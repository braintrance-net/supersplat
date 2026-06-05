import { Mat4, Quat, Vec3 } from 'playcanvas';

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
const COLLISION_MESH_PLAYER_HEIGHT = 1.6;
const COLLISION_MESH_CAPSULE_RADIUS = 0.22;
const COLLISION_MESH_STEP_HEIGHT = 0.32;
const COLLISION_MESH_HEAD_CLEARANCE = 0.18;
const COLLISION_MESH_REPORT_INTERVAL_MS = 900;
const COLLISION_MESH_MAX_FLOOR_NORMAL_Y = 0.75;

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
    private readonly cells = new Map<string, number[]>();

    private constructor(triangles: CollisionTriangle[]) {
        this.triangles = triangles;
        this.triangleCount = triangles.length;
        this.blockingTriangleCount = triangles.length;
        this.indexTriangles();
        this.cellCount = this.cells.size;
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

    intersectsPlayerCapsule(head: Vec3): CollisionMeshHit {
        const radius = COLLISION_MESH_CAPSULE_RADIUS;
        const minY = head.y - COLLISION_MESH_PLAYER_HEIGHT + COLLISION_MESH_STEP_HEIGHT;
        const maxY = head.y - COLLISION_MESH_HEAD_CLEARANCE;
        const minCellX = Math.floor((head.x - radius) / COLLISION_MESH_CELL_SIZE);
        const maxCellX = Math.floor((head.x + radius) / COLLISION_MESH_CELL_SIZE);
        const minCellZ = Math.floor((head.z - radius) / COLLISION_MESH_CELL_SIZE);
        const maxCellZ = Math.floor((head.z + radius) / COLLISION_MESH_CELL_SIZE);
        const checked = new Set<number>();

        for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
            for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += 1) {
                const indices = this.cells.get(`${cellX},${cellZ}`);
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

    private indexTriangles() {
        for (let i = 0; i < this.triangles.length; i += 1) {
            const triangle = this.triangles[i];
            const minCellX = Math.floor(triangle.minX / COLLISION_MESH_CELL_SIZE);
            const maxCellX = Math.floor(triangle.maxX / COLLISION_MESH_CELL_SIZE);
            const minCellZ = Math.floor(triangle.minZ / COLLISION_MESH_CELL_SIZE);
            const maxCellZ = Math.floor(triangle.maxZ / COLLISION_MESH_CELL_SIZE);
            for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
                for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += 1) {
                    const key = `${cellX},${cellZ}`;
                    let list = this.cells.get(key);
                    if (!list) {
                        list = [];
                        this.cells.set(key, list);
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
        if (len <= 0.000001 || Math.abs(ny / len) > COLLISION_MESH_MAX_FLOOR_NORMAL_Y) {
            return null;
        }

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
            maxZ: Math.max(a.z, b.z, c.z) + COLLISION_MESH_CAPSULE_RADIUS
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

        this.onEmbeddedKeyDownBound = (e: KeyboardEvent) => this.onEmbeddedKey(e, true);
        this.onEmbeddedKeyUpBound = (e: KeyboardEvent) => this.onEmbeddedKey(e, false);
        this.onEmbeddedFocusLossBound = () => {
            this.embeddedKeyboardInput = {};
            this.externalJumpWasPressed = false;
        };
        window.addEventListener('keydown', this.onEmbeddedKeyDownBound, { capture: true });
        window.addEventListener('keyup', this.onEmbeddedKeyUpBound, { capture: true });
        window.addEventListener('blur', this.onEmbeddedFocusLossBound);
        window.addEventListener('pagehide', this.onEmbeddedFocusLossBound);
        document.addEventListener('visibilitychange', this.onEmbeddedFocusLossBound);
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
            document.removeEventListener('visibilitychange', this.onEmbeddedFocusLossBound);
            this.onEmbeddedFocusLossBound = null;
        }
        this.embeddedKeyboardInput = {};
    }

    private isTypingTarget(target: EventTarget | null) {
        const element = target instanceof HTMLElement ? target : null;
        if (!element) {
            return false;
        }
        return Boolean(element.closest('input, textarea, select, [contenteditable="true"]'));
    }

    private onEmbeddedKey(event: KeyboardEvent, pressed: boolean) {
        if (!this.embeddedControls || !this.active || this.isTypingTarget(event.target)) {
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
            default:
                handled = false;
                break;
        }

        if (!handled) {
            return;
        }

        event.preventDefault();
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

        const resolvedMove = this.resolveCollisionMeshMove(camera.focalPoint, tmpVec);
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

        this.updateCollisionProxy(moving && forwardAmount > 0);

        if (this.externalGroundY === null || this.externalVerticalVelocity === 0 && focalPoint.y < this.externalGroundY) {
            this.externalGroundY = focalPoint.y;
        }

        if (input.jump && !this.externalJumpWasPressed && this.externalVerticalVelocity === 0) {
            this.externalGroundY = focalPoint.y;
            this.externalVerticalVelocity = camera.sceneRadius * 0.55;
        }
        this.externalJumpWasPressed = Boolean(input.jump);

        if (moving) {
            Camera.calcForwardVec(forwardVec, camera.azim, 0);
            forwardVec.y = 0;
            const forwardLength = Math.hypot(forwardVec.x, forwardVec.z) || 1;
            forwardVec.mulScalar(-1 / forwardLength);

            rightVec.set(-forwardVec.z, 0, forwardVec.x);
            moveVec.set(0, 0, 0);
            moveVec.add(forwardVec.clone().mulScalar(forwardAmount));
            moveVec.add(rightVec.clone().mulScalar(rightAmount));
            if (forwardAmount > 0 && this.collisionProxy.blocked) {
                moveVec.sub(tmpVec.copy(forwardVec).mulScalar(forwardAmount));
            }

            const moveLength = Math.hypot(moveVec.x, moveVec.z);
            if (moveLength > 0) {
                moveVec.mulScalar(1 / moveLength);
                const speedMultiplier = input.sprint || input.slide ? 1.8 : 1;
                moveVec.mulScalar(camera.sceneRadius * 0.22 * speedMultiplier * dt);
                const resolvedMove = this.resolveCollisionMeshMove(focalPoint, moveVec);
                if (resolvedMove) {
                    focalPoint.add(resolvedMove);
                    changed = true;
                }
            }
        }

        if (this.externalVerticalVelocity !== 0 && this.externalGroundY !== null) {
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
        this.collisionMesh = null;
        this.collisionMeshUrl = details.url;
        this.collisionMeshKey = meshKey;
        const startedAt = performance.now();
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
            this.collisionMesh = mesh;
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
                playerHeight: COLLISION_MESH_PLAYER_HEIGHT
            });
        } catch (error) {
            if (abortController.signal.aborted || meshKey !== this.collisionMeshKey) {
                return;
            }
            this.collisionMesh = null;
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
        this.events.fire('walk.collisionMesh', {
            ok: true,
            reason: 'cleared',
            ...details
        });
    }

    private reportCollisionMesh(now: number, reason: string, details: Record<string, unknown>) {
        if (reason !== 'blocked' && now - this.lastCollisionMeshReportAt < COLLISION_MESH_REPORT_INTERVAL_MS) {
            return;
        }

        this.lastCollisionMeshReportAt = now;
        this.events.fire('walk.collisionMesh', {
            ok: true,
            reason,
            embeddedControls: this.embeddedControls,
            ...details
        });
    }

    private resolveCollisionMeshMove(focalPoint: Vec3, desiredMove: Vec3) {
        const mesh = this.collisionMesh;
        if (!mesh) {
            return desiredMove;
        }

        const now = performance.now();
        const fullMove = desiredMove.clone();
        const candidates = [
            { reason: 'clear', move: fullMove },
            { reason: 'slide-x', move: new Vec3(fullMove.x, 0, 0) },
            { reason: 'slide-z', move: new Vec3(0, 0, fullMove.z) }
        ];

        for (const candidate of candidates) {
            if (Math.hypot(candidate.move.x, candidate.move.z) <= 0.00001) {
                continue;
            }

            const proposed = tmpVec.copy(focalPoint).add(candidate.move);
            const hit = mesh.intersectsPlayerCapsule(proposed);
            if (!hit.blocked) {
                this.reportCollisionMesh(now, candidate.reason, {
                    blocked: false,
                    moveX: Number(candidate.move.x.toFixed(3)),
                    moveZ: Number(candidate.move.z.toFixed(3))
                });
                return candidate.move;
            }
        }

        const blockedHead = tmpVec.copy(focalPoint).add(fullMove);
        const hit = mesh.intersectsPlayerCapsule(blockedHead);
        this.reportCollisionMesh(now, 'blocked', {
            blocked: true,
            triangle: hit.triangle ?? null,
            headX: Number(blockedHead.x.toFixed(3)),
            headY: Number(blockedHead.y.toFixed(3)),
            headZ: Number(blockedHead.z.toFixed(3)),
            moveX: Number(fullMove.x.toFixed(3)),
            moveZ: Number(fullMove.z.toFixed(3))
        });
        return null;
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
