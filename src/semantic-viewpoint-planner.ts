import { Vec3 } from 'playcanvas';

import { Events } from './events';
import { Scene } from './scene';
import { Splat } from './splat';
import { State } from './splat-state';

const DEFAULT_HELPER_BUDGET = 30;
const DEFAULT_REVIEW_FRAME_BUDGET = 10;
const SAMPLE_TARGET = 90000;
const GRID_WIDTH = 24;
const GRID_HEIGHT = 14;
const EPSILON = 1e-6;
const MAX_FRONTIER_DEPTH = 2;

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

type PlannerCapture = {
    mode?: 'normal' | 'debug';
    recommended: boolean;
    captured: boolean;
    reasons: string[];
};

type PlannerFrameMetadata = {
    version: string;
    role: 'seed' | 'yaw-sweep' | 'frontier';
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
};

type EvaluatedCandidate = PlannedCameraView & {
    lookDirection: Vec3;
    position: Vec3;
    generation: number;
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

const scoreProjectedSamples = (scene: Scene, samples: SplatSample[], bounds: RobustBounds, position: Vec3) => {
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
    const outsidePenalty = clamp01(outsideDistance / Math.max(bounds.radius, 0.1));

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

    if (hitCoverage < 0.08) reasons.push('low depth coverage');
    if (centerCoverage < 0.12) reasons.push('weak center hits');
    if (edgeHitRatio > 0.58) reasons.push('edge-heavy hits');
    if (nearClipRatio > 0.12) reasons.push('too close to surface');
    if (depthVariety < 0.08) reasons.push('flat depth');
    if (outsidePenalty > 0.2) reasons.push('far outside robust bounds');

    if (hitCoverage >= 0.16) badges.push('surface coverage');
    if (centerCoverage >= 0.2) badges.push('center anchored');
    if (gridCoverage >= 0.58) badges.push('wide spread');
    if (depthVariety >= 0.16) badges.push('depth variety');
    if (structure >= 0.18) badges.push('local structure');

    const accepted = scores.final >= 0.42 &&
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

const evaluateCandidate = (scene: Scene, candidate: Candidate, samples: SplatSample[], bounds: RobustBounds, original: CameraDebugState): EvaluatedCandidate => {
    const target = targetFromStation(candidate, candidate.yawOffset, candidate.pitchOffset);
    applyPose(scene, candidate.position, target, candidate.fov, candidate.ortho);

    const camera = debugFromPose(scene, candidate.position, target, original);
    const geometry = scoreProjectedSamples(scene, samples, bounds, candidate.position);
    const lookDirection = new Vec3().sub2(target, candidate.position).normalize();

    return {
        viewId: candidate.viewId,
        label: candidate.label,
        camera,
        planner: {
            version: 'local-depth-frontier-v1',
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
            decision: geometry.accepted ? 'accepted' : 'rejected',
            badges: geometry.badges,
            scores: {
                ...geometry.scores,
                final: round3(geometry.scores.final),
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
            reasons: geometry.reasons
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
    samples: SplatSample[],
    bounds: RobustBounds,
    helperBudget: number
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
            const evaluatedCandidate = evaluateCandidate(scene, candidate, samples, bounds, original);
            evaluated.push(evaluatedCandidate);
            batch.push(evaluatedCandidate);
        }
        return batch;
    };

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

const viewSimilarity = (a: EvaluatedCandidate, b: EvaluatedCandidate, bounds: RobustBounds) => {
    const directionSimilarity = clamp01((a.lookDirection.dot(b.lookDirection) + 1) * 0.5);
    const positionSimilarity = 1 - clamp01(distanceBetween(a.position, b.position) / Math.max(bounds.radius * 0.75, 0.1));
    return directionSimilarity * 0.62 + positionSimilarity * 0.38;
};

const selectDiverseViews = (evaluated: EvaluatedCandidate[], bounds: RobustBounds, maxReviewFrames: number): PlannedCameraView[] => {
    const byViewId = new Map(evaluated.map(candidate => [candidate.viewId, candidate]));
    const pool = evaluated
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
        if (parent && !selectedIds.has(parent.viewId)) {
            addWithAncestors(parent);
        }

        addCandidate(candidate);
    };

    const root = evaluated.find(candidate => !candidate.planner.branch.parentViewId &&
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

    return selected.map(({ lookDirection: _lookDirection, position: _position, generation: _generation, ...view }) => view);
};

const fallbackCurrentView = (scene: Scene, original: CameraDebugState): PlannedCameraView[] => {
    const position = vectorFromDebug(original.position);
    const target = vectorFromDebug(original.target);
    return [{
        viewId: 'planner-current-fallback',
        label: 'current view',
        camera: debugFromPose(scene, position, target, original),
        planner: {
            version: 'local-depth-frontier-v1',
            role: 'seed',
            stationId: 'current',
            branch: {
                label: 'forward',
                yawDegrees: 0,
                pitchDegrees: 0
            },
            decision: 'accepted',
            badges: ['fallback'],
            scores: {
                final: 0.5,
                depthCoverage: 0,
                centerCoverage: 0,
                gridCoverage: 0,
                noHitRatio: 1,
                edgeHitRatio: 0,
                nearClipRatio: 0,
                depthVariety: 0,
                structure: 0,
                image: 0,
                novelty: 1
            },
            geometry: {
                sampleGrid: [GRID_WIDTH, GRID_HEIGHT],
                validHits: 0,
                occupiedCells: 0,
                centerDepth: 0,
                depthQuantiles: { min: 0, p25: 0, median: 0, p75: 0, max: 0 },
                robustBoundsId: 'none'
            },
            navigation: {
                generation: 0
            },
            reasons: ['no splat samples available']
        }
    }];
};

const buildSemanticViewPlan = (events: Events, scene: Scene, options: PlannerOptions = {}): PlannedCameraView[] => {
    const original = events.invoke('camera.debugState') as CameraDebugState;
    const samples = collectSplatSamples(events, scene);
    if (samples.length === 0) {
        return fallbackCurrentView(scene, original);
    }

    const helperBudget = Math.max(1, Math.min(72, options.helperBudget ?? DEFAULT_HELPER_BUDGET));
    const maxReviewFrames = Math.max(1, Math.min(72, options.maxReviewFrames ?? DEFAULT_REVIEW_FRAME_BUDGET));
    const bounds = percentileBounds(samples) ?? fallbackBounds(scene);
    const evaluated = buildEvaluatedCandidates(scene, original, samples, bounds, helperBudget);

    return selectDiverseViews(evaluated, bounds, maxReviewFrames);
};

const applyPlannedView = (scene: Scene, view: PlannedCameraView) => {
    applyPose(scene, vectorFromDebug(view.camera.position), vectorFromDebug(view.camera.target), view.camera.fov, view.camera.ortho);
};

export {
    applyPlannedView,
    buildSemanticViewPlan
};

export type {
    PlannerFrameMetadata,
    PlannedCameraView,
    PlannerScores,
    PlannerGeometry
};
