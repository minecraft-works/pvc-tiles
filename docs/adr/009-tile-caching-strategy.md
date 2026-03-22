# ADR-009: Map Tile Caching Strategy

## Status
**Updated** — 2026 (originally implemented 2025; see revision note below)

## Context

The application displays interactive maps using Dynmap tile images. Each map view requires multiple tile requests:

| Zoom Level | Tiles per View | Total at Zoom |
|------------|----------------|---------------|
| 0 (world) | 1 | 1 |
| 3 | 4-9 | 64 |
| 5 | 16-25 | 1,024 |
| 6 (max) | 25-36 | 4,096 |

### Problems with Direct Tile Loading

1. **Network dependency**: Each pan/zoom fetches tiles from server
2. **CORS issues**: Dynmap may not allow cross-origin requests
3. **Latency**: Tile loading creates visible "grey squares"
4. **Bandwidth**: Repeated visits re-download same tiles
5. **Offline**: No functionality without network

## Decision

Pre-fetch all tiles at build time and serve from local `/tiles/` directory with **manifest-based loading** and **direct URL tile display** backed by the browser's HTTP cache.

```
Build time:                        Runtime:
┌─────────────┐                   ┌──────────────────────┐
│   Dynmap    │ ───fetch-tiles─► │ /tiles/manifest.json  │
│   Server    │ ─render-tiles─► │ /tiles/{l}/{x}/{z}.jpg│
└─────────────┘                   └──────────────────────┘
                                            │
                                     TileLoader
                                            │
                                   ┌───────────┐
                                   │  Browser  │
                                   │HTTP cache │
                                   └───────────┘
```

## Rationale

### Why Pre-fetch Instead of Proxy?

| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| **Pre-fetch** | Fast, offline, no CORS | Stale data, storage size | ✅ Selected |
| Runtime proxy | Always fresh | Server needed, latency | Rejected |
| Service Worker | Cache + fresh | Complexity, SW lifecycle | Rejected |
| CDN cache | Fast, fresh | Cost, configuration | Rejected |

**Key factors**:
- Map tiles for a Minecraft server change infrequently (days/weeks)
- Static hosting is simple and cheap
- Offline/LAN usage is valuable for Minecraft servers
- ~50MB tile storage is acceptable

### Why Direct URL Instead of Blob Cache?

The original implementation pre-fetched each tile via `fetch()`, waited for `response.blob()`, created an object URL, and passed that to `L.imageOverlay()`. This was replaced with passing the tile URL directly:

```typescript
// Before: fetch → blob() → createObjectURL → imageOverlay(blobUrl)
// After:  imageOverlay(url)  — browser HTTP cache handles the rest
L.imageOverlay(url, bounds, options).addTo(map);
```

| Property | Blob cache (old) | Direct URL + HTTP cache (new) |
|----------|:---:|:---:|
| Survives page reload | ❌ (lost on unload) | ✅ (browser cache) |
| Memory pressure | grows with tile count | managed by browser |
| First-visit speed | fetch + blob + objectURL round-trip | fetch only |
| Subsequent visits | instant (in-memory) | instant (disk cache / 304) |
| Deduplication within session | `addedToMap` Set | `addedToMap` Set (unchanged) |

The blob cache was solving a problem (re-download on re-open) that the browser's HTTP cache already solves — and solves it better because it persists across reloads.

### Why Progressive JPEG?

Tiles are served as progressive JPEG (`quality: 92, mozjpeg: true`) instead of PNG. Benefits:

- ~40–55% smaller files than equivalent PNG (Minecraft's flat-color surfaces are JPEG-friendly)
- Progressive encoding means the first scan (low-quality full image) arrives quickly; the browser refines it as more bytes arrive
- Once a tile is in the HTTP cache, it loads from disk and appears instantly regardless of encoding

**Note on Leaflet's imageOverlay behaviour**: `L.imageOverlay` hides the image (`opacity: 0`) until its `load` event fires, then fades it in. This means progressive scans are not visible during the initial download on a cold cache. However:
1. The overall tile appears sooner because JPEG files are smaller (download completes faster)
2. On a warm HTTP cache, tiles appear instantly from the start — the effective "streaming" experience

### Manifest-Based Loading

The manifest lists available tiles:

```json
{
    "tiles": [
        "0/0/0.png",
        "1/0/0.png",
        "1/0/1.png"
    ],
    "generated": "2025-01-15T10:00:00Z"
}
```

Benefits:
- Know which tiles exist before requesting
- Avoid 404 errors for missing tiles
- Can show placeholder for unavailable tiles
- Track freshness via `generated` timestamp

### Why Not Service Worker?

Service Workers add complexity:
- Registration/update lifecycle
- Scope restrictions
- Debug difficulty
- Cache invalidation strategy

The tile set is small enough to hold in memory and simple enough that a service worker is overkill.

## Implementation

### Build-Time Scripts

| Script | Purpose |
|--------|---------|
| `scripts/fetch-tiles.ts` | Download tiles from Dynmap |
| `scripts/tile-utils.ts` | Coordinate conversion, URL building |

### Runtime Components

| Component | Purpose |
|-----------|---------|
| `TileLoader` class | Manages tile fetching and blob caching |
| `TileManifest` interface | Typed manifest structure |
| Leaflet tile layer | Displays tiles on map |

### Cache Lifecycle

1. **Init**: Load manifest, determine which tiles exist
2. **Request**: Check `addedToMap` Set; if not yet added, call `L.imageOverlay(url, bounds)` directly
3. **Display**: Browser makes the HTTP request; result cached by browser HTTP cache
4. **Subsequent opens**: Browser serves tile from HTTP cache (disk) — no network round-trip if unchanged

### Fallback Behavior

```typescript
async getTile(z: number, x: number, y: number): Promise<string> {
    const key = `${z}/${x}/${y}`;
    
    if (!this.manifest.has(key)) {
        return PLACEHOLDER_TILE; // Grey tile
    }
    
    if (this.cache.has(key)) {
        return this.cache.get(key)!;
    }
    
    return this.fetchAndCache(key);
}
```

## Consequences

### Positive

- Near-instant tile display on second and subsequent visits (HTTP disk cache)
- Works offline/LAN after first visit (service worker not required)
- No CORS issues (tiles served from same origin)
- Predictable performance
- No memory accumulation from blob URLs
- Simpler code: `loadTileToMap` is a single `L.imageOverlay(url)` call

### Negative

- Tiles can become stale
- Must re-run fetch-tiles + render-tiles to update
- Storage space for tiles (~30–40 MB with JPEG vs ~50 MB PNG)
- First-visit download still required; tiles not visible until `load` event fires

### Mitigations

- Include `generated` date in manifest, show in UI
- Document refresh procedure
- Progressive JPEG reduces file sizes by 40–55% vs PNG
- GitHub Pages serves tiles with `ETag` + `Last-Modified`; subsequent visits use conditional GET (304) with no body — near-instant even after HTTP cache expiry

## Revision Note (2026)

Original implementation used in-memory blob URL caching (`fetch → blob() → createObjectURL → imageOverlay`). Replaced with direct URL passing (`imageOverlay(url)`) backed by the browser HTTP cache. Tile format changed from PNG to progressive JPEG for ~40–55% smaller files. Blob cache functions (`getCachedTileUrl`, `setCachedTileUrl`, `_getBlobCacheSize`) removed from `tile-loader.ts`.
