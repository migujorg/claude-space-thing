// Low-light acuity (eye/acuity.ts): Ward Larson et al. (1997) Eq. 15 against the values quoted in their text,
// and the pyramid level it selects.
import { describe, expect, it } from 'vitest';
import { acuityCyclesPerDeg, acuityLevel, fovealAdaptation, fovealFieldLevel, fovealSumsSize } from '../src/eye/acuity';
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
