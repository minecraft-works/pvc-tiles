/**
 * Heightmap Shader Module
 *
 * Pure functions for decoding BlueMap heightmap data and computing
 * per-pixel lighting shade maps. No I/O or sharp dependency — all
 * functions operate on raw pixel buffers.
 *
 * BlueMap encodes heightmap metadata in the bottom half of its dual-layer
 * 501×1002 PNG tiles. Each pixel's RGBA channels encode:
 *   R = block light (0–15, as R×255)
 *   G = height high byte
 *   B = height low byte
 *   A = unused
 *
 * Height decoding: `height = G×256 + B` (unsigned; signed at 32768).
 *
 * @module scripts/heightmap-shader
 * @see docs/adr/014-heightmap-lighting.md
 */

import { FOLIAGE_REF_COLORS, GRASS_REF_COLORS, WATER_REF_COLORS } from './material-colors.gen.js';

// ============================================================================
// Types
// ============================================================================

/** Configuration for heightmap-based lighting */
export interface LightingConfig {
    /** Shading model: 'slope' (BlueMap-style) or 'lambertian' (normal-based) */
    readonly model: 'slope' | 'lambertian';
    /** Sun direction vector [x, y, z] (will be normalized internally) */
    readonly sunDirection: readonly [number, number, number];
    /** Ambient light intensity (0–1). Prevents pure-black shadows */
    readonly ambientIntensity: number;
    /** Diffuse light intensity (0–1) */
    readonly diffuseIntensity: number;
    /** Height exaggeration factor (1.0 = real height, 2.0 = double relief) */
    readonly heightScale: number;
    /**
     * Y component of the unnormalized surface normal used in Lambertian shading.
     * Controls how sensitive the lighting is to slope angle — higher values
     * flatten the response (subtler shading). Default 2 = current BlueMap-like
     * behaviour (1-block step ≈ 26° tilt). Set to ~20 for Minecraft top-down
     * pixel-art terrain where per-block variation should barely register.
     */
    readonly normalScale: number;
    /**
     * Additive brightness boost applied from the BlueMap block-light channel
     * (R channel of the heightmap, range 0–15 mapped to 0–1).
     * 0 = disabled, 0.2 = subtle warm glow from lit blocks (torches, lava).
     */
    readonly blockLightBoost: number;
    /**
     * Integer upscale factor applied before shading.
     * Heights are resampled using `heightUpsampleMode`; block-light is bilinear;
     * colors are nearest-neighbour (preserving pixel-art edges).
     * Shade is computed and applied at `shadingScale × tileSize` resolution,
     * and the output tile is emitted at that larger size.
     * 1 = no upscale (current behaviour), 2 = 2x (1000x1000 for BlueMap).
     */
    readonly shadingScale: number;
    /**
     * Heightmap shadow casting configuration.
     * Traces rays along the sun direction through the heightmap.
     * Pixels occluded by taller terrain receive only ambient light.
     */
    readonly shadowCasting: {
        /** Enable heightmap shadow casting */
        readonly enabled: boolean;
        /** Maximum ray march distance in pixels (higher = longer shadows, slower) */
        readonly maxDistance: number;
        /** Shadow intensity: 0 = no darkening, 1 = full shadow (ambient only) */
        readonly intensity: number;
    };
    /**
     * Screen-space ambient occlusion from heightmap.
     * Samples heights radially to darken concave areas (pits, ravines, room interiors).
     */
    readonly ambientOcclusion: {
        /** Enable ambient occlusion */
        readonly enabled: boolean;
        /** Number of radial samples (higher = smoother, slower) */
        readonly samples: number;
        /** Sample radius in pixels */
        readonly radius: number;
        /** AO strength multiplier (0-1) */
        readonly intensity: number;
    };
    /**
     * Unsharp mask applied after shading to recover texture detail.
     */
    readonly unsharpMask: {
        /** Enable unsharp mask post-processing */
        readonly enabled: boolean;
        /** Gaussian blur radius in pixels */
        readonly radius: number;
        /** Amount/strength of sharpening (0-2 typical) */
        readonly amount: number;
        /** Minimum brightness difference to sharpen (prevents noise amplification) */
        readonly threshold: number;
    };
    /**
     * Per-material shading based on color hue classification.
     * Water gets specular highlights, foliage gets brighter diffuse,
     * stone gets stronger AO, snow gets brightness boost, lava glows.
     */
    readonly materialShading: {
        /** Enable material-aware shading */
        readonly enabled: boolean;
        /** Specular intensity for water surfaces (0-1) */
        readonly waterSpecular: number;
        /** Diffuse brightness boost for foliage (0-1) */
        readonly foliageBrightness: number;
        /** Extra AO multiplier for stone surfaces (1 = normal, 2 = double) */
        readonly stoneAOMultiplier: number;
        /** Brightness boost for snow/ice surfaces (0-1) */
        readonly snowBrightness: number;
        /** Constant additive glow for lava surfaces (0-1) */
        readonly lavaGlow: number;
        /** AO multiplier for sand (< 1 = less crevice darkening, default 0.4) */
        readonly sandAOMultiplier: number;
    };
    /**
     * Normal estimation kernel size.
     * 3 = standard central differences (current), 5 = Sobel 5x5, 7 = Sobel 7x7.
     * Wider kernels smooth noise and produce more plausible large-scale normals.
     */
    readonly normalKernelSize: 3 | 5 | 7;
    /**
     * Upsampling mode for height values when `shadingScale > 1`.
     * `'nearest'` preserves sharp block-face edges and the blocky Minecraft
     * staircase appearance in the shaded normals.
     * `'bilinear'` blends height steps into smooth ramps, producing dome-shaped
     * normals that look muddy on flat canopies and stepped terrain.
     * Default: `'nearest'`.
     */
    readonly heightUpsampleMode: 'bilinear' | 'nearest';
}

/** Quantized heightmap output for 8-bit grayscale tile */
export interface QuantizedHeightmap {
    /** Quantized 8-bit pixel data (width × height bytes) */
    readonly data: Buffer;
    /** Minimum height in the original heightmap */
    readonly min: number;
    /** Maximum height in the original heightmap */
    readonly max: number;
}

// ============================================================================
// Default Lighting Config
// ============================================================================

/** Default lighting configuration (noon sun, Lambertian model) */
export const DEFAULT_LIGHTING: LightingConfig = {
    model: 'lambertian',
    sunDirection: [0.3, 1, -0.3],
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
    normalKernelSize: 3,
    heightUpsampleMode: 'nearest',
};

// ============================================================================
// Vector Utilities
// ============================================================================

/**
 * Normalize a 3-component vector to unit length.
 *
 * @param v - Input vector [x, y, z]
 * @returns Normalized vector with magnitude 1
 */
export function normalizeVec3(v: readonly [number, number, number]): [number, number, number] {
    const length = Math.hypot(v[0], v[1], v[2]);
    if (length === 0) { return [0, 1, 0]; }
    return [v[0] / length, v[1] / length, v[2] / length];
}

// ============================================================================
// Heightmap Decoding
// ============================================================================

/**
 * Decode BlueMap heightmap from raw RGBA pixel buffer.
 *
 * Each pixel encodes: R = block light, G = height high byte, B = height low byte.
 * Height is unsigned (G×256 + B); values ≥ 32768 are negative (signed encoding).
 *
 * @param rgba - Raw pixel data (4 bytes per pixel: R, G, B, A)
 * @param width - Image width in pixels
 * @param height - Image height in pixels
 * @returns Float32Array of decoded height values (width × height elements)
 */
export function decodeHeightmap(
    rgba: Buffer | Uint8Array,
    width: number,
    height: number
): Float32Array {
    const pixelCount = width * height;
    const heights = new Float32Array(pixelCount);

    for (let i = 0; i < pixelCount; i++) {
        const offset = i * 4;
        const g = rgba[offset + 1]; // height high byte
        const b = rgba[offset + 2]; // height low byte
        const unsigned = g * 256 + b;
        heights[i] = unsigned >= 32_768 ? -(65_535 - unsigned) : unsigned;
    }

    return heights;
}

// ============================================================================
// Shade Computation
// ============================================================================

/**
 * Compute per-pixel shade intensity from a heightmap using slope model.
 *
 * This matches BlueMap's original fragment shader formula:
 * `shade = clamp((h - hRight + h - hBelow) × 0.06, -0.2, 0.04)`
 *
 * The result is converted to an absolute intensity multiplier:
 * `intensity = 1.0 + shade` (range 0.8–1.04).
 *
 * @param heights - Decoded height values (from decodeHeightmap)
 * @param width - Heightmap width in pixels
 * @param height - Heightmap height in pixels
 * @param config - Lighting configuration
 * @returns Float32Array of intensity multipliers (width × height elements)
 */
export function computeSlopeShade(
    heights: Float32Array,
    width: number,
    height: number,
    config: LightingConfig
): Float32Array {
    const shade = new Float32Array(width * height);
    const scale = config.heightScale;

    for (let z = 0; z < height; z++) {
        for (let x = 0; x < width; x++) {
            const index = z * width + x;
            const h = heights[index] * scale;
            const hRight = heights[z * width + Math.min(width - 1, x + 1)] * scale;
            const hBelow = heights[Math.min(height - 1, z + 1) * width + x] * scale;

            const slopeShade = Math.max(-0.2, Math.min(0.04, (h - hRight + h - hBelow) * 0.06));
            shade[index] = 1 + slopeShade;
        }
    }

    return shade;
}

/**
 * Compute per-pixel shade intensity using Lambertian diffuse model.
 *
 * Derives a surface normal from the height gradient at each pixel using
 * central differences (kernel size 3) or wider Sobel kernels (5 or 7),
 * then computes `I = ambient + diffuse * max(0, n.l)`.
 *
 * Wider kernels smooth noise in the heightmap and produce more plausible
 * large-scale terrain normals, especially on gradual slopes.
 *
 * @param heights - Decoded height values (from decodeHeightmap)
 * @param width - Heightmap width in pixels
 * @param height - Heightmap height in pixels
 * @param config - Lighting configuration
 * @returns Float32Array of intensity multipliers (width * height elements)
 */
export function computeLambertianShade(
    heights: Float32Array,
    width: number,
    height: number,
    config: LightingConfig
): Float32Array {
    const shade = new Float32Array(width * height);
    const [lx, ly, lz] = normalizeVec3(config.sunDirection);
    const scale = config.heightScale;

    // Compute gradient using the selected kernel size
    const { gradX, gradZ } = computeHeightGradients(heights, width, height, scale, config.normalKernelSize);

    for (let z = 0; z < height; z++) {
        for (let x = 0; x < width; x++) {
            const index = z * width + x;

            const dx = gradX[index] ?? 0;
            const dz = gradZ[index] ?? 0;

            // Surface normal: n = normalize(-dx, normalScale, -dz)
            const nx = -dx;
            const ny = config.normalScale;
            const nz = -dz;
            const length = Math.hypot(nx, ny, nz);
            const nnx = nx / length;
            const nny = ny / length;
            const nnz = nz / length;

            // Lambertian: I = ambient + diffuse * max(0, n.l)
            const dot = nnx * lx + nny * ly + nnz * lz;
            shade[index] = config.ambientIntensity
                + config.diffuseIntensity * Math.max(0, dot);
        }
    }

    return shade;
}

// ============================================================================
// Height Gradient Computation (variable kernel size)
// ============================================================================

/**
 * Sample a height value from the heightmap, clamped to valid bounds.
 *
 * @param heights - Height array (width * height elements)
 * @param width - Width of the heightmap
 * @param height - Height of the heightmap
 * @param x - X coordinate (clamped if out of bounds)
 * @param z - Z coordinate (clamped if out of bounds)
 * @param scale - Height exaggeration factor
 * @returns Scaled height at (x, z)
 */
function sampleHeight(
    heights: Float32Array, width: number, height: number,
    x: number, z: number, scale: number,
): number {
    const cx = Math.max(0, Math.min(width - 1, x));
    const cz = Math.max(0, Math.min(height - 1, z));
    return heights[cz * width + cx] * scale;
}

/**
 * Convolve a separable gradient kernel at a single pixel.
 *
 * @param heights - Decoded height array
 * @param width - Width in pixels
 * @param height - Height in pixels
 * @param x - Pixel X coordinate
 * @param z - Pixel Z coordinate
 * @param scale - Height exaggeration factor
 * @param derivW - Derivative kernel weights
 * @param smoothW - Smoothing kernel weights
 * @param halfK - Half kernel size (kernel radius)
 * @returns Unnormalized gradient sums { gx, gz }
 */
function convolveGradientKernel(
    heights: Float32Array, width: number, height: number,
    x: number, z: number, scale: number,
    derivW: number[], smoothW: number[], halfK: number,
): { gx: number; gz: number } {
    let gx = 0;
    let gz = 0;
    for (let kz = -halfK; kz <= halfK; kz++) {
        for (let kx = -halfK; kx <= halfK; kx++) {
            const h = sampleHeight(heights, width, height, x + kx, z + kz, scale);
            gx += h * derivW[kx + halfK] * smoothW[kz + halfK];
            gz += h * smoothW[kx + halfK] * derivW[kz + halfK];
        }
    }
    return { gx, gz };
}

/**
 * Compute X and Z height gradients using the specified kernel size.
 *
 * - kernelSize 3: standard central differences (2-pixel span)
 * - kernelSize 5: Sobel 5x5 (Scharr-like weighted kernel)
 * - kernelSize 7: Sobel 7x7 (wider weighted kernel)
 *
 * Wider kernels smooth noise in the heightmap and produce more plausible
 * large-scale terrain normals, especially on gradual slopes.
 *
 * @param heights - Decoded height values
 * @param width - Heightmap width
 * @param height - Heightmap height
 * @param scale - Height exaggeration factor
 * @param kernelSize - Kernel size (3, 5, or 7)
 * @returns Object with gradX and gradZ Float32Arrays
 */
export function computeHeightGradients(
    heights: Float32Array,
    width: number,
    height: number,
    scale: number,
    kernelSize: 3 | 5 | 7,
): { gradX: Float32Array; gradZ: Float32Array } {
    const count = width * height;
    const gradX = new Float32Array(count);
    const gradZ = new Float32Array(count);

    if (kernelSize === 3) {
        // Central differences (existing behaviour)
        for (let z = 0; z < height; z++) {
            for (let x = 0; x < width; x++) {
                const index = z * width + x;
                gradX[index] = sampleHeight(heights, width, height, x + 1, z, scale)
                             - sampleHeight(heights, width, height, x - 1, z, scale);
                gradZ[index] = sampleHeight(heights, width, height, x, z + 1, scale)
                             - sampleHeight(heights, width, height, x, z - 1, scale);
            }
        }
        return { gradX, gradZ };
    }

    // Separable Sobel-like kernels for 5x5 and 7x7
    // 5x5 derivative weights (1D): [-1, -2, 0, 2, 1] / 8, smoothing: [1, 4, 6, 4, 1] / 16
    // 7x7 derivative weights (1D): [-1, -4, -5, 0, 5, 4, 1] / 30, smoothing: [1, 6, 15, 20, 15, 6, 1] / 64
    const derivWeights5 = [-1, -2, 0, 2, 1];
    const smoothWeights5 = [1, 4, 6, 4, 1];
    const derivNorm5 = 8;
    const smoothNorm5 = 16;
    const derivWeights7 = [-1, -4, -5, 0, 5, 4, 1];
    const smoothWeights7 = [1, 6, 15, 20, 15, 6, 1];
    const derivNorm7 = 30;
    const smoothNorm7 = 64;

    const derivW = kernelSize === 5 ? derivWeights5 : derivWeights7;
    const smoothW = kernelSize === 5 ? smoothWeights5 : smoothWeights7;
    const derivN = kernelSize === 5 ? derivNorm5 : derivNorm7;
    const smoothN = kernelSize === 5 ? smoothNorm5 : smoothNorm7;
    const halfK = Math.floor(kernelSize / 2);

    for (let z = 0; z < height; z++) {
        for (let x = 0; x < width; x++) {
            const index = z * width + x;
            const { gx, gz } = convolveGradientKernel(
                heights, width, height, x, z, scale,
                derivW, smoothW, halfK,
            );
            gradX[index] = gx / (derivN * smoothN);
            gradZ[index] = gz / (derivN * smoothN);
        }
    }

    return { gradX, gradZ };
}

// ============================================================================
// Heightmap Shadow Casting
// ============================================================================

/**
 * Compute per-pixel shadow map by ray marching through the heightmap
 * along the sun direction.
 *
 * For each pixel, a ray is traced horizontally in the XZ plane in the
 * direction of the sun. At each step, the ray's theoretical height
 * (extrapolated from the sun's elevation angle) is compared against
 * the actual heightmap value. If the terrain is taller than the ray,
 * the pixel is in shadow.
 *
 * @param heights - Decoded height values (width * height elements)
 * @param width - Heightmap width in pixels
 * @param height - Heightmap height in pixels
 * @param config - Lighting configuration (uses sunDirection, heightScale, shadowCasting)
 * @returns Float32Array where 1.0 = fully lit, 0.0 = fully shadowed
 */
export function computeShadowMap(
    heights: Float32Array,
    width: number,
    height: number,
    config: LightingConfig,
): Float32Array {
    const shadow = new Float32Array(width * height);
    shadow.fill(1); // Default: fully lit

    if (!config.shadowCasting.enabled) { return shadow; }

    const [sx, sy, sz] = normalizeVec3(config.sunDirection);
    const hScale = config.heightScale;
    const maxDistance = config.shadowCasting.maxDistance;
    const intensity = config.shadowCasting.intensity;

    // Horizontal step direction (XZ plane, normalized)
    const horizLength = Math.hypot(sx, sz);
    if (horizLength < 0.001) { return shadow; } // Sun directly overhead — no shadows
    const stepX = sx / horizLength;
    const stepZ = sz / horizLength;
    // Height rise per horizontal pixel step
    const heightRise = sy / horizLength;

    const rayOptions = { stepX, stepZ, heightRise, maxDistance, intensity };

    for (let z = 0; z < height; z++) {
        for (let x = 0; x < width; x++) {
            shadow[z * width + x] = castShadowRay(
                heights, width, height, x, z, hScale, rayOptions,
            );
        }
    }

    return shadow;
}

/** Options for a single shadow ray march */
interface ShadowRayOptions {
    stepX: number;
    stepZ: number;
    heightRise: number;
    maxDistance: number;
    intensity: number;
}

/**
 * Cast a single shadow ray from (x, z) along the sun direction.
 *
 * @param heights - Decoded height array
 * @param width - Width in pixels
 * @param height - Height in pixels
 * @param x - Pixel X coordinate
 * @param z - Pixel Z coordinate
 * @param hScale - Height scale factor
 * @param options - Ray march parameters (direction, rise, distance, intensity)
 * @returns 1.0 if lit, (1 - intensity) if shadowed
 */
function castShadowRay(
    heights: Float32Array, width: number, height: number,
    x: number, z: number, hScale: number,
    options: ShadowRayOptions,
): number {
    const { stepX, stepZ, heightRise, maxDistance, intensity } = options;
    const baseH = heights[z * width + x] * hScale;

    for (let d = 1; d <= maxDistance; d++) {
        const sampleX = Math.round(x + stepX * d);
        const sampleZ = Math.round(z + stepZ * d);

        if (sampleX < 0 || sampleX >= width || sampleZ < 0 || sampleZ >= height) {
            return 1;
        }

        const terrainH = heights[sampleZ * width + sampleX] * hScale;
        if (terrainH > baseH + heightRise * d) {
            return 1 - intensity;
        }
    }
    return 1;
}

// ============================================================================
// Ambient Occlusion
// ============================================================================

/**
 * Compute screen-space ambient occlusion from heightmap.
 *
 * For each pixel, samples N heights at evenly-spaced angles around the pixel
 * at `radius` distance. The AO factor measures how much the surrounding
 * terrain rises above the current pixel — concave areas (pits, valleys,
 * cave entrances) get darkened.
 *
 * @param heights - Decoded height values (width * height elements)
 * @param width - Heightmap width in pixels
 * @param height - Heightmap height in pixels
 * @param config - Lighting configuration (uses heightScale, ambientOcclusion)
 * @returns Float32Array where 1.0 = fully unoccluded, ~0 = fully occluded
 */
export function computeAmbientOcclusion(
    heights: Float32Array,
    width: number,
    height: number,
    config: LightingConfig,
): Float32Array {
    const aoMap = new Float32Array(width * height);
    aoMap.fill(1);

    if (!config.ambientOcclusion.enabled) { return aoMap; }

    const { samples, radius, intensity } = config.ambientOcclusion;
    const hScale = config.heightScale;

    // Pre-compute sample offsets
    const offsets: { dx: number; dz: number }[] = [];
    for (let i = 0; i < samples; i++) {
        const angle = (2 * Math.PI * i) / samples;
        offsets.push({
            dx: Math.round(Math.cos(angle) * radius),
            dz: Math.round(Math.sin(angle) * radius),
        });
    }

    for (let z = 0; z < height; z++) {
        for (let x = 0; x < width; x++) {
            aoMap[z * width + x] = computeAOSample(
                heights, width, height, x, z, hScale, offsets, radius, samples, intensity,
            );
        }
    }

    return aoMap;
}

/**
 * Compute AO for a single pixel by radial height sampling.
 *
 * @param heights - Decoded height array
 * @param width - Width in pixels
 * @param height - Height in pixels
 * @param x - Pixel X coordinate
 * @param z - Pixel Z coordinate
 * @param hScale - Height scale factor
 * @param offsets - Sample direction offsets (dx, dz per sample)
 * @param radius - Contribution radius: diffs are normalised against this value
 * @param samples - Number of samples (offsets.length, used for normalisation)
 * @param intensity - Maximum occlusion strength (1.0 = fully black at full occlusion)
 * @returns AO factor (1.0 = fully unoccluded, 0 = fully occluded)
 */
function computeAOSample(
    heights: Float32Array, width: number, height: number,
    x: number, z: number, hScale: number,
    offsets: { dx: number; dz: number }[], radius: number,
    samples: number, intensity: number,
): number {
    const centerH = heights[z * width + x] * hScale;
    let occlusion = 0;

    for (const { dx, dz } of offsets) {
        const sx = Math.max(0, Math.min(width - 1, x + dx));
        const sz = Math.max(0, Math.min(height - 1, z + dz));
        const sampleH = heights[sz * width + sx] * hScale;
        const diff = sampleH - centerH;
        if (diff > 0) {
            occlusion += Math.min(1, diff / radius);
        }
    }

    return Math.max(0, 1 - intensity * (occlusion / samples));
}

// ============================================================================
// Per-Material Shading (histogram + hue-based classification)
// ============================================================================

/** Material type classified from pixel color */
export type MaterialType = 'water' | 'grass' | 'foliage' | 'snow' | 'lava' | 'stone' | 'sand' | 'other';

/**
 * Euclidean distance threshold (squared) for histogram color matching.
 * A radius of 28 means two colors must be within 28 units in RGB space to match.
 */
const MATERIAL_MATCH_THRESHOLD_SQ = 28 * 28;

/**
 * Returns true when the pixel (r, g, b) is within the Euclidean distance
 * threshold of any reference color in `refs`.
 *
 * Extracted from classifyMaterial to keep that function's cyclomatic
 * complexity within the configured limit.
 *
 * @param r - Red channel (0-255)
 * @param g - Green channel (0-255)
 * @param b - Blue channel (0-255)
 * @param references - Reference color table to match against
 * @returns `true` when any reference color is within the threshold distance
 */
function matchesColor(
    r: number,
    g: number,
    b: number,
    references: readonly (readonly [number, number, number])[],
): boolean {
    for (const [wr, wg, wb] of references) {
        if ((r - wr) ** 2 + (g - wg) ** 2 + (b - wb) ** 2 <= MATERIAL_MATCH_THRESHOLD_SQ) { return true; }
    }
    return false;
}

/**
 * Classify a pixel's material based on its RGB color.
 *
 * Priority order:
 * 1. Histogram lookup against imported reference tables (water, foliage, grass)
 * 2. Snow/ice: very high brightness + very low saturation (avoids stone misclassification)
 * 3. Lava: bright orange hue  
 * 4. HSV hue fallback for tinted water variants + sand
 * 5. Low saturation catch-all → stone
 *
 * @param r - Red channel (0-255)
 * @param g - Green channel (0-255)
 * @param b - Blue channel (0-255)
 * @returns Classified material type
 */
export function classifyMaterial(r: number, g: number, b: number): MaterialType {
    // --- Histogram lookups against reference color tables ---
    if (matchesColor(r, g, b, WATER_REF_COLORS))   { return 'water'; }
    if (matchesColor(r, g, b, FOLIAGE_REF_COLORS)) { return 'foliage'; }
    if (matchesColor(r, g, b, GRASS_REF_COLORS))   { return 'grass'; }

    // --- HSV-based fallbacks ---
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    const saturation = max === 0 ? 0 : delta / max;
    const avgBrightness = (r + g + b) / 3;

    // Snow / ice: near-white (very bright, very low saturation)
    // Distinguished from stone (same low saturation, but lower brightness)
    if (saturation < 0.12 && avgBrightness > 190) { return 'snow'; }

    // Stone: low saturation grey (mid-range brightness)
    if (saturation < 0.12) { return 'stone'; }

    // Compute hue in degrees for remaining hue-based rules
    let hue: number;
    if (delta === 0) {
        hue = 0;
    } else if (max === r) {
        hue = 60 * (((g - b) / delta) % 6);
    } else if (max === g) {
        hue = 60 * ((b - r) / delta + 2);
    } else {
        hue = 60 * ((r - g) / delta + 4);
    }
    if (hue < 0) { hue += 360; }

    // Lava: bright orange (avoids dirt/terracotta by requiring high brightness + saturation)
    if (hue >= 10 && hue <= 38 && saturation > 0.55 && max > 170) { return 'lava'; }

    // Sand: yellow-beige (low-to-medium saturation)
    if (hue >= 30 && hue < 55 && saturation > 0.12 && saturation < 0.5) { return 'sand'; }

    // Hue fallback for tinted water variants outside histogram radius (B > G > R enforced)
    if (hue >= 195 && hue <= 235 && saturation > 0.3 && b > g && b > r) { return 'water'; }

    return 'other';
}

/**
 * Compute a per-pixel material modifier map.
 *
 * Returns two arrays:
 * - diffuseModifier: multiplied with the shade map
 *   - foliage/grass: brighter (+foliageBrightness)
 *   - stone: extra AO amplification (stoneAOMultiplier)
 *   - snow: brightness boost (+snowBrightness), reduced AO
 *   - sand: reduced AO (sandAOMultiplier)
 * - specularAdd: additive per-pixel light contribution
 *   - water: positional ripple glint (waterSpecular)
 *   - lava: constant warm glow (lavaGlow)
 *
 * @param colorRgba - Color buffer (4 bytes per pixel RGBA)
 * @param _heights - Decoded heights (reserved for future wave-height ripple)
 * @param width - Width in pixels
 * @param height - Height in pixels
 * @param config - Lighting configuration
 * @param aoMap - Ambient occlusion map (for stone/snow AO modulation)
 * @returns diffuseModifier and specularAdd arrays
 */
export function computeMaterialModifiers(
    colorRgba: Buffer | Uint8Array,
    _heights: Float32Array,
    width: number,
    height: number,
    config: LightingConfig,
    aoMap: Float32Array,
): { diffuseModifier: Float32Array; specularAdd: Float32Array } {
    const count = width * height;
    const diffuseModifier = new Float32Array(count);
    const specularAdd = new Float32Array(count);
    diffuseModifier.fill(1);

    if (!config.materialShading.enabled) {
        return { diffuseModifier, specularAdd };
    }

    const { waterSpecular, foliageBrightness, stoneAOMultiplier, snowBrightness, lavaGlow, sandAOMultiplier } = config.materialShading;

    for (let z = 0; z < height; z++) {
        for (let x = 0; x < width; x++) {
            const index = z * width + x;
            const offset = index * 4;
            const r = colorRgba[offset];
            const g = colorRgba[offset + 1];
            const b = colorRgba[offset + 2];

            const material = classifyMaterial(r, g, b);

            switch (material) {
                case 'water': {
                    // Positional ripple glint — Minecraft water is flat so height
                    // gradients are ~0 and physics-based specular gives nothing.
                    const rippleA = 0.5 + 0.5 * Math.sin(x * 0.25);
                    const rippleB = 0.5 + 0.5 * Math.sin(z * 0.17 + 1.5);
                    specularAdd[index] = waterSpecular * rippleA * rippleB;
                    break;
                }
                case 'grass':
                case 'foliage': {
                    // Foliage and grass both get a diffuse brightness boost
                    diffuseModifier[index] = 1 + foliageBrightness;
                    break;
                }
                case 'stone': {
                    // Enhance AO for stone — rocky surfaces have deeper shadow crevices
                    const aoDarkeningStone = 1 - aoMap[index];
                    diffuseModifier[index] = 1 - aoDarkeningStone * stoneAOMultiplier;
                    break;
                }
                case 'snow': {
                    // High albedo — reduce AO influence and add brightness boost.
                    // Snow fills in small crevices, so use half the normal AO darkening.
                    const aoDarkeningSnow = 1 - aoMap[index];
                    diffuseModifier[index] = (1 + snowBrightness) - aoDarkeningSnow * 0.4;
                    break;
                }
                case 'lava': {
                    // Self-illuminating — constant additive glow regardless of sun angle
                    specularAdd[index] = lavaGlow;
                    break;
                }
                case 'sand': {
                    // Flat terrain — reduce AO darkening (sand fills gullies)
                    const aoDarkeningSand = 1 - aoMap[index];
                    diffuseModifier[index] = 1 - aoDarkeningSand * sandAOMultiplier;
                    break;
                }
                default: {
                    break;
                }
            }
        }
    }

    return { diffuseModifier, specularAdd };
}

// ============================================================================
// Unsharp Mask
// ============================================================================

/**
 * Apply a 1D Gaussian blur (horizontal or vertical pass).
 *
 * @param input - Input array (single channel, width * height)
 * @param width - Width in pixels
 * @param height - Height in pixels
 * @param radius - Kernel radius in pixels
 * @param horizontal - true for horizontal pass, false for vertical
 * @returns Blurred Float32Array
 */
function gaussianBlur1D(
    input: Float32Array, width: number, height: number,
    radius: number, horizontal: boolean,
): Float32Array {
    const output = new Float32Array(input.length);
    const sigma = radius / 2;
    const kernelSize = radius * 2 + 1;
    const kernel = new Float32Array(kernelSize);
    let sum = 0;
    for (let i = 0; i < kernelSize; i++) {
        const d = i - radius;
        kernel[i] = Math.exp(-0.5 * (d * d) / (sigma * sigma));
        sum += kernel[i];
    }
    for (let i = 0; i < kernelSize; i++) { kernel[i] /= sum; }

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let value = 0;
            for (let k = -radius; k <= radius; k++) {
                const sx = horizontal
                    ? Math.max(0, Math.min(width - 1, x + k))
                    : x;
                const sy = horizontal
                    ? y
                    : Math.max(0, Math.min(height - 1, y + k));
                value += input[sy * width + sx] * kernel[k + radius];
            }
            output[y * width + x] = value;
        }
    }
    return output;
}

/**
 * Apply unsharp mask to an RGBA color buffer in-place.
 *
 * Computes a luminance channel, blurs it, then adds the high-frequency
 * detail (original - blurred) * amount back to each RGB channel.
 * Pixels where the luminance difference is below threshold are untouched.
 *
 * @param colorRgba - Mutable RGBA pixel buffer (modified in-place)
 * @param width - Width in pixels
 * @param height - Height in pixels
 * @param config - Lighting configuration (uses unsharpMask settings)
 */
export function applyUnsharpMask(
    colorRgba: Buffer | Uint8Array,
    width: number,
    height: number,
    config: LightingConfig,
): void {
    if (!config.unsharpMask.enabled) { return; }

    const { radius, amount, threshold } = config.unsharpMask;
    const count = width * height;

    // Extract luminance channel
    const luminance = new Float32Array(count);
    for (let i = 0; i < count; i++) {
        const offset = i * 4;
        luminance[i] = 0.299 * colorRgba[offset]
                     + 0.587 * colorRgba[offset + 1]
                     + 0.114 * colorRgba[offset + 2];
    }

    // Two-pass Gaussian blur
    const blurred1 = gaussianBlur1D(luminance, width, height, radius, true);
    const blurred = gaussianBlur1D(blurred1, width, height, radius, false);

    // Apply sharpening
    for (let i = 0; i < count; i++) {
        const diff = luminance[i] - blurred[i];
        if (Math.abs(diff) < threshold) { continue; }

        const sharpen = diff * amount;
        const offset = i * 4;
        colorRgba[offset]     = Math.min(255, Math.max(0, Math.round(colorRgba[offset]     + sharpen)));
        colorRgba[offset + 1] = Math.min(255, Math.max(0, Math.round(colorRgba[offset + 1] + sharpen)));
        colorRgba[offset + 2] = Math.min(255, Math.max(0, Math.round(colorRgba[offset + 2] + sharpen)));
    }
}

// ============================================================================
// Full Shade Pipeline
// ============================================================================

/**
 * Apply the full shading pipeline: shade + shadow + AO + material + specular.
 *
 * Combines all lighting contributions into a single per-pixel operation:
 * `finalIntensity = shadeMap * shadow * ao * materialDiffuse + specular + blockLight`
 *
 * @param colorRgba - Mutable RGBA buffer (modified in-place)
 * @param shadeMap - Per-pixel Lambertian/slope shade intensity
 * @param shadowMap - Per-pixel shadow factor (1 = lit, 0 = shadowed)
 * @param aoMap - Per-pixel ambient occlusion (1 = open, 0 = occluded)
 * @param materialDiffuse - Per-pixel diffuse modifier from material classification
 * @param specularAdd - Per-pixel additive specular from material (water highlights)
 * @param blockLights - Optional block-light values (0-1)
 * @param blockLightBoost - Block light intensity multiplier
 */
export function applyFullShading(
    colorRgba: Buffer | Uint8Array,
    shadeMap: Float32Array,
    shadowMap: Float32Array,
    aoMap: Float32Array,
    materialDiffuse: Float32Array,
    specularAdd: Float32Array,
    blockLights?: Float32Array,
    blockLightBoost = 0,
): void {
    for (const [i, shadeIntensity] of shadeMap.entries()) {
        const blockBoost = blockLights ? blockLights[i] * blockLightBoost : 0;
        const shade = shadeIntensity * shadowMap[i] * aoMap[i] * materialDiffuse[i];
        const intensity = shade + specularAdd[i] + blockBoost;
        const offset = i * 4;
        colorRgba[offset]     = Math.min(255, Math.max(0, Math.round(colorRgba[offset]     * intensity)));
        colorRgba[offset + 1] = Math.min(255, Math.max(0, Math.round(colorRgba[offset + 1] * intensity)));
        colorRgba[offset + 2] = Math.min(255, Math.max(0, Math.round(colorRgba[offset + 2] * intensity)));
    }
}

/**
 * Apply BlueMap-exact slope shading to a color buffer in-place.
 *
 * Replicates the BlueMap `LowresFragmentShader` formula exactly:
 *   `shade = clamp((h - hRight + h - hBelow) × 0.06 / lodScale, -0.2, 0.04)`
 *   `color.rgb += shade`  (additive, not multiplicative)
 *
 * This additive formulation matches BlueMap's client-side GLSL shader, where
 * shadow areas receive an absolute darkening regardless of base color.
 * `lodScale` is 1 for lod=1 tiles (direct source tiles), matching heightScale=1.
 *
 * @param colorRgba - Mutable RGBA buffer (modified in-place, 4 bytes per pixel)
 * @param heights - Decoded height values (width × height Float32Array)
 * @param width - Buffer width in pixels
 * @param height - Buffer height in pixels
 * @param heightScale - Height exaggeration factor (1.0 = real scale, matches lodScale=1)
 */
export function applySlopeShading(
    colorRgba: Buffer | Uint8Array,
    heights: Float32Array,
    width: number,
    height: number,
    heightScale = 1,
): void {
    for (let z = 0; z < height; z++) {
        for (let x = 0; x < width; x++) {
            const i = z * width + x;
            const h = heights[i] * heightScale;
            const hRight = heights[z * width + Math.min(width - 1, x + 1)] * heightScale;
            const hBelow = heights[Math.min(height - 1, z + 1) * width + x] * heightScale;
            // BlueMap: clamp((h - hRight + h - hBelow) * 0.06, -0.2, 0.04)
            const shade = Math.max(-0.2, Math.min(0.04, (h - hRight + h - hBelow) * 0.06));
            // Additive: shade is in [0,1] space, convert to 0-255 additive offset
            const add = shade * 255;
            const offset = i * 4;
            colorRgba[offset]     = Math.min(255, Math.max(0, Math.round(colorRgba[offset]     + add)));
            colorRgba[offset + 1] = Math.min(255, Math.max(0, Math.round(colorRgba[offset + 1] + add)));
            colorRgba[offset + 2] = Math.min(255, Math.max(0, Math.round(colorRgba[offset + 2] + add)));
        }
    }
}

/**
 * Compute per-pixel shade intensity from a heightmap.
 *
 * Dispatches to the appropriate model based on config.model.
 *
 * @param heights - Decoded height values (from decodeHeightmap)
 * @param width - Heightmap width in pixels
 * @param height - Heightmap height in pixels
 * @param config - Lighting configuration
 * @returns Float32Array of intensity multipliers (width × height elements)
 */
export function computeShadeMap(
    heights: Float32Array,
    width: number,
    height: number,
    config: LightingConfig
): Float32Array {
    if (config.model === 'slope') {
        return computeSlopeShade(heights, width, height, config);
    }
    return computeLambertianShade(heights, width, height, config);
}

// ============================================================================
// Bilinear Upsampling
// ============================================================================

/**
 * Bilinearly upsample a Float32Array (e.g. decoded heights or block-light
 * values) by an integer scale factor.
 *
 * Destination pixel centres are mapped back to fractional source coordinates
 * using half-pixel offsets; boundary pixels clamp-to-edge (no wrap).
 *
 * @param data   - Source values laid out row-major (sourceW × sourceH elements)
 * @param sourceW  - Source width in pixels
 * @param sourceH  - Source height in pixels
 * @param scale  - Integer scale factor (must be ≥ 1)
 * @returns New Float32Array of size (sourceW × scale) × (sourceH × scale)
 */
export function upsampleBilinear(
    data: Float32Array,
    sourceW: number,
    sourceH: number,
    scale: number,
): Float32Array {
    const outputW = sourceW * scale;
    const outputH = sourceH * scale;
    return Float32Array.from({ length: outputW * outputH }, (_, i) => {
        const dx = i % outputW;
        const dy = Math.floor(i / outputW);
        // Map output pixel centre → fractional source coordinate
        const sx = (dx + 0.5) / scale - 0.5;
        const sy = (dy + 0.5) / scale - 0.5;
        const sx0 = Math.max(0, Math.floor(sx));
        const sx1 = Math.min(sourceW - 1, sx0 + 1);
        const sy0 = Math.max(0, Math.floor(sy));
        const sy1 = Math.min(sourceH - 1, sy0 + 1);
        const tx = sx - sx0;
        const ty = sy - sy0;
        return (
            data[sy0 * sourceW + sx0] * (1 - tx) * (1 - ty) +
            data[sy0 * sourceW + sx1] * tx        * (1 - ty) +
            data[sy1 * sourceW + sx0] * (1 - tx) * ty        +
            data[sy1 * sourceW + sx1] * tx        * ty
        );
    });
}

/**
 * Nearest-neighbour upsample a Float32Array by an integer scale factor.
 *
 * Each output pixel maps back to the closest source pixel centre, preserving
 * sharp step edges (block faces and stair steps) in the upsampled height field.
 * Use this instead of {@link upsampleBilinear} for height data so that normals
 * see flat-top block faces and crisp vertical steps rather than smooth dome
 * shapes.
 *
 * @param data    - Source values laid out row-major (sourceW × sourceH elements)
 * @param sourceW - Source width in pixels
 * @param sourceH - Source height in pixels
 * @param scale   - Integer scale factor (must be ≥ 1)
 * @returns New Float32Array of size (sourceW × scale) × (sourceH × scale)
 */
export function upsampleNearest(
    data: Float32Array,
    sourceW: number,
    sourceH: number,
    scale: number,
): Float32Array {
    const outputW = sourceW * scale;
    const outputH = sourceH * scale;
    return Float32Array.from({ length: outputW * outputH }, (_, i) => {
        const dx = i % outputW;
        const dy = Math.floor(i / outputW);
        const sx = Math.floor(dx / scale);
        const sy = Math.floor(dy / scale);
        return data[sy * sourceW + sx];
    });
}

// ============================================================================
// Block Light Decoding
// ============================================================================

/**
 * Decode BlueMap block-light values from the heightmap's R channel.
 *
 * Each pixel's R byte encodes block light in range 0–15 (stored as R×255
 * by BlueMap). This function normalises to 0–1.
 *
 * @param rgba - Raw heightmap pixel data (4 bytes per pixel: R=light, G=height-hi, B=height-lo, A)
 * @param width - Image width in pixels
 * @param height - Image height in pixels
 * @returns Float32Array of normalised block-light values (0–1)
 */
export function decodeBlockLight(
    rgba: Buffer | Uint8Array,
    width: number,
    height: number
): Float32Array {
    const pixelCount = width * height;
    return Float32Array.from({ length: pixelCount }, (_, i) => rgba[i * 4] / 15);
}

// ============================================================================
// Color Application
// ============================================================================

/**
 * Apply shade map (and optional block-light boost) to an RGBA color buffer
 * in-place.
 *
 * Each pixel's R, G, B channels are multiplied by `shadeMap[i] + blockBoost`
 * where `blockBoost = blockLights[i] × blockLightBoost` (0 when either arg is
 * absent). Alpha is preserved. Output is clamped to 0–255.
 *
 * @param colorRgba - Mutable RGBA pixel buffer (modified in-place)
 * @param shadeMap - Per-pixel intensity multipliers
 * @param blockLights - Optional normalised block-light values (0–1) per pixel
 * @param blockLightBoost - Maximum additive brightness from block light (0–1)
 */
export function applyShadeToColor(
    colorRgba: Buffer | Uint8Array,
    shadeMap: Float32Array,
    blockLights?: Float32Array,
    blockLightBoost = 0,
): void {
    for (const [i, shadeIntensity] of shadeMap.entries()) {
        const boost = blockLights ? blockLights[i] * blockLightBoost : 0;
        const intensity = shadeIntensity + boost;
        const offset = i * 4;
        colorRgba[offset]     = Math.min(255, Math.max(0, Math.round(colorRgba[offset]     * intensity)));
        colorRgba[offset + 1] = Math.min(255, Math.max(0, Math.round(colorRgba[offset + 1] * intensity)));
        colorRgba[offset + 2] = Math.min(255, Math.max(0, Math.round(colorRgba[offset + 2] * intensity)));
        // Alpha (offset + 3) is preserved
    }
}

// ============================================================================
// Enhancement Effects
// ============================================================================

/**
 * Warm block-light glow — radial spread with inverse-square falloff.
 *
 * Rather than reading each pixel's own block-light value in isolation, this
 * function performs a proper circular light spread:
 *
 *  1. Treat every pixel whose block-light value exceeds `emitThreshold` as a
 *     point light source with strength proportional to its block-light level.
 *  2. For every output pixel, accumulate contributions from all emitters within
 *     `maxRadius` pixels using inverse-square falloff:
 *       contribution = emitter_strength / (1 + falloff × dist²)
 *     This gives a natural circular halo that is brightest at the source and
 *     fades smoothly — not a rectangular pattern.
 *  3. The warm tint (R > G > B) is applied once to the final accumulated value.
 *
 * @param blockLights - Normalised block-light values (0–1) per pixel
 * @param width - Image width in pixels
 * @param height - Image height in pixels
 * @param strength - Peak additive brightness at an emitter pixel (default 0.30)
 * @param maxRadius - Maximum spread radius in pixels (default 40)
 * @param falloff - Inverse-square steepness: higher = tighter halo (default 0.008)
 * @param emitThreshold - Minimum block-light to be treated as an emitter (default 0.15)
 * @returns Per-channel additive values {r, g, b} and a grayscale {intensity} for visualization
 */
export function computeBlockLightGlow(
    blockLights: Float32Array,
    width: number,
    height: number,
    strength = 0.004,
    maxRadius = 20,
    falloff = 0.15,
    emitThreshold = 0.15,
): { r: Float32Array; g: Float32Array; b: Float32Array; intensity: Float32Array } {
    const n = width * height;
    const accumulated = new Float32Array(n);

    // Collect emitter pixels to avoid iterating the full grid for every output pixel
    const emitters: { x: number; z: number; strength: number }[] = [];
    for (let z = 0; z < height; z++) {
        for (let x = 0; x < width; x++) {
            const bl = blockLights[z * width + x];
            if (bl >= emitThreshold) {
                emitters.push({ x, z, strength: bl });
            }
        }
    }

    // Spread each emitter circularly using per-row chord width so no inside-circle
    // guard is needed in the innermost loop, keeping nesting depth ≤ 3.
    const r2max = maxRadius * maxRadius;
    for (const em of emitters) {
        for (let dz = -maxRadius; dz <= maxRadius; dz++) {
            const pz = em.z + dz;
            if (pz < 0 || pz >= height) { continue; }
            const maxDx = Math.floor(Math.sqrt(r2max - dz * dz));
            const xStart = Math.max(0, em.x - maxDx);
            const xEnd   = Math.min(width - 1, em.x + maxDx);
            for (let px = xStart; px <= xEnd; px++) {
                const dx = px - em.x;
                accumulated[pz * width + px] += em.strength / (1 + falloff * (dx * dx + dz * dz));
            }
        }
    }

    // Normalise and apply warm tint
    const r         = new Float32Array(n);
    const g         = new Float32Array(n);
    const b         = new Float32Array(n);
    const intensity = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        // Exponential tonemapping: naturally bounded at 1.0, gradual even with many overlapping emitters
        const accumulator = accumulated[i] ?? 0;
        const v = 1 - Math.exp(-accumulator * strength);
        intensity[i] = v;
        r[i] = v * 255;
        g[i] = v * 0.85 * 255;
        b[i] = v * 0.7 * 255;
    }
    return { r, g, b, intensity };
}

// ============================================================================
// Shadow Colour Grading & Post-Processing
// ============================================================================

/**
 * Apply cool-tinted shadows: shift shadowed pixels toward blue/purple ambient.
 *
 * Instead of pure gray darkening (`color × mul`), shadows blend toward a cool
 * sky-ambient colour. The blend amount is proportional to how deep the pixel is
 * in shadow (1 − mul). Fully lit pixels (mul = 1) are untouched.
 *
 * @param color - RGBA buffer (mutated in-place)
 * @param shadowMap - Per-pixel shadow factor (1 = lit, lower = shadowed)
 * @param aoMap - Per-pixel AO factor (1 = open, lower = occluded)
 * @param width - Image width
 * @param height - Image height
 * @param tintR - Cool ambient R (default 0.6 — slightly desaturated blue)
 * @param tintG - Cool ambient G (default 0.65)
 * @param tintB - Cool ambient B (default 0.85 — blue-dominant)
 * @param tintStrength - How much to blend toward cool tint in full shadow (default 0.3)
 */
export function applyCoolShadowTint(
    color: Buffer,
    shadowMap: Float32Array,
    aoMap: Float32Array,
    width: number,
    height: number,
    tintR = 0.6,
    tintG = 0.65,
    tintB = 0.85,
    tintStrength = 0.3,
): void {
    const n = width * height;
    for (let i = 0; i < n; i++) {
        const o = i * 4;
        const mul = shadowMap[i] * aoMap[i];
        const shadowDepth = 1 - mul; // 0 = fully lit, 1 = deepest shadow
        const blend = shadowDepth * tintStrength;

        // Darken by mul, then blend toward cool tint proportional to shadow depth
        const r = color[o] * mul;
        const g = color[o + 1] * mul;
        const b = color[o + 2] * mul;
        color[o]     = Math.min(255, Math.max(0, Math.round(r * (1 - blend) + r * tintR * blend * 2)));
        color[o + 1] = Math.min(255, Math.max(0, Math.round(g * (1 - blend) + g * tintG * blend * 2)));
        color[o + 2] = Math.min(255, Math.max(0, Math.round(b * (1 - blend) + b * tintB * blend * 2)));
    }
}

/**
 * Boost saturation of an RGBA buffer in-place.
 *
 * Converts each pixel to a luminance + chroma representation, scales the
 * chroma component by `factor`, then converts back. This recovers vibrancy
 * lost from multiplicative shadow/AO darkening without changing brightness.
 *
 * @param color - RGBA buffer (mutated in-place)
 * @param width - Image width
 * @param height - Image height
 * @param factor - Saturation multiplier (1.0 = no change, 1.3 = 30 % boost)
 */
export function boostSaturation(
    color: Buffer,
    width: number,
    height: number,
    factor = 1.3,
): void {
    const n = width * height;
    for (let i = 0; i < n; i++) {
        const o = i * 4;
        const r = color[o];
        const g = color[o + 1];
        const b = color[o + 2];
        // Rec. 709 luminance
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        color[o]     = Math.min(255, Math.max(0, Math.round(lum + (r - lum) * factor)));
        color[o + 1] = Math.min(255, Math.max(0, Math.round(lum + (g - lum) * factor)));
        color[o + 2] = Math.min(255, Math.max(0, Math.round(lum + (b - lum) * factor)));
    }
}

// ============================================================================
// Height-Aware Light Emission
// ============================================================================

/**
 * Check line-of-sight from emitter to target through the heightmap.
 *
 * Walks a Bresenham-style line from (ex, ez) to (tx, tz). At each step,
 * the expected ray height is linearly interpolated between `emitterH` and
 * `targetH`. If the actual terrain height at that step exceeds the
 * interpolated ray height, the ray is blocked.
 *
 * @param heights - Decoded height map
 * @param width - Image width
 * @param ex - Emitter X coordinate
 * @param ez - Emitter Z coordinate
 * @param emitterH - Height at the emitter (with light-source offset)
 * @param tx - Target X coordinate
 * @param tz - Target Z coordinate
 * @param targetH - Height at the target
 * @returns `true` if line-of-sight is clear, `false` if blocked
 */
function hasLineOfSight(
    heights: Float32Array,
    width: number,
    ex: number, ez: number, emitterH: number,
    tx: number, tz: number, targetH: number,
): boolean {
    const dx = tx - ex;
    const dz = tz - ez;
    const steps = Math.max(Math.abs(dx), Math.abs(dz));
    if (steps <= 1) { return true; } // Adjacent pixels — always visible

    const stepX = dx / steps;
    const stepZ = dz / steps;

    // Stride-2: check every other pixel. Walls are ≥ 2px at 2× scale,
    // so skipping 1 intermediate pixel cannot miss an occluder.
    for (let s = 2; s < steps; s += 2) {
        const sx = Math.round(ex + stepX * s);
        const sz = Math.round(ez + stepZ * s);
        const t = s / steps;
        const rayH = emitterH * (1 - t) + targetH * t;
        const terrainH = heights[sz * width + sx];
        if (terrainH > rayH) { return false; }
    }
    return true;
}

/**
 * Height-aware block-light glow with terrain occlusion.
 *
 * Like {@link computeBlockLightGlow}, this finds emitter pixels from the
 * block-light channel and spreads circular light with inverse-square falloff.
 * The key improvement: before contributing light to a target pixel, a
 * line-of-sight ray is marched through the heightmap. If any intermediate
 * terrain pixel is taller than the interpolated ray height, the light is
 * blocked — creating proper shadows behind walls, buildings, and hills.
 *
 * The emitter is assumed to sit `lightSourceOffset` blocks above the terrain
 * surface (e.g., a torch at Y+1). This prevents self-occlusion on flat ground
 * and allows light to peek over low walls.
 *
 * @param blockLights - Normalised block-light values (0–1) per pixel
 * @param heights - Decoded heightmap values (same resolution)
 * @param width - Image width in pixels
 * @param height - Image height in pixels
 * @param strength - Tonemapping strength (default 0.006)
 * @param maxRadius - Maximum spread radius in pixels (default 24)
 * @param falloff - Inverse-square steepness (default 0.12)
 * @param emitThreshold - Minimum block-light to be treated as emitter (default 0.15)
 * @param lightSourceOffset - Height blocks above terrain for light origin (default 1)
 * @returns Per-channel additive values {r, g, b} and a grayscale {intensity} for visualization
 */
export function computeHeightAwareLightGlow(
    blockLights: Float32Array,
    heights: Float32Array,
    width: number,
    height: number,
    strength = 0.006,
    maxRadius = 24,
    falloff = 0.12,
    emitThreshold = 0.15,
    lightSourceOffset = 1,
): { r: Float32Array; g: Float32Array; b: Float32Array; intensity: Float32Array } {
    const n = width * height;
    const accumulated = new Float32Array(n);

    // Collect emitter pixels
    const emitters: { x: number; z: number; strength: number; height: number }[] = [];
    for (let z = 0; z < height; z++) {
        for (let x = 0; x < width; x++) {
            const bl = blockLights[z * width + x];
            if (bl >= emitThreshold) {
                emitters.push({
                    x,
                    z,
                    strength: bl,
                    height: heights[z * width + x] + lightSourceOffset,
                });
            }
        }
    }

    // Spread each emitter circularly, checking line-of-sight through heightmap
    const r2max = maxRadius * maxRadius;
    for (const em of emitters) {
        spreadEmitterWithOcclusion(
            em, accumulated, heights, width, height, maxRadius, r2max, falloff,
        );
    }

    // Normalise and apply warm tint
    const r         = new Float32Array(n);
    const g         = new Float32Array(n);
    const b         = new Float32Array(n);
    const intensity = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const v = 1 - Math.exp(-(accumulated[i] ?? 0) * strength);
        intensity[i] = v;
        r[i] = v * 255;
        g[i] = v * 0.85 * 255;
        b[i] = v * 0.7 * 255;
    }
    return { r, g, b, intensity };
}

/**
 * Check whether a single target pixel should receive light from an emitter,
 * and if so accumulate the contribution.
 *
 * @param em - Emitter metadata (position, strength, height)
 * @param em.x - Emitter X position
 * @param em.z - Emitter Z position
 * @param em.strength - Emitter light strength
 * @param em.height - Emitter height above terrain
 * @param accumulated - Accumulation buffer (mutated in-place)
 * @param heights - Decoded heightmap
 * @param width - Image width
 * @param px - Target pixel X
 * @param pz - Target pixel Z
 * @param dx - Horizontal offset from emitter
 * @param dz - Vertical offset from emitter
 * @param falloff - Inverse-square falloff coefficient
 */
function accumulateIfVisible(
    em: { x: number; z: number; strength: number; height: number },
    accumulated: Float32Array,
    heights: Float32Array,
    width: number,
    px: number,
    pz: number,
    dx: number,
    dz: number,
    falloff: number,
): void {
    const d2 = dx * dx + dz * dz;
    const targetH = heights[pz * width + px];
    // Light cannot reach pixels whose terrain is above the emitter
    if (targetH > em.height) { return; }
    // Skip LOS for very close pixels (< 4px) — flat ground always has clear sight
    if (d2 >= 16 && !hasLineOfSight(heights, width, em.x, em.z, em.height, px, pz, targetH)) {
        return;
    }
    accumulated[pz * width + px] += em.strength / (1 + falloff * d2);
}

/**
 * Spread a single emitter's light contribution, checking line-of-sight for
 * each target pixel. Extracted to keep nesting depth within the complexity limit.
 *
 * @param em - Emitter metadata (position, strength, height)
 * @param em.x - Emitter X position
 * @param em.z - Emitter Z position
 * @param em.strength - Emitter light strength
 * @param em.height - Emitter height above terrain
 * @param accumulated - Accumulation buffer (mutated in-place)
 * @param heights - Decoded heightmap
 * @param width - Image width
 * @param height - Image height
 * @param maxRadius - Maximum spread radius
 * @param r2max - maxRadius² (pre-computed)
 * @param falloff - Inverse-square falloff coefficient
 */
function spreadEmitterWithOcclusion(
    em: { x: number; z: number; strength: number; height: number },
    accumulated: Float32Array,
    heights: Float32Array,
    width: number,
    height: number,
    maxRadius: number,
    r2max: number,
    falloff: number,
): void {
    for (let dz = -maxRadius; dz <= maxRadius; dz++) {
        const pz = em.z + dz;
        if (pz < 0 || pz >= height) { continue; }
        const maxDx = Math.floor(Math.sqrt(r2max - dz * dz));
        const xStart = Math.max(0, em.x - maxDx);
        const xEnd   = Math.min(width - 1, em.x + maxDx);
        for (let px = xStart; px <= xEnd; px++) {
            accumulateIfVisible(em, accumulated, heights, width, px, pz, px - em.x, dz, falloff);
        }
    }
}

// ============================================================================
// Optimised height-aware glow (1× resolution + emitter clustering)
// ============================================================================

/**
 * Cluster adjacent emitter pixels into representative centroids.
 *
 * Uses a simple flood-fill / connected-component approach: scan left-to-right,
 * top-to-bottom. Each emitter pixel is merged into an existing cluster if its
 * immediate left or top neighbour belongs to one (union-find). The result is a
 * dramatically reduced emitter list — e.g. 173 000 lit pixels collapse to
 * ~2 000 cluster centroids.
 *
 * Each cluster centroid gets the **sum** of its member strengths so total
 * energy is conserved. The height is the **maximum** of members (light rises
 * from the tallest block in the cluster).
 *
 * @param blockLights - Normalised block-light values (0–1)
 * @param heights - Decoded heightmap (same resolution)
 * @param width - Image width
 * @param height - Image height
 * @param emitThreshold - Minimum block-light to treat as emitter
 * @param lightSourceOffset - Height blocks above terrain
 * @returns Array of cluster centroids with accumulated strength
 */
/**
 * Union-find: find root with path compression.
 *
 * @param parent - Union-find parent array
 * @param index - Element index to find root for
 * @returns Root index of the element's component
 */
function ufFind(parent: Int32Array, index: number): number {
    let root = index;
    while (parent[root] !== root) { root = parent[root]; }
    let current = index;
    while (current !== root) {
        const next = parent[current];
        parent[current] = root;
        current = next;
    }
    return root;
}

/**
 * Conditionally union two pixels if the neighbour is an emitter at the same height.
 *
 * @param parent - Union-find array
 * @param heights - Decoded heightmap
 * @param index - Current pixel index
 * @param neighbourIndex - Neighbour pixel index
 * @param inBounds - Whether the neighbour is within image bounds
 * @param h - Height at the current pixel
 */
function tryUnion(
    parent: Int32Array,
    heights: Float32Array,
    index: number,
    neighbourIndex: number,
    inBounds: boolean,
    h: number,
): void {
    if (!inBounds || parent[neighbourIndex] < 0 || heights[neighbourIndex] !== h) { return; }
    const ra = ufFind(parent, index);
    const rb = ufFind(parent, neighbourIndex);
    if (ra !== rb) { parent[rb] = ra; }
}

/**
 * First pass of emitter clustering: label emitter pixels and union adjacent ones.
 *
 * Scans left-to-right, top-to-bottom. Each emitter pixel (block-light ≥ threshold)
 * is initialised as its own root, then merged with its left and top neighbours
 * if they are also emitters **and** at a similar elevation (4-connected union-find).
 *
 * The height gate prevents merging emitters across different terrain levels
 * (e.g., ground-floor torches vs. rooftop torches). Only emitters at exactly
 * the same height are merged. Uses 8-connectivity (cardinal + diagonal
 * neighbours) to merge as aggressively as possible on the horizontal plane.
 *
 * @param parent - Union-find array (pre-filled with -1); mutated in place
 * @param blockLights - Normalised block-light values (0–1)
 * @param heights - Decoded heightmap
 * @param width - Image width
 * @param height - Image height
 * @param emitThreshold - Minimum block-light to treat as emitter
 */
function labelAndUnionEmitters(
    parent: Int32Array,
    blockLights: Float32Array,
    heights: Float32Array,
    width: number,
    height: number,
    emitThreshold: number,
): void {
    for (let z = 0; z < height; z++) {
        for (let x = 0; x < width; x++) {
            const index = z * width + x;
            if (blockLights[index] < emitThreshold) { continue; }
            parent[index] = index;
            const h = heights[index];
            // 8-connected: check all already-visited neighbours (left, top-left, top, top-right)
            tryUnion(parent, heights, index, index - 1, x > 0, h);
            tryUnion(parent, heights, index, index - width - 1, z > 0 && x > 0, h);
            tryUnion(parent, heights, index, index - width, z > 0, h);
            tryUnion(parent, heights, index, index - width + 1, z > 0 && x < width - 1, h);
        }
    }
}

/** Per-cluster accumulator for strength-weighted centroid computation. */
interface ClusterAccumulator {
    sumX: number; sumZ: number; sumStrength: number;
    minH: number; count: number;
}

/**
 * Accumulate a single emitter pixel's contribution into a cluster.
 *
 * @param clusterMap - Map from root index to cluster accumulator
 * @param root - Union-find root index for this pixel
 * @param x - Pixel X coordinate
 * @param z - Pixel Z coordinate (unused directly, encoded in root)
 * @param bl - Block-light value at this pixel
 * @param h - Height at this pixel
 */
function accumulateClusterPixel(
    clusterMap: Map<number, ClusterAccumulator>,
    root: number,
    x: number,
    z: number,
    bl: number,
    h: number,
): void {
    const existing = clusterMap.get(root);
    if (existing) {
        existing.sumX += x * bl;
        existing.sumZ += z * bl;
        existing.sumStrength += bl;
        if (h < existing.minH) { existing.minH = h; }
        existing.count++;
    } else {
        clusterMap.set(root, {
            sumX: x * bl, sumZ: z * bl,
            sumStrength: bl, minH: h, count: 1,
        });
    }
}

/**
 * Second pass: accumulate per-cluster stats and build centroid list.
 *
 * @param parent - Union-find array from {@link labelAndUnionEmitters}
 * @param blockLights - Normalised block-light values
 * @param heights - Decoded heightmap
 * @param width - Image width
 * @param height - Image height
 * @param lightSourceOffset - Height blocks above terrain
 * @returns Array of cluster centroids
 */
function buildClusterCentroids(
    parent: Int32Array,
    blockLights: Float32Array,
    heights: Float32Array,
    width: number,
    height: number,
    lightSourceOffset: number,
): { x: number; z: number; strength: number; height: number }[] {
    const clusterMap = new Map<number, ClusterAccumulator>();

    for (let z = 0; z < height; z++) {
        for (let x = 0; x < width; x++) {
            const index = z * width + x;
            if (parent[index] < 0) { continue; }
            const root = ufFind(parent, index);
            accumulateClusterPixel(clusterMap, root, x, z, blockLights[index], heights[index]);
        }
    }

    const clusters: { x: number; z: number; strength: number; height: number }[] = [];
    for (const c of clusterMap.values()) {
        clusters.push({
            x: Math.round(c.sumX / c.sumStrength),
            z: Math.round(c.sumZ / c.sumStrength),
            strength: c.sumStrength / c.count,
            height: c.minH + lightSourceOffset,
        });
    }
    return clusters;
}

function clusterEmitters(
    blockLights: Float32Array,
    heights: Float32Array,
    width: number,
    height: number,
    emitThreshold: number,
    lightSourceOffset: number,
): { x: number; z: number; strength: number; height: number }[] {
    const parent = new Int32Array(width * height).fill(-1);
    labelAndUnionEmitters(parent, blockLights, heights, width, height, emitThreshold);
    return buildClusterCentroids(parent, blockLights, heights, width, height, lightSourceOffset);
}

/**
 * Fast height-aware block-light glow with terrain occlusion.
 *
 * This is an optimised variant of {@link computeHeightAwareLightGlow} designed
 * to run at **1× (native) resolution** — the caller is responsible for
 * bilinear-upsampling the returned glow buffers to the shading resolution.
 *
 * Two key speedups over the original:
 * 1. **Native-resolution computation**: 501×501 = 251 k pixels vs 1002×1002 =
 *    1 M pixels — 4× fewer target pixels and 4× fewer ray marches.
 * 2. **Emitter clustering**: adjacent lit pixels are merged via union-find into
 *    centroid points. A dense lit area of 100 pixels becomes a single emitter,
 *    reducing emitter count by ~50–100×.
 *
 * Together these produce ~200–300× speedup (from ~270 s to <1 s on the bench
 * tile).
 *
 * @param blockLights - Normalised block-light values (0–1) at **1× resolution**
 * @param heights - Decoded heightmap values at **1× resolution**
 * @param width - Native image width (e.g. 501)
 * @param height - Native image height (e.g. 501)
 * @param strength - Tonemapping strength (default 0.04)
 * @param maxRadius - Maximum spread radius in native pixels (default 16)
 * @param falloff - Inverse-square steepness (default 0.10)
 * @param emitThreshold - Minimum block-light to be treated as emitter (default 0.5)
 * @param lightSourceOffset - Height blocks above terrain for light origin (default 1)
 * @returns Per-channel additive values {r, g, b} and a grayscale {intensity} at native resolution
 */
export function computeHeightAwareLightGlowFast(
    blockLights: Float32Array,
    heights: Float32Array,
    width: number,
    height: number,
    strength = 0.04,
    maxRadius = 16,
    falloff = 0.1,
    emitThreshold = 0.5,
    lightSourceOffset = 1,
): { r: Float32Array; g: Float32Array; b: Float32Array; intensity: Float32Array } {
    const n = width * height;
    const accumulated = new Float32Array(n);

    // Cluster adjacent emitters into centroids
    const emitters = clusterEmitters(
        blockLights, heights, width, height, emitThreshold, lightSourceOffset,
    );
    console.log(`  Clusters: ${emitters.length} (from ${width}×${height} grid)`);

    // Spread each emitter circularly, checking line-of-sight through heightmap
    const r2max = maxRadius * maxRadius;
    for (const em of emitters) {
        spreadEmitterWithOcclusion(
            em, accumulated, heights, width, height, maxRadius, r2max, falloff,
        );
    }

    // Normalise and apply warm tint
    const r         = new Float32Array(n);
    const g         = new Float32Array(n);
    const b         = new Float32Array(n);
    const intensity = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const v = 1 - Math.exp(-(accumulated[i] ?? 0) * strength);
        intensity[i] = v;
        r[i] = v * 255;
        g[i] = v * 0.85 * 255;
        b[i] = v * 0.7 * 255;
    }
    return { r, g, b, intensity };
}

/**
 * Parallel variant of {@link computeHeightAwareLightGlowFast} using worker threads.
 *
 * Clusters emitters on the main thread, then distributes the spread computation
 * across N worker threads. Each worker gets a chunk of emitters and the shared
 * heightmap, returns its own accumulated buffer. The main thread sums them and
 * applies tonemapping.
 *
 * @param blockLights - Normalised block-light values (0–1)
 * @param heights - Decoded heightmap values
 * @param width - Image width
 * @param height - Image height
 * @param strength - Tonemapping strength
 * @param maxRadius - Maximum spread radius in pixels
 * @param falloff - Inverse-square steepness
 * @param emitThreshold - Minimum block-light to be treated as emitter
 * @param lightSourceOffset - Height blocks above terrain for light origin
 * @param numberWorkers - Number of worker threads (default: CPU count)
 * @returns Per-channel additive values {r, g, b} and a grayscale {intensity}
 */
export async function computeHeightAwareLightGlowParallel(
    blockLights: Float32Array,
    heights: Float32Array,
    width: number,
    height: number,
    strength = 0.04,
    maxRadius = 16,
    falloff = 0.1,
    emitThreshold = 0.5,
    lightSourceOffset = 1,
    numberWorkers?: number,
): Promise<{ r: Float32Array; g: Float32Array; b: Float32Array; intensity: Float32Array }> {
    const { Worker } = await import('node:worker_threads');
    const os = await import('node:os');
    const { default: nodePath } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const workerCount = numberWorkers ?? Math.min(os.cpus().length, 8);
    const n = width * height;

    // Cluster emitters (main thread — fast O(n) union-find)
    const emitters = clusterEmitters(
        blockLights, heights, width, height, emitThreshold, lightSourceOffset,
    );
    console.log(`  Clusters: ${emitters.length} (from ${width}×${height} grid)`);
    console.log(`  Distributing across ${workerCount} workers`);

    // Copy heights into SharedArrayBuffer so workers read without copying
    const heightsBuf = new SharedArrayBuffer(heights.byteLength);
    new Float32Array(heightsBuf).set(heights);

    // Split emitters into roughly equal chunks
    const chunkSize = Math.ceil(emitters.length / workerCount);
    const workerPath = nodePath.join(
        nodePath.dirname(fileURLToPath(import.meta.url)),
        '_glow-worker.mjs',
    );

    const promises: Promise<Float32Array>[] = [];
    for (let w = 0; w < workerCount; w++) {
        const chunk = emitters.slice(w * chunkSize, (w + 1) * chunkSize);
        if (chunk.length === 0) { continue; }

        const promise = new Promise<Float32Array>((resolve, reject) => {
            const worker = new Worker(workerPath, {
                workerData: {
                    heightsBuf,
                    width,
                    height,
                    maxRadius,
                    falloff,
                    emitters: chunk,
                },
            });
            worker.on('message', (buf: ArrayBuffer) => {
                resolve(new Float32Array(buf));
            });
            worker.on('error', reject);
            worker.on('exit', (code) => {
                if (code !== 0) { reject(new Error(`Worker exited with code ${code}`)); }
            });
        });
        promises.push(promise);
    }

    // Wait for all workers to finish and sum their accumulated buffers
    const results = await Promise.all(promises);
    const accumulated = new Float32Array(n);
    for (const partial of results) {
        for (let i = 0; i < n; i++) {
            accumulated[i] += partial[i];
        }
    }

    // Normalise and apply warm tint
    const r         = new Float32Array(n);
    const g         = new Float32Array(n);
    const b         = new Float32Array(n);
    const intensity = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const v = 1 - Math.exp(-(accumulated[i] ?? 0) * strength);
        intensity[i] = v;
        r[i] = v * 255;
        g[i] = v * 0.85 * 255;
        b[i] = v * 0.7 * 255;
    }
    return { r, g, b, intensity };
}

/**
 * Discrete hard-shadow map — cast shadows from cliffs toward the SE.
 *
 * Marches from each pixel toward the BlueMap light direction (upper-left of
 * the tile, i.e. decreasing x and z). A pixel is in shadow when a neighbour
 * along the ray is strictly higher than the current pixel plus a per-step
 * height tolerance.
 *
 * Soft-shadow with penumbra via multi-ray sun-disc sampling.
 *
 * Casts `numRays` rays from the pixel toward the NW light source, each at a
 * slightly different sun elevation (slopeThreshold ± sunSpread). Where only
 * some rays are blocked the pixel lies in the penumbra and receives a partial
 * shadow. Where all rays are blocked it is in the umbra (full shadow). This
 * matches how real-world shadow edges soften with distance from the caster.
 *
 * @param heights - Decoded height values (width × height)
 * @param width - Image width in pixels
 * @param height - Image height in pixels
 * @param maxDistance - Maximum ray-march distance in pixels (default 32)
 * @param slopeThreshold - Central sun elevation as tan(angle): higher = higher sun = shorter shadows (default 2.5)
 * @param shadowStrength - Umbra depth: values close to 0 are darker (default 0.55)
 * @param sunSpread - Angular half-spread of the sun disc as a fraction of slopeThreshold.
 *   Controls penumbra width; 0.2 = ±20 % of the central angle (default 0.2)
 * @param numberOfRays - Number of sample rays (odd numbers give a symmetric distribution; default 5)
 * @returns Float32Array where 1.0 = fully lit, shadowStrength = full umbra
 */

/**
 * Returns true when a single NW-diagonal ray from (startX, startZ) is blocked
 * by terrain within maxDistance steps.
 *
 * @param heights - Decoded height map
 * @param width - Image width
 * @param startX - Ray origin X
 * @param startZ - Ray origin Z
 * @param maxDistance - Maximum ray length
 * @param baseH - Height at the ray origin
 * @param thresh - Slope threshold for this ray (tan of sun elevation)
 * @returns `true` when any caster along the ray is taller than the origin
 */
function marchRayBlocked(
    heights: Float32Array,
    width: number,
    startX: number,
    startZ: number,
    maxDistance: number,
    baseH: number,
    thresh: number,
): boolean {
    for (let d = 1; d <= maxDistance; d++) {
        const sx = startX - d;
        const sz = startZ - d;
        if (sx < 0 || sz < 0) { return false; }
        const marchH = heights[sz * width + sx];
        if (marchH > baseH + d * thresh) { return true; }
    }
    return false;
}

/**
 * Count how many rays in `rayThresholds` are blocked for the pixel at (x, z).
 * Extracted to keep `computeHardShadowMap`'s loop nesting depth within the limit.
 *
 * @param heights - Decoded height map
 * @param width - Image width
 * @param x - Pixel X coordinate
 * @param z - Pixel Z coordinate
 * @param maxDistance - Maximum ray length in pixels
 * @param baseH - Height at the pixel
 * @param rayThresholds - Per-ray slope thresholds
 * @returns Number of blocked rays (0 to rayThresholds.length)
 */
function countBlockedRays(
    heights: Float32Array,
    width: number,
    x: number,
    z: number,
    maxDistance: number,
    baseH: number,
    rayThresholds: readonly number[],
): number {
    let count = 0;
    for (const thresh of rayThresholds) {
        if (marchRayBlocked(heights, width, x, z, maxDistance, baseH, thresh)) { count++; }
    }
    return count;
}

export function computeHardShadowMap(
    heights: Float32Array,
    width: number,
    height: number,
    maxDistance = 32,
    slopeThreshold = 2.5,
    shadowStrength = 0.55,
    sunSpread = 0.2,
    numberOfRays = 5,
): Float32Array {
    const shadow = new Float32Array(width * height).fill(1);
    const halfSpread = slopeThreshold * sunSpread;
    // Pre-compute per-ray slope thresholds (evenly spaced across sun disc)
    const rayThresholds: number[] = [];
    for (let r = 0; r < numberOfRays; r++) {
        const t = numberOfRays === 1 ? 0 : (r / (numberOfRays - 1)) * 2 - 1; // -1..+1
        rayThresholds.push(slopeThreshold + t * halfSpread);
    }
    for (let z = 0; z < height; z++) {
        for (let x = 0; x < width; x++) {
            const baseH = heights[z * width + x];
            const blockedCount = countBlockedRays(heights, width, x, z, maxDistance, baseH, rayThresholds);
            if (blockedCount > 0) {
                const fraction = blockedCount / numberOfRays; // 0..1: penumbra blend
                shadow[z * width + x] = 1 - fraction * (1 - shadowStrength);
            }
        }
    }
    return shadow;
}

/**
 * Neighbour-count ambient occlusion — integer 8-neighbour height comparison.
 *
 * For each pixel, counts how many of its 8 cardinal + diagonal neighbours
 * are strictly higher. More higher neighbours → more occlusion → darker.
 * Produces subtle darkening in corners, crevices and concave valleys near
 * block edges without the blobby halo artefacts of radius-based SSAO.
 *
 * @param heights - Decoded height values (width × height)
 * @param width - Image width in pixels
 * @param height - Image height in pixels
 * @param strength - Maximum darkening when all 8 neighbours are higher (default 0.35)
 * @returns Float32Array where 1.0 = fully open, (1 - strength) = maximally occluded
 */
export function computeNeighborAO(
    heights: Float32Array,
    width: number,
    height: number,
    strength = 0.35,
): Float32Array {
    const ao = new Float32Array(width * height).fill(1);
    const neighbors: readonly (readonly [number, number])[] = [
        [-1, -1], [0, -1], [1, -1],
        [-1,  0],           [1,  0],
        [-1,  1], [0,  1], [1,  1],
    ];

    /**
     * Count neighbours (from the pre-built offsets list) that are strictly higher
     * than `h`. Extracted to keep outer loop nesting depth within the 3-level limit.
     *
     * @param x - Pixel X coordinate
     * @param z - Pixel Z coordinate
     * @param h - Height baseline to compare neighbours against
     * @returns Number of neighbours strictly higher than `h` (0–8)
     */
    const countHigher = (x: number, z: number, h: number): number => {
        let count = 0;
        for (const [dx, dz] of neighbors) {
            const nx = x + dx;
            const nz = z + dz;
            if (nx < 0 || nx >= width || nz < 0 || nz >= height) { continue; }
            if (heights[nz * width + nx] > h) { count++; }
        }
        return count;
    };
    for (let z = 0; z < height; z++) {
        for (let x = 0; x < width; x++) {
            const h = heights[z * width + x];
            ao[z * width + x] = 1 - (countHigher(x, z, h) / 8) * strength;
        }
    }
    return ao;
}

// ============================================================================
// Heightmap Quantization (Phase 2)
// ============================================================================

/**
 * Extract a sub-region of RGBA pixels from a full source buffer.
 *
 * Used when splitting a dual-layer source tile into canonical sub-tiles.
 * Returns a new Buffer containing only the extracted region's pixels.
 *
 * @param rgba - Full source RGBA buffer (4 bytes per pixel)
 * @param sourceWidth - Width of the full source in pixels
 * @param startX - Left column of the sub-region (in pixels)
 * @param startZ - Top row of the sub-region (in pixels)
 * @param subWidth - Width of the sub-region
 * @param subHeight - Height of the sub-region
 * @returns New Buffer with extracted RGBA pixel data (subWidth × subHeight × 4 bytes)
 */
export function extractSubRegionRgba(
    rgba: Buffer | Uint8Array,
    sourceWidth: number,
    startX: number,
    startZ: number,
    subWidth: number,
    subHeight: number
): Buffer {
    const sub = Buffer.alloc(subWidth * subHeight * 4);
    const sourceRowBytes = sourceWidth * 4;
    const subRowBytes = subWidth * 4;
    for (let z = 0; z < subHeight; z++) {
        const sourceOffset = (startZ + z) * sourceRowBytes + startX * 4;
        const destinationOffset = z * subRowBytes;
        if (Buffer.isBuffer(rgba)) {
            rgba.copy(sub, destinationOffset, sourceOffset, sourceOffset + subRowBytes);
        } else {
            sub.set(rgba.subarray(sourceOffset, sourceOffset + subRowBytes), destinationOffset);
        }
    }
    return sub;
}

/**
 * Extract a sub-region of heights from a full-tile heightmap.
 *
 * Used when splitting a source tile into canonical sub-tiles —
 * each sub-tile gets its corresponding slice of the heightmap.
 *
 * @param heights - Full-tile decoded heights (sourceWidth × sourceHeight)
 * @param sourceWidth - Width of the full source heightmap
 * @param startX - Left column of the sub-region (in pixels)
 * @param startZ - Top row of the sub-region (in pixels)
 * @param subWidth - Width of the sub-region
 * @param subHeight - Height of the sub-region
 * @returns Float32Array of heights for the sub-region (subWidth × subHeight)
 */
export function extractSubHeights(
    heights: Float32Array,
    sourceWidth: number,
    startX: number,
    startZ: number,
    subWidth: number,
    subHeight: number
): Float32Array {
    const sub = new Float32Array(subWidth * subHeight);
    for (let z = 0; z < subHeight; z++) {
        for (let x = 0; x < subWidth; x++) {
            sub[z * subWidth + x] = heights[(startZ + z) * sourceWidth + (startX + x)];
        }
    }
    return sub;
}

/**
 * Quantize a Float32 heightmap to 8-bit grayscale for compact storage.
 *
 * Maps the height range [min, max] linearly to [0, 255].
 * If all heights are equal (flat terrain), all pixels are set to 128.
 *
 * @param heights - Float32 height values
 * @param width - Heightmap width in pixels
 * @param height - Heightmap height in pixels
 * @returns Quantized data buffer with min/max metadata for dequantization
 */
export function quantizeHeightmap(
    heights: Float32Array,
    width: number,
    height: number
): QuantizedHeightmap {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;

    const pixelCount = width * height;
    for (let i = 0; i < pixelCount; i++) {
        if (heights[i] < min) { min = heights[i]; }
        if (heights[i] > max) { max = heights[i]; }
    }

    const data = Buffer.alloc(pixelCount);
    const range = max - min;

    if (range === 0) {
        // Flat terrain — all pixels at midpoint
        data.fill(128);
    } else {
        for (let i = 0; i < pixelCount; i++) {
            data[i] = Math.round(255 * (heights[i] - min) / range);
        }
    }

    return { data, min: Math.round(min), max: Math.round(max) };
}

/**
 * Check if a source tile image dimensions indicate a BlueMap dual-layer tile.
 *
 * BlueMap dual-layer tiles have height ≈ 2× width (e.g., 501×1002).
 * Dynmap tiles are square (e.g., 512×512).
 *
 * @param imageWidth - Source image width in pixels
 * @param imageHeight - Source image height in pixels
 * @returns true if the image appears to be a dual-layer BlueMap tile
 */
export function isDualLayerTile(imageWidth: number, imageHeight: number): boolean {
    return imageHeight > imageWidth * 1.5;
}
