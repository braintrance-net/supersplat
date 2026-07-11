type MultiViewRefinePhase =
    'armed' |
    'processing' |
    'initial-result' |
    'refining' |
    'applied' |
    'abandoned';

type MultiViewRefineSnapshot<T> = {
    phase: MultiViewRefinePhase;
    angleCount: number;
    canApply: boolean;
    latestAngle: T | null;
};

type MultiViewRefineAngle = {
    selectedRanges: [number, number][];
    visibleRanges: [number, number][];
};

const addRanges = (ranges: [number, number][], visit: (index: number) => void) => {
    for (const [start, end] of ranges) {
        for (let index = start; index <= end; index++) {
            visit(index);
        }
    }
};

const combineMultiViewRefineAngles = (angles: MultiViewRefineAngle[]) => {
    const visibleCounts = new Map<number, number>();
    const selectedCounts = new Map<number, number>();

    for (const angle of angles) {
        addRanges(angle.visibleRanges, index => visibleCounts.set(index, (visibleCounts.get(index) ?? 0) + 1));
        addRanges(angle.selectedRanges, index => selectedCounts.set(index, (selectedCounts.get(index) ?? 0) + 1));
    }

    const selected = new Set<number>();
    for (const [index, positiveCount] of selectedCounts) {
        const visibleCount = visibleCounts.get(index) ?? 0;
        if (visibleCount > 0 && positiveCount / visibleCount > 0.5) {
            selected.add(index);
        }
    }
    return selected;
};

class MultiViewRefineSession<T> {
    private phase: MultiViewRefinePhase = 'armed';
    private angles: T[] = [];
    private returnPhase: MultiViewRefinePhase = 'armed';

    snapshot(): MultiViewRefineSnapshot<T> {
        return {
            phase: this.phase,
            angleCount: this.angles.length,
            canApply: this.angles.length >= 2 && this.phase === 'refining',
            latestAngle: this.angles.at(-1) ?? null
        };
    }

    retainedAngles(): readonly T[] {
        return this.angles;
    }

    beginAngle() {
        if (this.phase !== 'armed' && this.phase !== 'refining') {
            throw new Error(`Cannot begin an angle while ${this.phase}.`);
        }
        this.returnPhase = this.phase;
        this.phase = 'processing';
    }

    applyAngle(angle: T) {
        if (this.phase !== 'processing') {
            throw new Error(`Cannot apply an angle while ${this.phase}.`);
        }
        this.angles.push(angle);
        this.phase = this.angles.length === 1 ? 'initial-result' : 'refining';
    }

    failAngle() {
        if (this.phase !== 'processing') {
            return false;
        }
        this.phase = this.returnPhase;
        return true;
    }

    enterRefine() {
        if (this.phase !== 'initial-result') {
            throw new Error(`Cannot enter Refine while ${this.phase}.`);
        }
        this.phase = 'refining';
    }

    undoAngle(): T | null {
        if (this.phase !== 'initial-result' && this.phase !== 'refining') {
            return null;
        }
        const angle = this.angles.pop() ?? null;
        this.phase = this.angles.length === 0 ? 'armed' : 'refining';
        return angle;
    }

    apply() {
        if (!this.snapshot().canApply) {
            return false;
        }
        this.phase = 'applied';
        return true;
    }

    abandon() {
        if (this.phase === 'applied' || this.phase === 'abandoned') {
            return false;
        }
        this.phase = 'abandoned';
        return true;
    }
}

export { MultiViewRefineSession };
export { combineMultiViewRefineAngles };
export type { MultiViewRefineAngle, MultiViewRefinePhase, MultiViewRefineSnapshot };
