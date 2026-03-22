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
    /** Canonical tile width in pixels */
    tileWidth: z.number().int().positive().default(256),
    /** Canonical tile height in pixels */
    tileHeight: z.number().int().positive().default(256),
    /** Number of pyramid levels (higher = more detail tiers) */
    levels: z.number().int().min(1).max(10).default(3),
    /** Block coverage multiplier between adjacent levels */
    scaleFactor: z.number().int().min(2).max(32).default(4),
    /** Blocks per tile at the highest detail level */
    baseBlocksPerTile: z.number().int().positive().default(256),
    /** Output tile format */
    format: z.enum(['png', 'webp', 'avif', 'jpeg']).default('png'),
    /** Optional block-coordinate bounding box to limit tile rendering within an ROI */
    renderBounds: z.object({ minX: z.number(), minZ: z.number(), maxX: z.number(), maxZ: z.number() }).optional(),
    /** Heightmap-based lighting configuration (BlueMap sources only) */
    lighting: z.object({
        /** Enable baked lighting at build time */
        enabled: z.boolean().default(true),
        /** Shading model: 'slope' (BlueMap-style) or 'lambertian' (normal-based) */
        model: z.enum(['slope', 'lambertian']).default('lambertian'),
        /** Sun direction vector [x, y, z] — normalized internally */
        sunDirection: z.tuple([z.number(), z.number(), z.number()]).default([0.3, 1, -0.3]),
        /** Ambient light intensity (0–1). Prevents pure-black shadows */
        ambientIntensity: z.number().min(0).max(1).default(0.35),
        /** Diffuse light intensity (0–1) */
        diffuseIntensity: z.number().min(0).max(1).default(0.65),
        /** Height exaggeration factor (1.0 = real height) */
        heightScale: z.number().positive().default(1),
        /**
         * Y component of the surface normal for Lambertian shading.
         * Higher = flatter terrain appearance (subtler per-block shading).
         * Default 2 = BlueMap-like (steep). Use ~20 for Minecraft pixel-art terrain.
         */
        normalScale: z.number().positive().default(2),
        /**
         * Additive brightness boost from BlueMap block-light channel (0–1).
         * 0 = disabled. 0.2 = subtle warm glow from torches/lava.
         */
        blockLightBoost: z.number().min(0).max(1).default(0),
        /**
         * Integer upscale factor applied before shading (1–4).
         * Heights are resampled per `heightUpsampleMode`; block-light is bilinear;
         * colors are nearest-neighbour. Shade is computed and the tile emitted
         * at `shadingScale × tileSize`. Set tileWidth/Height to match in the preset.
         */
        shadingScale: z.number().int().min(1).max(4).default(1),
        /** Shadow casting via heightmap ray marching */
        shadowCasting: z.object({
            enabled: z.boolean().default(false),
            /** Maximum ray march distance in pixels */
            maxDistance: z.number().int().positive().default(64),
            /** Shadow darkness (0 = no shadow, 1 = full black) */
            intensity: z.number().min(0).max(1).default(0.7),
        }).default({ enabled: false, maxDistance: 64, intensity: 0.7 }),
        /** Screen-space ambient occlusion from heightmap */
        ambientOcclusion: z.object({
            enabled: z.boolean().default(false),
            /** Number of radial samples per pixel */
            samples: z.number().int().min(4).max(64).default(16),
            /** Sampling radius in pixels */
            radius: z.number().int().positive().default(8),
            /** AO darkness multiplier (0 = none, 1 = full) */
            intensity: z.number().min(0).max(1).default(0.5),
        }).default({ enabled: false, samples: 16, radius: 8, intensity: 0.5 }),
        /** Post-processing unsharp mask for detail enhancement */
        unsharpMask: z.object({
            enabled: z.boolean().default(false),
            /** Gaussian blur radius in pixels */
            radius: z.number().int().positive().default(2),
            /** Sharpening amount multiplier */
            amount: z.number().min(0).max(5).default(0.5),
            /** Luminance difference threshold (skip subtle changes) */
            threshold: z.number().min(0).default(4),
        }).default({ enabled: false, radius: 2, amount: 0.5, threshold: 4 }),
        /** Hue-based per-material shading modifiers */
        materialShading: z.object({
            enabled: z.boolean().default(false),
            /** Additive specular highlight for water surfaces */
            waterSpecular: z.number().min(0).max(1).default(0.3),
            /** Brightness boost for foliage (additive, 0–1) */
            foliageBrightness: z.number().min(0).max(1).default(0.1),
            /** AO multiplier for stone/grey surfaces */
            stoneAOMultiplier: z.number().min(0).max(5).default(1.5),
            /** Brightness boost for snow surfaces (additive, 0–1) */
            snowBrightness: z.number().min(0).max(1).default(0.2),
            /** Constant specular add for lava glow (0–1) */
            lavaGlow: z.number().min(0).max(1).default(0.25),
            /** AO multiplier for sand surfaces */
            sandAOMultiplier: z.number().min(0).max(2).default(0.4),
        }).default({ enabled: false, waterSpecular: 0.3, foliageBrightness: 0.1, stoneAOMultiplier: 1.5, snowBrightness: 0.2, lavaGlow: 0.25, sandAOMultiplier: 0.4 }),
        /** Normal kernel size: 3=central diff, 5=Sobel 5×5, 7=Sobel 7×7 */
        normalKernelSize: z.union([z.literal(3), z.literal(5), z.literal(7)]).default(3),
        /** Height upsampling method when shadingScale > 1. 'nearest' preserves blocky Minecraft normals. */
        heightUpsampleMode: z.enum(['bilinear', 'nearest']).default('nearest'),
    }).optional()
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
        tileWidth: 256,
        tileHeight: 256,
        levels: 3,
        scaleFactor: 4,
        baseBlocksPerTile: 256,
        format: 'png' as const,
        lighting: {
            enabled: true,
            model: 'lambertian' as const,
            sunDirection: [0.3, 1, -0.3] as [number, number, number],
            ambientIntensity: 0.35,
            diffuseIntensity: 0.65,
            heightScale: 1,
            normalScale: 2,
            blockLightBoost: 0,
            shadingScale: 1,
            shadowCasting: { enabled: false, maxDistance: 64, intensity: 0.7 },
            ambientOcclusion: { enabled: false, samples: 16, radius: 8, intensity: 0.5 },
            unsharpMask: { enabled: false, radius: 2, amount: 0.5, threshold: 4 },
            materialShading: { enabled: false, waterSpecular: 0.3, foliageBrightness: 0.1, stoneAOMultiplier: 1.5, snowBrightness: 0.2, lavaGlow: 0.25, sandAOMultiplier: 0.4 },
            normalKernelSize: 3 as const,
            heightUpsampleMode: 'nearest' as const,
        }
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
        tileWidth: 256,
        tileHeight: 256,
        levels: 3,
        scaleFactor: 4,
        baseBlocksPerTile: 256,
        format: 'png',
        lighting: {
            enabled: true,
            model: 'lambertian',
            sunDirection: [0.3, 1, -0.3] as [number, number, number],
            ambientIntensity: 0.35,
            diffuseIntensity: 0.65,
            heightScale: 1,
            normalScale: 2,
            blockLightBoost: 0,
            shadingScale: 1,
            shadowCasting: { enabled: false, maxDistance: 64, intensity: 0.7 },
            ambientOcclusion: { enabled: false, samples: 16, radius: 8, intensity: 0.5 },
            unsharpMask: { enabled: false, radius: 2, amount: 0.5, threshold: 4 },
            materialShading: { enabled: false, waterSpecular: 0.3, foliageBrightness: 0.1, stoneAOMultiplier: 1.5, snowBrightness: 0.2, lavaGlow: 0.25, sandAOMultiplier: 0.4 },
            normalKernelSize: 3 as const,
            heightUpsampleMode: 'nearest' as const,
        }
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
