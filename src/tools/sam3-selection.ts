import { Vec3 } from 'playcanvas';

import { Events } from '../events';
import { Scene } from '../scene';
import { Splat } from '../splat';

const SAM3_BACKEND_URL = (import.meta as any).env?.VITE_SAM3_BACKEND_URL || 'http://localhost:47824';

// Throttling for live tracking.
const MOVE_THRESHOLD_NDC = 0.02;   // re-run SAM 3 once the camera's up-vector or forward has moved > this in world-space angular units
const MIN_INTERVAL_MS = 250;       // and at most ~4 Hz so we don't bombard the GPU

// Per-frame render target → base64 PNG of the live scene view.
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

// Decode a base64 grayscale PNG into an HTMLCanvasElement aligned to the
// provided (width, height). That canvas is what SuperSplat's select.byMask
// event expects.
const maskPngToCanvas = async (b64: string, width: number, height: number): Promise<{canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D}> => {
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
    // Draw as alpha: SuperSplat's mask shader uses texture.a; supplying grayscale
    // directly makes RGB=mask and A=255, so we need to explicitly write the mask
    // to the alpha channel. Easiest path: draw, pull imageData, copy R→A.
    ctx.drawImage(img, 0, 0, width, height);
    const id = ctx.getImageData(0, 0, width, height);
    for (let i = 0; i < id.data.length; i += 4) {
        id.data[i + 3] = id.data[i]; // alpha = red channel of grayscale mask
    }
    ctx.putImageData(id, 0, 0);
    return { canvas, ctx };
};

// Compute the 3D centroid of the currently-selected splats (state bit 1 set).
// Returns null if no splats are selected.
const selectedCentroid = (splat: Splat): Vec3 | null => {
    const state: Uint8Array = splat.splatData.getProp('state') as Uint8Array;
    const sorter: any = splat.entity.gsplat?.instance?.sorter;
    if (!state || !sorter?.centers) return null;

    const centers: Float32Array = sorter.centers;
    const wm = splat.entity.getWorldTransform().data as Float32Array;

    let sx = 0, sy = 0, sz = 0, n = 0;
    for (let i = 0; i < state.length; i++) {
        if ((state[i] & 1) === 0) continue; // not selected
        const lx = centers[i * 3], ly = centers[i * 3 + 1], lz = centers[i * 3 + 2];
        sx += wm[0] * lx + wm[4] * ly + wm[8]  * lz + wm[12];
        sy += wm[1] * lx + wm[5] * ly + wm[9]  * lz + wm[13];
        sz += wm[2] * lx + wm[6] * ly + wm[10] * lz + wm[14];
        n++;
    }
    if (n === 0) return null;
    return new Vec3(sx / n, sy / n, sz / n);
};

// Project a world point through a PlayCanvas camera and return a pixel (x, y)
// in canvas client coordinates, or null if behind the camera.
const projectWorldToPixel = (
    world: Vec3,
    cam: any,
    w: number,
    h: number
): [number, number] | null => {
    const p = cam.projectionMatrix.data as Float32Array;
    const v = cam.viewMatrix.data as Float32Array;
    const wx = world.x, wy = world.y, wz = world.z;
    const cx = p[0] * (v[0] * wx + v[4] * wy + v[8]  * wz + v[12]) +
               p[4] * (v[1] * wx + v[5] * wy + v[9]  * wz + v[13]) +
               p[8] * (v[2] * wx + v[6] * wy + v[10] * wz + v[14]) +
               p[12] * (v[3] * wx + v[7] * wy + v[11] * wz + v[15]);
    const cy = p[1] * (v[0] * wx + v[4] * wy + v[8]  * wz + v[12]) +
               p[5] * (v[1] * wx + v[5] * wy + v[9]  * wz + v[13]) +
               p[9] * (v[2] * wx + v[6] * wy + v[10] * wz + v[14]) +
               p[13] * (v[3] * wx + v[7] * wy + v[11] * wz + v[15]);
    const cw = p[3] * (v[0] * wx + v[4] * wy + v[8]  * wz + v[12]) +
               p[7] * (v[1] * wx + v[5] * wy + v[9]  * wz + v[13]) +
               p[11] * (v[2] * wx + v[6] * wy + v[10] * wz + v[14]) +
               p[15] * (v[3] * wx + v[7] * wy + v[11] * wz + v[15]);
    if (cw <= 0) return null;
    const ndcX = cx / cw, ndcY = cy / cw;
    if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) return null;
    const px = Math.round((ndcX + 1) * 0.5 * w);
    const py = Math.round((1 - ndcY) * 0.5 * h);
    return [px, py];
};

class Sam3Selection {
    activate: () => void;
    deactivate: () => void;
    active = false;

    constructor(events: Events, scene: Scene, parent: HTMLElement) {
        const canvas = scene.canvas;
        let busy = false;
        // The 3D anchor we've locked onto after the first click. On subsequent
        // frames we project this to 2D and re-prompt SAM 3 with the new pixel.
        let anchorWorld: Vec3 | null = null;
        let lastSentAt = 0;
        let lastSentPose: Float32Array | null = null;

        const runOnce = async (
            image_b64: string,
            click_xy: [number, number],
            w: number,
            h: number
        ) => {
            const res = await fetch(`${SAM3_BACKEND_URL}/api/sam3/segment`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image: image_b64, click_xy, label: 1 })
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(`SAM3 ${res.status}: ${err.error || res.statusText}`);
            }
            const data = await res.json() as { mask: string, width: number, height: number };
            const { canvas: maskCanvas, ctx } = await maskPngToCanvas(data.mask, w, h);
            // Accumulate into the splat's persistent selection.
            await events.invoke('select.byMask', 'add', maskCanvas, ctx);
        };

        const pointerHandler = async (e: PointerEvent) => {
            if (!this.active || busy) return;
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();

            const splat = events.invoke('selection') as Splat;
            if (!splat) { console.warn('[SAM3] No splat selected'); return; }

            const rect = canvas.getBoundingClientRect();
            const clickX = Math.round(e.clientX - rect.left);
            const clickY = Math.round(e.clientY - rect.top);
            busy = true;
            parent.style.cursor = 'wait';
            try {
                const w = canvas.clientWidth;
                const h = canvas.clientHeight;
                const img = await captureScene(events, w, h);
                console.log(`[SAM3] click=(${clickX},${clickY})`);
                await runOnce(img, [clickX, clickY], w, h);
                // Lock onto the 3D centroid of whatever's selected now — that
                // becomes the anchor we reproject on subsequent frames.
                const c = selectedCentroid(splat);
                if (c) {
                    anchorWorld = c;
                    console.log(`[SAM3] anchor=(${c.x.toFixed(2)},${c.y.toFixed(2)},${c.z.toFixed(2)})`);
                }
                lastSentAt = performance.now();
                lastSentPose = new Float32Array(scene.camera.camera.viewMatrix.data as Float32Array);
            } catch (err) {
                console.error('[SAM3] click failed:', err);
            } finally {
                busy = false;
                parent.style.cursor = 'crosshair';
            }
        };

        // Decide whether the camera has moved enough since the last send to
        // warrant another mask. Uses the L1 diff of the viewMatrix rotation part.
        const poseChangedEnough = (): boolean => {
            if (!lastSentPose) return true;
            const v = scene.camera.camera.viewMatrix.data as Float32Array;
            let d = 0;
            for (let i = 0; i < 12; i++) d += Math.abs(v[i] - lastSentPose[i]);
            return d > MOVE_THRESHOLD_NDC;
        };

        const onUpdate = () => {
            if (!this.active || busy || !anchorWorld) return;
            if (performance.now() - lastSentAt < MIN_INTERVAL_MS) return;
            if (!poseChangedEnough()) return;

            const splat = events.invoke('selection') as Splat;
            if (!splat) return;

            const cam = scene.camera.camera;
            const w = canvas.clientWidth;
            const h = canvas.clientHeight;
            const pt = projectWorldToPixel(anchorWorld, cam, w, h);
            if (!pt) return; // object left the view frustum

            busy = true;
            const poseAtCapture = new Float32Array(cam.viewMatrix.data as Float32Array);
            (async () => {
                try {
                    const img = await captureScene(events, w, h);
                    await runOnce(img, pt, w, h);
                    const c = selectedCentroid(splat);
                    if (c) anchorWorld = c; // refine the anchor as selection grows
                    lastSentAt = performance.now();
                    lastSentPose = poseAtCapture;
                } catch (err) {
                    console.error('[SAM3] track frame failed:', err);
                } finally {
                    busy = false;
                }
            })();
        };

        this.activate = () => {
            this.active = true;
            parent.style.cursor = 'crosshair';
            parent.addEventListener('pointerdown', pointerHandler, true);
            scene.app.on('update', onUpdate);
        };

        this.deactivate = () => {
            this.active = false;
            parent.style.cursor = '';
            parent.removeEventListener('pointerdown', pointerHandler, true);
            scene.app.off('update', onUpdate);
            // Leave `anchorWorld` alone so re-activation can resume. Selection
            // itself is stored in the splat state; nothing to clean up there.
        };
    }
}

export { Sam3Selection };
