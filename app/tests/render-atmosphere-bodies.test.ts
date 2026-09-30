// Atmospheres over bodies drawn from their disk photometry (docs/rendering-earth.md §8), on the TEST FIXTURE
// atmosphere (fixtures/atmosphere.ts): the air's own light against single scattering, the surface-scale
// renormalization that keeps the measured p·Φ, the refusal when the air alone outshines the disk, and the
// Mars dust season lookup (fixture tables).
import { describe, expect, it } from 'vitest';
import {
  atmosphereDiskFactors, marsDustScale, precomputeAtmosphere, ProfileGrid, rayleighPhase, skyIrradianceK, sunTransmittanceK, viewPath,
} from '../src/render/atmosphere';
import type { AtmosphereBinding } from '../src/render/atmosphereGpu';
import { cameraGeom, prepareFrame } from '../src/render/frame';
import { LAMBERT_LAW, lawRadf } from '../src/render/spatial';
import { AdaptationState, computeEyeFrame } from '../src/eye/model';
import { DEFAULT_EYE_SETTINGS } from '../src/eye/settings';
import { AU_KM } from '../src/render/constants';
import type { SceneBody, SceneSnapshot } from '../src/render/scene';
import { fixtureRayleighAtmosphere } from './fixtures/atmosphere';

type V3 = [number, number, number];
const W = 1280, H = 720;
const R = 6000;
const m = fixtureRayleighAtmosphere({ bottomKm: R, topKm: R + 100 });
const tab = precomputeAtmosphere(m);
const grid = new ProfileGrid(m, 512);
const lambert = (_n: V3, mu0: number, mu: number) => {
  const r = mu0 > 0 ? lawRadf(LAMBERT_LAW, mu0, mu, 0) : 0;
  return { rho: [r, r, r, r], albedo: [1, 1, 1, 1] };
};

describe('atmosphere over a photometry-drawn body (fixture)', () => {
  it("the air's own light at zero phase ≈ single scattering, plus a little multiple scattering", () => {
    const f = atmosphereDiskFactors(m, tab, grid, [0, 0, 1], [0, 0, 1], lambert, 32);
    // Plane-parallel single scattering at μ0 = μ per unit irradiance: L = p(−1)·(1 − e^{−2τ/μ})/2 (p over 4π
    // normalised to 1); disk average of πL: π·p(−1)·∫(1 − e^{−2τ/μ}) μ dμ, flat fixture weights over the bins.
    let ss = 0;
    for (let k = 0; k < m.wavelengthsNm.length; k++) {
      const tau = 0.0116 * (550 / m.wavelengthsNm[k]) ** 4 * 8 * (1 - Math.exp(-100 / 8));
      let integ = 0;
      const n = 2000;
      for (let i = 0; i < n; i++) { const mu = (i + 0.5) / n; integ += (1 - Math.exp(-2 * tau / mu)) * mu / n; }
      ss += (Math.PI * rayleighPhase(-1, 0) * integ) / m.wavelengthsNm.length;
    }
    expect(f.Apath[1] / ss).toBeGreaterThan(0.97);
    expect(f.Apath[1] / ss).toBeLessThan(1.3); // multiple scattering: ~20 % at τ ≈ 0.04–0.19 (measured 1.21)
    // The Lambert disk alone: 2/3 at zero phase; under the air it is dimmer (τ ≈ 0.04–0.19 each way).
    expect(f.I0[1]).toBeCloseTo(2 / 3, 2);
    expect(f.Iatm[1]).toBeLessThan(f.I0[1]);
    expect(f.Iatm[1]).toBeGreaterThan(0.7 * f.I0[1]);
  });

  const eyeState = () => { const s = new AdaptationState(); s.update({ coneCdM2: 1e-5, rodCdM2: 1.4e-5, cornealFlux: 0 }, 0); return s; };
  const irr: [number, number, number, number] = [1.2e5, 1.3e5, 1.1e5, 2.9e5]; // test values
  function scene(p: number, phaseDeg: number, dist = 40000): SceneSnapshot {
    const a = (phaseDeg * Math.PI) / 180;
    const toSun: V3 = [5 * AU_KM * Math.sin(a), 0, 5 * AU_KM * Math.cos(a)];
    const pos: V3 = [0, 0, -dist];
    const b: SceneBody = {
      id: 7, name: 'Fixture', pos, toSun, orient: [1, 0, 0, 0, 1, 0, 0, 0, 1], radii: [R, R, R],
      albedoXYZS: irr.map((v) => p * v) as [number, number, number, number], phase: { kind: 'lambert' }, surfaceUnknown: false,
      worstLabel: 'measured', selected: false,
      atmosphere: { wavelengthsNm: m.wavelengthsNm, foldWeights: [], body: { altitudesKm: [0], topAltitudeKm: 100 } as never, worstLabel: 'estimated' },
    };
    return {
      et: 0, camera: { orient: [1, 0, 0, 0, 1, 0, 0, 0, 1], fovY: (40 * Math.PI) / 180, width: W, height: H },
      sun: { pos: [pos[0] + toSun[0], pos[1] + toSun[1], pos[2] + toSun[2]], radius: 696000, irradianceXYZS_1AU: irr, limbDarkening: null },
      bodies: [b], view: { mode: 'eye', exposureBoostStops: 0, overlays: { provenanceTint: false } }, orbits: [],
    };
  }
  const binding = (model = m, tables = tab, G = grid) => ({ model, tables, grid: G, key: `fixture|${model.species[0].scattering[0][0]}` }) as unknown as AtmosphereBinding;
  const eye = computeEyeFrame(DEFAULT_EYE_SETTINGS, eyeState(), 'eye', 0, null);
  const g = cameraGeom(scene(0.3, 0), W, H, 1e-7);

  it('the renormalized body (surface under the air, the air over the disk and beyond it) still reflects the measured p·Φ', () => {
    for (const phaseDeg of [0, 40]) {
      const s = scene(0.3, phaseDeg);
      const plain = prepareFrame(s, g, eye, 1e-9);
      const withAir = prepareFrame(s, g, eye, 1e-9, { atmospheres: () => binding() });
      const r = withAir.resolved[0];
      expect(r.atmosphere).not.toBeNull();
      expect(r.atmosphere!.onDisk).toBe(true);
      expect(plain.resolved[0].atmosphere).toBeNull();
      // Re-integrate what the shader draws (ATM_OVER_PHOTOMETRY) on a finer grid than frame.ts uses.
      const sunE = r.atmosphere!.sunE;
      const o: V3 = [0, 0, 1];
      const a = (phaseDeg * Math.PI) / 180;
      const sv: V3 = [Math.sin(a), 0, Math.cos(a)];
      const n = 48, Kb = tab.K;
      const ts = new Float64Array(Kb), es = new Float64Array(Kb);
      let sum = 0;
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const x = -1 + (2 * (i + 0.5)) / n, y = -1 + (2 * (j + 0.5)) / n;
        if (x * x + y * y >= 1) continue;
        const mu = Math.sqrt(1 - x * x - y * y);
        const nv: V3 = [x, y, mu];
        const mu0 = nv[0] * sv[0] + nv[1] * sv[1] + nv[2] * sv[2];
        const path = viewPath(m, tab, grid, [nv[0] * R, nv[1] * R, nv[2] * R], o, sv, -1, 24);
        sunTransmittanceK(m, tab, 0, mu0, ts);
        skyIrradianceK(m, tab, 0, mu0, es);
        const rho = mu0 > 0 ? lawRadf(LAMBERT_LAW, mu0, mu, a) : 0;
        let T2 = 0, Sky = 0, Lp = 0;
        for (let k = 0; k < Kb; k++) { T2 += m.weights[1][k] * ts[k] * path.T[k]; Sky += m.weights[1][k] * es[k] * path.T[k]; Lp += m.weights[1][k] * path.L[k]; }
        sum += ((r.K[1] * (rho * T2 + Sky) + Math.PI * sunE[1] * Lp) / sunE[1]) * ((2 / n) * (2 / n)) / Math.PI;
      }
      // Beyond the disk: the shell shader's chords (atmosphereDiskFactors' reference of it).
      const shell = atmosphereDiskFactors(m, tab, grid, o, sv, lambert, 8).Ashell[1];
      expect(shell).toBeGreaterThan(0);
      const lambertPhi = (Math.sin(a) + (Math.PI - a) * Math.cos(a)) / Math.PI;
      expect((sum + shell) / (0.3 * lambertPhi)).toBeCloseTo(1, 1);
      // And the surface itself is brighter than without air (it must make up for what the air takes).
      expect(r.K[1]).toBeGreaterThan(plain.resolved[0].K[1] * 0.9);
    }
  });

  it('beyond the measured phase range the surface scale comes from the range edge, and the air is added on top', () => {
    // A phase curve measured over 0–10° only (test values: Lambert's own Φ there), α = 70°: the photometry is
    // the law's extrapolation, which knows nothing of the air.
    const lam = (deg: number) => { const a = (deg * Math.PI) / 180; return (Math.sin(a) + (Math.PI - a) * Math.cos(a)) / Math.PI; };
    const measured = { kind: 'tabulated' as const, alphaDeg: [0, 2, 4, 6, 8, 10], deltaMag: [0, 2, 4, 6, 8, 10].map((d) => -2.5 * Math.log10(lam(d))) };
    const at = (deg: number) => {
      const s = scene(0.3, deg);
      s.bodies[0] = { ...s.bodies[0], phase: measured as never, allowPhaseExtrapolation: true };
      const plain = prepareFrame(s, g, eye, 1e-9).resolved[0].K;
      const r = prepareFrame(s, g, eye, 1e-9, { atmospheres: () => binding() });
      return { ratio: r.resolved[0].K.map((v, c) => v / plain[c]), r };
    };
    const edge = at(10), far = at(70);
    expect(far.r.resolved[0].atmosphere?.onDisk).toBe(true);
    for (let c = 0; c < 4; c++) expect(far.ratio[c]).toBeCloseTo(edge.ratio[c], 2);
    expect(far.r.warnings.join()).not.toMatch(/brighter than the measured disk/);
  });

  it('an atmosphere brighter than the measured disk is not drawn (and says so)', () => {
    const thick = fixtureRayleighAtmosphere({ bottomKm: R, topKm: R + 100, beta550: 0.3 });
    const tt = precomputeAtmosphere(thick);
    const s = scene(0.01, 0);
    const p = prepareFrame(s, g, eye, 1e-9, { atmospheres: () => binding(thick, tt, new ProfileGrid(thick, 512)) });
    expect(p.resolved[0].atmosphere).toBeNull();
    expect(p.warnings.join()).toMatch(/atmosphere alone is brighter than the measured disk/);
    const plain = prepareFrame(s, g, eye, 1e-9);
    expect(p.resolved[0].K).toEqual(plain.resolved[0].K);
  }, 60000);

  it('a surface hidden under its air keeps the measured disk; the air is drawn beyond it only', () => {
    // τ ≈ 16 at 550 nm: the surface cannot be seen, so no surface scale reproduces the disk.
    const opaque = fixtureRayleighAtmosphere({ bottomKm: R, topKm: R + 100, beta550: 2 });
    const to = precomputeAtmosphere(opaque);
    const s = scene(1.2, 0);
    const p = prepareFrame(s, g, eye, 1e-9, { atmospheres: () => binding(opaque, to, new ProfileGrid(opaque, 512)) });
    const r = p.resolved[0];
    expect(r.atmosphere).not.toBeNull();
    expect(r.atmosphere!.onDisk).toBe(false);
    expect(p.warnings.join()).toMatch(/drawn beyond the disk only/);
    const plain = prepareFrame(s, g, eye, 1e-9).resolved[0];
    for (let c = 0; c < 4; c++) {
      expect(r.K[c]).toBeLessThanOrEqual(plain.K[c]);
      expect(r.K[c]).toBeGreaterThan(0.9 * plain.K[c]);
    }
  }, 60000);

  it('an atmosphere whose scattering is not measured: no light, the shell only (marked not measured)', () => {
    const s = scene(0.3, 0);
    const stub = { model: { ...m, species: [] }, key: 'u', unmeasured: true } as unknown as AtmosphereBinding;
    const p = prepareFrame(s, g, eye, 1e-9, { atmospheres: () => ({ error: 'Fixture: haze single-scattering albedo not measured → its light is not drawn', unmeasured: stub }) });
    const r = p.resolved[0];
    expect(r.atmosphere).not.toBeNull();
    expect(r.atmosphere!.onDisk).toBe(false);
    expect(r.atmosphere!.binding.unmeasured).toBe(true);
    expect(r.K).toEqual(prepareFrame(s, g, eye, 1e-9).resolved[0].K);
    expect(p.warnings.join()).toMatch(/not measured/);
  });

  it('an atmosphere that cannot be built is reported, and the body is drawn without it', () => {
    const s = scene(0.3, 0);
    const p = prepareFrame(s, g, eye, 1e-9, { atmospheres: () => ({ error: 'Fixture: haze single-scattering albedo unknown → atmosphere not drawn' }) });
    expect(p.resolved[0].atmosphere).toBeNull();
    expect(p.warnings.join()).toMatch(/haze single-scattering albedo unknown/);
    expect(p.resolved[0].K).toEqual(prepareFrame(s, g, eye, 1e-9).resolved[0].K);
  });
});

describe('Mars dust season (fixture tables)', () => {
  const lsBins = Array.from({ length: 72 }, (_, i) => 2.5 + 5 * i);
  const body = {
    dustColumn: { value: { lsDeg: lsBins, globalMean610Pa: lsBins.map((l) => 0.2 + l / 1000), annualGlobalMean610Pa: 0.4 } },
    solarLongitude: { value: { et: [0, 100, 200], lsDeg: [350, 0, 10] } },
  };
  it('interpolates L_s across 360° and picks the nearest bin on the circle', () => {
    const a = marsDustScale(body, 60)!; // L_s 356
    expect(a.ls).toBeCloseTo(356, 6);
    expect(lsBins[a.bin]).toBe(357.5);
    expect(a.scale).toBeCloseTo((0.2 + 357.5 / 1000) / 0.4, 9);
    const b = marsDustScale(body, 160)!; // L_s 6
    expect(lsBins[b.bin]).toBe(7.5);
    const c = marsDustScale(body, 99)!; // L_s 359.9 → the 357.5 bin, not 2.5 (wrap-around distance 2.4 vs 2.6)
    expect(lsBins[c.bin]).toBe(357.5);
  });
  it('no dust table → no scaling', () => {
    expect(marsDustScale({}, 0)).toBeNull();
  });
});
