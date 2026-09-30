// Pure two-body pieces of the small-body propagator (no data needed): Stumpff functions, the universal-variable
// Kepler drift for all conic types, elements -> state, and the step grid.

import { describe, expect, it } from 'vitest';
import { SB_OK, elementsToState, keplerDrift, nextBoundary, stumpff, timeSincePerihelion } from '../src/core/smallbody';

// GM of the Sun only sets the scale of these tests; any positive value exercises the same code.
const MU = 1.32712440041e11; // km^3/s^2 (order of the solar value; the product header supplies the real one)
const AU = 1.495978707e8; // km, scale only

function energy(s: ArrayLike<number>): number {
  const r = Math.hypot(s[0], s[1], s[2]);
  return 0.5 * (s[3] ** 2 + s[4] ** 2 + s[5] ** 2) - MU / r;
}
function angMom(s: ArrayLike<number>): [number, number, number] {
  return [s[1] * s[5] - s[2] * s[4], s[2] * s[3] - s[0] * s[5], s[0] * s[4] - s[1] * s[3]];
}
function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (1664525 * x + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

describe('Stumpff functions', () => {
  it('series and closed forms agree across |z| = 1', () => {
    for (const z of [1 - 1e-12, -1 + 1e-12]) {
      const [a2, a3] = stumpff(z);
      const x = Math.sqrt(Math.abs(z));
      const c2 = z > 0 ? (1 - Math.cos(x)) / z : (Math.cosh(x) - 1) / -z;
      const c3 = z > 0 ? (x - Math.sin(x)) / (x * z) : (Math.sinh(x) - x) / (x * -z);
      expect(Math.abs(a2 - c2)).toBeLessThan(1e-14);
      expect(Math.abs(a3 - c3)).toBeLessThan(1e-14);
    }
    const [c20, c30] = stumpff(0);
    expect(c20).toBe(0.5);
    expect(c30).toBeCloseTo(1 / 6, 16);
  });
});

describe('universal-variable Kepler drift', () => {
  const cases: { name: string; q: number; e: number }[] = [
    { name: 'circular-ish main belt', q: 2.7 * AU, e: 0.01 },
    { name: 'NEO e = 0.9', q: 0.14 * AU, e: 0.89 },
    { name: 'near-parabolic e = 0.99999', q: 0.5 * AU, e: 0.99999 },
    { name: 'parabolic', q: 1.0 * AU, e: 1.0 },
    { name: 'hyperbolic e = 6.1', q: 1.36 * AU, e: 6.14 },
  ];
  for (const c of cases) {
    it(`${c.name}: conserves energy and angular momentum, and reverses exactly`, () => {
      const rand = rng(7);
      const st = elementsToState({ q: c.q, e: c.e, i: 0.4, node: 1.1, peri: 2.2, dtPeri: -20 * 86400 }, MU, 0.409);
      expect(st).not.toBeNull();
      const s = Float64Array.from(st!);
      const e0 = energy(s);
      const h0 = angMom(s);
      const start = Float64Array.from(s);
      let total = 0;
      for (let k = 0; k < 400; k++) {
        const dt = (rand() - 0.3) * 4 * 86400;
        total += dt;
        expect(keplerDrift(s, 0, dt, MU)).toBe(SB_OK);
      }
      const h1 = angMom(s);
      // Energy relative to its kinetic/potential scale at perihelion (the total is ~0 for near-parabolic orbits).
      expect(Math.abs(energy(s) - e0) / (MU / c.q)).toBeLessThan(1e-12);
      expect(Math.hypot(h1[0] - h0[0], h1[1] - h0[1], h1[2] - h0[2]) / Math.hypot(...h0)).toBeLessThan(1e-12);
      // One drift by the accumulated time must land where the 400 small drifts did.
      const once = Float64Array.from(start);
      expect(keplerDrift(once, 0, total, MU)).toBe(SB_OK);
      const dr = Math.hypot(once[0] - s[0], once[1] - s[1], once[2] - s[2]);
      expect(dr).toBeLessThan(1e-9 * Math.hypot(s[0], s[1], s[2]));
      // And back.
      expect(keplerDrift(once, 0, -total, MU)).toBe(SB_OK);
      expect(Math.hypot(once[0] - start[0], once[1] - start[1], once[2] - start[2])).toBeLessThan(1e-9 * c.q * 10);
    });
  }

  it('an elliptic orbit returns to its start after one period', () => {
    const q = 1.5 * AU;
    const e = 0.3;
    const a = q / (1 - e);
    const period = 2 * Math.PI * Math.sqrt((a * a * a) / MU);
    const s = elementsToState({ q, e, i: 0.2, node: 0.3, peri: 0.4, dtPeri: 12345 }, MU, 0.409)!;
    const t = Float64Array.from(s);
    expect(keplerDrift(t, 0, period, MU)).toBe(SB_OK);
    expect(Math.hypot(t[0] - s[0], t[1] - s[1], t[2] - s[2])).toBeLessThan(1e-6 * a * 1e-3);
  });
});

describe('elementsToState', () => {
  it('matches the classical eccentric-anomaly solution for elliptic orbits', () => {
    const rand = rng(3);
    for (let k = 0; k < 200; k++) {
      const e = rand() * 0.95;
      const q = (0.3 + 5 * rand()) * AU;
      const i = rand() * Math.PI;
      const node = rand() * 2 * Math.PI;
      const peri = rand() * 2 * Math.PI;
      const M = (rand() * 2 - 1) * Math.PI;
      const dt = timeSincePerihelion(q, e, M, null, MU);
      const s = elementsToState({ q, e, i, node, peri, dtPeri: dt }, MU, 0)!;
      // classical: E from M, perifocal x = a(cosE - e), y = a sqrt(1-e^2) sinE
      let E = M;
      for (let j = 0; j < 50; j++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
      const a = q / (1 - e);
      const x = a * (Math.cos(E) - e);
      const y = a * Math.sqrt(1 - e * e) * Math.sin(E);
      const cO = Math.cos(node), sO = Math.sin(node), cw = Math.cos(peri), sw = Math.sin(peri), ci = Math.cos(i), si = Math.sin(i);
      const P = [cO * cw - sO * sw * ci, sO * cw + cO * sw * ci, sw * si];
      const Q = [-cO * sw - sO * cw * ci, -sO * sw + cO * cw * ci, cw * si];
      const r = [x * P[0] + y * Q[0], x * P[1] + y * Q[1], x * P[2] + y * Q[2]];
      expect(Math.hypot(s[0] - r[0], s[1] - r[1], s[2] - r[2])).toBeLessThan(1e-12 * a * 100);
    }
  });

  it('rotates the ecliptic into the ICRF about x by the obliquity', () => {
    const eps = 0.40909280422232897;
    const ecl = elementsToState({ q: AU, e: 0.1, i: 0.3, node: 0.2, peri: 0.1, dtPeri: 1e6 }, MU, 0)!;
    const eq = elementsToState({ q: AU, e: 0.1, i: 0.3, node: 0.2, peri: 0.1, dtPeri: 1e6 }, MU, eps)!;
    expect(eq[0]).toBe(ecl[0]);
    expect(eq[1]).toBeCloseTo(Math.cos(eps) * ecl[1] - Math.sin(eps) * ecl[2], 3);
    expect(eq[2]).toBeCloseTo(Math.sin(eps) * ecl[1] + Math.cos(eps) * ecl[2], 3);
  });
});

describe('step grid', () => {
  const H = 172800;
  it('ends steps on grid points, with partial first and last steps', () => {
    expect(nextBoundary(0, 10 * H, 0, H)).toBe(H);
    expect(nextBoundary(0.5 * H, 10 * H, 0, H)).toBe(H);
    expect(nextBoundary(9.5 * H, 10.2 * H, 0, H)).toBe(10 * H);
    expect(nextBoundary(10 * H, 10.2 * H, 0, H)).toBe(10.2 * H);
    expect(nextBoundary(0, -3 * H, 0, H)).toBe(-H);
    expect(nextBoundary(-0.5 * H, -3 * H, 0, H)).toBe(-H);
    expect(nextBoundary(-2.5 * H, -2.7 * H, 0, H)).toBe(-2.7 * H);
  });
});
