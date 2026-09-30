// GPU side of planetary atmospheres: builds the renderer's model from atmospheres.json (atmosphere.ts),
// precomputes its tables in a worker, packs them into one rgba16float texture array (shaders-atmosphere.ts)
// and keeps one uniform buffer per atmosphere.

import { atmosphereModelFromData, IRR_H, IRR_W, MS_N, PHASE_N, particleDeltaFraction, particleTable, PROFILE_N, ProfileGrid, rayleighDepolarization, T_H, T_W, type AtmosphereModel, type AtmosphereTables } from './atmosphere';
import { ATM_K4_MAX, ATM_TEX_H, ATM_TEX_W } from './shaders-atmosphere';
import { numberToF16 } from './surface';
import type { SceneAtmosphere } from './scene';

export interface AtmosphereBinding {
  model: AtmosphereModel;
  view: GPUTextureView;
  uniform: GPUBuffer;
  /** The tables and a profile grid, for CPU integrals (the disk renormalization, atmosphere.ts). */
  tables?: AtmosphereTables;
  grid?: ProfileGrid;
  /** Identifies the model (body, dust bin) for caches. */
  key: string;
  /**
   * Scattering not measured (Titan's haze): only the extent (model.bottomKm/topKm) is known; the shell
   * marks the air beyond the disk "not measured" and draws no light (no tables; a placeholder texture).
   */
  unmeasured?: boolean;
}

interface Entry {
  state: 'pending' | 'ready' | 'failed' | 'unmeasured';
  model?: AtmosphereModel;
  texture?: GPUTexture;
  uniform?: GPUBuffer;
  tables?: AtmosphereTables;
  grid?: ProfileGrid;
  key?: string;
  error?: string;
}

/** Bytes of the Atm uniform (struct Atm: 3 + 16 + 4 vec4). */
export const ATM_UB_BYTES = (3 + 16 + 4 + 4) * 16;

export class AtmosphereGpu {
  /** Per atmosphere data object, per dust-season bin (−1: no dust scaling). */
  private entries = new Map<SceneAtmosphere['body'], Map<number, Entry>>();
  private ids = new Map<SceneAtmosphere['body'], number>();
  private worker: Worker | null = null;
  private nextId = 1;
  private waiting = new Map<number, (t: AtmosphereTables) => void>();
  private pendingCount = 0;
  /** Called when an atmosphere becomes ready (the host re-renders). */
  onReady?: () => void;
  readonly sampler: GPUSampler;

  constructor(private readonly device: GPUDevice, private readonly precompute?: (m: AtmosphereModel) => Promise<AtmosphereTables>) {
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  }

  private tables(model: AtmosphereModel): Promise<AtmosphereTables> {
    if (this.precompute) return this.precompute(model);
    if (!this.worker) {
      this.worker = new Worker(new URL('./atmosphere.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<{ id: number; tables: AtmosphereTables }>) => {
        const f = this.waiting.get(e.data.id);
        this.waiting.delete(e.data.id);
        f?.(e.data.tables);
      };
    }
    const id = this.nextId++;
    return new Promise((res) => { this.waiting.set(id, res); this.worker!.postMessage({ id, model }); });
  }

  /**
   * The atmosphere's GPU binding once its tables are ready; null while they are computed or when it cannot be
   * drawn (reason in `problems`). groundAlbedo: the Lambert-equivalent reflectance of what lies below
   * (for the multiple-scattering table).
   */
  binding(atm: SceneAtmosphere, groundAlbedo: number[], name: string, dust?: { scale: number; bin: number } | null): AtmosphereBinding | { error: string; unmeasured?: AtmosphereBinding } | null {
    let byBin = this.entries.get(atm.body);
    if (!byBin) { byBin = new Map(); this.entries.set(atm.body, byBin); this.ids.set(atm.body, this.ids.size + 1); }
    const bin = dust ? dust.bin : -1;
    let e = byBin.get(bin);
    if (!e) {
      const r = atmosphereModelFromData(atm, groundAlbedo, dust ? dust.scale : 1);
      if ('error' in r && r.extent) {
        e = {
          state: 'unmeasured', error: r.error, key: `${this.ids.get(atm.body)}|u`,
          model: { bottomKm: r.extent.bottomKm, topKm: r.extent.topKm, altitudesKm: [0], wavelengthsNm: [], weights: [[], [], [], []], species: [], groundAlbedo: [] },
          uniform: this.device.createBuffer({ size: ATM_UB_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: `atmosphere ${name} (not measured)` }),
          texture: this.device.createTexture({ size: [1, 1, 1], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING, label: `atmosphere ${name} (not measured)` }),
        };
      } else if ('error' in r) {
        e = { state: 'failed', error: r.error };
      } else if (Math.ceil(r.model.wavelengthsNm.length / 4) > ATM_K4_MAX) {
        e = { state: 'failed', error: `${name}: atmosphere has ${r.model.wavelengthsNm.length} bins, the shaders handle ${4 * ATM_K4_MAX} → not drawn` };
      } else {
        const entry: Entry = { state: 'pending', model: r.model, key: `${this.ids.get(atm.body)}|${bin}` };
        e = entry;
        this.pendingCount++;
        this.tables(r.model).then((t) => {
          entry.tables = t;
          entry.grid = new ProfileGrid(r.model, 512);
          entry.texture = this.pack(r.model, t);
          entry.uniform = this.device.createBuffer({ size: ATM_UB_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: `atmosphere ${name}` });
          entry.state = 'ready';
        }).catch((err) => {
          entry.state = 'failed';
          entry.error = `${name}: atmosphere tables failed (${err}) → not drawn`;
        }).finally(() => {
          this.pendingCount--;
          this.onReady?.();
          if (this.idle()) { const w = this.idleWaiters; this.idleWaiters = []; for (const f of w) f(); }
        });
      }
      byBin.set(bin, e);
    }
    if (e.state === 'failed') return { error: e.error ?? `${name}: atmosphere not drawn` };
    if (e.state === 'unmeasured') {
      return { error: e.error!, unmeasured: { model: e.model!, view: e.texture!.createView({ dimension: '2d-array' }), uniform: e.uniform!, key: e.key!, unmeasured: true } };
    }
    return e.state === 'ready'
      ? { model: e.model!, view: e.texture!.createView({ dimension: '2d-array' }), uniform: e.uniform!, tables: e.tables!, grid: e.grid!, key: e.key! }
      : null;
  }

  idle(): boolean { return this.pendingCount === 0; }

  private idleWaiters: (() => void)[] = [];
  /** Resolves when no table computation is pending (or after timeoutMs). */
  whenIdle(timeoutMs: number): Promise<void> {
    if (this.idle()) return Promise.resolve();
    return new Promise((res) => {
      const t = setTimeout(res, timeoutMs);
      this.idleWaiters.push(() => { clearTimeout(t); res(); });
    });
  }

  /** Per-frame uniform: geometry, the Sun's illuminance over π at the body, the shell quad. */
  writeUniform(b: AtmosphereBinding, sunE: number[], sunAngularRadius: number, quadHalfExtent: number, fullScreen: boolean, steps: number): void {
    const m = b.model;
    const K = m.wavelengthsNm.length;
    const K4 = Math.ceil(K / 4);
    const a = new Float32Array(ATM_UB_BYTES / 4);
    a.set([m.bottomKm, m.topKm, K4, sunAngularRadius, ...sunE, quadHalfExtent, fullScreen ? 1 : 0, steps, b.unmeasured ? 1 : 0], 0);
    if (b.unmeasured) { this.device.queue.writeBuffer(b.uniform, 0, a); return; }
    for (let c = 0; c < 4; c++) for (let k = 0; k < K; k++) a[12 + (4 * c + (k >> 2)) * 4 + (k & 3)] = m.weights[c][k];
    const dep = rayleighDepolarization(m);
    for (let k = 0; k < K; k++) a[12 + 64 + k] = dep[k];
    const fD = particleDeltaFraction(m);
    for (let k = 0; k < K; k++) a[12 + 64 + 16 + k] = fD[k];
    this.device.queue.writeBuffer(b.uniform, 0, a);
  }

  /** Pack the tables into the layers of one rgba16float texture (layout in shaders-atmosphere.ts). */
  private pack(m: AtmosphereModel, t: AtmosphereTables): GPUTexture {
    const K = t.K;
    const K4 = Math.ceil(K / 4);
    const layers = 7 * K4;
    const W = ATM_TEX_W, H = ATM_TEX_H;
    const data = new Uint16Array(W * H * 4 * layers);
    const put = (layer: number, x: number, y: number, k: number, v: number) => { data[((layer * H + y) * W + x) * 4 + (k & 3)] = numberToF16(v); };
    const table = particleTable(m);
    for (let k = 0; k < K; k++) {
      const j = k >> 2;
      for (let y = 0; y < T_H; y++) for (let x = 0; x < T_W; x++) put(j, x, y, k, t.transmittance[(y * T_W + x) * K + k]);
      for (let y = 0; y < MS_N; y++) for (let x = 0; x < MS_N; x++) put(K4 + j, x, y, k, t.multiScattering[(y * MS_N + x) * K + k]);
      for (let y = 0; y < IRR_H; y++) for (let x = 0; x < IRR_W; x++) put(2 * K4 + j, x, y, k, t.skyIrradiance[(y * IRR_W + x) * K + k]);
      for (let x = 0; x < PROFILE_N; x++) for (let q = 0; q < 3; q++) put((3 + q) * K4 + j, x, 0, k, t.profile[(x * K + k) * 4 + q]);
      for (let x = 0; x < PHASE_N; x++) put(6 * K4 + j, x, 0, k, table ? table[k][x] : 0);
    }
    const tex = this.device.createTexture({ size: [W, H, layers], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, label: 'atmosphere tables' });
    this.device.queue.writeTexture({ texture: tex }, data, { bytesPerRow: W * 8, rowsPerImage: H }, [W, H, layers]);
    return tex;
  }

  destroy(): void {
    for (const m of this.entries.values()) for (const e of m.values()) { e.texture?.destroy(); e.uniform?.destroy(); }
    this.worker?.terminate();
  }
}
