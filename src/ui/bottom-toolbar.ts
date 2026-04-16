import { Button, Element, Container } from '@playcanvas/pcui';

import { Events } from '../events';
import { ShortcutManager } from '../shortcut-manager';
import { localize } from './localization';
import assetBrowserSvg from './svg/asset-browser.svg';
import micSvg from './svg/microphone.svg';
import touchSvg from './svg/touch.svg';
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

        // Voice button
        const mic = new Button({
            id: 'bottom-toolbar-mic',
            class: 'bottom-toolbar-tool'
        });

        // Touch (SAM3) button
        const touch = new Button({
            id: 'bottom-toolbar-touch',
            class: 'bottom-toolbar-tool'
        });

        // Asset browser button
        const assetBrowserBtn = new Button({
            id: 'bottom-toolbar-asset-browser',
            class: 'bottom-toolbar-tool'
        });

        mic.dom.appendChild(createSvg(micSvg));
        touch.dom.appendChild(createSvg(touchSvg));
        assetBrowserBtn.dom.appendChild(createSvg(assetBrowserSvg));

        // Layout: Voice | Touch | Typing input | separator | Asset Browser
        this.append(mic);
        this.append(touch);

        // AI text prompt input (Typing — powered by SAM)
        const aiInputWrap = document.createElement('div');
        aiInputWrap.id = 'ai-prompt-wrap';

        const aiInput = document.createElement('input');
        aiInput.id = 'ai-prompt-input';
        aiInput.type = 'text';
        aiInput.placeholder = 'Type to select…';
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

        this.append(new Element({ class: 'bottom-toolbar-separator' }));
        this.append(assetBrowserBtn);

        // Click handlers
        mic.dom.addEventListener('click', () => events.fire('voice.toggle'));
        touch.dom.addEventListener('click', () => events.fire('tool.sam3Selection'));
        assetBrowserBtn.dom.addEventListener('click', () => events.fire('assetBrowser.toggleVisible'));

        // Voice transcript overlay
        const transcriptEl = document.createElement('div');
        transcriptEl.id = 'voice-transcript';
        document.body.appendChild(transcriptEl);

        // Active states
        events.on('tool.activated', (toolName: string) => {
            touch.class[toolName === 'sam3Selection' ? 'add' : 'remove']('active');
        });

        events.on('assetBrowser.visible', (visible: boolean) => {
            assetBrowserBtn.class[visible ? 'add' : 'remove']('active');
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

        // Tooltips
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

        tooltips.register(mic, 'Voice Control (hold Space)');
        tooltips.register(touch, tooltip('Touch Select', 'tool.sam3Selection'));
        tooltips.register(assetBrowserBtn, 'Asset Browser');
    }
}

export { BottomToolbar };
