#!/usr/bin/env npx tsx
/**
 * Canonical Tile Renderer
 *
 * Re-renders source tiles (fetched from Dynmap/BlueMap) into the canonical
 * tile pyramid format defined by pvc-tiles-api.md.
 *
 * Source tiles:    public/tiles-src/{world}/{levelId}/{tx}/{tz}.png
 * Canonical tiles: public/tiles/{world}/{zoom}/{x}/{z}.png
 *
 * Two render modes selected automatically from config:
 *
 * Split mode (integer split factor, e.g. Dynmap 512px → 256px canonical):
 *   For each source tile, split into splitFactor×splitFactor sub-regions and
 *   crop each to tileSize×tileSize pixels.
 *
 * Stitch mode (non-integer ratio, e.g. BlueMap 500px → 256px canonical):
 *   For each canonical tile, compute which source tile(s) overlap its block
 *   range and copy pixels directly — no resampling.
 *
 * Zoom convention: 0 = finest detail, negative = coarser.
 * Manifest format: { tileSize, border, tiles: [{ world, zoom, x, z, hasHeight }] }
 *
 * Run: npx tsx scripts/render-tiles.ts
 *      npm run render-tiles
 *
 * @module scripts/render-tiles
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import sharp from 'sharp';

import { createTileProviderFromConfig } from '../src/config';
import {
    blocksPerTile as pyramidBlocksPerTile,
    detailLevel,
    levelToZoom,
} from '../src/tile-pyramid';
import { AppConfigSchema, DEFAULT_CONFIG, resolveRawConfig, type TilePyramidConfig } from '../src/types';
import {
    decodeBlockLight,
    decodeHeightmap,
    extractSubRegionRgba,
    isDualLayerTile,
} from './heightmap-shader';

// ============================================================================
// Constants
// ============================================================================

/** Raw tiles downloaded by fetch-tiles.ts (never served directly) */
const SOURCE_TILES_DIR = 'public/tiles-src';
/** Canonical rendered tiles served at runtime */
const TILES_DIR = 'public/tiles';
const MANIFEST_PATH = path.join(TILES_DIR, 'manifest.json');

/** Block-light threshold (0–1) for emitter detection */
const EMITTER_THRESHOLD = 0.5;

/**
 * Build the disk path for a canonical tile or sidecar.
 *
 * @param world - World name
 * @param zoom - Zoom level
 * @param x - Tile X
 * @param z - Tile Z
 * @param suffix - File suffix ('.png', '_meta.png', '_emitters.bin')
 * @returns Absolute path to the tile file
 */
function tileFilePath(world: string, zoom: number, x: number, z: number, suffix = '.png'): string {
    return path.join(TILES_DIR, world, String(zoom), String(x), `${z}${suffix}`);
}

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

/** Manifest tile entry matching pvc-tiles-api.md */
interface CanonicalEntry {
    world: string;
    zoom: number;
    x: number;
    z: number;
    hasHeight: boolean;
}

interface SplitResult {
    entries: CanonicalEntry[];
    rendered: number;
    skipped: number;
}

/** Options for splitting a source tile into canonical tiles */
interface SplitOptions {
    source: SourceTile;
    canonLevel: number;
    splitFactor: number;
    tileSize: number;
    pyramid: TilePyramidConfig;
    isDualLayer: boolean;
}

/** Pre-loaded raw RGBA buffers for a single source tile */
interface LoadedSourceBuffers {
    /** Raw RGBA pixels of the colour layer (srcWidth × effectiveHeight × 4) */
    color: Buffer;
    /** Raw RGBA pixels of the height layer, or null for non-dual-layer sources */
    height: Buffer | null;
    /** Full image width in pixels (501 for BlueMap LOD-1) */
    srcWidth: number;
    /** Height of one layer in pixels (half of total for dual-layer) */
    effectiveHeight: number;
}

/** Top-level manifest matching pvc-tiles-api.md */
interface ManifestJson {
    tileSize: number;
    border: number;
    tiles: CanonicalEntry[];
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

/** Pattern matching both fetched ({z}.png) and pre-rendered ({z}_height-lit.png) tiles. */
const SOURCE_TILE_PATTERN = /^(?<z>-?\d+)(?<suffix>_height-lit)?\.png$/u;

/**
 * Scan a single tileX directory and collect source tiles into the map.
 * Prefers `_height-lit` variant when both plain and pre-rendered exist.
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
 * Find all world directories under the source tiles directory.
 *
 * @returns Array of normalised world name strings
 */
function findWorlds(): string[] {
    if (!existsSync(SOURCE_TILES_DIR)) { return []; }
    return readdirSync(SOURCE_TILES_DIR)
        .filter(name => statSync(path.join(SOURCE_TILES_DIR, name)).isDirectory())
        .map(normalizeWorld);
}

/**
 * Load raw RGBA buffers for every source tile in a world/level into a map
 * keyed by `"srcX/srcZ"`.
 *
 * For dual-layer (BlueMap) tiles the image is split vertically: the top half
 * is the colour layer and the bottom half is the height/light layer.
 *
 * @param world - Normalised world name
 * @param levelId - Provider-level identifier (e.g. 1 for BlueMap LOD-1)
 * @returns Map from "srcX/srcZ" to loaded buffers, and a dual-layer flag
 */
async function loadSourceBufferMap(
    world: string,
    levelId: number,
): Promise<{ buffers: Map<string, LoadedSourceBuffers>; isDualLayer: boolean }> {
    const sourceTiles = findSourceTilesInWorld(world, levelId);
    const buffers = new Map<string, LoadedSourceBuffers>();
    let isDualLayer = false;

    for (const tile of sourceTiles) {
        const img = sharp(tile.sourcePath);
        const meta = await img.metadata();
        if (!meta.width || !meta.height) { continue; }

        const dualLayer = isDualLayerTile(meta.width, meta.height);
        isDualLayer = dualLayer; // all tiles in a world/level share the same format

        const effectiveHeight = dualLayer ? Math.floor(meta.height / 2) : meta.height;
        const fullRaw = await img.ensureAlpha().raw().toBuffer();
        const rowBytes = meta.width * 4;

        const colorBuf = Buffer.from(fullRaw.subarray(0, effectiveHeight * rowBytes));
        const heightBuf = dualLayer
            ? Buffer.from(fullRaw.subarray(effectiveHeight * rowBytes, effectiveHeight * 2 * rowBytes))
            : null;

        buffers.set(`${tile.tileX}/${tile.tileZ}`, {
            color: colorBuf,
            height: heightBuf,
            srcWidth: meta.width,
            effectiveHeight,
        });
    }

    return { buffers, isDualLayer };
}

// ============================================================================
// Sidecar helpers
// ============================================================================

/**
 * Write _meta.png sidecar from raw heightmap RGBA sub-region.
 *
 * Re-maps: R (blocklight 0–15) → R (0–255), G/B (height) pass through, A=255.
 */
async function writeMetaTile(
    rawMetaRgba: Buffer,
    width: number,
    height: number,
    outputPath: string,
): Promise<void> {
    const pixelCount = width * height;
    const metaBuffer = Buffer.from(rawMetaRgba);
    for (let i = 0; i < pixelCount; i++) {
        const offset = i * 4;
        metaBuffer[offset] = Math.min(255, (metaBuffer[offset] ?? 0) * 17);
        metaBuffer[offset + 3] = 255;
    }
    mkdirSync(path.dirname(outputPath), { recursive: true });
    await sharp(metaBuffer, { raw: { width, height, channels: 4 } })
        .png({ compressionLevel: 9, effort: 10, palette: false })
        .toFile(outputPath);
}

/**
 * Scan block-light and height data to extract emitter positions, then write
 * _emitters.bin as little-endian Float32 [x, z, strength, height] tuples.
 */
function writeEmittersBin(
    blockLights: Float32Array,
    heights: Float32Array,
    width: number,
    height: number,
    outputPath: string,
): void {
    const tuples: number[] = [];
    for (let z = 0; z < height; z++) {
        for (let x = 0; x < width; x++) {
            const index = z * width + x;
            const strength = blockLights[index] ?? 0;
            if (strength >= EMITTER_THRESHOLD) {
                tuples.push(x, z, strength, heights[index] ?? 0);
            }
        }
    }
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, Buffer.from(new Float32Array(tuples).buffer));
}

/**
 * Stitch a single 256×256 canonical tile buffer from one or more source tile
 * buffers by pure pixel-copy (no resampling).
 *
 * A canonical tile covers blocks [canX×tileSize, canX×tileSize + tileSize).
 * A source tile covers blocks [sx×sourceBpt, sx×sourceBpt + sourceBpt).
 * Where those ranges overlap, pixels are copied directly.
 *
 * @param canX - Canonical tile X index
 * @param canZ - Canonical tile Z index
 * @param tileSize - Canonical tile side in pixels / blocks (e.g. 256)
 * @param sourceBpt - Source tile side in blocks (e.g. 500 for BlueMap LOD-1)
 * @param sourceBuffers - Map from "sx/sz" to loaded raw RGBA buffers
 * @param layer - Which buffer to read: 'color' or 'height'
 * @returns Filled RGBA Buffer (tileSize×tileSize×4), or null if no source data
 */
function stitchCanonicalBuffer(
    canX: number,
    canZ: number,
    tileSize: number,
    sourceBpt: number,
    sourceBuffers: Map<string, LoadedSourceBuffers>,
    layer: 'color' | 'height',
): Buffer | null {
    const blockMinX = canX * tileSize;
    const blockMaxX = blockMinX + tileSize;
    const blockMinZ = canZ * tileSize;
    const blockMaxZ = blockMinZ + tileSize;

    // Find source tile indices that overlap this canonical tile
    const sxMin = Math.floor(blockMinX / sourceBpt);
    const sxMax = Math.floor((blockMaxX - 1) / sourceBpt);
    const szMin = Math.floor(blockMinZ / sourceBpt);
    const szMax = Math.floor((blockMaxZ - 1) / sourceBpt);

    const out = Buffer.alloc(tileSize * tileSize * 4, 0);
    let hasData = false;

    for (let sx = sxMin; sx <= sxMax; sx++) {
        for (let sz = szMin; sz <= szMax; sz++) {
            const loaded = sourceBuffers.get(`${sx}/${sz}`);
            if (!loaded) { continue; }

            const srcBuf = layer === 'color' ? loaded.color : loaded.height;
            if (!srcBuf) { continue; }

            const srcStride = loaded.srcWidth; // 501 for BlueMap LOD-1

            // Block coordinate range of this source tile
            const srcBlockMinX = sx * sourceBpt;
            const srcBlockMinZ = sz * sourceBpt;

            // Overlap in block space
            const overlapBlockMinX = Math.max(blockMinX, srcBlockMinX);
            const overlapBlockMaxX = Math.min(blockMaxX, srcBlockMinX + sourceBpt);
            const overlapBlockMinZ = Math.max(blockMinZ, srcBlockMinZ);
            const overlapBlockMaxZ = Math.min(blockMaxZ, srcBlockMinZ + sourceBpt);

            if (overlapBlockMaxX <= overlapBlockMinX || overlapBlockMaxZ <= overlapBlockMinZ) { continue; }

            const w = overlapBlockMaxX - overlapBlockMinX;
            const h = overlapBlockMaxZ - overlapBlockMinZ;

            // Pixel offset into source buffer
            const srcPxX = overlapBlockMinX - srcBlockMinX;
            const srcPxZ = overlapBlockMinZ - srcBlockMinZ;

            // Pixel offset into output buffer
            const dstPxX = overlapBlockMinX - blockMinX;
            const dstPxZ = overlapBlockMinZ - blockMinZ;

            for (let row = 0; row < h; row++) {
                const srcOffset = ((srcPxZ + row) * srcStride + srcPxX) * 4;
                const dstOffset = ((dstPxZ + row) * tileSize + dstPxX) * 4;
                srcBuf.copy(out, dstOffset, srcOffset, srcOffset + w * 4);
            }
            hasData = true;
        }
    }

    return hasData ? out : null;
}

// ============================================================================
// Tile rendering
// ============================================================================

/**
 * Render a single dual-layer sub-tile: crop color → write PNG, write sidecars.
 *
 * @returns Entry and whether it was newly rendered or skipped (cached)
 */
async function renderDualLayerSubTile(
    dx: number,
    dz: number,
    source: SourceTile,
    splitFactor: number,
    canonLevel: number,
    tileSize: number,
    sourceWidth: number,
    colorBuffer: Buffer,
    heightBuffer: Uint8Array,
    pyramid: TilePyramidConfig,
): Promise<{ entry: CanonicalEntry; wasRendered: boolean }> {
    const canonTileX = source.tileX * splitFactor + dx;
    const canonTileZ = source.tileZ * splitFactor + dz;
    const zoom = levelToZoom(canonLevel, pyramid);

    const basePath = path.join(
        TILES_DIR, source.world,
        String(zoom), String(canonTileX),
        String(canonTileZ),
    );
    const colorPath = `${basePath}.png`;
    const metaPath = `${basePath}_meta.png`;
    const emittersPath = `${basePath}_emitters.bin`;

    const entry: CanonicalEntry = {
        zoom,
        world: source.world,
        x: canonTileX,
        z: canonTileZ,
        hasHeight: true,
    };

    if (existsSync(colorPath)) {
        return { entry, wasRendered: false };
    }

    // Crop sub-regions at tileSize dimensions
    const startX = dx * tileSize;
    const startZ = dz * tileSize;

    // Color tile
    const subColor = extractSubRegionRgba(colorBuffer, sourceWidth, startX, startZ, tileSize, tileSize);
    mkdirSync(path.dirname(colorPath), { recursive: true });
    await sharp(subColor, { raw: { width: tileSize, height: tileSize, channels: 4 } })
        .png({ compressionLevel: 9, effort: 10, palette: false })
        .toFile(colorPath);

    // Meta sidecar — crop same region from heightmap half
    const subMeta = extractSubRegionRgba(heightBuffer, sourceWidth, startX, startZ, tileSize, tileSize);
    await writeMetaTile(subMeta, tileSize, tileSize, metaPath);

    // Emitters sidecar — decode blocklight + heights from meta region
    const subBlockLights = decodeBlockLight(subMeta, tileSize, tileSize);
    const subHeights = decodeHeightmap(subMeta, tileSize, tileSize);
    writeEmittersBin(subBlockLights, subHeights, tileSize, tileSize, emittersPath);

    return { entry, wasRendered: true };
}

/**
 * Split a source tile into canonical tiles at native resolution (1 block = 1 pixel).
 *
 * For Dynmap (512px source → 2×2 split → 256px canonical):
 * each quadrant becomes one canonical tile.
 *
 * For BlueMap dual-layer tiles (501×1002), the top half holds colour pixels
 * and the bottom half holds heightmap metadata. Colour is written as-is;
 * metadata is re-encoded as `_meta.png` + `_emitters.bin` sidecars.
 *
 * @returns Rendered tile entries with counts of new and skipped tiles
 */
async function splitSourceTile(options: SplitOptions): Promise<SplitResult> {
    const { source, canonLevel, splitFactor, tileSize, pyramid, isDualLayer } = options;
    const entries: CanonicalEntry[] = [];
    let rendered = 0;
    let skipped = 0;
    const zoom = levelToZoom(canonLevel, pyramid);

    const sourceImage = sharp(source.sourcePath);

    // -------------------------------------------------------------------
    // Dual-layer path (BlueMap)
    // -------------------------------------------------------------------
    if (isDualLayer) {
        const meta = await sourceImage.metadata();
        const sourceWidth = meta.width;
        const colorHeight = Math.floor(meta.height / 2);

        const fullRaw = await sourceImage.clone()
            .ensureAlpha()
            .raw()
            .toBuffer();

        const rowBytes = sourceWidth * 4;
        const colorBuffer = Buffer.from(fullRaw.subarray(0, colorHeight * rowBytes));
        const heightBuffer = fullRaw.subarray(colorHeight * rowBytes, colorHeight * 2 * rowBytes);

        for (let dx = 0; dx < splitFactor; dx++) {
            for (let dz = 0; dz < splitFactor; dz++) {
                const { entry, wasRendered } = await renderDualLayerSubTile(
                    dx, dz, source, splitFactor, canonLevel, tileSize,
                    sourceWidth, colorBuffer, heightBuffer, pyramid,
                );
                entries.push(entry);
                rendered += wasRendered ? 1 : 0;
                skipped += wasRendered ? 0 : 1;
            }
        }

        return { entries, rendered, skipped };
    }

    // -------------------------------------------------------------------
    // Standard path (Dynmap): crop → write PNG
    // -------------------------------------------------------------------
    for (let dx = 0; dx < splitFactor; dx++) {
        for (let dz = 0; dz < splitFactor; dz++) {
            const canonTileX = source.tileX * splitFactor + dx;
            const canonTileZ = source.tileZ * splitFactor + dz;
            const outputPath = path.join(
                TILES_DIR, source.world,
                String(zoom), String(canonTileX),
                `${canonTileZ}.png`,
            );

            const entry: CanonicalEntry = {
                zoom,
                world: source.world,
                x: canonTileX,
                z: canonTileZ,
                hasHeight: false,
            };

            if (existsSync(outputPath)) {
                entries.push(entry);
                skipped++;
                continue;
            }

            mkdirSync(path.dirname(outputPath), { recursive: true });

            await sourceImage.clone()
                .extract({
                    left: dx * tileSize,
                    top: dz * tileSize,
                    width: tileSize,
                    height: tileSize,
                })
                .png({ compressionLevel: 9, effort: 10, palette: false })
                .toFile(outputPath);

            entries.push(entry);
            rendered++;
        }
    }

    return { entries, rendered, skipped };
}

// ============================================================================
// Source tile dimensions
// ============================================================================

/**
 * Probe the first source tile to determine whether the set is dual-layer.
 *
 * @returns Source image dimensions and dual-layer flag, or undefined if empty
 */
async function getSourceInfo(
    tiles: SourceTile[],
): Promise<{ isDualLayer: boolean; sourceWidth: number; effectiveHeight: number } | undefined> {
    if (tiles.length === 0) { return undefined; }

    const firstTile = tiles[0];
    if (!firstTile) { return undefined; }
    const { width, height } = await sharp(firstTile.sourcePath).metadata();
    if (!width || !height) { return undefined; }
    const dualLayer = isDualLayerTile(width, height);
    return {
        isDualLayer: dualLayer,
        sourceWidth: width,
        effectiveHeight: dualLayer ? Math.floor(height / 2) : height,
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
}

/**
 * Process all source tiles at a given level for one world.
 *
 * @returns Rendered tile entries with counts of new and skipped tiles
 */
async function processSourceLevel(options: LevelProcessOptions): Promise<SplitResult> {
    const { world, levelId, canonLevel, splitFactor, pyramid, label } = options;
    let tiles = findSourceTilesInWorld(world, levelId);

    if (tiles.length === 0) {
        return { entries: [], rendered: 0, skipped: 0 };
    }

    // Filter tiles to renderBounds when configured
    const bounds = pyramid.renderBounds;
    if (bounds) {
        const sourceBpt = pyramidBlocksPerTile(canonLevel, pyramid) * splitFactor;
        const before = tiles.length;
        tiles = tiles.filter(t => {
            const blockMinX = t.tileX * sourceBpt;
            const blockMaxX = blockMinX + sourceBpt;
            const blockMinZ = t.tileZ * sourceBpt;
            const blockMaxZ = blockMinZ + sourceBpt;
            return blockMaxX > bounds.minX && blockMinX < bounds.maxX
                && blockMaxZ > bounds.minZ && blockMinZ < bounds.maxZ;
        });
        if (tiles.length < before) {
            console.log(`  renderBounds filter: ${before} → ${tiles.length} tiles`);
        }
    }

    const info = await getSourceInfo(tiles);
    if (!info) {
        return { entries: [], rendered: 0, skipped: 0 };
    }

    const tileSize = pyramid.baseBlocksPerTile;
    const zoom = levelToZoom(canonLevel, pyramid);
    const dualLabel = info.isDualLayer ? ' [dual-layer]' : '';
    console.log(`\n[${world}] ${tiles.length} source ${label} tiles → zoom ${zoom} (${tileSize}×${tileSize}px)${dualLabel}`);

    const entries: CanonicalEntry[] = [];
    let rendered = 0;
    let skipped = 0;

    for (const tile of tiles) {
        try {
            const result = await splitSourceTile({
                canonLevel,
                splitFactor,
                tileSize,
                pyramid,
                source: tile,
                isDualLayer: info.isDualLayer,
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

/**
 * Canonical-first render pass for sources whose tile size is not an integer
 * multiple of the canonical tile size (e.g. BlueMap 500px → canonical 256px).
 *
 * Inverts the usual "split source" approach: for each canonical tile, we
 * compute which source tile(s) overlap its block range and stitch the pixels
 * directly — no resampling.
 *
 * @param world - Normalised world name
 * @param levelId - Provider-level ID to load from tiles-src
 * @param canonLevel - Canonical pyramid level to render into
 * @param sourceBpt - Source tile side in blocks (e.g. 500 for BlueMap LOD-1)
 * @param pyramid - Canonical pyramid config
 * @returns Rendered tile entries with counts of new and skipped tiles
 */
async function processSourceLevelCanonical(
    world: string,
    levelId: number,
    canonLevel: number,
    sourceBpt: number,
    pyramid: TilePyramidConfig,
): Promise<SplitResult> {
    const { buffers, isDualLayer } = await loadSourceBufferMap(world, levelId);

    if (buffers.size === 0) {
        return { entries: [], rendered: 0, skipped: 0 };
    }

    const tileSize = pyramid.baseBlocksPerTile;
    const zoom = levelToZoom(canonLevel, pyramid);

    // Derive the set of canonical tile coordinates covered by loaded source tiles
    const canonCoords = new Set<string>();
    for (const key of buffers.keys()) {
        const slash = key.indexOf('/');
        const sx = Number.parseInt(key.slice(0, slash), 10);
        const sz = Number.parseInt(key.slice(slash + 1), 10);

        const srcBlockMinX = sx * sourceBpt;
        const srcBlockMaxX = srcBlockMinX + sourceBpt;
        const srcBlockMinZ = sz * sourceBpt;
        const srcBlockMaxZ = srcBlockMinZ + sourceBpt;

        const cxMin = Math.floor(srcBlockMinX / tileSize);
        const cxMax = Math.floor((srcBlockMaxX - 1) / tileSize);
        const czMin = Math.floor(srcBlockMinZ / tileSize);
        const czMax = Math.floor((srcBlockMaxZ - 1) / tileSize);

        for (let cx = cxMin; cx <= cxMax; cx++) {
            for (let cz = czMin; cz <= czMax; cz++) {
                canonCoords.add(`${cx}/${cz}`);
            }
        }
    }

    // Apply renderBounds filter
    const bounds = pyramid.renderBounds;
    const filteredCoords: Array<{ cx: number; cz: number }> = [];
    for (const key of canonCoords) {
        const slash = key.indexOf('/');
        const cx = Number.parseInt(key.slice(0, slash), 10);
        const cz = Number.parseInt(key.slice(slash + 1), 10);
        if (bounds) {
            const blockMinX = cx * tileSize;
            const blockMaxX = blockMinX + tileSize;
            const blockMinZ = cz * tileSize;
            const blockMaxZ = blockMinZ + tileSize;
            if (blockMaxX <= bounds.minX || blockMinX >= bounds.maxX
                || blockMaxZ <= bounds.minZ || blockMinZ >= bounds.maxZ) {
                continue;
            }
        }
        filteredCoords.push({ cx, cz });
    }

    console.log(`\n[${world}] ${buffers.size} source tiles → ${filteredCoords.length} canonical zoom ${zoom} tiles (${tileSize}×${tileSize}px, stitch mode)${isDualLayer ? ' [dual-layer]' : ''}`);

    const entries: CanonicalEntry[] = [];
    let rendered = 0;
    let skipped = 0;

    for (const { cx, cz } of filteredCoords) {
        const basePath = path.join(TILES_DIR, world, String(zoom), String(cx), String(cz));
        const colorPath = `${basePath}.png`;
        const entry: CanonicalEntry = { world, zoom, x: cx, z: cz, hasHeight: isDualLayer };

        if (existsSync(colorPath)) {
            entries.push(entry);
            skipped++;
            continue;
        }

        // Stitch color
        const colorBuf = stitchCanonicalBuffer(cx, cz, tileSize, sourceBpt, buffers, 'color');
        if (!colorBuf) {
            // No source data — skip this canonical tile entirely
            continue;
        }

        mkdirSync(path.dirname(colorPath), { recursive: true });
        await sharp(colorBuf, { raw: { width: tileSize, height: tileSize, channels: 4 } })
            .png({ compressionLevel: 9, effort: 10, palette: false })
            .toFile(colorPath);

        if (isDualLayer) {
            const heightBuf = stitchCanonicalBuffer(cx, cz, tileSize, sourceBpt, buffers, 'height');
            if (heightBuf) {
                const metaPath = `${basePath}_meta.png`;
                await writeMetaTile(heightBuf, tileSize, tileSize, metaPath);

                const blockLights = decodeBlockLight(heightBuf, tileSize, tileSize);
                const heights = decodeHeightmap(heightBuf, tileSize, tileSize);
                writeEmittersBin(blockLights, heights, tileSize, tileSize, `${basePath}_emitters.bin`);
            }
        }

        entries.push(entry);
        rendered++;
    }

    return { entries, rendered, skipped };
}

// ============================================================================
// Intermediate Tile Derivation (cascade downsampling)
// ============================================================================

/**
 * Build sharp composites for one intermediate-tile mosaic group.
 * Reads each available detail tile from disk and places it at the
 * correct grid position. Missing tiles leave that cell transparent.
 *
 * @returns Array of overlay options ready for sharp.composite()
 */
async function buildMosaicComposites(
    groupEntries: CanonicalEntry[],
    world: string,
    sourceZoom: number,
    scale: number,
    tileSize: number,
): Promise<sharp.OverlayOptions[]> {
    const composites: sharp.OverlayOptions[] = [];
    for (const entry of groupEntries) {
        const localX = ((entry.x % scale) + scale) % scale;
        const localZ = ((entry.z % scale) + scale) % scale;
        const tilePath = path.join(
            TILES_DIR, world,
            String(sourceZoom), String(entry.x),
            `${entry.z}.png`,
        );
        if (existsSync(tilePath)) {
            const meta = await sharp(tilePath).metadata();
            if (meta.width === tileSize && meta.height === tileSize) {
                composites.push({
                    input: tilePath,
                    left: localX * tileSize,
                    top: localZ * tileSize,
                });
            } else {
                console.warn(
                    `  [WARN] Skipping stale tile ${tilePath}`
                    + ` (${meta.width}×${meta.height} ≠ ${tileSize}×${tileSize})`,
                );
            }
        }
    }
    return composites;
}

/**
 * Derive intermediate-level tiles by downsampling a scaleFactor×scaleFactor
 * grid of already-rendered tiles from the level above.
 *
 * For each group of source tiles sharing a parent, the function:
 * 1. Reads the source PNGs from disk
 * 2. Places each into a mosaic at the correct grid position
 * 3. Lanczos-resizes the mosaic to tileSize × tileSize
 * 4. Writes the result as a new tile
 *
 * Tiles already on disk are skipped (cache-friendly).
 *
 * @returns Rendered tile entries with counts of new and skipped tiles
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
    const tileSize = pyramid.baseBlocksPerTile;
    const targetZoom = levelToZoom(targetLevel, pyramid);
    const sourceZoom = levelToZoom(sourceLevel, pyramid);

    // Group source entries by parent tile at the coarser level
    const groups = new Map<string, CanonicalEntry[]>();
    for (const entry of sourceEntries) {
        if (entry.world !== world) { continue; }
        const parentX = Math.floor(entry.x / scale);
        const parentZ = Math.floor(entry.z / scale);
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

    const mosaicSize = tileSize * scale;
    const entries: CanonicalEntry[] = [];
    let rendered = 0;
    let skipped = 0;

    console.log(`\n[${world}] Deriving ${groups.size} zoom ${targetZoom} tiles from ${sourceEntries.length} zoom ${sourceZoom} tiles (${scale}×${scale} → 1)`);

    for (const [groupKey, groupEntries] of groups) {
        const slashPos = groupKey.indexOf('/');
        const parentX = Number.parseInt(groupKey.slice(0, slashPos), 10);
        const parentZ = Number.parseInt(groupKey.slice(slashPos + 1), 10);

        const outputPath = path.join(
            TILES_DIR, world,
            String(targetZoom), String(parentX),
            `${parentZ}.png`,
        );

        // Cascade tiles don't produce _meta.png / _emitters.bin sidecars,
        // so hasHeight is always false at derived (coarser) zoom levels.
        const entry: CanonicalEntry = {
            world,
            hasHeight: false,
            zoom: targetZoom,
            x: parentX,
            z: parentZ,
        };

        if (existsSync(outputPath)) {
            entries.push(entry);
            skipped++;
        } else {
            const composites = await buildMosaicComposites(
                groupEntries, world, sourceZoom, scale, tileSize,
            );
            if (composites.length > 0) {
                mkdirSync(path.dirname(outputPath), { recursive: true });

                // Two-pass: composite into mosaic, then downsample.
                // Buffering prevents alpha bleed across transparent gaps.
                const mosaicBuffer = await sharp({
                    create: {
                        width: mosaicSize,
                        height: mosaicSize,
                        channels: 4,
                        background: { r: 0, g: 0, b: 0, alpha: 0 },
                    },
                }).composite(composites).raw().ensureAlpha().toBuffer();

                await sharp(mosaicBuffer, {
                    raw: { width: mosaicSize, height: mosaicSize, channels: 4 },
                })
                    .resize(tileSize, tileSize, { kernel: 'lanczos3' })
                    .flatten({ background: { r: 0, g: 0, b: 0 } })
                    .png({ compressionLevel: 9, effort: 10, palette: false })
                    .toFile(outputPath);

                entries.push(entry);
                rendered++;
            }
        }
    }

    return { entries, rendered, skipped };
}

// ============================================================================
// Border Extension Pass
// ============================================================================

/**
 * Create a bordered version of a tile PNG by compositing border pixels from
 * up to 8 neighbor tiles. Reads only from the ORIGINAL (unbordred) files on
 * disk — always call before the batch-rename step.
 *
 * @param entry - Canonical tile coordinates
 * @param suffix - File suffix ('.png' for color, '_meta.png' for meta)
 * @param tileSize - Inner tile content dimension
 * @param border - Number of overlap pixels per side
 * @param outputPath - Where to write the bordered PNG
 */
async function createBorderedTile(
    entry: CanonicalEntry,
    suffix: string,
    tileSize: number,
    border: number,
    outputPath: string,
): Promise<void> {
    const centerPath = tileFilePath(entry.world, entry.zoom, entry.x, entry.z, suffix);
    if (!existsSync(centerPath)) { return; }

    const fullSize = tileSize + 2 * border;

    // Skip tiles that are already bordered (e.g. restored from cache)
    const centerMeta = await sharp(centerPath).metadata();
    if (centerMeta.width === fullSize && centerMeta.height === fullSize) { return; }

    const centerBuf = await sharp(centerPath).ensureAlpha().raw().toBuffer();
    const composites: sharp.OverlayOptions[] = [{
        input: centerBuf,
        raw: { width: tileSize, height: tileSize, channels: 4 },
        left: border,
        top: border,
    }];

    const s = tileSize;
    const b = border;

    /** Extract a rectangle from a neighbor tile and queue it for compositing. */
    const addNeighbor = async (
        dx: number, dz: number,
        sourceLeft: number, sourceTop: number, sourceW: number, sourceH: number,
        destinationLeft: number, destinationTop: number,
    ): Promise<void> => {
        const neighborPath = tileFilePath(entry.world, entry.zoom, entry.x + dx, entry.z + dz, suffix);
        if (!existsSync(neighborPath)) { return; }

        // If the neighbor is already bordered (from cache), offset extraction
        // into the inner content region to get the correct pixels.
        const neighborMeta = await sharp(neighborPath).metadata();
        const alreadyBordered = neighborMeta.width === fullSize && neighborMeta.height === fullSize;
        const offsetLeft = alreadyBordered ? border : 0;
        const offsetTop = alreadyBordered ? border : 0;

        const buf = await sharp(neighborPath)
            .extract({ left: sourceLeft + offsetLeft, top: sourceTop + offsetTop, width: sourceW, height: sourceH })
            .ensureAlpha()
            .raw()
            .toBuffer();
        composites.push({
            input: buf,
            raw: { width: sourceW, height: sourceH, channels: 4 },
            left: destinationLeft,
            top: destinationTop,
        });
    };

    // 4 edges
    await addNeighbor(-1,  0, s - b, 0, b, s, 0,     b);
    await addNeighbor( 1,  0, 0,     0, b, s, b + s, b);
    await addNeighbor( 0, -1, 0, s - b, s, b, b,     0);
    await addNeighbor( 0,  1, 0,     0, s, b, b,     b + s);

    // 4 corners
    await addNeighbor(-1, -1, s - b, s - b, b, b, 0,     0);
    await addNeighbor( 1, -1, 0,     s - b, b, b, b + s, 0);
    await addNeighbor(-1,  1, s - b, 0,     b, b, 0,     b + s);
    await addNeighbor( 1,  1, 0,     0,     b, b, b + s, b + s);

    await sharp({
        create: {
            width: fullSize,
            height: fullSize,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
    })
        .composite(composites)
        .png({ compressionLevel: 9, effort: 10, palette: false })
        .toFile(outputPath);
}

/**
 * Add border overlap to all rendered tiles.
 *
 * Writes bordered versions to temp files first, then batch-renames to avoid
 * reading already-bordered neighbors during the compositing pass.
 *
 * For dual-layer tiles, also borders _meta.png and rewrites _emitters.bin
 * with coordinates in the bordered pixel space.
 *
 * @param entries - All canonical tile entries to border
 * @param tileSize - Inner tile content dimension
 * @param border - Number of overlap pixels per side
 */
async function addBordersToAllTiles(
    entries: CanonicalEntry[],
    tileSize: number,
    border: number,
): Promise<void> {
    if (border <= 0) { return; }

    console.log(`\nAdding ${border}px borders to ${entries.length} tiles...`);

    const pendingRenames: [string, string][] = [];

    for (const entry of entries) {
        // Color tile
        const colorPath = tileFilePath(entry.world, entry.zoom, entry.x, entry.z);
        const colorTemporary = `${colorPath}.tmp`;
        await createBorderedTile(entry, '.png', tileSize, border, colorTemporary);
        if (existsSync(colorTemporary)) {
            pendingRenames.push([colorTemporary, colorPath]);
        }

        // Meta sidecar (detail dual-layer tiles only)
        if (entry.hasHeight) {
            const metaPath = tileFilePath(entry.world, entry.zoom, entry.x, entry.z, '_meta.png');
            const metaTemporary = `${metaPath}.tmp`;
            await createBorderedTile(entry, '_meta.png', tileSize, border, metaTemporary);
            if (existsSync(metaTemporary)) {
                pendingRenames.push([metaTemporary, metaPath]);
            }
        }
    }

    // Batch rename: swap bordered temp files into place
    for (const [temporaryPath, finalPath] of pendingRenames) {
        renameSync(temporaryPath, finalPath);
    }

    // Re-extract emitters from bordered meta tiles
    const fullSize = tileSize + 2 * border;
    let emittersRewritten = 0;
    for (const entry of entries) {
        if (entry.hasHeight) {
            const metaPath = tileFilePath(entry.world, entry.zoom, entry.x, entry.z, '_meta.png');
            if (existsSync(metaPath)) {
                const metaBuf = await sharp(metaPath).ensureAlpha().raw().toBuffer();
                // R was scaled ×17 during writeMetaTile — normalise to 0-1 for emitter detection
                const blockLights = Float32Array.from(
                    { length: fullSize * fullSize },
                    (_, i) => (metaBuf[i * 4] ?? 0) / 255,
                );
                const heights = decodeHeightmap(metaBuf, fullSize, fullSize);
                const emittersPath = tileFilePath(entry.world, entry.zoom, entry.x, entry.z, '_emitters.bin');
                writeEmittersBin(blockLights, heights, fullSize, fullSize, emittersPath);
                emittersRewritten++;
            }
        }
    }

    console.log(`  Bordered ${pendingRenames.length} files, rewrote ${emittersRewritten} emitter files`);
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
    console.log('=== Canonical Tile Renderer ===');
    console.log(`Timestamp: ${new Date().toISOString()}`);

    const config = loadConfig();
    const pyramid = config.tilePyramid;
    const provider = createTileProviderFromConfig(config);
    const tileSize = pyramid.baseBlocksPerTile;

    console.log(`\nSource provider: ${provider.name}`);
    console.log(`  Detail: ${provider.detailLevel.label} (${provider.detailLevel.blocksPerTile} blocks/tile)`);

    console.log('\nCanonical pyramid:');
    console.log(`  Tile size: ${tileSize}×${tileSize}px`);
    console.log(`  Levels: ${pyramid.levels} (zoom 0 to ${levelToZoom(0, pyramid)})`);
    console.log(`  Border: ${pyramid.border}px`);

    // Validate split factor — non-integer triggers canonical-first stitch mode
    const canonDetailBpt = pyramidBlocksPerTile(detailLevel(pyramid), pyramid);
    const detailSplit = provider.detailLevel.blocksPerTile / canonDetailBpt;
    const useStitchMode = !Number.isInteger(detailSplit);

    if (useStitchMode) {
        console.log(`\nStitch mode: source ${provider.detailLevel.blocksPerTile}px / canonical ${canonDetailBpt}px (non-integer ratio ${detailSplit.toFixed(4)})`);
    } else {
        console.log(`\nSplit factor: ${detailSplit}×${detailSplit}`);
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
        const detail = useStitchMode
            ? await processSourceLevelCanonical(
                world,
                provider.detailLevel.id,
                detailLevel(pyramid),
                provider.detailLevel.blocksPerTile,
                pyramid,
            )
            : await processSourceLevel({
                levelId: provider.detailLevel.id,
                canonLevel: detailLevel(pyramid),
                splitFactor: detailSplit,
                label: 'detail',
                world,
                pyramid,
            });
        allEntries.push(...detail.entries);
        totalRendered += detail.rendered;
        totalSkipped += detail.skipped;

        // Cascade downsampling: each level derived from the one above
        let currentEntries = detail.entries;
        for (let sourceLevel = detailLevel(pyramid); sourceLevel > 0; sourceLevel--) {
            const derived = await deriveIntermediateTiles(world, currentEntries, sourceLevel, pyramid);
            allEntries.push(...derived.entries);
            totalRendered += derived.rendered;
            totalSkipped += derived.skipped;
            currentEntries = derived.entries;
        }
    }

    // Deduplicate entries
    const entryMap = new Map<string, CanonicalEntry>();
    for (const entry of allEntries) {
        entryMap.set(`${entry.world}/${entry.zoom}/${entry.x}/${entry.z}`, entry);
    }

    // Add borders (reads unbordred tiles, writes temp files, batch renames)
    await addBordersToAllTiles([...entryMap.values()], tileSize, pyramid.border);

    // Prune entries whose file no longer exists on disk
    const uniqueEntries = [...entryMap.values()].filter(entry => {
        const filePath = path.join(
            TILES_DIR, entry.world,
            String(entry.zoom), String(entry.x),
            `${entry.z}.png`,
        );
        return existsSync(filePath);
    });

    // Write manifest per pvc-tiles-api.md
    const manifest: ManifestJson = {
        tileSize,
        border: pyramid.border,
        tiles: uniqueEntries,
    };
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));

    console.log('\n=== Render Summary ===');
    console.log(`Rendered: ${totalRendered}`);
    console.log(`Skipped (cached): ${totalSkipped}`);
    console.log(`Manifest: ${uniqueEntries.length} tiles (tileSize=${tileSize}, border=${pyramid.border})`);
    console.log('\n=== Complete ===');
}

main().catch((error: unknown) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
