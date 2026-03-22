/**
 * Tile Coordinate Utilities
 * 
 * Shared module for tile coordinate calculations used by both:
 * - Runtime (src/library.ts, src/main.ts)
 * - Build scripts (scripts/fetch-tiles.ts, scripts/tile-utils.ts)
 * 
 * This module eliminates duplication and ensures coordinate calculations
 * are consistent across build-time tile fetching and runtime tile loading.
 * 
 * @module tile-coords
 */

// ============================================================================
// Types
// ============================================================================

/** Basic tile coordinates (for runtime use at max zoom) */
export interface SimpleTileCoords {
    tileX: number;
    tileZ: number;
}

/** Extended tile coordinates with zoom info (for build scripts) */
export interface ZoomedTileCoords extends SimpleTileCoords {
    blocksPerTile: number;
}

/** 3D coordinates */
export interface Coordinates {
    x: number;
    y: number;
    z: number;
}

// ============================================================================
// Tile Coordinate Calculations
// ============================================================================

/**
 * Calculate tile coordinates from Minecraft world coordinates at maximum zoom.
 * At max zoom (zoom 8), each tile covers exactly tileSize blocks (512).
 * 
 * @param x - Minecraft X coordinate
 * @param z - Minecraft Z coordinate
 * @param tileSize - Size of tiles in blocks (default 512)
 * @returns Tile coordinates { tileX, tileZ }
 * 
 * @example
 * getTileCoords(600, -100) // { tileX: 1, tileZ: -1 }
 * getTileCoords(0, 0) // { tileX: 0, tileZ: 0 }
 * getTileCoords(511, 511) // { tileX: 0, tileZ: 0 }
 * getTileCoords(512, 512) // { tileX: 1, tileZ: 1 }
 */
export function getTileCoords(x: number, z: number, tileSize = 512): Readonly<SimpleTileCoords> {
    return {
        tileX: Math.floor(x / tileSize),
        tileZ: Math.floor(z / tileSize)
    };
}

/**
 * Calculate tile coordinates at a specific zoom level.
 * At maxZoom, 1 pixel = 1 block, so tile covers tileSize blocks.
 * At lower zooms, each tile covers more area: blocksPerTile = tileSize × 2^(maxZoom - zoom)
 * 
 * @param x - Minecraft X coordinate
 * @param z - Minecraft Z coordinate
 * @param zoom - Current zoom level
 * @param maxZoom - Maximum zoom level (typically 8)
 * @param tileSize - Base tile size in pixels/blocks (typically 512)
 * @returns Tile coordinates with blocksPerTile
 * 
 * @example
 * // Zoom 8 (max): 512 blocks per tile
 * getTileCoordsAtZoom(600, -100, 8, 8, 512) // { tileX: 1, tileZ: -1, blocksPerTile: 512 }
 * 
 * // Zoom 4: 8192 blocks per tile (512 × 2^4)
 * getTileCoordsAtZoom(600, -100, 4, 8, 512) // { tileX: 0, tileZ: -1, blocksPerTile: 8192 }
 */
export function getTileCoordsAtZoom(
    x: number,
    z: number,
    zoom: number,
    maxZoom: number,
    tileSize: number
): Readonly<ZoomedTileCoords> {
    const blocksPerTile = tileSize * Math.pow(2, maxZoom - zoom);
    
    return {
        tileX: Math.floor(x / blocksPerTile),
        tileZ: Math.floor(z / blocksPerTile),
        blocksPerTile
    };
}

/**
 * Calculate blocks per tile at a given zoom level.
 * 
 * @param zoom - Zoom level
 * @param maxZoom - Maximum zoom level (typically 8)
 * @param tileSize - Base tile size (typically 512)
 * @returns Number of Minecraft blocks covered by one tile at this zoom
 * 
 * @example
 * getBlocksPerTile(8, 8, 512) // 512 (1:1 at max zoom)
 * getBlocksPerTile(4, 8, 512) // 8192 (16× larger)
 * getBlocksPerTile(0, 8, 512) // 131072 (256× larger)
 */
export function getBlocksPerTile(zoom: number, maxZoom: number, tileSize: number): number {
    return tileSize * Math.pow(2, maxZoom - zoom);
}

// ============================================================================
// Location Parsing
// ============================================================================

/**
 * Parse a shop location string into coordinates.
 * Handles edge cases like null, undefined, empty strings, and partial coordinates.
 * 
 * @param location - Comma-separated coordinate string "x, y, z"
 * @returns Coordinates object with x, y, z (defaults to 0 for missing values)
 * 
 * @example
 * parseLocation('100, 64, -200') // { x: 100, y: 64, z: -200 }
 * parseLocation('100.5, 64.2, -200.8') // { x: 100.5, y: 64.2, z: -200.8 }
 * parseLocation(null) // { x: 0, y: 0, z: 0 }
 * parseLocation('') // { x: 0, y: 0, z: 0 }
 */
export function parseLocation(location: string | null | undefined): Readonly<Coordinates> {
    if (!location || typeof location !== 'string') {
        return { x: 0, y: 0, z: 0 };
    }
    const coords = location.split(', ');
    return {
        x: Number.parseFloat(coords[0] ?? '0') || 0,
        y: Number.parseFloat(coords[1] ?? '0') || 0,
        z: Number.parseFloat(coords[2] ?? '0') || 0
    };
}

// ============================================================================
// Tile Boundary Calculations
// ============================================================================

/**
 * Calculate the world coordinate boundaries of a tile.
 * 
 * @param tileX - Tile X coordinate
 * @param tileZ - Tile Z coordinate
 * @param blocksPerTile - Blocks covered by this tile (512 for zoom 8, 8192 for zoom 4)
 * @returns Tile boundaries { west, east, north, south }
 * 
 * @example
 * getTileBounds(0, 0, 512) // { west: 0, east: 512, north: 0, south: 512 }
 * getTileBounds(1, -1, 512) // { west: 512, east: 1024, north: -512, south: 0 }
 */
export function getTileBounds(
    tileX: number,
    tileZ: number,
    blocksPerTile: number
): Readonly<{ west: number; east: number; north: number; south: number }> {
    return {
        west: tileX * blocksPerTile,
        east: (tileX + 1) * blocksPerTile,
        north: tileZ * blocksPerTile,
        south: (tileZ + 1) * blocksPerTile
    };
}

/**
 * Check if a world coordinate falls within a tile.
 * 
 * @param x - Minecraft X coordinate
 * @param z - Minecraft Z coordinate
 * @param tileX - Tile X coordinate
 * @param tileZ - Tile Z coordinate
 * @param blocksPerTile - Blocks per tile
 * @returns true if (x, z) is within the tile
 */
export function isCoordInTile(
    x: number,
    z: number,
    tileX: number,
    tileZ: number,
    blocksPerTile: number
): boolean {
    const bounds = getTileBounds(tileX, tileZ, blocksPerTile);
    return x >= bounds.west && x < bounds.east && z >= bounds.north && z < bounds.south;
}

/**
 * Get all tile coordinates in a 5×5 grid around a center tile.
 * Used for pre-fetching tiles around shop locations.
 * 
 * @param centerTileX - Center tile X
 * @param centerTileZ - Center tile Z
 * @returns Array of 25 tile coordinates
 */
export function getTileNeighborhood(
    centerTileX: number,
    centerTileZ: number
): readonly SimpleTileCoords[] {
    const tiles: SimpleTileCoords[] = [];
    for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
            tiles.push({
                tileX: centerTileX + dx,
                tileZ: centerTileZ + dz
            });
        }
    }
    return tiles;
}
