import { describe, expect, it } from 'vitest';
import type { EphemHeader } from '../src/data/schema';
import { Ephemeris, EphemerisSet } from '../src/core/ephemeris';
import type { Vec3 } from '../src/core/vec';
import { distance, norm, sub } from '../src/core/vec';
import { MaxTracker, fixture, loadEphemeris, loadEphemerisSet } from './core-data';

interface SpiceSpk {
  kernel: { file: string };
  segments: { target: number; center: number; cases: { et: number; pos: number[]; vel: number[] }[] }[];
}
interface HorizonsFile {
  ourPlanetary: string;
  bodies: {
    target: number;
    queryUrl: string;
    horizonsPlanetary: string;
    epochs: { jdTdb: number; et: number; pos: number[]; vel: number[]; toOurs: number[] }[];
  }[];
}

const spk = fixture<SpiceSpk>('core_spice_spk.json');
// The planetary product is named after the kernel it was extracted from (e.g. de442s.bsp -> ephem/de442s).
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

// Horizons builds each answer on the planetary ephemeris of the satellite ephemeris it uses for that system: DE440
// (plain barycenter queries, Sun, inner planets, Mars, Jupiter, Saturn, Pluto) or DE442 (Uranus 799, Neptune 899).
// Each fixture epoch carries `toOurs`: SPICE's (our kernel − Horizons' kernel) for the planetary part of the chain
// (0 where Horizons already used our kernel). Horizons + toOurs is then the same answer on our planetary ephemeris,
// and every body must match it to within TOL_KM. The raw (un-rebased) error is reported alongside.
const TOL_KM = 5;

describe.skipIf(!set)('EphemerisSet vs JPL Horizons geometric SSB states (independent)', () => {
  const hz = fixture<HorizonsFile>('horizons_geometric.json');

  it('matches every body center and barycenter at every fixture epoch within a few km', () => {
    const max = new MaxTracker();
    let n = 0;
    expect(hz.ourPlanetary, 'fixtures were made for another planetary kernel: regenerate them').toBe(planetary);
    for (const b of hz.bodies) {
      for (const e of b.epochs) {
        const st = set!.stateSSB(b.target, e.et);
        expect(st, `${b.target} at JD ${e.jdTdb} not covered: regenerate fixtures`).not.toBeNull();
        const expected: Vec3 = [e.pos[0] + e.toOurs[0], e.pos[1] + e.toOurs[1], e.pos[2] + e.toOurs[2]];
        const dp = distance(st!.pos, expected);
        const raw = distance(st!.pos, e.pos as Vec3);
        const dv = distance(st!.vel, e.vel as Vec3);
        const tag = `${b.target} (Horizons on ${b.horizonsPlanetary})`;
        max.add(`${tag} position km`, dp, `JD ${e.jdTdb}`);
        max.add(`${tag} raw (not re-based) position km`, raw, `JD ${e.jdTdb}`);
        max.add(`${tag} velocity km/s`, dv, `JD ${e.jdTdb}`);
        expect(dp, `${b.target} JD ${e.jdTdb}`).toBeLessThan(TOL_KM);
        expect(dv, `${b.target} JD ${e.jdTdb}`).toBeLessThan(1e-5);
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

  it('reports provenance: measured for planetary-ephemeris chains, derived when a fitted center is involved', () => {
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

  it('honours a declared coverage narrower than the records (as SPICE does)', () => {
    const e = linearEphemeris(5, 0, 1000, 2, 0, 100, 10);
    const header: EphemHeader = { ...e.header, segments: [{ ...e.header.segments[0], startEt: 150, endEt: 800 }] };
    const n = new Ephemeris(header, new Float64Array(e.header.segments[0].n * e.header.segments[0].rsize).map((_, i) => i));
    expect(n.covers(5, 149)).toBe(false);
    expect(n.covers(5, 150)).toBe(true);
    expect(n.covers(5, 800)).toBe(true);
    expect(n.covers(5, 801)).toBe(false);
    expect(n.window).toEqual({ startEt: 150, endEt: 800 });
  });
});
