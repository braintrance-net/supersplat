import { Vec3 } from 'playcanvas';

import { SelectOp } from '../edit-ops';
import { Events } from '../events';
import { Scene } from '../scene';
import { Splat, type SplatUpdateStateOptions } from '../splat';

const EPS_FRAC_OF_DEPTH = 0.02;
const EPS_MIN_M = 0.005;
const EPS_MAX_M = 0.12;

const OCCLUSION_CELL_PX = 4;
const OCCLUSION_FRAC_OF_DEPTH = 0.015;
const OCCLUSION_MIN_M = 0.015;
const OCCLUSION_MAX_M = 0.12;
const CLICK_COMPONENT_SEARCH_RADIUS_PX = 32;
const SEED_GROW_RADIUS_MIN_M = 0.12;
// Raised 0.75->1.6: the old cap clipped the region grow before it could span a full object from
// an off-centre click (top-of-can click left the base unselected even with the diagonal reach).
const SEED_GROW_RADIUS_MAX_M = 1.6;
const SEED_GROW_DEPTH_MIN_M = 0.08;
const SEED_GROW_DEPTH_MAX_M = 0.55;
const SEED_GROW_DEPTH_RADIUS_SCALE = 0.75;
const CLICK_ANCHOR_RAY_RADIUS_PX = 8;
const CLICK_ANCHOR_MAX_NEAREST_PX = 18;
const CLICK_ANCHOR_EPS_FRAC_OF_DEPTH = 0.012;
const CLICK_ANCHOR_EPS_MIN_M = 0.012;
const CLICK_ANCHOR_EPS_MAX_M = 0.08;
const CLICK_ANCHOR_RADIUS_MIN_M = 0.08;
const CLICK_ANCHOR_RADIUS_MAX_M = 0.38;
const CLICK_ANCHOR_RADIUS_FRAC_OF_DEPTH = 0.035;
const CLICK_ANCHOR_DEPTH_MIN_M = 0.05;
const CLICK_ANCHOR_DEPTH_MAX_M = 0.22;
const CLICK_ANCHOR_DEPTH_FRAC_OF_DEPTH = 0.018;

type ArtisanSelectionMode = 'add' | 'remove' | 'set' | 'intersect';
type ArtisanMaskProjectionMode = 'frustum' | 'surface' | 'connected-surface' | 'connected-volume';
type ArtisanMaskSource = 'click' | 'brush';
type ArtisanPromptLabel = 0 | 1;
type ArtisanPromptPoint = { click_xy: [number, number]; label: ArtisanPromptLabel };
type ArtisanImageSize = { width: number; height: number };
type ArtisanImageStats = { mean_luma: number; non_black_ratio: number; alpha_ratio: number };
type ArtisanIntrinsics = { fx: number; fy: number; cx: number; cy: number };
type ArtisanRenderOffscreenTimings = {
    total_ms: number;
    source?: 'visible-canvas' | 'offscreen-render-target';
    setup_ms?: number;
    wait_postrender_ms?: number;
    alloc_ms?: number;
    copy_ms?: number;
    read_ms?: number;
    flip_ms?: number;
    cleanup_ms?: number;
};

type ArtisanCaptureSceneTimings = {
    total_ms: number;
    clear_confidence_ms: number;
    render_ms: number;
    render_source?: 'visible-canvas' | 'offscreen-render-target';
    render_setup_ms?: number;
    render_wait_postrender_ms?: number;
    render_alloc_ms?: number;
    render_copy_ms?: number;
    render_read_ms?: number;
    render_flip_ms?: number;
    render_cleanup_ms?: number;
    canvas_create_ms: number;
    canvas_put_ms: number;
    analysis_ms: number;
    encode_ms: number;
    local_draw_ms?: number;
    local_analysis_ms?: number;
    local_encode_ms?: number;
};

type ArtisanTimedRgba = {
    rgba: Uint8Array;
    timings: ArtisanRenderOffscreenTimings;
};

type ArtisanTimedPng = {
    image: string;
    mimeType: string;
    width: number;
    height: number;
    stats: ArtisanImageStats;
    timings: ArtisanRenderOffscreenTimings & { encode_ms?: number };
};

type ArtisanSelectionBounds = {
    center: { x: number; y: number; z: number };
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
    radius: number;
    count: number;
};

type ArtisanMaskInput = {
    source: ArtisanMaskSource;
    mask: Uint8Array;
    maskWidth: number;
    maskHeight: number;
    imageWidth: number;
    imageHeight: number;
    op: ArtisanSelectionMode;
    projectionMode: ArtisanMaskProjectionMode;
    seed?: [number, number];
};

type ArtisanSelectionResult = {
    source: ArtisanMaskSource;
    op: ArtisanSelectionMode;
    projectionMode: ArtisanMaskProjectionMode;
    selectedCount: number;
    projectedCandidateCount: number;
    surfaceCandidateCount: number;
    maskAreaRatio: number;
    seed?: [number, number];
    bounds?: ArtisanSelectionBounds;
    selectedRanges: [number, number][];
    seedMask?: {
        selectedCount: number;
        selectedRanges: [number, number][];
        bounds?: ArtisanSelectionBounds;
        projectedCandidateCount: number;
        surfaceCandidateCount: number;
    };
    clickAnchor?: {
        selectedCount: number;
        selectedRanges: [number, number][];
        bounds?: ArtisanSelectionBounds;
        seedIndex: number;
        seedSplatIndex: number;
        screen: [number, number];
        depth: number;
        nearestDistancePx: number;
        eps: number;
        maxSeedDistance: number;
        maxDepthDelta: number;
    };
    elapsedMs: number;
};

type ArtisanSelectionApplyTimings = {
    total_ms: number;
    select_op_build_ms: number;
    select_op_do_ms: number;
    history_ms: number;
    reveal_ms: number;
    update_bounds: boolean;
};

type ArtisanSelectionApplyOptions = {
    reveal?: boolean;
    updateBounds?: boolean;
};

type ArtisanMaskComponentResult = {
    mask: Uint8Array;
    originalArea: number;
    componentArea: number;
    isolated: boolean;
    seedMaskXY?: [number, number];
    nearestDistancePx?: number;
    searchRadiusPx: number;
    bbox?: [number, number, number, number];
};

type ArtisanSelectionProjection = ArtisanSelectionResult & {
    indices: Set<number>;
    logDetails: string;
};

type ArtisanVisibleSurfaceProjection = {
    indices: Set<number>;
    projectedCandidateCount: number;
    surfaceCandidateCount: number;
};

type Candidate = { idx: number; wx: number; wy: number; wz: number; cz: number; u: number; v: number };
type RegionGrowLimits = { maxSeedDistance?: number; maxDepthDelta?: number };

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const keyMatrix = (values?: Float32Array | number[]): string => {
    if (!values) return '';
    return Array.from(values).map(value => value.toFixed(5)).join(',');
};

const buildArtisanViewKey = (scene: Scene, splat: Splat, width: number, height: number): string => {
    const cam = scene.camera.camera as any;
    const view = keyMatrix(cam.viewMatrix?.data);
    const projection = keyMatrix(cam.projectionMatrix?.data) || `${cam.fov}:${cam.horizontalFov}:${cam.orthoHeight}`;
    const splatTransform = keyMatrix(splat.entity.getWorldTransform().data as Float32Array);
    return `${width}x${height}|${view}|${projection}|${splatTransform}`;
};

const normalizePromptPoint = (point: ArtisanPromptPoint, imageSize: ArtisanImageSize): [number, number] => {
    const width = Math.max(1, imageSize.width);
    const height = Math.max(1, imageSize.height);
    return [
        clamp01(point.click_xy[0] / width),
        clamp01(point.click_xy[1] / height)
    ];
};

const getArtisanOpFromPointer = (e: MouseEvent | PointerEvent, fallback: ArtisanSelectionMode): ArtisanSelectionMode => {
    if (e.altKey) return 'intersect';
    if (e.shiftKey) return 'add';
    if (e.ctrlKey || e.metaKey) return 'remove';
    return fallback;
};

const analyzeRgbaStats = (rgba: Uint8Array | Uint8ClampedArray): ArtisanImageStats => {
    let luma = 0;
    let nonBlack = 0;
    let alpha = 0;
    const count = Math.max(1, rgba.length / 4);
    for (let i = 0; i < rgba.length; i += 4) {
        const r = rgba[i];
        const g = rgba[i + 1];
        const b = rgba[i + 2];
        const a = rgba[i + 3];
        luma += 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (r > 4 || g > 4 || b > 4) {
            nonBlack++;
        }
        if (a > 0) {
            alpha++;
        }
    }

    return {
        mean_luma: luma / count,
        non_black_ratio: nonBlack / count,
        alpha_ratio: alpha / count
    };
};

const trimBase64DataUrl = (value: string) => value.replace(/^data:[^,]+,/, '');

const elapsedMs = (startMs: number) => Math.max(0, Math.round(performance.now() - startMs));

const urlFlagEnabled = (value: string | null) => value === '' || value === '1' || value === 'true' || value === 'yes' || value === 'on';

const visibleCaptureEnabled = () => urlFlagEnabled(new URLSearchParams(window.location.search).get('artisanVisibleCapture'));

const directPngCaptureEnabled = () => urlFlagEnabled(new URLSearchParams(window.location.search).get('artisanDirectPngCapture'));

// Multiplier on the click region-grow reach (?artisanSeedGrowReach=). Default 1.0 uses the
// full mask-bbox diagonal so a click anywhere on an object can flood-fill the WHOLE connected
// surface. The old behaviour (half the larger bbox side) meant a top-of-can click physically
// could not reach the base -> vertically "stubby" seed selection that capped the whole pipeline.
const seedGrowReach = () => {
    const raw = Number(new URLSearchParams(window.location.search).get('artisanSeedGrowReach'));
    return Number.isFinite(raw) && raw > 0 ? raw : 1.6;
};
// Independent depth-tolerance multiplier (?artisanSeedGrowDepth=). Kept separate from reach so
// the grow can span the full object HEIGHT without loosening the depth gate that stops it from
// leaking onto the adjacent desk surface. Lower this if the base bleeds onto the table.
const seedGrowDepth = () => {
    const raw = Number(new URLSearchParams(window.location.search).get('artisanSeedGrowDepth'));
    return Number.isFinite(raw) && raw > 0 ? raw : 1;
};

const captureImageMimeType = () => {
    const params = new URLSearchParams(window.location.search);
    const format = (params.get('artisanInputImageFormat') ?? params.get('artisanSam31InputImageFormat') ?? '').trim().toLowerCase();
    if (format === 'jpg' || format === 'jpeg') {
        return 'image/jpeg';
    }
    if (format === 'webp') {
        return 'image/webp';
    }
    return 'image/png';
};

const captureImageQuality = () => {
    const params = new URLSearchParams(window.location.search);
    const raw = Number(params.get('artisanInputImageQuality') ?? params.get('artisanSam31InputImageQuality'));
    return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : undefined;
};

const seedCaptureImageMimeType = () => {
    const params = new URLSearchParams(window.location.search);
    const format = (params.get('artisanSeedInputImageFormat') ?? '').trim().toLowerCase();
    if (format === 'jpg' || format === 'jpeg') {
        return 'image/jpeg';
    }
    if (format === 'webp') {
        return 'image/webp';
    }
    return 'image/png';
};

const seedCaptureImageQuality = () => {
    const raw = Number(new URLSearchParams(window.location.search).get('artisanSeedInputImageQuality'));
    return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : undefined;
};

const readBlobAsDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('image encode read failed'));
    reader.readAsDataURL(blob);
});

const encodeCanvasImage = async (
    canvas: HTMLCanvasElement,
    mimeType = captureImageMimeType(),
    quality = captureImageQuality()
) => {
    const encoded = await new Promise<string>((resolve) => {
        canvas.toBlob(async (blob) => {
            if (!blob) {
                resolve(canvas.toDataURL(mimeType, quality));
                return;
            }
            resolve(await readBlobAsDataUrl(blob));
        }, mimeType, quality);
    });
    const commaIndex = encoded.indexOf(',');
    const header = commaIndex >= 0 ? encoded.slice(0, commaIndex) : '';
    const actualMimeType = /^data:([^;]+);base64$/i.exec(header)?.[1]?.toLowerCase() ?? mimeType;
    return {
        image: commaIndex >= 0 ? encoded.slice(commaIndex + 1) : encoded,
        mimeType: actualMimeType
    };
};

const encodeSeedCanvasImage = (canvas: HTMLCanvasElement) => {
    const mimeType = seedCaptureImageMimeType();
    const encoded = canvas.toDataURL(mimeType, seedCaptureImageQuality());
    const commaIndex = encoded.indexOf(',');
    const header = commaIndex >= 0 ? encoded.slice(0, commaIndex) : '';
    const actualMimeType = /^data:([^;]+);base64$/i.exec(header)?.[1]?.toLowerCase() ?? mimeType;
    return {
        image: commaIndex >= 0 ? encoded.slice(commaIndex + 1) : encoded,
        mimeType: actualMimeType
    };
};

const rgbaLooksBlank = (rgba: Uint8Array) => {
    const pixelCount = Math.floor(rgba.length / 4);
    if (pixelCount === 0) {
        return true;
    }

    const stride = Math.max(1, Math.floor(pixelCount / 4096));
    let sampled = 0;
    let nonBlank = 0;
    for (let pixel = 0; pixel < pixelCount; pixel += stride) {
        const index = pixel * 4;
        sampled++;
        if (rgba[index + 3] > 0 && (rgba[index] > 0 || rgba[index + 1] > 0 || rgba[index + 2] > 0)) {
            nonBlank++;
        }
    }

    return sampled === 0 || nonBlank / sampled < 0.001;
};

const captureOffscreenRgbaTimed = async (
    events: Events,
    width: number,
    height: number
): Promise<ArtisanTimedRgba> => {
    const startedAt = performance.now();
    if (visibleCaptureEnabled() && events.invoke('config.artisanPreserveDrawingBuffer')) {
        try {
            const visible = await events.invoke('render.visibleCanvas.rgba.timed', width, height) as {
                data?: Uint8Array;
                rgba?: Uint8Array;
                timings?: ArtisanRenderOffscreenTimings;
            } | undefined;
            const visibleRgba = visible?.data ?? visible?.rgba;
            if (visibleRgba && !rgbaLooksBlank(visibleRgba)) {
                return {
                    rgba: visibleRgba,
                    timings: {
                        total_ms: visible?.timings?.total_ms ?? elapsedMs(startedAt),
                        source: 'visible-canvas',
                        setup_ms: visible?.timings?.setup_ms,
                        wait_postrender_ms: visible?.timings?.wait_postrender_ms,
                        alloc_ms: visible?.timings?.alloc_ms,
                        copy_ms: visible?.timings?.copy_ms,
                        read_ms: visible?.timings?.read_ms,
                        flip_ms: visible?.timings?.flip_ms,
                        cleanup_ms: visible?.timings?.cleanup_ms
                    }
                };
            }
        } catch (err) {
            console.warn('[ArtisanGS] Visible canvas capture unavailable; falling back to offscreen capture', err);
        }
    }

    const result = await events.invoke('render.offscreen.timed', width, height) as {
        data?: Uint8Array;
        rgba?: Uint8Array;
        timings?: ArtisanRenderOffscreenTimings;
    } | undefined;
    const rgba = result?.data ?? result?.rgba;
    if (rgba) {
        return {
            rgba,
            timings: {
                total_ms: result?.timings?.total_ms ?? elapsedMs(startedAt),
                source: 'offscreen-render-target',
                setup_ms: result?.timings?.setup_ms,
                wait_postrender_ms: result?.timings?.wait_postrender_ms,
                alloc_ms: result?.timings?.alloc_ms,
                copy_ms: result?.timings?.copy_ms,
                read_ms: result?.timings?.read_ms,
                flip_ms: result?.timings?.flip_ms,
                cleanup_ms: result?.timings?.cleanup_ms
            }
        };
    }

    const fallbackStartedAt = performance.now();
    return {
        rgba: await events.invoke('render.offscreen', width, height) as Uint8Array,
        timings: {
            total_ms: elapsedMs(fallbackStartedAt),
            source: 'offscreen-render-target'
        }
    };
};

const captureVisibleCanvasPngTimed = async (
    events: Events,
    width: number,
    height: number
): Promise<ArtisanTimedPng | null> => {
    if (!directPngCaptureEnabled() || !events.invoke('config.artisanPreserveDrawingBuffer')) {
        return null;
    }

    try {
        const captured = await events.invoke('render.visibleCanvas.png.timed', width, height, {
            mimeType: seedCaptureImageMimeType(),
            quality: seedCaptureImageQuality()
        }) as {
            image?: string;
            mimeType?: string;
            width?: number;
            height?: number;
            stats?: ArtisanImageStats;
            timings?: ArtisanRenderOffscreenTimings & { encode_ms?: number };
        } | undefined;
        if (!captured?.image || !captured.stats) {
            return null;
        }

        return {
            image: trimBase64DataUrl(captured.image),
            mimeType: captured.mimeType ?? seedCaptureImageMimeType(),
            width: captured.width ?? width,
            height: captured.height ?? height,
            stats: captured.stats,
            timings: {
                total_ms: captured.timings?.total_ms ?? 0,
                source: 'visible-canvas',
                setup_ms: captured.timings?.setup_ms,
                wait_postrender_ms: captured.timings?.wait_postrender_ms,
                alloc_ms: captured.timings?.alloc_ms,
                copy_ms: captured.timings?.copy_ms,
                read_ms: captured.timings?.read_ms,
                flip_ms: captured.timings?.flip_ms,
                cleanup_ms: captured.timings?.cleanup_ms,
                encode_ms: captured.timings?.encode_ms
            }
        };
    } catch (err) {
        console.warn('[ArtisanGS] Direct visible canvas PNG capture unavailable; falling back to RGBA capture', err);
        return null;
    }
};

const captureSceneImages = async (
    events: Events,
    width: number,
    height: number,
    resized?: { width: number; height: number }
): Promise<{
    image: string;
    mimeType: string;
    width: number;
    height: number;
    stats: ArtisanImageStats;
    timings: ArtisanCaptureSceneTimings;
    resized?: {
        image: string;
        mimeType: string;
        width: number;
        height: number;
        stats: ArtisanImageStats;
    };
}> => {
    const startedAt = performance.now();
    const clearConfidenceStartedAt = performance.now();
    const splats = (events.invoke('scene.allSplats') as Splat[] | undefined) ?? [];
    for (const splat of splats) {
        splat.setArtisanConfidencePreview(null);
    }
    const clearConfidenceMs = elapsedMs(clearConfidenceStartedAt);

    const direct = await captureVisibleCanvasPngTimed(events, width, height);
    if (direct) {
        const timings: ArtisanCaptureSceneTimings = {
            total_ms: 0,
            clear_confidence_ms: clearConfidenceMs,
            render_ms: direct.timings.total_ms,
            render_source: direct.timings.source,
            render_setup_ms: direct.timings.setup_ms,
            render_wait_postrender_ms: direct.timings.wait_postrender_ms,
            render_alloc_ms: direct.timings.alloc_ms,
            render_copy_ms: direct.timings.copy_ms,
            render_read_ms: direct.timings.read_ms,
            render_flip_ms: direct.timings.flip_ms,
            render_cleanup_ms: direct.timings.cleanup_ms,
            canvas_create_ms: 0,
            canvas_put_ms: 0,
            analysis_ms: direct.timings.read_ms ?? 0,
            encode_ms: direct.timings.encode_ms ?? 0
        };
        let resizedImage: {
            image: string;
            mimeType: string;
            width: number;
            height: number;
            stats: ArtisanImageStats;
        } | undefined;

        if (resized && (resized.width !== width || resized.height !== height)) {
            const sourceImage = await new Promise<HTMLImageElement>((resolve, reject) => {
                const image = new Image();
                image.onload = () => resolve(image);
                image.onerror = () => reject(new Error('direct capture image decode failed'));
                image.src = `data:${direct.mimeType};base64,${direct.image}`;
            });
            const small = document.createElement('canvas');
            small.width = resized.width;
            small.height = resized.height;
            const smallCtx = small.getContext('2d')!;
            const localDrawStartedAt = performance.now();
            smallCtx.drawImage(sourceImage, 0, 0, resized.width, resized.height);
            const localDrawMs = elapsedMs(localDrawStartedAt);
            const localAnalysisStartedAt = performance.now();
            const localStats = analyzeRgbaStats(smallCtx.getImageData(0, 0, resized.width, resized.height).data);
            const localAnalysisMs = elapsedMs(localAnalysisStartedAt);
            const localEncodeStartedAt = performance.now();
            const localEncoded = encodeSeedCanvasImage(small);
            const localEncodeMs = elapsedMs(localEncodeStartedAt);
            resizedImage = {
                image: localEncoded.image,
                mimeType: localEncoded.mimeType,
                width: resized.width,
                height: resized.height,
                stats: localStats
            };
            timings.local_draw_ms = localDrawMs;
            timings.local_analysis_ms = localAnalysisMs;
            timings.local_encode_ms = localEncodeMs;
        }

        timings.total_ms = elapsedMs(startedAt);
        return {
            image: direct.image,
            mimeType: direct.mimeType,
            width,
            height,
            stats: direct.stats,
            timings,
            resized: resizedImage
        };
    }

    const render = await captureOffscreenRgbaTimed(events, width, height);
    const rgba = render.rgba;
    const canvasCreateStartedAt = performance.now();
    const off = document.createElement('canvas');
    off.width = width;
    off.height = height;
    const ctx = off.getContext('2d')!;
    const imageData = ctx.createImageData(width, height);
    const canvasCreateMs = elapsedMs(canvasCreateStartedAt);
    const canvasPutStartedAt = performance.now();
    imageData.data.set(rgba);
    ctx.putImageData(imageData, 0, 0);
    const canvasPutMs = elapsedMs(canvasPutStartedAt);
    const analysisStartedAt = performance.now();
    const stats = analyzeRgbaStats(rgba);
    const analysisMs = elapsedMs(analysisStartedAt);
    const encodeStartedAt = performance.now();
    const encoded = encodeSeedCanvasImage(off);
    const encodeMs = elapsedMs(encodeStartedAt);
    const timings: ArtisanCaptureSceneTimings = {
        total_ms: 0,
        clear_confidence_ms: clearConfidenceMs,
        render_ms: render.timings.total_ms,
        render_source: render.timings.source,
        render_setup_ms: render.timings.setup_ms,
        render_wait_postrender_ms: render.timings.wait_postrender_ms,
        render_alloc_ms: render.timings.alloc_ms,
        render_copy_ms: render.timings.copy_ms,
        render_read_ms: render.timings.read_ms,
        render_flip_ms: render.timings.flip_ms,
        render_cleanup_ms: render.timings.cleanup_ms,
        canvas_create_ms: canvasCreateMs,
        canvas_put_ms: canvasPutMs,
        analysis_ms: analysisMs,
        encode_ms: encodeMs
    };
    let resizedImage: {
        image: string;
        mimeType: string;
        width: number;
        height: number;
        stats: ArtisanImageStats;
    } | undefined;

    if (resized && (resized.width !== width || resized.height !== height)) {
        const small = document.createElement('canvas');
        small.width = resized.width;
        small.height = resized.height;
        const smallCtx = small.getContext('2d')!;
        const localDrawStartedAt = performance.now();
        smallCtx.drawImage(off, 0, 0, resized.width, resized.height);
        const localDrawMs = elapsedMs(localDrawStartedAt);
        const localAnalysisStartedAt = performance.now();
        const localStats = analyzeRgbaStats(smallCtx.getImageData(0, 0, resized.width, resized.height).data);
        const localAnalysisMs = elapsedMs(localAnalysisStartedAt);
        const localEncodeStartedAt = performance.now();
        const localEncoded = encodeSeedCanvasImage(small);
        const localEncodeMs = elapsedMs(localEncodeStartedAt);
        resizedImage = {
            image: localEncoded.image,
            mimeType: localEncoded.mimeType,
            width: resized.width,
            height: resized.height,
            stats: localStats
        };
        timings.local_draw_ms = localDrawMs;
        timings.local_analysis_ms = localAnalysisMs;
        timings.local_encode_ms = localEncodeMs;
    }

    timings.total_ms = elapsedMs(startedAt);

    return {
        image: encoded.image,
        mimeType: encoded.mimeType,
        width,
        height,
        stats,
        timings,
        resized: resizedImage
    };
};

const captureScene = async (events: Events, width: number, height: number): Promise<string> => {
    return (await captureSceneImages(events, width, height)).image;
};

const maskPngToArray = async (b64: string, width: number, height: number): Promise<Uint8Array> => {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('mask image load failed'));
        img.src = `data:image/png;base64,${b64}`;
    });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, width, height);
    const id = ctx.getImageData(0, 0, width, height);
    const out = new Uint8Array(width * height);
    for (let i = 0, j = 0; i < id.data.length; i += 4, j++) {
        const luminance = Math.max(id.data[i], id.data[i + 1], id.data[i + 2]);
        const alpha = id.data[i + 3];
        out[j] = alpha < 255 ? alpha : luminance;
    }
    return out;
};

const base64ToBytes = (value: string) => {
    const payload = value.includes(',') ? value.split(',').pop()! : value;
    const binary = window.atob(payload.replace(/\s/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
};

const rleMaskToArray = (
    b64: string,
    width: number,
    height: number,
    runCount?: number,
    encoding?: string
): Uint8Array => {
    if (encoding !== undefined && encoding !== 'uint32-runs-v1') {
        throw new Error(`Unsupported RLE mask encoding ${encoding}`);
    }

    const bytes = base64ToBytes(b64);
    if (bytes.length % 8 !== 0) {
        throw new Error(`RLE mask byte length must be divisible by 8; got ${bytes.length}`);
    }

    const expectedRunCount = bytes.length / 8;
    if (runCount !== undefined && runCount !== expectedRunCount) {
        throw new Error(`RLE run count mismatch: expected ${runCount}, got ${expectedRunCount}`);
    }

    const mask = new Uint8Array(width * height);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let offset = 0; offset < bytes.length; offset += 8) {
        const start = view.getUint32(offset, true);
        const length = view.getUint32(offset + 4, true);
        const end = start + length;
        if (length === 0 || start >= mask.length || end > mask.length) {
            throw new Error(`RLE run out of range: start=${start} length=${length} expected=${mask.length}`);
        }
        mask.fill(255, start, end);
    }
    return mask;
};

const canvasAlphaToMask = (canvas: HTMLCanvasElement, context: CanvasRenderingContext2D): Uint8Array => {
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const mask = new Uint8Array(canvas.width * canvas.height);
    for (let i = 0, j = 0; i < image.data.length; i += 4, j++) {
        mask[j] = image.data[i + 3];
    }
    return mask;
};

const maskArrayToPngBase64 = (mask: Uint8Array, width: number, height: number): string => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d')!;
    const imageData = context.createImageData(width, height);
    for (let i = 0; i < mask.length; i++) {
        const value = mask[i] > 0 ? 255 : 0;
        const offset = i * 4;
        imageData.data[offset] = value;
        imageData.data[offset + 1] = value;
        imageData.data[offset + 2] = value;
        imageData.data[offset + 3] = 255;
    }
    context.putImageData(imageData, 0, 0);
    return canvas.toDataURL('image/png').split(',')[1];
};

const getMaskAreaRatio = (mask: Uint8Array) => {
    if (mask.length === 0) return 0;
    let count = 0;
    for (let i = 0; i < mask.length; i++) {
        if (mask[i] > 0) count++;
    }
    return count / mask.length;
};

const countMaskPixels = (mask: Uint8Array) => {
    let count = 0;
    for (let i = 0; i < mask.length; i++) {
        if (mask[i] > 0) count++;
    }
    return count;
};

const getMaskBoundingBox = (mask: Uint8Array, maskWidth: number, maskHeight: number): [number, number, number, number] | undefined => {
    let minX = maskWidth;
    let minY = maskHeight;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < maskHeight; y++) {
        const row = y * maskWidth;
        for (let x = 0; x < maskWidth; x++) {
            if (mask[row + x] === 0) {
                continue;
            }
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
        }
    }

    return maxX >= minX && maxY >= minY ? [minX, minY, maxX, maxY] : undefined;
};

const estimateSeedGrowLimits = (
    bbox: [number, number, number, number] | undefined,
    maskWidth: number,
    maskHeight: number,
    imageWidth: number,
    imageHeight: number,
    clickDepth: number,
    intrinsics: ArtisanIntrinsics
): Required<RegionGrowLimits> => {
    const bboxWidthPx = bbox ?
        Math.max(1, (bbox[2] - bbox[0] + 1) * imageWidth / Math.max(1, maskWidth)) :
        Math.max(12, imageWidth * 0.04);
    const bboxHeightPx = bbox ?
        Math.max(1, (bbox[3] - bbox[1] + 1) * imageHeight / Math.max(1, maskHeight)) :
        Math.max(12, imageHeight * 0.04);
    const focal = Math.max(1, (intrinsics.fx + intrinsics.fy) * 0.5);
    // Object's world extent from the mask-bbox DIAGONAL (independent of the tuning knobs) — the
    // half-larger-side basis clipped tall objects to a stubby blob around an off-centre click.
    const objectRadius = Math.max(0, clickDepth) * Math.hypot(bboxWidthPx, bboxHeightPx) / focal;
    // Spatial reach: how far from the click the grow may travel, scaled so a click anywhere spans
    // the whole object (?artisanSeedGrowReach=). Depth tolerance is derived from the object's OWN
    // extent, NOT from reach, so extending reach to cover full height never loosens the gate that
    // stops the grow from leaking onto the adjacent desk (?artisanSeedGrowDepth= to tune).
    const maxSeedDistance = Math.min(
        SEED_GROW_RADIUS_MAX_M,
        Math.max(SEED_GROW_RADIUS_MIN_M, objectRadius * seedGrowReach() * 1.1)
    );
    const maxDepthDelta = Math.min(
        SEED_GROW_DEPTH_MAX_M,
        Math.max(SEED_GROW_DEPTH_MIN_M, objectRadius * SEED_GROW_DEPTH_RADIUS_SCALE * seedGrowDepth())
    );

    return { maxSeedDistance, maxDepthDelta };
};

const extractMaskComponentAroundSeed = (
    mask: Uint8Array,
    maskWidth: number,
    maskHeight: number,
    imageWidth: number,
    imageHeight: number,
    seed?: [number, number],
    searchRadiusImagePx = CLICK_COMPONENT_SEARCH_RADIUS_PX
): ArtisanMaskComponentResult => {
    const originalArea = countMaskPixels(mask);
    const searchRadiusPx = Math.max(
        2,
        Math.round(searchRadiusImagePx * ((maskWidth / Math.max(1, imageWidth) + maskHeight / Math.max(1, imageHeight)) * 0.5))
    );

    if (!seed || originalArea === 0 || maskWidth <= 0 || maskHeight <= 0) {
        return {
            mask,
            originalArea,
            componentArea: originalArea,
            isolated: false,
            searchRadiusPx
        };
    }

    // Uniform (aspect-preserving) mask scale — same letterbox reason as collectMaskCandidates.
    const seedMaskScale = Math.min(maskWidth / Math.max(1, imageWidth), maskHeight / Math.max(1, imageHeight));
    const seedX = Math.min(maskWidth - 1, Math.max(0, Math.round(seed[0] * seedMaskScale)));
    const seedY = Math.min(maskHeight - 1, Math.max(0, Math.round(seed[1] * seedMaskScale)));
    let start = seedY * maskWidth + seedX;
    let bestD2 = mask[start] > 0 ? 0 : Infinity;

    if (mask[start] === 0) {
        const minY = Math.max(0, seedY - searchRadiusPx);
        const maxY = Math.min(maskHeight - 1, seedY + searchRadiusPx);
        const minX = Math.max(0, seedX - searchRadiusPx);
        const maxX = Math.min(maskWidth - 1, seedX + searchRadiusPx);
        const r2 = searchRadiusPx * searchRadiusPx;
        for (let y = minY; y <= maxY; y++) {
            const dy = y - seedY;
            for (let x = minX; x <= maxX; x++) {
                const dx = x - seedX;
                const d2 = dx * dx + dy * dy;
                if (d2 > r2 || d2 >= bestD2 || mask[y * maskWidth + x] === 0) {
                    continue;
                }
                bestD2 = d2;
                start = y * maskWidth + x;
            }
        }
    }

    if (!Number.isFinite(bestD2)) {
        return {
            mask,
            originalArea,
            componentArea: originalArea,
            isolated: false,
            seedMaskXY: [seedX, seedY],
            searchRadiusPx
        };
    }

    const out = new Uint8Array(mask.length);
    const visited = new Uint8Array(mask.length);
    const queue = new Int32Array(mask.length);
    let head = 0;
    let tail = 0;
    let componentArea = 0;
    let minX = maskWidth - 1;
    let minY = maskHeight - 1;
    let maxX = 0;
    let maxY = 0;

    visited[start] = 1;
    queue[tail++] = start;

    while (head < tail) {
        const idx = queue[head++];
        const value = mask[idx];
        if (value === 0) {
            continue;
        }

        out[idx] = value;
        componentArea++;
        const x = idx % maskWidth;
        const y = Math.floor(idx / maskWidth);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);

        for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= maskHeight) {
                continue;
            }

            for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) {
                    continue;
                }
                const xx = x + dx;
                if (xx < 0 || xx >= maskWidth) {
                    continue;
                }
                const next = yy * maskWidth + xx;
                if (visited[next] || mask[next] === 0) {
                    continue;
                }
                visited[next] = 1;
                queue[tail++] = next;
            }
        }
    }

    if (componentArea === 0 || componentArea === originalArea) {
        return {
            mask,
            originalArea,
            componentArea: originalArea,
            isolated: false,
            seedMaskXY: [seedX, seedY],
            nearestDistancePx: Math.sqrt(bestD2),
            searchRadiusPx,
            bbox: componentArea > 0 ? [minX, minY, maxX, maxY] : undefined
        };
    }

    return {
        mask: out,
        originalArea,
        componentArea,
        isolated: true,
        seedMaskXY: [seedX, seedY],
        nearestDistancePx: Math.sqrt(bestD2),
        searchRadiusPx,
        bbox: [minX, minY, maxX, maxY]
    };
};

const extractIntrinsics = (cam: any, w: number, h: number): ArtisanIntrinsics => {
    const fovRad = (cam.fov * Math.PI) / 180;
    const f = cam.horizontalFov ?
        w / (2 * Math.tan(fovRad / 2)) :
        h / (2 * Math.tan(fovRad / 2));
    return { fx: f, fy: f, cx: w / 2, cy: h / 2 };
};

const collectMaskCandidates = (
    splat: Splat,
    scene: Scene,
    mask: Uint8Array,
    maskW: number,
    maskH: number,
    imgW: number,
    imgH: number,
    intrinsics: ArtisanIntrinsics
): Candidate[] => {
    const sorter = (splat.entity as any).gsplat?.instance?.sorter;
    const centers = sorter?.centers as Float32Array | undefined;
    if (!centers) return [];

    const wm = splat.entity.getWorldTransform().data as Float32Array;
    const v = scene.camera.camera.viewMatrix.data as Float32Array;
    const { fx, fy, cx, cy } = intrinsics;
    // Uniform (aspect-preserving) mask scale: SAM letterboxes its mask (longest side resized,
    // short side padded, content top-left), so image->mask mapping uses ONE scale on both axes.
    // Independent factors compressed tall objects vertically ("stubby" seed selection). Math.min
    // is a no-op when the backend returns a frame-matched (un-padded) mask.
    const msx = Math.min(maskW / imgW, maskH / imgH);
    const msy = msx;

    const out: Candidate[] = [];
    const n = centers.length / 3;
    for (let i = 0; i < n; i++) {
        const lx = centers[i * 3], ly = centers[i * 3 + 1], lz = centers[i * 3 + 2];
        const wx = wm[0] * lx + wm[4] * ly + wm[8]  * lz + wm[12];
        const wy = wm[1] * lx + wm[5] * ly + wm[9]  * lz + wm[13];
        const wz = wm[2] * lx + wm[6] * ly + wm[10] * lz + wm[14];
        const ogZ = v[2] * wx + v[6] * wy + v[10] * wz + v[14];
        const cz = -ogZ;
        if (cz <= 0) continue;

        const ogX = v[0] * wx + v[4] * wy + v[8]  * wz + v[12];
        const ogY = v[1] * wx + v[5] * wy + v[9]  * wz + v[13];
        const u = Math.round(fx * ogX / cz + cx);
        const vp = Math.round(fy * (-ogY) / cz + cy);
        if (u < 0 || u >= imgW || vp < 0 || vp >= imgH) continue;

        const mu = Math.min(maskW - 1, Math.max(0, Math.round(u * msx)));
        const mv = Math.min(maskH - 1, Math.max(0, Math.round(vp * msy)));
        if (mask[mv * maskW + mu] === 0) continue;
        out.push({ idx: i, wx, wy, wz, cz, u, v: vp });
    }
    return out;
};

const collectVisibleCandidates = (
    splat: Splat,
    scene: Scene,
    imgW: number,
    imgH: number,
    intrinsics: ArtisanIntrinsics
): Candidate[] => {
    const sorter = (splat.entity as any).gsplat?.instance?.sorter;
    const centers = sorter?.centers as Float32Array | undefined;
    if (!centers) return [];

    const wm = splat.entity.getWorldTransform().data as Float32Array;
    const v = scene.camera.camera.viewMatrix.data as Float32Array;
    const { fx, fy, cx, cy } = intrinsics;

    const out: Candidate[] = [];
    const n = centers.length / 3;
    for (let i = 0; i < n; i++) {
        const lx = centers[i * 3], ly = centers[i * 3 + 1], lz = centers[i * 3 + 2];
        const wx = wm[0] * lx + wm[4] * ly + wm[8]  * lz + wm[12];
        const wy = wm[1] * lx + wm[5] * ly + wm[9]  * lz + wm[13];
        const wz = wm[2] * lx + wm[6] * ly + wm[10] * lz + wm[14];
        const ogZ = v[2] * wx + v[6] * wy + v[10] * wz + v[14];
        const cz = -ogZ;
        if (cz <= 0) continue;

        const ogX = v[0] * wx + v[4] * wy + v[8]  * wz + v[12];
        const ogY = v[1] * wx + v[5] * wy + v[9]  * wz + v[13];
        const u = Math.round(fx * ogX / cz + cx);
        const vp = Math.round(fy * (-ogY) / cz + cy);
        if (u < 0 || u >= imgW || vp < 0 || vp >= imgH) continue;

        out.push({ idx: i, wx, wy, wz, cz, u, v: vp });
    }
    return out;
};

const filterFrontSurfaceCandidates = (
    candidates: Candidate[],
    imgW: number,
    imgH: number,
    depthCandidates: Candidate[] = candidates
): Candidate[] => {
    const depthW = Math.ceil(imgW / OCCLUSION_CELL_PX);
    const depthH = Math.ceil(imgH / OCCLUSION_CELL_PX);
    const nearest = new Float32Array(depthW * depthH);
    nearest.fill(Infinity);

    for (const candidate of depthCandidates) {
        const x = Math.min(depthW - 1, Math.max(0, Math.floor(candidate.u / OCCLUSION_CELL_PX)));
        const y = Math.min(depthH - 1, Math.max(0, Math.floor(candidate.v / OCCLUSION_CELL_PX)));
        const idx = y * depthW + x;
        if (candidate.cz < nearest[idx]) {
            nearest[idx] = candidate.cz;
        }
    }

    return candidates.filter((candidate) => {
        const x = Math.min(depthW - 1, Math.max(0, Math.floor(candidate.u / OCCLUSION_CELL_PX)));
        const y = Math.min(depthH - 1, Math.max(0, Math.floor(candidate.v / OCCLUSION_CELL_PX)));
        let nearestDepth = Infinity;

        for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= depthH) continue;

            for (let dx = -1; dx <= 1; dx++) {
                const xx = x + dx;
                if (xx < 0 || xx >= depthW) continue;
                nearestDepth = Math.min(nearestDepth, nearest[yy * depthW + xx]);
            }
        }

        const tolerance = Math.min(
            OCCLUSION_MAX_M,
            Math.max(OCCLUSION_MIN_M, nearestDepth * OCCLUSION_FRAC_OF_DEPTH)
        );
        return candidate.cz <= nearestDepth + tolerance;
    });
};

const findSeedOnRay = (candidates: Candidate[], clickX: number, clickY: number, radius = 6): number => {
    const r2 = radius * radius;
    let ray = -1;
    let rayZ = Infinity;
    let fallback = -1;
    let fallbackD2 = Infinity;
    for (let i = 0; i < candidates.length; i++) {
        const du = candidates[i].u - clickX;
        const dv = candidates[i].v - clickY;
        const d2 = du * du + dv * dv;
        if (d2 < fallbackD2) {
            fallbackD2 = d2;
            fallback = i;
        }
        if (d2 <= r2 && candidates[i].cz < rayZ) {
            rayZ = candidates[i].cz;
            ray = i;
        }
    }
    return ray >= 0 ? ray : fallback;
};

const nearestScreenDistance = (candidate: Candidate | undefined, clickX: number, clickY: number) => {
    if (!candidate) {
        return Infinity;
    }

    return Math.hypot(candidate.u - clickX, candidate.v - clickY);
};

const quantile = (values: number[], q: number) => {
    if (values.length === 0) {
        return 0;
    }
    const index = Math.max(0, Math.min(values.length - 1, Math.floor((values.length - 1) * q)));
    return values[index];
};

const findSeedOnFrontMaskLayer = (candidates: Candidate[], clickX: number, clickY: number, radius = 20): number => {
    const raySeed = findSeedOnRay(candidates, clickX, clickY, radius);
    if (candidates.length < 8) {
        return raySeed;
    }

    const depths = candidates.map(candidate => candidate.cz).sort((a, b) => a - b);
    const frontDepth = quantile(depths, 0.08);
    const medianDepth = quantile(depths, 0.5);
    const tolerance = Math.min(EPS_MAX_M * 2, Math.max(EPS_MIN_M * 4, frontDepth * EPS_FRAC_OF_DEPTH * 1.5));
    const frontLimit = frontDepth + tolerance;
    let bestFront = -1;
    let bestScore = Infinity;

    for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        if (candidate.cz > frontLimit) {
            continue;
        }

        const du = candidate.u - clickX;
        const dv = candidate.v - clickY;
        const distance = Math.sqrt(du * du + dv * dv);
        const depthScore = Math.max(0, candidate.cz - frontDepth) / Math.max(tolerance, EPS_MIN_M);
        const score = distance + depthScore * 8;
        if (score < bestScore) {
            bestScore = score;
            bestFront = i;
        }
    }

    if (bestFront < 0 || raySeed < 0) {
        return bestFront >= 0 ? bestFront : raySeed;
    }

    const rayDepth = candidates[raySeed].cz;
    const separatedDepth = rayDepth > frontLimit + Math.max(0.08, medianDepth * 0.01);
    return separatedDepth ? bestFront : raySeed;
};

const buildHash = (candidates: Candidate[], eps: number): Map<number, number[]> => {
    const cells = new Map<number, number[]>();
    const inv = 1 / eps;
    for (let i = 0; i < candidates.length; i++) {
        const ix = Math.floor(candidates[i].wx * inv) | 0;
        const iy = Math.floor(candidates[i].wy * inv) | 0;
        const iz = Math.floor(candidates[i].wz * inv) | 0;
        const key = (ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791);
        const bucket = cells.get(key);
        if (bucket) {
            bucket.push(i);
        } else {
            cells.set(key, [i]);
        }
    }
    return cells;
};

const regionGrow = (candidates: Candidate[], seed: number, eps: number, limits: RegionGrowLimits = {}): Set<number> => {
    const cells = buildHash(candidates, eps);
    const visited = new Uint8Array(candidates.length);
    const queue = [seed];
    const seedCandidate = candidates[seed];
    visited[seed] = 1;
    const inv = 1 / eps;
    const eps2 = eps * eps;
    const maxSeedDistance2 = Number.isFinite(limits.maxSeedDistance) ?
        limits.maxSeedDistance! * limits.maxSeedDistance! :
        Infinity;

    while (queue.length > 0) {
        const i = queue.pop()!;
        const p = candidates[i];
        const ix = Math.floor(p.wx * inv) | 0;
        const iy = Math.floor(p.wy * inv) | 0;
        const iz = Math.floor(p.wz * inv) | 0;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dz = -1; dz <= 1; dz++) {
                    const key = ((ix + dx) * 73856093) ^ ((iy + dy) * 19349663) ^ ((iz + dz) * 83492791);
                    const bucket = cells.get(key);
                    if (!bucket) continue;
                    for (const j of bucket) {
                        if (visited[j]) continue;
                        const q = candidates[j];
                        const ddx = p.wx - q.wx;
                        const ddy = p.wy - q.wy;
                        const ddz = p.wz - q.wz;
                        if (ddx * ddx + ddy * ddy + ddz * ddz > eps2) continue;
                        const sdx = q.wx - seedCandidate.wx;
                        const sdy = q.wy - seedCandidate.wy;
                        const sdz = q.wz - seedCandidate.wz;
                        if (sdx * sdx + sdy * sdy + sdz * sdz > maxSeedDistance2) continue;
                        if (Number.isFinite(limits.maxDepthDelta) && Math.abs(q.cz - seedCandidate.cz) > limits.maxDepthDelta!) continue;
                        visited[j] = 1;
                        queue.push(j);
                    }
                }
            }
        }
    }

    const out = new Set<number>();
    for (let i = 0; i < candidates.length; i++) {
        if (visited[i]) out.add(i);
    }
    return out;
};

const buildClickAnchor = (
    surfaceCandidates: Candidate[],
    clickX: number,
    clickY: number
): ArtisanSelectionResult['clickAnchor'] | undefined => {
    if (surfaceCandidates.length === 0) {
        return undefined;
    }

    const seedIndex = findSeedOnRay(surfaceCandidates, clickX, clickY, CLICK_ANCHOR_RAY_RADIUS_PX);
    const seedCandidate = surfaceCandidates[seedIndex];
    const nearestDistancePx = nearestScreenDistance(seedCandidate, clickX, clickY);
    if (!seedCandidate || nearestDistancePx > CLICK_ANCHOR_MAX_NEAREST_PX) {
        return undefined;
    }

    const eps = Math.min(
        CLICK_ANCHOR_EPS_MAX_M,
        Math.max(CLICK_ANCHOR_EPS_MIN_M, seedCandidate.cz * CLICK_ANCHOR_EPS_FRAC_OF_DEPTH)
    );
    const maxSeedDistance = Math.min(
        CLICK_ANCHOR_RADIUS_MAX_M,
        Math.max(CLICK_ANCHOR_RADIUS_MIN_M, seedCandidate.cz * CLICK_ANCHOR_RADIUS_FRAC_OF_DEPTH)
    );
    const maxDepthDelta = Math.min(
        CLICK_ANCHOR_DEPTH_MAX_M,
        Math.max(CLICK_ANCHOR_DEPTH_MIN_M, seedCandidate.cz * CLICK_ANCHOR_DEPTH_FRAC_OF_DEPTH)
    );
    const kept = regionGrow(surfaceCandidates, seedIndex, eps, { maxSeedDistance, maxDepthDelta });
    const pickedIdx = new Set<number>();
    for (const k of kept) {
        pickedIdx.add(surfaceCandidates[k].idx);
    }
    if (pickedIdx.size === 0) {
        return undefined;
    }

    return {
        selectedCount: pickedIdx.size,
        selectedRanges: encodeIndexRanges(pickedIdx),
        bounds: getSelectionWorldBounds(surfaceCandidates, pickedIdx),
        seedIndex,
        seedSplatIndex: seedCandidate.idx,
        screen: [seedCandidate.u, seedCandidate.v],
        depth: seedCandidate.cz,
        nearestDistancePx,
        eps,
        maxSeedDistance,
        maxDepthDelta
    };
};

const getMaskCentroid = (mask: Uint8Array, maskW: number, maskH: number, imgW: number, imgH: number): [number, number] | undefined => {
    let mx = 0, my = 0, count = 0;
    // Inverse of the uniform (aspect-preserving) mask scale: mask px -> image px uses ONE factor
    // on both axes (SAM letterbox, content top-left). A no-op for frame-matched masks.
    const invMaskScale = Math.max(imgW / Math.max(1, maskW), imgH / Math.max(1, maskH));
    for (let y = 0; y < maskH; y++) {
        for (let x = 0; x < maskW; x++) {
            if (mask[y * maskW + x] > 0) {
                mx += x * invMaskScale;
                my += y * invMaskScale;
                count++;
            }
        }
    }
    return count > 0 ? [mx / count, my / count] : undefined;
};

function getSelectionWorldBounds(candidates: Candidate[], pickedIdx: Set<number>): ArtisanSelectionBounds | undefined {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let count = 0;

    for (const candidate of candidates) {
        if (!pickedIdx.has(candidate.idx)) {
            continue;
        }

        minX = Math.min(minX, candidate.wx);
        minY = Math.min(minY, candidate.wy);
        minZ = Math.min(minZ, candidate.wz);
        maxX = Math.max(maxX, candidate.wx);
        maxY = Math.max(maxY, candidate.wy);
        maxZ = Math.max(maxZ, candidate.wz);
        count++;
    }

    if (count === 0) {
        return undefined;
    }

    const center = {
        x: (minX + maxX) * 0.5,
        y: (minY + maxY) * 0.5,
        z: (minZ + maxZ) * 0.5
    };
    let radius = 0;
    for (const candidate of candidates) {
        if (!pickedIdx.has(candidate.idx)) {
            continue;
        }

        const dx = candidate.wx - center.x;
        const dy = candidate.wy - center.y;
        const dz = candidate.wz - center.z;
        radius = Math.max(radius, Math.sqrt(dx * dx + dy * dy + dz * dz));
    }

    return {
        center,
        min: { x: minX, y: minY, z: minZ },
        max: { x: maxX, y: maxY, z: maxZ },
        radius: Math.max(radius, EPS_MIN_M),
        count
    };
}

function encodeIndexRanges(indices: Set<number>): [number, number][] {
    const sorted = Array.from(indices).sort((a, b) => a - b);
    const ranges: [number, number][] = [];
    let start: number | undefined;
    let prev: number | undefined;

    for (const idx of sorted) {
        if (start === undefined) {
            start = idx;
            prev = idx;
        } else if (prev !== undefined && idx === prev + 1) {
            prev = idx;
        } else {
            ranges.push([start, prev!]);
            start = idx;
            prev = idx;
        }
    }

    if (start !== undefined && prev !== undefined) {
        ranges.push([start, prev]);
    }

    return ranges;
}

const revealSelection = (splat: Splat, pickedIdx: Set<number>) => {
    const centers = (splat.entity as any).gsplat.instance.sorter.centers as Float32Array;
    let cx = 0, cy = 0, cz = 0;
    for (const idx of pickedIdx) {
        cx += centers[idx * 3];
        cy += centers[idx * 3 + 1];
        cz += centers[idx * 3 + 2];
    }

    const n = pickedIdx.size;
    cx /= n;
    cy /= n;
    cz /= n;

    let maxDist = 0;
    for (const idx of pickedIdx) {
        const dx = centers[idx * 3] - cx;
        const dy = centers[idx * 3 + 1] - cy;
        const dz = centers[idx * 3 + 2] - cz;
        maxDist = Math.max(maxDist, Math.sqrt(dx * dx + dy * dy + dz * dz));
    }
    splat.startReveal(new Vec3(cx, cy, cz), maxDist || 1, pickedIdx);
};

const projectArtisanMaskSelection = (
    scene: Scene,
    splat: Splat,
    input: ArtisanMaskInput
): ArtisanSelectionProjection | null => {
    const t0 = performance.now();
    const intr = extractIntrinsics(scene.camera.camera, input.imageWidth, input.imageHeight);
    const connectedProjection = input.projectionMode === 'connected-surface' || input.projectionMode === 'connected-volume';
    const component = connectedProjection && input.seed ?
        extractMaskComponentAroundSeed(
            input.mask,
            input.maskWidth,
            input.maskHeight,
            input.imageWidth,
            input.imageHeight,
            input.seed
        ) :
        null;
    const projectionMask = component?.mask ?? input.mask;
    const projectedCandidates = collectMaskCandidates(
        splat,
        scene,
        projectionMask,
        input.maskWidth,
        input.maskHeight,
        input.imageWidth,
        input.imageHeight,
        intr
    );

    const visibleCandidates = input.projectionMode === 'frustum' ?
        [] :
        collectVisibleCandidates(splat, scene, input.imageWidth, input.imageHeight, intr);
    const surfaceCandidates = input.projectionMode === 'frustum' ?
        projectedCandidates :
        filterFrontSurfaceCandidates(projectedCandidates, input.imageWidth, input.imageHeight, visibleCandidates);
    const visibleSurfaceCandidates = input.seed && connectedProjection ?
        filterFrontSurfaceCandidates(visibleCandidates, input.imageWidth, input.imageHeight, visibleCandidates) :
        [];
    const clickAnchor = input.seed && connectedProjection ?
        buildClickAnchor(visibleSurfaceCandidates, input.seed[0], input.seed[1]) :
        undefined;
    const pickedIdx = new Set<number>();
    let seed = input.seed;
    let logDetails = '';

    if (connectedProjection) {
        seed = seed ?? getMaskCentroid(projectionMask, input.maskWidth, input.maskHeight, input.imageWidth, input.imageHeight);
        if (!seed || surfaceCandidates.length === 0) {
            return null;
        }

        const seedIndex = findSeedOnFrontMaskLayer(surfaceCandidates, seed[0], seed[1], 20);
        if (seedIndex < 0) {
            return null;
        }

        const seedCandidate = surfaceCandidates[seedIndex];
        const clickDepth = seedCandidate.cz;
        const eps = Math.min(EPS_MAX_M, Math.max(EPS_MIN_M, clickDepth * EPS_FRAC_OF_DEPTH));
        const seedGrowLimits = estimateSeedGrowLimits(
            component?.bbox ?? getMaskBoundingBox(projectionMask, input.maskWidth, input.maskHeight),
            input.maskWidth,
            input.maskHeight,
            input.imageWidth,
            input.imageHeight,
            clickDepth,
            intr
        );
        const growCandidates = input.projectionMode === 'connected-volume' ? projectedCandidates : surfaceCandidates;
        const growSeedIndex = growCandidates.findIndex(candidate => candidate.idx === seedCandidate.idx);
        if (growSeedIndex < 0) {
            return null;
        }
        const kept = regionGrow(growCandidates, growSeedIndex, eps, seedGrowLimits);
        if (input.projectionMode === 'connected-volume') {
            for (const candidate of surfaceCandidates) pickedIdx.add(candidate.idx);
        }
        for (const k of kept) pickedIdx.add(growCandidates[k].idx);
        const componentDetails = component ?
            ` component=${component.componentArea}/${component.originalArea}${component.isolated ? '' : ' shared'} near=${(component.nearestDistancePx ?? 0).toFixed(1)}px` :
            '';
        const volumeDetails = input.projectionMode === 'connected-volume' ? ` volume=${growCandidates.length}` : '';
        logDetails = `${componentDetails}${volumeDetails} depth=${clickDepth.toFixed(2)} eps=${eps.toFixed(3)} cap=${seedGrowLimits.maxSeedDistance.toFixed(2)} dz=${seedGrowLimits.maxDepthDelta.toFixed(2)} seed=${growSeedIndex} kept=${kept.size}`;
    } else {
        for (const candidate of surfaceCandidates) pickedIdx.add(candidate.idx);
        logDetails = input.projectionMode === 'frustum' ? ' frustum=true' : ' surface=true';
    }

    if (pickedIdx.size === 0) {
        return null;
    }

    const seedMaskIdx = new Set<number>();
    for (const candidate of projectedCandidates) {
        seedMaskIdx.add(candidate.idx);
    }
    const elapsedMs = performance.now() - t0;
    return {
        source: input.source,
        op: input.op,
        projectionMode: input.projectionMode,
        selectedCount: pickedIdx.size,
        projectedCandidateCount: projectedCandidates.length,
        surfaceCandidateCount: surfaceCandidates.length,
        maskAreaRatio: getMaskAreaRatio(projectionMask),
        seed,
        bounds: getSelectionWorldBounds(projectedCandidates, pickedIdx),
        selectedRanges: encodeIndexRanges(pickedIdx),
        seedMask: seedMaskIdx.size > pickedIdx.size ? {
            selectedCount: seedMaskIdx.size,
            selectedRanges: encodeIndexRanges(seedMaskIdx),
            bounds: getSelectionWorldBounds(projectedCandidates, seedMaskIdx),
            projectedCandidateCount: projectedCandidates.length,
            surfaceCandidateCount: surfaceCandidates.length
        } : undefined,
        clickAnchor,
        elapsedMs,
        indices: pickedIdx,
        logDetails: `${logDetails}${clickAnchor ? ` clickAnchor=${clickAnchor.selectedCount} near=${clickAnchor.nearestDistancePx.toFixed(1)}px depth=${clickAnchor.depth.toFixed(2)}` : ' clickAnchor=none'}`
    };
};

const projectArtisanVisibleSurface = (
    scene: Scene,
    splat: Splat,
    imageWidth: number,
    imageHeight: number
): ArtisanVisibleSurfaceProjection | null => {
    const intr = extractIntrinsics(scene.camera.camera, imageWidth, imageHeight);
    const projectedCandidates = collectVisibleCandidates(splat, scene, imageWidth, imageHeight, intr);
    const surfaceCandidates = filterFrontSurfaceCandidates(projectedCandidates, imageWidth, imageHeight);
    if (surfaceCandidates.length === 0) {
        return null;
    }

    const indices = new Set<number>();
    for (const candidate of surfaceCandidates) {
        indices.add(candidate.idx);
    }

    return {
        indices,
        projectedCandidateCount: projectedCandidates.length,
        surfaceCandidateCount: surfaceCandidates.length
    };
};

const projectArtisanClickAnchor = (
    scene: Scene,
    splat: Splat,
    imageWidth: number,
    imageHeight: number,
    click: [number, number]
): ArtisanSelectionResult['clickAnchor'] | undefined => {
    const intr = extractIntrinsics(scene.camera.camera, imageWidth, imageHeight);
    const projectedCandidates = collectVisibleCandidates(splat, scene, imageWidth, imageHeight, intr);
    const surfaceCandidates = filterFrontSurfaceCandidates(projectedCandidates, imageWidth, imageHeight);
    return buildClickAnchor(surfaceCandidates, click[0], click[1]);
};

const applyArtisanSelectionIndices = (
    events: Events,
    splat: Splat,
    op: ArtisanSelectionMode,
    indices: Set<number>,
    options: ArtisanSelectionApplyOptions = {}
): Promise<ArtisanSelectionApplyTimings> => {
    const startedAt = performance.now();
    const buildStartedAt = performance.now();
    const selectOp = new SelectOp(splat, op, i => indices.has(i));
    const selectOpBuildMs = Math.max(0, Math.round(performance.now() - buildStartedAt));

    return (async () => {
        const doStartedAt = performance.now();
        const updateOptions: SplatUpdateStateOptions = {
            updateBounds: options.updateBounds
        };
        await selectOp.do(updateOptions);
        const selectOpDoMs = Math.max(0, Math.round(performance.now() - doStartedAt));

        const historyStartedAt = performance.now();
        events.fire('edit.add', selectOp, true);
        const historyMs = Math.max(0, Math.round(performance.now() - historyStartedAt));

        let revealMs = 0;
        if ((options.reveal ?? op !== 'remove') && indices.size > 0) {
            const revealStartedAt = performance.now();
            revealSelection(splat, indices);
            revealMs = Math.max(0, Math.round(performance.now() - revealStartedAt));
        }

        return {
            total_ms: Math.max(0, Math.round(performance.now() - startedAt)),
            select_op_build_ms: selectOpBuildMs,
            select_op_do_ms: selectOpDoMs,
            history_ms: historyMs,
            reveal_ms: revealMs,
            update_bounds: options.updateBounds !== false
        };
    })();
};

const applyArtisanMaskSelection = (
    events: Events,
    scene: Scene,
    splat: Splat,
    input: ArtisanMaskInput
): Promise<ArtisanSelectionResult | null> => {
    const projection = projectArtisanMaskSelection(scene, splat, input);
    if (!projection) {
        events.fire('toast', 'Nothing detected', 'warning');
        return Promise.resolve(null);
    }

    console.log(`[ArtisanGS] ${input.source} op=${input.op} projection=${input.projectionMode} candidates=${projection.surfaceCandidateCount}/${projection.projectedCandidateCount}${projection.logDetails} (${projection.elapsedMs.toFixed(0)}ms)`);

    return (async () => {
        await applyArtisanSelectionIndices(events, splat, input.op, projection.indices);

        const { indices: _indices, logDetails: _logDetails, ...result } = projection;
        events.fire('artisan.selectionApplied', result);
        return result;
    })();
};

export {
    applyArtisanSelectionIndices,
    applyArtisanMaskSelection,
    buildArtisanViewKey,
    canvasAlphaToMask,
    captureOffscreenRgbaTimed,
    captureScene,
    captureSceneImages,
    extractMaskComponentAroundSeed,
    encodeIndexRanges,
    getArtisanOpFromPointer,
    maskArrayToPngBase64,
    maskPngToArray,
    normalizePromptPoint,
    projectArtisanClickAnchor,
    projectArtisanMaskSelection,
    projectArtisanVisibleSurface,
    rleMaskToArray
};
export type {
    ArtisanImageSize,
    ArtisanImageStats,
    ArtisanCaptureSceneTimings,
    ArtisanMaskProjectionMode,
    ArtisanPromptLabel,
    ArtisanPromptPoint,
    ArtisanRenderOffscreenTimings,
    ArtisanSelectionApplyTimings,
    ArtisanSelectionBounds,
    ArtisanSelectionMode,
    ArtisanSelectionResult
};
