import { Events } from '../events';
import { Scene } from '../scene';
import { Splat } from '../splat';
import {
    applyArtisanMaskSelection,
    buildArtisanViewKey,
    canvasAlphaToMask,
    captureScene,
    getArtisanOpFromPointer,
    maskArrayToPngBase64,
    type ArtisanSelectionMode
} from './artisan-selection';

type ArtisanTimingStep = {
    started_ms: number;
    ended_ms: number;
    duration_ms: number;
};

const preciseMs = (ms: number) => Number(Math.max(0, ms).toFixed(3));

const createTimingTracker = (startedAt: number) => {
    const timeline: Record<string, ArtisanTimingStep> = {};
    const finish = (name: string, stepStartedAt: number) => {
        const endedAt = performance.now();
        const step = {
            started_ms: preciseMs(stepStartedAt - startedAt),
            ended_ms: preciseMs(endedAt - startedAt),
            duration_ms: preciseMs(endedAt - stepStartedAt)
        };
        timeline[name] = step;
        return step;
    };

    return { timeline, finish };
};

class ArtisanBrushSelection {
    activate: () => void;
    deactivate: () => void;

    constructor(events: Events, scene: Scene, parent: HTMLElement, mask: { canvas: HTMLCanvasElement, context: CanvasRenderingContext2D }) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.classList.add('tool-svg', 'hidden');
        svg.id = 'artisan-brush-select-svg';
        parent.appendChild(svg);

        const circle = document.createElementNS(svg.namespaceURI, 'circle') as SVGCircleElement;
        svg.appendChild(circle);

        const { canvas, context } = mask;

        let radius = 40;
        let selectionMode: ArtisanSelectionMode = 'set';

        circle.setAttribute('r', radius.toString());

        const prev = { x: 0, y: 0 };
        let dragId: number | undefined;
        let points: [number, number][] = [];

        const controls = document.createElement('div');
        controls.className = 'brush-selection-controls hidden';
        controls.style.cssText = [
            'position:fixed',
            'display:none',
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

        const setControlsVisible = (visible: boolean) => {
            controls.classList[visible ? 'remove' : 'add']('hidden');
            controls.style.display = visible ? 'block' : 'none';
        };

        const controlHeader = document.createElement('div');
        controlHeader.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;gap:8px';

        const controlLabel = document.createElement('span');
        controlLabel.textContent = 'A Brush Size';
        controlLabel.style.cssText = 'font-weight:600';

        const radiusValue = document.createElement('span');
        radiusValue.style.cssText = 'color:#7dd3fc;font-variant-numeric:tabular-nums';

        const radiusInput = document.createElement('input');
        radiusInput.type = 'range';
        radiusInput.min = '1';
        radiusInput.max = '500';
        radiusInput.step = '1';
        radiusInput.style.cssText = 'display:block;width:100%;margin:0;accent-color:#0ea5e9';
        radiusInput.title = 'Artisan brush size';

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
            radiusValue.textContent = `${Math.round(radius)}px`;
        };

        setRadius(radius);

        const addPoint = (x: number, y: number) => {
            const last = points[points.length - 1];
            if (last && Math.hypot(last[0] - x, last[1] - y) < 3) return;
            points.push([x, y]);
        };

        const buildBrushPrompt = (op: ArtisanSelectionMode, viewKey: string, result: unknown) => {
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
            const bb2d: [number, number, number, number] = [
                Math.max(0, bounds[0] - radius),
                Math.max(0, bounds[1] - radius),
                Math.min(canvas.width, bounds[2] + radius),
                Math.min(canvas.height, bounds[3] + radius)
            ];

            return {
                type: 'client_brush',
                click_xy: center,
                selection_mode: op,
                projection_mode: 'surface',
                view_key: viewKey,
                image_size: { width: canvas.width, height: canvas.height },
                brush: {
                    shape: 'stroke',
                    center_xy: center,
                    radius,
                    bb2d,
                    points: points.map(point => [Math.round(point[0]), Math.round(point[1])] as [number, number])
                },
                result
            };
        };

        const update = (e: PointerEvent) => {
            const x = e.offsetX;
            const y = e.offsetY;

            circle.setAttribute('cx', x.toString());
            circle.setAttribute('cy', y.toString());

            if (dragId !== undefined) {
                context.beginPath();
                context.strokeStyle = '#0ea5e9';
                context.lineCap = 'round';
                context.lineWidth = radius * 2;
                context.moveTo(prev.x, prev.y);
                context.lineTo(x, y);
                context.stroke();
                addPoint(x, y);

                prev.x = x;
                prev.y = y;
            }
        };

        const pointerdown = (e: PointerEvent) => {
            if (dragId === undefined && (e.pointerType === 'mouse' ? e.button === 0 : e.isPrimary)) {
                e.preventDefault();
                e.stopPropagation();

                dragId = e.pointerId;
                parent.setPointerCapture(dragId);

                if (canvas.width !== parent.clientWidth || canvas.height !== parent.clientHeight) {
                    canvas.width = parent.clientWidth;
                    canvas.height = parent.clientHeight;
                }

                context.clearRect(0, 0, canvas.width, canvas.height);
                canvas.style.display = 'inline';

                prev.x = e.offsetX;
                prev.y = e.offsetY;
                points = [];
                addPoint(prev.x, prev.y);

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
        };

        const pointerup = async (e: PointerEvent) => {
            if (e.pointerId === dragId) {
                e.preventDefault();
                e.stopPropagation();

                const splat = events.invoke('selection') as Splat;
                if (!splat) {
                    console.warn('[ArtisanGS] No splat selected');
                    events.fire('toast', 'No splat loaded', 'warning');
                    dragEnd();
                    return;
                }

                const totalStartedAt = performance.now();
                const { timeline, finish } = createTimingTracker(totalStartedAt);
                const op = getArtisanOpFromPointer(e, selectionMode);
                const camera = events.invoke('camera.debugState');
                const viewKey = buildArtisanViewKey(scene, splat, canvas.width, canvas.height);
                const maskExtractStartedAt = performance.now();
                const brushMask = canvasAlphaToMask(canvas, context);
                const maskExtractMs = Math.round(finish('mask_extract', maskExtractStartedAt).duration_ms);
                const maskEncodeStartedAt = performance.now();
                const maskImage = maskArrayToPngBase64(brushMask, canvas.width, canvas.height);
                const maskEncodeMs = Math.round(finish('mask_encode', maskEncodeStartedAt).duration_ms);
                const applyStartedAt = performance.now();
                const result = await applyArtisanMaskSelection(events, scene, splat, {
                    source: 'brush',
                    mask: brushMask,
                    maskWidth: canvas.width,
                    maskHeight: canvas.height,
                    imageWidth: canvas.width,
                    imageHeight: canvas.height,
                    op,
                    projectionMode: 'surface'
                });
                const applyMs = Math.round(finish('mask_apply', applyStartedAt).duration_ms);
                const brushToMaskMs = Math.round(finish('brush_to_mask', totalStartedAt).duration_ms);
                const prompt = buildBrushPrompt(op, viewKey, result);
                if (prompt) {
                    events.fire('artisan.brushPromptCaptured', {
                        ...prompt,
                        timings: {
                            mask_extract_ms: maskExtractMs,
                            mask_encode_ms: maskEncodeMs,
                            apply_ms: applyMs,
                            brush_to_mask_ms: brushToMaskMs,
                            total_ms: brushToMaskMs,
                            timeline: { ...timeline }
                        }
                    });
                }

                dragEnd();

                try {
                    const captureStartedAt = performance.now();
                    const image = await captureScene(events, canvas.width, canvas.height);
                    const captureMs = Math.round(finish('capture', captureStartedAt).duration_ms);
                    const totalMs = Math.round(finish('brush_to_seed_event', totalStartedAt).duration_ms);
                    const timings = {
                        capture_ms: captureMs,
                        mask_extract_ms: maskExtractMs,
                        mask_encode_ms: maskEncodeMs,
                        apply_ms: applyMs,
                        brush_to_mask_ms: brushToMaskMs,
                        total_ms: totalMs,
                        timeline
                    };
                    console.log(`[ArtisanGS] seed brush timings extract=${maskExtractMs}ms encode=${maskEncodeMs}ms apply=${applyMs}ms brushToMask=${brushToMaskMs}ms capture=${captureMs}ms total=${timings.total_ms}ms`);
                    events.fire('artisan.seedMaskCaptured', {
                        source: 'brush',
                        selection_mode: op,
                        projection_mode: 'surface',
                        seed_xy: prompt?.click_xy,
                        view_key: viewKey,
                        frame: {
                            image,
                            width: canvas.width,
                            height: canvas.height,
                            mimeType: 'image/png',
                            camera
                        },
                        mask: {
                            image: maskImage,
                            width: canvas.width,
                            height: canvas.height,
                            mimeType: 'image/png',
                            data: brushMask
                        },
                        timings,
                        result
                    });
                } catch (err) {
                    console.warn('[ArtisanGS] Could not capture brush seed frame for local tracking', err);
                }
            }
        };

        const applyWheelDelta = (delta: number, fast: boolean) => {
            if (delta === 0) return;
            const scale = fast ? 1.18 : 1.08;
            setRadius(delta > 0 ? radius / scale : radius * scale);
        };

        const wheel = (e: WheelEvent) => {
            const { deltaX, deltaY } = e;
            applyWheelDelta(Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY, e.shiftKey);
            e.preventDefault();
            e.stopPropagation();
        };

        const modeHandler = (mode: ArtisanSelectionMode) => {
            selectionMode = mode;
            events.fire('artisan.selectionMode.changed', selectionMode);
            events.fire('artisanClick.selectionMode.changed', selectionMode);
        };

        radiusInput.addEventListener('input', () => {
            setRadius(Number(radiusInput.value));
        });

        radiusInput.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
        });

        controls.addEventListener('wheel', wheel);
        events.on('artisan.selectionMode', modeHandler);
        events.fire('artisan.selectionMode.changed', selectionMode);
        events.fire('artisanClick.selectionMode.changed', selectionMode);

        this.activate = () => {
            svg.classList.remove('hidden');
            setControlsVisible(true);
            parent.style.display = 'block';
            parent.addEventListener('pointerdown', pointerdown);
            parent.addEventListener('pointermove', pointermove);
            parent.addEventListener('pointerup', pointerup);
            parent.addEventListener('wheel', wheel);
            events.fire('artisan.selectionMode.changed', selectionMode);
            events.fire('artisanClick.selectionMode.changed', selectionMode);
        };

        this.deactivate = () => {
            if (dragId !== undefined) {
                dragEnd();
            }
            svg.classList.add('hidden');
            setControlsVisible(false);
            parent.style.display = 'none';
            parent.removeEventListener('pointerdown', pointerdown);
            parent.removeEventListener('pointermove', pointermove);
            parent.removeEventListener('pointerup', pointerup);
            parent.removeEventListener('wheel', wheel);
        };

        events.on('tool.artisanBrushSelection.smaller', () => {
            setRadius(radius / 1.08);
        });

        events.on('tool.artisanBrushSelection.bigger', () => {
            setRadius(radius * 1.08);
        });

        try {
            events.function('artisanBrushSelection.getRadius', () => radius);
            events.function('artisanBrushSelection.setRadius', (value: number) => {
                setRadius(Number(value));
                return radius;
            });
        } catch (err) {
            console.warn('[ArtisanBrushSelection] radius functions were already registered', err);
        }
    }
}

export { ArtisanBrushSelection };
