type SegmentationProviderId = 'local-sam2' | 'cloud-sam3';
type SegmentationCacheState = 'empty' | 'network' | 'persistent' | 'memory';
type SegmentationOperation = 'set' | 'add' | 'remove' | 'intersect';
type SegmentationPrompt = { x: number; y: number; label: 0 | 1 };
type FrameToMaskTransform = {
    scaleX: number;
    scaleY: number;
    offsetX: number;
    offsetY: number;
};
type SegmentationFrame = {
    rgba: Uint8Array;
    width: number;
    height: number;
    key: string;
    camera: unknown;
};
type SegmentationMask = {
    data: Uint8Array;
    width: number;
    height: number;
    frameToMask: FrameToMaskTransform;
    logits?: Float32Array;
};
type SegmentationTimings = {
    totalMs: number;
    [phase: string]: number;
};
type SegmentationRequest = {
    frame: SegmentationFrame;
    prompts: SegmentationPrompt[];
    signal: AbortSignal;
    priorMask?: Float32Array;
    sessionId?: string;
};
type SegmentationResult = {
    provider: SegmentationProviderId;
    model: string;
    modelDigest: string;
    runtime: string;
    executionProvider: string;
    cacheState: SegmentationCacheState;
    mask: SegmentationMask;
    timings: SegmentationTimings;
    sessionId?: string;
};
type SegmentationProvider = {
    readonly id: SegmentationProviderId;
    segment: (request: SegmentationRequest) => Promise<SegmentationResult>;
};

class SegmentationContractError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SegmentationContractError';
    }
}

const finite = (value: number) => typeof value === 'number' && Number.isFinite(value);

const validateSegmentationResult = (result: SegmentationResult) => {
    if (result.provider !== 'local-sam2' && result.provider !== 'cloud-sam3') {
        throw new SegmentationContractError('Unknown segmentation provider.');
    }
    const { mask } = result;
    if (!Number.isInteger(mask.width) || !Number.isInteger(mask.height) || mask.width <= 0 || mask.height <= 0) {
        throw new SegmentationContractError('Mask dimensions must be positive integers.');
    }
    if (!(mask.data instanceof Uint8Array) || mask.data.length !== mask.width * mask.height) {
        throw new SegmentationContractError('Mask storage does not match its declared dimensions.');
    }
    const transform = mask.frameToMask;
    if (!transform || !finite(transform.scaleX) || !finite(transform.scaleY) ||
        !finite(transform.offsetX) || !finite(transform.offsetY) ||
        transform.scaleX <= 0 || transform.scaleY <= 0) {
        throw new SegmentationContractError('Mask transform must declare finite positive scales and offsets.');
    }
    if (!finite(result.timings.totalMs) || result.timings.totalMs < 0) {
        throw new SegmentationContractError('Provider result must declare a non-negative total timing.');
    }
    return result;
};

const mapFramePointToMask = (
    point: [number, number],
    transform: FrameToMaskTransform
): [number, number] => [
    point[0] * transform.scaleX + transform.offsetX,
    point[1] * transform.scaleY + transform.offsetY
];

const resampleMaskToFrame = (mask: SegmentationMask, frameWidth: number, frameHeight: number) => {
    if (!Number.isInteger(frameWidth) || !Number.isInteger(frameHeight) || frameWidth <= 0 || frameHeight <= 0) {
        throw new SegmentationContractError('Frame dimensions must be positive integers.');
    }
    const output = new Uint8Array(frameWidth * frameHeight);
    for (let y = 0; y < frameHeight; y++) {
        for (let x = 0; x < frameWidth; x++) {
            const [maskX, maskY] = mapFramePointToMask([x + 0.5, y + 0.5], mask.frameToMask);
            const mx = Math.floor(maskX);
            const my = Math.floor(maskY);
            if (mx >= 0 && mx < mask.width && my >= 0 && my < mask.height) {
                output[y * frameWidth + x] = mask.data[my * mask.width + mx];
            }
        }
    }
    return output;
};

const applySelectionOperation = (
    current: ReadonlySet<number>,
    candidate: ReadonlySet<number>,
    operation: SegmentationOperation
) => {
    if (operation === 'set') return new Set(candidate);
    if (operation === 'add') return new Set([...current, ...candidate]);
    if (operation === 'remove') return new Set([...current].filter(id => !candidate.has(id)));
    return new Set([...current].filter(id => candidate.has(id)));
};

type BlindGrade = 'a' | 'b' | 'tie';
type BlindCandidate = {
    mask: SegmentationMask;
};

const blindCandidate = (result: SegmentationResult): BlindCandidate => ({
    mask: result.mask
});

const createBlindComparison = (
    local: SegmentationResult,
    cloud: SegmentationResult,
    random: () => number = Math.random
) => {
    validateSegmentationResult(local);
    validateSegmentationResult(cloud);
    const aResult = random() >= 0.5 ? cloud : local;
    const bResult = aResult === local ? cloud : local;
    let revealed = false;
    return {
        a: blindCandidate(aResult),
        b: blindCandidate(bResult),
        get revealed() {
            return revealed;
        },
        grade: (grade: BlindGrade) => {
            revealed = true;
            return {
                grade,
                mapping: {
                    a: aResult.provider,
                    b: bResult.provider
                },
                results: {
                    a: aResult,
                    b: bResult
                }
            };
        }
    };
};

export {
    SegmentationContractError,
    applySelectionOperation,
    createBlindComparison,
    mapFramePointToMask,
    resampleMaskToFrame,
    validateSegmentationResult
};
export type {
    BlindGrade,
    FrameToMaskTransform,
    SegmentationCacheState,
    SegmentationFrame,
    SegmentationMask,
    SegmentationOperation,
    SegmentationPrompt,
    SegmentationProvider,
    SegmentationProviderId,
    SegmentationRequest,
    SegmentationResult,
    SegmentationTimings
};
