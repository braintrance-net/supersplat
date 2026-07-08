#!/usr/bin/env node

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const options = { support: [], modelDir: null };
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--support-results') {
        while (args[i + 1] && !args[i + 1].startsWith('--')) options.support.push(args[++i]);
    } else if (args[i] === '--model-dir') {
        options.modelDir = args[++i];
    }
}

if (options.support.length !== 2 || !options.modelDir) {
    console.error('usage: analyze-boxnet-coverage-placement.mjs --support-results <live.json> <human.json> --model-dir <dir-with-live-0.json...>');
    process.exit(2);
}

const iou = (a, b) => {
    let inter = 1, va = 1, vb = 1;
    for (let axis = 0; axis < 3; axis++) {
        const lo = Math.max(a.min[axis], b.min[axis]);
        const hi = Math.min(a.max[axis], b.max[axis]);
        if (hi <= lo) { inter = 0; break; }
        inter *= hi - lo;
        va *= a.max[axis] - a.min[axis];
        vb *= b.max[axis] - b.min[axis];
    }
    return va + vb - inter > 0 ? inter / (va + vb - inter) : 0;
};

const aabbFromCorners = (corners) => ({
    min: [0, 1, 2].map(axis => Math.min(...corners.map(point => point[axis]))),
    max: [0, 1, 2].map(axis => Math.max(...corners.map(point => point[axis])))
});

const aabbFromCenterDimensions = (center, dimensions) => ({
    min: center.map((value, axis) => value - dimensions[axis] / 2),
    max: center.map((value, axis) => value + dimensions[axis] / 2)
});

const objectLabel = (target) => {
    const dims = [0, 1, 2].map(axis => target.max[axis] - target.min[axis]);
    if (dims[0] > 4) return 'laptop';
    if (dims[1] > 1.5) return 'can';
    return 'glasses';
};

const coveragePlace = (modelAabb, points) => {
    if (!modelAabb || points.length < 8) return null;
    const dims = [0, 1, 2].map(axis => modelAabb.max[axis] - modelAabb.min[axis]);
    const sorted = [0, 1, 2].map(axis => points.map(point => point[axis]).sort((a, b) => a - b));
    const n = points.length;
    const center = [0, 1, 2].map(axis => (
        sorted[axis][Math.floor(n * 0.05)] + sorted[axis][Math.floor(n * 0.95)]
    ) / 2);
    let bestCenter = center;
    let bestCoverage = -1;
    const score = (candidateCenter) => {
        const lo = candidateCenter.map((value, axis) => value - dims[axis] / 2);
        const hi = candidateCenter.map((value, axis) => value + dims[axis] / 2);
        return points.filter(point => point.every((value, axis) => value >= lo[axis] && value <= hi[axis])).length;
    };
    for (let step = 0.12; step >= 0.03; step /= 2) {
        let improved = true;
        while (improved) {
            improved = false;
            const current = score(bestCenter);
            if (current > bestCoverage) bestCoverage = current;
            for (let axis = 0; axis < 3; axis++) {
                for (const sign of [-1, 1]) {
                    const candidate = [...bestCenter];
                    candidate[axis] += sign * step;
                    const coverage = score(candidate);
                    if (coverage > bestCoverage) {
                        bestCenter = candidate;
                        bestCoverage = coverage;
                        improved = true;
                    }
                }
            }
        }
    }
    return {
        min: bestCenter.map((value, axis) => value - dims[axis] / 2),
        max: bestCenter.map((value, axis) => value + dims[axis] / 2)
    };
};

const supportRows = [];
for (const [prefix, path] of [['live', options.support[0]], ['human', options.support[1]]]) {
    JSON.parse(readFileSync(path, 'utf8')).forEach((row, index) => supportRows.push({ prefix, index, row }));
}

const byObject = new Map();
const rows = [];
for (const item of supportRows) {
    const support = item.row.client_brush_probe?.brush_surface?.support_sample ?? [];
    const points = [];
    for (let i = 0; i + 2 < support.length; i += 3) points.push([support[i], support[i + 1], support[i + 2]]);
    let model = null;
    try {
        const modelRows = JSON.parse(readFileSync(`${options.modelDir}/${item.prefix}-${item.index}.json`, 'utf8'));
        const raw = modelRows[0]?.raw_boxer_result ?? modelRows[0]?.boxer_result?.raw_boxer_result;
        if (raw?.corners) {
            model = aabbFromCorners(raw.corners);
        } else if (Array.isArray(modelRows[0]?.raw_center) && Array.isArray(modelRows[0]?.raw_dimensions)) {
            model = aabbFromCenterDimensions(modelRows[0].raw_center, modelRows[0].raw_dimensions);
        } else if (Array.isArray(modelRows[0]?.center) && Array.isArray(modelRows[0]?.dimensions)) {
            model = aabbFromCenterDimensions(modelRows[0].center, modelRows[0].dimensions);
        }
    } catch {
        // Missing model result: counted below as failed.
    }
    if (!item.row.metrics?.target_aabb) continue;
    const placed = coveragePlace(model, points);
    const score = placed ? iou(placed, item.row.metrics.target_aabb) : null;
    const label = objectLabel(item.row.metrics.target_aabb);
    rows.push({ label, score, baseline: item.row.metrics.aabb_iou, hasModel: !!model });
    if (score !== null) {
        const list = byObject.get(label) ?? [];
        list.push(score);
        byObject.set(label, list);
    }
}

const scored = rows.filter(row => row.score !== null);
const avg = values => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
console.log(`coverage-placed model dims: avg=${avg(scored.map(row => row.score)).toFixed(3)} n=${scored.length}/${rows.length} missing_model=${rows.filter(row => !row.hasModel).length}`);
console.log(`selected baseline over same rows: avg=${avg(scored.map(row => row.baseline)).toFixed(3)}`);
for (const [label, values] of [...byObject.entries()].sort()) {
    console.log(`  ${label}: avg=${avg(values).toFixed(3)} n=${values.length}`);
}
