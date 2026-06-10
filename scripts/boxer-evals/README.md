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
counts, source/scale pair counts, depth valid-ratio stats, SAM rejection counts,
brush averages, and failed target-leak case ids.

Latest local result:

- Artifact: `/tmp/boxer-target-leak-final-timed.json`
- Cases: `4/4` ok
- Target-leak checks: `4/4` passed
- Avg AABB IoU: `0.33125800831003743`
- Min/max AABB IoU: `0.2179194949963069 / 0.39611528791366585`
- Avg 2D target IoU: `0.5058008908541819`
- App `timing.total_ms`: `205`, `670`, `649.8`, `387.8`
- Replay wall time avg: `4615.2621675ms`; this includes Playwright
  evaluation and result serialization overhead, not just app click latency.

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
