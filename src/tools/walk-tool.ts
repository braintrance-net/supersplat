import { Vec3 } from 'playcanvas';

import { Events } from '../events';
import { Scene } from '../scene';
import { Camera } from '../camera';

type ArrowDirection = 'forward' | 'backward' | 'left' | 'right';

const tmpVec = new Vec3();
const screenPos = new Vec3();

// Max pixels the pointer can move between down/up and still count as a click
const CLICK_THRESHOLD = 5;

class WalkTool {
    private events: Events;
    private scene: Scene;
    private container: HTMLElement;
    private arrows: Map<ArrowDirection, HTMLElement> = new Map();
    private overlay: HTMLElement | null = null;
    private animFrame: number | null = null;
    private active = false;

    // Pointer tracking for distinguishing clicks from drags
    private pointerDownPos: { x: number; y: number } | null = null;
    private onPointerDownBound: ((e: PointerEvent) => void) | null = null;
    private onPointerUpBound: ((e: PointerEvent) => void) | null = null;

    constructor(events: Events, scene: Scene, container: HTMLElement) {
        this.events = events;
        this.scene = scene;
        this.container = container;
    }

    activate() {
        this.active = true;
        this.createOverlay();
        this.updateLoop();
    }

    deactivate() {
        this.active = false;
        this.destroyOverlay();
        if (this.animFrame !== null) {
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

        const directions: ArrowDirection[] = ['forward', 'backward', 'left', 'right'];
        for (const dir of directions) {
            const arrow = this.createArrow(dir);
            this.overlay.appendChild(arrow);
            this.arrows.set(dir, arrow);
        }

        // Track pointer down/up to distinguish clicks from drags
        this.onPointerDownBound = (e: PointerEvent) => this.onPointerDown(e);
        this.onPointerUpBound = (e: PointerEvent) => this.onPointerUp(e);
        this.container.addEventListener('pointerdown', this.onPointerDownBound);
        this.container.addEventListener('pointerup', this.onPointerUpBound);
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

        const rotations: Record<ArrowDirection, number> = {
            forward: 0,
            right: 90,
            backward: 180,
            left: 270
        };

        el.innerHTML = `<svg width="40" height="40" viewBox="0 0 40 40" style="transform: rotate(${rotations[direction]}deg); filter: drop-shadow(0 2px 4px rgba(0,0,0,0.5));">
            <polygon points="20,8 32,24 26,24 26,34 14,34 14,24 8,24" fill="white" stroke="rgba(0,0,0,0.3)" stroke-width="1"/>
        </svg>`;

        el.addEventListener('pointerenter', () => {
            el.style.opacity = '1';
            el.style.transform = el.style.transform.replace(/scale\([^)]*\)/, '') + ' scale(1.15)';
        });
        el.addEventListener('pointerleave', () => {
            el.style.opacity = '0.8';
            el.style.transform = el.style.transform.replace(/ ?scale\([^)]*\)/, '');
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
        const worldTransform = camera.mainCamera.getWorldTransform();

        const forward = worldTransform.getZ();
        forward.y = 0;
        forward.normalize().mulScalar(-1);

        const right = worldTransform.getX();
        right.y = 0;
        right.normalize();

        tmpVec.set(0, 0, 0);

        switch (direction) {
            case 'forward':
                tmpVec.add(forward);
                break;
            case 'backward':
                tmpVec.sub(forward);
                break;
            case 'right':
                tmpVec.add(right);
                break;
            case 'left':
                tmpVec.sub(right);
                break;
        }

        tmpVec.normalize().mulScalar(this.stepSize);

        const newFocal = camera.focalPoint.add(tmpVec);
        camera.setFocalPoint(newFocal);
        this.scene.forceRender = true;
    }

    private onPointerDown(e: PointerEvent) {
        // Ignore if clicking on an arrow element
        if ((e.target as HTMLElement).closest('.walk-arrow')) return;
        // Record where the pointer went down
        this.pointerDownPos = { x: e.clientX, y: e.clientY };
    }

    private async onPointerUp(e: PointerEvent) {
        if (!this.pointerDownPos) return;

        const dx = e.clientX - this.pointerDownPos.x;
        const dy = e.clientY - this.pointerDownPos.y;
        this.pointerDownPos = null;

        // Only treat as click if pointer barely moved (not a drag)
        if (Math.sqrt(dx * dx + dy * dy) > CLICK_THRESHOLD) return;

        // Ignore if the up target is an arrow
        if ((e.target as HTMLElement).closest('.walk-arrow')) return;

        const rect = this.container.getBoundingClientRect();
        const nx = (e.clientX - rect.left) / rect.width;
        const ny = (e.clientY - rect.top) / rect.height;

        const result = await this.camera.intersect(nx, ny);
        if (result) {
            this.moveTowardPoint(result.position, result.distance);
        }
    }

    private moveTowardPoint(worldPos: Vec3, currentDistance: number) {
        const camera = this.camera;

        const closerDistance = currentDistance * 0.4;
        const minDistance = camera.sceneRadius * 0.05;
        const targetDistance = Math.max(closerDistance, minDistance);

        camera.setFocalPoint(worldPos);
        camera.setDistance(targetDistance / camera.sceneRadius * camera.fovFactor);
        this.scene.forceRender = true;
    }

    private updateLoop() {
        if (!this.active) return;

        this.positionArrows();
        this.animFrame = requestAnimationFrame(() => this.updateLoop());
    }

    private positionArrows() {
        const camera = this.camera;
        const focalPoint = camera.focalPoint;

        const worldTransform = camera.mainCamera.getWorldTransform();
        const camForward = worldTransform.getZ().clone();
        camForward.y = 0;
        camForward.normalize().mulScalar(-1);

        const camRight = worldTransform.getX().clone();
        camRight.y = 0;
        camRight.normalize();

        // Place arrows on the actual scene floor, centered under the focal point
        const floorY = this.groundY;
        const arrowDist = this.stepSize * 0.7;

        // Ground-projected focal point (directly below focal point on the floor)
        const groundCenter = new Vec3(focalPoint.x, floorY, focalPoint.z);

        const positions: Record<ArrowDirection, Vec3> = {
            forward: new Vec3().add2(groundCenter, tmpVec.copy(camForward).mulScalar(arrowDist)),
            backward: new Vec3().add2(groundCenter, tmpVec.copy(camForward).mulScalar(-arrowDist)),
            left: new Vec3().add2(groundCenter, tmpVec.copy(camRight).mulScalar(-arrowDist)),
            right: new Vec3().add2(groundCenter, tmpVec.copy(camRight).mulScalar(arrowDist))
        };

        const containerRect = this.container.getBoundingClientRect();

        for (const [dir, el] of this.arrows) {
            const worldPos = positions[dir];
            camera.worldToScreen(worldPos, screenPos);

            const px = screenPos.x * containerRect.width;
            const py = screenPos.y * containerRect.height;

            // Hide if behind camera or outside viewport
            if (screenPos.z < 0 || screenPos.z > 1 ||
                px < -24 || px > containerRect.width + 24 ||
                py < -24 || py > containerRect.height + 24) {
                el.style.display = 'none';
                continue;
            }

            el.style.display = 'flex';
            el.style.left = `${px - 24}px`;
            el.style.top = `${py - 24}px`;
        }
    }

    private destroyOverlay() {
        if (this.onPointerDownBound) {
            this.container.removeEventListener('pointerdown', this.onPointerDownBound);
            this.onPointerDownBound = null;
        }
        if (this.onPointerUpBound) {
            this.container.removeEventListener('pointerup', this.onPointerUpBound);
            this.onPointerUpBound = null;
        }
        if (this.overlay) {
            this.overlay.remove();
            this.overlay = null;
        }
        this.arrows.clear();
        this.pointerDownPos = null;
    }
}

export { WalkTool };
