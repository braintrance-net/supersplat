import { Events } from '../events';
import { Scene } from '../scene';
import { Splat } from '../splat';
import type { SegmentationFrame } from './provider';
import {
    buildArtisanViewKey,
    captureOffscreenRgbaTimed
} from '../tools/artisan-selection';

const DEFAULT_CAPTURE_MAX_SIDE = 1024;

const resolveSegmentationCaptureSize = (canvasWidth: number, canvasHeight: number, maxSide = DEFAULT_CAPTURE_MAX_SIDE) => {
    const limit = Math.max(256, Math.min(1920, Math.round(maxSide)));
    const scale = Math.min(1, limit / Math.max(1, canvasWidth, canvasHeight));
    return {
        width: Math.max(1, Math.round(canvasWidth * scale)),
        height: Math.max(1, Math.round(canvasHeight * scale)),
        scale
    };
};

const captureSegmentationFrame = async (
    events: Events,
    scene: Scene,
    splat: Splat,
    maxSide = DEFAULT_CAPTURE_MAX_SIDE
) => {
    const captureSize = resolveSegmentationCaptureSize(scene.canvas.clientWidth, scene.canvas.clientHeight, maxSide);
    const captured = await captureOffscreenRgbaTimed(events, captureSize.width, captureSize.height);
    const frame: SegmentationFrame = {
        rgba: captured.rgba,
        width: captureSize.width,
        height: captureSize.height,
        key: buildArtisanViewKey(scene, splat, captureSize.width, captureSize.height),
        camera: events.invoke('camera.debugState')
    };
    return { frame, captureSize, timings: captured.timings };
};

const encodeSegmentationFramePng = (frame: SegmentationFrame) => {
    const canvas = document.createElement('canvas');
    canvas.width = frame.width;
    canvas.height = frame.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('2D canvas is unavailable for segmentation capture.');
    const image = context.createImageData(frame.width, frame.height);
    image.data.set(frame.rgba);
    context.putImageData(image, 0, 0);
    return canvas.toDataURL('image/png').split(',')[1];
};

export {
    DEFAULT_CAPTURE_MAX_SIDE,
    captureSegmentationFrame,
    encodeSegmentationFramePng,
    resolveSegmentationCaptureSize
};
