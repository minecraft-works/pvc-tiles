# ADR-015: BlueMap-Exact Slope Shading

## Status

Superseded — slope shading removed during pvc-tiles API migration.
The render pipeline now outputs raw color + metadata without baked shading.

Previously: Accepted — implemented in `scripts/heightmap-shader.ts` (`applySlopeShading`).
Active via `config.json` (`model: "slope"`, `shadingScale: 2`).
Three enhancement effects were layered on top of the base slope pass:
`computeHardShadowMap` (soft cast shadows with penumbra),
`computeNeighborAO` (8-neighbour ambient occlusion),
and `computeBlockLightGlow` (circular radial block-light glow).
All enhancement shaders ran at the full 1000×1000 resolution after upsampling.

## Context

ADR-014 introduced a Lambertian diffuse lighting model with configurable sun
direction, shadow casting, ambient occlusion, unsharp masking, and material
classification. After several tuning iterations, the output consistently looked
"blobby" or "muddy" compared to the reference BlueMap 3D viewer, even after
fixing the nearest-neighbour upsampling and reducing `normalScale`.

### Root Cause Analysis

Lambertian shading computes a surface **normal** at every pixel and dots it
against a sun direction. On a Minecraft map this means:

- **Every 1-block height step** between adjacent blocks creates a slope face,
  which gets normal tilt → shade gradient → visible "ridge" or "dome" effect.
- Tree canopies (flat leaf planes touching at different Y levels) produce
  dome-like shading because adjacent pixels have opposing normals.
- The effect is inherently smooth by nature of the dot product.

### How BlueMap Actually Works

Investigation of BlueMap's source (`LowresFragmentShader.js`,
`LowresVertexShader.js`, `LowresTile.java`) revealed:

1. **Server-side rendering applies no lighting whatsoever.** `LowresTile.set()`
   writes raw block color (RGBA) and metadata (height + blockLight) directly.
   The PNG color half is an unadulterated top-down block color atlas.

2. **All shading is client-side GLSL**, computed per-fragment on the GPU at
   render time.

3. **The shading formula is a simple slope comparison**, not a normal vector:

   ```glsl
   // Fragment shader — LowresFragmentShader.js
   float height  = metaToHeight(texture(textureImage, posToMetaUV(pos)));
   float heightX = metaToHeight(texture(textureImage, posToMetaUV(pos + vec2(1.0, 0.0))));
   float heightZ = metaToHeight(texture(textureImage, posToMetaUV(pos + vec2(0.0, 1.0))));

   float heightDiff = ((height - heightX) + (height - heightZ)) / lodScale;
   float shade = clamp(heightDiff * 0.06, -0.2, 0.04);

   color.rgb += shade;   // ADDITIVE — not multiplicative
   ```

4. **The shade is additive.** BlueMap adds a signed scalar directly to the RGB
   channels. This has important consequences:
   - `shade` range: `[-0.2, +0.04]` → in 8-bit terms: `[-51, +10]` per channel.
   - Shadows are an **absolute darkening** (–51 on each channel regardless of
     the underlying color). Dark forest floors become near-black; light sand
     cliffs become slightly dark.
   - Highlights are very subtle (+10 max — barely visible on bright surfaces).
   - The strong asymmetry is intentional: it produces crisp shadow lines without
     washing out lit areas.

5. **`lodScale` is 1 for lod=1 tiles** (direct source tiles, one pixel = one
   block). It increases for downsampled LODs. We only use lod=1 source tiles, so
   `lodScale = 1` and the formula simplifies to the raw `heightDiff * 0.06`.

6. **Block light** is stored in the R channel of the metadata half
   (`meta.r * 255.0`). BlueMap blends it with sunlight strength separately:
   ```glsl
   float blockLight = metaToLight(meta);
   float light = mix(blockLight, 15.0, sunlightStrength);
   color.rgb *= mix(ambientLight, 1.0, light / 15.0);
   ```
   This multiplicative light pass follows the additive shade pass. At
   `sunlightStrength = 1.0` and `ambientLight = 0` it reduces to
   `color.rgb *= 1.0` (full light everywhere outdoors). Underground areas with
   `blockLight = 0` get scaled by `ambientLight`.

### Why the Lambertian Model Produced Blobby Results

| Parameter | Lambertian effect | Slope effect |
|-----------|-------------------|--------------|
| 1-block height step | Normal tilts → visible shade gradient | 1-pixel difference → single sharp shade step |
| Flat block tops | Normal points up → full bright | height - hRight = 0 → shade = 0 → neutral |
| Tree canopy top | Normals mix across kernel → dome | Each leaf top is flat → shade = 0, only cliff edges shade |
| Cliff face | Steep normal → very bright edge | height - hRight large → strong shadow below, subtle highlight above |

The Lambertian model is correct for 3D surfaces but over-sensitive for a top-down
block map where every surface is either a flat top (no slope → no shade needed)
or an abrupt 1-block step (needs only a single-pixel shade transition, not a
smooth ramp).

## Decision

Replicate BlueMap's slope shading formula exactly, as a build-time baked pass
(`applySlopeShading` in `scripts/heightmap-shader.ts`).

### Formula

```
shade(x, z) = clamp(
    (h[x,z] - h[x+1,z] + h[x,z] - h[x,z+1]) × 0.06,
    -0.2, +0.04
)

output_rgb[i] = clamp(input_rgb[i] + shade × 255, 0, 255)
```

Constants are taken verbatim from BlueMap's GLSL source, unchanged.

### Config

```jsonc
// config.json — tileSourcePresets.bluemap.lighting
{
  "model": "slope",
  "shadingScale": 2
}
```

The extra effects (shadow, AO, glow) are implemented as unconditional post-passes
inside `render-tiles.ts` for the slope branch, not as config flags. They always
run at `shadingScale: 2` (1000×1000). The legacy Lambertian flags (`shadowCasting`,
`ambientOcclusion`, `unsharpMask`, `materialShading`) remain in config for
`model: "lambertian"` only.

### Enhancement Effects

Three effects are applied in order after `applySlopeShading`:

#### 1. Soft Cast Shadows — `computeHardShadowMap`

Ray marches from each pixel in the sun direction (NW diagonal, `slopeThreshold = 2.5` ≈ 68°
elevation) casting 5 rays spread ±20% around the central angle (sun-disc spread).
Each ray returns blocked/unblocked; `blockedCount / numRays` gives a partial shadow fraction
for penumbra at cliff edges. Applied multiplicatively: `shadow × aoFactor`.

- `shadowStrength = 0.55` — maximum darkening at full occlusion
- `sunSpread = 0.2` — ±20% angular spread across the 5 rays (penumbra width)
- `numRays = 5` — rays sampled across the sun disc
- `maxDistance = 32` — maximum shadow ray length in pixels

#### 2. Neighbour Ambient Occlusion — `computeNeighborAO`

Counts how many of the 8 immediate neighbours are strictly higher than the
current pixel. More raised neighbours → darker pixel (recessed in a hollow).
Combined multiplicatively with the shadow map.

- `strength = 0.35` — AO darkening per raised neighbour

#### 3. Block-Light Glow — `computeBlockLightGlow`

Radial emitter pass. Each pixel whose decoded block-light value exceeds `emitThreshold`
becomes an emitter. Contribution at distance `r` follows inverse-square falloff:
`emitterStrength / (1 + falloff × r²)`. Accumulated contributions are tonemapped
exponentially: `v = 1 − exp(−accumulation × strength)` to prevent blowout from
overlapping emitters. Applied additively after the shadow/AO pass.

- `strength = 0.004` — global intensity scale before tonemapping
- `maxRadius = 20 px` — cutoff radius for the emitter spread
- `falloff = 0.15` — inverse-square coefficient
- `emitThreshold = 0.15` — minimum decoded block-light value to act as emitter
- Tint: `R × 1.00 / G × 0.85 / B × 0.70` — near-white warm light

#### Pipeline Order

```
upsample 501→1000 (nearest-neighbour)
  └─ decode heights + blockLights at 1000×1000
       └─ applySlopeShading
            └─ computeHardShadowMap × computeNeighborAO  (multiplicative)
                 └─ + computeBlockLightGlow              (additive)
```

### Scale and Pixel Geometry

With `shadingScale: 2`:

- **Source 501×501 is upsampled to 1000×1000** (nearest-neighbour) before any
  shader runs. This gives the enhancement effects (shadow rays, AO, glow spread)
  sub-pixel precision within each Minecraft block.
- **Base slope shading** (`applySlopeShading`) runs at 1000×1000. Adjacent height
  differences are still integer per-block jumps, but the enhancement passes benefit
  from the larger canvas: shadow penumbra transitions span multiple pixels, glow
  radii are expressed in sub-block distances.
- The extra resolution over `shadingScale: 1` slightly departs from the BlueMap
  reference (which computes one shade per block), but the base additive formula
  is unchanged. The departure is intentional and limited to the enhancement layers.

At `shadingScale: 1` (original):  each source pixel → exact 2×2 solid-color
square in output; no sub-pixel variation. Still valid for `model: "lambertian"`
or for a zero-enhancement slope render.

### Resize Fix

At `shadingScale: 1` the shaded buffer is 501×501px but the pyramid tile size is
1000×1000px. The previous `sharp.extract(1000, 1000)` from a 501px buffer would
crash. The fix:

```typescript
// If buffer < tileWidth: upscale to first integer multiple ≥ tileWidth, then trim
const scaleX = Math.ceil(pyramid.tileWidth  / shadedW);   // = 2
const scaleY = Math.ceil(pyramid.tileHeight / shadedH);   // = 2
const upW = shadedW * scaleX;  // 501 × 2 = 1002
const upH = shadedH * scaleY;  // 501 × 2 = 1002
pipeline = pipeline.resize(upW, upH, { kernel: 'nearest' });
// 1002 ≠ 1000 → trim seamless border pixel
pipeline = pipeline.extract({ left: 0, top: 0, width: 1000, height: 1000 });
```

The same logic is applied to diagnostic tiles (`writeDiagnosticTile`) and the
heightmap sidecar.

## PNG Encoding

### Color Half (top 501×501 pixels)

Raw block color, premultiplied and averaged from all faces visible from above
(sourced from BlueMap's `BlockRenderPass.java`). No lighting applied server-side.

### Metadata Half (bottom 501×501 pixels)

Each pixel encodes three values packed into RGBA:

| Channel | Value | Range | Encoding |
|---------|-------|-------|----------|
| R | Block light | 0–15 | `blockLight / 15 × 255` |
| G | Height high byte | — | `(height & 0xFF00) >> 8` |
| B | Height low byte | — | `height & 0x00FF` |
| A | Unused | — | `0xFF` (always opaque) |

**Height is stored as a 16-bit unsigned integer**, with values ≥ 32768 treated
as negative (two's-complement wrapping at 16 bits):

```typescript
const unsigned = g * 256 + b;
const height = unsigned >= 32_768 ? -(65_535 - unsigned) : unsigned;
// Range: approximately -32767 to +32767 (Minecraft Y: -64 to 320 in practice)
```

**Seamless edge pixel**: BlueMap adds 1 to each tile dimension (`size = tileSize + 1`), writing one extra row and column at the right/bottom edge. These duplicate the neighbor tile's first row/column for seamless LOD blending in the 3D viewer. Our pipeline trims them via the `extract(1000, 1000)` step.

## Consequences

### Positive

- **Matches BlueMap reference** — same shadow direction, same intensity, same
  crisp appearance on cliff faces and terrain steps.
- **No blobby artifacts** — flat block tops produce zero shade (`h - hRight = 0`),
  tree canopy tops are flat → no dome effect.
- **Simple and fast** — one pass, no radial sampling, no normal estimation,
  no convolution kernels. Runs in `O(W × H)`.
- **Correct asymmetry** — shadows are strong (–51) and highlights are subtle
  (+10), preserving color fidelity in lit areas.
- **No dependency on extra techniques** — the block-light channel can still be
  consumed independently if desired (currently `blockLightBoost: 0`).

### Negative / Trade-offs

- **NW fixed sun** — shadow direction is always NW→SE (checks E and S neighbors).
  There is no way to change sun angle without departing from the BlueMap formula.
- **Baked AO approximation** — `computeNeighborAO` darkens pixels with raised
  neighbours, but it is a single-pixel radius pass, not a view-angle-gated SSAO.
  Deep ravines and cave overhangs are not replicated. This is a deliberate
  simplification acceptable for a top-down static tile.
- **No specular / water shimmer** — BlueMap's client has no specular pass either.
- **2×2 block pixels** — at `shadingScale: 1` the output tile is 500 logical
  blocks at 2 px/block. Leafy terrain looks slightly chunky at close zoom.
  Mitigatable by enabling `shadingScale: 2` (half-block resolution) at the cost
  of departing from the exact BlueMap formula.

## Alternatives Considered

### Keep Lambertian Shading

Rejected for the blobby / dome effect on flat block tops (see root cause analysis
above). Remains available in the codebase as `model: "lambertian"` for scenarios
where smooth terrain gradients are preferred over pixel-accurate block rendering.

### shadingScale: 1 (no upsampling)

The original default. Shade runs at 501×501; each source block becomes a 2×2
solid-color square in output. Shadow and AO cast at block resolution only —
penumbra transitions are 1 pixel wide, glow radii are coarse. Acceptable for
pure slope-reference matching but visually flatter than the current approach.

### Replicate BlueMap's GLSL AO Pass

BlueMap's AO is a screen-space, view-angle gated pass that only activates when
the camera is near top-down and the viewer is close (`lod === 1`, distance <
LOD threshold). For a static baked tile there is no camera, so this pass cannot
be replicated faithfully. A pre-baked radial AO approximation exists in the
codebase (`computeAmbientOcclusion`) but is disabled for slope mode.

## Related

- [ADR-012](012-bluemap-tile-migration.md) — BlueMap tile format and dual-layer PNG layout
- [ADR-013](013-canonical-tile-pyramid.md) — Canonical tile pyramid structure
- [ADR-014](014-heightmap-lighting.md) — Original heightmap lighting plan (Lambertian)
- `scripts/heightmap-shader.ts` — `applySlopeShading()`, `computeSlopeShade()`
- `scripts/render-tiles.ts` — Slope dispatch and resize logic
- `common/webapp/src/js/map/lowres/LowresFragmentShader.js` (BlueMap source) —
  reference GLSL implementation
