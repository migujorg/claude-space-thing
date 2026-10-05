// A body drawn from its atmosphere model (Titan; docs/rendering-earth.md §8 "Titan"), on TEST FIXTURES — not data:
// when the app attaches the surface under the air (extras.ts atmosphereFor), what the frame then draws (frame.ts:
// the model's own disk, not scaled to the disk photometry) and when the photometry still stands in, and the
// inspector's rows (inspectModel.ts atmosphereRows). The numbers of the real model are in render-titan.test.ts.
import { describe, expect, it } from 'vitest';
import { atmosphereFor } from '../src/app/extras';
import { precomputeAtmosphere, ProfileGrid } from '../src/render/atmosphere';
import type { AtmosphereBinding } from '../src/render/atmosphereGpu';
import { cameraGeom, prepareFrame } from '../src/render/frame';
import { LAMBERT_LAW } from '../src/render/spatial';
import { AdaptationState, computeEyeFrame } from '../src/eye/model';
import { DEFAULT_EYE_SETTINGS } from '../src/eye/settings';
import { AU_KM } from '../src/render/constants';
import type { AtmosphereFile, Label } from '../src/data/schema';
import type { SceneBody, SceneSnapshot } from '../src/render/scene';
import { atmosphereRows } from '../src/ui/inspectModel';
import { fixtureRayleighAtmosphere } from './fixtures/atmosphere';

type V3 = [number, number, number];
type XYZS = [number, number, number, number];

// ---- extras: when the surface is attached ------------------------------------------------------------------------
const comp = (id: string, ext: Label, ssa: Label) => ({
  id, description: `fixture ${id}`, columnOpticalDepth: [2],
  extinctionPerKm: { value: [[1]], label: ext, sources: ['fx'] },
  singleScatteringAlbedo: { value: ssa === 'unknown' ? null : [0.9], label: ssa, sources: ssa === 'unknown' ? [] : ['fx'] },
  phaseFunction: { value: ssa === 'unknown' ? null : { kind: 'rayleigh', depolarization: [0] }, label: ssa, sources: ssa === 'unknown' ? [] : ['fx'] },
});
const file = (components: unknown[], surfaceLabel: Label | null): AtmosphereFile => ({
  definition: '', wavelengthsNm: [550], channels: ['X', 'Y', 'Z', 'S'], foldWeights: { value: [[1], [1], [1], [1]], label: 'derived', sources: [] },
  bodies: {
    '1': {
      name: 'Fixture', naifId: 1, referenceRadiusKm: 1, altitudeReference: '', altitudesKm: [0], topAltitudeKm: 1, topRadiusKm: 2,
      scaleHeightKm: { value: 1, label: 'derived', sources: [] }, components,
      ...(surfaceLabel ? { surfaceReflectance: { value: { wavelengthsNm: [550], reflectance: [0.1], channelEquivalents: [0.11, 0.1, 0.07, 0.09] }, label: surfaceLabel, sources: ['fx'], method: 'fixture' } } : {}),
    },
  },
}) as unknown as AtmosphereFile;

describe('a body with a surface reflectance under its air (fixture)', () => {
  it('is drawn from its model when the surface and every component are known and admitted', () => {
    const f = file([comp('rayleigh', 'estimated', 'derived'), comp('haze', 'estimated', 'estimated')], 'estimated');
    const a = atmosphereFor(f, 1, 'best');
    expect(a?.surface).toEqual({ reflectance: [0.1], xyzs: [0.11, 0.1, 0.07, 0.09] });
    expect(a?.worstLabel).toBe('estimated');
    // Strict: the estimated air is withheld altogether, so the body keeps its disk photometry.
    expect(atmosphereFor(f, 1, 'strict')).toBeNull();
  });

  it('keeps its disk photometry when a component\'s scattering is unknown, or when the surface is not admitted', () => {
    // Unknown scattering: the air is passed without the surface (the renderer draws no light for it).
    const unknown = atmosphereFor(file([comp('rayleigh', 'estimated', 'derived'), comp('haze', 'estimated', 'unknown')], 'estimated'), 1, 'best');
    expect(unknown).not.toBeNull();
    expect(unknown!.surface).toBeUndefined();
    // Air admitted at Strict, surface estimated: the air is drawn over the photometry (renormalized), without it.
    const strict = atmosphereFor(file([comp('rayleigh', 'derived', 'derived')], 'estimated'), 1, 'strict');
    expect(strict).not.toBeNull();
    expect(strict!.surface).toBeUndefined();
    // No surface reflectance in the product (every body but Titan): never attached.
    expect(atmosphereFor(file([comp('rayleigh', 'derived', 'derived')], null), 1, 'best')!.surface).toBeUndefined();
  });

  it('has an inspector row per component, labelled with the worst of its parts, and one for the surface', () => {
    const f = file([comp('rayleigh', 'estimated', 'derived'), comp('haze', 'estimated', 'unknown')], 'estimated');
    const rows = atmosphereRows(f, 1, 'best');
    expect(rows.map((r) => r.key)).toEqual(['atm:rayleigh', 'atm:haze', 'atm:surface']);
    expect(rows.map((r) => r.label)).toEqual(['estimated', 'unknown', 'estimated']);
    expect(rows[0].value).toMatch(/^fixture rayleigh\. Vertical optical depth 2(\.0+)? at 550 nm, single-scattering albedo 0\.90*, phase function rayleigh$/);
    expect(rows[1].value).toContain('single-scattering albedo unknown');
    expect(rows[2].value).toContain('0.11');
    // Strict: the estimated rows are shown as withheld, the unknown one as unknown.
    expect(atmosphereRows(f, 1, 'strict').map((r) => !!r.withheld)).toEqual([true, false, true]);
    expect(atmosphereRows(f, 2, 'best')).toEqual([]);
    expect(atmosphereRows(null, 1, 'best')).toEqual([]);
  });
});

// ---- frame: what is drawn -------------------------------------------------------------------------------------------
const W = 1280, H = 720;
const R = 2575;
const m = fixtureRayleighAtmosphere({ bottomKm: R, topKm: R + 100 });
const tab = precomputeAtmosphere(m);
const grid = new ProfileGrid(m, 512);
const irr: XYZS = [1.2e5, 1.3e5, 1.1e5, 2.9e5]; // test values
const rho: XYZS = [0.11, 0.1, 0.07, 0.09];
const D_AU = 9.5;

function scene(phaseDeg: number, dist: number, p = 0.2, extra: Partial<SceneBody> = {}): SceneSnapshot {
  const a = (phaseDeg * Math.PI) / 180;
  const toSun: V3 = [D_AU * AU_KM * Math.sin(a), 0, D_AU * AU_KM * Math.cos(a)];
  const pos: V3 = [0, 0, -dist];
  const b: SceneBody = {
    id: 606, name: 'Fixture', pos, toSun, orient: [1, 0, 0, 0, 1, 0, 0, 0, 1], radii: [R, R, R],
    // Disk photometry measured to 5.7° only, like Titan's.
    albedoXYZS: irr.map((v) => p * v) as XYZS, phase: { kind: 'poly-mag', coeffs: [0, 0.003772], minDeg: 0, maxDeg: 5.7 }, surfaceUnknown: false,
    worstLabel: 'estimated', selected: false,
    atmosphere: {
      wavelengthsNm: m.wavelengthsNm, foldWeights: [], body: { altitudesKm: [0], topAltitudeKm: 100 } as never, worstLabel: 'estimated',
      surface: { reflectance: m.wavelengthsNm.map(() => 0.1), xyzs: rho },
    },
    ...extra,
  };
  return {
    et: 0, camera: { orient: [1, 0, 0, 0, 1, 0, 0, 0, 1], fovY: (40 * Math.PI) / 180, width: W, height: H },
    sun: { pos: [pos[0] + toSun[0], pos[1] + toSun[1], pos[2] + toSun[2]], radius: 696000, irradianceXYZS_1AU: irr, limbDarkening: null },
    bodies: [b], view: { mode: 'eye', exposureBoostStops: 0, overlays: { provenanceTint: false } }, orbits: [],
  };
}
const binding = () => ({ model: m, tables: tab, grid, key: 'fixture' }) as unknown as AtmosphereBinding;
const eyeState = () => { const s = new AdaptationState(); s.update({ coneCdM2: 1e-5, rodCdM2: 1.4e-5, cornealFlux: 0 }, 0); return s; };
const eye = computeEyeFrame(DEFAULT_EYE_SETTINGS, eyeState(), 'eye', 0, null);
const g = cameraGeom(scene(0, 40000), W, H, 1e-7);
const kModel = irr.map((v, c) => (v * rho[c]) / (Math.PI * D_AU * D_AU));

describe('the frame of a body drawn from its atmosphere model (fixture)', () => {
  it('a resolved disk is the model\'s own at any phase: sunlight on the surface reflectance, the air on top, no photometry', () => {
    for (const phaseDeg of [0, 5.7, 60, 150]) {
      // Two different disk photometries: what is drawn does not depend on them.
      const frames = [0.2, 0.4].map((p) => prepareFrame(scene(phaseDeg, 40000, p), g, eye, 1e-9, { atmospheres: () => binding() }));
      for (const f of frames) {
        const r = f.resolved[0];
        expect(r.lit).toBe(true);
        expect(r.hatch).toBe(false);
        expect(r.law).toBe(LAMBERT_LAW);
        expect(r.atmosphere?.onDisk).toBe(true);
        r.K.forEach((v, c) => expect(v).toBeCloseTo(kModel[c], 9));
        // The air's sunlight: E☉/π at the body's distance, unscaled.
        r.atmosphere!.sunE.forEach((v, c) => expect(v).toBeCloseTo(irr[c] / (Math.PI * D_AU * D_AU), 9));
        expect(f.points).toHaveLength(0);
        expect(f.warnings.filter((w) => w.startsWith('Fixture'))).toEqual([]);
      }
    }
  });

  it('until its tables are ready the disk photometry stands in, inside its phase range, without the air', () => {
    const p = 0.2;
    const f = prepareFrame(scene(3, 40000, p), g, eye, 1e-9, { atmospheres: () => ({ model: m, key: 'fixture' }) as unknown as AtmosphereBinding });
    const r = f.resolved[0];
    expect(r.atmosphere).toBeNull();
    expect(r.lit).toBe(true);
    // K = p·Φ(α)·E☉/(π d² I(α)) with the Lambert disk integral I ≈ 2/3 near opposition: not the model's scale.
    const phi = 10 ** (-0.4 * 0.003772 * 3);
    expect(r.K[1]).toBeGreaterThan((0.98 * (p * phi * irr[1])) / (Math.PI * D_AU * D_AU * (2 / 3)));
    expect(r.K[1]).toBeLessThan((1.02 * (p * phi * irr[1])) / (Math.PI * D_AU * D_AU * (2 / 3)));
    // Beyond the range, with no extrapolation allowed, there is nothing to stand in: marked, and said.
    const far = prepareFrame(scene(60, 40000, p), g, eye, 1e-9, { atmospheres: () => null });
    expect(far.resolved[0].lit).toBe(false);
    expect(far.resolved[0].hatch).toBe(true);
    expect(far.warnings.some((w) => w.includes('a resolved disk is drawn from its atmosphere model'))).toBe(true);
  });

  it('under a pixel across it is the point of its disk photometry', () => {
    const s = scene(3, 4e8);
    const f = prepareFrame(s, cameraGeom(s, W, H, 1e-7), eye, 1e-9, { atmospheres: () => binding() });
    expect(f.resolved).toHaveLength(0);
    expect(f.points).toHaveLength(1);
    // E = p·Φ(α)·E☉·(1/d²)(R/Δ)² (architecture §4.3).
    const phi = 10 ** (-0.4 * 0.003772 * 3);
    expect(f.points[0].E[1]).toBeCloseTo((0.2 * irr[1] * phi * R * R) / (D_AU * D_AU * 4e8 * 4e8), 12);
  });
});
