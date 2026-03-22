# ADR-012: BlueMap Tile Migration

## Status

Proposed

## Context

The PVC server exposes two map renderers:

- **Dynmap** at `https://web.peacefulvanilla.club/maps/` — currently used
- **BlueMap** at `https://web.peacefulvanilla.club/earth/maps/world/` — available, with heightmap data

BlueMap tiles contain embedded heightmap metadata that could enable dynamic lighting effects. This ADR documents the differences between the two systems and proposes a migration path.

## Dynmap vs BlueMap Tile System Comparison

### Current Dynmap System

| Property | Value |
|---|---|
| **Base URL** | `https://web.peacefulvanilla.club/maps/tiles/minecraft_overworld/{zoom}/{x}_{z}.png` |
| **Tile size** | 512×512 px (= 512 blocks at max zoom 8) |
| **Image content** | Pure top-down color map |
| **Zoom levels** | 1–8 (at zoom 8: 1px = 1 block; at zoom 4: 1px = 16 blocks) |
| **World IDs** | `minecraft_overworld`, `minecraft_the_nether`, `minecraft_the_end` |
| **Tile (0,0)** | Covers blocks (0,0) → (511,511) |

### BlueMap System (from settings.json & source)

| Property | Value |
|---|---|
| **Base URL** | `https://web.peacefulvanilla.club/earth/maps/world/tiles/{lod}/x{X}/z{Z}.png` |
| **Tile size** | 500×500 blocks (from `lowres.tileSize: [500, 500]`) |
| **Image content** | **Dual-layer PNG**: top half = color, bottom half = heightmap/light metadata |
| **Image dimensions** | 501×1002 px (501 wide = tileSize+1; 1002 tall = 2×501) |
| **LOD levels** | 3 with factor 5 (`lodCount: 3`, `lodFactor: 5`) |
| **World names** | `world` (not `minecraft_overworld`) |
| **Tile (0,0)** | Covers blocks (0,0) → (499,499) |

### BlueMap LOD Breakdown

| LOD | Scale | Blocks per tile | 1 pixel = N blocks |
|---|---|---|---|
| 1 | 5⁰ = 1 | 500 | 1 block |
| 2 | 5¹ = 5 | 2,500 | 5 blocks |
| 3 | 5² = 25 | 12,500 | 25 blocks |

### BlueMap URL Path Encoding (`pathFromCoords`)

Coordinates are encoded digit-by-digit into directory nesting:

```
Tile ( 0,  0) → x0/z0.png
Tile ( 5, -3) → x5/z-3.png
Tile (12, -7) → x1/2/z-7.png     (digits split into folders)
Tile (123, 45) → x1/2/3/z4/5.png
```

### BlueMap PNG Internal Format

From the GLSL shaders in [LowresFragmentShader.js](https://github.com/BlueMap-Minecraft/BlueMap/blob/master/common/webapp/src/js/map/lowres/LowresFragmentShader.js):

```
┌──────────────────────┐  ← row 0
│                      │
│    Color Map (RGBA)  │  501 × 501 pixels
│    (top-down view)   │  UV: pos.x / textureWidth, pos.y / textureHeight
│                      │
├──────────────────────┤  ← row 501 (y / textureHeight + 0.5)
│                      │
│    Metadata (RGBA)   │  501 × 501 pixels
│    R = block light   │  light = R × 255 (0–15 range)
│    G = height high   │  height = G×256 + B (signed at 32768)
│    B = height low    │
│                      │
└──────────────────────┘  ← row 1001
```

Height decoding (from the shader):

```glsl
float heightUnsigned = meta.g * 65280.0 + meta.b * 255.0;
// If >= 32768 → negative: -(65535 - heightUnsigned)
// Otherwise → positive: heightUnsigned
```

## Migration Approach

### Key Differences to Bridge

1. **Tile size**: 512 → 500 blocks (all coordinate math changes)
2. **Image format**: Pure color → split color+heightmap (need to crop/extract)
3. **URL pattern**: `{x}_{z}.png` → `x{X}/z{Z}.png` with digit nesting
4. **World IDs**: `minecraft_overworld` → `world`
5. **Extra pixel**: BlueMap tiles are 501px wide (tileSize+1 for vertex interpolation)

### Proposed Strategy: Adapter Layer

Rather than rewriting all tile code, introduce a **tile provider abstraction** that keeps the Leaflet consumption identical:

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ Leaflet Map │ ←── │ Tile Provider    │ ←── │ Dynmap Provider │ (current)
│ (unchanged) │     │ Interface        │     │ BlueMap Provider │ (new)
└─────────────┘     └──────────────────┘     └─────────────────┘
```

### Phase 1: Abstraction (no behavior change)

Extract a `TileProvider` interface from current code in `src/map/tile-loader.ts`:

- `getTileUrl(world, zoom, x, z): string`
- `getWorldId(world): string`
- `tileSize: number`
- `getBlocksPerTile(zoom): number`
- `extractColorImage(blob): Promise<Blob>` (identity for Dynmap)
- `extractHeightmap(blob): Promise<ImageData | undefined>` (undefined for Dynmap)

Wire existing code through the Dynmap provider — zero functional change.

### Phase 2: BlueMap Provider

Implement `BlueMapTileProvider`:

- `tileSize` = 500
- `getTileUrl` generates `x{X}/z{Z}.png` paths using the digit-nesting logic
- `extractColorImage` crops the top half (501×501) of the PNG and scales/clips to the 500×500 region for Leaflet overlays
- `extractHeightmap` extracts the bottom half for later use
- Update `config.json` to select provider:

```json
{ "tileProvider": "bluemap", "bluemap": { "baseUrl": "...", "mapId": "world" } }
```

### Phase 3: Heightmap for Dynamic Lighting

- Store extracted heightmaps alongside the color tiles in the blob cache
- Compute per-pixel shade using the same algorithm as BlueMap's fragment shader:

```
shade = clamp((height - heightRight + height - heightBelow) × 0.06, -0.2, 0.04)
```

- Apply as a CSS filter or a canvas post-process on the Leaflet image overlays
- Sun angle could be configurable or time-of-day based

### Phase 4: Build Script Update

- Update `fetch-tiles.ts` to fetch from BlueMap URLs
- Adapt manifest to BlueMap coordinate grid (500-block tiles)
- Store both the cropped color tile and the raw heightmap data

### Coordinate Conversion Reference

```typescript
// Dynmap: block → tile
dynmapTileX = Math.floor(blockX / 512)

// BlueMap: block → tile
bluemapTileX = Math.floor(blockX / 500)

// Same block can map to different tile indices:
// Block 510: Dynmap tile 0, BlueMap tile 1
```

## Risk Mitigation

- Keep Dynmap provider as fallback (feature flag in config)
- The `manifest.json` format doesn't change — just different tile coordinates
- All existing BDD tests continue to work against the Dynmap provider
- BlueMap provider gets its own unit tests for URL generation and image extraction

## Decision

Pending — exploring feasibility before committing.

## References

- [BlueMap GitHub](https://github.com/BlueMap-Minecraft/BlueMap)
- [BlueMap External Webserver Docs](https://bluemap.bluecolored.de/wiki/webserver/ExternalWebserversFile.html)
- [BlueMap LowresVertexShader.js](https://github.com/BlueMap-Minecraft/BlueMap/blob/master/common/webapp/src/js/map/lowres/LowresVertexShader.js)
- [BlueMap LowresFragmentShader.js](https://github.com/BlueMap-Minecraft/BlueMap/blob/master/common/webapp/src/js/map/lowres/LowresFragmentShader.js)
- [BlueMap LowresTileLoader.js](https://github.com/BlueMap-Minecraft/BlueMap/blob/master/common/webapp/src/js/map/LowresTileLoader.js)
- [ADR-009: Tile Caching Strategy](009-tile-caching-strategy.md)
- [ADR-010: Tile Loading Minimization](010-tile-loading-minimization.md)
