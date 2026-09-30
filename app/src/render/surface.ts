// Surface-map virtual texturing (docs/rendering-m2.md §1, architecture §4.4), GPU-agnostic parts:
// pyramid addressing, the level-of-detail rule shared with the WGSL body shader, the CPU footprint
// sampler that decides which tiles a frame needs, and the tile cache (fetch queue, LRU pages, strict
// budget, page-table updates). renderer.ts supplies the GPU page store.
//
// Pyramid (the §4.4 contract): level L is 512·2^L × 256·2^L texels in 2^(L+1) × 2^L tiles of 256².
// u = (lon_E + 180°)/360°, v = (90° − lat)/180°, planetocentric latitude in the IAU body-fixed frame.
// Page table: for each layer, one u32 per tile of levels 0..L_max, level-major; entry = page + 1, or 0
// when the tile is not resident (the shader then falls back to the coarser level).

import type { SurfaceLayerRef } from './scene';
import { farHit, nearHit, mulMV, normalize, type BodyFrame, type M3, type V3 } from './raycast';
import type { CameraGeom } from './overlays';
import type { ZonalProfile } from './spatial';

export const TILE = 256;
/** Finest level the renderer addresses (page-table size grows as 4^L; 10 ≈ 40 m/texel on Mars). */
export const MAX_ADDRESSED_LEVEL = 10;
/** Unit-cosine floor of the footprint's foreshortening term (grazing views). */
export const FORESHORTEN_MIN_MU = 0.05;

/**
 * Tile formats (one page atlas each): 'albedo' float16 XYZS; 'height' float32 metres; 'clouds' float16 ×4
 * (Earth's cloud-properties layer); 'rg16' float16 ×2 (Earth's surface-water and emitted-radiance layers).
 */
export type LayerFormat = 'albedo' | 'height' | 'clouds' | 'rg16';
export const TILE_BYTES: Record<LayerFormat, number> = { albedo: TILE * TILE * 8, height: TILE * TILE * 4, clouds: TILE * TILE * 8, rg16: TILE * TILE * 4 };

/** Header format each tile format decodes (channels: exact names, or a count when names vary by layer). */
const LAYER_FORMATS: Record<LayerFormat, { format: string; channels: string[] | number; bytes: number }> = {
  albedo: { format: 'float16', channels: ['X', 'Y', 'Z', 'S'], bytes: 8 },
  height: { format: 'float32', channels: 1, bytes: 4 },
  clouds: { format: 'float16', channels: ['cloudFraction', 'opticalThickness', 'cloudTopHeightM', 'iceFraction'], bytes: 8 },
  rg16: { format: 'float16', channels: 2, bytes: 4 },
};

export const tilesX = (L: number) => 2 << L;
export const tilesY = (L: number) => 1 << L;
/** Page-table offset of level L within a layer: Σ_{l<L} 2^(2l+1) = 2(4^L − 1)/3. */
export const levelOffset = (L: number) => (2 * (4 ** L - 1)) / 3;
export const layerEntries = (maxLevel: number) => levelOffset(maxLevel + 1);
export const tileIndex = (L: number, tx: number, ty: number) => levelOffset(L) + ty * tilesX(L) + tx;

/**
 * Pyramid level whose texel best matches a surface footprint (km) on a body of mean radius R:
 * equatorial texel size at level L is 2πR/(512·2^L). Mirrored in WGSL (`surfLevel`).
 */
export function levelForFootprint(radiusKm: number, footprintKm: number, maxLevel: number): number {
  const l = Math.floor(Math.log2((2 * Math.PI * radiusKm) / (512 * Math.max(footprintKm, 1e-9))) + 0.5);
  return Math.max(0, Math.min(maxLevel, l));
}

/** Surface footprint of one pixel, km: pixel angle × range, stretched by 1/√μ for foreshortening. */
export function pixelFootprintKm(pixelAngle: number, rangeKm: number, mu: number): number {
  return (pixelAngle * rangeKm) / Math.sqrt(Math.max(mu, FORESHORTEN_MIN_MU));
}

/** (u, v) of a body-fixed direction (x toward lon 0, z north). */
export function uvOf(p: V3): [number, number] {
  const lon = Math.atan2(p[1], p[0]);
  const lat = Math.atan2(p[2], Math.hypot(p[0], p[1]));
  return [(lon + Math.PI) / (2 * Math.PI), (Math.PI / 2 - lat) / Math.PI];
}

export function tileOf(L: number, u: number, v: number): [number, number] {
  const W = 512 << L, H = 256 << L;
  const i = Math.min(W - 1, Math.max(0, Math.floor(u * W)));
  const j = Math.min(H - 1, Math.max(0, Math.floor(v * H)));
  return [Math.floor(i / TILE), Math.floor(j / TILE)];
}

export interface TileRequest {
  L: number;
  tx: number;
  ty: number;
  /** Lower = more urgent. */
  priority: number;
}

/**
 * Tiles a body needs this frame: rays are cast (float64) through a grid of screen samples every
 * `stepPx` pixels over the body's screen footprint; each hit picks its level with the same rule as the
 * shader. Every needed tile brings its ancestors (the shader's fallback) and all of level 0.
 *
 * @param bodyToWorld body-fixed → ICRF rotation (row-major), i.e. SceneBody.orient
 */
export function footprintTiles(b: BodyFrame, bodyToWorld: M3, g: CameraGeom, maxLevel: number, stepPx = 24): TileRequest[] {
  const Lmax = Math.min(maxLevel, MAX_ADDRESSED_LEVEL);
  const R = Math.cbrt(b.radii[0] * b.radii[1] * b.radii[2]);
  const fwd: V3 = [-g.back[0], -g.back[1], -g.back[2]];
  // Screen rectangle to sample: whole screen for NEAR, else the projected bounding circle.
  let x0 = 0, x1 = g.W, y0 = 0, y1 = g.H;
  if (!b.near) {
    const c: V3 = [b.n[0] * b.D, b.n[1] * b.D, b.n[2] * b.D];
    const zc = -(c[0] * g.back[0] + c[1] * g.back[1] + c[2] * g.back[2]);
    if (zc <= 0) return [];
    const px = (c[0] * g.right[0] + c[1] * g.right[1] + c[2] * g.right[2]) / (g.tanX * zc);
    const py = (c[0] * g.up[0] + c[1] * g.up[1] + c[2] * g.up[2]) / (g.tanY * zc);
    const rNdcX = b.beta / g.tanX, rNdcY = b.beta / g.tanY;
    x0 = Math.max(0, ((px - rNdcX + 1) / 2) * g.W); x1 = Math.min(g.W, ((px + rNdcX + 1) / 2) * g.W);
    y0 = Math.max(0, ((1 - (py + rNdcY)) / 2) * g.H); y1 = Math.min(g.H, ((1 - (py - rNdcY)) / 2) * g.H);
    if (x1 <= x0 || y1 <= y0) return [];
  }
  const want = new Map<number, TileRequest>();
  const add = (L: number, tx: number, ty: number, pr: number) => {
    const k = tileIndex(L, tx, ty);
    const cur = want.get(k);
    if (!cur || cur.priority > pr) want.set(k, { L, tx, ty, priority: pr });
  };
  const nx = Math.max(2, Math.ceil((x1 - x0) / stepPx) + 1), ny = Math.max(2, Math.ceil((y1 - y0) / stepPx) + 1);
  const cxs = g.W / 2, cys = g.H / 2;
  const Rt = bodyToWorld;
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const sx = x0 + ((x1 - x0) * ix) / (nx - 1), sy = y0 + ((y1 - y0) * iy) / (ny - 1);
      const ndcX = (sx / g.W) * 2 - 1, ndcY = 1 - (sy / g.H) * 2;
      const dirW: V3 = [
        g.right[0] * ndcX * g.tanX + g.up[0] * ndcY * g.tanY + fwd[0],
        g.right[1] * ndcX * g.tanX + g.up[1] * ndcY * g.tanY + fwd[1],
        g.right[2] * ndcX * g.tanX + g.up[2] * ndcY * g.tanY + fwd[2],
      ];
      let hit, rangeKm;
      if (b.near) {
        hit = nearHit(b, dirW);
        rangeKm = hit.t * Math.hypot(...dirW);
      } else {
        const dn = dirW[0] * b.n[0] + dirW[1] * b.n[1] + dirW[2] * b.n[2];
        if (dn <= 0) continue;
        const x = (dirW[0] * b.e1[0] + dirW[1] * b.e1[1] + dirW[2] * b.e1[2]) / dn;
        const y = (dirW[0] * b.e2[0] + dirW[1] * b.e2[1] + dirW[2] * b.e2[2]) / dn;
        hit = farHit(b, x, y);
        rangeKm = hit.t * Math.hypot(1, x, y);
      }
      if (hit.disc < 0 || !(hit.t > 0)) continue;
      // Body-fixed point (km) and its outward normal.
      const pbf: V3 = [hit.h[0] * b.radii[0], hit.h[1] * b.radii[1], hit.h[2] * b.radii[2]];
      const nbf = normalize([pbf[0] / b.radii[0] ** 2, pbf[1] / b.radii[1] ** 2, pbf[2] / b.radii[2] ** 2]);
      const nW = mulMV(Rt, nbf);
      const dl = Math.hypot(...dirW);
      const mu = -(nW[0] * dirW[0] + nW[1] * dirW[1] + nW[2] * dirW[2]) / dl;
      const L = levelForFootprint(R, pixelFootprintKm(g.pixelAngle, rangeKm, mu), Lmax);
      const [u, v] = uvOf(pbf);
      const pr = Math.hypot(sx - cxs, sy - cys) / Math.hypot(cxs, cys);
      for (let l = L; l >= 0; l--) {
        const [tx, ty] = tileOf(l, u, v);
        add(l, tx, ty, l + pr);
      }
    }
  }
  add(0, 0, 0, -1);
  add(0, 1, 0, -1);
  return [...want.values()].sort((a, c) => a.priority - c.priority);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Tile cache
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** GPU side of one cache (one texture atlas + the shared page table), supplied by the renderer. */
export interface PageStore {
  readonly pages: number;
  upload(page: number, data: ArrayBuffer): void;
  setEntry(index: number, value: number): void;
}

/**
 * URL of tile (L, ty, tx) of a layer: the pipeline header's `tilePath` template (relative to the data
 * root `ref.url`), or `${url}/${L}/${ty}/${tx}.bin` for headers without one (fixtures).
 */
export function tileUrl(ref: SurfaceLayerRef, L: number, ty: number, tx: number): string {
  const t = ref.header.tilePath;
  if (!t) return `${ref.url}/${L}/${ty}/${tx}.bin`;
  const path = t.replace('{level}', String(L)).replace('{ty}', String(ty)).replace('{tx}', String(tx));
  return `${ref.url.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** Identity of a layer in the cache (several layers share one data root). */
export function layerKey(ref: SurfaceLayerRef): string {
  return ref.header.tilePath ? `${ref.url}|${ref.header.tilePath}` : ref.url;
}

/**
 * Why a layer header cannot be decoded as `format` (LAYER_FORMATS; `channels` overrides the expected
 * channel names), or null when it can (or the header does not say, as in the fixtures).
 */
export function layerFormatProblem(ref: SurfaceLayerRef, format: LayerFormat, channels?: string[]): string | null {
  const h = ref.header;
  const want = { ...LAYER_FORMATS[format], ...(channels ? { channels } : {}) };
  if (h.format !== undefined && h.format !== want.format) return `${format} layer stored as ${h.format}, renderer decodes ${want.format}`;
  if (h.bytesPerTexel !== undefined && h.bytesPerTexel !== want.bytes) return `${format} layer has ${h.bytesPerTexel} bytes per texel, expected ${want.bytes}`;
  if (h.channels !== undefined) {
    const ok = Array.isArray(want.channels) ? want.channels.join() === h.channels.join() : h.channels.length === want.channels;
    if (!ok) return `${format} layer channels [${h.channels.join(', ')}] not the expected ones`;
  }
  if (h.tileSize !== undefined && h.tileSize !== 256) return `${format} layer tile size ${h.tileSize}, expected 256`;
  if (h.minLevel !== undefined && h.minLevel !== 0) return `${format} layer starts at level ${h.minLevel}, expected 0`;
  return null;
}

export type Fetcher = (url: string) => Promise<ArrayBuffer | null>;

/** Default fetcher: 404 (or any non-OK status) → null, i.e. the tile is absent. */
export const httpFetcher: Fetcher = async (url) => {
  const r = await fetch(url);
  if (!r.ok) return null;
  return r.arrayBuffer();
};

interface Layer {
  ref: SurfaceLayerRef;
  format: LayerFormat;
  base: number;
  maxLevel: number;
  missing: Set<number>;
  /** CPU copy of level 0 (albedo: zonal mean for the normalization). */
  level0: (ArrayBuffer | null)[];
  zonal: ZonalProfile | null;
  /** Level 0 decoded (albedo), for normalizations that need longitude structure. */
  map0: Level0Map | null;
  /** Level 0 was looked for and every tile is known (loaded or absent). */
  level0Done: boolean;
}

interface Resident {
  layer: Layer;
  tile: number;
  page: number;
  lastUsed: number;
  pinned: boolean;
}

export interface CacheStats {
  residentTiles: number;
  pendingFetches: number;
  deferredTiles: number;
  failedFetches: number;
}

/**
 * One tile cache (albedo or height pages). Pages are allocated when a tile arrives and evicted in LRU
 * order among pages not used this frame; level-0 tiles are pinned. When every page is in use the
 * remaining (finer) requests are deferred: the budget is never exceeded.
 */
export class TileCache {
  private layers = new Map<string, Layer>();
  private resident = new Map<string, Resident>();
  private freePages: number[] = [];
  private pending = new Set<string>();
  private queue: { layer: Layer; req: TileRequest }[] = [];
  private frame = 0;
  private stats: CacheStats = { residentTiles: 0, pendingFetches: 0, deferredTiles: 0, failedFetches: 0 };
  /** Called when a tile becomes resident or is evicted (the renderer re-renders while loading). */
  onChange?: () => void;

  constructor(
    readonly format: LayerFormat,
    private store: PageStore,
    private allocBase: (entries: number) => number,
    private fetcher: Fetcher = httpFetcher,
    private concurrency = 8,
  ) {
    for (let p = store.pages - 1; p >= 0; p--) this.freePages.push(p);
  }

  /** Register (idempotently) a layer and return its page-table base and addressed max level. */
  layer(ref: SurfaceLayerRef): { base: number; maxLevel: number; zonal: ZonalProfile | null; map0: Level0Map | null } {
    const key = layerKey(ref);
    let l = this.layers.get(key);
    if (!l) {
      const maxLevel = Math.max(0, Math.min(ref.header.maxLevel, MAX_ADDRESSED_LEVEL));
      const missing = new Set<number>();
      for (const [lvl, list] of Object.entries(ref.header.missingTiles ?? ref.header.missing ?? {})) {
        const L = Number(lvl);
        if (L <= maxLevel) for (const [tx, ty] of list) missing.add(tileIndex(L, tx, ty));
      }
      l = { ref, format: this.format, base: this.allocBase(layerEntries(maxLevel)), maxLevel, missing, level0: [null, null], zonal: null, map0: null, level0Done: false };
      this.layers.set(key, l);
    }
    return { base: l.base, maxLevel: l.maxLevel, zonal: l.zonal, map0: l.map0 };
  }

  /** Start a frame: requests made until the next beginFrame count as "in use". */
  beginFrame(): void {
    this.frame++;
    this.queue = [];
    this.stats.deferredTiles = 0;
  }

  /** Request tiles of a layer for this frame (already sorted by priority). */
  request(ref: SurfaceLayerRef, reqs: TileRequest[]): void {
    const l = this.layers.get(layerKey(ref));
    if (!l) return;
    for (const r of reqs) {
      if (r.L > l.maxLevel) continue;
      const idx = tileIndex(r.L, r.tx, r.ty);
      if (l.missing.has(idx)) continue;
      const key = `${l.base}:${idx}`;
      const res = this.resident.get(key);
      if (res) { res.lastUsed = this.frame; continue; }
      if (this.pending.has(key)) continue;
      this.queue.push({ layer: l, req: r });
    }
  }

  /** Launch fetches (most urgent first) up to the concurrency limit. */
  pump(): void {
    this.queue.sort((a, b) => a.req.priority - b.req.priority);
    while (this.pending.size < this.concurrency && this.queue.length) {
      const { layer, req } = this.queue.shift()!;
      const idx = tileIndex(req.L, req.tx, req.ty);
      const key = `${layer.base}:${idx}`;
      if (this.pending.has(key) || this.resident.has(key)) continue;
      if (!this.canAllocate()) { this.stats.deferredTiles += 1 + this.queue.length; this.queue = []; break; }
      this.pending.add(key);
      const url = tileUrl(layer.ref, req.L, req.ty, req.tx);
      this.fetcher(url).then(
        (buf) => this.arrive(layer, req, key, buf),
        () => this.arrive(layer, req, key, null),
      );
    }
    this.stats.pendingFetches = this.pending.size;
  }

  private canAllocate(): boolean {
    if (this.freePages.length) return true;
    for (const r of this.resident.values()) if (!r.pinned && r.lastUsed < this.frame) return true;
    return false;
  }

  private allocate(): number | null {
    const f = this.freePages.pop();
    if (f !== undefined) return f;
    let victim: Resident | null = null;
    for (const r of this.resident.values()) {
      if (r.pinned || r.lastUsed >= this.frame) continue;
      if (!victim || r.lastUsed < victim.lastUsed || (r.lastUsed === victim.lastUsed && r.tile > victim.tile)) victim = r;
    }
    if (!victim) return null;
    this.resident.delete(`${victim.layer.base}:${victim.tile}`);
    this.store.setEntry(victim.layer.base + victim.tile, 0);
    return victim.page;
  }

  private arrive(layer: Layer, req: TileRequest, key: string, buf: ArrayBuffer | null): void {
    this.pending.delete(key);
    this.stats.pendingFetches = this.pending.size;
    const idx = tileIndex(req.L, req.tx, req.ty);
    if (!buf || buf.byteLength !== TILE_BYTES[this.format]) {
      // Absent (404) or malformed: treat as a missing tile, i.e. unknown texels, never refetched.
      if (buf) this.stats.failedFetches++;
      layer.missing.add(idx);
      if (req.L === 0) this.level0Arrived(layer, req.tx, null);
      this.onChange?.();
      return;
    }
    const page = this.allocate();
    if (page === null) { this.stats.deferredTiles++; return; }
    this.store.upload(page, buf);
    this.store.setEntry(layer.base + idx, page + 1);
    this.resident.set(key, { layer, tile: idx, page, lastUsed: this.frame, pinned: req.L === 0 });
    this.stats.residentTiles = this.resident.size;
    if (req.L === 0) this.level0Arrived(layer, req.tx, buf);
    this.onChange?.();
  }

  private level0Arrived(layer: Layer, tx: number, buf: ArrayBuffer | null): void {
    layer.level0[tx] = buf;
    const done = [0, 1].every((t) => layer.level0[t] !== null || layer.missing.has(tileIndex(0, t, 0)));
    if (!done) return;
    layer.level0Done = true;
    if (this.format === 'albedo') {
      layer.zonal = zonalMeanOfLevel0(layer.level0);
      layer.map0 = level0Map(layer.level0);
    }
  }

  getStats(): CacheStats {
    return { ...this.stats, residentTiles: this.resident.size, pendingFetches: this.pending.size };
  }

  /** Requests not yet started (waiting for a free fetch slot). */
  queuedCount(): number {
    return this.queue.length;
  }

  /** Pages currently holding tiles (for tests). */
  residentCount(): number {
    return this.resident.size;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Level-0 zonal means (normalization input)
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** IEEE 754 binary16 → number. */
export function f16ToNumber(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

/** number → IEEE 754 binary16 (round to nearest even), for fixtures and tests. */
export function numberToF16(v: number): number {
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  let e = ((x >>> 23) & 0xff) - 127 + 15;
  let m = x & 0x7fffff;
  if (((x >>> 23) & 0xff) === 0xff) return sign | 0x7c00 | (m ? 0x200 : 0);
  if (e >= 31) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    m = (m | 0x800000) >>> (1 - e);
    const r = m & 0x1fff;
    m >>>= 13;
    if (r > 0x1000 || (r === 0x1000 && (m & 1))) m++;
    return sign | m;
  }
  const r = m & 0x1fff;
  m >>>= 13;
  if (r > 0x1000 || (r === 0x1000 && (m & 1))) { m++; if (m === 0x400) { m = 0; e++; if (e >= 31) return sign | 0x7c00; } }
  return sign | (e << 10) | m;
}

/** Level 0 of an albedo layer decoded to float32 XYZS (512 × 256), unknown texels = 1 (as shaded). */
export interface Level0Map {
  width: number;
  height: number;
  data: Float32Array;
}

export function level0Map(tiles: (ArrayBuffer | null)[]): Level0Map {
  const width = 2 * TILE, height = TILE;
  const data = new Float32Array(width * height * 4).fill(1);
  for (let t = 0; t < 2; t++) {
    const buf = tiles[t];
    if (!buf) continue;
    const h = new Uint16Array(buf);
    for (let j = 0; j < TILE; j++) for (let i = 0; i < TILE; i++) {
      const o = (j * TILE + i) * 4;
      if ((h[o] | h[o + 1] | h[o + 2] | h[o + 3]) === 0) continue;
      const d = (j * width + t * TILE + i) * 4;
      for (let k = 0; k < 4; k++) data[d + k] = f16ToNumber(h[o + k]);
    }
  }
  return { width, height, data };
}

/** Bilinear sample of a level-0 map at planetocentric latitude/longitude (radians), XYZS. */
export function sampleLevel0(m: Level0Map, lat: number, lon: number): [number, number, number, number] {
  const u = ((lon + Math.PI) / (2 * Math.PI)) * m.width - 0.5;
  const v = ((Math.PI / 2 - lat) / Math.PI) * m.height - 0.5;
  const i0 = Math.floor(u), j0 = Math.floor(v);
  const fu = u - i0, fv = v - j0;
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let k = 0; k < 4; k++) {
    const di = k & 1, dj = k >> 1;
    const w = (di ? fu : 1 - fu) * (dj ? fv : 1 - fv);
    const ii = (((i0 + di) % m.width) + m.width) % m.width;
    const jj = Math.min(Math.max(j0 + dj, 0), m.height - 1);
    const o = (jj * m.width + ii) * 4;
    for (let c = 0; c < 4; c++) out[c] += w * m.data[o + c];
  }
  return out;
}

/**
 * Zonal mean of level 0 (512 × 256 texels, two tiles) per channel. Unknown texels (all channels 0)
 * count as 1, exactly as the shader shades them (the disk-average value). Missing tiles: all unknown.
 */
export function zonalMeanOfLevel0(tiles: (ArrayBuffer | null)[]): ZonalProfile {
  const rows = TILE;
  const mean = new Float64Array(rows * 4);
  for (let j = 0; j < rows; j++) {
    const acc = [0, 0, 0, 0];
    for (let t = 0; t < 2; t++) {
      const buf = tiles[t];
      if (!buf) { for (let k = 0; k < 4; k++) acc[k] += TILE; continue; }
      const h = new Uint16Array(buf, j * TILE * 8, TILE * 4);
      for (let i = 0; i < TILE; i++) {
        const o = i * 4;
        if ((h[o] | h[o + 1] | h[o + 2] | h[o + 3]) === 0) { for (let k = 0; k < 4; k++) acc[k] += 1; continue; }
        for (let k = 0; k < 4; k++) acc[k] += f16ToNumber(h[o + k]);
      }
    }
    for (let k = 0; k < 4; k++) mean[4 * j + k] = acc[k] / (2 * TILE);
  }
  return { rows, mean };
}
