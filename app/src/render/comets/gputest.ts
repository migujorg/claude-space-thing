// GPU check of the coma shader (sb-test.html?mode=comet, run by scripts/sb-gpu.mjs): the real CometLayer draws the
// showcase comet's coma (app/tests/fixtures/comet_reference.json) into an offscreen HDR target; the read-back
// luminance times each pixel's solid angle, summed, must equal the coma's total illuminance (the M1/K1 law), for
// comae from 1 to 40 pixels in radius and nuclei on and off pixel centres. The same sum on the CPU mirror is
// tests/comets.test.ts.

import type { CometModelProduct } from '../../data/schema';
import type { SceneComet } from '../scene';
import { CometLayer, cometInput } from './layer';
import { activityOf, coma, enclosed, type V3 } from './model';

interface Fixture {
  comet: { M1: number; K1: number; name: string };
  ours: { helioKm: V3; helioVelKmS: V3; earthHelioKm: V3 }[];
  measured: { C2?: number; CN?: number; C3?: number; afrho?: number; sources: string[] } | null;
  model: CometModelProduct;
}

const W = 256, H = 256;

function basis(n: V3): { right: V3; up: V3; back: V3 } {
  const ref: V3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a: V3): V3 => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };
  const back: V3 = [-n[0], -n[1], -n[2]];
  const right = norm(cross(ref, back));
  const up = cross(back, right);
  return { right, up, back };
}

export async function cometGpuFlux(): Promise<unknown> {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('no WebGPU adapter');
  const f32 = adapter.features.has('float32-blendable');
  const dev = await adapter.requestDevice({ requiredFeatures: f32 ? ['float32-blendable'] : [] });
  const hdr: GPUTextureFormat = f32 ? 'rgba32float' : 'rgba16float';
  const fx = (await (await fetch('/tests/fixtures/comet_reference.json')).json()) as Fixture;
  const model = fx.model;
  const layer = new CometLayer(dev, model, hdr);
  const o = fx.ours[1];
  const activity = activityOf(model, fx.measured);
  const rel: V3 = [o.helioKm[0] - o.earthHelioKm[0], o.helioKm[1] - o.earthHelioKm[1], o.helioKm[2] - o.earthHelioKm[2]];
  const d = Math.hypot(...rel);
  const n: V3 = [rel[0] / d, rel[1] / d, rel[2] / d];
  const sc: SceneComet = { id: -1, name: fx.comet.name, rel, helioPos: o.helioKm, helioVel: o.helioVelKmS, M1: fx.comet.M1, K1: fx.comet.K1, totalLabel: 'estimated', activity, dust: 'longPeriod' };
  const c = coma(model, cometInput(sc));
  const results = [];
  for (const [radiusPx, offPx] of [[1, 0], [1, 0.4], [2, 0.3], [8, 0.25], [40, 0.4]]) {
    const pix = c.radiusKm / c.deltaKm / radiusPx;
    const tanX = (pix * W) / 2, tanY = (pix * H) / 2;
    // aim the camera so the nucleus lands offPx pixels off a pixel centre (W, H even: the centre is a pixel corner)
    const b = basis(n);
    const sh = (0.5 + offPx) * pix;
    const look: V3 = [n[0] - b.right[0] * sh - b.up[0] * 0.7 * sh, n[1] - b.right[1] * sh - b.up[1] * 0.7 * sh, n[2] - b.right[2] * sh - b.up[2] * 0.7 * sh];
    const cam = basis([look[0] / Math.hypot(...look), look[1] / Math.hypot(...look), look[2] / Math.hypot(...look)]);
    const pre = f32 ? 1 : 1e-3 / (c.total[1] / (pix * pix));
    const frame = new Float32Array([
      ...cam.right, 0, ...cam.up, 0, ...cam.back, 0,
      1 / tanX, 1 / tanY, 1e-7, pre,
      W, H, 1 / W, 1 / H,
      tanX, tanY, pix, 0,
      f32 ? 3.4e38 : 65504, 0, 0, 0,
      0, 0, 1, 2,
    ]);
    const ub = dev.createBuffer({ size: frame.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(ub, 0, frame);
    const tex = (format: GPUTextureFormat, usage: number) => dev.createTexture({ size: [W, H], format, usage });
    const ext = tex(hdr, GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC);
    const depth = tex('depth32float', GPUTextureUsage.RENDER_ATTACHMENT);
    const enc = dev.createCommandEncoder();
    const clear = enc.beginRenderPass({
      colorAttachments: [{ view: ext.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
      depthStencilAttachment: { view: depth.createView(), depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' },
    });
    clear.end();
    const geom = { right: cam.right, up: cam.up, back: cam.back, tanX, tanY, W, H, near: 1e-7, pixelAngle: pix };
    layer.encode(enc, { ext, depth }, ub, 0, [sc], geom, 1, [], { tails: false, comaAsPoint: false });
    const bpp = f32 ? 16 : 8;
    const bpr = Math.ceil((W * bpp) / 256) * 256;
    const rb = dev.createBuffer({ size: bpr * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    enc.copyTextureToBuffer({ texture: ext }, { buffer: rb, bytesPerRow: bpr }, [W, H]);
    dev.queue.submit([enc.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    const raw = rb.getMappedRange();
    let sumY = 0, sumS = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let Y: number, S: number;
        if (f32) {
          const v = new Float32Array(raw, y * bpr + x * 16, 4);
          Y = v[1]; S = v[3];
        } else {
          const v = new Uint16Array(raw, y * bpr + x * 8, 4);
          Y = half(v[1]); S = half(v[3]);
        }
        // pixel solid angle (the shader's pixelSolidAngle)
        const ndcX = ((x + 0.5) / W) * 2 - 1, ndcY = 1 - ((y + 0.5) / H) * 2;
        const tx = ndcX * tanX, ty = ndcY * tanY;
        const r2 = 1 + tx * tx + ty * ty;
        const om = ((2 * tanX) / W) * ((2 * tanY) / H) / (r2 * Math.sqrt(r2));
        sumY += (Y / pre) * om;
        sumS += (S / pre) * om;
      }
    }
    rb.unmap();
    for (const t of [ext, depth]) t.destroy();
    ub.destroy();
    rb.destroy();
    // light the frame can hold: between the discs inscribed in it and circumscribing it (the nucleus is within a
    // pixel of the centre); for comae smaller than the frame both are the total
    const inKm = (W / 2 - 1) * pix * c.deltaKm, outKm = (W / 2 + 1) * Math.SQRT2 * pix * c.deltaKm;
    const lo = enclosed(model, c, inKm), hi = enclosed(model, c, outKm);
    const err = (sum: number, ch: number) => (sum < lo[ch] ? sum / lo[ch] - 1 : sum > hi[ch] ? sum / hi[ch] - 1 : 0);
    results.push({ radiusPx, offPx, ratioY: sumY / c.total[1], ratioS: sumS / c.total[3], inFrameY: [lo[1] / c.total[1], hi[1] / c.total[1]],
      inFrameS: [lo[3] / c.total[3], hi[3] / c.total[3]], errorY: err(sumY, 1), errorS: err(sumS, 3) });
  }
  layer.destroy();
  const worst = Math.max(...results.map((r) => Math.max(Math.abs(r.errorY), Math.abs(r.errorS))));
  return { hdr, comet: fx.comet.name, totalLux: c.total, radiusKm: c.radiusKm, results, worstRelativeError: worst, pass: worst < 0.01 };
}

function half(h: number): number {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (m / 1024);
  if (e === 31) return m ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + m / 1024);
}
