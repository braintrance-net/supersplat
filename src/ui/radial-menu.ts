import { Container } from '@playcanvas/pcui';

import { Events } from '../events';
import placeSvg from './svg/place.svg';
import trashSvg from './svg/trash.svg';
import undoSvg from './svg/undo.svg';

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
    private selectionToolCommitVisible = false;
    private events: Events;
    private selectionToolNames = new Set([
        'brushSelection',
        'boxSelection',
        'boxVolume',
        'rectSelection',
        'lassoSelection',
        'polygonSelection',
        'floodSelection',
        'eyedropperSelection'
    ]);

    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'radial-menu-container'
        };

        super(args);
        this.events = events;

        // Block pointer events from reaching canvas
        this.dom.addEventListener('pointerdown', e => e.stopPropagation());

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

        // Build DOM items arranged in a semicircle arc
        const totalItems = items.length;
        const arcStart = -90;
        const arcEnd = 90;
        const arcSpan = arcEnd - arcStart;
        const radius = 130; // px — large enough so 56px items never overlap

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

        const checkSelection = () => {
            if (this.selectionToolNames.has(events.invoke('tool.active') as string)) {
                if (this.selectionToolCommitVisible) {
                    const hasSplats = events.invoke('selection.splats');
                    if (hasSplats) {
                        if (!this.isVisible) {
                            this.showNearSelection(true);
                        }
                        return;
                    }
                }
                this.hide();
                return;
            }

            const hasSplats = events.invoke('selection.splats');
            if (hasSplats) {
                // If the menu is already visible (e.g. shown at click point), keep it where it is
                if (this.isVisible) return;
                this.showNearSelection();
            } else {
                this.hide();
            }
        };

        // selection.changed = splat entity selected/deselected
        // splat.stateChanged = gaussians selected/deselected within a splat (SAM3, brush, etc.)
        events.on('selection.changed', checkSelection);
        events.on('splat.stateChanged', checkSelection);

        events.on('selection.commit', () => {
            this.selectionToolCommitVisible = true;
            let attempts = 0;
            const showCommittedSelection = () => {
                if (events.invoke('selection.splats')) {
                    this.showNearSelection(true);
                } else if (attempts++ < 8) {
                    window.setTimeout(showCommittedSelection, 80);
                }
            };
            showCommittedSelection();
        });

        // Show menu immediately at click point when SAM3 starts processing
        events.on('sam3.clickStarted', (pt: { x: number; y: number }) => {
            if (this.oneShotTool) return;
            this.showAtPoint(pt.x, pt.y);
        });

        // Reposition after transforms (e.g. voice-driven translate).
        // splat.positionsChanged fires after the async GPU position update + bounds recompute,
        // so selectionBound reflects the new location. pivot.ended fires too early — the bound
        // is still stale at that point.
        events.on('splat.positionsChanged', () => {
            if (this.isVisible && !this.oneShotTool) {
                this.showNearSelection();
            }
        });

        events.on('tool.activated', (toolName: string | null) => {
            if (toolName && this.selectionToolNames.has(toolName)) {
                this.oneShotTool = null;
                this.selectionToolCommitVisible = false;
                this.hide();
            }
        });

        events.on('selection.gestureStarted', () => {
            this.selectionToolCommitVisible = false;
            this.hide();
        });

        events.on('brushSelection.rawMode.changed', () => {
            if (events.invoke('tool.active') === 'brushSelection') {
                this.hide();
            }
        });

        // When selection is cleared, hide
        events.on('selection.deselect', () => {
            this.selectionToolCommitVisible = false;
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

    private showAtPoint(x: number, y: number, allowSelectionTool = false) {
        if (this.oneShotTool) return;
        if (!allowSelectionTool && this.selectionToolNames.has(this.events.invoke('tool.active') as string)) return;

        const padding = 170;
        const clampedX = Math.max(padding, Math.min(x, window.innerWidth - padding));
        const clampedY = Math.max(padding, Math.min(y - 30, window.innerHeight - padding));

        this.dom.style.left = `${clampedX}px`;
        this.dom.style.top = `${clampedY}px`;
        this.dom.style.bottom = '';
        this.dom.style.transform = 'translate(-50%, -50%)';

        this.isVisible = true;
        this.dom.style.display = 'flex';
        requestAnimationFrame(() => {
            this.menuEl.classList.add('radial-menu-visible');
        });
    }

    private showNearSelection(allowSelectionTool = false) {
        if (this.oneShotTool) return;
        if (!allowSelectionTool && this.selectionToolNames.has(this.events.invoke('tool.active') as string)) {
            this.hide();
            return;
        }

        const screenPos = this.events.invoke('selection.screenPosition') as { x: number; y: number } | null;

        if (screenPos) {
            this.showAtPoint(screenPos.x, screenPos.y, allowSelectionTool);
        } else {
            // Fallback: center horizontally, near bottom
            this.dom.style.left = '50%';
            this.dom.style.top = '';
            this.dom.style.bottom = '100px';
            this.dom.style.transform = 'translateX(-50%)';
            this.isVisible = true;
            this.dom.style.display = 'flex';
            requestAnimationFrame(() => {
                this.menuEl.classList.add('radial-menu-visible');
            });
        }
    }

    hide() {
        this.isVisible = false;
        this.menuEl.classList.remove('radial-menu-visible');
        this.dom.style.display = 'none';
    }
}

export { RadialMenu };
