import { SelectOp } from '../edit-ops';
import { Events } from '../events';
import { Scene } from '../scene';
import { Splat } from '../splat';
import { State } from '../splat-state';
import {
    applyArtisanSelectionIndices,
    encodeIndexRanges,
    projectArtisanVisibleSurface
} from './artisan-selection';
import {
    MultiViewRefineSession,
    combineMultiViewRefineAngles,
    type MultiViewRefineAngle
} from './multi-view-refine-session';

type CapturedMask = {
    width: number;
    height: number;
    data: Uint8Array;
};

type MultiViewAngle = MultiViewRefineAngle & {
    mask: CapturedMask;
};

type CaptureResult = {
    ok?: boolean;
    error?: string;
    seed_result?: { selectedRanges?: [number, number][] };
    seed?: { mask?: CapturedMask };
};

const injectStyles = () => {
    if (document.getElementById('multi-view-refine-styles')) return;
    const style = document.createElement('style');
    style.id = 'multi-view-refine-styles';
    style.textContent = `
        .multi-view-refine-panel {
            position: fixed; top: 18px; left: 50%; z-index: 10020;
            width: min(420px, calc(100vw - 32px)); transform: translateX(-50%);
            padding: 14px; border: 1px solid rgba(255,255,255,.18); border-radius: 12px;
            color: #f6f7fb; background: rgba(19,21,27,.94); box-shadow: 0 12px 38px rgba(0,0,0,.4);
            font: 13px/1.4 system-ui, sans-serif; backdrop-filter: blur(12px);
        }
        .multi-view-refine-panel.hidden { display: none; }
        .multi-view-refine-panel__title { font-weight: 650; font-size: 14px; }
        .multi-view-refine-panel__status { margin-top: 4px; color: rgba(255,255,255,.72); }
        .multi-view-refine-panel__actions { display: flex; gap: 8px; margin-top: 12px; justify-content: flex-end; }
        .multi-view-refine-panel button { border: 1px solid rgba(255,255,255,.18); border-radius: 7px; padding: 7px 12px; color: #fff; background: #343843; cursor: pointer; }
        .multi-view-refine-panel button.primary { border-color: #58bdf8; background: #1687c8; }
        .multi-view-refine-panel button:disabled { opacity: .4; cursor: default; }
        .multi-view-refine-mask { position: fixed; z-index: 10010; pointer-events: none; opacity: .42; image-rendering: pixelated; }
    `;
    document.head.appendChild(style);
};

const selectionSet = (splat: Splat) => {
    const state = splat.splatData.getProp('state') as Uint8Array;
    const selected = new Set<number>();
    for (let index = 0; index < state.length; index++) {
        if ((state[index] & State.selected) !== 0) selected.add(index);
    }
    return selected;
};

class MultiViewRefineSelection {
    activate: () => void;
    deactivate: () => void;

    private active = false;
    private committed = false;
    private processing = false;
    private activationToken = 0;
    private session = new MultiViewRefineSession<MultiViewAngle>();
    private splat: Splat | null = null;
    private originalSelection = new Set<number>();
    private pointerStart: { x: number; y: number; id: number } | null = null;

    constructor(private events: Events, private scene: Scene, private parent: HTMLElement) {
        injectStyles();

        const panel = document.createElement('section');
        panel.className = 'multi-view-refine-panel hidden';
        panel.addEventListener('pointerdown', event => event.stopPropagation());
        panel.addEventListener('pointerup', event => event.stopPropagation());

        const title = document.createElement('div');
        title.className = 'multi-view-refine-panel__title';
        title.textContent = 'Multi-View Refine';
        const status = document.createElement('div');
        status.className = 'multi-view-refine-panel__status';
        const actions = document.createElement('div');
        actions.className = 'multi-view-refine-panel__actions';
        const cancelButton = document.createElement('button');
        cancelButton.textContent = 'Cancel';
        const refineButton = document.createElement('button');
        refineButton.className = 'primary';
        refineButton.textContent = 'Refine';
        const applyButton = document.createElement('button');
        applyButton.className = 'primary';
        applyButton.textContent = 'Apply';
        actions.append(cancelButton, refineButton, applyButton);
        panel.append(title, status, actions);
        document.body.appendChild(panel);

        const overlay = document.createElement('canvas');
        overlay.className = 'multi-view-refine-mask';
        document.body.appendChild(overlay);
        const overlayContext = overlay.getContext('2d');

        const hideOverlay = () => {
            overlay.style.display = 'none';
        };
        hideOverlay();

        const drawOverlay = (mask: CapturedMask) => {
            if (!overlayContext) return;
            const rect = this.scene.canvas.getBoundingClientRect();
            overlay.width = mask.width;
            overlay.height = mask.height;
            overlay.style.left = `${rect.left}px`;
            overlay.style.top = `${rect.top}px`;
            overlay.style.width = `${rect.width}px`;
            overlay.style.height = `${rect.height}px`;
            const image = overlayContext.createImageData(mask.width, mask.height);
            const limit = Math.min(mask.data.length, mask.width * mask.height);
            for (let index = 0; index < limit; index++) {
                if (mask.data[index] === 0) continue;
                const offset = index * 4;
                image.data[offset] = 55;
                image.data[offset + 1] = 189;
                image.data[offset + 2] = 248;
                image.data[offset + 3] = 210;
            }
            overlayContext.putImageData(image, 0, 0);
            overlay.style.display = 'block';
        };

        const syncUi = () => {
            const snapshot = this.session.snapshot();
            const count = snapshot.angleCount;
            const copy = this.processing && snapshot.phase !== 'processing' ?
                'Applying selection…' : ({
                    armed: 'Click the object from your first angle.',
                    processing: 'Building the mask for this angle…',
                    'initial-result': 'Initial mask ready. Press Refine, orbit, then click the same object.',
                    refining: `${count} angle${count === 1 ? '' : 's'} retained. Orbit and click again, or Apply. Ctrl-Z removes the last angle.`,
                    applied: 'Selection applied.',
                    abandoned: 'Refinement abandoned.'
                }[snapshot.phase]);
            status.textContent = copy;
            refineButton.hidden = snapshot.phase !== 'initial-result';
            applyButton.hidden = snapshot.phase === 'initial-result' || snapshot.phase === 'armed';
            applyButton.disabled = !snapshot.canApply || this.processing;
            cancelButton.disabled = this.processing;
            refineButton.disabled = this.processing;
            this.parent.style.cursor = this.processing ? 'wait' : 'crosshair';
            this.events.fire('multiViewRefine.stateChanged', snapshot);
        };

        const previewSelection = async () => {
            if (!this.splat) return;
            const selected = combineMultiViewRefineAngles(this.session.retainedAngles());
            const op = new SelectOp(this.splat, 'set', index => selected.has(index));
            await op.do();
            this.scene.forceRender = true;
            this.events.fire('multiViewRefine.selectionChanged', { selectedCount: selected.size });
        };

        const restoreOriginalSelection = async () => {
            if (!this.splat) return;
            const op = new SelectOp(this.splat, 'set', index => this.originalSelection.has(index));
            await op.do();
            this.scene.forceRender = true;
        };

        const captureAngle = async (x: number, y: number) => {
            const phase = this.session.snapshot().phase;
            if (this.processing || (phase !== 'armed' && phase !== 'refining')) return;
            if (!this.splat) {
                this.splat = this.events.invoke('selection') as Splat | null;
                if (!this.splat) {
                    this.events.fire('toast', 'Load a splat before using Multi-View Refine', 'warning');
                    return;
                }
                this.originalSelection = selectionSet(this.splat);
            }

            this.processing = true;
            const activationToken = this.activationToken;
            this.session.beginAngle();
            hideOverlay();
            syncUi();
            this.events.fire('multiViewRefine.angleStarted', { x, y });
            try {
                const result = await Promise.resolve(this.events.invoke('artisan.clickSelection.debugRun', {
                    click_xy: [x, y],
                    selectionMode: 'set',
                    label: 1,
                    captureOnly: true,
                    runLocal: false,
                    reviewSeedMask: false,
                    includeReview: false,
                    includeImages: false
                })) as CaptureResult | undefined;
                const selectedRanges = result?.seed_result?.selectedRanges;
                const mask = result?.seed?.mask;
                if (!this.active || activationToken !== this.activationToken) return;
                const visibleProjection = this.splat ?
                    projectArtisanVisibleSurface(this.scene, this.splat, this.scene.canvas.clientWidth, this.scene.canvas.clientHeight) :
                    null;
                if (!result?.ok || !selectedRanges?.length || !visibleProjection || !mask?.data) {
                    throw new Error(result?.error || 'This angle did not produce a usable mask.');
                }
                const visibleRanges = encodeIndexRanges(visibleProjection.indices);
                const angle: MultiViewAngle = { selectedRanges, visibleRanges, mask };
                this.session.applyAngle(angle);
                await previewSelection();
                drawOverlay(mask);
                this.events.fire('multiViewRefine.angleApplied', {
                    angleCount: this.session.snapshot().angleCount,
                    selectedRangeCount: selectedRanges.length
                });
            } catch (error) {
                if (!this.active || activationToken !== this.activationToken) return;
                this.session.failAngle();
                const message = error instanceof Error ? error.message : 'Mask capture failed.';
                this.events.fire('toast', `Multi-View Refine: ${message}`, 'error');
                this.events.fire('multiViewRefine.angleFailed', { error: message });
            } finally {
                if (this.active && activationToken === this.activationToken) {
                    this.processing = false;
                    syncUi();
                }
            }
        };

        const onPointerDown = (event: PointerEvent) => {
            if (!this.active || event.target !== this.scene.canvas) return;
            if (event.pointerType === 'mouse' && event.button !== 0) return;
            this.pointerStart = { x: event.clientX, y: event.clientY, id: event.pointerId };
        };
        const onPointerMove = (event: PointerEvent) => {
            if (!this.pointerStart || event.pointerId !== this.pointerStart.id) return;
            if (Math.hypot(event.clientX - this.pointerStart.x, event.clientY - this.pointerStart.y) > 5) {
                hideOverlay();
            }
        };
        const onPointerUp = (event: PointerEvent) => {
            const start = this.pointerStart;
            this.pointerStart = null;
            if (!this.active || !start || event.pointerId !== start.id || event.target !== this.scene.canvas) return;
            if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
            const rect = this.scene.canvas.getBoundingClientRect();
            captureAngle(Math.round(event.clientX - rect.left), Math.round(event.clientY - rect.top))
            .catch(error => console.error('[MultiViewRefine] angle capture failed', error));
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (!this.active || this.processing) return;
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
                const removed = this.session.undoAngle();
                if (!removed) return;
                event.preventDefault();
                event.stopImmediatePropagation();
                hideOverlay();
                previewSelection()
                .then(syncUi)
                .catch(error => console.error('[MultiViewRefine] undo preview failed', error));
                this.events.fire('multiViewRefine.angleUndone', { angleCount: this.session.snapshot().angleCount });
            } else if (event.key === 'Escape') {
                event.preventDefault();
                this.events.fire('tool.deactivate');
            }
        };

        refineButton.addEventListener('click', () => {
            this.session.enterRefine();
            hideOverlay();
            syncUi();
            this.events.fire('multiViewRefine.refineStarted');
        });
        cancelButton.addEventListener('click', () => this.events.fire('tool.deactivate'));
        applyButton.addEventListener('click', async () => {
            if (!this.splat || !this.session.snapshot().canApply) return;
            this.processing = true;
            syncUi();
            try {
                const selected = combineMultiViewRefineAngles(this.session.retainedAngles());
                await restoreOriginalSelection();
                await applyArtisanSelectionIndices(this.events, this.splat, 'set', selected);
                this.session.apply();
                this.committed = true;
                this.events.fire('multiViewRefine.applied', {
                    angleCount: this.session.snapshot().angleCount,
                    selectedCount: selected.size
                });
                this.events.fire('tool.deactivate');
            } catch (error) {
                this.processing = false;
                const message = error instanceof Error ? error.message : 'Selection could not be applied.';
                this.events.fire('toast', `Multi-View Refine: ${message}`, 'error');
                console.error('[MultiViewRefine] apply failed', error);
                syncUi();
            }
        });

        this.activate = () => {
            this.activationToken++;
            this.active = true;
            this.committed = false;
            this.processing = false;
            this.session = new MultiViewRefineSession<MultiViewAngle>();
            this.splat = null;
            this.originalSelection = new Set<number>();
            hideOverlay();
            panel.classList.remove('hidden');
            this.parent.addEventListener('pointerdown', onPointerDown, true);
            this.parent.addEventListener('pointermove', onPointerMove, true);
            this.parent.addEventListener('pointerup', onPointerUp, true);
            window.addEventListener('keydown', onKeyDown, true);
            syncUi();
        };

        this.deactivate = () => {
            this.activationToken++;
            this.active = false;
            this.pointerStart = null;
            panel.classList.add('hidden');
            hideOverlay();
            this.parent.style.cursor = '';
            this.parent.removeEventListener('pointerdown', onPointerDown, true);
            this.parent.removeEventListener('pointermove', onPointerMove, true);
            this.parent.removeEventListener('pointerup', onPointerUp, true);
            window.removeEventListener('keydown', onKeyDown, true);
            if (!this.committed && this.splat) {
                this.session.abandon();
                restoreOriginalSelection()
                .catch(error => console.error('[MultiViewRefine] selection restore failed', error));
                this.events.fire('multiViewRefine.abandoned');
            }
        };
    }
}

export { MultiViewRefineSelection };
