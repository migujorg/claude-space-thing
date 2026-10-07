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
import { cameraGeom, prepareFrame } from '../src/render/frame';
import { len, normalize, scale, sub } from '../src/render/raycast';
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

it.skipIf(!built)('audits Titan warning sets in all canonical scene geometries', async () => {
  const data = await loadAll({ fetch: fetchFs, base: '/data/', eagerEphemeris: (p) => p === 'ephem/de442s.json' });
  const scenes = JSON.parse(fs.readFileSync(new URL('../e2e/scenes.json', import.meta.url), 'utf8'));
  const baseline = JSON.parse(fs.readFileSync(new URL('../e2e/baseline/stats.json', import.meta.url), 'utf8'));
  const ids = scenes.scenes.map((s: { params: { target: string } }) => Number(s.params.target)).filter((id: number) => id >= 1000000);
  const rows = await selectedRows(ids);
  const state = new AdaptationState();
  state.update({ coneCdM2: 1e-5, rodCdM2: 1.4e-5, cornealFlux: 0 }, 0);
  const eye = computeEyeFrame(DEFAULT_EYE_SETTINGS, state, 'eye', 0, null);
  let bind: AtmosphereBinding | null = null;
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
    if (!bind && titan?.atmosphere?.surface) {
      const r = atmosphereModelFromData(titan.atmosphere, 0, 1,
        { groundPerSample: titan.atmosphere.surface.reflectance, multipleScattering: 'orders' });
      if ('error' in r) throw new Error(r.error);
      bind = { model: r.model, tables: precomputeAtmosphere(r.model), grid: new ProfileGrid(r.model, 512), key: 'model-point-all-scenes' } as AtmosphereBinding;
    }
    const g = cameraGeom(snap, 1280, 720, 1e-7);
    const frame = prepareFrame(snap, g, eye, 1e-9, { atmospheres: (b) => b.atmosphere?.surface ? bind : null });
    const photometry = prepareFrame(snap, g, eye, 1e-9);
    expect(frame.warnings.filter((w) => !w.startsWith('Titan:')), sc.id)
      .toEqual(photometry.warnings.filter((w) => !w.startsWith('Titan:')));
    const warnings = frame.warnings.filter((w) => w.startsWith('Titan:'));
    const expected = baseline.scenes[sc.id].stats.warnings.filter((w: string) => w.startsWith('Titan:'));
    if (JSON.stringify(warnings) !== JSON.stringify(expected)) changed.push(sc.id);
    const phase = titan ? 2 * Math.asin(Math.min(1, len(sub(normalize(titan.toSun), normalize(scale(titan.pos, -1)))) / 2)) * 180 / Math.PI : null;
    const diameter = titan?.radii ? 2 * Math.asin(Math.min(1, titan.radii[0] / len(titan.pos))) / g.pixelAngle : null;
    console.log(`[model-point warnings] ${sc.id}: Titan phase ${phase?.toFixed(6) ?? 'absent'}°, diameter ${diameter?.toFixed(4) ?? 'absent'} px; ${JSON.stringify(warnings)}`);
    expect(warnings, sc.id).toEqual(expected);
  }
  console.log(`[model-point warnings] changed from scene baseline: ${JSON.stringify(changed)}`);
  expect(changed).toEqual([]);
}, 120000);
