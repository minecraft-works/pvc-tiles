# ADR-010: Minimizing External Tile Requests

## Status
**Implemented** - 2026

## Context

The application displays Dynmap tiles from an external server (`web.peacefulvanilla.club`). This server:
- Is not under our control
- May have rate limiting or anti-DDoS measures (Cloudflare)
- Provides tiles for the entire Minecraft world (thousands of tiles)

We need map tiles for navigation, but must minimize requests to respect the server.

### Constraints

1. **Don't spam external servers** - the Dynmap is a community resource
2. **Only fetch tiles we actually need** - around shops, not entire world
3. **Cache aggressively** - avoid re-fetching unchanged tiles
4. **Validate before deploy** - catch fetch failures early

## Decision

Implement a **multi-layer caching strategy** with **shop-centric tile collection**:

```
                    GitHub Actions Cache
                           │
                           ▼
┌──────────────┐     ┌─────────────────────┐     ┌─────────────────┐
│   Dynmap     │────►│  fetch-tiles.ts     │────►│ public/tiles/   │
│   Server     │     │  (rate-limited)     │     │ + manifest.json │
└──────────────┘     └─────────────────────┘     └─────────────────┘
       ▲                     │                          │
       │              Skip if cached                    ▼
       │                     │                   ┌─────────────────┐
       └─────── Only new ────┘                   │  tile-loader.ts │
                 tiles                           │  (blob cache)   │
                                                 └─────────────────┘
```

### Shop-Centric Collection

Instead of fetching the entire world:

```typescript
// For each shop, fetch a 5×5 grid of tiles at zoom 8
const GRID_RADIUS = 2; // 2 tiles in each direction = 5×5 grid
for (const shop of shops) {
    const centerTile = getTileCoords(shop.x, shop.z);
    for (let dx = -GRID_RADIUS; dx <= GRID_RADIUS; dx++) {
        for (let dz = -GRID_RADIUS; dz <= GRID_RADIUS; dz++) {
            tiles.add(`${centerTile.x + dx}/${centerTile.z + dz}`);
        }
    }
}
```

This yields ~25 tiles per unique shop location instead of thousands.

### GitHub Actions Cache Layer

```yaml
- name: Cache map tiles
  uses: actions/cache@v4
  with:
    path: public/tiles
    key: map-tiles-v6-${{ hashFiles('config.json') }}
    restore-keys: |
      map-tiles-v6-
```

Tiles persist across deployments:
- Cache hit → skip fetching cached tiles
- Cache miss → fresh Dynmap fetch
- Static key → tiles accumulate over time

### Rate Limiting

```typescript
const CONFIG = {
    delayBetweenTiles: 500,   // 500ms between fetches
    batchSize: 10,             // 10 tiles per batch
    delayBetweenBatches: 2000  // 2s pause between batches
};
```

This means ~15-20 tiles/minute, respectful of server resources.

### Manifest Integrity

The manifest is written **after** fetching, only including successful tiles:

```typescript
// Track successful fetches
for (const tile of tiles) {
    const result = await fetchTile(tile);
    if (result.success) {
        successfulTiles.push(tile);
    }
}

// Write manifest with only successful tiles
writeFileSync('manifest.json', JSON.stringify(successfulTiles));
```

This ensures the manifest always reflects reality.

### Validation Step

After fetching, `validate-tiles.ts` checks:

1. **Manifest ↔ file integrity** - every manifest entry has a file
2. **Orphan detection** - zoom-8 files not in manifest
3. **Shop coverage** - each shop has its 5×5 tile neighborhood

```bash
npm run validate-tiles
# Exit 1 if integrity errors (blocks deploy)
# Exit 0 with warnings if shop coverage incomplete
```

## Rationale

### Why Shop-Centric, Not World-Wide?

| Approach | Tiles | Time | Storage |
|----------|-------|------|---------|
| **Full world** (zoom 8, ±100 range) | 40,000+ | Hours | 10+ GB |
| **Shop-centric** (5×5 per shop) | ~1,000 | ~10 min | ~50 MB |

Shop-centric is 40× fewer tiles while covering all navigation use cases.

### Why Cache Key is Static?

A config-derived cache key (`map-tiles-v6-${{ hashFiles('config.json') }}`) means:
- Tiles accumulate across deploys
- Old tiles for removed shops remain (harmless)
- No weekly re-fetch of entire tile set

Trade-off: Orphan tiles (~5% overhead) vs. respecting server resources.

### Why Validation in CI?

Catching issues before deploy prevents:
- User seeing grey tiles at shop locations
- Silent fetch failures going unnoticed
- Manifest/file mismatch causing runtime errors

### Single Source of Truth

Coordinate calculations live in `src/tile-coords.ts`:

```typescript
// Used by both:
// - scripts/fetch-tiles.ts (build-time)
// - src/map/tile-loader.ts (runtime)
export function getTileCoords(blockX: number, blockZ: number, tileSize = 512) {
    return {
        x: Math.floor(blockX / tileSize),
        z: Math.floor(blockZ / tileSize)
    };
}
```

This prevents bugs where build-time and runtime calculate different tiles.

## Consequences

### Positive

- **Minimal server load** - only ~1000 tiles fetched total
- **Fast deploys** - cache hit means 0 new fetches
- **Reliable tiles** - manifest reflects actual files
- **Early bug detection** - validation catches issues pre-deploy
- **Consistent logic** - shared module prevents drift

### Negative

- **Stale tiles** - only update on deploy
- **New shop gap** - shops added after deploy have no tiles until next deploy
- **Cache growth** - orphan tiles accumulate (acceptable ~5%)

### Mitigations

- Regular deploys keep tiles fresh (~daily)
- Validation warns about shops missing coverage
- Future: tile refresh based on shop activity

## Related

- [ADR-009](009-tile-caching-strategy.md) - Runtime blob URL caching
