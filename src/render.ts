import { BufferTarget, EncodedPacket, EncodedVideoPacketSource, MkvOutputFormat, MovOutputFormat, Mp4OutputFormat, Output, StreamTarget, WebMOutputFormat } from 'mediabunny';
import { Color, Mat4, path, PROJECTION_ORTHOGRAPHIC, Vec3 } from 'playcanvas';

import { ElementType } from './element';
import { Events } from './events';
import { PngCompressor } from './png-compressor';
import { Scene } from './scene';
import { Splat } from './splat';
import { localize } from './ui/localization';

const nullClr = new Color(0, 0, 0, 0);

type ImageSettings = {
    width: number;
    height: number;
    transparentBg: boolean;
    showDebug: boolean;
};

type RenderCaptureSettings = {
    width: number;
    height: number;
    transparentBg: boolean;
    showDebug: boolean;
};

type RenderCaptureTimings = {
    total_ms: number;
    setup_ms: number;
    wait_postrender_ms: number;
    alloc_ms: number;
    copy_ms: number;
    read_ms: number;
    flip_ms: number;
    cleanup_ms: number;
};

type RenderCaptureRgbaResult = {
    data: Uint8Array;
    timings: RenderCaptureTimings;
};

type VisibleCanvasProbeStats = {
    mean_luma: number;
    non_black_ratio: number;
    alpha_ratio: number;
};

type RenderPngCaptureTimings = {
    total_ms: number;
    setup_ms: number;
    wait_postrender_ms: number;
    alloc_ms: number;
    copy_ms: number;
    read_ms: number;
    flip_ms?: number;
    encode_ms: number;
    cleanup_ms: number;
    method?: 'image-bitmap' | 'read-pixels' | 'draw-image' | 'direct-canvas' | 'offscreen-render-target' | 'capture-stream';
    encode_method?: 'to-blob' | 'to-data-url';
    mime_type?: string;
    quality?: number;
    fallback_reason?: string;
};

type RenderPngCaptureResult = {
    image: string;
    mimeType: string;
    width: number;
    height: number;
    stats: {
        mean_luma: number;
        non_black_ratio: number;
        alpha_ratio: number;
    };
    timings: RenderPngCaptureTimings;
};

type RenderVisibleCanvasCropPngInput = {
    x: number;
    y: number;
    width: number;
    height: number;
    fullWidth: number;
    fullHeight: number;
    skipRender?: boolean;
    mimeType?: string;
    quality?: number;
};

type RenderVisibleCanvasPngOptions = {
    mimeType?: string;
    quality?: number;
    method?: 'capture-stream' | 'image-bitmap';
};

type CropProjectionCameraState = {
    projection: number;
    horizontalFov: boolean;
    fov: number;
    orthoHeight: number;
    nearClip: number;
    farClip: number;
};

type VideoSettings = {
    startFrame: number;
    endFrame: number;
    frameRate: number;
    width: number;
    height: number;
    bitrate: number;
    transparentBg: boolean;
    showDebug: boolean;
    format: 'mp4' | 'webm' | 'mov' | 'mkv';
    codec: 'h264' | 'h265' | 'vp9' | 'av1';
};

const removeExtension = (filename: string) => {
    return filename.substring(0, filename.length - path.getExtension(filename).length);
};

const downloadFile = (arrayBuffer: ArrayBuffer, filename: string) => {
    const blob = new Blob([arrayBuffer], { type: 'application/octet-stream' });
    const url = window.URL.createObjectURL(blob);
    const el = document.createElement('a');
    el.download = filename;
    el.href = url;
    el.click();
    window.URL.revokeObjectURL(url);
};

type RenderImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp';

const normalizeCaptureMimeType = (mimeType?: string): RenderImageMimeType => {
    const normalized = mimeType?.trim().toLowerCase();
    if (normalized === 'image/jpeg' || normalized === 'image/jpg' || normalized === 'jpeg' || normalized === 'jpg') {
        return 'image/jpeg';
    }
    if (normalized === 'image/webp' || normalized === 'webp') {
        return 'image/webp';
    }
    return 'image/png';
};

const normalizeCaptureQuality = (quality?: number) => (
    Number.isFinite(quality) ? Math.max(0.05, Math.min(1, quality!)) : undefined
);

const urlToggle = (name: string, fallback: boolean) => {
    const value = new URLSearchParams(window.location.search).get(name);
    if (value === null) {
        return fallback;
    }

    const normalized = value.trim().toLowerCase();
    if (normalized === '' || normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
        return true;
    }
    if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off' || normalized === 'none') {
        return false;
    }
    return fallback;
};

const useDataUrlForCropCapture = () => urlToggle('artisanCropDataUrlEncode', false);
const useDataUrlForFullCapture = () => urlToggle('artisanCaptureDataUrlEncode', false);
const forceImmediateCaptureRender = () => urlToggle('artisanForceRenderCapture', false);
const useFastCaptureResize = () => urlToggle('artisanFastCaptureResize', true);

const configureCaptureResize = (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) => {
    if (!useFastCaptureResize()) {
        return;
    }

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'low';
};

const readBlobAsDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Canvas blob read failed'));
    reader.readAsDataURL(blob);
});

const canvasToBlob = (canvas: HTMLCanvasElement, mimeType: string, quality?: number) => new Promise<Blob | null>((resolve) => {
    try {
        canvas.toBlob(resolve, mimeType, quality);
    } catch {
        resolve(null);
    }
});

const splitDataUrl = (data: string, fallbackMimeType: string) => {
    const commaIndex = data.indexOf(',');
    const header = commaIndex >= 0 ? data.slice(0, commaIndex) : '';
    const actualMimeType = /^data:([^;]+);base64$/i.exec(header)?.[1]?.toLowerCase() ?? fallbackMimeType;
    return {
        image: commaIndex >= 0 ? data.slice(commaIndex + 1) : data,
        mimeType: actualMimeType
    };
};

const encodeCanvasDataUrl = (
    canvas: HTMLCanvasElement,
    requestedMimeType: RenderImageMimeType,
    requestedQuality?: number
) => {
    const data = requestedQuality === undefined || requestedMimeType === 'image/png' ?
        canvas.toDataURL(requestedMimeType) :
        canvas.toDataURL(requestedMimeType, requestedQuality);
    const parsed = splitDataUrl(data, requestedMimeType);
    return {
        ...parsed,
        encodeMethod: 'to-data-url' as const,
        quality: requestedMimeType === 'image/png' ? undefined : requestedQuality
    };
};

const encodeCanvasImage = async (
    canvas: HTMLCanvasElement,
    mimeType?: string,
    quality?: number,
    options: { preferDataUrl?: boolean } = {}
) => {
    const requestedMimeType = normalizeCaptureMimeType(mimeType);
    const requestedQuality = normalizeCaptureQuality(quality);
    if (options.preferDataUrl) {
        return encodeCanvasDataUrl(canvas, requestedMimeType, requestedQuality);
    }

    const blob = await canvasToBlob(canvas, requestedMimeType, requestedQuality);
    if (blob) {
        const parsed = splitDataUrl(await readBlobAsDataUrl(blob), blob.type || requestedMimeType);
        return {
            ...parsed,
            encodeMethod: 'to-blob' as const,
            quality: requestedMimeType === 'image/png' ? undefined : requestedQuality
        };
    }

    return encodeCanvasDataUrl(canvas, requestedMimeType, requestedQuality);
};

const registerRenderEvents = (scene: Scene, events: Events) => {
    let compressor: PngCompressor;
    let visiblePngOutputCanvas: HTMLCanvasElement | null = null;
    let visiblePngSampleCanvas: HTMLCanvasElement | null = null;
    let visiblePngReadCanvas: HTMLCanvasElement | null = null;
    let visibleCanvasStream: MediaStream | null = null;
    let visibleCanvasStreamTrack: MediaStreamTrack | null = null;
    let visibleCanvasStreamReader: ReadableStreamDefaultReader<any> | null = null;
    const elapsedMs = (startMs: number) => Math.max(0, Math.round(performance.now() - startMs));
    const postRenderTimeoutMs = 5000;
    const yieldAfterPostRender = () => new Promise<void>((resolve) => {
        window.setTimeout(resolve, 0);
    });

    const getScratchCanvas = (
        current: HTMLCanvasElement | null,
        width: number,
        height: number
    ) => {
        const canvas = current ?? document.createElement('canvas');
        if (canvas.width !== width) {
            canvas.width = width;
        }
        if (canvas.height !== height) {
            canvas.height = height;
        }
        return canvas;
    };

    const resetVisibleCanvasStream = () => {
        try {
            visibleCanvasStreamReader?.releaseLock();
        } catch {
            // The reader may already be closed after a failed stream capture.
        }
        visibleCanvasStreamReader = null;
        visibleCanvasStreamTrack?.stop();
        visibleCanvasStreamTrack = null;
        visibleCanvasStream?.getTracks().forEach(track => track.stop());
        visibleCanvasStream = null;
    };

    const readVisibleCanvasStreamFrame = async () => {
        const captureStream = (scene.canvas as HTMLCanvasElement & {
            captureStream?: (frameRate?: number) => MediaStream;
        }).captureStream;
        const Processor = (window as any).MediaStreamTrackProcessor;
        if (typeof captureStream !== 'function' || typeof Processor !== 'function') {
            throw new Error('Canvas capture stream frame extraction is unavailable.');
        }
        if (!visibleCanvasStreamTrack || visibleCanvasStreamTrack.readyState === 'ended' || !visibleCanvasStreamReader) {
            resetVisibleCanvasStream();
            visibleCanvasStream = captureStream.call(scene.canvas, 0);
            visibleCanvasStreamTrack = visibleCanvasStream.getVideoTracks()[0] ?? null;
            if (!visibleCanvasStreamTrack) {
                throw new Error('Canvas capture stream did not expose a video track.');
            }
            const processor = new Processor({ track: visibleCanvasStreamTrack });
            visibleCanvasStreamReader = processor.readable.getReader();
        }

        const requestFrame = (visibleCanvasStreamTrack as any).requestFrame;
        if (typeof requestFrame !== 'function') {
            throw new Error('Canvas capture stream track does not support requestFrame.');
        }

        const readPromise = visibleCanvasStreamReader.read();
        requestFrame.call(visibleCanvasStreamTrack);
        const timeout = new Promise<never>((_, reject) => {
            window.setTimeout(() => reject(new Error('Canvas capture stream frame timed out.')), 2000);
        });
        const result = await Promise.race([readPromise, timeout]);
        if (!result || result.done || !result.value) {
            throw new Error('Canvas capture stream returned no frame.');
        }

        return result.value;
    };

    const analyzeVisibleCanvasStats = (data: Uint8ClampedArray): VisibleCanvasProbeStats => {
        const count = Math.max(1, data.length / 4);
        let luma = 0;
        let nonBlack = 0;
        let alpha = 0;

        for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const a = data[i + 3];
            luma += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
            if (r > 4 || g > 4 || b > 4) {
                nonBlack++;
            }
            if (a > 4) {
                alpha++;
            }
        }

        return {
            mean_luma: luma / count,
            non_black_ratio: nonBlack / count,
            alpha_ratio: alpha / count
        };
    };

    const analyzeCaptureStats = (data: Uint8Array | Uint8ClampedArray) => {
        const count = Math.max(1, data.length / 4);
        let luma = 0;
        let nonBlack = 0;
        let alpha = 0;

        for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const a = data[i + 3];
            const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            luma += y;
            if (r > 4 || g > 4 || b > 4) {
                nonBlack++;
            }
            if (a > 4) {
                alpha++;
            }
        }

        return {
            mean_luma: luma / count,
            non_black_ratio: nonBlack / count,
            alpha_ratio: alpha / count
        };
    };

    const captureCropProjectionCameraState = (): CropProjectionCameraState => {
        const camera = scene.camera.camera;
        return {
            projection: camera.projection,
            horizontalFov: camera.horizontalFov,
            fov: camera.fov,
            orthoHeight: camera.orthoHeight,
            nearClip: camera.nearClip,
            farClip: camera.farClip
        };
    };

    const buildCropProjectionMatrix = (
        crop: RenderVisibleCanvasCropPngInput,
        cameraState: CropProjectionCameraState
    ) => {
        const fullWidth = Math.max(1, crop.fullWidth);
        const fullHeight = Math.max(1, crop.fullHeight);
        const fullAspect = fullWidth / fullHeight;
        const near = cameraState.nearClip;
        const far = cameraState.farClip;
        const x0 = Math.max(0, Math.min(fullWidth, crop.x));
        const y0 = Math.max(0, Math.min(fullHeight, crop.y));
        const x1 = Math.max(x0 + 1, Math.min(fullWidth, crop.x + crop.width));
        const y1 = Math.max(y0 + 1, Math.min(fullHeight, crop.y + crop.height));

        const matrix = new Mat4();
        if (cameraState.projection === PROJECTION_ORTHOGRAPHIC) {
            const halfHeight = cameraState.orthoHeight;
            const halfWidth = halfHeight * fullAspect;
            const leftFull = -halfWidth;
            const rightFull = halfWidth;
            const bottomFull = -halfHeight;
            const topFull = halfHeight;
            const left = leftFull + (x0 / fullWidth) * (rightFull - leftFull);
            const right = leftFull + (x1 / fullWidth) * (rightFull - leftFull);
            const top = topFull - (y0 / fullHeight) * (topFull - bottomFull);
            const bottom = topFull - (y1 / fullHeight) * (topFull - bottomFull);
            matrix.setOrtho(left, right, bottom, top, near, far);
            return matrix;
        }

        const fovRad = cameraState.fov * Math.PI / 180;
        const halfHorizontal = cameraState.horizontalFov ?
            near * Math.tan(fovRad * 0.5) :
            near * Math.tan(fovRad * 0.5) * fullAspect;
        const halfVertical = cameraState.horizontalFov ?
            halfHorizontal / fullAspect :
            near * Math.tan(fovRad * 0.5);
        const leftFull = -halfHorizontal;
        const rightFull = halfHorizontal;
        const bottomFull = -halfVertical;
        const topFull = halfVertical;
        const left = leftFull + (x0 / fullWidth) * (rightFull - leftFull);
        const right = leftFull + (x1 / fullWidth) * (rightFull - leftFull);
        const top = topFull - (y0 / fullHeight) * (topFull - bottomFull);
        const bottom = topFull - (y1 / fullHeight) * (topFull - bottomFull);
        matrix.setFrustum(left, right, bottom, top, near, far);
        return matrix;
    };

    // wait for postrender to fire
    const postRender = (options: { forceRenderNow?: boolean } = {}) => {
        return new Promise<boolean>((resolve, reject) => {
            const listener: { handle?: { off: () => void } } = {};
            const timeout = window.setTimeout(() => {
                listener.handle?.off();
                reject(new Error(`Timed out waiting for postrender after ${postRenderTimeoutMs}ms; document visibility=${document.visibilityState}`));
            }, postRenderTimeoutMs);

            const handle = scene.events.on('postrender', () => {
                window.clearTimeout(timeout);
                handle.off();
                try {
                    resolve(true);
                } catch (error) {
                    reject(error);
                }
            });
            listener.handle = handle;

            if (options.forceRenderNow) {
                window.setTimeout(() => {
                    try {
                        scene.app.renderNextFrame = true;
                        scene.app.render();
                    } catch (error) {
                        window.clearTimeout(timeout);
                        handle.off();
                        reject(error);
                    }
                }, 0);
            }
        });
    };

    const captureOffscreenRgbaWithTimings = async ({ width, height, transparentBg, showDebug }: RenderCaptureSettings): Promise<RenderCaptureRgbaResult> => {
        const startedAt = performance.now();
        const timings: Partial<RenderCaptureTimings> = {};
        let data: Uint8Array | undefined;
        let caughtError: unknown;

        try {
            const setupStartedAt = performance.now();
            scene.camera.startOffscreenMode(width, height);
            scene.camera.renderOverlays = showDebug;
            scene.gizmoLayer.enabled = false;
            if (!transparentBg) {
                scene.camera.clearPass.setClearColor(events.invoke('bgClr'));
            }
            timings.setup_ms = elapsedMs(setupStartedAt);

            const waitStartedAt = performance.now();
            scene.forceRender = true;
            await postRender({ forceRenderNow: true });
            timings.wait_postrender_ms = elapsedMs(waitStartedAt);

            const allocStartedAt = performance.now();
            data = new Uint8Array(width * height * 4);
            timings.alloc_ms = elapsedMs(allocStartedAt);

            const { mainTarget, workTarget } = scene.camera;
            const copyStartedAt = performance.now();
            scene.dataProcessor.copyRt(mainTarget, workTarget);
            timings.copy_ms = elapsedMs(copyStartedAt);

            const readStartedAt = performance.now();
            await workTarget.colorBuffer.read(0, 0, width, height, { renderTarget: workTarget, data });
            timings.read_ms = elapsedMs(readStartedAt);

            const flipStartedAt = performance.now();
            let line = new Uint8Array(width * 4);
            for (let y = 0; y < height / 2; y++) {
                line = data.slice(y * width * 4, (y + 1) * width * 4);
                data.copyWithin(y * width * 4, (height - y - 1) * width * 4, (height - y) * width * 4);
                data.set(line, (height - y - 1) * width * 4);
            }
            timings.flip_ms = elapsedMs(flipStartedAt);
        } catch (error) {
            caughtError = error;
        } finally {
            const cleanupStartedAt = performance.now();
            scene.camera.endOffscreenMode();
            scene.camera.renderOverlays = true;
            scene.gizmoLayer.enabled = true;
            scene.camera.clearPass.setClearColor(nullClr);
            scene.camera.camera.clearColor.set(0, 0, 0, 0);
            timings.cleanup_ms = elapsedMs(cleanupStartedAt);
            timings.total_ms = elapsedMs(startedAt);
        }

        if (caughtError) {
            throw caughtError;
        }

        return {
            data: data!,
            timings: {
                total_ms: timings.total_ms ?? elapsedMs(startedAt),
                setup_ms: timings.setup_ms ?? 0,
                wait_postrender_ms: timings.wait_postrender_ms ?? 0,
                alloc_ms: timings.alloc_ms ?? 0,
                copy_ms: timings.copy_ms ?? 0,
                read_ms: timings.read_ms ?? 0,
                flip_ms: timings.flip_ms ?? 0,
                cleanup_ms: timings.cleanup_ms ?? 0
            }
        };
    };

    const captureOffscreenRgba = async (settings: RenderCaptureSettings) => {
        return (await captureOffscreenRgbaWithTimings(settings)).data;
    };

    const captureOffscreenCropPngWithTimings = async (crop: RenderVisibleCanvasCropPngInput): Promise<RenderPngCaptureResult> => {
        const width = Math.max(1, Math.round(crop.width));
        const height = Math.max(1, Math.round(crop.height));
        const captureMimeType = normalizeCaptureMimeType(crop.mimeType);
        const captureQuality = normalizeCaptureQuality(crop.quality);
        const startedAt = performance.now();
        const timings: Partial<RenderPngCaptureTimings> = {};
        const previousRenderOverlays = scene.camera.renderOverlays;
        const previousGizmoEnabled = scene.gizmoLayer.enabled;
        const previousLocalPosition = scene.camera.mainCamera.getLocalPosition().clone();
        const previousLocalRotation = scene.camera.mainCamera.getLocalRotation().clone();
        const projectionState = captureCropProjectionCameraState();
        let image = '';
        let stats: RenderPngCaptureResult['stats'] | undefined;
        let caughtError: unknown;

        try {
            const setupStartedAt = performance.now();
            scene.camera.startOffscreenMode(width, height);
            scene.camera.mainCamera.setLocalPosition(previousLocalPosition);
            scene.camera.mainCamera.setLocalRotation(previousLocalRotation);
            scene.camera.mainCamera.syncHierarchy();
            scene.camera.renderOverlays = false;
            scene.gizmoLayer.enabled = false;
            const cameraComponent = scene.camera.camera as any;
            const camera = cameraComponent.camera ?? cameraComponent._camera ?? cameraComponent;
            cameraComponent.projection = projectionState.projection;
            cameraComponent.horizontalFov = projectionState.horizontalFov;
            cameraComponent.fov = projectionState.fov;
            cameraComponent.orthoHeight = projectionState.orthoHeight;
            cameraComponent.nearClip = projectionState.nearClip;
            cameraComponent.farClip = projectionState.farClip;
            const cropProjection = buildCropProjectionMatrix(crop, projectionState);
            camera._projMat.copy(cropProjection);
            camera._projMatSkybox.copy(cropProjection);
            camera._projMatDirty = false;
            camera._viewProjMatDirty = true;
            camera._updateViewProjMat?.();
            timings.setup_ms = elapsedMs(setupStartedAt);

            const waitStartedAt = performance.now();
            scene.forceRender = true;
            await postRender({ forceRenderNow: true });
            timings.wait_postrender_ms = elapsedMs(waitStartedAt);

            const allocStartedAt = performance.now();
            const data = new Uint8Array(width * height * 4);
            timings.alloc_ms = elapsedMs(allocStartedAt);

            const { mainTarget, workTarget } = scene.camera;
            const copyStartedAt = performance.now();
            scene.dataProcessor.copyRt(mainTarget, workTarget);
            timings.copy_ms = elapsedMs(copyStartedAt);

            const readStartedAt = performance.now();
            await workTarget.colorBuffer.read(0, 0, width, height, { renderTarget: workTarget, data });
            timings.read_ms = elapsedMs(readStartedAt);

            const flipStartedAt = performance.now();
            let line = new Uint8Array(width * 4);
            for (let y = 0; y < height / 2; y++) {
                line = data.slice(y * width * 4, (y + 1) * width * 4);
                data.copyWithin(y * width * 4, (height - y - 1) * width * 4, (height - y) * width * 4);
                data.set(line, (height - y - 1) * width * 4);
            }
            timings.flip_ms = elapsedMs(flipStartedAt);

            const encodeStartedAt = performance.now();
            const output = getScratchCanvas(visiblePngOutputCanvas, width, height);
            visiblePngOutputCanvas = output;
            const context = output.getContext('2d');
            if (!context) {
                throw new Error('2D canvas unavailable for offscreen crop PNG capture.');
            }
            const imageData = context.createImageData(width, height);
            imageData.data.set(data);
            context.putImageData(imageData, 0, 0);
            stats = analyzeCaptureStats(data);
            const encoded = await encodeCanvasImage(output, captureMimeType, captureQuality, {
                preferDataUrl: useDataUrlForCropCapture()
            });
            image = encoded.image;
            timings.mime_type = encoded.mimeType;
            timings.quality = encoded.quality;
            timings.encode_method = encoded.encodeMethod;
            timings.encode_ms = elapsedMs(encodeStartedAt);
        } catch (error) {
            caughtError = error;
        } finally {
            const cleanupStartedAt = performance.now();
            scene.camera.endOffscreenMode();
            scene.camera.renderOverlays = previousRenderOverlays;
            scene.gizmoLayer.enabled = previousGizmoEnabled;
            scene.camera.clearPass.setClearColor(nullClr);
            scene.camera.camera.clearColor.set(0, 0, 0, 0);
            timings.cleanup_ms = elapsedMs(cleanupStartedAt);
            timings.total_ms = elapsedMs(startedAt);
        }

        if (caughtError) {
            throw caughtError;
        }

        return {
            image,
            mimeType: timings.mime_type ?? captureMimeType,
            width,
            height,
            stats: stats!,
            timings: {
                total_ms: timings.total_ms ?? elapsedMs(startedAt),
                setup_ms: timings.setup_ms ?? 0,
                wait_postrender_ms: timings.wait_postrender_ms ?? 0,
                alloc_ms: timings.alloc_ms ?? 0,
                copy_ms: timings.copy_ms ?? 0,
                read_ms: timings.read_ms ?? 0,
                flip_ms: timings.flip_ms ?? 0,
                encode_ms: timings.encode_ms ?? 0,
                cleanup_ms: timings.cleanup_ms ?? 0,
                method: 'offscreen-render-target',
                encode_method: timings.encode_method,
                mime_type: timings.mime_type ?? captureMimeType,
                quality: timings.quality
            }
        };
    };

    const captureVisibleCanvasRgbaWithTimings = async (width: number, height: number): Promise<RenderCaptureRgbaResult> => {
        if (!events.invoke('config.artisanPreserveDrawingBuffer')) {
            throw new Error('Visible canvas capture requires preserveDrawingBuffer.');
        }

        const startedAt = performance.now();
        const setupStartedAt = performance.now();
        const previousRenderOverlays = scene.camera.renderOverlays;
        const previousGizmoEnabled = scene.gizmoLayer.enabled;
        scene.camera.renderOverlays = false;
        scene.gizmoLayer.enabled = false;
        const setupMs = elapsedMs(setupStartedAt);

        let waitPostrenderMs = 0;
        let allocMs = 0;
        let drawMs = 0;
        let readMs = 0;
        let cleanupMs = 0;
        let data: Uint8Array | undefined;

        try {
            const waitStartedAt = performance.now();
            scene.forceRender = true;
            await postRender({ forceRenderNow: true });
            await yieldAfterPostRender();
            waitPostrenderMs = elapsedMs(waitStartedAt);

            const allocStartedAt = performance.now();
            const output = document.createElement('canvas');
            output.width = width;
            output.height = height;
            const ctx = output.getContext('2d', { willReadFrequently: true });
            if (!ctx) {
                throw new Error('2D canvas unavailable for visible canvas capture.');
            }
            allocMs = elapsedMs(allocStartedAt);

            const drawStartedAt = performance.now();
            ctx.drawImage(scene.canvas, 0, 0, width, height);
            drawMs = elapsedMs(drawStartedAt);

            const readStartedAt = performance.now();
            data = new Uint8Array(ctx.getImageData(0, 0, width, height).data);
            readMs = elapsedMs(readStartedAt);
        } finally {
            const cleanupStartedAt = performance.now();
            scene.camera.renderOverlays = previousRenderOverlays;
            scene.gizmoLayer.enabled = previousGizmoEnabled;
            cleanupMs = elapsedMs(cleanupStartedAt);
        }

        return {
            data: data!,
            timings: {
                total_ms: elapsedMs(startedAt),
                setup_ms: setupMs,
                wait_postrender_ms: waitPostrenderMs,
                alloc_ms: allocMs,
                copy_ms: drawMs,
                read_ms: readMs,
                flip_ms: 0,
                cleanup_ms: cleanupMs
            }
        };
    };

    const captureVisibleCanvasPngWithTimings = async (
        width: number,
        height: number,
        options: RenderVisibleCanvasPngOptions = {}
    ): Promise<RenderPngCaptureResult> => {
        if (!events.invoke('config.artisanPreserveDrawingBuffer')) {
            throw new Error('Visible canvas PNG capture requires preserveDrawingBuffer.');
        }

        const captureMimeType = normalizeCaptureMimeType(options.mimeType);
        const captureQuality = normalizeCaptureQuality(options.quality);
        const startedAt = performance.now();
        const setupStartedAt = performance.now();
        const previousRenderOverlays = scene.camera.renderOverlays;
        const previousGizmoEnabled = scene.gizmoLayer.enabled;
        scene.camera.renderOverlays = false;
        scene.gizmoLayer.enabled = false;
        const setupMs = elapsedMs(setupStartedAt);

        let waitPostrenderMs = 0;
        let allocMs = 0;
        let copyMs = 0;
        let readMs = 0;
        let encodeMs = 0;
        let cleanupMs = 0;
        let image = '';
        let actualMimeType: string = captureMimeType;
        let actualQuality = captureQuality;
        let stats: RenderPngCaptureResult['stats'] | undefined;
        let method: RenderPngCaptureTimings['method'];
        let encodeMethod: RenderPngCaptureTimings['encode_method'];
        let fallbackReason: string | undefined;

        try {
            const waitStartedAt = performance.now();
            scene.forceRender = true;
            await postRender({ forceRenderNow: true });
            waitPostrenderMs = elapsedMs(waitStartedAt);

            const allocStartedAt = performance.now();
            const output = getScratchCanvas(visiblePngOutputCanvas, width, height);
            visiblePngOutputCanvas = output;
            const ctx = output.getContext('2d');
            if (!ctx) {
                throw new Error('2D canvas unavailable for visible canvas PNG capture.');
            }
            configureCaptureResize(ctx);
            const sampleWidth = Math.max(1, Math.min(96, width));
            const sampleHeight = Math.max(1, Math.round(sampleWidth * height / Math.max(1, width)));
            const sample = getScratchCanvas(visiblePngSampleCanvas, sampleWidth, sampleHeight);
            visiblePngSampleCanvas = sample;
            const sampleCtx = sample.getContext('2d', { willReadFrequently: true });
            if (!sampleCtx) {
                throw new Error('2D canvas unavailable for visible canvas PNG stats.');
            }
            configureCaptureResize(sampleCtx);
            allocMs = elapsedMs(allocStartedAt);

            const sourceWidth = scene.canvas.width;
            const sourceHeight = scene.canvas.height;
            const canEncodeSceneCanvasDirectly = sourceWidth === width && sourceHeight === height;
            let encodeSource = output;
            let copied = false;
            if (options.method === 'capture-stream') {
                try {
                    const frameReadStartedAt = performance.now();
                    const frame = await readVisibleCanvasStreamFrame();
                    readMs += elapsedMs(frameReadStartedAt);
                    try {
                        const drawStartedAt = performance.now();
                        ctx.drawImage(frame, 0, 0, width, height);
                        copyMs = elapsedMs(drawStartedAt);
                        copied = true;
                        method = 'capture-stream';
                    } finally {
                        if (typeof frame.close === 'function') {
                            frame.close();
                        }
                    }
                } catch (err) {
                    fallbackReason = err instanceof Error ? err.message : String(err);
                    resetVisibleCanvasStream();
                    copied = false;
                }
            }
            if (!copied && options.method === 'image-bitmap' && typeof createImageBitmap === 'function') {
                try {
                    const bitmapStartedAt = performance.now();
                    const bitmap = await createImageBitmap(scene.canvas, 0, 0, sourceWidth, sourceHeight, {
                        resizeWidth: width,
                        resizeHeight: height,
                        resizeQuality: 'high'
                    });
                    ctx.drawImage(bitmap, 0, 0, width, height);
                    bitmap.close();
                    copyMs = elapsedMs(bitmapStartedAt);
                    copied = true;
                    method = 'image-bitmap';
                } catch (err) {
                    fallbackReason = err instanceof Error ? err.message : String(err);
                    copied = false;
                }
            }
            if (!copied && canEncodeSceneCanvasDirectly) {
                copied = true;
                method = 'direct-canvas';
                encodeSource = scene.canvas;
            } else if (!copied) {
                try {
                    const drawStartedAt = performance.now();
                    ctx.drawImage(scene.canvas, 0, 0, width, height);
                    copyMs = elapsedMs(drawStartedAt);
                    copied = true;
                    method = 'draw-image';
                } catch {
                    copied = false;
                }
            }
            if (!copied && typeof createImageBitmap === 'function') {
                try {
                    const bitmapStartedAt = performance.now();
                    const bitmap = await createImageBitmap(scene.canvas, 0, 0, sourceWidth, sourceHeight, {
                        resizeWidth: width,
                        resizeHeight: height,
                        resizeQuality: 'high'
                    });
                    ctx.drawImage(bitmap, 0, 0, width, height);
                    bitmap.close();
                    copyMs = elapsedMs(bitmapStartedAt);
                    copied = true;
                    method = 'image-bitmap';
                } catch {
                    copied = false;
                }
            }
            try {
                if (!copied) {
                    const readStartedAt = performance.now();
                    const pixels = new Uint8Array(sourceWidth * sourceHeight * 4);
                    (scene.graphicsDevice as any).readPixels(0, 0, sourceWidth, sourceHeight, pixels);
                    readMs += elapsedMs(readStartedAt);

                    const copyStartedAt = performance.now();
                    const imageData = new ImageData(sourceWidth, sourceHeight);
                    const sourceStride = sourceWidth * 4;
                    for (let y = 0; y < sourceHeight; y++) {
                        const sourceOffset = (sourceHeight - y - 1) * sourceStride;
                        const targetOffset = y * sourceStride;
                        imageData.data.set(pixels.subarray(sourceOffset, sourceOffset + sourceStride), targetOffset);
                    }
                    if (sourceWidth === width && sourceHeight === height) {
                        ctx.putImageData(imageData, 0, 0);
                    } else {
                        const readCanvas = getScratchCanvas(visiblePngReadCanvas, sourceWidth, sourceHeight);
                        visiblePngReadCanvas = readCanvas;
                        const readCtx = readCanvas.getContext('2d');
                        if (!readCtx) {
                            throw new Error('2D canvas unavailable for visible canvas PNG readback.');
                        }
                        readCtx.putImageData(imageData, 0, 0);
                        ctx.drawImage(readCanvas, 0, 0, sourceWidth, sourceHeight, 0, 0, width, height);
                    }
                    copyMs = elapsedMs(copyStartedAt);
                    copied = true;
                    method = 'read-pixels';
                }
            } catch {
                const copyStartedAt = performance.now();
                ctx.drawImage(scene.canvas, 0, 0, width, height);
                copyMs = elapsedMs(copyStartedAt);
                method = 'draw-image';
            }
            if (!canEncodeSceneCanvasDirectly) {
                sampleCtx.drawImage(output, 0, 0, sampleWidth, sampleHeight);
            }
            if (!copied && copyMs === 0) {
                copyMs = 0;
            }

            const encodeStartedAt = performance.now();
            const encoded = await encodeCanvasImage(encodeSource, captureMimeType, captureQuality, {
                preferDataUrl: useDataUrlForFullCapture()
            });
            image = encoded.image;
            actualMimeType = encoded.mimeType;
            actualQuality = encoded.quality;
            encodeMethod = encoded.encodeMethod;
            encodeMs = elapsedMs(encodeStartedAt);

            if (canEncodeSceneCanvasDirectly) {
                const sampleStartedAt = performance.now();
                sampleCtx.drawImage(scene.canvas, 0, 0, sampleWidth, sampleHeight);
                copyMs += elapsedMs(sampleStartedAt);
            }

            const readStartedAt = performance.now();
            stats = analyzeCaptureStats(sampleCtx.getImageData(0, 0, sampleWidth, sampleHeight).data);
            readMs += elapsedMs(readStartedAt);
        } finally {
            const cleanupStartedAt = performance.now();
            scene.camera.renderOverlays = previousRenderOverlays;
            scene.gizmoLayer.enabled = previousGizmoEnabled;
            cleanupMs = elapsedMs(cleanupStartedAt);
        }

        return {
            image,
            mimeType: actualMimeType,
            width,
            height,
            stats: stats!,
            timings: {
                total_ms: elapsedMs(startedAt),
                setup_ms: setupMs,
                wait_postrender_ms: waitPostrenderMs,
                alloc_ms: allocMs,
                copy_ms: copyMs,
                read_ms: readMs,
                encode_ms: encodeMs,
                cleanup_ms: cleanupMs,
                method,
                encode_method: encodeMethod,
                mime_type: actualMimeType,
                quality: actualQuality,
                fallback_reason: fallbackReason
            }
        };
    };

    const captureVisibleCanvasCropPngWithTimings = async (crop: RenderVisibleCanvasCropPngInput): Promise<RenderPngCaptureResult> => {
        if (!events.invoke('config.artisanPreserveDrawingBuffer')) {
            throw new Error('Visible canvas crop PNG capture requires preserveDrawingBuffer.');
        }

        const width = Math.max(1, Math.round(crop.width));
        const height = Math.max(1, Math.round(crop.height));
        const captureMimeType = normalizeCaptureMimeType(crop.mimeType);
        const captureQuality = normalizeCaptureQuality(crop.quality);
        const sourceScaleX = scene.canvas.width / Math.max(1, crop.fullWidth);
        const sourceScaleY = scene.canvas.height / Math.max(1, crop.fullHeight);
        const sourceX = Math.max(0, Math.min(scene.canvas.width - 1, Math.round(crop.x * sourceScaleX)));
        const sourceY = Math.max(0, Math.min(scene.canvas.height - 1, Math.round(crop.y * sourceScaleY)));
        const sourceWidth = Math.max(1, Math.min(scene.canvas.width - sourceX, Math.round(crop.width * sourceScaleX)));
        const sourceHeight = Math.max(1, Math.min(scene.canvas.height - sourceY, Math.round(crop.height * sourceScaleY)));

        const startedAt = performance.now();
        const setupStartedAt = performance.now();
        const previousRenderOverlays = scene.camera.renderOverlays;
        const previousGizmoEnabled = scene.gizmoLayer.enabled;
        scene.camera.renderOverlays = false;
        scene.gizmoLayer.enabled = false;
        const setupMs = elapsedMs(setupStartedAt);

        let waitPostrenderMs = 0;
        let allocMs = 0;
        let copyMs = 0;
        let readMs = 0;
        let encodeMs = 0;
        let cleanupMs = 0;
        let image = '';
        let actualMimeType: string = captureMimeType;
        let actualQuality = captureQuality;
        let stats: RenderPngCaptureResult['stats'] | undefined;
        let method: RenderPngCaptureTimings['method'];
        let encodeMethod: RenderPngCaptureTimings['encode_method'];

        try {
            if (!crop.skipRender) {
                const waitStartedAt = performance.now();
                scene.forceRender = true;
                await postRender({ forceRenderNow: true });
                await yieldAfterPostRender();
                waitPostrenderMs = elapsedMs(waitStartedAt);
            }

            const allocStartedAt = performance.now();
            const output = getScratchCanvas(visiblePngOutputCanvas, width, height);
            visiblePngOutputCanvas = output;
            const ctx = output.getContext('2d');
            if (!ctx) {
                throw new Error('2D canvas unavailable for visible canvas crop PNG capture.');
            }
            configureCaptureResize(ctx);
            const sampleWidth = Math.max(1, Math.min(96, width));
            const sampleHeight = Math.max(1, Math.round(sampleWidth * height / Math.max(1, width)));
            const sample = getScratchCanvas(visiblePngSampleCanvas, sampleWidth, sampleHeight);
            visiblePngSampleCanvas = sample;
            const sampleCtx = sample.getContext('2d', { willReadFrequently: true });
            if (!sampleCtx) {
                throw new Error('2D canvas unavailable for visible canvas crop PNG stats.');
            }
            configureCaptureResize(sampleCtx);
            allocMs = elapsedMs(allocStartedAt);

            let copied = false;
            try {
                const copyStartedAt = performance.now();
                ctx.drawImage(
                    scene.canvas,
                    sourceX,
                    sourceY,
                    sourceWidth,
                    sourceHeight,
                    0,
                    0,
                    width,
                    height
                );
                copyMs = elapsedMs(copyStartedAt);
                copied = true;
                method = 'draw-image';
            } catch {
                copied = false;
            }
            if (!copied && typeof createImageBitmap === 'function') {
                try {
                    const bitmapStartedAt = performance.now();
                    const bitmap = await createImageBitmap(scene.canvas, sourceX, sourceY, sourceWidth, sourceHeight, {
                        resizeWidth: width,
                        resizeHeight: height,
                        resizeQuality: 'high'
                    });
                    ctx.drawImage(bitmap, 0, 0, width, height);
                    bitmap.close();
                    copyMs = elapsedMs(bitmapStartedAt);
                    copied = true;
                    method = 'image-bitmap';
                } catch {
                    copied = false;
                }
            }
            try {
                if (!copied) {
                    const readbackStartedAt = performance.now();
                    const pixels = new Uint8Array(sourceWidth * sourceHeight * 4);
                    const readY = Math.max(0, scene.canvas.height - sourceY - sourceHeight);
                    (scene.graphicsDevice as any).readPixels(sourceX, readY, sourceWidth, sourceHeight, pixels);
                    readMs += elapsedMs(readbackStartedAt);

                    const flipStartedAt = performance.now();
                    const imageData = new ImageData(sourceWidth, sourceHeight);
                    const sourceStride = sourceWidth * 4;
                    for (let y = 0; y < sourceHeight; y++) {
                        const sourceOffset = (sourceHeight - y - 1) * sourceStride;
                        const targetOffset = y * sourceStride;
                        imageData.data.set(pixels.subarray(sourceOffset, sourceOffset + sourceStride), targetOffset);
                    }
                    const readCanvas = getScratchCanvas(visiblePngReadCanvas, sourceWidth, sourceHeight);
                    visiblePngReadCanvas = readCanvas;
                    const readCtx = readCanvas.getContext('2d');
                    if (!readCtx) {
                        throw new Error('2D canvas unavailable for visible canvas crop readback.');
                    }
                    readCtx.putImageData(imageData, 0, 0);
                    ctx.drawImage(readCanvas, 0, 0, sourceWidth, sourceHeight, 0, 0, width, height);
                    copyMs = elapsedMs(flipStartedAt);
                    copied = true;
                    method = 'read-pixels';
                }
            } catch {
                copied = false;
            }
            if (!copied) {
                const copyStartedAt = performance.now();
                ctx.drawImage(
                    scene.canvas,
                    sourceX,
                    sourceY,
                    sourceWidth,
                    sourceHeight,
                    0,
                    0,
                    width,
                    height
                );
                copyMs = elapsedMs(copyStartedAt);
                method = 'draw-image';
            }
            sampleCtx.drawImage(output, 0, 0, sampleWidth, sampleHeight);
            if (!copied && copyMs === 0) {
                copyMs = 0;
            }

            const readStartedAt = performance.now();
            stats = analyzeCaptureStats(sampleCtx.getImageData(0, 0, sampleWidth, sampleHeight).data);
            readMs += elapsedMs(readStartedAt);

            const encodeStartedAt = performance.now();
            const encoded = await encodeCanvasImage(output, captureMimeType, captureQuality, {
                preferDataUrl: useDataUrlForCropCapture()
            });
            image = encoded.image;
            actualMimeType = encoded.mimeType;
            actualQuality = encoded.quality;
            encodeMethod = encoded.encodeMethod;
            encodeMs = elapsedMs(encodeStartedAt);
        } finally {
            const cleanupStartedAt = performance.now();
            scene.camera.renderOverlays = previousRenderOverlays;
            scene.gizmoLayer.enabled = previousGizmoEnabled;
            cleanupMs = elapsedMs(cleanupStartedAt);
        }

        return {
            image,
            mimeType: actualMimeType,
            width,
            height,
            stats: stats!,
            timings: {
                total_ms: elapsedMs(startedAt),
                setup_ms: setupMs,
                wait_postrender_ms: waitPostrenderMs,
                alloc_ms: allocMs,
                copy_ms: copyMs,
                read_ms: readMs,
                encode_ms: encodeMs,
                cleanup_ms: cleanupMs,
                method,
                encode_method: encodeMethod,
                mime_type: actualMimeType,
                quality: actualQuality
            }
        };
    };

    events.function('render.offscreen.timed', (width: number, height: number): Promise<RenderCaptureRgbaResult> => {
        return captureOffscreenRgbaWithTimings({
            width,
            height,
            transparentBg: true,
            showDebug: false
        });
    });

    events.function('render.visibleCanvas.rgba.timed', (width: number, height: number): Promise<RenderCaptureRgbaResult> => {
        return captureVisibleCanvasRgbaWithTimings(width, height);
    });

    events.function('render.visibleCanvas.png.timed', (
        width: number,
        height: number,
        options?: RenderVisibleCanvasPngOptions
    ): Promise<RenderPngCaptureResult> => {
        return captureVisibleCanvasPngWithTimings(width, height, options);
    });

    events.function('render.offscreenCropPng.timed', (crop: RenderVisibleCanvasCropPngInput): Promise<RenderPngCaptureResult> => {
        return captureOffscreenCropPngWithTimings(crop);
    });

    events.function('render.visibleCanvas.cropPng.timed', (crop: RenderVisibleCanvasCropPngInput): Promise<RenderPngCaptureResult> => {
        return captureVisibleCanvasCropPngWithTimings(crop);
    });

    events.function('render.offscreen', (width: number, height: number): Promise<Uint8Array> => {
        return captureOffscreenRgba({
            width,
            height,
            transparentBg: true,
            showDebug: false
        });
    });

    events.function('render.visibleCanvasProbe', async (options: { includeStats?: boolean; mimeType?: string; quality?: number } = {}) => {
        const startedAt = performance.now();
        const waitStartedAt = performance.now();
        scene.forceRender = true;
        await postRender({ forceRenderNow: document.visibilityState === 'hidden' });
        await yieldAfterPostRender();
        const waitPostrenderMs = elapsedMs(waitStartedAt);

        const { canvas } = scene;
        const directEncodeStartedAt = performance.now();
        const encoded = await encodeCanvasImage(canvas, options.mimeType, options.quality);
        const directEncodeMs = elapsedMs(directEncodeStartedAt);

        let stats: VisibleCanvasProbeStats | undefined;
        let drawMs: number | undefined;
        let readMs: number | undefined;
        if (options.includeStats) {
            const drawStartedAt = performance.now();
            const off = document.createElement('canvas');
            off.width = canvas.width;
            off.height = canvas.height;
            const ctx = off.getContext('2d', { willReadFrequently: true });
            if (!ctx) {
                throw new Error('2D canvas unavailable for visible canvas probe');
            }
            ctx.drawImage(canvas, 0, 0);
            drawMs = elapsedMs(drawStartedAt);

            const readStartedAt = performance.now();
            const imageData = ctx.getImageData(0, 0, off.width, off.height);
            stats = analyzeVisibleCanvasStats(imageData.data);
            readMs = elapsedMs(readStartedAt);
        }

        return {
            preserve_drawing_buffer: !!events.invoke('config.artisanPreserveDrawingBuffer'),
            width: canvas.width,
            height: canvas.height,
            mime_type: encoded.mimeType,
            quality: encoded.quality,
            data_url_length: encoded.image.length + `data:${encoded.mimeType};base64,`.length,
            stats,
            timings: {
                wait_postrender_ms: waitPostrenderMs,
                draw_ms: drawMs,
                read_ms: readMs,
                encode_method: encoded.encodeMethod,
                direct_encode_ms: directEncodeMs,
                encode_ms: directEncodeMs,
                total_ms: elapsedMs(startedAt)
            }
        };
    });

    events.function('render.pngBuffer', async (imageSettings: RenderCaptureSettings): Promise<ArrayBuffer> => {
        const data = await captureOffscreenRgba(imageSettings);

        if (!compressor) {
            compressor = new PngCompressor();
        }

        return compressor.compress(
            new Uint32Array(data.buffer),
            imageSettings.width,
            imageSettings.height
        );
    });

    events.function('render.image', async (imageSettings: ImageSettings) => {
        events.fire('startSpinner');

        try {
            const { width, height } = imageSettings;
            const arrayBuffer = await events.invoke('render.pngBuffer', imageSettings) as ArrayBuffer;

            // construct filename
            const selected = events.invoke('selection') as Splat;
            const filename = `${removeExtension(selected?.name ?? 'SuperSplat')}-image.png`;

            // download
            downloadFile(arrayBuffer, filename);

            return true;
        } catch (error) {
            await events.invoke('showPopup', {
                type: 'error',
                header: localize('render.failed'),
                message: `'${error.message ?? error}'`
            });
        } finally {
            events.fire('stopSpinner');
        }
    });

    events.function('render.video', async (videoSettings: VideoSettings, fileStream: FileSystemWritableFileStream) => {
        events.fire('progressStart', localize('panel.render.render-video'));

        try {
            const { startFrame, endFrame, frameRate, width, height, bitrate, transparentBg, showDebug, format, codec: codecChoice } = videoSettings;

            const target = fileStream ? new StreamTarget(fileStream) : new BufferTarget();

            // Configure output format based on container selection
            let outputFormat: Mp4OutputFormat | MovOutputFormat | MkvOutputFormat | WebMOutputFormat;
            let fileExtension: string;

            if (format === 'webm') {
                outputFormat = new WebMOutputFormat();
                fileExtension = 'webm';
            } else if (format === 'mov') {
                outputFormat = new MovOutputFormat({
                    fastStart: 'in-memory'
                });
                fileExtension = 'mov';
            } else if (format === 'mkv') {
                outputFormat = new MkvOutputFormat();
                fileExtension = 'mkv';
            } else {
                outputFormat = new Mp4OutputFormat({
                    fastStart: 'in-memory'
                });
                fileExtension = 'mp4';
            }

            // Configure codec based on codec selection
            let codecType: 'avc' | 'hevc' | 'vp9' | 'av1';
            let codec: string;

            if (codecChoice === 'h264') {
                codecType = 'avc';
                codec = height < 1080 ? 'avc1.420028' : 'avc1.640033'; // H.264 Constrained Baseline/High profile
            } else if (codecChoice === 'h265') {
                codecType = 'hevc';
                codec = 'hev1.1.6.L120.B0'; // H.265 Main profile, Level 4.0
            } else if (codecChoice === 'vp9') {
                codecType = 'vp9';
                codec = 'vp09.00.10.08'; // VP9 Profile 0, Level 1.0
            } else if (codecChoice === 'av1') {
                codecType = 'av1';
                codec = 'av01.0.05M.08'; // AV1 Main Profile, Level 3.1
            } else {
                codecType = 'avc';
                codec = height < 1080 ? 'avc1.420028' : 'avc1.640033'; // Default: H.264 Constrained Baseline/High
            }

            const output = new Output({
                format: outputFormat,
                target
            });

            const videoSource = new EncodedVideoPacketSource(codecType);
            output.addVideoTrack(videoSource, {
                rotation: 0,
                frameRate
            });

            await output.start();

            let encoderError: Error | null = null;

            const encoder = new VideoEncoder({
                output: async (chunk, meta) => {
                    const encodedPacket = EncodedPacket.fromEncodedChunk(chunk);
                    await videoSource.add(encodedPacket, meta);
                },
                error: (error) => {
                    encoderError = error;
                }
            });

            encoder.configure({
                codec,
                width,
                height,
                bitrate
            });

            // start rendering to offscreen buffer only
            scene.camera.startOffscreenMode(width, height);
            scene.camera.renderOverlays = showDebug;
            scene.gizmoLayer.enabled = false;
            if (!transparentBg) {
                scene.camera.clearPass.setClearColor(events.invoke('bgClr'));
            }
            scene.lockedRenderMode = true;

            // cpu-side buffer to read pixels into
            const data = new Uint8Array(width * height * 4);
            const line = new Uint8Array(width * 4);

            // remember last camera position so we can skip sorting if the camera didn't move
            const last_pos = new Vec3(0, 0, 0);
            const last_forward = new Vec3(1, 0, 0);

            // helper to sort splats and wait for completion
            const sortAndWait = (splats: Splat[]) => {
                return Promise.all(splats.map((splat) => {
                    return new Promise<void>((resolve) => {
                        const { instance } = splat.entity.gsplat;
                        instance.sorter.once('updated', resolve);
                        instance.sort(scene.camera.mainCamera);
                        setTimeout(resolve, 1000);
                    });
                }));
            };

            // prepare the frame for rendering, returns the newly loaded splat if any
            const prepareFrame = async (frameTime: number): Promise<Splat | null> => {
                // Fire timeline.time for camera animation interpolation
                events.fire('timeline.time', frameTime);

                // Wait for PLY sequence to load the frame if present
                const newSplat = await events.invoke('plysequence.setFrameAsync', Math.floor(frameTime)) as Splat | null;

                // manually update the camera so position and rotation are correct
                scene.camera.onUpdate(0);

                // If a new PLY was loaded, sort and wait for completion
                if (newSplat) {
                    await sortAndWait([newSplat]);
                } else {
                    // No new PLY - sort existing splats if camera moved
                    const pos = scene.camera.position;
                    const forward = scene.camera.forward;
                    if (!last_pos.equals(pos) || !last_forward.equals(forward)) {
                        last_pos.copy(pos);
                        last_forward.copy(forward);

                        const splats = (scene.getElementsByType(ElementType.splat) as Splat[]).filter(splat => splat.visible);
                        await sortAndWait(splats);
                    }
                }

                return newSplat;
            };

            // capture the current video frame
            const captureFrame = async (frameTime: number) => {
                const { mainTarget, workTarget } = scene.camera;

                scene.dataProcessor.copyRt(mainTarget, workTarget);

                // read the rendered frame
                await workTarget.colorBuffer.read(0, 0, width, height, { renderTarget: workTarget, data });

                // flip the buffer vertically
                for (let y = 0; y < height / 2; y++) {
                    const top = y * width * 4;
                    const bottom = (height - y - 1) * width * 4;
                    line.set(data.subarray(top, top + width * 4));
                    data.copyWithin(top, bottom, bottom + width * 4);
                    data.set(line, bottom);
                }

                // construct the video frame
                const videoFrame = new VideoFrame(data, {
                    format: 'RGBA',
                    codedWidth: width,
                    codedHeight: height,
                    timestamp: Math.floor(1e6 * frameTime),
                    duration: Math.floor(1e6 / frameRate)
                });

                // wait for encoder queue to drain if necessary (backpressure handling)
                while (encoder.encodeQueueSize > 5) {
                    await new Promise<void>((resolve) => {
                        setTimeout(resolve, 1);
                    });
                }

                // check for encoder errors
                if (encoderError) {
                    videoFrame.close();
                    throw encoderError;
                }

                encoder.encode(videoFrame);
                videoFrame.close();
            };

            const animFrameRate = events.invoke('timeline.frameRate');
            const duration = (endFrame - startFrame) / animFrameRate;

            for (let frameTime = 0; frameTime <= duration; frameTime += 1.0 / frameRate) {
                // prepare the frame (loads PLY if needed, updates camera, sorts)
                await prepareFrame(startFrame + frameTime * animFrameRate);

                // render a frame
                scene.lockedRender = true;

                // wait for render to finish
                await postRender();

                // wait for capture
                await captureFrame(frameTime);

                events.fire('progressUpdate', {
                    text: localize('panel.render.rendering', { ellipsis: true }),
                    progress: 100 * frameTime / duration
                });
            }

            // Flush and finalize output
            await encoder.flush();
            await output.finalize();

            // Free resources
            encoder.close();

            // Download
            if (!fileStream) {
                const currentSplats = (scene.getElementsByType(ElementType.splat) as Splat[]).filter(splat => splat.visible);
                downloadFile((output.target as BufferTarget).buffer, `${removeExtension(currentSplats[0]?.name ?? 'supersplat')}.${fileExtension}`);
            }

            return true;
        } catch (error) {
            await events.invoke('showPopup', {
                type: 'error',
                header: localize('render.failed'),
                message: `'${error.message ?? error}'`
            });
        } finally {
            scene.camera.endOffscreenMode();
            scene.camera.renderOverlays = true;
            scene.gizmoLayer.enabled = true;
            scene.camera.clearPass.setClearColor(nullClr);
            scene.lockedRenderMode = false;
            scene.forceRender = true;       // camera likely moved, finish with normal render

            events.fire('progressEnd');
        }
    });
};

export { ImageSettings, VideoSettings, registerRenderEvents };
