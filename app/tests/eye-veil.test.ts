// The veil pyramid at the frame's edges (eye/veil.ts, the CPU twin of PYRAMID_SHADER; docs/eye-model.md §3).
// The model: the frame's image on an unbounded dark canvas. Light the eye scatters beyond the frame is lost; light
// that stays inside is not. The reference here is that canvas made finite and written WITHOUT the ring: the pyramid's
// arithmetic with nothing kept beyond a level's edge (ring 0), run on the frame's image surrounded by a dark margin
// as wide as the coarsest level's texel, so that the texel grid is the frame's and no level's own edge is within its
// texel of the frame.
import { describe, expect, it } from 'vitest';
import { fitScatterKernel } from '../src/eye/glare';
import { VEIL_BLUR_TAPS, VEIL_RING, veilLevelSize } from '../src/eye/points';
import { veilLevelAxis, veilLevelSizes, veilPyramid, veilRead, veilTexel } from '../src/eye/veil';

/** The CIE 146 fit's weights for a W × H frame at a vertical field of fovDeg (renderer.ts: pyramidSigma, glareCache). */
function fittedWeights(W: number, H: number, fovDeg: number): number[] {
  const sigma = (k: number) => { const p = 4 ** k; return Math.sqrt(p + (p - 1) / 12 + (4 * p - 4) / 18); };
  const pixelDeg = ((2 * Math.tan((fovDeg * Math.PI) / 360)) / H) * (180 / Math.PI);
  return fitScatterKernel(veilLevelSizes(W, H).map((_, k) => ({ sigmaPx: sigma(k) })), pixelDeg, Math.hypot(W, H), 25, 0.5).weights;
}
/** Level k alone of a row on the dark-margin canvas (no ring), cut back to the row's own pixels. */
function axisWithMargin(row: Float64Array, k: number, K: number): Float64Array {
  const M = 2 ** K, big = new Float64Array(row.length + 2 * M);
  big.set(row, M);
  return veilLevelAxis(big, k, 0).slice(M, M + row.length);
}
/** The whole pyramid on the dark-margin canvas (no ring), cut back to the frame: the veil of every pixel. */
function veilWithMargin(base: Float64Array, W: number, H: number, weights: number[]): Float64Array {
  const M = 2 ** (weights.length - 1), BW = W + 2 * M, BH = H + 2 * M, big = new Float64Array(BW * BH);
  for (let y = 0; y < H; y++) big.set(base.subarray(y * W, (y + 1) * W), (y + M) * BW + M);
  const acc = veilPyramid(big, BW, BH, weights, 0)[0], out = new Float64Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out[y * W + x] = veilTexel(acc, x + M, y + M);
  return out;
}
const places = (W: number, H: number): [string, number, number][] => [
  ['centre', W >> 1, H >> 1], ['mid top', W >> 1, 0], ['mid bottom', W >> 1, H - 1], ['mid left', 0, H >> 1], ['mid right', W - 1, H >> 1],
  ['top left', 0, 0], ['top right', W - 1, 0], ['bottom left', 0, H - 1], ['bottom right', W - 1, H - 1],
];
let seed = 20261008;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };

describe('the veil at the frame\'s edges: the pyramid holds what it holds on an unbounded dark canvas', () => {
  it('there is one ring of texels beyond each level\'s edge', () => {
    expect(VEIL_RING).toBe(1);
  });

  it('a uniform frame: the veil at the centre, the mid-edges and the corners equals the dark-margin canvas\'s, at even and odd sizes', () => {
    // 1280 × 720 (the suite's frame), 1283 × 723 (odd), 250 × 250 and 1375 × 138 (validation frames), 97 × 61 (odd at every level)
    for (const [W, H] of [[1280, 720], [1283, 723], [250, 250], [1375, 138], [97, 61]]) {
      const w = fittedWeights(W, H, 50), K = w.length - 1;
      const acc = veilPyramid(new Float64Array(W * H).fill(1), W, H, w)[0];
      // The reference per axis: a uniform frame is the product of two uniform rows, and every stage is the same
      // operation along x and along y (the two-dimensional reference is the next test).
      const onesX = new Float64Array(W).fill(1), onesY = new Float64Array(H).fill(1);
      const X: Float64Array[] = [], Y: Float64Array[] = [];
      for (let k = 0; k <= K; k++) { X.push(axisWithMargin(onesX, k, K)); Y.push(axisWithMargin(onesY, k, K)); }
      for (const [name, x, y] of places(W, H)) {
        const ref = w.reduce((a, wk, k) => a + wk * X[k][x] * Y[k][y], 0);
        expect(Math.abs(veilTexel(acc, x, y) / ref - 1), `${W} × ${H}, ${name}`).toBeLessThan(1e-12);
      }
    }
  });

  it('a disk cut by the edge, and a random image: every pixel equals the dark-margin canvas run in two dimensions', () => {
    for (const [W, H] of [[97, 61], [96, 54], [131, 77]]) {
      const w = fittedWeights(W, H, 50);
      const disk = new Float64Array(W * H), noise = new Float64Array(W * H);
      // a bright disk whose centre is inside the frame, a third of it beyond the bottom edge; dark elsewhere
      const cx = 0.55 * W, cy = H - 4.3, r = 0.2 * H;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) disk[y * W + x] = 3000;
        noise[y * W + x] = rnd();
      }
      for (const [name, image] of [['disk', disk], ['random', noise]] as const) {
        const acc = veilPyramid(image, W, H, w)[0], ref = veilWithMargin(image, W, H, w);
        let peak = 0, worst = 0;
        for (let i = 0; i < W * H; i++) peak = Math.max(peak, ref[i]);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) worst = Math.max(worst, Math.abs(veilTexel(acc, x, y) - ref[y * W + x]));
        expect(worst / peak, `${W} × ${H}, ${name}`).toBeLessThan(1e-13);
        // and far from the bright disk the veil is there at all: the corner above it holds light of the coarse levels
        if (name === 'disk') expect(ref[0]).toBeGreaterThan(0);
      }
    }
  });

  it('the level a point\'s background reads continues into the ring as the dark-margin canvas\'s level does', () => {
    const W = 97, H = 61, w = fittedWeights(W, H, 50), K = w.length - 1, M = 2 ** K;
    const image = new Float64Array(W * H);
    for (let i = 0; i < W * H; i++) image[i] = rnd();
    const acc = veilPyramid(image, W, H, w);
    const BW = W + 2 * M, BH = H + 2 * M, big = new Float64Array(BW * BH);
    for (let y = 0; y < H; y++) big.set(image.subarray(y * W, (y + 1) * W), (y + M) * BW + M);
    const ref = veilPyramid(big, BW, BH, w, 0);
    for (let k = 0; k <= K; k++) {
      // every texel of the level and of its ring
      const o = M / 2 ** k;
      for (let y = -1; y <= veilLevelSize(H, k); y++) for (let x = -1; x <= veilLevelSize(W, k); x++) {
        expect(Math.abs(veilTexel(acc[k], x, y) - veilTexel(ref[k], x + o, y + o)), `level ${k} texel (${x}, ${y})`).toBeLessThan(1e-13);
      }
      // the read at the frame's edges: the same number as the unbounded level read at that place, unclamped
      for (const [px, py] of [[0.2, 0.3], [W - 0.25, H - 0.1], [0.4, H / 2], [W / 2, 0.05], [W - 0.01, 0.01]]) {
        expect(Math.abs(veilRead(acc[k], k, px, py) - veilRead({ ...ref[k], ring: 0 }, k, px + M, py + M)), `level ${k} read at (${px}, ${py})`).toBeLessThan(1e-13);
      }
    }
  });

  it('the numbers at 1280 × 720 and a 50° field: mid-edge 0.592, corner 0.377, centre 0.935 of L·Σw, and 91.5 % of the veil stays in the frame', () => {
    const W = 1280, H = 720, w = fittedWeights(W, H, 50), total = w.reduce((a, b) => a + b, 0);
    const acc = veilPyramid(new Float64Array(W * H).fill(1), W, H, w)[0];
    const at = (x: number, y: number) => veilTexel(acc, x, y) / total;
    expect(at(W >> 1, 0)).toBeCloseTo(0.59207, 4);
    expect(at(0, 0)).toBeCloseTo(0.37718, 4);
    expect(at(W >> 1, H >> 1)).toBeCloseTo(0.93456, 4);
    let inside = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) inside += veilTexel(acc, x, y);
    // The rest is scattered beyond the frame and lost (§3). Without the ring these were 0.48621, 0.29221, 0.93372
    // and 0.90847: 17.9 %, 22.5 %, 0.09 % and 0.76 % low.
    expect(inside / (total * W * H)).toBeCloseTo(0.91539, 4);
    // Nothing is created: over the unbounded canvas a level's kernel sums to what its seven taps sum to, which is
    // one less 1e-8 (the taps are written to eight decimals).
    const M = 2 ** (w.length - 1), lit = new Float64Array(64 + 2 * M);
    lit[M + 37] = 1;
    const taps = VEIL_BLUR_TAPS[0] + 2 * (VEIL_BLUR_TAPS[1] + VEIL_BLUR_TAPS[2] + VEIL_BLUR_TAPS[3]);
    expect(Math.abs(taps - 1)).toBeLessThan(2e-8);
    for (const k of [0, 3, 7]) expect(veilLevelAxis(lit, k, 0).reduce((a, b) => a + b, 0)).toBeCloseTo(taps, 12);
  });
});
