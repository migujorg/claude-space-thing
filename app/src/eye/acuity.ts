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

// ── The filter's image chain (PYRAMID_SHADER downTiling; COMPOSITE_SHADER acuAt) ─────────────────────────────
// The extended image as a chain of levels, each about half the one above. It is one texture with mips: its base is
// the frame's rounded-up half, and every further mip the rounded-down half of the one above (WebGPU's rule). Each
// level tiles the frame: a texel is the mean of the interval of the level above that it covers, and the read maps a
// position onto a level by the level's size. Until October 2026 the chain was made with the veil pyramid's `down`
// (rows 2p and 2p+1, zero beyond): at an odd side the last row or column of the level above was never read, and at
// an odd frame size the base's last texel was averaged with zero (a dark last line on the screen).
// The functions below are the float reference of that shader code and of its sizes.

/**
 * Sides of the chain's levels along one axis: `base` (the frame's rounded-up half, frameSizing.ts acuW or acuH),
 * then each mip the rounded-down half of the one above, `mips` levels in all.
 */
export function acuityChainSides(base: number, mips: number): number[] {
  const s = [base];
  while (s.length < mips) s.push(Math.max(1, Math.floor(s[s.length - 1] / 2)));
  return s;
}

/**
 * How texel p of a level with `nDst` texels takes the texels of the level above, which has `nSrc`: p covers the
 * interval [p·nSrc/nDst, (p+1)·nSrc/nDst) of it, and each texel there counts by the share of the interval it fills.
 * In integers, as the shader has it (units of 1/nDst of a source texel), so the weights are exact: two of one half
 * where nSrc = 2·nDst, three where nSrc is odd.
 */
export function tilingTaps(p: number, nSrc: number, nDst: number): { first: number; weights: number[] } {
  const a = p * nSrc, first = Math.floor(a / nDst), weights: number[] = [];
  for (let i = first; i < first + 3; i++) {
    const w = Math.min(a + nSrc, (i + 1) * nDst) - Math.max(a, i * nDst);
    if (w > 0) weights.push(w / nSrc);
  }
  return { first, weights };
}

/** PYRAMID_SHADER `downTiling` in single precision: the level (wd × hd) below an image of w × h. */
export function downTiling(src: Float32Array, w: number, h: number, wd: number, hd: number): Float32Array {
  const f = Math.fround, o = new Float32Array(wd * hd);
  const tx = Array.from({ length: wd }, (_, x) => tilingTaps(x, w, wd)), ty = Array.from({ length: hd }, (_, y) => tilingTaps(y, h, hd));
  for (let y = 0; y < hd; y++) for (let x = 0; x < wd; x++) {
    const X = tx[x], Y = ty[y];
    let s = 0;
    // Rows outside, columns inside, as the shader sums: where both sides are even this is `down` to the bit.
    for (let j = 0; j < Y.weights.length; j++) for (let i = 0; i < X.weights.length; i++) {
      s = f(s + f(src[(Y.first + j) * w + X.first + i] * f(f(X.weights[i]) * f(Y.weights[j]))));
    }
    o[y * wd + x] = s;
  }
  return o;
}

/**
 * Where COMPOSITE_SHADER `acuAt` reads a level along one axis for the frame position q (pixels, at pixel centres
 * i + ½): in the level's texel units with texel centres at whole numbers. The level's texels tile the frame, so the
 * frame maps onto the level by the level's size. Single precision, as the shader computes it.
 */
export function acuityReadPos(q: number, frameSide: number, levelSide: number): number {
  const f = Math.fround;
  return f(f(q * f(levelSide / frameSide)) - 0.5);
}
