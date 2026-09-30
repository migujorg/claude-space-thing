// GPU side of planetary atmospheres: builds the renderer's model from atmospheres.json (atmosphere.ts),
// precomputes its tables in a worker, packs them into one rgba16float texture array (shaders-atmosphere.ts)
// and keeps one uniform buffer per atmosphere.

import { atmosphereModelFromData, IRR_H, IRR_W, MS_N, PHASE_N, particleTable, PROFILE_N, rayleighDepolarization, T_H, T_W, type AtmosphereModel, type AtmosphereTables } from './atmosphere';
import { ATM_K4_MAX, ATM_TEX_H, ATM_TEX_W } from './shaders-atmosphere';
import { numberToF16 } from './surface';
import type { SceneAtmosphere } from './scene';

export interface AtmosphereBinding {
  model: AtmosphereModel;
  view: GPUTextureView;
  uniform: GPUBuffer;
}

interface Entry {
  state: 'pending' | 'ready' | 'failed';
  model?: AtmosphereModel;
  texture?: GPUTexture;
  uniform?: GPUBuffer;
  error?: string;
}

/** Bytes of the Atm uniform (struct Atm: 3 + 16 + 4 vec4). */
export const ATM_UB_BYTES = (3 + 16 + 4) * 16;

export class AtmosphereGpu {
  private entries = new Map<SceneAtmosphere['body'], Entry>();
  private worker: Worker | null = null;
  private nextId = 1;
  private waiting = new Map<number, (t: AtmosphereTables) => void>();
  private pendingCount = 0;
  readonly problems = new Set<string>();
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
  binding(atm: SceneAtmosphere, groundAlbedo: number, name: string): AtmosphereBinding | null {
    let e = this.entries.get(atm.body);
    if (!e) {
      const r = atmosphereModelFromData(atm, groundAlbedo);
      if ('error' in r) {
        e = { state: 'failed', error: r.error };
        this.problems.add(r.error);
      } else if (Math.ceil(r.model.wavelengthsNm.length / 4) > ATM_K4_MAX) {
        e = { state: 'failed' };
        this.problems.add(`${name}: atmosphere has ${r.model.wavelengthsNm.length} bins, the shaders handle ${4 * ATM_K4_MAX} → not drawn`);
      } else {
        const entry: Entry = { state: 'pending', model: r.model };
        e = entry;
        this.pendingCount++;
        this.tables(r.model).then((t) => {
          entry.texture = this.pack(r.model, t);
          entry.uniform = this.device.createBuffer({ size: ATM_UB_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: `atmosphere ${name}` });
          entry.state = 'ready';
        }).catch((err) => {
          entry.state = 'failed';
          this.problems.add(`${name}: atmosphere tables failed (${err}) → not drawn`);
        }).finally(() => {
          this.pendingCount--;
          this.onReady?.();
          if (this.idle()) { const w = this.idleWaiters; this.idleWaiters = []; for (const f of w) f(); }
        });
      }
      this.entries.set(atm.body, e);
    }
    return e.state === 'ready' ? { model: e.model!, view: e.texture!.createView({ dimension: '2d-array' }), uniform: e.uniform! } : null;
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
    a.set([m.bottomKm, m.topKm, K4, sunAngularRadius, ...sunE, quadHalfExtent, fullScreen ? 1 : 0, steps, 0], 0);
    for (let c = 0; c < 4; c++) for (let k = 0; k < K; k++) a[12 + (4 * c + (k >> 2)) * 4 + (k & 3)] = m.weights[c][k];
    const dep = rayleighDepolarization(m);
    for (let k = 0; k < K; k++) a[12 + 64 + k] = dep[k];
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
    for (const e of this.entries.values()) { e.texture?.destroy(); e.uniform?.destroy(); }
    this.worker?.terminate();
  }
}
