// Low-light loss of spatial resolution (docs/eye-model.md §5b). Pure TS; the composite shader mirrors it.
//
// Foveal grating acuity against the adaptation luminance of the fovea, Ward Larson et al.'s (1997) fit to Shlaer
// (1937), applied as they do: the image is resolved only down to the level of an image pyramid whose texel
// is half a cycle at the acuity limit (their "mip map" variable-resolution filter).
//
// What the fovea is adapted to is this model's own rule, not theirs. They take the mean luminance of the 1° field
// plus the veil (their Eq. 12). Here the eye adapts to what it looks at by its light (§2): the fovea's adaptation at
// a pixel is the frame's adaptation statistic taken over the 1° field around that pixel (fovealAdaptation). Until
// October 2026 the filter used their area mean, while the frame's adaptation used the light: a small bright body in
// a dark field was then blurred with the acuity of a dark-adapted fovea by an eye adapted to the body.

import { CRUMEY, WARD1997_ACUITY as W } from './constants';
import { fixationAdaptation, type RetinalSample } from './fixation';

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

/**
 * The adaptation luminance (photopic, cd/m²) of the fovea looking at a pixel, for the acuity there: the frame's
 * adaptation statistic (fixation.ts: the log-average of the retinal image weighted by the light that can be seen)
 * over the samples of the 1° field around the pixel. A uniform field gives its own retinal luminance; a small
 * bright body in a dark field gives the body's, not the field's mean.
 *
 * The solar disk is not excluded here as it is from the frame's fixations (§2: one cannot look at it): the filter
 * asks with what acuity each pixel is shown, with the fovea on that pixel by construction. A field inside the disk
 * would otherwise have no weight at all.
 */
export function fovealAdaptation(field: RetinalSample[]): number {
  return fixationAdaptation(field.map((s) => ({ ...s, onSunDisk: false })), 'brightness').coneCdM2;
}

/**
 * Level (fractional, ≥ 0) of the adaptation pass's block-sum pyramid whose texel spans the 1° field: level 0
 * holds one sum per block of `blockPx` pixels of `pixelDeg` degrees, each level doubles the texel. Where a block
 * is already coarser than 1° the finest level is used.
 */
export function fovealFieldLevel(pixelDeg: number, blockPx: number): number {
  return Math.max(0, Math.log2(1 / (blockPx * pixelDeg)));
}

/**
 * Size of the block-sum texture for `blocksX` × `blocksY` blocks: each side the next power of two. A mip chain
 * halves each side rounding down, so with any other size a level drops the last odd row or column of the one
 * below, and a body there would be missing from the 1° field of its own pixels. The padding holds zero sums
 * (no weight), which change no ratio.
 */
export function fovealSumsSize(blocksX: number, blocksY: number): [number, number] {
  const pow2 = (n: number) => { let p = 1; while (p < n) p *= 2; return p; };
  return [pow2(blocksX), pow2(blocksY)];
}
