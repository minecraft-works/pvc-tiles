#!/usr/bin/env npx tsx
/**
 * Tile Validation Script
 *
 * Validates tile integrity after render-tiles.ts runs:
 * 1. Every manifest entry has a corresponding .png file on disk
 * 2. Entries with hasHeight have _meta.png and _emitters.bin sidecars
 * 3. Shops have expected tiles (warning only, not failure)
 *
 * Reads config.json to determine the active tile provider.
 *
 * Exit codes:
 * - 0: All validations passed (shop coverage warnings are OK)
 * - 1: Manifest/file integrity errors (hard failure)
 *
 * @example
 * npx tsx scripts/validate-tiles.ts
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { createTileProviderFromConfig } from '../src/config.js';
import {
    getTileNeighborhood,
    parseLocation,
} from '../src/tile-coords.js';
import {
    blocksPerTile as pyramidBlocksPerTile,
    detailLevel,
    levelToZoom,
} from '../src/tile-pyramid.js';
import { type AppConfig, AppConfigSchema, DEFAULT_CONFIG, resolveRawConfig } from '../src/types.js';

// ============================================================================
// Configuration
// ============================================================================

const TILES_DIR = 'public/tiles';
const MANIFEST_PATH = path.join(TILES_DIR, 'manifest.json');
const DATA_PATH = 'public/data.json';

function loadConfig(): AppConfig {
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
// Manifest Types (matching pvc-tiles-api.md)
// ============================================================================

const ManifestEntrySchema = z.object({
    world: z.string(),
    zoom: z.number(),
    x: z.number(),
    z: z.number(),
    hasHeight: z.boolean(),
});

const ManifestJsonSchema = z.object({
    tileSize: z.number(),
    border: z.number(),
    tiles: z.array(ManifestEntrySchema),
});

type ManifestEntry = z.infer<typeof ManifestEntrySchema>;
type ManifestJson = z.infer<typeof ManifestJsonSchema>;

interface ShopData {
    shopName: string;
    location: string;
    world: string;
}

// ============================================================================
// Path Helpers
// ============================================================================

/**
 * Build tile path from manifest entry: {world}/{zoom}/{x}/{z}.png
 *
 * @returns Relative tile colour path
 */
function entryToColorPath(entry: ManifestEntry): string {
    return `${entry.world}/${entry.zoom}/${entry.x}/${entry.z}.png`;
}

function entryToMetaPath(entry: ManifestEntry): string {
    return `${entry.world}/${entry.zoom}/${entry.x}/${entry.z}_meta.png`;
}

function entryToEmittersPath(entry: ManifestEntry): string {
    return `${entry.world}/${entry.zoom}/${entry.x}/${entry.z}_emitters.bin`;
}

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
// File Scanning
// ============================================================================

/**
 * Recursively scan for .png and .bin files under the tiles directory.
 *
 * @returns Array of relative file paths
 */
function scanTileFiles(dir: string, baseDir: string = dir): string[] {
    const files: string[] = [];
    if (!existsSync(dir)) { return files; }

    for (const entry of readdirSync(dir)) {
        const fullPath = path.join(dir, entry);
        const stat = statSync(fullPath);

        if (stat.isDirectory()) {
            files.push(...scanTileFiles(fullPath, baseDir));
        } else if (entry.endsWith('.png') || entry.endsWith('.bin')) {
            files.push(path.relative(baseDir, fullPath).replaceAll('\\', '/'));
        }
    }

    return files;
}

// ============================================================================
// Validation Logic
// ============================================================================

function validateManifestIntegrity(manifest: ManifestJson): {
    missingColorFiles: string[];
    missingMetaFiles: string[];
    missingEmitterFiles: string[];
} {
    const missingColorFiles: string[] = [];
    const missingMetaFiles: string[] = [];
    const missingEmitterFiles: string[] = [];

    for (const entry of manifest.tiles) {
        const colorPath = path.join(TILES_DIR, entryToColorPath(entry));
        if (!existsSync(colorPath)) {
            missingColorFiles.push(entryToColorPath(entry));
        }

        if (entry.hasHeight) {
            const metaPath = path.join(TILES_DIR, entryToMetaPath(entry));
            if (!existsSync(metaPath)) {
                missingMetaFiles.push(entryToMetaPath(entry));
            }
            const emittersPath = path.join(TILES_DIR, entryToEmittersPath(entry));
            if (!existsSync(emittersPath)) {
                missingEmitterFiles.push(entryToEmittersPath(entry));
            }
        }
    }

    return { missingColorFiles, missingMetaFiles, missingEmitterFiles };
}

function validateShopCoverage(
    shops: ShopData[],
    manifest: ManifestJson,
    detailBlocksPerTile: number,
    detailZoom: number,
): { shop: string; world: string; location: string; missingTiles: string[] }[] {
    // Build lookup of detail-zoom tiles
    const tileKeys = new Set<string>();
    for (const entry of manifest.tiles) {
        if (entry.zoom === detailZoom) {
            tileKeys.add(`${entry.world}/${entry.x}/${entry.z}`);
        }
    }

    const shopsMissingTiles: { shop: string; world: string; location: string; missingTiles: string[] }[] = [];

    for (const shop of shops) {
        const coords = parseLocation(shop.location);
        const world = normalizeWorld(shop.world);

        const tileX = Math.floor(coords.x / detailBlocksPerTile);
        const tileZ = Math.floor(coords.z / detailBlocksPerTile);
        const neighborhood = getTileNeighborhood(tileX, tileZ);

        const missingTiles: string[] = [];
        for (const tile of neighborhood) {
            if (!tileKeys.has(`${world}/${tile.tileX}/${tile.tileZ}`)) {
                missingTiles.push(`${tile.tileX},${tile.tileZ}`);
            }
        }

        if (missingTiles.length > 0) {
            shopsMissingTiles.push({
                shop: shop.shopName,
                location: shop.location,
                world,
                missingTiles,
            });
        }
    }

    return shopsMissingTiles;
}

// ============================================================================
// Main
// ============================================================================

function main(): void {
    console.log('=== Tile Validation ===\n');

    const config = loadConfig();
    const pyramid = config.tilePyramid;
    const provider = createTileProviderFromConfig(config);
    const detailBpt = pyramidBlocksPerTile(detailLevel(pyramid), pyramid);
    const detailZoom = levelToZoom(detailLevel(pyramid), pyramid);

    console.log(`Tile provider: ${provider.name}`);
    console.log(`Detail zoom: ${detailZoom} (${detailBpt} blocks/tile)`);

    if (!existsSync(TILES_DIR)) {
        console.error(`Error: Tiles directory not found: ${TILES_DIR}`);
        process.exit(1);
    }

    if (!existsSync(MANIFEST_PATH)) {
        console.error(`Error: Manifest not found: ${MANIFEST_PATH}`);
        process.exit(1);
    }

    // Load manifest (new format: { tileSize, border, tiles: [...] })
    const rawManifest: unknown = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    const parsed = ManifestJsonSchema.safeParse(rawManifest);
    if (!parsed.success) {
        console.error('Error: Invalid manifest format:', parsed.error.message);
        process.exit(1);
    }
    const manifest = parsed.data;
    console.log(`Manifest: ${manifest.tiles.length} tiles (tileSize=${manifest.tileSize}, border=${manifest.border})`);

    // Scan tile files on disk
    const tileFilesArray = scanTileFiles(TILES_DIR);
    console.log(`Files on disk: ${tileFilesArray.length}`);

    // Validate manifest ↔ file integrity
    console.log('\n--- Manifest Integrity ---');
    const { missingColorFiles, missingMetaFiles, missingEmitterFiles } = validateManifestIntegrity(manifest);

    let hasErrors = false;

    if (missingColorFiles.length > 0) {
        console.error(`\nERROR: ${missingColorFiles.length} manifest entries have no color tile:`);
        for (const file of missingColorFiles.slice(0, 10)) {
            console.error(`  - ${file}`);
        }
        if (missingColorFiles.length > 10) {
            console.error(`  ... and ${missingColorFiles.length - 10} more`);
        }
        hasErrors = true;
    } else {
        console.log('All manifest entries have corresponding color tiles.');
    }

    if (missingMetaFiles.length > 0) {
        console.warn(`\nWARNING: ${missingMetaFiles.length} hasHeight entries missing _meta.png:`);
        for (const file of missingMetaFiles.slice(0, 10)) {
            console.warn(`  - ${file}`);
        }
        if (missingMetaFiles.length > 10) {
            console.warn(`  ... and ${missingMetaFiles.length - 10} more`);
        }
    }

    if (missingEmitterFiles.length > 0) {
        console.warn(`\nWARNING: ${missingEmitterFiles.length} hasHeight entries missing _emitters.bin:`);
        for (const file of missingEmitterFiles.slice(0, 10)) {
            console.warn(`  - ${file}`);
        }
        if (missingEmitterFiles.length > 10) {
            console.warn(`  ... and ${missingEmitterFiles.length - 10} more`);
        }
    }

    const heightEntries = manifest.tiles.filter(entry => entry.hasHeight).length;
    if (heightEntries > 0 && missingMetaFiles.length === 0 && missingEmitterFiles.length === 0) {
        console.log(`All ${heightEntries} hasHeight entries have _meta.png and _emitters.bin.`);
    }

    // Validate shop coverage (warnings only)
    if (existsSync(DATA_PATH)) {
        console.log('\n--- Shop Coverage ---');
        const shopData = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
        const shops: ShopData[] = shopData.data || [];
        console.log(`Shops in data.json: ${shops.length}`);

        const shopsMissingTiles = validateShopCoverage(shops, manifest, detailBpt, detailZoom);

        if (shopsMissingTiles.length > 0) {
            console.warn(`\nWARNING: ${shopsMissingTiles.length} shops have incomplete tile coverage:`);

            const sorted = [...shopsMissingTiles].toSorted((a, b) => b.missingTiles.length - a.missingTiles.length);

            for (const { shop, world, location, missingTiles } of sorted.slice(0, 20)) {
                console.warn(`  - ${shop} (${world} @ ${location}): missing ${missingTiles.length}/25 tiles`);
            }
            if (sorted.length > 20) {
                console.warn(`  ... and ${sorted.length - 20} more shops`);
            }
        } else {
            console.log('All shops have complete tile coverage.');
        }
    } else {
        console.log(`\nSkipping shop coverage check (${DATA_PATH} not found)`);
    }

    // Exit
    console.log('\n=== Validation Complete ===');
    if (hasErrors) {
        console.error('\nFailed: Manifest/file integrity errors found.');
        process.exit(1);
    } else {
        console.log('\nPassed: All integrity checks OK.');
        process.exit(0);
    }
}

main();
