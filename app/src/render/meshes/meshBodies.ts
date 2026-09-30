// Shape meshes in the frame (docs/rendering-shapes.md): which resolved bodies are drawn from their shape model this
// frame, at which level of detail, and their per-draw uniforms (camera-relative transforms composed in float64 on
// the CPU), self-shadow maps, the draws into the bodies pass and the provenance tint overlay.
//
// Used by renderer.ts through four calls, each marked there: prepare() after prepareFrame, encodeShadows() before
// the bodies pass, draw() inside it (the ellipsoid draw skips the bodies returned by prepare()), encodeTint() after
// the overlays. A body whose mesh is not resident yet stays an ellipsoid.

import type { PreparedFrame } from '../frame';
import type { CameraGeom } from '../overlays';
import { meanRadius } from '../photometry';
import { chooseLod, drawableLod } from './lod';
import { MESH_SHADER, MESH_SHADOW_SHADER, MESH_TINT_SHADER, MESH_UNIFORM_BYTES } from './shaders';
import { MeshStore, type FetchFn, type MeshStoreStats, type ModelEntry } from './store';

/** Self-shadow map size (texels): ~14 m texels for Phobos, finer than its 2 M-triangle level. */
const SHADOW_RES = 2048;
/** Bodies at least this many pixels across get a self-shadow map (smaller ones cannot show one). */
const SHADOW_MIN_PX = 48;
/** At most this many self-shadow maps per frame (the largest bodies on screen). */
const MAX_SHADOW_MAPS = 2;
/** The self-shadow map is drawn from a level of at most this many triangles (its texels are coarser anyway). */
const SHADOW_MAX_TRIANGLES = 500_000;

interface Draw {
  index: number;
  entry: ModelEntry;
  lod: number;
  /** Level drawn into the self-shadow map. */
  shadowLod: number;
  ub: GPUBuffer;
  shadow: GPUTextureView | null;
  tint: boolean;
}

export interface MeshFrameStats extends MeshStoreStats {
  drawn: { name: string; level: number; triangles: number; energyNormalization: number; selfShadow: boolean }[];
}

type V3 = [number, number, number];

export class MeshBodies {
  private readonly store: MeshStore;
  /** Compiled asynchronously (a large shader: compiling it inside a frame would stall that frame). */
  private pipe: GPURenderPipeline | null = null;
  private shadowPipe: GPURenderPipeline | null = null;
  private compiling = true;
  private tintPipe: GPURenderPipeline | null = null;
  private readonly sampler: GPUSampler;
  private readonly dummyShadow: GPUTexture;
  private readonly ubs = new Map<number, GPUBuffer>();
  private readonly shadowTex: GPUTexture[] = [];
  private draws: Draw[] = [];
  private frame = 0;
  private lastStats: MeshFrameStats['drawn'] = [];

  constructor(
    private readonly device: GPUDevice,
    hdrFormat: GPUTextureFormat,
    weightFormat: GPUTextureFormat,
    budgetMiB = 512,
    fetchFn?: FetchFn,
  ) {
    const d = device;
    this.store = new MeshStore(d, budgetMiB * 2 ** 20, fetchFn);
    const add: GPUBlendState = { color: { operation: 'add', srcFactor: 'one', dstFactor: 'one' }, alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one' } };
    const min: GPUBlendState = { color: { operation: 'min', srcFactor: 'one', dstFactor: 'one' }, alpha: { operation: 'min', srcFactor: 'one', dstFactor: 'one' } };
    const max: GPUBlendState = { color: { operation: 'max', srcFactor: 'one', dstFactor: 'one' }, alpha: { operation: 'max', srcFactor: 'one', dstFactor: 'one' } };
    const m = d.createShaderModule({ code: MESH_SHADER, label: 'mesh bodies' });
    const main = d.createRenderPipelineAsync({
      label: 'mesh bodies', layout: 'auto',
      vertex: { module: m, entryPoint: 'vs', buffers: [
        { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
        { arrayStride: 8, attributes: [{ shaderLocation: 1, offset: 0, format: 'snorm16x4' }] },
      ] },
      fragment: { module: m, entryPoint: 'fs', targets: [{ format: hdrFormat, blend: add }, { format: weightFormat, blend: min }, { format: 'r8unorm', blend: max }] },
      // Closed, outward meshes (counter-clockwise seen from outside): back faces are culled.
      primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
    });
    const sm = d.createShaderModule({ code: MESH_SHADOW_SHADER, label: 'mesh self-shadow' });
    const shadow = d.createRenderPipelineAsync({
      label: 'mesh self-shadow', layout: 'auto',
      vertex: { module: sm, entryPoint: 'vs', buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
    });
    Promise.all([main, shadow]).then(
      ([a, b]) => { this.pipe = a; this.shadowPipe = b; this.compiling = false; },
      (e: Error) => { this.compiling = false; this.store.problems.push(`shape meshes: pipeline creation failed (${e.message}) → ellipsoids`); },
    );
    this.sampler = d.createSampler({ compare: 'less-equal', magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.dummyShadow = d.createTexture({ size: [1, 1], format: 'depth32float', usage: GPUTextureUsage.TEXTURE_BINDING, label: 'mesh shadow dummy' });
  }

  /**
   * Choose the drawn meshes and write their uniforms. Returns the indices (into prep.resolved) drawn as meshes;
   * the renderer draws the others as ellipsoids.
   */
  prepare(prep: PreparedFrame, g: CameraGeom): Set<number> {
    this.frame++;
    this.draws = [];
    const drawn: MeshFrameStats['drawn'] = [];
    if (!this.pipe) return new Set();
    const ppr = g.H / (2 * g.tanY);
    const cand: { i: number; e: ModelEntry; k: number; sk: number; px: number; energy: number }[] = [];
    prep.resolved.forEach((r, i) => {
      const shape = r.body.shape;
      if (!shape || !r.body.radii) return;
      const e = this.store.entry(shape);
      const s = shape.scaleKm;
      // size and area from the model (header) until the coarsest level has been decoded
      const bound = e.boundRadius !== null ? e.boundRadius * s : shape.boundRadiusKm;
      const areaKm2 = e.area !== null ? e.area * s * s : shape.areaKm2;
      const want = chooseLod({ triangles: e.lods.map((l) => l.triangles), areaKm2, boundRadiusKm: bound, distKm: r.frame.D, pixelsPerRadian: ppr });
      this.store.request(e, want);
      if (!e.meanProjectedArea) return;  // the coarsest level (normalization) is not in yet: ellipsoid meanwhile
      const k = drawableLod(want, this.store.resident(e));
      if (k < 0) return;
      this.store.touch(e, k, this.frame);
      // self-shadow level: the drawn one, or the finest resident one under SHADOW_MAX_TRIANGLES
      let sk = k;
      if (e.lods[k].triangles > SHADOW_MAX_TRIANGLES) {
        const lim = e.lods.findIndex((l) => l.triangles <= SHADOW_MAX_TRIANGLES);
        if (lim >= 0) {
          this.store.request(e, lim);
          const res = this.store.resident(e);
          const r2 = res.findIndex((ok, j) => ok && j >= lim);
          if (r2 >= 0) sk = r2;
          this.store.touch(e, sk, this.frame);
        }
      }
      const R = meanRadius(r.body.radii);
      cand.push({ i, e, k, sk, px: (2 * bound * ppr) / Math.max(r.frame.D, bound), energy: (Math.PI * R * R) / (e.meanProjectedArea * s * s) });
    });
    const shadowed = new Set(cand.filter((c) => prep.resolved[c.i].lit && c.px >= SHADOW_MIN_PX).sort((a, b) => b.px - a.px).slice(0, MAX_SHADOW_MAPS).map((c) => c.i));
    let sIdx = 0;
    for (const c of cand) {
      const r = prep.resolved[c.i];
      const shape = r.body.shape!;
      let shadow: GPUTextureView | null = null;
      if (shadowed.has(c.i)) shadow = this.shadowTarget(sIdx++);
      const ub = this.uniform(c.i);
      this.writeUniform(ub, g, r.body.pos as V3, shape.orient, shape.scaleKm, c.e.boundRadius! * shape.scaleKm, r.sunDir, c.i, c.energy, !!shadow, r.hatch, r.tint);
      this.draws.push({ index: c.i, entry: c.e, lod: c.k, shadowLod: c.sk, ub, shadow, tint: !!r.tint });
      drawn.push({ name: r.body.name, level: c.k, triangles: c.e.lods[c.k].triangles, energyNormalization: c.energy, selfShadow: !!shadow });
    }
    this.store.evict(this.frame);
    this.lastStats = drawn;
    return new Set(this.draws.map((d) => d.index));
  }

  private uniform(i: number): GPUBuffer {
    let b = this.ubs.get(i);
    if (!b) {
      b = this.device.createBuffer({ size: MESH_UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: `mesh uniform ${i}` });
      this.ubs.set(i, b);
    }
    return b;
  }

  private shadowTarget(k: number): GPUTextureView {
    if (!this.shadowTex[k]) {
      this.shadowTex[k] = this.device.createTexture({ size: [SHADOW_RES, SHADOW_RES], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING, label: `mesh self-shadow ${k}` });
    }
    return this.shadowTex[k].createView();
  }

  /** Camera-relative transforms composed in float64 (the mesh stays in its own frame, km or model units). */
  private writeUniform(ub: GPUBuffer, g: CameraGeom, C: V3, M: number[], s: number, boundKm: number, sun: V3, index: number,
    energy: number, shadow: boolean, hatch: boolean, tint: [number, number, number, number] | null): void {
    // row a of (aᵀ·M)·s for a camera axis a, and its translation a·C
    const rowOf = (a: V3): number[] => [0, 1, 2].map((j) => s * (a[0] * M[j] + a[1] * M[3 + j] + a[2] * M[6 + j]));
    const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const u = new Float32Array(MESH_UNIFORM_BYTES / 4);
    u.set([...rowOf(g.right), dot(g.right, C), ...rowOf(g.up), dot(g.up, C), ...rowOf(g.back), dot(g.back, C)], 0);
    for (let i = 0; i < 3; i++) u.set([s * M[3 * i], s * M[3 * i + 1], s * M[3 * i + 2], 0], 12 + 4 * i);
    // light space: x, y across the Sun direction, depth along it (0 at the sunward edge of the bounding sphere)
    const h: V3 = Math.abs(sun[0]) < 0.6 ? [1, 0, 0] : [0, 1, 0];
    const e1n: V3 = [sun[1] * h[2] - sun[2] * h[1], sun[2] * h[0] - sun[0] * h[2], sun[0] * h[1] - sun[1] * h[0]];
    const l = Math.hypot(...e1n);
    const e1: V3 = [e1n[0] / l, e1n[1] / l, e1n[2] / l];
    const e2: V3 = [sun[1] * e1[2] - sun[2] * e1[1], sun[2] * e1[0] - sun[0] * e1[2], sun[0] * e1[1] - sun[1] * e1[0]];
    const Rb = boundKm * 1.02;
    const lrow = (a: V3, k: number) => rowOf(a).map((x) => x * k);
    u.set([...lrow(e1, 1 / Rb), 0, ...lrow(e2, 1 / Rb), 0, ...lrow(sun, -1 / (2 * Rb)), 0.5], 24);
    u.set([index, energy, shadow ? 1 : 0, hatch ? 1 : 0], 36);
    u.set([1 / SHADOW_RES, 3 / SHADOW_RES, 2 / SHADOW_RES, 1.5], 40);
    u.set(tint ?? [0, 0, 0, 0], 44);
    this.device.queue.writeBuffer(ub, 0, u);
  }

  /** Self-shadow maps of this frame's shadowed meshes (before the bodies pass). */
  encodeShadows(enc: GPUCommandEncoder): void {
    for (const d of this.draws) {
      if (!d.shadow) continue;
      const gpu = d.entry.slots[d.shadowLod].gpu!;
      const sp = this.shadowPipe!;
      const pass = enc.beginRenderPass({ label: 'mesh self-shadow', colorAttachments: [], depthStencilAttachment: { view: d.shadow, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } });
      pass.setPipeline(sp);
      pass.setBindGroup(0, this.device.createBindGroup({ layout: sp.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: d.ub } }] }));
      pass.setVertexBuffer(0, gpu.pos);
      pass.setIndexBuffer(gpu.idx, gpu.indexFormat);
      pass.drawIndexed(gpu.indexCount);
      pass.end();
    }
  }

  /** Draw this frame's meshes into the open bodies pass (EXT, W, MASK, depth). */
  draw(pass: GPURenderPassEncoder, b: { frameUB: GPUBuffer; bodies: GPUBuffer; rings: GPUBuffer; ringProf: GPUBuffer }): void {
    if (!this.draws.length || !this.pipe) return;
    const d = this.device;
    const pipe = this.pipe;
    pass.setPipeline(pipe);
    pass.setBindGroup(0, d.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: b.frameUB } },
        { binding: 1, resource: { buffer: b.bodies } },
        { binding: 2, resource: { buffer: b.rings } },
        { binding: 3, resource: { buffer: b.ringProf } },
      ],
    }));
    for (const m of this.draws) {
      const gpu = m.entry.slots[m.lod].gpu!;
      pass.setBindGroup(1, d.createBindGroup({
        layout: pipe.getBindGroupLayout(1),
        entries: [
          { binding: 0, resource: { buffer: m.ub } },
          { binding: 1, resource: m.shadow ?? this.dummyShadow.createView() },
          { binding: 2, resource: this.sampler },
        ],
      }));
      pass.setVertexBuffer(0, gpu.pos);
      pass.setVertexBuffer(1, gpu.nrm);
      pass.setIndexBuffer(gpu.idx, gpu.indexFormat);
      pass.drawIndexed(gpu.indexCount);
    }
  }

  /** Provenance tint over the visible part of each tinted mesh (display space, after the overlays). */
  encodeTint(enc: GPUCommandEncoder, target: GPUTextureView, format: GPUTextureFormat, depth: GPUTextureView, frameUB: GPUBuffer): void {
    const tinted = this.draws.filter((m) => m.tint);
    if (!tinted.length) return;
    const d = this.device;
    if (!this.tintPipe) {
      const m = d.createShaderModule({ code: MESH_TINT_SHADER, label: 'mesh tint' });
      this.tintPipe = d.createRenderPipeline({
        label: 'mesh tint', layout: 'auto',
        vertex: { module: m, entryPoint: 'vs', buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }] },
        fragment: { module: m, entryPoint: 'fs', targets: [{ format, blend: { color: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'greater-equal' },
      });
    }
    const pipe = this.tintPipe;
    const pass = enc.beginRenderPass({ label: 'mesh tint', colorAttachments: [{ view: target, loadOp: 'load', storeOp: 'store' }], depthStencilAttachment: { view: depth, depthReadOnly: true } });
    pass.setPipeline(pipe);
    pass.setBindGroup(0, d.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: frameUB } }] }));
    for (const m of tinted) {
      const gpu = m.entry.slots[m.lod].gpu!;
      pass.setBindGroup(1, d.createBindGroup({ layout: pipe.getBindGroupLayout(1), entries: [{ binding: 0, resource: { buffer: m.ub } }] }));
      pass.setVertexBuffer(0, gpu.pos);
      pass.setIndexBuffer(gpu.idx, gpu.indexFormat);
      pass.drawIndexed(gpu.indexCount);
    }
    pass.end();
  }

  /** No level fetch in flight and the pipelines compiled. */
  idle(): boolean {
    return !this.compiling && this.store.idle();
  }

  async whenIdle(ms: number): Promise<void> {
    const t0 = performance.now();
    while (this.compiling && performance.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50));
    await this.store.whenIdle(Math.max(0, ms - (performance.now() - t0)));
  }

  stats(): MeshFrameStats {
    return { ...this.store.stats(), drawn: this.lastStats };
  }

  get problems(): string[] {
    return this.store.problems;
  }
}
