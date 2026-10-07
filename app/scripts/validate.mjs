// Validation against calibrated images (app/e2e/README.md, docs/reports/validation.md). Renders every case of
// validation/index.json with the real renderer and the real data (headless Chromium, SwiftShader WebGPU unless
// --gpu hardware, offscreen) on validation.html, reads the HDR XYZS buffer before the eye model over each region of
// interest, and compares it with the case's expected radiance and tolerance. Writes app/shots/validation/report.json,
// report.md (the table), and per case <id>.display.png (the eye-model image) and <id>.hdr.png (rendered Y,
// square-root scale).
//
//   npm run validate                         all cases
//   npm run validate -- --only io-nh-lorri-2007,saturn-cassini-wac-2016
//   options: --ss N (N × N samples per pixel, default DEFAULT_VALIDATION_SS in src/validation/sampling.mjs)  --reality strict|best|complete (default best)
//            --hdr f16 (rgba16float fallback targets)  --timeout <s per case, default 900>
//            --base http://127.0.0.1:5173 (use a running server)  --strict (exit 1 when an ROI/ratio fails or any case was not rendered)
//            --gpu swiftshader|hardware (default swiftshader; hardware = the machine's GPU through Vulkan, and the
//            run stops if the browser gave a software adapter instead)
// Not part of CI (no data, no WebGPU there). A failing ROI is a finding, reported with its numbers.

import { chromium } from 'playwright';
import { startLocalServer } from './local-server.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapterLabel, encodePng, gpuLaunchArgs, gpuMismatch, pageAdapterInfo, runServerOptions } from './e2e-lib.mjs';
import { assessCase, frameLimitReason, tally, validationExitCode } from '../src/validation/results.mjs';
import { markdownReport } from '../src/validation/report.mjs';
import { parseSamplingOption } from '../src/validation/sampling.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(ROOT, '..');
const VALIDATION = resolve(REPO, 'validation');

const argv = process.argv.slice(2);
const flag = (k) => argv.includes(`--${k}`);
const opt = (k) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};
const only = opt('only')?.split(',').filter(Boolean);
const ss = parseSamplingOption(argv);
const OUT = resolve(ROOT, opt('out') ?? 'shots/validation');
const reality = opt('reality') ?? 'best';
const timeoutMs = 1000 * Number(opt('timeout') ?? 900);
const gpuMode = opt('gpu') ?? 'swiftshader';
const launchArgs = gpuLaunchArgs(gpuMode); // throws on an unknown mode, before anything starts

const index = JSON.parse(readFileSync(resolve(VALIDATION, 'index.json'), 'utf8'));
const cases = index.cases.filter((c) => !only || only.includes(c.id));
if (only) for (const id of only) if (!index.cases.some((c) => c.id === id)) throw new Error(`unknown case ${id}`);

const gitRev = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
})();
const manifestPath = resolve(ROOT, 'public/data/manifest.json');
const dataGeneratedAt = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')).generatedAt ?? null : null;

mkdirSync(OUT, { recursive: true });
let server;
let base = opt('base');
if (!base) {
  ({ server, base } = await startLocalServer(ROOT, runServerOptions()));
}
const browser = await chromium.launch({ headless: true, args: launchArgs });

/** Rendered Y as an 8-bit grey image, square-root scale with `peak` at white. */
function yPng(y, w, h, peak) {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = Number.isFinite(y[i]) && y[i] > 0 ? Math.min(255, Math.round(255 * Math.sqrt(y[i] / peak))) : 0;
    rgba.set([v, v, v, 255], 4 * i);
  }
  return encodePng(rgba, w, h);
}

const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 400)); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 400)}`));
await page.goto(`${base}/validation.html${opt('hdr') === 'f16' ? '?hdr=f16' : ''}`);
await page.waitForFunction(() => window.__frameReady === true || !!window.__frameError, null, { timeout: 300000, polling: 500 });
const startErr = await page.evaluate(() => window.__frameError ?? null);
if (startErr) throw new Error(`validation page failed: ${startErr}`);
// The adapter the page's renderer was given (it is created once, so one look covers every case).
const gpu = { mode: gpuMode, adapter: await page.evaluate(pageAdapterInfo) };
const wrongGpu = gpuMismatch(gpuMode, gpu.adapter);
if (wrongGpu) {
  await browser.close();
  await server?.close();
  throw new Error(wrongGpu);
}
process.stdout.write(`gpu: ${gpu.mode}, adapter ${adapterLabel(gpu.adapter)}\n`);
const limits = await page.evaluate(() => window.__validation.limits);
const dataMissing = await page.evaluate(() => window.__validation.data.missing);

const results = [];
let pageUnavailable = null;
for (const entry of cases) {
  const c = JSON.parse(readFileSync(resolve(VALIDATION, entry.path), 'utf8'));
  process.stdout.write(`… ${c.id} (${c.view.camera.width}×${c.view.camera.height}, ss ${ss})\n`);
  const t0 = Date.now();
  consoleErrors.length = 0; // listeners now collect only this case, including readback errors
  try {
    const refusal = pageUnavailable ?? frameLimitReason(c, ss, limits);
    let timer;
    let r;
    try {
      r = refusal ? assessCase(c, null, { ss, reason: refusal }) : await Promise.race([
        page.evaluate(({ c, opts }) => window.__validation.run(c, opts), { c, opts: { ss, reality } }),
        new Promise((_, rej) => { timer = setTimeout(() => {
          pageUnavailable = `previous case ${c.id} timed out; page may still be rendering`;
          rej(new Error(`timeout after ${timeoutMs / 1000} s`));
        }, timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
    // Flush browser events delivered with the evaluation before accepting any measurement.
    const loss = pageUnavailable ?? await page.evaluate(() => window.__frameError ?? null);
    r = assessCase(c, r, { ss, errors: [...consoleErrors, ...(loss ? [loss] : [])] });
    r.consoleErrors = [...consoleErrors];
    if (r.ss !== ss) throw new Error(`requested ss ${ss}, renderer recorded ${r.ss}`);
    if (r.status === 'rendered') {
      const yBytes = Buffer.from(r.hdrY, 'base64');
      const y = new Float32Array(yBytes.buffer, yBytes.byteOffset, yBytes.byteLength / 4);
      const disp = new Uint8Array(Buffer.from(r.display, 'base64'));
      const peak = Math.max(1e-30, ...r.rois.filter((q) => q.expected).map((q) => q.expected[1]), ...r.rois.map((q) => q.rendered.mean[1]).filter(Number.isFinite));
      writeFileSync(resolve(OUT, `${c.id}.hdr.png`), yPng(y, r.width, r.height, 1.5 * peak));
      writeFileSync(resolve(OUT, `${c.id}.display.png`), encodePng(disp, r.width * r.ss, r.height * r.ss));
    } else {
      for (const suffix of ['hdr', 'display']) rmSync(resolve(OUT, `${c.id}.${suffix}.png`), { force: true });
    }
    delete r.hdrY;
    delete r.display;
    r.title = c.title;
    r.wallMs = Date.now() - t0;
    results.push(r);
    const n = tally([r]);
    process.stdout.write(`${r.status === 'not rendered' ? '✗' : '✓'} ${c.id}: ${n.pass} pass, ${n.fail} fail, ${n.notRendered} not rendered` +
      (r.reason ? `: ${r.reason}` : '') + ` (${(r.wallMs / 1000).toFixed(0)} s)\n`);
  } catch (e) {
    for (const suffix of ['hdr', 'display']) rmSync(resolve(OUT, `${c.id}.${suffix}.png`), { force: true });
    results.push({ ...assessCase(c, null, { ss, errors: consoleErrors, reason: String(e?.message ?? e).slice(0, 1000) }), consoleErrors: [...consoleErrors], wallMs: Date.now() - t0 });
    process.stdout.write(`✗ ${c.id}: ${String(e?.message ?? e).slice(0, 200)}\n`);
  }
}
await browser.close();
await server?.close();

const report = {
  generatedAt: new Date().toISOString(),
  git: gitRev,
  dataGeneratedAt,
  options: { ss, reality, hdr: opt('hdr') ?? 'auto' },
  gpu,
  // The machine that rendered: docs/reports/validation.md §7 names it in its run line (SwiftShader runs on the CPU).
  host: { cpu: cpus()[0]?.model ?? null, threads: cpus().length },
  dataMissing,
  limits,
  consoleErrors: results.flatMap((r) => r.consoleErrors ?? []),
  doc: 'docs/reports/validation.md (the cases), app/e2e/README.md (this runner)',
  cases: results,
};
writeFileSync(resolve(OUT, 'report.json'), JSON.stringify(report, null, 1) + '\n');
const md = markdownReport(report);
writeFileSync(resolve(OUT, 'report.md'), md);
console.log('\n' + md);
console.log(`report: ${resolve(OUT, 'report.json')}  images: ${OUT}`);
process.exit(validationExitCode(results, flag('strict')));
