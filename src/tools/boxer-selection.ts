import { Color, Vec3 } from 'playcanvas';

import { Events } from '../events';
import { Scene } from '../scene';
import { Splat } from '../splat';

const OBB_EDGES: [number, number][] = [
    [0, 1], [1, 2], [2, 3], [3, 0], // bottom face
    [4, 5], [5, 6], [6, 7], [7, 4], // top face
    [0, 4], [1, 5], [2, 6], [3, 7]  // vertical edges
];

const OBB_COLOR = new Color(0, 0.86, 1, 1); // cyan

const getBoxerBackendUrl = () => {
    return window.supersplatConfig?.boxerBackendUrl || 'https://boxer.4dream.app';
};

type OBBResult = {
    center: [number, number, number];
    dimensions: [number, number, number];
    rotation: number[][];
    corners: number[][];
    label: string;
    confidence: number;
    bb2d?: [number, number, number, number]; // [x_min, y_min, x_max, y_max] in image pixels
};

// Extract pinhole intrinsics from a PlayCanvas camera. Square pixels, so
// fx == fy; only the axis that `cam.fov` describes depends on `horizontalFov`.
// SuperSplat toggles horizontalFov based on viewport aspect, so we must read it.
const extractIntrinsics = (cam: any, w: number, h: number) => {
    const fovRad = (cam.fov * Math.PI) / 180;
    const f = cam.horizontalFov ?
        w / (2 * Math.tan(fovRad / 2)) :
        h / (2 * Math.tan(fovRad / 2));
    return { fx: f, fy: f, cx: w / 2, cy: h / 2, width: w, height: h };
};

// Invert view matrix (OGL world→cam) to cam→world, then flip Y,Z columns (OGL→CV).
const extractExtrinsics = (cam: any): number[] => {
    const v = cam.viewMatrix.data as Float32Array;
    const r00 = v[0], r10 = v[1], r20 = v[2];
    const r01 = v[4], r11 = v[5], r21 = v[6];
    const r02 = v[8], r12 = v[9], r22 = v[10];
    const tx = v[12], ty = v[13], tz = v[14];

    const rt00 = r00, rt01 = r10, rt02 = r20;
    const rt10 = r01, rt11 = r11, rt12 = r21;
    const rt20 = r02, rt21 = r12, rt22 = r22;
    const itx = -(rt00 * tx + rt01 * ty + rt02 * tz);
    const ity = -(rt10 * tx + rt11 * ty + rt12 * tz);
    const itz = -(rt20 * tx + rt21 * ty + rt22 * tz);

    return [
        rt00, rt10, rt20, 0,
        -rt01, -rt11, -rt21, 0,
        -rt02, -rt12, -rt22, 0,
        itx, ity, itz, 1
    ];
};

// Capture a fresh render via SuperSplat's offscreen render path (excludes overlays/gizmos).
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

// CPU z-buffer of splat centers projected through the current camera pose.
// Uses the same OpenGL→OpenCV conversion as extractExtrinsics, so the depth
// frame matches what the backend reconstructs from the extrinsics it receives.
// Depth values are camera-space +Z in OpenCV convention (positive = in front),
// in the scene's world units. 0 = invalid pixel.
type DepthBuffer = { data: Float32Array; width: number; height: number };

const renderSplatDepth = (
    splat: Splat,
    scene: Scene,
    imageWidth: number,
    imageHeight: number,
    intrinsics: { fx: number; fy: number; cx: number; cy: number }
): DepthBuffer => {
    // ~1/3 resolution preserves aspect; each Boxer 16-px patch still gets
    // dozens of depth samples for the per-patch median.
    const scale = 1 / 3;
    const width = Math.max(2, Math.round(imageWidth * scale));
    const height = Math.max(2, Math.round(imageHeight * scale));
    const fx = intrinsics.fx * (width / imageWidth);
    const fy = intrinsics.fy * (height / imageHeight);
    const cx = intrinsics.cx * (width / imageWidth);
    const cy = intrinsics.cy * (height / imageHeight);

    const sorter: any = splat.entity.gsplat?.instance?.sorter;
    if (!sorter?.centers) {
        return { data: new Float32Array(width * height), width, height };
    }
    const centers: Float32Array = sorter.centers;
    const wm = splat.entity.getWorldTransform().data as Float32Array;
    const v = scene.camera.camera.viewMatrix.data as Float32Array;

    const depth = new Float32Array(width * height);
    const INF = Number.POSITIVE_INFINITY;
    for (let i = 0; i < depth.length; i++) depth[i] = INF;

    const n = centers.length / 3;
    for (let i = 0; i < n; i++) {
        const lx = centers[i * 3];
        const ly = centers[i * 3 + 1];
        const lz = centers[i * 3 + 2];
        // splat-local → world
        const wx = wm[0] * lx + wm[4] * ly + wm[8]  * lz + wm[12];
        const wy = wm[1] * lx + wm[5] * ly + wm[9]  * lz + wm[13];
        const wz = wm[2] * lx + wm[6] * ly + wm[10] * lz + wm[14];
        // world → OpenGL camera (viewMatrix is column-major)
        const ogX = v[0] * wx + v[4] * wy + v[8]  * wz + v[12];
        const ogY = v[1] * wx + v[5] * wy + v[9]  * wz + v[13];
        const ogZ = v[2] * wx + v[6] * wy + v[10] * wz + v[14];
        // OpenGL → OpenCV: negate Y, Z in camera frame
        const cvX = ogX;
        const cvY = -ogY;
        const cvZ = -ogZ;
        if (cvZ <= 0) continue; // behind camera
        // pinhole projection in OpenCV convention
        const u = Math.round(fx * cvX / cvZ + cx);
        const vp = Math.round(fy * cvY / cvZ + cy);
        if (u < 0 || u >= width || vp < 0 || vp >= height) continue;
        const idx = vp * width + u;
        if (cvZ < depth[idx]) depth[idx] = cvZ;
    }

    // 0 marks invalid for the backend (sdp_from_depth filters zz > 0).
    for (let i = 0; i < depth.length; i++) if (!isFinite(depth[i])) depth[i] = 0;

    return { data: depth, width, height };
};

// Subsample splat world-space centers inside the current view frustum. Sent
// alongside the depth map so BoxerNet's sdp_w has both per-pixel surface depth
// (from the z-buffer) and sparse interior/occluded points (from the splat cloud).
const sampleSplatCentersInFrustum = (
    splat: Splat,
    scene: Scene,
    target = 50000
): number[][] => {
    const sorter: any = splat.entity.gsplat?.instance?.sorter;
    if (!sorter?.centers) return [];
    const centers: Float32Array = sorter.centers;
    const wm = splat.entity.getWorldTransform().data as Float32Array;

    const cam = scene.camera.camera;
    const p = cam.projectionMatrix.data as Float32Array;
    const v = cam.viewMatrix.data as Float32Array;
    const vp = new Float32Array(16);
    for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
            vp[i + j * 4] =
                p[i]      * v[j * 4] +
                p[i + 4]  * v[j * 4 + 1] +
                p[i + 8]  * v[j * 4 + 2] +
                p[i + 12] * v[j * 4 + 3];
        }
    }

    const n = centers.length / 3;
    const kept: number[][] = [];
    for (let i = 0; i < n; i++) {
        const lx = centers[i * 3], ly = centers[i * 3 + 1], lz = centers[i * 3 + 2];
        const wx = wm[0] * lx + wm[4] * ly + wm[8]  * lz + wm[12];
        const wy = wm[1] * lx + wm[5] * ly + wm[9]  * lz + wm[13];
        const wz = wm[2] * lx + wm[6] * ly + wm[10] * lz + wm[14];
        const cx = vp[0] * wx + vp[4] * wy + vp[8]  * wz + vp[12];
        const cy = vp[1] * wx + vp[5] * wy + vp[9]  * wz + vp[13];
        const cw = vp[3] * wx + vp[7] * wy + vp[11] * wz + vp[15];
        if (cw <= 0) continue;
        const ndcX = cx / cw, ndcY = cy / cw;
        if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) continue;
        kept.push([wx, wy, wz]);
    }
    if (kept.length <= target) return kept;
    const stride = kept.length / target;
    const out: number[][] = new Array(target);
    for (let i = 0; i < target; i++) out[i] = kept[Math.floor(i * stride)];
    return out;
};

const float32ToBase64 = (arr: Float32Array): string => {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
    }
    return btoa(binary);
};

class BoxerSelection {
    activate: () => void;
    deactivate: () => void;
    active = false;

    constructor(events: Events, scene: Scene, parent: HTMLElement) {
        const canvas = scene.canvas;
        let busy = false;
        let currentCorners: Vec3[] | null = null;

        // SVG overlay for the 2D detection bbox (sanity check).
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.style.position = 'absolute';
        svg.style.top = '0';
        svg.style.left = '0';
        svg.style.width = '100%';
        svg.style.height = '100%';
        svg.style.pointerEvents = 'none';
        svg.style.display = 'none';
        svg.setAttribute('preserveAspectRatio', 'none');
        const svgRect = document.createElementNS(svg.namespaceURI, 'rect') as SVGRectElement;
        svgRect.setAttribute('fill', 'none');
        svgRect.setAttribute('stroke', '#ff7f00');
        svgRect.setAttribute('stroke-width', '2');
        svgRect.setAttribute('stroke-dasharray', '6 4');
        svg.appendChild(svgRect);
        const svgText = document.createElementNS(svg.namespaceURI, 'text') as SVGTextElement;
        svgText.setAttribute('fill', '#ff7f00');
        svgText.setAttribute('font-family', 'monospace');
        svgText.setAttribute('font-size', '12');
        svg.appendChild(svgText);
        parent.appendChild(svg);

        const show2DBox = (bb: [number, number, number, number], label: string) => {
            const [x0, y0, x1, y1] = bb;
            const rect = canvas.getBoundingClientRect();
            const parentRect = parent.getBoundingClientRect();
            // canvas may not fill parent (e.g. toolbar above); offset accordingly
            const ox = rect.left - parentRect.left;
            const oy = rect.top - parentRect.top;
            svg.setAttribute('viewBox', `0 0 ${parent.clientWidth} ${parent.clientHeight}`);
            svg.style.display = '';
            svgRect.setAttribute('x', String(ox + x0));
            svgRect.setAttribute('y', String(oy + y0));
            svgRect.setAttribute('width', String(Math.max(1, x1 - x0)));
            svgRect.setAttribute('height', String(Math.max(1, y1 - y0)));
            svgText.setAttribute('x', String(ox + x0 + 4));
            svgText.setAttribute('y', String(oy + Math.max(14, y0 - 4)));
            svgText.textContent = label;
        };
        const hide2DBox = () => {
            svg.style.display = 'none';
        };

        // Draw the OBB wireframe every frame while it is set.
        // WebGL gl.lineWidth is capped at 1, so fake thickness by offsetting
        // each edge along camera-relative right/up axes and redrawing.
        const thickOffsets: [number, number][] = [
            [0, 0],
            [1, 0], [-1, 0], [0, 1], [0, -1],
            [1, 1], [-1, 1], [1, -1], [-1, -1]
        ];
        const tmpA = new Vec3();
        const tmpB = new Vec3();
        const right = new Vec3();
        const up = new Vec3();

        scene.app.on('update', () => {
            if (!currentCorners) return;

            const camTransform = scene.camera.mainCamera.getWorldTransform();
            camTransform.getX(right);
            camTransform.getY(up);

            // world-space thickness ≈ 0.3% of nearest edge length, min 5 mm
            const dx = currentCorners[0].distance(currentCorners[1]);
            const t = Math.max(0.005, dx * 0.02);

            for (const [ox, oy] of thickOffsets) {
                const offX = right.x * ox * t + up.x * oy * t;
                const offY = right.y * ox * t + up.y * oy * t;
                const offZ = right.z * ox * t + up.z * oy * t;
                for (const [a, b] of OBB_EDGES) {
                    tmpA.set(
                        currentCorners[a].x + offX,
                        currentCorners[a].y + offY,
                        currentCorners[a].z + offZ
                    );
                    tmpB.set(
                        currentCorners[b].x + offX,
                        currentCorners[b].y + offY,
                        currentCorners[b].z + offZ
                    );
                    scene.app.drawLine(tmpA, tmpB, OBB_COLOR, true, scene.worldLayer);
                }
            }
            scene.forceRender = true;
        });

        const handler = async (e: PointerEvent) => {
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
                console.warn('[Boxer] No splat selected');
                events.fire('toast', 'No splat loaded', 'warning');
                return;
            }

            const rect = canvas.getBoundingClientRect();
            const clickX = Math.round(e.clientX - rect.left);
            const clickY = Math.round(e.clientY - rect.top);

            busy = true;
            parent.style.cursor = 'wait';

            try {
                const cam = scene.camera.camera;
                const w = canvas.clientWidth;
                const h = canvas.clientHeight;
                const b64 = await captureScene(events, w, h);
                const intrinsics = extractIntrinsics(cam, w, h);
                const extrinsics = extractExtrinsics(cam);

                const t0 = performance.now();
                const depth = renderSplatDepth(splat, scene, w, h, intrinsics);
                const depthB64 = float32ToBase64(depth.data);
                const validPx = depth.data.reduce((n, d) => n + (d > 0 ? 1 : 0), 0);
                console.log(`[Boxer] click=(${clickX},${clickY}) depth=${depth.width}x${depth.height}` +
                    ` valid=${validPx}/${depth.data.length}` +
                    ` (${(performance.now() - t0).toFixed(0)}ms)`);

                // DEBUG: confirm splat entity global rotation is captured, and
                // print depth at the click pixel + camera distance to the clicked splat.
                {
                    const wm = splat.entity.getWorldTransform().data as Float32Array;
                    const e = splat.entity.getLocalEulerAngles();
                    const sampleIdx = Math.floor(splat.numSplats / 2);
                    const sorter: any = splat.entity.gsplat?.instance?.sorter;
                    const c = sorter?.centers as Float32Array | undefined;
                    const lx = c ? c[sampleIdx * 3] : 0;
                    const ly = c ? c[sampleIdx * 3 + 1] : 0;
                    const lz = c ? c[sampleIdx * 3 + 2] : 0;
                    const wx = wm[0] * lx + wm[4] * ly + wm[8]  * lz + wm[12];
                    const wy = wm[1] * lx + wm[5] * ly + wm[9]  * lz + wm[13];
                    const wz = wm[2] * lx + wm[6] * ly + wm[10] * lz + wm[14];
                    const sx = clickX * depth.width / w;
                    const sy = clickY * depth.height / h;
                    const d = depth.data[Math.round(sy) * depth.width + Math.round(sx)];
                    console.log(
                        `[Boxer] splat euler=(${e.x.toFixed(1)},${e.y.toFixed(1)},${e.z.toFixed(1)})` +
                        ` sample local=(${lx.toFixed(2)},${ly.toFixed(2)},${lz.toFixed(2)})` +
                        ` world=(${wx.toFixed(2)},${wy.toFixed(2)},${wz.toFixed(2)})` +
                        ` depth@click=${d.toFixed(3)}`
                    );
                }

                const boxerBackendUrl = getBoxerBackendUrl();
                const res = await fetch(`${boxerBackendUrl}/api/boxer-detect`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        image: b64,
                        click_xy: [clickX, clickY],
                        intrinsics,
                        extrinsics,
                        gravity: [0, -1, 0],
                        depth: depthB64,
                        depth_width: depth.width,
                        depth_height: depth.height
                    })
                });

                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    console.error(`[Boxer] ${res.status}: ${err.error || res.statusText}`);
                    events.fire('toast', 'Boxer backend error', 'error');
                    return;
                }

                const obb = await res.json() as OBBResult;
                console.log(`[Boxer] ${obb.label} (${(obb.confidence * 100).toFixed(0)}%) dims=${obb.dimensions.map(d => d.toFixed(2)).join(',')}`);

                if (obb.bb2d) {
                    show2DBox(obb.bb2d, `${obb.label} ${(obb.confidence * 100).toFixed(0)}%`);
                }

                // DEBUG: dump OBB rotation rows and which world axis each OBB-local axis points to.
                // The axis with the largest dimension should map to world +Y (up in PlayCanvas).
                {
                    const R = obb.rotation;
                    const axes = ['X', 'Y', 'Z'];
                    const fmt = (v: number) => (v >= 0 ? ' ' : '') + v.toFixed(2);
                    console.log(`[Boxer] R row0=(${fmt(R[0][0])},${fmt(R[0][1])},${fmt(R[0][2])})`);
                    console.log(`[Boxer] R row1=(${fmt(R[1][0])},${fmt(R[1][1])},${fmt(R[1][2])})`);
                    console.log(`[Boxer] R row2=(${fmt(R[2][0])},${fmt(R[2][1])},${fmt(R[2][2])})`);
                    for (let j = 0; j < 3; j++) {
                        // column j of R = OBB's local j-axis expressed in world coords
                        const cx_ = R[0][j], cy_ = R[1][j], cz_ = R[2][j];
                        const absV = [Math.abs(cx_), Math.abs(cy_), Math.abs(cz_)];
                        const dom = absV.indexOf(Math.max(...absV));
                        console.log(`[Boxer] OBB local ${axes[j]} (len=${obb.dimensions[j].toFixed(2)}) -> world (${fmt(cx_)},${fmt(cy_)},${fmt(cz_)}) ≈ ${R[dom][j] > 0 ? '+' : '-'}${axes[dom]}`);
                    }
                }

                // DEBUG: project the returned OBB center back to 2D with the
                // SAME intrinsics/extrinsics we sent. Landing near the click
                // proves the camera frame round-trips correctly.
                {
                    const e = extrinsics;
                    // world-to-OCV-camera = inverse of OCV cam-to-world
                    // rotation part (columns 0..2 of e), t = column 3
                    // For rigid: inv = [R^T | -R^T*t]
                    const r00 = e[0], r10 = e[1], r20 = e[2];
                    const r01 = e[4], r11 = e[5], r21 = e[6];
                    const r02 = e[8], r12 = e[9], r22 = e[10];
                    const tx = e[12], ty = e[13], tz = e[14];
                    const cx_w = obb.center[0], cy_w = obb.center[1], cz_w = obb.center[2];
                    // cam-space = R^T * (world - t)
                    const wx = cx_w - tx, wy = cy_w - ty, wz = cz_w - tz;
                    const xc = r00 * wx + r10 * wy + r20 * wz;
                    const yc = r01 * wx + r11 * wy + r21 * wz;
                    const zc = r02 * wx + r12 * wy + r22 * wz;
                    const u = intrinsics.fx * xc / zc + intrinsics.cx;
                    const v_px = intrinsics.fy * yc / zc + intrinsics.cy;
                    console.log(
                        `[Boxer] OBB center world=(${cx_w.toFixed(2)},${cy_w.toFixed(2)},${cz_w.toFixed(2)})` +
                        ` cam_ocv=(${xc.toFixed(2)},${yc.toFixed(2)},${zc.toFixed(2)})` +
                        ` reprojected=(${u.toFixed(0)},${v_px.toFixed(0)}) click=(${clickX},${clickY})`
                    );

                    // Snap OBB along the camera ray to the actual splat surface.
                    // Sample depth using a median kernel to handle 1/3-res depth buffer.
                    const sampleDepthArea = (imgU: number, imgV: number, radius = 2) => {
                        const du = Math.round(imgU * depth.width / w);
                        const dv = Math.round(imgV * depth.height / h);
                        const values: number[] = [];
                        for (let dy = -radius; dy <= radius; dy++) {
                            for (let dx = -radius; dx <= radius; dx++) {
                                const px = du + dx;
                                const py = dv + dy;
                                if (px >= 0 && px < depth.width && py >= 0 && py < depth.height) {
                                    const d = depth.data[py * depth.width + px];
                                    if (d > 0) values.push(d);
                                }
                            }
                        }
                        if (values.length === 0) return 0;
                        values.sort((a, b) => a - b);
                        return values[Math.floor(values.length / 2)];
                    };
                    let surfaceDepth = sampleDepthArea(u, v_px);
                    if (!(surfaceDepth > 0)) surfaceDepth = sampleDepthArea(clickX, clickY);

                    if (surfaceDepth > 0 && zc > 0) {
                        // Cap snap distance to 2x OBB diagonal to reject absurd shifts
                        const obbDiag = Math.sqrt(
                            obb.dimensions[0] ** 2 + obb.dimensions[1] ** 2 + obb.dimensions[2] ** 2
                        );
                        const maxSnap = Math.max(obbDiag * 2, 1.0);
                        const shift = surfaceDepth - zc;

                        if (Math.abs(shift) > maxSnap) {
                            console.warn(
                                `[Boxer] snap: shift ${shift.toFixed(2)}m exceeds max ${maxSnap.toFixed(2)}m; skipping snap`
                            );
                        } else {
                            // Translate along the camera ray (not the forward axis)
                            // to preserve the OBB's screen-space position.
                            const camX = tx, camY = ty, camZ = tz;
                            const ratio = surfaceDepth / zc;
                            const newCx = camX + (cx_w - camX) * ratio;
                            const newCy = camY + (cy_w - camY) * ratio;
                            const newCz = camZ + (cz_w - camZ) * ratio;
                            const dx = newCx - cx_w;
                            const dy = newCy - cy_w;
                            const dz = newCz - cz_w;
                            obb.center = [newCx, newCy, newCz];
                            obb.corners = obb.corners.map(c => [c[0] + dx, c[1] + dy, c[2] + dz]);
                            console.log(
                                `[Boxer] snap: obb_depth=${zc.toFixed(2)}m -> splat_depth=${surfaceDepth.toFixed(2)}m` +
                                ` shift=${shift.toFixed(2)}m ratio=${ratio.toFixed(3)}`
                            );
                        }
                    } else {
                        console.warn('[Boxer] snap: no valid splat depth near OBB; leaving OBB where Boxer placed it.');
                        events.fire('toast', 'Could not snap box to surface', 'warning');
                    }
                }

                currentCorners = obb.corners.map(c => new Vec3(c[0], c[1], c[2]));
                scene.forceRender = true;

                events.fire('select.byOBB', 'set', obb);
            } catch (err) {
                console.error('[Boxer] Request failed:', err);
                events.fire('toast', 'Boxer request failed', 'error');
            } finally {
                busy = false;
                parent.style.cursor = '';
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
            parent.style.cursor = 'wait';

            try {
                const cam = scene.camera.camera;
                const w = canvas.clientWidth;
                const h = canvas.clientHeight;
                const b64 = await captureScene(events, w, h);
                const intrinsics = extractIntrinsics(cam, w, h);
                const extrinsics = extractExtrinsics(cam);

                const depth = renderSplatDepth(splat, scene, w, h, intrinsics);
                const depthB64 = float32ToBase64(depth.data);

                console.log(`[Boxer] text="${text}"`);
                const boxerBackendUrl = getBoxerBackendUrl();
                const res = await fetch(`${boxerBackendUrl}/api/boxer-detect`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        image: b64,
                        text,
                        intrinsics,
                        extrinsics,
                        gravity: [0, -1, 0],
                        depth: depthB64,
                        depth_width: depth.width,
                        depth_height: depth.height
                    })
                });

                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    console.error(`[Boxer] text ${res.status}: ${err.error || res.statusText}`);
                    events.fire('toast', 'Boxer backend error', 'error');
                    return;
                }

                const obb = await res.json() as OBBResult;
                console.log(`[Boxer] text: ${obb.label} (${(obb.confidence * 100).toFixed(0)}%) dims=${obb.dimensions.map(d => d.toFixed(2)).join(',')}`);

                if (obb.bb2d) {
                    show2DBox(obb.bb2d, `${obb.label} ${(obb.confidence * 100).toFixed(0)}%`);
                }

                currentCorners = obb.corners.map(c => new Vec3(c[0], c[1], c[2]));
                scene.forceRender = true;
                events.fire('select.byOBB', 'set', obb);
            } catch (err) {
                console.error('[Boxer] Text request failed:', err);
                events.fire('toast', 'Boxer text request failed', 'error');
            } finally {
                busy = false;
                parent.style.cursor = '';
            }
        };

        this.activate = () => {
            this.active = true;
            parent.style.cursor = 'crosshair';
            parent.addEventListener('pointerdown', handler, true);
            events.on('ai.textQuery', textHandler);
        };

        this.deactivate = () => {
            this.active = false;
            parent.style.cursor = '';
            parent.removeEventListener('pointerdown', handler, true);
            events.off('ai.textQuery', textHandler);
            currentCorners = null;
            hide2DBox();
            scene.forceRender = true;
        };
    }
}

export { BoxerSelection };
