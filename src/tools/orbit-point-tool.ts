import { Container, Label } from '@playcanvas/pcui';

import { Events } from '../events';
import { Scene } from '../scene';
import { i18n } from '../ui/localization';

// pointer movement below this many pixels still counts as a click
const CLICK_TOLERANCE = 4;

/**
 * Click-to-recenter, matching the viewer: while this tool is active a single
 * click on the scene moves the camera's orbit origin (focal point) to the
 * surface point under the cursor, leaving the camera where it is. Dragging is
 * left alone so orbit/pan/zoom keep working with the tool switched on.
 */
class OrbitPointTool {
    activate: () => void;
    deactivate: () => void;

    constructor(events: Events, scene: Scene, canvasContainer: Container) {
        const hintLabel = new Label({ class: 'select-toolbar-label' });
        i18n.bindText(hintLabel, 'orbit-point.hint');

        const selectToolbar = new Container({
            class: ['select-toolbar', 'select-toolbar-tool'],
            hidden: true
        });

        selectToolbar.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
        });

        selectToolbar.append(hintLabel);
        canvasContainer.append(selectToolbar);

        const isPrimary = (e: PointerEvent) => {
            return e.pointerType === 'mouse' ? e.button === 0 : e.isPrimary;
        };

        let clicked = false;
        let clickX = 0;
        let clickY = 0;

        const pointerdown = (e: PointerEvent) => {
            if (!clicked && isPrimary(e)) {
                clicked = true;
                clickX = e.offsetX;
                clickY = e.offsetY;
            }
        };

        const pointermove = (e: PointerEvent) => {
            // forgive small jitter between down and up; a real drag is the user
            // navigating the camera, not picking a point
            if (clicked && Math.hypot(e.offsetX - clickX, e.offsetY - clickY) > CLICK_TOLERANCE) {
                clicked = false;
            }
        };

        const pointerup = (e: PointerEvent) => {
            if (!clicked || !isPrimary(e)) {
                return;
            }
            clicked = false;

            // fly mode has no orbit origin, so recentring implies orbit mode
            // (same switch the focus double-click performs)
            if (events.invoke('camera.controlMode') === 'fly') {
                events.fire('camera.setControlMode', 'orbit');
            }

            // pick at the pointer-down position: that is where the user aimed
            scene.camera.pickFocalPoint(
                clickX / canvasContainer.dom.clientWidth,
                clickY / canvasContainer.dom.clientHeight
            );

            e.preventDefault();
            e.stopPropagation();
        };

        this.activate = () => {
            clicked = false;
            canvasContainer.dom.addEventListener('pointerdown', pointerdown);
            canvasContainer.dom.addEventListener('pointermove', pointermove);
            canvasContainer.dom.addEventListener('pointerup', pointerup, true);
            selectToolbar.hidden = false;
            scene.canvas.style.cursor = 'crosshair';
        };

        this.deactivate = () => {
            clicked = false;
            canvasContainer.dom.removeEventListener('pointerdown', pointerdown);
            canvasContainer.dom.removeEventListener('pointermove', pointermove);
            canvasContainer.dom.removeEventListener('pointerup', pointerup, true);
            selectToolbar.hidden = true;
            scene.canvas.style.cursor = '';
        };
    }
}

export { OrbitPointTool };
