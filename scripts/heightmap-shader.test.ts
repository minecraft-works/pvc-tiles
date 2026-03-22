import { describe, expect, it } from 'vitest';

import {
    decodeBlockLight,
    decodeHeightmap,
    extractSubHeights,
    extractSubRegionRgba,
    isDualLayerTile,
} from './heightmap-shader.js';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build an RGBA buffer from [R, G, B, A] tuples.
 *
 * @param pixels - Array of [R, G, B, A] quadruples
 * @returns Buffer with packed RGBA pixel data
 */
function rgba(pixels: [number, number, number, number][]): Buffer {
    const buf = Buffer.alloc(pixels.length * 4);
    for (const [i, [r, g, b, a]] of pixels.entries()) {
        buf[i * 4] = r;
        buf[i * 4 + 1] = g;
        buf[i * 4 + 2] = b;
        buf[i * 4 + 3] = a;
    }
    return buf;
}

// ============================================================================
// decodeHeightmap
// ============================================================================

describe('decodeHeightmap', () => {
    it('decodes height from G and B channels', () => {
        const buf = rgba([[0, 0, 100, 255]]);
        const heights = decodeHeightmap(buf, 1, 1);
        expect(heights[0]).toBe(100);
    });

    it('decodes high byte from G channel', () => {
        // height = 300 → G=1 (256), B=44 (300-256)
        const buf = rgba([[0, 1, 44, 255]]);
        const heights = decodeHeightmap(buf, 1, 1);
        expect(heights[0]).toBe(300);
    });

    it('decodes negative heights via signed encoding', () => {
        // unsigned = 65000 → signed = -(65535 - 65000) = -535
        // G = floor(65000/256) = 253, B = 65000 - 253*256 = 232
        const buf = rgba([[0, 253, 232, 255]]);
        const heights = decodeHeightmap(buf, 1, 1);
        expect(heights[0]).toBe(-535);
    });

    it('treats height 32767 as positive', () => {
        // G = floor(32767/256) = 127, B = 255
        const buf = rgba([[0, 127, 255, 255]]);
        const heights = decodeHeightmap(buf, 1, 1);
        expect(heights[0]).toBe(32_767);
    });

    it('treats height 32768 as negative', () => {
        // unsigned = 32768 → signed = -(65535 - 32768) = -32767
        const buf = rgba([[0, 128, 0, 255]]);
        const heights = decodeHeightmap(buf, 1, 1);
        expect(heights[0]).toBe(-32_767);
    });

    it('decodes multiple pixels', () => {
        const buf = rgba([
            [0, 0, 10, 255],
            [0, 0, 20, 255],
            [0, 0, 30, 255],
            [0, 0, 40, 255],
        ]);
        const heights = decodeHeightmap(buf, 2, 2);
        expect([...heights]).toEqual([10, 20, 30, 40]);
    });

    it('ignores R channel (block light)', () => {
        const buf = rgba([[255, 0, 64, 255]]);
        const heights = decodeHeightmap(buf, 1, 1);
        expect(heights[0]).toBe(64);
    });
});

// ============================================================================
// decodeBlockLight
// ============================================================================

describe('decodeBlockLight', () => {
    it('normalises R channel to 0–1', () => {
        const buf = rgba([[15, 0, 0, 255]]);
        const lights = decodeBlockLight(buf, 1, 1);
        expect(lights[0]).toBe(1);
    });

    it('returns 0 for R=0', () => {
        const buf = rgba([[0, 0, 0, 255]]);
        const lights = decodeBlockLight(buf, 1, 1);
        expect(lights[0]).toBe(0);
    });

    it('decodes multiple pixels', () => {
        const buf = rgba([
            [0, 0, 0, 255],
            [15, 0, 0, 255],
        ]);
        const lights = decodeBlockLight(buf, 2, 1);
        expect(lights[0]).toBe(0);
        expect(lights[1]).toBe(1);
    });
});

// ============================================================================
// extractSubRegionRgba
// ============================================================================

describe('extractSubRegionRgba', () => {
    it('extracts a 2×2 sub-region from a 4×4 image', () => {
        // 4×4 RGBA image: each pixel's R = column*10 + row
        const pixels: [number, number, number, number][] = [];
        for (let z = 0; z < 4; z++) {
            for (let x = 0; x < 4; x++) {
                pixels.push([x * 10 + z, 0, 0, 255]);
            }
        }
        const buf = rgba(pixels);
        const sub = extractSubRegionRgba(buf, 4, 1, 1, 2, 2);
        // Should get pixels (1,1), (2,1), (1,2), (2,2)
        expect(sub[0]).toBe(11); // R of (1,1)
        expect(sub[4]).toBe(21); // R of (2,1)
        expect(sub[8]).toBe(12); // R of (1,2)
        expect(sub[12]).toBe(22); // R of (2,2)
    });

    it('handles full-size extraction', () => {
        const buf = rgba([[10, 20, 30, 40]]);
        const sub = extractSubRegionRgba(buf, 1, 0, 0, 1, 1);
        expect([...sub]).toEqual([10, 20, 30, 40]);
    });
});

// ============================================================================
// extractSubHeights
// ============================================================================

describe('extractSubHeights', () => {
    it('extracts a sub-region from a heightmap', () => {
        const heights = new Float32Array([
            1, 2, 3, 4,
            5, 6, 7, 8,
            9, 10, 11, 12,
            13, 14, 15, 16,
        ]);
        const sub = extractSubHeights(heights, 4, 1, 1, 2, 2);
        expect([...sub]).toEqual([6, 7, 10, 11]);
    });

    it('handles single-pixel extraction', () => {
        const heights = new Float32Array([10, 20, 30, 40]);
        const sub = extractSubHeights(heights, 2, 1, 0, 1, 1);
        expect([...sub]).toEqual([20]);
    });

    it('handles full-size extraction', () => {
        const heights = new Float32Array([1, 2, 3, 4]);
        const sub = extractSubHeights(heights, 2, 0, 0, 2, 2);
        expect([...sub]).toEqual([1, 2, 3, 4]);
    });
});

// ============================================================================
// isDualLayerTile
// ============================================================================

describe('isDualLayerTile', () => {
    it('detects BlueMap dual-layer (501×1002)', () => {
        expect(isDualLayerTile(501, 1002)).toBe(true);
    });

    it('rejects square dynmap tiles (512×512)', () => {
        expect(isDualLayerTile(512, 512)).toBe(false);
    });

    it('rejects near-square tiles (100×140)', () => {
        expect(isDualLayerTile(100, 140)).toBe(false);
    });

    it('detects any tile with height > 1.5× width', () => {
        expect(isDualLayerTile(100, 151)).toBe(true);
    });

    it('rejects exactly 1.5× height', () => {
        expect(isDualLayerTile(100, 150)).toBe(false);
    });
});
