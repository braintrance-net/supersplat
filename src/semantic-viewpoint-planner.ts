import { Vec3 } from 'playcanvas';

import { Events } from './events';
import { Scene } from './scene';
import { Splat } from './splat';
import { State } from './splat-state';

const DEFAULT_HELPER_BUDGET = 30;
const DEFAULT_REVIEW_FRAME_BUDGET = 10;
const MAX_HELPER_BUDGET = 200;
const SAMPLE_TARGET = 90000;
const GRID_WIDTH = 24;
const GRID_HEIGHT = 14;
const EPSILON = 1e-6;
const MAX_FRONTIER_DEPTH = 2;
const COLLISION_MAX_RAY_STEPS = 80;
const VISIBILITY_SAMPLE_TARGET = 64;
const FRONT_SURFACE_GRID_WIDTH = 64;
const FRONT_SURFACE_GRID_HEIGHT = 36;
const FRONT_SURFACE_SAMPLE_TARGET = 96;
const FRONT_SURFACE_SCENE_DEPTH_SAMPLE_TARGET = 4000;
const FRONT_SURFACE_TARGET_DEPTH_SAMPLE_TARGET = 4000;
const TARGET_ORBIT_FRONT_SURFACE_HARD_REJECT_RATIO = 0.01;
const TARGET_ORBIT_FRONT_SURFACE_WEAK_TARGET_VISIBILITY = 0.62;
const TARGET_ORBIT_FRONT_SURFACE_WEAK_SAMPLE_VISIBILITY = 0.5;
const TARGET_ORBIT_CANONICAL_MIN_TARGET_VISIBILITY = 0.72;
const TARGET_ORBIT_CANONICAL_MIN_SAMPLE_VISIBILITY = 0.64;
const TARGET_ORBIT_CANONICAL_MIN_FRONT_SURFACE_VISIBILITY = 0.2;
const TARGET_ORBIT_CANONICAL_HARD_MIN_TARGET_VISIBILITY = 0.12;
const TARGET_ORBIT_CANONICAL_HARD_MIN_SAMPLE_VISIBILITY = 0.08;
const TARGET_ORBIT_CANONICAL_HARD_MIN_FRONT_SURFACE_VISIBILITY = 0.015;
const DENSITY_FALLBACK_ANCHOR_TARGET = 2600;
const DENSITY_FALLBACK_MIN_POINTS = 48;
const DENSITY_FALLBACK_POSITION_COUNT = 36;
const TARGET_ORBIT_SCREEN_FRACTION = 0.62;
const SEED_LOCAL_SCREEN_FRACTION = 0.62;

type CameraDebugState = {
    position: { x: number, y: number, z: number };
    target: { x: number, y: number, z: number };
    fov: number;
    azim: number;
    elevation: number;
    distance: number;
    ortho?: boolean;
};

type PlannerDecision = 'accepted' | 'rejected' | 'helper';

type PlannerScores = {
    final: number;
    depthCoverage: number;
    centerCoverage: number;
    gridCoverage: number;
    noHitRatio: number;
    edgeHitRatio: number;
    nearClipRatio: number;
    depthVariety: number;
    structure: number;
    image: number;
    novelty: number;
};

type PlannerGeometry = {
    sampleGrid: [number, number];
    validHits: number;
    occupiedCells: number;
    centerDepth: number;
    depthQuantiles: {
        min: number;
        p25: number;
        median: number;
        p75: number;
        max: number;
    };
    robustBoundsId: string;
};

type PlannerNavigation = {
    generation: number;
    surfaceDepth?: number;
    stepDistance?: number;
    clearance?: number;
};

type PlannerCollision = {
    provider: 'splat-transform-voxel' | 'density-aware-fallback';
    cellSize: number;
    asset?: string;
    cameraClearance: number;
    minCameraClearance: number;
    centerHitDistance: number;
    minCenterHitDistance: number;
    maxCenterHitDistance: number;
    targetVisibilityRatio: number;
    targetVisibleRays: number;
    targetRayCount: number;
    nearestTargetHitDistance: number;
    sampleVisibilityRatio: number;
    visibleSamples: number;
    visibilitySampleCount: number;
    nearestSampleHitDistance: number;
    frontSurfaceVisibleRatio: number;
    frontSurfaceInFrameRatio: number;
    frontSurfaceVisibleInFrameRatio: number;
    frontSurfaceVisibleSamples: number;
    frontSurfaceInFrameSamples: number;
    frontSurfaceSampleCount: number;
    rejected: boolean;
    reasons: string[];
};

type PlannerCapture = {
    mode?: 'normal' | 'debug';
    recommended: boolean;
    captured: boolean;
    reasons: string[];
};

type PlannerFrameMetadata = {
    version: string;
    role: 'seed' | 'yaw-sweep' | 'frontier' | 'orbit' | 'density';
    stationId: string;
    parentStationId?: string;
    branch: {
        parentViewId?: string;
        label: string;
        yawDegrees: number;
        pitchDegrees: number;
        move?: 'forward' | 'backward' | 'left' | 'right';
    };
    decision: PlannerDecision;
    badges: string[];
    scores: PlannerScores;
    geometry: PlannerGeometry;
    navigation: PlannerNavigation;
    collision?: PlannerCollision;
    capture?: PlannerCapture;
    reasons: string[];
};

type PlannedCameraView = {
    viewId: string;
    label: string;
    camera: CameraDebugState;
    planner: PlannerFrameMetadata;
};

type PlannerOptions = {
    helperBudget?: number;
    maxReviewFrames?: number;
    targetBounds?: PlannerTargetBounds | null;
    targetSplat?: Splat | null;
    targetIndexRanges?: [number, number][] | null;
    originalCamera?: CameraDebugState | null;
};

type SplatSample = {
    x: number;
    y: number;
    z: number;
};

type RobustBounds = {
    id: string;
    center: Vec3;
    halfExtents: Vec3;
    radius: number;
    min: Vec3;
    max: Vec3;
};

type PlannerTargetBounds = {
    center: { x: number; y: number; z: number };
    min?: { x: number; y: number; z: number };
    max?: { x: number; y: number; z: number };
    radius?: number;
};

type Station = {
    id: string;
    label: string;
    position: Vec3;
    azim: number;
    elevation: number;
    distanceWorld: number;
    fov: number;
    ortho?: boolean;
    role: PlannerFrameMetadata['role'];
    parentStationId?: string;
    parentViewId?: string;
    move?: 'forward' | 'backward' | 'left' | 'right';
    generation: number;
    stepDistance?: number;
    surfaceDepth?: number;
    clearance?: number;
};

type Candidate = Station & {
    viewId: string;
    yawOffset: number;
    pitchOffset: number;
    parentViewId?: string;
    edgeLabel: string;
    viewRole: PlannerFrameMetadata['role'];
    target?: Vec3;
};

type EvaluatedCandidate = PlannedCameraView & {
    lookDirection: Vec3;
    position: Vec3;
    generation: number;
};

type CollisionProbe = PlannerCollision & {
    penalty: number;
};

type CollisionContext = {
    fallbackReason?: string;
    probe: (position: Vec3, target: Vec3, bounds: RobustBounds, scene: Scene, visibilitySamples?: SplatSample[], sceneSamples?: SplatSample[]) => CollisionProbe;
};

type VoxelMeta = {
    version: string;
    gridBounds: { min: number[]; max: number[] };
    voxelResolution: number;
    leafSize: number;
    treeDepth: number;
    nodeCount: number;
    leafDataCount: number;
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const round3 = (value: number) => Math.round(value * 1000) / 1000;

const vectorFromDebug = (value: { x: number, y: number, z: number }) => new Vec3(value.x, value.y, value.z);

const debugFromPose = (
    scene: Scene,
    position: Vec3,
    target: Vec3,
    base: Pick<CameraDebugState, 'fov' | 'ortho'>
): CameraDebugState => {
    const look = new Vec3().sub2(target, position);
    const distanceWorld = Math.max(EPSILON, look.length());
    const azim = Math.atan2(-look.x / distanceWorld, -look.z / distanceWorld) * 180 / Math.PI;
    const elevation = Math.asin(look.y / distanceWorld) * 180 / Math.PI;
    const distance = distanceWorld / Math.max(EPSILON, scene.camera.sceneRadius) * Math.max(EPSILON, scene.camera.fovFactor);

    return {
        position: { x: position.x, y: position.y, z: position.z },
        target: { x: target.x, y: target.y, z: target.z },
        fov: base.fov,
        azim,
        elevation,
        distance,
        ortho: base.ortho
    };
};

const calcOrbitVector = (azim: number, elev: number) => {
    const ex = elev * Math.PI / 180;
    const ey = azim * Math.PI / 180;
    const s1 = Math.sin(-ex);
    const c1 = Math.cos(-ex);
    const s2 = Math.sin(-ey);
    const c2 = Math.cos(-ey);
    return new Vec3(-c1 * s2, s1, c1 * c2);
};

const lookDirectionFromAngles = (azim: number, elev: number) => calcOrbitVector(azim, elev).mulScalar(-1).normalize();

const targetFromStation = (station: Station, yawOffset: number, pitchOffset: number) => {
    const direction = lookDirectionFromAngles(station.azim + yawOffset, station.elevation + pitchOffset);
    return new Vec3().copy(station.position).add(direction.mulScalar(station.distanceWorld));
};

const distanceBetween = (a: Vec3, b: Vec3) => new Vec3().sub2(a, b).length();

const crossVec = (a: Vec3, b: Vec3) => new Vec3(
    a.y * b.z - a.z * b.y,
    a.z * b.x - a.x * b.z,
    a.x * b.y - a.y * b.x
);

const quantile = (sorted: number[], q: number) => {
    if (sorted.length === 0) return 0;
    const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q)));
    return sorted[index];
};

const percentileBounds = (samples: SplatSample[]): RobustBounds | null => {
    if (samples.length < 16) {
        return null;
    }

    const xs = samples.map(sample => sample.x).sort((a, b) => a - b);
    const ys = samples.map(sample => sample.y).sort((a, b) => a - b);
    const zs = samples.map(sample => sample.z).sort((a, b) => a - b);
    const min = new Vec3(quantile(xs, 0.02), quantile(ys, 0.02), quantile(zs, 0.02));
    const max = new Vec3(quantile(xs, 0.98), quantile(ys, 0.98), quantile(zs, 0.98));
    const center = new Vec3().add2(min, max).mulScalar(0.5);
    const halfExtents = new Vec3().sub2(max, min).mulScalar(0.5);
    const pad = Math.max(0.05, halfExtents.length() * 0.08);
    halfExtents.x += pad;
    halfExtents.y += pad;
    halfExtents.z += pad;

    const paddedMin = new Vec3(center.x - halfExtents.x, center.y - halfExtents.y, center.z - halfExtents.z);
    const paddedMax = new Vec3(center.x + halfExtents.x, center.y + halfExtents.y, center.z + halfExtents.z);

    return {
        id: `p02-p98-${samples.length}`,
        center,
        halfExtents,
        radius: Math.max(0.1, halfExtents.length()),
        min: paddedMin,
        max: paddedMax
    };
};

const fallbackBounds = (scene: Scene): RobustBounds => {
    const bound = scene.bound;
    const center = bound.center.clone();
    const halfExtents = bound.halfExtents.clone();
    const min = new Vec3(center.x - halfExtents.x, center.y - halfExtents.y, center.z - halfExtents.z);
    const max = new Vec3(center.x + halfExtents.x, center.y + halfExtents.y, center.z + halfExtents.z);

    return {
        id: 'scene-bound',
        center,
        halfExtents,
        radius: Math.max(0.1, halfExtents.length()),
        min,
        max
    };
};

const finiteVec = (value?: { x: number; y: number; z: number }) => {
    return !!value && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
};

const targetBoundsToRobustBounds = (target?: PlannerTargetBounds | null): RobustBounds | null => {
    if (!target || !finiteVec(target.center)) {
        return null;
    }

    const center = vectorFromDebug(target.center);
    const hasExtents = finiteVec(target.min) && finiteVec(target.max);
    const min = hasExtents ? vectorFromDebug(target.min!) : center.clone();
    const max = hasExtents ? vectorFromDebug(target.max!) : center.clone();
    const halfExtents = new Vec3().sub2(max, min).mulScalar(0.5);
    const rawRadius = Number.isFinite(target.radius) && target.radius! > 0 ? target.radius! : halfExtents.length();
    const radius = Math.max(0.08, rawRadius);
    const pad = Math.max(0.05, radius * 0.2);

    halfExtents.x = Math.max(halfExtents.x + pad, radius * 0.18);
    halfExtents.y = Math.max(halfExtents.y + pad, radius * 0.18);
    halfExtents.z = Math.max(halfExtents.z + pad, radius * 0.18);

    return {
        id: 'artisan-target-bounds',
        center,
        halfExtents,
        radius: Math.max(radius + pad, halfExtents.length()),
        min: new Vec3(center.x - halfExtents.x, center.y - halfExtents.y, center.z - halfExtents.z),
        max: new Vec3(center.x + halfExtents.x, center.y + halfExtents.y, center.z + halfExtents.z)
    };
};

const collectSplatSamples = (events: Events, scene: Scene): SplatSample[] => {
    const splats = events.invoke('scene.splats') as Splat[];
    const totalSplats = splats.reduce((total, splat) => total + splat.splatData.numSplats, 0);
    const stride = Math.max(1, Math.floor(totalSplats / SAMPLE_TARGET));
    const samples: SplatSample[] = [];

    for (const splat of splats) {
        const sorter: { centers?: Float32Array } | undefined = splat.entity.gsplat?.instance?.sorter;
        const centers = sorter?.centers;
        if (!centers) {
            continue;
        }

        const state = splat.splatData.getProp('state') as Uint8Array | undefined;
        const matrix = splat.entity.getWorldTransform().data as Float32Array;
        const count = centers.length / 3;

        for (let i = 0; i < count; i += stride) {
            if (state && (state[i] & State.deleted) !== 0) {
                continue;
            }

            const lx = centers[i * 3];
            const ly = centers[i * 3 + 1];
            const lz = centers[i * 3 + 2];
            samples.push({
                x: matrix[0] * lx + matrix[4] * ly + matrix[8] * lz + matrix[12],
                y: matrix[1] * lx + matrix[5] * ly + matrix[9] * lz + matrix[13],
                z: matrix[2] * lx + matrix[6] * ly + matrix[10] * lz + matrix[14]
            });
        }
    }

    if (samples.length > SAMPLE_TARGET) {
        const stride = samples.length / SAMPLE_TARGET;
        return Array.from({ length: SAMPLE_TARGET }, (_, index) => samples[Math.floor(index * stride)]);
    }

    return samples;
};

const collectIndexedSplatSamples = (splat?: Splat | null, ranges?: [number, number][] | null): SplatSample[] => {
    if (!splat || !ranges?.length) {
        return [];
    }

    const sorter: { centers?: Float32Array } | undefined = splat.entity.gsplat?.instance?.sorter;
    const centers = sorter?.centers;
    if (!centers) {
        return [];
    }

    const state = splat.splatData.getProp('state') as Uint8Array | undefined;
    const matrix = splat.entity.getWorldTransform().data as Float32Array;
    const count = centers.length / 3;
    const samples: SplatSample[] = [];

    for (const [start, end] of ranges) {
        const first = Math.max(0, Math.min(count - 1, Math.floor(start)));
        const last = Math.max(first, Math.min(count - 1, Math.floor(end)));
        for (let i = first; i <= last; i++) {
            if (state && (state[i] & State.deleted) !== 0) {
                continue;
            }

            const lx = centers[i * 3];
            const ly = centers[i * 3 + 1];
            const lz = centers[i * 3 + 2];
            samples.push({
                x: matrix[0] * lx + matrix[4] * ly + matrix[8] * lz + matrix[12],
                y: matrix[1] * lx + matrix[5] * ly + matrix[9] * lz + matrix[13],
                z: matrix[2] * lx + matrix[6] * ly + matrix[10] * lz + matrix[14]
            });
        }
    }

    if (samples.length <= SAMPLE_TARGET) {
        return samples;
    }

    const stride = samples.length / SAMPLE_TARGET;
    return Array.from({ length: SAMPLE_TARGET }, (_, index) => samples[Math.floor(index * stride)]);
};

const buildViewProjection = (scene: Scene) => {
    const camera = scene.camera.camera;
    const projection = camera.projectionMatrix.data as Float32Array;
    const view = camera.viewMatrix.data as Float32Array;
    const vp = new Float32Array(16);

    for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
            vp[i + j * 4] =
                projection[i] * view[j * 4] +
                projection[i + 4] * view[j * 4 + 1] +
                projection[i + 8] * view[j * 4 + 2] +
                projection[i + 12] * view[j * 4 + 3];
        }
    }

    return { view, vp };
};

const projectSample = (sample: SplatSample, view: Float32Array, vp: Float32Array) => {
    const cx = vp[0] * sample.x + vp[4] * sample.y + vp[8] * sample.z + vp[12];
    const cy = vp[1] * sample.x + vp[5] * sample.y + vp[9] * sample.z + vp[13];
    const cw = vp[3] * sample.x + vp[7] * sample.y + vp[11] * sample.z + vp[15];
    if (cw <= EPSILON) {
        return null;
    }

    const ndcX = cx / cw;
    const ndcY = cy / cw;
    if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) {
        return null;
    }

    const ogZ = view[2] * sample.x + view[6] * sample.y + view[10] * sample.z + view[14];
    const depth = -ogZ;
    if (depth <= EPSILON) {
        return null;
    }

    return {
        cellX: Math.max(0, Math.min(FRONT_SURFACE_GRID_WIDTH - 1, Math.floor((ndcX * 0.5 + 0.5) * FRONT_SURFACE_GRID_WIDTH))),
        cellY: Math.max(0, Math.min(FRONT_SURFACE_GRID_HEIGHT - 1, Math.floor((1 - (ndcY * 0.5 + 0.5)) * FRONT_SURFACE_GRID_HEIGHT))),
        depth
    };
};

const frontDepthTolerance = (depth: number) => Math.min(0.18, Math.max(0.025, depth * 0.025));

const nearestDepthAround = (nearestDepth: Float32Array, cellX: number, cellY: number) => {
    let nearest = Infinity;

    for (let dy = -1; dy <= 1; dy++) {
        const y = cellY + dy;
        if (y < 0 || y >= FRONT_SURFACE_GRID_HEIGHT) continue;

        for (let dx = -1; dx <= 1; dx++) {
            const x = cellX + dx;
            if (x < 0 || x >= FRONT_SURFACE_GRID_WIDTH) continue;
            nearest = Math.min(nearest, nearestDepth[y * FRONT_SURFACE_GRID_WIDTH + x]);
        }
    }

    return nearest;
};

const forEachStridedSample = (
    samples: SplatSample[],
    targetCount: number,
    callback: (sample: SplatSample) => void
) => {
    const count = Math.min(samples.length, targetCount);
    if (count <= 0) {
        return;
    }

    const stride = samples.length / count;
    for (let i = 0; i < count; i++) {
        callback(samples[Math.floor(i * stride)]);
    }
};

const probeSelectedFrontSurface = (
    scene: Scene,
    targetSamples: SplatSample[],
    sceneSamples: SplatSample[]
) => {
    const sampleCount = Math.min(targetSamples.length, FRONT_SURFACE_SAMPLE_TARGET);
    if (sampleCount === 0) {
        return {
            visibleRatio: 1,
            inFrameRatio: 1,
            visibleInFrameRatio: 1,
            visibleSamples: 0,
            inFrameSamples: 0,
            sampleCount: 0
        };
    }

    const { view, vp } = buildViewProjection(scene);
    const nearestDepth = new Float32Array(FRONT_SURFACE_GRID_WIDTH * FRONT_SURFACE_GRID_HEIGHT);
    const targetNearestDepth = new Float32Array(FRONT_SURFACE_GRID_WIDTH * FRONT_SURFACE_GRID_HEIGHT);
    nearestDepth.fill(Infinity);
    targetNearestDepth.fill(Infinity);
    const stride = targetSamples.length / sampleCount;
    const checkSamples = Array.from({ length: sampleCount }, (_, index) => targetSamples[Math.floor(index * stride)]);

    const pushDepth = (sample: SplatSample, depths: Float32Array) => {
        const projected = projectSample(sample, view, vp);
        if (!projected) {
            return;
        }

        const index = projected.cellY * FRONT_SURFACE_GRID_WIDTH + projected.cellX;
        if (projected.depth < depths[index]) {
            depths[index] = projected.depth;
        }
    };

    forEachStridedSample(sceneSamples, FRONT_SURFACE_SCENE_DEPTH_SAMPLE_TARGET, sample => pushDepth(sample, nearestDepth));
    forEachStridedSample(targetSamples, FRONT_SURFACE_TARGET_DEPTH_SAMPLE_TARGET, (sample) => {
        pushDepth(sample, nearestDepth);
        pushDepth(sample, targetNearestDepth);
    });
    for (const sample of checkSamples) {
        pushDepth(sample, nearestDepth);
        pushDepth(sample, targetNearestDepth);
    }

    let targetCells = 0;
    let visibleTargetCells = 0;

    for (let i = 0; i < targetNearestDepth.length; i++) {
        const targetDepth = targetNearestDepth[i];
        if (!isFinite(targetDepth)) {
            continue;
        }

        targetCells++;
        const cellX = i % FRONT_SURFACE_GRID_WIDTH;
        const cellY = Math.floor(i / FRONT_SURFACE_GRID_WIDTH);
        const nearest = nearestDepthAround(nearestDepth, cellX, cellY);
        if (!isFinite(nearest) || targetDepth <= nearest + frontDepthTolerance(targetDepth)) {
            visibleTargetCells++;
        }
    }

    return {
        visibleRatio: targetCells > 0 ? visibleTargetCells / targetCells : 0,
        inFrameRatio: targetCells / Math.max(1, FRONT_SURFACE_GRID_WIDTH * FRONT_SURFACE_GRID_HEIGHT),
        visibleInFrameRatio: targetCells > 0 ? visibleTargetCells / targetCells : 0,
        visibleSamples: visibleTargetCells,
        inFrameSamples: targetCells,
        sampleCount: targetCells
    };
};

const collisionContextCache = new Map<string, CollisionContext | null>();
const reportedMissingCollisionAssets = new Set<string>();

const popcount8 = (value: number) => {
    value &= 0xff;
    value -= (value >> 1) & 0x55;
    value = (value & 0x33) + ((value >> 2) & 0x33);
    return (value + (value >> 4)) & 0x0f;
};

const loadJsonSync = <T>(url: string): T | null => {
    const request = new XMLHttpRequest();
    request.open('GET', url, false);
    try {
        request.send();
    } catch {
        return null;
    }

    if (request.status < 200 || request.status >= 300) {
        return null;
    }

    try {
        return JSON.parse(request.responseText) as T;
    } catch {
        return null;
    }
};

const loadArrayBufferSync = (url: string) => {
    const request = new XMLHttpRequest();
    request.open('GET', url, false);
    request.overrideMimeType('text/plain; charset=x-user-defined');
    try {
        request.send();
    } catch {
        return null;
    }

    if (request.status < 200 || request.status >= 300) {
        return null;
    }

    const text = request.responseText;
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
        bytes[i] = text.charCodeAt(i) & 0xff;
    }
    return bytes.buffer;
};

const collisionAssetUrl = (events: Events) => {
    const splats = events.invoke('scene.splats') as Splat[] | undefined;
    const filename = splats?.[0]?.filename ?? splats?.[0]?.name;
    const basename = filename?.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '');
    return basename ? `/static/dev-assets/collision/${basename}.voxel.json` : null;
};

const buildVoxelCollisionContext = (assetUrl: string): CollisionContext | null => {
    if (collisionContextCache.has(assetUrl)) {
        return collisionContextCache.get(assetUrl) ?? null;
    }

    const meta = loadJsonSync<VoxelMeta>(assetUrl);
    if (!meta || !meta.version?.startsWith('1.') || meta.leafSize !== 4 || meta.nodeCount <= 0) {
        collisionContextCache.set(assetUrl, null);
        return null;
    }

    const binUrl = assetUrl.replace(/\.voxel\.json(?:\?.*)?$/, '.voxel.bin');
    const buffer = loadArrayBufferSync(binUrl);
    if (!buffer || buffer.byteLength < (meta.nodeCount + meta.leafDataCount) * 4) {
        collisionContextCache.set(assetUrl, null);
        return null;
    }

    const words = new Uint32Array(buffer);
    const nodes = words.subarray(0, meta.nodeCount);
    const leafData = words.subarray(meta.nodeCount, meta.nodeCount + meta.leafDataCount);
    const min = meta.gridBounds.min;
    const max = meta.gridBounds.max;
    const voxelSize = meta.voxelResolution;
    const leafSize = meta.leafSize;
    const blockSize = voxelSize * leafSize;
    const blockCounts = [
        Math.round((max[0] - min[0]) / blockSize),
        Math.round((max[1] - min[1]) / blockSize),
        Math.round((max[2] - min[2]) / blockSize)
    ];

    const solidVoxel = (vx: number, vy: number, vz: number) => {
        const bx = Math.floor(vx / leafSize);
        const by = Math.floor(vy / leafSize);
        const bz = Math.floor(vz / leafSize);
        if (bx < 0 || by < 0 || bz < 0 || bx >= blockCounts[0] || by >= blockCounts[1] || bz >= blockCounts[2]) {
            return false;
        }

        let nodeIndex = 0;
        for (let depth = 0; depth <= meta.treeDepth; depth++) {
            const word = nodes[nodeIndex];
            if (word === 0xff000000) {
                return true;
            }

            const tag = word >>> 24;
            if (tag === 0) {
                const dataIndex = (word & 0x00ffffff) * 2;
                const lx = vx & 3;
                const ly = vy & 3;
                const lz = vz & 3;
                const bit = lx + (ly << 2) + (lz << 4);
                const mask = leafData[dataIndex + (bit >= 32 ? 1 : 0)] ?? 0;
                return ((mask >>> (bit & 31)) & 1) !== 0;
            }

            if (depth >= meta.treeDepth) {
                return false;
            }

            const shift = meta.treeDepth - 1 - depth;
            const oct = ((bx >> shift) & 1) | (((by >> shift) & 1) << 1) | (((bz >> shift) & 1) << 2);
            if ((tag & (1 << oct)) === 0) {
                return false;
            }

            const firstChild = word & 0x00ffffff;
            nodeIndex = firstChild + popcount8(tag & ((1 << oct) - 1));
        }

        return false;
    };

    const solidAt = (point: Vec3) => {
        if (point.x < min[0] || point.y < min[1] || point.z < min[2] ||
            point.x >= max[0] || point.y >= max[1] || point.z >= max[2]) {
            return false;
        }

        return solidVoxel(
            Math.floor((point.x - min[0]) / voxelSize),
            Math.floor((point.y - min[1]) / voxelSize),
            Math.floor((point.z - min[2]) / voxelSize)
        );
    };

    const nearestSolidDistance = (point: Vec3, maxDistance: number) => {
        const cx = Math.floor((point.x - min[0]) / voxelSize);
        const cy = Math.floor((point.y - min[1]) / voxelSize);
        const cz = Math.floor((point.z - min[2]) / voxelSize);
        const range = Math.ceil(maxDistance / voxelSize);
        let nearestSq = Infinity;

        for (let z = cz - range; z <= cz + range; z++) {
            for (let y = cy - range; y <= cy + range; y++) {
                for (let x = cx - range; x <= cx + range; x++) {
                    if (!solidVoxel(x, y, z)) {
                        continue;
                    }

                    const wx = min[0] + (x + 0.5) * voxelSize;
                    const wy = min[1] + (y + 0.5) * voxelSize;
                    const wz = min[2] + (z + 0.5) * voxelSize;
                    const dx = wx - point.x;
                    const dy = wy - point.y;
                    const dz = wz - point.z;
                    const distanceSq = dx * dx + dy * dy + dz * dz;
                    if (distanceSq < nearestSq) {
                        nearestSq = distanceSq;
                    }
                }
            }
        }

        return isFinite(nearestSq) ? Math.sqrt(nearestSq) : Infinity;
    };

    const firstSolidHit = (position: Vec3, direction: Vec3, maxDistance: number) => {
        const cursor = new Vec3();
        const step = Math.max(voxelSize * 1.25, maxDistance / COLLISION_MAX_RAY_STEPS);
        for (let distance = 0; distance <= maxDistance; distance += step) {
            cursor.copy(position).add(direction.clone().mulScalar(distance));
            if (solidAt(cursor)) {
                return distance;
            }
        }

        return Infinity;
    };

    const context: CollisionContext = {
        probe: (
            position: Vec3,
            target: Vec3,
            probeBounds: RobustBounds,
            scene: Scene,
            visibilitySamples: SplatSample[] = [],
            sceneSamples: SplatSample[] = []
        ) => {
            const direction = new Vec3().sub2(target, position);
            const targetDistance = Math.max(EPSILON, direction.length());
            direction.mulScalar(1 / targetDistance);

            const nearClearance = Number.isFinite(scene.camera.near) ? scene.camera.near * 4 : 0;
            const minCameraClearance = Math.max(voxelSize * 4, Math.min(nearClearance, voxelSize * 10));
            const minCenterHitDistance = Math.max(voxelSize * 8, minCameraClearance * 1.8);
            const maxCenterHitDistance = targetDistance * 1.25;
            const targetWindow = Math.max(Math.min(probeBounds.radius * 0.8, 1.2), voxelSize * 5, 0.4);
            const maxExpectedOccluderDistance = Math.max(minCenterHitDistance, targetDistance - targetWindow);
            const clearance = nearestSolidDistance(position, minCameraClearance * 2);
            const centerHit = firstSolidHit(position, direction, maxCenterHitDistance);
            const reasons: string[] = [];
            const rejectReasons: string[] = [];
            const addRejectReason = (reason: string) => {
                reasons.push(reason);
                rejectReasons.push(reason);
            };
            const addSoftReason = (reason: string) => {
                reasons.push(reason);
            };

            const worldUp = Math.abs(direction.y) > 0.92 ? new Vec3(0, 0, 1) : new Vec3(0, 1, 0);
            let right = crossVec(worldUp, direction);
            if (right.length() < EPSILON) {
                right = new Vec3(1, 0, 0);
            } else {
                right.normalize();
            }
            const up = crossVec(direction, right).normalize();
            const footprintRadius = Math.max(voxelSize * 4, Math.min(probeBounds.radius * 0.55, 1.0));
            const diagonalRadius = footprintRadius * 0.62;
            const targetPoints = [
                target.clone(),
                target.clone().add(right.clone().mulScalar(footprintRadius)),
                target.clone().add(right.clone().mulScalar(-footprintRadius)),
                target.clone().add(up.clone().mulScalar(footprintRadius)),
                target.clone().add(up.clone().mulScalar(-footprintRadius)),
                target.clone().add(right.clone().mulScalar(diagonalRadius)).add(up.clone().mulScalar(diagonalRadius)),
                target.clone().add(right.clone().mulScalar(-diagonalRadius)).add(up.clone().mulScalar(diagonalRadius)),
                target.clone().add(right.clone().mulScalar(diagonalRadius)).add(up.clone().mulScalar(-diagonalRadius)),
                target.clone().add(right.clone().mulScalar(-diagonalRadius)).add(up.clone().mulScalar(-diagonalRadius))
            ];
            let targetVisibleRays = 0;
            let nearestTargetHitDistance = Infinity;
            for (const point of targetPoints) {
                const pointDirection = new Vec3().sub2(point, position);
                const pointDistance = Math.max(EPSILON, pointDirection.length());
                pointDirection.mulScalar(1 / pointDistance);
                const hit = firstSolidHit(position, pointDirection, pointDistance * 1.1);
                if (isFinite(hit)) {
                    nearestTargetHitDistance = Math.min(nearestTargetHitDistance, hit);
                }
                if (!isFinite(hit) || hit >= pointDistance - targetWindow) {
                    targetVisibleRays++;
                }
            }
            const targetRayCount = targetPoints.length;
            const targetVisibilityRatio = targetVisibleRays / targetRayCount;
            const sampleWindow = Math.max(voxelSize * 4, Math.min(probeBounds.radius * 0.18, 0.45));
            const sampleCount = Math.min(visibilitySamples.length, VISIBILITY_SAMPLE_TARGET);
            const sampleStride = sampleCount > 0 ? visibilitySamples.length / sampleCount : 1;
            let visibleSamples = 0;
            let nearestSampleHitDistance = Infinity;
            for (let i = 0; i < sampleCount; i++) {
                const sample = visibilitySamples[Math.floor(i * sampleStride)];
                const point = new Vec3(sample.x, sample.y, sample.z);
                const pointDirection = new Vec3().sub2(point, position);
                const pointDistance = Math.max(EPSILON, pointDirection.length());
                pointDirection.mulScalar(1 / pointDistance);
                const hit = firstSolidHit(position, pointDirection, pointDistance * 1.1);
                if (isFinite(hit)) {
                    nearestSampleHitDistance = Math.min(nearestSampleHitDistance, hit);
                }
                if (!isFinite(hit) || hit >= pointDistance - sampleWindow) {
                    visibleSamples++;
                }
            }
            const sampleVisibilityRatio = sampleCount > 0 ? visibleSamples / sampleCount : 1;
            const frontSurface = visibilitySamples.length >= 8 ?
                probeSelectedFrontSurface(scene, visibilitySamples, sceneSamples) :
                {
                    visibleRatio: 1,
                    inFrameRatio: 1,
                    visibleInFrameRatio: 1,
                    visibleSamples: 0,
                    inFrameSamples: 0,
                    sampleCount: 0
                };

            const isTargetProbe = probeBounds.id === 'artisan-target-bounds';
            const minTargetVisibility = isTargetProbe ? TARGET_ORBIT_CANONICAL_MIN_TARGET_VISIBILITY : 0.48;
            const minSampleVisibility = isTargetProbe ? TARGET_ORBIT_CANONICAL_MIN_SAMPLE_VISIBILITY : 0.42;
            const hardMinTargetVisibility = isTargetProbe ? TARGET_ORBIT_CANONICAL_HARD_MIN_TARGET_VISIBILITY : minTargetVisibility;
            const hardMinSampleVisibility = isTargetProbe ? TARGET_ORBIT_CANONICAL_HARD_MIN_SAMPLE_VISIBILITY : minSampleVisibility;

            if (clearance < minCameraClearance) {
                addRejectReason(`camera inside/near voxel collision (${round3(clearance)}m)`);
            }
            if (isFinite(centerHit) && centerHit < minCenterHitDistance) {
                addRejectReason(`voxel collision too close to camera (${round3(centerHit)}m)`);
            } else if (centerHit < maxExpectedOccluderDistance) {
                const targetSurfaceVisible = isTargetProbe && (
                    targetVisibilityRatio >= hardMinTargetVisibility ||
                    sampleVisibilityRatio >= hardMinSampleVisibility ||
                    frontSurface.visibleRatio >= TARGET_ORBIT_CANONICAL_HARD_MIN_FRONT_SURFACE_VISIBILITY
                );
                if (targetSurfaceVisible) {
                    addSoftReason(`center ray hit visible target surface before target center (${round3(centerHit)}m < ${round3(maxExpectedOccluderDistance)}m)`);
                } else {
                    addRejectReason(`voxel collision before target (${round3(centerHit)}m < ${round3(maxExpectedOccluderDistance)}m)`);
                }
            }
            if (targetVisibilityRatio < hardMinTargetVisibility) {
                const prefix = isTargetProbe ? 'canonical target visibility gate' : 'low target voxel visibility';
                addRejectReason(`${prefix} (${targetVisibleRays}/${targetRayCount} rays < ${round3(hardMinTargetVisibility)})`);
            } else if (targetVisibilityRatio < minTargetVisibility) {
                const prefix = isTargetProbe ? 'relaxed canonical target visibility' : 'low target voxel visibility';
                const reason = `${prefix} (${targetVisibleRays}/${targetRayCount} rays < ${round3(minTargetVisibility)})`;
                if (isTargetProbe) {
                    addSoftReason(reason);
                } else {
                    addRejectReason(reason);
                }
            }
            if (sampleCount >= 8 && sampleVisibilityRatio < hardMinSampleVisibility) {
                const prefix = isTargetProbe ? 'canonical target sample visibility gate' : 'low target sample voxel visibility';
                addRejectReason(`${prefix} (${visibleSamples}/${sampleCount} samples < ${round3(hardMinSampleVisibility)})`);
            } else if (sampleCount >= 8 && sampleVisibilityRatio < minSampleVisibility) {
                const prefix = isTargetProbe ? 'relaxed canonical target sample visibility' : 'low target sample voxel visibility';
                const reason = `${prefix} (${visibleSamples}/${sampleCount} samples < ${round3(minSampleVisibility)})`;
                if (isTargetProbe) {
                    addSoftReason(reason);
                } else {
                    addRejectReason(reason);
                }
            }
            const targetFrontSurfaceHardReject = frontSurface.visibleRatio <= TARGET_ORBIT_FRONT_SURFACE_HARD_REJECT_RATIO &&
                targetVisibilityRatio < TARGET_ORBIT_CANONICAL_HARD_MIN_TARGET_VISIBILITY &&
                sampleVisibilityRatio < TARGET_ORBIT_CANONICAL_HARD_MIN_SAMPLE_VISIBILITY;
            const frontSurfaceHardReject = isTargetProbe ?
                targetFrontSurfaceHardReject :
                frontSurface.visibleRatio < 0.35;
            if (frontSurface.sampleCount >= 8 && frontSurfaceHardReject) {
                addRejectReason(`low selected splat front-surface cell visibility (${frontSurface.visibleSamples}/${frontSurface.sampleCount} cells)`);
            }
            if (isTargetProbe &&
                frontSurface.sampleCount >= 8 &&
                frontSurface.visibleRatio < TARGET_ORBIT_CANONICAL_HARD_MIN_FRONT_SURFACE_VISIBILITY) {
                addRejectReason(
                    `canonical target front-surface visibility gate ` +
                    `(${frontSurface.visibleSamples}/${frontSurface.sampleCount} cells < ${round3(TARGET_ORBIT_CANONICAL_HARD_MIN_FRONT_SURFACE_VISIBILITY)})`
                );
            } else if (isTargetProbe &&
                frontSurface.sampleCount >= 8 &&
                frontSurface.visibleRatio < TARGET_ORBIT_CANONICAL_MIN_FRONT_SURFACE_VISIBILITY) {
                addSoftReason(
                    `relaxed canonical target front-surface visibility ` +
                    `(${frontSurface.visibleSamples}/${frontSurface.sampleCount} cells < ${round3(TARGET_ORBIT_CANONICAL_MIN_FRONT_SURFACE_VISIBILITY)})`
                );
            }

            const rejected = rejectReasons.length > 0;
            const frontSurfacePenaltyWeight = isTargetProbe ? 0.16 : 0.25;
            const visibilityPenalty = Math.max(
                Math.max(0, ((isTargetProbe ? 0.82 : 0.68) - targetVisibilityRatio) * 0.5),
                sampleCount >= 8 ? Math.max(0, ((isTargetProbe ? 0.78 : 0.72) - sampleVisibilityRatio) * 0.42) : 0,
                frontSurface.sampleCount >= 3 ? Math.max(0, (0.65 - frontSurface.visibleRatio) * frontSurfacePenaltyWeight) : 0
            );
            return {
                provider: 'splat-transform-voxel',
                asset: assetUrl,
                cellSize: round3(voxelSize),
                cameraClearance: isFinite(clearance) ? round3(clearance) : Infinity,
                minCameraClearance: round3(minCameraClearance),
                centerHitDistance: isFinite(centerHit) ? round3(centerHit) : Infinity,
                minCenterHitDistance: round3(minCenterHitDistance),
                maxCenterHitDistance: round3(maxCenterHitDistance),
                targetVisibilityRatio: round3(targetVisibilityRatio),
                targetVisibleRays,
                targetRayCount,
                nearestTargetHitDistance: isFinite(nearestTargetHitDistance) ? round3(nearestTargetHitDistance) : Infinity,
                sampleVisibilityRatio: round3(sampleVisibilityRatio),
                visibleSamples,
                visibilitySampleCount: sampleCount,
                nearestSampleHitDistance: isFinite(nearestSampleHitDistance) ? round3(nearestSampleHitDistance) : Infinity,
                frontSurfaceVisibleRatio: round3(frontSurface.visibleRatio),
                frontSurfaceInFrameRatio: round3(frontSurface.inFrameRatio),
                frontSurfaceVisibleInFrameRatio: round3(frontSurface.visibleInFrameRatio),
                frontSurfaceVisibleSamples: frontSurface.visibleSamples,
                frontSurfaceInFrameSamples: frontSurface.inFrameSamples,
                frontSurfaceSampleCount: frontSurface.sampleCount,
                rejected,
                reasons,
                penalty: rejected ? 0.42 : visibilityPenalty
            };
        }
    };

    collisionContextCache.set(assetUrl, context);
    return context;
};

const missingCollisionMessage = (assetUrl: string | null) => {
    return assetUrl ?
        `Missing or invalid voxel collision asset: ${assetUrl}` :
        'Missing voxel collision asset for current scene.';
};

const reportMissingCollisionAsset = (events: Events, assetUrl: string | null) => {
    const message = missingCollisionMessage(assetUrl);
    const label = assetUrl ?? 'unknown scene';
    if (reportedMissingCollisionAssets.has(label)) {
        return;
    }

    reportedMissingCollisionAssets.add(label);
    console.warn(`[ArtisanGS] ${message}`);
    events.fire('toast', `${message} Using density-aware camera fallback.`, 'warning');
};

const buildDensityFallbackCollisionContext = (reason: string): CollisionContext => ({
    fallbackReason: reason,
    probe: () => ({
        provider: 'density-aware-fallback',
        cellSize: 0,
        cameraClearance: Infinity,
        minCameraClearance: 0,
        centerHitDistance: Infinity,
        minCenterHitDistance: 0,
        maxCenterHitDistance: Infinity,
        targetVisibilityRatio: 1,
        targetVisibleRays: 0,
        targetRayCount: 0,
        nearestTargetHitDistance: Infinity,
        sampleVisibilityRatio: 1,
        visibleSamples: 0,
        visibilitySampleCount: 0,
        nearestSampleHitDistance: Infinity,
        frontSurfaceVisibleRatio: 1,
        frontSurfaceInFrameRatio: 1,
        frontSurfaceVisibleInFrameRatio: 1,
        frontSurfaceVisibleSamples: 0,
        frontSurfaceInFrameSamples: 0,
        frontSurfaceSampleCount: 0,
        rejected: false,
        reasons: [],
        penalty: 0
    })
});

const buildCollisionContext = (events: Events): CollisionContext => {
    const assetUrl = collisionAssetUrl(events);
    if (!assetUrl) {
        reportMissingCollisionAsset(events, null);
        return buildDensityFallbackCollisionContext(missingCollisionMessage(null));
    }

    const voxelContext = buildVoxelCollisionContext(assetUrl);
    if (!voxelContext) {
        reportMissingCollisionAsset(events, assetUrl);
        return buildDensityFallbackCollisionContext(missingCollisionMessage(assetUrl));
    }

    return voxelContext;
};

const cameraDistanceWorld = (camera: CameraDebugState) => {
    return Math.max(EPSILON, distanceBetween(vectorFromDebug(camera.position), vectorFromDebug(camera.target)));
};

const stationFromCamera = (id: string, label: string, scene: Scene, camera: CameraDebugState): Station => {
    const position = vectorFromDebug(camera.position);
    const target = vectorFromDebug(camera.target);
    const distanceWorld = cameraDistanceWorld(camera);

    return {
        id,
        label,
        position,
        azim: camera.azim,
        elevation: camera.elevation,
        distanceWorld,
        fov: camera.fov,
        ortho: camera.ortho,
        role: 'seed',
        generation: 0
    };
};

const buildStations = (scene: Scene, original: CameraDebugState): Station[] => [
    stationFromCamera('current', 'current station', scene, original)
];

const yawSweep = [
    { suffix: 'yaw-0', label: '0deg', yaw: 0, pitch: 0 },
    { suffix: 'yaw-negative-45', label: '-45deg', yaw: -45, pitch: 0 },
    { suffix: 'yaw-positive-45', label: '+45deg', yaw: 45, pitch: 0 },
    { suffix: 'yaw-negative-90', label: '-90deg', yaw: -90, pitch: 0 },
    { suffix: 'yaw-positive-90', label: '+90deg', yaw: 90, pitch: 0 },
    { suffix: 'yaw-negative-135', label: '-135deg', yaw: -135, pitch: 0 },
    { suffix: 'yaw-positive-135', label: '+135deg', yaw: 135, pitch: 0 },
    { suffix: 'yaw-180', label: '+180deg', yaw: 180, pitch: 0 },
    { suffix: 'pitch-positive-15', label: 'pitch +15deg', yaw: 0, pitch: 15 },
    { suffix: 'pitch-negative-15', label: 'pitch -15deg', yaw: 0, pitch: -15 }
];

const seedLocalYawPitchPattern = [
    { yaw: 0, pitch: 0 },
    { yaw: -8, pitch: 0 },
    { yaw: 8, pitch: 0 },
    { yaw: -16, pitch: 0 },
    { yaw: 16, pitch: 0 },
    { yaw: 0, pitch: 8 },
    { yaw: 0, pitch: -8 },
    { yaw: -24, pitch: 8 },
    { yaw: 24, pitch: 8 },
    { yaw: -24, pitch: -8 },
    { yaw: 24, pitch: -8 },
    { yaw: -36, pitch: 0 },
    { yaw: 36, pitch: 0 },
    { yaw: -48, pitch: 12 },
    { yaw: 48, pitch: 12 },
    { yaw: -48, pitch: -12 },
    { yaw: 48, pitch: -12 },
    { yaw: -60, pitch: 0 },
    { yaw: 60, pitch: 0 }
];

const TRACKABLE_ORBIT_YAW_STEP_DEG = 8;

const buildTrackableYawOffsets = (stepDegrees: number, maxOffsets: number) => {
    const step = Math.max(2, Math.min(16, stepDegrees));
    const offsets: number[] = [0];
    const maxSteps = Math.ceil(180 / step);

    for (let index = 1; offsets.length < maxOffsets && index <= maxSteps; index++) {
        offsets.push(-round3(index * step));
        if (offsets.length < maxOffsets) {
            offsets.push(round3(index * step));
        }
    }

    return offsets;
};

const poseAnglesFromTarget = (position: Vec3, target: Vec3) => {
    const look = new Vec3().sub2(target, position);
    const distanceWorld = Math.max(EPSILON, look.length());
    return {
        azim: Math.atan2(-look.x / distanceWorld, -look.z / distanceWorld) * 180 / Math.PI,
        elevation: Math.asin(look.y / distanceWorld) * 180 / Math.PI,
        distanceWorld
    };
};

const orbitPoseUsingCameraControls = (
    scene: Scene,
    original: CameraDebugState,
    target: Vec3,
    distanceWorld: number,
    azim: number,
    elevation: number
) => {
    scene.camera.fov = original.fov;
    scene.camera.ortho = original.ortho ?? false;
    scene.camera.setFocalPoint(target, 0);
    scene.camera.setDistance(distanceWorld / Math.max(EPSILON, scene.camera.sceneRadius) * Math.max(EPSILON, scene.camera.fovFactor), 0);
    scene.camera.setAzimElev(azim, elevation, 0);
    scene.camera.onUpdate(0);
    const position = scene.camera.position.clone();

    return {
        position,
        camera: debugFromPose(scene, position, target, original)
    };
};

const createSeedLocalOrbitCandidates = (
    scene: Scene,
    original: CameraDebugState,
    targetBounds: RobustBounds,
    remainingBudget: number
): Candidate[] => {
    const count = Math.max(0, Math.min(
        remainingBudget,
        Math.max(36, Math.min(132, Math.floor(remainingBudget * 0.66)))
    ));
    if (count <= 0) {
        return [];
    }

    const target = targetBounds.center.clone();
    const originalPosition = vectorFromDebug(original.position);
    const basePose = poseAnglesFromTarget(originalPosition, target);
    const targetRadius = Math.max(0.04, targetBounds.radius);
    const fovRadians = Math.max(10, Math.min(100, original.fov)) * Math.PI / 180;
    const desiredDistance = targetRadius / Math.max(EPSILON, Math.tan(fovRadians * SEED_LOCAL_SCREEN_FRACTION * 0.5));
    const minDistance = Math.max(scene.camera.near * 18, targetRadius * 1.65);
    const baseDistance = Math.max(basePose.distanceWorld, minDistance);
    const closestUsefulDistance = Math.max(minDistance, Math.min(baseDistance, desiredDistance * 1.15));
    const scaledDistances = [
        baseDistance,
        Math.max(minDistance, baseDistance * 0.9),
        Math.max(minDistance, baseDistance * 0.72),
        Math.max(minDistance, baseDistance * 0.55),
        Math.max(minDistance, baseDistance * 0.38),
        closestUsefulDistance * 1.7,
        closestUsefulDistance * 1.3,
        Math.max(minDistance, closestUsefulDistance * 1.18),
        closestUsefulDistance
    ];
    const distances: number[] = [];
    for (const distance of scaledDistances) {
        const clamped = Math.max(minDistance, Math.min(baseDistance, distance));
        if (!distances.some(value => Math.abs(value - clamped) < 0.01)) {
            distances.push(clamped);
        }
    }
    if (distances.length === 0) {
        distances.push(baseDistance);
    }

    const pitchPattern = [0, 8, -8];
    const yawOffsets = buildTrackableYawOffsets(
        TRACKABLE_ORBIT_YAW_STEP_DEG,
        Math.max(seedLocalYawPitchPattern.length, Math.ceil(count / Math.max(1, pitchPattern.length)) + 2)
    );
    const candidates: Candidate[] = [];
    for (let distanceIndex = 0; distanceIndex < distances.length && candidates.length < count; distanceIndex++) {
        const distanceWorld = distances[distanceIndex];
        for (const yaw of yawOffsets) {
            for (const pitch of pitchPattern) {
                if (candidates.length >= count) {
                    break;
                }

                const elevation = Math.max(-72, Math.min(72, basePose.elevation + pitch));
                const pose = orbitPoseUsingCameraControls(
                    scene,
                    original,
                    target,
                    distanceWorld,
                    basePose.azim + yaw,
                    elevation
                );
                const index = candidates.length;
                const zoomLabel = Math.abs(distanceWorld - baseDistance) < 0.01 ? 'seed distance' : `zoom ${(baseDistance / distanceWorld).toFixed(1)}x`;
                const pitchLabel = pitch === 0 ? 'level' : (pitch > 0 ? `high +${pitch}deg` : `low ${pitch}deg`);
                const yawLabel = yaw > 0 ? `right +${yaw}deg` : `left ${yaw}deg`;
                const label = `seed local ${index + 1}/${count} ${yawLabel} ${pitchLabel} ${zoomLabel}`;

                candidates.push({
                    id: `seed-local-${index}`,
                    label,
                    position: pose.position,
                    azim: pose.camera.azim,
                    elevation: pose.camera.elevation,
                    distanceWorld,
                    fov: original.fov,
                    ortho: original.ortho,
                    role: 'orbit',
                    generation: 0,
                    viewId: `planner-seed-local-${index}`,
                    yawOffset: round3(yaw),
                    pitchOffset: round3(pitch),
                    edgeLabel: label,
                    viewRole: 'orbit',
                    target: target.clone()
                });
            }
        }
    }

    return candidates;
};

const createOrbitCandidates = (
    scene: Scene,
    original: CameraDebugState,
    targetBounds: RobustBounds,
    remainingBudget: number
): Candidate[] => {
    const localCandidates = createSeedLocalOrbitCandidates(scene, original, targetBounds, remainingBudget);
    const target = targetBounds.center.clone();
    const originalPosition = vectorFromDebug(original.position);
    const basePose = poseAnglesFromTarget(originalPosition, target);
    const fovRadians = Math.max(10, Math.min(100, original.fov)) * Math.PI / 180;
    const targetRadius = Math.max(0.04, targetBounds.radius);
    const desiredDistance = targetRadius / Math.max(EPSILON, Math.tan(fovRadians * TARGET_ORBIT_SCREEN_FRACTION * 0.5));
    const minDistance = Math.max(scene.camera.near * 18, targetRadius * 1.65);
    const baseDistance = Math.max(basePose.distanceWorld, minDistance);
    const focusedDistance = Math.max(minDistance, Math.min(baseDistance, desiredDistance));
    const count = Math.max(0, remainingBudget - localCandidates.length);
    const candidates: Candidate[] = [...localCandidates];
    const pitchPattern = count >= 12 ? [0, 16, -16] : [0, 14, -14];
    const distanceScales = [0.86, 1, 1.18];
    const rings: { pitchOffset: number; distanceWorld: number; zoomIndex: number }[] = [];
    for (let zoomIndex = 0; zoomIndex < distanceScales.length; zoomIndex++) {
        const distanceWorld = Math.min(baseDistance, focusedDistance * distanceScales[zoomIndex]);
        for (const pitchOffset of pitchPattern) {
            rings.push({ pitchOffset, distanceWorld, zoomIndex });
        }
    }
    const ringCount = Math.min(rings.length, Math.max(1, count));
    const yawOffsets = buildTrackableYawOffsets(
        TRACKABLE_ORBIT_YAW_STEP_DEG,
        Math.max(1, Math.ceil(count / Math.max(1, ringCount)))
    );

    for (let ringIndex = 0; ringIndex < ringCount && candidates.length < remainingBudget; ringIndex++) {
        const ring = rings[ringIndex];
        const pitchOffset = ring.pitchOffset;
        const elevation = Math.max(-75, Math.min(75, basePose.elevation + pitchOffset));
        for (let yawIndex = 0; yawIndex < yawOffsets.length && candidates.length < remainingBudget; yawIndex++) {
            const yawDegrees = yawOffsets[yawIndex] + (ringIndex % 2) * TRACKABLE_ORBIT_YAW_STEP_DEG * 0.5;
            const index = candidates.length - localCandidates.length;
            const pose = orbitPoseUsingCameraControls(
                scene,
                original,
                target,
                ring.distanceWorld,
                basePose.azim + yawDegrees,
                elevation
            );
            const pitchLabel = pitchOffset === 0 ? 'level' : (pitchOffset > 0 ? `high +${pitchOffset}deg` : `low ${pitchOffset}deg`);
            const zoomLabel = ring.zoomIndex === 0 ? 'near' : `zoom${ring.zoomIndex + 1}`;
            const label = `orbit ${index + 1}/${count} ${pitchLabel} ${zoomLabel}`;

            candidates.push({
                id: `orbit-${index}`,
                label,
                position: pose.position,
                azim: pose.camera.azim,
                elevation: pose.camera.elevation,
                distanceWorld: ring.distanceWorld,
                fov: original.fov,
                ortho: original.ortho,
                role: 'orbit',
                generation: 0,
                viewId: `planner-orbit-${index}`,
                yawOffset: round3(yawDegrees),
                pitchOffset: round3(pitchOffset),
                edgeLabel: label,
                viewRole: 'orbit',
                target: target.clone()
            });
        }
    }

    return candidates;
};

type DensityHash = {
    cellSize: number;
    cells: Map<string, number[]>;
};

const densityCellKey = (ix: number, iy: number, iz: number) => `${ix},${iy},${iz}`;

const buildDensityHash = (samples: SplatSample[], cellSize: number): DensityHash => {
    const cells = new Map<string, number[]>();
    const inv = 1 / Math.max(cellSize, EPSILON);

    for (let i = 0; i < samples.length; i++) {
        const sample = samples[i];
        const key = densityCellKey(
            Math.floor(sample.x * inv),
            Math.floor(sample.y * inv),
            Math.floor(sample.z * inv)
        );
        const bucket = cells.get(key);
        if (bucket) {
            bucket.push(i);
        } else {
            cells.set(key, [i]);
        }
    }

    return { cellSize, cells };
};

const visitDensityNeighbors = (
    samples: SplatSample[],
    hash: DensityHash,
    point: Vec3 | SplatSample,
    radius: number,
    callback: (sample: SplatSample) => void
) => {
    const inv = 1 / Math.max(hash.cellSize, EPSILON);
    const ix = Math.floor(point.x * inv);
    const iy = Math.floor(point.y * inv);
    const iz = Math.floor(point.z * inv);
    const range = Math.ceil(radius / Math.max(hash.cellSize, EPSILON));
    const radiusSq = radius * radius;

    for (let dz = -range; dz <= range; dz++) {
        for (let dy = -range; dy <= range; dy++) {
            for (let dx = -range; dx <= range; dx++) {
                const bucket = hash.cells.get(densityCellKey(ix + dx, iy + dy, iz + dz));
                if (!bucket) {
                    continue;
                }

                for (const index of bucket) {
                    const sample = samples[index];
                    const sx = sample.x - point.x;
                    const sy = sample.y - point.y;
                    const sz = sample.z - point.z;
                    if (sx * sx + sy * sy + sz * sz <= radiusSq) {
                        callback(sample);
                    }
                }
            }
        }
    }
};

const countDensityNeighbors = (samples: SplatSample[], hash: DensityHash, point: Vec3 | SplatSample, radius: number) => {
    let count = 0;
    visitDensityNeighbors(samples, hash, point, radius, () => {
        count++;
    });
    return count;
};

const localDensityCentroid = (
    samples: SplatSample[],
    hash: DensityHash,
    point: Vec3 | SplatSample,
    radius: number,
    fallback: Vec3
) => {
    const centroid = new Vec3();
    let count = 0;

    visitDensityNeighbors(samples, hash, point, radius, (sample) => {
        centroid.x += sample.x;
        centroid.y += sample.y;
        centroid.z += sample.z;
        count++;
    });

    return count >= 3 ? centroid.mulScalar(1 / count) : fallback.clone();
};

const createDensityFallbackCandidates = (
    scene: Scene,
    original: CameraDebugState,
    samples: SplatSample[],
    bounds: RobustBounds,
    remainingBudget: number
): Candidate[] => {
    if (samples.length < DENSITY_FALLBACK_MIN_POINTS || remainingBudget <= 0) {
        return [];
    }

    const densityRadius = Math.max(0.12, bounds.radius * 0.045);
    const localTargetRadius = Math.max(densityRadius * 4, bounds.radius * 0.18);
    const cameraOffset = Math.max(scene.camera.near * 20, bounds.radius * 0.16, 0.18);
    const minSeparation = Math.max(cameraOffset * 1.2, bounds.radius * 0.16);
    const anchorCount = Math.min(samples.length, DENSITY_FALLBACK_ANCHOR_TARGET);
    const anchorStride = samples.length / anchorCount;
    const hash = buildDensityHash(samples, densityRadius);
    const anchors = Array.from({ length: anchorCount }, (_, index) => {
        const sampleIndex = Math.min(samples.length - 1, Math.floor(index * anchorStride));
        const sample = samples[sampleIndex];
        return {
            sample,
            density: countDensityNeighbors(samples, hash, sample, densityRadius),
            sampleIndex
        };
    }).filter(anchor => anchor.density > 0);

    if (anchors.length === 0) {
        return createOrbitCandidates(scene, original, bounds, remainingBudget)
        .map((candidate, index) => ({
            ...candidate,
            id: `density-orbit-${index}`,
            viewId: `planner-density-orbit-${index}`,
            label: `density fallback orbit ${index + 1}/${remainingBudget}`,
            role: 'density' as const,
            viewRole: 'density' as const,
            edgeLabel: 'density fallback orbit'
        }));
    }

    const densities = anchors.map(anchor => anchor.density).sort((a, b) => a - b);
    const low = Math.max(1, quantile(densities, 0.18));
    const high = Math.max(low, quantile(densities, 0.88));
    const ideal = Math.max(low, quantile(densities, 0.52));
    const densityRange = Math.max(1, high - low);
    const scored = anchors
    .filter(anchor => anchor.density >= low && anchor.density <= high)
    .map((anchor) => {
        const densityScore = 1 - clamp01(Math.abs(anchor.density - ideal) / densityRange);
        const radial = distanceBetween(new Vec3(anchor.sample.x, anchor.sample.y, anchor.sample.z), bounds.center);
        const radialScore = clamp01(radial / Math.max(bounds.radius, 0.1));
        return {
            ...anchor,
            score: densityScore * 0.74 + radialScore * 0.26
        };
    })
    .sort((a, b) => b.score - a.score || a.sampleIndex - b.sampleIndex);

    const candidates: Candidate[] = [];
    const chosenPositions: Vec3[] = [];

    for (const anchor of scored) {
        if (candidates.length >= remainingBudget) {
            break;
        }

        const anchorPoint = new Vec3(anchor.sample.x, anchor.sample.y, anchor.sample.z);
        const direction = new Vec3().sub2(anchorPoint, bounds.center);
        if (direction.length() < EPSILON) {
            continue;
        }
        direction.normalize();

        const position = anchorPoint.clone().add(direction.mulScalar(cameraOffset));
        const cameraDensity = countDensityNeighbors(samples, hash, position, densityRadius * 0.8);
        if (cameraDensity > Math.max(2, high * 0.42)) {
            continue;
        }
        if (chosenPositions.some(used => distanceBetween(used, position) < minSeparation)) {
            continue;
        }

        const target = localDensityCentroid(samples, hash, anchor.sample, localTargetRadius, bounds.center);
        const pose = poseAnglesFromTarget(position, target);
        const index = candidates.length;
        chosenPositions.push(position);
        candidates.push({
            id: `density-${index}`,
            label: `density fallback ${index + 1}/${remainingBudget}`,
            position,
            azim: pose.azim,
            elevation: pose.elevation,
            distanceWorld: pose.distanceWorld,
            fov: original.fov,
            ortho: original.ortho,
            role: 'density',
            generation: 0,
            viewId: `planner-density-${index}`,
            yawOffset: 0,
            pitchOffset: 0,
            edgeLabel: `density band ${anchor.density}`,
            viewRole: 'density',
            target
        });
    }

    if (candidates.length > 0) {
        return candidates;
    }

    return createOrbitCandidates(scene, original, bounds, remainingBudget)
    .map((candidate, index) => ({
        ...candidate,
        id: `density-orbit-${index}`,
        viewId: `planner-density-orbit-${index}`,
        label: `density fallback orbit ${index + 1}/${remainingBudget}`,
        role: 'density' as const,
        viewRole: 'density' as const,
        edgeLabel: 'density fallback orbit'
    }));
};

const createSweepCandidates = (station: Station, remainingBudget: number): Candidate[] => {
    const candidates: Candidate[] = [];
    const stationRootViewId = `planner-${station.id}-yaw-0`;

    for (const view of yawSweep) {
        if (candidates.length >= remainingBudget) {
            break;
        }

        const isStationRoot = view.yaw === 0 && view.pitch === 0;
        candidates.push({
            ...station,
            viewId: `planner-${station.id}-${view.suffix}`,
            label: `${station.label}: ${isStationRoot && station.move ? station.move : view.label}`,
            yawOffset: view.yaw,
            pitchOffset: view.pitch,
            parentViewId: isStationRoot ? station.parentViewId : stationRootViewId,
            edgeLabel: isStationRoot && station.move ? station.move : view.label,
            move: isStationRoot ? station.move : undefined,
            viewRole: isStationRoot ? station.role : (station.role === 'frontier' ? 'frontier' : 'yaw-sweep')
        });
    }

    return candidates;
};

const applyPose = (scene: Scene, position: Vec3, target: Vec3, fov: number, ortho?: boolean) => {
    scene.camera.setPose(position, target, 0);
    scene.camera.fov = fov;
    scene.camera.ortho = !!ortho;
    scene.camera.onUpdate(0);
    scene.camera.mainCamera.getWorldTransform();
    (scene.camera.camera as any)._updateViewProjMat?.();
    scene.forceRender = true;
};

const makeDepthQuantiles = (values: number[]) => {
    if (values.length === 0) {
        return { min: 0, p25: 0, median: 0, p75: 0, max: 0 };
    }

    values.sort((a, b) => a - b);
    return {
        min: round3(values[0]),
        p25: round3(quantile(values, 0.25)),
        median: round3(quantile(values, 0.5)),
        p75: round3(quantile(values, 0.75)),
        max: round3(values[values.length - 1])
    };
};

const scoreProjectedSamples = (
    scene: Scene,
    samples: SplatSample[],
    bounds: RobustBounds,
    position: Vec3,
    allowCameraOutsideBounds = false
) => {
    const camera = scene.camera.camera;
    const projection = camera.projectionMatrix.data as Float32Array;
    const view = camera.viewMatrix.data as Float32Array;
    const vp = new Float32Array(16);

    for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
            vp[i + j * 4] =
                projection[i] * view[j * 4] +
                projection[i + 4] * view[j * 4 + 1] +
                projection[i + 8] * view[j * 4 + 2] +
                projection[i + 12] * view[j * 4 + 3];
        }
    }

    const cells = new Float32Array(GRID_WIDTH * GRID_HEIGHT);
    const nearestDepth = new Float32Array(GRID_WIDTH * GRID_HEIGHT);
    nearestDepth.fill(Infinity);
    const depths: number[] = [];
    const centerDepths: number[] = [];
    let edgeHits = 0;
    let centerHits = 0;
    let nearHits = 0;
    let minCellX = GRID_WIDTH;
    let maxCellX = -1;
    let minCellY = GRID_HEIGHT;
    let maxCellY = -1;
    const nearLimit = Math.max(scene.camera.near * 5, bounds.radius * 0.015);

    for (const sample of samples) {
        const cx = vp[0] * sample.x + vp[4] * sample.y + vp[8] * sample.z + vp[12];
        const cy = vp[1] * sample.x + vp[5] * sample.y + vp[9] * sample.z + vp[13];
        const cw = vp[3] * sample.x + vp[7] * sample.y + vp[11] * sample.z + vp[15];
        if (cw <= EPSILON) {
            continue;
        }

        const ndcX = cx / cw;
        const ndcY = cy / cw;
        if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) {
            continue;
        }

        const ogZ = view[2] * sample.x + view[6] * sample.y + view[10] * sample.z + view[14];
        const depth = -ogZ;
        if (depth <= EPSILON) {
            continue;
        }

        const cellX = Math.max(0, Math.min(GRID_WIDTH - 1, Math.floor((ndcX * 0.5 + 0.5) * GRID_WIDTH)));
        const cellY = Math.max(0, Math.min(GRID_HEIGHT - 1, Math.floor((1 - (ndcY * 0.5 + 0.5)) * GRID_HEIGHT)));
        const index = cellY * GRID_WIDTH + cellX;

        cells[index] = 1;
        if (depth < nearestDepth[index]) {
            nearestDepth[index] = depth;
        }
        depths.push(depth);
        minCellX = Math.min(minCellX, cellX);
        maxCellX = Math.max(maxCellX, cellX);
        minCellY = Math.min(minCellY, cellY);
        maxCellY = Math.max(maxCellY, cellY);

        if (cellX === 0 || cellX === GRID_WIDTH - 1 || cellY === 0 || cellY === GRID_HEIGHT - 1) {
            edgeHits++;
        }
        if (cellX >= GRID_WIDTH * 0.32 && cellX <= GRID_WIDTH * 0.68 && cellY >= GRID_HEIGHT * 0.28 && cellY <= GRID_HEIGHT * 0.72) {
            centerHits++;
            centerDepths.push(depth);
        }
        if (depth < nearLimit) {
            nearHits++;
        }
    }

    let occupiedCells = 0;
    for (const cell of cells) {
        occupiedCells += cell;
    }

    let discontinuities = 0;
    let neighborPairs = 0;
    for (let y = 0; y < GRID_HEIGHT; y++) {
        for (let x = 0; x < GRID_WIDTH; x++) {
            const index = y * GRID_WIDTH + x;
            if (!isFinite(nearestDepth[index])) {
                continue;
            }

            const right = x + 1 < GRID_WIDTH ? nearestDepth[y * GRID_WIDTH + x + 1] : Infinity;
            const down = y + 1 < GRID_HEIGHT ? nearestDepth[(y + 1) * GRID_WIDTH + x] : Infinity;

            if (isFinite(right)) {
                neighborPairs++;
                const scale = Math.max(nearestDepth[index], right, 0.1);
                if (Math.abs(nearestDepth[index] - right) / scale > 0.08) {
                    discontinuities++;
                }
            }

            if (isFinite(down)) {
                neighborPairs++;
                const scale = Math.max(nearestDepth[index], down, 0.1);
                if (Math.abs(nearestDepth[index] - down) / scale > 0.08) {
                    discontinuities++;
                }
            }
        }
    }

    const cellCount = GRID_WIDTH * GRID_HEIGHT;
    const hitCoverage = occupiedCells / cellCount;
    const validHits = depths.length;
    const centerCoverage = validHits > 0 ? centerHits / validHits : 0;
    const edgeHitRatio = validHits > 0 ? edgeHits / validHits : 1;
    const nearClipRatio = validHits > 0 ? nearHits / validHits : 0;
    const spreadX = maxCellX >= minCellX ? (maxCellX - minCellX + 1) / GRID_WIDTH : 0;
    const spreadY = maxCellY >= minCellY ? (maxCellY - minCellY + 1) / GRID_HEIGHT : 0;
    const gridCoverage = Math.sqrt(spreadX * spreadY);
    const quantiles = makeDepthQuantiles(depths);
    centerDepths.sort((a, b) => a - b);
    const centerDepth = centerDepths.length > 0 ? quantile(centerDepths, 0.35) : quantiles.p25 || quantiles.median;
    const depthRange = quantiles.median > 0 ? (quantiles.p75 - quantiles.p25) / Math.max(0.1, quantiles.median) : 0;
    const depthVariety = clamp01(depthRange / 0.45);
    const structure = neighborPairs > 0 ? clamp01((discontinuities / neighborPairs) * 4) : 0;
    const outsideDistance = Math.max(0, distanceBetween(position, bounds.center) - bounds.radius * 2.4);
    const outsidePenalty = allowCameraOutsideBounds ? 0 : clamp01(outsideDistance / Math.max(bounds.radius, 0.1));

    const scores: PlannerScores = {
        final: 0,
        depthCoverage: clamp01(hitCoverage / 0.32),
        centerCoverage: clamp01(centerCoverage / 0.28),
        gridCoverage: clamp01(gridCoverage / 0.66),
        noHitRatio: round3(1 - hitCoverage),
        edgeHitRatio: round3(edgeHitRatio),
        nearClipRatio: round3(nearClipRatio),
        depthVariety,
        structure,
        image: 0,
        novelty: 1
    };

    const penalty = edgeHitRatio * 0.16 + nearClipRatio * 0.28 + outsidePenalty * 0.2;
    scores.final = clamp01(
        scores.depthCoverage * 0.28 +
        scores.centerCoverage * 0.22 +
        scores.gridCoverage * 0.2 +
        scores.depthVariety * 0.16 +
        scores.structure * 0.14 -
        penalty
    );

    const reasons: string[] = [];
    const badges: string[] = [];

    if (allowCameraOutsideBounds) {
        if (validHits < 8) reasons.push('too few target hits');
        if (hitCoverage < 0.002) reasons.push('low target coverage');
        if (centerCoverage < 0.08) reasons.push('weak target center hits');
        if (edgeHitRatio > 0.82) reasons.push('target near image edge');
        if (nearClipRatio > 0.24) reasons.push('too close to target');
    } else {
        if (hitCoverage < 0.08) reasons.push('low depth coverage');
        if (centerCoverage < 0.12) reasons.push('weak center hits');
        if (edgeHitRatio > 0.58) reasons.push('edge-heavy hits');
        if (nearClipRatio > 0.12) reasons.push('too close to surface');
        if (depthVariety < 0.08) reasons.push('flat depth');
        if (outsidePenalty > 0.2) reasons.push('far outside robust bounds');
    }

    if (hitCoverage >= 0.16) badges.push('surface coverage');
    if (centerCoverage >= 0.2) badges.push('center anchored');
    if (gridCoverage >= 0.58) badges.push('wide spread');
    if (depthVariety >= 0.16) badges.push('depth variety');
    if (structure >= 0.18) badges.push('local structure');

    const accepted = allowCameraOutsideBounds ?
        scores.final >= 0.18 &&
            validHits >= 8 &&
            hitCoverage >= 0.002 &&
            centerCoverage >= 0.08 &&
            edgeHitRatio <= 0.82 &&
            nearClipRatio <= 0.24 :
        scores.final >= 0.42 &&
            hitCoverage >= 0.08 &&
            centerCoverage >= 0.1 &&
            edgeHitRatio <= 0.7 &&
            nearClipRatio <= 0.18;

    return {
        accepted,
        scores,
        reasons,
        badges,
        geometry: {
            sampleGrid: [GRID_WIDTH, GRID_HEIGHT] as [number, number],
            validHits,
            occupiedCells,
            centerDepth: round3(centerDepth),
            depthQuantiles: quantiles,
            robustBoundsId: bounds.id
        }
    };
};

const evaluateCandidate = (
    scene: Scene,
    candidate: Candidate,
    samples: SplatSample[],
    sceneSamples: SplatSample[],
    bounds: RobustBounds,
    original: CameraDebugState,
    collision: CollisionContext,
    visibilitySamples: SplatSample[]
): EvaluatedCandidate => {
    const target = candidate.target?.clone() ?? targetFromStation(candidate, candidate.yawOffset, candidate.pitchOffset);
    applyPose(scene, candidate.position, target, candidate.fov, candidate.ortho);

    const camera = debugFromPose(scene, candidate.position, target, original);
    const geometry = scoreProjectedSamples(
        scene,
        samples,
        bounds,
        candidate.position,
        bounds.id === 'artisan-target-bounds'
    );
    const collisionProbe = collision.probe(candidate.position, target, bounds, scene, visibilitySamples, sceneSamples);
    const lookDirection = new Vec3().sub2(target, candidate.position).normalize();
    const isTargetOrbit = bounds.id === 'artisan-target-bounds';
    const collisionPenalty = collisionProbe.penalty;
    const finalScore = clamp01(geometry.scores.final - collisionPenalty);
    const minFinalScore = isTargetOrbit ? 0.12 : 0.42;
    const accepted = geometry.accepted && !collisionProbe.rejected && finalScore >= minFinalScore;
    const badges = [...geometry.badges];
    const reasons = [...geometry.reasons, ...collisionProbe.reasons];
    const version = candidate.viewRole === 'density' ?
        'local-density-fallback-v1' :
                (candidate.target ? 'local-target-orbit-v6-canonical-gate' : 'local-depth-frontier-v1');

    if (!collisionProbe.rejected) {
        badges.push(collision.fallbackReason ? 'density fallback' : 'collision clear');
    }

    return {
        viewId: candidate.viewId,
        label: candidate.label,
        camera,
        planner: {
            version,
            role: candidate.viewRole,
            stationId: candidate.id,
            parentStationId: candidate.parentStationId,
            branch: {
                parentViewId: candidate.parentViewId,
                label: candidate.edgeLabel,
                yawDegrees: candidate.yawOffset,
                pitchDegrees: candidate.pitchOffset,
                move: candidate.move
            },
            decision: accepted ? 'accepted' : 'rejected',
            badges,
            scores: {
                ...geometry.scores,
                final: round3(finalScore),
                depthCoverage: round3(geometry.scores.depthCoverage),
                centerCoverage: round3(geometry.scores.centerCoverage),
                gridCoverage: round3(geometry.scores.gridCoverage),
                depthVariety: round3(geometry.scores.depthVariety),
                structure: round3(geometry.scores.structure)
            },
            geometry: geometry.geometry,
            navigation: {
                generation: candidate.generation,
                surfaceDepth: candidate.surfaceDepth,
                stepDistance: candidate.stepDistance,
                clearance: candidate.clearance
            },
            collision: collisionProbe,
            reasons
        },
        lookDirection,
        position: candidate.position.clone(),
        generation: candidate.generation
    };
};

const expandedBoundsContains = (bounds: RobustBounds, position: Vec3) => {
    const pad = bounds.radius * 0.25;
    return position.x >= bounds.min.x - pad &&
        position.x <= bounds.max.x + pad &&
        position.y >= bounds.min.y - pad &&
        position.y <= bounds.max.y + pad &&
        position.z >= bounds.min.z - pad &&
        position.z <= bounds.max.z + pad &&
        distanceBetween(position, bounds.center) <= bounds.radius * 1.7;
};

const shouldExploreFrom = (candidate: EvaluatedCandidate) => {
    const geometry = candidate.planner.geometry;
    return candidate.generation < MAX_FRONTIER_DEPTH &&
        candidate.planner.decision === 'accepted' &&
        candidate.planner.scores.nearClipRatio <= 0.12 &&
        candidate.planner.scores.noHitRatio <= 0.78 &&
        geometry.centerDepth > 0;
};

const frontierRank = (candidate: EvaluatedCandidate) => {
    const branch = candidate.planner.branch;
    const isCurrentForward = !branch.parentViewId && branch.yawDegrees === 0 && branch.pitchDegrees === 0;
    const straightAheadBonus = branch.yawDegrees === 0 && branch.pitchDegrees === 0 ? 0.2 : 0;
    return candidate.planner.scores.final + straightAheadBonus + (isCurrentForward ? 2 : 0) - candidate.generation * 0.1;
};

const compareFrontierSources = (a: EvaluatedCandidate, b: EvaluatedCandidate) => {
    if (a.generation !== b.generation) {
        return a.generation - b.generation;
    }

    return frontierRank(b) - frontierRank(a);
};

const rankedFrontierSources = (candidates: EvaluatedCandidate[]) => candidates
.filter(shouldExploreFrom)
.sort(compareFrontierSources);

const createForwardStation = (
    scene: Scene,
    bounds: RobustBounds,
    source: EvaluatedCandidate,
    stationIndex: number,
    stationPositions: Vec3[]
): Station | null => {
    const surfaceDepth = source.planner.geometry.centerDepth ||
        source.planner.geometry.depthQuantiles.p25 ||
        source.planner.geometry.depthQuantiles.median;
    const clearance = Math.max(scene.camera.near * 10, bounds.radius * 0.04);
    const minStep = Math.max(scene.camera.near * 16, bounds.radius * 0.045);
    const maxStep = Math.max(minStep, bounds.radius * 0.32);

    if (!isFinite(surfaceDepth) || surfaceDepth <= clearance + minStep) {
        return null;
    }

    const desiredStep = Math.max(minStep, Math.min(surfaceDepth * 0.5, maxStep));
    const stepDistance = Math.min(desiredStep, surfaceDepth - clearance);

    if (stepDistance < minStep * 0.75) {
        return null;
    }

    const position = source.position.clone().add(source.lookDirection.clone().mulScalar(stepDistance));
    if (!expandedBoundsContains(bounds, position)) {
        return null;
    }

    const minStationSpacing = Math.max(scene.camera.near * 12, bounds.radius * 0.035);
    if (stationPositions.some(stationPosition => distanceBetween(stationPosition, position) < minStationSpacing)) {
        return null;
    }

    return {
        id: `frontier-${stationIndex}`,
        label: `forward from ${source.planner.branch.label}`,
        position,
        azim: source.camera.azim,
        elevation: source.camera.elevation,
        distanceWorld: Math.max(scene.camera.sceneRadius * 0.2, Math.min(cameraDistanceWorld(source.camera), scene.camera.sceneRadius * 2.4)),
        fov: source.camera.fov,
        ortho: source.camera.ortho,
        role: 'frontier',
        parentStationId: source.planner.stationId,
        parentViewId: source.viewId,
        move: 'forward',
        generation: source.generation + 1,
        surfaceDepth: round3(surfaceDepth),
        stepDistance: round3(stepDistance),
        clearance: round3(clearance)
    };
};

const buildEvaluatedCandidates = (
    scene: Scene,
    original: CameraDebugState,
    sceneSamples: SplatSample[],
    samples: SplatSample[],
    visibilitySamples: SplatSample[],
    bounds: RobustBounds,
    helperBudget: number,
    _maxReviewFrames: number,
    targetBounds: RobustBounds | null,
    collision: CollisionContext
) => {
    const stations = buildStations(scene, original);
    const stationPositions = stations.map(station => station.position.clone());
    const evaluated: EvaluatedCandidate[] = [];
    const frontierQueue: EvaluatedCandidate[] = [];
    const explored = new Set<string>();
    let nextFrontierStation = 1;

    const evaluateBatch = (candidates: Candidate[]) => {
        const batch: EvaluatedCandidate[] = [];
        for (const candidate of candidates) {
            if (evaluated.length >= helperBudget) {
                break;
            }
            const evaluatedCandidate = evaluateCandidate(scene, candidate, samples, sceneSamples, bounds, original, collision, visibilitySamples);
            evaluated.push(evaluatedCandidate);
            batch.push(evaluatedCandidate);
        }
        return batch;
    };

    if (targetBounds) {
        const orbitBudget = Math.max(0, helperBudget - evaluated.length);
        evaluateBatch(createOrbitCandidates(scene, original, targetBounds, orbitBudget));
        return evaluated;
    }

    if (collision.fallbackReason) {
        const fallbackBudget = Math.max(0, helperBudget - evaluated.length);
        evaluateBatch(createDensityFallbackCandidates(scene, original, samples, bounds, fallbackBudget));
    }

    for (const station of stations) {
        const batch = evaluateBatch(createSweepCandidates(station, helperBudget - evaluated.length));
        frontierQueue.push(...rankedFrontierSources(batch));
    }

    while (evaluated.length < helperBudget && frontierQueue.length > 0) {
        const source = frontierQueue.shift();
        if (!source || explored.has(source.viewId)) {
            continue;
        }

        explored.add(source.viewId);
        const station = createForwardStation(scene, bounds, source, nextFrontierStation, stationPositions);
        if (!station) {
            continue;
        }

        nextFrontierStation++;
        stationPositions.push(station.position.clone());
        const batch = evaluateBatch(createSweepCandidates(station, helperBudget - evaluated.length));
        frontierQueue.push(...rankedFrontierSources(batch));
        frontierQueue.sort(compareFrontierSources);
    }

    return evaluated;
};

const filterSamplesToBounds = (samples: SplatSample[], bounds: RobustBounds) => {
    const pad = Math.max(0.05, bounds.radius * 0.25);
    const radiusLimit = bounds.radius + pad;
    const filtered = samples.filter((sample) => {
        if (sample.x < bounds.min.x - pad || sample.x > bounds.max.x + pad ||
            sample.y < bounds.min.y - pad || sample.y > bounds.max.y + pad ||
            sample.z < bounds.min.z - pad || sample.z > bounds.max.z + pad) {
            return false;
        }

        const dx = sample.x - bounds.center.x;
        const dy = sample.y - bounds.center.y;
        const dz = sample.z - bounds.center.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz) <= radiusLimit;
    });

    return filtered.length >= 16 ? filtered : samples;
};

const viewSimilarity = (a: EvaluatedCandidate, b: EvaluatedCandidate, bounds: RobustBounds) => {
    const directionSimilarity = clamp01((a.lookDirection.dot(b.lookDirection) + 1) * 0.5);
    const positionSimilarity = 1 - clamp01(distanceBetween(a.position, b.position) / Math.max(bounds.radius * 0.75, 0.1));
    return directionSimilarity * 0.62 + positionSimilarity * 0.38;
};

const plannedViewFromEvaluated = ({ lookDirection: _lookDirection, position: _position, generation: _generation, ...view }: EvaluatedCandidate): PlannedCameraView => view;

const selectDiverseViews = (evaluated: EvaluatedCandidate[], bounds: RobustBounds, maxReviewFrames: number): PlannedCameraView[] => {
    const byViewId = new Map(evaluated.map(candidate => [candidate.viewId, candidate]));
    const accepted = evaluated.filter(candidate => candidate.planner.decision === 'accepted');
    const pool = accepted
    .slice()
    .sort((a, b) => b.planner.scores.final - a.planner.scores.final);
    const selected: EvaluatedCandidate[] = [];
    const selectedIds = new Set<string>();

    const addCandidate = (candidate: EvaluatedCandidate) => {
        if (selectedIds.has(candidate.viewId) || selected.length >= maxReviewFrames) {
            return;
        }

        const similarity = selected.reduce((max, item) => Math.max(max, viewSimilarity(candidate, item, bounds)), 0);
        candidate.planner.scores.novelty = round3(1 - similarity);
        candidate.planner.scores.final = round3(candidate.planner.scores.final * 0.86 + candidate.planner.scores.novelty * 0.14);
        selectedIds.add(candidate.viewId);
        selected.push(candidate);
    };

    const addWithAncestors = (candidate: EvaluatedCandidate) => {
        const parentViewId = candidate.planner.branch.parentViewId;
        const parent = parentViewId ? byViewId.get(parentViewId) : undefined;
        if (parent && parent.planner.decision === 'accepted' && !selectedIds.has(parent.viewId)) {
            addWithAncestors(parent);
        }

        addCandidate(candidate);
    };

    const root = accepted.find(candidate => !candidate.planner.branch.parentViewId &&
        candidate.planner.branch.yawDegrees === 0 &&
        candidate.planner.branch.pitchDegrees === 0);
    if (root) {
        addCandidate(root);
    }

    while (selected.length < maxReviewFrames && pool.length > 0) {
        let bestIndex = 0;
        let bestScore = -Infinity;

        for (let i = 0; i < pool.length; i++) {
            const candidate = pool[i];
            const similarity = selected.reduce((max, item) => Math.max(max, viewSimilarity(candidate, item, bounds)), 0);
            const novelty = 1 - similarity;
            const score = candidate.planner.scores.final * 0.86 + novelty * 0.14;
            if (score > bestScore) {
                bestScore = score;
                bestIndex = i;
            }
        }

        const [next] = pool.splice(bestIndex, 1);
        addWithAncestors(next);
    }

    return selected.map(plannedViewFromEvaluated);
};

const buildSemanticCandidateSet = (events: Events, scene: Scene, options: PlannerOptions = {}) => {
    const original = options.originalCamera ?? events.invoke('camera.debugState') as CameraDebugState;
    const samples = collectSplatSamples(events, scene);
    if (samples.length === 0) {
        events.fire('toast', 'No splat samples available. Artisan multiview candidates disabled.', 'error');
        return null;
    }

    const helperBudget = Math.max(1, Math.min(MAX_HELPER_BUDGET, options.helperBudget ?? DEFAULT_HELPER_BUDGET));
    const maxReviewFrames = Math.max(1, Math.min(72, options.maxReviewFrames ?? DEFAULT_REVIEW_FRAME_BUDGET));
    const sceneBounds = percentileBounds(samples) ?? fallbackBounds(scene);
    const targetBounds = targetBoundsToRobustBounds(options.targetBounds);
    const bounds = targetBounds ?? sceneBounds;
    const selectedSamples = collectIndexedSplatSamples(options.targetSplat, options.targetIndexRanges);
    const scoringSamples = selectedSamples.length >= 8 ?
        selectedSamples :
        (targetBounds ? filterSamplesToBounds(samples, targetBounds) : samples);
    const visibilitySamples = scoringSamples.length >= 8 ? scoringSamples : samples;
    const collision = buildCollisionContext(events);

    try {
        const evaluated = buildEvaluatedCandidates(
            scene,
            original,
            samples,
            scoringSamples,
            visibilitySamples,
            bounds,
            helperBudget,
            maxReviewFrames,
            targetBounds,
            collision
        );

        return { evaluated, bounds, maxReviewFrames };
    } finally {
        applyPose(
            scene,
            vectorFromDebug(original.position),
            vectorFromDebug(original.target),
            original.fov,
            original.ortho
        );
    }
};

const buildSemanticViewCandidates = (events: Events, scene: Scene, options: PlannerOptions = {}): PlannedCameraView[] => {
    const set = buildSemanticCandidateSet(events, scene, options);
    return set ? set.evaluated.map(plannedViewFromEvaluated) : [];
};

const buildSemanticViewPlan = (events: Events, scene: Scene, options: PlannerOptions = {}): PlannedCameraView[] => {
    const set = buildSemanticCandidateSet(events, scene, options);
    return set ? selectDiverseViews(set.evaluated, set.bounds, set.maxReviewFrames) : [];
};

const applyPlannedView = (scene: Scene, view: PlannedCameraView) => {
    applyPose(scene, vectorFromDebug(view.camera.position), vectorFromDebug(view.camera.target), view.camera.fov, view.camera.ortho);
};

export {
    applyPlannedView,
    buildSemanticViewCandidates,
    buildSemanticViewPlan
};

export type {
    PlannerFrameMetadata,
    PlannedCameraView,
    PlannerScores,
    PlannerGeometry
};
