// Spatially resolved photometric models and their disk integrals (docs/rendering-m2.md §3).
//
// A spatial model only says how light is distributed across a body's disk. Its absolute scale is set
// so that the disk-integrated brightness equals the measured one (architecture §4.3/§4.4):
//
//   L(point) = albedoXYZS/(π d²) · Φ(α)/I(α) · r(μ0, μ, g) · M(point)
//   I(α)     = (1/πR²) ∫_disk r(μ0, μ, α) · M̄(lat) dA_proj        (per channel)
//
// r is the model's radiance factor (I/F), M the surface map's relative reflectance and M̄ its zonal
// (rotation-averaged) mean. Then ∫ L dΩ at a distant observer, averaged over the body's rotation, is
// exactly albedoXYZS·(1/d²)(R/Δ)²·Φ(α) for any model and any map. For a map without longitude
// structure it holds at every instant. This file is the float64 reference; shaders.ts mirrors lawRadf.

import type { PhaseDependent, SpatialPhotometricModel } from '../data/schema';
import type { V3 } from './raycast';

export type XYZS = [number, number, number, number];

/** Numeric codes shared with the WGSL body shader. */
export const LAW = { lambert: 0, lommelSeeliger: 1, lunarLambert: 2, minnaert: 3, hapke: 4 } as const;

/** A spatial model with its phase-dependent parameters evaluated at one phase angle. */
export interface ResolvedLaw {
  kind: number;
  /** lunar-lambert L, minnaert k, or hapke w. */
  p: number;
  b: number;
  c: number;
  bs0: number;
  hs: number;
  bc0: number;
  hc: number;
  thetaBar: number; // radians
  K: number;
  /** 0: Hapke (2002) H function, 1: Hapke (1981). */
  hFn: number;
}

export const LAMBERT_LAW: ResolvedLaw = { kind: LAW.lambert, p: 0, b: 0, c: 0, bs0: 0, hs: 1, bc0: 0, hc: 1, thetaBar: 0, K: 1, hFn: 0 };

function evalPhaseDependent(v: PhaseDependent, deg: number): number | null {
  if (typeof v === 'number') return v;
  const a = v.alphaDeg;
  const n = a.length;
  if (n === 0 || deg < a[0] || deg > a[n - 1]) return null;
  let i = 0;
  while (i < n - 2 && a[i + 1] < deg) i++;
  const t = a[i + 1] === a[i] ? 0 : (deg - a[i]) / (a[i + 1] - a[i]);
  return v.values[i] + t * (v.values[i + 1] - v.values[i]);
}

/**
 * Evaluate a model's parameters at phase angle α (radians). Returns an error string when the model
 * does not cover α (outside `validPhaseDeg` or a parameter table): the caller falls back to Lambert.
 */
export function resolveLaw(m: SpatialPhotometricModel | null | undefined, alpha: number): { law: ResolvedLaw } | { error: string } {
  if (!m) return { law: LAMBERT_LAW };
  const deg = (alpha * 180) / Math.PI;
  if (m.validPhaseDeg && (deg < m.validPhaseDeg[0] || deg > m.validPhaseDeg[1])) {
    return { error: `${m.kind} model fitted for phase ${m.validPhaseDeg[0]}–${m.validPhaseDeg[1]}°, now ${deg.toFixed(1)}°` };
  }
  switch (m.kind) {
    case 'lambert':
      return { law: LAMBERT_LAW };
    case 'lommel-seeliger':
      return { law: { ...LAMBERT_LAW, kind: LAW.lommelSeeliger } };
    case 'lunar-lambert': {
      const L = evalPhaseDependent(m.L, deg);
      return L === null ? { error: `lunar-lambert L not tabulated at ${deg.toFixed(1)}°` } : { law: { ...LAMBERT_LAW, kind: LAW.lunarLambert, p: L } };
    }
    case 'minnaert': {
      const k = evalPhaseDependent(m.k, deg);
      return k === null ? { error: `Minnaert k not tabulated at ${deg.toFixed(1)}°` } : { law: { ...LAMBERT_LAW, kind: LAW.minnaert, p: k } };
    }
    case 'hapke':
      return {
        law: {
          kind: LAW.hapke, p: m.w, b: m.b, c: m.c, bs0: m.bs0, hs: m.hs, bc0: m.bc0 ?? 0, hc: m.hc ?? 1,
          thetaBar: (m.thetaBarDeg * Math.PI) / 180, K: m.K ?? 1, hFn: m.hFunction === 'hapke1981' ? 1 : 0,
        },
      };
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Hapke (2012), Theory of Reflectance and Emittance Spectroscopy, 2nd ed., CUP, ch. 9–12;
// roughness: Hapke (1984), Icarus 59, 41; H function: Hapke (2002), Icarus 157, 523 (and Hapke (1981),
// JGR 86, 3039, for fits made with the older approximation, e.g. the USGS ISIS "Hapke" models).
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Hapke (2002) Eq. 13 approximation of Chandrasekhar's H function for isotropic scatterers (< 1 % error). */
export function hFunction2002(x: number, w: number): number {
  const gamma = Math.sqrt(Math.max(1 - w, 0));
  const r0 = (1 - gamma) / (1 + gamma);
  const xs = Math.max(x, 1e-12);
  return 1 / (1 - w * xs * (r0 + ((1 - 2 * r0 * xs) / 2) * Math.log((1 + xs) / xs)));
}

/** Hapke (1981) approximation H(x) = (1 + 2x)/(1 + 2γx). */
export function hFunction1981(x: number, w: number): number {
  const gamma = Math.sqrt(Math.max(1 - w, 0));
  return (1 + 2 * x) / (1 + 2 * x * gamma);
}

/** Double Henyey–Greenstein particle phase function (Hapke 2012 form; c > 0 favours back-scattering). */
export function doubleHG(g: number, b: number, c: number): number {
  const cg = Math.cos(g);
  const b2 = b * b;
  return ((1 + c) / 2) * (1 - b2) / Math.pow(1 - 2 * b * cg + b2, 1.5) + ((1 - c) / 2) * (1 - b2) / Math.pow(1 + 2 * b * cg + b2, 1.5);
}

/** Hapke (1984) macroscopic roughness: effective cosines μ0e, μe and shadowing function S. Angles in radians. */
export function hapkeRoughness(i: number, e: number, psi: number, thetaBar: number): { mu0e: number; mue: number; S: number } {
  const mu0 = Math.cos(i), mu = Math.cos(e);
  if (thetaBar <= 0) return { mu0e: mu0, mue: mu, S: 1 };
  const tb = Math.tan(thetaBar);
  const chi = 1 / Math.sqrt(1 + Math.PI * tb * tb);
  const cotT = 1 / tb;
  const cot = (x: number) => Math.cos(x) / Math.max(Math.sin(x), 1e-12);
  const E1 = (x: number) => Math.exp(Math.max(-(2 / Math.PI) * cotT * cot(x), -700));
  const E2 = (x: number) => Math.exp(Math.max(-(1 / Math.PI) * cotT * cotT * cot(x) * cot(x), -700));
  const eta = (x: number) => chi * (Math.cos(x) + Math.sin(x) * tb * E2(x) / (2 - E1(x)));
  const s2 = Math.sin(psi / 2) ** 2;
  const f = psi >= Math.PI ? 0 : Math.exp(-2 * Math.tan(psi / 2));
  if (i <= e) {
    const d = 2 - E1(e) - (psi / Math.PI) * E1(i);
    const mu0e = chi * (Math.cos(i) + Math.sin(i) * tb * (Math.cos(psi) * E2(e) + s2 * E2(i)) / d);
    const mue = chi * (Math.cos(e) + Math.sin(e) * tb * (E2(e) - s2 * E2(i)) / d);
    const S = (mue / eta(e)) * (mu0 / eta(i)) * chi / (1 - f + f * chi * (mu0 / eta(i)));
    return { mu0e, mue, S };
  }
  const d = 2 - E1(i) - (psi / Math.PI) * E1(e);
  const mu0e = chi * (Math.cos(i) + Math.sin(i) * tb * (E2(i) - s2 * E2(e)) / d);
  const mue = chi * (Math.cos(e) + Math.sin(e) * tb * (Math.cos(psi) * E2(i) + s2 * E2(e)) / d);
  const S = (mue / eta(e)) * (mu0 / eta(i)) * chi / (1 - f + f * chi * (mu / eta(e)));
  return { mu0e, mue, S };
}

/**
 * Hapke radiance factor RADF = I/F = π·r(i, e, g):
 *   r = K·w/(4π)·μ0e/(μ0e + μe)·[p(g)(1 + B_S0·B_S(g)) + H(μ0e/K)H(μe/K) − 1]·[1 + B_C0·B_C(g)]·S(i, e, ψ)
 * B_S = 1/(1 + tan(g/2)/h_S); B_C = [1 + (1 − e^−x)/x]/[2(1 + x)²], x = tan(g/2)/h_C.
 */
export function hapkeRadf(i: number, e: number, g: number, law: ResolvedLaw): number {
  if (i >= Math.PI / 2 || e >= Math.PI / 2) return 0;
  const si = Math.sin(i), se = Math.sin(e);
  const den = si * se;
  const cpsi = den > 1e-12 ? (Math.cos(g) - Math.cos(i) * Math.cos(e)) / den : 1;
  const psi = Math.acos(Math.min(1, Math.max(-1, cpsi)));
  const { mu0e, mue, S } = hapkeRoughness(i, e, psi, law.thetaBar);
  const w = law.p;
  const tg = Math.tan(g / 2);
  const Bs = law.hs > 0 ? 1 / (1 + tg / law.hs) : 0;
  const x = law.hc > 0 ? tg / law.hc : Infinity;
  const Bc = x > 1e-9 ? (1 + (1 - Math.exp(-x)) / x) / (2 * (1 + x) ** 2) : 1;
  const H = law.hFn === 1 ? hFunction1981 : hFunction2002;
  const M = H(mu0e / law.K, w) * H(mue / law.K, w) - 1;
  const r = ((law.K * w) / (4 * Math.PI)) * (mu0e / (mu0e + mue)) * (doubleHG(g, law.b, law.c) * (1 + law.bs0 * Bs) + M) * (1 + law.bc0 * Bc) * S;
  return Math.PI * r;
}

/**
 * Radiance factor (up to a constant) of a resolved law at cosines μ0, μ and phase angle g (radians).
 * Zero where unlit or not visible.
 */
export function lawRadf(law: ResolvedLaw, mu0: number, mu: number, g: number): number {
  if (!(mu0 > 0) || !(mu > 0)) return 0;
  switch (law.kind) {
    case LAW.lambert:
      return mu0;
    case LAW.lommelSeeliger:
      return mu0 / (mu0 + mu);
    case LAW.lunarLambert:
      return (2 * law.p * mu0) / (mu0 + mu) + (1 - law.p) * mu0;
    case LAW.minnaert:
      return Math.pow(mu0, law.p) * Math.pow(mu, law.p - 1);
    case LAW.hapke:
      return hapkeRadf(Math.acos(Math.min(mu0, 1)), Math.acos(Math.min(mu, 1)), g, law);
    default:
      return mu0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Disk integral
// ─────────────────────────────────────────────────────────────────────────────────────────────

const glCache = new Map<number, { x: Float64Array; w: Float64Array }>();

/** Gauss–Legendre nodes and weights on [−1, 1]. */
export function gaussLegendre(n: number): { x: Float64Array; w: Float64Array } {
  const c = glCache.get(n);
  if (c) return c;
  const x = new Float64Array(n), w = new Float64Array(n);
  for (let i = 0; i < Math.ceil(n / 2); i++) {
    let z = Math.cos((Math.PI * (i + 0.75)) / (n + 0.5));
    let dp = 0;
    for (let it = 0; it < 100; it++) {
      let p1 = 1, p2 = 0;
      for (let j = 1; j <= n; j++) {
        const p3 = p2;
        p2 = p1;
        p1 = ((2 * j - 1) * z * p2 - (j - 1) * p3) / j;
      }
      dp = (n * (z * p1 - p2)) / (z * z - 1);
      const z1 = z;
      z = z1 - p1 / dp;
      if (Math.abs(z - z1) < 1e-15) break;
    }
    x[i] = -z; x[n - 1 - i] = z;
    w[i] = w[n - 1 - i] = 2 / ((1 - z * z) * dp * dp);
  }
  const r = { x, w };
  glCache.set(n, r);
  return r;
}

/** Zonal (longitude-averaged) mean of a surface map per channel; row j is centred at lat 90° − 180°(j + ½)/rows. */
export interface ZonalProfile {
  rows: number;
  /** rows × 4 values (XYZS interleaved). */
  mean: Float64Array;
}

function zonalAt(z: ZonalProfile, sinLat: number, out: number[]): void {
  const lat = Math.asin(Math.max(-1, Math.min(1, sinLat)));
  const v = ((Math.PI / 2 - lat) / Math.PI) * z.rows - 0.5;
  const j0 = Math.max(0, Math.min(z.rows - 1, Math.floor(v)));
  const j1 = Math.min(z.rows - 1, j0 + 1);
  const t = Math.max(0, Math.min(1, v - j0));
  for (let k = 0; k < 4; k++) out[k] = z.mean[4 * j0 + k] * (1 - t) + z.mean[4 * j1 + k] * t;
}

/**
 * I(α) = (1/π) ∫ r(μ0, μ, α)·M̄(lat) dA_proj over the unit disk (per channel), for a distant observer.
 * Photometric frame: z toward the observer, x in the observer–Sun plane toward the Sun. The lit and
 * visible lune is the rectangle λ ∈ [α − π/2, π/2], β ∈ [−π/2, π/2] in photometric longitude/latitude,
 * integrated with Gauss–Legendre quadrature (n × n nodes).
 *
 * @param pole body's north pole in the photometric frame (needed only with a zonal profile)
 */
export function lawDiskIntegral(law: ResolvedLaw, alpha: number, zonal?: { profile: ZonalProfile; pole: V3 }, n = 32): XYZS {
  const a = Math.min(Math.max(alpha, 0), Math.PI);
  const lam0 = a - Math.PI / 2, lam1 = Math.PI / 2;
  if (lam1 <= lam0) return [0, 0, 0, 0];
  const { x, w } = gaussLegendre(n);
  const sa = Math.sin(a), ca = Math.cos(a);
  const acc = [0, 0, 0, 0];
  const m = [1, 1, 1, 1];
  for (let p = 0; p < n; p++) {
    const lam = lam0 + ((x[p] + 1) / 2) * (lam1 - lam0);
    const wl = (w[p] * (lam1 - lam0)) / 2;
    const sl = Math.sin(lam), cl = Math.cos(lam);
    for (let q = 0; q < n; q++) {
      const beta = (x[q] * Math.PI) / 2;
      const wb = (w[q] * Math.PI) / 2;
      const cb = Math.cos(beta), sb = Math.sin(beta);
      const mu = cb * cl;
      const mu0 = cb * (sl * sa + cl * ca);
      const r = lawRadf(law, mu0, mu, a);
      if (!(r > 0)) continue;
      const f = r * mu * cb * wl * wb;
      if (zonal) {
        const P = zonal.pole;
        zonalAt(zonal.profile, cb * sl * P[0] + sb * P[1] + cb * cl * P[2], m);
      }
      for (let k = 0; k < 4; k++) acc[k] += f * m[k];
    }
  }
  return acc.map((v) => v / Math.PI) as XYZS;
}

/** Closed-form disk-integrated phase function of a Lommel–Seeliger sphere, Φ(0) = 1. */
export function lommelSeeligerPhase(alpha: number): number {
  if (alpha <= 0) return 1;
  if (alpha >= Math.PI) return 0;
  return 1 - Math.sin(alpha / 2) * Math.tan(alpha / 2) * Math.log(1 / Math.tan(alpha / 4));
}

/**
 * Normalization of a spatial law with a map for one geometry: Φ(α)/I(α) per channel, cached on a
 * quantized geometry key. The renderer multiplies albedoXYZS/(π d²) by this factor.
 */
export class NormalizationCache {
  private cache = new Map<string, XYZS>();

  get(key: string, compute: () => XYZS): XYZS {
    let v = this.cache.get(key);
    if (!v) {
      v = compute();
      if (this.cache.size > 4096) this.cache.clear();
      this.cache.set(key, v);
    }
    return v;
  }
}

/** Photometric frame (z toward observer, x toward the Sun in the observer–Sun plane) from body-centred unit vectors. */
export function photometricFrame(toObserver: V3, toSun: V3): [V3, V3, V3] {
  const z = toObserver;
  const d = toSun[0] * z[0] + toSun[1] * z[1] + toSun[2] * z[2];
  let xv: V3 = [toSun[0] - d * z[0], toSun[1] - d * z[1], toSun[2] - d * z[2]];
  let l = Math.hypot(...xv);
  if (l < 1e-12) {
    // Zero (or 180°) phase: any direction perpendicular to z.
    const h: V3 = Math.abs(z[0]) < 0.6 ? [1, 0, 0] : [0, 1, 0];
    const hd = h[0] * z[0] + h[1] * z[1] + h[2] * z[2];
    xv = [h[0] - hd * z[0], h[1] - hd * z[1], h[2] - hd * z[2]];
    l = Math.hypot(...xv);
  }
  const x: V3 = [xv[0] / l, xv[1] / l, xv[2] / l];
  const y: V3 = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return [x, y, z];
}
