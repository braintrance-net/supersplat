import { Vec3 } from 'playcanvas';

import { Events } from './events';
import { Scene } from './scene';
import { SemanticAnnotation } from './semantic-annotations';
import { applyPlannedView, buildSemanticViewPlan, PlannerFrameMetadata } from './semantic-viewpoint-planner';

const FALLBACK_MARKER_COLOR = '#58c7ff';
const DEFAULT_CAPTURE_SIDE = 720;

type ScreenshotMode = 'normal' | 'debug';

type CameraDebugState = {
    position: { x: number, y: number, z: number };
    target: { x: number, y: number, z: number };
    fov: number;
    azim: number;
    elevation: number;
    distance: number;
    ortho?: boolean;
};

type SemanticScanDetection = {
    point: [number, number];
    label: string;
    description: string;
    confidence?: number;
};

type SemanticScanResponse = {
    ok: boolean;
    error?: string;
    data?: {
        provider: string;
        model: string;
        detections: SemanticScanDetection[];
    };
};

type CapturedReviewFrame = {
    viewId: string;
    label: string;
    image: string;
    mimeType: 'image/png';
    width: number;
    height: number;
    pixels: Uint8ClampedArray;
    camera: CameraDebugState;
    planner?: PlannerFrameMetadata;
    quality: {
        score: number;
        accepted: boolean;
        reasons: string[];
        contentRatio: number;
        luminanceMean: number;
        luminanceVariance: number;
        sharpness: number;
    };
};

type PublicReviewFrame = Omit<CapturedReviewFrame, 'pixels'>;

type CaptureTiming = {
    totalMs: number;
    planningMs: number;
    screenshotMs: number;
    plannedFrameCount: number;
    capturedFrameCount: number;
    skippedFrameCount: number;
    screenshotMode: ScreenshotMode;
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const createId = () => {
    if (window.crypto?.randomUUID) {
        return window.crypto.randomUUID();
    }

    return `semantic-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const normalizeLabel = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 48);

const normalizeDescription = (value: string) => value.trim().replace(/\s+/g, ' ').slice(0, 120);

const toTuple = (value: { x: number, y: number, z: number }): [number, number, number] => [value.x, value.y, value.z];

const getSemanticScanBackendUrl = () => {
    const configured = window.supersplatConfig?.semanticScanBackendUrl;
    if (configured) {
        return configured.replace(/\/$/, '');
    }

    if (document.referrer) {
        try {
            return new URL(document.referrer).origin;
        } catch {
            // Fall through to current origin.
        }
    }

    return window.location.origin;
};

const getCaptureSize = (scene: Scene, maxSide: number) => {
    const sourceWidth = scene.canvas.clientWidth || scene.targetSize.width || 1024;
    const sourceHeight = scene.canvas.clientHeight || scene.targetSize.height || 768;
    const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));

    return {
        width: Math.max(1, Math.round(sourceWidth * scale)),
        height: Math.max(1, Math.round(sourceHeight * scale))
    };
};

const getContext = (canvas: HTMLCanvasElement) => {
    const context = canvas.getContext('2d');
    if (!context) {
        throw new Error('Could not create preprocessing canvas');
    }
    return context;
};

const scorePixels = (pixels: Uint8ClampedArray, width: number, height: number) => {
    let content = 0;
    let luminance = 0;
    let luminanceSq = 0;
    let samples = 0;
    let sharpness = 0;
    let sharpnessSamples = 0;

    const stride = Math.max(1, Math.floor(Math.max(width, height) / 220));

    for (let y = 0; y < height; y += stride) {
        for (let x = 0; x < width; x += stride) {
            const i = (y * width + x) * 4;
            const red = pixels[i];
            const green = pixels[i + 1];
            const blue = pixels[i + 2];
            const luma = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
            const bgDistance = Math.abs(red - 16) + Math.abs(green - 16) + Math.abs(blue - 20);

            if (bgDistance > 34 && luma > 0.035) {
                content++;
            }

            luminance += luma;
            luminanceSq += luma * luma;
            samples++;

            if (x + stride < width && y + stride < height) {
                const right = (y * width + x + stride) * 4;
                const down = ((y + stride) * width + x) * 4;
                const rightLuma = (0.2126 * pixels[right] + 0.7152 * pixels[right + 1] + 0.0722 * pixels[right + 2]) / 255;
                const downLuma = (0.2126 * pixels[down] + 0.7152 * pixels[down + 1] + 0.0722 * pixels[down + 2]) / 255;
                sharpness += Math.abs(luma - rightLuma) + Math.abs(luma - downLuma);
                sharpnessSamples++;
            }
        }
    }

    const luminanceMean = samples > 0 ? luminance / samples : 0;
    const luminanceVariance = samples > 0 ? Math.max(0, luminanceSq / samples - luminanceMean * luminanceMean) : 0;
    const contentRatio = samples > 0 ? content / samples : 0;
    const normalizedSharpness = sharpnessSamples > 0 ? sharpness / sharpnessSamples : 0;
    const reasons: string[] = [];

    if (contentRatio < 0.12) {
        reasons.push('low scene coverage');
    }
    if (luminanceMean < 0.06) {
        reasons.push('too dark');
    }
    if (luminanceVariance < 0.004) {
        reasons.push('low contrast');
    }
    if (normalizedSharpness < 0.015) {
        reasons.push('soft or blurry');
    }

    const score = Math.round(
        clamp01(
            contentRatio * 1.35 +
            Math.min(0.35, luminanceVariance * 8) +
            Math.min(0.28, normalizedSharpness * 5) -
            Math.max(0, 0.08 - luminanceMean)
        ) * 100
    ) / 100;

    return {
        score,
        accepted: reasons.length === 0 && score >= 0.32,
        reasons,
        contentRatio: Math.round(contentRatio * 1000) / 1000,
        luminanceMean: Math.round(luminanceMean * 1000) / 1000,
        luminanceVariance: Math.round(luminanceVariance * 10000) / 10000,
        sharpness: Math.round(normalizedSharpness * 1000) / 1000
    };
};

const mergeQuality = (imageQuality: CapturedReviewFrame['quality'], planner?: PlannerFrameMetadata): CapturedReviewFrame['quality'] => {
    if (!planner) {
        return imageQuality;
    }

    const reasons = Array.from(new Set([...planner.reasons, ...imageQuality.reasons]));
    const imageAccepted = !imageQuality.reasons.includes('too dark') &&
        !imageQuality.reasons.includes('soft or blurry') &&
        imageQuality.contentRatio >= 0.08;
    const score = Math.round(clamp01(planner.scores.final * 0.72 + imageQuality.score * 0.28) * 100) / 100;

    planner.scores.image = imageQuality.score;

    return {
        ...imageQuality,
        score,
        accepted: planner.decision === 'accepted' && imageAccepted && score >= 0.38,
        reasons
    };
};

const screenshotSkipReasons = (planner?: PlannerFrameMetadata) => {
    if (!planner) {
        return [];
    }

    const isRoot = !planner.branch.parentViewId && planner.branch.yawDegrees === 0 && planner.branch.pitchDegrees === 0;
    if (isRoot) {
        return [];
    }

    const reasons: string[] = [];
    if (planner.decision !== 'accepted') reasons.push('local geometry rejected');
    if (planner.scores.nearClipRatio > 0.1) reasons.push('near wall or clipped surface');
    if (planner.scores.noHitRatio > 0.72) reasons.push('too much empty depth');
    if (planner.scores.depthCoverage < 0.42) reasons.push('weak surface coverage');
    if (planner.scores.centerCoverage < 0.34) reasons.push('weak center anchor');
    if (planner.scores.gridCoverage < 0.36) reasons.push('narrow screen spread');

    return reasons;
};

const annotateCaptureDecision = (
    planner: PlannerFrameMetadata | undefined,
    mode: ScreenshotMode,
    captured: boolean,
    skipReasons: string[]
) => {
    if (!planner) {
        return planner;
    }

    const normallySkipped = skipReasons.length > 0;
    return {
        ...planner,
        badges: normallySkipped && mode === 'debug' ? Array.from(new Set(['normally skipped', ...planner.badges])) : planner.badges,
        reasons: normallySkipped && mode === 'debug' ?
            Array.from(new Set([...planner.reasons, `normal skip: ${skipReasons.join(', ')}`])) :
            planner.reasons,
        capture: {
            mode,
            recommended: !normallySkipped,
            captured,
            reasons: skipReasons
        }
    };
};

const captureFrame = async (
    events: Events,
    scene: Scene,
    viewId: string,
    label: string,
    maxSide: number,
    planner?: PlannerFrameMetadata
): Promise<CapturedReviewFrame> => {
    const { width, height } = getCaptureSize(scene, maxSide);
    const rgba = await events.invoke('render.offscreen', width, height) as Uint8Array;

    const transparent = document.createElement('canvas');
    transparent.width = width;
    transparent.height = height;
    const transparentContext = getContext(transparent);
    const imageData = transparentContext.createImageData(width, height);
    imageData.data.set(rgba);
    transparentContext.putImageData(imageData, 0, 0);

    const output = document.createElement('canvas');
    output.width = width;
    output.height = height;
    const outputContext = getContext(output);
    outputContext.fillStyle = '#101014';
    outputContext.fillRect(0, 0, width, height);
    outputContext.drawImage(transparent, 0, 0);
    const pixels = outputContext.getImageData(0, 0, width, height).data;

    const imageQuality = scorePixels(pixels, width, height);

    return {
        viewId,
        label,
        image: output.toDataURL('image/png'),
        mimeType: 'image/png',
        width,
        height,
        pixels,
        camera: events.invoke('camera.debugState') as CameraDebugState,
        planner,
        quality: mergeQuality(imageQuality, planner)
    };
};

const publicFrame = (frame: CapturedReviewFrame): PublicReviewFrame => {
    const { pixels: _pixels, ...rest } = frame;
    return rest;
};

const parseResponse = (value: any): SemanticScanResponse => {
    const detections = value?.data?.detections;

    if (value?.ok === true && Array.isArray(detections)) {
        return {
            ok: true,
            data: {
                provider: typeof value.data.provider === 'string' ? value.data.provider : 'gemini',
                model: typeof value.data.model === 'string' ? value.data.model : 'unknown',
                detections: detections.filter((item: any): item is SemanticScanDetection => (
                    item &&
                    typeof item === 'object' &&
                    Array.isArray(item.point) &&
                    item.point.length === 2 &&
                    typeof item.point[0] === 'number' &&
                    typeof item.point[1] === 'number' &&
                    typeof item.label === 'string' &&
                    typeof item.description === 'string'
                ))
            }
        };
    }

    return {
        ok: false,
        error: typeof value?.error === 'string' ? value.error : 'Semantic scan failed'
    };
};

const sampleColor = (frame: CapturedReviewFrame, screenX: number, screenY: number) => {
    const x = Math.round(clamp01(screenX) * (frame.width - 1));
    const y = Math.round(clamp01(screenY) * (frame.height - 1));
    const i = (y * frame.width + x) * 4;
    const red = frame.pixels[i];
    const green = frame.pixels[i + 1];
    const blue = frame.pixels[i + 2];

    if (typeof red !== 'number' || typeof green !== 'number' || typeof blue !== 'number') {
        return FALLBACK_MARKER_COLOR;
    }

    return `rgb(${red}, ${green}, ${blue})`;
};

const pickWorldPoint = async (scene: Scene, screenX: number, screenY: number) => {
    const offsets = [
        [0, 0],
        [6, 0],
        [-6, 0],
        [0, 6],
        [0, -6],
        [8, 8],
        [-8, 8],
        [8, -8],
        [-8, -8]
    ];
    const width = Math.max(1, scene.canvas.clientWidth);
    const height = Math.max(1, scene.canvas.clientHeight);

    for (const [offsetX, offsetY] of offsets) {
        const hit = await scene.camera.intersect(
            clamp01(screenX + offsetX / width),
            clamp01(screenY + offsetY / height)
        );
        if (hit) {
            return hit.position as Vec3;
        }
    }

    return null;
};

const renderScene = async (scene: Scene) => {
    await new Promise<void>((resolve) => {
        const handle = scene.events.on('postrender', () => {
            handle.off();
            resolve();
        });
        scene.forceRender = true;
    });
};

const applyCameraState = (scene: Scene, camera: CameraDebugState) => {
    scene.camera.fov = camera.fov;
    scene.events.fire('camera.fov', scene.camera.fov);
    scene.camera.ortho = camera.ortho ?? false;
    scene.camera.setPose(
        new Vec3(camera.position.x, camera.position.y, camera.position.z),
        new Vec3(camera.target.x, camera.target.y, camera.target.z),
        0
    );
    scene.camera.onUpdate(0);
    scene.forceRender = true;
};

const applyCamera = async (scene: Scene, frame: { camera: CameraDebugState }) => {
    applyCameraState(scene, frame.camera);
    await renderScene(scene);
};

const registerSemanticPreprocessEvents = (events: Events, scene: Scene) => {
    let frames: CapturedReviewFrame[] = [];
    let busy = false;

    const setBusy = (value: boolean) => {
        if (busy !== value) {
            busy = value;
            events.fire('semanticPreprocess.running', busy);
        }
    };

    const isSemanticScanRunning = () => events.invoke('semanticScan.running') === true;

    const captureReviewFrames = async (options: {
        maxSide?: number,
        maxReviewFrames?: number,
        helperBudget?: number,
        screenshotMode?: ScreenshotMode
    } = {}) => {
        if (busy || isSemanticScanRunning()) {
            const message = busy ? 'Semantic preprocessing is already running.' : 'Semantic scan already running.';
            return { ok: false, error: message, frames: [] as PublicReviewFrame[] };
        }

        setBusy(true);
        frames = [];
        const startedAt = performance.now();
        const originalCamera = events.invoke('camera.debugState') as CameraDebugState;
        const activeTool = events.invoke('tool.active') as string | null;
        if (activeTool) {
            events.fire('tool.deactivate');
        }
        const maxSide = Math.max(320, Math.min(1024, options.maxSide ?? DEFAULT_CAPTURE_SIDE));
        const screenshotMode: ScreenshotMode = options.screenshotMode === 'debug' ? 'debug' : 'normal';

        try {
            const nextFrames: CapturedReviewFrame[] = [];
            const planningStartedAt = performance.now();
            const viewPlan = buildSemanticViewPlan(events, scene, {
                maxReviewFrames: options.maxReviewFrames,
                helperBudget: options.helperBudget
            });
            const planningMs = performance.now() - planningStartedAt;
            applyCameraState(scene, originalCamera);
            const screenshotStartedAt = performance.now();
            let normallySkippedCount = 0;
            for (const view of viewPlan) {
                const skipReasons = screenshotSkipReasons(view.planner);
                if (skipReasons.length > 0) {
                    normallySkippedCount++;
                }
                if (screenshotMode === 'normal' && skipReasons.length > 0) {
                    continue;
                }

                applyPlannedView(scene, view);
                scene.forceRender = true;
                nextFrames.push(await captureFrame(
                    events,
                    scene,
                    view.viewId,
                    view.label,
                    maxSide,
                    annotateCaptureDecision(view.planner, screenshotMode, true, skipReasons)
                ));
            }
            const screenshotMs = performance.now() - screenshotStartedAt;
            const totalMs = performance.now() - startedAt;
            frames = nextFrames;
            return {
                ok: true,
                frames: frames.map(publicFrame),
                timing: {
                    totalMs: Math.round(totalMs),
                    planningMs: Math.round(planningMs),
                    screenshotMs: Math.round(screenshotMs),
                    plannedFrameCount: viewPlan.length,
                    capturedFrameCount: frames.length,
                    skippedFrameCount: screenshotMode === 'normal' ? viewPlan.length - frames.length : normallySkippedCount,
                    screenshotMode
                } satisfies CaptureTiming
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Semantic preprocessing capture failed';
            frames = [];
            events.fire('toast', message, 'error');
            return { ok: false, error: message, frames: [] as PublicReviewFrame[] };
        } finally {
            applyCameraState(scene, originalCamera);
            if (activeTool) {
                events.fire(`tool.${activeTool}`);
            }
            setBusy(false);
        }
    };

    const scanReviewFrames = async (options: { acceptedViewIds?: string[], count?: number } = {}) => {
        if (busy || isSemanticScanRunning()) {
            const message = busy ? 'Semantic preprocessing is already running.' : 'Semantic scan already running.';
            return { ok: false, error: message, annotations: [] as SemanticAnnotation[] };
        }

        setBusy(true);
        const originalCamera = events.invoke('camera.debugState') as CameraDebugState;
        const annotations: SemanticAnnotation[] = [];
        let spinnerStarted = false;

        try {
            const accepted = new Set(options.acceptedViewIds ?? frames.filter(frame => frame.quality.accepted).map(frame => frame.viewId));
            const selectedFrames = frames.filter(frame => accepted.has(frame.viewId));

            if (selectedFrames.length === 0) {
                return { ok: false, error: 'No accepted preprocessing frames are available.', annotations };
            }

            events.fire('startSpinner');
            spinnerStarted = true;

            for (const frame of selectedFrames) {
                const response = await fetch(`${getSemanticScanBackendUrl()}/api/semantic-scan`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        image: frame.image.split(',')[1],
                        mimeType: frame.mimeType,
                        width: frame.width,
                        height: frame.height,
                        count: Math.max(1, Math.min(10, options.count ?? 5))
                    })
                });
                const parsed = parseResponse(await response.json().catch((): null => null));

                if (!response.ok || !parsed.ok || !parsed.data) {
                    throw new Error(parsed.error || 'Semantic preprocessing scan failed');
                }

                await applyCamera(scene, frame);

                for (const detection of parsed.data.detections) {
                    const screenY = clamp01(detection.point[0] / 1000);
                    const screenX = clamp01(detection.point[1] / 1000);
                    const position = await pickWorldPoint(scene, screenX, screenY);
                    if (!position) {
                        continue;
                    }

                    const annotation: SemanticAnnotation = {
                        id: createId(),
                        label: normalizeLabel(detection.label),
                        description: normalizeDescription(detection.description),
                        position: toTuple(position),
                        color: sampleColor(frame, screenX, screenY),
                        source: {
                            provider: parsed.data.provider,
                            model: parsed.data.model,
                            screenPoint: [screenX, screenY],
                            captureSize: [frame.width, frame.height],
                            camera: {
                                position: toTuple(frame.camera.position),
                                target: toTuple(frame.camera.target),
                                fov: frame.camera.fov,
                                ortho: frame.camera.ortho
                            },
                            capturedAt: new Date().toISOString(),
                            confidence: detection.confidence
                        }
                    };

                    annotations.push(annotation);
                }
            }

            for (const annotation of annotations) {
                events.fire('semanticAnnotations.add', annotation);
            }

            events.fire('toast', annotations.length > 0 ? `Added ${annotations.length} preprocessed labels` : 'No surface hits for accepted frames', annotations.length > 0 ? 'success' : 'warning');
            return { ok: true, annotations };
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Semantic preprocessing scan failed';
            events.fire('toast', message, 'error');
            return { ok: false, error: message, annotations: [] };
        } finally {
            applyCameraState(scene, originalCamera);
            scene.forceRender = true;
            if (spinnerStarted) {
                events.fire('stopSpinner');
            }
            setBusy(false);
        }
    };

    events.function('semanticPreprocess.running', () => busy);
    events.function('semanticPreprocess.captureReviewFrames', captureReviewFrames);
    events.function('semanticPreprocess.scanReviewFrames', scanReviewFrames);
};

export { registerSemanticPreprocessEvents };
export type { PublicReviewFrame };
