import { Vec3 } from 'playcanvas';

import { Events } from '../events';
import { Pivot } from '../pivot';
import { Scene } from '../scene';
import { Splat } from '../splat';
import { Transform } from '../transform';

const CLICK_THRESHOLD = 5;

class PlaceTool {
    activate: () => void;
    deactivate: () => void;

    constructor(events: Events, scene: Scene, container: HTMLElement) {
        let active = false;
        let pointerDownPos: { x: number; y: number } | null = null;

        const onPointerDown = (e: PointerEvent) => {
            pointerDownPos = { x: e.clientX, y: e.clientY };
        };

        const onPointerUp = async (e: PointerEvent) => {
            if (!active || !pointerDownPos) return;

            const dx = e.clientX - pointerDownPos.x;
            const dy = e.clientY - pointerDownPos.y;
            pointerDownPos = null;

            if (Math.sqrt(dx * dx + dy * dy) > CLICK_THRESHOLD) return;

            const splat = events.invoke('selection') as Splat;
            if (!splat || splat.numSelected === 0) return;

            // Raycast to find click destination
            const rect = container.getBoundingClientRect();
            const nx = (e.clientX - rect.left) / rect.width;
            const ny = (e.clientY - rect.top) / rect.height;

            const result = await scene.camera.intersect(nx, ny);
            if (!result) return;

            // Get current pivot (center of selected splats)
            const pivot = events.invoke('pivot') as Pivot;
            const pivotPos = pivot.transform.position;
            const oldRot = pivot.transform.rotation.clone();
            const oldScale = pivot.transform.scale.clone();

            // Calculate how far the pivot is above the selection's bottom.
            // This offset ensures the selection sits ON TOP of the surface
            // rather than embedding its center into it.
            const selBound = splat.selectionBound;
            const entity = splat.entity;

            // Transform the selection bound bottom to world space
            const boundBottomLocal = new Vec3(
                selBound.center.x,
                selBound.center.y - selBound.halfExtents.y,
                selBound.center.z
            );
            const boundBottomWorld = new Vec3();
            entity.getLocalTransform().transformPoint(boundBottomLocal, boundBottomWorld);

            // The vertical offset from selection bottom to pivot center
            const groundOffset = pivotPos.y - boundBottomWorld.y;

            // Place selection so its bottom sits on the hit point surface
            const newPos = new Vec3(
                result.position.x,
                result.position.y + groundOffset,
                result.position.z
            );

            pivot.start();
            pivot.move(new Transform(newPos, oldRot, oldScale));
            pivot.end();

            scene.forceRender = true;
        };

        this.activate = () => {
            active = true;
            container.addEventListener('pointerdown', onPointerDown);
            container.addEventListener('pointerup', onPointerUp);
            container.style.cursor = 'crosshair';
        };

        this.deactivate = () => {
            active = false;
            container.removeEventListener('pointerdown', onPointerDown);
            container.removeEventListener('pointerup', onPointerUp);
            container.style.cursor = '';
            pointerDownPos = null;
        };
    }
}

export { PlaceTool };
