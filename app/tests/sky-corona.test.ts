// The solar corona as the app renders it (render/sky/corona.ts, the CPU twin of the GPU shader) against the published
// numbers the pipeline transcribed: van de Hulst (1950) K-corona laws and totals, the LASCO F-corona map (Lamy et al.
// 2022). Skipped when sky/corona.json is not built.

import { describe, expect, it } from 'vitest';
import type { CoronaModel } from '../src/data/schema';
import { coronaXYZS, cyclePhase, fLaw, fNear, kBrightness, parseCorona, poleFromRaDec, type CoronaParams } from '../src/render/sky/corona';
import type { V3 } from '../src/render/sky/zodiacal';
import { DATA_DIR } from './core-data';

interface Fs { existsSync(p: string): boolean; readFileSync(p: string, enc: 'utf8'): string }
const fs: Fs = await import(/* @vite-ignore */ 'node:fs' as string);
const nodeUrl: { fileURLToPath(u: URL): string } = await import(/* @vite-ignore */ 'node:url' as string);
const path = DATA_DIR + 'sky/corona.json';
const built = fs.existsSync(path);
if (!built) console.warn(`sky-corona: ${path} not built, skipping`);
const tables = nodeUrl.fileURLToPath(new URL('../../pipeline/src/pipeline/sky_tables/', import.meta.url));
const table = <T>(name: string): T => JSON.parse(fs.readFileSync(tables + name, 'utf8')) as T;

type Law = { coeffs: Record<string, number> };
const vdh = table<{ unit_B_sun: number; laws: Record<string, Law>; table1: Record<string, number[]>; total_brightness_observed: Record<string, number> }>('vandehulst_1950.json');
const law = (name: string, r: number) => Object.entries(vdh.laws[name].coeffs).reduce((a, [n, c]) => a + c * r ** -Number(n), 0) * vdh.unit_B_sun;

const POLE = poleFromRaDec(286.13, 63.87);   // bodies.json, Sun (pck00011)
const AU_RSUN = 149597870.7 / 695700;

const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const n = Math.hypot(...a); return [a[0] / n, a[1] / n, a[2] / n]; };

/**
 * Observer at distance D (R_sun) in the solar equatorial plane, looking at the point at apparent distance rho and
 * position angle pa (degrees from solar north) on the plane of the sky: [observer, unit ray].
 */
function geometry(D: number, rho: number, paDeg: number): [V3, V3] {
  const e1 = norm(cross(POLE, [1, 0, 0]));          // in the equatorial plane
  const e2 = cross(POLE, e1);                         // in the equatorial plane, ⟂ e1
  const o: V3 = [e1[0] * D, e1[1] * D, e1[2] * D];
  const pa = (paDeg * Math.PI) / 180;
  const target: V3 = [0, 1, 2].map((k) => rho * (Math.sin(pa) * e2[k] + Math.cos(pa) * POLE[k])) as V3;
  return [o, norm([target[0] - o[0], target[1] - o[1], target[2] - o[2]])];
}

describe.skipIf(!built)('solar corona (sky/corona.json) against the published photometry', () => {
  const m = built ? (JSON.parse(fs.readFileSync(path, 'utf8')) as CoronaModel) : null;
  const p = m ? parseCorona(m, POLE) : (null as unknown as CoronaParams);
  const D = 1e5;   // a distant observer, as van de Hulst's laws assume

  it('reproduces van de Hulst’s equatorial laws at minimum and maximum (1.01–6 R_sun) and the polar law near the limb', () => {
    for (const rho of [1.02, 1.1, 1.3, 1.6, 2, 3, 4.5, 6]) {
      const [o, d] = geometry(D, rho, 90);
      expect(kBrightness(p, o, d, 0) / law('K_min', rho)).toBeGreaterThan(0.96);
      expect(kBrightness(p, o, d, 0) / law('K_min', rho)).toBeLessThan(1.04);
      expect(kBrightness(p, o, d, 1) / law('K_max', rho)).toBeCloseTo(kBrightness(p, o, d, 0) / law('K_min', rho), 2);
    }
    for (const rho of [1.02, 1.1, 1.3]) {
      const [o, d] = geometry(D, rho, 0);
      const r = kBrightness(p, o, d, 0) / law('K_pole', rho);
      expect(r).toBeGreaterThan(0.75);
      expect(r).toBeLessThan(1.25);
    }
  });

  it('K brightness at a given impact parameter hardly depends on the observer’s distance (0.3 AU … far)', () => {
    for (const rho of [1.2, 3, 8]) {
      const [o1, d1] = geometry(D, rho, 60);
      const [o2, d2] = geometry(0.3 * AU_RSUN, rho, 60);
      expect(kBrightness(p, o2, d2, 0.5) / kBrightness(p, o1, d1, 0.5)).toBeCloseTo(1, 1);
    }
    // inside the corona, looking away from the Sun: some light, but far less than towards it
    const o: V3 = [0, 1, 2].map((k) => 5 * norm(cross(POLE, [1, 0, 0]))[k]) as V3;
    const out = kBrightness(p, o, norm(o), 0.5);
    const inward = kBrightness(p, o, norm([-o[0] + POLE[0] * 2, -o[1] + POLE[1] * 2, -o[2] + POLE[2] * 2]), 0.5);
    expect(out).toBeGreaterThan(0);
    expect(out).toBeLessThan(inward);
  });

  /** Total (1/π) ∫∫ B ρ dρ dPA over rho1..rho2 in units of the Sun's total brightness (van de Hulst Table I). */
  const ringTotal = (rho1: number, rho2: number, P: number, withF = false) => {
    let tot = 0;
    const nR = 120, nA = 24;
    for (let i = 0; i < nR; i++) {
      const a = Math.log(rho1 - 0.999), b = Math.log(rho2 - 0.999);
      const t0 = a + ((b - a) * i) / nR, t1 = a + ((b - a) * (i + 1)) / nR;
      const r0 = Math.exp(t0) + 0.999, r1 = Math.exp(t1) + 0.999, rm = Math.exp(0.5 * (t0 + t1)) + 0.999;
      let mean = 0;
      for (let j = 0; j < nA; j++) {
        const [o, d] = geometry(D, rm, ((j + 0.5) * 90) / nA);
        mean += kBrightness(p, o, d, P) / nA;
        if (withF) mean += fNear(p, o, d)[0] / nA;
      }
      tot += 2 * mean * rm * (r1 - r0);
    }
    return tot;
  };

  it('gives van de Hulst’s total K brightness at minimum and maximum (Table I, 1.03–6 R_sun)', () => {
    expect(ringTotal(1.03, 6, 0) * 1e6).toBeCloseTo(vdh.table1.K_min_weighted[1], 1);
    expect(ringTotal(1.03, 6, 1) * 1e6).toBeCloseTo(vdh.table1.K_max[1], 1);
  });

  it('on 2027-08-02 the corona outside the Moon is a fraction of a full moon, between the minimum and maximum totals', () => {
    const et = (Date.UTC(2027, 7, 2, 10, 7, 50) - Date.UTC(2000, 0, 1, 12, 0, 0)) / 1000;
    const P = cyclePhase(p, et);
    expect(P).toBeGreaterThan(0.4);
    expect(P).toBeLessThan(0.7);
    const total = ringTotal(1.079, 6, P, true);   // the Moon's apparent radius at greatest eclipse: 1.079 R_sun
    const fullMoon = vdh.total_brightness_observed.visual_min_millionths_of_sun / vdh.total_brightness_observed.visual_min_full_moons * 1e-6;
    console.log(`corona 2027-08-02: phase ${P.toFixed(3)}, K+F 1.079–6 R_sun = ${(total * 1e6).toFixed(3)}e-6 of the Sun = ${(total / fullMoon).toFixed(2)} full moon`);
    expect(total / fullMoon).toBeGreaterThan(0.15);
    expect(total / fullMoon).toBeLessThan(0.72);
    const all = ringTotal(1.0, 6, P, true);
    expect(all * 1e6).toBeGreaterThan(vdh.table1.K_min_weighted_plus_F[1]);
    expect(all * 1e6).toBeLessThan(vdh.table1.K_max_plus_F[1] + vdh.table1.K_max[0]);
  });

  it('the F law reproduces the LASCO reference map (rows read as β) and hands over to the zodiacal model at 15°', () => {
    const t = table<{ unit_B_sun: number; [k: string]: unknown }>('lamy_2022_table5.json');
    let worst = 0;
    for (const blk of ['inner', 'outer'] as const) {
      const b = t[blk] as { row_deg: number[]; col_deg: number[]; values: (number | null)[][] };
      b.row_deg.forEach((beta, i) => b.col_deg.forEach((lam, j) => {
        const v = b.values[i][j];
        if (v === null) return;
        const be = (beta * Math.PI) / 180, la = (lam * Math.PI) / 180;
        const dir = [Math.cos(be) * Math.cos(la), Math.cos(be) * Math.sin(la), Math.sin(be)];
        const rho = AU_RSUN * Math.sin(Math.acos(dir[0]));
        const sinPsi = dir[2] / Math.hypot(dir[1], dir[2]);
        worst = Math.max(worst, Math.abs(Math.log(fLaw(p, rho, sinPsi) / (v * t.unit_B_sun))));
      }));
    }
    expect(Math.exp(worst)).toBeLessThan(1.13);
    // weight: the law alone within 7.5°, the zodiacal model alone beyond 15°, continuous between
    const o: V3 = [AU_RSUN, 0, 0];
    const ray = (epsDeg: number): V3 => { const e = (epsDeg * Math.PI) / 180; return [-Math.cos(e), Math.sin(e), 0]; };
    expect(fNear(p, o, ray(5))[1]).toBe(1);
    expect(fNear(p, o, ray(16))[1]).toBe(0);
    let prev = 1;
    for (let e = 7; e <= 15.5; e += 0.25) { const w = fNear(p, o, ray(e))[1]; expect(w).toBeLessThanOrEqual(prev + 1e-12); prev = w; }
    // looking away from the Sun, or from inside 15 deg of the Sun at 1 AU scale: the zodiacal model alone
    expect(fNear(p, o, [1, 0, 0])[1]).toBe(0);
    expect(fNear(p, [20, 0, 0], ray(5))[1]).toBe(0);
  });

  it('K is coloured like the photosphere, F slightly redder, and the Sun shield’s disc is not part of the model', () => {
    const k = coronaXYZS(p, 1e-6, 0), f = coronaXYZS(p, 0, 1e-6);
    expect(k[1]).toBeCloseTo(1e-6 * p.bSun[1], 6);
    expect(f[2] / f[1]).toBeLessThan(k[2] / k[1]);   // less Z (blue) relative to Y
    const [o, d] = geometry(D, 0.9, 30);
    expect(kBrightness(p, o, d, 0.5)).toBe(0);        // the ray meets the Sun
  });
});
