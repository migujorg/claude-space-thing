import { describe, expect, it } from 'vitest';
import type { EphemHeader } from '../src/data/schema';
import { Ephemeris, EphemerisSet } from '../src/core/ephemeris';
import type { LoadedSegment } from '../src/core/ephemeris';
import type { Vec3 } from '../src/core/vec';
import { distance, norm, sub } from '../src/core/vec';
import { MaxTracker, fixture, loadEphemeris, loadEphemerisSet } from './core-data';

interface SpiceCase {
  et: number;
  pos: number[];
  vel: number[];
}
interface SpiceSpk {
  kernel: { file: string };
  segments: { target: number; center: number; cases: SpiceCase[] }[];
  satellites: { product: string; kernel: string; target: number; center: number; type: number; cases: SpiceCase[] }[];
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

// ephem_fixtures.py writes SPICE doubles with json.dumps, without rounding: these JSON numbers round-trip
// to the same float64 bits in JS. Horizons' printed decimal vectors below are only tolerance references.
// Endpoint scan: all 14 planetary and 464 satellite type 2/3 segments had at most
// 8 position ulps and 3 velocity ulps (satellite excerpts: 0); 10 adds a small margin.
const endpointUlps = 10;

function expectSpiceBits(actual: { pos: Vec3; vel: Vec3 }, reference: SpiceCase, body: string, trimmedEnd = false): void {
  const values = [...actual.pos, ...actual.vel];
  const refs = [...reference.pos, ...reference.vel];
  const ours = new BigUint64Array(new Float64Array(values).buffer);
  const spice = new BigUint64Array(new Float64Array(refs).buffer);
  const components = ['pos.x', 'pos.y', 'pos.z', 'vel.x', 'vel.y', 'vel.z'];
  for (let j = 0; j < components.length; j++) {
    const detail = `${body}, et ${reference.et}, ${components[j]}: ` +
      `ours 0x${ours[j].toString(16).padStart(16, '0')}, SPICE 0x${spice[j].toString(16).padStart(16, '0')}`;
    if (trimmedEnd) {
      // Full-kernel SPICE may select the following polynomial, which the product
      // omits. Python tests verify bits against the retained source record itself.
      // Extract the exponent so values just below powers of two use their own ulp.
      const magnitude = (ours[j] & 0x7fffffffffffffffn) > (spice[j] & 0x7fffffffffffffffn) ? ours[j] : spice[j];
      const exponent = Number((magnitude >> 52n) & 0x7ffn);
      const ulp = exponent === 0 ? Number.MIN_VALUE : 2 ** (exponent - 1023 - 52);
      expect.soft(Math.abs(values[j] - refs[j]) / ulp, detail).toBeLessThanOrEqual(endpointUlps);
    } else {
      expect.soft(ours[j], detail).toBe(spice[j]);
    }
  }
}

function atFinalRecordBoundary(s: LoadedSegment, et: number): boolean {
  return et === s.endEt && s.endEt === s.initEt + s.n * s.intLen;
}

describe.skipIf(!de)(`Ephemeris (TS Chebyshev) vs SPICE spkgeo on the original ${spk.kernel.file}`, () => {
  it('reproduces sampled segments exactly for types 2/3, with bounded neighbouring-polynomial endpoints', () => {
    const max = new MaxTracker();
    for (const seg of spk.segments) {
      for (const c of seg.cases) {
        if (!max.inCoverage(de!.covers(seg.target, c.et))) continue;
        const st = de!.state(seg.target, c.et);
        expect.soft(st!.center).toBe(seg.center);
        const dp = distance(st!.pos, c.pos as [number, number, number]);
        const dv = distance(st!.vel, c.vel as [number, number, number]);
        max.add('position km', dp, `${seg.target} wrt ${seg.center}`);
        max.add('velocity km/s', dv, `${seg.target} wrt ${seg.center}`);
        expect.soft(dp).toBeLessThan(1e-6);
        expect.soft(dv).toBeLessThan(1e-9);
        const loaded = de!.find(seg.target, c.et)!;
        const type = loaded.type;
        if (type === 2 || type === 3) {
          expectSpiceBits(st!, c, `${seg.target} wrt ${seg.center} (${spk.kernel.file}, type ${type})`,
                          atFinalRecordBoundary(loaded, c.et));
        }
      }
    }
    max.report(`TS ${planetary} vs SPICE:`);
    max.requireSome('planetary SPICE fixture');
  });

  // Test-only references read from NAIF de442s.bsp (Earth wrt EMB, J2000, km and km/s),
  // sha256 54d97562a5b094d298b1b8eafa5a2e17e3e010ce85e1a366d07f003ad159323c.
  // https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/de442s.bsp
  // These cover the current product's start and final record boundary; a different
  // build window skips these fixed-epoch regressions, leaving the fixture tests above.
  const start: SpiceCase = {
    et: 796564800,
    pos: [-4163.183273582794, -1102.7628161510866, -626.2609799172914],
    vel: [0.003949245124075588, -0.011198782834249004, -0.006111955247176013],
  };
  it.skipIf(de?.find(399, start.et)?.startEt !== start.et)('matches SPICE bits at the Earth product start', () => {
    expectSpiceBits(de!.state(399, start.et)!, start, '399 wrt 3, de442s start');
  });

  const end: SpiceCase = {
    et: 891950400,
    pos: [4203.589172442336, -1258.5044564376726, -249.12683993698306],
    vel: [0.0035798784450729736, 0.011317943080263378, 0.005789629568672616],
  };
  const endingRecord: SpiceCase = {
    et: end.et,
    pos: [4203.589172442336, -1258.5044564376726, -249.1268399369833],
    vel: [0.003579878445072975, 0.01131794308026338, 0.005789629568672615],
  };
  // endingRecord comes from the Python evaluator on the full kernel's record ending
  // here; end comes from spkgeo, which selects the next record. They differ by 8 ulps
  // in Z (2.2737367544323206e-13 km), with identical bits for the retained record.
  it.skipIf(!de || !de.find(399, end.et) || !atFinalRecordBoundary(de.find(399, end.et)!, end.et))(
    'matches retained source-record bits and bounds the SPICE neighbouring-polynomial endpoint', () => {
      const actual = de!.state(399, end.et)!;
      expectSpiceBits(actual, endingRecord, '399 wrt 3, de442s ending source record');
      expectSpiceBits(actual, end, '399 wrt 3, de442s full-kernel endpoint', true);
    },
  );
});

// Satellite products: SPICE spkgeo on the kernel excerpts (each loaded alone) vs the TS evaluator on our products.
// Types 2/3 are bit-identical when selecting the same record (tested at starts and sampled interior epochs),
// including the retained source record at a trimmed final boundary where full-kernel SPICE may select the
// neighbouring polynomial and differ by <= 10 ulps of the larger component magnitude.
// Type 17 (a conic) agrees to < 1 mm (a mean longitude of ~1e5 rad has an ulp of ~1e-11 rad, i.e. ~1 mm at a = 117,061 km).
const satProducts = [...new Set(spk.satellites.map((s) => s.product))];
const sats = new Map(satProducts.map((p) => [p, loadEphemeris(p)] as const));
describe.skipIf([...sats.values()].some((e) => !e))('Satellite products vs SPICE spkgeo on the kernel excerpts', () => {
  it('reproduces sampled segments of every kernel to < 1 mm and < 1e-9 km/s, types 2/3 bit for bit', () => {
    const max = new MaxTracker();
    const types = new Set<number>();
    for (const seg of spk.satellites) {
      const e = sats.get(seg.product)!;
      for (const c of seg.cases) {
        if (!max.inCoverage(e.covers(seg.target, c.et))) continue;
        const st = e.state(seg.target, c.et);
        expect.soft(st!.center).toBe(seg.center);
        const dp = distance(st!.pos, c.pos as Vec3);
        const dv = distance(st!.vel, c.vel as Vec3);
        max.add(`type ${seg.type} position km`, dp, `${seg.target} (${seg.kernel})`);
        max.add(`type ${seg.type} velocity km/s`, dv, `${seg.target} (${seg.kernel})`);
        expect.soft(dp, `${seg.target}`).toBeLessThan(1e-6);
        expect.soft(dv, `${seg.target}`).toBeLessThan(1e-9);
        if (seg.type === 2 || seg.type === 3) {
          expectSpiceBits(st!, c, `${seg.target} wrt ${seg.center} (${seg.kernel}, type ${seg.type})`);
        }
        types.add(seg.type);
      }
    }
    max.report(`TS satellite products vs SPICE (${spk.satellites.length} segments, ${new Set(spk.satellites.map((s) => s.kernel)).size} kernels, SPK types ${[...types].sort().join(', ')}):`);
    max.requireSome('satellite SPICE fixture');
  });
});

interface HorizonsMoons {
  bodies: { target: number; center: string; targetLine: string; centerLine: string; epochs: { jdTdb: number; et: number; pos: number[]; vel: number[] }[] }[];
}

describe.skipIf(!set)('Moons vs JPL Horizons, relative to their planet centre (independent)', () => {
  it('matches Io, Europa, Titan, Enceladus, Phobos, Triton, Charon, Miranda, irregulars, Janus (type 3) and a type-17 moonlet', () => {
    const hz = fixture<HorizonsMoons>('horizons_moons.json');
    const max = new MaxTracker();
    for (const b of hz.bodies) {
      const planet = Number(b.center.replace('500@', ''));
      // Our planet centre comes from one kernel (e.g. 699 from sat441). Horizons pairs a moon with the planet centre
      // of the moon's own kernel: for sat415 moons (Janus) that is sat415's 699, which differs from sat441's by ~3 m,
      // inside sat415's stated 5.8 m interpolation error. Everywhere else both come from the same kernel.
      const mid = (set!.window.startEt + set!.window.endEt) / 2;
      const ourCenterKernel = set!.provenance(planet, mid)!.sources.find((s) => s !== `naif-${planetary}`)!.replace('naif-', '');
      // Kernel families: mar099s ~ mar099, nep098_part-1 ~ nep098_merged, sat441 ~ sat441l.
      const family = (k: string) => k.replace(/_part-\d+$/, '').replace(/_merged.*$/, '').replace(/^(\w{3}\d{3})[sl]$/, '$1');
      const hzCenterKernel = /source: ([^}]+)\}/.exec(b.centerLine)![1].trim();
      const sameCenter = family(ourCenterKernel) === family(hzCenterKernel);
      const tol = sameCenter ? 1e-3 : 1e-2;
      for (const e of b.epochs) {
        if (!max.inCoverage(set!.covers(b.target, e.et) && set!.covers(planet, e.et))) continue;
        const m = set!.stateSSB(b.target, e.et);
        const p = set!.stateSSB(planet, e.et);
        const dp = distance(sub(m!.pos, p!.pos), e.pos as Vec3);
        const dv = distance(sub(m!.vel, p!.vel), e.vel as Vec3);
        const tag = `${b.target} wrt ${planet}${sameCenter ? '' : ` (Horizons centre from ${hzCenterKernel}, ours from ${ourCenterKernel})`}`;
        max.add(`${tag} position km`, dp, `JD ${e.jdTdb}`);
        max.add(`${tag} velocity km/s`, dv, `JD ${e.jdTdb}`);
        // Same kernels as Horizons; Horizons prints 16 significant digits.
        expect(dp, `${b.target} JD ${e.jdTdb}`).toBeLessThan(tol);
        expect(dv, `${b.target} JD ${e.jdTdb}`).toBeLessThan(sameCenter ? 1e-8 : 1e-6);
      }
    }
    max.report(`Moons vs Horizons (${hz.bodies.length} moons):`);
    max.requireSome('Horizons moons fixture');
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
    expect(hz.ourPlanetary, 'fixtures were made for another planetary kernel: regenerate them').toBe(planetary);
    for (const b of hz.bodies) {
      for (const e of b.epochs) {
        if (!max.inCoverage(set!.covers(b.target, e.et))) continue;
        const st = set!.stateSSB(b.target, e.et);
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
      }
    }
    max.report('EphemerisSet vs Horizons geometric:');
    max.requireSome('Horizons geometric fixture');
  });

  it('includes the planet-center offsets (Pluto is ~2000 km from its barycenter)', () => {
    const et = (set!.window.startEt + set!.window.endEt) / 2;
    const off = norm(sub(set!.positionSSB(999, et)!, set!.positionSSB(9, et)!));
    expect(off).toBeGreaterThan(1500);
    expect(off).toBeLessThan(2500);
  });

  it('reports provenance: the segments and sources of the whole chain (planet centres and moons from the satellite kernels)', () => {
    const et = (set!.window.startEt + set!.window.endEt) / 2;
    expect(set!.provenance(399, et)!.label).toBe('measured');
    const p = set!.provenance(599, et)!;
    expect(p.label).toBe('measured');
    expect(p.sources).toContain(`naif-${planetary}`);
    expect(p.sources).toContain('naif-jup365');
    expect(set!.provenance(65304, et)!.segments.map((s) => s.target)).toEqual([65304, 699, 6]);
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

// ephem/centers duplicates the planet-centre segments of the sat-* files so planets are placeable before the moon
// systems load. EphemerisSet serves a (target, time) from the last-added file that covers it, so the duplicates are
// harmless as long as they are identical: check that, and that load order does not change any position.
const centers = loadEphemeris('ephem/centers');
describe.skipIf(!centers || [...sats.values()].some((e) => !e) || !de)('ephem/centers duplicates of the sat-* planet centres', () => {
  it('are bit-identical records, so either copy (whichever was added last) gives the same positions', () => {
    const w = centers!.window;
    const bySystem = new Map(satProducts.map((p) => [p, sats.get(p)!] as const));
    for (const s of centers!.header.segments) {
      const sys = [...bySystem.values()].find((e) => e.header.segments.some((x) => x.target === s.target))!;
      expect(sys, `no sat-* file holds ${s.target}`).toBeDefined();
      const d = sys.header.segments.find((x) => x.target === s.target)!;
      expect({ ...d, offset: 0 }).toEqual({ ...s, offset: 0 });
      const a = centers!.state(s.target, 0.5 * (w.startEt + w.endEt));
      const b = sys.state(s.target, 0.5 * (w.startEt + w.endEt));
      expect(a).toEqual(b);
      // Order independence: centers first vs last.
      const first = new EphemerisSet(), last = new EphemerisSet();
      for (const e of [de!, centers!, sys]) first.add(e);
      for (const e of [de!, sys, centers!]) last.add(e);
      for (let i = 0; i <= 20; i++) {
        const et = w.startEt + ((w.endEt - w.startEt) * i) / 20;
        expect(first.stateSSB(s.target, et)).toEqual(last.stateSSB(s.target, et));
      }
    }
    expect(centers!.header.segments.map((s) => s.target).sort()).toEqual([499, 599, 699, 799, 899, 999]);
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
  it('exposes the owning headers of exactly the selected chain, with fallback outside a later file', () => {
    const base = linearEphemeris(5, 0, 1000, 0, 0, 100, 10);
    const early = linearEphemeris(599, 5, 10, 0, 0, 100, 10);
    const late = linearEphemeris(599, 5, 20, 0, 200, 100, 1);
    const s = new EphemerisSet();
    for (const e of [base, early, late]) s.add(e);
    for (const [et, e, x] of [[199, early, 1010], [200, late, 1020], [300, late, 1020], [301, early, 1010]] as const) {
      expect(s.positionSSB(599, et)).toEqual([x, 0, 0]);
      const p = s.provenance(599, et)!;
      expect(p.links.map((l) => l.header)).toEqual([e.header, base.header]);
      expect(p.links.map((l) => l.seg)).toEqual(p.segments);
      expect(p.links[0].seg).toBe(e.header.segments[0]);
    }
    expect(s.provenance(599, 1001)).toBeNull();
    expect(s.provenance(599, NaN)).toBeNull();
    expect(s.provenance(0, 500)!.links).toEqual([]);
  });

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
