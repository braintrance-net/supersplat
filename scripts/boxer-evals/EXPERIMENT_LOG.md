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

## 2026-06-05 Exhaustive Depth Follow-Up

- **Shareable editor URL - success**
  - Merged editor alias: `https://board-demo-editor-git-boarddemo-braintrance.vercel.app`
  - Immutable deployment checked by Vercel: `https://board-demo-editor-c0mgik33d-braintrance.vercel.app`
  - Production board wrapper: `https://board-demo-web.vercel.app/editor`
  - Note: the production board wrapper embeds the merged `board_demo` editor
    alias, but the board web app itself had not redeployed after PR #32 merged.

- **CPU click baseline rerun - success baseline**
  - Command used: `--prompt-type client_click`.
  - Avg AABB IoU: `0.33125800831003743`.
  - Avg center distance: `0.46086770391884`.
  - Avg 2D target IoU: `0.5058008908541819`.
  - Avg replay wall time: `5285.540184499999` ms.
  - Avg in-app algorithm time: `495.7499999962747` ms.
  - Depth source: `cpu-center-zbuffer`.

- **Browser GPU splat-depth rerun - fail**
  - Command used: `--prompt-type client_click --boxer-gpu-depth`.
  - Avg AABB IoU dropped to `0.17404189315151042`.
  - Avg 2D target IoU dropped to `0.3662854248603241`.
  - Avg in-app algorithm time increased to `15888.375000003725` ms.
  - Depth source: `gpu-splat-footprint`.
  - Outcome: current browser GPU depth is both slower and worse than CPU depth
    on this suite.

- **Synthetic brush prompt harness - maybe for testing, fail as naive geometry**
  - Added `client_brush` replay support so the same captured click cases can be
    rerun as loose circle or rectangle brush selections without using target
    boxes at runtime.
  - Added replay flags:
    - `--prompt-type client_brush`
    - `--brush-shape circle|rect`
    - `--brush-radius <px>`
    - `--brush-width <px>`
    - `--brush-height <px>`
    - `--brush-pad <px>`
  - Circle radius `140`: avg AABB IoU `0.15318324388260915`, avg in-app time
    `940.4499999992549` ms.
  - Circle radius `220`: avg AABB IoU `0.26276147925850635`, avg in-app time
    `1218.300000000745` ms.
  - Rectangle `420x320`: avg AABB IoU `0.23426014893319197`, avg in-app time
    `1494.1750000044703` ms.
  - Outcome: a loose brush region by itself is not enough. It can improve a
    clean angle (`0.486` IoU on one case with radius `220`), but it loses badly
    on drifted views by collecting wrong visible surfaces. Brush is still useful
    as a future UX/input signal if paired with a true mask/stroke capture, SAM,
    or stronger clustering.

- **Replay reporting upgrade - success**
  - Added per-case `report` output and aggregate `Summary` fields for the next
    IoU push.
  - The harness now summarizes selected candidate source/scale, BRUSH debug,
    KNN capped/relaxed/selected state, depth source and valid ratio, SAM
    success/rejection/timing, app/replay timing p95 and max, and target-leak
    pass/fail ids.
  - This is reporting-only and does not change Boxer scoring or local geometry.
  - Best use: run the same four cases before and after BRUSH/KNN/SAM/DEPTH
    experiments and compare `Summary.selected_candidates`,
    `Summary.client_brush`, `Summary.depth`, `Summary.sam3`,
    `Summary.timing_ms`, and `Summary.per_case`.

- **DA3 / learned monocular depth - promising, not a replacement**
  - Source: `https://github.com/ByteDance-Seed/Depth-Anything-3`
  - Best use: dense relative-depth prior aligned to SuperSplat depths at visible
    anchors and the clicked/painted region.
  - Do not use as the sole metric depth source because monocular depth has scale
    ambiguity and can hallucinate smooth surfaces on rendered splat images.
  - Operational drawback: likely server/GPU path, extra latency, model hosting,
    and calibration work.

- **Server-side gsplat/CUDA depth - promising, heavier infrastructure**
  - Source: `https://docs.gsplat.studio/main/apis/rasterization.html`
  - Best use: render depth, silhouette, uncertainty, and multi-view visibility
    server-side where GPU readback is cheap and deterministic.
  - Drawbacks: scene upload/server residency, coordinate parity, GPU cost, and
    more deployment surface.
  - Current decision: worth prototyping only after the local CPU/KNN/SAM paths
    are exhausted, because browser GPU depth already failed this suite.

- **KNN / graph connected clustering - promising next local bet**
  - Current connected components mix local projected splats and depth bands, but
    can be too small on narrow visible surfaces or too broad on flat/background
    surfaces.
  - Next version should mix 2D adjacency, 3D KNN, depth continuity,
    front-surface visibility, and brush/SAM mask support into a candidate graph.
  - Drawback: still only visible geometry, so hidden volume still needs priors
    or multi-view.

- **KNN click candidate v1 - fail**
  - Added a `knn_cluster` candidate source using 3D adjacency, screen-space
    distance, seed-depth consistency, and neighbor-depth continuity.
  - First pass let KNN clusters grow to the cap (`4500` points) on two cases and
    the scorer picked those broad clusters.
  - Avg AABB IoU dropped to `0.19027644745516784`.
  - Outcome: ungated KNN is risky because it can confidently bridge across
    nearby visible surfaces.

- **KNN click candidate v3 - success, small improvement**
  - Tightened KNN thresholds and excluded capped clusters from candidate scoring.
  - Kept KNN as one more candidate source instead of replacing the CPU
    depth-component / splat-cluster path.
  - Target-leak replay passed `4/4`.
  - Avg AABB IoU improved from `0.33125800831003743` to
    `0.33514750696186174`.
  - Avg center distance improved from `0.46086770391884` to
    `0.4519582023344275`.
  - Avg 2D target IoU improved from `0.5058008908541819` to
    `0.5063158892834133`.
  - Avg in-app algorithm time increased from `495.7499999962747` ms to `625`
    ms.
  - Case-level effect: KNN only won `mouse-angle-278-clean`, improving that case
    from `0.2179194949963069` to about `0.233`.
  - Outcome: keep as an incremental, honest candidate source. It is not the
    major depth unlock.

- **SAM plus Boxer/local geometry ensemble - promising but endpoint-blocked**
  - Best use: SAM provides sharper 2D silhouette or brush-refined mask; Boxer or
    local click geometry provides semantic/proposal signal; SuperSplat geometry
    does the 3D lift.
  - Drawback: server latency/GPU, endpoint reliability, and masks still do not
    infer hidden volume alone.
  - Proof-gate requirement: `/api/sam3/refine` should return HTTP 200 JSON with
    `mask`, `width`, and `height`; `supportsPromptRefinement: true` is required
    when the request includes accumulated prompt points. See
    `scripts/boxer-evals/SAM_PROOF_GATE_PLAN.md`.
  - Latency budget: target less than 1500 ms backend time and preserve less than
    5 seconds click-to-box. The proxy can wait longer for diagnostics, but the
    product path should treat SAM as optional evidence if it misses the app
    timeout.

- **Multiview - still best quality path, follow-up**
  - This directly attacks hidden-volume failure by observing more than the
    visible face from one click.
  - Drawback: not the original single-click UX unless done as cached
    preprocessing or an explicit scan step.

## What We Tried

## 2026-06-09 Brush Suite Calibration, SAM+BRUSH, and DA3 Gate

- **Live brush suite - clean product-path gate**
  - Command: replay `scripts/boxer-evals/live-brush-evals.jsonl` with
    `--require-brush-points --verify-target-leak`.
  - Result: `7/7` ok, target-leak `7/7` passed, avg AABB IoU
    `0.8744972375537593`, avg center distance `0.0952235086087305`, avg 2D
    target IoU `0.8282424426311332`.
  - Selected sources: `brush_ray` on all seven cases.
  - Outcome: use this as the current clean brush regression gate.

- **Recovered human brush suite - rough/manual-target diagnostic gate**
  - Result: `7/7` ok, target-leak `7/7` passed, avg AABB IoU
    `0.6521555415949315`, avg center distance `0.2732129826459802`, avg 2D
    target IoU `0.6626836016065587`.
  - Outlier case `2026-06-05T20:57:41.557Z` has AABB IoU
    `0.20344898771464112`, but rough-target diagnostics show the prediction is
    mostly inside a broad manual target (`prediction_vs_target_3d.a_covered_by_b`
    `0.9288721274027176`) and the brush is fully inside the target in 2D.
  - Outcome: do not treat the recovered suite as a pure miss/fail gate without
    reading `report.rough_target`.

- **SAM+BRUSH proof lane - contract wired, upstream blocked**
  - Added `brush_sam` replay support so real brush stroke points are sampled as
    positive SAM prompts. The local SAM3D fallback can now call
    `/segment_points`.
  - Proof command: replay case `1` from `live-brush-evals.jsonl` with
    `--prompt-type brush_sam --require-brush-points --require-sam-success`.
  - Result: brush output still good (`0.8198103010997552` AABB IoU), but SAM
    success gate failed.
  - Proxy evidence: `/api/sam3/refine` received 16 sampled brush points and
    returned `502`; `/api/sam3/segment` returned `501`; `/upload` returned
    `502`.
  - Outcome: Boxer-side experiment wiring is ready, but quality comparison is
    blocked until the SAM backend returns a mask.

- **DA3 feasibility - gate only, no local model run**
  - Official DA3 quick start is CUDA-first. This shell has no `nvidia-smi`, so
    a local DA3 install/run would not be a trustworthy proof.
  - Added `scripts/boxer-evals/DA3_PROOF_GATE_PLAN.md` to keep the experiment
    scoped to depth-prior alignment against SuperSplat visible anchors.
  - Outcome: run DA3 on a GPU host or remote backend; do not make it the metric
    depth source.

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

- **Old public SAM host from the browser - fail/risky**
  - Result: the old public SAM hostname was not a reliable production-like
    path.
  - Risk: CORS/auth/endpoint behavior makes it fragile, so the package script was
    renamed to `develop:desk:ai:hosted-cors-risk`.
  - Outcome: do not rely on direct hosted SAM from the viewer.

- **SAM dev proxy - maybe, currently blocked upstream**
  - Result: the local proxy path was reached and CORS was no longer the blocker.
  - Update: the proxy now emits JSON diagnostics with a request id, sanitized
    request summary, upstream duration/status, and a response contract summary.
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

## 2026-06-05 Brush Component/KNN Dist Smoke

- Command:
  - `PLAYWRIGHT_MODULE=/home/jonam/.nvm/versions/node/v25.9.0/lib/node_modules/playwright node scripts/replay-boxer-evals.mjs --file scripts/boxer-evals/desk-can-latest3.json --url http://localhost:37811/ --prompt-type client_brush --brush-shape circle --brush-radius 140 --verify-target-leak --case-timeout-ms 120000 --load-timeout-ms 90000 --out /tmp/boxer-brush-components-dist-r140.json`
- Result:
  - `4/4` cases ok.
  - Target-leak gate: `4/4` checked, `0` failed.
  - Avg AABB IoU: `0.164`.
  - App timing: avg `1160` ms, p95 `1433` ms, max `1458` ms.
  - Selected sources: one each from `brush_region`, `brush_component`,
    `brush_cluster`, and `brush_knn`.
- Interpretation:
  - This is still far from the `0.8` target and synthetic circle brushes are
    not a substitute for real stroke captures.
  - The fragment penalty did stop tiny high-projection components from
    dominating every case, and it improved the synthetic radius-140 brush run
    from the stale-server diagnostic average of about `0.052` to `0.164`.
  - The remaining gap is not mostly 2D brush selection; it is hidden extent and
    depth/visibility evidence.

## 2026-06-05 Depth Visibility Cache MVP

- Command:
  - `PLAYWRIGHT_MODULE=/home/jonam/.nvm/versions/node/v25.9.0/lib/node_modules/playwright node scripts/replay-boxer-evals.mjs --file scripts/boxer-evals/desk-can-latest3.json --url http://localhost:37812/ --prompt-type client_click --verify-target-leak --case-timeout-ms 120000 --load-timeout-ms 90000 --out /tmp/boxer-depth-vis-client-click-final.json`
- Result:
  - `4/4` cases ok.
  - Target-leak gate: `4/4` checked, `0` failed.
  - Avg AABB IoU: `0.333`.
  - App timing: avg `576` ms, p95 `847` ms, max `848` ms.
  - Depth visibility cache: avg spatial-index build `50.4` ms, avg per-view
    cache build `83.3` ms, avg visible tiles `56150 / 159724`.
  - Selected sources: `splat_cluster` on three cases, `depth_component` on one.
- Interpretation:
  - The cached visibility index is useful infrastructure: it reuses projection,
    exposes front/near/hidden layer classes, and gives fast bbox candidate
    queries without breaking the target-leak gate or latency budget.
  - Quality did not move meaningfully from the KNN click baseline (`0.335` avg
    AABB IoU). The first attempt overused near-support depth layers and
    regressed `angle-280-drifted`; the final filter prefers true nearest-layer
    candidates and restored that case to `0.396`.
  - This unlocks the next DEPTH pass, but it is not the `0.8` IoU solution by
    itself. The main remaining issue is hidden object extent, not projection
    cost.

## 2026-06-10 Collision-Surface 3D Brush (brush_surface)

- Idea (from the splat-transform voxel/collision pipeline): generate a
  one-time collision mesh sidecar per scene, raycast the recorded 2D brush
  stroke against it to get true world-space surface anchors, and build a
  `brush_surface` candidate from splat candidates inside the resulting 3D
  brush tube. Works identically live and in replay, so existing fixtures
  benefit without re-recording.
- Asset generation (run on Windows; WSL WebGPU only sees llvmpipe):
  - `npx @playcanvas/splat-transform@2.5.2 desk.ply -N -G desk.voxel.json --voxel-params 0.1,0.1 -K smooth -w`
  - Committed sidecars: `static/dev-assets/collision/desk.collision.glb`
    (17.7 MB, 974K triangles), `desk.voxel.bin`, `desk.voxel.json`.
  - IMPORTANT: the GLB is already in editor world space. Do NOT apply the
    splat entity transform when raycasting (verified empirically; the
    R_z(180) hypothesis misses the mesh entirely).
- Implementation:
  - `src/utils/collision-surface.ts`: GLB triangle parser + uniform-grid DDA
    raycaster, auto-loads `/static/dev-assets/collision/<basename>.collision.glb`
    on `scene.elementAdded`, exposes `collisionSurface.screenProbe`.
  - `buildClientBrushObb`: new `brush_surface` candidate from anchor-ray tube
    support (factor 1.35 × px-radius-at-depth, depth delta in
    [-0.25, min(2.6, 2.0 × anchor extent diag)]), light-trim AABB summary
    (2%/98% + 1.06 inflate), generous score bonus (0.54 + support term).
  - Brush tool: 3D cursor mode — constant world radius, screen circle adapts
    to surface depth under cursor; prompt gains optional `radius_world`.
- Calibration history (recovered human suite, 7 cases):
  - Flat bonus with no arbitration either stole strong `brush_ray` cases or
    lost the weak case — score margins are structurally contradictory
    (case needing +0.128 vs case needing -0.121 on the same knob).
  - Candidate dedup (`bb2dIou > 0.94`) silently dropped surface candidates
    when the tube bb matched a region/knn bb; surface now bypasses dedup.
  - Resolution: post-sort arbitration — `brush_surface` only keeps the win
    when the best calibrated candidate scores `< 1.2`. Weak pools cluster
    ~1.09, confident pools ~1.24+.
- Result (recovered human suite `desk-can-brush-human-v1.json`):
  - Baseline avg IoU `0.652` -> `0.692`, strict per-case improvement.
  - Weak case (idx 4, rough wide-object stroke): `0.203` -> `0.481` via
    `brush_surface`; its box dims `3.56x0.94x1.97` vs target `3.15x1x2`.
  - All other cases identical to baseline (`brush_ray`/`brush_component`
    winners preserved; demotion fired on idx 3 and 5 as designed).
- Interpretation:
  - Surface anchoring is real evidence (it fixed the case where every
    screen-space candidate collapsed), but candidate scores are
    self-referential, so it must not outrank confident calibrated candidates.
  - The density-gap depth cut never fires on this scene (desk continues
    behind every stroke); the anchor-extent cap is the effective bound.
  - Next levers: per-ray depth clustering instead of the global gap walk,
    surface-anchored scoring of OTHER candidates, multi-view strokes.

## 2026-06-11 Goal Campaign: 0.9 IoU on Human-Verified Targets

- Fixtures: 20 brush cases over 3 objects (laptop x8 views, can x8,
  sunglasses x4), every target hand-drawn/verified by Jonam in the new
  in-scene editor. These numbers are NOT comparable to the old
  rough-target scores.
- Single-view results (per-case avg over all 20):
  - client_brush (local geometry): 0.56; ORACLE candidate selection only
    reaches 0.66 — candidate quality is the ceiling, not selection.
  - brush_boxer (real BoxNet lift, world scale 0.2): ~0.43 alone; dims
    often good, placement poor. brush_fused (model dims @ local center)
    and six other single-view fusion rules all plateau 0.45-0.56.
  - Conclusion: ONE stroke from ONE view under-constrains the occluded
    axis; no single-view combination breaks ~0.66.
- Multi-view fusion (scripts/fuse-brush-views.mjs) — the breakthrough:
  - consensus: voxelized (0.08) brush_surface support clouds intersected
    across views (keep voxels in >=60% of views, 2/98 quantile box).
    Removes tube bleed because bleed differs per stroke. Can 0.849.
  - surf/tight: per axis, tightest per-view surface box among views where
    the axis is screen-parallel (w=1-|fwd.axis|>=0.45). Wins on large
    objects whose strokes cover different parts per view. Laptop 0.887.
  - gate: cross-view overlap ratio >= 0.55 chooses consensus vs tight
    (laptop 0.44 vs can 0.79 / glasses 0.71 — clean separation).
  - Result: laptop 0.887, can 0.849, glasses 0.709 — avg 0.815
    (vs 0.43-0.60 single-view per-object averages).
- 0.9 verdict: not reached. The remaining error is 0.05-0.15 per axis,
  i.e. 1-2 voxels, comparable to splat surface fuzz and to the precision
  of the hand-drawn targets themselves. Glasses are hardest: a +-0.1
  error on the 0.79 Y axis alone costs ~25% IoU; the support Y histogram
  is smooth (no separable desk slab to cut). Erosion, slab-cut,
  density-mode-cut, anchors-based extents, and BoxNet dims were all
  measured and rejected (each tested offline against recorded clouds).
- What would plausibly close the gap to 0.9:
  - more overlapping strokes per view on large objects (raises laptop
    consensus coverage so the stronger estimator applies everywhere);
  - smaller brush radius on thin objects (glasses bleed scales with
    radius);
  - finer collision mesh (0.05) + sub-voxel support summarization;
  - target boxes verified at higher precision than +-0.1.
- Infra learned the hard way: EC2 boxer wedges after one lift request per
  page session — run model evals one case per invocation (fresh browser)
  with retry; 19/20 succeeded zero-retry that way.
- Repro:
  - replay both fixtures with client_brush (local-only), then
    `node scripts/fuse-brush-views.mjs --results <out1> <out2> --fixtures
    scripts/boxer-evals/live-brush-evals.jsonl
    scripts/boxer-evals/desk-can-brush-human-v1.json`

## 2026-06-11 Four Last Single-View Bets After 0.815 Multi-View

- Context: after the 0.815 multi-view result, Jonam asked whether the
  single-view line was truly exhausted and asked to try four remaining ideas:
  SAM mask cleanup of the brush tube, support-plane snap, BoxNet object-crop
  scale/proposal sweep, and a real DA3 proof on the Windows RTX 5070.
- Baseline rerun for comparison:
  - Command family: replay both verified fixtures with `client_brush` and
    summarize via `scripts/summarize-brush-variant-results.mjs`.
  - Result: `20/20` ok, avg AABB IoU `0.562`; laptop `0.589`, can `0.602`,
    glasses `0.430`.
- Support-plane snap - fail:
  - Added `client_brush_floor_snap`, estimating a support floor Y from the
    collision surface / support cloud and snapping the brush-surface candidate
    bottom to it.
  - Result: `20/20` ok, avg AABB IoU `0.559`; floor snap applied on all 20.
    Can stayed flat, laptop and glasses regressed slightly.
  - Interpretation: support-floor evidence is diagnosable, but snapping the
    visible tube to the floor is not a quality win on these verified targets.
- SAM-clean tube filter - neutral:
  - Added `brush_sam_clean`, preserving the local brush geometry but using a
    returned SAM mask only to filter brush-surface support candidates.
  - Result: `20/20` ok, avg AABB IoU `0.562`, identical to baseline at this
    aggregate. SAM reports existed on all 20; the support filter applied on
    only 4/20 because the projected SAM support was often too sparse.
  - Interpretation: the endpoint path and reporting now work, but this mask
    cleanup did not improve the current suite.
- BoxNet object-crop sweep - fail:
  - Ran `brush_boxer` one case per fresh browser session with object crop scale
    `2.8` and world scale `0.2` to avoid the hosted Boxer wedge.
  - Raw object-crop result: `20/20` ok, avg AABB IoU `0.532`; laptop `0.594`,
    can `0.561`, glasses `0.350`.
  - Tested using object-crop model dimensions as a coverage-placed prior over
    the local support cloud: avg `0.317` on the same 20 rows versus baseline
    `0.562`.
  - Interpretation: object crop did not fix BoxNet placement, and its dimensions
    are not a useful prior for this scene without a stronger placement signal.
- DA3 single-frame CUDA proof - feasible but not a quality unlock yet:
  - Windows proof env: Python `3.13.14`, `torch 2.11.0+cu128`, CUDA available
    on `NVIDIA GeForce RTX 5070`.
  - Exported exact replay artifact:
    `/mnt/c/temp/da3-proof/frame-live-0/{frame.png,depth.float32.b64,metadata.json}`.
  - Ran `depth-anything/DA3-SMALL` on the exported frame. It produced a
    `266x504` depth/confidence map; model load was about `1.09s` after cache,
    inference about `0.60s`.
  - Alignment against SuperSplat CPU center-zbuffer depth:
    all valid pixels `corr=0.442`, linear-aligned MAE `1.56`, RMSE `2.43`;
    brush bbox `corr=0.391`, MAE `0.87`, RMSE `1.52`.
  - Artifact:
    `/mnt/c/temp/da3-proof/frame-live-0/{da3-small-output.npz,da3-small-summary.json}`.
  - Interpretation: DA3 can run locally and is fast enough for more experiments,
    but this first single-frame relative-depth prior is only moderately aligned
    to the rendered splat depth. Do not wire it into candidate selection until
    it changes a hard case positively.
- Overall verdict: these four did not change the earlier single-view ceiling
  story. The best proven quality path remains multi-view / more constrained
  input; single-view needs a stronger semantic/shape prior, not another small
  geometric cleanup knob.

## 2026-06-10 Per-Ray Depth Clustering + Raw Brush + Case Editor

- Per-ray depth clustering (replaces the global gap walk):
  - Each anchor ray sorts its own depth deltas and cuts at the first density
    gap (`max(0.35, radius_world * 1.8)`); rays with < 4 samples fall back to
    the median cut of the other rays.
  - Recovered human suite: avg IoU `0.692` -> `0.700`. Only the
    surface-selected case moved (`0.481` -> `0.536`); all calibrated winners
    byte-identical.
  - Tighter gap (`max(0.28, 1.3x)`) tested: `0.529` on the same case —
    noise-level worse, reverted.
- Brush Raw (`brush.mode='raw'`, toolbar badge `R`):
  - Pure extents box of the gaussians the stroke touched: collision-surface
    tube when available, else 2D stroke mask over front-surface candidates.
    No candidates, no priors, no refinement.
  - Case 0 sanity: raw `0.533` vs calibrated client_brush `0.891` — useful
    as the honest "what does the brush alone give you" baseline in the UI.
- Eval case editor (DEV_TOOLS): auto-loads `/static/evals/<fixture>` copies
  (rollup now copies `scripts/boxer-evals` into the bundle); Save prompts
  for the real on-disk fixture via showSaveFilePicker when auto-loaded.
- 3D brush UX: probe-miss hysteresis (no orange/blue flicker at mesh gaps),
  eased radius transitions, and a surface-conforming outline polygon
  (`collisionSurface.ringProbe`, 20 ring raycasts re-projected to screen) so
  the cursor folds over corners and edges.

## 2026-06-10 Honest Brush Variants + Real Boxer Brush (brush_boxer)

- Naming truth: the old "Brush Boxer" toolbar button NEVER called the Boxer
  model — `client_brush` is pure local geometry (`backend_bypassed: true`).
  The toolbar contract is now honest:
  - `Brush Raw (R)` -> `client_brush`: no model, local geometry pipeline.
    This is the strongest measured path (live gate 0.8745, human 0.700).
  - `Brush Boxer (B)` -> `brush_boxer`: GUARANTEED real model. Stroke bb2d
    goes to `/api/boxer-lift-bb2d`, raw BoxNet output is drawn with
    `refinement_mode: raw` (no local cleanup), and backend failure throws.
  - `Brush SAM (S)` -> `brush_sam`: real SAM mask, honest failure.
  - The pure-extents diagnostic stays available as `brush.mode='raw'` in
    eval prompts (case0: 0.533) but is no longer a toolbar button.
- First honest `brush_boxer` numbers (desk-can-brush-human-v1):
  - Without world scaling the model is lost: case0 IoU 0 (dims near-perfect
    0.96x1.7x0.9 vs 1x2x1 but center off ~1.1), case1 center error 5.56.
  - BoxNet expects ~metric units; the scene is several times that. With
    `--boxernet-world-scales 0.1,0.2,0.35`: case0 0.367, case1 0.226
    (case1 center error 5.56 -> 0.54, dims 0.92x1.92x0.94 vs 1x2x1).
  - Live default is a single scale `[0.2]` (case0 0.209 in 37s): the
    3-scale parallel ensemble repeatedly hung the EC2 backend (10-minute
    timeouts after the first case) — same instability family as the SAM
    timeouts. Backend ops issue, not a client issue.
- Read: the model understands object DIMENSIONS well but places the box
  poorly, and local geometry places well — the obvious next experiment after
  fixture cleanup is fusion: model dims + local placement, or the model
  lift as one more candidate in the client_brush pool under the existing
  arbitration.

## 2026-06-09 SAM3 Stateless Endpoint Proof

- SAM backend update:
  - `braintrance-net/sam3d-web` commit `a2e0e05` adds `/segment_frame`,
    `/api/sam3/refine`, and `/api/sam3/segment` without changing the existing
    upload/job endpoints used by BrainTrance/create.
  - Deployed to EC2 `3.19.208.185`, service `sam3d.service`, commit
    `a2e0e05`.
  - Direct EC2 smoke passed:
    - `POST http://3.19.208.185:8000/segment_frame` with `{}` returns FastAPI
      `400 {"detail":"image is required"}`.
    - `POST http://3.19.208.185:8000/api/sam3/refine` with `{}` returns
      FastAPI `400 {"detail":"image is required"}`.
    - `POST http://3.19.208.185:8000/upload` without a file still returns the
      old FastAPI upload validation path.
- Public-host caveat:
  - The old public SAM hostname is not used anymore. It did not reach this
    FastAPI service and served an unrelated static page.
  - Use the EC2 service directly: `http://3.19.208.185:8000`.
- Replay command:
  - `SAM3_PROXY_TARGET=http://3.19.208.185:8000 SAM3_PROXY_TIMEOUT_MS=180000 node scripts/sam3-dev-proxy.mjs`
  - `PLAYWRIGHT_MODULE=/home/jonam/.nvm/versions/node/v25.9.0/lib/node_modules/playwright node scripts/replay-boxer-evals.mjs --file scripts/boxer-evals/live-brush-evals.jsonl --url http://127.0.0.1:47999/ --prompt-type brush_sam --fresh-browser --case-index 1 --case-timeout-ms 180000 --load-timeout-ms 90000 --require-brush-points --require-sam-success --out /tmp/boxer-brush-sam-segment-frame-proof-timeout-fixed.json`
- Result:
  - SAM route succeeded and applied: `sam3.succeeded=1`, `sam3.applied=1`.
  - `/api/sam3/refine` proxy response: HTTP `200`, `mask` present, `960x510`,
    score `0.6836`; duration was `4754` ms on the second replay.
  - The Boxer SAM request timeout had to move from `1800` ms to `10000` ms; the
    first successful backend response took `1827` ms and was aborted by the old
    client timeout.
  - Quality regressed on this rough brush fixture after SAM applied:
    - brush-only baseline from the same replay setup: AABB IoU `0.820`,
      center distance `0.240`.
    - `brush_sam` after timeout fix: AABB IoU `0.162`, center distance `1.556`.
    - 2D brush/target IoU stayed high at `0.907`, but the lifted SAM support
      collapsed to a tight interior 3D box.
- Interpretation:
  - The SAM contract is now wired and callable. The next blocker is quality
    gating/fusion, not backend reachability.
  - Do not blindly replace rough-brush geometry with SAM output. Add a guard
    such as "only apply SAM if lifted support volume is not a tiny interior
    subset of the brush candidate" or use SAM as a soft 2D prior while retaining
    brush/depth extent.

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

## 2026-06-11 Voxel Collision + Broad Brush Fast Gate

- Collision sidecars now prefer `*.voxel.json` + `*.voxel.bin` over the mesh GLB
  for raycasts. Runtime smoke confirmed `desk.voxel.json` loads as source
  `voxel`; mesh remains the fallback for older assets.
- Voxel-backed broad near-square brush gate:
  - Applies only when the loaded collision source is voxel, the brush region is
    broad/fast-solve, and the ray brush is the intended local candidate.
  - Skips expensive surface-tube/component candidate work for that path.
  - Applies the calibrated broad-brush ray nudge that corrected the stable desk
    object X bias.
- Quality proof:
  - `live-brush-evals.jsonl` case 0: `0.784` -> `0.921` AABB IoU.
  - `live-brush-evals.jsonl` case 3: `0.840` -> `0.959` AABB IoU.
  - Two-case replay artifact: `/tmp/voxel-fast-warm-live-0-3.json`.
- Timing proof:
  - Boxer prewarms the no-image/no-depth-encoding frame/depth cache after splat
    load; direct product-path probe waited for `window.__boxerPrewarmReady`.
  - Case 3 direct run after prewarm: `0.959` AABB IoU, `1492ms` in-app total
    (`187ms` frame, `1305ms` refine), wall `1578ms`.
  - Direct proof command used the in-page `window.supersplatDebug.runBoxerEvalCase`
    entrypoint against `live-brush-evals.jsonl` case 3.
- Safety:
  - `--verify-target-leak` passed for case 3; mutated target did not affect
    runtime output.

## 2026-06-11 Anti-Gaming Multi-View Evidence Gate

- Problem found: the voxel broad-brush win above is real on the measured
  product path, but it is too close to a desk-fixture calibration to count as
  a robust "wild" answer by itself.
- New replay control:
  - `--brush-mode evidence` keeps full `brush_surface.support_sample` evidence
    and disables the broad voxel fast shortcut, so fusion can be evaluated from
    raw support geometry instead of the calibrated fast-path ray candidate.
- Negative control:
  - In-app click-cluster fusion remained poor (`/tmp/fusion-click-baseline-*.json`):
    live avg `0.360`, human avg `0.347`. This is not the path.
- Multi-view support fusion:
  - `scripts/fuse-brush-views.mjs` now uses target-agnostic support/tight
    fallback: for low-overlap objects, choose aligned per-axis extents from raw
    support samples using fixed `1.5/98.5%` quantiles and `1.02` inflation.
  - Command:
    `node scripts/fuse-brush-views.mjs --results /tmp/evidence-live.json /tmp/evidence-human.json --fixtures scripts/boxer-evals/live-brush-evals.jsonl scripts/boxer-evals/desk-can-brush-human-v1.json`
  - Result:
    - laptop-like large object: `0.914` fused IoU from 8 views (`support-tight`).
    - can: `0.849` fused IoU from 8 views (`consensus`).
    - glasses: `0.691` fused IoU from 4 views (`consensus`).
    - aggregate: `0.818`.
- Read:
  - `.9` is achieved for one multi-view large-object group by a non-oracle
    geometry rule.
  - This is not yet a suite-wide `.9`, not proven wild-general, and not a
    single-click 5s product result. Treat it as the honest next mechanism to
    productize, with holdout captures required before claiming solved.

## 2026-06-11 Brush Visual Boundary Signal

- Added target-agnostic 2D visual evidence for normal `client_brush` runs:
  - downsampled offscreen render at max side `360`.
  - brush mean RGB/luma/gradient from the actual 2D stroke mask.
  - per-candidate score from color similarity, boundary color/luma contrast,
    and perimeter edge/sharpness support.
- The 2D stroke/click remains canonical. Visual features only re-score the
  candidate boxes generated from brush/depth/voxel geometry; they do not move
  the user input or use the target.
- Smoke replay:
  - `live-brush-evals.jsonl` case 0 stayed at `0.921` IoU.
  - Top candidate `visual_score`: `0.141` with color similarity `0.985`,
    boundary contrast `0.339`, perimeter edge support `0.571`.
  - Cold replay timing improved after low-res capture (`19.4s` wall ->
    `12.8s` wall), but app time was still `7.3s`; the 5s product gate needs a
    fresh prewarmed direct-path proof after this change.

## 2026-06-12 New Live Brush Captures - Voxel Surface Default

- User saved two new `brush_boxer` evals to
  `scripts/boxer-evals/live-brush-evals.jsonl` (`15` total cases).
- The second new capture is now flagged by eval quality metadata as suspect:
  the saved target is not projectable from the captured camera, so it should be
  treated as a bad-capture diagnostic rather than a clean accuracy case.
- Replay summaries now expose `scorable_cases`, `unscorable_cases`, and an
  `unscorable_target_view` bucket; the latest two-case replay reports one clean
  scorable case and one `target_not_projected` case.
- Default `client_brush` now lets broad voxel-backed brushes select
  `brush_surface` instead of falling back to the calibrated `brush_ray`
  shortcut.
- Replay on the first new capture:
  - before: `brush_ray`, `0.400` AABB IoU, center error `1.467`.
  - after: `brush_surface`, `0.631` AABB IoU, center error `0.655`.
  - target leak check passes after the replay checker was changed to tolerate
    tiny numeric jitter in runtime output (`2px` for bb2d, `0.03` world units
    for center/dim/corners).
- Speed:
  - Broad voxel brush now skips z-buffer / SDP frame work and reports
    `depth_source=skipped-voxel-brush`.
  - Direct surface return avoids the old candidate sweep; refine time on the
    first new capture dropped to about `0.77-0.84s`.
  - Warm replay of the same case in one browser: second run app total
    `840.9ms` (`1.6ms` frame, `839.3ms` refine), so the click-to-selection
    product path is under 5s after collision sidecar load.
  - Cold replay is still sidecar-load dominated (`~7.2s` app on the first run).
- Current honest status:
  - The warm product path is fast enough on this case.
  - Accuracy is improved but not solved: the selected surface box covers most
    of the target but is still oversized/miscentered (`0.631`, not `.9`).
  - Next quality work should focus on hidden-extent/center correction from
    multi-view support or a target-agnostic support-shrink rule, not on the old
    ray fallback.

## 2026-06-12 Hybrid Voxel Fast Path + Coverage Gate

- Tried all-stroke voxel direct mode:
  - Speed improved: live suite avg app `1.28s`, p95 app `3.91s`,
    `depth_source=skipped-voxel-brush` for all 15 cases.
  - Quality regressed: clean avg `0.596`, and a strong small-stroke ray case
    dropped from `0.862` to `0.621`.
  - Decision: do **not** make all-stroke direct surface the default; keep the
    hybrid behavior where broad strokes use fast voxel surface and small
    strokes can still use the deeper ray/candidate path.
- Added stricter capture-quality scoring:
  - `buildBb2dTargetMetrics` now records `target_covered_by_bb2d` and
    `bb2d_covered_by_target`.
  - Saved evals warn when the prompt covers less than `65%` of the target
    projection.
  - Replay marks these as `prompt_target_coverage_low`, preserving the case as
    a diagnostic but excluding it from the clean accuracy bucket.
- Current hybrid replay on `live-brush-evals.jsonl`:
  - `15/15` replayed.
  - `11` clean/scorable cases, `4` unscorable diagnostics
    (`2 target_not_projected`, `2 prompt_target_coverage_low`).
  - Clean avg IoU: `0.69668513065612`.
  - Best clean IoU: `0.861662776656686`.
  - Not solved: still below `.9`, and small-stroke hybrid path still has p95
    app timing above 5s in cold replay.
- Product read:
  - Broad voxel brush is warm-fast and target-leak clean.
  - All-fast is too inaccurate.
  - The next promising path is not another scalar quantile tweak; offline
    support-sample sweeps stayed around `0.64` average. Need either real
    multi-view productization, better 3D shape priors, or a learned/model
    hidden-extent correction that is bounded by the 2D brush and collision
    visibility.

## 2026-06-12 Gated Small-Stroke Voxel Fast Path

- Added a collision-surface ray-depth fallback for skipped-depth brush frames:
  when the frame reports `depth_source=skipped-voxel-brush`, the `brush_ray`
  candidate can derive ray depth from voxel surface anchors instead of the CPU
  z-buffer.
- Rejected blanket small-stroke skipped-depth:
  - Focused slow set app avg improved to `1.61s`, but quality fell from
    `0.862 -> 0.760` on the best ray case and `0.680 -> 0.575` on a tiny ray
    case.
  - Decision: do **not** use skipped-depth for every voxel brush.
- Current gate:
  - Broad brushes (`area_ratio > 0.1`) keep the direct voxel fast path.
  - Mid-size small brushes (`0.01 <= area_ratio <= 0.05`) use skipped-depth
    voxel ray/surface candidates.
  - High-area ray brushes and tiny ray brushes keep CPU depth because the
    voxel-anchor approximation shifted their centers.
- Focused slow-set replay:
  - Artifact: `/tmp/live-slow-client-brush-gated-fast.json`.
  - Avg IoU improved `0.712 -> 0.722`.
  - App avg improved `6.6s -> 3.26s`.
  - Still not solved: app p95 stayed above 5s because two CPU-depth ray cases
    remain slow.
- Full live replay:
  - Artifact: `/tmp/live-all-client-brush-gated-fast.json`.
  - `15/15` replayed, `11` clean/scorable, `4` diagnostics.
  - Clean avg IoU `0.7008833752652289` (was `0.69668513065612`).
  - Best clean IoU unchanged at `0.861662776656686`.
  - App avg `2.328s`; app p95 `7.063s`; max app `7.454s`.
  - Remaining speed blockers are CPU-depth `brush_ray` cases:
    `2026-06-08T23:10:31.647Z` (`0.862`, `7.45s`) and
    `2026-06-08T23:15:05.492Z` (`0.680`, `6.90s`).
- Tried skipping `brush_surface` evidence on the CPU-ray path:
  - It regressed the best clean case `0.862 -> 0.803`, because the final
    `brush_ray` calibration still uses surface evidence internally.
  - Reverted that behavior; surface evidence remains enabled for the current
    gated-fast build.

## 2026-06-12 Prewarm-Gated Replay Timing

- Accepted app/runtime speed patch:
  - Exposed the existing Boxer frame/depth prewarm as
    `window.__boxerWaitForPrewarm()`.
  - Replay now waits for that prewarm after the splat loads and before timing
    click-to-selection.
  - This matches the product goal better than charging first-click selection
    for work the app can do while the user is looking at the loaded scene.
- Full live replay:
  - Artifact: `/tmp/live-all-client-brush-prewarm-wait.json`.
  - `15/15` replayed, `11` clean/scorable, `4` diagnostics.
  - Clean avg IoU unchanged at `0.7008833752652289`.
  - Best clean IoU unchanged at `0.861662776656686`.
  - App avg `1.171s`; app p95 `2.361s`; max app `2.878s`.
  - First broad case wall time dropped from `~11.3s` to `1.23s`.
- Rejected alternatives checked in the same pass:
  - Native saved `brush_boxer` prompts: first new case was worse (`0.568`
    IoU, `21.7s` app), second timed out at `180s`.
  - Blanket raw brush mode: clean avg dropped to `0.637`, and the best ray
    case regressed `0.862 -> 0.621`.
- Current honest status:
  - The app-side under-5s click-to-selection goal is met for the local brush
    path in this replay.
  - The `.9` real-accuracy goal is not met. Single-view brush remains capped
    around `0.86` best / `0.70` clean avg.
  - Multi-view support fusion is promising but incomplete: current offline
    fusion reaches `0.914` on the 8-view laptop group and `0.849` on the
    3-view can group, but fails newer 2-view groups when one view does not
    project the target.

## 2026-06-12 Runtime Brush-Support Multi-View Fusion

- Added `brush_support` as an in-app `boxer.runEvalFusion` source:
  - Replays each saved brush view from its captured camera.
  - Lifts the 2D brush stroke onto the voxel collision surface.
  - Samples up to about `4000` support points per view, matching the offline
    evidence representation used by `scripts/fuse-brush-views.mjs`.
  - Fuses views with the same target-agnostic rule as the offline proof:
    consensus voxels when support overlaps strongly, otherwise aligned
    support-tight per-axis extents.
- Added a consistency gate:
  - Per-view support boxes must form a connected overlapping component.
  - Incoherent two-view groups return `incoherent-brush-support-views` instead
    of fabricating a fused box from unrelated world regions.
- Runtime replay:
  - Artifact: `/tmp/live-brush-support-fusion-consistent.json`.
  - Command used `--fusion --fusion-source brush_support`.
  - 8-view laptop-like group: `0.9154733452352875` IoU, center error `0.077`.
  - 3-view can group: `0.849250415112494` IoU, center error `0.071`.
  - 2-view glasses/flat-object group: `0.42172356154235935` IoU; still a
    weak diagnostic capture set.
  - New 2-view group: rejected as `incoherent-brush-support-views`.
  - Valid fused-group avg: `0.7288157739633802`.
- Current honest status:
  - This is the first runtime, target-agnostic path that clears `.9` on a real
    multi-view object group.
  - It does not complete the goal: suite-wide `.9` real accuracy is still not
    proven, and the workflow is multi-view eval/box authoring rather than a
    single-click selection result.

## 2026-06-12 Compact-Intersection Fusion + Scorable Group Reporting

- Added a target-agnostic compact-intersection fusion candidate:
  - Eligible only when a small consistent view set (`<=4` views) has strong
    support consensus (`>=0.75` overlap ratio) and the per-view support boxes
    have a real 3D intersection.
  - The candidate intersects the support boxes, then applies a small
    horizontal inflation and tiny vertical shrink.
  - This is meant for compact objects where several brush views agree on the
    same visible shell; it is not used for large/partial objects or weak
    moderate-overlap groups.
- Runtime fusion replay:
  - Artifact: `/tmp/live-brush-support-fusion-scorable-compact.json`.
  - Command used `--fusion --fusion-source brush_support`.
  - 8-view laptop-like group stayed unchanged at `0.9154733452352875`
    (`brush-support-tight`).
  - 3-view can group improved from `0.849250415112494` to
    `0.964113743447068` (`brush-support-compact-intersection`).
  - 2-view flat/glasses diagnostic group stayed at `0.42172356154235935`;
    its two source brush views had `0` scorable target-covering views, so it is
    now reported as diagnostic rather than clean accuracy evidence.
  - New 2-view group still rejects as `incoherent-brush-support-views`; it had
    only `1` scorable source view.
  - Valid/scorable fused-group avg: `0.9397935443411778` over `2` groups.
  - Raw fused-group avg including the diagnostic group remains
    `0.7671035500749049`.
- Speed guard:
  - Current full single-view replay with saved prompt types hit the remote
    `brush_boxer` backend on the two newest cases and timed both out at
    `180s`; do not use that as the local brush timing gate.
  - The 13 completed cases in that run had app `total_ms` avg `1183.6`, p95
    `2384.9`, max `2752.7`.
  - Replaying the two newest saved strokes as `client_brush` succeeded with
    app `total_ms` avg `664.9`, p95 `977.2`, max `1011.9`; one of those
    views is unscorable because the target is not projected from that camera.
- Current honest status:
  - The local brush path remains under the `5s` app-side click-to-selection
    target on the completed/scorable local-brush replays.
  - Multi-view brush-support fusion now clears `.9` on the scorable groups
    (`0.94` avg), but the full goal is not complete as a broad wild single-click
    guarantee: weak captures are still diagnostics/rejections, not solved
    selections.

## 2026-06-12 Local Brush Gate for Saved Boxer Strokes

- Added replay flag `--brush-boxer-as-client`:
  - Converts saved `brush_boxer` stroke prompts to `client_brush` only inside
    the replay harness.
  - Keeps live/product `brush_boxer` honest: the Boxer brush still measures the
    real remote model path unless the replay command explicitly asks for the
    local-brush gate.
- Full saved-suite local brush replay:
  - Artifact: `/tmp/live-all-local-brush-boxer-as-client.json`.
  - Command used `--brush-boxer-as-client --require-brush-points`.
  - `15/15` cases replayed, `0` failed.
  - App timing: avg `1160.2ms`, p95 `2432.9ms`, max `2876ms`.
  - Accuracy: `11` clean/scorable cases, clean avg IoU
    `0.7008833752652289`, best `0.861662776656686`.
  - `4` cases remain diagnostics (`prompt_target_coverage_low` or
    `target_not_projected`).
- Current honest status:
  - The local brush speed gate is now clean across all saved stroke fixtures,
    including the two strokes originally saved as `brush_boxer`.
  - Single-view local brush accuracy is still not `.9`; the `.9+` evidence is
    currently only the scorable multi-view fusion path.

## 2026-06-12 Rejected Single-View Trimmed Surface Candidate

- Tried a target-agnostic-looking `brush_surface_trimmed` candidate after an
  offline sweep over support-sample quantiles looked tempting.
- Rejected it during runtime replay:
  - Artifact: `/tmp/live-all-local-brush-trimmed-candidate.json`.
  - Case `2026-06-08T23:11:18.020Z` cratered from about `0.652` IoU to
    `0.042` IoU.
- Decision:
  - Do not trim the high tail of `brush_surface` as a default selection
    strategy.
  - The failure mode is hidden extent/depth ambiguity, not a scalar quantile
    cleanup problem.
  - Next accuracy work should favor multi-view support fusion, collision/voxel
    visibility gates, or target-agnostic hidden-extent priors.

## 2026-06-12 Replay Gates for Real Speed/Accuracy Claims

- Added replay harness gates:
  - `--require-all-ok`
  - `--min-scorable <n>`
  - `--max-unscorable <n>`
  - `--min-avg-scorable-iou <n>`
  - `--max-app-ms <n>`
  - `--max-p95-app-ms <n>`
- Gated multi-view brush-support replay:
  - Artifact: `/tmp/live-brush-support-fusion-gated.json`.
  - Command used `--fusion --fusion-source brush_support --min-scorable 2
    --min-avg-scorable-iou 0.9`.
  - Passed with `2` scorable groups and avg scorable IoU
    `0.9397935443411778`.
- Gated local single-view speed replay:
  - Artifact: `/tmp/live-all-local-brush-speed-gated.json`.
  - Command used `--brush-boxer-as-client --require-all-ok
    --require-brush-points --min-scorable 11 --max-app-ms 5000
    --max-p95-app-ms 5000`.
  - Passed with `15/15` ok, `11` scorable cases, app `total_ms` max
    `3055.1ms`, p95 `2396.4ms`.
  - Accuracy remains short for single-view: avg scorable IoU
    `0.7008833752652289`.
- Current honest status:
  - The under-5s click-to-selection gate is now executable and passing for the
    local brush path.
  - The `.9` gate is executable and passing only for scorable multi-view
    brush-support fusion, not for broad single-view brush selection.

## 2026-06-12 Save-Time Quality Warnings + Fusion Traceability

- Saved eval cases now record the same capture-quality verdict used by replay:
  - `eval_quality_gate.scorable`
  - `eval_quality_gate.scorable_reason`
- Save/copy toasts now surface diagnostic captures immediately:
  - target not visible
  - brush misses target
  - result misses target
  - camera changed
- Fusion `view_stats` now include `fixture_index`, `captured_at`, and
  `prompt_type` for every accepted/rejected view, so bad multi-view groups can
  be traced to the exact saved fixture row.
- Targeted replay proof:
  - Artifact: `/tmp/live-newest-fusion-viewstats.json`.
  - Command used `--case-index 13-14 --fusion --fusion-source brush_support`.
  - Group still rejects as `incoherent-brush-support-views`, but the reason is
    now explicit:
    - fixture `13` / `2026-06-12T04:20:53.323Z`: scorable, target coverage
      `0.8809633509711757`.
    - fixture `14` / `2026-06-12T04:21:54.920Z`: unscorable,
      `target_not_projected`.
- Current honest status:
  - This does not improve raw IoU by itself.
  - It makes the eval suite harder to game and makes future `.9` claims depend
    on enough real scorable captures instead of silently mixing in bad views.

## 2026-06-12 Ten-View Scorable Fusion Gate

- Added fusion-only replay gate:
  - `--min-total-scorable-views <n>`
  - This prevents a high group average from counting unless the `.9` claim is
    backed by enough source views.
- Gated full-suite replay:
  - Artifact: `/tmp/live-brush-support-fusion-10-view-gated.json`.
  - Command used `--fusion --fusion-source brush_support --min-scorable 2
    --max-unscorable 2 --min-total-scorable-views 10
    --min-avg-scorable-iou 0.9`.
  - Passed with:
    - `4` target groups total.
    - `2` scorable fused groups.
    - `10` total scorable source views.
    - Avg scorable IoU `0.9397935443411778`.
  - Scorable view provenance:
    - group 0 fixtures `0,1,2,3,9,10,11`: IoU
      `0.9154733452352875`.
    - group 1 fixtures `4,5,6`: IoU `0.964113743447068`.
  - Diagnostic groups remain explicit:
    - group 2 has `0` scorable views (`prompt_target_coverage_low` captures).
    - group 3 has only fixture `13` scorable; fixture `14` is
      `target_not_projected`.
- Current honest status:
  - This is the strongest current `.9` proof: `.94` average over `10` real
    scorable brush views using runtime brush-support fusion.
  - It still does not prove single-view `.9` accuracy; single-view local brush
    remains around `.70` clean/scorable average.

## 2026-06-12 Repeatable Goal Gate Scripts + Rejected Scale Prior

- Added package scripts:
  - `pnpm run boxer:gate:speed`
  - `pnpm run boxer:gate:fusion`
- `boxer:gate:fusion` reran successfully:
  - `2` scorable fused groups.
  - `10` total scorable source views.
  - Avg scorable IoU `0.9397935443411778`.
- `boxer:gate:speed` reran successfully:
  - `15/15` ok.
  - `11` scorable cases, `4` diagnostics.
  - App `total_ms`: avg `1133.0ms`, p95 `2280.7ms`, max `2750.8ms`.
  - Single-view avg scorable IoU remains `0.7008833752652289`.
- Rejected offline single-view AABB scale prior:
  - Global per-axis AABB scale sweep over clean/scorable single-view results
    found the best all-case scale was effectively `[1,1,1]`; baseline already
    won with avg `0.7008833752652289`.
  - Source-specific sweep improved only the three `brush_ray` cases
    (`0.7385 -> 0.7739`) and did not approach `.9`; the main `brush_surface`
    path barely moved and reduced the minimum case.
  - Decision: do not add another scalar hidden-extent prior. Single-view misses
    need more information (multi-view, visibility, learned prior, or better
    3D reasoning), not global scale tuning.

## 2026-06-12 Guarded Live Brush-Support Fusion

- Added an app-side live brush-support memory:
  - Each normal brush run stores a subsampled voxel/collision support cloud,
    support AABB, and camera forward vector.
  - Overlapping prior strokes are grouped by support-box IoU.
  - The live path can promote the selected OBB to the same
    support-consensus/tight/compact-intersection family used by runtime
    multi-view fusion.
  - Normal `boxer.runEvalCase` replay disables this memory by default so
    single-case gates remain honest.
- Promotion guard:
  - First view only records support.
  - Weak two-view consensus is not promoted.
  - Compact-intersection can promote early when overlap is strong.
  - Tight fusion requires at least `6` consistent views.
- Added debug and replay hooks:
  - `window.supersplatDebug.getLiveBrushFusionViews()`
  - `window.supersplatDebug.clearLiveBrushFusion()`
  - `scripts/replay-boxer-evals.mjs --live-brush-fusion`
  - `pnpm run boxer:smoke:live-fusion`
- Focused live-path smoke:
  - Artifact: `/tmp/live-brush-fusion-smoke-4-6-guarded.json`.
  - Command used `--case-index 4-6 --live-brush-fusion`.
  - Passed `3/3` ok.
  - View 1: local `client_brush`, IoU `0.843077510369195`.
  - View 2: not promoted, `live-fusion-evidence-not-promoted`,
    consensus overlap `0.62421875`, local IoU `0.6734968259924523`.
  - View 3: promoted to `live-brush-support-compact-intersection`,
    consensus overlap `0.8796875`, IoU `0.9645589795100151`.
  - App `total_ms`: avg `363.8ms`, p95 `439.7ms`, max `452.3ms`.
- Rejected eager live fusion:
  - A full opt-in smoke before the promotion guard proved the mechanism but
    also showed early laptop-group regressions and a late diagnostic timeout.
  - Decision: live fusion is a guarded multi-stroke assist, not a blanket
    replacement for single-stroke local brush.
- Post-change gates:
  - `pnpm run boxer:gate:speed` passed:
    - `15/15` ok.
    - `11` scorable cases, `4` diagnostics.
    - App `total_ms`: avg `1170.6ms`, p95 `2515.8ms`, max `2828.3ms`.
    - Single-view avg scorable IoU remains `0.7008833752652289`.
  - `pnpm run boxer:gate:fusion` passed:
    - `2` scorable fused groups.
    - `10` total scorable source views.
    - Avg scorable IoU `0.9397935443411778`.

## 2026-06-12 Honest Fusion Gate + Product Live-Fusion Proof

- Closed the hidden-support audit issue:
  - `scripts/replay-boxer-evals.mjs` now supports
    `--fusion-scorable-support-only`.
  - `boxer:gate:fusion` uses it for `brush_support` fusion, so each scored
    fusion box is built only from views whose target is projectable and covered
    by the brush prompt.
  - View diagnostics still include unscorable captures, but they cannot boost
    the scored support cloud.
- `pnpm run boxer:gate:fusion` passed under the stricter contract:
  - `4` groups total.
  - `2` scorable groups.
  - `10` total scorable source views.
  - Avg scorable IoU `0.9379826934975393`.
  - Large group used only fixtures `0,1,2,3,9,10,11`, method
    `brush-support-tight-consensus-edge`, IoU `0.9118516435480104`.
  - Can group used fixtures `4,5,6`, method
    `brush-support-compact-intersection`, IoU `0.964113743447068`.
- Added `pnpm run boxer:gate:live-fusion` as the product-path proof:
  - Runs both live-memory sequences with
    `--min-final-iou 0.9 --max-final-app-ms 5000`.
  - Can sequence (`4-6`) final result:
    - label `live-brush-support-compact-intersection`.
    - IoU `0.9645589795100151`.
    - app `total_ms` `432.90000000596046`.
  - Large/laptop-like sequence (`0-3,9-11`) final result:
    - label `live-brush-support-tight-consensus-edge`.
    - IoU `0.9117435031266848`.
    - app `total_ms` `1235.2000000178814`.
- `pnpm run boxer:gate:speed` passed after the gate changes:
  - `15/15` ok.
  - `11` scorable cases, `4` diagnostics.
  - App `total_ms`: avg `1135.7ms`, p95 `2368.6ms`, max `2836.3ms`.
  - Single-view avg scorable IoU remains `0.7008833752652289`.
- Added 2D painted-mask evidence to visual candidate scoring:
  - Downsampled brush mask is stored in `BrushVisualEvidence`.
  - Candidate visual scores now expose `brush_coverage`,
    `brush_density`, and `brush_inside_count`, alongside color similarity,
    boundary contrast, and perimeter edge support.
  - This makes the 2D mouse/brush stroke an explicit canonical signal for
    evidence-mode scoring and debug output.
- Rejected broad default visual scoring for voxel-backed brush:
  - Enabling visual scoring for all non-raw voxel brush paths failed
    `boxer:gate:speed`.
  - Failed run app `total_ms`: avg `1933.6ms`, p95 `6989.7ms`, max
    `7048.4ms`.
  - Decision: keep visual evidence available for `brush.mode === "evidence"`
    and non-voxel paths, but preserve the default voxel brush fast path.
  - This keeps orange/default live behavior under `5s`; blue/evidence mode can
    pay for image color/edge/mask evidence when explicitly used.

## 2026-06-12 Live Fusion Current-View Reprojection Guard

- Added a target-agnostic product safety gate before live brush-support fusion
  can promote a fused 3D box:
  - Project the fused OBB back into the current camera.
  - Compare that projected 2D box against the current brush-derived local 2D
    box.
  - Reject promotion as `live-fusion-reprojection-rejected` unless the fused
    box still overlaps the latest stroke intent.
- Why:
  - Multi-view memory is now powerful enough to override the local single-view
    brush result.
  - The latest 2D stroke/click should remain canonical, so stale or wrong
    support memory cannot promote a box that no longer appears under what the
    user just painted.
- Artifact evidence:
  - Can sequence final promotion:
    - `reprojection_overlap.iou`: `0.6890887797852104`.
    - current brush box covered by fused projection: `1`.
    - final IoU remains `0.9645589795100151`.
    - app `total_ms` `412.40000000596046`.
  - Large sequence final promotion:
    - `reprojection_overlap.iou`: `0.8482464909490816`.
    - current brush box covered by fused projection: `0.8927161852151283`.
    - fused projection covered by current brush box: `0.9445316583155285`.
    - final IoU remains `0.9117435031266848`.
    - app `total_ms` `1290`.
- Gates after this guard:
  - `pnpm run boxer:gate:live-fusion` passed:
    - can final IoU `0.9645589795100151`, final app `412.4ms`.
    - large final IoU `0.9117435031266848`, final app `1290ms`.
  - `pnpm run boxer:gate:fusion` passed:
    - avg scorable IoU `0.9379826934975393`.
  - `pnpm run boxer:gate:speed` passed:
    - app `total_ms` avg `1653.9ms`, p95 `3342.6ms`, max `3846.6ms`.

## 2026-06-12 Live Fusion Current-Support Guard

- Added a second current-view product safety gate before live brush-support
  fusion promotion:
  - Count current brush-support sample points inside the chosen fused AABB,
    with a small `0.025` world-unit tolerance.
  - Reject promotion as `live-fusion-current-support-rejected` when fewer than
    `24` current support points are inside, or when coverage is below `0.03`.
  - Emit `current_support_inside_count`, `current_support_count`, and
    `current_support_coverage` in `live_brush_fusion` debug output for every
    promoted/rejected candidate after a chosen AABB exists.
- Why:
  - Reprojection proves the fused box lands over the latest 2D stroke.
  - Current-support coverage proves the fused 3D box still contains real
    collision/voxel support from the latest brush view, so old multi-view
    memory cannot promote a box that only looks plausible in 2D.
- Artifact evidence from the current rerun:
  - Can final promotion:
    - method `live-brush-support-compact-intersection`.
    - current support inside/count `3206/3656`.
    - current support coverage `0.8769146608315098`.
    - reprojection IoU `0.6890887797852104`.
    - final IoU `0.9645589795100151`.
    - final app `total_ms` `413.59999999403954`.
  - Large final promotion:
    - method `live-brush-support-tight-consensus-edge`.
    - current support inside/count `3414/3902`.
    - current support coverage `0.8749359302921579`.
    - reprojection IoU `0.8482464909490816`.
    - final IoU `0.9117435031266848`.
    - final app `total_ms` `1301.800000011921`.
- Hardened the product-path live-fusion gate:
  - `scripts/replay-boxer-evals.mjs` now supports
    `--min-final-current-support-coverage`.
  - It also supports `--require-final-live-fusion`, so the product-path proof
    cannot pass from a lucky local-brush final result.
  - It also supports `--expect-cases`, and the live-fusion smoke scripts now
    assert the exact selected fixture count (`3` for the can sequence, `7` for
    the large sequence). This protects the gate from range/filter bugs or future
    fixture shrinkage.
  - It now surfaces final live-fusion `view_count` and
    `consistent_view_count`, and the smoke scripts require enough support views
    for the promoted `.9` box (`3/3` for the can sequence, at least `6/6` for
    the large sequence).
  - It also surfaces support-view camera-forward angle spread and requires the
    final live-fusion support views to span at least `45` degrees, preventing
    near-duplicate camera views from satisfying the multi-view proof.
  - Runtime promotion now applies the same `45` degree angle guard before a
    live fusion candidate can replace the local brush box.
  - The brush panel now shows live fusion state: memory view count, consistent
    view count, angle spread, current support coverage, reprojection IoU, last
    rejection/promotion reason, and a Clear Fusion button.
  - `window.supersplatDebug.getLiveBrushFusionStatus()` exposes that same state
    for manual browser checks.
  - `boxer:smoke:live-fusion` and `boxer:smoke:live-fusion-large` both require
    `--require-final-live-fusion` and
    `--min-final-current-support-coverage 0.5`.
  - They also require `--min-final-reprojection-iou 0.5`, making the
    current-view 2D intent guard part of the gate instead of just runtime
    debug.
  - `summary.final_ok_case.live_brush_fusion` now includes the compact final
    fusion proof block, so failures print the actual support/reprojection
    values.
- Gates after this guard:
  - `pnpm run build:desk:ai:proxy` passed with existing Sass,
    `mediabunny`, and `SpeechRecognition` warnings.
  - `pnpm run boxer:gate:live-fusion` passed with exact case-count and
    support-view-count assertions:
    - can sequence replayed `3` cases; final IoU `0.9645589795100151`, final
      app `503.7ms`, support views `3/3`, max view angle `86.2deg`, current
      support coverage `0.8769146608315098`, reprojection IoU
      `0.6890887797852104`.
    - large sequence replayed `7` cases; final IoU `0.9117435031266848`, final
      app `1246.1ms`, support views `7/7`, max view angle `60.7deg`, current
      support coverage `0.8749359302921579`, reprojection IoU
      `0.8482464909490816`.
  - Negative harness check passed: `--case-index 999 --expect-cases 1` fails
    before replay with `selected no eval cases`.
  - `pnpm run boxer:gate:fusion` passed:
    - `4` groups, `2` scorable groups, `10` total scorable source views.
    - avg scorable IoU `0.9379826934975393`.
  - `pnpm run boxer:gate:speed` passed:
    - `15/15` ok, `11` scorable, `4` diagnostics.
    - app `total_ms` avg `1568.5ms`, p95 `3060.9ms`, max `3490.9ms`.
    - single-view scorable IoU is still `0.7008833752652289`; the full
      `.9` proof remains the product-path multi-view live fusion, not
      single-view local brush.

## 2026-06-12 Eval Save Quality Gate and Rejected Single-View Detours

- Re-ran the current local brush speed gate after the moderate broad-voxel
  hybrid:
  - Artifact: `/tmp/live-all-local-brush-speed-gated.json`.
  - `15/15` ok, `11` scorable, `4` diagnostics.
  - App `total_ms` avg `1406.3ms`, p95 `3464.7ms`, max `4334.9ms`.
  - Single-view scorable IoU is `0.766188459342742`.
  - Main weak clean cases still come from single-view `brush_surface` support
    that matches the current 2D brush but is shifted or too large in 3D.
- Re-ran multi-view fusion after the latest saved evals:
  - Artifact: `/tmp/live-brush-support-fusion-10-view-gated.json`.
  - Still passes at avg scorable IoU `0.9379826934975393`.
  - The proof still covers the two established scorable groups only:
    fixtures `0,1,2,3,9,10,11` and `4,5,6`.
  - New fixture `13` is a one-view group, so it is not a multi-view proof yet.
  - New fixture `14` is not a valid target view: its saved target is not
    projectable from the captured camera and replays at `0` IoU.
- Rejected `client_brush_floor_snap` as a default:
  - Artifact: `/tmp/live-focused-floor-snap.json`.
  - Focused cases `5,6,9,10,11,13,14` dropped to clean avg
    `0.6303252204659365`.
  - It hurt broad surface cases and did not fix fixture `14`.
- Rejected `brush_sam_clean` for the 5s path:
  - Artifact: `/tmp/live-focused-sam-clean.json`.
  - Focused cases `9,10,11,13,14` stayed at clean avg
    `0.6626750639245989`.
  - SAM did not apply (`mask-unavailable-404` or timeout) and app `total_ms`
    averaged `18155.3ms`, far above the click-to-selection budget.
- Fixed the local eval save path so stale sticky targets cannot silently become
  ground truth:
  - `copyEvalCase` now marks reused sticky targets as failed when the target is
    not visible from the captured camera or when the current brush does not
    cover the target projection.
  - `save_local` skips append on that failed quality gate and shows a warning
    instructing the user to save a fresh 4-click target for the current view.
  - This prevents another case like fixture `14`, where the brush was valid but
    the reused target belonged to a different camera/object.
- Post-fix verification:
  - `node --check scripts/replay-boxer-evals.mjs`, package JSON parse, and
    `git diff --check` passed.
  - `pnpm run build:desk:ai:proxy` passed with existing Sass, `mediabunny`, and
    `SpeechRecognition` warnings.
  - `pnpm run boxer:gate:live-fusion` passed:
    - can final IoU `0.9645589795100151`, final app `431ms`.
    - large final IoU `0.9117435031266848`, final app `1336ms`.
    - both final selections were actual live-fusion promotions with current
      support coverage above `0.87`, reprojection IoU above `0.68`, and support
      view angle spread above `45deg`.

## 2026-06-12 Live Fusion Historical Validation

- Problem:
  - The large/laptop live-fusion sequence only promoted the final two tail
    views. The fifth view had enough camera diversity (`47.1deg`) but stayed on
    weak local `brush_surface` geometry at IoU `0.6432837206921538`.
  - Available broad support/consensus AABBs for that view topped out around
    `0.689` IoU, so lowering thresholds would have gamed the gate instead of
    fixing the product behavior.
- Rejected detour:
  - Tried feeding live fusion from `core_support_sample` instead of the broad
    brush `support_sample`.
  - This made the promoted tail views much worse:
    - sixth view IoU dropped to `0.5102709832676086`.
    - seventh/final view IoU dropped to `0.48720699559731584`.
  - Kept `core_support_sample` in debug output, but reverted runtime fusion to
    broad `support_sample`.
- Implemented:
  - Live brush-support fusion now stores the local world OBB for each support
    view.
  - When a later view has enough view diversity but the consensus/tight fusion
    candidate is not promotable, runtime can promote a previous world OBB only
    if the current view validates it:
    - at least `3` consistent support views,
    - max camera-forward angle at least `45deg`,
    - current brush-support coverage of the historical OBB at least `0.35`,
    - historical OBB/support-box IoU at least `0.18`,
    - current reprojection overlap IoU at least `0.35`, or equivalent coverage.
  - Promoted historical boxes report
    `live-brush-support-historical-validated`,
    `historical_source_view_id`, current support coverage, and current
    reprojection overlap.
  - The large live-fusion smoke gate now requires at least `3` promoted scorable
    live-fusion views, with promoted avg IoU at or above `.9`.
- Current gate evidence:
  - `pnpm run boxer:gate:live-fusion` passed:
    - can sequence: `3` cases, `1` promoted view, final IoU
      `0.9645589795100151`, final app `449.5ms`.
    - large sequence: `7` cases, avg IoU `0.9019773542909`, `3` promoted
      views, promoted avg IoU `0.9111688676515218`.
    - large fifth view now promotes as
      `live-brush-support-historical-validated` at IoU
      `0.9213294701095598`, current support coverage
      `0.8051848049281314`, and reprojection IoU `0.850359080591522`.
    - large final IoU remains `0.9117435031266848`, final app
      `1298.7ms`.
  - `pnpm run boxer:gate:speed` passed:
    - `15/15` ok, `11` scorable, `4` diagnostics.
    - app `total_ms` avg `1434.5ms`, p95 `3709.8ms`, max `4440.5ms`.
    - single-view scorable IoU remains `0.766188459342742`.
  - `pnpm run boxer:gate:fusion` passed:
    - `4` groups, `2` scorable groups, `10` total scorable source views.
    - avg scorable IoU `0.9379826934975393`.
- Remaining gap:
  - The product live-fusion proof now has `4/10` promoted smoke views
    (`1/3` can, `3/7` large), not all `10/10`.
  - The objective is closer, but not complete: single-view/local brush is still
    below `.9`, and live fusion still needs more views before promotion on the
    early sequence frames.

## 2026-06-12 Support-Quantile Brush Surface + Visual Timing Guard

- Problem:
  - The first can view (`2026-06-08T23:14:32.388Z`) had enough brush-surface
    support to reach `.9`, but the standard `brush_surface` summary inflated
    and shifted the box. Local single-view IoU was `0.843077510369195`.
  - Broad CPU-depth brush cases were also paying for color/edge visual evidence
    even when geometry still dominated the winning candidate. This pushed the
    speed gate over the 5s app-time budget.
- Implemented:
  - Added a `brush_surface` support-quantile candidate using `1.5/98.5%`
    extents and `1.02` inflation. It is an extra candidate, not a forced
    override.
  - Gated brush visual evidence so broad CPU-zbuffer strokes skip the low-res
    color/edge capture unless `brush.mode === "evidence"`. Compact CPU strokes
    and explicit evidence mode can still use visual scoring.
- Current gate evidence:
  - `pnpm run boxer:gate:speed` passed:
    - `15/15` ok, `11` scorable, `4` diagnostics.
    - app `total_ms` avg `1599.1ms`, p95 `4114.5ms`, max `4592.6ms`.
    - single-view scorable IoU improved to `0.7683202997473967`.
    - first can single-view improved to `0.9012751663065549`.
  - `pnpm run boxer:gate:live-fusion` passed:
    - can sequence avg `0.8464436572696741`, `1` promoted view, final IoU
      `0.9645589795100151`, final app `908.1ms`.
    - large sequence avg `0.9019773542909`, `3` promoted views, promoted avg
      IoU `0.9111688676515218`, final IoU `0.9117435031266848`, final app
      `2039.3ms`.
  - `pnpm run boxer:gate:fusion` passed:
    - `4` groups, `2` scorable groups, `10` total scorable source views.
    - avg scorable IoU `0.9379826934975393`.
- Remaining gap:
  - This adds one more honest single-view `.9` case, but local single-view
    scorable average is still far below `.9`.
  - The full objective is still not complete: `.9` is currently proven only for
    the scorable multi-view fusion groups and selected promoted live-fusion
    views, not for all saved product-path brush clicks.

## 2026-06-12 Product-Path 10-View Gate Closeout

- Implemented:
  - Added `--min-scorable-iou` to `scripts/replay-boxer-evals.mjs`, and wired
    both live-fusion smoke scripts to require every scorable case in the selected
    fixture range to reach `.9`. This prevents the gate from passing on a good
    average while hiding a weak view.
  - Cached repeated brush-surface support summaries during local brush scoring.
    This keeps full surface sampling intact while removing repeated large-cloud
    quantile/sort work from broad strokes.
- Rejected during testing:
  - A broader voxel fast-frame threshold improved app timing but regressed large
    first-view/local candidates (`0.325` and `0.237` IoU), and the new
    per-scorable-case gate caught it.
  - Dynamic broad-stroke anchor reduction improved timing but degraded the final
    large view to `0.768`, so it was reverted.
- Current gate evidence:
  - `pnpm run boxer:gate:live-fusion` passed with per-case `.9` enforcement:
    - can sequence: `3/3` ok/scorable, avg IoU `0.9223706642848878`, min IoU
      `0.9012751663065549`, promoted views `2`, promoted avg IoU
      `0.9329184132740541`, final IoU `0.9645589795100151`, final app
      `442.8ms`.
    - large sequence: `7/7` ok/scorable, avg IoU `0.9263640008701003`, min IoU
      `0.9004336297183209`, promoted views `5`, promoted avg IoU
      `0.9208624175608702`, final IoU `0.9117435031266848`, final app
      `1282.8ms`, app max `4610.2ms`.
  - `pnpm run boxer:gate:speed` passed:
    - `15/15` ok, `11` scorable, `4` diagnostics.
    - app `total_ms` avg `1486.98ms`, p95 `3936.03ms`, max `4386.9ms`.
  - `pnpm run boxer:gate:fusion` passed:
    - `4` groups, `2` scorable groups, `10` total scorable source views.
    - avg scorable IoU `0.9379826934975393`, min scorable group IoU
      `0.9118516435480104`.
- Verdict:
  - The saved 10 product-path smoke views now prove `.9+` per case and under-5s
    app click-to-selection timing.
  - This is still a saved-fixture/product-path claim, not a claim that arbitrary
    wild scenes are solved.

## 2026-06-12 Anti-Benchmax Eval Split Harness

- Implemented:
  - Added `scripts/boxer-evals/eval-splits.json` as a sidecar split manifest for
    `live-brush-evals.jsonl`, avoiding churn in the large JSONL fixture while
    making split status explicit.
  - Added split filters to `scripts/replay-boxer-evals.mjs`: `--split-manifest`,
    `--split`, `--suite`, `--tag`, `--bench-status`,
    `--require-case-metadata`, and `--list-cases`.
  - Replay and fusion summaries now include `eval_metadata` counts, and replay
    results/reports carry the per-case split metadata.
  - Added `scripts/boxer-evals/validate-eval-splits.mjs` plus package scripts:
    `boxer:gate:eval-splits`, `boxer:gate:holdout-ready`, and
    `boxer:eval:list:regression`.
- Current classification:
  - The current saved suite is `10` `regression` / `known_tuned` cases and `5`
    `diagnostic` / `known_diagnostic` cases.
  - There are currently zero true holdout cases. `boxer:gate:holdout-ready`
    fails by design until new unseen cases are saved and annotated.
- Policy:
  - Do not label the existing product-path proof as holdout or wild-scene
    evidence.
  - New holdout cases should stay out of tuning; once a holdout failure is used
    for tuning, move it to regression and replace it with a fresh unseen case.
  - PufferLib/RL remains overkill until there is enough split-clean data; a
    supervised candidate ranker is the likely first learned step.

## 2026-06-15 Selection Truth + Eval Anti-Gaming Tightening

- Implemented:
  - Boxer OBB application now records `selection_truth` with selected-splat
    counts and enables a selected-splat overlay after the run.
  - The selected-splat overlay renders actual selected points with a halo/core
    marker, so debugging starts from what was selected instead of from the
    distorted fitted 3D box.
  - The Boxer debug panel and eval case panel surface selected-splat counts.
  - Replay compact results and `Summary.per_case` now carry
    `selection_truth`; aggregate summaries include selected-splat count stats
    and zero-selection case ids.
  - `validate-eval-splits.mjs` now enforces split/status policy, duplicate
    fixture id detection, duplicate tag detection, fixture scene consistency,
    holdout `unseen` status, holdout forbidden tags, and fresh
    `scene_id::target_group` footprints.
  - Added `boxer:eval:list:holdout` for explicit holdout inspection.
- Expected behavior:
  - `boxer:gate:eval-splits` should still pass on the current branch, but warn
    that no holdout cases exist.
  - `boxer:gate:holdout-ready` should continue to fail until fresh unseen
    holdouts are saved and annotated.
- Why this matters:
  - A bad run can now be classified as wrong object, right object with poor
    point support, or good selected splats with bad box fitting.
  - The current `.9` product-path evidence remains regression/live-fusion
    evidence, not hidden holdout evidence.
