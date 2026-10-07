// CPU audit of canonical scenes; no browser, GPU, surface atlases or star catalogue are loaded.
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
import { cameraGeom, prepareFrame, type SurfaceBinding } from '../src/render/frame';
import { prepareNightglow } from '../src/render/renderer';
import { layerKey, level0Map, tileUrl, zonalMeanOfLevel0 } from '../src/render/surface';
import { decodeTexelHapke } from '../src/render/texelLaw';
import type { SceneBody, SurfaceLayerRef } from '../src/render/scene';
import { dot, len, normalize, scale, sub } from '../src/render/raycast';
import { evalPhase } from '../src/render/photometry';
import { CIE146 } from '../src/eye/constants';
import { AdaptationState, computeEyeFrame } from '../src/eye/model';
import { DEFAULT_EYE_SETTINGS } from '../src/eye/settings';
import { DATA_DIR } from './core-data';
import { BinaryTable } from '../src/data/binaryTable';
import type { SmallBodyCoreHeader, SmallBodyPhysicalHeader, SmallBodyTableHeader } from '../src/data/schema';
import type { SmallBodyTable, SmallBodyTables } from '../src/data/smallbodies';

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

// Read only the three selected catalogue records. Streaming the name index avoids retaining the catalogue.
async function selectedRows(ids: number[]): Promise<Map<number, number>> {
  const rows = new Map<number, number>();
  let row = 0, pending = '';
  for await (const chunk of fs.createReadStream(DATA_DIR + 'smallbodies/names.txt', { encoding: 'utf8' })) {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop()!;
    for (const line of lines) {
      const id = Number(line.split('\t', 1)[0]);
      if (ids.includes(id)) rows.set(id, row);
      row++;
    }
    if (rows.size === ids.length) break;
  }
  expect(rows.size).toBe(ids.length);
  return rows;
}

function tableRow<H extends SmallBodyTableHeader>(path: string, row: number): SmallBodyTable<H> {
  const h = JSON.parse(fs.readFileSync(DATA_DIR + path, 'utf8')) as H;
  const header = { ...h, count: 1 };
  const buffer = new ArrayBuffer(h.stride);
  const fd = fs.openSync(DATA_DIR + h.bin, 'r');
  try { expect(fs.readSync(fd, new Uint8Array(buffer), 0, h.stride, row * h.stride)).toBe(h.stride); }
  finally { fs.closeSync(fd); }
  return { header, buffer, table: new BinaryTable(header, buffer) };
}

function selectedTables(row: number): SmallBodyTables {
  const core = tableRow<SmallBodyCoreHeader>('smallbodies/core.json', row);
  const physRow = core.table.get('physRow', 0);
  const physical = physRow === 0xffffffff ? null : tableRow<SmallBodyPhysicalHeader>('smallbodies/physical.json', physRow);
  if (physical) new DataView(core.buffer).setUint32(core.header.fields.find((f) => f.name === 'physRow')!.offset, 0, true);
  // The small non-gravitational table supplies the same force inputs as the full catalogue, remapped to row 0.
  const nh = JSON.parse(fs.readFileSync(DATA_DIR + 'smallbodies/nongrav.json', 'utf8')) as SmallBodyTableHeader;
  const bytes = new Uint8Array(fs.readFileSync(DATA_DIR + nh.bin));
  const nt = new BinaryTable(nh, bytes.buffer);
  const nrow = Array.from({ length: nt.count }, (_, i) => i).find((i) => nt.get('row', i) === row);
  const nongrav = nrow === undefined ? null : tableRow('smallbodies/nongrav.json', nrow);
  if (nongrav) new DataView(nongrav.buffer).setUint32(nongrav.header.fields.find((f) => f.name === 'row')!.offset, 0, true);
  return { core, physical, nongrav, comets: null, namesHeader: null,
    cometRow: new Map(), nongravRow: nrow === undefined ? new Map() : new Map([[0, 0]]), count: 1 };
}

it.skipIf(!built)('audits every warning in all canonical scene geometries', async () => {
  const data = await loadAll({ fetch: fetchFs, base: '/data/', eagerEphemeris: (p) => p === 'ephem/de442s.json' });
  const scenes = JSON.parse(fs.readFileSync(new URL('../e2e/scenes.json', import.meta.url), 'utf8'));
  const baseline = JSON.parse(fs.readFileSync(new URL('../e2e/baseline/stats.json', import.meta.url), 'utf8'));
  const ids = scenes.scenes.map((s: { params: { target: string } }) => Number(s.params.target)).filter((id: number) => id >= 1000000);
  const rows = await selectedRows(ids);
  const state = new AdaptationState();
  state.update({ coneCdM2: 1e-5, rodCdM2: 1.4e-5, cornealFlux: 0 }, 0);
  const eye = computeEyeFrame(DEFAULT_EYE_SETTINGS, state, 'eye', 0, null);
  const bindings = readyBindings();
  const surfaces = readySurfaces();
  const changed: string[] = [];
  for (const sc of scenes.scenes) {
    const model = new AppModel({ TimeScale, formatUtc, Ephemeris, EphemerisSet, bodyToIcrf, apparentPosition, OrientationSet, PreciseOrientation });
    model.setData(data);
    model.setViewport({ width: 1280, height: 720, dpr: 1 });
    model.startBackgroundLoading();
    await model.systemsIdle();
    const view = parseUrlParams('?' + new URLSearchParams({ ...scenes.defaults, ...sc.params })).view;
    model.applyUrl(view);
    await model.systemsIdle();
    const row = rows.get(view.target!);
    if (row !== undefined) {
      model.setSmallBodyTables(selectedTables(row));
      expect(typeof model.goTo(-1, view.dist, { azDeg: view.az, elDeg: view.el, instant: true })).not.toBe('string');
      if (view.look) model.lookLocal(-1, view.look.azDeg, view.look.elDeg);
    }
    model.frame(0);
    const snap = model.snapshot!;
    const titan = snap.bodies.find((b) => b.id === 606);
    const g = cameraGeom(snap, 1280, 720, 1e-7);
    const frame = prepareFrame(snap, g, eye, 1e-9, { atmospheres: bindings, surfaces });
    // Runs the renderer's actual nightglow selection/attenuation warning, with no GPU encoding.
    prepareNightglow(frame);
    const warnings = [...new Set(frame.warnings)].sort();
    const expected = [...baseline.scenes[sc.id].stats.warnings].sort();
    if (JSON.stringify(warnings) !== JSON.stringify(expected)) changed.push(sc.id);
    const phase = titan ? 2 * Math.asin(Math.min(1, len(sub(normalize(titan.toSun), normalize(scale(titan.pos, -1)))) / 2)) * 180 / Math.PI : null;
    const diameter = titan?.radii ? 2 * Math.asin(Math.min(1, titan.radii[0] / len(titan.pos))) / g.pixelAngle : null;
    console.log(`[all warnings] ${sc.id}: Titan phase ${phase?.toFixed(6) ?? 'absent'}°, diameter ${diameter?.toFixed(4) ?? 'absent'} px; ${JSON.stringify(warnings)}`);
    expect.soft(warnings, sc.id).toEqual(expected);
  }
  console.log(`[all warnings] changed from scene baseline: ${JSON.stringify(changed)}`);
  expect(changed).toEqual([]);
}, 120000);

const { cpuUsage } = await import(/* @vite-ignore */ 'node:process' as string);

it.skipIf(!built)('requests only atmosphere tables that can contribute to canonical scenes', async () => {
  const data = await loadAll({ fetch: fetchFs, base: '/data/', eagerEphemeris: (p) => p === 'ephem/de442s.json' });
  const scenes = JSON.parse(fs.readFileSync(new URL('../e2e/scenes.json', import.meta.url), 'utf8'));
  const ids = scenes.scenes.map((s: { params: { target: string } }) => Number(s.params.target)).filter((id: number) => id >= 1000000);
  const rows = await selectedRows(ids);
  const state = new AdaptationState();
  state.update({ coneCdM2: 1e-5, rodCdM2: 1.4e-5, cornealFlux: 0 }, 0);
  const eye = computeEyeFrame(DEFAULT_EYE_SETTINGS, state, 'eye', 0, null);
  const costs = new Map<number, number>();
  const surfaces = readySurfaces();
  const noTables = new Set(['earth-day-strict', 'jupiter-galileans', 'ganymede-narrow-field',
    'uranus-epsilon-estimate', 'uranus', 'neptune', 'starfield', 'starfield-enhanced', 'sun-1au',
    'comet-lemmon', 'mercury-map', 'starfield-dark-2min', 'starfield-dark-12min',
    'starfield-dark-30min', 'hyperion-fallback', 'jupiter-double-shadow']);
  for (const sc of scenes.scenes) {
    const model = new AppModel({ TimeScale, formatUtc, Ephemeris, EphemerisSet, bodyToIcrf, apparentPosition, OrientationSet, PreciseOrientation });
    model.setData(data);
    model.setViewport({ width: 1280, height: 720, dpr: 1 });
    model.startBackgroundLoading();
    await model.systemsIdle();
    const view = parseUrlParams('?' + new URLSearchParams({ ...scenes.defaults, ...sc.params })).view;
    model.applyUrl(view);
    await model.systemsIdle();
    const row = rows.get(view.target!);
    if (row !== undefined) {
      model.setSmallBodyTables(selectedTables(row));
      expect(typeof model.goTo(-1, view.dist, { azDeg: view.az, elDeg: view.el, instant: true })).not.toBe('string');
      if (view.look) model.lookLocal(-1, view.look.azDeg, view.look.elDeg);
    }
    model.frame(0);
    const snap = model.snapshot!;
    const g = cameraGeom(snap, 1280, 720, 1e-7);
    const requests: { name: string; angleDeg: number; diameterPx: number; cpuMs: number }[] = [];
    const start = cpuUsage();
    const frame = prepareFrame(snap, g, eye, 1e-9, { surfaces, atmospheres: (b, ground, dust) => {
      if (!costs.has(b.id)) {
        const r = atmosphereModelFromData(b.atmosphere!, ground, dust?.scale ?? 1,
          b.atmosphere!.surface ? { groundPerSample: b.atmosphere!.surface.reflectance, multipleScattering: 'orders' } : {});
        if ('error' in r) costs.set(b.id, 0);
        else {
          const t = cpuUsage();
          precomputeAtmosphere(r.model);
          const d = cpuUsage(t);
          costs.set(b.id, (d.user + d.system) / 1000);
        }
      }
      requests.push({ name: b.name,
        angleDeg: Math.acos(Math.max(-1, Math.min(1, -g.back.reduce((sum, v, c) => sum + v * normalize(b.pos)[c], 0)))) * 180 / Math.PI,
        diameterPx: 2 * Math.asin(Math.min(1, b.radii![0] / len(b.pos))) / g.pixelAngle,
        cpuMs: costs.get(b.id)! });
      return null;
    } });
    // Audit the frame's downstream consumers independently of the request predicate. In particular the
    // nightglow pass selects a resolved emitter regardless of whether its shell overlaps the frustum.
    const emitter = frame.resolved.find((r) => r.body.nightglow)?.body;
    const consumers = snap.bodies.filter((b) => b.atmosphere).map((b) => {
      const r = frame.resolved.find((r) => r.body === b);
      const radius = Math.max(...b.radii!) + (b.atmosphere!.body.topAltitudeKm ?? 0) - (b.atmosphere!.body.altitudesKm[0] ?? 0);
      const d = len(b.pos), u = normalize(b.pos);
      const fieldDeg = Math.acos(Math.max(-1, Math.min(1, -dot(g.back, u)))) * 180 / Math.PI;
      const angularR = Math.asin(Math.min(1, radius / d));
      // Angular bounds of a sphere against both perspective axes; a deliberately separate geometric check.
      const shellInView = radius >= d || (Math.atan2(Math.abs(dot(g.right, b.pos)), -dot(g.back, b.pos)) <= Math.atan(g.tanX) + angularR
        && Math.atan2(Math.abs(dot(g.up, b.pos)), -dot(g.back, b.pos)) <= Math.atan(g.tanY) + angularR);
      const needs: string[] = [];
      if (r && r.lit && shellInView) {
        needs.push('disk/shell', 'disk normalization', 'aerial perspective', 'recipient planetshine attenuation');
        if (d > radius) needs.push('star/sky limb dimming');
      }
      if (b === emitter) needs.push('airglow/aurora attenuation');
      const phase = Math.acos(Math.max(-1, Math.min(1, dot(normalize(b.toSun), scale(u, -1)))));
      const ph = b.phase ? evalPhase(b.phase, phase) : null;
      const shielded = frame.sunShield && dot(u, frame.sunShield.dir) >= frame.sunShield.cosRadius;
      if (b.atmosphere?.surface && b.allowPhaseExtrapolation && ph && !ph.ok && !shielded && fieldDeg <= CIE146.maxDeg) {
        needs.push('model point/off-frame corneal flux');
      }
      const requested = requests.some((q) => q.name === b.name);
      expect.soft(requested || needs.length === 0, `${sc.id}/${b.name}: ${needs.join(', ')}`).toBe(true);
      return { name: b.name, requested, fieldDeg, shellInView, resolved: !!r, consumers: needs };
    });
    console.log(`[atmosphere consumers] ${sc.id}: ${JSON.stringify(consumers)}`);
    console.log(`[model-table requests] ${sc.id}: ${JSON.stringify(requests)}; points ${frame.points.length}`);
    if (noTables.has(sc.id)) {
      expect.soft(requests, sc.id).toHaveLength(0);
      const elapsed = cpuUsage(start);
      // Frame preparation only, using this process's CPU: generous versus the normal few ms.
      expect.soft((elapsed.user + elapsed.system) / 1000, sc.id).toBeLessThan(250);
    }
    const expected = expectedRequests[sc.id];
    expect(expected, `request audit missing scene ${sc.id}`).toBeDefined();
    expect.soft(requests.map((r) => r.name).sort(), sc.id).toEqual([...expected].sort());
    if (sc.id === 'phobos-stickney') {
      const mars = consumers.find((b) => b.name === 'Mars')!;
      expect(mars.requested).toBe(false);
      expect(mars.consumers).toEqual([]);
      const phobos = frame.resolved.find((r) => r.body.id === 401)!;
      expect(phobos.planetshine.some((ps) => ps.sourceId === 499)).toBe(true);
      // Mars still illuminates Phobos through its disk photometry; removing its observer-facing binding
      // must not change that illuminance. Phobos has no atmosphere to attenuate the received light.
      const withoutMarsAir = { ...snap, bodies: snap.bodies.map((b) => b.id === 499 ? { ...b, atmosphere: undefined } : b) };
      const unbound = prepareFrame(withoutMarsAir, g, eye, 1e-9, { surfaces });
      expect(unbound.resolved.find((r) => r.body.id === 401)!.planetshine).toEqual(phobos.planetshine);
    }
  }
}, 120000);


function readyBindings(): NonNullable<Parameters<typeof prepareFrame>[4]>['atmospheres'] {
  const cache = new Map<string, AtmosphereBinding>();
  return (b, ground, dust) => {
    const result = atmosphereModelFromData(b.atmosphere!, ground, dust?.scale ?? 1,
      b.atmosphere!.surface ? { groundPerSample: b.atmosphere!.surface.reflectance, multipleScattering: 'orders' } : {});
    if ('error' in result) throw new Error(result.error);
    const key = JSON.stringify(result.model);
    let bind = cache.get(key);
    if (!bind) {
      bind = { model: result.model, tables: precomputeAtmosphere(result.model),
        grid: new ProfileGrid(result.model, 512), key } as AtmosphereBinding;
      cache.set(key, bind);
    }
    return bind;
  };
}

function readySurfaces(): (b: SceneBody) => SurfaceBinding | null {
  const cache = new Map<string, SurfaceBinding>();
  const tiles = (ref: SurfaceLayerRef) => [0, 1].map((tx) => {
    const missing = ref.header.missingTiles?.['0'] ?? ref.header.missing?.['0'] ?? [];
    if (missing.some(([x, y]) => x === tx && y === 0)) return null;
    const path = DATA_DIR + tileUrl(ref, 0, 0, tx).replace(/^\/?data\//, '');
    expect(fs.existsSync(path), path).toBe(true);
    return new Uint8Array(fs.readFileSync(path)).buffer;
  });
  return (b) => {
    const s = b.surface;
    if (!s) return null;
    const key = Object.values(s).filter((ref) => ref && 'header' in ref).map((ref) => layerKey(ref as SurfaceLayerRef)).join('|');
    const hit = cache.get(key);
    if (hit) return hit;
    const out: SurfaceBinding = {};
    if (s.albedo) {
      const t = tiles(s.albedo);
      out.albedo = { base: 1, maxLevel: s.albedo.header.maxLevel, zonal: zonalMeanOfLevel0(t), map0: level0Map(t) };
    }
    for (const k of ['height', 'clouds', 'cloudTau', 'water', 'night'] as const) {
      if (s[k]) out[k] = { base: 1, maxLevel: s[k]!.header.maxLevel };
    }
    if (s.photometry && s.albedo) out.photometry = { texel: decodeTexelHapke(s.photometry, s.albedo, tiles(s.photometry)), view: {} as GPUTextureView };
    cache.set(key, out);
    return out;
  };
}


// Every canonical scene is covered, including the two requests lost in the rejected first handoff.
const expectedRequests: Record<string, string[]> = {
  'earth-day': ['Earth'], 'earth-day-strict': [], 'earth-night': ['Earth'],
  'night-limb-iss': ['Earth'], 'night-limb-iss-daylight-eye': ['Earth'],
  'aurora-2025-11-12': ['Earth'], 'aurora-2025-11-14-quiet': ['Earth'], 'moon-quarter': ['Earth'],
  'jupiter-galileans': [], 'ganymede-narrow-field': [], 'pluto-narrow-field': ['Pluto'],
  'saturn-rings': ['Titan'], 'uranus-epsilon-estimate': [], 'uranus': [], 'neptune': [],
  'pluto-charon': ['Pluto'], 'starfield': [], 'starfield-enhanced': [], 'sun-1au': [],
  'juno-closeup': ['Titan'], 'comet-lemmon': [], 'mars-map': ['Mars', 'Titan'], 'mercury-map': [],
  'starfield-dark-2min': [], 'starfield-dark-12min': [], 'starfield-dark-30min': [],
  'phobos-stickney': ['Titan'], 'titan-haze': ['Titan'], 'titan-haze-ring': ['Titan'],
  'hyperion-fallback': [], 'bennu-closeup': ['Titan'], 'earth-moon-first-run': ['Earth'],
  'eclipse-2027-above': ['Earth', 'Titan'], 'eclipse-2027-totality': ['Earth'], 'jupiter-double-shadow': [],
};
