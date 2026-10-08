// The retina's veil pyramid on the CPU: the reference for what PYRAMID_SHADER does (render/shaders.ts; render/renderer.ts
// encodePyramid; render/frameSizing.ts), unit-tested (tests/eye-veil.test.ts, tests/eye-points.test.ts). Pure TypeScript.
//
// The veil of everything in the frame is the frame's image convolved with the eye's scatter kernel, realised as a
// pyramid (docs/eye-model.md §3): every level is the mean of 2 × 2 of the one below, blurred with seven taps along
// x and along y, and the levels are added from the coarsest down, each upsampled linearly onto the next.
//
// THE FRAME'S EDGE. The scene beyond the frame is not rendered: the image is dark there, and light the eye scatters
// beyond the frame is lost. That is the same pyramid on an unbounded dark canvas, read inside the frame. A level's
// blur puts light into the texels just beyond the level's edge, and the upsampling of the level below reads them:
// with a texel of level k taking 3/4 of its parent and 1/4 of the parent's neighbour, the outermost texel reads a
// neighbour that lies beyond the edge. So the blurred level and the accumulation keep VEIL_RING texels beyond each
// edge (eye/points.ts). One is enough, and it is exact: texel t of a level reads the level above at
// floor((t + 1/2)/2 − 1/2) and the next, which for t from −1 to n lie from −1 to the level above's n; and the blur
// at −1 … n reads the level itself, which is dark beyond the frame. By induction from the coarsest level the frame
// and its ring never need anything else of the unbounded canvas (tested against a canvas with a dark margin).
//
// Until 8 October 2026 nothing was kept beyond a level's edge, and the upsampling read zero there. The outermost
// pixel of level k then held (3/4)^k of what the level's edge texel holds. A uniform frame's veil was 17 to 18 % low
// at the middle of each edge and 22.5 % low in the corners (1280 × 720, 50° field), and the veil that a bright body
// casts on the far edges of its frame, which only the coarse levels carry, was 88 % low there and 98 % low in the
// corners (measured on the GPU; docs/eye-model.md §10).

import { VEIL_BLUR_TAPS, VEIL_RING, veilLevelSize, veilTexelCoord } from './points';

export type VeilArray = Float64Array | Float32Array;
export type VeilArrayCtor = Float64ArrayConstructor | Float32ArrayConstructor;

/**
 * A level's blurred image or accumulation: w × h texels of the level and `ring` more beyond each edge. Texel (x, y)
 * of the level is data[(y + ring)·(w + 2·ring) + x + ring]; the GPU's textures have the same layout.
 */
export interface VeilLevelImage {
  w: number;
  h: number;
  ring: number;
  data: VeilArray;
}

/** The levels of a W × H frame as the renderer allocates them: halved rounding up, both sides together, to 1 × 1. */
export function veilLevelSizes(W: number, H: number): { w: number; h: number }[] {
  const out = [{ w: W, h: H }];
  while (out[out.length - 1].w > 1 || out[out.length - 1].h > 1) out.push({ w: veilLevelSize(W, out.length), h: veilLevelSize(H, out.length) });
  return out;
}

/** A texel of a level's image, ring included; nothing is kept beyond the ring. */
export function veilTexel(l: VeilLevelImage, x: number, y: number): number {
  const r = l.ring;
  return x >= -r && y >= -r && x < l.w + r && y < l.h + r ? l.data[(y + r) * (l.w + 2 * r) + x + r] : 0;
}

/**
 * PYRAMID_SHADER on whole images: down (every level), blurH and blurV (the levels with weight), accum from the
 * coarsest level down. Returns the accumulation of every level: acc[k] holds the veil at scales from level k up, on
 * level k's texels and its ring. `base` is the frame's image (W × H, row-major); the levels are weights.length, sized
 * by veilLevelSize. `ring` is VEIL_RING; 0 is the arithmetic before the ring (nothing kept beyond an edge), which the
 * tests run on a canvas with a dark margin as the reference. With A = Float32Array every stored value is single
 * precision, as on the GPU.
 */
export function veilPyramid(base: ArrayLike<number>, W: number, H: number, weights: readonly number[], ring: number = VEIL_RING, A: VeilArrayCtor = Float64Array): VeilLevelImage[] {
  const K = weights.length;
  const size = (k: number) => ({ w: veilLevelSize(W, k), h: veilLevelSize(H, k) });
  // down: the mean of 2 × 2; the level is dark beyond the frame, so a texel beyond its edge counts as zero.
  const lvl: VeilArray[] = [A.from(base as ArrayLike<number>)];
  for (let k = 1; k < K; k++) {
    const { w, h } = size(k), { w: pw, h: ph } = size(k - 1), src = lvl[k - 1], o = new A(w * h);
    const ld = (x: number, y: number) => (x < pw && y < ph ? src[y * pw + x] : 0);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o[y * w + x] = (ld(2 * x, 2 * y) + ld(2 * x + 1, 2 * y) + ld(2 * x, 2 * y + 1) + ld(2 * x + 1, 2 * y + 1)) * 0.25;
    lvl.push(o);
  }
  const acc: VeilLevelImage[] = new Array(K);
  const mix = (p: number, q: number, t: number) => p * (1 - t) + q * t;
  for (let k = K - 1; k >= 0; k--) {
    const { w, h } = size(k), rw = w + 2 * ring, rh = h + 2 * ring;
    const out: VeilLevelImage = { w, h, ring, data: new A(rw * rh) };
    let blur: VeilLevelImage | null = null;
    if (weights[k] > 0) {
      // blurH reads the level itself (dark beyond the frame); blurV reads blurH's output, ring included.
      const src = lvl[k];
      const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? src[y * w + x] : 0);
      const tmp: VeilLevelImage = { w, h, ring, data: new A(rw * rh) };
      for (let y = -ring; y < h + ring; y++) for (let x = -ring; x < w + ring; x++) {
        let v = at(x, y) * VEIL_BLUR_TAPS[0];
        for (let t = 1; t <= 3; t++) v += (at(x + t, y) + at(x - t, y)) * VEIL_BLUR_TAPS[t];
        tmp.data[(y + ring) * rw + x + ring] = v;
      }
      blur = { w, h, ring, data: new A(rw * rh) };
      for (let y = -ring; y < h + ring; y++) for (let x = -ring; x < w + ring; x++) {
        let v = veilTexel(tmp, x, y) * VEIL_BLUR_TAPS[0];
        for (let t = 1; t <= 3; t++) v += (veilTexel(tmp, x, y + t) + veilTexel(tmp, x, y - t)) * VEIL_BLUR_TAPS[t];
        blur.data[(y + ring) * rw + x + ring] = v;
      }
    }
    // accum: this level's blur by its weight, plus the level above read linearly at this texel's centre.
    const above = k + 1 < K ? acc[k + 1] : null;
    for (let y = -ring; y < h + ring; y++) for (let x = -ring; x < w + ring; x++) {
      const i = (y + ring) * rw + x + ring;
      let up = 0;
      if (above) {
        const cx = (x + 0.5) * 0.5 - 0.5, cy = (y + 0.5) * 0.5 - 0.5;
        const ix = Math.floor(cx), iy = Math.floor(cy), fx = cx - ix, fy = cy - iy;
        up = mix(mix(veilTexel(above, ix, iy), veilTexel(above, ix + 1, iy), fx), mix(veilTexel(above, ix, iy + 1), veilTexel(above, ix + 1, iy + 1), fx), fy);
      }
      out.data[i] = (blur ? weights[k] * blur.data[i] : 0) + up;
    }
    acc[k] = out;
  }
  return acc;
}

/**
 * A level's accumulation at a full-resolution pixel position (BG bgAt): linear between the texels of level k on that
 * level's own grid. At the frame's edge the read continues into the ring, as on the unbounded canvas, and stops at
 * the ring's end.
 */
export function veilRead(level: VeilLevelImage, k: number, px: number, py: number): number {
  const cx = veilTexelCoord(px, k), cy = veilTexelCoord(py, k);
  const ix = Math.floor(cx), iy = Math.floor(cy), fx = cx - ix, fy = cy - iy;
  const r = level.ring, cl = (t: number, n: number) => Math.min(Math.max(t, -r), n - 1 + r);
  const at = (x: number, y: number) => veilTexel(level, cl(x, level.w), cl(y, level.h));
  return (at(ix, iy) * (1 - fx) + at(ix + 1, iy) * fx) * (1 - fy) + (at(ix, iy + 1) * (1 - fx) + at(ix + 1, iy + 1) * fx) * fy;
}

/**
 * One axis of one level alone (weight 1): the row down-sampled k times, blurred, and upsampled back to full
 * resolution, on the pixels 0 … row.length − 1. Every stage of the pyramid is the same operation along x and along
 * y, so for an image that is a product X(x)·Y(y) level k's veil is veilLevelAxis(X, k)[x] · veilLevelAxis(Y, k)[y].
 * `ring` as in veilPyramid.
 */
export function veilLevelAxis(row: ArrayLike<number>, k: number, ring: number = VEIL_RING): Float64Array {
  const n0 = row.length;
  let v = Float64Array.from(row);
  for (let j = 1; j <= k; j++) {
    const n = veilLevelSize(n0, j), o = new Float64Array(n), src = v;
    for (let p = 0; p < n; p++) o[p] = 0.5 * ((2 * p < src.length ? src[2 * p] : 0) + (2 * p + 1 < src.length ? src[2 * p + 1] : 0));
    v = o;
  }
  // a row with its ring: texel t at index t + ring
  const n = v.length, src = v;
  const at = (t: number) => (t >= 0 && t < n ? src[t] : 0);
  let cur = new Float64Array(n + 2 * ring);
  for (let t = -ring; t < n + ring; t++) {
    let a = at(t) * VEIL_BLUR_TAPS[0];
    for (let d = 1; d <= 3; d++) a += (at(t + d) + at(t - d)) * VEIL_BLUR_TAPS[d];
    cur[t + ring] = a;
  }
  let curN = n;
  for (let j = k - 1; j >= 0; j--) {
    const m = veilLevelSize(n0, j), o = new Float64Array(m + 2 * ring), parent = cur, pn = curN;
    const pat = (t: number) => (t >= -ring && t < pn + ring ? parent[t + ring] : 0);
    for (let t = -ring; t < m + ring; t++) {
      const c = (t + 0.5) * 0.5 - 0.5, i0 = Math.floor(c), fr = c - i0;
      o[t + ring] = pat(i0) * (1 - fr) + pat(i0 + 1) * fr;
    }
    cur = o;
    curN = m;
  }
  return cur.slice(ring, ring + n0);
}
