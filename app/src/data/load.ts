// Loaders for the data products in app/public/data (docs/architecture.md §6). Shapes come only from
// schema.ts. Every product is optional from the loader's point of view: a missing or broken product is
// recorded in the DataReport (shown in the Data panel) with its consequence, and the app keeps running.

import type {
  Body,
  BinaryTableHeader,
  EphemHeader,
  LightData,
  Manifest,
  PhotometryFile,
  SourceRecord,
  TimeData,
} from './schema';
import { BinaryTable } from './binaryTable';
import { parseStarNames, type StarName } from './stars';

export type FetchFn = (url: string) => Promise<Response>;

export type ProductStatus = 'ok' | 'missing' | 'error' | 'unused';
export type HashStatus = 'verified' | 'mismatch' | 'unchecked';

export interface ProductReport {
  path: string;
  status: ProductStatus;
  bytes?: number;
  hash?: HashStatus;
  /** Error text for 'error'. */
  message?: string;
  /** What the user loses because of this product's state (for missing/error). */
  consequence?: string;
}

export interface DataReport {
  products: ProductReport[];
  /** Other findings (e.g. photometry for an id that has no body). */
  notes: string[];
}

export interface LoadedEphemeris {
  name: string;
  path: string;
  header: EphemHeader;
  data: Float64Array;
}

export interface LoadedStars {
  path: string;
  header: BinaryTableHeader;
  table: BinaryTable;
}

export interface LoadedData {
  manifest: Manifest | null;
  sources: Map<string, SourceRecord>;
  time: TimeData | null;
  ephemerides: LoadedEphemeris[];
  /** bodies.json with photometry.json merged in (body.photometry). */
  bodies: Body[];
  light: LightData | null;
  stars: LoadedStars | null;
  starNames: StarName[];
  report: DataReport;
}

export interface LoadOptions {
  fetch: FetchFn;
  /** Base URL of the data directory, with trailing slash, e.g. "/data/". */
  base: string;
  verifyHashes?: boolean;
}

const CONSEQUENCE: Record<string, string> = {
  'manifest.json': 'Data validity window unknown (time is not clamped) and product integrity cannot be verified.',
  'sources.json': 'Source citations cannot be shown.',
  'time.json': 'No leap-second table: UTC cannot be shown or entered; time is shown as TDB seconds past J2000.',
  'bodies.json': 'No bodies: nothing but stars can be shown.',
  'photometry.json': 'No reflectance data: every surface is shown as "not measured".',
  'light.json': 'No solar spectrum: the Sun cannot be drawn and nothing is lit.',
  'stars/bright.json': 'No star background.',
  'stars/bright.bin': 'No star background.',
  'stars/names.json': 'Star names unavailable in search.',
};

class NotFound extends Error {}

/** Where a header's `bin` lives: relative to the header's directory, or already a data-root path. */
export function resolveBinPath(headerPath: string, bin: string, manifest: Manifest | null): string {
  const dir = headerPath.includes('/') ? headerPath.slice(0, headerPath.lastIndexOf('/') + 1) : '';
  const candidates = [dir && !bin.startsWith(dir) ? dir + bin : bin, bin];
  if (manifest) for (const c of candidates) if (manifest.products[c]) return c;
  return candidates[0];
}

/** Normalizes a body's `ephemeris` reference ("de440s", "ephem/de440s", "ephem/de440s.json") to a product path. */
export function ephemPath(ref: string): string {
  const name = ref.replace(/^ephem\//, '').replace(/\.json$/, '');
  return `ephem/${name}.json`;
}

export async function sha256Hex(buf: ArrayBuffer): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const d = new Uint8Array(await subtle.digest('SHA-256', buf));
  let s = '';
  for (const b of d) s += b.toString(16).padStart(2, '0');
  return s;
}

export async function loadAll(opts: LoadOptions): Promise<LoadedData> {
  const verify = opts.verifyHashes ?? true;
  const reports = new Map<string, ProductReport>();
  const notes: string[] = [];
  let manifest: Manifest | null = null;

  const report = (path: string, r: Omit<ProductReport, 'path'>) => {
    const consequence = r.status === 'missing' || r.status === 'error' ? r.consequence ?? CONSEQUENCE[path] : undefined;
    reports.set(path, { path, ...r, ...(consequence ? { consequence } : {}) });
  };

  async function fetchBuf(path: string): Promise<ArrayBuffer> {
    let res: Response;
    try {
      res = await opts.fetch(opts.base + path);
    } catch (e) {
      throw new NotFound(String(e));
    }
    // Vite's dev server answers unknown paths with index.html (status 200): treat HTML as missing.
    const ct = res.headers.get('content-type') ?? '';
    if (res.status === 404 || ct.includes('text/html')) throw new NotFound(`${path}: not found`);
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.arrayBuffer();
  }

  async function checkIntegrity(path: string, buf: ArrayBuffer): Promise<{ hash: HashStatus; problem?: string }> {
    const entry = manifest?.products[path];
    if (!entry) return { hash: 'unchecked' };
    if (entry.bytes !== buf.byteLength) return { hash: 'mismatch', problem: `size ${buf.byteLength} B ≠ manifest ${entry.bytes} B` };
    if (!verify || !entry.sha256) return { hash: 'unchecked' };
    const h = await sha256Hex(buf);
    if (h === null) return { hash: 'unchecked' };
    return h === entry.sha256 ? { hash: 'verified' } : { hash: 'mismatch', problem: 'sha256 differs from manifest' };
  }

  /** Fetch + integrity + parse. Returns null (and records why) on any failure. */
  async function get<T>(path: string, parse: (buf: ArrayBuffer) => T, consequence?: string): Promise<T | null> {
    let buf: ArrayBuffer;
    try {
      buf = await fetchBuf(path);
    } catch (e) {
      report(path, { status: e instanceof NotFound ? 'missing' : 'error', message: e instanceof NotFound ? undefined : String(e), consequence });
      return null;
    }
    const integ = await checkIntegrity(path, buf);
    if (integ.hash === 'mismatch') {
      report(path, { status: 'error', bytes: buf.byteLength, hash: 'mismatch', message: `Integrity check failed: ${integ.problem}. Product not used.`, consequence });
      return null;
    }
    try {
      const v = parse(buf);
      report(path, { status: 'ok', bytes: buf.byteLength, hash: integ.hash });
      return v;
    } catch (e) {
      report(path, { status: 'error', bytes: buf.byteLength, hash: integ.hash, message: `Could not parse: ${(e as Error).message ?? e}`, consequence });
      return null;
    }
  }

  const json = (buf: ArrayBuffer): unknown => JSON.parse(new TextDecoder().decode(buf));

  // Manifest first: it drives integrity checks and product discovery.
  manifest = await get('manifest.json', (b) => validateManifest(json(b)));

  const [sourcesArr, time, bodiesArr, photometry, light, starHeader, namesJson] = await Promise.all([
    get('sources.json', (b) => validateArray<SourceRecord>(json(b), 'sources.json', (s) => typeof s.id === 'string')),
    get('time.json', (b) => validateTime(json(b))),
    get('bodies.json', (b) => validateArray<Body>(json(b), 'bodies.json', (x) => typeof x.id === 'number' && typeof x.name === 'string')),
    get('photometry.json', (b) => json(b) as PhotometryFile),
    get('light.json', (b) => validateLight(json(b))),
    get('stars/bright.json', (b) => json(b) as BinaryTableHeader),
    get('stars/names.json', (b) => json(b)),
  ]);

  const sources = new Map<string, SourceRecord>();
  for (const s of sourcesArr ?? []) sources.set(s.id, s);

  // Photometry merge.
  const bodies = (bodiesArr ?? []).map((b) => ({ ...b }));
  if (photometry) {
    const ids = new Set(bodies.map((b) => String(b.id)));
    for (const b of bodies) {
      const p = photometry[String(b.id)];
      if (p) b.photometry = p;
    }
    for (const k of Object.keys(photometry)) if (!ids.has(k)) notes.push(`photometry.json has an entry for id ${k}, which is not in bodies.json.`);
  }

  // Ephemerides: every file named by a body, plus every ephem/*.json in the manifest.
  const ephemPaths = new Set<string>();
  for (const b of bodies) if (b.ephemeris) ephemPaths.add(ephemPath(b.ephemeris));
  for (const p of Object.keys(manifest?.products ?? {})) if (/^ephem\/[^/]+\.json$/.test(p)) ephemPaths.add(p);
  const ephemerides: LoadedEphemeris[] = [];
  await Promise.all(
    [...ephemPaths].sort().map(async (path) => {
      const served = bodies.filter((b) => b.ephemeris && ephemPath(b.ephemeris) === path).map((b) => b.name);
      const cons = served.length ? `No positions for: ${served.join(', ')}.` : 'Ephemeris unavailable.';
      const header = await get(path, (b) => validateEphemHeader(json(b)), cons);
      if (!header) return;
      const binPath = resolveBinPath(path, header.bin, manifest);
      const data = await get(binPath, (b) => new Float64Array(b.slice(0, b.byteLength - (b.byteLength % 8))), cons);
      if (!data) return;
      const need = Math.max(0, ...header.segments.map((s) => s.offset + s.n * s.rsize));
      if (data.length < need) {
        report(binPath, { status: 'error', bytes: data.byteLength, message: `has ${data.length} doubles but segments need ${need}`, consequence: cons });
        return;
      }
      ephemerides.push({ name: path.replace(/^ephem\//, '').replace(/\.json$/, ''), path, header, data });
    }),
  );
  ephemerides.sort((a, b) => a.path.localeCompare(b.path));

  // Stars.
  let stars: LoadedStars | null = null;
  if (starHeader) {
    const binPath = resolveBinPath('stars/bright.json', starHeader.bin, manifest);
    const table = await get(binPath, (b) => new BinaryTable(starHeader, b), CONSEQUENCE['stars/bright.bin']);
    if (table) stars = { path: 'stars/bright.json', header: starHeader, table };
  }
  let starNames: StarName[] = [];
  if (namesJson != null) {
    if (!stars) notes.push('stars/names.json loaded but the star table is not available, so names cannot be used.');
    else {
      try {
        starNames = parseStarNames(namesJson, stars.table.count);
      } catch (e) {
        report('stars/names.json', { status: 'error', message: (e as Error).message, consequence: CONSEQUENCE['stars/names.json'] });
      }
    }
  }

  // Products the manifest lists that this app version does not read.
  for (const p of Object.keys(manifest?.products ?? {})) {
    if (!reports.has(p)) report(p, { status: 'unused', bytes: manifest!.products[p].bytes, message: 'Listed in the manifest; not read by this app version.' });
  }
  // Manifest-listed products that the loader expected but could not read are already 'missing'/'error'.
  // Sources referenced but not defined:
  if (sources.size) {
    const missing = new Set<string>();
    const visit = (ids: string[] | undefined) => ids?.forEach((id) => { if (!sources.has(id)) missing.add(id); });
    for (const b of bodies) {
      for (const a of [b.radii, b.gm, b.rotation]) visit(a?.sources);
      if (b.photometry) for (const a of Object.values(b.photometry)) visit((a as { sources?: string[] })?.sources);
    }
    for (const e of ephemerides) for (const s of e.header.segments) visit(s.sources);
    if (missing.size) notes.push(`Referenced source ids missing from sources.json: ${[...missing].sort().join(', ')}.`);
  }

  const order = ['manifest.json', 'sources.json', 'time.json', 'bodies.json', 'photometry.json', 'light.json'];
  const products = [...reports.values()].sort((a, b) => {
    const ia = order.indexOf(a.path), ib = order.indexOf(b.path);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.path.localeCompare(b.path);
  });
  return { manifest, sources, time, ephemerides, bodies, light, stars, starNames, report: { products, notes } };
}

// ---- light validation (structure only; values are the pipeline's) -------------------------------

function isObj(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

function validateManifest(x: unknown): Manifest {
  if (!isObj(x) || !isObj(x.window) || !isObj(x.products)) throw new Error('manifest.json: expected { window, products }');
  const w = x.window as Record<string, unknown>;
  if (typeof w.startEt !== 'number' || typeof w.endEt !== 'number' || !(w.startEt < w.endEt)) throw new Error('manifest.json: bad window');
  return x as unknown as Manifest;
}

function validateArray<T>(x: unknown, what: string, ok: (e: Record<string, any>) => boolean): T[] {
  if (!Array.isArray(x)) throw new Error(`${what}: expected an array`);
  const bad = x.findIndex((e) => !isObj(e) || !ok(e as Record<string, unknown>));
  if (bad >= 0) throw new Error(`${what}: entry ${bad} is malformed`);
  return x as T[];
}

function validateTime(x: unknown): TimeData {
  if (!isObj(x) || !Array.isArray(x.leapSeconds)) throw new Error('time.json: expected { leapSeconds: [...] }');
  for (const k of ['deltaTA', 'k', 'eb', 'm0', 'm1']) if (typeof x[k] !== 'number') throw new Error(`time.json: missing number "${k}"`);
  return x as unknown as TimeData;
}

function validateLight(x: unknown): LightData {
  if (!isObj(x) || !isObj(x.sun)) throw new Error('light.json: expected { sun, cie }');
  return x as unknown as LightData;
}

function validateEphemHeader(x: unknown): EphemHeader {
  if (!isObj(x) || typeof x.bin !== 'string' || !Array.isArray(x.segments)) throw new Error('expected { bin, segments }');
  return x as unknown as EphemHeader;
}
