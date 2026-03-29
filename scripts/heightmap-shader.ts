/**
 * Heightmap Decode Module
 *
 * Pure functions for decoding BlueMap dual-layer tile metadata.
 * No I/O or sharp dependency — all functions operate on raw pixel buffers.
 *
 * BlueMap encodes heightmap metadata in the bottom half of its dual-layer
 * 501×1002 PNG tiles. Each pixel's RGBA channels encode:
 *   R = block light (0–15, as R/255×15)
 *   G = height high byte
 *   B = height low byte
 *   A = unused
 *
 * Height decoding: `height = G×256 + B` (unsigned; signed at 32768).
 *
 * @module scripts/heightmap-shader
 */

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
// Sub-region Extraction
// ============================================================================

/**
 * Extract a rectangular RGBA sub-region from a larger RGBA pixel buffer.
 *
 * @param rgba - Source RGBA buffer (sourceWidth × sourceHeight × 4 bytes)
 * @param sourceWidth - Width of the source image in pixels
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

// ============================================================================
// Height Encoding
// ============================================================================

/**
 * Encode a signed height value back to unsigned G (high) and B (low) bytes.
 *
 * Inverse of the heightmap decode: `unsigned = G×256 + B`, with values ≥ 32768
 * representing negative heights.
 *
 * @param height - Signed height value
 * @returns [G, B] byte pair
 */
export function encodeHeight(height: number): [number, number] {
    const unsigned = height < 0 ? 65535 + height : height;
    return [(unsigned >> 8) & 0xFF, unsigned & 0xFF];
}

// ============================================================================
// Meta Downsampling (max-per-cell)
// ============================================================================

/**
 * Downsample a meta RGBA buffer using max-per-cell for both blocklight and height.
 *
 * Each output pixel represents the maximum blocklight (R) and maximum height
 * (G,B decoded → max → re-encoded) of a `scale × scale` cell of input pixels.
 *
 * This preserves shadow-casting peaks, slope magnitude, AO local maxima, and
 * glow LOS terrain for coarser zoom levels.
 *
 * @param metaRgba - Source meta RGBA buffer (R=blocklight 0-255, G=height-hi, B=height-lo, A=255)
 * @param srcWidth - Source width in pixels
 * @param srcHeight - Source height in pixels
 * @param scale - Downsample factor (e.g. 4 for a 4×4 cell → 1 pixel)
 * @returns Downsampled RGBA buffer (srcWidth/scale × srcHeight/scale × 4 bytes)
 */
export function downsampleMetaMax(
    metaRgba: Buffer | Uint8Array,
    srcWidth: number,
    srcHeight: number,
    scale: number,
): Buffer {
    const dstWidth = Math.floor(srcWidth / scale);
    const dstHeight = Math.floor(srcHeight / scale);
    const out = Buffer.alloc(dstWidth * dstHeight * 4);

    for (let dz = 0; dz < dstHeight; dz++) {
        for (let dx = 0; dx < dstWidth; dx++) {
            let maxR = 0;
            let maxHeight = -Infinity;

            for (let sz = 0; sz < scale; sz++) {
                for (let sx = 0; sx < scale; sx++) {
                    const srcIdx = ((dz * scale + sz) * srcWidth + (dx * scale + sx)) * 4;
                    const r = metaRgba[srcIdx] ?? 0;
                    const g = metaRgba[srcIdx + 1] ?? 0;
                    const b = metaRgba[srcIdx + 2] ?? 0;

                    if (r > maxR) { maxR = r; }

                    const unsigned = g * 256 + b;
                    const height = unsigned >= 32_768 ? -(65_535 - unsigned) : unsigned;
                    if (height > maxHeight) { maxHeight = height; }
                }
            }

            const dstIdx = (dz * dstWidth + dx) * 4;
            out[dstIdx] = maxR;

            const [gHi, bLo] = encodeHeight(maxHeight === -Infinity ? 0 : maxHeight);
            out[dstIdx + 1] = gHi;
            out[dstIdx + 2] = bLo;
            out[dstIdx + 3] = 255;
        }
    }

    return out;
}

// ============================================================================
// Dual-Layer Detection
// ============================================================================

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
