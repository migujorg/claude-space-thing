// Loaders for the data products in app/public/data (docs/architecture.md §6). Shapes come only from
// schema.ts. Every product is optional from the loader's point of view: a missing or broken product is
// recorded in the DataReport (shown in the Data panel) with its consequence, and the app keeps running.
//
// Ephemeris binaries can be DEFERRED (M2: one file per moon system, up to tens of MB): loadAll() then reads
// only their headers, lists them in `deferred`, and DataLoader.loadDeferred() fetches a binary later with the
// same integrity checks, updating the report in place.

import type {
  Body,
  BinaryTableHeader,
  EphemHeader,
  LightData,
  Manifest,
  OrientationHeader,
  PhotometryFile,
  SourceRecord,
  AtmosphereFile,
  RingsFile,
  ShapeIndex,
  TimeData,
} from './schema';
import { BinaryTable } from './binaryTable';
import { parseStarNames, type StarName } from './stars';
import { discoverSmallBodies, type SmallBodyProducts } from './smallbodies';
import { discoverSurfaces, parseSurfaceHeader, type SurfaceLayer } from './surfaces';
import { deepTilePaths, loadSkyHeaders, mapPath, type SkyHeaders } from './sky';

export type FetchFn = (url: string) => Promise<Response>;

/**
 * ok: loaded · missing/error: not usable · unused: listed but not read by this app version ·
 * deferred: will be fetched in the background · loading: being fetched · on-demand: fetched by the renderer when needed.
 */
export type ProductStatus = 'ok' | 'missing' | 'error' | 'unused' | 'deferred' | 'loading' | 'on-demand';
export type HashStatus = 'verified' | 'mismatch' | 'unchecked';

export interface ProductReport {
  path: string;
  status: ProductStatus;
  bytes?: number;
  hash?: HashStatus;
  /** Error text for 'error'; description for other states. */
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

/** An ephemeris whose header is loaded but whose binary is fetched later (DataLoader.loadDeferred). */
export interface DeferredEphemeris {
  name: string;
  path: string;
  binPath: string;
  header: EphemHeader;
  /** Size of the binary per the manifest, if known. */
  bytes: number | null;
  /** Bodies whose chain to the SSB needs this file (Body.ephemerisFiles, else Body.ephemeris). */
  bodies: number[];
}

export interface LoadedOrientation {
  path: string;
  header: OrientationHeader;
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
  /** Ephemerides loaded now (header + binary). */
  ephemerides: LoadedEphemeris[];
  /** Ephemerides to fetch later (header only). */
  deferred: DeferredEphemeris[];
  /** Precise orientation products (orient/*). */
  orientations: LoadedOrientation[];
  /** bodies.json with photometry.json merged in (body.photometry). */
  bodies: Body[];
  light: LightData | null;
  stars: LoadedStars | null;
  starNames: StarName[];
  /** Surface map layer headers (surfaces/<naifId>/<layer>.json); tiles are fetched on demand by the renderer. */
  surfaces: SurfaceLayer[];
  /** Small-body products (loaded in the background, DataLoader + loadSmallBodyTables); null if not built. */
  smallBodies?: SmallBodyProducts | null;
  /** rings.json: planet NAIF id (string) → ring system. */
  rings?: RingsFile | null;
  /** M4 sky headers (stars/deep.json, sky/diffuse.json, sky/zodiacal.json); maps and tiles load later (app/sky.ts). */
  sky?: SkyHeaders;
  /** atmospheres.json: optical properties for limb/sky rendering. */
  atmospheres?: AtmosphereFile | null;
  /** shapes/index.json (ShapeIndex); headers, meshes and the DAMIT table are fetched on demand (app/shapes.ts). */
  shapes?: ShapeIndex | null;
  report: DataReport;
  /** Fetches deferred products later; null when the data came from elsewhere (tests). */
  loader: DataLoader | null;
}

export interface LoadOptions {
  fetch: FetchFn;
  /** Base URL of the data directory, with trailing slash, e.g. "/data/". */
  base: string;
  verifyHashes?: boolean;
  /**
   * Which ephemeris files to load now; the others are deferred (header loaded, binary later).
   * Default: everything now.
   */
  eagerEphemeris?: (path: string, bodies: Body[]) => boolean;
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
  'rings.json': 'No ring data: planetary rings are not drawn.',
  'atmospheres.json': 'No atmosphere data: limbs, haze and Earth\'s sky are not drawn.',
  'shapes/index.json': 'No shape models: irregular bodies are drawn as triaxial ellipsoids.',
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

/** Normalizes an orientation reference ("orient/earth", "orient/earth.json") to a product path. */
export function orientPath(ref: string): string {
  return `orient/${ref.replace(/^orient\//, '').replace(/\.json$/, '')}.json`;
}

/** Every ephemeris product a body needs to reach the SSB. */
export function bodyEphemerisPaths(b: Body): string[] {
  const refs = b.ephemerisFiles?.length ? b.ephemerisFiles : b.ephemeris ? [b.ephemeris] : [];
  return refs.map(ephemPath);
}

export async function sha256Hex(buf: ArrayBuffer): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const d = new Uint8Array(await subtle.digest('SHA-256', buf));
  let s = '';
  for (const b of d) s += b.toString(16).padStart(2, '0');
  return s;
}

export type Progress = (received: number, total: number | null) => void;

/** Fetching, integrity checks and the report, shared by the initial load and deferred loads. */
export class DataLoader {
  manifest: Manifest | null = null;
  readonly report: DataReport = { products: [], notes: [] };
  private readonly reports = new Map<string, ProductReport>();
  private readonly verify: boolean;

  constructor(private readonly opts: LoadOptions) {
    this.verify = opts.verifyHashes ?? true;
  }

  /** Base URL of the data directory (products are fetched from base + path). */
  get base(): string {
    return this.opts.base;
  }

  setReport(path: string, r: Omit<ProductReport, 'path'>): void {
    const consequence = r.status === 'missing' || r.status === 'error' ? r.consequence ?? CONSEQUENCE[path] : undefined;
    this.reports.set(path, { path, ...r, ...(consequence ? { consequence } : {}) });
    this.sortReport();
  }

  has(path: string): boolean {
    return this.reports.has(path);
  }

  private sortReport(): void {
    const order = ['manifest.json', 'sources.json', 'time.json', 'bodies.json', 'photometry.json', 'light.json'];
    this.report.products = [...this.reports.values()].sort((a, b) => {
      const ia = order.indexOf(a.path), ib = order.indexOf(b.path);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.path.localeCompare(b.path);
    });
  }

  private async fetchBuf(path: string, onProgress?: Progress): Promise<ArrayBuffer> {
    let res: Response;
    try {
      res = await this.opts.fetch(this.opts.base + path);
    } catch (e) {
      throw new NotFound(String(e));
    }
    // Vite's dev server answers unknown paths with index.html (status 200): treat HTML as missing.
    const ct = res.headers.get('content-type') ?? '';
    if (res.status === 404 || ct.includes('text/html')) throw new NotFound(`${path}: not found`);
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    if (!onProgress || !res.body) return res.arrayBuffer();
    const total = Number(res.headers.get('content-length')) || this.manifest?.products[path]?.bytes || null;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    onProgress(0, total);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      onProgress(received, total);
    }
    const out = new Uint8Array(received);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.byteLength; }
    return out.buffer;
  }

  private async checkIntegrity(path: string, buf: ArrayBuffer): Promise<{ hash: HashStatus; problem?: string }> {
    const entry = this.manifest?.products[path];
    if (!entry) return { hash: 'unchecked' };
    if (entry.bytes !== buf.byteLength) return { hash: 'mismatch', problem: `size ${buf.byteLength} B ≠ manifest ${entry.bytes} B` };
    if (!this.verify || !entry.sha256) return { hash: 'unchecked' };
    const h = await sha256Hex(buf);
    if (h === null) return { hash: 'unchecked' };
    return h === entry.sha256 ? { hash: 'verified' } : { hash: 'mismatch', problem: 'sha256 differs from manifest' };
  }

  /** Fetch + integrity + parse. Returns null (and records why) on any failure. */
  async get<T>(path: string, parse: (buf: ArrayBuffer) => T, consequence?: string, onProgress?: Progress): Promise<T | null> {
    let buf: ArrayBuffer;
    try {
      buf = await this.fetchBuf(path, onProgress);
    } catch (e) {
      this.setReport(path, { status: e instanceof NotFound ? 'missing' : 'error', message: e instanceof NotFound ? undefined : String(e), consequence });
      return null;
    }
    const integ = await this.checkIntegrity(path, buf);
    if (integ.hash === 'mismatch') {
      this.setReport(path, { status: 'error', bytes: buf.byteLength, hash: 'mismatch', message: `Integrity check failed: ${integ.problem}. Product not used.`, consequence });
      return null;
    }
    try {
      const v = parse(buf);
      this.setReport(path, { status: 'ok', bytes: buf.byteLength, hash: integ.hash });
      return v;
    } catch (e) {
      this.setReport(path, { status: 'error', bytes: buf.byteLength, hash: integ.hash, message: `Could not parse: ${(e as Error).message ?? e}`, consequence });
      return null;
    }
  }

  /** Load the header + binary pair of an ephemeris now. */
  async ephemeris(path: string, header: EphemHeader, consequence: string, onProgress?: Progress): Promise<LoadedEphemeris | null> {
    const binPath = resolveBinPath(path, header.bin, this.manifest);
    const data = await this.get(binPath, toFloat64, consequence, onProgress);
    if (!data) return null;
    const need = Math.max(0, ...header.segments.map((s) => s.offset + s.n * s.rsize));
    if (data.length < need) {
      this.setReport(binPath, { status: 'error', bytes: data.byteLength, message: `has ${data.length} doubles but segments need ${need}`, consequence });
      return null;
    }
    return { name: path.replace(/^ephem\//, '').replace(/\.json$/, ''), path, header, data };
  }

  /** Fetch a deferred ephemeris binary (integrity-checked). Resolves null on failure (recorded in the report). */
  async loadDeferred(d: DeferredEphemeris, onProgress?: Progress): Promise<LoadedEphemeris | null> {
    this.setReport(d.binPath, { status: 'loading', bytes: d.bytes ?? undefined, message: 'Loading in the background.' });
    return this.ephemeris(d.path, d.header, `No positions for ${d.bodies.length} bodies of ${d.name}.`, onProgress);
  }
}

const toFloat64 = (b: ArrayBuffer) => new Float64Array(b.slice(0, b.byteLength - (b.byteLength % 8)));

export async function loadAll(opts: LoadOptions): Promise<LoadedData> {
  const L = new DataLoader(opts);
  const notes = L.report.notes;
  const json = (buf: ArrayBuffer): unknown => JSON.parse(new TextDecoder().decode(buf));

  // Manifest first: it drives integrity checks and product discovery.
  const manifest = (L.manifest = await L.get('manifest.json', (b) => validateManifest(json(b))));
  const productPaths = Object.keys(manifest?.products ?? {});

  const [sourcesArr, time, bodiesArr, photometry, light, starHeader, namesJson, rings, atmospheres] = await Promise.all([
    L.get('sources.json', (b) => validateArray<SourceRecord>(json(b), 'sources.json', (s) => typeof s.id === 'string')),
    L.get('time.json', (b) => validateTime(json(b))),
    L.get('bodies.json', (b) => validateArray<Body>(json(b), 'bodies.json', (x) => typeof x.id === 'number' && typeof x.name === 'string')),
    L.get('photometry.json', (b) => json(b) as PhotometryFile),
    L.get('light.json', (b) => validateLight(json(b))),
    L.get('stars/bright.json', (b) => json(b) as BinaryTableHeader),
    L.get('stars/names.json', (b) => json(b)),
    L.get('rings.json', (b) => json(b) as RingsFile),
    L.get('atmospheres.json', (b) => json(b) as AtmosphereFile),
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

  // Ephemerides: every file a body needs, plus every ephem/*.json in the manifest. Headers now; binaries now or deferred.
  const ephemPaths = new Set<string>();
  for (const b of bodies) for (const p of bodyEphemerisPaths(b)) ephemPaths.add(p);
  for (const p of productPaths) if (/^ephem\/[^/]+\.json$/.test(p)) ephemPaths.add(p);
  if (ephemPaths.size === 0)
    L.setReport('ephem/*.json', { status: 'missing', message: 'No ephemeris named by bodies.json or listed in the manifest.', consequence: 'No body can be positioned.' });
  const ephemerides: LoadedEphemeris[] = [];
  const deferred: DeferredEphemeris[] = [];
  const eager = opts.eagerEphemeris ?? (() => true);
  await Promise.all(
    [...ephemPaths].sort().map(async (path) => {
      const users = bodies.filter((b) => bodyEphemerisPaths(b).includes(path));
      const cons = users.length ? `No positions for: ${users.length > 12 ? `${users.length} bodies` : users.map((b) => b.name).join(', ')}.` : 'Ephemeris unavailable.';
      const header = await L.get(path, (b) => validateEphemHeader(json(b)), cons);
      if (!header) return;
      if (eager(path, bodies)) {
        const e = await L.ephemeris(path, header, cons);
        if (e) ephemerides.push(e);
      } else {
        const binPath = resolveBinPath(path, header.bin, manifest);
        const bytes = manifest?.products[binPath]?.bytes ?? null;
        deferred.push({ name: path.replace(/^ephem\//, '').replace(/\.json$/, ''), path, binPath, header, bytes, bodies: users.map((b) => b.id) });
        L.setReport(binPath, { status: 'deferred', ...(bytes !== null ? { bytes } : {}), message: `Loaded in the background after the first frame (${users.length} bodies).` });
      }
    }),
  );
  ephemerides.sort((a, b) => a.path.localeCompare(b.path));
  deferred.sort((a, b) => (a.bytes ?? 0) - (b.bytes ?? 0));

  // Precise orientation: products named by bodies plus every orient/*.json in the manifest.
  const orientPaths = new Set<string>();
  for (const b of bodies) if (b.orientation) orientPaths.add(orientPath(b.orientation));
  for (const p of productPaths) if (/^orient\/[^/]+\.json$/.test(p)) orientPaths.add(p);
  const orientations: LoadedOrientation[] = [];
  await Promise.all(
    [...orientPaths].sort().map(async (path) => {
      const users = bodies.filter((b) => b.orientation && orientPath(b.orientation) === path).map((b) => b.name);
      const cons = `${users.join(', ') || 'Bodies'} fall back to the IAU rotation model (less precise).`;
      const header = await L.get(path, (b) => validateOrientHeader(json(b)), cons);
      if (!header) return;
      const binPath = resolveBinPath(path, header.bin, manifest);
      const data = await L.get(binPath, toFloat64, cons);
      if (data) orientations.push({ path, header, data });
    }),
  );
  orientations.sort((a, b) => a.path.localeCompare(b.path));

  // Stars.
  let stars: LoadedStars | null = null;
  if (starHeader) {
    const binPath = resolveBinPath('stars/bright.json', starHeader.bin, manifest);
    const table = await L.get(binPath, (b) => new BinaryTable(starHeader, b), CONSEQUENCE['stars/bright.bin']);
    if (table) stars = { path: 'stars/bright.json', header: starHeader, table };
  }
  let starNames: StarName[] = [];
  if (namesJson != null) {
    if (!stars) notes.push('stars/names.json loaded but the star table is not available, so names cannot be used.');
    else {
      try {
        starNames = parseStarNames(namesJson, stars.table.count);
      } catch (e) {
        L.setReport('stars/names.json', { status: 'error', message: (e as Error).message, consequence: CONSEQUENCE['stars/names.json'] });
      }
    }
  }

  // Sky (M4): headers now; map binaries after the first frame, deep tiles on demand (app/sky.ts).
  const sky = await loadSkyHeaders(L, manifest);

  // Surface map layers: headers now (small), tiles on demand (aggregated in the report, one line per layer).
  const found = discoverSurfaces(manifest);
  const surfaces: SurfaceLayer[] = [];
  await Promise.all(
    found.map(async (f) => {
      const header = await L.get(f.path, (b) => json(b), `No ${f.layer} map for body ${f.bodyId}.`);
      if (header === null) return;
      try {
        surfaces.push(parseSurfaceHeader(f, header));
      } catch (e) {
        L.setReport(f.path, { status: 'error', message: (e as Error).message, consequence: `No ${f.layer} map for body ${f.bodyId}.` });
      }
      if (f.tiles.count)
        L.setReport(f.tilePattern, { status: 'on-demand', bytes: f.tiles.bytes, message: `${f.tiles.count} tiles, fetched by the renderer when needed.` });
    }),
  );
  surfaces.sort((a, b) => a.bodyId - b.bodyId || a.layer.localeCompare(b.layer));
  const tileFiles = new Set(found.flatMap((f) => f.tiles.paths));
  if (manifest?.products['surfaces/index.json']) tileFiles.add('surfaces/index.json');
  if (sky.deep) for (const p of deepTilePaths(sky.deep)) tileFiles.add(p);
  if (sky.maps) for (const l of Object.values(sky.maps.layers)) tileFiles.add(mapPath(l));

  // Shape models: the index now (small); headers, meshes and the DAMIT table on demand (app/shapes.ts, render/meshes).
  const shapes = manifest?.products['shapes/index.json'] ? await L.get('shapes/index.json', (b) => json(b) as ShapeIndex, CONSEQUENCE['shapes/index.json']) : null;
  const shapeFiles = productPaths.filter((p) => p.startsWith('shapes/') && p !== 'shapes/index.json');
  if (shapeFiles.length) {
    const bytes = shapeFiles.reduce((a, p) => a + manifest!.products[p].bytes, 0);
    L.setReport('shapes/*', { status: 'on-demand', bytes, message: `${shapeFiles.length} files: shape-model headers and meshes and the DAMIT table, fetched when a body is seen up close.` });
    for (const p of shapeFiles) tileFiles.add(p);
  }

  // Small bodies: tables load in the background after the moon systems; names are indexed when search needs them.
  const smallBodies = discoverSmallBodies(manifest);
  for (const p of smallBodies?.all ?? []) {
    const bytes = manifest!.products[p].bytes;
    if (p.endsWith('names.txt')) L.setReport(p, { status: 'on-demand', bytes, message: 'Indexed for search (in a worker) when first needed.' });
    else L.setReport(p, { status: 'deferred', bytes, message: 'Loaded in the background after the moon systems.' });
  }

  // Products the manifest lists that this app version does not read.
  for (const p of productPaths) {
    if (!L.has(p) && !tileFiles.has(p)) L.setReport(p, { status: 'unused', bytes: manifest!.products[p].bytes, message: 'Listed in the manifest; not read by this app version.' });
  }
  // Sources referenced but not defined:
  if (sources.size) {
    const missing = new Set<string>();
    const visit = (ids: string[] | undefined) => ids?.forEach((id) => { if (!sources.has(id)) missing.add(id); });
    for (const b of bodies) {
      for (const a of [b.radii, b.gm, b.rotation]) visit(a?.sources);
      if (b.photometry) for (const a of Object.values(b.photometry)) visit((a as { sources?: string[] })?.sources);
    }
    for (const e of [...ephemerides, ...deferred]) for (const s of e.header.segments) visit(s.sources);
    for (const o of orientations) for (const s of o.header.segments) visit(s.sources);
    for (const s of surfaces) visit(s.sources);
    if (sky.deep) for (const rs of Object.values(sky.deep.routes ?? {})) for (const r of rs) visit(r.sources);
    if (sky.maps) for (const l of Object.values(sky.maps.layers)) visit(l.sources);
    if (sky.zodiacal) for (const a of [sky.zodiacal.at1AU, sky.zodiacal.s10ToXYZS, sky.zodiacal.cloud, sky.zodiacal.scattering]) visit(a?.sources);
    for (const r of Object.values(rings ?? {})) {
      for (const a of [r.opticalDepth, r.opticalDepthEstimate, r.reflectance, r.components]) visit(a?.sources);
      const m = r.components?.value;
      if (m) {
        for (const c of m.components) for (const pv of Object.values(c.provenance)) visit(pv.sources);
        for (const t of Object.values(m.phaseFunctions)) visit(t.sources);
      }
    }
    if (missing.size) notes.push(`Referenced source ids missing from sources.json: ${[...missing].sort().join(', ')}.`);
  }

  return { manifest, sources, time, ephemerides, deferred, orientations, bodies, light, stars, starNames, surfaces, smallBodies, rings: rings ?? null, atmospheres: atmospheres ?? null, shapes: shapes ?? null, sky, report: L.report, loader: L };
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

function validateOrientHeader(x: unknown): OrientationHeader {
  if (!isObj(x) || typeof x.bin !== 'string' || !Array.isArray(x.segments) || !isObj(x.references) || !isObj(x.bodies))
    throw new Error('expected { bin, references, bodies, segments }');
  return x as unknown as OrientationHeader;
}

