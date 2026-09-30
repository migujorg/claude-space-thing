// Rings (the pipeline's single-scattering-v1 reflectance model, both faces, footprint averaging,
// extinction profiles, unresolved ring light) and planetshine.
import { describe, expect, it } from 'vitest';
import {
  effectiveElevationDeg, interpNodes, prepareRings, ringAverage, ringIlluminance, ringProfile, ringRadial,
  ringRadialExact, ringW, RING_K0,
} from '../src/render/rings';
import { planetshineSources } from '../src/render/planetshine';
import { AU_KM } from '../src/render/constants';
import { diskIlluminance, lambertPhase } from '../src/render/photometry';
import type { SceneBody, SceneRings, SceneSnapshot } from '../src/render/scene';
import type { RingReflectance } from '../src/data/schema';
import { prepareBody } from '../src/render/raycast';
import { cameraGeom, prepareFrame } from '../src/render/frame';
import { AdaptationState, computeEyeFrame } from '../src/eye/model';
import { DEFAULT_EYE_SETTINGS } from '../src/eye/settings';

const sunIrr: [number, number, number, number] = [1.23e5, 1.28e5, 1.09e5, 2.94e5]; // test values

// ── TEST FIXTURE: a small invented ring model in the shape of rings.json (not data) ──────────────────
function fixtureModel(tau: (r: number) => number, opts: Partial<RingReflectance> = {}): RingReflectance {
  const start = 1000, step = 10, count = 201; // 1000–3000 km
  const r = Array.from({ length: count }, (_, i) => start + i * step);
  const W = (a: number): number[][][] => [0, 1].map((e) => [0, 1].map((p) => [a * (1 + e) * (1 - 0.5 * p), a * (1 + e) * (1 - 0.5 * p), 0.8 * a, 0.9 * a]));
  return {
    kind: 'single-scattering-v1', formula: 'test', radiusStartKm: start, radiusStepKm: step, count,
    normalTau: r.map(tau), litModulation: r.map(() => 1), unlitTau: r.map((x) => 0.5 * tau(x)), unlitGain: r.map(() => 2),
    phaseDeg: [1, 41], elevationEffDeg: [5, 25], minPhaseDeg: 1, maxPhaseDeg: 41,
    regions: [
      { name: 'inner', radiusKm: [1200, 1500], centerKm: 1350, powerLawExponent: 3, amplitudeXYZS: W(1) },
      { name: 'outer', radiusKm: [2500, 2800], centerKm: 2650, powerLawExponent: 3, amplitudeXYZS: W(3) },
    ],
    ...opts,
  };
}
function fixtureRings(m: RingReflectance | null, tau: (r: number) => number | null): SceneRings {
  const radiusKm = Array.from({ length: 201 }, (_, i) => 1000 + i * 10);
  return { normal: [0, 0, 1], opticalDepth: [{ radiusKm, normalTau: radiusKm.map(tau) }], reflectance: m, worstLabel: 'estimated' };
}

describe('ring reflectance model (architecture §6, single-scattering-v1)', () => {
  const m = fixtureModel(() => 1);
  it('optically thin: both faces tend to A·τ/(4μ) (lit) and A·g_u·τ_u/(4μ) (unlit)', () => {
    const thin = fixtureModel(() => 1e-6);
    for (const [mu, mu0] of [[0.3, 0.1], [0.8, 0.2], [0.5, 0.5]]) {
      expect(ringRadialExact(thin, 2000, mu, mu0, true)! / (1e-6 / (4 * mu))).toBeCloseTo(1, 4);
      expect(ringRadialExact(thin, 2000, mu, mu0, false)! / ((2 * 0.5e-6) / (4 * mu))).toBeCloseTo(1, 4);
    }
  });
  it('optically thick: the lit face tends to μ0/(4(μ + μ0)), the unlit face to zero', () => {
    const thick = fixtureModel(() => 60);
    expect(ringRadialExact(thick, 2000, 0.4, 0.2, true)).toBeCloseTo(0.2 / (4 * 0.6), 9);
    expect(ringRadialExact(thick, 2000, 0.4, 0.2, false)!).toBeLessThan(1e-20);
  });
  it('the unlit face is continuous at μ = μ0', () => {
    const a = ringRadialExact(m, 2000, 0.3, 0.3, false)!;
    const b = ringRadialExact(m, 2000, 0.3 + 1e-5, 0.3, false)!;
    expect(a / b).toBeCloseTo(1, 3);
  });
  it('W: region tables inside, linear in radius between regions, nearest outside; bilinear in (α, Beff), Beff clamped', () => {
    expect(ringW(m, 1300, 1, 5)[1]).toBeCloseTo(1, 9);
    expect(ringW(m, 2600, 1, 5)[1]).toBeCloseTo(3, 9);
    expect(ringW(m, 2000, 1, 5)[1]).toBeCloseTo(1 + (2 * (2000 - 1500)) / (2500 - 1500), 9);
    expect(ringW(m, 1000, 1, 5)[1]).toBeCloseTo(1, 9);
    expect(ringW(m, 2950, 1, 5)[1]).toBeCloseTo(3, 9);
    expect(ringW(m, 1300, 21, 15)[1]).toBeCloseTo(1.5 * 0.75, 9); // mid-phase, mid-elevation
    expect(ringW(m, 1300, 1, 1)[1]).toBeCloseTo(1, 9); // Beff below the table → edge value
    expect(ringW(m, 1300, 1, 60)[1]).toBeCloseTo(2, 9);
    expect(ringW(m, 1300, 1, 5)[2]).toBeCloseTo(0.8, 9);
  });
  it('effective elevation: sin Beff = 2μμ0/(μ + μ0)', () => {
    const mu = Math.sin((10 * Math.PI) / 180), mu0 = Math.sin((20 * Math.PI) / 180);
    expect(Math.sin((effectiveElevationDeg(mu, mu0) * Math.PI) / 180)).toBeCloseTo((2 * mu * mu0) / (mu + mu0), 12);
  });
});

describe('ring profiles and footprint averaging', () => {
  it('averages τ, flags unknown stretches, treats outside as empty known space', () => {
    const r = fixtureRings(null, (x) => (x > 2000 && x < 2100 ? null : x < 1500 ? 1 : 0.5));
    const p = ringProfile(r);
    expect(p.stride).toBe(1);
    const a = ringAverage(p, 1100, 1400);
    expect(a.tau).toBeCloseTo(1, 5);
    expect(a.knownTau).toBeCloseTo(1, 6);
    expect(a.knownRefl).toBe(0);
    expect(ringAverage(p, 2020, 2080).knownTau).toBeLessThan(0.05);
    const out = ringAverage(p, 3500, 3600);
    expect(out.tau).toBe(0);
    expect(out.knownTau).toBeCloseTo(1, 9);
    // Sub-bin footprints keep full precision (per-bin increments, not differences of large sums).
    const tiny = ringAverage(p, 2900.001, 2900.002);
    expect(tiny.tau).toBeCloseTo(0.5, 5);
  });
  it('a single-τ footprint reproduces the exact model for every geometry (log-linear node interpolation is exact there)', () => {
    const m = fixtureModel(() => 0.8);
    const p = ringProfile(fixtureRings(m, () => 0.8));
    const f = ringAverage(p, 1995, 2005);
    for (const [mu, mu0, lit] of [[0.5, 0.3, true], [0.05, 0.02, true], [0.01, 0.4, true], [0.4, 0.2, false], [0.2, 0.2, false], [0.03, 0.5, false]] as [number, number, boolean][]) {
      const exact = ringRadialExact(m, 2000, mu, mu0, lit)!;
      expect(ringRadial(f, mu, mu0, lit) / exact).toBeCloseTo(1, 4);
    }
  });
  it('a footprint mixing gaps and dense ringlets matches the exact footprint mean within 2 %', () => {
    // 20 km ringlets of τ = 1.5 in 20 km gaps; A varies too.
    const tau = (x: number) => (Math.floor(x / 20) % 2 ? 1.5 : 0);
    const m = fixtureModel(tau, {});
    m.litModulation = m.litModulation.map((_, i) => 0.8 + 0.4 * ((i % 7) / 6));
    const p = ringProfile(fixtureRings(m, tau));
    for (const [mu, mu0, lit] of [[0.5, 0.3, true], [0.1, 0.05, true], [0.4, 0.2, false], [0.25, 0.2, false], [0.05, 0.3, false]] as [number, number, boolean][]) {
      const f = ringAverage(p, 1600, 2400);
      // Exact mean over the same bins (bin centres, where the profile was sampled).
      let s = 0, n = 0;
      for (let b = 0; b < p.bins; b++) {
        const rc = p.rMin + ((b + 0.5) / p.bins) * (p.rMax - p.rMin);
        if (rc < 1600 || rc > 2400) continue;
        s += ringRadialExact(m, rc, mu, mu0, lit)!;
        n++;
      }
      expect(Math.abs(ringRadial(f, mu, mu0, lit) / (s / n) - 1)).toBeLessThan(0.02);
    }
  });
  it('node interpolation returns the value and derivative of a single exponential exactly', () => {
    const F = Array.from({ length: 22 }, (_, j) => 0.7 * Math.exp(-0.9 * RING_K0 * 2 ** (j / 2)));
    const [v, d] = interpNodes(F, RING_K0, 3.3);
    expect(v / (0.7 * Math.exp(-0.9 * 3.3))).toBeCloseTo(1, 10);
    expect(d / (-0.9 * v)).toBeCloseTo(1, 10);
  });
});

describe('ring systems per frame', () => {
  const base = (rings: SceneRings, pos: [number, number, number], toSun: [number, number, number]): SceneBody => ({
    id: 699, name: 'R', pos, toSun, orient: null, radii: [1, 1, 1],
    albedoXYZS: null, phase: null, surfaceUnknown: false, worstLabel: 'measured', selected: false, rings,
  });
  // Observer 30° above the ring plane, Sun 20° above on the same side, phase angle ~10°.
  const el = (deg: number, az: number): [number, number, number] => [Math.cos((deg * Math.PI) / 180) * Math.cos(az), Math.cos((deg * Math.PI) / 180) * Math.sin(az), Math.sin((deg * Math.PI) / 180)];
  const toObs = el(30, 0), toSunU = el(20, 0);
  it('resolved rings get the solar illuminance / π, faded in between 1 and 2 px; tiny rings add their light to the point', () => {
    const m = fixtureModel(() => 0.5);
    const rings = fixtureRings(m, () => 0.5);
    const far = 1e9;
    const b = base(rings, toObs.map((v) => -v * far) as [number, number, number], toSunU.map((v) => v * 9.5 * AU_KM) as [number, number, number]);
    const big = prepareRings(b, sunIrr, 695700, 1e-9);
    expect(big.draw!.esun[1]).toBeCloseTo(sunIrr[1] / 9.5 ** 2 / Math.PI, 3);
    expect(big.pointE).toBeNull();
    const tiny = prepareRings(b, sunIrr, 695700, 1);
    expect(tiny.draw).toBeNull();
    expect(tiny.pointE![1]).toBeGreaterThan(0);
  });
  it('unresolved ring light equals the model integrated over the ring area (tiny planet: no shadow or occultation)', () => {
    const m = fixtureModel(() => 0.5);
    const p = ringProfile(fixtureRings(m, () => 0.5));
    const D = 1e9;
    const esun: [number, number, number, number] = [1, 1, 1, 1];
    const M = prepareBody([0, 0, 0], [1e-3, 1e-3, 1e-3], null).M;
    const E = ringIlluminance(p, [0, 0, 1], toObs, D, toSunU, esun, M, 400, 16)!;
    // Direct quadrature of the exact model over radius.
    const mu = Math.sin(Math.PI / 6), mu0 = Math.sin(Math.PI / 9);
    const alpha = (Math.acos(toObs[0] * toSunU[0] + toObs[1] * toSunU[1] + toObs[2] * toSunU[2]) * 180) / Math.PI;
    const beff = effectiveElevationDeg(mu, mu0);
    let s = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const r = 1000 + ((i + 0.5) / n) * 2000;
      s += ringW(m, r, alpha, beff)[1] * ringRadialExact(m, r, mu, mu0, true)! * 2 * Math.PI * r * (2000 / n);
    }
    expect(E[1] / ((s * mu) / (D * D))).toBeCloseTo(1, 2);
  });
  it('a planet in the middle hides and shadows part of the rings', () => {
    const m = fixtureModel(() => 0.5);
    const p = ringProfile(fixtureRings(m, () => 0.5));
    const esun: [number, number, number, number] = [1, 1, 1, 1];
    const lowSun = el(3, 0); // Sun low (long shadow across the far side), phase angle 27°
    const tinyP = prepareBody([0, 0, 0], [1e-3, 1e-3, 1e-3], null).M;
    const bigP = prepareBody([0, 0, 0], [900, 900, 900], null).M;
    const a = ringIlluminance(p, [0, 0, 1], toObs, 1e9, lowSun, esun, tinyP)!;
    const b = ringIlluminance(p, [0, 0, 1], toObs, 1e9, lowSun, esun, bigP)!;
    expect(b[1]).toBeLessThan(0.97 * a[1]);
    expect(b[1]).toBeGreaterThan(0.5 * a[1]);
  });
  it('outside the model phase range the ring brightness is not measured: warning, no light', () => {
    const m = fixtureModel(() => 0.5);
    const b = base(fixtureRings(m, () => 0.5), toObs.map((v) => -v * 1e9) as [number, number, number], el(-40, Math.PI).map((v) => v * 9.5 * AU_KM) as [number, number, number]);
    const rf = prepareRings(b, sunIrr, 695700, 1);
    expect(rf.pointE).toBeNull();
    expect(rf.warnings.join()).toMatch(/outside the reflectance model/);
  });
  it('effective elevation below the calibrated tables is flagged as estimated', () => {
    const m = fixtureModel(() => 0.5);
    const b = base(fixtureRings(m, () => 0.5), el(2, 0).map((v) => -v * 1e9) as [number, number, number], el(3, 0.1).map((v) => v * 9.5 * AU_KM) as [number, number, number]);
    expect(prepareRings(b, sunIrr, 695700, 1e-9).warnings.join()).toMatch(/effective elevation .* held at the table edge \(estimated\)/);
  });
  it('rings without a reflectance model: drawn (absorbing, hatched) but never add light', () => {
    const b = base(fixtureRings(null, () => 0.5), toObs.map((v) => -v * 1e9) as [number, number, number], toSunU.map((v) => v * 9.5 * AU_KM) as [number, number, number]);
    const big = prepareRings(b, sunIrr, 695700, 1e-9);
    expect(big.draw!.profile.tables).toBeNull();
    expect(big.warnings.join()).toMatch(/reflectance not measured/);
    expect(prepareRings(b, sunIrr, 695700, 1).pointE).toBeNull();
  });
});

describe('an unresolved ringed planet in a frame', () => {
  it('its point source carries the globe\'s light plus the rings\' (and only the globe\'s when the ring reflectance is unknown)', () => {
    const W = 1280, H = 720;
    const st = new AdaptationState();
    st.update({ coneCdM2: 1e-3, rodCdM2: 1e-3, cornealFlux: 0 }, 0);
    const eye = computeEyeFrame(DEFAULT_EYE_SETTINGS, st, 'eye', 0, null);
    const albedo: [number, number, number, number] = [5e4, 5e4, 4e4, 1e5]; // test values
    const make = (m: RingReflectance | null): SceneSnapshot => ({
      et: 0, camera: { orient: [1, 0, 0, 0, 1, 0, 0, 0, 1], fovY: 1, width: W, height: H },
      sun: { pos: [0, 0.5e8, 1.4e8 - 1.3e7], radius: 695700, irradianceXYZS_1AU: sunIrr, limbDarkening: null },
      bodies: [{
        id: 699, name: 'R', pos: [0, 0, -1.3e7], toSun: [0, 0.5e8, 1.4e8], orient: null, radii: [600, 600, 600],
        albedoXYZS: albedo, phase: { kind: 'lambert' }, surfaceUnknown: false, worstLabel: 'measured', selected: false,
        rings: { ...fixtureRings(m, () => 0.5), normal: [0, 0.5, 0.866] },
      }],
      view: { mode: 'eye', exposureBoostStops: 0, overlays: { provenanceTint: false } }, orbits: [],
    });
    const g = cameraGeom(make(null), W, H, 1e-7);
    const withRings = prepareFrame(make(fixtureModel(() => 0.5)), g, eye, 1e-9);
    const globeOnly = prepareFrame(make(null), g, eye, 1e-9);
    expect(withRings.points.length).toBe(1);
    expect(globeOnly.points.length).toBe(1);
    const b = make(null).bodies[0];
    const dAU = Math.hypot(...b.toSun) / AU_KM;
    const alpha = Math.acos((-b.pos[2] * b.toSun[2]) / (Math.hypot(...b.pos) * Math.hypot(...b.toSun)));
    const Eglobe = diskIlluminance(albedo, dAU, 600, Math.hypot(...b.pos), lambertPhase(alpha));
    expect(globeOnly.points[0].E[1] / Eglobe[1]).toBeCloseTo(1, 6);
    expect(withRings.points[0].E[1]).toBeGreaterThan(1.5 * Eglobe[1]);
  });
});

describe('planetshine', () => {
  const albedo = (p: number): [number, number, number, number] => sunIrr.map((v) => v * p) as [number, number, number, number];
  const moon: SceneBody = {
    id: 301, name: 'M', pos: [0, 0, -10000], toSun: [AU_KM, 0, 0], orient: null, radii: [1737, 1737, 1737],
    albedoXYZS: albedo(0.12), phase: { kind: 'lambert' }, surfaceUnknown: false, worstLabel: 'measured', selected: false,
  };
  const earth: SceneBody = { ...moon, id: 399, name: 'E', pos: [0, 0, 374400], radii: [6371, 6371, 6371], albedoXYZS: albedo(0.37) };
  it('the source illuminance is the source body\'s disk photometry at the lit body (architecture §4.3)', () => {
    const [ps] = planetshineSources(moon, [moon, earth], sunIrr);
    expect(ps.sourceId).toBe(399);
    // Earth as seen from the Moon: phase angle 90° (Sun along +x, Moon along −z from Earth).
    const E = diskIlluminance(earth.albedoXYZS!, 1, 6371, 384400, lambertPhase(Math.PI / 2));
    expect(ps.E[1] / E[1]).toBeCloseTo(1, 6);
    expect(ps.dir[2]).toBeCloseTo(1, 9);
    // Lambert reflection with A_L = 1.5·p of the lit body.
    expect(ps.K[1]).toBeCloseTo((1.5 * 0.12 * ps.E[1]) / Math.PI, 12);
  });
  it('no source without photometry, and never the body itself', () => {
    expect(planetshineSources(moon, [moon, { ...earth, phase: null }], sunIrr)).toEqual([]);
    expect(planetshineSources(moon, [moon], sunIrr)).toEqual([]);
  });
});
