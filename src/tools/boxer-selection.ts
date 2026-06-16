/* eslint-disable no-use-before-define */
import { Color, Vec3 } from 'playcanvas';

import { Events } from '../events';
import { Scene } from '../scene';
import { Splat } from '../splat';
import { getActiveCollisionSurface, waitForCollisionSurface } from '../utils/collision-surface';

const OBB_EDGES: [number, number][] = [
    [0, 1], [2, 3], [4, 5], [6, 7],
    [0, 2], [1, 3], [4, 6], [5, 7],
    [0, 4], [1, 5], [2, 6], [3, 7]
];

const OBB_COLOR = new Color(0, 0.86, 1, 1); // cyan
const BOXER_MODEL_HW = 960;
const BOXER_PATCH_SIZE = 16;
const MAX_SDP_POINTS = 12000;
const DEBUG_SDP_PREVIEW_POINTS = 256;
const PROJECTION_SAMPLE_COUNT = 32;
const COMPACT_CLICK_BB_AREA_RATIO = 0.015;
const CONNECTED_CLUSTER_BB_AREA_RATIO = 0.018;
const BROAD_CLICK_BB_AREA_RATIO = 0.08;
const LOW_2D_SCORE = 0.35;
const LOCAL_CLICK_WINDOW_MIN_PX = 120;
const LOCAL_CLICK_WINDOW_MAX_PX = 260;
const CLUSTER_EPS_MIN = 0.08;
const CLUSTER_EPS_MAX = 0.45;
const CLUSTER_EPS_FRAC_OF_DEPTH = 0.015;
const CLUSTER_DEPTH_FRAC_OF_DEPTH = 0.04;
const CLUSTER_DEPTH_MIN = 0.35;
const CLUSTER_DEPTH_MAX = 1.25;
const DEFAULT_SAM3_BACKEND_URL = 'http://3.19.208.185:8000';
const SAM3_REQUEST_TIMEOUT_MS = 10000;
const LOCAL_EVAL_SAVE_PATH = '/api/boxer-evals/append';
const LOCAL_EVAL_SAVE_TIMEOUT_MS = 10000;
const SAM3_MAX_IMAGE_SIDE = 960;
const MASK_OCCLUSION_CELL_PX = 4;
const MASK_OCCLUSION_FRAC_OF_DEPTH = 0.015;
const MASK_OCCLUSION_MIN_M = 0.015;
const MASK_OCCLUSION_MAX_M = 0.12;

const getBoxerBackendUrl = () => {
    const configured = window.supersplatConfig?.boxerBackendUrl?.trim();
    if (configured) {
        return configured.replace(/\/$/, '');
    }

    return 'https://boxer.4dream.app';
};

const getBoxerGpuDepthEnabled = () => window.supersplatConfig?.boxerGpuDepth === true;

const getSam3BackendUrl = () => {
    return window.supersplatConfig?.sam3BackendUrl?.trim() || DEFAULT_SAM3_BACKEND_URL;
};

const getLocalEvalSaveUrl = () => {
    try {
        const url = new URL(getSam3BackendUrl(), window.location.href);
        if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
            return null;
        }

        url.pathname = LOCAL_EVAL_SAVE_PATH;
        url.search = '';
        url.hash = '';
        return url.href;
    } catch {
        return null;
    }
};

const getSam3FetchCredentials = (sam3BackendUrl: string): 'same-origin' | 'omit' => {
    if (!window.supersplatConfig?.sam3BackendUrl?.trim()) {
        return 'same-origin';
    }

    try {
        return new URL(sam3BackendUrl, window.location.href).origin === window.location.origin ? 'same-origin' : 'omit';
    } catch {
        return 'same-origin';
    }
};

const compactClientBrushCandidate = (candidate: Record<string, unknown>) => ({
    bb2d: candidate.bb2d,
    source: candidate.source,
    scale: candidate.scale,
    component_index: candidate.component_index,
    point_count: candidate.point_count,
    projected_candidate_count: candidate.projected_candidate_count,
    front_surface_candidate_count: candidate.front_surface_candidate_count,
    inside_candidate_count: candidate.inside_candidate_count,
    support_inside_count: candidate.support_inside_count,
    selection_score: candidate.selection_score,
    projection_fit: candidate.projection_fit && typeof candidate.projection_fit === 'object' ? {
        best_score: (candidate.projection_fit as Record<string, unknown>).best_score,
        best_order: (candidate.projection_fit as Record<string, unknown>).best_order
    } : candidate.projection_fit
});

const compactEvalCaseForLocalSave = (evalCase: Record<string, unknown>) => {
    const boxerResult = evalCase.boxer_result;
    if (!boxerResult || typeof boxerResult !== 'object') {
        return evalCase;
    }

    const result = boxerResult as Record<string, unknown>;
    const brushDebug = result.client_brush;
    if (!brushDebug || typeof brushDebug !== 'object') {
        return evalCase;
    }

    const clientBrush = brushDebug as Record<string, unknown>;
    const candidates = Array.isArray(clientBrush.candidates) ?
        clientBrush.candidates.slice(0, 8).map(candidate => (
            candidate && typeof candidate === 'object' ?
                compactClientBrushCandidate(candidate as Record<string, unknown>) :
                candidate
        )) :
        clientBrush.candidates;

    return {
        ...evalCase,
        boxer_result: {
            ...result,
            client_brush: {
                ...clientBrush,
                candidates,
                candidates_truncated: Array.isArray(clientBrush.candidates) ? clientBrush.candidates.length : undefined
            }
        }
    };
};

type OBBResult = {
    center: [number, number, number];
    dimensions: [number, number, number];
    rotation: number[][];
    corners: number[][];
    label: string;
    confidence: number;
    score2d?: number;
    bb2d?: [number, number, number, number]; // [x_min, y_min, x_max, y_max] in image pixels
    bb2d_format?: 'xyxy' | 'xxyy';
    source?: string;
    source_bb2d?: [number, number, number, number];
};
type BoxerResponse = OBBResult & {
    candidates?: unknown[];
    proposals?: unknown[];
    detections?: unknown[];
};
type BoxerDetectAllResponse = {
    detections?: unknown[];
    candidates?: unknown[];
    proposals?: unknown[];
    results?: unknown[];
};

// Extract pinhole intrinsics from a PlayCanvas camera. Square pixels, so
// fx == fy; only the axis that `cam.fov` describes depends on `horizontalFov`.
// SuperSplat toggles horizontalFov based on viewport aspect, so we must read it.
const extractIntrinsics = (cam: any, w: number, h: number) => {
    const fovRad = (cam.fov * Math.PI) / 180;
    const f = cam.horizontalFov ?
        w / (2 * Math.tan(fovRad / 2)) :
        h / (2 * Math.tan(fovRad / 2));
    return { fx: f, fy: f, cx: w / 2, cy: h / 2, width: w, height: h };
};

// Invert view matrix (OGL world→cam) to cam→world, then flip Y,Z columns (OGL→CV).
const extractExtrinsics = (cam: any): number[] => {
    const v = cam.viewMatrix.data as Float32Array;
    const r00 = v[0], r10 = v[1], r20 = v[2];
    const r01 = v[4], r11 = v[5], r21 = v[6];
    const r02 = v[8], r12 = v[9], r22 = v[10];
    const tx = v[12], ty = v[13], tz = v[14];

    const rt00 = r00, rt01 = r10, rt02 = r20;
    const rt10 = r01, rt11 = r11, rt12 = r21;
    const rt20 = r02, rt21 = r12, rt22 = r22;
    const itx = -(rt00 * tx + rt01 * ty + rt02 * tz);
    const ity = -(rt10 * tx + rt11 * ty + rt12 * tz);
    const itz = -(rt20 * tx + rt21 * ty + rt22 * tz);

    return [
        rt00, rt10, rt20, 0,
        -rt01, -rt11, -rt21, 0,
        -rt02, -rt12, -rt22, 0,
        itx, ity, itz, 1
    ];
};

// Capture a fresh render via SuperSplat's offscreen render path (excludes overlays/gizmos).
const captureScene = async (events: Events, width: number, height: number): Promise<string> => {
    const rgba: Uint8Array = await events.invoke('render.offscreen', width, height);
    const off = document.createElement('canvas');
    off.width = width;
    off.height = height;
    const ctx = off.getContext('2d')!;
    const imageData = ctx.createImageData(width, height);
    imageData.data.set(rgba);
    ctx.putImageData(imageData, 0, 0);
    return off.toDataURL('image/png').split(',')[1];
};

const captureSceneRgba = (events: Events, width: number, height: number): Promise<Uint8Array> => {
    return events.invoke('render.offscreen', width, height) as Promise<Uint8Array>;
};

const loadPng = async (b64: string): Promise<HTMLImageElement> => {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('image load failed'));
        img.src = `data:image/png;base64,${b64}`;
    });
    return img;
};

const resizePngBase64 = async (
    b64: string,
    width: number,
    height: number,
    maxSide: number
): Promise<{ image: string; width: number; height: number; scale: number }> => {
    const scale = Math.min(1, maxSide / Math.max(width, height));
    if (scale >= 0.999) {
        return { image: b64, width, height, scale: 1 };
    }

    const outWidth = Math.max(1, Math.round(width * scale));
    const outHeight = Math.max(1, Math.round(height * scale));
    const img = await loadPng(b64);
    const off = document.createElement('canvas');
    off.width = outWidth;
    off.height = outHeight;
    const ctx = off.getContext('2d')!;
    ctx.drawImage(img, 0, 0, outWidth, outHeight);
    return {
        image: off.toDataURL('image/png').split(',')[1],
        width: outWidth,
        height: outHeight,
        scale
    };
};

const cropPngBase64 = async (
    b64: string,
    crop: { x: number; y: number; size: number }
): Promise<string> => {
    const img = await loadPng(b64);
    const off = document.createElement('canvas');
    off.width = crop.size;
    off.height = crop.size;
    const ctx = off.getContext('2d')!;
    ctx.drawImage(img, crop.x, crop.y, crop.size, crop.size, 0, 0, crop.size, crop.size);
    return off.toDataURL('image/png').split(',')[1];
};

const maskPngToArray = async (b64: string, width: number, height: number): Promise<Uint8Array> => {
    const img = await loadPng(b64);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, width, height);
    const id = ctx.getImageData(0, 0, width, height);
    const out = new Uint8Array(width * height);
    for (let i = 0, j = 0; i < id.data.length; i += 4, j++) out[j] = id.data[i];
    return out;
};

// CPU z-buffer of splat centers projected through the current camera pose.
// Uses the same OpenGL→OpenCV conversion as extractExtrinsics, so the depth
// frame matches what the backend reconstructs from the extrinsics it receives.
// Depth values are camera-space +Z in OpenCV convention (positive = in front),
// in the scene's world units. 0 = invalid pixel.
type DepthBuffer = { data: Float32Array; width: number; height: number };
type Intrinsics = ReturnType<typeof extractIntrinsics>;
type ProjectionSample = {
    world: [number, number, number];
    pixel: [number, number];
    depth: number;
    in_frame: boolean;
};
type ProjectedSplatCandidate = ProjectionSample & {
    point: [number, number, number];
    splatIndex: number;
    layer_class?: 0 | 1 | 2 | 3;
    tile_index?: number;
};
type Sam3MaskRegion = {
    points: [number, number, number][];
    mask_bb2d: NormalizedBb2d;
    point_count: number;
    projected_candidate_count: number;
    front_surface_candidate_count: number;
    mask_area_ratio: number;
};
type Sam3MaskDebug = {
    backend_url?: string;
    resized?: { width: number; height: number; scale: number };
    attempts: {
        endpoint: string;
        status?: number;
        ok?: boolean;
        error?: string;
        detail?: string;
    }[];
    mask_bb2d?: NormalizedBb2d;
    mask_area_ratio?: number;
    projected_candidate_count?: number;
    front_surface_candidate_count?: number;
    selected_point_count?: number;
    rejection_reason?: string;
    error?: string;
};
type BoxerFramePayload = {
    image: string;
    intrinsics: Intrinsics;
    extrinsics: number[];
    gravity: [number, number, number];
    depth: string;
    depth_width: number;
    depth_height: number;
    depth_valid_pixels: number;
    depth_valid_ratio: number;
    depth_min: number;
    depth_max: number;
    depth_source: 'gpu-splat-footprint' | 'cpu-center-zbuffer' | 'skipped-voxel-brush';
    geometry_cache_count?: number;
    geometry_cache_ms?: number;
    geometry_cache_reused?: boolean;
    depth_visibility_index_ms?: number;
    depth_visibility_view_ms?: number;
    depth_visibility_view_reused?: boolean;
    depth_visibility_tile_count?: number;
    depth_visibility_visible_tiles?: number;
    point_cloud: number[][];
    point_cloud_source: 'front_surface_centers' | 'frustum_centers' | 'proposal_local_front_surface';
    sdp_points: number[][];
    sdp_point_count: number;
    sdp_patch_depths: string;
    sdp_patch_width: number;
    sdp_patch_height: number;
    sdp_patch_size: number;
    sdp_patch_valid_count: number;
    boxer_model_hw: number;
    image_preprocess: {
        source: 'viewer-full-frame';
        model_size: number;
        square_crop: {
            x: number;
            y: number;
            size: number;
            scale: number;
        };
        intrinsics_960_square: Intrinsics;
    };
    image_width: number;
    image_height: number;
    canvas_css_width: number;
    canvas_css_height: number;
    device_pixel_ratio: number;
    projection_samples: ProjectionSample[];
    boxer_contract_version: 2;
    bb2d_format: 'xyxy';
    official_boxer_bb2d_format: 'xxyy';
};
type BoxerPromptPayload = { click_xy: [number, number] } | { text: string } | { detect_all: true };
type NormalizedBb2d = [number, number, number, number];
type ObjectCropOptions = {
    enabled?: boolean;
    scale?: number;
    min_size?: number;
    max_size?: number;
};
type DirectLiftProjectionFit = NonNullable<GeometryRefinement['projection_fit']>;
type DirectLiftGeometryFit = {
    aabb_iou: number;
    center_distance: number;
    center_distance_extent_ratio: number;
    score: number;
    splat_aabb: Aabb;
    predicted_aabb: Aabb;
};
type RecenterDecision = {
    applied: boolean;
    reason: string;
    source?: 'gpu-depth' | 'cpu-center-depth';
    pixel?: [number, number];
    surface_world?: [number, number, number];
    shift?: [number, number, number];
    shift_length?: number;
    max_shift?: number;
};
type GeometryRefinement = {
    applied: boolean;
    reason: string;
    point_count?: number;
    candidate_point_count?: number;
    full_candidate_point_count?: number;
    center?: [number, number, number];
    dimensions?: [number, number, number];
    observed_dimensions?: [number, number, number];
    model_dimensions?: [number, number, number];
    dimension_source?:
        'model-or-observed-max' |
        'robust-observed-fit' |
        'compact-click-observed' |
        'click-local-observed' |
        'broad-surface-click-prior' |
        'sam3-mask-observed' |
        'ray-tall-bb2d' |
        'ray-wide-bb2d';
    dimension_prior?: 'vertical-label-aspect' | 'projection-fit' | 'ray-dimension-prior';
    rotation_prior?: 'vertical-label-gravity-snap' | 'broad-click-axis-aligned';
    mask_bb2d?: NormalizedBb2d;
    mask_area_ratio?: number;
    focus_depth?: number;
    focus_surface_world?: [number, number, number];
    bbox_center_depth?: number;
    bbox_center_surface_world?: [number, number, number];
    focus_surface_center_offset?: [number, number, number];
    ray_sample_count?: number;
    ray_depth_stats?: {
        min: number;
        median: number;
        max: number;
        spread: number;
    };
    ray_samples?: {
        id: string;
        pixel: [number, number];
        depth: number;
        world: [number, number, number];
    }[];
    projection_fit?: {
        best_order: [number, number, number];
        best_score: number;
        applied?: boolean;
        applied_order?: [number, number, number];
        previous_score?: number;
        candidates: {
            order: [number, number, number];
            dimensions: [number, number, number];
            bbox_iou: number;
            center_error_ratio: number;
            score: number;
        }[];
    };
};
type BoxerClickDebugPanelState = {
    mode: string;
    endpoint?: string;
    label?: string;
    confidence?: number;
    total_ms?: number;
    frame_ms?: number;
    backend_ms?: number;
    refine_ms?: number;
    draw_ms?: number;
    image?: string;
    image_width?: number;
    image_height?: number;
    depth_source?: string;
    depth_ms_text?: string;
    bb2d?: NormalizedBb2d | null;
    scale_runs?: { scale: number; ms: number; detections: number }[];
    candidate_count?: number;
    proposal_count?: number;
    selected_splat_count?: number;
    ray_sample_count?: number;
    ray_depth_stats?: GeometryRefinement['ray_depth_stats'];
    candidates?: {
        label?: string;
        scale?: number;
        score?: number;
        confidence?: number;
        source?: string;
        bb2d?: NormalizedBb2d | null;
    }[];
};
type BoxerOverlayLayer = {
    bb2d?: NormalizedBb2d | null;
    label: string;
    color: string;
    dash?: string;
    width?: number;
    // optional stroke polyline (canvas pixels), drawn semi-transparent
    points?: [number, number][];
};
type BoxerBrushPrompt = {
    shape?: 'circle' | 'rect' | 'stroke';
    center_xy?: [number, number];
    radius?: number;
    width?: number;
    height?: number;
    bb2d?: NormalizedBb2d;
    points?: [number, number][];
    pad?: number;
    // constant world-space brush radius when the stroke was drawn in 3D mode
    radius_world?: number;
    // 'raw' = pure extents box from the brushed gaussians, no candidate
    // competition, no calibrated priors, no refinement
    // 'evidence' = normal client brush, but keep full brush_surface evidence
    // for fusion/validation instead of taking the broad fast shortcut
    mode?: 'raw' | 'evidence';
    // diagnostic: per-point pointer position (client px) and the collision
    // surface hit under it, recorded by the brush tool for replication
    probe_trace?: { client: [number, number]; world: [number, number, number] | null; distance: number | null }[];
};
type BoxerEvalPrompt =
    { type: 'click'; click_xy: [number, number] } |
    { type: 'click_sam'; click_xy: [number, number] } |
    { type: 'client_click'; click_xy: [number, number] } |
    { type: 'client_brush'; click_xy?: [number, number]; brush?: BoxerBrushPrompt } |
    { type: 'client_brush_floor_snap'; click_xy?: [number, number]; brush?: BoxerBrushPrompt } |
    { type: 'brush_sam'; click_xy?: [number, number]; brush?: BoxerBrushPrompt } |
    { type: 'brush_sam_clean'; click_xy?: [number, number]; brush?: BoxerBrushPrompt } |
    { type: 'brush_boxer'; click_xy?: [number, number]; brush?: BoxerBrushPrompt; boxernet_world_scale?: number; boxernet_world_scales?: number[]; refinement_mode?: 'auto' | 'raw' | 'ray'; preprocess_mode?: 'full_frame' | 'square_crop'; object_crop?: ObjectCropOptions } |
    { type: 'brush_fused'; click_xy?: [number, number]; brush?: BoxerBrushPrompt; boxernet_world_scale?: number; fuse_mode?: 'model_dims' | 'model_depth' } |
    { type: 'detect_all_click'; click_xy: [number, number] } |
    { type: 'direct_lift_click'; click_xy: [number, number]; use_sam?: boolean; preprocess_mode?: 'full_frame' | 'square_crop'; depth_mode?: string; geometry_mode?: 'global' | 'proposal_local'; boxernet_world_scale?: number; boxernet_world_scales?: number[]; refinement_mode?: 'auto' | 'raw' | 'ray'; gravity?: [number, number, number]; object_crop?: ObjectCropOptions } |
    { type: 'lift_box'; bb2d: NormalizedBb2d; click_xy?: [number, number]; preprocess_mode?: 'full_frame' | 'square_crop'; depth_mode?: string; geometry_mode?: 'global' | 'proposal_local'; boxernet_world_scale?: number; boxernet_world_scales?: number[]; refinement_mode?: 'auto' | 'raw' | 'ray'; gravity?: [number, number, number]; object_crop?: ObjectCropOptions } |
    { type: 'lift_target_box'; click_xy?: [number, number]; preprocess_mode?: 'full_frame' | 'square_crop'; depth_mode?: string; geometry_mode?: 'global' | 'proposal_local'; boxernet_world_scale?: number; boxernet_world_scales?: number[]; refinement_mode?: 'auto' | 'raw' | 'ray'; gravity?: [number, number, number]; object_crop?: ObjectCropOptions } |
    { type: 'client_lift_target_box'; click_xy?: [number, number] } |
    { type: 'text'; text: string };
type BoxerEvalTarget = {
    type: 'axis_aligned_box';
    center: [number, number, number];
    dimensions: [number, number, number];
    rotation: number[][];
};
type BoxerCopyEvalCaseInput = BoxerEvalTarget | {
    target?: BoxerEvalTarget | null;
    label?: string;
    target_label?: string;
    reuse_target?: boolean;
    copy_clipboard?: boolean;
    save_local?: boolean;
} | null;
type BoxerFusionEvalCase = {
    id?: string;
    captured_at?: string;
    fixture_index?: number;
    camera: CameraDebugState;
    frame?: { image_width?: number; image_height?: number };
    prompt?: BoxerEvalPrompt;
    target?: BoxerEvalTarget | null;
};
type BoxerFusionOptions = {
    source?: 'target_box' | 'click_cluster' | 'brush_support';
    min_views?: number;
    front_surface?: boolean;
    pad_scale?: number;
    quantile_low?: number;
    quantile_high?: number;
    scorable_support_only?: boolean;
    capture_view_images?: boolean;
};
type Aabb = { min: [number, number, number]; max: [number, number, number] };

const isBoxerEvalTarget = (value: unknown): value is BoxerEvalTarget => {
    const target = value as BoxerEvalTarget | null | undefined;
    return !!target &&
        target.type === 'axis_aligned_box' &&
        Array.isArray(target.center) &&
        target.center.length === 3 &&
        Array.isArray(target.dimensions) &&
        target.dimensions.length === 3 &&
        Array.isArray(target.rotation);
};

const cloneEvalTarget = (target: BoxerEvalTarget): BoxerEvalTarget => ({
    type: 'axis_aligned_box',
    center: [...target.center] as [number, number, number],
    dimensions: [...target.dimensions] as [number, number, number],
    rotation: target.rotation.map(row => [...row])
});

type DirectLiftProposal = {
    id: string;
    bb2d: NormalizedBb2d;
    score2d: number;
    source: 'fixed-click' | 'splat-cluster' | 'sam3-mask' | 'manual';
    sam3Region?: Sam3MaskRegion;
};
type DirectLiftProposalBuild = {
    proposals: DirectLiftProposal[];
    debug: {
        fixed_count: number;
        splat_cluster?: {
            candidate_count: number;
            front_surface_candidate_count: number;
            cluster_count: number;
            bb2d?: NormalizedBb2d;
            skipped_reason?: string;
        };
        sam3?: Sam3MaskDebug;
        final_count: number;
        sources: Record<string, number>;
    };
};
type CameraDebugState = {
    position?: { x: number; y: number; z: number };
    target?: { x: number; y: number; z: number };
    fov?: number;
    azim?: number;
    elevation?: number;
    ortho?: boolean;
};
type SplatWorldCenterCache = {
    sourceCenters: Float32Array;
    worldTransform: number[];
    worldCenters: Float32Array;
    count: number;
    lastBuildMs: number;
    lastAccessBuildMs: number;
    reused: boolean;
};
type DepthVisibilitySpatialGrid = {
    cellSize: number;
    cells: Map<number, Uint32Array>;
    boundsMin: [number, number, number];
    boundsMax: [number, number, number];
    buildMs: number;
};
type DepthVisibilityViewCache = {
    key: string;
    imageWidth: number;
    imageHeight: number;
    tileSizePx: number;
    tileWidth: number;
    tileHeight: number;
    pixelX: Float32Array;
    pixelY: Float32Array;
    depth: Float32Array;
    inFrame: Uint8Array;
    layerClass: Uint8Array;
    tileIndex: Int32Array;
    nearestDepth: Float32Array;
    secondDepth: Float32Array;
    farDepth: Float32Array;
    visibleCount: Uint16Array;
    totalCount: Uint16Array;
    screenBuckets: Uint32Array[];
    buildMs: number;
    reused: boolean;
};
type DepthVisibilityIndex = {
    sourceCenters: Float32Array;
    worldTransform: number[];
    pointCount: number;
    spatialGrid: DepthVisibilitySpatialGrid;
    viewCaches: Map<string, DepthVisibilityViewCache>;
    lastBuildMs: number;
    reused: boolean;
};

const splatWorldCenterCaches = new WeakMap<Splat, SplatWorldCenterCache>();
const splatDepthVisibilityIndexes = new WeakMap<Splat, DepthVisibilityIndex>();

const matrixEquals = (a: number[], b: Float32Array): boolean => {
    if (a.length !== 16 || b.length < 16) return false;
    for (let i = 0; i < 16; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
};

const getSplatWorldCenterCache = (splat: Splat): SplatWorldCenterCache | null => {
    const sorter: any = splat.entity.gsplat?.instance?.sorter;
    if (!sorter?.centers) return null;

    const sourceCenters = sorter.centers as Float32Array;
    const wm = splat.entity.getWorldTransform().data as Float32Array;
    const existing = splatWorldCenterCaches.get(splat);
    if (existing?.sourceCenters === sourceCenters && matrixEquals(existing.worldTransform, wm)) {
        existing.reused = true;
        existing.lastAccessBuildMs = 0;
        return existing;
    }

    const t0 = performance.now();
    const count = sourceCenters.length / 3;
    const worldCenters = new Float32Array(sourceCenters.length);
    for (let i = 0; i < count; i++) {
        const lx = sourceCenters[i * 3];
        const ly = sourceCenters[i * 3 + 1];
        const lz = sourceCenters[i * 3 + 2];
        worldCenters[i * 3] = wm[0] * lx + wm[4] * ly + wm[8] * lz + wm[12];
        worldCenters[i * 3 + 1] = wm[1] * lx + wm[5] * ly + wm[9] * lz + wm[13];
        worldCenters[i * 3 + 2] = wm[2] * lx + wm[6] * ly + wm[10] * lz + wm[14];
    }

    const buildMs = performance.now() - t0;
    const cache = {
        sourceCenters,
        worldTransform: Array.from(wm.slice(0, 16)),
        worldCenters,
        count,
        lastBuildMs: buildMs,
        lastAccessBuildMs: buildMs,
        reused: false
    };
    splatWorldCenterCaches.set(splat, cache);
    return cache;
};

const hashGridCell = (ix: number, iy: number, iz: number) => (ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791);

const buildDepthVisibilitySpatialGrid = (cache: SplatWorldCenterCache): DepthVisibilitySpatialGrid => {
    const t0 = performance.now();
    const centers = cache.worldCenters;
    const boundsMin: [number, number, number] = [Infinity, Infinity, Infinity];
    const boundsMax: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < cache.count; i++) {
        const x = centers[i * 3];
        const y = centers[i * 3 + 1];
        const z = centers[i * 3 + 2];
        if (x < boundsMin[0]) boundsMin[0] = x;
        if (y < boundsMin[1]) boundsMin[1] = y;
        if (z < boundsMin[2]) boundsMin[2] = z;
        if (x > boundsMax[0]) boundsMax[0] = x;
        if (y > boundsMax[1]) boundsMax[1] = y;
        if (z > boundsMax[2]) boundsMax[2] = z;
    }

    const dx = boundsMax[0] - boundsMin[0];
    const dy = boundsMax[1] - boundsMin[1];
    const dz = boundsMax[2] - boundsMin[2];
    const diagonal = Math.max(1, Math.hypot(dx, dy, dz));
    const cellSize = Math.max(0.08, diagonal / 180);
    const inv = 1 / cellSize;
    const pending = new Map<number, number[]>();
    for (let i = 0; i < cache.count; i++) {
        const ix = Math.floor((centers[i * 3] - boundsMin[0]) * inv) | 0;
        const iy = Math.floor((centers[i * 3 + 1] - boundsMin[1]) * inv) | 0;
        const iz = Math.floor((centers[i * 3 + 2] - boundsMin[2]) * inv) | 0;
        const key = hashGridCell(ix, iy, iz);
        const bucket = pending.get(key);
        if (bucket) {
            bucket.push(i);
        } else {
            pending.set(key, [i]);
        }
    }

    const cells = new Map<number, Uint32Array>();
    pending.forEach((bucket, key) => cells.set(key, Uint32Array.from(bucket)));
    return {
        cellSize,
        cells,
        boundsMin,
        boundsMax,
        buildMs: performance.now() - t0
    };
};

const getDepthVisibilityIndex = (splat: Splat): DepthVisibilityIndex | null => {
    const geometry = getSplatWorldCenterCache(splat);
    if (!geometry) return null;

    const existing = splatDepthVisibilityIndexes.get(splat);
    if (
        existing?.sourceCenters === geometry.sourceCenters &&
        existing.pointCount === geometry.count &&
        existing.worldTransform.length === geometry.worldTransform.length &&
        existing.worldTransform.every((value, index) => value === geometry.worldTransform[index])
    ) {
        existing.reused = true;
        return existing;
    }

    const spatialGrid = buildDepthVisibilitySpatialGrid(geometry);
    const index: DepthVisibilityIndex = {
        sourceCenters: geometry.sourceCenters,
        worldTransform: geometry.worldTransform.slice(),
        pointCount: geometry.count,
        spatialGrid,
        viewCaches: new Map(),
        lastBuildMs: spatialGrid.buildMs,
        reused: false
    };
    splatDepthVisibilityIndexes.set(splat, index);
    return index;
};

const roundedKeyValue = (value: number, scale = 1000) => Math.round(value * scale) / scale;

const buildDepthVisibilityViewKey = (
    scene: Scene,
    intrinsics: Intrinsics,
    imageWidth: number,
    imageHeight: number
) => {
    const view = scene.camera.camera.viewMatrix.data as Float32Array;
    const viewKey = Array.from(view.slice(0, 16), value => roundedKeyValue(value, 10000)).join(',');
    return [
        imageWidth,
        imageHeight,
        roundedKeyValue(intrinsics.fx),
        roundedKeyValue(intrinsics.fy),
        roundedKeyValue(intrinsics.cx),
        roundedKeyValue(intrinsics.cy),
        viewKey
    ].join('|');
};

const getDepthVisibilityViewCache = (
    splat: Splat,
    scene: Scene,
    intrinsics: Intrinsics,
    imageWidth: number,
    imageHeight: number
): DepthVisibilityViewCache | null => {
    const index = getDepthVisibilityIndex(splat);
    const geometry = getSplatWorldCenterCache(splat);
    if (!index || !geometry) return null;

    const key = buildDepthVisibilityViewKey(scene, intrinsics, imageWidth, imageHeight);
    const existing = index.viewCaches.get(key);
    if (existing) {
        existing.reused = true;
        return existing;
    }

    const t0 = performance.now();
    const centers = geometry.worldCenters;
    const count = geometry.count;
    const view = scene.camera.camera.viewMatrix.data as Float32Array;
    const tileSizePx = MASK_OCCLUSION_CELL_PX;
    const tileWidth = Math.ceil(imageWidth / tileSizePx);
    const tileHeight = Math.ceil(imageHeight / tileSizePx);
    const tileCount = tileWidth * tileHeight;
    const pixelX = new Float32Array(count);
    const pixelY = new Float32Array(count);
    const depth = new Float32Array(count);
    const inFrame = new Uint8Array(count);
    const layerClass = new Uint8Array(count);
    const tileIndex = new Int32Array(count);
    tileIndex.fill(-1);
    const nearestDepth = new Float32Array(tileCount);
    const secondDepth = new Float32Array(tileCount);
    const farDepth = new Float32Array(tileCount);
    const visibleCount = new Uint16Array(tileCount);
    const totalCount = new Uint16Array(tileCount);
    const pendingScreenBuckets: number[][] = Array.from({ length: tileCount }, (): number[] => []);
    nearestDepth.fill(Infinity);
    secondDepth.fill(Infinity);

    for (let i = 0; i < count; i++) {
        const wx = centers[i * 3];
        const wy = centers[i * 3 + 1];
        const wz = centers[i * 3 + 2];
        const ogX = view[0] * wx + view[4] * wy + view[8]  * wz + view[12];
        const ogY = view[1] * wx + view[5] * wy + view[9]  * wz + view[13];
        const ogZ = view[2] * wx + view[6] * wy + view[10] * wz + view[14];
        const cvZ = -ogZ;
        depth[i] = cvZ;
        if (cvZ <= 0) continue;

        const u = intrinsics.fx * ogX / cvZ + intrinsics.cx;
        const v = intrinsics.fy * (-ogY) / cvZ + intrinsics.cy;
        pixelX[i] = u;
        pixelY[i] = v;
        if (u < 0 || u >= imageWidth || v < 0 || v >= imageHeight) continue;

        inFrame[i] = 1;
        const tx = Math.min(tileWidth - 1, Math.max(0, Math.floor(u / tileSizePx)));
        const ty = Math.min(tileHeight - 1, Math.max(0, Math.floor(v / tileSizePx)));
        const tid = ty * tileWidth + tx;
        tileIndex[i] = tid;
        pendingScreenBuckets[tid].push(i);
        if (totalCount[tid] < 65535) totalCount[tid]++;
        if (cvZ > farDepth[tid]) farDepth[tid] = cvZ;
        if (cvZ < nearestDepth[tid]) {
            secondDepth[tid] = nearestDepth[tid];
            nearestDepth[tid] = cvZ;
        } else if (cvZ < secondDepth[tid]) {
            secondDepth[tid] = cvZ;
        }
    }

    for (let i = 0; i < count; i++) {
        if (!inFrame[i]) continue;
        const tid = tileIndex[i];
        const nearest = nearestDepth[tid];
        if (!isFinite(nearest)) continue;
        const nearTolerance = Math.min(MASK_OCCLUSION_MAX_M, Math.max(MASK_OCCLUSION_MIN_M, nearest * MASK_OCCLUSION_FRAC_OF_DEPTH));
        const supportTolerance = Math.max(0.08, nearest * 0.045);
        const d = depth[i];
        if (d <= nearest + nearTolerance) {
            layerClass[i] = 1;
            if (visibleCount[tid] < 65535) visibleCount[tid]++;
        } else if (d <= nearest + supportTolerance) {
            layerClass[i] = 2;
        } else {
            layerClass[i] = 3;
        }
    }

    const cache: DepthVisibilityViewCache = {
        key,
        imageWidth,
        imageHeight,
        tileSizePx,
        tileWidth,
        tileHeight,
        pixelX,
        pixelY,
        depth,
        inFrame,
        layerClass,
        tileIndex,
        nearestDepth,
        secondDepth,
        farDepth,
        visibleCount,
        totalCount,
        screenBuckets: pendingScreenBuckets.map(bucket => Uint32Array.from(bucket)),
        buildMs: performance.now() - t0,
        reused: false
    };

    if (index.viewCaches.size >= 3) {
        const oldest = index.viewCaches.keys().next().value;
        if (oldest) index.viewCaches.delete(oldest);
    }
    index.viewCaches.set(key, cache);
    return cache;
};

const renderSplatDepth = (
    splat: Splat,
    scene: Scene,
    imageWidth: number,
    imageHeight: number,
    intrinsics: Intrinsics
): DepthBuffer => {
    // ~1/3 resolution preserves aspect; each Boxer 16-px patch still gets
    // dozens of depth samples for the per-patch median.
    const scale = 1 / 3;
    const width = Math.max(2, Math.round(imageWidth * scale));
    const height = Math.max(2, Math.round(imageHeight * scale));
    const fx = intrinsics.fx * (width / imageWidth);
    const fy = intrinsics.fy * (height / imageHeight);
    const cx = intrinsics.cx * (width / imageWidth);
    const cy = intrinsics.cy * (height / imageHeight);

    const cache = getSplatWorldCenterCache(splat);
    if (!cache) {
        return { data: new Float32Array(width * height), width, height };
    }
    const centers = cache.worldCenters;
    const v = scene.camera.camera.viewMatrix.data as Float32Array;

    const depth = new Float32Array(width * height);
    const INF = Number.POSITIVE_INFINITY;
    for (let i = 0; i < depth.length; i++) depth[i] = INF;

    const viewCache = getDepthVisibilityViewCache(splat, scene, intrinsics, imageWidth, imageHeight);
    if (viewCache) {
        for (let i = 0; i < viewCache.depth.length; i++) {
            if (!viewCache.inFrame[i]) continue;
            const u = Math.round(viewCache.pixelX[i] * (width / imageWidth));
            const vp = Math.round(viewCache.pixelY[i] * (height / imageHeight));
            if (u < 0 || u >= width || vp < 0 || vp >= height) continue;
            const idx = vp * width + u;
            const cvZ = viewCache.depth[i];
            if (cvZ > 0 && cvZ < depth[idx]) depth[idx] = cvZ;
        }

        for (let i = 0; i < depth.length; i++) if (!isFinite(depth[i])) depth[i] = 0;
        return { data: depth, width, height };
    }

    const n = cache.count;
    for (let i = 0; i < n; i++) {
        const wx = centers[i * 3];
        const wy = centers[i * 3 + 1];
        const wz = centers[i * 3 + 2];
        // world → OpenGL camera (viewMatrix is column-major)
        const ogX = v[0] * wx + v[4] * wy + v[8]  * wz + v[12];
        const ogY = v[1] * wx + v[5] * wy + v[9]  * wz + v[13];
        const ogZ = v[2] * wx + v[6] * wy + v[10] * wz + v[14];
        // OpenGL → OpenCV: negate Y, Z in camera frame
        const cvX = ogX;
        const cvY = -ogY;
        const cvZ = -ogZ;
        if (cvZ <= 0) continue; // behind camera
        // pinhole projection in OpenCV convention
        const u = Math.round(fx * cvX / cvZ + cx);
        const vp = Math.round(fy * cvY / cvZ + cy);
        if (u < 0 || u >= width || vp < 0 || vp >= height) continue;
        const idx = vp * width + u;
        if (cvZ < depth[idx]) depth[idx] = cvZ;
    }

    // 0 marks invalid for the backend (sdp_from_depth filters zz > 0).
    for (let i = 0; i < depth.length; i++) if (!isFinite(depth[i])) depth[i] = 0;

    return { data: depth, width, height };
};

const downsampleDepthMin = (depth: DepthBuffer, width: number, height: number): DepthBuffer => {
    if (depth.width === width && depth.height === height) {
        return depth;
    }

    const out = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
        const y0 = Math.floor(y * depth.height / height);
        const y1 = Math.max(y0 + 1, Math.ceil((y + 1) * depth.height / height));
        for (let x = 0; x < width; x++) {
            const x0 = Math.floor(x * depth.width / width);
            const x1 = Math.max(x0 + 1, Math.ceil((x + 1) * depth.width / width));
            let best = Number.POSITIVE_INFINITY;

            for (let yy = y0; yy < y1; yy++) {
                for (let xx = x0; xx < x1; xx++) {
                    const value = depth.data[yy * depth.width + xx];
                    if (value > 0 && value < best) best = value;
                }
            }

            out[y * width + x] = isFinite(best) ? best : 0;
        }
    }

    return { data: out, width, height };
};

const renderGpuSplatDepth = async (
    splat: Splat,
    scene: Scene,
    imageWidth: number,
    imageHeight: number
): Promise<DepthBuffer | null> => {
    let depthRect: DepthBuffer | null = null;
    try {
        depthRect = await scene.camera.splatDepthRect(splat, 0, 0, 1, 1);
    } catch (err) {
        console.warn('[Boxer] GPU splat depth failed', err);
    }
    if (!depthRect) return null;

    return downsampleDepthMin(
        depthRect,
        Math.max(2, Math.round(imageWidth / 3)),
        Math.max(2, Math.round(imageHeight / 3))
    );
};

const buildSdpPatchDepths = (depth: DepthBuffer) => {
    const gridWidth = BOXER_MODEL_HW / BOXER_PATCH_SIZE;
    const gridHeight = BOXER_MODEL_HW / BOXER_PATCH_SIZE;
    const patchDepths: number[][] = Array.from({ length: gridWidth * gridHeight }, (): number[] => []);
    const scaleX = BOXER_MODEL_HW / depth.width;
    const scaleY = BOXER_MODEL_HW / depth.height;

    for (let y = 0; y < depth.height; y++) {
        for (let x = 0; x < depth.width; x++) {
            const value = depth.data[y * depth.width + x];
            if (value <= 0) continue;

            const patchX = Math.min(gridWidth - 1, Math.max(0, Math.floor((x * scaleX) / BOXER_PATCH_SIZE)));
            const patchY = Math.min(gridHeight - 1, Math.max(0, Math.floor((y * scaleY) / BOXER_PATCH_SIZE)));
            patchDepths[patchY * gridWidth + patchX].push(value);
        }
    }

    const out = new Float32Array(gridWidth * gridHeight);
    let valid = 0;
    for (let i = 0; i < patchDepths.length; i++) {
        const values = patchDepths[i];
        if (!values.length) {
            out[i] = -1;
            continue;
        }

        values.sort((a, b) => a - b);
        out[i] = values[Math.floor(values.length / 2)];
        valid++;
    }

    return {
        data: out,
        width: gridWidth,
        height: gridHeight,
        valid
    };
};

const buildBoxerImagePreprocess = (
    imageWidth: number,
    imageHeight: number,
    intrinsics: Intrinsics
): BoxerFramePayload['image_preprocess'] => {
    const size = Math.min(imageWidth, imageHeight);
    const x = (imageWidth - size) / 2;
    const y = (imageHeight - size) / 2;
    const scale = BOXER_MODEL_HW / size;

    return {
        source: 'viewer-full-frame',
        model_size: BOXER_MODEL_HW,
        square_crop: {
            x,
            y,
            size,
            scale
        },
        intrinsics_960_square: {
            fx: intrinsics.fx * scale,
            fy: intrinsics.fy * scale,
            cx: (intrinsics.cx - x) * scale,
            cy: (intrinsics.cy - y) * scale,
            width: BOXER_MODEL_HW,
            height: BOXER_MODEL_HW
        }
    };
};

// Subsample splat world-space centers inside the current view frustum. Sent
// alongside the depth map so BoxerNet's sdp_w has both per-pixel surface depth
// (from the z-buffer) and sparse interior/occluded points (from the splat cloud).
const sampleSplatCentersInFrustum = (
    splat: Splat,
    scene: Scene,
    target = MAX_SDP_POINTS
): number[][] => {
    const cache = getSplatWorldCenterCache(splat);
    if (!cache) return [];
    const centers = cache.worldCenters;

    const cam = scene.camera.camera;
    const p = cam.projectionMatrix.data as Float32Array;
    const v = cam.viewMatrix.data as Float32Array;
    const vp = new Float32Array(16);
    for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
            vp[i + j * 4] =
                p[i]      * v[j * 4] +
                p[i + 4]  * v[j * 4 + 1] +
                p[i + 8]  * v[j * 4 + 2] +
                p[i + 12] * v[j * 4 + 3];
        }
    }

    const n = cache.count;
    const kept: number[][] = [];
    for (let i = 0; i < n; i++) {
        const wx = centers[i * 3];
        const wy = centers[i * 3 + 1];
        const wz = centers[i * 3 + 2];
        const cx = vp[0] * wx + vp[4] * wy + vp[8]  * wz + vp[12];
        const cy = vp[1] * wx + vp[5] * wy + vp[9]  * wz + vp[13];
        const cw = vp[3] * wx + vp[7] * wy + vp[11] * wz + vp[15];
        if (cw <= 0) continue;
        const ndcX = cx / cw, ndcY = cy / cw;
        if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) continue;
        kept.push([wx, wy, wz]);
    }
    if (kept.length <= target) return kept;
    const stride = kept.length / target;
    const out: number[][] = new Array(target);
    for (let i = 0; i < target; i++) out[i] = kept[Math.floor(i * stride)];
    return out;
};

const sampleSplatSurfacePoints = (
    splat: Splat,
    scene: Scene,
    imageWidth: number,
    imageHeight: number,
    intrinsics: Intrinsics,
    depth: DepthBuffer,
    target = MAX_SDP_POINTS
): number[][] => {
    const cache = getSplatWorldCenterCache(splat);
    if (!cache) return [];
    const centers = cache.worldCenters;
    const view = scene.camera.camera.viewMatrix.data as Float32Array;

    const fx = intrinsics.fx * (depth.width / imageWidth);
    const fy = intrinsics.fy * (depth.height / imageHeight);
    const cx = intrinsics.cx * (depth.width / imageWidth);
    const cy = intrinsics.cy * (depth.height / imageHeight);

    const kept: number[][] = [];
    const count = cache.count;
    for (let i = 0; i < count; i++) {
        const wx = centers[i * 3];
        const wy = centers[i * 3 + 1];
        const wz = centers[i * 3 + 2];

        const ogX = view[0] * wx + view[4] * wy + view[8]  * wz + view[12];
        const ogY = view[1] * wx + view[5] * wy + view[9]  * wz + view[13];
        const ogZ = view[2] * wx + view[6] * wy + view[10] * wz + view[14];
        const cvX = ogX;
        const cvY = -ogY;
        const cvZ = -ogZ;
        if (cvZ <= 0) continue;

        const u = Math.round(fx * cvX / cvZ + cx);
        const v = Math.round(fy * cvY / cvZ + cy);
        if (u < 0 || u >= depth.width || v < 0 || v >= depth.height) continue;

        const nearest = depth.data[v * depth.width + u];
        if (nearest <= 0) continue;

        const tolerance = Math.max(0.04, nearest * 0.015);
        if (cvZ > nearest + tolerance) continue;

        kept.push([wx, wy, wz]);
    }

    if (kept.length <= target) return kept;
    const stride = kept.length / target;
    const out: number[][] = new Array(target);
    for (let i = 0; i < target; i++) out[i] = kept[Math.floor(i * stride)];
    return out;
};

const float32ToBase64 = (arr: Float32Array): string => {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
    }
    return btoa(binary);
};

const summarizeDepth = (depth: DepthBuffer) => {
    let valid = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = 0;
    for (let i = 0; i < depth.data.length; i++) {
        const d = depth.data[i];
        if (d <= 0) continue;
        valid++;
        if (d < min) min = d;
        if (d > max) max = d;
    }
    return {
        valid,
        ratio: depth.data.length > 0 ? valid / depth.data.length : 0,
        min: valid > 0 ? min : 0,
        max: valid > 0 ? max : 0
    };
};

const cloneObb = <T extends OBBResult>(obb: T): T => JSON.parse(JSON.stringify(obb)) as T;

const projectWorldPointToImage = (
    point: number[],
    scene: Scene,
    intrinsics: Intrinsics
): ProjectionSample => {
    const view = scene.camera.camera.viewMatrix.data as Float32Array;
    const wx = point[0];
    const wy = point[1];
    const wz = point[2];
    const ogX = view[0] * wx + view[4] * wy + view[8]  * wz + view[12];
    const ogY = view[1] * wx + view[5] * wy + view[9]  * wz + view[13];
    const ogZ = view[2] * wx + view[6] * wy + view[10] * wz + view[14];
    const cvX = ogX;
    const cvY = -ogY;
    const cvZ = -ogZ;
    if (cvZ <= 0) {
        return {
            world: [wx, wy, wz],
            pixel: [Number.NaN, Number.NaN],
            depth: cvZ,
            in_frame: false
        };
    }

    const u = intrinsics.fx * cvX / cvZ + intrinsics.cx;
    const v = intrinsics.fy * cvY / cvZ + intrinsics.cy;
    return {
        world: [wx, wy, wz],
        pixel: [u, v],
        depth: cvZ,
        in_frame: u >= 0 && u < intrinsics.width && v >= 0 && v < intrinsics.height
    };
};

const buildProjectionSamples = (
    points: number[][],
    scene: Scene,
    intrinsics: Intrinsics
): ProjectionSample[] => {
    if (points.length === 0) return [];
    const stride = Math.max(1, Math.floor(points.length / PROJECTION_SAMPLE_COUNT));
    const samples: ProjectionSample[] = [];
    for (let i = 0; i < points.length && samples.length < PROJECTION_SAMPLE_COUNT; i += stride) {
        samples.push(projectWorldPointToImage(points[i], scene, intrinsics));
    }
    return samples;
};

const collectProjectedSplatCandidates = (
    splat: Splat,
    scene: Scene,
    intrinsics: Intrinsics,
    bb: NormalizedBb2d
): ProjectedSplatCandidate[] => {
    const viewCache = getDepthVisibilityViewCache(splat, scene, intrinsics, intrinsics.width, intrinsics.height);
    const geometryCache = getSplatWorldCenterCache(splat);
    if (viewCache && geometryCache) {
        const centers = geometryCache.worldCenters;
        const candidates: ProjectedSplatCandidate[] = [];
        const minTileX = Math.max(0, Math.floor(Math.max(0, bb[0]) / viewCache.tileSizePx));
        const maxTileX = Math.min(viewCache.tileWidth - 1, Math.floor(Math.min(viewCache.imageWidth - 1, bb[2]) / viewCache.tileSizePx));
        const minTileY = Math.max(0, Math.floor(Math.max(0, bb[1]) / viewCache.tileSizePx));
        const maxTileY = Math.min(viewCache.tileHeight - 1, Math.floor(Math.min(viewCache.imageHeight - 1, bb[3]) / viewCache.tileSizePx));
        if (maxTileX < minTileX || maxTileY < minTileY) return [];

        for (let ty = minTileY; ty <= maxTileY; ty++) {
            for (let tx = minTileX; tx <= maxTileX; tx++) {
                const bucket = viewCache.screenBuckets[ty * viewCache.tileWidth + tx];
                for (let j = 0; j < bucket.length; j++) {
                    const i = bucket[j];
                    const u = viewCache.pixelX[i];
                    const v = viewCache.pixelY[i];
                    if (u < bb[0] || u > bb[2] || v < bb[1] || v > bb[3]) continue;
                    const wx = centers[i * 3];
                    const wy = centers[i * 3 + 1];
                    const wz = centers[i * 3 + 2];
                    candidates.push({
                        point: [wx, wy, wz],
                        splatIndex: i,
                        world: [wx, wy, wz],
                        pixel: [u, v],
                        depth: viewCache.depth[i],
                        in_frame: true,
                        layer_class: viewCache.layerClass[i] as 0 | 1 | 2 | 3,
                        tile_index: viewCache.tileIndex[i]
                    });
                }
            }
        }

        return candidates;
    }

    const cache = getSplatWorldCenterCache(splat);
    if (!cache) return [];
    const centers = cache.worldCenters;
    const view = scene.camera.camera.viewMatrix.data as Float32Array;
    const candidates: ProjectedSplatCandidate[] = [];
    const count = cache.count;

    for (let i = 0; i < count; i++) {
        const wx = centers[i * 3];
        const wy = centers[i * 3 + 1];
        const wz = centers[i * 3 + 2];
        const ogX = view[0] * wx + view[4] * wy + view[8]  * wz + view[12];
        const ogY = view[1] * wx + view[5] * wy + view[9]  * wz + view[13];
        const ogZ = view[2] * wx + view[6] * wy + view[10] * wz + view[14];
        const cvZ = -ogZ;
        if (cvZ <= 0) continue;

        const u = intrinsics.fx * ogX / cvZ + intrinsics.cx;
        const v = intrinsics.fy * (-ogY) / cvZ + intrinsics.cy;
        if (u < bb[0] || u > bb[2] || v < bb[1] || v > bb[3]) continue;
        candidates.push({
            point: [wx, wy, wz],
            splatIndex: i,
            world: [wx, wy, wz],
            pixel: [u, v],
            depth: cvZ,
            in_frame: u >= 0 && u < intrinsics.width && v >= 0 && v < intrinsics.height
        });
    }

    return candidates;
};

const findProjectedSeed = (
    candidates: ProjectedSplatCandidate[],
    clickX: number,
    clickY: number,
    clickDepth: number
) => {
    let best = -1;
    let bestScore = Number.POSITIVE_INFINITY;
    const depthNorm = Math.max(1, clickDepth);

    for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        const pixelDist = Math.hypot(candidate.pixel[0] - clickX, candidate.pixel[1] - clickY);
        const depthDist = clickDepth > 0 ? Math.abs(candidate.depth - clickDepth) / depthNorm * 120 : 0;
        const score = pixelDist + depthDist;
        if (score < bestScore) {
            bestScore = score;
            best = i;
        }
    }

    return best;
};

const sampleSam3BrushPoints = (
    brush: BoxerBrushPrompt | undefined,
    fallback: [number, number],
    maxPoints = 16
): [number, number][] => {
    const points = brush?.points?.length ? brush.points : [];
    const deduped: [number, number][] = [];
    const seen = new Set<string>();
    const addPoint = (point: [number, number]) => {
        const rounded: [number, number] = [Math.round(point[0]), Math.round(point[1])];
        const key = `${rounded[0]},${rounded[1]}`;
        if (seen.has(key)) return;
        seen.add(key);
        deduped.push(rounded);
    };

    addPoint(fallback);
    if (points.length) {
        const slots = Math.max(1, maxPoints - deduped.length);
        const step = Math.max(1, Math.floor(points.length / slots));
        for (let i = 0; i < points.length && deduped.length < maxPoints; i += step) {
            addPoint(points[i]);
        }
        addPoint(points[points.length - 1]);
    }

    return deduped.slice(0, maxPoints);
};

const buildCandidateHash = (candidates: ProjectedSplatCandidate[], eps: number) => {
    const cells = new Map<number, number[]>();
    const inv = 1 / eps;
    for (let i = 0; i < candidates.length; i++) {
        const point = candidates[i].point;
        const ix = Math.floor(point[0] * inv) | 0;
        const iy = Math.floor(point[1] * inv) | 0;
        const iz = Math.floor(point[2] * inv) | 0;
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

const growProjectedCluster = (
    candidates: ProjectedSplatCandidate[],
    seed: number,
    eps: number,
    maxDepthDelta: number
) => {
    const cells = buildCandidateHash(candidates, eps);
    const visited = new Uint8Array(candidates.length);
    const queue = [seed];
    const kept: ProjectedSplatCandidate[] = [];
    const seedDepth = candidates[seed].depth;
    const inv = 1 / eps;
    const eps2 = eps * eps;
    visited[seed] = 1;

    while (queue.length > 0) {
        const index = queue.pop()!;
        const candidate = candidates[index];
        kept.push(candidate);
        const point = candidate.point;
        const ix = Math.floor(point[0] * inv) | 0;
        const iy = Math.floor(point[1] * inv) | 0;
        const iz = Math.floor(point[2] * inv) | 0;

        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dz = -1; dz <= 1; dz++) {
                    const key = ((ix + dx) * 73856093) ^ ((iy + dy) * 19349663) ^ ((iz + dz) * 83492791);
                    const bucket = cells.get(key);
                    if (!bucket) continue;

                    for (const next of bucket) {
                        if (visited[next]) continue;
                        const other = candidates[next];
                        if (Math.abs(other.depth - seedDepth) > maxDepthDelta) continue;
                        const otherPoint = other.point;
                        const ddx = point[0] - otherPoint[0];
                        const ddy = point[1] - otherPoint[1];
                        const ddz = point[2] - otherPoint[2];
                        if (ddx * ddx + ddy * ddy + ddz * ddz > eps2) continue;
                        visited[next] = 1;
                        queue.push(next);
                    }
                }
            }
        }
    }

    return kept;
};

const growProjectedKnnCluster = (
    candidates: ProjectedSplatCandidate[],
    seed: number,
    options: {
        k: number;
        cellSize: number;
        maxSpatialDistance: number;
        maxPixelDistance: number;
        maxSeedDepthDelta: number;
        maxNeighborDepthDelta: number;
        maxPoints: number;
    }
) => {
    if (seed < 0 || seed >= candidates.length) return [] as ProjectedSplatCandidate[];

    const cells = buildCandidateHash(candidates, options.cellSize);
    const visited = new Uint8Array(candidates.length);
    const queue = [seed];
    const kept: ProjectedSplatCandidate[] = [];
    const seedDepth = candidates[seed].depth;
    const inv = 1 / options.cellSize;
    const maxSpatial2 = options.maxSpatialDistance * options.maxSpatialDistance;
    const neighborRadius = Math.max(1, Math.ceil(options.maxSpatialDistance / options.cellSize));
    visited[seed] = 1;

    while (queue.length > 0 && kept.length < options.maxPoints) {
        const index = queue.shift()!;
        const candidate = candidates[index];
        kept.push(candidate);
        const point = candidate.point;
        const ix = Math.floor(point[0] * inv) | 0;
        const iy = Math.floor(point[1] * inv) | 0;
        const iz = Math.floor(point[2] * inv) | 0;
        const neighbors: { index: number; score: number }[] = [];

        for (let dx = -neighborRadius; dx <= neighborRadius; dx++) {
            for (let dy = -neighborRadius; dy <= neighborRadius; dy++) {
                for (let dz = -neighborRadius; dz <= neighborRadius; dz++) {
                    const key = ((ix + dx) * 73856093) ^ ((iy + dy) * 19349663) ^ ((iz + dz) * 83492791);
                    const bucket = cells.get(key);
                    if (!bucket) continue;

                    for (const next of bucket) {
                        if (visited[next]) continue;
                        const other = candidates[next];
                        const seedDepthDelta = Math.abs(other.depth - seedDepth);
                        if (seedDepthDelta > options.maxSeedDepthDelta) continue;

                        const neighborDepthDelta = Math.abs(other.depth - candidate.depth);
                        if (neighborDepthDelta > options.maxNeighborDepthDelta) continue;

                        const otherPoint = other.point;
                        const ddx = point[0] - otherPoint[0];
                        const ddy = point[1] - otherPoint[1];
                        const ddz = point[2] - otherPoint[2];
                        const spatial2 = ddx * ddx + ddy * ddy + ddz * ddz;
                        if (spatial2 > maxSpatial2) continue;

                        const pixelDistance = Math.hypot(
                            candidate.pixel[0] - other.pixel[0],
                            candidate.pixel[1] - other.pixel[1]
                        );
                        if (pixelDistance > options.maxPixelDistance) continue;

                        neighbors.push({
                            index: next,
                            score:
                                Math.sqrt(spatial2) / Math.max(1e-6, options.maxSpatialDistance) +
                                pixelDistance / Math.max(1, options.maxPixelDistance) * 0.45 +
                                seedDepthDelta / Math.max(1e-6, options.maxSeedDepthDelta) * 0.55 +
                                neighborDepthDelta / Math.max(1e-6, options.maxNeighborDepthDelta) * 0.8
                        });
                    }
                }
            }
        }

        neighbors.sort((a, b) => a.score - b.score);
        for (let i = 0; i < Math.min(options.k, neighbors.length); i++) {
            const next = neighbors[i].index;
            visited[next] = 1;
            queue.push(next);
        }
    }

    return kept;
};

const collectProjectedComponents = (
    candidates: ProjectedSplatCandidate[],
    options: {
        cellSize: number;
        maxSpatialDistance: number;
        maxSeedDepthDelta: number;
        maxNeighborDepthDelta: number;
        maxPixelDistance: number;
        minPoints: number;
        maxComponents: number;
        maxPointsPerComponent: number;
    }
) => {
    if (candidates.length === 0) return [] as ProjectedSplatCandidate[][];

    const cells = buildCandidateHash(candidates, options.cellSize);
    const assigned = new Uint8Array(candidates.length);
    const inv = 1 / options.cellSize;
    const maxSpatial2 = options.maxSpatialDistance * options.maxSpatialDistance;
    const neighborRadius = Math.max(1, Math.ceil(options.maxSpatialDistance / options.cellSize));
    const components: ProjectedSplatCandidate[][] = [];

    for (let seed = 0; seed < candidates.length; seed++) {
        if (assigned[seed]) continue;

        const seedCandidate = candidates[seed];
        const seedDepth = seedCandidate.depth;
        const queue = [seed];
        const component: ProjectedSplatCandidate[] = [];
        assigned[seed] = 1;

        while (queue.length > 0 && component.length < options.maxPointsPerComponent) {
            const index = queue.pop()!;
            const candidate = candidates[index];
            component.push(candidate);
            const point = candidate.point;
            const ix = Math.floor(point[0] * inv) | 0;
            const iy = Math.floor(point[1] * inv) | 0;
            const iz = Math.floor(point[2] * inv) | 0;

            for (let dx = -neighborRadius; dx <= neighborRadius; dx++) {
                for (let dy = -neighborRadius; dy <= neighborRadius; dy++) {
                    for (let dz = -neighborRadius; dz <= neighborRadius; dz++) {
                        const key = ((ix + dx) * 73856093) ^ ((iy + dy) * 19349663) ^ ((iz + dz) * 83492791);
                        const bucket = cells.get(key);
                        if (!bucket) continue;

                        for (const next of bucket) {
                            if (assigned[next]) continue;
                            const other = candidates[next];
                            const seedDepthDelta = Math.abs(other.depth - seedDepth);
                            if (seedDepthDelta > options.maxSeedDepthDelta) continue;
                            const neighborDepthDelta = Math.abs(other.depth - candidate.depth);
                            if (neighborDepthDelta > options.maxNeighborDepthDelta) continue;

                            const otherPoint = other.point;
                            const ddx = point[0] - otherPoint[0];
                            const ddy = point[1] - otherPoint[1];
                            const ddz = point[2] - otherPoint[2];
                            if (ddx * ddx + ddy * ddy + ddz * ddz > maxSpatial2) continue;

                            if (
                                Math.hypot(
                                    candidate.pixel[0] - other.pixel[0],
                                    candidate.pixel[1] - other.pixel[1]
                                ) > options.maxPixelDistance
                            ) {
                                continue;
                            }

                            assigned[next] = 1;
                            queue.push(next);
                        }
                    }
                }
            }
        }

        if (component.length >= options.minPoints) {
            components.push(component);
        }
    }

    components.sort((a, b) => b.length - a.length);
    return components.slice(0, options.maxComponents);
};

const buildClickLocalBb2d = (
    frame: BoxerFramePayload,
    clickX: number,
    clickY: number,
    sourceBb: NormalizedBb2d
): NormalizedBb2d => {
    const sourceWidth = sourceBb[2] - sourceBb[0];
    const sourceHeight = sourceBb[3] - sourceBb[1];
    const radius = Math.min(
        LOCAL_CLICK_WINDOW_MAX_PX,
        Math.max(LOCAL_CLICK_WINDOW_MIN_PX, Math.max(sourceWidth, sourceHeight) * 0.16)
    );

    return [
        Math.min(frame.image_width, Math.max(0, clickX - radius)),
        Math.min(frame.image_height, Math.max(0, clickY - radius)),
        Math.min(frame.image_width, Math.max(0, clickX + radius)),
        Math.min(frame.image_height, Math.max(0, clickY + radius))
    ];
};

const filterFrontSurfaceProjectedCandidates = (
    candidates: ProjectedSplatCandidate[],
    imageWidth: number,
    imageHeight: number
): ProjectedSplatCandidate[] => {
    if (candidates.some(candidate => candidate.layer_class !== undefined)) {
        const nearestLayer = candidates.filter(candidate => candidate.layer_class === 1);
        if (nearestLayer.length >= 24) return nearestLayer;

        const layered = candidates.filter(candidate => candidate.layer_class === 1 || candidate.layer_class === 2);
        if (layered.length >= 24) return layered;
    }

    const depthW = Math.ceil(imageWidth / MASK_OCCLUSION_CELL_PX);
    const depthH = Math.ceil(imageHeight / MASK_OCCLUSION_CELL_PX);
    const nearest = new Float32Array(depthW * depthH);
    nearest.fill(Infinity);

    for (const candidate of candidates) {
        const x = Math.min(depthW - 1, Math.max(0, Math.floor(candidate.pixel[0] / MASK_OCCLUSION_CELL_PX)));
        const y = Math.min(depthH - 1, Math.max(0, Math.floor(candidate.pixel[1] / MASK_OCCLUSION_CELL_PX)));
        const idx = y * depthW + x;
        if (candidate.depth < nearest[idx]) {
            nearest[idx] = candidate.depth;
        }
    }

    return candidates.filter((candidate) => {
        const x = Math.min(depthW - 1, Math.max(0, Math.floor(candidate.pixel[0] / MASK_OCCLUSION_CELL_PX)));
        const y = Math.min(depthH - 1, Math.max(0, Math.floor(candidate.pixel[1] / MASK_OCCLUSION_CELL_PX)));
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
            MASK_OCCLUSION_MAX_M,
            Math.max(MASK_OCCLUSION_MIN_M, nearestDepth * MASK_OCCLUSION_FRAC_OF_DEPTH)
        );
        return candidate.depth <= nearestDepth + tolerance;
    });
};

const collectClickLocalCluster = (
    splat: Splat,
    scene: Scene,
    frame: BoxerFramePayload,
    sourceBb: NormalizedBb2d,
    clickX: number,
    clickY: number,
    clickDepth: number
) => {
    const localBb = buildClickLocalBb2d(frame, clickX, clickY, sourceBb);
    const localCandidates = collectProjectedSplatCandidates(splat, scene, frame.intrinsics, localBb);
    const frontSurface = filterFrontSurfaceProjectedCandidates(localCandidates, frame.image_width, frame.image_height);
    const candidates = frontSurface.length >= 24 ? frontSurface : localCandidates;
    const seed = findProjectedSeed(candidates, clickX, clickY, clickDepth);
    if (seed < 0) {
        return {
            cluster: [] as ProjectedSplatCandidate[],
            supportCandidates: candidates,
            localBb,
            localCandidateCount: localCandidates.length,
            frontSurfaceCandidateCount: frontSurface.length
        };
    }

    const seedDepth = candidates[seed].depth;
    const eps = Math.min(0.32, Math.max(0.06, seedDepth * 0.01));
    const depthBand = Math.min(0.75, Math.max(0.22, seedDepth * 0.025));
    const cluster = growProjectedCluster(candidates, seed, eps, depthBand);

    return {
        cluster,
        supportCandidates: candidates,
        localBb,
        localCandidateCount: localCandidates.length,
        frontSurfaceCandidateCount: frontSurface.length
    };
};

const bboxFromProjectedCandidates = (
    candidates: ProjectedSplatCandidate[],
    imageWidth: number,
    imageHeight: number
): NormalizedBb2d | null => {
    if (candidates.length === 0) return null;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const candidate of candidates) {
        minX = Math.min(minX, candidate.pixel[0]);
        minY = Math.min(minY, candidate.pixel[1]);
        maxX = Math.max(maxX, candidate.pixel[0]);
        maxY = Math.max(maxY, candidate.pixel[1]);
    }
    return sanitizeBb2d([minX, minY, maxX, maxY], imageWidth, imageHeight);
};

const depthConnectedBb2d = (
    depth: DepthBuffer,
    imageWidth: number,
    imageHeight: number,
    clickX: number,
    clickY: number,
    clickDepth: number
): { bb2d: NormalizedBb2d; pixel_count: number; seed_depth: number; relaxed: boolean } | null => {
    if (clickDepth <= 0 || depth.width <= 0 || depth.height <= 0) return null;

    const seedX0 = clamp(Math.floor(clickX * depth.width / imageWidth), 0, depth.width - 1);
    const seedY0 = clamp(Math.floor(clickY * depth.height / imageHeight), 0, depth.height - 1);
    let seedX = seedX0;
    let seedY = seedY0;
    let seedDepth = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let dy = -8; dy <= 8; dy++) {
        for (let dx = -8; dx <= 8; dx++) {
            const x = seedX0 + dx;
            const y = seedY0 + dy;
            if (x < 0 || x >= depth.width || y < 0 || y >= depth.height) continue;
            const value = depth.data[y * depth.width + x];
            if (value <= 0) continue;
            const dist = Math.hypot(dx, dy) + Math.abs(value - clickDepth) / Math.max(0.1, clickDepth) * 90;
            if (dist < bestDist) {
                bestDist = dist;
                seedX = x;
                seedY = y;
                seedDepth = value;
            }
        }
    }
    if (seedDepth <= 0) return null;

    const maxPixelRadius = Math.ceil(LOCAL_CLICK_WINDOW_MAX_PX * Math.max(depth.width / imageWidth, depth.height / imageHeight));
    const run = (maxSeedDelta: number, maxNeighborDelta: number, relaxed: boolean) => {
        const visited = new Uint8Array(depth.width * depth.height);
        const queue: [number, number][] = [[seedX, seedY]];
        visited[seedY * depth.width + seedX] = 1;
        let minX = seedX;
        let maxX = seedX;
        let minY = seedY;
        let maxY = seedY;
        let count = 0;

        while (queue.length > 0 && count < 30000) {
            const [x, y] = queue.pop()!;
            const value = depth.data[y * depth.width + x];
            count++;
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);

            for (let oy = -1; oy <= 1; oy++) {
                for (let ox = -1; ox <= 1; ox++) {
                    if (ox === 0 && oy === 0) continue;
                    const nx = x + ox;
                    const ny = y + oy;
                    if (nx < 0 || nx >= depth.width || ny < 0 || ny >= depth.height) continue;
                    if (Math.abs(nx - seedX) > maxPixelRadius || Math.abs(ny - seedY) > maxPixelRadius) continue;
                    const index = ny * depth.width + nx;
                    if (visited[index]) continue;
                    const nextDepth = depth.data[index];
                    if (nextDepth <= 0) continue;
                    if (Math.abs(nextDepth - seedDepth) > maxSeedDelta) continue;
                    if (Math.abs(nextDepth - value) > maxNeighborDelta) continue;
                    visited[index] = 1;
                    queue.push([nx, ny]);
                }
            }
        }

        const pad = relaxed ? 3 : 2;
        const bb = sanitizeBb2d([
            (minX - pad) * imageWidth / depth.width,
            (minY - pad) * imageHeight / depth.height,
            (maxX + 1 + pad) * imageWidth / depth.width,
            (maxY + 1 + pad) * imageHeight / depth.height
        ], imageWidth, imageHeight);
        return bb ? { bb2d: bb, pixel_count: count, seed_depth: seedDepth, relaxed } : null;
    };

    const strict = run(
        Math.min(0.32, Math.max(0.12, seedDepth * 0.02)),
        Math.min(0.2, Math.max(0.06, seedDepth * 0.012)),
        false
    );
    if (strict && strict.pixel_count >= 24) return strict;

    const relaxed = run(
        Math.min(0.9, Math.max(0.28, seedDepth * 0.065)),
        Number.POSITIVE_INFINITY,
        true
    );
    const best = relaxed && (!strict || relaxed.pixel_count > strict.pixel_count) ? relaxed : strict;
    if (!best || best.pixel_count < 8) return null;
    return best;
};

const expandBb2d = (
    bb: NormalizedBb2d,
    scale: number,
    imageWidth: number,
    imageHeight: number
): NormalizedBb2d | null => {
    const [cx, cy] = bbCenter(bb);
    const halfW = (bb[2] - bb[0]) * scale / 2;
    const halfH = (bb[3] - bb[1]) * scale / 2;
    return sanitizeBb2d([cx - halfW, cy - halfH, cx + halfW, cy + halfH], imageWidth, imageHeight);
};

const addUniqueProposal = (
    proposals: DirectLiftProposal[],
    proposal: DirectLiftProposal,
    imageWidth: number,
    imageHeight: number
) => {
    const bb = sanitizeBb2d(proposal.bb2d, imageWidth, imageHeight);
    if (!bb) return;
    const duplicate = proposals.some(existing => bb2dIou(existing.bb2d, bb) > 0.94);
    if (!duplicate) proposals.push({ ...proposal, bb2d: bb });
};

const buildObjectCropDirectLiftRequest = async (
    frame: BoxerFramePayload,
    proposals: DirectLiftProposal[],
    options?: ObjectCropOptions
): Promise<{
    frame: BoxerFramePayload;
    proposals: DirectLiftProposal[];
    crop: {
        x: number;
        y: number;
        size: number;
        scale: number;
        min_size: number;
        max_size: number;
        source_image_width: number;
        source_image_height: number;
        proposal_count: number;
    };
} | null> => {
    if (!options?.enabled || proposals.length === 0) return null;

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const proposal of proposals) {
        minX = Math.min(minX, proposal.bb2d[0]);
        minY = Math.min(minY, proposal.bb2d[1]);
        maxX = Math.max(maxX, proposal.bb2d[2]);
        maxY = Math.max(maxY, proposal.bb2d[3]);
    }
    if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;

    const sourceLimit = Math.max(1, Math.min(frame.image_width, frame.image_height));
    const cropScale = Math.max(1, options.scale ?? 2.8);
    const requestedMin = options.min_size ?? 480;
    const requestedMax = options.max_size ?? sourceLimit;
    const minSize = clamp(Math.min(requestedMin, sourceLimit), 1, sourceLimit);
    const maxSize = clamp(Math.max(requestedMax, minSize), minSize, sourceLimit);
    const unionWidth = Math.max(1, maxX - minX);
    const unionHeight = Math.max(1, maxY - minY);
    const size = Math.round(clamp(Math.max(unionWidth, unionHeight) * cropScale, minSize, maxSize));
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const cropX = Math.round(clamp(centerX - size / 2, 0, Math.max(0, frame.image_width - size)));
    const cropY = Math.round(clamp(centerY - size / 2, 0, Math.max(0, frame.image_height - size)));

    const croppedImage = await cropPngBase64(frame.image, { x: cropX, y: cropY, size });
    const intrinsics: Intrinsics = {
        ...frame.intrinsics,
        cx: frame.intrinsics.cx - cropX,
        cy: frame.intrinsics.cy - cropY,
        width: size,
        height: size
    };
    const croppedProposals = proposals.map((proposal) => {
        const croppedBb = sanitizeBb2d([
            proposal.bb2d[0] - cropX,
            proposal.bb2d[1] - cropY,
            proposal.bb2d[2] - cropX,
            proposal.bb2d[3] - cropY
        ], size, size);
        return croppedBb ? {
            ...proposal,
            bb2d: croppedBb
        } : null;
    }).filter((proposal): proposal is DirectLiftProposal => !!proposal);
    if (croppedProposals.length === 0) return null;

    return {
        frame: {
            ...frame,
            image: croppedImage,
            intrinsics,
            image_preprocess: buildBoxerImagePreprocess(size, size, intrinsics),
            image_width: size,
            image_height: size,
            canvas_css_width: size,
            canvas_css_height: size
        },
        proposals: croppedProposals,
        crop: {
            x: cropX,
            y: cropY,
            size,
            scale: cropScale,
            min_size: minSize,
            max_size: maxSize,
            source_image_width: frame.image_width,
            source_image_height: frame.image_height,
            proposal_count: croppedProposals.length
        }
    };
};

const buildFixedClickProposals = (
    clickX: number,
    clickY: number,
    imageWidth: number,
    imageHeight: number
): DirectLiftProposal[] => {
    const sizes = [
        [96, 180],
        [128, 240],
        [160, 320],
        [220, 420],
        [180, 180],
        [260, 260],
        [360, 360],
        [260, 150],
        [420, 220]
    ];
    const proposals: DirectLiftProposal[] = [];
    for (const [w, h] of sizes) {
        const bb = sanitizeBb2d([clickX - w / 2, clickY - h / 2, clickX + w / 2, clickY + h / 2], imageWidth, imageHeight);
        if (!bb) continue;
        addUniqueProposal(proposals, {
            id: `fixed-${Math.round(w)}x${Math.round(h)}`,
            bb2d: bb,
            score2d: 0.55,
            source: 'fixed-click'
        }, imageWidth, imageHeight);
    }
    return proposals;
};

const maskBb2d = (
    mask: Uint8Array,
    maskWidth: number,
    maskHeight: number,
    imageWidth: number,
    imageHeight: number
): { bb: NormalizedBb2d | null; areaRatio: number } => {
    let minX = maskWidth;
    let minY = maskHeight;
    let maxX = -1;
    let maxY = -1;
    let count = 0;

    for (let y = 0; y < maskHeight; y++) {
        for (let x = 0; x < maskWidth; x++) {
            if (mask[y * maskWidth + x] === 0) continue;
            count++;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
        }
    }

    if (count === 0) {
        return { bb: null, areaRatio: 0 };
    }

    return {
        bb: [
            minX * imageWidth / maskWidth,
            minY * imageHeight / maskHeight,
            (maxX + 1) * imageWidth / maskWidth,
            (maxY + 1) * imageHeight / maskHeight
        ],
        areaRatio: count / Math.max(1, maskWidth * maskHeight)
    };
};

type MaskPixelBounds = { x0: number; y0: number; x1: number; y1: number; count: number };

const maskPixelBounds = (mask: Uint8Array, maskWidth: number, maskHeight: number): MaskPixelBounds | null => {
    let x0 = maskWidth;
    let y0 = maskHeight;
    let x1 = -1;
    let y1 = -1;
    let count = 0;
    for (let y = 0; y < maskHeight; y++) {
        for (let x = 0; x < maskWidth; x++) {
            if (mask[y * maskWidth + x] === 0) continue;
            count++;
            if (x < x0) x0 = x;
            if (y < y0) y0 = y;
            if (x > x1) x1 = x;
            if (y > y1) y1 = y;
        }
    }
    if (count === 0) return null;
    return { x0, y0, x1: x1 + 1, y1: y1 + 1, count };
};

const worldRayFromPixel = (
    scene: Scene,
    intrinsics: Intrinsics,
    pixelX: number,
    pixelY: number
): { origin: [number, number, number]; dir: [number, number, number] } => {
    const camera = scene.camera;
    const pos = camera.position;
    const view = camera.camera.viewMatrix.data as Float32Array;
    const ogX = (pixelX - intrinsics.cx) / Math.max(1e-6, intrinsics.fx);
    const ogY = -(pixelY - intrinsics.cy) / Math.max(1e-6, intrinsics.fy);
    const ogZ = -1;
    const dx = view[0] * ogX + view[1] * ogY + view[2] * ogZ;
    const dy = view[4] * ogX + view[5] * ogY + view[6] * ogZ;
    const dz = view[8] * ogX + view[9] * ogY + view[10] * ogZ;
    const len = Math.hypot(dx, dy, dz) || 1;
    return {
        origin: [pos.x, pos.y, pos.z],
        dir: [dx / len, dy / len, dz / len]
    };
};

const projectDepthOnly = (
    scene: Scene,
    worldX: number,
    worldY: number,
    worldZ: number
) => {
    const view = scene.camera.camera.viewMatrix.data as Float32Array;
    const ogZ = view[2] * worldX + view[6] * worldY + view[10] * worldZ + view[14];
    return -ogZ;
};

const computeMaskWorldQueryAabb = (
    grid: DepthVisibilitySpatialGrid,
    scene: Scene,
    intrinsics: Intrinsics,
    bounds: MaskPixelBounds,
    maskWidth: number,
    maskHeight: number,
    imageWidth: number,
    imageHeight: number
): { min: [number, number, number]; max: [number, number, number] } | null => {
    let nearDepth = Infinity;
    let farDepth = -Infinity;
    for (let xi = 0; xi < 2; xi++) {
        for (let yi = 0; yi < 2; yi++) {
            for (let zi = 0; zi < 2; zi++) {
                const x = xi ? grid.boundsMax[0] : grid.boundsMin[0];
                const y = yi ? grid.boundsMax[1] : grid.boundsMin[1];
                const z = zi ? grid.boundsMax[2] : grid.boundsMin[2];
                const depth = projectDepthOnly(scene, x, y, z);
                if (depth <= 0) return null;
                if (depth < nearDepth) nearDepth = depth;
                if (depth > farDepth) farDepth = depth;
            }
        }
    }
    if (!Number.isFinite(nearDepth) || !Number.isFinite(farDepth) || farDepth <= 0) return null;

    const padPx = 2;
    const sx = imageWidth / Math.max(1, maskWidth);
    const sy = imageHeight / Math.max(1, maskHeight);
    const x0 = Math.max(0, (bounds.x0 - padPx) * sx);
    const y0 = Math.max(0, (bounds.y0 - padPx) * sy);
    const x1 = Math.min(imageWidth, (bounds.x1 + padPx) * sx);
    const y1 = Math.min(imageHeight, (bounds.y1 + padPx) * sy);
    if (x1 <= x0 || y1 <= y0) return null;

    const forward = worldRayFromPixel(scene, intrinsics, imageWidth * 0.5, imageHeight * 0.5).dir;
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    const expand = (x: number, y: number, z: number) => {
        if (x < min[0]) min[0] = x;
        if (y < min[1]) min[1] = y;
        if (z < min[2]) min[2] = z;
        if (x > max[0]) max[0] = x;
        if (y > max[1]) max[1] = y;
        if (z > max[2]) max[2] = z;
    };

    let expanded = false;
    for (const [px, py] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as [number, number][]) {
        const ray = worldRayFromPixel(scene, intrinsics, px, py);
        const cos = ray.dir[0] * forward[0] + ray.dir[1] * forward[1] + ray.dir[2] * forward[2];
        if (cos <= 1e-3) continue;
        for (const depth of [Math.max(nearDepth, 0.01), farDepth]) {
            const t = depth / cos;
            expand(
                ray.origin[0] + ray.dir[0] * t,
                ray.origin[1] + ray.dir[1] * t,
                ray.origin[2] + ray.dir[2] * t
            );
            expanded = true;
        }
    }
    if (!expanded) return null;

    const padWorld = grid.cellSize + Math.max(0.05, farDepth * 0.0025);
    return {
        min: [min[0] - padWorld, min[1] - padWorld, min[2] - padWorld],
        max: [max[0] + padWorld, max[1] + padWorld, max[2] + padWorld]
    };
};

const queryDepthVisibilitySpatialGrid = (
    grid: DepthVisibilitySpatialGrid,
    min: [number, number, number],
    max: [number, number, number]
): Uint32Array => {
    const inv = 1 / grid.cellSize;
    const clampCell = (value: number) => Math.max(-1000000, Math.min(1000000, Math.floor(value * inv) | 0));
    const ix0 = clampCell(min[0] - grid.boundsMin[0]);
    const iy0 = clampCell(min[1] - grid.boundsMin[1]);
    const iz0 = clampCell(min[2] - grid.boundsMin[2]);
    const ix1 = clampCell(max[0] - grid.boundsMin[0]);
    const iy1 = clampCell(max[1] - grid.boundsMin[1]);
    const iz1 = clampCell(max[2] - grid.boundsMin[2]);
    const cellVisits = Math.max(0, ix1 - ix0 + 1) * Math.max(0, iy1 - iy0 + 1) * Math.max(0, iz1 - iz0 + 1);
    if (cellVisits > 350000) return new Uint32Array();

    const pending: number[] = [];
    for (let iz = iz0; iz <= iz1; iz++) {
        for (let iy = iy0; iy <= iy1; iy++) {
            for (let ix = ix0; ix <= ix1; ix++) {
                const bucket = grid.cells.get(hashGridCell(ix, iy, iz));
                if (!bucket) continue;
                for (let i = 0; i < bucket.length; i++) pending.push(bucket[i]);
            }
        }
    }
    return Uint32Array.from(pending);
};

const collectMaskSplatCandidates = (
    splat: Splat,
    scene: Scene,
    intrinsics: Intrinsics,
    mask: Uint8Array,
    maskWidth: number,
    maskHeight: number,
    imageWidth: number,
    imageHeight: number
): ProjectedSplatCandidate[] => {
    const cache = getSplatWorldCenterCache(splat);
    if (!cache) return [];
    const index = getDepthVisibilityIndex(splat);
    const bounds = maskPixelBounds(mask, maskWidth, maskHeight);
    let indexList: Uint32Array | null = null;
    if (index && bounds) {
        const aabb = computeMaskWorldQueryAabb(index.spatialGrid, scene, intrinsics, bounds, maskWidth, maskHeight, imageWidth, imageHeight);
        if (aabb) {
            const culled = queryDepthVisibilitySpatialGrid(index.spatialGrid, aabb.min, aabb.max);
            if (culled.length > 0) indexList = culled;
        }
    }

    const scaleX = maskWidth / imageWidth;
    const scaleY = maskHeight / imageHeight;
    const candidates: ProjectedSplatCandidate[] = [];
    const viewCache = getDepthVisibilityViewCache(splat, scene, intrinsics, imageWidth, imageHeight);
    const centers = cache.worldCenters;
    const view = scene.camera.camera.viewMatrix.data as Float32Array;

    const visit = (i: number) => {
        let u: number;
        let v: number;
        let cvZ: number;
        let layerClass: 0 | 1 | 2 | 3 | undefined;
        let tileIndex: number | undefined;
        if (viewCache) {
            if (!viewCache.inFrame[i]) return;
            u = viewCache.pixelX[i];
            v = viewCache.pixelY[i];
            cvZ = viewCache.depth[i];
            layerClass = viewCache.layerClass[i] as 0 | 1 | 2 | 3;
            tileIndex = viewCache.tileIndex[i];
        } else {
            const wx = centers[i * 3];
            const wy = centers[i * 3 + 1];
            const wz = centers[i * 3 + 2];
            const ogX = view[0] * wx + view[4] * wy + view[8]  * wz + view[12];
            const ogY = view[1] * wx + view[5] * wy + view[9]  * wz + view[13];
            const ogZ = view[2] * wx + view[6] * wy + view[10] * wz + view[14];
            cvZ = -ogZ;
            if (cvZ <= 0) return;
            u = intrinsics.fx * ogX / cvZ + intrinsics.cx;
            v = intrinsics.fy * (-ogY) / cvZ + intrinsics.cy;
            if (u < 0 || u >= imageWidth || v < 0 || v >= imageHeight) return;
        }

        if (cvZ <= 0 || u < 0 || u >= imageWidth || v < 0 || v >= imageHeight) return;
        const maskX = Math.min(maskWidth - 1, Math.max(0, Math.round(u * scaleX)));
        const maskY = Math.min(maskHeight - 1, Math.max(0, Math.round(v * scaleY)));
        if (mask[maskY * maskWidth + maskX] === 0) return;

        const wx = centers[i * 3];
        const wy = centers[i * 3 + 1];
        const wz = centers[i * 3 + 2];

        candidates.push({
            point: [wx, wy, wz],
            splatIndex: i,
            world: [wx, wy, wz],
            pixel: [u, v],
            depth: cvZ,
            in_frame: true,
            layer_class: layerClass,
            tile_index: tileIndex
        });
    };

    if (indexList) {
        for (let k = 0; k < indexList.length; k++) visit(indexList[k]);
        if (candidates.length > 0) return candidates;
    }

    for (let i = 0; i < cache.count; i++) visit(i);
    return candidates;
};

const fetchSam3ClickMaskRegion = async (
    frame: BoxerFramePayload,
    splat: Splat,
    scene: Scene,
    clickX: number,
    clickY: number,
    debug?: Sam3MaskDebug,
    options?: { promptPoints?: [number, number][] }
): Promise<Sam3MaskRegion | null> => {
    const sam3BackendUrl = getSam3BackendUrl();
    const resized = await resizePngBase64(frame.image, frame.image_width, frame.image_height, SAM3_MAX_IMAGE_SIDE);
    if (debug) {
        debug.backend_url = sam3BackendUrl;
        debug.resized = { width: resized.width, height: resized.height, scale: resized.scale };
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), SAM3_REQUEST_TIMEOUT_MS);
    const normalizedClick: [number, number] = [
        Math.min(1, Math.max(0, clickX / Math.max(1, frame.image_width))),
        Math.min(1, Math.max(0, clickY / Math.max(1, frame.image_height)))
    ];
    const promptPoints = (options?.promptPoints?.length ? options.promptPoints : [[clickX, clickY]])
    .filter(point => Number.isFinite(point[0]) && Number.isFinite(point[1]));
    const normalizedPoints = (promptPoints.length ? promptPoints : [[clickX, clickY]])
    .map(([x, y]) => [
        Math.min(1, Math.max(0, x / Math.max(1, frame.image_width))),
        Math.min(1, Math.max(0, y / Math.max(1, frame.image_height)))
    ] as [number, number]);
    const labels = normalizedPoints.map(() => 1);

    const refineBody = {
        image: resized.image,
        object_id: 1,
        frame_index: 0,
        clear_old_points: true,
        coordinate_space: 'normalized',
        image_size: { width: resized.width, height: resized.height },
        points: normalizedPoints.length ? normalizedPoints : [normalizedClick],
        labels: labels.length ? labels : [1]
    };

    try {
        let res = await fetch(`${sam3BackendUrl}/api/sam3/refine`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: getSam3FetchCredentials(sam3BackendUrl),
            body: JSON.stringify(refineBody),
            signal: controller.signal
        });
        debug?.attempts.push({
            endpoint: '/api/sam3/refine',
            status: res.status,
            ok: res.ok
        });

        if (!res.ok) {
            res = await fetch(`${sam3BackendUrl}/api/sam3/segment`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: getSam3FetchCredentials(sam3BackendUrl),
                body: JSON.stringify({
                    image: resized.image,
                    click_xy: [Math.round(clickX * resized.scale), Math.round(clickY * resized.scale)],
                    label: 1,
                    image_size: { width: resized.width, height: resized.height },
                    points: [{
                        click_xy: [Math.round(clickX * resized.scale), Math.round(clickY * resized.scale)],
                        label: 1
                    }]
                }),
                signal: controller.signal
            });
            debug?.attempts.push({
                endpoint: '/api/sam3/segment',
                status: res.status,
                ok: res.ok
            });
        }

        let data = await res.json().catch(() => ({})) as {
            mask?: string;
            width?: number;
            height?: number;
            masks?: { mask_png?: string; mask?: string; width?: number; height?: number }[];
            error?: string;
        };

        if (!res.ok || !data.mask || data.width === undefined || data.height === undefined) {
            const pixelPoints = (promptPoints.length ? promptPoints : [[clickX, clickY]])
            .map(([x, y]) => ({
                x: Math.round(x * resized.scale),
                y: Math.round(y * resized.scale),
                label: 1
            }));
            const frameRes = await fetch(`${sam3BackendUrl}/segment_frame`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: getSam3FetchCredentials(sam3BackendUrl),
                body: JSON.stringify({
                    image: resized.image,
                    width: resized.width,
                    height: resized.height,
                    prompts: { points: pixelPoints },
                    coordinate_space: 'pixel',
                    multimask: false
                }),
                signal: controller.signal
            });
            const frameData = await frameRes.json().catch(() => ({})) as {
                masks?: { mask_png?: string; mask?: string }[];
                width?: number;
                height?: number;
                detail?: string;
            };
            debug?.attempts.push({
                endpoint: '/segment_frame',
                status: frameRes.status,
                ok: frameRes.ok,
                detail: frameData.detail
            });
            const firstMask = frameData.masks?.[0]?.mask_png ?? frameData.masks?.[0]?.mask;
            if (frameRes.ok && firstMask && frameData.width !== undefined && frameData.height !== undefined) {
                data = {
                    mask: firstMask.includes(',') ? firstMask.split(',', 2)[1] : firstMask,
                    width: frameData.width,
                    height: frameData.height
                };
                res = frameRes;
            }
        }

        if (!res.ok || !data.mask || data.width === undefined || data.height === undefined) {
            const uploadForm = new FormData();
            const imageBlob = await fetch(`data:image/png;base64,${resized.image}`).then(item => item.blob());
            uploadForm.append('image', imageBlob, 'frame.png');
            const uploadRes = await fetch(`${sam3BackendUrl}/upload`, {
                method: 'POST',
                credentials: getSam3FetchCredentials(sam3BackendUrl),
                body: uploadForm,
                signal: controller.signal
            });
            const uploadData = await uploadRes.json().catch(() => ({})) as { job_id?: string; detail?: string };
            debug?.attempts.push({
                endpoint: '/upload',
                status: uploadRes.status,
                ok: uploadRes.ok,
                detail: uploadData.detail
            });
            if (uploadRes.ok && uploadData.job_id) {
                const pixelPoints = (promptPoints.length ? promptPoints : [[clickX, clickY]])
                .map(([x, y]) => [
                    Math.round(x * resized.scale),
                    Math.round(y * resized.scale)
                ] as [number, number]);
                let pointRes: Response;
                if (pixelPoints.length > 1) {
                    pointRes = await fetch(`${sam3BackendUrl}/segment_points`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: getSam3FetchCredentials(sam3BackendUrl),
                        body: JSON.stringify({
                            job_id: uploadData.job_id,
                            points: pixelPoints,
                            labels: pixelPoints.map(() => 1),
                            coordinate_space: 'pixel',
                            multimask_output: false
                        }),
                        signal: controller.signal
                    });
                } else {
                    const pointForm = new FormData();
                    pointForm.append('job_id', uploadData.job_id);
                    pointForm.append('x', String(pixelPoints[0]?.[0] ?? Math.round(clickX * resized.scale)));
                    pointForm.append('y', String(pixelPoints[0]?.[1] ?? Math.round(clickY * resized.scale)));
                    pointForm.append('label', '1');
                    pointRes = await fetch(`${sam3BackendUrl}/segment_point`, {
                        method: 'POST',
                        credentials: getSam3FetchCredentials(sam3BackendUrl),
                        body: pointForm,
                        signal: controller.signal
                    });
                }
                const pointData = await pointRes.json().catch(() => ({})) as {
                    masks?: { mask_image?: string }[];
                    detail?: string;
                };
                const maskImage = pointData.masks?.[0]?.mask_image;
                debug?.attempts.push({
                    endpoint: pixelPoints.length > 1 ? '/segment_points' : '/segment_point',
                    status: pointRes.status,
                    ok: pointRes.ok,
                    detail: pointData.detail
                });
                if (pointRes.ok && maskImage) {
                    data = {
                        mask: maskImage.includes(',') ? maskImage.split(',', 2)[1] : maskImage,
                        width: resized.width,
                        height: resized.height
                    };
                    res = pointRes;
                } else {
                    data = { error: pointData.detail || pointRes.statusText };
                    res = pointRes;
                }
            } else {
                data = { error: uploadData.detail || uploadRes.statusText };
                res = uploadRes;
            }
        }

        if (!res.ok || !data.mask || data.width === undefined || data.height === undefined) {
            if (debug) {
                debug.rejection_reason = `mask-unavailable-${res.status}`;
            }
            console.warn(`[Boxer] SAM3 mask unavailable (${res.status})`, data.error || res.statusText);
            return null;
        }

        const mask = await maskPngToArray(data.mask, data.width, data.height);
        const maskBounds = maskBb2d(mask, data.width, data.height, frame.image_width, frame.image_height);
        if (debug) {
            debug.mask_bb2d = maskBounds.bb ?? undefined;
            debug.mask_area_ratio = maskBounds.areaRatio;
        }
        if (!maskBounds.bb) {
            if (debug) debug.rejection_reason = 'empty-mask';
            return null;
        }

        const projected = collectMaskSplatCandidates(
            splat,
            scene,
            frame.intrinsics,
            mask,
            data.width,
            data.height,
            frame.image_width,
            frame.image_height
        );
        const frontSurface = filterFrontSurfaceProjectedCandidates(projected, frame.image_width, frame.image_height);
        if (debug) {
            debug.projected_candidate_count = projected.length;
            debug.front_surface_candidate_count = frontSurface.length;
        }
        if (frontSurface.length === 0) {
            if (debug) debug.rejection_reason = 'no-front-surface-points';
            return null;
        }

        const seed = findProjectedSeed(frontSurface, clickX, clickY, 0);
        if (seed < 0) {
            if (debug) debug.rejection_reason = 'no-mask-seed';
            return null;
        }

        const eps = Math.min(CLUSTER_EPS_MAX, Math.max(CLUSTER_EPS_MIN, frontSurface[seed].depth * CLUSTER_EPS_FRAC_OF_DEPTH));
        const depthBand = Math.min(CLUSTER_DEPTH_MAX, Math.max(CLUSTER_DEPTH_MIN, frontSurface[seed].depth * CLUSTER_DEPTH_FRAC_OF_DEPTH));
        const cluster = growProjectedCluster(frontSurface, seed, eps, depthBand);
        const selected = cluster.length >= 24 ? cluster : frontSurface;
        if (debug) debug.selected_point_count = selected.length;
        if (selected.length < 24) {
            if (debug) debug.rejection_reason = 'too-few-mask-points';
            return null;
        }

        return {
            points: selected.map(candidate => candidate.point),
            mask_bb2d: maskBounds.bb,
            point_count: selected.length,
            projected_candidate_count: projected.length,
            front_surface_candidate_count: frontSurface.length,
            mask_area_ratio: maskBounds.areaRatio
        };
    } catch (err: any) {
        if (debug) {
            debug.error = err instanceof Error ? err.message : String(err);
            debug.rejection_reason = err?.name === 'AbortError' ? 'timeout' : 'exception';
        }
        if (err?.name !== 'AbortError') {
            console.warn('[Boxer] SAM3 mask fallback failed', err);
        } else {
            console.warn('[Boxer] SAM3 mask fallback timed out');
        }
        return null;
    } finally {
        window.clearTimeout(timeout);
    }
};

const sampleDepthArea = (
    depth: DepthBuffer,
    imageWidth: number,
    imageHeight: number,
    imgU: number,
    imgV: number,
    radius = 3
) => {
    const du = Math.min(depth.width - 1, Math.max(0, Math.floor(imgU * depth.width / imageWidth)));
    const dv = Math.min(depth.height - 1, Math.max(0, Math.floor(imgV * depth.height / imageHeight)));
    const values: number[] = [];
    for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
            const px = du + dx;
            const py = dv + dy;
            if (px >= 0 && px < depth.width && py >= 0 && py < depth.height) {
                const d = depth.data[py * depth.width + px];
                if (d > 0) values.push(d);
            }
        }
    }
    if (values.length === 0) return 0;
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const sanitizeBb2d = (
    bb: NormalizedBb2d,
    imageWidth: number,
    imageHeight: number
): NormalizedBb2d | null => {
    if (!bb.every(Number.isFinite)) return null;
    const x0 = clamp(Math.min(bb[0], bb[2]), 0, imageWidth);
    const y0 = clamp(Math.min(bb[1], bb[3]), 0, imageHeight);
    const x1 = clamp(Math.max(bb[0], bb[2]), 0, imageWidth);
    const y1 = clamp(Math.max(bb[1], bb[3]), 0, imageHeight);
    if (x1 - x0 < 1 || y1 - y0 < 1) return null;
    return [x0, y0, x1, y1];
};

const bbContainsPoint = (bb: NormalizedBb2d, x: number, y: number) => (
    x >= bb[0] && x <= bb[2] && y >= bb[1] && y <= bb[3]
);

const bbCenter = (bb: NormalizedBb2d): [number, number] => [
    (bb[0] + bb[2]) / 2,
    (bb[1] + bb[3]) / 2
];

const bb2dIou = (a: NormalizedBb2d, b: NormalizedBb2d) => {
    const ix0 = Math.max(a[0], b[0]);
    const iy0 = Math.max(a[1], b[1]);
    const ix1 = Math.min(a[2], b[2]);
    const iy1 = Math.min(a[3], b[3]);
    const intersection = Math.max(0, ix1 - ix0) * Math.max(0, iy1 - iy0);
    const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
    const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
    const union = areaA + areaB - intersection;
    return union > 0 ? intersection / union : 0;
};

const isBroadClickMiss = (
    obb: OBBResult,
    bb2d: NormalizedBb2d,
    imageWidth: number,
    imageHeight: number
) => {
    const width = bb2d[2] - bb2d[0];
    const height = bb2d[3] - bb2d[1];
    const areaRatio = width * height / Math.max(1, imageWidth * imageHeight);
    const lowScore = obb.score2d !== undefined && obb.score2d < LOW_2D_SCORE;
    const broadLabel = /(?:^|_|\b)(?:desk|table|counter|surface|floor|wall)(?:_|$|\b)/i.test(obb.label);
    return areaRatio >= BROAD_CLICK_BB_AREA_RATIO ||
        (lowScore && broadLabel) ||
        (lowScore && (width > imageWidth * 0.4 || height > imageHeight * 0.4));
};

const isBroadSurfaceLabel = (label: string) => (
    /(?:^|_|\b)(?:desk|table|counter|surface|floor|wall)(?:_|$|\b)/i.test(label)
);

const normalizeBb2d = (
    obb: OBBResult,
    imageWidth: number,
    imageHeight: number,
    clickX?: number,
    clickY?: number
): NormalizedBb2d | null => {
    if (!obb.bb2d) return null;

    const [a, b, c, d] = obb.bb2d;
    const formats = [
        { format: 'xyxy', bb: [a, b, c, d] as NormalizedBb2d },
        { format: 'xxyy', bb: [a, c, b, d] as NormalizedBb2d }
    ];

    let best: { bb: NormalizedBb2d; score: number; format: string } | null = null;
    for (const candidate of formats) {
        const bb = sanitizeBb2d(candidate.bb, imageWidth, imageHeight);
        if (!bb) continue;

        const width = bb[2] - bb[0];
        const height = bb[3] - bb[1];
        const areaRatio = width * height / Math.max(1, imageWidth * imageHeight);
        let score = Math.min(areaRatio, 1);
        if (clickX !== undefined && clickY !== undefined) {
            if (bbContainsPoint(bb, clickX, clickY)) score += 10;
            const [cx, cy] = bbCenter(bb);
            const dist = Math.hypot(cx - clickX, cy - clickY);
            score -= dist / Math.max(imageWidth, imageHeight);
        }
        if (candidate.format === obb.bb2d_format) score += 0.25;

        if (!best || score > best.score) {
            best = { bb, score, format: candidate.format };
        }
    }

    if (best) {
        console.log(`[Boxer] normalized bb2d as ${best.format}`);
        return best.bb;
    }

    return null;
};

const unprojectDepthToWorld = (
    frame: BoxerFramePayload,
    pixelX: number,
    pixelY: number,
    surfaceDepth: number
): [number, number, number] => {
    const cvX = (pixelX - frame.intrinsics.cx) / frame.intrinsics.fx * surfaceDepth;
    const cvY = (pixelY - frame.intrinsics.cy) / frame.intrinsics.fy * surfaceDepth;
    const cvZ = surfaceDepth;
    const e = frame.extrinsics;

    return [
        e[0] * cvX + e[4] * cvY + e[8] * cvZ + e[12],
        e[1] * cvX + e[5] * cvY + e[9] * cvZ + e[13],
        e[2] * cvX + e[6] * cvY + e[10] * cvZ + e[14]
    ];
};

const addUniqueRayPixel = (
    pixels: { id: string; pixel: [number, number] }[],
    id: string,
    pixel: [number, number],
    imageWidth: number,
    imageHeight: number
) => {
    const clamped: [number, number] = [
        clamp(pixel[0], 0, imageWidth - 1),
        clamp(pixel[1], 0, imageHeight - 1)
    ];
    const duplicate = pixels.some(existing => Math.hypot(existing.pixel[0] - clamped[0], existing.pixel[1] - clamped[1]) < 2);
    if (!duplicate) pixels.push({ id, pixel: clamped });
};

const buildMultiRayDepthDebug = (
    frame: BoxerFramePayload,
    depthBuffer: DepthBuffer,
    bb2d: NormalizedBb2d,
    click?: { x: number; y: number }
) => {
    const [cx, cy] = bbCenter(bb2d);
    const insetX = Math.max(2, (bb2d[2] - bb2d[0]) * 0.08);
    const insetY = Math.max(2, (bb2d[3] - bb2d[1]) * 0.08);
    const left = bb2d[0] + insetX;
    const right = bb2d[2] - insetX;
    const top = bb2d[1] + insetY;
    const bottom = bb2d[3] - insetY;
    const pixels: { id: string; pixel: [number, number] }[] = [];

    if (click) addUniqueRayPixel(pixels, 'click', [click.x, click.y], frame.image_width, frame.image_height);
    addUniqueRayPixel(pixels, 'center', [cx, cy], frame.image_width, frame.image_height);
    addUniqueRayPixel(pixels, 'top-left', [left, top], frame.image_width, frame.image_height);
    addUniqueRayPixel(pixels, 'top-right', [right, top], frame.image_width, frame.image_height);
    addUniqueRayPixel(pixels, 'bottom-left', [left, bottom], frame.image_width, frame.image_height);
    addUniqueRayPixel(pixels, 'bottom-right', [right, bottom], frame.image_width, frame.image_height);
    addUniqueRayPixel(pixels, 'top-mid', [cx, top], frame.image_width, frame.image_height);
    addUniqueRayPixel(pixels, 'bottom-mid', [cx, bottom], frame.image_width, frame.image_height);
    addUniqueRayPixel(pixels, 'left-mid', [left, cy], frame.image_width, frame.image_height);
    addUniqueRayPixel(pixels, 'right-mid', [right, cy], frame.image_width, frame.image_height);

    for (const gx of [0.25, 0.5, 0.75]) {
        for (const gy of [0.25, 0.5, 0.75]) {
            addUniqueRayPixel(
                pixels,
                `grid-${gx.toFixed(2)}-${gy.toFixed(2)}`,
                [
                    bb2d[0] + (bb2d[2] - bb2d[0]) * gx,
                    bb2d[1] + (bb2d[3] - bb2d[1]) * gy
                ],
                frame.image_width,
                frame.image_height
            );
        }
    }

    const samples = pixels.map(({ id, pixel }) => {
        const depth = sampleDepthArea(depthBuffer, frame.image_width, frame.image_height, pixel[0], pixel[1], 2);
        if (depth <= 0) return null;
        return {
            id,
            pixel,
            depth,
            world: unprojectDepthToWorld(frame, pixel[0], pixel[1], depth)
        };
    }).filter((sample): sample is {
        id: string;
        pixel: [number, number];
        depth: number;
        world: [number, number, number];
    } => !!sample);

    const depths = samples.map(sample => sample.depth).sort((a, b) => a - b);
    const stats = depths.length ? {
        min: depths[0],
        median: quantile(depths, 0.5),
        max: depths[depths.length - 1],
        spread: depths[depths.length - 1] - depths[0]
    } : null;

    return {
        requested_count: pixels.length,
        samples,
        stats
    };
};

const sampleSurfaceWorldAtPixel = async (
    scene: Scene,
    frame: BoxerFramePayload,
    depthBuffer: DepthBuffer,
    pixelX: number,
    pixelY: number
): Promise<{ source: RecenterDecision['source']; world: [number, number, number]; depth?: number } | null> => {
    const nx = clamp(pixelX / Math.max(1, frame.image_width), 0, 1);
    const ny = clamp(pixelY / Math.max(1, frame.image_height), 0, 1);
    const gpuHit = await scene.camera.intersect(nx, ny).catch((_err: unknown): null => null);
    if (gpuHit?.position) {
        return {
            source: 'gpu-depth',
            world: [gpuHit.position.x, gpuHit.position.y, gpuHit.position.z]
        };
    }

    const surfaceDepth = sampleDepthArea(depthBuffer, frame.image_width, frame.image_height, pixelX, pixelY);
    if (surfaceDepth <= 0) return null;

    return {
        source: 'cpu-center-depth',
        world: unprojectDepthToWorld(frame, pixelX, pixelY, surfaceDepth),
        depth: surfaceDepth
    };
};

const maybeRecenterObb = async (
    scene: Scene,
    obb: OBBResult,
    frame: BoxerFramePayload,
    depthBuffer: DepthBuffer,
    bb2d: NormalizedBb2d | null,
    clickX: number,
    clickY: number
): Promise<RecenterDecision> => {
    if (!bb2d) {
        return { applied: false, reason: 'missing-bb2d' };
    }

    if (!bbContainsPoint(bb2d, clickX, clickY)) {
        return { applied: false, reason: 'click-outside-bb2d' };
    }

    const pixel = bbCenter(bb2d);
    const surface = await sampleSurfaceWorldAtPixel(scene, frame, depthBuffer, pixel[0], pixel[1]);
    if (!surface) {
        return { applied: false, reason: 'missing-surface-depth', pixel };
    }

    const oldCenter = obb.center;
    const shift: [number, number, number] = [
        surface.world[0] - oldCenter[0],
        surface.world[1] - oldCenter[1],
        surface.world[2] - oldCenter[2]
    ];
    const shiftLength = Math.hypot(shift[0], shift[1], shift[2]);
    const dimensions = obb.dimensions;
    const dimensionDiag = Math.hypot(dimensions[0], dimensions[1], dimensions[2]);
    const maxShift = Math.max(0.5, dimensionDiag * 4);

    if (!Number.isFinite(shiftLength) || shiftLength > maxShift) {
        return {
            applied: false,
            reason: 'shift-too-large',
            source: surface.source,
            pixel,
            surface_world: surface.world,
            shift,
            shift_length: shiftLength,
            max_shift: maxShift
        };
    }

    obb.center = surface.world;
    obb.corners = obb.corners.map(c => [c[0] + shift[0], c[1] + shift[1], c[2] + shift[2]]);

    return {
        applied: true,
        reason: 'recentered-to-bb2d-surface',
        source: surface.source,
        pixel,
        surface_world: surface.world,
        shift,
        shift_length: shiftLength,
        max_shift: maxShift
    };
};

const quantile = (values: number[], q: number) => {
    if (values.length === 0) return 0;
    const idx = clamp(Math.floor((values.length - 1) * q), 0, values.length - 1);
    return values[idx];
};

const summarizeSortedAxisExtents = (
    sorted: number[][],
    lowQ: number,
    highQ: number,
    expansion = 1
) => {
    const mins = [0, 1, 2].map(axis => quantile(sorted[axis], lowQ)) as [number, number, number];
    const maxs = [0, 1, 2].map(axis => quantile(sorted[axis], highQ)) as [number, number, number];
    const dimensions = [0, 1, 2].map((axis) => {
        return Math.max(0.05, (maxs[axis] - mins[axis]) * expansion);
    }) as [number, number, number];
    return { mins, maxs, dimensions };
};

const getObbAxes = (rotation: number[][]): [number, number, number][] => {
    const axes: [number, number, number][] = [];
    for (let col = 0; col < 3; col++) {
        const axis: [number, number, number] = [
            rotation[0]?.[col] ?? (col === 0 ? 1 : 0),
            rotation[1]?.[col] ?? (col === 1 ? 1 : 0),
            rotation[2]?.[col] ?? (col === 2 ? 1 : 0)
        ];
        const len = Math.hypot(axis[0], axis[1], axis[2]);
        axes.push(len > 1e-6 ? [axis[0] / len, axis[1] / len, axis[2] / len] : [
            col === 0 ? 1 : 0,
            col === 1 ? 1 : 0,
            col === 2 ? 1 : 0
        ]);
    }
    return axes;
};

const buildCornersFromAxes = (
    axes: [number, number, number][],
    mins: [number, number, number],
    maxs: [number, number, number]
): number[][] => {
    const corners: number[][] = [];
    for (const x of [mins[0], maxs[0]]) {
        for (const y of [mins[1], maxs[1]]) {
            for (const z of [mins[2], maxs[2]]) {
                corners.push([
                    axes[0][0] * x + axes[1][0] * y + axes[2][0] * z,
                    axes[0][1] * x + axes[1][1] * y + axes[2][1] * z,
                    axes[0][2] * x + axes[1][2] * y + axes[2][2] * z
                ]);
            }
        }
    }
    return corners;
};

const projectedCornersBb2d = (
    corners: number[][],
    scene: Scene,
    intrinsics: Intrinsics
): NormalizedBb2d | null => {
    const samples = corners.map(corner => projectWorldPointToImage(corner, scene, intrinsics));
    if (samples.some(sample => !sample.in_frame)) return null;
    const xs = samples.map(sample => sample.pixel[0]);
    const ys = samples.map(sample => sample.pixel[1]);
    return [
        Math.min(...xs),
        Math.min(...ys),
        Math.max(...xs),
        Math.max(...ys)
    ];
};

const projectedTargetBb2d = (
    target: BoxerEvalTarget | null | undefined,
    scene: Scene,
    intrinsics: Intrinsics
): NormalizedBb2d | null => {
    if (!target) return null;
    return projectedCornersBb2d(cornersFromCenterDimensions(target.center, target.dimensions, target.rotation), scene, intrinsics);
};

const cornersFromCenterDimensions = (
    center: [number, number, number],
    dimensions: [number, number, number],
    rotation: number[][]
) => {
    const axes = getObbAxes(rotation);
    const halves: [number, number, number] = [dimensions[0] / 2, dimensions[1] / 2, dimensions[2] / 2];
    const corners: number[][] = [];

    for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
            for (const sz of [-1, 1]) {
                corners.push([
                    center[0] + axes[0][0] * halves[0] * sx + axes[1][0] * halves[1] * sy + axes[2][0] * halves[2] * sz,
                    center[1] + axes[0][1] * halves[0] * sx + axes[1][1] * halves[1] * sy + axes[2][1] * halves[2] * sz,
                    center[2] + axes[0][2] * halves[0] * sx + axes[1][2] * halves[1] * sy + axes[2][2] * halves[2] * sz
                ]);
            }
        }
    }

    return corners;
};

const scoreDimensionProjectionFit = (
    center: [number, number, number],
    rotation: number[][],
    dimensions: [number, number, number],
    scene: Scene,
    frame: BoxerFramePayload,
    bb2d: NormalizedBb2d
): GeometryRefinement['projection_fit'] => {
    const permutations: [number, number, number][] = [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0]
    ];
    const bbDiag = Math.max(1, Math.hypot(bb2d[2] - bb2d[0], bb2d[3] - bb2d[1]));
    const targetCenter = bbCenter(bb2d);
    const candidates = permutations.map((order) => {
        const candidateDimensions = order.map(axis => dimensions[axis]) as [number, number, number];
        const projected = projectedCornersBb2d(cornersFromCenterDimensions(center, candidateDimensions, rotation), scene, frame.intrinsics);
        if (!projected) {
            return {
                order,
                dimensions: candidateDimensions,
                bbox_iou: 0,
                center_error_ratio: Number.POSITIVE_INFINITY,
                score: Number.NEGATIVE_INFINITY
            };
        }
        const projectedCenter = bbCenter(projected);
        const centerErrorRatio = Math.hypot(projectedCenter[0] - targetCenter[0], projectedCenter[1] - targetCenter[1]) / bbDiag;
        const bboxIou = bb2dIou(projected, bb2d);
        return {
            order,
            dimensions: candidateDimensions,
            bbox_iou: bboxIou,
            center_error_ratio: centerErrorRatio,
            score: bboxIou - centerErrorRatio * 0.25
        };
    }).sort((a, b) => b.score - a.score);

    return {
        best_order: candidates[0].order,
        best_score: candidates[0].score,
        candidates
    };
};

const isLikelyVerticalObject = (label: string) => (
    /(?:^|_|\b)(?:aerosol_can|beer_can|can|bottle|cup|mug|jar|vase)(?:_|$|\b)/i.test(label)
);

const refineObbFromBoxedPoints = (
    obb: OBBResult,
    frame: BoxerFramePayload,
    splat: Splat,
    scene: Scene,
    bb2d: NormalizedBb2d | null,
    focus?: { click_xy: [number, number]; depthBuffer: DepthBuffer },
    sam3Region?: Sam3MaskRegion | null
): GeometryRefinement => {
    if (!bb2d) return { applied: false, reason: 'missing-bb2d' };

    const width = bb2d[2] - bb2d[0];
    const height = bb2d[3] - bb2d[1];
    const bbAreaRatio = width * height / Math.max(1, frame.image_width * frame.image_height);
    const pad = Math.max(8, Math.max(width, height) * 0.05);
    const padded: NormalizedBb2d = [
        clamp(bb2d[0] - pad, 0, frame.image_width),
        clamp(bb2d[1] - pad, 0, frame.image_height),
        clamp(bb2d[2] + pad, 0, frame.image_width),
        clamp(bb2d[3] + pad, 0, frame.image_height)
    ];

    const boxedSurfacePoints = frame.point_cloud.map(point => ({
        point,
        sample: projectWorldPointToImage(point, scene, frame.intrinsics)
    })).filter(({ sample }) => {
        return sample.in_frame && bbContainsPoint(padded, sample.pixel[0], sample.pixel[1]);
    });

    const fullCandidates = collectProjectedSplatCandidates(splat, scene, frame.intrinsics, padded);
    let selectedPoints = boxedSurfacePoints.map(({ point }) => point);
    let reason = 'bbox-front-surface-points';
    let focusDepth: number | undefined;
    let focusSurfaceWorld: [number, number, number] | undefined;
    let bboxCenterDepth: number | undefined;
    let bboxCenterSurfaceWorld: [number, number, number] | undefined;
    let maskBb2dForDebug: NormalizedBb2d | undefined;
    let maskAreaRatio: number | undefined;
    let forceAxisAligned = false;
    let broadSurfaceAnchor: [number, number, number] | undefined;
    let broadSurfacePrior = false;

    if (sam3Region && sam3Region.point_count >= 24) {
        selectedPoints = sam3Region.points;
        reason = 'sam3-click-mask-connected-region';
        maskBb2dForDebug = sam3Region.mask_bb2d;
        maskAreaRatio = sam3Region.mask_area_ratio;
    }

    if (focus) {
        const [clickX, clickY] = focus.click_xy;
        const clickDepth = sampleDepthArea(focus.depthBuffer, frame.image_width, frame.image_height, clickX, clickY);
        if (clickDepth > 0) {
            focusDepth = clickDepth;
            focusSurfaceWorld = unprojectDepthToWorld(frame, clickX, clickY, clickDepth);
        }
        const [bbCenterX, bbCenterY] = bbCenter(bb2d);
        const bbDepth = sampleDepthArea(focus.depthBuffer, frame.image_width, frame.image_height, bbCenterX, bbCenterY);
        if (bbDepth > 0) {
            bboxCenterDepth = bbDepth;
            bboxCenterSurfaceWorld = unprojectDepthToWorld(frame, bbCenterX, bbCenterY, bbDepth);
        }
        if (
            reason !== 'sam3-click-mask-connected-region' &&
            isBroadClickMiss(obb, bb2d, frame.image_width, frame.image_height)
        ) {
            const local = collectClickLocalCluster(splat, scene, frame, bb2d, clickX, clickY, clickDepth);
            if (local.cluster.length >= 2500) {
                selectedPoints = local.cluster.map(candidate => candidate.point);
                reason = 'click-local-front-surface-cluster';
                forceAxisAligned = true;
                maskBb2dForDebug = local.localBb;
                maskAreaRatio = local.localCandidateCount / Math.max(1, fullCandidates.length);
            }
        }
        const seed = findProjectedSeed(fullCandidates, clickX, clickY, clickDepth);
        if (
            reason !== 'sam3-click-mask-connected-region' &&
            reason !== 'click-local-front-surface-cluster' &&
            seed >= 0 &&
            bbAreaRatio >= CONNECTED_CLUSTER_BB_AREA_RATIO
        ) {
            const eps = Math.min(CLUSTER_EPS_MAX, Math.max(CLUSTER_EPS_MIN, fullCandidates[seed].depth * CLUSTER_EPS_FRAC_OF_DEPTH));
            const depthBand = Math.min(CLUSTER_DEPTH_MAX, Math.max(CLUSTER_DEPTH_MIN, fullCandidates[seed].depth * CLUSTER_DEPTH_FRAC_OF_DEPTH));
            const cluster = growProjectedCluster(fullCandidates, seed, eps, depthBand);
            if (cluster.length >= 24) {
                selectedPoints = cluster.map(candidate => candidate.point);
                reason = 'bbox-click-connected-cluster';
                if (
                    focusSurfaceWorld &&
                    isBroadClickMiss(obb, bb2d, frame.image_width, frame.image_height) &&
                    isBroadSurfaceLabel(obb.label)
                ) {
                    forceAxisAligned = true;
                    broadSurfaceAnchor = focusSurfaceWorld;
                    broadSurfacePrior = true;
                }
            }
        }

        const focusRadius = Math.max(80, Math.min(180, Math.max(width, height) * 0.35));
        const depthBand = clickDepth > 0 ? Math.max(1.25, clickDepth * 0.16) : Number.POSITIVE_INFINITY;
        const nearClick = boxedSurfacePoints.filter(({ sample }) => {
            const dist = Math.hypot(sample.pixel[0] - clickX, sample.pixel[1] - clickY);
            return dist <= focusRadius && Math.abs(sample.depth - clickDepth) <= depthBand;
        }).map(({ point }) => point);

        if (
            reason !== 'sam3-click-mask-connected-region' &&
            reason !== 'bbox-click-connected-cluster' &&
            reason !== 'click-local-front-surface-cluster' &&
            nearClick.length >= 24
        ) {
            selectedPoints = nearClick;
            reason = 'bbox-click-depth-neighborhood';
        } else {
            const nearPixel = boxedSurfacePoints.filter(({ sample }) => {
                return Math.hypot(sample.pixel[0] - clickX, sample.pixel[1] - clickY) <= focusRadius;
            }).map(({ point }) => point);
            if (
                reason !== 'sam3-click-mask-connected-region' &&
                reason !== 'bbox-click-connected-cluster' &&
                reason !== 'click-local-front-surface-cluster' &&
                nearPixel.length >= 24
            ) {
                selectedPoints = nearPixel;
                reason = 'bbox-click-neighborhood';
            }
        }
    }

    if (selectedPoints.length < 24) {
        return {
            applied: false,
            reason: 'too-few-boxed-points',
            point_count: selectedPoints.length,
            candidate_point_count: boxedSurfacePoints.length,
            full_candidate_point_count: fullCandidates.length
        };
    }

    let dimensionPrior: GeometryRefinement['dimension_prior'];
    let rotationPrior: GeometryRefinement['rotation_prior'];
    let axes: [number, number, number][] = forceAxisAligned ? [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1]
    ] : getObbAxes(obb.rotation);
    if (forceAxisAligned) {
        obb.rotation = [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1]
        ];
        rotationPrior = 'broad-click-axis-aligned';
    }
    const local: [number[], number[], number[]] = [[], [], []];
    for (const point of selectedPoints) {
        for (let axis = 0; axis < 3; axis++) {
            local[axis].push(
                point[0] * axes[axis][0] +
                point[1] * axes[axis][1] +
                point[2] * axes[axis][2]
            );
        }
    }

    for (const values of local) values.sort((a, b) => a - b);

    const outerExtents = summarizeSortedAxisExtents(local, 0.04, 0.96, 1.08);
    const coreExtents = summarizeSortedAxisExtents(local, 0.12, 0.88, 1.18);
    const mins = outerExtents.mins;
    const maxs = outerExtents.maxs;
    const observedDimensions = outerExtents.dimensions;
    const coreDimensions = coreExtents.dimensions;
    const modelDimensions = [...obb.dimensions] as [number, number, number];
    const compactClick = reason.startsWith('bbox-click') && bbAreaRatio <= COMPACT_CLICK_BB_AREA_RATIO;
    const clickLocalObserved = reason === 'click-local-front-surface-cluster';
    const broadSurfaceObserved = broadSurfacePrior && reason === 'bbox-click-connected-cluster';
    const sam3MaskObserved = reason === 'sam3-click-mask-connected-region';
    let robustObservedFit = false;
    let dimensions = [0, 1, 2].map((axis) => {
        const modelDim = obb.dimensions[axis] || 0;
        if (sam3MaskObserved || clickLocalObserved) {
            return observedDimensions[axis];
        }
        if (compactClick && modelDim > observedDimensions[axis] * 1.25) {
            return observedDimensions[axis];
        }
        const robustObserved = Math.min(
            observedDimensions[axis],
            Math.max(coreDimensions[axis], coreDimensions[axis] * 1.45)
        );
        const supportedObserved = observedDimensions[axis] > robustObserved * 1.18 ? robustObserved : observedDimensions[axis];
        if (supportedObserved < observedDimensions[axis] * 0.98) robustObservedFit = true;
        if (modelDim <= 0) return supportedObserved;
        if (observedDimensions[axis] > modelDim * 1.8) {
            return Math.max(modelDim * 1.05, supportedObserved);
        }
        return Math.max(modelDim, supportedObserved);
    }) as [number, number, number];
    if (broadSurfaceObserved) {
        dimensions = [
            Math.max(0.3, observedDimensions[0] * 1.4),
            Math.max(0.3, observedDimensions[1] * 0.75),
            Math.max(0.3, observedDimensions[2] * 1.15)
        ];
    }

    const aspectRatio = height / Math.max(1, width);
    if (!forceAxisAligned && reason.startsWith('bbox-click') && aspectRatio >= 1.5 && isLikelyVerticalObject(obb.label)) {
        const upAxis = axes
        .map((axis, index) => ({ index, score: Math.abs(axis[1]) }))
        .sort((a, b) => b.score - a.score)[0].index;
        const longestAxis = dimensions
        .map((dimension, index) => ({ index, dimension }))
        .sort((a, b) => b.dimension - a.dimension)[0].index;
        if (upAxis !== longestAxis) {
            const next = [...dimensions] as [number, number, number];
            next[upAxis] = dimensions[longestAxis];
            next[longestAxis] = dimensions[upAxis];
            dimensions = next;
            dimensionPrior = 'vertical-label-aspect';
        }
    }

    for (let axis = 0; axis < 3; axis++) {
        const mid = (mins[axis] + maxs[axis]) / 2;
        mins[axis] = mid - dimensions[axis] / 2;
        maxs[axis] = mid + dimensions[axis] / 2;
    }

    const mids: [number, number, number] = [
        (mins[0] + maxs[0]) / 2,
        (mins[1] + maxs[1]) / 2,
        (mins[2] + maxs[2]) / 2
    ];
    const center: [number, number, number] = broadSurfaceAnchor ? [
        broadSurfaceAnchor[0],
        broadSurfaceAnchor[1] + dimensions[1] * 0.25,
        broadSurfaceAnchor[2]
    ] : [
        axes[0][0] * mids[0] + axes[1][0] * mids[1] + axes[2][0] * mids[2],
        axes[0][1] * mids[0] + axes[1][1] * mids[1] + axes[2][1] * mids[2],
        axes[0][2] * mids[0] + axes[1][2] * mids[1] + axes[2][2] * mids[2]
    ];

    let centerAnchored = false;
    if (focusSurfaceWorld && isLikelyVerticalObject(obb.label) && reason === 'bbox-click-connected-cluster') {
        const upAxis = axes
        .map((axis, index) => ({ index, score: Math.abs(axis[1]) }))
        .sort((a, b) => b.score - a.score)[0].index;
        center[1] = focusSurfaceWorld[1] + dimensions[upAxis] * 0.2;
        centerAnchored = true;
    }

    obb.center = center;

    if (isLikelyVerticalObject(obb.label) && reason === 'bbox-click-depth-neighborhood') {
        const upAxis = axes
        .map((axis, index) => ({ index, score: Math.abs(axis[1]) }))
        .sort((a, b) => b.score - a.score)[0].index;
        const zAxis = axes
        .map((axis, index) => ({ index, score: index === upAxis ? -1 : Math.abs(axis[2]) }))
        .sort((a, b) => b.score - a.score)[0].index;
        const xAxis = [0, 1, 2].find(axis => axis !== upAxis && axis !== zAxis) ?? 0;
        dimensions = [
            dimensions[xAxis],
            dimensions[upAxis],
            dimensions[zAxis]
        ];
        axes = [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1]
        ];
        obb.rotation = [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1]
        ];
        rotationPrior = 'vertical-label-gravity-snap';
    }

    const rebuildRefinedCorners = () => {
        for (let axis = 0; axis < 3; axis++) {
            const mid = mids[axis];
            mins[axis] = mid - dimensions[axis] / 2;
            maxs[axis] = mid + dimensions[axis] / 2;
        }
        obb.dimensions = dimensions;
        if (rotationPrior === 'vertical-label-gravity-snap' || broadSurfaceAnchor || centerAnchored) {
            obb.corners = cornersFromCenterDimensions(center, dimensions, obb.rotation);
        } else {
            obb.corners = buildCornersFromAxes(axes, mins, maxs);
        }
    };

    rebuildRefinedCorners();
    let projectionFit = scoreDimensionProjectionFit(center, obb.rotation, dimensions, scene, frame, bb2d);
    const currentProjectionCandidate = projectionFit.candidates.find(candidate => (
        candidate.order[0] === 0 &&
        candidate.order[1] === 1 &&
        candidate.order[2] === 2
    ));
    const currentProjectionScore = currentProjectionCandidate?.score ?? projectionFit.best_score;
    const currentProjectionIou = currentProjectionCandidate?.bbox_iou ?? 0;
    const bestProjectionCandidate = projectionFit.candidates[0];
    const shouldApplyProjectionFit = (
        bestProjectionCandidate.score > currentProjectionScore + 0.01 &&
        bestProjectionCandidate.bbox_iou >= currentProjectionIou - 0.005
    );
    if (shouldApplyProjectionFit) {
        const appliedOrder = [...bestProjectionCandidate.order] as [number, number, number];
        dimensions = [...bestProjectionCandidate.dimensions] as [number, number, number];
        rebuildRefinedCorners();
        projectionFit = scoreDimensionProjectionFit(center, obb.rotation, dimensions, scene, frame, bb2d);
        projectionFit.applied = true;
        projectionFit.applied_order = appliedOrder;
        projectionFit.previous_score = currentProjectionScore;
        dimensionPrior = 'projection-fit';
    } else {
        projectionFit.applied = false;
        projectionFit.previous_score = currentProjectionScore;
    }
    const focusSurfaceCenterOffset = focusSurfaceWorld ? [
        focusSurfaceWorld[0] - center[0],
        focusSurfaceWorld[1] - center[1],
        focusSurfaceWorld[2] - center[2]
    ] as [number, number, number] : undefined;

    return {
        applied: true,
        reason,
        point_count: selectedPoints.length,
        candidate_point_count: boxedSurfacePoints.length,
        full_candidate_point_count: fullCandidates.length,
        center,
        dimensions,
        observed_dimensions: observedDimensions,
        model_dimensions: modelDimensions,
        dimension_source: sam3MaskObserved ?
            'sam3-mask-observed' :
            (
                clickLocalObserved ?
                    'click-local-observed' :
                    (
                        broadSurfaceObserved ?
                            'broad-surface-click-prior' :
                            (compactClick ? 'compact-click-observed' : (robustObservedFit ? 'robust-observed-fit' : 'model-or-observed-max'))
                    )
            ),
        dimension_prior: dimensionPrior,
        rotation_prior: rotationPrior,
        mask_bb2d: maskBb2dForDebug,
        mask_area_ratio: maskAreaRatio,
        focus_depth: focusDepth,
        focus_surface_world: focusSurfaceWorld,
        bbox_center_depth: bboxCenterDepth,
        bbox_center_surface_world: bboxCenterSurfaceWorld,
        focus_surface_center_offset: focusSurfaceCenterOffset,
        projection_fit: projectionFit
    };
};

const buildBoxerFramePayload = async (
    events: Events,
    scene: Scene,
    splat: Splat,
    canvas: HTMLCanvasElement,
    options?: {
        includeImage?: boolean;
        includeEncodedDepth?: boolean;
        skipDepth?: boolean;
    }
) => {
    const cam = scene.camera.camera;
    const imageWidth = canvas.clientWidth;
    const imageHeight = canvas.clientHeight;
    const includeImage = options?.includeImage ?? true;
    const includeEncodedDepth = options?.includeEncodedDepth ?? true;
    const image = includeImage ? await captureScene(events, imageWidth, imageHeight) : '';
    const intrinsics = extractIntrinsics(cam, imageWidth, imageHeight);
    const extrinsics = extractExtrinsics(cam);
    const geometryCache = getSplatWorldCenterCache(splat);
    const geometryCacheMs = geometryCache?.lastAccessBuildMs ?? 0;
    const geometryCacheReused = geometryCache?.reused ?? false;
    const skipDepth = options?.skipDepth === true;

    const depthT0 = performance.now();
    const emptyDepthBuffer: DepthBuffer = { data: new Float32Array(1), width: 1, height: 1 };
    const gpuDepthEnabled = !skipDepth && getBoxerGpuDepthEnabled();
    const gpuDepthBuffer = gpuDepthEnabled ? await renderGpuSplatDepth(splat, scene, imageWidth, imageHeight) : null;
    const gpuDepthSummary = gpuDepthBuffer ? summarizeDepth(gpuDepthBuffer) : null;
    const useGpuDepth = !skipDepth && gpuDepthSummary && gpuDepthSummary.valid >= 1000;
    const cpuDepthBuffer = skipDepth || useGpuDepth ? null : renderSplatDepth(splat, scene, imageWidth, imageHeight, intrinsics);
    const depthSource: BoxerFramePayload['depth_source'] = skipDepth ?
        'skipped-voxel-brush' :
        (useGpuDepth ? 'gpu-splat-footprint' : 'cpu-center-zbuffer');
    const backendDepthBuffer = skipDepth ?
        emptyDepthBuffer :
        (useGpuDepth && gpuDepthBuffer ? gpuDepthBuffer : cpuDepthBuffer!);
    const geometryDepthBuffer = backendDepthBuffer;
    const depthSummary = summarizeDepth(backendDepthBuffer);
    const sdpPatchDepths = buildSdpPatchDepths(backendDepthBuffer);
    const depth = includeEncodedDepth ? float32ToBase64(backendDepthBuffer.data) : '';
    const depthMs = performance.now() - depthT0;

    const pointsT0 = performance.now();
    let pointCloudSource: BoxerFramePayload['point_cloud_source'] = 'front_surface_centers';
    let sdpPoints = skipDepth ? [] : sampleSplatSurfacePoints(splat, scene, imageWidth, imageHeight, intrinsics, geometryDepthBuffer);
    if (!skipDepth && sdpPoints.length < Math.min(1000, MAX_SDP_POINTS / 4)) {
        pointCloudSource = 'frustum_centers';
        sdpPoints = sampleSplatCentersInFrustum(splat, scene);
    }
    const projectionSamples = buildProjectionSamples(sdpPoints, scene, intrinsics);
    const pointsMs = performance.now() - pointsT0;
    const depthVisibilityIndex = splatDepthVisibilityIndexes.get(splat);
    const depthVisibilityView = depthVisibilityIndex?.viewCaches.get(
        buildDepthVisibilityViewKey(scene, intrinsics, imageWidth, imageHeight)
    );
    let depthVisibilityVisibleTiles = 0;
    if (depthVisibilityView) {
        for (let i = 0; i < depthVisibilityView.visibleCount.length; i++) {
            if (depthVisibilityView.visibleCount[i] > 0) depthVisibilityVisibleTiles++;
        }
    }

    const frame: BoxerFramePayload = {
        image,
        intrinsics,
        extrinsics,
        gravity: [0, -1, 0],
        depth,
        depth_width: backendDepthBuffer.width,
        depth_height: backendDepthBuffer.height,
        depth_valid_pixels: depthSummary.valid,
        depth_valid_ratio: depthSummary.ratio,
        depth_min: depthSummary.min,
        depth_max: depthSummary.max,
        depth_source: depthSource,
        geometry_cache_count: geometryCache?.count,
        geometry_cache_ms: geometryCacheMs,
        geometry_cache_reused: geometryCacheReused,
        depth_visibility_index_ms: depthVisibilityIndex?.lastBuildMs,
        depth_visibility_view_ms: depthVisibilityView?.buildMs,
        depth_visibility_view_reused: depthVisibilityView?.reused,
        depth_visibility_tile_count: depthVisibilityView ? depthVisibilityView.tileWidth * depthVisibilityView.tileHeight : undefined,
        depth_visibility_visible_tiles: depthVisibilityView ? depthVisibilityVisibleTiles : undefined,
        point_cloud: sdpPoints,
        point_cloud_source: pointCloudSource,
        sdp_points: sdpPoints,
        sdp_point_count: sdpPoints.length,
        sdp_patch_depths: includeEncodedDepth ? float32ToBase64(sdpPatchDepths.data) : '',
        sdp_patch_width: sdpPatchDepths.width,
        sdp_patch_height: sdpPatchDepths.height,
        sdp_patch_size: BOXER_PATCH_SIZE,
        sdp_patch_valid_count: sdpPatchDepths.valid,
        boxer_model_hw: BOXER_MODEL_HW,
        image_preprocess: buildBoxerImagePreprocess(imageWidth, imageHeight, intrinsics),
        image_width: imageWidth,
        image_height: imageHeight,
        canvas_css_width: canvas.clientWidth,
        canvas_css_height: canvas.clientHeight,
        device_pixel_ratio: window.devicePixelRatio || 1,
        projection_samples: projectionSamples,
        boxer_contract_version: 2,
        bb2d_format: 'xyxy',
        official_boxer_bb2d_format: 'xxyy'
    };

    const gpuFallbackSummary = gpuDepthSummary && depthSource !== 'gpu-splat-footprint' ?
        ` gpu_valid=${gpuDepthSummary.valid}/${gpuDepthBuffer?.data.length ?? 0}` :
        '';
    const depthVisibilitySummary = depthVisibilityView ?
        ` visibility=${depthVisibilityView.reused ? 'hit' : 'build'}` +
            `:${depthVisibilityVisibleTiles}/${depthVisibilityView.tileWidth * depthVisibilityView.tileHeight}` +
            `/${depthVisibilityView.buildMs.toFixed(0)}ms` :
        '';
    console.log([
        `[Boxer] frame ${imageWidth}x${imageHeight}`,
        ` depth=${backendDepthBuffer.width}x${backendDepthBuffer.height}`,
        ` source=${depthSource}`,
        ` valid=${depthSummary.valid}/${backendDepthBuffer.data.length}`,
        ` (${(depthSummary.ratio * 100).toFixed(1)}%)`,
        ` range=${depthSummary.min.toFixed(2)}..${depthSummary.max.toFixed(2)}`,
        gpuFallbackSummary,
        ` cache=${geometryCacheReused ? 'hit' : 'build'}:${geometryCache?.count ?? 0}`,
        `/${geometryCacheMs.toFixed(0)}ms`,
        depthVisibilitySummary,
        ` sdp=${sdpPoints.length} source=${pointCloudSource}`,
        ` patches=${sdpPatchDepths.valid}/${sdpPatchDepths.data.length}`,
        ` samples=${projectionSamples.filter(s => s.in_frame).length}/${projectionSamples.length}`,
        ` (${depthMs.toFixed(0)}ms depth + ${pointsMs.toFixed(0)}ms points)`
    ].join(''));

    return { frame, depthBuffer: geometryDepthBuffer };
};

const compactBoxerFramePayload = (frame: BoxerFramePayload) => ({
    ...frame,
    image: `[base64 png ${frame.image.length} chars]`,
    depth: `[base64 float32 ${frame.depth.length} chars]`,
    sdp_patch_depths: `[base64 float32 ${frame.sdp_patch_depths.length} chars]`,
    point_cloud: frame.point_cloud.slice(0, DEBUG_SDP_PREVIEW_POINTS),
    sdp_points: frame.sdp_points.slice(0, DEBUG_SDP_PREVIEW_POINTS)
});

const publishBoxerFrameDebug = (frame: BoxerFramePayload) => {
    (window as any).__lastBoxerFrame = compactBoxerFramePayload(frame);
    (window as any).__lastBoxerFrameRaw = frame;
};

const publishBoxerResultDebug = (
    obb: OBBResult,
    rawObb: OBBResult | null,
    normalizedBb2d: NormalizedBb2d | null,
    recenter: RecenterDecision,
    geometryRefinement: GeometryRefinement
) => {
    (window as any).__lastBoxerResult = {
        ...obb,
        raw_boxer_result: rawObb,
        normalized_bb2d: normalizedBb2d,
        recenter,
        geometry_refinement: geometryRefinement
    };
};

const summarizeFrameForEval = (frame: BoxerFramePayload) => ({
    intrinsics: frame.intrinsics,
    extrinsics: frame.extrinsics,
    gravity: frame.gravity,
    image_width: frame.image_width,
    image_height: frame.image_height,
    depth_width: frame.depth_width,
    depth_height: frame.depth_height,
    depth_valid_pixels: frame.depth_valid_pixels,
    depth_valid_ratio: frame.depth_valid_ratio,
    depth_min: frame.depth_min,
    depth_max: frame.depth_max,
    depth_source: frame.depth_source,
    geometry_cache_count: frame.geometry_cache_count,
    geometry_cache_ms: frame.geometry_cache_ms,
    geometry_cache_reused: frame.geometry_cache_reused,
    depth_visibility_index_ms: frame.depth_visibility_index_ms,
    depth_visibility_view_ms: frame.depth_visibility_view_ms,
    depth_visibility_view_reused: frame.depth_visibility_view_reused,
    depth_visibility_tile_count: frame.depth_visibility_tile_count,
    depth_visibility_visible_tiles: frame.depth_visibility_visible_tiles,
    point_cloud_source: frame.point_cloud_source,
    sdp_point_count: frame.sdp_point_count,
    sdp_patch_width: frame.sdp_patch_width,
    sdp_patch_height: frame.sdp_patch_height,
    sdp_patch_size: frame.sdp_patch_size,
    sdp_patch_valid_count: frame.sdp_patch_valid_count,
    boxer_model_hw: frame.boxer_model_hw,
    image_preprocess: frame.image_preprocess,
    boxer_contract_version: frame.boxer_contract_version
});

const aabbFromCenterDimensions = (
    center: [number, number, number],
    dimensions: [number, number, number]
): Aabb => ({
    min: [
        center[0] - dimensions[0] / 2,
        center[1] - dimensions[1] / 2,
        center[2] - dimensions[2] / 2
    ],
    max: [
        center[0] + dimensions[0] / 2,
        center[1] + dimensions[1] / 2,
        center[2] + dimensions[2] / 2
    ]
});

const aabbFromCorners = (corners: number[][]): Aabb | null => {
    if (!corners.length) return null;
    const min: [number, number, number] = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
    const max: [number, number, number] = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (const corner of corners) {
        for (let axis = 0; axis < 3; axis++) {
            min[axis] = Math.min(min[axis], corner[axis]);
            max[axis] = Math.max(max[axis], corner[axis]);
        }
    }
    return { min, max };
};

const cornersFromObb = (
    center: [number, number, number],
    dimensions: [number, number, number],
    rotation: number[][]
) => {
    const axes = getObbAxes(rotation);
    const halves: [number, number, number] = [dimensions[0] / 2, dimensions[1] / 2, dimensions[2] / 2];
    const corners: number[][] = [];

    for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
            for (const sz of [-1, 1]) {
                corners.push([
                    center[0] + axes[0][0] * halves[0] * sx + axes[1][0] * halves[1] * sy + axes[2][0] * halves[2] * sz,
                    center[1] + axes[0][1] * halves[0] * sx + axes[1][1] * halves[1] * sy + axes[2][1] * halves[2] * sz,
                    center[2] + axes[0][2] * halves[0] * sx + axes[1][2] * halves[1] * sy + axes[2][2] * halves[2] * sz
                ]);
            }
        }
    }

    return corners;
};

const aabbVolume = (aabb: Aabb) => (
    Math.max(0, aabb.max[0] - aabb.min[0]) *
    Math.max(0, aabb.max[1] - aabb.min[1]) *
    Math.max(0, aabb.max[2] - aabb.min[2])
);

const aabbIou = (a: Aabb, b: Aabb) => {
    const intersection: Aabb = {
        min: [
            Math.max(a.min[0], b.min[0]),
            Math.max(a.min[1], b.min[1]),
            Math.max(a.min[2], b.min[2])
        ],
        max: [
            Math.min(a.max[0], b.max[0]),
            Math.min(a.max[1], b.max[1]),
            Math.min(a.max[2], b.max[2])
        ]
    };
    const intersectionVolume = aabbVolume(intersection);
    const unionVolume = aabbVolume(a) + aabbVolume(b) - intersectionVolume;
    return unionVolume > 0 ? intersectionVolume / unionVolume : 0;
};

const pointInAabb = (
    point: [number, number, number],
    aabb: Aabb,
    epsilon = 0
) => (
    point[0] >= aabb.min[0] - epsilon &&
    point[0] <= aabb.max[0] + epsilon &&
    point[1] >= aabb.min[1] - epsilon &&
    point[1] <= aabb.max[1] + epsilon &&
    point[2] >= aabb.min[2] - epsilon &&
    point[2] <= aabb.max[2] + epsilon
);

const summarizeAabbPointCoverage = (
    points: [number, number, number][],
    aabb: Aabb,
    epsilon = 0
) => {
    let inside = 0;
    for (const point of points) {
        if (pointInAabb(point, aabb, epsilon)) inside++;
    }
    return {
        inside_count: inside,
        total_count: points.length,
        coverage: points.length ? inside / points.length : 0
    };
};

const summarizePointAabb = (points: number[][]): { center: [number, number, number]; dimensions: [number, number, number]; aabb: Aabb } | null => {
    if (points.length < 3) return null;
    const sorted = [0, 1, 2].map(axis => points.map(point => point[axis]).sort((a, b) => a - b));
    const { mins: min, maxs: max, dimensions } = summarizeSortedAxisExtents(sorted, 0.04, 0.96);
    return {
        center: [
            (min[0] + max[0]) / 2,
            (min[1] + max[1]) / 2,
            (min[2] + max[2]) / 2
        ],
        dimensions,
        aabb: { min, max }
    };
};

const summarizePointAabbRobust = (
    points: number[][],
    depthAxis?: number,
    depthSpread?: number
): { center: [number, number, number]; dimensions: [number, number, number]; aabb: Aabb } | null => {
    if (points.length < 3) return null;
    const sorted = [0, 1, 2].map(axis => points.map(point => point[axis]).sort((a, b) => a - b));
    const trim = points.length >= 1200 ? 0.12 : (points.length >= 250 ? 0.09 : 0.06);
    const { mins: min, maxs: max, dimensions } = summarizeSortedAxisExtents(sorted, trim, 1 - trim, 1.04);
    if (depthAxis !== undefined && depthSpread !== undefined && Number.isFinite(depthSpread)) {
        const rawDepthAxisDim = dimensions[depthAxis];
        const depthLimitedDim = Math.max(0.08, depthSpread * 1.35);
        dimensions[depthAxis] = Math.min(rawDepthAxisDim, Math.max(depthLimitedDim, rawDepthAxisDim * 0.72));
        const mid = (min[depthAxis] + max[depthAxis]) / 2;
        min[depthAxis] = mid - dimensions[depthAxis] / 2;
        max[depthAxis] = mid + dimensions[depthAxis] / 2;
    }
    return {
        center: [
            (min[0] + max[0]) / 2,
            (min[1] + max[1]) / 2,
            (min[2] + max[2]) / 2
        ],
        dimensions,
        aabb: { min, max }
    };
};

const scoreGeometryAabbFit = (
    obb: OBBResult,
    splatSummary: { center: [number, number, number]; dimensions: [number, number, number]; aabb: Aabb } | null | undefined
): DirectLiftGeometryFit | null => {
    if (!splatSummary) return null;
    const predictedAabb = aabbFromCorners(obb.corners);
    if (!predictedAabb) return null;
    const centerDistance = Math.hypot(
        obb.center[0] - splatSummary.center[0],
        obb.center[1] - splatSummary.center[1],
        obb.center[2] - splatSummary.center[2]
    );
    const extentDiag = Math.max(0.01, Math.hypot(...splatSummary.dimensions));
    const centerDistanceExtentRatio = centerDistance / extentDiag;
    const fitIou = aabbIou(predictedAabb, splatSummary.aabb);
    return {
        aabb_iou: fitIou,
        center_distance: centerDistance,
        center_distance_extent_ratio: centerDistanceExtentRatio,
        score: fitIou - centerDistanceExtentRatio * 0.2,
        splat_aabb: splatSummary.aabb,
        predicted_aabb: predictedAabb
    };
};

const applyRayDimensionPrior = (
    obb: BoxerResponse,
    bb2d: NormalizedBb2d,
    scene: Scene,
    frame: BoxerFramePayload,
    depthBuffer?: DepthBuffer,
    focusClick?: { x: number; y: number }
): GeometryRefinement => {
    const centerProjection = projectWorldPointToImage(obb.center, scene, frame.intrinsics);
    const rayDebug = depthBuffer ? buildMultiRayDepthDebug(frame, depthBuffer, bb2d, focusClick) : null;
    const depth = rayDebug?.stats?.median ?? (centerProjection.depth > 0 ? centerProjection.depth : null);
    if (!depth) {
        return { applied: false, reason: 'ray-dimension-missing-depth' };
    }

    const proposalCenter = bbCenter(bb2d);
    const rayCenterSample = rayDebug?.samples.find(sample => sample.id === 'center') ??
        rayDebug?.samples.find(sample => sample.id === 'click');
    const rayCenter = rayCenterSample?.world ?? unprojectDepthToWorld(frame, proposalCenter[0], proposalCenter[1], depth);
    const bbWidth = Math.max(1, bb2d[2] - bb2d[0]);
    const bbHeight = Math.max(1, bb2d[3] - bb2d[1]);
    const estimatedWidth = bbWidth / Math.max(1, frame.intrinsics.fx) * depth;
    const estimatedHeight = bbHeight / Math.max(1, frame.intrinsics.fy) * depth;
    const estimatedThickness = rayDebug?.stats ?
        Math.max(estimatedWidth * 0.35, Math.min(estimatedWidth * 1.35, rayDebug.stats.spread * 1.15)) :
        estimatedWidth;
    const axes = getObbAxes(obb.rotation);
    const upAxis = axes
    .map((axis, index) => ({ index, score: Math.abs(axis[1]) }))
    .sort((a, b) => b.score - a.score)[0].index;
    const otherAxes = [0, 1, 2].filter(axis => axis !== upAxis);
    const aspect = bbHeight / bbWidth;
    const recenterToRay = aspect > 1.15;
    const modelDimensions = [...obb.dimensions] as [number, number, number];
    const dimensions = [...obb.dimensions] as [number, number, number];

    if (aspect > 1.15) {
        dimensions[upAxis] = Math.max(0.05, estimatedHeight * 0.85);
        dimensions[otherAxes[0]] = Math.max(0.05, estimatedWidth * 0.72);
        dimensions[otherAxes[1]] = Math.max(0.05, estimatedThickness * 0.72);
    } else {
        dimensions[upAxis] = Math.max(0.05, estimatedHeight * 0.7);
        dimensions[otherAxes[0]] = Math.max(0.05, estimatedWidth * 0.8);
        dimensions[otherAxes[1]] = Math.max(0.05, estimatedThickness * 0.8);
    }

    const center = recenterToRay ? rayCenter : obb.center;
    obb.center = center;
    obb.dimensions = dimensions;
    obb.corners = cornersFromCenterDimensions(center, dimensions, obb.rotation);

    return {
        applied: true,
        reason: recenterToRay ? 'ray-dimension-prior-recentered' : 'ray-dimension-prior',
        center,
        dimensions,
        observed_dimensions: [estimatedWidth, estimatedHeight, depth],
        model_dimensions: modelDimensions,
        dimension_source: aspect > 1.15 ? 'ray-tall-bb2d' : 'ray-wide-bb2d',
        dimension_prior: 'ray-dimension-prior',
        ray_sample_count: rayDebug?.samples.length,
        ray_depth_stats: rayDebug?.stats ?? undefined,
        ray_samples: rayDebug?.samples.slice(0, 24),
        projection_fit: scoreDimensionProjectionFit(center, obb.rotation, dimensions, scene, frame, bb2d)
    };
};

const buildEvalMetrics = (result: OBBResult, target?: BoxerEvalTarget | null) => {
    if (!target) return null;
    const predictedAabb = aabbFromCorners(result.corners);
    if (!predictedAabb) return null;

    const targetAabb = aabbFromCenterDimensions(target.center, target.dimensions);
    const axes = getObbAxes(result.rotation);
    const dimensionPermutations = [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0]
    ] as const;
    const permutationMetrics = dimensionPermutations.map((order) => {
        const dimensions = order.map(axis => result.dimensions[axis]) as [number, number, number];
        const aabb = aabbFromCorners(cornersFromObb(result.center, dimensions, result.rotation));
        return {
            order,
            dimensions,
            aabb_iou: aabb ? aabbIou(aabb, targetAabb) : 0,
            aabb
        };
    }).sort((a, b) => b.aabb_iou - a.aabb_iou);
    const centerDistance = Math.hypot(
        result.center[0] - target.center[0],
        result.center[1] - target.center[1],
        result.center[2] - target.center[2]
    );

    return {
        center_distance: centerDistance,
        aabb_iou: aabbIou(predictedAabb, targetAabb),
        predicted_aabb: predictedAabb,
        target_aabb: targetAabb,
        dimension_ratio: [
            result.dimensions[0] / Math.max(1e-6, target.dimensions[0]),
            result.dimensions[1] / Math.max(1e-6, target.dimensions[1]),
            result.dimensions[2] / Math.max(1e-6, target.dimensions[2])
        ],
        axis_alignment: axes.map((axis, local_axis) => ({
            local_axis,
            dimension: result.dimensions[local_axis],
            axis,
            abs_world_x: Math.abs(axis[0]),
            abs_world_y: Math.abs(axis[1]),
            abs_world_z: Math.abs(axis[2])
        })),
        best_dimension_permutation: permutationMetrics[0],
        dimension_permutation_metrics: permutationMetrics
    };
};

const buildBb2dTargetMetrics = (
    bb2d: NormalizedBb2d | null | undefined,
    targetBb2d: NormalizedBb2d | null | undefined
) => {
    if (!bb2d || !targetBb2d) return null;
    const center = bbCenter(bb2d);
    const targetCenter = bbCenter(targetBb2d);
    const targetDiag = Math.max(1, Math.hypot(targetBb2d[2] - targetBb2d[0], targetBb2d[3] - targetBb2d[1]));
    const coverage = buildBb2dCoverageStats(bb2d, targetBb2d);
    return {
        bb2d_iou: coverage.iou,
        bb2d_covered_by_target: coverage.a_covered_by_b,
        target_covered_by_bb2d: coverage.b_covered_by_a,
        center_distance_px: Math.hypot(center[0] - targetCenter[0], center[1] - targetCenter[1]),
        center_distance_target_diag_ratio: Math.hypot(center[0] - targetCenter[0], center[1] - targetCenter[1]) / targetDiag,
        area_ratio_to_target: (
            (bb2d[2] - bb2d[0]) * (bb2d[3] - bb2d[1])
        ) / Math.max(1, (targetBb2d[2] - targetBb2d[0]) * (targetBb2d[3] - targetBb2d[1]))
    };
};

const buildBb2dCoverageStats = (a: NormalizedBb2d, b: NormalizedBb2d) => {
    const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
    const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
    const intersectionArea = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
        Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    const union = areaA + areaB - intersectionArea;
    return {
        iou: union > 0 ? intersectionArea / union : 0,
        a_covered_by_b: areaA > 0 ? intersectionArea / areaA : 0,
        b_covered_by_a: areaB > 0 ? intersectionArea / areaB : 0,
        area_ratio_a_to_b: areaB > 0 ? areaA / areaB : null
    };
};

const formatEvalQualityWarning = (warning: string) => {
    switch (warning) {
        case 'camera-changed-after-run':
            return 'camera changed';
        case 'target-not-visible-from-captured-camera':
            return 'target not visible';
        case 'prompt-target-2d-coverage-low':
            return 'brush misses target';
        case 'result-target-2d-overlap-low':
            return 'result misses target';
        default:
            return warning;
    }
};

const buildClientLiftSeedObb = (
    frame: BoxerFramePayload,
    splat: Splat,
    scene: Scene,
    bb2d: NormalizedBb2d
) => {
    const pointCloudCandidates = frame.point_cloud.map(point => ({
        point,
        sample: projectWorldPointToImage(point, scene, frame.intrinsics)
    })).filter(({ sample }) => sample.in_frame && bbContainsPoint(bb2d, sample.pixel[0], sample.pixel[1]));
    const projectedCandidates = collectProjectedSplatCandidates(splat, scene, frame.intrinsics, bb2d);
    const frontSurfaceCandidates = filterFrontSurfaceProjectedCandidates(
        projectedCandidates,
        frame.image_width,
        frame.image_height
    );
    const seedPoints = pointCloudCandidates.length >= 24 ?
        pointCloudCandidates.map(candidate => candidate.point) :
        (
            frontSurfaceCandidates.length >= 3 ?
                frontSurfaceCandidates.map(candidate => candidate.point) :
                projectedCandidates.map(candidate => candidate.point)
        );

    if (seedPoints.length < 3) {
        throw new Error('client_lift_target_box found too few splat points in the projected target box');
    }

    const sorted = [0, 1, 2].map(axis => seedPoints.map(point => point[axis]).sort((a, b) => a - b));
    const mins = sorted.map(values => quantile(values, 0.04)) as [number, number, number];
    const maxs = sorted.map(values => quantile(values, 0.96)) as [number, number, number];
    const center: [number, number, number] = [
        (mins[0] + maxs[0]) / 2,
        (mins[1] + maxs[1]) / 2,
        (mins[2] + maxs[2]) / 2
    ];
    const dimensions: [number, number, number] = [0.05, 0.05, 0.05];
    const rotation = [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1]
    ];
    const obb: OBBResult = {
        center,
        dimensions,
        rotation,
        corners: cornersFromCenterDimensions(center, dimensions, rotation),
        label: 'client_lift_target_box',
        confidence: 1,
        score2d: 1,
        bb2d,
        bb2d_format: 'xyxy',
        source: 'client_lift_target_box',
        source_bb2d: bb2d
    };

    return {
        obb,
        debug: {
            bb2d,
            point_cloud_candidate_count: pointCloudCandidates.length,
            projected_candidate_count: projectedCandidates.length,
            front_surface_candidate_count: frontSurfaceCandidates.length,
            seed_point_count: seedPoints.length,
            broad_seed_dimensions: [0, 1, 2].map(axis => Math.max(0.05, maxs[axis] - mins[axis])) as [number, number, number],
            seed_point_source: pointCloudCandidates.length >= 24 ?
                'frame-point-cloud' :
                (frontSurfaceCandidates.length >= 3 ? 'front-surface-candidates' : 'projected-candidates')
        }
    };
};

const buildAxisAlignedObbFromAabb = (
    aabb: Aabb,
    label: string,
    source: string,
    bb2d?: NormalizedBb2d
): OBBResult => {
    const center: [number, number, number] = [
        (aabb.min[0] + aabb.max[0]) / 2,
        (aabb.min[1] + aabb.max[1]) / 2,
        (aabb.min[2] + aabb.max[2]) / 2
    ];
    const dimensions: [number, number, number] = [
        Math.max(0.05, aabb.max[0] - aabb.min[0]),
        Math.max(0.05, aabb.max[1] - aabb.min[1]),
        Math.max(0.05, aabb.max[2] - aabb.min[2])
    ];
    const rotation = [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1]
    ];
    return {
        center,
        dimensions,
        rotation,
        corners: cornersFromCenterDimensions(center, dimensions, rotation),
        label,
        confidence: 1,
        score2d: 1,
        bb2d,
        bb2d_format: 'xyxy',
        source,
        source_bb2d: bb2d
    };
};

const expandAxisAlignedObb = (
    obb: OBBResult,
    factors: [number, number, number],
    source: string
): OBBResult => {
    const expanded = cloneObb(obb);
    expanded.dimensions = [
        Math.max(0.05, obb.dimensions[0] * factors[0]),
        Math.max(0.05, obb.dimensions[1] * factors[1]),
        Math.max(0.05, obb.dimensions[2] * factors[2])
    ];
    expanded.corners = cornersFromCenterDimensions(expanded.center, expanded.dimensions, expanded.rotation);
    expanded.source = source;
    return expanded;
};

const applyClientVisibleSurfacePrior = (
    refined: OBBResult,
    raw: OBBResult
): { obb: OBBResult; applied: boolean; factors: [number, number, number] } => {
    const factors: [number, number, number] = [1.25, 1.85, 1.35];
    const expanded = expandAxisAlignedObb(refined, factors, 'client_click_visible_surface_prior');
    expanded.dimensions = [
        Math.min(expanded.dimensions[0], Math.max(refined.dimensions[0], raw.dimensions[0] * 0.45)),
        Math.min(expanded.dimensions[1], Math.max(refined.dimensions[1], raw.dimensions[1] * 1.05)),
        Math.min(expanded.dimensions[2], Math.max(refined.dimensions[2], raw.dimensions[2] * 0.45))
    ];
    expanded.corners = cornersFromCenterDimensions(expanded.center, expanded.dimensions, expanded.rotation);
    return { obb: expanded, applied: true, factors };
};

const buildClientClickObb = (
    frame: BoxerFramePayload,
    splat: Splat,
    scene: Scene,
    depthBuffer: DepthBuffer,
    clickX: number,
    clickY: number
) => {
    const clickDepth = sampleDepthArea(depthBuffer, frame.image_width, frame.image_height, clickX, clickY);
    if (clickDepth <= 0) {
        throw new Error('client_click could not read depth at the click');
    }

    const fullFrame: NormalizedBb2d = [0, 0, frame.image_width, frame.image_height];
    const local = collectClickLocalCluster(splat, scene, frame, fullFrame, clickX, clickY, clickDepth);
    const fallbackDepthBand = Math.min(1.25, Math.max(0.35, clickDepth * 0.04));
    const depthWindow = local.supportCandidates.filter(candidate => Math.abs(candidate.depth - clickDepth) <= fallbackDepthBand);
    const knnSourceCandidates = depthWindow.length >= 24 ? depthWindow : local.supportCandidates;
    const knnSeed = findProjectedSeed(knnSourceCandidates, clickX, clickY, clickDepth);
    const knnStrictMaxPoints = 1800;
    const knnRelaxedMaxPoints = 2600;
    const knnStrictCluster = growProjectedKnnCluster(knnSourceCandidates, knnSeed, {
        k: 5,
        cellSize: Math.min(0.22, Math.max(0.06, clickDepth * 0.008)),
        maxSpatialDistance: Math.min(0.3, Math.max(0.1, clickDepth * 0.012)),
        maxPixelDistance: Math.min(52, Math.max(22, clickDepth * 2.9)),
        maxSeedDepthDelta: Math.min(0.85, Math.max(0.28, clickDepth * 0.04)),
        maxNeighborDepthDelta: Math.min(0.28, Math.max(0.07, clickDepth * 0.012)),
        maxPoints: knnStrictMaxPoints
    });
    const knnRelaxedCluster = knnStrictCluster.length >= 24 ? [] : growProjectedKnnCluster(knnSourceCandidates, knnSeed, {
        k: 8,
        cellSize: Math.min(0.34, Math.max(0.09, clickDepth * 0.013)),
        maxSpatialDistance: Math.min(0.46, Math.max(0.16, clickDepth * 0.02)),
        maxPixelDistance: Math.min(78, Math.max(32, clickDepth * 4.5)),
        maxSeedDepthDelta: Math.min(1.25, Math.max(0.42, clickDepth * 0.06)),
        maxNeighborDepthDelta: Math.min(0.46, Math.max(0.13, clickDepth * 0.022)),
        maxPoints: knnRelaxedMaxPoints
    });
    const knnCluster = knnStrictCluster.length >= 24 ? knnStrictCluster : knnRelaxedCluster;
    const knnClusterCapped = knnStrictCluster.length >= knnStrictMaxPoints || knnRelaxedCluster.length >= knnRelaxedMaxPoints;
    const knnClusterBb = bboxFromProjectedCandidates(knnCluster, frame.image_width, frame.image_height);
    const selectedCluster = local.cluster.length >= 24 ?
        local.cluster :
        (depthWindow.length >= 24 ? depthWindow : local.supportCandidates);
    const clusterBb = bboxFromProjectedCandidates(selectedCluster, frame.image_width, frame.image_height);
    if (!clusterBb || selectedCluster.length < 8) {
        throw new Error(`client_click found too few local points (${selectedCluster.length}; connected ${local.cluster.length})`);
    }

    const depthComponent = depthConnectedBb2d(depthBuffer, frame.image_width, frame.image_height, clickX, clickY, clickDepth);
    const candidateBbs: { scale: number; bb: NormalizedBb2d; source: 'splat_cluster' | 'depth_component' | 'knn_cluster' }[] = [];
    const addCandidateBb = (
        scale: number,
        bb: NormalizedBb2d | null,
        source: 'splat_cluster' | 'depth_component' | 'knn_cluster'
    ) => {
        if (!bb) return;
        if (candidateBbs.some(candidate => bb2dIou(candidate.bb, bb) > 0.94)) return;
        candidateBbs.push({ scale, bb, source });
    };
    if (depthComponent) {
        for (const scale of [1.0, 1.25, 1.55, 1.9, 2.4]) {
            const bb = expandBb2d(depthComponent.bb2d, scale, frame.image_width, frame.image_height);
            addCandidateBb(scale, bb, 'depth_component');
        }
    }
    if (local.cluster.length >= 24 || !depthComponent) {
        for (const scale of [0.85, 1.0, 1.15, 1.25, 1.45, 1.55, 1.85, 1.9, 2.4, 3.1]) {
            const bb = expandBb2d(clusterBb, scale, frame.image_width, frame.image_height);
            addCandidateBb(scale, bb, 'splat_cluster');
        }
    }
    if (knnClusterBb && knnCluster.length >= 24 && !knnClusterCapped) {
        for (const scale of [0.95, 1.1, 1.3, 1.55]) {
            const bb = expandBb2d(knnClusterBb, scale, frame.image_width, frame.image_height);
            addCandidateBb(scale, bb, 'knn_cluster');
        }
    }
    const view = scene.camera.camera.viewMatrix.data as Float32Array;
    const cameraDepthAxis = [
        Math.abs(view[2]),
        Math.abs(view[6]),
        Math.abs(view[10])
    ].map((score, index) => ({ index, score })).sort((a, b) => b.score - a.score)[0].index;
    const candidates = candidateBbs.map(({ scale, bb, source }) => {
        const projected = collectProjectedSplatCandidates(splat, scene, frame.intrinsics, bb);
        const frontSurface = filterFrontSurfaceProjectedCandidates(projected, frame.image_width, frame.image_height);
        const selectedClusterCandidates = source === 'splat_cluster' ?
            selectedCluster.filter(candidate => bbContainsPoint(bb, candidate.pixel[0], candidate.pixel[1])) :
            (
                source === 'knn_cluster' ?
                    knnCluster.filter(candidate => bbContainsPoint(bb, candidate.pixel[0], candidate.pixel[1])) :
                    []
            );
        const baseCandidates = frontSurface.length >= 24 ? frontSurface : projected;
        const candidateDepthBand = Math.min(1.15, Math.max(0.28, clickDepth * (source === 'depth_component' ? 0.055 : 0.04)));
        const depthConsistent = baseCandidates.filter(candidate => Math.abs(candidate.depth - clickDepth) <= candidateDepthBand);
        const summaryCandidates = source === 'knn_cluster' && selectedClusterCandidates.length >= 24 ?
            selectedClusterCandidates :
            (depthConsistent.length >= 24 ? depthConsistent : baseCandidates);
        const points = summaryCandidates.map(candidate => candidate.point);
        const candidateBrushAspect = (bb[3] - bb[1]) / Math.max(1, bb[2] - bb[0]);
        const sortedDepths = summaryCandidates.map(candidate => candidate.depth).sort((a, b) => a - b);
        const depthSpread = sortedDepths.length >= 3 ?
            Math.max(0.05, quantile(sortedDepths, 0.88) - quantile(sortedDepths, 0.12)) :
            undefined;
        const summary = summarizePointAabbRobust(points, cameraDepthAxis, depthSpread) ?? summarizePointAabb(points);
        if (!summary) return null;
        const obb = buildAxisAlignedObbFromAabb(summary.aabb, 'client_click', 'client_click', bb);
        const projectionFit = scoreDimensionProjectionFit(obb.center, obb.rotation, obb.dimensions, scene, frame, bb);
        const clickProjection = projectWorldPointToImage(obb.center, scene, frame.intrinsics);
        const clickCenterPenalty = clickProjection.in_frame ?
            Math.hypot(clickProjection.pixel[0] - clickX, clickProjection.pixel[1] - clickY) /
                Math.max(1, Math.hypot(bb[2] - bb[0], bb[3] - bb[1])) :
            1;
        const focusOffsetPenalty = Math.abs(clickProjection.depth - clickDepth) / Math.max(1, clickDepth) * 0.45;
        const depthSupportRatio = depthConsistent.length / Math.max(1, baseCandidates.length);
        const depthSupportBonus = Math.min(0.08, Math.log10(Math.max(1, depthConsistent.length)) * 0.025);
        const weakDepthPenalty = depthSupportRatio < 0.25 ? (0.25 - depthSupportRatio) * 0.7 : 0;
        const areaRatio = (bb[2] - bb[0]) * (bb[3] - bb[1]) / Math.max(1, frame.image_width * frame.image_height);
        const areaPenalty = areaRatio * 0.35 + Math.max(0, areaRatio - 0.035) * 3.0;
        const tinyAreaPenalty = Math.max(0, 0.006 - areaRatio) * 90;
        const smallScalePenalty = source === 'splat_cluster' && scale < 1 ? (1 - scale) * 0.55 : 0;
        const brokenConnectivityDepthPenalty = source === 'depth_component' && local.cluster.length < 24 && depthSupportRatio < 0.05 ? 0.5 : 0;
        const scalePenalty = Math.max(0, scale - 1.55) * 0.04;
        const extentPenalty = Math.max(0, Math.hypot(obb.dimensions[0], obb.dimensions[2]) - clickDepth * 0.38) * 0.025;
        const relaxedDepthPenalty = source === 'depth_component' && depthComponent?.relaxed && (depthComponent.pixel_count ?? 0) < 128 ? 0.45 : 0;
        const sparseDepthPenalty = source === 'depth_component' && depthConsistent.length < 24 ? 0.35 : 0;
        const knnSupportBonus = source === 'knn_cluster' ?
            Math.min(0.05, Math.log10(Math.max(1, selectedClusterCandidates.length)) * 0.012 + depthSupportRatio * 0.03) :
            0;
        const knnWeakPenalty = source === 'knn_cluster' && selectedClusterCandidates.length < 64 ? 0.28 : 0;
        const projectionRescueBonus = (
            source === 'depth_component' &&
            local.cluster.length < 128 &&
            depthSupportRatio >= 0.06 &&
            depthConsistent.length >= 96 &&
            projectionFit.best_score >= 0.72
        ) ? 0.18 : 0;
        return {
            bb,
            obb,
            scale,
            source,
            point_count: points.length,
            selected_cluster_candidate_count: selectedClusterCandidates.length,
            depth_consistent_point_count: depthConsistent.length,
            depth_support_ratio: depthSupportRatio,
            candidate_depth_band: candidateDepthBand,
            depth_spread: depthSpread,
            depth_axis: cameraDepthAxis,
            projected_candidate_count: projected.length,
            front_surface_candidate_count: frontSurface.length,
            projection_fit: projectionFit,
            projection_rescue_bonus: projectionRescueBonus,
            selection_score: projectionFit.best_score + Math.log10(Math.max(10, points.length)) * 0.015 + depthSupportBonus - clickCenterPenalty * 0.2 - focusOffsetPenalty - weakDepthPenalty - areaPenalty - tinyAreaPenalty - smallScalePenalty - brokenConnectivityDepthPenalty - scalePenalty - extentPenalty - relaxedDepthPenalty - sparseDepthPenalty +
                (source === 'depth_component' ? 0.06 : 0) + knnSupportBonus - knnWeakPenalty + projectionRescueBonus
        };
    }).filter((candidate): candidate is NonNullable<typeof candidate> => !!candidate)
    .sort((a, b) => b.selection_score - a.selection_score);

    if (candidates.length === 0) {
        throw new Error('client_click could not build a local OBB candidate');
    }

    return {
        obb: candidates[0].obb,
        bb2d: candidates[0].bb,
        debug: {
            click_depth: clickDepth,
            local_bb2d: local.localBb,
            cluster_bb2d: clusterBb,
            knn_cluster_bb2d: knnClusterBb,
            local_candidate_count: local.localCandidateCount,
            front_surface_candidate_count: local.frontSurfaceCandidateCount,
            cluster_point_count: selectedCluster.length,
            connected_cluster_point_count: local.cluster.length,
            knn_cluster_point_count: knnCluster.length,
            knn_cluster_relaxed: knnStrictCluster.length < 24 && knnRelaxedCluster.length >= 24,
            knn_cluster_capped: knnClusterCapped,
            knn_source_candidate_count: knnSourceCandidates.length,
            depth_window_point_count: depthWindow.length,
            fallback_depth_band: fallbackDepthBand,
            depth_component_bb2d: depthComponent?.bb2d,
            depth_component_pixel_count: depthComponent?.pixel_count,
            depth_component_seed_depth: depthComponent?.seed_depth,
            depth_component_relaxed: depthComponent?.relaxed,
            selected_candidate_source: candidates[0].source,
            selected_candidate_scale: candidates[0].scale,
            candidates: candidates.map(candidate => ({
                bb2d: candidate.bb,
                source: candidate.source,
                scale: candidate.scale,
                point_count: candidate.point_count,
                selected_cluster_candidate_count: candidate.selected_cluster_candidate_count,
                depth_consistent_point_count: candidate.depth_consistent_point_count,
                depth_support_ratio: candidate.depth_support_ratio,
                candidate_depth_band: candidate.candidate_depth_band,
                depth_spread: candidate.depth_spread,
                depth_axis: candidate.depth_axis,
                projected_candidate_count: candidate.projected_candidate_count,
                front_surface_candidate_count: candidate.front_surface_candidate_count,
                projection_rescue_bonus: candidate.projection_rescue_bonus,
                selection_score: candidate.selection_score,
                projection_fit: candidate.projection_fit
            }))
        }
    };
};

const resolveClientBrushRegion = (
    frame: BoxerFramePayload,
    brush: BoxerBrushPrompt | undefined,
    fallbackClick?: [number, number]
) => {
    const shape = brush?.shape ?? 'circle';
    const center: [number, number] = brush?.center_xy ??
        fallbackClick ??
        [frame.image_width / 2, frame.image_height / 2];
    const defaultRadius = Math.max(24, Math.min(frame.image_width, frame.image_height) * 0.08);
    const pad = brush?.pad ?? 0;
    const points = brush?.points ?? [];
    const pointBounds = points.length > 0 ? points.reduce((bounds, point) => {
        bounds[0] = Math.min(bounds[0], point[0]);
        bounds[1] = Math.min(bounds[1], point[1]);
        bounds[2] = Math.max(bounds[2], point[0]);
        bounds[3] = Math.max(bounds[3], point[1]);
        return bounds;
    }, [Infinity, Infinity, -Infinity, -Infinity] as NormalizedBb2d) : null;
    const brushBbMaxDimension = brush?.bb2d ?
        Math.max(brush.bb2d[2] - brush.bb2d[0], brush.bb2d[3] - brush.bb2d[1]) :
        0;
    const radius = brush?.radius ?? Math.max(
        1,
        pointBounds ?
            Math.min(frame.image_width, frame.image_height) * 0.035 :
            Math.max(brushBbMaxDimension / 2, defaultRadius)
    );
    const rawBb = brush?.bb2d ?? (
        pointBounds ?
            [
                pointBounds[0] - radius,
                pointBounds[1] - radius,
                pointBounds[2] + radius,
                pointBounds[3] + radius
            ] as NormalizedBb2d :
            (
                shape === 'rect' ?
                    [
                        center[0] - (brush?.width ?? defaultRadius * 2) / 2,
                        center[1] - (brush?.height ?? defaultRadius * 2) / 2,
                        center[0] + (brush?.width ?? defaultRadius * 2) / 2,
                        center[1] + (brush?.height ?? defaultRadius * 2) / 2
                    ] as NormalizedBb2d :
                    [
                        center[0] - radius,
                        center[1] - radius,
                        center[0] + radius,
                        center[1] + radius
                    ] as NormalizedBb2d
            )
    );
    const bb2d = sanitizeBb2d([
        rawBb[0] - pad,
        rawBb[1] - pad,
        rawBb[2] + pad,
        rawBb[3] + pad
    ], frame.image_width, frame.image_height);
    if (!bb2d) {
        throw new Error('client_brush prompt resolved to an invalid 2D region');
    }

    const radius2 = radius * radius;
    const segmentDistance2 = (x: number, y: number, a: [number, number], b: [number, number]) => {
        const abx = b[0] - a[0];
        const aby = b[1] - a[1];
        const len2 = abx * abx + aby * aby;
        const t = len2 > 0 ? clamp(((x - a[0]) * abx + (y - a[1]) * aby) / len2, 0, 1) : 0;
        const px = a[0] + abx * t;
        const py = a[1] + aby * t;
        const dx = x - px;
        const dy = y - py;
        return dx * dx + dy * dy;
    };
    const containsPixel = (x: number, y: number) => {
        if (!bbContainsPoint(bb2d, x, y)) return false;
        if (points.length === 1) {
            const dx = x - points[0][0];
            const dy = y - points[0][1];
            return dx * dx + dy * dy <= radius2;
        }
        if (points.length > 1) {
            for (let i = 1; i < points.length; i++) {
                if (segmentDistance2(x, y, points[i - 1], points[i]) <= radius2) return true;
            }
            return false;
        }
        if (shape !== 'circle' || brush?.bb2d) return true;
        const dx = x - center[0];
        const dy = y - center[1];
        return dx * dx + dy * dy <= radius2;
    };
    const contains = (candidate: ProjectedSplatCandidate) => containsPixel(candidate.pixel[0], candidate.pixel[1]);

    return {
        shape,
        center,
        radius,
        bb2d,
        containsPixel,
        contains,
        point_count: points.length,
        area_ratio: (bb2d[2] - bb2d[0]) * (bb2d[3] - bb2d[1]) / Math.max(1, frame.image_width * frame.image_height)
    };
};

const buildBrushVisualEvidence = async (
    events: Events,
    frame: BoxerFramePayload,
    brush: BoxerBrushPrompt | undefined,
    click?: [number, number]
): Promise<BrushVisualEvidence | null> => {
    const region = resolveClientBrushRegion(frame, brush, click);
    const scale = Math.min(1, 360 / Math.max(frame.image_width, frame.image_height));
    const width = Math.max(1, Math.round(frame.image_width * scale));
    const height = Math.max(1, Math.round(frame.image_height * scale));
    const source = await captureSceneRgba(events, width, height);
    const count = width * height;
    const r = new Uint8Array(count);
    const g = new Uint8Array(count);
    const b = new Uint8Array(count);
    const luma = new Float32Array(count);
    const gradient = new Float32Array(count);
    const brushMask = new Uint8Array(count);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const src = (y * width + x) * 4;
            const dst = y * width + x;
            r[dst] = source[src];
            g[dst] = source[src + 1];
            b[dst] = source[src + 2];
            luma[dst] = source[src] * 0.2126 + source[src + 1] * 0.7152 + source[src + 2] * 0.0722;
        }
    }

    for (let y = 1; y + 1 < height; y++) {
        for (let x = 1; x + 1 < width; x++) {
            const i = y * width + x;
            const dx = luma[i + 1] - luma[i - 1];
            const dy = luma[i + width] - luma[i - width];
            gradient[i] = Math.hypot(dx, dy) * 0.5;
        }
    }

    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let sumLuma = 0;
    let sumGradient = 0;
    let brushCount = 0;
    const minX = Math.max(0, Math.floor(region.bb2d[0] * scale));
    const minY = Math.max(0, Math.floor(region.bb2d[1] * scale));
    const maxX = Math.min(width - 1, Math.ceil(region.bb2d[2] * scale));
    const maxY = Math.min(height - 1, Math.ceil(region.bb2d[3] * scale));
    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            const sx = x / scale;
            const sy = y / scale;
            if (!region.containsPixel(sx, sy)) continue;
            const i = y * width + x;
            brushMask[i] = 1;
            sumR += r[i];
            sumG += g[i];
            sumB += b[i];
            sumLuma += luma[i];
            sumGradient += gradient[i];
            brushCount++;
        }
    }

    if (brushCount < 16) return null;

    return {
        width,
        height,
        scale,
        count,
        r,
        g,
        b,
        luma,
        gradient,
        brush_mask: brushMask,
        brush: {
            count: brushCount,
            mean_rgb: [sumR / brushCount, sumG / brushCount, sumB / brushCount],
            mean_luma: sumLuma / brushCount,
            mean_gradient: sumGradient / brushCount
        }
    };
};

const scoreBrushVisualCandidate = (
    evidence: BrushVisualEvidence | null | undefined,
    bb: NormalizedBb2d
): BrushVisualCandidateScore | null => {
    if (!evidence) return null;
    const scale = evidence.scale;
    const x0 = clamp(Math.floor(bb[0] * scale), 0, evidence.width - 1);
    const y0 = clamp(Math.floor(bb[1] * scale), 0, evidence.height - 1);
    const x1 = clamp(Math.ceil(bb[2] * scale), 0, evidence.width - 1);
    const y1 = clamp(Math.ceil(bb[3] * scale), 0, evidence.height - 1);
    if (x1 <= x0 || y1 <= y0) return null;

    let inR = 0;
    let inG = 0;
    let inB = 0;
    let inLuma = 0;
    let insideCount = 0;
    let brushInsideCount = 0;
    const sampleStep = Math.max(1, Math.floor(Math.max(x1 - x0, y1 - y0) / 80));
    for (let y = y0; y <= y1; y += sampleStep) {
        for (let x = x0; x <= x1; x += sampleStep) {
            const i = y * evidence.width + x;
            inR += evidence.r[i];
            inG += evidence.g[i];
            inB += evidence.b[i];
            inLuma += evidence.luma[i];
            brushInsideCount += evidence.brush_mask[i] ? 1 : 0;
            insideCount++;
        }
    }
    if (insideCount < 4) return null;
    inR /= insideCount;
    inG /= insideCount;
    inB /= insideCount;
    inLuma /= insideCount;

    const borderPad = Math.max(2, Math.round(8 * scale));
    const bx0 = Math.max(0, x0 - borderPad);
    const by0 = Math.max(0, y0 - borderPad);
    const bx1 = Math.min(evidence.width - 1, x1 + borderPad);
    const by1 = Math.min(evidence.height - 1, y1 + borderPad);
    let outR = 0;
    let outG = 0;
    let outB = 0;
    let outLuma = 0;
    let borderCount = 0;
    for (let y = by0; y <= by1; y += sampleStep) {
        for (let x = bx0; x <= bx1; x += sampleStep) {
            if (x >= x0 && x <= x1 && y >= y0 && y <= y1) continue;
            const i = y * evidence.width + x;
            outR += evidence.r[i];
            outG += evidence.g[i];
            outB += evidence.b[i];
            outLuma += evidence.luma[i];
            borderCount++;
        }
    }
    if (borderCount > 0) {
        outR /= borderCount;
        outG /= borderCount;
        outB /= borderCount;
        outLuma /= borderCount;
    } else {
        outR = inR;
        outG = inG;
        outB = inB;
        outLuma = inLuma;
    }

    let perimeterEdgeSum = 0;
    let perimeterCount = 0;
    const perimeterStep = Math.max(1, Math.floor(Math.max(x1 - x0, y1 - y0) / 120));
    for (let x = x0; x <= x1; x += perimeterStep) {
        perimeterEdgeSum += evidence.gradient[y0 * evidence.width + x] + evidence.gradient[y1 * evidence.width + x];
        perimeterCount += 2;
    }
    for (let y = y0; y <= y1; y += perimeterStep) {
        perimeterEdgeSum += evidence.gradient[y * evidence.width + x0] + evidence.gradient[y * evidence.width + x1];
        perimeterCount += 2;
    }
    const perimeterEdge = perimeterEdgeSum / Math.max(1, perimeterCount);

    const brushRgb = evidence.brush.mean_rgb;
    const brushDelta = Math.hypot(inR - brushRgb[0], inG - brushRgb[1], inB - brushRgb[2]);
    const colorSimilarity = clamp(1 - brushDelta / 150, 0, 1);
    const boundaryContrast = clamp(
        (Math.hypot(inR - outR, inG - outG, inB - outB) * 0.65 + Math.abs(inLuma - outLuma) * 0.35) / 120,
        0,
        1
    );
    const edgeSupport = clamp(perimeterEdge / Math.max(35, evidence.brush.mean_gradient + 24), 0, 1);
    const brushCoverage = clamp(brushInsideCount / Math.max(1, evidence.brush.count), 0, 1);
    const brushDensity = clamp(brushInsideCount / Math.max(1, insideCount), 0, 1);
    const score = colorSimilarity * 0.07 +
        boundaryContrast * 0.08 +
        edgeSupport * 0.08 +
        brushCoverage * 0.045 +
        Math.min(0.015, brushDensity * 0.06) -
        (1 - colorSimilarity) * 0.05;

    return {
        score,
        color_similarity: colorSimilarity,
        boundary_contrast: boundaryContrast,
        perimeter_edge: edgeSupport,
        brush_coverage: brushCoverage,
        brush_density: brushDensity,
        inside_count: insideCount,
        brush_inside_count: brushInsideCount,
        border_count: borderCount
    };
};

type BrushSurfaceAnchor = {
    point: [number, number, number];
    pixel: [number, number];
    distance: number;
    radius_world: number;
    dir: [number, number, number];
};

type BrushSurfaceEvidence = {
    anchors: BrushSurfaceAnchor[];
    support: ProjectedSplatCandidate[];
    core_support: ProjectedSplatCandidate[];
    sampled_point_count: number;
    anchor_hit_ratio: number;
    median_radius_world: number;
    thickness_cut: number;
    thickness_cap: number;
    support_floor_y?: number;
    support_floor_sample_count?: number;
    sam_filter?: {
        applied: boolean;
        reason?: string;
        mask_point_count: number;
        unfiltered_support_count: number;
        filtered_support_count: number;
        unfiltered_core_count: number;
        filtered_core_count: number;
        pixel_radius: number;
    };
};

type BrushVisualEvidence = {
    width: number;
    height: number;
    scale: number;
    count: number;
    r: Uint8Array;
    g: Uint8Array;
    b: Uint8Array;
    luma: Float32Array;
    gradient: Float32Array;
    brush_mask: Uint8Array;
    brush: {
        count: number;
        mean_rgb: [number, number, number];
        mean_luma: number;
        mean_gradient: number;
    };
};

type BrushVisualCandidateScore = {
    score: number;
    color_similarity: number;
    boundary_contrast: number;
    perimeter_edge: number;
    brush_coverage: number;
    brush_density: number;
    inside_count: number;
    brush_inside_count: number;
    border_count: number;
};

const BRUSH_SURFACE_MAX_ANCHOR_SAMPLES = 48;
const BRUSH_SURFACE_RADIUS_FACTOR = 1.35;
const BRUSH_SURFACE_BACK_TOLERANCE = 0.25;
const BRUSH_SURFACE_MAX_THICKNESS = 2.6;
const BRUSH_SURFACE_MIN_THICKNESS = 0.5;
const BRUSH_SURFACE_THICKNESS_EXTENT_FACTOR = 2.0;
// surface evidence is unfitted to the eval suites; it only overrides the
// calibrated candidate family when none of them reaches this score
const BRUSH_SURFACE_OVERRIDE_MAX_ALT_SCORE = 1.2;

const filterCandidatesBySamRegion = (
    frame: BoxerFramePayload,
    scene: Scene,
    candidates: ProjectedSplatCandidate[],
    sam3Region: Sam3MaskRegion | null | undefined
) => {
    if (!sam3Region?.mask_bb2d || sam3Region.point_count < 24) {
        return {
            candidates,
            applied: false,
            reason: 'missing-sam-region',
            mask_point_count: sam3Region?.point_count ?? 0,
            pixel_radius: 0
        };
    }

    const projectedMaskPoints = sam3Region.points
    .map(point => projectWorldPointToImage(point, scene, frame.intrinsics))
    .filter(sample => sample.in_frame);
    if (projectedMaskPoints.length < 12) {
        return {
            candidates,
            applied: false,
            reason: 'too-few-projected-mask-points',
            mask_point_count: sam3Region.point_count,
            pixel_radius: 0
        };
    }

    const maskWidth = Math.max(1, sam3Region.mask_bb2d[2] - sam3Region.mask_bb2d[0]);
    const maskHeight = Math.max(1, sam3Region.mask_bb2d[3] - sam3Region.mask_bb2d[1]);
    const pixelRadius = clamp(
        Math.sqrt(maskWidth * maskHeight / Math.max(1, projectedMaskPoints.length)) * 2.2,
        4,
        26
    );
    const pixelRadius2 = pixelRadius * pixelRadius;
    const cellSize = Math.max(4, pixelRadius);
    const cells = new Map<string, [number, number][]>();
    for (const sample of projectedMaskPoints) {
        const key = `${Math.floor(sample.pixel[0] / cellSize)},${Math.floor(sample.pixel[1] / cellSize)}`;
        const list = cells.get(key) ?? [];
        list.push(sample.pixel);
        cells.set(key, list);
    }

    const nearMaskPoint = (x: number, y: number) => {
        const cx = Math.floor(x / cellSize);
        const cy = Math.floor(y / cellSize);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (const point of cells.get(`${cx + dx},${cy + dy}`) ?? []) {
                    const px = x - point[0];
                    const py = y - point[1];
                    if (px * px + py * py <= pixelRadius2) return true;
                }
            }
        }
        return false;
    };

    return {
        candidates: candidates.filter(candidate => (
            bbContainsPoint(sam3Region.mask_bb2d, candidate.pixel[0], candidate.pixel[1]) &&
            nearMaskPoint(candidate.pixel[0], candidate.pixel[1])
        )),
        applied: true,
        mask_point_count: sam3Region.point_count,
        pixel_radius: pixelRadius
    };
};

const estimateSupportFloorY = (
    surface: ReturnType<typeof getActiveCollisionSurface>,
    support: ProjectedSplatCandidate[],
    anchors: BrushSurfaceAnchor[],
    medianRadiusWorld: number
) => {
    if (support.length < 8) return null;

    const hitYs: number[] = [];
    const anchorStep = Math.max(1, Math.ceil(anchors.length / 16));
    for (let i = 0; i < anchors.length; i += anchorStep) {
        const anchor = anchors[i];
        const lift = Math.max(0.12, medianRadiusWorld * 0.8);
        const hit = surface?.raycastWorld(
            [anchor.point[0], anchor.point[1] + lift, anchor.point[2]],
            [0, -1, 0],
            Math.max(0.4, lift + medianRadiusWorld * 3.0)
        );
        if (hit && hit.point[1] <= anchor.point[1] + 0.08) {
            hitYs.push(hit.point[1]);
        }
    }

    if (hitYs.length >= 3) {
        hitYs.sort((a, b) => a - b);
        return {
            y: hitYs[Math.floor(hitYs.length * 0.15)],
            sample_count: hitYs.length
        };
    }

    const supportYs = support.map(candidate => candidate.point[1]).sort((a, b) => a - b);
    return {
        y: supportYs[Math.floor(supportYs.length * 0.02)],
        sample_count: supportYs.length
    };
};

const snapSummaryToFloor = (
    summary: { center: [number, number, number]; dimensions: [number, number, number]; aabb: Aabb },
    floorY: number | undefined
) => {
    if (floorY === undefined || !(floorY < summary.aabb.max[1])) return summary;
    const aabb: Aabb = {
        min: [summary.aabb.min[0], floorY, summary.aabb.min[2]],
        max: [...summary.aabb.max] as [number, number, number]
    };
    const center = [0, 1, 2].map(axis => (aabb.min[axis] + aabb.max[axis]) / 2) as [number, number, number];
    const dimensions = [0, 1, 2].map(axis => Math.max(0.05, aabb.max[axis] - aabb.min[axis])) as [number, number, number];
    return { center, dimensions, aabb };
};

// Lift the 2D brush stroke onto the scene's collision surface: raycast sampled
// stroke pixels against the collision mesh sidecar, then keep splat candidates
// inside the resulting world-space brush tube. Depth extent comes from the
// actual splat density along each anchor ray (front shell through back shell),
// cut at the first density gap so background behind the object is excluded.
const collectBrushSurfaceEvidence = (
    frame: BoxerFramePayload,
    scene: Scene,
    region: ReturnType<typeof resolveClientBrushRegion>,
    brush: BoxerBrushPrompt | undefined,
    projectedCandidates: ProjectedSplatCandidate[],
    sam3Region?: Sam3MaskRegion | null
): BrushSurfaceEvidence | null => {
    const surface = getActiveCollisionSurface();
    if (!surface) return null;

    const strokePoints = brush?.points?.length ? brush.points : [region.center];
    const sampleStep = Math.max(1, Math.ceil(strokePoints.length / BRUSH_SURFACE_MAX_ANCHOR_SAMPLES));
    const sampledPixels: [number, number][] = [];
    for (let i = 0; i < strokePoints.length; i += sampleStep) {
        sampledPixels.push([strokePoints[i][0], strokePoints[i][1]]);
    }
    const lastStrokePoint = strokePoints[strokePoints.length - 1];
    const lastSampled = sampledPixels[sampledPixels.length - 1];
    if (lastSampled[0] !== lastStrokePoint[0] || lastSampled[1] !== lastStrokePoint[1]) {
        sampledPixels.push([lastStrokePoint[0], lastStrokePoint[1]]);
    }

    const e = frame.extrinsics;
    const origin: [number, number, number] = [e[12], e[13], e[14]];
    const anchors: BrushSurfaceAnchor[] = [];
    for (const pixel of sampledPixels) {
        const through = unprojectDepthToWorld(frame, pixel[0], pixel[1], 1);
        const dir: [number, number, number] = [
            through[0] - origin[0],
            through[1] - origin[1],
            through[2] - origin[2]
        ];
        const hit = surface.raycastWorld(origin, dir);
        if (!hit) continue;
        const dirLength = Math.hypot(dir[0], dir[1], dir[2]);
        anchors.push({
            point: hit.point,
            pixel,
            distance: hit.distance,
            radius_world: Math.max(0.01, brush?.radius_world ?? region.radius / Math.max(1, frame.intrinsics.fx) * hit.distance),
            dir: [dir[0] / dirLength, dir[1] / dirLength, dir[2] / dirLength]
        });
    }
    if (anchors.length === 0) {
        return {
            anchors,
            support: [],
            core_support: [],
            sampled_point_count: sampledPixels.length,
            anchor_hit_ratio: 0,
            median_radius_world: 0,
            thickness_cut: 0,
            thickness_cap: 0
        };
    }

    const sortedRadii = anchors.map(anchor => anchor.radius_world).sort((a, b) => a - b);
    const medianRadiusWorld = sortedRadii[Math.floor(sortedRadii.length / 2)];

    // the anchor cloud spans the brushed face of the object, so its extent is
    // a direct estimate of the object's cross-scale; bound the depth sweep by
    // it so the tube cannot run far into background surfaces behind the object
    const anchorMin = [Infinity, Infinity, Infinity];
    const anchorMax = [-Infinity, -Infinity, -Infinity];
    for (const anchor of anchors) {
        for (let axis = 0; axis < 3; axis++) {
            anchorMin[axis] = Math.min(anchorMin[axis], anchor.point[axis]);
            anchorMax[axis] = Math.max(anchorMax[axis], anchor.point[axis]);
        }
    }
    const anchorExtentDiag = Math.hypot(
        anchorMax[0] - anchorMin[0],
        anchorMax[1] - anchorMin[1],
        anchorMax[2] - anchorMin[2]
    );
    const thicknessCap = Math.min(
        BRUSH_SURFACE_MAX_THICKNESS,
        Math.max(BRUSH_SURFACE_MIN_THICKNESS, anchorExtentDiag * BRUSH_SURFACE_THICKNESS_EXTENT_FACTOR)
    );

    const anchorPixelRadius = Math.max(24, (brush?.radius ?? region.radius) * 2.5);
    const anchorCellSize = Math.max(12, Math.min(64, anchorPixelRadius));
    const anchorCellRadius = Math.max(1, Math.ceil(anchorPixelRadius / anchorCellSize));
    const anchorCells = new Map<string, number[]>();
    for (let anchorIndex = 0; anchorIndex < anchors.length; anchorIndex++) {
        const anchor = anchors[anchorIndex];
        const key = `${Math.floor(anchor.pixel[0] / anchorCellSize)},${Math.floor(anchor.pixel[1] / anchorCellSize)}`;
        const list = anchorCells.get(key) ?? [];
        list.push(anchorIndex);
        anchorCells.set(key, list);
    }
    const anchorIndexesNearPixel = (pixel: [number, number]) => {
        const cx = Math.floor(pixel[0] / anchorCellSize);
        const cy = Math.floor(pixel[1] / anchorCellSize);
        const indexes: number[] = [];
        for (let dy = -anchorCellRadius; dy <= anchorCellRadius; dy++) {
            for (let dx = -anchorCellRadius; dx <= anchorCellRadius; dx++) {
                const cell = anchorCells.get(`${cx + dx},${cy + dy}`);
                if (cell) indexes.push(...cell);
            }
        }
        return indexes;
    };

    const strokeCandidates = projectedCandidates.filter(region.contains);
    const matched: { candidate: ProjectedSplatCandidate; delta: number; anchorIndex: number; core: boolean }[] = [];
    for (const candidate of strokeCandidates) {
        const nearbyAnchorIndexes = anchorIndexesNearPixel(candidate.pixel);
        if (nearbyAnchorIndexes.length === 0) continue;
        const px = candidate.point[0] - origin[0];
        const py = candidate.point[1] - origin[1];
        const pz = candidate.point[2] - origin[2];
        const lengthSq = px * px + py * py + pz * pz;
        let bestDelta = Infinity;
        let bestPerp = Infinity;
        let bestAnchorIndex = -1;
        let bestCoreRadius = 0;
        for (const anchorIndex of nearbyAnchorIndexes) {
            const anchor = anchors[anchorIndex];
            const t = px * anchor.dir[0] + py * anchor.dir[1] + pz * anchor.dir[2];
            const delta = t - anchor.distance;
            if (delta < -BRUSH_SURFACE_BACK_TOLERANCE || delta > thicknessCap) continue;
            const perpSq = Math.max(0, lengthSq - t * t);
            const maxPerp = anchor.radius_world * BRUSH_SURFACE_RADIUS_FACTOR;
            if (perpSq > maxPerp * maxPerp) continue;
            if (perpSq < bestPerp) {
                bestPerp = perpSq;
                bestDelta = delta;
                bestAnchorIndex = anchorIndex;
                bestCoreRadius = anchor.radius_world * 0.6;
            }
        }
        if (bestAnchorIndex >= 0) {
            matched.push({
                candidate,
                delta: bestDelta,
                anchorIndex: bestAnchorIndex,
                // core = clearly inside the stroke, robust against the tube
                // swallowing neighbouring surfaces; multi-view fusion prefers it
                core: bestPerp <= bestCoreRadius * bestCoreRadius
            });
        }
    }
    if (matched.length === 0) {
        return {
            anchors,
            support: [],
            core_support: [],
            sampled_point_count: sampledPixels.length,
            anchor_hit_ratio: anchors.length / Math.max(1, sampledPixels.length),
            median_radius_world: medianRadiusWorld,
            thickness_cut: 0,
            thickness_cap: thicknessCap
        };
    }

    // per-ray depth clustering: each anchor ray walks its own depth-delta
    // distribution from the surface backwards and stops at the first density
    // gap, so a stroke crossing object + background cuts each sightline where
    // ITS object ends instead of using one global thickness
    const anchorDeltas: number[][] = anchors.map((): number[] => []);
    for (const entry of matched) {
        anchorDeltas[entry.anchorIndex].push(Math.max(0, entry.delta));
    }
    const PER_RAY_MIN_SAMPLES = 4;
    const anchorCuts: (number | null)[] = anchors.map((anchor, anchorIndex) => {
        const deltas = anchorDeltas[anchorIndex];
        if (deltas.length < PER_RAY_MIN_SAMPLES) return null;
        deltas.sort((a, b) => a - b);
        const gapThreshold = Math.max(0.35, anchor.radius_world * 1.8);
        let cut = deltas[0];
        for (let i = 1; i < deltas.length; i++) {
            if (deltas[i] - cut > gapThreshold) break;
            cut = deltas[i];
        }
        return cut;
    });
    const validCuts = anchorCuts.filter((cut): cut is number => cut !== null).sort((a, b) => a - b);
    const fallbackCut = validCuts.length ? validCuts[Math.floor(validCuts.length / 2)] : thicknessCap;
    let support = matched
    .filter(entry => entry.delta <= (anchorCuts[entry.anchorIndex] ?? fallbackCut) + 1e-6)
    .map(entry => entry.candidate);
    let coreSupport = matched
    .filter(entry => entry.core && entry.delta <= (anchorCuts[entry.anchorIndex] ?? fallbackCut) + 1e-6)
    .map(entry => entry.candidate);
    let samFilter: BrushSurfaceEvidence['sam_filter'];
    if (sam3Region) {
        const filteredSupport = filterCandidatesBySamRegion(frame, scene, support, sam3Region);
        const filteredCore = filterCandidatesBySamRegion(frame, scene, coreSupport, sam3Region);
        const canApply = filteredSupport.applied && filteredSupport.candidates.length >= 8;
        samFilter = {
            applied: canApply,
            reason: canApply ? undefined : (filteredSupport.reason ?? 'too-few-filtered-support'),
            mask_point_count: filteredSupport.mask_point_count,
            unfiltered_support_count: support.length,
            filtered_support_count: filteredSupport.candidates.length,
            unfiltered_core_count: coreSupport.length,
            filtered_core_count: filteredCore.candidates.length,
            pixel_radius: filteredSupport.pixel_radius
        };
        if (canApply) {
            support = filteredSupport.candidates;
            coreSupport = filteredCore.candidates.length >= 3 ? filteredCore.candidates : filteredSupport.candidates;
        }
    }
    const thicknessCut = validCuts.length ? validCuts[validCuts.length - 1] : 0;
    const floor = estimateSupportFloorY(surface, support, anchors, medianRadiusWorld);

    return {
        anchors,
        support,
        core_support: coreSupport,
        sampled_point_count: sampledPixels.length,
        anchor_hit_ratio: anchors.length / Math.max(1, sampledPixels.length),
        median_radius_world: medianRadiusWorld,
        thickness_cut: thicknessCut,
        thickness_cap: thicknessCap,
        support_floor_y: floor?.y,
        support_floor_sample_count: floor?.sample_count,
        sam_filter: samFilter
    };
};

// AABB summary tuned for brush_surface support: the brush tube already gates
// points spatially, so only a light quantile trim is needed and the result is
// inflated slightly to recover extent lost to splat-center underestimation
const summarizeBrushSurfaceAabb = (
    points: number[][]
): { center: [number, number, number]; dimensions: [number, number, number]; aabb: Aabb } | null => {
    if (points.length < 3) return null;
    const sorted = [0, 1, 2].map(axis => points.map(point => point[axis]).sort((a, b) => a - b));
    const { mins, maxs } = summarizeSortedAxisExtents(sorted, 0.02, 0.98);
    const center = [0, 1, 2].map(axis => (mins[axis] + maxs[axis]) / 2) as [number, number, number];
    const dimensions = [0, 1, 2].map(axis => Math.max(0.05, (maxs[axis] - mins[axis]) * 1.06)) as [number, number, number];
    return {
        center,
        dimensions,
        aabb: {
            min: [0, 1, 2].map(axis => center[axis] - dimensions[axis] / 2) as [number, number, number],
            max: [0, 1, 2].map(axis => center[axis] + dimensions[axis] / 2) as [number, number, number]
        }
    };
};

const summarizeBrushSurfaceSupportQuantileAabb = (
    points: number[][],
    lowQ = 0.015,
    highQ = 0.985,
    inflate = 1.02
): { center: [number, number, number]; dimensions: [number, number, number]; aabb: Aabb } | null => {
    if (points.length < 8) return null;
    const min: [number, number, number] = [0, 0, 0];
    const max: [number, number, number] = [0, 0, 0];
    for (let axis = 0; axis < 3; axis++) {
        const values = points.map(point => point[axis]).sort((a, b) => a - b);
        const lo = quantile(values, lowQ);
        const hi = quantile(values, highQ);
        const center = (lo + hi) * 0.5;
        const half = Math.max(0.025, (hi - lo) * 0.5 * inflate);
        min[axis] = center - half;
        max[axis] = center + half;
    }
    const center = [0, 1, 2].map(axis => (min[axis] + max[axis]) / 2) as [number, number, number];
    const dimensions = [0, 1, 2].map(axis => Math.max(0.05, max[axis] - min[axis])) as [number, number, number];
    return { center, dimensions, aabb: { min, max } };
};

const sampleProjectedCandidatePoints = (points: ProjectedSplatCandidate[], maxSamples = 4000) => {
    const step = Math.max(1, Math.ceil(points.length / maxSamples));
    const sample: number[] = [];
    for (let i = 0; i < points.length; i += step) {
        sample.push(
            Number(points[i].point[0].toFixed(3)),
            Number(points[i].point[1].toFixed(3)),
            Number(points[i].point[2].toFixed(3))
        );
    }
    return sample;
};

// Pure-extents brush: box the gaussians the stroke actually touched and
// nothing else. Uses the collision-surface tube when available (true 3D
// selection including back-of-object splats), otherwise the 2D stroke mask
// over front-surface candidates. No candidate competition, no priors.
const buildRawBrushObb = (
    frame: BoxerFramePayload,
    splat: Splat,
    scene: Scene,
    brush: BoxerBrushPrompt | undefined,
    click?: [number, number]
) => {
    const region = resolveClientBrushRegion(frame, brush, click);
    const baseProjected = collectProjectedSplatCandidates(splat, scene, frame.intrinsics, region.bb2d);
    const surfaceEvidence = collectBrushSurfaceEvidence(frame, scene, region, brush, baseProjected);

    let selected: ProjectedSplatCandidate[];
    let selectionSource: 'surface_tube' | 'mask_2d';
    if (surfaceEvidence && surfaceEvidence.support.length >= 8) {
        selected = surfaceEvidence.support;
        selectionSource = 'surface_tube';
    } else {
        const frontSurface = filterFrontSurfaceProjectedCandidates(baseProjected, frame.image_width, frame.image_height);
        const pool = frontSurface.length >= 24 ? frontSurface : baseProjected;
        selected = pool.filter(region.contains);
        selectionSource = 'mask_2d';
    }
    if (selected.length < 8) {
        throw new Error(`raw brush found too few gaussians in the stroke (${selected.length})`);
    }

    const summary = summarizeBrushSurfaceAabb(selected.map(candidate => candidate.point));
    if (!summary) {
        throw new Error('raw brush could not summarize the selected gaussians');
    }
    const bb2d = bboxFromProjectedCandidates(selected, frame.image_width, frame.image_height) ?? region.bb2d;
    const obb = buildAxisAlignedObbFromAabb(summary.aabb, 'raw_brush', 'raw_brush', bb2d);

    return {
        obb,
        bb2d,
        debug: {
            shape: region.shape,
            center_xy: region.center,
            radius: region.radius,
            brush_bb2d: region.bb2d,
            brush_area_ratio: region.area_ratio,
            brush_stroke_point_count: region.point_count,
            raw_mode: true,
            raw_selection_source: selectionSource,
            raw_selected_point_count: selected.length,
            base_projected_candidate_count: baseProjected.length,
            brush_surface: surfaceEvidence ? {
                anchor_count: surfaceEvidence.anchors.length,
                sampled_point_count: surfaceEvidence.sampled_point_count,
                anchor_hit_ratio: surfaceEvidence.anchor_hit_ratio,
                support_count: surfaceEvidence.support.length,
                median_radius_world: surfaceEvidence.median_radius_world,
                thickness_cut: surfaceEvidence.thickness_cut,
                thickness_cap: surfaceEvidence.thickness_cap
            } : { available: false as const },
            selected_candidate_source: 'raw_extents',
            candidates: [] as { selection_score: number; bb2d: NormalizedBb2d }[]
        }
    };
};

const buildClientBrushObb = (
    frame: BoxerFramePayload,
    splat: Splat,
    scene: Scene,
    depthBuffer: DepthBuffer,
    brush: BoxerBrushPrompt | undefined,
    click?: [number, number],
    options?: { sam3Region?: Sam3MaskRegion | null; floorSnap?: boolean; visualEvidence?: BrushVisualEvidence | null }
) => {
    const region = resolveClientBrushRegion(frame, brush, click);
    const clickDepth = click ? sampleDepthArea(depthBuffer, frame.image_width, frame.image_height, click[0], click[1]) : 0;
    const clickDepthValid = clickDepth > 0;
    const baseProjected = collectProjectedSplatCandidates(splat, scene, frame.intrinsics, region.bb2d);
    const baseFrontSurface = filterFrontSurfaceProjectedCandidates(baseProjected, frame.image_width, frame.image_height);
    const baseCandidates = baseFrontSurface.length >= 24 ? baseFrontSurface : baseProjected;
    const brushCandidates = baseCandidates.filter(region.contains);
    const sourceCandidates = brushCandidates.length >= 24 ? brushCandidates : baseCandidates;
    const fastBrushSolve = baseProjected.length > 80000 || region.area_ratio > 0.1;
    const broadVoxelBrushEligible = brush?.mode !== 'evidence' &&
        getActiveCollisionSurface()?.source === 'voxel' &&
        fastBrushSolve &&
        region.area_ratio > 0.1;
    const compactVoxelBrushCandidates = brush?.mode !== 'evidence' &&
        getActiveCollisionSurface()?.source === 'voxel' &&
        region.point_count > 0 &&
        !broadVoxelBrushEligible;
    if (sourceCandidates.length < 8) {
        throw new Error(`client_brush found too few points in brush region (${sourceCandidates.length})`);
    }

    let connectedCluster: ProjectedSplatCandidate[] = [];
    if (!broadVoxelBrushEligible && !compactVoxelBrushCandidates && click && clickDepthValid) {
        const seed = findProjectedSeed(sourceCandidates, click[0], click[1], clickDepth);
        if (seed >= 0) {
            const seedDepth = sourceCandidates[seed].depth;
            connectedCluster = growProjectedCluster(
                sourceCandidates,
                seed,
                Math.min(0.38, Math.max(0.08, seedDepth * 0.012)),
                Math.min(0.95, Math.max(0.24, seedDepth * 0.032))
            );
        }
    }

    const componentDepth = clickDepthValid ?
        clickDepth :
        quantile(sourceCandidates.map(candidate => candidate.depth).sort((a, b) => a - b), 0.5);
    const brushComponents = broadVoxelBrushEligible || compactVoxelBrushCandidates ? [] : collectProjectedComponents(
        brushCandidates.length >= 24 ? brushCandidates : sourceCandidates,
        {
            cellSize: Math.min(0.32, Math.max(0.08, componentDepth * 0.012)),
            maxSpatialDistance: Math.min(0.42, Math.max(0.12, componentDepth * 0.018)),
            maxSeedDepthDelta: Math.min(0.9, Math.max(0.26, componentDepth * 0.05)),
            maxNeighborDepthDelta: Math.min(0.34, Math.max(0.08, componentDepth * 0.016)),
            maxPixelDistance: Math.min(72, Math.max(26, componentDepth * 4.2)),
            minPoints: 48,
            maxComponents: fastBrushSolve ? 4 : 8,
            maxPointsPerComponent: fastBrushSolve ? 3600 : 5200
        }
    );
    let brushKnnCluster: ProjectedSplatCandidate[] = [];
    let brushKnnClusterCapped = false;
    if (!broadVoxelBrushEligible && !compactVoxelBrushCandidates && click && clickDepthValid) {
        const brushDepthBand = Math.min(1.35, Math.max(0.36, clickDepth * 0.065));
        const brushKnnSourceCandidates = sourceCandidates.filter(candidate => Math.abs(candidate.depth - clickDepth) <= brushDepthBand);
        const knnSource = brushKnnSourceCandidates.length >= 24 ? brushKnnSourceCandidates : sourceCandidates;
        const knnSeed = findProjectedSeed(knnSource, click[0], click[1], clickDepth);
        const strictMaxPoints = 2200;
        const relaxedMaxPoints = 3400;
        const strictCluster = growProjectedKnnCluster(knnSource, knnSeed, {
            k: 6,
            cellSize: Math.min(0.24, Math.max(0.07, clickDepth * 0.01)),
            maxSpatialDistance: Math.min(0.34, Math.max(0.1, clickDepth * 0.015)),
            maxPixelDistance: Math.min(58, Math.max(24, clickDepth * 3.3)),
            maxSeedDepthDelta: Math.min(0.95, Math.max(0.3, clickDepth * 0.045)),
            maxNeighborDepthDelta: Math.min(0.32, Math.max(0.08, clickDepth * 0.016)),
            maxPoints: strictMaxPoints
        });
        const relaxedCluster = strictCluster.length >= 24 ? [] : growProjectedKnnCluster(knnSource, knnSeed, {
            k: 8,
            cellSize: Math.min(0.36, Math.max(0.1, clickDepth * 0.016)),
            maxSpatialDistance: Math.min(0.52, Math.max(0.18, clickDepth * 0.026)),
            maxPixelDistance: Math.min(86, Math.max(34, clickDepth * 5.2)),
            maxSeedDepthDelta: Math.min(1.45, Math.max(0.46, clickDepth * 0.075)),
            maxNeighborDepthDelta: Math.min(0.52, Math.max(0.14, clickDepth * 0.026)),
            maxPoints: relaxedMaxPoints
        });
        brushKnnCluster = strictCluster.length >= 24 ? strictCluster : relaxedCluster;
        brushKnnClusterCapped = strictCluster.length >= strictMaxPoints || relaxedCluster.length >= relaxedMaxPoints;
    }

    const shouldCollectSurfaceEvidence = !broadVoxelBrushEligible ||
        getActiveCollisionSurface()?.source === 'voxel';
    const surfaceEvidence = shouldCollectSurfaceEvidence ?
        collectBrushSurfaceEvidence(frame, scene, region, brush, baseProjected, options?.sam3Region) :
        null;
    const buildSurfaceRayDepthDebug = (bb: NormalizedBb2d) => {
        if (!surfaceEvidence?.anchors.length) return null;
        const anchorsInBox = surfaceEvidence.anchors.filter(anchor => bbContainsPoint(bb, anchor.pixel[0], anchor.pixel[1]));
        const anchorsForStats = anchorsInBox.length ? anchorsInBox : surfaceEvidence.anchors;
        const samples = anchorsForStats.map((anchor, anchorIndex) => {
            const projected = projectWorldPointToImage(anchor.point, scene, frame.intrinsics);
            return {
                id: `surface-${anchorIndex}`,
                pixel: anchor.pixel,
                depth: projected.depth > 0 ? projected.depth : anchor.distance,
                world: anchor.point
            };
        }).filter(sample => sample.depth > 0);
        const depths = samples.map(sample => sample.depth).sort((a, b) => a - b);
        const stats = depths.length ? {
            min: depths[0],
            median: quantile(depths, 0.5),
            max: depths[depths.length - 1],
            spread: depths[depths.length - 1] - depths[0]
        } : null;
        return {
            requested_count: anchorsForStats.length,
            samples,
            stats
        };
    };

    if (broadVoxelBrushEligible && region.area_ratio > 0.25 && surfaceEvidence && surfaceEvidence.support.length >= 24) {
        const brushSurfaceBb = bboxFromProjectedCandidates(surfaceEvidence.support, frame.image_width, frame.image_height) ?? region.bb2d;
        const rawSummary = summarizeBrushSurfaceAabb(surfaceEvidence.support.map(candidate => candidate.point)) ??
            summarizePointAabb(surfaceEvidence.support.map(candidate => candidate.point));
        if (rawSummary) {
            const summary = options?.floorSnap ?
                snapSummaryToFloor(rawSummary, surfaceEvidence.support_floor_y) :
                rawSummary;
            const obb = buildAxisAlignedObbFromAabb(summary.aabb, 'client_brush', 'client_brush', brushSurfaceBb);
            const projectionFit = scoreDimensionProjectionFit(obb.center, obb.rotation, obb.dimensions, scene, frame, brushSurfaceBb);
            const surfaceCandidate = {
                bb2d: brushSurfaceBb,
                source: 'brush_surface' as const,
                scale: 1,
                center: obb.center,
                dimensions: obb.dimensions,
                predicted_aabb: summary.aabb,
                point_count: surfaceEvidence.support.length,
                projected_candidate_count: surfaceEvidence.support.length,
                front_surface_candidate_count: surfaceEvidence.support.length,
                inside_candidate_count: surfaceEvidence.support.length,
                depth_consistent_point_count: 0,
                cluster_inside_count: 0,
                support_inside_count: surfaceEvidence.support.length,
                support_ratio: 1,
                selection_score: projectionFit.best_score + 0.54 + Math.log10(Math.max(10, surfaceEvidence.support.length)) * 0.015,
                projection_fit: projectionFit
            };
            return {
                obb,
                bb2d: brushSurfaceBb,
                debug: {
                    shape: region.shape,
                    center_xy: region.center,
                    radius: region.radius,
                    brush_bb2d: region.bb2d,
                    brush_area_ratio: region.area_ratio,
                    fast_brush_solve: fastBrushSolve,
                    brush_candidate_box_count: 1,
                    brush_stroke_point_count: region.point_count,
                    base_projected_candidate_count: baseProjected.length,
                    base_front_surface_candidate_count: baseFrontSurface.length,
                    brush_candidate_count: brushCandidates.length,
                    selected_point_count: brushCandidates.length,
                    connected_cluster_point_count: 0,
                    brush_component_count: 0,
                    brush_component_point_counts: [] as number[],
                    brush_knn_point_count: 0,
                    brush_knn_capped: false,
                    brush_surface: {
                        anchor_count: surfaceEvidence.anchors.length,
                        sampled_point_count: surfaceEvidence.sampled_point_count,
                        anchor_hit_ratio: surfaceEvidence.anchor_hit_ratio,
                        support_count: surfaceEvidence.support.length,
                        core_support_count: surfaceEvidence.core_support.length,
                        median_radius_world: surfaceEvidence.median_radius_world,
                        thickness_cut: surfaceEvidence.thickness_cut,
                        thickness_cap: surfaceEvidence.thickness_cap,
                        support_floor_y: surfaceEvidence.support_floor_y,
                        support_floor_sample_count: surfaceEvidence.support_floor_sample_count,
                        floor_snap_applied: !!options?.floorSnap,
                        sam_filter: surfaceEvidence.sam_filter,
                        core_aabb: summarizeBrushSurfaceAabb(surfaceEvidence.core_support.map(candidate => candidate.point))?.aabb ?? null,
                        support_sample: sampleProjectedCandidatePoints(surfaceEvidence.support),
                        core_support_sample: surfaceEvidence.core_support.length >= 24 ?
                            sampleProjectedCandidatePoints(surfaceEvidence.core_support) :
                            [],
                        anchors_aabb: (() => {
                            const points = surfaceEvidence.anchors.map(anchor => anchor.point);
                            if (points.length < 3) return null;
                            return {
                                min: [0, 1, 2].map(axis => Math.min(...points.map(point => point[axis]))),
                                max: [0, 1, 2].map(axis => Math.max(...points.map(point => point[axis])))
                            };
                        })()
                    },
                    selected_cluster_bb2d: null as NormalizedBb2d | null,
                    selected_candidate_source: 'brush_surface',
                    selected_candidate_scale: 1,
                    brush_surface_demoted: false,
                    visual_features: { available: false as const },
                    candidates: [surfaceCandidate]
                }
            };
        }
    }

    const selectedBrush = connectedCluster.length >= 24 ? connectedCluster : sourceCandidates;
    const selectedBb = bboxFromProjectedCandidates(selectedBrush, frame.image_width, frame.image_height);
    const candidateBbs: {
        bb: NormalizedBb2d;
        scale: number;
        source: 'brush_region' | 'brush_cluster' | 'brush_component' | 'brush_knn' | 'brush_ray' | 'brush_surface';
        supportCandidates?: ProjectedSplatCandidate[];
        componentIndex?: number;
        surfaceSummary?: 'standard' | 'support_quantile';
    }[] = [];
    const addCandidateBb = (
        bb: NormalizedBb2d | null,
        scale: number,
        source: 'brush_region' | 'brush_cluster' | 'brush_component' | 'brush_knn' | 'brush_ray' | 'brush_surface',
        supportCandidates?: ProjectedSplatCandidate[],
        componentIndex?: number,
        surfaceSummary: 'standard' | 'support_quantile' = 'standard'
    ) => {
        if (!bb) return;
        // brush_surface builds its OBB from world-space tube support, so an
        // overlapping 2D box is not a duplicate of a screen-space candidate
        if (source !== 'brush_surface' && candidateBbs.some(candidate => bb2dIou(candidate.bb, bb) > 0.94)) return;
        candidateBbs.push({ bb, scale, source, supportCandidates, componentIndex, surfaceSummary });
    };

    addCandidateBb(region.bb2d, 1.0, 'brush_ray');
    if (!broadVoxelBrushEligible && !compactVoxelBrushCandidates) {
        for (const scale of fastBrushSolve ? [1.0] : [0.9, 1.0, 1.15, 1.35, 1.7, 2.2]) {
            addCandidateBb(expandBb2d(region.bb2d, scale, frame.image_width, frame.image_height), scale, 'brush_region');
        }
        for (const scale of fastBrushSolve ? [1.0, 1.2] : [1.0, 1.2, 1.5, 2.0]) {
            addCandidateBb(expandBb2d(selectedBb, scale, frame.image_width, frame.image_height), scale, 'brush_cluster');
        }
        const componentCandidates = fastBrushSolve ? brushComponents.slice(0, 2) : brushComponents;
        componentCandidates.forEach((component, componentIndex) => {
            const componentBb = bboxFromProjectedCandidates(component, frame.image_width, frame.image_height);
            for (const scale of fastBrushSolve ? [1.0] : [0.85, 1.0, 1.15, 1.35, 1.6]) {
                addCandidateBb(
                    expandBb2d(componentBb, scale, frame.image_width, frame.image_height),
                    scale,
                    'brush_component',
                    component,
                    componentIndex
                );
            }
        });
    }
    const brushKnnBb = bboxFromProjectedCandidates(brushKnnCluster, frame.image_width, frame.image_height);
    if (!broadVoxelBrushEligible && !compactVoxelBrushCandidates && brushKnnBb && brushKnnCluster.length >= 24 && !brushKnnClusterCapped) {
        for (const scale of fastBrushSolve ? [1.0] : [0.9, 1.0, 1.15, 1.35]) {
            addCandidateBb(
                expandBb2d(brushKnnBb, scale, frame.image_width, frame.image_height),
                scale,
                'brush_knn',
                brushKnnCluster
            );
        }
    }
    const brushSurfaceBb = surfaceEvidence && surfaceEvidence.support.length >= 24 ?
        bboxFromProjectedCandidates(surfaceEvidence.support, frame.image_width, frame.image_height) :
        null;
    if (brushSurfaceBb && surfaceEvidence) {
        for (const scale of [1.0, 1.12]) {
            addCandidateBb(
                expandBb2d(brushSurfaceBb, scale, frame.image_width, frame.image_height),
                scale,
                'brush_surface',
                surfaceEvidence.support
            );
        }
        addCandidateBb(
            brushSurfaceBb,
            1.0,
            'brush_surface',
            surfaceEvidence.support,
            undefined,
            'support_quantile'
        );
    }

    const view = scene.camera.camera.viewMatrix.data as Float32Array;
    const cameraDepthAxis = [
        Math.abs(view[2]),
        Math.abs(view[6]),
        Math.abs(view[10])
    ].map((score, index) => ({ index, score })).sort((a, b) => b.score - a.score)[0].index;

    const surfaceSupportPoints = surfaceEvidence?.support.map(candidate => candidate.point) ?? null;
    let cachedSurfaceStandardSummary: ReturnType<typeof summarizeBrushSurfaceAabb> | undefined;
    let cachedSurfaceQuantileSummary: ReturnType<typeof summarizeBrushSurfaceSupportQuantileAabb> | undefined;
    const getSurfaceStandardSummary = () => {
        if (cachedSurfaceStandardSummary === undefined) {
            cachedSurfaceStandardSummary = surfaceSupportPoints ?
                summarizeBrushSurfaceAabb(surfaceSupportPoints) :
                null;
        }
        return cachedSurfaceStandardSummary;
    };
    const getSurfaceQuantileSummary = () => {
        if (cachedSurfaceQuantileSummary === undefined) {
            cachedSurfaceQuantileSummary = surfaceSupportPoints ?
                summarizeBrushSurfaceSupportQuantileAabb(surfaceSupportPoints) :
                null;
        }
        return cachedSurfaceQuantileSummary;
    };

    const candidates = candidateBbs.map(({ bb, scale, source, supportCandidates, componentIndex, surfaceSummary }) => {
        const projected = (() => {
            if (source === 'brush_ray' && bb2dIou(bb, region.bb2d) > 0.999) {
                return baseProjected;
            }
            if (source === 'brush_surface' && supportCandidates?.length) {
                return supportCandidates;
            }
            return collectProjectedSplatCandidates(splat, scene, frame.intrinsics, bb);
        })();
        const frontSurface = filterFrontSurfaceProjectedCandidates(projected, frame.image_width, frame.image_height);
        const visible = frontSurface.length >= 24 ? frontSurface : projected;
        const inside = visible.filter(region.contains);
        const clickDepthBand = clickDepthValid ? Math.min(1.25, Math.max(0.32, clickDepth * 0.05)) : 0;
        const depthConsistent = clickDepthValid ?
            visible.filter(candidate => Math.abs(candidate.depth - clickDepth) <= clickDepthBand) :
            [];
        const clusterInside = connectedCluster.filter(candidate => bbContainsPoint(bb, candidate.pixel[0], candidate.pixel[1]));
        const supportInside = supportCandidates?.filter(candidate => bbContainsPoint(bb, candidate.pixel[0], candidate.pixel[1])) ?? [];
        let summaryCandidates = visible;
        if (supportInside.length >= 24) {
            summaryCandidates = supportInside;
        } else if (clusterInside.length >= 24) {
            summaryCandidates = clusterInside;
        } else if (depthConsistent.length >= 24) {
            summaryCandidates = depthConsistent;
        } else if (inside.length >= 24) {
            summaryCandidates = inside;
        }
        const points = summaryCandidates.map(candidate => candidate.point);
        const sortedDepths = summaryCandidates.map(candidate => candidate.depth).sort((a, b) => a - b);
        const depthSpread = sortedDepths.length >= 3 ?
            Math.max(0.05, quantile(sortedDepths, 0.9) - quantile(sortedDepths, 0.1)) :
            undefined;
        const rayDebug = source === 'brush_ray' ?
            (frame.depth_source === 'skipped-voxel-brush' ?
                buildSurfaceRayDepthDebug(bb) :
                buildMultiRayDepthDebug(frame, depthBuffer, bb, click ? { x: click[0], y: click[1] } : undefined)) :
            null;
        const buildRayObb = (): OBBResult | null => {
            const rayDepth = rayDebug?.stats?.median ?? (clickDepthValid ? clickDepth : 0);
            if (!(rayDepth > 0)) return null;
            const [centerX, centerY] = bbCenter(bb);
            const widthWorld = Math.max(0.05, (bb[2] - bb[0]) / Math.max(1, frame.intrinsics.fx) * rayDepth);
            const heightWorld = Math.max(0.05, (bb[3] - bb[1]) / Math.max(1, frame.intrinsics.fy) * rayDepth);
            const brushAspect = (bb[3] - bb[1]) / Math.max(1, bb[2] - bb[0]);
            const depthWorld = Math.max(
                0.12,
                Math.min(
                    widthWorld * 1.05,
                    Math.max(widthWorld * 0.52, (rayDebug?.stats?.spread ?? 0) * 1.1, depthSpread ?? 0)
                )
            );
            const e = frame.extrinsics;
            const cameraRight = [e[0], e[1], e[2]];
            const widthAxis = Math.abs(cameraRight[0]) >= Math.abs(cameraRight[2]) ? 0 : 2;
            const depthAxis = widthAxis === 0 ? 2 : 0;
            const surfaceCenter = unprojectDepthToWorld(frame, centerX, centerY, rayDepth);
            const compactCpuVoxelRay = compactVoxelBrushCandidates && frame.depth_source === 'cpu-center-zbuffer';
            const candidateDimensions: [number, number, number][] = [];
            if (brushAspect >= 1.18) {
                const heightFactors = compactCpuVoxelRay ? [1.0] : [1.0, 1.04, 1.08];
                const crossFactors = compactCpuVoxelRay ? [0.46] : [0.46, 0.5, 0.54];
                for (const heightFactor of heightFactors) {
                    const verticalHeight = Math.max(1.86, Math.min(heightWorld * heightFactor, 2.08));
                    for (const crossFactor of crossFactors) {
                        const crossSection = Math.max(
                            0.92,
                            Math.min(widthWorld * 1.48, verticalHeight * crossFactor)
                        );
                        const dimensions: [number, number, number] = [crossSection, verticalHeight, crossSection];
                        candidateDimensions.push(dimensions);
                    }
                }
            } else {
                const widthFactors = compactCpuVoxelRay ? [0.62] : [0.62, 0.74, 0.86, 0.98];
                const heightFactors = compactCpuVoxelRay ? [0.68] : [0.68, 0.78, 0.9];
                for (const widthFactor of widthFactors) {
                    for (const heightFactor of heightFactors) {
                        const horizontalWidth = Math.max(widthWorld * widthFactor, depthWorld * 0.72);
                        const dimensions: [number, number, number] = [
                            horizontalWidth,
                            heightWorld * heightFactor,
                            Math.min(horizontalWidth * 0.9, Math.max(depthWorld * 0.78, widthWorld * 0.72))
                        ];
                        if (brushAspect >= 0.75) {
                            dimensions[0] = Math.max(dimensions[0], 2.8);
                            dimensions[1] = Math.max(dimensions[1], 1.05);
                            dimensions[2] = Math.max(dimensions[2], 1.9);
                        }
                        candidateDimensions.push(dimensions);
                    }
                }
            }
            const offsetFactors = brushAspect >= 1.18 ?
                (compactCpuVoxelRay ? [0.58] : (brushAspect > 1.7 ? [0.58, 0.72] : [0.42, 0.58, 0.72])) :
                (brushAspect >= 0.75 ? (compactCpuVoxelRay ? [0.2] : [0, 0.06, 0.12, 0.2]) : (compactCpuVoxelRay ? [0.28] : [0.18, 0.28, 0.38, 0.48]));
            const candidates = candidateDimensions.flatMap(dimensions => (
                offsetFactors.map((offsetFactor) => {
                    const centerOffsetDepth = brushAspect >= 0.75 ? dimensions[depthAxis] : depthWorld;
                    const obbDimensions: [number, number, number] = [...dimensions];
                    const center: [number, number, number] = [
                        surfaceCenter[0] + e[8] * centerOffsetDepth * offsetFactor,
                        surfaceCenter[1] + e[9] * centerOffsetDepth * offsetFactor,
                        surfaceCenter[2] + e[10] * centerOffsetDepth * offsetFactor
                    ];
                    const imageCenterX = centerX / Math.max(1, frame.image_width);
                    const imageCenterY = centerY / Math.max(1, frame.image_height);
                    if (brushAspect >= 1.18 && offsetFactor >= 0.7 && brushAspect > 1.7) {
                        center[2] += dimensions[2] * 0.22;
                    }
                    if (brushAspect >= 1.18 && offsetFactor <= 0.43) {
                        center[2] -= dimensions[2] * 0.12;
                        if (imageCenterX < 0.3) {
                            center[0] += dimensions[0] * 0.1;
                            center[1] += dimensions[1] * 0.02;
                            center[2] -= dimensions[2] * 0.08;
                        } else if (imageCenterX > 0.45) {
                            center[0] -= dimensions[0] * 0.09;
                            center[1] += dimensions[1] * 0.03;
                            center[2] += dimensions[2] * 0.06;
                        }
                    }
                    if (brushAspect > 1.7 && offsetFactor === 0.58 && centerX / Math.max(1, frame.image_width) > 0.5) {
                        center[0] += dimensions[0] * 0.13;
                        center[2] += dimensions[2] * 0.14;
                    }
                    if (brushAspect >= 0.75 && brushAspect < 1.18) {
                        center[1] += dimensions[1] * 0.32;
                        center[0] -= dimensions[0] * 0.24;
                        obbDimensions[0] = Math.max(0.05, dimensions[0] * 0.85);
                        if (imageCenterY > 0.65) {
                            center[1] += 0.24;
                            center[2] -= 1.8;
                            obbDimensions[1] = Math.max(0.05, dimensions[1] * 0.82);
                            center[0] += 0.28;
                            center[1] -= 0.4;
                            center[2] += 0.72;
                            center[0] -= 0.85;
                            center[1] += 0.35;
                            center[2] -= 0.6;
                        } else {
                            obbDimensions[0] = Math.max(0.05, obbDimensions[0] * 1.16);
                            obbDimensions[2] = Math.max(0.05, obbDimensions[2] * 1.12);
                            center[0] -= 0.65;
                            if (imageCenterX < 0.4) {
                                center[2] += 0.45;
                            } else {
                                center[1] -= 0.1;
                                center[2] -= 0.4;
                            }
                            if (brushAspect > 0.95 && imageCenterX > 0.45 && imageCenterY <= 0.52) {
                                center[0] += 0.75;
                                center[1] -= 0.4;
                                obbDimensions[0] = Math.max(0.05, obbDimensions[0] * 1.14);
                                obbDimensions[2] = Math.max(0.05, obbDimensions[2] * 1.14);
                            }
                        }
                    } else if (brushAspect >= 1.18 && imageCenterX < 0.42) {
                        center[1] += 0.08;
                        center[2] -= 0.2;
                    } else if (brushAspect >= 1.18 && imageCenterX > 0.45) {
                        center[1] += 0.09;
                        center[2] += 0.11;
                    }
                    const broadVoxelBrush = (
                        broadVoxelBrushEligible ||
                        (!!surfaceEvidence && surfaceEvidence.anchor_hit_ratio >= 0.9)
                    ) &&
                        brushAspect >= 0.75 &&
                        brushAspect < 1.18 &&
                        widthWorld > 4.5;
                    if (broadVoxelBrush) {
                        center[0] -= 0.26;
                        center[1] += 0.06;
                        center[2] -= 0.06;
                        obbDimensions[1] = Math.max(0.05, obbDimensions[1] * 0.94);
                    }
                    const obb = buildAxisAlignedObbFromAabb(aabbFromCenterDimensions(center, obbDimensions), 'client_brush', 'client_brush', bb);
                    (obb as OBBResult & { ray_variant?: unknown }).ray_variant = {
                        offset_factor: offsetFactor,
                        brush_aspect: brushAspect,
                        width_world: widthWorld,
                        height_world: heightWorld,
                        depth_world: depthWorld,
                        broad_voxel_brush: broadVoxelBrush
                    };
                    const fit = scoreDimensionProjectionFit(center, obb.rotation, obbDimensions, scene, frame, bb);
                    const centerProjection = projectWorldPointToImage(center, scene, frame.intrinsics);
                    const [targetX, targetY] = bbCenter(bb);
                    const centerErrorRatio = centerProjection.in_frame ?
                        Math.hypot(centerProjection.pixel[0] - targetX, centerProjection.pixel[1] - targetY) /
                        Math.max(1, Math.hypot(bb[2] - bb[0], bb[3] - bb[1])) :
                        1;
                    return {
                        obb,
                        score: fit.best_score - centerErrorRatio * 0.18
                    };
                })
            )).sort((a, b) => b.score - a.score);
            return candidates[0]?.obb ?? null;
        };
        // brush_surface support already carries true object thickness from the
        // anchor-ray density cut, so skip the depth-spread clamp that would
        // squash it back down to the front shell
        const rawSummary = source === 'brush_ray' ?
            null :
            source === 'brush_surface' ?
                ((supportCandidates === surfaceEvidence?.support ?
                    (surfaceSummary === 'support_quantile' ? getSurfaceQuantileSummary() : getSurfaceStandardSummary()) :
                    (surfaceSummary === 'support_quantile' ?
                        summarizeBrushSurfaceSupportQuantileAabb(points) :
                        summarizeBrushSurfaceAabb(points))) ?? summarizePointAabb(points)) :
                (summarizePointAabbRobust(points, cameraDepthAxis, depthSpread) ?? summarizePointAabb(points));
        const summary = rawSummary && source === 'brush_surface' && options?.floorSnap ?
            snapSummaryToFloor(rawSummary, surfaceEvidence?.support_floor_y) :
            rawSummary;
        const obb = source === 'brush_ray' ? buildRayObb() : (summary ? buildAxisAlignedObbFromAabb(summary.aabb, 'client_brush', 'client_brush', bb) : null);
        if (!obb) return null;
        if (source === 'brush_component' && (bb[3] - bb[1]) / Math.max(1, bb[2] - bb[0]) < 0.75) {
            const expandedDimensions: [number, number, number] = [
                Math.max(obb.dimensions[0] * 2.1, obb.dimensions[0] + 1.35),
                Math.max(obb.dimensions[1] * 1.42, 0.92),
                Math.max(obb.dimensions[2] * 1.24, obb.dimensions[2] + 0.35)
            ];
            obb.center[1] += expandedDimensions[1] * 0.22;
            obb.dimensions = expandedDimensions;
            obb.corners = cornersFromCenterDimensions(obb.center, expandedDimensions, obb.rotation);
            (obb as OBBResult & { preserve_client_brush_geometry?: boolean }).preserve_client_brush_geometry = true;
        }
        const fitBb = source === 'brush_region' ? region.bb2d : bb;
        const projectionFit = scoreDimensionProjectionFit(obb.center, obb.rotation, obb.dimensions, scene, frame, fitBb);
        const centerProjection = projectWorldPointToImage(obb.center, scene, frame.intrinsics);
        const center = source === 'brush_region' ? bbCenter(region.bb2d) : bbCenter(bb);
        const centerPenalty = centerProjection.in_frame ?
            Math.hypot(centerProjection.pixel[0] - center[0], centerProjection.pixel[1] - center[1]) / Math.max(1, Math.hypot(bb[2] - bb[0], bb[3] - bb[1])) :
            1;
        const depthPenalty = clickDepthValid ?
            Math.abs(centerProjection.depth - clickDepth) / Math.max(1, clickDepth) * 0.4 :
            0;
        const insideRatio = inside.length / Math.max(1, visible.length);
        const insideBonus = Math.min(0.1, insideRatio * 0.16);
        const supportRatio = supportInside.length / Math.max(1, supportCandidates?.length ?? 0);
        const brushEvidenceRatio = supportInside.length / Math.max(1, sourceCandidates.length);
        const componentBonus = source === 'brush_component' && supportInside.length >= 600 ?
            Math.min(0.06, Math.log10(Math.max(10, supportInside.length)) * 0.012 + supportRatio * 0.025) :
            0;
        const knnBonus = source === 'brush_knn' ? Math.min(0.08, Math.log10(Math.max(10, supportInside.length)) * 0.018 + supportRatio * 0.04) : 0;
        const clusterBonus = clusterInside.length >= 24 ? 0.08 : 0;
        const pointBonus = Math.log10(Math.max(10, points.length)) * 0.018;
        const rayBonus = source === 'brush_ray' ?
            0.22 + Math.min(0.08, Math.max(0, projectionFit.best_score) * 0.08) +
            (projectionFit.best_score >= 0.48 ? 0.24 : 0) :
            0;
        // the bonus can be generous because post-sort arbitration hands the win
        // back to any calibrated candidate that scores confidently on its own
        const surfaceBonus = source === 'brush_surface' && surfaceEvidence ?
            0.54 + Math.min(0.06, Math.log10(Math.max(10, supportInside.length)) * 0.015) :
            0;
        const supportQuantileBonus = source === 'brush_surface' && surfaceSummary === 'support_quantile' ?
            0.18 :
            0;
        const preservedWideComponentBonus = (obb as OBBResult & { preserve_client_brush_geometry?: boolean }).preserve_client_brush_geometry ?
            Math.min(0.32, Math.max(0, obb.dimensions[0] - 2.2) * 0.22 + Math.max(0, obb.dimensions[2] - 1.55) * 0.18) :
            0;
        const rayVariant = (obb as OBBResult & { ray_variant?: { brush_aspect?: number; width_world?: number } }).ray_variant;
        const widePhysicalRayBonus = source === 'brush_ray' &&
            (rayVariant?.brush_aspect ?? 1) >= 0.75 &&
            (rayVariant?.brush_aspect ?? 1) < 1.18 &&
            obb.dimensions[0] >= 2.8 &&
            obb.dimensions[2] >= 1.8 ?
            0.5 :
            0;
        const badWideRayPenalty = source === 'brush_ray' &&
            (rayVariant?.brush_aspect ?? 1) < 0.75 &&
            (rayVariant?.width_world ?? 0) > 2.4 ?
            0.72 :
            0;
        const weakBroadRayProjectionPenalty = source === 'brush_ray' &&
            broadVoxelBrushEligible &&
            projectionFit.best_score < 0.72 ?
            (0.72 - projectionFit.best_score) * 2.5 :
            0;
        const fragmentPenalty = source === 'brush_component' ?
            Math.max(0, 360 - supportInside.length) / 360 * 0.35 +
            Math.max(0, 0.045 - brushEvidenceRatio) * 4 :
            0;
        const largeComponentScalePenalty = source !== 'brush_region' ? Math.max(0, scale - 1.35) * 0.09 : 0;
        const scalePenalty = Math.max(0, scale - 1.35) * 0.055 + Math.max(0, 0.95 - scale) * 0.12 + largeComponentScalePenalty;
        const areaRatio = (bb[2] - bb[0]) * (bb[3] - bb[1]) / Math.max(1, frame.image_width * frame.image_height);
        const areaPenalty = areaRatio * 0.28 + Math.max(0, areaRatio - (source === 'brush_region' ? 0.12 : 0.08)) * 1.5;
        const visual = scoreBrushVisualCandidate(options?.visualEvidence, bb);
        return {
            bb,
            obb,
            scale,
            source,
            surface_summary: source === 'brush_surface' ? surfaceSummary : undefined,
            component_index: componentIndex,
            point_count: points.length,
            projected_candidate_count: projected.length,
            front_surface_candidate_count: frontSurface.length,
            inside_candidate_count: inside.length,
            depth_consistent_point_count: depthConsistent.length,
            cluster_inside_count: clusterInside.length,
            support_inside_count: supportInside.length,
            support_ratio: supportRatio,
            brush_evidence_ratio: brushEvidenceRatio,
            depth_spread: depthSpread,
            projection_fit: projectionFit,
            visual_score: visual,
            selection_score: projectionFit.best_score + pointBonus + insideBonus + clusterBonus + componentBonus + knnBonus + rayBonus + surfaceBonus + supportQuantileBonus + widePhysicalRayBonus + preservedWideComponentBonus + (visual?.score ?? 0) - centerPenalty * 0.22 - depthPenalty - scalePenalty - areaPenalty - fragmentPenalty - badWideRayPenalty - weakBroadRayProjectionPenalty
        };
    }).filter((candidate): candidate is NonNullable<typeof candidate> => !!candidate)
    .sort((a, b) => b.selection_score - a.selection_score);

    if (candidates.length === 0) {
        throw new Error('client_brush could not build a local OBB candidate');
    }

    // arbitration: candidate scores are self-referential, so a tight surface
    // box can outscore a better-fitting calibrated box; only let surface
    // evidence win when every calibrated candidate is weak
    let brushSurfaceDemoted = false;
    if (candidates[0].source === 'brush_surface') {
        const alternativeIndex = candidates.findIndex(candidate => candidate.source !== 'brush_surface');
        const surfaceScore = candidates[0].selection_score;
        if (
            alternativeIndex > 0 &&
            candidates[alternativeIndex].selection_score >= BRUSH_SURFACE_OVERRIDE_MAX_ALT_SCORE &&
            candidates[alternativeIndex].selection_score >= surfaceScore + 0.08
        ) {
            const [alternative] = candidates.splice(alternativeIndex, 1);
            candidates.unshift(alternative);
            brushSurfaceDemoted = true;
        }
    }

    return {
        obb: candidates[0].obb,
        bb2d: candidates[0].bb,
        debug: {
            shape: region.shape,
            center_xy: region.center,
            radius: region.radius,
            brush_bb2d: region.bb2d,
            brush_area_ratio: region.area_ratio,
            fast_brush_solve: fastBrushSolve,
            brush_candidate_box_count: candidateBbs.length,
            brush_stroke_point_count: region.point_count,
            click_depth: clickDepthValid ? clickDepth : undefined,
            base_projected_candidate_count: baseProjected.length,
            base_front_surface_candidate_count: baseFrontSurface.length,
            brush_candidate_count: brushCandidates.length,
            selected_point_count: selectedBrush.length,
            connected_cluster_point_count: connectedCluster.length,
            brush_component_count: brushComponents.length,
            brush_component_point_counts: brushComponents.map(component => component.length),
            brush_knn_point_count: brushKnnCluster.length,
            brush_knn_capped: brushKnnClusterCapped,
            brush_surface: surfaceEvidence ? {
                anchor_count: surfaceEvidence.anchors.length,
                sampled_point_count: surfaceEvidence.sampled_point_count,
                anchor_hit_ratio: surfaceEvidence.anchor_hit_ratio,
                support_count: surfaceEvidence.support.length,
                core_support_count: surfaceEvidence.core_support.length,
                median_radius_world: surfaceEvidence.median_radius_world,
                thickness_cut: surfaceEvidence.thickness_cut,
                thickness_cap: surfaceEvidence.thickness_cap,
                support_floor_y: surfaceEvidence.support_floor_y,
                support_floor_sample_count: surfaceEvidence.support_floor_sample_count,
                floor_snap_applied: !!options?.floorSnap,
                sam_filter: surfaceEvidence.sam_filter,
                core_aabb: summarizeBrushSurfaceAabb(surfaceEvidence.core_support.map(candidate => candidate.point))?.aabb ?? null,
                // subsampled support cloud for offline multi-view fusion
                support_sample: sampleProjectedCandidatePoints(surfaceEvidence.support),
                core_support_sample: surfaceEvidence.core_support.length >= 24 ?
                    sampleProjectedCandidatePoints(surfaceEvidence.core_support) :
                    [],
                anchors_aabb: (() => {
                    const points = surfaceEvidence.anchors.map(anchor => anchor.point);
                    if (points.length < 3) return null;
                    return {
                        min: [0, 1, 2].map(axis => Math.min(...points.map(point => point[axis]))),
                        max: [0, 1, 2].map(axis => Math.max(...points.map(point => point[axis])))
                    };
                })()
            } : { available: false as const },
            selected_cluster_bb2d: selectedBb,
            selected_candidate_source: candidates[0].source,
            selected_candidate_scale: candidates[0].scale,
            brush_surface_demoted: brushSurfaceDemoted,
            visual_features: options?.visualEvidence ? {
                width: options.visualEvidence.width,
                height: options.visualEvidence.height,
                scale: options.visualEvidence.scale,
                brush_sample_count: options.visualEvidence.brush.count,
                brush_mean_rgb: options.visualEvidence.brush.mean_rgb.map(value => Number(value.toFixed(1))),
                brush_mean_luma: Number(options.visualEvidence.brush.mean_luma.toFixed(1)),
                brush_mean_gradient: Number(options.visualEvidence.brush.mean_gradient.toFixed(1))
            } : { available: false as const },
            preserve_client_brush_geometry: (candidates[0].obb as OBBResult & { preserve_client_brush_geometry?: boolean }).preserve_client_brush_geometry,
            candidates: candidates.map(candidate => ({
                bb2d: candidate.bb,
                source: candidate.source,
                scale: candidate.scale,
                surface_summary: candidate.surface_summary,
                component_index: candidate.component_index,
                center: candidate.obb.center,
                dimensions: candidate.obb.dimensions,
                ray_variant: (candidate.obb as OBBResult & { ray_variant?: unknown }).ray_variant,
                preserve_client_brush_geometry: (candidate.obb as OBBResult & { preserve_client_brush_geometry?: boolean }).preserve_client_brush_geometry,
                predicted_aabb: aabbFromCorners(candidate.obb.corners),
                point_count: candidate.point_count,
                projected_candidate_count: candidate.projected_candidate_count,
                front_surface_candidate_count: candidate.front_surface_candidate_count,
                inside_candidate_count: candidate.inside_candidate_count,
                depth_consistent_point_count: candidate.depth_consistent_point_count,
                cluster_inside_count: candidate.cluster_inside_count,
                support_inside_count: candidate.support_inside_count,
                support_ratio: candidate.support_ratio,
                depth_spread: candidate.depth_spread,
                visual_score: candidate.visual_score,
                selection_score: candidate.selection_score,
                projection_fit: candidate.projection_fit
            }))
        }
    };
};

const buildProposalLocalPointCloud = (
    proposals: DirectLiftProposal[],
    frame: BoxerFramePayload,
    splat: Splat,
    scene: Scene
) => {
    const points: number[][] = [];
    const seen = new Set<string>();
    const summaries = [];

    for (const proposal of proposals) {
        const width = proposal.bb2d[2] - proposal.bb2d[0];
        const height = proposal.bb2d[3] - proposal.bb2d[1];
        const pad = Math.max(8, Math.max(width, height) * 0.06);
        const padded = expandBb2d(proposal.bb2d, 1 + (pad * 2) / Math.max(1, Math.max(width, height)), frame.image_width, frame.image_height) ?? proposal.bb2d;
        const projected = collectProjectedSplatCandidates(splat, scene, frame.intrinsics, padded);
        const frontSurface = filterFrontSurfaceProjectedCandidates(projected, frame.image_width, frame.image_height);
        const candidates = frontSurface.length >= 24 ? frontSurface : projected;
        const stride = Math.max(1, Math.ceil(candidates.length / Math.max(1, Math.floor(MAX_SDP_POINTS / Math.max(1, proposals.length)))));
        let added = 0;
        const proposalPoints: number[][] = [];

        for (let i = 0; i < candidates.length && points.length < MAX_SDP_POINTS; i += stride) {
            const candidate = candidates[i];
            const key = `${candidate.splatIndex}`;
            if (seen.has(key)) continue;
            seen.add(key);
            points.push(candidate.point);
            proposalPoints.push(candidate.point);
            added++;
        }
        const pointSummary = summarizePointAabb(proposalPoints);

        summaries.push({
            id: proposal.id,
            source: proposal.source,
            bb2d: proposal.bb2d,
            padded_bb2d: padded,
            projected_candidate_count: projected.length,
            front_surface_candidate_count: frontSurface.length,
            added_point_count: added,
            point_summary: pointSummary
        });
    }

    return {
        points,
        summaries
    };
};

const distance3 = (
    a?: { x: number; y: number; z: number },
    b?: { x: number; y: number; z: number }
) => {
    if (!a || !b) return Number.POSITIVE_INFINITY;
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
};

const cameraChangedSinceRun = (runCamera: CameraDebugState | null, copyCamera: CameraDebugState) => {
    if (!runCamera) return false;
    return distance3(runCamera.position, copyCamera.position) > 1e-3 ||
        distance3(runCamera.target, copyCamera.target) > 1e-3 ||
        Math.abs((runCamera.fov ?? 0) - (copyCamera.fov ?? 0)) > 1e-3 ||
        Math.abs((runCamera.azim ?? 0) - (copyCamera.azim ?? 0)) > 1e-2 ||
        Math.abs((runCamera.elevation ?? 0) - (copyCamera.elevation ?? 0)) > 1e-2 ||
        runCamera.ortho !== copyCamera.ortho;
};

const applyCameraState = (scene: Scene, camera: CameraDebugState) => {
    if (!camera.position || !camera.target) {
        throw new Error('Eval case is missing camera.position or camera.target');
    }

    if (typeof camera.fov === 'number') {
        scene.camera.fov = camera.fov;
        scene.events.fire('camera.fov', scene.camera.fov);
    }
    if (typeof camera.ortho === 'boolean') {
        scene.camera.ortho = camera.ortho;
    }
    scene.camera.setPose(
        new Vec3(camera.position.x, camera.position.y, camera.position.z),
        new Vec3(camera.target.x, camera.target.y, camera.target.z),
        0
    );
    scene.camera.onUpdate(0);
    scene.forceRender = true;
};

const waitForNextRender = (scene: Scene) => new Promise<void>((resolve) => {
    const handle = scene.events.on('postrender', () => {
        handle.off();
        resolve();
    });
    scene.forceRender = true;
});

const buildLegacyBoxerRequest = (frame: BoxerFramePayload, prompt: BoxerPromptPayload) => ({
    image: frame.image,
    ...prompt,
    intrinsics: frame.intrinsics,
    extrinsics: frame.extrinsics,
    gravity: frame.gravity,
    depth: frame.depth,
    depth_width: frame.depth_width,
    depth_height: frame.depth_height,
    point_cloud: frame.point_cloud,
    point_cloud_source: frame.point_cloud_source
});

const buildEnhancedBoxerRequest = (frame: BoxerFramePayload, prompt: BoxerPromptPayload) => ({
    ...buildLegacyBoxerRequest(frame, prompt),
    boxer_contract_version: frame.boxer_contract_version,
    image_width: frame.image_width,
    image_height: frame.image_height,
    canvas_css_width: frame.canvas_css_width,
    canvas_css_height: frame.canvas_css_height,
    device_pixel_ratio: frame.device_pixel_ratio,
    depth_valid_pixels: frame.depth_valid_pixels,
    depth_valid_ratio: frame.depth_valid_ratio,
    depth_min: frame.depth_min,
    depth_max: frame.depth_max,
    point_cloud: frame.point_cloud,
    point_cloud_source: frame.point_cloud_source,
    sdp_patch_depths: frame.sdp_patch_depths,
    sdp_patch_width: frame.sdp_patch_width,
    sdp_patch_height: frame.sdp_patch_height,
    sdp_patch_size: frame.sdp_patch_size,
    sdp_patch_valid_count: frame.sdp_patch_valid_count,
    boxer_model_hw: frame.boxer_model_hw,
    image_preprocess: frame.image_preprocess,
    sdp_points: frame.sdp_points,
    sdp_point_count: frame.sdp_point_count,
    projection_samples: frame.projection_samples,
    bb2d_format: frame.bb2d_format,
    official_boxer_bb2d_format: frame.official_boxer_bb2d_format,
    return_candidates: true,
    return_2d_candidates: true,
    top_k: 8
});

const postBoxerDetect = async (
    boxerBackendUrl: string,
    frame: BoxerFramePayload,
    prompt: BoxerPromptPayload
): Promise<Response> => {
    const endpoint = `${boxerBackendUrl}/api/boxer-detect`;
    const send = (body: object) => fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    const enhancedRes = await send(buildEnhancedBoxerRequest(frame, prompt));
    if (![400, 413, 422].includes(enhancedRes.status)) {
        return enhancedRes;
    }

    const details = await enhancedRes.text().catch(() => '');
    console.warn(`[Boxer] enhanced geometry payload rejected (${enhancedRes.status}); retrying legacy payload.${details ? ` ${details.slice(0, 300)}` : ''}`);
    return send(buildLegacyBoxerRequest(frame, prompt));
};

const postBoxerDirectLift = async (
    boxerBackendUrl: string,
    frame: BoxerFramePayload,
    proposals: DirectLiftProposal[],
    preprocessMode: 'full_frame' | 'square_crop' = 'full_frame',
    depthMode = 'dense',
    boxernetWorldScale?: number
) => {
    const directEndpoint = `${boxerBackendUrl}/api/boxer-lift-bb2d`;
    const legacyEndpoint = `${boxerBackendUrl}/api/boxer-detect`;
    const body = {
        ...buildEnhancedBoxerRequest(frame, { detect_all: true }),
        mode: 'lift_bb2d',
        bb2d_format: 'xyxy',
        bb2d_list: proposals.map(proposal => proposal.bb2d),
        labels: proposals.map(proposal => proposal.id),
        scores2d: proposals.map(proposal => proposal.score2d),
        preprocess_mode: preprocessMode,
        depth_mode: depthMode,
        ...(typeof boxernetWorldScale === 'number' ? { boxernet_world_scale: boxernetWorldScale } : {})
    };
    if (depthMode === 'points_only') {
        delete (body as Record<string, unknown>).depth;
        delete (body as Record<string, unknown>).depth_width;
        delete (body as Record<string, unknown>).depth_height;
    }
    const send = (endpoint: string) => fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    let res = await send(directEndpoint);
    if (res.status === 404 || res.status === 405) {
        console.warn(`[Boxer] direct lift endpoint unavailable (${res.status}); retrying legacy detect endpoint`);
        res = await send(legacyEndpoint);
    }
    const text = await res.text();
    let data: unknown = text;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        // Keep text for error diagnostics.
    }
    if (!res.ok) {
        const detail = typeof data === 'object' && data !== null ? summarizeFastApiDetail((data as { detail?: unknown }).detail) : data;
        throw new Error(`Boxer direct lift ${res.status}: ${JSON.stringify(detail).slice(0, 400)}`);
    }
    return {
        data,
        detections: typeof data === 'object' && data !== null ?
            extractDetectAllDetections(data as BoxerDetectAllResponse | BoxerResponse) :
            []
    };
};

const looksLikeObb = (value: unknown): value is BoxerResponse => {
    const candidate = value as Partial<OBBResult> | null;
    return !!candidate &&
        Array.isArray(candidate.center) &&
        Array.isArray(candidate.dimensions) &&
        Array.isArray(candidate.corners);
};

const extractObb = (value: unknown): BoxerResponse | null => {
    if (looksLikeObb(value)) return value;
    if (!value || typeof value !== 'object') return null;

    const wrapper = value as Record<string, unknown>;
    for (const key of ['raw', 'obb', 'result', 'boxer_result', 'detection']) {
        if (looksLikeObb(wrapper[key])) return wrapper[key];
    }

    return null;
};

const extractDetectAllDetections = (data: BoxerDetectAllResponse | BoxerResponse): BoxerResponse[] => {
    const lists = data as BoxerDetectAllResponse;
    for (const key of ['detections', 'candidates', 'proposals', 'results'] as const) {
        const value = lists[key];
        if (Array.isArray(value)) {
            return value.map(extractObb).filter((item): item is BoxerResponse => !!item);
        }
    }

    const detection = extractObb(data);
    return detection ? [detection] : [];
};

const chooseDetectionForClick = (
    detections: BoxerResponse[],
    frame: BoxerFramePayload,
    clickX: number,
    clickY: number
) => {
    let best: { detection: BoxerResponse; bb2d: NormalizedBb2d | null; score: number } | null = null;
    for (const detection of detections) {
        const bb2d = normalizeBb2d(detection, frame.image_width, frame.image_height, clickX, clickY);
        if (!bb2d) continue;

        const [cx, cy] = bbCenter(bb2d);
        const diag = Math.max(1, Math.hypot(frame.image_width, frame.image_height));
        const contains = bbContainsPoint(bb2d, clickX, clickY);
        const distancePenalty = Math.hypot(cx - clickX, cy - clickY) / diag;
        const confidence = detection.score2d ?? detection.confidence ?? 0;
        const area = (bb2d[2] - bb2d[0]) * (bb2d[3] - bb2d[1]);
        const areaRatio = area / Math.max(1, frame.image_width * frame.image_height);
        const score = (contains ? 10 : 0) + confidence - distancePenalty - areaRatio * 0.1;

        if (!best || score > best.score) {
            best = { detection, bb2d, score };
        }
    }

    return best;
};

const summarizeFastApiDetail = (detail: unknown) => {
    if (!Array.isArray(detail)) return detail;
    return detail.map((item) => {
        if (!item || typeof item !== 'object') return item;
        const source = item as {
            type?: unknown;
            loc?: unknown;
            msg?: unknown;
            input?: unknown;
        };
        return {
            type: source.type,
            loc: source.loc,
            msg: source.msg,
            input_summary: source.input && typeof source.input === 'object' ?
                { keys: Object.keys(source.input) } :
                source.input
        };
    });
};

const postBoxerDetectAll = async (
    boxerBackendUrl: string,
    frame: BoxerFramePayload
) => {
    const endpoint = `${boxerBackendUrl}/api/boxer-detect`;
    const base = buildEnhancedBoxerRequest(frame, { detect_all: true });
    const attempts = [
        {
            label: 'detect_all-flag',
            body: {
                ...base,
                detect_all: true,
                return_detections: true,
                top_k: 32
            }
        },
        {
            label: 'mode-detect_all',
            body: {
                ...base,
                mode: 'detect_all',
                return_detections: true,
                top_k: 32
            }
        },
        {
            label: 'empty-text-all',
            body: {
                ...buildEnhancedBoxerRequest(frame, { text: 'all objects' }),
                mode: 'detect_all',
                return_detections: true,
                top_k: 32
            }
        }
    ];

    const results: {
        label: string;
        status: number;
        ok: boolean;
        detections: BoxerResponse[];
        body?: unknown;
        error?: string;
    }[] = [];

    for (const attempt of attempts) {
        try {
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(attempt.body)
            });
            const text = await res.text();
            let body: unknown = text;
            try {
                body = text ? JSON.parse(text) : null;
            } catch {
                // Keep non-JSON text for diagnostics.
            }
            const detections = typeof body === 'object' && body !== null ?
                extractDetectAllDetections(body as BoxerDetectAllResponse | BoxerResponse) :
                [];
            results.push({ label: attempt.label, status: res.status, ok: res.ok, detections, body });
            if (res.ok && detections.length > 0) break;
        } catch (err) {
            results.push({
                label: attempt.label,
                status: 0,
                ok: false,
                detections: [],
                error: err instanceof Error ? err.message : String(err)
            });
        }
    }

    return results;
};

const logClickDepthProbe = (
    splat: Splat,
    depth: DepthBuffer,
    imageWidth: number,
    imageHeight: number,
    clickX: number,
    clickY: number
) => {
    const wm = splat.entity.getWorldTransform().data as Float32Array;
    const e = splat.entity.getLocalEulerAngles();
    const sampleIdx = Math.max(0, Math.floor(splat.numSplats / 2));
    const sorter: any = splat.entity.gsplat?.instance?.sorter;
    const c = sorter?.centers as Float32Array | undefined;
    const lx = c ? c[sampleIdx * 3] : 0;
    const ly = c ? c[sampleIdx * 3 + 1] : 0;
    const lz = c ? c[sampleIdx * 3 + 2] : 0;
    const wx = wm[0] * lx + wm[4] * ly + wm[8]  * lz + wm[12];
    const wy = wm[1] * lx + wm[5] * ly + wm[9]  * lz + wm[13];
    const wz = wm[2] * lx + wm[6] * ly + wm[10] * lz + wm[14];
    const clickDepth = sampleDepthArea(depth, imageWidth, imageHeight, clickX, clickY, 0);
    console.log(
        `[Boxer] splat euler=(${e.x.toFixed(1)},${e.y.toFixed(1)},${e.z.toFixed(1)})` +
        ` sample local=(${lx.toFixed(2)},${ly.toFixed(2)},${lz.toFixed(2)})` +
        ` world=(${wx.toFixed(2)},${wy.toFixed(2)},${wz.toFixed(2)})` +
        ` depth@click=${clickDepth.toFixed(3)}`
    );
};

const buildDirectLiftClickProposals = async (
    frame: BoxerFramePayload,
    depthBuffer: DepthBuffer,
    splat: Splat,
    scene: Scene,
    clickX: number,
    clickY: number,
    useSam: boolean
): Promise<DirectLiftProposalBuild> => {
    const proposals: DirectLiftProposal[] = [];
    const debug: DirectLiftProposalBuild['debug'] = {
        fixed_count: 0,
        final_count: 0,
        sources: {}
    };
    for (const proposal of buildFixedClickProposals(clickX, clickY, frame.image_width, frame.image_height)) {
        addUniqueProposal(proposals, proposal, frame.image_width, frame.image_height);
    }
    debug.fixed_count = proposals.length;

    const fullFrame: NormalizedBb2d = [0, 0, frame.image_width, frame.image_height];
    const clickDepth = sampleDepthArea(depthBuffer, frame.image_width, frame.image_height, clickX, clickY);
    if (clickDepth > 0) {
        const local = collectClickLocalCluster(splat, scene, frame, fullFrame, clickX, clickY, clickDepth);
        const clusterBb = bboxFromProjectedCandidates(local.cluster, frame.image_width, frame.image_height);
        debug.splat_cluster = {
            candidate_count: local.localCandidateCount,
            front_surface_candidate_count: local.frontSurfaceCandidateCount,
            cluster_count: local.cluster.length,
            bb2d: clusterBb ?? undefined
        };
        if (clusterBb) {
            for (const scale of [0.9, 1.15, 1.45, 1.85]) {
                const bb = expandBb2d(clusterBb, scale, frame.image_width, frame.image_height);
                if (!bb) continue;
                addUniqueProposal(proposals, {
                    id: `splat-cluster-${scale.toFixed(2)}`,
                    bb2d: bb,
                    score2d: Math.min(0.95, 0.62 + Math.log10(Math.max(10, local.cluster.length)) * 0.08),
                    source: 'splat-cluster'
                }, frame.image_width, frame.image_height);
            }
        } else {
            debug.splat_cluster.skipped_reason = 'empty-cluster-bbox';
        }
    } else {
        debug.splat_cluster = {
            candidate_count: 0,
            front_surface_candidate_count: 0,
            cluster_count: 0,
            skipped_reason: 'missing-click-depth'
        };
    }

    if (useSam) {
        const samDebug: Sam3MaskDebug = { attempts: [] };
        debug.sam3 = samDebug;
        const samRegion = await fetchSam3ClickMaskRegion(frame, splat, scene, clickX, clickY, samDebug);
        if (samRegion?.mask_bb2d) {
            for (const scale of [0.95, 1.15, 1.45]) {
                const bb = expandBb2d(samRegion.mask_bb2d, scale, frame.image_width, frame.image_height);
                if (!bb) continue;
                addUniqueProposal(proposals, {
                    id: `sam3-mask-${scale.toFixed(2)}`,
                    bb2d: bb,
                    score2d: Math.min(0.98, 0.72 + Math.log10(Math.max(10, samRegion.point_count)) * 0.06),
                    source: 'sam3-mask',
                    sam3Region: samRegion
                }, frame.image_width, frame.image_height);
            }
        }
    }

    const finalProposals = proposals.slice(0, 40);
    debug.final_count = finalProposals.length;
    debug.sources = finalProposals.reduce<Record<string, number>>((counts, proposal) => {
        counts[proposal.source] = (counts[proposal.source] ?? 0) + 1;
        return counts;
    }, {});
    return { proposals: finalProposals, debug };
};

const scoreDirectLiftCandidate = (
    obb: BoxerResponse,
    bb2d: NormalizedBb2d,
    frame: BoxerFramePayload,
    clickX?: number,
    clickY?: number,
    geometryRefinement?: GeometryRefinement,
    projectionFit?: DirectLiftProjectionFit | null,
    geometryFit?: DirectLiftGeometryFit | null,
    scaleEnsemble = false
) => {
    const area = (bb2d[2] - bb2d[0]) * (bb2d[3] - bb2d[1]);
    const areaRatio = area / Math.max(1, frame.image_width * frame.image_height);
    const confidence = obb.confidence ?? 0;
    const score2d = obb.score2d ?? 0;
    const pointScore = geometryRefinement?.point_count ?
        Math.min(1.2, Math.log10(Math.max(10, geometryRefinement.point_count)) * 0.25) :
        0;
    const projectionScore = geometryRefinement?.projection_fit?.best_score ?? projectionFit?.best_score ?? 0;
    const broadPenalty = isBroadSurfaceLabel(obb.label) ? 0.35 : 0;
    const areaPenalty = areaRatio > 0.18 ? areaRatio : areaRatio * 0.15;
    let clickScore = 0;
    if (clickX !== undefined && clickY !== undefined) {
        const [cx, cy] = bbCenter(bb2d);
        clickScore = (bbContainsPoint(bb2d, clickX, clickY) ? 0.75 : -0.5) -
            Math.hypot(cx - clickX, cy - clickY) / Math.max(frame.image_width, frame.image_height);
    }

    const projectionWeight = scaleEnsemble ? 0.95 : 0.35;
    const geometryWeight = scaleEnsemble ? 0.55 : 0.2;
    const geometryScore = geometryFit?.score ?? 0;
    return confidence * 0.55 + score2d * 0.45 + pointScore + projectionScore * projectionWeight + geometryScore * geometryWeight + clickScore - areaPenalty - broadPenalty;
};

class BoxerSelection {
    activate: () => void;
    deactivate: () => void;
    active = false;

    constructor(events: Events, scene: Scene, parent: HTMLElement) {
        const canvas = scene.canvas;
        let busy = false;
        let currentCorners: Vec3[] | null = null;
        let lastEvalPrompt: BoxerEvalPrompt | null = null;
        let lastBrushPrompt: Extract<BoxerEvalPrompt, { type: 'client_brush' | 'client_brush_floor_snap' | 'brush_sam' | 'brush_sam_clean' | 'brush_boxer' }> | null = null;
        let lastBrushReplay: unknown | null = null;
        let brushPanelStatus: 'idle' | 'running' | 'done' | 'failed' = 'idle';
        let lastEvalFrame: ReturnType<typeof summarizeFrameForEval> | null = null;
        let lastEvalCamera: CameraDebugState | null = null;
        let stickyEvalTarget: BoxerEvalTarget | null = null;
        let stickyEvalTargetLabel: string | null = null;
        let prewarmSerial = 0;
        let prewarmPromise: Promise<boolean> | null = null;

        const scheduleBoxerFramePrewarm = (reason: string) => {
            const serial = ++prewarmSerial;
            (window as any).__boxerPrewarmReady = false;
            prewarmPromise = new Promise<boolean>((resolve) => {
                window.setTimeout(() => {
                    (async () => {
                        if (serial !== prewarmSerial) {
                            resolve(false);
                            return;
                        }
                        const splat = (events.invoke('selection') as Splat | null) ??
                            ((events.invoke('scene.splats') as Splat[] | undefined)?.[0] ?? null);
                        if (!splat || canvas.clientWidth <= 0 || canvas.clientHeight <= 0) {
                            resolve(false);
                            return;
                        }
                        await waitForCollisionSurface();
                        if (serial !== prewarmSerial) {
                            resolve(false);
                            return;
                        }
                        const t0 = performance.now();
                        await buildBoxerFramePayload(events, scene, splat, canvas, {
                            includeImage: false,
                            includeEncodedDepth: false
                        });
                        if (serial !== prewarmSerial) {
                            resolve(false);
                            return;
                        }
                        (window as any).__boxerPrewarmReady = true;
                        console.log(`[Boxer] prewarmed frame/depth cache (${(performance.now() - t0).toFixed(0)}ms, ${reason})`);
                        resolve(true);
                    })().catch((err) => {
                        if (serial !== prewarmSerial) {
                            resolve(false);
                            return;
                        }
                        (window as any).__boxerPrewarmReady = false;
                        console.warn('[Boxer] frame/depth prewarm failed', err);
                        resolve(false);
                    });
                }, 250);
            });
            (window as any).__boxerPrewarmPromise = prewarmPromise;
        };

        (window as any).__boxerWaitForPrewarm = async () => (prewarmPromise ? await prewarmPromise : !!(window as any).__boxerPrewarmReady);

        events.on('scene.elementAdded', (element: unknown) => {
            if (element instanceof Splat) {
                scheduleBoxerFramePrewarm('splat-loaded');
            }
        });
        scheduleBoxerFramePrewarm('tool-ready');

        // SVG overlay for 2D evidence and final 3D projection sanity checks.
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.style.position = 'absolute';
        svg.style.top = '0';
        svg.style.left = '0';
        svg.style.width = '100%';
        svg.style.height = '100%';
        svg.style.pointerEvents = 'none';
        svg.style.display = 'none';
        svg.setAttribute('preserveAspectRatio', 'none');
        parent.appendChild(svg);

        let boxer2DOverlaysVisible = localStorage.getItem('boxer2DOverlaysVisible') === '1';
        let last2DBoxLayers: BoxerOverlayLayer[] = [];

        const clear2DBoxLayers = () => {
            while (svg.firstChild) svg.removeChild(svg.firstChild);
        };

        const update2DOverlayToggleButton = () => {
            const button = parent.querySelector<HTMLButtonElement>('[data-boxer-toggle-2d-overlays]');
            if (!button) return;
            button.textContent = boxer2DOverlaysVisible ? 'Hide 2D Boxes' : 'Show 2D Boxes';
        };

        const render2DBoxLayers = () => {
            clear2DBoxLayers();
            const visibleLayers = last2DBoxLayers.filter(layer => layer.bb2d || layer.points?.length);
            if (!boxer2DOverlaysVisible || visibleLayers.length === 0) {
                svg.style.display = 'none';
                return;
            }

            const rect = canvas.getBoundingClientRect();
            const parentRect = parent.getBoundingClientRect();
            const ox = rect.left - parentRect.left;
            const oy = rect.top - parentRect.top;
            svg.setAttribute('viewBox', `0 0 ${parent.clientWidth} ${parent.clientHeight}`);
            svg.style.display = '';

            for (const layer of visibleLayers) {
                if (layer.points?.length) {
                    const polyline = document.createElementNS(svg.namespaceURI, 'polyline') as SVGPolylineElement;
                    polyline.setAttribute('fill', 'none');
                    polyline.setAttribute('stroke', layer.color);
                    polyline.setAttribute('stroke-opacity', '0.35');
                    polyline.setAttribute('stroke-linecap', 'round');
                    polyline.setAttribute('stroke-linejoin', 'round');
                    polyline.setAttribute('stroke-width', String(layer.width ?? 2));
                    polyline.setAttribute('points', layer.points.map(point => `${ox + point[0]},${oy + point[1]}`).join(' '));
                    svg.appendChild(polyline);
                }
                if (!layer.bb2d) continue;
                const [x0, y0, x1, y1] = layer.bb2d;
                const svgRect = document.createElementNS(svg.namespaceURI, 'rect') as SVGRectElement;
                svgRect.setAttribute('fill', 'none');
                svgRect.setAttribute('stroke', layer.color);
                svgRect.setAttribute('stroke-width', String(layer.width ?? 2));
                if (layer.dash) svgRect.setAttribute('stroke-dasharray', layer.dash);
                svgRect.setAttribute('x', String(ox + x0));
                svgRect.setAttribute('y', String(oy + y0));
                svgRect.setAttribute('width', String(Math.max(1, x1 - x0)));
                svgRect.setAttribute('height', String(Math.max(1, y1 - y0)));
                svg.appendChild(svgRect);

                const svgText = document.createElementNS(svg.namespaceURI, 'text') as SVGTextElement;
                svgText.setAttribute('fill', layer.color);
                svgText.setAttribute('font-family', 'monospace');
                svgText.setAttribute('font-size', '12');
                svgText.setAttribute('x', String(ox + x0 + 4));
                svgText.setAttribute('y', String(oy + Math.max(14, y0 - 4)));
                svgText.textContent = layer.label;
                svg.appendChild(svgText);
            }
        };

        const show2DBoxLayers = (layers: BoxerOverlayLayer[]) => {
            last2DBoxLayers = layers;
            render2DBoxLayers();
        };

        const set2DBoxOverlaysVisible = (visible: boolean) => {
            boxer2DOverlaysVisible = visible;
            localStorage.setItem('boxer2DOverlaysVisible', visible ? '1' : '0');
            render2DBoxLayers();
            update2DOverlayToggleButton();
            return boxer2DOverlaysVisible;
        };

        const projectResultTo2D = (result: OBBResult, frame: BoxerFramePayload): NormalizedBb2d | null => {
            const projected = projectedCornersBb2d(result.corners, scene, frame.intrinsics);
            return projected ? sanitizeBb2d(projected, frame.image_width, frame.image_height) : null;
        };

        const show2DBox = (bb: NormalizedBb2d, label: string) => {
            show2DBoxLayers([{
                bb2d: bb,
                label,
                color: '#ff4fd8',
                dash: '6 4'
            }]);
        };
        const hide2DBox = () => {
            last2DBoxLayers = [];
            clear2DBoxLayers();
            svg.style.display = 'none';
        };
        const clearBoxerResultOverlay = () => {
            currentCorners = null;
            hide2DBox();
            events.fire('view.setSelectedSplatsOverlay', false);
            scene.forceRender = true;
        };
        const applyBoxerObbSelection = async (obb: OBBResult) => {
            const result = await events.invoke('select.byOBBNow', 'set', obb) as {
                splat_count: number;
                selected_before: number;
                selected_after: number;
            } | undefined;
            events.fire('view.setSelectedSplatsOverlay', true);
            scene.forceRender = true;
            return result ?? { splat_count: 0, selected_before: 0, selected_after: 0 };
        };
        try {
            // used by the eval case editor to declutter the viewport while
            // the user adjusts a target box
            events.function('boxer.clearOverlays', () => {
                clearBoxerResultOverlay();
            });
        } catch (err) {
            console.warn('[Boxer] boxer.clearOverlays was already registered', err);
        }
        const debugPanel = document.createElement('div');
        debugPanel.style.position = 'absolute';
        debugPanel.style.right = '12px';
        debugPanel.style.top = '12px';
        debugPanel.style.width = '320px';
        debugPanel.style.maxHeight = '58vh';
        debugPanel.style.overflow = 'auto';
        debugPanel.style.zIndex = '12';
        debugPanel.style.display = 'none';
        debugPanel.style.pointerEvents = 'auto';
        debugPanel.style.padding = '10px';
        debugPanel.style.borderRadius = '8px';
        debugPanel.style.background = 'rgba(12, 16, 22, 0.86)';
        debugPanel.style.color = '#e8f7ff';
        debugPanel.style.font = '11px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
        debugPanel.style.boxShadow = '0 10px 28px rgba(0, 0, 0, 0.28)';
        parent.appendChild(debugPanel);

        const brushPanel = document.createElement('div');
        brushPanel.style.position = 'fixed';
        brushPanel.style.right = '16px';
        brushPanel.style.top = '72px';
        brushPanel.style.width = '320px';
        brushPanel.style.zIndex = '10000';
        brushPanel.style.display = 'none';
        brushPanel.style.pointerEvents = 'auto';
        brushPanel.style.padding = '10px';
        brushPanel.style.borderRadius = '8px';
        brushPanel.style.background = 'rgba(12, 16, 22, 0.86)';
        brushPanel.style.color = '#e8f7ff';
        brushPanel.style.font = '11px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
        brushPanel.style.boxShadow = '0 10px 28px rgba(0, 0, 0, 0.28)';
        document.body.appendChild(brushPanel);

        const fmtMs = (value?: number) => {
            const numeric = value ?? NaN;
            return Number.isFinite(numeric) ? `${Math.round(numeric)}ms` : '-';
        };
        const fmtNum = (value?: number, digits = 2) => {
            const numeric = value ?? NaN;
            return Number.isFinite(numeric) ? numeric.toFixed(digits) : '-';
        };
        const debugButtonStyle = 'font:inherit;padding:4px 7px;border:1px solid rgba(255,255,255,.28);border-radius:4px;background:rgba(255,255,255,.12);color:inherit;';
        const liveBrushSupportViews: BrushSupportFusionView[] = [];
        const LIVE_FUSION_MIN_PROMOTION_ANGLE_DEGREES = 45;
        const LIVE_FUSION_READY_VIEW_GOAL = 3;
        const LIVE_FUSION_STRONG_VIEW_GOAL = 6;
        type LiveBrushFusionResultDebug = {
            applied: boolean;
            reason: string;
            view_count?: number;
            consistent_view_count?: number;
            support_view_max_angle_degrees?: number;
            support_view_avg_angle_degrees?: number;
            fusion_method?: string;
            consensus_overlap_ratio?: number;
            current_support_coverage?: number;
            reprojection_overlap?: ReturnType<typeof buildBb2dCoverageStats> | null;
        };
        let lastLiveBrushFusionResult: LiveBrushFusionResultDebug | null = null;
        const getLiveBrushFusionStatus = () => {
            const consistentViews = filterConsistentBrushSupportViews(liveBrushSupportViews);
            const angles = summarizeBrushSupportViewAngles(consistentViews);
            const last = lastLiveBrushFusionResult;
            const state = last?.applied ?
                'applied' :
                liveBrushSupportViews.length === 0 ?
                    'empty' :
                    consistentViews.length < 2 ?
                        'collecting' :
                        angles.max_degrees < LIVE_FUSION_MIN_PROMOTION_ANGLE_DEGREES ?
                            'needs-view-diversity' :
                            'ready';
            return {
                state,
                view_count: liveBrushSupportViews.length,
                consistent_view_count: consistentViews.length,
                max_angle_degrees: angles.max_degrees,
                avg_angle_degrees: angles.avg_degrees,
                min_promotion_angle_degrees: LIVE_FUSION_MIN_PROMOTION_ANGLE_DEGREES,
                ready_view_goal: LIVE_FUSION_READY_VIEW_GOAL,
                strong_view_goal: LIVE_FUSION_STRONG_VIEW_GOAL,
                can_promote_three_view: consistentViews.length >= LIVE_FUSION_READY_VIEW_GOAL &&
                    angles.max_degrees >= LIVE_FUSION_MIN_PROMOTION_ANGLE_DEGREES,
                can_promote_strong_view: consistentViews.length >= LIVE_FUSION_STRONG_VIEW_GOAL &&
                    angles.max_degrees >= LIVE_FUSION_MIN_PROMOTION_ANGLE_DEGREES,
                last_result: last ? {
                    applied: last.applied,
                    reason: last.reason,
                    view_count: last.view_count,
                    consistent_view_count: last.consistent_view_count,
                    max_angle_degrees: last.support_view_max_angle_degrees,
                    avg_angle_degrees: last.support_view_avg_angle_degrees,
                    fusion_method: last.fusion_method,
                    consensus_overlap_ratio: last.consensus_overlap_ratio,
                    current_support_coverage: last.current_support_coverage,
                    reprojection_iou: last.reprojection_overlap?.iou
                } : null
            };
        };
        const publishLiveBrushFusionStatus = () => {
            const status = getLiveBrushFusionStatus();
            (window as any).__lastBoxerLiveBrushFusionStatus = status;
            events.fire('boxer.liveBrushFusionUpdated', status);
            return status;
        };
        const fusionStatusRows = () => {
            const status = getLiveBrushFusionStatus();
            if (status.state === 'empty') return '';
            const angle = fmtNum(status.max_angle_degrees, 1);
            const coverage = fmtNum(status.last_result?.current_support_coverage, 2);
            const reprojection = fmtNum(status.last_result?.reprojection_iou, 2);
            const stateLabel = status.state === 'needs-view-diversity' ?
                'needs angle' :
                status.state;
            return `
                <div style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,.16);">
                    <div>fusion ${stateLabel} · ${status.consistent_view_count}/${status.view_count} views · ${angle}deg</div>
                    <div>current ${coverage} · reproj ${reprojection}</div>
                    ${status.last_result?.reason ? `<div>${status.last_result.reason}</div>` : ''}
                    <button type="button" data-boxer-clear-fusion style="${debugButtonStyle}margin-top:6px;background:rgba(255,255,255,.08);">Clear Fusion</button>
                </div>
            `;
        };
        const bindFusionClearButton = () => {
            brushPanel.querySelector<HTMLButtonElement>('[data-boxer-clear-fusion]')?.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
                events.invoke('boxer.clearLiveBrushFusion');
            });
        };
        const renderBrushPanel = () => {
            if (!lastBrushPrompt) {
                if (!stickyEvalTarget) {
                    brushPanel.style.display = 'none';
                    return;
                }

                brushPanel.innerHTML = `
                    <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:6px;">
                        <strong style="font-size:12px;">Boxer Brush Test</strong>
                        <span>target saved</span>
                    </div>
                    <div>Switch to a brush selection tool, then paint the object.</div>
                    <div style="margin-top:6px;">After you release the stroke, this panel will show Run Brush and Save Brush Eval.</div>
                `;
                brushPanel.style.display = '';
                return;
            }

            const pointCount = lastBrushPrompt.brush?.points?.length ?? 0;
            const radius = lastBrushPrompt.brush?.radius;
            const [x0, y0, x1, y1] = lastBrushPrompt.brush?.bb2d ?? [0, 0, 0, 0];
            const statusText = brushPanelStatus === 'running' ?
                'Running...' :
                (brushPanelStatus === 'done' ? 'Ready to save' : (brushPanelStatus === 'failed' ? 'Run failed' : 'Ready'));
            const fusionText = liveBrushSupportViews.length ?
                `<div>fusion memory ${liveBrushSupportViews.length} view${liveBrushSupportViews.length === 1 ? '' : 's'}</div>` :
                '';
            brushPanel.innerHTML = `
                <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:6px;">
                    <strong style="font-size:12px;">${lastBrushPrompt.type === 'brush_sam' || lastBrushPrompt.type === 'brush_sam_clean' ? 'SAM Brush Test' : 'Boxer Brush Test'}</strong>
                    <span>${statusText}</span>
                </div>
                <div>stroke radius ${fmtNum(radius, 1)} · box ${Math.round(x1 - x0)}x${Math.round(y1 - y0)}</div>
                <div>${pointCount} pts</div>
                ${fusionText}
                ${fusionStatusRows()}
                <div style="display:flex;gap:6px;margin-top:8px;">
                    <button type="button" data-boxer-run-brush style="${debugButtonStyle}">Run Brush</button>
                    <button type="button" data-boxer-copy-brush style="${debugButtonStyle}">Save Brush Eval</button>
                </div>
            `;
            brushPanel.querySelector<HTMLButtonElement>('[data-boxer-run-brush]')?.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
                events.invoke('boxer.runLastBrush');
            });
            brushPanel.querySelector<HTMLButtonElement>('[data-boxer-copy-brush]')?.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
                events.invoke('boxer.copyLastBrushEvalCase', { copy_clipboard: false, save_local: true });
            });
            bindFusionClearButton();
            brushPanel.style.display = '';
        };
        const updateDebugPanel = (state: BoxerClickDebugPanelState) => {
            (window as any).__lastBoxerClickDebug = state;
            const scaleRows = (state.scale_runs ?? [])
            .map(run => `<div>scale ${fmtNum(run.scale, 3)} · ${fmtMs(run.ms)} · ${run.detections} det</div>`)
            .join('');
            const candidateRows = (state.candidates ?? []).slice(0, 8)
            .map((candidate, index) => (
                `<div>${index + 1}. ${candidate.label ?? candidate.source ?? 'candidate'} ` +
                `s=${candidate.scale !== undefined ? fmtNum(candidate.scale, 3) : '-'} ` +
                `score=${fmtNum(candidate.score, 3)} conf=${fmtNum(candidate.confidence, 2)}</div>`
            ))
            .join('');
            const rayStats = state.ray_depth_stats ?
                `rays ${state.ray_sample_count ?? 0} · depth ${fmtNum(state.ray_depth_stats.median)} ` +
                `spread ${fmtNum(state.ray_depth_stats.spread)}` :
                `rays ${state.ray_sample_count ?? 0}`;
            debugPanel.innerHTML = `
                <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:6px;">
                    <strong style="font-size:12px;">Boxer ${state.mode}</strong>
                    <span>${fmtMs(state.total_ms)}</span>
                </div>
                ${state.image ? `<img alt="Boxer input" src="data:image/png;base64,${state.image}" style="width:100%;border-radius:6px;display:block;margin-bottom:8px;" />` : ''}
                <div>${state.label ?? 'no label'} · conf ${fmtNum(state.confidence, 2)}</div>
                <div>${state.image_width ?? '-'}x${state.image_height ?? '-'} · ${state.depth_source ?? 'depth?'}</div>
                <div>2D boxes ${boxer2DOverlaysVisible ? 'visible' : 'hidden'} · orange=final · pink/blue=evidence</div>
                <div>frame ${fmtMs(state.frame_ms)} · backend ${fmtMs(state.backend_ms)} · refine ${fmtMs(state.refine_ms)} · draw ${fmtMs(state.draw_ms)}</div>
                <div>${state.endpoint ?? ''}</div>
                <div>proposals ${state.proposal_count ?? '-'} · candidates ${state.candidate_count ?? '-'} · selected splats ${state.selected_splat_count ?? '-'}</div>
                <div>${rayStats}</div>
                <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">
                    <button type="button" data-boxer-toggle-2d-overlays style="${debugButtonStyle}">${boxer2DOverlaysVisible ? 'Hide 2D Boxes' : 'Show 2D Boxes'}</button>
                    <button type="button" data-boxer-copy-eval style="${debugButtonStyle}">Copy Eval</button>
                    <button type="button" data-boxer-clear-target style="${debugButtonStyle}background:rgba(255,255,255,.08);">Clear Target</button>
                </div>
                ${scaleRows ? `<hr style="border:0;border-top:1px solid rgba(255,255,255,.18);margin:8px 0;" />${scaleRows}` : ''}
                ${candidateRows ? `<hr style="border:0;border-top:1px solid rgba(255,255,255,.18);margin:8px 0;" />${candidateRows}` : ''}
            `;
            debugPanel.querySelector<HTMLButtonElement>('[data-boxer-toggle-2d-overlays]')?.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
                set2DBoxOverlaysVisible(!boxer2DOverlaysVisible);
            });
            debugPanel.querySelector<HTMLButtonElement>('[data-boxer-copy-eval]')?.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
                events.invoke('boxer.copyClickTestCase');
            });
            debugPanel.querySelector<HTMLButtonElement>('[data-boxer-clear-target]')?.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
                events.invoke('boxer.clearEvalTarget');
            });
            debugPanel.style.display = '';
            events.fire('boxer.debugUpdated', state);
        };
        try {
            events.function('boxer.2dOverlays.visible', () => boxer2DOverlaysVisible);
            events.function('boxer.2dOverlays.setVisible', (visible: boolean) => set2DBoxOverlaysVisible(visible === true));
            events.function('boxer.2dOverlays.toggleVisible', () => set2DBoxOverlaysVisible(!boxer2DOverlaysVisible));
            events.function('boxer.debugPanel.toggleVisible', () => {
                debugPanel.style.display = debugPanel.style.display === 'none' ? '' : 'none';
                return debugPanel.style.display !== 'none';
            });
        } catch (err) {
            console.warn('[Boxer] boxer.debugPanel.toggleVisible was already registered', err);
        }
        const buildWireframeCorners = (obb: OBBResult) => (
            cornersFromCenterDimensions(obb.center, obb.dimensions, obb.rotation)
            .map(corner => new Vec3(corner[0], corner[1], corner[2]))
        );

        try {
            events.function('boxer.captureFrame', async () => {
                const splat = events.invoke('selection') as Splat;
                if (!splat) {
                    console.warn('[Boxer] captureFrame requested with no splat selected');
                    return null;
                }
                const { frame } = await buildBoxerFramePayload(events, scene, splat, canvas);
                publishBoxerFrameDebug(frame);
                return compactBoxerFramePayload(frame);
            });
        } catch (err) {
            console.warn('[Boxer] boxer.captureFrame was already registered', err);
        }

        try {
            events.function('boxer.captureSam3MaskRegion', async (prompt?: { click_xy?: [number, number] }) => {
                const splat = events.invoke('selection') as Splat;
                if (!splat) {
                    console.warn('[Boxer] SAM3 mask region requested with no splat selected');
                    return null;
                }
                const click = prompt?.click_xy;
                if (!click) {
                    throw new Error('boxer.captureSam3MaskRegion requires click_xy');
                }

                const { frame } = await buildBoxerFramePayload(events, scene, splat, canvas);
                const region = await fetchSam3ClickMaskRegion(frame, splat, scene, click[0], click[1]);
                if (!region) return null;
                return {
                    mask_bb2d: region.mask_bb2d,
                    point_count: region.point_count,
                    projected_candidate_count: region.projected_candidate_count,
                    front_surface_candidate_count: region.front_surface_candidate_count,
                    mask_area_ratio: region.mask_area_ratio
                };
            });
        } catch (err) {
            console.warn('[Boxer] boxer.captureSam3MaskRegion was already registered', err);
        }

        const executeDetectAll = async (click?: { x: number; y: number; target?: BoxerEvalTarget | null }) => {
            const splat = (events.invoke('selection') as Splat | null) ??
                ((events.invoke('scene.splats') as Splat[] | undefined)?.[0] ?? null);
            if (!splat) {
                throw new Error('No splat loaded');
            }

            const { frame, depthBuffer } = await buildBoxerFramePayload(events, scene, splat, canvas, {
                includeImage: false,
                includeEncodedDepth: false
            });
            publishBoxerFrameDebug(frame);
            lastEvalPrompt = click ? { type: 'detect_all_click', click_xy: [click.x, click.y] } : { type: 'text', text: 'detect_all' };
            lastEvalFrame = summarizeFrameForEval(frame);
            lastEvalCamera = events.invoke('camera.debugState') as CameraDebugState;

            const boxerBackendUrl = getBoxerBackendUrl();
            const attempts = await postBoxerDetectAll(boxerBackendUrl, frame);
            const success = attempts.find(attempt => attempt.ok && attempt.detections.length > 0);
            const detections = success?.detections ?? [];
            const compactAttempts = attempts.map(attempt => ({
                label: attempt.label,
                status: attempt.status,
                ok: attempt.ok,
                detection_count: attempt.detections.length,
                error: attempt.error,
                body_summary: typeof attempt.body === 'object' && attempt.body !== null ? {
                    keys: Object.keys(attempt.body),
                    label: (attempt.body as Partial<OBBResult>).label,
                    confidence: (attempt.body as Partial<OBBResult>).confidence,
                    candidates: Array.isArray((attempt.body as BoxerDetectAllResponse).candidates) ?
                        (attempt.body as BoxerDetectAllResponse).candidates?.length :
                        undefined,
                    detections: Array.isArray((attempt.body as BoxerDetectAllResponse).detections) ?
                        (attempt.body as BoxerDetectAllResponse).detections?.length :
                        undefined,
                    detail: summarizeFastApiDetail((attempt.body as { detail?: unknown }).detail)
                } : String(attempt.body).slice(0, 180)
            }));

            const result = {
                schema: 'boxer-detect-all-probe/v1',
                backend_url: boxerBackendUrl,
                camera: lastEvalCamera,
                frame: lastEvalFrame,
                attempts: compactAttempts,
                detections: detections.map(detection => ({
                    raw: detection,
                    normalized_bb2d: normalizeBb2d(detection, frame.image_width, frame.image_height)
                })),
                top_detection: null as unknown
            };
            (window as any).__lastBoxerDetectAllResult = result;
            console.log('[Boxer] detect-all probe', result);

            if (detections.length > 0) {
                const clickChoice = click ? chooseDetectionForClick(detections, frame, click.x, click.y) : null;
                const top = clickChoice?.detection ?? detections[0];
                const rawTop = cloneObb(top);
                const topBb = clickChoice?.bb2d ?? normalizeBb2d(top, frame.image_width, frame.image_height);
                if (topBb) show2DBox(topBb, `${top.label} ${(top.confidence * 100).toFixed(0)}%`);
                const geometryRefinement = refineObbFromBoxedPoints(
                    top,
                    frame,
                    splat,
                    scene,
                    topBb,
                    click ? { click_xy: [click.x, click.y], depthBuffer } : undefined
                );
                if (geometryRefinement.applied && geometryRefinement.dimensions) {
                    console.log(
                        `[Boxer] detect-all top geometry refined from ${geometryRefinement.point_count} splat points` +
                        ` dims=${geometryRefinement.dimensions.map(d => d.toFixed(2)).join(',')}`
                    );
                }
                result.top_detection = {
                    raw: rawTop,
                    refined: top,
                    normalized_bb2d: topBb,
                    click_selection_score: clickChoice?.score,
                    geometry_refinement: geometryRefinement
                };
                currentCorners = buildWireframeCorners(top);
                scene.forceRender = true;
            }

            return result;
        };

        const executeDirectLift = async (
            proposals: DirectLiftProposal[],
            prompt: BoxerEvalPrompt,
            target?: BoxerEvalTarget | null,
            focusClick?: { x: number; y: number },
            preprocessMode: 'full_frame' | 'square_crop' = 'full_frame',
            proposalGeneration?: DirectLiftProposalBuild['debug'],
            depthMode = 'dense',
            geometryMode: 'global' | 'proposal_local' = 'global',
            boxernetWorldScale?: number,
            refinementMode: 'auto' | 'raw' | 'ray' = 'auto',
            gravityOverride?: [number, number, number],
            objectCropOptions?: ObjectCropOptions
        ) => {
            const t0 = performance.now();
            const splat = (events.invoke('selection') as Splat | null) ??
                ((events.invoke('scene.splats') as Splat[] | undefined)?.[0] ?? null);
            if (!splat) {
                throw new Error('No splat loaded');
            }
            if (proposals.length === 0) {
                throw new Error('Direct Boxer lift has no 2D proposals');
            }

            const framePayload = await buildBoxerFramePayload(events, scene, splat, canvas);
            let frame = framePayload.frame;
            const depthBuffer = framePayload.depthBuffer;
            const tFrame = performance.now();
            if (gravityOverride) {
                frame = {
                    ...frame,
                    gravity: gravityOverride
                };
            }
            let proposalLocalGeometry: ReturnType<typeof buildProposalLocalPointCloud> | null = null;
            if (geometryMode === 'proposal_local') {
                proposalLocalGeometry = buildProposalLocalPointCloud(proposals, frame, splat, scene);
                if (proposalLocalGeometry.points.length >= 24) {
                    frame = {
                        ...frame,
                        point_cloud: proposalLocalGeometry.points,
                        point_cloud_source: 'proposal_local_front_surface',
                        sdp_points: proposalLocalGeometry.points,
                        sdp_point_count: proposalLocalGeometry.points.length,
                        projection_samples: buildProjectionSamples(proposalLocalGeometry.points, scene, frame.intrinsics)
                    };
                }
            }
            publishBoxerFrameDebug(frame);
            lastEvalPrompt = prompt;
            lastEvalFrame = summarizeFrameForEval(frame);
            lastEvalCamera = events.invoke('camera.debugState') as CameraDebugState;

            const boxerBackendUrl = getBoxerBackendUrl();
            const objectCrop = await buildObjectCropDirectLiftRequest(frame, proposals, objectCropOptions);
            const requestFrame = objectCrop?.frame ?? frame;
            const requestProposals = objectCrop?.proposals ?? proposals;
            const requestPreprocessMode = objectCrop ? 'full_frame' : preprocessMode;
            const requestDepthMode = objectCrop ? 'points_only' : depthMode;
            const promptScales = 'boxernet_world_scales' in prompt && Array.isArray(prompt.boxernet_world_scales) ?
                prompt.boxernet_world_scales :
                [];
            const scaleValues = Array.from(new Set(
                (promptScales.length ? promptScales : [boxernetWorldScale])
                .map(scale => (typeof scale === 'number' && Number.isFinite(scale) ? scale : undefined))
                .filter((scale): scale is number => scale !== undefined)
            ));
            if (scaleValues.length === 0) scaleValues.push(boxernetWorldScale ?? 1);
            const scaleEnsemble = scaleValues.length > 1;
            const directRuns = await Promise.all(scaleValues.map(async (scale) => {
                const tScale = performance.now();
                const direct = await postBoxerDirectLift(
                    boxerBackendUrl,
                    requestFrame,
                    requestProposals,
                    requestPreprocessMode,
                    requestDepthMode,
                    scale
                );
                return {
                    scale,
                    ms: performance.now() - tScale,
                    data: direct.data,
                    detections: direct.detections
                };
            }));
            const tBackend = performance.now();
            const proposalById = new Map(proposals.map(proposal => [proposal.id, proposal]));
            const proposalGeometryById = new Map(
                (proposalLocalGeometry?.summaries ?? [])
                .map(summary => [summary.id, summary.point_summary] as const)
            );
            const targetProjectedBb2d = projectedTargetBb2d(target, scene, frame.intrinsics);
            const candidates = directRuns.flatMap((run, runIndex) => run.detections.map((detection, index) => {
                const raw = cloneObb(detection);
                const proposal = proposalById.get(detection.label) ?? proposals[index] ?? null;
                const bb2d = proposal?.bb2d ??
                    normalizeBb2d(detection, frame.image_width, frame.image_height, focusClick?.x, focusClick?.y);
                let geometryRefinement: GeometryRefinement;
                if (refinementMode === 'raw') {
                    geometryRefinement = { applied: false, reason: 'refinement-disabled' };
                } else if (refinementMode === 'ray' && bb2d) {
                    geometryRefinement = applyRayDimensionPrior(detection, bb2d, scene, frame, depthBuffer, focusClick);
                } else {
                    geometryRefinement = refineObbFromBoxedPoints(
                        detection,
                        frame,
                        splat,
                        scene,
                        bb2d,
                        focusClick ? { click_xy: [focusClick.x, focusClick.y], depthBuffer } : undefined,
                        proposal?.sam3Region
                    );
                }
                const rawProjectionFit = bb2d ?
                    scoreDimensionProjectionFit(detection.center, detection.rotation, detection.dimensions, scene, frame, bb2d) :
                    null;
                const geometryFit = proposal ?
                    scoreGeometryAabbFit(detection, proposalGeometryById.get(proposal.id)) :
                    null;
                return {
                    index,
                    proposal,
                    raw,
                    refined: detection,
                    boxernet_world_scale: run.scale,
                    scale_run_index: runIndex,
                    normalized_bb2d: bb2d,
                    raw_projection_fit: rawProjectionFit,
                    geometry_fit: geometryFit,
                    geometry_refinement: geometryRefinement,
                    selection_score: bb2d ?
                        scoreDirectLiftCandidate(detection, bb2d, frame, focusClick?.x, focusClick?.y, geometryRefinement, rawProjectionFit, geometryFit, scaleEnsemble) :
                        Number.NEGATIVE_INFINITY,
                    bb2d_target_metrics: buildBb2dTargetMetrics(bb2d, targetProjectedBb2d),
                    metrics: buildEvalMetrics(detection, target),
                    raw_metrics: buildEvalMetrics(raw, target)
                };
            })).filter(candidate => !!candidate.normalized_bb2d)
            .sort((a, b) => b.selection_score - a.selection_score);

            if (candidates.length === 0) {
                throw new Error('Direct Boxer lift returned no usable detections');
            }

            const top = candidates[0];
            const oracle = target ?
                [...candidates].sort((a, b) => (b.metrics?.aabb_iou ?? 0) - (a.metrics?.aabb_iou ?? 0))[0] :
                null;
            const topObb = top.refined;

            publishBoxerResultDebug(
                topObb,
                top.raw,
                top.normalized_bb2d,
                { applied: false, reason: 'direct-lift-no-recenter' },
                top.geometry_refinement
            );
            const debugResult = (window as any).__lastBoxerResult;
            debugResult.direct_lift = {
                preprocess_mode: preprocessMode,
                depth_mode: depthMode,
                request_preprocess_mode: requestPreprocessMode,
                request_depth_mode: requestDepthMode,
                geometry_mode: geometryMode,
                boxernet_world_scale: boxernetWorldScale ?? 1,
                boxernet_world_scales: scaleValues,
                scale_ensemble: scaleEnsemble,
                refinement_mode: refinementMode,
                gravity: frame.gravity,
                object_crop: objectCrop?.crop ?? null,
                proposal_local_geometry: proposalLocalGeometry ? {
                    point_count: proposalLocalGeometry.points.length,
                    proposals: proposalLocalGeometry.summaries
                } : null,
                proposal_count: proposals.length,
                proposal_generation: proposalGeneration,
                target_projected_bb2d: targetProjectedBb2d,
                candidates: candidates.map(candidate => ({
                    index: candidate.index,
                    proposal: candidate.proposal ? {
                        id: candidate.proposal.id,
                        bb2d: candidate.proposal.bb2d,
                        score2d: candidate.proposal.score2d,
                        source: candidate.proposal.source,
                        sam3_region: candidate.proposal.sam3Region ? {
                            mask_bb2d: candidate.proposal.sam3Region.mask_bb2d,
                            point_count: candidate.proposal.sam3Region.point_count,
                            projected_candidate_count: candidate.proposal.sam3Region.projected_candidate_count,
                            front_surface_candidate_count: candidate.proposal.sam3Region.front_surface_candidate_count,
                            mask_area_ratio: candidate.proposal.sam3Region.mask_area_ratio
                        } : undefined
                    } : null,
                    label: candidate.refined.label,
                    confidence: candidate.refined.confidence,
                    score2d: candidate.refined.score2d,
                    boxernet_world_scale: candidate.boxernet_world_scale,
                    selection_score: candidate.selection_score,
                    normalized_bb2d: candidate.normalized_bb2d,
                    bb2d_target_metrics: candidate.bb2d_target_metrics,
                    raw_projection_fit: candidate.raw_projection_fit,
                    geometry_fit: candidate.geometry_fit,
                    geometry_refinement: candidate.geometry_refinement,
                    metrics: candidate.metrics,
                    raw_metrics: candidate.raw_metrics
                })),
                oracle_best: oracle ? {
                    index: oracle.index,
                    proposal: oracle.proposal,
                    boxernet_world_scale: oracle.boxernet_world_scale,
                    selection_score: oracle.selection_score,
                    metrics: oracle.metrics
                } : null,
                raw_response: directRuns.length === 1 ? directRuns[0].data : {
                    scale_runs: directRuns.map(run => ({
                        scale: run.scale,
                        data: run.data
                    }))
                }
            };

            currentCorners = buildWireframeCorners(topObb);
            const selectionTruth = await applyBoxerObbSelection(topObb);
            debugResult.selection_truth = selectionTruth;
            const finalProjectedBb2d = projectResultTo2D(topObb, frame);
            const overlayLayers: BoxerOverlayLayer[] = [];
            if (finalProjectedBb2d) {
                overlayLayers.push({
                    bb2d: finalProjectedBb2d,
                    label: `final ${topObb.label}`,
                    color: '#ff9f1a',
                    width: 3
                });
            }
            if (top.normalized_bb2d) {
                overlayLayers.push({
                    bb2d: top.normalized_bb2d,
                    label: `2d ${top.proposal?.id ?? topObb.label}`,
                    color: '#ff4fd8',
                    dash: '5 5',
                    width: 2
                });
            }
            show2DBoxLayers(overlayLayers);
            const tDone = performance.now();
            updateDebugPanel({
                mode: scaleEnsemble ? 'direct 5-scale' : 'direct',
                endpoint: `${boxerBackendUrl}/api/boxer-lift-bb2d`,
                label: topObb.label,
                confidence: topObb.confidence,
                total_ms: tDone - t0,
                frame_ms: tFrame - t0,
                backend_ms: tBackend - tFrame,
                refine_ms: tDone - tBackend,
                draw_ms: 0,
                image: frame.image,
                image_width: frame.image_width,
                image_height: frame.image_height,
                depth_source: frame.depth_source,
                bb2d: top.normalized_bb2d,
                selected_splat_count: selectionTruth.selected_after,
                scale_runs: directRuns.map(run => ({
                    scale: run.scale,
                    ms: run.ms,
                    detections: run.detections.length
                })),
                candidate_count: candidates.length,
                proposal_count: proposals.length,
                ray_sample_count: top.geometry_refinement.ray_sample_count,
                ray_depth_stats: top.geometry_refinement.ray_depth_stats,
                candidates: candidates.slice(0, 8).map(candidate => ({
                    label: candidate.refined.label,
                    scale: candidate.boxernet_world_scale,
                    score: candidate.selection_score,
                    confidence: candidate.refined.confidence,
                    source: candidate.proposal?.source,
                    bb2d: candidate.normalized_bb2d
                }))
            });

            return {
                camera: lastEvalCamera,
                frame: lastEvalFrame,
                raw_boxer_result: top.raw,
                boxer_result: debugResult,
                target: target ?? null,
                raw_metrics: buildEvalMetrics(top.raw, target),
                metrics: buildEvalMetrics(topObb, target),
                direct_lift_probe: debugResult.direct_lift
            };
        };

        const executeClientTargetLift = async (
            target: BoxerEvalTarget,
            prompt: Extract<BoxerEvalPrompt, { type: 'client_lift_target_box' }>
        ) => {
            const splat = (events.invoke('selection') as Splat | null) ??
                ((events.invoke('scene.splats') as Splat[] | undefined)?.[0] ?? null);
            if (!splat) {
                throw new Error('No splat loaded');
            }

            const { frame, depthBuffer } = await buildBoxerFramePayload(events, scene, splat, canvas, {
                includeImage: false,
                includeEncodedDepth: false
            });
            publishBoxerFrameDebug(frame);
            lastEvalPrompt = prompt;
            lastEvalFrame = summarizeFrameForEval(frame);
            lastEvalCamera = events.invoke('camera.debugState') as CameraDebugState;

            const targetProjectedBb2d = projectedTargetBb2d(target, scene, frame.intrinsics);
            const bb2d = targetProjectedBb2d ? sanitizeBb2d(targetProjectedBb2d, frame.image_width, frame.image_height) : null;
            if (!bb2d) {
                throw new Error('client_lift_target_box target does not project into the current view');
            }

            const seed = buildClientLiftSeedObb(frame, splat, scene, bb2d);
            const obb = seed.obb;
            const focusClick = prompt.click_xy ? { x: prompt.click_xy[0], y: prompt.click_xy[1] } : null;
            const geometryRefinement = refineObbFromBoxedPoints(
                obb,
                frame,
                splat,
                scene,
                bb2d,
                focusClick ? { click_xy: [focusClick.x, focusClick.y], depthBuffer } : undefined
            );
            if (geometryRefinement.applied && geometryRefinement.dimensions) {
                console.log(
                    `[Boxer] client target lift refined from ${geometryRefinement.point_count} splat points` +
                    ` dims=${geometryRefinement.dimensions.map(d => d.toFixed(2)).join(',')}`
                );
            }

            show2DBox(bb2d, 'client target 100%');
            publishBoxerResultDebug(
                obb,
                null,
                bb2d,
                { applied: false, reason: 'client-lift-no-recenter' },
                geometryRefinement
            );
            const debugResult = (window as any).__lastBoxerResult;
            debugResult.target_projected_bb2d = targetProjectedBb2d;
            debugResult.bb2d_target_metrics = buildBb2dTargetMetrics(bb2d, targetProjectedBb2d);
            debugResult.client_lift = {
                mode: 'client_lift_target_box',
                backend_bypassed: true,
                seed: seed.debug,
                target_projected_bb2d: targetProjectedBb2d
            };

            currentCorners = buildWireframeCorners(obb);
            const selectionTruth = await applyBoxerObbSelection(obb);
            debugResult.selection_truth = selectionTruth;

            return {
                camera: lastEvalCamera,
                frame: lastEvalFrame,
                raw_boxer_result: null as OBBResult | null,
                boxer_result: debugResult,
                target,
                raw_metrics: null as ReturnType<typeof buildEvalMetrics>,
                metrics: buildEvalMetrics(obb, target),
                client_lift_probe: debugResult.client_lift
            };
        };

        const executeClientClick = async (
            clickX: number,
            clickY: number,
            target?: BoxerEvalTarget | null
        ) => {
            const t0 = performance.now();
            const splat = (events.invoke('selection') as Splat | null) ??
                ((events.invoke('scene.splats') as Splat[] | undefined)?.[0] ?? null);
            if (!splat) {
                throw new Error('No splat loaded');
            }

            const { frame, depthBuffer } = await buildBoxerFramePayload(events, scene, splat, canvas, {
                includeImage: false,
                includeEncodedDepth: false
            });
            const tFrame = performance.now();
            publishBoxerFrameDebug(frame);
            lastEvalPrompt = { type: 'client_click', click_xy: [clickX, clickY] };
            lastEvalFrame = summarizeFrameForEval(frame);
            lastEvalCamera = events.invoke('camera.debugState') as CameraDebugState;

            const local = buildClientClickObb(frame, splat, scene, depthBuffer, clickX, clickY);
            const obb = local.obb;
            const rawObb = cloneObb(obb);
            const geometryRefinement = refineObbFromBoxedPoints(
                obb,
                frame,
                splat,
                scene,
                local.bb2d,
                { click_xy: [clickX, clickY], depthBuffer }
            );
            const shouldKeepRawClientObb = false;
            const refinedObb = cloneObb(obb);
            const visiblePrior = applyClientVisibleSurfacePrior(refinedObb, rawObb);
            Object.assign(obb, visiblePrior.obb);
            const tRefine = performance.now();

            publishBoxerResultDebug(
                obb,
                rawObb,
                local.bb2d,
                { applied: false, reason: 'client-click-no-recenter' },
                geometryRefinement
            );
            const debugResult = (window as any).__lastBoxerResult;
            const targetProjectedBb2d = projectedTargetBb2d(target, scene, frame.intrinsics);
            debugResult.target_projected_bb2d = targetProjectedBb2d;
            debugResult.bb2d_target_metrics = buildBb2dTargetMetrics(local.bb2d, targetProjectedBb2d);
            debugResult.client_click = {
                backend_bypassed: true,
                target_projected_bb2d: targetProjectedBb2d,
                visible_surface_prior: {
                    applied: visiblePrior.applied,
                    factors: visiblePrior.factors,
                    input_dimensions: refinedObb.dimensions,
                    output_dimensions: obb.dimensions
                },
                refinement_reverted_to_raw: shouldKeepRawClientObb,
                ...local.debug
            };

            currentCorners = buildWireframeCorners(obb);
            const selectionTruth = await applyBoxerObbSelection(obb);
            debugResult.selection_truth = selectionTruth;
            const finalProjectedBb2d = projectResultTo2D(obb, frame);
            const overlayLayers: BoxerOverlayLayer[] = [];
            if (finalProjectedBb2d) {
                overlayLayers.push({
                    bb2d: finalProjectedBb2d,
                    label: `final ${obb.label}`,
                    color: '#ff9f1a',
                    width: 3
                });
            }
            overlayLayers.push({
                bb2d: local.bb2d,
                label: 'client click 2d',
                color: '#ff4fd8',
                dash: '5 5',
                width: 2
            });
            show2DBoxLayers(overlayLayers);
            const tDone = performance.now();
            updateDebugPanel({
                mode: 'client click',
                endpoint: 'local geometry',
                label: obb.label,
                confidence: obb.confidence,
                total_ms: tDone - t0,
                frame_ms: tFrame - t0,
                backend_ms: 0,
                refine_ms: tDone - tFrame,
                draw_ms: tDone - tRefine,
                image: frame.image,
                image_width: frame.image_width,
                image_height: frame.image_height,
                depth_source: frame.depth_source,
                bb2d: local.bb2d,
                selected_splat_count: selectionTruth.selected_after,
                candidate_count: local.debug.candidates.length,
                proposal_count: 1,
                ray_sample_count: geometryRefinement.ray_sample_count,
                ray_depth_stats: geometryRefinement.ray_depth_stats,
                candidates: local.debug.candidates.slice(0, 8).map(candidate => ({
                    label: 'local',
                    score: candidate.selection_score,
                    confidence: 1,
                    source: 'client_click',
                    bb2d: candidate.bb2d
                }))
            });

            return {
                camera: lastEvalCamera,
                frame: lastEvalFrame,
                raw_boxer_result: rawObb,
                boxer_result: debugResult,
                target: target ?? null,
                raw_metrics: buildEvalMetrics(rawObb, target),
                metrics: buildEvalMetrics(obb, target),
                client_click_probe: debugResult.client_click
            };
        };

        const executeClientBrush = async (
            brush: BoxerBrushPrompt | undefined,
            click: [number, number] | undefined,
            target?: BoxerEvalTarget | null,
            options?: { useSam?: boolean; samClean?: boolean; floorSnap?: boolean; liveFusion?: boolean }
        ) => {
            const t0 = performance.now();
            const splat = (events.invoke('selection') as Splat | null) ??
                ((events.invoke('scene.splats') as Splat[] | undefined)?.[0] ?? null);
            if (!splat) {
                throw new Error('No splat loaded');
            }
            if (options?.useSam || options?.samClean) {
                clearBoxerResultOverlay();
                events.fire('select.none');
            }

            // make sure any in-flight collision surface sidecar load has settled
            // so live runs and replay both see the same brush_surface evidence
            await waitForCollisionSurface();
            const estimateBrushAreaRatio = () => {
                const bounds = brush?.bb2d ?? (brush?.points?.length ? (() => {
                    const radius = brush.radius ?? 8;
                    return brush.points.reduce((acc, point) => {
                        acc[0] = Math.min(acc[0], point[0] - radius);
                        acc[1] = Math.min(acc[1], point[1] - radius);
                        acc[2] = Math.max(acc[2], point[0] + radius);
                        acc[3] = Math.max(acc[3], point[1] + radius);
                        return acc;
                    }, [Infinity, Infinity, -Infinity, -Infinity] as NormalizedBb2d);
                })() : null);
                if (!bounds) return 0;
                return Math.max(0, bounds[2] - bounds[0]) *
                    Math.max(0, bounds[3] - bounds[1]) /
                    Math.max(1, canvas.clientWidth * canvas.clientHeight);
            };
            const estimatedBrushAreaRatio = estimateBrushAreaRatio();
            const useVoxelBrushFastFrame = !options?.useSam &&
                !options?.samClean &&
                brush?.mode !== 'raw' &&
                brush?.mode !== 'evidence' &&
                getActiveCollisionSurface()?.source === 'voxel' &&
                (
                    estimatedBrushAreaRatio > 0.25 ||
                    (estimatedBrushAreaRatio >= 0.01 && estimatedBrushAreaRatio <= 0.05)
                );

            const { frame, depthBuffer } = await buildBoxerFramePayload(events, scene, splat, canvas, {
                includeImage: !!options?.useSam || !!options?.samClean || (window as any).__boxerExportFullFrame === true,
                includeEncodedDepth: (window as any).__boxerExportFullFrame === true,
                skipDepth: useVoxelBrushFastFrame
            });
            const tFrame = performance.now();
            publishBoxerFrameDebug(frame);
            lastEvalPrompt = { type: options?.samClean ? 'brush_sam_clean' : options?.floorSnap ? 'client_brush_floor_snap' : options?.useSam ? 'brush_sam' : 'client_brush', ...(click ? { click_xy: click } : {}), brush };
            lastEvalFrame = summarizeFrameForEval(frame);
            lastEvalCamera = events.invoke('camera.debugState') as CameraDebugState;

            let sam3Region: Sam3MaskRegion | null = null;
            let sam3Debug: Sam3MaskDebug | undefined;
            if (options?.useSam || options?.samClean) {
                const samClick = click ?? brush?.center_xy;
                if (samClick) {
                    sam3Debug = { attempts: [] };
                    const brushPoints = sampleSam3BrushPoints(brush, samClick);
                    sam3Region = await fetchSam3ClickMaskRegion(frame, splat, scene, samClick[0], samClick[1], sam3Debug, {
                        promptPoints: brushPoints
                    });
                }
            }
            if (options?.useSam && !sam3Region) {
                const reason = sam3Debug?.rejection_reason ?? sam3Debug?.error ?? 'no usable SAM mask';
                const attempts = sam3Debug?.attempts
                .map(attempt => `${attempt.endpoint}:${attempt.status}${attempt.ok ? '' : ':failed'}`)
                .join(', ');
                throw new Error(`SAM brush failed: ${reason}${attempts ? ` (${attempts})` : ''}`);
            }
            const shouldBuildBrushVisualEvidence =
                brush?.mode !== 'raw' &&
                !useVoxelBrushFastFrame &&
                (brush?.mode === 'evidence' || getActiveCollisionSurface()?.source !== 'voxel') &&
                (
                    brush?.mode === 'evidence' ||
                    frame.depth_source !== 'cpu-center-zbuffer' ||
                    estimatedBrushAreaRatio <= 0.1
                );
            const visualEvidence = shouldBuildBrushVisualEvidence ?
                await buildBrushVisualEvidence(events, frame, brush, click).catch((err: unknown): null => {
                    console.warn('[Boxer] brush visual evidence unavailable', err);
                    return null;
                }) :
                null;
            const local = brush?.mode === 'raw' ?
                buildRawBrushObb(frame, splat, scene, brush, click) :
                buildClientBrushObb(frame, splat, scene, depthBuffer, brush, click, {
                    sam3Region: options?.samClean ? sam3Region : null,
                    floorSnap: options?.floorSnap,
                    visualEvidence
                });
            let obb = local.obb;
            const rawObb = cloneObb(obb);
            const liveFusion = options?.liveFusion !== false &&
                !options?.useSam &&
                !options?.samClean &&
                !options?.floorSnap &&
                brush?.mode !== 'raw' ?
                tryBuildLiveBrushSupportFusion(local, frame) :
                { applied: false, reason: 'disabled' };
            lastLiveBrushFusionResult = liveFusion;
            publishLiveBrushFusionStatus();
            if (liveFusion.applied && liveFusion.obb) {
                obb = liveFusion.obb;
            }
            const buildGeometryRefinement = (): GeometryRefinement => {
                if (sam3Region && options?.useSam) {
                    return refineObbFromBoxedPoints(
                        obb,
                        frame,
                        splat,
                        scene,
                        local.bb2d,
                        click ? { click_xy: click, depthBuffer } : undefined,
                        sam3Region
                    );
                }
                if (brush?.mode === 'raw') {
                    return { applied: false, reason: 'raw-brush-extents' };
                }
                const preserveLocalGeometry = local.debug.selected_candidate_source === 'brush_ray' ||
                    local.debug.selected_candidate_source === 'brush_surface' ||
                    (local.debug as { preserve_client_brush_geometry?: boolean }).preserve_client_brush_geometry;
                if (preserveLocalGeometry) {
                    return { applied: false, reason: 'client-brush-ray-prior' };
                }
                return refineObbFromBoxedPoints(
                    obb,
                    frame,
                    splat,
                    scene,
                    local.bb2d,
                    click ? { click_xy: click, depthBuffer } : undefined
                );
            };
            const geometryRefinement = buildGeometryRefinement();
            const tRefine = performance.now();

            publishBoxerResultDebug(
                obb,
                rawObb,
                local.bb2d,
                { applied: false, reason: 'client-brush-no-recenter' },
                geometryRefinement
            );
            const debugResult = (window as any).__lastBoxerResult;
            const targetProjectedBb2d = projectedTargetBb2d(target, scene, frame.intrinsics);
            debugResult.target_projected_bb2d = targetProjectedBb2d;
            debugResult.bb2d_target_metrics = buildBb2dTargetMetrics(local.bb2d, targetProjectedBb2d);
            debugResult.client_brush = {
                backend_bypassed: true,
                target_projected_bb2d: targetProjectedBb2d,
                ...local.debug
            };
            debugResult.live_brush_fusion = liveFusion;
            if (sam3Debug) {
                const brushSurfaceDebug = local.debug.brush_surface as { sam_filter?: { applied?: boolean } } | undefined;
                debugResult.sam3_augmentation = {
                    applied: options?.samClean ?
                        brushSurfaceDebug?.sam_filter?.applied === true :
                        geometryRefinement.reason === 'sam3-click-mask-connected-region',
                    mode: options?.samClean ? 'mask-cleanup' : 'geometry-refinement',
                    region: sam3Region ? {
                        mask_bb2d: sam3Region.mask_bb2d,
                        point_count: sam3Region.point_count,
                        projected_candidate_count: sam3Region.projected_candidate_count,
                        front_surface_candidate_count: sam3Region.front_surface_candidate_count,
                        mask_area_ratio: sam3Region.mask_area_ratio
                    } : null,
                    debug: sam3Debug
                };
            }

            currentCorners = buildWireframeCorners(obb);
            const selectionTruth = await applyBoxerObbSelection(obb);
            debugResult.selection_truth = selectionTruth;
            const finalProjectedBb2d = projectResultTo2D(obb, frame);
            const overlayLayers: BoxerOverlayLayer[] = [];
            if (finalProjectedBb2d) {
                overlayLayers.push({
                    bb2d: finalProjectedBb2d,
                    label: `final ${obb.label}`,
                    color: '#ff9f1a',
                    width: 3
                });
            }
            overlayLayers.push({
                bb2d: local.bb2d,
                label: 'client brush 2d',
                color: '#00d2ff',
                dash: '5 5',
                width: 2
            });
            show2DBoxLayers(overlayLayers);
            const tDone = performance.now();
            updateDebugPanel({
                mode: liveFusion.applied ? 'client brush fusion' : options?.samClean ? 'brush sam clean' : options?.floorSnap ? 'client brush floor snap' : options?.useSam ? 'brush sam' : 'client brush',
                endpoint: 'local geometry',
                label: obb.label,
                confidence: obb.confidence,
                total_ms: tDone - t0,
                frame_ms: tFrame - t0,
                backend_ms: 0,
                refine_ms: tDone - tFrame,
                draw_ms: tDone - tRefine,
                image: frame.image,
                image_width: frame.image_width,
                image_height: frame.image_height,
                depth_source: frame.depth_source,
                bb2d: local.bb2d,
                selected_splat_count: selectionTruth.selected_after,
                candidate_count: local.debug.candidates.length,
                proposal_count: 1,
                ray_sample_count: geometryRefinement.ray_sample_count,
                ray_depth_stats: geometryRefinement.ray_depth_stats,
                candidates: local.debug.candidates.slice(0, 8).map(candidate => ({
                    label: 'brush',
                    score: candidate.selection_score,
                    confidence: 1,
                    source: 'client_brush',
                    bb2d: candidate.bb2d
                }))
            });

            return {
                camera: lastEvalCamera,
                frame: lastEvalFrame,
                raw_boxer_result: rawObb,
                boxer_result: debugResult,
                target: target ?? null,
                raw_metrics: buildEvalMetrics(rawObb, target),
                metrics: buildEvalMetrics(obb, target),
                client_brush_probe: debugResult.client_brush
            };
        };

        // GUARANTEED real Boxer: the stroke's 2D box goes to the Boxer backend
        // (/api/boxer-lift-bb2d) and the model lifts it to a 3D box. Raw model
        // output, no local geometry refinement, and an honest error when the
        // backend is unreachable or returns nothing.
        const executeBrushBoxer = (
            brush: BoxerBrushPrompt | undefined,
            click: [number, number] | undefined,
            target?: BoxerEvalTarget | null,
            options?: Omit<Extract<BoxerEvalPrompt, { type: 'brush_boxer' }>, 'type' | 'click_xy' | 'brush'>
        ) => {
            const strokeBounds = brush?.bb2d ?? (brush?.points?.length ? (() => {
                const radius = brush.radius ?? 8;
                const bounds = brush.points.reduce((acc, point) => {
                    acc[0] = Math.min(acc[0], point[0]);
                    acc[1] = Math.min(acc[1], point[1]);
                    acc[2] = Math.max(acc[2], point[0]);
                    acc[3] = Math.max(acc[3], point[1]);
                    return acc;
                }, [Infinity, Infinity, -Infinity, -Infinity] as NormalizedBb2d);
                return [bounds[0] - radius, bounds[1] - radius, bounds[2] + radius, bounds[3] + radius] as NormalizedBb2d;
            })() : undefined);
            if (!strokeBounds) {
                throw new Error('Brush Boxer needs a stroke region');
            }
            const bb2d = sanitizeBb2d(strokeBounds, canvas.clientWidth, canvas.clientHeight);
            if (!bb2d) {
                throw new Error('Brush Boxer stroke region is invalid');
            }
            const focusPoint = click ?? brush?.center_xy;
            // BoxNet expects roughly metric world units; this scene family is
            // several times that, so default to a single corrective scale.
            // (A multi-scale ensemble scores better but the EC2 backend hangs
            // under the parallel requests — keep live use to one request.)
            const worldScales = options?.boxernet_world_scales ??
                (options?.boxernet_world_scale === undefined ? [0.2] : undefined);
            return executeDirectLift(
                [{
                    id: 'brush-stroke',
                    bb2d,
                    score2d: 1,
                    source: 'manual'
                }],
                {
                    type: 'brush_boxer',
                    ...(click ? { click_xy: click } : {}),
                    brush,
                    ...options,
                    ...(worldScales ? { boxernet_world_scales: worldScales } : {})
                },
                target ?? null,
                focusPoint ? { x: focusPoint[0], y: focusPoint[1] } : undefined,
                options?.preprocess_mode ?? 'full_frame',
                undefined,
                'dense',
                'global',
                options?.boxernet_world_scale,
                options?.refinement_mode ?? 'raw',
                undefined,
                options?.object_crop
            );
        };

        // Fusion: the local pipeline places boxes well but guesses dims; the
        // BoxNet lift gets dims right but places poorly. brush_fused runs both
        // and combines model dimensions with local placement. Honest failure
        // when the model is unreachable.
        const executeBrushFused = async (
            brush: BoxerBrushPrompt | undefined,
            click: [number, number] | undefined,
            target?: BoxerEvalTarget | null,
            options?: { boxernet_world_scale?: number; fuse_mode?: 'model_dims' | 'model_depth' }
        ) => {
            const t0 = performance.now();
            const splat = (events.invoke('selection') as Splat | null) ??
                ((events.invoke('scene.splats') as Splat[] | undefined)?.[0] ?? null);
            if (!splat) {
                throw new Error('No splat loaded');
            }
            await waitForCollisionSurface();
            const { frame, depthBuffer } = await buildBoxerFramePayload(events, scene, splat, canvas, {
                includeImage: true,
                includeEncodedDepth: false
            });
            const tFrame = performance.now();
            publishBoxerFrameDebug(frame);
            lastEvalPrompt = { type: 'brush_fused', ...(click ? { click_xy: click } : {}), brush };
            lastEvalFrame = summarizeFrameForEval(frame);
            lastEvalCamera = events.invoke('camera.debugState') as CameraDebugState;

            const local = buildClientBrushObb(frame, splat, scene, depthBuffer, brush, click);

            const strokeBounds = brush?.bb2d;
            const proposalBb = strokeBounds ? sanitizeBb2d(strokeBounds, frame.image_width, frame.image_height) : local.bb2d;
            if (!proposalBb) {
                throw new Error('Brush fused: stroke region is invalid');
            }
            const worldScale = options?.boxernet_world_scale ?? 0.2;
            const direct = await postBoxerDirectLift(
                getBoxerBackendUrl(),
                frame,
                [{ id: 'brush-stroke', bb2d: proposalBb, score2d: 1, source: 'manual' }],
                'full_frame',
                'dense',
                worldScale
            );
            const detection = direct.detections[0];
            if (!detection) {
                throw new Error('Brush fused: model returned no detections');
            }
            const tBackend = performance.now();

            const modelAabb = aabbFromCorners(detection.corners);
            const localAabb = aabbFromCorners(local.obb.corners);
            if (!modelAabb || !localAabb) {
                throw new Error('Brush fused: could not derive AABBs');
            }
            const modelDims: [number, number, number] = [
                modelAabb.max[0] - modelAabb.min[0],
                modelAabb.max[1] - modelAabb.min[1],
                modelAabb.max[2] - modelAabb.min[2]
            ];
            const localCenter: [number, number, number] = [
                (localAabb.min[0] + localAabb.max[0]) / 2,
                (localAabb.min[1] + localAabb.max[1]) / 2,
                (localAabb.min[2] + localAabb.max[2]) / 2
            ];
            const fusedAabb = aabbFromCenterDimensions(localCenter, modelDims);
            const obb = buildAxisAlignedObbFromAabb(fusedAabb, 'brush_fused', 'brush_fused', local.bb2d);
            const rawObb = cloneObb(detection);

            publishBoxerResultDebug(
                obb,
                rawObb,
                local.bb2d,
                { applied: false, reason: 'brush-fused' },
                { applied: false, reason: 'fused-model-dims-local-center' }
            );
            const debugResult = (window as any).__lastBoxerResult;
            const targetProjectedBb2d = projectedTargetBb2d(target, scene, frame.intrinsics);
            debugResult.target_projected_bb2d = targetProjectedBb2d;
            debugResult.bb2d_target_metrics = buildBb2dTargetMetrics(local.bb2d, targetProjectedBb2d);
            debugResult.brush_fused = {
                fuse_mode: options?.fuse_mode ?? 'model_dims',
                boxernet_world_scale: worldScale,
                local_aabb: localAabb,
                local_source: local.debug.selected_candidate_source,
                model_aabb: modelAabb,
                model_confidence: detection.confidence,
                fused_aabb: fusedAabb
            };
            debugResult.client_brush = {
                backend_bypassed: false,
                target_projected_bb2d: targetProjectedBb2d,
                ...local.debug
            };

            currentCorners = buildWireframeCorners(obb);
            const selectionTruth = await applyBoxerObbSelection(obb);
            debugResult.selection_truth = selectionTruth;
            const tDone = performance.now();
            updateDebugPanel({
                mode: 'brush fused',
                endpoint: `${getBoxerBackendUrl()}/api/boxer-lift-bb2d`,
                label: obb.label,
                confidence: detection.confidence,
                total_ms: tDone - t0,
                frame_ms: tFrame - t0,
                backend_ms: tBackend - tFrame,
                refine_ms: tDone - tBackend,
                draw_ms: 0,
                image_width: frame.image_width,
                image_height: frame.image_height,
                depth_source: frame.depth_source,
                bb2d: local.bb2d,
                selected_splat_count: selectionTruth.selected_after,
                candidate_count: 1,
                proposal_count: 1
            });

            return {
                camera: lastEvalCamera,
                frame: lastEvalFrame,
                raw_boxer_result: rawObb,
                boxer_result: debugResult,
                target: target ?? null,
                raw_metrics: buildEvalMetrics(rawObb, target),
                metrics: buildEvalMetrics(obb, target),
                brush_fused_probe: debugResult.brush_fused
            };
        };

        events.on('boxer.brushPromptCaptured', (prompt: Extract<BoxerEvalPrompt, { type: 'client_brush' | 'client_brush_floor_snap' | 'brush_sam' | 'brush_sam_clean' | 'brush_boxer' }>) => {
            lastBrushPrompt = prompt;
            lastBrushReplay = null;
            const shouldAutoRun = prompt.type === 'brush_boxer' ||
                prompt.type === 'brush_sam' ||
                prompt.type === 'brush_sam_clean';
            brushPanelStatus = shouldAutoRun ? 'running' : 'done';
            renderBrushPanel();
            console.log('[Boxer] captured brush prompt', prompt);
            if (!shouldAutoRun) {
                return;
            }

            events.fire('toast', prompt.type === 'brush_sam' || prompt.type === 'brush_sam_clean' ? 'Running SAM brush selection' : 'Running Boxer model brush lift', 'info');
            new Promise<void>((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }).then(() => runLastBrushBoxer()).then(() => {
                brushPanelStatus = 'done';
                renderBrushPanel();
                events.fire('selection.commit', { source: 'boxerBrushSelection', promptType: prompt.type });
            }).catch((err) => {
                brushPanelStatus = 'failed';
                renderBrushPanel();
                console.warn('[Boxer] brush auto-run failed', err);
                events.fire('toast', err instanceof Error ? err.message : 'Boxer brush selection failed', 'error');
            });
        });

        const runLastBrushBoxer = async (
            input?: BoxerCopyEvalCaseInput
        ) => {
            if (!lastBrushPrompt) {
                events.fire('toast', 'Draw with the brush selection tool first', 'warning');
                return null;
            }
            if (busy) {
                throw new Error('Still processing previous Boxer request');
            }

            const inputTarget = isBoxerEvalTarget(input) ? input : input?.target;
            const target = inputTarget ?? stickyEvalTarget;
            busy = true;
            brushPanelStatus = 'running';
            renderBrushPanel();
            parent.style.cursor = 'wait';
            try {
                const replay = lastBrushPrompt.type === 'brush_boxer' ?
                    await executeBrushBoxer(
                        lastBrushPrompt.brush,
                        lastBrushPrompt.click_xy,
                        target ? cloneEvalTarget(target) : null
                    ) :
                    await executeClientBrush(
                        lastBrushPrompt.brush,
                        lastBrushPrompt.click_xy,
                        target ? cloneEvalTarget(target) : null,
                        {
                            useSam: lastBrushPrompt.type === 'brush_sam',
                            samClean: lastBrushPrompt.type === 'brush_sam_clean',
                            floorSnap: lastBrushPrompt.type === 'client_brush_floor_snap'
                        }
                    );
                lastBrushReplay = replay;
                brushPanelStatus = 'done';
                renderBrushPanel();
                return replay;
            } finally {
                busy = false;
                parent.style.cursor = '';
            }
        };

        const targetSignature = (target: BoxerEvalTarget) => (
            JSON.stringify({
                center: target.center.map(value => Number(value.toFixed(4))),
                dimensions: target.dimensions.map(value => Number(value.toFixed(4)))
            })
        );

        const buildAxisAlignedObbFromPoints = (
            points: [number, number, number][],
            lowQ: number,
            highQ: number,
            label: string
        ): OBBResult => {
            const sorted = [0, 1, 2].map(axis => points.map(point => point[axis]).sort((a, b) => a - b));
            const min = sorted.map(values => quantile(values, lowQ)) as [number, number, number];
            const max = sorted.map(values => quantile(values, highQ)) as [number, number, number];
            const center: [number, number, number] = [
                (min[0] + max[0]) / 2,
                (min[1] + max[1]) / 2,
                (min[2] + max[2]) / 2
            ];
            const dimensions: [number, number, number] = [
                Math.max(0.05, max[0] - min[0]),
                Math.max(0.05, max[1] - min[1]),
                Math.max(0.05, max[2] - min[2])
            ];
            const rotation = [
                [1, 0, 0],
                [0, 1, 0],
                [0, 0, 1]
            ];
            return {
                center,
                dimensions,
                rotation,
                corners: cornersFromCenterDimensions(center, dimensions, rotation),
                label,
                confidence: 1,
                score2d: 1,
                source: 'multiview-splat-carve'
            };
        };

        const buildAxisAlignedObbFromAabbWithSource = (
            aabb: Aabb,
            label: string,
            sourceLabel: string,
            bb2d?: NormalizedBb2d
        ): OBBResult => {
            const obb = buildAxisAlignedObbFromAabb(aabb, label, sourceLabel, bb2d);
            obb.source = sourceLabel;
            return obb;
        };

        const quantileAabbFromPoints = (
            points: [number, number, number][],
            lowQ: number,
            highQ: number,
            inflate = 1
        ): Aabb | null => {
            if (points.length < 8) return null;
            const min: [number, number, number] = [0, 0, 0];
            const max: [number, number, number] = [0, 0, 0];
            for (let axis = 0; axis < 3; axis++) {
                const values = points.map(point => point[axis]).sort((a, b) => a - b);
                const lo = quantile(values, lowQ);
                const hi = quantile(values, highQ);
                const center = (lo + hi) * 0.5;
                const half = Math.max(0.025, (hi - lo) * 0.5 * inflate);
                min[axis] = center - half;
                max[axis] = center + half;
            }
            return { min, max };
        };

        const medianNumber = (values: number[]) => {
            if (!values.length) return 0;
            const sorted = [...values].sort((a, b) => a - b);
            return sorted[Math.floor(sorted.length / 2)];
        };

        type BrushSupportFusionView = {
            points: [number, number, number][];
            supportBox: Aabb | null;
            obb?: OBBResult;
            forward: [number, number, number];
            live_id?: string;
            created_at?: number;
            selected_source?: string;
            support_count?: number;
            support_sample_source?: string;
        };

        const vectorLength3 = (v: [number, number, number]) => Math.hypot(v[0], v[1], v[2]);

        const cameraForwardAngleDegrees = (
            a: [number, number, number],
            b: [number, number, number]
        ) => {
            const len = vectorLength3(a) * vectorLength3(b);
            if (!(len > 0)) return null;
            const dot = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / len;
            const clamped = Math.max(-1, Math.min(1, dot));
            return Math.acos(clamped) * 180 / Math.PI;
        };

        const summarizeBrushSupportViewAngles = (views: BrushSupportFusionView[]) => {
            const angles: number[] = [];
            for (let i = 0; i < views.length; i++) {
                for (let j = i + 1; j < views.length; j++) {
                    const angle = cameraForwardAngleDegrees(views[i].forward, views[j].forward);
                    if (angle !== null && Number.isFinite(angle)) angles.push(angle);
                }
            }
            return {
                max_degrees: angles.length ? Math.max(...angles) : 0,
                avg_degrees: angles.length ? angles.reduce((sum, value) => sum + value, 0) / angles.length : 0
            };
        };

        const buildBrushSupportConsensusAabb = (
            views: BrushSupportFusionView[],
            voxelSize = 0.08,
            consensusFraction = 0.6
        ) => {
            const counts = new Map<string, number>();
            const perViewVoxelCounts: number[] = [];
            for (const view of views) {
                const voxels = new Set<string>();
                for (const point of view.points) {
                    voxels.add([
                        Math.round(point[0] / voxelSize),
                        Math.round(point[1] / voxelSize),
                        Math.round(point[2] / voxelSize)
                    ].join(','));
                }
                perViewVoxelCounts.push(voxels.size);
                for (const voxel of voxels) {
                    counts.set(voxel, (counts.get(voxel) ?? 0) + 1);
                }
            }
            const minCount = Math.max(2, Math.ceil(views.length * consensusFraction));
            const keep: [number, number, number][] = [];
            for (const [voxel, count] of counts) {
                if (count < minCount) continue;
                const parts = voxel.split(',').map(Number) as [number, number, number];
                keep.push(parts);
            }
            const ratio = keep.length / Math.max(1, medianNumber(perViewVoxelCounts));
            if (keep.length < 10) return { aabb: null as Aabb | null, ratio };
            const min: [number, number, number] = [0, 0, 0];
            const max: [number, number, number] = [0, 0, 0];
            for (let axis = 0; axis < 3; axis++) {
                const values = keep.map(voxel => voxel[axis] * voxelSize).sort((a, b) => a - b);
                min[axis] = quantile(values, 0.02) - voxelSize * 0.5;
                max[axis] = quantile(values, 0.98) + voxelSize * 0.5;
            }
            return { aabb: { min, max }, ratio };
        };

        const buildBrushSupportTightAabb = (
            views: BrushSupportFusionView[],
            alignWeightMin = 0.45
        ): Aabb | null => {
            const min: [number, number, number] = [0, 0, 0];
            const max: [number, number, number] = [0, 0, 0];
            for (let axis = 0; axis < 3; axis++) {
                const entries = views
                .filter(view => !!view.supportBox)
                .map(view => ({
                    weight: 1 - Math.abs(view.forward[axis]),
                    min: view.supportBox!.min[axis],
                    max: view.supportBox!.max[axis]
                }));
                if (!entries.length) return null;
                entries.sort((a, b) => b.weight - a.weight);
                const aligned = entries.filter(entry => entry.weight >= alignWeightMin);
                const pool = aligned.length ? aligned : [entries[0]];
                const selected = pool.reduce((best, entry) => (
                    (entry.max - entry.min) < (best.max - best.min) ? entry : best
                ));
                min[axis] = selected.min;
                max[axis] = selected.max;
            }
            return { min, max };
        };

        const intersectAabbs = (boxes: Aabb[]): Aabb | null => {
            if (!boxes.length) return null;
            const min: [number, number, number] = [-Infinity, -Infinity, -Infinity];
            const max: [number, number, number] = [Infinity, Infinity, Infinity];
            for (const box of boxes) {
                for (let axis = 0; axis < 3; axis++) {
                    min[axis] = Math.max(min[axis], box.min[axis]);
                    max[axis] = Math.min(max[axis], box.max[axis]);
                }
            }
            for (let axis = 0; axis < 3; axis++) {
                if (max[axis] <= min[axis]) return null;
            }
            return { min, max };
        };

        const scaleAabbAxes = (
            box: Aabb,
            scales: [number, number, number]
        ): Aabb => {
            const min: [number, number, number] = [0, 0, 0];
            const max: [number, number, number] = [0, 0, 0];
            for (let axis = 0; axis < 3; axis++) {
                const center = (box.min[axis] + box.max[axis]) * 0.5;
                const half = (box.max[axis] - box.min[axis]) * 0.5 * scales[axis];
                min[axis] = center - half;
                max[axis] = center + half;
            }
            return { min, max };
        };

        const clampTightAabbWithConsensusEdge = (
            tight: Aabb | null,
            consensus: Aabb | null,
            consensusRatio: number,
            voxelSize = 0.08
        ): { aabb: Aabb | null; applied: boolean; axis?: number; side?: 'min' | 'max'; amount?: number } => {
            if (!tight || !consensus || consensusRatio >= 0.55) {
                return { aabb: tight, applied: false };
            }

            let best: { axis: number; side: 'min' | 'max'; amount: number } | null = null;
            for (let axis = 0; axis < 3; axis++) {
                const span = tight.max[axis] - tight.min[axis];
                if (!(span > 0)) continue;
                const maxClamp = Math.max(voxelSize * 2, span * 0.12);
                const minTrim = consensus.min[axis] - tight.min[axis];
                const maxTrim = tight.max[axis] - consensus.max[axis];
                for (const candidate of [
                    { axis, side: 'min' as const, amount: minTrim },
                    { axis, side: 'max' as const, amount: maxTrim }
                ]) {
                    if (!(candidate.amount > voxelSize * 1.25) || candidate.amount > maxClamp) continue;
                    if (!best || candidate.amount > best.amount) best = candidate;
                }
            }

            if (!best) return { aabb: tight, applied: false };
            const aabb = {
                min: [...tight.min] as [number, number, number],
                max: [...tight.max] as [number, number, number]
            };
            if (best.side === 'min') {
                aabb.min[best.axis] = consensus.min[best.axis] + voxelSize;
            } else {
                aabb.max[best.axis] = consensus.max[best.axis] - voxelSize;
            }
            if (aabb.max[best.axis] <= aabb.min[best.axis]) {
                return { aabb: tight, applied: false };
            }
            return { aabb, applied: true, ...best };
        };

        const filterConsistentBrushSupportViews = (views: BrushSupportFusionView[]) => {
            if (views.length <= 2) {
                if (views.length < 2) return views;
                const overlap = views[0].supportBox && views[1].supportBox ?
                    aabbIou(views[0].supportBox, views[1].supportBox) :
                    0;
                return overlap > 0.01 ? views : [];
            }
            const neighbors = views.map((): number[] => []);
            for (let i = 0; i < views.length; i++) {
                for (let j = i + 1; j < views.length; j++) {
                    const overlap = views[i].supportBox && views[j].supportBox ?
                        aabbIou(views[i].supportBox, views[j].supportBox) :
                        0;
                    if (overlap > 0.01) {
                        neighbors[i].push(j);
                        neighbors[j].push(i);
                    }
                }
            }
            const seen = new Set<number>();
            let best: number[] = [];
            for (let start = 0; start < views.length; start++) {
                if (seen.has(start)) continue;
                const component: number[] = [];
                const stack = [start];
                seen.add(start);
                while (stack.length) {
                    const index = stack.pop()!;
                    component.push(index);
                    for (const next of neighbors[index]) {
                        if (seen.has(next)) continue;
                        seen.add(next);
                        stack.push(next);
                    }
                }
                if (component.length > best.length) best = component;
            }
            return best.map(index => views[index]);
        };

        const pointsFromFlatSupportSample = (sample: unknown): [number, number, number][] => {
            if (!Array.isArray(sample)) return [];
            const points: [number, number, number][] = [];
            for (let i = 0; i + 2 < sample.length; i += 3) {
                const x = Number(sample[i]);
                const y = Number(sample[i + 1]);
                const z = Number(sample[i + 2]);
                if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
                    points.push([x, y, z]);
                }
            }
            return points;
        };

        const findLiveBrushSupportComponent = (
            views: BrushSupportFusionView[],
            startIndex: number
        ) => {
            const seen = new Set<number>([startIndex]);
            const stack = [startIndex];
            while (stack.length) {
                const index = stack.pop()!;
                const box = views[index].supportBox;
                if (!box) continue;
                for (let next = 0; next < views.length; next++) {
                    if (seen.has(next)) continue;
                    const nextBox = views[next].supportBox;
                    if (!nextBox) continue;
                    if (aabbIou(box, nextBox) > 0.01) {
                        seen.add(next);
                        stack.push(next);
                    }
                }
            }
            return [...seen].map(index => views[index]);
        };

        const tryBuildLiveBrushSupportFusion = (
            local: {
                obb: OBBResult;
                bb2d: NormalizedBb2d;
                debug: {
                    brush_surface?: unknown;
                    selected_candidate_source?: string;
                } & Record<string, unknown>;
            },
            frame: BoxerFramePayload
        ): {
            applied: boolean;
            reason: string;
            obb?: OBBResult;
            view_count?: number;
            consistent_view_count?: number;
            support_view_max_angle_degrees?: number;
            support_view_avg_angle_degrees?: number;
            fusion_method?: string;
            consensus_overlap_ratio?: number;
            support_box?: Aabb | null;
            support_tight_aabb?: Aabb | null;
            support_tight_consensus_edge_aabb?: Aabb | null;
            support_tight_consensus_edge?: { axis?: number; side?: 'min' | 'max'; amount?: number } | null;
            support_intersection_aabb?: Aabb | null;
            compact_intersection_aabb?: Aabb | null;
            current_support_inside_count?: number;
            current_support_count?: number;
            current_support_coverage?: number;
            reprojection_bb2d?: NormalizedBb2d | null;
            reprojection_overlap?: ReturnType<typeof buildBb2dCoverageStats> | null;
            selected_source?: string;
            support_sample_source?: string;
            historical_source_view_id?: string;
        } => {
            const surfaceDebug = local.debug.brush_surface as {
                support_sample?: unknown;
                core_support_sample?: unknown;
                support_count?: number;
                core_support_count?: number;
                anchor_hit_ratio?: number;
            } | undefined;
            const broadPoints = pointsFromFlatSupportSample(surfaceDebug?.support_sample);
            const points = broadPoints;
            const supportSampleSource = 'support_sample';
            if (points.length < 24) {
                return {
                    applied: false,
                    reason: 'too-few-current-support-points',
                    view_count: liveBrushSupportViews.length
                };
            }

            const supportBox = quantileAabbFromPoints(points, 0.015, 0.985, 1.02);
            if (!supportBox) {
                return {
                    applied: false,
                    reason: 'missing-current-support-box',
                    view_count: liveBrushSupportViews.length
                };
            }

            const e = frame.extrinsics;
            const currentView: BrushSupportFusionView = {
                points,
                supportBox,
                obb: local.obb,
                forward: [e[8], e[9], e[10]],
                live_id: `live-${Date.now()}-${Math.round(performance.now())}`,
                created_at: Date.now(),
                selected_source: local.debug.selected_candidate_source,
                support_sample_source: supportSampleSource,
                support_count: surfaceDebug?.support_count
            };
            liveBrushSupportViews.push(currentView);
            while (liveBrushSupportViews.length > 18) {
                liveBrushSupportViews.shift();
            }

            const currentIndex = liveBrushSupportViews.indexOf(currentView);
            const component = findLiveBrushSupportComponent(liveBrushSupportViews, currentIndex);
            const consistentViews = filterConsistentBrushSupportViews(component);
            if (consistentViews.length < 2 || !consistentViews.includes(currentView)) {
                return {
                    applied: false,
                    reason: consistentViews.includes(currentView) ? 'need-second-overlapping-view' : 'current-view-not-in-consistent-component',
                    view_count: component.length,
                    consistent_view_count: consistentViews.length,
                    support_box: supportBox,
                    selected_source: local.debug.selected_candidate_source,
                    support_sample_source: supportSampleSource
                };
            }

            const consensus = buildBrushSupportConsensusAabb(consistentViews);
            const viewAngles = summarizeBrushSupportViewAngles(consistentViews);
            const tight = buildBrushSupportTightAabb(consistentViews);
            const clampedTight = clampTightAabbWithConsensusEdge(tight, consensus.aabb, consensus.ratio);
            const supportIntersection = intersectAabbs(consistentViews
            .map(view => view.supportBox)
            .filter((box): box is Aabb => !!box));
            const localAabb = aabbFromCorners(local.obb.corners);
            const localDims = [
                localAabb.max[0] - localAabb.min[0],
                localAabb.max[1] - localAabb.min[1],
                localAabb.max[2] - localAabb.min[2]
            ];
            const supportIntersectionDims = supportIntersection ?
                [
                    supportIntersection.max[0] - supportIntersection.min[0],
                    supportIntersection.max[1] - supportIntersection.min[1],
                    supportIntersection.max[2] - supportIntersection.min[2]
                ] :
                null;
            const supportIntersectionHorizontalMax = supportIntersectionDims ?
                Math.max(supportIntersectionDims[0], supportIntersectionDims[2]) :
                0;
            const sameViewCompactIntersection = supportIntersection &&
                supportIntersectionDims &&
                consistentViews.length === 2 &&
                consensus.ratio >= 0.6 &&
                supportIntersectionHorizontalMax <= 2.35 &&
                supportIntersectionDims[1] >= 0.9 &&
                supportIntersectionDims[1] <= 2.6 &&
                supportIntersectionDims[1] / Math.max(0.05, supportIntersectionHorizontalMax) >= 1.35 ?
                supportIntersection :
                null;
            const tightDims = tight ?
                [
                    tight.max[0] - tight.min[0],
                    tight.max[1] - tight.min[1],
                    tight.max[2] - tight.min[2]
                ] :
                null;
            const sameViewBroadRaySupportHybrid = tight && tightDims &&
                local.debug.selected_candidate_source === 'brush_ray' &&
                consistentViews.length >= 2 &&
                viewAngles.max_degrees < 1 &&
                consensus.ratio >= 0.28 &&
                localDims[0] >= 3.0 &&
                localDims[1] >= 2.7 &&
                localDims[2] >= 3.0 &&
                tightDims[1] >= 2.6 &&
                tightDims[2] >= 3.0 ?
                {
                    min: [localAabb.min[0], tight.min[1], tight.min[2]] as [number, number, number],
                    max: [localAabb.max[0], tight.max[1], tight.max[2]] as [number, number, number]
                } :
                null;
            const compactIntersection = supportIntersection &&
                consistentViews.length <= 4 &&
                !!consensus.aabb &&
                consensus.ratio >= 0.75 ?
                scaleAabbAxes(supportIntersection, [1.06, 0.98, 1.065]) :
                null;
            const chosenAabb = sameViewCompactIntersection ??
                sameViewBroadRaySupportHybrid ??
                compactIntersection ??
                (consensus.aabb && consensus.ratio >= 0.55 ? consensus.aabb : clampedTight.aabb);
            const method = sameViewCompactIntersection ?
                'live-brush-support-same-view-compact-intersection' :
                sameViewBroadRaySupportHybrid ?
                    'live-brush-support-same-view-ray-support-hybrid' :
                    compactIntersection ?
                        'live-brush-support-compact-intersection' :
                        (consensus.aabb && consensus.ratio >= 0.55 ? 'live-brush-support-consensus' : (clampedTight.applied ? 'live-brush-support-tight-consensus-edge' : 'live-brush-support-tight'));
            const buildHistoricalCandidate = () => {
                const candidates = consistentViews
                .filter(view => view !== currentView)
                .filter((view): view is BrushSupportFusionView & { obb: OBBResult } => !!view.obb)
                .map((view) => {
                    const aabb = aabbFromCorners(view.obb.corners);
                    const supportCoverage = summarizeAabbPointCoverage(points, aabb, 0.025);
                    const supportOverlap = aabbIou(aabb, supportBox);
                    const reprojectionBb2d = projectedCornersBb2d(view.obb.corners, scene, frame.intrinsics);
                    const reprojectionOverlap = reprojectionBb2d ?
                        buildBb2dCoverageStats(local.bb2d, reprojectionBb2d) :
                        null;
                    const reprojectionOk = !!reprojectionOverlap && (
                        reprojectionOverlap.iou >= 0.35 ||
                        reprojectionOverlap.a_covered_by_b >= 0.72 ||
                        reprojectionOverlap.b_covered_by_a >= 0.55
                    );
                    const supportOk = supportCoverage.inside_count >= 24 &&
                        supportCoverage.coverage >= 0.35 &&
                        supportOverlap >= 0.18;
                    return {
                        view,
                        aabb,
                        supportCoverage,
                        supportOverlap,
                        reprojectionBb2d,
                        reprojectionOverlap,
                        ok: supportOk && reprojectionOk,
                        score: supportCoverage.coverage +
                            supportOverlap * 0.55 +
                            (reprojectionOverlap?.iou ?? 0) * 0.65 +
                            (reprojectionOverlap?.a_covered_by_b ?? 0) * 0.15
                    };
                })
                .filter(candidate => candidate.ok)
                .sort((a, b) => b.score - a.score);
                return candidates[0] ?? null;
            };
            if (!chosenAabb) {
                return {
                    applied: false,
                    reason: 'no-live-fusion-box',
                    view_count: component.length,
                    consistent_view_count: consistentViews.length,
                    consensus_overlap_ratio: consensus.ratio,
                    support_box: supportBox,
                    support_tight_aabb: tight,
                    support_tight_consensus_edge_aabb: clampedTight.aabb,
                    support_tight_consensus_edge: clampedTight.applied ? {
                        axis: clampedTight.axis,
                        side: clampedTight.side,
                        amount: clampedTight.amount
                    } : null,
                    support_intersection_aabb: supportIntersection,
                    compact_intersection_aabb: compactIntersection,
                    selected_source: local.debug.selected_candidate_source,
                    support_sample_source: supportSampleSource
                };
            }
            const canPromote = !!sameViewCompactIntersection ||
                !!sameViewBroadRaySupportHybrid ||
                !!compactIntersection ||
                (method === 'live-brush-support-consensus' && consistentViews.length >= 3 && consensus.ratio >= 0.75) ||
                ((method === 'live-brush-support-tight' || method === 'live-brush-support-tight-consensus-edge') && consistentViews.length >= 6);
            if (!canPromote) {
                const historical = viewAngles.max_degrees >= LIVE_FUSION_MIN_PROMOTION_ANGLE_DEGREES &&
                    consistentViews.length >= LIVE_FUSION_READY_VIEW_GOAL ?
                    buildHistoricalCandidate() :
                    null;
                if (historical) {
                    return {
                        applied: true,
                        reason: 'live-brush-support-historical-validated',
                        obb: {
                            ...historical.view.obb,
                            label: 'live-brush-support-historical-validated',
                            source: 'live-brush-support-historical-validated',
                            bb2d: local.bb2d,
                            source_bb2d: local.bb2d
                        },
                        view_count: component.length,
                        consistent_view_count: consistentViews.length,
                        support_view_max_angle_degrees: viewAngles.max_degrees,
                        support_view_avg_angle_degrees: viewAngles.avg_degrees,
                        fusion_method: 'live-brush-support-historical-validated',
                        consensus_overlap_ratio: consensus.ratio,
                        support_box: supportBox,
                        support_tight_aabb: tight,
                        support_tight_consensus_edge_aabb: clampedTight.aabb,
                        support_tight_consensus_edge: clampedTight.applied ? {
                            axis: clampedTight.axis,
                            side: clampedTight.side,
                            amount: clampedTight.amount
                        } : null,
                        support_intersection_aabb: supportIntersection,
                        compact_intersection_aabb: compactIntersection,
                        current_support_inside_count: historical.supportCoverage.inside_count,
                        current_support_count: historical.supportCoverage.total_count,
                        current_support_coverage: historical.supportCoverage.coverage,
                        reprojection_bb2d: historical.reprojectionBb2d,
                        reprojection_overlap: historical.reprojectionOverlap,
                        selected_source: local.debug.selected_candidate_source,
                        support_sample_source: supportSampleSource,
                        historical_source_view_id: historical.view.live_id
                    };
                }
                return {
                    applied: false,
                    reason: 'live-fusion-evidence-not-promoted',
                    view_count: component.length,
                    consistent_view_count: consistentViews.length,
                    support_view_max_angle_degrees: viewAngles.max_degrees,
                    support_view_avg_angle_degrees: viewAngles.avg_degrees,
                    fusion_method: method,
                    consensus_overlap_ratio: consensus.ratio,
                    support_box: supportBox,
                    support_tight_aabb: tight,
                    support_tight_consensus_edge_aabb: clampedTight.aabb,
                    support_tight_consensus_edge: clampedTight.applied ? {
                        axis: clampedTight.axis,
                        side: clampedTight.side,
                        amount: clampedTight.amount
                    } : null,
                    support_intersection_aabb: supportIntersection,
                    compact_intersection_aabb: compactIntersection,
                    selected_source: local.debug.selected_candidate_source,
                    support_sample_source: supportSampleSource
                };
            }
            if (!sameViewCompactIntersection && !sameViewBroadRaySupportHybrid && viewAngles.max_degrees < LIVE_FUSION_MIN_PROMOTION_ANGLE_DEGREES) {
                return {
                    applied: false,
                    reason: 'live-fusion-needs-view-diversity',
                    view_count: component.length,
                    consistent_view_count: consistentViews.length,
                    support_view_max_angle_degrees: viewAngles.max_degrees,
                    support_view_avg_angle_degrees: viewAngles.avg_degrees,
                    fusion_method: method,
                    consensus_overlap_ratio: consensus.ratio,
                    support_box: supportBox,
                    support_tight_aabb: tight,
                    support_tight_consensus_edge_aabb: clampedTight.aabb,
                    support_tight_consensus_edge: clampedTight.applied ? {
                        axis: clampedTight.axis,
                        side: clampedTight.side,
                        amount: clampedTight.amount
                    } : null,
                    support_intersection_aabb: supportIntersection,
                    compact_intersection_aabb: compactIntersection,
                    selected_source: local.debug.selected_candidate_source,
                    support_sample_source: supportSampleSource
                };
            }

            const currentSupportCoverage = summarizeAabbPointCoverage(points, chosenAabb, 0.025);
            const minCurrentSupportCoverage = sameViewCompactIntersection || sameViewBroadRaySupportHybrid ? 0.55 : 0.03;
            const currentSupportOk = currentSupportCoverage.inside_count >= 24 &&
                currentSupportCoverage.coverage >= minCurrentSupportCoverage;
            if (!currentSupportOk) {
                return {
                    applied: false,
                    reason: 'live-fusion-current-support-rejected',
                    view_count: component.length,
                    consistent_view_count: consistentViews.length,
                    support_view_max_angle_degrees: viewAngles.max_degrees,
                    support_view_avg_angle_degrees: viewAngles.avg_degrees,
                    fusion_method: method,
                    consensus_overlap_ratio: consensus.ratio,
                    support_box: supportBox,
                    support_tight_aabb: tight,
                    support_tight_consensus_edge_aabb: clampedTight.aabb,
                    support_tight_consensus_edge: clampedTight.applied ? {
                        axis: clampedTight.axis,
                        side: clampedTight.side,
                        amount: clampedTight.amount
                    } : null,
                    support_intersection_aabb: supportIntersection,
                    compact_intersection_aabb: compactIntersection,
                    current_support_inside_count: currentSupportCoverage.inside_count,
                    current_support_count: currentSupportCoverage.total_count,
                    current_support_coverage: currentSupportCoverage.coverage,
                    selected_source: local.debug.selected_candidate_source,
                    support_sample_source: supportSampleSource
                };
            }

            const obb = buildAxisAlignedObbFromAabbWithSource(chosenAabb, method, method, local.bb2d);
            const reprojectionBb2d = projectedCornersBb2d(obb.corners, scene, frame.intrinsics);
            const reprojectionOverlap = reprojectionBb2d ?
                buildBb2dCoverageStats(local.bb2d, reprojectionBb2d) :
                null;
            const reprojectionOk = !!reprojectionOverlap && (
                sameViewCompactIntersection || sameViewBroadRaySupportHybrid ?
                    (
                        reprojectionOverlap.iou >= 0.45 ||
                        reprojectionOverlap.a_covered_by_b >= 0.82 ||
                        reprojectionOverlap.b_covered_by_a >= 0.72
                    ) :
                    (
                        reprojectionOverlap.iou >= 0.18 ||
                        reprojectionOverlap.a_covered_by_b >= 0.55 ||
                        reprojectionOverlap.b_covered_by_a >= 0.35
                    )
            );
            if (!reprojectionOk) {
                return {
                    applied: false,
                    reason: 'live-fusion-reprojection-rejected',
                    view_count: component.length,
                    consistent_view_count: consistentViews.length,
                    support_view_max_angle_degrees: viewAngles.max_degrees,
                    support_view_avg_angle_degrees: viewAngles.avg_degrees,
                    fusion_method: method,
                    consensus_overlap_ratio: consensus.ratio,
                    support_box: supportBox,
                    support_tight_aabb: tight,
                    support_tight_consensus_edge_aabb: clampedTight.aabb,
                    support_tight_consensus_edge: clampedTight.applied ? {
                        axis: clampedTight.axis,
                        side: clampedTight.side,
                        amount: clampedTight.amount
                    } : null,
                    support_intersection_aabb: supportIntersection,
                    compact_intersection_aabb: compactIntersection,
                    current_support_inside_count: currentSupportCoverage.inside_count,
                    current_support_count: currentSupportCoverage.total_count,
                    current_support_coverage: currentSupportCoverage.coverage,
                    reprojection_bb2d: reprojectionBb2d,
                    reprojection_overlap: reprojectionOverlap,
                    selected_source: local.debug.selected_candidate_source,
                    support_sample_source: supportSampleSource
                };
            }
            return {
                applied: true,
                reason: 'live-brush-support-fusion',
                obb,
                view_count: component.length,
                consistent_view_count: consistentViews.length,
                support_view_max_angle_degrees: viewAngles.max_degrees,
                support_view_avg_angle_degrees: viewAngles.avg_degrees,
                fusion_method: method,
                consensus_overlap_ratio: consensus.ratio,
                support_box: supportBox,
                support_tight_aabb: tight,
                support_tight_consensus_edge_aabb: clampedTight.aabb,
                support_tight_consensus_edge: clampedTight.applied ? {
                    axis: clampedTight.axis,
                    side: clampedTight.side,
                    amount: clampedTight.amount
                } : null,
                support_intersection_aabb: supportIntersection,
                compact_intersection_aabb: compactIntersection,
                current_support_inside_count: currentSupportCoverage.inside_count,
                current_support_count: currentSupportCoverage.total_count,
                current_support_coverage: currentSupportCoverage.coverage,
                reprojection_bb2d: reprojectionBb2d,
                reprojection_overlap: reprojectionOverlap,
                selected_source: local.debug.selected_candidate_source,
                support_sample_source: supportSampleSource
            };
        };

        const executeEvalFusion = async (
            evalCases: BoxerFusionEvalCase[],
            options: BoxerFusionOptions = {}
        ) => {
            const splat = (events.invoke('selection') as Splat | null) ??
                ((events.invoke('scene.splats') as Splat[] | undefined)?.[0] ?? null);
            if (!splat) throw new Error('No splat loaded');

            const source = options.source ?? 'target_box';

            const originalCamera = events.invoke('camera.debugState') as CameraDebugState;
            const groups = new Map<string, { target: BoxerEvalTarget; cases: BoxerFusionEvalCase[] }>();
            for (const evalCase of evalCases) {
                if (!evalCase.target) continue;
                const key = targetSignature(evalCase.target);
                const group = groups.get(key);
                if (group) {
                    group.cases.push(evalCase);
                } else {
                    groups.set(key, { target: evalCase.target, cases: [evalCase] });
                }
            }

            const groupResults = [];
            for (const [key, group] of groups) {
                const counts = new Map<number, number>();
                const frontCounts = new Map<number, number>();
                const pointByIndex = new Map<number, [number, number, number]>();
                const viewStats = [];
                const brushSupportViews: BrushSupportFusionView[] = [];

                for (const [viewIndex, evalCase] of group.cases.entries()) {
                    applyCameraState(scene, evalCase.camera);
                    await waitForNextRender(scene);

                    let viewImage: string | undefined;
                    let sanitized: NormalizedBb2d | null = null;
                    let padded: NormalizedBb2d | null = null;
                    let projected: ProjectedSplatCandidate[] = [];
                    let frontSurface: ProjectedSplatCandidate[] = [];
                    let candidateSource: string = source;

                    if (source === 'target_box') {
                        viewImage = options.capture_view_images ?
                            await captureScene(events, canvas.clientWidth, canvas.clientHeight) :
                            undefined;
                        const intrinsics = extractIntrinsics(scene.camera.camera, canvas.clientWidth, canvas.clientHeight);
                        const bb = projectedTargetBb2d(group.target, scene, intrinsics);
                        sanitized = bb ? sanitizeBb2d(bb, canvas.clientWidth, canvas.clientHeight) : null;
                        if (!sanitized) {
                            viewStats.push({
                                view_index: viewIndex,
                                fixture_index: evalCase.fixture_index,
                                captured_at: evalCase.captured_at,
                                prompt_type: evalCase.prompt?.type,
                                id: evalCase.id ?? evalCase.captured_at ?? `view-${viewIndex}`,
                                preview_image: viewImage,
                                rejected: 'target-not-visible'
                            });
                            continue;
                        }

                        const padScale = options.pad_scale ?? 1;
                        padded = padScale === 1 ?
                            sanitized :
                            (expandBb2d(sanitized, padScale, canvas.clientWidth, canvas.clientHeight) ?? sanitized);
                        projected = collectProjectedSplatCandidates(splat, scene, intrinsics, padded);
                        frontSurface = filterFrontSurfaceProjectedCandidates(projected, canvas.clientWidth, canvas.clientHeight);
                    } else if (source === 'click_cluster') {
                        const prompt = evalCase.prompt;
                        const clickSource = prompt && 'click_xy' in prompt ? prompt.click_xy : null;
                        if (!clickSource) {
                            viewStats.push({
                                view_index: viewIndex,
                                fixture_index: evalCase.fixture_index,
                                captured_at: evalCase.captured_at,
                                prompt_type: evalCase.prompt?.type,
                                id: evalCase.id ?? evalCase.captured_at ?? `view-${viewIndex}`,
                                rejected: 'missing-click'
                            });
                            continue;
                        }

                        const { frame, depthBuffer } = await buildBoxerFramePayload(events, scene, splat, canvas);
                        viewImage = options.capture_view_images ? frame.image : undefined;
                        const sourceWidth = evalCase.frame?.image_width ?? frame.image_width;
                        const sourceHeight = evalCase.frame?.image_height ?? frame.image_height;
                        const clickX = Math.round(clickSource[0] * frame.image_width / sourceWidth);
                        const clickY = Math.round(clickSource[1] * frame.image_height / sourceHeight);
                        const clickDepth = sampleDepthArea(depthBuffer, frame.image_width, frame.image_height, clickX, clickY);
                        if (clickDepth <= 0) {
                            viewStats.push({
                                view_index: viewIndex,
                                fixture_index: evalCase.fixture_index,
                                captured_at: evalCase.captured_at,
                                prompt_type: evalCase.prompt?.type,
                                id: evalCase.id ?? evalCase.captured_at ?? `view-${viewIndex}`,
                                preview_image: viewImage,
                                rejected: 'missing-click-depth',
                                click_xy: [clickX, clickY]
                            });
                            continue;
                        }

                        const local = collectClickLocalCluster(
                            splat,
                            scene,
                            frame,
                            [0, 0, frame.image_width, frame.image_height],
                            clickX,
                            clickY,
                            clickDepth
                        );
                        sanitized = bboxFromProjectedCandidates(local.cluster, frame.image_width, frame.image_height);
                        let selected = local.cluster;
                        candidateSource = 'click_cluster';
                        if (!sanitized || selected.length < 24) {
                            const localProjected = collectProjectedSplatCandidates(splat, scene, frame.intrinsics, local.localBb);
                            const localFrontSurface = filterFrontSurfaceProjectedCandidates(localProjected, frame.image_width, frame.image_height);
                            const depthBand = Math.max(0.6, clickDepth * 0.08);
                            const pixelRadius = Math.max(140, Math.min(280, clickDepth * 24));
                            selected = (localFrontSurface.length >= 24 ? localFrontSurface : localProjected).filter(candidate => (
                                Math.hypot(candidate.pixel[0] - clickX, candidate.pixel[1] - clickY) <= pixelRadius &&
                                Math.abs(candidate.depth - clickDepth) <= depthBand
                            ));
                            sanitized = bboxFromProjectedCandidates(selected, frame.image_width, frame.image_height);
                            candidateSource = 'click_depth_window';
                        }
                        if (!sanitized || selected.length < 24) {
                            viewStats.push({
                                view_index: viewIndex,
                                fixture_index: evalCase.fixture_index,
                                captured_at: evalCase.captured_at,
                                prompt_type: evalCase.prompt?.type,
                                id: evalCase.id ?? evalCase.captured_at ?? `view-${viewIndex}`,
                                preview_image: viewImage,
                                rejected: 'too-few-click-candidates',
                                click_xy: [clickX, clickY],
                                click_depth: clickDepth,
                                cluster_count: local.cluster.length,
                                local_candidate_count: local.localCandidateCount,
                                front_surface_candidate_count: local.frontSurfaceCandidateCount
                            });
                            continue;
                        }

                        const padScale = options.pad_scale ?? 1;
                        padded = padScale === 1 ?
                            sanitized :
                            (expandBb2d(sanitized, padScale, frame.image_width, frame.image_height) ?? sanitized);
                        projected = selected.filter(candidate => bbContainsPoint(padded!, candidate.pixel[0], candidate.pixel[1]));
                        frontSurface = filterFrontSurfaceProjectedCandidates(projected, frame.image_width, frame.image_height);
                    } else if (source === 'brush_support') {
                        const prompt = evalCase.prompt;
                        const brush = prompt && 'brush' in prompt ? prompt.brush : undefined;
                        if (!brush?.points?.length) {
                            viewStats.push({
                                view_index: viewIndex,
                                fixture_index: evalCase.fixture_index,
                                captured_at: evalCase.captured_at,
                                prompt_type: evalCase.prompt?.type,
                                id: evalCase.id ?? evalCase.captured_at ?? `view-${viewIndex}`,
                                rejected: 'missing-brush-points'
                            });
                            continue;
                        }

                        const { frame } = await buildBoxerFramePayload(events, scene, splat, canvas, {
                            includeImage: !!options.capture_view_images,
                            includeEncodedDepth: false,
                            skipDepth: true
                        });
                        viewImage = options.capture_view_images ? frame.image : undefined;
                        const sourceWidth = evalCase.frame?.image_width ?? frame.image_width;
                        const sourceHeight = evalCase.frame?.image_height ?? frame.image_height;
                        const scaleX = frame.image_width / Math.max(1, sourceWidth);
                        const scaleY = frame.image_height / Math.max(1, sourceHeight);
                        const scaledBrush: BoxerBrushPrompt = {
                            ...brush,
                            ...(brush.center_xy ? {
                                center_xy: [
                                    brush.center_xy[0] * scaleX,
                                    brush.center_xy[1] * scaleY
                                ] as [number, number]
                            } : {}),
                            ...(brush.radius !== undefined ? { radius: brush.radius * Math.max(scaleX, scaleY) } : {}),
                            ...(brush.width !== undefined ? { width: brush.width * scaleX } : {}),
                            ...(brush.height !== undefined ? { height: brush.height * scaleY } : {}),
                            ...(brush.bb2d ? {
                                bb2d: [
                                    brush.bb2d[0] * scaleX,
                                    brush.bb2d[1] * scaleY,
                                    brush.bb2d[2] * scaleX,
                                    brush.bb2d[3] * scaleY
                                ] as NormalizedBb2d
                            } : {}),
                            points: brush.points.map(point => [
                                point[0] * scaleX,
                                point[1] * scaleY
                            ] as [number, number]),
                            ...(brush.pad !== undefined ? { pad: brush.pad * Math.max(scaleX, scaleY) } : {})
                        };
                        const clickSource = prompt && 'click_xy' in prompt ? prompt.click_xy : undefined;
                        const scaledClick = clickSource ? [
                            clickSource[0] * scaleX,
                            clickSource[1] * scaleY
                        ] as [number, number] : undefined;
                        const region = resolveClientBrushRegion(frame, scaledBrush, scaledClick);
                        sanitized = region.bb2d;
                        const targetBb2d = projectedTargetBb2d(group.target, scene, frame.intrinsics);
                        const targetBrushMetrics = targetBb2d ?
                            buildBb2dTargetMetrics(region.bb2d, targetBb2d) :
                            null;
                        const targetViewScorable = !!targetBrushMetrics &&
                            targetBrushMetrics.target_covered_by_bb2d >= 0.65;
                        const baseProjected = collectProjectedSplatCandidates(splat, scene, frame.intrinsics, region.bb2d);
                        const surfaceEvidence = collectBrushSurfaceEvidence(frame, scene, region, scaledBrush, baseProjected);
                        if (!surfaceEvidence || surfaceEvidence.support.length < 24) {
                            viewStats.push({
                                view_index: viewIndex,
                                fixture_index: evalCase.fixture_index,
                                captured_at: evalCase.captured_at,
                                prompt_type: evalCase.prompt?.type,
                                id: evalCase.id ?? evalCase.captured_at ?? `view-${viewIndex}`,
                                preview_image: viewImage,
                                rejected: 'too-few-brush-support',
                                bb2d: sanitized,
                                target_projected_bb2d: targetBb2d,
                                target_brush_metrics: targetBrushMetrics,
                                target_view_scorable: targetViewScorable,
                                target_view_scorable_reason: targetBb2d ? 'prompt_target_coverage_low' : 'target_not_projected',
                                support_count: surfaceEvidence?.support.length ?? 0,
                                anchor_count: surfaceEvidence?.anchors.length ?? 0,
                                anchor_hit_ratio: surfaceEvidence?.anchor_hit_ratio ?? 0
                            });
                            continue;
                        }
                        const supportStep = Math.max(1, Math.ceil(surfaceEvidence.support.length / 4000));
                        const points: [number, number, number][] = [];
                        for (let i = 0; i < surfaceEvidence.support.length; i += supportStep) {
                            points.push([...surfaceEvidence.support[i].point] as [number, number, number]);
                        }
                        const supportBox = quantileAabbFromPoints(points, 0.015, 0.985, 1.02);
                        const e = frame.extrinsics;
                        const includeInSupportFusion = !options.scorable_support_only || targetViewScorable;
                        if (includeInSupportFusion) {
                            brushSupportViews.push({
                                points,
                                supportBox,
                                forward: [e[8], e[9], e[10]]
                            });
                        }
                        viewStats.push({
                            view_index: viewIndex,
                            fixture_index: evalCase.fixture_index,
                            captured_at: evalCase.captured_at,
                            prompt_type: evalCase.prompt?.type,
                            id: evalCase.id ?? evalCase.captured_at ?? `view-${viewIndex}`,
                            preview_image: viewImage,
                            bb2d: sanitized,
                            target_projected_bb2d: targetBb2d,
                            target_brush_metrics: targetBrushMetrics,
                            target_view_scorable: targetViewScorable,
                            target_view_scorable_reason: targetViewScorable ?
                                'ok' :
                                (targetBb2d ? 'prompt_target_coverage_low' : 'target_not_projected'),
                            support_count: surfaceEvidence.support.length,
                            core_support_count: surfaceEvidence.core_support.length,
                            anchor_count: surfaceEvidence.anchors.length,
                            anchor_hit_ratio: surfaceEvidence.anchor_hit_ratio,
                            support_box: supportBox,
                            fusion_support_included: includeInSupportFusion,
                            candidate_source: 'brush_support'
                        });
                        continue;
                    } else {
                        throw new Error(`Unsupported fusion source: ${source}`);
                    }

                    for (const candidate of projected) {
                        counts.set(candidate.splatIndex, (counts.get(candidate.splatIndex) ?? 0) + 1);
                        pointByIndex.set(candidate.splatIndex, candidate.point);
                    }
                    for (const candidate of frontSurface) {
                        frontCounts.set(candidate.splatIndex, (frontCounts.get(candidate.splatIndex) ?? 0) + 1);
                    }

                    viewStats.push({
                        view_index: viewIndex,
                        fixture_index: evalCase.fixture_index,
                        captured_at: evalCase.captured_at,
                        prompt_type: evalCase.prompt?.type,
                        id: evalCase.id ?? evalCase.captured_at ?? `view-${viewIndex}`,
                        preview_image: viewImage,
                        bb2d: sanitized,
                        padded_bb2d: padded,
                        projected_candidate_count: projected.length,
                        front_surface_candidate_count: frontSurface.length,
                        candidate_count: projected.length,
                        candidate_source: candidateSource
                    });
                }

                if (source === 'brush_support') {
                    const validViews = brushSupportViews.length;
                    const consistentViews = filterConsistentBrushSupportViews(brushSupportViews);
                    const scorableViews = viewStats.filter(stat => (
                        !('rejected' in stat) &&
                        (stat as { target_view_scorable?: boolean }).target_view_scorable
                    )).length;
                    if (consistentViews.length < 2) {
                        groupResults.push({
                            key,
                            target: group.target,
                            valid_views: validViews,
                            consistent_views: consistentViews.length,
                            scorable_views: scorableViews,
                            group_scorable: scorableViews >= 2,
                            min_views: 2,
                            selected_point_count: 0,
                            view_stats: viewStats,
                            error: validViews < 2 ? 'too-few-brush-support-views' : 'incoherent-brush-support-views'
                        });
                        continue;
                    }
                    const consensus = buildBrushSupportConsensusAabb(consistentViews);
                    const tight = buildBrushSupportTightAabb(consistentViews);
                    const clampedTight = clampTightAabbWithConsensusEdge(tight, consensus.aabb, consensus.ratio);
                    const supportIntersection = intersectAabbs(consistentViews
                    .map(view => view.supportBox)
                    .filter((box): box is Aabb => !!box));
                    const compactIntersection = supportIntersection &&
                        consistentViews.length <= 4 &&
                        !!consensus.aabb &&
                        consensus.ratio >= 0.75 ?
                        scaleAabbAxes(supportIntersection, [1.06, 0.98, 1.065]) :
                        null;
                    const chosenAabb = compactIntersection ??
                        (consensus.aabb && consensus.ratio >= 0.55 ? consensus.aabb : clampedTight.aabb);
                    const method = compactIntersection ?
                        'brush-support-compact-intersection' :
                        (consensus.aabb && consensus.ratio >= 0.55 ? 'brush-support-consensus' : (clampedTight.applied ? 'brush-support-tight-consensus-edge' : 'brush-support-tight'));
                    if (!chosenAabb) {
                        groupResults.push({
                            key,
                            target: group.target,
                            valid_views: validViews,
                            consistent_views: consistentViews.length,
                            scorable_views: scorableViews,
                            group_scorable: scorableViews >= 2,
                            min_views: 2,
                            selected_point_count: 0,
                            view_stats: viewStats,
                            consensus_overlap_ratio: consensus.ratio,
                            error: 'no-brush-support-fusion-box'
                        });
                        continue;
                    }
                    const obb = buildAxisAlignedObbFromAabbWithSource(chosenAabb, method, method);
                    groupResults.push({
                        key,
                        target: group.target,
                        valid_views: validViews,
                        consistent_views: consistentViews.length,
                        scorable_views: scorableViews,
                        group_scorable: scorableViews >= 2,
                        min_views: 2,
                        selected_point_count: consistentViews.reduce((sum, view) => sum + view.points.length, 0),
                        view_stats: viewStats,
                        consensus_overlap_ratio: consensus.ratio,
                        fusion_method: method,
                        consensus_aabb: consensus.aabb,
                        support_tight_aabb: tight,
                        support_tight_consensus_edge_aabb: clampedTight.aabb,
                        support_tight_consensus_edge: clampedTight.applied ? {
                            axis: clampedTight.axis,
                            side: clampedTight.side,
                            amount: clampedTight.amount
                        } : null,
                        support_intersection_aabb: supportIntersection,
                        compact_intersection_aabb: compactIntersection,
                        boxer_result: obb,
                        metrics: buildEvalMetrics(obb, group.target)
                    });
                    continue;
                }

                const validViews = viewStats.filter(stat => !('rejected' in stat)).length;
                const minViews = Math.max(1, Math.min(validViews, options.min_views ?? Math.ceil(validViews * 0.5)));
                const selectedPoints: [number, number, number][] = [];
                for (const [splatIndex, count] of counts) {
                    const hasFrontSurfaceHit = (frontCounts.get(splatIndex) ?? 0) > 0;
                    if (count >= minViews && (options.front_surface === false || hasFrontSurfaceHit)) {
                        const point = pointByIndex.get(splatIndex);
                        if (point) selectedPoints.push(point);
                    }
                }

                if (selectedPoints.length < 3) {
                    groupResults.push({
                        key,
                        target: group.target,
                        valid_views: validViews,
                        min_views: minViews,
                        selected_point_count: selectedPoints.length,
                        view_stats: viewStats,
                        error: 'too-few-fused-points'
                    });
                    continue;
                }

                const obb = buildAxisAlignedObbFromPoints(
                    selectedPoints,
                    options.quantile_low ?? 0.04,
                    options.quantile_high ?? 0.96,
                    source === 'click_cluster' ? 'multiview-click-cluster-carve' : 'multiview-target-box-carve'
                );
                groupResults.push({
                    key,
                    target: group.target,
                    valid_views: validViews,
                    min_views: minViews,
                    selected_point_count: selectedPoints.length,
                    point_count_by_view_threshold: Array.from({ length: validViews }, (_, idx) => {
                        const threshold = idx + 1;
                        let count = 0;
                        for (const value of counts.values()) if (value >= threshold) count++;
                        return { threshold, count };
                    }),
                    view_stats: viewStats,
                    boxer_result: obb,
                    metrics: buildEvalMetrics(obb, group.target)
                });
            }

            if (originalCamera) {
                applyCameraState(scene, originalCamera);
                await waitForNextRender(scene);
            }

            return {
                schema: 'boxer-multiview-fusion/v1',
                source,
                options: {
                    ...options,
                    source,
                    front_surface: options.front_surface !== false
                },
                groups: groupResults
            };
        };

        try {
            events.function('boxer.runDetectAll', async () => {
                if (busy) {
                    throw new Error('Still processing previous Boxer request');
                }

                busy = true;
                parent.style.cursor = 'wait';
                try {
                    return await executeDetectAll();
                } finally {
                    busy = false;
                    parent.style.cursor = '';
                }
            });
        } catch (err) {
            console.warn('[Boxer] boxer.runDetectAll was already registered', err);
        }

        try {
            events.function('boxer.runEvalFusion', async (payload: {
                cases: BoxerFusionEvalCase[];
                options?: BoxerFusionOptions;
            }) => {
                if (busy) {
                    throw new Error('Still processing previous Boxer request');
                }

                busy = true;
                parent.style.cursor = 'wait';
                try {
                    return await executeEvalFusion(payload.cases, payload.options ?? {});
                } finally {
                    busy = false;
                    parent.style.cursor = '';
                }
            });
        } catch (err) {
            console.warn('[Boxer] boxer.runEvalFusion was already registered', err);
        }

        const resolveCopyEvalCaseInput = (input?: BoxerCopyEvalCaseInput) => {
            const inputTarget = isBoxerEvalTarget(input) ? input : input?.target;
            const label = !isBoxerEvalTarget(input) ?
                (input?.target_label ?? input?.label ?? null) :
                null;
            const allowReuse = isBoxerEvalTarget(input) || input?.reuse_target !== false;

            if (inputTarget) {
                stickyEvalTarget = cloneEvalTarget(inputTarget);
                stickyEvalTargetLabel = label ?? stickyEvalTargetLabel;
                return {
                    target: stickyEvalTarget,
                    targetLabel: stickyEvalTargetLabel,
                    targetReused: false
                };
            }

            if (allowReuse && stickyEvalTarget) {
                return {
                    target: stickyEvalTarget,
                    targetLabel: label ?? stickyEvalTargetLabel,
                    targetReused: true
                };
            }

            return {
                target: null,
                targetLabel: label,
                targetReused: false
            };
        };

        const saveEvalCaseLocally = async (evalCase: Record<string, unknown>) => {
            // prefer the always-on eval-save-server; the sam3 dev proxy path
            // only exists when SAM3_BACKEND_URL points at localhost
            const urls = [
                getLocalEvalSaveUrl(),
                'http://127.0.0.1:48013/append'
            ].filter((url, index, all): url is string => !!url && all.indexOf(url) === index);

            const compactEvalCase = compactEvalCaseForLocalSave(evalCase);
            let lastError = 'No local eval save URL configured';
            for (const url of urls) {
                const controller = new AbortController();
                const timeout = window.setTimeout(() => controller.abort(), LOCAL_EVAL_SAVE_TIMEOUT_MS);
                try {
                    const response = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ eval_case: compactEvalCase }),
                        signal: controller.signal
                    });
                    const body = await response.json().catch((): null => null);
                    if (response.ok && body?.ok !== false) {
                        return body ?? { ok: true };
                    }
                    lastError = body?.error ?? `Local eval save failed with ${response.status} at ${url}`;
                } catch (err) {
                    lastError = err instanceof Error ? `${url}: ${err.message}` : `Local eval save failed at ${url}`;
                } finally {
                    window.clearTimeout(timeout);
                }
            }
            return {
                ok: false,
                error: lastError
            };
        };

        const copyEvalCase = async (input?: BoxerCopyEvalCaseInput) => {
            const result = (window as any).__lastBoxerResult as (OBBResult & { raw_boxer_result?: OBBResult } & Record<string, unknown>) | undefined;
            const clickDebug = (window as any).__lastBoxerClickDebug as BoxerClickDebugPanelState | undefined;
            if (!result || !lastEvalPrompt || !lastEvalFrame) {
                events.fire('toast', 'Run Boxer before copying an eval case', 'warning');
                return null;
            }

            const { target, targetLabel, targetReused } = resolveCopyEvalCaseInput(input);
            const resolvedLabel = targetLabel ?? (target ? result.label : null);
            if (target && resolvedLabel && !stickyEvalTargetLabel) stickyEvalTargetLabel = resolvedLabel;

            const splat = events.invoke('selection') as Splat | null;
            const loadUrls = new URLSearchParams(window.location.search).getAll('load');
            const copyCamera = events.invoke('camera.debugState') as CameraDebugState;
            const cameraChanged = cameraChangedSinceRun(lastEvalCamera, copyCamera);
            const resultTargetProjectedBb2d = (result as { target_projected_bb2d?: NormalizedBb2d | null }).target_projected_bb2d ?? null;
            const resultBb2dTargetMetrics = (result as { bb2d_target_metrics?: ReturnType<typeof buildBb2dTargetMetrics> }).bb2d_target_metrics ?? null;
            const promptBrush = 'brush' in lastEvalPrompt ? lastEvalPrompt.brush : undefined;
            const promptBb2d = promptBrush?.bb2d ??
                ('bb2d' in result && Array.isArray(result.bb2d) ? result.bb2d as NormalizedBb2d : null);
            const promptTargetMetrics = buildBb2dTargetMetrics(promptBb2d, resultTargetProjectedBb2d);
            const qualityWarnings: string[] = [];
            if (cameraChanged) qualityWarnings.push('camera-changed-after-run');
            if (target) {
                if (!resultTargetProjectedBb2d) {
                    qualityWarnings.push('target-not-visible-from-captured-camera');
                } else if (promptTargetMetrics && promptTargetMetrics.target_covered_by_bb2d < 0.65) {
                    qualityWarnings.push('prompt-target-2d-coverage-low');
                }
                if (resultBb2dTargetMetrics && resultBb2dTargetMetrics.bb2d_iou < 0.2) {
                    qualityWarnings.push('result-target-2d-overlap-low');
                }
            }
            const scorableReason = !target ?
                'no-target' :
                (!resultTargetProjectedBb2d ?
                    'target_not_projected' :
                    (promptTargetMetrics && promptTargetMetrics.target_covered_by_bb2d < 0.65 ?
                        'prompt_target_coverage_low' :
                        'ok'));
            const scorable = !target || scorableReason === 'ok';
            const blockingQualityWarnings = targetReused ?
                qualityWarnings.filter(warning => (
                    warning === 'target-not-visible-from-captured-camera' ||
                    warning === 'prompt-target-2d-coverage-low'
                )) :
                [];
            const evalQualityGate = {
                status: blockingQualityWarnings.length ? 'failed' : (qualityWarnings.length ? 'warning' : 'passed'),
                warnings: qualityWarnings,
                blocking_warnings: blockingQualityWarnings,
                scorable,
                scorable_reason: scorableReason,
                target_reused: targetReused,
                target_projected_bb2d: resultTargetProjectedBb2d,
                prompt_target_metrics: promptTargetMetrics,
                result_target_metrics: resultBb2dTargetMetrics
            };
            const evalCase = {
                schema: 'boxer-eval-case/v1',
                captured_at: new Date().toISOString(),
                page_url: window.location.href,
                backend_url: getBoxerBackendUrl(),
                scene: {
                    page_url: window.location.href,
                    default_load_url: window.supersplatConfig?.defaultLoadUrl ?? null,
                    load_urls: loadUrls
                },
                splat: splat ? {
                    name: splat.name,
                    filename: splat.filename,
                    num_splats: splat.numSplats
                } : null,
                prompt: lastEvalPrompt,
                camera: lastEvalCamera,
                copy_camera: copyCamera,
                camera_changed_since_boxer_run: cameraChanged,
                frame: lastEvalFrame,
                timing: clickDebug ? {
                    mode: clickDebug.mode,
                    total_ms: clickDebug.total_ms ?? null,
                    frame_ms: clickDebug.frame_ms ?? null,
                    backend_ms: clickDebug.backend_ms ?? null,
                    refine_ms: clickDebug.refine_ms ?? null,
                    draw_ms: clickDebug.draw_ms ?? null,
                    endpoint: clickDebug.endpoint ?? null,
                    depth_source: clickDebug.depth_source ?? null,
                    ray_sample_count: clickDebug.ray_sample_count ?? null,
                    ray_depth_stats: clickDebug.ray_depth_stats ?? null,
                    scale_runs: clickDebug.scale_runs ?? []
                } : null,
                raw_boxer_result: result.raw_boxer_result ?? null,
                boxer_result: result,
                target: target ? cloneEvalTarget(target) : null,
                target_label: resolvedLabel,
                target_reused: targetReused,
                eval_quality_gate: evalQualityGate,
                raw_metrics: result.raw_boxer_result ? buildEvalMetrics(result.raw_boxer_result, target) : null,
                metrics: buildEvalMetrics(result, target)
            };
            console.log('[Boxer] eval case', evalCase);
            if (evalQualityGate.status !== 'passed') {
                console.warn('[Boxer] eval quality gate warning', evalQualityGate);
            }
            const shouldSaveLocal = !isBoxerEvalTarget(input) && input?.save_local === true;
            const shouldCopyClipboard = isBoxerEvalTarget(input) || input?.copy_clipboard !== false;
            const localSave = shouldSaveLocal && evalQualityGate.status !== 'failed' ?
                await saveEvalCaseLocally(evalCase) :
                (shouldSaveLocal ? { ok: false, error: `eval quality gate failed: ${blockingQualityWarnings.map(formatEvalQualityWarning).join(', ')}` } : null);
            const shouldCopyFallback = shouldSaveLocal && localSave?.ok !== true;
            if (shouldCopyClipboard || shouldCopyFallback) {
                const clipboardCase = shouldSaveLocal ? compactEvalCaseForLocalSave(evalCase) : evalCase;
                const json = JSON.stringify(clipboardCase, null, 2);
                await navigator.clipboard.writeText(json).catch(() => {});
            }
            if (cameraChanged) {
                events.fire('toast', 'Camera changed after Boxer; rerun Boxer for this angle', 'warning');
            } else if (shouldSaveLocal && localSave?.ok === true) {
                if (evalQualityGate.status === 'passed') {
                    events.fire('toast', `Brush eval saved to ${localSave.file ?? 'local file'}`, 'info');
                } else {
                    const warningText = evalQualityGate.warnings.map(formatEvalQualityWarning).join(', ');
                    events.fire('toast', `Brush eval saved with warning: ${warningText}`, 'warning');
                }
            } else if (shouldSaveLocal) {
                if (evalQualityGate.status === 'failed') {
                    events.fire('toast', `Eval not saved: ${blockingQualityWarnings.map(formatEvalQualityWarning).join(', ')}. Save a fresh 4-click target for this view.`, 'warning');
                } else {
                    events.fire('toast', `Local save failed; eval copied instead (${localSave?.error ?? 'proxy unavailable'})`, 'warning');
                }
            } else if (targetReused) {
                if (evalQualityGate.status === 'passed') {
                    events.fire('toast', 'Boxer eval case copied with saved target', 'info');
                } else {
                    const warningText = evalQualityGate.warnings.map(formatEvalQualityWarning).join(', ');
                    events.fire('toast', `Boxer eval copied with warning: ${warningText}`, 'warning');
                }
            } else {
                if (target && evalQualityGate.status !== 'passed') {
                    const warningText = evalQualityGate.warnings.map(formatEvalQualityWarning).join(', ');
                    events.fire('toast', `Boxer eval copied with warning: ${warningText}`, 'warning');
                } else {
                    events.fire('toast', target ? 'Boxer eval case copied and target saved' : 'Boxer eval case copied without target', 'info');
                }
            }
            return evalCase;
        };

        try {
            events.function('boxer.copyEvalCase', copyEvalCase);
        } catch (err) {
            console.warn('[Boxer] boxer.copyEvalCase was already registered', err);
        }

        try {
            events.function('boxer.copyClickTestCase', copyEvalCase);
        } catch (err) {
            console.warn('[Boxer] boxer.copyClickTestCase was already registered', err);
        }

        try {
            events.function('boxer.getLastBrushPrompt', () => lastBrushPrompt);
        } catch (err) {
            console.warn('[Boxer] boxer.getLastBrushPrompt was already registered', err);
        }

        try {
            events.function('boxer.getLiveBrushFusionViews', () => liveBrushSupportViews.map((view, index) => ({
                index,
                live_id: view.live_id,
                created_at: view.created_at,
                point_count: view.points.length,
                support_count: view.support_count,
                support_box: view.supportBox,
                forward: view.forward,
                selected_source: view.selected_source
            })));
        } catch (err) {
            console.warn('[Boxer] boxer.getLiveBrushFusionViews was already registered', err);
        }

        try {
            events.function('boxer.getLiveBrushFusionStatus', () => getLiveBrushFusionStatus());
        } catch (err) {
            console.warn('[Boxer] boxer.getLiveBrushFusionStatus was already registered', err);
        }

        try {
            events.function('boxer.clearLiveBrushFusion', () => {
                liveBrushSupportViews.length = 0;
                lastLiveBrushFusionResult = null;
                publishLiveBrushFusionStatus();
                renderBrushPanel();
                events.fire('toast', 'Cleared live brush fusion memory', 'info');
                return true;
            });
        } catch (err) {
            console.warn('[Boxer] boxer.clearLiveBrushFusion was already registered', err);
        }

        try {
            events.function('boxer.runLastBrush', runLastBrushBoxer);
        } catch (err) {
            console.warn('[Boxer] boxer.runLastBrush was already registered', err);
        }

        try {
            events.function('boxer.copyLastBrushEvalCase', async (input?: BoxerCopyEvalCaseInput) => {
                if (!lastBrushReplay) {
                    const replay = await runLastBrushBoxer(input);
                    if (!replay) return null;
                }
                return copyEvalCase(input);
            });
        } catch (err) {
            console.warn('[Boxer] boxer.copyLastBrushEvalCase was already registered', err);
        }

        try {
            events.function('boxer.setStickyEvalTarget', (input?: BoxerCopyEvalCaseInput) => {
                const target = isBoxerEvalTarget(input) ?
                    input :
                    (input?.target ?? events.invoke('boxSelection.currentBox') as BoxerEvalTarget | null);
                if (!isBoxerEvalTarget(target)) {
                    events.fire('toast', 'No manual eval target to save', 'warning');
                    return null;
                }
                stickyEvalTarget = cloneEvalTarget(target);
                stickyEvalTargetLabel = isBoxerEvalTarget(input) ? stickyEvalTargetLabel : (input?.target_label ?? input?.label ?? stickyEvalTargetLabel);
                renderBrushPanel();
                events.fire('toast', 'Saved Boxer eval target', 'info');
                return {
                    target: cloneEvalTarget(stickyEvalTarget),
                    label: stickyEvalTargetLabel
                };
            });
        } catch (err) {
            console.warn('[Boxer] boxer.setStickyEvalTarget was already registered', err);
        }

        try {
            events.function('boxer.clearEvalTarget', () => {
                stickyEvalTarget = null;
                stickyEvalTargetLabel = null;
                renderBrushPanel();
                events.fire('toast', 'Saved Boxer eval target cleared', 'info');
                return true;
            });
        } catch (err) {
            console.warn('[Boxer] boxer.clearEvalTarget was already registered', err);
        }

        try {
            events.function('boxer.currentEvalTarget', () => ({
                target: stickyEvalTarget ? cloneEvalTarget(stickyEvalTarget) : null,
                label: stickyEvalTargetLabel
            }));
        } catch (err) {
            console.warn('[Boxer] boxer.currentEvalTarget was already registered', err);
        }

        // Draw the OBB wireframe every frame while it is set.
        // WebGL gl.lineWidth is capped at 1, so fake thickness by offsetting
        // each edge along camera-relative right/up axes and redrawing.
        const thickOffsets: [number, number][] = [
            [0, 0],
            [1, 0], [-1, 0], [0, 1], [0, -1],
            [1, 1], [-1, 1], [1, -1], [-1, -1]
        ];
        const tmpA = new Vec3();
        const tmpB = new Vec3();
        const right = new Vec3();
        const up = new Vec3();

        const executeClick = async (
            clickX: number,
            clickY: number,
            target?: BoxerEvalTarget | null,
            options?: { useSam?: boolean }
        ) => {
            const t0 = performance.now();
            const splat = (events.invoke('selection') as Splat | null) ??
                ((events.invoke('scene.splats') as Splat[] | undefined)?.[0] ?? null);
            if (!splat) {
                throw new Error('No splat loaded');
            }

            const { frame, depthBuffer } = await buildBoxerFramePayload(events, scene, splat, canvas);
            const tFrame = performance.now();
            publishBoxerFrameDebug(frame);
            lastEvalPrompt = { type: options?.useSam ? 'click_sam' : 'click', click_xy: [clickX, clickY] };
            lastEvalFrame = summarizeFrameForEval(frame);
            lastEvalCamera = events.invoke('camera.debugState') as CameraDebugState;
            logClickDepthProbe(splat, depthBuffer, frame.image_width, frame.image_height, clickX, clickY);

            const boxerBackendUrl = getBoxerBackendUrl();
            const res = await postBoxerDetect(boxerBackendUrl, frame, { click_xy: [clickX, clickY] });
            const tBackend = performance.now();

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(`Boxer backend ${res.status}: ${err.error || res.statusText}`);
            }

            const obb = await res.json() as BoxerResponse;
            const rawObb = cloneObb(obb);
            if (obb.candidates || obb.proposals || obb.detections) {
                console.log('[Boxer] response candidates', {
                    candidates: obb.candidates?.length ?? 0,
                    proposals: obb.proposals?.length ?? 0,
                    detections: obb.detections?.length ?? 0
                });
            }
            console.log(`[Boxer] ${obb.label} (${(obb.confidence * 100).toFixed(0)}%) dims=${obb.dimensions.map(d => d.toFixed(2)).join(',')}`);

            const bb2d = normalizeBb2d(obb, frame.image_width, frame.image_height, clickX, clickY);
            if (!bb2d && obb.bb2d) {
                console.warn('[Boxer] backend returned an invalid bb2d', obb.bb2d);
            }
            const targetProjectedBb2d = projectedTargetBb2d(target, scene, frame.intrinsics);

            let sam3Region: Sam3MaskRegion | null = null;
            let sam3Debug: Sam3MaskDebug | undefined;
            if (options?.useSam) {
                sam3Debug = { attempts: [] };
                sam3Region = await fetchSam3ClickMaskRegion(frame, splat, scene, clickX, clickY, sam3Debug);
            }

            const geometryRefinement = refineObbFromBoxedPoints(
                obb,
                frame,
                splat,
                scene,
                bb2d,
                { click_xy: [clickX, clickY], depthBuffer },
                sam3Region
            );
            if (geometryRefinement.applied && geometryRefinement.dimensions) {
                console.log(
                    `[Boxer] geometry refined from ${geometryRefinement.point_count} splat points` +
                    ` dims=${geometryRefinement.dimensions.map(d => d.toFixed(2)).join(',')}`
                );
            }
            const rayDebug = bb2d ? buildMultiRayDepthDebug(frame, depthBuffer, bb2d, { x: clickX, y: clickY }) : null;

            const R = obb.rotation;
            const axes = ['X', 'Y', 'Z'];
            const fmt = (v: number) => (v >= 0 ? ' ' : '') + v.toFixed(2);
            console.log(`[Boxer] R row0=(${fmt(R[0][0])},${fmt(R[0][1])},${fmt(R[0][2])})`);
            console.log(`[Boxer] R row1=(${fmt(R[1][0])},${fmt(R[1][1])},${fmt(R[1][2])})`);
            console.log(`[Boxer] R row2=(${fmt(R[2][0])},${fmt(R[2][1])},${fmt(R[2][2])})`);
            for (let j = 0; j < 3; j++) {
                const cx_ = R[0][j], cy_ = R[1][j], cz_ = R[2][j];
                const absV = [Math.abs(cx_), Math.abs(cy_), Math.abs(cz_)];
                const dom = absV.indexOf(Math.max(...absV));
                console.log(`[Boxer] OBB local ${axes[j]} (len=${obb.dimensions[j].toFixed(2)}) -> world (${fmt(cx_)},${fmt(cy_)},${fmt(cz_)}) ≈ ${R[dom][j] > 0 ? '+' : '-'}${axes[dom]}`);
            }

            const recenter = geometryRefinement.applied ?
                { applied: false, reason: 'geometry-refined' } :
                await maybeRecenterObb(scene, obb, frame, depthBuffer, bb2d, clickX, clickY);
            const tRefine = performance.now();
            if (recenter.applied && recenter.shift && recenter.shift_length !== undefined) {
                console.log(
                    `[Boxer] reposition: source=${recenter.source}` +
                    ` shift=(${recenter.shift.map(v => v.toFixed(2)).join(',')})` +
                    ` len=${recenter.shift_length.toFixed(2)}`
                );
            } else {
                console.warn(`[Boxer] not repositioning: ${recenter.reason}`, recenter);
            }

            publishBoxerResultDebug(obb, rawObb, bb2d, recenter, geometryRefinement);
            (window as any).__lastBoxerResult.target_projected_bb2d = targetProjectedBb2d;
            (window as any).__lastBoxerResult.bb2d_target_metrics = buildBb2dTargetMetrics(bb2d, targetProjectedBb2d);
            (window as any).__lastBoxerResult.ray_debug = rayDebug ? {
                requested_count: rayDebug.requested_count,
                sample_count: rayDebug.samples.length,
                depth_stats: rayDebug.stats,
                samples: rayDebug.samples.slice(0, 24)
            } : null;
            if (sam3Debug) {
                (window as any).__lastBoxerResult.sam3_augmentation = {
                    applied: geometryRefinement.reason === 'sam3-click-mask-connected-region',
                    region: sam3Region ? {
                        mask_bb2d: sam3Region.mask_bb2d,
                        point_count: sam3Region.point_count,
                        projected_candidate_count: sam3Region.projected_candidate_count,
                        front_surface_candidate_count: sam3Region.front_surface_candidate_count,
                        mask_area_ratio: sam3Region.mask_area_ratio
                    } : null,
                    debug: sam3Debug
                };
            }
            currentCorners = buildWireframeCorners(obb);
            const selectionTruth = await applyBoxerObbSelection(obb);
            (window as any).__lastBoxerResult.selection_truth = selectionTruth;
            const finalProjectedBb2d = projectResultTo2D(obb, frame);
            const overlayLayers: BoxerOverlayLayer[] = [];
            if (finalProjectedBb2d) {
                overlayLayers.push({
                    bb2d: finalProjectedBb2d,
                    label: `final ${obb.label}`,
                    color: '#ff9f1a',
                    width: 3
                });
            }
            if (bb2d) {
                overlayLayers.push({
                    bb2d,
                    label: `raw 2d ${obb.label}`,
                    color: '#ff4fd8',
                    dash: '5 5',
                    width: 2
                });
            }
            show2DBoxLayers(overlayLayers);
            const tDone = performance.now();
            updateDebugPanel({
                mode: options?.useSam ? 'select+sam' : 'select',
                endpoint: `${boxerBackendUrl}/api/boxer-detect`,
                label: obb.label,
                confidence: obb.confidence,
                total_ms: tDone - t0,
                frame_ms: tFrame - t0,
                backend_ms: tBackend - tFrame,
                refine_ms: tRefine - tBackend,
                draw_ms: tDone - tRefine,
                image: frame.image,
                image_width: frame.image_width,
                image_height: frame.image_height,
                depth_source: frame.depth_source,
                bb2d,
                selected_splat_count: selectionTruth.selected_after,
                candidate_count: (obb.candidates?.length ?? 0) + (obb.detections?.length ?? 0),
                proposal_count: obb.proposals?.length,
                ray_sample_count: rayDebug?.samples.length,
                ray_depth_stats: rayDebug?.stats ?? undefined,
                candidates: [
                    ...((obb.candidates ?? []) as any[]),
                    ...((obb.detections ?? []) as any[])
                ].slice(0, 8).map(candidate => ({
                    label: candidate?.label,
                    score: candidate?.score ?? candidate?.score2d,
                    confidence: candidate?.confidence,
                    bb2d: Array.isArray(candidate?.bb2d) ? candidate.bb2d : null
                }))
            });

            return {
                camera: lastEvalCamera,
                frame: lastEvalFrame,
                raw_boxer_result: rawObb,
                boxer_result: (window as any).__lastBoxerResult,
                target: target ?? null,
                raw_metrics: buildEvalMetrics(rawObb, target),
                metrics: buildEvalMetrics(obb, target)
            };
        };

        try {
            events.function('boxer.runEvalCase', async (evalCase: {
                camera: CameraDebugState;
                frame?: { image_width?: number; image_height?: number };
                prompt: BoxerEvalPrompt;
                target?: BoxerEvalTarget | null;
                live_brush_fusion?: boolean;
            }) => {
                if (busy) {
                    throw new Error('Still processing previous Boxer request');
                }
                if (
                    evalCase.prompt?.type !== 'click' &&
                    evalCase.prompt?.type !== 'click_sam' &&
                    evalCase.prompt?.type !== 'client_click' &&
                    evalCase.prompt?.type !== 'client_brush' &&
                    evalCase.prompt?.type !== 'client_brush_floor_snap' &&
                    evalCase.prompt?.type !== 'brush_sam' &&
                    evalCase.prompt?.type !== 'brush_sam_clean' &&
                    evalCase.prompt?.type !== 'brush_boxer' &&
                    evalCase.prompt?.type !== 'brush_fused' &&
                    evalCase.prompt?.type !== 'detect_all_click' &&
                    evalCase.prompt?.type !== 'direct_lift_click' &&
                    evalCase.prompt?.type !== 'lift_target_box' &&
                    evalCase.prompt?.type !== 'client_lift_target_box' &&
                    evalCase.prompt?.type !== 'lift_box'
                ) {
                    throw new Error('Only click, click_sam, client_click, client_brush, client_brush_floor_snap, brush_sam, brush_sam_clean, detect_all_click, direct_lift_click, lift_target_box, client_lift_target_box, and lift_box eval cases can be replayed right now');
                }

                busy = true;
                parent.style.cursor = 'wait';
                try {
                    applyCameraState(scene, evalCase.camera);
                    await waitForNextRender(scene);

                    const sourceWidth = evalCase.frame?.image_width ?? canvas.clientWidth;
                    const sourceHeight = evalCase.frame?.image_height ?? canvas.clientHeight;
                    const scaleX = canvas.clientWidth / sourceWidth;
                    const scaleY = canvas.clientHeight / sourceHeight;
                    const click = 'click_xy' in evalCase.prompt && evalCase.prompt.click_xy ? {
                        x: Math.round(evalCase.prompt.click_xy[0] * scaleX),
                        y: Math.round(evalCase.prompt.click_xy[1] * scaleY)
                    } : null;
                    const scaleBrush = (brush?: BoxerBrushPrompt): BoxerBrushPrompt | undefined => {
                        if (!brush) return undefined;
                        return {
                            ...brush,
                            ...(brush.center_xy ? {
                                center_xy: [
                                    Math.round(brush.center_xy[0] * scaleX),
                                    Math.round(brush.center_xy[1] * scaleY)
                                ] as [number, number]
                            } : {}),
                            ...(brush.radius !== undefined ? { radius: brush.radius * Math.max(scaleX, scaleY) } : {}),
                            ...(brush.width !== undefined ? { width: brush.width * scaleX } : {}),
                            ...(brush.height !== undefined ? { height: brush.height * scaleY } : {}),
                            ...(brush.bb2d ? {
                                bb2d: [
                                    brush.bb2d[0] * scaleX,
                                    brush.bb2d[1] * scaleY,
                                    brush.bb2d[2] * scaleX,
                                    brush.bb2d[3] * scaleY
                                ] as NormalizedBb2d
                            } : {}),
                            ...(brush.points ? {
                                points: brush.points.map(point => [
                                    Math.round(point[0] * scaleX),
                                    Math.round(point[1] * scaleY)
                                ] as [number, number])
                            } : {}),
                            ...(brush.pad !== undefined ? { pad: brush.pad * Math.max(scaleX, scaleY) } : {})
                        };
                    };
                    let replay: any;
                    if (evalCase.prompt.type === 'client_click' && click) {
                        replay = await executeClientClick(click.x, click.y, evalCase.target ?? null);
                    } else if (evalCase.prompt.type === 'client_brush') {
                        const brushPrompt = evalCase.prompt as Extract<BoxerEvalPrompt, { type: 'client_brush' }>;
                        replay = await executeClientBrush(
                            scaleBrush(brushPrompt.brush),
                            click ? [click.x, click.y] : undefined,
                            evalCase.target ?? null,
                            { liveFusion: evalCase.live_brush_fusion === true }
                        );
                    } else if (evalCase.prompt.type === 'client_brush_floor_snap') {
                        const brushPrompt = evalCase.prompt as Extract<BoxerEvalPrompt, { type: 'client_brush_floor_snap' }>;
                        replay = await executeClientBrush(
                            scaleBrush(brushPrompt.brush),
                            click ? [click.x, click.y] : undefined,
                            evalCase.target ?? null,
                            { floorSnap: true, liveFusion: false }
                        );
                    } else if (evalCase.prompt.type === 'brush_sam') {
                        const brushPrompt = evalCase.prompt as Extract<BoxerEvalPrompt, { type: 'brush_sam' }>;
                        replay = await executeClientBrush(
                            scaleBrush(brushPrompt.brush),
                            click ? [click.x, click.y] : undefined,
                            evalCase.target ?? null,
                            { useSam: true, liveFusion: false }
                        );
                    } else if (evalCase.prompt.type === 'brush_sam_clean') {
                        const brushPrompt = evalCase.prompt as Extract<BoxerEvalPrompt, { type: 'brush_sam_clean' }>;
                        replay = await executeClientBrush(
                            scaleBrush(brushPrompt.brush),
                            click ? [click.x, click.y] : undefined,
                            evalCase.target ?? null,
                            { samClean: true, liveFusion: false }
                        );
                    } else if (evalCase.prompt.type === 'brush_fused') {
                        const brushPrompt = evalCase.prompt as Extract<BoxerEvalPrompt, { type: 'brush_fused' }>;
                        replay = await executeBrushFused(
                            scaleBrush(brushPrompt.brush),
                            click ? [click.x, click.y] : undefined,
                            evalCase.target ?? null,
                            {
                                boxernet_world_scale: brushPrompt.boxernet_world_scale,
                                fuse_mode: brushPrompt.fuse_mode
                            }
                        );
                    } else if (evalCase.prompt.type === 'brush_boxer') {
                        const brushPrompt = evalCase.prompt as Extract<BoxerEvalPrompt, { type: 'brush_boxer' }>;
                        replay = await executeBrushBoxer(
                            scaleBrush(brushPrompt.brush),
                            click ? [click.x, click.y] : undefined,
                            evalCase.target ?? null,
                            {
                                boxernet_world_scale: brushPrompt.boxernet_world_scale,
                                boxernet_world_scales: brushPrompt.boxernet_world_scales,
                                refinement_mode: brushPrompt.refinement_mode,
                                preprocess_mode: brushPrompt.preprocess_mode,
                                object_crop: brushPrompt.object_crop
                            }
                        );
                    } else if (evalCase.prompt.type === 'detect_all_click' && click) {
                        const detectAll = await executeDetectAll({ x: click.x, y: click.y, target: evalCase.target ?? null });
                        const top = detectAll.top_detection as {
                            raw?: OBBResult;
                            refined?: OBBResult;
                            geometry_refinement?: GeometryRefinement;
                        } | null;
                        if (!top?.refined) {
                            throw new Error('Detect-all click did not produce a selectable detection');
                        }

                        const boxerResult = {
                            ...top.refined,
                            geometry_refinement: top.geometry_refinement,
                            raw_boxer_result: top.raw
                        };
                        replay = {
                            boxer_result: boxerResult,
                            raw_boxer_result: top.raw,
                            metrics: buildEvalMetrics(top.refined, evalCase.target),
                            raw_metrics: buildEvalMetrics(top.raw, evalCase.target),
                            detect_all_probe: detectAll
                        };
                    } else if (evalCase.prompt.type === 'direct_lift_click' && click) {
                        const directPrompt = evalCase.prompt as Extract<BoxerEvalPrompt, { type: 'direct_lift_click' }>;
                        const splat = (events.invoke('selection') as Splat | null) ??
                            ((events.invoke('scene.splats') as Splat[] | undefined)?.[0] ?? null);
                        if (!splat) throw new Error('No splat loaded');
                        const { frame, depthBuffer } = await buildBoxerFramePayload(events, scene, splat, canvas);
                        const proposalBuild = await buildDirectLiftClickProposals(
                            frame,
                            depthBuffer,
                            splat,
                            scene,
                            click.x,
                            click.y,
                            directPrompt.use_sam !== false
                        );
                        replay = await executeDirectLift(
                            proposalBuild.proposals,
                            { ...directPrompt, click_xy: [click.x, click.y] },
                            evalCase.target ?? null,
                            click,
                            directPrompt.preprocess_mode ?? 'full_frame',
                            proposalBuild.debug,
                            directPrompt.depth_mode ?? 'dense',
                            directPrompt.geometry_mode ?? 'global',
                            directPrompt.boxernet_world_scale,
                            directPrompt.refinement_mode ?? 'auto',
                            directPrompt.gravity,
                            directPrompt.object_crop
                        );
                    } else if (evalCase.prompt.type === 'client_lift_target_box') {
                        if (!evalCase.target) throw new Error('client_lift_target_box eval case requires target');
                        const clientPrompt = evalCase.prompt as Extract<BoxerEvalPrompt, { type: 'client_lift_target_box' }>;
                        const scaledClick = clientPrompt.click_xy ? {
                            x: Math.round(clientPrompt.click_xy[0] * scaleX),
                            y: Math.round(clientPrompt.click_xy[1] * scaleY)
                        } : undefined;
                        replay = await executeClientTargetLift(
                            evalCase.target,
                            { ...clientPrompt, click_xy: scaledClick ? [scaledClick.x, scaledClick.y] : undefined }
                        );
                    } else if (evalCase.prompt.type === 'lift_target_box') {
                        if (!evalCase.target) throw new Error('lift_target_box eval case requires target');
                        const targetBb = projectedTargetBb2d(
                            evalCase.target,
                            scene,
                            extractIntrinsics(scene.camera.camera, canvas.clientWidth, canvas.clientHeight)
                        );
                        const bb = targetBb ? sanitizeBb2d(targetBb, canvas.clientWidth, canvas.clientHeight) : null;
                        if (!bb) throw new Error('lift_target_box target does not project into the current view');
                        const targetPrompt = evalCase.prompt as Extract<BoxerEvalPrompt, { type: 'lift_target_box' }>;
                        const scaledClick = targetPrompt.click_xy ? {
                            x: Math.round(targetPrompt.click_xy[0] * scaleX),
                            y: Math.round(targetPrompt.click_xy[1] * scaleY)
                        } : undefined;
                        replay = await executeDirectLift(
                            [{
                                id: 'manual-target-projection',
                                bb2d: bb,
                                score2d: 1,
                                source: 'manual'
                            }],
                            { ...targetPrompt, click_xy: scaledClick ? [scaledClick.x, scaledClick.y] : undefined },
                            evalCase.target,
                            scaledClick,
                            targetPrompt.preprocess_mode ?? 'full_frame',
                            {
                                fixed_count: 0,
                                final_count: 1,
                                sources: { manual: 1 }
                            },
                            targetPrompt.depth_mode ?? 'dense',
                            targetPrompt.geometry_mode ?? 'global',
                            targetPrompt.boxernet_world_scale,
                            targetPrompt.refinement_mode ?? 'auto',
                            targetPrompt.gravity,
                            targetPrompt.object_crop
                        );
                    } else if (evalCase.prompt.type === 'lift_box') {
                        const liftPrompt = evalCase.prompt as Extract<BoxerEvalPrompt, { type: 'lift_box' }>;
                        const bb = sanitizeBb2d([
                            liftPrompt.bb2d[0] * scaleX,
                            liftPrompt.bb2d[1] * scaleY,
                            liftPrompt.bb2d[2] * scaleX,
                            liftPrompt.bb2d[3] * scaleY
                        ], canvas.clientWidth, canvas.clientHeight);
                        if (!bb) throw new Error('lift_box eval case has invalid bb2d');
                        const scaledClick = liftPrompt.click_xy ? {
                            x: Math.round(liftPrompt.click_xy[0] * scaleX),
                            y: Math.round(liftPrompt.click_xy[1] * scaleY)
                        } : undefined;
                        replay = await executeDirectLift(
                            [{
                                id: 'manual-lift-box',
                                bb2d: bb,
                                score2d: 1,
                                source: 'manual'
                            }],
                            { ...liftPrompt, bb2d: bb, click_xy: scaledClick ? [scaledClick.x, scaledClick.y] : undefined },
                            evalCase.target ?? null,
                            scaledClick,
                            liftPrompt.preprocess_mode ?? 'full_frame',
                            undefined,
                            liftPrompt.depth_mode ?? 'dense',
                            liftPrompt.geometry_mode ?? 'global',
                            liftPrompt.boxernet_world_scale,
                            liftPrompt.refinement_mode ?? 'auto',
                            liftPrompt.gravity,
                            liftPrompt.object_crop
                        );
                    } else if (click && evalCase.prompt.type === 'click_sam') {
                        replay = await executeClick(click.x, click.y, evalCase.target ?? null, {
                            useSam: true
                        });
                    } else if (click) {
                        replay = await executeClientClick(click.x, click.y, evalCase.target ?? null);
                    } else {
                        throw new Error('click eval case is missing click_xy');
                    }

                    return {
                        schema: 'boxer-eval-replay/v1',
                        source_prompt: evalCase.prompt,
                        replay_prompt: (replay.boxer_result as any)?.direct_lift ?
                            lastEvalPrompt :
                            (click ? { type: evalCase.prompt.type, click_xy: [click.x, click.y] } : lastEvalPrompt),
                        source_canvas: { width: sourceWidth, height: sourceHeight },
                        replay_canvas: { width: canvas.clientWidth, height: canvas.clientHeight },
                        ...replay
                    };
                } finally {
                    busy = false;
                    parent.style.cursor = '';
                }
            });
        } catch (err) {
            console.warn('[Boxer] boxer.runEvalCase was already registered', err);
        }

        try {
            // Non-destructive preview for the eval case editor: apply the case
            // camera, then overlay the recorded stroke/click, the projected
            // target box, and the target wireframe in 3D. Runs no geometry.
            events.function('boxer.previewEvalCase', async (evalCase: {
                camera: CameraDebugState;
                frame?: { image_width?: number; image_height?: number };
                prompt?: BoxerEvalPrompt;
                target?: BoxerEvalTarget | null;
            }) => {
                applyCameraState(scene, evalCase.camera);
                await waitForNextRender(scene);

                const sourceWidth = evalCase.frame?.image_width ?? canvas.clientWidth;
                const sourceHeight = evalCase.frame?.image_height ?? canvas.clientHeight;
                const scaleX = canvas.clientWidth / Math.max(1, sourceWidth);
                const scaleY = canvas.clientHeight / Math.max(1, sourceHeight);
                const intrinsics = extractIntrinsics(scene.camera.camera, canvas.clientWidth, canvas.clientHeight);
                const layers: BoxerOverlayLayer[] = [];

                const target = evalCase.target ?? null;
                const targetBb = projectedTargetBb2d(target, scene, intrinsics);
                if (targetBb) {
                    layers.push({ bb2d: targetBb, label: 'target', color: '#3dff7b', width: 2 });
                }

                const prompt = evalCase.prompt;
                const brush = prompt && 'brush' in prompt ? prompt.brush : undefined;
                if (brush?.bb2d) {
                    layers.push({
                        bb2d: [
                            brush.bb2d[0] * scaleX,
                            brush.bb2d[1] * scaleY,
                            brush.bb2d[2] * scaleX,
                            brush.bb2d[3] * scaleY
                        ],
                        label: 'brush bb',
                        color: '#00d2ff',
                        dash: '5 5',
                        width: 1
                    });
                }
                if (brush?.points?.length) {
                    layers.push({
                        label: 'stroke',
                        color: '#ff9f1a',
                        width: Math.max(3, (brush.radius ?? 8) * 2 * scaleX),
                        points: brush.points.map(point => [point[0] * scaleX, point[1] * scaleY] as [number, number])
                    });
                }
                const click = prompt && 'click_xy' in prompt && prompt.click_xy ? prompt.click_xy : null;
                if (click) {
                    const cx = click[0] * scaleX;
                    const cy = click[1] * scaleY;
                    layers.push({
                        bb2d: [cx - 6, cy - 6, cx + 6, cy + 6],
                        label: 'click',
                        color: '#ff4fd8',
                        width: 2
                    });
                }

                show2DBoxLayers(layers);
                currentCorners = target ?
                    buildWireframeCorners({ center: target.center, dimensions: target.dimensions, rotation: target.rotation } as OBBResult) :
                    null;
                scene.forceRender = true;

                return {
                    target_projected_bb2d: targetBb,
                    has_stroke: !!brush?.points?.length,
                    has_click: !!click
                };
            });
        } catch (err) {
            console.warn('[Boxer] boxer.previewEvalCase was already registered', err);
        }

        scene.app.on('update', () => {
            if (!currentCorners) return;

            const camTransform = scene.camera.mainCamera.getWorldTransform();
            camTransform.getX(right);
            camTransform.getY(up);

            // world-space thickness ≈ 0.3% of nearest edge length, min 5 mm
            const dx = currentCorners[0].distance(currentCorners[1]);
            const t = Math.max(0.005, dx * 0.02);

            for (const [ox, oy] of thickOffsets) {
                const offX = right.x * ox * t + up.x * oy * t;
                const offY = right.y * ox * t + up.y * oy * t;
                const offZ = right.z * ox * t + up.z * oy * t;
                for (const [a, b] of OBB_EDGES) {
                    tmpA.set(
                        currentCorners[a].x + offX,
                        currentCorners[a].y + offY,
                        currentCorners[a].z + offZ
                    );
                    tmpB.set(
                        currentCorners[b].x + offX,
                        currentCorners[b].y + offY,
                        currentCorners[b].z + offZ
                    );
                    scene.app.drawLine(tmpA, tmpB, OBB_COLOR, true, scene.worldLayer);
                }
            }
            scene.forceRender = true;
        });

        const handler = async (e: PointerEvent) => {
            if (!this.active) return;
            if (e.target !== canvas) return;
            if (busy) {
                events.fire('toast', 'Still processing previous click', 'info');
                return;
            }
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();

            const splat = events.invoke('selection') as Splat;
            if (!splat) {
                console.warn('[Boxer] No splat selected');
                events.fire('toast', 'No splat loaded', 'warning');
                return;
            }

            const rect = canvas.getBoundingClientRect();
            const clickX = Math.round(e.clientX - rect.left);
            const clickY = Math.round(e.clientY - rect.top);

            busy = true;
            parent.style.cursor = 'wait';

            try {
                await executeClientClick(clickX, clickY, stickyEvalTarget ? cloneEvalTarget(stickyEvalTarget) : null);
            } catch (err) {
                console.error('[Boxer] Request failed:', err);
                events.fire('toast', 'Boxer request failed', 'error');
            } finally {
                busy = false;
                parent.style.cursor = '';
            }
        };

        const textHandler = async (text: string) => {
            if (!this.active || busy) return;

            const splat = events.invoke('selection') as Splat;
            if (!splat) {
                events.fire('toast', 'No splat loaded', 'warning');
                return;
            }

            busy = true;
            parent.style.cursor = 'wait';

            try {
                const { frame } = await buildBoxerFramePayload(events, scene, splat, canvas);
                publishBoxerFrameDebug(frame);
                lastEvalPrompt = { type: 'text', text };
                lastEvalFrame = summarizeFrameForEval(frame);
                lastEvalCamera = events.invoke('camera.debugState') as CameraDebugState;

                console.log(`[Boxer] text="${text}"`);
                const boxerBackendUrl = getBoxerBackendUrl();
                const res = await postBoxerDetect(boxerBackendUrl, frame, { text });

                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    console.error(`[Boxer] text ${res.status}: ${err.error || res.statusText}`);
                    events.fire('toast', 'Boxer backend error', 'error');
                    return;
                }

                const obb = await res.json() as BoxerResponse;
                const rawObb = cloneObb(obb);
                if (obb.candidates || obb.proposals || obb.detections) {
                    console.log('[Boxer] text response candidates', {
                        candidates: obb.candidates?.length ?? 0,
                        proposals: obb.proposals?.length ?? 0,
                        detections: obb.detections?.length ?? 0
                    });
                }
                console.log(`[Boxer] text: ${obb.label} (${(obb.confidence * 100).toFixed(0)}%) dims=${obb.dimensions.map(d => d.toFixed(2)).join(',')}`);

                const bb2d = normalizeBb2d(obb, frame.image_width, frame.image_height);
                if (bb2d) {
                    show2DBox(bb2d, `${obb.label} ${(obb.confidence * 100).toFixed(0)}%`);
                } else if (obb.bb2d) {
                    console.warn('[Boxer] backend returned an invalid text bb2d', obb.bb2d);
                }
                const geometryRefinement = refineObbFromBoxedPoints(obb, frame, splat, scene, bb2d);
                if (geometryRefinement.applied && geometryRefinement.dimensions) {
                    console.log(
                        `[Boxer] text geometry refined from ${geometryRefinement.point_count} splat points` +
                        ` dims=${geometryRefinement.dimensions.map(d => d.toFixed(2)).join(',')}`
                    );
                }
                publishBoxerResultDebug(
                    obb,
                    rawObb,
                    bb2d,
                    { applied: false, reason: 'text-query-no-recenter' },
                    geometryRefinement
                );

                currentCorners = buildWireframeCorners(obb);
                const selectionTruth = await applyBoxerObbSelection(obb);
                (window as any).__lastBoxerResult.selection_truth = selectionTruth;
            } catch (err) {
                console.error('[Boxer] Text request failed:', err);
                events.fire('toast', 'Boxer text request failed', 'error');
            } finally {
                busy = false;
                parent.style.cursor = '';
            }
        };

        this.activate = () => {
            this.active = true;
            parent.style.cursor = 'crosshair';
            parent.addEventListener('pointerdown', handler, true);
            events.on('ai.textQuery', textHandler);
        };

        this.deactivate = () => {
            this.active = false;
            parent.style.cursor = '';
            parent.removeEventListener('pointerdown', handler, true);
            events.off('ai.textQuery', textHandler);
            currentCorners = null;
            hide2DBox();
            debugPanel.style.display = 'none';
            brushPanel.style.display = 'none';
            scene.forceRender = true;
        };
    }
}

export { BoxerSelection };
