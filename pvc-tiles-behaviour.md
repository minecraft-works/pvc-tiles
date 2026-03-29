# Tile Pipeline Behaviour

## Downsampling Strategy for Coarser Zoom Levels

All data types are propagated to every zoom level. The pipeline processes
each coarser level by reading the tiles from the level above and producing
color, meta, and emitter sidecars.

### Color — 2×2 average (box filter via Lanczos3)

Each coarser pixel covers `scaleFactor × scaleFactor` finer pixels. The color
mosaic is composited from child tiles and Lanczos3-resized to the canonical
tile size — effectively a high-quality box filter. The viewer's bridge shader
uses `floor()` (nearest-neighbor) to read from the atlas, so the source data
just needs to be a correct downsampled representation.

Border pixels are re-derived from neighboring tiles at the same coarser zoom
level, identical to zoom=0.

### Height & Blocklight (Meta) — max per cell

The meta PNG (R=blocklight, G=height-hi, B=height-lo) is downsampled using
**max-per-cell**: for each `scaleFactor × scaleFactor` block of source meta
pixels, the output pixel receives:

- **R** = max(blocklight) — preserves emitting pixels for clustering and
  prevents bilinear interpolation from underestimating light near sources.
- **G,B** = encoded max(height) — preserves shadow-casting peaks, slope
  magnitude, AO local maxima, and glow LOS terrain.

Why max, not average:

- **Shadows** depend on the tallest feature. A mountain peak averaged with a
  valley floor becomes a hill that casts no shadow.
- **Slope shading** uses height differences between adjacent pixels. Max
  preserves the magnitude of height transitions.
- **AO** checks local height variation. Max ensures tall structures still
  read as local maxima at coarser scales.
- **Glow LOS** ray-marches use height. Max ensures terrain doesn't
  "disappear" and let light leak through ridgelines.

The viewer decodes meta identically regardless of zoom level.

### Emitters — re-cluster from downsampled meta (Approach A)

The same union-find clustering algorithm runs on the downsampled meta PNG.
Since the meta was downsampled with max-blocklight, emitting pixels are
preserved. The algorithm produces emitters in source pixel space of the
coarser tile — exactly what the viewer expects.

**Height tolerance relaxation**: at coarser zoom levels, the "same-height"
merge condition is relaxed to "height within N blocks", where N equals the
number of coarsening steps from the detail level. This compensates for the
max-height downsample shifting heights by up to 1 block per level.

Why this works well:

- At zoom=-1, each source pixel = `scaleFactor` blocks. Adjacent emitters
  that were separate at zoom=0 become neighbors and naturally merge.
- The height-equality merge constraint still works (with tolerance).
- Emitter count drops roughly `scaleFactor²×` per zoom level.
- Output format (`_emitters.bin` with `[x, z, strength, height]`) is
  identical, so the viewer needs zero changes.

---

## Emitter Clustering Algorithm

### Purpose
Reduce thousands of individual lit pixels into a smaller set of representative light sources. Adjacent pixels at the same height that both emit light are merged into a single emitter.

### Input
The **meta** image (RGBA), where per-pixel:
- **R** = blocklight (0–15 as a byte 0–255, so `R / 15` gives 0.0–1.0)
- **G** = height high byte
- **B** = height low byte
- Height = `G * 256 + B` (unsigned 16-bit), then if ≥ 32768 → `-(65535 - value)` (signed)

### Step 1: Identify emitting pixels
Only pixels with `blocklight ≥ 0.5` (i.e. R ≥ 8) are emitters. All others are ignored.

### Step 2: Union-Find clustering
Scan pixels left-to-right, top-to-bottom. For each emitting pixel, initialize it as its own cluster, then try to merge with up to **4 already-visited neighbors**:

```
  [NW] [N] [NE]
  [W]  [*]
```

- **Left** (x−1, z)
- **Up-Left** (x−1, z−1)
- **Up** (x, z−1)
- **Up-Right** (x+1, z−1)

A merge only happens if the neighbor:
1. Is also an emitter (has been initialized, i.e. `parent[neighbor] ≥ 0`)
2. Has height within `heightTolerance` blocks of the current pixel (0 at zoom=0, increases at coarser zooms)

This uses standard **union-find with path compression**: `find()` walks to root and compresses the path; `union()` merges two roots.

### Step 3: Aggregate clusters
After scanning, iterate all emitting pixels again. For each, find its cluster root and accumulate:
- `sumX += x * blocklight` (brightness-weighted X position)
- `sumZ += z * blocklight` (brightness-weighted Z position)
- `sumS += blocklight` (total brightness)
- `minH = min(height)` across the cluster
- `count++`

### Step 4: Emit one record per cluster
For each cluster, output:
```
x        = round(sumX / sumS)          // brightness-weighted centroid X
z        = round(sumZ / sumS)          // brightness-weighted centroid Z
strength = sumS / count                // average blocklight (0.0–1.0)
height   = minH + 1                    // +1 block offset (light source is above ground)
```

All coordinates are in **source pixel space** (0 to tileWidth+2×border−1).

### Output format
**Float32 array**, 4 floats per emitter: `[x, z, strength, height]`, written as raw little-endian binary (`.bin`).

### Effect
For a 288×288 tile, this typically reduces ~39,000 lit pixels → ~5,000–10,000 clustered emitters, which is critical both for GPU performance (fewer instanced draw calls) and for staying within WebGL's `MAX_TEXTURE_SIZE` limit.
