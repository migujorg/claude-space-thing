// WebGPU renderer: light in absolute photometric units → human-eye model → display.
//
// Frame outline (docs/eye-model.md has the physics; this file the plumbing):
//   1. bodies   → EXT (XYZS luminance, additive), W (Ricco weight, min), depth (reversed-Z, ∞ far)
//   2. cull     → stars above the Crumey threshold → compact list + indirect draw args (compute)
//   3. points   → PT (stars, unresolved bodies): energy-conserving splats, depth-tested vs bodies
//   4. glare    → pyramid convolution of EXT+PT with the CIE 146 scatter kernel → veil
//   5. sun      → limb-darkened disk into EXT (its glare is analytic, so it is added after 4)
//   6. adapt    → foveal mean of the retinal image + corneal flux, reduced on the GPU, read back
//   7. composite→ Pattanaik tone reproduction, mesopic colour, CAT02, sRGB, dither → canvas
//   8. overlays → hatch / provenance tint / markers / orbits in display space

import type { RendererStats, SceneSnapshot, StarCatalog } from './scene';
import {
  ADAPT_REDUCE_SHADER, ADAPT_SHADER, BODY_OVERLAY_SHADER, BODY_SHADER, CLAMP_ARGS_SHADER, COMPOSITE_SHADER,
  CULL_SHADER, LINE_SHADER, POINT_SHADER, PYRAMID_BLUR_SIGMA, PYRAMID_SHADER, SUN_SHADER,
} from './shaders';
import { cameraGeom, prepareFrame, type PreparedFrame } from './frame';
import { orbitVertices } from './overlays';
import { AdaptationState, computeEyeFrame, type EyeFrame } from '../eye/model';
import { DEFAULT_EYE_SETTINGS, type EyeSettings } from '../eye/settings';
import { fitScatterKernel } from '../eye/glare';
import { DEG2_PER_SR } from '../eye/pupil';
import { DARK_LIGHT_CONE, DARK_LIGHT_ROD } from '../eye/tonemap';
import { CIE191, CRUMEY, PATTANAIK } from '../eye/constants';

/** Near plane of the reversed-Z infinite projection, km (0.1 mm). */
const NEAR_KM = 1e-7;
/**
 * Smallest σ (pixels) of a point-source splat. A reconstruction-filter choice, not an eye constant:
 * at σ ≥ 0.6 px the discrete sum of the Gaussian over the pixel grid equals its integral to 2·10⁻³
 * for every sub-pixel position (Poisson summation: 2·exp(−2π²σ²)), so splats conserve energy.
 */
const SIGMA_MIN_PX = 0.6;
/** Point-splat radius in units of σ. */
const SPLAT_EXTENT_SIGMA = 3;
const MAX_GLARE_SOURCES = 32;
const MAX_VISIBLE_STARS = 1 << 22;

interface Level {
  w: number;
  h: number;
  lvl: GPUTexture;
  tmp: GPUTexture;
  blur: GPUTexture;
  acc: GPUTexture;
  /** Ricco-weighted accumulation (perceptual veil). */
  accR: GPUTexture;
  ub: GPUBuffer;
}

interface Targets {
  W: number;
  H: number;
  ext: GPUTexture;
  pt: GPUTexture;
  w: GPUTexture;
  depth: GPUTexture;
  levels: Level[];
  zero: GPUTexture;
  zero2: GPUTexture;
  partials: GPUBuffer;
  tilesX: number;
  tilesY: number;
}

interface StarChunk {
  buffer: GPUBuffer;
  count: number;
  info: GPUBuffer;
}

interface Measurement {
  converged: boolean;
}

export class Renderer {
  readonly stats: RendererStats = { frameMs: 0, adaptationLuminance: 0, starsDrawn: 0, warnings: [] };

  private readonly adaptation = new AdaptationState();
  private settings: EyeSettings = { ...DEFAULT_EYE_SETTINGS };
  private targets: Targets | null = null;
  private stars: StarChunk[] = [];
  private starStride = 7;
  private starCount = 0;
  private visible: GPUBuffer;
  private maxVisible = 1;
  private frameIndex = 0;
  private lastSnapshot: SceneSnapshot | null = null;
  private readbackBusy = false;
  private waiters: ((m: Measurement) => void)[] = [];
  private glareCache = { key: '', weights: [] as number[], unscattered: 1 };
  private lastMeasurementTime = 0;
  private persistentWarnings: string[] = [];
  /** Debug: names of passes to skip ('bodies', 'cull', 'points', 'pyramid', 'sun', 'adapt', 'composite', 'overlays'). */
  debugSkip = new Set<string>();
  /** Optional debug hook, called with each adaptation measurement. */
  onMeasurement?: (info: { goal: { coneCdM2: number; rodCdM2: number; cornealFlux: number }; used: { cone: number; rod: number }; converged: boolean; starsDrawn: number }) => void;

  // Buffers
  private frameUB: GPUBuffer;
  private eyeUB: GPUBuffer;
  private sunUB: GPUBuffer;
  private clampUB: GPUBuffer;
  private reduceUB: GPUBuffer;
  private args: GPUBuffer;
  private srcs: GPUBuffer;
  private result: GPUBuffer;
  private readback: GPUBuffer;
  private bodiesBuf: GPUBuffer | null = null;
  private overlayBuf: GPUBuffer | null = null;
  private pointsBuf: GPUBuffer | null = null;
  private sunPointBuf: GPUBuffer;
  private lineBuf: GPUBuffer | null = null;

  // Pipelines
  private bodyPipe: GPURenderPipeline;
  private bodyOverlayPipe: GPURenderPipeline;
  private cullPipe: GPUComputePipeline;
  private clampPipe: GPUComputePipeline;
  private pointPipe: GPURenderPipeline;
  private sunPipe: GPURenderPipeline;
  private pyr: Record<'combine' | 'down' | 'blurH' | 'blurV' | 'accum', GPUComputePipeline>;
  private adaptPipe: GPUComputePipeline;
  private reducePipe: GPUComputePipeline;
  private compositePipe: GPURenderPipeline;
  private linePipe: GPURenderPipeline;

  private constructor(
    private readonly device: GPUDevice,
    private readonly canvas: HTMLCanvasElement,
    /** null in offscreen presentation mode. */
    private readonly ctx: GPUCanvasContext | null,
    private readonly format: GPUTextureFormat,
    private readonly hdrFormat: GPUTextureFormat,
    private readonly weightFormat: GPUTextureFormat,
  ) {
    const d = device;
    const ub = (size: number) => d.createBuffer({ size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.frameUB = ub(112);
    this.eyeUB = ub(13 * 16);  // 13 vec4 (struct Eye)
    this.sunUB = ub(11 * 16);
    this.clampUB = ub(16);
    this.reduceUB = ub(16);
    this.args = d.createBuffer({ size: 16, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.srcs = d.createBuffer({ size: MAX_GLARE_SOURCES * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.result = d.createBuffer({ size: 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    this.readback = d.createBuffer({ size: 32, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.sunPointBuf = d.createBuffer({ size: 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.visible = d.createBuffer({ size: 32, usage: GPUBufferUsage.STORAGE });

    const mod = (code: string, label: string) => d.createShaderModule({ code, label });
    const bodyMod = mod(BODY_SHADER, 'bodies');
    const add: GPUBlendState = { color: { operation: 'add', srcFactor: 'one', dstFactor: 'one' }, alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one' } };
    const min: GPUBlendState = { color: { operation: 'min', srcFactor: 'one', dstFactor: 'one' }, alpha: { operation: 'min', srcFactor: 'one', dstFactor: 'one' } };
    const over: GPUBlendState = { color: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
    this.bodyPipe = d.createRenderPipeline({
      label: 'bodies', layout: 'auto',
      vertex: { module: bodyMod, entryPoint: 'vs' },
      fragment: { module: bodyMod, entryPoint: 'fs', targets: [{ format: hdrFormat, blend: add }, { format: weightFormat, blend: min }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
    });
    const ovMod = mod(BODY_OVERLAY_SHADER, 'body overlay');
    this.bodyOverlayPipe = d.createRenderPipeline({
      label: 'body overlay', layout: 'auto',
      vertex: { module: ovMod, entryPoint: 'vs' },
      fragment: { module: ovMod, entryPoint: 'fsOverlay', targets: [{ format, blend: over }] },
      primitive: { topology: 'triangle-list' },
    });
    this.cullPipe = d.createComputePipeline({ label: 'star cull', layout: 'auto', compute: { module: mod(CULL_SHADER, 'cull'), entryPoint: 'main' } });
    this.clampPipe = d.createComputePipeline({ label: 'clamp args', layout: 'auto', compute: { module: mod(CLAMP_ARGS_SHADER, 'clamp'), entryPoint: 'main' } });
    const ptMod = mod(POINT_SHADER, 'points');
    this.pointPipe = d.createRenderPipeline({
      label: 'points', layout: 'auto',
      vertex: { module: ptMod, entryPoint: 'vs' },
      fragment: { module: ptMod, entryPoint: 'fs', targets: [{ format: hdrFormat, blend: add }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'greater-equal' },
    });
    const sunMod = mod(SUN_SHADER, 'sun');
    this.sunPipe = d.createRenderPipeline({
      label: 'sun', layout: 'auto',
      vertex: { module: sunMod, entryPoint: 'vs' },
      fragment: { module: sunMod, entryPoint: 'fs', targets: [{ format: hdrFormat, blend: add }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'greater-equal' },
    });
    const pyrMod = mod(PYRAMID_SHADER, 'pyramid');
    const cp = (entryPoint: string) => d.createComputePipeline({ label: entryPoint, layout: 'auto', compute: { module: pyrMod, entryPoint } });
    this.pyr = { combine: cp('combine'), down: cp('down'), blurH: cp('blurH'), blurV: cp('blurV'), accum: cp('accum') };
    this.adaptPipe = d.createComputePipeline({ label: 'adapt tiles', layout: 'auto', compute: { module: mod(ADAPT_SHADER, 'adapt'), entryPoint: 'tiles' } });
    this.reducePipe = d.createComputePipeline({ label: 'adapt reduce', layout: 'auto', compute: { module: mod(ADAPT_REDUCE_SHADER, 'reduce'), entryPoint: 'main' } });
    const compMod = mod(COMPOSITE_SHADER, 'composite');
    this.compositePipe = d.createRenderPipeline({
      label: 'composite', layout: 'auto',
      vertex: { module: compMod, entryPoint: 'vs' },
      fragment: { module: compMod, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    const lineMod = mod(LINE_SHADER, 'lines');
    this.linePipe = d.createRenderPipeline({
      label: 'lines', layout: 'auto',
      vertex: {
        module: lineMod, entryPoint: 'vs',
        buffers: [{ arrayStride: 28, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x4' }] }],
      },
      fragment: { module: lineMod, entryPoint: 'fs', targets: [{ format, blend: over }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  /**
   * @param options.presentation 'canvas' (default) presents into the canvas' WebGPU context;
   *   'offscreen' renders the display image into an internal texture that readPixels() returns (used by
   *   the headless test page, where WebGPU canvas presentation does not complete).
   */
  static async create(canvas: HTMLCanvasElement, options: { presentation?: 'canvas' | 'offscreen'; hdr?: 'auto' | 'f16' } = {}): Promise<Renderer> {
    if (!navigator.gpu) throw new Error('WebGPU is not available in this browser');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter');
    // float32-blendable is required for rgba32float HDR targets; otherwise (or with hdr: 'f16', for
    // testing) the targets are rgba16float with pre-exposure 1/A_cone and clamping at the fp16 maximum.
    const blend32 = adapter.features.has('float32-blendable') && options.hdr !== 'f16';
    const device = await adapter.requestDevice({
      requiredFeatures: blend32 ? ['float32-blendable'] : [],
      requiredLimits: {
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxBufferSize: adapter.limits.maxBufferSize,
      },
    });
    device.lost.then((info) => console.error(`WebGPU device lost (${info.reason}): ${info.message}`));
    device.addEventListener('uncapturederror', (e) => console.error('WebGPU error:', (e as GPUUncapturedErrorEvent).error.message));
    const offscreen = options.presentation === 'offscreen';
    const ctx = offscreen ? null : canvas.getContext('webgpu');
    if (!offscreen && !ctx) throw new Error('Could not get a WebGPU canvas context');
    const format: GPUTextureFormat = offscreen ? 'rgba8unorm' : navigator.gpu.getPreferredCanvasFormat();
    ctx?.configure({ device, format, alphaMode: 'opaque' });
    device.pushErrorScope('validation');
    const r = new Renderer(device, canvas, ctx, format, blend32 ? 'rgba32float' : 'rgba16float', blend32 ? 'r32float' : 'r16float');
    const err = await device.popErrorScope();
    if (err) throw new Error(`Renderer pipeline creation failed: ${err.message}`);
    if (!blend32) r.persistentWarnings.push('HDR buffers are rgba16float with pre-exposure (float32-blendable unavailable or disabled)');
    r.resize(canvas.clientWidth || canvas.width || 1, canvas.clientHeight || canvas.height || 1, 1);
    return r;
  }

  /** Upload the star catalog once (static). Large catalogs are split into storage-binding-sized chunks. */
  setStars(catalog: StarCatalog): void {
    for (const c of this.stars) { c.buffer.destroy(); c.info.destroy(); }
    this.stars = [];
    this.starStride = catalog.stride;
    this.starCount = catalog.count;
    const maxBytes = Math.min(this.device.limits.maxStorageBufferBindingSize, this.device.limits.maxBufferSize);
    const perChunk = Math.max(1, Math.floor(maxBytes / (catalog.stride * 4)));
    for (let first = 0; first < catalog.count; first += perChunk) {
      const count = Math.min(perChunk, catalog.count - first);
      const data = catalog.data.subarray(first * catalog.stride, (first + count) * catalog.stride);
      const buffer = this.device.createBuffer({ size: Math.max(16, data.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.device.queue.writeBuffer(buffer, 0, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
      const info = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.stars.push({ buffer, count, info });
    }
    this.maxVisible = Math.max(1, Math.min(catalog.count, MAX_VISIBLE_STARS));
    this.visible.destroy();
    this.visible = this.device.createBuffer({ size: this.maxVisible * 32, usage: GPUBufferUsage.STORAGE });
  }

  resize(width: number, height: number, devicePixelRatio: number): void {
    const W = Math.max(1, Math.round(width * devicePixelRatio));
    const H = Math.max(1, Math.round(height * devicePixelRatio));
    this.canvas.width = W;
    this.canvas.height = H;
    if (this.targets && this.targets.W === W && this.targets.H === H) return;
    this.destroyTargets();
    const d = this.device;
    const tex = (w: number, h: number, format: GPUTextureFormat, usage: number, label: string) => d.createTexture({ size: [w, h], format, usage, label });
    const RT = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    const ST = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
    const levels: Level[] = [];
    let w = W, h = H;
    for (let k = 0; ; k++) {
      levels.push({
        w, h,
        lvl: tex(w, h, 'rgba32float', ST, `pyr lvl ${k}`),
        tmp: tex(w, h, 'rgba32float', ST, `pyr tmp ${k}`),
        blur: tex(w, h, 'rgba32float', ST, `pyr blur ${k}`),
        acc: tex(w, h, 'rgba32float', ST, `pyr acc ${k}`),
        accR: tex(w, h, 'rgba32float', ST, `pyr accR ${k}`),
        ub: d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      });
      if (w === 1 && h === 1) break;
      w = Math.max(1, Math.ceil(w / 2));
      h = Math.max(1, Math.ceil(h / 2));
    }
    const tilesX = Math.ceil(W / 16), tilesY = Math.ceil(H / 16);
    this.targets = {
      W, H,
      ext: tex(W, H, this.hdrFormat, RT, 'EXT'),
      pt: tex(W, H, this.hdrFormat, RT, 'PT'),
      w: tex(W, H, this.weightFormat, RT, 'W'),
      depth: tex(W, H, 'depth32float', RT, 'depth'),
      levels,
      zero: tex(1, 1, 'rgba32float', ST, 'zero'),
      zero2: tex(1, 1, 'rgba32float', ST, 'zero2'),
      partials: d.createBuffer({ size: tilesX * tilesY * 16, usage: GPUBufferUsage.STORAGE }),
      tilesX, tilesY,
    };
    this.glareCache.key = '';
  }

  private display: GPUTexture | null = null;

  private displayTexture(): GPUTexture {
    const t = this.targets!;
    if (!this.display || this.display.width !== t.W || this.display.height !== t.H) {
      this.display?.destroy();
      this.display = this.device.createTexture({ size: [t.W, t.H], format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC, label: 'display (offscreen)' });
    }
    return this.display;
  }

  /** Offscreen mode: the last displayed frame as RGBA8 (sRGB-encoded) pixels. */
  async readPixels(): Promise<{ width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> }> {
    if (this.ctx) throw new Error('readPixels() is only available with presentation: "offscreen"');
    const tex = this.displayTexture();
    const { width, height } = tex;
    const bpr = Math.ceil((width * 4) / 256) * 256;
    const buf = this.device.createBuffer({ size: bpr * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [width, height]);
    this.device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(buf.getMappedRange());
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) data.set(src.subarray(y * bpr, y * bpr + width * 4), y * width * 4);
    buf.unmap();
    buf.destroy();
    return { width, height, data };
  }

  private destroyTargets(): void {
    const t = this.targets;
    if (!t) return;
    for (const x of [t.ext, t.pt, t.w, t.depth, t.zero, t.zero2]) x.destroy();
    for (const l of t.levels) { l.lvl.destroy(); l.tmp.destroy(); l.blur.destroy(); l.acc.destroy(); l.accR.destroy(); l.ub.destroy(); }
    t.partials.destroy();
    this.targets = null;
  }

  /** Resolves once the eye's adaptation has converged for the current view (drives frames itself). */
  async settled(): Promise<void> {
    let stable = 0;
    for (let i = 0; i < 40; i++) {
      if (!this.lastSnapshot) return;
      const next = new Promise<Measurement>((res) => this.waiters.push(res));
      this.render(this.lastSnapshot);
      const m = await next;
      stable = m.converged ? stable + 1 : 0;
      if (stable >= 2) return;
    }
    console.warn('Renderer.settled(): adaptation did not converge in 40 frames');
  }

  render(snapshot: SceneSnapshot): void {
    const t = this.targets;
    if (!t) return;
    const t0 = performance.now();
    this.lastSnapshot = snapshot;
    this.frameIndex++;
    const d = this.device;
    this.settings = { ...DEFAULT_EYE_SETTINGS, ...(snapshot.view.eye ?? {}) };
    const sunWhite = snapshot.sun ? ([snapshot.sun.irradianceXYZS_1AU[0], snapshot.sun.irradianceXYZS_1AU[1], snapshot.sun.irradianceXYZS_1AU[2]] as [number, number, number]) : null;
    const eye = computeEyeFrame(this.settings, this.adaptation, snapshot.view.mode, snapshot.view.exposureBoostStops, sunWhite);
    const g = cameraGeom(snapshot, t.W, t.H, NEAR_KM);

    // Point-splat footprint: the eye's optical core (Watson 2013) or the reconstruction minimum.
    const sigmaPx = Math.max(((eye.coreSigmaDeg * Math.PI) / 180) / g.pixelAngle, SIGMA_MIN_PX);
    const extentPx = SPLAT_EXTENT_SIGMA * sigmaPx;
    const omegaCentre = ((2 * g.tanX) / t.W) * ((2 * g.tanY) / t.H);
    const footprintSr = 2 * Math.PI * sigmaPx * sigmaPx * omegaCentre;
    const wPt = Math.min(1, footprintSr / eye.riccoAreaSr);
    const prep = prepareFrame(snapshot, g, eye, footprintSr);

    // Scatter kernel (CIE 146) fitted to this pyramid and field of view.
    const key = `${t.W}x${t.H}:${snapshot.camera.fovY}:${this.settings.ageYears}:${this.settings.pigmentation}`;
    if (this.glareCache.key !== key) {
      const levels = t.levels.map((_, k) => ({ sigmaPx: pyramidSigma(k) }));
      const fit = fitScatterKernel(levels, (g.pixelAngle * 180) / Math.PI, Math.hypot(t.W, t.H), this.settings.ageYears, this.settings.pigmentation);
      this.glareCache = { key, weights: fit.weights, unscattered: 1 - fit.total };
    }
    // Ricco weight of each scatter level: its Gaussian's equivalent area vs the Ricco area.
    t.levels.forEach((l, k) => {
      const Ak = 2 * Math.PI * pyramidSigma(k) ** 2 * omegaCentre;
      d.queue.writeBuffer(l.ub, 0, new Float32Array([this.glareCache.weights[k] ?? 0, Math.min(1, Ak / eye.riccoAreaSr), 0, 0]));
    });

    this.writeUniforms(snapshot, eye, g, prep, sigmaPx, extentPx, wPt);

    const enc = d.createCommandEncoder({ label: 'frame' });
    d.queue.writeBuffer(this.args, 0, new Uint32Array([6, 0, 0, 0]));

    // 1. Resolved bodies.
    const nRes = prep.resolved.length;
    if (nRes) this.writeBodies(prep);
    const skip = this.debugSkip;
    {
      const pass = enc.beginRenderPass({
        label: 'bodies',
        colorAttachments: [
          { view: t.ext.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
          { view: t.w.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [1, 1, 1, 1] },
        ],
        depthStencilAttachment: { view: t.depth.createView(), depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' },
      });
      if (nRes && this.bodiesBuf && !skip.has('bodies')) {
        pass.setPipeline(this.bodyPipe);
        pass.setBindGroup(0, d.createBindGroup({ layout: this.bodyPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.frameUB } }, { binding: 1, resource: { buffer: this.bodiesBuf } }] }));
        pass.draw(6, nRes);
      }
      pass.end();
    }

    // 2. Star visibility culling (reads last frame's veil for the local background).
    const veilView = t.levels[0].acc.createView();
    const veilRView = t.levels[0].accR.createView();
    if (this.starCount > 0 && !skip.has('cull')) {
      const pass = enc.beginComputePass({ label: 'star cull' });
      pass.setPipeline(this.cullPipe);
      for (const c of this.stars) {
        const groups = Math.ceil(c.count / 256);
        const gx = Math.min(groups, 65535);
        const gy = Math.ceil(groups / gx);
        d.queue.writeBuffer(c.info, 0, new Uint32Array([c.count, this.starStride, this.maxVisible, gx]));
        pass.setBindGroup(0, d.createBindGroup({
          layout: this.cullPipe.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.frameUB } },
            { binding: 1, resource: { buffer: this.eyeUB } },
            { binding: 2, resource: { buffer: c.buffer } },
            { binding: 3, resource: { buffer: this.visible } },
            { binding: 4, resource: { buffer: this.args } },
            { binding: 5, resource: veilRView },
            { binding: 6, resource: { buffer: c.info } },
            { binding: 7, resource: { buffer: this.srcs } },
          ],
        }));
        pass.dispatchWorkgroups(gx, gy);
      }
      d.queue.writeBuffer(this.clampUB, 0, new Uint32Array([this.maxVisible, 0, 0, 0]));
      pass.setPipeline(this.clampPipe);
      pass.setBindGroup(0, d.createBindGroup({ layout: this.clampPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.args } }, { binding: 1, resource: { buffer: this.clampUB } }] }));
      pass.dispatchWorkgroups(1);
      pass.end();
    }

    // 3. Point sources.
    {
      const pass = enc.beginRenderPass({
        label: 'points',
        colorAttachments: [{ view: t.pt.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
        depthStencilAttachment: { view: t.depth.createView(), depthReadOnly: true },
      });
      pass.setPipeline(this.pointPipe);
      if (this.starCount > 0 && !skip.has('points')) {
        pass.setBindGroup(0, this.pointBindGroup(this.visible));
        pass.drawIndirect(this.args, 0);
      }
      if (prep.points.length) {
        const buf = this.ensure('pointsBuf', prep.points.length * 32);
        const a = new Float32Array(prep.points.length * 8);
        prep.points.forEach((p, i) => a.set([p.ndc[0], p.ndc[1], p.depth, 0, ...p.E], i * 8));
        d.queue.writeBuffer(buf, 0, a);
        pass.setBindGroup(0, this.pointBindGroup(buf));
        pass.draw(6, prep.points.length);
      }
      pass.end();
    }

    // 4. Glare pyramid over EXT + PT.
    if (!skip.has('pyramid')) this.encodePyramid(enc, t);

    // 5. Sun (after the pyramid: its scatter is analytic).
    if (prep.sun && (prep.sun.resolvedFraction > 0 || prep.sun.point) && !skip.has('sun')) {
      const s = prep.sun;
      if (s.resolvedFraction > 0) {
        const pass = enc.beginRenderPass({
          label: 'sun disk',
          colorAttachments: [{ view: t.ext.createView(), loadOp: 'load', storeOp: 'store' }],
          depthStencilAttachment: { view: t.depth.createView(), depthReadOnly: true },
        });
        pass.setPipeline(this.sunPipe);
        pass.setBindGroup(0, d.createBindGroup({ layout: this.sunPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.frameUB } }, { binding: 1, resource: { buffer: this.sunUB } }] }));
        pass.draw(6);
        pass.end();
      }
      if (s.point) {
        d.queue.writeBuffer(this.sunPointBuf, 0, new Float32Array([s.point.ndc[0], s.point.ndc[1], s.point.depth, 0, ...s.point.E]));
        const pass = enc.beginRenderPass({
          label: 'sun point',
          colorAttachments: [{ view: t.pt.createView(), loadOp: 'load', storeOp: 'store' }],
          depthStencilAttachment: { view: t.depth.createView(), depthReadOnly: true },
        });
        pass.setPipeline(this.pointPipe);
        pass.setBindGroup(0, this.pointBindGroup(this.sunPointBuf));
        pass.draw(6, 1);
        pass.end();
      }
    }

    // 6. Adaptation measurement.
    if (!skip.has('adapt')) {
      const pass = enc.beginComputePass({ label: 'adaptation' });
      pass.setPipeline(this.adaptPipe);
      pass.setBindGroup(0, d.createBindGroup({
        layout: this.adaptPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.frameUB } },
          { binding: 1, resource: { buffer: this.eyeUB } },
          { binding: 2, resource: t.ext.createView() },
          { binding: 3, resource: t.pt.createView() },
          { binding: 4, resource: veilView },
          { binding: 5, resource: { buffer: t.partials } },
          { binding: 6, resource: { buffer: this.srcs } },
        ],
      }));
      pass.dispatchWorkgroups(t.tilesX, t.tilesY);
      d.queue.writeBuffer(this.reduceUB, 0, new Uint32Array([t.tilesX * t.tilesY, 0, 0, 0]));
      pass.setPipeline(this.reducePipe);
      pass.setBindGroup(0, d.createBindGroup({
        layout: this.reducePipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: t.partials } },
          { binding: 1, resource: { buffer: this.result } },
          { binding: 2, resource: { buffer: this.reduceUB } },
          { binding: 3, resource: { buffer: this.args } },
        ],
      }));
      pass.dispatchWorkgroups(1);
      pass.end();
    }

    // 7. Composite (eye model) into the canvas.
    const canvasView = this.ctx ? this.ctx.getCurrentTexture().createView() : this.displayTexture().createView();
    {
      const pass = enc.beginRenderPass({ label: 'composite', colorAttachments: [{ view: canvasView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
      if (!skip.has('composite')) {
      pass.setPipeline(this.compositePipe);
      pass.setBindGroup(0, d.createBindGroup({
        layout: this.compositePipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.frameUB } },
          { binding: 1, resource: { buffer: this.eyeUB } },
          { binding: 2, resource: t.ext.createView() },
          { binding: 3, resource: t.pt.createView() },
          { binding: 4, resource: t.w.createView() },
          { binding: 5, resource: veilRView },
          { binding: 6, resource: { buffer: this.srcs } },
        ],
      }));
      pass.draw(3);
      }
      pass.end();
    }

    // 8. Display-space overlays.
    const lines: number[] = [...prep.overlay];
    orbitVertices(snapshot.orbits, g, lines);
    const ovBodies = prep.resolved.some((r) => r.hatch || r.tint);
    if ((ovBodies || lines.length) && !skip.has('overlays')) {
      const pass = enc.beginRenderPass({ label: 'overlays', colorAttachments: [{ view: canvasView, loadOp: 'load', storeOp: 'store' }] });
      const depthView = t.depth.createView();
      if (ovBodies && this.bodiesBuf) {
        const ov = new Float32Array(nRes * 8);
        prep.resolved.forEach((r, i) => {
          const col = r.tint ?? [0, 0, 0, 0];
          ov.set([col[0], col[1], col[2], col[3], r.hatch ? 1 : 0, r.tint ? 1 : 0, 0, 0], i * 8);
        });
        const buf = this.ensure('overlayBuf', ov.byteLength);
        d.queue.writeBuffer(buf, 0, ov);
        pass.setPipeline(this.bodyOverlayPipe);
        pass.setBindGroup(0, d.createBindGroup({
          layout: this.bodyOverlayPipe.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.frameUB } },
            { binding: 1, resource: { buffer: this.bodiesBuf } },
            { binding: 2, resource: { buffer: buf } },
            { binding: 3, resource: depthView },
          ],
        }));
        pass.draw(6, nRes);
      }
      if (lines.length) {
        const a = new Float32Array(lines);
        const buf = this.ensure('lineBuf', a.byteLength, GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST);
        d.queue.writeBuffer(buf, 0, a);
        pass.setPipeline(this.linePipe);
        pass.setBindGroup(0, d.createBindGroup({ layout: this.linePipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: depthView }] }));
        pass.setVertexBuffer(0, buf);
        pass.draw(a.length / 7);
      }
      pass.end();
    }

    const doReadback = !this.readbackBusy;
    if (doReadback) enc.copyBufferToBuffer(this.result, 0, this.readback, 0, 32);
    d.queue.submit([enc.finish()]);

    this.stats.adaptationLuminance = eye.Acone;
    this.stats.scotopicAdaptationLuminance = eye.Arod;
    this.stats.pupilDiameterMm = eye.pupilMm;
    this.stats.mesopicM = eye.mesopic.m;
    this.stats.limitingMagnitude = eye.limitingMagnitude;
    this.stats.warnings = [...this.persistentWarnings, ...prep.warnings];
    d.queue.onSubmittedWorkDone().then(() => { this.stats.frameMs = performance.now() - t0; });

    if (doReadback) {
      this.readbackBusy = true;
      const used = { cone: eye.Acone, rod: eye.Arod, offFrameFlux: prep.offFrameFluxDeg2 };
      this.readback.mapAsync(GPUMapMode.READ).then(() => {
        const r = new Float32Array(this.readback.getMappedRange().slice(0));
        this.readback.unmap();
        this.readbackBusy = false;
        this.handleMeasurement(r, used);
      }, (e) => { this.readbackBusy = false; console.error(e); });
    }
  }

  private handleMeasurement(r: Float32Array, used: { cone: number; rod: number; offFrameFlux: number }): void {
    const om = r[2];
    const goal = {
      coneCdM2: om > 0 ? r[0] / om : 0,
      rodCdM2: om > 0 ? r[1] / om : 0,
      cornealFlux: r[3] * DEG2_PER_SR + used.offFrameFlux,
    };
    this.stats.starsDrawn = Math.round(r[4]);
    const now = performance.now();
    const dt = this.lastMeasurementTime ? (now - this.lastMeasurementTime) / 1000 : 0;
    this.lastMeasurementTime = now;
    const floorC = CRUMEY.zeroBackgroundB;
    const floorR = CRUMEY.zeroBackgroundB * CRUMEY.spRatioBlackwell;
    const dist = Math.max(
      Math.abs(Math.log(Math.max(goal.coneCdM2, floorC) / used.cone)),
      Math.abs(Math.log(Math.max(goal.rodCdM2, floorR) / used.rod)),
    );
    const prevFlux = this.adaptation.cornealFlux;
    this.adaptation.update(goal, dt);
    const fluxStable = Math.abs(goal.cornealFlux - prevFlux) <= 1e-3 * Math.max(goal.cornealFlux, 1e-12);
    const converged = dist < 1e-3 && fluxStable;
    this.onMeasurement?.({ goal, used, converged, starsDrawn: this.stats.starsDrawn });
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f({ converged });
  }

  private pointBindGroup(buf: GPUBuffer): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.pointPipe.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.frameUB } }, { binding: 1, resource: { buffer: this.eyeUB } }, { binding: 2, resource: { buffer: buf } }],
    });
  }

  private ensure(name: 'bodiesBuf' | 'overlayBuf' | 'pointsBuf' | 'lineBuf', bytes: number, usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST): GPUBuffer {
    const cur = this[name];
    if (cur && cur.size >= bytes) return cur;
    cur?.destroy();
    const size = Math.max(256, 2 ** Math.ceil(Math.log2(bytes)));
    const b = this.device.createBuffer({ size, usage });
    this[name] = b;
    return b;
  }

  private writeUniforms(snap: SceneSnapshot, eye: EyeFrame, g: ReturnType<typeof cameraGeom>, prep: PreparedFrame, sigmaPx: number, extentPx: number, wPt: number): void {
    const d = this.device;
    const t = this.targets!;
    const preExposure = this.hdrFormat === 'rgba32float' ? 1 : 1 / Math.max(eye.Acone, 1e-6);
    d.queue.writeBuffer(this.frameUB, 0, new Float32Array([
      ...g.right, 0, ...g.up, 0, ...g.back, 0,
      1 / g.tanX, 1 / g.tanY, NEAR_KM, preExposure,
      t.W, t.H, 1 / t.W, 1 / t.H,
      g.tanX, g.tanY, g.pixelAngle, this.frameIndex,
      this.hdrFormat === 'rgba32float' ? 3.4e38 : 65504, 0, 0, 0,
    ]));
    const s = this.settings;
    const cosField = Math.cos(((s.adaptationFieldDeg / 2) * Math.PI) / 180);
    const nSrc = Math.min(prep.glare.length, MAX_GLARE_SOURCES);
    const norm = 1 / (1 - Math.exp(-(SPLAT_EXTENT_SIGMA * SPLAT_EXTENT_SIGMA) / 2));
    const c = eye.cat;
    d.queue.writeBuffer(this.eyeUB, 0, new Float32Array([
      eye.scene.sigmaCone, eye.scene.sigmaRod, eye.scene.Bcone, eye.scene.BrodAdapt,
      eye.map.gain, eye.map.offset, PATTANAIK.n, eye.exposure,
      eye.display.sigma, eye.display.B, eye.display.white, eye.display.peak,
      eye.mesopic.m, CIE191.vPrimeLambda0, CRUMEY.spRatioBlackwell, s.fieldFactor,
      CRUMEY.a1, CRUMEY.a2, CRUMEY.a3, CRUMEY.a4,
      CRUMEY.a5, CRUMEY.zeroBackgroundB, eye.adaptBw, eye.riccoAreaSr,
      this.glareCache.unscattered, s.ageYears, s.pigmentation, wPt,
      c[0], c[1], c[2], 0, c[3], c[4], c[5], 0, c[6], c[7], c[8], 0,
      1 / 255, cosField, sigmaPx, nSrc,
      extentPx, norm, 0, 0,
      DARK_LIGHT_CONE, DARK_LIGHT_ROD, eye.darkResponse[0], eye.darkResponse[1],
    ]));
    const src = new Float32Array(MAX_GLARE_SOURCES * 8);
    prep.glare.slice(0, nSrc).forEach((gs, i) => src.set([...gs.dir, gs.minDeg, ...gs.E], i * 8));
    d.queue.writeBuffer(this.srcs, 0, src);
    if (prep.sun) {
      const sp = prep.sun;
      const co = (k: number) => [sp.coeffs[0][k], sp.coeffs[1][k], sp.coeffs[2][k], sp.coeffs[3][k]];
      d.queue.writeBuffer(this.sunUB, 0, new Float32Array([
        ...sp.n, sp.distKm, ...sp.e1, sp.beta, ...sp.e2, sp.radiusKm, ...sp.I0,
        ...co(0), ...co(1), ...co(2), ...co(3), ...co(4), ...co(5),
        sp.resolvedFraction, 0, 0, 0,
      ]));
    }
    void snap;
  }

  private writeBodies(prep: PreparedFrame): void {
    const n = prep.resolved.length;
    const a = new Float32Array(n * 80);
    prep.resolved.forEach((r, i) => {
      const f = r.frame;
      const o = i * 80;
      const M = f.M, Mi = f.Mi;
      a.set([...f.n, f.D, ...f.e1, f.beta, ...f.e2, f.near ? 1 : 0, ...f.ns, 0, ...f.E1, 0, ...f.E2, 0], o);
      a.set([M[0], M[1], M[2], 0, M[3], M[4], M[5], 0, M[6], M[7], M[8], 0], o + 24);
      a.set([Mi[0], Mi[1], Mi[2], 0, Mi[3], Mi[4], Mi[5], 0, Mi[6], Mi[7], Mi[8], 0], o + 36);
      a.set([...f.o, f.c, ...r.sunDir, r.sunDistKm, ...r.K, r.riccoWeight, r.sunRadiusKm, r.occluders.length, r.lit ? 1 : 0], o + 48);
      r.occluders.forEach(([p, rad], k) => a.set([...p, rad], o + 64 + k * 4));
    });
    const buf = this.ensure('bodiesBuf', a.byteLength);
    this.device.queue.writeBuffer(buf, 0, a);
  }

  private encodePyramid(enc: GPUCommandEncoder, t: Targets): void {
    const d = this.device;
    const pass = enc.beginComputePass({ label: 'glare pyramid' });
    const run = (pipe: GPUComputePipeline, w: number, h: number, entries: GPUBindGroupEntry[]) => {
      pass.setPipeline(pipe);
      pass.setBindGroup(0, d.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries }));
      pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    };
    const L = t.levels;
    run(this.pyr.combine, t.W, t.H, [
      { binding: 0, resource: t.ext.createView() },
      { binding: 1, resource: t.pt.createView() },
      { binding: 2, resource: L[0].lvl.createView() },
    ]);
    for (let k = 1; k < L.length; k++) {
      run(this.pyr.down, L[k].w, L[k].h, [{ binding: 0, resource: L[k - 1].lvl.createView() }, { binding: 2, resource: L[k].lvl.createView() }]);
    }
    for (let k = 0; k < L.length; k++) {
      run(this.pyr.blurH, L[k].w, L[k].h, [{ binding: 0, resource: L[k].lvl.createView() }, { binding: 2, resource: L[k].tmp.createView() }]);
      run(this.pyr.blurV, L[k].w, L[k].h, [{ binding: 0, resource: L[k].tmp.createView() }, { binding: 2, resource: L[k].blur.createView() }]);
    }
    for (let k = L.length - 1; k >= 0; k--) {
      run(this.pyr.accum, L[k].w, L[k].h, [
        { binding: 0, resource: L[k].blur.createView() },
        { binding: 1, resource: (k + 1 < L.length ? L[k + 1].acc : t.zero).createView() },
        { binding: 2, resource: L[k].acc.createView() },
        { binding: 3, resource: { buffer: L[k].ub } },
        { binding: 4, resource: (k + 1 < L.length ? L[k + 1].accR : t.zero2).createView() },
        { binding: 5, resource: L[k].accR.createView() },
      ]);
    }
    pass.end();
  }
}

/**
 * Effective σ (full-resolution pixels) of pyramid level k: box downsampling 2^k (variance
 * (4^k − 1)/12), blur of σ_b texels at that level (σ_b²·4^k), and k bilinear upsamples
 * (Σ_{j=1..k} 4^j/6 = (4^{k+1} − 4)/18).
 */
export function pyramidSigma(k: number): number {
  const p = Math.pow(4, k);
  return Math.sqrt(PYRAMID_BLUR_SIGMA * PYRAMID_BLUR_SIGMA * p + (p - 1) / 12 + (4 * p - 4) / 18);
}
