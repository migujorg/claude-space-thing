// Frame-to-frame census of the point sources (docs/eye-model.md §6 "Background"; app/e2e/README.md "Determinism").
//
// The property it checks: in a settled scene whose eye is always adapted, WHICH stars the cull keeps is the same on
// every frame, and the same again after the frames before it were disturbed. It reads the cull's list back on
// consecutive frames (Renderer.readPointList) and compares the lists by identity, not by count.
//
//   node scripts/point-census.mjs --gpu hardware                    all scenes, 300 consecutive frames each
//   node scripts/point-census.mjs --gpu hardware --perturb          then skip a renderer pass for 1 to 3 frames, seven
//                                                                   times, and compare the settled set with the first
//   options: --only a,b   --frames 300   --settle 40 --measure 40 (perturbation)   --pixels 16 (also compare the
//            displayed image on the first frames)   --query "smallbodies=1"   --out file.json
//            --gpu swiftshader|hardware (default swiftshader: a frame takes seconds there, use --frames 40)
//
// Exit 1 when a scene with adapt=instant changes between two consecutive frames, or does not return to the first
// settled set after a perturbation. A scene with adapt=realtime may gain stars as its pigments regenerate: it fails
// only if a star goes back and forth (changes on at least half of the frame pairs).
//
//   node scripts/point-census.mjs --gpu hardware --lone --only starfield,pluto-charon
//
// --lone checks a different property (docs/eye-model.md §6 "A source's own light"): a point source alone in the
// frame is judged against a background that holds none of its own light. The scene's stars are replaced by one
// source at each of --positions places (default 24, and the frame's edges); the veil level its background is read
// at is read back (Renderer.readVeilLevel) with and without the source, and the cull's own-light value from the
// list (Renderer.readPointList). What is left, as a fraction of the source's own light, must be under 1e-6 where
// the HDR targets are float32 and under 1e-3 where they are half float. Options: --lux 1e-6 (the source's
// illuminance), --query "fov=2", --size 1283x723.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapterLabel, gpuLaunchArgs, gpuMismatch, pageAdapterInfo, runServerOptions, sceneQuery } from './e2e-lib.mjs';
import { startLocalServer } from './local-server.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (k) => argv.includes(`--${k}`);
const mode = opt('gpu', 'swiftshader');
const frames = Number(opt('frames', '300'));
const pixels = Number(opt('pixels', '0'));
const settle = Number(opt('settle', '40'));
const measure = Number(opt('measure', '40'));
const only = opt('only') ? opt('only').split(',') : null;
const lone = flag('lone');
const positions = Number(opt('positions', '24'));
const lux = Number(opt('lux', '1e-6'));
const size = opt('size') ? opt('size').split('x').map(Number) : null;
/** What may be left of a lone source's own light in its background, as a fraction of it, by the HDR targets' format. */
const LONE_BOUND = { rgba32float: 1e-6, rgba16float: 1e-3 };
const extra = opt('query', '');
const suite = JSON.parse(readFileSync(resolve(ROOT, 'e2e/scenes.json'), 'utf8'));

/** Runs in the page: `frames` consecutive render() calls, the cull's list read back after each. */
const pageCensus = async ({ frames, pixels }) => {
      const P = window.__app.sky.renderer;   // the app's renderer (the sky controller holds it)
      const R = P.r ?? P;                     // inside the offscreen presenter, when present=offscreen
      const keysOf = (p) => {
        const u = new Uint32Array(p.data.buffer, p.data.byteOffset, p.count * 8);
        const k = new BigUint64Array(p.count);
        for (let i = 0; i < p.count; i++) k[i] = (BigInt(u[i * 8]) << 32n) | BigInt(u[i * 8 + 1]);
        k.sort();
        return k;
      };
      const light = (p) => { let y = 0; for (let i = 0; i < p.count; i++) y += p.data[i * 8 + 5]; return y; };
      const pending = [];
      const pix = [];
      let lastFrame = -1;
      const t0 = performance.now();
      let n = 0;
      while (n < frames && performance.now() - t0 < 600000) {
        await new Promise(requestAnimationFrame);
        // Synchronous up to the first await inside: the frame index and the copies belong to the same render().
        const f = R.frameIndex;
        if (f === lastFrame) continue;
        lastFrame = f;
        const stats = R.stats;
        pending.push(R.readPointList().then((p) => ({ frame: p.frame, count: p.count, keys: keysOf(p), lightY: light(p), drawn: stats.starsDrawn, L: stats.adaptationLuminance, ptLim: stats.pointLimitingMagnitude ?? null })));
        if (n < pixels) pix.push(R.readPixels().then((im) => ({ frame: f, data: im.data })));
        n++;
        // bound what is held: reduce in order
        if (pending.length > 8) await pending[pending.length - 8];
      }
      const elapsed = performance.now() - t0;
      const lists = await Promise.all(pending);
      // consecutive frames only
      const flips = new Map();
      let pairs = 0, maxDiff = 0, sumDiff = 0;
      const counts = [], lightYs = [];
      const symdiff = (a, b, on) => {
        let i = 0, j = 0, d = 0;
        while (i < a.length || j < b.length) {
          if (j >= b.length || (i < a.length && a[i] < b[j])) { on(a[i]); d++; i++; }
          else if (i >= a.length || b[j] < a[i]) { on(b[j]); d++; j++; }
          else { i++; j++; }
        }
        return d;
      };
      for (let i = 0; i < lists.length; i++) { counts.push(lists[i].count); lightYs.push(lists[i].lightY); }
      for (let i = 1; i < lists.length; i++) {
        if (lists[i].frame !== lists[i - 1].frame + 1) continue;
        pairs++;
        const d = symdiff(lists[i - 1].keys, lists[i].keys, (k) => flips.set(k, (flips.get(k) ?? 0) + 1));
        maxDiff = Math.max(maxDiff, d);
        sumDiff += d;
      }
      let alternating = 0;
      for (const v of flips.values()) if (v >= pairs / 2) alternating++;
      // in the second half only (after any transient)
      const flips2 = new Map();
      let pairs2 = 0, maxDiff2 = 0;
      for (let i = Math.max(1, lists.length >> 1); i < lists.length; i++) {
        if (lists[i].frame !== lists[i - 1].frame + 1) continue;
        pairs2++;
        maxDiff2 = Math.max(maxDiff2, symdiff(lists[i - 1].keys, lists[i].keys, (k) => flips2.set(k, (flips2.get(k) ?? 0) + 1)));
      }
      const ims = await Promise.all(pix);
      let pixPairs = 0, pixMaxChanged = 0, pixMaxStep = 0;
      for (let i = 1; i < ims.length; i++) {
        if (ims[i].frame !== ims[i - 1].frame + 1) continue;
        pixPairs++;
        const a = ims[i - 1].data, b = ims[i].data;
        let ch = 0, st = 0;
        for (let p = 0; p < a.length; p += 4) {
          const d = Math.max(Math.abs(a[p] - b[p]), Math.abs(a[p + 1] - b[p + 1]), Math.abs(a[p + 2] - b[p + 2]));
          if (d > 0) { ch++; if (d > st) st = d; }
        }
        pixMaxChanged = Math.max(pixMaxChanged, ch);
        pixMaxStep = Math.max(pixMaxStep, st);
      }
      const distinct = [...new Set(counts)].sort((a, b) => a - b);
      const Ls = lists.map((l) => l.L);
      const s = window.__app.sky;
      return {
        sampled: lists.length, pairs, elapsedMs: elapsed, distinct, first: counts.slice(0, 8), last: counts.slice(-4),
        maxDiff, meanDiff: pairs ? sumDiff / pairs : 0, everChanged: flips.size, alternating,
        pairs2, maxDiff2, everChanged2: flips2.size,
        lightY: [Math.min(...lightYs), Math.max(...lightYs)],
        L: [Math.min(...Ls), Math.max(...Ls)], ptLim: lists.length ? lists[lists.length - 1].ptLim : null,
        pixPairs, pixMaxChanged, pixMaxStep,
        sky: s ? { cutMag: s.stats.cutMag, pointsBright: s.stats.pointsBright, pointsDeep: s.stats.pointsDeep, rebuilds: s.stats.rebuilds, cube: s.backgroundStats?.cubeSize ?? null } : null,
        frameMs: R.stats.frameMs, gpuFrameMs: R.stats.gpuFrameMs ?? null,
      };
    };

/** Runs in the page: the settled set, then seven perturbations, each followed by `settle` frames and `measure` compared ones. */
const pagePerturb = async ({ settle, measure }) => {
      const P = window.__app.sky.renderer;
      const R = P.r ?? P;
      const keysOf = (p) => {
        const u = new Uint32Array(p.data.buffer, p.data.byteOffset, p.count * 8);
        const k = new BigUint64Array(p.count);
        for (let i = 0; i < p.count; i++) k[i] = (BigInt(u[i * 8]) << 32n) | BigInt(u[i * 8 + 1]);
        k.sort();
        return k;
      };
      const symdiff = (a, b) => {
        let i = 0, j = 0, d = 0;
        while (i < a.length || j < b.length) {
          if (j >= b.length || (i < a.length && a[i] < b[j])) { d++; i++; }
          else if (i >= a.length || b[j] < a[i]) { d++; j++; }
          else { i++; j++; }
        }
        return d;
      };
      let lastFrame = R.frameIndex;
      const newFrame = async () => { for (;;) { await new Promise(requestAnimationFrame); if (R.frameIndex !== lastFrame) { lastFrame = R.frameIndex; return; } } };
      const frames = async (n) => { for (let i = 0; i < n; i++) await newFrame(); };
      const sample = async (n) => {
        const pending = [];
        for (let i = 0; i < n; i++) {
          await newFrame();
          pending.push(R.readPointList().then((p) => ({ frame: p.frame, count: p.count, keys: keysOf(p) })));
          if (pending.length > 8) await pending[pending.length - 8];
        }
        const lists = await Promise.all(pending);
        let maxDiff = 0, pairs = 0;
        for (let i = 1; i < lists.length; i++) if (lists[i].frame === lists[i - 1].frame + 1) { pairs++; maxDiff = Math.max(maxDiff, symdiff(lists[i - 1].keys, lists[i].keys)); }
        return { keys: lists[lists.length - 1].keys, prev: lists[lists.length - 2].keys, counts: [...new Set(lists.map((l) => l.count))].sort((a, b) => a - b), maxDiff, pairs };
      };
      const out = [];
      const k0 = await sample(measure);
      out.push({ what: 'settled', counts: k0.counts, maxDiff: k0.maxDiff, pairs: k0.pairs, fromK0: 0, fromK0prev: symdiff(k0.prev, k0.keys) });
      for (const [name, n] of [['points', 1], ['points', 2], ['cull', 1], ['cull', 2], ['pyramid', 1], ['points', 3], ['cull', 3]]) {
        R.debugSkip.add(name);
        await frames(n);
        R.debugSkip.delete(name);
        await frames(settle);
        const k = await sample(measure);
        // against either phase of K0, when K0 itself alternates
        out.push({ what: `${name} skipped for ${n}`, counts: k.counts, maxDiff: k.maxDiff, pairs: k.pairs, fromK0: Math.min(symdiff(k.keys, k0.keys), symdiff(k.keys, k0.prev), symdiff(k.prev, k0.keys)) });
      }
      return out;
    };

/** Runs in the page: one source alone, at n places and at the frame's edges; the residual of its own light in its background. */
const pageLone = async ({ n, lux }) => {
  const P = window.__app.sky.renderer;
  const R = P.r ?? P;
  const set = R.setStars.bind(R);
  R.setStars = () => {};   // the sky controller must not put its catalogue back while this runs
  if (P !== R) P.setStars = () => {};
  const snap = window.__app.snapshot();
  const o = snap.camera.orient, W = R.targets.W, H = R.targets.H;
  const tanY = Math.tan(snap.camera.fovY / 2), tanX = (tanY * W) / H;
  const right = [o[0], o[3], o[6]], up = [o[1], o[4], o[7]], back = [o[2], o[5], o[8]];
  const dirOf = (px, py) => {
    const nx = (px / W) * 2 - 1, ny = 1 - (py / H) * 2;
    const v = [0, 1, 2].map((i) => right[i] * nx * tanX + up[i] * ny * tanY - back[i]);
    const l = Math.hypot(...v);
    return v.map((x) => x / l);
  };
  const frames = async (k) => { let last = R.frameIndex; for (let i = 0; i < k;) { await new Promise(requestAnimationFrame); if (R.frameIndex !== last) { last = R.frameIndex; i++; } } };
  const one = async (px, py, e) => {
    set({ count: 1, stride: 7, data: new Float32Array([...dirOf(px, py), 0.95 * e, e, 1.09 * e, 2 * e]) });
    await frames(3);   // the cull reads the veil of the frame before
    const [p, t] = await Promise.all([R.readPointList(), R.readVeilLevel()]);
    const rec = p.count === 1 ? p.data : p.unseenCount === 1 ? p.unseen : null;
    if (!rec) return null;   // behind a body, or outside the frame
    // the shaders' read (bgAt): linear between the level's texels on the level's own grid, indices clamped
    const inv = 2 ** -t.level, cx = rec[0] * inv - 0.5, cy = rec[1] * inv - 0.5, ix = Math.floor(cx), iy = Math.floor(cy), fx = cx - ix, fy = cy - iy;
    const at = (x, y) => t.data[(Math.min(Math.max(y, 0), t.height - 1) * t.width + Math.min(Math.max(x, 0), t.width - 1)) * 4 + 1] / t.preExposure;
    const tex = (at(ix, iy) * (1 - fx) + at(ix + 1, iy) * fx) * (1 - fy) + (at(ix, iy + 1) * (1 - fx) + at(ix + 1, iy + 1) * fx) * fy;
    return { tex, own: rec[3] * rec[5], level: t.level };
  };
  let seed = 987654321;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const pos = [];
  for (let i = 0; i < n; i++) pos.push([8 + rnd() * (W - 16), 8 + rnd() * (H - 16)]);
  pos.push([0.4, 0.3], [W - 0.3, H - 0.4], [1.7, H - 2.2], [W - 1.1, 3.3]);
  const rows = [];
  for (const [x, y] of pos) {
    const a = await one(x, y, 1e-30), b = await one(x, y, lux);
    if (!a || !b) { rows.push({ hidden: true }); continue; }
    rows.push({ residual: (b.tex - b.own - a.tex) / b.own, ownOverBackground: b.own / Math.max(a.tex, 1e-30), level: b.level, levelMoved: a.level !== b.level });
  }
  return { rows, format: R.hdrFormat, size: [W, H] };
};

const { server, base } = await startLocalServer(ROOT, runServerOptions());
const browser = await chromium.launch({ headless: true, args: gpuLaunchArgs(mode) });
const rows = [];
let adapter = null;
try {
  for (const scene of suite.scenes) {
    if (only && !only.includes(scene.id)) continue;
    const query = sceneQuery(suite, scene);
    const instant = /(^|&)adapt=instant(&|$)/.test(query);
    const page = await browser.newPage({ viewport: size ? { width: size[0], height: size[1] } : suite.viewport });
    const row = { id: scene.id, instant };
    try {
      await page.goto(`${base}/?${query}&present=offscreen${extra ? `&${extra}` : ''}`);
      await page.waitForFunction(() => window.__frameReady === true || !!window.__frameError, null, { timeout: 900000, polling: 100 });
      const err = await page.evaluate(() => window.__frameError ?? null);
      const info = await page.evaluate(pageAdapterInfo);
      adapter ??= adapterLabel(info);
      const wrong = gpuMismatch(mode, info);
      if (err || wrong) throw new Error(err ?? wrong);
      if (lone) row.lone = await page.evaluate(pageLone, { n: positions, lux });
      else {
        row.census = await page.evaluate(pageCensus, { frames, pixels });
        if (flag('perturb')) row.perturb = await page.evaluate(pagePerturb, { settle, measure });
      }
    } catch (e) {
      row.error = String(e?.message ?? e).slice(0, 600);
    }
    await page.close();
    if (lone && !row.error) {
      const ok = row.lone.rows.filter((r) => !r.hidden), bound = LONE_BOUND[row.lone.format];
      const worst = Math.max(...ok.map((r) => Math.abs(r.residual)));
      const moved = ok.filter((r) => r.levelMoved).length;
      // a source bright enough to move the adaptation changes the level read between the two frames: no measurement
      row.fail = !ok.length || moved > 0 || !(worst < bound);
      rows.push(row);
      console.log(`${scene.id.padEnd(28)} ${row.lone.size.join('x')} ${row.lone.format} level ${ok[0]?.level}: ${ok.length} positions (${row.lone.rows.length - ok.length} hidden)  largest |residual| / own light ${worst.toExponential(2)} (bound ${bound})  own / background, median ${ok.map((r) => r.ownOverBackground).sort((a, b) => a - b)[ok.length >> 1]?.toExponential(1)}` +
        (moved ? `  the level read moved with the source at ${moved} positions: use a smaller --lux` : '') + (row.fail ? '  FAIL' : ''));
      continue;
    }
    const c = row.census;
    const moved = row.perturb ? row.perturb.filter((s) => s.fromK0 > 0 || s.maxDiff > 0).length : 0;
    row.fail = !!row.error || (instant ? c.maxDiff > 0 || moved > 0 : c.alternating > 0);
    rows.push(row);
    if (row.error) { console.log(`${scene.id.padEnd(28)} ERROR ${row.error}`); continue; }
    const d = c.distinct.length > 4 ? `${c.distinct[0]} … ${c.distinct[c.distinct.length - 1]} (${c.distinct.length} values)` : c.distinct.join(', ');
    console.log(`${scene.id.padEnd(28)} ${instant ? 'instant ' : 'realtime'}  ${String(c.pairs).padStart(3)} frame pairs  drawn ${d.padEnd(26)} largest change between two frames ${String(c.maxDiff).padStart(5)}  alternating ${String(c.alternating).padStart(5)}` +
      (pixels ? `  pixels changing ≤ ${c.pixMaxChanged} (by ≤ ${c.pixMaxStep}/255)` : '') +
      (row.perturb ? `  perturbations that did not bring back the first set: ${moved} of ${row.perturb.length - 1}` : '') + (row.fail ? '  FAIL' : ''));
  }
} finally {
  await browser.close();
  await server.close();
}
const failed = rows.filter((r) => r.fail);
console.log(`\n${mode} (${adapter}): ${rows.length} scenes, ${failed.length} failed${failed.length ? ': ' + failed.map((r) => r.id).join(', ') : ''}`);
if (opt('out')) writeFileSync(opt('out'), JSON.stringify({ mode, adapter, frames, perturbed: flag('perturb'), lone, rows }, null, 1));
process.exit(failed.length ? 1 : 0);
