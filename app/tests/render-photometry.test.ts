// Energy consistency between the resolved (disk) and point representations of a body
// (docs/architecture.md §4.3): numerically integrating the rendered radiance over the disk must
// reproduce the disk-integrated formula, for the Lambert law and for measured phase curves.
import { describe, expect, it } from 'vitest';
import { diskIlluminance, evalPhase, lambertPhase, lambertRadianceFactor, limbDarkenedI0, spatialScale, type XYZS } from '../src/render/photometry';
import { dot, farHit, nearHit, normalize, prepareBody, worldNormal, type V3 } from '../src/render/raycast';
import type { PhaseFunction } from '../src/data/schema';

const albedo: XYZS = [0.3 * 1.2e5, 0.3 * 1.3e5, 0.3 * 1.25e5, 0.3 * 3.0e5]; // test values only

/** Integrate L = K·max(cos i,0) over the body's disk as seen from the camera, by ray casting. */
function integrateDisk(R: number, delta: number, alpha: number, K: XYZS, n = 500, radii?: V3): number {
  const pos: V3 = [0, 0, -delta];
  const b = prepareBody(pos, radii ?? [R, R, R], null);
  // Sun direction at phase angle alpha from the observer direction (+z from the body).
  const sunDir: V3 = normalize([Math.sin(alpha), 0, Math.cos(alpha)]);
  let E = 0;
  const lim = b.beta;
  const h = (2 * lim) / n;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const x = -lim + (i + 0.5) * h;
    const y = -lim + (j + 0.5) * h;
    const hit = farHit(b, x, y);
    if (hit.disc < 0) continue;
    const N = worldNormal(b, hit.h);
    const cosI = Math.max(dot(N, sunDir), 0);
    const dOmega = (h * h) / Math.pow(1 + x * x + y * y, 1.5);
    E += K[1] * cosI * dOmega;
  }
  return E;
}

describe('Lambert disk integral reproduces §4.3', () => {
  for (const deg of [0, 30, 60, 90, 120, 150]) {
    it(`α = ${deg}°`, () => {
      const alpha = (deg * Math.PI) / 180;
      const R = 6000, delta = 6000 * 2000, dAU = 1;
      const K = lambertRadianceFactor(albedo, dAU, 1);
      const E = integrateDisk(R, delta, alpha, K);
      const want = diskIlluminance(albedo, dAU, R, delta, lambertPhase(alpha))[1];
      expect(E / want).toBeCloseTo(1, 2);
    });
  }
  it('α = 0 closed form: ∫μ dΩ = (2π/3)(R/Δ)² gives exactly p·(R/Δ)²', () => {
    const R = 1, delta = 1e4;
    const K = lambertRadianceFactor(albedo, 1, 1);
    expect(K[1] * ((2 * Math.PI) / 3) * (R / delta) ** 2).toBeCloseTo(albedo[1] * (R / delta) ** 2, 12);
  });
});

describe('measured phase curves: scaled Lambert radiance reproduces Φ_meas exactly', () => {
  const pf: PhaseFunction = { kind: 'poly-mag', coeffs: [0, 0.02, 1e-4], minDeg: 0, maxDeg: 160 };
  for (const deg of [10, 45, 100]) {
    it(`poly-mag at α = ${deg}°`, () => {
      const alpha = (deg * Math.PI) / 180;
      const ph = evalPhase(pf, alpha);
      expect(ph.ok).toBe(true);
      if (!ph.ok) return;
      const s = spatialScale(pf, ph.phi, alpha)!;
      const R = 3000, delta = 3000 * 3000;
      const E = integrateDisk(R, delta, alpha, lambertRadianceFactor(albedo, 5.2, s));
      const want = diskIlluminance(albedo, 5.2, R, delta, ph.phi)[1];
      expect(E / want).toBeCloseTo(1, 2);
    });
  }
  it('never extrapolates outside the validity range', () => {
    expect(evalPhase(pf, (170 * Math.PI) / 180).ok).toBe(false);
    const tab: PhaseFunction = { kind: 'tabulated', alphaDeg: [2, 10, 40], deltaMag: [0.05, 0.3, 1.1] };
    expect(evalPhase(tab, (1 * Math.PI) / 180).ok).toBe(false);
    const mid = evalPhase(tab, (25 * Math.PI) / 180);
    expect(mid.ok && Math.abs(mid.phi - Math.pow(10, -0.4 * 0.7)) < 1e-12).toBe(true);
  });
});

describe('precision-conditioned ray casting', () => {
  it('a 1000 km body at 50 AU is hit where geometry says (FAR path)', () => {
    const D = 50 * 149597870.7;
    const b = prepareBody([0, 0, -D], [1000, 1000, 1000], null);
    expect(b.near).toBe(false);
    const x = 0.5 * (1000 / D);
    const hit = farHit(b, x, 0);
    expect(hit.disc).toBeGreaterThan(0);
    // Unit-sphere hit at impact parameter 0.5: h = (0.5, 0, sqrt(0.75)) up to the tangent-plane convention.
    expect(Math.hypot(hit.h[0], hit.h[1], hit.h[2])).toBeCloseTo(1, 9);
    expect(hit.t).toBeCloseTo(D - 1000 * Math.sqrt(0.75), 3);
  });
  it('camera 1 m above a 6371 km sphere sees the horizon at the right dip angle (NEAR path)', () => {
    const R = 6371, hKm = 1e-3;
    const b = prepareBody([0, 0, -(R + hKm)], [R, R, R], null);
    expect(b.near).toBe(true);
    const dip = Math.acos(R / (R + hKm)); // horizon depression below the local horizontal
    // Local horizontal is ⟂ to the z axis; a ray dipping slightly more than `dip` hits, slightly less misses.
    const ray = (a: number): V3 => [Math.cos(a), 0, -Math.sin(a)];
    expect(nearHit(b, ray(dip * 1.02)).disc).toBeGreaterThan(0);
    expect(nearHit(b, ray(dip * 0.98)).disc).toBeLessThan(0);
    const straightDown = nearHit(b, [0, 0, -1]);
    expect(straightDown.t).toBeCloseTo(hKm, 9);
  });
  it('triaxial ellipsoid: the FAR hit lies on the ellipsoid surface', () => {
    const b = prepareBody([100, -50, -1e5], [3000, 2000, 1000], [0.36, 0.48, -0.8, -0.8, 0.6, 0, 0.48, 0.64, 0.6]);
    const hit = farHit(b, 0.001, 0.004);
    expect(hit.disc).toBeGreaterThan(0);
    expect(dot(hit.h, hit.h)).toBeCloseTo(1, 9);
  });
});

describe('limb-darkened solar disk normalisation', () => {
  it('∫ I dΩ over the disk equals the irradiance, for any limb-darkening polynomial', () => {
    const E = 1.3e5, R = 695700, D = 149597870.7;
    const coeffs = [0.3, 0.93, -0.23];
    const I0 = limbDarkenedI0(E, coeffs, R, D);
    // Independent check with the small-angle planar integral: ∫ P(μ) 2π b db (R/D)², μ = √(1−b²)
    let s = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) {
      const bb = (i + 0.5) / n;
      const mu = Math.sqrt(1 - bb * bb);
      s += (coeffs[0] + coeffs[1] * mu + coeffs[2] * mu * mu) * 2 * Math.PI * bb / n;
    }
    expect(I0 * s * (R / D) ** 2 / E).toBeCloseTo(1, 4);
  });
});
