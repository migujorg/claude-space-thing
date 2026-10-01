// The M4 sky products (docs/architecture.md §6): the deep star tier (stars/deep.json + HEALPix tiles, fetched
// lazily, only as deep into each brightest-first tile as needed) and the all-sky maps (sky/diffuse.json:
// faintStars, diffuse, deepRemainder), the zodiacal-light model (sky/zodiacal.json) and the solar corona
// (sky/corona.json).
//
// loadAll() reads the three headers (small); SkyController (app/sky.ts) fetches the maps after the first frame
// and the tiles as the view needs them, through the same DataLoader (integrity checks, Data-panel report).

import type { CoronaModel, HealpixMapLayer, Label, Manifest, SkyMapsFile, TiledBinaryTableHeader, ZodiacalLightModel } from './schema';
import type { DataLoader } from './load';

export const DEEP_HEADER = 'stars/deep.json';
export const SKY_MAPS_HEADER = 'sky/diffuse.json';
export const ZODIACAL = 'sky/zodiacal.json';
export const CORONA = 'sky/corona.json';

export interface SkyHeaders {
  deep: TiledBinaryTableHeader | null;
  maps: SkyMapsFile | null;
  zodiacal: ZodiacalLightModel | null;
  corona: CoronaModel | null;
}

export interface SkyMaps {
  faint: Float32Array | null;
  diffuse: Float32Array | null;
  remainder: Float32Array | null;
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

function validateDeep(x: unknown): TiledBinaryTableHeader {
  if (!isObj(x) || typeof x.binPattern !== 'string' || !Array.isArray(x.tiles) || !Array.isArray(x.fields) || typeof x.stride !== 'number' || !isObj(x.tiling))
    throw new Error('expected { binPattern, stride, fields, tiling, tiles }');
  const t = x.tiling as Record<string, unknown>;
  if (t.scheme !== 'HEALPix' || t.ordering !== 'NESTED' || typeof t.order !== 'number' || !Array.isArray(t.prefixY)) throw new Error('tiling: expected HEALPix NESTED with order and prefixY');
  return x as unknown as TiledBinaryTableHeader;
}

function validateMaps(x: unknown): SkyMapsFile {
  if (!isObj(x) || !isObj(x.layers)) throw new Error('expected { layers }');
  for (const [k, l] of Object.entries(x.layers as Record<string, unknown>)) {
    if (!isObj(l) || l.scheme !== 'HEALPix' || l.ordering !== 'NESTED' || typeof l.order !== 'number' || typeof l.bin !== 'string' || l.dtype !== 'f32')
      throw new Error(`layer ${k}: expected a HEALPix NESTED f32 map`);
  }
  return x as unknown as SkyMapsFile;
}

function validateZodi(x: unknown): ZodiacalLightModel {
  if (!isObj(x) || x.kind !== 'zodiacalLightModel' || !isObj(x.cloud) || !isObj(x.scattering)) throw new Error('expected a zodiacalLightModel');
  return x as unknown as ZodiacalLightModel;
}

function validateCorona(x: unknown): CoronaModel {
  if (!isObj(x) || x.kind !== 'coronaModel' || !isObj(x.kCorona) || !isObj(x.fCorona) || !isObj(x.bSun)) throw new Error('expected a coronaModel');
  return x as unknown as CoronaModel;
}

/** Headers only (loadAll). Tile files are reported as on-demand, map binaries as deferred. */
export async function loadSkyHeaders(L: DataLoader, manifest: Manifest | null): Promise<SkyHeaders> {
  const json = (b: ArrayBuffer): unknown => JSON.parse(new TextDecoder().decode(b));
  const has = (p: string) => !manifest || !!manifest.products[p];
  const [deep, maps, zodiacal, corona] = await Promise.all([
    has(DEEP_HEADER) ? L.get(DEEP_HEADER, (b) => validateDeep(json(b)), 'No deep star tiles: stars fainter than the bright tier are not drawn as points.') : null,
    has(SKY_MAPS_HEADER) ? L.get(SKY_MAPS_HEADER, (b) => validateMaps(json(b)), 'No diffuse sky: the Milky Way glow and the faint stars are not drawn.') : null,
    has(ZODIACAL) ? L.get(ZODIACAL, (b) => validateZodi(json(b)), 'No zodiacal light.') : null,
    has(CORONA) ? L.get(CORONA, (b) => validateCorona(json(b)), 'No solar corona: near the Sun only the zodiacal-light model is drawn.') : null,
  ]);
  if (deep) {
    const tiles = deepTilePaths(deep);
    const bytes = tiles.reduce((a, p) => a + (manifest?.products[p]?.bytes ?? 0), 0);
    L.setReport(deepTilePattern(deep), { status: 'on-demand', bytes, message: `${deep.tiles.length} tiles, ${deep.count.toLocaleString('en')} stars; fetched by view direction, only as deep as the eye's limit needs.` });
  }
  if (maps) {
    for (const l of Object.values(maps.layers)) {
      const p = mapPath(l);
      L.setReport(p, { status: 'deferred', bytes: manifest?.products[p]?.bytes, message: 'Loaded in the background after the first frame.' });
    }
  }
  return { deep, maps, zodiacal, corona };
}

export const mapPath = (l: HealpixMapLayer): string => (l.bin.startsWith('sky/') ? l.bin : `sky/${l.bin}`);
export const deepTilePath = (h: TiledBinaryTableHeader, pix: number): string => `stars/${h.tiles[pix]?.bin ?? h.binPattern.replace('{pix:03d}', String(pix).padStart(3, '0'))}`;
export const deepTilePattern = (h: TiledBinaryTableHeader): string => `stars/${h.binPattern.replace('{pix:03d}', '*')}`;
export const deepTilePaths = (h: TiledBinaryTableHeader): string[] => h.tiles.map((_, i) => deepTilePath(h, i));

/** The three map binaries (integrity-checked); a layer that fails is null (and reported). */
export async function loadSkyMaps(L: DataLoader, maps: SkyMapsFile): Promise<SkyMaps> {
  const get = async (key: string, channels = 4): Promise<Float32Array | null> => {
    const l = maps.layers[key];
    if (!l) return null;
    const expect = l.npix * channels * (l.slices?.count ?? 1);
    return L.get(mapPath(l), (b) => {
      if (b.byteLength !== expect * 4) throw new Error(`${b.byteLength} bytes, expected ${expect} float32`);
      return new Float32Array(b);
    }, `${key}: not drawn.`);
  };
  const [faint, diffuse, remainder] = await Promise.all([get('faintStars'), get('diffuse'), get('deepRemainder')]);
  return { faint, diffuse, remainder };
}

// ---- deep tiles -------------------------------------------------------------------------------------

/** Loaded prefix of one tile: `count` brightest records. */
export interface DeepTile {
  pix: number;
  count: number;
  /** 7 floats per record: ux, uy, uz, X, Y, Z, S (renderer star layout). */
  stars: Float32Array;
  /** Gaia source_id as (lo, hi) uint32 words. */
  catId: Uint32Array;
  /** Labels per record: position, flux, colour (indices into labelEncoding). */
  labels: Uint8Array;
  /** posRoute, lightRoute per record. */
  routes: Uint8Array;
  flags: Uint8Array;
}

export type RangeFetch = (url: string, start: number, end: number) => Promise<{ buf: ArrayBuffer; partial: boolean }>;

/** Default range fetch: HTTP Range; a server that ignores Range (200) returns the whole file, which is sliced. */
export function httpRangeFetch(fetchFn: (url: string, init?: RequestInit) => Promise<Response> = (u, i) => fetch(u, i)): RangeFetch {
  return async (url, start, end) => {
    const res = await fetchFn(url, { headers: { Range: `bytes=${start}-${end - 1}` } });
    if (res.status === 206) return { buf: await res.arrayBuffer(), partial: true };
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const all = await res.arrayBuffer();
    return { buf: all.slice(start, end), partial: false };
  };
}

export class DeepTiles {
  private readonly tiles = new Map<number, DeepTile>();
  private readonly offsets: Record<string, number> = {};
  private readonly labelOrder: Label[];
  /** Records fetched so far (all tiles, including evicted ones). */
  fetchedBytes = 0;
  failures = 0;

  constructor(readonly header: TiledBinaryTableHeader, private readonly base: string, private readonly fetchRange: RangeFetch, private readonly onChange?: () => void) {
    for (const f of header.fields) this.offsets[f.name] = f.offset;
    for (const n of ['dir', 'xyzs', 'labelPos', 'labelFlux', 'labelColor', 'posRoute', 'lightRoute', 'flags', 'catId'])
      if (this.offsets[n] === undefined) throw new Error(`stars/deep.json: field ${n} missing`);
    if (header.stride % 4) throw new Error('stars/deep.json: stride not a multiple of 4');
    this.labelOrder = (header.labelEncoding ?? []) as Label[];
  }

  get(pix: number): DeepTile | undefined {
    return this.tiles.get(pix);
  }

  loaded(): DeepTile[] {
    return [...this.tiles.values()];
  }

  label(i: number): Label {
    return this.labelOrder[i] ?? 'unknown';
  }

  /** Records held in memory. */
  records(): number {
    let n = 0;
    for (const t of this.tiles.values()) n += t.count;
    return n;
  }

  /** Make sure the first `count` records of tile `pix` are in memory (fetches only the missing byte range). */
  async ensure(pix: number, count: number): Promise<DeepTile> {
    const meta = this.header.tiles[pix];
    const want = Math.min(count, meta.count);
    const have = this.tiles.get(pix);
    if (have && have.count >= want) return have;
    const from = have?.count ?? 0;
    const S = this.header.stride;
    const { buf } = await this.fetchRange(this.base + deepTilePath(this.header, pix), from * S, want * S);
    if (buf.byteLength !== (want - from) * S) throw new Error(`${deepTilePath(this.header, pix)}: got ${buf.byteLength} bytes, expected ${(want - from) * S}`);
    this.fetchedBytes += buf.byteLength;
    const add = this.decode(pix, buf, want - from);
    const merged = have ? concatTiles(have, add) : add;
    this.tiles.set(pix, merged);
    this.onChange?.();
    return merged;
  }

  evict(pix: number): void {
    if (this.tiles.delete(pix)) this.onChange?.();
  }

  private decode(pix: number, buf: ArrayBuffer, n: number): DeepTile {
    const S = this.header.stride;
    const f = new Float32Array(buf);
    const u32 = new Uint32Array(buf);
    const u8 = new Uint8Array(buf);
    const o = this.offsets;
    const stars = new Float32Array(n * 7);
    const catId = new Uint32Array(n * 2);
    const labels = new Uint8Array(n * 3);
    const routes = new Uint8Array(n * 2);
    const flags = new Uint8Array(n);
    const sf = S / 4;
    for (let i = 0; i < n; i++) {
      const b = i * sf;
      for (let k = 0; k < 3; k++) stars[i * 7 + k] = f[b + o.dir / 4 + k];
      for (let k = 0; k < 4; k++) stars[i * 7 + 3 + k] = f[b + o.xyzs / 4 + k];
      catId[i * 2] = u32[b + o.catId / 4];
      catId[i * 2 + 1] = u32[b + o.catId / 4 + 1];
      const r = i * S;
      labels[i * 3] = u8[r + o.labelPos];
      labels[i * 3 + 1] = u8[r + o.labelFlux];
      labels[i * 3 + 2] = u8[r + o.labelColor];
      routes[i * 2] = u8[r + o.posRoute];
      routes[i * 2 + 1] = u8[r + o.lightRoute];
      flags[i] = u8[r + o.flags];
    }
    return { pix, count: n, stars, catId, labels, routes, flags };
  }
}

function concatTiles(a: DeepTile, b: DeepTile): DeepTile {
  const cat = <T extends Float32Array | Uint32Array | Uint8Array>(x: T, y: T): T => {
    const out = new (x.constructor as new (n: number) => T)(x.length + y.length);
    out.set(x);
    out.set(y, x.length);
    return out;
  };
  return { pix: a.pix, count: a.count + b.count, stars: cat(a.stars, b.stars), catId: cat(a.catId, b.catId), labels: cat(a.labels, b.labels), routes: cat(a.routes, b.routes), flags: cat(a.flags, b.flags) };
}

/** Gaia source_id (decimal string) from its (lo, hi) uint32 words. */
export function gaiaSourceId(lo: number, hi: number): string {
  return (BigInt(hi) * 4294967296n + BigInt(lo)).toString();
}
