import { Container, Button, Label, TextInput } from '@playcanvas/pcui';

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

        // Handle model download + import
        events.on('assetBrowser.import', async (model: SketchfabModel) => {
            if (!this.apiToken) {
                await events.invoke('showPopup', {
                    type: 'error',
                    header: 'API Token Required',
                    message: 'Set SKETCHFAB_API_TOKEN env var to download models.'
                });
                return;
            }

            events.fire('startSpinner');
            try {
                const downloadUrl = await this.getDownloadUrl(model.uid);
                if (!downloadUrl) {
                    throw new Error('Model is not downloadable or requires purchase.');
                }

                // Fetch the glTF/GLB file
                const response = await fetch(downloadUrl);
                if (!response.ok) throw new Error(`Download failed: ${response.status}`);
                const blob = await response.blob();

                // Import into scene as a PLY-like file (the engine handles glTF)
                const file = new File([blob], `${model.name}.glb`, { type: 'model/gltf-binary' });
                await events.invoke('import', [{
                    filename: `${model.name}.glb`,
                    url: downloadUrl
                }]);
            } catch (error: any) {
                await events.invoke('showPopup', {
                    type: 'error',
                    header: 'Download Failed',
                    message: error.message || String(error)
                });
            } finally {
                events.fire('stopSpinner');
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

        info.appendChild(name);
        info.appendChild(author);

        card.appendChild(img);
        card.appendChild(info);

        // Click to view on Sketchfab (open in new tab) — since direct import
        // of glTF into a splat editor has format limitations, we give the user
        // a preview link + download option
        card.addEventListener('click', () => {
            this.showModelDetail(model);
        });

        return card;
    }

    private showModelDetail(model: SketchfabModel) {
        // Show a detail overlay within the panel
        const existing = this.dom.querySelector('.asset-browser-detail');
        if (existing) existing.remove();

        const detail = document.createElement('div');
        detail.className = 'asset-browser-detail';

        const detailInner = document.createElement('div');
        detailInner.className = 'asset-browser-detail-inner';

        // Close button
        const closeBtn = document.createElement('button');
        closeBtn.className = 'asset-browser-detail-close';
        closeBtn.textContent = '\u00D7';
        closeBtn.addEventListener('click', () => detail.remove());
        detailInner.appendChild(closeBtn);

        // Preview image
        const img = document.createElement('img');
        img.className = 'asset-browser-detail-img';
        img.src = this.getThumbnail(model, true);
        img.alt = model.name;
        img.draggable = false;
        detailInner.appendChild(img);

        // Title
        const title = document.createElement('div');
        title.className = 'asset-browser-detail-title';
        title.textContent = model.name;
        detailInner.appendChild(title);

        // Author
        const author = document.createElement('div');
        author.className = 'asset-browser-detail-author';
        author.textContent = `by ${model.user?.displayName || 'Unknown'}`;
        detailInner.appendChild(author);

        // License
        if (model.license) {
            const license = document.createElement('div');
            license.className = 'asset-browser-detail-license';
            license.textContent = model.license.label;
            detailInner.appendChild(license);
        }

        // Buttons
        const btnRow = document.createElement('div');
        btnRow.className = 'asset-browser-detail-buttons';

        const viewBtn = document.createElement('button');
        viewBtn.className = 'asset-browser-detail-btn';
        viewBtn.textContent = 'View on Sketchfab';
        viewBtn.addEventListener('click', () => {
            window.open(model.viewerUrl, '_blank');
        });
        btnRow.appendChild(viewBtn);

        if (this.apiToken) {
            const downloadBtn = document.createElement('button');
            downloadBtn.className = 'asset-browser-detail-btn primary';
            downloadBtn.textContent = 'Download GLB';
            downloadBtn.addEventListener('click', async () => {
                downloadBtn.textContent = 'Downloading...';
                downloadBtn.disabled = true;
                try {
                    const downloadUrl = await this.getDownloadUrl(model.uid);
                    if (!downloadUrl) {
                        throw new Error('Not downloadable');
                    }
                    // Trigger browser download
                    const a = document.createElement('a');
                    a.href = downloadUrl;
                    a.download = `${model.name}.glb`;
                    a.target = '_blank';
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    downloadBtn.textContent = 'Downloaded!';
                } catch (err: any) {
                    downloadBtn.textContent = 'Download Failed';
                    console.error('Download error:', err);
                }
                setTimeout(() => {
                    downloadBtn.textContent = 'Download GLB';
                    downloadBtn.disabled = false;
                }, 2000);
            });
            btnRow.appendChild(downloadBtn);
        }

        detailInner.appendChild(btnRow);
        detail.appendChild(detailInner);

        // Close on backdrop click
        detail.addEventListener('click', (e) => {
            if (e.target === detail) detail.remove();
        });

        this.dom.appendChild(detail);
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
