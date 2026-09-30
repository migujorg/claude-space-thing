import { describe, expect, it } from 'vitest';
import { SystemScheduler, systemBarycenter, type SystemInfo } from '../src/app/lazy';
import { AppModel } from '../src/app/model';
import type { DeferredEphemeris, LoadedData, LoadedEphemeris } from '../src/data/load';
import type { EphemHeader } from '../src/data/schema';
import type { Vec3 } from '../src/app/ports';
import { body, FAKE_J2000_MS, FakeEphemerisSet, fakeCore, fakeLight } from './app-fakes';

const sys = (name: string, bodies: number[], bary: number | null = null, bytes = 1000): SystemInfo => ({ path: `ephem/${name}.json`, name, title: name, bytes, bodies, barycenter: bary });

describe('SystemScheduler', () => {
  it('walks deferred → queued → loading → loaded / error', () => {
    const s = new SystemScheduler([sys('sat-jup', [599, 501]), sys('sat-sat', [699])], 1);
    expect(s.state('ephem/sat-jup.json')).toBe('deferred');
    expect(s.next()).toBeNull(); // nothing queued before startAll/request
    s.startAll();
    expect(s.state('ephem/sat-sat.json')).toBe('queued');
    const a = s.next()!;
    expect(s.state(a.path)).toBe('loading');
    expect(s.next()).toBeNull(); // concurrency 1
    s.setProgress(a.path, 0.5);
    expect(s.progress(a.path)).toBe(0.5);
    s.done(a.path, true);
    expect(s.state(a.path)).toBe('loaded');
    const b = s.next()!;
    s.done(b.path, false, 'HTTP 500');
    expect(s.state(b.path)).toBe('error');
    expect(s.idle).toBe(true);
    expect(s.summary()).toMatchObject({ loaded: 1, total: 2, errors: [`${b.title}: HTTP 500`] });
  });

  it('prefers explicit requests (latest first), then closer systems', () => {
    const s = new SystemScheduler([sys('a', [1]), sys('b', [2]), sys('c', [3]), sys('d', [4])], 1);
    s.setBasePriority('ephem/a.json', -9); // far
    s.setBasePriority('ephem/b.json', -6); // near
    s.setBasePriority('ephem/c.json', -8);
    s.setBasePriority('ephem/d.json', -7);
    s.startAll();
    expect(s.next()!.name).toBe('b');
    s.done('ephem/b.json', true);
    s.request('ephem/a.json');
    s.request('ephem/c.json');
    expect(s.next()!.name).toBe('c'); // most recent request
    s.done('ephem/c.json', true);
    expect(s.next()!.name).toBe('a');
    s.done('ephem/a.json', true);
    expect(s.next()!.name).toBe('d');
  });

  it('knows what each body is waiting for', () => {
    const s = new SystemScheduler([sys('sat-jup', [599, 501])], 2);
    expect(s.bodyState(501)).toBe('deferred');
    expect(s.bodyState(399)).toBe('loaded'); // needs nothing deferred
    expect(s.requestBody(501).map((x) => x.name)).toEqual(['sat-jup']);
    expect(s.bodyState(501)).toBe('queued');
    s.next();
    expect(s.bodyState(501)).toBe('loading');
    s.done('ephem/sat-jup.json', true);
    expect(s.bodyState(501)).toBe('loaded');
    expect(s.pendingFor(501)).toEqual([]);
  });

  it('finds a system barycenter from its segment centers', () => {
    expect(systemBarycenter([{ center: 5 }, { center: 599 }, { center: 5 }, { center: 0 }])).toBe(5);
    expect(systemBarycenter([{ center: 0 }])).toBeNull();
  });
});

// ---- AppModel background loading with a fake loader ------------------------------------------------

const T0 = 8.4e8;
const jupAt = (t: number): Vec3 => [7.8e8, 13 * (t - T0), 0];
const ioAt = (t: number): Vec3 => { const j = jupAt(t); return [j[0] + 4.2e5, j[1], j[2]]; };

function setupLazy(opts: { fail?: boolean } = {}) {
  // The fake ephemeris set only "covers" a body once its file has been added.
  const all = new FakeEphemerisSet({ 10: () => [0, 0, 0], 399: () => [1.5e8, 0, 0], 599: jupAt, 501: ioAt }, { startEt: T0 - 1e7, endEt: T0 + 1e7 });
  const loadedIds = new Set([10, 399]);
  const eph = new FakeEphemerisSet(undefined, all.window);
  eph.covers = (id, et) => loadedIds.has(id) && all.covers(id, et);
  eph.positionSSB = (id, et) => (loadedIds.has(id) ? all.positionSSB(id, et) : null);
  eph.stateSSB = (id, et) => (loadedIds.has(id) ? all.stateSSB(id, et) : null);
  eph.add = (e) => { for (const id of (e as unknown as { ids: number[] }).ids) loadedIds.add(id); };
  const header: EphemHeader = { bin: 'ephem/sat-jup.bin', segments: [{ target: 599, center: 5, frame: 'J2000', type: 2, initEt: 0, intLen: 1, rsize: 5, n: 1, offset: 0, sources: [] }, { target: 501, center: 5, frame: 'J2000', type: 2, initEt: 0, intLen: 1, rsize: 5, n: 1, offset: 0, sources: [] }] };
  const deferred: DeferredEphemeris = { name: 'sat-jup', path: 'ephem/sat-jup.json', binPath: 'ephem/sat-jup.bin', header, bytes: 1000, bodies: [599, 501] };
  let release: (() => void) | null = null;
  const calls: string[] = [];
  const loader = {
    loadDeferred: (d: DeferredEphemeris, onProgress?: (a: number, b: number | null) => void): Promise<LoadedEphemeris | null> => {
      calls.push(d.path);
      onProgress?.(500, 1000);
      return new Promise((res) => { release = () => res(opts.fail ? null : { name: d.name, path: d.path, header: d.header, data: new Float64Array(10) }); });
    },
  };
  const model = new AppModel(fakeCore(eph), { now: () => FAKE_J2000_MS + T0 * 1000 });
  const data: LoadedData = {
    manifest: { generatedAt: 'x', pipelineVersion: 'x', window: { startEt: T0 - 5e6, endEt: T0 + 5e6 }, products: {} },
    sources: new Map(), time: { source: 'x', leapSeconds: [], deltaTA: 0, k: 0, eb: 0, m0: 0, m1: 0 },
    ephemerides: [{ name: 'de', path: 'ephem/de.json', header: { bin: 'x', segments: [] }, data: new Float64Array(0) }],
    deferred: [deferred], orientations: [], surfaces: [],
    bodies: [body(10, 'Sun', 'star', { r: 7e5 }), body(399, 'Earth', 'planet', { r: 6400 }), body(599, 'Jupiter', 'planet', { r: 71000 }), body(501, 'Io', 'moon', { parent: 599, r: 1800 })],
    light: fakeLight(), stars: null, starNames: [], report: { products: [], notes: [] },
    loader: loader as unknown as LoadedData['loader'],
  };
  model.setData(data);
  model.setViewport({ width: 1600, height: 900, dpr: 1 });
  model.applyUrl({ tMs: FAKE_J2000_MS + T0 * 1000 });
  return { model, calls, release: () => release?.() };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('AppModel lazy moon systems', () => {
  it('bodies of a system that is not loaded have no position, are not drawn, and are listed as loading', async () => {
    const { model, release } = setupLazy();
    model.frame(0);
    expect(model.snapshot!.bodies.map((b) => b.id)).not.toContain(501);
    expect(model.bodyLoadState(501)).toBe('deferred');
    expect(model.bodyPos(501)).toBeNull();
    model.startBackgroundLoading();
    expect(model.bodyLoadState(501)).toBe('loading');
    expect(model.systems!.progress('ephem/sat-jup.json')).toBe(0.5);
    const idle = model.systemsIdle();
    release();
    await idle;
    model.frame(0);
    expect(model.bodyLoadState(501)).toBe('loaded');
    expect(model.snapshot!.bodies.map((b) => b.id)).toContain(501);
  });

  it('go-to a moon whose system is loading waits for it, then travels there', async () => {
    const { model, calls, release } = setupLazy();
    const p = model.goTo(501, 50000, { instant: true });
    expect(typeof p).not.toBe('string');
    expect(calls).toEqual(['ephem/sat-jup.json']); // requested immediately, before background loading started
    expect(model.selectedId).toBe(501);
    let done = false;
    void (p as Promise<void>).then(() => (done = true));
    await flush();
    expect(done).toBe(false);
    release();
    await flush();
    await flush();
    expect(done).toBe(true);
    model.frame(0);
    expect(model.debugState().camera).toMatchObject({ target: 501, distKm: 50000 });
  });

  it('a failed system rejects the pending go-to and says why', async () => {
    const { model, release } = setupLazy({ fail: true });
    const p = model.goTo(501) as Promise<void>;
    const caught = p.catch((e: Error) => e.message);
    release();
    expect(await caught).toMatch(/could not be loaded/);
    expect(model.bodyLoadState(501)).toBe('error');
    expect(model.goTo(501)).toMatch(/could not be loaded/);
  });

  it('selecting a moon prioritizes its system', () => {
    const { model, calls } = setupLazy();
    model.select(501);
    expect(calls).toEqual(['ephem/sat-jup.json']);
  });
});
