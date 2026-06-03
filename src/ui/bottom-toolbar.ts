import { Button, Element, Container } from '@playcanvas/pcui';

import { Events } from '../events';
import { ShortcutManager } from '../shortcut-manager';
import { localize } from './localization';
import assetBrowserSvg from './svg/asset-browser.svg';
import micSvg from './svg/microphone.svg';
import redoSvg from './svg/redo.svg';
import brushSvg from './svg/select-brush.svg';
import eyedropperSvg from './svg/select-eyedropper.svg';
import floodSvg from './svg/select-flood.svg';
import lassoSvg from './svg/select-lasso.svg';
import pickerSvg from './svg/select-picker.svg';
import polygonSvg from './svg/select-poly.svg';
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

        // Simplified toolbar
        const mic = new Button({
            id: 'bottom-toolbar-mic',
            class: 'bottom-toolbar-tool'
        });

        const touch = new Button({
            id: 'bottom-toolbar-touch',
            class: 'bottom-toolbar-tool'
        });

        const semanticScan = new Button({
            id: 'bottom-toolbar-semantic-scan',
            class: 'bottom-toolbar-tool'
        });

        const samModeWrap = document.createElement('div');
        samModeWrap.id = 'sam3-mode-wrap';

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

        const simplifiedAssetBrowser = new Button({
            id: 'bottom-toolbar-asset-browser',
            class: 'bottom-toolbar-tool'
        });

        mic.dom.appendChild(createSvg(micSvg));
        touch.dom.appendChild(createSvg(touchSvg));
        semanticScan.dom.appendChild(createSvg(semanticScanSvg));
        simplifiedAssetBrowser.dom.appendChild(createSvg(assetBrowserSvg));

        appendSimplified(mic);
        appendSimplified(touch);
        appendSimplified(samModeWrap);
        appendSimplified(semanticScan);

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

        mic.dom.addEventListener('click', () => events.fire('voice.toggle'));
        mic.dom.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            events.fire('voice.toggleWakeWord');
        });
        touch.dom.addEventListener('click', () => events.fire('tool.sam3Selection'));
        semanticScan.dom.addEventListener('click', () => events.fire('semanticScan.run'));
        simplifiedAssetBrowser.dom.addEventListener('click', () => events.fire('assetBrowser.toggleVisible'));

        tooltips.register(mic, 'Voice Control (hold Space, right-click for wake word)');
        tooltips.register(touch, tooltip('Touch Select', 'tool.sam3Selection'));
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
        brush.dom.addEventListener('click', () => events.fire('tool.brushSelection'));
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

        events.on('tool.activated', (toolName: string) => {
            touch.class[toolName === 'sam3Selection' ? 'add' : 'remove']('active');

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

        events.on('voice.active', (active: boolean) => {
            mic.dom.classList[active ? 'add' : 'remove']('voice-active');
        });

        events.on('voice.listening', (listening: boolean) => {
            mic.dom.classList[listening ? 'add' : 'remove']('voice-listening');
        });

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
