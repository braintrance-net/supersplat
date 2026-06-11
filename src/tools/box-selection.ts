import { Button, Container, NumericInput } from '@playcanvas/pcui';
import { Ray, TranslateGizmo, Vec3 } from 'playcanvas';

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

        // resize mode: six face handles, each dragging ONLY its own face along
        // the face axis (the opposite face stays put) — unlike a scale gizmo,
        // which grows the box symmetrically from the center
        let gizmoMode: 'move' | 'resize' = 'move';
        const attachActiveGizmo = () => {
            gizmo.detach();
            if (gizmoMode === 'move') {
                gizmo.attach([box.pivot]);
            }
            syncFaceHandleVisibility(this.active, gizmoMode);
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

        // ---- face drag handles ----
        type FaceHandle = { axis: 0 | 1 | 2; sign: 1 | -1; dom: HTMLDivElement };
        const faceAxisColors = ['#ff4f4f', '#4fff6a', '#4fa8ff'];
        const faceHandles: FaceHandle[] = [];
        let syncingFromGizmo = false;
        const faceRay = new Ray();
        const faceScreen = new Vec3();
        let activeDrag: { handle: FaceHandle; pointerId: number } | null = null;

        const lenForAxis = (axis: 0 | 1 | 2) => (axis === 0 ? box.lenX : axis === 1 ? box.lenY : box.lenZ);
        const setLenForAxis = (axis: 0 | 1 | 2, value: number) => {
            syncingFromGizmo = true;
            if (axis === 0) {
                box.lenX = value;
                lenX.value = value;
            } else if (axis === 1) {
                box.lenY = value;
                lenY.value = value;
            } else {
                box.lenZ = value;
                lenZ.value = value;
            }
            syncingFromGizmo = false;
        };

        const dragFaceTo = (handle: FaceHandle, clientX: number, clientY: number) => {
            const rect = scene.canvas.getBoundingClientRect();
            scene.camera.getRay(clientX - rect.left, clientY - rect.top, faceRay);
            // closest point between the mouse ray and the face axis line
            const center = box.pivot.getPosition();
            const axisDir = [0, 0, 0];
            axisDir[handle.axis] = 1;
            const w0x = center.x - faceRay.origin.x;
            const w0y = center.y - faceRay.origin.y;
            const w0z = center.z - faceRay.origin.z;
            const b = axisDir[0] * faceRay.direction.x + axisDir[1] * faceRay.direction.y + axisDir[2] * faceRay.direction.z;
            const d = -(axisDir[0] * w0x + axisDir[1] * w0y + axisDir[2] * w0z);
            const e = -(faceRay.direction.x * w0x + faceRay.direction.y * w0y + faceRay.direction.z * w0z);
            const denom = 1 - b * b;
            if (Math.abs(denom) < 1e-6) return;
            const t = (b * e - d) / denom;
            const centerCoord = handle.axis === 0 ? center.x : handle.axis === 1 ? center.y : center.z;
            const faceCoord = centerCoord + t;
            const oppositeCoord = centerCoord - handle.sign * lenForAxis(handle.axis) / 2;
            const nextLength = Math.max(0.01, handle.sign * (faceCoord - oppositeCoord));
            const nextCenterCoord = oppositeCoord + handle.sign * nextLength / 2;
            const position = center.clone();
            if (handle.axis === 0) position.x = nextCenterCoord;
            else if (handle.axis === 1) position.y = nextCenterCoord;
            else position.z = nextCenterCoord;
            box.pivot.setPosition(position);
            setLenForAxis(handle.axis, nextLength);
            box.moved();
            scene.forceRender = true;
        };

        function createFaceHandle(axis: 0 | 1 | 2, sign: 1 | -1) {
            const dom = document.createElement('div');
            dom.style.cssText = [
                'position:absolute',
                'width:14px',
                'height:14px',
                'margin:-7px 0 0 -7px',
                'border-radius:50%',
                `background:${faceAxisColors[axis]}`,
                'border:2px solid rgba(255,255,255,0.9)',
                'box-shadow:0 1px 4px rgba(0,0,0,0.5)',
                'cursor:grab',
                'pointer-events:auto',
                'z-index:60',
                'display:none'
            ].join(';');
            const handle: FaceHandle = { axis, sign, dom };
            dom.addEventListener('pointerdown', (event) => {
                event.stopPropagation();
                event.preventDefault();
                activeDrag = { handle, pointerId: event.pointerId };
                dom.setPointerCapture(event.pointerId);
                dom.style.cursor = 'grabbing';
            });
            dom.addEventListener('pointermove', (event) => {
                if (!activeDrag || activeDrag.pointerId !== event.pointerId) return;
                event.stopPropagation();
                dragFaceTo(activeDrag.handle, event.clientX, event.clientY);
            });
            const endDrag = (event: PointerEvent) => {
                if (!activeDrag || activeDrag.pointerId !== event.pointerId) return;
                dom.releasePointerCapture(event.pointerId);
                activeDrag = null;
                dom.style.cursor = 'grab';
            };
            dom.addEventListener('pointerup', endDrag);
            dom.addEventListener('pointercancel', endDrag);
            faceHandles.push(handle);
            canvasContainer.dom.appendChild(dom);
        }
        for (const axis of [0, 1, 2] as const) {
            for (const sign of [1, -1] as const) {
                createFaceHandle(axis, sign);
            }
        }

        function syncFaceHandleVisibility(active: boolean, mode: 'move' | 'resize') {
            const visible = active && mode === 'resize';
            for (const handle of faceHandles) {
                handle.dom.style.display = visible ? 'block' : 'none';
            }
        }

        const updateFaceHandles = () => {
            if (!this.active || gizmoMode !== 'resize') return;
            const center = box.pivot.getPosition();
            const canvasRect = scene.canvas.getBoundingClientRect();
            const containerRect = canvasContainer.dom.getBoundingClientRect();
            const offsetX = canvasRect.left - containerRect.left;
            const offsetY = canvasRect.top - containerRect.top;
            const forward = scene.camera.mainCamera.forward;
            const camPos = scene.camera.mainCamera.getPosition();
            for (const handle of faceHandles) {
                const world = center.clone();
                if (handle.axis === 0) world.x += handle.sign * box.lenX / 2;
                else if (handle.axis === 1) world.y += handle.sign * box.lenY / 2;
                else world.z += handle.sign * box.lenZ / 2;
                const toPoint = world.clone().sub(camPos);
                if (toPoint.dot(forward) <= 0) {
                    handle.dom.style.display = 'none';
                    continue;
                }
                handle.dom.style.display = 'block';
                scene.camera.camera.worldToScreen(world, faceScreen);
                handle.dom.style.left = `${offsetX + faceScreen.x}px`;
                handle.dom.style.top = `${offsetY + faceScreen.y}px`;
            }
        };
        scene.app.on('update', updateFaceHandles);

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
            scene.remove(box);
            this.active = false;
            syncFaceHandleVisibility(false, gizmoMode);
        };
    }
}

export { BoxSelection };
