// Titan drawn from its atmosphere model (docs/rendering-earth.md §8 "Titan"): the renderer's disk-integrated
// reflectance — its CPU twin, atmosphere.ts diskReflectanceSpectral, with the tables and the march the shaders use —
// against the Monte Carlo solution of the same model (docs/reports/titan-mc.json, pipeline/src/pipeline/photometry/
// titan_rt.py: exact multiple scattering in spherical geometry). The tolerances are the renderer's documented
// approximation errors, not a fit: the orders of scattering assume the column's solar zenith angle all around a
// point, which misses the light that reaches the terminator from the sunlit side (the crescent at 120–150°).
// And what the frame then draws (frame.ts): that model scaled per channel to Titan's disk photometry, so that inside
// the photometry's phase range the disk's integral is the measurement (architecture §4.3).
//
// TITAN_REPORT=1 also writes docs/reports/titan-renderer.json (every sample as its own bin, and the app's 12 bins, at
// the report's phase angles; and the frame's own disk integrals at 0–6°) for pipeline/src/pipeline/photometry/
// titan_check.py; under a minute on the workstation.

import { describe, expect, it } from 'vitest';
import { atmosphereFor } from '../src/app/extras';
import { atmosphereModelFromData, diskReflectanceSpectral, modelDiskXYZS, precomputeAtmosphere, ProfileGrid, type AtmosphereModel } from '../src/render/atmosphere';
import type { AtmosphereBinding } from '../src/render/atmosphereGpu';
import { AU_KM } from '../src/render/constants';
import { cameraGeom, prepareFrame } from '../src/render/frame';
import { evalPhase } from '../src/render/photometry';
import type { SceneBody, SceneSnapshot } from '../src/render/scene';
import { AdaptationState, computeEyeFrame } from '../src/eye/model';
import { DEFAULT_EYE_SETTINGS } from '../src/eye/settings';
import type { AtmosphereFile, BodyPhotometry, LightData } from '../src/data/schema';
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

  it('the frame scales the model to photometry and carries the same integrated disk light in its point at every phase', () => {
    const ph = (JSON.parse(fs.readFileSync(DATA_DIR + 'photometry.json', 'utf8')) as Record<string, BodyPhotometry>)['606'];
    const irr = (JSON.parse(fs.readFileSync(DATA_DIR + 'light.json', 'utf8')) as LightData).sun.irradianceXYZS_1AU.value as [number, number, number, number];
    const albedo = ph.geometricAlbedoXYZS.value as [number, number, number, number];
    const phase = ph.phaseFunction.value!;
    // The atmosphere as the app attaches it at Best estimate (the surface under the air included), and the model
    // and tables the renderer builds from it (atmosphereGpu.ts binding).
    const atm = atmosphereFor(af, 606, 'best')!;
    expect(atm.surface).toBeDefined();
    const m = titanModel();
    const tab = precomputeAtmosphere(m);
    const G = new ProfileGrid(m, 512);
    const bind = { model: m, tables: tab, grid: G, key: 'titan' } as unknown as AtmosphereBinding;
    const R = af!.bodies['606'].referenceRadiusKm, dAU = 9.5, dist = 2e5, W = 1280, H = 720;
    const scene = (phaseDeg: number): SceneSnapshot => {
      const a = (phaseDeg * Math.PI) / 180;
      const toSun: [number, number, number] = [dAU * AU_KM * Math.sin(a), 0, dAU * AU_KM * Math.cos(a)];
      const b: SceneBody = {
        id: 606, name: 'Titan', pos: [0, 0, -dist], toSun, orient: [1, 0, 0, 0, 1, 0, 0, 0, 1], radii: [R, R, R],
        albedoXYZS: albedo, phase, surfaceUnknown: false, worstLabel: 'estimated', selected: false, allowPhaseExtrapolation: true, atmosphere: atm,
      };
      return {
        et: 0, camera: { orient: [1, 0, 0, 0, 1, 0, 0, 0, 1], fovY: (4 * Math.PI) / 180, width: W, height: H },
        sun: { pos: [toSun[0], toSun[1], toSun[2] - dist], radius: 696000, irradianceXYZS_1AU: irr, limbDarkening: null },
        bodies: [b], view: { mode: 'eye', exposureBoostStops: 0, overlays: { provenanceTint: false } }, orbits: [],
      };
    };
    const st = new AdaptationState();
    st.update({ coneCdM2: 1e-5, rodCdM2: 1.4e-5, cornealFlux: 0 }, 0);
    const eye = computeEyeFrame(DEFAULT_EYE_SETTINGS, st, 'eye', 0, null);
    const g = cameraGeom(scene(0), W, H, 1e-7);
    const sunOverPi = irr.map((v) => v / (Math.PI * dAU * dAU));
    const rho = atm.surface!.xyzs;
    const factorsAt = (phaseDeg: number) => {
      const f = prepareFrame(scene(phaseDeg), g, eye, 1e-9, { atmospheres: () => bind });
      const r = f.resolved[0];
      expect(r.atmosphere?.onDisk, `α ${phaseDeg}°`).toBe(true);
      const fac = r.atmosphere!.sunE.map((v, c) => v / sunOverPi[c]);
      // One factor per channel on the surface term and on the air alike.
      r.K.forEach((v, c) => expect(v / (sunOverPi[c] * rho[c]), `α ${phaseDeg}°`).toBeCloseTo(fac[c], 10));
      return { fac, line: f.warnings.filter((w) => w.startsWith('Titan: atmosphere model scaled')) };
    };
    // Same geometry, under a pixel across: change sampling only, so the point and disk have the same R/Δ.
    const dotGeom = { ...g, pixelAngle: 4 * Math.asin(R / dist) };
    const coldStart = performance.now();
    prepareFrame(scene(150), dotGeom, eye, 1e-9, { atmospheres: () => bind });
    const coldMs = performance.now() - coldStart;
    const warmStart = performance.now();
    for (let i = 0; i < 100; i++) prepareFrame(scene(150), dotGeom, eye, 1e-9, { atmospheres: () => bind });
    console.log(`[render-titan] point at 150°: cold frame ${coldMs.toFixed(2)} ms; warm ${( (performance.now() - warmStart) / 100).toFixed(3)} ms/frame (tables already ready)`);
    const rows: string[] = [];
    let worst = 0;
    for (const phaseDeg of [0, 0.5, 1, 1.5, 2.5, 3.5, 4.5, 5.6]) {
      const { fac, line } = factorsAt(phaseDeg);
      // The disk integral of what is drawn, with the model's integrals on a finer grid at the exact phase angle.
      const d = modelDiskXYZS(m, tab, G, dir(phaseDeg), [0, 0, 1], 64);
      const ev = evalPhase(phase, (phaseDeg * Math.PI) / 180);
      if (!ev.ok) throw new Error(ev.reason);
      const ratio = [0, 1, 2, 3].map((c) => (fac[c] * (d.air[c] + rho[c] * d.surface[c])) / ((albedo[c] / irr[c]) * ev.phi));
      rows.push(`${phaseDeg}°: factors ${fac.map((x) => x.toFixed(4)).join(' ')}; drawn / measured ${ratio.map((x) => x.toFixed(4)).join(' ')}`);
      // 0.1 %: the frame's 1° phase bins and its coarser grid (numerical; measured 0.05 % at most).
      for (const x of ratio) { expect(Math.abs(x - 1), `α ${phaseDeg}°: ${ratio.map((y) => y.toFixed(4)).join(' ')}`).toBeLessThanOrEqual(0.001); worst = Math.max(worst, Math.abs(x - 1)); }
      expect(line).toHaveLength(1);
      expect(line[0]).not.toContain('estimated');
    }
    // Beyond the measured range: the factors of its edge, at any phase, and the line says it is an estimate.
    const edge = factorsAt(5.7 + 1e-9);
    for (const phaseDeg of [30, 61, 170]) {
      const { fac, line } = factorsAt(phaseDeg);
      fac.forEach((v, c) => expect(v).toBeCloseTo(edge.fac[c], 10));
      expect(line).toHaveLength(1);
      expect(line[0]).toContain('→ estimated');
      if (phaseDeg === 61) rows.push(line[0]);
    }
    // The point and off-frame glare must carry the model's integrated light with the disk's own factors.
    // Use the frame's stated 24-point quadrature, independently integrating its surface and air radiances.
    // 0.1 % covers interpolation at 5.7°; at integer phases the two should agree to roundoff. The finer-grid
    // error at high phase is reported separately: the documented convergence bound only covers α ≤ 60°.
    for (const a of [0, 3, 5.7, 30, 90, 150, 166]) {
      const s = scene(a);
      const disk = prepareFrame(s, g, eye, 1e-9, { atmospheres: () => bind }).resolved[0];
      const d = modelDiskXYZS(m, tab, G, dir(a), [0, 0, 1]);
      const fine = modelDiskXYZS(m, tab, G, dir(a), [0, 0, 1], 64);
      const integrated = [0, 1, 2, 3].map((c) => Math.PI * (R / dist) ** 2 *
        (disk.atmosphere!.sunE[c] * d.air[c] + disk.K[c] * d.surface[c]));
      const point = prepareFrame(s, dotGeom, eye, 1e-9, { atmospheres: () => bind });
      expect(point.resolved).toHaveLength(0);
      expect(point.points).toHaveLength(1);
      const ratio = point.points[0].E.map((v, c) => v / integrated[c]);
      const old = prepareFrame(s, dotGeom, eye, 1e-9).points[0].E;
      rows.push(`${a}°: point / disk ${ratio.map((v) => v.toFixed(6)).join(' ')}; model / old point ${integrated.map((v, c) => (v / old[c]).toFixed(4)).join(' ')}; 24 / 64 quadrature ${d.air.map((v, c) => ((v + rho[c] * d.surface[c]) / (fine.air[c] + rho[c] * fine.surface[c]))).map((v) => v.toFixed(6)).join(' ')}`);
      ratio.forEach((v, c) => expect.soft(Math.abs(v - 1), `point/disk α ${a}°, channel ${c}`).toBeLessThanOrEqual(0.001));
      // Turn the camera 5°: Titan is outside the frame, inside the glare field. Its physical geometry is unchanged.
      const theta = 5 * Math.PI / 180;
      const offGeom = { ...dotGeom, back: [Math.sin(theta), 0, Math.cos(theta)] as [number, number, number],
        right: [Math.cos(theta), 0, -Math.sin(theta)] as [number, number, number] };
      const off = prepareFrame(s, offGeom, eye, 1e-9, { atmospheres: () => bind });
      const glare = off.glare.find((v) => v.dir[2] === -1)!;
      expect(glare?.inFrame).toBe(false);
      expect(glare.E).toEqual(point.points[0].E);
      expect.soft(point.warnings.filter((w) => w.startsWith('Titan:'))).toEqual(a <= 5.7 ? [] :
        prepareFrame(s, g, eye, 1e-9, { atmospheres: () => bind }).warnings.filter((w) => w.startsWith('Titan:')));
      if (a <= 5.7) expect.soft(point.points[0].E).toEqual(old);
    }
    rows.push(`edge (5.7°) factors ${edge.fac.map((x) => x.toFixed(4)).join(' ')}; largest |drawn / measured − 1| in range ${(100 * worst).toFixed(2)} %`);
    console.log('[render-titan] the model scaled to the disk photometry (X, Y, Z, S)\n  ' + rows.join('\n  '));
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
    // What the frame scales to the disk photometry (frame.ts modelDisk): the app's model folded to X, Y, Z, S as the
    // shaders compose it (modelDiskXYZS with the surface's channel equivalents), at the frame's 1° phase bins and grid.
    await tick();
    const tab = precomputeAtmosphere(app);
    const G = new ProfileGrid(app, 512);
    const rho = af!.bodies['606'].surfaceReflectance!.value!.channelEquivalents;
    const bins = [0, 1, 2, 3, 4, 5, 6];
    out.frameModel = {
      what: 'The disk-integrated reflectance X, Y, Z, S of the app\'s model as the frame computes it to scale the model to the disk photometry (frame.ts modelDisk; atmosphere.ts modelDiskXYZS: the air\'s light plus the surface term with the surface\'s channel equivalents), at its 1° phase bins; the frame interpolates linearly between them.',
      phasesDeg: bins,
      A: bins.map((a) => { const d = modelDiskXYZS(app, tab, G, dir(a), [0, 0, 1]); return [0, 1, 2, 3].map((c) => d.air[c] + rho[c] * d.surface[c]); }),
    };
    fs.writeFileSync(OUT_PATH, JSON.stringify(out) + '\n');
  }, 3600000);
});
