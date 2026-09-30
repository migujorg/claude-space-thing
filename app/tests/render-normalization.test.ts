// A surface map and a spatial law never change a body's disk-integrated brightness: with the
// renderer's normalization K = albedo/(πd²)·Φ(α)/I(α; M̄), the flux from the rendered disk equals the
// measured albedoXYZS·(1/d²)(R/Δ)²·Φ(α) — exactly for maps without longitude structure, and on average
// over the body's rotation for any map (architecture §4.3/§4.4). Checked by brute-force integration
// over the sphere, independent of the Gauss–Legendre scheme used by the renderer.
import { describe, expect, it } from 'vitest';
import { LAMBERT_LAW, lawDiskIntegral, lawRadf, resolveLaw, type ResolvedLaw, type ZonalProfile } from '../src/render/spatial';
import type { V3 } from '../src/render/raycast';

const deg = (d: number) => (d * Math.PI) / 180;
const norm = (v: V3): V3 => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** A made-up map with latitude bands and longitude structure, per channel (TEST ONLY). */
function mapM(lat: number, lon: number, k: number, lonStructure: boolean): number {
  const band = 1 + 0.4 * Math.sin(3 * lat + k) + 0.2 * Math.cos(5 * lat);
  const spots = lonStructure ? 0.5 * Math.cos(2 * lon + k) * Math.cos(lat) + 0.3 * Math.sin(5 * lon) * Math.sin(2 * lat) : 0;
  return Math.max(0.05, band + spots);
}

function zonalOf(lonStructure: boolean, rows = 256): ZonalProfile {
  const mean = new Float64Array(rows * 4);
  for (let j = 0; j < rows; j++) {
    const lat = Math.PI / 2 - (Math.PI * (j + 0.5)) / rows;
    for (let k = 0; k < 4; k++) {
      let s = 0;
      for (let i = 0; i < 512; i++) s += mapM(lat, -Math.PI + (2 * Math.PI * (i + 0.5)) / 512, k, lonStructure);
      mean[4 * j + k] = s / 512;
    }
  }
  return { rows, mean };
}

/**
 * (1/π) ∫ r(μ0, μ, α)·M(lat, lon − ω)·μ dA over the visible lit sphere (unit radius), brute force on a
 * lat/lon grid, for rotation phase ω. Photometric frame: z to the observer, Sun at (sin α, 0, cos α).
 */
function bruteForce(law: ResolvedLaw, alpha: number, pole: V3, omega: number, lonStructure: boolean, k: number, n = 360): number {
  const P = norm(pole);
  const A = norm(cross(P, Math.abs(P[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
  const B = cross(P, A);
  const s: V3 = [Math.sin(alpha), 0, Math.cos(alpha)];
  let acc = 0;
  for (let j = 0; j < n; j++) {
    const lat = -Math.PI / 2 + (Math.PI * (j + 0.5)) / n;
    const dA = Math.cos(lat) * (Math.PI / n) * (2 * Math.PI / (2 * n));
    for (let i = 0; i < 2 * n; i++) {
      const lon = -Math.PI + (2 * Math.PI * (i + 0.5)) / (2 * n);
      const cl = Math.cos(lat) * Math.cos(lon + omega), sl = Math.cos(lat) * Math.sin(lon + omega), z = Math.sin(lat);
      const nv: V3 = [cl * A[0] + sl * B[0] + z * P[0], cl * A[1] + sl * B[1] + z * P[1], cl * A[2] + sl * B[2] + z * P[2]];
      const mu = nv[2];
      const mu0 = nv[0] * s[0] + nv[2] * s[2];
      if (mu <= 0 || mu0 <= 0) continue;
      acc += lawRadf(law, mu0, mu, alpha) * mapM(lat, lon, k, lonStructure) * mu * dA;
    }
  }
  return acc / Math.PI;
}

const hapke = (() => {
  const r = resolveLaw({ kind: 'hapke', w: 0.25, b: 0.25, c: 0.4, bs0: 1.8, hs: 0.07, thetaBarDeg: 23.657 }, deg(50));
  if ('error' in r) throw new Error(r.error);
  return r.law;
})();

describe('disk integral with a surface map equals p·Φ(α)', () => {
  const pole: V3 = norm([0.35, 0.8, 0.45]);
  it('a map without longitude structure: exact at any rotation (Lambert and Hapke)', () => {
    const z = zonalOf(false);
    for (const [law, alpha] of [[LAMBERT_LAW, deg(40)], [hapke, deg(50)]] as [ResolvedLaw, number][]) {
      const I = lawDiskIntegral(law, alpha, { profile: z, pole });
      for (const k of [0, 2]) {
        const brute = bruteForce(law, alpha, pole, 0.7, false, k);
        // The rendered flux is K·brute·πR²/Δ² with K ∝ Φ/I: it reproduces p·Φ when brute/I = 1.
        expect(brute / I[k]).toBeCloseTo(1, 2);
      }
    }
  });
  it('any map: exact on average over the rotation, with a real rotational light curve', () => {
    const z = zonalOf(true);
    const alpha = deg(50);
    const I = lawDiskIntegral(hapke, alpha, { profile: z, pole });
    const phases = 24;
    const vals: number[] = [];
    for (let q = 0; q < phases; q++) vals.push(bruteForce(hapke, alpha, pole, (2 * Math.PI * q) / phases, true, 1, 180));
    const mean = vals.reduce((a, b) => a + b, 0) / phases;
    expect(mean / I[1]).toBeCloseTo(1, 2);
    // The map's longitude structure makes the brightness vary with rotation (it is not normalized away).
    expect(Math.max(...vals) / Math.min(...vals)).toBeGreaterThan(1.02);
  });
});
