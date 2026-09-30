import { describe, expect, it } from 'vitest';
import type { EphemHeader } from '../src/data/schema';
import { Ephemeris, EphemerisSet } from '../src/core/ephemeris';
import { distance, norm, sub } from '../src/core/vec';
import { MaxTracker, fixture, loadEphemeris, loadEphemerisSet } from './core-data';

interface SpiceSpk {
  kernel: { file: string };
  segments: { target: number; center: number; cases: { et: number; pos: number[]; vel: number[] }[] }[];
}
interface HorizonsFile {
  bodies: { target: number; queryUrl: string; epochs: { jdTdb: number; et: number; pos: number[]; vel: number[] }[] }[];
}

const spk = fixture<SpiceSpk>('core_spice_spk.json');
// The planetary product is named after the kernel it was extracted from (e.g. de440s.bsp -> ephem/de440s).
const planetary = spk.kernel.file.replace(/\.bsp$/, '');
const de = loadEphemeris(`ephem/${planetary}`);
const set = loadEphemerisSet();

describe.skipIf(!de)(`Ephemeris (TS Chebyshev) vs SPICE spkgeo on the original ${spk.kernel.file}`, () => {
  it('reproduces every segment to < 1 mm and < 1 µm/s', () => {
    const max = new MaxTracker();
    let n = 0;
    for (const seg of spk.segments) {
      for (const c of seg.cases) {
        const st = de!.state(seg.target, c.et);
        expect(st, `${seg.target} at ${c.et} not covered: regenerate fixtures (pipeline.ephem_fixtures)`).not.toBeNull();
        expect(st!.center).toBe(seg.center);
        const dp = distance(st!.pos, c.pos as [number, number, number]);
        const dv = distance(st!.vel, c.vel as [number, number, number]);
        max.add('position km', dp, `${seg.target} wrt ${seg.center}`);
        max.add('velocity km/s', dv, `${seg.target} wrt ${seg.center}`);
        expect(dp).toBeLessThan(1e-6);
        expect(dv).toBeLessThan(1e-9);
        n++;
      }
    }
    expect(n).toBeGreaterThanOrEqual(14 * 3);
    max.report(`TS ${planetary} vs SPICE (${n} cases):`);
  });
});

// Horizons computes Uranus (799) and Neptune (899) wrt the SSB through its satellite ephemerides ura184/nep098,
// which embed the DE442 Uranus/Neptune barycenters, while its own barycenters 7 and 8 wrt the SSB are
// DE440-equivalent (they match ours to < 1 m, checked below). DE442 moved Uranus by ~1370 km and Neptune by
// ~380 km relative to DE440 over this window (docs/sources/naif-de440s.md), so for those two bodies this
// comparison measures DE440 vs DE442, not our code. Their center offsets (799 wrt 7, 899 wrt 8) are verified
// against independent Horizons hold-out epochs in pipeline/tests/test_ephem.py.
const DE440_VS_DE442_BOUND_KM: Record<number, number> = { 799: 1500, 899: 500 };
const TOL_KM = 5;

describe.skipIf(!set)('EphemerisSet vs JPL Horizons geometric SSB states (independent)', () => {
  const hz = fixture<HorizonsFile>('horizons_geometric.json');

  it('matches every body center and barycenter at every fixture epoch within a few km', () => {
    const max = new MaxTracker();
    let n = 0;
    for (const b of hz.bodies) {
      const tol = DE440_VS_DE442_BOUND_KM[b.target] ?? TOL_KM;
      for (const e of b.epochs) {
        const st = set!.stateSSB(b.target, e.et);
        expect(st, `${b.target} at JD ${e.jdTdb} not covered: regenerate fixtures`).not.toBeNull();
        const dp = distance(st!.pos, e.pos as [number, number, number]);
        const dv = distance(st!.vel, e.vel as [number, number, number]);
        max.add(`${b.target} position km`, dp, `JD ${e.jdTdb}`);
        max.add(`${b.target} velocity km/s`, dv, `JD ${e.jdTdb}`);
        expect(dp, `${b.target} JD ${e.jdTdb}`).toBeLessThan(tol);
        expect(dv, `${b.target} JD ${e.jdTdb}`).toBeLessThan(tol === TOL_KM ? 1e-5 : 1e-3);
        // positionSSB must agree with stateSSB exactly.
        expect(distance(set!.positionSSB(b.target, e.et)!, st!.pos)).toBeLessThan(1e-9);
        n++;
      }
    }
    expect(n).toBeGreaterThanOrEqual(18 * 3);
    max.report(`EphemerisSet vs Horizons geometric (${n} cases):`);
  });

  it('includes the planet-center offsets (Pluto is ~2000 km from its barycenter)', () => {
    const et = hz.bodies[0].epochs[0].et;
    const off = norm(sub(set!.positionSSB(999, et)!, set!.positionSSB(9, et)!));
    expect(off).toBeGreaterThan(1500);
    expect(off).toBeLessThan(2500);
  });

  it('reports provenance: measured for DE440s chains, derived when a fitted center is involved', () => {
    const et = hz.bodies[0].epochs[0].et;
    expect(set!.provenance(399, et)!.label).toBe('measured');
    const p = set!.provenance(599, et)!;
    expect(p.label).toBe('derived');
    expect(p.sources).toContain(`naif-${planetary}`);
    expect(p.sources).toContain('jpl-horizons-center-599');
  });

  it('never extrapolates: null outside coverage, window is the intersection', () => {
    const w = set!.window;
    expect(w.startEt).toBeLessThan(w.endEt);
    for (const id of [10, 399, 301, 599, 999]) {
      expect(set!.positionSSB(id, w.startEt)).not.toBeNull();
      expect(set!.positionSSB(id, w.endEt)).not.toBeNull();
    }
    const before = w.startEt - 40 * 86400;
    const after = w.endEt + 40 * 86400;
    for (const id of [10, 399, 301, 599, 999]) {
      expect(set!.positionSSB(id, before)).toBeNull();
      expect(set!.stateSSB(id, after)).toBeNull();
      expect(set!.covers(id, after)).toBe(false);
    }
    expect(set!.positionSSB(12345, w.startEt)).toBeNull();
    expect(set!.positionSSB(399, Number.NaN)).toBeNull();
  });
});

// Synthetic data built in the test (not a data product): checks chaining, priority and record selection.
function linearEphemeris(target: number, center: number, x0: number, vx: number, initEt: number, intLen: number, n: number): Ephemeris {
  // Type 2, degree 1: x(t) = x0 + vx (t − initEt); y = z = 0.
  const rsize = 2 + 3 * 2;
  const data = new Float64Array(n * rsize);
  for (let i = 0; i < n; i++) {
    const mid = initEt + (i + 0.5) * intLen;
    const rad = intLen / 2;
    data.set([mid, rad, x0 + vx * (mid - initEt), vx * rad, 0, 0, 0, 0], i * rsize);
  }
  const header: EphemHeader = {
    bin: 'test.bin',
    segments: [{ target, center, frame: 'J2000', type: 2, initEt, intLen, rsize, n, offset: 0, sources: ['test'] }],
  };
  return new Ephemeris(header, data);
}

describe('EphemerisSet mechanics (synthetic)', () => {
  it('chains to the SSB, prefers later files, returns velocities, and has an empty window when unloaded', () => {
    const s = new EphemerisSet();
    expect(s.window.startEt).toBe(Infinity);
    expect(s.positionSSB(5, 0)).toBeNull();
    s.add(linearEphemeris(5, 0, 1000, 2, 0, 100, 10));
    s.add(linearEphemeris(599, 5, 10, -1, 0, 50, 20));
    expect(s.positionSSB(599, 250)).toEqual([1000 + 500 + 10 - 250, 0, 0]);
    expect(s.stateSSB(599, 250)!.vel).toEqual([1, 0, 0]);
    expect(s.window).toEqual({ startEt: 0, endEt: 1000 });
    s.add(linearEphemeris(599, 5, 0, 0, 0, 1000, 1));
    expect(s.positionSSB(599, 250)).toEqual([1500, 0, 0]);
    expect(s.positionSSB(599, 1000.001)).toBeNull();
    expect(s.positionSSB(599, 1000)).toEqual([3000, 0, 0]);
  });
});
