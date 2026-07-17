type Vec3Tuple = [number, number, number];
type Rotation3 = [Vec3Tuple, Vec3Tuple, Vec3Tuple];

type OrientedBounds = {
    center: Vec3Tuple;
    halfExtents: Vec3Tuple;
    rotation: Rotation3;
};

type PointCloudBoundarySettings = {
    enabled: boolean;
    boundsMode: 'manual' | 'automatic';
    preview: 'automatic' | 'inside' | 'boundary' | 'outside';
    fadeWidth: number;
    automaticShape: 'footprint' | 'box';
    automaticTrimPercent: number;
    automaticPadding: number;
    pointShape: 'fixed' | 'gaussian';
    pointRadius: number;
    gaussianScale: number;
    pointOpacity: number;
    pointTint: Vec3Tuple;
    pointTintStrength: number;
    pointSaturation: number;
    manualBounds: OrientedBounds | null;
};

type PointCloudBoundaryState = {
    signedDistance: number | null;
    weight: number;
    boundsMode: PointCloudBoundarySettings['boundsMode'];
};

type AutomaticBoundsSample = {
    position: Vec3Tuple;
    visible: boolean;
    deleted: boolean;
};

type AutomaticSceneEnvelope = {
    bounds: OrientedBounds;
    footprint: {
        origin: [number, number];
        cellSize: number;
        width: number;
        height: number;
        signedDistances: Float32Array;
    };
};

const IDENTITY_ROTATION: Rotation3 = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1]
];

const DEFAULT_POINT_CLOUD_BOUNDARY_SETTINGS: PointCloudBoundarySettings = {
    enabled: true,
    boundsMode: 'automatic',
    preview: 'automatic',
    fadeWidth: 1,
    automaticShape: 'footprint',
    automaticTrimPercent: 0.5,
    automaticPadding: 0.35,
    pointShape: 'fixed',
    pointRadius: 2,
    gaussianScale: 0.25,
    pointOpacity: 1,
    pointTint: [1, 1, 1],
    pointTintStrength: 0,
    pointSaturation: 1,
    manualBounds: null
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const isFiniteVec3 = (value: unknown): value is Vec3Tuple => Array.isArray(value) &&
    value.length === 3 && value.every(component => typeof component === 'number' && Number.isFinite(component));
const finiteNumber = (value: unknown, fallback: number) => {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
};
const sanitizeColor = (value: unknown, fallback: Vec3Tuple): Vec3Tuple => {
    return isFiniteVec3(value) ? value.map(component => clamp(component, 0, 1)) as Vec3Tuple : [...fallback];
};

const normalize = (value: Vec3Tuple, fallback: Vec3Tuple): Vec3Tuple => {
    const length = Math.hypot(value[0], value[1], value[2]);
    if (!Number.isFinite(length) || length < 1e-6) return [...fallback];
    return [value[0] / length, value[1] / length, value[2] / length];
};

const sanitizeRotation = (value: unknown): Rotation3 => {
    if (!Array.isArray(value) || value.length !== 3 || !value.every(isFiniteVec3)) {
        return IDENTITY_ROTATION.map(axis => [...axis]) as Rotation3;
    }
    return [
        normalize(value[0], IDENTITY_ROTATION[0]),
        normalize(value[1], IDENTITY_ROTATION[1]),
        normalize(value[2], IDENTITY_ROTATION[2])
    ];
};

const sanitizeBounds = (value: unknown): OrientedBounds | null => {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Partial<OrientedBounds>;
    if (!isFiniteVec3(candidate.center) || !isFiniteVec3(candidate.halfExtents)) return null;
    return {
        center: [...candidate.center],
        halfExtents: candidate.halfExtents.map(component => Math.max(0.01, component)) as Vec3Tuple,
        rotation: sanitizeRotation(candidate.rotation)
    };
};

const sanitizePointCloudBoundarySettings = (value: unknown): PointCloudBoundarySettings => {
    const candidate = value && typeof value === 'object' ? value as Partial<PointCloudBoundarySettings> : {};
    const boundsMode = candidate.boundsMode === 'manual' || candidate.boundsMode === 'automatic' ?
        candidate.boundsMode : DEFAULT_POINT_CLOUD_BOUNDARY_SETTINGS.boundsMode;
    const preview = ['automatic', 'inside', 'boundary', 'outside'].includes(candidate.preview as string) ?
        candidate.preview as PointCloudBoundarySettings['preview'] : DEFAULT_POINT_CLOUD_BOUNDARY_SETTINGS.preview;
    const automaticShape = candidate.automaticShape === 'box' || candidate.automaticShape === 'footprint' ?
        candidate.automaticShape : DEFAULT_POINT_CLOUD_BOUNDARY_SETTINGS.automaticShape;
    const pointShape = candidate.pointShape === 'fixed' || candidate.pointShape === 'gaussian' ?
        candidate.pointShape : DEFAULT_POINT_CLOUD_BOUNDARY_SETTINGS.pointShape;
    return {
        enabled: candidate.enabled === undefined ? DEFAULT_POINT_CLOUD_BOUNDARY_SETTINGS.enabled : candidate.enabled === true,
        boundsMode,
        preview,
        fadeWidth: clamp(Number(candidate.fadeWidth) || DEFAULT_POINT_CLOUD_BOUNDARY_SETTINGS.fadeWidth, 0.01, 10000),
        automaticShape,
        automaticTrimPercent: clamp(finiteNumber(candidate.automaticTrimPercent, DEFAULT_POINT_CLOUD_BOUNDARY_SETTINGS.automaticTrimPercent), 0, 5),
        automaticPadding: clamp(finiteNumber(candidate.automaticPadding, DEFAULT_POINT_CLOUD_BOUNDARY_SETTINGS.automaticPadding), -5, 20),
        pointShape,
        pointRadius: clamp(Number(candidate.pointRadius) || DEFAULT_POINT_CLOUD_BOUNDARY_SETTINGS.pointRadius, 0.5, 8),
        gaussianScale: clamp(finiteNumber(candidate.gaussianScale, DEFAULT_POINT_CLOUD_BOUNDARY_SETTINGS.gaussianScale), 0.01, 2),
        pointOpacity: clamp(Number.isFinite(Number(candidate.pointOpacity)) ? Number(candidate.pointOpacity) : 1, 0, 1),
        pointTint: sanitizeColor(candidate.pointTint, DEFAULT_POINT_CLOUD_BOUNDARY_SETTINGS.pointTint),
        pointTintStrength: clamp(finiteNumber(candidate.pointTintStrength, DEFAULT_POINT_CLOUD_BOUNDARY_SETTINGS.pointTintStrength), 0, 1),
        pointSaturation: clamp(finiteNumber(candidate.pointSaturation, DEFAULT_POINT_CLOUD_BOUNDARY_SETTINGS.pointSaturation), 0, 2),
        manualBounds: sanitizeBounds(candidate.manualBounds)
    };
};

const signedDistanceToOrientedBox = (position: Vec3Tuple, bounds: OrientedBounds) => {
    const delta: Vec3Tuple = [
        position[0] - bounds.center[0],
        position[1] - bounds.center[1],
        position[2] - bounds.center[2]
    ];
    const local = bounds.rotation.map(axis => Math.abs(
        delta[0] * axis[0] + delta[1] * axis[1] + delta[2] * axis[2]
    )) as Vec3Tuple;
    const q: Vec3Tuple = [
        local[0] - bounds.halfExtents[0],
        local[1] - bounds.halfExtents[1],
        local[2] - bounds.halfExtents[2]
    ];
    const outside = Math.hypot(Math.max(q[0], 0), Math.max(q[1], 0), Math.max(q[2], 0));
    const inside = Math.min(Math.max(q[0], q[1], q[2]), 0);
    return outside + inside;
};

const smoothstep = (edge0: number, edge1: number, value: number) => {
    const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
};

const calculatePointCloudBoundaryState = (
    input: PointCloudBoundarySettings,
    cameraPosition: Vec3Tuple,
    automaticBounds: OrientedBounds | AutomaticSceneEnvelope | null = null
): PointCloudBoundaryState => {
    const settings = sanitizePointCloudBoundarySettings(input);
    let automaticDistance: number | null = null;
    if (automaticBounds) {
        automaticDistance = 'footprint' in automaticBounds ?
            signedDistanceToAutomaticSceneEnvelope(cameraPosition, automaticBounds) :
            signedDistanceToOrientedBox(cameraPosition, automaticBounds);
    }
    const signedDistance = settings.boundsMode === 'manual' ?
        settings.manualBounds ? signedDistanceToOrientedBox(cameraPosition, settings.manualBounds) : null :
        automaticDistance;
    if (!settings.enabled) return { signedDistance, weight: 0, boundsMode: settings.boundsMode };
    if (settings.preview !== 'automatic') {
        const forcedWeight = settings.preview === 'inside' ? 0 : settings.preview === 'boundary' ? 0.5 : 1;
        return { signedDistance, weight: forcedWeight, boundsMode: settings.boundsMode };
    }
    return {
        signedDistance,
        weight: signedDistance === null ? 0 : smoothstep(0, settings.fadeWidth, signedDistance),
        boundsMode: settings.boundsMode
    };
};

const quantile = (sorted: number[], fraction: number) => {
    const index = (sorted.length - 1) * fraction;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const mix = index - lower;
    return sorted[lower] * (1 - mix) + sorted[upper] * mix;
};

const deriveRobustAutomaticBounds = (
    samples: AutomaticBoundsSample[],
    trimFraction = 0.005,
    padding = 0
): OrientedBounds | null => {
    const positions = samples
    .filter(sample => sample.visible && !sample.deleted && isFiniteVec3(sample.position))
    .map(sample => sample.position);
    if (positions.length === 0) return null;

    const axes = [0, 1, 2].map(axis => positions.map(position => position[axis]).sort((a, b) => a - b));
    const fences = axes.map((values) => {
        const q1 = quantile(values, 0.25);
        const q3 = quantile(values, 0.75);
        const iqr = Math.max(q3 - q1, 1e-6);
        return [q1 - iqr * 3, q3 + iqr * 3];
    });
    const robust = positions.filter(position => position.every((component, axis) => {
        return component >= fences[axis][0] && component <= fences[axis][1];
    }));
    const retained = robust.length > 0 ? robust : positions;
    const minimum = [Infinity, Infinity, Infinity] as Vec3Tuple;
    const maximum = [-Infinity, -Infinity, -Infinity] as Vec3Tuple;
    if (retained.length >= 64) {
        const trim = clamp(trimFraction, 0, 0.05);
        for (let axis = 0; axis < 3; axis++) {
            const values = retained.map(position => position[axis]).sort((a, b) => a - b);
            minimum[axis] = quantile(values, trim);
            maximum[axis] = quantile(values, 1 - trim);
        }
    } else {
        for (const position of retained) {
            for (let axis = 0; axis < 3; axis++) {
                minimum[axis] = Math.min(minimum[axis], position[axis]);
                maximum[axis] = Math.max(maximum[axis], position[axis]);
            }
        }
    }
    return {
        center: minimum.map((value, axis) => (value + maximum[axis]) * 0.5) as Vec3Tuple,
        halfExtents: minimum.map((value, axis) => Math.max(0.01, (maximum[axis] - value) * 0.5 + padding)) as Vec3Tuple,
        rotation: IDENTITY_ROTATION.map(axis => [...axis]) as Rotation3
    };
};

const chamferDistances = (mask: Uint8Array, width: number, height: number, target: number) => {
    const distances = new Float32Array(mask.length);
    distances.fill(Number.POSITIVE_INFINITY);
    for (let index = 0; index < mask.length; index++) {
        if (mask[index] === target) distances[index] = 0;
    }
    const diagonal = Math.SQRT2;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const index = y * width + x;
            if (x > 0) distances[index] = Math.min(distances[index], distances[index - 1] + 1);
            if (y > 0) distances[index] = Math.min(distances[index], distances[index - width] + 1);
            if (x > 0 && y > 0) distances[index] = Math.min(distances[index], distances[index - width - 1] + diagonal);
            if (x + 1 < width && y > 0) distances[index] = Math.min(distances[index], distances[index - width + 1] + diagonal);
        }
    }
    for (let y = height - 1; y >= 0; y--) {
        for (let x = width - 1; x >= 0; x--) {
            const index = y * width + x;
            if (x + 1 < width) distances[index] = Math.min(distances[index], distances[index + 1] + 1);
            if (y + 1 < height) distances[index] = Math.min(distances[index], distances[index + width] + 1);
            if (x + 1 < width && y + 1 < height) distances[index] = Math.min(distances[index], distances[index + width + 1] + diagonal);
            if (x > 0 && y + 1 < height) distances[index] = Math.min(distances[index], distances[index + width - 1] + diagonal);
        }
    }
    return distances;
};

const deriveAutomaticSceneEnvelope = (
    samples: AutomaticBoundsSample[],
    trimFraction = 0.005,
    padding = 0.35
): AutomaticSceneEnvelope | null => {
    const coreBounds = deriveRobustAutomaticBounds(samples, trimFraction);
    if (!coreBounds) return null;
    const bounds: OrientedBounds = {
        ...coreBounds,
        halfExtents: coreBounds.halfExtents.map(value => Math.max(0.01, value + padding)) as Vec3Tuple
    };
    const positions = samples
    .filter(sample => sample.visible && !sample.deleted && isFiniteVec3(sample.position))
    .map(sample => sample.position)
    .filter(sample => signedDistanceToOrientedBox(sample, coreBounds) <= 0);
    if (positions.length === 0) return null;

    const minX = bounds.center[0] - bounds.halfExtents[0];
    const maxX = bounds.center[0] + bounds.halfExtents[0];
    const minZ = bounds.center[2] - bounds.halfExtents[2];
    const maxZ = bounds.center[2] + bounds.halfExtents[2];
    const span = Math.max(maxX - minX, maxZ - minZ);
    const cellSize = clamp(span / 160, 0.1, 1);
    const paddingCells = Math.ceil(Math.abs(padding) / cellSize);
    const margin = paddingCells + 2;
    const width = Math.max(3, Math.ceil((maxX - minX) / cellSize) + margin * 2 + 1);
    const height = Math.max(3, Math.ceil((maxZ - minZ) / cellSize) + margin * 2 + 1);
    const origin: [number, number] = [minX - margin * cellSize, minZ - margin * cellSize];
    const occupied = new Uint8Array(width * height);
    for (const sample of positions) {
        const x = clamp(Math.floor((sample[0] - origin[0]) / cellSize), 0, width - 1);
        const y = clamp(Math.floor((sample[2] - origin[1]) / cellSize), 0, height - 1);
        occupied[y * width + x] = 1;
    }

    if (paddingCells > 0) {
        const rawToOccupied = chamferDistances(occupied, width, height, 1);
        const rawToEmpty = chamferDistances(occupied, width, height, 0);
        for (let index = 0; index < occupied.length; index++) {
            const rawDistance = (occupied[index] ? -(rawToEmpty[index] - 0.5) : rawToOccupied[index] - 0.5) * cellSize;
            occupied[index] = rawDistance <= padding ? 1 : 0;
        }
    }

    const toOccupied = chamferDistances(occupied, width, height, 1);
    const toEmpty = chamferDistances(occupied, width, height, 0);
    const signedDistances = new Float32Array(occupied.length);
    for (let index = 0; index < occupied.length; index++) {
        signedDistances[index] = (occupied[index] ? -(toEmpty[index] - 0.5) : toOccupied[index] - 0.5) * cellSize;
    }
    return { bounds, footprint: { origin, cellSize, width, height, signedDistances } };
};

function signedDistanceToAutomaticSceneEnvelope(position: Vec3Tuple, envelope: AutomaticSceneEnvelope) {
    const { bounds, footprint } = envelope;
    const gridX = Math.floor((position[0] - footprint.origin[0]) / footprint.cellSize);
    const gridY = Math.floor((position[2] - footprint.origin[1]) / footprint.cellSize);
    let horizontal: number;
    if (gridX >= 0 && gridX < footprint.width && gridY >= 0 && gridY < footprint.height) {
        horizontal = footprint.signedDistances[gridY * footprint.width + gridX];
    } else {
        const clampedX = clamp(gridX, 0, footprint.width - 1);
        const clampedY = clamp(gridY, 0, footprint.height - 1);
        horizontal = footprint.signedDistances[clampedY * footprint.width + clampedX] +
            Math.hypot(gridX - clampedX, gridY - clampedY) * footprint.cellSize;
    }
    const minY = bounds.center[1] - bounds.halfExtents[1];
    const maxY = bounds.center[1] + bounds.halfExtents[1];
    let vertical = -Math.min(position[1] - minY, maxY - position[1]);
    if (position[1] < minY) vertical = minY - position[1];
    else if (position[1] > maxY) vertical = position[1] - maxY;
    return Math.max(horizontal, vertical);
}

export {
    DEFAULT_POINT_CLOUD_BOUNDARY_SETTINGS,
    calculatePointCloudBoundaryState,
    deriveAutomaticSceneEnvelope,
    deriveRobustAutomaticBounds,
    sanitizePointCloudBoundarySettings,
    signedDistanceToAutomaticSceneEnvelope,
    signedDistanceToOrientedBox
};
export type {
    AutomaticBoundsSample,
    AutomaticSceneEnvelope,
    OrientedBounds,
    PointCloudBoundarySettings,
    PointCloudBoundaryState,
    Rotation3,
    Vec3Tuple
};
