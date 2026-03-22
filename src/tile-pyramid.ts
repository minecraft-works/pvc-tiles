/**
 * Canonical Tile Pyramid
 *
 * Pure functions for the application's canonical tile system.
 * All coordinate math, URL generation, and level calculations
 * are derived from the pyramid configuration — no provider-specific
 * logic exists here.
 *
 * The pyramid is config-driven:
 * - `tileWidth` / `tileHeight`: pixel dimensions of each tile
 * - `levels`: number of zoom tiers (0 = overview … levels-1 = detail)
 * - `scaleFactor`: block coverage multiplier between adjacent levels
 * - `baseBlocksPerTile`: blocks per tile at the highest detail level
 * - `format`: output tile format (png, webp, avif, …)
 *
 * Level convention (matches Leaflet zoom):
 *   Higher level number = more detail = fewer blocks per tile.
 *
 * @module tile-pyramid
 * @see docs/adr/013-canonical-tile-pyramid.md
 */

import type { TilePyramidConfig } from './types.js';

// ============================================================================
// Types
// ============================================================================

/** Tile coordinates within the canonical pyramid */
export interface CanonicalTileCoords {
    readonly tileX: number;
    readonly tileZ: number;
}

/** Block-coordinate boundaries of a tile */
export interface TileBounds {
    readonly west: number;
    readonly east: number;
    readonly north: number;
    readonly south: number;
}

// ============================================================================
// Default Pyramid Config
// ============================================================================

/**
 * Default pyramid configuration.
 *
 * Produces 3 levels:
 * - Level 2 (detail): 256 blocks/tile
 * - Level 1 (mid):    1 024 blocks/tile
 * - Level 0 (overview): 4 096 blocks/tile
 */
export const DEFAULT_PYRAMID: TilePyramidConfig = {
    tileWidth: 256,
    tileHeight: 256,
    levels: 3,
    scaleFactor: 4,
    baseBlocksPerTile: 256,
    format: 'png'
};

// ============================================================================
// Level Math
// ============================================================================

/**
 * Calculate blocks per tile at a given pyramid level.
 *
 * Formula: `baseBlocksPerTile × scaleFactor ^ (levels - 1 - level)`
 *
 * @param level - Pyramid level (0 = overview, levels-1 = detail)
 * @param pyramid - Pyramid configuration
 * @returns Number of Minecraft blocks covered by one tile at this level
 *
 * @example
 * // Default pyramid (base=256, factor=4, levels=3)
 * blocksPerTile(2, DEFAULT_PYRAMID) // 256  (detail)
 * blocksPerTile(1, DEFAULT_PYRAMID) // 1024 (mid)
 * blocksPerTile(0, DEFAULT_PYRAMID) // 4096 (overview)
 */
export function blocksPerTile(level: number, pyramid: Readonly<TilePyramidConfig>): number {
    const exponent = pyramid.levels - 1 - level;
    return pyramid.baseBlocksPerTile * Math.pow(pyramid.scaleFactor, exponent);
}

/**
 * Get the detail (highest zoom) level number.
 *
 * @param pyramid - Pyramid configuration
 * @returns The detail level index (levels - 1)
 */
export function detailLevel(pyramid: Readonly<TilePyramidConfig>): number {
    return pyramid.levels - 1;
}

/**
 * Get the overview (lowest zoom) level number.
 *
 * @returns Always 0
 */
export function overviewLevel(): number {
    return 0;
}

/**
 * Calculate the ratio of blocks between overview and detail levels.
 *
 * @param pyramid - Pyramid configuration
 * @returns scaleFactor ^ (levels - 1)
 *
 * @example
 * // Default: 4^2 = 16
 * detailToOverviewRatio(DEFAULT_PYRAMID) // 16
 */
export function detailToOverviewRatio(pyramid: Readonly<TilePyramidConfig>): number {
    return Math.pow(pyramid.scaleFactor, pyramid.levels - 1);
}

/**
 * Validate that a level is within range for the pyramid.
 *
 * @param level - Level to check
 * @param pyramid - Pyramid configuration
 * @returns true if 0 ≤ level < levels
 */
export function isValidLevel(level: number, pyramid: Readonly<TilePyramidConfig>): boolean {
    return Number.isInteger(level) && level >= 0 && level < pyramid.levels;
}

// ============================================================================
// Coordinate Calculations
// ============================================================================

/**
 * Calculate canonical tile coordinates from Minecraft block coordinates.
 *
 * @param blockX - Minecraft X coordinate
 * @param blockZ - Minecraft Z coordinate
 * @param level - Pyramid level
 * @param pyramid - Pyramid configuration
 * @returns Tile coordinates at the specified level
 *
 * @example
 * // At detail level (256 blocks/tile):
 * tileFromBlock(600, -100, 2, DEFAULT_PYRAMID) // { tileX: 2, tileZ: -1 }
 *
 * // At overview level (4096 blocks/tile):
 * tileFromBlock(600, -100, 0, DEFAULT_PYRAMID) // { tileX: 0, tileZ: -1 }
 */
export function tileFromBlock(
    blockX: number,
    blockZ: number,
    level: number,
    pyramid: Readonly<TilePyramidConfig>
): Readonly<CanonicalTileCoords> {
    const bpt = blocksPerTile(level, pyramid);
    return {
        tileX: Math.floor(blockX / bpt),
        tileZ: Math.floor(blockZ / bpt)
    };
}

/**
 * Calculate block-coordinate boundaries of a tile.
 *
 * @param tileX - Tile X coordinate
 * @param tileZ - Tile Z coordinate
 * @param level - Pyramid level
 * @param pyramid - Pyramid configuration
 * @returns Tile boundaries { west, east, north, south }
 *
 * @example
 * tileBounds(0, 0, 2, DEFAULT_PYRAMID)
 * // { west: 0, east: 256, north: 0, south: 256 }
 *
 * tileBounds(1, -1, 2, DEFAULT_PYRAMID)
 * // { west: 256, east: 512, north: -256, south: 0 }
 */
export function tileBounds(
    tileX: number,
    tileZ: number,
    level: number,
    pyramid: Readonly<TilePyramidConfig>
): Readonly<TileBounds> {
    const bpt = blocksPerTile(level, pyramid);
    return {
        west: tileX * bpt,
        east: (tileX + 1) * bpt,
        north: tileZ * bpt,
        south: (tileZ + 1) * bpt
    };
}

/** Options for checking if a block falls within a tile */
export interface BlockInTileOptions {
    /** Minecraft X coordinate */
    blockX: number;
    /** Minecraft Z coordinate */
    blockZ: number;
    /** Tile X coordinate */
    tileX: number;
    /** Tile Z coordinate */
    tileZ: number;
    /** Pyramid level */
    level: number;
}

/**
 * Check if a block coordinate falls within a tile.
 *
 * @param options - Block and tile coordinates plus level
 * @param pyramid - Pyramid configuration
 * @returns true if the block is within the tile
 */
export function isBlockInTile(
    options: Readonly<BlockInTileOptions>,
    pyramid: Readonly<TilePyramidConfig>
): boolean {
    const bounds = tileBounds(options.tileX, options.tileZ, options.level, pyramid);
    return options.blockX >= bounds.west && options.blockX < bounds.east
        && options.blockZ >= bounds.north && options.blockZ < bounds.south;
}

/**
 * Convert detail-level tile coordinates to a coarser level.
 *
 * @param detailTileX - Tile X at the detail level
 * @param detailTileZ - Tile Z at the detail level
 * @param fromLevel - Source level (higher = more detail)
 * @param toLevel - Target level (lower = less detail)
 * @param pyramid - Pyramid configuration
 * @returns Tile coordinates at the target level
 *
 * @example
 * // Detail tile (5, 7) at level 2 → which level 0 tile?
 * // ratio = 4^(2-0) = 16
 * coarsenTile(5, 7, 2, 0, DEFAULT_PYRAMID) // { tileX: 0, tileZ: 0 }
 */
export function coarsenTile(
    detailTileX: number,
    detailTileZ: number,
    fromLevel: number,
    toLevel: number,
    pyramid: Readonly<TilePyramidConfig>
): Readonly<CanonicalTileCoords> {
    const fromBpt = blocksPerTile(fromLevel, pyramid);
    const toBpt = blocksPerTile(toLevel, pyramid);
    const ratio = toBpt / fromBpt;
    return {
        tileX: Math.floor(detailTileX / ratio),
        tileZ: Math.floor(detailTileZ / ratio)
    };
}

// ============================================================================
// URL Generation
// ============================================================================

/** Options for canonical tile URL generation */
export interface CanonicalTileUrlOptions {
    /** Normalized world name ('overworld', 'the_nether') */
    world: string;
    /** Pyramid level */
    level: number;
    /** Tile X coordinate */
    tileX: number;
    /** Tile Z coordinate */
    tileZ: number;
    /** Base URL for tiles (default: 'tiles') */
    baseUrl?: string;
}

/**
 * Generate canonical tile URL.
 *
 * Pattern: `{baseUrl}/{world}/{level}/{tileX}/{tileZ}.{format}`
 *
 * @param options - World, level, coordinates, and optional base URL
 * @param pyramid - Pyramid configuration
 * @returns Canonical tile URL
 *
 * @example
 * canonicalTileUrl({ world: 'overworld', level: 2, tileX: 3, tileZ: -2 }, DEFAULT_PYRAMID)
 * // 'tiles/overworld/2/3/-2.png'
 */
export function canonicalTileUrl(
    options: Readonly<CanonicalTileUrlOptions>,
    pyramid: Readonly<TilePyramidConfig>
): string {
    const base = options.baseUrl ?? 'tiles';
    return `${base}/${options.world}/${String(options.level)}/${String(options.tileX)}/${String(options.tileZ)}.${pyramid.format}`;
}

// ============================================================================
// Tile Grid Enumeration
// ============================================================================

/**
 * Get all tile coordinates in a grid around a center tile.
 *
 * @param centerTileX - Center tile X
 * @param centerTileZ - Center tile Z
 * @param radius - Radius in tiles (e.g., 2 gives a 5×5 grid)
 * @returns Array of tile coordinates
 *
 * @example
 * tileNeighborhood(0, 0, 1) // 9 tiles: -1..1 × -1..1
 * tileNeighborhood(5, 3, 2) // 25 tiles: 3..7 × 1..5
 */
export function tileNeighborhood(
    centerTileX: number,
    centerTileZ: number,
    radius = 2
): readonly CanonicalTileCoords[] {
    const tiles: CanonicalTileCoords[] = [];
    for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
            tiles.push({
                tileX: centerTileX + dx,
                tileZ: centerTileZ + dz
            });
        }
    }
    return tiles;
}

/** Options for computing tiles covering a block range */
export interface TilesInBlockRangeOptions {
    /** Minimum block X */
    minBlockX: number;
    /** Maximum block X */
    maxBlockX: number;
    /** Minimum block Z */
    minBlockZ: number;
    /** Maximum block Z */
    maxBlockZ: number;
    /** Pyramid level */
    level: number;
}

/**
 * Get all tile coordinates that cover a block-coordinate range at a given level.
 *
 * @param options - Block range and level
 * @param pyramid - Pyramid configuration
 * @returns Array of tile coordinates covering the range
 */
export function tilesInBlockRange(
    options: Readonly<TilesInBlockRangeOptions>,
    pyramid: Readonly<TilePyramidConfig>
): readonly CanonicalTileCoords[] {
    const bpt = blocksPerTile(options.level, pyramid);
    const minTileX = Math.floor(options.minBlockX / bpt);
    const maxTileX = Math.floor(options.maxBlockX / bpt);
    const minTileZ = Math.floor(options.minBlockZ / bpt);
    const maxTileZ = Math.floor(options.maxBlockZ / bpt);

    const tiles: CanonicalTileCoords[] = [];
    for (let tx = minTileX; tx <= maxTileX; tx++) {
        for (let tz = minTileZ; tz <= maxTileZ; tz++) {
            tiles.push({ tileX: tx, tileZ: tz });
        }
    }
    return tiles;
}
