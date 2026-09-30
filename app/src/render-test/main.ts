// Renderer test page (dev/test only). Builds a SceneSnapshot from TEST FIXTURES (not data), renders
// until the eye's adaptation has converged, then sets window.__frameReady for the screenshot harness.
//   /render-test.html?scene=sphere|sun|stars|unknown|neptune|eclipse|far&mode=eye|enhanced&boost=4&tint=1&orbits=1&hud=0
//   more: stars=N (fixture stars, 0 = none), dist=km, dau=AU (neptune/far), phase=deg, fov=deg, limb=0 (sun),
//   hdr=f16 (fallback path), present=canvas (WebGPU canvas instead of offscreen), debug=1, skip=pass,...
//   shield=1 (Sun shield viewing aid: an occulting disc over the Sun),
//   M2: scene=vt|lowsun|hapke|rings|earthshine, cache=MiB (surface tile budget, default 96), side=lit|unlit (rings),
//   nomodel=1 (rings without a reflectance model); real data (pipeline products under /data):
//   scene=rings-data|moon-data (see dataScenes.ts)

import { Renderer } from '../render/renderer';
import { buildScene } from './scenes';
import { buildDataScene } from './dataScenes';
import { fixtureTile } from './fixtures/surfaces';

// Surface-map fixture tiles (TEST FIXTURES) are served from fixture:// URLs; everything else is fetched.
const realFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith('fixture://')) {
    const b = fixtureTile(url);
    return b ? new Response(b) : new Response(null, { status: 404 });
  }
  return realFetch(input, init);
}) as typeof fetch;

declare global {
  interface Window {
    __frameReady?: boolean;
    __frameError?: string;
  }
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const hud = document.getElementById('hud') as HTMLDivElement;
  // Headless Chromium + SwiftShader never completes WebGPU canvas presentation, so by default the
  // test page renders offscreen and blits the pixels into a 2D canvas (?present=canvas to override).
  const offscreen = params.get('present') !== 'canvas';
  const gpuCanvas = offscreen ? document.createElement('canvas') : canvas;
  const renderer = await Renderer.create(gpuCanvas, {
    presentation: offscreen ? 'offscreen' : 'canvas',
    hdr: params.get('hdr') === 'f16' ? 'f16' : 'auto',
    surfaceCacheMiB: Number(params.get('cache') ?? 96),
  });
  renderer.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
  const scene = (params.get('scene') ?? '').endsWith('-data') ? await buildDataScene(params) : buildScene(params);
  if (scene.stars) renderer.setStars(scene.stars);
  if (params.get('debug') === '1') {
    const t0 = performance.now();
    renderer.onMeasurement = (m) => console.warn(`[measure ${((performance.now() - t0) / 1000).toFixed(1)}s]`, JSON.stringify(m));
  }
  const dbg = params.get('debug') === '1';
  for (const k of (params.get('skip') ?? '').split(',').filter(Boolean)) renderer.debugSkip.add(k);
  const dev = (renderer as unknown as { device: GPUDevice }).device;
  const tt = performance.now();
  if (dbg) console.warn('[stage] created');
  renderer.render(scene.snapshot);
  if (dbg) {
    console.warn('[stage] first render submitted');
    await dev.queue.onSubmittedWorkDone();
    console.warn(`[stage] first frame GPU done after ${(performance.now() - tt).toFixed(0)} ms`);
  }
  await renderer.settled();
  if (offscreen) {
    const px = await renderer.readPixels();
    canvas.width = px.width;
    canvas.height = px.height;
    canvas.getContext('2d')!.putImageData(new ImageData(px.data, px.width, px.height), 0, 0);
  }
  const s = renderer.stats;
  if (params.get('hud') !== '0') {
    hud.textContent = [
      `${scene.realData ? 'REAL DATA (pipeline products)' : 'TEST FIXTURES — not data'} · ${scene.title} · mode ${scene.snapshot.view.mode}`,
      `adaptation ${s.adaptationLuminance.toPrecision(3)} cd/m² (scotopic ${s.scotopicAdaptationLuminance?.toPrecision(3)}) · CIE191 m ${s.mesopicM?.toFixed(2)} · pupil ${s.pupilDiameterMm?.toFixed(2)} mm`,
      `limiting V ${s.limitingMagnitude?.toFixed(2)} · stars drawn ${s.starsDrawn} · frame ${s.frameMs.toFixed(0)} ms${params.get('hdr') === 'f16' ? ' · HDR rgba16float fallback' : ''}`,
      ...(s.surfaceCache ? [`surface tiles ${s.surfaceCache.residentTiles} resident · ${s.surfaceCache.usedMiB.toFixed(0)}/${s.surfaceCache.budgetMiB} MiB · deferred ${s.surfaceCache.deferredTiles} · failed ${s.surfaceCache.failedFetches}`] : []),
      ...(s.gpuFrameMs !== undefined ? [`GPU ${s.gpuFrameMs.toFixed(2)} ms: ${Object.entries(s.gpuPassMs ?? {}).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(' · ')}`] : []),
      ...(s.warnings ?? []).map((w) => `⚠ ${w}`),
    ].join('\n');
  }
  (window as unknown as { __app: unknown }).__app = { renderer, debugState: () => ({ ...renderer.stats, scene: scene.title }) };
  window.__frameReady = true;
}

main().catch((e) => {
  console.error(e);
  window.__frameError = String(e?.stack ?? e);
});
