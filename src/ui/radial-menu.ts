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
    private isVisible = false;
    private oneShotTool: string | null = null;
    private events: Events;

    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'radial-menu-container'
        };

        super(args);
        this.events = events;

        // Block pointer events from reaching canvas
        this.dom.addEventListener('pointerdown', (e) => e.stopPropagation());

        this.menuEl = document.createElement('div');
        this.menuEl.id = 'radial-menu';
        this.dom.appendChild(this.menuEl);

        // Define items in order: Clear, Undo, Move, Rotate, Scale, Place, Trash
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
                    this.startOneShotTool('move');
                }
            },
            {
                id: 'radial-rotate',
                label: 'Rotate',
                icon: null,
                fontIcon: 'E113',
                action: () => {
                    this.startOneShotTool('rotate');
                }
            },
            {
                id: 'radial-scale',
                label: 'Scale',
                icon: null,
                fontIcon: 'E112',
                action: () => {
                    this.startOneShotTool('scale');
                }
            },
            {
                id: 'radial-place',
                label: 'Place',
                icon: placeSvg,
                action: () => {
                    this.startOneShotTool('place');
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

        // Only show when splat selection changes (not asset browser)
        events.on('selection.changed', () => {
            const hasSplats = events.invoke('selection.splats');
            if (hasSplats) {
                this.showNearSelection();
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
                setTimeout(() => {
                    events.fire('tool.walk');
                    const hasSplats = events.invoke('selection.splats');
                    if (hasSplats) {
                        this.showNearSelection();
                    }
                }, 100);
            }
        });

        // Start hidden
        this.hide();
    }

    private startOneShotTool(toolName: string) {
        this.oneShotTool = toolName;
        this.hide();
        this.events.fire(`tool.${toolName}`);
    }

    private showNearSelection() {
        if (this.oneShotTool) return;

        // Get screen position of the selection center
        const screenPos = this.events.invoke('selection.screenPosition') as { x: number; y: number } | null;

        if (screenPos) {
            // Position the menu near the selection, offset upward so the arc sits above
            // Clamp to keep it on screen with some padding
            const padding = 130;
            const x = Math.max(padding, Math.min(screenPos.x, window.innerWidth - padding));
            const y = Math.max(padding, Math.min(screenPos.y - 30, window.innerHeight - padding));

            this.dom.style.left = `${x}px`;
            this.dom.style.top = `${y}px`;
            this.dom.style.bottom = '';
            this.dom.style.transform = 'translate(-50%, -50%)';
        } else {
            // Fallback: center horizontally, near bottom
            this.dom.style.left = '50%';
            this.dom.style.top = '';
            this.dom.style.bottom = '100px';
            this.dom.style.transform = 'translateX(-50%)';
        }

        this.isVisible = true;
        this.dom.style.display = 'flex';
        requestAnimationFrame(() => {
            this.menuEl.classList.add('radial-menu-visible');
        });
    }

    hide() {
        this.isVisible = false;
        this.menuEl.classList.remove('radial-menu-visible');
        this.dom.style.display = 'none';
    }
}

export { RadialMenu };
