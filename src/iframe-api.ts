import { Quat, Vec3 } from 'playcanvas';

import { Events } from './events';
import type { SemanticAnnotation, SemanticLayer } from './semantic-annotations';

const IS_SCENE_DIRTY = 'supersplat:is-scene-dirty';
const LOAD_FILE = 'supersplat:load-file';
const GET_CAMERA_STATE = 'supersplat:get-camera-state';
const CAMERA_STATE = 'supersplat:camera-state';
const GET_PRESET_STATE = 'supersplat:get-preset-state';
const PRESET_STATE = 'supersplat:preset-state';
const CAPTURE_THUMBNAIL = 'supersplat:capture-thumbnail';
const THUMBNAIL = 'supersplat:thumbnail';
const THUMBNAIL_ERROR = 'supersplat:thumbnail-error';
const CAPABILITIES_GET = 'supersplat:capabilities-get';
const CAPABILITIES = 'supersplat:capabilities';
const SAM3D_CONFIG = 'supersplat:sam3d-config';
const API_CONFIG = 'supersplat:api-config';
const READY = 'supersplat:ready';
const SCENE_LOADED = 'supersplat:scene-loaded';
const DIAGNOSTIC = 'supersplat:diagnostic';
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
const TIME_TRIAL_MISS = 'supersplat:time-trial-miss';
const TIME_TRIAL_FOUND = 'supersplat:time-trial-found';
const ANNOTATION_FOCUS = 'supersplat:annotation-focus';
const ANNOTATION_AUTHORING_CAPTURE = 'supersplat:annotation-authoring-capture';
const ANNOTATION_ANCHOR_CAPTURED = 'supersplat:annotation-anchor-captured';
const POINTER_LOOK = 'supersplat:pointer-look';
const WALK_INPUT = 'supersplat:walk-input';
const CROSSHAIR_CLICK = 'supersplat:crosshair-click';
const MULTIPLAYER_PLAYERS = 'supersplat:multiplayer-players';
const SCREEN_SURFACE = 'supersplat:screen-surface';
const SCREEN_FRAME = 'supersplat:screen-frame';
const SCREEN_CLEAR = 'supersplat:screen-clear';
const RAYCAST = 'supersplat:raycast';
const RAYCAST_RESULT = 'supersplat:raycast-result';
const RENDER_WARMUP = 'supersplat:render-warmup';
const VIEWER_PERF_RESET = 'supersplat:viewer-perf-reset';

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

type RequestId = number | string | null;
type Vec3Tuple = [number, number, number];

type MultiplayerPlayer = {
    id: string;
    label: string;
    color?: string;
    position: Vec3Tuple;
    target?: Vec3Tuple;
    speaking?: boolean;
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
    collisionMeshSrc?: string | null;
    requestId?: RequestId;
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
    requestId?: RequestId;
}

interface ThumbnailResponse {
    type: typeof THUMBNAIL;
    filename: string;
    data: ArrayBuffer | Uint8Array;
    requestId?: RequestId;
}

interface ThumbnailErrorResponse {
    type: typeof THUMBNAIL_ERROR;
    error: string;
    requestId?: RequestId;
}

interface CapabilitiesGetMessage {
    type: typeof CAPABILITIES_GET;
    requestId?: RequestId;
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
    boxerBackendUrl?: string;
    sketchfabApiToken?: string;
}

interface SemanticLayerGetMessage {
    type: typeof SEMANTIC_LAYER_GET;
    requestId?: RequestId;
}

interface SemanticLayerLoadMessage {
    type: typeof SEMANTIC_LAYER_LOAD;
    layer: Partial<SemanticLayer>;
    requestId?: RequestId;
}

interface SemanticScanRunMessage {
    type: typeof SEMANTIC_SCAN_RUN;
    requestId?: RequestId;
}

interface PreprocessReviewFramesMessage {
    type: typeof PREPROCESS_REVIEW_FRAMES;
    maxSide?: number;
    maxReviewFrames?: number;
    helperBudget?: number;
    screenshotMode?: 'normal' | 'debug';
    requestId?: RequestId;
}

interface SemanticPreprocessScanMessage {
    type: typeof SEMANTIC_PREPROCESS_SCAN;
    acceptedViewIds?: string[];
    count?: number;
    requestId?: RequestId;
}

interface GameModeMessage {
    type: typeof GAME_MODE;
    enabled: boolean;
    objectiveIds?: string[];
    showHitboxes?: boolean;
    hideChrome?: boolean;
    camera?: CameraState;
}

interface AnnotationAuthoringCaptureMessage {
    type: typeof ANNOTATION_AUTHORING_CAPTURE;
    requestId?: RequestId;
}

interface TimeTrialFoundMessage {
    type: typeof TIME_TRIAL_FOUND;
    annotationId?: string;
    annotationIds?: string[];
}

interface AnnotationFocusMessage {
    type: typeof ANNOTATION_FOCUS;
    annotationId: string;
    highlight?: boolean;
}

interface PointerLookMessage {
    type: typeof POINTER_LOOK;
    dx: number;
    dy: number;
}

interface WalkInputMessage {
    type: typeof WALK_INPUT;
    keys: {
        forward?: boolean;
        backward?: boolean;
        left?: boolean;
        right?: boolean;
        sprint?: boolean;
        slide?: boolean;
        jump?: boolean;
    };
}

interface CrosshairClickMessage {
    type: typeof CROSSHAIR_CLICK;
    screenPoint?: [number, number];
    requestId?: RequestId;
}

interface RenderWarmupMessage {
    type: typeof RENDER_WARMUP;
    frames?: number;
}

interface ViewerPerfResetMessage {
    type: typeof VIEWER_PERF_RESET;
}

interface MultiplayerPlayersMessage {
    type: typeof MULTIPLAYER_PLAYERS;
    players: MultiplayerPlayer[];
}

type ScreenCornerPoint = { x: number; y: number; z: number };

interface ScreenSurfaceMessage {
    type: typeof SCREEN_SURFACE;
    corners: { topLeft: ScreenCornerPoint; topRight: ScreenCornerPoint; bottomLeft: ScreenCornerPoint } | null;
}

interface ScreenFrameMessage {
    type: typeof SCREEN_FRAME;
    bitmap: ImageBitmap;
}

interface ScreenClearMessage {
    type: typeof SCREEN_CLEAR;
}

interface RaycastMessage {
    type: typeof RAYCAST;
    x: number;
    y: number;
    requestId?: string | number;
}

const hasOptionalRequestId = (data: any) => (
    data.requestId === undefined ||
    data.requestId === null ||
    typeof data.requestId === 'number' ||
    typeof data.requestId === 'string'
);

const hasOptionalScreenPoint = (data: any) => (
    data.screenPoint === undefined ||
    (
        Array.isArray(data.screenPoint) &&
        data.screenPoint.length === 2 &&
        data.screenPoint.every((value: unknown) => typeof value === 'number' && Number.isFinite(value))
    )
);

const isVec3Tuple = (value: unknown): value is Vec3Tuple => (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every(item => typeof item === 'number' && Number.isFinite(item))
);

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
        data.type === CAPTURE_THUMBNAIL &&
        hasOptionalRequestId(data)
    );
};

const isCapabilitiesGetMessage = (data: any): data is CapabilitiesGetMessage => {
    return data && typeof data === 'object' && data.type === CAPABILITIES_GET && hasOptionalRequestId(data);
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
        (data.boxerBackendUrl === undefined || typeof data.boxerBackendUrl === 'string') &&
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
        typeof data.enabled === 'boolean' &&
        (data.objectiveIds === undefined || Array.isArray(data.objectiveIds)) &&
        (data.showHitboxes === undefined || typeof data.showHitboxes === 'boolean') &&
        (data.hideChrome === undefined || typeof data.hideChrome === 'boolean') &&
        (data.camera === undefined || typeof data.camera === 'object')
    );
};

const isAnnotationAuthoringCaptureMessage = (data: any): data is AnnotationAuthoringCaptureMessage => {
    return (
        data &&
        typeof data === 'object' &&
        data.type === ANNOTATION_AUTHORING_CAPTURE &&
        hasOptionalRequestId(data)
    );
};

const isTimeTrialFoundMessage = (data: any): data is TimeTrialFoundMessage => {
    return (
        data &&
        typeof data === 'object' &&
        data.type === TIME_TRIAL_FOUND &&
        (data.annotationId === undefined || typeof data.annotationId === 'string') &&
        (data.annotationIds === undefined || (Array.isArray(data.annotationIds) && data.annotationIds.every((id: unknown) => typeof id === 'string')))
    );
};

const isAnnotationFocusMessage = (data: any): data is AnnotationFocusMessage => {
    return (
        data &&
        typeof data === 'object' &&
        data.type === ANNOTATION_FOCUS &&
        typeof data.annotationId === 'string' &&
        (data.highlight === undefined || typeof data.highlight === 'boolean')
    );
};

const isPointerLookMessage = (data: any): data is PointerLookMessage => {
    return data && typeof data === 'object' && data.type === POINTER_LOOK && typeof data.dx === 'number' && typeof data.dy === 'number';
};

const isWalkInputMessage = (data: any): data is WalkInputMessage => {
    return data && typeof data === 'object' && data.type === WALK_INPUT && data.keys && typeof data.keys === 'object';
};

const isCrosshairClickMessage = (data: any): data is CrosshairClickMessage => {
    return data && typeof data === 'object' && data.type === CROSSHAIR_CLICK && hasOptionalRequestId(data) && hasOptionalScreenPoint(data);
};

const isRenderWarmupMessage = (data: any): data is RenderWarmupMessage => {
    return data && typeof data === 'object' && data.type === RENDER_WARMUP && (data.frames === undefined || typeof data.frames === 'number');
};

const isViewerPerfResetMessage = (data: any): data is ViewerPerfResetMessage => {
    return data && typeof data === 'object' && data.type === VIEWER_PERF_RESET;
};

const isMultiplayerPlayersMessage = (data: any): data is MultiplayerPlayersMessage => {
    return (
        data &&
        typeof data === 'object' &&
        data.type === MULTIPLAYER_PLAYERS &&
        Array.isArray(data.players) &&
        data.players.every((player: any) => (
            player &&
            typeof player === 'object' &&
            typeof player.id === 'string' &&
            typeof player.label === 'string' &&
            (player.color === undefined || typeof player.color === 'string') &&
            isVec3Tuple(player.position) &&
            (player.target === undefined || isVec3Tuple(player.target))
        ))
    );
};

const isScreenCornerPoint = (value: any): value is ScreenCornerPoint => (
    value &&
    typeof value === 'object' &&
    typeof value.x === 'number' &&
    typeof value.y === 'number' &&
    typeof value.z === 'number'
);

const isScreenSurfaceMessage = (data: any): data is ScreenSurfaceMessage => (
    data &&
    typeof data === 'object' &&
    data.type === SCREEN_SURFACE &&
    (
        data.corners === null ||
        (
            data.corners &&
            isScreenCornerPoint(data.corners.topLeft) &&
            isScreenCornerPoint(data.corners.topRight) &&
            isScreenCornerPoint(data.corners.bottomLeft)
        )
    )
);

const isScreenFrameMessage = (data: any): data is ScreenFrameMessage => (
    data &&
    typeof data === 'object' &&
    data.type === SCREEN_FRAME &&
    typeof ImageBitmap !== 'undefined' &&
    data.bitmap instanceof ImageBitmap
);

const isScreenClearMessage = (data: any): data is ScreenClearMessage => (
    data && typeof data === 'object' && data.type === SCREEN_CLEAR
);

const isRaycastMessage = (data: any): data is RaycastMessage => (
    data && typeof data === 'object' && data.type === RAYCAST && typeof data.x === 'number' && typeof data.y === 'number'
);

// Raycast normalized screen coords against the splat, returning the world hit
// point. Tries a small ring of nearby pixels since splats are sparse and an
// exact click can fall between gaussians.
const raycastWorldPoint = async (nx: number, ny: number) => {
    const scene = window.scene as any;
    const camera = scene?.camera;
    const canvas = scene?.canvas as HTMLCanvasElement | undefined;
    if (!camera || !canvas) return null;

    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    const offsets = [[0, 0], [6, 0], [-6, 0], [0, 6], [0, -6], [10, 10], [-10, 10], [10, -10], [-10, -10]];
    for (const [ox, oy] of offsets) {
        const x = Math.min(1, Math.max(0, nx + ox / width));
        const y = Math.min(1, Math.max(0, ny + oy / height));
        const hit = await camera.intersect(x, y);
        if (hit?.position) {
            return { x: hit.position.x, y: hit.position.y, z: hit.position.z };
        }
    }
    return null;
};

const normalizeOrigin = (value: string, base: string) => new URL(value, base).origin;
const normalizeUrl = (value: string, base: string) => new URL(value, base).href.replace(/\/$/, '');

const applyApiConfig = (
    event: MessageEvent,
    values: { proxyBaseUrl?: string, sam3BackendUrl?: string, semanticScanUrl?: string, boxerBackendUrl?: string, sketchfabApiToken?: string }
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

        if (values.boxerBackendUrl) {
            nextConfig.boxerBackendUrl = normalizeUrl(values.boxerBackendUrl, event.origin);
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

const cameraStateFromAnnotation = (annotation: SemanticAnnotation): CameraState => ({
    position: {
        x: annotation.source.camera.position[0],
        y: annotation.source.camera.position[1],
        z: annotation.source.camera.position[2]
    },
    target: {
        x: annotation.source.camera.target[0],
        y: annotation.source.camera.target[1],
        z: annotation.source.camera.target[2]
    },
    fov: annotation.source.camera.fov,
    ortho: annotation.source.camera.ortho
});

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

const collisionMeshAssetVersion = '20260605-raw-mesh-v1';

const collisionMeshSrcForFilename = (filename: string, explicitSrc?: string | null) => {
    if (explicitSrc !== undefined) {
        return explicitSrc;
    }

    const basename = filename.split('/').pop()?.replace(/\.(ply|sog|spz|splat|ksplat|compressed\.ply)$/i, '');
    return basename ? `/static/dev-assets/collision/${basename}.collision.glb?v=${collisionMeshAssetVersion}` : null;
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

const requestIdPayload = (requestId?: RequestId) => {
    if (requestId !== undefined) {
        return { requestId };
    }
    return {};
};

const shouldHideTimeTrialChromeFromUrl = () => {
    const params = new URLSearchParams(window.location.search);
    return params.get('hideEditorChrome') === '1' || params.has('timeTrialPlayer');
};

const postDiagnostic = (
    source: Window,
    origin: string,
    label: string,
    details?: Record<string, unknown>,
    requestId?: RequestId
) => {
    source.postMessage({
        type: DIAGNOSTIC,
        source: 'supersplat',
        label,
        details,
        at: new Date().toISOString(),
        ...requestIdPayload(requestId)
    }, origin);
};

const messageFromError = (error: unknown, fallback = 'Unknown error') => {
    return error instanceof Error ? error.message : fallback;
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
    let timeoutId: number | null = null;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
            })
        ]);
    } finally {
        if (timeoutId !== null) {
            window.clearTimeout(timeoutId);
        }
    }
};

const waitForPostRender = (events: Events, timeoutMs = 2000) => new Promise<boolean>((resolve) => {
    let settled = false;
    let handle: { off: () => void } | null = null;
    const timeout = window.setTimeout(() => {
        if (settled) {
            return;
        }
        settled = true;
        handle?.off();
        resolve(false);
    }, timeoutMs);

    handle = events.on('postrender', () => {
        if (settled) {
            return;
        }
        settled = true;
        window.clearTimeout(timeout);
        handle?.off();
        resolve(true);
    }) as { off: () => void };

    const scene = window.scene as any;
    if (scene) {
        scene.forceRender = true;
    }
});

const emptyPointerLookStats = () => ({
    count: 0,
    forcedWalkCount: 0,
    totalAbsDx: 0,
    totalAbsDy: 0,
    totalApplyMs: 0,
    maxApplyMs: 0,
    totalGapMs: 0,
    gapCount: 0,
    maxGapMs: 0,
    longGaps: 0,
    maxLongGapMs: 0,
    lastAt: null as number | null
});

const POINTER_LOOK_LONG_GAP_MS = 80;
const POINTER_LOOK_IDLE_RESET_MS = 1000;
const LONG_TASK_REPORT_MS = 5000;
const POSTRENDER_SPIKE_GAP_MS = 120;
const POSTRENDER_SPIKE_REPORT_MS = 1000;
const GAME_MODE_ACTIVE_RENDER_IDLE_MS = 320;

const registerIframeApi = (events: Events) => {
    document.body.classList.toggle('time-trial-game-mode', shouldHideTimeTrialChromeFromUrl());

    let gameModeActive = false;
    let gameModePreviousTool: string | null = null;
    let gameModeActivatedWalk = false;
    let gameModePreviousRenderOverlays: boolean | null = null;
    let gameModePreviousGizmoLayerEnabled: boolean | null = null;
    let lastPointerLookDiagnosticAt = 0;
    let pointerLookStats = emptyPointerLookStats();
    let pendingPointerLookDx = 0;
    let pendingPointerLookDy = 0;
    let pendingPointerLookFrame: number | null = null;
    let pendingPointerLookSource: Window | null = null;
    let pendingPointerLookOrigin = '*';
    let perfFrameCount = 0;
    let perfTotalGapMs = 0;
    let perfMaxGapMs = 0;
    let perfLastFrameAt: number | null = null;
    let perfSampleStartedAt = performance.now();
    let perfLongFrameCount = 0;
    let perfVeryLongFrameCount = 0;
    let perfSpikeCount = 0;
    let lastPostrenderSpikeReportAt = 0;
    let lastPostRenderAt: number | null = null;
    let rafFrameCount = 0;
    let rafTotalGapMs = 0;
    let rafMaxGapMs = 0;
    let rafLastFrameAt: number | null = null;
    let rafSampleStartedAt = performance.now();
    let rafLongFrameCount = 0;
    let rafVeryLongFrameCount = 0;
    let pointerLookIdleResetCount = 0;
    let lastAutoSemanticLayerSignature = '';
    let activeCollisionMeshSrc: string | null = null;
    let lastGameModeSignature = '';
    let renderWarmupFrame: number | null = null;
    let activeRenderFrame: number | null = null;
    let activeRenderUntil = 0;
    let activeRenderWalkHeld = false;
    let activeRenderTickCount = 0;
    let activeRenderTotalGapMs = 0;
    let activeRenderMaxGapMs = 0;
    let activeRenderLastAt: number | null = null;
    let longTaskCount = 0;
    let longTaskTotalMs = 0;
    let longTaskMaxMs = 0;
    let longTaskSamples: Array<Record<string, unknown>> = [];
    let lastLongTaskReportAt = performance.now();

    const resetLongTaskStats = () => {
        longTaskCount = 0;
        longTaskTotalMs = 0;
        longTaskMaxMs = 0;
        longTaskSamples = [];
        lastLongTaskReportAt = performance.now();
    };

    const resetViewerPerfStats = () => {
        perfFrameCount = 0;
        perfTotalGapMs = 0;
        perfMaxGapMs = 0;
        perfLastFrameAt = null;
        perfSampleStartedAt = performance.now();
        perfLongFrameCount = 0;
        perfVeryLongFrameCount = 0;
        perfSpikeCount = 0;
        lastPostRenderAt = null;
        rafFrameCount = 0;
        rafTotalGapMs = 0;
        rafMaxGapMs = 0;
        rafLastFrameAt = null;
        rafSampleStartedAt = performance.now();
        rafLongFrameCount = 0;
        rafVeryLongFrameCount = 0;
        activeRenderTickCount = 0;
        activeRenderTotalGapMs = 0;
        activeRenderMaxGapMs = 0;
        activeRenderLastAt = null;
        resetLongTaskStats();
    };

    const startRenderWarmup = (frames?: number) => {
        const scene = window.scene as any;
        if (!scene) {
            return;
        }

        if (renderWarmupFrame !== null) {
            window.cancelAnimationFrame(renderWarmupFrame);
            renderWarmupFrame = null;
        }

        let remaining = Math.max(1, Math.min(240, Math.round(frames ?? 30)));
        const tick = () => {
            scene.forceRender = true;
            remaining -= 1;
            renderWarmupFrame = remaining > 0 ? window.requestAnimationFrame(tick) : null;
        };
        tick();
    };

    events.on('scene.clear', () => {
        activeCollisionMeshSrc = null;
    });

    const hasWalkInput = (input?: WalkInputMessage['keys']) => Boolean(
        input?.forward ||
        input?.backward ||
        input?.left ||
        input?.right ||
        input?.sprint ||
        input?.slide ||
        input?.jump
    );

    const stopActiveRender = () => {
        activeRenderUntil = 0;
        activeRenderWalkHeld = false;
        if (activeRenderFrame !== null) {
            window.cancelAnimationFrame(activeRenderFrame);
            activeRenderFrame = null;
        }
    };

    const setGameModeRenderChrome = (enabled: boolean) => {
        const scene = window.scene as any;
        if (!scene) {
            return;
        }

        if (enabled) {
            if (gameModePreviousRenderOverlays === null) {
                gameModePreviousRenderOverlays = Boolean(scene.camera?.renderOverlays);
            }
            if (gameModePreviousGizmoLayerEnabled === null) {
                gameModePreviousGizmoLayerEnabled = Boolean(scene.gizmoLayer?.enabled);
            }
            if (scene.camera) {
                scene.camera.renderOverlays = false;
            }
            if (scene.gizmoLayer) {
                scene.gizmoLayer.enabled = false;
            }
        } else {
            if (scene.camera && gameModePreviousRenderOverlays !== null) {
                scene.camera.renderOverlays = gameModePreviousRenderOverlays;
            }
            if (scene.gizmoLayer && gameModePreviousGizmoLayerEnabled !== null) {
                scene.gizmoLayer.enabled = gameModePreviousGizmoLayerEnabled;
            }
            gameModePreviousRenderOverlays = null;
            gameModePreviousGizmoLayerEnabled = null;
        }

        scene.forceRender = true;
    };

    const scheduleActiveRender = (leaseMs = GAME_MODE_ACTIVE_RENDER_IDLE_MS) => {
        if (!gameModeActive) {
            return;
        }

        activeRenderUntil = Math.max(activeRenderUntil, performance.now() + leaseMs);
        if (activeRenderFrame !== null) {
            return;
        }

        const tick = () => {
            const now = performance.now();
            const scene = window.scene as any;
            const shouldRender = gameModeActive && (activeRenderWalkHeld || now <= activeRenderUntil);
            if (!scene || !shouldRender) {
                activeRenderFrame = null;
                activeRenderLastAt = null;
                return;
            }

            if (activeRenderLastAt !== null) {
                const gapMs = now - activeRenderLastAt;
                activeRenderTotalGapMs += gapMs;
                activeRenderMaxGapMs = Math.max(activeRenderMaxGapMs, gapMs);
            }
            activeRenderLastAt = now;
            activeRenderTickCount += 1;
            scene.forceRender = true;
            activeRenderFrame = window.requestAnimationFrame(tick);
        };
        tick();
    };

    if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
        const flushLongTasks = (reason: string) => {
            if (longTaskCount === 0 || !window.parent || window.parent === window) {
                return;
            }
            postDiagnostic(window.parent, '*', 'editor-longtask', {
                reason,
                count: longTaskCount,
                totalMs: Number(longTaskTotalMs.toFixed(1)),
                maxMs: Number(longTaskMaxMs.toFixed(1)),
                samples: longTaskSamples,
                activeTool: events.invoke('tool.active') as string | null
            });
            resetLongTaskStats();
        };
        const longTaskObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
                longTaskCount += 1;
                longTaskTotalMs += entry.duration;
                longTaskMaxMs = Math.max(longTaskMaxMs, entry.duration);
                const attribution = (entry as any).attribution;
                const sample = {
                    durationMs: Number(entry.duration.toFixed(1)),
                    startTimeMs: Number(entry.startTime.toFixed(1)),
                    name: entry.name,
                    attribution: Array.isArray(attribution) ?
                        attribution.slice(0, 3).map((item: any) => ({
                            name: item.name,
                            entryType: item.entryType,
                            containerType: item.containerType,
                            containerName: item.containerName,
                            containerSrc: item.containerSrc
                        })) :
                        undefined
                };
                longTaskSamples.push(sample);
                longTaskSamples.sort((a, b) => Number(b.durationMs) - Number(a.durationMs));
                longTaskSamples = longTaskSamples.slice(0, 5);
            }
            if (performance.now() - lastLongTaskReportAt >= LONG_TASK_REPORT_MS) {
                flushLongTasks('interval');
            }
        });
        longTaskObserver.observe({ type: 'longtask', buffered: true });
        window.setInterval(() => flushLongTasks('interval'), LONG_TASK_REPORT_MS);
    }

    const resetPointerLookState = () => {
        pointerLookStats = emptyPointerLookStats();
        pendingPointerLookDx = 0;
        pendingPointerLookDy = 0;
        pendingPointerLookSource = null;
        pendingPointerLookOrigin = '*';
        if (pendingPointerLookFrame !== null) {
            window.cancelAnimationFrame(pendingPointerLookFrame);
            pendingPointerLookFrame = null;
        }
    };

    const tickRafPerf = () => {
        const now = performance.now();
        if (rafLastFrameAt !== null) {
            const gapMs = now - rafLastFrameAt;
            rafTotalGapMs += gapMs;
            rafMaxGapMs = Math.max(rafMaxGapMs, gapMs);
            if (gapMs >= 50) {
                rafLongFrameCount += 1;
            }
            if (gapMs >= 100) {
                rafVeryLongFrameCount += 1;
            }
        }
        rafLastFrameAt = now;
        rafFrameCount += 1;
        window.requestAnimationFrame(tickRafPerf);
    };
    window.requestAnimationFrame(tickRafPerf);

    const restoreGameModeTool = () => {
        const restoreTool = gameModePreviousTool;
        const shouldRestoreTool = gameModeActivatedWalk && events.invoke('tool.active') === 'walk';
        gameModeActive = false;
        gameModePreviousTool = null;
        gameModeActivatedWalk = false;
        setGameModeRenderChrome(false);
        const activeTool = events.invoke('tool.active') as string | null;
        if (shouldRestoreTool && restoreTool && activeTool !== restoreTool) {
            events.fire(`tool.${restoreTool}`);
        } else if (shouldRestoreTool && !restoreTool && activeTool) {
            events.fire('tool.deactivate');
        }
    };

    const resetGameModeState = () => {
        lastGameModeSignature = '';
        events.fire('walk.embeddedControls', false);
        resetPointerLookState();
        restoreGameModeTool();
        events.fire('semanticAnnotations.interactionMode', 'edit');
        document.body.classList.toggle('time-trial-game-mode', shouldHideTimeTrialChromeFromUrl());
    };

    const semanticLayerSignature = (layer: Pick<SemanticLayer, 'annotations'> | Partial<SemanticLayer>) => JSON.stringify((layer.annotations ?? []).map(annotation => ({
        id: annotation.id,
        label: annotation.label,
        position: annotation.position,
        radius: annotation.radius,
        targetImage: annotation.targetImage ? {
            src: annotation.targetImage.src,
            maskSrc: annotation.targetImage.maskSrc,
            fullMaskSrc: annotation.targetImage.fullMaskSrc
        } : null
    })));

    const postSemanticLayer = (source: Window = window.parent, origin = '*', requestId?: RequestId, layer?: SemanticLayer) => {
        const response = {
            type: SEMANTIC_LAYER,
            result: layer ?? events.invoke('semanticAnnotations.layer') as SemanticLayer,
            ...requestIdPayload(requestId)
        };
        source.postMessage(response, origin);
    };

    events.on('semanticAnnotations.changed', () => {
        if (window.parent && window.parent !== window) {
            const layer = events.invoke('semanticAnnotations.layer') as SemanticLayer;
            const signature = semanticLayerSignature(layer);
            if (signature !== lastAutoSemanticLayerSignature) {
                lastAutoSemanticLayerSignature = signature;
                postSemanticLayer(window.parent, '*', undefined, layer);
            }
        }
    });

    const flushPointerLook = () => {
        pendingPointerLookFrame = null;
        const dx = pendingPointerLookDx;
        const dy = pendingPointerLookDy;
        pendingPointerLookDx = 0;
        pendingPointerLookDy = 0;
        if (dx === 0 && dy === 0) {
            return;
        }

        const applyStart = performance.now();
        events.fire('walk.pointerLook', dx, dy);
        scheduleActiveRender();
        const applyMs = performance.now() - applyStart;
        pointerLookStats.totalApplyMs += applyMs;
        pointerLookStats.maxApplyMs = Math.max(pointerLookStats.maxApplyMs, applyMs);

        const source = pendingPointerLookSource;
        const now = performance.now();
        if (!source || now - lastPointerLookDiagnosticAt <= 2000) {
            return;
        }

        lastPointerLookDiagnosticAt = now;
        postDiagnostic(source, pendingPointerLookOrigin, 'pointer-look-perf', {
            events: pointerLookStats.count,
            forcedWalks: pointerLookStats.forcedWalkCount,
            avgDx: Number((pointerLookStats.totalAbsDx / Math.max(1, pointerLookStats.count)).toFixed(2)),
            avgDy: Number((pointerLookStats.totalAbsDy / Math.max(1, pointerLookStats.count)).toFixed(2)),
            avgGapMs: Number((pointerLookStats.totalGapMs / Math.max(1, pointerLookStats.gapCount)).toFixed(1)),
            maxGapMs: Number(pointerLookStats.maxGapMs.toFixed(1)),
            longGaps: pointerLookStats.longGaps,
            maxLongGapMs: Number(pointerLookStats.maxLongGapMs.toFixed(1)),
            avgApplyMs: Number((pointerLookStats.totalApplyMs / Math.max(1, pointerLookStats.count)).toFixed(3)),
            maxApplyMs: Number(pointerLookStats.maxApplyMs.toFixed(3)),
            activeTool: events.invoke('tool.active') as string | null,
            idleResets: pointerLookIdleResetCount
        });
        pointerLookIdleResetCount = 0;
        pointerLookStats = emptyPointerLookStats();
    };

    events.on('postrender', () => {
        const now = performance.now();
        if (perfLastFrameAt !== null) {
            const gapMs = now - perfLastFrameAt;
            perfTotalGapMs += gapMs;
            perfMaxGapMs = Math.max(perfMaxGapMs, gapMs);
            if (gapMs >= 50) {
                perfLongFrameCount += 1;
            }
            if (gapMs >= 100) {
                perfVeryLongFrameCount += 1;
            }
            if (gapMs >= POSTRENDER_SPIKE_GAP_MS) {
                perfSpikeCount += 1;
                if (window.parent && window.parent !== window && now - lastPostrenderSpikeReportAt >= POSTRENDER_SPIKE_REPORT_MS) {
                    const scene = window.scene as any;
                    const canvas = scene?.canvas as HTMLCanvasElement | undefined;
                    const targetSize = scene?.camera?.targetSize as { width?: number, height?: number } | undefined;
                    postDiagnostic(window.parent, '*', 'viewer-postrender-spike', {
                        gapMs: Number(gapMs.toFixed(1)),
                        rafAgeMs: rafLastFrameAt === null ? null : Number((now - rafLastFrameAt).toFixed(1)),
                        gameModeActive,
                        activeRenderLease: activeRenderFrame !== null,
                        activeRenderWalkHeld,
                        visibilityState: document.visibilityState,
                        hasFocus: document.hasFocus(),
                        activeTool: events.invoke('tool.active') as string | null,
                        annotations: (events.invoke('semanticAnnotations.list') as unknown[] | null)?.length ?? 0,
                        renderNextFrame: scene?.app?.renderNextFrame ?? null,
                        canvas: canvas ? { width: canvas.clientWidth, height: canvas.clientHeight } : null,
                        targetSize: targetSize ? { width: targetSize.width, height: targetSize.height } : null,
                        dpr: window.devicePixelRatio
                    });
                    lastPostrenderSpikeReportAt = now;
                }
            }
        }
        perfLastFrameAt = now;
        lastPostRenderAt = now;
        perfFrameCount += 1;
    });

    window.setInterval(() => {
        if (!window.parent || window.parent === window) {
            return;
        }

        const frameCount = perfFrameCount;
        const now = performance.now();
        const perfSampleMs = Math.max(1, now - perfSampleStartedAt);
        const rafSampleMs = Math.max(1, now - rafSampleStartedAt);
        const avgFrameMs = frameCount > 1 ? perfTotalGapMs / (frameCount - 1) : 0;
        const browserFrameCount = rafFrameCount;
        const avgBrowserFrameMs = browserFrameCount > 1 ? rafTotalGapMs / (browserFrameCount - 1) : 0;
        const avgActiveRenderGapMs = activeRenderTickCount > 1 ? activeRenderTotalGapMs / (activeRenderTickCount - 1) : 0;
        const sinceLastPostrenderMs = lastPostRenderAt === null ? null : now - lastPostRenderAt;
        const canvas = (window.scene as any)?.canvas as HTMLCanvasElement | undefined;
        const targetSize = (window.scene as any)?.camera?.targetSize as { width?: number, height?: number } | undefined;

        postDiagnostic(window.parent, '*', 'viewer-perf', {
            metric: 'postrender',
            idle: frameCount === 0,
            rendered: frameCount > 0,
            sampleMs: Number(perfSampleMs.toFixed(1)),
            sinceLastPostrenderMs: sinceLastPostrenderMs === null ? null : Number(sinceLastPostrenderMs.toFixed(1)),
            frames: frameCount,
            windowFps: Number((frameCount * 1000 / perfSampleMs).toFixed(1)),
            approxFps: avgFrameMs > 0 ? Number((1000 / avgFrameMs).toFixed(1)) : 0,
            avgFrameMs: Number(avgFrameMs.toFixed(1)),
            maxFrameMs: Number(perfMaxGapMs.toFixed(1)),
            longFrames: perfLongFrameCount,
            veryLongFrames: perfVeryLongFrameCount,
            spikeFrames: perfSpikeCount,
            canvas: canvas ? { width: canvas.clientWidth, height: canvas.clientHeight } : null,
            targetSize: targetSize ? { width: targetSize.width, height: targetSize.height } : null,
            dpr: window.devicePixelRatio,
            gameModeActive,
            activeRenderLease: activeRenderFrame !== null,
            activeRenderWalkHeld,
            activeRenderTicks: activeRenderTickCount,
            activeRenderAvgGapMs: Number(avgActiveRenderGapMs.toFixed(1)),
            activeRenderMaxGapMs: Number(activeRenderMaxGapMs.toFixed(1)),
            visibilityState: document.visibilityState,
            hasFocus: document.hasFocus(),
            renderNextFrame: (window.scene as any)?.app?.renderNextFrame ?? null,
            activeTool: events.invoke('tool.active') as string | null,
            annotations: (events.invoke('semanticAnnotations.list') as unknown[] | null)?.length ?? 0
        });

        postDiagnostic(window.parent, '*', 'viewer-raf-perf', {
            metric: 'requestAnimationFrame',
            sampleMs: Number(rafSampleMs.toFixed(1)),
            frames: browserFrameCount,
            windowFps: Number((browserFrameCount * 1000 / rafSampleMs).toFixed(1)),
            approxFps: avgBrowserFrameMs > 0 ? Number((1000 / avgBrowserFrameMs).toFixed(1)) : 0,
            avgFrameMs: Number(avgBrowserFrameMs.toFixed(1)),
            maxFrameMs: Number(rafMaxGapMs.toFixed(1)),
            longFrames: rafLongFrameCount,
            veryLongFrames: rafVeryLongFrameCount,
            gameModeActive,
            activeRenderLease: activeRenderFrame !== null,
            activeRenderWalkHeld,
            visibilityState: document.visibilityState,
            hasFocus: document.hasFocus(),
            activeTool: events.invoke('tool.active') as string | null
        });

        perfFrameCount = 0;
        perfTotalGapMs = 0;
        perfMaxGapMs = 0;
        perfLastFrameAt = null;
        perfSampleStartedAt = performance.now();
        perfLongFrameCount = 0;
        perfVeryLongFrameCount = 0;
        perfSpikeCount = 0;
        rafFrameCount = 0;
        rafTotalGapMs = 0;
        rafMaxGapMs = 0;
        rafLastFrameAt = null;
        rafSampleStartedAt = performance.now();
        rafLongFrameCount = 0;
        rafVeryLongFrameCount = 0;
        activeRenderTickCount = 0;
        activeRenderTotalGapMs = 0;
        activeRenderMaxGapMs = 0;
        activeRenderLastAt = null;
    }, 2000);

    events.on('semanticAnnotations.activate', (annotationId: string) => {
        if (window.parent && window.parent !== window) {
            window.parent.postMessage({
                type: TIME_TRIAL_HIT,
                annotationId
            }, '*');
        }
    });

    events.on('semanticAnnotations.miss', (point?: [number, number, number] | null) => {
        if (window.parent && window.parent !== window) {
            window.parent.postMessage({
                type: TIME_TRIAL_MISS,
                point: point ?? null
            }, '*');
        }
    });

    events.on('walk.pointerLock', (details: Record<string, unknown>) => {
        if (window.parent && window.parent !== window) {
            window.parent.postMessage({
                type: DIAGNOSTIC,
                source: 'supersplat',
                label: 'walk-pointer-lock',
                details,
                at: new Date().toISOString()
            }, '*');
        }
    });

    events.on('walk.collisionProxy', (details: Record<string, unknown>) => {
        if (window.parent && window.parent !== window) {
            window.parent.postMessage({
                type: DIAGNOSTIC,
                source: 'supersplat',
                label: 'walk-collision-proxy',
                details,
                at: new Date().toISOString()
            }, '*');
        }
    });

    events.on('walk.collisionMesh', (details: Record<string, unknown>) => {
        if (window.parent && window.parent !== window) {
            window.parent.postMessage({
                type: DIAGNOSTIC,
                source: 'supersplat',
                label: 'walk-collision-mesh',
                details,
                at: new Date().toISOString()
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

        if (isCapabilitiesGetMessage(event.data)) {
            source.postMessage({
                type: CAPABILITIES,
                result: {
                    authorCapture: true,
                    crosshairClick: true,
                    pointerLook: true,
                    walkInput: true,
                    thumbnailError: true,
                    multiplayerPlayers: true,
                    screenSurface: true,
                    raycast: true,
                    version: 6
                },
                ...requestIdPayload(event.data.requestId)
            }, event.origin);
        }

        if (isMultiplayerPlayersMessage(event.data)) {
            events.fire('multiplayer.players', event.data.players);
            return;
        }

        if (isScreenSurfaceMessage(event.data)) {
            events.fire('screen.surface', event.data.corners);
            return;
        }

        if (isScreenFrameMessage(event.data)) {
            events.fire('screen.frame', event.data.bitmap);
            return;
        }

        if (isScreenClearMessage(event.data)) {
            events.fire('screen.clear');
            return;
        }

        if (isRaycastMessage(event.data)) {
            const requestId = event.data.requestId;
            const position = await raycastWorldPoint(event.data.x, event.data.y);
            source.postMessage({ type: RAYCAST_RESULT, requestId, position }, event.origin);
            return;
        }

        if (isCaptureThumbnailQuery(event.data)) {
            const width = event.data.width ?? 1200;
            const height = event.data.height ?? 1440;
            const transparentBg = event.data.transparentBg ?? false;
            const showDebug = event.data.showDebug ?? false;
            try {
                const data = await withTimeout(
                    events.invoke('render.pngBuffer', {
                        width,
                        height,
                        transparentBg,
                        showDebug
                    }) as Promise<ArrayBuffer | Uint8Array>,
                    8000,
                    'Thumbnail capture timed out'
                );
                const splats = events.invoke('scene.splats') as Array<any>;
                const baseName = removeExtension(splats?.[0]?.name ?? 'supersplat');
                const { payload, transferables } = normalizeTransferableBuffer(data);
                const response: ThumbnailResponse = {
                    type: THUMBNAIL,
                    filename: `${baseName}-thumbnail.png`,
                    data: payload,
                    ...requestIdPayload(event.data.requestId)
                };
                postDiagnostic(source, event.origin, 'thumbnail-captured', { width, height }, event.data.requestId);
                source.postMessage(response, event.origin, transferables);
            } catch (error) {
                const message = messageFromError(error, 'Thumbnail capture failed');
                postDiagnostic(source, event.origin, 'thumbnail-error', { error: message, width, height }, event.data.requestId);
                const response: ThumbnailErrorResponse = {
                    type: THUMBNAIL_ERROR,
                    error: message,
                    ...requestIdPayload(event.data.requestId)
                };
                source.postMessage(response, event.origin);
            }
        }

        if (isPointerLookMessage(event.data)) {
            const receivedAt = performance.now();
            if (pointerLookStats.lastAt !== null) {
                const gapMs = receivedAt - pointerLookStats.lastAt;
                if (gapMs > POINTER_LOOK_IDLE_RESET_MS) {
                    pointerLookStats = emptyPointerLookStats();
                    pointerLookIdleResetCount += 1;
                } else if (gapMs > POINTER_LOOK_LONG_GAP_MS) {
                    pointerLookStats.longGaps += 1;
                    pointerLookStats.maxLongGapMs = Math.max(pointerLookStats.maxLongGapMs, gapMs);
                } else {
                    pointerLookStats.totalGapMs += gapMs;
                    pointerLookStats.gapCount += 1;
                    pointerLookStats.maxGapMs = Math.max(pointerLookStats.maxGapMs, gapMs);
                }
            }
            pointerLookStats.lastAt = receivedAt;
            pointerLookStats.count += 1;
            pointerLookStats.totalAbsDx += Math.abs(event.data.dx);
            pointerLookStats.totalAbsDy += Math.abs(event.data.dy);
            pendingPointerLookDx += event.data.dx;
            pendingPointerLookDy += event.data.dy;
            pendingPointerLookSource = source;
            pendingPointerLookOrigin = event.origin;
            if (pendingPointerLookFrame === null) {
                pendingPointerLookFrame = window.requestAnimationFrame(flushPointerLook);
            }
            return;
        }

        if (isWalkInputMessage(event.data)) {
            activeRenderWalkHeld = hasWalkInput(event.data.keys);
            events.fire('walk.input', event.data.keys);
            scheduleActiveRender(activeRenderWalkHeld ? 1000 : GAME_MODE_ACTIVE_RENDER_IDLE_MS);
            return;
        }

        if (isCrosshairClickMessage(event.data)) {
            const clickStartedAt = performance.now();
            const result = await events.invoke('semanticAnnotations.clickCenter', event.data.screenPoint);
            const handlerMs = performance.now() - clickStartedAt;
            postDiagnostic(source, event.origin, 'crosshair-click', {
                ...(result as Record<string, unknown>),
                handlerMs: Number(handlerMs.toFixed(1))
            }, event.data.requestId);
        }

        if (isRenderWarmupMessage(event.data)) {
            startRenderWarmup(event.data.frames);
            return;
        }

        if (isViewerPerfResetMessage(event.data)) {
            resetViewerPerfStats();
            return;
        }

        if (isSemanticLayerGetMessage(event.data)) {
            postSemanticLayer(source, event.origin, event.data.requestId);
        }

        if (isSemanticLayerLoadMessage(event.data)) {
            lastAutoSemanticLayerSignature = semanticLayerSignature(event.data.layer);
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
            if (event.data.enabled) {
                applyCameraState(events, event.data.camera);
            }
            const gameModeSignature = JSON.stringify({
                enabled: event.data.enabled,
                objectiveIds: event.data.objectiveIds ?? [],
                showHitboxes: event.data.showHitboxes === true,
                hideChrome: event.data.hideChrome !== false
            });
            if (gameModeSignature === lastGameModeSignature) {
                postDiagnostic(source, event.origin, 'game-mode-skip', {
                    enabled: event.data.enabled,
                    objectiveCount: event.data.objectiveIds?.length ?? 0,
                    cameraReset: Boolean(event.data.camera)
                });
                return;
            }
            lastGameModeSignature = gameModeSignature;
            events.fire('walk.embeddedControls', event.data.enabled);
            events.fire('semanticAnnotations.interactionMode', event.data.enabled ? 'game' : 'edit');
            events.fire('semanticAnnotations.gameTargets', event.data.enabled ? event.data.objectiveIds ?? [] : []);
            events.fire('semanticAnnotations.showHitboxes', event.data.enabled && event.data.showHitboxes === true);
            document.body.classList.toggle('time-trial-game-mode', event.data.enabled && event.data.hideChrome !== false);
            setGameModeRenderChrome(event.data.enabled);
            postDiagnostic(source, event.origin, 'game-mode', {
                enabled: event.data.enabled,
                objectiveCount: event.data.objectiveIds?.length ?? 0,
                showHitboxes: event.data.showHitboxes === true,
                hideChrome: event.data.hideChrome !== false,
                renderOverlays: (window.scene as any)?.camera?.renderOverlays ?? null,
                gizmoLayerEnabled: (window.scene as any)?.gizmoLayer?.enabled ?? null,
                cameraReset: Boolean(event.data.camera)
            });
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
                scheduleActiveRender(1000);
            } else {
                lastGameModeSignature = '';
                document.body.classList.toggle('time-trial-game-mode', shouldHideTimeTrialChromeFromUrl());
                if (document.pointerLockElement) {
                    document.exitPointerLock();
                }
                resetPointerLookState();
                stopActiveRender();
                restoreGameModeTool();
            }
        }

        if (isTimeTrialFoundMessage(event.data)) {
            const annotationIds = event.data.annotationIds ?? (event.data.annotationId ? [event.data.annotationId] : []);
            events.fire('semanticAnnotations.foundTargets', annotationIds);
            postDiagnostic(source, event.origin, 'found-targets', { count: annotationIds.length });
        }

        if (isAnnotationFocusMessage(event.data)) {
            const annotations = events.invoke('semanticAnnotations.list') as SemanticAnnotation[] | undefined;
            const annotation = annotations?.find(item => item.id === event.data.annotationId);
            if (annotation) {
                applyCameraState(events, cameraStateFromAnnotation(annotation));
                if (event.data.highlight ?? true) {
                    events.fire('semanticAnnotations.foundTargets', [annotation.id]);
                }
                postDiagnostic(source, event.origin, 'annotation-focus', { annotationId: annotation.id });
            } else {
                postDiagnostic(source, event.origin, 'annotation-focus-miss', { annotationId: event.data.annotationId });
            }
        }

        if (isAnnotationAuthoringCaptureMessage(event.data)) {
            const result = await events.invoke('semanticAnnotations.captureAnchor');
            postDiagnostic(source, event.origin, 'authoring-capture', { ok: Boolean(result?.ok) }, event.data.requestId);
            source.postMessage({
                type: ANNOTATION_ANCHOR_CAPTURED,
                result,
                ...requestIdPayload(event.data.requestId)
            }, event.origin);
        }

        if (isLoadFileMessage(event.data)) {
            let error: string | undefined;
            let rendered = false;
            resetGameModeState();
            events.fire('multiplayer.players', []);
            postDiagnostic(source, event.origin, 'load-file-start', {
                filename: event.data.filename,
                byteLength: event.data.data?.byteLength ?? 0
            }, event.data.requestId);
            try {
                const hasSceneData = Boolean(event.data.data);
                if (hasSceneData && event.data.data) {
                    events.fire('scene.clear');
                    const file = new File([event.data.data], event.data.filename);
                    await events.invoke('import', [{
                        filename: file.name,
                        contents: file
                    }]);
                    postDiagnostic(source, event.origin, 'load-file-imported', {
                        filename: event.data.filename,
                        empty: events.invoke('scene.empty') as boolean
                    }, event.data.requestId);
                }

                applyTransformState(events, event.data.transform);
                let collisionMeshSrc: string | null = null;
                if (hasSceneData) {
                    collisionMeshSrc = collisionMeshSrcForFilename(event.data.filename, event.data.collisionMeshSrc);
                    activeCollisionMeshSrc = collisionMeshSrc;
                } else if (event.data.transform && activeCollisionMeshSrc) {
                    collisionMeshSrc = activeCollisionMeshSrc;
                }
                if (collisionMeshSrc) {
                    events.fire('walk.collisionMeshLoad', {
                        url: collisionMeshSrc,
                        requestId: event.data.requestId ?? null,
                        transform: event.data.transform
                    });
                } else {
                    events.fire('walk.collisionMeshClear', {
                        reason: 'disabled',
                        requestId: event.data.requestId ?? null
                    });
                }
                applyCameraState(events, event.data.camera);
                rendered = await waitForPostRender(events);
                postDiagnostic(source, event.origin, 'load-file-postrender', { rendered }, event.data.requestId);
            } catch (err) {
                error = err instanceof Error ? err.message : 'Import failed';
                console.error('[iframe-api] load-file failed:', err);
                events.fire('toast', error, 'error');
                postDiagnostic(source, event.origin, 'load-file-error', { error }, event.data.requestId);
            }
            source.postMessage({
                type: SCENE_LOADED,
                result: {
                    empty: events.invoke('scene.empty') as boolean,
                    semanticLayer: events.invoke('semanticAnnotations.layer') as SemanticLayer,
                    error: error ?? (rendered ? undefined : 'Scene imported, but render confirmation timed out')
                },
                ...requestIdPayload(event.data.requestId)
            }, event.origin);
        }
    });

    if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: READY }, '*');
        postDiagnostic(window.parent, '*', 'ready');
    }
};

export { registerIframeApi };
