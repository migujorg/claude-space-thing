// Small bodies in the app shell with made-up tables (sb-fixtures.ts) and a fake GPU field: identity, CPU
// positions, selection and go-to, the resolved close-up and its reality-filter rules, picking fallback, counts,
// inspector rows, URL SPK-ID targets.

import { describe, expect, it } from 'vitest';
import { AppModel } from '../src/app/model';
import { viewDistance } from '../src/app/camera';
import { NameService } from '../src/app/nameService';
import { CpuSmallBodyStates, sbId, sbRow } from '../src/app/smallbodies';
import { len, sub } from '../src/app/vec';
import { keplerDrift, SmallBodyPropagator } from '../src/core/smallbody';
import { gridStates } from '../src/app/sbgrid';
import type { LoadedData } from '../src/data/load';
import type { SmallBodyNamesHeader } from '../src/data/schema';
import type { SmallBodyProducts } from '../src/data/smallbodies';
import { brightnessInputs, smallBodyFacts, smallBodyLegend, smallBodyWhy } from '../src/ui/smallBodyInspect';
import { body, FAKE_J2000_MS, FakeEphemerisSet, fakeCore, fakeLight } from './app-fakes';
import { DAY, EPOCH, FAKE_GM, FakeField, R0, fakeTables } from './sb-fixtures';

const T = EPOCH + 10 * DAY;
const PRODUCTS: SmallBodyProducts = { core: 'smallbodies/core.json', physical: null, comets: null, nongrav: null, names: null, all: [], tableBytes: 0, namesBytes: 0 };

function setup(opts: { products?: boolean } = {}) {
  const eph = new FakeEphemerisSet({ 10: () => [0, 0, 0], 399: () => [1.5e8, 0, 0] }, { startEt: EPOCH - 1000 * DAY, endEt: EPOCH + 1000 * DAY });
  const model = new AppModel(fakeCore(eph), { now: () => FAKE_J2000_MS + T * 1000 });
  const data: LoadedData = {
    manifest: { generatedAt: 'x', pipelineVersion: 'x', window: { startEt: EPOCH - 500 * DAY, endEt: EPOCH + 500 * DAY }, products: {} },
    sources: new Map(),
    time: { source: 'x', leapSeconds: [], deltaTA: 0, k: 0, eb: 0, m0: 0, m1: 0 },
    ephemerides: [{ name: 'fake', path: 'ephem/fake.json', header: { bin: 'fake.bin', segments: [] }, data: new Float64Array(0) }],
    bodies: [body(10, 'Sun', 'star', { r: 7e5 }), body(399, 'Earth', 'planet', { r: 6400, albedo: 'derived', phase: 'measured' })],
    light: fakeLight(),
    stars: null,
    starNames: [],
    report: { products: [], notes: [] },
    deferred: [],
    orientations: [],
    surfaces: [],
    smallBodies: opts.products ? PRODUCTS : null,
    loader: null,
  };
  model.setData(data);
  model.setViewport({ width: 1600, height: 900, dpr: 1 });
  model.setEt(T);
  model.clock.pause();
  return { model, eph };
}

function withTables(field?: FakeField) {
  const s = setup();
  s.model.setSmallBodyTables(fakeTables());
  if (field) s.model.setSmallBodyField(field);
  return s;
}

describe('small-body identity and CPU positions', () => {
  it('maps rows to negative body ids and builds a pseudo body with honest labels', () => {
    expect(sbRow(sbId(0))).toBe(0);
    expect(sbId(0)).toBe(-1);
    const { model } = withTables();
    const b = model.bodyOf(sbId(0))!;
    expect(b.name).toBe('Small body #1');
    // Sphere of the measured diameter: the shape is an assumption.
    expect(b.radii.value).toEqual([5, 5, 5]);
    expect(b.radii.label).toBe('estimated');
    expect(b.photometry!.geometricAlbedoXYZS.label).toBe('derived');
    expect(b.photometry!.phaseFunction).toMatchObject({ value: { kind: 'lambert' }, label: 'estimated' });
    expect(model.bodyOf(sbId(1))!.radii.value).toBeNull(); // no measured diameter → nothing resolved
    expect(model.radiusOf(sbId(1))).toBeCloseTo(0.5, 6); // …but the diameter from H serves navigation
    expect(model.bodyOf(sbId(99))).toBeUndefined();
    expect(model.chainLabel(sbId(0))).toBe('derived');
  });

  it('propagates two-body exactly and restarts on the grid bit-identically, whatever the query order', () => {
    const t = fakeTables();
    const eph = { positionSSB: () => [0, 0, 0] as [number, number, number] };
    const a = new CpuSmallBodyStates(t, eph);
    const times = [EPOCH + 100.3 * DAY, EPOCH + 10.7 * DAY, EPOCH - 50.1 * DAY, EPOCH + 399 * DAY, EPOCH];
    const first = times.map((x) => a.stateOf(0, x));
    // A fresh store per time: one long propagation each.
    const direct = times.map((x) => new CpuSmallBodyStates(t, eph).stateOf(0, x));
    expect(first).toEqual(direct);
    // Against a single Kepler drift from the epoch state.
    const st = Float64Array.from([R0, 0, 0, 0, Math.sqrt(FAKE_GM / R0), 0]);
    keplerDrift(st, 0, times[0] - EPOCH, FAKE_GM);
    expect(Math.hypot(first[0]!.pos[0] - st[0], first[0]!.pos[1] - st[1], first[0]!.pos[2] - st[2])).toBeLessThan(1e-3);
    expect(a.stateOf(0, EPOCH + 401 * DAY)).toBeNull(); // outside the catalogue window: never extrapolated
    expect(a.stateOf(2, T)).toBeNull(); // position unknown
  });
});

describe('background propagation (worker protocol, in-process)', () => {
  const fakeEph = { positionSSB: () => [0, 0, 0] as [number, number, number] };
  /** The worker's computation, run in this thread but answered asynchronously like the real worker. */
  const port = (t: ReturnType<typeof fakeTables>) => {
    const prop = new SmallBodyPropagator(t.core.header.forceModel, fakeEph as never);
    const calls: number[] = [];
    return {
      calls,
      grid: async (row: number, state: ArrayLike<number>, ng: null) => {
        calls.push(row);
        await new Promise((r) => setTimeout(r, 0));
        return gridStates(prop, state, ng, EPOCH, t.core.header.forceModel.grid.baseStepS, t.core.header.window);
      },
    };
  };

  it('seeds the store with whole-window states identical to the main-thread propagation', async () => {
    const t = fakeTables();
    const sync = new CpuSmallBodyStates(t, fakeEph);
    const bg = new CpuSmallBodyStates(t, fakeEph);
    const p = port(t);
    bg.attachWorker(p);
    const seeded = new Promise<number>((r) => (bg.onSeeded = r));
    expect(bg.stateOf(1, T)).toBeNull(); // pending
    expect(bg.isPending(1)).toBe(true);
    expect(bg.stateOf(1, T + DAY)).toBeNull();
    expect(p.calls).toEqual([1]); // requested once
    expect(await seeded).toBe(1);
    const times = [T, EPOCH - 399.5 * DAY, EPOCH + 399.9 * DAY, EPOCH + 3.3 * DAY];
    expect(times.map((x) => bg.stateOf(1, x))).toEqual(times.map((x) => sync.stateOf(1, x)));
    expect(bg.ms).toBeLessThan(sync.ms + 50); // only partial steps on this thread
  });

  it('a go-to waits for the background propagation, then travels', async () => {
    const { model } = withTables();
    const p = port(model.smallBodies!.tables);
    model.useGridWorker(p);
    const r = model.goTo(sbId(1), undefined, { instant: true });
    expect(r).toBeInstanceOf(Promise);
    expect(model.bodyLoadState(sbId(1))).toBe('loading');
    expect(model.messages.at(-1)?.text).toMatch(/Propagating Small body #2/);
    await r;
    expect(model.cam).toMatchObject({ mode: 'orbit', target: sbId(1) });
    expect(model.bodyLoadState(sbId(1))).toBe('loaded');
  });

  it('falls back to the main thread when the worker fails', async () => {
    const { model } = withTables();
    model.useGridWorker({ grid: async () => { throw new Error('boom'); } });
    expect(model.bodyPos(sbId(1))).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(model.messages.at(-1)?.text).toMatch(/main thread \(worker failed: boom\)/);
    expect(model.bodyPos(sbId(1))).not.toBeNull();
  });
});

describe('selection, go-to and the close-up (fake field)', () => {
  it('selects, travels to a few diameters, draws a resolved sphere and takes it out of the field', () => {
    const field = new FakeField({ 0: [R0, 0, 0], 1: [0, R0, 0] });
    const { model } = withTables(field);
    const id = sbId(0);
    model.select(id);
    expect(model.selectedId).toBe(id);
    model.frame(0);
    const g = model.world!.bodies.get(id)!;
    expect(g.app).not.toBeNull();
    expect(g.app!.lightTime).toBeCloseTo(len(g.app!.rel) / 1e5, 6); // fake light speed 1e5 km/s
    expect(g.toSun).toEqual([-R0, 0, 0]);

    const r = model.goTo(id, undefined, { instant: true });
    expect(typeof r).not.toBe('string');
    expect(model.cam).toMatchObject({ mode: 'orbit', target: id });
    expect(model.cam.mode === 'orbit' && model.cam.dist).toBeCloseTo(viewDistance(5, model.fovY), 6);
    model.frame(0);
    const close = model.snapshot!.bodies.find((b) => b.id === id)!;
    expect(close.radii).toEqual([5, 5, 5]);
    expect(close.albedoXYZS).toEqual([0.1, 0.2, 0.3, 0.4].map((x) => Math.fround(x)));
    expect(close.worstLabel).toBe('estimated');
    expect(field.excluded.at(-1)).toEqual([0]);
    expect(model.debugState().smallBodies.closeUps).toEqual([id]);

    // Strict: the sphere is an assumption, so no close-up — the field's point only.
    model.setReality({ exists: 'strict' });
    model.frame(0);
    expect(model.snapshot!.bodies.some((b) => b.id < 0)).toBe(false);
    expect(field.excluded.at(-1)).toEqual([]);
    expect(model.overlayOnly.some((b) => b.id === id)).toBe(false); // the field draws it; no hollow marker

    // Far away (sub-pixel): the field draws it.
    model.setReality({ exists: 'best' });
    void model.goTo(id, 1e8, { instant: true });
    model.frame(0);
    expect(model.snapshot!.bodies.some((b) => b.id < 0)).toBe(false);
  });

  it('without a field: resolved-capable bodies go to the renderer, others get the overlay marker', () => {
    const { model } = withTables();
    model.select(sbId(1));
    model.frame(0);
    expect(model.overlayOnly.map((b) => b.id)).toContain(sbId(1));
    model.select(sbId(0));
    void model.goTo(sbId(0), 1e8, { instant: true });
    model.frame(0);
    expect(model.snapshot!.bodies.find((b) => b.id === sbId(0))?.radii).toEqual([5, 5, 5]);
  });

  it('picks the field when no major body is under the cursor', async () => {
    const field = new FakeField({ 0: [R0, 0, 0] });
    const { model } = withTables(field);
    void model.goTo(399, 1e5, { instant: true });
    model.frame(0);
    field.pickResult = 1;
    const id = await model.pickAtAsync(5, 5); // a corner: nothing major there
    expect(id).toBe(sbId(1));
    expect(field.picks[0].tol).toBeCloseTo((6 * 2 * Math.tan(model.fovY / 2)) / 900, 9);
    field.pickResult = null;
    expect(await model.pickAtAsync(5, 5)).toBeNull();
  });

  it('a go-to issued before the catalogue arrives completes once it does', async () => {
    const { model } = setup({ products: true });
    expect(model.sb.status).toBe('waiting');
    const r = model.goTo(sbId(0), undefined, { instant: true });
    expect(r).toBeInstanceOf(Promise);
    expect(model.messages.at(-1)?.text).toMatch(/Loading the small-body catalogue/);
    model.setSmallBodyTables(fakeTables());
    await r;
    expect(model.cam).toMatchObject({ mode: 'orbit', target: sbId(0) });
    expect(model.selectedId).toBe(sbId(0));
  });

  it('explains why there is no position', () => {
    const { model } = withTables();
    expect(model.goTo(sbId(2))).toMatch(/position is unknown/);
    model.setEt(EPOCH + 450 * DAY);
    expect(model.goTo(sbId(0))).toMatch(/only within/);
  });

  it('draws the orbit of the selected small body from propagated positions', () => {
    const { model } = withTables();
    model.select(sbId(1));
    model.setReality({ overlays: { orbits: true } });
    model.frame(0);
    const o = model.snapshot!.orbits.find((x) => x.id === sbId(1))!;
    expect(o.selected).toBe(true);
    const sunRel = model.world!.bodies.get(10)!.app!.rel;
    let worst = 0;
    for (let i = 0; i < o.points.length; i += 3) {
      const r = Math.hypot(o.points[i] - sunRel[0], o.points[i + 1] - sunRel[1], o.points[i + 2] - sunRel[2]);
      worst = Math.max(worst, Math.abs(r - R0));
    }
    expect(o.points.length / 3).toBeGreaterThan(100);
    expect(worst).toBeLessThan(1e-3); // a circular two-body orbit stays at R0
  });
});

describe('counts, badge and inspector rows', () => {
  it('counts drawn / withheld by labels without a field, and uses the field counts when there is one', () => {
    const { model } = withTables();
    expect(model.smallBodyCounts()).toEqual({ drawn: 3, withheld: 0, noPosition: 1, from: 'labels' });
    model.setReality({ exists: 'strict' });
    // Row 0 keeps its point through its measured phase fit; row 1 (G assumed) and the comet (law estimated) do not.
    expect(model.smallBodyCounts()).toEqual({ drawn: 1, withheld: 2, noPosition: 1, from: 'labels' });
    expect(model.badge()).toContain('SMALL BODIES: 2 withheld');
    const f = new FakeField({});
    model.setSmallBodyField(f);
    expect(model.smallBodyCounts()).toMatchObject({ drawn: 7, withheld: 3, from: 'field' });
  });

  it('lists every attribute with label, source and method; flags; why lines', () => {
    const t = fakeTables();
    const f = smallBodyFacts(t, 0, 'strict');
    const byKey = Object.fromEntries(f.rows.map((r) => [r.key, r]));
    expect(byKey['sb:orbit']).toMatchObject({ label: 'derived', withheld: false });
    expect(byKey['sb:orbit'].sources).toEqual(['src-orbits', 'src-planets']);
    expect(byKey['sb:orbit'].method).toMatch(/fake orbit method.*LEAPFROG/);
    expect(byKey['sb:H']).toMatchObject({ label: 'measured', value: '15 mag', sources: ['src-orbits'] });
    expect(byKey['sb:G']).toMatchObject({ label: 'estimated', withheld: true, method: 'fake G method: assumed value, estimated' });
    expect(byKey['sb:diameter']).toMatchObject({ label: 'measured', value: '10 ± 1 km', sources: ['src-physical'], method: 'fake diameter method' });
    expect(byKey['sb:colour']).toMatchObject({ label: 'derived', sources: ['src-colour'] });
    expect(byKey['sb:phase'].value).toMatch(/^H 15\.1/);
    expect(f.unknown).toContain('Rotation period (synodic)');
    expect(f.flags.map((x) => x.name)).toEqual(['numbered', 'neo']);
    expect(f.orbitClass).toEqual({ code: 'AAA', name: 'fake class A' });
    // A comet: its magnitude law row.
    expect(smallBodyFacts(t, 3, 'best').rows.find((r) => r.key === 'sb:cometTotal')).toMatchObject({ label: 'estimated', value: 'M1 10 mag, K1 8' });

    const why = (row: number, level: 'strict' | 'best', field = true) =>
      smallBodyWhy({ level, positionLabel: t.core.table.label('posLabel', row), drawn: 'point', field, inputs: brightnessInputs(t, row), filtered: null, hasDiameter: row === 0 });
    expect(why(0, 'strict')).toMatch(/^Drawn by the small-body field as a point.*H-G1-G2 fit \(measured\)/);
    expect(why(1, 'strict')).toMatch(/^Not drawn at Strict: its brightness rests on G \(estimated\)/);
    expect(why(1, 'best')).toMatch(/^Drawn by the small-body field/);
    expect(why(2, 'best')).toMatch(/position is unknown/);
    expect(why(1, 'best', false)).toMatch(/no small-body renderer/);
    expect(smallBodyLegend(t).join(' ')).toMatch(/G: 3 estimated, 1 unknown\. fake G method/);
  });
});

describe('names and URL targets', () => {
  const header: SmallBodyNamesHeader = { file: 'smallbodies/names.txt', count: 4, encoding: 'utf-8', separator: '\t', lineSeparator: '\n', columns: ['spkid', 'designation', 'name', 'prefix', 'principalProvisionalDesignation'], sources: [] };
  const text = ['20000123\t123\tFakeone\t\t2001 AA', '54000001\t2020 BB\t\t\t2020 BB', '54000002\t2021 CC\t\t\t2021 CC', '1000001\t9P\tFakecomet\tP\t'].join('\n') + '\n';
  const names = () => new NameService({ url: 'names.txt', header, fetch: async () => new Response(text) });

  it('resolves an SPK-ID target from the URL once names and tables are in, and links back to it', async () => {
    const { model } = setup({ products: true });
    model.applyUrl({ target: 20000123, dist: 50, tMs: FAKE_J2000_MS + T * 1000 });
    expect(model.cam.mode === 'orbit' && model.cam.target).toBe(399); // somewhere meanwhile
    model.names = names();
    model.setSmallBodyTables(fakeTables());
    await model.urlTargetSettled();
    expect(model.cam).toMatchObject({ mode: 'orbit', target: sbId(0), dist: 50 });
    await model.names.display([0]);
    expect(model.currentUrlView()).toMatchObject({ target: 20000123, dist: 50 });
    // The selection's name arrives from the index.
    model.select(sbId(0));
    await new Promise((r) => setTimeout(r, 0));
    expect(model.bodyName(sbId(0))).toBe('123 Fakeone (2001 AA)');
  });

  it('caches SPK-IDs with display names', async () => {
    const svc = names();
    expect(await svc.display([3, 1])).toEqual(['9P/Fakecomet', '2020 BB']);
    expect(svc.spkidOf(3)).toBe(1000001);
    expect(svc.spkidOf(0)).toBeNull();
    expect(await svc.rowOfSpkid(20000123)).toBe(0);
    expect(svc.spkidOf(0)).toBe(20000123);
  });

  it('distance from the selected small body tracks the propagated position', () => {
    const { model } = withTables();
    void model.goTo(sbId(1), 1e6, { instant: true });
    model.frame(0);
    const p = model.bodyPos(sbId(1))!;
    expect(len(sub(model.pose.pos, p))).toBeCloseTo(1e6, 3);
  });
});
