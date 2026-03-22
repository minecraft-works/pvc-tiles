# pvc-tiles API Specification

## Manifest

`GET /manifest.json`

Fetched once on load. Single JSON object:

```json
{
  "tileSize": 256,
  "border": 32,
  "tiles": [
    { "world": "overworld", "zoom": 0, "x": -1, "z": 0, "hasHeight": true },
    { "world": "overworld", "zoom": -1, "x": 0,  "z": 0, "hasHeight": false }
  ]
}
```

| Field | Type | Description |
|---|---|---|
| `tileSize` | int | Inner content size in pixels. Must be a power of 2 (e.g. 256). |
| `border` | int | Overlap pixels baked into each side of the PNG. Must be a power of 2 (e.g. 32). Actual PNG dimensions = `(tileSize + 2×border)²`. |
| `tiles[].world` | string | World identifier. |
| `tiles[].zoom` | int | Zoom level. 0 = finest detail, negative = coarser. |
| `tiles[].x` | int | Tile X coordinate. |
| `tiles[].z` | int | Tile Z coordinate. |
| `tiles[].hasHeight` | bool | Whether `_meta.png` and `_emitters.bin` exist for this tile. |

---

## Tile Files

### Color — always present

`GET /{world}/{zoom}/{x}/{z}.png`

- Format: RGBA PNG
- Dimensions: `(tileSize + 2×border) × (tileSize + 2×border)`

### Height + Lighting metadata — present if `hasHeight: true`

`GET /{world}/{zoom}/{x}/{z}_meta.png`

- Format: RGBA PNG, same dimensions as color
- Channel encoding:
  - `R` = blocklight, range 0–15 mapped to 0–255
  - `G` = height high byte
  - `B` = height low byte
  - Height value (signed int) = `G×256 + B`, where values ≥ 32768 are negative: `-(65535 - value)`

### Pre-computed emitters — present if `hasHeight: true`

`GET /{world}/{zoom}/{x}/{z}_emitters.bin`

- Format: raw binary, little-endian Float32
- Layout: `[x, z, strength, height]` repeated N times (N × 16 bytes total)
- Coordinates are in source pixel space (0 to `tileSize + 2×border`)

---

## HTTP Requirements

| Requirement | Value |
|---|---|
| CORS | `Access-Control-Allow-Origin: *` on all files |
| Content-Type (PNG) | `image/png` |
| Content-Type (bin) | `application/octet-stream` |
| Caching | `Cache-Control: public, immutable` recommended |
