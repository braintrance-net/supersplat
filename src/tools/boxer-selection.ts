import { Color, Vec3 } from 'playcanvas';

import { Events } from '../events';
import { Scene } from '../scene';
import { Splat } from '../splat';

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
const DEFAULT_SAM3_BACKEND_URL = 'https://sam3.4dream.app';
const SAM3_REQUEST_TIMEOUT_MS = 1800;
const SAM3_MAX_IMAGE_SIDE = 960;
const MASK_OCCLUSION_CELL_PX = 4;
const MASK_OCCLUSION_FRAC_OF_DEPTH = 0.015;
const MASK_OCCLUSION_MIN_M = 0.015;
const MASK_OCCLUSION_MAX_M = 0.12;

const PRODUCTION_BOXER_PROXY_URL = '/api/boxer';

const getBoxerBackendUrl = () => {
    const configured = window.supersplatConfig?.boxerBackendUrl?.trim();
    if (configured) {
        return configured.replace(/\/$/, '');
    }

    if (/^board-demo-editor(?:-[a-z0-9-]+)?\.vercel\.app$/i.test(window.location.hostname)) {
        return PRODUCTION_BOXER_PROXY_URL;
    }

    return 'https://boxer.4dream.app';
};

const getBoxerGpuDepthEnabled = () => window.supersplatConfig?.boxerGpuDepth === true;

const getSam3BackendUrl = () => {
    return window.supersplatConfig?.sam3BackendUrl?.trim() || DEFAULT_SAM3_BACKEND_URL;
};

const getSam3FetchCredentials = (sam3BackendUrl: string): 'same-origin' | 'include' => {
    if (!window.supersplatConfig?.sam3BackendUrl?.trim()) {
        return 'same-origin';
    }

    try {
        return new URL(sam3BackendUrl, window.location.href).origin === window.location.origin ? 'same-origin' : 'include';
    } catch {
        return 'same-origin';
    }
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
    depth_source: 'gpu-splat-footprint' | 'cpu-center-zbuffer';
    geometry_cache_count?: number;
    geometry_cache_ms?: number;
    geometry_cache_reused?: boolean;
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
    bb2d: NormalizedBb2d;
    label: string;
    color: string;
    dash?: string;
    width?: number;
};
type BoxerEvalPrompt =
    { type: 'click'; click_xy: [number, number] } |
    { type: 'click_sam'; click_xy: [number, number] } |
    { type: 'client_click'; click_xy: [number, number] } |
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
} | null;
type BoxerFusionEvalCase = {
    id?: string;
    captured_at?: string;
    camera: CameraDebugState;
    frame?: { image_width?: number; image_height?: number };
    prompt?: BoxerEvalPrompt;
    target?: BoxerEvalTarget | null;
};
type BoxerFusionOptions = {
    source?: 'target_box' | 'click_cluster';
    min_views?: number;
    front_surface?: boolean;
    pad_scale?: number;
    quantile_low?: number;
    quantile_high?: number;
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

const splatWorldCenterCaches = new WeakMap<Splat, SplatWorldCenterCache>();

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
    const centers = cache.worldCenters;
    const view = scene.camera.camera.viewMatrix.data as Float32Array;
    const scaleX = maskWidth / imageWidth;
    const scaleY = maskHeight / imageHeight;
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
        if (u < 0 || u >= imageWidth || v < 0 || v >= imageHeight) continue;

        const maskX = Math.min(maskWidth - 1, Math.max(0, Math.round(u * scaleX)));
        const maskY = Math.min(maskHeight - 1, Math.max(0, Math.round(v * scaleY)));
        if (mask[maskY * maskWidth + maskX] === 0) continue;

        candidates.push({
            point: [wx, wy, wz],
            splatIndex: i,
            world: [wx, wy, wz],
            pixel: [u, v],
            depth: cvZ,
            in_frame: true
        });
    }

    return candidates;
};

const fetchSam3ClickMaskRegion = async (
    frame: BoxerFramePayload,
    splat: Splat,
    scene: Scene,
    clickX: number,
    clickY: number,
    debug?: Sam3MaskDebug
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

    const refineBody = {
        image: resized.image,
        object_id: 1,
        frame_index: 0,
        clear_old_points: true,
        coordinate_space: 'normalized',
        image_size: { width: resized.width, height: resized.height },
        points: [normalizedClick],
        labels: [1]
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

        if (res.status === 404 || res.status === 405 || res.status === 501) {
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
            error?: string;
        };

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
                const pointForm = new FormData();
                pointForm.append('job_id', uploadData.job_id);
                pointForm.append('x', String(Math.round(clickX * resized.scale)));
                pointForm.append('y', String(Math.round(clickY * resized.scale)));
                pointForm.append('label', '1');
                const pointRes = await fetch(`${sam3BackendUrl}/segment_point`, {
                    method: 'POST',
                    credentials: getSam3FetchCredentials(sam3BackendUrl),
                    body: pointForm,
                    signal: controller.signal
                });
                const pointData = await pointRes.json().catch(() => ({})) as {
                    masks?: { mask_image?: string }[];
                    detail?: string;
                };
                const maskImage = pointData.masks?.[0]?.mask_image;
                debug?.attempts.push({
                    endpoint: '/segment_point',
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

    const depthT0 = performance.now();
    const gpuDepthEnabled = getBoxerGpuDepthEnabled();
    const gpuDepthBuffer = gpuDepthEnabled ? await renderGpuSplatDepth(splat, scene, imageWidth, imageHeight) : null;
    const gpuDepthSummary = gpuDepthBuffer ? summarizeDepth(gpuDepthBuffer) : null;
    const useGpuDepth = gpuDepthSummary && gpuDepthSummary.valid >= 1000;
    const cpuDepthBuffer = useGpuDepth ? null : renderSplatDepth(splat, scene, imageWidth, imageHeight, intrinsics);
    const depthSource: BoxerFramePayload['depth_source'] = useGpuDepth ?
        'gpu-splat-footprint' :
        'cpu-center-zbuffer';
    const backendDepthBuffer = useGpuDepth && gpuDepthBuffer ? gpuDepthBuffer : cpuDepthBuffer!;
    const geometryDepthBuffer = backendDepthBuffer;
    const depthSummary = summarizeDepth(backendDepthBuffer);
    const sdpPatchDepths = buildSdpPatchDepths(backendDepthBuffer);
    const depth = includeEncodedDepth ? float32ToBase64(backendDepthBuffer.data) : '';
    const depthMs = performance.now() - depthT0;

    const pointsT0 = performance.now();
    let pointCloudSource: BoxerFramePayload['point_cloud_source'] = 'front_surface_centers';
    let sdpPoints = sampleSplatSurfacePoints(splat, scene, imageWidth, imageHeight, intrinsics, geometryDepthBuffer);
    if (sdpPoints.length < Math.min(1000, MAX_SDP_POINTS / 4)) {
        pointCloudSource = 'frustum_centers';
        sdpPoints = sampleSplatCentersInFrustum(splat, scene);
    }
    const projectionSamples = buildProjectionSamples(sdpPoints, scene, intrinsics);
    const pointsMs = performance.now() - pointsT0;

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
    console.log(`[Boxer] frame ${imageWidth}x${imageHeight}` +
        ` depth=${backendDepthBuffer.width}x${backendDepthBuffer.height}` +
        ` source=${depthSource}` +
        ` valid=${depthSummary.valid}/${backendDepthBuffer.data.length}` +
        ` (${(depthSummary.ratio * 100).toFixed(1)}%)` +
        ` range=${depthSummary.min.toFixed(2)}..${depthSummary.max.toFixed(2)}` +
        `${gpuFallbackSummary}` +
        ` cache=${geometryCacheReused ? 'hit' : 'build'}:${geometryCache?.count ?? 0}` +
        `/${geometryCacheMs.toFixed(0)}ms` +
        ` sdp=${sdpPoints.length} source=${pointCloudSource}` +
        ` patches=${sdpPatchDepths.valid}/${sdpPatchDepths.data.length}` +
        ` samples=${projectionSamples.filter(s => s.in_frame).length}/${projectionSamples.length}` +
        ` (${depthMs.toFixed(0)}ms depth + ${pointsMs.toFixed(0)}ms points)`);

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
    return {
        bb2d_iou: bb2dIou(bb2d, targetBb2d),
        center_distance_px: Math.hypot(center[0] - targetCenter[0], center[1] - targetCenter[1]),
        center_distance_target_diag_ratio: Math.hypot(center[0] - targetCenter[0], center[1] - targetCenter[1]) / targetDiag,
        area_ratio_to_target: (
            (bb2d[2] - bb2d[0]) * (bb2d[3] - bb2d[1])
        ) / Math.max(1, (targetBb2d[2] - targetBb2d[0]) * (targetBb2d[3] - targetBb2d[1]))
    };
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
    const selectedCluster = local.cluster.length >= 24 ?
        local.cluster :
        (depthWindow.length >= 24 ? depthWindow : local.supportCandidates);
    const clusterBb = bboxFromProjectedCandidates(selectedCluster, frame.image_width, frame.image_height);
    if (!clusterBb || selectedCluster.length < 8) {
        throw new Error(`client_click found too few local points (${selectedCluster.length}; connected ${local.cluster.length})`);
    }

    const depthComponent = depthConnectedBb2d(depthBuffer, frame.image_width, frame.image_height, clickX, clickY, clickDepth);
    const candidateBbs: { scale: number; bb: NormalizedBb2d; source: 'splat_cluster' | 'depth_component' }[] = [];
    const addCandidateBb = (
        scale: number,
        bb: NormalizedBb2d | null,
        source: 'splat_cluster' | 'depth_component'
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
            [];
        const baseCandidates = frontSurface.length >= 24 ? frontSurface : projected;
        const candidateDepthBand = Math.min(1.15, Math.max(0.28, clickDepth * (source === 'depth_component' ? 0.055 : 0.04)));
        const depthConsistent = baseCandidates.filter(candidate => Math.abs(candidate.depth - clickDepth) <= candidateDepthBand);
        const summaryCandidates = depthConsistent.length >= 24 ? depthConsistent : baseCandidates;
        const points = summaryCandidates.map(candidate => candidate.point);
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
            selection_score: projectionFit.best_score + Math.log10(Math.max(10, points.length)) * 0.015 + depthSupportBonus - clickCenterPenalty * 0.2 - focusOffsetPenalty - weakDepthPenalty - areaPenalty - tinyAreaPenalty - smallScalePenalty - brokenConnectivityDepthPenalty - scalePenalty - extentPenalty - relaxedDepthPenalty - sparseDepthPenalty +
                (source === 'depth_component' ? 0.06 : 0)
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
            local_candidate_count: local.localCandidateCount,
            front_surface_candidate_count: local.frontSurfaceCandidateCount,
            cluster_point_count: selectedCluster.length,
            connected_cluster_point_count: local.cluster.length,
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
        let lastEvalFrame: ReturnType<typeof summarizeFrameForEval> | null = null;
        let lastEvalCamera: CameraDebugState | null = null;
        let stickyEvalTarget: BoxerEvalTarget | null = null;
        let stickyEvalTargetLabel: string | null = null;

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

        const clear2DBoxLayers = () => {
            while (svg.firstChild) svg.removeChild(svg.firstChild);
        };

        const show2DBoxLayers = (layers: BoxerOverlayLayer[]) => {
            clear2DBoxLayers();
            const visibleLayers = layers.filter(layer => layer.bb2d);
            if (visibleLayers.length === 0) {
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
            clear2DBoxLayers();
            svg.style.display = 'none';
        };
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

        const fmtMs = (value?: number) => Number.isFinite(value) ? `${Math.round(value!)}ms` : '-';
        const fmtNum = (value?: number, digits = 2) => Number.isFinite(value) ? value!.toFixed(digits) : '-';
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
                <div>overlay orange=final 3D projection · pink=raw 2D evidence</div>
                <div>frame ${fmtMs(state.frame_ms)} · backend ${fmtMs(state.backend_ms)} · refine ${fmtMs(state.refine_ms)} · draw ${fmtMs(state.draw_ms)}</div>
                <div>${state.endpoint ?? ''}</div>
                <div>proposals ${state.proposal_count ?? '-'} · candidates ${state.candidate_count ?? '-'}</div>
                <div>${rayStats}</div>
                <div style="display:flex;gap:6px;margin-top:8px;">
                    <button type="button" data-boxer-copy-eval style="font:inherit;padding:4px 7px;border:1px solid rgba(255,255,255,.28);border-radius:4px;background:rgba(255,255,255,.12);color:inherit;">Copy Eval</button>
                    <button type="button" data-boxer-clear-target style="font:inherit;padding:4px 7px;border:1px solid rgba(255,255,255,.28);border-radius:4px;background:rgba(255,255,255,.08);color:inherit;">Clear Target</button>
                </div>
                ${scaleRows ? `<hr style="border:0;border-top:1px solid rgba(255,255,255,.18);margin:8px 0;" />${scaleRows}` : ''}
                ${candidateRows ? `<hr style="border:0;border-top:1px solid rgba(255,255,255,.18);margin:8px 0;" />${candidateRows}` : ''}
            `;
            debugPanel.querySelector<HTMLButtonElement>('[data-boxer-copy-eval]')?.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
                void events.invoke('boxer.copyClickTestCase');
            });
            debugPanel.querySelector<HTMLButtonElement>('[data-boxer-clear-target]')?.addEventListener('pointerdown', (e) => {
                e.stopPropagation();
                void events.invoke('boxer.clearEvalTarget');
            });
            debugPanel.style.display = '';
            events.fire('boxer.debugUpdated', state);
        };
        try {
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

            let { frame, depthBuffer } = await buildBoxerFramePayload(events, scene, splat, canvas);
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
                .map(scale => typeof scale === 'number' && Number.isFinite(scale) ? scale : undefined)
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
            scene.forceRender = true;
            events.fire('select.byOBB', 'set', topObb);
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
            scene.forceRender = true;
            events.fire('select.byOBB', 'set', obb);

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
            scene.forceRender = true;
            events.fire('select.byOBB', 'set', obb);
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
                            selected = (localFrontSurface.length >= 24 ? localFrontSurface : localProjected).filter((candidate) => (
                                Math.hypot(candidate.pixel[0] - clickX, candidate.pixel[1] - clickY) <= pixelRadius &&
                                Math.abs(candidate.depth - clickDepth) <= depthBand
                            ));
                            sanitized = bboxFromProjectedCandidates(selected, frame.image_width, frame.image_height);
                            candidateSource = 'click_depth_window';
                        }
                        if (!sanitized || selected.length < 24) {
                            viewStats.push({
                                view_index: viewIndex,
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
            const allowReuse = !isBoxerEvalTarget(input) && input?.reuse_target === false ? false : true;

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
                raw_metrics: result.raw_boxer_result ? buildEvalMetrics(result.raw_boxer_result, target) : null,
                metrics: buildEvalMetrics(result, target)
            };
            const json = JSON.stringify(evalCase, null, 2);
            console.log('[Boxer] eval case', evalCase);
            await navigator.clipboard.writeText(json).catch(() => {});
            if (cameraChanged) {
                events.fire('toast', 'Camera changed after Boxer; rerun Boxer for this angle', 'warning');
            } else if (targetReused) {
                events.fire('toast', 'Boxer eval case copied with saved target', 'info');
            } else {
                events.fire('toast', target ? 'Boxer eval case copied and target saved' : 'Boxer eval case copied without target', 'info');
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
            scene.forceRender = true;
            events.fire('select.byOBB', 'set', obb);
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
            }) => {
                if (busy) {
                    throw new Error('Still processing previous Boxer request');
                }
                if (
                    evalCase.prompt?.type !== 'click' &&
                    evalCase.prompt?.type !== 'click_sam' &&
                    evalCase.prompt?.type !== 'client_click' &&
                    evalCase.prompt?.type !== 'detect_all_click' &&
                    evalCase.prompt?.type !== 'direct_lift_click' &&
                    evalCase.prompt?.type !== 'lift_target_box' &&
                    evalCase.prompt?.type !== 'client_lift_target_box' &&
                    evalCase.prompt?.type !== 'lift_box'
                ) {
                    throw new Error('Only click, click_sam, client_click, detect_all_click, direct_lift_click, lift_target_box, client_lift_target_box, and lift_box eval cases can be replayed right now');
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
                    let replay: any;
                    if (evalCase.prompt.type === 'client_click' && click) {
                        replay = await executeClientClick(click.x, click.y, evalCase.target ?? null);
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
                scene.forceRender = true;
                events.fire('select.byOBB', 'set', obb);
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
            scene.forceRender = true;
        };
    }
}

export { BoxerSelection };
