// Runs the small-body GPU field test page (sb-test.html) in headless Chromium with SwiftShader WebGPU, like
// shot.mjs: prints the page log, writes the JSON result, and (render mode) a screenshot.
//
//   node scripts/sb-gpu.mjs --query "mode=accuracy&n=1000" --json out/sb-accuracy.json
//   node scripts/sb-gpu.mjs --query "mode=timing" --json out/sb-timing.json
//   node scripts/sb-gpu.mjs --query "mode=render&scene=above" --out ../docs/reports/img/smallbodies-above.png
import { chromium } from 'playwright';
import { startLocalServer } from './local-server.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]?.startsWith('--') ? 'true' : arr[i + 1]]] : acc), []),
);
const query = args.query ?? 'mode=accuracy';
const width = Number(args.width ?? 1280);
const height = Number(args.height ?? 720);
const timeoutMs = Number(args.timeout ?? 3600000);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { server, base } = await startLocalServer(root);
const browser = await chromium.launch({
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader',
    '--ignore-gpu-blocklist', '--disable-gpu-watchdog', '--js-flags=--max-old-space-size=8192'],
});
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
  console.log(`[done in ${((Date.now() - t0) / 1000).toFixed(0)} s]`);
  if (args.json && res !== undefined) {
    mkdirSync(dirname(resolve(args.json)), { recursive: true });
    writeFileSync(resolve(args.json), JSON.stringify(res, null, 1));
    console.log('wrote', resolve(args.json));
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
