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

- **Direct hosted SAM from the browser - fail/risky**
  - Result: direct `https://sam3.4dream.app` browser access was not a reliable
    production-like path.
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
  - `https://sam3.4dream.app` is not currently reaching this FastAPI service.
    It serves an unrelated static "Splat Thumbnail Comparison" page, with
    `/docs` and `/openapi.json` returning static HTML `404` and POSTs returning
    static HTML `501`.
  - Use `SAM3_PROXY_TARGET=http://3.19.208.185:8000` for evals until that DNS /
    Cloudflare route is corrected.
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
