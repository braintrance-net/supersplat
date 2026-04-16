import { Events } from './events';
import { Vec3 } from 'playcanvas';

const IS_SCENE_DIRTY = 'supersplat:is-scene-dirty';
const LOAD_FILE = 'supersplat:load-file';
const GET_CAMERA_STATE = 'supersplat:get-camera-state';
const CAMERA_STATE = 'supersplat:camera-state';

type CameraState = {
    position: { x: number; y: number; z: number };
    target: { x: number; y: number; z: number };
    fov: number;
    ortho?: boolean;
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
}

interface GetCameraStateQuery {
    type: typeof GET_CAMERA_STATE;
}

interface CameraStateResponse {
    type: typeof CAMERA_STATE;
    result: CameraState;
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

        if (isLoadFileMessage(event.data)) {
            if (event.data.data) {
                const file = new File([event.data.data], event.data.filename);
                await events.invoke('import', [{
                    filename: file.name,
                    contents: file
                }]);
            }

            applyCameraState(events, event.data.camera);
        }
    });
};

export { registerIframeApi };
