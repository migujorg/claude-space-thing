import { describe, expect, it } from 'vitest';
import { C_KM_S } from '../src/core/constants';
import { apparentPosition } from '../src/core/lighttime';
import type { Vec3 } from '../src/core/vec';
import { distance, norm } from '../src/core/vec';
import { MaxTracker, fixture, loadEphemerisSet } from './core-data';

interface HorizonsFile {
  bodies: { target: number; center: string; epochs: { jdTdb: number; et: number; pos: number[] }[] }[];
}

const set = loadEphemerisSet();

describe.skipIf(!set)('apparentPosition vs JPL Horizons astrometric (VEC_CORR=LT, from 500@399)', () => {
  it('matches light-time-corrected Earth-centered vectors within a few km', () => {
    const hz = fixture<HorizonsFile>('horizons_astrometric.json');
    const max = new MaxTracker();
    let n = 0;
    for (const b of hz.bodies) {
      expect(b.center).toBe('500@399');
      for (const e of b.epochs) {
        const obs = set!.positionSSB(399, e.et);
        expect(obs, `JD ${e.jdTdb} not covered: regenerate fixtures`).not.toBeNull();
        const ap = apparentPosition(set!, b.target, obs!, e.et)!;
        expect(ap).not.toBeNull();
        const h = e.pos as Vec3;
        const dp = distance(ap.rel, h);
        const dlt = Math.abs(ap.lightTime - norm(h) / C_KM_S);
        max.add(`${b.target} position km`, dp, `JD ${e.jdTdb}`);
        max.add(`${b.target} light time s`, dlt, `JD ${e.jdTdb}`);
        expect(dp, `${b.target} JD ${e.jdTdb}`).toBeLessThan(5);
        expect(ap.emitEt).toBe(e.et - ap.lightTime);
        expect(Math.abs(norm(ap.rel) / C_KM_S - ap.lightTime)).toBeLessThan(1e-8);
        n++;
      }
    }
    expect(n).toBeGreaterThanOrEqual(2 * 3);
    max.report(`apparentPosition vs Horizons astrometric (${n} cases):`);
  });

  it('light-time correction is not negligible: Jupiter moves ~tens of thousands of km during the delay', () => {
    const hz = fixture<HorizonsFile>('horizons_astrometric.json');
    const e = hz.bodies.find((b) => b.target === 599)!.epochs[0];
    const obs = set!.positionSSB(399, e.et)!;
    const geo = set!.positionSSB(599, e.et)!;
    const ap = apparentPosition(set!, 599, obs, e.et)!;
    const shift = distance([geo[0] - obs[0], geo[1] - obs[1], geo[2] - obs[2]], ap.rel);
    expect(shift).toBeGreaterThan(1e4);
  });
});

describe('apparentPosition (synthetic, exact solution)', () => {
  it('solves |p0 + v(t − τ)| = cτ for a target in uniform motion', () => {
    const p0: Vec3 = [3e8, -1e8, 5e7]; // km, target at t = 0
    const v: Vec3 = [30, -20, 10]; // km/s
    const eph = { positionSSB: (_id: number, t: number): Vec3 => [p0[0] + v[0] * t, p0[1] + v[1] * t, p0[2] + v[2] * t] };
    const ap = apparentPosition(eph, 1, [0, 0, 0], 0)!;
    // Exact: |p0 − vτ|² = c²τ² → (v·v − c²)τ² − 2(p0·v)τ + p0·p0 = 0, positive root.
    const a = v[0] ** 2 + v[1] ** 2 + v[2] ** 2 - C_KM_S ** 2;
    const bq = -2 * (p0[0] * v[0] + p0[1] * v[1] + p0[2] * v[2]);
    const cq = p0[0] ** 2 + p0[1] ** 2 + p0[2] ** 2;
    const tau = (-bq - Math.sqrt(bq * bq - 4 * a * cq)) / (2 * a);
    expect(Math.abs(ap.lightTime - tau)).toBeLessThan(1e-9);
    expect(ap.emitEt).toBe(-ap.lightTime);
  });

  it('returns null when the emission epoch is not covered', () => {
    const eph = { positionSSB: (_id: number, t: number): Vec3 | null => (t >= 0 ? [1e9, 0, 0] : null) };
    expect(apparentPosition(eph, 1, [0, 0, 0], 0)).toBeNull();
  });
});
