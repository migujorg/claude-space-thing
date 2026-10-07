// CPU audit of the canonical Saturn views; no browser, GPU, surface atlases or star catalogue are loaded.
import { expect, it } from 'vitest';
import { AppModel } from '../src/app/model';
import { parseUrlParams } from '../src/app/url';
import { loadAll } from '../src/data/load';
import { Ephemeris, EphemerisSet } from '../src/core/ephemeris';
import { apparentPosition } from '../src/core/lighttime';
import { OrientationSet, PreciseOrientation, bodyToIcrf } from '../src/core/rotation';
import { TimeScale, formatUtc } from '../src/core/time';
import { atmosphereModelFromData, precomputeAtmosphere, ProfileGrid } from '../src/render/atmosphere';
import type { AtmosphereBinding } from '../src/render/atmosphereGpu';
import { cameraGeom, prepareFrame } from '../src/render/frame';
import { len, normalize, scale, sub } from '../src/render/raycast';
import { AdaptationState, computeEyeFrame } from '../src/eye/model';
import { DEFAULT_EYE_SETTINGS } from '../src/eye/settings';
import { DATA_DIR } from './core-data';

const fs = await import(/* @vite-ignore */ 'node:fs' as string);
const built = fs.existsSync(DATA_DIR + 'atmospheres.json') && fs.existsSync(DATA_DIR + 'ephem/sat-sat.json');
const fetchFs = async (url: string): Promise<Response> => {
  const path = DATA_DIR + url.replace(/^\/data\//, '');
  if (!fs.existsSync(path)) return new Response('not found', { status: 404 });
  return new Response(new Uint8Array(fs.readFileSync(path)));
};

it.skipIf(!built)('model-drawn bodies in canonical scenes reuse their point/disk integral across full frames', async () => {
  const data = await loadAll({ fetch: fetchFs, base: '/data/', eagerEphemeris: (p) => p === 'ephem/de442s.json' });
  const model = new AppModel({ TimeScale, formatUtc, Ephemeris, EphemerisSet, bodyToIcrf, apparentPosition, OrientationSet, PreciseOrientation });
  model.setData(data);
  model.setViewport({ width: 1280, height: 720, dpr: 1 });
  model.startBackgroundLoading();
  await model.systemsIdle();
  const scenes = JSON.parse(fs.readFileSync(new URL('../e2e/scenes.json', import.meta.url), 'utf8'));
  const st = new AdaptationState();
  st.update({ coneCdM2: 1e-5, rodCdM2: 1.4e-5, cornealFlux: 0 }, 0);
  const eye = computeEyeFrame(DEFAULT_EYE_SETTINGS, st, 'eye', 0, null);
  let bind: AtmosphereBinding | null = null;
  for (const id of ['saturn-rings', 'hyperion-fallback']) {
    const sc = scenes.scenes.find((s: { id: string }) => s.id === id);
    model.applyUrl(parseUrlParams('?' + new URLSearchParams({ ...scenes.defaults, ...sc.params })).view);
    await model.systemsIdle();
    model.frame(0);
    const snap = model.snapshot!;
    const titan = snap.bodies.find((b) => b.id === 606)!;
    expect(titan.atmosphere?.surface).toBeDefined();
    if (!bind) {
      const start = performance.now();
      const r = atmosphereModelFromData(titan.atmosphere!, 0, 1,
        { groundPerSample: titan.atmosphere!.surface!.reflectance, multipleScattering: 'orders' });
      if ('error' in r) throw new Error(r.error);
      const tables = precomputeAtmosphere(r.model);
      bind = { model: r.model, tables, grid: new ProfileGrid(r.model, 512), key: 'model-point-scenes' } as AtmosphereBinding;
      console.log(`[model-point] Titan table construction: ${(performance.now() - start).toFixed(1)} ms (CPU; app uses a worker)`);
    }
    const g = cameraGeom(snap, 1280, 720, 1e-7);
    const opts = { atmospheres: (b: typeof titan) => b.atmosphere?.surface ? bind : null };
    const coldStart = performance.now();
    const frame = prepareFrame(snap, g, eye, 1e-9, opts);
    const coldMs = performance.now() - coldStart;
    const warmStart = performance.now();
    for (let i = 0; i < 100; i++) prepareFrame(snap, g, eye, 1e-9, opts);
    const warmMs = (performance.now() - warmStart) / 100;
    const angularR = Math.asin(Math.min(1, titan.radii![0] / len(titan.pos)));
    const phase = 2 * Math.asin(Math.min(1, len(sub(normalize(titan.toSun), normalize(scale(titan.pos, -1)))) / 2));
    // Isolate the source at the same geometry and aim at its centre, sampled below a pixel. This exposes its
    // full flux even when off frame in the original scene. All other bodies keep the existing preparation path.
    const dotG = { ...g, back: normalize(scale(titan.pos, -1)), right: [0, 0, 0] as [number, number, number],
      up: [0, 0, 0] as [number, number, number], pixelAngle: 4 * angularR };
    const isolated = { ...snap, bodies: [titan] };
    const old = prepareFrame(isolated, dotG, eye, 1e-9).points[0].E;
    const actual = prepareFrame(isolated, dotG, eye, 1e-9, opts).points[0].E;
    const ratio = actual.map((v, c) => v / old[c]);
    const oldFrame = prepareFrame(snap, g, eye, 1e-9);
    const fieldDeg = Math.acos(Math.max(-1, Math.min(1, -g.back.reduce((sum, v, c) => sum + v * normalize(titan.pos)[c], 0)))) * 180 / Math.PI;
    const fluxDelta = frame.offFrameFluxDeg2 - oldFrame.offFrameFluxDeg2;
    const modeled = snap.bodies.filter((b) => b.atmosphere?.surface).map((b) => b.name);
    expect(modeled).toEqual(['Titan']);
    expect(ratio.every((v) => Number.isFinite(v) && v > 0)).toBe(true);
    console.log(`[model-point] ${id}: ${snap.bodies.length} bodies; model-drawn ${modeled}; Titan phase ${(phase * 180 / Math.PI).toFixed(6)}°, diameter ${(2 * angularR / g.pixelAngle).toFixed(4)} px; new / old XYZS ${ratio.map((v) => v.toFixed(6)).join(' ')}; Y ${old[1]} -> ${actual[1]} lux; angle from fixation ${fieldDeg.toFixed(3)}°, off-frame flux change ${fluxDelta} cd/m²·deg²; all-body cold ${coldMs.toFixed(2)} ms, warm ${warmMs.toFixed(3)} ms/frame (other atmosphere bindings absent)`);
  }
}, 120000);
