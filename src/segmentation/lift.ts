import { Events } from '../events';
import { Scene } from '../scene';
import { Splat } from '../splat';
import { State } from '../splat-state';
import {
    applySelectionOperation,
    resampleMaskToFrame,
    type SegmentationFrame,
    type SegmentationOperation,
    type SegmentationResult
} from './provider';
import {
    applyArtisanSelectionIndices,
    projectArtisanMaskSelection
} from '../tools/artisan-selection';

type LiftedSegmentation = {
    providerResult: SegmentationResult;
    candidateIds: Set<number>;
    selectedIds: Set<number>;
    projection: ReturnType<typeof projectArtisanMaskSelection>;
    liftMs: number;
};

const currentSelectionIds = (splat: Splat) => {
    const state = splat.splatData.getProp('state') as Uint8Array;
    const selected = new Set<number>();
    for (let index = 0; index < state.length; index++) {
        if ((state[index] & State.selected) !== 0 && (state[index] & State.deleted) === 0) selected.add(index);
    }
    return selected;
};

const liftSegmentationResult = (
    scene: Scene,
    splat: Splat,
    frame: SegmentationFrame,
    result: SegmentationResult,
    operation: SegmentationOperation,
    seed: [number, number],
    baseSelection?: ReadonlySet<number>
): LiftedSegmentation | null => {
    const startedAt = performance.now();
    const frameMask = resampleMaskToFrame(result.mask, frame.width, frame.height);
    const projection = projectArtisanMaskSelection(scene, splat, {
        source: 'click',
        mask: frameMask,
        maskWidth: frame.width,
        maskHeight: frame.height,
        imageWidth: frame.width,
        imageHeight: frame.height,
        op: 'set',
        projectionMode: 'connected-volume',
        seed
    });
    if (!projection) return null;
    const candidateIds = new Set(projection.indices);
    return {
        providerResult: result,
        candidateIds,
        selectedIds: applySelectionOperation(baseSelection ?? currentSelectionIds(splat), candidateIds, operation),
        projection,
        liftMs: performance.now() - startedAt
    };
};

const applyLiftedSegmentation = (events: Events, splat: Splat, lifted: LiftedSegmentation) => {
    return applyArtisanSelectionIndices(events, splat, 'set', lifted.selectedIds);
};

const previewLiftedSegmentation = (splat: Splat, lifted: LiftedSegmentation | null) => {
    if (!lifted) {
        splat.setArtisanConfidencePreview(null);
        return;
    }
    const confidence = new Float32Array(splat.splatData.numSplats);
    for (const index of lifted.selectedIds) confidence[index] = 1;
    splat.setArtisanConfidencePreview(confidence, 0.5, true);
};

export {
    applyLiftedSegmentation,
    currentSelectionIds,
    liftSegmentationResult,
    previewLiftedSegmentation
};
export type { LiftedSegmentation };
