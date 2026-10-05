// Headless screenshot harness (docs/architecture.md §5.4).
// Starts a Vite dev server unless --base is given, opens the page in Chromium with SwiftShader WebGPU (or, with
// --gpu hardware, the machine's GPU through Vulkan), waits for window.__frameReady, and saves a PNG. Prints console
// errors and the adapter that rendered.
//
//   node scripts/shot.mjs --url "/?t=2026-09-30T00:00:00Z" --out shots/x.png [--width 1280 --height 720] [--wait 0] [--base http://localhost:5173]
//                         [--gpu swiftshader|hardware] (default swiftshader; with hardware a software adapter is an error)
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapterLabel, gpuLaunchArgs, gpuMismatch, pageAdapterInfo } from './e2e-lib.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]?.startsWith('--') ? 'true' : arr[i + 1]]] : acc), []),
);
let url = args.url ?? '/';
// The main app needs offscreen presentation in headless Chromium (see src/app/offscreenPresenter.ts).
if (!/[?&]present=/.test(url) && !/\.html/.test(url)) url += (url.includes('?') ? '&' : '?') + 'present=offscreen';
const out = resolve(args.out ?? 'shots/shot.png');
const width = Number(args.width ?? 1280);
const height = Number(args.height ?? 720);
const extraWaitMs = Number(args.wait ?? 0);
const timeoutMs = Number(args.timeout ?? 180000);
const gpuMode = args.gpu ?? 'swiftshader';
const launchArgs = gpuLaunchArgs(gpuMode); // throws on an unknown mode, before anything starts

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let server;
let base = args.base;
if (!base) {
  server = await createServer({ root, server: { port: 0, strictPort: false }, logLevel: 'error' });
  await server.listen();
  const addr = server.httpServer.address();
  base = `http://localhost:${addr.port}`;
}

const browser = await chromium.launch({ headless: true, args: launchArgs });
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[console.${m.type()}]`, m.text()); });
  page.on('pageerror', (e) => { console.log('[pageerror]', e.message); failed = true; });
  await page.goto(base + url);
  await page.waitForFunction(() => window.__frameReady === true || window.__frameError, null, { timeout: timeoutMs, polling: 250 });
  const err = await page.evaluate(() => window.__frameError);
  if (err) { console.log('[frameError]', err); failed = true; }
  const adapter = await page.evaluate(pageAdapterInfo);
  console.log('[gpu]', `${gpuMode}, adapter ${adapterLabel(adapter)}`);
  const wrongGpu = gpuMismatch(gpuMode, adapter);
  if (wrongGpu) { console.log('[gpu]', wrongGpu); failed = true; }
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
