// GPU pass/term isolation for any main-app URL. Uses real app/data, physical HDR before the eye,
// and settled adaptation after the eye. No gain, no source replacement. Run from app:
// node scripts/nightglow-diagnostic.mjs --gpu hardware --url '/?t=...&target=399&dist=6771&az=180&el=30&look=0,-15&fov=60'
// --reported runs every row in root's report; --scenes runs the nightglow regression scenes.
// --pixel oval:0,0.8928571428571429 adds a named HDR probe (normalized coordinates).
// --only baseline,legacyGeometry,noNightglow,... restricts variants. --out DIR saves JSON and images.
import { chromium } from 'playwright';
import { startLocalServer } from './local-server.mjs';
import { adapterLabel, gpuLaunchArgs, gpuMismatch, pageAdapterInfo } from './e2e-lib.mjs';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const flag = k => argv.includes(`--${k}`);
const opt = (k, fallback) => { const i = argv.indexOf(`--${k}`); return i < 0 ? fallback : argv[i + 1]; };
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const width = Number(opt('width', 1280)), height = Number(opt('height', 720));
const timeout = Number(opt('timeout', 300)) * 1000;
const mode = opt('gpu', 'swiftshader'), launchArgs = gpuLaunchArgs(mode);
const out = opt('out');
const pixelSpecs = [['centre', .5, .5], ['sky', .5, .25], ['ground', .5, .8]];
if (opt('pixel')) {
  const [name, coords] = opt('pixel').split(':');
  const [x, y] = (coords ?? '').split(',').map(Number);
  if (!name || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x >= 1 || y < 0 || y >= 1) throw new Error('--pixel expects name:x,y in normalized [0,1) coordinates');
  pixelSpecs.push([name, x, y]);
}
if (out) mkdirSync(resolve(out), { recursive: true });
const variants = [
  ['baseline', ''], ['legacyGeometry', 'glareGeometry'], ['legacyWithoutGlare', 'glareGeometry,glare'],
  ['noNightglow', 'nightglow'], ['noAirglow', 'airglow'], ['noAurora', 'aurora'],
  ['fullResolutionNightglow', 'nightglowHalfResolution'], ['noNightglowAttenuation', 'nightglowAttenuation'],
  ['noAtmosphere', 'atmosphere'], ['noAPColumns', 'ap'], ['noLimbExtinction', 'limb'],
  ['noBodies', 'bodies'], ['noPyramid', 'pyramid'], ['noAnalyticGlare', 'glare'],
  ['noSunDisk', 'sun'], ['noSkyBackground', 'background'], ['noPoints', 'points'],
  ['emissionOnly', 'bodies,atmosphere,background,points,sun,pyramid,glare,overlays'],
];
const only = opt('only')?.split(',');
if (only) for (const v of only) if (!variants.some(([id]) => id === v)) throw new Error(`Unknown variant ${v}`);
const cases = [];
if (flag('reported')) {
  for (const [id, t, el, look, fov] of [
    ['q0', '2026-10-15T00:00:00Z', 0, '0,-15', 30],
    ['q10', '2026-10-15T00:00:00Z', 10, '0,-15', 60],
    ['q30', '2026-10-15T00:00:00Z', 30, '0,-15', 60],
    ['q50', '2026-10-15T00:00:00Z', 50, '0,-15', 60],
    ['s50', '2025-11-12T01:00:00Z', 50, '0,-15', 60],
    ['s55', '2025-11-12T01:00:00Z', 55, '180,-15', 60],
    ['q55', '2026-10-15T00:00:00Z', 55, '180,-15', 60],
    ['qDown', '2026-10-15T00:00:00Z', 50, '0,-89', 60],
  ]) cases.push({ id, path: `/?t=${t}&target=399&dist=6771&az=180&el=${el}&look=${look}&fov=${fov}&adapt=instant` });
} else if (flag('scenes')) {
  const index = JSON.parse(readFileSync(resolve(root, 'e2e/scenes.json'), 'utf8'));
  for (const c of index.scenes.filter(c => c.id.startsWith('night-limb-') || c.id.startsWith('aurora-'))) {
    cases.push({ id: c.id, path: '/?' + new URLSearchParams({ ...index.defaults, ...c.params }) });
  }
} else {
  if (!opt('url')) throw new Error('Provide --url, --reported or --scenes');
  cases.push({ id: 'view', path: opt('url') });
}
let server, base = opt('base');
let browser;
const results = [];
try {
  if (!base) ({ server, base } = await startLocalServer(root));
  browser = await chromium.launch({ headless: true, args: launchArgs });
  for (const c of cases) for (const [variant, skip] of variants.filter(([id]) => !only || only.includes(id))) {
    // A fresh page clears previous-frame backgrounds, adaptation histories and skipped pyramid textures.
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    // Capture the real Renderer before bootstrap's first frame, including through OffscreenPresenter.
    // This diagnostic hook is local to the browser page; no product/debug API changes are required.
    await page.route('**/src/main.ts*', async route => {
      const response = await route.fetch();
      const body = await response.text();
      await route.fulfill({ response, body: `
const __ngCreate = Renderer.create.bind(Renderer);
Renderer.create = async (...args) => {
  const r = await __ngCreate(...args);
  for (const k of (new URLSearchParams(location.search).get('skip') || '').split(',').filter(Boolean)) r.debugSkip.add(k);
  window.__ngDiagnosticRenderer = r;
  return r;
};
${body}` });
    });
    const url = new URL(c.path, base);
    url.searchParams.set('present', 'offscreen');
    url.searchParams.set('adapt', url.searchParams.get('adapt') ?? 'instant');
    url.searchParams.set('ui', '0'); url.searchParams.set('labels', '0'); url.searchParams.set('orbits', '0');
    url.searchParams.set('smallbodies', '0');
    const originalSkip = url.searchParams.get('skip');
    url.searchParams.set('skip', [originalSkip, skip].filter(Boolean).join(','));
    try {
      await page.goto(url.href);
      await page.waitForFunction(() => window.__frameReady || window.__frameError, null, { timeout, polling: 250 });
      const error = await page.evaluate(() => window.__frameError);
      if (error) throw new Error(error);
      const adapter = await page.evaluate(pageAdapterInfo);
      const mismatch = gpuMismatch(mode, adapter);
      if (mismatch) throw new Error(mismatch);
      const r = await page.evaluate(async (pixelSpecs) => {
        const r = window.__ngDiagnosticRenderer;
        if (!r) throw new Error('Diagnostic renderer hook did not run');
        await r.frameDone();
        const image = await r.readHdr();
        const snap = window.__app.snapshot();
        const { nearHit, prepareBody, normalize } = await import('/src/render/raycast.ts');
        const earth = snap.bodies.find(b => b.id === 399);
        const b = earth && prepareBody(earth.pos, earth.radii, earth.orient);
        const o = snap.camera.orient, ty = Math.tan(snap.camera.fovY / 2), tx = ty * image.width / image.height;
        const pixels = Object.fromEntries(pixelSpecs.map(([name, fx, fy]) => {
          const x = Math.floor(fx * image.width), y = Math.floor(fy * image.height);
          const ndcX = 2 * (x + .5) / image.width - 1, ndcY = 1 - 2 * (y + .5) / image.height;
          const dir = normalize([0, 1, 2].map(k => o[3*k] * ndcX * tx + o[3*k+1] * ndcY * ty - o[3*k+2]));
          const hit = b && nearHit(b, dir);
          return [name, { x, y, xyzs: Array.from(image.data.slice(4 * (y * image.width + x), 4 * (y * image.width + x) + 4)), hitsEarth: !!hit && hit.t > 0 && hit.disc >= 0 }];
        }));
        let peak = -Infinity, peakIndex = 0;
        for (let i = 0; i < image.width * image.height; i++) if (image.data[4*i+1] > peak) { peak = image.data[4*i+1]; peakIndex = i; }
        return { adaptation: r.stats.adaptationLuminance, scotopicAdaptation: r.stats.scotopicAdaptationLuminance,
          mesopicM: r.stats.mesopicM, pixels, peak: { x: peakIndex % image.width, y: Math.floor(peakIndex / image.width), Y: peak }, warnings: r.stats.warnings };
      }, pixelSpecs);
      const result = { case: c.id, variant, url: url.href, gpu: { mode, adapter: adapterLabel(adapter) }, ...r, errors };
      results.push(result);
      console.log(JSON.stringify(result));
      if (out) await page.screenshot({ path: resolve(out, `${c.id}-${variant}.png`) });
      if (errors.length) throw new Error(errors.join('\n'));
    } finally { await page.close(); }
  }
} finally {
  await browser?.close(); await server?.close();
  if (out) writeFileSync(resolve(out, 'report.json'), JSON.stringify({ git: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), width, height, results }, null, 2) + '\n');
}
