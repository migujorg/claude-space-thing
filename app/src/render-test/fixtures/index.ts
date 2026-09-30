// ════════════════════════════════════════════════════════════════════════════════════════════
//  TEST FIXTURES — NOT DATA.
//  Hand-entered, approximate values used only by the renderer test page (/render-test.html) to
//  exercise the renderer. They must never be imported by the app or copied into app/public/data
//  (docs/architecture.md §2.1 "No placeholders, ever"). Real values come from the pipeline.
// ════════════════════════════════════════════════════════════════════════════════════════════

import type { PhaseFunction } from '../../data/schema';
import type { StarCatalog } from '../../render/scene';

type XYZS = [number, number, number, number];

/** Approximate extra-atmospheric sunlight at 1 AU: Y ≈ 1.28e5 lux, chromaticity ≈ (0.332, 0.347), S/P ≈ 2.3. */
export const FIXTURE_SUN_IRRADIANCE_1AU: XYZS = (() => {
  const Y = 1.28e5, x = 0.332, y = 0.347;
  return [(Y * x) / y, Y, (Y * (1 - x - y)) / y, 2.3 * Y];
})();
export const FIXTURE_SUN_RADIUS_KM = 695700;
/** Approximate quadratic limb darkening I(μ)/I(1) = c0 + c1 μ + c2 μ² per channel (bluer = darker limb). */
export const FIXTURE_SUN_LIMB: number[][] = [
  [0.36, 0.84, -0.2], // X
  [0.3, 0.93, -0.23], // Y
  [0.2, 1.02, -0.22], // Z
  [0.24, 0.98, -0.22], // S
];

/** A grey planet with geometric albedo 0.3 in every channel. */
export function fixtureGreyAlbedo(p = 0.3): XYZS {
  return FIXTURE_SUN_IRRADIANCE_1AU.map((v) => v * p) as XYZS;
}
/** A pale blue-green planet (per-channel geometric albedos, invented for the test). */
export function fixtureBluishAlbedo(): XYZS {
  const p = [0.36, 0.42, 0.58, 0.55];
  return FIXTURE_SUN_IRRADIANCE_1AU.map((v, i) => v * p[i]) as XYZS;
}
export const FIXTURE_LAMBERT: PhaseFunction = { kind: 'lambert' };

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A synthetic star field: isotropic directions, V magnitudes from N(<m) ∝ 10^(0.5 m) between
 * mMin and mMax, a few colour classes with approximate chromaticities, S/P from Crumey (2014) Eq. 13.
 * Illuminance E_V = 2.54e-6 lux · 10^(−0.4 V).
 */
export function fixtureStars(count: number, seed = 1, mMin = -1.5, mMax = 9): StarCatalog {
  const r = rng(seed);
  const classes = [
    { x: 0.25, y: 0.25, bv: -0.1 },
    { x: 0.29, y: 0.3, bv: 0.1 },
    { x: 0.31, y: 0.32, bv: 0.4 },
    { x: 0.33, y: 0.35, bv: 0.65 },
    { x: 0.38, y: 0.38, bv: 1.1 },
    { x: 0.45, y: 0.41, bv: 1.5 },
  ];
  const stride = 7;
  const data = new Float32Array(count * stride);
  const a = Math.pow(10, 0.5 * mMin), b = Math.pow(10, 0.5 * mMax);
  for (let i = 0; i < count; i++) {
    const z = 2 * r() - 1;
    const phi = 2 * Math.PI * r();
    const s = Math.sqrt(1 - z * z);
    const m = 2 * Math.log10(a + (b - a) * r());
    const c = classes[Math.floor(r() * classes.length)];
    const Y = 2.54e-6 * Math.pow(10, -0.4 * m);
    const sp = Math.pow(10, -0.1094 * c.bv + 0.4378);
    data.set([s * Math.cos(phi), s * Math.sin(phi), z, (Y * c.x) / c.y, Y, (Y * (1 - c.x - c.y)) / c.y, Y * sp], i * stride);
  }
  return { count, data, stride };
}
