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

    // Tracks which model UIDs have already been placed for a given voice query,
    // so "use a different chair" cycles through the result list instead of repeating.
    private voiceQueryHistory: Map<string, { uids: Set<string>; cursor: string | null }> = new Map();
    // Maps placed entities → the voice query that produced them, so we know what
    // to re-search when the user asks to replace the current asset.
    private entityToQuery: Map<Entity, string> = new Map();

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

        // Toolbar deselect/delete buttons
        events.on('selection.deselect', () => {
            this.deselectEntity();
        });
        events.on('selection.delete', () => {
            this.deleteSelectedEntity();
        });

        // Voice command: search and place at scene center, auto-select.
        // Does NOT open the browser UI.
        events.on('assetBrowser.searchAndPlace', async (query: string) => {
            await this.voicePlaceAsset(query, false);
        });

        // Voice command: replace the currently selected placed asset with a different one.
        // If newQuery is provided, search that; otherwise re-use the query that produced
        // the current selection and pick a different result.
        events.on('assetBrowser.replaceSelected', async (newQuery?: string) => {
            await this.voicePlaceAsset(newQuery, true);
        });

        // Expose the currently selected placed entity so voice commands can
        // redirect translate/rotate/scale/delete onto a glTF asset instead of the splat.
        events.function('assetBrowser.selectedPlacedEntity', () => this.selectedEntity);

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

            // After transform ends, drop to surface (gravity)
            gizmo.on('transform:end', () => {
                if (this.selectedEntity) {
                    this.dropToSurface(this.selectedEntity);
                }
            });
        }
    }

    private selectEntity(entity: Entity) {
        this.selectedEntity = entity;
        this.ensureGizmos();

        // Clear splat selection so voice/radial-menu operations don't target a stale splat.
        // Placed assets own the selection context until explicitly deselected.
        this.events.fire('select.none');

        // Notify toolbar to show deselect/delete buttons
        this.events.fire('assetBrowser.entitySelected', entity);

        // If a transform tool is active, attach the gizmo
        if (this.currentGizmoType) {
            this.attachGizmo(this.currentGizmoType);
        } else {
            // Default to translate when selecting a placed entity
            this.currentGizmoType = 'translate';
            this.events.fire('tool.move');
        }
    }

    private deselectEntity() {
        if (!this.selectedEntity) return;

        this.detachGizmo();
        this.selectedEntity = null;
        this.currentGizmoType = null;
        this.events.fire('assetBrowser.entitySelected', null);
    }

    private deleteSelectedEntity() {
        if (!this.selectedEntity) return;

        const entity = this.selectedEntity;
        this.detachGizmo();
        this.selectedEntity = null;
        this.currentGizmoType = null;
        this.events.fire('assetBrowser.entitySelected', null);

        // Remove from tracking and destroy
        const idx = this.placedEntities.indexOf(entity);
        if (idx !== -1) this.placedEntities.splice(idx, 1);
        this.entityToQuery.delete(entity);

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

    /**
     * Search Sketchfab directly (no UI), pick a result not yet used for this query,
     * download + instantiate, place at scene center (or at the replaced entity's
     * position), and leave it selected with the move gizmo active.
     */
    private async voicePlaceAsset(queryOrUndefined: string | undefined, replaceSelected: boolean): Promise<void> {
        // Figure out the effective query:
        //   - replace + explicit new query: use new query (fresh history slot)
        //   - replace + no query: re-use the current entity's original query
        //   - fresh place: use query as given
        let query = queryOrUndefined;
        if (replaceSelected && !query && this.selectedEntity) {
            query = this.entityToQuery.get(this.selectedEntity);
        }
        if (!query) {
            console.warn('[AssetBrowser] voicePlaceAsset: no query available');
            return;
        }

        if (!this.apiToken) {
            this.events.fire('toast', 'Sketchfab API token not configured', 'error');
            return;
        }

        this.events.fire('startSpinner');

        try {
            // Remember the replace target's transform before we destroy it
            const replaceTarget = replaceSelected ? this.selectedEntity : null;
            const replacePos = replaceTarget ? replaceTarget.getPosition().clone() : null;
            const replaceRot = replaceTarget ? replaceTarget.getRotation().clone() : null;

            // Fetch next-unused result for this query
            const model = await this.fetchNextVoiceResult(query);
            if (!model) {
                this.events.fire('toast', `No more results for "${query}"`, 'warning');
                return;
            }

            // Download the GLB
            const downloadUrl = await this.getDownloadUrl(model.uid);
            if (!downloadUrl) {
                this.events.fire('toast', `"${model.name}" is not downloadable`, 'warning');
                return;
            }

            const response = await fetch(downloadUrl);
            if (!response.ok) throw new Error(`Download failed: ${response.status}`);
            const arrayBuffer = await response.arrayBuffer();

            const app: AppBase = (window as any).scene?.app;
            if (!app) throw new Error('PlayCanvas app not available');

            const blob = new Blob([arrayBuffer], { type: 'model/gltf-binary' });
            const blobUrl = URL.createObjectURL(blob);

            const containerAsset = new Asset(model.name, 'container', { url: blobUrl, filename: `${model.name}.glb` });
            app.assets.add(containerAsset);

            await new Promise<void>((resolve, reject) => {
                containerAsset.on('load', () => resolve());
                containerAsset.on('error', (err: string) => reject(new Error(err)));
                app.assets.load(containerAsset);
            });

            const resource = containerAsset.resource as any;
            let entity: Entity;
            if (resource.instantiateRenderEntity) {
                entity = resource.instantiateRenderEntity();
            } else if (resource.instantiateModelEntity) {
                entity = resource.instantiateModelEntity();
            } else {
                throw new Error('Could not instantiate model from container');
            }

            entity.name = model.name;
            app.root.addChild(entity);
            this.autoScaleEntity(entity);

            const scene = (window as any).scene;
            const worldLayerId = scene?.worldLayer?.id;
            if (worldLayerId !== undefined) {
                this.setLayerRecursive(entity, worldLayerId);
            }
            this.ensureSceneLighting(app, worldLayerId);
            URL.revokeObjectURL(blobUrl);

            // Compute bottom offset so the model sits on whatever surface
            const bbox = this.computeEntityBounds(entity);
            const entityPos = entity.getPosition();
            const boundsBottom = bbox.center.y - bbox.halfExtents.y;
            const bottomOffset = entityPos.y - boundsBottom;

            // Target position:
            //   replace → same spot as the old entity (keep rotation too)
            //   fresh   → camera focal point if available, else scene bound center, else origin
            let targetPos: Vec3;
            if (replacePos) {
                targetPos = replacePos;
            } else if (scene?.camera?.focalPoint) {
                const fp = scene.camera.focalPoint;
                targetPos = new Vec3(fp.x, fp.y + bottomOffset, fp.z);
            } else if (scene?.bound) {
                targetPos = new Vec3(
                    scene.bound.center.x,
                    scene.bound.center.y - scene.bound.halfExtents.y + bottomOffset,
                    scene.bound.center.z
                );
            } else {
                targetPos = new Vec3(0, bottomOffset, 0);
            }

            entity.setPosition(targetPos.x, targetPos.y, targetPos.z);
            if (replaceRot) {
                entity.setRotation(replaceRot);
            }

            // If replacing, destroy old entity and remove its tracking
            if (replaceTarget) {
                const idx = this.placedEntities.indexOf(replaceTarget);
                if (idx !== -1) this.placedEntities.splice(idx, 1);
                this.entityToQuery.delete(replaceTarget);
                this.detachGizmo();
                replaceTarget.destroy();
            }

            // Register placement
            this.placedEntities.push(entity);
            this.entityToQuery.set(entity, query);
            scene.forceRender = true;

            // Auto-select with move gizmo (same path as click-placement)
            this.selectEntity(entity);

            console.log(`[AssetBrowser] Voice placed "${model.name}" (${model.uid}) for query "${query}"`);

        } catch (err: any) {
            console.error('[AssetBrowser] Voice placement failed:', err);
            this.events.fire('toast', `Placement failed: ${err.message || err}`, 'error');
        } finally {
            this.events.fire('stopSpinner');
        }
    }

    /**
     * Returns the next Sketchfab model for the given query that hasn't already been
     * placed via voice this session. Paginates through cursors as needed.
     */
    private async fetchNextVoiceResult(query: string): Promise<SketchfabModel | null> {
        const history = this.voiceQueryHistory.get(query) ?? { uids: new Set<string>(), cursor: null };

        // Try the current page first; if all used, advance to next cursor
        for (let attempt = 0; attempt < 4; attempt++) {
            const params = new URLSearchParams({
                type: 'models',
                q: query,
                downloadable: 'true',
                count: '24',
                sort_by: '-relevance'
            });
            if (history.cursor) params.set('cursor', history.cursor);

            const headers: Record<string, string> = { 'Authorization': `Token ${this.apiToken}` };
            const res = await fetch(`https://api.sketchfab.com/v3/search?${params}`, { headers });
            if (!res.ok) throw new Error(`Sketchfab search failed: ${res.status}`);

            const data: SearchResult = await res.json();
            const fresh = data.results.find(m => !history.uids.has(m.uid));
            if (fresh) {
                history.uids.add(fresh.uid);
                this.voiceQueryHistory.set(query, history);
                return fresh;
            }

            // All results on this page used — advance cursor or give up
            if (!data.cursors?.next) {
                this.voiceQueryHistory.set(query, history);
                return null;
            }
            history.cursor = data.cursors.next;
        }

        return null;
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
