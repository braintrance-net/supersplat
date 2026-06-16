import { Button, Container, NumericInput } from '@playcanvas/pcui';
import { Color, Ray, TranslateGizmo, Vec3 } from 'playcanvas';

import { BoxShape } from '../box-shape';
import { BoxVolumeShape, type BoxVolumeDebugSnapshot } from '../box-volume-shape';
import { Events } from '../events';
import { Scene } from '../scene';
import { createScreenMath, getActiveCollisionSurface, waitForCollisionSurface } from '../utils/collision-surface';

type Phase = 'idle' | 'width' | 'depth' | 'height' | 'placed';
type EditMode = 'move' | 'resize';
type Axis = 0 | 1 | 2;
type FaceHandle = { axis: Axis; sign: 1 | -1 };
type ResizeHandle = { faces: FaceHandle[]; dom: HTMLDivElement };

const MIN_EXTENT = 0.02;
const CLICK_MOVE_TOLERANCE_PX = 7;

const ray = new Ray();
const planeNormal = new Vec3();
const planePoint = new Vec3();
const hitPoint = new Vec3();
const perp = new Vec3();
const segA = new Vec3();
const segB = new Vec3();
const camPos = new Vec3();
const wireColor = new Color(0.35, 0.95, 1, 1);
const DEBUG_FACE_INDICES = [
    [0, 1, 2, 3],
    [4, 7, 6, 5],
    [0, 4, 5, 1],
    [1, 5, 6, 2],
    [2, 6, 7, 3],
    [3, 7, 4, 0]
] as const;
const DEBUG_FACE_LABELS = ['bottom', 'top', 'depth-', 'width+', 'depth+', 'width-'];

const rayPlane = (origin: Vec3, dir: Vec3, point: Vec3, normal: Vec3, out: Vec3) => {
    const denom = normal.dot(dir);
    if (Math.abs(denom) < 1e-6) return false;
    const t = (normal.dot(point) - normal.dot(origin)) / denom;
    if (!Number.isFinite(t)) return false;
    out.copy(dir).mulScalar(t).add(origin);
    return true;
};

const roundDebug = (value: number) => Number(value.toFixed(4));

const polygonArea = (points: [number, number][]) => {
    let area = 0;
    for (let i = 0; i < points.length; i++) {
        const next = (i + 1) % points.length;
        area += points[i][0] * points[next][1] - points[next][0] * points[i][1];
    }
    return Math.abs(area) * 0.5;
};

class BoxVolumeTool {
    activate: () => void;
    deactivate: () => void;

    constructor(events: Events, scene: Scene, canvasContainer: Container) {
        const box = new BoxShape();
        const volumeShape = new BoxVolumeShape();
        const gizmo = new TranslateGizmo(scene.camera.camera, scene.gizmoLayer);

        let active = false;
        let phase: Phase = 'idle';
        let boxAdded = false;
        let clicked = false;
        let busy = false;
        let clickCandidate: { pointerId: number; startClient: [number, number] } | null = null;
        let hasWidth = false;
        let editMode: EditMode = 'resize';
        let activeDrag: {
            handle: ResizeHandle;
            pointerId: number;
            startClient: [number, number];
            lockedFace: FaceHandle | null;
        } | null = null;

        const corner = new Vec3();
        const widthDir = new Vec3(1, 0, 0);
        const center = new Vec3();
        const axisX = new Vec3(1, 0, 0);
        const axisY = new Vec3(0, 1, 0);
        const axisZ = new Vec3(0, 0, 1);
        let widthLen = MIN_EXTENT;
        let depthLen = MIN_EXTENT;
        let heightLen = MIN_EXTENT;
        let lastDebugSignature = '';
        let lastDebugLogAt = 0;
        let debugEnabled = localStorage.getItem('boxVolumeDebugAuto') === '1';
        let syncingInputs = false;
        let selectionRefreshQueued = false;
        let selectionRefreshInFlight = false;
        let selectionRefreshFrame: number | null = null;
        const resizeHandles: ResizeHandle[] = [];

        const depthAxis = (out: Vec3) => out.set(widthDir.z, 0, -widthDir.x);
        const screenMath = createScreenMath(scene);

        gizmo.on('render:update', () => {
            scene.forceRender = true;
        });
        gizmo.on('transform:move', () => {
            syncBoxFromPivot();
            queueSelectionRefresh();
        });
        gizmo.on('transform:end', () => {
            syncBoxFromPivot();
            queueSelectionRefresh(true);
        });

        const overlaySvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        overlaySvg.style.cssText = [
            'position:absolute',
            'inset:0',
            'z-index:54',
            'pointer-events:none',
            'overflow:visible',
            'display:none'
        ].join(';');
        const faceGroup = document.createElementNS(overlaySvg.namespaceURI, 'g');
        const edgeGroup = document.createElementNS(overlaySvg.namespaceURI, 'g');
        overlaySvg.append(faceGroup, edgeGroup);
        canvasContainer.dom.appendChild(overlaySvg);

        const selectToolbar = new Container({ class: 'select-toolbar', hidden: true });
        selectToolbar.dom.addEventListener('pointerdown', e => e.stopPropagation());

        const moveModeButton = new Button({ text: 'Move', class: 'select-toolbar-button' });
        const resizeModeButton = new Button({ text: 'Resize', class: 'select-toolbar-button' });
        const setButton = new Button({ text: 'Set', class: 'select-toolbar-button' });
        const addButton = new Button({ text: 'Add', class: 'select-toolbar-button' });
        const removeButton = new Button({ text: 'Remove', class: 'select-toolbar-button' });
        const saveTargetButton = new Button({ text: 'Save Target', class: 'select-toolbar-button' });
        const copyEvalButton = new Button({ text: 'Copy Click Eval', class: 'select-toolbar-button' });

        const lenX = new NumericInput({ precision: 2, value: widthLen, placeholder: 'Width', width: 80, min: MIN_EXTENT });
        const lenY = new NumericInput({ precision: 2, value: heightLen, placeholder: 'Height', width: 80, min: MIN_EXTENT });
        const lenZ = new NumericInput({ precision: 2, value: Math.abs(depthLen), placeholder: 'Depth', width: 80, min: MIN_EXTENT });

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
            depthAxis(perp);
            const sign = depthLen >= 0 ? 1 : -1;
            return {
                type: 'axis_aligned_box' as const,
                center: [center.x, center.y, center.z] as [number, number, number],
                dimensions: [
                    Math.max(MIN_EXTENT, widthLen),
                    Math.max(MIN_EXTENT, heightLen),
                    Math.max(MIN_EXTENT, Math.abs(depthLen))
                ] as [number, number, number],
                rotation: [
                    [widthDir.x, 0, widthDir.z],
                    [0, 1, 0],
                    [perp.x * sign, 0, perp.z * sign]
                ]
            };
        };

        const selectCurrentBox = (op: 'set' | 'add' | 'remove' = 'set', live = false) => {
            const obb = currentBox();
            return events.invoke(live ? 'select.byOBBLiveNow' : 'select.byOBBNow', op, {
                center: obb.center,
                dimensions: obb.dimensions,
                rotation: obb.rotation
            }) as Promise<unknown>;
        };

        const applySelection = (op: 'set' | 'add' | 'remove') => {
            selectCurrentBox(op).catch((err) => {
                console.warn('[BoxVolume] selection apply failed', err);
            });
        };

        async function runSelectionRefresh() {
            if (!active || phase !== 'placed' || !boxAdded) {
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
                console.warn('[BoxVolume] live selection refresh failed', err);
            } finally {
                selectionRefreshInFlight = false;
                if (selectionRefreshQueued && active && phase === 'placed' && boxAdded) {
                    queueSelectionRefresh();
                }
            }
        }

        function queueSelectionRefresh(immediate = false) {
            if (!active || phase !== 'placed' || !boxAdded) {
                return;
            }
            selectionRefreshQueued = true;
            if (immediate) {
                if (selectionRefreshFrame !== null) {
                    window.cancelAnimationFrame(selectionRefreshFrame);
                    selectionRefreshFrame = null;
                }
                runSelectionRefresh().catch((err) => {
                    console.warn('[BoxVolume] live selection refresh failed', err);
                });
                return;
            }
            if (selectionRefreshFrame !== null || selectionRefreshInFlight) {
                return;
            }
            selectionRefreshFrame = window.requestAnimationFrame(() => {
                selectionRefreshFrame = null;
                runSelectionRefresh().catch((err) => {
                    console.warn('[BoxVolume] live selection refresh failed', err);
                });
            });
        }

        function syncBoxFromPivot() {
            center.copy(box.pivot.getPosition());
            box.moved();
            syncCornerFromCenter();
            updateVolumeShape();
            updateOverlay();
            updateResizeHandles();
            scene.forceRender = true;
        }

        const syncNumericInput = (input: NumericInput, value: number) => {
            if (Math.abs(input.value - value) > 1e-6) {
                input.value = value;
            }
        };

        const syncInputs = () => {
            syncingInputs = true;
            try {
                syncNumericInput(lenX, Math.max(MIN_EXTENT, widthLen));
                syncNumericInput(lenY, Math.max(MIN_EXTENT, heightLen));
                syncNumericInput(lenZ, Math.max(MIN_EXTENT, Math.abs(depthLen)));
            } finally {
                syncingInputs = false;
            }
        };

        const syncEditMode = () => {
            moveModeButton.dom.style.opacity = editMode === 'move' ? '1' : '0.55';
            resizeModeButton.dom.style.opacity = editMode === 'resize' ? '1' : '0.55';
            if (phase === 'placed') {
                gizmo.attach([box.pivot]);
            } else {
                gizmo.detach();
            }
            updateResizeHandles();
            scene.forceRender = true;
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
        moveModeButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            editMode = 'move';
            syncEditMode();
        });
        resizeModeButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            editMode = 'resize';
            syncEditMode();
        });

        setButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            applySelection('set');
        });
        addButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            applySelection('add');
        });
        removeButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            applySelection('remove');
        });
        saveTargetButton.dom.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
            events.invoke('boxer.setStickyEvalTarget', currentBox());
            events.fire('toast', 'Saved box-volume target for Boxer evals', 'info');
        });
        copyEvalButton.dom.addEventListener('pointerdown', async (e) => {
            e.stopPropagation();
            await events.invoke('boxer.copyEvalCase', currentBox());
        });

        lenX.on('change', () => {
            if (syncingInputs) return;
            widthLen = Math.max(MIN_EXTENT, lenX.value);
            updateBox();
        });
        lenY.on('change', () => {
            if (syncingInputs) return;
            heightLen = Math.max(MIN_EXTENT, lenY.value);
            updateBox();
        });
        lenZ.on('change', () => {
            if (syncingInputs) return;
            const sign = depthLen >= 0 ? 1 : -1;
            depthLen = sign * Math.max(MIN_EXTENT, lenZ.value);
            updateBox();
        });

        const buildPickRay = (nx: number, ny: number) => {
            const device = scene.graphicsDevice;
            scene.camera.getRay(nx * device.width, ny * device.height, ray);
        };

        const pickCollisionSurface = (nx: number, ny: number) => {
            const surface = getActiveCollisionSurface();
            if (!surface) return null;
            buildPickRay(nx, ny);
            const hit = surface.raycastWorld(
                [ray.origin.x, ray.origin.y, ray.origin.z],
                [ray.direction.x, ray.direction.y, ray.direction.z]
            );
            return hit ? new Vec3(hit.point[0], hit.point[1], hit.point[2]) : null;
        };

        const pickSurface = async (nx: number, ny: number) => {
            try {
                const surfaceHit = pickCollisionSurface(nx, ny);
                if (surfaceHit) return surfaceHit;
            } catch (err) {
                console.warn('[BoxVolume] collision surface pick failed, using splat depth pick', err);
            }
            const result = await scene.camera.intersect(nx, ny);
            return result ? result.position.clone() : null;
        };

        const pickBasePlane = (nx: number, ny: number) => {
            buildPickRay(nx, ny);
            planeNormal.set(0, 1, 0);
            planePoint.copy(corner);
            return rayPlane(ray.origin, ray.direction, planePoint, planeNormal, hitPoint);
        };

        function updateBox() {
            depthAxis(perp);
            center.set(
                corner.x + widthDir.x * widthLen * 0.5 + perp.x * depthLen * 0.5,
                corner.y + heightLen * 0.5,
                corner.z + widthDir.z * widthLen * 0.5 + perp.z * depthLen * 0.5
            );
            box.pivot.setPosition(center);
            box.lenX = Math.max(MIN_EXTENT, widthLen);
            box.lenY = Math.max(MIN_EXTENT, heightLen);
            box.lenZ = Math.max(MIN_EXTENT, Math.abs(depthLen));
            box.moved();
            syncInputs();
            syncCornerFromCenter();
            updateVolumeShape();
            updateOverlay();
            updateResizeHandles();
            if (phase === 'placed') {
                queueSelectionRefresh();
            }
            scene.forceRender = true;
        }

        const boxCorners = () => {
            depthAxis(perp);
            const ax = corner.x;
            const ay = corner.y;
            const az = corner.z;
            const wx = widthDir.x * widthLen;
            const wz = widthDir.z * widthLen;
            const dx = perp.x * depthLen;
            const dz = perp.z * depthLen;
            const h = heightLen;
            return [
                [ax, ay, az],
                [ax + wx, ay, az + wz],
                [ax + wx + dx, ay, az + wz + dz],
                [ax + dx, ay, az + dz],
                [ax, ay + h, az],
                [ax + wx, ay + h, az + wz],
                [ax + wx + dx, ay + h, az + wz + dz],
                [ax + dx, ay + h, az + dz]
            ] as [number, number, number][];
        };

        const readRendererInfo = () => {
            const canvas = scene.canvas;
            const gl = canvas && (canvas.getContext('webgl2') || canvas.getContext('webgl'));
            const ext = gl?.getExtension('WEBGL_debug_renderer_info');
            return {
                renderer: gl && ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string : null,
                vendor: gl && ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) as string : null,
                canvasSize: [canvas?.width ?? null, canvas?.height ?? null],
                canvasClientSize: [canvas?.clientWidth ?? null, canvas?.clientHeight ?? null]
            };
        };

        const projectedFaceDebug = () => {
            const model = screenMath.pinhole();
            if (!model) return null;
            const rect = canvasContainer.dom.getBoundingClientRect();
            const corners = boxCorners();
            const projected = corners.map(point => screenMath.projectToClient(model, point));
            if (projected.some(point => !point)) return null;
            const pts = projected.map(point => [point![0] - rect.left, point![1] - rect.top] as [number, number]);

            return DEBUG_FACE_INDICES.map((indices, faceIndex) => {
                const points = indices.map(index => pts[index]);
                const xs = points.map(point => point[0]);
                const ys = points.map(point => point[1]);
                return {
                    faceIndex,
                    label: DEBUG_FACE_LABELS[faceIndex],
                    areaPx: roundDebug(polygonArea(points)),
                    bbox: [
                        roundDebug(Math.min(...xs)),
                        roundDebug(Math.min(...ys)),
                        roundDebug(Math.max(...xs)),
                        roundDebug(Math.max(...ys))
                    ],
                    points: points.map(point => [roundDebug(point[0]), roundDebug(point[1])])
                };
            });
        };

        const buildBoxVolumeDebugSnapshot = (reason = 'manual') => {
            const rect = canvasContainer.dom.getBoundingClientRect();
            const overlayFaces = overlaySvg.querySelectorAll('[data-face-index], [data-face-depth], polygon').length;
            const overlayEdges = overlaySvg.querySelectorAll('line').length;
            const visibleHandles = resizeHandles.filter(handle => handle.dom.style.display !== 'none').length;
            const shapeSnapshot = volumeShape.getDebugSnapshot() as BoxVolumeDebugSnapshot | null;

            return {
                reason,
                timestamp: new Date().toISOString(),
                active,
                phase,
                editMode,
                boxAdded,
                dimensions: {
                    width: roundDebug(widthLen),
                    height: roundDebug(heightLen),
                    depthSigned: roundDebug(depthLen),
                    depthAbs: roundDebug(Math.abs(depthLen))
                },
                corner: [roundDebug(corner.x), roundDebug(corner.y), roundDebug(corner.z)],
                center: [roundDebug(center.x), roundDebug(center.y), roundDebug(center.z)],
                axes: {
                    widthDir: [roundDebug(widthDir.x), roundDebug(widthDir.y), roundDebug(widthDir.z)],
                    y: [0, 1, 0],
                    depth: localAxis(2).map(roundDebug)
                },
                camera: {
                    position: [
                        roundDebug(scene.camera.mainCamera.getPosition().x),
                        roundDebug(scene.camera.mainCamera.getPosition().y),
                        roundDebug(scene.camera.mainCamera.getPosition().z)
                    ],
                    target: [
                        roundDebug(scene.camera.focalPoint.x),
                        roundDebug(scene.camera.focalPoint.y),
                        roundDebug(scene.camera.focalPoint.z)
                    ],
                    ortho: scene.camera.ortho
                },
                renderer: readRendererInfo(),
                overlay: {
                    svgDisplay: overlaySvg.style.display,
                    faceCount: overlayFaces,
                    edgeCount: overlayEdges,
                    visibleHandles,
                    containerRect: {
                        left: roundDebug(rect.left),
                        top: roundDebug(rect.top),
                        width: roundDebug(rect.width),
                        height: roundDebug(rect.height)
                    }
                },
                shape: shapeSnapshot,
                projectedFaces: projectedFaceDebug(),
                diagnosisHints: {
                    nearFacesShouldBeTransparent: shapeSnapshot?.nearFaces ?? [],
                    farFacesShouldBeOpaque: shapeSnapshot?.farFaces ?? [],
                    expectedNearCount: 3,
                    expectedFarCount: 3,
                    svgShouldNotContainFaces: overlayFaces === 0,
                    compositeCanStillLookOpaque: shapeSnapshot?.compositeRisk ?? null
                }
            };
        };

        const printBoxVolumeDebug = (reason = 'manual') => {
            const snapshot = buildBoxVolumeDebugSnapshot(reason);
            (window as any).__lastBoxVolumeDebug = snapshot;
            console.groupCollapsed(`[BoxVolumeDebug] ${reason} phase=${phase}`);
            console.log(snapshot);
            if (snapshot.shape?.faces) {
                console.table(snapshot.shape.faces.map(face => ({
                    face: `${face.faceIndex}:${face.label}`,
                    relation: face.relation,
                    opacity: face.material.opacity,
                    blendType: face.material.blendType,
                    depthWrite: face.material.depthWrite,
                    depthTest: face.material.depthTest,
                    drawOrder: face.material.drawOrder,
                    sideDot: face.sideDot,
                    distanceToCamera: face.distanceToCamera
                })));
            }
            if (snapshot.shape?.compositeRisk) {
                console.table([snapshot.shape.compositeRisk]);
            }
            if (snapshot.projectedFaces) {
                console.table(snapshot.projectedFaces.map(face => ({
                    face: `${face.faceIndex}:${face.label}`,
                    areaPx: face.areaPx,
                    bbox: face.bbox.join(', ')
                })));
            }
            console.groupEnd();
            return snapshot;
        };

        const maybePrintBoxVolumeDebug = (reason: string) => {
            if (!debugEnabled || !boxAdded || (phase !== 'height' && phase !== 'placed')) return;
            const shapeSnapshot = volumeShape.getDebugSnapshot();
            const signature = JSON.stringify({
                phase,
                editMode,
                near: shapeSnapshot?.nearFaces,
                far: shapeSnapshot?.farFaces,
                opacity: shapeSnapshot?.faces.map(face => face.material.opacity),
                drawOrder: shapeSnapshot?.faces.map(face => face.material.drawOrder),
                camera: buildBoxVolumeDebugSnapshot(reason).camera.position
            });
            const now = performance.now();
            if (signature !== lastDebugSignature || now - lastDebugLogAt > 1500) {
                lastDebugSignature = signature;
                lastDebugLogAt = now;
                printBoxVolumeDebug(reason);
            }
        };

        (window as any).__boxVolumeDebug = {
            snapshot: buildBoxVolumeDebugSnapshot,
            print: printBoxVolumeDebug,
            enableAuto: () => {
                debugEnabled = true;
                localStorage.setItem('boxVolumeDebugAuto', '1');
                return printBoxVolumeDebug('auto-enabled');
            },
            disableAuto: () => {
                debugEnabled = false;
                localStorage.setItem('boxVolumeDebug', '0');
                localStorage.setItem('boxVolumeDebugAuto', '0');
                return buildBoxVolumeDebugSnapshot('auto-disabled');
            }
        };
        console.info('[BoxVolumeDebug] installed: window.__boxVolumeDebug.print() / .snapshot() / .enableAuto() / .disableAuto()');

        function updateVolumeShape() {
            if (!boxAdded || (phase !== 'height' && phase !== 'placed')) {
                volumeShape.setVisible(false);
                return;
            }
            axisX.copy(widthDir);
            axisY.set(0, 1, 0);
            const axis = localAxis(2);
            axisZ.set(axis[0], axis[1], axis[2]);
            volumeShape.setVisible(true);
            volumeShape.update(boxCorners(), [axisX, axisY, axisZ], center, scene.camera.mainCamera.getPosition());
        }

        function localAxis(axis: Axis): [number, number, number] {
            if (axis === 0) return [widthDir.x, 0, widthDir.z];
            if (axis === 1) return [0, 1, 0];
            depthAxis(perp);
            const sign = depthLen >= 0 ? 1 : -1;
            return [perp.x * sign, 0, perp.z * sign];
        }

        const lenForAxis = (axis: Axis) => {
            if (axis === 0) return widthLen;
            if (axis === 1) return heightLen;
            return Math.abs(depthLen);
        };

        const setLenForAxis = (axis: Axis, value: number) => {
            const next = Math.max(MIN_EXTENT, value);
            if (axis === 0) widthLen = next;
            else if (axis === 1) heightLen = next;
            else depthLen = (depthLen >= 0 ? 1 : -1) * next;
        };

        const applyFaceOffset = (face: FaceHandle, offset: number) => {
            const oldLength = lenForAxis(face.axis);
            const nextLength = Math.max(MIN_EXTENT, oldLength + face.sign * offset);
            const delta = nextLength - oldLength;
            setLenForAxis(face.axis, nextLength);
            const axis = localAxis(face.axis);
            center.set(
                center.x + axis[0] * face.sign * delta * 0.5,
                center.y + axis[1] * face.sign * delta * 0.5,
                center.z + axis[2] * face.sign * delta * 0.5
            );
            syncCornerFromCenter();
            updateBox();
        };

        function updateOverlay() {
            if (!active || (phase !== 'height' && phase !== 'placed')) {
                overlaySvg.style.display = 'none';
                return;
            }
            const model = screenMath.pinhole();
            if (!model) {
                overlaySvg.style.display = 'none';
                return;
            }
            const rect = canvasContainer.dom.getBoundingClientRect();
            overlaySvg.style.display = '';
            overlaySvg.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
            overlaySvg.setAttribute('width', `${rect.width}`);
            overlaySvg.setAttribute('height', `${rect.height}`);

            const corners = boxCorners();
            const projected = corners.map(point => screenMath.projectToClient(model, point));
            if (projected.some(point => !point)) {
                overlaySvg.style.display = 'none';
                return;
            }
            const pts = projected.map(point => [point![0] - rect.left, point![1] - rect.top] as [number, number]);
            faceGroup.replaceChildren();
            edgeGroup.replaceChildren();
            const edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
            for (const [a, b] of edges) {
                const line = document.createElementNS(overlaySvg.namespaceURI, 'line');
                line.setAttribute('x1', pts[a][0].toFixed(1));
                line.setAttribute('y1', pts[a][1].toFixed(1));
                line.setAttribute('x2', pts[b][0].toFixed(1));
                line.setAttribute('y2', pts[b][1].toFixed(1));
                line.setAttribute('stroke', '#d9fbff');
                line.setAttribute('stroke-width', '4.5');
                line.setAttribute('stroke-linecap', 'round');
                edgeGroup.appendChild(line);
            }
        }

        const handleAnchorWorld = (handle: ResizeHandle): [number, number, number] => {
            const result: [number, number, number] = [center.x, center.y, center.z];
            for (const face of handle.faces) {
                const axis = localAxis(face.axis);
                const half = lenForAxis(face.axis) * 0.5 * face.sign;
                result[0] += axis[0] * half;
                result[1] += axis[1] * half;
                result[2] += axis[2] * half;
            }
            return result;
        };

        function updateResizeHandles() {
            const visible = active && phase === 'placed' && editMode === 'resize';
            const model = visible ? screenMath.pinhole() : null;
            const rect = canvasContainer.dom.getBoundingClientRect();
            for (const handle of resizeHandles) {
                if (!visible || !model) {
                    handle.dom.style.display = 'none';
                    continue;
                }
                const projected = screenMath.projectToClient(model, handleAnchorWorld(handle));
                if (!projected) {
                    handle.dom.style.display = 'none';
                    continue;
                }
                handle.dom.style.display = 'block';
                handle.dom.style.left = `${projected[0] - rect.left}px`;
                handle.dom.style.top = `${projected[1] - rect.top}px`;
            }
        }

        const resolveEdgeLock = (handle: ResizeHandle, clientX: number, clientY: number) => {
            if (!activeDrag) return null;
            const model = screenMath.pinhole();
            if (!model) return null;
            const deltaX = clientX - activeDrag.startClient[0];
            const deltaY = clientY - activeDrag.startClient[1];
            if (Math.hypot(deltaX, deltaY) < 8) return null;
            const anchor = handleAnchorWorld(handle);
            const anchorScreen = screenMath.projectToClient(model, anchor);
            if (!anchorScreen) return null;
            let best: { face: FaceHandle; score: number } | null = null;
            for (const face of handle.faces) {
                const axis = localAxis(face.axis);
                const offset: [number, number, number] = [
                    anchor[0] + axis[0] * Math.max(0.2, lenForAxis(face.axis) * 0.25),
                    anchor[1] + axis[1] * Math.max(0.2, lenForAxis(face.axis) * 0.25),
                    anchor[2] + axis[2] * Math.max(0.2, lenForAxis(face.axis) * 0.25)
                ];
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
            const face = handle.faces.length === 1 ?
                handle.faces[0] :
                (activeDrag?.lockedFace ?? resolveEdgeLock(handle, clientX, clientY));
            if (!face) return;
            if (activeDrag && !activeDrag.lockedFace && handle.faces.length > 1) {
                activeDrag.lockedFace = face;
            }

            const axis = localAxis(face.axis);
            const anchor = handleAnchorWorld({ faces: [face], dom: handle.dom });
            const anchorScreen = screenMath.projectToClient(model, anchor);
            const offsetScreen = screenMath.projectToClient(model, [
                anchor[0] + axis[0] * Math.max(0.25, lenForAxis(face.axis) * 0.25),
                anchor[1] + axis[1] * Math.max(0.25, lenForAxis(face.axis) * 0.25),
                anchor[2] + axis[2] * Math.max(0.25, lenForAxis(face.axis) * 0.25)
            ]);
            if (!anchorScreen || !offsetScreen) return;
            const ax = offsetScreen[0] - anchorScreen[0];
            const ay = offsetScreen[1] - anchorScreen[1];
            const axisPixels = Math.hypot(ax, ay);
            if (axisPixels < 1) return;
            const dx = clientX - anchorScreen[0];
            const dy = clientY - anchorScreen[1];
            const worldScale = Math.max(0.25, lenForAxis(face.axis) * 0.25) / axisPixels;
            const offset = (dx * ax + dy * ay) / axisPixels * worldScale;
            applyFaceOffset(face, offset);
        };

        const createResizeHandle = (faces: FaceHandle[]) => {
            const dom = document.createElement('div');
            const isFace = faces.length === 1;
            const size = isFace ? 14 : 11;
            dom.style.cssText = [
                'position:absolute',
                `width:${size}px`,
                `height:${size}px`,
                `margin:${-size / 2}px 0 0 ${-size / 2}px`,
                'border-radius:50%',
                `background:${isFace ? '#5edcff' : '#ffffff'}`,
                'border:2px solid rgba(20,22,25,0.9)',
                'box-shadow:0 1px 5px rgba(0,0,0,0.55)',
                'cursor:grab',
                'pointer-events:auto',
                'z-index:65',
                'display:none'
            ].join(';');
            const handle: ResizeHandle = { faces, dom };
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
            };
            const lostPointerCapture = (event: PointerEvent) => {
                if (!activeDrag || activeDrag.pointerId !== event.pointerId) return;
                activeDrag = null;
                dom.style.cursor = 'grab';
            };
            dom.addEventListener('pointerup', endDrag);
            dom.addEventListener('pointercancel', endDrag);
            dom.addEventListener('lostpointercapture', lostPointerCapture);
            resizeHandles.push(handle);
            canvasContainer.dom.appendChild(dom);
        };

        for (const axis of [0, 1, 2] as const) {
            for (const sign of [1, -1] as const) {
                createResizeHandle([{ axis, sign }]);
            }
        }
        for (const freeAxis of [0, 1, 2] as const) {
            const axes = [0, 1, 2].filter(axis => axis !== freeAxis) as Axis[];
            for (const signA of [1, -1] as const) {
                for (const signB of [1, -1] as const) {
                    createResizeHandle([{ axis: axes[0], sign: signA }, { axis: axes[1], sign: signB }]);
                }
            }
        }
        syncEditMode();
        scene.app.on('update', () => {
            updateVolumeShape();
            updateOverlay();
            updateResizeHandles();
        });

        const previewWidth = (nx: number, ny: number) => {
            if (!pickBasePlane(nx, ny)) return;
            const dx = hitPoint.x - corner.x;
            const dz = hitPoint.z - corner.z;
            const len = Math.hypot(dx, dz);
            if (len > 1e-4) {
                widthDir.set(dx / len, 0, dz / len);
                widthLen = Math.max(MIN_EXTENT, len);
                hasWidth = true;
                syncInputs();
            }
            scene.forceRender = true;
        };

        const previewDepth = (nx: number, ny: number) => {
            if (!pickBasePlane(nx, ny)) return;
            depthAxis(perp);
            const dx = hitPoint.x - corner.x;
            const dz = hitPoint.z - corner.z;
            const proj = dx * perp.x + dz * perp.z;
            depthLen = Math.abs(proj) < MIN_EXTENT ? (proj < 0 ? -MIN_EXTENT : MIN_EXTENT) : proj;
            if (boxAdded) updateBox();
            else syncInputs();
            scene.forceRender = true;
        };

        const previewHeight = (nx: number, ny: number) => {
            buildPickRay(nx, ny);
            planeNormal.set(ray.direction.x, 0, ray.direction.z);
            if (planeNormal.length() < 1e-4) return;
            planeNormal.normalize();
            planePoint.set(center.x, corner.y, center.z);
            if (!rayPlane(ray.origin, ray.direction, planePoint, planeNormal, hitPoint)) return;
            heightLen = Math.max(MIN_EXTENT, hitPoint.y - corner.y);
            updateBox();
        };

        const drawSeg = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
            segA.set(ax, ay, az);
            segB.set(bx, by, bz);
            scene.app.drawLine(segA, segB, wireColor, false, scene.worldLayer);
        };

        const drawFootprint = (y: number, yTop?: number) => {
            depthAxis(perp);
            const ax = corner.x;
            const az = corner.z;
            const wx = widthDir.x * widthLen;
            const wz = widthDir.z * widthLen;
            const dx = perp.x * depthLen;
            const dz = perp.z * depthLen;
            const ax0 = ax;
            const az0 = az;
            const bx = ax + wx;
            const bz = az + wz;
            const cx = ax + wx + dx;
            const cz = az + wz + dz;
            const dx0 = ax + dx;
            const dz0 = az + dz;
            drawSeg(ax0, y, az0, bx, y, bz);
            drawSeg(bx, y, bz, cx, y, cz);
            drawSeg(cx, y, cz, dx0, y, dz0);
            drawSeg(dx0, y, dz0, ax0, y, az0);
            if (yTop !== undefined) {
                drawSeg(ax0, yTop, az0, bx, yTop, bz);
                drawSeg(bx, yTop, bz, cx, yTop, cz);
                drawSeg(cx, yTop, cz, dx0, yTop, dz0);
                drawSeg(dx0, yTop, dz0, ax0, yTop, az0);
                drawSeg(ax0, y, az0, ax0, yTop, az0);
                drawSeg(bx, y, bz, bx, yTop, bz);
                drawSeg(cx, y, cz, cx, yTop, cz);
                drawSeg(dx0, y, dz0, dx0, yTop, dz0);
            }
        };

        const drawConstruction = () => {
            if (!active) return;
            if (phase === 'width') {
                camPos.copy(scene.camera.mainCamera.getPosition());
                const s = Math.max(MIN_EXTENT, corner.distance(camPos) * 0.012);
                drawSeg(corner.x - s, corner.y, corner.z, corner.x + s, corner.y, corner.z);
                drawSeg(corner.x, corner.y - s, corner.z, corner.x, corner.y + s, corner.z);
                drawSeg(corner.x, corner.y, corner.z - s, corner.x, corner.y, corner.z + s);
                if (hasWidth) {
                    drawSeg(corner.x, corner.y, corner.z, corner.x + widthDir.x * widthLen, corner.y, corner.z + widthDir.z * widthLen);
                }
                scene.forceRender = true;
            } else if (phase === 'depth') {
                drawFootprint(corner.y);
                scene.forceRender = true;
            } else if (phase === 'height') {
                const baseY = center.y - heightLen * 0.5;
                drawFootprint(baseY, baseY + heightLen);
                scene.forceRender = true;
            }
        };
        scene.app.on('update', drawConstruction);

        function syncCornerFromCenter() {
            depthAxis(perp);
            corner.set(
                center.x - widthDir.x * widthLen * 0.5 - perp.x * depthLen * 0.5,
                center.y - heightLen * 0.5,
                center.z - widthDir.z * widthLen * 0.5 - perp.z * depthLen * 0.5
            );
        }

        const isPrimary = (e: PointerEvent) => (e.pointerType === 'mouse' ? e.button === 0 : e.isPrimary);
        const localCoords = (e: PointerEvent) => {
            const rect = canvasContainer.dom.getBoundingClientRect();
            return {
                nx: Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width))),
                ny: Math.max(0, Math.min(1, (e.clientY - rect.top) / Math.max(1, rect.height)))
            };
        };

        const pointerdown = (e: PointerEvent) => {
            if (!clicked && isPrimary(e)) {
                e.preventDefault();
                e.stopPropagation();
                clicked = true;
                clickCandidate = {
                    pointerId: e.pointerId,
                    startClient: [e.clientX, e.clientY]
                };
            }
        };

        const pointermove = (e: PointerEvent) => {
            if (clickCandidate && e.pointerId === clickCandidate.pointerId) {
                const moved = Math.hypot(
                    e.clientX - clickCandidate.startClient[0],
                    e.clientY - clickCandidate.startClient[1]
                );
                if (moved > CLICK_MOVE_TOLERANCE_PX) {
                    clicked = false;
                }
            }
            if (e.buttons !== 0) return;
            const { nx, ny } = localCoords(e);
            if (phase === 'width') previewWidth(nx, ny);
            else if (phase === 'depth') previewDepth(nx, ny);
            else if (phase === 'height') previewHeight(nx, ny);
        };

        const pointerup = async (e: PointerEvent) => {
            if (!clicked || !isPrimary(e) || busy || clickCandidate?.pointerId !== e.pointerId) {
                if (clickCandidate?.pointerId === e.pointerId) {
                    clicked = false;
                    clickCandidate = null;
                }
                return;
            }
            clicked = false;
            clickCandidate = null;
            const { nx, ny } = localCoords(e);

            if (phase === 'idle') {
                busy = true;
                const hit = await pickSurface(nx, ny);
                busy = false;
                if (!hit) return;
                corner.copy(hit);
                widthDir.set(1, 0, 0);
                widthLen = MIN_EXTENT;
                depthLen = MIN_EXTENT;
                heightLen = MIN_EXTENT;
                hasWidth = false;
                phase = 'width';
            } else if (phase === 'width') {
                previewWidth(nx, ny);
                phase = 'depth';
            } else if (phase === 'depth') {
                previewDepth(nx, ny);
                heightLen = MIN_EXTENT;
                if (!boxAdded) {
                    scene.add(box);
                    scene.add(volumeShape);
                    boxAdded = true;
                    const render = (box.pivot as any).render;
                    if (render) render.enabled = false;
                }
                updateBox();
                phase = 'height';
            } else if (phase === 'height') {
                previewHeight(nx, ny);
                phase = 'placed';
                editMode = 'resize';
                syncEditMode();
                selectToolbar.hidden = false;
                syncInputs();
                updateOverlay();
                updateResizeHandles();
                queueSelectionRefresh(true);
            } else {
                return;
            }

            maybePrintBoxVolumeDebug(`pointerup:${phase}`);
            scene.forceRender = true;
            e.preventDefault();
            e.stopPropagation();
        };

        const pointercancel = (e: PointerEvent) => {
            if (clickCandidate?.pointerId === e.pointerId) {
                clicked = false;
                clickCandidate = null;
            }
        };

        const reset = () => {
            if (selectionRefreshFrame !== null) {
                window.cancelAnimationFrame(selectionRefreshFrame);
                selectionRefreshFrame = null;
            }
            selectionRefreshQueued = false;
            cancelActiveDrag();
            phase = 'idle';
            clicked = false;
            clickCandidate = null;
            busy = false;
            hasWidth = false;
            gizmo.detach();
            selectToolbar.hidden = true;
            overlaySvg.style.display = 'none';
            volumeShape.setVisible(false);
            for (const handle of resizeHandles) handle.dom.style.display = 'none';
            if (boxAdded) {
                scene.remove(box);
                scene.remove(volumeShape);
                boxAdded = false;
            }
            scene.forceRender = true;
        };

        const onKeyDown = (e: KeyboardEvent) => {
            if (active && e.key === 'Escape' && phase !== 'idle') {
                reset();
                e.stopPropagation();
            }
        };

        const updateGizmoSize = () => {
            const { camera, canvas } = scene;
            gizmo.size = camera.ortho ? 1125 / canvas.clientHeight : 1200 / Math.max(canvas.clientWidth, canvas.clientHeight);
        };
        updateGizmoSize();
        events.on('camera.resize', updateGizmoSize);
        events.on('camera.ortho', updateGizmoSize);

        this.activate = () => {
            active = true;
            phase = 'idle';
            waitForCollisionSurface().catch(() => {});
            canvasContainer.dom.addEventListener('pointerdown', pointerdown);
            canvasContainer.dom.addEventListener('pointermove', pointermove);
            canvasContainer.dom.addEventListener('pointerup', pointerup, true);
            canvasContainer.dom.addEventListener('pointercancel', pointercancel, true);
            document.addEventListener('keydown', onKeyDown);
        };

        this.deactivate = () => {
            active = false;
            reset();
            canvasContainer.dom.removeEventListener('pointerdown', pointerdown);
            canvasContainer.dom.removeEventListener('pointermove', pointermove);
            canvasContainer.dom.removeEventListener('pointerup', pointerup, true);
            canvasContainer.dom.removeEventListener('pointercancel', pointercancel, true);
            document.removeEventListener('keydown', onKeyDown);
        };
    }
}

export { BoxVolumeTool };
