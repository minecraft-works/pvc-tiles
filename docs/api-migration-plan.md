# API Migration Plan: Current → pvc-tiles-api.md

## What pvc-tiles does

Download map tile images from BlueMap or Dynmap (configurable), crop them to an ROI, and serve them as a static tile pyramid in multiple zoom levels with pixel overlap — per `pvc-tiles-api.md`.

**Keep:** provider-based fetching, ROI filtering (`renderBounds`), GitHub Actions tile caching, pyramid downsampling.  
**Remove:** all build-time lighting/shading (slope, shadows, AO, glow, material modifiers, unsharp mask). Color tiles pass through as-downloaded.  
**Add:** tile borders (overlap), `_meta.png` + `_emitters.bin` sidecars (raw height/blocklight data from dual-layer sources, no processing), new manifest format.

---

## 1. Delete all lighting code

| File | Action |
|---|---|
| `scripts/heightmap-shader.ts` | **Gut** — keep only `isDualLayerTile()`, `decodeHeightmap()`, `decodeBlockLight()`, `extractSubRegionRgba()`, `extractSubHeights()`. Delete everything else. |
| `scripts/_render-single-tile.ts` | **Delete** |
| `scripts/_glow-worker.mjs` | **Delete** |
| `scripts/extract-material-colors.ts` | **Delete** |
| `scripts/material-colors.gen.ts` | **Delete** |
| `src/types.ts` | Remove entire `lighting` sub-schema from `TilePyramidConfigSchema`. Remove `shadingScale`, `tileWidth`, `tileHeight`. |
| `config.json` | Remove `lighting` block from bluemap preset. Remove `tileWidth`, `tileHeight`, `shadingScale`. |
| `scripts/render-tiles.ts` | Remove all shading imports and logic. Dual-layer path becomes: split into color half + metadata half, crop, write color PNG at source resolution, write `_meta.png` sidecar, write `_emitters.bin` sidecar. |
| `docs/adr/014-*`, `015-*`, `016-*` | Mark superseded or delete |

---

## 2. Manifest format

**Current:** flat JSON array with `{ world, tileX, tileZ, blocksPerTile }`.  
**Target:** object `{ tileSize, border, tiles: [{ world, zoom, x, z, hasHeight }] }`.

| Field | Source |
|---|---|
| `tileSize` | `baseBlocksPerTile` (= pixels at 1 block/pixel) |
| `border` | New config field |
| `tiles[].zoom` | `0` for detail, `-(detailLevel - level)` for coarser |
| `tiles[].x`, `tiles[].z` | Renamed from `tileX`, `tileZ` |
| `tiles[].hasHeight` | `true` if source was dual-layer (BlueMap), `false` otherwise |

---

## 3. Zoom convention

| Current | Target |
|---|---|
| Level 0 = overview (coarsest) | Zoom 0 = finest detail |
| Level N-1 = detail (finest) | Negative zoom = coarser |

Directory names go from `0/, 1/, 2/, 3/, 4/` to `0/, -1/, -2/, -3/, -4/`.

Add `levelToZoom()` / `zoomToLevel()` helpers in `tile-pyramid.ts`.

---

## 4. Tile borders

Each tile PNG has dimensions `(tileSize + 2×border)²`. The extra `border` pixels on each edge overlap with neighboring tiles.

- Extend crop regions by `border` pixels per side when splitting source tiles
- Requires neighbor-aware stitching (source tiles may not cover the border region alone)
- Cascade (downsampled) tiles also need borders
- Add `border` to config schema
- `_meta.png` has the same dimensions (including border)

**Hardest part of the migration.**

---

## 5. Sidecar files (`_meta.png`, `_emitters.bin`)

Only for dual-layer (BlueMap) sources — pass through raw height/blocklight data, no processing.

- `_meta.png`: re-encode the RGBA metadata half at the same crop region + border as the color tile
- `_emitters.bin`: scan blocklight channel for pixels above threshold, write as `Float32[x, z, strength, height]`
- Decode functions already exist in `heightmap-shader.ts` — keep those

---

## 6. Format — PNG only

Lock output to RGBA PNG. Drop the `format` config option.

---

## Implementation order

| Step | What | Complexity |
|---|---|---|
| 1 | Delete lighting code + simplify config | Low |
| 2 | Manifest restructure + zoom convention + field renames | Low |
| 3 | Write color tiles at source-native resolution (1 bpp) | Low |
| 4 | `_meta.png` + `_emitters.bin` sidecar output | Moderate |
| 5 | Tile borders (neighbor-aware crop + cascade) | **High** |
| 6 | Update validate script | Low |
| 7 | Update consumer (pvc-trades) | Moderate |
