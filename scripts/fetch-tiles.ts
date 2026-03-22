import { existsSync,mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Page } from 'playwright';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

import { createTileProviderFromConfig } from '../src/config';
import type { TileProvider } from '../src/providers/tile-provider';
import { blocksPerTile as pyramidBlocksPerTile, detailLevel } from '../src/tile-pyramid';
import { type AppConfig, AppConfigSchema, DEFAULT_CONFIG, resolveRawConfig, type TilePyramidConfig } from '../src/types';
import {
    calculateRateLimitDelay,
    type FetchResult,
    getNormalizedWorld,
    getTilePath,
    type TileInfo,
    type TileUrlBuilder} from './tile-utils';

// Add stealth plugin to avoid Cloudflare detection
chromium.use(StealthPlugin());

/** Rate limiting / browser config (provider-independent) */
const FETCH_CONFIG = {
    homepageUrl: 'https://web.peacefulvanilla.club/',
    // Rate limiting to avoid DDoS
    delayBetweenTiles: 500, // ms between tile fetches
    batchSize: 10, // tiles per batch
    delayBetweenBatches: 2000 // ms between batches
} as const;

/**
 * Load config.json from disk and create the matching tile provider.
 *
 * @returns The tile provider, parsed config, and homepage URL for stealth browsing.
 */
function loadProviderFromConfig(): { provider: TileProvider; config: AppConfig; homepageUrl: string } {
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
    const provider = createTileProviderFromConfig(config);
    // Derive homepage from baseUrl (strip path after host)
    const homepageUrl = new URL(config.dynmap.baseUrl).origin + '/';
    return { provider, config, homepageUrl };
}

/**
 * Enumerate all detail-level tiles within the ROI bounding box.
 * Uses the canonical pyramid config to compute tile coordinates from block bounds.
 *
 * @param pyramid - Tile pyramid configuration with renderBounds
 * @param provider - Tile provider for detail level metadata
 * @param urlBuilder - Builds tile URLs from world/x/z coordinates
 * @returns Array of tile descriptors covering the ROI at detail level
 */
function getDetailTilesInRoi(
    pyramid: TilePyramidConfig,
    provider: TileProvider,
    urlBuilder: TileUrlBuilder,
): TileInfo[] {
    const bounds = pyramid.renderBounds;
    if (!bounds) {
        console.warn('No renderBounds configured — cannot determine ROI. Skipping detail tiles.');
        return [];
    }

    const level = detailLevel(pyramid);
    const bpt = pyramidBlocksPerTile(level, pyramid);
    const minTX = Math.floor(bounds.minX / bpt);
    const maxTX = Math.floor((bounds.maxX - 1) / bpt);
    const minTZ = Math.floor(bounds.minZ / bpt);
    const maxTZ = Math.floor((bounds.maxZ - 1) / bpt);

    const tiles: TileInfo[] = [];
    for (let tx = minTX; tx <= maxTX; tx++) {
        for (let tz = minTZ; tz <= maxTZ; tz++) {
            tiles.push({
                world: 'overworld',
                tileX: tx,
                tileZ: tz,
                blocksPerTile: provider.detailLevel.blocksPerTile,
                levelId: provider.detailLevel.id,
                url: urlBuilder('overworld', tx, tz),
                shops: [],
            });
        }
    }
    return tiles;
}

/**
 * Create a TileUrlBuilder from a provider for a specific detail level.
 *
 * @param provider - Tile provider used to resolve URLs
 * @param level - The detail level to build URLs for
 * @returns A function that maps (world, tileX, tileZ) to a tile URL
 */
function createUrlBuilder(provider: TileProvider, level: TileProvider['detailLevel']): TileUrlBuilder {
    return (world: string, tileX: number, tileZ: number) => {
        const normalizedWorld = getNormalizedWorld(world);
        return provider.getSourceTileUrl(normalizedWorld, level, tileX, tileZ);
    };
}

interface FetchTileResult extends FetchResult {
    error?: string;
}

/**
 * Fetch a single tile by navigating to it (like fetch-data.ts does).
 * Saves in pyramid structure: {world}/{levelId}/{x}/{y}.png
 *
 * @param page - Playwright page instance for navigation
 * @param tile - Tile descriptor with URL and coordinate metadata
 * @param outputDir - Root output directory for saved tiles
 * @returns Fetch result with success/cached status and optional error message
 */
async function fetchTile(page: Page, tile: TileInfo, outputDir: string): Promise<FetchTileResult> {
    const tilePath = getTilePath(tile.levelId, tile.tileX, tile.tileZ);
    const normalizedWorld = getNormalizedWorld(tile.world);
    
    const filepath = path.join(outputDir, normalizedWorld, tilePath);
    
    // Skip if already exists (from previous run)
    if (existsSync(filepath)) {
        console.log(`  [CACHED] ${normalizedWorld}/${tilePath}`);
        return { success: true, cached: true };
    }
    
    // Create directory structure
    mkdirSync(path.dirname(filepath), { recursive: true });
    
    // Log the exact URL being fetched
    console.log(`  [FETCH] ${tile.url}`);
    
    try {
        // Navigate to the tile URL (same approach as fetch-data.ts)
        const response = await page.goto(tile.url, { 
            waitUntil: 'load', 
            timeout: 30_000 
        });
        
        if (!response) {
            console.log(`  [FAIL] ${normalizedWorld}/${tilePath}: No response`);
            return { success: false, cached: false, error: 'No response' };
        }
        
        const status = response.status();
        if (status !== 200) {
            console.log(`  [FAIL] ${normalizedWorld}/${tilePath}: HTTP ${status}`);
            return { success: false, cached: false, error: `HTTP ${status}` };
        }
        
        const contentType = response.headers()['content-type'] || '';
        if (!contentType.includes('image')) {
            console.log(`  [FAIL] ${normalizedWorld}/${tilePath}: Not an image (${contentType})`);
            return { success: false, cached: false, error: `Not an image: ${contentType}` };
        }
        
        // Get the raw body as buffer
        const buffer = await response.body();
        writeFileSync(filepath, buffer);
        console.log(`  [OK] ${normalizedWorld}/${tilePath} (${buffer.length} bytes)`);
        return { success: true, cached: false };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`  [ERROR] ${normalizedWorld}/${tilePath}: ${message}`);
        return { success: false, cached: false, error: message };
    }
}

/**
 * Sleep utility.
 *
 * @param ms - Duration to sleep in milliseconds
 * @returns Promise that resolves after the specified delay
 */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    console.log('=== Tile Fetcher ===');
    console.log(`Timestamp: ${new Date().toISOString()}`);
    
    // Load config and create provider
    const { provider, config, homepageUrl } = loadProviderFromConfig();
    const pyramid = config.tilePyramid;
    console.log(`Tile provider: ${provider.name}`);
    console.log(`Detail level: ${provider.detailLevel.label} (${provider.detailLevel.blocksPerTile} blocks/tile)`);
    
    // Create URL builder for detail level
    const detailUrlBuilder = createUrlBuilder(provider, provider.detailLevel);
    
    // Get all detail tiles within the ROI
    const tiles = getDetailTilesInRoi(pyramid, provider, detailUrlBuilder);
    const bounds = pyramid.renderBounds;
    if (bounds) {
        console.log(`\nROI: ${bounds.minX},${bounds.minZ} → ${bounds.maxX},${bounds.maxZ}`);
    }
    console.log(`Detail tiles to fetch: ${tiles.length}`);
    
    // Group by world and level for summary
    const byWorldLevel: Record<string, Record<string, number>> = {};
    for (const tile of tiles) {
        if (!byWorldLevel[tile.world]) {
            byWorldLevel[tile.world] = {};
        }
        const levelKey = `level-${tile.levelId}`;
        byWorldLevel[tile.world][levelKey] = (byWorldLevel[tile.world][levelKey] || 0) + 1;
    }
    console.log('By world/level:', JSON.stringify(byWorldLevel, null, 2));
    
    // Output directory — source tiles only; render-tiles.ts converts these to canonical public/tiles
    const outputDir = 'public/tiles-src';
    mkdirSync(outputDir, { recursive: true });
    
    // Track successfully fetched tiles for manifest (written after fetch loop)
    const successfulTiles: TileInfo[] = [];
    
    // Launch browser
    console.log('\nLaunching browser...');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    });
    const page = await context.newPage();
    
    // Visit homepage first to get cookies
    console.log('Visiting homepage for cookies...');
    await page.goto(homepageUrl, { waitUntil: 'networkidle', timeout: 60_000 });
    await sleep(3000);
    
    // Sanity check: fetch a known tile to verify tile server is accessible
    console.log('\n--- Sanity check: fetching center tile ---');
    const testUrl = provider.getSourceTileUrl('overworld', provider.detailLevel, 0, 0);
    console.log(`Testing: ${testUrl}`);
    
    try {
        const testResponse = await page.goto(testUrl, { waitUntil: 'load', timeout: 30_000 });
        const testStatus = testResponse?.status();
        const testContentType = testResponse?.headers()['content-type'] || '';
        
        if (testStatus !== 200) {
            console.error(`\nSanity check FAILED: HTTP ${testStatus}`);
            console.error('The tile server may be down or blocking requests.');
            await browser.close();
            process.exit(1);
        }
        
        if (!testContentType.includes('image')) {
            console.error(`\nSanity check FAILED: Expected image, got ${testContentType}`);
            console.error('The tile server may be returning an error page.');
            await browser.close();
            process.exit(1);
        }
        
        const testBuffer = await testResponse.body();
        console.log(`Sanity check PASSED: Got ${testBuffer.length} bytes of image data`);
    } catch (error) {
        console.error(`\nSanity check FAILED: ${error.message}`);
        console.error('Cannot connect to tile server. Aborting tile fetch.');
        await browser.close();
        process.exit(1);
    }
    
    // Fetch tiles in batches with rate limiting
    let downloaded = 0;
    let cached = 0;
    let failed = 0;
    const rateLimitState = { fetchedInBatch: 0 };
    const rateLimitConfig = {
        batchSize: FETCH_CONFIG.batchSize,
        delayBetweenTiles: FETCH_CONFIG.delayBetweenTiles,
        delayBetweenBatches: FETCH_CONFIG.delayBetweenBatches
    };

    console.log(`\nFetching ${tiles.length} tiles...`);
    console.log(`Rate limit: ${FETCH_CONFIG.delayBetweenTiles}ms between fetches, ${FETCH_CONFIG.delayBetweenBatches}ms between batches of ${FETCH_CONFIG.batchSize}`);

    for (let i = 0; i < tiles.length; i++) {
        const tile = tiles[i];
        const result = await fetchTile(page, tile, outputDir);

        // Update counters and track successful tiles
        if (result.success) {
            successfulTiles.push(tile);
            if (result.cached) {
                cached++;
            } else {
                downloaded++;
            }
        } else {
            failed++;
        }

        // Calculate rate limit delay using tested utility
        const hasMoreTiles = i < tiles.length - 1;
        const rateLimit = calculateRateLimitDelay(result, rateLimitState, rateLimitConfig, hasMoreTiles);
        
        if (rateLimit.batchComplete) {
            console.log(`\n  Batch complete. Waiting ${rateLimit.delay}ms...`);
        }
        
        if (rateLimit.delay > 0) {
            await sleep(rateLimit.delay);
        }
    }

    await browser.close();

    console.log('\n=== Fetch Summary ===');
    console.log(`Downloaded: ${downloaded}`);
    console.log(`Cached: ${cached}`);
    console.log(`Failed: ${failed}`);
    console.log(`Total: ${tiles.length}`);
    
    // Save tile manifest AFTER fetching - only include successful tiles
    const manifest = successfulTiles.map(t => ({
        world: t.world,
        tileX: t.tileX,
        tileZ: t.tileZ,
        blocksPerTile: t.blocksPerTile,
        levelId: t.levelId,
        shopCount: t.shops.length
    }));
    writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(`\nSaved tile manifest with ${manifest.length} entries (${failed} failed tiles excluded)`);
    
    console.log('\n=== Complete ===');
    console.log(`Provider: ${provider.name}`);
    console.log(`Detail: ${provider.detailLevel.label} within ROI`);
}

main().catch((error: unknown) => {
    console.error('Fatal error:', error);
    process.exit(1);
});