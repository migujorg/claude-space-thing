// WebGPU renderer: light in absolute photometric units → human-eye model → display.
//
// Frame outline (docs/eye-model.md has the physics; this file the plumbing):
//   1. bodies   → EXT (XYZS luminance, additive), W (Ricco weight, min), MASK (not-measured map gaps and
//                 ring regions), depth (reversed-Z, ∞ far); surface maps are virtual-textured (surfaceGpu.ts);
//                 then rings (ray–plane, lit/unlit faces, planet shadow), depth-tested, not depth-writing
//   2. cull     → stars above the Crumey threshold → compact list + indirect draw args (compute)
//   3. points   → PT (stars, unresolved bodies): physical energy-conserving splats, depth-tested vs
//                 bodies, and PTEX: the part of their light the display cannot convey (eye/points.ts)
//   4. glare    → pyramid convolution with the CIE 146 scatter kernel, twice: of EXT+PT (the physical
//                 veil: adaptation, thresholds) and of the excess image (the glare that is painted)
//   5. sun      → limb-darkened disk into EXT (its glare is analytic, so it is added after 4)
//   6. adapt    → foveal mean of the retinal image + corneal flux, reduced on the GPU, read back
//   6b. points  → PTDISP: sharp display-space splats of each point's display flux and own colour
//   7. composite→ Pattanaik tone reproduction, mesopic colour, CAT02, + points, sRGB, dither → canvas
//   8. overlays → hatch / provenance tint / markers / orbits in display space

import type { RendererStats, SceneSnapshot, StarCatalog } from './scene';
import {
  ADAPT_REDUCE_SHADER, ADAPT_SHADER, BODY_OVERLAY_SHADER, BODY_SHADER, CLAMP_ARGS_SHADER, COMPOSITE_SHADER,
  CULL_SHADER, LINE_SHADER, MASK_HATCH_SHADER, OVERFLOW_SHADER, POINT_SHADER, PYRAMID_BLUR_SIGMA, PYRAMID_SHADER,
  RING_SHADER, SUN_SHADER,
} from './shaders';
import { SurfaceGpu } from './surfaceGpu';
import type { RingPrep } from './rings';
import { LAW } from './spatial';
import { cameraGeom, prepareFrame, type PreparedFrame } from './frame';
import { orbitVertices } from './overlays';
import { AdaptationState, computeEyeFrame, type EyeFrame } from '../eye/model';
import { DEFAULT_EYE_SETTINGS, type EyeSettings } from '../eye/settings';
import { fitScatterKernel } from '../eye/glare';
import { DEG2_PER_SR } from '../eye/pupil';
import { DARK_LIGHT_CONE, DARK_LIGHT_ROD, response } from '../eye/tonemap';
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
  /** Physical veil (components at this level and coarser). */
  acc: GPUTexture;
  /** Painted glare: the viewer's veil of the overflow image (display units). */
  accR: GPUTexture;
  /** Level weights: physical w_k, and painted r_k·w_k (r_k = min(1, A_k/A_R,disp), the viewer's Ricco summation). */
  ub: GPUBuffer;
  ubR: GPUBuffer;
}

interface Targets {
  W: number;
  H: number;
  ext: GPUTexture;
  /** "Not measured" regions of resolved surfaces (map gaps) and rings, for the display hatch. */
  mask: GPUTexture;
  pt: GPUTexture;
  /** Excess part of point light (painted glare input). */
  ptEx: GPUTexture;
  /** Point sources as displayed (display-linear XYZ, cd/m²). */
  ptDisp: GPUTexture;
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
  private pointDispPipe: GPURenderPipeline;
  private ringPipe: GPURenderPipeline;
  private maskHatchPipe: GPURenderPipeline;
  private surf: SurfaceGpu | null = null;
  private surfUB: GPUBuffer;
  /** Per-texel photometric law (texelLaw.ts): uniform (band weights, constants) and a placeholder texture. */
  private texelUB: GPUBuffer;
  private texelDummy: GPUTexture | null = null;
  private ringsBuf: GPUBuffer | null = null;
  private ringProfBuf: GPUBuffer | null = null;
  private ringProfKey: unknown[] = [];
  private ringProfOffsets: number[] = [];
  private dummyStorage: GPUBuffer;
  /** Surface-map page cache budget (MiB), albedo 2/3 and height 1/3. */
  surfaceCacheMiB = 1024;
  private overflowPipe: GPUComputePipeline;
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
    this.eyeUB = ub(16 * 16);  // 16 vec4 (struct Eye)
    this.sunUB = ub(11 * 16);
    this.clampUB = ub(16);
    this.reduceUB = ub(16);
    this.args = d.createBuffer({ size: 16, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.srcs = d.createBuffer({ size: MAX_GLARE_SOURCES * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.result = d.createBuffer({ size: 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    this.readback = d.createBuffer({ size: 32, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.sunPointBuf = d.createBuffer({ size: 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.visible = d.createBuffer({ size: 32, usage: GPUBufferUsage.STORAGE });
    this.surfUB = ub(16);
    this.texelUB = ub(6 * 16);
    this.dummyStorage = d.createBuffer({ size: 256, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });

    const mod = (code: string, label: string) => d.createShaderModule({ code, label });
    const bodyMod = mod(BODY_SHADER, 'bodies');
    const add: GPUBlendState = { color: { operation: 'add', srcFactor: 'one', dstFactor: 'one' }, alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one' } };
    const min: GPUBlendState = { color: { operation: 'min', srcFactor: 'one', dstFactor: 'one' }, alpha: { operation: 'min', srcFactor: 'one', dstFactor: 'one' } };
    const max: GPUBlendState = { color: { operation: 'max', srcFactor: 'one', dstFactor: 'one' }, alpha: { operation: 'max', srcFactor: 'one', dstFactor: 'one' } };
    const over: GPUBlendState = { color: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
    this.bodyPipe = d.createRenderPipeline({
      label: 'bodies', layout: 'auto',
      vertex: { module: bodyMod, entryPoint: 'vs' },
      fragment: { module: bodyMod, entryPoint: 'fs', targets: [{ format: hdrFormat, blend: add }, { format: weightFormat, blend: min }, { format: 'r8unorm', blend: max }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
    });
    const ringMod = mod(RING_SHADER, 'rings');
    this.ringPipe = d.createRenderPipeline({
      label: 'rings', layout: 'auto',
      vertex: { module: ringMod, entryPoint: 'vs' },
      fragment: { module: ringMod, entryPoint: 'fs', targets: [{ format: hdrFormat, blend: add }, { format: weightFormat, blend: min }, { format: 'r8unorm', blend: max }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'greater' },
    });
    const hatchMod = mod(MASK_HATCH_SHADER, 'mask hatch');
    this.maskHatchPipe = d.createRenderPipeline({
      label: 'mask hatch', layout: 'auto',
      vertex: { module: hatchMod, entryPoint: 'vs' },
      fragment: { module: hatchMod, entryPoint: 'fs', targets: [{ format, blend: over }] },
      primitive: { topology: 'triangle-list' },
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
      label: 'points (retina)', layout: 'auto',
      vertex: { module: ptMod, entryPoint: 'vs' },
      fragment: { module: ptMod, entryPoint: 'fsPhys', targets: [{ format: hdrFormat, blend: add }, { format: hdrFormat, blend: add }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'greater-equal' },
    });
    this.pointDispPipe = d.createRenderPipeline({
      label: 'points (display)', layout: 'auto',
      vertex: { module: ptMod, entryPoint: 'vs' },
      fragment: { module: ptMod, entryPoint: 'fsDisp', targets: [{ format: 'rgba16float', blend: add }] },
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
    this.overflowPipe = d.createComputePipeline({ label: 'overflow', layout: 'auto', compute: { module: mod(OVERFLOW_SHADER, 'overflow'), entryPoint: 'main' } });
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
  /**
   * @param options.surfaceCacheMiB GPU memory budget for surface-map tiles (default 1024 MiB); never exceeded.
   */
  static async create(canvas: HTMLCanvasElement, options: { presentation?: 'canvas' | 'offscreen'; hdr?: 'auto' | 'f16'; surfaceCacheMiB?: number } = {}): Promise<Renderer> {
    if (!navigator.gpu) throw new Error('WebGPU is not available in this browser');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter');
    // float32-blendable is required for rgba32float HDR targets; otherwise (or with hdr: 'f16', for
    // testing) the targets are rgba16float with pre-exposure 1/A_cone and clamping at the fp16 maximum.
    const blend32 = adapter.features.has('float32-blendable') && options.hdr !== 'f16';
    const device = await adapter.requestDevice({
      requiredFeatures: [...(blend32 ? ['float32-blendable' as const] : []), ...(adapter.features.has('timestamp-query') ? ['timestamp-query' as const] : [])],
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
    if (options.surfaceCacheMiB !== undefined) r.surfaceCacheMiB = options.surfaceCacheMiB;
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
        ubR: d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
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
      ptEx: tex(W, H, this.hdrFormat, RT, 'PTEX'),
      ptDisp: tex(W, H, 'rgba16float', RT, 'PTDISP'),
      w: tex(W, H, this.weightFormat, RT, 'W'),
      mask: tex(W, H, 'r8unorm', RT, 'MASK'),
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
    for (const x of [t.ext, t.pt, t.ptEx, t.ptDisp, t.w, t.mask, t.depth, t.zero, t.zero2]) x.destroy();
    for (const l of t.levels) { l.lvl.destroy(); l.tmp.destroy(); l.blur.destroy(); l.acc.destroy(); l.accR.destroy(); l.ub.destroy(); l.ubR.destroy(); }
    t.partials.destroy();
    this.targets = null;
  }

  /**
   * Resolves once the eye's adaptation has converged for the current view and every surface-map tile the
   * view needs is loaded (drives frames itself; tile loading gives up after ~90 s).
   */
  async settled(): Promise<void> {
    const t0 = performance.now();
    // Load tiles first (one frame per batch of requests), then let the adaptation converge.
    for (let round = 0; round < 256 && this.lastSnapshot && performance.now() - t0 < 90000; round++) {
      this.render(this.lastSnapshot);
      if (!this.surf || this.surf.idle()) break;
      await this.surf.whenIdle(10000);
    }
    await this.settleAdaptation();
  }

  private async settleAdaptation(): Promise<void> {
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

  /** Change the surface-map memory budget (drops all resident tiles). */
  setSurfaceCacheBudget(mib: number): void {
    this.surfaceCacheMiB = mib;
    this.surf?.destroy();
    this.surf = null;
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
    if (!this.surf && snapshot.bodies.some((b) => b.surface && (b.surface.albedo || b.surface.height))) {
      this.surf = new SurfaceGpu(d, this.surfaceCacheMiB);
    }
    const surf = this.surf;
    surf?.beginFrame();
    const prep = prepareFrame(snapshot, g, eye, footprintSr, surf ? { surfaces: (b) => surf.binding(b) } : {});
    if (surf) {
      surf.request(prep, g);
      surf.flush();
      this.stats.surfaceCache = surf.stats();
    }

    // Scatter kernel (CIE 146) fitted to this pyramid and field of view.
    const key = `${t.W}x${t.H}:${snapshot.camera.fovY}:${this.settings.ageYears}:${this.settings.pigmentation}`;
    if (this.glareCache.key !== key) {
      const levels = t.levels.map((_, k) => ({ sigmaPx: pyramidSigma(k) }));
      const fit = fitScatterKernel(levels, (g.pixelAngle * 180) / Math.PI, Math.hypot(t.W, t.H), this.settings.ageYears, this.settings.pigmentation);
      this.glareCache = { key, weights: fit.weights, unscattered: 1 - fit.total };
    }
    // Painted glare is the viewer's (display-adapted) veil: structure finer than their Ricco area is summed
    // rather than seen (its perceived luminance is its flux over A_R,disp), so fine levels count A_k/A_R,disp.
    t.levels.forEach((l, k) => {
      const wk = this.glareCache.weights[k] ?? 0;
      const Ak = 2 * Math.PI * pyramidSigma(k) ** 2 * omegaCentre;
      d.queue.writeBuffer(l.ub, 0, new Float32Array([wk, 0, 0, 0]));
      d.queue.writeBuffer(l.ubR, 0, new Float32Array([wk * Math.min(1, Ak / eye.displayRiccoSr), 0, 0, 0]));
    });
    // Local background of point sources: the physical veil at scales >= the Ricco area (the level whose
    // Gaussian's equivalent area first reaches A_R), so a star's own core glare does not mask it.
    let kR = 0;
    while (kR < t.levels.length - 1 && 2 * Math.PI * pyramidSigma(kR) ** 2 * omegaCentre < eye.riccoAreaSr) kR++;
    this.bgView = t.levels[kR].acc.createView();
    // A source's own light in that background at its own position, per unit illuminance and per pixel
    // solid angle: Σ_{k≥kR} w_k/(2π σ_k²). The shaders subtract it: the background excludes the source.
    let selfVeilPx = 0;
    for (let k = kR; k < t.levels.length; k++) selfVeilPx += (this.glareCache.weights[k] ?? 0) / (2 * Math.PI * pyramidSigma(k) ** 2);
    this.selfVeilPx = selfVeilPx;

    this.writeUniforms(snapshot, eye, g, prep, sigmaPx, extentPx, wPt);

    const enc = d.createCommandEncoder({ label: 'frame' });
    this.tsLabels = [];
    d.queue.writeBuffer(this.args, 0, new Uint32Array([6, 0, 0, 0]));

    // 1. Resolved bodies, then rings.
    const nRes = prep.resolved.length;
    if (nRes) this.writeBodies(prep);
    const nRings = this.writeRings(prep.rings);
    d.queue.writeBuffer(this.surfUB, 0, new Uint32Array([surf?.perRow('albedo') ?? 1, surf?.perRow('height') ?? 1, nRings, 0]));
    const skip = this.debugSkip;
    {
      const pass = enc.beginRenderPass({
        label: 'bodies',
        timestampWrites: this.tsw('bodies+rings'),
        colorAttachments: [
          { view: t.ext.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
          { view: t.w.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [1, 1, 1, 1] },
          { view: t.mask.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
        ],
        depthStencilAttachment: { view: t.depth.createView(), depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' },
      });
      const ringsRes = this.ringsBuf && nRings ? this.ringsBuf : this.dummyStorage;
      // One per-texel photometric layer per frame (the Moon's): the first resolved body that has one.
      const texelBody = prep.resolved.find((r) => r.surface?.photometry && r.law.kind === LAW.texelHapke);
      const tp = texelBody?.surface?.photometry;
      if (tp) {
        const t = tp.texel;
        d.queue.writeBuffer(this.texelUB, 0, new Float32Array([...t.cw.flatMap((row) => row.slice(0, 4)), t.thetaBar, t.K, t.bc0, t.hc, t.width, t.height, t.hFn, 0]));
      }
      if (!this.texelDummy) this.texelDummy = d.createTexture({ size: [1, 1, 1], format: 'rgba32float', usage: GPUTextureUsage.TEXTURE_BINDING, label: 'texel law dummy' });
      const texelView = tp ? tp.view : this.texelDummy.createView({ dimension: '2d-array' });
      const profRes = this.ringProfBuf && nRings ? this.ringProfBuf : this.dummyStorage;
      if (nRes && this.bodiesBuf && !skip.has('bodies')) {
        pass.setPipeline(this.bodyPipe);
        pass.setBindGroup(0, d.createBindGroup({
          layout: this.bodyPipe.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.frameUB } },
            { binding: 1, resource: { buffer: this.bodiesBuf } },
            { binding: 2, resource: { buffer: surf ? surf.pageTable : this.dummyStorage } },
            { binding: 3, resource: surf ? surf.view('albedo') : this.dummyAtlas('albedo') },
            { binding: 4, resource: surf ? surf.view('height') : this.dummyAtlas('height') },
            { binding: 5, resource: { buffer: this.surfUB } },
            { binding: 6, resource: { buffer: ringsRes } },
            { binding: 7, resource: { buffer: profRes } },
            { binding: 8, resource: texelView },
            { binding: 9, resource: { buffer: this.texelUB } },
          ],
        }));
        pass.draw(6, nRes);
      }
      if (nRings && !skip.has('rings')) {
        pass.setPipeline(this.ringPipe);
        pass.setBindGroup(0, d.createBindGroup({
          layout: this.ringPipe.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.frameUB } },
            { binding: 1, resource: { buffer: ringsRes } },
            { binding: 2, resource: { buffer: profRes } },
          ],
        }));
        pass.draw(6, nRings);
      }
      pass.end();
    }

    // 2. Star visibility culling (reads last frame's veil for the local background).
    const veilView = t.levels[0].acc.createView();
    const paintView = t.levels[0].accR.createView();
    const bgView = this.bgView!;
    if (this.starCount > 0 && !skip.has('cull')) {
      const pass = enc.beginComputePass({ label: 'star cull', timestampWrites: this.tsw('star cull') });
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
            { binding: 5, resource: bgView },
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

    // 3. Point sources on the retina (PT) and their excess (PTEX).
    const pointPass = (pipe: GPURenderPipeline, targets: GPUTexture[], load: boolean, draw: (pass: GPURenderPassEncoder) => void) => {
      const pass = enc.beginRenderPass({
        label: pipe.label,
        timestampWrites: this.tsw(pipe.label),
        colorAttachments: targets.map((tx) => ({ view: tx.createView(), loadOp: load ? ('load' as const) : ('clear' as const), storeOp: 'store' as const, clearValue: [0, 0, 0, 0] })),
        depthStencilAttachment: { view: t.depth.createView(), depthReadOnly: true },
      });
      pass.setPipeline(pipe);
      draw(pass);
      pass.end();
    };
    let bodyPointsBuf: GPUBuffer | null = null;
    if (prep.points.length) {
      bodyPointsBuf = this.ensure('pointsBuf', prep.points.length * 32);
      const a = new Float32Array(prep.points.length * 8);
      prep.points.forEach((p, i) => a.set([p.ndc[0], p.ndc[1], p.depth, 0, ...p.E], i * 8));
      d.queue.writeBuffer(bodyPointsBuf, 0, a);
    }
    const drawPoints = (pipe: GPURenderPipeline, bg: GPUTextureView) => (pass: GPURenderPassEncoder) => {
      if (this.starCount > 0 && !skip.has('points')) {
        pass.setBindGroup(0, this.pointBindGroup(pipe, this.visible, bg));
        pass.drawIndirect(this.args, 0);
      }
      if (bodyPointsBuf) {
        pass.setBindGroup(0, this.pointBindGroup(pipe, bodyPointsBuf, bg));
        pass.draw(6, prep.points.length);
      }
    };
    pointPass(this.pointPipe, [t.pt, t.ptEx], false, drawPoints(this.pointPipe, bgView));

    // 4. Glare pyramids: physical veil (EXT + PT -> acc) and painted glare (overflow -> accR).
    if (!skip.has('pyramid')) {
      this.encodePyramid(enc, t, 'acc');
      this.encodePyramid(enc, t, 'accR');
    }

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
        // Into PT only for adaptation; its glare is analytic (PTEX is not read after the pyramid).
        d.queue.writeBuffer(this.sunPointBuf, 0, new Float32Array([s.point.ndc[0], s.point.ndc[1], s.point.depth, 0, ...s.point.E]));
        pointPass(this.pointPipe, [t.pt, t.ptEx], true, (pass) => {
          pass.setBindGroup(0, this.pointBindGroup(this.pointPipe, this.sunPointBuf, bgView));
          pass.draw(6, 1);
        });
      }
    }

    // 6. Adaptation measurement.
    if (!skip.has('adapt')) {
      const pass = enc.beginComputePass({ label: 'adaptation', timestampWrites: this.tsw('adaptation') });
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

    // 6b. Point sources as displayed (sharp splats of display flux, own colour), against this frame's veil.
    const bgNow = t.levels[kR].acc.createView();
    pointPass(this.pointDispPipe, [t.ptDisp], false, (pass) => {
      drawPoints(this.pointDispPipe, bgNow)(pass);
      if (prep.sun?.point && !skip.has('sun')) {
        pass.setBindGroup(0, this.pointBindGroup(this.pointDispPipe, this.sunPointBuf, bgNow));
        pass.draw(6, 1);
      }
    });

    // 7. Composite (eye model) into the canvas.
    const canvasView = this.ctx ? this.ctx.getCurrentTexture().createView() : this.displayTexture().createView();
    {
      const pass = enc.beginRenderPass({ label: 'composite', timestampWrites: this.tsw('composite'), colorAttachments: [{ view: canvasView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
      if (!skip.has('composite')) {
      pass.setPipeline(this.compositePipe);
      pass.setBindGroup(0, d.createBindGroup({
        layout: this.compositePipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.frameUB } },
          { binding: 1, resource: { buffer: this.eyeUB } },
          { binding: 2, resource: t.ext.createView() },
          { binding: 3, resource: t.ptDisp.createView() },
          { binding: 4, resource: t.w.createView() },
          { binding: 5, resource: paintView },
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
    const ovMask = prep.rings.length > 0 || prep.resolved.some((r) => r.surface?.albedo);
    if ((ovBodies || ovMask || lines.length) && !skip.has('overlays')) {
      const pass = enc.beginRenderPass({ label: 'overlays', timestampWrites: this.tsw('overlays'), colorAttachments: [{ view: canvasView, loadOp: 'load', storeOp: 'store' }] });
      if (ovMask) {
        pass.setPipeline(this.maskHatchPipe);
        pass.setBindGroup(0, d.createBindGroup({ layout: this.maskHatchPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: t.mask.createView() }] }));
        pass.draw(3);
      }
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
    this.resolveTimestamps(enc);
    d.queue.submit([enc.finish()]);
    this.readTimestamps();

    this.stats.adaptationLuminance = eye.Acone;
    this.stats.scotopicAdaptationLuminance = eye.Arod;
    this.stats.pupilDiameterMm = eye.pupilMm;
    this.stats.mesopicM = eye.mesopic.m;
    this.stats.limitingMagnitude = eye.limitingMagnitude;
    this.stats.warnings = [...this.persistentWarnings, ...prep.warnings, ...(surf?.problems ?? [])];
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
      coneCdM2: om > 0 ? Math.exp(r[0] / om) - DARK_LIGHT_CONE : 0,
      rodCdM2: om > 0 ? Math.exp(r[1] / om) - DARK_LIGHT_ROD : 0,
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

  private bgView: GPUTextureView | null = null;

  // GPU timing (timestamp queries), when the adapter supports them: one begin/end pair per pass.
  private static readonly MAX_TS_PASSES = 32;
  private tsQuery: GPUQuerySet | null = null;
  private tsResolve: GPUBuffer | null = null;
  private tsReadback: GPUBuffer | null = null;
  private tsBusy = false;
  private tsLabels: string[] = [];

  private tsw(label: string): GPURenderPassTimestampWrites | undefined {
    if (!this.device.features.has('timestamp-query')) return undefined;
    if (!this.tsQuery) {
      const n = 2 * Renderer.MAX_TS_PASSES;
      this.tsQuery = this.device.createQuerySet({ type: 'timestamp', count: n });
      this.tsResolve = this.device.createBuffer({ size: n * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
      this.tsReadback = this.device.createBuffer({ size: n * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    }
    const i = this.tsLabels.length;
    if (i >= Renderer.MAX_TS_PASSES) return undefined;
    this.tsLabels.push(label);
    return { querySet: this.tsQuery, beginningOfPassWriteIndex: 2 * i, endOfPassWriteIndex: 2 * i + 1 };
  }

  private resolveTimestamps(enc: GPUCommandEncoder): void {
    if (!this.tsQuery || !this.tsLabels.length || this.tsBusy) return;
    const n = 2 * this.tsLabels.length;
    enc.resolveQuerySet(this.tsQuery, 0, n, this.tsResolve!, 0);
    enc.copyBufferToBuffer(this.tsResolve!, 0, this.tsReadback!, 0, n * 8);
    this.tsPending = [...this.tsLabels];
  }
  private tsPending: string[] | null = null;

  private readTimestamps(): void {
    const labels = this.tsPending;
    if (!labels || this.tsBusy || !this.tsReadback) return;
    this.tsPending = null;
    this.tsBusy = true;
    const rb = this.tsReadback;
    rb.mapAsync(GPUMapMode.READ).then(() => {
      const t = new BigUint64Array(rb.getMappedRange().slice(0));
      rb.unmap();
      this.tsBusy = false;
      const ms: Record<string, number> = {};
      let total = 0;
      labels.forEach((l, i) => {
        const dt = Number(t[2 * i + 1] - t[2 * i]) / 1e6;
        if (Number.isFinite(dt) && dt >= 0) { ms[l] = (ms[l] ?? 0) + dt; total += dt; }
      });
      this.stats.gpuPassMs = ms;
      this.stats.gpuFrameMs = total;
    }, () => { this.tsBusy = false; });
  }
  private selfVeilPx = 0;

  private pointBindGroup(pipe: GPURenderPipeline, buf: GPUBuffer, bg: GPUTextureView): GPUBindGroup {
    return this.device.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.frameUB } },
        { binding: 1, resource: { buffer: this.eyeUB } },
        { binding: 2, resource: { buffer: buf } },
        { binding: 3, resource: bg },
        { binding: 4, resource: this.targets!.ext.createView() },
        { binding: 5, resource: { buffer: this.srcs } },
      ],
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
    // The resolved solar disk is never a fixation (brightness-weighted fixations, eye-model.md §2).
    const sp = prep.sun;
    const sunFix = sp && sp.resolvedFraction > 0
      ? [...sp.n, Math.cos(Math.min(Math.asin(Math.min(1, sp.radiusKm / sp.distKm)) + g.pixelAngle, Math.PI))]
      : [0, 0, 1, 2];
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
      response(PATTANAIK.coneBleachHalf, eye.display.sigma, eye.display.B), eye.displayRiccoSr, eye.coneSummationSr, this.selfVeilPx,
      ...sunFix,
      eye.display.blackRef, s.coneBleaching ? 1 : 0, s.fixation === 'centre' ? 0 : 1, 0,
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

  /** Body records: 33 vec4 each (struct Body in shaders.ts). */
  private writeBodies(prep: PreparedFrame): void {
    const n = prep.resolved.length;
    const STRIDE = 132;
    const a = new Float32Array(n * STRIDE);
    const u = new Uint32Array(a.buffer);
    prep.resolved.forEach((r, i) => {
      const f = r.frame;
      const o = i * STRIDE;
      const M = f.M, Mi = f.Mi;
      a.set([...f.n, f.D, ...f.e1, f.beta, ...f.e2, f.near ? 1 : 0, ...f.ns, 0, ...f.E1, 0, ...f.E2, 0], o);
      a.set([M[0], M[1], M[2], 0, M[3], M[4], M[5], 0, M[6], M[7], M[8], 0], o + 24);
      a.set([Mi[0], Mi[1], Mi[2], 0, Mi[3], Mi[4], Mi[5], 0, Mi[6], Mi[7], Mi[8], 0], o + 36);
      a.set([...f.o, f.c, ...r.sunDir, r.sunDistKm, ...r.K, r.riccoWeight, r.sunRadiusKm, r.occluders.length, r.lit ? 1 : 0], o + 48);
      r.occluders.forEach(([p, rad], k) => a.set([...p, rad], o + 64 + k * 4));
      const R = r.bodyToWorld, rr = r.radiiKm;
      a.set([R[0], R[1], R[2], rr[0], R[3], R[4], R[5], rr[1], R[6], R[7], R[8], rr[2]], o + 80);
      const meanR = Math.cbrt(rr[0] * rr[1] * rr[2]);
      const sa = r.surface?.albedo, sh = r.surface?.height;
      a.set([0, sa ? sa.maxLevel : 0, sa ? 1 : 0, meanR], o + 92);
      if (sa) u[o + 92] = sa.base;
      a.set([0, sh ? sh.maxLevel : 0, sh ? 1 : 0, 0], o + 96);
      if (sh) u[o + 96] = sh.base;
      const l = r.law;
      a.set([l.kind, l.p, l.b, l.c, l.bs0, l.hs, l.bc0, l.hc, l.thetaBar, l.K, l.hFn, 0], o + 100);
      r.planetshine.slice(0, 2).forEach((ps, k) => a.set([...ps.dir, 1, ...ps.K], o + 112 + 8 * k));
      a.set(r.ring ? [r.ring.index, ...r.ring.B] : [-1, 0, 0, 0], o + 128);
    });
    const buf = this.ensure('bodiesBuf', a.byteLength);
    this.device.queue.writeBuffer(buf, 0, a);
  }

  private dummyAtlasTex: Partial<Record<'albedo' | 'height', GPUTexture>> = {};
  private dummyAtlas(fmt: 'albedo' | 'height'): GPUTextureView {
    let t = this.dummyAtlasTex[fmt];
    if (!t) {
      t = this.device.createTexture({ size: [1, 1, 1], format: fmt === 'albedo' ? 'rgba16float' : 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING });
      this.dummyAtlasTex[fmt] = t;
    }
    return t.createView({ dimension: '2d-array' });
  }

  /** Ring records (14 vec4 each, struct Ring) and their cumulative radial profiles. Returns the ring count. */
  private writeRings(rings: RingPrep[]): number {
    const d = this.device;
    if (!rings.length) return 0;
    // Profiles: re-upload only when the set of ring systems changes.
    const key = rings.map((r) => r.profile);
    if (key.length !== this.ringProfKey.length || key.some((k, i) => k !== this.ringProfKey[i])) {
      // Per ring system: cumulative profile (stride vec4 per bin edge), then the reflectance tables.
      const offsets: number[] = [];
      let total = 0;
      for (const r of rings) {
        offsets.push(total);
        total += r.profile.cumulative.length / 4 + (r.profile.tables ? r.profile.tables.length / 4 : 0);
      }
      const data = new Float32Array(Math.max(total * 4, 64));
      rings.forEach((r, i) => {
        data.set(r.profile.cumulative, offsets[i] * 4);
        if (r.profile.tables) data.set(r.profile.tables, offsets[i] * 4 + r.profile.cumulative.length);
      });
      this.ringProfBuf?.destroy();
      this.ringProfBuf = d.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'ring profiles' });
      d.queue.writeBuffer(this.ringProfBuf, 0, data);
      this.ringProfKey = key;
      this.ringProfOffsets = offsets;
    }
    const STRIDE = 56;
    const a = new Float32Array(rings.length * STRIDE);
    rings.forEach((r, i) => {
      const o = i * STRIDE;
      const p = r.profile;
      const base = this.ringProfOffsets[i];
      const tabBase = p.tables ? base + p.cumulative.length / 4 : -1;
      a.set([...r.n, r.D, ...r.e1, r.beta, ...r.e2, r.near ? 1 : 0, ...r.E1, 0, ...r.E2, 0, ...r.o, 0], o);
      a.set([...r.normal, p.rMin, p.rMax, p.bins, base, p.stride], o + 24);
      a.set([...r.sunDir, r.sunDistKm, ...r.esun, tabBase, r.sunRadiusKm, 0, 0], o + 32);
      const M = r.M;
      a.set([M[0], M[1], M[2], 0, M[3], M[4], M[5], 0, M[6], M[7], M[8], 0], o + 44);
    });
    if (!this.ringsBuf || this.ringsBuf.size < a.byteLength) {
      this.ringsBuf?.destroy();
      this.ringsBuf = d.createBuffer({ size: Math.max(256, a.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'rings' });
    }
    d.queue.writeBuffer(this.ringsBuf, 0, a);
    return rings.length;
  }

  private encodePyramid(enc: GPUCommandEncoder, t: Targets, out: 'acc' | 'accR'): void {
    const d = this.device;
    const label = out === 'acc' ? 'glare pyramid (retina)' : 'glare pyramid (painted)';
    const pass = enc.beginComputePass({ label, timestampWrites: this.tsw(label) });
    const run = (pipe: GPUComputePipeline, w: number, h: number, entries: GPUBindGroupEntry[]) => {
      pass.setPipeline(pipe);
      pass.setBindGroup(0, d.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries }));
      pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    };
    const L = t.levels;
    if (out === 'acc') {
      run(this.pyr.combine, t.W, t.H, [
        { binding: 0, resource: t.ext.createView() },
        { binding: 1, resource: t.pt.createView() },
        { binding: 2, resource: L[0].lvl.createView() },
      ]);
    } else {
      run(this.overflowPipe, t.W, t.H, [
        { binding: 0, resource: { buffer: this.frameUB } },
        { binding: 1, resource: { buffer: this.eyeUB } },
        { binding: 2, resource: t.ext.createView() },
        { binding: 3, resource: t.w.createView() },
        { binding: 4, resource: t.ptEx.createView() },
        { binding: 5, resource: L[0].lvl.createView() },
      ]);
    }
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
        { binding: 1, resource: (k + 1 < L.length ? L[k + 1][out] : t.zero).createView() },
        { binding: 2, resource: L[k][out].createView() },
        { binding: 3, resource: { buffer: out === 'acc' ? L[k].ub : L[k].ubR } },
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
