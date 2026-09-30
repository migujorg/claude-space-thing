// Sky background on the GPU: extended sky light added to the renderer's EXT target (absolute XYZS luminance,
// cd/m² and scotopic cd/m²) wherever no body is in front, right after the bodies pass, so that it takes part in
// the glare veil, the adaptation measurement and the local background of every point source like any other
// light in the scene.
//
//   sky = faintStars (Gaia G ≥ 14)  +  diffuse (Pioneer-anchored remainder)  +  deep-tier light not drawn as
//         points (deepRemainder slice of each tile's load level)  +  catalogue stars fainter than the point
//         cut (binned on the CPU, sky.ts)  +  zodiacal light (Kelsall cloud, line-of-sight integrated here)
//
// The four HEALPix maps are composed into one cube map (rgba16float, luminance × MAP_SCALE) only when their
// inputs change: each texel averages the maps over a small disc of about one source pixel (a tent-like
// reconstruction, so the HEALPix pixel grid does not show), and a mip chain box-filters it for minification.
// The background pass samples the cube at the level of detail of the screen pixel's footprint. Zodiacal light
// is integrated per frame (when the observer or the view changed) on a coarse screen-aligned grid (one ray per
// ZODI_STEP pixels) and interpolated bilinearly.

import { COMMON, LIMB_WGSL } from '../shaders';
import { HEALPIX_WGSL, npix } from './healpix';
import { zodiacalWgsl, OBLIQUITY_J2000_RAD, type ZodiParams } from './zodiacal';
import type { SceneSnapshot } from '../scene';

/** Luminance scale in the rgba16float cube (µcd/m²): keeps sky values (1e-7 … 1e-2 cd/m²) in fp16 range. */
export const MAP_SCALE = 1e6;
export const ZODI_STEP = 16;
const SAMPLES = 12;

export interface SkyMapsGpuInput {
  /** order 8 × XYZS (cd/m²), faint stars */
  faint: Float32Array | null;
  /** order 6 × XYZS, diffuse remainder */
  diffuse: Float32Array | null;
  /** 4 slices × order 7 × XYZS, deep-tier light not loaded at each tile level */
  remainder: Float32Array | null;
  /** HEALPix order of the deep tiles (remainder slices are indexed by the tile's load level). */
  tileOrder: number;
}

export interface BackgroundTargets {
  ext: GPUTexture;
  depth: GPUTexture;
  frameUB: GPUBuffer;
  /** The atmospheres' limbs (shaders.ts LIMB_WGSL): the sky behind them is dimmed by the chord's transmittance. */
  limbs: GPUBuffer;
  W: number;
  H: number;
  snapshot: SceneSnapshot;
}

/** What the renderer calls (Renderer.setBackground). */
export interface SkyBackgroundHook {
  encode(enc: GPUCommandEncoder, t: BackgroundTargets): void;
}

export interface SkyBackgroundStats {
  composes: number;
  zodiUpdates: number;
  cubeSize: number;
}

const ORDER_FAINT = 8;
const ORDER_REM = 7;
const ORDER_DIFF = 6;

const COMPOSE_WGSL = (tileOrder: number) => HEALPIX_WGSL + /* wgsl */ `
struct CU { n: u32, samples: u32, npix7: u32, flags: u32, radii: vec4f, scale: vec4f };
@group(0) @binding(0) var<uniform> U: CU;
@group(0) @binding(1) var<storage, read> faint: array<vec4f>;
@group(0) @binding(2) var<storage, read> diffuse: array<vec4f>;
@group(0) @binding(3) var<storage, read> rem: array<vec4f>;
@group(0) @binding(4) var<storage, read> stars: array<vec4f>;
@group(0) @binding(5) var<storage, read> tileLevel: array<u32>;
@group(0) @binding(6) var outTex: texture_storage_2d_array<rgba16float, write>;

/** Cube-face texel → direction (WebGPU/Vulkan cube conventions: s right, t down on each face). */
fn faceDir(face: u32, sc: f32, tc: f32) -> vec3f {
  switch face {
    case 0u: { return vec3f(1.0, -tc, -sc); }
    case 1u: { return vec3f(-1.0, -tc, sc); }
    case 2u: { return vec3f(sc, 1.0, tc); }
    case 3u: { return vec3f(sc, -1.0, -tc); }
    case 4u: { return vec3f(sc, -tc, 1.0); }
    default: { return vec3f(-sc, -tc, -1.0); }
  }
}

@compute @workgroup_size(8, 8) fn compose(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= U.n || id.y >= U.n) { return; }
  let sc = (f32(id.x) + 0.5) / f32(U.n) * 2.0 - 1.0;
  let tc = (f32(id.y) + 0.5) / f32(U.n) * 2.0 - 1.0;
  let d = normalize(faceDir(id.z, sc, tc));
  var a = vec3f(0.0, 0.0, 1.0);
  if (abs(d.z) > 0.9) { a = vec3f(1.0, 0.0, 0.0); }
  let e1 = normalize(cross(d, a));
  let e2 = cross(d, e1);
  var sum = vec4f(0.0);
  for (var k = 0u; k < U.samples; k = k + 1u) {
    // Vogel disc: uniform coverage of the unit disc
    let r = sqrt((f32(k) + 0.5) / f32(U.samples));
    let th = f32(k) * 2.39996323;
    let o = (e1 * cos(th) + e2 * sin(th)) * r;
    if ((U.flags & 1u) != 0u) { sum = sum + faint[hpxVec2Pix(${ORDER_FAINT}u, d + o * U.radii.x)]; }
    // binned sub-threshold stars: spread over the wider disc (~0.3°), close to the dark-adapted Ricco scale
    if ((U.flags & 8u) != 0u) { sum = sum + stars[hpxVec2Pix(${ORDER_FAINT}u, d + o * U.radii.y)]; }
    if ((U.flags & 2u) != 0u) { sum = sum + diffuse[hpxVec2Pix(${ORDER_DIFF}u, d + o * U.radii.z)]; }
    if ((U.flags & 4u) != 0u) {
      let p7 = hpxVec2Pix(${ORDER_REM}u, d + o * U.radii.y);
      let lvl = tileLevel[p7 >> ${2 * (ORDER_REM - tileOrder)}u];
      if (lvl < 4u) { sum = sum + rem[lvl * U.npix7 + p7]; }
    }
  }
  textureStore(outTex, vec2i(id.xy), i32(id.z), sum / f32(U.samples) * U.scale.x);
}
`;

const MIP_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d_array<f32>;
@group(0) @binding(1) var dst: texture_storage_2d_array<rgba16float, write>;
@compute @workgroup_size(8, 8) fn down(@builtin(global_invocation_id) id: vec3u) {
  let n = textureDimensions(dst).x;
  if (id.x >= n || id.y >= n) { return; }
  let s = vec2i(id.xy) * 2;
  let f = i32(id.z);
  let v = textureLoad(src, s, f, 0) + textureLoad(src, s + vec2i(1, 0), f, 0) + textureLoad(src, s + vec2i(0, 1), f, 0) + textureLoad(src, s + vec2i(1, 1), f, 0);
  textureStore(dst, vec2i(id.xy), f, 0.25 * v);
}
`;

const ZODI_COMPUTE_WGSL = (m: ZodiParams) => COMMON + zodiacalWgsl(m) + /* wgsl */ `
struct ZU { obs: vec4f, sunDir: vec4f, grid: vec4u, eclY: vec4f, eclZ: vec4f };
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> Z: ZU;
@group(0) @binding(2) var outZ: texture_storage_2d<rgba32float, write>;
@compute @workgroup_size(8, 8) fn zodi(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= Z.grid.x || id.y >= Z.grid.y) { return; }
  let px = vec2f(id.xy) * f32(Z.grid.z);
  let d = normalize(worldDirNdc(F, ndcFromFrag(F, px)));
  // ICRF → helio-ecliptic J2000
  let de = vec3f(d.x, dot(Z.eclY.xyz, d), dot(Z.eclZ.xyz, d));
  let I = zodiI(Z.obs.xyz, de, Z.obs.w);
  let eps = acos(clamp(dot(d, Z.sunDir.xyz), -1.0, 1.0));
  var L = zodiXYZS(I, eps);
  if (Z.sunDir.w < 0.5) { L = vec4f(0.0); }
  textureStore(outZ, vec2i(id.xy), L);
}
`;

const BG_WGSL = COMMON + /* wgsl */ `
struct BU { scaleInv: f32, texelAngle: f32, zodiStep: f32, flags: u32, zodiSize: vec2u, pad: vec2u };
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var cube: texture_cube<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var zodiTex: texture_2d<f32>;
@group(0) @binding(4) var<uniform> B: BU;
${LIMB_WGSL(5)}

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  return vec4f(p, 0.0, 1.0);   // depth 0: only where the (reversed-Z) depth is still cleared, i.e. no body
}

fn zodiAt(p: vec2f) -> vec4f {
  let g = p / B.zodiStep;
  let g0 = vec2u(floor(g));
  let f = fract(g);
  let mx = B.zodiSize - vec2u(1u);
  let a = textureLoad(zodiTex, min(g0, mx), 0);
  let b = textureLoad(zodiTex, min(g0 + vec2u(1u, 0u), mx), 0);
  let c = textureLoad(zodiTex, min(g0 + vec2u(0u, 1u), mx), 0);
  let d = textureLoad(zodiTex, min(g0 + vec2u(1u, 1u), mx), 0);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let d = normalize(worldDirNdc(F, ndcFromFrag(F, pos.xy)));
  var L = vec4f(0.0);
  if ((B.flags & 1u) != 0u) {
    let lod = max(0.0, log2(F.tanHalf.z / B.texelAngle));
    L = L + textureSampleLevel(cube, samp, d, lod) * B.scaleInv;
  }
  if ((B.flags & 2u) != 0u) { L = L + zodiAt(pos.xy); }
  // Seen through an atmosphere's limb (the zodiacal light too: nearly all of it comes from beyond the planet).
  L = L * limbTransmittance(d);
  return toStore(F, max(L, vec4f(0.0)));
}
`;

export class SkyBackground implements SkyBackgroundHook {
  readonly stats: SkyBackgroundStats = { composes: 0, zodiUpdates: 0, cubeSize: 0 };
  /** Debug switches: which parts to draw. */
  showMaps = true;
  showZodiacal = true;

  private cube: GPUTexture;
  private sampler: GPUSampler;
  private composeUB: GPUBuffer;
  private bgUB: GPUBuffer;
  private zodiUB: GPUBuffer;
  private faintBuf: GPUBuffer;
  private diffBuf: GPUBuffer;
  private remBuf: GPUBuffer;
  private starBuf: GPUBuffer;
  private tileBuf: GPUBuffer;
  private flags = 0;
  private have = 0;
  private dirty = true;
  private composePipe: GPUComputePipeline;
  private mipPipe: GPUComputePipeline;
  private zodiPipe: GPUComputePipeline | null = null;
  private bgPipe: GPURenderPipeline | null = null;
  private bgFormat: GPUTextureFormat | null = null;
  private zodiTex: GPUTexture | null = null;
  private zodiKey = '';
  private zodiOn = false;
  private readonly levels: number;

  constructor(private readonly device: GPUDevice, maps: SkyMapsGpuInput, zodi: ZodiParams | null, readonly cubeSize = 512) {
    const d = device;
    this.stats.cubeSize = cubeSize;
    this.levels = Math.log2(cubeSize) + 1;
    this.cube = d.createTexture({
      label: 'sky cube', size: [cubeSize, cubeSize, 6], format: 'rgba16float', mipLevelCount: this.levels,
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.sampler = d.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
    const ub = (size: number) => d.createBuffer({ size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.composeUB = ub(48);
    this.bgUB = ub(32);
    this.zodiUB = ub(80);
    const sto = (data: Float32Array | null, fallbackBytes: number) => {
      const size = Math.max(16, data ? data.byteLength : fallbackBytes);
      const b = d.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      if (data) d.queue.writeBuffer(b, 0, data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
      return b;
    };
    this.faintBuf = sto(maps.faint, 16);
    this.diffBuf = sto(maps.diffuse, 16);
    this.remBuf = sto(maps.remainder, 16);
    this.starBuf = sto(null, npix(ORDER_FAINT) * 16);
    this.tileBuf = d.createBuffer({ size: Math.max(16, npix(maps.tileOrder) * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.have = (maps.faint ? 1 : 0) | (maps.diffuse ? 2 : 0) | (maps.remainder ? 4 : 0);
    this.flags = this.have;
    const mod = (code: string, label: string) => d.createShaderModule({ code, label });
    this.composePipe = d.createComputePipeline({ label: 'sky compose', layout: 'auto', compute: { module: mod(COMPOSE_WGSL(maps.tileOrder), 'sky compose'), entryPoint: 'compose' } });
    this.mipPipe = d.createComputePipeline({ label: 'sky mips', layout: 'auto', compute: { module: mod(MIP_WGSL, 'sky mips'), entryPoint: 'down' } });
    if (zodi) this.zodiPipe = d.createComputePipeline({ label: 'zodiacal', layout: 'auto', compute: { module: mod(ZODI_COMPUTE_WGSL(zodi), 'zodiacal'), entryPoint: 'zodi' } });
  }

  /** Which map layers to draw (e.g. by the reality level: a layer whose label is not admitted is not drawn). */
  setLayers(on: { faint: boolean; diffuse: boolean; remainder: boolean }): void {
    const f = (on.faint && this.have & 1 ? 1 : 0) | (on.diffuse && this.have & 2 ? 2 : 0) | (on.remainder && this.have & 4 ? 4 : 0);
    if ((this.flags & 7) !== f) {
      this.flags = (this.flags & 8) | f;
      this.dirty = true;
    }
  }

  /** CPU-binned catalogue stars (order-8 XYZS per sr) and each deep tile's load level (0 = none … 4 = all). */
  setDynamic(stars: Float32Array | null, tileLevels: Uint32Array): void {
    const d = this.device;
    if (stars) d.queue.writeBuffer(this.starBuf, 0, stars.buffer as ArrayBuffer, stars.byteOffset, stars.byteLength);
    d.queue.writeBuffer(this.tileBuf, 0, tileLevels.buffer as ArrayBuffer, tileLevels.byteOffset, tileLevels.byteLength);
    this.flags = (this.flags & 7) | (stars ? 8 : 0);
    this.dirty = true;
  }

  get pending(): boolean {
    return this.dirty;
  }

  /** Encode the background into EXT (called by the renderer right after the bodies pass). */
  encode(enc: GPUCommandEncoder, t: BackgroundTargets): void {
    const d = this.device;
    if (this.dirty) this.compose(enc);
    const zodiOn = this.showZodiacal && !!this.zodiPipe && this.updateZodi(enc, t);
    const fmt = t.ext.format;
    if (!this.bgPipe || this.bgFormat !== fmt) {
      const add: GPUBlendState = { color: { operation: 'add', srcFactor: 'one', dstFactor: 'one' }, alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one' } };
      const m = d.createShaderModule({ code: BG_WGSL, label: 'sky background' });
      this.bgPipe = d.createRenderPipeline({
        label: 'sky background', layout: 'auto',
        vertex: { module: m, entryPoint: 'vs' },
        fragment: { module: m, entryPoint: 'fs', targets: [{ format: fmt, blend: add }] },
        primitive: { topology: 'triangle-list' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'greater-equal' },
      });
      this.bgFormat = fmt;
    }
    if (!this.zodiTex) this.zodiTex = d.createTexture({ size: [1, 1], format: 'rgba32float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
    const texelAngle = Math.PI / 2 / this.cubeSize;
    const u = new ArrayBuffer(32);
    new Float32Array(u, 0, 3).set([1 / MAP_SCALE, texelAngle, ZODI_STEP]);
    new Uint32Array(u, 12, 3).set([(this.showMaps ? 1 : 0) | (zodiOn ? 2 : 0), this.zodiTex.width, this.zodiTex.height]);
    d.queue.writeBuffer(this.bgUB, 0, u);
    const pass = enc.beginRenderPass({
      label: 'sky background',
      colorAttachments: [{ view: t.ext.createView(), loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: t.depth.createView(), depthReadOnly: true },
    });
    pass.setPipeline(this.bgPipe);
    pass.setBindGroup(0, d.createBindGroup({
      layout: this.bgPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: t.frameUB } },
        { binding: 1, resource: this.cube.createView({ dimension: 'cube' }) },
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: this.zodiTex.createView() },
        { binding: 4, resource: { buffer: this.bgUB } },
        { binding: 5, resource: { buffer: t.limbs } },
      ],
    }));
    pass.draw(3);
    pass.end();
  }

  private compose(enc: GPUCommandEncoder): void {
    const d = this.device;
    const N = this.cubeSize;
    const u = new ArrayBuffer(48);
    const px = (o: number) => Math.sqrt((4 * Math.PI) / npix(o));
    new Uint32Array(u, 0, 4).set([N, SAMPLES, npix(ORDER_REM), this.flags]);
    // disc radius ≈ 0.7 source pixel (0.9 for the 3°-resolution diffuse layer), never below a cube texel
    const tex = Math.PI / 2 / N;
    new Float32Array(u, 16, 8).set([Math.max(0.7 * px(ORDER_FAINT), tex), Math.max(0.7 * px(ORDER_REM), tex), Math.max(0.9 * px(ORDER_DIFF), tex), 0, MAP_SCALE, 0, 0, 0]);
    d.queue.writeBuffer(this.composeUB, 0, u);
    const pass = enc.beginComputePass({ label: 'sky compose' });
    pass.setPipeline(this.composePipe);
    pass.setBindGroup(0, d.createBindGroup({
      layout: this.composePipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.composeUB } },
        { binding: 1, resource: { buffer: this.faintBuf } },
        { binding: 2, resource: { buffer: this.diffBuf } },
        { binding: 3, resource: { buffer: this.remBuf } },
        { binding: 4, resource: { buffer: this.starBuf } },
        { binding: 5, resource: { buffer: this.tileBuf } },
        { binding: 6, resource: this.cube.createView({ dimension: '2d-array', baseMipLevel: 0, mipLevelCount: 1 }) },
      ],
    }));
    pass.dispatchWorkgroups(Math.ceil(N / 8), Math.ceil(N / 8), 6);
    pass.setPipeline(this.mipPipe);
    for (let l = 1; l < this.levels; l++) {
      const n = N >> l;
      pass.setBindGroup(0, d.createBindGroup({
        layout: this.mipPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.cube.createView({ dimension: '2d-array', baseMipLevel: l - 1, mipLevelCount: 1 }) },
          { binding: 1, resource: this.cube.createView({ dimension: '2d-array', baseMipLevel: l, mipLevelCount: 1 }) },
        ],
      }));
      pass.dispatchWorkgroups(Math.ceil(n / 8), Math.ceil(n / 8), 6);
    }
    pass.end();
    this.dirty = false;
    this.stats.composes++;
  }

  /** Zodiacal grid for this view; recomputed only when the observer, view or size changed. */
  private updateZodi(enc: GPUCommandEncoder, t: BackgroundTargets): boolean {
    const s = t.snapshot;
    if (!s.sun) return false;
    const d = this.device;
    const AU = 149597870.7;
    // observer heliocentric (ICRF, AU) = −(camera-relative Sun position)
    const oI = [-s.sun.pos[0] / AU, -s.sun.pos[1] / AU, -s.sun.pos[2] / AU];
    const c = Math.cos(OBLIQUITY_J2000_RAD), sn = Math.sin(OBLIQUITY_J2000_RAD);
    const oE = [oI[0], c * oI[1] + sn * oI[2], -sn * oI[1] + c * oI[2]];
    const r = Math.hypot(oI[0], oI[1], oI[2]);
    const sunDir = [-oI[0] / r, -oI[1] / r, -oI[2] / r];
    const T = s.et / (36525 * 86400);
    const earthLon = ((((100.46457166 + 35999.37244981 * T) % 360) + 360) % 360) * (Math.PI / 180);
    const gw = Math.ceil(t.W / ZODI_STEP) + 1, gh = Math.ceil(t.H / ZODI_STEP) + 1;
    const o = s.camera.orient;
    const key = [...oE.map((x) => x.toPrecision(7)), earthLon.toFixed(3), ...o.map((x) => x.toFixed(6)), s.camera.fovY.toFixed(6), gw, gh].join(',');
    if (key === this.zodiKey && this.zodiTex && this.zodiTex.width === gw) return this.zodiOn;
    this.zodiKey = key;
    if (!this.zodiTex || this.zodiTex.width !== gw || this.zodiTex.height !== gh) {
      this.zodiTex?.destroy();
      this.zodiTex = d.createTexture({ label: 'zodiacal grid', size: [gw, gh], format: 'rgba32float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
    }
    const u = new ArrayBuffer(80);
    const f = new Float32Array(u);
    f.set([oE[0], oE[1], oE[2], earthLon, sunDir[0], sunDir[1], sunDir[2], 1], 0);
    new Uint32Array(u, 32, 4).set([gw, gh, ZODI_STEP, 0]);
    f.set([0, c, sn, 0, 0, -sn, c, 0], 12);
    d.queue.writeBuffer(this.zodiUB, 0, u);
    const pass = enc.beginComputePass({ label: 'zodiacal light' });
    pass.setPipeline(this.zodiPipe!);
    pass.setBindGroup(0, d.createBindGroup({
      layout: this.zodiPipe!.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: t.frameUB } },
        { binding: 1, resource: { buffer: this.zodiUB } },
        { binding: 2, resource: this.zodiTex.createView() },
      ],
    }));
    pass.dispatchWorkgroups(Math.ceil(gw / 8), Math.ceil(gh / 8));
    pass.end();
    this.stats.zodiUpdates++;
    this.zodiOn = true;
    return true;
  }

  /**
   * Debug: sample the composed cube (hardware cube sampling at mip level `lod`) along ICRF directions, in cd/m²;
   * checks the face convention of the compose pass against the sampler's, and the flux through the mip chain.
   */
  async sampleCube(dirs: [number, number, number][], lod = 0): Promise<number[][]> {
    const d = this.device;
    const n = dirs.length;
    const code = /* wgsl */ `
@group(0) @binding(0) var cube: texture_cube<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<storage, read> dirs: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> outv: array<vec4f>;
@compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
  outv[id.x] = textureSampleLevel(cube, samp, dirs[id.x].xyz, dirs[id.x].w);
}`;
    const pipe = d.createComputePipeline({ layout: 'auto', compute: { module: d.createShaderModule({ code }), entryPoint: 'main' } });
    const inb = d.createBuffer({ size: n * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(inb, 0, new Float32Array(dirs.flatMap((v) => [v[0], v[1], v[2], lod])));
    const outb = d.createBuffer({ size: n * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const rb = d.createBuffer({ size: n * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = d.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipe);
    pass.setBindGroup(0, d.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: this.cube.createView({ dimension: 'cube' }) },
      { binding: 1, resource: this.sampler },
      { binding: 2, resource: { buffer: inb } },
      { binding: 3, resource: { buffer: outb } },
    ] }));
    pass.dispatchWorkgroups(n);
    pass.end();
    enc.copyBufferToBuffer(outb, 0, rb, 0, n * 16);
    d.queue.submit([enc.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const r = new Float32Array(rb.getMappedRange().slice(0));
    rb.unmap();
    for (const b of [inb, outb, rb]) b.destroy();
    return dirs.map((_, i) => [0, 1, 2, 3].map((k) => r[i * 4 + k] / MAP_SCALE));
  }

  /** Debug: the zodiacal grid as last computed (XYZS per grid point, row-major), or null. */
  async readZodi(): Promise<{ w: number; h: number; data: Float32Array } | null> {
    const tex = this.zodiTex;
    if (!tex || !this.zodiOn) return null;
    const d = this.device;
    const bpr = Math.ceil((tex.width * 16) / 256) * 256;
    const buf = d.createBuffer({ size: bpr * tex.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = d.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [tex.width, tex.height]);
    d.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const src = new Float32Array(buf.getMappedRange());
    const out = new Float32Array(tex.width * tex.height * 4);
    for (let y = 0; y < tex.height; y++) out.set(src.subarray((y * bpr) / 4, (y * bpr) / 4 + tex.width * 4), y * tex.width * 4);
    buf.unmap();
    buf.destroy();
    return { w: tex.width, h: tex.height, data: out };
  }

  destroy(): void {
    for (const b of [this.composeUB, this.bgUB, this.zodiUB, this.faintBuf, this.diffBuf, this.remBuf, this.starBuf, this.tileBuf]) b.destroy();
    this.cube.destroy();
    this.zodiTex?.destroy();
  }
}
