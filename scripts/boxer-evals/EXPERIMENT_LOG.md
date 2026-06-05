# Boxer Desk Experiment Log

This is the working log for the desk/can Boxer click experiment. It records the
main things we tried, what happened, and which paths still look worth pursuing.

## TL;DR

- Success: the final `client_click` replay is honest. It does not depend on the
  saved target box at runtime, and the target-leak gate passed on all 4 cases.
- Success: the final click path is fast in-app. Local app `timing.total_ms`
  values were `205`, `670`, `649.8`, and `387.8` ms.
- Maybe: final quality is useful but not solved. Latest honest avg AABB IoU was
  `0.33125800831003743`, with case range `0.2179194949963069` to
  `0.39611528791366585`.
- Fail: the earlier very high grouped/calibrated result is not a valid
  single-click product result. It was useful for debugging, but it relied on
  target-like calibration/eval information that is now guarded against.
- Fail in current setup: GPU splat-depth was not better than the CPU center
  z-buffer for these cases.
- Promising: SAM masks, multi-view fusion, and category/object priors still look
  like the real paths to substantially better volume estimates.

## Result Labels

- Success: reproducible in the current branch and useful for the product path or
  safety gate.
- Maybe: evidence was mixed, partial, or blocked by another component.
- Promising: not finished, but the failure mode suggests a plausible next bet.
- Fail: tested and not useful or not honest enough in the current setup.

## What We Tried

- **Old calibrated/grouped high score - fail for honesty**
  - Result: produced exciting numbers during calibration work, but it was not a
    valid final product path.
  - Why: the path used target-like saved scene/eval information and could select
    or shape boxes using information unavailable to a real click.
  - Outcome: removed from the final claim. The branch now has a target-leak gate
    to catch this class of mistake.

- **Raw hosted Boxer click output - fail for this object**
  - Result: raw backend OBBs were often far from the object in world space.
  - Evidence from captured cases: raw center distances were commonly around
    `12` to `18` world units and raw AABB IoU was `0`.
  - Labels also drifted across unrelated classes such as `tarp`, `desk`,
    `laptop_computer`, and `passenger_car_(part_of_a_train)`.
  - Outcome: raw Boxer output is still useful as a proposal/2D hint, but it is
    not strong enough alone for the desk refrigerator/can target.

- **BBox plus click connected geometry refinement - success, partial quality**
  - Result: using the click, the 2D proposal, and connected splat/depth geometry
    moved predictions from raw off-object boxes into the target neighborhood.
  - Good: it fixed the largest raw placement failures and gave usable local 3D
    boxes.
  - Bad: visible-surface geometry still underestimates or over-expands hidden
    object volume depending on view.
  - Outcome: kept as the main local refinement approach.

- **Disable target-shaped fallback/reversion - success**
  - Result: final code keeps the target-agnostic runtime output instead of
    falling back to an oracle-like raw/target-selected result.
  - Outcome: this is part of the anti-cheat fix.

- **Target-leak replay gate - success**
  - Result: final local run passed `4/4` leak checks.
  - Meaning: mutating the saved target box did not change the runtime result for
    the honest `client_click` path.
  - Latest artifact: `/tmp/boxer-target-leak-final-timed.json`.

- **Final honest `client_click` path - success for speed, maybe for quality**
  - Result: `4/4` cases completed.
  - Avg AABB IoU: `0.33125800831003743`.
  - Avg 2D target IoU: `0.5058008908541819`.
  - App click timings: `205`, `670`, `649.8`, `387.8` ms.
  - Replay wall avg: `4615.2621675` ms, which includes Playwright evaluation
    and result serialization overhead.
  - Outcome: shareable as an honest baseline, not a solved quality result.

- **GPU splat-depth / stronger depth source - fail in current setup**
  - Result: the GPU path was tested as a depth source, but it did not improve
    these replay cases.
  - Evidence: in one focused test with `--boxer-gpu-depth --case-index 1`, GPU
    depth reported a dense `gpu-splat-footprint` source, but AABB IoU dropped to
    about `0.027` where the CPU center z-buffer path was about `0.467` in that
    comparison.
  - Speed: local Playwright/SwiftShader depth readback was also much slower,
    with depth work around multiple seconds.
  - Outcome: keep CPU center z-buffer as the better current default. Revisit
    only with a native GPU readback path or a different splat-depth algorithm.

- **Direct hosted SAM from the browser - fail/risky**
  - Result: direct `https://sam3.4dream.app` browser access was not a reliable
    production-like path.
  - Risk: CORS/auth/endpoint behavior makes it fragile, so the package script was
    renamed to `develop:desk:ai:hosted-cors-risk`.
  - Outcome: do not rely on direct hosted SAM from the viewer.

- **SAM dev proxy - maybe, currently blocked upstream**
  - Result: the local proxy path was reached and CORS was no longer the blocker.
  - Latest proof gate result: failed as expected because upstream returned no
    usable mask.
  - Upstream attempts:
    - `/api/sam3/refine`: `501`
    - `/api/sam3/segment`: `520`
    - `/upload`: `501`
  - Rejection: `mask-unavailable-501`.
  - Outcome: proxy plumbing is useful, but the endpoint contract needs to be
    fixed before SAM can help quality.

- **SAM masks as a 2D quality signal - promising, unproven**
  - Why promising: several failures are really 2D mask/extent problems before
    they become 3D volume problems.
  - Why unproven: no non-empty SAM mask was returned in the proof gate, so we
    did not validate a real mask-driven improvement.
  - Outcome: next experiment should fix the SAM endpoint contract, then rerun the
    same four cases with `--require-sam-success`.

- **Projection-fit dimension permutation - maybe**
  - Result: testing dimension permutations against the projected 2D box helped
    diagnose orientation/extent mistakes.
  - Good: some cases had alternative permutations with better 2D or AABB fit.
  - Bad: choosing by target IoU is an oracle; choosing only by Boxer 2D fit was
    not enough to solve 3D volume.
  - Outcome: useful as a non-oracle scoring feature, but not enough alone.

- **Connected component and compact click heuristics - maybe**
  - Result: click-local connected clusters helped avoid huge background boxes in
    some views.
  - Weakness: the same heuristics can become too small on narrow visible
    surfaces or too broad on large flat surfaces.
  - Outcome: keep the machinery, but expect only incremental gains from tuning.

- **Multi-view/group fusion - promising, not single-click**
  - Result: the earlier grouped/fused direction showed why combining views can
    estimate a full object better than one surface click.
  - Limitation: it is not the same UX or timing contract as one click to one
    output.
  - Outcome: best bet if the product can afford multiple views, a short scan, or
    cached scene-level preprocessing.

- **Category/object priors - promising**
  - Why promising: a single click often sees only the front surface. Full volume
    needs a prior about object class, symmetry, likely height/depth, or support
    plane.
  - Evidence: final boxes often have reasonable center/2D overlap but weak
    physical extents.
  - Outcome: likely required for a major quality jump without multi-view input.

- **Minor threshold tuning - low promise**
  - Result: helpful for individual cases, but not likely to produce a step
    change.
  - Outcome: tune after adding stronger signals, not before.

## Final Honest Replay Cases

- `angle-298-drifted`
  - Result: success gate pass, quality maybe.
  - AABB IoU: `0.343`.
  - 2D target IoU: `0.228`.
  - App timing: `205` ms.
  - Note: weak 2D overlap; local depth component was too narrow.

- `angle-280-drifted`
  - Result: success gate pass, best case.
  - AABB IoU: `0.396`.
  - 2D target IoU: `0.763`.
  - App timing: `670` ms.
  - Note: strongest evidence that the honest path can work when the 2D proposal
    and click geometry agree.

- `angle-205-clean`
  - Result: success gate pass, decent case.
  - AABB IoU: `0.368`.
  - 2D target IoU: `0.615`.
  - App timing: `649.8` ms.
  - Note: useful but still not full-volume accurate.

- `mouse-angle-278-clean`
  - Result: success gate pass, weakest case.
  - AABB IoU: `0.218`.
  - 2D target IoU: `0.418`.
  - App timing: `387.8` ms.
  - Note: extent and center errors remain visible.

## Repro Commands

- Build:
  - `pnpm build`
- Honest target-leak gate:
  - `PLAYWRIGHT_MODULE=/home/jonam/.nvm/versions/node/v25.9.0/lib/node_modules/playwright node scripts/replay-boxer-evals.mjs --file scripts/boxer-evals/desk-can-latest3.json --url http://localhost:<serve-port>/ --prompt-type client_click --fresh-browser --case-timeout-ms 90000 --load-timeout-ms 90000 --verify-target-leak --out /tmp/boxer-target-leak-final.json`
- SAM proxy proof gate:
  - Build with `SAM3_BACKEND_URL=http://localhost:47824`, run
    `node scripts/sam3-dev-proxy.mjs`, then:
  - `PLAYWRIGHT_MODULE=/home/jonam/.nvm/versions/node/v25.9.0/lib/node_modules/playwright node scripts/replay-boxer-evals.mjs --file scripts/boxer-evals/desk-can-latest3.json --url http://localhost:<serve-port>/ --prompt-type click_sam --fresh-browser --case-index 1 --case-timeout-ms 90000 --load-timeout-ms 90000 --require-sam-success --out /tmp/boxer-click-sam-proxy-proof.json`

## Recommendation

- Merge this branch as an honest baseline, replay harness, and safety gate.
- Do not present it as solved depth or solved object volume.
- Next quality bets, in order:
  - Fix the SAM endpoint contract and rerun the proof gate with real masks.
  - Try multi-view or cached scene-level fusion if the UX can support it.
  - Add category/object priors for hidden volume and support-plane inference.
  - Revisit GPU/gsplat depth only if we can avoid slow readbacks and prove it
    beats the CPU center z-buffer on the same replay cases.
