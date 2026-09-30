// Planetary rings (docs/rendering-m2.md §5): radial profiles resampled for the GPU, the photometric
// model as a float64 reference (mirrored in shaders.ts), and per-frame preparation.
//
// Physics: a classical many-particle-thick layer with single scattering (e.g. Cuzzi et al. 1984;
// Chandrasekhar 1960 for a plane-parallel layer), per channel:
//   lit face   I/F = (ϖ0·P(α)/4) · μ0/(μ + μ0) · [1 − exp(−τ(1/μ + 1/μ0))]
//   unlit face I/F = (ϖ0·P(α)/4) · μ0/(μ − μ0) · [exp(−τ/μ) − exp(−τ/μ0)]   (→ (ϖ0P/4)(τ/μ0)e^(−τ/μ0) at μ = μ0)
//   direct transmission of a ray crossing the plane: exp(−τ/|μ|)
// τ normal optical depth, ϖ0 particle single-scattering albedo, P particle phase function (∫P dΩ/4π = 1),
// μ, μ0 cosines of the viewing and illumination directions to the ring normal. Multiple scattering,
// self-gravity wakes (azimuth-dependent τ) and ringshine are not modelled.

import type { SceneBody, SceneRings } from './scene';
import type { Label } from '../data/schema';
import { AU_KM } from './constants';
import { dot, len, normalize, prepareBody, type M3, type V3 } from './raycast';
import type { XYZS } from './photometry';

/** Largest number of radial bins uploaded per ring system. */
export const MAX_RING_BINS = 16384;

export interface RingProfile {
  rMin: number;
  rMax: number;
  bins: number;
  /** Cumulative sums at the bins+1 bin edges, 8 floats each: Στ·known, Σknown_τ, Σknown_ϖ, 0, Σϖ0·known_ϖ (XYZS). */
  cumulative: Float32Array;
  albedoKnown: boolean;
}

const profileCache = new WeakMap<SceneRings, RingProfile>();

/** Resample a ring system's radial profile onto uniform bins and build cumulative sums (cached per object). */
export function ringProfile(r: SceneRings): RingProfile {
  const hit = profileCache.get(r);
  if (hit) return hit;
  const R = r.radiusKm;
  const n = R.length;
  const rMin = R[0], rMax = R[n - 1];
  const bins = Math.max(1, Math.min(MAX_RING_BINS, 2 * n));
  const cum = new Float64Array((bins + 1) * 8);
  let i = 0;
  const acc = new Float64Array(8);
  for (let b = 0; b < bins; b++) {
    const rc = rMin + ((b + 0.5) / bins) * (rMax - rMin);
    while (i < n - 2 && R[i + 1] < rc) i++;
    const t = R[i + 1] === R[i] ? 0 : Math.min(1, Math.max(0, (rc - R[i]) / (R[i + 1] - R[i])));
    const t0 = r.tau[i], t1 = r.tau[i + 1];
    if (t0 !== null && t1 !== null && Number.isFinite(t0) && Number.isFinite(t1)) {
      acc[0] += t0 + t * (t1 - t0);
      acc[1] += 1;
    }
    const a0 = r.albedoXYZS?.[i] ?? null, a1 = r.albedoXYZS?.[i + 1] ?? null;
    if (a0 && a1) {
      acc[2] += 1;
      for (let k = 0; k < 4; k++) acc[4 + k] += a0[k] + t * (a1[k] - a0[k]);
    }
    cum.set(acc, (b + 1) * 8);
  }
  const p: RingProfile = { rMin, rMax, bins, cumulative: new Float32Array(cum), albedoKnown: !!r.albedoXYZS && r.albedoXYZS.some((a) => a !== null) };
  profileCache.set(r, p);
  return p;
}

/** Mean τ, known fractions and mean ϖ0 over [ra, rb] (km), outside the ring counting as empty, known space. */
export function ringAverage(p: RingProfile, ra: number, rb: number): { tau: number; knownTau: number; knownAlb: number; albedo: XYZS } {
  const toX = (r: number) => ((r - p.rMin) / (p.rMax - p.rMin)) * p.bins;
  let x0 = toX(Math.min(ra, rb)), x1 = toX(Math.max(ra, rb));
  if (x1 - x0 < 1e-3) { x0 -= 5e-4; x1 += 5e-4; }
  const span = x1 - x0;
  const c = (x: number, k: number) => {
    const xc = Math.min(Math.max(x, 0), p.bins);
    const j = Math.min(Math.floor(xc), p.bins - 1);
    const f = xc - j;
    return p.cumulative[j * 8 + k] + f * (p.cumulative[(j + 1) * 8 + k] - p.cumulative[j * 8 + k]);
  };
  const inside = Math.min(Math.max(x1, 0), p.bins) - Math.min(Math.max(x0, 0), p.bins);
  const dk = (k: number) => c(x1, k) - c(x0, k);
  const nAlb = dk(2);
  return {
    tau: dk(0) / span,
    knownTau: (dk(1) + (span - inside)) / span,
    knownAlb: nAlb / span,
    albedo: [4, 5, 6, 7].map((k) => (nAlb > 0 ? dk(k) / nAlb : 0)) as XYZS,
  };
}

/** Radiance factor I/F of the ring layer (per unit ϖ0·P/4 factor applied by the caller). */
export function ringReflectance(tau: number, mu: number, mu0: number, litSide: boolean): number {
  if (!(tau > 0) || !(mu > 0) || !(mu0 > 0)) return 0;
  if (litSide) return (mu0 / (mu + mu0)) * (1 - Math.exp(-tau * (1 / mu + 1 / mu0)));
  if (Math.abs(mu - mu0) < 1e-6 * mu0) return (tau / mu0) * Math.exp(-tau / mu0);
  return (mu0 / (mu - mu0)) * (Math.exp(-tau / mu) - Math.exp(-tau / mu0));
}

/** Henyey–Greenstein particle phase function at phase angle α (scattering angle π − α), ∫P dΩ/4π = 1. */
export function hgPhase(alpha: number, g: number): number {
  return (1 - g * g) / Math.pow(1 + g * g + 2 * g * Math.cos(alpha), 1.5);
}

export interface RingPrep {
  bodyId: number;
  near: boolean;
  n: V3;
  D: number;
  e1: V3;
  e2: V3;
  beta: number;
  E1: V3;
  E2: V3;
  o: V3;
  normal: V3;
  profile: RingProfile;
  sunDir: V3;
  sunDistKm: number;
  /** Solar illuminance at the rings / π (radiance per unit I/F), XYZS. */
  esun: XYZS;
  /** 0 unknown (no reflected light), 1 Henyey–Greenstein (value = g), 2 constant P (value = P at α). */
  phaseKind: number;
  phaseValue: number;
  sunRadiusKm: number;
  /** Planet world → unit-sphere matrix (row-major), for the planet's shadow on the rings. */
  M: M3;
  label: Label;
  /** Centre, camera-relative km (float64), for bodies' ring shadows and transmission. */
  pos: V3;
}

/**
 * Per-frame preparation of a body's ring system, or null when it is not drawable (unknown geometry, or
 * smaller than a pixel: the rings' light is then missing from the point source, a documented limitation).
 */
export function prepareRings(b: SceneBody, sunIrradianceXYZS_1AU: XYZS | null, sunRadiusKm: number, pixelAngle: number): RingPrep | null {
  const r = b.rings;
  if (!r || !b.radii || r.radiusKm.length < 2) return null;
  const prof = ringProfile(r);
  const D = len(b.pos);
  if (!(D > 0) || (Math.asin(Math.min(1, prof.rMax / D)) / pixelAngle) < 1) return null;
  const frame = prepareBody(b.pos, [prof.rMax, prof.rMax, prof.rMax], null, 3 * pixelAngle);
  const planet = prepareBody(b.pos, b.radii, (b.orient as M3 | null) ?? null);
  const sunLen = len(b.toSun);
  const sunDir = normalize(b.toSun);
  const dAU = sunLen / AU_KM;
  const esun: XYZS = sunIrradianceXYZS_1AU ? (sunIrradianceXYZS_1AU.map((v) => v / (dAU * dAU) / Math.PI) as XYZS) : [0, 0, 0, 0];
  let phaseKind = 0, phaseValue = 0;
  const pp = r.particlePhase;
  if (pp && pp.kind === 'hg') { phaseKind = 1; phaseValue = pp.g; }
  else if (pp && pp.kind === 'tabulated' && pp.alphaDeg.length) {
    const alpha = (Math.acos(Math.max(-1, Math.min(1, -dot(sunDir, b.pos) / D))) * 180) / Math.PI;
    const a = pp.alphaDeg;
    if (alpha >= a[0] && alpha <= a[a.length - 1]) {
      let i = 0;
      while (i < a.length - 2 && a[i + 1] < alpha) i++;
      const t = a[i + 1] === a[i] ? 0 : (alpha - a[i]) / (a[i + 1] - a[i]);
      phaseKind = 2;
      phaseValue = pp.P[i] + t * (pp.P[i + 1] - pp.P[i]);
    }
  }
  return {
    bodyId: b.id, near: frame.near, n: frame.n, D, e1: frame.e1, e2: frame.e2, beta: frame.beta,
    // D·e1, D·e2 in km (the tangent-plane offsets of the FAR parametrisation, O(ring radius)).
    E1: [frame.e1[0] * D, frame.e1[1] * D, frame.e1[2] * D],
    E2: [frame.e2[0] * D, frame.e2[1] * D, frame.e2[2] * D],
    o: [-b.pos[0], -b.pos[1], -b.pos[2]],
    normal: normalize(r.normal), profile: prof, sunDir, sunDistKm: sunLen, esun,
    phaseKind, phaseValue, sunRadiusKm, M: planet.M, label: r.worstLabel, pos: b.pos,
  };
}
