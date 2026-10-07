// Extra point sources fed through the star path (Renderer.setExtraPointSources): a GPU buffer of records whose first
// seven float32 are the star layout [dirX, dirY, dirZ, X, Y, Z, S] (ICRF unit vector from the camera, illuminance at
// the eye in lux), `strideFloats` floats per record (e.g. the small-body field's 8: the 8th holds its object index).
// The buffer is produced on the GPU each frame by its owner; the renderer only reads it. The records go through the
// same cull (visibility threshold against the local background, eye model) and point rendering as the stars (every
// record in the frame adds its light to the physical point image; the cull decides which are displayed as points),
// with the same limitations: points are drawn at infinite depth, so a resolved body occludes them even when they
// are in front of it.

export interface PointSourceBuffer {
  buffer: GPUBuffer;
  count: number;
  strideFloats: number;
}

/** Bindings of the star cull pass (CULL_SHADER) other than the source buffer and its info block. */
export interface CullBindings {
  frameUB: GPUBuffer;
  eyeUB: GPUBuffer;
  visible: GPUBuffer;
  /** The records in the frame that fail the visibility test (light in the point image, not displayed). */
  unseen: GPUBuffer;
  args: GPUBuffer;
  bgView: GPUTextureView;
  srcs: GPUBuffer;
  /** Atmospheric limbs (CULL_SHADER Limbs). */
  limbs: GPUBuffer;
  maxVisible: number;
}

export class ExtraPointSources {
  private src: PointSourceBuffer | null = null;
  private info: GPUBuffer | null = null;

  constructor(private readonly device: GPUDevice) {}

  get count(): number {
    return this.src?.count ?? 0;
  }

  set(src: PointSourceBuffer | null): void {
    if (src && (src.strideFloats < 7 || src.count < 0)) throw new Error('extra point sources: need >= 7 floats per record');
    this.src = src && src.count > 0 ? src : null;
    if (this.src && !this.info) {
      this.info = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'extra points info' });
    }
  }

  /** Dispatch the star cull over the extra records inside an open compute pass whose pipeline is the cull pipeline. */
  cull(pass: GPUComputePassEncoder, pipeline: GPUComputePipeline, b: CullBindings): void {
    const s = this.src;
    if (!s || !this.info) return;
    const groups = Math.ceil(s.count / 256);
    const gx = Math.min(groups, 65535);
    const gy = Math.ceil(groups / gx);
    this.device.queue.writeBuffer(this.info, 0, new Uint32Array([s.count, s.strideFloats, b.maxVisible, gx]));
    pass.setBindGroup(0, this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: b.frameUB } },
        { binding: 1, resource: { buffer: b.eyeUB } },
        { binding: 2, resource: { buffer: s.buffer } },
        { binding: 3, resource: { buffer: b.visible } },
        { binding: 4, resource: { buffer: b.args } },
        { binding: 5, resource: b.bgView },
        { binding: 6, resource: { buffer: this.info } },
        { binding: 7, resource: { buffer: b.srcs } },
        { binding: 8, resource: { buffer: b.limbs } },
        { binding: 9, resource: { buffer: b.unseen } },
      ],
    }));
    pass.dispatchWorkgroups(gx, gy);
  }
}
