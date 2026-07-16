import { Events } from '../events';
import { Scene } from '../scene';
import {
    buildArtisanViewKey,
    encodeIndexRanges
} from './artisan-selection';
import { CloudSam3Provider } from '../segmentation/cloud-sam3-provider';
import {
    captureSegmentationFrame,
    encodeSegmentationFramePng,
    resolveSegmentationCaptureSize
} from '../segmentation/frame';
import {
    applyLiftedSegmentation,
    currentSelectionIds,
    liftSegmentationResult,
    previewLiftedSegmentation,
    type LiftedSegmentation
} from '../segmentation/lift';
import { LocalSam2Provider, TOTAL_MODEL_BYTES, type LocalSam2Progress } from '../segmentation/local-sam2-provider';
import {
    resampleMaskToFrame,
    type BlindGrade,
    type SegmentationFrame,
    type SegmentationOperation,
    type SegmentationPrompt,
    type SegmentationResult
} from '../segmentation/provider';
import { Splat } from '../splat';

type LocalMode = SegmentationOperation | 'refine-positive' | 'refine-negative' | 'compare';
type LocalPromptSession = {
    viewKey: string;
    frame: SegmentationFrame;
    prompts: SegmentationPrompt[];
    operation: SegmentationOperation;
    baseSelection: Set<number>;
    priorMask?: Float32Array;
};
type CompareCandidate = {
    result: SegmentationResult | null;
    lifted: LiftedSegmentation | null;
    error?: string;
    errorPhase?: string;
};
type CompareSlot = 'a' | 'b';

const formatBytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
const preciseMs = (value: number) => Number(value.toFixed(3));

const encodeMaskRle = (mask: Uint8Array) => {
    if (mask.length === 0) return [];
    const runs: number[] = [];
    let value = mask[0] > 0 ? 1 : 0;
    let count = 1;
    for (let index = 1; index < mask.length; index++) {
        const next = mask[index] > 0 ? 1 : 0;
        if (next === value) count++;
        else {
            runs.push(value, count);
            value = next;
            count = 1;
        }
    }
    runs.push(value, count);
    return runs;
};

class LocalSegmentSelection {
    activate: () => void;
    deactivate: () => void;
    active = false;

    constructor(events: Events, scene: Scene, parent: HTMLElement) {
        const canvas = scene.canvas;
        let busy = false;
        let mode: LocalMode = 'set';
        let runAbort: AbortController | null = null;
        let ready = false;
        let promptSession: LocalPromptSession | null = null;
        let lastBundle: Record<string, unknown> | null = null;
        const bundles: Record<string, unknown>[] = [];

        const toolbar = document.createElement('div');
        toolbar.className = 'select-toolbar hidden';
        toolbar.id = 'local-segment-toolbar';
        toolbar.addEventListener('pointerdown', event => event.stopPropagation());
        const status = document.createElement('span');
        status.className = 'local-segment-status';
        status.textContent = `Local SAM2 · ${formatBytes(TOTAL_MODEL_BYTES)} first use`;
        const buttons = new Map<LocalMode, HTMLButtonElement>();
        const syncModeButtons = () => {
            for (const [value, button] of buttons) button.classList.toggle('active', value === mode);
        };
        const addModeButton = (value: LocalMode, label: string) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'select-toolbar-button';
            button.textContent = label;
            button.dataset.mode = value;
            button.addEventListener('click', () => {
                mode = value;
                syncModeButtons();
            });
            buttons.set(value, button);
            toolbar.appendChild(button);
            return button;
        };
        const loadButton = document.createElement('button');
        loadButton.type = 'button';
        loadButton.className = 'select-toolbar-button';
        loadButton.textContent = `Load ${formatBytes(TOTAL_MODEL_BYTES)}`;
        const cancelButton = document.createElement('button');
        cancelButton.type = 'button';
        cancelButton.className = 'select-toolbar-button hidden';
        cancelButton.textContent = 'Cancel';
        toolbar.append(status, loadButton, cancelButton);
        addModeButton('set', 'New');
        addModeButton('add', 'Add');
        addModeButton('remove', 'Remove');
        addModeButton('intersect', 'Intersect');
        addModeButton('refine-positive', 'Refine +');
        addModeButton('refine-negative', 'Refine −');
        addModeButton('compare', 'Compare Local vs Cloud');
        parent.appendChild(toolbar);

        const comparePanel = document.createElement('div');
        comparePanel.id = 'segmentation-compare-panel';
        comparePanel.className = 'segmentation-compare-panel hidden';
        comparePanel.addEventListener('pointerdown', event => event.stopPropagation());
        const compareTitle = document.createElement('strong');
        compareTitle.textContent = 'Blind Local vs Cloud comparison';
        const compareStatus = document.createElement('span');
        const candidates = document.createElement('div');
        candidates.className = 'segmentation-compare-candidates';
        const createCandidate = (slot: CompareSlot) => {
            const wrapper = document.createElement('div');
            const title = document.createElement('strong');
            title.textContent = slot.toUpperCase();
            const canvas = document.createElement('canvas');
            canvas.width = 256;
            canvas.height = 144;
            canvas.dataset.slot = slot;
            const preview = document.createElement('button');
            preview.type = 'button';
            preview.textContent = `Preview ${slot.toUpperCase()} in 3D`;
            wrapper.append(title, canvas, preview);
            candidates.appendChild(wrapper);
            return { title, canvas, preview };
        };
        const candidateUi = { a: createCandidate('a'), b: createCandidate('b') };
        const maskGrade = document.createElement('div');
        const cutGrade = document.createElement('div');
        const createGradeRow = (label: string, parent: HTMLElement) => {
            const text = document.createElement('span');
            text.textContent = label;
            parent.appendChild(text);
            const row = new Map<BlindGrade, HTMLButtonElement>();
            for (const grade of ['a', 'b', 'tie'] as const) {
                const button = document.createElement('button');
                button.type = 'button';
                button.textContent = grade.toUpperCase();
                parent.appendChild(button);
                row.set(grade, button);
            }
            return row;
        };
        const maskGradeButtons = createGradeRow('Better 2D mask:', maskGrade);
        const cutGradeButtons = createGradeRow('Better 3D cut:', cutGrade);
        const clearPreview = document.createElement('button');
        const applyA = document.createElement('button');
        const applyB = document.createElement('button');
        const download = document.createElement('button');
        const close = document.createElement('button');
        clearPreview.type = applyA.type = applyB.type = download.type = close.type = 'button';
        clearPreview.textContent = 'Show normal scene';
        applyA.textContent = 'Apply A';
        applyB.textContent = 'Apply B';
        download.textContent = 'Download benchmark bundle';
        close.textContent = 'Close';
        clearPreview.disabled = true;
        applyA.disabled = true;
        applyB.disabled = true;
        download.disabled = true;
        comparePanel.append(
            compareTitle,
            compareStatus,
            candidates,
            clearPreview,
            maskGrade,
            cutGrade,
            applyA,
            applyB,
            download,
            close
        );
        parent.appendChild(comparePanel);

        let compareSlots: Record<CompareSlot, CompareCandidate> | null = null;
        let compareMapping: Record<CompareSlot, SegmentationResult['provider'] | 'failed'> | null = null;
        let maskGradeValue: BlindGrade | null = null;
        let cutGradeValue: BlindGrade | null = null;

        syncModeButtons();

        const handleProgress = (progress: LocalSam2Progress) => {
            const percent = Math.round(progress.loadedBytes / progress.totalBytes * 100);
            if (progress.phase === 'ready') {
                ready = true;
                loadButton.classList.add('hidden');
                cancelButton.classList.add('hidden');
                status.textContent = `Local SAM2 ready · ${progress.executionProvider}`;
                if (progress.executionProvider === 'wasm') {
                    events.fire('toast', 'Local SAM2 is using WASM fallback; expect slower inference.', 'warning');
                }
                return;
            }
            cancelButton.classList.remove('hidden');
            loadButton.classList.add('hidden');
            status.textContent = `${progress.phase} ${progress.artifact ?? 'runtime'} · ${percent}%`;
        };
        const localProvider = new LocalSam2Provider(handleProgress);
        const cloudProvider = new CloudSam3Provider();
        const benchmarkCase = {
            id: new URLSearchParams(window.location.search).get('segmentationCase'),
            category: new URLSearchParams(window.location.search).get('segmentationCategory')
        };

        const ensureReady = async (signal: AbortSignal) => {
            await localProvider.ensureReady(signal);
            ready = true;
        };

        const beginLoad = async () => {
            if (busy || ready) return;
            busy = true;
            runAbort = new AbortController();
            try {
                await ensureReady(runAbort.signal);
            } catch (error: any) {
                if (error?.name !== 'AbortError') {
                    console.error('[Local SAM2] load failed', error);
                    events.fire('toast', error?.message || 'Local SAM2 failed to load.', 'error');
                }
                status.textContent = error?.name === 'AbortError' ? 'Local SAM2 load cancelled' : 'Local SAM2 unavailable';
                loadButton.classList.remove('hidden');
            } finally {
                cancelButton.classList.add('hidden');
                busy = false;
                runAbort = null;
            }
        };
        loadButton.addEventListener('click', beginLoad);
        cancelButton.addEventListener('click', () => runAbort?.abort());

        const drawMask = (target: HTMLCanvasElement, result: SegmentationResult | null, frame: SegmentationFrame) => {
            target.height = Math.max(1, Math.round(target.width * frame.height / frame.width));
            const context = target.getContext('2d')!;
            context.clearRect(0, 0, target.width, target.height);
            if (!result) {
                context.fillStyle = '#301010';
                context.fillRect(0, 0, target.width, target.height);
                context.fillStyle = '#fff';
                context.fillText('Failed', 12, 24);
                return;
            }
            const frameMask = resampleMaskToFrame(result.mask, frame.width, frame.height);
            const source = document.createElement('canvas');
            source.width = frame.width;
            source.height = frame.height;
            const sourceContext = source.getContext('2d')!;
            const image = sourceContext.createImageData(frame.width, frame.height);
            for (let index = 0; index < frameMask.length; index++) {
                const pixel = index * 4;
                if (frameMask[index] > 0) {
                    image.data[pixel] = 70;
                    image.data[pixel + 1] = 255;
                    image.data[pixel + 2] = 180;
                    image.data[pixel + 3] = 255;
                }
            }
            sourceContext.putImageData(image, 0, 0);
            context.imageSmoothingEnabled = false;
            context.drawImage(source, 0, 0, target.width, target.height);
        };

        const revealComparison = () => {
            if (!compareSlots || !compareMapping || !maskGradeValue || !cutGradeValue) return;
            candidateUi.a.title.textContent = `A · ${compareMapping.a}`;
            candidateUi.b.title.textContent = `B · ${compareMapping.b}`;
            compareStatus.textContent = `2D: ${maskGradeValue.toUpperCase()} · 3D: ${cutGradeValue.toUpperCase()}`;
            applyA.disabled = !compareSlots.a.lifted;
            applyB.disabled = !compareSlots.b.lifted;
            download.disabled = false;
            if (lastBundle) {
                lastBundle.grades = { mask: maskGradeValue, cut: cutGradeValue };
                lastBundle.mapping = compareMapping;
                lastBundle.revealedAt = new Date().toISOString();
            }
        };
        const attachGrades = (buttons: Map<BlindGrade, HTMLButtonElement>, kind: 'mask' | 'cut') => {
            Array.from(buttons.entries()).forEach(([grade, button]) => {
                button.addEventListener('click', () => {
                    if (kind === 'mask') maskGradeValue = grade;
                    else cutGradeValue = grade;
                    for (const [value, item] of buttons) item.classList.toggle('active', value === grade);
                    revealComparison();
                });
            });
        };
        attachGrades(maskGradeButtons, 'mask');
        attachGrades(cutGradeButtons, 'cut');

        const normalComparisonStatus = () => {
            return maskGradeValue && cutGradeValue ?
                `2D: ${maskGradeValue.toUpperCase()} · 3D: ${cutGradeValue.toUpperCase()}` :
                'Grade both outputs before identities are revealed.';
        };
        const clearCandidatePreview = () => {
            const splat = events.invoke('selection') as Splat;
            if (splat) previewLiftedSegmentation(splat, null);
            candidateUi.a.preview.classList.remove('active');
            candidateUi.b.preview.classList.remove('active');
            clearPreview.disabled = true;
            compareStatus.textContent = normalComparisonStatus();
        };
        const previewCandidate = (slot: CompareSlot) => {
            const splat = events.invoke('selection') as Splat;
            const candidate = compareSlots?.[slot];
            if (!splat || !candidate?.lifted) return;
            const startedAt = performance.now();
            previewLiftedSegmentation(splat, candidate.lifted);
            candidateUi.a.preview.classList.toggle('active', slot === 'a');
            candidateUi.b.preview.classList.toggle('active', slot === 'b');
            clearPreview.disabled = false;
            compareStatus.textContent = `Previewing ${slot.toUpperCase()} · ${candidate.lifted.selectedIds.size.toLocaleString()} Gaussians · selection unchanged`;
            if (lastBundle) {
                lastBundle.preview = {
                    slot,
                    selectedCount: candidate.lifted.selectedIds.size,
                    ms: preciseMs(performance.now() - startedAt)
                };
            }
        };
        clearPreview.addEventListener('click', clearCandidatePreview);

        const applySlot = async (slot: CompareSlot) => {
            const candidate = compareSlots?.[slot];
            if (!candidate?.lifted) return;
            const splat = events.invoke('selection') as Splat;
            if (!splat) return;
            const startedAt = performance.now();
            await applyLiftedSegmentation(events, splat, candidate.lifted);
            clearCandidatePreview();
            comparePanel.classList.add('hidden');
            if (lastBundle) {
                lastBundle.applied = slot;
                lastBundle.applyMs = preciseMs(performance.now() - startedAt);
            }
        };
        applyA.addEventListener('click', () => applySlot('a'));
        applyB.addEventListener('click', () => applySlot('b'));
        candidateUi.a.preview.addEventListener('click', () => previewCandidate('a'));
        candidateUi.b.preview.addEventListener('click', () => previewCandidate('b'));
        close.addEventListener('click', () => {
            clearCandidatePreview();
            comparePanel.classList.add('hidden');
        });
        download.addEventListener('click', () => {
            if (!lastBundle) return;
            const blob = new Blob([JSON.stringify(lastBundle, null, 2)], { type: 'application/json' });
            const link = document.createElement('a');
            link.download = `segmentation-compare-${lastBundle.id}.json`;
            link.href = URL.createObjectURL(blob);
            link.click();
            window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
        });

        const runCompare = async (
            splat: Splat,
            frame: SegmentationFrame,
            click: [number, number],
            signal: AbortSignal,
            captureTimings: unknown
        ) => {
            clearCandidatePreview();
            compareStatus.textContent = 'Running both providers…';
            comparePanel.classList.remove('hidden');
            const prompts: SegmentationPrompt[] = [{ x: click[0], y: click[1], label: 1 }];
            const startedAt = performance.now();
            const [localSettled, cloudSettled] = await Promise.allSettled([
                localProvider.segment({ frame, prompts, signal }),
                cloudProvider.segment({ frame, prompts, signal })
            ]);
            const lift = (settled: PromiseSettledResult<SegmentationResult>): CompareCandidate => {
                if (settled.status === 'rejected') {
                    return {
                        result: null,
                        lifted: null,
                        error: settled.reason?.message || String(settled.reason),
                        errorPhase: settled.reason?.phase || settled.reason?.name || 'unknown'
                    };
                }
                return {
                    result: settled.value,
                    lifted: liftSegmentationResult(scene, splat, frame, settled.value, 'set', click)
                };
            };
            const local = lift(localSettled);
            const cloud = lift(cloudSettled);
            const swap = crypto.getRandomValues(new Uint32Array(1))[0] % 2 === 1;
            compareSlots = swap ? { a: cloud, b: local } : { a: local, b: cloud };
            compareMapping = {
                a: compareSlots.a.result?.provider ?? 'failed',
                b: compareSlots.b.result?.provider ?? 'failed'
            };
            maskGradeValue = null;
            cutGradeValue = null;
            applyA.disabled = true;
            applyB.disabled = true;
            download.disabled = true;
            for (const buttons of [maskGradeButtons, cutGradeButtons]) {
                for (const button of buttons.values()) button.classList.remove('active');
            }
            candidateUi.a.title.textContent = 'A';
            candidateUi.b.title.textContent = 'B';
            drawMask(candidateUi.a.canvas, compareSlots.a.result, frame);
            drawMask(candidateUi.b.canvas, compareSlots.b.result, frame);
            compareStatus.textContent = 'Grade both outputs before identities are revealed.';
            const serializeCandidate = (candidate: CompareCandidate) => (candidate.result ? {
                provider: candidate.result.provider,
                model: candidate.result.model,
                modelDigest: candidate.result.modelDigest,
                runtime: candidate.result.runtime,
                executionProvider: candidate.result.executionProvider,
                cacheState: candidate.result.cacheState,
                timings: candidate.result.timings,
                liftMs: candidate.lifted?.liftMs,
                selectedCount: candidate.lifted?.selectedIds.size,
                candidateCutRanges: candidate.lifted ? encodeIndexRanges(candidate.lifted.selectedIds) : [],
                mask: {
                    width: candidate.result.mask.width,
                    height: candidate.result.mask.height,
                    frameToMask: candidate.result.mask.frameToMask,
                    rle: encodeMaskRle(candidate.result.mask.data)
                }
            } : { error: candidate.error, phase: candidate.errorPhase });
            lastBundle = {
                id: `${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`,
                createdAt: new Date().toISOString(),
                totalMs: preciseMs(performance.now() - startedAt),
                captureTimings,
                frame: {
                    width: frame.width,
                    height: frame.height,
                    key: frame.key,
                    camera: frame.camera,
                    pngBase64: encodeSegmentationFramePng(frame)
                },
                prompt: prompts,
                selectionBeforeRanges: encodeIndexRanges(currentSelectionIds(splat)),
                sceneSplats: splat.splatData.numSplats,
                viewport: [canvas.clientWidth, canvas.clientHeight],
                devicePixelRatio: window.devicePixelRatio,
                userAgent: navigator.userAgent,
                gpu: (scene.app.graphicsDevice as unknown as { unmaskedRenderer?: string }).unmaskedRenderer ?? 'unreported',
                benchmarkCase,
                local: serializeCandidate(local),
                cloud: serializeCandidate(cloud),
                grades: null,
                mapping: null,
                applied: null
            };
            bundles.push(lastBundle);
            events.fire('segmentationCompare.completed', lastBundle);
        };

        const pointerHandler = async (event: PointerEvent) => {
            if (!this.active || event.target !== canvas || busy) return;
            if (event.pointerType === 'mouse' && event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            const splat = events.invoke('selection') as Splat;
            if (!splat) {
                events.fire('toast', 'No splat loaded.', 'warning');
                return;
            }
            const rect = canvas.getBoundingClientRect();
            const canvasPoint: [number, number] = [event.clientX - rect.left, event.clientY - rect.top];
            busy = true;
            runAbort = new AbortController();
            parent.style.cursor = 'wait';
            cancelButton.classList.remove('hidden');
            try {
                if (mode !== 'compare') await ensureReady(runAbort.signal);
                const refine = mode === 'refine-positive' || mode === 'refine-negative';
                let frame: SegmentationFrame;
                let prompts: SegmentationPrompt[];
                let operation: SegmentationOperation;
                let baseSelection: Set<number>;
                let click: [number, number];
                let captureTimings: unknown = null;
                if (refine) {
                    if (!promptSession) throw new Error('Start with New, Add, Remove, or Intersect before refining.');
                    const currentKey = buildArtisanViewKey(scene, splat, promptSession.frame.width, promptSession.frame.height);
                    if (currentKey !== promptSession.viewKey) {
                        promptSession = null;
                        throw new Error('The camera changed; start a new local mask before refining.');
                    }
                    frame = promptSession.frame;
                    const scaleX = frame.width / Math.max(1, canvas.clientWidth);
                    const scaleY = frame.height / Math.max(1, canvas.clientHeight);
                    click = [Math.round(canvasPoint[0] * scaleX), Math.round(canvasPoint[1] * scaleY)];
                    prompts = [...promptSession.prompts, {
                        x: click[0],
                        y: click[1],
                        label: mode === 'refine-positive' ? 1 : 0
                    }];
                    operation = promptSession.operation;
                    baseSelection = promptSession.baseSelection;
                } else {
                    previewLiftedSegmentation(splat, null);
                    const captured = await captureSegmentationFrame(events, scene, splat);
                    frame = captured.frame;
                    captureTimings = captured.timings;
                    click = [
                        Math.round(canvasPoint[0] * captured.captureSize.scale),
                        Math.round(canvasPoint[1] * captured.captureSize.scale)
                    ];
                    prompts = [{ x: click[0], y: click[1], label: 1 }];
                    operation = mode === 'set' || mode === 'add' || mode === 'remove' || mode === 'intersect' ?
                        mode :
                        'set';
                    baseSelection = currentSelectionIds(splat);
                }
                if (mode === 'compare') {
                    await runCompare(splat, frame, click, runAbort.signal, captureTimings);
                    return;
                }
                const result = await localProvider.segment({
                    frame,
                    prompts,
                    priorMask: refine ? promptSession?.priorMask : undefined,
                    signal: runAbort.signal
                });
                const lifted = liftSegmentationResult(scene, splat, frame, result, operation, click, baseSelection);
                if (!lifted) throw new Error('Local SAM2 mask did not lift to visible Gaussians.');
                await applyLiftedSegmentation(events, splat, lifted);
                promptSession = {
                    viewKey: frame.key,
                    frame,
                    prompts,
                    operation,
                    baseSelection,
                    priorMask: result.mask.logits
                };
                status.textContent = `Local SAM2 · ${result.executionProvider} · ${result.timings.totalMs.toFixed(0)}ms`;
            } catch (error: any) {
                if (error?.name !== 'AbortError') {
                    console.error('[Local SAM2] selection failed', error);
                    events.fire('toast', error?.message || 'Local SAM2 selection failed.', 'error');
                }
            } finally {
                busy = false;
                runAbort = null;
                cancelButton.classList.add('hidden');
                if (this.active) parent.style.cursor = 'crosshair';
            }
        };

        events.function('localSegment.status', () => ({ active: this.active, busy, ready, mode, hasPromptSession: !!promptSession }));
        events.function('segmentationCompare.lastBundle', () => lastBundle);
        events.function('segmentationCompare.bundles', () => [...bundles]);

        this.activate = () => {
            this.active = true;
            toolbar.classList.remove('hidden');
            parent.style.cursor = 'crosshair';
            parent.addEventListener('pointerdown', pointerHandler, true);
            if (!ready) {
                events.fire('toast', `Local SAM2 runs in this browser. First use downloads ${formatBytes(TOTAL_MODEL_BYTES)}.`, 'info');
            }
        };
        this.deactivate = () => {
            this.active = false;
            toolbar.classList.add('hidden');
            comparePanel.classList.add('hidden');
            parent.style.cursor = '';
            parent.removeEventListener('pointerdown', pointerHandler, true);
            runAbort?.abort();
            runAbort = null;
            promptSession = null;
            busy = false;
            const splat = events.invoke('selection') as Splat;
            if (splat) previewLiftedSegmentation(splat, null);
        };

        // Keep the size helper reachable in debug bundles and ensure local/cloud use the same policy.
        events.function('segmentation.captureSize', (width: number, height: number) => resolveSegmentationCaptureSize(width, height));
    }
}

export { LocalSegmentSelection };
