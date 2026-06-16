import { Events } from '../events';

type BrushSelectionVariant = 'boxer' | 'sam' | 'raw';
type BrushSelectionOp = 'add' | 'remove' | 'set';

const LIVE_GAUSSIAN_PREVIEW_DEFAULT_ENABLED = true;
const LIVE_GAUSSIAN_PREVIEW_INTERVAL_MS = 90;

const livePreviewEnabledFromUrl = () => {
    const value = new URLSearchParams(window.location.search).get('brushLivePreview')?.toLowerCase();
    return value !== '0' && value !== 'false' && value !== 'off';
};

class BrushSelection {
    activate: () => void;
    deactivate: () => void;

    constructor(events: Events, parent: HTMLElement, mask: { canvas: HTMLCanvasElement, context: CanvasRenderingContext2D }) {
        // create svg
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.classList.add('tool-svg', 'hidden');
        svg.id = 'brush-select-svg';
        parent.appendChild(svg);

        // create circle element
        const circle = document.createElementNS(svg.namespaceURI, 'circle') as SVGCircleElement;
        svg.appendChild(circle);

        // surface-conforming outline used in 3D mode: a ring of raycasts
        // against the collision mesh, so the cursor folds over corners
        const surfaceOutline = document.createElementNS(svg.namespaceURI, 'polygon') as SVGPolygonElement;
        surfaceOutline.style.display = 'none';
        svg.appendChild(surfaceOutline);

        const { canvas, context } = mask;

        let radius = 40;

        circle.setAttribute('r', radius.toString());

        const prev = { x: 0, y: 0 };
        let dragId: number | undefined;
        let points: [number, number][] = [];
        let pointRadii: number[] = [];
        let variant: BrushSelectionVariant = 'boxer';
        let livePreviewEnabled = LIVE_GAUSSIAN_PREVIEW_DEFAULT_ENABLED && livePreviewEnabledFromUrl();
        let livePreviewTimer: number | undefined;
        let livePreviewInFlight = false;
        let livePreviewQueued = false;
        let livePreviewOp: BrushSelectionOp = 'set';
        let livePreviewRunId = 0;
        let lastLivePreviewAt = 0;

        // 3D brush mode: when a collision surface is loaded for the scene, the
        // brush keeps a constant world-space radius and the cursor conforms to
        // the surface depth/shape under the pointer.
        let radiusWorld: number | null = null;
        let lastPxPerWorld: number | null = null;
        // transient probe misses (mesh gaps, edges) coast on the last good
        // conversion instead of flickering back to 2D mode
        let surfaceMissStreak = 0;
        const SURFACE_MISS_TOLERANCE = 14;
        // per-stroke diagnostic trace: where the user actually pointed (client
        // px) and where the surface probe landed in 3D — recorded into the
        // prompt so strokes can be replicated and debugged offline
        let lastProbeHit: { point: [number, number, number]; distance: number } | null = null;
        let strokeTrace: { client: [number, number]; world: [number, number, number] | null; distance: number | null }[] = [];

        type SurfaceProbeHit = {
            point: [number, number, number];
            distance: number;
            world_per_screen_height: number;
            px_per_world: number;
        };

        // probes speak raw viewport (client) pixels — no frame conversions here
        const probeSurface = (clientX: number, clientY: number) => {
            return events.invoke('collisionSurface.screenProbe', clientX, clientY) as SurfaceProbeHit | null | undefined;
        };

        const probeSurfaceRing = (clientX: number, clientY: number, rWorld: number) => {
            return events.invoke('collisionSurface.ringProbe', clientX, clientY, rWorld, 20) as
                { center: SurfaceProbeHit; ring: [number, number][] } | null | undefined;
        };

        const controls = document.createElement('div');
        controls.className = 'brush-selection-controls hidden';
        controls.style.cssText = [
            'position:fixed',
            'left:16px',
            'top:72px',
            'z-index:10000',
            'width:220px',
            'box-sizing:border-box',
            'padding:10px 12px',
            'border:1px solid rgba(255,255,255,0.18)',
            'border-radius:6px',
            'background:rgba(20,22,25,0.9)',
            'box-shadow:0 8px 24px rgba(0,0,0,0.26)',
            'color:#f4f4f4',
            'font:12px/1.35 sans-serif',
            'pointer-events:auto',
            'user-select:none'
        ].join(';');

        const controlHeader = document.createElement('div');
        controlHeader.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;gap:8px';

        const controlLabel = document.createElement('span');
        controlLabel.textContent = 'Brush Size';
        controlLabel.style.cssText = 'font-weight:600';

        const radiusValue = document.createElement('span');
        radiusValue.style.cssText = 'color:#ffb26d;font-variant-numeric:tabular-nums';

        const radiusInput = document.createElement('input');
        radiusInput.type = 'range';
        radiusInput.min = '1';
        radiusInput.max = '500';
        radiusInput.step = '1';
        radiusInput.style.cssText = 'display:block;width:100%;margin:0;accent-color:#ff7a1a';
        radiusInput.title = 'Brush size';

        controlHeader.append(controlLabel, radiusValue);
        controls.append(controlHeader, radiusInput);
        document.body.appendChild(controls);

        const clampRadius = (value: number) => {
            return Number.isFinite(value) ? Math.max(1, Math.min(500, value)) : radius;
        };

        const setRadius = (value: number) => {
            radius = clampRadius(value);
            circle.setAttribute('r', radius.toString());
            radiusInput.value = Math.round(radius).toString();
            radiusValue.textContent = radiusWorld !== null ?
                `${Math.round(radius)}px · ${radiusWorld.toFixed(2)}wu` :
                `${Math.round(radius)}px`;
        };

        setRadius(radius);

        // keep the world radius in sync after explicit user resizes (wheel/slider)
        const syncWorldRadius = () => {
            if (radiusWorld !== null && lastPxPerWorld) {
                radiusWorld = radius / lastPxPerWorld;
            }
        };

        const exitSurfaceMode = () => {
            svg.classList.remove('surface-mode');
            surfaceOutline.style.display = 'none';
            circle.style.display = '';
            controlLabel.textContent = 'Brush Size';
        };

        const applySurfaceRadius = (clientX: number, clientY: number) => {
            const ringResult = radiusWorld !== null ? probeSurfaceRing(clientX, clientY, radiusWorld) : null;
            const hit = ringResult?.center ?? probeSurface(clientX, clientY);
            if (!hit || !(hit.px_per_world > 0)) {
                lastProbeHit = null;
                surfaceMissStreak += 1;
                if (surfaceMissStreak > SURFACE_MISS_TOLERANCE) {
                    exitSurfaceMode();
                }
                return;
            }
            lastProbeHit = { point: hit.point, distance: hit.distance };
            surfaceMissStreak = 0;
            const pxPerWorld = hit.px_per_world;
            if (radiusWorld === null) {
                radiusWorld = radius / pxPerWorld;
            }
            lastPxPerWorld = pxPerWorld;
            svg.classList.add('surface-mode');
            controlLabel.textContent = 'Brush Size · 3D';

            // ease toward the target size so depth edges do not snap the cursor
            const targetRadius = radiusWorld * pxPerWorld;
            setRadius(radius + (targetRadius - radius) * 0.45);

            if (ringResult?.ring?.length) {
                const parentRect = parent.getBoundingClientRect();
                surfaceOutline.setAttribute(
                    'points',
                    ringResult.ring.map(point => `${(point[0] - parentRect.left).toFixed(1)},${(point[1] - parentRect.top).toFixed(1)}`).join(' ')
                );
                surfaceOutline.style.display = '';
                circle.style.display = 'none';
            } else {
                surfaceOutline.style.display = 'none';
                circle.style.display = '';
            }
        };

        const addPoint = (x: number, y: number, clientX?: number, clientY?: number) => {
            const last = points[points.length - 1];
            if (last && Math.hypot(last[0] - x, last[1] - y) < 3) return;
            points.push([x, y]);
            pointRadii.push(radius);
            if (clientX !== undefined && clientY !== undefined && strokeTrace.length < 256) {
                strokeTrace.push({
                    client: [Math.round(clientX), Math.round(clientY)],
                    world: lastProbeHit ? [...lastProbeHit.point] : null,
                    distance: lastProbeHit ? Number(lastProbeHit.distance.toFixed(3)) : null
                });
            }
        };

        const buildBrushPrompt = () => {
            if (points.length === 0) return null;
            const bounds = points.reduce((acc, point) => {
                acc[0] = Math.min(acc[0], point[0]);
                acc[1] = Math.min(acc[1], point[1]);
                acc[2] = Math.max(acc[2], point[0]);
                acc[3] = Math.max(acc[3], point[1]);
                return acc;
            }, [Infinity, Infinity, -Infinity, -Infinity] as [number, number, number, number]);
            const center = points.reduce((acc, point) => {
                acc[0] += point[0];
                acc[1] += point[1];
                return acc;
            }, [0, 0] as [number, number]);
            center[0] = Math.round(center[0] / points.length);
            center[1] = Math.round(center[1] / points.length);
            // in 3D mode the px radius varies along the stroke; the prompt
            // carries the mean for region tests and the max for bounds padding
            const promptRadius = pointRadii.length ?
                pointRadii.reduce((sum, value) => sum + value, 0) / pointRadii.length :
                radius;
            const paddingRadius = pointRadii.length ? Math.max(...pointRadii) : radius;
            const bb2d: [number, number, number, number] = [
                Math.max(0, bounds[0] - paddingRadius),
                Math.max(0, bounds[1] - paddingRadius),
                Math.min(canvas.width, bounds[2] + paddingRadius),
                Math.min(canvas.height, bounds[3] + paddingRadius)
            ];

            // honest variant contract:
            //   raw   -> client_brush  (no model, local geometry pipeline)
            //   boxer -> brush_boxer   (real Boxer model lift, no fallback)
            //   sam   -> brush_sam     (real SAM mask, no fallback)
            return {
                type: variant === 'sam' ? 'brush_sam' : variant === 'boxer' ? 'brush_boxer' : 'client_brush',
                click_xy: center,
                brush: {
                    shape: 'stroke',
                    center_xy: center,
                    radius: promptRadius,
                    bb2d,
                    points: points.map(point => [Math.round(point[0]), Math.round(point[1])] as [number, number]),
                    ...(radiusWorld !== null ? { radius_world: radiusWorld } : {}),
                    ...(strokeTrace.length ? { probe_trace: strokeTrace } : {})
                }
            };
        };

        const selectionOpFromPointer = (e: PointerEvent): BrushSelectionOp => {
            return e.shiftKey ? 'add' : (e.ctrlKey ? 'remove' : 'set');
        };

        const invokeClearLivePreview = () => {
            const result = events.invoke('select.clearMaskPreview') as Promise<unknown> | undefined;
            if (result && typeof result.catch === 'function') {
                result.catch((err) => {
                    console.warn('[BrushSelection] live preview clear failed', err);
                });
            }
        };

        const cancelLivePreview = () => {
            livePreviewRunId++;
            livePreviewQueued = false;
            if (livePreviewTimer !== undefined) {
                window.clearTimeout(livePreviewTimer);
                livePreviewTimer = undefined;
            }
        };

        const clearLivePreview = () => {
            cancelLivePreview();
            invokeClearLivePreview();
        };

        async function runLivePreview() {
            livePreviewTimer = undefined;
            if (!livePreviewEnabled || !livePreviewQueued || dragId === undefined) {
                livePreviewQueued = false;
                return;
            }

            const runId = livePreviewRunId;
            const op = livePreviewOp;
            livePreviewQueued = false;
            livePreviewInFlight = true;

            try {
                await events.invoke('select.previewByMask', op, canvas, context);
            } catch (err) {
                console.warn('[BrushSelection] live preview failed', err);
            } finally {
                livePreviewInFlight = false;
                lastLivePreviewAt = performance.now();
                if (livePreviewQueued && dragId !== undefined && runId === livePreviewRunId) {
                    requestLivePreview(livePreviewOp);
                }
            }
        }

        function requestLivePreview(op: BrushSelectionOp) {
            if (!livePreviewEnabled || dragId === undefined) {
                return;
            }

            livePreviewOp = op;
            livePreviewQueued = true;

            if (livePreviewInFlight || livePreviewTimer !== undefined) {
                return;
            }

            const elapsed = performance.now() - lastLivePreviewAt;
            const delay = Math.max(0, LIVE_GAUSSIAN_PREVIEW_INTERVAL_MS - elapsed);
            livePreviewTimer = window.setTimeout(() => {
                runLivePreview();
            }, delay);
        }

        const update = (e: PointerEvent) => {
            const x = e.offsetX;
            const y = e.offsetY;

            applySurfaceRadius(e.clientX, e.clientY);
            circle.setAttribute('cx', x.toString());
            circle.setAttribute('cy', y.toString());

            if (dragId !== undefined) {
                context.beginPath();
                context.strokeStyle = '#f60';
                context.lineCap = 'round';
                context.lineWidth = radius * 2;
                context.moveTo(prev.x, prev.y);
                context.lineTo(x, y);
                context.stroke();
                addPoint(x, y, e.clientX, e.clientY);

                prev.x = x;
                prev.y = y;

                requestLivePreview(selectionOpFromPointer(e));
            }
        };

        const pointerdown = (e: PointerEvent) => {
            if (dragId === undefined && (e.pointerType === 'mouse' ? e.button === 0 : e.isPrimary)) {
                e.preventDefault();
                e.stopPropagation();

                dragId = e.pointerId;
                parent.setPointerCapture(dragId);

                // initialize canvas
                if (canvas.width !== parent.clientWidth || canvas.height !== parent.clientHeight) {
                    canvas.width = parent.clientWidth;
                    canvas.height = parent.clientHeight;
                }

                // clear canvas
                context.clearRect(0, 0, canvas.width, canvas.height);

                // display it
                canvas.style.display = 'inline';

                prev.x = e.offsetX;
                prev.y = e.offsetY;
                points = [];
                pointRadii = [];
                strokeTrace = [];
                addPoint(prev.x, prev.y, e.clientX, e.clientY);

                update(e);
            }
        };

        const pointermove = (e: PointerEvent) => {
            if (dragId !== undefined) {
                e.preventDefault();
                e.stopPropagation();
            }

            update(e);
        };

        const dragEnd = () => {
            parent.releasePointerCapture(dragId);
            dragId = undefined;
            canvas.style.display = 'none';
            clearLivePreview();
        };

        const pointerup = async (e: PointerEvent) => {
            if (e.pointerId === dragId) {
                e.preventDefault();
                e.stopPropagation();
                cancelLivePreview();

                await events.invoke(
                    'select.byMask',
                    selectionOpFromPointer(e),
                    canvas,
                    context
                );
                const prompt = buildBrushPrompt();
                if (prompt) {
                    events.fire('boxer.brushPromptCaptured', prompt);
                }

                dragEnd();
            }
        };

        const applyWheelDelta = (delta: number, fast: boolean) => {
            if (delta === 0) return;
            const scale = fast ? 1.18 : 1.08;
            setRadius(delta > 0 ? radius / scale : radius * scale);
            syncWorldRadius();
        };

        const wheel = (e: WheelEvent) => {
            const { deltaX, deltaY } = e;
            applyWheelDelta(Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY, e.shiftKey);
            e.preventDefault();
            e.stopPropagation();
        };

        radiusInput.addEventListener('input', () => {
            setRadius(Number(radiusInput.value));
            syncWorldRadius();
        });

        radiusInput.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
        });

        controls.addEventListener('wheel', wheel);

        this.activate = () => {
            // re-derive the world radius from the current px radius on first
            // probe, in case the scene or camera changed since last activation
            radiusWorld = null;
            lastPxPerWorld = null;
            surfaceMissStreak = 0;
            exitSurfaceMode();
            svg.classList.remove('hidden');
            controls.classList.remove('hidden');
            parent.style.display = 'block';
            parent.addEventListener('pointerdown', pointerdown);
            parent.addEventListener('pointermove', pointermove);
            parent.addEventListener('pointerup', pointerup);
            parent.addEventListener('wheel', wheel);
        };

        this.deactivate = () => {
            // cancel active operation
            if (dragId !== undefined) {
                dragEnd();
            }
            svg.classList.add('hidden');
            controls.classList.add('hidden');
            parent.style.display = 'none';
            parent.removeEventListener('pointerdown', pointerdown);
            parent.removeEventListener('pointermove', pointermove);
            parent.removeEventListener('pointerup', pointerup);
            parent.removeEventListener('wheel', wheel);
        };

        events.on('tool.brushSelection.smaller', () => {
            setRadius(radius / 1.08);
        });

        events.on('tool.brushSelection.bigger', () => {
            setRadius(radius * 1.08);
        });

        events.on('brushSelection.variant', (value: BrushSelectionVariant) => {
            variant = value === 'sam' || value === 'raw' ? value : 'boxer';
            events.fire('brushSelection.variant.changed', variant);
        });

        try {
            events.function('brushSelection.getRadius', () => radius);
            events.function('brushSelection.setRadius', (value: number) => {
                setRadius(Number(value));
                return radius;
            });
            events.function('brushSelection.getVariant', () => variant);
            events.function('brushSelection.getLivePreviewEnabled', () => livePreviewEnabled);
            events.function('brushSelection.setLivePreviewEnabled', (enabled: boolean) => {
                livePreviewEnabled = enabled === true;
                if (!livePreviewEnabled) {
                    clearLivePreview();
                }
                return livePreviewEnabled;
            });
        } catch (err) {
            console.warn('[BrushSelection] brushSelection functions were already registered', err);
        }
    }
}

export { BrushSelection };
