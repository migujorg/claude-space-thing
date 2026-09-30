import { describe, expect, it } from 'vitest';
import { bodyToIcrf } from '../src/core/rotation';
import {
  bodyToIcrfFromConstants, damitBodyToIcrf, ECLIPTIC_TO_ICRF, iauFromSimple, radarBodyToIcrf, rotationAngleDeg,
  type PckConstants,
} from '../src/core/shapeRotation';
import type { Mat3 } from '../src/core/vec';
import { fixture } from './core-data';

interface Fx {
  epochs: string[];
  frames: { key: string; frame: string; sourceRotation: PckConstants; cases: { et: number; bodyToJ2000: number[] }[] }[];
  damit: {
    spkid: number; damitModelId: number; lambdaDeg: number; betaDeg: number; periodHours: number; jd0: number; phi0Deg: number;
    yorpRadPerDay2: number; poleRaDeg: number; poleDecDeg: number; w0Deg: number; wDotDegPerDay: number;
  }[];
}

const fx = fixture<Fx>('shape_orientation.json');
const pole = (m: Mat3): [number, number, number] => [m[2], m[5], m[8]];
const angle = (a: number[], b: number[]) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180 / Math.PI;

describe('shape-model frames from header constants vs SPICE pxform with the mission kernels', () => {
  it('reproduces each frame (incl. Phobos/Deimos nutation terms and Lutetia\'s derived constants)', () => {
    expect(fx.frames.map((f) => f.key).sort()).toEqual(['bennu', 'deimos', 'eros', 'lutetia', 'phobos', 'vesta']);
    for (const f of fx.frames) {
      for (const c of f.cases) {
        const m = bodyToIcrfFromConstants(f.sourceRotation, c.et);
        const err = rotationAngleDeg(m, c.bodyToJ2000 as Mat3);
        expect(err, `${f.frame} et ${c.et}`).toBeLessThan(1e-5);  // 1e-5° ≈ 2 mm on a 13 km body
      }
    }
  });
  it('drops the nutation terms at its peril: Phobos is ~1–2° off without them', () => {
    const f = fx.frames.find((x) => x.key === 'phobos')!;
    const bare = { POLE_RA: f.sourceRotation.POLE_RA, POLE_DEC: f.sourceRotation.POLE_DEC, PM: f.sourceRotation.PM };
    const err = rotationAngleDeg(bodyToIcrfFromConstants(bare, f.cases[2].et), f.cases[2].bodyToJ2000 as Mat3);
    expect(err).toBeGreaterThan(0.5);
  });
});

describe('DAMIT spin state (λ, β, P, t0, φ0, YORP) → ICRF', () => {
  it('matches DAMIT\'s own IAU-form conversion (IAUspin) of the same models', () => {
    expect(fx.damit.length).toBeGreaterThanOrEqual(8);
    // DAMIT's IAUspin of model 4923 (2482 Perkin, P = 771 h) has a pole 22° from its own (λ, β): an inconsistent
    // file in the export, not a convention. Every other model must agree.
    const inconsistent = new Set([4923]);
    const phaseChecked = new Set<number>();
    for (const d of fx.damit) {
      if (inconsistent.has(d.damitModelId)) continue;
      const iau = iauFromSimple(d);
      // near J2000 (IAUspin's W0 epoch): the rates' rounding (float32 Ẇ, DAMIT's period digits) stays small
      for (const days of [0, 3.3, 41.7]) {
        const et = days * 86400;
        // IAUspin is linear in time: DAMIT leaves the YORP term out of it, so compare the conventions without it
        const a = damitBodyToIcrf({ ...d, yorpRadPerDay2: 0 }, et);
        const b = bodyToIcrf(iau, et);
        expect(angle(pole(a), pole(b)), `pole ${d.damitModelId}`).toBeLessThan(1);
        // The rotation phase is comparable only where IAUspin's Ẇ is the model's 360°·24/P (e.g. model 6415's
        // differs by 0.004°/day, which its W0 at J2000 inherits over the decades back from t0).
        if (Math.abs(d.wDotDegPerDay - (360 * 24) / d.periodHours) < 1e-3) {
          expect(rotationAngleDeg(a, b), `model ${d.damitModelId} at J2000 + ${days} d`).toBeLessThan(2.5);
          phaseChecked.add(d.damitModelId);
        }
      }
    }
    expect(phaseChecked.size).toBeGreaterThanOrEqual(6);
  });
  it('adds the YORP phase ½·υ·(t − t0)²', () => {
    const d = fx.damit.find((x) => x.yorpRadPerDay2 > 0)!;
    const dt = 2451545 + 1000 - d.jd0;
    const a = damitBodyToIcrf(d, 1000 * 86400);
    const b = damitBodyToIcrf({ ...d, yorpRadPerDay2: 0 }, 1000 * 86400);
    const expected = (0.5 * d.yorpRadPerDay2 * dt * dt * 180) / Math.PI;
    expect(rotationAngleDeg(a, b)).toBeCloseTo(expected % 360 > 180 ? 360 - (expected % 360) : expected % 360, 6);
  });
  it('puts the pole at (λ, β) in ecliptic coordinates and rotates prograde about it', () => {
    const s = { lambdaDeg: 30, betaDeg: 60, periodHours: 6, jd0: 2451545, phi0Deg: 0, yorpRadPerDay2: 0 };
    const m = damitBodyToIcrf(s, 0);
    // pole in ecliptic coordinates = ECLIPTIC_TO_ICRFᵀ · pole
    const p = pole(m);
    const e = ECLIPTIC_TO_ICRF;
    const pe = [e[0] * p[0] + e[3] * p[1] + e[6] * p[2], e[1] * p[0] + e[4] * p[1] + e[7] * p[2], e[2] * p[0] + e[5] * p[1] + e[8] * p[2]];
    expect(Math.asin(pe[2]) * 180 / Math.PI).toBeCloseTo(60, 9);
    expect(Math.atan2(pe[1], pe[0]) * 180 / Math.PI).toBeCloseTo(30, 9);
    // a quarter period later the body's x axis has turned +90° about the pole
    const q = damitBodyToIcrf(s, 1.5 * 3600);
    const x0: [number, number, number] = [m[0], m[3], m[6]], x1: [number, number, number] = [q[0], q[3], q[6]];
    const cr = [x0[1] * x1[2] - x0[2] * x1[1], x0[2] * x1[0] - x0[0] * x1[2], x0[0] * x1[1] - x0[1] * x1[0]];
    expect(cr[0] * p[0] + cr[1] * p[1] + cr[2] * p[2]).toBeCloseTo(1, 9);
  });
});

describe('radar spin state → ICRF (SHAPE Euler convention, assumed)', () => {
  it('puts the pole at (λ, β) and advances the phase at 360°/P', () => {
    const s = { lambdaDeg: 200, betaDeg: -40, periodHours: 4, phi0Deg: 10, t0Et: 1e8 };
    const m = radarBodyToIcrf(s, 1e8);
    const p = pole(m);
    const e = ECLIPTIC_TO_ICRF;
    const pe = [e[0] * p[0] + e[3] * p[1] + e[6] * p[2], e[1] * p[0] + e[4] * p[1] + e[7] * p[2], e[2] * p[0] + e[5] * p[1] + e[8] * p[2]];
    expect(Math.asin(pe[2]) * 180 / Math.PI).toBeCloseTo(-40, 9);
    expect((Math.atan2(pe[1], pe[0]) * 180 / Math.PI + 360) % 360).toBeCloseTo(200, 9);
    expect(rotationAngleDeg(radarBodyToIcrf(s, 1e8 + 4 * 3600), m)).toBeLessThan(1e-6);
    expect(rotationAngleDeg(radarBodyToIcrf(s, 1e8 + 3600), m)).toBeCloseTo(90, 6);
  });
});
