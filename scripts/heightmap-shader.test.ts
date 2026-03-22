import { describe, expect, it } from 'vitest';

import {
    applyShadeToColor,
    computeLambertianShade,
    computeShadeMap,
    computeSlopeShade,
    decodeHeightmap,
    DEFAULT_LIGHTING,
    extractSubHeights,
    isDualLayerTile,
    type LightingConfig,
    normalizeVec3,
    quantizeHeightmap} from './heightmap-shader.js';

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
// normalizeVec3
// ============================================================================

describe('normalizeVec3', () => {
    it('normalizes a unit-length vector unchanged', () => {
        const [x, y, z] = normalizeVec3([1, 0, 0]);
        expect(x).toBeCloseTo(1);
        expect(y).toBeCloseTo(0);
        expect(z).toBeCloseTo(0);
    });

    it('normalizes a non-unit vector', () => {
        const [x, y, z] = normalizeVec3([3, 4, 0]);
        expect(x).toBeCloseTo(0.6);
        expect(y).toBeCloseTo(0.8);
        expect(z).toBeCloseTo(0);
    });

    it('returns up vector for zero-length input', () => {
        const [x, y, z] = normalizeVec3([0, 0, 0]);
        expect(x).toBe(0);
        expect(y).toBe(1);
        expect(z).toBe(0);
    });

    it('handles negative components', () => {
        const [x, y, z] = normalizeVec3([-1, -1, -1]);
        const length = Math.hypot(x, y, z);
        expect(length).toBeCloseTo(1);
    });
});

// ============================================================================
// decodeHeightmap
// ============================================================================

describe('decodeHeightmap', () => {
    it('decodes height from G and B channels', () => {
        // height = 100 → G=0, B=100
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
        // unsigned = 65535 → signed = -(65535 - 65535) = 0? No...
        // unsigned = 65000 → signed = -(65535 - 65000) = -535
        // G = floor(65000/256) = 253, B = 65000 - 253*256 = 65000 - 64768 = 232
        const buf = rgba([[0, 253, 232, 255]]);
        const heights = decodeHeightmap(buf, 1, 1);
        expect(heights[0]).toBe(-535);
    });

    it('treats height 32767 as positive', () => {
        // G = floor(32767/256) = 127, B = 32767 - 127*256 = 32767 - 32512 = 255
        const buf = rgba([[0, 127, 255, 255]]);
        const heights = decodeHeightmap(buf, 1, 1);
        expect(heights[0]).toBe(32_767);
    });

    it('treats height 32768 as negative', () => {
        // unsigned = 32768 → signed = -(65535 - 32768) = -32767
        // G = floor(32768/256) = 128, B = 0
        const buf = rgba([[0, 128, 0, 255]]);
        const heights = decodeHeightmap(buf, 1, 1);
        expect(heights[0]).toBe(-32_767);
    });

    it('decodes multiple pixels', () => {
        const buf = rgba([
            [0, 0, 10, 255],
            [0, 0, 20, 255],
            [0, 0, 30, 255],
            [0, 0, 40, 255]
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
// computeSlopeShade
// ============================================================================

describe('computeSlopeShade', () => {
    const config: LightingConfig = { ...DEFAULT_LIGHTING, model: 'slope' };

    it('returns 1.0 for flat terrain', () => {
        // 3×3 flat heightmap at height 64
        const heights = new Float32Array(9).fill(64);
        const shade = computeSlopeShade(heights, 3, 3, config);
        for (const s of shade) {
            expect(s).toBeCloseTo(1);
        }
    });

    it('darkens westward slopes (right neighbor higher)', () => {
        // Center pixel: height 64, right neighbor: height 80
        // shade = (64-80 + 64-64) * 0.06 = -0.96 → clamped to -0.2 → intensity = 0.8
        const heights = new Float32Array([64, 64, 64, 64, 64, 80, 64, 64, 64]);
        const shade = computeSlopeShade(heights, 3, 3, config);
        // Center pixel (1,1)
        expect(shade[4]).toBeLessThan(1);
    });

    it('clamps shade within [-0.2, 0.04]', () => {
        // Very steep slope
        const heights = new Float32Array([0, 0, 0, 0, 0, 200, 0, 200, 0]);
        const shade = computeSlopeShade(heights, 3, 3, config);
        for (const s of shade) {
            expect(s).toBeGreaterThanOrEqual(0.8); // 1.0 - 0.2
            expect(s).toBeLessThanOrEqual(1.04); // 1.0 + 0.04
        }
    });

    it('applies heightScale', () => {
        const scaledConfig: LightingConfig = { ...config, heightScale: 2 };
        // Small height differences to stay within clamp range
        const heights = new Float32Array([64, 64, 64, 64, 64, 65, 64, 64, 64]);
        const unscaled = computeSlopeShade(heights, 3, 3, config);
        const scaled = computeSlopeShade(heights, 3, 3, scaledConfig);
        // With more height exaggeration, shade should differ more from 1.0
        expect(Math.abs(scaled[4] - 1)).toBeGreaterThan(Math.abs(unscaled[4] - 1));
    });
});

// ============================================================================
// computeLambertianShade
// ============================================================================

describe('computeLambertianShade', () => {
    const config: LightingConfig = { ...DEFAULT_LIGHTING, model: 'lambertian' };

    it('returns ambient + diffuse for flat terrain (sun from above)', () => {
        // Flat terrain → normal is straight up [0,1,0]
        // sun [0.3,1.0,-0.3] → normalized ≈ [0.27, 0.91, -0.27]
        // dot(normal, sun) ≈ 0.91
        // I = 0.35 + 0.65 * 0.91 ≈ 0.94
        const heights = new Float32Array(9).fill(64);
        const shade = computeLambertianShade(heights, 3, 3, config);
        expect(shade[4]).toBeCloseTo(0.35 + 0.65 * normalizeVec3(config.sunDirection)[1], 1);
    });

    it('returns at least ambient intensity for back-lit faces', () => {
        // Sun from below (impossible normal case) — dot will be negative
        const downConfig: LightingConfig = {
            ...config,
            sunDirection: [0, -1, 0]
        };
        const heights = new Float32Array(9).fill(64);
        const shade = computeLambertianShade(heights, 3, 3, downConfig);
        // Flat terrain with sun below → dot = -1 → max(0, -1) = 0 → I = ambient only
        expect(shade[4]).toBeCloseTo(config.ambientIntensity);
    });

    it('handles edge pixels without crashing', () => {
        // 2×2 — all edge pixels
        const heights = new Float32Array([10, 20, 30, 40]);
        const shade = computeLambertianShade(heights, 2, 2, config);
        expect(shade.length).toBe(4);
        for (const s of shade) {
            expect(s).toBeGreaterThan(0);
            expect(s).toBeLessThanOrEqual(1);
        }
    });

    it('brightens sun-facing slopes', () => {
        // Sun from the right (+x), slope faces right
        const rightSunConfig: LightingConfig = {
            ...config,
            sunDirection: [1, 0.5, 0],
            ambientIntensity: 0.3,
            diffuseIntensity: 0.7
        };
        // Row of increasing height: sun-facing slope
        const heights = new Float32Array([
            10, 20, 30,
            10, 20, 30,
            10, 20, 30
        ]);
        const shade = computeLambertianShade(heights, 3, 3, rightSunConfig);
        // Center pixel faces the sun; shade should be > ambient
        expect(shade[4]).toBeGreaterThan(rightSunConfig.ambientIntensity);
    });
});

// ============================================================================
// computeShadeMap (dispatcher)
// ============================================================================

describe('computeShadeMap', () => {
    it('dispatches to slope model', () => {
        const heights = new Float32Array(9).fill(64);
        const config: LightingConfig = { ...DEFAULT_LIGHTING, model: 'slope' };
        const shade = computeShadeMap(heights, 3, 3, config);
        expect(shade[4]).toBeCloseTo(1);
    });

    it('dispatches to lambertian model', () => {
        const heights = new Float32Array(9).fill(64);
        const config: LightingConfig = { ...DEFAULT_LIGHTING, model: 'lambertian' };
        const shade = computeShadeMap(heights, 3, 3, config);
        expect(shade[4]).toBeCloseTo(0.35 + 0.65 * normalizeVec3(config.sunDirection)[1], 1);
    });
});

// ============================================================================
// applyShadeToColor
// ============================================================================

describe('applyShadeToColor', () => {
    it('multiplies RGB by shade and preserves alpha', () => {
        const color = rgba([[200, 100, 50, 255]]);
        const shade = new Float32Array([0.5]);
        applyShadeToColor(color, shade);
        expect(color[0]).toBe(100); // 200 * 0.5
        expect(color[1]).toBe(50);  // 100 * 0.5
        expect(color[2]).toBe(25);  // 50 * 0.5
        expect(color[3]).toBe(255); // alpha preserved
    });

    it('clamps to 255 on overflow', () => {
        const color = rgba([[250, 250, 250, 255]]);
        const shade = new Float32Array([1.5]);
        applyShadeToColor(color, shade);
        expect(color[0]).toBe(255);
        expect(color[1]).toBe(255);
        expect(color[2]).toBe(255);
    });

    it('clamps to 0 on underflow', () => {
        const color = rgba([[200, 100, 50, 255]]);
        const shade = new Float32Array([0]);
        applyShadeToColor(color, shade);
        expect(color[0]).toBe(0);
        expect(color[1]).toBe(0);
        expect(color[2]).toBe(0);
    });

    it('handles multiple pixels', () => {
        const color = rgba([
            [100, 100, 100, 255],
            [200, 200, 200, 255]
        ]);
        const shade = new Float32Array([0.5, 0.8]);
        applyShadeToColor(color, shade);
        expect(color[0]).toBe(50);   // 100 * 0.5
        expect(color[4]).toBe(160);  // 200 * 0.8
    });
});

// ============================================================================
// extractSubHeights
// ============================================================================

describe('extractSubHeights', () => {
    it('extracts a sub-region from a heightmap', () => {
        // 4×4 heightmap
        const heights = new Float32Array([
            1, 2, 3, 4,
            5, 6, 7, 8,
            9, 10, 11, 12,
            13, 14, 15, 16
        ]);
        // Extract 2×2 from (1,1)
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
// quantizeHeightmap
// ============================================================================

describe('quantizeHeightmap', () => {
    it('maps height range to 0–255', () => {
        const heights = new Float32Array([0, 50, 100]);
        const result = quantizeHeightmap(heights, 3, 1);
        expect(result.data[0]).toBe(0);
        expect(result.data[1]).toBe(128); // 50/100 * 255 ≈ 128
        expect(result.data[2]).toBe(255);
        expect(result.min).toBe(0);
        expect(result.max).toBe(100);
    });

    it('fills 128 for flat terrain', () => {
        const heights = new Float32Array([64, 64, 64, 64]);
        const result = quantizeHeightmap(heights, 2, 2);
        for (const v of result.data) {
            expect(v).toBe(128);
        }
        expect(result.min).toBe(64);
        expect(result.max).toBe(64);
    });

    it('handles negative heights', () => {
        const heights = new Float32Array([-50, 0, 50]);
        const result = quantizeHeightmap(heights, 3, 1);
        expect(result.data[0]).toBe(0);   // min → 0
        expect(result.data[2]).toBe(255); // max → 255
        expect(result.min).toBe(-50);
        expect(result.max).toBe(50);
    });

    it('rounds min/max to integers', () => {
        const heights = new Float32Array([10.3, 20.7]);
        const result = quantizeHeightmap(heights, 2, 1);
        expect(result.min).toBe(10);
        expect(result.max).toBe(21);
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
