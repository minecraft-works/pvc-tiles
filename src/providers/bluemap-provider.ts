/**
 * BlueMap Tile Provider
 *
 * BlueMap serves lowres tiles as dual-layer PNGs:
 * - Top half (501×501 px): color map (top-down view)
 * - Bottom half (501×501 px): metadata (R=block light, G+B=height)
 *
 * Tiles cover 500×500 blocks at LOD 1 (1 pixel = 1 block).
 * The extra pixel (501 vs 500) is for vertex interpolation between tiles.
 *
 * URL pattern: `{baseUrl}/maps/{mapId}/tiles/{lod}/{xPath}/{zPath}.png`
 * where coordinates use digit-nesting: 123 → `x1/2/3`, -7 → `z-7`
 *
 * LOD system (factor 5, 3 levels):
 * - LOD 1: 500 blocks/tile (1 px = 1 block)
 * - LOD 2: 2500 blocks/tile (1 px = 5 blocks)
 * - LOD 3: 12500 blocks/tile (1 px = 25 blocks)
 *
 * Heightmap encoding (from BlueMap's GLSL fragment shader):
 * ```
 * height = G * 256 + B (unsigned, signed at 32768)
 * blockLight = R * 255 (range 0–15)
 * ```
 *
 * @module map/providers/bluemap-provider
 */

import type { DetailLevel, TileProvider } from './tile-provider.js';

/**
 * Tile provider for BlueMap map servers.
 *
 * @example
 * const provider = new BlueMapTileProvider('https://map.example.com', 'world');
 * provider.tileSize // 500
 * provider.getSourceWorldId('overworld') // 'world'
 * provider.getSourceTileUrl('overworld', provider.detailLevel, 12, -7)
 * // 'https://map.example.com/maps/world/tiles/1/x1/2/z-7.png'
 */
export class BlueMapTileProvider implements TileProvider {
    readonly name = 'bluemap';
    readonly tileSize = 500;

    readonly detailLevel: DetailLevel = {
        id: 1,
        blocksPerTile: 500,
        label: 'lod1'
    };

    readonly overviewLevel: DetailLevel = {
        id: 3,
        blocksPerTile: 12_500,
        label: 'lod3'
    };

    constructor(
        private readonly sourceBaseUrl: string,
        private readonly mapId = 'world'
    ) {}

    /**
     * Convert normalized world name to BlueMap's map identifier.
     *
     * @param normalizedWorld - 'overworld', 'the_nether', or 'the_end'
     * @returns BlueMap map ID (e.g., 'world', 'world_nether')
     */
    getSourceWorldId(normalizedWorld: string): string {
        if (normalizedWorld === 'overworld') { return this.mapId; }
        if (normalizedWorld === 'the_nether') { return `${this.mapId}_nether`; }
        if (normalizedWorld === 'the_end') { return `${this.mapId}_the_end`; }
        return normalizedWorld;
    }

    /**
     * Generate BlueMap tile URL with digit-nesting path encoding.
     *
     * Format: `{baseUrl}/maps/{mapId}/tiles/{lod}/{xPath}/{zPath}.png`
     * @param normalizedWorld - Normalized world name (e.g., 'overworld', 'the_nether')
     * @param level - Detail level config with zoom id
     * @param tileX - X tile coordinate
     * @param tileZ - Z tile coordinate
     * @returns Full URL string for the tile image
     */
    getSourceTileUrl(
        normalizedWorld: string,
        level: DetailLevel,
        tileX: number,
        tileZ: number
    ): string {
        const worldId = this.getSourceWorldId(normalizedWorld);
        const xPath = encodeCoordPath(tileX, 'x');
        const zPath = encodeCoordPath(tileZ, 'z');
        return `${this.sourceBaseUrl}/maps/${worldId}/tiles/${String(level.id)}/${xPath}/${zPath}.png`;
    }
}

// ============================================================================
// Coordinate Path Encoding
// ============================================================================

/**
 * Encode a tile coordinate into BlueMap's digit-nesting path format.
 *
 * Multi-digit numbers have their digits split into nested directories.
 * Single-digit numbers and negative signs are kept together with the prefix.
 *
 * @param value - Tile coordinate value
 * @param prefix - Axis prefix ('x' or 'z')
 * @returns Encoded path segment
 *
 * @example
 * encodeCoordPath(0, 'x')    // 'x0'
 * encodeCoordPath(5, 'z')    // 'z5'
 * encodeCoordPath(12, 'x')   // 'x1/2'
 * encodeCoordPath(123, 'x')  // 'x1/2/3'
 * encodeCoordPath(-7, 'z')   // 'z-7'
 * encodeCoordPath(-73, 'z')  // 'z-7/3'
 */
export function encodeCoordPath(value: number, prefix: string): string {
    const text = String(value);

    if (value < 0) {
        const digits = text.slice(1); // remove leading '-'
        if (digits.length <= 1) { return `${prefix}-${digits}`; }
        return `${prefix}-${Array.from(digits).join('/')}`;
    }

    if (text.length <= 1) { return `${prefix}${text}`; }
    return `${prefix}${Array.from(text).join('/')}`;
}
