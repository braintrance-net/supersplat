import { Events } from '../events';
import { Scene } from '../scene';
import { Splat } from '../splat';
import {
    applyArtisanMaskSelection,
    buildArtisanViewKey,
    captureSceneImages,
    extractMaskComponentAroundSeed,
    getArtisanOpFromPointer,
    maskArrayToPngBase64,
    maskPngToArray,
    normalizePromptPoint,
    rleMaskToArray,
    type ArtisanImageSize,
    type ArtisanPromptLabel,
    type ArtisanPromptPoint,
    type ArtisanSelectionMode
} from './artisan-selection';

const DEFAULT_SAM3_BACKEND_URL = 'https://sam3.4dream.app';
const DEFAULT_LOCAL_FRAME_MAX_SIDE = 720;
const DEFAULT_SEED_SAM_CAPTURE_MAX_SIDE = 960;
const DEFAULT_SEED_SAM3_TIMEOUT_MS = 12000;
const MIN_LOCAL_SAM_CAPTURE_MAX_SIDE = 256;
const MAX_LOCAL_SAM_CAPTURE_MAX_SIDE = 1280;
const MAX_SEED_SAM_CAPTURE_MAX_SIDE = 1920;
const SEED_NEGATIVE_CORNER_MARGIN_RATIO = 0.08;
const SEED_NEGATIVE_MIN_DISTANCE_RATIO = 0.18;
const ARTISAN_CLICK_CONFIG_STORAGE_KEY = 'supersplat.artisanClickSelection.config.v1';

const getSam3BackendUrl = () => {
    const configured = window.supersplatConfig?.sam3BackendUrl?.trim();
    if (configured) {
        return configured;
    }
    // Hosted (non-localhost) deploys with no explicit backend target the SAME ORIGIN so SAM3
    // requests hit the Vercel proxy at /api/sam3/* (forwards server-side to the HTTP EC2). Mirrors
    // getSam3BackendUrl in artisan-gs-local.ts. Local dev sets SAM3_BACKEND_URL, so this is skipped.
    const host = window.location.hostname;
    if (host !== 'localhost' && host !== '127.0.0.1') {
        return window.location.origin;
    }
    return DEFAULT_SAM3_BACKEND_URL;
};

const getSam3FetchCredentials = (sam3BackendUrl: string): 'same-origin' | 'include' => {
    if (!window.supersplatConfig?.sam3BackendUrl?.trim()) {
        return 'same-origin';
    }

    try {
        return new URL(sam3BackendUrl, window.location.href).origin === window.location.origin ? 'same-origin' : 'include';
    } catch {
        return 'same-origin';
    }
};

// The splat's sorted centers stream in after the scene already looks loaded; clicking
// before they're complete gives partial projections (12x fewer candidates), blank capture
// readbacks, and a starved viewpoint planner. Wait (bounded) for the full centers buffer.
const waitForSplatCentersReady = async (splat: Splat, timeoutMs = 8000) => {
    const startedAt = performance.now();
    // The centers buffer is allocated full-length up front and filled in place, so length
    // alone lies; sample content and wait until the non-zero count stops growing.
    const countNonZeroSample = (centers: Float32Array) => {
        const triples = Math.floor(centers.length / 3);
        const stride = Math.max(1, Math.floor(triples / 4096));
        let nonZero = 0;
        let sampled = 0;
        for (let i = 0; i < triples; i += stride) {
            sampled++;
            if (centers[i * 3] !== 0 || centers[i * 3 + 1] !== 0 || centers[i * 3 + 2] !== 0) {
                nonZero++;
            }
        }
        return { nonZero, sampled };
    };
    let previousNonZero = -1;
    for (;;) {
        const centers = splat.entity.gsplat?.instance?.sorter?.centers as Float32Array | undefined;
        const total = splat.splatData.numSplats;
        if (centers && centers.length / 3 >= total) {
            const { nonZero, sampled } = countNonZeroSample(centers);
            if (nonZero > sampled * 0.5 && nonZero === previousNonZero) {
                return true;
            }
            previousNonZero = nonZero;
        }
        if (performance.now() - startedAt > timeoutMs) {
            console.warn(`[ArtisanGS] splat centers not settled after ${timeoutMs}ms — proceeding anyway`);
            return false;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
};

// requestAnimationFrame never fires while the window is occluded/backgrounded, so any
// render-settle wait must be capped with a timer or the click flow hangs indefinitely.
const waitForRenderTick = (timeoutMs = 250) => new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
        if (!settled) {
            settled = true;
            resolve();
        }
    };
    requestAnimationFrame(() => requestAnimationFrame(done));
    window.setTimeout(done, timeoutMs);
});

const isLoopbackSam3Url = (sam3BackendUrl: string) => {
    try {
        const host = new URL(sam3BackendUrl, window.location.href).hostname;
        return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
    } catch {
        return false;
    }
};

const describeSam3ConnectionError = (sam3BackendUrl: string, err: unknown) => {
    const detail = err instanceof Error && err.message ? err.message : 'fetch failed';
    const hint = isLoopbackSam3Url(sam3BackendUrl) ?
        ' The SAM3 dev proxy looks down — start it with "node scripts/sam3-dev-proxy.mjs" (port 47825) or "npm run artisangs:stack".' :
        '';
    return `SAM3 backend unreachable at ${sam3BackendUrl} (${detail}).${hint}`;
};

// Background reachability probe for the local SAM3 dev proxy so a missing proxy is
// reported on tool activation instead of as a generic failure on the first click.
let lastSam3ProxyProbeAt = 0;
const warnIfSam3ProxyDown = async (events: Events) => {
    const sam3BackendUrl = getSam3BackendUrl();
    if (!isLoopbackSam3Url(sam3BackendUrl)) {
        return;
    }
    const now = Date.now();
    if (now - lastSam3ProxyProbeAt < 30000) {
        return;
    }
    lastSam3ProxyProbeAt = now;
    try {
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), 2000);
        try {
            await fetch(new URL('/healthz', sam3BackendUrl), {
                method: 'GET',
                cache: 'no-store',
                credentials: getSam3FetchCredentials(sam3BackendUrl),
                signal: controller.signal
            });
        } finally {
            window.clearTimeout(timer);
        }
    } catch (err) {
        console.warn('[ArtisanGS] SAM3 dev proxy preflight failed:', err);
        events.fire('toast', describeSam3ConnectionError(sam3BackendUrl, err), 'warning');
    }
};

const formatArtisanToastError = (label: string, error?: string) => {
    const detail = error?.trim();
    if (!detail) return label;
    return `${label}: ${detail.length > 160 ? `${detail.slice(0, 157)}...` : detail}`;
};

type Sam3SegmentResponse = {
    mask?: string;
    rle_mask?: string;
    rle_encoding?: string;
    rle_run_count?: number;
    width?: number;
    height?: number;
    job_id?: string;
    supportsPromptRefinement?: boolean;
    error?: string;
};

type Sam3RequestTimings = {
    endpoint: string;
    status: number;
    request_stringify_ms: number;
    request_bytes: number;
    fetch_ms: number;
    resource_start_delay_ms?: number;
    resource_duration_ms?: number;
    resource_request_start_ms?: number;
    resource_response_start_ms?: number;
    resource_response_end_ms?: number;
    fetch_resume_lag_ms?: number;
};

type Sam3SegmentTimings = Sam3RequestTimings & {
    total_ms: number;
    response_json_ms: number;
    fallback_from_status?: number;
    refine_status?: number;
    sam3_timeout_ms?: number;
    compact_mask_response?: boolean;
};

type ArtisanTimingStep = {
    started_ms: number;
    ended_ms: number;
    duration_ms: number;
};

type ArtisanClickRunOptions = {
    click_xy: [number, number];
    op: ArtisanSelectionMode;
    label: ArtisanPromptLabel;
    allowInactive?: boolean;
    emitSeedEvent?: boolean;
    runLocal?: boolean;
    reviewSeedMask?: boolean;
    localOptions?: Record<string, unknown>;
    includeReview?: boolean;
    includeImages?: boolean;
};

type ArtisanDebugClickOptions = {
    click_xy?: [number, number];
    x?: number;
    y?: number;
    selectionMode?: ArtisanSelectionMode;
    label?: ArtisanPromptLabel;
    runLocal?: boolean;
    reviewSeedMask?: boolean;
    localOptions?: Record<string, unknown>;
    includeReview?: boolean;
    includeImages?: boolean;
};

type ArtisanClickSeedPayload = {
    source: 'click';
    selection_mode: ArtisanSelectionMode;
    projection_mode: 'connected-surface';
    seed_xy: [number, number];
    canvas_xy: [number, number];
    view_key: string;
    frame: {
        image: string;
        width: number;
        height: number;
        mimeType: string;
        camera: unknown;
        mean_luma: number;
        non_black_ratio: number;
        alpha_ratio: number;
    };
    mask: {
        image: string;
        width: number;
        height: number;
        mimeType: string;
        data: Uint8Array;
    };
    timings: Record<string, unknown>;
    result: unknown;
    review?: Record<string, unknown>;
};

type ArtisanClickPresetId = 'seed' | 'fast' | 'normal' | 'quality' | 'max' | 'custom';

type ArtisanClickConfig = {
    presetId: ArtisanClickPresetId;
    frameCount: number;
    candidateCheckBudget: number;
    minAcceptedMaskCountForApply: number;
    reviewSeedMask: boolean;
    showDebugViews: boolean;
    includeDebugCandidates: boolean;
};

type ArtisanClickPreset = Omit<ArtisanClickConfig, 'reviewSeedMask' | 'showDebugViews' | 'includeDebugCandidates'> & {
    label: string;
};

const ARTISAN_CLICK_PRESETS: ArtisanClickPreset[] = [
    { presetId: 'seed', label: 'Seed', frameCount: 1, candidateCheckBudget: 8, minAcceptedMaskCountForApply: 1 },
    { presetId: 'fast', label: 'Fast', frameCount: 1, candidateCheckBudget: 16, minAcceptedMaskCountForApply: 1 },
    { presetId: 'normal', label: 'Normal', frameCount: 3, candidateCheckBudget: 48, minAcceptedMaskCountForApply: 2 },
    { presetId: 'quality', label: 'Quality', frameCount: 12, candidateCheckBudget: 120, minAcceptedMaskCountForApply: 3 },
    { presetId: 'max', label: 'Max', frameCount: 50, candidateCheckBudget: 200, minAcceptedMaskCountForApply: 4 }
];

const DEFAULT_ARTISAN_CLICK_CONFIG: ArtisanClickConfig = {
    presetId: 'normal',
    frameCount: 3,
    candidateCheckBudget: 48,
    minAcceptedMaskCountForApply: 2,
    reviewSeedMask: true,
    showDebugViews: false,
    includeDebugCandidates: false
};

const preciseMs = (ms: number) => Number(Math.max(0, ms).toFixed(3));

const createTimingTracker = (startedAt: number) => {
    const timeline: Record<string, ArtisanTimingStep> = {};
    const finish = (name: string, stepStartedAt: number) => {
        const endedAt = performance.now();
        const step = {
            started_ms: preciseMs(stepStartedAt - startedAt),
            ended_ms: preciseMs(endedAt - startedAt),
            duration_ms: preciseMs(endedAt - stepStartedAt)
        };
        timeline[name] = step;
        return step;
    };

    return { timeline, finish };
};

const numberOption = (value: unknown): number | undefined => {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

const positiveIntegerUrlParam = (name: string) => {
    const value = new URLSearchParams(window.location.search).get(name);
    if (!value) {
        return undefined;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : undefined;
};

const booleanUrlParam = (name: string) => {
    const value = new URLSearchParams(window.location.search).get(name);
    if (value === null) {
        return undefined;
    }

    const normalized = value.trim().toLowerCase();
    return normalized !== '0' && normalized !== 'false' && normalized !== 'off' && normalized !== 'none';
};

const clampInteger = (value: unknown, fallback: number, min: number, max: number) => {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) {
        return fallback;
    }
    return Math.max(min, Math.min(max, Math.round(numeric)));
};

const normalizeArtisanClickConfig = (value?: Partial<ArtisanClickConfig> | null): ArtisanClickConfig => {
    const frameCount = clampInteger(value?.frameCount, DEFAULT_ARTISAN_CLICK_CONFIG.frameCount, 1, 50);
    const candidateCheckBudget = clampInteger(
        value?.candidateCheckBudget,
        Math.max(frameCount, DEFAULT_ARTISAN_CLICK_CONFIG.candidateCheckBudget),
        frameCount,
        200
    );
    const minAcceptedMaskCountForApply = clampInteger(
        value?.minAcceptedMaskCountForApply,
        Math.min(frameCount, DEFAULT_ARTISAN_CLICK_CONFIG.minAcceptedMaskCountForApply),
        1,
        frameCount
    );
    const presetId = ARTISAN_CLICK_PRESETS.some(preset => preset.presetId === value?.presetId) ?
        value!.presetId! :
        (value?.presetId === 'custom' ? 'custom' : DEFAULT_ARTISAN_CLICK_CONFIG.presetId);

    return {
        presetId,
        frameCount,
        candidateCheckBudget,
        minAcceptedMaskCountForApply,
        reviewSeedMask: value?.reviewSeedMask !== false,
        showDebugViews: value?.showDebugViews === true,
        includeDebugCandidates: value?.includeDebugCandidates === true
    };
};

const isLegacySeedOnlyNormalConfig = (stored: Partial<ArtisanClickConfig> | null) => {
    return stored?.presetId === 'custom' &&
        stored.frameCount === 1 &&
        stored.candidateCheckBudget === 32 &&
        (stored.minAcceptedMaskCountForApply === undefined || stored.minAcceptedMaskCountForApply === 1) &&
        stored.showDebugViews !== true &&
        stored.includeDebugCandidates !== true;
};

const loadArtisanClickConfig = () => {
    let stored: Partial<ArtisanClickConfig> | null = null;
    try {
        const raw = window.localStorage?.getItem(ARTISAN_CLICK_CONFIG_STORAGE_KEY);
        stored = raw ? JSON.parse(raw) as Partial<ArtisanClickConfig> : null;
    } catch {
        stored = null;
    }
    const storedPreset = ARTISAN_CLICK_PRESETS.find(preset =>
        preset.presetId === (isLegacySeedOnlyNormalConfig(stored) ? 'normal' : stored?.presetId)
    );

    return normalizeArtisanClickConfig({
        ...DEFAULT_ARTISAN_CLICK_CONFIG,
        ...(isLegacySeedOnlyNormalConfig(stored) ? { ...stored, presetId: 'normal' as const } : stored),
        ...(storedPreset ? {
            frameCount: storedPreset.frameCount,
            candidateCheckBudget: storedPreset.candidateCheckBudget,
            minAcceptedMaskCountForApply: storedPreset.minAcceptedMaskCountForApply
        } : {}),
        frameCount: positiveIntegerUrlParam('artisanFrameCount') ??
            (storedPreset ? storedPreset.frameCount : stored?.frameCount) ??
            DEFAULT_ARTISAN_CLICK_CONFIG.frameCount,
        candidateCheckBudget: positiveIntegerUrlParam('artisanCandidateChecks') ??
            positiveIntegerUrlParam('artisanCandidateCheckBudget') ??
            (storedPreset ? storedPreset.candidateCheckBudget : stored?.candidateCheckBudget) ??
            DEFAULT_ARTISAN_CLICK_CONFIG.candidateCheckBudget,
        minAcceptedMaskCountForApply: positiveIntegerUrlParam('artisanMinAcceptedMasksForApply') ??
            positiveIntegerUrlParam('artisanMinAcceptedMaskCountForApply') ??
            (storedPreset ? storedPreset.minAcceptedMaskCountForApply : stored?.minAcceptedMaskCountForApply) ??
            DEFAULT_ARTISAN_CLICK_CONFIG.minAcceptedMaskCountForApply,
        reviewSeedMask: booleanUrlParam('artisanReviewSeedMask') ??
            stored?.reviewSeedMask ??
            DEFAULT_ARTISAN_CLICK_CONFIG.reviewSeedMask,
        showDebugViews: booleanUrlParam('artisanDebugViews') ?? stored?.showDebugViews ?? DEFAULT_ARTISAN_CLICK_CONFIG.showDebugViews,
        includeDebugCandidates: booleanUrlParam('artisanDebugCandidates') ??
            stored?.includeDebugCandidates ??
            DEFAULT_ARTISAN_CLICK_CONFIG.includeDebugCandidates
    });
};

const storeArtisanClickConfig = (config: ArtisanClickConfig) => {
    try {
        window.localStorage?.setItem(ARTISAN_CLICK_CONFIG_STORAGE_KEY, JSON.stringify(config));
    } catch {
        // Ignore private-mode/localStorage errors; the controls remain usable for this session.
    }
};

const injectArtisanClickConfigStyles = () => {
    if (document.getElementById('artisan-click-config-style')) {
        return;
    }

    const style = document.createElement('style');
    style.id = 'artisan-click-config-style';
    style.textContent = `
.artisan-click-config {
    position: fixed;
    left: 16px;
    top: 72px;
    z-index: 10000;
    width: 304px;
    box-sizing: border-box;
    padding: 10px;
    border-radius: 8px;
    background: rgba(13, 17, 23, 0.92);
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.1), 0 12px 28px rgba(0, 0, 0, 0.32);
    color: #f8fafc;
    font: 12px/1.35 sans-serif;
    -webkit-font-smoothing: antialiased;
    user-select: none;
}
.artisan-click-config.hidden {
    display: none;
}
.artisan-click-config__header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
}
.artisan-click-config__title {
    font-weight: 700;
}
.artisan-click-config__summary {
    color: #93c5fd;
    font-variant-numeric: tabular-nums;
}
.artisan-click-config__presets {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 4px;
    margin-bottom: 9px;
}
.artisan-click-config__preset {
    min-height: 32px;
    padding: 0 6px;
    border: 0;
    border-radius: 6px;
    color: #dbeafe;
    background: rgba(255, 255, 255, 0.07);
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.08);
    font: 700 11px/1 sans-serif;
    transition-property: background-color, box-shadow, transform;
    transition-duration: 140ms;
    transition-timing-function: cubic-bezier(0.2, 0, 0, 1);
}
.artisan-click-config__preset:hover {
    background: rgba(96, 165, 250, 0.18);
    box-shadow: 0 0 0 1px rgba(147, 197, 253, 0.28);
}
.artisan-click-config__preset:active {
    transform: scale(0.96);
}
.artisan-click-config__preset.active {
    color: #04111f;
    background: #7dd3fc;
    box-shadow: 0 0 0 1px rgba(186, 230, 253, 0.72);
}
.artisan-click-config__row {
    display: grid;
    grid-template-columns: 58px minmax(0, 1fr) 58px;
    align-items: center;
    gap: 8px;
    min-height: 34px;
}
.artisan-click-config__label {
    color: #cbd5e1;
    font-weight: 700;
}
.artisan-click-config__range {
    width: 100%;
    margin: 0;
    accent-color: #38bdf8;
}
.artisan-click-config__number {
    width: 58px;
    height: 28px;
    box-sizing: border-box;
    border: 0;
    border-radius: 6px;
    padding: 0 6px;
    color: #f8fafc;
    background: rgba(255, 255, 255, 0.08);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.1);
    font: 700 12px/1 sans-serif;
    font-variant-numeric: tabular-nums;
}
.artisan-click-config__toggles {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    margin-top: 8px;
}
.artisan-click-config__toggle {
    display: flex;
    align-items: center;
    gap: 7px;
    min-height: 32px;
    box-sizing: border-box;
    padding: 0 8px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.06);
    color: #dbeafe;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.08);
    font-weight: 700;
}
.artisan-click-config__toggle input {
    width: 16px;
    height: 16px;
    accent-color: #38bdf8;
}
.artisan-click-config__actions {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 5px;
    margin-top: 8px;
}
.artisan-click-config__action {
    min-height: 30px;
    border: 0;
    border-radius: 6px;
    padding: 0 5px;
    color: #e0f2fe;
    background: rgba(14, 165, 233, 0.14);
    box-shadow: 0 0 0 1px rgba(125, 211, 252, 0.16);
    font: 700 11px/1 sans-serif;
    transition-property: background-color, box-shadow, transform;
    transition-duration: 140ms;
    transition-timing-function: cubic-bezier(0.2, 0, 0, 1);
}
.artisan-click-config__action:hover {
    background: rgba(14, 165, 233, 0.24);
    box-shadow: 0 0 0 1px rgba(125, 211, 252, 0.34);
}
.artisan-click-config__action:active {
    transform: scale(0.96);
}
.artisan-seed-review {
    position: fixed;
    left: 336px;
    top: 72px;
    z-index: 10002;
    width: 336px;
    box-sizing: border-box;
    padding: 10px;
    border-radius: 8px;
    background: rgba(13, 17, 23, 0.94);
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.1), 0 12px 28px rgba(0, 0, 0, 0.34);
    color: #f8fafc;
    font: 12px/1.35 sans-serif;
    -webkit-font-smoothing: antialiased;
    user-select: none;
}
.artisan-seed-review.hidden,
.artisan-seed-repair-canvas.hidden {
    display: none;
}
.artisan-seed-review__header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 6px;
}
.artisan-seed-review__title {
    font-weight: 700;
}
.artisan-seed-review__summary {
    color: #93c5fd;
    font-variant-numeric: tabular-nums;
}
.artisan-seed-review__body {
    color: #dbeafe;
    margin-bottom: 9px;
    text-wrap: pretty;
}
.artisan-seed-review__actions,
.artisan-seed-review__repair-actions {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 6px;
}
.artisan-seed-review__repair-actions {
    grid-template-columns: repeat(4, minmax(0, 1fr));
    margin-top: 8px;
}
.artisan-seed-review__button {
    min-height: 34px;
    border: 0;
    border-radius: 6px;
    color: #dbeafe;
    background: rgba(255, 255, 255, 0.07);
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.08);
    font: 700 11px/1 sans-serif;
    transition-property: background-color, box-shadow, transform;
    transition-duration: 140ms;
    transition-timing-function: cubic-bezier(0.2, 0, 0, 1);
}
.artisan-seed-review__button:hover {
    background: rgba(96, 165, 250, 0.18);
    box-shadow: 0 0 0 1px rgba(147, 197, 253, 0.28);
}
.artisan-seed-review__button:active {
    transform: scale(0.96);
}
.artisan-seed-review__button.primary {
    color: #04111f;
    background: #7dd3fc;
    box-shadow: 0 0 0 1px rgba(186, 230, 253, 0.72);
}
.artisan-seed-review__button.danger {
    color: #fee2e2;
}
.artisan-seed-review__repair {
    display: none;
    margin-top: 9px;
}
.artisan-seed-review.repairing .artisan-seed-review__repair {
    display: block;
}
.artisan-seed-review__repair-row {
    display: grid;
    grid-template-columns: 76px minmax(0, 1fr) 54px;
    align-items: center;
    gap: 8px;
    min-height: 34px;
}
.artisan-seed-review__repair-label {
    color: #cbd5e1;
    font-weight: 700;
}
.artisan-seed-review__repair-range {
    width: 100%;
    margin: 0;
    accent-color: #38bdf8;
}
.artisan-seed-review__repair-value {
    color: #93c5fd;
    font-variant-numeric: tabular-nums;
    text-align: right;
}
.artisan-seed-repair-canvas {
    position: fixed;
    left: 0;
    top: 0;
    z-index: 10001;
    cursor: crosshair;
    pointer-events: none;
    touch-action: none;
}
.artisan-seed-repair-canvas.repairing {
    pointer-events: auto;
}
`;
    document.head.appendChild(style);
};

const resolveSeedSam3TimeoutMs = (options: ArtisanClickRunOptions) => {
    const value = numberOption(options.localOptions?.seedSam3TimeoutMs) ??
        numberOption(options.localOptions?.sam3TimeoutMs) ??
        positiveIntegerUrlParam('artisanSeedSam3TimeoutMs') ??
        positiveIntegerUrlParam('artisanSam3TimeoutMs') ??
        DEFAULT_SEED_SAM3_TIMEOUT_MS;
    return Math.max(1000, Math.min(180000, Math.round(value)));
};

const clampPromptPixel = (value: number, limit: number) => Math.round(Math.min(Math.max(0, value), Math.max(0, limit - 1)));

const buildSeedPromptPoints = (
    click_xy: [number, number],
    label: ArtisanPromptLabel,
    imageSize: ArtisanImageSize,
    includeSyntheticNegativeCorners = false
): ArtisanPromptPoint[] => {
    const points: ArtisanPromptPoint[] = [{ click_xy, label }];
    if (!includeSyntheticNegativeCorners || label !== 1 || imageSize.width <= 0 || imageSize.height <= 0) {
        return points;
    }

    const marginX = imageSize.width * SEED_NEGATIVE_CORNER_MARGIN_RATIO;
    const marginY = imageSize.height * SEED_NEGATIVE_CORNER_MARGIN_RATIO;
    const minDistance = Math.min(imageSize.width, imageSize.height) * SEED_NEGATIVE_MIN_DISTANCE_RATIO;
    const candidates: [number, number][] = [
        [marginX, marginY],
        [imageSize.width - marginX, marginY],
        [marginX, imageSize.height - marginY],
        [imageSize.width - marginX, imageSize.height - marginY]
    ];

    for (const [x, y] of candidates) {
        const clamped: [number, number] = [
            clampPromptPixel(x, imageSize.width),
            clampPromptPixel(y, imageSize.height)
        ];
        if (Math.hypot(clamped[0] - click_xy[0], clamped[1] - click_xy[1]) < minDistance) {
            continue;
        }
        points.push({ click_xy: clamped, label: 0 });
    }

    return points;
};

const resolveCaptureSize = (
    canvasWidth: number,
    canvasHeight: number,
    options: ArtisanClickRunOptions
) => {
    const requestedMaxSide = numberOption(options.localOptions?.seedMaxSide) ??
        positiveIntegerUrlParam('artisanSeedMaxSide') ??
        numberOption(options.localOptions?.samMaxSide) ??
        positiveIntegerUrlParam('artisanSamMaxSide') ??
        positiveIntegerUrlParam('artisanMaxSide');
    const maxSide = requestedMaxSide !== undefined ?
        Math.max(
            MIN_LOCAL_SAM_CAPTURE_MAX_SIDE,
            Math.min(MAX_SEED_SAM_CAPTURE_MAX_SIDE, requestedMaxSide)
        ) :
        DEFAULT_SEED_SAM_CAPTURE_MAX_SIDE;

    return resolveCaptureSizeForMaxSide(canvasWidth, canvasHeight, maxSide);
};

const resolveCaptureSizeForMaxSide = (
    canvasWidth: number,
    canvasHeight: number,
    maxSide: number
) => {
    const scale = Math.min(1, maxSide / Math.max(1, canvasWidth, canvasHeight));

    return {
        width: Math.max(1, Math.round(canvasWidth * scale)),
        height: Math.max(1, Math.round(canvasHeight * scale)),
        scale
    };
};

const resolveSeedCaptureAttemptMaxSides = (
    canvasWidth: number,
    canvasHeight: number,
    options: ArtisanClickRunOptions
) => {
    const primarySize = resolveCaptureSize(canvasWidth, canvasHeight, options);
    const primary = Math.max(primarySize.width, primarySize.height);
    const candidates = [primary, DEFAULT_SEED_SAM_CAPTURE_MAX_SIDE, 960, DEFAULT_LOCAL_FRAME_MAX_SIDE]
        .filter(side => side <= primary && side >= MIN_LOCAL_SAM_CAPTURE_MAX_SIDE);
    return Array.from(new Set(candidates));
};

const booleanOption = (value: unknown): boolean | undefined => {
    return typeof value === 'boolean' ? value : undefined;
};

const shouldUseSeedNegativeCornerPrompts = (options: ArtisanClickRunOptions) => {
    return booleanOption(options.localOptions?.seedNegativeCornerPrompts) ??
        booleanOption(options.localOptions?.seedSyntheticNegativePrompts) ??
        booleanUrlParam('artisanSeedNegativeCorners') ??
        booleanUrlParam('artisanSeedSyntheticNegatives') ??
        false;
};

const resolveLocalFrameSize = (
    canvasWidth: number,
    canvasHeight: number,
    options: ArtisanClickRunOptions
) => {
    const localEnabled = options.emitSeedEvent !== false || options.runLocal !== false;
    if (!localEnabled) {
        return { width: canvasWidth, height: canvasHeight, scale: 1 };
    }

    const requestedMaxSide = numberOption(options.localOptions?.maxSide) ??
        positiveIntegerUrlParam('artisanLocalFrameMaxSide') ??
        positiveIntegerUrlParam('artisanCaptureMaxSide') ??
        positiveIntegerUrlParam('artisanMaxSide') ??
        DEFAULT_LOCAL_FRAME_MAX_SIDE;
    const maxSide = Math.max(
        MIN_LOCAL_SAM_CAPTURE_MAX_SIDE,
        Math.min(MAX_LOCAL_SAM_CAPTURE_MAX_SIDE, requestedMaxSide)
    );
    const scale = Math.min(1, maxSide / Math.max(1, canvasWidth, canvasHeight));
    return {
        width: Math.max(1, Math.round(canvasWidth * scale)),
        height: Math.max(1, Math.round(canvasHeight * scale)),
        scale
    };
};

class ArtisanClickSelection {
    activate: () => void;
    deactivate: () => void;
    active = false;

    constructor(events: Events, scene: Scene, parent: HTMLElement) {
        const canvas = scene.canvas;
        let busy = false;
        let warmedUp = false;
        let abort: AbortController | null = null;
        let cancelPendingSeedReview: (() => void) | null = null;
        let selectionMode: ArtisanSelectionMode = 'set';
        let clickConfig = loadArtisanClickConfig();
        const modeTitle: Record<ArtisanSelectionMode, string> = {
            set: 'Artisan New',
            add: 'Artisan Add',
            remove: 'Artisan Remove',
            intersect: 'Artisan Intersect'
        };

        injectArtisanClickConfigStyles();

        const controls = document.createElement('div');
        controls.className = 'artisan-click-config hidden';
        controls.addEventListener('pointerdown', event => event.stopPropagation());
        controls.addEventListener('pointerup', event => event.stopPropagation());
        controls.addEventListener('click', event => event.stopPropagation());
        controls.addEventListener('wheel', event => event.stopPropagation());

        const header = document.createElement('div');
        header.className = 'artisan-click-config__header';

        const title = document.createElement('div');
        title.className = 'artisan-click-config__title';

        const summary = document.createElement('div');
        summary.className = 'artisan-click-config__summary';

        header.append(title, summary);
        controls.appendChild(header);

        const presetWrap = document.createElement('div');
        presetWrap.className = 'artisan-click-config__presets';
        const presetButtons = new Map<ArtisanClickPresetId, HTMLButtonElement>();
        for (const preset of ARTISAN_CLICK_PRESETS) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'artisan-click-config__preset';
            button.textContent = preset.label;
            button.title = `${preset.frameCount} views, ${preset.candidateCheckBudget} checks`;
            button.addEventListener('click', () => {
                setClickConfig({
                    presetId: preset.presetId,
                    frameCount: preset.frameCount,
                    candidateCheckBudget: preset.candidateCheckBudget,
                    minAcceptedMaskCountForApply: preset.minAcceptedMaskCountForApply
                });
            });
            presetButtons.set(preset.presetId, button);
            presetWrap.appendChild(button);
        }
        controls.appendChild(presetWrap);

        const createNumericControl = (
            labelText: string,
            min: number,
            max: number,
            step: number,
            getValue: () => number,
            setValue: (value: number) => void
        ) => {
            const row = document.createElement('label');
            row.className = 'artisan-click-config__row';

            const label = document.createElement('span');
            label.className = 'artisan-click-config__label';
            label.textContent = labelText;

            const range = document.createElement('input');
            range.className = 'artisan-click-config__range';
            range.type = 'range';
            range.min = String(min);
            range.max = String(max);
            range.step = String(step);

            const number = document.createElement('input');
            number.className = 'artisan-click-config__number';
            number.type = 'number';
            number.min = String(min);
            number.max = String(max);
            number.step = String(step);
            number.inputMode = 'numeric';

            const commit = (raw: string) => {
                const value = clampInteger(raw, getValue(), Number(number.min), Number(number.max));
                setValue(value);
            };

            range.addEventListener('input', () => commit(range.value));
            number.addEventListener('change', () => commit(number.value));
            number.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    number.blur();
                }
            });

            row.append(label, range, number);
            controls.appendChild(row);

            return {
                range,
                number,
                sync: (nextMin = min, nextMax = max) => {
                    const value = getValue();
                    range.min = String(nextMin);
                    number.min = String(nextMin);
                    range.max = String(nextMax);
                    number.max = String(nextMax);
                    range.value = String(value);
                    number.value = String(value);
                }
            };
        };

        const viewControl = createNumericControl('Views', 1, 50, 1, () => clickConfig.frameCount, (frameCount) => {
            setClickConfig({ frameCount, presetId: 'custom' });
        });
        const checkControl = createNumericControl('Checks', 1, 200, 1, () => clickConfig.candidateCheckBudget, (candidateCheckBudget) => {
            setClickConfig({ candidateCheckBudget, presetId: 'custom' });
        });
        const applyControl = createNumericControl('Apply', 1, 50, 1, () => clickConfig.minAcceptedMaskCountForApply, (minAcceptedMaskCountForApply) => {
            setClickConfig({ minAcceptedMaskCountForApply, presetId: 'custom' });
        });

        const toggles = document.createElement('div');
        toggles.className = 'artisan-click-config__toggles';

        const createToggle = (labelText: string, getValue: () => boolean, setValue: (value: boolean) => void) => {
            const label = document.createElement('label');
            label.className = 'artisan-click-config__toggle';
            const input = document.createElement('input');
            input.type = 'checkbox';
            const text = document.createElement('span');
            text.textContent = labelText;
            input.addEventListener('change', () => setValue(input.checked));
            label.append(input, text);
            toggles.appendChild(label);
            return {
                input,
                sync: () => {
                    input.checked = getValue();
                }
            };
        };

        const reviewToggle = createToggle('Review', () => clickConfig.reviewSeedMask, (reviewSeedMask) => {
            setClickConfig({ reviewSeedMask });
        });
        const debugToggle = createToggle('Debug', () => clickConfig.showDebugViews, (showDebugViews) => {
            setClickConfig({ showDebugViews });
        });
        const candidatesToggle = createToggle('Candidates', () => clickConfig.includeDebugCandidates, (includeDebugCandidates) => {
            setClickConfig({ includeDebugCandidates });
        });
        controls.appendChild(toggles);

        const actionWrap = document.createElement('div');
        actionWrap.className = 'artisan-click-config__actions';
        const createActionButton = (labelText: string, titleText: string, action: () => void) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'artisan-click-config__action';
            button.textContent = labelText;
            button.title = titleText;
            button.addEventListener('click', action);
            actionWrap.appendChild(button);
            return button;
        };
        const restoreArtisanSelection = (mode: string) => {
            Promise.resolve(events.invoke('artisan.local.restoreActiveObject', { mode }))
            .then((restored) => {
                if (restored === false) {
                    events.fire('toast', 'No Artisan selection to show yet', 'warning');
                }
            })
            .catch((err) => {
                console.warn(`[ArtisanGS] Failed to show ${mode} selection`, err);
                events.fire('toast', 'Could not show Artisan selection', 'warning');
            });
        };
        createActionButton('Final', 'Show final Artisan selection', () => restoreArtisanSelection('final'));
        createActionButton('Voted', 'Show voted Artisan selection', () => restoreArtisanSelection('voted'));
        createActionButton('Conf', 'Show confidence-filtered Artisan selection', () => restoreArtisanSelection('confidence'));
        createActionButton('Post', 'Show posterior-filtered Artisan selection', () => restoreArtisanSelection('posterior'));
        createActionButton('Base', 'Show target-bounded base selection', () => restoreArtisanSelection('target_bounded_base'));
        createActionButton('Loose', 'Show target-bounded loose selection', () => restoreArtisanSelection('target_bounded_loose'));
        createActionButton('Vol', 'Show target-volume selection', () => restoreArtisanSelection('target_volume'));
        createActionButton('Heat', 'Toggle orbitable 3D posterior heatmap (blue=against, yellow=building, pink=selected)', () => {
            Promise.resolve(events.invoke('artisan.local.toggleConfidenceHeatmap')).catch((err) => {
                console.warn('[ArtisanGS] Failed to toggle confidence heatmap', err);
                events.fire('toast', 'Could not toggle posterior heatmap', 'warning');
            });
        });
        createActionButton('Views', 'Show Artisan debug views', () => {
            Promise.resolve(events.invoke('artisan.local.showDebugViews')).catch((err) => {
                console.warn('[ArtisanGS] Failed to show debug views', err);
                events.fire('toast', 'Could not show Artisan debug views', 'warning');
            });
        });
        // Live minimum-confidence slider: drag to choose the posterior floor for the
        // selection; the viewport reselects + recolors in real time (heatmap pivot follows).
        const confRow = document.createElement('div');
        confRow.className = 'artisan-click-config__row';
        const confLabel = document.createElement('span');
        confLabel.className = 'artisan-click-config__label';
        confLabel.textContent = 'Conf ≥';
        const confRange = document.createElement('input');
        confRange.className = 'artisan-click-config__range';
        confRange.type = 'range';
        confRange.min = '0.05';
        confRange.max = '0.95';
        confRange.step = '0.01';
        confRange.value = '0.50';
        confRange.title = 'Minimum posterior confidence included in the selection (live)';
        const confValue = document.createElement('span');
        confValue.className = 'artisan-click-config__label';
        confValue.style.minWidth = '92px';
        confValue.textContent = '0.50';
        let confFloorBusy = false;
        let confFloorPending: number | null = null;
        const applyConfidenceFloor = (value: number) => {
            if (confFloorBusy) {
                confFloorPending = value;
                return;
            }
            confFloorBusy = true;
            Promise.resolve(events.invoke('artisan.local.setSelectionConfidenceFloor', value))
                .then((result: { ok?: boolean; selected_count?: number } | undefined) => {
                    confValue.textContent = result?.ok ?
                        `${value.toFixed(2)} · ${result.selected_count} splats` :
                        value.toFixed(2);
                })
                .catch(() => undefined)
                .finally(() => {
                    confFloorBusy = false;
                    if (confFloorPending !== null) {
                        const next = confFloorPending;
                        confFloorPending = null;
                        applyConfidenceFloor(next);
                    }
                });
        };
        confRange.addEventListener('input', () => {
            const value = Number(confRange.value);
            confValue.textContent = value.toFixed(2);
            applyConfidenceFloor(value);
        });
        confRow.append(confLabel, confRange, confValue);
        controls.appendChild(confRow);
        controls.appendChild(actionWrap);
        document.body.appendChild(controls);

        function setClickConfig(patch: Partial<ArtisanClickConfig>) {
            clickConfig = normalizeArtisanClickConfig({
                ...clickConfig,
                ...patch
            });
            if (clickConfig.candidateCheckBudget < clickConfig.frameCount) {
                clickConfig = normalizeArtisanClickConfig({
                    ...clickConfig,
                    candidateCheckBudget: clickConfig.frameCount
                });
            }
            if (clickConfig.minAcceptedMaskCountForApply > clickConfig.frameCount) {
                clickConfig = normalizeArtisanClickConfig({
                    ...clickConfig,
                    minAcceptedMaskCountForApply: clickConfig.frameCount
                });
            }
            storeArtisanClickConfig(clickConfig);
            syncControls();
            events.fire('artisan.clickSelection.configChanged', { ...clickConfig });
        }

        function syncControls() {
            title.textContent = modeTitle[selectionMode] ?? 'Artisan New';
            summary.textContent = `${clickConfig.frameCount}v / ${clickConfig.candidateCheckBudget}c`;
            for (const [presetId, button] of presetButtons) {
                button.classList.toggle('active', presetId === clickConfig.presetId);
            }
            viewControl.sync(1, 50);
            checkControl.sync(clickConfig.frameCount, 200);
            applyControl.sync(1, clickConfig.frameCount);
            reviewToggle.sync();
            debugToggle.sync();
            candidatesToggle.sync();
        }

        const buildConfiguredLocalOptions = (overrides: Record<string, unknown> = {}) => {
            const practicalMultiview =
                clickConfig.frameCount > 1 &&
                (
                    clickConfig.presetId === 'normal' ||
                    (clickConfig.presetId === 'custom' && clickConfig.frameCount <= 5)
                );
            const refinedViewCount = Math.max(1, clickConfig.frameCount - 1);
            return {
                frameCount: clickConfig.frameCount,
                candidateCheckBudget: clickConfig.candidateCheckBudget,
                minAcceptedMaskCountForApply: clickConfig.minAcceptedMaskCountForApply,
                showDebugViews: clickConfig.showDebugViews,
                includeDebugCandidates: clickConfig.includeDebugCandidates || clickConfig.showDebugViews,
                combinedPreview: 'confidence',
                ...(practicalMultiview ? {
                    maxSide: 512,
                    strictSequentialEig: false,
                    sam31CloudBatchSize: Math.min(4, refinedViewCount),
                    sam31CloudConcurrency: Math.min(4, refinedViewCount)
                } : {}),
                ...overrides
            };
        };

        syncControls();

        const shouldReviewSeedMask = (options: ArtisanClickRunOptions) => {
            if (options.runLocal === false) {
                return false;
            }
            if (options.reviewSeedMask !== undefined) {
                return options.reviewSeedMask;
            }
            if (typeof options.localOptions?.reviewSeedMask === 'boolean') {
                return options.localOptions.reviewSeedMask;
            }
            return clickConfig.reviewSeedMask && options.op === 'set';
        };

        const reviewSeedMask = (
            seed: ArtisanClickSeedPayload,
            splat: Splat,
            originalMask: Uint8Array
        ): Promise<ArtisanClickSeedPayload | null> => {
            cancelPendingSeedReview?.();

            return new Promise((resolve) => {
                const reviewStartedAt = performance.now();
                let settled = false;
                let repairMode: 'add' | 'erase' = 'add';
                let repairRadius = 34;
                let repairPointerId: number | null = null;
                let previousPoint: [number, number] | null = null;
                let strokeCount = 0;
                const repairedMask = new Uint8Array(originalMask);

                const panel = document.createElement('div');
                panel.className = 'artisan-seed-review';
                panel.addEventListener('pointerdown', event => event.stopPropagation());
                panel.addEventListener('pointerup', event => event.stopPropagation());
                panel.addEventListener('click', event => event.stopPropagation());
                panel.addEventListener('wheel', event => event.stopPropagation());

                const repairCanvas = document.createElement('canvas');
                repairCanvas.className = 'artisan-seed-repair-canvas';
                const repairContext = repairCanvas.getContext('2d');
                const previewCanvas = document.createElement('canvas');
                previewCanvas.width = seed.mask.width;
                previewCanvas.height = seed.mask.height;
                const previewContext = previewCanvas.getContext('2d');

                const header = document.createElement('div');
                header.className = 'artisan-seed-review__header';

                const title = document.createElement('div');
                title.className = 'artisan-seed-review__title';
                title.textContent = 'Seed Mask';

                const seedStats = document.createElement('div');
                seedStats.className = 'artisan-seed-review__summary';
                seedStats.textContent = `${seed.mask.width}x${seed.mask.height}`;

                header.append(title, seedStats);

                const body = document.createElement('div');
                body.className = 'artisan-seed-review__body';
                body.textContent = 'Does this first mask match the clicked object?';

                const actions = document.createElement('div');
                actions.className = 'artisan-seed-review__actions';

                const makeButton = (label: string, className = '') => {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = `artisan-seed-review__button ${className}`.trim();
                    button.textContent = label;
                    return button;
                };

                const continueButton = makeButton('Continue', 'primary');
                const brushButton = makeButton('Brush Fix');
                const cancelButton = makeButton('Cancel', 'danger');
                actions.append(continueButton, brushButton, cancelButton);

                const repair = document.createElement('div');
                repair.className = 'artisan-seed-review__repair';

                const repairRow = document.createElement('label');
                repairRow.className = 'artisan-seed-review__repair-row';

                const repairLabel = document.createElement('span');
                repairLabel.className = 'artisan-seed-review__repair-label';
                repairLabel.textContent = 'Brush';

                const repairRange = document.createElement('input');
                repairRange.className = 'artisan-seed-review__repair-range';
                repairRange.type = 'range';
                repairRange.min = '4';
                repairRange.max = '160';
                repairRange.step = '1';
                repairRange.value = String(repairRadius);

                const repairValue = document.createElement('span');
                repairValue.className = 'artisan-seed-review__repair-value';

                repairRow.append(repairLabel, repairRange, repairValue);

                const repairActions = document.createElement('div');
                repairActions.className = 'artisan-seed-review__repair-actions';
                const addButton = makeButton('Add', 'primary');
                const eraseButton = makeButton('Erase');
                const resetButton = makeButton('Reset');
                const useButton = makeButton('Use Mask', 'primary');
                repairActions.append(addButton, eraseButton, resetButton, useButton);

                repair.append(repairRow, repairActions);
                panel.append(header, body, actions, repair);
                document.body.append(panel, repairCanvas);

                const syncRepairMode = () => {
                    addButton.classList.toggle('primary', repairMode === 'add');
                    eraseButton.classList.toggle('primary', repairMode === 'erase');
                    repairValue.textContent = `${Math.round(repairRadius)}px`;
                };

                const drawMaskPreview = () => {
                    if (!repairContext || !previewContext || repairCanvas.width <= 0 || repairCanvas.height <= 0) {
                        return;
                    }
                    const imageData = previewContext.createImageData(seed.mask.width, seed.mask.height);
                    for (let i = 0; i < repairedMask.length; i++) {
                        if (repairedMask[i] === 0) {
                            continue;
                        }
                        const offset = i * 4;
                        imageData.data[offset] = 56;
                        imageData.data[offset + 1] = 189;
                        imageData.data[offset + 2] = 248;
                        imageData.data[offset + 3] = 96;
                    }
                    previewContext.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
                    previewContext.putImageData(imageData, 0, 0);
                    repairContext.clearRect(0, 0, repairCanvas.width, repairCanvas.height);
                    repairContext.imageSmoothingEnabled = false;
                    repairContext.drawImage(previewCanvas, 0, 0, repairCanvas.width, repairCanvas.height);
                };

                const syncRepairCanvas = () => {
                    const rect = canvas.getBoundingClientRect();
                    repairCanvas.width = Math.max(1, Math.round(rect.width));
                    repairCanvas.height = Math.max(1, Math.round(rect.height));
                    repairCanvas.style.left = `${rect.left}px`;
                    repairCanvas.style.top = `${rect.top}px`;
                    repairCanvas.style.width = `${rect.width}px`;
                    repairCanvas.style.height = `${rect.height}px`;
                    drawMaskPreview();
                };

                const cleanup = () => {
                    repairCanvas.remove();
                    panel.remove();
                    if (cancelPendingSeedReview === cancelReview) {
                        cancelPendingSeedReview = null;
                    }
                };

                const finish = (value: ArtisanClickSeedPayload | null) => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    cleanup();
                    resolve(value);
                };

                function cancelReview() {
                    finish(null);
                }

                const canvasToMask = (point: [number, number]): [number, number] => [
                    Math.round(point[0] * seed.mask.width / Math.max(1, repairCanvas.width)),
                    Math.round(point[1] * seed.mask.height / Math.max(1, repairCanvas.height))
                ];

                const paintMaskCircle = (center: [number, number]) => {
                    const [maskX, maskY] = canvasToMask(center);
                    const radius = Math.max(1, Math.round(repairRadius * seed.mask.width / Math.max(1, repairCanvas.width)));
                    const radiusSq = radius * radius;
                    const minX = Math.max(0, maskX - radius);
                    const maxX = Math.min(seed.mask.width - 1, maskX + radius);
                    const minY = Math.max(0, maskY - radius);
                    const maxY = Math.min(seed.mask.height - 1, maskY + radius);
                    const value = repairMode === 'add' ? 255 : 0;
                    for (let y = minY; y <= maxY; y++) {
                        const dy = y - maskY;
                        const row = y * seed.mask.width;
                        for (let x = minX; x <= maxX; x++) {
                            const dx = x - maskX;
                            if (dx * dx + dy * dy <= radiusSq) {
                                repairedMask[row + x] = value;
                            }
                        }
                    }
                };

                const paintStroke = (from: [number, number], to: [number, number]) => {
                    const distance = Math.max(1, Math.hypot(to[0] - from[0], to[1] - from[1]));
                    const steps = Math.max(1, Math.ceil(distance / Math.max(1, repairRadius * 0.35)));
                    for (let i = 0; i <= steps; i++) {
                        const t = i / steps;
                        paintMaskCircle([
                            from[0] + (to[0] - from[0]) * t,
                            from[1] + (to[1] - from[1]) * t
                        ]);
                    }
                };

                const drawStroke = (from: [number, number], to: [number, number]) => {
                    if (!repairContext) {
                        return;
                    }
                    repairContext.lineCap = 'round';
                    repairContext.lineJoin = 'round';
                    repairContext.lineWidth = repairRadius * 2;
                    repairContext.strokeStyle = repairMode === 'add' ?
                        'rgba(56, 189, 248, 0.72)' :
                        'rgba(248, 113, 113, 0.72)';
                    repairContext.beginPath();
                    repairContext.moveTo(from[0], from[1]);
                    repairContext.lineTo(to[0], to[1]);
                    repairContext.stroke();
                };

                const eventPoint = (event: PointerEvent): [number, number] => {
                    const rect = repairCanvas.getBoundingClientRect();
                    return [
                        event.clientX - rect.left,
                        event.clientY - rect.top
                    ];
                };

                const startRepair = () => {
                    panel.classList.add('repairing');
                    repairCanvas.classList.add('repairing');
                    repairCanvas.classList.remove('hidden');
                    body.textContent = 'Brush add/erase corrections, then use the corrected mask.';
                    syncRepairCanvas();
                    syncRepairMode();
                };

                const buildCorrectedSeed = async () => {
                    const encodedStartedAt = performance.now();
                    const correctedImage = maskArrayToPngBase64(repairedMask, seed.mask.width, seed.mask.height);
                    const applyStartedAt = performance.now();
                    const result = await applyArtisanMaskSelection(events, scene, splat, {
                        source: 'click',
                        mask: repairedMask,
                        maskWidth: seed.mask.width,
                        maskHeight: seed.mask.height,
                        imageWidth: seed.mask.width,
                        imageHeight: seed.mask.height,
                        op: seed.selection_mode,
                        projectionMode: seed.projection_mode,
                        seed: seed.seed_xy
                    });
                    const reviewMs = preciseMs(performance.now() - reviewStartedAt);
                    return {
                        ...seed,
                        mask: {
                            ...seed.mask,
                            image: correctedImage,
                            data: new Uint8Array(repairedMask)
                        },
                        result,
                        timings: {
                            ...seed.timings,
                            seed_review_ms: reviewMs,
                            seed_review_encode_ms: preciseMs(applyStartedAt - encodedStartedAt),
                            seed_review_apply_ms: preciseMs(performance.now() - applyStartedAt)
                        },
                        review: {
                            state: strokeCount > 0 ? 'brush-corrected' : 'confirmed-after-brush',
                            stroke_count: strokeCount,
                            brush_radius_px: repairRadius
                        }
                    };
                };

                continueButton.addEventListener('click', () => {
                    finish({
                        ...seed,
                        review: {
                            state: 'confirmed'
                        },
                        timings: {
                            ...seed.timings,
                            seed_review_ms: preciseMs(performance.now() - reviewStartedAt)
                        }
                    });
                });
                brushButton.addEventListener('click', startRepair);
                cancelButton.addEventListener('click', () => finish(null));
                addButton.addEventListener('click', () => {
                    repairMode = 'add';
                    syncRepairMode();
                });
                eraseButton.addEventListener('click', () => {
                    repairMode = 'erase';
                    syncRepairMode();
                });
                resetButton.addEventListener('click', () => {
                    repairedMask.set(originalMask);
                    strokeCount = 0;
                    drawMaskPreview();
                });
                useButton.addEventListener('click', () => {
                    void buildCorrectedSeed().then(finish).catch((err) => {
                        console.warn('[ArtisanGS] Seed brush correction failed', err);
                        events.fire('toast', formatArtisanToastError('Seed brush correction failed', err?.message), 'error');
                    });
                });
                repairRange.addEventListener('input', () => {
                    repairRadius = clampInteger(repairRange.value, repairRadius, 4, 160);
                    syncRepairMode();
                });
                repairCanvas.addEventListener('pointerdown', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    repairPointerId = event.pointerId;
                    try {
                        repairCanvas.setPointerCapture(repairPointerId);
                    } catch {
                        // Synthetic test events and a few browser edge cases can reject capture.
                    }
                    previousPoint = eventPoint(event);
                    paintMaskCircle(previousPoint);
                    drawMaskPreview();
                    strokeCount++;
                });
                repairCanvas.addEventListener('pointermove', (event) => {
                    if (repairPointerId !== event.pointerId || !previousPoint) {
                        return;
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    const nextPoint = eventPoint(event);
                    paintStroke(previousPoint, nextPoint);
                    drawMaskPreview();
                    drawStroke(previousPoint, nextPoint);
                    previousPoint = nextPoint;
                });
                repairCanvas.addEventListener('pointerup', (event) => {
                    if (repairPointerId !== event.pointerId) {
                        return;
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    try {
                        repairCanvas.releasePointerCapture(repairPointerId);
                    } catch {
                        // Pointer capture may not exist for synthetic/cancelled interactions.
                    }
                    repairPointerId = null;
                    previousPoint = null;
                });

                cancelPendingSeedReview = cancelReview;
                syncRepairCanvas();
            });
        };

        const resourceTiming = (
            url: string,
            fetchStartedAt: number,
            fetchResolvedAt: number
        ) => {
            const entries = performance.getEntriesByName(url, 'resource') as PerformanceResourceTiming[];
            const entry = entries[entries.length - 1];
            if (!entry) return {};

            return {
                resource_start_delay_ms: preciseMs(entry.startTime - fetchStartedAt),
                resource_duration_ms: preciseMs(entry.duration),
                resource_request_start_ms: preciseMs(entry.requestStart - entry.startTime),
                resource_response_start_ms: preciseMs(entry.responseStart - entry.startTime),
                resource_response_end_ms: preciseMs(entry.responseEnd - entry.startTime),
                fetch_resume_lag_ms: entry.responseEnd > 0 ? preciseMs(fetchResolvedAt - entry.responseEnd) : undefined
            };
        };

        const fetchSegment = async (
            sam3BackendUrl: string,
            payload: {
                image: string;
                click_xy: [number, number];
                label: ArtisanPromptLabel;
                points: ArtisanPromptPoint[];
                image_size: ArtisanImageSize;
            },
            signal: AbortSignal,
            timeoutMs?: number
        ): Promise<
            { ok: true; data: Sam3SegmentResponse; timings: Sam3SegmentTimings } |
            { ok: false; status: number; error: string; data: Sam3SegmentResponse; timings: Sam3SegmentTimings }
        > => {
            const totalStartedAt = performance.now();
            const refineBody = {
                image: payload.image,
                object_id: 1,
                frame_index: 0,
                clear_old_points: true,
                coordinate_space: 'normalized',
                image_size: payload.image_size,
                points: payload.points.map(point => normalizePromptPoint(point, payload.image_size)),
                labels: payload.points.map(point => point.label)
            };

            const request = async (endpoint: string, body: unknown): Promise<{ res: Response; timings: Sam3RequestTimings }> => {
                const requestUrl = new URL(endpoint, sam3BackendUrl);
                if (timeoutMs !== undefined) {
                    requestUrl.searchParams.set('timeout_ms', String(timeoutMs));
                }
                const url = requestUrl.toString();
                const stringifyStartedAt = performance.now();
                const requestBody = JSON.stringify(body);
                const requestStringifyMs = preciseMs(performance.now() - stringifyStartedAt);
                const fetchStartedAt = performance.now();
                const headers: Record<string, string> = { 'Content-Type': 'application/json' };
                if (timeoutMs !== undefined) {
                    headers['X-SAM3-Timeout-Ms'] = String(timeoutMs);
                }
                if (endpoint === '/api/sam3/refine') {
                    headers['X-SAM3-Mask-Encoding'] = 'rle-compact';
                    headers['X-SAM3-Compact-Mask'] = '1';
                }
                const requestAbort = new AbortController();
                let timedOut = false;
                let timeoutId: number | undefined;
                const abortFromParent = () => requestAbort.abort(signal.reason);
                if (signal.aborted) {
                    abortFromParent();
                } else {
                    signal.addEventListener('abort', abortFromParent, { once: true });
                }
                if (timeoutMs !== undefined) {
                    timeoutId = window.setTimeout(() => {
                        timedOut = true;
                        requestAbort.abort();
                    }, timeoutMs);
                }

                let res: Response;
                try {
                    res = await fetch(url, {
                        method: 'POST',
                        headers,
                        credentials: getSam3FetchCredentials(sam3BackendUrl),
                        body: requestBody,
                        signal: requestAbort.signal
                    });
                } catch (err: any) {
                    if (timedOut && err?.name === 'AbortError') {
                        const timeoutError = new Error(`SAM request timed out after ${timeoutMs}ms`);
                        timeoutError.name = 'TimeoutError';
                        throw timeoutError;
                    }
                    if (err?.name !== 'AbortError' && err instanceof TypeError) {
                        throw new Error(describeSam3ConnectionError(sam3BackendUrl, err));
                    }
                    throw err;
                } finally {
                    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
                    signal.removeEventListener('abort', abortFromParent);
                }
                const fetchResolvedAt = performance.now();

                return {
                    res,
                    timings: {
                        endpoint,
                        status: res.status,
                        request_stringify_ms: requestStringifyMs,
                        request_bytes: requestBody.length,
                        fetch_ms: preciseMs(fetchResolvedAt - fetchStartedAt),
                        ...resourceTiming(url, fetchStartedAt, fetchResolvedAt)
                    }
                };
            };

            const refine = await request('/api/sam3/refine', refineBody);
            let final = refine;
            let fallbackFromStatus: number | undefined;
            if (refine.res.status === 404 || refine.res.status === 405 || refine.res.status === 501) {
                fallbackFromStatus = refine.res.status;
                final = await request('/api/sam3/segment', payload);
            }
            const jsonStartedAt = performance.now();
            const data = await final.res.json().catch(() => ({})) as Sam3SegmentResponse;
            const timings: Sam3SegmentTimings = {
                ...final.timings,
                total_ms: preciseMs(performance.now() - totalStartedAt),
                response_json_ms: preciseMs(performance.now() - jsonStartedAt),
                fallback_from_status: fallbackFromStatus,
                refine_status: refine.res.status,
                sam3_timeout_ms: timeoutMs,
                compact_mask_response: typeof data.rle_mask === 'string' && typeof data.mask !== 'string'
            };
            if (!final.res.ok) {
                return { ok: false, status: final.res.status, error: data.error || final.res.statusText, data, timings };
            }
            return { ok: true, data, timings };
        };

        const runClick = async (options: ArtisanClickRunOptions) => {
            if (busy) {
                events.fire('toast', 'Still processing previous Artisan click', 'info');
                return { ok: false, error: 'Still processing previous Artisan click' };
            }
            if (!options.allowInactive && !this.active) {
                return { ok: false, error: 'Artisan click selection is not active.' };
            }

            const splat = events.invoke('selection') as Splat;
            if (!splat) {
                console.warn('[ArtisanGS] No splat selected');
                events.fire('toast', 'No splat loaded', 'warning');
                return { ok: false, error: 'No splat loaded.' };
            }

            const [clickX, clickY] = options.click_xy;
            const op = options.op;
            const label = options.label;
            const shouldContinue = () => options.allowInactive || this.active;
            const totalStartedAt = performance.now();
            const { timeline, finish } = createTimingTracker(totalStartedAt);
            let captureMs = 0;
            let backendMs = 0;
            let decodeMs = 0;
            let maskDecodeMs = 0;
            let maskEncodeMs = 0;
            let applyMs = 0;

            busy = true;
            abort = new AbortController();
            const previousCursor = parent.style.cursor;
            parent.style.cursor = 'wait';

            events.fire('artisan.clickStarted', { x: clickX, y: clickY });
            events.fire('sam3.clickStarted', { x: clickX, y: clickY });

            try {
                const canvasWidth = canvas.clientWidth;
                const canvasHeight = canvas.clientHeight;
                const localFrameSize = resolveLocalFrameSize(canvasWidth, canvasHeight, options);
                const canvasClick_xy: [number, number] = [clickX, clickY];
                const camera = events.invoke('camera.debugState');
                const sam3BackendUrl = getSam3BackendUrl();
                const seedSam3TimeoutMs = resolveSeedSam3TimeoutMs(options);
                const captureAttemptMaxSides = resolveSeedCaptureAttemptMaxSides(canvasWidth, canvasHeight, options);
                const seedNegativeCornerPrompts = shouldUseSeedNegativeCornerPrompts(options);
                const failedSam3Attempts: Array<{
                    width: number;
                    height: number;
                    status: number;
                    error: string;
                    request_bytes?: number;
                    fetch_ms?: number;
                    timed_out?: boolean;
                    timeout_ms?: number;
                }> = [];
                let captureSize = resolveCaptureSize(canvasWidth, canvasHeight, options);
                let w = captureSize.width;
                let h = captureSize.height;
                let click_xy: [number, number] = [Math.round(clickX * captureSize.scale), Math.round(clickY * captureSize.scale)];
                let viewKey = '';
                let capturedImages: Awaited<ReturnType<typeof captureSceneImages>> | null = null;
                let localFrame: Awaited<ReturnType<typeof captureSceneImages>> | NonNullable<Awaited<ReturnType<typeof captureSceneImages>>['resized']> | null = null;
                let image_size: ArtisanImageSize = { width: w, height: h };
                let points: ArtisanPromptPoint[] = [];
                let segmentResult: Extract<Awaited<ReturnType<typeof fetchSegment>>, { ok: true }> | null = null;

                await waitForSplatCentersReady(splat);

                for (let attemptIndex = 0; attemptIndex < captureAttemptMaxSides.length; attemptIndex++) {
                    captureSize = resolveCaptureSizeForMaxSide(canvasWidth, canvasHeight, captureAttemptMaxSides[attemptIndex]);
                    w = captureSize.width;
                    h = captureSize.height;
                    click_xy = [
                        Math.round(clickX * captureSize.scale),
                        Math.round(clickY * captureSize.scale)
                    ];
                    viewKey = buildArtisanViewKey(scene, splat, w, h);
                    const captureStartedAt = performance.now();
                    capturedImages = await captureSceneImages(events, w, h, localFrameSize);
                    // Blank-capture guard: on a cold scene (first click after load/resize) the
                    // readback can be a black frame; SAM then returns a whole-frame garbage mask
                    // and the projected seed collapses. Force a render and recapture.
                    for (let blankRetry = 0; blankRetry < 2 && capturedImages.stats.non_black_ratio < 0.02; blankRetry++) {
                        console.warn(`[ArtisanGS] seed capture looks blank (nonBlack=${(capturedImages.stats.non_black_ratio * 100).toFixed(1)}%, luma=${capturedImages.stats.mean_luma.toFixed(1)}) — forcing render and recapturing`);
                        scene.forceRender = true;
                        await waitForRenderTick();
                        capturedImages = await captureSceneImages(events, w, h, localFrameSize);
                    }
                    if (capturedImages.stats.non_black_ratio < 0.02) {
                        events.fire('toast', 'Artisan seed capture came back blank — the scene has not rendered yet. Try clicking again in a moment.', 'warning');
                        return { ok: false, error: 'seed capture blank (scene not rendered)' };
                    }
                    localFrame = capturedImages.resized ?? capturedImages;
                    const captureStep = finish(attemptIndex === 0 ? 'capture' : `capture_retry_${attemptIndex}`, captureStartedAt);
                    captureMs += Math.round(captureStep.duration_ms);
                    if (!shouldContinue()) return { ok: false, error: 'cancelled' };

                    image_size = { width: w, height: h };
                    points = buildSeedPromptPoints(click_xy, label, image_size, seedNegativeCornerPrompts);
                    console.log(`[ArtisanGS] click=(${clickX},${clickY}) capture=(${click_xy[0]},${click_xy[1]}) ${w}x${h} op=${op} prompts=${points.length} attempt=${attemptIndex + 1}/${captureAttemptMaxSides.length}`);

                    const backendStartedAt = performance.now();
                    let attemptResult: Awaited<ReturnType<typeof fetchSegment>>;
                    try {
                        attemptResult = await fetchSegment(sam3BackendUrl, {
                            image: capturedImages.image,
                            click_xy,
                            label,
                            points,
                            image_size
                        }, abort.signal, seedSam3TimeoutMs);
                    } catch (err: any) {
                        const backendStep = finish(attemptIndex === 0 ? 'sam3_backend' : `sam3_backend_retry_${attemptIndex}`, backendStartedAt);
                        backendMs += Math.round(backendStep.duration_ms);
                        if (abort.signal.aborted || !shouldContinue()) return { ok: false, error: 'cancelled' };
                        const timedOut = err?.name === 'TimeoutError';
                        const error = err?.message || 'SAM seed request failed.';
                        failedSam3Attempts.push({
                            width: w,
                            height: h,
                            status: 0,
                            error,
                            fetch_ms: backendStep.duration_ms,
                            timed_out: timedOut,
                            timeout_ms: seedSam3TimeoutMs
                        });
                        console.warn(`[ArtisanGS] seed SAM attempt ${attemptIndex + 1}/${captureAttemptMaxSides.length} failed at ${w}x${h}: ${timedOut ? 'timeout' : 'network'} ${error}`);
                        continue;
                    }
                    const backendStep = finish(attemptIndex === 0 ? 'sam3_backend' : `sam3_backend_retry_${attemptIndex}`, backendStartedAt);
                    backendMs += Math.round(backendStep.duration_ms);
                    if (!shouldContinue()) return { ok: false, error: 'cancelled' };

                    if (attemptResult.ok === true) {
                        segmentResult = attemptResult;
                        break;
                    }

                    failedSam3Attempts.push({
                        width: w,
                        height: h,
                        status: attemptResult.status,
                        error: attemptResult.error,
                        request_bytes: attemptResult.timings.request_bytes,
                        fetch_ms: attemptResult.timings.fetch_ms,
                        timeout_ms: seedSam3TimeoutMs
                    });
                    console.warn(`[ArtisanGS] seed SAM attempt ${attemptIndex + 1}/${captureAttemptMaxSides.length} failed at ${w}x${h}: ${attemptResult.status} ${attemptResult.error}`);
                }

                if (!segmentResult || !capturedImages || !localFrame) {
                    const lastFailure = failedSam3Attempts[failedSam3Attempts.length - 1];
                    const error = lastFailure?.error ?? 'SAM seed capture failed.';
                    console.error(`[ArtisanGS] seed SAM failed after ${failedSam3Attempts.length} attempts: ${error}`);
                    events.fire('toast', formatArtisanToastError('Artisan click backend error', error), 'error');
                    return {
                        ok: false,
                        error,
                        status: lastFailure?.status,
                        seed_timings: {
                            backend_ms: backendMs,
                            capture_ms: captureMs,
                            sam3_timeout_ms: seedSam3TimeoutMs,
                            sam3_failed_attempts: failedSam3Attempts
                        }
                    };
                }

                const data = segmentResult.data;
                if ((!data.mask && !data.rle_mask) || data.width === undefined || data.height === undefined) {
                    console.error('[ArtisanGS] segmentation response missing mask data');
                    events.fire('toast', formatArtisanToastError('Artisan click backend error', data.error || 'missing mask data'), 'error');
                    return { ok: false, error: data.error || 'missing mask data' };
                }

                const decodeStartedAt = performance.now();
                let mask = data.rle_mask ?
                    rleMaskToArray(data.rle_mask, data.width, data.height, data.rle_run_count, data.rle_encoding) :
                    await maskPngToArray(data.mask!, data.width, data.height);
                maskDecodeMs = Math.round(finish('mask_decode', decodeStartedAt).duration_ms);
                if (!shouldContinue()) return { ok: false, error: 'cancelled' };
                const componentStartedAt = performance.now();
                const maskComponent = extractMaskComponentAroundSeed(
                    mask,
                    data.width,
                    data.height,
                    w,
                    h,
                    click_xy
                );
                mask = maskComponent.mask;
                const maskComponentMs = Math.round(finish('mask_component', componentStartedAt).duration_ms);
                const encodeStartedAt = performance.now();
                const normalizedMask = maskArrayToPngBase64(mask, data.width, data.height);
                maskEncodeMs = Math.round(finish('mask_encode', encodeStartedAt).duration_ms);
                decodeMs = maskDecodeMs + maskEncodeMs;

                const applyStartedAt = performance.now();
                let result = await applyArtisanMaskSelection(events, scene, splat, {
                    source: 'click',
                    mask,
                    maskWidth: data.width,
                    maskHeight: data.height,
                    imageWidth: w,
                    imageHeight: h,
                    op,
                    projectionMode: 'connected-surface',
                    seed: click_xy
                });
                // Cold-scene guard: on the first click after load, the mask->splat projection
                // can collapse to a handful of splats even for a good mask (stale depth), which
                // then starves the multiview planner. Retry once after forcing a fresh render.
                let seedProjectionRetried = false;
                if ((result?.selectedCount ?? 0) < 96) {
                    let maskAreaPx = 0;
                    for (let i = 0; i < mask.length; i++) {
                        if (mask[i] > 127) maskAreaPx++;
                    }
                    if (maskAreaPx > 200) {
                        seedProjectionRetried = true;
                        console.warn(`[ArtisanGS] seed projection degenerate (${result?.selectedCount ?? 0} splats for ${maskAreaPx}px mask) — retrying after fresh render`);
                        scene.forceRender = true;
                        await waitForRenderTick();
                        const retry = await applyArtisanMaskSelection(events, scene, splat, {
                            source: 'click',
                            mask,
                            maskWidth: data.width,
                            maskHeight: data.height,
                            imageWidth: w,
                            imageHeight: h,
                            op,
                            projectionMode: 'connected-surface',
                            seed: click_xy
                        });
                        if ((retry?.selectedCount ?? 0) > (result?.selectedCount ?? 0)) {
                            result = retry;
                        }
                        if ((result?.selectedCount ?? 0) < 96) {
                            events.fire('toast', `Artisan seed projected to only ${result?.selectedCount ?? 0} splats — multiview will likely stall. Try clicking again or brush-fix the seed.`, 'warning');
                        }
                    }
                }
                applyMs = Math.round(finish('mask_apply', applyStartedAt).duration_ms);
                const clickToMaskMs = Math.round(finish('click_to_mask', totalStartedAt).duration_ms);
                const timings = {
                    capture_ms: captureMs,
                    canvas_width: canvasWidth,
                    canvas_height: canvasHeight,
                    capture_width: w,
                    capture_height: h,
                    capture_scale: captureSize.scale,
                    seed_capture_attempt_count: failedSam3Attempts.length + 1,
                    seed_capture_attempt_max_sides: captureAttemptMaxSides,
                    seed_sam_failed_attempts: failedSam3Attempts,
                    capture_clear_confidence_ms: capturedImages.timings.clear_confidence_ms,
                    capture_render_ms: capturedImages.timings.render_ms,
                    capture_render_source: capturedImages.timings.render_source,
                    capture_render_setup_ms: capturedImages.timings.render_setup_ms,
                    capture_render_wait_postrender_ms: capturedImages.timings.render_wait_postrender_ms,
                    capture_render_alloc_ms: capturedImages.timings.render_alloc_ms,
                    capture_render_copy_ms: capturedImages.timings.render_copy_ms,
                    capture_render_read_ms: capturedImages.timings.render_read_ms,
                    capture_render_flip_ms: capturedImages.timings.render_flip_ms,
                    capture_render_cleanup_ms: capturedImages.timings.render_cleanup_ms,
                    capture_canvas_create_ms: capturedImages.timings.canvas_create_ms,
                    capture_canvas_put_ms: capturedImages.timings.canvas_put_ms,
                    capture_analysis_ms: capturedImages.timings.analysis_ms,
                    capture_encode_ms: capturedImages.timings.encode_ms,
                    local_frame_width: localFrame.width,
                    local_frame_height: localFrame.height,
                    local_frame_scale: localFrame.width / Math.max(1, canvasWidth),
                    local_frame_draw_ms: capturedImages.timings.local_draw_ms,
                    local_frame_analysis_ms: capturedImages.timings.local_analysis_ms,
                    local_frame_encode_ms: capturedImages.timings.local_encode_ms,
                    backend_ms: backendMs,
                    seed_projection_selected_count: result?.selectedCount ?? 0,
                    seed_projection_retried: seedProjectionRetried,
                    seed_prompt_point_count: points.length,
                    seed_prompt_positive_count: points.filter(point => point.label === 1).length,
                    seed_prompt_negative_count: points.filter(point => point.label === 0).length,
                    seed_prompt_negative_corner_enabled: seedNegativeCornerPrompts,
                    sam3_timeout_ms: seedSam3TimeoutMs,
                    sam3_endpoint: segmentResult.timings.endpoint,
                    sam3_total_ms: segmentResult.timings.total_ms,
                    sam3_request_stringify_ms: segmentResult.timings.request_stringify_ms,
                    sam3_request_bytes: segmentResult.timings.request_bytes,
                    sam3_fetch_ms: segmentResult.timings.fetch_ms,
                    sam3_response_json_ms: segmentResult.timings.response_json_ms,
                    sam3_resource_start_delay_ms: segmentResult.timings.resource_start_delay_ms,
                    sam3_resource_duration_ms: segmentResult.timings.resource_duration_ms,
                    sam3_resource_request_start_ms: segmentResult.timings.resource_request_start_ms,
                    sam3_resource_response_start_ms: segmentResult.timings.resource_response_start_ms,
                    sam3_resource_response_end_ms: segmentResult.timings.resource_response_end_ms,
                    sam3_fetch_resume_lag_ms: segmentResult.timings.fetch_resume_lag_ms,
                    sam3_fallback_from_status: segmentResult.timings.fallback_from_status,
                    sam3_refine_status: segmentResult.timings.refine_status,
                    sam3_compact_mask_response: segmentResult.timings.compact_mask_response,
                    decode_ms: decodeMs,
                    mask_decode_ms: maskDecodeMs,
                    mask_component_ms: maskComponentMs,
                    mask_component_isolated: maskComponent.isolated,
                    mask_component_area: maskComponent.componentArea,
                    mask_component_original_area: maskComponent.originalArea,
                    mask_component_search_radius_px: maskComponent.searchRadiusPx,
                    mask_component_seed_distance_px: maskComponent.nearestDistancePx,
                    mask_component_bbox: maskComponent.bbox,
                    mask_encode_ms: maskEncodeMs,
                    apply_ms: applyMs,
                    click_to_mask_ms: clickToMaskMs,
                    total_ms: clickToMaskMs,
                    timeline
                };
                console.log(`[ArtisanGS] seed click timings capture=${captureMs}ms render=${capturedImages.timings.render_ms}ms read=${capturedImages.timings.render_read_ms ?? 0}ms png=${capturedImages.timings.encode_ms}ms localPng=${capturedImages.timings.local_encode_ms ?? 0}ms backend=${backendMs}ms samFetch=${segmentResult.timings.fetch_ms}ms samStringify=${segmentResult.timings.request_stringify_ms}ms samResume=${segmentResult.timings.fetch_resume_lag_ms ?? 0}ms decode=${maskDecodeMs}ms component=${maskComponentMs}ms componentArea=${maskComponent.componentArea}/${maskComponent.originalArea}${maskComponent.isolated ? '' : ' shared'} encode=${maskEncodeMs}ms apply=${applyMs}ms clickToMask=${timings.click_to_mask_ms}ms total=${timings.total_ms}ms`);

                events.fire('artisan.clickPromptCaptured', {
                    type: 'sam_click',
                    click_xy: canvasClick_xy,
                    capture_click_xy: click_xy,
                    points,
                    selection_mode: op,
                    projection_mode: 'connected-surface',
                    view_key: viewKey,
                    image_size: { width: w, height: h },
                    mask_size: { width: data.width, height: data.height },
                    job_id: data.job_id,
                    mask_area_ratio: result?.maskAreaRatio,
                    timings,
                    result
                });

                const seed: ArtisanClickSeedPayload = {
                    source: 'click',
                    selection_mode: op,
                    projection_mode: 'connected-surface',
                    seed_xy: click_xy,
                    canvas_xy: canvasClick_xy,
                    view_key: viewKey,
                    frame: {
                        image: localFrame.image,
                        width: localFrame.width,
                        height: localFrame.height,
                        mimeType: localFrame.mimeType ?? capturedImages.mimeType ?? 'image/png',
                        camera,
                        mean_luma: localFrame.stats.mean_luma,
                        non_black_ratio: localFrame.stats.non_black_ratio,
                        alpha_ratio: localFrame.stats.alpha_ratio
                    },
                    mask: {
                        image: normalizedMask,
                        width: data.width,
                        height: data.height,
                        mimeType: 'image/png',
                        data: mask
                    },
                    timings,
                    result
                };

                let finalSeed = seed;
                if (shouldReviewSeedMask(options)) {
                    parent.style.cursor = 'crosshair';
                    const reviewedSeed = await reviewSeedMask(seed, splat, mask);
                    if (!reviewedSeed) {
                        return {
                            ok: false,
                            error: 'Seed mask review cancelled.',
                            click_xy: canvasClick_xy,
                            capture_click_xy: click_xy,
                            selection_mode: op,
                            seed,
                            seed_result: result,
                            seed_timings: timings,
                            timings: {
                                ...timings,
                                click_to_final_ms: preciseMs(performance.now() - totalStartedAt),
                                total_ms: preciseMs(performance.now() - totalStartedAt),
                                timeline
                            }
                        };
                    }
                    finalSeed = reviewedSeed;
                    parent.style.cursor = 'wait';
                }

                let localResult: unknown;
                let localMs: number | undefined;
                if (options.emitSeedEvent !== false) {
                    events.fire('artisan.seedMaskCaptured', finalSeed);
                } else if (options.runLocal !== false) {
                    const localOptions = options.localOptions ?? {};
                    const requestedFrameCount = numberOption(localOptions.frameCount);
                    const requestedCandidateChecks = numberOption(localOptions.candidateCheckBudget);
                    console.log(`[ArtisanGS] starting multiview local refinement frames=${requestedFrameCount ?? 'default'} checks=${requestedCandidateChecks ?? 'default'}`);
                    events.fire(
                        'toast',
                        requestedFrameCount && requestedFrameCount > 1 ?
                            `Starting ArtisanGS multiview (${requestedFrameCount} views)` :
                            'Starting ArtisanGS refinement',
                        'info'
                    );
                    const localStartedAt = performance.now();
                    const invokedLocalRun = events.invoke('artisan.local.run', finalSeed, localOptions);
                    if (invokedLocalRun === undefined) {
                        const error = 'ArtisanGS multiview runner is not registered.';
                        console.error(`[ArtisanGS] ${error}`);
                        events.fire('toast', error, 'error');
                        localResult = { ok: false, error };
                    } else {
                        localResult = await Promise.resolve(invokedLocalRun);
                    }
                    localMs = preciseMs(performance.now() - localStartedAt);
                    finish('local_refine', localStartedAt);
                }

                const totalMs = preciseMs(performance.now() - totalStartedAt);
                const localError = (() => {
                    const result = localResult as { ok?: boolean; error?: string } | null | undefined;
                    if (options.runLocal !== false && result?.ok === false) {
                        return result.error || 'Artisan local refinement failed.';
                    }
                    return undefined;
                })();
                return {
                    ok: !localError,
                    error: localError,
                    click_xy: canvasClick_xy,
                    capture_click_xy: click_xy,
                    selection_mode: op,
                    seed: finalSeed,
                    seed_result: finalSeed.result,
                    seed_timings: finalSeed.timings,
                    local_result: localResult,
                    review: options.includeReview ?
                        events.invoke('artisan.local.exportDebugReview', { includeImages: options.includeImages === true }) :
                        undefined,
                    timings: {
                        ...timings,
                        local_ms: localMs,
                        click_to_final_ms: totalMs,
                        total_ms: totalMs,
                        timeline
                    }
                };
            } catch (err: any) {
                if (err?.name === 'AbortError') return { ok: false, error: 'cancelled' };
                console.error('[ArtisanGS] click failed:', err);
                events.fire('toast', formatArtisanToastError('Artisan click request failed', err?.message), 'error');
                return { ok: false, error: err?.message || 'Artisan click request failed' };
            } finally {
                busy = false;
                abort = null;
                parent.style.cursor = this.active ? 'crosshair' : previousCursor;
            }
        };

        const pointerHandler = async (e: PointerEvent) => {
            if (!this.active) return;
            if (e.target !== canvas) return;
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();

            const rect = canvas.getBoundingClientRect();
            const clickX = Math.round(e.clientX - rect.left);
            const clickY = Math.round(e.clientY - rect.top);
            await runClick({
                click_xy: [clickX, clickY],
                op: getArtisanOpFromPointer(e, selectionMode),
                label: 1,
                emitSeedEvent: false,
                runLocal: true,
                reviewSeedMask: clickConfig.reviewSeedMask,
                localOptions: buildConfiguredLocalOptions()
            });
        };

        const modeHandler = (mode: ArtisanSelectionMode) => {
            selectionMode = mode;
            events.fire('artisan.selectionMode.changed', selectionMode);
            events.fire('artisanClick.selectionMode.changed', selectionMode);
            syncControls();
        };

        events.on('artisan.selectionMode', modeHandler);
        events.on('artisanClick.selectionMode', modeHandler);
        events.fire('artisan.selectionMode.changed', selectionMode);
        events.fire('artisanClick.selectionMode.changed', selectionMode);

        events.function('artisan.clickSelection.debugRun', (options: ArtisanDebugClickOptions = {}) => {
            const w = canvas.clientWidth;
            const h = canvas.clientHeight;
            const click_xy: [number, number] = options.click_xy ?? [
                Math.round(options.x ?? w / 2),
                Math.round(options.y ?? h / 2)
            ];
            const runLocal = options.runLocal !== false;
            const localOptions = runLocal ? buildConfiguredLocalOptions({
                showDebugViews: true,
                includeDebugCandidates: true,
                combinedPreview: 'confidence',
                ...options.localOptions
            }) : undefined;

            return runClick({
                click_xy,
                op: options.selectionMode ?? selectionMode,
                label: options.label ?? 1,
                allowInactive: true,
                emitSeedEvent: false,
                runLocal,
                reviewSeedMask: options.reviewSeedMask ?? clickConfig.reviewSeedMask,
                localOptions,
                includeReview: options.includeReview !== false,
                includeImages: options.includeImages === true
            });
        });

        events.function('artisan.clickSelection.config', () => ({ ...clickConfig }));
        events.function('artisan.clickSelection.setConfig', (patch: Partial<ArtisanClickConfig> = {}) => {
            setClickConfig({
                ...patch,
                presetId: patch.presetId ?? 'custom'
            });
            return { ...clickConfig };
        });

        this.activate = () => {
            this.active = true;
            controls.classList.remove('hidden');
            syncControls();
            parent.style.cursor = 'crosshair';
            parent.addEventListener('pointerdown', pointerHandler, true);
            events.fire('artisan.selectionMode.changed', selectionMode);
            events.fire('artisanClick.selectionMode.changed', selectionMode);
            void warnIfSam3ProxyDown(events);
            // Cold-start mitigation (best-effort). The EIG planner can starve on the very first
            // click after a fresh page load — candidate poses collapse before the render/centre
            // pipeline is warm. Pre-warm it once on activation (force a render, wait for splat
            // centres + a render tick) so the first real click plans against warm state. Purely
            // a warm-up: no selection side effects, so it cannot regress a healthy run. See the
            // artisangs-recall-expansion memory — cold-start remains intermittently open.
            if (!warmedUp) {
                warmedUp = true;
                void (async () => {
                    try {
                        const warmSplat = events.invoke('selection') as Splat | undefined;
                        if (!warmSplat) {
                            return;
                        }
                        scene.forceRender = true;
                        await waitForSplatCentersReady(warmSplat).catch(() => undefined);
                        scene.forceRender = true;
                        await waitForRenderTick();
                    } catch {
                        // warm-up is strictly best-effort
                    }
                })();
            }
        };

        this.deactivate = () => {
            this.active = false;
            cancelPendingSeedReview?.();
            cancelPendingSeedReview = null;
            controls.classList.add('hidden');
            parent.style.cursor = '';
            parent.removeEventListener('pointerdown', pointerHandler, true);
            abort?.abort();
            abort = null;
            busy = false;
        };
    }
}

export { ArtisanClickSelection };
