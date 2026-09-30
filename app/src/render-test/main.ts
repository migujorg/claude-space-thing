// Renderer test page (dev/test only). Builds a SceneSnapshot from TEST FIXTURES (not data), renders
// until the eye's adaptation has converged, then sets window.__frameReady for the screenshot harness.
//   /render-test.html?scene=sphere|sun|stars|unknown|neptune|eclipse|far&mode=eye|enhanced&boost=4&tint=1&orbits=1&hud=0
//   more: stars=N (fixture stars, 0 = none), dist=km, dau=AU (neptune/far), phase=deg, fov=deg, limb=0 (sun),
//   hdr=f16 (fallback path), present=canvas (WebGPU canvas instead of offscreen), debug=1, skip=pass,...
//   shield=1 (Sun shield viewing aid: an occulting disc over the Sun),
//   M2: scene=vt|lowsun|hapke|rings|earthshine, cache=MiB (surface tile budget, default 96), side=lit|unlit (rings),
//   nomodel=1 (rings without a reflectance model); real data (pipeline products under /data):
//   scene=rings-data|moon-data (see dataScenes.ts); stars=N adds N fixture stars to a data scene;
//   bench=N (the stats then carry the median GPU time of each pass over N more frames), benchab=<skip> (A/B);
//   hdrgrid=N (log the HDR Y in N-px cells), comet=behind|front (earth-data: a fixture comet at the limb);
//   skip=ap|limb|acuity|…

import { Renderer } from '../render/renderer';
import { buildScene } from './scenes';
import { buildDataScene } from './dataScenes';
import { fixtureTile } from './fixtures/surfaces';
import { fixtureStars } from './fixtures';

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
  renderer.deviceLost.then((i) => { window.__frameError = `WebGPU device lost (${i.reason}): ${i.message}`; });
  renderer.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
  const scene = (params.get('scene') ?? '').endsWith('-data') ? await buildDataScene(params) : buildScene(params);
  // Data scenes carry no stars; stars=N adds N TEST FIXTURE stars (e.g. to see them set behind a limb).
  const fixtureCount = Number(params.get('stars') ?? 0);
  if (scene.realData && fixtureCount > 0) {
    scene.stars = fixtureStars(fixtureCount);
    scene.title += ` + ${fixtureCount} TEST FIXTURE stars (not data)`;
  }
  if (scene.stars) renderer.setStars(scene.stars);
  if (scene.cometModel) renderer.setCometModel(scene.cometModel);
  // Eye history (docs/eye-model.md §2 "Time"): adaptfrom=<cd/m²>,<exposure s>,<elapsed s>.
  const adaptFrom = params.get('adaptfrom');
  if (adaptFrom) {
    const [luminanceCdM2, exposureS, elapsedS] = adaptFrom.split(',').map(Number);
    scene.snapshot.view.adaptation = { mode: 'realtime', history: { luminanceCdM2, exposureS, elapsedS } };
  }
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
  // bench=N: N more frames of the settled view; the stats then carry the median GPU time of each pass.
  // benchab=<skip name>: 2N frames alternating without and with that skip; the second set is reported with
  // a "B " prefix (same load on both, e.g. benchab=ap for the aerial-perspective columns).
  const bench = Math.max(0, Math.floor(Number(params.get('bench') ?? 0)));
  if (bench) {
    const ab = params.get('benchab');
    const runs: Record<string, number>[][] = [[], []];
    for (let i = 0; i < (ab ? 2 * bench : bench); i++) {
      const b = ab ? 1 - (i & 1) : 0; // B first, so the last frame (the screenshot) is A
      if (ab) { if (b) renderer.debugSkip.add(ab); else renderer.debugSkip.delete(ab); }
      const before = renderer.stats.gpuPassMs;
      renderer.render(scene.snapshot);
      await dev.queue.onSubmittedWorkDone();
      for (let w = 0; w < 100 && renderer.stats.gpuPassMs === before; w++) await new Promise((r) => setTimeout(r, 20));
      if (renderer.stats.gpuPassMs && renderer.stats.gpuPassMs !== before) runs[b].push({ ...renderer.stats.gpuPassMs, total: renderer.stats.gpuFrameMs ?? 0 });
    }
    if (ab) renderer.debugSkip.delete(ab);
    const med = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[(s.length - 1) >> 1] : NaN; };
    const medians = (rs: Record<string, number>[]) => {
      const keys = [...new Set(rs.flatMap((r) => Object.keys(r)))];
      return Object.fromEntries(keys.map((k) => [k, med(rs.map((r) => r[k]).filter((x) => x !== undefined))]));
    };
    const A = medians(runs[0]);
    const B = ab ? Object.fromEntries(Object.entries(medians(runs[1])).map(([k, v]) => [`B ${k}`, v])) : {};
    console.log('[bench]', JSON.stringify({ frames: runs[0].length + runs[1].length, medianPassMs: { ...A, ...B } }));
    renderer.stats.gpuPassMs = { ...A, ...B };
  }
  // hdrgrid=N: log the mean HDR luminance Y (cd/m², before the eye model) in N × N-pixel cells, for comparing renders.
  const cell = Math.floor(Number(params.get('hdrgrid') ?? 0));
  if (cell > 0) {
    const img = await renderer.readHdr();
    const gw = Math.ceil(img.width / cell), gh = Math.ceil(img.height / cell);
    const grid = new Float64Array(gw * gh);
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) grid[Math.floor(y / cell) * gw + Math.floor(x / cell)] += img.data[4 * (y * img.width + x) + 1] / (cell * cell);
    console.warn('[hdrgrid]', JSON.stringify({ cell, gw, gh, y: Array.from(grid, (v) => Number(v.toPrecision(4))) }));
  }
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
      `limiting V ${s.limitingMagnitude?.toFixed(2)} (darkest background ${s.pointLimitingMagnitude?.toFixed(2)}) · stars drawn ${s.starsDrawn} · frame ${s.frameMs.toFixed(0)} ms${params.get('hdr') === 'f16' ? ' · HDR rgba16float fallback' : ''}${s.darkAdaptation ? ` · ${s.darkAdaptation.text}` : ''}`,
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
