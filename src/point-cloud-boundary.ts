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
    pointRadius: number;
    pointOpacity: number;
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
    pointRadius: 2,
    pointOpacity: 1,
    manualBounds: null
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const isFiniteVec3 = (value: unknown): value is Vec3Tuple => Array.isArray(value) &&
    value.length === 3 && value.every(component => typeof component === 'number' && Number.isFinite(component));

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
    return {
        enabled: candidate.enabled === undefined ? DEFAULT_POINT_CLOUD_BOUNDARY_SETTINGS.enabled : candidate.enabled === true,
        boundsMode,
        preview,
        fadeWidth: clamp(Number(candidate.fadeWidth) || DEFAULT_POINT_CLOUD_BOUNDARY_SETTINGS.fadeWidth, 0.01, 10000),
        pointRadius: clamp(Number(candidate.pointRadius) || DEFAULT_POINT_CLOUD_BOUNDARY_SETTINGS.pointRadius, 0.5, 8),
        pointOpacity: clamp(Number.isFinite(Number(candidate.pointOpacity)) ? Number(candidate.pointOpacity) : 1, 0, 1),
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
    automaticBounds: OrientedBounds | null = null
): PointCloudBoundaryState => {
    const settings = sanitizePointCloudBoundarySettings(input);
    const bounds = settings.boundsMode === 'manual' ? settings.manualBounds : automaticBounds;
    const signedDistance = bounds ? signedDistanceToOrientedBox(cameraPosition, bounds) : null;
    if (!settings.enabled) return { signedDistance, weight: 0, boundsMode: settings.boundsMode };
    if (settings.preview !== 'automatic') {
        const forcedWeight = settings.preview === 'inside' ? 0 : settings.preview === 'boundary' ? 0.5 : 1;
        return { signedDistance, weight: forcedWeight, boundsMode: settings.boundsMode };
    }
    return {
        signedDistance,
        weight: signedDistance === null ? 0 : smoothstep(-settings.fadeWidth, settings.fadeWidth, signedDistance),
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

const deriveRobustAutomaticBounds = (samples: AutomaticBoundsSample[]): OrientedBounds | null => {
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
    for (const position of retained) {
        for (let axis = 0; axis < 3; axis++) {
            minimum[axis] = Math.min(minimum[axis], position[axis]);
            maximum[axis] = Math.max(maximum[axis], position[axis]);
        }
    }
    return {
        center: minimum.map((value, axis) => (value + maximum[axis]) * 0.5) as Vec3Tuple,
        halfExtents: minimum.map((value, axis) => Math.max(0.01, (maximum[axis] - value) * 0.5)) as Vec3Tuple,
        rotation: IDENTITY_ROTATION.map(axis => [...axis]) as Rotation3
    };
};

export {
    DEFAULT_POINT_CLOUD_BOUNDARY_SETTINGS,
    calculatePointCloudBoundaryState,
    deriveRobustAutomaticBounds,
    sanitizePointCloudBoundarySettings,
    signedDistanceToOrientedBox
};
export type {
    AutomaticBoundsSample,
    OrientedBounds,
    PointCloudBoundarySettings,
    PointCloudBoundaryState,
    Rotation3,
    Vec3Tuple
};
