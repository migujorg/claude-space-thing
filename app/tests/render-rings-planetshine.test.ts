// Rings (single-scattering layer, both faces, transmission, profile averaging) and planetshine.
import { describe, expect, it } from 'vitest';
import { hgPhase, prepareRings, ringAverage, ringProfile, ringReflectance } from '../src/render/rings';
import { planetshineSources } from '../src/render/planetshine';
import { AU_KM } from '../src/render/constants';
import { diskIlluminance, lambertPhase } from '../src/render/photometry';
import type { SceneBody, SceneRings } from '../src/render/scene';

const sunIrr: [number, number, number, number] = [1.23e5, 1.28e5, 1.09e5, 2.94e5]; // test values

describe('ring photometry', () => {
  it('optically thin: both faces give I/F → ϖ0Pτ/(4μ) (the same from either side)', () => {
    const tau = 1e-6;
    for (const [mu, mu0] of [[0.3, 0.1], [0.8, 0.2], [0.5, 0.5]]) {
      expect(ringReflectance(tau, mu, mu0, true) / (tau / mu)).toBeCloseTo(1, 3);
      expect(ringReflectance(tau, mu, mu0, false) / (tau / mu)).toBeCloseTo(1, 3);
    }
  });
  it('optically thick: the lit face tends to Lommel–Seeliger μ0/(μ + μ0), the unlit face to zero', () => {
    expect(ringReflectance(50, 0.4, 0.2, true)).toBeCloseTo(0.2 / 0.6, 9);
    expect(ringReflectance(50, 0.4, 0.2, false)).toBeLessThan(1e-20);
  });
  it('the unlit face is continuous at μ = μ0', () => {
    const a = ringReflectance(0.7, 0.3, 0.3, false);
    const b = ringReflectance(0.7, 0.3 + 1e-4, 0.3, false);
    expect(a / b).toBeCloseTo(1, 3);
  });
  it('Henyey–Greenstein is normalized: ∫P dΩ/4π = 1', () => {
    for (const g of [-0.4, 0, 0.6]) {
      let s = 0;
      const n = 20000;
      for (let i = 0; i < n; i++) {
        const a = ((i + 0.5) / n) * Math.PI;
        s += hgPhase(a, g) * 0.5 * Math.sin(a) * (Math.PI / n);
      }
      expect(s).toBeCloseTo(1, 3);
    }
  });
});

describe('ring profiles', () => {
  const rings: SceneRings = {
    normal: [0, 0, 1],
    radiusKm: [100, 200, 300, 400],
    tau: [1, 1, null, 0.5],
    albedoXYZS: [[0.5, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5], null, [0.3, 0.3, 0.3, 0.3]],
    particlePhase: { kind: 'hg', g: -0.3 },
    worstLabel: 'estimated',
  };
  it('averages τ over a radius range, flags unknown stretches, and treats outside as empty known space', () => {
    const p = ringProfile(rings);
    const a = ringAverage(p, 110, 190);
    expect(a.tau).toBeCloseTo(1, 6);
    expect(a.knownTau).toBeCloseTo(1, 6);
    expect(a.albedo[1]).toBeCloseTo(0.5, 6);
    const gap = ringAverage(p, 210, 290);
    expect(gap.knownTau).toBeLessThan(0.1);
    const out = ringAverage(p, 450, 500);
    expect(out.tau).toBe(0);
    expect(out.knownTau).toBeCloseTo(1, 9);
  });
  it('prepares a drawable ring system with the solar illuminance at the planet', () => {
    const body: SceneBody = {
      id: 699, name: 'R', pos: [0, 0, -2e6], toSun: [9.5 * AU_KM, 0, 0], orient: null, radii: [60, 60, 60],
      albedoXYZS: null, phase: null, surfaceUnknown: false, worstLabel: 'measured', selected: false, rings,
    };
    const r = prepareRings(body, sunIrr, 695700, 1e-5)!;
    expect(r).not.toBeNull();
    expect(r.esun[1]).toBeCloseTo(sunIrr[1] / 9.5 ** 2 / Math.PI, 3);
    expect(r.phaseKind).toBe(1);
    expect(prepareRings(body, sunIrr, 695700, 1)).toBeNull(); // sub-pixel: not drawn
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
