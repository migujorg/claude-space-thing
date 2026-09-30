// GPU side of surface-map virtual texturing (surface.ts has the GPU-agnostic logic): one page atlas per
// tile format (albedo rgba16float, height r32float, clouds rgba16float, rg16 rg16float) as texture arrays
// of 256×256 pages, one shared page table (u32 storage buffer, CPU mirror, dirty-range uploads), and the
// per-frame tile requests.
//
// Memory is strictly bounded by the budget given at creation (a renderer option), split by ATLAS_SHARE.
// Nothing is allocated until the first body with a layer of that format appears.

import type { SceneBody, SurfaceLayerRef } from './scene';
import type { CameraGeom } from './overlays';
import type { PreparedFrame, SurfaceBinding } from './frame';
import { footprintTiles, httpFetcher, layerFormatProblem, layerKey, TILE, TILE_BYTES, TileCache, tileUrl, type Fetcher, type LayerFormat, type PageStore } from './surface';
import { decodeTexelHapke, texelHapkeGpuLayers, texelLawProblem, type TexelHapke } from './texelLaw';

const MIB = 1 << 20;

/** GPU texture format of each atlas. */
const ATLAS_FORMAT: Record<LayerFormat, GPUTextureFormat> = { albedo: 'rgba16float', height: 'r32float', clouds: 'rgba16float', rg16: 'rg16float' };
/** Share of the surface-cache budget each atlas may use (they sum to 1). */
const ATLAS_SHARE: Record<LayerFormat, number> = { albedo: 0.35, height: 0.2, clouds: 0.3, rg16: 0.15 };
/** Earth's two-channel layers: expected channels by layer kind (architecture §4.4). */
const RG16_CHANNELS: Record<string, string[]> = {
  'surface-water': ['waterFraction', 'seaIceFraction'],
  'emitted-radiance': ['dnbRadiance', 'censoredFraction'],
};

interface Atlas {
  texture: GPUTexture;
  perRow: number;
  pages: number;
}

export interface SurfaceStats {
  budgetMiB: number;
  usedMiB: number;
  residentTiles: number;
  pendingFetches: number;
  deferredTiles: number;
  failedFetches: number;
}

export class SurfaceGpu {
  private atlases: Partial<Record<LayerFormat, Atlas>> = {};
  private caches: Partial<Record<LayerFormat, TileCache>> = {};
  private mirror = new Uint32Array(1024);
  private used = 1; // entry 0 unused (keeps base 0 meaning "no layer" out of the way)
  private buffer: GPUBuffer;
  private bufferEntries = 0;
  private dirtyLo = Infinity;
  private dirtyHi = -1;
  private dummy: Record<LayerFormat, GPUTexture>;
  private idleWaiters: (() => void)[] = [];
  /** Called when a tile arrives (the host may want to render again). */
  onTile?: () => void;

  constructor(private readonly device: GPUDevice, readonly budgetMiB: number, private readonly fetcher?: Fetcher) {
    this.buffer = this.makeBuffer(1024);
    const tex = (format: GPUTextureFormat) => device.createTexture({ size: [1, 1, 1], format, usage: GPUTextureUsage.TEXTURE_BINDING, label: 'surface dummy' });
    this.dummy = { albedo: tex('rgba16float'), height: tex('r32float'), clouds: tex('rgba16float'), rg16: tex('rg16float') };
  }

  private makeBuffer(entries: number): GPUBuffer {
    this.bufferEntries = entries;
    return this.device.createBuffer({ size: entries * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'surface page table' });
  }

  private allocBase = (entries: number): number => {
    const base = this.used;
    this.used += entries;
    if (this.used > this.mirror.length) {
      let n = this.mirror.length;
      while (n < this.used) n *= 2;
      const m = new Uint32Array(n);
      m.set(this.mirror);
      this.mirror = m;
    }
    return base;
  };

  private cache(format: LayerFormat): TileCache {
    let c = this.caches[format];
    if (c) return c;
    const d = this.device;
    const share = ATLAS_SHARE[format];
    const bytes = TILE_BYTES[format];
    // Strict budget: allocate whole atlas layers only, never more pages than the budget holds.
    const budgetPages = Math.max(4, Math.floor((this.budgetMiB * MIB * share) / bytes));
    const perRow = Math.max(1, Math.min(16, Math.floor(Math.sqrt(budgetPages)), Math.floor(d.limits.maxTextureDimension2D / TILE)));
    const layers = Math.max(1, Math.min(Math.floor(budgetPages / (perRow * perRow)), d.limits.maxTextureArrayLayers));
    const pages = layers * perRow * perRow;
    const texture = d.createTexture({
      size: [perRow * TILE, perRow * TILE, layers],
      format: ATLAS_FORMAT[format],
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      label: `surface ${format} pages`,
    });
    const atlas: Atlas = { texture, perRow, pages };
    this.atlases[format] = atlas;
    const bpp = TILE_BYTES[format] / (TILE * TILE);
    const store: PageStore = {
      pages,
      upload: (page, data) => {
        const per2 = perRow * perRow;
        const slot = page % per2;
        d.queue.writeTexture(
          { texture, origin: [(slot % perRow) * TILE, Math.floor(slot / perRow) * TILE, Math.floor(page / per2)] },
          data, { bytesPerRow: TILE * bpp, rowsPerImage: TILE }, [TILE, TILE, 1],
        );
      },
      setEntry: (i, v) => {
        this.mirror[i] = v;
        this.dirtyLo = Math.min(this.dirtyLo, i);
        this.dirtyHi = Math.max(this.dirtyHi, i);
      },
    };
    c = new TileCache(format, store, this.allocBase, this.fetcher);
    c.onChange = () => {
      this.onTile?.();
      if (this.idle()) { const w = this.idleWaiters; this.idleWaiters = []; for (const f of w) f(); }
    };
    this.caches[format] = c;
    return c;
  }

  beginFrame(): void {
    for (const c of Object.values(this.caches)) c.beginFrame();
  }

  /** Register a body's layers (idempotent) and return their page-table bindings. */
  binding(b: SceneBody): SurfaceBinding | null {
    const s = b.surface;
    if (!s) return null;
    const out: SurfaceBinding = {};
    const usable = (ref: SurfaceLayerRef, format: LayerFormat, channels?: string[]): boolean => {
      const why = layerFormatProblem(ref, format, channels);
      if (why) this.problems.add(`${b.name}: ${why} → layer not shown`);
      return !why;
    };
    if (s.albedo && usable(s.albedo, 'albedo')) {
      const l = this.cache('albedo').layer(s.albedo);
      out.albedo = { base: l.base, maxLevel: l.maxLevel, zonal: l.zonal, map0: l.map0 };
    }
    if (s.height && usable(s.height, 'height')) {
      const l = this.cache('height').layer(s.height);
      out.height = { base: l.base, maxLevel: l.maxLevel };
    }
    if (s.clouds && usable(s.clouds, 'clouds')) {
      const l = this.cache('clouds').layer(s.clouds);
      out.clouds = { base: l.base, maxLevel: l.maxLevel };
    }
    for (const k of ['water', 'night'] as const) {
      const ref = s[k];
      if (ref && usable(ref, 'rg16', RG16_CHANNELS[k === 'water' ? 'surface-water' : 'emitted-radiance'])) {
        const l = this.cache('rg16').layer(ref);
        out[k] = { base: l.base, maxLevel: l.maxLevel };
      }
    }
    if (s.wind) {
      const w = this.wholeLayer(s.wind, b.name);
      if (w) out.wind = w;
    }
    if (s.photometry && s.albedo && out.albedo) {
      const p = this.photometry(s.photometry, s.albedo, b.name);
      if (p) out.photometry = p;
    } else if (s.photometry && !s.albedo) {
      this.problems.add(`${b.name}: per-texel photometric layer needs the albedo layer (band weights) → not used`);
    }
    return out.albedo || out.height || out.clouds || out.water || out.night || out.wind ? out : null;
  }

  // ── Per-texel photometric layers (texelLaw.ts): level 0 only, loaded whole, one GPU texture each.
  private photo = new Map<string, { state: 'loading' | 'ready' | 'failed'; texel?: TexelHapke; texture?: GPUTexture }>();
  private photoPending = 0;

  private photometry(ref: SurfaceLayerRef, albedo: SurfaceLayerRef, name: string): { texel: TexelHapke; view: GPUTextureView } | null {
    const key = layerKey(ref);
    let e = this.photo.get(key);
    if (!e) {
      const why = texelLawProblem(ref, albedo);
      if (why) {
        this.problems.add(`${name}: ${why} → per-texel photometry not used`);
        this.photo.set(key, { state: 'failed' });
        return null;
      }
      const entry: { state: 'loading' | 'ready' | 'failed'; texel?: TexelHapke; texture?: GPUTexture } = { state: 'loading' };
      e = entry;
      this.photo.set(key, entry);
      const fetcher = this.fetcher ?? httpFetcher;
      const missing = ref.header.missingTiles?.['0'] ?? ref.header.missing?.['0'] ?? [];
      this.photoPending++;
      Promise.all([0, 1].map((tx) => (missing.some(([x, y]) => x === tx && y === 0) ? Promise.resolve(null) : fetcher(tileUrl(ref, 0, 0, tx)).catch(() => null))))
        .then((tiles) => {
          const t = decodeTexelHapke(ref, albedo, tiles);
          const texture = this.device.createTexture({
            size: [t.width, t.height, 6], format: 'rgba32float',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, label: 'per-texel photometry',
          });
          this.device.queue.writeTexture({ texture }, texelHapkeGpuLayers(t), { bytesPerRow: t.width * 16, rowsPerImage: t.height }, [t.width, t.height, 6]);
          entry.texel = t;
          entry.texture = texture;
          entry.state = 'ready';
        })
        .catch((err) => {
          entry.state = 'failed';
          this.problems.add(`${name}: per-texel photometry could not be loaded (${err}) → not used`);
        })
        .finally(() => {
          this.photoPending--;
          this.onTile?.();
          if (this.idle()) { const w = this.idleWaiters; this.idleWaiters = []; for (const f of w) f(); }
        });
    }
    return e.state === 'ready' && e.texel && e.texture ? { texel: e.texel, view: e.texture.createView({ dimension: '2d-array' }) } : null;
  }

  // ── Whole small layers (Earth's wind): the finest level ≤ 2 loaded at once into one rgba16float texture.
  private whole = new Map<string, { state: 'loading' | 'ready' | 'failed'; texture?: GPUTexture }>();

  private wholeLayer(ref: SurfaceLayerRef, name: string): { view: GPUTextureView } | null {
    const key = layerKey(ref);
    let e = this.whole.get(key);
    if (!e) {
      const h = ref.header;
      const ch = h.channels?.length ?? 0;
      if (h.format !== 'float16' || !(ch >= 1 && ch <= 4) || h.bytesPerTexel !== 2 * ch) {
        this.problems.add(`${name}: ${h.layer ?? 'layer'} is not a float16 layer of 1–4 channels → not used`);
        e = { state: 'failed' };
        this.whole.set(key, e);
        return null;
      }
      const L = Math.min(h.maxLevel, 2);
      const tx = 2 << L, ty = 1 << L;
      const entry: { state: 'loading' | 'ready' | 'failed'; texture?: GPUTexture } = { state: 'loading' };
      e = entry;
      this.whole.set(key, entry);
      const fetcher = this.fetcher ?? httpFetcher;
      const missing = new Set((h.missingTiles?.[String(L)] ?? h.missing?.[String(L)] ?? []).map(([x, y]) => `${x},${y}`));
      this.photoPending++;
      const jobs: Promise<ArrayBuffer | null>[] = [];
      for (let y = 0; y < ty; y++) for (let x = 0; x < tx; x++) jobs.push(missing.has(`${x},${y}`) ? Promise.resolve(null) : fetcher(tileUrl(ref, L, y, x)).catch(() => null));
      Promise.all(jobs).then((tiles) => {
        const W = tx * TILE, H = ty * TILE;
        const data = new Uint16Array(W * H * 4).fill(0x7e00); // NaN: unknown
        tiles.forEach((buf, i) => {
          if (!buf || buf.byteLength !== TILE * TILE * 2 * ch) return;
          const src = new Uint16Array(buf);
          const x0 = (i % tx) * TILE, y0 = Math.floor(i / tx) * TILE;
          for (let j = 0; j < TILE; j++) for (let q = 0; q < TILE; q++) {
            const o = ((y0 + j) * W + x0 + q) * 4, si = (j * TILE + q) * ch;
            for (let c = 0; c < ch; c++) data[o + c] = src[si + c];
          }
        });
        const texture = this.device.createTexture({ size: [W, H], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, label: `${name} ${h.layer}` });
        this.device.queue.writeTexture({ texture }, data, { bytesPerRow: W * 8, rowsPerImage: H }, [W, H]);
        entry.texture = texture;
        entry.state = 'ready';
      }).catch((err) => {
        entry.state = 'failed';
        this.problems.add(`${name}: ${h.layer} could not be loaded (${err}) → not used`);
      }).finally(() => {
        this.photoPending--;
        this.onTile?.();
        if (this.idle()) { const w = this.idleWaiters; this.idleWaiters = []; for (const f of w) f(); }
      });
    }
    return e.state === 'ready' && e.texture ? { view: e.texture.createView() } : null;
  }

  /** Layers that could not be used (format mismatch), as warnings. */
  readonly problems = new Set<string>();

  /** Request the tiles each resolved body's footprint needs, most urgent first, and start fetches. */
  request(prep: PreparedFrame, g: CameraGeom): void {
    for (const r of prep.resolved) {
      const s = r.body.surface;
      if (!r.surface || !s) continue;
      if (s.albedo && r.surface.albedo) this.cache('albedo').request(s.albedo, footprintTiles(r.frame, r.bodyToWorld, g, r.surface.albedo.maxLevel));
      if (s.height && r.surface.height) this.cache('height').request(s.height, footprintTiles(r.frame, r.bodyToWorld, g, r.surface.height.maxLevel));
      if (s.clouds && r.surface.clouds) this.cache('clouds').request(s.clouds, footprintTiles(r.frame, r.bodyToWorld, g, r.surface.clouds.maxLevel));
      if (s.water && r.surface.water) this.cache('rg16').request(s.water, footprintTiles(r.frame, r.bodyToWorld, g, r.surface.water.maxLevel));
      if (s.night && r.surface.night) this.cache('rg16').request(s.night, footprintTiles(r.frame, r.bodyToWorld, g, r.surface.night.maxLevel));
    }
    for (const c of Object.values(this.caches)) c.pump();
  }

  /** Upload page-table changes (called once per frame before the body pass). */
  flush(): void {
    if (this.bufferEntries < this.mirror.length) {
      this.buffer.destroy();
      this.buffer = this.makeBuffer(this.mirror.length);
      this.device.queue.writeBuffer(this.buffer, 0, this.mirror);
    } else if (this.dirtyHi >= this.dirtyLo) {
      this.device.queue.writeBuffer(this.buffer, this.dirtyLo * 4, this.mirror, this.dirtyLo, this.dirtyHi - this.dirtyLo + 1);
    }
    this.dirtyLo = Infinity;
    this.dirtyHi = -1;
  }

  get pageTable(): GPUBuffer { return this.buffer; }
  view(format: LayerFormat): GPUTextureView {
    return (this.atlases[format]?.texture ?? this.dummy[format]).createView({ dimension: '2d-array' });
  }
  perRow(format: LayerFormat): number { return this.atlases[format]?.perRow ?? 1; }

  idle(): boolean {
    return this.photoPending === 0 && Object.values(this.caches).every((c) => c.getStats().pendingFetches === 0 && c.queuedCount() === 0);
  }

  /** Resolves when no tile fetch is pending (or after timeoutMs). */
  whenIdle(timeoutMs: number): Promise<void> {
    if (this.idle()) return Promise.resolve();
    return new Promise((res) => {
      const t = setTimeout(res, timeoutMs);
      this.idleWaiters.push(() => { clearTimeout(t); res(); });
    });
  }

  stats(): SurfaceStats {
    const s: SurfaceStats = { budgetMiB: this.budgetMiB, usedMiB: 0, residentTiles: 0, pendingFetches: 0, deferredTiles: 0, failedFetches: 0 };
    for (const [fmt, c] of Object.entries(this.caches) as [LayerFormat, TileCache][]) {
      const cs = c.getStats();
      s.residentTiles += cs.residentTiles;
      s.pendingFetches += cs.pendingFetches;
      s.deferredTiles += cs.deferredTiles;
      s.failedFetches += cs.failedFetches;
      const a = this.atlases[fmt];
      if (a) s.usedMiB += (a.texture.width * a.texture.height * a.texture.depthOrArrayLayers * (TILE_BYTES[fmt] / (TILE * TILE))) / MIB;
    }
    s.usedMiB += (this.bufferEntries * 4) / MIB;
    return s;
  }

  destroy(): void {
    for (const a of Object.values(this.atlases)) a.texture.destroy();
    for (const p of this.photo.values()) p.texture?.destroy();
    for (const w of this.whole.values()) w.texture?.destroy();
    for (const t of Object.values(this.dummy)) t.destroy();
    this.buffer.destroy();
  }
}
