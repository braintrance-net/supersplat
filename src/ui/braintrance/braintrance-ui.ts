// ─────────────────────────────────────────────────────────────────────────
// Braintrance editor overlay — "Simplification" redesign.
//
// A self-contained DOM overlay layered over SuperSplat's live PlayCanvas
// viewport. Reproduces the persistent chrome from the Paper "best" frames
// (Explore / Selected / W - Move): top menu, project header + camera hints,
// left rail, snapshot panel, scrubber, and the selection contextual bar.
//
// Prototype philosophy (see braintrance-editor-prototype-spec.md): wire what's
// cheap; fake the rest. State here is local + visual so the *feel* reads. It
// can later be wired to SuperSplat's `Events` bus.
// ─────────────────────────────────────────────────────────────────────────

import { Color, Entity, RotateGizmo, ScaleGizmo, StandardMaterial, TranslateGizmo, Vec3 } from 'playcanvas';

type GizmoMode = 'move' | 'scale' | 'rotate';

type RailTool = 'explore' | 'sam' | 'audio' | 'assets';
type EditorState = 'explore' | 'selected';

// Placeholder colours (matching the frames: idle cube red, selected cube yellow)
const IDLE_DIFFUSE = new Color(0.83, 0.20, 0.18);
const SEL_DIFFUSE = new Color(1.0, 0.90, 0.0);

// ── icons (Lucide 24×24, matching the frame's stroke icons) ─────────────────
const stroke = (paths: string, size = 24) =>
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const fill = (paths: string, size = 24) =>
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor">${paths}</svg>`;

const ICON = {
    explore: stroke('<path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>'),
    sam: stroke('<path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72Z"/><path d="m14 7 3 3"/><path d="M5 6v4"/><path d="M19 14v4"/><path d="M10 2v2"/><path d="M7 8H3"/><path d="M21 16h-4"/><path d="M11 3H9"/>'),
    audio: stroke('<path d="M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6a1.4 1.4 0 0 1-1 .4H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z"/><path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.4 5.6a9 9 0 0 1 0 12.7"/>'),
    assets: stroke('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>'),
    back: stroke('<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>'),
    rotate: stroke('<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>'),
    pan: stroke('<path d="M5 9l-3 3 3 3"/><path d="M9 5l3-3 3 3"/><path d="M15 19l-3 3-3-3"/><path d="M19 9l3 3-3 3"/><path d="M2 12h20"/><path d="M12 2v20"/>'),
    zoom: stroke('<rect x="5" y="2" width="14" height="20" rx="7"/><path d="M12 6v4"/>'),
    play: fill('<polygon points="6 3 20 12 6 21 6 3"/>'),
    reset: stroke('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
    globe: stroke('<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>', 18),
    sparkles: stroke('<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/>', 15),
    zap: stroke('<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>', 15),
    pause: fill('<rect x="6" y="5" width="3.5" height="14" rx="1"/><rect x="14.5" y="5" width="3.5" height="14" rx="1"/>', 12),
    expand: stroke('<path d="M21 21l-6-6"/><path d="M21 15v6h-6"/><path d="M3 3l6 6"/><path d="M3 9V3h6"/>', 18),
    x: stroke('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>', 18),
    trash: stroke('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>', 15),
    chevronRight: stroke('<path d="m9 18 6-6-6-6"/>', 16),
    plus: stroke('<path d="M12 5v14"/><path d="M5 12h14"/>', 18),
    camera: stroke('<path d="m22 8-6 4 6 4V8Z"/><rect x="2" y="6" width="14" height="12" rx="2"/>', 18)
};

// Effect catalogue (faked — labels per spec §7.6). Presets are single-select
// (a new one replaces the prior), shader effects stack.
const COLOR_PRESETS = ['None', 'Warm', 'Cool', 'Vivid', 'Noir', 'Vintage', 'B&W', 'Faded'];
const SHADER_EFFECTS = ['Glow', 'Bloom', 'Blur', 'Outline', 'Pixelate', 'Scanlines', 'Depth fade', 'Point cloud'];

type Effect = { label: string; type: 'preset' | 'effect'; strength: number };

// Asset browser catalogue (hardcoded, per spec §7.10) + thumbnail gradients.
const ASSETS: Record<string, string[]> = {
    Gaussians: ['Potted plant', 'Armchair', 'Marble bust', 'Vase', 'Sneaker', 'Toy car'],
    Props: ['Cube', 'Sphere', 'Cylinder', 'Cone', 'Torus', 'Plane'],
    Sounds: ['Ambient pad', 'Footsteps', 'Birdsong', 'Rain', 'Wind', 'Chime']
};
const ASSET_GRADS = [
    'linear-gradient(135deg,#f6d365,#fda085)',
    'linear-gradient(135deg,#a1c4fd,#c2e9fb)',
    'linear-gradient(135deg,#d4fc79,#96e6a1)',
    'linear-gradient(135deg,#ffecd2,#fcb69f)',
    'linear-gradient(135deg,#e0c3fc,#8ec5fc)',
    'linear-gradient(135deg,#f5576c,#f093fb)'
];

// Audio content library (click to spawn). SFX = spatial, Music = stereo.
const AUDIO_LIB: { SFX: string[]; Music: string[] } = {
    SFX: ['Footsteps', 'Door creak', 'Birdsong', 'Rain', 'Wind', 'Chime', 'Whoosh', 'Splash'],
    Music: ['Cathedral tone', 'Ambient pad', 'Lo-fi loop', 'Drone', 'Piano', 'Strings']
};

const el = (tag: string, cls?: string, html?: string): HTMLElement => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
};

class BraintranceUI {
    root: HTMLElement;
    private state: EditorState = 'explore';
    private headerCenter!: HTMLElement;
    private bottomCenter!: HTMLElement; // hosts snapshot panel or context bar
    private railItems: Partial<Record<RailTool, HTMLElement>> = {};

    // scene integration (placeholder object + faked selection)
    private scene: any = null;
    private canvas: HTMLCanvasElement | null = null;
    private events: any = null;
    private box: Entity | null = null;
    private boxMat: StandardMaterial | null = null;
    private gizmo: any = null;            // active PlayCanvas transform gizmo
    private gizmoMode: GizmoMode | null = null;

    // the current selection's model — badges/counts read from here (the effects &
    // interactions already on it, per the fixture cube: 2 effects + 1 interaction)
    private selection: { name: string; effects: Effect[]; interactions: string[] } = {
        name: 'Cuboid',
        effects: [
            { label: 'Vivid', type: 'preset', strength: 60 },
            { label: 'Bloom', type: 'effect', strength: 50 }
        ],
        interactions: ['On click → moves + glows']
    };

    // effects-library state
    private effectsMode = false;            // context bar in chip view + library open
    private interactionsMode = false;       // context bar showing interaction chips + Add
    private openChip: number | null = null; // index of the chip whose strength popover is open
    private effectsPanel: HTMLElement | null = null;
    private strengthPop: HTMLElement | null = null;

    // audio-mode state (fixtures: one ambient bed + one unplaced spatial source)
    private audioMode = false;
    private audioPanel: HTMLElement | null = null;
    private audioBar: HTMLElement | null = null;
    private placingAudio = false;
    private audioMarkers: Entity[] = [];
    private activeAudio = 1;
    private audioSources = [
        { name: 'Cathedral tone', kind: 'Stereo', volume: 62, range: 8, loop: true, placed: true },
        { name: 'Footsteps', kind: 'Spatial', volume: 23, range: 8, loop: false, placed: false }
    ];

    // interaction-recording state
    private recordingMode = false;
    private recordBorder: HTMLElement | null = null;
    private recordBar: HTMLElement | null = null;

    // asset-browser state
    private assetsPanel: HTMLElement | null = null;
    private assetTab = 'Gaussians';
    private placedCount = 0;

    constructor() {
        document.body.classList.add('bt-mode');
        this.root = el('div');
        this.root.id = 'bt-overlay';

        this.root.appendChild(this.buildMenubar());
        this.root.appendChild(this.buildHeader());
        this.root.appendChild(this.buildRail());

        this.bottomCenter = el('div');
        this.root.appendChild(this.bottomCenter);
        this.root.appendChild(this.buildScrubber());

        document.body.appendChild(this.root);
        this.setState('explore');
    }

    // ── top menu strip ──
    private buildMenubar(): HTMLElement {
        const bar = el('div', 'bt-menubar');
        ['file', 'select', 'view', 'help'].forEach((label) => {
            bar.appendChild(el('div', 'bt-menubar-item', label));
        });
        return bar;
    }

    // ── project sub-header (back · title · center cluster) ──
    private buildHeader(): HTMLElement {
        const header = el('div', 'bt-header');
        header.appendChild(el('div', 'bt-back', ICON.back));
        header.appendChild(el('div', 'bt-project-title', 'Untitled Project'));
        this.headerCenter = el('div', 'bt-header-center');
        header.appendChild(this.headerCenter);
        return header;
    }

    // camera hints (Explore state)
    private exploreHints(): HTMLElement {
        const wrap = el('div', 'bt-header-center');
        const keys = el('div', 'bt-hint');
        keys.innerHTML = `<span class="bt-hint-keys">⌨</span><span>W A S D <span style="color:var(--bt-ink-3)">or Arrow keys to move</span></span>`;
        wrap.appendChild(keys);
        const hint = (icon: string, label: string) =>
            el('div', 'bt-hint', `${icon}<span>${label}</span>`);
        wrap.appendChild(hint(ICON.rotate, 'Rotate'));
        wrap.appendChild(hint(ICON.pan, 'Pan'));
        wrap.appendChild(hint(ICON.zoom, 'Zoom'));
        return wrap;
    }

    // transform tools (Selected state): Q Move · E Scale · R Rotate · F Frame · ⌘K Crop to · ⌫ Delete
    private selectedTopbar(): HTMLElement {
        const wrap = el('div', 'bt-header-center');
        const bar = el('div', 'bt-topbar');
        const tool = (key: string, label: string, opts: { mode?: GizmoMode; danger?: boolean; onClick?: () => void } = {}) => {
            const active = !!opts.mode && opts.mode === this.gizmoMode;
            const t = el('div', `bt-tool${active ? ' is-active' : ''}${opts.danger ? ' is-danger' : ''}`);
            t.innerHTML = `<span class="bt-key">${key}</span><span>${label}</span>`;
            if (opts.onClick) t.addEventListener('click', opts.onClick);
            return t;
        };
        bar.appendChild(tool('Q', 'Move', { mode: 'move', onClick: () => this.setGizmoMode('move') }));
        bar.appendChild(tool('E', 'Scale', { mode: 'scale', onClick: () => this.setGizmoMode('scale') }));
        bar.appendChild(tool('R', 'Rotate', { mode: 'rotate', onClick: () => this.setGizmoMode('rotate') }));
        bar.appendChild(tool('F', 'Frame', { onClick: () => this.frameSelection() }));
        bar.appendChild(tool('⌘K', 'Crop to'));
        bar.appendChild(tool('⌫', 'Delete', { danger: true, onClick: () => this.deleteSelection() }));
        wrap.appendChild(bar);
        return wrap;
    }

    // ── left rail ──
    private buildRail(): HTMLElement {
        const rail = el('div', 'bt-rail');
        const item = (tool: RailTool, icon: string, label: string, caret = false) => {
            const it = el('div', 'bt-rail-item');
            it.innerHTML = `${icon}<span class="bt-rail-label">${label}</span>${caret ? '<span class="bt-rail-caret"></span>' : ''}`;
            it.addEventListener('click', () => this.selectTool(tool));
            this.railItems[tool] = it;
            return it;
        };
        // Grouped at the top, matching the "best" frame (not Assets-pinned-bottom).
        rail.appendChild(item('explore', ICON.explore, 'Explore'));
        rail.appendChild(item('sam', ICON.sam, 'SAM', true));
        rail.appendChild(item('audio', ICON.audio, 'Audio'));
        rail.appendChild(item('assets', ICON.assets, 'Assets'));
        return rail;
    }

    // ── snapshot panel (Explore state) ──
    private snapshotPanel(): HTMLElement {
        const p = el('div', 'bt-snapshot');
        p.appendChild(el('button', 'bt-btn', 'Snapshot all'));
        p.appendChild(el('button', 'bt-btn', 'Remove snapshot'));
        p.appendChild(el('button', 'bt-icon-btn', ICON.reset));
        return p;
    }

    // ── selection contextual bar — default actions vs effect-chip view ──
    private contextBar(): HTMLElement {
        if (this.effectsMode) return this.contextBarChips();
        if (this.interactionsMode) return this.contextBarInteractions();
        return this.contextBarDefault();
    }

    // interaction chips: ‹ Cuboid · [On click → …] · [+ Add]
    private contextBarInteractions(): HTMLElement {
        const bar = el('div', 'bt-contextbar');
        const chips = el('div', 'bt-cb-chips');
        const back = el('div', 'bt-cb-back', ICON.back);
        back.addEventListener('click', () => this.closeInteractions());
        chips.appendChild(back);
        chips.appendChild(el('div', 'bt-cb-name', this.selection.name));
        this.selection.interactions.forEach((it) => {
            chips.appendChild(el('div', 'bt-chip bt-chip-int',
                `<span class="bt-chip-dot"></span><span>${it}</span><span class="bt-chip-caret">${ICON.chevronRight}</span>`));
        });
        const add = el('button', 'bt-chip bt-chip-add', `${ICON.plus}<span>Add</span>`);
        add.addEventListener('click', () => this.startRecording());
        chips.appendChild(add);
        bar.appendChild(chips);
        return bar;
    }

    private contextBarDefault(): HTMLElement {
        const bar = el('div', 'bt-contextbar');

        const head = el('div', 'bt-cb-head');
        head.appendChild(el('div', 'bt-cb-name', `${ICON.globe}<span>${this.selection.name}</span>`));
        head.appendChild(el('div', 'bt-pause', `${ICON.pause}<span>Pause</span>`));
        bar.appendChild(head);

        // Badges = the effects / interactions already on this selection.
        const actions = el('div', 'bt-cb-actions');
        const eff = el('button', 'bt-cb-btn bt-effect',
            `<span>Add Effect</span><span class="bt-cb-badge">${this.selection.effects.length} ${ICON.sparkles}</span>`);
        eff.addEventListener('click', () => this.openEffects());
        const inter = el('button', 'bt-cb-btn bt-interaction',
            `<span>Add interaction</span><span class="bt-cb-badge">${this.selection.interactions.length} ${ICON.zap}</span>`);
        inter.addEventListener('click', () => this.openInteractions());
        actions.appendChild(eff);
        actions.appendChild(inter);
        actions.appendChild(el('button', 'bt-icon-btn', ICON.reset));
        bar.appendChild(actions);

        bar.appendChild(el('div', 'bt-cb-hint', 'Shift click adds, ctrl click removes'));
        return bar;
    }

    private contextBarChips(): HTMLElement {
        const bar = el('div', 'bt-contextbar');
        const chips = el('div', 'bt-cb-chips');
        const back = el('div', 'bt-cb-back', ICON.back);
        back.addEventListener('click', () => this.closeEffects());
        chips.appendChild(back);
        chips.appendChild(el('div', 'bt-cb-name', this.selection.name));
        this.selection.effects.forEach((eff, i) => {
            const chip = el('button', `bt-chip${this.openChip === i ? ' is-open' : ''}`,
                `<span class="bt-chip-dot"></span><span>${eff.label}</span><span class="bt-chip-caret">${ICON.chevronRight}</span>`);
            chip.addEventListener('click', () => this.toggleChip(i));
            chips.appendChild(chip);
        });
        bar.appendChild(chips);
        return bar;
    }

    // ── scrubber ──
    private buildScrubber(): HTMLElement {
        const s = el('div', 'bt-scrubber');
        s.appendChild(el('button', 'bt-play', ICON.play));
        s.appendChild(el('div', 'bt-time', '0:51'));

        const track = el('div', 'bt-track');
        track.appendChild(el('div', 'bt-track-fill'));
        // seed captures (fixtures): two gray diamonds + a blue playhead
        const marker = (pct: number, playhead = false) => {
            const m = el('div', `bt-marker${playhead ? ' is-playhead' : ''}`);
            m.style.left = `${pct}%`;
            return m;
        };
        const fillBar = track.firstElementChild as HTMLElement;
        fillBar.style.width = '34%';
        track.appendChild(marker(14));
        track.appendChild(marker(34, true));
        track.appendChild(marker(60));
        s.appendChild(track);

        s.appendChild(el('div', 'bt-time', '2:31'));
        s.appendChild(el('div', 'bt-expand', ICON.expand));
        return s;
    }

    // ── state ──
    private setActiveTool(tool: RailTool) {
        (Object.keys(this.railItems) as RailTool[]).forEach((k) => {
            this.railItems[k]?.classList.toggle('is-active', k === tool);
        });
    }

    private selectTool(tool: RailTool) {
        if (tool !== 'audio') this.exitAudio();
        if (tool !== 'assets') this.closeAssets();
        if (tool === 'sam') {
            this.selectObject(true);
        } else if (tool === 'audio') {
            this.selectObject(false);
            this.setActiveTool('audio');
            this.enterAudio();
        } else if (tool === 'assets') {
            this.selectObject(false);
            this.setActiveTool('assets');
            this.openAssets();
        } else {
            this.selectObject(false);
            this.setActiveTool(tool);
        }
    }

    setState(state: EditorState) {
        this.state = state;
        this.refreshHeaderCenter();
        this.refreshBottom();
        // default active rail item matches state
        if (state === 'explore' && !Object.values(this.railItems).some(i => i?.classList.contains('is-active'))) {
            this.railItems.explore?.classList.add('is-active');
        }
    }

    // Re-render the bottom-center panel (audio bar vs context bar / chips vs snapshot).
    private refreshBottom() {
        let next: HTMLElement;
        if (this.recordingMode) next = el('div'); // center panel hidden; record bar is full-width
        else if (this.audioMode) next = this.buildAudioBar();
        else if (this.state === 'selected') next = this.contextBar();
        else next = this.snapshotPanel();
        this.bottomCenter.replaceWith(next);
        this.bottomCenter = next;
        this.audioBar = this.audioMode ? next : null;
    }

    // ── effects library ("Enhance with effects") ──
    private openEffects() {
        this.effectsMode = true;
        this.interactionsMode = false;
        this.openChip = null;
        this.refreshBottom();          // context bar → chip view
        this.hideStrengthPop();
        this.effectsPanel?.remove();
        this.effectsPanel = this.buildEffectsPanel();
        this.root.appendChild(this.effectsPanel);
    }

    private closeEffects() {
        this.effectsMode = false;
        this.openChip = null;
        this.effectsPanel?.remove(); this.effectsPanel = null;
        this.hideStrengthPop();
        if (this.state === 'selected') this.refreshBottom();
    }

    private openInteractions() {
        this.interactionsMode = true;
        this.effectsMode = false;
        this.effectsPanel?.remove(); this.effectsPanel = null;
        this.hideStrengthPop();
        this.refreshBottom(); // context bar → interaction chips + Add
    }

    private closeInteractions() {
        this.interactionsMode = false;
        if (this.state === 'selected') this.refreshBottom();
    }

    private buildEffectsPanel(): HTMLElement {
        const panel = el('div', 'bt-effects-panel');
        const head = el('div', 'bt-ep-head');
        head.appendChild(el('div', 'bt-ep-title', 'Enhance with effects'));
        const close = el('div', 'bt-ep-close', ICON.x);
        close.addEventListener('click', () => this.closeEffects());
        head.appendChild(close);
        panel.appendChild(head);

        panel.appendChild(el('div', 'bt-ep-search', 'Search effects…'));

        panel.appendChild(el('div', 'bt-ep-section', 'COLOR PRESETS'));
        const row = el('div', 'bt-ep-row');
        COLOR_PRESETS.forEach(name => row.appendChild(this.effectTile(name, 'preset')));
        panel.appendChild(row);

        panel.appendChild(el('div', 'bt-ep-strength',
            '<span>Strength</span><input type="range" min="0" max="100" value="60">'));

        panel.appendChild(el('div', 'bt-ep-section', 'SHADER EFFECTS'));
        const grid = el('div', 'bt-ep-grid');
        SHADER_EFFECTS.forEach(name => grid.appendChild(this.effectTile(name, 'effect')));
        panel.appendChild(grid);
        return panel;
    }

    private effectTile(name: string, type: 'preset' | 'effect'): HTMLElement {
        const swCls = name === 'None' ? 'is-none' : name === 'Cool' ? 'is-cool' : '';
        const tile = el('div', 'bt-tile',
            `<div class="bt-tile-sw ${swCls}"></div><span class="bt-tile-label">${name}</span>`);
        tile.addEventListener('click', () => this.applyEffect(name, type));
        return tile;
    }

    private applyEffect(label: string, type: 'preset' | 'effect') {
        if (label === 'None') {
            this.selection.effects = this.selection.effects.filter(e => e.type !== 'preset');
        } else {
            if (type === 'preset') this.selection.effects = this.selection.effects.filter(e => e.type !== 'preset');
            this.selection.effects.push({ label, type, strength: 50 });
        }
        this.refreshBottom(); // re-render chip list
    }

    private toggleChip(i: number) {
        this.openChip = this.openChip === i ? null : i;
        this.refreshBottom();
        if (this.openChip === null) this.hideStrengthPop();
        else this.showStrengthPop(i);
    }

    private removeEffect(i: number) {
        this.selection.effects.splice(i, 1);
        this.openChip = null;
        this.hideStrengthPop();
        this.refreshBottom();
    }

    private showStrengthPop(i: number) {
        this.hideStrengthPop();
        const eff = this.selection.effects[i];
        if (!eff) return;
        const pop = el('div', 'bt-strength-pop');
        pop.appendChild(el('div', 'bt-sp-title', eff.label));
        const row = el('div', 'bt-sp-row', `<span>Strength</span><span class="bt-sp-val">${eff.strength}%</span>`);
        pop.appendChild(row);
        const valEl = row.querySelector('.bt-sp-val') as HTMLElement;
        const slider = el('input') as HTMLInputElement;
        slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.value = String(eff.strength);
        slider.addEventListener('input', () => { eff.strength = +slider.value; valEl.textContent = `${eff.strength}%`; });
        pop.appendChild(slider);
        pop.appendChild(el('div', 'bt-sp-note', 'Other shader toggles go here'));
        const reset = el('div', 'bt-sp-action', `${ICON.reset}<span>Reset</span>`);
        reset.addEventListener('click', () => { eff.strength = 50; slider.value = '50'; valEl.textContent = '50%'; });
        const remove = el('div', 'bt-sp-action is-danger', `${ICON.trash}<span>Remove</span>`);
        remove.addEventListener('click', () => this.removeEffect(i));
        pop.appendChild(reset);
        pop.appendChild(remove);
        pop.classList.add('bt-interactive');
        this.strengthPop = pop;
        this.root.appendChild(pop);
    }

    private hideStrengthPop() {
        this.strengthPop?.remove();
        this.strengthPop = null;
    }

    // ── audio mode (Objects panel + audio contextual bar + placed pins) ──
    private enterAudio() {
        this.audioMode = true;
        this.placingAudio = false;
        this.audioPanel?.remove();
        this.audioPanel = this.buildAudioLibrary();
        this.root.appendChild(this.audioPanel);
        this.refreshBottom(); // bottom → audio bar for the active source
    }

    private exitAudio() {
        if (!this.audioMode && !this.audioPanel) return;
        this.audioMode = false;
        this.placingAudio = false;
        this.audioPanel?.remove(); this.audioPanel = null;
        this.audioBar = null;
        this.refreshBottom();
    }

    private rebuildAudio() {
        if (this.audioPanel) {
            const p = this.buildAudioLibrary();
            this.audioPanel.replaceWith(p);
            this.audioPanel = p;
        }
        this.refreshBottom();
    }

    // a browsable library of sounds — click a tile to spawn it
    private buildAudioLibrary(): HTMLElement {
        const panel = el('div', 'bt-effects-panel'); // reuse the docked-left library shell
        const head = el('div', 'bt-ep-head');
        head.appendChild(el('div', 'bt-ep-title', 'Add sound'));
        const close = el('div', 'bt-ep-close', ICON.x);
        close.addEventListener('click', () => { this.exitAudio(); this.setActiveTool('explore'); });
        head.appendChild(close);
        panel.appendChild(head);
        panel.appendChild(el('div', 'bt-ep-search', 'Search sounds…'));

        panel.appendChild(el('div', 'bt-ep-section', 'SFX · 3D'));
        const sfx = el('div', 'bt-ep-grid');
        AUDIO_LIB.SFX.forEach(name => sfx.appendChild(this.audioTile(name, 'Spatial')));
        panel.appendChild(sfx);

        panel.appendChild(el('div', 'bt-ep-section', 'MUSIC · STEREO'));
        const music = el('div', 'bt-ep-grid');
        AUDIO_LIB.Music.forEach(name => music.appendChild(this.audioTile(name, 'Stereo')));
        panel.appendChild(music);
        return panel;
    }

    private audioTile(name: string, kind: string): HTMLElement {
        const tile = el('div', 'bt-tile',
            `<div class="bt-tile-sw is-audio">${ICON.audio}</div><span class="bt-tile-label">${name}</span>`);
        tile.addEventListener('click', () => this.spawnAudio(name, kind));
        return tile;
    }

    // spawn the clicked sound; spatial ones drop a pin at world origin (then re-Place to move)
    private spawnAudio(name: string, kind: string) {
        this.audioSources.push({ name, kind, volume: 50, range: 8, loop: false, placed: kind === 'Stereo' });
        this.activeAudio = this.audioSources.length - 1;
        if (kind === 'Spatial') this.dropAudioPin(0, 0.3, 0);
        this.refreshBottom(); // audio bar for the new source
    }

    private dropAudioPin(x: number, y: number, z: number) {
        const scene = this.scene;
        if (!scene?.contentRoot) return;
        const mat = new StandardMaterial();
        mat.useLighting = false; mat.diffuse.set(0, 0, 0); mat.emissive.set(0.13, 0.78, 0.6); mat.update();
        const pin = new Entity('bt-audio-pin');
        pin.addComponent('render', { type: 'sphere' });
        if (pin.render) pin.render.material = mat;
        pin.setLocalScale(0.14, 0.14, 0.14);
        pin.setLocalPosition(x, y, z);
        scene.contentRoot.addChild(pin);
        this.audioMarkers.push(pin);
        scene.forceRender = true;
    }

    private buildAudioBar(): HTMLElement {
        const s = this.audioSources[this.activeAudio] ?? this.audioSources[0];
        const bar = el('div', 'bt-audio-bar');

        const head = el('div', 'bt-ab-head');
        head.appendChild(el('div', 'bt-ab-name', `${ICON.globe}<span>${s.name}</span>`));
        head.appendChild(el('div', 'bt-ab-badge', s.kind));
        head.appendChild(el('div', 'bt-ab-replace', 'Replace'));
        bar.appendChild(head);

        const controls = el('div', 'bt-ab-controls');
        const vol = el('div', 'bt-ab-vol', '<span>Volume</span>');
        const slider = el('input') as HTMLInputElement;
        slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.value = String(s.volume);
        const val = el('span', 'bt-ab-val', String(s.volume));
        slider.addEventListener('input', () => { s.volume = +slider.value; val.textContent = String(s.volume); });
        vol.appendChild(slider); vol.appendChild(val);
        controls.appendChild(vol);
        controls.appendChild(el('div', 'bt-ab-range', `<span>Range</span><strong>${s.range}m</strong>`));
        controls.appendChild(el('label', 'bt-ab-loop', `<input type="checkbox" ${s.loop ? 'checked' : ''}/><span>Loop audio</span>`));
        bar.appendChild(controls);

        if (s.kind === 'Spatial' && !s.placed) {
            const place = el('button', 'bt-ab-place', this.placingAudio ? 'Click in the scene to place…' : 'Place in scene');
            place.addEventListener('click', () => this.armPlace());
            bar.appendChild(place);
        }
        return bar;
    }

    private armPlace() {
        this.placingAudio = true;
        this.refreshBottom(); // button label → "Click in the scene to place…"
    }

    private placeAudioAt(clientX: number, clientY: number) {
        const s = this.audioSources[this.activeAudio];
        const cam = this.cameraComponent();
        if (cam && this.canvas) {
            const rect = this.canvas.getBoundingClientRect();
            const dist = this.scene.camera?.distance ?? 2;
            const out = new Vec3();
            cam.screenToWorld(clientX - rect.left, clientY - rect.top, dist, out);
            this.dropAudioPin(out.x, out.y, out.z);
        }
        if (s) s.placed = true;
        this.placingAudio = false;
        this.rebuildAudio();
    }

    // ── interaction recording (cyan border + record bar) ──
    private startRecording() {
        if (this.state !== 'selected') return;
        this.recordingMode = true;
        this.recordBorder = el('div', 'bt-recording');
        this.root.appendChild(this.recordBorder);
        this.recordBar = this.buildRecordBar();
        this.root.appendChild(this.recordBar);
        this.refreshBottom(); // hide the context bar while recording
    }

    private buildRecordBar(): HTMLElement {
        const bar = el('div', 'bt-record-bar');
        const when = el('div', 'bt-rb-when',
            `When <strong>${this.selection.name}</strong> is <select>
                <option>Clicked</option><option>Hovered</option><option>Looked at</option><option>Nearby</option>
            </select>`);
        bar.appendChild(when);
        bar.appendChild(el('div', 'bt-rb-rec', 'Recording changes'));
        bar.appendChild(el('div', 'bt-rb-spacer'));
        const reset = el('div', 'bt-rb-reset', ICON.reset);
        reset.addEventListener('click', () => this.finishRecording(false)); // discard
        const finish = el('button', 'bt-rb-finish', 'Finish Changes');
        finish.addEventListener('click', () => this.finishRecording(true));
        bar.appendChild(reset);
        bar.appendChild(finish);
        return bar;
    }

    private finishRecording(commit: boolean) {
        this.recordingMode = false;
        this.recordBorder?.remove(); this.recordBorder = null;
        this.recordBar?.remove(); this.recordBar = null;
        if (commit) this.selection.interactions.push('On click → changes'); // bumps the badge
        this.interactionsMode = true; // return to the interaction list (showing the new one)
        this.refreshBottom();
    }

    // ── asset browser (revealable) ──
    private openAssets() {
        this.assetsPanel?.remove();
        this.assetsPanel = this.buildAssetsPanel();
        this.root.appendChild(this.assetsPanel);
    }

    private closeAssets() {
        this.assetsPanel?.remove();
        this.assetsPanel = null;
    }

    private buildAssetsPanel(): HTMLElement {
        const panel = el('div', 'bt-assets-panel');
        const head = el('div', 'bt-as-head');
        head.appendChild(el('div', 'bt-as-title', 'Assets'));
        const close = el('div', 'bt-as-close', ICON.x);
        close.addEventListener('click', () => { this.closeAssets(); this.setActiveTool('explore'); });
        head.appendChild(close);
        panel.appendChild(head);

        const tabs = el('div', 'bt-as-tabs');
        ['Gaussians', 'Props', 'Sounds'].forEach((t) => {
            const tab = el('div', `bt-as-tab${this.assetTab === t ? ' is-active' : ''}`, t);
            tab.addEventListener('click', () => { this.assetTab = t; this.openAssets(); });
            tabs.appendChild(tab);
        });
        panel.appendChild(tabs);

        const grid = el('div', 'bt-as-grid');
        ASSETS[this.assetTab].forEach((name, i) => {
            const tile = el('div', 'bt-as-tile');
            const thumb = el('div', 'bt-as-thumb');
            thumb.style.background = ASSET_GRADS[i % ASSET_GRADS.length];
            tile.appendChild(thumb);
            tile.appendChild(el('div', 'bt-as-label', name));
            tile.addEventListener('click', () => this.placeAssetAndSelect(name));
            grid.appendChild(tile);
        });
        panel.appendChild(grid);
        panel.appendChild(el('div', 'bt-as-foot', 'Click an item to drop it in the scene and select it.'));
        return panel;
    }

    // selecting an asset drops it into the scene and makes it the active selection
    private placeAssetAndSelect(name: string) {
        const scene = this.scene;
        if (scene?.contentRoot) {
            const mat = new StandardMaterial();
            mat.useLighting = false; mat.diffuse.copy(IDLE_DIFFUSE); mat.emissive.copy(IDLE_DIFFUSE); mat.emissiveIntensity = 1; mat.update();
            const asset = new Entity('bt-asset');
            asset.addComponent('render', { type: 'box' });
            if (asset.render) asset.render.material = mat;
            asset.setLocalScale(0.3, 0.3, 0.3);
            // offset from the existing cube so the new (selected/yellow) asset is visible
            const k = this.placedCount++;
            asset.setLocalPosition(0.55 + k * 0.12, 0.3, 0.25 - k * 0.12);
            scene.contentRoot.addChild(asset);
            this.box = asset;                 // make it the selectable object
            this.boxMat = mat;
            this.selection = { name, effects: [], interactions: [] };
            scene.forceRender = true;
        }
        this.closeAssets();
        this.selectObject(true);              // select it: yellow + selected chrome + gizmo
    }

    // Re-render the header center cluster (camera hints vs transform tools). Also
    // called when the gizmo mode changes so the active Q/E/R highlight updates.
    private refreshHeaderCenter() {
        const next = this.state === 'selected' ? this.selectedTopbar() : this.exploreHints();
        this.headerCenter.replaceWith(next);
        this.headerCenter = next;
    }

    // ── scene integration: placeholder object + faked SAM selection ──
    attachScene(scene: any, canvas: HTMLCanvasElement, events?: any) {
        this.scene = scene;
        this.canvas = canvas;
        this.events = events ?? null;
        this.addPlaceholder();
        this.wireSelection();
        this.wireKeyboard();
    }

    private addPlaceholder() {
        const scene = this.scene;
        if (!scene?.contentRoot) return;
        const mat = new StandardMaterial();
        // Drive colour through emissive so the box reads clearly over the splat
        // viewport even though the scene has no lights (a lit material would be black).
        mat.diffuse.copy(IDLE_DIFFUSE);
        mat.emissive.copy(IDLE_DIFFUSE);
        mat.emissiveIntensity = 1;
        mat.update();

        const box = new Entity('bt-placeholder');
        box.addComponent('render', { type: 'box' });
        if (box.render) box.render.material = mat; // apply to all primitive mesh instances
        box.setLocalScale(0.35, 0.35, 0.35);
        box.setLocalPosition(0, 0.3, 0);
        scene.contentRoot.addChild(box);

        this.box = box;
        this.boxMat = mat;
        scene.forceRender = true;
    }

    private wireSelection() {
        const canvas = this.canvas;
        if (!canvas) return;
        let down = false, downX = 0, downY = 0, moved = false;
        canvas.addEventListener('pointerdown', (e) => { down = true; downX = e.clientX; downY = e.clientY; moved = false; });
        canvas.addEventListener('pointermove', (e) => {
            if (down && Math.hypot(e.clientX - downX, e.clientY - downY) > 4) moved = true;
            // keep rendering while a gizmo is up so its hover/drag feedback is live
            // (SuperSplat renders on demand; the gizmo otherwise wouldn't animate)
            if (this.gizmo && this.scene) this.scene.forceRender = true;
        });
        // observe only (no preventDefault) so SuperSplat's camera drag still works
        canvas.addEventListener('pointerup', (e) => {
            const wasDown = down; down = false;
            if (!wasDown || moved || e.button !== 0) return; // a drag is a camera move, not a click
            if (this.placingAudio) { this.placeAudioAt(e.clientX, e.clientY); return; }
            if (this.audioMode) return; // audio mode: clicks are for placement only
            if (this.recordingMode) return; // recording: keep the source selected (move it = a change)
            this.selectObject(this.hitsPlaceholder(e.clientX, e.clientY));
        });
    }

    // ── keyboard map (spec §8): Q/E/R transforms · F frame · ⌫ delete · Esc deselect ──
    private wireKeyboard() {
        window.addEventListener('keydown', (e) => {
            const tag = (e.target as HTMLElement)?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA') return;
            if (e.key === 'Escape') {
                if (this.recordingMode) this.finishRecording(false); // cancel recording
                else if (this.effectsMode) this.closeEffects();      // close the library first
                else if (this.interactionsMode) this.closeInteractions();
                else this.selectObject(false);
                return;
            }
            if (this.state !== 'selected') return; // leave WASD etc. to the camera
            switch (e.key.toLowerCase()) {
                case 'q': this.setGizmoMode('move'); break;
                case 'e': this.setGizmoMode('scale'); break;
                case 'r': this.setGizmoMode('rotate'); break;
                case 'f': this.frameSelection(); break;
                case 'delete': case 'backspace': this.deleteSelection(); break;
                default: return;
            }
        });
    }

    // Faked SAM: a click within a screen-space radius of the placeholder selects it.
    private hitsPlaceholder(clientX: number, clientY: number): boolean {
        const scene = this.scene;
        const canvas = this.canvas;
        if (!scene || !canvas || !this.box) return true;
        const cam = scene.app?.root?.findByName?.('Camera');
        if (!cam?.camera) return true;
        const sp = new Vec3();
        cam.camera.worldToScreen(this.box.getPosition(), sp);
        const rect = canvas.getBoundingClientRect();
        const sx = sp.x * (rect.width / canvas.width);   // device px → css px
        const sy = sp.y * (rect.height / canvas.height);
        return Math.hypot((clientX - rect.left) - sx, (clientY - rect.top) - sy) < 150;
    }

    private selectObject(sel: boolean) {
        // reset any open effects / recording UI on selection change
        this.effectsMode = false;
        this.interactionsMode = false;
        this.openChip = null;
        this.effectsPanel?.remove(); this.effectsPanel = null;
        this.hideStrengthPop();
        this.recordingMode = false;
        this.recordBorder?.remove(); this.recordBorder = null;
        this.recordBar?.remove(); this.recordBar = null;
        if (this.boxMat && this.box?.enabled !== false) {
            const c = sel ? SEL_DIFFUSE : IDLE_DIFFUSE;
            this.boxMat.diffuse.copy(c);
            this.boxMat.emissive.copy(c);
            this.boxMat.update();
            if (this.scene) this.scene.forceRender = true;
        }
        this.setActiveTool(sel ? 'sam' : 'explore');
        this.setState(sel ? 'selected' : 'explore');
        // selecting defaults to the Move gizmo (matches the "W - Move - best" frame)
        if (sel) this.setGizmoMode('move');
        else this.clearGizmo();
    }

    // ── transform gizmo (real PlayCanvas Translate/Scale/Rotate) ──
    private cameraComponent(): any {
        return this.scene?.app?.root?.findByName?.('Camera')?.camera ?? null;
    }

    private setGizmoMode(mode: GizmoMode) {
        if (this.state !== 'selected' || !this.box || this.box.enabled === false) return;
        if (this.gizmoMode === mode && this.gizmo) return;
        this.clearGizmo();
        const cam = this.cameraComponent();
        const layer = this.scene?.gizmoLayer;
        if (!cam || !layer) return;
        const Cls = mode === 'move' ? TranslateGizmo : mode === 'scale' ? ScaleGizmo : RotateGizmo;
        const gizmo = new Cls(cam, layer);
        gizmo.attach([this.box]);
        const render = () => { if (this.scene) this.scene.forceRender = true; };
        const suppressCamera = (on: boolean) => { if (this.scene?.camera) this.scene.camera.inputDisabled = on; };
        // while an axis is being dragged, stop the camera from orbiting under it
        gizmo.on('transform:start', () => { suppressCamera(true); render(); });
        gizmo.on('transform:move', render);
        gizmo.on('transform:end', () => { suppressCamera(false); render(); });
        this.gizmo = gizmo;
        this.gizmoMode = mode;
        render();
        this.refreshHeaderCenter(); // highlight active Q/E/R
    }

    private clearGizmo() {
        if (this.gizmo) {
            try { this.gizmo.detach(); this.gizmo.destroy(); } catch (e) { /* noop */ }
            this.gizmo = null;
        }
        this.gizmoMode = null;
        if (this.scene?.camera) this.scene.camera.inputDisabled = false; // safety if torn down mid-drag
        if (this.scene) this.scene.forceRender = true;
    }

    private frameSelection() {
        const cam = this.scene?.camera; // Camera element
        if (cam?.focus && this.box && this.box.enabled !== false) {
            // focus() sets focal point + the right distance to fit `radius`; speed 0 = instant.
            const r = Math.max(this.box.getLocalScale().x, 0.2) * 1.6;
            cam.focus({ focalPoint: this.box.getPosition(), radius: r, speed: 0 });
            if (this.scene) this.scene.forceRender = true;
        } else {
            this.events?.fire?.('camera.focus');
        }
    }

    private deleteSelection() {
        this.clearGizmo();
        if (this.box) this.box.enabled = false; // placeholder: hide it
        if (this.scene) this.scene.forceRender = true;
        this.selectObject(false);
    }

    destroy() {
        document.body.classList.remove('bt-mode');
        this.root.remove();
    }
}

export { BraintranceUI };
