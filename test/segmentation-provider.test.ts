import assert from 'node:assert/strict';
import test from 'node:test';

import {
    applySelectionOperation,
    createBlindComparison,
    formatLocalSegmentationTimings,
    formatSegmentationProvider,
    mapFramePointToMask,
    resampleMaskToFrame,
    validateSegmentationResult,
    type SegmentationResult
} from '../src/segmentation/provider.ts';
import {
    calculateBoundaryFScore,
    calculateMaskMetrics,
    calculateSelectionJaccard,
    summarizeBenchmarkRuns
} from '../src/segmentation/benchmark.ts';

const result = (patch: Partial<SegmentationResult> = {}): SegmentationResult => ({
    provider: 'local-sam2',
    model: 'sam2-hiera-tiny',
    modelDigest: 'sha256:test',
    runtime: 'onnxruntime-web-test',
    executionProvider: 'webgpu',
    cacheState: 'memory',
    mask: {
        data: new Uint8Array([0, 1, 1, 0]),
        width: 2,
        height: 2,
        frameToMask: { scaleX: 0.5, scaleY: 0.5, offsetX: 0, offsetY: 0 }
    },
    timings: { totalMs: 10 },
    ...patch
});

test('provider results require dimension-declared masks with exact storage', () => {
    assert.doesNotThrow(() => validateSegmentationResult(result()));
    assert.throws(() => validateSegmentationResult(result({
        mask: {
            data: new Uint8Array(3),
            width: 2,
            height: 2,
            frameToMask: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 }
        }
    })), /mask storage/i);
    assert.throws(() => validateSegmentationResult(result({
        mask: {
            data: new Uint8Array(4),
            width: 2,
            height: 2,
            frameToMask: { scaleX: Number.NaN, scaleY: 1, offsetX: 0, offsetY: 0 }
        }
    })), /transform/i);
});

test('frame points map through scale and letterbox offsets without guessing', () => {
    assert.deepEqual(mapFramePointToMask([100, 50], {
        scaleX: 0.25,
        scaleY: 0.25,
        offsetX: 0,
        offsetY: 32
    }), [25, 44.5]);
});

test('letterboxed masks resample into canonical frame space without padded pixels', () => {
    const frameMask = resampleMaskToFrame({
        data: new Uint8Array([
            0, 0, 0, 0,
            0, 1, 1, 0,
            0, 1, 1, 0,
            0, 0, 0, 0
        ]),
        width: 4,
        height: 4,
        frameToMask: { scaleX: 1, scaleY: 1, offsetX: 1, offsetY: 1 }
    }, 2, 2);
    assert.deepEqual([...frameMask], [1, 1, 1, 1]);
});

test('selection operations return candidates without mutating either input set', () => {
    const current = new Set([1, 2, 3]);
    const candidate = new Set([3, 4]);

    assert.deepEqual([...applySelectionOperation(current, candidate, 'set')], [3, 4]);
    assert.deepEqual([...applySelectionOperation(current, candidate, 'add')], [1, 2, 3, 4]);
    assert.deepEqual([...applySelectionOperation(current, candidate, 'remove')], [1, 2]);
    assert.deepEqual([...applySelectionOperation(current, candidate, 'intersect')], [3]);
    assert.deepEqual([...current], [1, 2, 3]);
    assert.deepEqual([...candidate], [3, 4]);
});

test('blind comparisons hide provider identity until a grade is recorded', () => {
    const local = result();
    const cloud = result({ provider: 'cloud-sam3', model: 'sam3' });
    const comparison = createBlindComparison(local, cloud, () => 0.9);

    assert.equal(comparison.revealed, false);
    assert.equal(comparison.a.provider, undefined);
    assert.equal(comparison.b.provider, undefined);
    assert.equal('executionProvider' in comparison.a, false);
    const reveal = comparison.grade('a');
    assert.equal(reveal.grade, 'a');
    assert.equal(reveal.mapping.a, 'cloud-sam3');
    assert.equal(reveal.mapping.b, 'local-sam2');
});

test('provider identities use clear labels when a blind comparison is revealed', () => {
    assert.equal(formatSegmentationProvider('local-sam2'), 'Local SAM2');
    assert.equal(formatSegmentationProvider('cloud-sam3'), 'Cloud SAM3');
    assert.equal(formatSegmentationProvider('failed'), 'Failed');
});

test('local timings expose every inference phase and cached encoders', () => {
    assert.equal(formatLocalSegmentationTimings({
        totalMs: 28003,
        initializeMs: 2440,
        preprocessMs: 16,
        encoderMs: 15070,
        decoderMs: 10460,
        postprocessMs: 17
    }, 162), 'total 28.00s · init 2.44s · prep 16ms · encode 15.07s · decode 10.46s · post 17ms · 3D lift 162ms');
    assert.match(formatLocalSegmentationTimings({
        totalMs: 122,
        initializeMs: 0,
        preprocessMs: 0,
        encoderMs: 0,
        decoderMs: 118,
        postprocessMs: 4
    }, 8), /encode cached/);
});

test('mask metrics use golden pixels as an independent answer key', () => {
    const metrics = calculateMaskMetrics(
        new Uint8Array([1, 1, 0, 0]),
        new Uint8Array([1, 0, 1, 0]),
        2,
        2
    );
    assert.equal(metrics.iou, 1 / 3);
    assert.equal(metrics.precision, 0.5);
    assert.equal(metrics.recall, 0.5);
});

test('benchmark summaries include failures and separate p50 from p95', () => {
    const summary = summarizeBenchmarkRuns([
        { ok: true, totalMs: 10 },
        { ok: true, totalMs: 20 },
        { ok: true, totalMs: 30 },
        { ok: false, totalMs: 5 }
    ]);
    assert.equal(summary.totalRuns, 4);
    assert.equal(summary.failureRate, 0.25);
    assert.equal(summary.p50Ms, 20);
    assert.equal(summary.p95Ms, 30);
});

test('boundary F-score tolerates a one-pixel contour shift only when requested', () => {
    const golden = new Uint8Array([
        0, 0, 0, 0, 0,
        0, 1, 1, 0, 0,
        0, 1, 1, 0, 0,
        0, 0, 0, 0, 0
    ]);
    const shifted = new Uint8Array([
        0, 0, 0, 0, 0,
        0, 0, 1, 1, 0,
        0, 0, 1, 1, 0,
        0, 0, 0, 0, 0
    ]);

    assert.ok(calculateBoundaryFScore(shifted, golden, 5, 4, 0).fScore < 1);
    assert.equal(calculateBoundaryFScore(shifted, golden, 5, 4, 1).fScore, 1);
});

test('candidate cut Jaccard reports exact overlap and handles two empty cuts', () => {
    assert.equal(calculateSelectionJaccard(new Set([1, 2, 3]), new Set([2, 3, 4])), 0.5);
    assert.equal(calculateSelectionJaccard(new Set(), new Set()), 1);
});
