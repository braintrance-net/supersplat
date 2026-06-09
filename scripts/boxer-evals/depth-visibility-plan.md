# Cached Layered Surfel / Depth Visibility Index Plan

## Goal

Build a cached depth-first geometry index that lets `client_click` and
`client_brush` query object-scale 3D evidence quickly enough for a product path:

- Target quality: approach `0.8` AABB IoU without target-box leakage.
- Target latency: under `5s` end-to-end for a cold interaction if possible, and
  under `1s` for warm click/brush queries after scene-level caching.
- Scope: improve local SuperSplat depth/visibility evidence before relying on
  Boxer output, SAM masks, or manual target boxes.

The core idea is to stop treating depth as one nearest visible center per pixel.
Instead, build a reusable index of projected surfel layers, splat IDs, local
3D adjacency, and multi-view visibility. A click or brush becomes a query into
that index, not a fresh global scan plus scale sweep.

## Current Repo Baseline

Relevant current surfaces:

- `getSplatWorldCenterCache`: caches transformed splat centers in world space.
- `renderSplatDepth`: builds the current CPU nearest-center z-buffer at about
  one third image resolution.
- `sampleSplatSurfacePoints`: filters world centers to the front surface using
  the depth buffer.
- `collectProjectedSplatCandidates`: scans projected centers in a 2D box.
- `filterFrontSurfaceProjectedCandidates`: coarse front-surface filter by
  nearest depth in screen cells.
- `depthConnectedBb2d`: grows a 2D connected depth component from the click.
- `growProjectedKnnCluster`: current KNN-ish 3D/screen/depth cluster growth.
- `buildClientClickObb` and `buildClientBrushObb`: current local candidate
  generation and scoring entrypoints.
- multi-view fusion path: counts `splatIndex` support across views and fits
  an OBB from selected points.

Observed limits:

- Single-layer nearest-center depth misses splat footprint thickness and all
  occluded/backside volume.
- `front_surface_centers` is good for visible surface anchoring, but it
  intentionally throws away hidden object extent.
- Loose brush regions improve the 2D signal but still collect wrong visible
  surfaces without stronger depth/visibility separation.
- Current browser GPU depth is slower and worse in this suite; do not depend on
  WebGL readback as the MVP path.
- KNN helps only incrementally unless it is constrained by richer visibility
  evidence.

## Proposed Data Structures

### `DepthVisibilityIndex`

One index per `(splat, worldTransform, scene revision)` with view-dependent
subcaches.

```ts
type DepthVisibilityIndex = {
  version: 1;
  splat: Splat;
  sourceCenters: Float32Array;
  worldTransformKey: string;
  pointCount: number;
  worldCenters: Float32Array;
  pointMeta: SurfelMetaArrays;
  spatialGrid: SpatialGrid;
  viewCaches: Map<string, ViewVisibilityCache>;
  buildStats: DepthVisibilityBuildStats;
};
```

### `SurfelMetaArrays`

Keep this structure array-of-scalars for speed and memory predictability.

```ts
type SurfelMetaArrays = {
  selected: Uint8Array;          // current editor selection, optional in MVP
  density: Float32Array;         // approximate local neighbor density
  radius: Float32Array;          // estimated surfel footprint radius
  normalX: Float32Array;         // approximate local PCA/grid normal
  normalY: Float32Array;
  normalZ: Float32Array;
  componentId: Int32Array;       // optional connected component label
};
```

MVP can leave `selected`, normals, and `componentId` as defaults. The important
first win is a spatial grid plus view-layer caches.

### `SpatialGrid`

World-space hash grid over splat centers. It replaces repeated full scans for
local KNN, ray marching, and query expansion.

```ts
type SpatialGrid = {
  cellSize: number;
  cells: Map<number, Uint32Array>;
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
};
```

Initial `cellSize` should be adaptive:

- Start from scene scale or median nearest-neighbor distance if cheap.
- Practical first value: same family as existing KNN thresholds, roughly
  `max(0.05, medianDepth * 0.008)` for view queries, plus a global floor.

### `ViewVisibilityCache`

One view cache per camera/intrinsics/canvas size. It stores layered projected
surfel evidence.

```ts
type ViewVisibilityCache = {
  key: string;
  imageWidth: number;
  imageHeight: number;
  tileSizePx: number;
  tileWidth: number;
  tileHeight: number;
  intrinsics: Intrinsics;
  extrinsics: number[];
  layers: TileDepthLayers;
  projected: ProjectedSurfelArrays;
  buildStats: ViewVisibilityBuildStats;
};
```

### `TileDepthLayers`

Use a small fixed number of layers per tile. Four layers is enough for MVP:
nearest visible, second surface, far support, and density/uncertainty.

```ts
type TileDepthLayers = {
  nearestDepth: Float32Array;    // tile count
  secondDepth: Float32Array;
  farDepth: Float32Array;
  nearestIndex: Int32Array;
  secondIndex: Int32Array;
  visibleCount: Uint16Array;
  totalCount: Uint16Array;
  depthMean: Float32Array;
  depthVariance: Float32Array;
};
```

Layer update rule per projected splat center:

1. Project center into the view.
2. Find the tile.
3. Insert depth into nearest/second/far buckets.
4. Increment `totalCount`.
5. Mark visible if within `visibilityTolerance(nearestDepth)` after the pass.

For MVP, `farDepth` can be the `0.90` depth quantile per tile rather than the
maximum, so background tails do not dominate.

### `ProjectedSurfelArrays`

Dense projected data for fast candidate filtering.

```ts
type ProjectedSurfelArrays = {
  pixelX: Float32Array;
  pixelY: Float32Array;
  depth: Float32Array;
  inFrame: Uint8Array;
  layerClass: Uint8Array;        // 0 hidden/out, 1 nearest, 2 near, 3 far
  tileIndex: Int32Array;
};
```

This lets `collectProjectedSplatCandidates` become a view-cache query rather
than a full projection loop for every candidate bbox.

## Build Algorithm

### Scene-Level Build

Inputs: `splat`, current world transform, optional editor selection state.

1. Reuse the existing world-center transform cache.
2. Build or reuse `SpatialGrid`.
3. Estimate local density and optional surfel radius:
   - For MVP, radius can be approximate from neighbor count in adjacent grid
     cells.
   - Later, use Gaussian covariance if accessible from `gsplat` internals.
4. Store `DepthVisibilityIndex` in a `WeakMap<Splat, DepthVisibilityIndex>`.
5. Invalidate when `sourceCenters` identity changes, world transform changes,
   splat count changes, or scene revision increments.

Expected cost:

- World center cache already exists; reuse it.
- Spatial grid over 100k-500k centers should target `100-500ms` in JS.
- Density/radius estimates should be optional in MVP to protect latency.

### View Cache Build

Inputs: index, scene camera, image width/height, intrinsics/extrinsics.

1. Derive a stable view key:
   - canvas size
   - camera view matrix
   - projection/intrinsics
   - splat world transform key
2. Allocate projected arrays sized to `pointCount`.
3. Project every world center once into this view.
4. Fill tile depth layer accumulators:
   - nearest and second depth by insertion.
   - far/depth quantile by compact per-tile sample lists or approximate bins.
5. Classify each in-frame point:
   - `nearest`: within `max(0.04, nearestDepth * 0.015)`.
   - `near`: within a wider object-surface band, e.g. `nearestDepth * 0.04`.
   - `far`: inside the tile's robust depth support but behind near layer.
   - `hidden/out`: in-frame but not useful for this view's visible object query.
6. Cache `visibleCount`, `totalCount`, `depthMean`, and `depthVariance`.

Expected cost:

- One full projection pass: target `100-300ms` for moderate scenes.
- Layer classification: target `30-100ms`.
- Total warm-cache view build target: `250-700ms`.

### Optional Multi-View Cache Build

For the `0.8` target, build a small set of synthetic or user-camera-adjacent
views during idle:

- Current view.
- Left/right orbit offsets.
- Slight top/bottom offsets.
- A few semantic object-facing views if a viewpoint planner is available.

Each view stores a `ViewVisibilityCache`. Multi-view fusion then uses per-splat
support counts, not target boxes.

Cold target:

- 6 views under `3-5s` total in browser JS if projection is optimized and work
  is chunked.
- Warm click/brush query under `300-800ms`.

## Query Algorithm

### Shared Query Input

```ts
type VisibilityQuery = {
  kind: 'click' | 'brush' | 'sam_mask' | 'boxer_bb2d';
  click?: [number, number];
  brushMask?: Uint8Array;
  brushBb2d?: NormalizedBb2d;
  bb2d?: NormalizedBb2d;
  imageWidth: number;
  imageHeight: number;
};
```

### Query Stages

1. Resolve or build the current `ViewVisibilityCache`.
2. Seed candidate splats:
   - Click: nearest/near splats in a local tile radius around click.
   - Brush: splats whose projected pixels are inside the brush raster, not just
     the brush bounding box.
   - SAM mask: same as brush but from the SAM mask.
   - Boxer bbox: projected splats inside bbox, using layers to reject
     background.
3. Choose seed depth:
   - Median nearest/near layer depth under click or mask core.
   - Record `seed_depth_source`.
4. Grow a graph cluster over `SpatialGrid`:
   - Require local 3D neighbor distance.
   - Require projected 2D continuity in the current view.
   - Allow depth to move gradually, but cap distance from seed by object prior.
   - Penalize transitions across tiles with low visible/total support.
   - Prefer splats visible in more than one cached view.
5. Infer occluded volume:
   - Use `near` and `far` tile layers to estimate thickness behind the visible
     surface.
   - Use multi-view support counts when available.
   - Use class/shape priors only as explicit candidate priors, never as hidden
     target-box information.
6. Generate OBB candidates:
   - visible-surface OBB
   - layered-depth OBB
   - multi-view fused OBB
   - conservative prior-expanded OBB
7. Score candidates:
   - projection fit against non-oracle prompt evidence
   - layer support ratio
   - connected graph support
   - multi-view support
   - depth thickness plausibility
   - brush/mask containment
   - penalty for background bridging and huge area

### Candidate Score Sketch

```ts
score =
  projectionFit * 0.25 +
  layerSupport * 0.25 +
  graphConnectivity * 0.20 +
  multiViewSupport * 0.20 +
  promptContainment * 0.15 +
  thicknessPlausibility * 0.10 -
  backgroundBridgePenalty -
  excessiveVolumePenalty;
```

Weights should be logged and tuned with replay artifacts, not hidden in
constants without metrics.

## Integration Points

### `getSplatWorldCenterCache`

Add a sibling cache:

- `getDepthVisibilityIndex(splat, scene?)`
- Reuse `sourceCenters`, `worldCenters`, `count`, and transform checks.
- Do not duplicate world center memory if the existing cache can own it.

### `renderSplatDepth`

Keep this as the fallback depth source and compatibility path for Boxer payloads.

MVP integration:

- Build `ViewVisibilityCache` first.
- Produce the current single-layer depth buffer from `nearestDepth` rather than
  re-projecting centers again.
- Keep `depth_source: 'cpu-center-zbuffer'` until the payload contract changes.

Future payload:

- Add optional debug-only fields for layered stats first.
- Only add backend contract fields after replay proof.

### `sampleSplatSurfacePoints`

Replace the current nearest-depth filter with view-cache layer classes:

- `front_surface_centers`: layer `nearest`.
- `near_surface_centers`: layers `nearest | near`.
- `layered_support_centers`: layers `nearest | near | far`, capped.

Keep the existing fallback to `frustum_centers` if visible support is too small.

### `collectProjectedSplatCandidates`

Use `ProjectedSurfelArrays` and tile ranges to avoid full global scans per bbox:

1. Convert bbox to tile range.
2. Iterate splat IDs stored per tile or scan projected arrays with a tile index
   filter.
3. Return the same `ProjectedSplatCandidate` shape so existing callers can
   migrate incrementally.

### `filterFrontSurfaceProjectedCandidates`

Replace or overload with:

- `filterByLayer(candidates, ['nearest'])`
- `filterByLayer(candidates, ['nearest', 'near'])`
- `filterByLayerAndPrompt(candidates, promptMask)`

This keeps old call sites readable and makes layer selection explicit.

### `depthConnectedBb2d`

Use tile layers instead of raw single-depth pixels:

- Strict mode: connected nearest layer around click.
- Object mode: connected nearest+near layer with far support evidence.
- Debug mode: compare old depth-component bbox vs layered-component bbox.

### `buildClientClickObb`

Add a new candidate source, not a replacement on day one:

- `layered_visibility_cluster`
- `layered_ray_bundle`
- `multiview_visibility_cluster`

Record it beside existing `splat_cluster`, `depth_component`, and `knn_cluster`
sources. This preserves the current honest fallback while measuring lift.

### `buildClientBrushObb`

MVP should consume a raster brush mask, not only `bb2d` plus stroke distance.

Add candidate sources:

- `brush_layered_visibility`
- `brush_multiview_visibility`

The brush should act as positive/negative 2D evidence over view-cache layers:

- inside mask + nearest/near = strong positive
- inside mask + far = possible hidden support
- outside mask but connected in 3D = weak support or penalty

### Multi-View Fusion

The current group fusion path already counts splat IDs across views. Reuse the
same primitive online:

- Build `ViewVisibilityCache` for N cached views.
- For each query cluster, count splat support across views.
- Require at least one current-view prompt hit plus enough cached-view support.
- Fit OBB from selected world centers with robust quantiles.

This is the highest-probability path to `0.8` because it observes volume rather
than guessing it from one view.

## Performance Budget

### Cold Load / Idle Precompute

| Step | Target |
| --- | ---: |
| world center cache | existing cost, usually `0-300ms` |
| spatial grid build | `100-500ms` |
| current view cache | `250-700ms` |
| 6 cached views | `1.5-4.5s` chunked/idle |
| total cold target | `<5s` if scene size is moderate |

### Warm Query

| Step | Target |
| --- | ---: |
| resolve cache | `<10ms` |
| seed prompt candidates | `10-50ms` |
| graph cluster growth | `30-150ms` |
| ray bundle / layered thickness | `30-150ms` |
| multi-view support count | `30-200ms` |
| OBB candidates and scoring | `20-100ms` |
| total warm target | `150-800ms` |

### Memory Budget

For `N` splats:

- world centers: existing `12N` bytes.
- projected arrays per view: about `17N` bytes with floats/typed arrays.
- layer arrays per tile: small compared to splat arrays.
- 6 views for 300k splats: roughly `30-45MB` projected cache, depending on
  fields and alignment.

Mitigations:

- Keep only current view plus most useful cached views.
- Store projected arrays as quantized `Uint16` pixels and `Float32` depth if
  memory becomes the bottleneck.
- Drop full projected arrays for old views after building per-splat support
  counts.

## Debug Metrics

Add these to `client_click_probe` and `client_brush_probe` when enabled:

### Build Metrics

- `depth_visibility_index_version`
- `depth_visibility_point_count`
- `depth_visibility_grid_cell_size`
- `depth_visibility_grid_cell_count`
- `depth_visibility_grid_build_ms`
- `view_visibility_cache_hit`
- `view_visibility_build_ms`
- `view_visibility_project_ms`
- `view_visibility_layer_ms`
- `view_visibility_tile_size_px`
- `view_visibility_tile_count`

### Layer Metrics

- `layer_nearest_point_count`
- `layer_near_point_count`
- `layer_far_point_count`
- `layer_hidden_point_count`
- `layer_visible_ratio`
- `layer_depth_min`
- `layer_depth_median`
- `layer_depth_max`
- `layer_depth_spread_p90_p10`

### Query Metrics

- `visibility_query_kind`
- `visibility_seed_depth`
- `visibility_seed_depth_source`
- `visibility_seed_candidate_count`
- `visibility_graph_candidate_count`
- `visibility_graph_selected_count`
- `visibility_graph_component_count`
- `visibility_background_bridge_penalty`
- `visibility_layer_support_ratio`
- `visibility_far_support_ratio`
- `visibility_multiview_view_count`
- `visibility_multiview_min_views`
- `visibility_multiview_supported_count`
- `selected_candidate_source`
- `selected_candidate_scale`
- `projection_fit`

### Comparison Metrics

For the first few runs, log both old and new candidates:

- `legacy_connected_cluster_point_count`
- `legacy_depth_window_point_count`
- `legacy_depth_component_pixel_count`
- `legacy_selected_candidate_source`
- `legacy_aabb_dimensions`
- `layered_selected_candidate_source`
- `layered_aabb_dimensions`
- `candidate_score_breakdown`

In replay output, keep reporting:

- `aabb_iou`
- `center_distance`
- `bb2d_iou` or final projected 2D IoU
- in-app `timing.total_ms`
- target-leak verification result

## First MVP Steps

1. Add `DepthVisibilityIndex` and current-view `ViewVisibilityCache` behind a
   feature flag.
   - No behavior change.
   - Log build/cache metrics only.

2. Rebuild the existing CPU depth buffer from `nearestDepth`.
   - Expected result should match current `renderSplatDepth` closely.
   - Replay must prove no regression before changing query behavior.

3. Replace `sampleSplatSurfacePoints` internals with layer-class filtering.
   - Keep output shape exactly the same.
   - Compare `front_surface_centers` counts and Boxer payload stats.

4. Add `layered_visibility_cluster` as an extra candidate source in
   `buildClientClickObb`.
   - Do not remove existing `splat_cluster`, `depth_component`, or `knn_cluster`.
   - Select it only through normal non-oracle scoring.

5. Add brush raster mask support for `client_brush`.
   - Preserve current stroke/bbox prompt format.
   - Add optional mask field or local mask reconstruction for layered queries.

6. Add cached 3-view fusion.
   - Current view, slight left orbit, slight right orbit.
   - Query selected splat IDs across cached views.
   - Compare against current group fusion artifacts.

7. Expand to 6-12 cached views only if 3-view fusion shows real lift.
   - Stop if warm query or cold precompute exceeds the budget without quality
     movement.

## Acceptance Gates

MVP is successful if:

- Target-leak gate still passes.
- CPU-depth compatibility replay is within noise of current baseline.
- `layered_visibility_cluster` wins at least one case without lowering average
  AABB IoU.
- Warm query remains under `1s` in-app for the four replay cases.

Full depth-index lane is successful if:

- Average AABB IoU crosses `0.6` with single current-view layered queries, or
  the lane should pivot harder to multi-view.
- Cached multi-view query approaches `0.8` average AABB IoU under `5s` cold or
  under `1s` warm.
- Failures are explainable through debug metrics: sparse layers, background
  bridge, weak prompt mask, insufficient cached views, or class-prior miss.

## Non-Goals

- Do not use saved target boxes or target projected boxes at runtime.
- Do not make browser GPU readback the default depth source.
- Do not replace Boxer/SAM integration; this index should provide better local
  geometry evidence that those systems can consume.
- Do not tune only thresholds until the layered/multi-view evidence is present.

