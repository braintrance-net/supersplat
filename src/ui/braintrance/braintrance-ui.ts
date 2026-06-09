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
    expand: stroke('<path d="M21 21l-6-6"/><path d="M21 15v6h-6"/><path d="M3 3l6 6"/><path d="M3 9V3h6"/>', 18)
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
    private selection = {
        name: 'Cuboid',
        effects: ['Vivid', 'Bloom'],
        interactions: ['On click → moves + glows']
    };

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

    // ── selection contextual bar (Selected / Move state) ──
    private contextBar(): HTMLElement {
        const bar = el('div', 'bt-contextbar');

        const head = el('div', 'bt-cb-head');
        head.appendChild(el('div', 'bt-cb-name', `${ICON.globe}<span>${this.selection.name}</span>`));
        head.appendChild(el('div', 'bt-pause', `${ICON.pause}<span>Pause</span>`));
        bar.appendChild(head);

        // Badges = the effects / interactions already on this selection.
        const actions = el('div', 'bt-cb-actions');
        const eff = el('button', 'bt-cb-btn bt-effect',
            `<span>Add Effect</span><span class="bt-cb-badge">${this.selection.effects.length} ${ICON.sparkles}</span>`);
        const inter = el('button', 'bt-cb-btn bt-interaction',
            `<span>Add interaction</span><span class="bt-cb-badge">${this.selection.interactions.length} ${ICON.zap}</span>`);
        actions.appendChild(eff);
        actions.appendChild(inter);
        actions.appendChild(el('button', 'bt-icon-btn', ICON.reset));
        bar.appendChild(actions);

        bar.appendChild(el('div', 'bt-cb-hint', 'Shift click adds, ctrl click removes'));
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
        // SAM = select the placeholder; any other tool returns to explore chrome.
        if (tool === 'sam') {
            this.selectObject(true);
        } else {
            this.selectObject(false);
            this.setActiveTool(tool);
        }
    }

    setState(state: EditorState) {
        this.state = state;
        this.refreshHeaderCenter();
        // bottom center panel
        const next = state === 'selected' ? this.contextBar() : this.snapshotPanel();
        this.bottomCenter.replaceWith(next);
        this.bottomCenter = next;
        // default active rail item matches state
        if (state === 'explore' && !Object.values(this.railItems).some(i => i?.classList.contains('is-active'))) {
            this.railItems.explore?.classList.add('is-active');
        }
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
            this.selectObject(this.hitsPlaceholder(e.clientX, e.clientY));
        });
    }

    // ── keyboard map (spec §8): Q/E/R transforms · F frame · ⌫ delete · Esc deselect ──
    private wireKeyboard() {
        window.addEventListener('keydown', (e) => {
            const tag = (e.target as HTMLElement)?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA') return;
            if (e.key === 'Escape') { this.selectObject(false); return; }
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
        if (cam?.setFocalPoint && this.box && this.box.enabled !== false) {
            cam.setFocalPoint(this.box.getPosition());        // re-centre orbit on the cube
            cam.setDistance?.(1.2, 0.4);                      // pull to a comfortable framing
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
