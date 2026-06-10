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
const AUDIO_DIFFUSE = new Color(0.13, 0.78, 0.6); // audio pins idle green

// ── icons (Lucide 24×24, matching the frame's stroke icons) ─────────────────
const stroke = (paths: string, size = 24) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const fill = (paths: string, size = 24) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor">${paths}</svg>`;

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
    camera: stroke('<path d="m22 8-6 4 6 4V8Z"/><rect x="2" y="6" width="14" height="12" rx="2"/>', 18),
    chevronDown: stroke('<path d="m6 9 6 6 6-6"/>', 18),
    diamond: stroke('<path d="M12 3l9 9-9 9-9-9z"/>', 15),
    type: stroke('<path d="M4 7V5h16v2"/><path d="M9 19h6"/><path d="M12 5v14"/>', 18),
    lasso: stroke('<path d="M7 22a5 5 0 0 1-2-4"/><path d="M3.3 14A6.8 6.8 0 0 1 2 10c0-4.4 4.5-8 10-8s10 3.6 10 8-4.5 8-10 8a12 12 0 0 1-5-1"/><circle cx="5" cy="16" r="2"/>'),
    frame: stroke('<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="2.5"/>'),
    crop: stroke('<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>')
};

// Top-menu contents ('—' = separator). Most are faked; a few wire to real actions.
const MENUS: Record<string, [string, string?][]> = {
    file: [['New project'], ['Open…'], ['Save', '⌘S'], ['—'], ['Export video…'], ['Publish to viewer']],
    select: [['Select all', '⌘A'], ['Deselect', 'Esc'], ['Invert'], ['—'], ['Frame selection', 'F']],
    view: [['Frame all'], ['Reset camera'], ['—'], ['Toggle grid'], ['Fullscreen']],
    help: [['Keyboard shortcuts', '?'], ['About Braintrance'], ['—'], ['Documentation']]
};

const DURATION = 151; // 2:31 timeline (seconds)
const fmtTime = (sec: number) => {
    const s = Math.max(0, Math.round(sec));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// Effect catalogue (faked — labels per spec §7.6). Presets are single-select
// (a new one replaces the prior), shader effects stack.
const COLOR_PRESETS = ['None', 'Warm', 'Cool', 'Vivid', 'Noir', 'Vintage', 'B&W', 'Faded'];
const SHADER_EFFECTS = ['Glow', 'Bloom', 'Blur', 'Outline', 'Pixelate', 'Scanlines', 'Depth fade', 'Point cloud'];

type Effect = { label: string; type: 'preset' | 'effect'; strength: number };

// One object affected by an interaction + the changes/timing it plays.
type InteractionTarget = { name: string; changes: string; timing?: string; thisObject?: boolean };
// A recorded interaction: a trigger, a short label, and the objects it drives.
type Interaction = { trigger: string; label: string; targets: InteractionTarget[] };

// A selectable world object — each carries its own effects / interactions.
// `idle` is its un-selected emissive colour; `audioIndex` links audio-pin objects
// back to their entry in `audioSources`.
type SceneObject = { entity: Entity; mat: StandardMaterial; name: string; effects: Effect[]; interactions: Interaction[]; idle?: Color; audioIndex?: number };

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
    private toolTabs: Partial<Record<RailTool, HTMLElement>> = {}; // top Explore/Select toggle

    // selection mode: null/sam = click-select, lasso = draw region, crop = volume box
    private selectMode: 'sam' | 'lasso' | 'crop' | null = null;
    private selectMenu: HTMLElement | null = null;          // the Select dropdown
    private lasso: { pts: { x: number; y: number }[]; el: HTMLElement } | null = null;
    private cropBox: { x0: number; y0: number; x1: number; y1: number; el: HTMLElement } | null = null;
    private cropConfirm: HTMLElement | null = null;
    private menuDropdown: HTMLElement | null = null;
    private menuOpen: string | null = null;
    private depthPop: HTMLElement | null = null;            // lasso depth prompt
    private captures: number[] = [0.14, 0.60];              // snapshot marker positions (0..1)
    private scrubberEl: HTMLElement | null = null;

    // playback (scrubber + sequencer share one playhead)
    private playing = false;
    private dgsPlaying = false;  // object's own 4DGS playback (stand-in; runtime not wired)
    private playhead = 0.34;             // 0..1 (0:51 of 2:31)
    private playRaf = 0;
    private scrubFill: HTMLElement | null = null;
    private scrubPlayheadEl: HTMLElement | null = null;
    private scrubTimeEl: HTMLElement | null = null;
    private playBtns: HTMLElement[] = []; // play buttons (scrubber + sequencer) to sync icon
    private sequencer: HTMLElement | null = null;
    private seqPlayheadEl: HTMLElement | null = null;

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
    private objects: SceneObject[] = [];   // all selectable world objects
    private selection!: SceneObject;        // the active selection (set when the cube is created)

    // effects-library state
    private effectsMode = false;            // context bar in chip view + library open
    private interactionsMode = false;       // context bar showing interaction chips + Add
    private openChip: number | null = null; // index of the chip whose strength popover is open
    private editingInteraction: number | null = null; // interaction being re-recorded, if any
    private effectsPanel: HTMLElement | null = null;
    private strengthPop: HTMLElement | null = null;

    // audio-mode state (fixtures: one ambient bed + one unplaced spatial source)
    private audioMode = false;
    private audioPanel: HTMLElement | null = null;
    private audioBar: HTMLElement | null = null;
    private placingAudio = false;
    private audioCtx: AudioContext | null = null;   // lazily-created, for audition tones
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
        this.scrubberEl = this.buildScrubber();
        this.root.appendChild(this.scrubberEl);

        // Frame-all button (top-right) — the interview's main pain point ("fly to origin")
        const frame = el('button', 'bt-frameall', `${ICON.frame}<span>Frame all</span>`);
        frame.title = 'Frame all content';
        frame.addEventListener('click', () => this.frameAll());
        this.root.appendChild(frame);

        document.body.appendChild(this.root);
        this.setState('explore');
        this.setActiveTool('explore'); // Explore is the default tool
    }

    // ── top menu strip ──
    private buildMenubar(): HTMLElement {
        const bar = el('div', 'bt-menubar');
        ['file', 'select', 'view', 'help'].forEach((label) => {
            const it = el('div', 'bt-menubar-item', label);
            it.addEventListener('click', (e) => {
                e.stopPropagation(); this.openMenu(label, it);
            });
            it.addEventListener('mouseenter', () => {
                if (this.menuOpen && this.menuOpen !== label) this.openMenu(label, it);
            });
            bar.appendChild(it);
        });
        return bar;
    }

    private openMenu(name: string, anchor: HTMLElement) {
        if (this.menuOpen === name) {
            this.closeMenu(); return;
        }
        this.closeMenu();
        const dd = el('div', 'bt-menu-dd bt-interactive');
        (MENUS[name] ?? []).forEach(([label, sc]) => {
            if (label === '—') {
                dd.appendChild(el('div', 'bt-menu-sep')); return;
            }
            const row = el('div', 'bt-menu-row', `<span>${label}</span>${sc ? `<span class="bt-menu-sc">${sc}</span>` : ''}`);
            row.addEventListener('click', () => {
                this.closeMenu(); this.runMenuAction(label);
            });
            dd.appendChild(row);
        });
        const r = anchor.getBoundingClientRect();
        dd.style.left = `${r.left}px`;
        dd.style.top = `${r.bottom + 2}px`;
        this.menuDropdown = dd;
        this.menuOpen = name;
        anchor.classList.add('is-open');
        this.root.appendChild(dd);
        setTimeout(() => document.addEventListener('pointerdown', this.onMenuDocDown), 0);
    }

    private onMenuDocDown = (e: PointerEvent) => {
        const t = e.target as HTMLElement;
        if (this.menuDropdown && !this.menuDropdown.contains(t) && !t?.closest?.('.bt-menubar')) this.closeMenu();
    };

    private closeMenu() {
        if (this.menuDropdown) {
            this.menuDropdown.remove();
            this.menuDropdown = null;
            this.menuOpen = null;
            this.root.querySelectorAll('.bt-menubar-item.is-open').forEach(e => e.classList.remove('is-open'));
            document.removeEventListener('pointerdown', this.onMenuDocDown);
        }
    }

    private runMenuAction(label: string) {
        if (label === 'Frame all') this.frameAll();
        else if (label === 'Frame selection') this.frameSelection();
        else if (label === 'Deselect') this.selectObject(false);
        else if (label === 'Fullscreen') {
            (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.())?.catch?.(() => {});
        }
        // remaining items are faked placeholders for the prototype
    }

    // ── project sub-header (back · title · center cluster) ──
    private buildHeader(): HTMLElement {
        const header = el('div', 'bt-header');
        header.appendChild(el('div', 'bt-back', ICON.back));
        header.appendChild(el('div', 'bt-project-title', 'Untitled Project'));
        header.appendChild(this.buildToolTabs()); // Explore / SAM toggle, right of the title
        this.headerCenter = el('div', 'bt-header-center');
        header.appendChild(this.headerCenter);
        return header;
    }

    // top-of-header Explore (default) + Select dropdown (moved up from the rail)
    private buildToolTabs(): HTMLElement {
        const tabs = el('div', 'bt-tooltabs');
        const explore = el('div', 'bt-tooltab', `${ICON.explore}<span>Explore</span>`);
        explore.addEventListener('click', () => this.selectTool('explore'));
        this.toolTabs.explore = explore;
        tabs.appendChild(explore);

        const select = el('div', 'bt-tooltab bt-tooltab-dd');
        select.innerHTML = `${ICON.sam}<span class="bt-tt-label">Select</span><span class="bt-tt-caret">${ICON.chevronDown}</span>`;
        // Photoshop-style: short click activates (selects last); long-press reveals the flyout.
        let pressTimer = 0, longPressed = false;
        const endPress = () => {
            if (pressTimer) {
                clearTimeout(pressTimer); pressTimer = 0;
            }
        };
        select.addEventListener('pointerdown', (e) => {
            e.stopPropagation(); longPressed = false;
            pressTimer = window.setTimeout(() => {
                longPressed = true; this.openSelectMenu();
            }, 360);
        });
        select.addEventListener('pointerup', () => {
            endPress(); if (!longPressed) this.activateSelect();
        });
        select.addEventListener('pointerleave', endPress);
        this.toolTabs.sam = select;
        tabs.appendChild(select);
        return tabs;
    }

    // short click: enter Select (last sub-tool) and re-select the last object
    private activateSelect() {
        this.selectMode = 'sam';
        this.exitAudio();
        this.closeAssets();
        this.endLasso();
        this.closeSelectMenu();
        this.setActiveTool('sam');
        this.updateSelectTabLabel();
        if (this.canvas) this.canvas.style.cursor = 'crosshair';
        if (this.selection?.entity && this.selection.entity.enabled !== false) {
            this.selectSceneObject(this.selection); // auto-select the last object
        }
    }

    private openSelectMenu() {
        if (this.selectMenu) return;
        const menu = el('div', 'bt-select-menu bt-interactive');
        const item = (icon: string, name: string, sub: string, mode: 'sam' | 'lasso' | 'crop') => {
            const it = el('div', `bt-select-item${this.selectMode === mode ? ' is-active' : ''}`,
                `${icon}<div class="bt-si-text"><div class="bt-si-name">${name}</div><div class="bt-si-sub">${sub}</div></div>`);
            it.addEventListener('click', () => this.enableSelectMode(mode));
            return it;
        };
        menu.appendChild(item(ICON.sam, 'SAM', 'AI click-to-segment', 'sam'));
        menu.appendChild(item(ICON.lasso, 'Shape', 'Draw a lasso region', 'lasso'));
        menu.appendChild(item(ICON.crop, 'Crop', 'Drag a volume box', 'crop'));
        const tab = this.toolTabs.sam!;
        const r = tab.getBoundingClientRect();
        menu.style.left = `${r.left}px`;
        menu.style.top = `${r.bottom + 6}px`;
        this.selectMenu = menu;
        this.root.appendChild(menu);
        setTimeout(() => document.addEventListener('pointerdown', this.onDocPointerDown), 0);
    }

    private onDocPointerDown = (e: PointerEvent) => {
        if (this.selectMenu && !this.selectMenu.contains(e.target as Node) && !this.toolTabs.sam?.contains(e.target as Node)) {
            this.closeSelectMenu();
        }
    };

    private closeSelectMenu() {
        if (this.selectMenu) {
            this.selectMenu.remove();
            this.selectMenu = null;
            document.removeEventListener('pointerdown', this.onDocPointerDown);
        }
    }

    // enabling a select mode does NOT auto-select — it just turns selection on
    private enableSelectMode(mode: 'sam' | 'lasso' | 'crop') {
        this.selectMode = mode;
        this.exitAudio();
        this.closeAssets();
        this.endLasso();
        this.endCrop();
        this.setActiveTool('sam');       // highlight the Select tab
        this.closeSelectMenu();
        this.updateSelectTabLabel();
        if (this.canvas) this.canvas.style.cursor = 'crosshair';
        // SAM re-selects the last object; lasso/crop wait for a drawn region
        if (mode === 'sam' && this.selection?.entity && this.selection.entity.enabled !== false) {
            this.selectSceneObject(this.selection);
        }
    }

    private updateSelectTabLabel() {
        const label = this.toolTabs.sam?.querySelector('.bt-tt-label');
        const name = this.selectMode === 'lasso' ? 'Lasso' : this.selectMode === 'crop' ? 'Crop' : this.selectMode === 'sam' ? 'SAM' : 'Select';
        if (label) label.textContent = name;
    }

    // camera hints (Explore state)
    private exploreHints(): HTMLElement {
        const wrap = el('div', 'bt-header-center');
        const keys = el('div', 'bt-hint');
        // little WASD keycap cluster (W on top, A S D below) + "or Arrow keys to move"
        keys.innerHTML =
            '<span class="bt-wasd">' +
                '<span class="bt-kc bt-kc-w">W</span>' +
                '<span class="bt-kc bt-kc-a">A</span>' +
                '<span class="bt-kc bt-kc-s">S</span>' +
                '<span class="bt-kc bt-kc-d">D</span>' +
            '</span>' +
            '<span class="bt-hint-sub">or Arrow keys to move</span>';
        wrap.appendChild(keys);
        const hint = (icon: string, label: string) => el('div', 'bt-hint', `${icon}<span>${label}</span>`);
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
        bar.appendChild(tool('⌘K', 'Crop to', { onClick: () => this.cropToObjects(this.selection ? [this.selection] : []) }));
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
        // Explore/Select moved to the top header; the rail holds content tools.
        rail.appendChild(item('audio', ICON.audio, 'Audio'));
        rail.appendChild(item('assets', ICON.assets, 'Assets'));
        return rail;
    }

    // ── snapshot panel (Explore state) ──
    private snapshotPanel(): HTMLElement {
        const p = el('div', 'bt-snapshot');
        const add = el('button', 'bt-btn', 'Snapshot all');
        add.addEventListener('click', () => this.addCapture(this.playhead));
        const rem = el('button', 'bt-btn', 'Remove snapshot');
        rem.addEventListener('click', () => this.removeNearestCapture(this.playhead));
        p.appendChild(add);
        p.appendChild(rem);
        p.appendChild(el('button', 'bt-icon-btn', ICON.reset));
        return p;
    }

    // ── snapshot captures (drive scrubber + sequencer keyframes) ──
    private addCapture(pos: number) {
        if (!this.captures.some(c => Math.abs(c - pos) < 0.015)) {
            this.captures.push(pos);
            this.captures.sort((a, b) => a - b);
            this.renderCaptures();
        }
    }

    private removeNearestCapture(pos: number) {
        if (!this.captures.length) return;
        let bi = 0, bd = Infinity;
        this.captures.forEach((c, i) => {
            const d = Math.abs(c - pos); if (d < bd) {
                bd = d; bi = i;
            }
        });
        this.captures.splice(bi, 1);
        this.renderCaptures();
    }

    private renderCaptures() {
        if (this.scrubberEl) {
            const s = this.buildScrubber(); this.scrubberEl.replaceWith(s); this.scrubberEl = s;
        }
        if (this.sequencer) {
            this.sequencer.remove(); this.seqPlayheadEl = null; this.sequencer = this.buildSequencer(); this.root.appendChild(this.sequencer);
        }
    }

    // ── selection contextual bar — default actions vs effect-chip view ──
    private contextBar(): HTMLElement {
        if (this.effectsMode) return this.contextBarChips();
        if (this.interactionsMode) {
            // an open interaction shows its full overview; otherwise the chip list
            return this.openChip !== null && this.selection.interactions[this.openChip] ?
                this.interactionOverview(this.openChip) :
                this.contextBarInteractions();
        }
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
        this.selection.interactions.forEach((it, i) => {
            const chip = el('button', `bt-chip bt-chip-int${this.openChip === i ? ' is-open' : ''}`,
                `<span class="bt-chip-dot"></span><span>${it.label}</span><span class="bt-chip-caret">${ICON.chevronRight}</span>`);
            chip.addEventListener('click', () => this.toggleInteractionChip(i));
            chips.appendChild(chip);
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
        // This Play/Pause drives the object's own 4DGS playback (not the timeline). The
        // 4DGS runtime isn't wired yet, so it's a stand-in toggle for now.
        const pause = el('div', 'bt-pause', `${this.dgsPlaying ? ICON.pause : ICON.play}<span>${this.dgsPlaying ? 'Pause' : 'Play'}</span>`);
        pause.addEventListener('click', () => {
            this.dgsPlaying = !this.dgsPlaying; this.refreshBottom();
        });
        head.appendChild(pause);
        bar.appendChild(head);

        // Category buttons: open the existing effects / interactions (not "Add" — the
        // Add button lives inside each list so the library doesn't pop up too soon).
        const actions = el('div', 'bt-cb-actions');
        const eff = el('button', 'bt-cb-btn bt-effect',
            `<span>Effects</span><span class="bt-cb-badge">${this.selection.effects.length} ${ICON.sparkles}</span>`);
        eff.addEventListener('click', () => this.openEffects());
        const inter = el('button', 'bt-cb-btn bt-interaction',
            `<span>Interactions</span><span class="bt-cb-badge">${this.selection.interactions.length} ${ICON.zap}</span>`);
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
        const add = el('button', 'bt-chip bt-chip-add', `${ICON.plus}<span>Add effect</span>`);
        add.addEventListener('click', () => this.showEffectsLibrary()); // library opens only here
        chips.appendChild(add);
        bar.appendChild(chips);
        return bar;
    }

    // ── scrubber ──
    private buildScrubber(): HTMLElement {
        const s = el('div', 'bt-scrubber');
        const play = el('button', 'bt-play', ICON.play);
        play.addEventListener('click', () => this.togglePlay());
        this.playBtns = [play];
        s.appendChild(play);
        this.scrubTimeEl = el('div', 'bt-time', fmtTime(this.playhead * DURATION));
        s.appendChild(this.scrubTimeEl);

        const track = el('div', 'bt-track');
        const fill = el('div', 'bt-track-fill');
        fill.style.width = `${this.playhead * 100}%`;
        this.scrubFill = fill;
        track.appendChild(fill);
        this.captures.forEach((pos) => {
            const m = el('div', 'bt-marker'); m.style.left = `${pos * 100}%`; track.appendChild(m);
        });
        const ph = el('div', 'bt-marker is-playhead'); ph.style.left = `${this.playhead * 100}%`;
        this.scrubPlayheadEl = ph; track.appendChild(ph);
        track.addEventListener('click', (e) => {
            const r = track.getBoundingClientRect();
            this.setPlayhead(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
        });
        s.appendChild(track);

        s.appendChild(el('div', 'bt-time', fmtTime(DURATION)));

        // global "Preview all" — rolls the timeline + fires every object's interactions
        const previewAll = el('button', 'bt-preview-all', `${ICON.play}<span>Preview all</span>`);
        previewAll.title = 'Preview the whole experience — timeline + interactions';
        previewAll.addEventListener('click', () => this.previewAll());
        s.appendChild(previewAll);

        const expand = el('button', 'bt-expand', ICON.expand);
        expand.title = 'Open timeline';
        expand.addEventListener('click', () => this.toggleSequencer());
        s.appendChild(expand);
        return s;
    }

    // ── playback ──
    private togglePlay() {
        this.playing = !this.playing;
        this.updatePlayIcon();
        if (this.playing) {
            if (this.playhead >= 1) this.playhead = 0; // restart from the top
            let last = performance.now();
            const tick = (now: number) => {
                if (!this.playing) return;
                const dt = (now - last) / 1000; last = now;
                this.playhead += dt / DURATION;
                if (this.playhead >= 1) {
                    this.playhead = 1; this.applyPlayhead(); this.playing = false; this.updatePlayIcon(); return;
                }
                this.applyPlayhead();
                this.playRaf = requestAnimationFrame(tick);
            };
            this.playRaf = requestAnimationFrame(tick);
        } else {
            cancelAnimationFrame(this.playRaf);
        }
    }

    private setPlayhead(f: number) {
        this.playhead = f; this.applyPlayhead();
    }

    private applyPlayhead() {
        const pct = `${this.playhead * 100}%`;
        if (this.scrubFill) this.scrubFill.style.width = pct;
        if (this.scrubPlayheadEl) this.scrubPlayheadEl.style.left = pct;
        if (this.scrubTimeEl) this.scrubTimeEl.textContent = fmtTime(this.playhead * DURATION);
        if (this.seqPlayheadEl) this.seqPlayheadEl.style.left = pct;
        const seqTime = this.sequencer?.querySelector('.bt-seq-time');
        if (seqTime) seqTime.textContent = `${fmtTime(this.playhead * DURATION)} / ${fmtTime(DURATION)}`;
    }

    private updatePlayIcon() {
        this.playBtns.forEach((b) => {
            b.innerHTML = this.playing ? ICON.pause : ICON.play;
        });
    }

    // ── expandable timeline / sequencer ──
    private toggleSequencer() {
        if (this.sequencer) {
            this.playBtns = this.playBtns.filter(b => !this.sequencer!.contains(b));
            this.sequencer.remove(); this.sequencer = null; this.seqPlayheadEl = null;
            document.body.classList.remove('bt-seq-open');
            return;
        }
        this.sequencer = this.buildSequencer();
        this.root.appendChild(this.sequencer);
        document.body.classList.add('bt-seq-open');
    }

    private buildSequencer(): HTMLElement {
        const panel = el('div', 'bt-sequencer');

        // header: collapse · play · time · Snapshot
        const head = el('div', 'bt-seq-head');
        const collapse = el('button', 'bt-seq-collapse', ICON.chevronDown);
        collapse.title = 'Close timeline';
        collapse.addEventListener('click', () => this.toggleSequencer());
        head.appendChild(collapse);
        const play = el('button', 'bt-seq-play', this.playing ? ICON.pause : ICON.play);
        play.addEventListener('click', () => this.togglePlay());
        this.playBtns.push(play);
        head.appendChild(play);
        head.appendChild(el('div', 'bt-seq-time', `${fmtTime(this.playhead * DURATION)} / ${fmtTime(DURATION)}`));
        head.appendChild(el('div', 'bt-seq-spacer'));
        const snap = el('button', 'bt-seq-snap', `${ICON.diamond}<span>Snapshot</span>`);
        snap.addEventListener('click', () => this.addCapture(this.playhead));
        head.appendChild(snap);
        panel.appendChild(head);

        // body: label column + lanes column
        const body = el('div', 'bt-seq-body');
        const labels = el('div', 'bt-seq-labels');
        const lanes = el('div', 'bt-seq-lanes');

        // ruler + playhead (sit above the lanes)
        const ruler = el('div', 'bt-seq-ruler');
        for (let i = 0; i <= 10; i++) {
            const t = el('div', 'bt-seq-tick', fmtTime((i / 10) * DURATION)); t.style.left = `${i * 10}%`; ruler.appendChild(t);
        }
        lanes.appendChild(ruler);
        labels.appendChild(el('div', 'bt-seq-label bt-seq-rulerlabel', 'Layers'));
        const ph = el('div', 'bt-seq-playhead'); ph.style.left = `${this.playhead * 100}%`; this.seqPlayheadEl = ph; lanes.appendChild(ph);
        lanes.addEventListener('click', (e) => {
            const r = lanes.getBoundingClientRect();
            this.setPlayhead(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
        });

        // tracks: each selectable object, then Camera · Music · Text (designed placeholders)
        type Track = { name: string; color: string; icon?: string; kfs?: number[]; clip?: [number, number] };
        const capPts = this.captures.map(c => c * 100); // snapshots become keyframes
        const tracks: Track[] = [
            ...this.objects.map(o => ({ name: o.name, color: 'var(--bt-selection)', icon: ICON.globe, kfs: capPts })),
            { name: 'Camera', color: 'var(--bt-playhead)', icon: ICON.camera, kfs: capPts },
            { name: 'Music', color: 'var(--bt-audio)', icon: ICON.audio, clip: [4, 74] },
            { name: 'Text', color: '#8a8a8a', icon: ICON.type, kfs: [34, 66] }
        ];
        tracks.forEach((tr) => {
            labels.appendChild(el('div', 'bt-seq-label',
                `${tr.icon ?? ''}<span class="bt-seq-dot" style="background:${tr.color}"></span><span class="bt-seq-name">${tr.name}</span>`));
            const lane = el('div', 'bt-seq-lane');
            if (tr.clip) {
                const c = el('div', 'bt-seq-clip'); c.style.left = `${tr.clip[0]}%`; c.style.width = `${tr.clip[1] - tr.clip[0]}%`; c.style.background = tr.color; lane.appendChild(c);
            }
            (tr.kfs ?? []).forEach((p) => {
                const d = el('div', 'bt-seq-kf'); d.style.left = `${p}%`; d.style.background = tr.color; lane.appendChild(d);
            });
            lanes.appendChild(lane);
        });
        // add-layer affordance
        const addLabel = el('div', 'bt-seq-label bt-seq-add', `${ICON.plus}<span>Add layer</span>`);
        labels.appendChild(addLabel);
        lanes.appendChild(el('div', 'bt-seq-lane bt-seq-lane-add'));

        body.appendChild(labels);
        body.appendChild(lanes);
        panel.appendChild(body);
        return panel;
    }

    // ── state ──
    private setActiveTool(tool: RailTool) {
        (Object.keys(this.railItems) as RailTool[]).forEach((k) => {
            this.railItems[k]?.classList.toggle('is-active', k === tool);
        });
        (Object.keys(this.toolTabs) as RailTool[]).forEach((k) => {
            this.toolTabs[k]?.classList.toggle('is-active', k === tool);
        });
    }

    private selectTool(tool: RailTool) {
        if (tool !== 'audio') this.exitAudio();
        if (tool !== 'assets') this.closeAssets();
        this.closeSelectMenu();
        this.selectMode = null;          // leaving Select mode
        this.endLasso();
        this.endCrop();
        this.updateSelectTabLabel();
        if (tool === 'audio') {
            this.selectObject(false);
            this.setActiveTool('audio');
            this.enterAudio();
        } else if (tool === 'assets') {
            this.selectObject(false);
            this.setActiveTool('assets');
            this.openAssets();
        } else { // explore (default)
            this.selectObject(false);
            this.setActiveTool('explore');
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
        // a lasso-depth / crop-confirm prompt owns the bottom-center zone — don't
        // stack the snapshot bar (or any panel) under it.
        if (this.depthPop || this.cropConfirm) next = el('div');
        else if (this.recordingMode) next = el('div'); // center panel hidden; record bar is full-width
        else if (this.audioMode) next = this.buildAudioBar();
        else if (this.state === 'selected' && this.selection?.audioIndex != null) next = this.buildAudioBar();
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
        this.hideStrengthPop();
        this.effectsPanel?.remove(); this.effectsPanel = null;
        this.refreshBottom();          // context bar → effect chip list (+ Add)
    }

    private showEffectsLibrary() {
        this.hideStrengthPop();
        this.effectsPanel?.remove();
        this.effectsPanel = this.buildEffectsPanel();
        this.root.appendChild(this.effectsPanel);
    }

    private hideEffectsLibrary() {
        this.effectsPanel?.remove();
        this.effectsPanel = null;
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
        this.openChip = null; // start on the chip list, not a stale overview
        this.effectsPanel?.remove(); this.effectsPanel = null;
        this.hideStrengthPop();
        this.refreshBottom(); // context bar → interaction chips + Add
    }

    private closeInteractions() {
        this.interactionsMode = false;
        this.openChip = null;
        if (this.state === 'selected') this.refreshBottom();
    }

    private buildEffectsPanel(): HTMLElement {
        const panel = el('div', 'bt-effects-panel');
        const head = el('div', 'bt-ep-head');
        head.appendChild(el('div', 'bt-ep-title', 'Enhance with effects'));
        const close = el('div', 'bt-ep-close', ICON.x);
        close.addEventListener('click', () => this.hideEffectsLibrary()); // back to the chip list
        head.appendChild(close);
        panel.appendChild(head);

        panel.appendChild(el('div', 'bt-ep-search', 'Search effects…'));

        panel.appendChild(el('div', 'bt-ep-section', 'COLOR PRESETS'));
        const row = el('div', 'bt-ep-row');
        COLOR_PRESETS.forEach(name => row.appendChild(this.effectTile(name, 'preset')));
        panel.appendChild(row);

        panel.appendChild(el('div', 'bt-ep-strength',
            '<span>Strength</span><input type="range" min="0" max="100" value="60">'));

        const shaderCount = this.selection.effects.filter(e => e.type === 'effect').length;
        panel.appendChild(el('div', 'bt-ep-section',
            `<span>SHADER EFFECTS</span>${shaderCount ? `<span class="bt-ep-count">${shaderCount} selected</span>` : ''}`));
        const grid = el('div', 'bt-ep-grid');
        SHADER_EFFECTS.forEach(name => grid.appendChild(this.effectTile(name, 'effect')));
        panel.appendChild(grid);
        return panel;
    }

    private effectTile(name: string, type: 'preset' | 'effect'): HTMLElement {
        const swCls = name === 'None' ? 'is-none' : name === 'Cool' ? 'is-cool' : '';
        const selected = this.isEffectSelected(name, type);
        const tile = el('div', `bt-tile${selected ? ' is-selected' : ''}`,
            `<div class="bt-tile-sw ${swCls}"></div><span class="bt-tile-label">${name}</span>`);
        tile.addEventListener('click', () => this.applyEffect(name, type));
        return tile;
    }

    // is this library tile currently applied to the selection?
    private isEffectSelected(label: string, type: 'preset' | 'effect'): boolean {
        if (type === 'preset') {
            // the "None" tile reads as selected when no colour preset is active
            const hasPreset = this.selection.effects.some(e => e.type === 'preset');
            return label === 'None' ? !hasPreset : this.selection.effects.some(e => e.type === 'preset' && e.label === label);
        }
        return this.selection.effects.some(e => e.type === 'effect' && e.label === label);
    }

    private applyEffect(label: string, type: 'preset' | 'effect') {
        if (type === 'preset') {
            // presets are single-select: pick one (replacing any active preset); None clears
            this.selection.effects = this.selection.effects.filter(e => e.type !== 'preset');
            if (label !== 'None') this.selection.effects.push({ label, type, strength: 50 });
        } else {
            // shader effects toggle: click to add, click again to remove
            const idx = this.selection.effects.findIndex(e => e.type === 'effect' && e.label === label);
            if (idx >= 0) this.selection.effects.splice(idx, 1);
            else this.selection.effects.push({ label, type, strength: 50 });
        }
        this.refreshEffectsPanel(); // update tile borders + shader-effects count in place
        this.refreshBottom();       // update the chip list / Effects badge
    }

    // rebuild the open library so selected borders + the count reflect the new state
    private refreshEffectsPanel() {
        if (!this.effectsPanel) return;
        const next = this.buildEffectsPanel();
        this.effectsPanel.replaceWith(next);
        this.effectsPanel = next;
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
        slider.addEventListener('input', () => {
            eff.strength = +slider.value; valEl.textContent = `${eff.strength}%`;
        });
        pop.appendChild(slider);
        pop.appendChild(el('div', 'bt-sp-note', 'Other shader toggles go here'));
        const reset = el('div', 'bt-sp-action', `${ICON.reset}<span>Reset</span>`);
        reset.addEventListener('click', () => {
            eff.strength = 50; slider.value = '50'; valEl.textContent = '50%';
        });
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

    // clicking an interaction chip opens its full overview (toggle)
    private toggleInteractionChip(i: number) {
        this.hideStrengthPop();
        this.openChip = this.openChip === i ? null : i;
        this.refreshBottom();
    }

    // Full interaction overview (matches the design): trigger, an at-a-glance card per
    // affected object (what changes + timing), preview controls and save.
    private interactionOverview(i: number): HTMLElement {
        const it = this.selection.interactions[i];
        const bar = el('div', 'bt-int-overview');

        const head = el('div', 'bt-io-head');
        const back = el('div', 'bt-cb-back', ICON.back);
        back.addEventListener('click', () => {
            this.openChip = null; this.refreshBottom();
        });
        head.appendChild(back);
        head.appendChild(el('div', 'bt-io-name', `${ICON.globe}<span>${this.selection.name}</span>`));
        head.appendChild(el('div', 'bt-io-spacer'));
        const prev = el('button', 'bt-io-preview', `${ICON.play}<span>Preview</span>`);
        prev.addEventListener('click', () => this.previewInteraction(i));
        head.appendChild(prev);
        const edit = el('button', 'bt-io-edit', `${ICON.zap}<span>Edit changes</span>`);
        edit.addEventListener('click', () => this.editInteraction(i));
        head.appendChild(edit);
        const remove = el('button', 'bt-icon-btn', ICON.trash);
        remove.addEventListener('click', () => {
            this.selection.interactions.splice(i, 1); this.openChip = null; this.refreshBottom();
        });
        head.appendChild(remove);
        bar.appendChild(head);

        // When <trigger>
        const when = el('div', 'bt-io-when', 'When ');
        const sel = document.createElement('select');
        sel.className = 'bt-io-trigger';
        ['Clicked', 'Hovered', 'Looked at', 'Nearby'].forEach((t) => {
            const o = document.createElement('option');
            o.textContent = t; o.selected = t === it.trigger; sel.appendChild(o);
        });
        sel.addEventListener('change', () => {
            it.trigger = sel.value;
        });
        when.appendChild(sel);
        bar.appendChild(when);

        // one card per affected object — the overview of what the interaction does
        const cards = el('div', 'bt-io-cards');
        it.targets.forEach((t) => {
            const card = el('div', `bt-io-card${t.thisObject ? ' is-this' : ''}`);
            const top = el('div', 'bt-io-card-top');
            top.appendChild(el('span', 'bt-io-card-name', t.name));
            if (t.thisObject) top.appendChild(el('span', 'bt-io-card-tag', 'THIS OBJECT'));
            else if (t.timing) top.appendChild(el('span', 'bt-io-card-timing', t.timing));
            card.appendChild(top);
            card.appendChild(el('div', 'bt-io-card-changes', t.changes));
            cards.appendChild(card);
        });
        bar.appendChild(cards);

        bar.appendChild(el('div', 'bt-io-note', 'Preview to play this interaction, or Edit changes to re-record what it does.'));
        return bar;
    }

    // play a single interaction: spin + glow-pulse the object that owns it
    private previewInteraction(_i: number) {
        this.previewObject(this.selection);
    }

    // spin + glow-pulse one object to show its interaction "playing"
    private previewObject(obj: SceneObject) {
        const ent = obj.entity;
        const mat = obj.mat;
        if (!ent) return;
        const start = performance.now();
        const dur = 900;
        const rot0 = ent.getLocalEulerAngles().clone();
        const tick = (now: number) => {
            const t = Math.min((now - start) / dur, 1);
            const ease = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
            ent.setLocalEulerAngles(rot0.x, rot0.y + 360 * ease, rot0.z);
            if (mat) {
                mat.emissiveIntensity = 1 + Math.sin(t * Math.PI) * 1.8; mat.update();
            }
            if (this.scene) this.scene.forceRender = true;
            if (t < 1) {
                requestAnimationFrame(tick);
            } else {
                ent.setLocalEulerAngles(rot0.x, rot0.y, rot0.z);
                if (mat) {
                    mat.emissiveIntensity = 1; mat.update();
                }
                if (this.scene) this.scene.forceRender = true;
            }
        };
        requestAnimationFrame(tick);
    }

    // global "preview all": roll the timeline (video) and fire every object's interactions
    private previewAll() {
        if (!this.playing) {
            this.togglePlay(); this.refreshBottom();
        }
        this.objects.forEach((o) => {
            if (o.interactions.length) this.previewObject(o);
        });
    }

    // re-record an existing interaction's changes (Edit)
    private editInteraction(i: number) {
        this.editingInteraction = i;
        this.openChip = null;
        this.startRecording();
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
        close.addEventListener('click', () => {
            this.exitAudio(); this.setActiveTool('explore');
        });
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
        tile.addEventListener('click', () => this.previewAudio(name, kind));
        return tile;
    }

    // Audition the clicked sound and set it as the pending source — but DON'T add it to
    // the scene yet. That happens via the bar's "Place in scene" / "Add to scene" button.
    private previewAudio(name: string, kind: string) {
        this.playPreviewTone(name);
        const cur = this.audioSources[this.activeAudio];
        if (cur && !cur.placed) {
            cur.name = name; cur.kind = kind;   // still auditioning → swap the pending sound
        } else {
            this.audioSources.push({ name, kind, volume: 50, range: 8, loop: false, placed: false });
            this.activeAudio = this.audioSources.length - 1;
        }
        this.refreshBottom(); // show the audio bar (Preview + Place button)
    }

    // short synthesized audition tone (the library is faked), pitched by the sound name
    private playPreviewTone(name: string) {
        try {
            const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
            this.audioCtx = this.audioCtx ?? new Ctx();
            const ctx = this.audioCtx;
            if (ctx.state === 'suspended') ctx.resume();
            const now = ctx.currentTime;
            let h = 0;
            for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
            const base = 200 + (h % 14) * 32;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = (['sine', 'triangle', 'square', 'sawtooth'] as const)[h % 4];
            osc.frequency.setValueAtTime(base, now);
            osc.frequency.exponentialRampToValueAtTime(base * 1.5, now + 0.16);
            gain.gain.setValueAtTime(0.0001, now);
            gain.gain.exponentialRampToValueAtTime(0.16, now + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
            osc.connect(gain); gain.connect(ctx.destination);
            osc.start(now); osc.stop(now + 0.52);
        } catch (e) { /* preview is best-effort */ }
    }

    // add a stereo (global) sound — it still gets a world-space pin (at the origin) so it
    // can be selected/moved later, even though it plays globally.
    private addStereo() {
        const s = this.audioSources[this.activeAudio];
        if (s) {
            this.dropAudioPin(0, 0, 0);
            s.placed = true;
        }
        this.rebuildAudio();
    }

    // flip the pending sound between spatial (3D, positioned + ranged) and stereo (global)
    private toggleAudioKind() {
        const s = this.audioSources[this.activeAudio];
        if (!s) return;
        s.kind = s.kind === 'Spatial' ? 'Stereo' : 'Spatial';
        this.refreshBottom();
    }

    private dropAudioPin(x: number, y: number, z: number) {
        const scene = this.scene;
        if (!scene?.contentRoot) return;
        const mat = new StandardMaterial();
        mat.useLighting = false;
        mat.diffuse.copy(AUDIO_DIFFUSE); mat.emissive.copy(AUDIO_DIFFUSE); mat.emissiveIntensity = 1; mat.update();
        const pin = new Entity('bt-audio-pin');
        pin.addComponent('render', { type: 'sphere' });
        if (pin.render) pin.render.material = mat;
        pin.setLocalScale(0.14, 0.14, 0.14);
        pin.setLocalPosition(x, y, z);
        scene.contentRoot.addChild(pin);
        this.audioMarkers.push(pin);
        // the pin is a selectable object linked back to its sound (green idle, not red)
        const src = this.audioSources[this.activeAudio];
        this.objects.push({
            entity: pin,
            mat,
            name: src?.name ?? 'Audio',
            effects: [],
            interactions: [],
            idle: AUDIO_DIFFUSE.clone(),
            audioIndex: this.activeAudio
        });
        scene.forceRender = true;
    }

    private buildAudioBar(): HTMLElement {
        const s = this.audioSources[this.activeAudio] ?? this.audioSources[0];
        const bar = el('div', 'bt-audio-bar');

        const head = el('div', 'bt-ab-head');
        head.appendChild(el('div', 'bt-ab-name', `${ICON.globe}<span>${s.name}</span>`));
        // the Spatial/Stereo badge is a toggle (stereo plays globally → no range/placement)
        const badge = el('div', 'bt-ab-badge is-toggle', `${s.kind}<span class="bt-ab-swap">⇄</span>`);
        badge.addEventListener('click', () => this.toggleAudioKind());
        head.appendChild(badge);
        head.appendChild(el('div', 'bt-ab-spacer'));
        const preview = el('div', 'bt-ab-preview', `${ICON.play}<span>Preview</span>`);
        preview.addEventListener('click', () => this.playPreviewTone(s.name));
        head.appendChild(preview);
        if (s.placed) head.appendChild(el('div', 'bt-ab-replace', 'Replace')); // only once it's in the scene
        bar.appendChild(head);

        if (s.placed) {
            // Volume / Range / Loop only matter once the sound is actually in the scene.
            const controls = el('div', 'bt-ab-controls');
            const vol = el('div', 'bt-ab-vol', '<span>Volume</span>');
            const slider = el('input') as HTMLInputElement;
            slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.value = String(s.volume);
            const val = el('span', 'bt-ab-val', String(s.volume));
            slider.addEventListener('input', () => {
                s.volume = +slider.value; val.textContent = String(s.volume);
            });
            vol.appendChild(slider); vol.appendChild(val);
            controls.appendChild(vol);
            // range only applies to spatial (3D) sounds; stereo plays at a fixed level everywhere
            if (s.kind === 'Spatial') controls.appendChild(el('div', 'bt-ab-range', `<span>Range</span><strong>${s.range}m</strong>`));
            controls.appendChild(el('label', 'bt-ab-loop', `<input type="checkbox" ${s.loop ? 'checked' : ''}/><span>Loop audio</span>`));
            bar.appendChild(controls);
        } else {
            const label = s.kind === 'Spatial' ?
                (this.placingAudio ? 'Click in the scene to place…' : 'Place in scene') :
                'Add to scene';
            const place = el('button', 'bt-ab-place', label);
            place.addEventListener('click', () => (s.kind === 'Spatial' ? this.armPlace() : this.addStereo()));
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
        this.hideStrengthPop(); // dismiss any open chip/interaction detail popover
        this.openChip = null;
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
        // capture the chosen trigger before tearing the bar down
        const trigger = (this.recordBar?.querySelector('select') as HTMLSelectElement | null)?.value ?? 'Clicked';
        this.recordingMode = false;
        this.recordBorder?.remove(); this.recordBorder = null;
        this.recordBar?.remove(); this.recordBar = null;
        const editing = this.editingInteraction;
        this.editingInteraction = null;
        if (commit) {
            const phrase: Record<string, string> = {
                Clicked: 'On click', Hovered: 'On hover', 'Looked at': 'On look', Nearby: 'When nearby'
            };
            if (editing != null && this.selection.interactions[editing]) {
                // editing an existing interaction: update its trigger/label, keep its targets
                const it = this.selection.interactions[editing];
                it.trigger = trigger;
                it.label = `${phrase[trigger] ?? 'On click'} → changes`;
                this.openChip = editing; // reopen its overview
            } else {
                this.selection.interactions.push({
                    trigger,
                    label: `${phrase[trigger] ?? 'On click'} → changes`,
                    targets: [{ name: this.selection.name, changes: 'Move, Rotate', thisObject: true }]
                }); // bumps the badge
                this.openChip = null; // show the chip list with the new one
            }
        }
        this.interactionsMode = true; // back to the interaction list / overview
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
        close.addEventListener('click', () => {
            this.closeAssets(); this.setActiveTool('explore');
        });
        head.appendChild(close);
        panel.appendChild(head);

        const tabs = el('div', 'bt-as-tabs');
        ['Gaussians', 'Props', 'Sounds'].forEach((t) => {
            const tab = el('div', `bt-as-tab${this.assetTab === t ? ' is-active' : ''}`, t);
            tab.addEventListener('click', () => {
                this.assetTab = t; this.openAssets();
            });
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
            const obj: SceneObject = { entity: asset, mat, name, effects: [], interactions: [] };
            this.objects.push(obj);
            scene.forceRender = true;
            this.closeAssets();
            this.selectSceneObject(obj);       // select it: yellow + selected chrome + gizmo
            return;
        }
        this.closeAssets();
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

        // A few selectable stand-ins so selection can move between world objects.
        const make = (name: string, type: 'box' | 'sphere',
            pos: [number, number, number], scale: [number, number, number],
            effects: Effect[], interactions: string[]): SceneObject => {
            const mat = new StandardMaterial();
            // Drive colour through emissive so objects read clearly over the splat
            // viewport even though the scene has no lights (a lit material is black).
            mat.useLighting = false;
            mat.diffuse.copy(IDLE_DIFFUSE);
            mat.emissive.copy(IDLE_DIFFUSE);
            mat.emissiveIntensity = 1;
            mat.update();
            const ent = new Entity(`bt-obj-${name}`);
            ent.addComponent('render', { type });
            if (ent.render) ent.render.material = mat; // applies to every primitive mesh instance
            ent.setLocalScale(scale[0], scale[1], scale[2]);
            ent.setLocalPosition(pos[0], pos[1], pos[2]);
            scene.contentRoot.addChild(ent);
            const obj: SceneObject = { entity: ent, mat, name, effects, interactions };
            this.objects.push(obj);
            return obj;
        };

        // The hero Cuboid carries the seeded effect/interaction fixtures; the others
        // start clean so the user can build them up — and select between all three.
        const cube = make('Cuboid', 'box', [0, 0.5, 0], [0.34, 0.34, 0.34],
            [{ label: 'Vivid', type: 'preset', strength: 60 }, { label: 'Bloom', type: 'effect', strength: 50 }],
            [{
                trigger: 'Clicked',
                label: 'On click → moves + glows',
                targets: [
                    { name: 'Cuboid', changes: 'Move, Rotate, Glow', thisObject: true },
                    { name: 'Scene', changes: 'Fog', timing: '0.0s, 0.3s' },
                    { name: 'Camera', changes: 'Move', timing: '0.2s, 0.3s' }
                ]
            }]);
        make('Sphere', 'sphere', [-0.66, 0.44, 0.1], [0.28, 0.28, 0.28], [], []);
        make('Pillar', 'box', [0.66, 0.62, -0.05], [0.2, 0.56, 0.2], [], []);

        this.selection = cube;
        this.box = cube.entity;
        this.boxMat = cube.mat;
        scene.forceRender = true;
    }

    private wireSelection() {
        const canvas = this.canvas;
        if (!canvas) return;
        // SuperSplat's camera controller calls setPointerCapture on #canvas-container,
        // which redirects every later pointermove/up to that element. If we listened on
        // the <canvas> child we'd never see the release, so a real click could never
        // select. Listen on the same captured element; coordinate math still uses the
        // canvas (it fills the container, so the rect is identical).
        const target: HTMLElement = document.getElementById('canvas-container') ?? canvas;
        let down = false, downX = 0, downY = 0, moved = false;
        // Click-vs-drag slop: a real mouse/trackpad jitters several px during a click,
        // so anything under this still counts as a click-to-select. Above it is a
        // deliberate camera orbit. (Lasso/crop draw on every move regardless.)
        const CLICK_SLOP = 10;
        const drawMode = () => this.selectMode === 'lasso' || this.selectMode === 'crop';
        target.addEventListener('pointerdown', (e) => {
            down = true; downX = e.clientX; downY = e.clientY; moved = false;
            if (e.button !== 0) return;
            // For lasso/crop we set camera.inputDisabled, so SuperSplat skips its own
            // pointer capture — capture here ourselves so the whole drag (move + up)
            // is delivered to this element even if the cursor leaves it.
            if (this.selectMode === 'lasso') {
                try {
                    target.setPointerCapture(e.pointerId);
                } catch (err) { /* noop */ }
                this.startLasso(e.clientX, e.clientY);
            } else if (this.selectMode === 'crop') {
                try {
                    target.setPointerCapture(e.pointerId);
                } catch (err) { /* noop */ }
                this.startCrop(e.clientX, e.clientY);
            }
        });
        target.addEventListener('pointermove', (e) => {
            if (down && Math.hypot(e.clientX - downX, e.clientY - downY) > CLICK_SLOP) moved = true;
            if (this.gizmo && this.scene) this.scene.forceRender = true;
            if (this.lasso && down) {
                this.addLassoPoint(e.clientX, e.clientY); return;
            }
            if (this.cropBox && down) {
                this.updateCrop(e.clientX, e.clientY); return;
            }
            // hover affordance
            if (!down && !drawMode() && !this.audioMode && !this.placingAudio) {
                canvas.style.cursor = this.pickObjectAt(e.clientX, e.clientY) ? 'pointer' : '';
            } else if (drawMode() && !down) {
                canvas.style.cursor = 'crosshair';
            }
        });
        target.addEventListener('pointerup', (e) => {
            const wasDown = down; down = false;
            if (this.lasso) {
                this.finishLasso(); return;
            } // → depth prompt
            if (this.cropBox) {
                this.finishCrop(); return;
            } // → crop confirm
            if (!wasDown || moved || e.button !== 0) return; // a drag is a camera move, not a click
            if (this.placingAudio) {
                this.placeAudioAt(e.clientX, e.clientY); return;
            }
            if (this.audioMode) return;
            if (this.recordingMode) {
                // While recording an interaction you can retarget which object you're
                // changing — pick it without tearing down the recording session.
                if (!drawMode()) {
                    const obj = this.pickObjectAt(e.clientX, e.clientY);
                    if (obj) this.selectDuringRecording(obj);
                }
                return;
            }
            if (drawMode()) return; // lasso/crop draws are handled above
            if (this.selectMode === 'sam') {
                // Select mode: click an object to select it; click the already-selected
                // object (or blank) to deselect — but stay in Select, don't drop to Explore.
                const obj = this.pickObjectAt(e.clientX, e.clientY);
                if (obj && !(this.state === 'selected' && obj === this.selection)) {
                    this.selectSceneObject(obj);
                } else {
                    this.selectObject(false);
                }
            } else {
                // Explore mode: navigate — click an object to centre it (if it's near),
                // click blank space to step forward into the scene.
                this.exploreNavigate(e.clientX, e.clientY);
            }
        });
    }

    // Explore navigation: centre a nearby object, else glide forward into the scene.
    private exploreNavigate(clientX: number, clientY: number) {
        const cam = this.scene?.camera;
        const camEntity = this.scene?.app?.root?.findByName?.('Camera');
        if (!cam || !camEntity) return;
        const camPos = camEntity.getPosition();
        const worldDist = Math.max(camPos.distance(cam.focalPoint), 0.001);
        const obj = this.pickObjectAt(clientX, clientY);
        if (obj && obj.entity.enabled !== false) {
            const objPos = obj.entity.getPosition();
            // "close enough": within ~1.3× the current focal distance → centre it
            if (camPos.distance(objPos) <= worldDist * 1.3) {
                cam.setFocalPoint(objPos.clone(), 1);
                this.pumpRender(700);
                return;
            }
        }
        // blank space (or a far object) → turn to face WHERE YOU CLICKED and step
        // forward in that direction (not just straight ahead).
        let rayDir = camEntity.forward.clone();
        const camComp = this.cameraComponent();
        if (camComp && this.canvas) {
            const rect = this.canvas.getBoundingClientRect();
            const sx = (clientX - rect.left) * (this.canvas.width / rect.width);
            const sy = (clientY - rect.top) * (this.canvas.height / rect.height);
            const far = new Vec3();
            camComp.screenToWorld(sx, sy, 50, far);
            const dir = far.sub(camPos);
            if (dir.length() > 1e-4) rayDir = dir.normalize();
        }
        const step = Math.max(worldDist * 0.4, 0.3);
        const newPos = camPos.clone().add(rayDir.clone().mulScalar(step));
        const newTarget = newPos.clone().add(rayDir.clone().mulScalar(worldDist));
        cam.setPose(newPos, newTarget, 1);
        this.pumpRender(700);
    }

    // switch the active object mid-recording without exiting the recording session
    private selectDuringRecording(obj: SceneObject) {
        if (this.boxMat && this.boxMat !== obj.mat) {
            const idle = this.selection?.idle ?? IDLE_DIFFUSE;
            this.boxMat.diffuse.copy(idle); this.boxMat.emissive.copy(idle); this.boxMat.update();
        }
        this.box = obj.entity; this.boxMat = obj.mat; this.selection = obj;
        this.boxMat.diffuse.copy(SEL_DIFFUSE); this.boxMat.emissive.copy(SEL_DIFFUSE); this.boxMat.update();
        this.clearGizmo(); // a transform tool re-attaches to the newly targeted object
        if (this.scene) this.scene.forceRender = true;
    }

    // ── lasso (Shape) selection: draw a region, then choose its depth ──
    private startLasso(x: number, y: number) {
        this.endLasso();
        if (this.scene?.camera) this.scene.camera.inputDisabled = true; // don't orbit while drawing
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'bt-lasso-svg');
        const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        poly.setAttribute('class', 'bt-lasso-path');
        svg.appendChild(poly);
        this.root.appendChild(svg);
        this.lasso = { pts: [{ x, y }], el: svg as unknown as HTMLElement };
        this.drawLasso();
    }

    private addLassoPoint(x: number, y: number) {
        if (!this.lasso) return;
        this.lasso.pts.push({ x, y });
        this.drawLasso();
    }

    private drawLasso() {
        const poly = this.lasso?.el.querySelector('.bt-lasso-path');
        if (poly && this.lasso) poly.setAttribute('points', this.lasso.pts.map(p => `${p.x},${p.y}`).join(' '));
    }

    private endLasso() {
        if (this.scene?.camera) this.scene.camera.inputDisabled = false;
        this.lasso?.el.remove();
        this.lasso = null;
    }

    private finishLasso() {
        if (!this.lasso || this.lasso.pts.length < 3) {
            this.endLasso(); return;
        }
        const pts = this.lasso.pts;
        const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
        const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
        // close the path visually, then ask for selection depth
        pts.push({ ...pts[0] }); this.drawLasso();
        this.showDepthPrompt(cx, cy);
    }

    private showDepthPrompt(cx: number, cy: number) {
        this.depthPop?.remove();
        const pop = el('div', 'bt-depth-pop bt-interactive');
        pop.appendChild(el('div', 'bt-dp-title', 'Selection depth'));
        pop.appendChild(el('div', 'bt-dp-sub', 'How far into the scene the lasso selects'));
        const row = el('div', 'bt-dp-row', '<input type="range" min="0.2" max="5" step="0.1" value="1.5"><span class="bt-dp-val">1.5 m</span>');
        const slider = row.querySelector('input') as HTMLInputElement;
        const valEl = row.querySelector('.bt-dp-val') as HTMLElement;
        slider.addEventListener('input', () => {
            valEl.textContent = `${(+slider.value).toFixed(1)} m`;
        });
        pop.appendChild(row);
        const actions = el('div', 'bt-dp-actions');
        const cancel = el('button', 'bt-dp-cancel', 'Cancel');
        cancel.addEventListener('click', () => this.cancelLasso());
        const create = el('button', 'bt-dp-create', 'Create selection');
        create.addEventListener('click', () => this.commitLasso(cx, cy));
        actions.appendChild(cancel); actions.appendChild(create);
        pop.appendChild(actions);
        pop.style.left = `${Math.min(Math.max(cx - 120, 12), window.innerWidth - 256)}px`;
        pop.style.top = `${Math.min(cy + 14, window.innerHeight - 190)}px`;
        this.depthPop = pop;
        this.root.appendChild(pop);
        this.refreshBottom(); // hide the snapshot bar while the prompt is open
    }

    private cancelLasso() {
        this.depthPop?.remove(); this.depthPop = null; this.endLasso();
        this.refreshBottom(); // restore the snapshot bar
    }

    private commitLasso(cx: number, cy: number) {
        this.depthPop?.remove(); this.depthPop = null;
        this.endLasso();
        // faked SAM: select whatever object sits under the lasso's centre
        const obj = this.pickObjectAt(cx, cy);
        if (obj) this.selectSceneObject(obj);
        else this.refreshBottom(); // nothing selected → bring the snapshot bar back
    }

    // ── crop / volume (bounding-box) selection — the interview's #1 tool ──
    private startCrop(x: number, y: number) {
        this.endCrop();
        if (this.scene?.camera) this.scene.camera.inputDisabled = true;
        const box = el('div', 'bt-crop-box');
        ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach(h => box.appendChild(el('span', `bt-crop-h bt-crop-${h}`)));
        this.root.appendChild(box);
        this.cropBox = { x0: x, y0: y, x1: x, y1: y, el: box };
        this.drawCrop();
    }

    private updateCrop(x: number, y: number) {
        if (!this.cropBox) return;
        this.cropBox.x1 = x; this.cropBox.y1 = y;
        this.drawCrop();
    }

    private drawCrop() {
        const b = this.cropBox; if (!b) return;
        b.el.style.left = `${Math.min(b.x0, b.x1)}px`;
        b.el.style.top = `${Math.min(b.y0, b.y1)}px`;
        b.el.style.width = `${Math.abs(b.x1 - b.x0)}px`;
        b.el.style.height = `${Math.abs(b.y1 - b.y0)}px`;
    }

    private endCrop() {
        if (this.scene?.camera) this.scene.camera.inputDisabled = false;
        this.cropBox?.el.remove(); this.cropBox = null;
        this.cropConfirm?.remove(); this.cropConfirm = null;
        this.refreshBottom(); // restore the snapshot bar (no-op if already correct)
    }

    private finishCrop() {
        if (this.scene?.camera) this.scene.camera.inputDisabled = false; // camera ok again; box stays
        const b = this.cropBox;
        if (!b || Math.abs(b.x1 - b.x0) < 12 || Math.abs(b.y1 - b.y0) < 12) {
            this.endCrop(); return;
        }
        this.showCropConfirm();
    }

    private showCropConfirm() {
        const b = this.cropBox; if (!b) return;
        this.cropConfirm?.remove();
        const bar = el('div', 'bt-crop-confirm bt-interactive');
        bar.appendChild(el('div', 'bt-crop-title', `${ICON.crop}<span>Crop to volume</span>`));
        const depth = el('div', 'bt-crop-depth', '<span>Depth</span><input type="range" min="0.2" max="5" step="0.1" value="2"><span class="bt-crop-val">2.0 m</span>');
        const slider = depth.querySelector('input') as HTMLInputElement;
        const val = depth.querySelector('.bt-crop-val') as HTMLElement;
        slider.addEventListener('input', () => {
            val.textContent = `${(+slider.value).toFixed(1)} m`;
        });
        bar.appendChild(depth);
        const acts = el('div', 'bt-crop-acts');
        const cancel = el('button', 'bt-crop-cancel', 'Cancel');
        cancel.addEventListener('click', () => this.endCrop());
        const apply = el('button', 'bt-crop-apply', 'Apply crop');
        apply.addEventListener('click', () => this.applyCrop());
        acts.appendChild(cancel); acts.appendChild(apply);
        bar.appendChild(acts);
        const l = Math.min(b.x0, b.x1), t = Math.min(b.y0, b.y1), w = Math.abs(b.x1 - b.x0);
        bar.style.left = `${Math.min(Math.max(l + w / 2 - 152, 12), window.innerWidth - 316)}px`;
        bar.style.top = `${Math.min(Math.max(t - 8, 100), window.innerHeight - 150)}px`;
        this.cropConfirm = bar;
        this.root.appendChild(bar);
        this.refreshBottom(); // hide the snapshot bar while the confirm is open
    }

    private applyCrop() {
        // Crop to the drawn volume: keep every object whose screen position falls inside
        // the box and drop the rest. Fall back to keeping the current selection.
        const inside = this.objectsInCropBox();
        this.endCrop();
        this.cropToObjects(inside.length ? inside : (this.selection ? [this.selection] : []));
    }

    // objects whose screen-space centre lies inside the current crop box
    private objectsInCropBox(): SceneObject[] {
        const b = this.cropBox;
        const cam = this.cameraComponent();
        const canvas = this.canvas;
        if (!b || !cam || !canvas) return [];
        const x0 = Math.min(b.x0, b.x1), x1 = Math.max(b.x0, b.x1);
        const y0 = Math.min(b.y0, b.y1), y1 = Math.max(b.y0, b.y1);
        const rect = canvas.getBoundingClientRect();
        const sp = new Vec3();
        const hits: SceneObject[] = [];
        for (const o of this.objects) {
            if (o.entity.enabled === false) continue;
            cam.worldToScreen(o.entity.getPosition(), sp);
            const sx = rect.left + sp.x * (rect.width / canvas.width);
            const sy = rect.top + sp.y * (rect.height / canvas.height);
            if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) hits.push(o);
        }
        return hits;
    }

    // "Crop to" / delete-all-but: keep only `keep`, hide + drop everything else
    private cropToObjects(keep: SceneObject[]) {
        if (!keep.length) return;
        const keepSet = new Set(keep);
        this.objects.forEach((o) => {
            if (!keepSet.has(o)) o.entity.enabled = false;
        });
        this.objects = this.objects.filter(o => keepSet.has(o));
        if (this.scene) this.scene.forceRender = true;
        const sel = this.selection && keepSet.has(this.selection) ? this.selection : keep[0];
        this.selectSceneObject(sel);
        this.renderCaptures(); // rebuild scrubber + sequencer for the reduced object set
    }

    // ── frame-all / fly-to-content (the interview's main pain point) ──
    private frameAll() {
        const cam = this.scene?.camera;
        if (!cam?.focus) {
            this.events?.fire?.('camera.focus'); return;
        }
        const vis = this.objects.filter(o => o.entity.enabled !== false);
        if (vis.length === 0) {
            cam.focus({ focalPoint: new Vec3(0, 0.3, 0), radius: 1, speed: 1 }); this.pumpRender(650); return;
        }
        const min = new Vec3(Infinity, Infinity, Infinity);
        const max = new Vec3(-Infinity, -Infinity, -Infinity);
        for (const o of vis) {
            const p = o.entity.getPosition(); const s = o.entity.getLocalScale().x * 0.6;
            min.x = Math.min(min.x, p.x - s); min.y = Math.min(min.y, p.y - s); min.z = Math.min(min.z, p.z - s);
            max.x = Math.max(max.x, p.x + s); max.y = Math.max(max.y, p.y + s); max.z = Math.max(max.z, p.z + s);
        }
        const center = new Vec3((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
        const radius = Math.max(0.6, Math.hypot(max.x - min.x, max.y - min.y, max.z - min.z) * 0.6);
        cam.focus({ focalPoint: center, radius, speed: 1 });
        this.pumpRender(650);
    }

    // ── keyboard map (spec §8): Q/E/R transforms · F frame · ⌫ delete · Esc deselect ──
    private wireKeyboard() {
        // Capture phase: this must run BEFORE SuperSplat's own document-level keydown,
        // which calls stopPropagation() on the keys it owns (e.g. 'f' → camera.focus).
        // On the bubble phase our window listener fired too late and never saw them.
        window.addEventListener('keydown', (e) => {
            const t = e.target as HTMLElement;
            if (t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA' || t?.isContentEditable) return;
            const mod = e.metaKey || e.ctrlKey || e.altKey;
            const k = e.key.toLowerCase();
            // global mode shortcuts (any state): V = Select, H = Explore
            if (!mod && !e.shiftKey) {
                if (k === 'v') {
                    e.preventDefault(); e.stopPropagation(); this.activateSelect(); return;
                }
                if (k === 'h') {
                    e.preventDefault(); e.stopPropagation(); this.selectTool('explore'); return;
                }
            }
            // ⌘K / Ctrl+K — Crop to: keep only the selection, drop the rest
            if ((e.metaKey || e.ctrlKey) && !e.altKey && k === 'k') {
                e.preventDefault(); e.stopPropagation();
                if (this.state === 'selected' && this.selection) this.cropToObjects([this.selection]);
                return;
            }
            if (e.key === 'Escape') {
                // one layer per press: lasso/menus → popover → recording → library/list → deselect
                if (this.menuDropdown) {
                    this.closeMenu(); return;
                }
                if (this.depthPop) {
                    this.cancelLasso(); return;
                }
                if (this.cropConfirm || this.cropBox) {
                    this.endCrop(); return;
                }
                if (this.selectMenu) {
                    this.closeSelectMenu(); return;
                }
                if (this.lasso) {
                    this.endLasso(); return;
                }
                if (this.strengthPop) {
                    this.hideStrengthPop(); this.openChip = null; this.refreshBottom();
                } else if (this.effectsPanel) this.hideEffectsLibrary(); // close the library, keep the chip list
                else if (this.recordingMode) this.finishRecording(false);
                else if (this.effectsMode) this.closeEffects();
                else if (this.interactionsMode) this.closeInteractions();
                else this.selectObject(false);
                return;
            }
            if (e.key === ' ' || e.code === 'Space') {
                e.preventDefault(); e.stopPropagation(); this.togglePlay(); return;
            } // play/pause
            if (this.state !== 'selected') return; // leave WASD etc. to the camera
            if (mod) return; // don't clobber browser / SuperSplat combos (Cmd+R, Ctrl+Z…)
            switch (k) {
                case 'q': e.stopPropagation(); this.setGizmoMode('move'); break;
                case 'e': e.stopPropagation(); this.setGizmoMode('scale'); break;
                case 'r': e.stopPropagation(); this.setGizmoMode('rotate'); break;
                case 'f': e.preventDefault(); e.stopPropagation(); this.frameSelection(); break;
                case 'delete': case 'backspace': e.stopPropagation(); this.deleteSelection(); break;
                default:
            }
        }, true);
    }

    // Faked SAM: pick the selectable object nearest the cursor (screen-space), or null.
    private pickObjectAt(clientX: number, clientY: number): SceneObject | null {
        const cam = this.cameraComponent();
        const canvas = this.canvas;
        if (!cam || !canvas) return this.objects[0] ?? null;
        const rect = canvas.getBoundingClientRect();
        const sp = new Vec3();
        let best: SceneObject | null = null;
        let bestD = 150; // px threshold
        for (const obj of this.objects) {
            if (obj.entity.enabled === false) continue;
            cam.worldToScreen(obj.entity.getPosition(), sp);
            const sx = sp.x * (rect.width / canvas.width);
            const sy = sp.y * (rect.height / canvas.height);
            const d = Math.hypot((clientX - rect.left) - sx, (clientY - rect.top) - sy);
            if (d < bestD) {
                bestD = d; best = obj;
            }
        }
        return best;
    }

    // switch the active selection to a different world object
    private selectSceneObject(obj: SceneObject) {
        if (this.boxMat && this.boxMat !== obj.mat) { // revert the old object's colour
            const idle = this.selection?.idle ?? IDLE_DIFFUSE;
            this.boxMat.diffuse.copy(idle);
            this.boxMat.emissive.copy(idle);
            this.boxMat.update();
        }
        this.box = obj.entity;
        this.boxMat = obj.mat;
        this.selection = obj;
        if (obj.audioIndex != null) this.activeAudio = obj.audioIndex; // selecting a pin edits its sound
        this.selectObject(true); // yellow + selected chrome + gizmo
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
        this.clearGizmo(); // drop any gizmo from the previously-selected object so it re-attaches to this one
        if (this.boxMat && this.box?.enabled !== false) {
            const c = sel ? SEL_DIFFUSE : (this.selection?.idle ?? IDLE_DIFFUSE);
            this.boxMat.diffuse.copy(c);
            this.boxMat.emissive.copy(c);
            this.boxMat.update();
            if (this.scene) this.scene.forceRender = true;
        }
        // Selecting implies Select mode; on deselect stay in whichever mode is live
        // (Select if a select sub-tool is active, else Explore) — don't snap to Explore.
        this.setActiveTool(sel || this.selectMode ? 'sam' : 'explore');
        this.setState(sel ? 'selected' : 'explore');
        // Selection shows the highlight only — no gizmo until a transform tool
        // (Q/E/R) is chosen. Matches "Selected - best" (no gizmo) vs "W - Move - best"
        // (move gizmo). The previous object's gizmo was already cleared above.
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
        const render = () => {
            if (this.scene) this.scene.forceRender = true;
        };
        const suppressCamera = (on: boolean) => {
            if (this.scene?.camera) this.scene.camera.inputDisabled = on;
        };
        // while an axis is being dragged, stop the camera from orbiting under it
        gizmo.on('transform:start', () => {
            suppressCamera(true); render();
        });
        gizmo.on('transform:move', render);
        gizmo.on('transform:end', () => {
            suppressCamera(false); render();
        });
        this.gizmo = gizmo;
        this.gizmoMode = mode;
        render();
        this.refreshHeaderCenter(); // highlight active Q/E/R
    }

    private clearGizmo() {
        if (this.gizmo) {
            try {
                this.gizmo.detach(); this.gizmo.destroy();
            } catch (e) { /* noop */ }
            this.gizmo = null;
        }
        this.gizmoMode = null;
        if (this.scene?.camera) this.scene.camera.inputDisabled = false; // safety if torn down mid-drag
        if (this.scene) this.scene.forceRender = true;
    }

    private frameSelection() {
        const cam = this.scene?.camera; // Camera element
        if (cam?.focus && this.box && this.box.enabled !== false) {
            const s = this.box.getLocalScale();
            // bounding-sphere radius of the unit primitive scaled by s (covers tall/wide
            // shapes, not just x), times a margin so it sits comfortably in frame at a
            // good distance rather than filling it edge-to-edge.
            const radius = Math.max(0.5 * Math.hypot(s.x, s.y, s.z) * 3.6, 0.4);
            cam.focus({ focalPoint: this.box.getPosition(), radius, speed: 1 });
            // SuperSplat renders on demand; pump forceRender so the focus animation is drawn.
            this.pumpRender(700);
        } else {
            this.events?.fire?.('camera.focus');
        }
    }

    // keep the scene rendering for `ms` so an on-demand camera animation is visible
    private pumpRender(ms: number) {
        const start = performance.now();
        const tick = () => {
            if (this.scene) this.scene.forceRender = true;
            if (performance.now() - start < ms) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }

    private deleteSelection() {
        this.clearGizmo();
        if (this.box) {
            this.box.enabled = false;                                  // hide it
            this.objects = this.objects.filter(o => o.entity !== this.box); // and drop it from selectables
        }
        if (this.scene) this.scene.forceRender = true;
        this.selectObject(false);
    }

    destroy() {
        document.body.classList.remove('bt-mode');
        this.root.remove();
    }
}

export { BraintranceUI };
