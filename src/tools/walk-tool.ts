import { Color, Mat4, Quat, Vec3 } from 'playcanvas';

import { Camera } from '../camera';
import { Events } from '../events';
import { Scene } from '../scene';

type ArrowDirection = 'north' | 'south' | 'east' | 'west';
type WalkInputState = {
    forward?: boolean;
    backward?: boolean;
    left?: boolean;
    right?: boolean;
    sprint?: boolean;
    slide?: boolean;
    jump?: boolean;
    up?: boolean;
    down?: boolean;
};

type CollisionProxyState = {
    pending: boolean;
    frontDistance: number | null;
    viewDistance: number;
    blocked: boolean;
    lastSampleAt: number;
    lastReportAt: number;
    sampleMs: number | null;
};

type PresetTransform = {
    position: { x: number; y: number; z: number };
    rotationEuler: { x: number; y: number; z: number };
    scale: { x: number; y: number; z: number };
};

type CollisionMeshLoadDetails = {
    url: string;
    blockingEnabled?: boolean;
    floorY?: number | null;
    requestId?: number | string | null;
    transform?: PresetTransform;
};

type CollisionMeshHit = {
    blocked: boolean;
    triangle?: number;
};

type GroundMeshHit = {
    y: number;
    triangle: number | null;
    source?: 'mesh' | 'cached' | 'locked';
};

type CollisionDebugTriangle = {
    index: number;
    triangle: CollisionTriangle;
};

type CollisionDebugVoxel = {
    x: number;
    y: number;
    z: number;
    size: number;
    blocking: boolean;
};

type CollisionDebugSample = {
    at: string;
    perfNow: number;
    kind: string;
    details: Record<string, unknown>;
};

type PlayerCollisionBody = {
    head: Vec3;
    eye: Vec3;
    height: number;
    eyeHeight: number;
    radius: number;
};

const tmpVec = new Vec3();
const forwardVec = new Vec3();
const rightVec = new Vec3();
const moveVec = new Vec3();
const screenPos = new Vec3();
const COLLISION_SAMPLE_INTERVAL_MS = 700;
const COLLISION_EMBEDDED_SAMPLE_INTERVAL_MS = 450;
const COLLISION_SLOW_SAMPLE_INTERVAL_MS = 1400;
const COLLISION_REPORT_INTERVAL_MS = 1800;
const COLLISION_SLOW_SAMPLE_MS = 28;
const COLLISION_MAX_BLOCK_ELEVATION_DEG = 24;
const COLLISION_POINTER_LOOK_DEFER_MS = 160;
const COLLISION_POINTER_LOOK_MAX_DEFER_MS = 900;
const COLLISION_MESH_CELL_SIZE = 0.5;
const COLLISION_MESH_PLAYER_HEIGHT = 1.65;
const COLLISION_MESH_EYE_HEIGHT = 1.47;
const COLLISION_MESH_CAPSULE_RADIUS = 0.28;
const COLLISION_MESH_STEP_HEIGHT = 0.12;

const isBoardDemoEditorHost = () => (
    typeof window !== 'undefined' &&
    /^board-demo-editor(?:-[a-z0-9-]+)?\.vercel\.app$/i.test(window.location.hostname)
);

const shouldHideWalkHeightControls = () => {
    if (typeof window === 'undefined') {
        return false;
    }
    const params = new URLSearchParams(window.location.search);
    return params.get('hideWalkHeightControls') === '1' ||
        params.get('walkHeightControls') === '0' ||
        isBoardDemoEditorHost();
};
const COLLISION_MESH_HEAD_CLEARANCE = 0;
const COLLISION_MESH_WALK_SPEED = 1.8;
const COLLISION_MESH_HEIGHT_ADJUST_SPEED = 0.65;
const COLLISION_MESH_SPRINT_MULTIPLIER = 1.65;
const COLLISION_MESH_JUMP_SPEED = 2.9;
const COLLISION_MESH_GRAVITY = 7.5;
const COLLISION_MESH_GROUND_SNAP = 0.42;
const COLLISION_MESH_GROUND_PROBE_RADIUS = 0.22;
const COLLISION_MESH_GROUND_CACHE_DROP = 0.45;
const COLLISION_MESH_GROUND_CACHE_RISE = 0.16;
const COLLISION_MESH_BLOCKING_ENABLED = true;
const COLLISION_MESH_FIRST_PERSON_DISTANCE = 0.035;
const COLLISION_MESH_THIRD_PERSON_DISTANCE = 2.2;
const COLLISION_MESH_FIRST_PERSON_SNAP_DISTANCE = 0.45;
const COLLISION_MESH_VIEW_DISTANCE_STEP = 0.52;
const COLLISION_MESH_DEPENETRATE_RADIUS = 0.9;
const COLLISION_MESH_DEPENETRATE_STEP = 0.05;
const COLLISION_MESH_REPORT_INTERVAL_MS = 900;
const COLLISION_MESH_BLOCK_REPORT_INTERVAL_MS = 180;
const COLLISION_MESH_STUCK_MS = 650;
const COLLISION_MESH_MAX_FLOOR_NORMAL_Y = 0.75;
const COLLISION_MESH_SWEEP_STEP = 0.05;
const COLLISION_DEBUG_TRIANGLE_RADIUS = 2.2;
const COLLISION_DEBUG_TRIANGLE_LIMIT = 120;
const COLLISION_DEBUG_HISTORY_LIMIT = 900;
const COLLISION_MESH_PREVIEW_TRIANGLE_LIMIT = 900;
const COLLISION_MESH_DEBUG_DEFAULT_VOXEL_SIZE = 0.18;
const COLLISION_MESH_DEBUG_VOXEL_MAX_CELLS = 1800;
const COLLISION_MESH_DEBUG_VOXEL_TRIANGLE_LIMIT = 1200;
const COLLISION_MESH_DEBUG_VOXEL_TRIANGLE_SAMPLE_LIMIT = 36;
const COLLISION_MESH_PREVIEW_VOXEL_LIMIT = 460;
const COLLISION_MESH_PREVIEW_MINI_VOXEL_LIMIT = 1200;
const COLLISION_MESH_DEBUG_VOXEL_VISUAL_SCALE = 0.72;
const COLLISION_MESH_PREVIEW_CANVAS_SIZE = 148;
const COLLISION_MESH_PREVIEW_CANVAS_PADDING = 12;
const COLLISION_DEBUG_PLAYER_COLOR = new Color(0.1, 0.72, 1, 1);
const COLLISION_DEBUG_EYE_COLOR = new Color(0.82, 0.96, 1, 1);
const COLLISION_DEBUG_FLOOR_COLOR = new Color(0.18, 1, 0.38, 1);
const COLLISION_DEBUG_WALL_COLOR = new Color(1, 0.18, 0.12, 1);
const COLLISION_DEBUG_PREVIEW_FLOOR_COLOR = new Color(0.18, 1, 0.48, 1);
const COLLISION_DEBUG_PREVIEW_WALL_COLOR = new Color(1, 0.28, 0.18, 1);
const COLLISION_DEBUG_HIT_COLOR = new Color(1, 0, 0.9, 1);
const COLLISION_DEBUG_RAY_COLOR = new Color(1, 0.86, 0.18, 1);
const COLLISION_DEBUG_DESIRED_MOVE_COLOR = new Color(1, 0.62, 0.12, 1);
const COLLISION_DEBUG_RESOLVED_MOVE_COLOR = new Color(0.35, 1, 0.95, 1);
const COLLISION_MESH_FLOOR_STORAGE_PREFIX = 'supersplat:walk-floor-height:v1';
const COLLISION_MESH_DEFAULT_FLOOR_HEIGHTS = new Map<string, number>([
    ['/static/dev-assets/collision/elegant-kitchen-living-room-1.collision.glb?v=20260605-raw-mesh-v1|{"position":{"x":0,"y":0,"z":0},"rotationEuler":{"x":178.5392,"y":6.3398,"z":178.4648},"scale":{"x":1,"y":1,"z":1}}', -0.6559780054854247],
    ['/static/dev-assets/collision/meeting-prototype-room-splat-voxel-v1.collision.glb|null', -0.05],
    ['/static/dev-assets/collision/meeting-prototype-room-splat-transform-outdoor-floor-fill-v1.collision.glb|null', -0.05],
    ['/static/dev-assets/collision/meeting-prototype-room-splat-transform-indoor-external-fill-v1.collision.glb|null', -0.05]
]);

type CollisionTriangle = {
    ax: number;
    ay: number;
    az: number;
    bx: number;
    by: number;
    bz: number;
    cx: number;
    cy: number;
    cz: number;
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
    normalY: number;
    blocking: boolean;
};

type CollisionMeshBounds = {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    minZ: number;
    maxZ: number;
};

type GltfAccessor = {
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
};

type GltfBufferView = {
    buffer?: number;
    byteOffset?: number;
    byteLength: number;
    byteStride?: number;
};

type GltfPrimitive = {
    attributes?: { POSITION?: number };
    indices?: number;
};

type GltfMesh = {
    primitives?: GltfPrimitive[];
};

type GltfNode = {
    mesh?: number;
    children?: number[];
    matrix?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
};

type GltfDocument = {
    accessors?: GltfAccessor[];
    bufferViews?: GltfBufferView[];
    meshes?: GltfMesh[];
    nodes?: GltfNode[];
    scenes?: Array<{ nodes?: number[] }>;
    scene?: number;
};

class WalkCollisionMesh {
    readonly triangleCount: number;
    readonly blockingTriangleCount: number;
    readonly cellCount: number;
    readonly bounds: CollisionMeshBounds;
    readonly debugVoxelSize: number;
    private readonly triangles: CollisionTriangle[];
    private readonly debugVoxelCells: CollisionDebugVoxel[];
    private readonly blockingCells = new Map<string, number[]>();
    private readonly groundCells = new Map<string, number[]>();

    private constructor(triangles: CollisionTriangle[], debugVoxelSize: number) {
        this.triangles = triangles;
        this.triangleCount = triangles.length;
        this.blockingTriangleCount = triangles.filter(triangle => triangle.blocking).length;
        this.bounds = WalkCollisionMesh.triangleBounds(triangles);
        this.debugVoxelSize = debugVoxelSize;
        this.debugVoxelCells = WalkCollisionMesh.buildDebugVoxelCells(triangles, debugVoxelSize);
        this.indexTriangles();
        this.cellCount = this.blockingCells.size;
    }

    static fromGlb(buffer: ArrayBuffer, transform?: PresetTransform, debugVoxelSize = COLLISION_MESH_DEBUG_DEFAULT_VOXEL_SIZE) {
        const startedAt = performance.now();
        const { json, bin } = WalkCollisionMesh.parseGlb(buffer);
        const worldTransform = WalkCollisionMesh.transformFromPreset(transform);
        const triangles: CollisionTriangle[] = [];
        const rootNodes = WalkCollisionMesh.rootNodeIndices(json);
        const visitedNodes = new Set<number>();
        for (const nodeIndex of rootNodes) {
            WalkCollisionMesh.collectNodeTriangles(json, bin, nodeIndex, worldTransform.clone(), triangles, visitedNodes);
        }

        const mesh = new WalkCollisionMesh(triangles, debugVoxelSize);
        return {
            mesh,
            parseMs: Number((performance.now() - startedAt).toFixed(1))
        };
    }

    intersectsPlayerBody(body: PlayerCollisionBody): CollisionMeshHit {
        const { head, radius } = body;
        const minY = head.y - body.height + COLLISION_MESH_STEP_HEIGHT;
        const maxY = head.y - COLLISION_MESH_HEAD_CLEARANCE;
        const minCellX = Math.floor((head.x - radius) / COLLISION_MESH_CELL_SIZE);
        const maxCellX = Math.floor((head.x + radius) / COLLISION_MESH_CELL_SIZE);
        const minCellZ = Math.floor((head.z - radius) / COLLISION_MESH_CELL_SIZE);
        const maxCellZ = Math.floor((head.z + radius) / COLLISION_MESH_CELL_SIZE);
        const checked = new Set<number>();

        for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
            for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += 1) {
                const indices = this.blockingCells.get(`${cellX},${cellZ}`);
                if (!indices) {
                    continue;
                }

                for (const index of indices) {
                    if (checked.has(index)) {
                        continue;
                    }
                    checked.add(index);
                    const triangle = this.triangles[index];
                    if (triangle.maxY < minY || triangle.minY > maxY) {
                        continue;
                    }
                    if (triangle.maxX < head.x - radius || triangle.minX > head.x + radius ||
                        triangle.maxZ < head.z - radius || triangle.minZ > head.z + radius) {
                        continue;
                    }
                    if (WalkCollisionMesh.pointNearTriangleXZ(head.x, head.z, triangle, radius)) {
                        return { blocked: true, triangle: index };
                    }
                }
            }
        }

        return { blocked: false };
    }

    groundYAt(x: number, z: number, maxY: number, minY: number): GroundMeshHit | null {
        const cellX = Math.floor(x / COLLISION_MESH_CELL_SIZE);
        const cellZ = Math.floor(z / COLLISION_MESH_CELL_SIZE);
        let best: GroundMeshHit | null = null;
        const checked = new Set<number>();

        for (let dx = -1; dx <= 1; dx += 1) {
            for (let dz = -1; dz <= 1; dz += 1) {
                const indices = this.groundCells.get(`${cellX + dx},${cellZ + dz}`);
                if (!indices) {
                    continue;
                }

                for (const index of indices) {
                    if (checked.has(index)) {
                        continue;
                    }
                    checked.add(index);
                    const triangle = this.triangles[index];
                    if (triangle.blocking || triangle.minY > maxY || triangle.maxY < minY) {
                        continue;
                    }
                    if (triangle.maxX < x || triangle.minX > x || triangle.maxZ < z || triangle.minZ > z) {
                        continue;
                    }
                    if (!WalkCollisionMesh.pointInTriangleXZ(x, z, triangle)) {
                        continue;
                    }

                    const y = WalkCollisionMesh.interpolateTriangleY(x, z, triangle);
                    if (y !== null && y <= maxY && y >= minY && (!best || y > best.y)) {
                        best = { y, triangle: index, source: 'mesh' };
                    }
                }
            }
        }

        return best;
    }

    groundYNear(x: number, z: number, maxY: number, minY: number, radius = COLLISION_MESH_GROUND_PROBE_RADIUS): GroundMeshHit | null {
        const offsets = [
            [0, 0],
            [radius, 0],
            [-radius, 0],
            [0, radius],
            [0, -radius],
            [radius * 0.7, radius * 0.7],
            [radius * 0.7, -radius * 0.7],
            [-radius * 0.7, radius * 0.7],
            [-radius * 0.7, -radius * 0.7]
        ];
        let best: GroundMeshHit | null = null;
        for (const [dx, dz] of offsets) {
            const hit = this.groundYAt(x + dx, z + dz, maxY, minY);
            if (hit && (!best || hit.y > best.y)) {
                best = hit;
            }
        }
        return best;
    }

    triangleAt(index: number) {
        return this.triangles[index] ?? null;
    }

    debugTriangles(limit = COLLISION_MESH_PREVIEW_TRIANGLE_LIMIT) {
        if (this.triangles.length <= limit) {
            return this.triangles.map((triangle, index) => ({ index, triangle }));
        }

        const stride = Math.ceil(this.triangles.length / limit);
        const result: CollisionDebugTriangle[] = [];
        for (let index = 0; index < this.triangles.length; index += stride) {
            result.push({ index, triangle: this.triangles[index] });
        }
        return result;
    }

    debugVoxels(limit = COLLISION_MESH_PREVIEW_VOXEL_LIMIT) {
        if (this.debugVoxelCells.length <= limit) {
            return this.debugVoxelCells;
        }

        const stride = Math.ceil(this.debugVoxelCells.length / limit);
        const result: CollisionDebugVoxel[] = [];
        for (let index = 0; index < this.debugVoxelCells.length; index += stride) {
            result.push(this.debugVoxelCells[index]);
        }
        return result;
    }

    debugTrianglesNear(x: number, z: number, radius = COLLISION_DEBUG_TRIANGLE_RADIUS, limit = COLLISION_DEBUG_TRIANGLE_LIMIT) {
        const minCellX = Math.floor((x - radius) / COLLISION_MESH_CELL_SIZE);
        const maxCellX = Math.floor((x + radius) / COLLISION_MESH_CELL_SIZE);
        const minCellZ = Math.floor((z - radius) / COLLISION_MESH_CELL_SIZE);
        const maxCellZ = Math.floor((z + radius) / COLLISION_MESH_CELL_SIZE);
        const checked = new Set<number>();
        const result: CollisionDebugTriangle[] = [];

        const addCell = (indices?: number[]) => {
            if (!indices) {
                return;
            }

            for (const index of indices) {
                if (checked.has(index)) {
                    continue;
                }
                checked.add(index);
                const triangle = this.triangles[index];
                if (triangle.maxX < x - radius || triangle.minX > x + radius ||
                    triangle.maxZ < z - radius || triangle.minZ > z + radius) {
                    continue;
                }
                result.push({ index, triangle });
            }
        };

        for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
            for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += 1) {
                const key = `${cellX},${cellZ}`;
                addCell(this.blockingCells.get(key));
                addCell(this.groundCells.get(key));
            }
        }

        return result
        .sort((a, b) => {
            const acx = (a.triangle.ax + a.triangle.bx + a.triangle.cx) / 3;
            const acz = (a.triangle.az + a.triangle.bz + a.triangle.cz) / 3;
            const bcx = (b.triangle.ax + b.triangle.bx + b.triangle.cx) / 3;
            const bcz = (b.triangle.az + b.triangle.bz + b.triangle.cz) / 3;
            return Math.hypot(acx - x, acz - z) - Math.hypot(bcx - x, bcz - z);
        })
        .slice(0, limit);
    }

    private static buildDebugVoxelCells(triangles: CollisionTriangle[], voxelSize: number) {
        const cells = new Map<string, CollisionDebugVoxel>();
        const triangleStride = Math.max(1, Math.ceil(triangles.length / COLLISION_MESH_DEBUG_VOXEL_TRIANGLE_LIMIT));

        for (let triangleIndex = 0; triangleIndex < triangles.length && cells.size < COLLISION_MESH_DEBUG_VOXEL_MAX_CELLS; triangleIndex += triangleStride) {
            WalkCollisionMesh.addTriangleDebugVoxels(cells, triangles[triangleIndex], voxelSize);
        }

        return Array.from(cells.values());
    }

    private static addTriangleDebugVoxels(cells: Map<string, CollisionDebugVoxel>, triangle: CollisionTriangle, voxelSize: number) {
        const normal = WalkCollisionMesh.triangleNormal(triangle);
        const axis = WalkCollisionMesh.dominantNormalAxis(normal);
        if (axis === null) {
            return;
        }

        const uAxis = axis === 0 ? 1 : 0;
        const vAxis = axis === 2 ? 1 : 2;
        const normalValue = normal[axis];
        const normalSign = normalValue < 0 ? -1 : 1;
        const plane = (
            WalkCollisionMesh.triangleCoord(triangle, 0, axis) +
            WalkCollisionMesh.triangleCoord(triangle, 1, axis) +
            WalkCollisionMesh.triangleCoord(triangle, 2, axis)
        ) / 3;
        const axisCenter = plane - normalSign * voxelSize * 0.5;
        const minU = Math.min(
            WalkCollisionMesh.triangleCoord(triangle, 0, uAxis),
            WalkCollisionMesh.triangleCoord(triangle, 1, uAxis),
            WalkCollisionMesh.triangleCoord(triangle, 2, uAxis)
        );
        const maxU = Math.max(
            WalkCollisionMesh.triangleCoord(triangle, 0, uAxis),
            WalkCollisionMesh.triangleCoord(triangle, 1, uAxis),
            WalkCollisionMesh.triangleCoord(triangle, 2, uAxis)
        );
        const minV = Math.min(
            WalkCollisionMesh.triangleCoord(triangle, 0, vAxis),
            WalkCollisionMesh.triangleCoord(triangle, 1, vAxis),
            WalkCollisionMesh.triangleCoord(triangle, 2, vAxis)
        );
        const maxV = Math.max(
            WalkCollisionMesh.triangleCoord(triangle, 0, vAxis),
            WalkCollisionMesh.triangleCoord(triangle, 1, vAxis),
            WalkCollisionMesh.triangleCoord(triangle, 2, vAxis)
        );
        const minCellU = Math.floor(minU / voxelSize);
        const maxCellU = Math.floor(maxU / voxelSize);
        const minCellV = Math.floor(minV / voxelSize);
        const maxCellV = Math.floor(maxV / voxelSize);
        const cellCount = Math.max(1, (maxCellU - minCellU + 1) * (maxCellV - minCellV + 1));
        const step = Math.max(1, Math.ceil(Math.sqrt(cellCount / COLLISION_MESH_DEBUG_VOXEL_TRIANGLE_SAMPLE_LIMIT)));
        const epsilon = voxelSize * voxelSize * 0.04;

        for (let uCell = minCellU; uCell <= maxCellU && cells.size < COLLISION_MESH_DEBUG_VOXEL_MAX_CELLS; uCell += step) {
            for (let vCell = minCellV; vCell <= maxCellV && cells.size < COLLISION_MESH_DEBUG_VOXEL_MAX_CELLS; vCell += step) {
                const u = (uCell + 0.5) * voxelSize;
                const v = (vCell + 0.5) * voxelSize;
                if (!WalkCollisionMesh.pointInProjectedTriangle(u, v, triangle, uAxis, vAxis, epsilon)) {
                    continue;
                }

                const coords = [0, 0, 0];
                coords[axis] = axisCenter;
                coords[uAxis] = u;
                coords[vAxis] = v;
                const key = [
                    Math.floor(coords[0] / voxelSize),
                    Math.floor(coords[1] / voxelSize),
                    Math.floor(coords[2] / voxelSize)
                ].join(',');

                cells.set(key, {
                    x: coords[0],
                    y: coords[1],
                    z: coords[2],
                    size: voxelSize,
                    blocking: triangle.blocking
                });
            }
        }
    }

    private static triangleNormal(triangle: CollisionTriangle) {
        const abx = triangle.bx - triangle.ax;
        const aby = triangle.by - triangle.ay;
        const abz = triangle.bz - triangle.az;
        const acx = triangle.cx - triangle.ax;
        const acy = triangle.cy - triangle.ay;
        const acz = triangle.cz - triangle.az;
        return [
            aby * acz - abz * acy,
            abz * acx - abx * acz,
            abx * acy - aby * acx
        ];
    }

    private static dominantNormalAxis(normal: number[]) {
        const absX = Math.abs(normal[0]);
        const absY = Math.abs(normal[1]);
        const absZ = Math.abs(normal[2]);
        const max = Math.max(absX, absY, absZ);
        if (max <= 0.000001) {
            return null;
        }
        if (max === absX) {
            return 0;
        }
        return max === absY ? 1 : 2;
    }

    private static triangleCoord(triangle: CollisionTriangle, vertex: number, axis: number) {
        if (vertex === 0) {
            return axis === 0 ? triangle.ax : axis === 1 ? triangle.ay : triangle.az;
        }
        if (vertex === 1) {
            return axis === 0 ? triangle.bx : axis === 1 ? triangle.by : triangle.bz;
        }
        return axis === 0 ? triangle.cx : axis === 1 ? triangle.cy : triangle.cz;
    }

    private static pointInProjectedTriangle(u: number, v: number, triangle: CollisionTriangle, uAxis: number, vAxis: number, epsilon: number) {
        const au = WalkCollisionMesh.triangleCoord(triangle, 0, uAxis);
        const av = WalkCollisionMesh.triangleCoord(triangle, 0, vAxis);
        const bu = WalkCollisionMesh.triangleCoord(triangle, 1, uAxis);
        const bv = WalkCollisionMesh.triangleCoord(triangle, 1, vAxis);
        const cu = WalkCollisionMesh.triangleCoord(triangle, 2, uAxis);
        const cv = WalkCollisionMesh.triangleCoord(triangle, 2, vAxis);
        const d1 = WalkCollisionMesh.sign2d(u, v, au, av, bu, bv);
        const d2 = WalkCollisionMesh.sign2d(u, v, bu, bv, cu, cv);
        const d3 = WalkCollisionMesh.sign2d(u, v, cu, cv, au, av);
        const hasNeg = d1 < -epsilon || d2 < -epsilon || d3 < -epsilon;
        const hasPos = d1 > epsilon || d2 > epsilon || d3 > epsilon;
        return !(hasNeg && hasPos);
    }

    private indexTriangles() {
        for (let i = 0; i < this.triangles.length; i += 1) {
            const triangle = this.triangles[i];
            const radius = triangle.blocking ? COLLISION_MESH_CAPSULE_RADIUS : 0;
            const minCellX = Math.floor((triangle.minX - radius) / COLLISION_MESH_CELL_SIZE);
            const maxCellX = Math.floor((triangle.maxX + radius) / COLLISION_MESH_CELL_SIZE);
            const minCellZ = Math.floor((triangle.minZ - radius) / COLLISION_MESH_CELL_SIZE);
            const maxCellZ = Math.floor((triangle.maxZ + radius) / COLLISION_MESH_CELL_SIZE);
            for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
                for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += 1) {
                    const key = `${cellX},${cellZ}`;
                    const cells = triangle.blocking ? this.blockingCells : this.groundCells;
                    let list = cells.get(key);
                    if (!list) {
                        list = [];
                        cells.set(key, list);
                    }
                    list.push(i);
                }
            }
        }
    }

    private static triangleBounds(triangles: CollisionTriangle[]): CollisionMeshBounds {
        const bounds = {
            minX: Infinity,
            maxX: -Infinity,
            minY: Infinity,
            maxY: -Infinity,
            minZ: Infinity,
            maxZ: -Infinity
        };

        for (const triangle of triangles) {
            bounds.minX = Math.min(bounds.minX, triangle.minX);
            bounds.maxX = Math.max(bounds.maxX, triangle.maxX);
            bounds.minY = Math.min(bounds.minY, triangle.minY);
            bounds.maxY = Math.max(bounds.maxY, triangle.maxY);
            bounds.minZ = Math.min(bounds.minZ, triangle.minZ);
            bounds.maxZ = Math.max(bounds.maxZ, triangle.maxZ);
        }

        if (!Number.isFinite(bounds.minX)) {
            return { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
        }
        return bounds;
    }

    private static parseGlb(buffer: ArrayBuffer) {
        const view = new DataView(buffer);
        if (view.getUint32(0, true) !== 0x46546c67) {
            throw new Error('Collision mesh is not a GLB file.');
        }

        let offset = 12;
        let json: GltfDocument | null = null;
        let bin: ArrayBuffer | null = null;
        while (offset < buffer.byteLength) {
            const chunkLength = view.getUint32(offset, true);
            const chunkType = view.getUint32(offset + 4, true);
            offset += 8;
            const chunk = buffer.slice(offset, offset + chunkLength);
            if (chunkType === 0x4e4f534a) {
                json = JSON.parse(new TextDecoder().decode(chunk)) as GltfDocument;
            } else if (chunkType === 0x004e4942) {
                bin = chunk;
            }
            offset += (chunkLength + 3) & ~3;
        }

        if (!json || !bin) {
            throw new Error('Collision GLB is missing JSON or BIN chunks.');
        }

        return { json, bin };
    }

    private static transformFromPreset(transform?: PresetTransform) {
        const matrix = new Mat4();
        if (!transform) {
            return matrix;
        }

        matrix.setTRS(
            new Vec3(transform.position.x, transform.position.y, transform.position.z),
            new Quat().setFromEulerAngles(transform.rotationEuler.x, transform.rotationEuler.y, transform.rotationEuler.z),
            new Vec3(transform.scale.x, transform.scale.y, transform.scale.z)
        );
        return matrix;
    }

    private static rootNodeIndices(json: GltfDocument) {
        const nodes = json.nodes ?? [];
        const sceneIndex = json.scene ?? 0;
        const sceneNodes = json.scenes?.[sceneIndex]?.nodes?.filter(index => nodes[index]);
        if (sceneNodes?.length) {
            return Array.from(new Set(sceneNodes));
        }

        const childNodes = new Set<number>();
        for (const node of nodes) {
            for (const childIndex of node.children ?? []) {
                childNodes.add(childIndex);
            }
        }

        const allNodeIndices = nodes.map((_, index) => index);
        const rootNodes = allNodeIndices.filter(index => !childNodes.has(index));
        return rootNodes.length ? rootNodes : allNodeIndices;
    }

    private static nodeMatrix(node: GltfNode) {
        const matrix = new Mat4();
        if (node.matrix?.length === 16) {
            matrix.data.set(node.matrix);
            return matrix;
        }

        const translation = node.translation ?? [0, 0, 0];
        const rotation = node.rotation ?? [0, 0, 0, 1];
        const scale = node.scale ?? [1, 1, 1];
        matrix.setTRS(
            new Vec3(translation[0], translation[1], translation[2]),
            new Quat(rotation[0], rotation[1], rotation[2], rotation[3]),
            new Vec3(scale[0], scale[1], scale[2])
        );
        return matrix;
    }

    private static collectNodeTriangles(json: GltfDocument, bin: ArrayBuffer, nodeIndex: number, parentTransform: Mat4, triangles: CollisionTriangle[], visitedNodes: Set<number>) {
        if (visitedNodes.has(nodeIndex)) {
            return;
        }
        visitedNodes.add(nodeIndex);

        const node = json.nodes?.[nodeIndex];
        if (!node) {
            return;
        }

        const worldTransform = parentTransform.clone().mul(WalkCollisionMesh.nodeMatrix(node));
        if (node.mesh !== undefined) {
            WalkCollisionMesh.collectMeshTriangles(json, bin, node.mesh, worldTransform, triangles);
        }

        for (const childIndex of node.children ?? []) {
            WalkCollisionMesh.collectNodeTriangles(json, bin, childIndex, worldTransform, triangles, visitedNodes);
        }
    }

    private static collectMeshTriangles(json: GltfDocument, bin: ArrayBuffer, meshIndex: number, transform: Mat4, triangles: CollisionTriangle[]) {
        const mesh = json.meshes?.[meshIndex];
        if (!mesh) {
            return;
        }

        for (const primitive of mesh.primitives ?? []) {
            const positionAccessorIndex = primitive.attributes?.POSITION;
            if (positionAccessorIndex === undefined) {
                continue;
            }
            const positions = WalkCollisionMesh.readVec3Accessor(json, bin, positionAccessorIndex, transform);
            const indices = primitive.indices === undefined ?
                positions.map((_, index) => index) :
                WalkCollisionMesh.readIndexAccessor(json, bin, primitive.indices);
            for (let i = 0; i + 2 < indices.length; i += 3) {
                const triangle = WalkCollisionMesh.makeTriangle(
                    positions[indices[i]],
                    positions[indices[i + 1]],
                    positions[indices[i + 2]]
                );
                if (triangle) {
                    triangles.push(triangle);
                }
            }
        }
    }

    private static readVec3Accessor(json: GltfDocument, bin: ArrayBuffer, accessorIndex: number, transform: Mat4) {
        const accessor = json.accessors?.[accessorIndex];
        const bufferView = accessor?.bufferView === undefined ? undefined : json.bufferViews?.[accessor.bufferView];
        if (!accessor || !bufferView || accessor.componentType !== 5126 || accessor.type !== 'VEC3') {
            throw new Error('Collision GLB position accessor must be FLOAT VEC3.');
        }

        const byteOffset = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
        const stride = bufferView.byteStride ?? 12;
        const view = new DataView(bin, byteOffset, bufferView.byteLength - (accessor.byteOffset ?? 0));
        const result: Vec3[] = [];
        for (let i = 0; i < accessor.count; i += 1) {
            const offset = i * stride;
            const point = new Vec3(
                view.getFloat32(offset, true),
                view.getFloat32(offset + 4, true),
                view.getFloat32(offset + 8, true)
            );
            transform.transformPoint(point, point);
            result.push(point);
        }
        return result;
    }

    private static readIndexAccessor(json: GltfDocument, bin: ArrayBuffer, accessorIndex: number) {
        const accessor = json.accessors?.[accessorIndex];
        const bufferView = accessor?.bufferView === undefined ? undefined : json.bufferViews?.[accessor.bufferView];
        if (!accessor || !bufferView) {
            throw new Error('Collision GLB is missing an index accessor.');
        }

        const componentSize = WalkCollisionMesh.componentSize(accessor.componentType);
        const byteOffset = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
        const stride = bufferView.byteStride ?? componentSize;
        const view = new DataView(bin, byteOffset, bufferView.byteLength - (accessor.byteOffset ?? 0));
        const result: number[] = [];
        for (let i = 0; i < accessor.count; i += 1) {
            const offset = i * stride;
            if (accessor.componentType === 5125) {
                result.push(view.getUint32(offset, true));
            } else if (accessor.componentType === 5123) {
                result.push(view.getUint16(offset, true));
            } else if (accessor.componentType === 5121) {
                result.push(view.getUint8(offset));
            } else {
                throw new Error(`Unsupported collision index component type ${accessor.componentType}.`);
            }
        }
        return result;
    }

    private static componentSize(componentType: number) {
        if (componentType === 5125 || componentType === 5126) {
            return 4;
        }
        if (componentType === 5123) {
            return 2;
        }
        if (componentType === 5121) {
            return 1;
        }
        throw new Error(`Unsupported collision component type ${componentType}.`);
    }

    private static makeTriangle(a: Vec3, b: Vec3, c: Vec3): CollisionTriangle | null {
        const ux = b.x - a.x;
        const uy = b.y - a.y;
        const uz = b.z - a.z;
        const vx = c.x - a.x;
        const vy = c.y - a.y;
        const vz = c.z - a.z;
        const nx = uy * vz - uz * vy;
        const ny = uz * vx - ux * vz;
        const nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz);
        if (len <= 0.000001) {
            return null;
        }
        const normalY = ny / len;

        return {
            ax: a.x,
            ay: a.y,
            az: a.z,
            bx: b.x,
            by: b.y,
            bz: b.z,
            cx: c.x,
            cy: c.y,
            cz: c.z,
            minX: Math.min(a.x, b.x, c.x) - COLLISION_MESH_CAPSULE_RADIUS,
            maxX: Math.max(a.x, b.x, c.x) + COLLISION_MESH_CAPSULE_RADIUS,
            minY: Math.min(a.y, b.y, c.y),
            maxY: Math.max(a.y, b.y, c.y),
            minZ: Math.min(a.z, b.z, c.z) - COLLISION_MESH_CAPSULE_RADIUS,
            maxZ: Math.max(a.z, b.z, c.z) + COLLISION_MESH_CAPSULE_RADIUS,
            normalY,
            blocking: Math.abs(normalY) <= COLLISION_MESH_MAX_FLOOR_NORMAL_Y
        };
    }

    private static pointNearTriangleXZ(x: number, z: number, triangle: CollisionTriangle, radius: number) {
        if (WalkCollisionMesh.pointInTriangleXZ(x, z, triangle)) {
            return true;
        }

        const radiusSq = radius * radius;
        return WalkCollisionMesh.distancePointSegmentSq(x, z, triangle.ax, triangle.az, triangle.bx, triangle.bz) <= radiusSq ||
            WalkCollisionMesh.distancePointSegmentSq(x, z, triangle.bx, triangle.bz, triangle.cx, triangle.cz) <= radiusSq ||
            WalkCollisionMesh.distancePointSegmentSq(x, z, triangle.cx, triangle.cz, triangle.ax, triangle.az) <= radiusSq;
    }

    private static pointInTriangleXZ(x: number, z: number, triangle: CollisionTriangle) {
        const d1 = WalkCollisionMesh.sign2d(x, z, triangle.ax, triangle.az, triangle.bx, triangle.bz);
        const d2 = WalkCollisionMesh.sign2d(x, z, triangle.bx, triangle.bz, triangle.cx, triangle.cz);
        const d3 = WalkCollisionMesh.sign2d(x, z, triangle.cx, triangle.cz, triangle.ax, triangle.az);
        const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
        const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
        return !(hasNeg && hasPos);
    }

    private static sign2d(px: number, pz: number, ax: number, az: number, bx: number, bz: number) {
        return (px - bx) * (az - bz) - (ax - bx) * (pz - bz);
    }

    private static distancePointSegmentSq(px: number, pz: number, ax: number, az: number, bx: number, bz: number) {
        const dx = bx - ax;
        const dz = bz - az;
        const lenSq = dx * dx + dz * dz;
        if (lenSq <= 0.000001) {
            return (px - ax) * (px - ax) + (pz - az) * (pz - az);
        }
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lenSq));
        const closestX = ax + t * dx;
        const closestZ = az + t * dz;
        return (px - closestX) * (px - closestX) + (pz - closestZ) * (pz - closestZ);
    }

    private static interpolateTriangleY(x: number, z: number, triangle: CollisionTriangle) {
        const v0x = triangle.bx - triangle.ax;
        const v0z = triangle.bz - triangle.az;
        const v1x = triangle.cx - triangle.ax;
        const v1z = triangle.cz - triangle.az;
        const v2x = x - triangle.ax;
        const v2z = z - triangle.az;
        const dot00 = v0x * v0x + v0z * v0z;
        const dot01 = v0x * v1x + v0z * v1z;
        const dot02 = v0x * v2x + v0z * v2z;
        const dot11 = v1x * v1x + v1z * v1z;
        const dot12 = v1x * v2x + v1z * v2z;
        const denominator = dot00 * dot11 - dot01 * dot01;
        if (Math.abs(denominator) <= 0.000001) {
            return null;
        }
        const invDenominator = 1 / denominator;
        const v = (dot11 * dot02 - dot01 * dot12) * invDenominator;
        const w = (dot00 * dot12 - dot01 * dot02) * invDenominator;
        const u = 1 - v - w;
        return triangle.ay * u + triangle.by * v + triangle.cy * w;
    }
}

class WalkTool {
    private events: Events;
    private scene: Scene;
    private container: HTMLElement;
    private arrows: Map<ArrowDirection, HTMLElement> = new Map();
    private overlay: HTMLElement | null = null;
    private heightControls: HTMLElement | null = null;
    private animFrame: number | null = null;
    private active = false;

    private onPointerDownBound: ((e: PointerEvent) => void) | null = null;
    private onPointerLockMouseMoveBound: ((e: MouseEvent) => void) | null = null;
    private onPointerLockChangeBound: (() => void) | null = null;
    private onEmbeddedKeyDownBound: ((e: KeyboardEvent) => void) | null = null;
    private onEmbeddedKeyUpBound: ((e: KeyboardEvent) => void) | null = null;
    private onEmbeddedWheelBound: ((e: WheelEvent) => void) | null = null;
    private onEmbeddedFocusLossBound: (() => void) | null = null;
    private onEmbeddedVisibilityChangeBound: (() => void) | null = null;
    private externalWalkInput: WalkInputState = {};
    private embeddedKeyboardInput: WalkInputState = {};
    private lastExternalMoveAt = performance.now();
    private lastLookAt = 0;
    private externalVerticalVelocity = 0;
    private externalGroundY: number | null = null;
    private externalJumpWasPressed = false;
    private embeddedControls = false;
    private warmupBackground = false;
    private lastArrowPositionAt = 0;
    private collisionMesh: WalkCollisionMesh | null = null;
    private collisionMeshUrl: string | null = null;
    private collisionMeshKey: string | null = null;
    private collisionMeshLoadedKey: string | null = null;
    private collisionMeshBuffer: ArrayBuffer | null = null;
    private collisionMeshBufferUrl: string | null = null;
    private collisionMeshAbort: AbortController | null = null;
    private collisionMeshBlockingEnabled = COLLISION_MESH_BLOCKING_ENABLED;
    private lastCollisionMeshReportAt = 0;
    private lastCollisionMeshBlockReportAt = 0;
    private collisionMeshBlockedSince: number | null = null;
    private collisionMeshHeadY: number | null = null;
    private collisionMeshPendingSavedFloorY: number | null = null;
    private collisionMeshSavedFloorY: number | null = null;
    private collisionMeshSavedFloorKey: string | null = null;
    private collisionMeshLockedFloorY: number | null = null;
    private collisionMeshLockedFloorTriangle: number | null = null;
    private collisionDebugEnabled = WalkTool.defaultCollisionDebugEnabled();
    private collisionMeshPreviewEnabled = WalkTool.defaultCollisionMeshPreviewEnabled();
    private collisionMeshMiniOverlayEnabled = WalkTool.defaultCollisionMeshMiniOverlayEnabled();
    private collisionMeshPreviewCanvas: HTMLCanvasElement | null = null;
    private lastCollisionDebugReason = 'idle';
    private lastCollisionDesiredMove = new Vec3();
    private lastCollisionResolvedMove: Vec3 | null = null;
    private lastCollisionHitTriangle: number | null = null;
    private lastCollisionFloorTriangle: number | null = null;
    private lastCollisionBlockedBody: PlayerCollisionBody | null = null;
    private readonly collisionDebugSamples: CollisionDebugSample[] = [];
    private collisionProxy: CollisionProxyState = {
        pending: false,
        frontDistance: null,
        viewDistance: 0,
        blocked: false,
        lastSampleAt: 0,
        lastReportAt: 0,
        sampleMs: null
    };

    constructor(events: Events, scene: Scene, container: HTMLElement) {
        this.events = events;
        this.scene = scene;
        this.container = container;
        this.events.on('walk.pointerLook', this.onExternalPointerLook, this);
        this.events.on('walk.input', this.onExternalWalkInput, this);
        this.events.on('walk.embeddedControls', this.onEmbeddedControls, this);
        this.events.on('walk.warmupBackground', this.onWarmupBackground, this);
        this.events.on('walk.collisionMeshLoad', this.loadCollisionMesh, this);
        this.events.on('walk.collisionMeshClear', this.clearCollisionMesh, this);
        this.events.on('walk.saveFloorHeight', this.saveCollisionMeshFloorHeight, this);
        this.events.on('scene.clear', this.clearCollisionMesh, this);
        this.events.on('walk.collisionDebug', this.onCollisionDebug, this);
        this.events.on('walk.collisionMeshPreview', this.onCollisionMeshPreview, this);
        this.events.on('prerender', this.drawCollisionDebug, this);
        this.events.function('walk.collisionDebug', () => this.collisionDebugEnabled);
        this.events.function('walk.collisionMeshPreview', () => this.collisionMeshPreviewEnabled);
        this.events.function('walk.collisionDebugBundle', () => this.collisionDebugBundle());
        this.events.function('walk.saveFloorHeight', (source?: string) => this.saveCollisionMeshFloorHeight(source));
    }

    private static defaultCollisionDebugEnabled() {
        if (typeof window === 'undefined') {
            return false;
        }
        const params = new URLSearchParams(window.location.search);
        return params.get('collisionDebug') === '1' ||
            params.get('debugCollision') === '1' ||
            params.get('walkDebug') === '1';
    }

    private static defaultCollisionMeshPreviewEnabled() {
        if (typeof window === 'undefined') {
            return false;
        }
        const params = new URLSearchParams(window.location.search);
        return params.get('collisionMeshPreview') === '1' ||
            params.get('collisionMeshMini') === '1' ||
            params.get('voxelDebug') === '1';
    }

    private static defaultCollisionMeshMiniOverlayEnabled() {
        if (typeof window === 'undefined') {
            return false;
        }
        const params = new URLSearchParams(window.location.search);
        return params.get('collisionMeshMini') === '1';
    }

    private onCollisionDebug(enabled = true) {
        this.collisionDebugEnabled = Boolean(enabled);
        this.scene.forceRender = true;
    }

    private onCollisionMeshPreview(enabled = true) {
        this.collisionMeshPreviewEnabled = Boolean(enabled);
        this.syncCollisionMeshPreviewOverlay();
        this.scene.forceRender = true;
    }

    private static debugVec3(value: Vec3 | null) {
        if (!value) {
            return null;
        }
        return {
            x: Number(value.x.toFixed(4)),
            y: Number(value.y.toFixed(4)),
            z: Number(value.z.toFixed(4))
        };
    }

    private pushCollisionDebugSample(kind: string, details: Record<string, unknown>) {
        if (!this.collisionDebugEnabled) {
            return;
        }
        this.collisionDebugSamples.push({
            at: new Date().toISOString(),
            perfNow: Number(performance.now().toFixed(1)),
            kind,
            details
        });
        if (this.collisionDebugSamples.length > COLLISION_DEBUG_HISTORY_LIMIT) {
            this.collisionDebugSamples.splice(0, this.collisionDebugSamples.length - COLLISION_DEBUG_HISTORY_LIMIT);
        }
    }

    private collisionDebugInput(input: WalkInputState) {
        return {
            forward: Boolean(input.forward),
            backward: Boolean(input.backward),
            left: Boolean(input.left),
            right: Boolean(input.right),
            sprint: Boolean(input.sprint),
            slide: Boolean(input.slide),
            jump: Boolean(input.jump),
            up: Boolean(input.up),
            down: Boolean(input.down)
        };
    }

    private activeToolName() {
        try {
            return this.events.invoke('tool.active') as string | null;
        } catch {
            return null;
        }
    }

    private static cloneCollisionBody(body: PlayerCollisionBody) {
        return {
            ...body,
            head: body.head.clone(),
            eye: body.eye.clone()
        };
    }

    private static debugBody(body: PlayerCollisionBody | null) {
        if (!body) {
            return null;
        }
        return {
            head: WalkTool.debugVec3(body.head),
            eye: WalkTool.debugVec3(body.eye),
            feetY: Number((body.eye.y - body.eyeHeight).toFixed(4)),
            radius: Number(body.radius.toFixed(4)),
            height: Number(body.height.toFixed(4)),
            eyeHeight: Number(body.eyeHeight.toFixed(4))
        };
    }

    private collisionDebugBundle() {
        const mesh = this.collisionMesh;
        return {
            version: 1,
            createdAt: new Date().toISOString(),
            toolActive: this.active,
            embeddedControls: this.embeddedControls,
            collisionDebugEnabled: this.collisionDebugEnabled,
            collisionMeshPreviewEnabled: this.collisionMeshPreviewEnabled,
            collisionMeshMiniOverlayEnabled: this.collisionMeshMiniOverlayEnabled,
            activeTool: this.activeToolName(),
            camera: this.events.invoke('camera.debugState') ?? null,
            mesh: {
                loaded: Boolean(mesh),
                url: this.collisionMeshUrl,
                key: this.collisionMeshKey,
                loadedKey: this.collisionMeshLoadedKey,
                triangles: mesh?.triangleCount ?? null,
                blockingTriangles: mesh?.blockingTriangleCount ?? null,
                blockingEnabled: this.collisionMeshBlockingEnabled,
                cells: mesh?.cellCount ?? null,
                cellSize: mesh ? COLLISION_MESH_CELL_SIZE : null,
                capsuleRadius: COLLISION_MESH_CAPSULE_RADIUS,
                playerHeight: COLLISION_MESH_PLAYER_HEIGHT,
                eyeHeight: COLLISION_MESH_EYE_HEIGHT,
                stepHeight: COLLISION_MESH_STEP_HEIGHT,
                savedFloorY: this.collisionMeshSavedFloorY,
                savedFloorKey: this.collisionMeshSavedFloorKey,
                lockedFloorY: this.collisionMeshLockedFloorY,
                lockedFloorTriangle: this.collisionMeshLockedFloorTriangle,
                floorStorageKey: this.collisionMeshFloorStorageKey(),
                walkSpeed: COLLISION_MESH_WALK_SPEED
            },
            state: {
                debugReason: this.lastCollisionDebugReason,
                blockedSinceMs: this.collisionMeshBlockedSince === null ? null : Number((performance.now() - this.collisionMeshBlockedSince).toFixed(1)),
                headY: this.collisionMeshHeadY,
                externalGroundY: this.externalGroundY,
                externalVerticalVelocity: this.externalVerticalVelocity,
                desiredMove: WalkTool.debugVec3(this.lastCollisionDesiredMove),
                resolvedMove: WalkTool.debugVec3(this.lastCollisionResolvedMove),
                hitTriangle: this.lastCollisionHitTriangle,
                floorTriangle: this.lastCollisionFloorTriangle,
                blockedBody: WalkTool.debugBody(this.lastCollisionBlockedBody)
            },
            samples: this.collisionDebugSamples
        };
    }

    activate() {
        this.active = true;
        if (!this.embeddedControls) {
            this.createOverlay();
            this.createHeightControls();
        } else {
            this.createEmbeddedKeyboardControls();
        }
        this.ensureUpdateLoop();
    }

    deactivate() {
        this.active = false;
        this.destroyOverlay();
        this.destroyHeightControls();
        this.destroyEmbeddedKeyboardControls();
        if (!this.hasExternalWalkInput() && this.animFrame !== null) {
            cancelAnimationFrame(this.animFrame);
            this.animFrame = null;
        }
    }

    private get camera(): Camera {
        return this.scene.camera;
    }

    private get stepSize(): number {
        return this.camera.sceneRadius * 0.4;
    }

    /** Bottom of the scene bounding box — the actual floor level */
    private get groundY(): number {
        const bound = this.scene.bound;
        return bound.center.y - bound.halfExtents.y;
    }

    private createOverlay() {
        if (this.overlay || this.embeddedControls) {
            return;
        }

        this.overlay = document.createElement('div');
        this.overlay.id = 'walk-tool-overlay';
        this.overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:10;';
        this.container.appendChild(this.overlay);

        const directions: ArrowDirection[] = ['north', 'south', 'east', 'west'];
        for (const dir of directions) {
            const arrow = this.createArrow(dir);
            this.overlay.appendChild(arrow);
            this.arrows.set(dir, arrow);
        }

        this.onPointerDownBound = (e: PointerEvent) => this.onPointerDown(e);
        this.onPointerLockMouseMoveBound = (e: MouseEvent) => this.onPointerLockMouseMove(e);
        this.onPointerLockChangeBound = () => this.onPointerLockChange();
        this.container.addEventListener('pointerdown', this.onPointerDownBound);
        document.addEventListener('mousemove', this.onPointerLockMouseMoveBound);
        document.addEventListener('pointerlockchange', this.onPointerLockChangeBound);
    }

    private createHeightControls() {
        if (this.heightControls || shouldHideWalkHeightControls()) {
            return;
        }

        const root = document.createElement('div');
        root.id = 'walk-height-controls';
        root.style.cssText = 'position:absolute;right:16px;bottom:16px;z-index:14;pointer-events:auto;display:flex;align-items:center;gap:8px;';

        const saveButton = document.createElement('button');
        saveButton.type = 'button';
        saveButton.textContent = 'Save Height';
        saveButton.style.cssText = 'border:1px solid rgba(240,196,91,.55);background:rgba(8,9,9,.78);color:#f7f1df;padding:10px 12px;font:600 11px/1 system-ui,sans-serif;text-transform:uppercase;letter-spacing:.12em;cursor:pointer;backdrop-filter:blur(10px);';
        saveButton.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
        saveButton.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.saveCollisionMeshFloorHeight('button');
        });

        root.appendChild(saveButton);
        this.container.appendChild(root);
        this.heightControls = root;
    }

    private destroyHeightControls() {
        if (this.heightControls) {
            this.heightControls.remove();
            this.heightControls = null;
        }
    }

    private onEmbeddedControls(enabled = false) {
        this.embeddedControls = enabled;
        if (enabled) {
            if (document.pointerLockElement === this.container) {
                document.exitPointerLock();
            }
            this.destroyOverlay();
            this.destroyHeightControls();
            this.createEmbeddedKeyboardControls();
            return;
        }

        this.destroyEmbeddedKeyboardControls();
        if (this.active) {
            this.createOverlay();
            this.createHeightControls();
        }
    }

    private onWarmupBackground(enabled = false) {
        this.warmupBackground = Boolean(enabled);
        if (!this.warmupBackground) {
            if (this.active || this.hasExternalWalkInput()) {
                this.ensureUpdateLoop();
            }
            this.scene.forceRender = true;
            return;
        }

        this.externalWalkInput = {};
        this.embeddedKeyboardInput = {};
        this.externalVerticalVelocity = 0;
        this.externalJumpWasPressed = false;
        this.clearNativeFlyInput();

        if (this.animFrame !== null) {
            cancelAnimationFrame(this.animFrame);
            this.animFrame = null;
        }
    }

    private createEmbeddedKeyboardControls() {
        if (this.onEmbeddedKeyDownBound || this.onEmbeddedKeyUpBound) {
            return;
        }

        this.clearNativeFlyInput();
        this.onEmbeddedKeyDownBound = (e: KeyboardEvent) => this.onEmbeddedKey(e, true);
        this.onEmbeddedKeyUpBound = (e: KeyboardEvent) => this.onEmbeddedKey(e, false);
        this.onEmbeddedWheelBound = (e: WheelEvent) => this.onEmbeddedWheel(e);
        const clearEmbeddedInput = () => {
            this.embeddedKeyboardInput = {};
            this.externalJumpWasPressed = false;
            this.clearNativeFlyInput();
        };
        this.onEmbeddedFocusLossBound = clearEmbeddedInput;
        this.onEmbeddedVisibilityChangeBound = () => {
            if (document.visibilityState === 'hidden') {
                clearEmbeddedInput();
            }
        };
        window.addEventListener('keydown', this.onEmbeddedKeyDownBound, { capture: true });
        window.addEventListener('keyup', this.onEmbeddedKeyUpBound, { capture: true });
        this.container.addEventListener('wheel', this.onEmbeddedWheelBound, { passive: false });
        window.addEventListener('blur', this.onEmbeddedFocusLossBound);
        window.addEventListener('pagehide', this.onEmbeddedFocusLossBound);
        document.addEventListener('visibilitychange', this.onEmbeddedVisibilityChangeBound);
    }

    private destroyEmbeddedKeyboardControls() {
        if (this.onEmbeddedKeyDownBound) {
            window.removeEventListener('keydown', this.onEmbeddedKeyDownBound, { capture: true });
            this.onEmbeddedKeyDownBound = null;
        }
        if (this.onEmbeddedKeyUpBound) {
            window.removeEventListener('keyup', this.onEmbeddedKeyUpBound, { capture: true });
            this.onEmbeddedKeyUpBound = null;
        }
        if (this.onEmbeddedWheelBound) {
            this.container.removeEventListener('wheel', this.onEmbeddedWheelBound);
            this.onEmbeddedWheelBound = null;
        }
        if (this.onEmbeddedFocusLossBound) {
            window.removeEventListener('blur', this.onEmbeddedFocusLossBound);
            window.removeEventListener('pagehide', this.onEmbeddedFocusLossBound);
            this.onEmbeddedFocusLossBound = null;
        }
        if (this.onEmbeddedVisibilityChangeBound) {
            document.removeEventListener('visibilitychange', this.onEmbeddedVisibilityChangeBound);
            this.onEmbeddedVisibilityChangeBound = null;
        }
        this.embeddedKeyboardInput = {};
        this.clearNativeFlyInput();
    }

    private onEmbeddedWheel(event: WheelEvent) {
        if (!this.embeddedControls || !this.active || this.warmupBackground) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        let pixelDeltaY = event.deltaY;
        if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
            pixelDeltaY *= 40;
        } else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
            pixelDeltaY *= 600;
        }
        if (pixelDeltaY === 0) {
            return;
        }

        const currentDistance = this.embeddedViewDistance();
        const direction = Math.sign(pixelDeltaY);
        const magnitude = Math.min(3, Math.max(0.35, Math.abs(pixelDeltaY) / 80));
        let nextDistance = currentDistance + direction * COLLISION_MESH_VIEW_DISTANCE_STEP * magnitude;
        if (direction < 0 && nextDistance <= COLLISION_MESH_FIRST_PERSON_SNAP_DISTANCE) {
            nextDistance = COLLISION_MESH_FIRST_PERSON_DISTANCE;
        }
        if (direction > 0 && currentDistance <= COLLISION_MESH_FIRST_PERSON_SNAP_DISTANCE) {
            nextDistance = Math.max(nextDistance, COLLISION_MESH_THIRD_PERSON_DISTANCE);
        }
        this.setEmbeddedViewDistance(nextDistance);
    }

    private embeddedViewDistance() {
        return this.camera.distance * this.camera.sceneRadius / this.camera.fovFactor;
    }

    private setEmbeddedViewDistance(worldDistance: number) {
        const camera = this.camera;
        const playerAnchor = camera.focalPoint.clone();
        const currentHead = this.playerHead(camera);
        const nextDistance = Math.max(
            COLLISION_MESH_FIRST_PERSON_DISTANCE,
            Math.min(COLLISION_MESH_THIRD_PERSON_DISTANCE, worldDistance)
        );
        Camera.calcForwardVec(forwardVec, camera.azim, camera.elevation);
        const focalPoint = nextDistance > COLLISION_MESH_FIRST_PERSON_SNAP_DISTANCE ?
            playerAnchor :
            currentHead.clone().sub(forwardVec.clone().mulScalar(nextDistance));
        camera.setDistance(nextDistance / camera.sceneRadius * camera.fovFactor, 0);
        camera.setFocalPoint(focalPoint, 0);
        if (this.collisionMeshHeadY !== null) {
            this.collisionMeshHeadY = nextDistance > COLLISION_MESH_FIRST_PERSON_SNAP_DISTANCE ?
                focalPoint.y :
                currentHead.y;
        }
        this.scene.forceRender = true;
    }

    private clearNativeFlyInput() {
        this.events.fire('camera.fly.forward', false);
        this.events.fire('camera.fly.backward', false);
        this.events.fire('camera.fly.left', false);
        this.events.fire('camera.fly.right', false);
        this.events.fire('camera.fly.down', false);
        this.events.fire('camera.fly.up', false);
        this.events.fire('camera.modifier.fast', false);
        this.events.fire('camera.modifier.slow', false);
    }

    private isTypingTarget(target: EventTarget | null) {
        const element = target instanceof HTMLElement ? target : null;
        if (!element) {
            return false;
        }
        return Boolean(element.closest('input, textarea, select, [contenteditable="true"]'));
    }

    private onEmbeddedKey(event: KeyboardEvent, pressed: boolean) {
        if (!this.embeddedControls || !this.active || this.warmupBackground) {
            return;
        }
        if (pressed && this.isTypingTarget(event.target)) {
            return;
        }

        let handled = true;
        switch (event.code) {
            case 'KeyW':
            case 'ArrowUp':
                this.embeddedKeyboardInput.forward = pressed;
                break;
            case 'KeyS':
            case 'ArrowDown':
                this.embeddedKeyboardInput.backward = pressed;
                break;
            case 'KeyA':
            case 'ArrowLeft':
                this.embeddedKeyboardInput.left = pressed;
                break;
            case 'KeyD':
            case 'ArrowRight':
                this.embeddedKeyboardInput.right = pressed;
                break;
            case 'ShiftLeft':
            case 'ShiftRight':
                this.embeddedKeyboardInput.sprint = pressed;
                break;
            case 'Space':
                this.embeddedKeyboardInput.jump = pressed;
                break;
            case 'KeyQ':
                this.embeddedKeyboardInput.down = pressed;
                break;
            case 'KeyE':
                this.embeddedKeyboardInput.up = pressed;
                break;
            case 'AltLeft':
            case 'AltRight':
                handled = false;
                break;
            default:
                handled = false;
                break;
        }

        if (!handled) {
            return;
        }

        if (window.parent && window.parent !== window) {
            window.parent.postMessage({ type: 'supersplat:walk-key-state', code: event.code, pressed }, '*');
        }
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        this.clearNativeFlyInput();
        this.ensureUpdateLoop();
    }

    private createArrow(direction: ArrowDirection): HTMLElement {
        const el = document.createElement('div');
        el.className = 'walk-arrow';
        el.dataset.direction = direction;
        el.style.cssText = `
            position: absolute;
            pointer-events: auto;
            cursor: pointer;
            width: 48px;
            height: 48px;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: opacity 0.15s, transform 0.15s;
            opacity: 0.8;
        `;

        // SVG points "up" by default; rotation is set dynamically in positionArrows
        // based on screen-space direction from center to arrow position
        el.innerHTML = `<svg width="40" height="40" viewBox="0 0 40 40" style="filter: drop-shadow(0 2px 4px rgba(0,0,0,0.5));">
            <polygon points="20,8 32,24 26,24 26,34 14,34 14,24 8,24" fill="white" stroke="rgba(0,0,0,0.3)" stroke-width="1"/>
        </svg>`;

        // Scale the inner SVG on hover to avoid conflicting with the outer rotation transform
        const svg = el.querySelector('svg') as SVGElement;
        el.addEventListener('pointerenter', () => {
            el.style.opacity = '1';
            if (svg) svg.style.transform = `scale(1.15) ${svg.style.transform}`;
        });
        el.addEventListener('pointerleave', () => {
            el.style.opacity = '0.8';
            if (svg) svg.style.transform = svg.style.transform.replace('scale(1.15) ', '');
        });
        el.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            e.preventDefault();
            this.moveInDirection(direction);
        });

        return el;
    }

    private moveInDirection(direction: ArrowDirection) {
        const camera = this.camera;

        // Fixed world-space directions (N=-Z, S=+Z, E=+X, W=-X)
        switch (direction) {
            case 'north':
                tmpVec.set(0, 0, -1);
                break;
            case 'south':
                tmpVec.set(0, 0, 1);
                break;
            case 'east':
                tmpVec.set(1, 0, 0);
                break;
            case 'west':
                tmpVec.set(-1, 0, 0);
                break;
        }

        tmpVec.mulScalar(this.stepSize);

        const resolvedMove = this.resolveCollisionMeshMove(this.playerCollisionBodies(camera), tmpVec);
        if (!resolvedMove) {
            return;
        }

        const newFocal = camera.focalPoint.add(resolvedMove);
        camera.setFocalPoint(newFocal);
        this.scene.forceRender = true;
    }

    private onPointerDown(e: PointerEvent) {
        // Ignore if clicking on an arrow element
        if ((e.target as HTMLElement).closest('.walk-arrow')) return;
        if (e.pointerType === 'mouse' && e.button === 0) {
            this.requestPointerLock();
        }
    }

    private requestPointerLock() {
        if (document.pointerLockElement === this.container) {
            return;
        }

        try {
            const result = this.container.requestPointerLock();
            if (result instanceof Promise) {
                result.catch((error) => {
                    this.events.fire('walk.pointerLock', {
                        locked: false,
                        error: error instanceof Error ? error.message : 'Pointer lock was rejected'
                    });
                });
            }
        } catch (error) {
            // Browser policy may reject pointer lock if the click is not a user gesture.
            this.events.fire('walk.pointerLock', {
                locked: false,
                error: error instanceof Error ? error.message : 'Pointer lock was rejected'
            });
        }
    }

    private onPointerLockChange() {
        const locked = document.pointerLockElement === this.container;
        this.container.classList.toggle('walk-pointer-locked', locked);
        this.events.fire('walk.pointerLock', { locked });
    }

    private onPointerLockMouseMove(event: MouseEvent) {
        if (!this.active || this.warmupBackground || document.pointerLockElement !== this.container) {
            return;
        }

        const dx = event.movementX || 0;
        const dy = event.movementY || 0;
        if (dx === 0 && dy === 0) {
            return;
        }

        this.lastLookAt = performance.now();
        this.look(dx, dy);
    }

    private onExternalPointerLook(dx = 0, dy = 0) {
        if (this.warmupBackground) {
            return;
        }
        this.lastLookAt = performance.now();
        this.look(Math.max(-200, Math.min(200, dx)), Math.max(-200, Math.min(200, dy)));
    }

    private onExternalWalkInput(input: WalkInputState = {}) {
        if (this.warmupBackground) {
            this.externalWalkInput = {};
            this.externalVerticalVelocity = 0;
            this.externalJumpWasPressed = false;
            this.clearNativeFlyInput();
            return;
        }

        this.externalWalkInput = {
            forward: Boolean(input.forward),
            backward: Boolean(input.backward),
            left: Boolean(input.left),
            right: Boolean(input.right),
            sprint: Boolean(input.sprint),
            slide: Boolean(input.slide),
            jump: Boolean(input.jump),
            up: Boolean(input.up),
            down: Boolean(input.down)
        };
        this.ensureUpdateLoop();
    }

    private hasExternalWalkInput() {
        const input = this.walkInputState;
        return Boolean(
            input.forward ||
            input.backward ||
            input.left ||
            input.right ||
            input.sprint ||
            input.slide ||
            input.jump ||
            input.up ||
            input.down ||
            Math.abs(this.externalVerticalVelocity) > 0.0001
        );
    }

    private get walkInputState(): WalkInputState {
        return {
            forward: Boolean(this.externalWalkInput.forward || this.embeddedKeyboardInput.forward),
            backward: Boolean(this.externalWalkInput.backward || this.embeddedKeyboardInput.backward),
            left: Boolean(this.externalWalkInput.left || this.embeddedKeyboardInput.left),
            right: Boolean(this.externalWalkInput.right || this.embeddedKeyboardInput.right),
            sprint: Boolean(this.externalWalkInput.sprint || this.embeddedKeyboardInput.sprint),
            slide: Boolean(this.externalWalkInput.slide || this.embeddedKeyboardInput.slide),
            jump: Boolean(this.externalWalkInput.jump || this.embeddedKeyboardInput.jump),
            up: Boolean(this.externalWalkInput.up || this.embeddedKeyboardInput.up),
            down: Boolean(this.externalWalkInput.down || this.embeddedKeyboardInput.down)
        };
    }

    private ensureUpdateLoop() {
        if (this.warmupBackground) {
            return;
        }

        if (this.animFrame === null) {
            this.lastExternalMoveAt = performance.now();
            this.animFrame = requestAnimationFrame(() => this.updateLoop());
        }
    }

    private applyExternalWalkInput() {
        const input = this.walkInputState;
        const forwardAmount = (input.forward ? 1 : 0) - (input.backward ? 1 : 0);
        const rightAmount = (input.right ? 1 : 0) - (input.left ? 1 : 0);
        const moving = forwardAmount !== 0 || rightAmount !== 0;

        const now = performance.now();
        const dt = Math.min(0.05, Math.max(0.001, (now - this.lastExternalMoveAt) / 1000));
        this.lastExternalMoveAt = now;

        const camera = this.camera;
        const focalPoint = camera.focalPoint;
        let changed = false;
        const useCollisionProxy = !this.collisionMesh;
        changed ||= this.applyCollisionHeadHeightLock(camera, focalPoint);
        const adjustedHeight = this.applyManualHeightInput(input, dt, camera, focalPoint);
        changed ||= adjustedHeight;

        this.updateCollisionProxy(useCollisionProxy && moving && forwardAmount > 0);
        if (!moving) {
            this.collisionMeshBlockedSince = null;
            this.resetCollisionDebugMove({ preserveBlock: this.collisionDebugEnabled });
        }

        if (this.collisionMesh) {
            if (!adjustedHeight) {
                changed ||= this.applyCollisionMeshVertical(input, dt, camera, focalPoint);
            }
            changed ||= this.resolveCollisionMeshPenetration(camera, focalPoint);
        } else {
            if (this.externalGroundY === null || this.externalVerticalVelocity === 0 && focalPoint.y < this.externalGroundY) {
                this.externalGroundY = focalPoint.y;
            }

            if (input.jump && !this.externalJumpWasPressed && this.externalVerticalVelocity === 0) {
                this.externalGroundY = focalPoint.y;
                this.externalVerticalVelocity = camera.sceneRadius * 0.55;
            }
            this.externalJumpWasPressed = Boolean(input.jump);
        }

        if (moving) {
            Camera.calcForwardVec(forwardVec, camera.azim, 0);
            forwardVec.y = 0;
            const forwardLength = Math.hypot(forwardVec.x, forwardVec.z) || 1;
            forwardVec.mulScalar(-1 / forwardLength);

            rightVec.set(-forwardVec.z, 0, forwardVec.x);
            moveVec.set(0, 0, 0);
            moveVec.add(forwardVec.clone().mulScalar(forwardAmount));
            moveVec.add(rightVec.clone().mulScalar(rightAmount));
            if (useCollisionProxy && forwardAmount > 0 && this.collisionProxy.blocked) {
                moveVec.sub(tmpVec.copy(forwardVec).mulScalar(forwardAmount));
            }

            const moveLength = Math.hypot(moveVec.x, moveVec.z);
            if (moveLength > 0) {
                moveVec.mulScalar(1 / moveLength);
                const speed = this.collisionMesh ? COLLISION_MESH_WALK_SPEED : camera.sceneRadius * 0.22;
                const speedMultiplier = input.sprint || input.slide ? this.collisionMesh ? COLLISION_MESH_SPRINT_MULTIPLIER : 1.8 : 1;
                moveVec.mulScalar(speed * speedMultiplier * dt);
                const resolvedMove = this.resolveCollisionMeshMove(this.playerCollisionBodies(camera), moveVec);
                if (resolvedMove) {
                    focalPoint.add(resolvedMove);
                    changed = true;
                }
            }
        }

        if (!this.collisionMesh && this.externalVerticalVelocity !== 0 && this.externalGroundY !== null) {
            focalPoint.y += this.externalVerticalVelocity * dt;
            this.externalVerticalVelocity -= camera.sceneRadius * 1.5 * dt;
            if (focalPoint.y <= this.externalGroundY) {
                focalPoint.y = this.externalGroundY;
                this.externalVerticalVelocity = 0;
            }
            changed = true;
        }

        if (changed) {
            camera.setFocalPoint(focalPoint, 0);
            this.scene.forceRender = true;
        }
    }

    private async loadCollisionMesh(details: CollisionMeshLoadDetails) {
        const transformKey = JSON.stringify(details.transform ?? null);
        const meshKey = `${details.url}|${transformKey}`;
        if (!details.url || meshKey === this.collisionMeshKey && this.collisionMesh) {
            return;
        }

        this.collisionMeshAbort?.abort();
        const abortController = new AbortController();
        this.collisionMeshAbort = abortController;
        this.collisionMeshUrl = details.url;
        this.collisionMeshKey = meshKey;
        const configuredFloorY = typeof details.floorY === 'number' && Number.isFinite(details.floorY) ?
            details.floorY :
            null;
        this.collisionMeshPendingSavedFloorY = this.readSavedCollisionMeshFloorY(meshKey, configuredFloorY);
        const blockingEnabled = details.blockingEnabled ?? COLLISION_MESH_BLOCKING_ENABLED;
        const startedAt = performance.now();
        this.pushCollisionDebugSample('mesh-load-start', {
            url: details.url,
            requestId: details.requestId ?? null,
            configuredFloorY,
            savedFloorY: this.collisionMeshPendingSavedFloorY
        });
        this.events.fire('walk.collisionMesh', {
            ok: true,
            reason: 'load-start',
            url: details.url,
            requestId: details.requestId ?? null,
            configuredFloorY,
            savedFloorY: this.collisionMeshPendingSavedFloorY
        });

        try {
            const debugVoxelSizePromise = this.loadCollisionMeshDebugVoxelSize(details.url, abortController.signal);
            let buffer = details.url === this.collisionMeshBufferUrl ? this.collisionMeshBuffer : null;
            if (!buffer) {
                const response = await fetch(details.url, { signal: abortController.signal, cache: 'force-cache' });
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }

                buffer = await response.arrayBuffer();
                if (details.url !== this.collisionMeshUrl) {
                    return;
                }
                this.collisionMeshBuffer = buffer;
                this.collisionMeshBufferUrl = details.url;
            }

            const debugVoxelSize = await debugVoxelSizePromise;
            if (details.url !== this.collisionMeshUrl) {
                return;
            }

            const { mesh, parseMs } = WalkCollisionMesh.fromGlb(buffer, details.transform, debugVoxelSize ?? undefined);
            if (meshKey !== this.collisionMeshKey) {
                return;
            }
            if (mesh.blockingTriangleCount === 0) {
                this.collisionMesh = null;
                this.collisionMeshHeadY = null;
                this.collisionMeshLoadedKey = null;
                this.collisionMeshPendingSavedFloorY = null;
                this.collisionMeshSavedFloorY = null;
                this.collisionMeshSavedFloorKey = null;
                this.resetCollisionMeshFloorLock();
                this.syncCollisionMeshPreviewOverlay();
                this.events.fire('walk.collisionMesh', {
                    ok: false,
                    reason: 'empty',
                    url: details.url,
                    requestId: details.requestId ?? null,
                    byteLength: buffer.byteLength,
                    parseMs
                });
                return;
            }
            this.collisionMesh = mesh;
            this.collisionMeshBlockingEnabled = blockingEnabled;
            this.collisionMeshLoadedKey = meshKey;
            this.collisionMeshHeadY = null;
            this.syncCollisionMeshPreviewOverlay();
            const savedFloorY = this.collisionMeshSavedFloorKey === meshKey ?
                this.collisionMeshSavedFloorY :
                this.collisionMeshPendingSavedFloorY;
            this.collisionMeshSavedFloorY = savedFloorY;
            this.collisionMeshSavedFloorKey = savedFloorY === null ? null : meshKey;
            this.collisionMeshPendingSavedFloorY = null;
            this.resetCollisionMeshFloorLock();
            const floorLock = this.collisionMeshLockedFloorY === null ? 'pending' : 'saved';
            this.pushCollisionDebugSample('mesh-ready', {
                url: details.url,
                requestId: details.requestId ?? null,
                byteLength: buffer.byteLength,
                parseMs,
                triangles: mesh.triangleCount,
                blockingTriangles: mesh.blockingTriangleCount,
                blockingEnabled: this.collisionMeshBlockingEnabled,
                floorLock,
                configuredFloorY,
                savedFloorY: this.collisionMeshSavedFloorY,
                floorStorageKey: this.collisionMeshFloorStorageKey(meshKey),
                cells: mesh.cellCount,
                debugVoxelSize: mesh.debugVoxelSize
            });
            this.events.fire('walk.collisionMesh', {
                ok: true,
                reason: 'ready',
                url: details.url,
                requestId: details.requestId ?? null,
                byteLength: buffer.byteLength,
                loadMs: Number((performance.now() - startedAt).toFixed(1)),
                parseMs,
                triangles: mesh.triangleCount,
                blockingTriangles: mesh.blockingTriangleCount,
                blockingEnabled: this.collisionMeshBlockingEnabled,
                floorLock,
                configuredFloorY,
                savedFloorY: this.collisionMeshSavedFloorY,
                floorStorageKey: this.collisionMeshFloorStorageKey(meshKey),
                cells: mesh.cellCount,
                cellSize: COLLISION_MESH_CELL_SIZE,
                debugVoxelSize: mesh.debugVoxelSize,
                capsuleRadius: COLLISION_MESH_CAPSULE_RADIUS,
                playerHeight: COLLISION_MESH_PLAYER_HEIGHT,
                eyeHeight: COLLISION_MESH_EYE_HEIGHT,
                stepHeight: COLLISION_MESH_STEP_HEIGHT,
                walkSpeed: COLLISION_MESH_WALK_SPEED,
                sprintSpeed: Number((COLLISION_MESH_WALK_SPEED * COLLISION_MESH_SPRINT_MULTIPLIER).toFixed(3))
            });
        } catch (error) {
            if (abortController.signal.aborted || meshKey !== this.collisionMeshKey) {
                return;
            }
            this.collisionMesh = null;
            this.collisionMeshHeadY = null;
            this.collisionMeshLoadedKey = null;
            this.collisionMeshPendingSavedFloorY = null;
            this.collisionMeshSavedFloorY = null;
            this.collisionMeshSavedFloorKey = null;
            this.resetCollisionMeshFloorLock();
            this.syncCollisionMeshPreviewOverlay();
            this.pushCollisionDebugSample('mesh-load-failed', {
                url: details.url,
                requestId: details.requestId ?? null,
                error: error instanceof Error ? error.message : 'collision mesh load failed'
            });
            this.events.fire('walk.collisionMesh', {
                ok: false,
                reason: 'load-failed',
                url: details.url,
                requestId: details.requestId ?? null,
                error: error instanceof Error ? error.message : 'collision mesh load failed'
            });
        }
    }

    private async loadCollisionMeshDebugVoxelSize(url: string, signal: AbortSignal) {
        const voxelJsonUrl = this.collisionMeshVoxelJsonUrl(url);
        if (!voxelJsonUrl) {
            return null;
        }

        try {
            const response = await fetch(voxelJsonUrl, { signal, cache: 'force-cache' });
            if (!response.ok) {
                return null;
            }
            const json = await response.json() as { voxelResolution?: unknown };
            return typeof json.voxelResolution === 'number' && Number.isFinite(json.voxelResolution) && json.voxelResolution > 0 ?
                json.voxelResolution :
                null;
        } catch {
            return null;
        }
    }

    private collisionMeshVoxelJsonUrl(url: string) {
        try {
            const parsed = new URL(url, window.location.href);
            if (!parsed.pathname.endsWith('.collision.glb')) {
                return null;
            }
            parsed.pathname = parsed.pathname.replace(/\.collision\.glb$/, '.voxel.json');
            parsed.search = '';
            return parsed.toString();
        } catch {
            return null;
        }
    }

    private clearCollisionMesh(details: Record<string, unknown> = {}) {
        this.collisionMeshAbort?.abort();
        this.collisionMeshAbort = null;
        this.collisionMesh = null;
        this.collisionMeshUrl = null;
        this.collisionMeshKey = null;
        this.collisionMeshLoadedKey = null;
        this.collisionMeshBuffer = null;
        this.collisionMeshBufferUrl = null;
        this.collisionMeshBlockingEnabled = COLLISION_MESH_BLOCKING_ENABLED;
        this.collisionMeshHeadY = null;
        this.collisionMeshBlockedSince = null;
        this.collisionMeshPendingSavedFloorY = null;
        this.collisionMeshSavedFloorY = null;
        this.collisionMeshSavedFloorKey = null;
        this.resetCollisionMeshFloorLock();
        this.resetCollisionDebugMove();
        this.lastCollisionFloorTriangle = null;
        this.syncCollisionMeshPreviewOverlay();
        this.pushCollisionDebugSample('mesh-clear', {
            reason: details.reason ?? 'cleared',
            requestId: details.requestId ?? null
        });
        this.events.fire('walk.collisionMesh', {
            ok: true,
            reason: 'cleared',
            ...details
        });
    }

    private resetCollisionMeshFloorLock() {
        if (this.collisionMeshSavedFloorY !== null) {
            this.collisionMeshLockedFloorY = this.collisionMeshSavedFloorY;
            this.collisionMeshLockedFloorTriangle = null;
            this.externalGroundY = this.collisionMeshSavedFloorY;
            this.externalVerticalVelocity = 0;
            this.lastCollisionFloorTriangle = null;
            return;
        }
        this.collisionMeshLockedFloorY = null;
        this.collisionMeshLockedFloorTriangle = null;
        this.externalGroundY = null;
    }

    private currentPlayerFeetY(camera = this.camera, focalPoint = camera.focalPoint) {
        return this.playerHead(camera, focalPoint).y - COLLISION_MESH_EYE_HEIGHT;
    }

    private collisionMeshFloorStorageMeshKey() {
        return this.collisionMeshLoadedKey ?? this.collisionMeshKey;
    }

    private collisionMeshFloorStorageKey(meshKey = this.collisionMeshFloorStorageMeshKey()) {
        return meshKey ? `${COLLISION_MESH_FLOOR_STORAGE_PREFIX}:${meshKey}` : null;
    }

    private readSavedCollisionMeshFloorY(meshKey: string, configuredFloorY: number | null = null) {
        const defaultFloorY = configuredFloorY ?? COLLISION_MESH_DEFAULT_FLOOR_HEIGHTS.get(meshKey) ?? null;
        if (typeof window === 'undefined') {
            return defaultFloorY;
        }
        try {
            const storageKey = this.collisionMeshFloorStorageKey(meshKey);
            const value = storageKey ? window.localStorage.getItem(storageKey) : null;
            if (value === null) {
                return defaultFloorY;
            }
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : defaultFloorY;
        } catch {
            return defaultFloorY;
        }
    }

    private persistCollisionMeshFloorHeight(floorY: number) {
        const meshKey = this.collisionMeshFloorStorageMeshKey();
        if (typeof window === 'undefined') {
            return { persisted: false, meshKey };
        }
        try {
            const storageKey = this.collisionMeshFloorStorageKey(meshKey);
            if (!storageKey) {
                return { persisted: false, meshKey };
            }
            window.localStorage.setItem(storageKey, String(floorY));
            return { persisted: true, meshKey };
        } catch {
            return { persisted: false, meshKey };
        }
    }

    private saveCollisionMeshFloorHeight(source = 'manual') {
        const floorY = this.currentPlayerFeetY();
        const { persisted, meshKey } = this.persistCollisionMeshFloorHeight(floorY);
        this.collisionMeshSavedFloorY = floorY;
        this.collisionMeshSavedFloorKey = meshKey;
        this.collisionMeshLockedFloorY = floorY;
        this.collisionMeshLockedFloorTriangle = null;
        this.externalGroundY = floorY;
        this.externalVerticalVelocity = 0;
        this.lastCollisionFloorTriangle = null;
        this.pushCollisionDebugSample('floor-save', {
            floorY: Number(floorY.toFixed(3)),
            source,
            persisted,
            floorStorageKey: this.collisionMeshFloorStorageKey(meshKey),
            savedFloorKey: this.collisionMeshSavedFloorKey
        });
        this.events.fire('walk.collisionMesh', {
            ok: true,
            reason: 'floor-saved',
            embeddedControls: this.embeddedControls,
            floorY: Number(floorY.toFixed(3)),
            floorSource: source,
            persisted,
            floorStorageKey: this.collisionMeshFloorStorageKey(meshKey),
            savedFloorKey: this.collisionMeshSavedFloorKey
        });
        this.scene.forceRender = true;
        return {
            floorY,
            source,
            persisted
        };
    }

    private applyManualHeightInput(input: WalkInputState, dt: number, camera: Camera, focalPoint: Vec3) {
        const verticalAmount = (input.up ? 1 : 0) - (input.down ? 1 : 0);
        if (verticalAmount === 0) {
            return false;
        }

        const speed = this.collisionMesh ? COLLISION_MESH_HEIGHT_ADJUST_SPEED : camera.sceneRadius * 0.18;
        const speedMultiplier = input.sprint || input.slide ? COLLISION_MESH_SPRINT_MULTIPLIER : 1;
        const deltaY = verticalAmount * speed * speedMultiplier * dt;
        focalPoint.y += deltaY;
        if (this.collisionMeshHeadY !== null) {
            this.collisionMeshHeadY += deltaY;
        }

        const floorY = this.currentPlayerFeetY(camera, focalPoint);
        this.externalVerticalVelocity = 0;
        this.externalJumpWasPressed = Boolean(input.jump);
        this.externalGroundY = floorY;
        if (this.collisionMesh) {
            this.collisionMeshLockedFloorY = floorY;
            this.collisionMeshLockedFloorTriangle = null;
            this.lastCollisionFloorTriangle = null;
            this.reportCollisionMesh(performance.now(), 'height-adjust', {
                blocked: false,
                floorY: Number(floorY.toFixed(3)),
                floorTriangle: null,
                floorSource: 'manual',
                deltaY: Number(deltaY.toFixed(3)),
                input: this.collisionDebugInput(input)
            });
        }
        return true;
    }

    private resetCollisionDebugMove(options: { preserveBlock?: boolean } = {}) {
        this.lastCollisionDesiredMove.set(0, 0, 0);
        this.lastCollisionResolvedMove = null;
        if (options.preserveBlock && (this.lastCollisionHitTriangle !== null || this.lastCollisionBlockedBody)) {
            return;
        }
        this.lastCollisionDebugReason = 'idle';
        this.lastCollisionHitTriangle = null;
        this.lastCollisionBlockedBody = null;
    }

    private reportCollisionMesh(now: number, reason: string, details: Record<string, unknown>) {
        this.pushCollisionDebugSample('move', {
            reason,
            embeddedControls: this.embeddedControls,
            input: this.collisionDebugInput(this.walkInputState),
            ...details
        });
        if (reason === 'blocked' && now - this.lastCollisionMeshBlockReportAt < COLLISION_MESH_BLOCK_REPORT_INTERVAL_MS) {
            return;
        }
        if (reason !== 'blocked' && now - this.lastCollisionMeshReportAt < COLLISION_MESH_REPORT_INTERVAL_MS) {
            return;
        }

        this.lastCollisionMeshReportAt = now;
        if (reason === 'blocked') {
            this.lastCollisionMeshBlockReportAt = now;
        }
        this.events.fire('walk.collisionMesh', {
            ok: true,
            reason,
            embeddedControls: this.embeddedControls,
            ...details
        });
    }

    private resolveCollisionMeshMove(bodies: PlayerCollisionBody[], desiredMove: Vec3) {
        const mesh = this.collisionMesh;
        if (!mesh) {
            return desiredMove;
        }

        const now = performance.now();
        const fullMove = desiredMove.clone();
        this.lastCollisionDesiredMove.copy(fullMove);
        this.lastCollisionResolvedMove = null;
        this.lastCollisionHitTriangle = null;
        this.lastCollisionBlockedBody = null;

        if (Math.hypot(fullMove.x, fullMove.z) <= 0.00001) {
            this.lastCollisionDebugReason = 'idle';
            return fullMove;
        }

        if (!this.collisionMeshBlockingEnabled) {
            this.collisionMeshBlockedSince = null;
            this.lastCollisionDebugReason = 'floor-only';
            this.lastCollisionResolvedMove = fullMove.clone();
            return fullMove;
        }

        const hit = this.firstCollisionMeshHit(mesh, bodies, fullMove);
        if (!hit) {
            this.collisionMeshBlockedSince = null;
            this.lastCollisionDebugReason = 'clear';
            this.lastCollisionResolvedMove = fullMove.clone();
            this.reportCollisionMesh(now, 'clear', {
                blocked: false,
                body: bodies.length,
                ...this.collisionMeshBodyDetails(mesh, bodies[0]),
                moveX: Number(fullMove.x.toFixed(3)),
                moveZ: Number(fullMove.z.toFixed(3))
            });
            return fullMove;
        }

        this.lastCollisionHitTriangle = hit.triangle ?? null;
        this.lastCollisionBlockedBody = WalkTool.cloneCollisionBody(hit.body);
        const slideCandidates = [
            new Vec3(fullMove.x, 0, 0),
            new Vec3(0, 0, fullMove.z)
        ].filter(candidate => Math.hypot(candidate.x, candidate.z) > 0.00001);
        for (const candidate of slideCandidates.sort((a, b) => Math.hypot(b.x, b.z) - Math.hypot(a.x, a.z))) {
            if (!this.firstCollisionMeshHit(mesh, bodies, candidate)) {
                this.collisionMeshBlockedSince = null;
                this.lastCollisionDebugReason = 'slide';
                this.lastCollisionResolvedMove = candidate.clone();
                this.reportCollisionMesh(now, 'slide', {
                    blocked: false,
                    triangle: hit?.triangle ?? null,
                    anchor: hit?.anchor ?? null,
                    sweepStep: hit?.step ?? null,
                    sweepSteps: hit?.steps ?? null,
                    ...this.collisionMeshBodyDetails(mesh, bodies[0]),
                    moveX: Number(candidate.x.toFixed(3)),
                    moveZ: Number(candidate.z.toFixed(3))
                });
                return candidate;
            }
        }

        const blockedBody = hit?.body ?? {
            ...bodies[0],
            eye: bodies[0].eye.clone().add(fullMove),
            head: bodies[0].head.clone().add(fullMove)
        };
        if (this.collisionMeshBlockedSince === null) {
            this.collisionMeshBlockedSince = now;
        }
        const blockedMs = now - this.collisionMeshBlockedSince;
        this.lastCollisionDebugReason = blockedMs >= COLLISION_MESH_STUCK_MS ? 'stuck' : 'blocked';
        this.reportCollisionMesh(now, blockedMs >= COLLISION_MESH_STUCK_MS ? 'stuck' : 'blocked', {
            blocked: true,
            triangle: hit?.triangle ?? null,
            anchor: hit?.anchor ?? null,
            sweepStep: hit?.step ?? null,
            sweepSteps: hit?.steps ?? null,
            stuckMs: Number(blockedMs.toFixed(1)),
            ...this.collisionMeshBodyDetails(mesh, blockedBody),
            moveX: Number(fullMove.x.toFixed(3)),
            moveZ: Number(fullMove.z.toFixed(3))
        });
        return null;
    }

    private collisionMeshGroundHit(mesh: WalkCollisionMesh, x: number, z: number, feetY: number, snapUp: number, snapDown: number) {
        if (this.collisionMeshLockedFloorY !== null) {
            return {
                y: this.collisionMeshLockedFloorY,
                triangle: this.collisionMeshLockedFloorTriangle,
                source: 'locked' as const
            };
        }

        const hit = mesh.groundYNear(x, z, feetY + snapUp, feetY - snapDown);
        if (hit) {
            if (this.externalGroundY !== null &&
                hit.y < this.externalGroundY - COLLISION_MESH_GROUND_CACHE_DROP &&
                feetY >= this.externalGroundY - COLLISION_MESH_GROUND_CACHE_DROP) {
                return {
                    y: this.externalGroundY,
                    triangle: null,
                    source: 'cached' as const
                };
            }
            this.collisionMeshLockedFloorY = hit.y;
            this.collisionMeshLockedFloorTriangle = hit.triangle ?? null;
            this.externalGroundY = hit.y;
            this.pushCollisionDebugSample('floor-lock', {
                floorY: Number(hit.y.toFixed(3)),
                floorTriangle: hit.triangle ?? null,
                floorSource: hit.source ?? 'mesh'
            });
            return hit;
        }

        if (this.externalGroundY !== null &&
            feetY <= this.externalGroundY + COLLISION_MESH_GROUND_CACHE_RISE &&
            feetY >= this.externalGroundY - COLLISION_MESH_GROUND_CACHE_DROP) {
            return {
                y: this.externalGroundY,
                triangle: null,
                source: 'cached' as const
            };
        }

        if (this.embeddedControls && this.externalGroundY !== null) {
            return {
                y: this.externalGroundY,
                triangle: null,
                source: 'cached' as const
            };
        }

        return null;
    }

    private applyCollisionMeshVertical(input: WalkInputState, dt: number, camera: Camera, focalPoint: Vec3) {
        const mesh = this.collisionMesh;
        if (!mesh) {
            return false;
        }

        let changed = false;
        let eye = this.playerHead(camera, focalPoint);
        let feetY = eye.y - COLLISION_MESH_EYE_HEIGHT;
        const groundHit = this.collisionMeshGroundHit(mesh,
            eye.x,
            eye.z,
            feetY,
            COLLISION_MESH_GROUND_SNAP,
            COLLISION_MESH_GROUND_SNAP * 3
        );
        const groundY = groundHit?.y ?? null;
        let reportGroundHit = groundHit ?? null;
        let reportGroundY = groundY;
        this.lastCollisionFloorTriangle = reportGroundHit?.triangle ?? null;
        const grounded = groundY !== null && feetY <= groundY + 0.04 && this.externalVerticalVelocity <= 0;

        if (input.jump && !this.externalJumpWasPressed && grounded) {
            this.externalVerticalVelocity = COLLISION_MESH_JUMP_SPEED;
        } else if (grounded && groundY !== null && Math.abs(feetY - groundY) > 0.001) {
            const snap = groundY - feetY;
            focalPoint.y += snap;
            if (this.collisionMeshHeadY !== null) {
                this.collisionMeshHeadY += snap;
            }
            this.externalVerticalVelocity = 0;
            changed = true;
            eye = this.playerHead(camera, focalPoint);
            feetY = eye.y - COLLISION_MESH_EYE_HEIGHT;
        }

        this.externalJumpWasPressed = Boolean(input.jump);

        if (this.externalVerticalVelocity !== 0 || !grounded) {
            this.externalVerticalVelocity -= COLLISION_MESH_GRAVITY * dt;
            const deltaY = this.externalVerticalVelocity * dt;
            focalPoint.y += deltaY;
            if (this.collisionMeshHeadY !== null) {
                this.collisionMeshHeadY += deltaY;
            }
            changed = true;

            eye = this.playerHead(camera, focalPoint);
            feetY = eye.y - COLLISION_MESH_EYE_HEIGHT;
            const nextGroundHit = this.collisionMeshGroundHit(mesh,
                eye.x,
                eye.z,
                feetY,
                COLLISION_MESH_GROUND_SNAP,
                COLLISION_MESH_GROUND_SNAP * 4
            );
            const nextGroundY = nextGroundHit?.y ?? null;
            if (nextGroundHit) {
                reportGroundHit = nextGroundHit;
                reportGroundY = nextGroundY;
                this.lastCollisionFloorTriangle = nextGroundHit.triangle ?? null;
            }
            if (nextGroundY !== null && feetY <= nextGroundY && this.externalVerticalVelocity <= 0) {
                const snap = nextGroundY - feetY;
                focalPoint.y += snap;
                if (this.collisionMeshHeadY !== null) {
                    this.collisionMeshHeadY += snap;
                }
                this.externalVerticalVelocity = 0;
            }
        }

        this.externalGroundY = reportGroundY;
        if (changed || this.externalVerticalVelocity !== 0) {
            this.reportCollisionMesh(performance.now(), grounded ? 'ground' : 'air', {
                blocked: false,
                floorY: reportGroundY === null ? null : Number(reportGroundY.toFixed(3)),
                floorTriangle: reportGroundHit?.triangle ?? null,
                floorSource: reportGroundHit?.source ?? null,
                eyeX: Number(eye.x.toFixed(3)),
                eyeY: Number(eye.y.toFixed(3)),
                eyeZ: Number(eye.z.toFixed(3)),
                feetY: Number(feetY.toFixed(3)),
                verticalVelocity: Number(this.externalVerticalVelocity.toFixed(3)),
                input: this.collisionDebugInput(input)
            });
        }
        return changed;
    }

    private resolveCollisionMeshPenetration(camera: Camera, focalPoint: Vec3) {
        const mesh = this.collisionMesh;
        if (!mesh || !this.collisionMeshBlockingEnabled) {
            return false;
        }

        const body = this.playerCollisionBodies(camera)[0];
        const currentHit = mesh.intersectsPlayerBody(body);
        if (!currentHit.blocked) {
            return false;
        }

        const directions = 24;
        for (let radius = COLLISION_MESH_DEPENETRATE_STEP; radius <= COLLISION_MESH_DEPENETRATE_RADIUS; radius += COLLISION_MESH_DEPENETRATE_STEP) {
            for (let i = 0; i < directions; i += 1) {
                const angle = i / directions * Math.PI * 2;
                const offset = new Vec3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
                const candidate = {
                    ...body,
                    head: body.head.clone().add(offset)
                };
                if (mesh.intersectsPlayerBody(candidate).blocked) {
                    continue;
                }

                focalPoint.add(offset);
                this.collisionMeshBlockedSince = null;
                this.reportCollisionMesh(performance.now(), 'depenetrate', {
                    blocked: false,
                    triangle: currentHit.triangle ?? null,
                    ...this.collisionMeshBodyDetails(mesh, candidate),
                    moveX: Number(offset.x.toFixed(3)),
                    moveZ: Number(offset.z.toFixed(3))
                });
                return true;
            }
        }

        return false;
    }

    private firstCollisionMeshHit(mesh: WalkCollisionMesh, bodies: PlayerCollisionBody[], move: Vec3) {
        const stepCount = Math.max(1, Math.ceil(Math.hypot(move.x, move.z) / COLLISION_MESH_SWEEP_STEP));
        for (let step = 1; step <= stepCount; step += 1) {
            const scale = step / stepCount;
            for (let i = 0; i < bodies.length; i += 1) {
                const body = {
                    ...bodies[i],
                    eye: bodies[i].eye.clone().add(tmpVec.copy(move).mulScalar(scale)),
                    head: bodies[i].head.clone().add(tmpVec.copy(move).mulScalar(scale))
                };
                const hit = mesh.intersectsPlayerBody(body);
                if (hit.blocked) {
                    return {
                        anchor: `player-${i}`,
                        body,
                        step,
                        steps: stepCount,
                        triangle: hit.triangle
                    };
                }
            }
        }
        return null;
    }

    private collisionMeshBodyDetails(mesh: WalkCollisionMesh, body: PlayerCollisionBody) {
        const feetY = body.eye.y - body.eyeHeight;
        const floor = this.collisionMeshGroundHit(mesh,
            body.eye.x,
            body.eye.z,
            feetY,
            COLLISION_MESH_GROUND_SNAP,
            COLLISION_MESH_GROUND_SNAP * 3
        );
        return {
            headX: Number(body.head.x.toFixed(3)),
            headY: Number(body.head.y.toFixed(3)),
            headZ: Number(body.head.z.toFixed(3)),
            eyeX: Number(body.eye.x.toFixed(3)),
            eyeY: Number(body.eye.y.toFixed(3)),
            eyeZ: Number(body.eye.z.toFixed(3)),
            feetY: Number(feetY.toFixed(3)),
            floorY: floor ? Number(floor.y.toFixed(3)) : null,
            floorTriangle: floor?.triangle ?? null,
            floorSource: floor?.source ?? null,
            radius: Number(body.radius.toFixed(3)),
            playerHeight: Number(body.height.toFixed(3)),
            eyeHeight: Number(body.eyeHeight.toFixed(3)),
            stepHeight: Number(COLLISION_MESH_STEP_HEIGHT.toFixed(3))
        };
    }

    private playerCollisionBodies(camera = this.camera): PlayerCollisionBody[] {
        const eye = this.playerHead(camera);
        const head = eye.clone();
        head.y += COLLISION_MESH_PLAYER_HEIGHT - COLLISION_MESH_EYE_HEIGHT;
        return [{
            head,
            eye,
            height: COLLISION_MESH_PLAYER_HEIGHT,
            eyeHeight: COLLISION_MESH_EYE_HEIGHT,
            radius: COLLISION_MESH_CAPSULE_RADIUS
        }];
    }

    private playerHead(camera = this.camera, focalPoint = camera.focalPoint) {
        const distance = camera.distance * camera.sceneRadius / camera.fovFactor;
        if (this.embeddedControls && distance > COLLISION_MESH_FIRST_PERSON_SNAP_DISTANCE) {
            return focalPoint.clone();
        }
        Camera.calcForwardVec(forwardVec, camera.azim, camera.elevation);
        return focalPoint.clone().add(forwardVec.clone().mulScalar(distance));
    }

    private syncCollisionMeshPreviewOverlay() {
        if (!this.collisionMeshMiniOverlayEnabled || !this.collisionMesh || typeof document === 'undefined') {
            this.removeCollisionMeshPreviewOverlay();
            return;
        }

        const canvas = this.ensureCollisionMeshPreviewCanvas();
        if (!canvas) {
            return;
        }

        this.drawCollisionMeshPreviewCanvas(canvas, this.collisionMesh);
    }

    private ensureCollisionMeshPreviewCanvas() {
        if (this.collisionMeshPreviewCanvas?.isConnected) {
            return this.collisionMeshPreviewCanvas;
        }
        if (!document.body) {
            return null;
        }

        const canvas = document.createElement('canvas');
        canvas.style.position = 'fixed';
        canvas.style.left = '12px';
        canvas.style.bottom = '12px';
        canvas.style.width = `${COLLISION_MESH_PREVIEW_CANVAS_SIZE}px`;
        canvas.style.height = `${COLLISION_MESH_PREVIEW_CANVAS_SIZE}px`;
        canvas.style.zIndex = '2147483646';
        canvas.style.pointerEvents = 'none';
        canvas.style.background = 'rgba(2, 6, 8, 0.72)';
        canvas.style.border = '1px solid rgba(180, 245, 255, 0.42)';
        canvas.style.borderRadius = '6px';
        canvas.style.boxShadow = '0 8px 24px rgba(0, 0, 0, 0.38)';
        document.body.appendChild(canvas);
        this.collisionMeshPreviewCanvas = canvas;
        return canvas;
    }

    private removeCollisionMeshPreviewOverlay() {
        this.collisionMeshPreviewCanvas?.remove();
        this.collisionMeshPreviewCanvas = null;
    }

    private drawCollisionMeshPreviewCanvas(canvas: HTMLCanvasElement, mesh: WalkCollisionMesh) {
        const context = canvas.getContext('2d');
        if (!context) {
            return;
        }

        const pixelRatio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
        const pixelSize = Math.round(COLLISION_MESH_PREVIEW_CANVAS_SIZE * pixelRatio);
        if (canvas.width !== pixelSize || canvas.height !== pixelSize) {
            canvas.width = pixelSize;
            canvas.height = pixelSize;
        }

        context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        context.clearRect(0, 0, COLLISION_MESH_PREVIEW_CANVAS_SIZE, COLLISION_MESH_PREVIEW_CANVAS_SIZE);
        context.fillStyle = 'rgba(2, 6, 8, 0.72)';
        context.fillRect(0, 0, COLLISION_MESH_PREVIEW_CANVAS_SIZE, COLLISION_MESH_PREVIEW_CANVAS_SIZE);

        const bounds = mesh.bounds;
        const sizeX = Math.max(0.001, bounds.maxX - bounds.minX);
        const sizeZ = Math.max(0.001, bounds.maxZ - bounds.minZ);
        const centerX = (bounds.minX + bounds.maxX) / 2;
        const centerZ = (bounds.minZ + bounds.maxZ) / 2;
        const scale = (COLLISION_MESH_PREVIEW_CANVAS_SIZE - COLLISION_MESH_PREVIEW_CANVAS_PADDING * 2) / Math.max(sizeX, sizeZ);
        const project = (x: number, z: number) => ({
            x: COLLISION_MESH_PREVIEW_CANVAS_SIZE / 2 + (x - centerX) * scale,
            y: COLLISION_MESH_PREVIEW_CANVAS_SIZE / 2 - (z - centerZ) * scale
        });

        context.lineWidth = 1;
        context.strokeStyle = 'rgba(180, 245, 255, 0.22)';
        context.strokeRect(
            COLLISION_MESH_PREVIEW_CANVAS_SIZE / 2 - sizeX * scale / 2,
            COLLISION_MESH_PREVIEW_CANVAS_SIZE / 2 - sizeZ * scale / 2,
            sizeX * scale,
            sizeZ * scale
        );

        for (const voxel of mesh.debugVoxels(COLLISION_MESH_PREVIEW_MINI_VOXEL_LIMIT)) {
            const center = project(voxel.x, voxel.z);
            const size = Math.max(1.2, voxel.size * scale * COLLISION_MESH_DEBUG_VOXEL_VISUAL_SCALE);
            context.fillStyle = voxel.blocking ? 'rgba(255, 82, 64, 0.58)' : 'rgba(78, 255, 146, 0.48)';
            context.fillRect(center.x - size / 2, center.y - size / 2, size, size);
        }

        context.strokeStyle = 'rgba(255, 236, 128, 0.86)';
        context.beginPath();
        context.moveTo(COLLISION_MESH_PREVIEW_CANVAS_SIZE / 2 - 5, COLLISION_MESH_PREVIEW_CANVAS_SIZE / 2);
        context.lineTo(COLLISION_MESH_PREVIEW_CANVAS_SIZE / 2 + 5, COLLISION_MESH_PREVIEW_CANVAS_SIZE / 2);
        context.moveTo(COLLISION_MESH_PREVIEW_CANVAS_SIZE / 2, COLLISION_MESH_PREVIEW_CANVAS_SIZE / 2 - 5);
        context.lineTo(COLLISION_MESH_PREVIEW_CANVAS_SIZE / 2, COLLISION_MESH_PREVIEW_CANVAS_SIZE / 2 + 5);
        context.stroke();
    }

    private drawCollisionDebug() {
        if ((!this.collisionDebugEnabled && !this.collisionMeshPreviewEnabled) || !this.active || !this.collisionMesh) {
            return;
        }

        const mesh = this.collisionMesh;
        const body = this.playerCollisionBodies()[0];
        if (this.collisionMeshPreviewEnabled) {
            this.drawDebugMeshPreview(mesh);
        }

        if (!this.collisionDebugEnabled) {
            this.scene.forceRender = true;
            return;
        }

        const feetY = body.eye.y - body.eyeHeight;
        const floor = this.collisionMeshGroundHit(mesh,
            body.eye.x,
            body.eye.z,
            feetY,
            COLLISION_MESH_GROUND_SNAP,
            COLLISION_MESH_GROUND_SNAP * 3
        );
        this.lastCollisionFloorTriangle = floor?.triangle ?? null;

        this.drawDebugTriangles(mesh, body, floor);
        this.drawDebugPlayerCapsule(body);
        this.drawDebugBlockedBody(body);
        this.drawDebugFloorProbe(body, feetY, floor);
        this.drawDebugMoveVectors(body);

        this.scene.forceRender = true;
    }

    private drawDebugMeshPreview(mesh: WalkCollisionMesh) {
        for (const voxel of mesh.debugVoxels()) {
            this.drawDebugVoxel(voxel, voxel.blocking ? COLLISION_DEBUG_PREVIEW_WALL_COLOR : COLLISION_DEBUG_PREVIEW_FLOOR_COLOR);
        }
    }

    private drawDebugVoxel(voxel: CollisionDebugVoxel, color: Color) {
        const half = voxel.size * COLLISION_MESH_DEBUG_VOXEL_VISUAL_SCALE / 2;
        const x0 = voxel.x - half;
        const x1 = voxel.x + half;
        const y0 = voxel.y - half;
        const y1 = voxel.y + half;
        const z0 = voxel.z - half;
        const z1 = voxel.z + half;
        const corners = [
            new Vec3(x0, y0, z0),
            new Vec3(x1, y0, z0),
            new Vec3(x1, y0, z1),
            new Vec3(x0, y0, z1),
            new Vec3(x0, y1, z0),
            new Vec3(x1, y1, z0),
            new Vec3(x1, y1, z1),
            new Vec3(x0, y1, z1)
        ];
        const edges = [
            [0, 1], [1, 2], [2, 3], [3, 0],
            [4, 5], [5, 6], [6, 7], [7, 4],
            [0, 4], [1, 5], [2, 6], [3, 7]
        ];

        for (const [from, to] of edges) {
            this.drawCollisionMeshPreviewLine(corners[from], corners[to], color);
        }
    }

    private drawDebugTriangles(mesh: WalkCollisionMesh, body: PlayerCollisionBody, floor: GroundMeshHit | null) {
        const triangles = mesh.debugTrianglesNear(body.eye.x, body.eye.z);
        const drawn = new Set<number>();
        for (const { index, triangle } of triangles) {
            const color = index === this.lastCollisionHitTriangle ?
                COLLISION_DEBUG_HIT_COLOR :
                index === floor?.triangle || index === this.lastCollisionFloorTriangle ?
                    COLLISION_DEBUG_RAY_COLOR :
                    triangle.blocking ? COLLISION_DEBUG_WALL_COLOR : COLLISION_DEBUG_FLOOR_COLOR;
            this.drawDebugTriangle(triangle, color);
            drawn.add(index);
        }
        this.drawDebugTriangleByIndex(mesh, drawn, floor?.triangle ?? this.lastCollisionFloorTriangle, COLLISION_DEBUG_RAY_COLOR);
        this.drawDebugTriangleByIndex(mesh, drawn, this.lastCollisionHitTriangle, COLLISION_DEBUG_HIT_COLOR);
        this.drawDebugTriangleMarkerByIndex(mesh, this.lastCollisionHitTriangle, COLLISION_DEBUG_HIT_COLOR);
    }

    private drawDebugTriangleByIndex(mesh: WalkCollisionMesh, drawn: Set<number>, index: number | null, color: Color) {
        if (index === null || drawn.has(index)) {
            return;
        }
        const triangle = mesh.triangleAt(index);
        if (!triangle) {
            return;
        }
        this.drawDebugTriangle(triangle, color);
        drawn.add(index);
    }

    private drawDebugTriangleMarkerByIndex(mesh: WalkCollisionMesh, index: number | null, color: Color) {
        if (index === null) {
            return;
        }
        const triangle = mesh.triangleAt(index);
        if (!triangle) {
            return;
        }
        const center = new Vec3(
            (triangle.ax + triangle.bx + triangle.cx) / 3,
            (triangle.ay + triangle.by + triangle.cy) / 3,
            (triangle.az + triangle.bz + triangle.cz) / 3
        );
        const size = 0.18;
        this.drawDebugLine(new Vec3(center.x - size, center.y, center.z), new Vec3(center.x + size, center.y, center.z), color);
        this.drawDebugLine(new Vec3(center.x, center.y - size, center.z), new Vec3(center.x, center.y + size, center.z), color);
        this.drawDebugLine(new Vec3(center.x, center.y, center.z - size), new Vec3(center.x, center.y, center.z + size), color);
    }

    private drawDebugTriangle(triangle: CollisionTriangle, color: Color) {
        const a = new Vec3(triangle.ax, triangle.ay, triangle.az);
        const b = new Vec3(triangle.bx, triangle.by, triangle.bz);
        const c = new Vec3(triangle.cx, triangle.cy, triangle.cz);
        this.drawDebugLine(a, b, color);
        this.drawDebugLine(b, c, color);
        this.drawDebugLine(c, a, color);
    }

    private drawDebugPlayerCapsule(body: PlayerCollisionBody, color = COLLISION_DEBUG_PLAYER_COLOR, eyeColor = COLLISION_DEBUG_EYE_COLOR) {
        const feetY = body.eye.y - body.eyeHeight;
        const headY = body.head.y;
        this.drawDebugCircleXZ(new Vec3(body.eye.x, feetY, body.eye.z), body.radius, color);
        this.drawDebugCircleXZ(new Vec3(body.eye.x, body.eye.y, body.eye.z), body.radius, eyeColor);
        this.drawDebugCircleXZ(new Vec3(body.head.x, headY, body.head.z), body.radius, color);

        for (const [dx, dz] of [[body.radius, 0], [-body.radius, 0], [0, body.radius], [0, -body.radius]]) {
            this.drawDebugLine(
                new Vec3(body.eye.x + dx, feetY, body.eye.z + dz),
                new Vec3(body.head.x + dx, headY, body.head.z + dz),
                color
            );
        }
    }

    private drawDebugBlockedBody(currentBody: PlayerCollisionBody) {
        const blockedBody = this.lastCollisionBlockedBody;
        if (!blockedBody) {
            return;
        }
        this.drawDebugPlayerCapsule(blockedBody, COLLISION_DEBUG_HIT_COLOR, COLLISION_DEBUG_HIT_COLOR);
        this.drawDebugLine(currentBody.eye, blockedBody.eye, COLLISION_DEBUG_HIT_COLOR);
        this.drawDebugCircleXZ(blockedBody.eye, blockedBody.radius * 1.45, COLLISION_DEBUG_HIT_COLOR);
    }

    private drawDebugFloorProbe(body: PlayerCollisionBody, feetY: number, floor: GroundMeshHit | null) {
        const top = new Vec3(body.eye.x, feetY + COLLISION_MESH_GROUND_SNAP, body.eye.z);
        const bottom = new Vec3(body.eye.x, feetY - COLLISION_MESH_GROUND_SNAP * 3, body.eye.z);
        this.drawDebugLine(top, bottom, COLLISION_DEBUG_RAY_COLOR);

        if (floor) {
            const hit = new Vec3(body.eye.x, floor.y, body.eye.z);
            const markerSize = Math.max(0.04, body.radius * 0.25);
            this.drawDebugLine(
                new Vec3(hit.x - markerSize, hit.y, hit.z),
                new Vec3(hit.x + markerSize, hit.y, hit.z),
                COLLISION_DEBUG_RAY_COLOR
            );
            this.drawDebugLine(
                new Vec3(hit.x, hit.y, hit.z - markerSize),
                new Vec3(hit.x, hit.y, hit.z + markerSize),
                COLLISION_DEBUG_RAY_COLOR
            );
        }
    }

    private drawDebugMoveVectors(body: PlayerCollisionBody) {
        const origin = new Vec3(body.eye.x, body.eye.y, body.eye.z);
        if (Math.hypot(this.lastCollisionDesiredMove.x, this.lastCollisionDesiredMove.z) > 0.00001) {
            this.drawDebugLine(origin, origin.clone().add(this.lastCollisionDesiredMove), COLLISION_DEBUG_DESIRED_MOVE_COLOR);
        }
        if (this.lastCollisionResolvedMove && Math.hypot(this.lastCollisionResolvedMove.x, this.lastCollisionResolvedMove.z) > 0.00001) {
            const offsetOrigin = origin.clone();
            offsetOrigin.y += 0.06;
            this.drawDebugLine(offsetOrigin, offsetOrigin.clone().add(this.lastCollisionResolvedMove), COLLISION_DEBUG_RESOLVED_MOVE_COLOR);
        }
        if (this.lastCollisionDebugReason === 'blocked' || this.lastCollisionDebugReason === 'stuck') {
            this.drawDebugCircleXZ(origin, body.radius * 1.18, COLLISION_DEBUG_HIT_COLOR);
        }
    }

    private drawDebugCircleXZ(center: Vec3, radius: number, color: Color) {
        const segments = 28;
        let previous = new Vec3(center.x + radius, center.y, center.z);
        for (let i = 1; i <= segments; i += 1) {
            const angle = i / segments * Math.PI * 2;
            const next = new Vec3(center.x + Math.cos(angle) * radius, center.y, center.z + Math.sin(angle) * radius);
            this.drawDebugLine(previous, next, color);
            previous = next;
        }
    }

    private drawDebugLine(a: Vec3, b: Vec3, color: Color) {
        this.scene.app.drawLine(a, b, color, true, this.scene.worldLayer);
    }

    private drawCollisionMeshPreviewLine(a: Vec3, b: Vec3, color: Color) {
        this.scene.app.drawLine(a, b, color, false, this.scene.worldLayer);
    }

    private applyCollisionHeadHeightLock(camera: Camera, focalPoint: Vec3) {
        if (!this.collisionMesh) {
            this.collisionMeshHeadY = null;
            return false;
        }

        const head = this.playerHead(camera, focalPoint);
        if (this.collisionMeshHeadY === null) {
            this.collisionMeshHeadY = head.y;
            return false;
        }

        const deltaY = this.collisionMeshHeadY - head.y;
        if (Math.abs(deltaY) <= 0.0001) {
            return false;
        }

        focalPoint.y += deltaY;
        return true;
    }

    private updateCollisionProxy(enabled: boolean) {
        const now = performance.now();
        if (!enabled || this.embeddedControls) {
            if (this.collisionProxy.blocked) {
                this.collisionProxy.blocked = false;
                this.reportCollisionProxy(now, this.embeddedControls ? 'embedded-disabled' : 'released');
            } else if (enabled && this.embeddedControls && now - this.collisionProxy.lastReportAt >= COLLISION_REPORT_INTERVAL_MS) {
                this.collisionProxy.frontDistance = null;
                this.collisionProxy.sampleMs = null;
                this.reportCollisionProxy(now, 'embedded-disabled');
            } else if (now - this.collisionProxy.lastReportAt >= COLLISION_REPORT_INTERVAL_MS && this.collisionProxy.frontDistance !== null) {
                this.collisionProxy.frontDistance = null;
                this.collisionProxy.sampleMs = null;
                this.reportCollisionProxy(now, 'idle');
            }
            return;
        }
        if (now - this.lastLookAt < COLLISION_POINTER_LOOK_DEFER_MS &&
            now - this.collisionProxy.lastSampleAt < COLLISION_POINTER_LOOK_MAX_DEFER_MS) {
            return;
        }
        const regularSampleInterval = this.embeddedControls ? COLLISION_EMBEDDED_SAMPLE_INTERVAL_MS : COLLISION_SAMPLE_INTERVAL_MS;
        const sampleInterval = (this.collisionProxy.sampleMs ?? 0) > COLLISION_SLOW_SAMPLE_MS ?
            COLLISION_SLOW_SAMPLE_INTERVAL_MS :
            regularSampleInterval;
        if (this.collisionProxy.pending || now - this.collisionProxy.lastSampleAt < sampleInterval) {
            return;
        }

        const camera = this.camera;
        const viewDistance = Math.max(0.001, camera.distance * camera.sceneRadius / camera.fovFactor);
        this.collisionProxy.pending = true;
        this.collisionProxy.lastSampleAt = now;
        this.collisionProxy.viewDistance = viewDistance;
        const sampleStartedAt = performance.now();

        camera.intersect(0.5, 0.5).then((hit) => {
            const sampleMs = performance.now() - sampleStartedAt;
            const distance = typeof hit?.distance === 'number' && Number.isFinite(hit.distance) ? hit.distance : null;
            const clearance = Math.max(0.12, Math.min(0.9, viewDistance * 0.18));
            const canBlockFromView = Math.abs(camera.elevation) <= COLLISION_MAX_BLOCK_ELEVATION_DEG;
            const blocked = canBlockFromView && distance !== null && distance < viewDistance - clearance;
            const changed = blocked !== this.collisionProxy.blocked;
            this.collisionProxy.pending = false;
            this.collisionProxy.frontDistance = distance;
            this.collisionProxy.blocked = blocked;
            this.collisionProxy.sampleMs = sampleMs;
            if (changed || sampleMs >= COLLISION_SLOW_SAMPLE_MS || now - this.collisionProxy.lastReportAt >= COLLISION_REPORT_INTERVAL_MS) {
                this.reportCollisionProxy(performance.now(), changed ? 'changed' : sampleMs >= COLLISION_SLOW_SAMPLE_MS ? 'slow-sample' : 'sampled', {
                    canBlockFromView,
                    clearance,
                    sampleInterval
                });
            }
        }).catch((error: unknown) => {
            this.collisionProxy.pending = false;
            this.collisionProxy.frontDistance = null;
            this.collisionProxy.blocked = false;
            this.collisionProxy.sampleMs = null;
            this.events.fire('walk.collisionProxy', {
                ok: false,
                error: error instanceof Error ? error.message : 'collision proxy sample failed'
            });
        });
    }

    private reportCollisionProxy(now: number, reason: string, details: Record<string, unknown> = {}) {
        this.collisionProxy.lastReportAt = now;
        this.events.fire('walk.collisionProxy', {
            ok: true,
            reason,
            blocked: this.collisionProxy.blocked,
            pending: this.collisionProxy.pending,
            embeddedControls: this.embeddedControls,
            frontDistance: this.collisionProxy.frontDistance === null ? null : Number(this.collisionProxy.frontDistance.toFixed(3)),
            viewDistance: Number(this.collisionProxy.viewDistance.toFixed(3)),
            sampleMs: this.collisionProxy.sampleMs === null ? null : Number(this.collisionProxy.sampleMs.toFixed(1)),
            lookAgeMs: Number(Math.max(0, now - this.lastLookAt).toFixed(1)),
            elevation: Number(this.camera.elevation.toFixed(2)),
            ...details
        });
    }

    private look(dx: number, dy: number) {
        const camera = this.camera;
        const distance = camera.distance * camera.sceneRadius / camera.fovFactor;

        const playerHead = this.playerHead(camera);

        const sensitivity = camera.scene.config.controls.orbitSensitivity;
        const azim = camera.azim - dx * sensitivity;
        const elev = camera.elevation - dy * sensitivity;

        Camera.calcForwardVec(forwardVec, azim, elev);
        const focalPoint = this.embeddedControls && distance > COLLISION_MESH_FIRST_PERSON_SNAP_DISTANCE ?
            playerHead :
            playerHead.clone().sub(forwardVec.clone().mulScalar(distance));

        camera.setAzimElev(azim, elev, 0);
        camera.setFocalPoint(focalPoint, 0);
        this.scene.forceRender = true;
    }

    private updateLoop() {
        if (this.warmupBackground) {
            this.animFrame = null;
            return;
        }

        if (!this.active && !this.hasExternalWalkInput()) {
            this.animFrame = null;
            return;
        }

        const now = performance.now();
        if (this.active && !this.embeddedControls && this.overlay && now - this.lastArrowPositionAt >= 120) {
            this.lastArrowPositionAt = now;
            this.positionArrows();
        }
        this.applyExternalWalkInput();
        this.animFrame = requestAnimationFrame(() => this.updateLoop());
    }

    private positionArrows() {
        const camera = this.camera;
        const focalPoint = camera.focalPoint;

        // Place arrows on the actual scene floor, fixed world directions
        const floorY = this.groundY;
        const arrowDist = this.stepSize * 0.7;

        // Ground-projected focal point (directly below focal point on the floor)
        const groundCenter = new Vec3(focalPoint.x, floorY, focalPoint.z);

        // Fixed NSEW world-space positions
        const positions: Record<ArrowDirection, Vec3> = {
            north: new Vec3(groundCenter.x, floorY, groundCenter.z - arrowDist),
            south: new Vec3(groundCenter.x, floorY, groundCenter.z + arrowDist),
            east: new Vec3(groundCenter.x + arrowDist, floorY, groundCenter.z),
            west: new Vec3(groundCenter.x - arrowDist, floorY, groundCenter.z)
        };

        const width = this.container.clientWidth;
        const height = this.container.clientHeight;

        // Project center to screen for computing arrow rotation angles
        const centerScreen = new Vec3();
        camera.worldToScreen(groundCenter, centerScreen);
        const cx = centerScreen.x * width;
        const cy = centerScreen.y * height;

        for (const [dir, el] of this.arrows) {
            const worldPos = positions[dir];
            camera.worldToScreen(worldPos, screenPos);

            const px = screenPos.x * width;
            const py = screenPos.y * height;

            // Hide if behind camera or outside viewport
            if (screenPos.z < 0 || screenPos.z > 1 ||
                px < -24 || px > width + 24 ||
                py < -24 || py > height + 24) {
                el.style.display = 'none';
                continue;
            }

            // Compute rotation so arrow SVG points away from center in screen space
            const angleDeg = Math.atan2(px - cx, -(py - cy)) * (180 / Math.PI);

            el.style.display = 'flex';
            el.style.left = `${px - 24}px`;
            el.style.top = `${py - 24}px`;
            el.style.transform = `rotate(${angleDeg}deg)`;
        }
    }

    private destroyOverlay() {
        if (this.onPointerDownBound) {
            this.container.removeEventListener('pointerdown', this.onPointerDownBound);
            this.onPointerDownBound = null;
        }
        if (this.onPointerLockMouseMoveBound) {
            document.removeEventListener('mousemove', this.onPointerLockMouseMoveBound);
            this.onPointerLockMouseMoveBound = null;
        }
        if (this.onPointerLockChangeBound) {
            document.removeEventListener('pointerlockchange', this.onPointerLockChangeBound);
            this.onPointerLockChangeBound = null;
        }
        if (document.pointerLockElement === this.container) {
            document.exitPointerLock();
        }
        this.container.classList.remove('walk-pointer-locked');
        if (this.overlay) {
            this.overlay.remove();
            this.overlay = null;
        }
        this.arrows.clear();
    }
}

export { WalkTool };
