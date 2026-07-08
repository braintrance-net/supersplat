import { Mat4, Quat, Vec3 } from 'playcanvas';

import { Element, ElementType } from '../element';
import { Events } from '../events';
import { Scene } from '../scene';
import { Splat } from '../splat';

// Raycasters over scene collision sidecars generated from the source splat via:
//   splat-transform <scene>.ply -N -G <scene>.voxel.json --voxel-params 0.1,0.1 -K smooth
// splat-transform writes the voxel/mesh data in the same frame the editor displays the
// splat in (verified empirically against desk.ply), so rays are cast in editor
// world space directly. Like the walk tool, the mesh does not track user
// transforms applied to the splat after load.

type CollisionSurfaceHit = {
    point: [number, number, number];
    distance: number;
    // unit surface normal at the hit, oriented toward the ray origin
    normal: [number, number, number];
};

type MeshCollisionRaycastSurface = {
    source: 'mesh';
    triangleCount: number;
    raycastWorld(origin: [number, number, number], direction: [number, number, number], maxDistance?: number): CollisionSurfaceHit | null;
};

type VoxelCollisionRaycastSurface = {
    source: 'voxel';
    voxelCount: number;
    voxelResolution: number;
    raycastWorld(origin: [number, number, number], direction: [number, number, number], maxDistance?: number): CollisionSurfaceHit | null;
};

type CollisionRaycastSurface = MeshCollisionRaycastSurface | VoxelCollisionRaycastSurface;

type VoxelMetadata = {
    gridBounds: { min: number[]; max: number[] };
    voxelResolution: number;
    leafSize: number;
    treeDepth: number;
    nodeCount: number;
    leafDataCount: number;
};

type SurfaceGltfAccessor = {
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
};

type SurfaceGltfBufferView = {
    byteOffset?: number;
    byteLength: number;
    byteStride?: number;
};

type SurfaceGltfNode = {
    mesh?: number;
    children?: number[];
    matrix?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
};

type SurfaceGltfDocument = {
    accessors?: SurfaceGltfAccessor[];
    bufferViews?: SurfaceGltfBufferView[];
    meshes?: { primitives?: { attributes?: { POSITION?: number }; indices?: number }[] }[];
    nodes?: SurfaceGltfNode[];
    scenes?: Array<{ nodes?: number[] }>;
    scene?: number;
};

const parseGlbChunks = (buffer: ArrayBuffer) => {
    const header = new DataView(buffer);
    if (header.getUint32(0, true) !== 0x46546c67) {
        throw new Error('Collision surface file is not a GLB.');
    }

    let offset = 12;
    let json: SurfaceGltfDocument | null = null;
    let bin: ArrayBuffer | null = null;
    while (offset + 8 <= buffer.byteLength) {
        const chunkLength = header.getUint32(offset, true);
        const chunkType = header.getUint32(offset + 4, true);
        const chunkStart = offset + 8;
        if (chunkType === 0x4e4f534a) {
            json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, chunkStart, chunkLength)));
        } else if (chunkType === 0x004e4942) {
            bin = buffer.slice(chunkStart, chunkStart + chunkLength);
        }
        offset = chunkStart + chunkLength + (chunkLength % 4 === 0 ? 0 : 4 - chunkLength % 4);
    }

    if (!json || !bin) {
        throw new Error('Collision surface GLB is missing JSON or BIN chunk.');
    }
    return { json, bin };
};

const surfaceNodeMatrix = (node: SurfaceGltfNode) => {
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
};

const surfaceRootNodes = (json: SurfaceGltfDocument) => {
    const nodes = json.nodes ?? [];
    const sceneNodes = json.scenes?.[json.scene ?? 0]?.nodes?.filter(index => nodes[index]);
    if (sceneNodes?.length) {
        return Array.from(new Set(sceneNodes));
    }
    const childNodes = new Set<number>();
    for (const node of nodes) {
        for (const childIndex of node.children ?? []) {
            childNodes.add(childIndex);
        }
    }
    const allNodes = nodes.map((_, index) => index);
    const roots = allNodes.filter(index => !childNodes.has(index));
    return roots.length ? roots : allNodes;
};

const readSurfaceIndices = (json: SurfaceGltfDocument, bin: ArrayBuffer, accessorIndex: number) => {
    const accessor = json.accessors?.[accessorIndex];
    const bufferView = accessor?.bufferView === undefined ? undefined : json.bufferViews?.[accessor.bufferView];
    if (!accessor || !bufferView) {
        throw new Error('Collision surface GLB is missing an index accessor.');
    }
    const byteOffset = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    if (accessor.componentType === 5125) {
        return new Uint32Array(bin, byteOffset, accessor.count);
    }
    if (accessor.componentType === 5123) {
        return new Uint16Array(bin, byteOffset, accessor.count);
    }
    if (accessor.componentType === 5121) {
        return new Uint8Array(bin, byteOffset, accessor.count);
    }
    throw new Error(`Unsupported collision surface index component type ${accessor.componentType}.`);
};

class CollisionSurface {
    readonly source = 'mesh' as const;
    // 9 floats per triangle: ax,ay,az,bx,by,bz,cx,cy,cz (splat-local space)
    private readonly triangles: Float32Array;
    readonly triangleCount: number;

    private gridMin = [0, 0, 0];
    private gridCellSize = 1;
    private gridDims = [1, 1, 1];
    private cellStarts: Int32Array;
    private cellTriangles: Int32Array;
    private visitStamp: Int32Array;
    private currentStamp = 0;

    private constructor(triangles: Float32Array) {
        this.triangles = triangles;
        this.triangleCount = triangles.length / 9;
        this.buildGrid();
    }

    static fromGlb(buffer: ArrayBuffer) {
        const { json, bin } = parseGlbChunks(buffer);
        const chunks: Float32Array[] = [];
        let total = 0;
        const visited = new Set<number>();

        const collectNode = (nodeIndex: number, parent: Mat4) => {
            if (visited.has(nodeIndex)) return;
            visited.add(nodeIndex);
            const node = json.nodes?.[nodeIndex];
            if (!node) return;
            const world = parent.clone().mul(surfaceNodeMatrix(node));
            if (node.mesh !== undefined) {
                for (const primitive of json.meshes?.[node.mesh]?.primitives ?? []) {
                    const positionIndex = primitive.attributes?.POSITION;
                    if (positionIndex === undefined) continue;
                    const accessor = json.accessors?.[positionIndex];
                    const bufferView = accessor?.bufferView === undefined ? undefined : json.bufferViews?.[accessor.bufferView];
                    if (!accessor || !bufferView || accessor.componentType !== 5126 || accessor.type !== 'VEC3') {
                        throw new Error('Collision surface position accessor must be FLOAT VEC3.');
                    }
                    const byteOffset = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
                    const stride = (bufferView.byteStride ?? 12) / 4;
                    const positions = new Float32Array(bin, byteOffset, accessor.count * stride);
                    const indices = primitive.indices === undefined ? null : readSurfaceIndices(json, bin, primitive.indices);
                    const indexCount = indices ? indices.length : accessor.count;
                    const out = new Float32Array(indexCount * 3);
                    const point = new Vec3();
                    const isIdentity = world.equals(Mat4.IDENTITY);
                    for (let i = 0; i < indexCount; i++) {
                        const v = (indices ? indices[i] : i) * stride;
                        point.set(positions[v], positions[v + 1], positions[v + 2]);
                        if (!isIdentity) world.transformPoint(point, point);
                        out[i * 3] = point.x;
                        out[i * 3 + 1] = point.y;
                        out[i * 3 + 2] = point.z;
                    }
                    chunks.push(out);
                    total += out.length;
                }
            }
            for (const childIndex of node.children ?? []) {
                collectNode(childIndex, world);
            }
        };

        for (const nodeIndex of surfaceRootNodes(json)) {
            collectNode(nodeIndex, new Mat4());
        }

        const triangles = new Float32Array(Math.floor(total / 9) * 9);
        let cursor = 0;
        for (const chunk of chunks) {
            const usable = Math.min(chunk.length, triangles.length - cursor);
            triangles.set(chunk.subarray(0, usable), cursor);
            cursor += usable;
        }
        return new CollisionSurface(triangles);
    }

    private buildGrid() {
        const tris = this.triangles;
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < tris.length; i += 3) {
            minX = Math.min(minX, tris[i]); maxX = Math.max(maxX, tris[i]);
            minY = Math.min(minY, tris[i + 1]); maxY = Math.max(maxY, tris[i + 1]);
            minZ = Math.min(minZ, tris[i + 2]); maxZ = Math.max(maxZ, tris[i + 2]);
        }
        if (!Number.isFinite(minX)) {
            minX = minY = minZ = 0;
            maxX = maxY = maxZ = 1;
        }

        const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 0.001);
        this.gridCellSize = extent / 96;
        this.gridMin = [minX, minY, minZ];
        this.gridDims = [
            Math.max(1, Math.ceil((maxX - minX) / this.gridCellSize + 0.001)),
            Math.max(1, Math.ceil((maxY - minY) / this.gridCellSize + 0.001)),
            Math.max(1, Math.ceil((maxZ - minZ) / this.gridCellSize + 0.001))
        ];

        const [dimX, dimY, dimZ] = this.gridDims;
        const cellCount = dimX * dimY * dimZ;
        const counts = new Int32Array(cellCount + 1);
        const cellOf = (value: number, axis: number) => Math.min(
            this.gridDims[axis] - 1,
            Math.max(0, Math.floor((value - this.gridMin[axis]) / this.gridCellSize))
        );

        const triangleCellRange = (tri: number) => {
            const base = tri * 9;
            const xs = [tris[base], tris[base + 3], tris[base + 6]];
            const ys = [tris[base + 1], tris[base + 4], tris[base + 7]];
            const zs = [tris[base + 2], tris[base + 5], tris[base + 8]];
            return [
                cellOf(Math.min(...xs), 0), cellOf(Math.max(...xs), 0),
                cellOf(Math.min(...ys), 1), cellOf(Math.max(...ys), 1),
                cellOf(Math.min(...zs), 2), cellOf(Math.max(...zs), 2)
            ];
        };

        for (let tri = 0; tri < this.triangleCount; tri++) {
            const [x0, x1, y0, y1, z0, z1] = triangleCellRange(tri);
            for (let x = x0; x <= x1; x++) {
                for (let y = y0; y <= y1; y++) {
                    for (let z = z0; z <= z1; z++) {
                        counts[(x * dimY + y) * dimZ + z + 1] += 1;
                    }
                }
            }
        }
        for (let i = 1; i <= cellCount; i++) {
            counts[i] += counts[i - 1];
        }
        this.cellStarts = counts;
        this.cellTriangles = new Int32Array(counts[cellCount]);
        const fill = new Int32Array(cellCount);
        for (let tri = 0; tri < this.triangleCount; tri++) {
            const [x0, x1, y0, y1, z0, z1] = triangleCellRange(tri);
            for (let x = x0; x <= x1; x++) {
                for (let y = y0; y <= y1; y++) {
                    for (let z = z0; z <= z1; z++) {
                        const cell = (x * dimY + y) * dimZ + z;
                        this.cellTriangles[this.cellStarts[cell] + fill[cell]] = tri;
                        fill[cell] += 1;
                    }
                }
            }
        }
        this.visitStamp = new Int32Array(this.triangleCount);
    }

    private intersectTriangle(tri: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number) {
        const base = tri * 9;
        const tris = this.triangles;
        const ax = tris[base], ay = tris[base + 1], az = tris[base + 2];
        const e1x = tris[base + 3] - ax, e1y = tris[base + 4] - ay, e1z = tris[base + 5] - az;
        const e2x = tris[base + 6] - ax, e2y = tris[base + 7] - ay, e2z = tris[base + 8] - az;
        const px = dy * e2z - dz * e2y;
        const py = dz * e2x - dx * e2z;
        const pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-12) return -1;
        const invDet = 1 / det;
        const tx = ox - ax, ty = oy - ay, tz = oz - az;
        const u = (tx * px + ty * py + tz * pz) * invDet;
        if (u < -1e-6 || u > 1 + 1e-6) return -1;
        const qx = ty * e1z - tz * e1y;
        const qy = tz * e1x - tx * e1z;
        const qz = tx * e1y - ty * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * invDet;
        if (v < -1e-6 || u + v > 1 + 1e-6) return -1;
        const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
        return t > 1e-6 ? t : -1;
    }

    // Raycast in splat-local space. Returns the nearest hit or null.
    raycastLocal(origin: [number, number, number], direction: [number, number, number], maxDistance = Infinity): CollisionSurfaceHit | null {
        const dirLength = Math.hypot(direction[0], direction[1], direction[2]);
        if (!(dirLength > 0)) return null;
        const dx = direction[0] / dirLength;
        const dy = direction[1] / dirLength;
        const dz = direction[2] / dirLength;
        const [ox, oy, oz] = origin;
        const [dimX, dimY, dimZ] = this.gridDims;
        const cellSize = this.gridCellSize;
        const gridMaxX = this.gridMin[0] + dimX * cellSize;
        const gridMaxY = this.gridMin[1] + dimY * cellSize;
        const gridMaxZ = this.gridMin[2] + dimZ * cellSize;

        // clip ray to grid bounds
        let tMin = 0;
        let tMax = Math.min(maxDistance, 1e9);
        const clipAxis = (o: number, d: number, lo: number, hi: number) => {
            if (Math.abs(d) < 1e-12) {
                return o >= lo && o <= hi;
            }
            let t0 = (lo - o) / d;
            let t1 = (hi - o) / d;
            if (t0 > t1) [t0, t1] = [t1, t0];
            tMin = Math.max(tMin, t0);
            tMax = Math.min(tMax, t1);
            return tMin <= tMax;
        };
        if (!clipAxis(ox, dx, this.gridMin[0], gridMaxX)) return null;
        if (!clipAxis(oy, dy, this.gridMin[1], gridMaxY)) return null;
        if (!clipAxis(oz, dz, this.gridMin[2], gridMaxZ)) return null;

        const startT = tMin + 1e-6;
        let cellX = Math.min(dimX - 1, Math.max(0, Math.floor((ox + dx * startT - this.gridMin[0]) / cellSize)));
        let cellY = Math.min(dimY - 1, Math.max(0, Math.floor((oy + dy * startT - this.gridMin[1]) / cellSize)));
        let cellZ = Math.min(dimZ - 1, Math.max(0, Math.floor((oz + dz * startT - this.gridMin[2]) / cellSize)));

        const stepX = dx > 0 ? 1 : -1;
        const stepY = dy > 0 ? 1 : -1;
        const stepZ = dz > 0 ? 1 : -1;
        const nextBoundary = (cell: number, axis: number, step: number) => {
            return this.gridMin[axis] + (cell + (step > 0 ? 1 : 0)) * cellSize;
        };
        let tNextX = Math.abs(dx) < 1e-12 ? Infinity : (nextBoundary(cellX, 0, stepX) - ox) / dx;
        let tNextY = Math.abs(dy) < 1e-12 ? Infinity : (nextBoundary(cellY, 1, stepY) - oy) / dy;
        let tNextZ = Math.abs(dz) < 1e-12 ? Infinity : (nextBoundary(cellZ, 2, stepZ) - oz) / dz;
        const tDeltaX = Math.abs(dx) < 1e-12 ? Infinity : cellSize / Math.abs(dx);
        const tDeltaY = Math.abs(dy) < 1e-12 ? Infinity : cellSize / Math.abs(dy);
        const tDeltaZ = Math.abs(dz) < 1e-12 ? Infinity : cellSize / Math.abs(dz);

        this.currentStamp += 1;
        const stamp = this.currentStamp;
        let bestT = Infinity;
        let bestTri = -1;

        for (let guard = dimX + dimY + dimZ + 3; guard > 0; guard--) {
            const cell = (cellX * dimY + cellY) * dimZ + cellZ;
            const start = this.cellStarts[cell];
            const end = this.cellStarts[cell + 1];
            for (let i = start; i < end; i++) {
                const tri = this.cellTriangles[i];
                if (this.visitStamp[tri] === stamp) continue;
                this.visitStamp[tri] = stamp;
                const t = this.intersectTriangle(tri, ox, oy, oz, dx, dy, dz);
                if (t > 0 && t < bestT && t <= tMax) {
                    bestT = t;
                    bestTri = tri;
                }
            }

            const cellExit = Math.min(tNextX, tNextY, tNextZ);
            if (bestT <= cellExit) break;
            if (cellExit > tMax) break;
            if (tNextX <= tNextY && tNextX <= tNextZ) {
                cellX += stepX;
                if (cellX < 0 || cellX >= dimX) break;
                tNextX += tDeltaX;
            } else if (tNextY <= tNextZ) {
                cellY += stepY;
                if (cellY < 0 || cellY >= dimY) break;
                tNextY += tDeltaY;
            } else {
                cellZ += stepZ;
                if (cellZ < 0 || cellZ >= dimZ) break;
                tNextZ += tDeltaZ;
            }
        }

        if (!Number.isFinite(bestT) || bestTri < 0) return null;
        const base = bestTri * 9;
        const tris = this.triangles;
        const e1x = tris[base + 3] - tris[base], e1y = tris[base + 4] - tris[base + 1], e1z = tris[base + 5] - tris[base + 2];
        const e2x = tris[base + 6] - tris[base], e2y = tris[base + 7] - tris[base + 1], e2z = tris[base + 8] - tris[base + 2];
        let nx = e1y * e2z - e1z * e2y;
        let ny = e1z * e2x - e1x * e2z;
        let nz = e1x * e2y - e1y * e2x;
        const nLength = Math.hypot(nx, ny, nz) || 1;
        nx /= nLength; ny /= nLength; nz /= nLength;
        if (nx * dx + ny * dy + nz * dz > 0) {
            nx = -nx; ny = -ny; nz = -nz;
        }
        return {
            point: [ox + dx * bestT, oy + dy * bestT, oz + dz * bestT],
            distance: bestT,
            normal: [nx, ny, nz]
        };
    }

    // Raycast a world-space ray against the surface. The sidecar mesh is
    // already in editor world space, so this is a direct traversal.
    raycastWorld(origin: [number, number, number], direction: [number, number, number], maxDistance = Infinity): CollisionSurfaceHit | null {
        return this.raycastLocal(origin, direction, maxDistance);
    }
}

const SOLID_LEAF_MARKER = 0xFF000000 >>> 0;

const popcount8 = (value: number) => {
    value &= 0xFF;
    value -= ((value >>> 1) & 0x55);
    value = (value & 0x33) + ((value >>> 2) & 0x33);
    return (value + (value >>> 4)) & 0x0F;
};

class VoxelCollisionSurface {
    readonly source = 'voxel' as const;
    readonly voxelResolution: number;
    readonly voxelCount: number;

    private readonly nodes: Uint32Array;
    private readonly leafData: Uint32Array;
    private readonly gridMin: [number, number, number];
    private readonly gridMax: [number, number, number];
    private readonly dims: [number, number, number];
    private readonly treeDepth: number;

    private constructor(metadata: VoxelMetadata, nodes: Uint32Array, leafData: Uint32Array) {
        this.nodes = nodes;
        this.leafData = leafData;
        this.voxelResolution = metadata.voxelResolution;
        this.treeDepth = metadata.treeDepth;
        this.gridMin = [
            metadata.gridBounds.min[0],
            metadata.gridBounds.min[1],
            metadata.gridBounds.min[2]
        ];
        this.gridMax = [
            metadata.gridBounds.max[0],
            metadata.gridBounds.max[1],
            metadata.gridBounds.max[2]
        ];
        this.dims = [0, 1, 2].map(axis => Math.max(1, Math.round((this.gridMax[axis] - this.gridMin[axis]) / this.voxelResolution))) as [number, number, number];
        this.voxelCount = this.dims[0] * this.dims[1] * this.dims[2];
    }

    static fromFiles(metadata: VoxelMetadata, buffer: ArrayBuffer) {
        if (metadata.leafSize !== 4) {
            throw new Error(`Unsupported voxel leaf size ${metadata.leafSize}.`);
        }
        const words = new Uint32Array(buffer);
        const expectedWords = metadata.nodeCount + metadata.leafDataCount;
        if (words.length < expectedWords) {
            throw new Error(`Voxel bin is truncated: expected ${expectedWords} u32 words, got ${words.length}.`);
        }
        const nodes = words.slice(0, metadata.nodeCount);
        const leafData = words.slice(metadata.nodeCount, expectedWords);
        return new VoxelCollisionSurface(metadata, nodes, leafData);
    }

    private voxelAt(ix: number, iy: number, iz: number) {
        if (
            ix < 0 || iy < 0 || iz < 0 ||
            ix >= this.dims[0] || iy >= this.dims[1] || iz >= this.dims[2] ||
            this.nodes.length === 0
        ) {
            return false;
        }

        const bx = ix >> 2;
        const by = iy >> 2;
        const bz = iz >> 2;
        let nodeIndex = 0;
        for (let level = this.treeDepth - 1; level >= 0; level--) {
            const node = this.nodes[nodeIndex];
            if (node === SOLID_LEAF_MARKER) return true;

            const childMask = node >>> 24;
            const octant = ((bx >>> level) & 1) | (((by >>> level) & 1) << 1) | (((bz >>> level) & 1) << 2);
            const octantBit = 1 << octant;
            if ((childMask & octantBit) === 0) return false;

            const childBase = node & 0x00FFFFFF;
            nodeIndex = childBase + popcount8(childMask & (octantBit - 1));
            if (nodeIndex < 0 || nodeIndex >= this.nodes.length) return false;
        }

        const leafNode = this.nodes[nodeIndex];
        if (leafNode === SOLID_LEAF_MARKER) return true;
        const leafDataIndex = leafNode & 0x00FFFFFF;
        const dataOffset = leafDataIndex * 2;
        if (dataOffset + 1 >= this.leafData.length) return false;

        const bitIdx = (ix & 3) + ((iy & 3) << 2) + ((iz & 3) << 4);
        return bitIdx < 32 ?
            ((this.leafData[dataOffset] >>> bitIdx) & 1) === 1 :
            ((this.leafData[dataOffset + 1] >>> (bitIdx - 32)) & 1) === 1;
    }

    raycastWorld(origin: [number, number, number], direction: [number, number, number], maxDistance = Infinity): CollisionSurfaceHit | null {
        const dirLength = Math.hypot(direction[0], direction[1], direction[2]);
        if (!(dirLength > 0)) return null;

        const dx = direction[0] / dirLength;
        const dy = direction[1] / dirLength;
        const dz = direction[2] / dirLength;
        const [ox, oy, oz] = origin;
        let tMin = 0;
        let tMax = Math.min(maxDistance, 1e9);
        let entryNormal: [number, number, number] = [-dx, -dy, -dz];
        const clipAxis = (o: number, d: number, lo: number, hi: number, axis: 0 | 1 | 2) => {
            if (Math.abs(d) < 1e-12) {
                return o >= lo && o <= hi;
            }
            let t0 = (lo - o) / d;
            let t1 = (hi - o) / d;
            let normalSign = -Math.sign(d);
            if (t0 > t1) {
                [t0, t1] = [t1, t0];
                normalSign = Math.sign(d);
            }
            if (t0 > tMin) {
                tMin = t0;
                entryNormal = [0, 0, 0];
                entryNormal[axis] = normalSign;
            }
            tMax = Math.min(tMax, t1);
            return tMin <= tMax;
        };

        if (!clipAxis(ox, dx, this.gridMin[0], this.gridMax[0], 0)) return null;
        if (!clipAxis(oy, dy, this.gridMin[1], this.gridMax[1], 1)) return null;
        if (!clipAxis(oz, dz, this.gridMin[2], this.gridMax[2], 2)) return null;

        const startT = Math.max(0, tMin) + 1e-6;
        const res = this.voxelResolution;
        let ix = Math.min(this.dims[0] - 1, Math.max(0, Math.floor((ox + dx * startT - this.gridMin[0]) / res)));
        let iy = Math.min(this.dims[1] - 1, Math.max(0, Math.floor((oy + dy * startT - this.gridMin[1]) / res)));
        let iz = Math.min(this.dims[2] - 1, Math.max(0, Math.floor((oz + dz * startT - this.gridMin[2]) / res)));

        const stepX = dx > 0 ? 1 : -1;
        const stepY = dy > 0 ? 1 : -1;
        const stepZ = dz > 0 ? 1 : -1;
        const nextBoundary = (cell: number, axis: number, step: number) => {
            return this.gridMin[axis] + (cell + (step > 0 ? 1 : 0)) * res;
        };
        let tNextX = Math.abs(dx) < 1e-12 ? Infinity : (nextBoundary(ix, 0, stepX) - ox) / dx;
        let tNextY = Math.abs(dy) < 1e-12 ? Infinity : (nextBoundary(iy, 1, stepY) - oy) / dy;
        let tNextZ = Math.abs(dz) < 1e-12 ? Infinity : (nextBoundary(iz, 2, stepZ) - oz) / dz;
        const tDeltaX = Math.abs(dx) < 1e-12 ? Infinity : res / Math.abs(dx);
        const tDeltaY = Math.abs(dy) < 1e-12 ? Infinity : res / Math.abs(dy);
        const tDeltaZ = Math.abs(dz) < 1e-12 ? Infinity : res / Math.abs(dz);
        let t = Math.max(0, tMin);
        let normal = entryNormal;

        for (let guard = this.dims[0] + this.dims[1] + this.dims[2] + 3; guard > 0; guard--) {
            if (this.voxelAt(ix, iy, iz)) {
                return {
                    point: [ox + dx * t, oy + dy * t, oz + dz * t],
                    distance: t,
                    normal
                };
            }

            if (tNextX <= tNextY && tNextX <= tNextZ) {
                t = tNextX;
                if (t > tMax) break;
                ix += stepX;
                if (ix < 0 || ix >= this.dims[0]) break;
                tNextX += tDeltaX;
                normal = [-stepX, 0, 0];
            } else if (tNextY <= tNextZ) {
                t = tNextY;
                if (t > tMax) break;
                iy += stepY;
                if (iy < 0 || iy >= this.dims[1]) break;
                tNextY += tDeltaY;
                normal = [0, -stepY, 0];
            } else {
                t = tNextZ;
                if (t > tMax) break;
                iz += stepZ;
                if (iz < 0 || iz >= this.dims[2]) break;
                tNextZ += tDeltaZ;
                normal = [0, 0, -stepZ];
            }
        }

        return null;
    }
}

// Explicit pinhole screen math in raw viewport (client) pixels, built from
// the camera pose + fov — the same convention as the Boxer eval pipeline.
// (The engine's screenToWorld/worldToScreen are NOT inverse-consistent in
// this app: SuperSplat customizes the projection, so a screenToWorld ray
// re-projected with worldToScreen lands ~3% off. Do not use them for
// cursor-anchored features.)
type PinholeModel = { rect: DOMRect; focal: number; position: Vec3 };

const createScreenMath = (scene: Scene) => {
    const camRight = new Vec3();
    const camUp = new Vec3();
    const camBack = new Vec3();

    const pinhole = (): PinholeModel | null => {
        const rect = scene.canvas.getBoundingClientRect();
        if (!(rect.width > 0) || !(rect.height > 0)) return null;
        const camera = scene.camera.camera;
        const fovRad = camera.fov * Math.PI / 180;
        const focal = camera.horizontalFov ?
            rect.width / (2 * Math.tan(fovRad / 2)) :
            rect.height / (2 * Math.tan(fovRad / 2));
        const transform = scene.camera.mainCamera.getWorldTransform();
        transform.getX(camRight);
        transform.getY(camUp);
        transform.getZ(camBack);
        const position = scene.camera.mainCamera.getPosition();
        return { rect, focal, position };
    };

    const rayThrough = (model: PinholeModel, clientX: number, clientY: number): [number, number, number] => {
        const { rect, focal } = model;
        const sx = (clientX - rect.left - rect.width / 2) / focal;
        const sy = (clientY - rect.top - rect.height / 2) / focal;
        // camera space (GL): +x right, +y up, -z forward; screen y grows down
        return [
            camRight.x * sx - camUp.x * sy - camBack.x,
            camRight.y * sx - camUp.y * sy - camBack.y,
            camRight.z * sx - camUp.z * sy - camBack.z
        ];
    };

    const projectToClient = (model: PinholeModel, point: [number, number, number]): [number, number] | null => {
        const { rect, focal, position } = model;
        const dx = point[0] - position.x;
        const dy = point[1] - position.y;
        const dz = point[2] - position.z;
        const xc = dx * camRight.x + dy * camRight.y + dz * camRight.z;
        const yc = dx * camUp.x + dy * camUp.y + dz * camUp.z;
        const depth = -(dx * camBack.x + dy * camBack.y + dz * camBack.z);
        if (!(depth > 0.0001)) return null;
        return [
            rect.left + rect.width / 2 + focal * (xc / depth),
            rect.top + rect.height / 2 - focal * (yc / depth)
        ];
    };

    return { pinhole, rayThrough, projectToClient };
};

// Active surface registry. Voxel octrees are preferred; the generated GLB mesh
// remains the fallback for older sidecars.
const surfaceCache = new Map<string, Promise<CollisionRaycastSurface | null>>();
let activeSurface: CollisionRaycastSurface | null = null;
let activeSurfaceFilename: string | null = null;
let activeSurfacePending: Promise<CollisionRaycastSurface | null> = Promise.resolve(null);

const collisionSurfaceBaseForFilename = (filename: string | undefined | null) => {
    if (!filename) return null;
    const basename = filename.split('/').pop()?.replace(/\.(ply|sog|spz|splat|ksplat|compressed\.ply)$/i, '');
    return basename ? `/static/dev-assets/collision/${basename}` : null;
};

const shouldDisableCollisionSurfaceSidecars = () => {
    if (typeof window === 'undefined') return false;
    const params = new URLSearchParams(window.location.search);
    return params.get('hideEditorChrome') === '1' ||
        params.get('collisionSurfaceSidecars') === '0' ||
        params.has('timeTrialPlayer');
};

const loadVoxelSurface = async (baseUrl: string): Promise<VoxelCollisionSurface | null> => {
    const jsonUrl = `${baseUrl}.voxel.json`;
    const metadataResponse = await fetch(jsonUrl);
    if (!metadataResponse.ok) return null;
    const metadata = await metadataResponse.json() as VoxelMetadata;
    const binUrl = `${baseUrl}.voxel.bin`;
    const binResponse = await fetch(binUrl);
    if (!binResponse.ok) return null;
    return VoxelCollisionSurface.fromFiles(metadata, await binResponse.arrayBuffer());
};

const loadMeshSurface = async (baseUrl: string): Promise<CollisionSurface | null> => {
    const response = await fetch(`${baseUrl}.collision.glb`);
    if (!response.ok) return null;
    return CollisionSurface.fromGlb(await response.arrayBuffer());
};

const loadCollisionSurface = (baseUrl: string) => {
    let pending = surfaceCache.get(baseUrl);
    if (!pending) {
        pending = (async (): Promise<CollisionRaycastSurface | null> => {
            try {
                const voxelSurface = await loadVoxelSurface(baseUrl);
                if (voxelSurface) return voxelSurface;
                return await loadMeshSurface(baseUrl);
            } catch (err) {
                console.warn(`[CollisionSurface] failed to load ${baseUrl}`, err);
                return null;
            }
        })();
        surfaceCache.set(baseUrl, pending);
    }
    return pending;
};

const getActiveCollisionSurface = () => activeSurface;

// Resolves once any in-flight sidecar load settles (null when no sidecar exists).
const waitForCollisionSurface = () => activeSurfacePending;

const registerCollisionSurfaceLoader = (events: Events, scene: Scene) => {
    const sidecarsDisabled = shouldDisableCollisionSurfaceSidecars();

    events.on('scene.elementAdded', (element: Element) => {
        if (element.type !== ElementType.splat) return;
        if (sidecarsDisabled) {
            activeSurface = null;
            activeSurfaceFilename = null;
            activeSurfacePending = Promise.resolve(null);
            return;
        }
        const splat = element as Splat;
        const baseUrl = collisionSurfaceBaseForFilename(splat.filename ?? splat.name);
        if (!baseUrl) return;
        activeSurfaceFilename = splat.filename ?? splat.name;
        const requestedFor = activeSurfaceFilename;
        activeSurfacePending = loadCollisionSurface(baseUrl).then((surface) => {
            if (activeSurfaceFilename !== requestedFor) return activeSurface;
            activeSurface = surface;
            if (surface) {
                const details = surface.source === 'voxel' ?
                    { url: `${baseUrl}.voxel.json`, source: surface.source, voxelCount: surface.voxelCount, voxelResolution: surface.voxelResolution } :
                    { url: `${baseUrl}.collision.glb`, source: surface.source, triangleCount: surface.triangleCount };
                console.log(`[CollisionSurface] loaded ${details.url} (${details.source})`);
                events.fire('collisionSurface.loaded', details);
            }
            return surface;
        });
    });

    events.function('collisionSurface.ready', () => !!activeSurface);

    // Probe the collision surface at a normalized (0-1) screen coordinate.
    // Returns the world hit plus the world-height the viewport spans at that
    // depth, so callers can convert between pixel and world brush radii.
    const { pinhole, rayThrough, projectToClient } = createScreenMath(scene);

    const probeAt = (clientX: number, clientY: number) => {
        if (!activeSurface) return null;
        const model = pinhole();
        if (!model) return null;
        const hit = activeSurface.raycastWorld(
            [model.position.x, model.position.y, model.position.z],
            rayThrough(model, clientX, clientY)
        );
        if (!hit) return null;
        // px per world unit at the hit depth straight from the pinhole focal
        const pxPerWorld = model.focal / hit.distance;
        return {
            point: hit.point,
            distance: hit.distance,
            normal: hit.normal,
            world_per_screen_height: model.rect.height / Math.max(0.000001, pxPerWorld),
            px_per_world: pxPerWorld
        };
    };
    events.function('collisionSurface.screenProbe', probeAt);

    // Walk the brush outline along the actual surface: the ring starts in the
    // tangent plane at the cursor hit and each direction marches outward in
    // small steps, re-projecting onto the visible surface (camera ray through
    // the marched guess) and re-orienting to the local normal each step. The
    // outline therefore folds across corners like a sticker on the mesh —
    // climbing a laptop screen at the hinge — and stops at silhouette edges
    // instead of spiking onto far background.
    const WALK_STEPS = 4;
    events.function('collisionSurface.ringProbe', (clientX: number, clientY: number, radiusWorld: number, sampleCount = 20) => {
        const center = probeAt(clientX, clientY);
        if (!center || !activeSurface || !(radiusWorld > 0)) return null;
        const model = pinhole();
        if (!model) return null;
        const rect = model.rect;
        const origin: [number, number, number] = [model.position.x, model.position.y, model.position.z];

        // the voxel mesh has staircase normals; average a small probe cross
        // around the cursor so the ring plane reflects the macro surface
        const n0: [number, number, number] = [...center.normal];
        const probeStep = Math.max(6, rect.height * 0.012);
        for (const [ox, oy] of [[probeStep, 0], [-probeStep, 0], [0, probeStep], [0, -probeStep]]) {
            const neighbor = probeAt(clientX + ox, clientY + oy);
            if (neighbor && Math.abs(neighbor.distance - center.distance) < radiusWorld * 2) {
                n0[0] += neighbor.normal[0];
                n0[1] += neighbor.normal[1];
                n0[2] += neighbor.normal[2];
            }
        }
        const n0Length = Math.hypot(n0[0], n0[1], n0[2]) || 1;
        n0[0] /= n0Length; n0[1] /= n0Length; n0[2] /= n0Length;
        const upRef: [number, number, number] = Math.abs(n0[1]) > 0.94 ? [1, 0, 0] : [0, 1, 0];
        let ux = n0[1] * upRef[2] - n0[2] * upRef[1];
        let uy = n0[2] * upRef[0] - n0[0] * upRef[2];
        let uz = n0[0] * upRef[1] - n0[1] * upRef[0];
        const uLength = Math.hypot(ux, uy, uz) || 1;
        ux /= uLength; uy /= uLength; uz /= uLength;
        const vx = n0[1] * uz - n0[2] * uy;
        const vy = n0[2] * ux - n0[0] * uz;
        const vz = n0[0] * uy - n0[1] * ux;

        const step = radiusWorld / WALK_STEPS;
        const stepTolerance = step * 2.2;
        const rawRing: [number, number][] = [];
        for (let i = 0; i < sampleCount; i++) {
            const angle = i / sampleCount * Math.PI * 2;
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);
            let px = center.point[0], py = center.point[1], pz = center.point[2];
            let nx = n0[0], ny = n0[1], nz = n0[2];
            let dx = ux * cos + vx * sin;
            let dy = uy * cos + vy * sin;
            let dz = uz * cos + vz * sin;
            for (let k = 0; k < WALK_STEPS; k++) {
                const gx = px + dx * step;
                const gy = py + dy * step;
                const gz = pz + dz * step;
                const rx = gx - origin[0];
                const ry = gy - origin[1];
                const rz = gz - origin[2];
                const guessDistance = Math.hypot(rx, ry, rz);
                const hit = activeSurface.raycastWorld(origin, [rx, ry, rz], guessDistance + stepTolerance);
                if (!hit) break;
                const deviation = Math.hypot(hit.point[0] - gx, hit.point[1] - gy, hit.point[2] - gz);
                if (deviation > stepTolerance) break;
                px = hit.point[0]; py = hit.point[1]; pz = hit.point[2];
                // damp staircase normal noise while still tracking real folds
                nx = nx * 0.45 + hit.normal[0] * 0.55;
                ny = ny * 0.45 + hit.normal[1] * 0.55;
                nz = nz * 0.45 + hit.normal[2] * 0.55;
                const nLength = Math.hypot(nx, ny, nz) || 1;
                nx /= nLength; ny /= nLength; nz /= nLength;
                // keep marching in the surface plane: strip the normal component
                const dot = dx * nx + dy * ny + dz * nz;
                let tx = dx - nx * dot;
                let ty = dy - ny * dot;
                let tz = dz - nz * dot;
                const tLength = Math.hypot(tx, ty, tz);
                if (tLength > 0.001) {
                    tx /= tLength; ty /= tLength; tz /= tLength;
                    dx = tx; dy = ty; dz = tz;
                }
            }
            const projected = projectToClient(model, [px, py, pz]);
            if (projected) rawRing.push(projected);
        }

        // one smoothing pass to soften voxel staircase jitter
        const ring: [number, number][] = rawRing.map((point, i) => {
            const prev = rawRing[(i + rawRing.length - 1) % rawRing.length];
            const next = rawRing[(i + 1) % rawRing.length];
            return [
                point[0] * 0.5 + (prev[0] + next[0]) * 0.25,
                point[1] * 0.5 + (prev[1] + next[1]) * 0.25
            ];
        });

        return { center, ring };
    });
};

export { CollisionSurface, VoxelCollisionSurface, CollisionSurfaceHit, createScreenMath, getActiveCollisionSurface, waitForCollisionSurface, registerCollisionSurfaceLoader };
