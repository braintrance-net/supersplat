import { Events } from '../events';

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

        const { canvas, context } = mask;

        let radius = 40;

        circle.setAttribute('r', radius.toString());

        const prev = { x: 0, y: 0 };
        let dragId: number | undefined;
        let points: [number, number][] = [];

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
            radiusValue.textContent = `${Math.round(radius)}px`;
        };

        setRadius(radius);

        const addPoint = (x: number, y: number) => {
            const last = points[points.length - 1];
            if (last && Math.hypot(last[0] - x, last[1] - y) < 3) return;
            points.push([x, y]);
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
            const bb2d: [number, number, number, number] = [
                Math.max(0, bounds[0] - radius),
                Math.max(0, bounds[1] - radius),
                Math.min(canvas.width, bounds[2] + radius),
                Math.min(canvas.height, bounds[3] + radius)
            ];

            return {
                type: 'client_brush',
                click_xy: center,
                brush: {
                    shape: 'stroke',
                    center_xy: center,
                    radius,
                    bb2d,
                    points: points.map(point => [Math.round(point[0]), Math.round(point[1])] as [number, number])
                }
            };
        };

        const update = (e: PointerEvent) => {
            const x = e.offsetX;
            const y = e.offsetY;

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

                await events.invoke(
                    'select.byMask',
                    e.shiftKey ? 'add' : (e.ctrlKey ? 'remove' : 'set'),
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
        };

        const wheel = (e: WheelEvent) => {
            const { deltaX, deltaY } = e;
            applyWheelDelta(Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY, e.shiftKey);
            e.preventDefault();
            e.stopPropagation();
        };

        radiusInput.addEventListener('input', () => {
            setRadius(Number(radiusInput.value));
        });

        radiusInput.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
        });

        controls.addEventListener('wheel', wheel);

        this.activate = () => {
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

        try {
            events.function('brushSelection.getRadius', () => radius);
            events.function('brushSelection.setRadius', (value: number) => {
                setRadius(Number(value));
                return radius;
            });
        } catch (err) {
            console.warn('[BrushSelection] brushSelection radius functions were already registered', err);
        }
    }
}

export { BrushSelection };
