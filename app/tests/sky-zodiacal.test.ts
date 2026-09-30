// Zodiacal light as the app renders it (render/sky/zodiacal.ts, the CPU twin of the GPU shader) against the
// measured Leinert et al. (1998) Table 16 carried in sky/zodiacal.json (at1AU): seen from the Earth's orbit.
// Skipped when the product is not built.

import { describe, expect, it } from 'vitest';
import type { ZodiacalLightModel } from '../src/data/schema';
import { losBrightness, parseZodiacal, S10_PER_SOLAR_FLUX_SR, zodiXYZS, type V3 } from '../src/render/sky/zodiacal';
import { DATA_DIR } from './core-data';

interface Fs { existsSync(p: string): boolean; readFileSync(p: string, enc: 'utf8'): string }
const fs: Fs = await import(/* @vite-ignore */ 'node:fs' as string);
const path = DATA_DIR + 'sky/zodiacal.json';
const built = fs.existsSync(path);
if (!built) console.warn(`sky-zodiacal: ${path} not built, skipping`);

/** Direction at helioecliptic (λ − λ☉, β) for an observer at heliocentric longitude lonE (Sun at lonE + 180°). */
function dirAt(dlamDeg: number, betaDeg: number, lonE: number): V3 {
  const lam = lonE + Math.PI + (dlamDeg * Math.PI) / 180;
  const b = (betaDeg * Math.PI) / 180;
  return [Math.cos(b) * Math.cos(lam), Math.cos(b) * Math.sin(lam), Math.sin(b)];
}

describe.skipIf(!built)('zodiacal light from 1 AU vs Leinert 1998 Table 16', () => {
  const z = built ? (JSON.parse(fs.readFileSync(path, 'utf8')) as ZodiacalLightModel) : null;
  const m = z ? parseZodiacal(z) : null;
  const table = z?.at1AU.value;

  /** Annual mean (12 Earth positions, ±β, ±Δλ, as the table is averaged) in S10sun. */
  const annual = (dl: number, b: number) => {
    let s = 0, n = 0;
    for (let k = 0; k < 12; k++) {
      const lonE = (2 * Math.PI * k) / 12;
      const obs: V3 = [Math.cos(lonE), Math.sin(lonE), 0];
      for (const sb of [1, -1]) for (const sl of [1, -1]) { s += losBrightness(m!, obs, dirAt(sl * dl, sb * b, lonE), lonE); n++; }
    }
    return s / n / S10_PER_SOLAR_FLUX_SR;
  };
  const cell = (dl: number, b: number) => table!.s10[table!.dlamDeg.indexOf(dl)][table!.betaDeg.indexOf(b)]!;

  it('matches the table within its errors at representative elongations', () => {
    const cells: [number, number][] = [[20, 0], [30, 0], [45, 0], [60, 0], [90, 0], [120, 0], [150, 0], [180, 0], [30, 30], [90, 30], [180, 30], [90, 60], [180, 45]];
    const logs: number[] = [];
    for (const [dl, b] of cells) {
      const mod = annual(dl, b);
      const obs = cell(dl, b);
      const r = mod / obs;
      logs.push(Math.log(r));
      // the pipeline fit reproduces the table to 12 % rms, max 28 % (docs/reports/sky.md §4.2)
      expect(Math.abs(Math.log(r)), `Δλ ${dl}°, β ${b}°: model ${mod.toFixed(1)} vs table ${obs} S10`).toBeLessThan(0.3);
    }
    const rms = Math.sqrt(logs.reduce((a, x) => a + x * x, 0) / logs.length);
    expect(rms).toBeLessThan(0.15);
  });

  it('gives the ecliptic pole near 60 S10 and falls off with heliocentric distance like Helios/Pioneer', () => {
    const pole = annual(0, 90);
    expect(pole).toBeGreaterThan(50);
    expect(pole).toBeLessThan(70);
    // ecliptic at 90° elongation from R (Leinert Eqs. 15, 17: R^-2.3 inside 1 AU, R^-2.5 to 3.3 AU)
    const at = (R: number) => losBrightness(m!, [R, 0, 0], [0, 1, 0], 0);
    const e1 = Math.log(at(0.5) / at(1)) / Math.log(0.5);
    const e2 = Math.log(at(3.3) / at(1)) / Math.log(3.3);
    expect(e1).toBeLessThan(-2.0);
    expect(e1).toBeGreaterThan(-2.6);
    expect(e2).toBeLessThan(-2.2);
    expect(e2).toBeGreaterThan(-3.0);
    // beyond the cloud's outer edge nothing is left
    expect(losBrightness(m!, [30, 0, 0], [0, 1, 0], 0)).toBe(0);
  });

  it('converts to about 23.3 mag/arcsec² at the pole (60 S10sun)', () => {
    const I = 60 * S10_PER_SOLAR_FLUX_SR;
    const Y = zodiXYZS(m!, I, Math.PI / 2)[1];
    // 1 S10 = 27.78 mag/arcsec² (Leinert Table 2) → 23.33; Y ≈ 5.5e-5 cd/m²
    expect(Y).toBeGreaterThan(5.0e-5);
    expect(Y).toBeLessThan(6.0e-5);
  });

  it('is converged in the quadrature (64+24 steps vs 4x more)', () => {
    const obs: V3 = [1, 0, 0];
    for (const [dl, b] of [[20, 0], [90, 0], [180, 0], [45, 45]] as [number, number][]) {
      const d = dirAt(dl, b, 0);
      const a = losBrightness(m!, obs, d, 0);
      const fine = losBrightness(m!, obs, d, 0, 96, 256);
      expect(Math.abs(a / fine - 1)).toBeLessThan(0.02);
    }
  });
});
