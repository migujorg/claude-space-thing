// GPU side of surface-map virtual texturing (surface.ts has the GPU-agnostic logic): two page atlases
// (albedo rgba16float, height r32float) as texture arrays of 256×256 pages, one shared page table
// (u32 storage buffer, CPU mirror, dirty-range uploads), and the per-frame tile requests.
//
// Memory is strictly bounded by the budget given at creation (a renderer option): 2/3 for albedo pages,
// 1/3 for height pages. Nothing is allocated until the first body with a surface map appears.

import type { SceneBody } from './scene';
import type { CameraGeom } from './overlays';
import type { PreparedFrame, SurfaceBinding } from './frame';
import { footprintTiles, TILE, TILE_BYTES, TileCache, type Fetcher, type LayerFormat, type PageStore } from './surface';

const MIB = 1 << 20;

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
    this.dummy = { albedo: tex('rgba16float'), height: tex('r32float') };
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
    const share = format === 'albedo' ? 2 / 3 : 1 / 3;
    const bytes = TILE_BYTES[format];
    // Strict budget: allocate whole atlas layers only, never more pages than the budget holds.
    const budgetPages = Math.max(4, Math.floor((this.budgetMiB * MIB * share) / bytes));
    const perRow = Math.max(1, Math.min(16, Math.floor(Math.sqrt(budgetPages)), Math.floor(d.limits.maxTextureDimension2D / TILE)));
    const layers = Math.max(1, Math.min(Math.floor(budgetPages / (perRow * perRow)), d.limits.maxTextureArrayLayers));
    const pages = layers * perRow * perRow;
    const texture = d.createTexture({
      size: [perRow * TILE, perRow * TILE, layers],
      format: format === 'albedo' ? 'rgba16float' : 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      label: `surface ${format} pages`,
    });
    const atlas: Atlas = { texture, perRow, pages };
    this.atlases[format] = atlas;
    const bpp = format === 'albedo' ? 8 : 4;
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
    if (s.albedo) {
      const l = this.cache('albedo').layer(s.albedo);
      out.albedo = { base: l.base, maxLevel: l.maxLevel, zonal: this.cache('albedo').layer(s.albedo).zonal };
    }
    if (s.height) {
      const l = this.cache('height').layer(s.height);
      out.height = { base: l.base, maxLevel: l.maxLevel };
    }
    return out.albedo || out.height ? out : null;
  }

  /** Request the tiles each resolved body's footprint needs, most urgent first, and start fetches. */
  request(prep: PreparedFrame, g: CameraGeom): void {
    for (const r of prep.resolved) {
      const s = r.body.surface;
      if (!r.surface || !s) continue;
      if (s.albedo && r.surface.albedo) this.cache('albedo').request(s.albedo, footprintTiles(r.frame, r.bodyToWorld, g, r.surface.albedo.maxLevel));
      if (s.height && r.surface.height) this.cache('height').request(s.height, footprintTiles(r.frame, r.bodyToWorld, g, r.surface.height.maxLevel));
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
    return Object.values(this.caches).every((c) => c.getStats().pendingFetches === 0 && c.queuedCount() === 0);
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
      if (a) s.usedMiB += (a.texture.width * a.texture.height * a.texture.depthOrArrayLayers * (fmt === 'albedo' ? 8 : 4)) / MIB;
    }
    s.usedMiB += (this.bufferEntries * 4) / MIB;
    return s;
  }

  destroy(): void {
    for (const a of Object.values(this.atlases)) a.texture.destroy();
    this.dummy.albedo.destroy();
    this.dummy.height.destroy();
    this.buffer.destroy();
  }
}
