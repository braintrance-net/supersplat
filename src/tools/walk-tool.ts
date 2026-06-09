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
    source?: 'mesh' | 'cached';
};

type CollisionDebugTriangle = {
    index: number;
    triangle: CollisionTriangle;
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
const COLLISION_MESH_HEAD_CLEARANCE = 0;
const COLLISION_MESH_WALK_SPEED = 1.8;
const COLLISION_MESH_SPRINT_MULTIPLIER = 1.65;
const COLLISION_MESH_JUMP_SPEED = 2.9;
const COLLISION_MESH_GRAVITY = 7.5;
const COLLISION_MESH_GROUND_SNAP = 0.42;
const COLLISION_MESH_GROUND_PROBE_RADIUS = 0.22;
const COLLISION_MESH_GROUND_CACHE_DROP = 0.45;
const COLLISION_MESH_GROUND_CACHE_RISE = 0.16;
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
const COLLISION_DEBUG_PLAYER_COLOR = new Color(0.1, 0.72, 1, 1);
const COLLISION_DEBUG_EYE_COLOR = new Color(0.82, 0.96, 1, 1);
const COLLISION_DEBUG_FLOOR_COLOR = new Color(0.18, 1, 0.38, 1);
const COLLISION_DEBUG_WALL_COLOR = new Color(1, 0.18, 0.12, 1);
const COLLISION_DEBUG_HIT_COLOR = new Color(1, 0, 0.9, 1);
const COLLISION_DEBUG_RAY_COLOR = new Color(1, 0.86, 0.18, 1);
const COLLISION_DEBUG_DESIRED_MOVE_COLOR = new Color(1, 0.62, 0.12, 1);
const COLLISION_DEBUG_RESOLVED_MOVE_COLOR = new Color(0.35, 1, 0.95, 1);

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
    private readonly triangles: CollisionTriangle[];
    private readonly blockingCells = new Map<string, number[]>();
    private readonly groundCells = new Map<string, number[]>();

    private constructor(triangles: CollisionTriangle[]) {
        this.triangles = triangles;
        this.triangleCount = triangles.length;
        this.blockingTriangleCount = triangles.filter(triangle => triangle.blocking).length;
        this.indexTriangles();
        this.cellCount = this.blockingCells.size;
    }

    static fromGlb(buffer: ArrayBuffer, transform?: PresetTransform) {
        const startedAt = performance.now();
        const { json, bin } = WalkCollisionMesh.parseGlb(buffer);
        const worldTransform = WalkCollisionMesh.transformFromPreset(transform);
        const triangles: CollisionTriangle[] = [];
        const rootNodes = WalkCollisionMesh.rootNodeIndices(json);
        const visitedNodes = new Set<number>();
        for (const nodeIndex of rootNodes) {
            WalkCollisionMesh.collectNodeTriangles(json, bin, nodeIndex, worldTransform.clone(), triangles, visitedNodes);
        }

        const mesh = new WalkCollisionMesh(triangles);
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
    private animFrame: number | null = null;
    private active = false;

    private onPointerDownBound: ((e: PointerEvent) => void) | null = null;
    private onPointerLockMouseMoveBound: ((e: MouseEvent) => void) | null = null;
    private onPointerLockChangeBound: (() => void) | null = null;
    private onEmbeddedKeyDownBound: ((e: KeyboardEvent) => void) | null = null;
    private onEmbeddedKeyUpBound: ((e: KeyboardEvent) => void) | null = null;
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
    private lastArrowPositionAt = 0;
    private collisionMesh: WalkCollisionMesh | null = null;
    private collisionMeshUrl: string | null = null;
    private collisionMeshKey: string | null = null;
    private collisionMeshBuffer: ArrayBuffer | null = null;
    private collisionMeshBufferUrl: string | null = null;
    private collisionMeshAbort: AbortController | null = null;
    private lastCollisionMeshReportAt = 0;
    private lastCollisionMeshBlockReportAt = 0;
    private collisionMeshBlockedSince: number | null = null;
    private collisionMeshHeadY: number | null = null;
    private collisionDebugEnabled = WalkTool.defaultCollisionDebugEnabled();
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
        this.events.on('walk.collisionMeshLoad', this.loadCollisionMesh, this);
        this.events.on('walk.collisionMeshClear', this.clearCollisionMesh, this);
        this.events.on('scene.clear', this.clearCollisionMesh, this);
        this.events.on('walk.collisionDebug', this.onCollisionDebug, this);
        this.events.on('prerender', this.drawCollisionDebug, this);
        this.events.function('walk.collisionDebug', () => this.collisionDebugEnabled);
        this.events.function('walk.collisionDebugBundle', () => this.collisionDebugBundle());
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

    private onCollisionDebug(enabled = true) {
        this.collisionDebugEnabled = Boolean(enabled);
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
            jump: Boolean(input.jump)
        };
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
            activeTool: this.events.invoke('tool.active') as string | null,
            camera: this.events.invoke('camera.debugState') ?? null,
            mesh: {
                loaded: Boolean(mesh),
                url: this.collisionMeshUrl,
                key: this.collisionMeshKey,
                triangles: mesh?.triangleCount ?? null,
                blockingTriangles: mesh?.blockingTriangleCount ?? null,
                cells: mesh?.cellCount ?? null,
                cellSize: mesh ? COLLISION_MESH_CELL_SIZE : null,
                capsuleRadius: COLLISION_MESH_CAPSULE_RADIUS,
                playerHeight: COLLISION_MESH_PLAYER_HEIGHT,
                eyeHeight: COLLISION_MESH_EYE_HEIGHT,
                stepHeight: COLLISION_MESH_STEP_HEIGHT,
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
        } else {
            this.createEmbeddedKeyboardControls();
        }
        this.ensureUpdateLoop();
    }

    deactivate() {
        this.active = false;
        this.destroyOverlay();
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

    private onEmbeddedControls(enabled = false) {
        this.embeddedControls = enabled;
        if (enabled) {
            if (document.pointerLockElement === this.container) {
                document.exitPointerLock();
            }
            this.destroyOverlay();
            this.createEmbeddedKeyboardControls();
            return;
        }

        this.destroyEmbeddedKeyboardControls();
        if (this.active) {
            this.createOverlay();
        }
    }

    private createEmbeddedKeyboardControls() {
        if (this.onEmbeddedKeyDownBound || this.onEmbeddedKeyUpBound) {
            return;
        }

        this.clearNativeFlyInput();
        this.onEmbeddedKeyDownBound = (e: KeyboardEvent) => this.onEmbeddedKey(e, true);
        this.onEmbeddedKeyUpBound = (e: KeyboardEvent) => this.onEmbeddedKey(e, false);
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
        if (!this.embeddedControls || !this.active) {
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
            case 'KeyE':
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
        if (!this.active || document.pointerLockElement !== this.container) {
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
        this.lastLookAt = performance.now();
        this.look(Math.max(-200, Math.min(200, dx)), Math.max(-200, Math.min(200, dy)));
    }

    private onExternalWalkInput(input: WalkInputState = {}) {
        this.externalWalkInput = {
            forward: Boolean(input.forward),
            backward: Boolean(input.backward),
            left: Boolean(input.left),
            right: Boolean(input.right),
            sprint: Boolean(input.sprint),
            slide: Boolean(input.slide),
            jump: Boolean(input.jump)
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
            jump: Boolean(this.externalWalkInput.jump || this.embeddedKeyboardInput.jump)
        };
    }

    private ensureUpdateLoop() {
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

        this.updateCollisionProxy(useCollisionProxy && moving && forwardAmount > 0);
        if (!moving) {
            this.collisionMeshBlockedSince = null;
            this.resetCollisionDebugMove({ preserveBlock: this.collisionDebugEnabled });
        }

        if (this.collisionMesh) {
            changed ||= this.applyCollisionMeshVertical(input, dt, camera, focalPoint);
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
        const startedAt = performance.now();
        this.pushCollisionDebugSample('mesh-load-start', {
            url: details.url,
            requestId: details.requestId ?? null
        });
        this.events.fire('walk.collisionMesh', {
            ok: true,
            reason: 'load-start',
            url: details.url,
            requestId: details.requestId ?? null
        });

        try {
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

            const { mesh, parseMs } = WalkCollisionMesh.fromGlb(buffer, details.transform);
            if (meshKey !== this.collisionMeshKey) {
                return;
            }
            if (mesh.blockingTriangleCount === 0) {
                this.collisionMesh = null;
                this.collisionMeshHeadY = null;
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
            this.collisionMeshHeadY = null;
            this.pushCollisionDebugSample('mesh-ready', {
                url: details.url,
                requestId: details.requestId ?? null,
                byteLength: buffer.byteLength,
                parseMs,
                triangles: mesh.triangleCount,
                blockingTriangles: mesh.blockingTriangleCount,
                cells: mesh.cellCount
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
                cells: mesh.cellCount,
                cellSize: COLLISION_MESH_CELL_SIZE,
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

    private clearCollisionMesh(details: Record<string, unknown> = {}) {
        this.collisionMeshAbort?.abort();
        this.collisionMeshAbort = null;
        this.collisionMesh = null;
        this.collisionMeshUrl = null;
        this.collisionMeshKey = null;
        this.collisionMeshBuffer = null;
        this.collisionMeshBufferUrl = null;
        this.collisionMeshHeadY = null;
        this.collisionMeshBlockedSince = null;
        this.resetCollisionDebugMove();
        this.lastCollisionFloorTriangle = null;
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
        if (!mesh) {
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
        Camera.calcForwardVec(forwardVec, camera.azim, camera.elevation);
        return focalPoint.clone().add(forwardVec.clone().mulScalar(distance));
    }

    private drawCollisionDebug() {
        if (!this.collisionDebugEnabled || !this.active || !this.collisionMesh) {
            return;
        }

        const mesh = this.collisionMesh;
        const body = this.playerCollisionBodies()[0];
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
        if (!enabled) {
            if (this.collisionProxy.blocked) {
                this.collisionProxy.blocked = false;
                this.reportCollisionProxy(now, 'released');
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

        Camera.calcForwardVec(forwardVec, camera.azim, camera.elevation);
        const cameraPosition = camera.focalPoint.add(forwardVec.clone().mulScalar(distance));

        const sensitivity = camera.scene.config.controls.orbitSensitivity;
        const azim = camera.azim - dx * sensitivity;
        const elev = camera.elevation - dy * sensitivity;

        Camera.calcForwardVec(forwardVec, azim, elev);
        const focalPoint = cameraPosition.clone().sub(forwardVec.clone().mulScalar(distance));

        camera.setAzimElev(azim, elev, 0);
        camera.setFocalPoint(focalPoint, 0);
        this.scene.forceRender = true;
    }

    private updateLoop() {
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
