// Numerical integration probes, independent of images/validation and the production node mapping.
import { describe, expect, it } from 'vitest';
import { zonalMeanOfLevel0 } from '../src/render/surface';
import type { BodyPhotometry } from '../src/data/schema';
import { gaussLegendre, LAW, LAMBERT_LAW, lawDiskIntegral, lawRadf, resolveLaw, type ResolvedLaw, type ZonalProfile, MotionNormalization } from '../src/render/spatial';
const fs: { existsSync(p: URL): boolean; readFileSync(p: URL, enc: 'utf8'): string; readFileSync(p: URL): Uint8Array } =
  await import(/* @vite-ignore */ 'node:fs' as string);
const path = new URL('../public/data/photometry.json', import.meta.url);
const built = fs.existsSync(path);
const photometry: Record<string, BodyPhotometry> = built ? JSON.parse(fs.readFileSync(path, 'utf8')) : {};
const { env }: { env: Record<string, string | undefined> } = await import(/* @vite-ignore */ 'node:process' as string);
const sparsePhases = [0, 1e-5, 1, 15, 30, 60, 90, 120, 150, 170, 175, 179, 179.5, 179.9];
// Optional dense numerical scan; independent of GPU scenes. Ordinary tests retain the critical phases.
const phases = env.LAW_QUADRATURE_REPORT
  ? [...new Set([...sparsePhases, ...Array.from({ length: 180 }, (_, i) => i)])].sort((a, b) => a - b) : sparsePhases;

/** High-resolution composite GL in the ORIGINAL longitude/latitude coordinates. Splits resolve
 * Barkstrom's limb kink and the Akimov latitude concentration. No production mapping is reused. */
function reference(law: ResolvedLaw, a: number, n = 160, zonal?: { profile: ZonalProfile; pole: [number, number, number] }) {
  const { x, w } = gaussLegendre(n), hi = Math.PI / 2, lo = a - hi;
  const lc = [lo, ...[hi - 0.01, hi - 0.001, hi - 0.0001].filter(v => v > lo), hi];
  const bc = [0, 0.1, hi];
  let sum = 0;
  for (let j = 1; j < lc.length; j++) for (let k = 1; k < bc.length; k++) {
    const dl = (lc[j] - lc[j - 1]) / 2, db = (bc[k] - bc[k - 1]) / 2;
    for (let p = 0; p < n; p++) {
      const lam = lc[j - 1] + (x[p] + 1) * dl;
      for (let q = 0; q < n; q++) {
        const beta = bc[k - 1] + (x[q] + 1) * db, cb = Math.cos(beta);
        const mu = cb * Math.cos(lam), mu0 = cb * Math.cos(lam - a);
        let weight = 2;
        if (zonal) {
          const { profile: z, pole: P } = zonal;
          weight = 0;
          for (const sign of [-1, 1]) {
            const lat = Math.asin(Math.max(-1, Math.min(1, cb * Math.sin(lam) * P[0] + sign * Math.sin(beta) * P[1] + mu * P[2])));
            const v = (0.5 - lat / Math.PI) * z.rows - 0.5;
            const j = Math.max(0, Math.min(z.rows - 1, Math.floor(v))), t = Math.max(0, Math.min(1, v - j));
            weight += z.mean[4 * j + 1] * (1 - t) + z.mean[4 * Math.min(j + 1, z.rows - 1) + 1] * t;
          }
        }
        sum += weight * lawRadf(law, mu0, mu, a) * mu * cb * w[p] * w[q] * dl * db;
      }
    }
  }
  return sum / Math.PI;
}
const cases = [
  ...[LAW.lambert, LAW.lommelSeeliger, LAW.lunarLambert].map(kind => ({ name: `test law ${kind}`, law: { ...LAMBERT_LAW, kind, p: 0.4 } })),
  ...[0, 0.5, 1, 2].map(p => ({ name: `test Minnaert k=${p}`, law: { ...LAMBERT_LAW, kind: LAW.minnaert, p } })),
];
describe('disk quadrature: relative accuracy across 0–179.9°, including thin crescents', () => {
  for (const entry of cases) it(entry.name, async () => {
    for (const phase of phases) {
      if (env.LAW_QUADRATURE_REPORT) await new Promise(resolve => setTimeout(resolve, 0));
      const a = phase * Math.PI / 180, ref = reference(entry.law, a), value = lawDiskIntegral(entry.law, a, undefined, 32)[0];
      if (env.LAW_QUADRATURE_REPORT) console.log(JSON.stringify({ name: entry.name, phase, value, ref, rel: value / ref - 1 }));
      expect(Math.abs(value / ref - 1), `${phase}°`).toBeLessThan(1e-4);
    }
  }, env.LAW_QUADRATURE_REPORT ? 120000 : 30000);
  for (const [id, p] of Object.entries(photometry)) {
    if (!p.spatialModel?.value || ['602', '603', '604', '605'].includes(id)) continue;
    it(`${id} ${p.spatialModel.value.kind} (built parameters)`, async () => {
      for (const phase of phases) {
        if (env.LAW_QUADRATURE_REPORT) await new Promise(resolve => setTimeout(resolve, 0));
        const a = phase * Math.PI / 180, resolved = resolveLaw(p.spatialModel!.value, a);
        if ('error' in resolved) continue; // e.g. a phase-dependent table's measured domain
        const law = resolved.law, ref = reference(law, a);
        const value = lawDiskIntegral(law, a, undefined, law.kind === LAW.hapke ? 24 : 32)[0];
        if (env.LAW_QUADRATURE_REPORT) console.log(JSON.stringify({ id, phase, value, ref, rel: value / ref - 1 }));
        expect(Math.abs(value / ref - 1), `${phase}°`).toBeLessThan(1e-4);
      }
    }, env.LAW_QUADRATURE_REPORT ? 120000 : 30000);
  }
  for (const [id, phase] of [['599', 179.9], ['599', 60], ['699', 0], ['699', 179.9], ['799', 90], ['899', 179.9]] as const) {
    const paths = [0, 1].map(t => new URL(`../public/data/surfaces/${id}/albedo/0/0/${t}.bin`, import.meta.url));
    it.skipIf(!paths.every(p => fs.existsSync(p)))(`${id} at ${phase}°: actual zonal row knots converge and agree within 1e-4`, () => {
      const tiles = paths.map(p => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; });
      const profile = zonalMeanOfLevel0(tiles);
      const a = phase * Math.PI / 180, resolved = resolveLaw(photometry[id].spatialModel!.value, a);
      if ('error' in resolved) throw new Error(resolved.error);
      for (const pole of [[0.3, 0.7, Math.sqrt(0.42)], [0, 1, 0], [0, 0, 1]] as [number, number, number][]) {
        const zonal = { profile, pole }, ref = reference(resolved.law, a, 320, zonal);
        expect(Math.abs(lawDiskIntegral(resolved.law, a, zonal, 32)[1] / ref - 1), `pole ${pole}`).toBeLessThan(1e-4);
      }
    });
  }
  it('Akimov 179.9° with a tilted smooth zonal profile (test input) agrees within 1e-4', () => {
    const rows = 64, mean = new Float64Array(4 * rows);
    for (let j = 0; j < rows; j++) for (let c = 0; c < 4; c++) mean[4 * j + c] = 1 + 0.5 * Math.sin(Math.PI * (0.5 - (j + 0.5) / rows));
    const zonal = { profile: { rows, mean }, pole: [0.3, 0.7, Math.sqrt(0.42)] as [number, number, number] };
    const law = { ...LAMBERT_LAW, kind: LAW.akimov }, a = 179.9 * Math.PI / 180;
    expect(Math.abs(lawDiskIntegral(law, a, zonal, 32)[1] / reference(law, a, 320, zonal) - 1)).toBeLessThan(1e-4);
  });
  it.skipIf(!built)('has sourced built parameters (otherwise build light first)', () => {
    expect(Object.keys(photometry).length).toBeGreaterThan(0);
  });
  it('reference converges at Akimov 179.9° to 1e-6', () => {
    const law = { ...LAMBERT_LAW, kind: LAW.akimov }, a = 179.9 * Math.PI / 180;
    expect(Math.abs(reference(law, a, 160) / reference(law, a, 320) - 1)).toBeLessThan(1e-6);
  });
});

// Motion uses this same entry point; the accepted quadrature above stays its independent oracle.
const motionPhases = env.LAW_MOTION_REPORT ? [...new Set([...sparsePhases, ...Array.from({ length: 180 }, (_, i) => i)])] : [0, 0.00001, 0.01, 0.1, 1, 3, 17, 41, 73, 91, 119, 135, 150, 170, 175, 179, 179.5, 179.9];
describe('motion normalization: bounded approximation, independent of image scores', () => {
  it('interpolated bare laws stay within 2e-5 relative, including opposition and crescents', () => {
    const cache = new MotionNormalization();
    for (const id of ['499', '501', '502', '503', '504', '601', '801', '901', '999']) {
      for (const deg of motionPhases) {
        const a = deg * Math.PI / 180, r = resolveLaw(photometry[id].spatialModel!.value, a);
        if ('error' in r) continue;
        const value = cache.get(r.law, a), exact = lawDiskIntegral(r.law, a, undefined, 24);
        expect(Math.abs(value[1] / exact[1] - 1), `${id} at ${deg}`).toBeLessThan(2e-5);
      }
    }
  }, 60000);
  for (const id of ['599', '699', '799', '899']) it(`${id}: moving pole and phase stay within 2e-5 of converged row quadrature`, () => {
    const tiles = [0, 1].map(t => {
      const b = fs.readFileSync(new URL(`../public/data/surfaces/${id}/albedo/0/0/${t}.bin`, import.meta.url));
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    });
    const profile = zonalMeanOfLevel0(tiles), cache = new MotionNormalization();
    let maxRelative = 0, comparisons = 0;
    for (const deg of motionPhases) {
      const a = deg * Math.PI / 180, r = resolveLaw(photometry[id].spatialModel!.value, a);
      if ('error' in r) throw new Error(r.error);
      for (const pole of [[0.3, 0.7, Math.sqrt(0.42)], [0, 1, 0], [0, 0, 1]] as [number, number, number][]) {
        const zonal = { profile, pole }, value = cache.get(r.law, a, zonal), exact = lawDiskIntegral(r.law, a, zonal);
        for (let c = 0; c < 4; c++) {
          const relative = Math.abs(value[c] / exact[c] - 1);
          maxRelative = Math.max(maxRelative, relative); comparisons++;
          expect(relative, `${deg} pole=${pole} c=${c}`).toBeLessThan(2e-5);
        }
      }
    }
    if (env.LAW_MOTION_REPORT) console.log(JSON.stringify({ id, maxRelative, comparisons }));
  }, env.LAW_MOTION_REPORT ? 180000 : 30000);
});
