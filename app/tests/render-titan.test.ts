// Titan drawn from its atmosphere model (docs/rendering-earth.md §8 "Titan"): the renderer's disk-integrated
// reflectance — its CPU twin, atmosphere.ts diskReflectanceSpectral, with the tables and the march the shaders use —
// against the Monte Carlo solution of the same model (docs/reports/titan-mc.json, pipeline/src/pipeline/photometry/
// titan_rt.py: exact multiple scattering in spherical geometry). The tolerances are the renderer's documented
// approximation errors, not a fit: the orders of scattering assume the column's solar zenith angle all around a
// point, which misses the light that reaches the terminator from the sunlit side (the crescent at 120–150°).
//
// TITAN_REPORT=1 also writes docs/reports/titan-renderer.json (every sample as its own bin, and the app's 12 bins, at
// the report's phase angles) for pipeline/src/pipeline/photometry/titan_check.py; a few minutes.

import { describe, expect, it } from 'vitest';
import { atmosphereModelFromData, diskReflectanceSpectral, precomputeAtmosphere, ProfileGrid, type AtmosphereModel } from '../src/render/atmosphere';
import type { AtmosphereFile } from '../src/data/schema';
import { DATA_DIR } from './core-data';

interface Fs { existsSync(p: string): boolean; readFileSync(p: string, enc: 'utf8'): string; writeFileSync(p: string, s: string): void }
const fs: Fs = await import(/* @vite-ignore */ 'node:fs' as string);
const nodeUrl: { fileURLToPath(u: URL): string } = await import(/* @vite-ignore */ 'node:url' as string);
const env = ((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {});

const MC_PATH = nodeUrl.fileURLToPath(new URL('../../docs/reports/titan-mc.json', import.meta.url));
const OUT_PATH = nodeUrl.fileURLToPath(new URL('../../docs/reports/titan-renderer.json', import.meta.url));
const atmPath = DATA_DIR + 'atmospheres.json';
const af: AtmosphereFile | null = fs.existsSync(atmPath) ? JSON.parse(fs.readFileSync(atmPath, 'utf8')) as AtmosphereFile : null;
if (!af) console.warn('[render-titan] atmospheres.json not built; skipping');

interface McFile {
  alphaDeg: number[];
  inputs: { columnOpticalDepth: Record<string, number[]>; singleScatteringAlbedo: Record<string, number[]>; surfaceReflectance: number[] };
  curves: { sample: number; wavelengthNm: number; AgPhi: number[]; sigma: number[] }[];
}
const mc = JSON.parse(fs.readFileSync(MC_PATH, 'utf8')) as McFile;

/** The Monte Carlo A_gΦ of sample k at α: linear between bin centres (the first, at 6.0°, held below). */
function mcAt(k: number, alphaDeg: number): number {
  const a = mc.alphaDeg, v = mc.curves[k].AgPhi;
  if (alphaDeg <= a[0]) return v[0];
  for (let i = 1; i < a.length; i++) if (a[i] >= alphaDeg) return v[i - 1] + ((v[i] - v[i - 1]) * (alphaDeg - a[i - 1])) / (a[i] - a[i - 1]);
  return v[v.length - 1];
}

function titanModel(opts: { only?: number[] } = {}): AtmosphereModel {
  const body = af!.bodies['606'];
  const r = atmosphereModelFromData({ wavelengthsNm: af!.wavelengthsNm, foldWeights: af!.foldWeights.value!, body }, 0, 1,
    { ...opts, groundPerSample: body.surfaceReflectance!.value!.reflectance, multipleScattering: 'orders' });
  if ('error' in r) throw new Error(r.error);
  return r.model;
}

const dir = (a: number): [number, number, number] => [Math.sin((a * Math.PI) / 180), 0, Math.cos((a * Math.PI) / 180)];

describe.skipIf(!af)('Titan drawn from its atmosphere model', () => {
  it('the Monte Carlo reference was computed from this atmospheres.json', () => {
    const body = af!.bodies['606'];
    for (const c of body.components) {
      const ref = mc.inputs.columnOpticalDepth[c.id];
      expect(ref, c.id).toBeDefined();
      c.columnOpticalDepth.forEach((t, k) => expect(Math.abs(t - ref[k])).toBeLessThanOrEqual(1e-5 * Math.max(1, t)));
      expect(c.singleScatteringAlbedo.value, c.id).toEqual(mc.inputs.singleScatteringAlbedo[c.id]);
    }
    expect(body.surfaceReflectance!.value!.reflectance).toEqual(mc.inputs.surfaceReflectance);
  });

  it('renders within its approximation errors of the exact solution (disk-integrated, 400–800 nm)', () => {
    // Every 5th sample as its own bin (the app's bins average 4 samples; a sample is what the reference computed).
    const only = [4, 14, 24, 34, 44];
    const m = titanModel({ only });
    const tab = precomputeAtmosphere(m);
    const G = new ProfileGrid(m, 512);
    // Phase angle → largest |renderer / reference − 1| (docs/rendering-earth.md §8 "Titan").
    const tol: [number, number][] = [[6.04, 0.07], [60, 0.05], [120, 0.12], [150, 0.16], [166, 0.06]];
    const rows: string[] = [];
    for (const [a, t] of tol) {
      const d = diskReflectanceSpectral(m, tab, G, dir(a), [0, 0, 1], m.groundAlbedo, 20, 32);
      const r = only.map((k, i) => d.A[i] / mcAt(k, a));
      rows.push(`${a}°: ` + r.map((x, i) => `${af!.wavelengthsNm[only[i]]} nm ${x.toFixed(3)}`).join(', '));
      for (const x of r) expect(Math.abs(x - 1), `α ${a}°: ${r.map((y) => y.toFixed(3)).join(' ')}`).toBeLessThanOrEqual(t);
    }
    console.log('[render-titan] renderer / Monte Carlo\n  ' + rows.join('\n  '));
  }, 300000);

  it.runIf(env.TITAN_REPORT === '1')('writes docs/reports/titan-renderer.json', async () => {
    const phases = [6.04, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 155, 160, 163, 166, 169];
    const out: Record<string, unknown> = {
      what: 'The renderer\'s disk-integrated reflectance A_gΦ(α) for Titan (app/tests/render-titan.test.ts, CPU twin of the shaders): per sample (each its own bin) and with the app\'s bins; bin weights are the X, Y, Z, S fold weights of each bin.',
      phasesDeg: phases, diskPoints: 32, marchSteps: 48,
    };
    // Yields between the long computations, so that the test runner's worker stays responsive.
    const tick = () => new Promise((res) => setTimeout(res, 0));
    const run = async (m: AtmosphereModel) => {
      const tab = precomputeAtmosphere(m);
      const G = new ProfileGrid(m, 512);
      const rows: number[][] = [];
      for (const a of phases) {
        await tick();
        rows.push(Array.from(diskReflectanceSpectral(m, tab, G, dir(a), [0, 0, 1], m.groundAlbedo, 32, 48).A));
      }
      return rows;
    };
    // Every sample its own bin, in four models of 12 (bins are independent; shorter table computations).
    const wl: number[] = [];
    const A: number[][] = phases.map(() => []);
    for (let q = 0; q < af!.wavelengthsNm.length; q += 12) {
      const part = titanModel({ only: af!.wavelengthsNm.map((_, k) => k).slice(q, q + 12) });
      await tick();
      const rows = await run(part);
      wl.push(...part.wavelengthsNm);
      rows.forEach((row, i) => A[i].push(...row));
    }
    out.perSample = { wavelengthsNm: wl, A };
    const app = titanModel();
    out.appBins = { wavelengthsNm: app.wavelengthsNm, weights: app.weights, A: await run(app) };
    fs.writeFileSync(OUT_PATH, JSON.stringify(out) + '\n');
  }, 3600000);
});
