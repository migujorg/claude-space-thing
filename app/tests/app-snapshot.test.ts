import { describe, expect, it } from 'vitest';
import { buildSnapshot, buildSun } from '../src/app/snapshot';
import { IauOrientationSet } from '../src/app/orientation';
import { computeWorld } from '../src/app/world';
import { defaultReality } from '../src/app/reality';
import { DEFAULT_EYE_SETTINGS } from '../src/eye/settings';
import type { SceneCamera } from '../src/render/scene';
import type { Vec3 } from '../src/app/ports';
import { body, FakeEphemerisSet, fakeBodyToIcrf, fakeLight, makeApparent, ScratchEphemerisSet } from './app-fakes';

const C = 1000; // test signal speed, km/s: makes light-time large and easy to see
const cam: SceneCamera = { orient: [1, 0, 0, 0, 1, 0, 0, 0, 1], fovY: 1, width: 100, height: 100 };

// Sun fixed at origin; planet moving along +Y at 10 km/s from x = 1e6; moon circles the planet.
const planetAt = (t: number): Vec3 => [1e6, 10 * t, 0];
const eph = new FakeEphemerisSet({
  10: () => [0, 0, 0],
  3: (t) => planetAt(t), // barycenter: never drawn
  399: planetAt,
  301: (t) => { const p = planetAt(t); return [p[0] + 5e4 * Math.cos(t / 1e4), p[1] + 5e4 * Math.sin(t / 1e4), 0]; },
});
const bodies = [
  body(10, 'Sun', 'star', { r: 500 }),
  body(3, 'Bary', 'barycenter'),
  body(399, 'Planet', 'planet', { albedo: 'measured', phase: 'estimated', parent: undefined }),
  body(301, 'Moon', 'moon', { parent: 399, rLabel: 'estimated', albedo: 'measured', phase: 'measured' }),
];
const core = { apparentPosition: makeApparent(C), bodyToIcrf: fakeBodyToIcrf };
const iau = () => new IauOrientationSet(bodies, fakeBodyToIcrf);

function snap(et: number, camPos: Vec3, reality = defaultReality(), selectedId: number | null = null) {
  const world = computeWorld(et, camPos, bodies, eph, core, 10);
  return { world, s: buildSnapshot({ world, camera: cam, reality, light: fakeLight(), selectedId, orbits: [], orientations: iau() }) };
}

describe('buildSnapshot', () => {
  it('positions are camera-relative and light-time corrected', () => {
    const camPos: Vec3 = [1e6 - 2e5, 0, 0];
    const { s } = snap(1000, camPos);
    const p = s.bodies.find((b) => b.id === 399)!;
    // light time ≈ 2e5 km / 1000 km/s = 200 s → planet seen where it was at et − ~200 s
    const tau = Math.hypot(2e5, 10 * (1000 - 200)) / C;
    expect(p.pos[0]).toBeCloseTo(2e5, 3);
    expect(p.pos[1]).toBeCloseTo(10 * (1000 - tau), 0);
    expect(p.pos[1]).toBeLessThan(10 * 1000 - 1000); // not the geometric position
  });

  it('toSun and orientation use the emission epoch', () => {
    const camPos: Vec3 = [1e6 - 2e5, 0, 0];
    const { world, s } = snap(1000, camPos);
    const g = world.bodies.get(399)!;
    const p = s.bodies.find((b) => b.id === 399)!;
    const emit = g.app!.emitEt;
    expect(emit).toBeLessThan(1000);
    expect(p.toSun[0]).toBeCloseTo(-1e6, 6);
    expect(p.toSun[1]).toBeCloseTo(-10 * emit, 6);
    expect(p.orient).toEqual(fakeBodyToIcrf(bodies[2].rotation.value!, emit));
  });

  it('excludes the Sun and barycenters from bodies; the Sun comes from light.json', () => {
    const { s } = snap(0, [5e5, 0, 0]);
    expect(s.bodies.map((b) => b.id).sort()).toEqual([301, 399]);
    expect(s.sun).not.toBeNull();
    expect(s.sun!.radius).toBe(500);
    expect(s.sun!.irradianceXYZS_1AU).toEqual([10, 11, 12, 13]);
    expect(s.sun!.pos[0]).toBeCloseTo(-5e5, 6);
    expect(s.sun!.limbDarkening).toEqual([[1], [1], [1], [1]]);
  });

  it('applies the reality filter per level', () => {
    const best = snap(0, [5e5, 0, 0]).s;
    const strict = snap(0, [5e5, 0, 0], { ...defaultReality(), exists: 'strict' }).s;
    const pb = best.bodies.find((b) => b.id === 399)!;
    const ps = strict.bodies.find((b) => b.id === 399)!;
    expect(pb.surfaceUnknown).toBe(false);
    expect(pb.worstLabel).toBe('estimated');
    expect(ps.surfaceUnknown).toBe(true); // phase function estimated → not admitted
    expect(ps.albedoXYZS).toBeNull();
    expect(ps.phase).toBeNull();
    const ms = strict.bodies.find((b) => b.id === 301)!;
    expect(ms.radii).toBeNull(); // estimated radius withheld at strict
    expect(ms.albedoXYZS).not.toBeNull(); // still drawn as a point of known brightness
    expect(ms.orient).toBeNull();
  });

  it('marks selection and passes view settings (boost only when enhanced)', () => {
    const r = { ...defaultReality(), exposureBoostStops: 3 };
    const eye = snap(0, [5e5, 0, 0], r, 301).s;
    expect(eye.bodies.find((b) => b.id === 301)!.selected).toBe(true);
    expect(eye.bodies.find((b) => b.id === 399)!.selected).toBe(false);
    expect(eye.view).toEqual({ mode: 'eye', exposureBoostStops: 0, overlays: { provenanceTint: false }, adaptation: { mode: 'realtime' } });
    expect(snap(0, [5e5, 0, 0], { ...r, instantAdaptation: true }).s.view.adaptation).toEqual({ mode: 'instant' });
    const enh = snap(0, [5e5, 0, 0], { ...r, view: 'enhanced' }).s;
    expect(enh.view.exposureBoostStops).toBe(3);
  });

  it('the app\'s observer is an eye: its snapshot never overrides the eye settings, so the optical core is on', () => {
    for (const view of ['eye', 'enhanced'] as const) {
      const { s } = snap(0, [5e5, 0, 0], { ...defaultReality(), view });
      expect(s.view.eye).toBeUndefined();
    }
    expect(DEFAULT_EYE_SETTINGS.opticalCore).toBe(true);
  });
  it('omits bodies without ephemeris coverage (never extrapolates)', () => {
    const limited = new FakeEphemerisSet({ 10: () => [0, 0, 0], 399: planetAt }, { startEt: 0, endEt: 100 });
    const world = computeWorld(500, [1, 0, 0], bodies, limited, core, 10);
    expect(world.bodies.get(399)!.app).toBeNull();
    const s = buildSnapshot({ world, camera: cam, reality: defaultReality(), light: fakeLight(), selectedId: null, orbits: [], orientations: iau() });
    expect(s.bodies).toHaveLength(0);
    expect(s.sun).toBeNull();
  });

  it('is not fooled by ephemerides that reuse scratch arrays', () => {
    const scratch = new ScratchEphemerisSet({ 10: () => [0, 0, 0], 399: planetAt, 301: (t) => [2e6, t, 0] });
    const world = computeWorld(1000, [1e6 - 2e5, 0, 0], bodies, scratch, core, 10);
    const a = world.bodies.get(399)!, b = world.bodies.get(301)!;
    expect(a.app!.rel).not.toBe(b.app!.rel);
    expect(a.app!.rel[0]).toBeCloseTo(2e5, 6);
    expect(b.app!.rel[0]).toBeCloseTo(1.2e6, 6);
    expect(a.toSun![0]).toBeCloseTo(-1e6, 6); // not zero (Sun and body read from the same scratch)
  });

  it('withholds the Sun when its irradiance is not admitted', () => {
    const world = computeWorld(0, [5e5, 0, 0], bodies, eph, core, 10);
    const r = buildSun(world, fakeLight('estimated'), 'strict');
    expect(r.sun).toBeNull();
    expect(r.reason).toMatch(/estimated/);
    expect(buildSun(world, null, 'best').reason).toMatch(/light.json/);
  });

  it('drops orbits unless the overlay is on', () => {
    const world = computeWorld(0, [5e5, 0, 0], bodies, eph, core, 10);
    const orbits = [{ id: 399, points: new Float64Array(6), selected: false }];
    const off = buildSnapshot({ world, camera: cam, reality: defaultReality(), light: null, selectedId: null, orbits, orientations: iau() });
    expect(off.orbits).toEqual([]);
    const r = defaultReality();
    r.overlays.orbits = true;
    const on = buildSnapshot({ world, camera: cam, reality: r, light: null, selectedId: null, orbits, orientations: iau() });
    expect(on.orbits).toHaveLength(1);
  });
});

// A mean reference stays derived regardless of its single-view spread.
describe('ellipsoid calibration at Strict and Best', () => {
  for (const calibration of ['dated', 'mean', 'estimated'] as const) for (const level of ['strict', 'best'] as const) {
    it(`${calibration} view at ${level}`, () => {
      const b = body(399, 'Planet', 'planet', {albedo: 'measured', phase: 'measured'});
      b.radii.value = [10, 10, 9];
      b.photometry!.albedoMeasurementView = {value: calibration === 'dated' ? {kind:'latitude', latitudeDeg: 40} : {kind:'orientation-mean'}, label: calibration === 'estimated' ? 'estimated' : 'derived', sources: ['test']};
      b.photometry!.albedoViewSpread = {value: {bareMaxRelative: 2}, label:'derived', sources:['test']};
      const bs = [body(10,'Sun','star',{r:500}), b];
      const world = computeWorld(0, [5e5,0,0], bs, eph, core, 10);
      const s = buildSnapshot({world, camera: cam, reality:{...defaultReality(), exists:level},light:fakeLight(), selectedId:null, orbits:[],orientations:new IauOrientationSet(bs,fakeBodyToIcrf)});
      const p = s.bodies.find(b => b.id === 399)!;
      expect(p.albedoMeasurementView).toEqual(b.photometry!.albedoMeasurementView.value);
      const hidden = calibration === 'estimated' && level === 'strict';
      expect(p.surfaceUnknown).toBe(hidden);
      expect(p.albedoXYZS === null).toBe(hidden);
      expect(p.phase === null).toBe(hidden);
      expect(p.worstLabel).toBe(calibration === 'estimated' && level === 'best' ? 'estimated' : 'derived');
    });
  }
});
