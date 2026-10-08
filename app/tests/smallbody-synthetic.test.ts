// The synthetic layer (pipeline stage synthetic, the COMPLETE level): two-body positions, synthetic rows in the app
// shell (identity, labels, reality gating, counts, inspector facts, the default level) with made-up tables, and the
// built products where present (completeness guard, elements <-> states, population totals).

import { describe, expect, it } from 'vitest';
import { AppModel } from '../src/app/model';
import { sbId } from '../src/app/smallbodies';
import { filterBody } from '../src/app/reality';
import { centerStateFrom, diameterFromH, keplerE, readSynthetic, syntheticMu, syntheticPeriod, syntheticRelativeState, syntheticState } from '../src/core/smallbodySynthetic';
import type { LoadedData } from '../src/data/load';
import type { Manifest, SmallBodyCoreHeader, SyntheticCellsHeader, SyntheticObjectsHeader, SyntheticPopulation } from '../src/data/schema';
import type { SmallBodyProducts, SmallBodyTables } from '../src/data/smallbodies';
import { BinaryTable } from '../src/data/binaryTable';
import { syntheticFacts, syntheticPopulationFacts, syntheticWhy } from '../src/ui/syntheticInspect';
import { body, FAKE_J2000_MS, FakeEphemerisSet, fakeCore, fakeLight } from './app-fakes';
import { DAY, EPOCH, FAKE_GM, FakeField, fakeTables, makeTable, vCirc } from './sb-fixtures';
import { DATA_DIR } from './core-data';

const AU = 1.495978707e8;
const DEG = Math.PI / 180;

const POP = {
  name: 'mainbelt', code: 2, modelId: 'fake-model', sources: ['src-model'], prefix: 'synthetic-v1|1|fake-model',
  grid: { aEdgesAu: [2, 2.02], eWidth: 0.05, iWidthDeg: 2.5, nE: 14, nI: 36, hWidthMag: 0.5, hAlignment: '' },
  hFloor: 20, limit: { method: 'hendler-malhotra-2020', fit: { C: 21.3 } }, model: { slope: { alphaFaint: 0.23, source: 'maeda-2021-hsc' } },
  firstCell: 0, cells: 1, firstObject: 0, objects: 3, knownInGrid: 10,
  totals: { model: 5, knownInGroups: 2, rawDeficit: 3, deficit: 3, shown: 3, groups: 1 },
};

/** Three made-up synthetic objects in one made-up cell (fixture numbers, not real objects). */
function syntheticTables() {
  const objects = makeTable<SyntheticObjectsHeader>(
    [['a', 'f32'], ['e', 'f32'], ['i', 'f32'], ['node', 'f32'], ['peri', 'f32'], ['M', 'f32'], ['H', 'f32'], ['pV', 'f32'], ['rotPeriod', 'f32'], ['cell', 'u32'], ['k', 'u32'], ['pop', 'u8'], ['colorClass', 'u8']],
    [
      { a: 2.0, e: 0, i: 0, node: 0, peri: 0, M: 0, H: 19.2, pV: 0.1, rotPeriod: 5, cell: 0, k: 0, pop: 2, colorClass: 0 },
      { a: 2.01, e: 0.3, i: 10, node: 40, peri: 70, M: 200, H: 19.4, pV: 0.25, rotPeriod: 3, cell: 0, k: 2, pop: 2, colorClass: 0 },
      { a: 2.015, e: 0.97, i: 150, node: 300, peri: 10, M: 1, H: 19.9, pV: 0.05, rotPeriod: 9, cell: 0, k: 3, pop: 2, colorClass: 255 },
    ],
    {
      algorithm: 'synthetic-v1', seed: 1, epochEt: EPOCH, epochTdb: 'fake epoch', gmSun: FAKE_GM, obliquityArcsec: 0, auKm: AU,
      catalogue: { product: 'smallbodies/core.bin', snapshot: 'fake', coreSha256: '', physicalSha256: '', sources: [] },
      populations: [POP], labels: '', seedRule: 'fake seed rule', yieldRule: 'fake yield rule', frame: '', cells: 'synthetic/cells.json',
      counts: { synthetic: 3, cells: 1 }, floors: { mainbelt: 20 }, slopeParameterG: { value: 0.15, source: 'bowell-1989', method: 'fake G' },
      columns: { pV: { label: 'synthetic', method: 'fake pV method' }, H: { unit: 'mag', method: 'fake H method' } },
    } as Partial<SyntheticObjectsHeader>,
  );
  const cells = makeTable<SyntheticCellsHeader>(
    [['pop', 'u8'], ['ia', 'u16'], ['ie', 'u16'], ['ii', 'u16'], ['ih', 'i32'], ['aLo', 'f32'], ['aHi', 'f32'], ['eLo', 'f32'], ['eHi', 'f32'], ['iLo', 'f32'], ['iHi', 'f32'],
      ['hLo', 'f32'], ['hHi', 'f32'], ['hLim', 'f32'], ['nModel', 'f32'], ['nObs', 'u32'], ['rawDeficit', 'f32'], ['deficit', 'f32'], ['u0', 'f32'], ['nShown', 'u32'], ['first', 'u32']],
    [{ pop: 2, ia: 0, ie: 0, ii: 0, ih: 38, aLo: 2, aHi: 2.02, eLo: 0, eHi: 0.05, iLo: 0, iHi: 2.5, hLo: 19, hHi: 19.5, hLim: 18.6, nModel: 5.2, nObs: 2, rawDeficit: 3.2, deficit: 3.1, u0: 0.25, nShown: 3, first: 0 }],
  );
  return { objects, cells };
}

/** GM of a made-up planet system (fixture; not Jupiter's value). */
const FAKE_GM_PLANET = 1.0e8;
const MOON_POP = {
  ...POP, name: 'irregular-jupiter', code: 7, modelId: 'fake-moons', prefix: 'synthetic-v1|1|fake-moons',
  center: { naifId: 5, name: 'Jupiter system barycentre', gm: FAKE_GM_PLANET },
  limit: { method: 'model-comparison', rule: 'fake rule', hLimV: 17.6, calibration: { offset: -6.37, offsetSigma: 0.06, n: 7 } },
  model: { planet: 'Jupiter', moonClass: 'retrograde', motion: 'fake motion text', model: { source: 'ashton-2020-jupiter', nInRange: 440, hLoV: 17.63, hHiV: 19.33, alpha: 0.29 } },
};

/** One made-up planet-centred object (a synthetic irregular moon) in one made-up cell. */
function moonTables() {
  const objects = makeTable<SyntheticObjectsHeader>(
    [['a', 'f32'], ['e', 'f32'], ['i', 'f32'], ['node', 'f32'], ['peri', 'f32'], ['M', 'f32'], ['H', 'f32'], ['pV', 'f32'], ['rotPeriod', 'f32'], ['cell', 'u32'], ['k', 'u32'], ['pop', 'u8'], ['colorClass', 'u8']],
    [{ a: 0.125, e: 0, i: 150, node: 0, peri: 0, M: 0, H: 18.2, pV: 0.04, rotPeriod: NaN, cell: 0, k: 0, pop: 7, colorClass: 255 }],
    {
      algorithm: 'synthetic-v1', seed: 1, epochEt: EPOCH, epochTdb: 'fake epoch', gmSun: FAKE_GM, obliquityArcsec: 0, auKm: AU,
      catalogue: { product: 'smallbodies/core.bin', snapshot: 'fake', coreSha256: '', physicalSha256: '', sources: [] },
      populations: [MOON_POP], labels: '', seedRule: 'fake seed rule', yieldRule: 'fake yield rule', frame: '', cells: 'synthetic/cells.json',
      counts: { synthetic: 1, cells: 1 }, floors: {}, slopeParameterG: { value: 0.15, source: 'bowell-1989', method: 'fake G' },
      grey: { colorClass: 255, method: 'fake grey' }, columns: { pV: { label: 'synthetic', method: 'fake pV method' } },
    } as Partial<SyntheticObjectsHeader>,
  );
  const cells = makeTable<SyntheticCellsHeader>(
    [['pop', 'u8'], ['ia', 'u16'], ['ie', 'u16'], ['ii', 'u16'], ['ih', 'i32'], ['aLo', 'f32'], ['aHi', 'f32'], ['eLo', 'f32'], ['eHi', 'f32'], ['iLo', 'f32'], ['iHi', 'f32'],
      ['hLo', 'f32'], ['hHi', 'f32'], ['hLim', 'f32'], ['nModel', 'f32'], ['nObs', 'u32'], ['rawDeficit', 'f32'], ['deficit', 'f32'], ['u0', 'f32'], ['nShown', 'u32'], ['first', 'u32']],
    [{ pop: 7, ia: 8, ie: 0, ii: 30, ih: 36, aLo: 0.12, aHi: 0.13, eLo: 0, eHi: 0.1, iLo: 150, iHi: 155, hLo: 18, hHi: 18.5, hLim: 17.63, nModel: 1.4, nObs: 0, rawDeficit: 1.4, deficit: 1.4, u0: 0.1, nShown: 1, first: 0 }],
  );
  return { objects, cells };
}

function tablesWithSynthetic(): SmallBodyTables {
  const t = fakeTables();
  (t.core.header as SmallBodyCoreHeader).colorClasses = { method: '', sources: [], classes: [{ name: 'S', xyzsPerUnitPV: [1, 1, 1, 1], pVMedian: 0.2 }] };
  return { ...t, synthetic: syntheticTables() };
}

describe('synthetic objects: two-body positions', () => {
  it('solves Kepler to 1e-12 up to e = 0.9999', () => {
    for (const e of [0, 0.1, 0.5, 0.9, 0.99, 0.9999]) {
      for (let k = -20; k <= 20; k++) {
        const M = k * 0.37;
        const E = keplerE(M, e);
        const m = M - 2 * Math.PI * Math.floor(M / (2 * Math.PI));
        expect(Math.abs(E - e * Math.sin(E) - m)).toBeLessThan(1e-12);
      }
    }
  });

  it('moves on the Kepler ellipse of its elements (circular: a quarter period is a quarter turn; energy and angular momentum conserved)', () => {
    const { objects } = syntheticTables();
    const s = readSynthetic(objects.header, objects.buffer);
    const a = 2 * AU;
    const P = 2 * Math.PI * Math.sqrt((a * a * a) / FAKE_GM);
    const s0 = syntheticState(s, 0, EPOCH)!;
    const s1 = syntheticState(s, 0, EPOCH + P / 4)!;
    const tolKm = a * 1e-6;          // the elements are float32
    expect(Math.abs(s0.pos[0] - a)).toBeLessThan(tolKm);
    expect(Math.abs(s1.pos[1] - a)).toBeLessThan(tolKm);
    expect(Math.hypot(...s0.vel)).toBeCloseTo(vCirc(a), 6);
    for (const j of [1, 2]) {
      const aj = objects.table.get('a', j) * AU;
      const en = (st: { pos: number[]; vel: number[] }) => (st.vel[0] ** 2 + st.vel[1] ** 2 + st.vel[2] ** 2) / 2 - FAKE_GM / Math.hypot(st.pos[0], st.pos[1], st.pos[2]);
      const hz = (st: { pos: number[]; vel: number[] }) => st.pos[0] * st.vel[1] - st.pos[1] * st.vel[0];
      const x = syntheticState(s, j, EPOCH)!, y = syntheticState(s, j, EPOCH + 123.4 * DAY)!;
      expect(en(x) / (-FAKE_GM / (2 * aj))).toBeCloseTo(1, 10);
      expect(en(y) / en(x)).toBeCloseTo(1, 10);
      expect(hz(y) / hz(x)).toBeCloseTo(1, 10);
    }
    // e = 0.97, i = 150 deg: retrograde (h_z < 0); r = a (1 - e cos E) with M = 1 deg.
    const r = syntheticState(s, 2, EPOCH)!;
    expect(r.pos[0] * r.vel[1] - r.pos[1] * r.vel[0]).toBeLessThan(0);
    const [a2, e2] = [objects.table.get('a', 2) * AU, objects.table.get('e', 2)];
    expect(Math.hypot(...r.pos) / (a2 * (1 - e2 * Math.cos(keplerE(Math.fround(1) * DEG, e2))))).toBeCloseTo(1, 10);
  });

  it('moves a planet-centred object (synthetic irregular moon) about its barycentre with the system GM', () => {
    const { objects } = moonTables();
    const s = readSynthetic(objects.header, objects.buffer);
    const C = { pos: [7.8e8, -1.0e7, 2.0e6] as [number, number, number], vel: [1.0, 12.0, -0.3] as [number, number, number] };
    const center = (id: number) => (id === 5 ? C : null);
    expect(syntheticState(s, 0, EPOCH)).toBeNull();            // no centre given: no position
    expect(syntheticState(s, 0, EPOCH, () => null)).toBeNull();
    const a = 0.125 * AU;
    const P = 2 * Math.PI * Math.sqrt((a * a * a) / FAKE_GM_PLANET);
    expect(syntheticPeriod(s, 0)).toBeCloseTo(P, 3);
    for (const t of [0, P / 4, 0.37 * P]) {
      const rel = syntheticRelativeState(s, 0, EPOCH + t)!;
      const abs = syntheticState(s, 0, EPOCH + t, center)!;
      expect(Math.abs(Math.hypot(...rel.pos) / a - 1)).toBeLessThan(1e-6);     // circular: |r| = a (float32 a)
      expect(Math.hypot(...rel.vel)).toBeCloseTo(Math.sqrt(FAKE_GM_PLANET / a), 4);
      for (let k = 0; k < 3; k++) {
        expect(abs.pos[k]).toBeCloseTo(C.pos[k] + rel.pos[k], 3);
        expect(abs.vel[k]).toBeCloseTo(C.vel[k] + rel.vel[k], 9);
      }
      // i = 150 deg: retrograde about the barycentre
      expect(rel.pos[0] * rel.vel[1] - rel.pos[1] * rel.vel[0]).toBeLessThan(0);
    }
    expect(centerStateFrom(new FakeEphemerisSet({ 10: () => [1, 2, 3], 5: (t: number) => [5 + t, 6, 7] }, { startEt: -1e9, endEt: 1e9 }), 10)(5, 100))
      .toEqual({ pos: [104, 4, 4], vel: [1, 0, 0] });
  });
});

describe('synthetic objects in the app shell', () => {
  const eph = new FakeEphemerisSet({ 10: () => [0, 0, 0], 399: () => [1.5e8, 0, 0] }, { startEt: EPOCH - 1000 * DAY, endEt: EPOCH + 1000 * DAY });
  const setup = (synthetic: boolean, e = eph) => {
    const model = new AppModel(fakeCore(e), { now: () => FAKE_J2000_MS + (EPOCH + 10 * DAY) * 1000 });
    const products: SmallBodyProducts = {
      core: 'smallbodies/core.json', physical: null, comets: null, nongrav: null, names: null, all: [], tableBytes: 0, namesBytes: 0,
      synthetic: synthetic ? { objects: 'synthetic/objects.json', cells: 'synthetic/cells.json' } : null,
    };
    const data: LoadedData = {
      manifest: { generatedAt: 'x', pipelineVersion: 'x', window: { startEt: EPOCH - 500 * DAY, endEt: EPOCH + 500 * DAY }, products: {} },
      sources: new Map(), time: { source: 'x', leapSeconds: [], deltaTA: 0, k: 0, eb: 0, m0: 0, m1: 0 },
      ephemerides: [{ name: 'fake', path: 'ephem/fake.json', header: { bin: 'fake.bin', segments: [] }, data: new Float64Array(0) }],
      bodies: [body(10, 'Sun', 'star', { r: 7e5 }), body(399, 'Earth', 'planet', { r: 6400 })],
      light: fakeLight(), stars: null, starNames: [], report: { products: [], notes: [] }, deferred: [], orientations: [], surfaces: [],
      smallBodies: products, loader: null,
    };
    model.setData(data);
    model.setEt(EPOCH + 10 * DAY);
    model.clock.pause();
    return model;
  };

  it('makes Complete the default level once the build has a synthetic layer (a chosen level is kept)', () => {
    expect(setup(false).reality.exists).toBe('best');
    const m = setup(true);
    expect(m.reality.exists).toBe('complete');
    expect(m.realityDefaults.exists).toBe('complete');
    expect(m.badge()).toEqual([]);
    m.setReality({ exists: 'best' });
    expect(m.badge()[0]).toMatch(/BEST ESTIMATE/);
    // smallbodies=0 in the URL: no synthetic layer, so Best estimate stays the default.
    const off = setup(true);
    off.applyUrl({ smallbodies: false });
    expect(off.reality.exists).toBe('best');
    expect(off.realityDefaults.exists).toBe('best');
    // A level set in the URL is kept whatever the default.
    const url = setup(true);
    url.applyUrl({ exists: 'strict' });
    expect(url.reality.exists).toBe('strict');
    expect(url.realityDefaults.exists).toBe('complete');
  });

  it('gives synthetic rows an identity, synthetic labels and positions, and admits them at Complete only', () => {
    const m = setup(true);
    m.setSmallBodyTables(tablesWithSynthetic());
    const sb = m.smallBodies!;
    expect(sb.count).toBe(4);
    expect(sb.syntheticCount).toBe(3);
    const row = sb.count + 1;
    expect(sb.has(row) && sb.isSynthetic(row) && !sb.isSynthetic(0)).toBe(true);
    expect(sb.has(sb.count + 3)).toBe(false);
    expect(sb.name(row)).toBe('Synthetic main-belt asteroid #2');
    expect(sb.flags(row)).toEqual([]);
    expect(sb.posLabel(row)).toBe('synthetic');
    expect(sb.summary(row)).toMatchObject({ hLabel: 'synthetic', comet: false, positionKnown: true, orbitClass: { code: 'mainbelt' } });
    expect(sb.measuredDiameter(row)).toBeNull();
    expect(sb.navRadius(row)).toBeCloseTo(diameterFromH(Math.fround(19.4), Math.fround(0.25)) / 2, 9);
    const h = sb.helio(row, EPOCH + 5 * DAY)!;
    const want = syntheticState(sb.synthetic!, 1, EPOCH + 5 * DAY)!;
    expect(h.pos).toEqual(want.pos);
    expect(sb.helio(row, EPOCH + 900 * DAY)).toBeNull();      // outside the small-body window, like the catalogue
    const b = m.bodyOf(sbId(row))!;
    expect(b.radii.value).toBeNull();
    expect(b.photometry!.geometricAlbedoV).toMatchObject({ label: 'synthetic' });
    expect(m.chainLabel(sbId(row))).toBe('synthetic');
    for (const level of ['strict', 'best'] as const) expect(filterBody(b, level, { chainLabel: 'synthetic' }).position).toBe(false);
    expect(filterBody(b, 'complete', { chainLabel: 'synthetic' }).position).toBe(true);
    const tr = sb.orbit(row, EPOCH, { startEt: EPOCH - 1000 * DAY, endEt: EPOCH + 1000 * DAY })!;
    expect(tr.pos.length).toBe(3 * 257);
  });

  it('counts catalogued and synthetic points separately (the field reports both)', () => {
    const m = setup(true);
    m.setSmallBodyTables(tablesWithSynthetic());
    const f = new FakeField({}) as FakeField & { syntheticCount: number };
    (f as unknown as { stats: unknown }).stats = { drawn: 7, withheld: 3, synthetic: { drawn: 3, withheld: 0 } };
    f.syntheticCount = 3;
    m.setSmallBodyField(f);
    expect(m.smallBodyCounts()).toMatchObject({ drawn: 7, withheld: 3, synthetic: { drawn: 3, objects: 3 } });
  });

  it('explains what a synthetic object stands for, with its cell, deficit and seed, every row synthetic', () => {
    const { objects, cells } = syntheticTables();
    const s = readSynthetic(objects.header, objects.buffer, cells.header, cells.buffer);
    const f = syntheticFacts(s, 1, 'complete', 'fake epoch');
    expect(f.what).toMatch(/^Not a real object\. It stands in for one of ~3\.1 model-deficit main-belt asteroid/);
    expect(f.what).toMatch(/expects 5\.2 objects there; the catalogue has 2, with fitted completeness proxy H 18\.6/);
    expect(f.rows.every((r) => r.label === 'synthetic' && !r.withheld)).toBe(true);
    const seed = f.rows.find((r) => r.key === 'syn:seed')!;
    expect(seed.value).toBe("candidate 2 of the stream 'synthetic-v1|1|fake-model|0|0|0|38' (seed 1, algorithm synthetic-v1)");
    expect(f.rows.map((r) => r.key)).toEqual(['syn:population', 'syn:cell', 'syn:limit', 'syn:seed', 'syn:orbit', 'syn:H', 'syn:G', 'syn:pV', 'syn:D', 'syn:rot']);
    expect(syntheticFacts(s, 1, 'best', undefined).rows.every((r) => r.withheld)).toBe(true);
    expect(syntheticWhy('best', true, true)).toMatch(/exists only at Complete/);
  });

  it('explains a synthetic irregular moon: its planet, the model, the magnitude calibration and the orbit assumption', () => {
    const { objects, cells } = moonTables();
    const s = readSynthetic(objects.header, objects.buffer, cells.header, cells.buffer);
    const f = syntheticFacts(s, 0, 'complete', 'fake epoch');
    expect(f.what).toMatch(/model-deficit retrograde irregular moons of Jupiter in its cell \(a 0\.12–0\.13 au about the Jupiter system barycentre/);
    expect(f.what).toMatch(/Ashton et al\. \(2020\)/);
    expect(f.what).toMatch(/the MPC list of known moons has 0, with fitted completeness proxy H 17\.63,/);
    const orbit = f.rows.find((r) => r.key === 'syn:orbit')!;
    expect(orbit.name).toMatch(/about the Jupiter system barycentre/);
    expect(orbit.method).toMatch(/an assumption: no bias-corrected orbit distribution was found.*fake motion text/);
    expect(f.rows.find((r) => r.key === 'syn:limit')!.method).toMatch(/H_V = m − 6\.37 ± 0\.06, the median offset over the survey's photometry of 7 known moons/);
    // A missing population attribute must be shown as unknown, including below Complete.
    for (const level of ['complete', 'best'] as const) {
      expect(syntheticFacts(s, 0, level, 'fake epoch').rows.find((r) => r.key === 'syn:rot'))
        .toMatchObject({ name: 'Rotation period', label: 'unknown', value: 'unknown', sources: [], withheld: false });
    }
  });

  it('places a synthetic irregular moon at its planet, draws its orbit around the planet now, and lights it grey', () => {
    const PLANET: [number, number, number] = [7.8e8, 1e6, -2e6];
    const eph2 = new FakeEphemerisSet({ 10: () => [0, 0, 0], 399: () => [1.5e8, 0, 0], 5: () => PLANET }, { startEt: EPOCH - 1000 * DAY, endEt: EPOCH + 1000 * DAY });
    const model = setup(true, eph2);
    const t = fakeTables();
    (t.core.header as SmallBodyCoreHeader).colorClasses = { method: '', sources: [], classes: [{ name: 'S', xyzsPerUnitPV: [1, 1, 1, 1], pVMedian: 0.2 }] };
    model.setSmallBodyTables({ ...t, synthetic: moonTables(), photometry: { sunIrradianceXYZS1AU: { value: [3, 4, 5, 6], label: 'derived', sources: [] } } as unknown as SmallBodyTables['photometry'] });
    const sb = model.smallBodies!;
    const row = sb.count;
    expect(sb.name(row)).toBe('Synthetic irregular moon of Jupiter #1');
    const h = sb.helio(row, EPOCH + 3 * DAY)!;
    expect(Math.hypot(h.pos[0] - PLANET[0], h.pos[1] - PLANET[1], h.pos[2] - PLANET[2]) / (0.125 * AU)).toBeCloseTo(1, 5);
    const tr = sb.orbit(row, EPOCH, { startEt: EPOCH - 1000 * DAY, endEt: EPOCH + 1000 * DAY })!;
    const n = tr.pos.length / 3;
    const mean = [0, 1, 2].map((k) => { let x = 0; for (let q = 0; q < n - 1; q++) x += tr.pos[3 * q + k]; return x / (n - 1); });
    for (let k = 0; k < 3; k++) expect(Math.abs(mean[k] - PLANET[k])).toBeLessThan(1e-3 * 0.125 * AU);
    const b = model.bodyOf(sbId(row))!;
    expect(b.photometry!.geometricAlbedoXYZS).toMatchObject({ label: 'synthetic' });
    expect((b.photometry!.geometricAlbedoXYZS.value as number[])[1]).toBeCloseTo(4 * Math.fround(0.04), 9);
  });
});

// ---------------------------------------------------------------------------------------------- real products
interface Fs { existsSync(p: string): boolean; readFileSync(p: string): Uint8Array; readFileSync(p: string, e: 'utf8'): string }
const fs: Fs = await import(/* @vite-ignore */ 'node:fs' as string);
const built = fs.existsSync(DATA_DIR + 'synthetic/objects.json') && fs.existsSync(DATA_DIR + 'synthetic/cells.json');
if (!built) console.warn('[synthetic tests] synthetic/* not built; skipping the real-data tests');

describe.skipIf(!built)('the built synthetic layer', () => {
  const read = <H>(name: string) => {
    const header = JSON.parse(fs.readFileSync(DATA_DIR + `synthetic/${name}.json`, 'utf8')) as H;
    const u8 = fs.readFileSync(DATA_DIR + `synthetic/${name}.bin`);
    return { header, buffer: u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer };
  };

  it.each([
    ['hilda', '2025', ['family orbital coefficients', 'magnitude coefficients', 'spline end conditions', 'real-valued']],
    ['trojan', '2024', ['stability mask', 'family magnitude', 'spline end conditions', 'real-valued']],
  ])('explains why the published %s model is inactive in the inspector', (name, year, missing) => {
    const o = read<SyntheticObjectsHeader>('objects');
    const c = read<SyntheticCellsHeader>('cells');
    const s = readSynthetic(o.header, o.buffer, c.header, c.buffer);
    const p = o.header.populations.find(p => p.name === name)!;
    const f = syntheticFacts(s, p.firstObject, 'complete', o.header.epochTdb);
    const row = f.rows.find(r => r.key === 'syn:population')!;
    expect(row.method).toBe(p.model.method);
    expect(row.method).toContain(`Vokrouhlický et al. (${year})`);
    expect(row.method).toContain('published bias-corrected model');
    expect(row.method).toContain('not used');
    expect(row.method).toContain('https://arxiv.org/');
    for (const phrase of missing) expect(row.method).toContain(phrase);
    expect(p.modelId).toMatch(/^catalogue\+hendler-malhotra-2020\+/);
  });

  it('never shows an object brighter than its cell\'s completeness limit; cells tile the object table', () => {
    const o = read<SyntheticObjectsHeader>('objects');
    const c = read<SyntheticCellsHeader>('cells');
    const s = readSynthetic(o.header, o.buffer, c.header, c.buffer);
    const ot = s.table, ct = s.cells!;
    const H = ot.column('H'), cell = ot.column('cell'), pop = ot.column('pop');
    const hLim = ct.column('hLim'), cpop = ct.column('pop');
    let bad = 0;
    for (let j = 0; j < s.count; j++) {
      const k = cell.get(j);
      if (H.get(j) < hLim.get(k) || pop.get(j) !== cpop.get(k)) bad++;
    }
    expect(bad).toBe(0);
    let shown = 0;
    for (let k = 0; k < ct.count; k++) shown += ct.get('nShown', k);
    expect(shown).toBe(s.count);
    for (const p of o.header.populations) {
      let n = 0;
      for (let j = p.firstObject; j < p.firstObject + p.objects; j++) if (pop.get(j) === p.code) n++;
      expect(n).toBe(p.objects);
    }
  });

  it('turns stored elements into states whose osculating a, e, i are the stored ones', () => {
    const o = read<SyntheticObjectsHeader>('objects');
    const s = readSynthetic(o.header, o.buffer);
    const eps = s.obliquity;
    let worst = 0;
    // every population, the irregular moons included (states relative to the centre of the orbit, mu of that centre)
    const firsts = o.header.populations.filter((p) => p.objects > 0).flatMap((p) => Array.from({ length: Math.min(p.objects, 300) }, (_, k) => p.firstObject + Math.floor((k * p.objects) / Math.min(p.objects, 300))));
    for (const j of firsts) {
      const st = syntheticRelativeState(s, j, s.epochEt + 77.7 * DAY)!;
      const mu = syntheticMu(s, j);
      const r = st.pos, v = st.vel;
      // back to the ecliptic
      const re = [r[0], Math.cos(eps) * r[1] + Math.sin(eps) * r[2], -Math.sin(eps) * r[1] + Math.cos(eps) * r[2]];
      const ve = [v[0], Math.cos(eps) * v[1] + Math.sin(eps) * v[2], -Math.sin(eps) * v[1] + Math.cos(eps) * v[2]];
      const rn = Math.hypot(re[0], re[1], re[2]);
      const a = 1 / (2 / rn - (ve[0] ** 2 + ve[1] ** 2 + ve[2] ** 2) / mu);
      const hvec = [re[1] * ve[2] - re[2] * ve[1], re[2] * ve[0] - re[0] * ve[2], re[0] * ve[1] - re[1] * ve[0]];
      const hn = Math.hypot(hvec[0], hvec[1], hvec[2]);
      const inc = Math.acos(hvec[2] / hn) / DEG;
      const e = Math.sqrt(Math.max(0, 1 - (hn * hn) / (mu * a)));
      worst = Math.max(worst, Math.abs(a / (s.table.get('a', j) * s.auKm) - 1), Math.abs(e - s.table.get('e', j)), Math.abs(inc - s.table.get('i', j)) * DEG);
    }
    expect(worst).toBeLessThan(1e-7);
  });

  it('is conditioned on the catalogue product it ships with', () => {
    const o = read<SyntheticObjectsHeader>('objects');
    const manifest = JSON.parse(fs.readFileSync(DATA_DIR + 'manifest.json', 'utf8')) as Manifest;
    expect(o.header.catalogue.coreSha256).toBe(manifest.products['smallbodies/core.bin']?.sha256);
    expect(new BinaryTable(o.header, o.buffer).count).toBe(o.header.counts.synthetic);
  });

  it('keeps synthetic irregular moons bound to their planet and Centaurs beyond Jupiter', () => {
    const o = read<SyntheticObjectsHeader>('objects');
    const s = readSynthetic(o.header, o.buffer);
    const moons = o.header.populations.filter((p) => p.center);
    if (!moons.length) return;      // a layer built before the irregular moons
    for (const p of moons) {
      for (let j = p.firstObject; j < p.firstObject + p.objects; j++) {
        const r = syntheticRelativeState(s, j, s.epochEt + 100 * DAY)!;
        const rAu = Math.hypot(...r.pos) / s.auKm;
        // within its pericentre-apocentre range about the barycentre, far inside the Sun's distance
        expect(rAu).toBeLessThanOrEqual(s.table.get('a', j) * (1 + s.table.get('e', j)) * (1 + 1e-6));
        expect(rAu).toBeLessThan(0.6);
        expect(s.table.get('colorClass', j)).toBe(255);
      }
    }
    const cen = o.header.populations.find((p) => p.name === 'centaur');
    if (cen) {
      for (let j = cen.firstObject; j < cen.firstObject + cen.objects; j += 7) {
        const a = s.table.get('a', j), e = s.table.get('e', j);
        expect(a * (1 - e)).toBeGreaterThan(5.2 - 1e-5);
        expect(a).toBeLessThan(30);
      }
    }
  });
});

describe('synthetic statement limits', () => {
  it('calls the fitted cutoff a proxy and discloses unknown orbit detectability even with older headers', () => {
    const { objects, cells } = moonTables();
    const s = readSynthetic(objects.header, objects.buffer, cells.header, cells.buffer);
    const f = syntheticFacts(s, 0, 'complete', 'fake epoch');
    const limit = f.rows.find((r) => r.key === 'syn:limit')!;
    expect(limit.name).toBe('Completeness proxy here');
    expect(limit.uncertainty).toMatch(/not a detection probability/);
    expect(limit.uncertainty).toMatch(/not evaluated for this synthetic orbit/);
    expect(f.what).not.toMatch(/the debiased population|complete down to/);
    expect(f.what).toMatch(/aggregate/);
    expect(f.rows.find((r) => r.key === 'syn:orbit')!.uncertainty).toMatch(/unknown/);
  });

  it('keeps population disclosures sourced, including zero-object populations, and obeys the reality filter', () => {
    const p = { ...MOON_POP, name: 'irregular-uranus', objects: 0,
      model: { method: 'No supported faint model in the sources reviewed.', uncertainty: 'No samples; unknown unseen count.' } };
    for (const level of ['complete', 'best'] as const) {
      const rows = syntheticPopulationFacts(p, level);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ label: 'synthetic', sources: p.sources, withheld: level === 'best',
        method: p.model.method, uncertainty: p.model.uncertainty });
    }
  });

  it.skipIf(!built)('reads population limitations and sampled motion evidence into the object inspector', () => {
    const h = JSON.parse(fs.readFileSync(DATA_DIR + 'synthetic/objects.json', 'utf8')) as SyntheticObjectsHeader;
    const ch = JSON.parse(fs.readFileSync(DATA_DIR + 'synthetic/cells.json', 'utf8')) as SyntheticCellsHeader;
    const buf = (name: string) => {
      const b = fs.readFileSync(DATA_DIR + `synthetic/${name}.bin`);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    };
    const s = readSynthetic(h, buf('objects'), ch, buf('cells'));
    for (const p of h.populations.filter((p) => p.objects)) {
      const f = syntheticFacts(s, p.firstObject, 'complete', h.epochTdb);
      expect(f.rows.find((r) => r.key === 'syn:limit')!.uncertainty).toMatch(/proxy.*not a detection probability/);
      const orbit = f.rows.find((r) => r.key === 'syn:orbit')!;
      expect(orbit.uncertainty).toBe(p.model.positionUncertainty);
      expect(orbit.uncertainty).toMatch(/C3.*not a bound/);
      expect(orbit.method).toContain(String(p.model.motion));
      expect(f.what).toMatch(/aggregate/);
      const population = f.rows.find((r) => r.key === 'syn:population')!;
      expect(population.uncertainty).toBe(p.model.uncertainty);
      if (p.name === 'centaur') {
        expect(population.uncertainty).toMatch(/43.*comet-flagged.*18.*suitability/);
        const nuclei = f.rows.find(r => r.key === 'syn:nuclei')!;
        expect(nuclei.value).toBe('1 conditioned; 43 unconditioned');
        expect(nuclei.method).toContain('Conditioned: C/2014 OG392.');
      }
      if (p.center) expect(f.what).not.toMatch(/the debiased population|complete down to/);
    }
  });
});

it('names comet nuclei whose nuclear H cannot condition the Centaur population', () => {
  const p = { name: 'centaur', sources: ['paper'], model: { method: 'qualified nuclear H_V', cometNuclei: {
    rule: 'Only qualified point nuclear H_V counts; M1 and lower bounds do not count.', objects: [
      { designation: 'P/qualified', status: 'conditioned' },
      { designation: 'P/unknown', status: 'unknown-model-band' },
      { designation: 'P/bound', status: 'unqualified' },
    ],
  } } } as unknown as SyntheticPopulation;
  const row = syntheticPopulationFacts(p, 'complete').find(r => r.key === 'syn:nuclei');
  expect(row?.value).toContain('1 conditioned');
  expect(row?.method).toContain('P/unknown: unknown-model-band');
  expect(row?.method).toContain('P/bound: unqualified');
  expect(row?.method).toContain('M1 and lower bounds do not count');
});
