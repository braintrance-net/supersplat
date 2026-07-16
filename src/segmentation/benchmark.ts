type MaskMetrics = {
    iou: number;
    precision: number;
    recall: number;
};

type BenchmarkRun = {
    ok: boolean;
    totalMs: number;
};

type BoundaryMetrics = {
    precision: number;
    recall: number;
    fScore: number;
};

const assertMaskStorage = (mask: Uint8Array, width: number, height: number) => {
    if (mask.length !== width * height) {
        throw new Error('Mask metric dimensions do not match pixel storage.');
    }
};

const calculateMaskMetrics = (
    predicted: Uint8Array,
    golden: Uint8Array,
    width: number,
    height: number
): MaskMetrics => {
    const expectedLength = width * height;
    assertMaskStorage(predicted, width, height);
    assertMaskStorage(golden, width, height);
    let intersection = 0;
    let predictedCount = 0;
    let goldenCount = 0;
    for (let index = 0; index < expectedLength; index++) {
        const predictedValue = predicted[index] > 0;
        const goldenValue = golden[index] > 0;
        if (predictedValue) predictedCount++;
        if (goldenValue) goldenCount++;
        if (predictedValue && goldenValue) intersection++;
    }
    const union = predictedCount + goldenCount - intersection;
    return {
        iou: union === 0 ? 1 : intersection / union,
        precision: predictedCount === 0 ? (goldenCount === 0 ? 1 : 0) : intersection / predictedCount,
        recall: goldenCount === 0 ? (predictedCount === 0 ? 1 : 0) : intersection / goldenCount
    };
};

const extractBoundary = (mask: Uint8Array, width: number, height: number) => {
    assertMaskStorage(mask, width, height);
    const boundary = new Uint8Array(mask.length);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const index = y * width + x;
            if (mask[index] === 0) continue;
            if (
                x === 0 || x === width - 1 || y === 0 || y === height - 1 ||
                mask[index - 1] === 0 || mask[index + 1] === 0 ||
                mask[index - width] === 0 || mask[index + width] === 0
            ) {
                boundary[index] = 1;
            }
        }
    }
    return boundary;
};

const dilateBoundary = (boundary: Uint8Array, width: number, height: number, tolerance: number) => {
    const radius = Math.max(0, Math.floor(tolerance));
    if (radius === 0) return boundary;
    const dilated = new Uint8Array(boundary.length);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (boundary[y * width + x] === 0) continue;
            for (let dy = -radius; dy <= radius; dy++) {
                const yy = y + dy;
                if (yy < 0 || yy >= height) continue;
                for (let dx = -radius; dx <= radius; dx++) {
                    const xx = x + dx;
                    if (xx < 0 || xx >= width || dx * dx + dy * dy > radius * radius) continue;
                    dilated[yy * width + xx] = 1;
                }
            }
        }
    }
    return dilated;
};

const calculateBoundaryFScore = (
    predicted: Uint8Array,
    golden: Uint8Array,
    width: number,
    height: number,
    tolerancePx = 1
): BoundaryMetrics => {
    const predictedBoundary = extractBoundary(predicted, width, height);
    const goldenBoundary = extractBoundary(golden, width, height);
    const predictedTolerance = dilateBoundary(predictedBoundary, width, height, tolerancePx);
    const goldenTolerance = dilateBoundary(goldenBoundary, width, height, tolerancePx);
    let predictedCount = 0;
    let goldenCount = 0;
    let predictedMatches = 0;
    let goldenMatches = 0;
    for (let index = 0; index < predictedBoundary.length; index++) {
        if (predictedBoundary[index]) {
            predictedCount++;
            if (goldenTolerance[index]) predictedMatches++;
        }
        if (goldenBoundary[index]) {
            goldenCount++;
            if (predictedTolerance[index]) goldenMatches++;
        }
    }
    const precision = predictedCount === 0 ? (goldenCount === 0 ? 1 : 0) : predictedMatches / predictedCount;
    const recall = goldenCount === 0 ? (predictedCount === 0 ? 1 : 0) : goldenMatches / goldenCount;
    return {
        precision,
        recall,
        fScore: precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall)
    };
};

const calculateSelectionJaccard = (predicted: ReadonlySet<number>, golden: ReadonlySet<number>) => {
    if (predicted.size === 0 && golden.size === 0) return 1;
    let intersection = 0;
    for (const index of predicted) {
        if (golden.has(index)) intersection++;
    }
    return intersection / (predicted.size + golden.size - intersection);
};

const percentile = (values: number[], fraction: number) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
};

const summarizeBenchmarkRuns = (runs: BenchmarkRun[]) => {
    const successful = runs.filter(run => run.ok).map(run => run.totalMs);
    return {
        totalRuns: runs.length,
        successfulRuns: successful.length,
        failureRate: runs.length === 0 ? 0 : (runs.length - successful.length) / runs.length,
        p50Ms: percentile(successful, 0.5),
        p95Ms: percentile(successful, 0.95)
    };
};

export {
    calculateBoundaryFScore,
    calculateMaskMetrics,
    calculateSelectionJaccard,
    summarizeBenchmarkRuns
};
export type { BenchmarkRun, BoundaryMetrics, MaskMetrics };
