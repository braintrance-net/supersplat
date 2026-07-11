import assert from 'node:assert/strict';
import test from 'node:test';

import {
    MultiViewRefineSession,
    combineMultiViewRefineAngles
} from '../src/tools/multi-view-refine-session.ts';

test('Apply unlocks only after two retained angles in persistent Refine mode', () => {
    const session = new MultiViewRefineSession<string>();

    assert.deepEqual(session.snapshot(), {
        phase: 'armed',
        angleCount: 0,
        canApply: false,
        latestAngle: null
    });

    session.beginAngle();
    session.applyAngle('front');
    assert.equal(session.snapshot().phase, 'initial-result');
    assert.equal(session.snapshot().canApply, false);

    session.enterRefine();
    session.beginAngle();
    session.applyAngle('side');

    assert.deepEqual(session.snapshot(), {
        phase: 'refining',
        angleCount: 2,
        canApply: true,
        latestAngle: 'side'
    });
    assert.equal(session.apply(), true);
    assert.equal(session.snapshot().phase, 'applied');
});

test('Ctrl-Z pops angles last-in-first-out and re-locks Apply', () => {
    const session = new MultiViewRefineSession<string>();
    session.beginAngle();
    session.applyAngle('front');
    session.enterRefine();
    session.beginAngle();
    session.applyAngle('side');
    session.beginAngle();
    session.applyAngle('back');

    assert.equal(session.undoAngle(), 'back');
    assert.equal(session.snapshot().angleCount, 2);
    assert.equal(session.snapshot().canApply, true);

    assert.equal(session.undoAngle(), 'side');
    assert.deepEqual(session.snapshot(), {
        phase: 'refining',
        angleCount: 1,
        canApply: false,
        latestAngle: 'front'
    });

    assert.equal(session.undoAngle(), 'front');
    assert.equal(session.snapshot().phase, 'armed');
});

test('A failed SAM angle restores the exact state before processing', () => {
    const session = new MultiViewRefineSession<string>();
    session.beginAngle();
    session.failAngle();
    assert.equal(session.snapshot().phase, 'armed');

    session.beginAngle();
    session.applyAngle('front');
    session.enterRefine();
    session.beginAngle();
    session.failAngle();

    assert.deepEqual(session.snapshot(), {
        phase: 'refining',
        angleCount: 1,
        canApply: false,
        latestAngle: 'front'
    });
});

test('Tool switch abandons every uncommitted angle without applying', () => {
    const session = new MultiViewRefineSession<string>();
    session.beginAngle();
    session.applyAngle('front');
    session.enterRefine();
    session.beginAngle();
    session.applyAngle('side');

    assert.equal(session.abandon(), true);
    assert.deepEqual(session.snapshot(), {
        phase: 'abandoned',
        angleCount: 2,
        canApply: false,
        latestAngle: 'side'
    });
});

test('mask evidence is tallied only in views where a splat is visible', () => {
    const selected = combineMultiViewRefineAngles([
        { selectedRanges: [[1, 2]], visibleRanges: [[1, 3]] },
        { selectedRanges: [[2, 2], [4, 4]], visibleRanges: [[2, 4]] },
        { selectedRanges: [], visibleRanges: [[3, 4]] }
    ]);

    assert.deepEqual([...selected], [1, 2]);
});
