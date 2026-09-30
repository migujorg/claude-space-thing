// Earth's layer model (render/earth.ts): cloud optics limits, energy conservation, unknown handling.
import { describe, expect, it } from 'vitest';
import { cloudOptics, cloudPlaneAlbedo, earthShade, escape, fresnel, FRESNEL_DIFFUSE, GAUSS4_W, GAUSS4_X, glintRadianceFactor, SEA_ICE_ALBEDO_VIS, type EarthSample } from '../src/render/earth';

const sample = (over: Partial<EarthSample> = {}): EarthSample => ({
  surface: [0.1, 0.1, 0.1, 0.1], waterFraction: 0, seaIceFraction: NaN, cloudFraction: 0, opticalThickness: 0, iceFraction: 0, ...over,
});
/** Hemispheric albedo of a radiance factor: (1/μ0)·2∫ρ(μ)μ dμ (4-point Gauss, as the model's own integrals). */
const albedo = (rho: (mu: number) => number, mu0: number) => GAUSS4_X.reduce((a, x, k) => a + 2 * GAUSS4_W[k] * x * rho(x), 0) / mu0;

describe('cloud optics (δ-Eddington, conservative)', () => {
  it('no cloud reflects nothing; a thick one reflects everything; the result stays in [0, 1]', () => {
    expect(cloudPlaneAlbedo(0, 0.86, 0.7)).toBe(0);
    expect(cloudPlaneAlbedo(1e5, 0.86, 0.7)).toBeGreaterThan(0.999);
    for (const tau of [0.01, 0.3, 1, 3, 10, 30, 100]) for (const mu0 of [0.02, 0.2, 0.5, 1]) {
      const R = cloudPlaneAlbedo(tau, 0.86, mu0);
      expect(R).toBeGreaterThanOrEqual(0);
      expect(R).toBeLessThanOrEqual(1);
    }
  });
  it('matches the closed form [(1−g)τ + (2/3 − μ0)(1 − e^(−(1−g²)τ/μ0))] / [4/3 + (1−g)τ]', () => {
    const g = 0.86, tau = 10, mu0 = 0.5;
    const expected = ((1 - g) * tau + (2 / 3 - mu0) * (1 - Math.exp(-(1 - g * g) * tau / mu0))) / (4 / 3 + (1 - g) * tau);
    expect(cloudPlaneAlbedo(tau, g, mu0)).toBeCloseTo(expected, 12);
    // Similarity: the same (1 − g)τ reflects about the same at high Sun.
    expect(Math.abs(cloudPlaneAlbedo(20, 0.85, 1) - cloudPlaneAlbedo(12, 0.75, 1))).toBeLessThan(0.02);
  });
  it('the escape function is normalised like a Lambert surface (2∫u μ dμ = 1)', () => {
    expect(GAUSS4_X.reduce((a, x, k) => a + 2 * GAUSS4_W[k] * x * escape(x), 0)).toBeCloseTo(1, 12);
  });
  it('thicker clouds are brighter and let less light through', () => {
    let prev = cloudOptics(0.5, 0.86, 0.6, 0.8);
    for (const tau of [1, 2, 5, 10, 20, 50]) {
      const o = cloudOptics(tau, 0.86, 0.6, 0.8);
      expect(o.R0).toBeGreaterThan(prev.R0);
      expect(o.rbar).toBeGreaterThan(prev.rbar);
      expect(o.tView + o.tViewDiffuse).toBeLessThan(prev.tView + prev.tViewDiffuse);
      prev = o;
    }
  });
});

describe('earthShade', () => {
  it('clear sky is a Lambert surface of the absolute reflectance', () => {
    const s = earthShade(sample(), 0.6, 0.9);
    for (const c of [0, 1, 2, 3]) expect(s.rho[c]).toBeCloseTo(0.1 * 0.6, 12);
    expect(s.emitT[1]).toBe(1);
    expect(s.gap).toBe(0);
  });
  it('conserves energy: a non-absorbing cloud over a white surface reflects all the light', () => {
    for (const tau of [0.5, 3, 20]) for (const mu0 of [0.3, 0.8]) {
      const a = albedo((mu) => earthShade(sample({ surface: [1, 1, 1, 1], cloudFraction: 1, opticalThickness: tau }), mu0, mu).rho[1], mu0);
      expect(a).toBeCloseTo(1, 6);
    }
  });
  it('over a black surface the cloud reflects its plane albedo, with the escape-function distribution', () => {
    const mu0 = 0.7, tau = 8;
    const s = (mu: number) => earthShade(sample({ surface: [0, 0, 0, 0], cloudFraction: 1, opticalThickness: tau }), mu0, mu);
    expect(albedo((mu) => s(mu).rho[1], mu0)).toBeCloseTo(cloudPlaneAlbedo(tau, 0.867, mu0), 6);
    expect(s(1).rho[1] / s(0.2).rho[1]).toBeCloseTo(escape(1) / escape(0.2), 9);
  });
  it('light emitted below a cloud leaves with its diffuse transmission', () => {
    const tau = 5;
    const t = albedo((mu) => earthShade(sample({ surface: [0, 0, 0, 0], cloudFraction: 1, opticalThickness: tau }), 1, mu).emitT[1], 1);
    expect(t).toBeCloseTo(1 - cloudOptics(tau, 0.867, 1, 1).rbar, 6);
  });
  it('sea ice covers its share of the water with the cited albedo', () => {
    const s = earthShade(sample({ surface: null, waterFraction: 1, seaIceFraction: 1 }), 1, 1);
    expect(s.rho[1]).toBeCloseTo(SEA_ICE_ALBEDO_VIS, 12);
    expect(s.gap).toBe(0);
    const half = earthShade(sample({ surface: [0.02, 0.02, 0.02, 0.02], waterFraction: 1, seaIceFraction: 0.5 }), 1, 1);
    expect(half.rho[1]).toBeCloseTo(0.5 * SEA_ICE_ALBEDO_VIS + 0.5 * 0.02, 12);
  });
  it('never invents: unknown surface or cloud state is marked, and contributes no light', () => {
    const noSurface = earthShade(sample({ surface: null }), 1, 1);
    expect(noSurface.rho[1]).toBe(0);
    expect(noSurface.gap).toBe(1);
    expect(earthShade(sample({ cloudFraction: NaN }), 1, 1).gap).toBe(1);
    const noTau = earthShade(sample({ cloudFraction: 0.4, opticalThickness: NaN }), 1, 1);
    expect(noTau.gap).toBeCloseTo(0.4, 12);
    expect(noTau.rho[1]).toBeCloseTo(0.6 * 0.1, 12); // only the clear part
    // Under a full cloud an unknown surface only loses its (unknown) share of the light: not marked.
    expect(earthShade(sample({ surface: null, cloudFraction: 1, opticalThickness: 20 }), 1, 1).gap).toBe(0);
  });
});

describe('sea surface (Cox & Munk 1954)', () => {
  it('Fresnel: 2 % at normal incidence for n = 1.338, 1 at grazing; diffuse mean ≈ 0.066', () => {
    expect(fresnel(1)).toBeCloseTo(((1.338 - 1) / (1.338 + 1)) ** 2, 10);
    expect(fresnel(0)).toBeCloseTo(1, 6);
    expect(FRESNEL_DIFFUSE).toBeGreaterThan(0.06);
    expect(FRESNEL_DIFFUSE).toBeLessThan(0.07);
  });
  it('the glint reflects about the Fresnel fraction of the direct beam, spread wider by stronger wind', () => {
    // Sun at 20° zenith in the x–z plane; integrate ρ·μ/π over view directions (half-vector geometry).
    const th0 = (20 * Math.PI) / 180;
    const S = [Math.sin(th0), 0, Math.cos(th0)];
    const albedo = (u: number) => {
      let a = 0;
      const n = 400;
      for (let i = 0; i < n; i++) for (let j = 0; j < 2 * n; j++) {
        const th = ((i + 0.5) / n) * (Math.PI / 2), ph = ((j + 0.5) / (2 * n)) * 2 * Math.PI;
        const V = [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)];
        const h = [S[0] + V[0], S[1] + V[1], S[2] + V[2]];
        const hl = Math.hypot(h[0], h[1], h[2]);
        const cosB = h[2] / hl, cosW = (h[0] * S[0] + h[1] * S[1] + h[2] * S[2]) / hl;
        const dOmega = Math.sin(th) * (Math.PI / 2 / n) * (Math.PI / n);
        a += (glintRadianceFactor(cosB, V[2], cosW, u) * V[2] * dOmega) / Math.PI;
      }
      return a / Math.cos(th0);
    };
    const a5 = albedo(5);
    expect(a5 / fresnel(Math.cos(th0))).toBeGreaterThan(0.9);
    expect(a5 / fresnel(Math.cos(th0))).toBeLessThan(1.15);
    // Peak (specular direction) is higher for calmer water.
    expect(glintRadianceFactor(1, 1, 1, 2)).toBeGreaterThan(glintRadianceFactor(1, 1, 1, 12));
  });
  it('stays finite at grazing angles (Smith/Sancer shadowing): the reflected flux vanishes at the limb', () => {
    // Forward specular geometry near the limb: Sun and view both 89.5° from the normal, facets flat.
    const mu = Math.cos((89.5 * Math.PI) / 180);
    const cosOmega = mu; // incidence on a flat facet
    const r = glintRadianceFactor(1, mu, cosOmega, 7, mu);
    expect(Number.isFinite(r)).toBe(true);
    expect(r * mu).toBeLessThan(0.5);
    expect(glintRadianceFactor(1, 1e-4, 1e-4, 7, 1e-4) * 1e-4).toBeLessThan(glintRadianceFactor(1, mu, mu, 7, mu) * mu);
  });
  it('unknown wind: no glint, and the open water in the glint zone is marked unknown', () => {
    const water = sample({ surface: [0.01, 0.01, 0.01, 0.01], waterFraction: 1 });
    const known = earthShade({ ...water, windSpeed: 6 }, 0.9, 0.9, { cosBeta: 1, cosOmega: 0.9 });
    const unknown = earthShade({ ...water, windSpeed: NaN }, 0.9, 0.9, { cosBeta: 1, cosOmega: 0.9 });
    expect(known.rho[1]).toBeGreaterThan(unknown.rho[1] * 10);
    expect(known.gap).toBe(0);
    expect(unknown.gap).toBe(1);
    // Far from the glint zone an unknown wind does not matter.
    expect(earthShade({ ...water, windSpeed: NaN }, 0.9, 0.5, { cosBeta: 0.5, cosOmega: 0.9 }).gap).toBe(0);
  });
});
