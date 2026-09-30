// Validation page (validation.html; driven by scripts/validate.mjs, app/e2e/README.md): renders ground-truth cases
// (validation/cases/<id>/case.json) with the real renderer and the app's data, and reads the HDR XYZS buffer
// before the eye model over each case's regions of interest.
//
//   window.__validation.run(case, { reality, ss }) → result (see RunResult); .debug = { renderer, data } for scripts
//   ?hdr=f16 uses the rgba16float fallback targets; ?cache=MiB the surface tile budget (default 512).
// window.__frameReady is set once the renderer and the data are ready (window.__frameError on failure).

import { loadAll } from '../data/load';
import type { ValidationCase } from '../data/schema';
import { Renderer } from '../render/renderer';
import { regionStats } from '../render/hdrReadback';
import { surfaceRefs } from '../app/extras';
import { compareRatios, compareRoi, scaledRect, validationScene, type RatioResult, type RoiResult, type ValidationData, type ValidationOptions, type ValidationScene } from './runner';

export interface RunResult {
  id: string;
  width: number;
  height: number;
  ss: number;
  reality: string;
  hdrFormat: string;
  scene: Pick<ValidationScene, 'notes' | 'bodies'>;
  rois: RoiResult[];
  ratios: RatioResult[];
  stats: Renderer['stats'];
  renderMs: number;
  /** Rendered HDR Y (cd/m²), width × height float32 little-endian, base64 (box-averaged when ss > 1). */
  hdrY: string;
  /** The eye-model display image, RGBA8 at the rendered size (ss × width, ss × height), base64. */
  display: string;
}

declare global {
  interface Window {
    __validation?: {
      run(c: ValidationCase, opts?: ValidationOptions): Promise<RunResult>;
      data: { missing: string[] };
      /** For scripted experiments (a variant scene, a changed body): the renderer and the app data used. */
      debug: { renderer: Renderer; data: ValidationData };
    };
    __frameReady?: boolean;
    __frameError?: string;
  }
}

function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const gpuCanvas = document.createElement('canvas');
  const renderer = await Renderer.create(gpuCanvas, {
    presentation: 'offscreen',
    hdr: params.get('hdr') === 'f16' ? 'f16' : 'auto',
    surfaceCacheMiB: Number(params.get('cache') ?? 512),
  });
  renderer.deviceLost.then((i) => { window.__frameError = `WebGPU device lost (${i.reason}): ${i.message}`; });
  const base = `${import.meta.env.BASE_URL}data/`;
  const loaded = await loadAll({ fetch: (u: string) => fetch(u), base, verifyHashes: false, eagerEphemeris: () => false });
  const data: ValidationData = {
    bodies: loaded.bodies,
    light: loaded.light,
    extras: { surfaces: surfaceRefs(loaded.surfaces ?? [], base), rings: loaded.rings ?? null, atmospheres: loaded.atmospheres ?? null },
  };
  const missing = loaded.report.products.filter((p) => p.status === 'missing' || p.status === 'error').map((p) => p.path);

  async function run(c: ValidationCase, opts: ValidationOptions = {}): Promise<RunResult> {
    const ss = Math.max(1, Math.round(opts.ss ?? 1));
    const scene = validationScene(c, data, opts);
    const W = c.view.camera.width, H = c.view.camera.height;
    renderer.resize(W * ss, H * ss, 1);
    const t0 = performance.now();
    renderer.render(scene.snapshot);
    await renderer.settled();
    const renderMs = performance.now() - t0;
    // The renderer warns when its HDR targets are the rgba16float fallback (no float32-blendable).
    const hdrFormat = renderer.stats.warnings?.some((w) => w.includes('rgba16float')) ? 'rgba16float' : 'rgba32float';
    const rois: RoiResult[] = [];
    for (const roi of c.rois) rois.push(compareRoi(roi, await renderer.readHdrRegion(scaledRect(roi.rect, ss))));
    const full = await renderer.readHdr();
    const y = new Float32Array(W * H);
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        let s = 0;
        for (let dy = 0; dy < ss; dy++) for (let dx = 0; dx < ss; dx++) s += full.data[4 * ((j * ss + dy) * full.width + i * ss + dx) + 1];
        y[j * W + i] = s / (ss * ss);
      }
    }
    const display = await renderer.readPixels();
    // The whole frame's statistics are not a test; they make a blank render obvious in the report.
    const frame = regionStats(full);
    return {
      id: c.id, width: W, height: H, ss, reality: opts.reality ?? 'best', hdrFormat,
      scene: { notes: [...scene.notes, ...(frame.mean[1] > 0 ? [] : ['the HDR frame is black'])], bodies: scene.bodies },
      rois, ratios: compareRatios(c, rois), stats: structuredClone(renderer.stats), renderMs,
      hdrY: b64(new Uint8Array(y.buffer)), display: b64(new Uint8Array(display.data.buffer)),
    };
  }

  window.__validation = { run, data: { missing }, debug: { renderer, data } };
  window.__frameReady = true;
}

main().catch((e) => {
  console.error(e);
  window.__frameError = String(e?.stack ?? e);
});
