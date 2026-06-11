#!/usr/bin/env node

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const groups = [];
for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--variant') continue;
    const name = args[++i];
    const paths = [];
    while (args[i + 1] && args[i + 1] !== '--variant') paths.push(args[++i]);
    if (name && paths.length) groups.push({ name, paths });
}

if (!groups.length) {
    console.error('usage: summarize-brush-variant-results.mjs --variant <name> <result.json...> [--variant <name> <result.json...>]');
    process.exit(2);
}

const finite = value => typeof value === 'number' && Number.isFinite(value);

const objectLabel = (target) => {
    if (!target?.min || !target?.max) return 'unknown';
    const dims = [0, 1, 2].map(axis => target.max[axis] - target.min[axis]);
    if (dims[0] > 4) return 'laptop';
    if (dims[1] > 1.5) return 'can';
    return 'glasses';
};

const stats = (values) => {
    const clean = values.filter(finite);
    if (!clean.length) return { n: 0, avg: 0, min: 0, max: 0 };
    return {
        n: clean.length,
        avg: clean.reduce((sum, value) => sum + value, 0) / clean.length,
        min: Math.min(...clean),
        max: Math.max(...clean)
    };
};

const fmt = value => value.toFixed(3);

for (const group of groups) {
    const rows = group.paths.flatMap(path => JSON.parse(readFileSync(path, 'utf8')));
    const ok = rows.filter(row => row?.ok !== false && row?.metrics);
    const failed = rows.length - ok.length;
    const scores = ok.map(row => row.metrics?.aabb_iou);
    const byObject = new Map();
    for (const row of ok) {
        const label = objectLabel(row.metrics?.target_aabb);
        const list = byObject.get(label) ?? [];
        list.push(row.metrics?.aabb_iou);
        byObject.set(label, list);
    }
    const samReports = ok.map(row => row.sam3_augmentation ?? row.candidate_debug?.sam3).filter(Boolean);
    const samApplied = samReports.filter(report => report.applied).length;
    const samCleanApplied = ok.filter(row => row.client_brush_probe?.brush_surface?.sam_filter?.applied).length;
    const floorReports = ok.map(row => row.client_brush_probe?.brush_surface).filter(Boolean);
    const floorWithY = floorReports.filter(report => finite(report.support_floor_y)).length;
    const floorSnap = floorReports.filter(report => report.floor_snap_applied).length;

    const all = stats(scores);
    console.log(`${group.name}: ok=${ok.length}/${rows.length} failed=${failed} avg=${fmt(all.avg)} min=${fmt(all.min)} max=${fmt(all.max)}`);
    for (const [label, values] of [...byObject.entries()].sort()) {
        const s = stats(values);
        console.log(`  ${label}: n=${s.n} avg=${fmt(s.avg)} min=${fmt(s.min)} max=${fmt(s.max)}`);
    }
    if (samReports.length) {
        console.log(`  sam: reports=${samReports.length} applied=${samApplied} sam_clean_filter_applied=${samCleanApplied}`);
    }
    if (floorReports.length) {
        console.log(`  floor: support_floor_y=${floorWithY}/${floorReports.length} floor_snap=${floorSnap}`);
    }
}
