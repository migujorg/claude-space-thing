// The veil at the frame's edges, checked on the GPU (docs/eye-model.md §3; app/e2e/README.md "The veil at the edges").
//
// The property: the veil pyramid holds, inside the frame, what the same pyramid holds on an unbounded dark canvas.
// Light the eye scatters beyond the frame is lost; light that stays inside is not. The check runs the renderer's own
// compiled pyramid passes (Renderer.pyr: down, blurH, blurV, accum, with the frame's fitted weights) twice on the
// same input, in the page, with the renderer's own device:
//
//   frame    on textures of the frame's size, in the same order as Renderer.encodePyramid;
//   margin   on a canvas with a DARK MARGIN around that input, as wide as the texel of the coarsest level that has
//            weight (1024 px at 1280 × 720 and a 50° field): the texel grid is then the frame's, and no level's own
//            edge is within its texel of the frame. Cut back to the frame, this is the unbounded canvas.
//
// It fails when the two differ anywhere by more than 1e-6 of the peak veil (measured: 0, they agree to the bit).
// It also checks itself: on a rendered scene the first run must equal the renderer's own veil texture.
// Before the pyramid kept a ring of texels beyond each level's edge (8 October 2026), `frame` was 17 to 18 % below
// `margin` at the middle of each edge of a uniform frame and 22.5 % in the corners, and 88 to 98 % below it on the
// far edges of a frame with one bright body.
//
//   node scripts/veil-edges.mjs --gpu hardware                 a uniform frame at 1280 × 720 and 1283 × 723, and
//                                                              three scenes of the suite (one of them an odd frame)
//   options: --only uniform,uniform-odd,jupiter-galileans      --scenes a,b (suite scenes instead of the default three)
//            --gpu swiftshader|hardware (default swiftshader: the margin canvas is ten times the frame, allow minutes)
//            --out file.json
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapterLabel, gpuLaunchArgs, gpuMismatch, pageAdapterInfo, runServerOptions, sceneQuery } from './e2e-lib.mjs';
import { startLocalServer } from './local-server.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const mode = opt('gpu', 'swiftshader');
const only = opt('only') ? opt('only').split(',') : null;
const suite = JSON.parse(readFileSync(resolve(ROOT, 'e2e/scenes.json'), 'utf8'));
const sceneIds = (opt('scenes') ?? 'jupiter-galileans,starfield,jupiter-odd-frame').split(',').filter(Boolean);
/** What may differ between the frame's veil and the dark-margin canvas's, as a fraction of the peak veil. */
const BOUND = 1e-6;

const FIXTURE = '/render-test.html?scene=stars&stars=0&fov=50&hud=0';   // nothing in view: only its fitted weights are used
const views = [
  { id: 'uniform', url: FIXTURE, size: [1280, 720], uniform: true },
  { id: 'uniform-odd', url: FIXTURE, size: [1283, 723], uniform: true },
  ...sceneIds.map((id) => {
    const scene = suite.scenes.find((s) => s.id === id);
    if (!scene) throw new Error(`unknown scene ${id}`);
    const vp = scene.viewport ?? suite.viewport;
    return { id, url: `/?${sceneQuery(suite, scene)}`, size: [vp.width, vp.height], uniform: false };
  }),
].filter((v) => !only || only.includes(v.id));

/** Runs in the page: the two runs of the renderer's pyramid passes, compared there. */
const pageVeil = async ({ uniform }) => {
  const A = window.__app;
  const P = A.sky?.renderer ?? A.renderer;
  const R = P.r ?? P;
  // One more settled frame, then nothing is rendered: every texture read below belongs to that frame.
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
  R.render = () => {};
  if (P !== R) P.render = () => {};
  const dev = R.device;
  await dev.queue.onSubmittedWorkDone();
  const T = R.targets, L = T.levels, W = T.W, H = T.H;
  const weights = L.map((_, k) => R.glareCache.weights[k] ?? 0);
  const U = GPUTextureUsage;
  const mk = (w, h) => dev.createTexture({ size: [w, h], format: 'rgba32float', usage: U.STORAGE_BINDING | U.TEXTURE_BINDING | U.COPY_SRC | U.COPY_DST });
  // The renderer's own layout: how much larger than the level its tmp, blur and acc textures are (twice the ring).
  const padOf = (name) => [L[0][name].width - L[0].w, L[0][name].height - L[0].h];
  const pad = { tmp: padOf('tmp'), blur: padOf('blur'), acc: padOf('acc') };
  const zero = mk(1, 1);
  const ubOf = (w) => { const b = dev.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }); dev.queue.writeBuffer(b, 0, new Float32Array([w, 0, 0, 0])); return b; };
  /** Channel Y of a rectangle of a texture. */
  const read = async (tex, x0, y0, w, h) => {
    const bpr = Math.ceil((w * 16) / 256) * 256;
    const buf = dev.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = dev.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: tex, origin: [x0, y0] }, { buffer: buf, bytesPerRow: bpr }, { width: w, height: h });
    dev.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const raw = new Float32Array(buf.getMappedRange());
    const y = new Float32Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) y[j * w + i] = raw[(j * bpr) / 4 + i * 4 + 1];
    buf.unmap();
    buf.destroy();
    return y;
  };
  /** Renderer.encodePyramid for the retina's veil, on textures of our own: the levels 0 … wts.length − 1 of a w0 × h0 canvas. */
  const run = (input, w0, h0, wts) => {
    const lv = [];
    let w = w0, h = h0;
    for (let k = 0; k < wts.length; k++) {
      lv.push({ w, h, lvl: k === 0 ? input : mk(w, h), tmp: mk(w + pad.tmp[0], h + pad.tmp[1]), blur: mk(w + pad.blur[0], h + pad.blur[1]), acc: mk(w + pad.acc[0], h + pad.acc[1]), ub: ubOf(wts[k]) });
      w = Math.max(1, Math.ceil(w / 2)); h = Math.max(1, Math.ceil(h / 2));
    }
    const enc = dev.createCommandEncoder();
    const pass = enc.beginComputePass();
    const go = (pipe, tex, entries) => {
      pass.setPipeline(pipe);
      pass.setBindGroup(0, dev.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: entries.map(([binding, r]) => ({ binding, resource: r instanceof GPUBuffer ? { buffer: r } : r.createView() })) }));
      pass.dispatchWorkgroups(Math.ceil(tex.width / 8), Math.ceil(tex.height / 8));
    };
    for (let k = 1; k < lv.length; k++) go(R.pyr.down, lv[k].lvl, [[0, lv[k - 1].lvl], [2, lv[k].lvl]]);
    const used = (k) => wts[k] > 0;
    for (let k = 0; k < lv.length; k++) {
      if (!used(k)) continue;
      go(R.pyr.blurH, lv[k].tmp, [[0, lv[k].lvl], [2, lv[k].tmp]]);
      go(R.pyr.blurV, lv[k].blur, [[0, lv[k].tmp], [2, lv[k].blur]]);
    }
    for (let k = lv.length - 1; k >= 0; k--) go(R.pyr.accum, lv[k].acc, [[0, used(k) ? lv[k].blur : zero], [1, k + 1 < lv.length ? lv[k + 1].acc : zero], [2, lv[k].acc], [3, lv[k].ub]]);
    pass.end();
    dev.queue.submit([enc.finish()]);
    return lv;
  };
  const free = (lv) => { for (const l of lv) { for (const n of ['lvl', 'tmp', 'blur', 'acc']) l[n].destroy(); l.ub.destroy(); } };

  // The input: a frame of ones, or the frame's own pyramid input (EXT + PT) made again with the renderer's `combine`.
  const input = mk(W, H);
  if (uniform) dev.queue.writeTexture({ texture: input }, new Float32Array(W * H * 4).fill(1), { bytesPerRow: W * 16 }, [W, H]);
  else {
    const enc = dev.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(R.pyr.combine);
    pass.setBindGroup(0, dev.createBindGroup({ layout: R.pyr.combine.getBindGroupLayout(0), entries: [{ binding: 0, resource: T.ext.createView() }, { binding: 1, resource: T.pt.createView() }, { binding: 2, resource: input.createView() }] }));
    pass.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8));
    pass.end();
    dev.queue.submit([enc.finish()]);
  }
  // Texel (0, 0) of a level is at (ox, oy) in its accumulation texture.
  const ox = pad.acc[0] / 2, oy = pad.acc[1] / 2;
  const here = run(input, W, H, weights);
  const frame = await read(here[0].acc, ox, oy, W, H);
  // The renderer's own veil of this frame. Not where the Sun is in the frame: its disk and point are drawn into the
  // frame after the pyramid (their glare is analytic), so the input made again here would hold light the renderer's
  // veil never saw.
  let sunDrawn = false;
  const snap = A.snapshot?.();
  if (snap?.sun) {
    const o = snap.camera.orient, s = snap.sun.pos, d = Math.hypot(s[0], s[1], s[2]);
    const x = o[0] * s[0] + o[3] * s[1] + o[6] * s[2], y = o[1] * s[0] + o[4] * s[1] + o[7] * s[2], z = o[2] * s[0] + o[5] * s[1] + o[8] * s[2];
    const tanY = Math.tan(snap.camera.fovY / 2), tanX = (tanY * W) / H, reach = snap.sun.radius / d + (16 * 2 * tanY) / H;   // its disk and 16 px
    sunDrawn = z < 0 && Math.abs(x / -z) <= tanX + reach && Math.abs(y / -z) <= tanY + reach;
  }
  const own = uniform || sunDrawn ? null : await read(L[0].acc, ox, oy, W, H);

  let kTop = 0;
  for (let k = 0; k < weights.length; k++) if (weights[k] > 0) kTop = k;
  const M = 2 ** kTop;
  const big = mk(W + 2 * M, H + 2 * M);
  {
    const enc = dev.createCommandEncoder();
    enc.copyTextureToTexture({ texture: input }, { texture: big, origin: [M, M] }, [W, H]);
    dev.queue.submit([enc.finish()]);
  }
  const mar = run(big, W + 2 * M, H + 2 * M, weights.slice(0, kTop + 1));
  const margin = await read(mar[0].acc, ox + M, oy + M, W, H);
  await dev.queue.onSubmittedWorkDone();
  free(mar);
  free(here.slice(1));

  let peak = 0, worst = 0, worstAt = 0, selfWorst = 0, sumFrame = 0, sumMargin = 0;
  for (let i = 0; i < W * H; i++) {
    peak = Math.max(peak, margin[i]);
    const d = Math.abs(frame[i] - margin[i]);
    if (d > worst) { worst = d; worstAt = i; }
    if (own) selfWorst = Math.max(selfWorst, Math.abs(own[i] - frame[i]));
    sumFrame += frame[i]; sumMargin += margin[i];
  }
  const total = weights.reduce((a, b) => a + b, 0);
  const at = (a, x, y) => a[y * W + x];
  const places = [['centre', W >> 1, H >> 1], ['mid top', W >> 1, 0], ['mid left', 0, H >> 1], ['top left', 0, 0], ['bottom right', W - 1, H - 1]];
  return {
    W, H, levels: weights.length, margin: M, ring: pad.acc[0] / 2, hdrFormat: R.hdrFormat, peak,
    worst: peak > 0 ? worst / peak : 0, worstAt: [worstAt % W, Math.floor(worstAt / W)],
    self: own && peak > 0 ? selfWorst / peak : null,
    inside: sumMargin > 0 ? sumFrame / sumMargin - 1 : 0,
    places: places.map(([name, x, y]) => ({ name, frame: at(frame, x, y), margin: at(margin, x, y) })),
    weightSum: total, sunDrawn,
  };
};

const { server, base } = await startLocalServer(ROOT, runServerOptions());
const browser = await chromium.launch({ headless: true, args: gpuLaunchArgs(mode) });
const rows = [];
let adapter = null;
try {
  for (const v of views) {
    const page = await browser.newPage({ viewport: { width: v.size[0], height: v.size[1] } });
    const row = { id: v.id };
    try {
      await page.goto(`${base}${v.url}&present=offscreen`);
      await page.waitForFunction(() => window.__frameReady === true || !!window.__frameError, null, { timeout: 900000, polling: 100 });
      const err = await page.evaluate(() => window.__frameError ?? null);
      const info = await page.evaluate(pageAdapterInfo);
      adapter ??= adapterLabel(info);
      const wrong = gpuMismatch(mode, info);
      if (err || wrong) throw new Error(err ?? wrong);
      row.veil = await page.evaluate(pageVeil, { uniform: v.uniform });
    } catch (e) {
      row.error = String(e?.message ?? e).slice(0, 600);
    }
    await page.close();
    rows.push(row);
    if (row.error) { row.fail = true; console.log(`${v.id.padEnd(22)} ERROR ${row.error}`); continue; }
    const r = row.veil;
    // The harness itself: its passes on the frame's input must give the renderer's own veil (a scene with the Sun's
    // disk or point in the frame is drawn into after the pyramid, and has no such check).
    const selfBad = r.self !== null && r.self > BOUND;
    row.fail = !(r.worst <= BOUND) || selfBad;
    const u = v.uniform ? ` veil / (L·Σw): ${r.places.map((p) => `${p.name} ${(p.frame / r.weightSum).toFixed(5)}`).join(', ')};` : '';
    console.log(`${v.id.padEnd(22)} ${r.W}x${r.H} ${r.hdrFormat} ${r.levels} levels, ring ${r.ring}, dark margin ${r.margin} px:` +
      ` largest |frame − margin| / peak veil ${r.worst.toExponential(2)} at (${r.worstAt}) (bound ${BOUND});` +
      ` at ${r.places.map((p) => `${p.name} ${p.margin > 0 ? `${((p.frame / p.margin - 1) * 100).toFixed(2)} %` : 'dark'}`).join(', ')}; veil light inside ${(r.inside * 100).toFixed(3)} %;${u}` +
      (r.self !== null ? ` the passes run again against the renderer's own veil ${r.self.toExponential(2)}` : v.uniform ? '' : r.sunDrawn ? ' (the Sun is in the frame, drawn after the pyramid: no check against the renderer\'s own veil)' : '') + (row.fail ? '  FAIL' : ''));
  }
} finally {
  await browser.close();
  await server.close();
}
const failed = rows.filter((r) => r.fail);
console.log(`\n${mode} (${adapter}): ${rows.length} views, ${failed.length} failed${failed.length ? ': ' + failed.map((r) => r.id).join(', ') : ''}`);
if (opt('out')) writeFileSync(opt('out'), JSON.stringify({ mode, adapter, bound: BOUND, rows }, null, 1));
process.exit(failed.length ? 1 : 0);
