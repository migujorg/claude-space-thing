// Headless screenshots of the M4 sky (like shot.mjs: Vite dev server + Chromium/SwiftShader WebGPU), with a
// look direction and sky statistics.
//
//   node scripts/sky-shots.mjs --url "/?t=...&target=399&dist=1e6&az=180&labels=0&ui=0&fov=60" \
//        --look "266.4,-28.94" --out shots/x.png [--frames 12] [--probe "ra,dec;ra,dec"]
// --look RA,Dec (degrees, ICRS): turn the camera to look along that direction (free mode) after load.
// --probe: directions whose sky-background luminance (the GPU maps + zodiacal model evaluated on the CPU twin,
//          app/sky.ts probe) is printed.
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]?.startsWith('--') ? 'true' : arr[i + 1]]] : acc), []),
);
let url = args.url ?? '/';
if (!/[?&]present=/.test(url)) url += (url.includes('?') ? '&' : '?') + 'present=offscreen';
const out = resolve(args.out ?? 'shots/sky.png');
const width = Number(args.width ?? 1280);
const height = Number(args.height ?? 720);
const frames = Number(args.frames ?? 12);
const timeoutMs = Number(args.timeout ?? 600000);
const look = args.look ? args.look.split(',').map(Number) : null;
const probes = args.probe ? args.probe.split(';').map((p) => p.split(',').map(Number)) : [];

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, server: { port: 0, strictPort: false, hmr: false, watch: { ignored: ['**/*'] } }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}`;
const browser = await chromium.launch({
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
});
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[console.${m.type()}]`, m.text()); });
  page.on('pageerror', (e) => { console.log('[pageerror]', e.message); failed = true; });
  const t0 = Date.now();
  await page.goto(base + url);
  await page.waitForFunction(() => window.__frameReady === true || window.__frameError, null, { timeout: timeoutMs, polling: 500 });
  const err = await page.evaluate(() => window.__frameError);
  if (err) { console.log('[frameError]', err); failed = true; }
  console.log(`ready after ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  if (look) {
    await page.evaluate(([ra, dec]) => {
      const r = (ra * Math.PI) / 180, d = (dec * Math.PI) / 180;
      window.__app.model.lookAlong([Math.cos(d) * Math.cos(r), Math.cos(d) * Math.sin(r), Math.sin(d)]);
    }, look);
  }
  const state = () => page.evaluate(() => {
    const a = window.__app, r = a.debugState().renderer, s = a.sky;
    return `lim ${r?.limitingMagnitude?.toFixed(2)} A ${r?.adaptationLuminance?.toExponential(2)} drawn ${r?.starsDrawn} | cut ${s?.stats.cutMag} pts ${s?.stats.pointsBright}+${s?.stats.pointsDeep} tiles ${s?.stats.tilesLoaded} pend ${s?.stats.pendingTiles} rebuilds ${s?.stats.rebuilds} bg ${JSON.stringify(s?.backgroundStats)}`;
  });
  for (let i = 0; i < frames; i++) {
    await page.evaluate(() => window.__app.nextFrame());
    if (args.verbose) console.log(`frame ${i} +${((Date.now() - t0) / 1000).toFixed(0)} s: ${await state()}`);
  }
  // then until the sky is idle (tiles in, rebuilt, composed), with a cap
  for (let i = 0; i < 20; i++) {
    const idle = await page.evaluate(() => Promise.race([window.__app.sky?.idle().then(() => true) ?? true, new Promise((r) => setTimeout(() => r(false), 60000))]));
    if (args.verbose) console.log(`idle ${idle} +${((Date.now() - t0) / 1000).toFixed(0)} s: ${await state()}`);
    if (idle) break;
    await page.evaluate(() => window.__app.nextFrame());
  }
  await page.evaluate(() => window.__app.nextFrame());
  await page.evaluate(() => window.__app.nextFrame());
  if (args.verbose) console.log(`final +${((Date.now() - t0) / 1000).toFixed(0)} s: ${await state()}`);
  mkdirSync(dirname(out), { recursive: true });
  await page.screenshot({ path: out });
  const info = await page.evaluate((pr) => {
    const a = window.__app;
    const st = a.debugState();
    return {
      renderer: st.renderer && { starsDrawn: st.renderer.starsDrawn, limitingMagnitude: st.renderer.limitingMagnitude, adaptationLuminance: st.renderer.adaptationLuminance, scotopic: st.renderer.scotopicAdaptationLuminance, mesopicM: st.renderer.mesopicM, pupil: st.renderer.pupilDiameterMm, frameMs: st.renderer.frameMs },
      sky: a.sky ? { ...a.sky.stats } : null,
      summary: a.model.skyInfo ? a.model.skyInfo() : null,
      probes: a.sky && a.sky.probe ? pr.map(([ra, dec, rad]) => ({ ra, dec, rad: rad ?? 0, ...a.sky.probe(ra, dec, rad ?? 0) })) : [],
    };
  }, probes);
  console.log('[sky]', JSON.stringify(info, null, 1));
  const cc = await page.evaluate(() => window.__app.sky?.checkCube([[266.4, -28.94], [192.859, 27.128], [12.86, -27.13], [83.8, -5.4], [10.7, 41.3], [0, 89], [150, -60]]));
  if (cc && cc.length) console.log('[cubeGpuVsCpu]', JSON.stringify(cc));
  const zc = await page.evaluate(() => window.__app.sky?.checkZodiacal());
  if (zc && zc.length) console.log('[zodiacalGpuVsCpu]', JSON.stringify(zc));
  // the inspector's facts for the brightest deep-tier point (as a click on it would show), and a bright one
  const picks = await page.evaluate(() => {
    const s = window.__app.sky;
    if (!s) return null;
    const out = {};
    for (const tier of ['deep', 'bright']) {
      let best = -1;
      s.points.forEach((p, k) => { if (p.tier === tier && (best < 0 || s.pointData[k * 7 + 4] > s.pointData[best * 7 + 4])) best = k; });
      if (best < 0) continue;
      const d = Array.from(s.pointData.subarray(best * 7, best * 7 + 3));
      const p = s.pickStar(d, 1e-5);
      out[tier] = p ? s.facts(p) : null;
    }
    return out;
  });
  if (picks) console.log('[picks]', JSON.stringify(picks));
  if (args['tier-stats']) {
    const drawn = {};
    for (const tier of ['bright', 'deep', 'all']) {
      await page.evaluate((t) => { window.__app.sky.debugTier = t; window.__app.sky.invalidate(); }, tier);
      for (let i = 0; i < 3; i++) await page.evaluate(() => window.__app.nextFrame());
      drawn[tier] = await page.evaluate(() => window.__app.debugState().renderer.starsDrawn);
    }
    console.log('[starsDrawnPerTier]', JSON.stringify(drawn));
  }
  console.log('saved', out, `(${((Date.now() - t0) / 1000).toFixed(0)} s)`);
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
