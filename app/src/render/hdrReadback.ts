// Readback of the HDR XYZS target (EXT) for validation (docs/reports/validation.md §1): the renderer's absolute
// radiance before the eye model, as the ground-truth cases in validation/ compare it. Used through
// Renderer.readHdrRegion / Renderer.readHdr (the marked validation hook in renderer.ts).
//
// EXT holds what the renderer draws as extended light: resolved bodies, rings, atmospheres, the sky background
// (when one is set) and the solar disk. Point sources (stars, unresolved bodies) are splatted with the eye's
// optical core into another target and are not included. The values are X, Y, Z in cd/m² and S in scotopic
// cd/m²; with rgba16float targets they are stored pre-exposed, which `scale` undoes.
//
// A compute pass copies the texels into a storage buffer as float32 (the same code for rgba32float and
// rgba16float), which is mapped and reduced in float64 on the CPU.

export type HdrRect = [x0: number, y0: number, x1: number, y1: number];

export interface HdrRegionStats {
  /** Mean X, Y, Z, S over the finite pixels of the rectangle. */
  mean: [number, number, number, number];
  /** Population standard deviation per channel. */
  std: [number, number, number, number];
  /** Number of finite pixels used. */
  n: number;
}

export interface HdrImage {
  width: number;
  height: number;
  /** width × height × 4 (X, Y, Z, S), row-major from the top-left pixel, absolute units. */
  data: Float32Array;
}

const SHADER = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<vec4f>;
@group(0) @binding(2) var<uniform> P: vec4u;  // x0, y0, width, height of the rectangle
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= P.z || id.y >= P.w) { return; }
  dst[id.y * P.z + id.x] = textureLoad(src, vec2u(P.x + id.x, P.y + id.y), 0);
}`;

export class HdrReadback {
  private pipeline: GPUComputePipeline | null = null;
  private layout: GPUBindGroupLayout | null = null;

  constructor(private readonly device: GPUDevice) {}

  private ensurePipeline(): { pipeline: GPUComputePipeline; layout: GPUBindGroupLayout } {
    if (!this.pipeline || !this.layout) {
      const d = this.device;
      this.layout = d.createBindGroupLayout({
        label: 'hdr readback',
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
          { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        ],
      });
      this.pipeline = d.createComputePipeline({
        label: 'hdr readback',
        layout: d.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
        compute: { module: d.createShaderModule({ code: SHADER, label: 'hdr readback' }), entryPoint: 'main' },
      });
    }
    return { pipeline: this.pipeline, layout: this.layout };
  }

  /** The texels of `rect` (clipped to the texture) as float32 X, Y, Z, S, multiplied by `scale`. */
  async read(texture: GPUTexture, rect: HdrRect, scale: number): Promise<HdrImage> {
    const x0 = Math.max(0, Math.min(texture.width, Math.floor(rect[0])));
    const y0 = Math.max(0, Math.min(texture.height, Math.floor(rect[1])));
    const x1 = Math.max(x0, Math.min(texture.width, Math.ceil(rect[2])));
    const y1 = Math.max(y0, Math.min(texture.height, Math.ceil(rect[3])));
    const w = x1 - x0, h = y1 - y0;
    if (w === 0 || h === 0) return { width: w, height: h, data: new Float32Array(0) };
    const d = this.device;
    const { pipeline, layout } = this.ensurePipeline();
    const bytes = w * h * 16;
    const storage = d.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, label: 'hdr readback' });
    const staging = d.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, label: 'hdr readback staging' });
    const params = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(params, 0, new Uint32Array([x0, y0, w, h]));
    const enc = d.createCommandEncoder({ label: 'hdr readback' });
    const pass = enc.beginComputePass({ label: 'hdr readback' });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, d.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: texture.createView() },
        { binding: 1, resource: { buffer: storage } },
        { binding: 2, resource: { buffer: params } },
      ],
    }));
    pass.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    pass.end();
    enc.copyBufferToBuffer(storage, 0, staging, 0, bytes);
    d.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const data = new Float32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    for (const b of [storage, staging, params]) b.destroy();
    if (scale !== 1) for (let i = 0; i < data.length; i++) data[i] *= scale;
    return { width: w, height: h, data };
  }

  /** Mean, standard deviation and count of the finite pixels of `rect`, per channel, in float64. */
  async region(texture: GPUTexture, rect: HdrRect, scale: number): Promise<HdrRegionStats> {
    return regionStats(await this.read(texture, rect, scale));
  }
}

/** Per-channel mean and population standard deviation of the pixels whose four channels are finite. */
export function regionStats(img: HdrImage): HdrRegionStats {
  const s = [0, 0, 0, 0], s2 = [0, 0, 0, 0];
  let n = 0;
  const a = img.data;
  for (let i = 0; i + 3 < a.length; i += 4) {
    if (!(Number.isFinite(a[i]) && Number.isFinite(a[i + 1]) && Number.isFinite(a[i + 2]) && Number.isFinite(a[i + 3]))) continue;
    for (let c = 0; c < 4; c++) { s[c] += a[i + c]; s2[c] += a[i + c] * a[i + c]; }
    n++;
  }
  const mean = s.map((v) => (n ? v / n : NaN)) as HdrRegionStats['mean'];
  const std = s2.map((v, c) => (n ? Math.sqrt(Math.max(0, v / n - mean[c] * mean[c])) : NaN)) as HdrRegionStats['std'];
  return { mean, std, n };
}
