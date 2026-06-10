#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const usage = () => {
    console.error(`Usage: node scripts/replay-boxer-evals.mjs --file evals.json [--url http://localhost:8010/] [--out results.json]

Options:
  --file <path>          JSON array, JSONL, or pasted back-to-back eval JSON objects
  --url <url>            Built SuperSplat URL (default: http://localhost:8010/)
  --out <path>           Write incremental JSON results after each case
  --print-results        Print full replay JSON to stdout after the summary
  --summary-detail       Include verbose per-case diagnostics in stdout summary
  --case-index <n|a,b|a-b>
                         Replay only selected zero-based case indexes
  --limit <n>            Replay at most this many cases after filtering
  --prompt-type <type>   Override click prompts, e.g. client_click, client_brush, brush_sam, direct_lift_click, detect_all_click, or client_lift_target_box
  --brush-shape <shape>  For client_brush: circle or rect (default: circle)
  --brush-radius <px>    For client_brush circle prompts (default: 180)
  --brush-width <px>     For client_brush rect prompts (default: radius * 2)
  --brush-height <px>    For client_brush rect prompts (default: radius * 2)
  --brush-pad <px>       Expand the client_brush region before geometry
  --preprocess-mode <m>  Override direct lift preprocessing: full_frame or square_crop
  --depth-mode <m>       Override direct lift depth source: dense or points_only
  --geometry-mode <m>    Override direct lift geometry: global or proposal_local
  --boxernet-world-scale <n>
                         Scale world coordinates before BoxNet, then backend scales output back
  --boxernet-world-scales <a,b,c>
                         Try several BoxNet world scales and select by non-oracle candidate score
  --refinement-mode <m>  Override direct lift refinement: auto or raw
  --gravity <x,y,z>      Override direct lift gravity vector
  --object-crop          Crop the request image around the proposal and adjust intrinsics
  --object-crop-scale <n>
                         Crop side = proposal union side * scale (default: 2.8)
  --object-crop-min-size <n>
                         Minimum crop side in pixels (default: 480)
  --object-crop-max-size <n>
                         Maximum crop side in pixels
  --fusion               Run multi-view fusion instead of per-case replay
  --fusion-source <s>    Fusion source: target_box or click_cluster
  --fusion-min-views <n> Minimum views a splat must appear in
  --fusion-pad-scale <n> Expand each fusion 2D box by this scale
  --fusion-no-front-surface
                         Do not require a front-surface hit for fused splats
  --fusion-capture-view-images
                         Include base64 preview images for every fusion view
  --fusion-quantiles <lo,hi>
                         Quantiles for fused AABB, e.g. 0.04,0.96
  --fusion-timeout-ms <n>
                         Timeout for one fusion run
  --aggregate-target-groups
                         Fuse replayed predictions for cases with the same target AABB
  --no-sam               For direct_lift_click, disable SAM proposal augmentation
  --boxer-gpu-depth      Enable the app's GPU splat-depth path during replay
  --require-sam-success  Fail unless every ok case produces a non-empty SAM mask region
  --require-brush-points Fail client_brush cases whose prompt has no stroke points
  --verify-target-leak   Re-run target-agnostic cases with a mutated target and require identical runtime output
  --target-leak-offset <x,y,z>
                         Target center offset for --verify-target-leak (default: 13.37,-7.11,5.29)
  --case-timeout-ms <n>  Per-case timeout (default: 90000)
  --load-timeout-ms <n>  Page load/splat wait timeout (default: 45000)
  --fresh-browser        Launch a clean browser/page for every case
  --headful              Run Chromium headed
`);
};

const parseArgs = (argv) => {
    const args = {
        url: 'http://localhost:8010/',
        caseTimeoutMs: 90000,
        loadTimeoutMs: 45000,
        headless: true,
        freshBrowser: false
    };

    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--file') args.file = argv[++i];
        else if (arg === '--url') args.url = argv[++i];
        else if (arg === '--out') args.out = argv[++i];
        else if (arg === '--print-results') args.printResults = true;
        else if (arg === '--summary-detail') args.summaryDetail = true;
        else if (arg === '--case-index') args.caseIndex = argv[++i];
        else if (arg === '--limit') args.limit = Number(argv[++i]);
        else if (arg === '--prompt-type') args.promptType = argv[++i];
        else if (arg === '--brush-shape') args.brushShape = argv[++i];
        else if (arg === '--brush-radius') args.brushRadius = Number(argv[++i]);
        else if (arg === '--brush-width') args.brushWidth = Number(argv[++i]);
        else if (arg === '--brush-height') args.brushHeight = Number(argv[++i]);
        else if (arg === '--brush-pad') args.brushPad = Number(argv[++i]);
        else if (arg === '--preprocess-mode') args.preprocessMode = argv[++i];
        else if (arg === '--depth-mode') args.depthMode = argv[++i];
        else if (arg === '--geometry-mode') args.geometryMode = argv[++i];
        else if (arg === '--boxernet-world-scale') args.boxernetWorldScale = Number(argv[++i]);
        else if (arg === '--boxernet-world-scales') args.boxernetWorldScales = argv[++i].split(',').map(Number).filter(Number.isFinite);
        else if (arg === '--refinement-mode') args.refinementMode = argv[++i];
        else if (arg === '--gravity') args.gravity = argv[++i].split(',').map(Number);
        else if (arg === '--object-crop') args.objectCrop = true;
        else if (arg === '--object-crop-scale') args.objectCropScale = Number(argv[++i]);
        else if (arg === '--object-crop-min-size') args.objectCropMinSize = Number(argv[++i]);
        else if (arg === '--object-crop-max-size') args.objectCropMaxSize = Number(argv[++i]);
        else if (arg === '--fusion') args.fusion = true;
        else if (arg === '--fusion-source') args.fusionSource = argv[++i];
        else if (arg === '--fusion-min-views') args.fusionMinViews = Number(argv[++i]);
        else if (arg === '--fusion-pad-scale') args.fusionPadScale = Number(argv[++i]);
        else if (arg === '--fusion-no-front-surface') args.fusionFrontSurface = false;
        else if (arg === '--fusion-capture-view-images') args.fusionCaptureViewImages = true;
        else if (arg === '--fusion-quantiles') {
            const [lo, hi] = argv[++i].split(',').map(Number);
            args.fusionQuantiles = [lo, hi];
        } else if (arg === '--fusion-timeout-ms') args.fusionTimeoutMs = Number(argv[++i]);
        else if (arg === '--aggregate-target-groups') args.aggregateTargetGroups = true;
        else if (arg === '--no-sam') args.useSam = false;
        else if (arg === '--boxer-gpu-depth') args.boxerGpuDepth = true;
        else if (arg === '--require-sam-success') args.requireSamSuccess = true;
        else if (arg === '--require-brush-points') args.requireBrushPoints = true;
        else if (arg === '--verify-target-leak') args.verifyTargetLeak = true;
        else if (arg === '--target-leak-offset') args.targetLeakOffset = argv[++i].split(',').map(Number);
        else if (arg === '--case-timeout-ms') args.caseTimeoutMs = Number(argv[++i]);
        else if (arg === '--load-timeout-ms') args.loadTimeoutMs = Number(argv[++i]);
        else if (arg === '--fresh-browser') args.freshBrowser = true;
        else if (arg === '--headful') args.headless = false;
        else if (arg === '--help' || arg === '-h') {
            usage();
            process.exit(0);
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    if (!args.file) {
        usage();
        process.exit(2);
    }
    if (args.targetLeakOffset && (args.targetLeakOffset.length !== 3 || args.targetLeakOffset.some(value => !Number.isFinite(value)))) {
        throw new Error('--target-leak-offset must be three comma-separated numbers');
    }
    if (args.brushShape && !['circle', 'rect'].includes(args.brushShape)) {
        throw new Error('--brush-shape must be circle or rect');
    }
    return args;
};

const parseCaseIndexes = (value) => {
    if (!value) return null;
    const indexes = new Set();
    for (const part of value.split(',').map(item => item.trim()).filter(Boolean)) {
        const range = part.match(/^(\d+)-(\d+)$/);
        if (range) {
            const start = Number(range[1]);
            const end = Number(range[2]);
            const lo = Math.min(start, end);
            const hi = Math.max(start, end);
            for (let i = lo; i <= hi; i++) indexes.add(i);
            continue;
        }
        const index = Number(part);
        if (!Number.isInteger(index) || index < 0) {
            throw new Error(`Invalid --case-index value: ${part}`);
        }
        indexes.add(index);
    }
    return indexes;
};

const filterCases = (cases, args) => {
    let filtered = cases;
    const indexes = parseCaseIndexes(args.caseIndex);
    if (indexes) {
        filtered = filtered.filter((_evalCase, index) => indexes.has(index));
    }
    if (Number.isFinite(args.limit)) {
        filtered = filtered.slice(0, Math.max(0, args.limit));
    }
    return filtered;
};

const withPromptOverride = (evalCase, args) => {
    if (!args.promptType && !args.preprocessMode && !args.depthMode && !args.geometryMode && args.boxernetWorldScale === undefined && !args.boxernetWorldScales && !args.refinementMode && !args.gravity && !args.objectCrop && !args.brushShape && args.brushRadius === undefined && args.brushWidth === undefined && args.brushHeight === undefined && args.brushPad === undefined) return evalCase;
    const type = args.promptType ?? evalCase.prompt.type;
    const canOmitClick = type === 'lift_target_box' || type === 'client_lift_target_box';
    if (!evalCase.prompt?.click_xy && !canOmitClick) return evalCase;
    const buildBrush = () => {
        if (type !== 'client_brush' && type !== 'brush_sam') return {};
        if (evalCase.prompt.brush && !args.brushShape && args.brushRadius === undefined && args.brushWidth === undefined && args.brushHeight === undefined && args.brushPad === undefined) {
            return { brush: evalCase.prompt.brush };
        }
        const click = evalCase.prompt.click_xy;
        const shape = args.brushShape ?? 'circle';
        const radius = Number.isFinite(args.brushRadius) ? args.brushRadius : 180;
        return {
            brush: {
                shape,
                center_xy: click,
                ...(shape === 'circle' ? { radius } : {
                    width: Number.isFinite(args.brushWidth) ? args.brushWidth : radius * 2,
                    height: Number.isFinite(args.brushHeight) ? args.brushHeight : radius * 2
                }),
                ...(Number.isFinite(args.brushPad) ? { pad: args.brushPad } : {})
            }
        };
    };
    return {
        ...evalCase,
        prompt: {
            ...evalCase.prompt,
            type,
            ...buildBrush(),
            ...(args.preprocessMode ? { preprocess_mode: args.preprocessMode } : {}),
            ...(args.depthMode ? { depth_mode: args.depthMode } : {}),
            ...(args.geometryMode ? { geometry_mode: args.geometryMode } : {}),
            ...(args.boxernetWorldScale !== undefined ? { boxernet_world_scale: args.boxernetWorldScale } : {}),
            ...(args.boxernetWorldScales ? { boxernet_world_scales: args.boxernetWorldScales } : {}),
            ...(args.refinementMode ? { refinement_mode: args.refinementMode } : {}),
            ...(args.gravity ? { gravity: args.gravity } : {}),
            ...(args.objectCrop ? {
                object_crop: {
                    enabled: true,
                    ...(Number.isFinite(args.objectCropScale) ? { scale: args.objectCropScale } : {}),
                    ...(Number.isFinite(args.objectCropMinSize) ? { min_size: args.objectCropMinSize } : {}),
                    ...(Number.isFinite(args.objectCropMaxSize) ? { max_size: args.objectCropMaxSize } : {})
                }
            } : {}),
            ...(type === 'direct_lift_click' && args.useSam === false ? { use_sam: false } : {})
        }
    };
};

const tryLoadPlaywright = () => {
    const candidates = [
        process.env.PLAYWRIGHT_MODULE,
        'playwright',
        '/tmp/boxer-playwright/node_modules/playwright'
    ].filter(Boolean);

    for (const candidate of candidates) {
        try {
            return require(candidate);
        } catch (_err) {
            // Try the next candidate.
        }
    }

    throw new Error('Could not load Playwright. Install it or set PLAYWRIGHT_MODULE=/path/to/playwright.');
};

const parseBackToBackJson = (text) => {
    const values = [];
    let start = -1;
    let depth = 0;
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

        if (ch === '"') {
            inString = true;
        } else if (ch === '{' || ch === '[') {
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

const withTimeout = (promise, ms, message) => {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

const compactTiming = (timing) => {
    if (!timing || typeof timing !== 'object') return timing ?? null;
    const rest = { ...timing };
    delete rest.image;
    return rest;
};

const compactDepth = (frame, timing) => {
    const totalPixels = finite(frame?.depth_width) && finite(frame?.depth_height) ?
        frame.depth_width * frame.depth_height :
        null;
    const validRatio = finite(frame?.depth_valid_ratio) ?
        frame.depth_valid_ratio :
        (finite(frame?.depth_valid_pixels) && totalPixels ? frame.depth_valid_pixels / totalPixels : null);
    return {
        source: frame?.depth_source ?? timing?.depth_source ?? null,
        width: frame?.depth_width ?? null,
        height: frame?.depth_height ?? null,
        valid_pixels: frame?.depth_valid_pixels ?? null,
        total_pixels: totalPixels,
        valid_ratio: validRatio,
        min: frame?.depth_min ?? null,
        max: frame?.depth_max ?? null,
        visibility_index_ms: frame?.depth_visibility_index_ms ?? null,
        visibility_view_ms: frame?.depth_visibility_view_ms ?? null,
        visibility_view_reused: frame?.depth_visibility_view_reused ?? null,
        visibility_tile_count: frame?.depth_visibility_tile_count ?? null,
        visibility_visible_tiles: frame?.depth_visibility_visible_tiles ?? null
    };
};

const compactProjectionFit = (fit) => {
    if (!fit || typeof fit !== 'object') return null;
    return {
        applied: fit.applied,
        applied_order: fit.applied_order,
        best_order: fit.best_order,
        best_score: fit.best_score,
        previous_score: fit.previous_score,
        candidate_count: Array.isArray(fit.candidates) ? fit.candidates.length : undefined,
        top_candidates: Array.isArray(fit.candidates) ? fit.candidates.slice(0, 4).map(candidate => ({
            order: candidate.order,
            bbox_iou: candidate.bbox_iou,
            center_error_ratio: candidate.center_error_ratio,
            score: candidate.score
        })) : undefined
    };
};

const compactCandidate = (candidate) => {
    if (!candidate || typeof candidate !== 'object') return null;
    return {
        id: candidate.id,
        source: candidate.source,
        scale: candidate.scale,
        component_index: candidate.component_index,
        center: candidate.center,
        dimensions: candidate.dimensions,
        ray_variant: candidate.ray_variant,
        preserve_client_brush_geometry: candidate.preserve_client_brush_geometry,
        predicted_aabb: candidate.predicted_aabb,
        label: candidate.label,
        score: candidate.score ?? candidate.score2d,
        selection_score: candidate.selection_score,
        confidence: candidate.confidence,
        bb2d: Array.isArray(candidate.bb2d) ? candidate.bb2d : null,
        center: candidate.center,
        dimensions: candidate.dimensions,
        point_count: candidate.point_count ?? candidate.geometry_refinement?.point_count,
        depth_consistent_point_count: candidate.depth_consistent_point_count,
        depth_support_ratio: candidate.depth_support_ratio,
        candidate_depth_band: candidate.candidate_depth_band,
        depth_spread: candidate.depth_spread,
        depth_axis: candidate.depth_axis,
        inside_candidate_count: candidate.inside_candidate_count,
        cluster_inside_count: candidate.cluster_inside_count,
        support_inside_count: candidate.support_inside_count,
        support_ratio: candidate.support_ratio,
        brush_evidence_ratio: candidate.brush_evidence_ratio,
        selected_cluster_candidate_count: candidate.selected_cluster_candidate_count,
        projected_candidate_count: candidate.projected_candidate_count,
        front_surface_candidate_count: candidate.front_surface_candidate_count,
        geometry_reason: candidate.geometry_refinement?.reason,
        candidate_point_count: candidate.geometry_refinement?.candidate_point_count,
        dimension_source: candidate.geometry_refinement?.dimension_source,
        projection_fit: compactProjectionFit(candidate.projection_fit ?? candidate.geometry_refinement?.projection_fit)
    };
};

const buildCandidateDebug = (replay) => {
    const geometry = replay.boxer_result?.geometry_refinement;
    const clientClick = replay.client_click_probe ?? replay.boxer_result?.client_click;
    const clientBrush = replay.client_brush_probe ?? replay.boxer_result?.client_brush;
    const directLift = replay.direct_lift_probe ?? replay.boxer_result?.direct_lift;
    const clientLift = replay.client_lift_probe ?? replay.boxer_result?.client_lift;
    const sam3 = replay.boxer_result?.sam3_augmentation;
    const candidates = [
        ...((clientClick?.candidates ?? []) || []),
        ...((clientBrush?.candidates ?? []) || []),
        ...((directLift?.candidates ?? []) || []),
        ...((clientLift?.candidates ?? []) || [])
    ];

    return {
        geometry: geometry ? {
            applied: geometry.applied,
            reason: geometry.reason,
            point_count: geometry.point_count,
            candidate_point_count: geometry.candidate_point_count,
            full_candidate_point_count: geometry.full_candidate_point_count,
            observed_dimensions: geometry.observed_dimensions,
            model_dimensions: geometry.model_dimensions,
            dimensions: geometry.dimensions,
            dimension_source: geometry.dimension_source,
            dimension_prior: geometry.dimension_prior,
            rotation_prior: geometry.rotation_prior,
            focus_depth: geometry.focus_depth,
            bbox_center_depth: geometry.bbox_center_depth,
            focus_surface_center_offset: geometry.focus_surface_center_offset,
            projection_fit: compactProjectionFit(geometry.projection_fit)
        } : null,
        client_click: clientClick ? {
            backend_bypassed: clientClick.backend_bypassed,
            click_depth: clientClick.click_depth,
            local_candidate_count: clientClick.local_candidate_count,
            front_surface_candidate_count: clientClick.front_surface_candidate_count,
            cluster_point_count: clientClick.cluster_point_count,
            connected_cluster_point_count: clientClick.connected_cluster_point_count,
            knn_cluster_point_count: clientClick.knn_cluster_point_count,
            knn_cluster_relaxed: clientClick.knn_cluster_relaxed,
            knn_cluster_capped: clientClick.knn_cluster_capped,
            knn_source_candidate_count: clientClick.knn_source_candidate_count,
            depth_window_point_count: clientClick.depth_window_point_count,
            fallback_depth_band: clientClick.fallback_depth_band,
            visible_surface_prior: clientClick.visible_surface_prior,
            local_bb2d: clientClick.local_bb2d,
            cluster_bb2d: clientClick.cluster_bb2d,
            knn_cluster_bb2d: clientClick.knn_cluster_bb2d,
            depth_component_bb2d: clientClick.depth_component_bb2d,
            depth_component_pixel_count: clientClick.depth_component_pixel_count,
            depth_component_seed_depth: clientClick.depth_component_seed_depth,
            depth_component_relaxed: clientClick.depth_component_relaxed,
            selected_candidate_source: clientClick.selected_candidate_source,
            selected_candidate_scale: clientClick.selected_candidate_scale
        } : null,
        client_brush: clientBrush ? {
            backend_bypassed: clientBrush.backend_bypassed,
            shape: clientBrush.shape,
            center_xy: clientBrush.center_xy,
            radius: clientBrush.radius,
            brush_bb2d: clientBrush.brush_bb2d,
            brush_area_ratio: clientBrush.brush_area_ratio,
            brush_stroke_point_count: clientBrush.brush_stroke_point_count,
            click_depth: clientBrush.click_depth,
            base_projected_candidate_count: clientBrush.base_projected_candidate_count,
            base_front_surface_candidate_count: clientBrush.base_front_surface_candidate_count,
            brush_candidate_count: clientBrush.brush_candidate_count,
            selected_point_count: clientBrush.selected_point_count,
            connected_cluster_point_count: clientBrush.connected_cluster_point_count,
            brush_component_count: clientBrush.brush_component_count,
            brush_component_point_counts: clientBrush.brush_component_point_counts,
            brush_knn_point_count: clientBrush.brush_knn_point_count,
            brush_knn_capped: clientBrush.brush_knn_capped,
            selected_cluster_bb2d: clientBrush.selected_cluster_bb2d,
            selected_candidate_source: clientBrush.selected_candidate_source,
            selected_candidate_scale: clientBrush.selected_candidate_scale,
            candidates: Array.isArray(clientBrush.candidates) ?
                clientBrush.candidates.slice(0, 32).map(compactCandidate).filter(Boolean) :
                undefined
        } : null,
        sam3: sam3 ? {
            applied: sam3.applied,
            mask_area_ratio: sam3.mask_area_ratio,
            region: sam3.region,
            error: sam3.error ?? sam3.debug?.error,
            debug: sam3.debug ? {
                attempts: Array.isArray(sam3.debug.attempts) ? sam3.debug.attempts.map(attempt => ({
                    endpoint: attempt.endpoint,
                    status: attempt.status,
                    ok: attempt.ok,
                    detail: attempt.detail
                })) : undefined,
                upload_ms: sam3.debug.upload_ms,
                segment_ms: sam3.debug.segment_ms,
                mask_width: sam3.debug.mask_width,
                mask_height: sam3.debug.mask_height,
                mask_area_ratio: sam3.debug.mask_area_ratio,
                rejection_reason: sam3.debug.rejection_reason,
                error: sam3.debug.error
            } : undefined
        } : null,
        candidates: candidates.slice(0, 8).map(compactCandidate).filter(Boolean)
    };
};

const compactReplay = (evalCase, replay) => {
    const timing = compactTiming(replay.timing ?? replay.click_debug);
    return {
        id: evalCase.id ?? evalCase.captured_at ?? `${evalCase.prompt?.click_xy?.join(',')}`,
        replay_wall_ms: replay.replay_wall_ms,
        input_camera_changed: !!evalCase.camera_changed_since_boxer_run,
        source_prompt: replay.source_prompt,
        replay_prompt: replay.replay_prompt,
        source_canvas: replay.source_canvas,
        replay_canvas: replay.replay_canvas,
        label: replay.boxer_result?.label,
        confidence: replay.boxer_result?.confidence,
        score2d: replay.boxer_result?.score2d,
        bb2d: replay.boxer_result?.normalized_bb2d,
        raw_bb2d: replay.boxer_result?.bb2d,
        bb2d_format: replay.boxer_result?.bb2d_format,
        response_candidate_counts: {
            candidates: replay.boxer_result?.candidates?.length ?? 0,
            proposals: replay.boxer_result?.proposals?.length ?? 0,
            detections: replay.boxer_result?.detections?.length ?? 0
        },
        dimensions: replay.boxer_result?.dimensions,
        center: replay.boxer_result?.center,
        raw_label: replay.raw_boxer_result?.label ?? replay.boxer_result?.raw_boxer_result?.label,
        raw_dimensions: replay.raw_boxer_result?.dimensions ?? replay.boxer_result?.raw_boxer_result?.dimensions,
        raw_center: replay.raw_boxer_result?.center ?? replay.boxer_result?.raw_boxer_result?.center,
        geometry_refinement: replay.boxer_result?.geometry_refinement,
        target_projected_bb2d: replay.boxer_result?.target_projected_bb2d ?? replay.direct_lift_probe?.target_projected_bb2d,
        bb2d_target_metrics: replay.boxer_result?.bb2d_target_metrics ??
            replay.direct_lift_probe?.candidates?.[0]?.bb2d_target_metrics,
        timing,
        depth: compactDepth(replay.frame, timing),
        direct_lift_probe: replay.direct_lift_probe ?? replay.boxer_result?.direct_lift,
        client_lift_probe: replay.client_lift_probe ?? replay.boxer_result?.client_lift,
        client_click_probe: replay.client_click_probe ?? replay.boxer_result?.client_click,
        client_brush_probe: replay.client_brush_probe ?? replay.boxer_result?.client_brush,
        sam3_augmentation: replay.boxer_result?.sam3_augmentation,
        candidate_debug: buildCandidateDebug(replay),
        raw_metrics: replay.raw_metrics,
        metrics: replay.metrics
    };
};

const roundNumber = (value, decimals = 6) => (
    Number.isFinite(value) ? Number(value.toFixed(decimals)) : value
);

const stableValue = (value) => {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value)
            .filter(([_key, item]) => item !== undefined)
            .map(([key, item]) => [key, stableValue(item)])
        );
    }
    return typeof value === 'number' ? roundNumber(value) : value;
};

const pickRuntimeObb = (obb) => {
    if (!obb || typeof obb !== 'object') return null;
    return stableValue({
        label: obb.label,
        confidence: obb.confidence,
        score2d: obb.score2d,
        bb2d: obb.bb2d,
        normalized_bb2d: obb.normalized_bb2d,
        bb2d_format: obb.bb2d_format,
        center: obb.center,
        dimensions: obb.dimensions,
        rotation: obb.rotation,
        corners: obb.corners,
        geometry_refinement: obb.geometry_refinement ? {
            applied: obb.geometry_refinement.applied,
            reason: obb.geometry_refinement.reason,
            point_count: obb.geometry_refinement.point_count,
            candidate_point_count: obb.geometry_refinement.candidate_point_count,
            full_candidate_point_count: obb.geometry_refinement.full_candidate_point_count,
            center: obb.geometry_refinement.center,
            dimensions: obb.geometry_refinement.dimensions,
            observed_dimensions: obb.geometry_refinement.observed_dimensions,
            model_dimensions: obb.geometry_refinement.model_dimensions,
            dimension_source: obb.geometry_refinement.dimension_source,
            dimension_prior: obb.geometry_refinement.dimension_prior,
            rotation_prior: obb.geometry_refinement.rotation_prior,
            focus_depth: obb.geometry_refinement.focus_depth,
            focus_surface_world: obb.geometry_refinement.focus_surface_world,
            bbox_center_depth: obb.geometry_refinement.bbox_center_depth,
            bbox_center_surface_world: obb.geometry_refinement.bbox_center_surface_world,
            focus_surface_center_offset: obb.geometry_refinement.focus_surface_center_offset,
            projection_fit: compactProjectionFit(obb.geometry_refinement.projection_fit)
        } : null
    });
};

const runtimeSignature = replay => stableValue({
    replay_prompt: replay.replay_prompt,
    boxer_result: pickRuntimeObb(replay.boxer_result),
    raw_boxer_result: pickRuntimeObb(replay.raw_boxer_result ?? replay.boxer_result?.raw_boxer_result)
});

const isTargetDependentPrompt = prompt => (
    prompt?.type === 'lift_target_box' ||
    prompt?.type === 'client_lift_target_box'
);

const mutateTarget = (target, offset = [13.37, -7.11, 5.29]) => {
    if (!target || !Array.isArray(target.center) || !Array.isArray(target.dimensions)) return null;
    return {
        ...target,
        center: target.center.map((value, index) => value + offset[index]),
        dimensions: target.dimensions.map((value, index) => Math.max(0.01, value * [1.7, 0.61, 2.3][index]))
    };
};

const findFirstDifference = (a, b, path = '') => {
    if (Object.is(a, b)) return null;
    if (typeof a !== typeof b) return { path, baseline: a, mutated: b };
    if (!a || !b || typeof a !== 'object') return { path, baseline: a, mutated: b };
    if (Array.isArray(a) !== Array.isArray(b)) return { path, baseline: a, mutated: b };
    if (Array.isArray(a)) {
        if (a.length !== b.length) return { path: `${path}.length`, baseline: a.length, mutated: b.length };
        for (let i = 0; i < a.length; i++) {
            const diff = findFirstDifference(a[i], b[i], `${path}[${i}]`);
            if (diff) return diff;
        }
        return null;
    }
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const key of keys) {
        if (!(key in a) || !(key in b)) return { path: path ? `${path}.${key}` : key, baseline: a[key], mutated: b[key] };
        const diff = findFirstDifference(a[key], b[key], path ? `${path}.${key}` : key);
        if (diff) return diff;
    }
    return null;
};

function finite(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

const average = (values) => {
    const good = values.filter(finite);
    return good.length ? good.reduce((sum, value) => sum + value, 0) / good.length : null;
};

const percentile = (values, q) => {
    const good = values.filter(finite).sort((a, b) => a - b);
    if (!good.length) return null;
    const pos = (good.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return good[lo];
    return good[lo] + (good[hi] - good[lo]) * (pos - lo);
};

const maxFinite = (values) => {
    const good = values.filter(finite);
    return good.length ? Math.max(...good) : null;
};

const minFinite = (values) => {
    const good = values.filter(finite);
    return good.length ? Math.min(...good) : null;
};

const countBy = (items, keyFn) => {
    const counts = {};
    for (const item of items) {
        const key = keyFn(item);
        if (!key) continue;
        counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
};

const timingStats = (results, field) => {
    const values = results.map(result => result.timing?.[field]);
    return {
        avg: average(values),
        p95: percentile(values, 0.95),
        max: maxFinite(values)
    };
};

const selectedCandidateSummary = (result) => {
    const brush = result.candidate_debug?.client_brush;
    const click = result.candidate_debug?.client_click;
    const candidates = result.candidate_debug?.candidates ?? [];
    const top = candidates[0];
    const source = brush?.selected_candidate_source ??
        click?.selected_candidate_source ??
        top?.source ??
        null;
    const scale = brush?.selected_candidate_scale ??
        click?.selected_candidate_scale ??
        top?.scale ??
        null;
    return {
        source,
        scale,
        score: top?.selection_score ?? top?.score ?? null,
        point_count: top?.point_count ?? null,
        depth_support_ratio: top?.depth_support_ratio ?? null,
        depth_consistent_point_count: top?.depth_consistent_point_count ?? null,
        projected_candidate_count: top?.projected_candidate_count ?? null,
        front_surface_candidate_count: top?.front_surface_candidate_count ?? null
    };
};

const leakStatus = (check) => {
    if (!check) return 'not_requested';
    if (check.skipped) return 'skipped';
    if (!check.checked) return 'not_checked';
    return check.passed ? 'passed' : 'failed';
};

const bb2dArea = (bb) => {
    if (!Array.isArray(bb) || bb.length !== 4 || !bb.every(finite)) return null;
    return Math.max(0, bb[2] - bb[0]) * Math.max(0, bb[3] - bb[1]);
};

const bb2dIntersectionArea = (a, b) => {
    if (bb2dArea(a) === null || bb2dArea(b) === null) return null;
    return Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
        Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
};

const bb2dOverlapStats = (a, b) => {
    const areaA = bb2dArea(a);
    const areaB = bb2dArea(b);
    const intersection = bb2dIntersectionArea(a, b);
    if (areaA === null || areaB === null || intersection === null) return null;
    const union = areaA + areaB - intersection;
    const centerA = [(a[0] + a[2]) / 2, (a[1] + a[3]) / 2];
    const centerB = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
    const diagA = Math.max(1, Math.hypot(a[2] - a[0], a[3] - a[1]));
    const diagB = Math.max(1, Math.hypot(b[2] - b[0], b[3] - b[1]));
    return {
        iou: union > 0 ? intersection / union : 0,
        a_covered_by_b: areaA > 0 ? intersection / areaA : 0,
        b_covered_by_a: areaB > 0 ? intersection / areaB : 0,
        center_distance_ratio: Math.hypot(centerA[0] - centerB[0], centerA[1] - centerB[1]) / Math.max(diagA, diagB),
        area_ratio_a_to_b: areaB > 0 ? areaA / areaB : null
    };
};

const buildCaseReport = (result) => {
    const selected = selectedCandidateSummary(result);
    const brush = result.candidate_debug?.client_brush;
    const click = result.candidate_debug?.client_click;
    const sam3 = result.candidate_debug?.sam3;
    const samAttempts = sam3?.debug?.attempts ?? [];
    return {
        id: result.id,
        ok: result.ok,
        prompt_type: result.replay_prompt?.type ?? result.source_prompt?.type ?? null,
        label: result.label ?? null,
        aabb_iou: result.metrics?.aabb_iou ?? null,
        center_distance: result.metrics?.center_distance ?? null,
        bb2d_target_iou: result.bb2d_target_metrics?.bb2d_iou ?? null,
        rough_target: roughTargetDiagnostics(result),
        selected_candidate: selected,
        depth: {
            source: result.depth?.source ?? result.timing?.depth_source ?? null,
            valid_ratio: result.depth?.valid_ratio ?? null,
            valid_pixels: result.depth?.valid_pixels ?? null,
            total_pixels: result.depth?.total_pixels ?? null,
            min: result.depth?.min ?? null,
            max: result.depth?.max ?? null,
            visibility_index_ms: result.depth?.visibility_index_ms ?? null,
            visibility_view_ms: result.depth?.visibility_view_ms ?? null,
            visibility_view_reused: result.depth?.visibility_view_reused ?? null,
            visibility_tile_count: result.depth?.visibility_tile_count ?? null,
            visibility_visible_tiles: result.depth?.visibility_visible_tiles ?? null
        },
        timing_ms: {
            app_total: result.timing?.total_ms ?? null,
            frame: result.timing?.frame_ms ?? null,
            backend: result.timing?.backend_ms ?? null,
            refine: result.timing?.refine_ms ?? null,
            draw: result.timing?.draw_ms ?? null,
            replay_wall: result.replay_wall_ms ?? null
        },
        client_click: click ? {
            local_candidate_count: click.local_candidate_count,
            front_surface_candidate_count: click.front_surface_candidate_count,
            cluster_point_count: click.cluster_point_count,
            connected_cluster_point_count: click.connected_cluster_point_count,
            depth_window_point_count: click.depth_window_point_count,
            click_depth: click.click_depth
        } : undefined,
        client_brush: brush ? {
            shape: brush.shape,
            brush_area_ratio: brush.brush_area_ratio,
            brush_stroke_point_count: brush.brush_stroke_point_count,
            brush_candidate_count: brush.brush_candidate_count,
            selected_point_count: brush.selected_point_count,
            connected_cluster_point_count: brush.connected_cluster_point_count,
            brush_component_count: brush.brush_component_count,
            brush_component_point_counts: brush.brush_component_point_counts,
            brush_knn_point_count: brush.brush_knn_point_count,
            brush_knn_capped: brush.brush_knn_capped,
            selected_candidate_source: brush.selected_candidate_source,
            selected_candidate_scale: brush.selected_candidate_scale,
            click_depth: brush.click_depth,
            top_candidates: (brush.candidates ?? []).slice(0, 4).map(candidate => ({
                source: candidate.source,
                scale: candidate.scale,
                selection_score: candidate.selection_score,
                point_count: candidate.point_count,
                inside_candidate_count: candidate.inside_candidate_count,
                depth_consistent_point_count: candidate.depth_consistent_point_count,
                cluster_inside_count: candidate.cluster_inside_count,
                support_inside_count: candidate.support_inside_count,
                support_ratio: candidate.support_ratio,
                brush_evidence_ratio: candidate.brush_evidence_ratio
            }))
        } : undefined,
        knn: click ? {
            cluster_point_count: click.knn_cluster_point_count,
            source_candidate_count: click.knn_source_candidate_count,
            relaxed: click.knn_cluster_relaxed,
            capped: click.knn_cluster_capped,
            selected: selected.source === 'knn_cluster'
        } : undefined,
        sam3: sam3 ? {
            applied: sam3.applied,
            succeeded: samSucceeded(result),
            mask_area_ratio: sam3.mask_area_ratio ?? sam3.debug?.mask_area_ratio ?? null,
            rejection_reason: sam3.debug?.rejection_reason ?? null,
            error: sam3.error ?? sam3.debug?.error ?? null,
            upload_ms: sam3.debug?.upload_ms ?? null,
            segment_ms: sam3.debug?.segment_ms ?? null,
            attempts: samAttempts.map(attempt => ({
                endpoint: attempt.endpoint,
                status: attempt.status,
                ok: attempt.ok
            }))
        } : undefined,
        target_leak: {
            status: leakStatus(result.target_leak_check),
            first_difference_path: result.target_leak_check?.first_difference?.path ?? null,
            reason: result.target_leak_check?.reason ?? null
        }
    };
};

const attachCaseReport = (result) => {
    result.report = buildCaseReport(result);
    return result;
};

const aabbVolume = aabb => (
    Math.max(0, aabb.max[0] - aabb.min[0]) *
    Math.max(0, aabb.max[1] - aabb.min[1]) *
    Math.max(0, aabb.max[2] - aabb.min[2])
);

const aabbIou = (a, b) => {
    const intersection = {
        min: [0, 1, 2].map(axis => Math.max(a.min[axis], b.min[axis])),
        max: [0, 1, 2].map(axis => Math.min(a.max[axis], b.max[axis]))
    };
    const intersectionVolume = aabbVolume(intersection);
    const unionVolume = aabbVolume(a) + aabbVolume(b) - intersectionVolume;
    return unionVolume > 0 ? intersectionVolume / unionVolume : 0;
};

const aabbOverlapStats = (a, b) => {
    if (!a || !b) return null;
    const intersection = {
        min: [0, 1, 2].map(axis => Math.max(a.min[axis], b.min[axis])),
        max: [0, 1, 2].map(axis => Math.min(a.max[axis], b.max[axis]))
    };
    const intersectionVolume = aabbVolume(intersection);
    const volumeA = aabbVolume(a);
    const volumeB = aabbVolume(b);
    const union = volumeA + volumeB - intersectionVolume;
    return {
        iou: union > 0 ? intersectionVolume / union : 0,
        a_covered_by_b: volumeA > 0 ? intersectionVolume / volumeA : 0,
        b_covered_by_a: volumeB > 0 ? intersectionVolume / volumeB : 0,
        volume_ratio_a_to_b: volumeB > 0 ? volumeA / volumeB : null
    };
};

const padAabb = (aabb, scale) => {
    if (!aabb) return null;
    const center = [0, 1, 2].map(axis => (aabb.min[axis] + aabb.max[axis]) / 2);
    const half = [0, 1, 2].map(axis => Math.max(0, (aabb.max[axis] - aabb.min[axis]) / 2) * scale);
    return {
        min: [0, 1, 2].map(axis => center[axis] - half[axis]),
        max: [0, 1, 2].map(axis => center[axis] + half[axis])
    };
};

const roughTargetDiagnostics = (result) => {
    const predictedAabb = result.metrics?.predicted_aabb;
    const targetAabb = result.metrics?.target_aabb;
    const predictionTarget3d = aabbOverlapStats(predictedAabb, targetAabb);
    const predBb = result.bb2d;
    const targetBb = result.target_projected_bb2d;
    const brushBb = result.candidate_debug?.client_brush?.brush_bb2d ??
        result.client_brush_probe?.brush_bb2d ??
        result.replay_prompt?.brush?.bb2d ??
        result.source_prompt?.brush?.bb2d;
    const targetBrush2d = brushBb && targetBb ? bb2dOverlapStats(targetBb, brushBb) : null;
    const predBrush2d = brushBb && predBb ? bb2dOverlapStats(predBb, brushBb) : null;
    const predTarget2d = predBb && targetBb ? bb2dOverlapStats(predBb, targetBb) : null;
    const targetDiag = targetAabb ? Math.hypot(
        targetAabb.max[0] - targetAabb.min[0],
        targetAabb.max[1] - targetAabb.min[1],
        targetAabb.max[2] - targetAabb.min[2]
    ) : null;
    const centerDistanceRatio = finite(result.metrics?.center_distance) && targetDiag ?
        result.metrics.center_distance / Math.max(1e-6, targetDiag) :
        null;
    return {
        target_vs_brush_2d: targetBrush2d,
        prediction_vs_brush_2d: predBrush2d,
        prediction_vs_target_2d: predTarget2d,
        prediction_vs_target_3d: predictionTarget3d,
        target_padded_iou_3d: {
            scale_1_15: predictedAabb && targetAabb ? aabbIou(predictedAabb, padAabb(targetAabb, 1.15)) : null,
            scale_1_30: predictedAabb && targetAabb ? aabbIou(predictedAabb, padAabb(targetAabb, 1.30)) : null
        },
        center_distance_target_diag_ratio: centerDistanceRatio,
        likely_rough_target_2d: !!targetBrush2d &&
            targetBrush2d.iou < 0.45 &&
            targetBrush2d.b_covered_by_a >= 0.75,
        likely_tight_prediction_inside_target: !!predictionTarget3d &&
            predictionTarget3d.a_covered_by_b >= 0.75 &&
            predictionTarget3d.b_covered_by_a < 0.45
    };
};

const centerDistance = (a, b) => {
    const ac = [0, 1, 2].map(axis => (a.min[axis] + a.max[axis]) / 2);
    const bc = [0, 1, 2].map(axis => (b.min[axis] + b.max[axis]) / 2);
    return Math.hypot(ac[0] - bc[0], ac[1] - bc[1], ac[2] - bc[2]);
};

const targetKey = (result) => {
    const target = result.metrics?.target_aabb;
    if (!target) return null;
    return JSON.stringify({
        min: target.min.map(value => Number(value.toFixed(4))),
        max: target.max.map(value => Number(value.toFixed(4)))
    });
};

const addAggregateTargetGroups = (results) => {
    const groups = new Map();
    for (const result of results) {
        const key = targetKey(result);
        const predicted = result.metrics?.predicted_aabb;
        const target = result.metrics?.target_aabb;
        if (!key || !predicted || !target) continue;
        if (!groups.has(key)) groups.set(key, { key, target, results: [] });
        groups.get(key).results.push(result);
    }

    const aggregateGroups = [];
    for (const group of groups.values()) {
        const fusedAabb = {
            min: [0, 1, 2].map(axis => average(group.results.map(result => result.metrics.predicted_aabb.min[axis]))),
            max: [0, 1, 2].map(axis => average(group.results.map(result => result.metrics.predicted_aabb.max[axis])))
        };
        const aggregate = {
            key: group.key,
            case_count: group.results.length,
            fused_aabb: fusedAabb,
            target_aabb: group.target,
            aabb_iou: aabbIou(fusedAabb, group.target),
            center_distance: centerDistance(fusedAabb, group.target)
        };
        aggregateGroups.push(aggregate);
        for (const result of group.results) {
            result.group_fused_metrics = aggregate;
        }
    }

    return aggregateGroups;
};

const summarizeResults = (results, options = {}) => {
    const ok = results.filter(result => result.ok);
    const selectedIous = ok.map(result => result.metrics?.aabb_iou);
    const centers = ok.map(result => result.metrics?.center_distance);
    const bb2dIous = ok.map(result => result.bb2d_target_metrics?.bb2d_iou);
    const oracleIous = ok.map(result => result.direct_lift_probe?.oracle_best?.metrics?.aabb_iou);
    const groupFusedIous = ok.map(result => result.group_fused_metrics?.aabb_iou);
    const replayWallMs = ok.map(result => result.replay_wall_ms);
    const caseReports = ok.map(result => result.report ?? buildCaseReport(result));
    const selectedSources = caseReports.map(report => report.selected_candidate?.source);
    const selectedSourceBuckets = {};
    for (const source of new Set(selectedSources.filter(Boolean))) {
        const bucket = caseReports.filter(report => report.selected_candidate?.source === source);
        selectedSourceBuckets[source] = {
            count: bucket.length,
            avg_iou: average(bucket.map(report => report.aabb_iou)),
            avg_center_distance: average(bucket.map(report => report.center_distance)),
            scales: countBy(bucket, (report) => {
                const scale = report.selected_candidate?.scale;
                return finite(scale) ? String(scale) : null;
            })
        };
    }
    const depthReports = caseReports.map(report => report.depth).filter(Boolean);
    const brushReports = caseReports.map(report => report.client_brush).filter(Boolean);
    const samReports = caseReports.map(report => report.sam3).filter(Boolean);
    const targetLeakChecks = ok.map(result => result.target_leak_check).filter(Boolean);
    const checkedTargetLeaks = targetLeakChecks.filter(check => check.checked);
    const failedTargetLeaks = checkedTargetLeaks.filter(check => !check.passed);
    return {
        cases: results.length,
        ok: ok.length,
        failed: results.length - ok.length,
        avg_iou: average(selectedIous),
        avg_group_fused_case_iou: average(groupFusedIous),
        group_fused_cases: groupFusedIous.filter(finite).length,
        avg_center_distance: average(centers),
        avg_bb2d_target_iou: average(bb2dIous),
        avg_direct_lift_oracle_iou: average(oracleIous),
        avg_replay_wall_ms: average(replayWallMs),
        max_replay_wall_ms: replayWallMs.filter(finite).length ? Math.max(...replayWallMs.filter(finite)) : null,
        timing_ms: {
            replay_wall: {
                avg: average(replayWallMs),
                p95: percentile(replayWallMs, 0.95),
                max: maxFinite(replayWallMs)
            },
            app_total: timingStats(ok, 'total_ms'),
            frame: timingStats(ok, 'frame_ms'),
            backend: timingStats(ok, 'backend_ms'),
            refine: timingStats(ok, 'refine_ms'),
            draw: timingStats(ok, 'draw_ms')
        },
        selected_candidates: {
            sources: countBy(caseReports, report => report.selected_candidate?.source),
            source_scale_pairs: countBy(caseReports, (report) => {
                const source = report.selected_candidate?.source;
                const scale = report.selected_candidate?.scale;
                return source && finite(scale) ? `${source}@${scale}` : null;
            }),
            by_source: selectedSourceBuckets
        },
        depth: {
            sources: countBy(depthReports, depth => depth.source),
            avg_valid_ratio: average(depthReports.map(depth => depth.valid_ratio)),
            min_valid_ratio: minFinite(depthReports.map(depth => depth.valid_ratio)),
            max_valid_ratio: maxFinite(depthReports.map(depth => depth.valid_ratio)),
            avg_visibility_index_ms: average(depthReports.map(depth => depth.visibility_index_ms)),
            avg_visibility_view_ms: average(depthReports.map(depth => depth.visibility_view_ms)),
            reused_visibility_views: depthReports.filter(depth => depth.visibility_view_reused).length,
            avg_visibility_visible_tiles: average(depthReports.map(depth => depth.visibility_visible_tiles)),
            avg_visibility_tile_count: average(depthReports.map(depth => depth.visibility_tile_count))
        },
        client_brush: brushReports.length ? {
            cases: brushReports.length,
            selected_sources: countBy(brushReports, brush => brush.selected_candidate_source),
            selected_scales: countBy(brushReports, brush => (
                finite(brush.selected_candidate_scale) ? String(brush.selected_candidate_scale) : null
            )),
            avg_brush_candidate_count: average(brushReports.map(brush => brush.brush_candidate_count)),
            avg_selected_point_count: average(brushReports.map(brush => brush.selected_point_count)),
            avg_connected_cluster_point_count: average(brushReports.map(brush => brush.connected_cluster_point_count)),
            avg_brush_component_count: average(brushReports.map(brush => brush.brush_component_count)),
            max_brush_component_count: maxFinite(brushReports.map(brush => brush.brush_component_count)),
            avg_brush_knn_point_count: average(brushReports.map(brush => brush.brush_knn_point_count)),
            brush_knn_capped_cases: brushReports.filter(brush => brush.brush_knn_capped).length,
            avg_brush_area_ratio: average(brushReports.map(brush => brush.brush_area_ratio))
        } : undefined,
        sam3: samReports.length ? {
            cases: samReports.length,
            succeeded: samReports.filter(sam => sam.succeeded).length,
            applied: samReports.filter(sam => sam.applied).length,
            avg_mask_area_ratio: average(samReports.map(sam => sam.mask_area_ratio)),
            rejection_reasons: countBy(samReports, sam => sam.rejection_reason ?? sam.error)
        } : undefined,
        target_leak_checks: targetLeakChecks.length ? {
            total: targetLeakChecks.length,
            checked: checkedTargetLeaks.length,
            skipped: targetLeakChecks.filter(check => check.skipped).length,
            failed: failedTargetLeaks.length,
            passed: checkedTargetLeaks.filter(check => check.passed).length,
            failed_ids: ok
            .filter(result => result.target_leak_check?.checked && !result.target_leak_check.passed)
            .map(result => result.id)
        } : undefined,
        per_case: options.detail ? caseReports : caseReports.map(report => ({
            id: report.id,
            ok: report.ok,
            prompt_type: report.prompt_type,
            aabb_iou: report.aabb_iou,
            center_distance: report.center_distance,
            bb2d_target_iou: report.bb2d_target_iou,
            rough_target: report.rough_target,
            selected_candidate: report.selected_candidate,
            target_leak: report.target_leak
        })),
        min_iou: selectedIous.filter(finite).length ? Math.min(...selectedIous.filter(finite)) : null,
        max_iou: selectedIous.filter(finite).length ? Math.max(...selectedIous.filter(finite)) : null,
        buckets: ['clean', 'camera_changed'].reduce((acc, key) => {
            const bucket = ok.filter(result => (
                key === 'camera_changed' ? result.input_camera_changed : !result.input_camera_changed
            ));
            acc[key] = {
                ok: bucket.length,
                avg_iou: average(bucket.map(result => result.metrics?.aabb_iou)),
                avg_center_distance: average(bucket.map(result => result.metrics?.center_distance)),
                avg_bb2d_target_iou: average(bucket.map(result => result.bb2d_target_metrics?.bb2d_iou))
            };
            return acc;
        }, {})
    };
};

const writeResults = async (path, results) => {
    if (!path) return;
    await writeFile(path, `${JSON.stringify(results, null, 2)}\n`);
};

const runFusion = async ({ chromium, url, evalCases, args }) => {
    const replayPage = await createReplayPage({
        chromium,
        url,
        firstCase: evalCases[0],
        headless: args.headless,
        loadTimeoutMs: args.loadTimeoutMs,
        args
    });
    try {
        const options = {
            source: args.fusionSource ?? 'target_box',
            ...(Number.isFinite(args.fusionMinViews) ? { min_views: args.fusionMinViews } : {}),
            ...(Number.isFinite(args.fusionPadScale) ? { pad_scale: args.fusionPadScale } : {}),
            ...(args.fusionFrontSurface === false ? { front_surface: false } : {}),
            ...(args.fusionCaptureViewImages ? { capture_view_images: true } : {}),
            ...(args.fusionQuantiles ? {
                quantile_low: args.fusionQuantiles[0],
                quantile_high: args.fusionQuantiles[1]
            } : {})
        };
        const timeoutMs = args.fusionTimeoutMs ?? Math.max(args.caseTimeoutMs, args.caseTimeoutMs * Math.max(1, evalCases.length));
        return await withTimeout(
            replayPage.page.evaluate(
                input => window.supersplatDebug.runBoxerEvalFusion(input),
                { cases: evalCases, options }
            ),
            timeoutMs,
            `Timed out after ${timeoutMs}ms`
        );
    } finally {
        await replayPage.browser.close().catch(() => {});
    }
};

const launchBrowser = (chromium, headless) => chromium.launch({
    headless,
    args: [
        '--disable-dev-shm-usage',
        '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist',
        '--use-gl=swiftshader'
    ]
});

const waitForLoadedSplat = async (page, loadTimeoutMs) => {
    await page.waitForFunction(
        () => {
            const splats = window.scene?.events?.invoke?.('scene.splats') || [];
            const bodyText = document.body?.innerText || '';
            return splats.length > 0 || bodyText.includes('ERROR LOADING FILE');
        },
        null,
        { timeout: loadTimeoutMs }
    );

    const loadState = await page.evaluate(() => ({
        splats: (window.scene?.events?.invoke?.('scene.splats') || []).length,
        errorText: document.body?.innerText?.includes('ERROR LOADING FILE') ?
            document.body.innerText.slice(0, 800) :
            ''
    }));
    if (loadState.splats <= 0) {
        throw new Error(loadState.errorText || 'Timed out waiting for splat load');
    }

};

const installReplayConfig = async (page, args) => {
    if (!args?.boxerGpuDepth) return;
    const setConfig = () => {
        window.supersplatConfig = {
            ...(window.supersplatConfig ?? {}),
            boxerGpuDepth: true
        };
    };
    await page.addInitScript(setConfig);
    await page.evaluate(setConfig).catch(() => {});
};

const createReplayPage = async ({ chromium, url, firstCase, headless, loadTimeoutMs, args }) => {
    const width = Math.max(320, Math.round(firstCase.frame?.image_width ?? 1280));
    const height = Math.max(320, Math.round(firstCase.frame?.image_height ?? 820));
    const browser = await launchBrowser(chromium, headless);
    const context = await browser.newContext({
        viewport: { width, height },
        permissions: ['clipboard-read', 'clipboard-write']
    });
    const page = await context.newPage();
    await installReplayConfig(page, args);
    const browserConsole = [];

    page.on('console', (msg) => {
        const text = msg.text();
        if (
            text.includes('[Boxer]') ||
            text.includes('SAM3') ||
            text.includes('direct lift') ||
            msg.type() === 'error'
        ) {
            browserConsole.push({
                type: msg.type(),
                text: text.slice(0, 1000)
            });
        }
    });
    page.on('pageerror', (err) => {
        browserConsole.push({
            type: 'pageerror',
            text: err.message.slice(0, 1000)
        });
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: loadTimeoutMs });
    await page.waitForFunction(
        () => !!window.supersplatDebug?.runBoxerEvalCase,
        null,
        { timeout: loadTimeoutMs }
    );
    await waitForLoadedSplat(page, loadTimeoutMs);
    await installReplayConfig(page, args);

    return { browser, page, browserConsole };
};

const runReplayEnvelope = async (page, evalCase, caseTimeoutMs) => {
    const started = performance.now();
    const envelope = await withTimeout(
        page.evaluate(async (input) => {
            const replay = await window.supersplatDebug.runBoxerEvalCase(input);
            return {
                replay,
                click_debug: window.__lastBoxerClickDebug ?? null
            };
        }, evalCase),
        caseTimeoutMs,
        `Timed out after ${caseTimeoutMs}ms`
    );
    return {
        ...envelope.replay,
        click_debug: envelope.click_debug,
        replay_wall_ms: performance.now() - started
    };
};

const samSucceeded = (result) => {
    const sam3 = result.sam3_augmentation ?? result.candidate_debug?.sam3;
    const region = sam3?.region;
    const attempts = sam3?.debug?.attempts ?? [];
    return !!region &&
        finite(region.point_count) &&
        region.point_count >= 24 &&
        attempts.some(attempt => attempt?.ok);
};

const hasRequiredBrushPoints = (result) => {
    const replayPrompt = result.replay_prompt;
    const sourcePrompt = result.source_prompt;
    if (
        replayPrompt?.type !== 'client_brush' &&
        sourcePrompt?.type !== 'client_brush' &&
        replayPrompt?.type !== 'brush_sam' &&
        sourcePrompt?.type !== 'brush_sam'
    ) return true;
    const points = replayPrompt?.brush?.points ?? sourcePrompt?.brush?.points;
    const consumedPointCount = result.report?.client_brush?.brush_stroke_point_count ??
        result.candidate_debug?.client_brush?.brush_stroke_point_count;
    return (Array.isArray(points) && points.length > 0) ||
        (Number.isFinite(consumedPointCount) && consumedPointCount > 0);
};

const evalCaseHasRequiredBrushPoints = (evalCase) => {
    if (evalCase.prompt?.type !== 'client_brush' && evalCase.prompt?.type !== 'brush_sam') return true;
    const points = evalCase.prompt?.brush?.points;
    return Array.isArray(points) && points.length > 0;
};

const buildTargetLeakCheck = async ({ page, evalCase, baselineReplay, caseTimeoutMs, args }) => {
    if (!args.verifyTargetLeak) return null;
    if (isTargetDependentPrompt(evalCase.prompt)) {
        return {
            checked: false,
            skipped: true,
            reason: `${evalCase.prompt?.type} intentionally uses target geometry as input`
        };
    }

    const mutatedTarget = mutateTarget(evalCase.target, args.targetLeakOffset);
    if (!mutatedTarget) {
        return {
            checked: false,
            skipped: true,
            reason: 'case has no mutable target'
        };
    }

    const mutatedCase = {
        ...evalCase,
        target: mutatedTarget
    };
    const mutatedReplay = await runReplayEnvelope(page, mutatedCase, caseTimeoutMs);
    const baselineSignature = runtimeSignature(baselineReplay);
    const mutatedSignature = runtimeSignature(mutatedReplay);
    const difference = findFirstDifference(baselineSignature, mutatedSignature);

    return {
        checked: true,
        passed: !difference,
        mutation: {
            offset: args.targetLeakOffset ?? [13.37, -7.11, 5.29],
            baseline_target: evalCase.target,
            mutated_target: mutatedTarget
        },
        first_difference: difference,
        baseline_metrics: {
            aabb_iou: baselineReplay.metrics?.aabb_iou,
            center_distance: baselineReplay.metrics?.center_distance,
            bb2d_iou: baselineReplay.boxer_result?.bb2d_target_metrics?.bb2d_iou ??
                baselineReplay.direct_lift_probe?.candidates?.[0]?.bb2d_target_metrics?.bb2d_iou
        },
        mutated_metrics: {
            aabb_iou: mutatedReplay.metrics?.aabb_iou,
            center_distance: mutatedReplay.metrics?.center_distance,
            bb2d_iou: mutatedReplay.boxer_result?.bb2d_target_metrics?.bb2d_iou ??
                mutatedReplay.direct_lift_probe?.candidates?.[0]?.bb2d_target_metrics?.bb2d_iou
        }
    };
};

const runCase = async ({ page, browserConsole, evalCase, caseTimeoutMs, args }) => {
    const consoleStart = browserConsole.length;
    const replay = await runReplayEnvelope(page, evalCase, caseTimeoutMs);
    const result = {
        ok: true,
        ...compactReplay(evalCase, replay)
    };
    const targetLeakCheck = await buildTargetLeakCheck({ page, evalCase, baselineReplay: replay, caseTimeoutMs, args });
    if (targetLeakCheck) result.target_leak_check = targetLeakCheck;
    attachCaseReport(result);
    return {
        ...result,
        browser_console: browserConsole.slice(consoleStart)
    };
};

const runCaseInFreshBrowser = async ({ chromium, url, evalCase, headless, loadTimeoutMs, caseTimeoutMs, args }) => {
    const width = Math.max(320, Math.round(evalCase.frame?.image_width ?? 1280));
    const height = Math.max(320, Math.round(evalCase.frame?.image_height ?? 820));
    const browser = await launchBrowser(chromium, headless);
    const context = await browser.newContext({
        viewport: { width, height },
        permissions: ['clipboard-read', 'clipboard-write']
    });
    const page = await context.newPage();
    await installReplayConfig(page, args);
    const browserConsole = [];
    page.on('console', (msg) => {
        const text = msg.text();
        if (
            text.includes('[Boxer]') ||
            text.includes('SAM3') ||
            text.includes('direct lift') ||
            msg.type() === 'error'
        ) {
            browserConsole.push({
                type: msg.type(),
                text: text.slice(0, 1000)
            });
        }
    });
    page.on('pageerror', (err) => {
        browserConsole.push({
            type: 'pageerror',
            text: err.message.slice(0, 1000)
        });
    });

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: loadTimeoutMs });
        await page.waitForFunction(
            () => !!window.supersplatDebug?.runBoxerEvalCase,
            null,
            { timeout: loadTimeoutMs }
        );
        await waitForLoadedSplat(page, loadTimeoutMs);
        await installReplayConfig(page, args);

        const replay = await runReplayEnvelope(page, evalCase, caseTimeoutMs);
        const result = { ok: true, ...compactReplay(evalCase, replay) };
        const targetLeakCheck = await buildTargetLeakCheck({ page, evalCase, baselineReplay: replay, caseTimeoutMs, args });
        if (targetLeakCheck) result.target_leak_check = targetLeakCheck;
        attachCaseReport(result);
        return { ...result, browser_console: browserConsole };
    } finally {
        await browser.close().catch(() => {});
    }
};

const main = async () => {
    const args = parseArgs(process.argv);
    const { chromium } = tryLoadPlaywright();
    const loadedCases = await parseEvalCases(args.file);
    const cases = filterCases(loadedCases, args);
    const results = [];

    console.log(`Replaying ${cases.length} Boxer eval case(s) against ${args.url}`);

    const evalCases = cases.map(evalCase => withPromptOverride(evalCase, args));
    if (args.requireBrushPoints) {
        const missingBrushPoints = evalCases.filter(evalCase => !evalCaseHasRequiredBrushPoints(evalCase));
        if (missingBrushPoints.length > 0) {
            throw new Error(`Brush point verification failed before replay for ${missingBrushPoints.length} case(s): ${missingBrushPoints.map((evalCase, index) => evalCase.id ?? evalCase.captured_at ?? `case-${index + 1}`).join(', ')}`);
        }
    }
    if (args.fusion) {
        console.log(`Running Boxer multi-view fusion for ${evalCases.length} case(s)`);
        const fusion = await runFusion({ chromium, url: args.url, evalCases, args });
        await writeResults(args.out, fusion);
        const summary = {
            groups: fusion.groups?.length ?? 0,
            avg_iou: average((fusion.groups ?? []).map(group => group.metrics?.aabb_iou)),
            groups_detail: (fusion.groups ?? []).map((group, index) => ({
                index,
                valid_views: group.valid_views,
                min_views: group.min_views,
                selected_point_count: group.selected_point_count,
                iou: group.metrics?.aabb_iou,
                center_distance: group.metrics?.center_distance,
                error: group.error
            }))
        };
        console.log('Fusion summary:', JSON.stringify(summary, null, 2));
        if (args.out) console.log(`Wrote fusion results to ${args.out}`);
        if (args.printResults) console.log(JSON.stringify(fusion, null, 2));
        return;
    }

    let replayPage = null;
    if (evalCases.length > 0 && !args.freshBrowser) {
        replayPage = await createReplayPage({
            chromium,
            url: args.url,
            firstCase: evalCases[0],
            headless: args.headless,
            loadTimeoutMs: args.loadTimeoutMs,
            args
        });
    }

    for (let i = 0; i < evalCases.length; i++) {
        const evalCase = evalCases[i];
        const id = evalCase.id ?? evalCase.captured_at ?? `case-${i + 1}`;
        const consoleStart = replayPage?.browserConsole.length ?? 0;
        process.stdout.write(`[${i + 1}/${cases.length}] ${id} ... `);

        try {
            const result = replayPage ?
                await runCase({
                    page: replayPage.page,
                    browserConsole: replayPage.browserConsole,
                    evalCase,
                    caseTimeoutMs: args.caseTimeoutMs,
                    args
                }) :
                await runCaseInFreshBrowser({
                    chromium,
                    url: args.url,
                    evalCase,
                    headless: args.headless,
                    loadTimeoutMs: args.loadTimeoutMs,
                    caseTimeoutMs: args.caseTimeoutMs,
                    args
                });
            results.push(result);
            console.log(`ok label=${result.label} iou=${result.metrics?.aabb_iou?.toFixed?.(3) ?? 'n/a'} center=${result.metrics?.center_distance?.toFixed?.(3) ?? 'n/a'} ms=${result.replay_wall_ms?.toFixed?.(0) ?? 'n/a'}`);
        } catch (err) {
            const result = {
                ok: false,
                id,
                input_camera_changed: !!evalCase.camera_changed_since_boxer_run,
                error: err instanceof Error ? err.message : String(err),
                browser_console: replayPage?.browserConsole.slice(consoleStart) ?? []
            };
            results.push(result);
            console.log(`failed: ${result.error}`);
        }

        await writeResults(args.out, results);
    }

    if (replayPage) {
        await replayPage.browser.close().catch(() => {});
    }

    let aggregateGroups = [];
    if (args.aggregateTargetGroups) {
        aggregateGroups = addAggregateTargetGroups(results);
        await writeResults(args.out, results);
    }

    const summary = summarizeResults(results, { detail: args.summaryDetail });
    if (args.aggregateTargetGroups) {
        summary.aggregate_target_groups = aggregateGroups.map(group => ({
            case_count: group.case_count,
            aabb_iou: group.aabb_iou,
            center_distance: group.center_distance
        }));
    }
    console.log('Summary:', JSON.stringify(summary, null, 2));
    if (args.out) console.log(`Wrote replay results to ${args.out}`);
    if (args.printResults) console.log(JSON.stringify(results, null, 2));
    if (args.verifyTargetLeak) {
        const failedLeakChecks = results.filter(result => result.target_leak_check?.checked && !result.target_leak_check.passed);
        if (failedLeakChecks.length > 0) {
            console.error(`Target leak verification failed for ${failedLeakChecks.length} case(s): ${failedLeakChecks.map(result => result.id).join(', ')}`);
            process.exitCode = 1;
        }
    }
    if (args.requireSamSuccess) {
        const failedSam = results.filter(result => result.ok && !samSucceeded(result));
        if (failedSam.length > 0) {
            console.error(`SAM success verification failed for ${failedSam.length} case(s): ${failedSam.map(result => result.id).join(', ')}`);
            process.exitCode = 1;
        }
    }
    if (args.requireBrushPoints) {
        const failedBrush = results.filter(result => result.ok && !hasRequiredBrushPoints(result));
        if (failedBrush.length > 0) {
            console.error(`Brush point verification failed for ${failedBrush.length} case(s): ${failedBrush.map(result => result.id).join(', ')}`);
            process.exitCode = 1;
        }
    }
};

main().catch((err) => {
    console.error(err instanceof Error ? err.stack : err);
    process.exit(1);
});
