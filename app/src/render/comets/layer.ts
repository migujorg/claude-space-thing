// CometLayer: the GPU side of comets (./model.ts has the physics, ./shaders.ts the WGSL). The renderer calls encode()
// once per frame after the bodies pass, with the frame's comets (SceneSnapshot.comets: those the app shell decided to
// draw extended — the rest stay points of the small-body field). Tails are drawn additively into EXT (absolute
// luminance), depth-tested against the bodies. A coma is drawn there too when its half-light disc exceeds the eye's
// Ricco area; a smaller one is seen as a point (its flux summed over the Ricco area, as for the field's points), so it
// joins the renderer's point sources with its total light instead: the same eye path as before, now with the coma's
// colour. (A W weight would dim everything behind a transparent coma.)

import type { CometModelProduct } from '../../data/schema';
import type { SceneComet } from '../scene';
import type { PointSource } from '../frame';
import { camToNdc, toCam, type CameraGeom } from '../overlays';
import {
  coma, comaExtentKm, comaLut, dustTailGeometry, dustTailLight, halfLightRadiusKm, ionTail, LUT_SIZE,
  type Coma, type CometInput, type DustPacketGeometry, type TailPacket, type V3,
} from './model';
import { COMA_SHADER, PACKET_SHADER } from './shaders';
import { LIMBS_UB_BYTES } from '../shaders';

export interface CometTargets {
  ext: GPUTexture;
  depth: GPUTexture;
}

export interface CometFrameStats {
  comae: number;
  packets: number;
  /** Per comet: what was drawn (for the inspector and tests). */
  drawn: { id: number; m1: number; radiusKm: number; gasFractionV: number; packets: number; comaAsPoint: boolean }[];
}

/** The coma and tails of one comet as seen from the camera (physics only; used by encode and by the app shell). */
export interface CometView {
  input: CometInput;
  coma: Coma;
}

export function cometInput(sc: SceneComet): CometInput {
  const observer: V3 = [sc.helioPos[0] - sc.rel[0], sc.helioPos[1] - sc.rel[1], sc.helioPos[2] - sc.rel[2]];
  return { M1: sc.M1, K1: sc.K1, activity: sc.activity, dust: sc.dust, helioPos: sc.helioPos, helioVel: sc.helioVel, observer };
}

export class CometLayer {
  private comaPipe: GPURenderPipeline;
  private packetPipe: GPURenderPipeline;
  private comaBuf: GPUBuffer | null = null;
  private noLimbs: GPUBuffer | null = null;
  private lutBuf: GPUBuffer | null = null;
  private packetBuf: GPUBuffer | null = null;
  private geoCache = new Map<number, { et: number; pos: V3; geo: DustPacketGeometry[] }>();
  stats: CometFrameStats = { comae: 0, packets: 0, drawn: [] };

  constructor(private readonly device: GPUDevice, readonly model: CometModelProduct, hdrFormat: GPUTextureFormat) {
    const add: GPUBlendState = { color: { operation: 'add', srcFactor: 'one', dstFactor: 'one' }, alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one' } };
    const pipe = (code: string, label: string) => {
      const m = device.createShaderModule({ code, label });
      return device.createRenderPipeline({
        label, layout: 'auto',
        vertex: { module: m, entryPoint: 'vs' },
        fragment: { module: m, entryPoint: 'fs', targets: [{ format: hdrFormat, blend: add }] },
        primitive: { topology: 'triangle-list' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'greater-equal' },
      });
    };
    this.comaPipe = pipe(COMA_SHADER, 'comet coma');
    this.packetPipe = pipe(PACKET_SHADER, 'comet tails');
  }

  private buffer(name: 'comaBuf' | 'lutBuf' | 'packetBuf', bytes: number): GPUBuffer {
    const cur = this[name];
    if (cur && cur.size >= bytes) return cur;
    cur?.destroy();
    const b = this.device.createBuffer({ size: Math.max(256, 2 ** Math.ceil(Math.log2(bytes))), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: name });
    this[name] = b;
    return b;
  }

  /** Dust-tail geometry of a comet at et, cached while the comet does not move (paused time, repeated frames). */
  private dustGeometry(sc: SceneComet, et: number, c: Coma): DustPacketGeometry[] {
    const hit = this.geoCache.get(sc.id);
    if (hit && hit.et === et && hit.pos[0] === sc.helioPos[0] && hit.pos[1] === sc.helioPos[1] && hit.pos[2] === sc.helioPos[2]) return hit.geo;
    const geo = dustTailGeometry(this.model, { helioPos: sc.helioPos, helioVel: sc.helioVel, K1: sc.K1 }, c);
    this.geoCache.set(sc.id, { et, pos: [...sc.helioPos] as V3, geo });
    return geo;
  }

  /**
   * Draw this frame's comets. `points` receives the comae smaller than the Ricco area (drawn by the renderer's point
   * pass); opts.comaAsPoint false forces every coma into EXT (tests).
   */
  encode(enc: GPUCommandEncoder, t: CometTargets, frameUB: GPUBuffer, et: number, comets: SceneComet[], cam: CameraGeom, riccoAreaSr: number,
    points: PointSource[], opts: { tails?: boolean; comaAsPoint?: boolean; timestampWrites?: () => GPURenderPassTimestampWrites | undefined; limbs?: GPUBuffer } = {}): void {
    const pixelAngle = cam.pixelAngle;
    const m = this.model;
    const comaData = new Float32Array(comets.length * 16);
    const luts = new Float32Array(comets.length * LUT_SIZE * 4);
    const packets: number[] = [];
    const drawn: CometFrameStats['drawn'] = [];
    const seen = new Set<number>();
    let nComae = 0;
    comets.forEach((sc) => {
      seen.add(sc.id);
      const input = cometInput(sc);
      const c = coma(m, input);
      const d = Math.hypot(sc.rel[0], sc.rel[1], sc.rel[2]);
      const halfLight = halfLightRadiusKm(m, c) / d;
      const asPoint = opts.comaAsPoint !== false && Math.PI * halfLight * halfLight < riccoAreaSr;
      if (asPoint) {
        const cc = toCam(cam, sc.rel);
        if (cc[2] < 0) points.push({ ndc: camToNdc(cam, cc), depth: cam.near / -cc[2], E: [...c.total] as [number, number, number, number] });
      } else {
        const i = nComae++;
        const extKm = comaExtentKm(m, c);
        const lut = comaLut(m, c, extKm);
        luts.set(lut.values, i * LUT_SIZE * 4);
        const n: V3 = [sc.rel[0] / d, sc.rel[1] / d, sc.rel[2] / d];
        // tangent-plane axes along the pixel grid (camera right and up, projected), for the shader's exact near cells
        const rn = cam.right[0] * n[0] + cam.right[1] * n[1] + cam.right[2] * n[2];
        const e1 = normalize([cam.right[0] - rn * n[0], cam.right[1] - rn * n[1], cam.right[2] - rn * n[2]]);
        const e2 = cross(n, e1);
        const half = Math.tan(Math.min(extKm / d, 1.2)) + 2 * pixelAngle;
        comaData.set([...n, d, ...e1, half, ...e2, 0, lut.theta0, Math.log(lut.theta1 / lut.theta0), i * LUT_SIZE, 0], i * 16);
      }
      const tail: TailPacket[] = opts.tails === false ? [] : [
        ...dustTailLight(m, this.dustGeometry(sc, et, c), input, c),
        ...ionTail(m, input, c),
      ];
      for (const p of tail) {
        if (!(p.xyzs[1] > 0 || p.xyzs[3] > 0)) continue;
        packets.push(sc.rel[0] + p.pos[0] - sc.helioPos[0], sc.rel[1] + p.pos[1] - sc.helioPos[1], sc.rel[2] + p.pos[2] - sc.helioPos[2], p.sigmaKm, ...p.xyzs);
      }
      drawn.push({ id: sc.id, m1: c.m1, radiusKm: c.radiusKm, gasFractionV: c.gasFractionV, packets: tail.length, comaAsPoint: asPoint });
    });
    for (const id of this.geoCache.keys()) if (!seen.has(id)) this.geoCache.delete(id);
    const nPackets = packets.length / 8;
    this.stats = { comae: nComae, packets: nPackets, drawn };
    if (!nComae && !nPackets) return;
    const d = this.device;
    const comaBuf = this.buffer('comaBuf', comaData.byteLength);
    d.queue.writeBuffer(comaBuf, 0, comaData);
    const lutBuf = this.buffer('lutBuf', luts.byteLength);
    d.queue.writeBuffer(lutBuf, 0, luts);
    // The atmospheres' limbs (shaders.ts LIMB_WGSL; renderer.ts writeLimbs); none without the renderer's uniform.
    const limbs = opts.limbs ?? (this.noLimbs ??= d.createBuffer({ size: LIMBS_UB_BYTES, usage: GPUBufferUsage.UNIFORM, label: 'comet no limbs' }));
    const pass = enc.beginRenderPass({
      label: 'comets',
      timestampWrites: opts.timestampWrites?.(),
      colorAttachments: [{ view: t.ext.createView(), loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: t.depth.createView(), depthReadOnly: true },
    });
    if (nPackets) {
      const pk = new Float32Array(packets);
      const packetBuf = this.buffer('packetBuf', pk.byteLength);
      d.queue.writeBuffer(packetBuf, 0, pk);
      pass.setPipeline(this.packetPipe);
      pass.setBindGroup(0, d.createBindGroup({ layout: this.packetPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: frameUB } }, { binding: 1, resource: { buffer: packetBuf } }, { binding: 2, resource: { buffer: limbs } }] }));
      pass.draw(6, nPackets);
    }
    if (nComae) {
      pass.setPipeline(this.comaPipe);
      pass.setBindGroup(0, d.createBindGroup({
        layout: this.comaPipe.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: frameUB } }, { binding: 1, resource: { buffer: comaBuf } }, { binding: 2, resource: { buffer: lutBuf } }, { binding: 3, resource: { buffer: limbs } }],
      }));
      pass.draw(6, nComae);
    }
    pass.end();
  }

  destroy(): void {
    this.noLimbs?.destroy();
    this.comaBuf?.destroy();
    this.lutBuf?.destroy();
    this.packetBuf?.destroy();
  }
}

function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
}
