#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

const DEFAULT_POLICY = {
    allowed_splits: ['regression', 'holdout', 'diagnostic', 'release'],
    allowed_bench_statuses: ['known_tuned', 'known_diagnostic', 'unseen', 'demoted_holdout', 'released'],
    holdout_bench_statuses: ['unseen'],
    holdout_forbidden_tags: ['product-path', 'known-tuned', 'tuned', 'regression'],
    require_holdout_fresh_scene_or_target_group: true,
    metric_tracks: ['single_view_brush', 'live_multiview', 'fusion_offline_multiview', 'speed']
};

const usage = () => {
    console.error(`Usage: node scripts/boxer-evals/validate-eval-splits.mjs --manifest scripts/boxer-evals/eval-splits.json

Options:
  --manifest <path>       Eval split manifest to validate
  --require-holdout       Fail unless holdout contains at least --min-holdout cases
  --min-holdout <n>       Minimum holdout case count for --require-holdout (default: 1)
`);
};

const parseArgs = (argv) => {
    const args = {
        minHoldout: 1
    };
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--manifest') args.manifest = argv[++i];
        else if (arg === '--require-holdout') args.requireHoldout = true;
        else if (arg === '--min-holdout') args.minHoldout = Number(argv[++i]);
        else if (arg === '--help' || arg === '-h') {
            usage();
            process.exit(0);
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    if (!args.manifest) {
        usage();
        process.exit(2);
    }
    if (!Number.isInteger(args.minHoldout) || args.minHoldout < 0) {
        throw new Error('--min-holdout must be a non-negative integer');
    }
    return args;
};

const parseBackToBackJson = (text) => {
    const values = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') inString = true;
        else if (ch === '{' || ch === '[') {
            if (depth === 0) start = i;
            depth++;
        } else if (ch === '}' || ch === ']') {
            depth--;
            if (depth === 0 && start >= 0) {
                values.push(JSON.parse(text.slice(start, i + 1)));
                start = -1;
            }
        }
    }

    if (depth !== 0) throw new Error('Could not parse eval JSON: unbalanced braces/brackets');
    return values.flat();
};

const parseEvalCases = async (file) => {
    const text = await readFile(file, 'utf8');
    try {
        const parsed = JSON.parse(text);
        return Array.isArray(parsed) ? parsed : [parsed];
    } catch (_err) {
        const jsonl = text
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
        if (jsonl.length > 1 && jsonl.every(line => line.startsWith('{'))) {
            return jsonl.map(line => JSON.parse(line));
        }
        return parseBackToBackJson(text);
    }
};

const normalizePath = (file) => relative(process.cwd(), resolve(file)).replaceAll('\\', '/');

const caseStableId = (evalCase, index) => (
    evalCase.id ??
    evalCase.captured_at ??
    (Number.isInteger(evalCase.fixture_index) ? String(evalCase.fixture_index) : null) ??
    `case-${index + 1}`
);

const countBy = (items, keyFn) => {
    const counts = {};
    for (const item of items) {
        const key = keyFn(item);
        if (!key) continue;
        counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
};

const normalizeStringArray = (value, fallback, context, errors) => {
    if (value === undefined) return fallback;
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) {
        errors.push(`${context} must be an array of non-empty strings`);
        return fallback;
    }
    return value;
};

const manifestPolicy = (manifest, errors) => {
    const raw = manifest.policy ?? {};
    if (raw && (typeof raw !== 'object' || Array.isArray(raw))) {
        errors.push('manifest.policy must be an object when present');
        return DEFAULT_POLICY;
    }
    const freshnessPolicy = raw.require_holdout_fresh_scene_or_target_group;
    if (freshnessPolicy !== undefined && typeof freshnessPolicy !== 'boolean') {
        errors.push('policy.require_holdout_fresh_scene_or_target_group must be a boolean');
    }
    return {
        ...DEFAULT_POLICY,
        ...raw,
        allowed_splits: normalizeStringArray(raw.allowed_splits, DEFAULT_POLICY.allowed_splits, 'policy.allowed_splits', errors),
        allowed_bench_statuses: normalizeStringArray(
            raw.allowed_bench_statuses,
            DEFAULT_POLICY.allowed_bench_statuses,
            'policy.allowed_bench_statuses',
            errors
        ),
        holdout_bench_statuses: normalizeStringArray(
            raw.holdout_bench_statuses,
            DEFAULT_POLICY.holdout_bench_statuses,
            'policy.holdout_bench_statuses',
            errors
        ),
        holdout_forbidden_tags: normalizeStringArray(
            raw.holdout_forbidden_tags,
            DEFAULT_POLICY.holdout_forbidden_tags,
            'policy.holdout_forbidden_tags',
            errors
        ),
        metric_tracks: normalizeStringArray(raw.metric_tracks, DEFAULT_POLICY.metric_tracks, 'policy.metric_tracks', errors),
        require_holdout_fresh_scene_or_target_group: typeof freshnessPolicy === 'boolean' ?
            freshnessPolicy :
            DEFAULT_POLICY.require_holdout_fresh_scene_or_target_group
    };
};

const assertMetadata = (metadata, context, errors, policy) => {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        errors.push(`${context}: metadata must be an object`);
        return;
    }
    for (const field of ['split', 'suite', 'bench_status', 'scene_id', 'target_group']) {
        if (!metadata[field] || typeof metadata[field] !== 'string') {
            errors.push(`${context}: missing string ${field}`);
        }
    }
    if (!Array.isArray(metadata.tags)) {
        errors.push(`${context}: tags must be an array`);
    } else {
        const seenTags = new Set();
        for (const tag of metadata.tags) {
            if (typeof tag !== 'string' || tag.length === 0) {
                errors.push(`${context}: tags must contain only non-empty strings`);
            } else if (seenTags.has(tag)) {
                errors.push(`${context}: duplicate tag "${tag}"`);
            }
            seenTags.add(tag);
        }
    }
    if (typeof metadata.split === 'string' && !policy.allowed_splits.includes(metadata.split)) {
        errors.push(`${context}: split=${metadata.split} is not in policy.allowed_splits`);
    }
    if (typeof metadata.bench_status === 'string' && !policy.allowed_bench_statuses.includes(metadata.bench_status)) {
        errors.push(`${context}: bench_status=${metadata.bench_status} is not in policy.allowed_bench_statuses`);
    }
    if (['holdout', 'release'].includes(metadata.split) && String(metadata.bench_status).startsWith('known_')) {
        errors.push(`${context}: ${metadata.split} cannot use bench_status=${metadata.bench_status}`);
    }
    if (metadata.split === 'holdout') {
        if (!policy.holdout_bench_statuses.includes(metadata.bench_status)) {
            errors.push(`${context}: holdout bench_status must be one of ${policy.holdout_bench_statuses.join(', ')}`);
        }
        for (const tag of metadata.tags ?? []) {
            if (policy.holdout_forbidden_tags.includes(tag)) {
                errors.push(`${context}: holdout case cannot be tagged ${tag}`);
            }
        }
    }
};

const validateHoldoutFreshness = (annotated, policy, errors) => {
    if (!policy.require_holdout_fresh_scene_or_target_group) return;

    const tunedFootprints = new Set(
        annotated
        .filter(item => item.split !== 'holdout')
        .map(item => `${item.scene_id}::${item.target_group}`)
    );

    for (const item of annotated.filter(entry => entry.split === 'holdout')) {
        const footprint = `${item.scene_id}::${item.target_group}`;
        if (tunedFootprints.has(footprint)) {
            errors.push(`${item.fixture}#${item.id}: holdout must introduce a fresh scene_id or target_group; ${footprint} already exists outside holdout`);
        }
    }
};

const main = async () => {
    const args = parseArgs(process.argv);
    const manifest = JSON.parse(await readFile(args.manifest, 'utf8'));
    const errors = [];
    const warnings = [];
    const annotated = [];
    const policy = manifestPolicy(manifest, errors);

    if (manifest.schema !== 'boxer-eval-splits/v1') {
        errors.push(`unsupported manifest schema: ${manifest.schema ?? 'missing'}`);
    }
    if (!manifest.fixtures || typeof manifest.fixtures !== 'object') {
        errors.push('manifest.fixtures must be an object');
    }

    for (const [fixturePath, fixture] of Object.entries(manifest.fixtures ?? {})) {
        if (!fixture || typeof fixture !== 'object' || Array.isArray(fixture)) {
            errors.push(`${fixturePath}: fixture metadata must be an object`);
            continue;
        }
        const cases = await parseEvalCases(fixturePath);
        if (!fixture.cases || typeof fixture.cases !== 'object' || Array.isArray(fixture.cases)) {
            errors.push(`${fixturePath}: fixture.cases must be an object`);
        }
        const manifestCases = fixture.cases && typeof fixture.cases === 'object' && !Array.isArray(fixture.cases) ?
            fixture.cases :
            {};
        const seenKeys = new Set();
        const stableCaseIds = new Set();
        cases.forEach((evalCase, index) => {
            const id = caseStableId({ ...evalCase, fixture_index: index }, index);
            if (stableCaseIds.has(id)) {
                errors.push(`${fixturePath}#${id}: duplicate stable fixture id`);
            }
            stableCaseIds.add(id);
            seenKeys.add(id);
            seenKeys.add(String(index));
            const metadata = manifestCases[id] ?? manifestCases[String(index)];
            if (!metadata) {
                errors.push(`${fixturePath}#${id}: missing manifest metadata`);
                return;
            }
            assertMetadata(metadata, `${fixturePath}#${id}`, errors, policy);
            if (typeof metadata !== 'object' || Array.isArray(metadata)) {
                return;
            }
            if (fixture.scene_id && metadata.scene_id && fixture.scene_id !== metadata.scene_id) {
                errors.push(`${fixturePath}#${id}: metadata scene_id=${metadata.scene_id} does not match fixture scene_id=${fixture.scene_id}`);
            }
            annotated.push({
                fixture: fixturePath,
                id,
                ...metadata
            });
        });

        for (const id of Object.keys(manifestCases)) {
            if (!seenKeys.has(id)) {
                errors.push(`${fixturePath}#${id}: manifest metadata has no matching fixture case`);
            }
        }
    }

    validateHoldoutFreshness(annotated, policy, errors);

    const holdoutCount = annotated.filter(item => item.split === 'holdout').length;
    if (args.requireHoldout && holdoutCount < args.minHoldout) {
        errors.push(`expected at least ${args.minHoldout} holdout case(s), got ${holdoutCount}`);
    }
    if (holdoutCount === 0) {
        warnings.push('no holdout cases are annotated; current metrics are regression/diagnostic only');
    }

    const summary = {
        manifest: normalizePath(args.manifest),
        cases: annotated.length,
        splits: countBy(annotated, item => item.split),
        suites: countBy(annotated, item => item.suite),
        bench_statuses: countBy(annotated, item => item.bench_status),
        target_groups: countBy(annotated, item => item.target_group),
        policy: {
            metric_tracks: policy.metric_tracks,
            holdout_bench_statuses: policy.holdout_bench_statuses,
            holdout_forbidden_tags: policy.holdout_forbidden_tags,
            require_holdout_fresh_scene_or_target_group: !!policy.require_holdout_fresh_scene_or_target_group
        },
        holdout_ready: holdoutCount >= args.minHoldout,
        warnings
    };
    console.log(JSON.stringify(summary, null, 2));

    if (warnings.length > 0) {
        console.error(`Eval split validation warning(s):`);
        for (const warning of warnings) console.error(`- ${warning}`);
    }

    if (errors.length > 0) {
        console.error(`Eval split validation failed with ${errors.length} issue(s):`);
        for (const error of errors) console.error(`- ${error}`);
        process.exitCode = 1;
    }
};

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
