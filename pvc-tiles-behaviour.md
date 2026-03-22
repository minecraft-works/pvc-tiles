# Emitter Clustering Algorithm

## Purpose
Reduce thousands of individual lit pixels into a smaller set of representative light sources. Adjacent pixels at the same height that both emit light are merged into a single emitter.

## Input
The **meta** image (RGBA), where per-pixel:
- **R** = blocklight (0–15 as a byte 0–255, so `R / 15` gives 0.0–1.0)
- **G** = height high byte
- **B** = height low byte
- Height = `G * 256 + B` (unsigned 16-bit), then if ≥ 32768 → `-(65535 - value)` (signed)

## Step 1: Identify emitting pixels
Only pixels with `blocklight ≥ 0.5` (i.e. R ≥ 8) are emitters. All others are ignored.

## Step 2: Union-Find clustering
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
2. Has the **same height** value as the current pixel

This uses standard **union-find with path compression**: `find()` walks to root and compresses the path; `union()` merges two roots.

## Step 3: Aggregate clusters
After scanning, iterate all emitting pixels again. For each, find its cluster root and accumulate:
- `sumX += x * blocklight` (brightness-weighted X position)
- `sumZ += z * blocklight` (brightness-weighted Z position)
- `sumS += blocklight` (total brightness)
- `minH = min(height)` across the cluster
- `count++`

## Step 4: Emit one record per cluster
For each cluster, output:
```
x        = round(sumX / sumS)          // brightness-weighted centroid X
z        = round(sumZ / sumS)          // brightness-weighted centroid Z
strength = sumS / count                // average blocklight (0.0–1.0)
height   = minH + 1                    // +1 block offset (light source is above ground)
```

All coordinates are in **source pixel space** (0 to tileWidth+2×border−1).

## Output format
**Float32 array**, 4 floats per emitter: `[x, z, strength, height]`, written as raw little-endian binary (`.bin`).

## Effect
For a 288×288 tile, this typically reduces ~39,000 lit pixels → ~5,000–10,000 clustered emitters, which is critical both for GPU performance (fewer instanced draw calls) and for staying within WebGL's `MAX_TEXTURE_SIZE` limit.
