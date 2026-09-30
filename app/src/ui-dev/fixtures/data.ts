// ============================================================================================
//  UI-DEV FIXTURE DATA — NOT REAL. Round, made-up numbers shaped like the real data products so
//  the UI can be laid out and exercised. Every SourceRecord says FIXTURE. Served from memory by
//  fixtureFetch(); never written to app/public/data and never loaded by the real app.
// ============================================================================================

import type {
  BinaryTableHeader, Body, EphemHeader, EphemSegment, Label, LightData, Manifest, PhotometryFile, SourceRecord, Sourced, TimeData,
} from '../../data/schema';

const DAY = 86400;
const F = 'fixture';

function s<T>(value: T | null, label: Label, sources: string[], unit?: string, method?: string, uncertainty?: string): Sourced<T> {
  return {
    value: label === 'unknown' ? null : value,
    label,
    sources: label === 'unknown' ? [] : sources,
    ...(unit ? { unit } : {}),
    ...(method ? { method } : {}),
    ...(uncertainty ? { uncertainty } : {}),
  };
}

const SOURCES: SourceRecord[] = [
  { id: 'fixture-ephem', title: 'FIXTURE ephemeris — not real data', citation: 'UI development fixture: circular orbits with round numbers.', url: 'about:fixture', retrieved: '2026-09-30', version: 'fixture', notes: 'Never shipped. See app/src/ui-dev/fixtures.' },
  { id: 'fixture-pck', title: 'FIXTURE shapes and rotation — not real data', citation: 'UI development fixture.', url: 'about:fixture', retrieved: '2026-09-30', sha256: '0'.repeat(64), license: 'n/a' },
  { id: 'fixture-gm', title: 'FIXTURE GM values — not real data', citation: 'UI development fixture.', url: 'about:fixture', retrieved: '2026-09-30' },
  { id: 'fixture-photometry', title: 'FIXTURE photometry — not real data', citation: 'UI development fixture.', url: 'about:fixture', retrieved: '2026-09-30' },
  { id: 'fixture-sun', title: 'FIXTURE solar spectrum — not real data', citation: 'UI development fixture.', url: 'about:fixture', retrieved: '2026-09-30' },
  { id: 'fixture-stars', title: 'FIXTURE star field — random points, not real stars', citation: 'UI development fixture (seeded PRNG).', url: 'about:fixture', retrieved: '2026-09-30' },
];

interface BodySpec {
  id: number;
  name: string;
  kind: Body['kind'];
  parent?: number;
  center: number;
  orbit: [number, number, number, number]; // radius km, period s, phase rad, inclination rad
  radii: [number, number, number] | null;
  radiiLabel: Label;
  gm: number;
  photo?: { albedo: Label; phase: Label; pf?: 'lambert' | 'tab' | 'poly' };
}

const BODIES: BodySpec[] = [
  { id: 10, name: 'Sun', kind: 'star', center: 0, orbit: [0, 1, 0, 0], radii: [700000, 700000, 700000], radiiLabel: 'measured', gm: 1.3e11 },
  { id: 199, name: 'Mercury', kind: 'planet', center: 0, orbit: [5.8e7, 88 * DAY, 0.4, 0.12], radii: [2400, 2400, 2400], radiiLabel: 'measured', gm: 2.2e4, photo: { albedo: 'derived', phase: 'measured', pf: 'poly' } },
  { id: 299, name: 'Venus', kind: 'planet', center: 0, orbit: [1.08e8, 225 * DAY, 2.1, 0.06], radii: [6000, 6000, 6000], radiiLabel: 'measured', gm: 3.2e5, photo: { albedo: 'derived', phase: 'estimated' } },
  { id: 399, name: 'Earth', kind: 'planet', center: 0, orbit: [1.5e8, 365 * DAY, 1.0, 0], radii: [6400, 6400, 6350], radiiLabel: 'measured', gm: 4e5, photo: { albedo: 'derived', phase: 'measured', pf: 'tab' } },
  { id: 301, name: 'Moon', kind: 'moon', parent: 399, center: 399, orbit: [3.8e5, 27 * DAY, 0.3, 0.09], radii: [1700, 1700, 1700], radiiLabel: 'measured', gm: 4900, photo: { albedo: 'measured', phase: 'measured', pf: 'tab' } },
  { id: 499, name: 'Mars', kind: 'planet', center: 0, orbit: [2.3e8, 687 * DAY, 4.0, 0.03], radii: [3400, 3400, 3380], radiiLabel: 'measured', gm: 4.3e4, photo: { albedo: 'estimated', phase: 'estimated' } },
  { id: 401, name: 'Phobos', kind: 'moon', parent: 499, center: 499, orbit: [9400, 0.32 * DAY, 0, 0.02], radii: [13, 11, 9], radiiLabel: 'estimated', gm: 7e-4 },
  { id: 599, name: 'Jupiter', kind: 'planet', center: 0, orbit: [7.8e8, 4330 * DAY, 5.2, 0.02], radii: [71500, 71500, 66900], radiiLabel: 'measured', gm: 1.27e8, photo: { albedo: 'derived', phase: 'measured', pf: 'poly' } },
  { id: 501, name: 'Io', kind: 'moon', parent: 599, center: 599, orbit: [4.2e5, 1.77 * DAY, 1.2, 0], radii: [1800, 1800, 1800], radiiLabel: 'measured', gm: 5960, photo: { albedo: 'measured', phase: 'unknown' } },
  { id: 999, name: 'Pluto', kind: 'dwarf-planet', center: 0, orbit: [5.9e9, 90000 * DAY, 3.3, 0.3], radii: [1200, 1200, 1200], radiiLabel: 'measured', gm: 870 },
  { id: 5, name: 'Jupiter barycenter', kind: 'barycenter', center: 0, orbit: [0, 1, 0, 0], radii: null, radiiLabel: 'unknown', gm: 1.27e8 },
  // A crowd of fixture irregular moons of unknown size and brightness (exercise decluttering).
  ...Array.from({ length: 40 }, (_, i): BodySpec => ({
    id: 55000 + i, name: `S/Fixture J ${i + 1}`, kind: 'moon', parent: 599, center: 599,
    orbit: [1e7 + i * 5e5, (500 + i * 20) * DAY, i * 0.7, 0.3 + (i % 7) * 0.35], radii: null, radiiLabel: 'unknown', gm: 0,
  })),
];

const ROT = (w1: number) => ({ poleRa: [0, 0, 0], poleDec: [90, 0, 0], pm: [10, w1] });

export interface FixtureOptions {
  /** Extra delay (ms) before serving moon-system binaries, to watch lazy loading. */
  slowSystemsMs?: number;
  /** Products to leave out (e.g. to see the Data panel's "missing" state). */
  omit?: string[];
  /** "now" in fixture ET, for the window. */
  nowEt: number;
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildFixtureFiles(o: FixtureOptions): { files: Map<string, Uint8Array>; window: Manifest['window'] } {
  const window = { startEt: Math.round(o.nowEt - 548 * DAY), endEt: Math.round(o.nowEt + 548 * DAY) };
  const enc = (x: unknown) => new TextEncoder().encode(JSON.stringify(x, null, 1));
  const files = new Map<string, Uint8Array>();

  const time: TimeData = { source: 'fixture', leapSeconds: [], deltaTA: 0, k: 0, eb: 0, m0: 0, m1: 0 };

  // Ephemeris: one fixture "SPK" with a 4-double record per segment.
  // Planets in the "planetary" fixture file; each planet's moons (and, as in the real data, the planet
  // centre relative to its barycenter is NOT modelled here) in a per-system file loaded lazily.
  const fileOf = (b: BodySpec) => (b.center === 499 ? 'sat-mar' : b.center === 599 ? 'sat-jup' : 'fixture');
  const ephFiles = new Map<string, { segs: EphemSegment[]; data: number[] }>();
  for (const b of BODIES) {
    const f = fileOf(b);
    let e = ephFiles.get(f);
    if (!e) ephFiles.set(f, (e = { segs: [], data: [] }));
    e.segs.push({ target: b.id, center: b.center, frame: 'J2000', type: 2, initEt: window.startEt, intLen: window.endEt - window.startEt, rsize: 4, n: 1, offset: e.data.length, sources: ['fixture-ephem'], label: 'measured' });
    e.data.push(...b.orbit);
  }

  const bodies: Body[] = BODIES.map((b) => ({
    id: b.id,
    name: b.name,
    kind: b.kind,
    ...(b.parent !== undefined ? { parent: b.parent } : {}),
    ephemeris: `ephem/${fileOf(b)}`,
    ephemerisFiles: fileOf(b) === F ? [`ephem/${F}`] : [`ephem/${fileOf(b)}`, `ephem/${F}`],
    radii: s(b.radii, b.radii ? b.radiiLabel : 'unknown', ['fixture-pck'], 'km', b.radiiLabel === 'estimated' ? 'FIXTURE: size from brightness with an assumed albedo.' : 'FIXTURE: triaxial radii.', b.radiiLabel === 'estimated' ? '±30% (fixture)' : '±1 km (fixture)'),
    gm: s(b.gm, b.gm ? 'measured' : 'unknown', ['fixture-gm'], 'km^3/s^2', 'FIXTURE value.'),
    rotation: s(ROT(b.id === 10 ? 14 : 360), b.kind === 'barycenter' || !b.radii ? 'unknown' : 'measured', ['fixture-pck'], undefined, 'FIXTURE rotation model.'),
  }));

  const photometry: PhotometryFile = {};
  for (const b of BODIES) {
    if (!b.photo) continue;
    const pf =
      b.photo.pf === 'tab'
        ? { kind: 'tabulated' as const, alphaDeg: [0, 30, 60, 90, 120, 150], deltaMag: [0, 0.4, 0.9, 1.5, 2.3, 3.4] }
        : b.photo.pf === 'poly'
          ? { kind: 'poly-mag' as const, coeffs: [0, 0.02, 1e-4], minDeg: 2, maxDeg: 170 }
          : { kind: 'lambert' as const };
    photometry[String(b.id)] = {
      geometricAlbedoXYZS: s<[number, number, number, number]>([100, 100, 90, 80], b.photo.albedo, ['fixture-photometry'], 'lux at 1 AU', 'FIXTURE: albedo spectrum × solar spectrum × CIE observers.'),
      geometricAlbedoV: s(0.3, b.photo.albedo, ['fixture-photometry'], undefined, 'FIXTURE.'),
      phaseFunction: s(pf, b.photo.phase, ['fixture-photometry'], undefined, b.photo.phase === 'estimated' ? 'FIXTURE: assumed Lambert sphere (a modeling assumption).' : 'FIXTURE phase curve.'),
    };
  }

  const light: LightData = {
    sun: {
      irradianceXYZS_1AU: s<[number, number, number, number]>([1e5, 1e5, 1e5, 2e5], 'derived', ['fixture-sun'], 'lux', 'FIXTURE: spectrum integrated against CIE observers.'),
      radius: s(700000, 'measured', ['fixture-sun'], 'km'),
      limbDarkening: s({ kind: 'poly-mu' as const, coeffsXYZS: [[0.3, 0.7], [0.3, 0.7], [0.3, 0.7], [0.3, 0.7]] }, 'measured', ['fixture-sun']),
    },
    cie: { photopicKm: 1, scotopicKm: 1, sources: ['fixture-sun'] },
  };

  // Stars: random directions and brightnesses (seeded), a few with an 'estimated' label.
  const N = 600, stride = 32;
  const starBuf = new ArrayBuffer(N * stride);
  const dv = new DataView(starBuf);
  const rnd = mulberry32(42);
  for (let i = 0; i < N; i++) {
    const z = 2 * rnd() - 1, ph = 2 * Math.PI * rnd(), r = Math.sqrt(1 - z * z);
    const E = Math.pow(10, -9 + 4.5 * Math.pow(rnd(), 3));
    const tint = 0.7 + 0.6 * rnd();
    [r * Math.cos(ph), r * Math.sin(ph), z, E * tint, E, E * (2 - tint), E * 1.5].forEach((v, k) => dv.setFloat32(i * stride + 4 * k, v, true));
    dv.setUint8(i * stride + 28, rnd() < 0.05 ? 2 : 0);
  }
  const starHeader: BinaryTableHeader = {
    bin: 'fixture-stars.bin', count: N, stride,
    fields: [{ name: 'dir', type: 'f32', count: 3, offset: 0 }, { name: 'xyzs', type: 'f32', count: 4, offset: 12 }, { name: 'illumLabel', type: 'u8', count: 1, offset: 28 }],
    labelEncoding: ['measured', 'derived', 'estimated', 'synthetic', 'unknown'],
    sourceTable: ['fixture-stars'],
    notes: 'FIXTURE',
  };
  const names = [0, 1, 2, 3, 4].map((i) => ({ name: `Fixture Star ${'ABCDE'[i]}`, index: i * 7 }));

  files.set('sources.json', enc(SOURCES));
  files.set('time.json', enc(time));
  files.set('bodies.json', enc(bodies));
  files.set('photometry.json', enc(photometry));
  files.set('light.json', enc(light));
  for (const [name, e] of ephFiles) {
    const header: EphemHeader = { bin: `ephem/${name}.bin`, segments: e.segs };
    files.set(`ephem/${name}.json`, enc(header));
    files.set(`ephem/${name}.bin`, new Uint8Array(new Float64Array(e.data).buffer));
  }
  files.set('stars/bright.json', enc(starHeader));
  files.set('stars/fixture-stars.bin', new Uint8Array(starBuf));
  files.set('stars/names.json', enc(names));
  for (const p of o.omit ?? []) files.delete(p);
  return { files, window };
}

async function sha256(b: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', b as Uint8Array<ArrayBuffer>));
  return Array.from(d, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** A fetch() that serves the fixture products (plus a manifest with real hashes of them) from memory. */
export async function fixtureFetch(o: FixtureOptions): Promise<(url: string) => Promise<Response>> {
  const { files, window } = buildFixtureFiles({ ...o, omit: [] });
  const products: Manifest['products'] = {};
  for (const [p, b] of files) products[p] = { path: p, bytes: b.byteLength, sha256: await sha256(b), stage: 'fixture' };
  const manifest: Manifest = { generatedAt: new Date().toISOString(), pipelineVersion: 'FIXTURE', window, products };
  files.set('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)));
  for (const p of o.omit ?? []) files.delete(p);
  return async (url: string) => {
    const path = url.replace(/^.*?fixture-data\//, '');
    const b = files.get(path);
    await new Promise((r) => setTimeout(r, /^ephem\/sat-.*\.bin$/.test(path) ? 5 + (o.slowSystemsMs ?? 0) : 5));
    if (!b) return new Response('not found', { status: 404 });
    return new Response(new Blob([b as Uint8Array<ArrayBuffer>]), { status: 200, headers: { 'content-type': path.endsWith('.json') ? 'application/json' : 'application/octet-stream' } });
  };
}
