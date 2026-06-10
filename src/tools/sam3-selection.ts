import { Vec3 } from 'playcanvas';

import { SelectOp } from '../edit-ops';
import { Events } from '../events';
import { Scene } from '../scene';
import { Splat } from '../splat';

const DEFAULT_SAM3_BACKEND_URL = 'http://3.19.208.185:8000';

const getSam3BackendUrl = () => {
    return window.supersplatConfig?.sam3BackendUrl?.trim() || DEFAULT_SAM3_BACKEND_URL;
};

const getSam3FetchCredentials = (sam3BackendUrl: string): 'same-origin' | 'include' => {
    if (!window.supersplatConfig?.sam3BackendUrl?.trim()) {
        return 'same-origin';
    }

    try {
        return new URL(sam3BackendUrl, window.location.href).origin === window.location.origin ? 'same-origin' : 'include';
    } catch {
        return 'same-origin';
    }
};

const EPS_FRAC_OF_DEPTH = 0.02;
const EPS_MIN_M = 0.005;
const EPS_MAX_M = 0.12;

const OCCLUSION_CELL_PX = 4;
const OCCLUSION_FRAC_OF_DEPTH = 0.015;
const OCCLUSION_MIN_M = 0.015;
const OCCLUSION_MAX_M = 0.12;

const captureScene = async (events: Events, width: number, height: number): Promise<string> => {
    const rgba: Uint8Array = await events.invoke('render.offscreen', width, height);
    const off = document.createElement('canvas');
    off.width = width;
    off.height = height;
    const ctx = off.getContext('2d')!;
    const imageData = ctx.createImageData(width, height);
    imageData.data.set(rgba);
    ctx.putImageData(imageData, 0, 0);
    return off.toDataURL('image/png').split(',')[1];
};

const maskPngToArray = async (b64: string, width: number, height: number): Promise<Uint8Array> => {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('mask image load failed'));
        img.src = `data:image/png;base64,${b64}`;
    });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, width, height);
    const id = ctx.getImageData(0, 0, width, height);
    const out = new Uint8Array(width * height);
    for (let i = 0, j = 0; i < id.data.length; i += 4, j++) out[j] = id.data[i];
    return out;
};

const extractIntrinsics = (cam: any, w: number, h: number) => {
    const fovRad = (cam.fov * Math.PI) / 180;
    const f = cam.horizontalFov ?
        w / (2 * Math.tan(fovRad / 2)) :
        h / (2 * Math.tan(fovRad / 2));
    return { fx: f, fy: f, cx: w / 2, cy: h / 2 };
};

type Candidate = { idx: number; wx: number; wy: number; wz: number; cz: number; u: number; v: number };
type Sam3PromptLabel = 0 | 1;
type Sam3PromptPoint = { click_xy: [number, number]; label: Sam3PromptLabel };
type Sam3PromptSession = {
    viewKey: string;
    image: string;
    jobId?: string;
    points: Sam3PromptPoint[];
};
type Sam3SelectionMode = 'add' | 'remove' | 'set';
type MaskProjectionMode = 'connected' | 'complete';
type Sam3ImageSize = { width: number; height: number };
type Sam3SegmentResponse = {
    mask?: string;
    width?: number;
    height?: number;
    job_id?: string;
    supportsPromptRefinement?: boolean;
    error?: string;
};

const keyMatrix = (values?: Float32Array | number[]): string => {
    if (!values) return '';
    return Array.from(values).map(value => value.toFixed(5)).join(',');
};

const buildViewKey = (scene: Scene, splat: Splat, width: number, height: number): string => {
    const cam = scene.camera.camera as any;
    const view = keyMatrix(cam.viewMatrix?.data);
    const projection = keyMatrix(cam.projectionMatrix?.data) || `${cam.fov}:${cam.horizontalFov}:${cam.orthoHeight}`;
    const splatTransform = keyMatrix(splat.entity.getWorldTransform().data as Float32Array);
    return `${width}x${height}|${view}|${projection}|${splatTransform}`;
};

const normalizePromptPoint = (point: Sam3PromptPoint, imageSize: Sam3ImageSize): [number, number] => {
    const width = Math.max(1, imageSize.width);
    const height = Math.max(1, imageSize.height);
    return [
        Math.min(1, Math.max(0, point.click_xy[0] / width)),
        Math.min(1, Math.max(0, point.click_xy[1] / height))
    ];
};

const collectMaskCandidates = (
    splat: Splat,
    scene: Scene,
    mask: Uint8Array, maskW: number, maskH: number,
    imgW: number, imgH: number,
    intrinsics: { fx: number; fy: number; cx: number; cy: number }
): Candidate[] => {
    const sorter: any = splat.entity.gsplat?.instance?.sorter;
    const centers: Float32Array = sorter?.centers;
    if (!centers) return [];

    const wm = splat.entity.getWorldTransform().data as Float32Array;
    const v = scene.camera.camera.viewMatrix.data as Float32Array;
    const { fx, fy, cx, cy } = intrinsics;
    const msx = maskW / imgW;
    const msy = maskH / imgH;

    const out: Candidate[] = [];
    const n = centers.length / 3;
    for (let i = 0; i < n; i++) {
        const lx = centers[i * 3], ly = centers[i * 3 + 1], lz = centers[i * 3 + 2];
        const wx = wm[0] * lx + wm[4] * ly + wm[8]  * lz + wm[12];
        const wy = wm[1] * lx + wm[5] * ly + wm[9]  * lz + wm[13];
        const wz = wm[2] * lx + wm[6] * ly + wm[10] * lz + wm[14];
        const ogZ = v[2] * wx + v[6] * wy + v[10] * wz + v[14];
        const cz = -ogZ;
        if (cz <= 0) continue;
        const ogX = v[0] * wx + v[4] * wy + v[8]  * wz + v[12];
        const ogY = v[1] * wx + v[5] * wy + v[9]  * wz + v[13];
        const u = Math.round(fx * ogX / cz + cx);
        const vp = Math.round(fy * (-ogY) / cz + cy);
        if (u < 0 || u >= imgW || vp < 0 || vp >= imgH) continue;
        const mu = Math.min(maskW - 1, Math.round(u * msx));
        const mv = Math.min(maskH - 1, Math.round(vp * msy));
        if (mask[mv * maskW + mu] === 0) continue;
        out.push({ idx: i, wx, wy, wz, cz, u, v: vp });
    }
    return out;
};

const filterFrontSurfaceCandidates = (candidates: Candidate[], imgW: number, imgH: number): Candidate[] => {
    const depthW = Math.ceil(imgW / OCCLUSION_CELL_PX);
    const depthH = Math.ceil(imgH / OCCLUSION_CELL_PX);
    const nearest = new Float32Array(depthW * depthH);
    nearest.fill(Infinity);

    for (const candidate of candidates) {
        const x = Math.min(depthW - 1, Math.max(0, Math.floor(candidate.u / OCCLUSION_CELL_PX)));
        const y = Math.min(depthH - 1, Math.max(0, Math.floor(candidate.v / OCCLUSION_CELL_PX)));
        const idx = y * depthW + x;
        if (candidate.cz < nearest[idx]) {
            nearest[idx] = candidate.cz;
        }
    }

    return candidates.filter((candidate) => {
        const x = Math.min(depthW - 1, Math.max(0, Math.floor(candidate.u / OCCLUSION_CELL_PX)));
        const y = Math.min(depthH - 1, Math.max(0, Math.floor(candidate.v / OCCLUSION_CELL_PX)));
        let nearestDepth = Infinity;

        for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= depthH) continue;

            for (let dx = -1; dx <= 1; dx++) {
                const xx = x + dx;
                if (xx < 0 || xx >= depthW) continue;
                nearestDepth = Math.min(nearestDepth, nearest[yy * depthW + xx]);
            }
        }

        const tolerance = Math.min(
            OCCLUSION_MAX_M,
            Math.max(OCCLUSION_MIN_M, nearestDepth * OCCLUSION_FRAC_OF_DEPTH)
        );
        return candidate.cz <= nearestDepth + tolerance;
    });
};

const findSeedOnRay = (
    c: Candidate[],
    clickX: number,
    clickY: number,
    radius = 6
): number => {
    const r2 = radius * radius;
    let ray = -1;
    let rayZ = Infinity;
    let fallback = -1;
    let fallbackD2 = Infinity;
    for (let i = 0; i < c.length; i++) {
        const du = c[i].u - clickX;
        const dv = c[i].v - clickY;
        const d2 = du * du + dv * dv;
        if (d2 < fallbackD2) {
            fallbackD2 = d2;
            fallback = i;
        }
        if (d2 <= r2 && c[i].cz < rayZ) {
            rayZ = c[i].cz;
            ray = i;
        }
    }
    return ray >= 0 ? ray : fallback;
};

const buildHash = (c: Candidate[], eps: number): Map<number, number[]> => {
    const cells = new Map<number, number[]>();
    const inv = 1 / eps;
    for (let i = 0; i < c.length; i++) {
        const ix = Math.floor(c[i].wx * inv) | 0;
        const iy = Math.floor(c[i].wy * inv) | 0;
        const iz = Math.floor(c[i].wz * inv) | 0;
        const key = (ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791);
        const bucket = cells.get(key);
        if (bucket) {
            bucket.push(i);
        } else {
            cells.set(key, [i]);
        }
    }
    return cells;
};

const regionGrow = (c: Candidate[], seed: number, eps: number): Set<number> => {
    const cells = buildHash(c, eps);
    const visited = new Uint8Array(c.length);
    const queue = [seed];
    visited[seed] = 1;
    const inv = 1 / eps;
    const eps2 = eps * eps;

    while (queue.length > 0) {
        const i = queue.pop()!;
        const p = c[i];
        const ix = Math.floor(p.wx * inv) | 0;
        const iy = Math.floor(p.wy * inv) | 0;
        const iz = Math.floor(p.wz * inv) | 0;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dz = -1; dz <= 1; dz++) {
                    const key = ((ix + dx) * 73856093) ^ ((iy + dy) * 19349663) ^ ((iz + dz) * 83492791);
                    const bucket = cells.get(key);
                    if (!bucket) continue;
                    for (const j of bucket) {
                        if (visited[j]) continue;
                        const q = c[j];
                        const ddx = p.wx - q.wx;
                        const ddy = p.wy - q.wy;
                        const ddz = p.wz - q.wz;
                        if (ddx * ddx + ddy * ddy + ddz * ddz > eps2) continue;
                        visited[j] = 1;
                        queue.push(j);
                    }
                }
            }
        }
    }

    const out = new Set<number>();
    for (let i = 0; i < c.length; i++) {
        if (visited[i]) out.add(i);
    }
    return out;
};

class Sam3Selection {
    activate: () => void;
    deactivate: () => void;
    active = false;

    constructor(events: Events, scene: Scene, parent: HTMLElement) {
        const canvas = scene.canvas;
        let busy = false;
        let abort: AbortController | null = null;
        let selectionMode: Sam3SelectionMode = 'set';
        let promptSession: Sam3PromptSession | null = null;

        const fetchSegment = async (
            sam3BackendUrl: string,
            payload: {
                image: string;
                click_xy: [number, number];
                label: Sam3PromptLabel;
                job_id?: string;
                points?: Sam3PromptPoint[];
                image_size: Sam3ImageSize;
            },
            signal: AbortSignal
        ): Promise<{ ok: true; data: Sam3SegmentResponse } | { ok: false; status: number; error: string; data: Sam3SegmentResponse }> => {
            const points = payload.points ?? [{ click_xy: payload.click_xy, label: payload.label }];
            const refineBody = {
                image: payload.image,
                session_id: payload.job_id,
                job_id: payload.job_id,
                object_id: 1,
                frame_index: 0,
                clear_old_points: true,
                coordinate_space: 'normalized',
                image_size: payload.image_size,
                points: points.map(point => normalizePromptPoint(point, payload.image_size)),
                labels: points.map(point => point.label)
            };

            let res = await fetch(`${sam3BackendUrl}/api/sam3/refine`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: getSam3FetchCredentials(sam3BackendUrl),
                body: JSON.stringify(refineBody),
                signal
            });
            if (res.status === 404 || res.status === 405 || res.status === 501) {
                res = await fetch(`${sam3BackendUrl}/api/sam3/segment`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: getSam3FetchCredentials(sam3BackendUrl),
                    body: JSON.stringify(payload),
                    signal
                });
            }
            const data = await res.json().catch(() => ({})) as Sam3SegmentResponse;
            if (!res.ok) {
                return { ok: false, status: res.status, error: data.error || res.statusText, data };
            }
            return { ok: true, data };
        };

        // Shared logic: given a mask and optional click point, select splats
        const processMask = (
            splat: Splat,
            mask: Uint8Array, maskW: number, maskH: number,
            imgW: number, imgH: number,
            intr: { fx: number; fy: number; cx: number; cy: number },
            op: Sam3SelectionMode,
            clickX?: number, clickY?: number,
            projectionMode: MaskProjectionMode = 'connected'
        ) => {
            const t0 = performance.now();
            const projectedCandidates = collectMaskCandidates(splat, scene, mask, maskW, maskH, imgW, imgH, intr);
            const candidates = filterFrontSurfaceCandidates(projectedCandidates, imgW, imgH);
            if (candidates.length === 0) {
                events.fire('toast', 'Nothing detected', 'warning');
                return;
            }

            // For text queries we have no click point — use mask centroid
            let seedX = clickX ?? 0;
            let seedY = clickY ?? 0;
            if (clickX === undefined || clickY === undefined) {
                let mx = 0, my = 0, count = 0;
                for (let y = 0; y < maskH; y++) {
                    for (let x = 0; x < maskW; x++) {
                        if (mask[y * maskW + x] > 0) {
                            mx += x * imgW / maskW;
                            my += y * imgH / maskH;
                            count++;
                        }
                    }
                }
                if (count > 0) {
                    seedX = mx / count;
                    seedY = my / count;
                }
            }

            const pickedIdx = new Set<number>();
            let logDetails = '';
            if (projectionMode === 'complete') {
                for (const candidate of candidates) pickedIdx.add(candidate.idx);
                logDetails = ' completeMask=true';
            } else {
                const seed = findSeedOnRay(candidates, seedX, seedY, 20);
                if (seed < 0) {
                    events.fire('toast', 'Nothing detected', 'warning');
                    return;
                }
                const clickDepth = candidates[seed].cz;
                const eps = Math.min(EPS_MAX_M, Math.max(EPS_MIN_M, clickDepth * EPS_FRAC_OF_DEPTH));
                const kept = regionGrow(candidates, seed, eps);
                for (const k of kept) pickedIdx.add(candidates[k].idx);
                logDetails = ` depth=${clickDepth.toFixed(2)} eps=${eps.toFixed(3)} seed=${seed} kept=${kept.size}`;
            }

            if (pickedIdx.size === 0) {
                events.fire('toast', 'Nothing detected', 'warning');
                return;
            }

            console.log(`[SAM3] op=${op} candidates=${candidates.length}/${projectedCandidates.length}${logDetails} (${(performance.now() - t0).toFixed(0)}ms)`);

            const selectOp = new SelectOp(splat, op, i => pickedIdx.has(i));
            events.fire('edit.add', selectOp);

            if (op === 'remove') {
                return;
            }

            // trigger reveal animation
            const centers = splat.entity.gsplat.instance.sorter.centers;
            let cx = 0, cy = 0, cz = 0;
            for (const idx of pickedIdx) {
                cx += centers[idx * 3];
                cy += centers[idx * 3 + 1];
                cz += centers[idx * 3 + 2];
            }
            const n = pickedIdx.size;
            cx /= n; cy /= n; cz /= n;
            let maxDist = 0;
            for (const idx of pickedIdx) {
                const dx = centers[idx * 3] - cx;
                const dy = centers[idx * 3 + 1] - cy;
                const dz = centers[idx * 3 + 2] - cz;
                maxDist = Math.max(maxDist, Math.sqrt(dx * dx + dy * dy + dz * dz));
            }
            splat.startReveal(new Vec3(cx, cy, cz), maxDist || 1, pickedIdx);
        };

        const pointerHandler = async (e: PointerEvent) => {
            if (!this.active) return;
            if (e.target !== canvas) return;
            if (busy) {
                events.fire('toast', 'Still processing previous click', 'info');
                return;
            }
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();

            const splat = events.invoke('selection') as Splat;
            if (!splat) {
                console.warn('[SAM3] No splat selected');
                events.fire('toast', 'No splat loaded', 'warning');
                return;
            }

            const rect = canvas.getBoundingClientRect();
            const clickX = Math.round(e.clientX - rect.left);
            const clickY = Math.round(e.clientY - rect.top);
            busy = true;
            abort = new AbortController();
            parent.style.cursor = 'wait';

            // Optimistically show the radial menu at the click point while SAM3 processes
            events.fire('sam3.clickStarted', { x: clickX, y: clickY });
            try {
                const w = canvas.clientWidth;
                const h = canvas.clientHeight;
                const cam = scene.camera.camera;
                const intr = extractIntrinsics(cam, w, h);
                const modifierOp: Sam3SelectionMode | null = e.shiftKey ? 'add' : ((e.ctrlKey || e.metaKey) ? 'remove' : null);
                const op = modifierOp ?? selectionMode;
                const click_xy: [number, number] = [clickX, clickY];
                const viewKey = buildViewKey(scene, splat, w, h);

                const hasPromptSession = promptSession !== null && promptSession.points.length > 0;
                const canRefinePrompt = hasPromptSession && promptSession.viewKey === viewKey;

                if (hasPromptSession && !canRefinePrompt) {
                    promptSession = null;
                    events.fire('toast', 'Camera changed. Starting a new SAM mask for this view.', 'info');
                }

                let requestImage: string;
                let requestJobId: string | undefined;
                let requestPoints: Sam3PromptPoint[];
                let nextPromptSession: Sam3PromptSession;
                let outputOp = op;
                const label: Sam3PromptLabel = op === 'remove' ? 0 : 1;

                if (op === 'set' || !canRefinePrompt) {
                    const img = await captureScene(events, w, h);
                    if (!this.active) return;
                    nextPromptSession = { viewKey, image: img, points: [{ click_xy, label }] };
                    requestImage = nextPromptSession.image;
                    requestPoints = nextPromptSession.points;
                } else {
                    outputOp = 'set';
                    nextPromptSession = {
                        ...promptSession!,
                        points: [...promptSession!.points, { click_xy, label }]
                    };
                    requestImage = nextPromptSession.image;
                    requestJobId = promptSession!.jobId;
                    requestPoints = nextPromptSession.points;
                }

                console.log(`[SAM3] click=(${clickX},${clickY}) op=${op} applyOp=${outputOp} promptPoints=${requestPoints.length}`);

                const sam3BackendUrl = getSam3BackendUrl();
                const segmentResult = await fetchSegment(sam3BackendUrl, {
                    image: requestImage,
                    click_xy,
                    label,
                    job_id: requestJobId,
                    points: requestPoints,
                    image_size: { width: w, height: h }
                }, abort.signal);

                if (!this.active) return;
                if (segmentResult.ok === false) {
                    console.error(`[SAM3] ${segmentResult.status}: ${segmentResult.error}`);
                    events.fire('toast', 'SAM3 backend error', 'error');
                    return;
                }

                const data = segmentResult.data;
                if (requestPoints.length > 1 && data.supportsPromptRefinement !== true) {
                    console.error('[SAM3] backend did not apply prompt refinement');
                    events.fire('toast', 'SAM prompt refinement is not available on this backend.', 'error');
                    return;
                }

                if (!data.mask || data.width === undefined || data.height === undefined) {
                    console.error('[SAM3] segmentation response missing mask data');
                    events.fire('toast', 'SAM3 backend error', 'error');
                    return;
                }

                promptSession = nextPromptSession;
                if (data.job_id) {
                    promptSession.jobId = data.job_id;
                }

                if (outputOp === 'set' && requestPoints.length > 1) {
                    console.log(`[SAM3] prompt refinement applied points=${requestPoints.length}`);
                }

                const mask = await maskPngToArray(data.mask, data.width, data.height);
                if (!this.active) return;

                processMask(
                    splat,
                    mask,
                    data.width,
                    data.height,
                    w,
                    h,
                    intr,
                    outputOp,
                    clickX,
                    clickY,
                    requestPoints.length > 1 ? 'complete' : 'connected'
                );
            } catch (err: any) {
                if (err?.name === 'AbortError') return;
                console.error('[SAM3] click failed:', err);
                events.fire('toast', 'SAM3 request failed', 'error');
            } finally {
                busy = false;
                abort = null;
                if (this.active) parent.style.cursor = 'crosshair';
            }
        };

        const textHandler = async (text: string) => {
            if (!this.active || busy) return;

            const splat = events.invoke('selection') as Splat;
            if (!splat) {
                events.fire('toast', 'No splat loaded', 'warning');
                return;
            }

            busy = true;
            abort = new AbortController();
            promptSession = null;
            parent.style.cursor = 'wait';
            try {
                const w = canvas.clientWidth;
                const h = canvas.clientHeight;
                const cam = scene.camera.camera;
                const intr = extractIntrinsics(cam, w, h);
                const op = selectionMode;
                const img = await captureScene(events, w, h);
                if (!this.active) return;

                console.log(`[SAM3] text="${text}"`);
                const sam3BackendUrl = getSam3BackendUrl();
                const res = await fetch(`${sam3BackendUrl}/api/sam3/segment-text`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: getSam3FetchCredentials(sam3BackendUrl),
                    body: JSON.stringify({ image: img, text }),
                    signal: abort.signal
                });
                if (!this.active) return;
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    console.error(`[SAM3] text ${res.status}: ${err.error || res.statusText}`);
                    events.fire('toast', 'SAM3 backend error', 'error');
                    return;
                }
                const data = await res.json() as { mask: string; width: number; height: number };
                if (!this.active) return;
                const mask = await maskPngToArray(data.mask, data.width, data.height);
                if (!this.active) return;

                processMask(splat, mask, data.width, data.height, w, h, intr, op);
            } catch (err: any) {
                if (err?.name === 'AbortError') return;
                console.error('[SAM3] text query failed:', err);
                events.fire('toast', 'SAM3 text query failed', 'error');
            } finally {
                busy = false;
                abort = null;
                if (this.active) parent.style.cursor = 'crosshair';
            }
        };

        const modeHandler = (mode: Sam3SelectionMode) => {
            selectionMode = mode;
            events.fire('sam3.selectionMode.changed', selectionMode);
        };

        events.on('sam3.selectionMode', modeHandler);
        events.fire('sam3.selectionMode.changed', selectionMode);

        this.activate = () => {
            this.active = true;
            parent.style.cursor = 'crosshair';
            parent.addEventListener('pointerdown', pointerHandler, true);
            events.on('ai.textQuery', textHandler);
            events.fire('sam3.selectionMode.changed', selectionMode);
        };

        this.deactivate = () => {
            this.active = false;
            parent.style.cursor = '';
            parent.removeEventListener('pointerdown', pointerHandler, true);
            events.off('ai.textQuery', textHandler);
            abort?.abort();
            abort = null;
            promptSession = null;
            busy = false;
        };
    }
}

export { Sam3Selection };
