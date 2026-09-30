// CPU-side pieces of the GPU small-body field (gpu/smallbodies): double-single splitting, the perturber sample table
// and its interpolation exactly as the WGSL does it (float32 arithmetic emulated with Math.fround) against the
// float64 ephemeris, and the photometry packing. The GPU kernels themselves are tested on the device by
// scripts/sb-gpu.mjs (docs/reports/small-bodies.md).

import { describe, expect, it } from 'vitest';
import type { SmallBodyCoreHeader } from '../src/data/schema';
import { split64 } from '../src/gpu/smallbodies/wgslConst';
import { PlanetTable, SAMPLES } from '../src/gpu/smallbodies/planetTable';
import { fromHalf, toHalf } from '../src/core/smallbodyPhotometry';
import { DATA_DIR, loadEphemerisSet } from './core-data';

const fs: { existsSync(p: string): boolean; readFileSync(p: string, e: 'utf8'): string } = await import(/* @vite-ignore */ 'node:fs' as string);
const f = Math.fround;

describe('double-single literals', () => {
  it('hi + lo reproduces float64 values to 2^-48 relative', () => {
    for (const x of [1.32712440041279e11, 172800 * 0.1127016653792583, 4.2e9 + 0.123456789, -7.77e-3, 1 / 6]) {
      const [hi, lo] = split64(x);
      expect(f(hi)).toBe(hi);
      expect(f(lo)).toBe(lo);
      expect(Math.abs(hi + lo - x)).toBeLessThanOrEqual(Math.abs(x) * 2 ** -48);
    }
  });
  it('half floats as unpack2x16float reads them', () => {
    expect(toHalf(1)).toBe(0x3c00);
    expect(toHalf(-2)).toBe(0xc000);
    expect(fromHalf(toHalf(0.15))).toBeCloseTo(0.15, 3);
    expect(fromHalf(toHalf(65504))).toBe(65504);
  });
});

const eph = loadEphemerisSet();
const coreJson = DATA_DIR + 'smallbodies/core.json';
const header: SmallBodyCoreHeader | null = fs.existsSync(coreJson) ? JSON.parse(fs.readFileSync(coreJson, 'utf8')) : null;

describe.skipIf(!eph || !header)('perturber sample table and its interpolation (as in the kernels)', () => {
  it('interpolated heliocentric positions match the float64 ephemeris to < 0.02 km', () => {
    const m = header!.forceModel;
    const table = new PlanetTable(m, eph!, header!.epochEt, header!.window);
    const nb = m.perturbers.length;
    const worst = new Float64Array(nb);
    let seed = 3;
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    for (const k of [table.kmin, -1, 0, 123, table.kmax]) {
      const iv = table.index(k);
      if (!table.fill(iv)) continue;
      const base = iv * table.stride;
      const t0 = header!.epochEt + k * m.grid.baseStepS;
      for (let n = 0; n < 60; n++) {
        const u = f(rnd() * (SAMPLES - 1));
        const t = t0 + (u / (SAMPLES - 1)) * m.grid.baseStepS;
        // stencil (kernels.ts): j0 = clamp(floor(u) - 1, 0, NS - 4), Lagrange weights at x = u - j0.
        const j0 = Math.min(Math.max(Math.floor(u) - 1, 0), SAMPLES - 4);
        const x = f(u - j0);
        const a = f(x - 1), b = f(x - 2), c = f(x - 3);
        const w = [f(f(f(-a * b) * c) / 6), f(f(f(x * b) * c) / 2), f(f(f(-x * a) * c) / 2), f(f(f(x * a) * b) / 6)];
        const nn = Math.min(Math.max(Math.round(x), 0), 3);
        const sun = eph!.positionSSB(m.sun.naifId, t)!;
        for (let p = 0; p < nb; p++) {
          const truth = eph!.positionSSB(m.perturbers[p].naifId, t)!;
          const at = (i: number, comp: number, lo: boolean) => table.data[base + (p * SAMPLES + j0 + i) * 8 + (lo ? 4 : 0) + comp];
          let err2 = 0;
          for (let comp = 0; comp < 3; comp++) {
            const ph = at(nn, comp, false), pl = at(nn, comp, true);
            let dsum = 0;
            for (let i = 0; i < 4; i++) {
              if (i === nn) continue;
              const dp = f(f(at(i, comp, false) - ph) + f(at(i, comp, true) - pl));
              dsum = f(dsum + f(w[i] * dp));
            }
            const interp = ph + pl + dsum; // what the kernel adds to (hi - x) + (lo - x) terms
            const e = interp - (truth[comp] - sun[comp]);
            err2 += e * e;
          }
          worst[p] = Math.max(worst[p], Math.sqrt(err2));
        }
      }
    }
    console.log(`[gpu table] max interpolation error per perturber (km): ${m.perturbers.map((p, i) => `${p.name} ${worst[i].toExponential(2)}`).join(', ')}`);
    for (let p = 0; p < nb; p++) expect(worst[p]).toBeLessThan(0.02);
  });
});
