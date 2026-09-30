import { describe, expect, it } from 'vitest';
import { WATSON_YELLOTT } from '../src/eye/constants';
import { pupilDiameterMm, stanleyDavies } from '../src/eye/pupil';
import { blackwellEquivalent, mesopic } from '../src/eye/mesopic';
import { CRUMEY } from '../src/eye/constants';

describe('Watson & Yellott (2012) unified pupil formula', () => {
  it('Stanley–Davies limits: 7.75 mm in darkness, → 2.0 mm for very bright fields', () => {
    expect(stanleyDavies(0)).toBeCloseTo(7.75, 10);
    expect(stanleyDavies(1e15)).toBeCloseTo(2.0, 2);
  });
  it('hand-computed value: 100 cd/m² over a 25°-diameter field (a = π·12.5² deg²)', () => {
    // F = 49087 → (F/846)^0.41 = 5.2856 → D = 7.75 − 5.75·5.2856/7.2856 = 3.578 mm
    expect(stanleyDavies(100 * Math.PI * 12.5 * 12.5)).toBeCloseTo(3.578, 2);
  });
  it('at the reference age the unified formula equals Stanley–Davies', () => {
    for (const F of [0, 10, 1e3, 1e5]) expect(pupilDiameterMm(F, WATSON_YELLOTT.refAge, 2)).toBeCloseTo(stanleyDavies(F), 10);
  });
  it('monocular viewing reduces the effective flux tenfold', () => {
    expect(pupilDiameterMm(5000, WATSON_YELLOTT.refAge, 1)).toBeCloseTo(stanleyDavies(500), 10);
  });
  it('decreases with luminance, and dark-adapted pupils shrink with age', () => {
    let prev = Infinity;
    for (let F = 1e-3; F < 1e9; F *= 10) {
      const d = pupilDiameterMm(F, 25, 2);
      expect(d).toBeLessThan(prev);
      prev = d;
    }
    expect(pupilDiameterMm(0, 70, 2)).toBeLessThan(pupilDiameterMm(0, 20, 2));
  });
});

describe('CIE 191:2010 mesopic system', () => {
  it('photopic above 5 cd/m², scotopic below 0.005 cd/m²', () => {
    expect(mesopic(10, 20).m).toBe(1);
    expect(mesopic(10, 20).Lmes).toBeCloseTo(10, 10);
    expect(mesopic(1e-3, 2e-3).m).toBe(0);
    expect(mesopic(1e-3, 2e-3).Lmes).toBeCloseTo(2e-3, 12);
  });
  it('the coefficients reproduce the range endpoints m(0.005) = 0, m(5) = 1', () => {
    expect(0.767 + 0.3334 * Math.log10(0.005)).toBeCloseTo(0, 3);
    expect(0.767 + 0.3334 * Math.log10(5)).toBeCloseTo(1, 3);
  });
  it('m is between 0 and 1 in the mesopic range and increases with luminance', () => {
    let prev = -1;
    for (const L of [0.01, 0.03, 0.1, 0.3, 1, 3]) {
      const r = mesopic(L, 1.5 * L);
      expect(r.m).toBeGreaterThan(0);
      expect(r.m).toBeLessThan(1);
      expect(r.m).toBeGreaterThan(prev);
      prev = r.m;
      // Self-consistency of the converged iteration.
      expect(r.m).toBeCloseTo(Math.min(1, Math.max(0, 0.767 + 0.3334 * Math.log10(r.Lmes))), 6);
    }
  });
  it("Blackwell's own 2850 K light is invariant under the Blackwell-equivalent conversion", () => {
    for (const m of [0, 0.3, 0.7, 1]) expect(blackwellEquivalent(1, CRUMEY.spRatioBlackwell, m)).toBeCloseTo(1, 12);
    // Scotopic end reduces to Crumey's colour correction q_s/ρ2850 (§1.3).
    expect(blackwellEquivalent(1, 2.2, 0)).toBeCloseTo(2.2 / CRUMEY.spRatioBlackwell, 12);
  });
});
