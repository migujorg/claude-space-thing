// Headless screenshot harness (docs/architecture.md §5.4).
// Starts a Vite dev server unless --base is given, opens the page in Chromium with SwiftShader WebGPU,
// waits for window.__frameReady, and saves a PNG. Prints console errors.
//
//   node scripts/shot.mjs --url "/?t=2026-09-30T00:00:00Z" --out shots/x.png [--width 1280 --height 720] [--wait 0] [--base http://localhost:5173]
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]?.startsWith('--') ? 'true' : arr[i + 1]]] : acc), []),
);
const url = args.url ?? '/';
const out = resolve(args.out ?? 'shots/shot.png');
const width = Number(args.width ?? 1280);
const height = Number(args.height ?? 720);
const extraWaitMs = Number(args.wait ?? 0);
const timeoutMs = Number(args.timeout ?? 180000);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let server;
let base = args.base;
if (!base) {
  server = await createServer({ root, server: { port: 0, strictPort: false }, logLevel: 'error' });
  await server.listen();
  const addr = server.httpServer.address();
  base = `http://localhost:${addr.port}`;
}

const browser = await chromium.launch({
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
});
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[console.${m.type()}]`, m.text()); });
  page.on('pageerror', (e) => { console.log('[pageerror]', e.message); failed = true; });
  await page.goto(base + url);
  await page.waitForFunction(() => window.__frameReady === true || window.__frameError, null, { timeout: timeoutMs, polling: 250 });
  const err = await page.evaluate(() => window.__frameError);
  if (err) { console.log('[frameError]', err); failed = true; }
  if (extraWaitMs) await page.waitForTimeout(extraWaitMs);
  mkdirSync(dirname(out), { recursive: true });
  await page.screenshot({ path: out });
  const state = await page.evaluate(() => (window.__app && window.__app.debugState ? window.__app.debugState() : null));
  if (state) console.log('[state]', JSON.stringify(state));
  console.log('saved', out);
} finally {
  await browser.close();
  if (server) await server.close();
}
process.exit(failed ? 1 : 0);
