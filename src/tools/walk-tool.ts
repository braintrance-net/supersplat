import { Vec3, math, Ray } from 'playcanvas';

import { Events } from '../events';
import { Scene } from '../scene';
import { Camera } from '../camera';

// Arrow directions relative to camera forward (projected onto ground plane)
type ArrowDirection = 'forward' | 'backward' | 'left' | 'right';

const tmpVec = new Vec3();
const tmpVec2 = new Vec3();
const screenPos = new Vec3();
const ray = new Ray();

class WalkTool {
    private events: Events;
    private scene: Scene;
    private container: HTMLElement;
    private arrows: Map<ArrowDirection, HTMLElement> = new Map();
    private overlay: HTMLElement | null = null;
    private animFrame: number | null = null;
    private active = false;
    private pointerHandler: ((e: PointerEvent) => void) | null = null;

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
        // Step size proportional to scene scale
        return this.camera.sceneRadius * 0.4;
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

        // Handle clicks on the scene for click-to-move
        this.pointerHandler = (e: PointerEvent) => this.onPointerDown(e);
        this.container.addEventListener('pointerdown', this.pointerHandler);
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

        // Rotation angles for each direction
        const rotations: Record<ArrowDirection, number> = {
            forward: 0,
            right: 90,
            backward: 180,
            left: 270
        };

        // Chevron SVG arrow (Google Maps style)
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

        // Get camera forward projected onto ground plane (XZ)
        const forward = worldTransform.getZ();
        forward.y = 0;
        forward.normalize().mulScalar(-1); // Camera Z is backward

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

        // Move focal point (camera follows)
        const newFocal = camera.focalPoint.add(tmpVec);
        camera.setFocalPoint(newFocal);
        this.scene.forceRender = true;
    }

    private async onPointerDown(e: PointerEvent) {
        // Ignore if clicking on an arrow
        if ((e.target as HTMLElement).closest('.walk-arrow')) return;

        const rect = this.container.getBoundingClientRect();
        const nx = (e.clientX - rect.left) / rect.width;
        const ny = (e.clientY - rect.top) / rect.height;

        // Raycast into scene to find hit point
        const result = await this.camera.intersect(nx, ny);
        if (result) {
            this.moveTowardPoint(result.position, result.distance);
        }
    }

    private moveTowardPoint(worldPos: Vec3, currentDistance: number) {
        const camera = this.camera;

        // Move 60% closer to the clicked point
        const closerDistance = currentDistance * 0.4;
        const minDistance = camera.sceneRadius * 0.05;
        const targetDistance = Math.max(closerDistance, minDistance);

        // Set the clicked point as the new focal point
        camera.setFocalPoint(worldPos);

        // Set closer distance
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

        // Get camera forward on ground plane
        const worldTransform = camera.mainCamera.getWorldTransform();
        const camForward = worldTransform.getZ().clone();
        camForward.y = 0;
        camForward.normalize().mulScalar(-1);

        const camRight = worldTransform.getX().clone();
        camRight.y = 0;
        camRight.normalize();

        // Place arrows on the ground at the focal point, offset in each direction
        const arrowDist = this.stepSize * 0.7;
        const groundY = focalPoint.y - camera.sceneRadius * 0.3; // Slightly below focal point

        const positions: Record<ArrowDirection, Vec3> = {
            forward: new Vec3().add2(focalPoint, tmpVec.copy(camForward).mulScalar(arrowDist)),
            backward: new Vec3().add2(focalPoint, tmpVec.copy(camForward).mulScalar(-arrowDist)),
            left: new Vec3().add2(focalPoint, tmpVec.copy(camRight).mulScalar(-arrowDist)),
            right: new Vec3().add2(focalPoint, tmpVec.copy(camRight).mulScalar(arrowDist))
        };

        // Set ground Y for all positions
        for (const key of Object.keys(positions) as ArrowDirection[]) {
            positions[key].y = groundY;
        }

        const containerRect = this.container.getBoundingClientRect();

        for (const [dir, el] of this.arrows) {
            const worldPos = positions[dir];
            camera.worldToScreen(worldPos, screenPos);

            // Convert normalized coords to pixel coords
            const px = screenPos.x * containerRect.width;
            const py = screenPos.y * containerRect.height;

            // Hide if behind camera
            if (screenPos.z < 0 || screenPos.z > 1) {
                el.style.display = 'none';
                continue;
            }

            el.style.display = 'flex';
            el.style.left = `${px - 24}px`;
            el.style.top = `${py - 24}px`;
        }
    }

    private destroyOverlay() {
        if (this.pointerHandler) {
            this.container.removeEventListener('pointerdown', this.pointerHandler);
            this.pointerHandler = null;
        }
        if (this.overlay) {
            this.overlay.remove();
            this.overlay = null;
        }
        this.arrows.clear();
    }
}

export { WalkTool };
