/**
 * Tile utility functions for build-time tile fetching.
 * Extracted from fetch-tiles.js for testability.
 * 
 * Core coordinate calculations are now in src/tile-coords.ts (shared with runtime).
 * URL generation and world ID mapping delegated to TileProvider at runtime,
 * but build scripts use the TileUrlBuilder abstraction.
 */

// Import shared coordinate utilities
import {
    type Coordinates,
    getTileCoordsAtZoom,
    parseLocation as sharedParseLocation,
    type ZoomedTileCoords} from '../src/tile-coords.js';

// Re-export types from shared module

// Re-export TileCoords as an alias to ZoomedTileCoords for backward compatibility
export type TileCoords = ZoomedTileCoords;

/**
 * Function that builds a tile URL for a given world and tile coordinates.
 * 
 * Abstracts away the URL pattern so both Dynmap and BlueMap
 * (or any future provider) can be used by build scripts.
 */
export type TileUrlBuilder = (world: string, tileX: number, tileZ: number) => string;

export interface ShopInput {
    location: string;
    world: string;
}

export interface ShopLocation {
    x: number;
    z: number;
    location: string;
}

export interface TileInfo {
    world: string;
    tileX: number;
    tileZ: number;
    blocksPerTile: number;
    /** Provider-specific level identifier (e.g., zoom 8 for Dynmap, LOD 1 for BlueMap) */
    levelId: number;
    url: string;
    shops: ShopLocation[];
}

export interface FetchResult {
    success: boolean;
    cached: boolean;
}

export interface RateLimitState {
    fetchedInBatch: number;
}

export interface RateLimitConfig {
    batchSize: number;
    delayBetweenTiles: number;
    delayBetweenBatches: number;
}

export interface RateLimitResult {
    delay: number;
    batchComplete: boolean;
}

/**
 * Calculate tile coordinates from Minecraft world coordinates.
 * At maxZoom, 1 pixel = 1 block, so tile covers tileSize blocks.
 * At lower zooms, each tile covers more area: blocksPerTile = tileSize * 2^(maxZoom - zoom)
 * 
 * @param x - Block X coordinate.
 * @param z - Block Z coordinate.
 * @param zoom - Zoom level.
 * @param maxZoom - Maximum zoom level.
 * @param tileSize - Base tile size in blocks.
 * @returns Tile coordinates and blocks-per-tile at the given zoom.
 * @deprecated Use getTileCoordsAtZoom from '../src/tile-coords.js' directly
 */
export function getTileCoords(
    x: number,
    z: number,
    zoom: number,
    maxZoom: number,
    tileSize: number
): TileCoords {
    return getTileCoordsAtZoom(x, z, zoom, maxZoom, tileSize);
}

/**
 * Get tile filename from coordinates (legacy flat format).
 *
 * @param tileX - Tile X coordinate.
 * @param tileZ - Tile Z coordinate.
 * @returns Filename in format "{x}_{z}.png".
 */
export function getTileFilename(tileX: number, tileZ: number): string {
    return `${tileX}_${tileZ}.png`;
}

/**
 * Get tile path in pyramid structure: {z}/{x}/{y}.png
 *
 * @param zoom - Zoom level.
 * @param tileX - Tile X coordinate.
 * @param tileZ - Tile Z coordinate.
 * @returns Path string in format "{zoom}/{x}/{z}.png".
 */
export function getTilePath(zoom: number, tileX: number, tileZ: number): string {
    return `${zoom}/${tileX}/${tileZ}.png`;
}

/**
 * Get tile URL for a world.
 *
 * @param baseUrl - Base URL of the tile server.
 * @param world - World name (e.g. 'overworld', 'nether').
 * @param zoom - Zoom level.
 * @param tileX - Tile X coordinate.
 * @param tileZ - Tile Z coordinate.
 * @returns Full tile URL.
 */
export function getTileUrl(
    baseUrl: string,
    world: string,
    zoom: number,
    tileX: number,
    tileZ: number
): string {
    const worldId = getWorldId(world);
    return `${baseUrl}/tiles/${worldId}/${zoom}/${tileX}_${tileZ}.png`;
}

/**
 * Create a TileUrlBuilder for Dynmap at a specific zoom level.
 * Wraps getTileUrl into the provider-agnostic interface.
 *
 * @param baseUrl - Base URL of the Dynmap server.
 * @param zoom - Zoom level to build URLs for.
 * @returns A TileUrlBuilder function.
 */
export function createDynmapUrlBuilder(baseUrl: string, zoom: number): TileUrlBuilder {
    return (world: string, tileX: number, tileZ: number) =>
        getTileUrl(baseUrl, world, zoom, tileX, tileZ);
}

/**
 * Convert world name to dynmap world ID.
 *
 * @param world - World name (e.g. 'overworld', 'world_nether').
 * @returns Dynmap world identifier (e.g. 'minecraft_overworld').
 */
export function getWorldId(world: string): string {
    const worldLower = world.toLowerCase();
    if (worldLower === 'world' || worldLower === 'overworld') {
        return 'minecraft_overworld';
    }
    if (worldLower === 'world_nether' || worldLower.includes('nether')) {
        return 'minecraft_the_nether';
    }
    if (worldLower === 'world_the_end' || worldLower.includes('end')) {
        return 'minecraft_the_end';
    }
    return `minecraft_${world}`;
}

/**
 * Parse shop location string to coordinates.
 * 
 * @param location - Comma-separated coordinate string (e.g. '100, 64, -200').
 * @returns Parsed coordinates with x, y, z fields.
 * @deprecated Use parseLocation from '../src/tile-coords.js' directly
 */
export function parseLocation(location: string | null | undefined): Coordinates {
    return sharedParseLocation(location);
}

/**
 * Get normalized world name for output directory.
 *
 * @param world - Raw world name.
 * @returns Normalized world name ('overworld', 'the_nether', 'the_end', or original).
 */
export function getNormalizedWorld(world: string): string {
    const worldLower = world.toLowerCase();
    if (worldLower === 'world' || worldLower === 'overworld') {
        return 'overworld';
    }
    if (worldLower === 'world_nether' || worldLower.includes('nether')) {
        return 'the_nether';
    }
    if (worldLower === 'world_the_end' || worldLower.includes('end')) {
        return 'the_end';
    }
    return world;
}

/**
 * Get unique tiles needed for all shops (including 5x5 neighbors).
 * 
 * @param shops - Array of shop data with location and world.
 * @param blocksPerTile - Number of blocks covered by each tile at this level.
 * @param levelId - Provider-specific level identifier (e.g., zoom 8, LOD 1).
 * @param urlBuilder - Function to generate tile URLs for the active provider.
 * @returns Array of unique tile entries across all shops.
 */
export function getUniqueTiles(
    shops: ShopInput[],
    blocksPerTile: number,
    levelId: number,
    urlBuilder: TileUrlBuilder
): TileInfo[] {
    const tilesMap = new Map<string, TileInfo>();
    
    for (const shop of shops) {
        addShopTiles(tilesMap, shop, blocksPerTile, levelId, urlBuilder);
    }
    
    return [...tilesMap.values()];
}

/**
 * Add tiles for a single shop to the tile map (5x5 grid around center).
 *
 * @param tilesMap - Accumulating map of tile key to tile info.
 * @param shop - Shop with location and world.
 * @param blocksPerTile - Number of blocks per tile at this level.
 * @param levelId - Provider-specific level identifier.
 * @param urlBuilder - Function to generate tile URLs.
 */
function addShopTiles(
    tilesMap: Map<string, TileInfo>,
    shop: ShopInput,
    blocksPerTile: number,
    levelId: number,
    urlBuilder: TileUrlBuilder
): void {
    const { x, z } = sharedParseLocation(shop.location);
    const world = shop.world.replace('minecraft:', '');
    const tileX = Math.floor(x / blocksPerTile);
    const tileZ = Math.floor(z / blocksPerTile);
    
    // Add the center tile and all 24 neighbors (5x5 grid)
    for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
            const tx = tileX + dx;
            const tz = tileZ + dz;
            const key = `${world}/${levelId}/${tx}_${tz}`;
            
            if (!tilesMap.has(key)) {
                tilesMap.set(key, {
                    world,
                    blocksPerTile,
                    levelId,
                    tileX: tx,
                    tileZ: tz,
                    url: urlBuilder(world, tx, tz),
                    shops: []
                });
            }
            
            // Only track shops on the center tile
            if (dx === 0 && dz === 0) {
                const entry = tilesMap.get(key);
                entry?.shops.push({ x, z, location: shop.location });
            }
        }
    }
}

/**
 * Get all tiles in a specific range for base map coverage.
 * 
 * @param minTileX - Minimum tile X coordinate.
 * @param maxTileX - Maximum tile X coordinate.
 * @param minTileZ - Minimum tile Z coordinate.
 * @param maxTileZ - Maximum tile Z coordinate.
 * @param blocksPerTile - Number of blocks covered by each tile at this level.
 * @param levelId - Provider-specific level identifier (e.g., zoom 4, LOD 3).
 * @param urlBuilder - Function to generate tile URLs for the active provider.
 * @param world - World name (default: 'overworld').
 * @returns Array of tile entries covering the specified range.
 */
export function getBaseMapTiles(
    minTileX: number,
    maxTileX: number,
    minTileZ: number,
    maxTileZ: number,
    blocksPerTile: number,
    levelId: number,
    urlBuilder: TileUrlBuilder,
    world = 'overworld'
): TileInfo[] {
    const tiles: TileInfo[] = [];
    
    for (let tx = minTileX; tx <= maxTileX; tx++) {
        for (let tz = minTileZ; tz <= maxTileZ; tz++) {
            tiles.push({
                world,
                blocksPerTile,
                levelId,
                tileX: tx,
                tileZ: tz,
                url: urlBuilder(world, tx, tz),
                shops: []
            });
        }
    }
    
    return tiles;
}

/**
 * Process fetch results and determine if rate limiting delay is needed.
 * Returns the delay in ms (0 for no delay).
 *
 * @param result - The fetch result to evaluate.
 * @param state - Mutable rate limit state tracking batch progress.
 * @param config - Rate limiting configuration.
 * @param hasMoreTiles - Whether more tiles remain to fetch.
 * @returns Delay in ms and whether batch is complete.
 */
export function calculateRateLimitDelay(
    result: FetchResult,
    state: RateLimitState,
    config: RateLimitConfig,
    hasMoreTiles: boolean
): RateLimitResult {
    // Cached tiles don't need rate limiting
    if (result.success && result.cached) {
        return { delay: 0, batchComplete: false };
    }
    
    // Increment fetch count for actual fetches and failed attempts
    state.fetchedInBatch++;
    
    // Check if batch is complete
    if (state.fetchedInBatch >= config.batchSize) {
        state.fetchedInBatch = 0;
        return { delay: config.delayBetweenBatches, batchComplete: true };
    }
    
    // Regular delay between tiles (only if more tiles remain)
    if (hasMoreTiles) {
        return { delay: config.delayBetweenTiles, batchComplete: false };
    }
    
    return { delay: 0, batchComplete: false };
}

export {type Coordinates} from '../src/tile-coords.js';