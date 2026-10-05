import { describe, expect, it } from 'vitest';
import { attributeRows, derivedLabel, ephemerisChain, sunRows, sunWhy } from '../src/ui/inspectModel';
import { groupReport } from '../src/ui/dataReport';
import type { LoadedEphemeris } from '../src/data/load';
import type { EphemSegment } from '../src/data/schema';
import { body, fakeLight } from './app-fakes';
import { Ephemeris, EphemerisSet } from '../src/core/ephemeris';
import { AppModel } from '../src/app/model';
import { FakeEphemerisSet, fakeCore } from './app-fakes';
import { fixture, loadEphemeris } from './core-data';

const seg = (target: number, center: number, sources: string[]): EphemSegment => ({ target, center, frame: 'J2000', type: 2, initEt: 0, intLen: 1, rsize: 5, n: 1, offset: 0, sources, label: 'measured' });
const ephs: LoadedEphemeris[] = [
  { name: 'a', path: 'ephem/a.json', header: { bin: 'a.bin', segments: [seg(399, 3, ['s1']), seg(3, 0, ['s1'])] }, data: new Float64Array() },
  { name: 'b', path: 'ephem/b.json', header: { bin: 'b.bin', segments: [seg(301, 3, ['s2'])] }, data: new Float64Array() },
];

function evaluator(files: LoadedEphemeris[]): EphemerisSet {
  const set = new EphemerisSet();
  for (const e of files) {
    // Constant-position SPK type-2 records: test fixtures only.
    const data = new Float64Array(e.header.segments.length * 5);
    e.header.segments.forEach((s, i) => { s.offset = i * 5; data.set([0.5, 0.5, 1, 0, 0], s.offset); });
    set.add(new Ephemeris(e.header, data));
  }
  return set;
}

const planetary = fixture<{ kernel: { file: string } }>('core_spice_spk.json').kernel.file.replace(/\.bsp$/, '');
const realProducts = [planetary, 'centers', 'sat-jup'].map((name) => ({ name, path: `ephem/${name}.json`, eph: loadEphemeris(`ephem/${name}`) }));

describe.skipIf(realProducts.some((p) => !p.eph))('inspector chain with real products', () => {
  it('reports sat-jup after it overrides the identical centers copy for Jupiter', () => {
    const set = new EphemerisSet();
    const files = realProducts.map((p) => ({ path: p.path, header: p.eph!.header }));
    set.add(realProducts[0].eph!);
    set.add(realProducts[1].eph!);
    const et = (set.window.startEt + set.window.endEt) / 2;
    const before = set.positionSSB(599, et);
    set.add(realProducts[2].eph!);
    expect(before).not.toBeNull();
    expect(set.positionSSB(599, et)).toEqual(before);
    // Concrete old behavior: first header wins even after sat-jup loads.
    expect(ephemerisChain(files, 599).links[0].file).toBe('ephem/centers.json');
    const p = set.provenance(599, et)!;
    expect(p.links[0].header).toBe(realProducts[2].eph!.header);
    const row = attributeRows(body(599, 'Jupiter', 'planet'), 'best', files, { ephemeris: p })[0];
    expect(row.method).toContain(`sat-jup.json, ${planetary}.json`);
    expect(row.method).not.toContain('centers.json');
    expect(row.sources).toEqual(p.sources);
  });
});

describe('inspector model', () => {
  it('uses the evaluator selection across files, including later files and segments', () => {
    const later: LoadedEphemeris = { ...ephs[1], header: { bin: 'b.bin', segments: [seg(301, 0, ['unused']), { ...seg(301, 399, ['selected']), label: 'estimated' }] } };
    const files = [ephs[0], ephs[1], later];
    const set = evaluator(files);
    const selected = set.provenance(301, 0.5)!;
    expect(set.positionSSB(301, 0.5)).toEqual([3, 0, 0]);
    const row = attributeRows(body(301, 'Moon', 'moon'), 'best', files, { ephemeris: selected })[0];
    expect(row.value).toContain('301 → 399 → 3 → 0 (SSB)');
    expect(selected.links.map((l) => [l.header, l.seg])).toEqual([
      [later.header, later.header.segments[1]],
      [files[0].header, files[0].header.segments[0]],
      [files[0].header, files[0].header.segments[1]],
    ]);
    expect(row.label).toBe(selected.label);
    expect(row.sources).toEqual(selected.sources);
    expect(row.method).toContain('b.json, a.json');
    expect(row.method).toContain('301 → 399: b.json segment 2 (SPK type 2, estimated; sources: selected)');
    expect(row.method).toContain('3 → 0: a.json segment 2 (SPK type 2, measured; sources: s1)');
  });

  it('shows no coverage with no chain or sources outside any required link', () => {
    const set = evaluator(ephs);
    for (const et of [-0.01, 1.01, NaN]) {
      expect(set.positionSSB(301, et)).toBeNull();
      const row = attributeRows(body(301, 'Moon', 'moon'), 'best', ephs, { ephemeris: set.provenance(301, et) })[0];
      expect(row.value).toContain('no coverage');
      expect(row.value).not.toContain('→');
      expect(row.label).toBe('unknown');
      expect(row.sources).toEqual([]);
    }
    // The target itself covers this time, but a required parent link does not.
    const files = [
      { ...ephs[0], header: { ...ephs[0].header, segments: ephs[0].header.segments.map((s) => ({ ...s, endEt: 0.5 })) } },
      ephs[1],
    ];
    const incomplete = evaluator(files);
    expect(incomplete.positionSSB(301, 0.75)).toBeNull();
    const row = attributeRows(body(301, 'Moon', 'moon'), 'best', files, { ephemeris: incomplete.provenance(301, 0.75) })[0];
    expect(row.value).toContain('no coverage');
    expect(row.sources).toEqual([]);
  });

  it('asks for the chain at the frame emission epoch, and returns none when the frame has no position', () => {
    const set = evaluator(ephs);
    const later = { ...ephs[1].header, bin: 'later.bin', segments: [{ ...seg(301, 0, ['later']), startEt: 0.5 }] };
    set.add(new Ephemeris(later, new Float64Array([0.5, 0.5, 9, 0, 0])));
    const m = new AppModel(fakeCore(new FakeEphemerisSet()));
    m.eph = set;
    m.clock.set(0.75);
    const b = body(301, 'Moon', 'moon');
    m.world = { et: 0.75, cameraPos: [0, 0, 0], sunId: null, bodies: new Map([[301, { id: 301, body: b, app: { rel: [2, 0, 0], lightTime: 0.5, emitEt: 0.25 }, toSun: null }]]) };
    expect(m.ephemerisSource(301)).toEqual(set.provenance(301, 0.25));
    expect(m.ephemerisSource(301)!.sources).not.toContain('later');
    m.world.bodies.get(301)!.app = null;
    expect(m.ephemerisSource(301)).toBeNull();
  });
  it('follows ephemeris segments to the SSB and collects their sources', () => {
    const c = ephemerisChain(ephs, 301);
    expect(c.links.map((l) => [l.seg.target, l.seg.center])).toEqual([[301, 3], [3, 0]]);
    expect(c.complete).toBe(true);
    expect(c.sources).toEqual(['s2', 's1']);
    expect(ephemerisChain(ephs, 42).links).toHaveLength(0);
  });

  it('lists every attribute with its label, marking values withheld at the level', () => {
    const b = body(301, 'Moon', 'moon', { rLabel: 'estimated', albedo: 'measured', phase: 'estimated' });
    const ctx = { ephemeris: evaluator(ephs).provenance(301, 0.5) };
    const rows = attributeRows(b, 'strict', ephs, ctx);
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(Object.keys(by)).toEqual(['position', 'radii', 'gm', 'rotation', 'albedoXYZS', 'albedoV', 'phase']);
    expect(by.position.label).toBe('measured');
    expect(by.position.value).toMatch(/301 → 3 → 0/);
    expect(by.radii.withheld).toBe(true);
    expect(by.phase.withheld).toBe(true);
    expect(by.albedoXYZS.withheld).toBe(false);
    expect(attributeRows(b, 'best', ephs, ctx).find((r) => r.key === 'radii')!.withheld).toBe(false);
    const noPhot = attributeRows(body(1, 'X', 'planet'), 'best', []);
    expect(noPhot.find((r) => r.key === 'albedoXYZS')!.label).toBe('unknown');
    expect(noPhot.find((r) => r.key === 'position')!.value).toMatch(/no coverage/);
  });

  it('describes the Sun from light.json', () => {
    const rows = sunRows(fakeLight('estimated'), 'strict');
    expect(rows.map((r) => r.key)).toEqual(['irradiance', 'sunRadius', 'limbDarkening']);
    expect(rows[0].withheld).toBe(true);
    expect(sunRows(null, 'best')[0].value).toMatch(/missing/);
    expect(sunWhy(fakeLight(), 'best', true)).toMatch(/light.json/);
    expect(sunWhy(null, 'best', false, 'light.json is missing.')).toMatch(/not drawn/);
  });

  it('derived quantities carry the worst of their inputs', () => {
    expect(derivedLabel('measured')).toBe('derived');
    expect(derivedLabel('estimated')).toBe('estimated');
  });
});

describe('data panel rows', () => {
  it('groups numbered products with the same status into one row', () => {
    const shard = (i: number) => ({ path: `stars/deep-o3-${String(i).padStart(3, '0')}.bin`, status: 'unused' as const, bytes: 10, message: 'Listed in the manifest; not read by this app version.' });
    const rows = groupReport([{ path: 'manifest.json', status: 'ok', bytes: 5, hash: 'unchecked' }, ...Array.from({ length: 768 }, (_, i) => shard(i)), { path: 'stars/bright.bin', status: 'ok', bytes: 7 }]);
    expect(rows.map((r) => [r.path, r.count, r.bytes])).toEqual([['manifest.json', 1, 5], ['stars/deep-o3-000.bin', 768, 7680], ['stars/bright.bin', 1, 7]]);
    expect(rows[1].lastPath).toBe('stars/deep-o3-767.bin');
    // A shard with a different status stays on its own row; small groups are not collapsed.
    expect(groupReport([shard(0), shard(1), shard(2), { ...shard(3), status: 'error' }, shard(4)]).map((r) => r.count)).toEqual([4, 1]);
    expect(groupReport([shard(0), shard(1), shard(2)]).map((r) => r.count)).toEqual([1, 1, 1]);
  });
});
