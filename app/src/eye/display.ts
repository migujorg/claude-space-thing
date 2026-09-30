// Display encoding: chromatic adaptation (CIECAM02 CAT02), XYZ → linear sRGB (IEC 61966-2-1),
// gamut mapping, and the sRGB transfer function.

import { CAT02, SRGB } from './constants';

export type M3 = [number, number, number, number, number, number, number, number, number];
export type V3 = [number, number, number];

export function mul(m: readonly number[], v: readonly number[]): V3 {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}

export function mulM(a: readonly number[], b: readonly number[]): M3 {
  const r = new Array<number>(9) as M3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
}

export function inv3(m: readonly number[]): M3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

export const XYZ_TO_SRGB: M3 = [...SRGB.xyzToRgb] as M3;
export const SRGB_TO_XYZ: M3 = inv3(XYZ_TO_SRGB);

/** XYZ of the display white (D65) with Y = 1. */
export function displayWhiteXYZ(): V3 {
  return [SRGB.whiteX / SRGB.whiteY, 1, (1 - SRGB.whiteX - SRGB.whiteY) / SRGB.whiteY];
}

/** CIECAM02 degree of adaptation D(L_A) for an average surround. */
export function degreeOfAdaptation(LA: number): number {
  const D = CAT02.surroundF * (1 - (1 / CAT02.dScale) * Math.exp((-LA - CAT02.dOffset) / CAT02.dWidth));
  return Math.min(1, Math.max(0, D));
}

/**
 * Von Kries-type CAT02 transform from an adapted white (e.g. sunlight) to the display white, with
 * degree of adaptation D. Returns a 3×3 matrix acting on XYZ (row-major).
 */
export function cat02Matrix(srcWhiteXYZ: V3, dstWhiteXYZ: V3, D: number): M3 {
  const M = CAT02.m as unknown as M3;
  const Mi = inv3(M);
  const ws = mul(M, srcWhiteXYZ.map((v) => v / srcWhiteXYZ[1]));
  const wd = mul(M, dstWhiteXYZ.map((v) => v / dstWhiteXYZ[1]));
  const g = [0, 1, 2].map((k) => D * (wd[k] / ws[k]) + (1 - D));
  const diag: M3 = [g[0], 0, 0, 0, g[1], 0, 0, 0, g[2]];
  return mulM(Mi, mulM(diag, M));
}

/**
 * Gamut mapping, in linear sRGB relative to the display peak (1 = peak):
 *  1. negative components (outside the sRGB triangle): move toward the achromatic colour of the
 *     same luminance Y until all components are ≥ 0 (constant Y, constant dominant hue);
 *  2. components above 1 (brighter than the display can show in that hue): again move toward the
 *     achromatic colour of the same Y until the largest component is 1; if Y itself exceeds 1 the
 *     result is display white.
 * Documented in docs/eye-model.md §7.
 */
export function gamutMap(rgb: V3): V3 {
  const Y = SRGB_TO_XYZ[3] * rgb[0] + SRGB_TO_XYZ[4] * rgb[1] + SRGB_TO_XYZ[5] * rgb[2];
  // Achromatic (display-white) colour with the same Y: g·(1,1,1), g = Y / (Y of RGB white).
  const g = Y / (SRGB_TO_XYZ[3] + SRGB_TO_XYZ[4] + SRGB_TO_XYZ[5]);
  if (g >= 1) return [1, 1, 1];
  if (g <= 0) return [0, 0, 0];
  let t = 1; // fraction of chroma kept
  for (let k = 0; k < 3; k++) {
    const c = rgb[k];
    if (c < 0) t = Math.min(t, g / (g - c));
    if (c > 1) t = Math.min(t, (1 - g) / (c - g));
  }
  return [g + t * (rgb[0] - g), g + t * (rgb[1] - g), g + t * (rgb[2] - g)];
}

/** IEC 61966-2-1 sRGB encoding of a linear value in [0, 1]. */
export function srgbEncode(c: number): number {
  if (c <= SRGB.encodeThreshold) return SRGB.linearSlope * c;
  return SRGB.gammaScale * Math.pow(c, 1 / SRGB.gamma) - SRGB.gammaOffset;
}

export function srgbDecode(v: number): number {
  if (v <= SRGB.encodeThreshold * SRGB.linearSlope) return v / SRGB.linearSlope;
  return Math.pow((v + SRGB.gammaOffset) / SRGB.gammaScale, SRGB.gamma);
}
