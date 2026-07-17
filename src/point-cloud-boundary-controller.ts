import { Vec3 } from 'playcanvas';

import { ElementType } from './element';
import { Events } from './events';
import {
    DEFAULT_POINT_CLOUD_BOUNDARY_SETTINGS,
    calculatePointCloudBoundaryState,
    deriveRobustAutomaticBounds,
    sanitizePointCloudBoundarySettings,
    type AutomaticBoundsSample,
    type OrientedBounds,
    type PointCloudBoundarySettings,
    type PointCloudBoundaryState,
    type Vec3Tuple
} from './point-cloud-boundary';
import { Scene } from './scene';
import { Splat } from './splat';
import { State } from './splat-state';

type PointCloudBoundaryRuntimeState = PointCloudBoundaryState & {
    enabled: boolean;
    pointRadius: number;
    pointOpacity: number;
    preview: PointCloudBoundarySettings['preview'];
    hasBounds: boolean;
};

const MAX_AUTOMATIC_BOUND_SAMPLES = 100000;
const position = new Vec3();

const cloneSettings = (settings: PointCloudBoundarySettings): PointCloudBoundarySettings => ({
    ...settings,
    manualBounds: settings.manualBounds ? {
        center: [...settings.manualBounds.center],
        halfExtents: [...settings.manualBounds.halfExtents],
        rotation: settings.manualBounds.rotation.map(axis => [...axis]) as OrientedBounds['rotation']
    } : null
});

const registerPointCloudBoundaryEvents = (events: Events, scene: Scene) => {
    let settings = cloneSettings(DEFAULT_POINT_CLOUD_BOUNDARY_SETTINGS);
    let automaticBounds: OrientedBounds | null = null;
    let automaticBoundsDirty = true;
    let automaticBoundsRetryAt = 0;
    let canonicalCaptureDepth = 0;
    const deletedCounts = new WeakMap<Splat, number>();
    let runtimeState: PointCloudBoundaryRuntimeState = {
        enabled: false,
        signedDistance: null,
        weight: 0,
        boundsMode: settings.boundsMode,
        pointRadius: settings.pointRadius,
        pointOpacity: settings.pointOpacity,
        preview: settings.preview,
        hasBounds: false
    };

    const invalidateAutomaticBounds = () => {
        automaticBoundsDirty = true;
        automaticBoundsRetryAt = 0;
    };

    const collectAutomaticBounds = () => {
        const splats = scene.getElementsByType(ElementType.splat) as Splat[];
        const total = splats.reduce((sum, splat) => sum + (splat.visible ? splat.splatData.numSplats : 0), 0);
        const stride = Math.max(1, Math.ceil(total / MAX_AUTOMATIC_BOUND_SAMPLES));
        const samples: AutomaticBoundsSample[] = [];
        for (const splat of splats) {
            if (!splat.visible) continue;
            deletedCounts.set(splat, splat.numDeleted);
            const centers = splat.entity.gsplat.instance.sorter?.centers as Float32Array | undefined;
            const states = splat.splatData.getProp('state') as Uint8Array | undefined;
            if (!centers) continue;
            for (let index = 0; index < centers.length / 3; index += stride) {
                const deleted = !!states && (states[index] & State.deleted) !== 0;
                position.set(centers[index * 3], centers[index * 3 + 1], centers[index * 3 + 2]);
                splat.worldTransform.transformPoint(position, position);
                samples.push({
                    position: [position.x, position.y, position.z],
                    visible: true,
                    deleted
                });
            }
        }
        automaticBounds = deriveRobustAutomaticBounds(samples);
        // Splat elements can be added before their sorter centers are uploaded. Keep
        // retrying until a populated scene yields usable bounds instead of caching the
        // first empty result for the rest of the session.
        automaticBoundsDirty = total > 0 && samples.length === 0;
    };

    const setSettings = (value: unknown) => {
        settings = sanitizePointCloudBoundarySettings(value);
        scene.forceRender = true;
        events.fire('pointCloudBoundary.settings', cloneSettings(settings));
    };

    const patchSettings = (patch: Partial<PointCloudBoundarySettings>) => {
        setSettings({ ...settings, ...patch });
    };

    const togglePointView = () => {
        const forced = settings.enabled && settings.preview === 'outside';
        patchSettings(forced ? {
            enabled: false,
            preview: 'automatic'
        } : {
            enabled: true,
            preview: 'outside'
        });
    };

    const useCurrentBox = () => {
        const current = events.invoke('boxVolume.currentBox') as {
            ready?: boolean;
            center?: Vec3Tuple;
            dimensions?: Vec3Tuple;
            rotation?: OrientedBounds['rotation'];
        } | undefined;
        if (!current?.ready || !current.center || !current.dimensions || !current.rotation) return false;
        patchSettings({
            boundsMode: 'manual',
            manualBounds: {
                center: [...current.center],
                halfExtents: current.dimensions.map(value => Math.max(0.01, Math.abs(value) * 0.5)) as Vec3Tuple,
                rotation: current.rotation.map(axis => [...axis]) as OrientedBounds['rotation']
            }
        });
        return true;
    };

    const renderSample = () => new Promise<{ durationMs: number; drawCalls: number | null }>((resolve) => {
        const startedAt = performance.now();
        events.once('postrender', () => resolve({
            durationMs: performance.now() - startedAt,
            drawCalls: (scene.app as any).stats?.drawCalls?.total ?? null
        }));
        scene.forceRender = true;
    });

    const percentile = (values: number[], fraction: number) => {
        const sorted = [...values].sort((a, b) => a - b);
        return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
    };

    const benchmark = async (options: { samples?: number } = {}) => {
        const sampleCount = Math.max(5, Math.min(120, Math.floor(options.samples ?? 30)));
        const saved = cloneSettings(settings);
        const results: Record<string, {
            p50Ms: number;
            p95Ms: number;
            maxMs: number;
            drawCalls: Array<number | null>;
            samples: number[];
        }> = {};
        try {
            for (const preview of ['inside', 'boundary', 'outside'] as const) {
                patchSettings({ enabled: true, preview });
                await renderSample();
                await renderSample();
                const rendered = [];
                for (let index = 0; index < sampleCount; index++) rendered.push(await renderSample());
                const samples = rendered.map(sample => sample.durationMs);
                results[preview] = {
                    p50Ms: percentile(samples, 0.5),
                    p95Ms: percentile(samples, 0.95),
                    maxMs: Math.max(...samples),
                    drawCalls: rendered.map(sample => sample.drawCalls),
                    samples
                };
            }
        } finally {
            setSettings(saved);
        }
        const gl = scene.canvas.getContext('webgl2');
        const rendererInfo = gl?.getExtension('WEBGL_debug_renderer_info');
        return {
            renderer: gl && rendererInfo ? gl.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL) : null,
            fullScenePasses: 1,
            sampleCount,
            results
        };
    };

    const update = () => {
        const now = performance.now();
        if (settings.boundsMode === 'automatic' && automaticBoundsDirty && now >= automaticBoundsRetryAt) {
            collectAutomaticBounds();
            automaticBoundsRetryAt = now + 250;
        }
        const camera = scene.camera.position;
        const calculated = calculatePointCloudBoundaryState(
            settings,
            [camera.x, camera.y, camera.z],
            automaticBounds
        );
        const next: PointCloudBoundaryRuntimeState = {
            ...calculated,
            enabled: settings.enabled,
            pointRadius: settings.pointRadius,
            pointOpacity: settings.pointOpacity,
            preview: settings.preview,
            hasBounds: calculated.signedDistance !== null
        };
        const changed = next.enabled !== runtimeState.enabled ||
            next.weight !== runtimeState.weight ||
            next.signedDistance !== runtimeState.signedDistance ||
            next.boundsMode !== runtimeState.boundsMode ||
            next.pointRadius !== runtimeState.pointRadius ||
            next.pointOpacity !== runtimeState.pointOpacity ||
            next.preview !== runtimeState.preview ||
            next.hasBounds !== runtimeState.hasBounds;
        runtimeState = next;
        if (changed) {
            scene.forceRender = true;
            events.fire('pointCloudBoundary.state', { ...runtimeState });
        }
    };

    events.function('pointCloudBoundary.settings', () => cloneSettings(settings));
    events.function('pointCloudBoundary.state', () => ({ ...runtimeState }));
    events.function('pointCloudBoundary.renderState', () => {
        return canonicalCaptureDepth > 0 ? {
            ...runtimeState,
            enabled: false,
            weight: 0
        } : { ...runtimeState };
    });
    events.function('pointCloudBoundary.beginCanonicalCapture', () => {
        canonicalCaptureDepth++;
        scene.forceRender = true;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            canonicalCaptureDepth = Math.max(0, canonicalCaptureDepth - 1);
            scene.forceRender = true;
        };
    });
    events.function('pointCloudBoundary.automaticBounds', () => automaticBounds);
    events.function('pointCloudBoundary.diagnostics', () => {
        const appStats = (scene.app as any).stats;
        return {
            ...runtimeState,
            settings: cloneSettings(settings),
            automaticBounds,
            frameTimeMs: appStats?.frame?.ms ?? null,
            gpuTimeMs: appStats?.frame?.gpuMs ?? null,
            drawCalls: appStats?.drawCalls?.total ?? null,
            fullScenePasses: 1
        };
    });
    events.function('pointCloudBoundary.useCurrentBox', useCurrentBox);
    events.function('pointCloudBoundary.benchmark', benchmark);
    events.function('docSerialize.pointCloudBoundary', () => cloneSettings(settings));
    events.function('docDeserialize.pointCloudBoundary', (value: unknown) => setSettings(value));

    events.on('pointCloudBoundary.set', setSettings);
    events.on('pointCloudBoundary.patch', patchSettings);
    events.on('pointCloudBoundary.togglePointView', togglePointView);
    events.on('scene.elementAdded', invalidateAutomaticBounds);
    events.on('scene.elementRemoved', invalidateAutomaticBounds);
    events.on('splat.stateChanged', (splat: Splat) => {
        const previous = deletedCounts.get(splat);
        deletedCounts.set(splat, splat.numDeleted);
        if (previous === undefined || previous !== splat.numDeleted) invalidateAutomaticBounds();
    });
    events.on('splat.positionsChanged', invalidateAutomaticBounds);
    events.on('splat.moved', invalidateAutomaticBounds);
    events.on('splat.visibility', invalidateAutomaticBounds);
    events.on('update', update);

    events.fire('pointCloudBoundary.settings', cloneSettings(settings));
};

export { registerPointCloudBoundaryEvents };
export type { PointCloudBoundaryRuntimeState };
