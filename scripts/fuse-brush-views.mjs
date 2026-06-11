#!/usr/bin/env node
// Multi-view brush fusion: combine per-case client_brush replay outputs for
// the SAME object (same target box) into one fused 3D box.
//
//   node scripts/fuse-brush-views.mjs --results out1.json out2.json \
//       --fixtures scripts/boxer-evals/live-brush-evals.jsonl scripts/boxer-evals/desk-can-brush-human-v1.json
//
// Method (calibrated 2026-06-11 on the human-verified desk suite):
//  - consensus: voxelize each view's brush_surface support sample (0.08),
//    keep voxels seen by >=60% of views, box the survivors at the 2/98
//    quantiles. Removes per-view tube bleed (desk next to the can) because
//    bleed differs per stroke while the object is in every tube.
//  - surf/tight: per axis, among views where the axis is screen-parallel
//    (weight 1-|forward.axis| >= 0.45), take the tightest extent of the
//    per-view brush_surface boxes. Wins when strokes from different views
//    cover DIFFERENT parts of a large object (laptop) and consensus would
//    erase single-view regions.
//  - gate: cross-view overlap ratio (consensus voxels / median per-view
//    voxels) >= 0.55 -> consensus, else surf/tight.
//
// Verified desk suite results: laptop 0.887, can 0.849, glasses 0.709
// (avg 0.815) vs single-view oracle ceiling ~0.66.

import { readFileSync } from 'node:fs';

const VOX = 0.08;
const CONSENSUS_FRACTION = 0.6;
const GATE_RATIO = 0.55;
const ALIGN_WEIGHT_MIN = 0.45;
const QUANTILES = [0.02, 0.98];

const args = process.argv.slice(2);
const lists = { results: [], fixtures: [] };
let bucket = null;
for (const arg of args) {
    if (arg === '--results') bucket = 'results';
    else if (arg === '--fixtures') bucket = 'fixtures';
    else if (bucket) lists[bucket].push(arg);
}
if (!lists.results.length || !lists.fixtures.length) {
    console.error('usage: fuse-brush-views.mjs --results <replay out json...> --fixtures <fixture json/jsonl...>');
    process.exit(1);
}

const loadFixture = (path) => {
    const text = readFileSync(path, 'utf8');
    if (path.endsWith('.jsonl')) {
        return text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
    }
    return JSON.parse(text);
};

const rows = [];
for (let f = 0; f < lists.results.length; f++) {
    const results = JSON.parse(readFileSync(lists.results[f], 'utf8'));
    const fixture = loadFixture(lists.fixtures[f]);
    results.forEach((c, i) => {
        if (!c || !c.metrics) return;
        const probe = c.client_brush_probe ?? {};
        const surface = probe.brush_surface ?? {};
        const sample = surface.support_sample ?? [];
        const pts = [];
        for (let j = 0; j + 2 < sample.length; j += 3) pts.push([sample[j], sample[j + 1], sample[j + 2]]);
        let surfBox = null;
        for (const cand of probe.candidates ?? []) {
            if (cand.source === 'brush_surface' && cand.predicted_aabb) { surfBox = cand.predicted_aabb; break; }
        }
        const ext = fixture[i]?.frame?.extrinsics;
        rows.push({
            tgt: c.metrics.target_aabb,
            key: JSON.stringify(c.metrics.target_aabb),
            pts,
            surf: surfBox,
            fwd: ext ? [ext[8], ext[9], ext[10]] : null,
            selIou: c.metrics.aabb_iou
        });
    });
}

const groups = new Map();
for (const r of rows) {
    if (!groups.has(r.key)) groups.set(r.key, []);
    groups.get(r.key).push(r);
}

const iou = (a, b) => {
    let inter = 1, va = 1, vb = 1;
    for (let i = 0; i < 3; i++) {
        const lo = Math.max(a.min[i], b.min[i]);
        const hi = Math.min(a.max[i], b.max[i]);
        if (hi <= lo) { inter = 0; break; }
        inter *= hi - lo;
    }
    for (let i = 0; i < 3; i++) {
        va *= a.max[i] - a.min[i];
        vb *= b.max[i] - b.min[i];
    }
    return va + vb - inter > 0 ? inter / (va + vb - inter) : 0;
};

const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
};

const consensus = (cases) => {
    const counts = new Map();
    const perView = [];
    for (const c of cases) {
        const voxels = new Set(c.pts.map(p => `${Math.round(p[0] / VOX)},${Math.round(p[1] / VOX)},${Math.round(p[2] / VOX)}`));
        perView.push(voxels.size);
        for (const v of voxels) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const k = Math.max(2, Math.ceil(cases.length * CONSENSUS_FRACTION));
    const keep = [...counts.entries()].filter(([, n]) => n >= k).map(([v]) => v.split(',').map(Number));
    const ratio = keep.length / Math.max(1, median(perView));
    if (keep.length < 10) return { box: null, ratio };
    const lo = [], hi = [];
    for (let ax = 0; ax < 3; ax++) {
        const vals = keep.map(v => v[ax] * VOX).sort((a, b) => a - b);
        const n = vals.length;
        lo.push(vals[Math.max(0, Math.floor(n * QUANTILES[0]))] - VOX / 2);
        hi.push(vals[Math.min(n - 1, Math.floor(n * QUANTILES[1]))] + VOX / 2);
    }
    return { box: { min: lo, max: hi }, ratio };
};

const surfTight = (cases) => {
    const lo = [0, 0, 0], hi = [0, 0, 0];
    for (let ax = 0; ax < 3; ax++) {
        const entries = [];
        for (const c of cases) {
            if (!c.surf || !c.fwd) continue;
            entries.push({ w: 1 - Math.abs(c.fwd[ax]), mn: c.surf.min[ax], mx: c.surf.max[ax] });
        }
        if (!entries.length) return null;
        entries.sort((a, b) => b.w - a.w);
        const aligned = entries.filter(e => e.w >= ALIGN_WEIGHT_MIN);
        const pool = aligned.length ? aligned : [entries[0]];
        const sel = pool.reduce((best, e) => ((e.mx - e.mn) < (best.mx - best.mn) ? e : best));
        lo[ax] = sel.mn;
        hi[ax] = sel.mx;
    }
    return { min: lo, max: hi };
};

let total = 0, count = 0;
for (const [, cases] of groups) {
    const { box: cBox, ratio } = consensus(cases);
    const sBox = surfTight(cases);
    const chosen = (cBox && ratio >= GATE_RATIO) ? cBox : sBox;
    const method = (cBox && ratio >= GATE_RATIO) ? 'consensus' : 'surf-tight';
    const tgt = cases[0].tgt;
    const dims = [0, 1, 2].map(i => (tgt.max[i] - tgt.min[i]).toFixed(2));
    const score = chosen ? iou(chosen, tgt) : 0;
    const singleAvg = cases.reduce((s, c) => s + c.selIou, 0) / cases.length;
    console.log(`object dims=[${dims}] views=${cases.length} method=${method} overlap=${ratio.toFixed(2)} fused_iou=${score.toFixed(3)} (single-view avg ${singleAvg.toFixed(3)})`);
    total += score;
    count += 1;
}
console.log(`fused avg over ${count} objects: ${(total / count).toFixed(3)}`);
