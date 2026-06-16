# DA3 Proof Gate Plan

This is the narrow Depth Anything 3 lane for Boxer/Brush work. DA3 should be
tested as an auxiliary depth prior, not as the source of metric truth.

## Current Fit

- Official source: `https://github.com/ByteDance-Seed/Depth-Anything-3`.
- Best first model for this repo: `depth-anything/DA3-BASE` or
  `depth-anything/DA3-SMALL`, because the larger and nested models are too heavy
  for quick local iteration.
- Expected output to compare: dense depth and confidence for the rendered Boxer
  frame, aligned against SuperSplat CPU center-zbuffer depth at visible anchors.
- Do not compare DA3 depth directly to target AABB IoU without alignment; the
  useful signal is whether it improves visible mask/depth continuity enough to
  pick a better candidate.

## Runtime Gate

DA3's official quick start uses CUDA. Before running a model proof:

```bash
nvidia-smi
python3 --version
uv --version
df -h /home
```

If CUDA is unavailable, do not spend time installing the full DA3 stack in this
workspace. Use a GPU host or a small isolated clone with the official package.

## Proof Experiment

1. Export one replay frame from `scripts/boxer-evals/live-brush-evals.jsonl`.
2. Run DA3 on that RGB frame and save depth/confidence as `.npz`.
3. Align DA3 relative depth to `frame.depth` using visible SuperSplat anchors
   inside the brush/SAM mask.
4. Report correlation, aligned depth error, and whether the selected Boxer
   candidate changes.
5. Only after a positive single-case result, wire DA3 as an optional candidate
   score/debug source.

## Pass Criteria

- DA3 produces depth for the exact replay frame.
- The aligned DA3 prior improves at least one current hard brush/SAM case
  without reducing the clean live-brush average.
- The added runtime path is optional and diagnosable; Boxer still returns a box
  when DA3 is unavailable.

