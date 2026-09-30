// Shape-mesh levels in GPU memory (docs/rendering-shapes.md §4): fetched on demand with HTTP range requests (one
// level of one model per request), decoded (format.ts) and uploaded; least recently used levels are evicted when
// the budget is exceeded, never one drawn this frame. The coarsest level of a model is always fetched first: it
// gives the model's size and its mean projected area (area.ts) before any finer level arrives.

import type { SceneShape, SceneShapeLod } from '../scene';
import { meanProjectedArea } from './area';
import { decodeLod } from './format';

export interface LodGpu {
  pos: GPUBuffer;
  nrm: GPUBuffer;
  idx: GPUBuffer;
  indexFormat: GPUIndexFormat;
  indexCount: number;
  bytes: number;
}

interface Slot {
  state: 'idle' | 'loading' | 'ready' | 'failed';
  gpu: LodGpu | null;
  lastFrame: number;
  error?: string;
}

export interface ModelEntry {
  key: string;
  lods: SceneShapeLod[];
  slots: Slot[];
  /** From the first decoded level (model units). */
  boundRadius: number | null;
  area: number | null;
  meanProjectedArea: number | null;
}

export interface MeshStoreStats {
  budgetMiB: number;
  usedMiB: number;
  residentLevels: number;
  pendingFetches: number;
  failedFetches: number;
  models: number;
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export class MeshStore {
  private readonly models = new Map<string, ModelEntry>();
  private used = 0;
  private pending = 0;
  private failed = 0;
  private idleWaiters: (() => void)[] = [];
  readonly problems: string[] = [];

  constructor(
    private readonly device: GPUDevice,
    private budgetBytes = 512 * 2 ** 20,
    private readonly fetchFn: FetchFn = (u, i) => fetch(u, i),
  ) {}

  entry(shape: SceneShape): ModelEntry {
    let e = this.models.get(shape.key);
    if (!e) {
      e = { key: shape.key, lods: shape.lods, slots: shape.lods.map(() => ({ state: 'idle', gpu: null, lastFrame: -1 })), boundRadius: null, area: null, meanProjectedArea: null };
      this.models.set(shape.key, e);
      this.request(e, shape.lods.length - 1);
    }
    return e;
  }

  resident(e: ModelEntry): boolean[] {
    return e.slots.map((s) => s.state === 'ready');
  }

  /** Start fetching a level (no-op if loading, resident or failed). */
  request(e: ModelEntry, k: number): void {
    const s = e.slots[k];
    if (!s || s.state !== 'idle') return;
    s.state = 'loading';
    this.pending++;
    this.load(e, k).then(
      () => undefined,
      (err: Error) => {
        s.state = 'failed';
        s.error = err.message;
        this.failed++;
        this.problems.push(`${e.key} level ${k}: ${err.message}`);
      },
    ).finally(() => {
      this.pending--;
      if (this.pending === 0) this.idleWaiters.splice(0).forEach((f) => f());
    });
  }

  private async load(e: ModelEntry, k: number): Promise<void> {
    const lod = e.lods[k];
    const res = await this.fetchFn(lod.url, { headers: { Range: `bytes=${lod.offset}-${lod.offset + lod.bytes - 1}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let buf = await res.arrayBuffer();
    // A server that ignores the range answers 200 with the whole file.
    if (res.status !== 206 && buf.byteLength > lod.bytes) buf = buf.slice(lod.offset, lod.offset + lod.bytes);
    const d = decodeLod(buf, lod);
    if (k === e.slots.length - 1) {
      // the coarsest level carries the model's size and its energy normalization (area.ts)
      e.boundRadius = d.boundRadius;
      e.area = d.area;
      e.meanProjectedArea = meanProjectedArea(d.positions, d.indices, d.triangles, d.boundRadius);
    }
    const dev = this.device;
    const mk = (data: ArrayBufferView, usage: number, label: string) => {
      const size = Math.max(16, (data.byteLength + 3) & ~3);
      const b = dev.createBuffer({ size, usage: usage | GPUBufferUsage.COPY_DST, label });
      const pad = new Uint8Array(size);
      pad.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      dev.queue.writeBuffer(b, 0, pad);
      return b;
    };
    const gpu: LodGpu = {
      pos: mk(d.positions, GPUBufferUsage.VERTEX, `${e.key} L${k} positions`),
      nrm: mk(d.normals, GPUBufferUsage.VERTEX, `${e.key} L${k} normals`),
      idx: mk(d.indices, GPUBufferUsage.INDEX, `${e.key} L${k} indices`),
      indexFormat: d.indices instanceof Uint16Array ? 'uint16' : 'uint32',
      indexCount: d.triangles * 3,
      bytes: d.positions.byteLength + d.normals.byteLength + d.indices.byteLength,
    };
    const s = e.slots[k];
    s.gpu = gpu;
    s.state = 'ready';
    this.used += gpu.bytes;
  }

  touch(e: ModelEntry, k: number, frame: number): void {
    e.slots[k].lastFrame = frame;
  }

  /** Free least recently used levels until the budget holds (never a level used in `frame`). */
  evict(frame: number): void {
    if (this.used <= this.budgetBytes) return;
    const cands: { e: ModelEntry; k: number; last: number }[] = [];
    for (const e of this.models.values()) e.slots.forEach((s, k) => { if (s.state === 'ready' && s.lastFrame < frame) cands.push({ e, k, last: s.lastFrame }); });
    cands.sort((a, b) => a.last - b.last);
    for (const c of cands) {
      if (this.used <= this.budgetBytes) break;
      // keep the coarsest level of every model: it carries the model's size and normalization
      if (c.k === c.e.slots.length - 1) continue;
      const s = c.e.slots[c.k];
      if (!s.gpu) continue;
      this.used -= s.gpu.bytes;
      s.gpu.pos.destroy(); s.gpu.nrm.destroy(); s.gpu.idx.destroy();
      s.gpu = null;
      s.state = 'idle';
    }
  }

  idle(): boolean {
    return this.pending === 0;
  }

  whenIdle(ms: number): Promise<void> {
    if (this.pending === 0) return Promise.resolve();
    return new Promise((res) => {
      const t = setTimeout(res, ms);
      this.idleWaiters.push(() => { clearTimeout(t); res(); });
    });
  }

  stats(): MeshStoreStats {
    let resident = 0;
    for (const e of this.models.values()) resident += e.slots.filter((s) => s.state === 'ready').length;
    return {
      budgetMiB: this.budgetBytes / 2 ** 20, usedMiB: this.used / 2 ** 20, residentLevels: resident,
      pendingFetches: this.pending, failedFetches: this.failed, models: this.models.size,
    };
  }

  destroy(): void {
    for (const e of this.models.values()) for (const s of e.slots) if (s.gpu) { s.gpu.pos.destroy(); s.gpu.nrm.destroy(); s.gpu.idx.destroy(); }
    this.models.clear();
    this.used = 0;
  }
}
