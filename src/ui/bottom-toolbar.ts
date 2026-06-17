import { Button, Element, Container } from '@playcanvas/pcui';

import { Events } from '../events';
import { ShortcutManager } from '../shortcut-manager';
import { localize } from './localization';
import assetBrowserSvg from './svg/asset-browser.svg';
import redoSvg from './svg/redo.svg';
import boxVolumeSvg from './svg/select-box-volume.svg';
import boxerSvg from './svg/select-boxer.svg';
import brushSvg from './svg/select-brush.svg';
import eyedropperSvg from './svg/select-eyedropper.svg';
import floodSvg from './svg/select-flood.svg';
import lassoSvg from './svg/select-lasso.svg';
import normalSvg from './svg/select-normal.svg';
import pickerSvg from './svg/select-picker.svg';
import polygonSvg from './svg/select-poly.svg';
import samSvg from './svg/select-sam.svg';
import sphereSvg from './svg/select-sphere.svg';
import semanticScanSvg from './svg/semantic-scan.svg';
import boxSvg from './svg/show-hide-splats.svg';
import touchSvg from './svg/touch.svg';
import undoSvg from './svg/undo.svg';
import { Tooltips } from './tooltips';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

type RawBrushMode = 'new' | 'add' | 'remove' | 'intersect';
type BrushSelectionVariant = 'boxer' | 'sam' | 'raw' | 'raw3d';

class BottomToolbar extends Container {
    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'bottom-toolbar'
        };

        super(args);

        this.dom.addEventListener('pointerdown', (event) => {
            event.stopPropagation();
        });

        const shortcutManager: ShortcutManager = events.invoke('shortcutManager');
        const tooltip = (localeKey: string, shortcutId?: string) => {
            const text = localize(localeKey);
            if (shortcutId) {
                const shortcut = shortcutManager.formatShortcut(shortcutId);
                if (shortcut) {
                    return `${text} ( ${shortcut} )`;
                }
            }
            return text;
        };
        const addVariantBadge = (button: Button, label: string) => {
            const badge = document.createElement('span');
            badge.className = 'bottom-toolbar-variant-badge';
            badge.textContent = label;
            button.dom.appendChild(badge);
        };
        const addExperimentalBadge = (button: Button) => {
            const badge = document.createElement('span');
            badge.className = 'bottom-toolbar-experimental-badge';
            badge.textContent = '⚑';
            button.dom.appendChild(badge);
        };

        const simplifiedGroup = new Element({
            id: 'bottom-toolbar-simplified'
        });

        const advancedGroup = new Element({
            id: 'bottom-toolbar-advanced'
        });

        this.append(simplifiedGroup);
        this.append(advancedGroup);

        const appendSimplified = (node: HTMLElement | Element) => {
            if (node instanceof Element) {
                simplifiedGroup.dom.appendChild(node.dom);
            } else {
                simplifiedGroup.dom.appendChild(node);
            }
        };

        const appendAdvanced = (node: HTMLElement | Element) => {
            if (node instanceof Element) {
                advancedGroup.dom.appendChild(node.dom);
            } else {
                advancedGroup.dom.appendChild(node);
            }
        };
        const numericShortcutOrder = (shortcutId: string | undefined, fallbackOrder: number) => {
            const key = shortcutId ?
                shortcutManager.get(shortcutId)?.keys?.find(value => /^[1-9]$/.test(value)) :
                undefined;
            return key ? Number(key) : fallbackOrder;
        };
        const appendSimplifiedOrdered = (items: {
            node: HTMLElement | Element;
            shortcutId?: string;
            fallbackOrder: number;
        }[]) => {
            const seen = new Map<number, string>();
            for (const item of items) {
                if (!item.shortcutId) continue;
                const key = shortcutManager.get(item.shortcutId)?.keys?.find(value => /^[1-9]$/.test(value));
                if (!key) continue;
                const numericKey = Number(key);
                const existing = seen.get(numericKey);
                if (existing) {
                    console.warn(`[BottomToolbar] duplicate numeric shortcut ${numericKey}: ${existing}, ${item.shortcutId}`);
                }
                seen.set(numericKey, item.shortcutId);
            }

            [...items]
            .sort((a, b) => {
                const orderDelta = numericShortcutOrder(a.shortcutId, a.fallbackOrder) -
                    numericShortcutOrder(b.shortcutId, b.fallbackOrder);
                return orderDelta || a.fallbackOrder - b.fallbackOrder;
            })
            .forEach(item => appendSimplified(item.node));
        };

        // Simplified toolbar
        const normal = new Button({
            id: 'bottom-toolbar-normal',
            class: 'bottom-toolbar-tool'
        });

        const touch = new Button({
            id: 'bottom-toolbar-touch',
            class: 'bottom-toolbar-tool'
        });

        const boxer = new Button({
            id: 'bottom-toolbar-boxer',
            class: 'bottom-toolbar-tool'
        });

        const brushBoxerSelect = new Button({
            id: 'bottom-toolbar-brush-boxer',
            class: 'bottom-toolbar-tool'
        });
        brushBoxerSelect.dom.classList.add('bottom-toolbar-variant-tool');

        const brushSamSelect = new Button({
            id: 'bottom-toolbar-brush-sam',
            class: 'bottom-toolbar-tool'
        });
        brushSamSelect.dom.classList.add('bottom-toolbar-variant-tool');

        const brushRawSelect = new Button({
            id: 'bottom-toolbar-brush-raw',
            class: 'bottom-toolbar-tool'
        });
        brushRawSelect.dom.classList.add('bottom-toolbar-variant-tool');

        const brushRaw3dSelect = new Button({
            id: 'bottom-toolbar-brush-raw-3d',
            class: 'bottom-toolbar-tool'
        });
        brushRaw3dSelect.dom.title = '3D Brush - Experimental';
        brushRaw3dSelect.dom.setAttribute('aria-label', '3D Brush - Experimental');
        brushRaw3dSelect.dom.classList.add('bottom-toolbar-variant-tool');

        const boxerAll = new Button({
            id: 'bottom-toolbar-boxer-all',
            class: 'bottom-toolbar-text-tool',
            text: 'All'
        });

        const manualBox = new Button({
            id: 'bottom-toolbar-manual-box',
            class: 'bottom-toolbar-tool'
        });

        const boxVolume = new Button({
            id: 'bottom-toolbar-box-volume',
            class: 'bottom-toolbar-tool'
        });

        const semanticScan = new Button({
            id: 'bottom-toolbar-semantic-scan',
            class: 'bottom-toolbar-tool'
        });

        const samModeWrap = document.createElement('div');
        samModeWrap.id = 'sam3-mode-wrap';
        samModeWrap.className = 'hidden';

        const samModeButtons = [
            { mode: 'set', label: 'New' },
            { mode: 'add', label: 'Add' },
            { mode: 'remove', label: 'Remove' }
        ] as const;

        const activateSam3Selection = () => {
            if (events.invoke('tool.active') !== 'sam3Selection') {
                events.fire('tool.sam3Selection');
            }
        };

        for (const { mode, label } of samModeButtons) {
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.mode = mode;
            button.textContent = label;
            button.className = 'sam3-mode-button';
            button.addEventListener('click', (event) => {
                event.stopPropagation();
                events.fire('sam3.selectionMode', mode);
                activateSam3Selection();
            });
            samModeWrap.appendChild(button);
        }

        const rawBrushModeWrap = document.createElement('div');
        rawBrushModeWrap.id = 'raw-brush-mode-wrap';
        rawBrushModeWrap.className = 'hidden';
        rawBrushModeWrap.addEventListener('pointerdown', event => event.stopPropagation());
        rawBrushModeWrap.addEventListener('pointerup', event => event.stopPropagation());
        rawBrushModeWrap.addEventListener('click', event => event.stopPropagation());

        const rawBrushModeButtons = [
            { mode: 'new', label: 'New', key: 'N' },
            { mode: 'add', label: 'Add', key: 'A' },
            { mode: 'remove', label: 'Remove', key: 'R' },
            { mode: 'intersect', label: 'Intersect', key: 'I' }
        ] as const;

        for (const { mode, label, key } of rawBrushModeButtons) {
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.mode = mode;
            button.className = 'raw-brush-mode-button';
            button.title = `Raw brush ${label} (${key})`;
            const keyBadge = document.createElement('span');
            keyBadge.className = 'raw-brush-mode-key';
            keyBadge.textContent = key;
            const labelText = document.createElement('span');
            labelText.textContent = label;
            button.append(keyBadge, labelText);
            const activateMode = (event: Event) => {
                event.stopPropagation();
                events.fire('brushSelection.rawMode', mode);
            };
            button.addEventListener('pointerdown', (event) => {
                event.preventDefault();
                activateMode(event);
            });
            button.addEventListener('pointerup', event => event.stopPropagation());
            button.addEventListener('click', activateMode);
            rawBrushModeWrap.appendChild(button);
        }

        const simplifiedAssetBrowser = new Button({
            id: 'bottom-toolbar-asset-browser',
            class: 'bottom-toolbar-tool'
        });

        normal.dom.appendChild(createSvg(normalSvg));
        touch.dom.appendChild(createSvg(touchSvg));
        boxer.dom.appendChild(createSvg(boxerSvg));
        brushBoxerSelect.dom.appendChild(createSvg(brushSvg));
        brushSamSelect.dom.appendChild(createSvg(samSvg));
        brushRawSelect.dom.appendChild(createSvg(brushSvg));
        brushRaw3dSelect.dom.appendChild(createSvg(brushSvg));
        addVariantBadge(brushBoxerSelect, 'B');
        addVariantBadge(brushSamSelect, 'S');
        addVariantBadge(brushRawSelect, '2D');
        addVariantBadge(brushRaw3dSelect, '3D');
        addExperimentalBadge(brushRaw3dSelect);
        manualBox.dom.appendChild(createSvg(boxSvg));
        boxVolume.dom.appendChild(createSvg(boxVolumeSvg));
        semanticScan.dom.appendChild(createSvg(semanticScanSvg));
        simplifiedAssetBrowser.dom.appendChild(createSvg(assetBrowserSvg));

        appendSimplifiedOrdered([
            { node: normal, shortcutId: 'tool.deactivate', fallbackOrder: 1 },
            { node: boxer, shortcutId: 'tool.boxerSelection', fallbackOrder: 2 },
            { node: touch, shortcutId: 'tool.sam3Selection', fallbackOrder: 3 },
            { node: brushBoxerSelect, shortcutId: 'tool.brushSelection.boxer', fallbackOrder: 4 },
            { node: brushSamSelect, shortcutId: 'tool.brushSelection.sam', fallbackOrder: 5 },
            { node: brushRawSelect, shortcutId: 'tool.brushSelection.raw', fallbackOrder: 6 },
            { node: brushRaw3dSelect, shortcutId: 'tool.brushSelection.raw3d', fallbackOrder: 6.5 },
            { node: boxerAll, shortcutId: 'tool.boxerDetectAll', fallbackOrder: 7 },
            { node: manualBox, shortcutId: 'tool.boxSelection', fallbackOrder: 8 },
            { node: boxVolume, shortcutId: 'tool.boxVolume', fallbackOrder: 9 },
            { node: semanticScan, fallbackOrder: 11 }
        ]);
        this.dom.appendChild(samModeWrap);
        this.dom.appendChild(rawBrushModeWrap);

        const aiInputWrap = document.createElement('div');
        aiInputWrap.id = 'ai-prompt-wrap';

        const aiInput = document.createElement('input');
        aiInput.id = 'ai-prompt-input';
        aiInput.type = 'text';
        aiInput.placeholder = 'Type to select…';
        aiInput.spellcheck = false;

        aiInputWrap.addEventListener('pointerdown', e => e.stopPropagation());
        aiInputWrap.addEventListener('pointerup', e => e.stopPropagation());
        aiInputWrap.addEventListener('click', e => e.stopPropagation());

        aiInput.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && aiInput.value.trim()) {
                events.fire('ai.textQuery', aiInput.value.trim());
                aiInput.value = '';
            }
            if (e.key === 'Escape') {
                aiInput.blur();
            }
        });
        aiInput.addEventListener('keyup', e => e.stopPropagation());
        aiInput.addEventListener('keypress', e => e.stopPropagation());

        aiInputWrap.appendChild(aiInput);
        appendSimplified(aiInputWrap);
        appendSimplified(new Element({ class: 'bottom-toolbar-separator' }));
        appendSimplified(simplifiedAssetBrowser);

        normal.dom.addEventListener('click', () => events.fire('tool.deactivate'));
        let brushVariant: BrushSelectionVariant = 'boxer';
        let rawBrushMode: RawBrushMode = 'new';
        const isRawBrushVariant = () => brushVariant === 'raw' || brushVariant === 'raw3d';
        const positionFloatingWrap = (wrap: HTMLElement, target: HTMLElement) => {
            if (wrap.classList.contains('hidden')) {
                return;
            }

            window.requestAnimationFrame(() => {
                if (wrap.classList.contains('hidden')) {
                    return;
                }

                const toolbarRect = this.dom.getBoundingClientRect();
                const targetRect = target.getBoundingClientRect();
                wrap.style.left = `${targetRect.left - toolbarRect.left + targetRect.width / 2}px`;
            });
        };
        const positionSamModeWrap = () => {
            positionFloatingWrap(samModeWrap, touch.dom);
        };
        const positionRawBrushModeWrap = () => {
            positionFloatingWrap(rawBrushModeWrap, brushVariant === 'raw3d' ? brushRaw3dSelect.dom : brushRawSelect.dom);
        };
        const syncRawBrushModeButtons = (mode: RawBrushMode) => {
            rawBrushMode = mode === 'add' || mode === 'remove' || mode === 'intersect' ? mode : 'new';
            for (const button of Array.from(rawBrushModeWrap.querySelectorAll<HTMLButtonElement>('.raw-brush-mode-button'))) {
                button.classList.toggle('active', button.dataset.mode === rawBrushMode);
            }
        };
        const syncRawBrushModeWrap = () => {
            const visible = events.invoke('tool.active') === 'brushSelection' && isRawBrushVariant();
            rawBrushModeWrap.classList.toggle('hidden', !visible);
            if (visible) {
                positionRawBrushModeWrap();
            }
        };
        const syncSamModeWrap = () => {
            const visible = events.invoke('tool.active') === 'sam3Selection';
            samModeWrap.classList.toggle('hidden', !visible);
            if (visible) {
                positionSamModeWrap();
            }
        };
        const activateBrushVariant = (variant: BrushSelectionVariant) => {
            const activeTool = events.invoke('tool.active');
            const currentVariant = (events.invoke('brushSelection.getVariant') as BrushSelectionVariant | undefined) ?? brushVariant;
            if (activeTool === 'brushSelection' && currentVariant === variant) {
                events.fire('tool.brushSelection');
                return;
            }

            events.fire('brushSelection.variant', variant);
            if (activeTool !== 'brushSelection') {
                events.fire('tool.brushSelection');
            }
        };

        touch.dom.addEventListener('click', () => events.fire('tool.sam3Selection'));
        boxer.dom.addEventListener('click', () => events.fire('tool.boxerSelection'));
        brushBoxerSelect.dom.addEventListener('click', () => activateBrushVariant('boxer'));
        brushSamSelect.dom.addEventListener('click', () => activateBrushVariant('sam'));
        brushRawSelect.dom.addEventListener('click', () => activateBrushVariant('raw'));
        brushRaw3dSelect.dom.addEventListener('click', () => activateBrushVariant('raw3d'));
        events.on('tool.brushSelection.boxer', () => activateBrushVariant('boxer'));
        events.on('tool.brushSelection.sam', () => activateBrushVariant('sam'));
        events.on('tool.brushSelection.raw', () => activateBrushVariant('raw'));
        events.on('tool.brushSelection.raw3d', () => activateBrushVariant('raw3d'));
        const runBoxerDetectAll = async () => {
            try {
                await events.invoke('boxer.runDetectAll');
            } catch (err) {
                console.error('[Boxer] Detect-all probe failed', err);
                events.fire('toast', 'Boxer detect-all probe failed', 'error');
            }
        };
        boxerAll.dom.addEventListener('click', runBoxerDetectAll);
        events.on('tool.boxerDetectAll', runBoxerDetectAll);
        manualBox.dom.addEventListener('click', () => events.fire('tool.boxSelection'));
        boxVolume.dom.addEventListener('click', () => events.fire('tool.boxVolume'));
        semanticScan.dom.addEventListener('click', () => events.fire('semanticScan.run'));
        simplifiedAssetBrowser.dom.addEventListener('click', () => events.fire('assetBrowser.toggleVisible'));

        tooltips.register(normal, tooltip('No Tool', 'tool.deactivate'));
        tooltips.register(touch, tooltip('Touch Select', 'tool.sam3Selection'));
        tooltips.register(boxer, tooltip('Boxer Select', 'tool.boxerSelection'));
        tooltips.register(brushBoxerSelect, tooltip('Brush Boxer', 'tool.brushSelection.boxer'));
        tooltips.register(brushSamSelect, tooltip('Brush SAM', 'tool.brushSelection.sam'));
        tooltips.register(brushRawSelect, tooltip('2D Brush', 'tool.brushSelection.raw'));
        tooltips.register(brushRaw3dSelect, '3D Brush - Experimental');
        tooltips.register(boxerAll, tooltip('Boxer Detect All', 'tool.boxerDetectAll'));
        tooltips.register(manualBox, tooltip('4 Click Box', 'tool.boxSelection'));
        tooltips.register(boxVolume, tooltip('Box Volume', 'tool.boxVolume'));
        tooltips.register(semanticScan, 'Scan Semantic Labels');
        tooltips.register(simplifiedAssetBrowser, 'Asset Browser');

        // Advanced toolbar from original braintrance branch
        const undo = new Button({
            id: 'bottom-toolbar-undo',
            class: 'bottom-toolbar-button',
            enabled: false
        });

        const redo = new Button({
            id: 'bottom-toolbar-redo',
            class: 'bottom-toolbar-button',
            enabled: false
        });

        const picker = new Button({
            id: 'bottom-toolbar-picker',
            class: 'bottom-toolbar-tool'
        });

        const polygon = new Button({
            id: 'bottom-toolbar-polygon',
            class: 'bottom-toolbar-tool'
        });

        const brush = new Button({
            id: 'bottom-toolbar-brush',
            class: 'bottom-toolbar-tool'
        });

        const flood = new Button({
            id: 'bottom-toolbar-flood',
            class: 'bottom-toolbar-tool'
        });

        const lasso = new Button({
            id: 'bottom-toolbar-lasso',
            class: 'bottom-toolbar-tool'
        });

        const sphere = new Button({
            id: 'bottom-toolbar-sphere',
            class: 'bottom-toolbar-tool'
        });

        const box = new Button({
            id: 'bottom-toolbar-box',
            class: 'bottom-toolbar-tool'
        });

        const eyedropper = new Button({
            id: 'bottom-toolbar-eyedropper',
            class: 'bottom-toolbar-tool'
        });

        const translate = new Button({
            id: 'bottom-toolbar-translate',
            class: 'bottom-toolbar-tool',
            icon: 'E111'
        });

        const rotate = new Button({
            id: 'bottom-toolbar-rotate',
            class: 'bottom-toolbar-tool',
            icon: 'E113'
        });

        const scale = new Button({
            id: 'bottom-toolbar-scale',
            class: 'bottom-toolbar-tool',
            icon: 'E112'
        });

        const measure = new Button({
            id: 'bottom-toolbar-measure',
            class: 'bottom-toolbar-tool',
            icon: 'E358'
        });

        const coordSpace = new Button({
            id: 'bottom-toolbar-coord-space',
            class: 'bottom-toolbar-toggle',
            icon: 'E118'
        });

        const origin = new Button({
            id: 'bottom-toolbar-origin',
            class: 'bottom-toolbar-toggle',
            icon: 'E189'
        });

        undo.dom.appendChild(createSvg(undoSvg));
        redo.dom.appendChild(createSvg(redoSvg));
        picker.dom.appendChild(createSvg(pickerSvg));
        polygon.dom.appendChild(createSvg(polygonSvg));
        brush.dom.appendChild(createSvg(brushSvg));
        flood.dom.appendChild(createSvg(floodSvg));
        sphere.dom.appendChild(createSvg(sphereSvg));
        box.dom.appendChild(createSvg(boxSvg));
        lasso.dom.appendChild(createSvg(lassoSvg));
        eyedropper.dom.appendChild(createSvg(eyedropperSvg));

        [
            undo,
            redo,
            new Element({ class: 'bottom-toolbar-separator' }),
            picker,
            lasso,
            polygon,
            brush,
            flood,
            eyedropper,
            new Element({ class: 'bottom-toolbar-separator' }),
            sphere,
            box,
            new Element({ class: 'bottom-toolbar-separator' }),
            translate,
            rotate,
            scale,
            new Element({ class: 'bottom-toolbar-separator' }),
            measure,
            coordSpace,
            origin
        ].forEach(appendAdvanced);

        undo.dom.addEventListener('click', () => events.fire('edit.undo'));
        redo.dom.addEventListener('click', () => events.fire('edit.redo'));
        picker.dom.addEventListener('click', () => events.fire('tool.rectSelection'));
        lasso.dom.addEventListener('click', () => events.fire('tool.lassoSelection'));
        polygon.dom.addEventListener('click', () => events.fire('tool.polygonSelection'));
        brush.dom.addEventListener('click', () => activateBrushVariant('boxer'));
        flood.dom.addEventListener('click', () => events.fire('tool.floodSelection'));
        eyedropper.dom.addEventListener('click', () => events.fire('tool.eyedropperSelection'));
        sphere.dom.addEventListener('click', () => events.fire('tool.sphereSelection'));
        box.dom.addEventListener('click', () => events.fire('tool.boxSelection'));
        translate.dom.addEventListener('click', () => events.fire('tool.move'));
        rotate.dom.addEventListener('click', () => events.fire('tool.rotate'));
        scale.dom.addEventListener('click', () => events.fire('tool.scale'));
        measure.dom.addEventListener('click', () => events.fire('tool.measure'));
        coordSpace.dom.addEventListener('click', () => events.fire('tool.toggleCoordSpace'));
        origin.dom.addEventListener('click', () => events.fire('pivot.toggleOrigin'));

        events.on('edit.canUndo', (value: boolean) => {
            undo.enabled = value;
        });
        events.on('edit.canRedo', (value: boolean) => {
            redo.enabled = value;
        });

        const syncBrushVariantActive = (toolName: string | null | undefined) => {
            brushBoxerSelect.class[toolName === 'brushSelection' && brushVariant === 'boxer' ? 'add' : 'remove']('active');
            brushSamSelect.class[toolName === 'brushSelection' && brushVariant === 'sam' ? 'add' : 'remove']('active');
            brushRawSelect.class[toolName === 'brushSelection' && brushVariant === 'raw' ? 'add' : 'remove']('active');
            brushRaw3dSelect.class[toolName === 'brushSelection' && brushVariant === 'raw3d' ? 'add' : 'remove']('active');
        };

        events.on('tool.activated', (toolName: string | null) => {
            normal.class[toolName === null ? 'add' : 'remove']('active');
            touch.class[toolName === 'sam3Selection' ? 'add' : 'remove']('active');
            boxer.class[toolName === 'boxerSelection' ? 'add' : 'remove']('active');
            syncBrushVariantActive(toolName);
            syncRawBrushModeWrap();
            syncSamModeWrap();
            manualBox.class[toolName === 'boxSelection' ? 'add' : 'remove']('active');
            boxVolume.class[toolName === 'boxVolume' ? 'add' : 'remove']('active');

            picker.class[toolName === 'rectSelection' ? 'add' : 'remove']('active');
            brush.class[toolName === 'brushSelection' ? 'add' : 'remove']('active');
            flood.class[toolName === 'floodSelection' ? 'add' : 'remove']('active');
            polygon.class[toolName === 'polygonSelection' ? 'add' : 'remove']('active');
            lasso.class[toolName === 'lassoSelection' ? 'add' : 'remove']('active');
            sphere.class[toolName === 'sphereSelection' ? 'add' : 'remove']('active');
            box.class[toolName === 'boxSelection' ? 'add' : 'remove']('active');
            translate.class[toolName === 'move' ? 'add' : 'remove']('active');
            rotate.class[toolName === 'rotate' ? 'add' : 'remove']('active');
            scale.class[toolName === 'scale' ? 'add' : 'remove']('active');
            measure.class[toolName === 'measure' ? 'add' : 'remove']('active');
            eyedropper.class[toolName === 'eyedropperSelection' ? 'add' : 'remove']('active');
        });

        events.on('brushSelection.variant.changed', (variant: BrushSelectionVariant) => {
            brushVariant = variant === 'sam' || variant === 'raw' || variant === 'raw3d' ? variant : 'boxer';
            syncBrushVariantActive(events.invoke('tool.active'));
            syncRawBrushModeWrap();
        });

        events.on('brushSelection.rawMode.changed', (mode: RawBrushMode) => {
            syncRawBrushModeButtons(mode);
        });

        events.on('sam3.selectionMode.changed', (mode: string) => {
            for (const button of Array.from(samModeWrap.querySelectorAll<HTMLButtonElement>('.sam3-mode-button'))) {
                button.classList.toggle('active', button.dataset.mode === mode);
            }
        });

        events.on('semanticScan.running', (running: boolean) => {
            semanticScan.class[running ? 'add' : 'remove']('active');
        });

        events.on('tool.coordSpace', (space: 'local' | 'world') => {
            coordSpace.dom.classList[space === 'local' ? 'add' : 'remove']('active');
        });

        events.on('pivot.origin', (value: 'center' | 'boundCenter') => {
            origin.dom.classList[value === 'boundCenter' ? 'add' : 'remove']('active');
        });

        events.on('assetBrowser.visible', (visible: boolean) => {
            simplifiedAssetBrowser.class[visible ? 'add' : 'remove']('active');
        });

        window.addEventListener('resize', () => {
            positionRawBrushModeWrap();
            positionSamModeWrap();
        });
        syncRawBrushModeButtons(rawBrushMode);
        syncRawBrushModeWrap();
        syncSamModeWrap();

        const transcriptEl = document.createElement('div');
        transcriptEl.id = 'voice-transcript';
        document.body.appendChild(transcriptEl);

        let transcriptTimer: ReturnType<typeof setTimeout> | null = null;
        events.on('voice.transcript', (text: string) => {
            transcriptEl.textContent = text;
            transcriptEl.classList.add('visible');
            if (transcriptTimer) {
                clearTimeout(transcriptTimer);
            }
            transcriptTimer = setTimeout(() => {
                transcriptEl.classList.remove('visible');
            }, 3000);
        });

        tooltips.register(undo, tooltip('tooltip.bottom-toolbar.undo', 'edit.undo'));
        tooltips.register(redo, tooltip('tooltip.bottom-toolbar.redo', 'edit.redo'));
        tooltips.register(picker, tooltip('tooltip.bottom-toolbar.rect', 'tool.rectSelection'));
        tooltips.register(lasso, tooltip('tooltip.bottom-toolbar.lasso', 'tool.lassoSelection'));
        tooltips.register(polygon, tooltip('tooltip.bottom-toolbar.polygon', 'tool.polygonSelection'));
        tooltips.register(brush, tooltip('tooltip.bottom-toolbar.brush', 'tool.brushSelection'));
        tooltips.register(flood, tooltip('tooltip.bottom-toolbar.flood', 'tool.floodSelection'));
        tooltips.register(sphere, tooltip('tooltip.bottom-toolbar.sphere'));
        tooltips.register(box, tooltip('tooltip.bottom-toolbar.box'));
        tooltips.register(translate, tooltip('tooltip.bottom-toolbar.translate', 'tool.move'));
        tooltips.register(rotate, tooltip('tooltip.bottom-toolbar.rotate', 'tool.rotate'));
        tooltips.register(scale, tooltip('tooltip.bottom-toolbar.scale', 'tool.scale'));
        tooltips.register(measure, tooltip('tooltip.bottom-toolbar.measure'));
        tooltips.register(coordSpace, tooltip('tooltip.bottom-toolbar.local-space', 'tool.toggleCoordSpace'));
        tooltips.register(origin, tooltip('tooltip.bottom-toolbar.bound-center'));
        tooltips.register(eyedropper, tooltip('tooltip.bottom-toolbar.eyedropper', 'tool.eyedropperSelection'));
    }
}

export { BottomToolbar };
