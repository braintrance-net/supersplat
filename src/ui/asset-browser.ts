import { Container } from '@playcanvas/pcui';
import { AppBase, Asset, BoundingBox, Color, Entity, LIGHTTYPE_DIRECTIONAL, RotateGizmo, ScaleGizmo, TransformGizmo, TranslateGizmo, Vec3 } from 'playcanvas';

import { Events } from '../events';
import { Tooltips } from './tooltips';

interface SketchfabModel {
    uid: string;
    name: string;
    thumbnails: {
        images: Array<{
            url: string;
            width: number;
            height: number;
        }>;
    };
    viewerUrl: string;
    isDownloadable: boolean;
    user: {
        displayName: string;
    };
    license: {
        label: string;
    } | null;
}

interface SearchResult {
    results: SketchfabModel[];
    cursors: {
        next: string | null;
    };
    next: string | null;
}

class AssetBrowser extends Container {
    private events: Events;
    private apiToken: string;
    private nextCursor: string | null = null;
    private currentQuery = '';
    private gridContainer: HTMLDivElement;
    private loadMoreBtn: HTMLButtonElement;
    private statusLabel: HTMLDivElement;
    private searchInput: HTMLInputElement;
    private lightEntity: Entity | null = null;
    private placedEntities: Entity[] = [];
    private selectedEntity: Entity | null = null;
    private activeGizmo: TransformGizmo | null = null;
    private gizmos: { translate: TranslateGizmo | null; rotate: RotateGizmo | null; scale: ScaleGizmo | null } = {
        translate: null,
        rotate: null,
        scale: null
    };
    private currentGizmoType: 'translate' | 'rotate' | 'scale' | null = null;
    private pendingPlacement: { entity: Entity; card: HTMLElement; actionEl: Element | null } | null = null;
    private entityActionBar: HTMLDivElement | null = null;

    constructor(events: Events, tooltips: Tooltips, args = {}) {
        args = {
            ...args,
            id: 'asset-browser',
            hidden: true
        };

        super(args);

        this.events = events;
        const devConfig = (window as any).supersplatConfig ?? {};
        this.apiToken = devConfig.sketchfabApiToken || '';

        // Stop pointer events from reaching canvas
        ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
            this.dom.addEventListener(eventName, (event: Event) => event.stopPropagation());
        });

        // Build DOM directly for the complex layout
        const panel = document.createElement('div');
        panel.className = 'asset-browser-panel';

        // Header
        const header = document.createElement('div');
        header.className = 'asset-browser-header';

        const titleRow = document.createElement('div');
        titleRow.className = 'asset-browser-title-row';

        const title = document.createElement('span');
        title.className = 'asset-browser-title';
        title.textContent = 'ASSET BROWSER';

        const closeBtn = document.createElement('button');
        closeBtn.className = 'asset-browser-close';
        closeBtn.textContent = '\u00D7';
        closeBtn.addEventListener('click', () => {
            this.hidden = true;
            events.fire('assetBrowser.visible', false);
        });

        titleRow.appendChild(title);
        titleRow.appendChild(closeBtn);
        header.appendChild(titleRow);

        // Search
        const searchRow = document.createElement('div');
        searchRow.className = 'asset-browser-search-row';

        this.searchInput = document.createElement('input');
        this.searchInput.className = 'asset-browser-search';
        this.searchInput.type = 'text';
        this.searchInput.placeholder = 'Search 3D models...';
        this.searchInput.spellcheck = false;

        // Prevent keyboard shortcuts while typing
        this.searchInput.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
                this.search(this.searchInput.value.trim());
            }
            if (e.key === 'Escape') {
                this.searchInput.blur();
            }
        });
        this.searchInput.addEventListener('keyup', e => e.stopPropagation());
        this.searchInput.addEventListener('keypress', e => e.stopPropagation());

        const searchBtn = document.createElement('button');
        searchBtn.className = 'asset-browser-search-btn';
        searchBtn.textContent = 'Search';
        searchBtn.addEventListener('click', () => {
            this.search(this.searchInput.value.trim());
        });

        searchRow.appendChild(this.searchInput);
        searchRow.appendChild(searchBtn);
        header.appendChild(searchRow);

        // Category quick filters
        const categories = document.createElement('div');
        categories.className = 'asset-browser-categories';
        const categoryList = ['Furniture', 'Architecture', 'Nature', 'Vehicles', 'Characters', 'Food'];
        categoryList.forEach(cat => {
            const chip = document.createElement('button');
            chip.className = 'asset-browser-chip';
            chip.textContent = cat;
            chip.addEventListener('click', () => {
                this.searchInput.value = cat.toLowerCase();
                this.search(cat.toLowerCase());
            });
            categories.appendChild(chip);
        });
        header.appendChild(categories);

        panel.appendChild(header);

        // Status
        this.statusLabel = document.createElement('div');
        this.statusLabel.className = 'asset-browser-status';
        this.statusLabel.textContent = 'Search for 3D models on Sketchfab';
        panel.appendChild(this.statusLabel);

        // Grid
        this.gridContainer = document.createElement('div');
        this.gridContainer.className = 'asset-browser-grid';
        panel.appendChild(this.gridContainer);

        // Load more
        this.loadMoreBtn = document.createElement('button');
        this.loadMoreBtn.className = 'asset-browser-load-more';
        this.loadMoreBtn.textContent = 'Load More';
        this.loadMoreBtn.style.display = 'none';
        this.loadMoreBtn.addEventListener('click', () => {
            if (this.nextCursor) {
                this.search(this.currentQuery, this.nextCursor);
            }
        });
        panel.appendChild(this.loadMoreBtn);

        this.dom.appendChild(panel);

        // Entity action bar — floating controls for selected placed entities
        this.entityActionBar = document.createElement('div');
        this.entityActionBar.className = 'entity-action-bar';
        this.entityActionBar.style.display = 'none';

        // Stop events from reaching canvas
        ['pointerdown', 'pointerup', 'pointermove', 'click'].forEach((evt) => {
            this.entityActionBar.addEventListener(evt, (e: Event) => e.stopPropagation());
        });

        const deselectBtn = document.createElement('button');
        deselectBtn.className = 'entity-action-btn';
        deselectBtn.title = 'Deselect (drop to surface)';
        deselectBtn.innerHTML = `<svg viewBox="0 0 20 20" width="16" height="16"><path fill="currentColor" d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z"/></svg>`;
        deselectBtn.addEventListener('click', () => this.deselectEntity());

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'entity-action-btn entity-action-delete';
        deleteBtn.title = 'Delete entity';
        deleteBtn.innerHTML = `<svg viewBox="0 0 20 20" width="16" height="16"><path fill="currentColor" d="M8.5 4h3a1.5 1.5 0 00-3 0zm-1 0a2.5 2.5 0 015 0h4.25a.75.75 0 010 1.5h-.92l-.89 10.69A2.5 2.5 0 0112.47 18H7.53a2.5 2.5 0 01-2.47-2.19L4.17 5.5h-.92a.75.75 0 010-1.5H7.5zm2.5 3.75a.75.75 0 00-1.5 0v5.5a.75.75 0 001.5 0v-5.5zm2.75-.75a.75.75 0 00-.75.75v5.5a.75.75 0 001.5 0v-5.5a.75.75 0 00-.75-.75z"/></svg>`;
        deleteBtn.addEventListener('click', () => this.deleteSelectedEntity());

        this.entityActionBar.appendChild(deselectBtn);
        this.entityActionBar.appendChild(deleteBtn);

        // Append to body so it floats above everything
        document.body.appendChild(this.entityActionBar);

        // Events
        events.on('assetBrowser.toggleVisible', () => {
            this.hidden = !this.hidden;
            events.fire('assetBrowser.visible', !this.hidden);
            if (!this.hidden && this.gridContainer.children.length === 0) {
                this.searchInput.focus();
            }
        });

        // Map toolbar tool names to our gizmo types
        events.on('tool.activated', (toolName: string) => {
            if (toolName === 'move') {
                this.switchGizmo('translate');
            } else if (toolName === 'rotate') {
                this.switchGizmo('rotate');
            } else if (toolName === 'scale') {
                this.switchGizmo('scale');
            } else {
                // Non-transform tool activated — detach gizmo but keep selection
                this.detachGizmo();
                this.currentGizmoType = null;
            }
        });

        // Let placed entities be re-selected by event
        events.on('assetBrowser.selectEntity', (entity: Entity) => {
            this.selectEntity(entity);
        });

        // Voice command: search and place first result
        events.on('assetBrowser.searchAndPlace', async (query: string) => {
            // Show the browser
            if (this.hidden) {
                this.hidden = false;
                events.fire('assetBrowser.visible', true);
            }

            // Run the search
            this.searchInput.value = query;
            await this.search(query);

            // Auto-click first result card
            const firstCard = this.gridContainer.querySelector('.asset-browser-card') as HTMLElement;
            if (firstCard) {
                firstCard.click();
            }
        });

    }

    private ensureGizmos() {
        if (this.gizmos.translate) return;

        const scene = (window as any).scene;
        if (!scene) return;

        const camera = scene.camera.camera;
        const layer = scene.gizmoLayer;

        this.gizmos.translate = new TranslateGizmo(camera, layer);
        this.gizmos.rotate = new RotateGizmo(camera, layer);
        this.gizmos.scale = new ScaleGizmo(camera, layer);

        // Wire up all gizmos to directly transform the selected entity
        for (const gizmo of [this.gizmos.translate, this.gizmos.rotate, this.gizmos.scale]) {
            gizmo.on('render:update', () => {
                scene.forceRender = true;
            });

            gizmo.on('transform:move', () => {
                scene.forceRender = true;
            });
        }
    }

    private selectEntity(entity: Entity) {
        this.selectedEntity = entity;
        this.ensureGizmos();

        // Show action bar
        if (this.entityActionBar) {
            this.entityActionBar.style.display = 'flex';
        }

        // If a transform tool is active, attach the gizmo
        if (this.currentGizmoType) {
            this.attachGizmo(this.currentGizmoType);
        } else {
            // Default to translate when selecting a placed entity
            this.currentGizmoType = 'translate';
            this.events.fire('tool.move');
        }
    }

    private async deselectEntity() {
        if (!this.selectedEntity) return;

        const entity = this.selectedEntity;
        this.detachGizmo();
        this.selectedEntity = null;
        this.currentGizmoType = null;

        // Hide action bar
        if (this.entityActionBar) {
            this.entityActionBar.style.display = 'none';
        }

        // Gravity drop — find the surface below and snap to it
        await this.dropToSurface(entity);
    }

    private deleteSelectedEntity() {
        if (!this.selectedEntity) return;

        const entity = this.selectedEntity;
        this.detachGizmo();
        this.selectedEntity = null;
        this.currentGizmoType = null;

        // Hide action bar
        if (this.entityActionBar) {
            this.entityActionBar.style.display = 'none';
        }

        // Remove from tracking
        const idx = this.placedEntities.indexOf(entity);
        if (idx !== -1) this.placedEntities.splice(idx, 1);

        // Destroy the entity
        entity.destroy();

        const scene = (window as any).scene;
        if (scene) scene.forceRender = true;
    }

    private async dropToSurface(entity: Entity) {
        const scene = (window as any).scene;
        if (!scene?.camera) return;

        const pos = entity.getPosition();
        const canvas = scene.canvas as HTMLCanvasElement;

        // Project entity position to screen space
        const camera = scene.camera.camera as any;
        const screenPos = new Vec3();
        camera.worldToScreen(pos, screenPos);

        // Normalize to 0-1 range
        const nx = screenPos.x / canvas.clientWidth;
        const ny = screenPos.y / canvas.clientHeight;

        // Only attempt if the entity is on screen
        if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;

        const result = await scene.camera.intersect(nx, ny);
        if (!result) return;

        // Compute bottom offset for this entity
        const bbox = this.computeEntityBounds(entity);
        const boundsBottom = bbox.center.y - bbox.halfExtents.y;
        const bottomOffset = pos.y - boundsBottom;

        // Only drop if the surface is below the entity
        const surfaceY = result.position.y;
        const targetY = surfaceY + bottomOffset;

        if (targetY < pos.y) {
            entity.setPosition(pos.x, targetY, pos.z);
            scene.forceRender = true;
        }
    }

    private switchGizmo(type: 'translate' | 'rotate' | 'scale') {
        this.currentGizmoType = type;
        if (this.selectedEntity) {
            this.attachGizmo(type);
        }
    }

    private attachGizmo(type: 'translate' | 'rotate' | 'scale') {
        this.ensureGizmos();
        this.detachGizmo();

        const gizmo = this.gizmos[type];
        if (!gizmo || !this.selectedEntity) return;

        gizmo.attach([this.selectedEntity]);
        this.activeGizmo = gizmo;

        const scene = (window as any).scene;
        if (scene) scene.forceRender = true;
    }

    private detachGizmo() {
        if (this.activeGizmo?.enabled) {
            this.activeGizmo.detach();
        }
        this.activeGizmo = null;
    }

    private async search(query: string, cursor?: string) {
        if (!query) return;

        this.currentQuery = query;
        if (!cursor) {
            this.gridContainer.innerHTML = '';
        }

        this.statusLabel.textContent = 'Searching...';
        this.loadMoreBtn.style.display = 'none';

        try {
            const params = new URLSearchParams({
                type: 'models',
                q: query,
                downloadable: 'true',
                count: '24',
                sort_by: '-relevance'
            });
            if (cursor) {
                params.set('cursor', cursor);
            }

            const headers: Record<string, string> = {};
            if (this.apiToken) {
                headers['Authorization'] = `Token ${this.apiToken}`;
            }

            const response = await fetch(`https://api.sketchfab.com/v3/search?${params}`, { headers });
            if (!response.ok) throw new Error(`Search failed: ${response.status}`);

            const data: SearchResult = await response.json();
            this.nextCursor = data.cursors?.next || null;

            if (data.results.length === 0 && !cursor) {
                this.statusLabel.textContent = 'No models found.';
                return;
            }

            this.statusLabel.textContent = `Results for "${query}"`;

            data.results.forEach(model => {
                this.gridContainer.appendChild(this.createModelCard(model));
            });

            this.loadMoreBtn.style.display = this.nextCursor ? 'block' : 'none';

        } catch (error: any) {
            this.statusLabel.textContent = `Error: ${error.message || error}`;
        }
    }

    private createModelCard(model: SketchfabModel): HTMLElement {
        const card = document.createElement('div');
        card.className = 'asset-browser-card';

        // Thumbnail — pick a medium-sized image
        const thumbUrl = this.getThumbnail(model);
        const img = document.createElement('img');
        img.className = 'asset-browser-thumb';
        img.src = thumbUrl;
        img.alt = model.name;
        img.loading = 'lazy';
        img.draggable = false;

        // Info
        const info = document.createElement('div');
        info.className = 'asset-browser-card-info';

        const name = document.createElement('div');
        name.className = 'asset-browser-card-name';
        name.textContent = model.name;
        name.title = model.name;

        const author = document.createElement('div');
        author.className = 'asset-browser-card-author';
        author.textContent = model.user?.displayName || '';

        const action = document.createElement('div');
        action.className = 'asset-browser-card-action';
        action.textContent = 'Click to place in scene';

        info.appendChild(name);
        info.appendChild(author);
        info.appendChild(action);

        card.appendChild(img);
        card.appendChild(info);

        // Click to download and place in scene
        card.addEventListener('click', () => {
            this.placeInScene(model, card);
        });

        return card;
    }

    private async placeInScene(model: SketchfabModel, card: HTMLElement) {
        if (!this.apiToken) {
            await this.events.invoke('showPopup', {
                type: 'error',
                header: 'API Token Required',
                message: 'Set SKETCHFAB_API_TOKEN in .env to download models.'
            });
            return;
        }

        // Show loading state on the card
        card.classList.add('loading');
        const actionEl = card.querySelector('.asset-browser-card-action');
        if (actionEl) actionEl.textContent = 'Downloading...';

        this.events.fire('startSpinner');

        try {
            // Get download URL from Sketchfab
            const downloadUrl = await this.getDownloadUrl(model.uid);
            if (!downloadUrl) {
                throw new Error('Model is not downloadable or requires purchase.');
            }

            // Fetch the GLB binary
            const response = await fetch(downloadUrl);
            if (!response.ok) throw new Error(`Download failed: ${response.status}`);
            const arrayBuffer = await response.arrayBuffer();

            // Load into PlayCanvas as a container asset (glTF/GLB)
            const app: AppBase = (window as any).scene?.app;
            if (!app) throw new Error('PlayCanvas app not available.');

            const blob = new Blob([arrayBuffer], { type: 'model/gltf-binary' });
            const blobUrl = URL.createObjectURL(blob);

            const containerAsset = new Asset(model.name, 'container', { url: blobUrl, filename: `${model.name}.glb` });

            app.assets.add(containerAsset);

            await new Promise<void>((resolve, reject) => {
                containerAsset.on('load', () => resolve());
                containerAsset.on('error', (err: string) => reject(new Error(err)));
                app.assets.load(containerAsset);
            });

            // Instantiate the model as an entity in the scene
            const resource = containerAsset.resource as any;
            let entity: Entity;
            if (resource.instantiateRenderEntity) {
                entity = resource.instantiateRenderEntity();
            } else if (resource.instantiateModelEntity) {
                entity = resource.instantiateModelEntity();
            } else {
                throw new Error('Could not instantiate model from container.');
            }

            entity.name = model.name;

            // Add to scene first so transforms are resolved
            app.root.addChild(entity);

            // Scale relative to scene bounds for natural sizing
            this.autoScaleEntity(entity);

            // Hide entity until placed — position offscreen
            entity.setPosition(1e6, 1e6, 1e6);

            // Ensure render components are on the world layer
            const scene = (window as any).scene;
            const worldLayerId = scene?.worldLayer?.id;
            if (worldLayerId !== undefined) {
                this.setLayerRecursive(entity, worldLayerId);
            }

            this.ensureSceneLighting(app, worldLayerId);

            URL.revokeObjectURL(blobUrl);

            // Enter click-to-place mode
            this.pendingPlacement = { entity, card, actionEl };
            if (actionEl) actionEl.textContent = 'Click on scene to place...';
            card.classList.remove('loading');
            card.classList.add('pending-place');

            this.startPlacementMode();

        } catch (error: any) {
            console.error('Asset placement error:', error);
            await this.events.invoke('showPopup', {
                type: 'error',
                header: 'Placement Failed',
                message: error.message || String(error)
            });
            if (actionEl) actionEl.textContent = 'Click to place in scene';
            card.classList.remove('loading');
        } finally {
            this.events.fire('stopSpinner');
        }
    }

    private autoScaleEntity(entity: Entity) {
        const bbox = this.computeEntityBounds(entity);
        const size = bbox.halfExtents;
        const maxExtent = Math.max(size.x, size.y, size.z) * 2;
        if (maxExtent <= 0) return;

        // Scale model to ~15% of scene radius for natural fit
        const scene = (window as any).scene;
        let targetSize = 2.0;
        if (scene?.bound) {
            const sceneRadius = scene.bound.halfExtents.length();
            if (sceneRadius > 0) {
                targetSize = sceneRadius * 0.15;
            }
        }

        const scaleFactor = targetSize / maxExtent;
        entity.setLocalScale(scaleFactor, scaleFactor, scaleFactor);
    }

    private startPlacementMode() {
        const scene = (window as any).scene;
        if (!scene) return;

        const canvas = scene.canvas as HTMLCanvasElement;
        canvas.style.cursor = 'crosshair';

        const onPointerDown = async (e: PointerEvent) => {
            if (!this.pendingPlacement) return;
            // Ignore right-click / middle-click
            if (e.button !== 0) return;

            e.stopPropagation();
            e.preventDefault();

            const rect = canvas.getBoundingClientRect();
            const nx = (e.clientX - rect.left) / rect.width;
            const ny = (e.clientY - rect.top) / rect.height;

            // Try depth-based intersection with the splat surface
            const result = await scene.camera.intersect(nx, ny);

            const { entity, card, actionEl } = this.pendingPlacement;

            // Compute how far the model's bottom is below its origin
            // so we can sit the base on the surface, not the center
            const bbox = this.computeEntityBounds(entity);
            const entityPos = entity.getPosition();
            const boundsBottom = bbox.center.y - bbox.halfExtents.y;
            const bottomOffset = entityPos.y - boundsBottom;

            if (result) {
                entity.setPosition(
                    result.position.x,
                    result.position.y + bottomOffset,
                    result.position.z
                );
            } else {
                if (scene.camera?.focalPoint) {
                    const fp = scene.camera.focalPoint;
                    entity.setPosition(fp.x, fp.y + bottomOffset, fp.z);
                } else {
                    entity.setPosition(0, bottomOffset, 0);
                }
            }

            // Finalize placement
            this.placedEntities.push(entity);
            scene.forceRender = true;

            // Focus camera on placed entity
            const pos = entity.getPosition();
            if (scene.camera) {
                scene.camera.focus({ focalPoint: pos, radius: 3, speed: 1 });
            }

            // Auto-select with move gizmo
            this.selectEntity(entity);

            // Clean up placement mode
            canvas.style.cursor = '';
            canvas.removeEventListener('pointerdown', onPointerDown, true);
            canvas.removeEventListener('keydown', onEscape, true);

            card.classList.remove('pending-place');
            if (actionEl) actionEl.textContent = 'Placed! Click to place another';
            this.pendingPlacement = null;
        };

        const onEscape = (e: KeyboardEvent) => {
            if (e.key !== 'Escape' || !this.pendingPlacement) return;

            // Cancel placement — remove the entity
            const { entity, card, actionEl } = this.pendingPlacement;
            entity.destroy();
            canvas.style.cursor = '';
            canvas.removeEventListener('pointerdown', onPointerDown, true);
            canvas.removeEventListener('keydown', onEscape, true);

            card.classList.remove('pending-place');
            if (actionEl) actionEl.textContent = 'Click to place in scene';
            this.pendingPlacement = null;
        };

        // Use capture phase so we get the click before orbit controls
        canvas.addEventListener('pointerdown', onPointerDown, true);
        canvas.addEventListener('keydown', onEscape, true);
    }

    private getThumbnail(model: SketchfabModel, large = false): string {
        const images = model.thumbnails?.images || [];
        if (images.length === 0) return '';

        // Sort by width and pick appropriate size
        const sorted = [...images].sort((a, b) => a.width - b.width);
        if (large) {
            return sorted[sorted.length - 1]?.url || sorted[0]?.url || '';
        }
        // Pick ~200px wide thumbnail for grid
        const target = sorted.find(i => i.width >= 200) || sorted[sorted.length - 1];
        return target?.url || '';
    }

    private computeEntityBounds(entity: Entity): BoundingBox {
        const bounds = new BoundingBox();
        let first = true;

        const walk = (e: Entity) => {
            if ((e as any).render?.meshInstances) {
                for (const mi of (e as any).render.meshInstances) {
                    if (first) {
                        bounds.copy(mi.aabb);
                        first = false;
                    } else {
                        bounds.add(mi.aabb);
                    }
                }
            }
            for (const child of e.children) {
                walk(child as Entity);
            }
        };

        walk(entity);

        if (first) {
            // No render components found — return a small box at entity position
            bounds.center.copy(entity.getPosition());
            bounds.halfExtents.set(0.5, 0.5, 0.5);
        }

        return bounds;
    }

    private ensureSceneLighting(app: AppBase, worldLayerId?: number) {
        if (this.lightEntity) return;

        // Set ambient light on the scene
        app.scene.ambientLight = new Color(0.3, 0.3, 0.3);

        // Add a key directional light
        const light = new Entity('AssetBrowser_KeyLight');
        light.addComponent('light', {
            type: 'directional',
            color: new Color(1, 1, 1),
            intensity: 1.2,
            castShadows: false
        });
        light.setEulerAngles(45, 135, 0);
        if (worldLayerId !== undefined) {
            (light as any).light.layers = [worldLayerId];
        }
        app.root.addChild(light);

        // Add a fill light from the opposite side
        const fill = new Entity('AssetBrowser_FillLight');
        fill.addComponent('light', {
            type: 'directional',
            color: new Color(0.7, 0.8, 1.0),
            intensity: 0.5,
            castShadows: false
        });
        fill.setEulerAngles(30, -45, 0);
        if (worldLayerId !== undefined) {
            (fill as any).light.layers = [worldLayerId];
        }
        app.root.addChild(fill);

        this.lightEntity = light;
        console.log('[AssetBrowser] Added scene lighting');
    }

    private setLayerRecursive(entity: Entity, layerId: number) {
        if ((entity as any).render) {
            (entity as any).render.layers = [layerId];
        }
        for (const child of entity.children) {
            this.setLayerRecursive(child as Entity, layerId);
        }
    }

    private async getDownloadUrl(uid: string): Promise<string | null> {
        const headers: Record<string, string> = {
            'Authorization': `Token ${this.apiToken}`
        };

        const response = await fetch(`https://api.sketchfab.com/v3/models/${uid}/download`, { headers });
        if (!response.ok) return null;

        const data = await response.json();
        // Prefer glb, fall back to gltf
        return data.glb?.url || data.gltf?.url || null;
    }
}

export { AssetBrowser };
