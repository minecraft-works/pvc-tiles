import { describe, expect, it } from 'vitest';

import { getTileCoordsAtZoom, parseLocation } from '../src/tile-coords';
import {
    calculateRateLimitDelay,
    createDynmapUrlBuilder,
    getNormalizedWorld,
    getTileFilename,
    getTilePath,
    getTileUrl,
    getUniqueTiles,
    getWorldId} from './tile-utils';

describe('getTileCoords', () => {
    const tileSize = 512;
    const maxZoom = 8;
    
    it('calculates tile at origin', () => {
        const result = getTileCoordsAtZoom(0, 0, 8, maxZoom, tileSize);
        expect(result).toEqual({ tileX: 0, tileZ: 0, blocksPerTile: 512 });
    });
    
    it('calculates tile for positive coordinates', () => {
        // At zoom 8, each tile is 512 blocks
        // 600 / 512 = 1.17, floor = 1
        const result = getTileCoordsAtZoom(600, 1000, 8, maxZoom, tileSize);
        expect(result.tileX).toBe(1);
        expect(result.tileZ).toBe(1); // 1000 / 512 = 1.95, floor = 1
        expect(result.blocksPerTile).toBe(512);
    });
    
    it('calculates tile for negative coordinates', () => {
        // -100 / 512 = -0.19, floor = -1
        const result = getTileCoordsAtZoom(-100, -600, 8, maxZoom, tileSize);
        expect(result.tileX).toBe(-1);
        expect(result.tileZ).toBe(-2); // -600 / 512 = -1.17, floor = -2
    });
    
    it('handles lower zoom levels with more blocks per tile', () => {
        // At zoom 7 (maxZoom - 1), blocksPerTile = 512 * 2^1 = 1024
        const result = getTileCoordsAtZoom(600, 1000, 7, maxZoom, tileSize);
        expect(result.blocksPerTile).toBe(1024);
        expect(result.tileX).toBe(0); // 600 / 1024 = 0.58, floor = 0
        expect(result.tileZ).toBe(0); // 1000 / 1024 = 0.97, floor = 0
    });
    
    it('handles tile boundary exactly', () => {
        // Exactly at 512 should be tile 1
        const result = getTileCoordsAtZoom(512, 512, 8, maxZoom, tileSize);
        expect(result.tileX).toBe(1);
        expect(result.tileZ).toBe(1);
    });
    
    it('handles tile boundary minus one', () => {
        // Just before 512 should still be tile 0
        const result = getTileCoordsAtZoom(511, 511, 8, maxZoom, tileSize);
        expect(result.tileX).toBe(0);
        expect(result.tileZ).toBe(0);
    });
});

describe('getTileFilename', () => {
    it('formats positive coordinates', () => {
        expect(getTileFilename(1, 2)).toBe('1_2.png');
    });
    
    it('formats negative coordinates', () => {
        expect(getTileFilename(-3, -4)).toBe('-3_-4.png');
    });
    
    it('formats zero', () => {
        expect(getTileFilename(0, 0)).toBe('0_0.png');
    });
    
    it('formats mixed coordinates', () => {
        expect(getTileFilename(-1, 5)).toBe('-1_5.png');
    });
});

describe('getTilePath', () => {
    it('formats pyramid path with positive coordinates', () => {
        expect(getTilePath(8, 1, 2)).toBe('8/1/2.png');
    });
    
    it('formats pyramid path with negative coordinates', () => {
        expect(getTilePath(6, -3, -4)).toBe('6/-3/-4.png');
    });
    
    it('formats pyramid path at zoom 1', () => {
        expect(getTilePath(1, 0, 0)).toBe('1/0/0.png');
    });
    
    it('formats pyramid path with mixed coordinates', () => {
        expect(getTilePath(4, -1, 5)).toBe('4/-1/5.png');
    });
});

describe('getWorldId', () => {
    it('maps "world" to minecraft_overworld', () => {
        expect(getWorldId('world')).toBe('minecraft_overworld');
    });
    
    it('maps "overworld" to minecraft_overworld', () => {
        expect(getWorldId('overworld')).toBe('minecraft_overworld');
    });
    
    it('maps "World" (uppercase) to minecraft_overworld', () => {
        expect(getWorldId('World')).toBe('minecraft_overworld');
    });
    
    it('maps "world_nether" to minecraft_the_nether', () => {
        expect(getWorldId('world_nether')).toBe('minecraft_the_nether');
    });
    
    it('maps "nether" to minecraft_the_nether', () => {
        expect(getWorldId('nether')).toBe('minecraft_the_nether');
    });
    
    it('maps "the_nether" to minecraft_the_nether', () => {
        expect(getWorldId('the_nether')).toBe('minecraft_the_nether');
    });
    
    it('maps "world_the_end" to minecraft_the_end', () => {
        expect(getWorldId('world_the_end')).toBe('minecraft_the_end');
    });
    
    it('maps "end" to minecraft_the_end', () => {
        expect(getWorldId('end')).toBe('minecraft_the_end');
    });
    
    it('maps unknown world to minecraft_ prefix', () => {
        expect(getWorldId('custom_world')).toBe('minecraft_custom_world');
    });
});

describe('getTileUrl', () => {
    const baseUrl = 'https://example.com/maps';
    
    it('builds correct URL for overworld', () => {
        const url = getTileUrl(baseUrl, 'overworld', 8, 1, 2);
        expect(url).toBe('https://example.com/maps/tiles/minecraft_overworld/8/1_2.png');
    });
    
    it('builds correct URL for nether', () => {
        const url = getTileUrl(baseUrl, 'nether', 8, -1, -2);
        expect(url).toBe('https://example.com/maps/tiles/minecraft_the_nether/8/-1_-2.png');
    });
    
    it('builds correct URL for end', () => {
        const url = getTileUrl(baseUrl, 'end', 7, 0, 0);
        expect(url).toBe('https://example.com/maps/tiles/minecraft_the_end/7/0_0.png');
    });
});

describe('parseLocation', () => {
    it('parses comma-separated coordinates', () => {
        expect(parseLocation('100, 64, -200')).toEqual({ x: 100, y: 64, z: -200 });
    });
    
    it('parses float coordinates', () => {
        expect(parseLocation('100.5, 64.2, -200.8')).toEqual({ x: 100.5, y: 64.2, z: -200.8 });
    });
    
    it('handles missing values gracefully', () => {
        expect(parseLocation('')).toEqual({ x: 0, y: 0, z: 0 });
    });
    
    it('handles null gracefully', () => {
        expect(parseLocation(null)).toEqual({ x: 0, y: 0, z: 0 });
    });
    
    it('handles undefined gracefully', () => {
        expect(parseLocation()).toEqual({ x: 0, y: 0, z: 0 });
    });
    
    it('handles partial coordinates', () => {
        expect(parseLocation('100')).toEqual({ x: 100, y: 0, z: 0 });
    });
    
    it('handles invalid values', () => {
        expect(parseLocation('abc, def, ghi')).toEqual({ x: 0, y: 0, z: 0 });
    });
});

describe('getNormalizedWorld', () => {
    it('normalizes "world" to "overworld"', () => {
        expect(getNormalizedWorld('world')).toBe('overworld');
    });
    
    it('normalizes "overworld" to "overworld"', () => {
        expect(getNormalizedWorld('overworld')).toBe('overworld');
    });
    
    it('normalizes "World" (uppercase) to "overworld"', () => {
        expect(getNormalizedWorld('World')).toBe('overworld');
    });
    
    it('normalizes "world_nether" to "the_nether"', () => {
        expect(getNormalizedWorld('world_nether')).toBe('the_nether');
    });
    
    it('normalizes "nether" to "the_nether"', () => {
        expect(getNormalizedWorld('nether')).toBe('the_nether');
    });
    
    it('normalizes "world_the_end" to "the_end"', () => {
        expect(getNormalizedWorld('world_the_end')).toBe('the_end');
    });
    
    it('normalizes "end" to "the_end"', () => {
        expect(getNormalizedWorld('end')).toBe('the_end');
    });
    
    it('returns unknown worlds as-is', () => {
        expect(getNormalizedWorld('custom_world')).toBe('custom_world');
    });
});

describe('getUniqueTiles', () => {
    const baseUrl = 'https://example.com/maps';
    const blocksPerTile = 512;
    const levelId = 8;
    const urlBuilder = createDynmapUrlBuilder(baseUrl, levelId);
    
    it('returns empty array for empty shops', () => {
        const result = getUniqueTiles([], blocksPerTile, levelId, urlBuilder);
        expect(result).toEqual([]);
    });
    
    it('returns 25 tiles (5x5 grid) for single shop', () => {
        const shops = [{ location: '100, 64, 100', world: 'overworld' }];
        const result = getUniqueTiles(shops, blocksPerTile, levelId, urlBuilder);
        expect(result).toHaveLength(25);
    });
    
    it('deduplicates overlapping tiles from nearby shops', () => {
        // Two shops in the same tile should share tiles
        const shops = [
            { location: '100, 64, 100', world: 'overworld' },
            { location: '200, 64, 200', world: 'overworld' }
        ];
        const result = getUniqueTiles(shops, blocksPerTile, levelId, urlBuilder);
        // Both are in tile (0, 0), so we should get 25 tiles, not 50
        expect(result).toHaveLength(25);
    });
    
    it('separates tiles from different worlds', () => {
        const shops = [
            { location: '100, 64, 100', world: 'overworld' },
            { location: '100, 64, 100', world: 'nether' }
        ];
        const result = getUniqueTiles(shops, blocksPerTile, levelId, urlBuilder);
        // 25 tiles for each world
        expect(result).toHaveLength(50);
    });
    
    it('tracks shops only on center tile', () => {
        const shops = [{ location: '100, 64, 100', world: 'overworld' }];
        const result = getUniqueTiles(shops, blocksPerTile, levelId, urlBuilder);
        
        // Center tile should have the shop
        const centerTile = result.find(t => t.tileX === 0 && t.tileZ === 0);
        expect(centerTile?.shops).toHaveLength(1);
        
        // Neighbor tiles should have no shops
        const neighborTile = result.find(t => t.tileX === 1 && t.tileZ === 0);
        expect(neighborTile?.shops).toHaveLength(0);
    });
    
    it('strips minecraft: prefix from world', () => {
        const shops = [{ location: '100, 64, 100', world: 'minecraft:overworld' }];
        const result = getUniqueTiles(shops, blocksPerTile, levelId, urlBuilder);
        expect(result[0].world).toBe('overworld');
    });
    
    it('includes correct URL for each tile', () => {
        const shops = [{ location: '100, 64, 100', world: 'overworld' }];
        const result = getUniqueTiles(shops, blocksPerTile, levelId, urlBuilder);
        const centerTile = result.find(t => t.tileX === 0 && t.tileZ === 0);
        expect(centerTile?.url).toBe('https://example.com/maps/tiles/minecraft_overworld/8/0_0.png');
    });
    
    it('stores levelId on each tile', () => {
        const shops = [{ location: '100, 64, 100', world: 'overworld' }];
        const result = getUniqueTiles(shops, blocksPerTile, levelId, urlBuilder);
        for (const tile of result) {
            expect(tile.levelId).toBe(8);
        }
    });
});

describe('calculateRateLimitDelay', () => {
    const config = {
        batchSize: 10,
        delayBetweenTiles: 500,
        delayBetweenBatches: 2000
    };
    
    it('returns no delay for cached tiles', () => {
        const state = { fetchedInBatch: 0 };
        const result = calculateRateLimitDelay(
            { success: true, cached: true },
            state,
            config,
            true
        );
        expect(result.delay).toBe(0);
        expect(result.batchComplete).toBe(false);
        expect(state.fetchedInBatch).toBe(0); // Should not increment
    });
    
    it('returns tile delay for successful fetch', () => {
        const state = { fetchedInBatch: 0 };
        const result = calculateRateLimitDelay(
            { success: true, cached: false },
            state,
            config,
            true
        );
        expect(result.delay).toBe(500);
        expect(result.batchComplete).toBe(false);
        expect(state.fetchedInBatch).toBe(1);
    });
    
    it('returns batch delay when batch is complete', () => {
        const state = { fetchedInBatch: 9 };
        const result = calculateRateLimitDelay(
            { success: true, cached: false },
            state,
            config,
            true
        );
        expect(result.delay).toBe(2000);
        expect(result.batchComplete).toBe(true);
        expect(state.fetchedInBatch).toBe(0); // Reset after batch
    });
    
    it('counts failed fetches towards batch limit', () => {
        const state = { fetchedInBatch: 9 };
        const result = calculateRateLimitDelay(
            { success: false, cached: false },
            state,
            config,
            true
        );
        expect(result.delay).toBe(2000);
        expect(result.batchComplete).toBe(true);
        expect(state.fetchedInBatch).toBe(0);
    });
    
    it('returns no delay on last tile', () => {
        const state = { fetchedInBatch: 0 };
        const result = calculateRateLimitDelay(
            { success: true, cached: false },
            state,
            config,
            false // No more tiles
        );
        expect(result.delay).toBe(0);
        expect(state.fetchedInBatch).toBe(1);
    });
    
    it('processes multiple tiles correctly', () => {
        const state = { fetchedInBatch: 0 };
        
        // Simulate 5 cached tiles - no delays
        for (let i = 0; i < 5; i++) {
            const result = calculateRateLimitDelay(
                { success: true, cached: true },
                state,
                config,
                true
            );
            expect(result.delay).toBe(0);
        }
        expect(state.fetchedInBatch).toBe(0);
        
        // Simulate 10 actual fetches
        for (let i = 0; i < 10; i++) {
            const result = calculateRateLimitDelay(
                { success: true, cached: false },
                state,
                config,
                true
            );
            if (i < 9) {
                expect(result.delay).toBe(500);
                expect(result.batchComplete).toBe(false);
            } else {
                expect(result.delay).toBe(2000);
                expect(result.batchComplete).toBe(true);
            }
        }
        expect(state.fetchedInBatch).toBe(0); // Reset after batch complete
    });
});
