// The event finder on the real products, built exactly as the worker builds it (EventEngine.fromFiles: ephemeris
// files, bodies.json, orientation products). Skips, loudly, when the data is not built.
//
// References (published predictions; tolerances allow for their slightly different conventions, stated per test):
//   * Eclipses: NASA Eclipse Web Site (F. Espenak and J. Meeus, NASA GSFC), Five Millennium Canon of Solar /
//     Lunar Eclipses — greatest eclipse times are in TD (≈ TDB here), positions and durations at greatest eclipse.
//   * Saturn's equinox (the Sun crossing the ring plane): 2025 May 6; oppositions and elongations: published
//     almanac dates (e.g. USNO / the Astronomical Almanac), to the day.
//   * Near-Earth-object approaches: JPL CNEOS close-approach data for this build's window, the rows the smallbodies
//     stage kept in its build record (verification/smallbodies.json closeApproaches; source jpl-cneos-cad). JPL
//     computes an approach from an orbit solution, so it is a reference for our propagation only where the
//     catalogue holds that same solution: the stage keeps rows by that rule, at build time, from the answer it
//     downloaded with the catalogue. A committed copy of such rows would go stale with the next SBDB snapshot.
//
// The published dates are fixed, the built window is not (it is centred on the day of the first build). Each
// published case is checked when the window contains it and reported as not compared when it does not.

import { describe, expect, it } from 'vitest';
import { EventEngine, type EngineInit } from '../src/app/events/engine';
import type { SkyEvent } from '../src/app/events/finder';
import type { AtmosphereFile, Body, EphemHeader, Manifest, OrientationHeader, SmallBodyCoreHeader } from '../src/data/schema';
import { DATA_DIR, buildRecord, ephemerisProducts, etDate, loadBodies, notCompared, type SmallBodyRecord } from './core-data';

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
  // (Without built data this suite is skipped, but its body still runs to list its tests: then every published
  // case is listed, as for a window that holds them all.)
  const W = built ? init().window : { startEt: et('2025-03-31T00:00:00'), endEt: et('2028-04-05T00:00:00') };
  const window = `${etDate(W.startEt)} to ${etDate(W.endEt)}`;
  const inside = (t0: number, t1 = t0) => t0 >= W.startEt && t1 <= W.endEt;
  /**
   * A published case: `when` is its TD instant ("2027-08-02T10:07:50"), its day ("2026-01-10": the whole day must
   * be in the window) or a span of days ("2025-11-01/2025-11-30"). Checked if the built window contains it.
   */
  function published(name: string, when: string, fn: () => void, timeout?: number): void {
    const [a, b] = when.split('/');
    const ok = when.includes('T') ? inside(et(when)) : inside(et(`${a}T00:00:00`), et(`${b ?? a}T00:00:00`) + DAY);
    if (ok) it(name, fn, timeout);
    else notCompared(name, `${when} is not inside the built window (${window})`);
  }
  const memo = <T,>(f: () => T) => {
    let v: T | undefined;
    return () => (v ??= f());
  };
  const eclipses = memo(() => engine.find('eclipses'));
  const solar = () => eclipses().filter((e) => e.kind === 'solar-eclipse');
  const planets = memo(() => engine.find('planets'));
  const saturn = memo(() => engine.find('saturn'));
  const day = (e: SkyEvent) => new Date(J2000_MS + e.et * 1000).toISOString().slice(0, 10);

  published('solar eclipses: the total eclipse of 2027-08-02, as published', '2027-08-02T10:07:50', () => {
    const t0 = performance.now();
    const l = solar();
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
    console.log(`solar eclipses: ${l.length} in ${ms.toFixed(0)} ms; 2027-08-02 greatest ${new Date(J2000_MS + e.et * 1000).toISOString()} TDB at ${Number(e.data!.latDeg).toFixed(3)}, ${Number(e.data!.lonDeg).toFixed(3)}; ${Number(e.data!.durationS).toFixed(1)} s`);
  }, 60_000);

  // 2025 Sep 21 partial (magnitude 0.855), 2026 Feb 17 annular, 2026 Aug 12 total (2m18s), 2027 Feb 06 annular,
  // 2027 Aug 02 total, 2028 Jan 26 annular: every solar eclipse from 2025-03-31 to 2028-04-04, the span of the
  // windows this list was compiled for and checked on. Beyond that span this test has no published list.
  const SOLAR: [string, string][] = [['partial', '2025-09-21'], ['annular', '2026-02-17'], ['total', '2026-08-12'], ['annular', '2027-02-06'], ['total', '2027-08-02'], ['annular', '2028-01-26']];
  const listed = { startEt: Math.max(W.startEt, et('2025-03-31T00:00:00')), endEt: Math.min(W.endEt, et('2028-04-04T00:00:00') + DAY) };
  if (W.startEt < listed.startEt) notCompared(`the solar eclipses found from ${etDate(W.startEt)} to 2025-03-31`, 'the published list in this test starts on 2025-03-31');
  if (W.endEt > listed.endEt) notCompared(`the solar eclipses found from 2028-04-04 to ${etDate(W.endEt)}`, 'the published list in this test ends on 2028-04-04');
  if (listed.startEt >= listed.endEt) notCompared('solar eclipses: types and dates of every one in the window', `the published list in this test covers 2025-03-31 to 2028-04-04, the built window ${window}`);
  else {
    it(`solar eclipses: every one from ${etDate(listed.startEt)} to ${etDate(listed.endEt)}, types and dates as published`, () => {
      const found = solar().filter((x) => x.et >= listed.startEt && x.et <= listed.endEt).map((x) => [x.subtype, day(x)]);
      // A published eclipse on the day of a window edge may or may not be in the window: it is left out of both.
      const edge = (d: string) => et(`${d}T00:00:00`) < listed.startEt !== et(`${d}T00:00:00`) + DAY <= listed.startEt || et(`${d}T00:00:00`) < listed.endEt !== et(`${d}T00:00:00`) + DAY <= listed.endEt;
      const want = SOLAR.filter(([, d]) => et(`${d}T00:00:00`) >= listed.startEt && et(`${d}T00:00:00`) + DAY <= listed.endEt);
      expect(found.filter(([, d]) => !edge(d as string))).toEqual(want);
    }, 60_000);
  }
  published('solar eclipses: the partial eclipse of 2025-09-21 has magnitude 0.855', '2025-09-21T19:43:04', () => {
    expect(Number(near(solar(), et('2025-09-21T19:43:04')).data!.magnitude)).toBeCloseTo(0.855, 2);
  }, 60_000);
  published('solar eclipses: totality lasts 2m18s on 2026-08-12', '2026-08-12T17:47:06', () => {
    expect(Math.abs(Number(near(solar(), et('2026-08-12T17:47:06')).data!.durationS) - 138)).toBeLessThan(6);
  }, 60_000);

  // Greatest eclipse 18:12:58 TD (umbral magnitude 1.362) and 11:34:52 TD (1.151). Our shadow is the geometric
  // one (published shadows are enlarged for the atmosphere), so our magnitudes are a little smaller.
  for (const [td, mag] of [['2025-09-07T18:12:58', 1.362], ['2026-03-03T11:34:52', 1.151]] as const) {
    published(`lunar eclipses: the total eclipse of ${td.slice(0, 10)} at the published greatest eclipse`, td, () => {
      const l = eclipses().filter((e) => e.kind === 'lunar-eclipse');
      const e = near(l, et(td));
      expect(e.subtype).toBe('total');
      expect(Math.abs(e.et - et(td))).toBeLessThan(60);
      expect(Number(e.data!.umbral)).toBeLessThan(mag);
      expect(Number(e.data!.umbral)).toBeGreaterThan(mag - 0.05);
    }, 60_000);
  }

  published('Saturn: the Sun crosses the ring plane on 2025-05-06', '2025-05-05/2025-05-07', () => {
    const eq = saturn().find((e) => e.subtype === 'sun-crossing')!;
    expect(Math.abs(eq.et - et('2025-05-06T12:00:00'))).toBeLessThan(DAY);
  });
  published('Saturn: the rings nearly edge-on from the Earth in late 2025', '2025-11-01/2025-11-30', () => {
    const close = saturn().find((e) => e.subtype === 'earth-closest')!;
    expect(new Date(J2000_MS + close.et * 1000).toISOString().slice(0, 7)).toBe('2025-11');
    expect(Number(close.data!.earthBDeg)).toBeLessThan(0.5);
  });

  // Planets: oppositions and elongations on the published dates.
  const find = (kind: string, id: number, date: string) => planets().find((e) => e.kind === kind && e.bodies.includes(id) && day(e) === date);
  published('planets: Mars at opposition on 2027-02-19', '2027-02-19', () => expect(find('opposition', 499, '2027-02-19')).toBeTruthy());
  published('planets: Jupiter at opposition on 2026-01-10', '2026-01-10', () => expect(find('opposition', 599, '2026-01-10')).toBeTruthy());
  published('planets: Saturn at opposition on 2025-09-21', '2025-09-21', () => expect(find('opposition', 699, '2025-09-21')).toBeTruthy());
  published('planets: Venus at inferior conjunction on 2026-10-24', '2026-10-24', () => expect(find('conjunction', 299, '2026-10-24')?.subtype).toBe('inferior'));
  published('planets: Mercury and Venus 2° from the Sun on 2027-08-11, shown with the Sun shield', '2027-08-11', () => {
    const mv = planets().find((e) => e.kind === 'planet-pair' && e.subtype === '199-299' && day(e) === '2027-08-11')!;
    expect(Number(mv.data!.sunDeg)).toBeLessThan(5);
    expect(mv.views[0].sunShield).toBe(true);
  });
  published('planets: Mercury at greatest western elongation (27.4°) on 2025-04-21', '2025-04-21', () => {
    const gwe = find('elongation', 199, '2025-04-21')!;
    expect(gwe.subtype).toBe('west');
    expect(Number(gwe.data!.elongationDeg)).toBeCloseTo(27.4, 1);
  });

  it('Pluto–Charon: no mutual events in this window (the orbit is far from edge-on)', () => {
    const l = engine.find('pluto');
    expect(l).toHaveLength(1);
    expect(l[0].subtype).toBe('none');
    expect(Number(l[0].data!.closestGapKm)).toBeGreaterThan(0);
  });

  // Galilean moons, 20 days a month before and after the 2026-01-10 opposition: shadows lead their moons before
  // it and follow after.
  for (const [start, end, shadowFirst] of [['2025-11-20', '2025-12-10', true], ['2026-03-01', '2026-03-21', false]] as const) {
    published(`Galilean moons from ${start}: Io's shadow ${shadowFirst ? 'leads' : 'follows'} it across Jupiter`, `${start}/${end}`, () => {
      const t = et(`${start}T00:00:00`);
      const l = EventEngine.fromFiles(init({ startEt: t, endEt: t + 20 * DAY })).find('jovian');
      const tr = l.filter((e) => e.subtype === 'transit' && e.data?.moon === 501);
      const sh = l.filter((e) => e.subtype === 'shadow-transit' && e.data?.moon === 501);
      expect(tr.length).toBeGreaterThanOrEqual(10); // Io: every 1.77 days
      for (const s of sh) {
        const t = near(tr, s.et);
        expect(s.et < t.et).toBe(shadowFirst);
        expect(Math.abs(s.et - t.et)).toBeLessThan(DAY / 4);
      }
      for (const e of tr) expect(e.endEt! - e.startEt!).toBeGreaterThan(1.5 * 3600);
    }, 120_000);
  }

  const haveSb = fs.existsSync(DATA_DIR + 'smallbodies/core.json') && fs.existsSync(DATA_DIR + 'smallbodies/names.txt');
  const rec = buildRecord<SmallBodyRecord>('verification/smallbodies.json', 'smallbodies');
  const NEO = 'near-Earth objects: approaches computed from the catalogue orbits match JPL CNEOS';
  if (!haveSb) notCompared(NEO, 'smallbodies/core is not built (a minimal-profile build)');
  else if (!rec.record) notCompared(NEO, rec.why);
  else if (rec.record.closeApproaches.value.rows.length === 0) notCompared(NEO, `JPL CNEOS lists no comparable approach in this window (${JSON.stringify(rec.record.closeApproaches.counts)})`);
  else {
    const ca = rec.record.closeApproaches.value, counts = rec.record.closeApproaches.counts;
    it(`${NEO} (${ca.rows.length} approaches of this build's window, by the build record's rule)`, () => {
      expect(rec.unbound).toEqual([]);
      const core = JSON.parse(fs.readFileSync(DATA_DIR + 'smallbodies/core.json', 'utf8')) as SmallBodyCoreHeader;
      expect(core.window, 'one build has one window: the catalogue\'s is the manifest\'s').toEqual(W);
      const names = fs.readFileSync(DATA_DIR + 'smallbodies/names.txt', 'utf8').split('\n');
      const u8 = fs.readFileSync(DATA_DIR + core.bin);
      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      const off = (f: string) => core.fields.find((x) => x.name === f)!.offset;
      const I = Object.fromEntries(ca.fields.map((k, i) => [k, i]));
      const bit = Number(Object.entries(core.flagBits).find(([, n]) => n === 'nonGravitational')![0]);
      const cands = ca.rows.map((r) => {
        const row = Number(r[I.coreRow]);
        expect(names[row].split('\t')[1], 'the record names this row').toBe(String(r[I.des]));
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
      for (const r of ca.rows) {
        const row = Number(r[I.coreRow]), body = r[I.body] === 'Earth' ? 'earth' : 'moon';
        const t = (Number(r[I.jd]) - 2451545) * DAY;
        expect(t, 'the record keeps approaches inside the window').toBeGreaterThanOrEqual(core.window.startEt);
        expect(t).toBeLessThanOrEqual(core.window.endEt);
        const e = l.find((x) => x.data?.row === row && x.subtype === body && Math.abs(x.et - t) < DAY)!;
        expect(e, `${r[I.des]} ${r[I.cd]}`).toBeTruthy();
        const dist = Number(r[I.dist]) * AU_KM;
        worstDt = Math.max(worstDt, Math.abs(e.et - t));
        worstRel = Math.max(worstRel, Math.abs(Number(e.data!.distKm) - dist) / dist);
        expect(Math.abs(Number(e.data!.vRelKmS) - Number(r[I.v_rel]))).toBeLessThan(1e-3);
      }
      expect(worstDt).toBeLessThan(2);
      expect(worstRel).toBeLessThan(1e-4);
      console.log(`NEO approaches: ${cands.length} objects (${ca.rows.map((r) => `${r[I.des]} ${r[I.cd]} ${r[I.body]}`).join('; ')}) in ${ms.toFixed(0)} ms; vs CNEOS worst |dt| ${worstDt.toFixed(2)} s, worst |dd|/d ${worstRel.toExponential(2)}; counts ${JSON.stringify(counts)}`);
    }, 120_000);
  }
});
