import { Vec3 } from 'playcanvas';

import { Camera } from '../camera';
import { ElementType } from '../element';
import { Events } from '../events';
import { Scene } from '../scene';
import { Splat } from '../splat';
import { State } from '../splat-state';

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

type CollisionGridBuildStats = {
    signature: string;
    totalCenters: number;
    sampledCenters: number;
    stride: number;
    cells: number;
    buildMs: number;
};

type CollisionGridHit = {
    blocked: boolean;
    cellX?: number;
    cellZ?: number;
    bin?: number;
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
const COLLISION_GRID_CELL_SIZE = 0.16;
const COLLISION_GRID_Y_BIN_SIZE = 0.18;
const COLLISION_GRID_MAX_SAMPLES = 500_000;
const COLLISION_GRID_PLAYER_HEIGHT = 1.65;
const COLLISION_GRID_CAPSULE_RADIUS = 0.22;
const COLLISION_GRID_STEP_HEIGHT = 0.32;
const COLLISION_GRID_HEAD_CLEARANCE = 0.18;
const COLLISION_GRID_REPORT_INTERVAL_MS = 900;

class WalkCollisionGrid {
    readonly stats: CollisionGridBuildStats;
    private readonly cells = new Map<string, Set<number>>();

    private constructor(stats: Omit<CollisionGridBuildStats, 'cells' | 'buildMs'>, buildStartedAt: number) {
        this.stats = {
            ...stats,
            cells: 0,
            buildMs: 0
        };
        this.buildStartedAt = buildStartedAt;
    }

    private readonly buildStartedAt: number;

    static signatureForSplats(splats: Splat[]) {
        return splats.map(splat => `${splat.uid}:${splat.numSplats}:${splat.changedCounter}`).join('|');
    }

    static build(scene: Scene) {
        const buildStartedAt = performance.now();
        const splats = (scene.getElementsByType(ElementType.splat) as Splat[]).filter(splat => splat.visible);
        const signature = WalkCollisionGrid.signatureForSplats(splats);
        const totalCenters = splats.reduce((total, splat) => {
            const centers: Float32Array | undefined = splat.entity.gsplat?.instance?.sorter?.centers;
            return total + (centers ? centers.length / 3 : 0);
        }, 0);
        const stride = Math.max(1, Math.ceil(totalCenters / COLLISION_GRID_MAX_SAMPLES));
        const grid = new WalkCollisionGrid({ signature, totalCenters, sampledCenters: 0, stride }, buildStartedAt);

        for (const splat of splats) {
            const centers: Float32Array | undefined = splat.entity.gsplat?.instance?.sorter?.centers;
            if (!centers) {
                continue;
            }

            const state = splat.splatData.getProp('state') as Uint8Array | undefined;
            const worldTransform = splat.entity.getWorldTransform().data as Float32Array;
            const count = centers.length / 3;
            for (let i = 0; i < count; i += stride) {
                if (state && ((state[i] ?? 0) & State.deleted) !== 0) {
                    continue;
                }

                const localX = centers[i * 3];
                const localY = centers[i * 3 + 1];
                const localZ = centers[i * 3 + 2];
                const worldX = worldTransform[0] * localX + worldTransform[4] * localY + worldTransform[8] * localZ + worldTransform[12];
                const worldY = worldTransform[1] * localX + worldTransform[5] * localY + worldTransform[9] * localZ + worldTransform[13];
                const worldZ = worldTransform[2] * localX + worldTransform[6] * localY + worldTransform[10] * localZ + worldTransform[14];

                grid.addPoint(worldX, worldY, worldZ);
            }
        }

        grid.stats.cells = grid.cells.size;
        grid.stats.buildMs = Number((performance.now() - grid.buildStartedAt).toFixed(1));
        return grid;
    }

    private addPoint(x: number, y: number, z: number) {
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
            return;
        }

        const cellX = Math.floor(x / COLLISION_GRID_CELL_SIZE);
        const cellZ = Math.floor(z / COLLISION_GRID_CELL_SIZE);
        const bin = Math.floor(y / COLLISION_GRID_Y_BIN_SIZE);
        const key = `${cellX},${cellZ}`;
        let bins = this.cells.get(key);
        if (!bins) {
            bins = new Set<number>();
            this.cells.set(key, bins);
        }
        bins.add(bin);
        this.stats.sampledCenters += 1;
    }

    intersectsPlayerCapsule(head: Vec3): CollisionGridHit {
        const radius = COLLISION_GRID_CAPSULE_RADIUS;
        const cellRadius = Math.ceil(radius / COLLISION_GRID_CELL_SIZE);
        const centerCellX = Math.floor(head.x / COLLISION_GRID_CELL_SIZE);
        const centerCellZ = Math.floor(head.z / COLLISION_GRID_CELL_SIZE);
        const minBin = Math.floor((head.y - COLLISION_GRID_PLAYER_HEIGHT + COLLISION_GRID_STEP_HEIGHT) / COLLISION_GRID_Y_BIN_SIZE);
        const maxBin = Math.floor((head.y - COLLISION_GRID_HEAD_CLEARANCE) / COLLISION_GRID_Y_BIN_SIZE);

        for (let dx = -cellRadius; dx <= cellRadius; dx += 1) {
            for (let dz = -cellRadius; dz <= cellRadius; dz += 1) {
                const cellX = centerCellX + dx;
                const cellZ = centerCellZ + dz;
                const cellCenterX = (cellX + 0.5) * COLLISION_GRID_CELL_SIZE;
                const cellCenterZ = (cellZ + 0.5) * COLLISION_GRID_CELL_SIZE;
                if (Math.hypot(cellCenterX - head.x, cellCenterZ - head.z) > radius + COLLISION_GRID_CELL_SIZE * 0.75) {
                    continue;
                }

                const bins = this.cells.get(`${cellX},${cellZ}`);
                if (!bins) {
                    continue;
                }

                for (let bin = minBin; bin <= maxBin; bin += 1) {
                    if (bins.has(bin)) {
                        return { blocked: true, cellX, cellZ, bin };
                    }
                }
            }
        }

        return { blocked: false };
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
    private externalWalkInput: WalkInputState = {};
    private embeddedKeyboardInput: WalkInputState = {};
    private lastExternalMoveAt = performance.now();
    private lastLookAt = 0;
    private externalVerticalVelocity = 0;
    private externalGroundY: number | null = null;
    private externalJumpWasPressed = false;
    private embeddedControls = false;
    private lastArrowPositionAt = 0;
    private collisionGrid: WalkCollisionGrid | null = null;
    private lastCollisionGridReportAt = 0;
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
        window.addEventListener('keydown', this.onEmbeddedKeyDownBound, { capture: true });
        window.addEventListener('keyup', this.onEmbeddedKeyUpBound, { capture: true });
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

        const newFocal = camera.focalPoint.add(tmpVec);
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
                const resolvedMove = this.resolveCollisionGridMove(focalPoint, moveVec);
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

    private ensureCollisionGrid() {
        const splats = (this.scene.getElementsByType(ElementType.splat) as Splat[]).filter(splat => splat.visible);
        const signature = WalkCollisionGrid.signatureForSplats(splats);
        if (this.collisionGrid?.stats.signature === signature) {
            return this.collisionGrid;
        }

        if (splats.length === 0) {
            return null;
        }

        this.collisionGrid = WalkCollisionGrid.build(this.scene);
        this.events.fire('walk.collisionGrid', {
            ok: true,
            reason: 'built',
            ...this.collisionGrid.stats,
            cellSize: COLLISION_GRID_CELL_SIZE,
            yBinSize: COLLISION_GRID_Y_BIN_SIZE,
            capsuleRadius: COLLISION_GRID_CAPSULE_RADIUS,
            playerHeight: COLLISION_GRID_PLAYER_HEIGHT
        });
        return this.collisionGrid;
    }

    private reportCollisionGrid(now: number, reason: string, details: Record<string, unknown>) {
        if (reason !== 'blocked' && now - this.lastCollisionGridReportAt < COLLISION_GRID_REPORT_INTERVAL_MS) {
            return;
        }

        this.lastCollisionGridReportAt = now;
        this.events.fire('walk.collisionGrid', {
            ok: true,
            reason,
            embeddedControls: this.embeddedControls,
            ...details
        });
    }

    private resolveCollisionGridMove(focalPoint: Vec3, desiredMove: Vec3) {
        const grid = this.ensureCollisionGrid();
        if (!grid) {
            return desiredMove;
        }

        const now = performance.now();
        const candidates = [
            { reason: 'clear', move: desiredMove },
            { reason: 'slide-x', move: tmpVec.set(desiredMove.x, 0, 0).clone() },
            { reason: 'slide-z', move: tmpVec.set(0, 0, desiredMove.z).clone() }
        ];

        for (const candidate of candidates) {
            if (Math.hypot(candidate.move.x, candidate.move.z) <= 0.00001) {
                continue;
            }

            const proposed = tmpVec.copy(focalPoint).add(candidate.move);
            const hit = grid.intersectsPlayerCapsule(proposed);
            if (!hit.blocked) {
                this.reportCollisionGrid(now, candidate.reason, {
                    blocked: false,
                    moveX: Number(candidate.move.x.toFixed(3)),
                    moveZ: Number(candidate.move.z.toFixed(3))
                });
                return candidate.move;
            }
        }

        const blockedHead = tmpVec.copy(focalPoint).add(desiredMove);
        const hit = grid.intersectsPlayerCapsule(blockedHead);
        this.reportCollisionGrid(now, 'blocked', {
            blocked: true,
            cellX: hit.cellX ?? null,
            cellZ: hit.cellZ ?? null,
            bin: hit.bin ?? null,
            headX: Number(blockedHead.x.toFixed(3)),
            headY: Number(blockedHead.y.toFixed(3)),
            headZ: Number(blockedHead.z.toFixed(3)),
            moveX: Number(desiredMove.x.toFixed(3)),
            moveZ: Number(desiredMove.z.toFixed(3))
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
