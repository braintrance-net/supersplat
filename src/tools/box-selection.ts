import { Button, Container, NumericInput } from '@playcanvas/pcui';
import { ScaleGizmo, TranslateGizmo, Vec3 } from 'playcanvas';

import { BoxShape } from '../box-shape';
import { Events } from '../events';
import { Scene } from '../scene';
import { Splat } from '../splat';

class BoxSelection {
    activate: () => void;
    deactivate: () => void;

    active = false;

    constructor(events: Events, scene: Scene, canvasContainer: Container) {
        const box = new BoxShape();

        const gizmo = new TranslateGizmo(scene.camera.camera, scene.gizmoLayer);

        gizmo.on('render:update', () => {
            scene.forceRender = true;
        });

        gizmo.on('transform:move', () => {
            box.moved();
        });

        // resize mode: the box pivot's local scale IS the box dimensions
        // (box.moved() copies lens into setLocalScale), so a scale gizmo
        // resizes the box natively — just mirror the result back into lens
        const scaleGizmo = new ScaleGizmo(scene.camera.camera, scene.gizmoLayer);
        scaleGizmo.on('render:update', () => {
            scene.forceRender = true;
        });
        let syncingFromGizmo = false;

        let gizmoMode: 'move' | 'resize' = 'move';
        const attachActiveGizmo = () => {
            gizmo.detach();
            scaleGizmo.detach();
            if (gizmoMode === 'move') {
                gizmo.attach([box.pivot]);
            } else {
                scaleGizmo.attach([box.pivot]);
            }
        };

        // ui
        const selectToolbar = new Container({
            class: 'select-toolbar',
            hidden: true
        });

        selectToolbar.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
        });

        const moveModeButton = new Button({ text: 'Move', class: 'select-toolbar-button' });
        const resizeModeButton = new Button({ text: 'Resize', class: 'select-toolbar-button' });
        const setButton = new Button({ text: 'Set', class: 'select-toolbar-button' });
        const addButton = new Button({ text: 'Add', class: 'select-toolbar-button' });
        const removeButton = new Button({ text: 'Remove', class: 'select-toolbar-button' });
        const saveTargetButton = new Button({ text: 'Save Target', class: 'select-toolbar-button' });
        const copyEvalButton = new Button({ text: 'Copy Click Eval', class: 'select-toolbar-button' });

        const lenX = new NumericInput({
            precision: 2,
            value: box.lenX,
            placeholder: 'Width',
            width: 80,
            min: 0.01
        });

        const lenY = new NumericInput({
            precision: 2,
            value: box.lenY,
            placeholder: 'Height',
            width: 80,
            min: 0.01
        });

        const lenZ = new NumericInput({
            precision: 2,
            value: box.lenZ,
            placeholder: 'Depth',
            width: 80,
            min: 0.01
        });

        selectToolbar.append(moveModeButton);
        selectToolbar.append(resizeModeButton);
        selectToolbar.append(setButton);
        selectToolbar.append(addButton);
        selectToolbar.append(removeButton);
        selectToolbar.append(saveTargetButton);
        selectToolbar.append(copyEvalButton);
        selectToolbar.append(lenX);
        selectToolbar.append(lenY);
        selectToolbar.append(lenZ);

        canvasContainer.append(selectToolbar);

        const currentBox = () => {
            const p = box.pivot.getPosition();
            return {
                type: 'axis_aligned_box',
                center: [p.x, p.y, p.z],
                dimensions: [box.lenX, box.lenY, box.lenZ],
                rotation: [
                    [1, 0, 0],
                    [0, 1, 0],
                    [0, 0, 1]
                ]
            };
        };

        const apply = (op: 'set' | 'add' | 'remove') => {
            const p = box.pivot.getPosition();
            events.fire('select.byBox', op, [p.x, p.y, p.z, box.lenX, box.lenY, box.lenZ]);
        };

        scaleGizmo.on('transform:move', () => {
            const localScale = box.pivot.getLocalScale();
            syncingFromGizmo = true;
            box.lenX = Math.max(0.01, localScale.x);
            box.lenY = Math.max(0.01, localScale.y);
            box.lenZ = Math.max(0.01, localScale.z);
            lenX.value = box.lenX;
            lenY.value = box.lenY;
            lenZ.value = box.lenZ;
            syncingFromGizmo = false;
            box.moved();
            scene.forceRender = true;
        });

        const syncModeButtons = () => {
            moveModeButton.dom.style.opacity = gizmoMode === 'move' ? '1' : '0.55';
            resizeModeButton.dom.style.opacity = gizmoMode === 'resize' ? '1' : '0.55';
        };
        syncModeButtons();
        moveModeButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            gizmoMode = 'move';
            syncModeButtons();
            if (this.active) attachActiveGizmo();
        });
        resizeModeButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            gizmoMode = 'resize';
            syncModeButtons();
            if (this.active) attachActiveGizmo();
        });
        setButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            apply('set');
        });
        addButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            apply('add');
        });
        removeButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            apply('remove');
        });
        saveTargetButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            events.invoke('boxer.setStickyEvalTarget', currentBox());
        });
        copyEvalButton.dom.addEventListener('pointerdown', async (e) => {
            e.stopPropagation();
            await events.invoke('boxer.copyEvalCase', currentBox());
        });
        const resizeFromLowSide = (axis: 'x' | 'y' | 'z', nextLength: number) => {
            const previousLength = axis === 'x' ? box.lenX : (axis === 'y' ? box.lenY : box.lenZ);
            const delta = nextLength - previousLength;
            const position = box.pivot.getPosition().clone();
            position[axis] += delta * 0.5;
            box.pivot.setPosition(position);
            if (axis === 'x') {
                box.lenX = nextLength;
            } else if (axis === 'y') {
                box.lenY = nextLength;
            } else {
                box.lenZ = nextLength;
            }
            box.moved();
            scene.forceRender = true;
        };

        lenX.on('change', () => {
            if (!syncingFromGizmo) resizeFromLowSide('x', lenX.value);
        });
        lenY.on('change', () => {
            if (!syncingFromGizmo) resizeFromLowSide('y', lenY.value);
        });
        lenZ.on('change', () => {
            if (!syncingFromGizmo) resizeFromLowSide('z', lenZ.value);
        });

        events.on('camera.focalPointPicked', (details: { splat: Splat, position: Vec3 }) => {
            if (this.active) {
                box.pivot.setPosition(details.position);
                attachActiveGizmo();
            }
        });

        try {
            events.function('boxSelection.currentBox', currentBox);
        } catch (err) {
            console.warn('[BoxSelection] boxSelection.currentBox was already registered', err);
        }

        try {
            // seed the manual box from an external source (eval case editor)
            events.function('boxSelection.setBox', (next: { center: [number, number, number]; dimensions: [number, number, number] }) => {
                box.pivot.setPosition(new Vec3(next.center[0], next.center[1], next.center[2]));
                box.lenX = Math.max(0.01, next.dimensions[0]);
                box.lenY = Math.max(0.01, next.dimensions[1]);
                box.lenZ = Math.max(0.01, next.dimensions[2]);
                lenX.value = box.lenX;
                lenY.value = box.lenY;
                lenZ.value = box.lenZ;
                box.moved();
                if (this.active) {
                    attachActiveGizmo();
                }
                scene.forceRender = true;
                return currentBox();
            });
        } catch (err) {
            console.warn('[BoxSelection] boxSelection.setBox was already registered', err);
        }

        const updateGizmoSize = () => {
            const { camera, canvas } = scene;
            if (camera.ortho) {
                gizmo.size = 1125 / canvas.clientHeight;
            } else {
                gizmo.size = 1200 / Math.max(canvas.clientWidth, canvas.clientHeight);
            }
            scaleGizmo.size = gizmo.size;
        };
        updateGizmoSize();
        events.on('camera.resize', updateGizmoSize);
        events.on('camera.ortho', updateGizmoSize);

        this.activate = () => {
            this.active = true;
            scene.add(box);
            attachActiveGizmo();
            selectToolbar.hidden = false;
        };

        this.deactivate = () => {
            selectToolbar.hidden = true;
            gizmo.detach();
            scaleGizmo.detach();
            scene.remove(box);
            this.active = false;
        };
    }
}

export { BoxSelection };
