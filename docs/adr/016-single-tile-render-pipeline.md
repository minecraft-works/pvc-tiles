# ADR-016: Single-Tile Render Pipeline

## Status

Accepted — implemented in `scripts/_render-single-tile.ts`.
Produces three output tiles plus three diagnostic images from any BlueMap
dual-layer source PNG.

## Context

The full `render-tiles.ts` pipeline is designed for batch rendering of all
source tiles during CI deployment. During development and visual QA, we
frequently need to test shading changes on a single tile without running the
full pipeline (tile discovery → split → manifest rebuild).

ADR-015 documented the shading formula and enhancement effects but did not
prescribe a standalone workflow for processing individual tiles. Manual
iteration required either:

1. Placing the tile into `public/tiles-src/` under the correct directory
   structure and running the full renderer, or
2. Writing throwaway scripts that duplicated logic from `heightmap-shader.ts`.

Both approaches were slow and error-prone.

## Decision

Provide a standalone single-tile renderer (`scripts/_render-single-tile.ts`)
that accepts any BlueMap dual-layer PNG as input and runs the full shading
pipeline, producing clearly labelled output variants for comparison.

### Input Format

A BlueMap dual-layer PNG tile (501×1002 pixels):

```
┌──────────────────────┐
│   Color half          │  501×501 — raw block color (RGBA)
│   (top 501 rows)      │  No lighting applied server-side
├──────────────────────┤
│   Metadata half       │  501×501 — encoded per-pixel metadata
│   (bottom 501 rows)   │  R = blockLight/15×255, G = heightHi, B = heightLo
└──────────────────────┘
```

Height decoding: `height = G×256 + B` (unsigned 16-bit; values ≥ 32768 are
negative via two's-complement wrapping).

### Pipeline

```
INPUT: BlueMap dual-layer PNG (501×1002)
  │
  ├─ Split top/bottom halves
  │   ├─ colorBuffer  (501×501 RGBA)
  │   └─ heightBuffer (501×501 RGBA → decode)
  │
  ├─ Decode metadata
  │   ├─ heights     = decodeHeightmap(heightBuffer)     → Float32Array
  │   └─ blockLights = decodeBlockLight(heightBuffer)    → Float32Array (0–1)
  │
  ├─ Upscale 501→1002 (shadingScale = 2)
  │   ├─ color:      sharp nearest-neighbour
  │   ├─ heights:    upsampleNearest   (preserves block edges)
  │   └─ blockLights: upsampleBilinear (smooth spread)
  │
  ├─ OUTPUT 1: Slope shading only
  │   ├─ applySlopeShading(color, heights)
  │   └─ Trim to 1000×1000 → _slope-only.png
  │
  ├─ OUTPUT 2: Full pipeline
  │   ├─ applySlopeShading(color, heights)        [additive]
  │   ├─ computeHardShadowMap(heights)            [5-ray NW penumbra]
  │   ├─ computeNeighborAO(heights)               [8-neighbour count]
  │   ├─ Apply shadow × AO                        [multiplicative]
  │   ├─ computeBlockLightGlow(blockLights)       [radial emitters]
  │   ├─ Apply glow                               [additive, warm tint]
  │   └─ Trim to 1000×1000 → _full.png
  │
  ├─ OUTPUT 3: Height-aware light emission
  │   ├─ applySlopeShading(color, heights)        [additive]
  │   ├─ applyCoolShadowTint(color, shadow, AO)   [blue-shifted darken]
  │   ├─ computeHeightAwareLightGlowParallel(…)   [clustered + LOS]
  │   │   ├─ clusterEmitters (union-find, main thread)
  │   │   ├─ Distribute chunks → N worker threads
  │   │   ├─ Each worker: spreadEmitters with LOS
  │   │   └─ Sum accumulated buffers, tonemap
  │   ├─ Apply glow                               [additive, warm tint]
  │   ├─ boostSaturation(1.3)                     [Rec.709 luminance]
  │   └─ Trim to 1000×1000 → _height-lit.png
  │
  └─ DIAGNOSTICS
      ├─ _color-raw.png           (unshaded top-half, baseline)
      ├─ _heightmap.png           (quantized grayscale, min–max)
      ├─ _blocklight.png          (block-light channel 0–1 → 0–255)
      └─ _glow-height-aware.png   (glow intensity mask)
```

### Shading Steps Detail

#### Step 1 — Additive Slope Shading (BlueMap formula)

```
shade = clamp((h − hRight + h − hBelow) × 0.06, −0.2, +0.04)
rgb += shade × 255
```

- Flat block tops: `shade = 0` → no change
- Downhill east/south edge: `shade < 0` → darkened (max −51 per channel)
- Uphill east/south edge: `shade > 0` → brightened (max +10 per channel)
- Strong asymmetry is intentional (crisp shadows, subtle highlights)

#### Step 2 — Soft Cast Shadows

`computeHardShadowMap(heights, w, h, maxDistance=32, slopeThreshold=2.5,
shadowStrength=0.55, sunSpread=0.2, numRays=5)`

- 5 rays from NW diagonal, spread ±20% for penumbra
- Blocked count / total rays → partial shadow fraction
- Output: `1.0` (lit) to `0.55` (full umbra)

#### Step 3 — Neighbour Ambient Occlusion

`computeNeighborAO(heights, w, h, strength=0.35)`

- Counts 8 immediate neighbours strictly higher than current pixel
- More raised neighbours → recessed → darker
- Output: `1.0` (open) to `0.65` (all 8 neighbours higher)

#### Step 4 — Multiplicative Darkening

```
factor = shadow[i] × ao[i]
rgb[i] = round(rgb[i] × factor)
```

Shadow and AO combine multiplicatively before glow is added.

#### Step 5 — Block-Light Glow (only in full pipeline)

`computeBlockLightGlow(blockLights, w, h, strength=0.004, maxRadius=20,
falloff=0.15, emitThreshold=0.15)`

- Every pixel with blockLight ≥ 0.15 becomes a radial emitter
- Inverse-square falloff: `contribution = emitterStrength / (1 + 0.15 × r²)`
- Exponential tonemapping: `v = 1 − exp(−accumulated × 0.004)`
- Warm tint: R × 1.00, G × 0.85, B × 0.70
- Applied additively to the shadow/AO-darkened image

#### Step 5b — Height-Aware Glow (height-lit pipeline)

`computeHeightAwareLightGlowParallel(blockLights, heights, w, h,
strength=0.03, maxRadius=48, falloff=0.008, emitThreshold=0.5,
lightSourceOffset=2)`

Height-aware glow replaces the simple radial glow with terrain-occluded
light emission. Emitters are clustered via union-find and distributed
across worker threads for parallel computation.

##### Emitter Clustering

1. **Label emitters**: every pixel with `blockLight ≥ emitThreshold` is
   labelled. 8-connected neighbours at the **exact same height** share
   a label (union-find).
2. **Build centroids**: each cluster gets a single representative emitter
   with averaged (x, z) position, summed strength, and **minimum height**
   (`minH + lightSourceOffset`). Using `minH` prevents light leaking over
   walls where a cluster straddles different elevations.
3. Typical result: 173k emitter pixels → ~10k clusters at 2× resolution.

##### Terrain Occlusion

For each emitter→pixel pair within `maxRadius`:

1. **Height gate**: if `targetHeight > emitterHeight`, skip immediately
   (light cannot reach higher ground). This rejects ~60% of candidates.
2. **Skip-LOS for close pixels**: if `distance² < 16` (within ~4 px),
   assume line-of-sight (terrain rarely occludes at this range).
3. **Stride-2 Bresenham ray march**: check every other pixel along the
   ray. If any terrain sample exceeds the interpolated ray height, the
   path is blocked. Stride-2 halves ray marching cost with negligible
   visual impact.

##### Parallel Worker Threads

`computeHeightAwareLightGlowParallel` uses Node.js `worker_threads` to
distribute the emitter spread across multiple CPU cores:

1. **Main thread** clusters emitters (fast O(n) union-find).
2. Heights are shared via `SharedArrayBuffer` (zero-copy read).
3. Emitter array is split into `min(cpuCount, 8)` chunks.
4. Each worker (`_glow-worker.mjs`) receives its chunk of emitters plus
   the shared height buffer, spreads light with full LOS checks, and
   posts back its `Float32Array` accumulation buffer (transferred,
   zero-copy).
5. Main thread sums all partial buffers, applies exponential tonemapping,
   and produces the warm-tinted RGB output.

Performance on a 16-core machine (1002×1002, ~10k clusters):
- Single-threaded: ~3.2 s
- 8 workers: ~0.9 s (3.4× speedup)

##### Tonemapping & Tint

Same as Step 5: `v = 1 − exp(−accumulated × strength)`, warm tint
R × 1.00, G × 0.85, B × 0.70.

#### Step 6 — Cool Shadow Tint (height-lit pipeline only)

`applyCoolShadowTint(color, shadow, ao, w, h)`

Replaces the plain multiplicative shadow × AO darkening with a
blue-shifted tint. Dark areas receive a subtle cool hue that contrasts
with the warm glow, improving visual depth.

#### Step 7 — Saturation Boost (height-lit pipeline only)

`boostSaturation(color, w, h, factor=1.3)`

Shadow darkening and glow addition desaturate colors. A 1.3× saturation
boost using Rec.709 luminance-preserving math restores vibrancy.

### Trim Step

The source is 501×501 per half (BlueMap adds 1 extra row and column for
seamless LOD blending). After upscaling 2× the buffer is 1002×1002. The
final `sharp.extract(1000, 1000)` trims the 2-pixel seamless border.

### Usage

```bash
npx tsx scripts/_render-single-tile.ts <input.png> [outputDir]
```

- `input.png` — path to any BlueMap dual-layer 501×1002 PNG
- `outputDir` — defaults to the directory containing the input file

### Output Files

| Suffix | Content |
|--------|---------|
| `_slope-only.png` | BlueMap-exact slope shading, no enhancements |
| `_full.png` | Slope + shadow + AO + block-light glow |
| `_height-lit.png` | Slope + cool shadows + height-aware glow + saturation boost |
| `_glow-height-aware.png` | Glow intensity diagnostic (shows reach vs. occlusion) |
| `_color-raw.png` | Unshaded raw block color (comparison baseline) |
| `_heightmap.png` | Grayscale height (quantized min–max → 0–255) |
| `_blocklight.png` | Block-light channel visualization |

## Consequences

### Positive

- **Fast iteration** — process one tile in ~2 seconds without full pipeline
  overhead (tile discovery, manifest, directory scanning).
- **Visual QA** — side-by-side comparison of raw, slope-only, and full output
  makes it easy to evaluate shading parameter changes.
- **Diagnostic visibility** — heightmap and block-light channel images expose
  data quality issues (e.g., missing block-light, flat heightmaps) before they
  propagate through the full render.
- **Reuses production code** — all shading functions are imported from
  `heightmap-shader.ts`, so the standalone script always matches the batch
  pipeline's output.

### Negative

- **Underscore prefix** — the `_` prefix marks it as a development tool not
  included in CI or production workflows. It could drift if `heightmap-shader.ts`
  changes its API signature.
- **Hardcoded defaults** — enhancement parameters (shadow strength, AO strength,
  glow falloff) are the same defaults as `computeHardShadowMap` etc. If
  `config.json` overrides are added later, this script won't pick them up unless
  modified to read configuration.

## Related

- [ADR-012](012-bluemap-tile-migration.md) — BlueMap tile format and dual-layer PNG layout
- [ADR-015](015-bluemap-slope-shading.md) — BlueMap-exact slope shading formula and enhancements
- `scripts/_render-single-tile.ts` — Implementation
- `scripts/_glow-worker.mjs` — Worker thread for parallel emitter spread (plain JS for Node.js compatibility)
- `scripts/heightmap-shader.ts` — All shading functions
- `scripts/render-tiles.ts` — Full batch pipeline
