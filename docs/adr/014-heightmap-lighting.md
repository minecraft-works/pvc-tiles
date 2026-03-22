# ADR-014: Heightmap-Based Lighting

## Status

Superseded — lighting pipeline removed during pvc-tiles API migration.
The render pipeline now outputs raw color + metadata (heightmap, blocklight)
without baked shading. Consumers apply their own shading at runtime.

Previously: Accepted — baked slope shading with three enhancement effects implemented.
Runtime dynamic lighting (Phase 3) considered and dropped.

## Context

BlueMap tiles embed a heightmap in the bottom half of their dual-layer 501×1002
PNG (see [ADR-012](012-bluemap-tile-migration.md)). The bottom 501×501 pixels
encode per-pixel metadata in RGBA channels:

```
R = block light level (0–15, normalised to 0–1)
G = height high byte
B = height low byte
A = unused
```

Height decoding (from BlueMap's `LowresFragmentShader.js`):

```
heightUnsigned = G × 256 + B
if heightUnsigned ≥ 32768:
    height = -(65535 - heightUnsigned)    // negative = below sea level
else:
    height = heightUnsigned
```

The build-time renderer (`scripts/render-tiles.ts`) previously discarded the
bottom half entirely, treating all source tiles as flat color images.

## Decision

Apply heightmap-derived lighting to canonical tiles at build time in
`render-tiles.ts`. All shading is baked into the PNG — zero runtime cost.

### Lighting model

After trialling a Lambertian (normal vector) model which produced blobby
dome-like artefacts on blocky terrain, we adopted BlueMap's own slope formula
(see [ADR-015](015-bluemap-slope-shading.md)) as the base layer.

Three additional per-pixel effects are layered on top, all computed at
1000×1000 px (the source is upsampled first):

| Effect | Function | Description |
|--------|----------|-------------|
| Slope shading | `applySlopeShading` | BlueMap-exact base: `shade = clamp((hx−hx+1 + hz−hz+1) × 0.06, −0.2, 0.04)` |
| Soft cast shadows | `computeHardShadowMap` | Ray-march NW diagonal; 5-ray sun-disc spread gives penumbra at shadow edges |
| Neighbour AO | `computeNeighborAO` | Counts strictly-higher 8-neighbours; darkens corners and crevices |
| Block-light glow | `computeBlockLightGlow` | Collects emitter pixels (blockLight ≥ 0.15), spreads circular inverse-square halo |

Compose order:

```
output = slopeShaded × hardShadow × neighborAO + blockLightGlow
```

### Upsampling before shading

Source tiles are 501×501. They are upsampled to 1000×1000 via nearest-neighbour
**before** decoding heights or computing any effect, so ray-march steps and
light falloff operate at half-block precision rather than full-block steps.

### Heightmap tiles

Each canonical tile also emits a quantized 8-bit heightmap stored in the
manifest (`heightmap: { min, max }`). This is consumed by the client for
elevation tooltips and future use.

### Runtime dynamic lighting — dropped

A day/night compositing approach (per-frame sun angle update, canvas
re-shading of visible tiles) was considered but not built. The baked
single-sun-angle output is sufficient for a top-down map viewer where
orientation is fixed. The R-channel block-light data covers the
"lights-on indoors" case adequately without a runtime pipeline.

## Consequences

- Tiles look significantly better than flat color, matching the reference
  BlueMap 3D viewer appearance at equivalent zoom
- Build time increases slightly (~2× per tile, within CI budget)
- All enhancement parameters are tunable via defaults in `heightmap-shader.ts`
- No runtime complexity added

## Related

- [ADR-012](012-bluemap-tile-migration.md) — BlueMap dual-layer PNG format
- [ADR-013](013-canonical-tile-pyramid.md) — Canonical tile pipeline
- [ADR-015](015-bluemap-slope-shading.md) — Why slope beats Lambertian

## References

- [BlueMap LowresFragmentShader.js](https://github.com/BlueMap-Minecraft/BlueMap/blob/master/common/webapp/src/js/map/lowres/LowresFragmentShader.js)
