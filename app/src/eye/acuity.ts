// Low-light loss of spatial resolution (docs/eye-model.md §5b). Pure TS; the composite shader mirrors it.
//
// Foveal grating acuity against the local adaptation luminance, Ward Larson et al.'s (1997) fit to Shlaer
// (1937), applied as they do: the image is resolved only down to the level of an image pyramid whose texel
// is half a cycle at the acuity limit (their "mip map" variable-resolution filter), with the luminance of
// the ~1° foveal field around each pixel (including the veil) as the adaptation.

import { CRUMEY, WARD1997_ACUITY as W } from './constants';

/** Highest resolvable spatial frequency, cycles/degree, at adaptation luminance La (cd/m²; floored at the dark light). */
export function acuityCyclesPerDeg(La: number): number {
  const L = Math.max(La, CRUMEY.zeroBackgroundB);
  return W.scale * Math.atan(W.logSlope * Math.log10(L) + W.logOffset) + W.offset;
}

/**
 * Pyramid level (fractional, 0 = full resolution) whose texel is half a cycle at acuity R, for pixels of
 * `pixelDeg` degrees: log2(1/(2·R·pixelDeg)); 0 when the pixels are coarser than that (no blur).
 */
export function acuityLevel(R: number, pixelDeg: number): number {
  return Math.max(0, Math.log2(1 / (2 * Math.max(R, 1e-6) * pixelDeg)));
}
