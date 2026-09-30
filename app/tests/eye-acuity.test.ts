// Low-light acuity (eye/acuity.ts): Ward Larson et al. (1997) Eq. 15 against the values quoted in their text,
// and the pyramid level it selects.
import { describe, expect, it } from 'vitest';
import { acuityCyclesPerDeg, acuityLevel } from '../src/eye/acuity';

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
