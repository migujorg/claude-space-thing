// Numerical integration probes, independent of images/validation and the production node mapping.
import { describe, expect, it } from 'vitest';
import type { BodyPhotometry } from '../src/data/schema';
import { gaussLegendre, LAW, LAMBERT_LAW, lawDiskIntegral, lawRadf, resolveLaw, type ResolvedLaw } from '../src/render/spatial';
const fs: { existsSync(p: URL): boolean; readFileSync(p: URL, enc: 'utf8'): string } =
  await import(/* @vite-ignore */ 'node:fs' as string);
const path = new URL('../public/data/photometry.json', import.meta.url);
const built = fs.existsSync(path);
const photometry: Record<string, BodyPhotometry> = built ? JSON.parse(fs.readFileSync(path, 'utf8')) : {};
const phases = [0, 1e-5, 1, 15, 30, 60, 90, 120, 150, 170, 175, 179, 179.5, 179.9];

/** High-resolution composite GL in the ORIGINAL longitude/latitude coordinates. Splits resolve
 * Barkstrom's limb kink and the Akimov latitude concentration. No production mapping is reused. */
function reference(law: ResolvedLaw, a: number, n = 160) {
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
        sum += 2 * lawRadf(law, mu0, mu, a) * mu * cb * w[p] * w[q] * dl * db;
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
  for (const entry of cases) it(entry.name, () => {
    for (const phase of phases) {
      const a = phase * Math.PI / 180, ref = reference(entry.law, a);
      expect(Math.abs(lawDiskIntegral(entry.law, a, undefined, 32)[0] / ref - 1), `${phase}°`).toBeLessThan(1e-4);
    }
  });
  for (const [id, p] of Object.entries(photometry)) {
    if (!p.spatialModel?.value || ['602', '603', '604', '605'].includes(id)) continue;
    it(`${id} ${p.spatialModel.value.kind} (built parameters)`, () => {
      for (const phase of phases) {
        const a = phase * Math.PI / 180, resolved = resolveLaw(p.spatialModel!.value, a);
        if ('error' in resolved) continue; // e.g. a phase-dependent table's measured domain
        const law = resolved.law, ref = reference(law, a);
        expect(Math.abs(lawDiskIntegral(law, a, undefined, law.kind === LAW.hapke ? 24 : 32)[0] / ref - 1), `${phase}°`).toBeLessThan(1e-4);
      }
    }, 30000);
  }
  it.skipIf(!built)('has sourced built parameters (otherwise build light first)', () => {
    expect(Object.keys(photometry).length).toBeGreaterThan(0);
  });
  it('reference converges at Akimov 179.9° to 1e-6', () => {
    const law = { ...LAMBERT_LAW, kind: LAW.akimov }, a = 179.9 * Math.PI / 180;
    expect(Math.abs(reference(law, a, 160) / reference(law, a, 320) - 1)).toBeLessThan(1e-6);
  });
});
