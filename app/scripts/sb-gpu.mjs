// Runs the small-body GPU field test page (sb-test.html) in headless Chromium, like shot.mjs: prints the page log,
// writes the JSON result, and (render mode) a screenshot. `--gpu swiftshader|hardware` as in shot.mjs (default
// swiftshader; with hardware a software adapter is an error: app/e2e/README.md "On the GPU").
//
//   node scripts/sb-gpu.mjs --query "mode=accuracy&n=1000" --json out/sb-accuracy.json [--gpu hardware]
//   node scripts/sb-gpu.mjs --query "mode=timing" --json out/sb-timing.json
//   node scripts/sb-gpu.mjs --query "mode=render&scene=above" --out ../docs/reports/img/smallbodies-above.png
import { chromium } from 'playwright';
import { startLocalServer } from './local-server.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapterLabel, gpuLaunchArgs, gpuMismatch, pageAdapterInfo } from './e2e-lib.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]?.startsWith('--') ? 'true' : arr[i + 1]]] : acc), []),
);
const query = args.query ?? 'mode=accuracy';
const width = Number(args.width ?? 1280);
const height = Number(args.height ?? 720);
const timeoutMs = Number(args.timeout ?? 3600000);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const gpuMode = args.gpu ?? 'swiftshader';
// The shared arguments of the mode (they throw on an unknown mode, before anything starts), plus what this page
// always needed: no GPU watchdog (one dispatch can take minutes on SwiftShader) and a larger JS heap (the catalogue).
const launchArgs = [...gpuLaunchArgs(gpuMode), '--disable-gpu-watchdog', '--js-flags=--max-old-space-size=8192'];

const { server, base } = await startLocalServer(root);
const browser = await chromium.launch({ headless: true, args: launchArgs });
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('console', (m) => console.log(`[${m.type()}]`, m.text()));
  page.on('pageerror', (e) => { console.log('[pageerror]', e.message); failed = true; });
  const t0 = Date.now();
  await page.goto(`${base}/sb-test.html?${query}`);
  await page.waitForFunction(() => window.__sbResult !== undefined || window.__frameError, null, { timeout: timeoutMs, polling: 1000 });
  const err = await page.evaluate(() => window.__frameError);
  if (err) { console.log('[frameError]', err); failed = true; }
  const res = await page.evaluate(() => window.__sbResult);
  const adapter = await page.evaluate(pageAdapterInfo);
  console.log('[gpu]', `${gpuMode}, adapter ${adapterLabel(adapter)}`);
  const wrongGpu = gpuMismatch(gpuMode, adapter);
  if (wrongGpu) { console.log('[gpu]', wrongGpu); failed = true; }
  if (res?.mode === 'moon-compare' || res?.mode === 'moon-accuracy' || res?.mode === 'moon-pick') {
    res.runner = { gpuMode, adapter, query, width, height };
  }
  console.log(`[done in ${((Date.now() - t0) / 1000).toFixed(0)} s]`);
  if (args.json && res !== undefined) {
    mkdirSync(dirname(resolve(args.json)), { recursive: true });
    writeFileSync(resolve(args.json), JSON.stringify(res, null, 1));
    console.log('wrote', resolve(args.json));
  }
  // Numerical comparison modes report every variant before asserting, so failure still writes evidence.
  if (res?.passed === false) {
    console.log('[assertion]', 'per-camera moon budget or identity checks failed; inspect JSON variants');
    failed = true;
  }
  if (args.out) {
    mkdirSync(dirname(resolve(args.out)), { recursive: true });
    await page.screenshot({ path: resolve(args.out) });
    console.log('saved', resolve(args.out));
  }
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
