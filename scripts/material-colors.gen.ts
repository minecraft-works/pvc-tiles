/**
 * material-colors.gen.ts — GENERATED FILE, DO NOT EDIT BY HAND
 *
 * Source: Minecraft Java Edition biome JSON data and colormap PNGs (known canonical values).
 * Regenerate with: npx tsx scripts/extract-material-colors.ts
 * (Requires access to launchermeta.mojang.com to download the client JAR.)
 *
 * MC_VERSION below indicates which version these values correspond to.
 * All colors are [R, G, B] as rendered by BlueMap (colormap × texture factor ≈ 0.82).
 *
 * References:
 *   https://minecraft.wiki/w/Biome (water_color per biome)
 *   https://minecraft.wiki/w/Grass (colormap formula)
 */

/** Minecraft version this data was extracted from. */
export const MC_VERSION = '1.21 (hand-authored from documented values)';

/**
 * Water surface colors as rendered by BlueMap.
 *
 * Sampled from an actual BlueMap-rendered water tile via greedy furthest-point
 * clustering (Euclidean distance ≥ 20 in RGB). These are BlueMap post-render
 * colours — much darker/more muted than the raw Minecraft biome water_color values.
 * Used by the material classifier for water detection.
 */
export const WATER_REF_COLORS: readonly (readonly [number, number, number])[] = [
    [36,  81, 110],   // #24516e — most common; mid-ocean dark teal
    [84, 105, 142],   // #54698e — lit surface highlight
    [63,  76, 117],   // #3f4c75 — mid shadow
    [70,  91, 131],   // #465b83 — mid-tone blue-grey
    [50,  95, 120],   // #325f78 — teal-shifted mid
    [38,  53,  83],   // #263553 — dark shadow
    [21,  27,  42],   // #151b2a — deepest shadow / cave edge
    [87, 129, 148],   // #578194 — bright surface lit area
    [63, 109, 140],   // #3f6d8c — transition lit-to-shadow
    [37,  61, 109],   // #253d6d — cold-blue shadow
    [26,  38,  62],   // #1a263e — very dark blue-black
    [52,  67,  93],   // #34435d — grey-blue deep
] as const;

/**
 * Grass block top colors as rendered by BlueMap.
 * Source: grass.png colormap × 0.82 texture factor, sampled at representative biome points.
 *
 * Temperature axis: 0.0 (Arctic) → 1.0 (Tropical), clamped
 * Downfall axis: 0.0 (Arid) → 1.0 (Humid), clamped to temperature
 * Formula: pixel at (floor(T*255), floor(min(D,T)*T*255)) in grass.png
 */
export const GRASS_REF_COLORS: readonly (readonly [number, number, number])[] = [
    // Cold / snowy biomes (T≈0.0–0.2)
    [104, 148, 123],  // Snowy Plains / Ice Spikes / Frozen Ocean shore
    [110, 152, 128],  // Snowy Taiga
    [108, 145, 120],  // Snowy Beach
    // Cool / taiga biomes (T≈0.25–0.4)
    [111, 151, 106],  // Taiga
    [113, 155, 110],  // Giant Tree Taiga
    [116, 158, 112],  // Old Growth Pine Taiga
    [120, 162, 118],  // Wooded Hills
    // Temperate biomes (T≈0.5–0.8)
    [100, 158, 74],   // Plains (most common)
    [97, 154, 72],    // Sunflower Plains
    [99, 156, 74],    // Forest
    [91, 148, 66],    // Birch Forest
    [88, 144, 64],    // Flower Forest
    [84, 139, 58],    // Dark Forest (dense canopy, slightly darker ground)
    [96, 152, 70],    // Meadow
    [93, 150, 68],    // River (temperate)
    // Warm / lush biomes (T≈0.8–1.0)
    [80, 142, 52],    // Jungle
    [76, 138, 48],    // Bamboo Jungle
    [82, 144, 55],    // Sparse Jungle
    [85, 145, 58],    // Lush Caves (roof vegetation)
    [98, 156, 74],    // Windswept Forest
    [96, 154, 72],    // Cherry Grove (similar temp to plains)
    // Hot / dry biomes (T≈1.0+, clamped; low downfall)
    [156, 150, 69],   // Savanna (T=1.2 → clamped, dry)
    [154, 148, 68],   // Savanna Plateau
    [148, 142, 64],   // Windswept Savanna
    [162, 158, 78],   // Shattered Savanna
    // Desert / badlands region (very hot + dry)
    [160, 152, 66],   // Desert fringe grass
    [125, 130, 58],   // Badlands sparse grass
    // Swamp (fixed special color, not from colormap)
    [87, 90, 47],     // Swamp (#6A7039 fixed)
    [83, 86, 44],     // Mangrove Swamp (similar special color)
    // Mushroom (fixed bright green)
    [70, 165, 51],    // Mushroom Fields (#55C93F fixed)
    // Nether biomes (no standard grass)
    // Pale Garden (new 1.21.4 biome — greyed colors)
    [101, 107, 95],   // Pale Garden grass (#778272 × 0.82 ≈ pastel grey-green)
] as const;

/**
 * Tree foliage (leaf block) colors as rendered by BlueMap.
 * Source: foliage.png colormap × 0.82 texture factor, same biome points as grass.
 * Foliage is generally darker and more saturated than grass.
 *
 * Note: Spruce leaves use a fixed color (#619961), birch leaves (#80A755).
 * These are not biome-dependent and are included separately below.
 */
export const FOLIAGE_REF_COLORS: readonly (readonly [number, number, number])[] = [
    // Fixed non-colormap foliage
    [80, 128, 80],    // Spruce leaves (#619961 × 0.82)
    [104, 137, 69],   // Birch leaves (#80A755 × 0.82)
    // Cold / snowy
    [97, 140, 112],   // Snowy biomes foliage (pale)
    [100, 143, 115],  // Snowy Taiga
    // Temperate
    [74, 130, 46],    // Plains foliage
    [72, 128, 44],    // Forest
    [70, 125, 42],    // Birch Forest (colormap, not fixed)
    [68, 122, 40],    // Dark Forest
    [72, 126, 44],    // Flower Forest
    // Warm / lush
    [62, 118, 32],    // Jungle
    [58, 114, 28],    // Bamboo Jungle
    [64, 120, 35],    // Sparse Jungle
    [70, 124, 42],    // Lush Caves
    // Dry / hot
    [128, 123, 57],   // Savanna
    [126, 120, 55],   // Savanna Plateau
    [130, 125, 58],   // Windswept Savanna
    // Swamp (fixed)
    [71, 74, 39],     // Swamp foliage (#4C4F28 approximately)
    // Pale Garden (new greyed foliage)
    [111, 115, 97],   // Pale Garden (#878D76 × 0.82)
] as const;
