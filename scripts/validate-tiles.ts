#!/usr/bin/env npx tsx
/**
 * Tile Validation Script
 * 
 * Validates tile integrity after fetch-tiles.ts runs:
 * 1. Every manifest entry has a corresponding file on disk
 * 2. Every tile file is listed in the manifest
 * 3. Shops have expected tiles (warning only, not failure)
 * 
 * Reads config.json to determine the active tile provider and its
 * detail/overview levels, replacing previously hardcoded Dynmap constants.
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

import { createTileProviderFromConfig } from '../src/config.js';
import {
    getTileNeighborhood,
    parseLocation} from '../src/tile-coords.js';
import {
    blocksPerTile as pyramidBlocksPerTile,
    detailLevel,
} from '../src/tile-pyramid.js';
import { type AppConfig, AppConfigSchema, DEFAULT_CONFIG, resolveRawConfig,type TilePyramidConfig } from '../src/types.js';

// ============================================================================
// Configuration
// ============================================================================

const TILES_DIR = 'public/tiles';
const MANIFEST_PATH = path.join(TILES_DIR, 'manifest.json');
const DATA_PATH = 'public/data.json';

/**
 * Load config.json from disk.
 *
 * @returns Parsed AppConfig or defaults if config.json is missing/invalid
 */
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

interface ManifestEntry {
    world: string;
    tileX: number;
    tileZ: number;
    blocksPerTile: number;
    levelId?: number;
    shopCount?: number;
}

interface ShopData {
    shopName: string;
    location: string;
    world: string;
}

// ============================================================================
// File Scanning
// ============================================================================

/**
 * Recursively scan a directory for tile files (color tiles + heightmap sidecar tiles).
 *
 * @param dir - Directory to scan
 * @param format - Tile image format extension (e.g. 'jpeg')
 * @param baseDir - Root directory for computing relative paths
 * @returns Array of relative file paths found
 */
function scanTileFiles(dir: string, format: string, baseDir: string = dir): string[] {
    const files: string[] = [];
    
    if (!existsSync(dir)) {
        return files;
    }
    
    const extension = `.${format}`;
    const heightmapExtension = '.height.png';
    for (const entry of readdirSync(dir)) {
        const fullPath = path.join(dir, entry);
        const stat = statSync(fullPath);
        
        if (stat.isDirectory()) {
            files.push(...scanTileFiles(fullPath, format, baseDir));
        } else if (entry.endsWith(extension) || entry.endsWith(heightmapExtension)) {
            // Normalize path separators to forward slashes (matching manifest format)
            const relativePath = path.relative(baseDir, fullPath).replaceAll('\\', '/');
            files.push(relativePath);
        }
    }
    
    return files;
}

/**
 * Parse a tile path like "overworld/2/0/0.png" into components.
 *
 * @param tilePath - Relative tile path to parse
 * @returns Parsed tile components, or undefined if the path doesn't match
 */
function parseTilePath(tilePath: string): { world: string; level: number; tileX: number; tileZ: number } | undefined {
    // Format: {world}/{level}/{x}/{z}.{format}
    const regex = /^(?<world>[^/]+)\/(?<level>\d+)\/(?<tileX>-?\d+)\/(?<tileZ>-?\d+)\.\w+$/;
    const match = regex.exec(tilePath);
    if (!match?.groups) {
        return undefined;
    }
    
    return {
        world: match.groups.world ?? '',
        level: Number.parseInt(match.groups.level ?? '0', 10),
        tileX: Number.parseInt(match.groups.tileX ?? '0', 10),
        tileZ: Number.parseInt(match.groups.tileZ ?? '0', 10),
    };
}

/**
 * Derive canonical pyramid level from blocksPerTile.
 *
 * @param blocksPerTile - Blocks per tile at the target level
 * @param pyramid - Tile pyramid configuration
 * @returns Canonical level index
 */
function getCanonicalLevel(blocksPerTile: number, pyramid: TilePyramidConfig): number {
    for (let level = 0; level < pyramid.levels; level++) {
        if (pyramidBlocksPerTile(level, pyramid) === blocksPerTile) {
            return level;
        }
    }
    // Fallback: detail level
    return detailLevel(pyramid);
}

/**
 * Convert manifest entry to canonical file path.
 *
 * @param entry - Manifest entry to convert
 * @param pyramid - Tile pyramid configuration
 * @returns Canonical file path string
 */
function manifestEntryToPath(entry: ManifestEntry, pyramid: TilePyramidConfig): string {
    const level = getCanonicalLevel(entry.blocksPerTile, pyramid);
    const normalizedWorld = normalizeWorld(entry.world);
    return `${normalizedWorld}/${level}/${entry.tileX}/${entry.tileZ}.${pyramid.format}`;
}

/**
 * Normalize world name to directory format.
 *
 * @param world - Raw world name from manifest or config
 * @returns Normalized directory name
 */
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
// Validation Logic
// ============================================================================

function validateManifestIntegrity(manifest: ManifestEntry[], tileFiles: Set<string>, pyramid: TilePyramidConfig): {
    missingFiles: string[];
    orphanedDetailFiles: string[];
    otherLevelFiles: number;
    missingHeightmapFiles: string[];
} {
    const manifestPaths = new Set(manifest.map(entry => manifestEntryToPath(entry, pyramid)));
    const canonDetailLevel = detailLevel(pyramid);
    
    const missingFiles: string[] = [];
    const orphanedDetailFiles: string[] = [];
    const missingHeightmapFiles: string[] = [];
    let otherLevelFiles = 0;
    
    // Check each manifest entry has a file
    for (const path of manifestPaths) {
        if (!tileFiles.has(path)) {
            missingFiles.push(path);
        }
    }

    // Check heightmap files for entries that declare heightmap metadata
    for (const entry of manifest) {
        if (entry.heightmap) {
            const level = getCanonicalLevel(entry.blocksPerTile, pyramid);
            const normalizedWorld = normalizeWorld(entry.world);
            const heightmapPath = `${normalizedWorld}/${level}/${entry.tileX}/${entry.tileZ}.height.png`;
            if (!tileFiles.has(heightmapPath)) {
                missingHeightmapFiles.push(heightmapPath);
            }
        }
    }
    
    // Check each file - only detail-level files should be in manifest
    for (const file of tileFiles) {
        const parsed = parseTilePath(file);
        if (!parsed) {continue;}
        
        if (parsed.level === canonDetailLevel) {
            if (!manifestPaths.has(file)) {
                orphanedDetailFiles.push(file);
            }
        } else {
            otherLevelFiles++;
        }
    }
    
    return { missingFiles, orphanedDetailFiles, otherLevelFiles, missingHeightmapFiles };
}

function validateShopCoverage(shops: ShopData[], manifest: ManifestEntry[], pyramid: TilePyramidConfig): {
    shop: string;
    world: string;
    location: string;
    missingTiles: string[];
}[] {
    const shopsMissingTiles: {
        shop: string;
        world: string;
        location: string;
        missingTiles: string[];
    }[] = [];
    
    const detailBlocksPerTile = pyramidBlocksPerTile(detailLevel(pyramid), pyramid);
    
    // Build a set of manifest keys for quick lookup
    const manifestKeys = new Set<string>();
    for (const entry of manifest) {
        const normalizedWorld = normalizeWorld(entry.world);
        const key = `${normalizedWorld}/${entry.blocksPerTile}/${entry.tileX}/${entry.tileZ}`;
        manifestKeys.add(key);
    }
    
    // Check each shop
    for (const shop of shops) {
        const coords = parseLocation(shop.location);
        const world = normalizeWorld(shop.world);
        
        // Get the tile containing this shop using provider's detail level
        const tileX = Math.floor(coords.x / detailBlocksPerTile);
        const tileZ = Math.floor(coords.z / detailBlocksPerTile);
        
        // Get 5×5 neighborhood
        const neighborhood = getTileNeighborhood(tileX, tileZ);
        
        const missingTiles: string[] = [];
        for (const tile of neighborhood) {
            const key = `${world}/${detailBlocksPerTile}/${tile.tileX}/${tile.tileZ}`;
            if (!manifestKeys.has(key)) {
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
    
    // Load config and pyramid
    const config = loadConfig();
    const pyramid = config.tilePyramid;
    const provider = createTileProviderFromConfig(config);
    console.log(`Tile provider: ${provider.name}`);
    console.log(`Detail level: ${provider.detailLevel.label} (canonical: ${pyramidBlocksPerTile(detailLevel(pyramid), pyramid)} blocks/tile)`);
    
    // Check paths exist
    if (!existsSync(TILES_DIR)) {
        console.error(`Error: Tiles directory not found: ${TILES_DIR}`);
        console.error('Run fetch-tiles.ts first.');
        process.exit(1);
    }
    
    if (!existsSync(MANIFEST_PATH)) {
        console.error(`Error: Manifest not found: ${MANIFEST_PATH}`);
        console.error('Run fetch-tiles.ts first.');
        process.exit(1);
    }
    
    // Load manifest
    const manifest: ManifestEntry[] = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    console.log(`Manifest entries: ${manifest.length}`);
    
    // Scan tile files
    const tileFilesArray = scanTileFiles(TILES_DIR, pyramid.format);
    const tileFiles = new Set(tileFilesArray);
    console.log(`Tile files on disk: ${tileFiles.size}`);
    
    // Validate manifest ↔ file integrity
    console.log('\n--- Manifest Integrity ---');
    const { missingFiles, orphanedDetailFiles, otherLevelFiles, missingHeightmapFiles } = validateManifestIntegrity(manifest, tileFiles, pyramid);
    
    let hasErrors = false;
    
    if (missingFiles.length > 0) {
        console.error(`\nERROR: ${missingFiles.length} manifest entries have no file:`);
        for (const file of missingFiles.slice(0, 10)) {
            console.error(`  - ${file}`);
        }
        if (missingFiles.length > 10) {
            console.error(`  ... and ${missingFiles.length - 10} more`);
        }
        hasErrors = true;
    } else {
        console.log('All manifest entries have corresponding files.');
    }

    if (missingHeightmapFiles.length > 0) {
        console.warn(`\nWARNING: ${missingHeightmapFiles.length} manifest entries with heightmap metadata have no .height.png file:`);
        for (const file of missingHeightmapFiles.slice(0, 10)) {
            console.warn(`  - ${file}`);
        }
        if (missingHeightmapFiles.length > 10) {
            console.warn(`  ... and ${missingHeightmapFiles.length - 10} more`);
        }
        // Heightmap files missing is a warning, not a hard error —
        // the color tile still works without the heightmap sidecar
    } else {
        const heightmapCount = manifest.filter(entry => entry.heightmap).length;
        if (heightmapCount > 0) {
            console.log(`All ${heightmapCount} heightmap tiles have corresponding files.`);
        }
    }
    
    if (orphanedDetailFiles.length > 0) {
        console.warn(`\nWARNING: ${orphanedDetailFiles.length} detail-level files not in manifest (orphaned from previous runs):`);
        for (const file of orphanedDetailFiles.slice(0, 10)) {
            console.warn(`  - ${file}`);
        }
        if (orphanedDetailFiles.length > 10) {
            console.warn(`  ... and ${orphanedDetailFiles.length - 10} more`);
        }
        // Orphan files are harmless - just cached tiles from shops that moved/were removed
    } else {
        console.log('All detail-level tile files are listed in manifest.');
    }
    
    if (otherLevelFiles > 0) {
        console.log(`(${otherLevelFiles} tiles at other levels are not tracked in manifest - expected)`);
    }
    
    // Validate shop coverage (warnings only)
    if (existsSync(DATA_PATH)) {
        console.log('\n--- Shop Coverage ---');
        const shopData = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
        const shops: ShopData[] = shopData.data || [];
        console.log(`Shops in data.json: ${shops.length}`);
        
        const shopsMissingTiles = validateShopCoverage(shops, manifest, pyramid);
        
        if (shopsMissingTiles.length > 0) {
            console.warn(`\nWARNING: ${shopsMissingTiles.length} shops have incomplete tile coverage:`);
            
            // Group by severity (more missing = more severe)
            const sorted = [...shopsMissingTiles].toSorted((a, b) => b.missingTiles.length - a.missingTiles.length);
            
            for (const { shop, world, location, missingTiles } of sorted.slice(0, 20)) {
                console.warn(`  - ${shop} (${world} @ ${location}): missing ${missingTiles.length}/25 tiles`);
            }
            if (sorted.length > 20) {
                console.warn(`  ... and ${sorted.length - 20} more shops`);
            }
            
            // Summary by world
            const byWorld = new Map<string, number>();
            for (const { world } of shopsMissingTiles) {
                byWorld.set(world, (byWorld.get(world) || 0) + 1);
            }
            console.warn('\n  By world:');
            for (const [world, count] of byWorld) {
                console.warn(`    ${world}: ${count} shops with missing tiles`);
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
