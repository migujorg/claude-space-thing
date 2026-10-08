// Built-map census through the real frame preparation path. No browser/GPU or data writes.
import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import type { SceneBody, SceneSnapshot, SurfaceLayerRef } from '../src/render/scene';
import type { SurfaceBinding } from '../src/render/frame';
import type * as Frame from '../src/render/frame';
import type * as Spatial from '../src/render/spatial';
import type * as Surface from '../src/render/surface';
import type * as Texel from '../src/render/texelLaw';
const fs = await import(/* @vite-ignore */ 'node:fs' as string);
const os = await import(/* @vite-ignore */ 'node:os' as string);
const path = await import(/* @vite-ignore */ 'node:path' as string);
const proc = await import(/* @vite-ignore */ 'node:process' as string);
const crypto = await import(/* @vite-ignore */ 'node:crypto' as string);
const url = await import(/* @vite-ignore */ 'node:url' as string);
const app = url.fileURLToPath(new URL('..', import.meta.url));
const data = path.join(app, 'public/data');
const built = fs.existsSync(path.join(data, 'photometry.json'));
const json = (p: string) => JSON.parse(fs.readFileSync(path.join(data, p), 'utf8'));
const cpu = () => { const t = proc.cpuUsage(); return (t.user + t.system) / 1000; };
const median = (v: number[]) => v.sort((a, b) => a - b)[v.length >> 1];
// Increment at the function entry, not at the cache lookup. Instruments only the temporary test bundle.
const counters: Record<string, number> = {};
(globalThis as any).__mapIntegralCalls = counters;
async function instrumented() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'map-prep-'));
  const outfile = path.join(dir, 'frame.mjs');
  await build({ stdin: { contents: `export * from './src/render/frame'; export * from './src/render/spatial'; export * from './src/render/surface'; export * from './src/render/texelLaw'; export { AdaptationState, computeEyeFrame } from './src/eye/model'; export { DEFAULT_EYE_SETTINGS } from './src/eye/settings';`, resolveDir: app, loader: 'ts' }, outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent', plugins: [{ name: 'count-integrals', setup(b) {
    b.onLoad({ filter: /render\/spatial\.ts$/ }, args => {
      let contents = fs.readFileSync(args.path, 'utf8');
      for (const name of ['fixedOrderZonalIntegral', 'spectralIntegral', 'crescentIntegral', 'mapDiskIntegral', 'zonalDiskIntegral']) {
        const marker = `globalThis.__mapIntegralCalls['${name}'] = (globalThis.__mapIntegralCalls['${name}'] || 0) + 1;`;
        const at = contents.indexOf(`function ${name}(`);
        if (at < 0) throw new Error(`Missing integrator ${name}`);
        // Parameters contain object types, but only the function body opens before a newline.
        const body = contents.indexOf('{\n', at);
        if (body < 0) throw new Error(`Missing body ${name}`);
        contents = contents.slice(0, body + 2) + marker + '\n' + contents.slice(body + 2);
      }
      contents = contents.replace('const evaluate=(n:number):XYZS=>{', "const evaluate=(n:number):XYZS=>{globalThis.__mapIntegralCalls.ellipsoid = (globalThis.__mapIntegralCalls.ellipsoid || 0) + 1;");
      return { contents, loader: 'ts' };
    });
  } }] });
  const lib = await import(/* @vite-ignore */ url.pathToFileURL(outfile).href) as typeof Frame & typeof Spatial & typeof Surface & typeof Texel & { AdaptationState: any; computeEyeFrame: any; DEFAULT_EYE_SETTINGS: any };
  fs.rmSync(dir, { recursive: true, force: true });
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(app, 'src/render/spatial.ts'))).digest('hex');
  lib.installHapkePhaseTables(json('hapke-phase.json'), hash);
  return lib;
}
const reset = () => { for (const k of Object.keys(counters)) delete counters[k]; };
const total = () => Object.values(counters).reduce((a, b) => a + b, 0);
const ids: string[] = built ? fs.readdirSync(path.join(data, 'surfaces')).filter((id: string) => fs.existsSync(path.join(data, `surfaces/${id}/albedo.json`))) : [];
function inputs(lib: Awaited<ReturnType<typeof instrumented>>, id: string) {
  const p = json('photometry.json')[id], b = json('bodies.json').find((b: any) => String(b.id) === id);
  const ref = (layer: string): SurfaceLayerRef => ({ url: `data/surfaces/${id}/${layer}`, header: json(`surfaces/${id}/${layer}.json`) });
  const tiles = (layer: string) => [0, 1].map(t => {
    const f = path.join(data, `surfaces/${id}/${layer}/0/0/${t}.bin`);
    if (!fs.existsSync(f)) return null;
    const v = fs.readFileSync(f); return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
  });
  const albedo = ref('albedo'), z = lib.zonalMeanOfLevel0(tiles('albedo'));
  const binding: SurfaceBinding = { albedo: { base: 0, maxLevel: 0, zonal: z, map0: lib.level0Map(tiles('albedo')) } };
  const surface: SceneBody['surface'] = { albedo };
  if (id === '301') {
    surface.photometry = ref('hapke');
    binding.photometry = { texel: lib.decodeTexelHapke(surface.photometry, albedo, tiles('hapke')), view: {} as GPUTextureView };
  }
  if (id === '399') { surface.clouds = ref('clouds'); binding.clouds = { base: 2, maxLevel: 0 }; }
  const irradiance = json('light.json').sun.irradianceXYZS_1AU.value;
  const solarRadius = json('bodies.json').find((b: any) => b.id === 10).radii.value[0];
  const refs = json('albedo-reference.json');
  const state = new lib.AdaptationState(); state.update({ coneCdM2: 1e-5, rodCdM2: 1.4e-5, cornealFlux: 0 }, 0);
  const eye = lib.computeEyeFrame(lib.DEFAULT_EYE_SETTINGS, state, 'eye', 0, null);
  // A nearby resolved body: distance/angles are test viewing geometry, all physical inputs are built data.
  const at = (f: number, point = false): SceneSnapshot => {
    const a = 0.3 + f * 1e-3, lat = 0.2 + f * 1e-4, spin = f * 1e-3;
    const D = Math.max(...b.radii.value) * (point ? 1e6 : 20);
    const c = Math.cos(lat), s = Math.sin(lat), C = Math.cos(spin), S = Math.sin(spin);
    const body: SceneBody = { id: Number(id), name: b.name, pos: [D * Math.sin(spin), 0, -D * Math.cos(spin)], toSun: [1e8 * Math.sin(a), 0, 1e8 * Math.cos(a)], orient: [-s*S, s*C, -c, c*S, -c*C, -s, -C, -S, 0], radii: b.radii.value, albedoXYZS: p.geometricAlbedoXYZS.value, phase: p.phaseFunction.value, spatialModel: p.spatialModel?.value, diskReflectanceModel: p.diskReflectanceModel?.value, albedoMeasurementView: p.albedoMeasurementView?.value, albedoReferenceNormalization: refs[id]?.value, surfaceUnknown: false, worstLabel: 'estimated', selected: false, allowPhaseExtrapolation: true, surface };
    return { et: f, camera: { orient: [1,0,0,0,1,0,0,0,1], fovY: 0.5, width: 1280, height: 720 }, sun: { pos: [0,0,1e8], radius: solarRadius, irradianceXYZS_1AU: irradiance, limbDarkening: null }, bodies: [body], view: { mode: 'eye', exposureBoostStops: 0, overlays: { provenanceTint: false } }, orbits: [] };
  };
  return { name: b.name, law: binding.photometry ? 'texel Hapke' : p.spatialModel?.value?.kind ?? 'Lambert', run: (f: number, point = false) => { const s = at(f, point); return lib.prepareFrame(s, lib.cameraGeom(s, 1280, 720, 1e-7), eye, 1e-9, { surfaces: () => binding }); } };
}
describe('mapped-body frame preparation', () => {
  it.skipIf(!built)('all built maps: moving CPU budget and zero integrations after the first still frame', async () => {
    const lib = await instrumented();
    const failures: string[] = [];
    for (const id of ids) {
      if (proc.env.MAP_COST_FILE) fs.appendFileSync(proc.env.MAP_COST_FILE, `starting ${id}\n`);
      const input = inputs(lib, id);
      for (const point of [false, true]) {
        reset(); const first = input.run(0, point), initialCalls = { ...counters };
        reset(); const stillTimes = Array.from({ length: 31 }, () => { const t = cpu(); const p = input.run(0, point); expect(p.resolved.map(b => b.K)).toEqual(first.resolved.map(b => b.K)); return cpu() - t; });
        const stillCalls = total(), stillByFunction = { ...counters };
        reset(); const digest = crypto.createHash('sha256');
        const movingTimes = Array.from({ length: 61 }, (_, i) => { const t = cpu(); const result = input.run(i + 1, point); const ms = cpu() - t; digest.update(JSON.stringify({ resolved: result.resolved.map(({ body, surface, atmosphere, ...r }) => r), points: result.points, glare: result.glare, warnings: result.warnings })); return ms; });
        const movingMedian = median(movingTimes);
        const row = { id, name: input.name, law: input.law, point, initialCalls, stillCalls, stillByFunction, movingCalls: { ...counters }, movingOutputSha256: digest.digest('hex'), stillMedianCpuMs: median(stillTimes), movingMedianCpuMs: movingMedian };
        if (proc.env.MAP_COST_REPORT) console.log(JSON.stringify(row));
        if (proc.env.MAP_COST_FILE) fs.appendFileSync(proc.env.MAP_COST_FILE, JSON.stringify(row) + '\n');
        if (!proc.env.MAP_COST_CENSUS) {
          if (stillCalls) failures.push(`${id} point=${point}: ${stillCalls} repeated integrations`);
          // This process CPU budget covers a whole single-body prepareFrame, not just its lookup.
          // Baseline observed 0.02–4 ms; 10 ms catches expensive integrals without scheduler wall-time noise.
          expect(movingMedian, `${id} point=${point}: moving CPU median`).toBeLessThan(10);
        }
      }
    }
    expect(ids.length).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  }, 120000);
});
