import { Vec3 } from 'playcanvas';

import { Events } from '../events';
import { Scene } from '../scene';
import { SemanticAnnotation } from '../semantic-annotations';

class SemanticAnnotationOverlay {
    private readonly container: HTMLDivElement;
    private readonly markers = new Map<string, HTMLButtonElement>();
    private readonly screenPos = new Vec3();
    private annotations: SemanticAnnotation[] = [];
    private interactionMode: 'edit' | 'game' = 'edit';

    constructor(private readonly events: Events, private readonly scene: Scene, parent: HTMLElement) {
        this.container = document.createElement('div');
        this.container.id = 'semantic-annotation-overlay';
        parent.appendChild(this.container);

        events.on('semanticAnnotations.changed', this.setAnnotations, this);
        events.on('semanticAnnotations.interactionMode', this.setInteractionMode, this);
        events.on('postrender', this.update, this);
    }

    destroy() {
        this.events.off('semanticAnnotations.changed', this.setAnnotations, this);
        this.events.off('semanticAnnotations.interactionMode', this.setInteractionMode, this);
        this.events.off('postrender', this.update, this);
        this.container.remove();
        this.markers.clear();
    }

    private setAnnotations(annotations: SemanticAnnotation[]) {
        this.annotations = annotations;
        this.syncMarkers();
        this.scene.forceRender = true;
    }

    private setInteractionMode(mode: 'edit' | 'game') {
        this.interactionMode = mode;
        this.container.classList.toggle('game-mode', mode === 'game');
    }

    private syncMarkers() {
        const ids = new Set(this.annotations.map(annotation => annotation.id));

        for (const [id, marker] of this.markers) {
            if (!ids.has(id)) {
                marker.remove();
                this.markers.delete(id);
            }
        }

        for (const annotation of this.annotations) {
            let marker = this.markers.get(annotation.id);
            if (!marker) {
                marker = document.createElement('button');
                marker.type = 'button';
                marker.className = 'semantic-annotation-marker';
                marker.addEventListener('click', (event) => {
                    event.stopPropagation();
                    if (this.interactionMode === 'game') {
                        this.events.fire('semanticAnnotations.activate', annotation.id);
                    } else {
                        this.events.fire('semanticAnnotations.remove', annotation.id);
                    }
                });
                this.container.appendChild(marker);
                this.markers.set(annotation.id, marker);
            }

            marker.style.setProperty('--semantic-marker-color', annotation.color || '#58c7ff');
            marker.innerHTML = `
                <span class="semantic-annotation-pin"></span>
                <span class="semantic-annotation-body">
                    <span class="semantic-annotation-label"></span>
                    <span class="semantic-annotation-description"></span>
                </span>
            `;
            marker.querySelector('.semantic-annotation-label')!.textContent = annotation.label;
            marker.querySelector('.semantic-annotation-description')!.textContent = annotation.description;
        }

        this.update();
    }

    private update() {
        const { clientWidth, clientHeight } = this.scene.canvas;

        for (const annotation of this.annotations) {
            const marker = this.markers.get(annotation.id);
            if (!marker) {
                continue;
            }

            const world = new Vec3(annotation.position[0], annotation.position[1], annotation.position[2]);
            this.scene.camera.worldToScreen(world, this.screenPos);

            const visible =
                this.screenPos.z >= 0 &&
                this.screenPos.z <= 1 &&
                this.screenPos.x >= -0.05 &&
                this.screenPos.x <= 1.05 &&
                this.screenPos.y >= -0.05 &&
                this.screenPos.y <= 1.05;

            marker.hidden = !visible;
            if (visible) {
                marker.style.transform = `translate(${(this.screenPos.x * clientWidth).toFixed(1)}px, ${(this.screenPos.y * clientHeight).toFixed(1)}px)`;
            }
        }
    }
}

export { SemanticAnnotationOverlay };
