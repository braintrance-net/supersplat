import { Events } from './events';
import { Quat, Vec3 } from 'playcanvas';

const IS_SCENE_DIRTY = 'supersplat:is-scene-dirty';
const LOAD_FILE = 'supersplat:load-file';
const GET_CAMERA_STATE = 'supersplat:get-camera-state';
const CAMERA_STATE = 'supersplat:camera-state';
const GET_PRESET_STATE = 'supersplat:get-preset-state';
const PRESET_STATE = 'supersplat:preset-state';
const CAPTURE_THUMBNAIL = 'supersplat:capture-thumbnail';
const THUMBNAIL = 'supersplat:thumbnail';

type CameraState = {
    position: { x: number; y: number; z: number };
    target: { x: number; y: number; z: number };
    fov: number;
    ortho?: boolean;
};

type PresetTransform = {
    position: { x: number; y: number; z: number };
    rotationEuler: { x: number; y: number; z: number };
    scale: { x: number; y: number; z: number };
};

type PresetState = {
    camera: CameraState;
    splatTransform: PresetTransform | null;
};

interface IsSceneDirtyQuery {
    type: typeof IS_SCENE_DIRTY;
}

interface IsSceneDirtyResponse {
    type: typeof IS_SCENE_DIRTY;
    result: boolean;
}

interface LoadFileMessage {
    type: typeof LOAD_FILE;
    filename: string;
    data?: ArrayBuffer;
    camera?: CameraState;
    transform?: PresetTransform;
}

interface GetCameraStateQuery {
    type: typeof GET_CAMERA_STATE;
}

interface CameraStateResponse {
    type: typeof CAMERA_STATE;
    result: CameraState;
}

interface GetPresetStateQuery {
    type: typeof GET_PRESET_STATE;
}

interface PresetStateResponse {
    type: typeof PRESET_STATE;
    result: PresetState;
}

interface CaptureThumbnailQuery {
    type: typeof CAPTURE_THUMBNAIL;
    width?: number;
    height?: number;
    transparentBg?: boolean;
    showDebug?: boolean;
}

interface ThumbnailResponse {
    type: typeof THUMBNAIL;
    filename: string;
    data: ArrayBuffer | Uint8Array;
}

const isSceneDirtyQuery = (data: any): data is IsSceneDirtyQuery => {
    return (
        data &&
        typeof data === 'object' &&
        data.type === IS_SCENE_DIRTY
    );
};

const isLoadFileMessage = (data: any): data is LoadFileMessage => {
    return (
        data &&
        typeof data === 'object' &&
        data.type === LOAD_FILE &&
        typeof data.filename === 'string' &&
        (data.data === undefined || data.data instanceof ArrayBuffer)
    );
};

const isGetCameraStateQuery = (data: any): data is GetCameraStateQuery => {
    return (
        data &&
        typeof data === 'object' &&
        data.type === GET_CAMERA_STATE
    );
};

const isGetPresetStateQuery = (data: any): data is GetPresetStateQuery => {
    return (
        data &&
        typeof data === 'object' &&
        data.type === GET_PRESET_STATE
    );
};

const isCaptureThumbnailQuery = (data: any): data is CaptureThumbnailQuery => {
    return (
        data &&
        typeof data === 'object' &&
        data.type === CAPTURE_THUMBNAIL
    );
};

const applyCameraState = (events: Events, camera?: CameraState) => {
    if (!camera) {
        return;
    }

    events.fire('camera.setPose', {
        position: new Vec3(camera.position.x, camera.position.y, camera.position.z),
        target: new Vec3(camera.target.x, camera.target.y, camera.target.z)
    }, 0);

    if (typeof camera.fov === 'number') {
        events.fire('camera.setFov', camera.fov);
    }

    if (typeof camera.ortho === 'boolean') {
        events.fire('camera.setOrtho', camera.ortho);
    }
};

const applyTransformState = (events: Events, transform?: PresetTransform) => {
    if (!transform) {
        return;
    }

    const splats = events.invoke('scene.splats') as Array<any>;
    const splat = splats?.[0];
    if (!splat) {
        return;
    }

    splat.move(
        new Vec3(transform.position.x, transform.position.y, transform.position.z),
        new Quat().setFromEulerAngles(
            transform.rotationEuler.x,
            transform.rotationEuler.y,
            transform.rotationEuler.z
        ),
        new Vec3(transform.scale.x, transform.scale.y, transform.scale.z)
    );

    const selection = events.invoke('selection');
    const pivot = events.invoke('pivot');
    if (selection && pivot) {
        events.fire('selection.changed', selection);
    }

    const scene = window.scene as any;
    if (scene) {
        scene.forceRender = true;
    }
};

const removeExtension = (filename: string) => {
    const dot = filename.lastIndexOf('.');
    return dot === -1 ? filename : filename.slice(0, dot);
};

const normalizeTransferableBuffer = (data: ArrayBuffer | Uint8Array) => {
    if (data instanceof ArrayBuffer) {
        return {
            payload: data,
            transferables: [data]
        };
    }

    if (ArrayBuffer.isView(data)) {
        const payload = data.buffer instanceof ArrayBuffer &&
            data.byteOffset === 0 &&
            data.byteLength === data.buffer.byteLength ?
            data.buffer :
            data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;

        return {
            payload,
            transferables: [payload]
        };
    }

    const payload = new Uint8Array(data as ArrayBufferLike).slice().buffer;
    return {
        payload,
        transferables: [payload]
    };
};

const registerIframeApi = (events: Events) => {
    window.addEventListener('message', async (event: MessageEvent) => {
        const source = event.source as Window | null;
        if (!source) {
            return;
        }

        if (isSceneDirtyQuery(event.data)) {
            const response: IsSceneDirtyResponse = {
                type: IS_SCENE_DIRTY,
                result: events.invoke('scene.dirty') as boolean
            };
            source.postMessage(response, event.origin);
        }

        if (isGetCameraStateQuery(event.data)) {
            const response: CameraStateResponse = {
                type: CAMERA_STATE,
                result: events.invoke('camera.debugState') as CameraState
            };
            source.postMessage(response, event.origin);
        }

        if (isGetPresetStateQuery(event.data)) {
            const response: PresetStateResponse = {
                type: PRESET_STATE,
                result: events.invoke('preset.debugState') as PresetState
            };
            source.postMessage(response, event.origin);
        }

        if (isCaptureThumbnailQuery(event.data)) {
            const width = event.data.width ?? 1200;
            const height = event.data.height ?? 1440;
            const transparentBg = event.data.transparentBg ?? false;
            const showDebug = event.data.showDebug ?? false;
            const data = await events.invoke('render.pngBuffer', {
                width,
                height,
                transparentBg,
                showDebug
            }) as ArrayBuffer | Uint8Array;
            const splats = events.invoke('scene.splats') as Array<any>;
            const baseName = removeExtension(splats?.[0]?.name ?? 'supersplat');
            const { payload, transferables } = normalizeTransferableBuffer(data);
            const response: ThumbnailResponse = {
                type: THUMBNAIL,
                filename: `${baseName}-thumbnail.png`,
                data: payload
            };
            source.postMessage(response, event.origin, transferables);
        }

        if (isLoadFileMessage(event.data)) {
            if (event.data.data) {
                const file = new File([event.data.data], event.data.filename);
                await events.invoke('import', [{
                    filename: file.name,
                    contents: file
                }]);
            }

            applyTransformState(events, event.data.transform);
            applyCameraState(events, event.data.camera);
        }
    });
};

export { registerIframeApi };
