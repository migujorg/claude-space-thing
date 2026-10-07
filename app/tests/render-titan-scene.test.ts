// A body drawn from its atmosphere model (Titan; docs/rendering-earth.md §8 "Titan"), on TEST FIXTURES — not data:
// when the app attaches the surface under the air (extras.ts atmosphereFor), what the frame then draws (frame.ts:
// the model's disk scaled per channel to the disk photometry, architecture §4.3 and §4.4; the Earth with its layers
// is the exception) and when the photometry still stands in, the model's disk integral (atmosphere.ts), and the
// inspector's rows (inspectModel.ts atmosphereRows). The numbers of the real model are in render-titan.test.ts.
import { describe, expect, it, vi } from 'vitest';
import * as atmosphereMath from '../src/render/atmosphere';
import { atmosphereFor } from '../src/app/extras';
import { diskReflectanceSpectral, modelDiskXYZS, precomputeAtmosphere, ProfileGrid } from '../src/render/atmosphere';
import type { AtmosphereBinding } from '../src/render/atmosphereGpu';
import { cameraGeom, prepareFrame } from '../src/render/frame';
import { PROVENANCE_TINT } from '../src/render/overlays';
import { lambertPhase } from '../src/render/photometry';
import { LAMBERT_LAW } from '../src/render/spatial';
import { AdaptationState, computeEyeFrame } from '../src/eye/model';
import { DEFAULT_EYE_SETTINGS } from '../src/eye/settings';
import { AU_KM } from '../src/render/constants';
import type { AtmosphereFile, Label } from '../src/data/schema';
import type { SceneBody, SceneSnapshot } from '../src/render/scene';
import { atmosphereRows, rendererLines } from '../src/ui/inspectModel';
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

  it('the inspector shows the renderer\'s own lines about the selected body, and only those', () => {
    const warnings = [
      'Titan: atmosphere model scaled to the disk photometry at 3°, ×0.99 X, 0.99 Y, 0.88 Z, 0.95 S (measured p·Φ over the model\'s disk integral)',
      'Titania: phase extrapolated beyond measured range (0–35°) with the spatial law → estimated',
      'Saturn rings: phase angle 147.75° outside the reflectance model\'s 0.25–47° → ring brightness not measured (hatched)',
      'Saturn: Barkstrom law outside its fitted range → Lambert spatial distribution',
    ];
    expect(rendererLines(warnings, 'Titan')).toEqual([warnings[0].slice('Titan: '.length)]);
    expect(rendererLines(warnings, 'Saturn')).toEqual([warnings[2].slice('Saturn '.length), warnings[3].slice('Saturn: '.length)]);
    expect(rendererLines(warnings, 'Rhea')).toEqual([]);
    expect(rendererLines(undefined, 'Titan')).toEqual([]);
  });
});

// ---- the model's disk integral ---------------------------------------------------------------------------------------
const W = 1280, H = 720;
const R = 2575;
const m = fixtureRayleighAtmosphere({ bottomKm: R, topKm: R + 100 });
const tab = precomputeAtmosphere(m);
const grid = new ProfileGrid(m, 512);
const dir = (deg: number): V3 => [Math.sin((deg * Math.PI) / 180), 0, Math.cos((deg * Math.PI) / 180)];

describe('the disk integral of a body drawn from its atmosphere model (fixture)', () => {
  it('does not depend on its grid: 24 to 48 points across agree with 96 within 0.1 %, to 120° phase', () => {
    // Measured: within 0.05 %. The square grid of cell centres this replaced was off by −1.0 % at 24 and +1.0 % at 32
    // (its count of cells inside the disk), which a normalization would have put on the screen.
    const surface = m.wavelengthsNm.map(() => 0.1);
    for (const a of [0, 5.7, 60, 120]) {
      const fine = diskReflectanceSpectral(m, tab, grid, dir(a), [0, 0, 1], surface, 96);
      for (const n of [24, 32, 48]) {
        const d = diskReflectanceSpectral(m, tab, grid, dir(a), [0, 0, 1], surface, n);
        // The disk (surface and air over it) and the whole, at the bluest bin (the most air) and the reddest.
        for (const k of [0, m.wavelengthsNm.length - 1]) {
          expect(Math.abs((d.path[k] + d.ground[k]) / (fine.path[k] + fine.ground[k]) - 1), `disk, α ${a}°, n ${n}, bin ${k}`).toBeLessThan(1e-3);
          expect(Math.abs(d.A[k] / fine.A[k] - 1), `whole, α ${a}°, n ${n}, bin ${k}`).toBeLessThan(1e-3);
        }
      }
    }
  });

  it('under transparent air is the Lambert sphere: ρ·(2/3)·Φ_L(α)', () => {
    const clear = fixtureRayleighAtmosphere({ bottomKm: R, topKm: R + 100, beta550: 1e-12 });
    const ct = precomputeAtmosphere(clear);
    const cg = new ProfileGrid(clear, 512);
    for (const a of [0, 5.7, 60, 120]) {
      const d = diskReflectanceSpectral(clear, ct, cg, dir(a), [0, 0, 1], clear.wavelengthsNm.map(() => 0.1), 24);
      const exact = 0.1 * (2 / 3) * lambertPhase((a * Math.PI) / 180);
      expect(Math.abs(d.A[3] / exact - 1), `α ${a}°`).toBeLessThan(1e-3);
      expect(d.shell[3]).toBeLessThan(1e-9);
    }
  });

  it('folds to X, Y, Z, S as the shaders compose the pixel: the air per unit sunlight, the surface per unit reflectance', () => {
    const ones = m.wavelengthsNm.map(() => 1);
    const d = diskReflectanceSpectral(m, tab, grid, dir(5.7), [0, 0, 1], ones, 24);
    const f = modelDiskXYZS(m, tab, grid, dir(5.7), [0, 0, 1], 24);
    for (let c = 0; c < 4; c++) {
      let air = 0, sfc = 0;
      for (let k = 0; k < m.wavelengthsNm.length; k++) { air += m.weights[c][k] * (d.path[k] + d.shell[k]); sfc += m.weights[c][k] * d.ground[k]; }
      expect(f.air[c]).toBeCloseTo(air, 12);
      expect(f.surface[c]).toBeCloseTo(sfc, 12);
    }
  });
});

// ---- frame: what is drawn -------------------------------------------------------------------------------------------
const irr: XYZS = [1.2e5, 1.3e5, 1.1e5, 2.9e5]; // test values
const rho: XYZS = [0.11, 0.1, 0.07, 0.09];
const D_AU = 9.5;
const PHASE_COEFF = 0.003772;
const phiOf = (deg: number) => 10 ** (-0.4 * PHASE_COEFF * deg);

function scene(phaseDeg: number, dist: number, p: number | XYZS = 0.2, extra: Partial<SceneBody> = {}): SceneSnapshot {
  const a = (phaseDeg * Math.PI) / 180;
  const toSun: V3 = [D_AU * AU_KM * Math.sin(a), 0, D_AU * AU_KM * Math.cos(a)];
  const pos: V3 = [0, 0, -dist];
  const pc = typeof p === 'number' ? [p, p, p, p] : p;
  const b: SceneBody = {
    id: 606, name: 'Fixture', pos, toSun, orient: [1, 0, 0, 0, 1, 0, 0, 0, 1], radii: [R, R, R],
    // Disk photometry measured to 5.7° only, like Titan's.
    albedoXYZS: irr.map((v, c) => pc[c] * v) as XYZS, phase: { kind: 'poly-mag', coeffs: [0, PHASE_COEFF], minDeg: 0, maxDeg: 5.7 }, surfaceUnknown: false,
    worstLabel: 'measured', selected: false, allowPhaseExtrapolation: true,
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
/** Sunlight over π at the body: the scale of the air's light, and of the surface per unit reflectance. */
const sunOverPi = irr.map((v) => v / (Math.PI * D_AU * D_AU));
/**
 * The disk-integrated reflectance (X, Y, Z, S) a frame draws, from its two scales (the surface's K and the air's
 * sunE) and the model's disk integrals on a finer grid than the frame's: Σ over the pixel's terms as the shaders
 * compose them (modelDiskXYZS).
 */
function drawn(r: ReturnType<typeof prepareFrame>['resolved'][0], phaseDeg: number): number[] {
  const d = modelDiskXYZS(m, tab, grid, dir(phaseDeg), [0, 0, 1], 64);
  return [0, 1, 2, 3].map((c) => (r.atmosphere!.sunE[c] / sunOverPi[c]) * d.air[c] + (r.K[c] / sunOverPi[c]) * d.surface[c]);
}
const scaleLine = (f: ReturnType<typeof prepareFrame>) => f.warnings.filter((w) => w.startsWith('Fixture: atmosphere model scaled'));

describe('the frame of a body drawn from its atmosphere model (fixture)', () => {
  it('inside the photometry\'s range the drawn disk reflects the measured p·Φ(α) in every channel', () => {
    // Two disk photometries, one of them coloured: the picture follows the measurement, whatever the model gives.
    const photometries: (number | XYZS)[] = [0.2, [0.21, 0.2, 0.12, 0.16]];
    for (const phaseDeg of [0, 0.5, 3, 5.6]) {
      for (const p of photometries) {
        const f = prepareFrame(scene(phaseDeg, 40000, p), g, eye, 1e-9, { atmospheres: () => binding() });
        const r = f.resolved[0];
        expect(r.lit).toBe(true);
        expect(r.hatch).toBe(false);
        expect(r.law).toBe(LAMBERT_LAW);
        expect(r.atmosphere?.onDisk).toBe(true);
        const A = drawn(r, phaseDeg);
        const pc = typeof p === 'number' ? [p, p, p, p] : p;
        // 0.2 %: the 1° phase bins of the frame's disk integrals and its coarser grid (numerical).
        A.forEach((v, c) => expect(Math.abs(v / (pc[c] * phiOf(phaseDeg)) - 1), `α ${phaseDeg}°, channel ${c}`).toBeLessThan(2e-3));
        // One factor per channel on the whole model: the surface under the air and the air's own light alike.
        const fac = r.K.map((v, c) => v / (sunOverPi[c] * rho[c]));
        r.atmosphere!.sunE.forEach((v, c) => expect(v / sunOverPi[c]).toBeCloseTo(fac[c], 12));
        expect(f.points).toHaveLength(0);
        // The factors are said, per channel, and nothing else is warned.
        const line = scaleLine(f);
        expect(line).toHaveLength(1);
        expect(line[0]).toContain(`×${fac[0].toFixed(2)} X, ${fac[1].toFixed(2)} Y, ${fac[2].toFixed(2)} Z, ${fac[3].toFixed(2)} S`);
        expect(line[0]).not.toContain('estimated');
        expect(f.warnings.filter((w) => w.startsWith('Fixture'))).toHaveLength(1);
      }
    }
  });

  it('the factor is the measurement over the model: it follows the photometry, and no number of the model moves', () => {
    const a = prepareFrame(scene(3, 40000, 0.2), g, eye, 1e-9, { atmospheres: () => binding() }).resolved[0];
    const b2 = prepareFrame(scene(3, 40000, 0.4), g, eye, 1e-9, { atmospheres: () => binding() }).resolved[0];
    a.K.forEach((v, c) => expect(b2.K[c] / v).toBeCloseTo(2, 12));
    a.atmosphere!.sunE.forEach((v, c) => expect(b2.atmosphere!.sunE[c] / v).toBeCloseTo(2, 12));
    // A photometry equal to the model's own disk integral leaves the model as it is (factor 1).
    const d = modelDiskXYZS(m, tab, grid, dir(3), [0, 0, 1]);
    const own = [0, 1, 2, 3].map((c) => (d.air[c] + rho[c] * d.surface[c]) / phiOf(3)) as XYZS;
    const same = prepareFrame(scene(3, 40000, own), g, eye, 1e-9, { atmospheres: () => binding() }).resolved[0];
    same.K.forEach((v, c) => expect(Math.abs(v / (sunOverPi[c] * rho[c]) - 1)).toBeLessThan(1e-9));
  });

  it('beyond the measured range the factors of the range\'s edge are held, and the result is labelled estimated', () => {
    const edge = prepareFrame(scene(5.7, 40000), g, eye, 1e-9, { atmospheres: () => binding() }).resolved[0];
    const facEdge = edge.K.map((v, c) => v / (sunOverPi[c] * rho[c]));
    for (const phaseDeg of [6, 60, 150]) {
      const s = scene(phaseDeg, 40000);
      s.view.overlays.provenanceTint = true;
      const f = prepareFrame(s, g, eye, 1e-9, { atmospheres: () => binding() });
      const r = f.resolved[0];
      expect(r.lit).toBe(true);
      expect(r.hatch).toBe(false);
      r.K.forEach((v, c) => expect(v / (sunOverPi[c] * rho[c])).toBeCloseTo(facEdge[c], 12));
      r.atmosphere!.sunE.forEach((v, c) => expect(v / sunOverPi[c]).toBeCloseTo(facEdge[c], 12));
      // The body's label was measured: the continuation makes it estimated (tint), and the line says so.
      expect(r.tint?.slice(0, 3)).toEqual([...PROVENANCE_TINT.estimated]);
      const line = scaleLine(f);
      expect(line).toHaveLength(1);
      expect(line[0]).toContain('beyond the measured range (0–5.7°)');
      expect(line[0]).toContain(`×${facEdge[0].toFixed(2)} X`);
      expect(line[0]).toContain('→ estimated');
      // Fully resolved: no point part, so the spatial law's continuation is not in the picture and is not announced.
      expect(f.points).toHaveLength(0);
      expect(f.warnings.filter((w) => w.startsWith('Fixture'))).toHaveLength(1);
    }
  });

  it('at Strict (no continuation allowed) a phase beyond the range is not measured: marked, the model not drawn', () => {
    const f = prepareFrame(scene(60, 40000, 0.2, { allowPhaseExtrapolation: false }), g, eye, 1e-9, { atmospheres: () => binding() });
    const r = f.resolved[0];
    expect(r.lit).toBe(false);
    expect(r.hatch).toBe(true);
    expect(r.atmosphere).toBeNull();
    expect(f.warnings.filter((w) => w.startsWith('Fixture'))).toEqual(['Fixture: phase angle 60.0° outside the curve\'s validity 0–5.7° → sunlit part drawn as not measured (night side black)']);
    // Inside the range the same body is drawn, scaled, without an estimate.
    const inRange = prepareFrame(scene(3, 40000, 0.2, { allowPhaseExtrapolation: false }), g, eye, 1e-9, { atmospheres: () => binding() });
    expect(inRange.resolved[0].lit).toBe(true);
    expect(scaleLine(inRange)).toHaveLength(1);
  });

  it('until its tables are ready the disk photometry stands in, inside its phase range, without the air', () => {
    const p = 0.2;
    const f = prepareFrame(scene(3, 40000, p), g, eye, 1e-9, { atmospheres: () => ({ model: m, key: 'fixture' }) as unknown as AtmosphereBinding });
    const r = f.resolved[0];
    expect(r.atmosphere).toBeNull();
    expect(r.lit).toBe(true);
    // K = p·Φ(α)·E☉/(π d² I(α)) with the Lambert disk integral I ≈ 2/3 near opposition: not the model's scale.
    expect(r.K[1]).toBeGreaterThan((0.98 * (p * phiOf(3) * irr[1])) / (Math.PI * D_AU * D_AU * (2 / 3)));
    expect(r.K[1]).toBeLessThan((1.02 * (p * phiOf(3) * irr[1])) / (Math.PI * D_AU * D_AU * (2 / 3)));
    expect(scaleLine(f)).toHaveLength(0);
    // Beyond the range the stand-in is the spatial law's continuation (Best), or nothing (Strict): marked, and said.
    const best = prepareFrame(scene(60, 40000, p), g, eye, 1e-9, { atmospheres: () => null });
    expect(best.resolved[0].lit).toBe(true);
    expect(best.warnings.some((w) => w.includes('phase extrapolated beyond measured range (0–5.7°) with the spatial law → estimated'))).toBe(true);
    const far = prepareFrame(scene(60, 40000, p, { allowPhaseExtrapolation: false }), g, eye, 1e-9, { atmospheres: () => null });
    expect(far.resolved[0].lit).toBe(false);
    expect(far.resolved[0].hatch).toBe(true);
    expect(far.warnings.some((w) => w.includes('sunlit part drawn as not measured'))).toBe(true);
  });

  it('reuses the model integral for a point as its phase moves slowly, by data rather than body id', () => {
    const spy = vi.spyOn(atmosphereMath, 'modelDiskXYZS');
    try {
      const at = (a: number) => prepareFrame(scene(a, 2e7, 0.2, { id: 12345 }), g, eye, 1e-9,
        { atmospheres: () => ({ ...binding(), key: 'point-cache-test' }) });
      at(30.25);
      expect(spy).toHaveBeenCalledTimes(4); // 5° and 6° calibration edge, 30° and 31° current phase.
      at(30.26);
      expect(spy).toHaveBeenCalledTimes(4);
      at(31.25);
      expect(spy).toHaveBeenCalledTimes(5); // Only 32° is new.
    } finally { spy.mockRestore(); }
  });

  it('an in-range point uses photometry bit for bit, without model tables, an integral or a scaling line', () => {
    const integral = vi.spyOn(atmosphereMath, 'modelDiskXYZS');
    const tables = vi.fn(() => ({ ...binding(), key: 'in-range-point-no-integral' }));
    try {
      // Stay just inside the upper endpoint: angle reconstruction can round 5.7° outside its strict domain.
      for (const phase of [0, 0.5, 1.2, 3, 5.7 - 1e-9]) {
        const s = scene(phase, 2e7, [0.21, 0.2, 0.12, 0.16], { id: 12345 });
        // No atmosphere callback is the direct photometry path from before model point integration.
        const photometry = prepareFrame(s, g, eye, 1e-9);
        const point = prepareFrame(s, g, eye, 1e-9, { atmospheres: tables });
        expect(point.resolved).toHaveLength(0);
        expect(point.points).toHaveLength(1);
        expect.soft(point.points[0].E).toEqual(photometry.points[0].E);
        expect.soft(scaleLine(point)).toEqual([]);
        // The same source outside a narrow field still contributes its direct photometry to glare.
        const theta = 0.5 * Math.PI / 180;
        const offG = { ...g, tanX: Math.tan(Math.PI / 1800), tanY: Math.tan(Math.PI / 1800),
          back: [Math.sin(theta), 0, Math.cos(theta)] as V3,
          right: [Math.cos(theta), 0, -Math.sin(theta)] as V3 };
        const off = prepareFrame(s, offG, eye, 1e-9, { atmospheres: tables });
        expect(off.glare.find((v) => v.dir[2] === -1)?.E).toEqual(photometry.points[0].E);
      }
      expect.soft(tables).not.toHaveBeenCalled();
      expect.soft(integral).not.toHaveBeenCalled();
    } finally { integral.mockRestore(); }
  });

  it('an extrapolated point reports the disk\'s held edge factors once, rather than a spatial-law continuation', () => {
    for (const phase of [6, 60, 150]) {
      const point = prepareFrame(scene(phase, 2e7), g, eye, 1e-9, { atmospheres: () => binding() });
      const disk = prepareFrame(scene(phase, 40000), g, eye, 1e-9, { atmospheres: () => binding() });
      expect(point.resolved).toHaveLength(0);
      expect(point.points).toHaveLength(1);
      const lines = point.warnings.filter((w) => w.startsWith('Fixture:'));
      expect(lines).toEqual(scaleLine(disk));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('beyond the measured range (0–5.7°) and the factors of its edge are held → estimated');
      expect(lines[0]).not.toContain('with the spatial law');
    }
  });

  it('a body without a model-drawn disk keeps the point photometry bit for bit, with no table request', () => {
    const atmosphere = { ...scene(0, 40000).bodies[0].atmosphere!, surface: undefined };
    for (const a of [0, 3, 5.7, 30, 90, 150, 166]) {
      const s = scene(a, 2e7, 0.2, { atmosphere });
      const baseline = prepareFrame(s, g, eye, 1e-9);
      let requests = 0;
      const actual = prepareFrame(s, g, eye, 1e-9, { atmospheres: () => { requests++; return binding(); } });
      expect(actual).toEqual(baseline);
      expect(requests).toBe(0);
    }
  });

  it('under a pixel across it is the point of its disk photometry', () => {
    const s = scene(3, 4e8);
    const f = prepareFrame(s, cameraGeom(s, W, H, 1e-7), eye, 1e-9, { atmospheres: () => binding() });
    expect(f.resolved).toHaveLength(0);
    expect(f.points).toHaveLength(1);
    // E = p·Φ(α)·E☉·(1/d²)(R/Δ)² (architecture §4.3).
    expect(f.points[0].E[1]).toBeCloseTo((0.2 * irr[1] * phiOf(3) * R * R) / (D_AU * D_AU * 4e8 * 4e8), 12);
  });

  it('between one and two pixels the point part and the disk part are the same measured light, inside the range', () => {
    // Diameter 1.5 px: smooth(1, 2, 1.5) = 0.5 of the disk resolved.
    const dist = (2 * R) / (1.5 * g.pixelAngle);
    const s = scene(3, dist);
    const f = prepareFrame(s, g, eye, 1e-9, { atmospheres: () => binding() });
    expect(f.resolved).toHaveLength(1);
    expect(f.points).toHaveLength(1);
    const half = f.resolved[0];
    const A = drawn(half, 3);
    // The resolved half reflects half of p·Φ, the point carries the other half as illuminance.
    A.forEach((v, c) => expect(Math.abs(v / (0.5 * 0.2 * phiOf(3)) - 1), `channel ${c}`).toBeLessThan(2e-3));
    f.points[0].E.forEach((v, c) => expect(Math.abs(v / ((0.5 * 0.2 * irr[c] * phiOf(3) * R * R) / (D_AU * D_AU * dist * dist)) - 1)).toBeLessThan(1e-5));
  });
});

// ---- the exception: the Earth with its layers -------------------------------------------------------------------------
describe('the Earth drawn with its layers is not scaled to its disk photometry (fixture)', () => {
  // Earth mode (frame.ts earthMode): an albedo map of surface-only absolute reflectance with its cloud layer bound.
  const earthLayers = {
    albedo: { header: { normalization: { absoluteDiskMean: { X: 0.03, Y: 0.03, Z: 0.03, S: 0.03 } } } },
    clouds: {},
  } as unknown as SceneBody['surface'];
  const surfaces = () => ({ albedo: { base: 0, maxLevel: 0, zonal: null }, clouds: { base: 0, maxLevel: 0 } });
  const air = { wavelengthsNm: m.wavelengthsNm, foldWeights: [], body: { altitudesKm: [0], topAltitudeKm: 100 } as never, worstLabel: 'estimated' as const };

  it('its point is unchanged bit for bit even if its atmosphere carries a surface: Earth mode wins', () => {
    for (const a of [0, 3, 5.7, 30, 90, 150, 166]) {
      const s = scene(a, 2e7, 0.2, { surface: earthLayers, atmosphere: air });
      const baseline = prepareFrame(s, g, eye, 1e-9, { atmospheres: () => binding(), surfaces });
      s.bodies[0].atmosphere = { ...air, surface: { reflectance: m.wavelengthsNm.map(() => 0.1), xyzs: rho } };
      let requests = 0;
      const actual = prepareFrame(s, g, eye, 1e-9, { atmospheres: () => { requests++; return binding(); }, surfaces });
      // Object identity in the resolved body is absent here: this is a pure point.
      expect(actual.resolved).toHaveLength(0);
      expect(actual.points).toHaveLength(1);
      expect(actual).toEqual(baseline);
      expect(requests).toBe(0);
    }
  });

  it('its surface and its air keep the absolute scale E☉/(π d²) at every phase, whatever the disk photometry says', () => {
    for (const atmosphere of [air, { ...air, surface: { reflectance: m.wavelengthsNm.map(() => 0.1), xyzs: rho } }]) {
      for (const phaseDeg of [0, 3, 60, 150]) {
        for (const p of [0.2, 0.4]) {
          const s = scene(phaseDeg, 40000, p, { surface: earthLayers, atmosphere, phase: { kind: 'lambert' } });
          const f = prepareFrame(s, g, eye, 1e-9, { atmospheres: () => binding(), surfaces });
          const r = f.resolved[0];
          expect(r.earth).not.toBeNull();
          expect(r.lit).toBe(true);
          expect(r.law).toBe(LAMBERT_LAW);
          r.K.forEach((v, c) => expect(v).toBeCloseTo(sunOverPi[c], 9));
          expect(r.atmosphere?.onDisk).toBe(true);
          r.atmosphere!.sunE.forEach((v, c) => expect(v).toBeCloseTo(sunOverPi[c], 9));
          expect(f.warnings.filter((w) => w.includes('scaled'))).toEqual([]);
        }
      }
    }
  });
});
