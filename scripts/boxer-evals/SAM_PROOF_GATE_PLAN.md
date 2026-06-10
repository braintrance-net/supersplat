# Boxer SAM Proof Gate Plan

This is the narrow SAM lane before changing `src/tools/boxer-selection.ts`.
The goal is to prove that SAM can return a usable 2D mask for Boxer, then let
local SuperSplat geometry do the 3D lift.

## Current Boxer Request Contract

For `click_sam`, Boxer first posts JSON to `/api/sam3/refine` through
`SAM3_BACKEND_URL`:

```json
{
  "image": "<base64 png frame>",
  "object_id": 1,
  "frame_index": 0,
  "clear_old_points": true,
  "coordinate_space": "normalized",
  "image_size": { "width": 960, "height": 512 },
  "points": [[0.696, 0.626]],
  "labels": [1]
}
```

If that fails with `404`, `405`, or `501`, the current app tries
`/api/sam3/segment`, then `/upload` plus `/segment_point`.

## Required Backend Response

The proof gate needs one successful endpoint to return HTTP 200 JSON:

```json
{
  "mask": "<base64 png mask without data URL prefix>",
  "width": 960,
  "height": 512,
  "job_id": "optional-session-id",
  "supportsPromptRefinement": true,
  "timing": {
    "encode_ms": 0,
    "inference_ms": 0,
    "total_ms": 0
  }
}
```

Required fields:

- `mask`: PNG mask as base64. The app decodes the red channel and treats
  nonzero pixels as selected.
- `width` and `height`: pixel dimensions of the mask, matching the returned
  mask image.
- `supportsPromptRefinement`: required to be `true` only when a request uses
  more than one prompt point. Single-click `click_sam` can omit it.

Recommended fields:

- `job_id`: stable session id for accumulated prompt refinement.
- `timing.total_ms` or equivalent backend timing fields.
- `error` or `detail` on non-200 responses.

For `brush_sam`, use the same `/api/sam3/refine` response. Boxer sends sampled
positive prompt points derived from the brush stroke, not a target box or
target-derived mask. If the `/api/sam3/refine` and `/api/sam3/segment` JSON
contracts are unavailable, the local SAM3D fallback uploads the frame and calls
`/segment_points` with pixel-space brush points.

## Latency Budget

The product budget is click-to-box under 5 seconds. The current honest local
geometry path is under 1 second in app timing, so SAM should be treated as
optional evidence:

- Preferred backend response budget: 1500 ms.
- Current Boxer SAM client timeout: 1800 ms.
- Proxy diagnostic timeout: 15000 ms by default, only to make endpoint failures
  observable during proof-gate work.
- If SAM misses the 1800 ms client budget, local Boxer geometry should still be
  allowed to produce the box in the later app integration.

## Proof Gates

Run the proxy health check:

```bash
curl -s http://localhost:47824/healthz | jq .
```

Run the single-case `click_sam` gate:

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

Run the brush-prompt gate:

```bash
PLAYWRIGHT_MODULE=/home/jonam/.nvm/versions/node/v25.9.0/lib/node_modules/playwright \
node scripts/replay-boxer-evals.mjs \
  --file scripts/boxer-evals/live-brush-evals.jsonl \
  --url http://localhost:<serve-port>/ \
  --prompt-type brush_sam \
  --fresh-browser \
  --case-index 1 \
  --case-timeout-ms 90000 \
  --load-timeout-ms 90000 \
  --require-brush-points \
  --require-sam-success \
  --out /tmp/boxer-brush-sam-proxy-proof.json
```

Pass criteria:

- Replay exits successfully with `--require-sam-success`.
- `sam3_augmentation.region.point_count >= 24`.
- Proxy logs show at least one upstream `ok: true` response with `has_mask`.
- No target-leak gate failures when the same experiment is expanded to the full
  case set.

## Diagnostics To Capture

The proxy logs one JSON line for each request, response, and error. Keep these
with the replay output when reporting a SAM result:

- `request_id`
- endpoint path and upstream status
- duration in ms
- sanitized prompt summary: point count, labels, image size
- response contract summary: mask present, width, height,
  `supportsPromptRefinement`

Do not log full images or masks in proof-gate reports.
