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
        header.append(title, openButton, saveButton);

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
        actions.style.cssText = 'display:flex;gap:6px;margin-bottom:8px';
        const previewButton = button('Preview', () => {
            previewSelected();
        });
        const runButton = button('Run case', () => {
            runSelected();
        });
        actions.append(previewButton, runButton);

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
                };
                const iou = replay?.metrics?.aabb_iou;
                const center = replay?.metrics?.center_distance;
                const source = replay?.client_brush_probe?.selected_candidate_source;
                metricsInfo.textContent =
                    `IoU ${iou === undefined ? '-' : iou.toFixed(3)}` +
                    `  center ${center === undefined ? '-' : center.toFixed(3)}${
                        source ? `\nselected: ${source}${replay.client_brush_probe?.brush_surface_demoted ? ' (surface demoted)' : ''}` : ''}`;
            } catch (err) {
                metricsInfo.textContent = `run failed: ${err instanceof Error ? err.message : err}`;
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

        // auto-load the primary brush fixture served alongside the dev build;
        // saving will prompt for the real file location on disk
        async function autoLoad() {
            const candidates = [
                'desk-can-brush-human-v1.json',
                'live-brush-evals.jsonl',
                'desk-can-latest3.json'
            ];
            for (const name of candidates) {
                try {
                    const response = await fetch(`./static/evals/${name}`);
                    if (!response.ok) continue;
                    const parsed = parseFixture(await response.text(), name);
                    fileHandle = null;
                    fileName = name;
                    cases = parsed.cases;
                    format = parsed.format;
                    selectedIndex = -1;
                    dirty = false;
                    updateFileInfo();
                    renderList();
                    return;
                } catch {
                    // try the next fixture
                }
            }
        }

        updateFileInfo();
        autoLoad();
    }
}

export { EvalCasePanel };
