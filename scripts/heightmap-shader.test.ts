import { describe, expect, it } from 'vitest';

import {
    decodeBlockLight,
    decodeHeightmap,
    downsampleMetaMax,
    encodeHeight,
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

// ============================================================================
// encodeHeight
// ============================================================================

describe('encodeHeight', () => {
    it('encodes positive height', () => {
        // height = 300 → G=1, B=44
        expect(encodeHeight(300)).toEqual([1, 44]);
    });

    it('encodes zero', () => {
        expect(encodeHeight(0)).toEqual([0, 0]);
    });

    it('encodes negative height', () => {
        // height = -535 → unsigned = 65535 + (-535) = 65000
        // G = floor(65000/256) = 253, B = 65000 - 253*256 = 232
        expect(encodeHeight(-535)).toEqual([253, 232]);
    });

    it('round-trips through decodeHeightmap', () => {
        for (const h of [0, 1, 100, 300, 32767, -1, -535, -32767]) {
            const [g, b] = encodeHeight(h);
            const buf = rgba([[0, g, b, 255]]);
            const decoded = decodeHeightmap(buf, 1, 1);
            expect(decoded[0]).toBe(h);
        }
    });
});

// ============================================================================
// downsampleMetaMax
// ============================================================================

describe('downsampleMetaMax', () => {
    it('picks max blocklight from a 2×2 cell', () => {
        // 2×2 meta image: R values are 10, 50, 30, 20; heights all 0
        const buf = rgba([
            [10, 0, 0, 255], [50, 0, 0, 255],
            [30, 0, 0, 255], [20, 0, 0, 255],
        ]);
        const result = downsampleMetaMax(buf, 2, 2, 2);
        // Should output 1×1 pixel with R = max(10,50,30,20) = 50
        expect(result[0]).toBe(50);
    });

    it('picks max height from a 2×2 cell', () => {
        // heights: 10, 20, 30, 5 → max = 30
        const [g10, b10] = encodeHeight(10);
        const [g20, b20] = encodeHeight(20);
        const [g30, b30] = encodeHeight(30);
        const [g5, b5] = encodeHeight(5);
        const buf = rgba([
            [0, g10, b10, 255], [0, g20, b20, 255],
            [0, g30, b30, 255], [0, g5, b5, 255],
        ]);
        const result = downsampleMetaMax(buf, 2, 2, 2);
        // Decode the output height
        const outG = result[1];
        const outB = result[2];
        const unsigned = outG * 256 + outB;
        expect(unsigned).toBe(30);
    });

    it('handles negative heights correctly', () => {
        // heights: -10, -5, -20, -1 → max = -1
        const [gN10, bN10] = encodeHeight(-10);
        const [gN5, bN5] = encodeHeight(-5);
        const [gN20, bN20] = encodeHeight(-20);
        const [gN1, bN1] = encodeHeight(-1);
        const buf = rgba([
            [0, gN10, bN10, 255], [0, gN5, bN5, 255],
            [0, gN20, bN20, 255], [0, gN1, bN1, 255],
        ]);
        const result = downsampleMetaMax(buf, 2, 2, 2);
        const outG = result[1];
        const outB = result[2];
        const outUnsigned = outG * 256 + outB;
        const outHeight = outUnsigned >= 32_768 ? -(65_535 - outUnsigned) : outUnsigned;
        expect(outHeight).toBe(-1);
    });

    it('handles mixed positive and negative heights', () => {
        // heights: -10, 50, -5, 20 → max = 50
        const [gN10, bN10] = encodeHeight(-10);
        const [g50, b50] = encodeHeight(50);
        const [gN5, bN5] = encodeHeight(-5);
        const [g20, b20] = encodeHeight(20);
        const buf = rgba([
            [0, gN10, bN10, 255], [0, g50, b50, 255],
            [0, gN5, bN5, 255],   [0, g20, b20, 255],
        ]);
        const result = downsampleMetaMax(buf, 2, 2, 2);
        const outG = result[1];
        const outB = result[2];
        const outUnsigned = outG * 256 + outB;
        expect(outUnsigned).toBe(50);
    });

    it('downsamples a 4×4 image with scale=4 to 1×1', () => {
        // 4×4 meta pixels, all height=0 except one at 100, all R=0 except one at 200
        const pixels: [number, number, number, number][] = [];
        for (let i = 0; i < 16; i++) {
            pixels.push([0, 0, 0, 255]);
        }
        // Set pixel (1,2) R=200
        pixels[2 * 4 + 1] = [200, 0, 0, 255];
        // Set pixel (3,0) height=100
        const [g100, b100] = encodeHeight(100);
        pixels[0 * 4 + 3] = [0, g100, b100, 255];

        const buf = rgba(pixels);
        const result = downsampleMetaMax(buf, 4, 4, 4);
        expect(result.length).toBe(4); // 1×1×4
        expect(result[0]).toBe(200); // max R
        const outHeight = result[1] * 256 + result[2];
        expect(outHeight).toBe(100); // max height
    });

    it('produces correct dimensions for non-square scale', () => {
        // 4×2 image with scale=2 → 2×1 output
        const buf = rgba([
            [10, 0, 0, 255], [20, 0, 0, 255], [30, 0, 0, 255], [40, 0, 0, 255],
            [5, 0, 0, 255],  [15, 0, 0, 255], [25, 0, 0, 255], [35, 0, 0, 255],
        ]);
        const result = downsampleMetaMax(buf, 4, 2, 2);
        // Should be 2×1 = 2 pixels = 8 bytes
        expect(result.length).toBe(8);
        // First pixel: max(10,20,5,15) = 20
        expect(result[0]).toBe(20);
        // Second pixel: max(30,40,25,35) = 40
        expect(result[4]).toBe(40);
    });

    it('sets alpha to 255', () => {
        const buf = rgba([[100, 0, 0, 0]]); // A=0 in source
        const result = downsampleMetaMax(buf, 1, 1, 1);
        expect(result[3]).toBe(255);
    });
});
