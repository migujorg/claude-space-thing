// TEST FIXTURE air and surface; no validation image chooses the transport.
import { describe, expect, it } from 'vitest';
import { CLOUD_G_LIQUID, cloudOptics, escape, earthAtmosphereRadiance, earthParts, type EarthSample } from '../src/render/earth';
import { precomputeAtmosphere, ProfileGrid, skyIrradianceK, sunTransmittanceK, viewPath } from '../src/render/atmosphere';
import { fixtureRayleighAtmosphere } from './fixtures/atmosphere';
const m = fixtureRayleighAtmosphere();
// Distinct spectral bands: the limit must hold separately, not merely for gray test fold weights.
m.weights = [0, 2, 4, 7].map((bin) => m.wavelengthsNm.map((_, k) => +(k === bin)));
const tab = precomputeAtmosphere(m), grid = new ProfileGrid(m, 1024);
const sample: EarthSample = { surface: [0.08, 0.15, 0.04, 0.12], waterFraction: 1, seaIceFraction: 0,
  cloudFraction: 0.73, opticalThickness: 0, iceFraction: 0, windSpeed: 5 };
function column(h: number, mu0: number, mu: number) {
  const sun: [number, number, number] = [Math.sqrt(1 - mu0 * mu0), 0, mu0];
  const view: [number, number, number] = [0, Math.sqrt(1 - mu * mu), mu];
  const path = viewPath(m, tab, grid, [0, 0, m.bottomKm], view, sun, h, 256);
  const light = { ts0: sunTransmittanceK(m, tab, 0, mu0, new Float64Array(tab.K)),
    es0: skyIrradianceK(m, tab, 0, mu0, new Float64Array(tab.K)),
    tsc: sunTransmittanceK(m, tab, h, mu0, new Float64Array(tab.K)),
    esc: skyIrradianceK(m, tab, h, mu0, new Float64Array(tab.K)) };
  const radiance = (s: EarthSample) => earthAtmosphereRadiance(earthParts(s, mu0, mu), path, light, m.weights, mu0);
  return { path, light, radiance };
}
describe('cloud/air transport limits', () => {
  it('zero and vanishing thickness recover clear air in every channel, height 0–16 km and high to grazing Sun/view', () => {
    for (let h = 0; h <= 16; h++) for (const mu0 of [-0.05, 0, 0.001, 0.05, 0.3, 0.8, 1]) for (const mu of [0.05, 0.3, 0.9]) {
      const { radiance } = column(h, mu0, mu);
      const clear = radiance({ ...sample, cloudFraction: 0 });
      for (const tau of [0, 1e-10]) for (const ice of [0, 1]) {
        const cloudy = radiance({ ...sample, opticalThickness: tau, iceFraction: ice });
        for (let c = 0; c < 4; c++) expect(cloudy[c]).toBeCloseTo(clear[c], 8);
      }
    }
  });
  it('the opaque limit preserves the existing above-cloud reflection and path', () => {
    for (const h of [0, 8, 16]) for (const mu0 of [0.001, 0.3, 1]) {
      const { path, light, radiance } = column(h, mu0, 0.6);
      const s = { ...sample, cloudFraction: 1, opticalThickness: 1e12 };
      const actual = radiance(s), o = cloudOptics(s.opticalThickness, CLOUD_G_LIQUID, mu0, 0.6);
      // Independent old opaque expression: cloud reflection at its top plus above-cloud path only.
      for (let c = 0; c < 4; c++) {
        const old = m.weights[c].reduce((a, w, k) => a + w * (Math.PI * path.Lc[k]
          + path.Tcd[k] * (mu0 * o.R0 * escape(0.6) * light.tsc[k] + o.rbar * escape(0.6) * light.esc[k])), 0);
        expect(actual[c]).toBeCloseTo(old, 10);
      }
    }
  });
  it('unretrieved populations and transmitted ocean glint also recover clear air', () => {
    const mu0 = 0.3, mu = 0.3, glint = { cosBeta: 1, cosOmega: mu0 };
    for (const h of [0, 8, 16]) {
      const { path, light } = column(h, mu0, mu);
      const rad = (s: EarthSample) => earthAtmosphereRadiance(earthParts(s, mu0, mu, glint), path, light, m.weights, mu0);
      const clear = rad({ ...sample, cloudFraction: 0 });
      const transparent = rad({ ...sample, tauMoments: { fTau: 0, m1: 0, m2: 0, iceTau: 0 },
        unmeasuredTau: { taus: [0, 0], p: [0.25, 0.75] } });
      for (let c = 0; c < 4; c++) expect(transparent[c]).toBeCloseTo(clear[c], 12);
    }
  });
  it('lower-air attenuation decreases and cloud reflection increases continuously with thickness', () => {
    for (const mu0 of [0.001, 0.05, 0.3, 0.8, 1]) for (const mu of [0.05, 0.3, 0.9]) {
      let prevD = 1, prevF = 1, prevR = 0;
      for (const tau of [0, ...Array.from({ length: 161 }, (_, i) => 10 ** (-8 + i / 10))]) {
        const q = earthParts({ ...sample, surface: [0, 0, 0, 0], waterFraction: 0, cloudFraction: 1, opticalThickness: tau }, mu0, mu).cloudy;
        expect(q.lowerDirect).toBeLessThanOrEqual(prevD + 1e-14);
        expect(q.lowerDiffuse).toBeLessThanOrEqual(prevF + 1e-14);
        expect(q.dir[0]).toBeGreaterThanOrEqual(prevR - 1e-14);
        expect(q.lowerDirect).toBeGreaterThanOrEqual(0);
        expect(q.lowerDiffuse).toBeGreaterThanOrEqual(0);
        prevD = q.lowerDirect; prevF = q.lowerDiffuse; prevR = q.dir[0];
      }
    }
  });
  it('total radiance is continuous from transparent to opaque (it need not be monotonic)', () => {
    for (const h of [0, 8, 16]) for (const mu0 of [0.001, 0.3, 1]) for (const mu of [0.05, 0.9]) {
      const { radiance } = column(h, mu0, mu);
      for (const tau of [0, ...Array.from({ length: 65 }, (_, i) => 10 ** (-8 + i / 4))]) {
        const a = radiance({ ...sample, opticalThickness: tau });
        const b = radiance({ ...sample, opticalThickness: tau + Math.max(tau, 1e-8) * 1e-7 });
        for (let c = 0; c < 4; c++) {
          expect(a[c]).toBeGreaterThanOrEqual(0);
          expect(Math.abs(a[c] - b[c])).toBeLessThan(1e-7 * Math.max(1, a[c]));
        }
      }
    }
    // A thick cloud brightens a dark surface, but a thin one can first hide bright grazing air.
    const { radiance } = column(16, 0.3, 0.05);
    const dark = { ...sample, surface: [0, 0, 0, 0] as EarthSample['surface'], waterFraction: 0, cloudFraction: 1 };
    const zero = radiance({ ...dark, opticalThickness: 0 });
    const thin = radiance({ ...dark, opticalThickness: 1 });
    const thick = radiance({ ...dark, opticalThickness: 1e12 });
    expect(thin[1]).toBeLessThan(zero[1]);
    expect(thin[1]).toBeLessThan(thick[1]);
  });
  it('hemispheric reflected flux never exceeds incident flux for black through white surfaces', () => {
    // Normal solar incidence; 2∫ρ(μ)μ dμ is outgoing flux / E_sun. The Rayleigh fixture is
    // azimuthally symmetric here. This tests transport energy, not measured photometry agreement.
    for (const h of [0, 8, 16]) for (const tau of [0, 0.001, 0.1, 1, 10, 1e12]) for (const R of [0, 0.5, 1]) {
      const flux = [0, 0, 0, 0];
      for (let i = 0; i < 64; i++) {
        const mu = (i + 0.5) / 64, { radiance } = column(h, 1, mu);
        const rho = radiance({ ...sample, surface: [R, R, R, R], waterFraction: 0, cloudFraction: 1, opticalThickness: tau });
        for (let c = 0; c < 4; c++) flux[c] += 2 * mu * rho[c] / 64;
      }
      for (const f of flux) expect(f).toBeLessThanOrEqual(1 + 1e-5); // midpoint quadrature error only
    }
  });
});
