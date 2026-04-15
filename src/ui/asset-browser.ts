import { Container } from '@playcanvas/pcui';
import { AppBase, Asset, Entity } from 'playcanvas';

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
            console.log('[AssetBrowser] Fetching GLB from:', downloadUrl.substring(0, 80) + '...');
            const response = await fetch(downloadUrl);
            if (!response.ok) throw new Error(`Download failed: ${response.status}`);
            const arrayBuffer = await response.arrayBuffer();
            console.log('[AssetBrowser] Downloaded:', (arrayBuffer.byteLength / 1024 / 1024).toFixed(2), 'MB');

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

            console.log('[AssetBrowser] Asset loaded. Resource:', containerAsset.resource);
            console.log('[AssetBrowser] Resource type:', typeof containerAsset.resource);
            console.log('[AssetBrowser] Resource keys:', containerAsset.resource ? Object.keys(containerAsset.resource) : 'null');

            // Instantiate the model as an entity in the scene
            const resource = containerAsset.resource as any;
            let entity: Entity;
            if (resource.instantiateRenderEntity) {
                entity = resource.instantiateRenderEntity();
                console.log('[AssetBrowser] Used instantiateRenderEntity');
            } else if (resource.instantiateModelEntity) {
                entity = resource.instantiateModelEntity();
                console.log('[AssetBrowser] Used instantiateModelEntity');
            } else {
                console.error('[AssetBrowser] Resource has no instantiate method. Keys:', Object.getOwnPropertyNames(resource));
                throw new Error('Could not instantiate model from container.');
            }

            entity.name = model.name;

            // Position at the camera's focal point so it appears where the user is looking
            const scene = (window as any).scene;
            if (scene?.camera?.focalPoint) {
                const fp = scene.camera.focalPoint;
                entity.setPosition(fp.x, fp.y, fp.z);
                console.log('[AssetBrowser] Placed at focal point:', fp.x.toFixed(2), fp.y.toFixed(2), fp.z.toFixed(2));
            } else {
                console.warn('[AssetBrowser] No focal point available, placed at origin');
            }

            app.root.addChild(entity);

            // Debug: log entity hierarchy and bounding info
            console.log('[AssetBrowser] Entity added to scene:', entity.name);
            console.log('[AssetBrowser] Entity position:', entity.getPosition().toString());
            console.log('[AssetBrowser] Entity scale:', entity.getLocalScale().toString());
            console.log('[AssetBrowser] Entity children:', entity.children.length);

            // Walk children to find render components and log their bounding boxes
            const logChildren = (e: Entity, depth: number) => {
                const prefix = '  '.repeat(depth);
                const components = Object.keys((e as any).c || {});
                console.log(`[AssetBrowser] ${prefix}${e.name} [components: ${components.join(', ') || 'none'}] pos: ${e.getLocalPosition().toString()} scale: ${e.getLocalScale().toString()}`);
                for (const child of e.children) {
                    logChildren(child as Entity, depth + 1);
                }
            };
            logChildren(entity, 0);

            URL.revokeObjectURL(blobUrl);

            // Activate the move tool so the user can reposition immediately
            this.events.fire('tool.move');

            if (actionEl) actionEl.textContent = 'Placed in scene!';
            setTimeout(() => {
                if (actionEl) actionEl.textContent = 'Click to place again';
            }, 2000);

        } catch (error: any) {
            console.error('Asset placement error:', error);
            await this.events.invoke('showPopup', {
                type: 'error',
                header: 'Placement Failed',
                message: error.message || String(error)
            });
            if (actionEl) actionEl.textContent = 'Click to place in scene';
        } finally {
            card.classList.remove('loading');
            this.events.fire('stopSpinner');
        }
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
