import { Vec3 } from 'playcanvas';

import { SelectOp } from '../edit-ops';
import { Events } from '../events';
import { Scene } from '../scene';
import { Splat } from '../splat';

const getSam3BackendUrl = () => {
    return window.supersplatConfig?.sam3BackendUrl || 'https://sam3.4dream.app';
};

const EPS_FRAC_OF_DEPTH = 0.025;
const EPS_MIN_M = 0.005;
const EPS_MAX_M = 1.0;

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

        // Shared logic: given a mask and optional click point, select splats
        const processMask = (
            splat: Splat,
            mask: Uint8Array, maskW: number, maskH: number,
            imgW: number, imgH: number,
            intr: { fx: number; fy: number; cx: number; cy: number },
            clickX?: number, clickY?: number
        ) => {
            const t0 = performance.now();
            const candidates = collectMaskCandidates(splat, scene, mask, maskW, maskH, imgW, imgH, intr);
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

            const seed = findSeedOnRay(candidates, seedX, seedY, 20);
            if (seed < 0) {
                events.fire('toast', 'Nothing detected', 'warning');
                return;
            }
            const clickDepth = candidates[seed].cz;
            const eps = Math.min(EPS_MAX_M, Math.max(EPS_MIN_M, clickDepth * EPS_FRAC_OF_DEPTH));
            const kept = regionGrow(candidates, seed, eps);

            const pickedIdx = new Set<number>();
            for (const k of kept) pickedIdx.add(candidates[k].idx);
            if (pickedIdx.size === 0) {
                events.fire('toast', 'Nothing detected', 'warning');
                return;
            }

            console.log(
                `[SAM3] candidates=${candidates.length} seed=${seed} kept=${kept.size}` +
                ` (${(performance.now() - t0).toFixed(0)}ms)`
            );

            const op = new SelectOp(splat, 'add', i => pickedIdx.has(i));
            events.fire('edit.add', op);

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
            try {
                const w = canvas.clientWidth;
                const h = canvas.clientHeight;
                const cam = scene.camera.camera;
                const intr = extractIntrinsics(cam, w, h);

                const img = await captureScene(events, w, h);
                if (!this.active) return;
                console.log(`[SAM3] click=(${clickX},${clickY})`);

                const sam3BackendUrl = getSam3BackendUrl();
                const res = await fetch(`${sam3BackendUrl}/api/sam3/segment`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ image: img, click_xy: [clickX, clickY], label: 1 }),
                    signal: abort.signal
                });
                if (!this.active) return;
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    console.error(`[SAM3] ${res.status}: ${err.error || res.statusText}`);
                    events.fire('toast', 'SAM3 backend error', 'error');
                    return;
                }
                const data = await res.json() as { mask: string; width: number; height: number };
                if (!this.active) return;
                const mask = await maskPngToArray(data.mask, data.width, data.height);
                if (!this.active) return;

                processMask(splat, mask, data.width, data.height, w, h, intr, clickX, clickY);
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
            parent.style.cursor = 'wait';
            try {
                const w = canvas.clientWidth;
                const h = canvas.clientHeight;
                const cam = scene.camera.camera;
                const intr = extractIntrinsics(cam, w, h);
                const img = await captureScene(events, w, h);
                if (!this.active) return;

                console.log(`[SAM3] text="${text}"`);
                const sam3BackendUrl = getSam3BackendUrl();
                const res = await fetch(`${sam3BackendUrl}/api/sam3/segment-text`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
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

                processMask(splat, mask, data.width, data.height, w, h, intr);
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

        this.activate = () => {
            this.active = true;
            parent.style.cursor = 'crosshair';
            parent.addEventListener('pointerdown', pointerHandler, true);
            events.on('ai.textQuery', textHandler);
        };

        this.deactivate = () => {
            this.active = false;
            parent.style.cursor = '';
            parent.removeEventListener('pointerdown', pointerHandler, true);
            events.off('ai.textQuery', textHandler);
            abort?.abort();
            abort = null;
            busy = false;
        };
    }
}

export { Sam3Selection };
