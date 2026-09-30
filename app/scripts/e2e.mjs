// Scene regression suite (app/e2e/README.md). Renders every scene of app/e2e/scenes.json in the real app with
// the real data (headless Chromium, SwiftShader WebGPU, ?present=offscreen), one Vite server and one browser,
// at most two scenes at a time. Saves app/shots/e2e/<id>.png (with the UI) and <id>.thumb.png (the rendered
// image only, 64×36), writes app/shots/e2e/report.json (renderer stats + debugState per scene) and compares
// with the committed baseline in app/e2e/baseline/ (stats with tolerances, and a 16×9 lightness grid of the
// thumbnails).
//
//   npm run e2e                          render all scenes, compare with the baseline (exit 1 on a regression)
//   npm run e2e -- --only earth-day,sun-1au
//   npm run e2e -- --accept              render, then make this run the new baseline (all or --only scenes)
//   npm run e2e -- --accept-last         make the last run (app/shots/e2e/report.json) the baseline, no rendering
//   npm run e2e -- --no-compare          render and report only
//   options: --jobs 1|2  --timeout <s per scene>  --base http://localhost:5173 (use a running server)

import { chromium } from 'playwright';
import { createServer } from 'vite';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareScene, decodePng, encodePng, extractStats, gridFromThumb, sceneQuery, statsTable, thumbFromLinear, THUMB_H, THUMB_W } from './e2e-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const E2E = resolve(ROOT, 'e2e');
const BASE_DIR = resolve(E2E, 'baseline');
const OUT = resolve(ROOT, 'shots/e2e');

const argv = process.argv.slice(2);
const flag = (k) => argv.includes(`--${k}`);
const opt = (k) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};
const only = opt('only')?.split(',').filter(Boolean);
const accept = flag('accept');
const acceptLast = flag('accept-last');
const jobs = Math.max(1, Math.min(2, Number(opt('jobs') ?? 2)));
const timeoutMs = 1000 * Number(opt('timeout') ?? 420);

const suite = JSON.parse(readFileSync(resolve(E2E, 'scenes.json'), 'utf8'));
const scenes = suite.scenes.filter((s) => !only || only.includes(s.id));
if (only) for (const id of only) if (!suite.scenes.some((s) => s.id === id)) throw new Error(`unknown scene ${id}`);
const baselinePath = resolve(BASE_DIR, 'stats.json');
const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : null;
const compare = !flag('no-compare') && !!baseline;

const dataInfo = (() => {
  const p = resolve(ROOT, 'public/data/manifest.json');
  if (!existsSync(p)) return { manifest: null };
  const buf = readFileSync(p);
  return { manifestGeneratedAt: JSON.parse(buf.toString('utf8')).generatedAt ?? null, manifestSha256: createHash('sha256').update(buf).digest('hex') };
})();
const gitRev = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
})();

/** Write baseline/stats.json and the thumbnails for these results (merged with the other scenes' baseline). */
function writeBaseline(rs, meta) {
  const bad = rs.filter((r) => r.error || !r.stats);
  if (bad.length) {
    console.log(`Not accepting: ${bad.map((r) => r.id).join(', ')} did not render.`);
    process.exit(1);
  }
  mkdirSync(BASE_DIR, { recursive: true });
  const prev = baseline ?? { scenes: {} };
  const accepted = { ...meta, scenes: { ...prev.scenes } };
  for (const r of rs) {
    accepted.scenes[r.id] = { query: r.query, stats: r.stats, consoleErrors: r.consoleErrors ?? [], readyMs: r.readyMs };
    if (r.thumb) writeFileSync(resolve(BASE_DIR, `${r.id}.png`), encodePng(r.thumb, THUMB_W, THUMB_H));
  }
  // Drop scenes that no longer exist in scenes.json.
  for (const id of Object.keys(accepted.scenes)) if (!suite.scenes.some((s) => s.id === id)) delete accepted.scenes[id];
  writeFileSync(baselinePath, JSON.stringify(accepted, null, 1) + '\n');
  console.log(`Accepted ${rs.length} scene(s) as the baseline in ${BASE_DIR}. Review the diff, then commit it.`);
  process.exit(0);
}

if (acceptLast) {
  // The last run's report and thumbnails, after reviewing its screenshots: no need to render again.
  const last = JSON.parse(readFileSync(resolve(OUT, 'report.json'), 'utf8'));
  const rs = last.scenes.filter((r) => scenes.some((s) => s.id === r.id));
  for (const r of rs) {
    const png = resolve(OUT, `${r.id}.thumb.png`);
    if (existsSync(png)) r.thumb = decodePng(readFileSync(png)).rgba;
  }
  writeBaseline(rs, { acceptedAt: last.generatedAt, git: last.git, data: last.data, viewport: last.viewport });
}

mkdirSync(OUT, { recursive: true });
let server;
let base = opt('base');
if (!base) {
  server = await createServer({ root: ROOT, server: { port: 0, strictPort: false }, logLevel: 'error' });
  await server.listen();
  base = `http://localhost:${server.httpServer.address().port}`;
}
const browser = await chromium.launch({
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
});
const vp = suite.viewport ?? { width: 1280, height: 720 };

/** Box-average the presented canvas (offscreen presentation blits into a 2D canvas) in linear light, in the page. */
function pageCells({ tw, th }) {
  const c = document.getElementById('view');
  const ctx = c && c.getContext('2d');
  if (!ctx) return null;
  const w = c.width, h = c.height;
  const d = ctx.getImageData(0, 0, w, h).data;
  const lut = new Float64Array(256);
  for (let i = 0; i < 256; i++) { const x = i / 255; lut[i] = x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }
  const out = new Float64Array(tw * th * 3), cnt = new Float64Array(tw * th);
  for (let y = 0; y < h; y++) {
    const ty = Math.min(th - 1, Math.floor((y * th) / h));
    for (let x = 0; x < w; x++) {
      const tx = Math.min(tw - 1, Math.floor((x * tw) / w)), i = 4 * (y * w + x), k = ty * tw + tx;
      out[3 * k] += lut[d[i]]; out[3 * k + 1] += lut[d[i + 1]]; out[3 * k + 2] += lut[d[i + 2]]; cnt[k]++;
    }
  }
  for (let k = 0; k < tw * th; k++) for (let j = 0; j < 3; j++) out[3 * k + j] /= Math.max(1, cnt[k]);
  return { w, h, lin: Array.from(out) };
}

async function renderScene(scene) {
  const query = sceneQuery(suite, scene);
  const page = await browser.newPage({ viewport: { width: scene.viewport?.width ?? vp.width, height: scene.viewport?.height ?? vp.height } });
  const consoleErrors = [];
  const consoleWarnings = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 400));
    else if (m.type() === 'warning') consoleWarnings.push(m.text().slice(0, 400));
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 400)}`));
  const t0 = Date.now();
  const r = { id: scene.id, title: scene.title, query };
  try {
    await page.goto(`${base}/?${query}&present=offscreen`);
    await page.waitForFunction(() => window.__frameReady === true || !!window.__frameError, null, { timeout: timeoutMs, polling: 500 });
    r.readyMs = Date.now() - t0;
    const err = await page.evaluate(() => window.__frameError ?? null);
    if (err) r.error = String(err).slice(0, 1000);
    const debug = await page.evaluate(() => window.__app?.debugState?.() ?? null);
    r.stats = extractStats(debug);
    r.renderer = debug?.renderer ?? null;
    r.debug = debug && {
      et: debug.et, utc: debug.utc, selected: debug.selected, camera: debug.camera, reality: debug.reality, badge: debug.badge,
      drawn: debug.drawn, noPosition: debug.noPosition, loading: debug.loading && { ...debug.loading, systems: undefined },
      timings: debug.timings, orbitStats: debug.orbitStats, smallBodies: debug.smallBodies && { ...debug.smallBodies },
      data: { missing: debug.data?.missing ?? [], errors: debug.data?.errors ?? [] }, messages: debug.messages,
    };
    const cells = await page.evaluate(pageCells, { tw: THUMB_W, th: THUMB_H });
    if (cells) {
      const thumb = thumbFromLinear(cells.lin);
      writeFileSync(resolve(OUT, `${scene.id}.thumb.png`), encodePng(thumb, THUMB_W, THUMB_H));
      r.grid = gridFromThumb(thumb);
      r.thumb = thumb;
    } else r.imageNote = 'no 2D canvas to read (not offscreen presentation?)';
    await page.screenshot({ path: resolve(OUT, `${scene.id}.png`) });
  } catch (e) {
    r.readyMs = Date.now() - t0;
    r.error = String(e?.message ?? e).slice(0, 1000);
    try {
      await page.screenshot({ path: resolve(OUT, `${scene.id}.png`) });
    } catch {
      /* page gone */
    }
  }
  r.consoleErrors = consoleErrors;
  r.consoleWarnings = consoleWarnings;
  await page.close();
  return r;
}

const results = new Array(scenes.length);
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(jobs, scenes.length) }, async () => {
    for (let i = next++; i < scenes.length; i = next++) {
      const s = scenes[i];
      process.stdout.write(`… ${s.id}\n`);
      results[i] = await renderScene(s);
      process.stdout.write(`${results[i].error ? '✗' : '✓'} ${s.id} (${((results[i].readyMs ?? 0) / 1000).toFixed(0)} s)${results[i].error ? `: ${results[i].error}` : ''}\n`);
    }
  }),
);
await browser.close();
await server?.close();

// ---- compare ---------------------------------------------------------------------------------------------------

const notes = [];
if (compare && baseline.data?.manifestSha256 && baseline.data.manifestSha256 !== dataInfo.manifestSha256)
  notes.push(`The baseline was accepted on another data build (manifest ${baseline.data.manifestGeneratedAt}); this run uses ${dataInfo.manifestGeneratedAt}. Differences may come from the data.`);
for (const r of results) {
  if (!compare) continue;
  const b = baseline.scenes?.[r.id];
  let ref = null;
  if (b) {
    ref = { ...b };
    const png = resolve(BASE_DIR, `${r.id}.png`);
    ref.grid = existsSync(png) ? gridFromThumb(decodePng(readFileSync(png)).rgba) : null;
    if (b.query !== r.query) notes.push(`${r.id}: the scene's URL changed since the baseline (${b.query} → ${r.query})`);
  }
  const scene = suite.scenes.find((s) => s.id === r.id);
  r.compare = compareScene(r, ref, scene?.tolerance);
}

const report = {
  generatedAt: new Date().toISOString(),
  git: gitRev,
  data: dataInfo,
  viewport: vp,
  compared: compare ? { baselineAcceptedAt: baseline.acceptedAt, baselineGit: baseline.git } : null,
  notes,
  scenes: results.map(({ thumb: _t, ...r }) => r),
};
writeFileSync(resolve(OUT, 'report.json'), JSON.stringify(report, null, 1));
const table = statsTable(results);
writeFileSync(resolve(OUT, 'stats.txt'), table + '\n');
console.log('\n' + table);
for (const n of notes) console.log(`note: ${n}`);
for (const r of results) {
  for (const f of r.compare?.failures ?? []) console.log(`FAIL ${r.id}: ${f}`);
  for (const n of r.compare?.notes ?? []) console.log(`     ${r.id}: ${n}`);
}
console.log(`\nreport: ${resolve(OUT, 'report.json')}  screenshots: ${OUT}`);

// ---- accept ----------------------------------------------------------------------------------------------------

if (accept) writeBaseline(results, { acceptedAt: report.generatedAt, git: gitRev, data: dataInfo, viewport: vp });

const failed = results.filter((r) => r.error || (r.compare && !r.compare.pass));
process.exit(failed.length ? 1 : 0);
