import { Button, Container, NumericInput } from '@playcanvas/pcui';
import { TranslateGizmo, Vec3 } from 'playcanvas';

import { BoxShape } from '../box-shape';
import { Events } from '../events';
import { Scene } from '../scene';
import { Splat } from '../splat';
import { createScreenMath } from '../utils/collision-surface';

class BoxSelection {
    activate: () => void;
    deactivate: () => void;

    active = false;

    constructor(events: Events, scene: Scene, canvasContainer: Container) {
        const box = new BoxShape();
        let touched = false;
        let synthetic = false;
        let confirmedAt: string | null = null;
        let confirmationAttemptedAt: string | null = null;
        let updatedAt: string | null = null;
        let suppressUserEditTracking = false;
        const initialPosition = box.pivot.getPosition().clone();
        const initialDimensions: [number, number, number] = [box.lenX, box.lenY, box.lenZ];

        const markTouched = () => {
            touched = true;
            if (!suppressUserEditTracking) {
                synthetic = false;
            }
            updatedAt = new Date().toISOString();
        };

        const hasChangedFromInitial = (position: Vec3) => (
            Math.abs(position.x - initialPosition.x) > 1e-5 ||
            Math.abs(position.y - initialPosition.y) > 1e-5 ||
            Math.abs(position.z - initialPosition.z) > 1e-5 ||
            Math.abs(box.lenX - initialDimensions[0]) > 1e-5 ||
            Math.abs(box.lenY - initialDimensions[1]) > 1e-5 ||
            Math.abs(box.lenZ - initialDimensions[2]) > 1e-5
        );

        const gizmo = new TranslateGizmo(scene.camera.camera, scene.gizmoLayer);

        gizmo.on('render:update', () => {
            scene.forceRender = true;
        });

        gizmo.on('transform:move', () => {
            markTouched();
            box.moved();
            queueSelectionRefresh();
        });

        gizmo.on('transform:end', () => {
            markTouched();
            box.moved();
            queueSelectionRefresh(true, true);
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
            const changedFromInitial = hasChangedFromInitial(p);
            const ready = changedFromInitial;
            return {
                type: 'axis_aligned_box',
                center: [p.x, p.y, p.z],
                dimensions: [box.lenX, box.lenY, box.lenZ],
                rotation: [
                    [1, 0, 0],
                    [0, 1, 0],
                    [0, 0, 1]
                ],
                ready,
                updated_at: updatedAt,
                touched,
                confirmed: ready && !!confirmedAt,
                confirmed_at: ready ? confirmedAt : null,
                confirmation_attempted_at: confirmationAttemptedAt,
                changed_from_initial: changedFromInitial,
                active: this.active,
                synthetic,
                source: 'boxSelection.currentBox'
            };
        };

        const confirmEvalTarget = () => {
            const now = new Date().toISOString();
            confirmationAttemptedAt = now;
            updatedAt = now;
            if (hasChangedFromInitial(box.pivot.getPosition())) {
                confirmedAt = now;
                touched = true;
            }
            return currentBox();
        };

        const setCurrentBoxTarget = (input: unknown) => {
            const record = input as {
                target?: unknown;
                center?: unknown;
                dimensions?: unknown;
                synthetic?: unknown;
            } | null | undefined;
            const target = (record?.target ?? input) as {
                center?: unknown;
                dimensions?: unknown;
                synthetic?: unknown;
            } | null | undefined;
            const center = target?.center;
            const dimensions = target?.dimensions;
            if (!Array.isArray(center) || center.length !== 3 ||
                !Array.isArray(dimensions) || dimensions.length !== 3) {
                return { ok: false, error: 'Expected an axis-aligned eval target with center and dimensions.' };
            }

            const nextCenter = center.map(Number);
            const nextDimensions = dimensions.map(Number);
            if (!nextCenter.every(Number.isFinite) ||
                !nextDimensions.every(value => Number.isFinite(value) && value > 0)) {
                return { ok: false, error: 'Eval target center or dimensions are invalid.' };
            }

            suppressUserEditTracking = true;
            try {
                box.pivot.setPosition(nextCenter[0], nextCenter[1], nextCenter[2]);
                box.lenX = nextDimensions[0];
                box.lenY = nextDimensions[1];
                box.lenZ = nextDimensions[2];
                lenX.value = box.lenX;
                lenY.value = box.lenY;
                lenZ.value = box.lenZ;
                box.moved();
            } finally {
                suppressUserEditTracking = false;
            }

            synthetic = (target?.synthetic ?? record?.synthetic) === true;
            touched = !synthetic;
            confirmedAt = null;
            confirmationAttemptedAt = null;
            updatedAt = new Date().toISOString();
            scene.forceRender = true;
            if (this.active) {
                attachActiveGizmo();
                queueSelectionRefresh(true);
            }

            return { ok: true, target: currentBox() };
        };

        const copyJson = async (payload: unknown) => {
            const text = JSON.stringify(payload, null, 2);
            try {
                await navigator.clipboard.writeText(text);
                return true;
            } catch {
                const input = document.createElement('textarea');
                input.value = text;
                input.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
                document.body.append(input);
                input.select();
                const copied = document.execCommand('copy');
                input.remove();
                return copied;
            }
        };

        const selectCurrentBox = (op: 'set' | 'add' | 'remove' = 'set', live = false) => {
            const selectionBox = currentBox();
            return events.invoke(live ? 'select.byOBBLiveNow' : 'select.byOBBNow', op, {
                center: selectionBox.center,
                dimensions: selectionBox.dimensions,
                rotation: selectionBox.rotation
            }) as Promise<unknown>;
        };

        const apply = (op: 'set' | 'add' | 'remove') => {
            markTouched();
            selectCurrentBox(op)
            .then(() => {
                events.fire('selection.commit', { source: 'boxSelection', action: op });
            })
            .catch((err) => {
                console.warn('[BoxSelection] selection apply failed', err);
            });
        };

        // ---- resize handles: 6 face dots + 12 edge dots ----
        // Faces drag one face along its axis; edges drag the two faces that
        // meet at that edge (the opposite faces stay fixed). All math runs in
        // explicit pinhole screen space (engine screen<->world is warped).
        type ResizeHandle = { faces: { axis: 0 | 1 | 2; sign: 1 | -1 }[]; freeAxis: 0 | 1 | 2; dom: HTMLDivElement };
        const faceAxisColors = ['#ff4f4f', '#4fff6a', '#4fa8ff'];
        const resizeHandles: ResizeHandle[] = [];
        const screenMath = createScreenMath(scene);
        let syncingFromGizmo = false;
        let activeDrag: {
            handle: ResizeHandle;
            pointerId: number;
            startClient: [number, number];
            // edge handles lock to ONE of their two axes once the drag
            // direction is clear — never two dimensions at once
            lockedFace: { axis: 0 | 1 | 2; sign: 1 | -1 } | null;
        } | null = null;
        let selectionRefreshQueued = false;
        let selectionRefreshInFlight = false;
        let selectionRefreshFrame: number | null = null;
        let showRadialAfterSelectionRefresh = false;
        const isActive = () => this.active;

        const runSelectionRefresh = async () => {
            if (!isActive()) {
                selectionRefreshQueued = false;
                return;
            }
            if (selectionRefreshInFlight) {
                selectionRefreshQueued = true;
                return;
            }

            selectionRefreshQueued = false;
            selectionRefreshInFlight = true;
            try {
                await selectCurrentBox('set', true);
            } catch (err) {
                console.warn('[BoxSelection] live selection refresh failed', err);
            } finally {
                selectionRefreshInFlight = false;
                if (selectionRefreshQueued && isActive()) {
                    queueSelectionRefresh();
                } else if (showRadialAfterSelectionRefresh) {
                    showRadialAfterSelectionRefresh = false;
                    events.fire('selection.commit', { source: 'boxSelection', action: 'edit' });
                }
            }
        };

        function queueSelectionRefresh(immediate = false, showRadial = false) {
            if (!isActive()) {
                return;
            }
            if (showRadial) {
                showRadialAfterSelectionRefresh = true;
            }
            selectionRefreshQueued = true;
            if (immediate) {
                if (selectionRefreshFrame !== null) {
                    window.cancelAnimationFrame(selectionRefreshFrame);
                    selectionRefreshFrame = null;
                }
                runSelectionRefresh().catch((err) => {
                    console.warn('[BoxSelection] live selection refresh failed', err);
                });
                return;
            }
            if (selectionRefreshFrame !== null || selectionRefreshInFlight) {
                return;
            }
            selectionRefreshFrame = window.requestAnimationFrame(() => {
                selectionRefreshFrame = null;
                runSelectionRefresh().catch((err) => {
                    console.warn('[BoxSelection] live selection refresh failed', err);
                });
            });
        }

        const cancelSelectionRefresh = () => {
            if (selectionRefreshFrame !== null) {
                window.cancelAnimationFrame(selectionRefreshFrame);
                selectionRefreshFrame = null;
            }
            selectionRefreshQueued = false;
            showRadialAfterSelectionRefresh = false;
        };

        const cancelActiveDrag = () => {
            if (!activeDrag) return;
            const { handle, pointerId } = activeDrag;
            if (handle.dom.hasPointerCapture(pointerId)) {
                handle.dom.releasePointerCapture(pointerId);
            }
            handle.dom.style.cursor = 'grab';
            activeDrag = null;
        };

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

        // move one face to an absolute world coordinate along its axis,
        // keeping the opposite face fixed
        const applyFaceCoord = (axis: 0 | 1 | 2, sign: 1 | -1, faceCoord: number) => {
            const center = box.pivot.getPosition();
            const centerCoord = axis === 0 ? center.x : axis === 1 ? center.y : center.z;
            const oppositeCoord = centerCoord - sign * lenForAxis(axis) / 2;
            const nextLength = Math.max(0.01, sign * (faceCoord - oppositeCoord));
            const nextCenterCoord = oppositeCoord + sign * nextLength / 2;
            const position = center.clone();
            if (axis === 0) position.x = nextCenterCoord;
            else if (axis === 1) position.y = nextCenterCoord;
            else position.z = nextCenterCoord;
            box.pivot.setPosition(position);
            setLenForAxis(axis, nextLength);
        };

        const handleAnchorWorld = (handle: ResizeHandle) => {
            const center = box.pivot.getPosition();
            const world: [number, number, number] = [center.x, center.y, center.z];
            for (const face of handle.faces) {
                world[face.axis] += face.sign * lenForAxis(face.axis) / 2;
            }
            return world;
        };

        const updateResizeHandles = () => {
            if (!this.active || gizmoMode !== 'resize') return;
            const model = screenMath.pinhole();
            if (!model) return;
            const containerRect = canvasContainer.dom.getBoundingClientRect();
            for (const handle of resizeHandles) {
                const projected = screenMath.projectToClient(model, handleAnchorWorld(handle));
                if (!projected) {
                    handle.dom.style.display = 'none';
                    continue;
                }
                handle.dom.style.display = 'block';
                handle.dom.style.left = `${projected[0] - containerRect.left}px`;
                handle.dom.style.top = `${projected[1] - containerRect.top}px`;
            }
        };

        // resolve a single-face drag: closest point between the mouse ray and
        // the world axis line through the box center
        const dragFaceAlongAxis = (
            face: { axis: 0 | 1 | 2; sign: 1 | -1 },
            o: [number, number, number],
            d: [number, number, number]
        ) => {
            const center = box.pivot.getPosition();
            const p0: [number, number, number] = [center.x, center.y, center.z];
            const u: [number, number, number] = [0, 0, 0];
            u[face.axis] = 1;
            // closest point on the axis line P(t) = p0 + u*t to the mouse ray
            // R(s) = o + d*s, with w = p0 - o:  t = (b*(d·w) - (u·w)) / (1 - b²)
            const w0 = [p0[0] - o[0], p0[1] - o[1], p0[2] - o[2]];
            const b = u[0] * d[0] + u[1] * d[1] + u[2] * d[2];
            const uw = u[0] * w0[0] + u[1] * w0[1] + u[2] * w0[2];
            const dw = d[0] * w0[0] + d[1] * w0[1] + d[2] * w0[2];
            const denom = 1 - b * b;
            if (Math.abs(denom) < 1e-6) return;
            const t = (b * dw - uw) / denom;
            applyFaceCoord(face.axis, face.sign, p0[face.axis] + t);
        };

        // pick which of an edge's two axes the user is dragging along by
        // comparing the mouse delta against each axis's screen direction
        const resolveEdgeLock = (handle: ResizeHandle, model: NonNullable<ReturnType<typeof screenMath.pinhole>>, clientX: number, clientY: number) => {
            if (!activeDrag) return null;
            const deltaX = clientX - activeDrag.startClient[0];
            const deltaY = clientY - activeDrag.startClient[1];
            if (Math.hypot(deltaX, deltaY) < 8) return null;
            const anchor = handleAnchorWorld(handle);
            const anchorScreen = screenMath.projectToClient(model, anchor);
            if (!anchorScreen) return null;
            let best: { face: { axis: 0 | 1 | 2; sign: 1 | -1 }; score: number } | null = null;
            for (const face of handle.faces) {
                const offset: [number, number, number] = [...anchor];
                offset[face.axis] += Math.max(0.2, lenForAxis(face.axis) * 0.25);
                const offsetScreen = screenMath.projectToClient(model, offset);
                if (!offsetScreen) continue;
                const axisDeltaX = offsetScreen[0] - anchorScreen[0];
                const axisDeltaY = offsetScreen[1] - anchorScreen[1];
                const axisLength = Math.hypot(axisDeltaX, axisDeltaY) || 1;
                const score = Math.abs((deltaX * axisDeltaX + deltaY * axisDeltaY) / axisLength);
                if (!best || score > best.score) best = { face, score };
            }
            return best?.face ?? null;
        };

        const dragHandleTo = (handle: ResizeHandle, clientX: number, clientY: number) => {
            const model = screenMath.pinhole();
            if (!model) return;
            const dir = screenMath.rayThrough(model, clientX, clientY);
            const dirLength = Math.hypot(dir[0], dir[1], dir[2]) || 1;
            const d: [number, number, number] = [dir[0] / dirLength, dir[1] / dirLength, dir[2] / dirLength];
            const o: [number, number, number] = [model.position.x, model.position.y, model.position.z];

            if (handle.faces.length === 1) {
                dragFaceAlongAxis(handle.faces[0], o, d);
            } else {
                // edge: one dimension at a time — lock to the axis the user is
                // pulling along, then behave exactly like that face's handle
                if (activeDrag && !activeDrag.lockedFace) {
                    activeDrag.lockedFace = resolveEdgeLock(handle, model, clientX, clientY);
                }
                const locked = activeDrag?.lockedFace;
                if (!locked) return;
                dragFaceAlongAxis(locked, o, d);
            }
            markTouched();
            box.moved();
            scene.forceRender = true;
            updateResizeHandles();
            queueSelectionRefresh();
        };

        function createResizeHandle(faces: { axis: 0 | 1 | 2; sign: 1 | -1 }[], freeAxis: 0 | 1 | 2) {
            const dom = document.createElement('div');
            const isFace = faces.length === 1;
            const size = isFace ? 14 : 10;
            const background = isFace ? faceAxisColors[faces[0].axis] : '#f4f4f4';
            dom.style.cssText = [
                'position:absolute',
                `width:${size}px`,
                `height:${size}px`,
                `margin:${-size / 2}px 0 0 ${-size / 2}px`,
                'border-radius:50%',
                `background:${background}`,
                `border:2px solid ${isFace ? 'rgba(255,255,255,0.9)' : 'rgba(20,22,25,0.85)'}`,
                'box-shadow:0 1px 4px rgba(0,0,0,0.5)',
                'cursor:grab',
                'pointer-events:auto',
                'z-index:60',
                'display:none'
            ].join(';');
            const handle: ResizeHandle = { faces, freeAxis, dom };
            dom.addEventListener('pointerdown', (event) => {
                event.stopPropagation();
                event.preventDefault();
                activeDrag = {
                    handle,
                    pointerId: event.pointerId,
                    startClient: [event.clientX, event.clientY],
                    lockedFace: null
                };
                dom.setPointerCapture(event.pointerId);
                dom.style.cursor = 'grabbing';
            });
            dom.addEventListener('pointermove', (event) => {
                if (!activeDrag || activeDrag.pointerId !== event.pointerId) return;
                event.stopPropagation();
                dragHandleTo(activeDrag.handle, event.clientX, event.clientY);
            });
            const endDrag = (event: PointerEvent) => {
                if (!activeDrag || activeDrag.pointerId !== event.pointerId) return;
                if (dom.hasPointerCapture(event.pointerId)) {
                    dom.releasePointerCapture(event.pointerId);
                }
                activeDrag = null;
                dom.style.cursor = 'grab';
                queueSelectionRefresh(true, true);
            };
            const lostPointerCapture = (event: PointerEvent) => {
                if (!activeDrag || activeDrag.pointerId !== event.pointerId) return;
                activeDrag = null;
                dom.style.cursor = 'grab';
                queueSelectionRefresh(true, true);
            };
            dom.addEventListener('pointerup', endDrag);
            dom.addEventListener('pointercancel', endDrag);
            dom.addEventListener('lostpointercapture', lostPointerCapture);
            resizeHandles.push(handle);
            canvasContainer.dom.appendChild(dom);
        }

        // 6 faces
        for (const axis of [0, 1, 2] as const) {
            for (const sign of [1, -1] as const) {
                createResizeHandle([{ axis, sign }], axis);
            }
        }
        // 12 edges: every pair of axes, every sign combination; the remaining
        // axis is the edge direction
        for (const freeAxis of [0, 1, 2] as const) {
            const [axisA, axisB] = [0, 1, 2].filter(axis => axis !== freeAxis) as [0 | 1 | 2, 0 | 1 | 2];
            for (const signA of [1, -1] as const) {
                for (const signB of [1, -1] as const) {
                    createResizeHandle([{ axis: axisA, sign: signA }, { axis: axisB, sign: signB }], freeAxis);
                }
            }
        }

        function syncFaceHandleVisibility(active: boolean, mode: 'move' | 'resize') {
            const visible = active && mode === 'resize';
            for (const handle of resizeHandles) {
                handle.dom.style.display = visible ? 'block' : 'none';
            }
        }

        scene.app.on('update', () => updateResizeHandles());

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
        });
        saveTargetButton.dom.addEventListener('click', (e) => {
            e.stopPropagation();
            const target = confirmEvalTarget();
            if (!target.ready) {
                events.fire('toast', 'Move or resize the eval box around the object before saving it', 'warning');
                return;
            }
            if (target.synthetic) {
                events.fire('toast', 'Adjust the prefilled eval box before saving it as a benchmark target', 'warning');
                return;
            }
            try {
                events.invoke('boxer.setStickyEvalTarget', target);
            } catch {
                // Boxer is optional for Artisan eval exports.
            }
            try {
                events.invoke('artisan.local.setEvalTarget', target);
            } catch {
                // ArtisanGS is optional in some editor builds.
            }
        });
        copyEvalButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
        });
        copyEvalButton.dom.addEventListener('click', async (e) => {
            e.stopPropagation();
            const target = confirmEvalTarget();
            if (!target.ready) {
                events.fire('toast', 'Move or resize the eval box around the object before copying an eval', 'warning');
                return;
            }
            if (target.synthetic) {
                events.fire('toast', 'Adjust the prefilled eval box before copying an eval', 'warning');
                return;
            }
            try {
                const payload = events.invoke('artisan.local.exportEvalCase', {
                    target,
                    includeReview: false,
                    primarySelection: 'target_bounded_posterior'
                }) as { ok?: boolean; error?: string } | null;
                if (payload?.ok) {
                    const copied = await copyJson(payload);
                    events.fire('toast', copied ? 'Copied Artisan click eval case' : 'Could not copy Artisan eval case', copied ? 'info' : 'warning');
                    return;
                }
            } catch {
                // Artisan eval export is optional; fall back to Boxer below.
            }

            await events.invoke('boxer.copyEvalCase', target);
        });
        const resizeFromLowSide = (axis: 'x' | 'y' | 'z', nextLength: number) => {
            markTouched();
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
            queueSelectionRefresh();
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
                markTouched();
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
            events.function('boxSelection.confirmEvalTarget', confirmEvalTarget);
        } catch (err) {
            console.warn('[BoxSelection] boxSelection.confirmEvalTarget was already registered', err);
        }

        try {
            events.function('boxSelection.setCurrentBoxTarget', setCurrentBoxTarget);
        } catch (err) {
            console.warn('[BoxSelection] boxSelection.setCurrentBoxTarget was already registered', err);
        }

        try {
            events.function('boxSelection.hasCurrentBox', () => {
                return currentBox().ready;
            });
        } catch (err) {
            console.warn('[BoxSelection] boxSelection.hasCurrentBox was already registered', err);
        }

        try {
            events.function('boxSelection.state', () => {
                const target = currentBox();
                return {
                    active: this.active,
                    touched,
                    confirmed: target.confirmed,
                    confirmed_at: target.confirmed_at,
                    confirmation_attempted_at: target.confirmation_attempted_at,
                    changed_from_initial: target.changed_from_initial,
                    ready: target.ready,
                    updated_at: updatedAt,
                    target
                };
            });
        } catch (err) {
            console.warn('[BoxSelection] boxSelection.state was already registered', err);
        }

        try {
            // seed the manual box from an external source (eval case editor)
            events.function('boxSelection.setBox', (next: { center: [number, number, number]; dimensions: [number, number, number] }) => {
                suppressUserEditTracking = true;
                box.pivot.setPosition(new Vec3(next.center[0], next.center[1], next.center[2]));
                box.lenX = Math.max(0.01, next.dimensions[0]);
                box.lenY = Math.max(0.01, next.dimensions[1]);
                box.lenZ = Math.max(0.01, next.dimensions[2]);
                lenX.value = box.lenX;
                lenY.value = box.lenY;
                lenZ.value = box.lenZ;
                box.moved();
                suppressUserEditTracking = false;
                synthetic = false;
                touched = true;
                updatedAt = new Date().toISOString();
                if (this.active) {
                    attachActiveGizmo();
                    queueSelectionRefresh(true);
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
            cancelSelectionRefresh();
            cancelActiveDrag();
            selectToolbar.hidden = true;
            gizmo.detach();
            scene.remove(box);
            this.active = false;
            syncFaceHandleVisibility(false, gizmoMode);
        };
    }
}

export { BoxSelection };
