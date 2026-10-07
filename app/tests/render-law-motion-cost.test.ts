// The normalization lookup runs on the main thread inside a frame: its cost is bounded, first use included.
// 7 October 2026: after the converged quadratures landed, a Hapke body cost 1.5–2.5 s the first time it was
// seen (a table built on first use) and a mapped Hapke body 0.8–6 s in every frame (the converged zonal
// integral, uncached): Pluto with Charon ran at 1.3 frames per second. The scene suite waits for a settled
// frame and did not see it.
import { describe, expect, it } from 'vitest';
import { zonalMeanOfLevel0 } from '../src/render/surface';
import type { BodyPhotometry } from '../src/data/schema';
import { lawDiskIntegral, MotionNormalization, EllipsoidNormalization, photometricFrame, LAMBERT_LAW, resolveLaw, type ZonalProfile } from '../src/render/spatial';
const fs: { existsSync(p: URL): boolean; readFileSync(p: URL, enc: 'utf8'): string; readFileSync(p: URL): Uint8Array } =
  await import(/* @vite-ignore */ 'node:fs' as string);
const path = new URL('../public/data/photometry.json', import.meta.url);
const built = fs.existsSync(path);
const photometry: Record<string, BodyPhotometry> = built ? JSON.parse(fs.readFileSync(path, 'utf8')) : {};
const { env }: { env: Record<string, string | undefined> } = await import(/* @vite-ignore */ 'node:process' as string);

/**
 * Budgets in CPU time of this test's own process (process.cpuUsage), not wall time: on 7 October the first
 * version of this test measured wall time and failed in the landing gate, where the suite's other workers and
 * eight lanes shared the machine (425 ms of wall time for a lookup that takes 14-26 ms alone).
 * - The first lookup of a body may set up what later lookups reuse (the giants' zonal spectrum: 14-26 ms).
 *   250 ms fails the 1.5-2.5 s table of 7 October by a factor of six and leaves ten times the normal cost.
 * - A lookup at a moving phase happens in every frame: the median of five is held under 20 ms (normal 0.03 to
 *   2 ms; the regression was 100 ms for Mars and 800 ms for Pluto under their maps).
 */
const FIRST_LOOKUP_BUDGET_MS = 250;
const MOVING_LOOKUP_BUDGET_MS = 20;
const { cpuUsage }: { cpuUsage(previous?: { user: number; system: number }): { user: number; system: number } } =
  await import(/* @vite-ignore */ 'node:process' as string);
const cpuMs = (f: () => unknown): number => { const t = cpuUsage(); f(); const d = cpuUsage(t); return (d.user + d.system) / 1000; };
const median = (v: number[]) => v.slice().sort((a, b) => a - b)[v.length >> 1];
const tile = (id: string, t: number) => new URL(`../public/data/surfaces/${id}/albedo/0/0/${t}.bin`, import.meta.url);
function zonalOf(id: string): ZonalProfile | null {
  if (![0, 1].some((t) => fs.existsSync(tile(id, t)))) return null;
  return zonalMeanOfLevel0([0, 1].map((t) => {
    if(!fs.existsSync(tile(id,t))) return null;
    const b = fs.readFileSync(tile(id, t));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  }));
}
const models = Object.entries(photometry).flatMap(([id, p]) => (p.spatialModel?.value ? [{ id, model: p.spatialModel.value }] : []));
describe('normalization lookups have a bounded cost on the main thread', () => {
  it.skipIf(!built)('every built law, without a map: the first lookup and lookups at moving phases', () => {
    for (const { id, model } of models) for (const deg of [0.5, 16, 90, 150]) {
      const a = (deg * Math.PI) / 180, r = resolveLaw(model, a);
      if ('error' in r) continue;
      const cache = new MotionNormalization();
      expect(cpuMs(() => cache.get(r.law, a)), `${id} ${model.kind} at ${deg}°, first use`).toBeLessThan(FIRST_LOOKUP_BUDGET_MS);
      const moving = [1, 2, 3, 4, 5].map((i) => cpuMs(() => cache.get(r.law, a + i * 1e-4)));
      expect(median(moving), `${id} ${model.kind} at ${deg}°, moving`).toBeLessThan(MOVING_LOOKUP_BUDGET_MS);
    }
  }, 120000);
  it.skipIf(!built)('every built law under its own map: the first lookup and lookups at moving phases and poles', () => {
    let mapped = 0;
    for (const { id, model } of models) {
      const profile = zonalOf(id);
      if (!profile) continue;
      mapped++;
      for (const deg of [16, 90]) {
        const cache = new MotionNormalization();
        const at = (i: number) => {
          const a = (deg * Math.PI) / 180 + i * 1e-4, r = resolveLaw(model, a);
          if ('error' in r) return null;
          const t = 0.4 + 0.01 * i, pole: [number, number, number] = [Math.sin(t) * 0.6, Math.sin(t) * 0.8, Math.cos(t)];
          return cpuMs(() => cache.get(r.law, a, { profile, pole }));
        };
        const first = at(0);
        if (first === null) continue;
        expect(first, `${id} ${model.kind} at ${deg}° with its map, first use`).toBeLessThan(FIRST_LOOKUP_BUDGET_MS);
        const moving = [1, 2, 3, 4, 5].map(at).filter((v): v is number => v !== null);
        expect(median(moving), `${id} ${model.kind} at ${deg}° with its map, moving`).toBeLessThan(MOVING_LOOKUP_BUDGET_MS);
      }
    }
    expect(mapped).toBeGreaterThan(0);
  }, 120000);
  it.skipIf(!built)('a cached value stands for every phase of its cell within 2e-5, at the opposition peak and in a thin crescent', () => {
    for (const { id, model } of models.filter((m) => m.model.kind === 'hapke')) {
      const cache = new MotionNormalization();
      for (const a0 of [0, 1e-7, 1e-5, 1e-3, 0.3, Math.PI - 1e-2, Math.PI - 1e-3]) for (const d of [0, 3e-9, 1e-7, 4e-6]) {
        const a = a0 + d, r = resolveLaw(model, a);
        if ('error' in r) continue;
        const value = cache.get(r.law, a)[1], exact = lawDiskIntegral(r.law, a, undefined, 24)[1];
        expect(Math.abs(value / exact - 1), `${id} at ${a0} + ${d} rad`).toBeLessThan(2e-5);
      }
    }
  }, 60000);
  // What the bounded-cost rule gives up: the fixed-order quadrature does not resolve the map's row knots.
  // Against the converged zonal integral (seconds per call, so one body and one phase here; LAW_MOTION_REPORT=1
  // scans every mapped Hapke body at four phases and prints the largest difference: 1.9e-3 on the build of
  // 7 October 2026).
  const scan = env.LAW_MOTION_REPORT ? models.filter((m) => m.model.kind === 'hapke').map((m) => m.id) : ['999'];
  const scanPhases = env.LAW_MOTION_REPORT ? [5, 16, 60, 120] : [16];
  it.skipIf(!built || !zonalOf('999'))('a mapped Hapke body: the fixed-order rule is within 2.5e-3 of the converged integral', () => {
    let worst = 0;
    for (const id of scan) {
      const profile = zonalOf(id);
      if (!profile) continue;
      for (const deg of scanPhases) {
        const a = (deg * Math.PI) / 180, r = resolveLaw(models.find((m) => m.id === id)!.model, a);
        if ('error' in r) continue;
        const zonal = { profile, pole: [0.3, 0.7, Math.sqrt(0.42)] as [number, number, number] };
        const value = new MotionNormalization().get(r.law, a, zonal), exact = lawDiskIntegral(r.law, a, zonal);
        for (let c = 0; c < 4; c++) {
          const rel = Math.abs(value[c] / exact[c] - 1);
          worst = Math.max(worst, rel);
          expect(rel, `${id} at ${deg}° channel ${c}`).toBeLessThan(2.5e-3);
        }
      }
    }
    if (env.LAW_MOTION_REPORT) console.log(JSON.stringify({ fixedOrderZonalHapkeWorstRelative: worst, bodies: scan, phases: scanPhases }));
  }, 600000);
});

const bodiesPath = new URL('../public/data/bodies.json', import.meta.url);
const unequal = built && fs.existsSync(bodiesPath) ? JSON.parse(fs.readFileSync(bodiesPath, 'utf8')).filter((b: {id:number;radii:{value:[number,number,number]}}) => b.radii.value && new Set(b.radii.value).size > 1 && photometry[b.id]) : [];
describe('ellipsoid frame entry points, first use included', () => {
  it.skipIf(!built)('every built unequal-radii body, reference/current/orientation mean, with and without its map', () => {
    for (const body of unequal) for (const map of [undefined, zonalOf(String(body.id)) ?? undefined]) {
      for (const deg of [0.5, 16, 90, 150]) {
        const cache = new EllipsoidNormalization(), radii = body.radii.value;
        for (const entry of ['reference','current','mean'] as const) {
          const at = (i: number): number => {
            const a=deg*Math.PI/180+i*1e-4,r=resolveLaw(photometry[body.id].spatialModel?.value,a);
            const law='error' in r?LAMBERT_LAW:r.law;
            const lat=.6+i*1e-4,o:[number,number,number]=[Math.cos(lat),0,Math.sin(lat)];
            const axes=photometricFrame(o,[o[0]*Math.cos(a),Math.sin(a),o[2]*Math.cos(a)]);
            const geometry={radii,axes,pole:[axes[0][2],axes[1][2],axes[2][2]] as [number,number,number]};
            let value: number[] = [];
            const ms=cpuMs(()=>{
              value=entry==='current'?cache.get(law,a,geometry,map):cache.reference(law,a,radii,
                entry==='mean'?{kind:'orientation-mean'}:photometry[body.id].albedoMeasurementView?.value ?? {kind:'orientation-mean'},map,entry==='reference'?photometry[body.id].albedoReferenceNormalization?.value ?? undefined:undefined);
            });
            expect(value.every(Number.isFinite)).toBe(true);
            return ms;
          };
          expect(at(0),`${body.id} ${entry} ${deg}° map=${!!map}, first use`).toBeLessThan(FIRST_LOOKUP_BUDGET_MS);
          const moving=[1,2,3,4,5].map(at);
          expect(median(moving),`${body.id} ${entry} ${deg}° map=${!!map}, moving`).toBeLessThan(MOVING_LOOKUP_BUDGET_MS);
        }
      }
    }
    expect(unequal.length).toBeGreaterThan(0);
  }, 600000);
});
