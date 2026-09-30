import { describe, expect, it } from 'vitest';
import { buildTrack, OrbitManager, orbitParentId, orbitSpan, osculatingPeriod, trackPolyline } from '../src/app/orbits';
import { computeWorld } from '../src/app/world';
import type { Vec3 } from '../src/app/ports';
import { body, FakeEphemerisSet, makeApparent, ScratchEphemerisSet, src } from './app-fakes';

// Circular test orbit: radius R around a parent moving linearly; μ chosen so the period is known.
const R = 1e5, T = 1e6, MU = (4 * Math.PI * Math.PI * R ** 3) / T ** 2;
const parentAt = (t: number): Vec3 => [1e8, 3 * t, 0];
const moonAt = (t: number): Vec3 => {
  const p = parentAt(t), w = (2 * Math.PI) / T;
  return [p[0] + R * Math.cos(w * t), p[1] + R * Math.sin(w * t), p[2]];
};
const eph = new FakeEphemerisSet({ 10: () => [0, 0, 0], 1: parentAt, 2: moonAt }, { startEt: 0, endEt: 10 * T });
const parent = body(1, 'P', 'planet', { gm: src(MU * 0.99, 'measured') });
const moon = body(2, 'M', 'moon', { parent: 1, gm: src(MU * 0.01, 'measured') });

describe('orbits', () => {
  it('osculating period of a circular orbit', () => {
    const v = (2 * Math.PI * R) / T;
    expect(osculatingPeriod([R, 0, 0], [0, v, 0], MU)! / T).toBeCloseTo(1, 9);
    expect(osculatingPeriod([R, 0, 0], [0, 10 * v, 0], MU)).toBeNull(); // unbound
  });

  it('parent is the UI parent unless that is a barycenter; otherwise the Sun', () => {
    const byId = new Map([[1, parent], [2, moon], [3, body(3, 'B', 'barycenter')], [10, body(10, 'S', 'star')]]);
    expect(orbitParentId(moon, byId, 10)).toBe(1);
    expect(orbitParentId(parent, byId, 10)).toBe(10);
    expect(orbitParentId(body(4, 'X', 'planet', { parent: 3 }), byId, 10)).toBe(10);
    expect(orbitParentId(byId.get(10)!, byId, 10)).toBeNull();
  });

  it('span is one period around now, kept inside the window, or the whole window', () => {
    const w = { startEt: 0, endEt: 100 };
    expect(orbitSpan(50, 10, w)).toEqual([45, 55]);
    expect(orbitSpan(2, 10, w)).toEqual([0, 10]);
    expect(orbitSpan(99, 10, w)).toEqual([90, 100]);
    expect(orbitSpan(50, 500, w)).toEqual([0, 100]);
    expect(orbitSpan(50, null, w)).toEqual([0, 100]);
  });

  it('track is relative to the parent and the polyline is camera-relative via the parent', () => {
    const w = eph.window;
    const tr = buildTrack(eph, moon, parent, w, 5 * T, 256)!;
    expect(tr.period! / T).toBeCloseTo(1, 3);
    // every sample lies on the circle of radius R around the parent
    for (let i = 0; i < tr.n; i += 97) expect(Math.hypot(tr.rel[3 * i], tr.rel[3 * i + 1], tr.rel[3 * i + 2])).toBeCloseTo(R, 3);
    const parentCam: Vec3 = [-7, 8, 9];
    const pl = trackPolyline(tr, 5 * T, w, parentCam, true);
    expect(pl.selected).toBe(true);
    const n = pl.points.length / 3;
    expect(n).toBeGreaterThan(200);
    expect(n).toBeLessThan(300); // one period ≈ 256 samples, not the whole 10-period window
    const d0 = Math.hypot(pl.points[0] - parentCam[0], pl.points[1] - parentCam[1], pl.points[2] - parentCam[2]);
    expect(d0).toBeCloseTo(R, 3);
  });

  it('is not fooled by ephemerides that reuse scratch arrays', () => {
    const scratch = new ScratchEphemerisSet({ 10: () => [0, 0, 0], 1: parentAt, 2: moonAt }, { startEt: 0, endEt: 10 * T });
    const tr = buildTrack(scratch, moon, parent, scratch.window, 5 * T, 256)!;
    expect(tr.period! / T).toBeCloseTo(1, 3);
    expect(Math.hypot(tr.rel[0], tr.rel[1], tr.rel[2])).toBeCloseTo(R, 3);
  });

  it("a moon of unknown GM still gets its period from the parent's GM", () => {
    const noGm = body(2, 'M', 'moon', { parent: 1, gm: src<number>(null, 'unknown') });
    const tr = buildTrack(eph, noGm, parent, eph.window, 5 * T, 256)!;
    // circular speed for MU, but μ = 0.99 MU → slightly eccentric: a = 0.99 R / 0.98, T' = 2π √(a³/μ)
    expect(tr.period! / T).toBeCloseTo(Math.sqrt((0.99 / 0.98) ** 3 / 0.99), 3);
  });

  it("without the parent's GM the whole window is drawn", () => {
    const noGmParent = body(1, 'P', 'planet', { gm: src<number>(null, 'unknown') });
    const tr = buildTrack(eph, moon, noGmParent, eph.window, 0, 256)!;
    expect(tr.period).toBeNull();
    const pl = trackPolyline(tr, 0, eph.window, [0, 0, 0], false);
    expect(pl.points.length / 3).toBe(tr.n);
  });

  it('samples one and a half periods, at the requested resolution', () => {
    const tr = buildTrack(eph, moon, parent, eph.window, 5 * T, 100)!;
    expect((tr.t1 - tr.t0) / T).toBeCloseTo(1.5, 3);
    expect(tr.n).toBe(151);
    // the polyline shows one period around now
    const pl = trackPolyline(tr, 5 * T, eph.window, [0, 0, 0], false);
    expect(pl.points.length / 3).toBeGreaterThanOrEqual(100);
    expect(pl.points.length / 3).toBeLessThanOrEqual(103);
  });
});

describe('OrbitManager', () => {
  const world = (et: number, camPos: Vec3) => computeWorld(et, camPos, [parent, moon, body(10, 'S', 'star', { gm: src(1e20, 'measured') })], eph, { apparentPosition: makeApparent(1e9) }, 10);
  it('skips orbits smaller than a few pixels unless selected, and scales samples with apparent size', () => {
    const mgr = new OrbitManager(eph, [parent, moon, body(10, 'S', 'star')], 10, eph.window, () => 0);
    // Far away: the moon's orbit (R = 1e5 km) seen from 1e10 km is sub-pixel.
    const far = world(5 * T, [1e8, 1e10, 0]);
    let out = mgr.update({ et: 5 * T, world: far, fovY: 1, height: 900, selectedId: null });
    expect(out.find((o) => o.id === 2)).toBeUndefined();
    out = mgr.update({ et: 5 * T, world: far, fovY: 1, height: 900, selectedId: 2 });
    expect(out.find((o) => o.id === 2)).toBeDefined();
    const coarse = mgr.track(2)!.perOrbit;
    // Close: large on screen → rebuilt at a higher resolution.
    const near = world(5 * T, [1e8, 3 * 5 * T + 1.5e5, 0]);
    for (let i = 0; i < 5; i++) mgr.update({ et: 5 * T, world: near, fovY: 1, height: 900, selectedId: null });
    expect(mgr.track(2)!.perOrbit).toBeGreaterThan(coarse);
  });

  it('spends at most its time budget per frame (at least one track), selected first', () => {
    let clock = 0;
    const many = [parent, moon, ...[3, 4, 5, 6].map((id) => body(id, `M${id}`, 'moon', { parent: 1 }))];
    const e2 = new FakeEphemerisSet({ 10: () => [0, 0, 0], 1: parentAt, 2: moonAt, 3: moonAt, 4: moonAt, 5: moonAt, 6: moonAt }, eph.window);
    const slow = { ...e2, positionSSB: (id: number, t: number) => { clock += 0.01; return e2.positionSSB(id, t); }, stateSSB: e2.stateSSB.bind(e2), covers: e2.covers.bind(e2), add: e2.add.bind(e2), window: e2.window };
    const mgr = new OrbitManager(slow, [...many, body(10, 'S', 'star')], 10, eph.window, () => clock);
    const w = computeWorld(5 * T, [1e8, 3 * 5 * T + 5e5, 0], [...many, body(10, 'S', 'star')], e2, { apparentPosition: makeApparent(1e9) }, 10);
    mgr.update({ et: 5 * T, world: w, fovY: 1, height: 900, selectedId: 5 }, 3);
    expect(mgr.stats.built).toBe(1);
    expect(mgr.track(5)).toBeDefined(); // selected built first
    expect(mgr.stats.pending).toBeGreaterThan(0);
    for (let i = 0; i < 10; i++) mgr.update({ et: 5 * T, world: w, fovY: 1, height: 900, selectedId: 5 }, 3);
    expect(mgr.stats.pending).toBe(0);
    expect([2, 3, 4, 6].every((id) => mgr.track(id))).toBe(true);
  });
});
