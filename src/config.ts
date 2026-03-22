/**
 * Tile Provider Factory
 *
 * Creates a tile provider (Dynmap or BlueMap) from the app configuration.
 * Standalone replacement for the config-store's createTileProviderFromConfig
 * used by build scripts.
 *
 * @module config
 */

import { BlueMapTileProvider } from './providers/bluemap-provider.js';
import { DynmapTileProvider } from './providers/dynmap-provider.js';
import type { AppConfig, TileSource } from './types.js';

/**
 * Create a tile provider matching the given config.
 *
 * @param config - The application config to read tile source from
 * @returns A TileProvider instance matching the configured source
 */
export function createTileProviderFromConfig(config: AppConfig): DynmapTileProvider | BlueMapTileProvider {
    const source: TileSource = config.tileSource;
    switch (source) {
        case 'dynmap': {
            return new DynmapTileProvider(config.dynmap.baseUrl);
        }
        case 'bluemap': {
            const bluemap = config.bluemap;
            if (!bluemap) {
                console.warn('tileSource is "bluemap" but no bluemap config provided, falling back to dynmap');
                return new DynmapTileProvider(config.dynmap.baseUrl);
            }
            return new BlueMapTileProvider(bluemap.baseUrl, bluemap.mapId);
        }
    }
}
