import { Asset, Color, Entity, Mat4, Ray, Vec3 } from 'playcanvas';

import { ElementType } from '../element';
import { Events } from '../events';
import { Scene } from '../scene';
import { SemanticAnnotation } from '../semantic-annotations';
import { Splat } from '../splat';
import { State } from '../splat-state';

type MaskHitVolume = {
    center: Vec3;
    min: Vec3;
    max: Vec3;
    radius: number;
    sampleCount: number;
    flipY: boolean;
    source: 'raycast-samples' | 'splat-centers';
};

type Candidate = {
    wx: number;
    wy: number;
    wz: number;
    cz: number;
    u: number;
    v: number;
};

type MaskPixels = {
    width: number;
    height: number;
    data: Uint8Array;
    points: Array<{ x: number, y: number }>;
};

type MultiplayerOverlayPlayer = {
    id: string;
    label: string;
    color?: string;
    position: [number, number, number];
    target?: [number, number, number];
    speaking?: boolean;
};

type MultiplayerHeightCalibration = {
    height: number;
    groundY?: number;
};

type MultiplayerAvatarAnimation = 'idle' | 'run';

type MultiplayerAvatarInstance = {
    entity: Entity;
    rig: MultiplayerAvatarRig | null;
    usesProceduralRig: boolean;
    state: MultiplayerAvatarAnimation;
    smoothedPlanarSpeed: number;
    phase: number;
    lastPosition: Vec3;
    lastUpdateMs: number;
};

type MultiplayerAvatarRigBone = {
    entity: Entity;
    baseEuler: Vec3;
};

type MultiplayerAvatarRig = {
    leftArm?: MultiplayerAvatarRigBone;
    rightArm?: MultiplayerAvatarRigBone;
    leftLeg?: MultiplayerAvatarRigBone;
    rightLeg?: MultiplayerAvatarRigBone;
    spine?: MultiplayerAvatarRigBone;
    head?: MultiplayerAvatarRigBone;
};

type MultiplayerAvatarContainer = {
    instantiateRenderEntity?: (options?: object) => Entity;
    instantiateModelEntity?: (options?: object) => Entity;
    animations?: Array<{ name: string; resource?: unknown }>;
};

type MultiplayerAnimLayer = {
    play: (name?: string) => void;
    transition: (to: string, time?: number, transitionOffset?: number) => void;
};

type MultiplayerAnimComponent = {
    loadStateGraph: (stateGraph: object) => void;
    assignAnimation: (nodePath: string, animTrack: unknown, layerName?: string, speed?: number, loop?: boolean) => void;
    baseLayer: MultiplayerAnimLayer | null;
    rootBone: Entity;
    playable: boolean;
    playing: boolean;
    rebind: () => void;
};

type MultiplayerAvatarAnimationSetup = {
    animationNames: string[];
    rootBoneName?: string;
    nativeAnimation: boolean;
    animPlayable?: boolean;
    fallbackReason?: string;
};

type MarkerRenderState = {
    hidden: boolean;
    transform: string;
    hitboxSize: string;
    maskVolumeTarget: boolean;
    inactiveGameTarget: boolean;
    foundGameTarget: boolean;
};

const OCCLUSION_CELL_PX = 4;
const OCCLUSION_FRAC_OF_DEPTH = 0.015;
const OCCLUSION_MIN_M = 0.015;
const OCCLUSION_MAX_M = 0.12;
const HIT_VOLUME_COLOR = new Color(0.66, 1, 0.47, 0.95);
const HIT_VOLUME_FOUND_COLOR = new Color(0.3, 1, 0.46, 1);
const MULTIPLAYER_DEFAULT_HEIGHT = 1.65;
const MULTIPLAYER_MIN_HEIGHT = 0.95;
const MULTIPLAYER_MAX_HEIGHT = 2.35;
const MULTIPLAYER_RAYCAST_MAX_SAMPLES = 260_000;
const MULTIPLAYER_GROUND_RADII = [0.04, 0.08, 0.14, 0.22, 0.35, 0.52];
// Prefer a VRM avatar from the meeting library (loaded as a glTF container);
// fall back to the bundled Kenney avatar if the remote model fails to load.
const MULTIPLAYER_VRM_URL = 'https://arweave.net/gfVzs1oH_aPaHVxpQK86HT_rqzyrFPOUKUrDJ30yprs';
const MULTIPLAYER_AVATAR_URL = '/static/dev-assets/kenney/kenney-avatar-animated.glb';
const MULTIPLAYER_AVATAR_URLS = [MULTIPLAYER_VRM_URL, MULTIPLAYER_AVATAR_URL];
const MULTIPLAYER_AVATAR_SOURCE_HEIGHT = 3.765;
const MULTIPLAYER_AVATAR_RUN_START_SPEED = 0.12;
const MULTIPLAYER_AVATAR_RUN_STOP_SPEED = 0.05;
const MULTIPLAYER_AVATAR_SPEED_SMOOTHING_SECONDS = 0.08;
const MULTIPLAYER_AVATAR_TRANSITION_SECONDS = 0.12;
const MULTIPLAYER_AVATAR_FORWARD_YAW_DEGREES = 0;

const loadImage = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Image failed to load'));
    image.src = src;
});

const selectedMaskPixels = async (src: string, maxSamples = 256): Promise<MaskPixels> => {
    const image = await loadImage(src);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (width <= 0 || height <= 0) {
        return { width: 0, height: 0, data: new Uint8Array(), points: [] };
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) {
        return { width, height, data: new Uint8Array(width * height), points: [] };
    }

    context.drawImage(image, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    const selected = new Uint8Array(width * height);
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    const isSelected = (x: number, y: number) => {
        const index = (y * width + x) * 4;
        const alpha = pixels[index + 3] ?? 0;
        const strength = Math.max(pixels[index] ?? 0, pixels[index + 1] ?? 0, pixels[index + 2] ?? 0);
        return alpha > 16 && strength > 24;
    };

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            if (!isSelected(x, y)) {
                continue;
            }
            selected[y * width + x] = 1;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
        }
    }

    if (maxX < minX || maxY < minY) {
        return { width, height, data: selected, points: [] };
    }

    const points: Array<{ x: number, y: number }> = [];

    const addPoint = (point: { x: number, y: number } | null) => {
        if (!point) {
            return;
        }
        if (!points.some(existing => existing.x === point.x && existing.y === point.y)) {
            points.push(point);
        }
    };

    const findSelected = (outerStart: number, outerEnd: number, outerStep: number, scanXFirst: boolean) => {
        for (let outer = outerStart; outerStep > 0 ? outer <= outerEnd : outer >= outerEnd; outer += outerStep) {
            const innerStart = scanXFirst ? minY : minX;
            const innerEnd = scanXFirst ? maxY : maxX;
            for (let inner = innerStart; inner <= innerEnd; inner += 1) {
                const x = scanXFirst ? outer : inner;
                const y = scanXFirst ? inner : outer;
                if (isSelected(x, y)) {
                    return { x, y };
                }
            }
        }
        return null;
    };

    addPoint(findSelected(minX, maxX, 1, true));
    addPoint(findSelected(maxX, minX, -1, true));
    addPoint(findSelected(minY, maxY, 1, false));
    addPoint(findSelected(maxY, minY, -1, false));

    const boxWidth = maxX - minX + 1;
    const boxHeight = maxY - minY + 1;
    const grid = Math.max(3, Math.ceil(Math.sqrt(maxSamples)));
    for (let gy = 0; gy < grid; gy += 1) {
        const cellMinY = Math.floor(minY + boxHeight * gy / grid);
        const cellMaxY = Math.min(maxY, Math.floor(minY + boxHeight * (gy + 1) / grid) - 1);
        for (let gx = 0; gx < grid; gx += 1) {
            const cellMinX = Math.floor(minX + boxWidth * gx / grid);
            const cellMaxX = Math.min(maxX, Math.floor(minX + boxWidth * (gx + 1) / grid) - 1);
            const cellCenterX = Math.round((cellMinX + cellMaxX) / 2);
            const cellCenterY = Math.round((cellMinY + cellMaxY) / 2);
            let best: { x: number, y: number } | null = null;
            let bestDistance = Infinity;

            for (let y = cellMinY; y <= cellMaxY; y += 1) {
                for (let x = cellMinX; x <= cellMaxX; x += 1) {
                    if (!isSelected(x, y)) {
                        continue;
                    }

                    const dx = x - cellCenterX;
                    const dy = y - cellCenterY;
                    const distance = dx * dx + dy * dy;
                    if (distance < bestDistance) {
                        best = { x, y };
                        bestDistance = distance;
                    }
                }
            }

            addPoint(best);
            if (points.length >= maxSamples) {
                break;
            }
        }
        if (points.length >= maxSamples) {
            break;
        }
    }

    const centerX = Math.round((minX + maxX) / 2);
    const centerY = Math.round((minY + maxY) / 2);
    if (isSelected(centerX, centerY)) {
        addPoint({ x: centerX, y: centerY });
    }

    return { width, height, data: selected, points: points.slice(0, maxSamples) };
};

const extractIntrinsics = (camera: { fov: number; horizontalFov?: boolean }, width: number, height: number) => {
    const fovRad = (camera.fov * Math.PI) / 180;
    const f = camera.horizontalFov ?
        width / (2 * Math.tan(fovRad / 2)) :
        height / (2 * Math.tan(fovRad / 2));
    return { fx: f, fy: f, cx: width / 2, cy: height / 2 };
};

const filterFrontSurfaceCandidates = (candidates: Candidate[], imageWidth: number, imageHeight: number) => {
    const depthWidth = Math.ceil(imageWidth / OCCLUSION_CELL_PX);
    const depthHeight = Math.ceil(imageHeight / OCCLUSION_CELL_PX);
    const nearest = new Float32Array(depthWidth * depthHeight);
    nearest.fill(Infinity);

    for (const candidate of candidates) {
        const x = Math.min(depthWidth - 1, Math.max(0, Math.floor(candidate.u / OCCLUSION_CELL_PX)));
        const y = Math.min(depthHeight - 1, Math.max(0, Math.floor(candidate.v / OCCLUSION_CELL_PX)));
        const index = y * depthWidth + x;
        if (candidate.cz < nearest[index]) {
            nearest[index] = candidate.cz;
        }
    }

    return candidates.filter((candidate) => {
        const x = Math.min(depthWidth - 1, Math.max(0, Math.floor(candidate.u / OCCLUSION_CELL_PX)));
        const y = Math.min(depthHeight - 1, Math.max(0, Math.floor(candidate.v / OCCLUSION_CELL_PX)));
        let nearestDepth = Infinity;

        for (let dy = -1; dy <= 1; dy += 1) {
            const yy = y + dy;
            if (yy < 0 || yy >= depthHeight) {
                continue;
            }

            for (let dx = -1; dx <= 1; dx += 1) {
                const xx = x + dx;
                if (xx < 0 || xx >= depthWidth) {
                    continue;
                }
                nearestDepth = Math.min(nearestDepth, nearest[yy * depthWidth + xx]);
            }
        }

        const tolerance = Math.min(
            OCCLUSION_MAX_M,
            Math.max(OCCLUSION_MIN_M, nearestDepth * OCCLUSION_FRAC_OF_DEPTH)
        );
        return candidate.cz <= nearestDepth + tolerance;
    });
};

class SemanticAnnotationOverlay {
    private readonly container: HTMLDivElement;
    private readonly markers = new Map<string, HTMLButtonElement>();
    private readonly screenPos = new Vec3();
    private readonly markerDistanceDelta = new Vec3();
    private readonly multiplayerWorld = new Vec3();
    private readonly multiplayerFeetWorld = new Vec3();
    private readonly multiplayerFeetScreenPos = new Vec3();
    private readonly multiplayerDelta = new Vec3();
    private readonly multiplayerTargetWorld = new Vec3();
    private readonly multiplayerTargetScreenPos = new Vec3();
    private readonly captureViewMatrix = new Mat4();
    private readonly hitVolumes = new Map<string, MaskHitVolume>();
    private readonly hitVolumeSourceSignatures = new Map<string, string>();
    private readonly markerRenderStates = new Map<string, MarkerRenderState>();
    private readonly multiplayerMarkers = new Map<string, HTMLDivElement>();
    private readonly multiplayerHeightCalibrations = new Map<string, MultiplayerHeightCalibration>();
    private readonly multiplayerAvatarInstances = new Map<string, MultiplayerAvatarInstance>();
    private annotations: SemanticAnnotation[] = [];
    private multiplayerPlayers: MultiplayerOverlayPlayer[] = [];
    private multiplayerAvatarAsset: Asset | null = null;
    private multiplayerAvatarLoading = false;
    private multiplayerAvatarFailed = false;
    private multiplayerAvatarLoadStartedAt: number | null = null;
    private interactionMode: 'edit' | 'game' = 'edit';
    private activeGameTargetIds = new Set<string>();
    private foundAnnotationIds = new Set<string>();
    private showHitboxes = false;
    private pointerDownPos: { x: number, y: number } | null = null;
    private hitVolumeGeneration = 0;
    private lastClickCandidates: Array<Record<string, unknown>> = [];
    private sceneGeometryRevision = 0;
    private hitVolumeRebuildTimer: number | null = null;

    constructor(private readonly events: Events, private readonly scene: Scene, parent: HTMLElement) {
        this.container = document.createElement('div');
        this.container.id = 'semantic-annotation-overlay';
        parent.appendChild(this.container);

        events.on('semanticAnnotations.changed', this.setAnnotations, this);
        events.on('semanticAnnotations.interactionMode', this.setInteractionMode, this);
        events.on('semanticAnnotations.gameTargets', this.setGameTargets, this);
        events.on('semanticAnnotations.foundTargets', this.setFoundTargets, this);
        events.on('semanticAnnotations.showHitboxes', this.setShowHitboxes, this);
        events.on('multiplayer.players', this.setMultiplayerPlayers, this);
        events.on('multiplayer.avatarPreload', this.preloadMultiplayerAvatarAsset, this);
        events.on('scene.elementAdded', this.onSceneGeometryChanged, this);
        events.on('scene.elementRemoved', this.onSceneGeometryChanged, this);
        events.on('splat.positionsChanged', this.onSceneGeometryChanged, this);
        events.on('splat.moved', this.onSceneGeometryChanged, this);
        events.on('splat.visibility', this.onSceneGeometryChanged, this);
        events.on('update', this.onSceneUpdate, this);
        events.on('prerender', this.drawHitVolumes, this);
        events.on('postrender', this.update, this);
        events.function('semanticAnnotations.captureAnchor', this.captureAnchor.bind(this));
        events.function('semanticAnnotations.clickCenter', this.clickCenter.bind(this));
        parent.addEventListener('pointerdown', this.onPointerDown);
        parent.addEventListener('pointerup', this.onPointerUp);
    }

    destroy() {
        this.events.off('semanticAnnotations.changed', this.setAnnotations, this);
        this.events.off('semanticAnnotations.interactionMode', this.setInteractionMode, this);
        this.events.off('semanticAnnotations.gameTargets', this.setGameTargets, this);
        this.events.off('semanticAnnotations.foundTargets', this.setFoundTargets, this);
        this.events.off('semanticAnnotations.showHitboxes', this.setShowHitboxes, this);
        this.events.off('multiplayer.players', this.setMultiplayerPlayers, this);
        this.events.off('multiplayer.avatarPreload', this.preloadMultiplayerAvatarAsset, this);
        this.events.off('scene.elementAdded', this.onSceneGeometryChanged, this);
        this.events.off('scene.elementRemoved', this.onSceneGeometryChanged, this);
        this.events.off('splat.positionsChanged', this.onSceneGeometryChanged, this);
        this.events.off('splat.moved', this.onSceneGeometryChanged, this);
        this.events.off('splat.visibility', this.onSceneGeometryChanged, this);
        this.events.off('update', this.onSceneUpdate, this);
        this.events.off('prerender', this.drawHitVolumes, this);
        this.events.off('postrender', this.update, this);
        if (this.hitVolumeRebuildTimer !== null) {
            window.clearTimeout(this.hitVolumeRebuildTimer);
            this.hitVolumeRebuildTimer = null;
        }
        this.container.parentElement?.removeEventListener('pointerdown', this.onPointerDown);
        this.container.parentElement?.removeEventListener('pointerup', this.onPointerUp);
        this.container.remove();
        this.markers.clear();
        this.markerRenderStates.clear();
        this.multiplayerMarkers.clear();
        for (const avatar of this.multiplayerAvatarInstances.values()) {
            avatar.entity.destroy();
        }
        this.multiplayerAvatarInstances.clear();
    }

    private setAnnotations(annotations: SemanticAnnotation[]) {
        this.annotations = annotations;
        this.syncMarkers();
        this.rebuildHitVolumes(annotations).catch((_error: unknown): undefined => undefined);
        this.scene.forceRender = true;
    }

    private onSceneGeometryChanged() {
        this.sceneGeometryRevision += 1;
        this.hitVolumeGeneration += 1;
        this.hitVolumes.clear();
        this.hitVolumeSourceSignatures.clear();
        if (this.hitVolumeRebuildTimer !== null) {
            window.clearTimeout(this.hitVolumeRebuildTimer);
        }
        this.hitVolumeRebuildTimer = window.setTimeout(() => {
            this.hitVolumeRebuildTimer = null;
            if (this.annotations.length === 0) {
                return;
            }
            this.rebuildHitVolumes(this.annotations).catch((_error: unknown): undefined => undefined);
        }, 0);
        this.syncMarkerClasses();
        this.scene.forceRender = true;
    }

    private setInteractionMode(mode: 'edit' | 'game') {
        if (this.interactionMode === mode) {
            return;
        }
        this.interactionMode = mode;
        this.container.classList.toggle('game-mode', mode === 'game');
        if (mode !== 'game') {
            this.setShowHitboxes(false);
        } else {
            this.preloadMultiplayerAvatarAsset({ reason: 'game-mode' });
        }
        this.syncMarkerClasses();
    }

    private updateMultiplayerMarkerAvatarState(marker: HTMLDivElement, avatar: MultiplayerAvatarInstance | null = null) {
        const expects3dAvatar = !this.multiplayerAvatarFailed;
        marker.classList.toggle('has-3d-avatar', Boolean(avatar));
        marker.classList.toggle('awaiting-3d-avatar', expects3dAvatar && !avatar);
    }

    private setMultiplayerPlayers(players?: MultiplayerOverlayPlayer[]) {
        this.multiplayerPlayers = Array.isArray(players) ? players : [];
        const ids = new Set(this.multiplayerPlayers.map(player => player.id));

        for (const [id, marker] of this.multiplayerMarkers) {
            if (!ids.has(id)) {
                marker.remove();
                this.multiplayerMarkers.delete(id);
                this.multiplayerHeightCalibrations.delete(id);
                this.destroyMultiplayerAvatar(id);
            }
        }

        if (this.multiplayerPlayers.length > 0) {
            this.preloadMultiplayerAvatarAsset({ reason: 'players', count: this.multiplayerPlayers.length });
        }

        for (const player of this.multiplayerPlayers) {
            let marker = this.multiplayerMarkers.get(player.id);
            if (!marker) {
                marker = document.createElement('div');
                marker.className = 'multiplayer-avatar-marker';
                marker.innerHTML = `
                    <span class="multiplayer-avatar-shadow"></span>
                    <span class="multiplayer-avatar-aim"></span>
                    <span class="multiplayer-avatar-body">
                        <span class="multiplayer-avatar-head"></span>
                        <span class="multiplayer-avatar-chest"></span>
                        <span class="multiplayer-avatar-arms"></span>
                        <span class="multiplayer-avatar-legs"></span>
                    </span>
                    <span class="multiplayer-avatar-label"></span>
                `;
                this.container.appendChild(marker);
                this.multiplayerMarkers.set(player.id, marker);
            }

            marker.style.setProperty('--multiplayer-avatar-color', player.color || '#53d6ff');
            marker.querySelector('.multiplayer-avatar-label')!.textContent = player.label;
            // Talking cue: glow the avatar body while the participant is speaking.
            const body = marker.querySelector('.multiplayer-avatar-body') as HTMLElement | null;
            if (body) body.style.filter = player.speaking ? 'drop-shadow(0 0 9px #91d9ce) drop-shadow(0 0 4px #91d9ce)' : '';
            this.updateMultiplayerMarkerAvatarState(marker);
        }

        this.update();
        this.scene.forceRender = true;
    }

    private setGameTargets(annotationIds?: string[]) {
        const nextTargetIds = new Set(Array.isArray(annotationIds) ? annotationIds : []);
        if (this.sameStringSet(this.activeGameTargetIds, nextTargetIds)) {
            return;
        }
        this.activeGameTargetIds = nextTargetIds;
        if (this.interactionMode !== 'game' || this.showHitboxes) {
            this.syncMarkerClasses();
        }
        this.emitDiagnostic('semantic-hitboxes', this.hitboxDiagnosticDetails());
    }

    private setFoundTargets(annotationIds?: string[]) {
        const nextFoundIds = new Set(Array.isArray(annotationIds) ? annotationIds : []);
        if (this.sameStringSet(this.foundAnnotationIds, nextFoundIds)) {
            return;
        }
        this.foundAnnotationIds = nextFoundIds;
        if (this.interactionMode !== 'game' || this.showHitboxes) {
            this.syncMarkerClasses();
        }
    }

    private setShowHitboxes(showHitboxes?: boolean) {
        const nextShowHitboxes = showHitboxes === true;
        if (this.showHitboxes === nextShowHitboxes) {
            return;
        }
        this.showHitboxes = nextShowHitboxes;
        this.container.classList.toggle('show-hitboxes', this.showHitboxes);
        this.syncMarkerClasses();
        this.emitDiagnostic('semantic-hitboxes', this.hitboxDiagnosticDetails());
    }

    private sameStringSet(left: Set<string>, right: Set<string>) {
        if (left.size !== right.size) {
            return false;
        }
        for (const value of left) {
            if (!right.has(value)) {
                return false;
            }
        }
        return true;
    }

    private syncMarkerClasses() {
        let changed = false;
        for (const annotation of this.annotations) {
            const marker = this.markers.get(annotation.id);
            if (!marker) {
                continue;
            }

            const hasUsableVolume = !this.requiresMaskVolume(annotation) || this.hitVolumes.has(annotation.id);
            changed = this.setMarkerClass(marker, 'inactive-game-target', this.interactionMode === 'game' && !this.isActiveGameTarget(annotation)) || changed;
            changed = this.setMarkerClass(marker, 'found-game-target', this.foundAnnotationIds.has(annotation.id)) || changed;
            changed = this.setMarkerClass(marker, 'missing-hit-volume', this.interactionMode === 'game' && this.requiresMaskVolume(annotation) && !hasUsableVolume) || changed;
            changed = this.setMarkerClass(
                marker,
                'visible-test-target',
                this.interactionMode === 'game' && this.showHitboxes && this.isActiveGameTarget(annotation)
            ) || changed;
        }
        if (changed) {
            this.scene.forceRender = true;
        }
    }

    private hitboxDiagnosticDetails() {
        const allTargetsMode = this.activeGameTargetIds.size === 0;
        const activeAnnotations = this.annotations.filter(annotation => this.isActiveGameTarget(annotation));
        const activeIds = activeAnnotations.map(annotation => annotation.id);
        const missingVolumeIds = activeAnnotations
        .filter(annotation => this.requiresMaskVolume(annotation) && !this.hitVolumes.has(annotation.id))
        .map(annotation => annotation.id);

        return {
            mode: this.interactionMode,
            showHitboxes: this.showHitboxes,
            allTargetsMode,
            annotations: this.annotations.length,
            activeTargets: activeIds.length,
            hitVolumes: this.hitVolumes.size,
            missingVolumeIds
        };
    }

    private emitDiagnostic(label: string, details?: Record<string, unknown>) {
        if (!window.parent || window.parent === window) {
            return;
        }

        window.parent.postMessage({
            type: 'supersplat:diagnostic',
            source: 'supersplat',
            label,
            details,
            at: new Date().toISOString()
        }, '*');
    }

    private onSceneUpdate(deltaTime = 1 / 60) {
        if (this.multiplayerAvatarInstances.size === 0) {
            return;
        }

        const rigDeltaTime = Math.min(Math.max(deltaTime, 1 / 120), 1 / 15);
        for (const avatar of this.multiplayerAvatarInstances.values()) {
            if (avatar.entity.enabled && avatar.usesProceduralRig) {
                this.animateMultiplayerAvatarRig(avatar, rigDeltaTime);
            }
        }
        this.scene.forceRender = true;
    }

    private preloadMultiplayerAvatarAsset(details: { reason?: string; count?: number } = {}) {
        this.loadMultiplayerAvatarAsset(details.reason ?? 'preload', details);
    }

    private loadMultiplayerAvatarAsset(reason = 'update', details: Record<string, unknown> = {}) {
        if (this.multiplayerAvatarAsset || this.multiplayerAvatarLoading || this.multiplayerAvatarFailed) {
            return;
        }

        this.multiplayerAvatarLoading = true;
        this.multiplayerAvatarLoadStartedAt = performance.now();
        this.tryLoadMultiplayerAvatarUrl(0, reason, details);
    }

    // Try the candidate avatar URLs in order (VRM first, Kenney fallback) so a
    // remote VRM failing to load never leaves participants without an avatar.
    private tryLoadMultiplayerAvatarUrl(index: number, reason: string, details: Record<string, unknown>) {
        const url = MULTIPLAYER_AVATAR_URLS[index];
        if (!url) {
            this.multiplayerAvatarLoading = false;
            this.multiplayerAvatarFailed = true;
            this.emitDiagnostic('multiplayer-avatar-load-failed', { reason, ...details });
            for (const marker of this.multiplayerMarkers.values()) {
                this.updateMultiplayerMarkerAvatarState(marker);
            }
            this.update();
            this.scene.forceRender = true;
            return;
        }

        this.emitDiagnostic('multiplayer-avatar-preload-start', { url, reason, ...details });
        this.scene.app.assets.loadFromUrl(url, 'container', (error: unknown, asset?: Asset) => {
            const loadMs = this.multiplayerAvatarLoadStartedAt === null ? null : performance.now() - this.multiplayerAvatarLoadStartedAt;
            if (error || !asset) {
                this.emitDiagnostic('multiplayer-avatar-url-failed', {
                    url,
                    error: error instanceof Error ? error.message : String(error ?? 'unknown')
                });
                this.tryLoadMultiplayerAvatarUrl(index + 1, reason, details);
                return;
            }

            this.multiplayerAvatarLoading = false;
            this.multiplayerAvatarAsset = asset;
            const resource = asset.resource as MultiplayerAvatarContainer | undefined;
            this.emitDiagnostic('multiplayer-avatar-preload-ready', {
                url,
                loadMs: loadMs === null ? null : Number(loadMs.toFixed(1)),
                animations: resource?.animations?.map(animation => animation.name) ?? [],
                waitingPlayers: this.multiplayerPlayers.length
            });
            for (const marker of this.multiplayerMarkers.values()) {
                this.updateMultiplayerMarkerAvatarState(marker);
            }
            this.update();
            this.scene.forceRender = true;
        });
    }

    private destroyMultiplayerAvatar(id: string) {
        const avatar = this.multiplayerAvatarInstances.get(id);
        if (!avatar) {
            return;
        }
        avatar.entity.destroy();
        this.multiplayerAvatarInstances.delete(id);
    }

    private setMultiplayerAvatarLayers(entity: Entity) {
        const worldLayerId = this.scene.worldLayer?.id;
        if (worldLayerId === undefined) {
            return;
        }

        const renders = entity.findComponents('render') as Array<{ layers?: number[]; meshInstances?: Array<{ castShadow?: boolean; receiveShadow?: boolean }> }>;
        for (const render of renders) {
            render.layers = [worldLayerId];
            for (const meshInstance of render.meshInstances ?? []) {
                meshInstance.castShadow = false;
                meshInstance.receiveShadow = false;
            }
        }
    }

    private setupMultiplayerAvatarAnimation(entity: Entity, resource: MultiplayerAvatarContainer): MultiplayerAvatarAnimationSetup {
        const animations = resource.animations ?? [];
        const animationNames = animations.map(animation => animation.name);
        const idle = animations.find(animation => /idle/i.test(animation.name))?.resource ?? animations[0]?.resource;
        const run = animations.find(animation => /run/i.test(animation.name))?.resource ?? animations[1]?.resource;
        if (!idle || !run) {
            return {
                animationNames,
                nativeAnimation: false,
                fallbackReason: 'missing-idle-or-run-clip'
            };
        }

        const animationRoot = (entity.findByName('Root') ?? entity.findByName('RootNode') ?? entity) as Entity;
        entity.addComponent('anim', { activate: true, rootBone: animationRoot });
        const anim = (entity as Entity & { anim?: MultiplayerAnimComponent }).anim;
        if (!anim) {
            return {
                animationNames,
                rootBoneName: animationRoot.name,
                nativeAnimation: false,
                fallbackReason: 'anim-component-missing'
            };
        }
        anim.rootBone = animationRoot;

        anim.loadStateGraph({
            layers: [
                {
                    name: 'Base',
                    states: [
                        { name: 'START' },
                        { name: 'Idle', defaultState: true, speed: 1, loop: true },
                        { name: 'Run', speed: 1, loop: true }
                    ],
                    transitions: [
                        { from: 'START', to: 'Idle' }
                    ]
                }
            ],
            parameters: {}
        });
        anim.assignAnimation('Idle', idle, undefined, 1, true);
        anim.assignAnimation('Run', run, undefined, 1, true);
        anim.rebind();
        if (!anim.playable) {
            anim.playing = false;
            this.emitDiagnostic('multiplayer-avatar-animation-unplayable', {
                rootBone: animationRoot.name,
                animations: animationNames
            });
            return {
                animationNames,
                rootBoneName: animationRoot.name,
                nativeAnimation: false,
                animPlayable: false,
                fallbackReason: 'anim-component-unplayable'
            };
        }

        anim.playing = true;
        anim.baseLayer?.play('Idle');
        return {
            animationNames,
            rootBoneName: animationRoot.name,
            nativeAnimation: true,
            animPlayable: true
        };
    }

    private multiplayerRigBone(entity: Entity, name: string): MultiplayerAvatarRigBone | undefined {
        const bone = entity.findByName(name) as Entity | null;
        if (!bone) {
            return undefined;
        }
        const euler = bone.getLocalEulerAngles();
        return {
            entity: bone,
            baseEuler: new Vec3(euler.x, euler.y, euler.z)
        };
    }

    private createMultiplayerAvatarRig(entity: Entity): MultiplayerAvatarRig {
        return {
            leftArm: this.multiplayerRigBone(entity, 'LeftArm'),
            rightArm: this.multiplayerRigBone(entity, 'RightArm'),
            leftLeg: this.multiplayerRigBone(entity, 'LeftUpLeg'),
            rightLeg: this.multiplayerRigBone(entity, 'RightUpLeg'),
            spine: this.multiplayerRigBone(entity, 'Spine'),
            head: this.multiplayerRigBone(entity, 'Head')
        };
    }

    private multiplayerRigDiagnostics(rig: MultiplayerAvatarRig | null) {
        if (!rig) {
            return {};
        }

        return {
            leftArm: rig.leftArm?.entity.name ?? null,
            rightArm: rig.rightArm?.entity.name ?? null,
            leftLeg: rig.leftLeg?.entity.name ?? null,
            rightLeg: rig.rightLeg?.entity.name ?? null,
            spine: rig.spine?.entity.name ?? null,
            head: rig.head?.entity.name ?? null
        };
    }

    private setMultiplayerRigBone(bone: MultiplayerAvatarRigBone | undefined, x = 0, y = 0, z = 0) {
        if (!bone) {
            return;
        }
        bone.entity.setLocalEulerAngles(
            bone.baseEuler.x + x,
            bone.baseEuler.y + y,
            bone.baseEuler.z + z
        );
    }

    private animateMultiplayerAvatarRig(instance: MultiplayerAvatarInstance, dt: number) {
        const rig = instance.rig;
        if (!rig) {
            return;
        }

        const running = instance.state === 'run';
        instance.phase += dt * (running ? 9.5 : 2.4);
        const stride = Math.sin(instance.phase);
        const counterStride = Math.sin(instance.phase + Math.PI);
        const lift = Math.sin(instance.phase * 2);

        if (running) {
            this.setMultiplayerRigBone(rig.leftArm, stride * 28, 0, 5);
            this.setMultiplayerRigBone(rig.rightArm, counterStride * 28, 0, -5);
            this.setMultiplayerRigBone(rig.leftLeg, counterStride * 30, 0, 2);
            this.setMultiplayerRigBone(rig.rightLeg, stride * 30, 0, -2);
            this.setMultiplayerRigBone(rig.spine, lift * 2, 0, stride * 5);
            this.setMultiplayerRigBone(rig.head, lift * 1.2, stride * 4, 0);
        } else {
            this.setMultiplayerRigBone(rig.leftArm, 3 + stride * 3, 0, 2);
            this.setMultiplayerRigBone(rig.rightArm, 3 + counterStride * 3, 0, -2);
            this.setMultiplayerRigBone(rig.leftLeg);
            this.setMultiplayerRigBone(rig.rightLeg);
            this.setMultiplayerRigBone(rig.spine, lift * 0.7, 0, stride * 1.5);
            this.setMultiplayerRigBone(rig.head, lift * 0.5, stride * 1.8, 0);
        }
    }

    private ensureMultiplayerAvatar(player: MultiplayerOverlayPlayer) {
        const existing = this.multiplayerAvatarInstances.get(player.id);
        if (existing) {
            return existing;
        }

        this.loadMultiplayerAvatarAsset();
        const resource = this.multiplayerAvatarAsset?.resource as MultiplayerAvatarContainer | undefined;
        if (!resource) {
            return null;
        }

        const entity = resource.instantiateRenderEntity?.({ castShadows: false, receiveShadows: false }) ??
            resource.instantiateModelEntity?.({ castShadows: false, receiveShadows: false });
        if (!entity) {
            this.multiplayerAvatarFailed = true;
            return null;
        }

        entity.name = `multiplayer-avatar-${player.id}`;
        entity.enabled = false;
        this.setMultiplayerAvatarLayers(entity);
        const animationSetup = this.setupMultiplayerAvatarAnimation(entity, resource);
        this.scene.contentRoot.addChild(entity);

        const rig = this.createMultiplayerAvatarRig(entity);
        const instance = {
            entity,
            rig,
            usesProceduralRig: !animationSetup.nativeAnimation,
            state: 'idle',
            smoothedPlanarSpeed: 0,
            phase: Math.random() * Math.PI * 2,
            lastPosition: new Vec3(player.position[0], player.position[1], player.position[2]),
            lastUpdateMs: performance.now()
        } satisfies MultiplayerAvatarInstance;
        this.multiplayerAvatarInstances.set(player.id, instance);
        this.emitDiagnostic('multiplayer-avatar-rig-ready', {
            playerId: player.id,
            nativeAnimation: animationSetup.nativeAnimation,
            animPlayable: animationSetup.animPlayable ?? null,
            fallbackReason: animationSetup.fallbackReason ?? null,
            rootBone: animationSetup.rootBoneName ?? null,
            animations: animationSetup.animationNames,
            rigBones: this.multiplayerRigDiagnostics(rig),
            renderComponents: entity.findComponents('render').length
        });
        return instance;
    }

    private transitionMultiplayerAvatar(instance: MultiplayerAvatarInstance, state: MultiplayerAvatarAnimation) {
        if (instance.state === state) {
            return;
        }

        instance.state = state;
        if (!instance.usesProceduralRig) {
            const anim = (instance.entity as Entity & { anim?: MultiplayerAnimComponent }).anim;
            anim?.baseLayer?.transition(state === 'run' ? 'Run' : 'Idle', MULTIPLAYER_AVATAR_TRANSITION_SECONDS);
        }
    }

    private updateMultiplayerAvatar(
        player: MultiplayerOverlayPlayer,
        instance: MultiplayerAvatarInstance,
        avatarWorldHeight: number,
        nowMs: number
    ) {
        const feetX = player.position[0];
        const feetY = player.position[1] - avatarWorldHeight;
        const feetZ = player.position[2];
        const dx = feetX - instance.lastPosition.x;
        const dz = feetZ - instance.lastPosition.z;
        const dt = Math.max(1 / 60, (nowMs - instance.lastUpdateMs) / 1000);
        const planarSpeed = Math.sqrt(dx * dx + dz * dz) / dt;
        const speedBlend = 1 - Math.exp(-dt / MULTIPLAYER_AVATAR_SPEED_SMOOTHING_SECONDS);
        instance.smoothedPlanarSpeed += (planarSpeed - instance.smoothedPlanarSpeed) * speedBlend;
        const nextState = instance.state === 'run' ?
            (instance.smoothedPlanarSpeed < MULTIPLAYER_AVATAR_RUN_STOP_SPEED ? 'idle' : 'run') :
            (instance.smoothedPlanarSpeed > MULTIPLAYER_AVATAR_RUN_START_SPEED ? 'run' : 'idle');
        this.transitionMultiplayerAvatar(instance, nextState);

        let forwardX = dx;
        let forwardZ = dz;
        if (player.target) {
            forwardX = player.target[0] - player.position[0];
            forwardZ = player.target[2] - player.position[2];
        }
        if (forwardX * forwardX + forwardZ * forwardZ > 1e-6) {
            const yaw = Math.atan2(forwardX, forwardZ) * 180 / Math.PI + MULTIPLAYER_AVATAR_FORWARD_YAW_DEGREES;
            instance.entity.setEulerAngles(0, yaw, 0);
        }

        const scale = avatarWorldHeight / MULTIPLAYER_AVATAR_SOURCE_HEIGHT;
        instance.entity.enabled = true;
        instance.entity.setLocalScale(scale, scale, scale);
        instance.entity.setPosition(feetX, feetY, feetZ);
        instance.lastPosition.set(feetX, feetY, feetZ);
        instance.lastUpdateMs = nowMs;
    }

    private syncMarkers() {
        const ids = new Set(this.annotations.map(annotation => annotation.id));

        for (const [id, marker] of this.markers) {
            if (!ids.has(id)) {
                marker.remove();
                this.markers.delete(id);
                this.markerRenderStates.delete(id);
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
                <span class="semantic-annotation-hitbox"></span>
                <span class="semantic-annotation-pin"></span>
                <span class="semantic-annotation-body">
                    <span class="semantic-annotation-label"></span>
                    <span class="semantic-annotation-description"></span>
                </span>
            `;
            marker.querySelector('.semantic-annotation-label')!.textContent = annotation.label;
            marker.querySelector('.semantic-annotation-description')!.textContent = annotation.description;
        }

        this.syncMarkerClasses();
        this.update();
    }

    private isActiveGameTarget(annotation: SemanticAnnotation) {
        return !this.foundAnnotationIds.has(annotation.id) && (this.activeGameTargetIds.size === 0 || this.activeGameTargetIds.has(annotation.id));
    }

    private shouldShowVolume(annotation: SemanticAnnotation) {
        return this.interactionMode !== 'game' ||
            (this.showHitboxes && this.isActiveGameTarget(annotation));
    }

    private shouldUpdateAnnotationMarker(annotation: SemanticAnnotation) {
        return this.interactionMode !== 'game' || (this.showHitboxes && this.isActiveGameTarget(annotation));
    }

    private setMarkerClass(marker: HTMLElement, className: string, enabled: boolean) {
        if (marker.classList.contains(className) === enabled) {
            return false;
        }
        marker.classList.toggle(className, enabled);
        return true;
    }

    private setMarkerHidden(id: string, marker: HTMLElement, hidden: boolean) {
        const previous = this.markerRenderStates.get(id);
        if (previous?.hidden === hidden) {
            return;
        }
        marker.hidden = hidden;
        this.markerRenderStates.set(id, {
            hidden,
            transform: previous?.transform ?? '',
            hitboxSize: previous?.hitboxSize ?? '',
            maskVolumeTarget: previous?.maskVolumeTarget ?? false,
            inactiveGameTarget: previous?.inactiveGameTarget ?? false,
            foundGameTarget: previous?.foundGameTarget ?? false
        });
    }

    private updateMarkerRenderState(id: string, marker: HTMLElement, state: Omit<MarkerRenderState, 'hidden'>) {
        const previous = this.markerRenderStates.get(id);
        if (previous?.transform !== state.transform) {
            marker.style.transform = state.transform;
        }
        if (previous?.hitboxSize !== state.hitboxSize) {
            marker.style.setProperty('--semantic-hitbox-size', state.hitboxSize);
        }
        if (previous?.maskVolumeTarget !== state.maskVolumeTarget) {
            marker.classList.toggle('mask-volume-target', state.maskVolumeTarget);
        }
        if (previous?.inactiveGameTarget !== state.inactiveGameTarget) {
            marker.classList.toggle('inactive-game-target', state.inactiveGameTarget);
        }
        if (previous?.foundGameTarget !== state.foundGameTarget) {
            marker.classList.toggle('found-game-target', state.foundGameTarget);
        }
        marker.style.removeProperty('--semantic-hitbox-width');
        marker.style.removeProperty('--semantic-hitbox-height');
        this.markerRenderStates.set(id, {
            hidden: false,
            ...state
        });
    }

    private requiresMaskVolume(annotation: SemanticAnnotation) {
        return Boolean(annotation.targetImage?.fullMaskSrc || annotation.targetImage?.maskSrc);
    }

    private annotationRadius(annotation: SemanticAnnotation) {
        return Math.max(0.08, Math.min(2.5, annotation.radius ?? 0.35));
    }

    private annotationCenter(annotation: SemanticAnnotation) {
        const volume = this.hitVolumes.get(annotation.id);
        return volume?.center ?? new Vec3(annotation.position[0], annotation.position[1], annotation.position[2]);
    }

    private annotationHitRadius(annotation: SemanticAnnotation) {
        return this.hitVolumes.get(annotation.id)?.radius ?? this.annotationRadius(annotation);
    }

    private pointVolumeDistance(point: Vec3, volume: MaskHitVolume) {
        const dx = Math.max(volume.min.x - point.x, 0, point.x - volume.max.x);
        const dy = Math.max(volume.min.y - point.y, 0, point.y - volume.max.y);
        const dz = Math.max(volume.min.z - point.z, 0, point.z - volume.max.z);
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    private pointInsideVolume(point: Vec3, volume: MaskHitVolume) {
        return this.pointVolumeDistance(point, volume) <= Math.max(0.04, volume.radius * 0.12);
    }

    private rayVolumeDistance(ray: Ray, volume: MaskHitVolume) {
        const margin = Math.max(0.05, Math.min(0.35, volume.radius * 0.18));
        const minX = volume.min.x - margin;
        const minY = volume.min.y - margin;
        const minZ = volume.min.z - margin;
        const maxX = volume.max.x + margin;
        const maxY = volume.max.y + margin;
        const maxZ = volume.max.z + margin;
        let tMin = 0;
        let tMax = Infinity;

        const testAxis = (origin: number, direction: number, min: number, max: number) => {
            if (Math.abs(direction) < 1e-6) {
                return origin >= min && origin <= max;
            }

            let near = (min - origin) / direction;
            let far = (max - origin) / direction;
            if (near > far) {
                const temp = near;
                near = far;
                far = temp;
            }
            tMin = Math.max(tMin, near);
            tMax = Math.min(tMax, far);
            return tMin <= tMax;
        };

        if (!testAxis(ray.origin.x, ray.direction.x, minX, maxX)) {
            return null;
        }
        if (!testAxis(ray.origin.y, ray.direction.y, minY, maxY)) {
            return null;
        }
        if (!testAxis(ray.origin.z, ray.direction.z, minZ, maxZ)) {
            return null;
        }

        return tMax >= 0 ? Math.max(0, tMin) : null;
    }

    private rayCanReachActiveHitVolume(ray: Ray) {
        let checkedVolumes = 0;
        for (const annotation of this.annotations) {
            if (!this.isActiveGameTarget(annotation)) {
                continue;
            }

            const volume = this.hitVolumes.get(annotation.id);
            if (!volume) {
                return true;
            }

            checkedVolumes += 1;
            if (this.rayVolumeDistance(ray, volume) !== null) {
                return true;
            }
        }

        return checkedVolumes === 0;
    }

    private volumeFromWorldPoints(
        annotation: SemanticAnnotation,
        points: Array<{ x: number; y: number; z: number }>,
        flipY: boolean,
        source: MaskHitVolume['source']
    ) {
        if (points.length < 3) {
            return null;
        }

        const min = new Vec3(points[0].x, points[0].y, points[0].z);
        const max = min.clone();
        const center = new Vec3();
        for (const point of points) {
            min.x = Math.min(min.x, point.x);
            min.y = Math.min(min.y, point.y);
            min.z = Math.min(min.z, point.z);
            max.x = Math.max(max.x, point.x);
            max.y = Math.max(max.y, point.y);
            max.z = Math.max(max.z, point.z);
            center.x += point.x;
            center.y += point.y;
            center.z += point.z;
        }
        center.mulScalar(1 / points.length);

        let radius = 0;
        for (const point of points) {
            const dx = point.x - center.x;
            const dy = point.y - center.y;
            const dz = point.z - center.z;
            radius = Math.max(radius, Math.sqrt(dx * dx + dy * dy + dz * dz));
        }

        return {
            center,
            min,
            max,
            radius: Math.max(radius, this.annotationRadius(annotation)),
            sampleCount: points.length,
            flipY,
            source
        } satisfies MaskHitVolume;
    }

    private buildSplatCenterHitVolume(annotation: SemanticAnnotation, mask: MaskPixels, flipY: boolean, view: Float32Array) {
        const splats = (this.scene.getElementsByType(ElementType.splat) as Splat[]).filter(splat => splat.visible);
        if (splats.length === 0) {
            return null;
        }

        const { fx, fy, cx, cy } = extractIntrinsics({
            fov: annotation.source.camera.fov,
            horizontalFov: mask.width > mask.height
        }, mask.width, mask.height);
        const candidates: Candidate[] = [];
        for (const splat of splats) {
            const sorter: { centers?: Float32Array } | undefined = splat.entity.gsplat?.instance?.sorter;
            const centers = sorter?.centers;
            if (!centers) {
                continue;
            }

            const worldTransform = splat.entity.getWorldTransform().data as Float32Array;
            const count = centers.length / 3;
            for (let i = 0; i < count; i += 1) {
                const localX = centers[i * 3];
                const localY = centers[i * 3 + 1];
                const localZ = centers[i * 3 + 2];
                const worldX = worldTransform[0] * localX + worldTransform[4] * localY + worldTransform[8] * localZ + worldTransform[12];
                const worldY = worldTransform[1] * localX + worldTransform[5] * localY + worldTransform[9] * localZ + worldTransform[13];
                const worldZ = worldTransform[2] * localX + worldTransform[6] * localY + worldTransform[10] * localZ + worldTransform[14];
                const cameraZ = -(view[2] * worldX + view[6] * worldY + view[10] * worldZ + view[14]);
                if (cameraZ <= 0) {
                    continue;
                }

                const cameraX = view[0] * worldX + view[4] * worldY + view[8] * worldZ + view[12];
                const cameraY = view[1] * worldX + view[5] * worldY + view[9] * worldZ + view[13];
                const u = Math.round(fx * cameraX / cameraZ + cx);
                const v = Math.round(fy * (-cameraY) / cameraZ + cy);
                if (u < 0 || u >= mask.width || v < 0 || v >= mask.height) {
                    continue;
                }

                const maskY = flipY ? mask.height - 1 - v : v;
                if (mask.data[maskY * mask.width + u] === 0) {
                    continue;
                }

                candidates.push({ wx: worldX, wy: worldY, wz: worldZ, cz: cameraZ, u, v });
            }
        }

        const visibleSurface = filterFrontSurfaceCandidates(candidates, mask.width, mask.height);
        return this.volumeFromWorldPoints(
            annotation,
            visibleSurface.map(candidate => ({ x: candidate.wx, y: candidate.wy, z: candidate.wz })),
            flipY,
            'splat-centers'
        );
    }

    private calibrateMultiplayerHeight(player: MultiplayerOverlayPlayer) {
        const existing = this.multiplayerHeightCalibrations.get(player.id);
        if (existing) {
            return existing;
        }

        const startedAt = performance.now();
        const head = {
            x: player.position[0],
            y: player.position[1],
            z: player.position[2]
        };
        let measuredHeight: number | null = null;
        let measuredGroundY: number | undefined;

        const splats = (this.scene.getElementsByType(ElementType.splat) as Splat[]).filter(splat => splat.visible);
        const totalCenters = splats.reduce((total, splat) => {
            const centers: Float32Array | undefined = splat.entity.gsplat?.instance?.sorter?.centers;
            return total + (centers ? centers.length / 3 : 0);
        }, 0);
        const stride = Math.max(1, Math.ceil(totalCenters / MULTIPLAYER_RAYCAST_MAX_SAMPLES));
        const radiusSquares = MULTIPLAYER_GROUND_RADII.map(radius => radius * radius);
        const bestYByRadius = MULTIPLAYER_GROUND_RADII.map(() => -Infinity);
        const maxRadiusSq = radiusSquares[radiusSquares.length - 1] ?? 0;
        let visited = 0;
        let sampled = 0;

        for (const splat of splats) {
            const sorter: { centers?: Float32Array } | undefined = splat.entity.gsplat?.instance?.sorter;
            const centers = sorter?.centers;
            if (!centers) {
                continue;
            }

            const state = splat.splatData.getProp('state') as Uint8Array | undefined;
            const worldTransform = splat.entity.getWorldTransform().data as Float32Array;
            const count = centers.length / 3;
            for (let i = 0; i < count; i += 1) {
                visited += 1;
                if (visited % stride !== 0) {
                    continue;
                }
                sampled += 1;
                if (state && ((state[i] ?? 0) & State.deleted) !== 0) {
                    continue;
                }

                const localX = centers[i * 3];
                const localY = centers[i * 3 + 1];
                const localZ = centers[i * 3 + 2];
                const worldX = worldTransform[0] * localX + worldTransform[4] * localY + worldTransform[8] * localZ + worldTransform[12];
                const worldY = worldTransform[1] * localX + worldTransform[5] * localY + worldTransform[9] * localZ + worldTransform[13];
                const worldZ = worldTransform[2] * localX + worldTransform[6] * localY + worldTransform[10] * localZ + worldTransform[14];

                if (worldY >= head.y - 0.05) {
                    continue;
                }

                const dx = worldX - head.x;
                const dz = worldZ - head.z;
                const distanceSq = dx * dx + dz * dz;
                if (distanceSq > maxRadiusSq) {
                    continue;
                }

                for (let radiusIndex = 0; radiusIndex < radiusSquares.length; radiusIndex += 1) {
                    const radiusSq = radiusSquares[radiusIndex] ?? 0;
                    if (distanceSq <= radiusSq) {
                        bestYByRadius[radiusIndex] = Math.max(bestYByRadius[radiusIndex] ?? -Infinity, worldY);
                    }
                }
            }
        }

        for (let radiusIndex = 0; radiusIndex < bestYByRadius.length; radiusIndex += 1) {
            const groundY = bestYByRadius[radiusIndex] ?? -Infinity;
            if (Number.isFinite(groundY)) {
                const height = head.y - groundY;
                if (height >= MULTIPLAYER_MIN_HEIGHT && height <= MULTIPLAYER_MAX_HEIGHT) {
                    measuredHeight = height;
                    measuredGroundY = groundY;
                    break;
                }
            }
        }

        if (measuredHeight === null && player.target) {
            const headToTargetY = player.position[1] - player.target[1];
            if (Number.isFinite(headToTargetY) && headToTargetY >= MULTIPLAYER_MIN_HEIGHT && headToTargetY <= MULTIPLAYER_MAX_HEIGHT) {
                measuredHeight = headToTargetY;
            }
        }

        const calibration = {
            height: measuredHeight ?? MULTIPLAYER_DEFAULT_HEIGHT,
            groundY: measuredGroundY
        } satisfies MultiplayerHeightCalibration;
        this.multiplayerHeightCalibrations.set(player.id, calibration);
        this.emitDiagnostic('multiplayer-avatar-height-calibrated', {
            playerId: player.id,
            height: Number(calibration.height.toFixed(3)),
            groundY: calibration.groundY === undefined ? null : Number(calibration.groundY.toFixed(3)),
            source: measuredHeight === null ? 'default' : measuredGroundY === undefined ? 'target' : 'splat-ground',
            totalCenters,
            stride,
            sampled,
            calibrationMs: Number((performance.now() - startedAt).toFixed(1))
        });
        return calibration;
    }

    private drawHitVolumes() {
        if (this.interactionMode === 'game' && !this.showHitboxes) {
            return;
        }

        for (const annotation of this.annotations) {
            const volume = this.hitVolumes.get(annotation.id);
            if (!volume || !this.shouldShowVolume(annotation)) {
                continue;
            }

            const color = this.foundAnnotationIds.has(annotation.id) ? HIT_VOLUME_FOUND_COLOR : HIT_VOLUME_COLOR;
            this.scene.app.drawWireAlignedBox(volume.min, volume.max, color, true, this.scene.worldLayer);
        }
    }

    private findCenterHit(surfacePoint?: Vec3 | null, centerRay?: Ray | null) {
        let bestAnnotation: SemanticAnnotation | null = null;
        let bestDistance = Infinity;
        const candidates: Array<Record<string, unknown>> = [];

        for (const annotation of this.annotations) {
            if (!this.isActiveGameTarget(annotation)) {
                continue;
            }

            const volume = this.hitVolumes.get(annotation.id);
            if (this.requiresMaskVolume(annotation) && !volume) {
                continue;
            }

            const world = this.annotationCenter(annotation);
            const radius = this.annotationHitRadius(annotation);
            const distance = surfacePoint ? new Vec3().sub2(world, surfacePoint).length() : Infinity;

            let hit = distance <= radius;
            let rank = distance;
            let details: Record<string, unknown> = {
                id: annotation.id,
                label: annotation.label,
                radius: Number(radius.toFixed(3)),
                anchorDistance: Number(distance.toFixed(3))
            };
            if (volume) {
                const surfaceInside = surfacePoint ? this.pointInsideVolume(surfacePoint, volume) : false;
                const surfaceVolumeDistance = surfacePoint ? this.pointVolumeDistance(surfacePoint, volume) : Infinity;
                const surfaceNearMargin = Math.max(0.12, Math.min(0.55, volume.radius * 0.28));
                const surfaceNearVolume = surfaceVolumeDistance <= surfaceNearMargin;
                const rayDistance = centerRay ? this.rayVolumeDistance(centerRay, volume) : null;
                const surfaceDistance = surfacePoint && centerRay ?
                    new Vec3().sub2(surfacePoint, centerRay.origin).length() :
                    Infinity;
                const occlusionMargin = Math.max(0.14, Math.min(0.65, volume.radius * 0.28));
                const blockedByCloserSurface = Boolean(
                    centerRay &&
                    surfacePoint &&
                    rayDistance !== null &&
                    !surfaceInside &&
                    !surfaceNearVolume &&
                    surfaceDistance < rayDistance - occlusionMargin
                );

                hit = surfaceInside || surfaceNearVolume || (rayDistance !== null && !blockedByCloserSurface);
                rank = surfaceInside || surfaceNearVolume ? surfaceVolumeDistance : rayDistance ?? distance;
                details = {
                    ...details,
                    source: volume.source,
                    samples: volume.sampleCount,
                    surfaceInside,
                    surfaceNearVolume,
                    surfaceVolumeDistance: Number(surfaceVolumeDistance.toFixed(3)),
                    surfaceNearMargin: Number(surfaceNearMargin.toFixed(3)),
                    rayDistance: rayDistance === null ? null : Number(rayDistance.toFixed(3)),
                    surfaceDistance: Number(surfaceDistance.toFixed(3)),
                    occlusionMargin: Number(occlusionMargin.toFixed(3)),
                    blockedByCloserSurface,
                    hit
                };
            }
            candidates.push(details);

            if (hit && rank < bestDistance) {
                bestAnnotation = annotation;
                bestDistance = rank;
            }
        }

        this.lastClickCandidates = candidates
        .sort((a, b) => Number(a.rayDistance ?? a.surfaceVolumeDistance ?? a.anchorDistance ?? Infinity) - Number(b.rayDistance ?? b.surfaceVolumeDistance ?? b.anchorDistance ?? Infinity))
        .slice(0, 5);
        return bestAnnotation;
    }

    private async rebuildHitVolumes(annotations: SemanticAnnotation[]) {
        const generation = ++this.hitVolumeGeneration;
        const startedAt = performance.now();
        const nextHitVolumes = new Map<string, MaskHitVolume>();
        const nextHitVolumeSourceSignatures = new Map<string, string>();
        let attempted = 0;
        let built = 0;

        for (const annotation of annotations) {
            if (this.shouldAbortHitVolumeBuild(generation)) {
                return;
            }
            const maskSrc = annotation.targetImage?.fullMaskSrc ?? annotation.targetImage?.maskSrc;
            if (!maskSrc || !annotation.source?.camera) {
                continue;
            }

            attempted += 1;
            const signature = this.hitVolumeSignature(annotation, maskSrc);
            const cachedVolume = this.hitVolumes.get(annotation.id);
            const cachedSignature = this.hitVolumeSourceSignatures.get(annotation.id);
            const volume = cachedVolume && cachedSignature === signature ?
                cachedVolume :
                await this.buildMaskHitVolume(annotation, maskSrc).catch((_error: unknown): null => null);
            if (generation !== this.hitVolumeGeneration) {
                return;
            }
            if (volume) {
                built += 1;
                nextHitVolumes.set(annotation.id, volume);
                nextHitVolumeSourceSignatures.set(annotation.id, signature);
            }
        }

        if (this.shouldAbortHitVolumeBuild(generation)) {
            return;
        }
        this.hitVolumes.clear();
        for (const [id, volume] of nextHitVolumes) {
            this.hitVolumes.set(id, volume);
        }
        this.hitVolumeSourceSignatures.clear();
        for (const [id, signature] of nextHitVolumeSourceSignatures) {
            this.hitVolumeSourceSignatures.set(id, signature);
        }
        this.syncMarkerClasses();
        this.update();
        this.emitDiagnostic('semantic-hitboxes-built', {
            ...this.hitboxDiagnosticDetails(),
            attempted,
            built,
            buildMs: Number((performance.now() - startedAt).toFixed(1))
        });
    }

    private shouldAbortHitVolumeBuild(generation: number) {
        return generation !== this.hitVolumeGeneration;
    }

    private hitVolumeSignature(annotation: SemanticAnnotation, maskSrc: string) {
        return JSON.stringify({
            id: annotation.id,
            maskSrc,
            position: annotation.position,
            radius: annotation.radius,
            sceneGeometryRevision: this.sceneGeometryRevision,
            sourceCamera: annotation.source?.camera,
            sourceCaptureSize: annotation.source?.captureSize,
            targetImage: {
                width: annotation.targetImage?.width,
                height: annotation.targetImage?.height,
                fullWidth: annotation.targetImage?.fullWidth,
                fullHeight: annotation.targetImage?.fullHeight
            }
        });
    }

    private sourceViewMatrix(annotation: SemanticAnnotation) {
        const sourceCamera = annotation.source.camera;
        if (Array.isArray(sourceCamera.viewMatrix) && sourceCamera.viewMatrix.length === 16) {
            this.captureViewMatrix.data.set(sourceCamera.viewMatrix);
            return this.captureViewMatrix.data as Float32Array;
        }

        this.captureViewMatrix.setLookAt(
            new Vec3(sourceCamera.position[0], sourceCamera.position[1], sourceCamera.position[2]),
            new Vec3(sourceCamera.target[0], sourceCamera.target[1], sourceCamera.target[2]),
            Vec3.UP
        );
        this.captureViewMatrix.invert();
        return this.captureViewMatrix.data as Float32Array;
    }

    private async buildMaskHitVolume(annotation: SemanticAnnotation, maskSrc: string) {
        const mask = await selectedMaskPixels(maskSrc);
        if (mask.points.length < 3) {
            return null;
        }

        const generation = this.hitVolumeGeneration;
        const maskMatchesSourceCapture = annotation.source.captureSize ?
            Math.abs(mask.width - annotation.source.captureSize[0]) <= 2 &&
            Math.abs(mask.height - annotation.source.captureSize[1]) <= 2 :
            false;
        const canProjectSplats = Boolean(annotation.targetImage?.fullMaskSrc) || maskMatchesSourceCapture;
        if (!canProjectSplats || this.shouldAbortHitVolumeBuild(generation)) {
            return null;
        }

        const view = this.sourceViewMatrix(annotation);
        const candidates: MaskHitVolume[] = [];
        const normal = this.buildSplatCenterHitVolume(annotation, mask, false, view);
        if (normal) {
            candidates.push(normal);
        }
        const flipped = this.buildSplatCenterHitVolume(annotation, mask, true, view);
        if (flipped) {
            candidates.push(flipped);
        }

        if (candidates.length === 0) {
            return null;
        }

        const anchor = new Vec3(annotation.position[0], annotation.position[1], annotation.position[2]);
        candidates.sort((a, b) => new Vec3().sub2(a.center, anchor).length() - new Vec3().sub2(b.center, anchor).length());
        return candidates[0];
    }

    private onPointerDown = (event: PointerEvent) => {
        if (this.interactionMode !== 'game' || (event.target as HTMLElement).closest('.semantic-annotation-marker')) {
            return;
        }

        this.pointerDownPos = { x: event.clientX, y: event.clientY };
    };

    private onPointerUp = async (event: PointerEvent) => {
        if (this.interactionMode !== 'game' || !this.pointerDownPos || (event.target as HTMLElement).closest('.semantic-annotation-marker')) {
            this.pointerDownPos = null;
            return;
        }

        const dx = event.clientX - this.pointerDownPos.x;
        const dy = event.clientY - this.pointerDownPos.y;
        this.pointerDownPos = null;
        if (Math.sqrt(dx * dx + dy * dy) > 5) {
            return;
        }

        await this.clickCenter();
    };

    private async clickCenter(screenPoint?: [number, number]) {
        if (this.interactionMode !== 'game') {
            return { ok: false, reason: 'inactive' };
        }

        const startedAt = performance.now();
        const normalizedScreenPoint = screenPoint ?? [0.5, 0.5];
        const x = Math.max(0, Math.min(1, normalizedScreenPoint[0]));
        const y = Math.max(0, Math.min(1, normalizedScreenPoint[1]));
        const centerRay = new Ray();
        const { width, height } = this.scene.camera.targetSize;
        this.scene.camera.getRay(width * x, height * y, centerRay);
        const intersectStartedAt = performance.now();
        const canReachTarget = this.rayCanReachActiveHitVolume(centerRay);
        const hit = canReachTarget ? await this.scene.camera.intersect(x, y) : null;
        const intersectMs = performance.now() - intersectStartedAt;
        const matchStartedAt = performance.now();
        const matched = this.findCenterHit(hit?.position ?? null, centerRay);
        const matchMs = performance.now() - matchStartedAt;
        const clickEvalMs = performance.now() - startedAt;
        const clickDiagnostics = {
            screenPoint: [Number(x.toFixed(4)), Number(y.toFixed(4))],
            hasSurfaceHit: Boolean(hit?.position),
            intersectMs: Number(intersectMs.toFixed(1)),
            intersectSkipped: !canReachTarget,
            matchMs: Number(matchMs.toFixed(1)),
            clickEvalMs: Number(clickEvalMs.toFixed(1))
        };

        if (matched) {
            this.events.fire('semanticAnnotations.activate', matched.id);
            return { ok: true, annotationId: matched.id, candidates: this.lastClickCandidates, ...clickDiagnostics, ...this.hitboxDiagnosticDetails() };
        }

        const point = hit?.position ? [hit.position.x, hit.position.y, hit.position.z] : null;
        this.events.fire('semanticAnnotations.miss', point);
        return { ok: false, point, candidates: this.lastClickCandidates, ...clickDiagnostics, ...this.hitboxDiagnosticDetails() };
    }

    private async captureAnchor() {
        const canvas = this.scene.canvas;
        const hit = await this.scene.camera.intersect(0.5, 0.5);
        if (!hit) {
            return { ok: false, error: 'No surface under crosshair' };
        }

        const camera = this.scene.camera;
        const position = camera.position;
        const target = camera.focalPoint;

        return {
            ok: true,
            position: [hit.position.x, hit.position.y, hit.position.z],
            screenPoint: [0.5, 0.5],
            captureSize: [canvas.clientWidth, canvas.clientHeight],
            radius: Math.max(0.12, Math.min(0.75, hit.distance * 0.08)),
            camera: {
                position: [position.x, position.y, position.z],
                target: [target.x, target.y, target.z],
                fov: camera.fov,
                ortho: camera.ortho,
                viewMatrix: Array.from(camera.camera.viewMatrix.data)
            }
        };
    }

    private update() {
        const { clientWidth, clientHeight } = this.scene.canvas;
        const cameraPosition = this.scene.camera.position;

        for (const annotation of this.annotations) {
            const marker = this.markers.get(annotation.id);
            if (!marker) {
                continue;
            }

            const world = this.annotationCenter(annotation);
            this.scene.camera.worldToScreen(world, this.screenPos);

            const visible = this.shouldUpdateAnnotationMarker(annotation) &&
                this.screenPos.z >= 0 &&
                this.screenPos.z <= 1 &&
                this.screenPos.x >= -0.05 &&
                this.screenPos.x <= 1.05 &&
                this.screenPos.y >= -0.05 &&
                this.screenPos.y <= 1.05;

            this.setMarkerHidden(annotation.id, marker, !visible);
            if (!visible) {
                continue;
            }

            const volume = this.hitVolumes.get(annotation.id);
            const transform = `translate(${(this.screenPos.x * clientWidth).toFixed(1)}px, ${(this.screenPos.y * clientHeight).toFixed(1)}px)`;
            const radius = this.annotationHitRadius(annotation);
            const distance = Math.max(0.1, this.markerDistanceDelta.sub2(world, cameraPosition).length());
            const radiusPx = Math.max(18, Math.min(190, radius / distance * clientHeight * 0.55));
            this.updateMarkerRenderState(annotation.id, marker, {
                transform,
                hitboxSize: `${radiusPx.toFixed(1)}px`,
                maskVolumeTarget: volume !== undefined && this.shouldShowVolume(annotation),
                inactiveGameTarget: this.interactionMode === 'game' && !this.isActiveGameTarget(annotation),
                foundGameTarget: this.foundAnnotationIds.has(annotation.id)
            });
        }

        this.updateMultiplayerPlayers(clientWidth, clientHeight, cameraPosition);
    }

    private updateMultiplayerPlayers(clientWidth: number, clientHeight: number, cameraPosition: Vec3) {
        if (this.multiplayerPlayers.length > 0) {
            this.loadMultiplayerAvatarAsset('update');
        }

        const nowMs = performance.now();
        for (const player of this.multiplayerPlayers) {
            const marker = this.multiplayerMarkers.get(player.id);
            if (!marker) {
                continue;
            }

            this.multiplayerWorld.set(player.position[0], player.position[1], player.position[2]);
            this.scene.camera.worldToScreen(this.multiplayerWorld, this.screenPos);

            const visible =
                this.screenPos.z >= 0 &&
                this.screenPos.z <= 1 &&
                this.screenPos.x >= -0.04 &&
                this.screenPos.x <= 1.04 &&
                this.screenPos.y >= -0.04 &&
                this.screenPos.y <= 1.04;

            marker.hidden = !visible;
            if (!visible) {
                const avatar = this.multiplayerAvatarInstances.get(player.id);
                if (avatar) {
                    avatar.entity.enabled = false;
                    this.transitionMultiplayerAvatar(avatar, 'idle');
                    avatar.smoothedPlanarSpeed = 0;
                    avatar.lastPosition.set(player.position[0], player.position[1], player.position[2]);
                    avatar.lastUpdateMs = nowMs;
                }
                continue;
            }

            const calibration = this.calibrateMultiplayerHeight(player);
            const avatarWorldHeight = calibration.height;
            const avatar = this.ensureMultiplayerAvatar(player);
            if (avatar) {
                this.updateMultiplayerAvatar(player, avatar, avatarWorldHeight, nowMs);
            }
            this.updateMultiplayerMarkerAvatarState(marker, avatar);

            this.multiplayerFeetWorld.set(player.position[0], player.position[1] - avatarWorldHeight, player.position[2]);
            this.scene.camera.worldToScreen(this.multiplayerFeetWorld, this.multiplayerFeetScreenPos);

            const headX = this.screenPos.x * clientWidth;
            const headY = this.screenPos.y * clientHeight;
            const feetY = this.multiplayerFeetScreenPos.y * clientHeight;
            const projectedHeight = Math.abs(feetY - headY);
            const distance = Math.max(0.1, this.multiplayerDelta.sub2(this.multiplayerWorld, cameraPosition).length());
            const fallbackSpan = Math.max(150, Math.min(270, 310 / Math.sqrt(distance)));
            const hasProjectedFeet = Number.isFinite(projectedHeight) && projectedHeight >= 48;
            const avatarSpan = hasProjectedFeet ? Math.max(150, Math.min(330, projectedHeight)) : fallbackSpan;
            const avatarHeight = avatarSpan / 0.87;
            const anchorY = hasProjectedFeet ? feetY : headY + avatarSpan;

            marker.style.setProperty('--multiplayer-avatar-height', `${avatarHeight.toFixed(1)}px`);
            marker.style.setProperty('--multiplayer-avatar-width', `${(avatarHeight * 0.52).toFixed(1)}px`);
            marker.style.transform = avatar || !this.multiplayerAvatarFailed ?
                `translate(${headX.toFixed(1)}px, ${headY.toFixed(1)}px)` :
                `translate(${headX.toFixed(1)}px, ${anchorY.toFixed(1)}px) translate(-50%, -100%)`;
            marker.style.zIndex = `${Math.max(1, Math.round((1 - this.screenPos.z) * 1000) + 20)}`;

            if (player.target) {
                this.multiplayerTargetWorld.set(player.target[0], player.target[1], player.target[2]);
                this.scene.camera.worldToScreen(this.multiplayerTargetWorld, this.multiplayerTargetScreenPos);
                const dx = (this.multiplayerTargetScreenPos.x - this.screenPos.x) * clientWidth;
                const dy = (this.multiplayerTargetScreenPos.y - this.screenPos.y) * clientHeight;
                const angle = Math.atan2(dy, dx) * 180 / Math.PI;
                marker.style.setProperty('--multiplayer-avatar-aim-angle', `${angle.toFixed(1)}deg`);
                marker.classList.toggle('has-target', Number.isFinite(angle) && Math.abs(dx) + Math.abs(dy) > 1);
            } else {
                marker.classList.remove('has-target');
            }
        }
    }
}

export { SemanticAnnotationOverlay };
