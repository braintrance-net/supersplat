import { Container } from '@playcanvas/pcui';

import { Events } from '../events';
import undoSvg from './svg/undo.svg';
import placeSvg from './svg/place.svg';
import trashSvg from './svg/trash.svg';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement;
};

interface RadialItem {
    id: string;
    label: string;
    icon: string | null;  // SVG string or null for font icon
    fontIcon?: string;     // PCUI font icon code
    action: () => void;
    className?: string;
}

class RadialMenu extends Container {
    private menuEl: HTMLElement;
    private visible = false;
    private oneShotTool: string | null = null;

    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'radial-menu-container'
        };

        super(args);

        // Block pointer events from reaching canvas
        this.dom.addEventListener('pointerdown', (e) => e.stopPropagation());

        this.menuEl = document.createElement('div');
        this.menuEl.id = 'radial-menu';
        this.dom.appendChild(this.menuEl);

        // Define items in order: Clear, Undo, Transform, Rotate, Scale, Place, Trash
        const items: RadialItem[] = [
            {
                id: 'radial-clear',
                label: 'Clear',
                icon: null,
                fontIcon: 'E132',
                action: async () => {
                    await events.invoke('selection.dropToSurface');
                    events.fire('select.none');
                    events.fire('selection.deselect');
                }
            },
            {
                id: 'radial-undo',
                label: 'Undo',
                icon: undoSvg,
                action: () => {
                    events.fire('edit.undo');
                }
            },
            {
                id: 'radial-transform',
                label: 'Move',
                icon: null,
                fontIcon: 'E111',
                action: () => {
                    this.startOneShotTool('move', events);
                }
            },
            {
                id: 'radial-rotate',
                label: 'Rotate',
                icon: null,
                fontIcon: 'E113',
                action: () => {
                    this.startOneShotTool('rotate', events);
                }
            },
            {
                id: 'radial-scale',
                label: 'Scale',
                icon: null,
                fontIcon: 'E112',
                action: () => {
                    this.startOneShotTool('scale', events);
                }
            },
            {
                id: 'radial-place',
                label: 'Place',
                icon: placeSvg,
                action: () => {
                    this.startOneShotTool('place', events);
                }
            },
            {
                id: 'radial-trash',
                label: 'Delete',
                icon: trashSvg,
                className: 'radial-item-trash',
                action: () => {
                    events.fire('select.delete');
                    events.fire('selection.delete');
                }
            }
        ];

        // Build DOM items arranged in an arc
        const totalItems = items.length;
        // Arc from -90deg (left) to +90deg (right), centered at top
        const arcStart = -90;
        const arcEnd = 90;
        const arcSpan = arcEnd - arcStart;
        const radius = 100; // px from center

        items.forEach((item, i) => {
            const el = document.createElement('button');
            el.id = item.id;
            el.className = `radial-item ${item.className || ''}`;

            // Icon
            const iconWrap = document.createElement('span');
            iconWrap.className = 'radial-item-icon';
            if (item.icon) {
                iconWrap.appendChild(createSvg(item.icon));
            } else if (item.fontIcon) {
                const fontEl = document.createElement('span');
                fontEl.className = 'font-icon';
                fontEl.textContent = String.fromCodePoint(parseInt(item.fontIcon, 16));
                iconWrap.appendChild(fontEl);
            }
            el.appendChild(iconWrap);

            // Label
            const labelEl = document.createElement('span');
            labelEl.className = 'radial-item-label';
            labelEl.textContent = item.label;
            el.appendChild(labelEl);

            // Position in arc
            const angle = arcStart + (arcSpan * i) / (totalItems - 1);
            const rad = (angle * Math.PI) / 180;
            const x = Math.sin(rad) * radius;
            const y = -Math.cos(rad) * radius;
            el.style.setProperty('--radial-x', `${x}px`);
            el.style.setProperty('--radial-y', `${y}px`);

            el.addEventListener('click', (e) => {
                e.stopPropagation();
                item.action();
            });

            this.menuEl.appendChild(el);
        });

        // Listen for selection changes to show/hide
        events.on('selection.changed', () => {
            const sel = events.invoke('selection');
            if (sel) {
                this.show();
            } else {
                this.hide();
            }
        });

        events.on('assetBrowser.entitySelected', (entity: any) => {
            if (entity) {
                this.show();
            } else {
                this.hide();
            }
        });

        // When selection is cleared, hide
        events.on('selection.deselect', () => {
            this.hide();
        });

        // One-shot tool: after an edit is completed, reopen menu
        events.on('edit.add', () => {
            if (this.oneShotTool) {
                this.oneShotTool = null;
                // Small delay to let the edit finish visually
                setTimeout(() => {
                    events.fire('tool.walk');
                    const sel = events.invoke('selection');
                    if (sel) {
                        this.show();
                    }
                }, 100);
            }
        });

        // Start hidden
        this.hide();
    }

    private startOneShotTool(toolName: string, events: Events) {
        this.oneShotTool = toolName;
        this.hide();
        events.fire(`tool.${toolName}`);
    }

    show() {
        if (this.oneShotTool) return; // Don't show while one-shot tool is active
        this.visible = true;
        this.dom.style.display = 'flex';
        // Trigger entrance animation
        requestAnimationFrame(() => {
            this.menuEl.classList.add('radial-menu-visible');
        });
    }

    hide() {
        this.visible = false;
        this.menuEl.classList.remove('radial-menu-visible');
        this.dom.style.display = 'none';
    }
}

export { RadialMenu };
