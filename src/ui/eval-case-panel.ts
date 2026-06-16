import { Events } from '../events';

// Dev-tools panel for browsing, previewing, editing, and re-running Boxer eval
// cases. Opens the fixture file straight from disk via the File System Access
// API, so edits save back to the real scripts/boxer-evals/*.json(l) files.

type EvalTarget = {
    type: 'axis_aligned_box';
    center: [number, number, number];
    dimensions: [number, number, number];
    rotation: number[][];
};

type EvalCase = {
    captured_at?: string;
    prompt?: { type?: string; click_xy?: [number, number]; brush?: { points?: [number, number][] } };
    target?: EvalTarget | null;
    target_label?: string;
    camera?: unknown;
    frame?: unknown;
    [key: string]: unknown;
};

type FixtureFormat = 'json' | 'jsonl';

const PANEL_STYLE = [
    'position:fixed',
    'right:16px',
    'top:72px',
    'z-index:10000',
    'width:320px',
    'max-height:78vh',
    'overflow-y:auto',
    'box-sizing:border-box',
    'padding:12px',
    'border:1px solid rgba(255,255,255,0.18)',
    'border-radius:6px',
    'background:rgba(20,22,25,0.94)',
    'box-shadow:0 8px 24px rgba(0,0,0,0.26)',
    'color:#f4f4f4',
    'font:12px/1.4 monospace',
    'pointer-events:auto',
    'user-select:none'
].join(';');

const BUTTON_STYLE = [
    'background:#2a2e33',
    'color:#f4f4f4',
    'border:1px solid rgba(255,255,255,0.22)',
    'border-radius:4px',
    'padding:3px 8px',
    'font:11px monospace',
    'cursor:pointer'
].join(';');

const button = (label: string, onClick: () => void) => {
    const el = document.createElement('button');
    el.textContent = label;
    el.style.cssText = BUTTON_STYLE;
    el.addEventListener('click', onClick);
    return el;
};

class EvalCasePanel {
    constructor(events: Events) {
        let cases: EvalCase[] = [];
        let format: FixtureFormat = 'json';
        let fileHandle: FileSystemFileHandle | null = null;
        let fileName = '';
        let selectedIndex = -1;
        let dirty = false;

        const panel = document.createElement('div');
        panel.id = 'eval-case-panel';
        panel.style.cssText = PANEL_STYLE;
        panel.style.display = 'none';

        const toggle = document.createElement('button');
        toggle.textContent = 'Evals';
        toggle.title = 'Eval case browser/editor';
        toggle.style.cssText = `${BUTTON_STYLE};position:fixed;right:16px;top:40px;z-index:10000`;
        toggle.addEventListener('click', () => {
            panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
        });

        const header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:8px';
        const title = document.createElement('span');
        title.textContent = 'Eval Cases';
        title.style.cssText = 'font-weight:600';
        const openButton = button('Open…', () => {
            openFile();
        });
        const saveButton = button('Save', () => {
            saveFile();
        });
        const switchButton = button('⇄', () => {
            const next = fileName === 'live-brush-evals.jsonl' ? 'desk-can-brush-human-v1.json' : 'live-brush-evals.jsonl';
            loadFixtureByName(next);
        });
        switchButton.title = 'Switch between live-brush-evals.jsonl and desk-can-brush-human-v1.json (always fresh from disk)';
        const addLastRunButton = button('+ Add last run', () => {
            addLastBrushRun();
        });
        addLastRunButton.title = 'Append the most recent brush run (current camera + stroke + sticky target) as a new case';
        addLastRunButton.style.background = '#2f6feb';
        header.append(title, openButton, switchButton, saveButton, addLastRunButton);

        // drag the panel by its header to get it out of the way of the other
        // debug panels that stack in the same corner
        let headerDrag: { pointerId: number; offsetX: number; offsetY: number } | null = null;
        title.style.cursor = 'grab';
        title.addEventListener('pointerdown', (event) => {
            const rect = panel.getBoundingClientRect();
            headerDrag = { pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
            title.setPointerCapture(event.pointerId);
            event.preventDefault();
        });
        title.addEventListener('pointermove', (event) => {
            if (!headerDrag || headerDrag.pointerId !== event.pointerId) return;
            panel.style.right = 'auto';
            panel.style.left = `${event.clientX - headerDrag.offsetX}px`;
            panel.style.top = `${event.clientY - headerDrag.offsetY}px`;
        });
        title.addEventListener('pointerup', (event) => {
            if (headerDrag?.pointerId === event.pointerId) {
                title.releasePointerCapture(event.pointerId);
                headerDrag = null;
            }
        });

        const fileInfo = document.createElement('div');
        fileInfo.style.cssText = 'color:#9aa3ab;margin-bottom:8px;word-break:break-all';
        fileInfo.textContent = 'No file loaded. Open a scripts/boxer-evals/*.json(l) fixture.';

        const list = document.createElement('div');
        list.style.cssText = 'display:flex;flex-direction:column;gap:2px;margin-bottom:10px';

        const detail = document.createElement('div');
        detail.style.cssText = 'border-top:1px solid rgba(255,255,255,0.14);padding-top:8px;display:none';

        const promptInfo = document.createElement('div');
        promptInfo.style.cssText = 'color:#9aa3ab;margin-bottom:6px';

        const targetGrid = document.createElement('div');
        targetGrid.style.cssText = 'display:grid;grid-template-columns:64px 1fr 1fr 1fr;gap:4px;align-items:center;margin-bottom:8px';

        const targetInputs: Record<'center' | 'dimensions', HTMLInputElement[]> = { center: [], dimensions: [] };
        for (const field of ['center', 'dimensions'] as const) {
            const label = document.createElement('span');
            label.textContent = field === 'center' ? 'center' : 'dims';
            targetGrid.appendChild(label);
            for (let axis = 0; axis < 3; axis++) {
                const input = document.createElement('input');
                input.type = 'number';
                input.step = '0.05';
                input.style.cssText = 'width:100%;box-sizing:border-box;background:#15171a;color:#f4f4f4;border:1px solid rgba(255,255,255,0.18);border-radius:3px;padding:2px 4px;font:11px monospace';
                input.addEventListener('change', () => applyTargetEdit());
                targetInputs[field].push(input);
                targetGrid.appendChild(input);
            }
        }

        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px';
        const previewButton = button('Preview', () => {
            previewSelected();
        });
        const runButton = button('Run case', () => {
            runSelected();
        });
        const editInSceneButton = button('Edit in scene', () => {
            editTargetInScene();
        });
        editInSceneButton.title = 'Open the manual box tool seeded with this target — drag the gizmo, adjust dims';
        const applyBoxButton = button('Apply box', () => {
            applyBoxFromScene();
        });
        applyBoxButton.title = 'Copy the manual box tool’s current box back into this case’s target';
        actions.append(previewButton, runButton, editInSceneButton, applyBoxButton);

        const metricsInfo = document.createElement('div');
        metricsInfo.style.cssText = 'color:#ffb26d;white-space:pre-wrap';

        detail.append(promptInfo, targetGrid, actions, metricsInfo);
        panel.append(header, fileInfo, list, detail);
        document.body.append(toggle, panel);

        function updateFileInfo() {
            fileInfo.textContent = fileName ?
                `${fileName} · ${cases.length} cases${dirty ? ' · UNSAVED EDITS' : ''}` :
                'No file loaded. Open a scripts/boxer-evals/*.json(l) fixture.';
            saveButton.style.opacity = dirty ? '1' : '0.5';
        }

        function renderList() {
            list.innerHTML = '';
            cases.forEach((evalCase, index) => {
                const row = document.createElement('div');
                const time = evalCase.captured_at ? evalCase.captured_at.replace(/^\d{4}-\d{2}-\d{2}T/, '').replace(/\.\d+Z$/, '') : '';
                const strokePoints = evalCase.prompt?.brush?.points?.length ?? 0;
                row.textContent = `#${index} ${evalCase.prompt?.type ?? '?'} ${strokePoints ? `${strokePoints}pts` : ''} ${evalCase.target_label ?? ''} ${time}`;
                row.style.cssText = `cursor:pointer;padding:2px 6px;border-radius:3px;${index === selectedIndex ? 'background:#2f6feb;color:#fff' : ''}`;
                row.addEventListener('click', () => {
                    selectCase(index);
                });
                list.appendChild(row);
            });
        }

        function fillTargetInputs() {
            const target = cases[selectedIndex]?.target;
            for (const field of ['center', 'dimensions'] as const) {
                for (let axis = 0; axis < 3; axis++) {
                    targetInputs[field][axis].value = target ? String(Number(target[field][axis].toFixed(4))) : '';
                    targetInputs[field][axis].disabled = !target;
                }
            }
        }

        function applyTargetEdit() {
            const target = cases[selectedIndex]?.target;
            if (!target) return;
            for (const field of ['center', 'dimensions'] as const) {
                for (let axis = 0; axis < 3; axis++) {
                    const value = Number(targetInputs[field][axis].value);
                    if (Number.isFinite(value)) target[field][axis] = value;
                }
            }
            dirty = true;
            updateFileInfo();
            previewSelected();
        }

        async function previewSelected() {
            const evalCase = cases[selectedIndex];
            if (!evalCase) return;
            try {
                await events.invoke('boxer.previewEvalCase', evalCase);
            } catch (err) {
                metricsInfo.textContent = `preview failed: ${err instanceof Error ? err.message : err}`;
            }
        }

        async function selectCase(index: number) {
            selectedIndex = index;
            detail.style.display = 'block';
            metricsInfo.textContent = '';
            const evalCase = cases[index];
            const strokePoints = evalCase.prompt?.brush?.points?.length ?? 0;
            promptInfo.textContent = `prompt: ${evalCase.prompt?.type ?? '?'}${
                evalCase.prompt?.click_xy ? ` click=(${evalCase.prompt.click_xy.join(',')})` : ''
            }${strokePoints ? ` stroke=${strokePoints}pts` : ''
            }${evalCase.target ? '' : ' · NO TARGET'}`;
            fillTargetInputs();
            renderList();
            await previewSelected();
        }

        async function runSelected() {
            const evalCase = cases[selectedIndex];
            if (!evalCase) return;
            metricsInfo.textContent = 'running…';
            try {
                const replay = await events.invoke('boxer.runEvalCase', JSON.parse(JSON.stringify(evalCase))) as {
                    metrics?: { aabb_iou?: number; center_distance?: number };
                    client_brush_probe?: { selected_candidate_source?: string; brush_surface_demoted?: boolean };
                    boxer_result?: {
                        selection_truth?: { splat_count?: number; selected_after?: number };
                    };
                    selection_truth?: { splat_count?: number; selected_after?: number };
                };
                const iou = replay?.metrics?.aabb_iou;
                const center = replay?.metrics?.center_distance;
                const source = replay?.client_brush_probe?.selected_candidate_source;
                const truth = replay.selection_truth ?? replay.boxer_result?.selection_truth;
                const selectedSplats = truth?.selected_after ?? truth?.splat_count;
                metricsInfo.textContent =
                    `IoU ${iou === undefined ? '-' : iou.toFixed(3)}` +
                    `  center ${center === undefined ? '-' : center.toFixed(3)}${
                        source ? `\nselected: ${source}${replay.client_brush_probe?.brush_surface_demoted ? ' (surface demoted)' : ''}` : ''
                    }${selectedSplats === undefined ? '' : `\nselected splats: ${selectedSplats}`}`;
            } catch (err) {
                metricsInfo.textContent = `run failed: ${err instanceof Error ? err.message : err}`;
            }
        }

        function editTargetInScene() {
            const target = cases[selectedIndex]?.target;
            if (!target) {
                metricsInfo.textContent = 'this case has no target to edit';
                return;
            }
            // declutter: drop boxer wireframes/overlays and any selection
            // highlight so only the editable box is visible
            events.invoke('boxer.clearOverlays');
            events.fire('select.none');
            events.fire('tool.boxSelection');
            const seeded = events.invoke('boxSelection.setBox', target);
            metricsInfo.textContent = seeded ?
                'box tool seeded with the target — Move/Resize, then hit Apply box' :
                'box tool is not available';
        }

        // fixtures reuse the same physical object across cases with slightly
        // different hand-drawn boxes; treat targets as "the same" when their
        // centers and dims are close, so one correction fans out to all of them
        function targetsMatch(a: EvalTarget, b: EvalTarget) {
            const centerDistance = Math.hypot(
                a.center[0] - b.center[0],
                a.center[1] - b.center[1],
                a.center[2] - b.center[2]
            );
            const dimsDelta = Math.max(
                Math.abs(a.dimensions[0] - b.dimensions[0]),
                Math.abs(a.dimensions[1] - b.dimensions[1]),
                Math.abs(a.dimensions[2] - b.dimensions[2])
            );
            return centerDistance <= 0.4 && dimsDelta <= 0.3;
        }

        function applyBoxFromScene() {
            const target = cases[selectedIndex]?.target;
            if (!target) return;
            const current = events.invoke('boxSelection.currentBox') as
                { center: [number, number, number]; dimensions: [number, number, number] } | undefined;
            if (!current) {
                metricsInfo.textContent = 'box tool has no current box';
                return;
            }
            const original: EvalTarget = JSON.parse(JSON.stringify(target));
            target.center = [...current.center];
            target.dimensions = [...current.dimensions];
            // propagate to every other case whose target matches the one we
            // just replaced (same object, slightly different rough box)
            let propagated = 0;
            cases.forEach((other, index) => {
                if (index === selectedIndex || !other.target) return;
                if (targetsMatch(other.target, original)) {
                    other.target.center = [...current.center];
                    other.target.dimensions = [...current.dimensions];
                    propagated += 1;
                }
            });
            dirty = true;
            updateFileInfo();
            fillTargetInputs();
            metricsInfo.textContent = `target updated${propagated ? ` (+${propagated} matching case${propagated > 1 ? 's' : ''} propagated)` : ''} — Save to persist`;
        }

        async function addLastBrushRun() {
            metricsInfo.textContent = 'capturing last brush run…';
            try {
                const evalCase = await events.invoke('boxer.copyLastBrushEvalCase', { copy_clipboard: false }) as EvalCase | null;
                if (!evalCase) {
                    metricsInfo.textContent = 'no brush run to capture — draw a stroke first';
                    return;
                }
                cases.push(evalCase);
                selectedIndex = cases.length - 1;
                dirty = true;
                updateFileInfo();
                renderList();
                detail.style.display = 'block';
                fillTargetInputs();
                metricsInfo.textContent = `case #${selectedIndex} added${evalCase.target ? ' (with target)' : ' — NO TARGET: set one via Save Target in the box tool first'} — Save to persist`;
            } catch (err) {
                metricsInfo.textContent = `capture failed: ${err instanceof Error ? err.message : err}`;
            }
        }

        function parseFixture(text: string, name: string): { cases: EvalCase[]; format: FixtureFormat } {
            if (name.endsWith('.jsonl')) {
                return {
                    cases: text.split('\n').map(line => line.trim()).filter(Boolean)
                    .map(line => JSON.parse(line) as EvalCase),
                    format: 'jsonl'
                };
            }
            const parsed = JSON.parse(text);
            if (!Array.isArray(parsed)) throw new Error('Fixture JSON must be an array of eval cases');
            return { cases: parsed as EvalCase[], format: 'json' };
        }

        async function openFile() {
            const picker = (window as unknown as {
                showOpenFilePicker?: (options?: unknown) => Promise<FileSystemFileHandle[]>;
            }).showOpenFilePicker;
            if (!picker) {
                metricsInfo.textContent = 'File System Access API unavailable in this browser';
                return;
            }
            try {
                const [handle] = await picker({
                    types: [{ description: 'Eval fixtures', accept: { 'application/json': ['.json', '.jsonl'] } }]
                });
                const file = await handle.getFile();
                const parsed = parseFixture(await file.text(), file.name);
                fileHandle = handle;
                fileName = file.name;
                cases = parsed.cases;
                format = parsed.format;
                selectedIndex = -1;
                dirty = false;
                detail.style.display = 'none';
                updateFileInfo();
                renderList();
            } catch (err) {
                if ((err as Error)?.name !== 'AbortError') {
                    fileInfo.textContent = `open failed: ${err instanceof Error ? err.message : err}`;
                }
            }
        }

        async function saveFile() {
            if (cases.length === 0) return;
            try {
                const text = format === 'jsonl' ?
                    `${cases.map(entry => JSON.stringify(entry)).join('\n')}\n` :
                    JSON.stringify(cases, null, 2);
                // primary path: local eval-save-server (node scripts/eval-save-server.mjs)
                try {
                    const response = await fetch('http://127.0.0.1:48013/save', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name: fileName, content: text })
                    });
                    const body = await response.json();
                    if (response.ok && body.ok) {
                        dirty = false;
                        updateFileInfo();
                        metricsInfo.textContent = `saved to ${body.path}`;
                        return;
                    }
                    metricsInfo.textContent = `save server rejected: ${body.error ?? response.status} — falling back to file picker`;
                } catch {
                    metricsInfo.textContent = 'save server not running (node scripts/eval-save-server.mjs) — falling back to file picker';
                }
                // auto-loaded fixtures have no disk handle yet; ask for one so
                // the user can overwrite the real scripts/boxer-evals file
                if (!fileHandle) {
                    const savePicker = (window as unknown as {
                        showSaveFilePicker?: (options?: unknown) => Promise<FileSystemFileHandle>;
                    }).showSaveFilePicker;
                    if (!savePicker) {
                        metricsInfo.textContent = 'File System Access API unavailable in this browser';
                        return;
                    }
                    fileHandle = await savePicker({
                        suggestedName: fileName || 'evals.json',
                        types: [{ description: 'Eval fixtures', accept: { 'application/json': ['.json', '.jsonl'] } }]
                    });
                }
                const writable = await (fileHandle as FileSystemFileHandle & {
                    createWritable: () => Promise<{ write: (data: string) => Promise<void>; close: () => Promise<void> }>;
                }).createWritable();
                await writable.write(text);
                await writable.close();
                dirty = false;
                updateFileInfo();
                metricsInfo.textContent = `saved ${fileName}`;
            } catch (err) {
                if ((err as Error)?.name !== 'AbortError') {
                    metricsInfo.textContent = `save failed: ${err instanceof Error ? err.message : err}`;
                }
            }
        }

        // auto-load the primary brush fixture. The save server reads the REAL
        // scripts/boxer-evals files; the bundled /static/evals copies are
        // frozen at build time and only serve as a fallback.
        async function fetchFixtureText(name: string): Promise<string | null> {
            try {
                const response = await fetch(`http://127.0.0.1:48013/file?name=${encodeURIComponent(name)}`);
                if (response.ok) {
                    const body = await response.json();
                    if (body.ok && typeof body.content === 'string') return body.content;
                }
            } catch {
                // save server down — fall through to the bundled copy
            }
            try {
                const response = await fetch(`./static/evals/${name}`);
                if (response.ok) return await response.text();
            } catch {
                // no bundled copy either
            }
            return null;
        }

        async function loadFixtureByName(name: string) {
            const text = await fetchFixtureText(name);
            if (text === null) return false;
            const parsed = parseFixture(text, name);
            fileHandle = null;
            fileName = name;
            cases = parsed.cases;
            format = parsed.format;
            selectedIndex = -1;
            dirty = false;
            detail.style.display = 'none';
            updateFileInfo();
            renderList();
            return true;
        }

        async function autoLoad() {
            const candidates = [
                'live-brush-evals.jsonl',
                'desk-can-brush-human-v1.json',
                'desk-can-latest3.json'
            ];
            for (const name of candidates) {
                if (await loadFixtureByName(name)) return;
            }
        }

        updateFileInfo();
        autoLoad();
    }
}

export { EvalCasePanel };
