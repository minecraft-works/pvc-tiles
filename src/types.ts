/**
 * Type definitions for the PVC Tiles pipeline.
 * 
 * Contains Zod schemas for configuration validation and TypeScript types
 * for the tile pyramid, providers, and app config.
 */

import { z } from 'zod';

// ============================================================================
// Configuration Types
// ============================================================================

const DynmapConfigSchema = z.object({
    baseUrl: z.url(),
    tileSize: z.number().int().positive(),
    defaultZoom: z.number().int().min(0).max(10),
    maxZoomLevel: z.number().int().positive(),
    playerRefreshMs: z.number().int().positive()
});

const BlueMapConfigSchema = z.object({
    baseUrl: z.url(),
    mapId: z.string().min(1).optional().default('world'),
    playerRefreshMs: z.number().int().positive()
});

const TilePyramidConfigSchema = z.object({
    /** Number of pyramid levels (higher = more detail tiers) */
    levels: z.number().int().min(1).max(10).default(3),
    /** Block coverage multiplier between adjacent levels */
    scaleFactor: z.number().int().min(2).max(32).default(4),
    /** Blocks per tile at the highest detail level (= pixels at 1 block/pixel) */
    baseBlocksPerTile: z.number().int().positive().default(256),
    /** Overlap pixels baked into each side of every tile PNG */
    border: z.number().int().min(0).default(0),
    /** Optional block-coordinate bounding box to limit tile rendering within an ROI */
    renderBounds: z.object({ minX: z.number(), minZ: z.number(), maxX: z.number(), maxZ: z.number() }).optional(),
});

export type TilePyramidConfig = z.infer<typeof TilePyramidConfigSchema>;

/**
 * Partial pyramid overrides stored per-source in `tileSourcePresets`.
 * Only the fields you want to override need to be specified.
 */
const TilePyramidPresetSchema = TilePyramidConfigSchema.partial();

/** Tile source discriminator: 'dynmap' or 'bluemap' */
export const TileSourceSchema = z.enum(['dynmap', 'bluemap']).default('dynmap');
export type TileSource = z.infer<typeof TileSourceSchema>;

export const AppConfigSchema = z.object({
    dataUrl: z.string().min(1),
    dataRefreshMs: z.number().int().positive().optional().default(60_000),
    tileSource: TileSourceSchema,
    tileSourcePresets: z.object({
        dynmap: TilePyramidPresetSchema.optional(),
        bluemap: TilePyramidPresetSchema.optional()
    }).optional(),
    tilePyramid: TilePyramidConfigSchema.default({
        levels: 3,
        scaleFactor: 4,
        baseBlocksPerTile: 256,
        border: 0,
    }),
    dynmap: DynmapConfigSchema,
    bluemap: BlueMapConfigSchema.optional(),
    analysis: z.object({
        shopClusterDistance: z.number().positive(),
        maxTransitiveIterations: z.number().int().positive(),
        minIndependentShops: z.number().int().positive()
    })
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

// ============================================================================
// Config Preset Resolution
// ============================================================================

/**
 * Type guard that narrows `unknown` to `Record<string, unknown>`.
 *
 * @param value - Value to check
 * @returns True if value is a non-null object
 */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/**
 * Merge `tileSourcePresets[tileSource]` into the raw config before Zod validation.
 * Preset provides base values; explicit `tilePyramid` fields override them.
 *
 * @param raw - Raw parsed JSON (unknown type)
 * @returns The same object with `tilePyramid` pre-merged from the preset
 */
export function resolveRawConfig(raw: unknown): unknown {
    if (!isRecord(raw)) { return raw; }
    const source = typeof raw.tileSource === 'string' ? raw.tileSource : undefined;
    if (!source || !isRecord(raw.tileSourcePresets)) { return raw; }
    const presetValue = raw.tileSourcePresets[source];
    if (!isRecord(presetValue)) { return raw; }
    const explicit = isRecord(raw.tilePyramid) ? raw.tilePyramid : {};
    return { ...raw, tilePyramid: { ...presetValue, ...explicit } };
}

// ============================================================================
// Default Configuration
// ============================================================================

/** Fallback configuration when config.json cannot be loaded or parsed */
export const DEFAULT_CONFIG: AppConfig = {
    dataUrl: 'https://web.peacefulvanilla.club/shops/data.json',
    dataRefreshMs: 60_000,
    tileSource: 'dynmap',
    tilePyramid: {
        levels: 3,
        scaleFactor: 4,
        baseBlocksPerTile: 256,
        border: 0,
    },
    dynmap: {
        baseUrl: 'https://web.peacefulvanilla.club/maps',
        tileSize: 128,
        defaultZoom: 4,
        maxZoomLevel: 7,
        playerRefreshMs: 1000
    },
    analysis: {
        shopClusterDistance: 16,
        maxTransitiveIterations: 10,
        minIndependentShops: 3
    }
};
