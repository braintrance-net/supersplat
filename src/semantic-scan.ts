import { Vec3 } from 'playcanvas';

import { Events } from './events';
import { Scene } from './scene';
import { SemanticAnnotation } from './semantic-annotations';

const MAX_CAPTURE_SIDE = 1024;
const FALLBACK_MARKER_COLOR = '#58c7ff';

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

type CameraDebugState = {
    position: { x: number, y: number, z: number };
    target: { x: number, y: number, z: number };
    fov: number;
    ortho?: boolean;
};

type CapturedFrame = {
    image: string;
    mimeType: 'image/png';
    width: number;
    height: number;
    pixels: Uint8ClampedArray;
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

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

const getSemanticScanFetchCredentials = (backendUrl: string): 'same-origin' | 'include' => {
    try {
        return new URL(backendUrl, window.location.href).origin === window.location.origin ? 'same-origin' : 'include';
    } catch {
        return 'same-origin';
    }
};

const createId = () => {
    if (window.crypto?.randomUUID) {
        return window.crypto.randomUUID();
    }

    return `semantic-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const getCaptureSize = (scene: Scene) => {
    const sourceWidth = scene.canvas.clientWidth || scene.targetSize.width || 1024;
    const sourceHeight = scene.canvas.clientHeight || scene.targetSize.height || 768;
    const scale = Math.min(1, MAX_CAPTURE_SIDE / Math.max(sourceWidth, sourceHeight));

    return {
        width: Math.max(1, Math.round(sourceWidth * scale)),
        height: Math.max(1, Math.round(sourceHeight * scale))
    };
};

const getContext = (canvas: HTMLCanvasElement) => {
    const context = canvas.getContext('2d');
    if (!context) {
        throw new Error('Could not create image canvas');
    }
    return context;
};

const captureScene = async (events: Events, scene: Scene): Promise<CapturedFrame> => {
    const { width, height } = getCaptureSize(scene);
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

    return {
        image: output.toDataURL('image/png').split(',')[1],
        mimeType: 'image/png',
        width,
        height,
        pixels: outputContext.getImageData(0, 0, width, height).data
    };
};

const normalizeLabel = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 48);

const normalizeDescription = (value: string) => value.trim().replace(/\s+/g, ' ').slice(0, 120);

const isDetection = (value: any): value is SemanticScanDetection => {
    return (
        value &&
        typeof value === 'object' &&
        Array.isArray(value.point) &&
        value.point.length === 2 &&
        typeof value.point[0] === 'number' &&
        typeof value.point[1] === 'number' &&
        typeof value.label === 'string' &&
        typeof value.description === 'string'
    );
};

const parseResponse = (value: any): SemanticScanResponse => {
    const detections = value?.data?.detections;

    if (value?.ok === true && Array.isArray(detections)) {
        return {
            ok: true,
            data: {
                provider: typeof value.data.provider === 'string' ? value.data.provider : 'gemini',
                model: typeof value.data.model === 'string' ? value.data.model : 'unknown',
                detections: detections.filter(isDetection)
            }
        };
    }

    return {
        ok: false,
        error: typeof value?.error === 'string' ? value.error : 'Semantic scan failed'
    };
};

const rgbToHsl = (red: number, green: number, blue: number) => {
    const r = red / 255;
    const g = green / 255;
    const b = blue / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const lightness = (max + min) / 2;

    if (max === min) {
        return { hue: 198, saturation: 0.8, lightness };
    }

    const delta = max - min;
    const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    let hue: number;

    switch (max) {
        case r:
            hue = (g - b) / delta + (g < b ? 6 : 0);
            break;
        case g:
            hue = (b - r) / delta + 2;
            break;
        default:
            hue = (r - g) / delta + 4;
            break;
    }

    return {
        hue: hue * 60,
        saturation,
        lightness
    };
};

const sampleColor = (frame: CapturedFrame, screenX: number, screenY: number) => {
    const centerX = Math.round(clamp01(screenX) * (frame.width - 1));
    const centerY = Math.round(clamp01(screenY) * (frame.height - 1));
    const radius = 8;
    let red = 0;
    let green = 0;
    let blue = 0;
    let count = 0;

    for (let y = Math.max(0, centerY - radius); y <= Math.min(frame.height - 1, centerY + radius); y++) {
        for (let x = Math.max(0, centerX - radius); x <= Math.min(frame.width - 1, centerX + radius); x++) {
            const i = (y * frame.width + x) * 4;
            red += frame.pixels[i];
            green += frame.pixels[i + 1];
            blue += frame.pixels[i + 2];
            count++;
        }
    }

    if (count === 0) {
        return FALLBACK_MARKER_COLOR;
    }

    const hsl = rgbToHsl(red / count, green / count, blue / count);
    const saturation = Math.min(92, Math.max(58, hsl.saturation * 135));
    const lightness = Math.min(76, Math.max(48, hsl.lightness * 110));
    return `hsl(${Math.round(hsl.hue)}, ${Math.round(saturation)}%, ${Math.round(lightness)}%)`;
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

const toTuple = (value: { x: number, y: number, z: number }): [number, number, number] => [value.x, value.y, value.z];

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

const registerSemanticScanEvents = (events: Events, scene: Scene) => {
    let running = false;

    const setRunning = (value: boolean) => {
        if (running !== value) {
            running = value;
            events.fire('semanticScan.running', running);
        }
    };

    const run = async () => {
        const preprocessing = events.invoke('semanticPreprocess.running') === true;
        if (running || preprocessing) {
            const message = running ? 'Semantic scan already running' : 'Semantic preprocessing is already running';
            events.fire('toast', message, 'info');
            return { ok: false, error: message, annotations: [] as SemanticAnnotation[] };
        }

        setRunning(true);
        events.fire('startSpinner');
        let restoreCamera: CameraDebugState | null = null;

        try {
            const camera = events.invoke('camera.debugState') as CameraDebugState;
            const frame = await captureScene(events, scene);
            const semanticScanBackendUrl = getSemanticScanBackendUrl();
            const response = await fetch(`${semanticScanBackendUrl}/api/semantic-scan`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: getSemanticScanFetchCredentials(semanticScanBackendUrl),
                body: JSON.stringify({
                    image: frame.image,
                    mimeType: frame.mimeType,
                    width: frame.width,
                    height: frame.height,
                    count: 5
                })
            });
            const parsed = parseResponse(await response.json().catch((): null => null));

            if (!response.ok || !parsed.ok || !parsed.data) {
                throw new Error(parsed.error || 'Semantic scan failed');
            }

            restoreCamera = events.invoke('camera.debugState') as CameraDebugState;
            applyCameraState(scene, camera);
            let added = 0;
            const annotations: SemanticAnnotation[] = [];

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
                            position: toTuple(camera.position),
                            target: toTuple(camera.target),
                            fov: camera.fov,
                            ortho: camera.ortho
                        },
                        capturedAt: new Date().toISOString(),
                        confidence: detection.confidence
                    }
                };

                events.fire('semanticAnnotations.add', annotation);
                annotations.push(annotation);
                added++;
            }

            events.fire('toast', added > 0 ? `Added ${added} semantic labels` : 'No surface hits for scan labels', added > 0 ? 'success' : 'warning');
            return { ok: true, added, annotations };
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Semantic scan failed';
            events.fire('toast', message, 'error');
            return { ok: false, error: message, annotations: [] };
        } finally {
            if (restoreCamera) {
                applyCameraState(scene, restoreCamera);
            }
            events.fire('stopSpinner');
            setRunning(false);
        }
    };

    events.function('semanticScan.running', () => running);
    events.function('semanticScan.run', run);
    events.on('semanticScan.run', () => {
        run();
    });
};

export { registerSemanticScanEvents };
