// Renders a view and probes the corona around the Sun (window.__app.sky.probe, the CPU twin of the GPU background).
//   node scripts/corona-shots.mjs --url "/?..." --out shots/x.png [--width 1280 --height 720] [--probe 1] [--off K,F]
// --off hides the K and/or F corona (to see what each adds, e.g. to the eye's adaptation).
// With --probe: radiance profiles (K, F, zodiacal) at position angles 0, 45, 90° from solar north, the corona's
// illuminance outside the Moon relative to the Sun's, and SkyController.checkCorona() (GPU texture vs CPU twin).
// The views of docs/reports/sky.md §5.5: the scene eclipse-2027-totality query, and the Sun shield from 1 AU.
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]?.startsWith('--') ? 'true' : arr[i + 1]]] : acc), []));
let url = args.url ?? '/';
if (!/[?&]present=/.test(url)) url += (url.includes('?') ? '&' : '?') + 'present=offscreen';
const out = resolve(args.out ?? 'shots/corona.png');
const width = Number(args.width ?? 1280), height = Number(args.height ?? 720);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, server: { port: 0, strictPort: false }, logLevel: 'error' });
await server.listen();
const base = `http://localhost:${server.httpServer.address().port}`;
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[console.${m.type()}]`, m.text()); });
  page.on('pageerror', (e) => { console.log('[pageerror]', e.message); failed = true; });
  const t0 = Date.now();
  await page.goto(base + url);
  await page.waitForFunction(() => window.__frameReady === true || window.__frameError, null, { timeout: 600000, polling: 500 });
  const err = await page.evaluate(() => window.__frameError);
  if (err) { console.log('[frameError]', err); failed = true; }
  // wait for the sky maps (background) and a few settled frames
  await page.waitForFunction(() => window.__app?.sky?.stats?.mapsLoaded === true, null, { timeout: 600000, polling: 500 }).catch(() => console.log('maps not loaded'));
  if (args.off) {
    await page.evaluate((off) => {
      const bg = window.__app.sky.bg;
      if (off.includes('K')) bg.showCoronaK = false;
      if (off.includes('F')) bg.showCoronaF = false;
    }, args.off);
  }
  for (let i = 0; i < 4; i++) await page.evaluate(() => window.__app.nextFrame());
  console.log(`rendered in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  mkdirSync(dirname(out), { recursive: true });
  await page.screenshot({ path: out });
  const state = await page.evaluate(() => {
    const st = window.__app.debugState();
    return { layers: window.__app.sky?.stats?.layers, renderer: st.renderer ? { adaptY: st.renderer.adaptationLuminance ?? st.renderer.adaptedLuminance, frames: st.renderer.frames } : null, url: window.__app.url() };
  });
  console.log('[state]', JSON.stringify(state));
  if (args.probe) {
    const res = await page.evaluate(() => {
      const s = window.__app.snapshot();
      const sky = window.__app.sky;
      const sun = s.sun;
      const D = Math.hypot(...sun.pos);
      const n = sun.pos.map((x) => x / D);
      const R = sun.radius;
      const bodies = window.__app.model.data.bodies;
      const rot = bodies.find((b) => b.id === 10).rotation.value;
      const a = (rot.poleRa[0] * Math.PI) / 180, dd = (rot.poleDec[0] * Math.PI) / 180;
      const pole = [Math.cos(dd) * Math.cos(a), Math.cos(dd) * Math.sin(a), Math.sin(dd)];
      // sky-plane axes at the Sun: north = pole projected, east completes
      const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
      const pn = pole.map((x, k) => x - dot(pole, n) * n[k]);
      const pl = Math.hypot(...pn);
      const north = pn.map((x) => x / pl);
      const east = [n[1] * north[2] - n[2] * north[1], n[2] * north[0] - n[0] * north[2], n[0] * north[1] - n[1] * north[0]];
      const dirAt = (rho, paDeg) => {
        const eps = Math.asin(Math.min(1, (rho * R) / D));
        const pa = (paDeg * Math.PI) / 180;
        const t = [0, 1, 2].map((k) => Math.cos(pa) * north[k] + Math.sin(pa) * east[k]);
        return [0, 1, 2].map((k) => Math.cos(eps) * n[k] + Math.sin(eps) * t[k]);
      };
      const radec = (v) => [((Math.atan2(v[1], v[0]) * 180) / Math.PI + 360) % 360, (Math.asin(v[2]) * 180) / Math.PI];
      const prof = {};
      for (const pa of [0, 45, 90]) {
        prof[pa] = [1.1, 1.5, 2, 3, 5, 10, 20, 30].map((rho) => {
          const [ra, de] = radec(dirAt(rho, pa));
          const p = sky.probe(ra, de);
          return { rho, K: p.kCorona[1], F: p.fCorona[1], zodi: p.zodiacal[1], total: p.background[1] };
        });
      }
      // illuminance of the corona (K + F) over the annulus rhoIn..6 R_sun, relative to the Sun's
      const moon = s.bodies.find((b) => b.id === 301);
      let rhoIn = 1.0;
      if (moon) {
        const dm = Math.hypot(...moon.pos);
        const am = Math.asin(1737.4 / dm);
        const sep = Math.acos(Math.max(-1, Math.min(1, dot(moon.pos.map((x) => x / dm), n))));
        rhoIn = (Math.sin(am + sep) * D) / R;   // the Moon's far edge seen from the Sun's centre (covers rho < rhoIn)
      }
      let E = 0;
      const nr = 40, na = 24;
      const lr0 = Math.log(rhoIn), lr1 = Math.log(6);
      for (let i = 0; i < nr; i++) {
        const l0 = lr0 + ((lr1 - lr0) * i) / nr, l1 = lr0 + ((lr1 - lr0) * (i + 1)) / nr;
        const rm = Math.exp(0.5 * (l0 + l1)), dr = Math.exp(l1) - Math.exp(l0);
        for (let j = 0; j < na; j++) {
          const [ra, de] = radec(dirAt(rm, (360 * (j + 0.5)) / na));
          const p = sky.probe(ra, de);
          const L = p.kCorona[1] + p.fCorona[1];
          E += L * ((R / D) ** 2) * rm * dr * ((2 * Math.PI) / na);   // solid angle rho drho dPA (R/D)^2
        }
      }
      const Esun = sun.irradianceXYZS_1AU[1] / ((D / 149597870.7) ** 2);
      return { D_AU: D / 149597870.7, sunRadiusDeg: (Math.asin(R / D) * 180) / Math.PI, rhoIn, profiles: prof, coronaLux: E, sunLux: Esun, ratio: E / Esun };
    });
    res.gpuCheck = await page.evaluate(() => window.__app.sky.checkCorona());
    res.state = state;
    console.log('[probe]', JSON.stringify(res));
    writeFileSync(out.replace(/\.png$/, '.json'), JSON.stringify(res, null, 1));
  }
  console.log('saved', out);
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
