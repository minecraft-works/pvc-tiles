#!/usr/bin/env npx tsx
/**
 * Canonical Tile Renderer
 *
 * Re-renders source tiles (fetched by fetch-tiles.ts from Dynmap/BlueMap)
 * into the canonical pyramid format defined by config.json's tilePyramid.
 *
 * Source tiles:    public/tiles/{world}/{providerLevelId}/{tx}/{tz}.png
 * Canonical tiles: public/tiles/{world}/{canonicalLevel}/{tx}/{tz}.{format}
 *
 * For each source tile, the script:
 * 1. Reads the source image (any pixel dimensions)
 * 2. Splits it into splitFactor×splitFactor sub-regions
 * 3. Resizes each sub-region to tileWidth×tileHeight
 * 4. Writes the canonical tile
 *
 * Also overwrites manifest.json with canonical entries compatible with the
 * runtime's loadTileManifest().
 *
 * Run: npx tsx scripts/render-tiles.ts
 *      npm run render-tiles
 *
 * @module scripts/render-tiles
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import sharp from 'sharp';

import { createTileProviderFromConfig } from '../src/config';
import {
    blocksPerTile as pyramidBlocksPerTile,
    detailLevel,
    overviewLevel,
} from '../src/tile-pyramid';
import { AppConfigSchema, DEFAULT_CONFIG, resolveRawConfig, type TilePyramidConfig } from '../src/types';
import {
    applyCoolShadowTint,
    applyFullShading,
    applySlopeShading,
    applyUnsharpMask,
    boostSaturation,
    computeAmbientOcclusion,
    computeHardShadowMap,
    computeHeightAwareLightGlowParallel,
    computeMaterialModifiers,
    computeNeighborAO,
    computeShadeMap,
    computeShadowMap,
    decodeBlockLight,
    decodeHeightmap,
    extractSubHeights,
    extractSubRegionRgba,
    isDualLayerTile,
    type LightingConfig,
    upsampleBilinear,
    upsampleNearest,
} from './heightmap-shader';

// ============================================================================
// Constants
// ============================================================================

/** Raw tiles downloaded by fetch-tiles.ts (never served directly) */
const SOURCE_TILES_DIR = 'public/tiles-src';
/** Canonical rendered tiles served at runtime */
const TILES_DIR = 'public/tiles';
const MANIFEST_PATH = path.join(TILES_DIR, 'manifest.json');

// ============================================================================
// Types
// ============================================================================

interface SourceTile {
    world: string;
    tileX: number;
    tileZ: number;
    levelId: number;
    sourcePath: string;
}

interface CanonicalEntry {
    world: string;
    tileX: number;
    tileZ: number;
    blocksPerTile: number;
}

interface SplitResult {
    entries: CanonicalEntry[];
    rendered: number;
    skipped: number;
}

/** Options for splitting a source tile into canonical tiles */
interface SplitOptions {
    /** Source tile metadata */
    source: SourceTile;
    /** Canonical pyramid level to produce */
    canonLevel: number;
    /** Number of canonical tiles per source tile per axis */
    splitFactor: number;
    /** Pixel width of each crop region in the source */
    cropWidth: number;
    /** Pixel height of each crop region in the source */
    cropHeight: number;
    /** Pyramid configuration */
    pyramid: TilePyramidConfig;
    /** Whether the source is a BlueMap dual-layer tile (color + heightmap) */
    isDualLayer: boolean;
    /** Lighting configuration (used only when isDualLayer is true) */
    lightingConfig?: LightingConfig;
}

/** Shared context for rendering a single dual-layer sub-tile */
interface DualLayerSubTileContext {
    /** Grid offset along X axis */
    dx: number;
    /** Grid offset along Z axis */
    dz: number;
    /** Source tile metadata */
    source: SourceTile;
    /** Split factor per axis */
    splitFactor: number;
    /** Canonical level index */
    canonLevel: number;
    /** Canonical blocks-per-tile value */
    canonBpt: number;
    /** Pixel width of each crop region */
    cropWidth: number;
    /** Pixel height of each crop region */
    cropHeight: number;
    /** Width of the full source image */
    sourceWidth: number;
    /** Full-source color buffer (RGBA) */
    colorBuffer: Buffer;
    /** Decoded full-source heightmap */
    heights: Float32Array;
    /** Decoded full-source block-light values (0–1 per pixel), or undefined when not available */
    blockLights: Float32Array | undefined;
    /** Lighting configuration */
    lightingConfig: LightingConfig;
    /** Pyramid configuration */
    pyramid: TilePyramidConfig;
}

// ============================================================================
// Config
// ============================================================================

function loadConfig() {
    const configPath = 'config.json';
    let config = DEFAULT_CONFIG;
    if (existsSync(configPath)) {
        const raw: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
        const parsed = AppConfigSchema.safeParse(resolveRawConfig(raw));
        if (parsed.success) {
            config = parsed.data;
        } else {
            console.warn('Invalid config.json, using defaults:', parsed.error.message);
        }
    } else {
        console.warn('config.json not found, using defaults');
    }
    return config;
}

// ============================================================================
// World normalization
// ============================================================================

function normalizeWorld(world: string): string {
    const lower = world.toLowerCase();
    if (lower === 'world' || lower === 'overworld' || lower === 'minecraft_overworld') {
        return 'overworld';
    }
    if (lower.includes('nether')) {
        return 'the_nether';
    }
    if (lower.includes('end')) {
        return 'the_end';
    }
    return world;
}

// ============================================================================
// Source tile discovery
// ============================================================================

/**
 * Scan the tiles directory for source tiles at a specific provider level.
 *
 * @param world - Normalized world name (e.g., 'overworld')
 * @param levelId - Provider-specific level ID (e.g., 8 for Dynmap detail)
 * @returns Array of discovered source tiles
 */
/** Pattern matching both fetched ({z}.png) and pre-rendered ({z}_height-lit.png) tiles. */
const SOURCE_TILE_PATTERN = /^(?<z>-?\d+)(?<suffix>_height-lit)?\.png$/u;

/**
 * Scan a single tileX directory and collect source tiles into the map.
 * Prefers `_height-lit` variant when both plain and pre-rendered exist.
 *
 * @param txDirPath - Path to the tileX directory on disk
 * @param world - Normalised world name
 * @param tileX - Parsed X coordinate
 * @param levelId - Provider-specific level ID
 * @param tileMap - Accumulator map keyed by "tileX/tileZ"
 */
function collectTilesFromDirectory(
    txDirPath: string, world: string, tileX: number, levelId: number,
    tileMap: Map<string, SourceTile>,
): void {
    for (const file of readdirSync(txDirPath)) {
        const match = SOURCE_TILE_PATTERN.exec(file);
        if (match?.groups && (!tileMap.has(`${tileX}/${match.groups.z}`) || match.groups.suffix)) {
            const tileZ = Number.parseInt(match.groups.z, 10);
            tileMap.set(`${tileX}/${tileZ}`, {
                world, tileX, tileZ, levelId,
                sourcePath: path.join(txDirPath, file),
            });
        }
    }
}

function findSourceTilesInWorld(world: string, levelId: number): SourceTile[] {
    const levelDir = path.join(SOURCE_TILES_DIR, world, String(levelId));
    if (!existsSync(levelDir)) { return []; }

    const tileMap = new Map<string, SourceTile>();
    for (const txDirName of readdirSync(levelDir)) {
        const txDirPath = path.join(levelDir, txDirName);
        const tileX = Number.parseInt(txDirName, 10);
        if (!statSync(txDirPath).isDirectory() || Number.isNaN(tileX)) { continue; }

        collectTilesFromDirectory(txDirPath, world, tileX, levelId, tileMap);
    }

    return [...tileMap.values()];
}

/**
 * Find all world directories under the tiles directory.
 *
 * @returns Array of normalized world name strings
 */
function findWorlds(): string[] {
    if (!existsSync(SOURCE_TILES_DIR)) { return []; }
    return readdirSync(SOURCE_TILES_DIR)
        .filter(name => {
            const fullPath = path.join(SOURCE_TILES_DIR, name);
            return statSync(fullPath).isDirectory();
        })
        .map(name => normalizeWorld(name));
}

// ============================================================================
// Rendering
// ============================================================================

/**
 * Apply output format encoding to a sharp pipeline.
 *
 * @param pipeline - Sharp pipeline to encode
 * @param format - Target format string ('jpeg', 'webp', 'avif', or default png)
 * @returns The pipeline with the format encoder applied
 */
function applyFormat(pipeline: sharp.Sharp, format: string): sharp.Sharp {
    // Flatten alpha before encoding — all canonical tiles are opaque terrain.
    // Unexplored areas in sparse mosaics render as black rather than transparent,
    // which is acceptable and avoids the overhead of an extra alpha channel.
    const flat = pipeline.flatten({ background: { r: 0, g: 0, b: 0 } });
    switch (format) {
        // lossless=true + effort=6 (max) gives best compression without quality loss.
        // nearLossless + quality 100 not used — true lossless is smaller for pixel-art terrain.
        case 'webp': { return flat.webp({ lossless: true, effort: 6 }); }
        case 'avif': { return flat.avif(); }
        case 'jpeg': { return flat.jpeg({ progressive: true, quality: 92, mozjpeg: true }); }
        default: { return flat.png({ compressionLevel: 9, effort: 10 }); }
    }
}

/**
 * Upscale sub-region buffers when shadingScale > 1.
 *
 * @param subColor - 4-channel RGBA Buffer at source resolution
 * @param subHeights - Height float array at source resolution
 * @param subBlockLights - Block-light float array (or undefined)
 * @param cropWidth - Source width in pixels
 * @param cropHeight - Source height in pixels
 * @param shadingScale - Scale factor (1 = no upscale)
 * @param heightUpsampleMode - 'nearest' or any other value for bilinear
 * @returns Upscaled buffers (same object references when scale === 1)
 */
async function upscaleSubRegion(
    subColor: Buffer,
    subHeights: Float32Array,
    subBlockLights: Float32Array | undefined,
    cropWidth: number,
    cropHeight: number,
    shadingScale: number,
    heightUpsampleMode: string,
): Promise<{ shadedColor: Buffer; shadedHeights: Float32Array; shadedBlockLights: Float32Array | undefined }> {
    if (shadingScale <= 1) {
        return { shadedColor: subColor, shadedHeights: subHeights, shadedBlockLights: subBlockLights };
    }
    const upW = cropWidth  * shadingScale;
    const upH = cropHeight * shadingScale;
    const shadedColor = await sharp(subColor, { raw: { width: cropWidth, height: cropHeight, channels: 4 } })
        .resize(upW, upH, { kernel: 'nearest' })
        .raw()
        .toBuffer();
    const shadedHeights = heightUpsampleMode === 'nearest'
        ? upsampleNearest(subHeights, cropWidth, cropHeight, shadingScale)
        : upsampleBilinear(subHeights, cropWidth, cropHeight, shadingScale);
    const shadedBlockLights = subBlockLights
        ? upsampleBilinear(subBlockLights, cropWidth, cropHeight, shadingScale)
        : undefined;
    return { shadedColor, shadedHeights, shadedBlockLights };
}

/**
 * Apply BlueMap-exact slope shading and post-processing enhancements in-place.
 *
 * Passes in order: additive BlueMap slope shade, cool-tinted shadow × AO
 * darkening, height-aware block-light glow (parallel worker threads), and
 * saturation boost.
 *
 * @param shadedColor - RGBA pixel buffer (mutated)
 * @param shadedHeights - Decoded height values
 * @param shadedBlockLights - Block-light values per pixel (optional)
 * @param shadedW - Buffer width in pixels
 * @param shadedH - Buffer height in pixels
 * @param heightScale - Height exaggeration for the slope-shade formula
 * @returns Hard-shadow and AO maps for downstream diagnostic use
 */
// Block-space lighting constants (scale-invariant) — see _render-single-tile.ts for rationale.
// Pixel values = blockValue × shadingScale; falloff = blockFalloff / shadingScale².
const SHADOW_REACH_BLOCKS        = 16;    // hard-shadow ray reach [blocks]
const SHADOW_SLOPE_BLOCKS        = 2;   // sun angle [blocks/block]: 2.0 ≈ 63° elevation
const HEIGHT_GLOW_RADIUS_BLOCKS  = 24;    // height-aware glow radius [blocks]
const HEIGHT_GLOW_FALLOFF_BLOCKS = 0.032; // falloff coefficient [blocks⁻²] (= 0.008 × 2²)
const HEIGHT_GLOW_OFFSET_BLOCKS  = 1;     // light source height above terrain [blocks]

async function applySlopeEnhancements(
    shadedColor: Buffer,
    shadedHeights: Float32Array,
    shadedBlockLights: Float32Array | undefined,
    shadedW: number,
    shadedH: number,
    heightScale: number,
    scale: number,
): Promise<{ hardShadow: Float32Array; ao: Float32Array }> {
    applySlopeShading(shadedColor, shadedHeights, shadedW, shadedH, heightScale);
    const hardShadow = computeHardShadowMap(
        shadedHeights, shadedW, shadedH,
        SHADOW_REACH_BLOCKS * scale,
        SHADOW_SLOPE_BLOCKS / scale,
    );
    const ao         = computeNeighborAO(shadedHeights, shadedW, shadedH);
    const n          = shadedW * shadedH;

    // Cool-tinted shadow × AO (blue-shifted darken instead of plain multiply)
    applyCoolShadowTint(shadedColor, hardShadow, ao, shadedW, shadedH);

    // Height-aware block-light glow with terrain occlusion (parallel workers)
    if (shadedBlockLights) {
        const { r, g, b } = await computeHeightAwareLightGlowParallel(
            shadedBlockLights, shadedHeights, shadedW, shadedH,
            /* strength */         0.03,
            /* maxRadius */        HEIGHT_GLOW_RADIUS_BLOCKS  * scale,
            /* falloff */          HEIGHT_GLOW_FALLOFF_BLOCKS / (scale * scale),
            /* emitThreshold */    0.5,
            /* lightSourceOffset */ HEIGHT_GLOW_OFFSET_BLOCKS * scale,
        );
        for (let i = 0; i < n; i++) {
            const o = i * 4;
            shadedColor[o]     = Math.min(255, (shadedColor[o]     ?? 0) + Math.round(r[i] ?? 0));
            shadedColor[o + 1] = Math.min(255, (shadedColor[o + 1] ?? 0) + Math.round(g[i] ?? 0));
            shadedColor[o + 2] = Math.min(255, (shadedColor[o + 2] ?? 0) + Math.round(b[i] ?? 0));
        }
    }

    // Saturation boost — recover vibrancy lost from shadow darkening
    boostSaturation(shadedColor, shadedW, shadedH, 1.3);

    return { hardShadow, ao };
}

/**
 * Render a Float32Array map to a grayscale diagnostic PNG tile.
 *
 * @param map - Per-pixel float values in [0, 1] (rendered as 8-bit grey)
 * @param suffix - Filename suffix appended to the canonical tile name
 * @param world - Tile world directory name
 * @param canonLevel - Canonical zoom level
 * @param canonTileX - Canonical tile X index
 * @param canonTileZ - Canonical tile Z index
 * @param shadedW - Map width in pixels
 * @param shadedH - Map height in pixels
 * @param pyramid - Canonical tile size configuration
 */
/**
 * Scale a shaded RGBA buffer to canonical tile dimensions and write it to disk.
 *
 * @param buffer - Source RGBA buffer at bufW × bufH resolution
 * @param bufW - Buffer width in pixels
 * @param bufH - Buffer height in pixels
 * @param pyramid - Tile size and format configuration
 * @param outputPath - Destination file path
 */
async function writeShadedColorTile(
    buffer: Buffer,
    bufW: number,
    bufH: number,
    pyramid: TilePyramidConfig,
    outputPath: string,
): Promise<void> {
    let pipeline = sharp(buffer, { raw: { width: bufW, height: bufH, channels: 4 } });
    if (bufW >= pyramid.tileWidth && bufH >= pyramid.tileHeight) {
        if (bufW !== pyramid.tileWidth || bufH !== pyramid.tileHeight) {
            pipeline = pipeline.extract({ left: 0, top: 0, width: pyramid.tileWidth, height: pyramid.tileHeight });
        }
    } else {
        const scaleX = Math.ceil(pyramid.tileWidth  / bufW);
        const scaleY = Math.ceil(pyramid.tileHeight / bufH);
        const upW = bufW * scaleX;
        const upH = bufH * scaleY;
        pipeline = pipeline.resize(upW, upH, { kernel: 'nearest' });
        if (upW !== pyramid.tileWidth || upH !== pyramid.tileHeight) {
            pipeline = pipeline.extract({ left: 0, top: 0, width: pyramid.tileWidth, height: pyramid.tileHeight });
        }
    }
    await applyFormat(pipeline, pyramid.format).toFile(outputPath);
}

/**
 * Render a single dual-layer sub-tile: extract sub-region, compute shade,
 * write the shaded color tile and optional heightmap sidecar.
 *
 * @param context - Shared dual-layer rendering context
 * @returns Entry, plus whether the tile was newly rendered or skipped
 */
async function renderDualLayerSubTile(context: DualLayerSubTileContext): Promise<{
    entry: CanonicalEntry;
    wasRendered: boolean;
}> {
    const {
        dx, dz, source, splitFactor, canonLevel, canonBpt,
        cropWidth, cropHeight, sourceWidth, colorBuffer, heights, blockLights,
        lightingConfig, pyramid,
    } = context;

    const canonTileX = source.tileX * splitFactor + dx;
    const canonTileZ = source.tileZ * splitFactor + dz;
    const outputPath = path.join(
        TILES_DIR, source.world,
        String(canonLevel), String(canonTileX),
        `${canonTileZ}.${pyramid.format}`,
    );
    // Extract sub-regions
    const startX = dx * cropWidth;
    const startZ = dz * cropHeight;
    const subColor = extractSubRegionRgba(colorBuffer, sourceWidth, startX, startZ, cropWidth, cropHeight);
    const subHeights = extractSubHeights(heights, sourceWidth, startX, startZ, cropWidth, cropHeight);
    const subBlockLights = blockLights
        ? extractSubHeights(blockLights, sourceWidth, startX, startZ, cropWidth, cropHeight)
        : undefined;

    // Upscale buffers when shadingScale > 1 (heights: heightUpsampleMode, block-light: bilinear, color: nearest)
    const scale = lightingConfig.shadingScale;
    const shadedW = cropWidth  * scale;
    const shadedH = cropHeight * scale;
    const { shadedColor, shadedHeights, shadedBlockLights } = await upscaleSubRegion(
        subColor, subHeights, subBlockLights, cropWidth, cropHeight, scale, lightingConfig.heightUpsampleMode,
    );

    // Compute shade map and apply shading pipeline at (potentially upscaled) resolution
    const shade = computeShadeMap(shadedHeights, shadedW, shadedH, lightingConfig);
    if (lightingConfig.model === 'slope') {
        // BlueMap-exact slope shading + cool shadows + height-aware glow + saturation boost
        await applySlopeEnhancements(
            shadedColor, shadedHeights, shadedBlockLights, shadedW, shadedH,
            lightingConfig.heightScale, lightingConfig.shadingScale,
        );
    } else {
        const shadowMap = computeShadowMap(shadedHeights, shadedW, shadedH, lightingConfig);
        const aoMap = computeAmbientOcclusion(shadedHeights, shadedW, shadedH, lightingConfig);
        const { diffuseModifier, specularAdd } = computeMaterialModifiers(
            shadedColor, shadedHeights, shadedW, shadedH, lightingConfig, aoMap,
        );
        // Apply full shading pipeline (shade × shadow × AO × material + specular + blockLight)
        applyFullShading(
            shadedColor, shade, shadowMap, aoMap,
            diffuseModifier, specularAdd,
            shadedBlockLights, lightingConfig.blockLightBoost,
        );
        // Post-processing: unsharp mask (operates on final color buffer)
        applyUnsharpMask(shadedColor, shadedW, shadedH, lightingConfig);
    }

    const entry: CanonicalEntry = {
        world: source.world,
        tileX: canonTileX,
        tileZ: canonTileZ,
        blocksPerTile: canonBpt,
    };

    if (existsSync(outputPath)) {
        return { entry, wasRendered: false };
    }

    mkdirSync(path.dirname(outputPath), { recursive: true });

    // Write shaded color tile at canonical tile dimensions
    await writeShadedColorTile(shadedColor, shadedW, shadedH, pyramid, outputPath);

    return { entry, wasRendered: true };
}

/**
 * Split a source tile into canonical tiles.
 *
 * For Dynmap (512px source → 2×2 split → 256px canonical):
 * each quadrant of the source image becomes one canonical tile.
 *
 * For BlueMap dual-layer tiles (501×1002), the top half holds color pixels
 * and the bottom half holds heightmap metadata. When lighting is enabled,
 * shade is baked into the color using the heightmap gradients. Optionally,
 * a separate 8-bit grayscale heightmap tile is also emitted.
 *
 * @param options - Split configuration including source tile path, level, split factor, and crop dimensions
 * @returns Rendered tile entries with counts of new and skipped tiles
 */
async function splitSourceTile(options: SplitOptions): Promise<SplitResult> {
    const { source, canonLevel, splitFactor, cropWidth, cropHeight, pyramid, isDualLayer, lightingConfig } = options;
    const entries: CanonicalEntry[] = [];
    let rendered = 0;
    let skipped = 0;

    const sourceImage = sharp(source.sourcePath);
    const canonBpt = pyramidBlocksPerTile(canonLevel, pyramid);

    // -------------------------------------------------------------------
    // Dual-layer path: decode heightmap, apply shade, write heightmap tiles
    // -------------------------------------------------------------------
    if (isDualLayer && lightingConfig) {
        const meta = await sourceImage.metadata();
        const sourceWidth = meta.width;
        const colorHeight = Math.floor(meta.height / 2);

        // Read full source as raw RGBA (color half + heightmap half)
        const fullRaw = await sourceImage.clone()
            .ensureAlpha()
            .raw()
            .toBuffer();

        const rowBytes = sourceWidth * 4;
        const colorBuffer = Buffer.from(fullRaw.subarray(0, colorHeight * rowBytes));
        const heightBuffer = fullRaw.subarray(colorHeight * rowBytes, colorHeight * 2 * rowBytes);

        // Decode full heightmap (heights) and block-light channel once
        const heights = decodeHeightmap(heightBuffer, sourceWidth, colorHeight);
        const blockLights = lightingConfig.blockLightBoost > 0
            ? decodeBlockLight(heightBuffer, sourceWidth, colorHeight)
            : undefined;
        for (let dx = 0; dx < splitFactor; dx++) {
            for (let dz = 0; dz < splitFactor; dz++) {
                const { entry, wasRendered } = await renderDualLayerSubTile({
                    dx, dz, source, splitFactor, canonLevel, canonBpt,
                    cropWidth, cropHeight, sourceWidth, colorBuffer, heights, blockLights,
                    lightingConfig, pyramid,
                });
                entries.push(entry);
                rendered += wasRendered ? 1 : 0;
                skipped += wasRendered ? 0 : 1;
            }
        }

        return { entries, rendered, skipped };
    }

    // -------------------------------------------------------------------
    // Standard path: simple crop → resize → encode (Dynmap / non-heightmap)
    // -------------------------------------------------------------------
    for (let dx = 0; dx < splitFactor; dx++) {
        for (let dz = 0; dz < splitFactor; dz++) {
            const canonTileX = source.tileX * splitFactor + dx;
            const canonTileZ = source.tileZ * splitFactor + dz;
            const outputPath = path.join(
                TILES_DIR, source.world,
                String(canonLevel), String(canonTileX),
                `${canonTileZ}.${pyramid.format}`,
            );

            if (existsSync(outputPath)) {
                entries.push({
                    world: source.world,
                    tileX: canonTileX,
                    tileZ: canonTileZ,
                    blocksPerTile: canonBpt,
                });
                skipped++;
                continue;
            }

            mkdirSync(path.dirname(outputPath), { recursive: true });

            const extractRegion = {
                left: dx * cropWidth,
                top: dz * cropHeight,
                width: cropWidth,
                height: cropHeight,
            };

            let pipeline = sourceImage.clone().extract(extractRegion);

            // Resize if crop dimensions don't match target tile dimensions
            if (cropWidth !== pyramid.tileWidth || cropHeight !== pyramid.tileHeight) {
                pipeline = pipeline.resize(pyramid.tileWidth, pyramid.tileHeight);
            }

            pipeline = applyFormat(pipeline, pyramid.format);
            await pipeline.toFile(outputPath);
            entries.push({
                world: source.world,
                tileX: canonTileX,
                tileZ: canonTileZ,
                blocksPerTile: canonBpt,
            });
            rendered++;
        }
    }

    return { entries, rendered, skipped };
}

/**
 * Read the pixel dimensions of one source tile to determine crop regions.
 *
 * For BlueMap dual-layer tiles (height > 1.5× width), only the top half
 * (color data) is used for cropping. The bottom half is heightmap metadata.
 *
 * @param tiles - Source tiles at a given level
 * @param splitFactor - How many canonical tiles per axis per source tile
 * @returns Crop width and height in source pixels plus dual-layer flag, or undefined if no tiles
 */
async function getSourceCropDimensions(
    tiles: SourceTile[],
    splitFactor: number,
): Promise<{ cropWidth: number; cropHeight: number; isDualLayer: boolean } | undefined> {
    if (tiles.length === 0) { return undefined; }

    const { width, height } = await sharp(tiles[0].sourcePath).metadata();
    const dualLayer = isDualLayerTile(width, height);
    const effectiveHeight = dualLayer ? Math.floor(height / 2) : height;

    return {
        cropWidth: Math.floor(width / splitFactor),
        cropHeight: Math.floor(effectiveHeight / splitFactor),
        isDualLayer: dualLayer,
    };
}

// ============================================================================
// Level Processing
// ============================================================================

interface LevelProcessOptions {
    world: string;
    levelId: number;
    canonLevel: number;
    splitFactor: number;
    pyramid: TilePyramidConfig;
    label: string;
    /** Lighting config to use for dual-layer tiles (undefined = no shading) */
    lightingConfig?: LightingConfig;
}

/**
 * Process all source tiles at a given level for one world.
 *
 * @param options - Level processing configuration including world, source level ID, canonical level, and split factor
 * @returns Rendered tile entries with counts of new and skipped tiles
 */
async function processSourceLevel(options: LevelProcessOptions): Promise<SplitResult> {
    const { world, levelId, canonLevel, splitFactor, pyramid, label, lightingConfig } = options;
    let tiles = findSourceTilesInWorld(world, levelId);

    if (tiles.length === 0) {
        return { entries: [], rendered: 0, skipped: 0 };
    }

    // Filter tiles to renderBounds when configured (block-coordinate bounding box)
    const bounds = pyramid.renderBounds;
    if (bounds) {
        const sourceBpt = tiles[0].levelId === 0 ? pyramid.baseBlocksPerTile : (
            // Derive source blocks-per-tile from the first tile's level metadata.
            // For the active provider, levelId maps to a known bpt. Use the
            // canonical bpt × splitFactor as the source tile's block coverage.
            pyramidBlocksPerTile(canonLevel, pyramid) * splitFactor
        );
        const before = tiles.length;
        tiles = tiles.filter(t => {
            const blockMinX = t.tileX * sourceBpt;
            const blockMaxX = blockMinX + sourceBpt;
            const blockMinZ = t.tileZ * sourceBpt;
            const blockMaxZ = blockMinZ + sourceBpt;
            // AABB overlap test
            return blockMaxX > bounds.minX && blockMinX < bounds.maxX
                && blockMaxZ > bounds.minZ && blockMinZ < bounds.maxZ;
        });
        if (tiles.length < before) {
            console.log(`  renderBounds filter: ${before} → ${tiles.length} tiles (${bounds.minX},${bounds.minZ} to ${bounds.maxX},${bounds.maxZ})`);
        }
    }

    const crop = await getSourceCropDimensions(tiles, splitFactor);
    if (!crop) {
        return { entries: [], rendered: 0, skipped: 0 };
    }

    const dualLabel = crop.isDualLayer ? ' [dual-layer]' : '';
    console.log(`\n[${world}] ${tiles.length} source ${label} tiles → level ${canonLevel} (crop ${crop.cropWidth}×${crop.cropHeight}px)${dualLabel}`);

    const entries: CanonicalEntry[] = [];
    let rendered = 0;
    let skipped = 0;

    for (const tile of tiles) {
        try {
            const result = await splitSourceTile({
                source: tile,
                cropWidth: crop.cropWidth,
                cropHeight: crop.cropHeight,
                isDualLayer: crop.isDualLayer,
                canonLevel,
                splitFactor,
                pyramid,
                lightingConfig,
            });
            entries.push(...result.entries);
            rendered += result.rendered;
            skipped += result.skipped;
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`  [WARN] Failed to render ${tile.sourcePath}: ${message}`);
        }
    }

    return { entries, rendered, skipped };
}

// ============================================================================
// Intermediate Tile Derivation
// ============================================================================

/**
 * Build the array of sharp composites for one intermediate-tile mosaic group.
 * Reads each available shaded detail tile from disk and places it at the
 * correct grid position within the mosaic.  Missing tiles leave that cell
 * transparent (the parent sharp image is initialised to transparent).
 *
 * @param groupEntries - Detail-level entries that share the same intermediate parent
 * @param world - Normalised world name
 * @param sourceLevel - Level index of the source (detail) tiles
 * @param scale - Pyramid scale factor (tiles per intermediate tile side)
 * @param pyramid - Pyramid configuration (tile dimensions and format)
 * @returns Array of overlay options ready for sharp.composite()
 */
async function buildMosaicComposites(
    groupEntries: CanonicalEntry[],
    world: string,
    sourceLevel: number,
    scale: number,
    pyramid: TilePyramidConfig,
): Promise<sharp.OverlayOptions[]> {
    const composites: sharp.OverlayOptions[] = [];
    for (const detailEntry of groupEntries) {
        const localX = ((detailEntry.tileX % scale) + scale) % scale;
        const localZ = ((detailEntry.tileZ % scale) + scale) % scale;
        const detailPath = path.join(
            TILES_DIR, world,
            String(sourceLevel), String(detailEntry.tileX),
            `${detailEntry.tileZ}.${pyramid.format}`,
        );
        // Guard against stale cached tiles whose dimensions no longer match the
        // current pyramid config (e.g. a pre-shadingScale=2 run leaving 500×500
        // tiles when tileWidth/tileHeight is now 1000). Passing a raw buffer
        // with the wrong declared dimensions causes a libvips memory error.
        if (existsSync(detailPath)) {
            const meta = await sharp(detailPath).metadata();
            if (meta.width === pyramid.tileWidth && meta.height === pyramid.tileHeight) {
                // Pass the file path directly so sharp reads PNG dimensions from metadata
                // — no raw buffer spec means no possibility of a size mismatch.
                composites.push({
                    input: detailPath,
                    left: localX * pyramid.tileWidth,
                    top: localZ * pyramid.tileHeight,
                });
            } else {
                console.warn(
                    `  [WARN] Skipping stale tile ${detailPath}` +
                    ` (${meta.width}×${meta.height} ≠ expected` +
                    ` ${pyramid.tileWidth}×${pyramid.tileHeight}) — canonical cache may be stale`,
                );
            }
        }
    }
    return composites;
}

/**
 * Derive intermediate-level canonical tiles by downsampling a scaleFactor×scaleFactor
 * grid of already-rendered detail tiles.
 *
 * For each group of detail tiles that share a parent at
 * `detailLevel(pyramid) - 1`, the function:
 * 1. Reads the shaded detail tile PNGs from disk.
 * 2. Places each into a (scaleFactor x tileWidth) x (scaleFactor x tileHeight)
 *    mosaic at the correct grid position (transparent where tiles are absent).
 * 3. Lanczos-resizes the mosaic back to tileWidth x tileHeight.
 * 4. Writes to `TILES_DIR/world/{intermediateLevel}/{parentX}/{parentZ}.{format}`.
 *
 * Tiles already present on disk are skipped (skip-if-exists).
 * The LOD‑4 overview pass runs afterward and only writes to a different level
 * (overviewLevel = 0), so there is no conflict.
 *
 * @param world - Normalised world name
 * @param sourceEntries - Canonical entries from the source level to derive from
 * @param sourceLevel - Level index of the source tiles
 * @param pyramid - Pyramid configuration
 * @returns SplitResult with new entries and render/skip counts
 */
async function deriveIntermediateTiles(
    world: string,
    sourceEntries: CanonicalEntry[],
    sourceLevel: number,
    pyramid: TilePyramidConfig,
): Promise<SplitResult> {
    const targetLevel = sourceLevel - 1;
    if (targetLevel < 0) {
        return { entries: [], rendered: 0, skipped: 0 };
    }

    const scale = pyramid.scaleFactor;
    const targetBpt = pyramidBlocksPerTile(targetLevel, pyramid);

    // Group source entries by parent tile coordinate at the target level
    const groups = new Map<string, CanonicalEntry[]>();
    for (const entry of sourceEntries) {
        if (entry.world !== world) { continue; }
        const parentX = Math.floor(entry.tileX / scale);
        const parentZ = Math.floor(entry.tileZ / scale);
        const key = `${parentX}/${parentZ}`;
        const existing = groups.get(key);
        if (existing) {
            existing.push(entry);
        } else {
            groups.set(key, [entry]);
        }
    }

    if (groups.size === 0) {
        return { entries: [], rendered: 0, skipped: 0 };
    }

    const mosaicW = pyramid.tileWidth * scale;
    const mosaicH = pyramid.tileHeight * scale;
    const entries: CanonicalEntry[] = [];
    let rendered = 0;
    let skipped = 0;

    console.log(`\n[${world}] Deriving ${groups.size} level-${targetLevel} tiles from ${sourceEntries.length} level-${sourceLevel} tiles (${scale}x${scale} -> 1)`);

    for (const [groupKey, groupEntries] of groups) {
        const slashPos = groupKey.indexOf('/');
        const parentX = Number.parseInt(groupKey.slice(0, slashPos), 10);
        const parentZ = Number.parseInt(groupKey.slice(slashPos + 1), 10);

        const outputPath = path.join(
            TILES_DIR, world,
            String(targetLevel), String(parentX),
            `${parentZ}.${pyramid.format}`,
        );

        const entry: CanonicalEntry = {
            world,
            tileX: parentX,
            tileZ: parentZ,
            blocksPerTile: targetBpt,
        };

        if (existsSync(outputPath)) {
            entries.push(entry);
            skipped++;
        } else {
            const composites = await buildMosaicComposites(groupEntries, world, sourceLevel, scale, pyramid);
            if (composites.length > 0) {
                mkdirSync(path.dirname(outputPath), { recursive: true });

                // Sharp's chained .composite().resize() pipeline bleeds content from
                // opaque source tiles across the transparent mosaic background when
                // resizing. Buffer the composite first, then resize in a separate pass
                // to get correct alpha-aware downsampling.
                const mosaicBuffer = await sharp({
                    create: {
                        width: mosaicW,
                        height: mosaicH,
                        channels: 4,
                        background: { r: 0, g: 0, b: 0, alpha: 0 },
                    },
                }).composite(composites).raw().ensureAlpha().toBuffer();

                let pipeline = sharp(mosaicBuffer, {
                    raw: { width: mosaicW, height: mosaicH, channels: 4 },
                }).resize(pyramid.tileWidth, pyramid.tileHeight, { kernel: 'lanczos3' });
                pipeline = applyFormat(pipeline, pyramid.format);
                await pipeline.toFile(outputPath);

                entries.push(entry);
                rendered++;
            }
        }
    }

    return { entries, rendered, skipped };
}

// ============================================================================
// Main
// ============================================================================
 
async function main(): Promise<void> {
    console.log('=== Canonical Tile Renderer ===');
    console.log(`Timestamp: ${new Date().toISOString()}`);

    // Load config
    const config = loadConfig();
    const pyramid = config.tilePyramid;
    const provider = createTileProviderFromConfig(config);

    console.log(`\nSource provider: ${provider.name}`);
    console.log(`  Detail: ${provider.detailLevel.label} (${provider.detailLevel.blocksPerTile} blocks/tile)`);
    console.log(`  Overview: ${provider.overviewLevel.label} (${provider.overviewLevel.blocksPerTile} blocks/tile)`);

    console.log('\nCanonical pyramid:');
    console.log(`  Tile size: ${pyramid.tileWidth}×${pyramid.tileHeight}px`);
    console.log(`  Levels: ${pyramid.levels} (detail=${detailLevel(pyramid)}, overview=${overviewLevel()})`);
    console.log(`  Format: ${pyramid.format}`);

    // Validate split factors (must be integer for simple splitting)
    const canonDetailBpt = pyramidBlocksPerTile(detailLevel(pyramid), pyramid);

    const detailSplit = provider.detailLevel.blocksPerTile / canonDetailBpt;

    if (!Number.isInteger(detailSplit)) {
        console.error(`\nERROR: Source detail blocks/tile (${provider.detailLevel.blocksPerTile}) is not a multiple of canonical (${canonDetailBpt}).`);
        console.error('Non-aligned grid compositing is not yet supported.');
        process.exit(1);
    }

    console.log(`\nSplit factors: detail=${detailSplit}×${detailSplit}`);

    // Resolve lighting configuration (only for BlueMap sources with lighting enabled)
    const lightingCfg = pyramid.lighting;
    let lightingConfig: LightingConfig | undefined;
    if (lightingCfg?.enabled) {
        lightingConfig = {
            model: lightingCfg.model,
            sunDirection: lightingCfg.sunDirection,
            ambientIntensity: lightingCfg.ambientIntensity,
            diffuseIntensity: lightingCfg.diffuseIntensity,
            heightScale: lightingCfg.heightScale,
            normalScale: lightingCfg.normalScale,
            blockLightBoost: lightingCfg.blockLightBoost,
            shadingScale: lightingCfg.shadingScale,
            shadowCasting: lightingCfg.shadowCasting,
            ambientOcclusion: lightingCfg.ambientOcclusion,
            unsharpMask: lightingCfg.unsharpMask,
            materialShading: lightingCfg.materialShading,
            normalKernelSize: lightingCfg.normalKernelSize,
        };
        console.log(`\nLighting: ${lightingConfig.model} model (ambient=${lightingConfig.ambientIntensity}, diffuse=${lightingConfig.diffuseIntensity}, heightScale=${lightingConfig.heightScale}, normalScale=${lightingConfig.normalScale}, blockLightBoost=${lightingConfig.blockLightBoost}, shadingScale=${lightingConfig.shadingScale})`);
        console.log(`  Sun direction: [${lightingConfig.sunDirection.join(', ')}]`);
        console.log(`  Shadow casting: ${lightingConfig.shadowCasting.enabled ? 'enabled' : 'disabled'}`);
        console.log(`  Ambient occlusion: ${lightingConfig.ambientOcclusion.enabled ? 'enabled' : 'disabled'}`);
        console.log(`  Unsharp mask: ${lightingConfig.unsharpMask.enabled ? 'enabled' : 'disabled'}`);
        console.log(`  Material shading: ${lightingConfig.materialShading.enabled ? 'enabled' : 'disabled'}`);
        console.log(`  Normal kernel size: ${lightingConfig.normalKernelSize}×${lightingConfig.normalKernelSize}`);
    } else {
        console.log('\nLighting: disabled');
    }

    // Discover worlds
    const worlds = findWorlds();
    console.log(`Worlds found: ${worlds.join(', ') || '(none)'}`);

    if (worlds.length === 0) {
        console.log('\nNo tiles to render.');
        return;
    }

    let totalRendered = 0;
    let totalSkipped = 0;
    const allEntries: CanonicalEntry[] = [];

    for (const world of worlds) {
        const detail = await processSourceLevel({
            levelId: provider.detailLevel.id,
            canonLevel: detailLevel(pyramid),
            splitFactor: detailSplit,
            label: 'detail',
            world,
            pyramid,
            lightingConfig,
        });
        allEntries.push(...detail.entries);
        totalRendered += detail.rendered;
        totalSkipped += detail.skipped;

        // Cascade downsampling from detail-1 down to 0 — each level is derived
        // purely from the level above it, so lighting calculations run only once
        // at the detail level.
        let currentEntries = detail.entries;
        for (let sourceLevel = detailLevel(pyramid); sourceLevel > 0; sourceLevel--) {
            const derived = await deriveIntermediateTiles(world, currentEntries, sourceLevel, pyramid);
            allEntries.push(...derived.entries);
            totalRendered += derived.rendered;
            totalSkipped += derived.skipped;
            currentEntries = derived.entries;
        }
    }

    // Deduplicate entries (same canonical tile from different source tiles)
    const entryMap = new Map<string, CanonicalEntry>();
    for (const entry of allEntries) {
        const key = `${entry.world}/${entry.blocksPerTile}/${entry.tileX}/${entry.tileZ}`;
        entryMap.set(key, entry);
    }

    // Prune entries whose output file no longer exists on disk (guards against
    // stale manifest from a partial/interrupted run or missing cache restore).
    // Derive the canonical level from the entry's blocksPerTile value.
    const uniqueEntries = [...entryMap.values()].filter(entry => {
        let level = detailLevel(pyramid);
        for (let l = 0; l < pyramid.levels; l++) {
            if (pyramidBlocksPerTile(l, pyramid) === entry.blocksPerTile) {
                level = l;
                break;
            }
        }
        const filePath = path.join(
            TILES_DIR, entry.world,
            String(level), String(entry.tileX),
            `${entry.tileZ}.${pyramid.format}`,
        );
        return existsSync(filePath);
    });

    // Write canonical manifest
    writeFileSync(MANIFEST_PATH, JSON.stringify(uniqueEntries, null, 2));

    console.log('\n=== Render Summary ===');
    console.log(`Rendered: ${totalRendered}`);
    console.log(`Skipped (cached): ${totalSkipped}`);
    console.log(`Canonical manifest: ${uniqueEntries.length} entries`);
    console.log('\n=== Complete ===');
}

main().catch((error: unknown) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
