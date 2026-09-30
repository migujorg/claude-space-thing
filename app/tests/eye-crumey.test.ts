// Crumey (2014) threshold model against the paper's own worked numbers (arXiv:1405.4209v1).
import { describe, expect, it } from 'vitest';
import { CRUMEY } from '../src/eye/constants';
import {
  largeTargetContrast,
  largeTargetContrastScotopic,
  luminanceFromSurfaceBrightness,
  luxFromMagnitude,
  magnitudeFromLux,
  pointThreshold,
  pointThresholdPhotopic,
  pointThresholdScotopic,
  riccoArea,
  surfaceBrightnessFromLuminance,
} from '../src/eye/crumey';
import { limitingMagnitudeOnSky, AdaptationState, computeEyeFrame } from '../src/eye/model';
import { DEFAULT_EYE_SETTINGS } from '../src/eye/settings';

/** Eq. 53 in magnitudes. */
const m0 = (mu: number, F: number) => magnitudeFromLux(F * pointThresholdScotopic(luminanceFromSurfaceBrightness(mu)));

describe('Crumey 2014 photometric conversions (§1.3)', () => {
  it('uses m_V = −2.5 log J − 13.99 and μ_V = −2.5 log B + 12.58', () => {
    expect(magnitudeFromLux(1)).toBeCloseTo(-13.99, 2);
    expect(surfaceBrightnessFromLuminance(1)).toBeCloseTo(12.58, 2);
    expect(luxFromMagnitude(0)).toBeCloseTo(2.54e-6, 12);
  });
  it('22 mag/arcsec² ≈ 1.71e-4 cd/m² and 21.83 ≈ 2e-4 cd/m², as quoted', () => {
    expect(luminanceFromSurfaceBrightness(22)).toBeCloseTo(1.71e-4, 6);
    expect(luminanceFromSurfaceBrightness(21.83)).toBeCloseTo(2.0e-4, 5);
  });
});

describe('Crumey 2014 point-source model', () => {
  it('dark sky B = 2e-4 cd/m² gives m0 = 6.93 − 2.5 log F (§3.1)', () => {
    const B = 2e-4;
    expect(magnitudeFromLux(pointThresholdScotopic(B))).toBeCloseTo(6.93, 2);
    expect(magnitudeFromLux(2 * pointThresholdScotopic(B))).toBeCloseTo(6.18, 2);
  });
  it('reproduces the linear approximation Eq. 54 (max error 0.01 mag for 20 < μ < 22)', () => {
    for (let mu = 20.05; mu < 22; mu += 0.1) {
      expect(Math.abs(m0(mu, 1) - (0.3834 * mu - 1.44))).toBeLessThan(0.011);
    }
  });
  it('reproduces the linear approximation Eq. 55 (max error 0.04 mag for 21 < μ < 25)', () => {
    for (let mu = 21.05; mu < 25; mu += 0.1) {
      expect(Math.abs(m0(mu, 1) - (0.426 * mu - 2.365))).toBeLessThan(0.041);
    }
  });
  it('reproduces Table 1 magnitude penalties m22 − m0', () => {
    const table: [number, number][] = [[21.75, 0.1], [21.5, 0.2], [21.25, 0.3], [21.0, 0.4], [20.75, 0.49], [20.5, 0.59], [20.0, 0.77], [19.5, 0.93], [19.25, 1.01]];
    for (const [mu, pen] of table) expect(m0(22, 1) - m0(mu, 1)).toBeCloseTo(pen, 1.7);
  });
  it('zero-background cut-off ζ = 1.150e-9 lx (Eq. 71) and ξ1, ξ2 (Eqs. 51, 52)', () => {
    expect(pointThresholdScotopic(1e-5)).toBeCloseTo(1.15e-9, 11);
    expect((Math.pow(10, 5 / 4) * CRUMEY.r1 + CRUMEY.r2) ** 2).toBeCloseTo(1.15e-4, 6);
    expect(Math.pow(10, 5 / 4) * CRUMEY.k1 + CRUMEY.k2).toBeCloseTo(0.1286, 4);
    // Below the cut-off the full model is constant.
    expect(pointThreshold(1e-9)).toBe(pointThreshold(1e-5));
  });
  it('the two point-source branches meet at the published split point 7.08e-2 cd/m²', () => {
    const B = CRUMEY.pointSplitB;
    expect(pointThresholdScotopic(B) / pointThresholdPhotopic(B)).toBeCloseTo(1, 2);
  });
  it('the full-range hyperbola (Eq. 34) agrees with the branches away from the bend', () => {
    // Crumey Fig. 6: the two model versions are "virtually indistinguishable" apart from the bend.
    for (const B of [1e-4, 2e-4, 1e-3, 3e-3]) {
      expect(Math.abs(magnitudeFromLux(pointThreshold(B)) - magnitudeFromLux(pointThresholdScotopic(B)))).toBeLessThan(0.05);
    }
    for (const B of [10, 100, 1e3, 1e4]) {
      expect(Math.abs(magnitudeFromLux(pointThreshold(B)) - magnitudeFromLux(pointThresholdPhotopic(B)))).toBeLessThan(0.06);
    }
  });
  it('large-target C∞: full form ≈ scotopic branch; Weber limit k4 in daylight', () => {
    // Fig. 8: the C∞ hyperbola has "a more gradual bend" than the point-source one.
    for (const B of [1e-5, 1e-4, 1e-3]) expect(Math.abs(largeTargetContrast(B) / largeTargetContrastScotopic(B) - 1)).toBeLessThan(0.1);
    expect(largeTargetContrast(1e4)).toBeGreaterThan(1.5e-3);
    expect(largeTargetContrast(1e4)).toBeLessThan(CRUMEY.k4 * 1.2);
  });
  it('Ricco area at zero background ≈ 8.94e-4 sr (§2.3, 116 arcmin diameter)', () => {
    expect(riccoArea(1e-6) / 8.94e-4).toBeCloseTo(1, 1);
  });
  it('Ricco radius at 21.83 mag/arcsec² ≈ 37.6 arcmin (§2.3 text after Eq. 63)', () => {
    const B = luminanceFromSurfaceBrightness(21.83);
    const A = (CRUMEY.r1 * B ** -0.25 + CRUMEY.r2) ** 2 / (CRUMEY.k1 * B ** -0.25 + CRUMEY.k2); // Eq. 59
    const rArcmin = (Math.sqrt(A / Math.PI) * 180 * 60) / Math.PI;
    expect(rArcmin).toBeCloseTo(37.6, 0);
  });
});

describe('naked-eye limit from the full eye model (mesopic conversion + Crumey + F)', () => {
  it('dark-sky limit (21.5–22 mag/arcsec²) comes out at V ≈ 6–7 for typical star colours', () => {
    const skySP = 1.38; // Crumey §1.3: typical moonless natural sky S/P
    // Star S/P ratios from Crumey Eq. 13, log ρ = −0.1094·(B−V) + 0.4378, for B−V = 0 … 1.5
    // (0.7 is the typical naked-eye colour index he cites from Cinzano et al. 2001).
    const starSPs = [0, 0.7, 1.5].map((c) => Math.pow(10, -0.1094 * c + 0.4378));
    for (const mu of [21.5, 21.75, 22]) {
      const skyP = luminanceFromSurfaceBrightness(mu);
      for (const starSP of starSPs) {
        const V = limitingMagnitudeOnSky(skyP, skyP * skySP, starSP, DEFAULT_EYE_SETTINGS.fieldFactor);
        expect(V).toBeGreaterThan(6);
        expect(V).toBeLessThan(7);
      }
    }
  });
  it('the renderer frame state reports the same limit when adapted to that sky', () => {
    const skyP = luminanceFromSurfaceBrightness(21.83);
    const st = new AdaptationState();
    st.update({ coneCdM2: skyP, rodCdM2: skyP * CRUMEY.spRatioBlackwell, cornealFlux: skyP * 41253 }, 0);
    const f = computeEyeFrame(DEFAULT_EYE_SETTINGS, st, 'eye', 0, null);
    expect(f.limitingMagnitude).toBeCloseTo(6.18, 1);
    expect(f.mesopic.m).toBe(0);
    const fe = computeEyeFrame(DEFAULT_EYE_SETTINGS, st, 'enhanced', 2, null);
    expect(fe.limitingMagnitude - f.limitingMagnitude).toBeCloseTo(2.5 * Math.log10(4), 6);
  });
  it('a sunlit-adapted eye cannot see any star (limit brighter than Sirius, V = −1.46)', () => {
    const st = new AdaptationState();
    st.update({ coneCdM2: 1e4, rodCdM2: 2.3e4, cornealFlux: 1e7 }, 0);
    const f = computeEyeFrame(DEFAULT_EYE_SETTINGS, st, 'eye', 0, null);
    expect(f.limitingMagnitude).toBeLessThan(-1.46);
  });
});
