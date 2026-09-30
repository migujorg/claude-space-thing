// Event finder ("Moments") on made-up geometry with known answers, the scheduling service, the result cache, the
// model's "go there" placement and first-run view, the panel's provenance helpers and the curated list.
// TEST FIXTURES ONLY: the orbits and sizes below are round numbers chosen for easy assertions.

import { describe, expect, it } from 'vitest';
import { AppModel } from '../src/app/model';
import {
  bisect, fmtDuration, Geometry, goldenMin, jovianEvents, lunarEclipses, minima, negativeIntervals, solarEclipses,
  type FinderInput, type SkyEvent,
} from '../src/app/events/finder';
import { eventBookmarks, staticBookmarks, CURATED_TUNING } from '../src/app/events/curated';
import type { Category, EngineInit } from '../src/app/events/engine';
import {
  EventService, hashKey, indexedDbCache, storageCache, type EventCache, type EventComputePort, type EventServiceHost, type FindResult, type Readiness,
} from '../src/app/events/service';
import { forwardOf } from '../src/app/camera';
import { len, norm, sub } from '../src/app/vec';
import type { Vec3 } from '../src/app/ports';
import type { LoadedData } from '../src/data/load';
import { around, eventProvenance } from '../src/ui/eventsModel';
import { rememberHintDismissed, shouldShowHint } from '../src/ui/hint';
import { body, FAKE_J2000_MS, FakeEphemerisSet, fakeCore, fakeLight } from './app-fakes';

const DAY = 86400;
const C = 299792.458;
const deg = (r: number) => (r * 180) / Math.PI;

// ---- a coplanar Sun–Earth–Moon (eclipses every new and full moon) ----------------------------------------------

const AU = 1.496e8, A_MOON = 363000;
const W_E = (2 * Math.PI) / (365.25 * DAY), W_M = (2 * Math.PI) / (27.32 * DAY);
const R_SUN = 695700, R_EARTH = 6378, R_MOON = 1737;
const earth = (t: number): Vec3 => [AU * Math.cos(W_E * t), AU * Math.sin(W_E * t), 0];
// Phase π at t = 0: the Moon between the Earth and the Sun (new moon at t ≈ 0).
const moon = (t: number): Vec3 => { const e = earth(t); return [e[0] + A_MOON * Math.cos(W_M * t + Math.PI), e[1] + A_MOON * Math.sin(W_M * t + Math.PI), 0]; };
const SYNODIC = (2 * Math.PI) / (W_M - W_E);

function sunEarthMoon(window = { startEt: -10 * DAY, endEt: 25 * DAY }): FinderInput {
  const eph = new FakeEphemerisSet({ 10: () => [0, 0, 0], 399: earth, 301: moon });
  return {
    eph,
    radii: new Map<number, Vec3>([[10, [R_SUN, R_SUN, R_SUN]], [399, [R_EARTH, R_EARTH, R_EARTH]], [301, [R_MOON, R_MOON, R_MOON]]]),
    orientation: (id) => (id === 399 ? [1, 0, 0, 0, 1, 0, 0, 0, 1] : null),
    window,
  };
}

describe('numerical tools', () => {
  it('bisection, golden section, minima and negative intervals', () => {
    expect(bisect((t) => t - 3.3, 0, 10, 1e-9)).toBeCloseTo(3.3, 8);
    expect(goldenMin((t) => (t - 2) ** 2, 0, 5, 1e-7).t).toBeCloseTo(2, 5);
    const m = minima(Math.cos, 0, 20, 0.5);
    // Time tolerance of the finder: 0.1 (seconds, in its use).
    expect(m.map((x) => x.t)).toEqual([expect.closeTo(Math.PI, 1), expect.closeTo(3 * Math.PI, 1), expect.closeTo(5 * Math.PI, 1)]);
    // (π, 2π) is found; (3π, 4π) runs past the end of the range, so it is not a complete event.
    const iv = negativeIntervals((t) => Math.sin(t), 0.1, 12, 0.5);
    expect(iv).toHaveLength(1);
    expect(iv[0].start).toBeCloseTo(Math.PI, 1);
    expect(iv[0].end).toBeCloseTo(2 * Math.PI, 1);
    // A graze between two positive samples is still found.
    const graze = negativeIntervals((t) => (t - 5.05) ** 2 - 0.001, 0, 10, 0.5);
    expect(graze).toHaveLength(1);
    expect(graze[0].min.t).toBeCloseTo(5.05, 1);
    expect(fmtDuration(383)).toBe('6 min 23 s');
  });
});

describe('solar and lunar eclipses on a coplanar Sun–Earth–Moon', () => {
  const g = new Geometry(sunEarthMoon());

  it('finds the central eclipse at new moon, with the umbra cone and the diameter ratio', () => {
    const l = solarEclipses(g);
    expect(l).toHaveLength(1);
    const e = l[0];
    expect(Math.abs(e.et)).toBeLessThan(60);
    expect(e.subtype).toBe('total');
    expect(Number(e.data!.gamma)).toBeLessThan(0.01);
    // Sub-lunar point: the Moon at A_MOON − R_EARTH, the Sun at AU − R_EARTH.
    const x = A_MOON - R_EARTH;
    const ratio = Math.asin(R_MOON / x) / Math.asin(R_SUN / (AU - R_EARTH));
    expect(Number(e.data!.magnitude)).toBeCloseTo(ratio, 3);
    const ru = R_MOON - (x * (R_SUN - R_MOON)) / (AU - A_MOON);
    expect(Number(e.data!.umbraKm)).toBeCloseTo(2 * ru, -1);
    expect(Number(e.data!.sunAltDeg)).toBeGreaterThan(89);
    // The shadow sweeps at roughly the Moon's orbital speed (the Earth does not rotate in this fixture).
    const d = Number(e.data!.durationS);
    expect(d).toBeGreaterThan((2 * ru) / (W_M * A_MOON) * 0.7);
    expect(d).toBeLessThan((2 * ru) / (W_M * A_MOON) * 1.5);
    // Views: on the shadow axis above the Earth; 1 km above the greatest-eclipse point looking at the Sun.
    expect(len(e.views[0].rel)).toBeCloseTo(4.5 * R_EARTH, -1);
    expect(e.views[1]).toMatchObject({ target: 399, lookAt: 10, fovDeg: 6 });
    expect(len(e.views[1].rel)).toBeCloseTo(R_EARTH + 1, 3);
    expect(e.orientations).toEqual([399]);
  });

  it('finds the total lunar eclipse at full moon with the geometric umbral magnitude and totality', () => {
    const l = lunarEclipses(g);
    expect(l).toHaveLength(1);
    const e = l[0];
    expect(Math.abs(e.et - SYNODIC / 2)).toBeLessThan(120);
    expect(e.subtype).toBe('total');
    const ru = R_EARTH - (A_MOON * (R_SUN - R_EARTH)) / AU;
    expect(Number(e.data!.umbral)).toBeCloseTo((ru + R_MOON) / (2 * R_MOON), 2);
    // Totality: the Moon's centre crosses 2 (ru − R_MOON) relative to the shadow axis (which turns with the Earth).
    const expected = (2 * (ru - R_MOON)) / ((W_M - W_E) * A_MOON);
    const tot = /totality (\d+) h (\d+) min/.exec(e.detail)!;
    expect(Number(tot[1]) * 3600 + Number(tot[2]) * 60).toBeCloseTo(expected, -3);
    expect(e.views[0]).toMatchObject({ target: 301, lookAt: 399 });
    expect(e.method).toMatch(/no enlargement for the atmosphere/);
  });
});

describe('Galilean-moon phenomena on a made-up Jupiter at opposition', () => {
  // Sun, Earth and "Jupiter" on the x axis (opposition); two moons on circular orbits in the x-y plane.
  const J: Vec3 = [7.8e8, 0, 0], RJ = 71492;
  const moonOrbit = (a: number, P: number, ph: number) => (t: number): Vec3 => [J[0] + a * Math.cos((2 * Math.PI * t) / P + ph), a * Math.sin((2 * Math.PI * t) / P + ph), 0];
  // Both moons in front of the planet (toward the Sun and the Earth, angle π) at t = 2 days: two shadows at once.
  const t1 = 2 * DAY, ph = (P: number) => Math.PI - (2 * Math.PI * t1) / P;
  const io = moonOrbit(421700, 1.769 * DAY, ph(1.769 * DAY)), eu = moonOrbit(671000, 3.551 * DAY, ph(3.551 * DAY));
  const inp: FinderInput = {
    eph: new FakeEphemerisSet({ 10: () => [0, 0, 0], 399: () => [1.5e8, 0, 0], 599: () => J, 501: io, 502: eu }),
    radii: new Map<number, Vec3>([[599, [RJ, RJ, RJ]], [10, [R_SUN, R_SUN, R_SUN]]]),
    orientation: () => null,
    window: { startEt: 0, endEt: 12 * DAY },
  };
  const ev = jovianEvents(new Geometry(inp));
  const of = (m: number, sub: string) => ev.filter((e) => e.data?.moon === m && e.subtype === sub);

  it('transits and occultations alternate, lasting the chord of the orbit across the disk', () => {
    const tr = of(501, 'transit'), oc = of(501, 'occultation');
    expect(tr.length).toBeGreaterThanOrEqual(6);
    expect(Math.abs(tr.length - oc.length)).toBeLessThanOrEqual(1);
    // Seen from a finite distance D the moon (a nearer to the Earth) crosses a disk shrunk by (D − a)/D.
    const D = J[0] - 1.5e8, a = 421700;
    const expected = (2 * Math.asin((RJ * (D - a)) / D / a)) / ((2 * Math.PI) / (1.769 * DAY));
    for (const e of tr) expect(Math.abs(e.endEt! - e.startEt! - expected)).toBeLessThan(1);
  });

  it('at opposition the shadow transit coincides with the transit, the eclipse with the occultation', () => {
    const tr = of(501, 'transit'), sh = of(501, 'shadow-transit'), oc = of(501, 'occultation'), ec = of(501, 'eclipse');
    expect(sh.length).toBe(tr.length);
    for (const s of sh) expect(Math.min(...tr.map((t) => Math.abs(t.et - s.et)))).toBeLessThan(20);
    for (const s of ec) expect(Math.min(...oc.map((t) => Math.abs(t.et - s.et)))).toBeLessThan(20);
    // Times are as observed at the Earth: 2000 s of light time after the moon's own time.
    expect(Math.abs(sh[0].et - tr[0].et)).toBeLessThan(20);
    expect((J[0] - 1.5e8) / C).toBeGreaterThan(2000);
  });

  it('two shadows at once lie inside both single shadow transits', () => {
    const dbl = ev.filter((e) => e.subtype === 'double-shadow');
    expect(dbl.length).toBeGreaterThan(0);
    expect(dbl.some((d) => Math.abs(d.et - 2 * DAY - (J[0] - 1.5e8) / C) < 1800)).toBe(true);
    for (const d of dbl) {
      for (const m of [501, 502]) {
        expect(of(m, 'shadow-transit').some((s) => s.startEt! <= d.startEt! + 1e-3 && s.endEt! >= d.endEt! - 1e-3)).toBe(true);
      }
    }
  });
});

// ---- the service ----------------------------------------------------------------------------------------------------

function fakeEvent(id: string, et: number, over: Partial<SkyEvent> = {}): SkyEvent {
  return { id, kind: 'planet-pair', subtype: 'x', et, title: id, detail: '', bodies: [10], observer: 'x', method: 'm', rank: 1, views: [], ...over };
}

class FakePort implements EventComputePort {
  calls: Category[] = [];
  files: string[] = [];
  sb = 0;
  pending: { c: Category; resolve: (r: FindResult) => void; reject: (e: Error) => void }[] = [];
  constructor(readonly init: EngineInit) {}
  addEphem(f: { path: string }): void { this.files.push(f.path); }
  setSmallBodies(): void { this.sb++; }
  find(c: Category, onProgress: (f: number) => void): Promise<FindResult> {
    this.calls.push(c);
    onProgress(0.5);
    return new Promise((resolve, reject) => this.pending.push({ c, resolve, reject }));
  }
  dispose(): void {}
}

function memoryStorage(): Storage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, v),
  };
}

describe('EventService', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  function make(ready: Partial<Record<Category, Readiness>>, cache: EventCache | null = null) {
    let port: FakePort | null = null;
    const host: EventServiceHost = {
      readiness: (c) => ready[c] ?? { state: 'ready' },
      engineInit: () => ({ ephem: [{ path: 'ephem/a.json', header: { bin: 'a', segments: [] }, data: new Float64Array(0) }], bodies: [], orientations: [], window: { startEt: 0, endEt: 1 } }),
      smallBodies: () => ({ forceModel: {} as never, epochEt: 0, window: { startEt: 0, endEt: 1 }, maxKm: 1, candidates: [] }),
      cacheKey: (c) => `k:${c}`,
    };
    const svc = new EventService(host, (init) => (port = new FakePort(init)), cache);
    return { svc, port: () => port!, host, ready };
  }

  it('does nothing until started, then runs one category at a time and reports progress', async () => {
    const { svc, port } = make({ jovian: { state: 'wait', why: 'Waiting for the Jupiter system.' }, neo: { state: 'no', why: 'none' } });
    expect(svc.isStarted).toBe(false);
    expect(svc.states().every((s) => s.status === 'idle')).toBe(true);
    let changes = 0;
    svc.onChange(() => changes++);
    svc.start();
    expect(port().calls).toEqual(['eclipses']);
    expect(svc.state('eclipses')).toMatchObject({ status: 'running', progress: 0.5 });
    expect(svc.state('jovian')).toMatchObject({ status: 'waiting', message: 'Waiting for the Jupiter system.' });
    expect(svc.state('neo')).toMatchObject({ status: 'unavailable', message: 'none' });
    port().pending.shift()!.resolve({ events: [fakeEvent('a', 5)], ms: 12, errors: ['bad file'] });
    await flush();
    expect(svc.state('eclipses')).toMatchObject({ status: 'ready', ms: 12, cached: false });
    expect(svc.errors).toEqual(['bad file']);
    expect(port().calls).toEqual(['eclipses', 'planets']);
    expect(changes).toBeGreaterThan(2);
    expect(svc.byId('a')?.et).toBe(5);
  });

  it('a waiting category runs once its inputs arrive; files loaded later are forwarded once', async () => {
    const { svc, port, ready } = make({ jovian: { state: 'wait', why: 'w' } });
    const p = svc.whenReady('jovian');
    for (const c of ['eclipses', 'planets', 'saturn']) {
      port().pending.shift()!.resolve({ events: [], ms: 1, errors: [] });
      await flush();
      expect(port().calls.at(-1)).not.toBe(c);
    }
    // 'pluto' is running; jovian still waits.
    expect(port().calls.at(-1)).toBe('pluto');
    ready.jovian = { state: 'ready' };
    svc.addEphem({ path: 'ephem/sat-jup.json', header: { bin: 'b', segments: [] }, data: new Float64Array(0) });
    svc.addEphem({ path: 'ephem/a.json', header: { bin: 'a', segments: [] }, data: new Float64Array(0) }); // sent at init
    expect(port().files).toEqual(['ephem/sat-jup.json']);
    port().pending.shift()!.resolve({ events: [], ms: 1, errors: [] });
    await flush();
    expect(port().calls.at(-1)).toBe('jovian');
    port().pending.shift()!.resolve({ events: [fakeEvent('j', 1)], ms: 1, errors: [] });
    expect((await p).map((e) => e.id)).toEqual(['j']);
    await flush();
    // neo: the small-body candidates are sent before its request.
    expect(port().calls.at(-1)).toBe('neo');
    expect(port().sb).toBe(1);
  });

  it('results are cached per category under the input key; a hit needs no computation', async () => {
    const st = memoryStorage();
    const cache = storageCache(() => st);
    const a = make({}, cache);
    a.svc.start();
    await flush(); // nothing cached yet: computed
    a.port().pending.shift()!.resolve({ events: [fakeEvent('e1', 1.23456789, { method: 'long method text' }), fakeEvent('e2', 2, { method: 'long method text' })], ms: 1, errors: [] });
    await flush();
    const stored = JSON.parse(st.map.get('st-events:eclipses')!);
    expect(stored.key).toBe('k:eclipses');
    expect(stored.methods).toEqual(['long method text']);
    const b = make({}, cache);
    b.svc.start();
    expect(b.svc.state('eclipses').status).toBe('reading');
    await flush();
    expect(b.svc.state('eclipses')).toMatchObject({ status: 'ready', cached: true });
    expect(b.svc.state('eclipses').events.map((e) => [e.id, e.et, e.method])).toEqual([['e1', 1.235, 'long method text'], ['e2', 2, 'long method text']]);
    expect(b.port().calls[0]).toBe('planets');
    // Another data build: a miss.
    expect(await cache.load('eclipses', 'other')).toBeNull();
    // Without IndexedDB nothing is kept, and nothing throws.
    const none = indexedDbCache(() => null);
    await none.save('eclipses', 'k', []);
    expect(await none.load('eclipses', 'k')).toBeNull();
  });

  it('failures reject waiters and do not block the queue; storage errors are swallowed', async () => {
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); } } as unknown as Storage;
    const { svc, port } = make({}, storageCache(() => broken));
    const p = svc.whenReady('eclipses');
    await flush();
    port().pending.shift()!.reject(new Error('boom'));
    await expect(p).rejects.toThrow('boom');
    await flush();
    expect(svc.state('eclipses')).toMatchObject({ status: 'error', message: 'boom' });
    expect(port().calls.at(-1)).toBe('planets');
    port().pending.shift()!.resolve({ events: [], ms: 1, errors: [] });
    await flush();
    expect(svc.state('planets').status).toBe('ready');
  });

  it('hashKey is a stable 64-bit FNV-1a', () => {
    expect(hashKey('')).toBe('cbf29ce484222325');
    expect(hashKey('a')).toBe('af63dc4c8601ec8c');
    expect(hashKey('abc')).not.toBe(hashKey('abd'));
  });
});

// ---- the model -------------------------------------------------------------------------------------------------------

const T0 = 8.4e8;
function modelSetup() {
  const shift = (f: (t: number) => Vec3) => (t: number) => f(t - T0);
  const eph = new FakeEphemerisSet({ 10: () => [0, 0, 0], 399: shift(earth), 301: shift(moon), 3: shift(earth) }, { startEt: T0 - 40 * DAY, endEt: T0 + 40 * DAY });
  const model = new AppModel(fakeCore(eph), { now: () => FAKE_J2000_MS + (T0 + 3 * DAY) * 1000 });
  const data: LoadedData = {
    manifest: { generatedAt: 'x', pipelineVersion: 'x', window: { startEt: T0 - 40 * DAY, endEt: T0 + 40 * DAY }, products: {} },
    sources: new Map(),
    time: { source: 'x', leapSeconds: [], deltaTA: 0, k: 0, eb: 0, m0: 0, m1: 0 },
    ephemerides: [{
      name: 'fake', path: 'ephem/fake.json', data: new Float64Array(0),
      header: { bin: 'fake.bin', segments: [10, 3, 399, 301].map((t) => ({ target: t, center: t === 399 || t === 301 ? 3 : 0, sources: [`src-${t}`], label: 'measured' })) as never },
    }],
    bodies: [
      body(10, 'Sun', 'star', { r: R_SUN }),
      body(399, 'Earth', 'planet', { r: R_EARTH }),
      body(301, 'Moon', 'moon', { parent: 399, r: R_MOON, rLabel: 'estimated' }),
    ],
    light: fakeLight(), stars: null, starNames: [], report: { products: [], notes: [] }, deferred: [], orientations: [], surfaces: [], loader: null,
  };
  model.setData(data);
  model.setViewport({ width: 1600, height: 900, dpr: 1 });
  return { model, eph };
}

describe('model: events, "go there" and the first-run view', () => {
  it('an orbit view jumps to the time (paused), sets the field of view and orbits the target from `rel`', async () => {
    const { model } = modelSetup();
    model.clock.play();
    const r = model.showView({ label: 'x', target: 399, rel: [0, 20000, 0], fovDeg: 6, up: [0, 0, 1] }, T0 + DAY, { instant: true });
    expect(typeof r).not.toBe('string');
    await r;
    expect(model.clock.playing).toBe(false);
    expect(model.clock.et).toBe(T0 + DAY);
    expect(deg(model.fovY)).toBeCloseTo(6, 9);
    expect(model.cam).toMatchObject({ mode: 'orbit', target: 399, dist: 20000, dir: [0, 1, 0] });
    expect(model.reality.view).toBe('eye');
  });

  it('a fixed view stays at its offset from the target and looks at `lookAt`; enhanced views say so', async () => {
    const { model } = modelSetup();
    await model.showView({ label: 'x', target: 399, rel: [R_EARTH + 1, 0, 0], lookAt: 301, up: [1, 0, 0], enhancedStops: 4 }, T0 + 2 * DAY);
    expect(model.cam).toMatchObject({ mode: 'free', anchor: 399, rel: [R_EARTH + 1, 0, 0] });
    const E = model.bodyPos(399)!, M = model.bodyPos(301)!;
    const pos: Vec3 = [E[0] + R_EARTH + 1, E[1], E[2]];
    const f = forwardOf(model.pose.orient), want = norm(sub(M, pos));
    expect(f[0] * want[0] + f[1] * want[1] + f[2] * want[2]).toBeCloseTo(1, 12);
    expect(model.selectedId).toBe(301);
    expect(model.reality).toMatchObject({ view: 'enhanced', exposureBoostStops: 4 });
    expect(model.badge().join(' ')).toMatch(/ENHANCED/);
  });

  it('a view may ask for the Sun shield; it round-trips through the URL and is badged', async () => {
    const { model } = modelSetup();
    await model.showView({ label: 'belt', target: 10, rel: [0, 0, 2e9], sunShield: true, enhancedStops: 14 }, T0, { instant: true });
    expect(model.reality).toMatchObject({ sunShield: true, view: 'enhanced', exposureBoostStops: 14 });
    const v = model.currentUrlView();
    expect(v).toMatchObject({ shield: true, view: 'enhanced', boost: 14, target: 10 });
    const b = modelSetup().model;
    b.applyUrl(v);
    expect(b.reality.sunShield).toBe(true);
    expect(b.badge()).toContain('SUN SHIELDED: occulting disc (viewing aid)');
  });

  it('first run (no URL parameters): now, playing, the Earth framed with the Moon 14° from the centre', () => {
    const { model } = modelSetup();
    model.applyUrl({});
    expect(model.firstRun).toBe(true);
    expect(model.clock.playing).toBe(true);
    expect(model.clock.et).toBeCloseTo(T0 + 3 * DAY, 3);
    expect(model.cam).toMatchObject({ mode: 'orbit', target: 399 });
    const M = model.bodyPos(301)!;
    const f = forwardOf(model.pose.orient), m = norm(sub(M, model.pose.pos));
    expect(deg(Math.acos(f[0] * m[0] + f[1] * m[1] + f[2] * m[2]))).toBeCloseTo(14, 6);
    // Any parameter: not a first run.
    const b = modelSetup().model;
    b.applyUrl({ target: 399 });
    expect(b.firstRun).toBe(false);
  });

  it('readiness per category, and the finder runs in-process on this data', async () => {
    const { model } = modelSetup();
    expect(model.eventReadiness('eclipses')).toEqual({ state: 'ready' });
    expect(model.eventReadiness('jovian')).toMatchObject({ state: 'no' });
    expect(model.eventReadiness('neo')).toMatchObject({ state: 'no', why: expect.stringMatching(/no small-body catalogue/) });
    const ev = await model.events!.whenReady('eclipses');
    // New moons at T0 + k·synodic: solar eclipses at T0 and T0 + synodic; lunar ones between.
    const solar = ev.filter((e) => e.kind === 'solar-eclipse');
    expect(solar.map((e) => Math.round((e.et - T0) / SYNODIC) + 0)).toEqual([-1, 0, 1]);
    const r = model.goToEvent(solar[1], 0, { instant: true });
    expect(typeof r).not.toBe('string');
    expect(model.clock.et).toBe(solar[1].et);
  });

  it('provenance of an event: the ephemeris chain per body, radii, and the worst label', () => {
    const { model } = modelSetup();
    const p = eventProvenance(model, { bodies: [10, 399, 301], et: T0 });
    expect(p.files).toEqual(['ephem/fake.json', 'bodies.json']);
    expect(p.sources).toEqual(expect.arrayContaining(['src-10', 'src-399', 'src-3', 'src-301', 'fixture-src']));
    // The Moon's radii are labelled estimated here: so is the event.
    expect(p.label).toBe('estimated');
    expect(eventProvenance(model, { bodies: [10, 399], et: T0 }).label).toBe('derived');
    const o = eventProvenance(model, { bodies: [399], orientations: [399], et: T0 });
    expect(o.parts.at(-1)).toMatchObject({ what: expect.stringMatching(/Earth orientation \(IAU rotation model\)/), label: 'measured', files: ['bodies.json'] });
  });
});

describe('panel helpers, curated views, first-run hint', () => {
  it('around(): the next events from a time, with some before', () => {
    const l = [5, 1, 3, 9, 7].map((t) => fakeEvent(`e${t}`, t));
    expect(around(l, 4, 2).list.map((e) => e.et)).toEqual([5, 7]);
    expect(around(l, 4, 3, 1).list.map((e) => e.et)).toEqual([3, 5, 7]);
    expect(around(l, 100, 2).list.map((e) => e.et)).toEqual([7, 9]);
  });

  it('curated list from events: the best total solar eclipse (both views), equinox, NEO …', () => {
    const v = [{ label: 'a', target: 399, rel: [1, 0, 0] as Vec3 }, { label: 'b', target: 399, rel: [2, 0, 0] as Vec3 }];
    const evs = [
      fakeEvent('s1', 100, { kind: 'solar-eclipse', subtype: 'total', rank: 100, views: v }),
      fakeEvent('s0', 50, { kind: 'solar-eclipse', subtype: 'annular', rank: 80, views: v }),
      fakeEvent('r', 10, { kind: 'ring-plane', subtype: 'sun-crossing', rank: 85, views: v }),
      fakeEvent('n1', 20, { kind: 'neo-approach', subtype: 'earth', views: v, data: { distKm: 9000 } }),
      fakeEvent('n2', 30, { kind: 'neo-approach', subtype: 'earth', views: v, data: { distKm: 7000 } }),
    ];
    const b = eventBookmarks(evs, 0);
    expect(b.map((x) => x.id)).toEqual(['s1#0', 's1#1', 'r#0', 'n2#0']);
    expect(b[0].et).toBe(100);
  });

  it('the lunar-orbit view puts the Earth just above the lunar horizon', () => {
    const inp = sunEarthMoon({ startEt: -30 * DAY, endEt: 30 * DAY });
    const bm = staticBookmarks(inp, 0).find((x) => x.id === 'static:earthrise')!;
    expect(bm).toBeTruthy();
    const g = new Geometry(inp);
    const M = g.pos(301, bm.et), E = g.pos(399, bm.et), S = g.pos(10, bm.et);
    // Half-lit Earth from the Moon: the Sun–Moon–Earth angle is 90°.
    const a = norm(sub(E, M)), s = norm(sub(S, M));
    expect(deg(Math.acos(a[0] * s[0] + a[1] * s[1] + a[2] * s[2]))).toBeCloseTo(90, 1);
    const cam: Vec3 = [M[0] + bm.view.rel[0], M[1] + bm.view.rel[1], M[2] + bm.view.rel[2]];
    const up = norm(bm.view.rel), toE = norm(sub(E, cam));
    const elev = 90 - deg(Math.acos(up[0] * toE[0] + up[1] * toE[1] + up[2] * toE[2]));
    const dip = deg(Math.acos(R_MOON / (R_MOON + CURATED_TUNING.lunarOrbitAltKm)));
    expect(elev + dip).toBeCloseTo(CURATED_TUNING.earthAboveHorizonDeg, 0);
    expect(bm.view).toMatchObject({ target: 301, lookAt: 399 });
  });

  it('the first-run hint: first runs only, until dismissed; storage failures do not hide it', () => {
    const st = memoryStorage();
    expect(shouldShowHint(false, st)).toBe(false);
    expect(shouldShowHint(true, st)).toBe(true);
    rememberHintDismissed(st);
    expect(shouldShowHint(true, st)).toBe(false);
    const broken = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } } as unknown as Storage;
    expect(shouldShowHint(true, broken)).toBe(true);
    expect(() => rememberHintDismissed(broken)).not.toThrow();
    expect(shouldShowHint(true, null)).toBe(true);
  });
});
