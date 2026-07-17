import assert from 'node:assert/strict';
import test from 'node:test';

import {
    DEFAULT_POINT_CLOUD_BOUNDARY_SETTINGS,
    calculatePointCloudBoundaryState,
    deriveAutomaticSceneEnvelope,
    deriveRobustAutomaticBounds,
    sanitizePointCloudBoundarySettings,
    signedDistanceToAutomaticSceneEnvelope,
    signedDistanceToOrientedBox,
    type PointCloudBoundarySettings
} from '../src/point-cloud-boundary.ts';

const identityBox = {
    center: [0, 0, 0] as [number, number, number],
    halfExtents: [5, 4, 3] as [number, number, number],
    rotation: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1]
    ] as [[number, number, number], [number, number, number], [number, number, number]]
};

const settings = (patch: Partial<PointCloudBoundarySettings> = {}): PointCloudBoundarySettings => ({
    enabled: true,
    boundsMode: 'manual',
    preview: 'automatic',
    fadeWidth: 2,
    automaticShape: 'footprint',
    automaticTrimPercent: 0.5,
    automaticPadding: 0.35,
    pointShape: 'fixed',
    pointRadius: 2,
    gaussianScale: 0.25,
    pointOpacity: 1,
    pointTint: [1, 1, 1],
    pointTintStrength: 0,
    pointSaturation: 1,
    manualBounds: identityBox,
    ...patch
});

test('oriented box distance is negative inside, zero on the face, and positive outside', () => {
    assert.equal(signedDistanceToOrientedBox([0, 0, 0], identityBox), -3);
    assert.equal(signedDistanceToOrientedBox([5, 0, 0], identityBox), 0);
    assert.equal(signedDistanceToOrientedBox([7, 0, 0], identityBox), 2);
});

test('oriented box distance follows rotated local axes', () => {
    const rotated = {
        center: [0, 0, 0] as [number, number, number],
        halfExtents: [2, 1, 1] as [number, number, number],
        rotation: [
            [0, 0, 1],
            [0, 1, 0],
            [-1, 0, 0]
        ] as [[number, number, number], [number, number, number], [number, number, number]]
    };

    assert.equal(signedDistanceToOrientedBox([0, 0, 2], rotated), 0);
    assert.equal(signedDistanceToOrientedBox([0, 0, 3], rotated), 1);
    assert.equal(signedDistanceToOrientedBox([1, 0, 0], rotated), 0);
});

test('automatic state stays Gaussian inside and transitions only after crossing the boundary', () => {
    assert.deepEqual(calculatePointCloudBoundaryState(settings(), [-3, 0, 0]), {
        signedDistance: -2,
        weight: 0,
        boundsMode: 'manual'
    });
    assert.equal(calculatePointCloudBoundaryState(settings(), [5, 0, 0]).weight, 0);
    assert.equal(calculatePointCloudBoundaryState(settings(), [6, 0, 0]).weight, 0.5);
    assert.equal(calculatePointCloudBoundaryState(settings(), [7, 0, 0]).weight, 1);
});

test('forced previews are deterministic and disabled effects stay at reconstruction rendering', () => {
    assert.equal(calculatePointCloudBoundaryState(settings({ preview: 'inside' }), [100, 0, 0]).weight, 0);
    assert.equal(calculatePointCloudBoundaryState(settings({ preview: 'boundary' }), [100, 0, 0]).weight, 0.5);
    assert.equal(calculatePointCloudBoundaryState(settings({ preview: 'outside' }), [0, 0, 0]).weight, 1);
    assert.equal(calculatePointCloudBoundaryState(settings({ enabled: false, preview: 'outside' }), [100, 0, 0]).weight, 0);
});

test('robust automatic bounds ignore hidden, deleted, invalid, and extreme floater centers', () => {
    const samples = [
        { position: [0, 0, 0] as [number, number, number], visible: true, deleted: false },
        { position: [1, 1, 1] as [number, number, number], visible: true, deleted: false },
        { position: [2, 2, 2] as [number, number, number], visible: true, deleted: false },
        { position: [3, 3, 3] as [number, number, number], visible: true, deleted: false },
        { position: [500, 500, 500] as [number, number, number], visible: true, deleted: false },
        { position: [-500, -500, -500] as [number, number, number], visible: false, deleted: false },
        { position: [400, 400, 400] as [number, number, number], visible: true, deleted: true },
        { position: [Number.NaN, 0, 0] as [number, number, number], visible: true, deleted: false }
    ];
    const result = deriveRobustAutomaticBounds(samples);

    assert.deepEqual(result?.center, [1.5, 1.5, 1.5]);
    assert.deepEqual(result?.halfExtents, [1.5, 1.5, 1.5]);
});

test('automatic footprint detects empty courtyards that remain inside a scene box', () => {
    const samples = [];
    for (let x = 0; x <= 8; x += 0.25) {
        for (let z = 0; z <= 8; z += 0.25) {
            if (x < 2 || x > 6 || z < 2 || z > 6) {
                samples.push({
                    position: [x, 0, z] as [number, number, number],
                    visible: true,
                    deleted: false
                });
            }
        }
    }
    const envelope = deriveAutomaticSceneEnvelope(samples, 0, 0.2);
    assert.ok(envelope);
    assert.ok(signedDistanceToAutomaticSceneEnvelope([1, 0, 4], envelope) < 0);
    assert.ok(signedDistanceToAutomaticSceneEnvelope([4, 0, 4], envelope) > 0);
    assert.ok(signedDistanceToOrientedBox([4, 0, 4], envelope.bounds) < 0);
});

test('document settings reject malformed values and retain a safe manual volume', () => {
    const result = sanitizePointCloudBoundarySettings({
        enabled: true,
        boundsMode: 'manual',
        preview: 'automatic',
        fadeWidth: -5,
        automaticShape: 'invalid',
        automaticTrimPercent: 50,
        automaticPadding: -50,
        pointShape: 'gaussian',
        pointRadius: 200,
        gaussianScale: 10,
        pointOpacity: 4,
        pointTint: [2, -1, 0.5],
        pointTintStrength: 2,
        pointSaturation: -1,
        manualBounds: {
            center: [1, 2, 3],
            halfExtents: [-1, 0, 4],
            rotation: identityBox.rotation
        }
    });

    assert.equal(result.fadeWidth, 0.01);
    assert.equal(result.automaticShape, 'footprint');
    assert.equal(result.automaticTrimPercent, 5);
    assert.equal(result.automaticPadding, -5);
    assert.equal(result.pointShape, 'gaussian');
    assert.equal(result.pointRadius, 8);
    assert.equal(result.gaussianScale, 2);
    assert.equal(result.pointOpacity, 1);
    assert.deepEqual(result.pointTint, [1, 0, 0.5]);
    assert.equal(result.pointTintStrength, 1);
    assert.equal(result.pointSaturation, 0);
    assert.deepEqual(result.manualBounds?.halfExtents, [0.01, 0.01, 4]);
});

test('missing document settings enable automatic bounds out of the box', () => {
    assert.deepEqual(sanitizePointCloudBoundarySettings(undefined), DEFAULT_POINT_CLOUD_BOUNDARY_SETTINGS);
});
