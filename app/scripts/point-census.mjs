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

const { server, base } = await startLocalServer(ROOT, runServerOptions());
const browser = await chromium.launch({ headless: true, args: gpuLaunchArgs(mode) });
const rows = [];
let adapter = null;
try {
  for (const scene of suite.scenes) {
    if (only && !only.includes(scene.id)) continue;
    const query = sceneQuery(suite, scene);
    const instant = /(^|&)adapt=instant(&|$)/.test(query);
    const page = await browser.newPage({ viewport: suite.viewport });
    const row = { id: scene.id, instant };
    try {
      await page.goto(`${base}/?${query}&present=offscreen${extra ? `&${extra}` : ''}`);
      await page.waitForFunction(() => window.__frameReady === true || !!window.__frameError, null, { timeout: 900000, polling: 100 });
      const err = await page.evaluate(() => window.__frameError ?? null);
      const info = await page.evaluate(pageAdapterInfo);
      adapter ??= adapterLabel(info);
      const wrong = gpuMismatch(mode, info);
      if (err || wrong) throw new Error(err ?? wrong);
      row.census = await page.evaluate(pageCensus, { frames, pixels });
      if (flag('perturb')) row.perturb = await page.evaluate(pagePerturb, { settle, measure });
    } catch (e) {
      row.error = String(e?.message ?? e).slice(0, 600);
    }
    await page.close();
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
if (opt('out')) writeFileSync(opt('out'), JSON.stringify({ mode, adapter, frames, perturbed: flag('perturb'), rows }, null, 1));
process.exit(failed.length ? 1 : 0);
