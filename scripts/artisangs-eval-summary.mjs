#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const files = [];
let json = false;

const usage = () => {
    console.log('Usage: node scripts/artisangs-eval-summary.mjs [--json] <eval-suite-or-eval.json...>');
};

const resolveInputPath = (value) => {
    const windowsMatch = /^([A-Za-z]):[\\/](.*)$/.exec(value);
    if (windowsMatch) {
        const drive = windowsMatch[1].toLowerCase();
        const rest = windowsMatch[2].replaceAll('\\', '/');
        return `/mnt/${drive}/${rest}`;
    }
    return path.resolve(value);
};

for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
        json = true;
    } else if (arg === '--help' || arg === '-h') {
        usage();
        process.exit(0);
    } else {
        files.push(resolveInputPath(arg));
    }
}

if (files.length === 0) {
    usage();
    process.exit(1);
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

const round = (value) => Number.isFinite(value) ? Number(value.toFixed(4)) : null;

const metricSummary = (metrics, key) => {
    const item = metrics?.selection_summaries?.[key] ?? metrics?.selections?.[key] ?? null;
    if (!item) {
        return null;
    }
    return {
        selected: item.selected_count ?? null,
        inside: item.selected_inside_target_count ?? null,
        target: item.target_inside_count ?? null,
        precision: round(item.precision),
        recall: round(item.target_recall),
        pass: item.pass === true
    };
};

const seedTiming = (data) => data?.seed_fixture?.seed_timing ??
    data?.local_result?.seed_timing ??
    data?.review?.seed_timing ??
    null;

const localTimings = (data) => data?.local_result?.timings ?? {};

const seedResult = (data) => data?.seed_fixture?.seed_result ??
    data?.review?.seed_result ??
    null;

const evalMetrics = (data) => data?.eval_metrics ??
    data?.baseline?.metrics ??
    data?.eval_case?.baseline?.metrics ??
    null;

const evalTarget = (data) => data?.eval_target ??
    data?.eval_case?.target ??
    data?.target ??
    null;

const summarize = (file, index, baseline) => {
    const data = readJson(file);
    const seed = seedTiming(data);
    const seedProjection = seedResult(data);
    const timings = localTimings(data);
    const metrics = evalMetrics(data);
    const target = evalTarget(data);
    const clickToMaskMs = seed?.click_to_mask_ms ?? timings?.seed?.duration_ms ?? null;
    const totalMs = timings?.total?.duration_ms ?? seed?.total_ms ?? null;

    return {
        file,
        name: path.basename(file),
        run_id: data.run_id ?? data.eval_case?.run_id ?? null,
        captured_at: data.captured_at ?? null,
        schema: data.schema ?? null,
        kind: data.kind ?? null,
        preset: data.click_config?.presetId ?? null,
        frame_count: data.click_config?.frameCount ?? null,
        candidate_checks: data.click_config?.candidateCheckBudget ?? null,
        accepted_masks: data.local_result?.accepted_mask_count ?? null,
        target_source: target?.source ?? data.target_source ?? null,
        target_ready: target?.ready ?? data.real_eval_target_ready ?? null,
        target_synthetic: target?.synthetic ?? data.target_synthetic ?? null,
        target_inside_count: metrics?.target_inside_count ?? null,
        real_eval_target_ready: data.real_eval_target_ready ?? null,
        seed_capture_width: seed?.capture_width ?? null,
        seed_capture_height: seed?.capture_height ?? null,
        seed_prompt_points: seed?.seed_prompt_point_count ?? null,
        seed_prompt_positive: seed?.seed_prompt_positive_count ?? null,
        seed_prompt_negative: seed?.seed_prompt_negative_count ?? null,
        seed_mask_pixels: seed?.mask_component_area ?? null,
        seed_mask_original_pixels: seed?.mask_component_original_area ?? null,
        seed_mask_bbox: seed?.mask_component_bbox ? JSON.stringify(seed.mask_component_bbox) : null,
        seed_mask_area_ratio: round(seedProjection?.maskAreaRatio),
        seed_selected_count: seedProjection?.selectedCount ?? null,
        seed_projected_count: seedProjection?.projectedCandidateCount ?? null,
        seed_surface_count: seedProjection?.surfaceCandidateCount ?? null,
        seed_full_mask_projected_count: seedProjection?.seedMask?.selectedCount ?? null,
        seed_click_to_mask_ms: clickToMaskMs,
        delta_click_to_mask_ms: index > 0 && Number.isFinite(clickToMaskMs) && Number.isFinite(baseline?.seed_click_to_mask_ms) ?
            clickToMaskMs - baseline.seed_click_to_mask_ms :
            null,
        seed_capture_ms: seed?.capture_ms ?? null,
        seed_backend_ms: seed?.backend_ms ?? seed?.sam3_total_ms ?? null,
        seed_apply_ms: seed?.apply_ms ?? null,
        seed_review_ms: seed?.seed_review_ms ?? null,
        local_total_ms: totalMs,
        local_capture_ms: timings?.capture?.duration_ms ?? null,
        local_track_ms: timings?.track?.duration_ms ?? null,
        local_aggregate_ms: timings?.aggregate?.duration_ms ?? null,
        local_apply_ms: timings?.apply?.duration_ms ?? null,
        object_selected: metricSummary(metrics, 'object_selected'),
        editor_state: metricSummary(metrics, 'editor_state'),
        target_volume: metricSummary(metrics, 'target_volume'),
        target_bounded_posterior: metricSummary(metrics, 'target_bounded_posterior')
    };
};

const rows = [];
for (const file of files) {
    if (!fs.existsSync(file)) {
        console.error(`Missing file: ${file}`);
        process.exit(1);
    }
    const baseline = rows[0] ?? null;
    rows.push(summarize(file, rows.length, baseline));
}

if (json) {
    console.log(JSON.stringify(rows, null, 2));
    process.exit(0);
}

const formatMetric = (metric) => {
    if (!metric) {
        return '';
    }
    return `${metric.precision ?? '-'}p/${metric.recall ?? '-'}r/${metric.selected ?? '-'}sel/${metric.target ?? '-'}target/${metric.pass ? 'pass' : 'fail'}`;
};

const columns = [
    'name',
    'run_id',
    'target_source',
    'target_ready',
    'target_synthetic',
    'target_inside_count',
    'frame_count',
    'candidate_checks',
    'seed_capture_width',
    'seed_capture_height',
    'seed_prompt_points',
    'seed_prompt_positive',
    'seed_prompt_negative',
    'seed_mask_pixels',
    'seed_mask_bbox',
    'seed_mask_area_ratio',
    'seed_selected_count',
    'seed_projected_count',
    'seed_surface_count',
    'seed_full_mask_projected_count',
    'seed_click_to_mask_ms',
    'delta_click_to_mask_ms',
    'seed_capture_ms',
    'seed_backend_ms',
    'seed_apply_ms',
    'seed_review_ms',
    'local_total_ms',
    'local_capture_ms',
    'local_track_ms',
    'accepted_masks',
    'object_selected',
    'editor_state',
    'target_volume'
];

console.log(columns.join('\t'));
for (const row of rows) {
    console.log(columns.map((column) => {
        const value = row[column];
        if (column === 'object_selected' || column === 'editor_state' || column === 'target_volume') {
            return formatMetric(value);
        }
        return value ?? '';
    }).join('\t'));
}
