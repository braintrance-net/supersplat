import { Vec3 } from 'playcanvas';

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
};

const tmpVec = new Vec3();
const forwardVec = new Vec3();
const rightVec = new Vec3();
const moveVec = new Vec3();
const screenPos = new Vec3();
const COLLISION_SAMPLE_INTERVAL_MS = 300;
const COLLISION_REPORT_INTERVAL_MS = 800;
const COLLISION_MAX_BLOCK_ELEVATION_DEG = 24;

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
    private externalWalkInput: WalkInputState = {};
    private lastExternalMoveAt = performance.now();
    private externalVerticalVelocity = 0;
    private externalGroundY: number | null = null;
    private externalJumpWasPressed = false;
    private lastArrowPositionAt = 0;
    private collisionProxy: CollisionProxyState = {
        pending: false,
        frontDistance: null,
        viewDistance: 0,
        blocked: false,
        lastSampleAt: 0,
        lastReportAt: 0
    };

    constructor(events: Events, scene: Scene, container: HTMLElement) {
        this.events = events;
        this.scene = scene;
        this.container = container;
        this.events.on('walk.pointerLook', this.onExternalPointerLook, this);
        this.events.on('walk.input', this.onExternalWalkInput, this);
    }

    activate() {
        this.active = true;
        this.createOverlay();
        this.ensureUpdateLoop();
    }

    deactivate() {
        this.active = false;
        this.destroyOverlay();
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

        this.look(dx, dy);
    }

    private onExternalPointerLook(dx = 0, dy = 0) {
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
        const input = this.externalWalkInput;
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

    private ensureUpdateLoop() {
        if (this.animFrame === null) {
            this.lastExternalMoveAt = performance.now();
            this.animFrame = requestAnimationFrame(() => this.updateLoop());
        }
    }

    private applyExternalWalkInput() {
        const input = this.externalWalkInput;
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
                focalPoint.add(moveVec);
                changed = true;
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

    private updateCollisionProxy(enabled: boolean) {
        const now = performance.now();
        if (!enabled) {
            if (this.collisionProxy.blocked) {
                this.collisionProxy.blocked = false;
                this.reportCollisionProxy(now, 'released');
            }
            return;
        }
        if (this.collisionProxy.pending || now - this.collisionProxy.lastSampleAt < COLLISION_SAMPLE_INTERVAL_MS) {
            return;
        }

        const camera = this.camera;
        const viewDistance = Math.max(0.001, camera.distance * camera.sceneRadius / camera.fovFactor);
        this.collisionProxy.pending = true;
        this.collisionProxy.lastSampleAt = now;
        this.collisionProxy.viewDistance = viewDistance;

        camera.intersect(0.5, 0.5).then((hit) => {
            const distance = typeof hit?.distance === 'number' && Number.isFinite(hit.distance) ? hit.distance : null;
            const clearance = Math.max(0.12, Math.min(0.9, viewDistance * 0.18));
            const canBlockFromView = Math.abs(camera.elevation) <= COLLISION_MAX_BLOCK_ELEVATION_DEG;
            const blocked = canBlockFromView && distance !== null && distance < viewDistance - clearance;
            const changed = blocked !== this.collisionProxy.blocked;
            this.collisionProxy.pending = false;
            this.collisionProxy.frontDistance = distance;
            this.collisionProxy.blocked = blocked;
            if (changed || now - this.collisionProxy.lastReportAt >= COLLISION_REPORT_INTERVAL_MS) {
                this.reportCollisionProxy(performance.now(), changed ? 'changed' : 'sampled');
            }
        }).catch((error: unknown) => {
            this.collisionProxy.pending = false;
            this.collisionProxy.frontDistance = null;
            this.collisionProxy.blocked = false;
            this.events.fire('walk.collisionProxy', {
                ok: false,
                error: error instanceof Error ? error.message : 'collision proxy sample failed'
            });
        });
    }

    private reportCollisionProxy(now: number, reason: string) {
        this.collisionProxy.lastReportAt = now;
        this.events.fire('walk.collisionProxy', {
            ok: true,
            reason,
            blocked: this.collisionProxy.blocked,
            frontDistance: this.collisionProxy.frontDistance === null ? null : Number(this.collisionProxy.frontDistance.toFixed(3)),
            viewDistance: Number(this.collisionProxy.viewDistance.toFixed(3)),
            elevation: Number(this.camera.elevation.toFixed(2))
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
        if (this.active && now - this.lastArrowPositionAt >= 120) {
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
