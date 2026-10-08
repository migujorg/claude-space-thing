// Low-light acuity (eye/acuity.ts): Ward Larson et al. (1997) Eq. 15 against the values quoted in their text,
// and the pyramid level it selects.
import { describe, expect, it } from 'vitest';
import { acuityCyclesPerDeg, acuityLevel, fovealAdaptation, fovealFieldLevel, fovealSumsSize, acuityChainSides, acuityReadPos, downTiling, tilingTaps } from '../src/eye/acuity';
import { frameSize, type FrameLimits } from '../src/render/frameSizing';
import { ADAPT_TILE_PX } from '../src/render/shaders';

// WebGPU baseline limits (allocation geometry only; no GPU is involved).
const LIMITS: FrameLimits = { maxTextureDimension2D: 8192, maxTextureDimension3D: 2048, maxBufferSize: 256 * 2 ** 20, maxStorageBufferBindingSize: 128 * 2 ** 20, maxComputeWorkgroupsPerDimension: 65535 };
import type { RetinalSample } from '../src/eye/fixation';

describe('acuity against luminance (Ward Larson et al. 1997, fit to Shlaer 1937)', () => {
  it('reproduces the values in the paper\'s text', () => {
    // "an average level around 25 cd/m², corresponding to a visual acuity of about 45 cycles/degree";
    // "around 0.05 cd/m², corresponding to a visual acuity of about nine cycles/degree".
    expect(acuityCyclesPerDeg(25)).toBeGreaterThan(43);
    expect(acuityCyclesPerDeg(25)).toBeLessThan(47);
    expect(acuityCyclesPerDeg(0.05)).toBeGreaterThan(8);
    expect(acuityCyclesPerDeg(0.05)).toBeLessThan(10.5);
    // "At daylight levels ... about 50 cycles/degree"; "near the limits of vision ... about two".
    expect(acuityCyclesPerDeg(1e4)).toBeGreaterThan(48);
    expect(acuityCyclesPerDeg(1e-5)).toBeLessThan(2.5);
    expect(acuityCyclesPerDeg(1e-9)).toBe(acuityCyclesPerDeg(1e-5)); // floored at the dark light
  });
  it('increases with luminance', () => {
    let prev = 0;
    for (let e = -5; e <= 5; e += 0.5) { const r = acuityCyclesPerDeg(10 ** e); expect(r).toBeGreaterThan(prev); prev = r; }
  });
  it('selects the pyramid level whose texel is half a cycle; none when pixels are coarser', () => {
    // 0.01°/px: 2 cycles/degree needs 25 px per half cycle → level log2(25).
    expect(acuityLevel(2, 0.01)).toBeCloseTo(Math.log2(25), 9);
    // 1080 px over 50°: 0.046°/px, Nyquist 10.8 cycles/degree; daylight acuity (50) needs no blur.
    expect(acuityLevel(acuityCyclesPerDeg(100), 50 / 1080)).toBe(0);
  });
});

describe('the fovea\'s adaptation that sets the acuity at a pixel (docs/eye-model.md §5b)', () => {
  const ARCMIN = Math.PI / (180 * 60);
  const U = 0.655;          // unscattered fraction at a 1° field, as rendered on the GPU (lane ricco-disk, 2026-10-07)
  const SKY = 1e-4;         // dark sky, cd/m² (test value)
  /**
   * The 1° field around a pixel as retinal samples: a disk of scene luminance L and angular diameter `diam`
   * (rad) at its centre, on a sky of SKY, with a uniform veil. Pixels of 15″.
   */
  function field(L: number, diam: number, veil: number): RetinalSample[] {
    const px = 15 * ARCMIN / 60, half = 0.5 * 60 * ARCMIN, om = px * px;
    const out: RetinalSample[] = [];
    for (let y = -half + px / 2; y < half; y += px) for (let x = -half + px / 2; x < half; x += px) {
      if (x * x + y * y > half * half) continue;
      const on = x * x + y * y <= (diam / 2) ** 2;
      const scene = on ? L : SKY;
      out.push({ Y: U * scene + veil, S: 2.27 * (U * scene + veil), sceneY: scene, omegaSr: om });
    }
    return out;
  }
  /** The rule until October 2026: the arithmetic mean of the scene over the 1° field, plus the veil at the pixel. */
  const areaMean = (f: RetinalSample[]) => {
    const w = f.reduce((a, s) => a + s.omegaSr, 0);
    return f.reduce((a, s) => a + (s.Y * s.omegaSr) / w, 0);
  };

  it('a 3′ disk in a dark 1° field: the fovea is adapted to the disk by its light, not to the field\'s mean', () => {
    for (const L of [8, 10, 29, 400]) {          // Charon, Pluto, Triton, Ganymede as rendered
      const f = field(L, 3 * ARCMIN, 0.05);
      const La = fovealAdaptation(f);
      expect(La / (U * L + 0.05)).toBeGreaterThan(0.95);
      expect(La / (U * L + 0.05)).toBeLessThan(1.0001);
      // The area mean is two orders of magnitude lower: the disk covers 0.25 % of the field.
      expect(areaMean(f) / (U * L + 0.05)).toBeLessThan(0.05);
    }
  });
  it('a uniform field: the same adaptation under both rules, its own retinal luminance', () => {
    for (const L of [1e-4, 0.03, 5, 300]) {
      const f = field(L, 0, 0).map((s) => ({ ...s, Y: U * L, S: 2.27 * U * L, sceneY: L }));
      expect(fovealAdaptation(f) / (U * L)).toBeCloseTo(1, 9);
      expect(areaMean(f) / (U * L)).toBeCloseTo(1, 9);
    }
  });
  it('the acuity cell on that disk is under a quarter of its diameter (it was as large as the disk)', () => {
    const cellArcmin = (La: number) => 60 / (2 * acuityCyclesPerDeg(La));
    for (const L of [8, 10, 29]) {
      const f = field(L, 3 * ARCMIN, 0.05);
      expect(cellArcmin(fovealAdaptation(f))).toBeLessThan(3 / 4);
      expect(cellArcmin(areaMean(f))).toBeGreaterThan(1.5);
    }
  });
  it('a 1° field inside the solar disk: the disk\'s own luminance, although the frame never fixates it', () => {
    // §2 gives the solar disk no fixation for the frame's adaptation (one cannot look at it). The filter asks
    // with what acuity each pixel is shown, with the fovea on that pixel by construction: no exclusion there.
    // Without this the weights of a field inside the disk sum to zero and the disk would be shown with the
    // acuity of the dark light. 1.6e9 cd/m² is the Sun's order of magnitude; only that it is bright matters.
    const f = field(1.6e9, 0, 0).map((s) => ({ ...s, Y: U * 1.6e9, S: 2.27 * U * 1.6e9, sceneY: 1.6e9, onSunDisk: true }));
    expect(fovealAdaptation(f) / (U * 1.6e9)).toBeCloseTo(1, 9);
    expect(acuityCyclesPerDeg(fovealAdaptation(f))).toBeGreaterThan(50);
  });
  it('the block-sum pyramid level whose texel is the 1° field', () => {
    // 8 px blocks: at a 1° field on 720 lines (5″ per pixel) a block is 40″ and 1° is 90 blocks, level log2(90).
    expect(fovealFieldLevel(1 / 720, 8)).toBeCloseTo(Math.log2(90), 12);
    // Where a block is coarser than 1° the finest level is used.
    expect(fovealFieldLevel(0.2, 8)).toBe(0);
  });
  it('the block sums of every part of the frame reach every level of their pyramid', () => {
    // A mip chain halves each side rounding down. 1280 × 720 has 160 × 90 blocks; from 90 rows the levels would be
    // 45, 22, 11, 5, 2, 1: the last odd row is dropped three times, and the level whose texel is 1° at a 1° field
    // would not hold the bottom 208 of 720 lines. With sides that are powers of two nothing is dropped.
    for (const [bx, by] of [[160, 90], [240, 135], [320, 180], [8, 8], [1, 1], [136, 96]]) {
      const [w, h] = fovealSumsSize(bx, by);
      expect(w).toBeGreaterThanOrEqual(bx);
      expect(h).toBeGreaterThanOrEqual(by);
      expect(w).toBeLessThan(2 * bx);
      expect(h).toBeLessThan(2 * by);
      for (let n = w; n > 1; n >>= 1) expect(n % 2).toBe(0);
      for (let n = h; n > 1; n >>= 1) expect(n % 2).toBe(0);
    }
    expect(fovealSumsSize(160, 90)).toEqual([256, 128]);
  });
});

describe('the filter\'s image chain: every level tiles the frame (docs/eye-model.md §5b; PYRAMID_SHADER downTiling)', () => {
  const f = Math.fround;
  /** The chain for a frame: the levels' sizes (the base is the frame's rounded-up half) and the images, in float32. */
  function chain(img: Float32Array, W: number, H: number) {
    const plan = frameSize(W, H, LIMITS, ADAPT_TILE_PX);
    if (!plan.ok) throw new Error(plan.warning);
    const sx = acuityChainSides(plan.size.acuW, plan.size.acuMips), sy = acuityChainSides(plan.size.acuH, plan.size.acuMips);
    const levels: { w: number; h: number; data: Float32Array }[] = [{ w: W, h: H, data: img }];
    for (let j = 0; j < sx.length; j++) {
      const p = levels[levels.length - 1];
      levels.push({ w: sx[j], h: sy[j], data: downTiling(p.data, p.w, p.h, sx[j], sy[j]) });
    }
    return levels;
  }
  /** PYRAMID_SHADER `down` as the acuity chain used it until October 2026: the mean of 2 × 2, zero beyond the source. */
  function downPyramid(src: Float32Array, w: number, h: number, wd: number, hd: number): Float32Array {
    const o = new Float32Array(wd * hd);
    const at = (x: number, y: number) => (x < w && y < h ? src[y * w + x] : 0);
    for (let y = 0; y < hd; y++) for (let x = 0; x < wd; x++) {
      o[y * wd + x] = f(f(f(f(at(2 * x, 2 * y) + at(2 * x + 1, 2 * y)) + at(2 * x, 2 * y + 1)) + at(2 * x + 1, 2 * y + 1)) * 0.25);
    }
    return o;
  }
  const sum = (a: Float32Array) => { let s = 0; for (const v of a) s += v; return s; };
  const random = (n: number, seed: number) => { const a = new Float32Array(n); let s = seed; for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) % 2147483648; a[i] = s / 2147483648; } return a; };
  // The suite's frame, an odd one, the validation's two frames that are not powers of two (it renders a case at
  // four times its size) with two of its cases' own sizes, powers of two, and small ones of both parities per axis.
  const FRAMES: [number, number][] = [[1280, 720], [1283, 723], [5500, 552], [1000, 1000], [1375, 138], [250, 250], [256, 256], [512, 512], [161, 91], [37, 64], [3, 5], [1, 1]];

  it('the light of a level is the light of the level below, at odd and even sides', () => {
    for (const [W, H] of FRAMES) {
      const lv = chain(random(W * H, W * 31 + H), W, H);
      for (let j = 1; j < lv.length; j++) {
        // Light = the sum over the level times its texel's area in frame pixels.
        const a = sum(lv[j - 1].data) * ((W * H) / (lv[j - 1].w * lv[j - 1].h)), b = sum(lv[j].data) * ((W * H) / (lv[j].w * lv[j].h));
        expect(Math.abs(b - a) / a, `${W}×${H} level ${j}`).toBeLessThan(1e-6);
      }
    }
  });
  it('a uniform image is uniform at every level', () => {
    let largest = 0;
    for (const [W, H] of FRAMES) {
      const lv = chain(new Float32Array(W * H).fill(1), W, H);
      // Nine products and their sum in single precision: within four units in the last place of 1 (the largest
      // found in these frames is two, 2.4e-7, at 1283 × 723; a level whose two sides are even is exact).
      for (let j = 1; j < lv.length; j++) {
        let worst = 0;
        for (const v of lv[j].data) worst = Math.max(worst, Math.abs(v - 1));
        expect(worst, `${W}×${H} level ${j}`).toBeLessThanOrEqual(4 * 2 ** -23);
        largest = Math.max(largest, worst);
        if (W === 256 || W === 512) expect(worst).toBe(0);   // every side even all the way down
      }
    }
    expect(largest).toBeLessThanOrEqual(2 * 2 ** -23);
  });
  it('a source in the last row, the last column or the last corner is in every level', () => {
    for (const [W, H] of FRAMES) {
      for (const [x, y] of [[W >> 1, H - 1], [W - 1, H >> 1], [W - 1, H - 1]]) {
        const img = new Float32Array(W * H); img[y * W + x] = 1;
        const lv = chain(img, W, H);
        for (let j = 1; j < lv.length; j++) {
          const light = sum(lv[j].data) * ((W * H) / (lv[j].w * lv[j].h));
          expect(Math.abs(light - 1), `${W}×${H} source (${x}, ${y}) level ${j}`).toBeLessThan(1e-6);
        }
      }
    }
  });
  it('the defect it replaces: with the pyramid\'s down, a source in the last row of 720 is gone from the 32 px level on', () => {
    // 720 → 360, 180, 90, 45, then 22: the mip sides round down, and `down` reads rows 2p and 2p+1 only.
    const H = 720, sides = acuityChainSides(360, 9);
    expect(sides).toEqual([360, 180, 90, 45, 22, 11, 5, 2, 1]);
    // Along the one axis `down` is the mean of two, zero beyond the source.
    let cur: number[] = new Array(H).fill(0); cur[H - 1] = 1;
    const light: number[] = [];
    for (const n of sides) {
      const src = cur;
      cur = Array.from({ length: n }, (_, p) => 0.5 * ((src[2 * p] ?? 0) + (src[2 * p + 1] ?? 0)));
      light.push(cur.reduce((a, v) => a + v, 0) * (H / n) * (n * 2 ** (light.length + 1) / H));   // sum × nominal texel of 2^m px
    }
    expect(light.slice(0, 4)).toEqual([1, 1, 1, 1]);
    expect(light.slice(4)).toEqual([0, 0, 0, 0, 0]);
  });
  it('where a side is even the taps are one half each, and the level is the pyramid\'s down to the bit', () => {
    expect(tilingTaps(7, 640, 320)).toEqual({ first: 14, weights: [0.5, 0.5] });
    expect(tilingTaps(0, 2, 1)).toEqual({ first: 0, weights: [0.5, 0.5] });
    // An odd side: three taps, the ends by the part of the texel inside the interval, summing to one.
    const t = tilingTaps(3, 45, 22);
    expect(t.first).toBe(6);
    expect(t.weights.length).toBe(3);
    expect(t.weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(t.weights[0]).toBeCloseTo((7 - 3 * 45 / 22) / (45 / 22), 12);
    for (const [w, h] of [[640, 360], [64, 36], [8, 2]]) {
      const img = random(w * h, w + 7 * h);
      expect(downTiling(img, w, h, w / 2, h / 2)).toEqual(downPyramid(img, w, h, w / 2, h / 2));
    }
  });
  it('the read maps the frame onto the level by the level\'s size: today\'s position where the sides are even', () => {
    // Even all the way: level/frame is exactly 2^-m, so q·(level/frame) − ½ is q/2^m − ½ in single precision.
    for (const [side, frame, m] of [[640, 1280, 1], [45, 720, 4], [80, 1280, 4]]) {
      for (const q of [0.5, 17.5, 333.5, frame - 0.5]) expect(acuityReadPos(q, frame, side)).toBe(f(f(q / 2 ** m) - 0.5));
    }
    // An odd frame: the last pixel's centre falls inside the last texel (it fell beyond the level before).
    for (const [side, frame] of [[642, 1283], [22, 720], [160, 1283]]) {
      const c = acuityReadPos(frame - 0.5, frame, side);
      expect(c).toBeGreaterThan(side - 1.5);
      expect(c).toBeLessThan(side - 0.5);
    }
  });
});

describe('the veil pyramid\'s down keeps its light (a guard: the points\' own-light term relies on it)', () => {
  const f = Math.fround;
  it('four times the sum over a level is the sum over the level below, at odd and even sides', () => {
    // PYRAMID_SHADER `down` into the veil pyramid's levels, whose sides are rounded up (frameSizing.ts): every texel
    // of the level below is read, so nothing is lost on the way down.
    for (const [W, H] of [[1280, 720], [1283, 723], [1375, 138], [250, 250], [161, 91]]) {
      const plan = frameSize(W, H, LIMITS, ADAPT_TILE_PX);
      if (!plan.ok) throw new Error(plan.warning);
      let cur = new Float32Array(W * H); let s = W + H;
      for (let i = 0; i < cur.length; i++) { s = (s * 1103515245 + 12345) % 2147483648; cur[i] = s / 2147483648; }
      let w = W, h = H;
      for (const { w: wd, h: hd } of plan.size.levels.slice(1)) {
        const o = new Float32Array(wd * hd);
        const at = (x: number, y: number) => (x < w && y < h ? cur[y * w + x] : 0);
        for (let y = 0; y < hd; y++) for (let x = 0; x < wd; x++) o[y * wd + x] = f(f(f(f(at(2 * x, 2 * y) + at(2 * x + 1, 2 * y)) + at(2 * x, 2 * y + 1)) + at(2 * x + 1, 2 * y + 1)) * 0.25);
        let a = 0, b = 0; for (const v of cur) a += v; for (const v of o) b += v;
        if (a > 0) expect(Math.abs(4 * b - a) / a, `${W}×${H} → ${wd}×${hd}`).toBeLessThan(1e-6);
        cur = o; w = wd; h = hd;
      }
    }
  });
});
