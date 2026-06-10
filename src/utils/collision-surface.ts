import { Mat4, Quat, Ray, Vec3 } from 'playcanvas';

import { Element, ElementType } from '../element';
import { Events } from '../events';
import { Scene } from '../scene';
import { Splat } from '../splat';

// Grid-accelerated triangle raycaster over a scene's collision mesh sidecar.
// The mesh is a one-time per-scene artifact generated from the source splat via:
//   splat-transform <scene>.ply -N -G <scene>.voxel.json --voxel-params 0.1,0.1 -K smooth
// splat-transform writes the mesh in the same frame the editor displays the
// splat in (verified empirically against desk.ply), so rays are cast in editor
// world space directly. Like the walk tool, the mesh does not track user
// transforms applied to the splat after load.

type CollisionSurfaceHit = {
    point: [number, number, number];
    distance: number;
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

        if (!Number.isFinite(bestT)) return null;
        return {
            point: [ox + dx * bestT, oy + dy * bestT, oz + dz * bestT],
            distance: bestT
        };
    }

    // Raycast a world-space ray against the surface. The sidecar mesh is
    // already in editor world space, so this is a direct traversal.
    raycastWorld(origin: [number, number, number], direction: [number, number, number], maxDistance = Infinity): CollisionSurfaceHit | null {
        return this.raycastLocal(origin, direction, maxDistance);
    }
}

// Active surface registry. Surfaces load from the same sidecar convention as
// the walk tool: /static/dev-assets/collision/<basename>.collision.glb
const surfaceCache = new Map<string, Promise<CollisionSurface | null>>();
let activeSurface: CollisionSurface | null = null;
let activeSurfaceFilename: string | null = null;
let activeSurfacePending: Promise<CollisionSurface | null> = Promise.resolve(null);

const collisionSurfaceUrlForFilename = (filename: string | undefined | null) => {
    if (!filename) return null;
    const basename = filename.split('/').pop()?.replace(/\.(ply|sog|spz|splat|ksplat|compressed\.ply)$/i, '');
    return basename ? `/static/dev-assets/collision/${basename}.collision.glb` : null;
};

const loadCollisionSurface = (url: string) => {
    let pending = surfaceCache.get(url);
    if (!pending) {
        pending = fetch(url)
        .then(response => (response.ok ? response.arrayBuffer() : null))
        .then(buffer => (buffer ? CollisionSurface.fromGlb(buffer) : null))
        .catch((err): CollisionSurface | null => {
            console.warn(`[CollisionSurface] failed to load ${url}`, err);
            return null;
        });
        surfaceCache.set(url, pending);
    }
    return pending;
};

const getActiveCollisionSurface = () => activeSurface;

// Resolves once any in-flight sidecar load settles (null when no sidecar exists).
const waitForCollisionSurface = () => activeSurfacePending;

const registerCollisionSurfaceLoader = (events: Events, scene: Scene) => {
    events.on('scene.elementAdded', (element: Element) => {
        if (element.type !== ElementType.splat) return;
        const splat = element as Splat;
        const url = collisionSurfaceUrlForFilename(splat.filename ?? splat.name);
        if (!url) return;
        activeSurfaceFilename = splat.filename ?? splat.name;
        const requestedFor = activeSurfaceFilename;
        activeSurfacePending = loadCollisionSurface(url).then((surface) => {
            if (activeSurfaceFilename !== requestedFor) return activeSurface;
            activeSurface = surface;
            if (surface) {
                console.log(`[CollisionSurface] loaded ${url} (${surface.triangleCount} triangles)`);
                events.fire('collisionSurface.loaded', { url, triangleCount: surface.triangleCount });
            }
            return surface;
        });
    });

    events.function('collisionSurface.ready', () => !!activeSurface);

    // Probe the collision surface at a normalized (0-1) screen coordinate.
    // Returns the world hit plus the world-height the viewport spans at that
    // depth, so callers can convert between pixel and world brush radii.
    const probeRay = new Ray();
    events.function('collisionSurface.screenProbe', (x: number, y: number) => {
        if (!activeSurface) return null;
        const { width, height } = scene.camera.targetSize;
        scene.camera.getRay(x * width, y * height, probeRay);
        const hit = activeSurface.raycastWorld(
            [probeRay.origin.x, probeRay.origin.y, probeRay.origin.z],
            [probeRay.direction.x, probeRay.direction.y, probeRay.direction.z]
        );
        if (!hit) return null;
        const camera = scene.camera.camera;
        const fovRad = camera.fov * Math.PI / 180;
        const fovY = camera.horizontalFov ?
            2 * Math.atan(Math.tan(fovRad / 2) * (height / Math.max(1, width))) :
            fovRad;
        return {
            point: hit.point,
            distance: hit.distance,
            world_per_screen_height: 2 * Math.tan(fovY / 2) * hit.distance
        };
    });
};

export { CollisionSurface, CollisionSurfaceHit, getActiveCollisionSurface, waitForCollisionSurface, registerCollisionSurfaceLoader };
