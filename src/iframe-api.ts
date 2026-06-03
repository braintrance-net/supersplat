import { Quat, Vec3 } from 'playcanvas';

import { Events } from './events';
import type { SemanticLayer } from './semantic-annotations';

const IS_SCENE_DIRTY = 'supersplat:is-scene-dirty';
const LOAD_FILE = 'supersplat:load-file';
const GET_CAMERA_STATE = 'supersplat:get-camera-state';
const CAMERA_STATE = 'supersplat:camera-state';
const GET_PRESET_STATE = 'supersplat:get-preset-state';
const PRESET_STATE = 'supersplat:preset-state';
const CAPTURE_THUMBNAIL = 'supersplat:capture-thumbnail';
const THUMBNAIL = 'supersplat:thumbnail';
const SAM3D_CONFIG = 'supersplat:sam3d-config';
const API_CONFIG = 'supersplat:api-config';
const READY = 'supersplat:ready';
const SCENE_LOADED = 'supersplat:scene-loaded';
const SEMANTIC_LAYER_GET = 'supersplat:semantic-layer-get';
const SEMANTIC_LAYER = 'supersplat:semantic-layer';
const SEMANTIC_LAYER_LOAD = 'supersplat:semantic-layer-load';
const SEMANTIC_SCAN_RUN = 'supersplat:semantic-scan-run';
const SEMANTIC_SCAN_RESULT = 'supersplat:semantic-scan-result';
const PREPROCESS_REVIEW_FRAMES = 'supersplat:preprocess-review-frames';
const PREPROCESS_REVIEW_FRAMES_RESULT = 'supersplat:preprocess-review-frames-result';
const SEMANTIC_PREPROCESS_SCAN = 'supersplat:semantic-preprocess-scan';
const SEMANTIC_PREPROCESS_SCAN_RESULT = 'supersplat:semantic-preprocess-scan-result';
const GAME_MODE = 'supersplat:game-mode';
const TIME_TRIAL_HIT = 'supersplat:time-trial-hit';

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
    requestId?: number;
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

interface Sam3dConfigMessage {
    type: typeof SAM3D_CONFIG;
    proxyBaseUrl: string;
    semanticScanUrl?: string;
}

interface ApiConfigMessage {
    type: typeof API_CONFIG;
    proxyBaseUrl?: string;
    sam3BackendUrl?: string;
    semanticScanUrl?: string;
    sketchfabApiToken?: string;
}

interface SemanticLayerGetMessage {
    type: typeof SEMANTIC_LAYER_GET;
    requestId?: number;
}

interface SemanticLayerLoadMessage {
    type: typeof SEMANTIC_LAYER_LOAD;
    layer: Partial<SemanticLayer>;
    requestId?: number;
}

interface SemanticScanRunMessage {
    type: typeof SEMANTIC_SCAN_RUN;
    requestId?: number;
}

interface PreprocessReviewFramesMessage {
    type: typeof PREPROCESS_REVIEW_FRAMES;
    maxSide?: number;
    maxReviewFrames?: number;
    helperBudget?: number;
    screenshotMode?: 'normal' | 'debug';
    requestId?: number;
}

interface SemanticPreprocessScanMessage {
    type: typeof SEMANTIC_PREPROCESS_SCAN;
    acceptedViewIds?: string[];
    count?: number;
    requestId?: number;
}

interface GameModeMessage {
    type: typeof GAME_MODE;
    enabled: boolean;
}

const hasOptionalRequestId = (data: any) => data.requestId === undefined || typeof data.requestId === 'number';

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
        (data.data === undefined || data.data instanceof ArrayBuffer) &&
        hasOptionalRequestId(data)
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

const isSam3dConfigMessage = (data: any): data is Sam3dConfigMessage => {
    return (
        data &&
        typeof data === 'object' &&
        data.type === SAM3D_CONFIG &&
        typeof data.proxyBaseUrl === 'string'
    );
};

const isApiConfigMessage = (data: any): data is ApiConfigMessage => {
    return (
        data &&
        typeof data === 'object' &&
        data.type === API_CONFIG &&
        (data.proxyBaseUrl === undefined || typeof data.proxyBaseUrl === 'string') &&
        (data.sam3BackendUrl === undefined || typeof data.sam3BackendUrl === 'string') &&
        (data.semanticScanUrl === undefined || typeof data.semanticScanUrl === 'string') &&
        (data.sketchfabApiToken === undefined || typeof data.sketchfabApiToken === 'string')
    );
};

const isSemanticLayerGetMessage = (data: any): data is SemanticLayerGetMessage => {
    return data && typeof data === 'object' && data.type === SEMANTIC_LAYER_GET && hasOptionalRequestId(data);
};

const isSemanticLayerLoadMessage = (data: any): data is SemanticLayerLoadMessage => {
    return (
        data &&
        typeof data === 'object' &&
        data.type === SEMANTIC_LAYER_LOAD &&
        data.layer &&
        typeof data.layer === 'object' &&
        hasOptionalRequestId(data)
    );
};

const isSemanticScanRunMessage = (data: any): data is SemanticScanRunMessage => {
    return data && typeof data === 'object' && data.type === SEMANTIC_SCAN_RUN && hasOptionalRequestId(data);
};

const isPreprocessReviewFramesMessage = (data: any): data is PreprocessReviewFramesMessage => {
    return (
        data &&
        typeof data === 'object' &&
        data.type === PREPROCESS_REVIEW_FRAMES &&
        (data.maxSide === undefined || typeof data.maxSide === 'number') &&
        (data.maxReviewFrames === undefined || typeof data.maxReviewFrames === 'number') &&
        (data.helperBudget === undefined || typeof data.helperBudget === 'number') &&
        (data.screenshotMode === undefined || data.screenshotMode === 'normal' || data.screenshotMode === 'debug') &&
        hasOptionalRequestId(data)
    );
};

const isSemanticPreprocessScanMessage = (data: any): data is SemanticPreprocessScanMessage => {
    return (
        data &&
        typeof data === 'object' &&
        data.type === SEMANTIC_PREPROCESS_SCAN &&
        (data.acceptedViewIds === undefined || Array.isArray(data.acceptedViewIds)) &&
        (data.count === undefined || typeof data.count === 'number') &&
        hasOptionalRequestId(data)
    );
};

const isGameModeMessage = (data: any): data is GameModeMessage => {
    return (
        data &&
        typeof data === 'object' &&
        data.type === GAME_MODE &&
        typeof data.enabled === 'boolean'
    );
};

const normalizeOrigin = (value: string, base: string) => new URL(value, base).origin;

const applyApiConfig = (
    event: MessageEvent,
    values: { proxyBaseUrl?: string, sam3BackendUrl?: string, semanticScanUrl?: string, sketchfabApiToken?: string }
) => {
    try {
        const config = (window as any).supersplatConfig ?? {};
        const nextConfig = { ...config };
        const proxyOrigin = values.proxyBaseUrl ? normalizeOrigin(values.proxyBaseUrl, event.origin) : undefined;

        if (proxyOrigin) {
            nextConfig.sam3BackendUrl = proxyOrigin;
            nextConfig.semanticScanBackendUrl = proxyOrigin;
        }

        if (values.sam3BackendUrl) {
            nextConfig.sam3BackendUrl = normalizeOrigin(values.sam3BackendUrl, event.origin);
        }

        if (values.semanticScanUrl) {
            nextConfig.semanticScanBackendUrl = normalizeOrigin(values.semanticScanUrl, event.origin);
        }

        if (values.sketchfabApiToken) {
            nextConfig.sketchfabApiToken = values.sketchfabApiToken;
        }

        (window as any).supersplatConfig = nextConfig;
    } catch {
        // Ignore invalid config messages.
    }
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

const requestIdPayload = (requestId?: number) => {
    if (typeof requestId === 'number') {
        return { requestId };
    }
    return {};
};

const registerIframeApi = (events: Events) => {
    let gameModeActive = false;
    let gameModePreviousTool: string | null = null;
    let gameModeActivatedWalk = false;

    const restoreGameModeTool = () => {
        const restoreTool = gameModePreviousTool;
        const shouldRestoreTool = gameModeActivatedWalk && events.invoke('tool.active') === 'walk';
        gameModeActive = false;
        gameModePreviousTool = null;
        gameModeActivatedWalk = false;
        const activeTool = events.invoke('tool.active') as string | null;
        if (shouldRestoreTool && restoreTool && activeTool !== restoreTool) {
            events.fire(`tool.${restoreTool}`);
        } else if (shouldRestoreTool && !restoreTool && activeTool) {
            events.fire('tool.deactivate');
        }
    };

    const resetGameModeState = () => {
        restoreGameModeTool();
        events.fire('semanticAnnotations.interactionMode', 'edit');
    };

    const postSemanticLayer = (source: Window = window.parent, origin = '*', requestId?: number) => {
        const response = {
            type: SEMANTIC_LAYER,
            result: events.invoke('semanticAnnotations.layer') as SemanticLayer,
            ...requestIdPayload(requestId)
        };
        source.postMessage(response, origin);
    };

    events.on('semanticAnnotations.changed', () => {
        if (window.parent && window.parent !== window) {
            postSemanticLayer();
        }
    });

    events.on('semanticAnnotations.activate', (annotationId: string) => {
        if (window.parent && window.parent !== window) {
            window.parent.postMessage({
                type: TIME_TRIAL_HIT,
                annotationId
            }, '*');
        }
    });

    window.addEventListener('message', async (event: MessageEvent) => {
        const source = event.source as Window | null;
        if (!source) {
            return;
        }

        if (isSam3dConfigMessage(event.data)) {
            applyApiConfig(event, event.data);
        }

        if (isApiConfigMessage(event.data)) {
            applyApiConfig(event, event.data);
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

        if (isSemanticLayerGetMessage(event.data)) {
            postSemanticLayer(source, event.origin, event.data.requestId);
        }

        if (isSemanticLayerLoadMessage(event.data)) {
            events.invoke('semanticAnnotations.loadLayer', event.data.layer);
            postSemanticLayer(source, event.origin, event.data.requestId);
        }

        if (isSemanticScanRunMessage(event.data)) {
            const result = await events.invoke('semanticScan.run');
            source.postMessage({
                type: SEMANTIC_SCAN_RESULT,
                result,
                ...requestIdPayload(event.data.requestId)
            }, event.origin);
        }

        if (isPreprocessReviewFramesMessage(event.data)) {
            const result = await events.invoke('semanticPreprocess.captureReviewFrames', {
                maxSide: event.data.maxSide,
                maxReviewFrames: event.data.maxReviewFrames,
                helperBudget: event.data.helperBudget,
                screenshotMode: event.data.screenshotMode
            });
            source.postMessage({
                type: PREPROCESS_REVIEW_FRAMES_RESULT,
                result,
                ...requestIdPayload(event.data.requestId)
            }, event.origin);
        }

        if (isSemanticPreprocessScanMessage(event.data)) {
            const result = await events.invoke('semanticPreprocess.scanReviewFrames', {
                acceptedViewIds: event.data.acceptedViewIds,
                count: event.data.count
            });
            source.postMessage({
                type: SEMANTIC_PREPROCESS_SCAN_RESULT,
                result,
                ...requestIdPayload(event.data.requestId)
            }, event.origin);
        }

        if (isGameModeMessage(event.data)) {
            events.fire('semanticAnnotations.interactionMode', event.data.enabled ? 'game' : 'edit');
            if (event.data.enabled) {
                const activeTool = events.invoke('tool.active') as string | null;
                const startingGameMode = !gameModeActive;
                if (startingGameMode) {
                    gameModePreviousTool = activeTool;
                    gameModeActivatedWalk = activeTool !== 'walk';
                    gameModeActive = true;
                }
                if (startingGameMode && gameModeActivatedWalk) {
                    events.fire('tool.walk');
                }
            } else {
                restoreGameModeTool();
            }
        }

        if (isLoadFileMessage(event.data)) {
            let error: string | undefined;
            resetGameModeState();
            try {
                if (event.data.data) {
                    events.fire('scene.clear');
                    const file = new File([event.data.data], event.data.filename);
                    await events.invoke('import', [{
                        filename: file.name,
                        contents: file
                    }]);
                }

                applyTransformState(events, event.data.transform);
                applyCameraState(events, event.data.camera);
            } catch (err) {
                error = err instanceof Error ? err.message : 'Import failed';
                console.error('[iframe-api] load-file failed:', err);
                events.fire('toast', error, 'error');
            }
            source.postMessage({
                type: SCENE_LOADED,
                result: {
                    empty: events.invoke('scene.empty') as boolean,
                    semanticLayer: events.invoke('semanticAnnotations.layer') as SemanticLayer,
                    error
                },
                ...requestIdPayload(event.data.requestId)
            }, event.origin);
        }
    });

    if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: READY }, '*');
    }
};

export { registerIframeApi };
