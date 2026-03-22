/**
 * Dynmap Tile Provider
 *
 * Dynmap serves tiles as flat-color PNGs in a zoom-level pyramid.
 * Tiles are 512×512 pixels, each pixel = 1 block at max zoom (zoom 8).
 *
 * URL pattern: `{baseUrl}/tiles/{worldId}/{zoom}/{tileX}_{tileZ}.png`
 *
 * World IDs: `minecraft_overworld`, `minecraft_the_nether`, `minecraft_the_end`
 *
 * Zoom levels (used by this app):
 * - Zoom 8: 512 blocks/tile (1 px = 1 block, detail view)
 * - Zoom 4: 8192 blocks/tile (1 px = 16 blocks, overview)
 *
 * @module map/providers/dynmap-provider
 */

import type { DetailLevel, TileProvider } from './tile-provider.js';

/**
 * Tile provider for Dynmap map servers.
 *
 * @example
 * const provider = new DynmapTileProvider('https://map.example.com');
 * provider.tileSize // 512
 * provider.getSourceWorldId('overworld') // 'minecraft_overworld'
 * provider.getSourceTileUrl('overworld', provider.detailLevel, 3, -2)
 * // 'https://map.example.com/tiles/minecraft_overworld/8/3_-2.png'
 */
export class DynmapTileProvider implements TileProvider {
    readonly name = 'dynmap';
    readonly tileSize = 512;

    readonly detailLevel: DetailLevel = {
        id: 8,
        blocksPerTile: 512,
        label: 'zoom8'
    };

    readonly overviewLevel: DetailLevel = {
        id: 4,
        blocksPerTile: 8192,
        label: 'zoom4'
    };

    constructor(private readonly sourceBaseUrl: string) {}

    /**
     * Convert normalized world name to Dynmap's world identifier.
     *
     * @param normalizedWorld - 'overworld', 'the_nether', or 'the_end'
     * @returns Dynmap world ID (e.g., 'minecraft_overworld')
     */
    getSourceWorldId(normalizedWorld: string): string {
        return `minecraft_${normalizedWorld}`;
    }

    /**
     * Generate Dynmap tile URL.
     *
     * Format: `{baseUrl}/tiles/{worldId}/{zoom}/{tileX}_{tileZ}.png`
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
        return `${this.sourceBaseUrl}/tiles/${worldId}/${String(level.id)}/${String(tileX)}_${String(tileZ)}.png`;
    }

}
