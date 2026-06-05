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

## SAM Proxy Proof Gate

Build with `SAM3_BACKEND_URL=http://localhost:47824`, start
`scripts/sam3-dev-proxy.mjs`, and run:

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
