// The event finder on the real products, built exactly as the worker builds it (EventEngine.fromFiles: ephemeris
// files, bodies.json, orientation products). Skips, loudly, when the data is not built.
//
// References (published predictions; tolerances allow for their slightly different conventions, stated per test):
//   * Eclipses: NASA Eclipse Web Site (F. Espenak and J. Meeus, NASA GSFC), Five Millennium Canon of Solar /
//     Lunar Eclipses — greatest eclipse times are in TD (≈ TDB here), positions and durations at greatest eclipse.
//   * Saturn's equinox (the Sun crossing the ring plane): 2025 May 6; oppositions and elongations: published
//     almanac dates (e.g. USNO / the Astronomical Almanac), to the day.
//   * Near-Earth-object approaches: JPL CNEOS close-approach data, the rows in fixtures/cneos_close_approaches.json
//     (copied from the API response the pipeline downloaded; source jpl-cneos-cad).

import { describe, expect, it } from 'vitest';
import { EventEngine, type EngineInit } from '../src/app/events/engine';
import type { SkyEvent } from '../src/app/events/finder';
import type { AtmosphereFile, Body, EphemHeader, Manifest, OrientationHeader, SmallBodyCoreHeader } from '../src/data/schema';
import { DATA_DIR, ephemerisProducts, fixture, loadBodies } from './core-data';

interface Fs { existsSync(p: string): boolean; readFileSync(p: string): Uint8Array; readFileSync(p: string, e: 'utf8'): string }
const fs: Fs = await import(/* @vite-ignore */ 'node:fs' as string);

const built = fs.existsSync(DATA_DIR + 'manifest.json') && fs.existsSync(DATA_DIR + 'ephem/sat-jup.json');
if (!built) console.warn('[event tests] data not built; skipping the real-data event tests');

const DAY = 86400;
const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);
/** TDB seconds past J2000 from a TD/TDB calendar time ("2027-08-02T10:07:50"). */
const et = (td: string) => (Date.parse(`${td}Z`) - J2000_MS) / 1000;

function f64(path: string): Float64Array {
  const u8 = fs.readFileSync(DATA_DIR + path);
  const buf = new ArrayBuffer(u8.byteLength);
  new Uint8Array(buf).set(u8);
  return new Float64Array(buf);
}

function init(window?: { startEt: number; endEt: number }): EngineInit {
  const man = JSON.parse(fs.readFileSync(DATA_DIR + 'manifest.json', 'utf8')) as Manifest & { window: { startEt: number; endEt: number } };
  const ephem = ephemerisProducts()!.map((n) => {
    const header = JSON.parse(fs.readFileSync(DATA_DIR + n + '.json', 'utf8')) as EphemHeader;
    return { path: `${n}.json`, header, data: f64(header.bin) };
  });
  const orientations = Object.keys(man.products).filter((k) => /^orient\/[^/]+\.json$/.test(k)).map((path) => {
    const header = JSON.parse(fs.readFileSync(DATA_DIR + path, 'utf8')) as OrientationHeader;
    return { path, header, data: f64(header.bin) };
  });
  const bodies = loadBodies() as Body[];
  // As the app passes them: the top of each drawn atmosphere above the body's largest radius.
  const atm = fs.existsSync(DATA_DIR + 'atmospheres.json') ? (JSON.parse(fs.readFileSync(DATA_DIR + 'atmospheres.json', 'utf8')) as AtmosphereFile) : null;
  const atmospheres = Object.values(atm?.bodies ?? {}).filter((a) => a.topAltitudeKm !== null).map((a) => ({ id: a.naifId, topKm: a.topAltitudeKm! - (a.altitudesKm[0] ?? 0) }));
  return { ephem, bodies, orientations, window: window ?? man.window, atmospheres };
}

const near = (l: SkyEvent[], t: number, pred: (e: SkyEvent) => boolean = () => true) =>
  l.filter(pred).reduce<SkyEvent | null>((a, e) => (!a || Math.abs(e.et - t) < Math.abs(a.et - t) ? e : a), null)!;

describe.skipIf(!built)('event finder on the real products', () => {
  const engine = built ? EventEngine.fromFiles(init()) : null!;

  it('solar eclipses: the total eclipse of 2027-08-02 and the others in the window, as published', () => {
    const t0 = performance.now();
    const l = engine.find('eclipses').filter((e) => e.kind === 'solar-eclipse');
    const ms = performance.now() - t0;
    // 2027 Aug 02: greatest eclipse 10:07:50 TD at 25°29.5'N 33°11.2'E, gamma 0.1421, magnitude 1.0790,
    // central duration 6m23s (published with a slightly smaller lunar radius: ours is a few seconds longer).
    const e = near(l, et('2027-08-02T10:07:50'));
    expect(e.subtype).toBe('total');
    expect(Math.abs(e.et - et('2027-08-02T10:07:50'))).toBeLessThan(30);
    expect(Number(e.data!.latDeg)).toBeCloseTo(25 + 29.5 / 60, 1);
    expect(Number(e.data!.lonDeg)).toBeCloseTo(33 + 11.2 / 60, 1);
    expect(Number(e.data!.gamma)).toBeCloseTo(0.1421, 3);
    expect(Number(e.data!.magnitude)).toBeCloseTo(1.079, 2);
    expect(Math.abs(Number(e.data!.durationS) - 383)).toBeLessThan(10);
    // The second view looks at the Sun from just above the drawn atmosphere (still inside the umbra).
    const v = e.views[1];
    expect(v).toMatchObject({ target: 399, lookAt: 10, fovDeg: 6 });
    expect(Math.hypot(...v.rel) - 6378.1366).toBeGreaterThan(86);
    expect(Math.hypot(...v.rel) - 6378.1366).toBeLessThan(250);
    // The others: 2025 Sep 21 partial (magnitude 0.855), 2026 Feb 17 annular, 2026 Aug 12 total (2m18s),
    // 2027 Feb 06 annular, 2028 Jan 26 annular.
    expect(l.map((x) => [x.subtype, new Date(J2000_MS + x.et * 1000).toISOString().slice(0, 10)])).toEqual([
      ['partial', '2025-09-21'], ['annular', '2026-02-17'], ['total', '2026-08-12'], ['annular', '2027-02-06'], ['total', '2027-08-02'], ['annular', '2028-01-26'],
    ]);
    expect(Number(near(l, et('2025-09-21T19:43:04')).data!.magnitude)).toBeCloseTo(0.855, 2);
    expect(Math.abs(Number(near(l, et('2026-08-12T17:47:06')).data!.durationS) - 138)).toBeLessThan(6);
    console.log(`solar eclipses: ${l.length} in ${ms.toFixed(0)} ms; 2027-08-02 greatest ${new Date(J2000_MS + e.et * 1000).toISOString()} TDB at ${Number(e.data!.latDeg).toFixed(3)}, ${Number(e.data!.lonDeg).toFixed(3)}; ${Number(e.data!.durationS).toFixed(1)} s`);
  }, 60_000);

  it('lunar eclipses: totals of 2025-09-07 and 2026-03-03 at the published greatest eclipse', () => {
    const l = engine.find('eclipses').filter((e) => e.kind === 'lunar-eclipse');
    // Greatest eclipse 18:12:58 TD (umbral magnitude 1.362) and 11:34:52 TD (1.151). Our shadow is the geometric
    // one (published shadows are enlarged for the atmosphere), so our magnitudes are a little smaller.
    for (const [td, mag] of [['2025-09-07T18:12:58', 1.362], ['2026-03-03T11:34:52', 1.151]] as const) {
      const e = near(l, et(td));
      expect(e.subtype).toBe('total');
      expect(Math.abs(e.et - et(td))).toBeLessThan(60);
      expect(Number(e.data!.umbral)).toBeLessThan(mag);
      expect(Number(e.data!.umbral)).toBeGreaterThan(mag - 0.05);
    }
  }, 60_000);

  it('Saturn: the Sun crosses the ring plane on 2025-05-06; the rings nearly edge-on from the Earth in late 2025', () => {
    const l = engine.find('saturn');
    const eq = l.find((e) => e.subtype === 'sun-crossing')!;
    expect(Math.abs(eq.et - et('2025-05-06T12:00:00'))).toBeLessThan(DAY);
    const close = l.find((e) => e.subtype === 'earth-closest')!;
    expect(new Date(J2000_MS + close.et * 1000).toISOString().slice(0, 7)).toBe('2025-11');
    expect(Number(close.data!.earthBDeg)).toBeLessThan(0.5);
  });

  it('planets: oppositions and elongations on the published dates', () => {
    const l = engine.find('planets');
    const day = (e: SkyEvent) => new Date(J2000_MS + e.et * 1000).toISOString().slice(0, 10);
    const find = (kind: string, id: number, date: string) => l.find((e) => e.kind === kind && e.bodies.includes(id) && day(e) === date);
    expect(find('opposition', 499, '2027-02-19')).toBeTruthy(); // Mars
    expect(find('opposition', 599, '2026-01-10')).toBeTruthy(); // Jupiter
    expect(find('opposition', 699, '2025-09-21')).toBeTruthy(); // Saturn
    expect(find('conjunction', 299, '2026-10-24')?.subtype).toBe('inferior'); // Venus
    // Mercury and Venus 2° from the Sun: shown with the Sun shield.
    const mv = l.find((e) => e.kind === 'planet-pair' && e.subtype === '199-299' && day(e) === '2027-08-11')!;
    expect(Number(mv.data!.sunDeg)).toBeLessThan(5);
    expect(mv.views[0].sunShield).toBe(true);
    const gwe = find('elongation', 199, '2025-04-21')!; // Mercury, greatest western elongation 27.4°
    expect(gwe.subtype).toBe('west');
    expect(Number(gwe.data!.elongationDeg)).toBeCloseTo(27.4, 1);
  });

  it('Pluto–Charon: no mutual events in this window (the orbit is far from edge-on)', () => {
    const l = engine.find('pluto');
    expect(l).toHaveLength(1);
    expect(l[0].subtype).toBe('none');
    expect(Number(l[0].data!.closestGapKm)).toBeGreaterThan(0);
  });

  it('Galilean moons (a month on each side of the 2026-01-10 opposition): shadows lead their moons before, follow after', () => {
    const run = (a: string) => {
      const t = et(a);
      return EventEngine.fromFiles(init({ startEt: t, endEt: t + 20 * DAY })).find('jovian');
    };
    for (const [start, shadowFirst] of [['2025-11-20T00:00:00', true], ['2026-03-01T00:00:00', false]] as const) {
      const l = run(start);
      const tr = l.filter((e) => e.subtype === 'transit' && e.data?.moon === 501);
      const sh = l.filter((e) => e.subtype === 'shadow-transit' && e.data?.moon === 501);
      expect(tr.length).toBeGreaterThanOrEqual(10); // Io: every 1.77 days
      for (const s of sh) {
        const t = near(tr, s.et);
        expect(s.et < t.et).toBe(shadowFirst);
        expect(Math.abs(s.et - t.et)).toBeLessThan(DAY / 4);
      }
      for (const e of tr) expect(e.endEt! - e.startEt!).toBeGreaterThan(1.5 * 3600);
    }
  }, 120_000);

  it.skipIf(!fs.existsSync(DATA_DIR + 'smallbodies/core.json') || !fs.existsSync(DATA_DIR + 'smallbodies/names.txt'))('near-Earth objects: approaches computed from the catalogue orbits match JPL CNEOS', () => {
    const core = JSON.parse(fs.readFileSync(DATA_DIR + 'smallbodies/core.json', 'utf8')) as SmallBodyCoreHeader;
    const names = fs.readFileSync(DATA_DIR + 'smallbodies/names.txt', 'utf8').split('\n');
    const rowOf = new Map(names.map((l, i) => [l.split('\t')[1], i]));
    const u8 = fs.readFileSync(DATA_DIR + core.bin);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const off = (f: string) => core.fields.find((x) => x.name === f)!.offset;
    const fx = fixture<{ fields: string[]; data: string[][] }>('cneos_close_approaches.json');
    const I = Object.fromEntries(fx.fields.map((k, i) => [k, i]));
    const inWindow = fx.data.filter((r) => {
      const t = (Number(r[I.jd]) - 2451545) * DAY;
      return t >= core.window.startEt && t <= core.window.endEt;
    });
    expect(inWindow.length, 'CNEOS reference cases inside the built window').toBeGreaterThan(0);
    const bit = Number(Object.entries(core.flagBits).find(([, n]) => n === 'nonGravitational')![0]);
    const cands = inWindow.map((r) => {
      const row = rowOf.get(r[I.des])!;
      expect(dv.getUint16(row * core.stride + off('flags'), true) & bit).toBe(0); // no non-gravitational terms needed
      const state = [0, 1, 2].map((k) => dv.getFloat64(row * core.stride + off('pos') + 8 * k, true)).concat([0, 1, 2].map((k) => dv.getFloat64(row * core.stride + off('vel') + 8 * k, true)));
      return { row, state, ng: null, H: null };
    });
    const st = core.statistics.propagation as { closeApproachesInWindow: { maxDistanceAu: number } };
    const AU_KM = 149597870.7;
    engine.setSmallBodies({ forceModel: core.forceModel, epochEt: core.epochEt, window: core.window, maxKm: st.closeApproachesInWindow.maxDistanceAu * AU_KM, candidates: cands });
    const t0 = performance.now();
    const l = engine.find('neo');
    const ms = performance.now() - t0;
    let worstDt = 0, worstRel = 0;
    for (const r of inWindow) {
      const row = rowOf.get(r[I.des])!, body = r[I.body] === 'Earth' ? 'earth' : 'moon';
      const t = (Number(r[I.jd]) - 2451545) * DAY;
      const e = l.find((x) => x.data?.row === row && x.subtype === body && Math.abs(x.et - t) < DAY)!;
      expect(e, `${r[I.des]} ${r[I.cd]}`).toBeTruthy();
      const dist = Number(r[I.dist]) * AU_KM;
      worstDt = Math.max(worstDt, Math.abs(e.et - t));
      worstRel = Math.max(worstRel, Math.abs(Number(e.data!.distKm) - dist) / dist);
      expect(Math.abs(Number(e.data!.vRelKmS) - Number(r[I.v_rel]))).toBeLessThan(1e-3);
    }
    expect(worstDt).toBeLessThan(2);
    expect(worstRel).toBeLessThan(1e-4);
    console.log(`NEO approaches: ${cands.length} objects in ${ms.toFixed(0)} ms; vs CNEOS worst |dt| ${worstDt.toFixed(2)} s, worst |dd|/d ${worstRel.toExponential(2)}`);
  }, 120_000);
});
