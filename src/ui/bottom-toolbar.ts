import { Button, Element, Container } from '@playcanvas/pcui';

import { Events } from '../events';
import { ShortcutManager } from '../shortcut-manager';
import { localize } from './localization';
import redoSvg from './svg/redo.svg';
import brushSvg from './svg/select-brush.svg';
import eyedropperSvg from './svg/select-eyedropper.svg';
import floodSvg from './svg/select-flood.svg';
import lassoSvg from './svg/select-lasso.svg';
import pickerSvg from './svg/select-picker.svg';
import polygonSvg from './svg/select-poly.svg';
import assetBrowserSvg from './svg/asset-browser.svg';
import micSvg from './svg/microphone.svg';
import walkSvg from './svg/walk.svg';
import placeSvg from './svg/place.svg';
import boxerIconSvg from './svg/select-boxer.svg';
import samIconSvg from './svg/select-sam.svg';
import sphereSvg from './svg/select-sphere.svg';
import boxSvg from './svg/show-hide-splats.svg';
import undoSvg from './svg/undo.svg';
import { Tooltips } from './tooltips';
// import cropSvg from './svg/crop.svg';

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

        const boxer = new Button({
            id: 'bottom-toolbar-boxer',
            class: 'bottom-toolbar-tool'
        });

        const walk = new Button({
            id: 'bottom-toolbar-walk',
            class: 'bottom-toolbar-tool'
        });

        const sam3 = new Button({
            id: 'bottom-toolbar-sam3',
            class: 'bottom-toolbar-tool'
        });

        const eyedropper = new Button({
            id: 'bottom-toolbar-eyedropper',
            class: 'bottom-toolbar-tool'
        });

        // const crop = new Button({
        //     id: 'bottom-toolbar-crop',
        //     class: ['bottom-toolbar-tool', 'disabled']
        // });

        const place = new Button({
            id: 'bottom-toolbar-place',
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

        const assetBrowserBtn = new Button({
            id: 'bottom-toolbar-asset-browser',
            class: 'bottom-toolbar-tool'
        });

        const mic = new Button({
            id: 'bottom-toolbar-mic',
            class: 'bottom-toolbar-tool'
        });

        const origin = new Button({
            id: 'bottom-toolbar-origin',
            class: ['bottom-toolbar-toggle'],
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

        assetBrowserBtn.dom.appendChild(createSvg(assetBrowserSvg));
        mic.dom.appendChild(createSvg(micSvg));
        walk.dom.appendChild(createSvg(walkSvg));
        place.dom.appendChild(createSvg(placeSvg));
        boxer.dom.appendChild(createSvg(boxerIconSvg));
        sam3.dom.appendChild(createSvg(samIconSvg));

        // crop.dom.appendChild(createSvg(cropSvg));

        this.append(undo);
        this.append(redo);
        this.append(new Element({ class: 'bottom-toolbar-separator' }));
        this.append(walk);
        this.append(boxer);
        this.append(sam3);
        this.append(new Element({ class: 'bottom-toolbar-separator' }));
        this.append(picker);
        this.append(lasso);
        this.append(polygon);
        this.append(brush);
        this.append(flood);
        this.append(eyedropper);
        this.append(new Element({ class: 'bottom-toolbar-separator' }));
        this.append(sphere);
        this.append(box);

        // AI text prompt input — visible when Boxer or SAM3 is active
        const aiInputWrap = document.createElement('div');
        aiInputWrap.id = 'ai-prompt-wrap';
        aiInputWrap.style.display = 'none';

        const aiInput = document.createElement('input');
        aiInput.id = 'ai-prompt-input';
        aiInput.type = 'text';
        aiInput.placeholder = 'Describe what to select…';
        aiInput.spellcheck = false;

        // Prevent all pointer events from reaching the canvas
        aiInputWrap.addEventListener('pointerdown', e => e.stopPropagation());
        aiInputWrap.addEventListener('pointerup', e => e.stopPropagation());
        aiInputWrap.addEventListener('click', e => e.stopPropagation());

        // Prevent keyboard shortcuts while typing
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
        this.dom.appendChild(aiInputWrap);

        // this.append(crop);
        this.append(new Element({ class: 'bottom-toolbar-separator' }));
        this.append(translate);
        this.append(rotate);
        this.append(scale);
        this.append(place);
        this.append(new Element({ class: 'bottom-toolbar-separator' }));
        this.append(measure);
        this.append(coordSpace);
        this.append(origin);
        this.append(new Element({ class: 'bottom-toolbar-separator' }));
        this.append(assetBrowserBtn);
        this.append(mic);

        // Deselect + Delete buttons — visible when something is selected
        const selectionSep = new Element({ id: 'bottom-toolbar-selection-sep', class: 'bottom-toolbar-separator' });
        selectionSep.hidden = true;

        const deselect = new Button({
            id: 'bottom-toolbar-deselect',
            class: 'bottom-toolbar-tool',
            icon: 'E132'
        });
        deselect.hidden = true;

        const deleteBtn = new Button({
            id: 'bottom-toolbar-delete',
            class: 'bottom-toolbar-tool'
        });
        deleteBtn.hidden = true;

        // Trash can SVG
        const trashSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 38 38" width="38" height="38"><path fill="currentColor" d="M14 11h10v-1a2 2 0 00-2-2h-6a2 2 0 00-2 2v1zm-2 0v-1a4 4 0 014-4h6a4 4 0 014 4v1h4a1 1 0 110 2h-1.1l-1.2 16.1A4 4 0 0123.7 33h-9.4a4 4 0 01-4-3.9L9.1 13H8a1 1 0 110-2h4zm2 2h-2.9l1.2 16.05A2 2 0 0014.3 31h9.4a2 2 0 002-1.95L26.9 13H12zm4 3a1 1 0 011 1v10a1 1 0 11-2 0V17a1 1 0 011-1zm6 0a1 1 0 011 1v10a1 1 0 11-2 0V17a1 1 0 011-1z"/></svg>`;
        const trashEl = new DOMParser().parseFromString(trashSvg, 'image/svg+xml').documentElement;
        deleteBtn.dom.appendChild(trashEl);

        this.append(selectionSep);
        this.append(deselect);
        this.append(deleteBtn);

        deselect.dom.addEventListener('click', async () => {
            await events.invoke('selection.dropToSurface');
            events.fire('select.none');
            events.fire('selection.deselect');
        });
        deleteBtn.dom.addEventListener('click', () => {
            events.fire('select.delete');
            events.fire('selection.delete');
        });

        // Show/hide based on selection state
        const updateSelectionButtons = (hasSelection: boolean) => {
            selectionSep.hidden = !hasSelection;
            deselect.hidden = !hasSelection;
            deleteBtn.hidden = !hasSelection;
        };

        events.on('selection.changed', () => {
            const sel = events.invoke('selection');
            updateSelectionButtons(!!sel);
        });

        events.on('assetBrowser.entitySelected', (entity: any) => {
            updateSelectionButtons(!!entity);
        });

        // Voice transcript overlay
        const transcriptEl = document.createElement('div');
        transcriptEl.id = 'voice-transcript';
        document.body.appendChild(transcriptEl);

        undo.dom.addEventListener('click', () => events.fire('edit.undo'));
        redo.dom.addEventListener('click', () => events.fire('edit.redo'));
        polygon.dom.addEventListener('click', () => events.fire('tool.polygonSelection'));
        lasso.dom.addEventListener('click', () => events.fire('tool.lassoSelection'));
        brush.dom.addEventListener('click', () => events.fire('tool.brushSelection'));
        flood.dom.addEventListener('click', () => events.fire('tool.floodSelection'));
        picker.dom.addEventListener('click', () => events.fire('tool.rectSelection'));
        eyedropper.dom.addEventListener('click', () => events.fire('tool.eyedropperSelection'));
        sphere.dom.addEventListener('click', () => events.fire('tool.sphereSelection'));
        box.dom.addEventListener('click', () => events.fire('tool.boxSelection'));
        assetBrowserBtn.dom.addEventListener('click', () => events.fire('assetBrowser.toggleVisible'));
        mic.dom.addEventListener('click', () => events.fire('voice.toggle'));
        walk.dom.addEventListener('click', () => events.fire('tool.walk'));
        boxer.dom.addEventListener('click', () => events.fire('tool.boxerSelection'));
        sam3.dom.addEventListener('click', () => events.fire('tool.sam3Selection'));
        place.dom.addEventListener('click', () => events.fire('tool.place'));
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
            walk.class[toolName === 'walk' ? 'add' : 'remove']('active');
            picker.class[toolName === 'rectSelection' ? 'add' : 'remove']('active');
            brush.class[toolName === 'brushSelection' ? 'add' : 'remove']('active');
            flood.class[toolName === 'floodSelection' ? 'add' : 'remove']('active');
            polygon.class[toolName === 'polygonSelection' ? 'add' : 'remove']('active');
            lasso.class[toolName === 'lassoSelection' ? 'add' : 'remove']('active');
            sphere.class[toolName === 'sphereSelection' ? 'add' : 'remove']('active');
            box.class[toolName === 'boxSelection' ? 'add' : 'remove']('active');
            boxer.class[toolName === 'boxerSelection' ? 'add' : 'remove']('active');
            sam3.class[toolName === 'sam3Selection' ? 'add' : 'remove']('active');
            place.class[toolName === 'place' ? 'add' : 'remove']('active');
            translate.class[toolName === 'move' ? 'add' : 'remove']('active');
            rotate.class[toolName === 'rotate' ? 'add' : 'remove']('active');
            scale.class[toolName === 'scale' ? 'add' : 'remove']('active');
            measure.class[toolName === 'measure' ? 'add' : 'remove']('active');
            eyedropper.class[toolName === 'eyedropperSelection' ? 'add' : 'remove']('active');

            const isAiTool = toolName === 'boxerSelection' || toolName === 'sam3Selection';
            aiInputWrap.style.display = isAiTool ? 'flex' : 'none';
            if (!isAiTool) aiInput.value = '';
        });

        events.on('tool.coordSpace', (space: 'local' | 'world') => {
            coordSpace.dom.classList[space === 'local' ? 'add' : 'remove']('active');
        });

        events.on('assetBrowser.visible', (visible: boolean) => {
            assetBrowserBtn.class[visible ? 'add' : 'remove']('active');
        });

        events.on('pivot.origin', (o: 'center' | 'boundCenter') => {
            origin.dom.classList[o === 'boundCenter' ? 'add' : 'remove']('active');
        });

        events.on('voice.active', (active: boolean) => {
            mic.dom.classList[active ? 'add' : 'remove']('voice-active');
        });

        let transcriptTimer: ReturnType<typeof setTimeout> | null = null;
        events.on('voice.transcript', (text: string) => {
            transcriptEl.textContent = text;
            transcriptEl.classList.add('visible');
            if (transcriptTimer) clearTimeout(transcriptTimer);
            transcriptTimer = setTimeout(() => {
                transcriptEl.classList.remove('visible');
            }, 3000);
        });

        // Helper to compose localized tooltip text with shortcut
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

        // register tooltips
        tooltips.register(assetBrowserBtn, 'Asset Browser');
        tooltips.register(mic, 'Voice Control (hold Space)');
        tooltips.register(walk, tooltip('Walk Mode', 'tool.walk'));
        tooltips.register(undo, tooltip('tooltip.bottom-toolbar.undo', 'edit.undo'));
        tooltips.register(redo, tooltip('tooltip.bottom-toolbar.redo', 'edit.redo'));
        tooltips.register(picker, tooltip('tooltip.bottom-toolbar.rect', 'tool.rectSelection'));
        tooltips.register(lasso, tooltip('tooltip.bottom-toolbar.lasso', 'tool.lassoSelection'));
        tooltips.register(polygon, tooltip('tooltip.bottom-toolbar.polygon', 'tool.polygonSelection'));
        tooltips.register(brush, tooltip('tooltip.bottom-toolbar.brush', 'tool.brushSelection'));
        tooltips.register(flood, tooltip('tooltip.bottom-toolbar.flood', 'tool.floodSelection'));
        tooltips.register(boxer, tooltip('Boxer AI', 'tool.boxerSelection'));
        tooltips.register(sam3, tooltip('SAM3 AI', 'tool.sam3Selection'));
        tooltips.register(sphere, tooltip('tooltip.bottom-toolbar.sphere'));
        tooltips.register(box, tooltip('tooltip.bottom-toolbar.box'));
        tooltips.register(place, tooltip('Click to Place', 'tool.place'));
        tooltips.register(translate, tooltip('tooltip.bottom-toolbar.translate', 'tool.move'));
        tooltips.register(rotate, tooltip('tooltip.bottom-toolbar.rotate', 'tool.rotate'));
        tooltips.register(scale, tooltip('tooltip.bottom-toolbar.scale', 'tool.scale'));
        tooltips.register(measure, tooltip('tooltip.bottom-toolbar.measure', 'tool.measure'));
        tooltips.register(coordSpace, tooltip('tooltip.bottom-toolbar.local-space', 'tool.toggleCoordSpace'));
        tooltips.register(origin, tooltip('tooltip.bottom-toolbar.bound-center'));
        tooltips.register(eyedropper, tooltip('tooltip.bottom-toolbar.eyedropper', 'tool.eyedropperSelection'));
        tooltips.register(deselect, 'Deselect');
        tooltips.register(deleteBtn, 'Delete');
    }
}

export { BottomToolbar };
