// Atmosphere tables (render/atmosphere.ts) on a TEST FIXTURE atmosphere (fixtures/atmosphere.ts): analytic
// limits of transmittance, single scattering and sky irradiance, and the multiple-scattering term.
import { describe, expect, it } from 'vitest';
import {
  hgPhase, limbChordTable, limbTransmittance, msLookup, precomputeAtmosphere, rayleighPhase, skyIrradianceLookup, skyRadiance,
  sphereDirections, transmittanceToTop,
} from '../src/render/atmosphere';
import { fixtureRayleighAtmosphere } from './fixtures/atmosphere';

const m = fixtureRayleighAtmosphere();
const t0 = performance.now();
const tab = precomputeAtmosphere(m);
const precomputeMs = performance.now() - t0;
const k550 = 4; // the 560 nm bin
const beta = (k: number) => 0.0116 * (550 / m.wavelengthsNm[k]) ** 4;

describe('atmosphere tables (fixture)', () => {
  it('precomputes in well under a few seconds', () => {
    console.log(`atmosphere precompute: ${precomputeMs.toFixed(0)} ms for ${m.wavelengthsNm.length} bins`);
    expect(precomputeMs).toBeLessThan(60000); // generous: the suite shares the CPU
  });
  it('phase functions are normalised over the sphere', () => {
    const dirs = sphereDirections(4000);
    const integ = (f: (nu: number) => number) => dirs.reduce((a, w) => a + f(w[2]), 0) * (4 * Math.PI) / dirs.length;
    expect(integ((nu) => rayleighPhase(nu, 0))).toBeCloseTo(1, 2);
    expect(integ((nu) => rayleighPhase(nu, 0.0279))).toBeCloseTo(1, 2);
    expect(integ((nu) => hgPhase(nu, 0.7))).toBeCloseTo(1, 1);
  });
  it('transmittance: vertical path = exp(−β·H_s), 1 at the top, 0-ish grazing the ground', () => {
    for (const k of [0, k550, 7]) {
      const T = transmittanceToTop(m, tab, m.bottomKm, 1, k);
      const tau = beta(k) * 8 * (1 - Math.exp(-100 / 8));
      // Profiles are linear between levels (atmospheres.json), so the 2 km fixture grid adds ~0.2 %.
      expect(T).toBeCloseTo(Math.exp(-tau), 2);
      expect(transmittanceToTop(m, tab, m.topKm, 0.5, k)).toBeCloseTo(1, 4);
    }
    expect(transmittanceToTop(m, tab, m.bottomKm + 0.01, 0, 0)).toBeLessThan(0.01);
  });
  it('optically thin single scattering matches the analytic zenith sky', () => {
    // Zenith view from the ground, Sun at zenith: L ≈ P(−1)·τ (τ ≪ 1, per unit irradiance); ms adds a few %.
    const k = 7;
    const tau = beta(k) * 8;
    const L = skyRadiance(m, tab, [0, 0, m.bottomKm + 1e-3], [0, 0, 1], [0, 0, 1], k, 200);
    const analytic = rayleighPhase(1, 0) * tau * Math.exp(-tau); // single scattering, both paths attenuated ≈ e^(−τ)
    expect(L / analytic).toBeGreaterThan(0.98);
    expect(L / analytic).toBeLessThan(1.15);
  });
  it('multiple scattering is positive, larger in the blue, and grows with the ground albedo', () => {
    const blue = msLookup(m, tab, 1, 0.8, 0), red = msLookup(m, tab, 1, 0.8, 7);
    expect(blue).toBeGreaterThan(red);
    expect(red).toBeGreaterThan(0);
    const bright = precomputeAtmosphere(fixtureRayleighAtmosphere({ albedo: 0.3 }));
    expect(msLookup(m, bright, 1, 0.8, 7)).toBeGreaterThan(red);
  }, 60000);
  it('sky irradiance at the ground ≈ half the scattered light for a thin conservative atmosphere (Sun at zenith)', () => {
    const k = 7;
    const tau = beta(k) * 8;
    const E = skyIrradianceLookup(m, tab, 0, 0.99, k);
    // Down-scattered diffuse ≈ (1 − e^(−τ))/2 for Rayleigh (forward/backward symmetric), within 15 %.
    expect(E / ((1 - Math.exp(-tau)) / 2)).toBeGreaterThan(0.85);
    expect(E / ((1 - Math.exp(-tau)) / 2)).toBeLessThan(1.15);
    // No sky light long after sunset at the ground.
    expect(skyIrradianceLookup(m, tab, 0, -0.5, k)).toBeLessThan(1e-3 * E);
  });
  it('an absorber only dims the bins it absorbs in', () => {
    const oz = precomputeAtmosphere(fixtureRayleighAtmosphere({ ozone: true }));
    const ratio = (k: number) => transmittanceToTop(m, oz, m.bottomKm, 1, k) / transmittanceToTop(m, tab, m.bottomKm, 1, k);
    expect(ratio(0)).toBeCloseTo(1, 4);
    expect(ratio(5)).toBeCloseTo(Math.exp(-0.002 * 10), 2);
  }, 60000);
  it('limb chords: the grazing optical depth of an exponential atmosphere (Chapman: β(h)·√(2π r H_s))', () => {
    const table = limbChordTable(m);
    const H = m.topKm - m.bottomKm;
    for (const h of [0, 8, 20, 33.3, 50]) {
      const r = m.bottomKm + h;
      // Flat test weights: the channel transmittance is the mean over the bins.
      const T = m.wavelengthsNm.reduce((a, _, k) => a + Math.exp(-beta(k) * Math.exp(-h / 8) * Math.sqrt(2 * Math.PI * r * 8)), 0) / m.wavelengthsNm.length;
      for (const c of [0, 1, 3]) expect(limbTransmittance(table, H, h, c) / T).toBeCloseTo(1, 1);
      expect(Math.abs(limbTransmittance(table, H, h, 1) / T - 1)).toBeLessThan(0.02);
    }
    expect(limbTransmittance(table, H, H, 1)).toBe(1);
    expect(limbTransmittance(table, H, -1, 1)).toBe(0);
    let prev = 0;
    for (let h = 0; h <= H; h += 0.7) { const t = limbTransmittance(table, H, h, 1); expect(t).toBeGreaterThanOrEqual(prev); prev = t; }
  });
});
