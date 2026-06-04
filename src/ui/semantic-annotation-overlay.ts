import { Color, Mat4, Ray, Vec3 } from 'playcanvas';

import { ElementType } from '../element';
import { Events } from '../events';
import { Scene } from '../scene';
import { SemanticAnnotation } from '../semantic-annotations';
import { Splat } from '../splat';

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

const OCCLUSION_CELL_PX = 4;
const OCCLUSION_FRAC_OF_DEPTH = 0.015;
const OCCLUSION_MIN_M = 0.015;
const OCCLUSION_MAX_M = 0.12;
const HIT_VOLUME_COLOR = new Color(0.66, 1, 0.47, 0.95);
const HIT_VOLUME_FOUND_COLOR = new Color(0.3, 1, 0.46, 1);

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
    private readonly clickRay = new Ray();
    private readonly captureViewMatrix = new Mat4();
    private readonly hitVolumes = new Map<string, MaskHitVolume>();
    private annotations: SemanticAnnotation[] = [];
    private interactionMode: 'edit' | 'game' = 'edit';
    private activeGameTargetIds = new Set<string>();
    private foundAnnotationIds = new Set<string>();
    private showHitboxes = false;
    private pointerDownPos: { x: number, y: number } | null = null;
    private hitVolumeGeneration = 0;

    constructor(private readonly events: Events, private readonly scene: Scene, parent: HTMLElement) {
        this.container = document.createElement('div');
        this.container.id = 'semantic-annotation-overlay';
        parent.appendChild(this.container);

        events.on('semanticAnnotations.changed', this.setAnnotations, this);
        events.on('semanticAnnotations.interactionMode', this.setInteractionMode, this);
        events.on('semanticAnnotations.gameTargets', this.setGameTargets, this);
        events.on('semanticAnnotations.foundTargets', this.setFoundTargets, this);
        events.on('semanticAnnotations.showHitboxes', this.setShowHitboxes, this);
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
        this.events.off('prerender', this.drawHitVolumes, this);
        this.events.off('postrender', this.update, this);
        this.container.parentElement?.removeEventListener('pointerdown', this.onPointerDown);
        this.container.parentElement?.removeEventListener('pointerup', this.onPointerUp);
        this.container.remove();
        this.markers.clear();
    }

    private setAnnotations(annotations: SemanticAnnotation[]) {
        this.annotations = annotations;
        this.syncMarkers();
        this.rebuildHitVolumes(annotations).catch((_error: unknown): undefined => undefined);
        this.scene.forceRender = true;
    }

    private setInteractionMode(mode: 'edit' | 'game') {
        this.interactionMode = mode;
        if (mode === 'game') {
            this.hitVolumeGeneration += 1;
        }
        this.container.classList.toggle('game-mode', mode === 'game');
        if (mode !== 'game') {
            this.setShowHitboxes(false);
        }
        this.syncMarkerClasses();
    }

    private setGameTargets(annotationIds?: string[]) {
        this.activeGameTargetIds = new Set(Array.isArray(annotationIds) ? annotationIds : []);
        this.syncMarkerClasses();
    }

    private setFoundTargets(annotationIds?: string[]) {
        this.foundAnnotationIds = new Set(Array.isArray(annotationIds) ? annotationIds : []);
        this.syncMarkerClasses();
    }

    private setShowHitboxes(showHitboxes?: boolean) {
        this.showHitboxes = showHitboxes === true;
        this.container.classList.toggle('show-hitboxes', this.showHitboxes);
        this.syncMarkerClasses();
    }

    private syncMarkerClasses() {
        for (const annotation of this.annotations) {
            const marker = this.markers.get(annotation.id);
            if (!marker) {
                continue;
            }

            const hasUsableVolume = !this.requiresMaskVolume(annotation) || this.hitVolumes.has(annotation.id);
            marker.classList.toggle('inactive-game-target', this.interactionMode === 'game' && !this.isActiveGameTarget(annotation));
            marker.classList.toggle('found-game-target', this.foundAnnotationIds.has(annotation.id));
            marker.classList.toggle(
                'visible-test-target',
                this.interactionMode === 'game' && this.showHitboxes && this.isActiveGameTarget(annotation) && hasUsableVolume
            );
        }
        this.scene.forceRender = true;
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
            this.foundAnnotationIds.has(annotation.id) ||
            (this.showHitboxes && this.isActiveGameTarget(annotation));
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

    private pointInsideVolume(point: Vec3, volume: MaskHitVolume) {
        const margin = Math.max(0.04, volume.radius * 0.1);
        const dx = Math.max(volume.min.x - point.x, 0, point.x - volume.max.x);
        const dy = Math.max(volume.min.y - point.y, 0, point.y - volume.max.y);
        const dz = Math.max(volume.min.z - point.z, 0, point.z - volume.max.z);
        return Math.sqrt(dx * dx + dy * dy + dz * dz) <= margin;
    }

    private rayIntersectsVolume(ray: Ray, volume: MaskHitVolume) {
        const margin = Math.max(0.04, volume.radius * 0.1);
        let near = -Infinity;
        let far = Infinity;

        const updateAxis = (origin: number, direction: number, min: number, max: number) => {
            const a = min - margin;
            const b = max + margin;
            if (Math.abs(direction) < 1e-6) {
                return origin >= a && origin <= b;
            }

            const t1 = (a - origin) / direction;
            const t2 = (b - origin) / direction;
            near = Math.max(near, Math.min(t1, t2));
            far = Math.min(far, Math.max(t1, t2));
            return near <= far;
        };

        if (!updateAxis(ray.origin.x, ray.direction.x, volume.min.x, volume.max.x)) {
            return null;
        }
        if (!updateAxis(ray.origin.y, ray.direction.y, volume.min.y, volume.max.y)) {
            return null;
        }
        if (!updateAxis(ray.origin.z, ray.direction.z, volume.min.z, volume.max.z)) {
            return null;
        }

        if (far < 0) {
            return null;
        }

        return { near: Math.max(0, near), far };
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

    private drawHitVolumes() {
        let drew = false;
        for (const annotation of this.annotations) {
            const volume = this.hitVolumes.get(annotation.id);
            if (!volume || !this.shouldShowVolume(annotation)) {
                continue;
            }

            const color = this.foundAnnotationIds.has(annotation.id) ? HIT_VOLUME_FOUND_COLOR : HIT_VOLUME_COLOR;
            this.scene.app.drawWireAlignedBox(volume.min, volume.max, color, true, this.scene.worldLayer);
            drew = true;
        }

        if (drew) {
            this.scene.forceRender = true;
        }
    }

    private findCenterHit(surfacePoint?: Vec3 | null, surfaceDistance?: number | null) {
        const targetSize = this.scene.camera.targetSize;
        this.scene.camera.getRay(targetSize.width * 0.5, targetSize.height * 0.5, this.clickRay);
        const maxRayDistance = typeof surfaceDistance === 'number' && Number.isFinite(surfaceDistance) ?
            surfaceDistance + 0.08 :
            Infinity;

        if (!surfacePoint) {
            surfaceDistance = null;
        }

        let bestAnnotation: SemanticAnnotation | null = null;
        let bestDistance = Infinity;

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

            const rayHit = volume ? this.rayIntersectsVolume(this.clickRay, volume) : null;
            const hit = volume ?
                (surfacePoint ? this.pointInsideVolume(surfacePoint, volume) : false) ||
                    (rayHit !== null && rayHit.near <= maxRayDistance) :
                distance <= radius;
            if (hit && distance < bestDistance) {
                bestAnnotation = annotation;
                bestDistance = Number.isFinite(distance) ? distance : rayHit?.near ?? Infinity;
            }
        }

        return bestAnnotation;
    }

    private async rebuildHitVolumes(annotations: SemanticAnnotation[]) {
        const generation = ++this.hitVolumeGeneration;
        const nextHitVolumes = new Map<string, MaskHitVolume>();

        for (const annotation of annotations) {
            if (this.shouldAbortHitVolumeBuild(generation)) {
                return;
            }
            const maskSrc = annotation.targetImage?.fullMaskSrc ?? annotation.targetImage?.maskSrc;
            if (!maskSrc || !annotation.source?.camera) {
                continue;
            }

            const volume = await this.buildMaskHitVolume(annotation, maskSrc).catch((_error: unknown): null => null);
            if (generation !== this.hitVolumeGeneration) {
                return;
            }
            if (volume) {
                nextHitVolumes.set(annotation.id, volume);
            }
        }

        if (this.shouldAbortHitVolumeBuild(generation)) {
            return;
        }
        this.hitVolumes.clear();
        for (const [id, volume] of nextHitVolumes) {
            this.hitVolumes.set(id, volume);
        }
        this.syncMarkerClasses();
        this.update();
    }

    private shouldAbortHitVolumeBuild(generation: number) {
        return generation !== this.hitVolumeGeneration || this.interactionMode === 'game' || document.pointerLockElement !== null;
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

    private async clickCenter() {
        if (this.interactionMode !== 'game') {
            return { ok: false, reason: 'inactive' };
        }

        const hit = await this.scene.camera.intersect(0.5, 0.5);
        const matched = this.findCenterHit(hit?.position ?? null, hit?.distance ?? null);

        if (matched) {
            this.events.fire('semanticAnnotations.activate', matched.id);
            return { ok: true, annotationId: matched.id };
        }

        const point = hit?.position ? [hit.position.x, hit.position.y, hit.position.z] : null;
        this.events.fire('semanticAnnotations.miss', point);
        return { ok: false, point };
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

            const visible =
                this.screenPos.z >= 0 &&
                this.screenPos.z <= 1 &&
                this.screenPos.x >= -0.05 &&
                this.screenPos.x <= 1.05 &&
                this.screenPos.y >= -0.05 &&
                this.screenPos.y <= 1.05;

            marker.hidden = !visible;
            if (visible) {
                const volume = this.hitVolumes.get(annotation.id);
                marker.style.transform = `translate(${(this.screenPos.x * clientWidth).toFixed(1)}px, ${(this.screenPos.y * clientHeight).toFixed(1)}px)`;
                const radius = this.annotationHitRadius(annotation);
                const distance = Math.max(0.1, new Vec3().sub2(world, cameraPosition).length());
                const radiusPx = Math.max(18, Math.min(190, radius / distance * clientHeight * 0.55));
                marker.style.setProperty('--semantic-hitbox-size', `${radiusPx.toFixed(1)}px`);
                marker.style.removeProperty('--semantic-hitbox-width');
                marker.style.removeProperty('--semantic-hitbox-height');
                marker.classList.toggle('mask-volume-target', volume !== undefined && this.shouldShowVolume(annotation));
                marker.classList.toggle('inactive-game-target', this.interactionMode === 'game' && !this.isActiveGameTarget(annotation));
                marker.classList.toggle('found-game-target', this.foundAnnotationIds.has(annotation.id));
            }
        }
    }
}

export { SemanticAnnotationOverlay };
