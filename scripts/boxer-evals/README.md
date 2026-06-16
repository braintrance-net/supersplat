# Boxer Desk Closeout

This folder holds the local replay cases used to evaluate the desk/can Boxer
click experiment.

## Honest Client Click Gate

Run against a freshly built and served `dist`:

```bash
PLAYWRIGHT_MODULE=/home/jonam/.nvm/versions/node/v25.9.0/lib/node_modules/playwright \
node scripts/replay-boxer-evals.mjs \
  --file scripts/boxer-evals/desk-can-latest3.json \
  --url http://localhost:<serve-port>/ \
  --prompt-type client_click \
  --fresh-browser \
  --case-timeout-ms 90000 \
  --load-timeout-ms 90000 \
  --verify-target-leak \
  --out /tmp/boxer-target-leak-final.json
```

The target-leak check mutates the target box and requires target-agnostic runtime
output to remain identical.

The replay output now includes a compact `report` object on every successful
case, plus `Summary.per_case` and aggregate rollups for comparing BRUSH, KNN,
SAM, and depth runs. The most useful fields for the Boxer IoU push are:

- `report.selected_candidate.source` / `scale`: which candidate family won,
  such as `brush_region`, `brush_cluster`, `knn_cluster`, `depth_component`, or
  `splat_cluster`.
- `report.client_brush`: brush area, brush candidate count, selected point
  count, connected-cluster size, top brush candidates, and selected source/scale.
- `report.selection_truth`: the actual splat selection count after the fitted
  OBB is applied. Use this with the selected-splat overlay to tell wrong-object
  selections apart from good point selections with bad box fitting.
- `report.knn`: KNN cluster size, source candidate count, capped/relaxed flags,
  and whether KNN won the case.
- `report.depth`: depth source and valid pixel ratio.
- `report.timing_ms`: app total/frame/backend/refine/draw timings and replay
  wall time.
- `report.sam3`: SAM success, mask area, rejection reason, endpoint attempts,
  upload time, and segment time.
- `report.target_leak.status`: `passed`, `failed`, `skipped`, or
  `not_requested`.

The aggregate `Summary` also reports timing p95/max, selected candidate source
counts, source/scale pair counts, selected-splat truth stats, depth valid-ratio
stats, SAM rejection counts, brush averages, and failed target-leak case ids.

## Current Goal Gates

Build and serve the desk app first:

```bash
pnpm run build:desk:ai:proxy
pnpm exec serve dist -C -l 48012
```

Then run the current proof gates:

```bash
pnpm run boxer:gate:eval-splits
pnpm run boxer:gate:speed
pnpm run boxer:gate:fusion
pnpm run boxer:gate:live-fusion
```

`boxer:gate:eval-splits` validates the anti-benchmax sidecar manifest at
`scripts/boxer-evals/eval-splits.json`. The current saved suite is explicitly
classified as `10` `regression` cases and `5` `diagnostic` cases. It is not a
holdout suite. Run this cheap gate before tuning or quoting replay evidence, so
the summary tells you whether a result is from `known_tuned`, diagnostic, or
future unseen cases.

`boxer:gate:speed` verifies the local brush path stays under the `5s`
app-side click-to-selection budget on the saved stroke suite. It requires all
cases to replay, at least `11` scorable cases, at most `4` diagnostics, and max
plus p95 app `total_ms` under `5000`.

`boxer:gate:fusion` verifies the current `.9` accuracy proof for runtime
brush-support multi-view fusion. It requires at least `2` scorable fused
groups, at most `2` diagnostic groups, at least `10` total scorable source
views, average scorable IoU at or above `0.9`, and every scorable fused group
at or above `0.9`. The gate passes `--fusion-scorable-support-only`, so the
scored fusion boxes are built only from source views whose target is projectable
and covered by the brush prompt.

This is intentionally split: the speed gate is single-view/local-brush, while
the `.9` accuracy gate is currently multi-view fusion. Single-view local brush
accuracy is not yet `.9`.

`boxer:gate:live-fusion` is the product-path proof. It runs both live fusion
sequences with `--min-scorable-iou 0.9 --min-final-iou 0.9
--max-final-app-ms 5000`:

- fixtures `4-6`: final can selection must cross `.9`.
- fixtures `0-3,9-11`: final large/laptop-like selection must cross `.9`.
- every scorable case in those two fixture ranges must cross `.9`; averages
  alone are not accepted.
- the large sequence must now promote at least `3` scorable live-fusion views,
  with promoted-view average IoU at or above `0.9`.
- both final selections must also report current support coverage at or above
  `0.5`, preventing stale/empty fusion memory from satisfying the product-path
  proof.
- both final selections must report current-view reprojection IoU at or above
  `0.5`, keeping the latest 2D stroke/click canonical.
- both final selections must be actual live-fusion promotions, not lucky local
  brush results.
- both final selections must report enough live support views:
  `3` consistent support views for fixtures `4-6`, and at least `6` consistent
  support views for fixtures `0-3,9-11`.
- both final selections must span at least `45` degrees of camera-forward view
  diversity, so near-duplicate views cannot satisfy the multi-view proof.
- both fixture ranges assert their exact selected case count with
  `--expect-cases` (`3` for fixtures `4-6`, `7` for fixtures `0-3,9-11`) so a
  range/filter bug cannot shrink the proof set.

The underlying focused live-path smokes are:

```bash
pnpm run boxer:smoke:live-fusion
pnpm run boxer:smoke:live-fusion-large
```

That replay opts into the app's live brush-support fusion memory. Normal replay
keeps this memory disabled so single-case accuracy and speed gates stay honest.
The live path stores support from the first view, refuses weak two-view
consensus, then promotes only when fusion evidence is strong and the fused box
still matches the current stroke. Runtime promotion also refuses support views
whose camera-forward angle spread is below `45` degrees; those views remain in
memory but cannot become the trusted fused box.

Useful live fusion console helpers:

```js
window.supersplatDebug.getLiveBrushFusionViews()
window.supersplatDebug.getLiveBrushFusionStatus()
window.supersplatDebug.clearLiveBrushFusion()
```

## Anti-Benchmax Workflow

The saved desk cases now use a sidecar manifest instead of inline JSONL edits:

```bash
scripts/boxer-evals/eval-splits.json
```

Use these cheap checks while iterating:

```bash
pnpm run boxer:gate:eval-splits
pnpm run boxer:eval:list:regression
pnpm run boxer:eval:list:holdout
```

`boxer:gate:holdout-ready` intentionally fails today because there are no true
holdout cases yet:

```bash
pnpm run boxer:gate:holdout-ready
```

To make a real holdout:

1. Save new evals from fresh objects, camera paths, or scenes that were not used
   to tune Boxer/brush/fusion thresholds.
2. Add their case ids to `eval-splits.json` with `split: "holdout"` and
   `bench_status: "unseen"`.
3. Run the replay with `--split holdout --require-case-metadata`.
4. Do not tune against holdout failures directly. Promote a failed holdout case
   to a new `regression` entry only after recording the failure and adding a
   different fresh holdout replacement.

The manifest policy now enforces the anti-gaming pieces that are cheap to
check:

- holdouts cannot use a `known_*` status, and today must use `unseen`;
- holdouts cannot carry product-path/tuned/regression tags;
- a holdout must introduce a fresh `scene_id::target_group` footprint relative
  to non-holdout cases in the manifest;
- duplicate fixture ids, duplicate tags, unknown split/status values, and
  fixture-level scene mismatches fail the cheap split gate.

Keep the current metrics mentally separated:

- `single_view_brush`: local/client brush replay and speed;
- `live_multiview`: product-path live support promotion;
- `fusion_offline_multiview`: offline grouped/fused support evidence;
- `speed`: app click-to-selection timing.

The app also has a View-panel `Selected Splats` toggle. Boxer runs enable it
automatically after applying a selected OBB, but the manual toggle is useful
when comparing the highlighted splats against candidate/debug boxes.

PufferLib/RL is likely overkill for this phase. The next learned approach should
be a supervised candidate ranker trained only after enough split-clean data
exists; until then, split hygiene and failure-preserving regression cases matter
more than model training.

Latest local gate results:

- `boxer:gate:speed`: `15/15` ok, `11` scorable, `4` diagnostics,
  app `total_ms` avg `1486.98`, p95 `3936.03`, max `4386.9`,
  scorable IoU `0.7683202997473967`.
- `boxer:gate:fusion`: `2` scorable groups, `10` scorable source views,
  avg scorable IoU `0.9379826934975393`, min scorable group IoU
  `0.9118516435480104`.
- `boxer:gate:live-fusion`:
  - can sequence replayed `3` cases; avg IoU `0.9223706642848878`, min IoU
    `0.9012751663065549`, promoted views `2`, promoted avg IoU
    `0.9329184132740541`, final IoU `0.9645589795100151`, final app
    `442.8ms`, support views `3/3`, max view angle `86.2deg`, current support
    coverage `0.8769146608315098`, reprojection IoU `0.6890887797852104`.
  - large sequence replayed `7` cases; avg IoU `0.9263640008701003`, min IoU
    `0.9004336297183209`, promoted views `5`, promoted avg IoU
    `0.9208624175608702`, final IoU `0.9117435031266848`, final app
    `1282.8ms`, app max `4610.2ms`, support views `7/7`, max view angle
    `60.7deg`, current support coverage `0.8749359302921579`, reprojection IoU
    `0.7933565931328129`.

The live fusion path also reprojects the fused 3D box into the current camera
before promotion. The projected fused box must still overlap the current
brush-derived 2D box, keeping the latest stroke/click as the canonical intent.
It also checks that the promoted 3D box contains enough of the current
brush-support cloud; weak current support rejects promotion as
`live-fusion-current-support-rejected`. The brush panel mirrors the same state
with view count, angle spread, current support coverage, reprojection IoU, and
a Clear Fusion action so the product path is not hidden in console memory.

## Manual Brush Test Cases

Build and serve the debug desk app:

```bash
pnpm run build:desk:ai:proxy
pnpm exec serve dist -C -l 37810
```

Open `http://localhost:37810/`, draw an eval target box around the object, then
click `Save Target` in the box toolbar. Switch to the brush selection tool and
paint the object as naturally as possible. While the brush tool is active, adjust
the radius with the `Brush Size` slider, mouse wheel, or the `[` / `]`
shortcuts. The brush tool stores the real stroke points and radius as a
`client_brush` prompt.

After releasing the stroke, use the `Boxer Brush Test` panel to run the brush
or copy a brush eval case.

The browser save button uses the sticky `Save Target` box if no target is passed
directly. Reused sticky targets are now quality-gated before local save: if the
saved target is not visible from the captured camera, or if the current brush
does not cover the target projection, the eval is not appended. Save a fresh
4-click target for the current view/object before saving the brush eval.

That copies one `boxer-eval-case/v1` JSON blob to the clipboard. Paste several
of them into a new JSON file, then replay them. The recovered June 5 human
brush suite lives at `scripts/boxer-evals/desk-can-brush-human-v1.json`.

```bash
PLAYWRIGHT_MODULE=/home/jonam/.nvm/versions/node/v25.9.0/lib/node_modules/playwright \
node scripts/replay-boxer-evals.mjs \
  --file scripts/boxer-evals/desk-can-brush-human-v1.json \
  --url http://localhost:37810/ \
  --require-brush-points \
  --verify-target-leak \
  --case-timeout-ms 120000 \
  --load-timeout-ms 90000 \
  --out /tmp/boxer-brush-human-results.json
```

Useful console helpers:

```js
window.supersplatDebug.getLastBrushBoxerPrompt()
window.supersplatDebug.getBrushSelectionRadius()
window.supersplatDebug.setBrushSelectionRadius(56)
await window.supersplatDebug.runLastBrushBoxer()
await window.supersplatDebug.copyLastBrushBoxerEvalCase()
```

## SAM Proxy Proof Gate

Build with `SAM3_BACKEND_URL=http://localhost:47824`, start
`scripts/sam3-dev-proxy.mjs`, and run:

```bash
curl -s http://localhost:47824/healthz | jq .
```

```bash
PLAYWRIGHT_MODULE=/home/jonam/.nvm/versions/node/v25.9.0/lib/node_modules/playwright \
node scripts/replay-boxer-evals.mjs \
  --file scripts/boxer-evals/desk-can-latest3.json \
  --url http://localhost:<serve-port>/ \
  --prompt-type click_sam \
  --fresh-browser \
  --case-index 1 \
  --case-timeout-ms 90000 \
  --load-timeout-ms 90000 \
  --require-sam-success \
  --out /tmp/boxer-click-sam-proxy-proof.json
```

This gate fails if the replay does not produce a non-empty SAM mask region.
The exact backend contract and planned `brush_sam` extension are documented in
`scripts/boxer-evals/SAM_PROOF_GATE_PLAN.md`.

For the current `click_sam` app path, one SAM endpoint must return HTTP 200 JSON
with:

```json
{
  "mask": "<base64 png mask without data URL prefix>",
  "width": 960,
  "height": 512,
  "supportsPromptRefinement": true
}
```

`mask`, `width`, and `height` are required. `supportsPromptRefinement` is
required only once the request contains more than one prompt point. The proxy
logs sanitized request/response summaries with an `X-SAM3-Proxy-Request-Id`;
attach those logs to proof-gate results.

To test SAM with the real brush stroke points instead of a single click, replay
the brush suite with `--prompt-type brush_sam` and `--require-sam-success`.

Latency target: keep product click-to-box under 5 seconds. The current Boxer
client SAM timeout is 1800 ms, while the proxy default timeout is 15000 ms so
backend failures stay diagnosable during local experiments.

Latest local result:

- Artifact: `/tmp/boxer-click-sam-proxy-proof.json`
- Case: `angle-280-drifted`
- Result: gate failed as expected because the proxy was reached but upstream did
  not return a mask.
- Upstream attempts:
  - `/api/sam3/refine`: `501`
  - `/api/sam3/segment`: `520`
  - `/upload`: `501`
- SAM rejection: `mask-unavailable-501`
- App `timing.total_ms`: `14598.3`
