import { describe, expect, it } from 'vitest';
import { buildTrack, orbitParentId, orbitSpan, osculatingPeriod, trackPolyline } from '../src/app/orbits';
import type { Vec3 } from '../src/app/ports';
import { body, FakeEphemerisSet, src } from './app-fakes';

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
    const tr = buildTrack(eph, moon, parent, w, 5 * T)!;
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

  it('without GM the whole window is drawn', () => {
    const noGm = body(2, 'M', 'moon', { parent: 1, gm: src<number>(null, 'unknown') });
    const tr = buildTrack(eph, noGm, parent, eph.window, 0)!;
    expect(tr.period).toBeNull();
    const pl = trackPolyline(tr, 0, eph.window, [0, 0, 0], false);
    expect(pl.points.length / 3).toBe(tr.n);
  });
});
