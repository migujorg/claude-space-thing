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
// exactly albedoXYZS·(1/d²)(R/Δ)²·Φ(α) for spheres (ellipsoids use their fixed albedo reference below). For a map without longitude
// structure it holds at every instant. This file is the float64 reference; shaders.ts mirrors lawRadf.

import type { AlbedoMeasurementView, CalibrationNormalizationTable, HapkePhaseFile, HapkePhaseTable, PhaseDependent, SpatialPhotometricModel } from '../data/schema';
import type { V3 } from './raycast';

export type XYZS = [number, number, number, number];

/** Numeric codes shared with the WGSL body shader. */
export const LAW = { lambert: 0, lommelSeeliger: 1, lunarLambert: 2, minnaert: 3, hapke: 4, texelHapke: 5, akimov: 6, barkstrom: 7 } as const;

/** A spatial model with its phase-dependent parameters evaluated at one phase angle. */
export interface ResolvedLaw {
  kind: number;
  /** lunar-lambert L, minnaert k, barkstrom B, or hapke w. */
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
/** Marker for the per-texel Hapke law (texelLaw.ts): the body shader reads its parameters from the texel. */
export const TEXEL_LAW: ResolvedLaw = { ...LAMBERT_LAW, kind: LAW.texelHapke };

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
    case 'akimov':
      return { law: { ...LAMBERT_LAW, kind: LAW.akimov } };
    case 'barkstrom': {
      const B = evalPhaseDependent(m.B, deg);
      return B === null ? { error: `Barkstrom B not tabulated at ${deg.toFixed(1)}°` } : { law: { ...LAMBERT_LAW, kind: LAW.barkstrom, p: B } };
    }
    case 'hapke':
      return {
        law: {
          kind: LAW.hapke, p: m.w, b: m.b, c: m.c, bs0: m.bs0, hs: m.hs, bc0: m.bc0 ?? 0, hc: m.hc ?? 1,
          thetaBar: (m.thetaBarDeg * Math.PI) / 180, K: m.K ?? 1, hFn: m.hFunction === 'hapke1981' ? 1 : 0,
        },
      };
    default:
      // A kind this renderer does not know (a newer data build): the caller falls back to Lambert and says so.
      return { error: `spatial model kind '${(m as { kind: string }).kind}' not supported by the renderer` };
  }
}

/**
 * Akimov disk function (Shkuratov et al. 1999, Icarus 141, 132; as written by Filacchione et al. 2022,
 * arXiv:2111.15541, §4 Eqs. 4–6, for Saturn's mid-sized moons), parameter-free:
 *   D = cos(g/2)·cos[π/(π − g)·(γ − g/2)]·(cos β)^{g/(π − g)} / cos γ,
 *   γ = arctan[(cos i − cos e cos g)/(cos e sin g)],  β = arccos(cos e / cos γ),
 * with γ, β the photometric longitude and latitude. I/F = D·F(g) (their Eq. 3); D = 1 at g = 0 and
 * 0 at the terminator (γ = g − π/2). At the bright limb (γ → π/2) the ratio cos[π(γ − g/2)/(π − g)]/cos γ
 * is 0/0; with ε = π/2 − γ it is exactly sin(kε)/sin ε, k = π/(π − g), → k. g is clamped below π.
 */
export function akimovDisk(mu0: number, mu: number, gIn: number): number {
  if (!(mu0 > 0) || !(mu > 0)) return 0;
  const g = Math.min(Math.max(gIn, 0), Math.PI - 1e-4);
  if (g < 1e-6) return 1;
  const gam = Math.atan2(mu0 - mu * Math.cos(g), mu * Math.sin(g));
  const eps = Math.PI / 2 - gam;
  const k = Math.PI / (Math.PI - g);
  const ratio = eps > 1e-6 ? Math.sin(k * eps) / Math.sin(eps) : k;
  const cosBeta = Math.min(1, Math.max(mu / Math.max(Math.cos(gam), 1e-300), 1e-300));
  return Math.max(0, Math.cos(g / 2) * ratio * Math.pow(cosBeta, g / (Math.PI - g)));
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
  const Bc = x > 1e-9 ? (1 - Math.expm1(-x) / x) / (2 * (1 + x) ** 2) : 1;
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
    case LAW.akimov:
      return akimovDisk(mu0, mu, g);
    case LAW.barkstrom:
      // Barkstrom (1973): I/F ∝ (1/μ)(μ0μ/(μ0 + μ))^B; μ floored at 1e-3 (B < 1 diverges at the limb); mirrored in WGSL.
      return Math.pow((mu0 * mu) / (mu0 + mu), law.p) / Math.max(mu, 1e-3);
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
  /** Internal Gauss-map profiles: exact sampler and its interpolation/geometry cuts, in radians. */
  sample?: (sinLat: number, out: number[]) => void;
  cuts?: number[];
  slopeBound?: XYZS;
  maxBound?: XYZS;
  minBound?: XYZS;
}

function zonalAt(z: ZonalProfile, sinLat: number, out: number[]): void {
  if (z.sample) { z.sample(sinLat, out); return; }
  const lat = Math.asin(Math.max(-1, Math.min(1, sinLat)));
  const v = ((Math.PI / 2 - lat) / Math.PI) * z.rows - 0.5;
  const j0 = Math.max(0, Math.min(z.rows - 1, Math.floor(v)));
  const j1 = Math.min(z.rows - 1, j0 + 1);
  const t = Math.max(0, Math.min(1, v - j0));
  for (let k = 0; k < 4; k++) out[k] = z.mean[4 * j0 + k] * (1 - t) + z.mean[4 * j1 + k] * t;
}

/** Zonal maps are piecewise linear in BODY latitude. Integrate in that frame, splitting
 * at every row centre and at the great-circle tangencies/intersections, instead of trying
 * to resolve hundreds of interpolation kinks by global node doubling in photometric latitude.
 * The measure is mu*cos(lat)*dlat*dlon, exactly the same projected area as the bare-law path. */
function zonalDiskIntegral(law: ResolvedLaw, a: number, zonal: { profile: ZonalProfile; pole: V3 }, n: number): XYZS {
  const length = Math.hypot(...zonal.pole);
  const P = zonal.pole.map(v => v / length) as V3;
  const el = Math.hypot(P[0], P[1]);
  const E: V3 = el > 1e-12 ? [-P[1] / el, P[0] / el, 0] : [1, 0, 0];
  const F: V3 = [P[1] * E[2] - P[2] * E[1], P[2] * E[0] - P[0] * E[2], P[0] * E[1] - P[1] * E[0]];
  const sa = Math.sin(a), ca = Math.cos(a);
  const incidence = (v: V3) => sa * v[0] + ca * v[2];
  const pv = P[2], ps = incidence(P), ev = E[2], es = incidence(E), fv = F[2], fs = incidence(F);
  const cuts = [-Math.PI / 2, Math.PI / 2];
  cuts.push(...profileCuts(zonal.profile));
  // Latitudes where a circle becomes tangent to the limb, terminator, i=e plane,
  // or Hapke roughness azimuth cusp in the Sun/observer plane.
  const sd = Math.hypot(sa, ca - 1);
  for (const pd of [pv, ps, ...(law.kind === LAW.hapke && law.thetaBar > 0 ? [P[1]] : []), ...(sd > 1e-12 ? [(ps - pv) / sd] : [])]) {
    const lat = Math.acos(Math.min(1, Math.abs(pd)));
    cuts.push(-lat, lat);
  }
  // The limb/terminator intersection is +/- y in the photometric frame, for nonzero phase.
  if (Math.abs(sa) > 1e-12) { const lat = Math.asin(P[1]); cuts.push(lat, -lat); }
  // Barkstrom has the same mu=1e-3 floor in CPU and shader; split its kink too.
  if (law.kind === LAW.barkstrom) {
    const radius = Math.sqrt((1 - 1e-6) * Math.max(0, 1 - pv * pv));
    for (const z of [1e-3 * pv - radius, 1e-3 * pv + radius]) cuts.push(Math.asin(Math.max(-1, Math.min(1, z))));
  }
  const unique = (values: number[]) => values.sort((x, y) => x - y).filter((v, j, all) => j === 0 || v - all[j - 1] > 32 * Number.EPSILON);
  const latCuts = unique(cuts);
  const evaluate = (order: number): XYZS => {
    const latGL = gaussLegendre(order), lonGL = gaussLegendre(2 * order);
    const acc: XYZS = [0, 0, 0, 0], map = [1, 1, 1, 1];
    for (let j = 1; j < latCuts.length; j++) {
      const half = (latCuts[j] - latCuts[j - 1]) / 2;
      for (let q = 0; q < order; q++) {
        const lat = latCuts[j - 1] + (latGL.x[q] + 1) * half, z = Math.sin(lat), cb = Math.cos(lat);
        const av = z * pv, bv = cb * ev, cv = cb * fv;
        const as = z * ps, bs = cb * es, cs = cb * fs;
        const phiCuts = [-Math.PI, Math.PI];
        const boundaries = [[av, bv, cv], [as, bs, cs], [as - av, bs - bv, cs - cv]];
        // Hapke's local azimuth is even across the Sun/observer plane and has a
        // cusp there. In body coordinates that plane is not a row boundary.
        // Split it explicitly rather than globally doubling through the cusp.
        if (law.kind === LAW.hapke && law.thetaBar > 0) boundaries.push([z * P[1], cb * E[1], cb * F[1]]);
        if (law.kind === LAW.barkstrom) boundaries.push([av - 1e-3, bv, cv]);
        for (const [A, B, C] of boundaries) {
          const r = Math.hypot(B, C);
          if (r === 0 || Math.abs(A) >= r) continue;
          const centre = Math.atan2(C, B), angle = Math.acos(-A / r);
          for (let phi of [centre - angle, centre + angle]) {
            if (phi < -Math.PI) phi += 2 * Math.PI;
            if (phi > Math.PI) phi -= 2 * Math.PI;
            phiCuts.push(phi);
          }
        }
        const longitudes = unique(phiCuts);
        zonalAt(zonal.profile, z, map);
        for (let k = 1; k < longitudes.length; k++) {
          const lo = longitudes[k - 1], hi = longitudes[k], mid = (lo + hi) / 2;
          if (av + bv * Math.cos(mid) + cv * Math.sin(mid) <= 0 || as + bs * Math.cos(mid) + cs * Math.sin(mid) <= 0) continue;
          for (let p = 0; p < 2 * order; p++) {
            const u = lonGL.x[p] * Math.PI / 2;
            const phi = mid + (hi - lo) / 2 * Math.sin(u), cp = Math.cos(phi), sp = Math.sin(phi);
            const mu = av + bv * cp + cv * sp, mu0 = as + bs * cp + cs * sp;
            const value = lawRadf(law, mu0, mu, a) * mu * cb * latGL.w[q] * half
              * lonGL.w[p] * (hi - lo) * Math.PI / 4 * Math.cos(u);
            for (let c = 0; c < 4; c++) acc[c] += value * map[c];
          }
        }
      }
    }
    return acc.map(v => v / Math.PI) as XYZS;
  };
  let order = Math.max(4, Math.ceil(n / 4)), prev = evaluate(order);
  const maxOrder = Math.max(128, 2 * order);
  while (order < maxOrder) {
    order = Math.min(2 * order, maxOrder);
    const next = evaluate(order);
    if (next.every((v, c) => Math.abs(v - prev[c]) <= 1e-6 * Math.max(Math.abs(v), Math.abs(prev[c])))) return next;
    prev = next;
  }
  throw new Error('Zonal surface-law disk quadrature did not converge to 1e-6');
}

/** One endpoint-smoothed order, also the bounded-cost fallback for an unavailable bare table. */
function bareDiskIntegralAtOrder(law: ResolvedLaw, a: number, order: number): XYZS {
  // The sine map makes distances to both lune edges quadratic in the node coordinate:
  // it smooths the fractional-power endpoints of Minnaert without clipping the law.
  // Akimov contains cos(beta)^(a/(pi-a)); its width is O(sqrt((pi-a)/pi)).
  // beta = atan(scale*tan(u)) resolves that concentration even as the lune narrows.
  const delta = Math.PI - a;
  const scale = law.kind === LAW.akimov ? Math.sqrt(delta / Math.PI) : 1;

  const { x, w } = gaussLegendre(order);
  // Split at the equator and mu0=mu (eps=delta/2), where roughness changes branch.
  // The bare law is even in beta (zonal profiles use the row-split path above).
  const latitudes = Array.from(x, (v, q) => {
    const u = (v + 1) * Math.PI / 4, t = Math.tan(u);
    const beta = Math.atan(scale * t);
    const jac = scale * (1 + t * t) / (1 + scale * scale * t * t);
    return { cb: Math.cos(beta), sb: Math.sin(beta), wb: w[q] * Math.PI / 4 * jac };
  }).map(v => ({ ...v, wb: 2 * v.wb }));
  const acc: XYZS = [0, 0, 0, 0];
  for (const side of [-1, 1]) for (let p = 0; p < order; p++) {
    const u = side * (x[p] + 1) * Math.PI / 4;
    const eps = delta * (1 + Math.sin(u)) / 2;
    const wl = w[p] * delta * Math.PI / 8 * Math.cos(u);
    const cl = Math.sin(eps);
    // mu0 = cos(beta)*sin(delta-eps) avoids cancellation in the thin crescent.
    const ci = Math.sin(delta - eps);
    for (const { cb, wb } of latitudes) {
      const mu = cb * cl, mu0 = cb * ci;
      const r = lawRadf(law, mu0, mu, a);
      if (!(r > 0)) continue;
      const f = r * mu * cb * wl * wb;
      for (let k = 0; k < 4; k++) acc[k] += f;
    }
  }
  return acc.map(v => v / Math.PI) as XYZS;
}

/**
 * I(α) = (1/π) ∫ r(μ0, μ, α)·M̄(lat) dA_proj over the unit disk (per channel), for a distant observer.
 * Photometric frame: z toward the observer, x in the observer–Sun plane toward the Sun. The lit and
 * visible lune is the rectangle λ ∈ [α − π/2, π/2], β ∈ [−π/2, π/2] in photometric longitude/latitude,
 * integrated with endpoint-smoothed, adaptively doubled Gauss–Legendre quadrature.
 * `n` is the initial order; successive integrals must agree to 1e-6 relative (tested against an
 * independent reference to 1e-4 for the supported laws from 0 to 179.9 degrees).
 *
 * @param pole body's north pole in the photometric frame (needed only with a zonal profile)
 */
export function lawDiskIntegral(law: ResolvedLaw, alpha: number, zonal?: { profile: ZonalProfile; pole: V3 }, n = 32): XYZS {
  const a = Math.min(Math.max(alpha, 0), Math.PI);
  const lam0 = a - Math.PI / 2, lam1 = Math.PI / 2;
  if (lam1 <= lam0) return [0, 0, 0, 0];
  if (zonal) return zonalDiskIntegral(law, a, zonal, n);
  const evaluate = (order: number) => bareDiskIntegralAtOrder(law, a, order);
  // Relative successive-order tolerance is numerical, not a fit/scene parameter. Leave two
  // orders of margin to the 1e-4 reference contract; fail explicitly if refinement cannot resolve it.
  let order = Math.max(16, Math.ceil(n)), prev = evaluate(order);
  const maxOrder = Math.max(1024, 2 * order);
  while (order < maxOrder) {
    order = Math.min(2 * order, maxOrder);
    const next = evaluate(order);
    if (next.every((v, c) => Math.abs(v - prev[c]) <= 1e-6 * Math.max(Math.abs(v), Math.abs(prev[c])))) return next;
    prev = next;
  }
  throw new Error('Surface-law disk quadrature did not converge to 1e-6');
}

/**
 * I_c = (1/π)∫ f_c dA_proj over the lit and visible lune of the unit disk, with f = R·M evaluated at each
 * point's body-fixed planetocentric latitude and longitude: the normalization for a map (and a
 * per-texel law) that is not zonal. Same photometric frame as lawDiskIntegral, with fixed-order
 * quadrature in longitude/latitude. `frame`
 * holds the photometric axes (x toward the Sun in the observer–Sun plane, y, z toward the observer)
 * expressed in the body-fixed frame. `rotations` > 1 averages over that many rotations of the body about
 * its pole (for disk photometry that is itself a rotational average); 1 = this geometry exactly (for disk
 * photometry measured at this geometry, e.g. ROLO).
 */
export function mapDiskIntegral(
  alpha: number,
  frame: [V3, V3, V3],
  f: (lat: number, lon: number, mu0: number, mu: number, g: number) => XYZS,
  n = 20,
  rotations = 1,
  radii?: V3,
): XYZS {
  const a = Math.min(Math.max(alpha, 0), Math.PI);
  const lam0 = a - Math.PI / 2, lam1 = Math.PI / 2;
  if (lam1 <= lam0) return [0, 0, 0, 0];
  const { x, w } = gaussLegendre(n);
  const sa = Math.sin(a), ca = Math.cos(a);
  const [X, Y, Z] = frame;
  const R = radii ? Math.cbrt(radii[0]*radii[1]*radii[2]) : 1;
  const d = radii ? radii.map(v=>(v/R)**2) : [1,1,1];
  const acc = [0, 0, 0, 0];
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
      if (!(mu0 > 0) || !(mu > 0)) continue;
      const px = cb * sl, py = sb, pz = cb * cl;
      const bx = px * X[0] + py * Y[0] + pz * Z[0];
      const by = px * X[1] + py * Y[1] + pz * Z[1];
      const bz = px * X[2] + py * Y[2] + pz * Z[2];
      const den=d[0]*bx*bx+d[1]*by*by+d[2]*bz*bz;
      const jac=radii?d[0]*d[1]*d[2]/den**2:1;
      const position=radii?[d[0]*bx,d[1]*by,d[2]*bz]:[bx,by,bz];
      const lat = Math.asin(Math.max(-1, Math.min(1, radii?position[2]/Math.hypot(...position):bz)));
      const lon0 = Math.atan2(position[1],position[0]);
      const wt = (mu * cb * wl * wb * jac) / rotations;
      for (let k = 0; k < rotations; k++) {
        let lon = lon0 + (2 * Math.PI * k) / rotations;
        if (lon > Math.PI) lon -= 2 * Math.PI;
        const v = f(lat, lon, mu0, mu, a);
        for (let c = 0; c < 4; c++) acc[c] += wt * v[c];
      }
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
 * The zonally weighted disk integral by a fixed n × n Gauss–Legendre rule over the lit lune (the rule every
 * normalization used before the converged quadratures above): n² law evaluations whatever the map, so its cost
 * is bounded (about 2 ms for Hapke at n = 24), where `zonalDiskIntegral` splits the lune at every row knot of
 * the map and costs seconds for a Hapke law on a 256-row map. It does not resolve the row knots: against the
 * converged integral it is within 2.5e-3 for the built maps (render-law-motion-cost.test.ts; 1.9e-3 measured).
 */
function fixedOrderZonalIntegral(law: ResolvedLaw, a: number, zonal: { profile: ZonalProfile; pole: V3 }, n: number): XYZS {
  const lam0 = a - Math.PI / 2, lam1 = Math.PI / 2;
  if (lam1 <= lam0) return [0, 0, 0, 0];
  const { x, w } = gaussLegendre(n);
  const sa = Math.sin(a), ca = Math.cos(a), P = zonal.pole;
  const acc = [0, 0, 0, 0], m = [1, 1, 1, 1];
  for (let p = 0; p < n; p++) {
    const lam = lam0 + ((x[p] + 1) / 2) * (lam1 - lam0);
    const wl = (w[p] * (lam1 - lam0)) / 2;
    const sl = Math.sin(lam), cl = Math.cos(lam);
    for (let q = 0; q < n; q++) {
      const beta = (x[q] * Math.PI) / 2;
      const cb = Math.cos(beta), sb = Math.sin(beta);
      const mu = cb * cl;
      const r = lawRadf(law, cb * (sl * sa + cl * ca), mu, a);
      if (!(r > 0)) continue;
      const f = r * mu * cb * wl * ((w[q] * Math.PI) / 2);
      zonalAt(zonal.profile, cb * sl * P[0] + sb * P[1] + cb * cl * P[2], m);
      for (let k = 0; k < 4; k++) acc[k] += f * m[k];
    }
  }
  return acc.map((v) => v / Math.PI) as XYZS;
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

// Motion normalization. The general converged quadrature remains the oracle/fallback above.
// All tolerances below are numerical error budgets, never photometric fit parameters.
const MOTION_RELATIVE_BUDGET = 5e-5;

// Lanczos g=7, n=9 log-gamma approximation (Boost.Math / Numerical Recipes). Its constants
// approximate a mathematical function; they are not physical quantities or fitted scene values.
function logGamma(z: number): number {
  const c = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  z--;
  let x = 0.99999999999980993;
  for (let i = 0; i < c.length; i++) x += c[i] / (z + i + 1);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
const latitudeBeta = (s: number) => Math.exp(logGamma(0.5) + logGamma(s + 1) - logGamma(s + 1.5));
const scalarXYZS = (v: number): XYZS => [v, v, v, v];

function profileCuts(z: ZonalProfile): number[] {
  return z.cuts ?? Array.from({ length: z.rows }, (_, j) => Math.PI * (0.5 - (j + 0.5) / z.rows));
}

type PhaseCell = HapkePhaseTable['cells'][number];
/** Piecewise cubic in log(I / particle-phase-factor) versus t=log(pi/(pi-alpha)); this removes the crescent's
 * vanishing power law. Each cell is checked at seven interlaced points against converged
 * quadrature, to 1e-7 relative. The supported-model tested bound is 2e-5 (not an
 * interval-arithmetic certificate for arbitrary future Hapke fits). Construction belongs exclusively to the pipeline bridge; frames only read its product. */
function hapkePhaseFactor(law: ResolvedLaw, a: number): number {
  const tg = Math.tan(a / 2), Bs = law.hs > 0 ? 1 / (1 + tg / law.hs) : 0;
  const x = law.hc > 0 ? tg / law.hc : Infinity;
  const Bc = x > 1e-9 ? (1 - Math.expm1(-x) / x) / (2 * (1 + x) ** 2) : 1;
  return doubleHG(a, law.b, law.c) * (1 + law.bs0 * Bs) * (1 + law.bc0 * Bc);
}
export function buildHapkePhaseCells(law: ResolvedLaw): PhaseCell[] {
  if (law.kind !== LAW.hapke || !(law.p > 0)) throw new Error('Expected a nonzero Hapke law');
  const out: PhaseCell[] = [], cache = new Map<number, number>();
  const evalAt = (t: number) => {
    let v = cache.get(t);
    if (v === undefined) {
      const a = Math.PI * -Math.expm1(-t);
      v = Math.log(lawDiskIntegral(law, a, undefined, 24)[0] / hapkePhaseFactor(law, a));
      cache.set(t, v);
    }
    return v;
  };
  const visit = (lo: number, hi: number, depth: number) => {
    const values = [0, 1 / 3, 2 / 3, 1].map(u => evalAt(lo + u * (hi - lo)));
    const cell = { lo, hi, values };
    let error = 0;
    for (const u of [1 / 12, 1 / 6, 1 / 4, 1 / 2, 3 / 4, 5 / 6, 11 / 12])
      error = Math.max(error, Math.abs(Math.expm1(cubic(cell, lo + u * (hi - lo)) - evalAt(lo + u * (hi - lo)))));
    if (error <= 1e-7) out.push(cell);
    else if (depth < 16) { const mid = (lo + hi) / 2; visit(lo, mid, depth + 1); visit(mid, hi, depth + 1); }
    else throw new Error('Surface-law phase interpolation did not converge');
  };
  const end = Math.log(Math.PI / 1e-4);
  for (let j = 0; j < 16; j++) visit(end * j / 16, end * (j + 1) / 16, 0);
  return out;
}
function cubic(c: PhaseCell, t: number): number {
  const u = (t - c.lo) / (c.hi - c.lo), [a, b, d, e] = c.values;
  return -4.5 * (u - 1 / 3) * (u - 2 / 3) * (u - 1) * a
    + 13.5 * u * (u - 2 / 3) * (u - 1) * b
    - 13.5 * u * (u - 1 / 3) * (u - 1) * d
    + 4.5 * u * (u - 1 / 3) * (u - 2 / 3) * e;
}

// Replaced atomically at data load, never constructed in a frame. Exact resolved-law keys
// prevent reuse for a changed fit; the loader checks the TS source digest before installation.
let hapkePhaseTables = new Map<string, HapkePhaseTable>();
const hapkeLawKey = (law: ResolvedLaw) => JSON.stringify(law);
export function installHapkePhaseTables(product: HapkePhaseFile | null, spatialCodeSha256: string | null): string[] {
  const tables = new Map<string, HapkePhaseTable>(), notes: string[] = [];
  for (const [id, entry] of Object.entries(product ?? {})) {
    const t = entry?.value;
    const resolved = t?.model?.kind === 'hapke' ? resolveLaw(t.model, 0) : null;
    let hi = 0;
    const valid = t?.algorithm === 'hapke-phase-v1' && t.spatialCodeSha256 === spatialCodeSha256
      && spatialCodeSha256 !== null && t.relativeTolerance > 0 && t.relativeTolerance <= 1e-5 && t.interpolationTolerance > 0 && t.interpolationTolerance <= 1e-7
      && t.minCrescentRad > 0 && t.minCrescentRad <= 1e-4 && Array.isArray(t.cells) && t.cells.length > 0
      && t.cells.every(c => {
        const good = c != null && c.lo === hi && c.hi > c.lo && Number.isFinite(c.hi)
          && Array.isArray(c.values) && c.values.length === 4 && c.values.every(Number.isFinite);
        if (c) hi = c.hi; return good;
      }) && Math.abs(hi - Math.log(Math.PI / t.minCrescentRad)) < 1e-12;
    if (!valid || !resolved || 'error' in resolved) {
      notes.push(`${id}: missing, stale or invalid bare Hapke phase table → bounded fixed-order normalization`);
    } else tables.set(hapkeLawKey(resolved.law), t);
  }
  hapkePhaseTables = tables;
  return notes;
}
export function hapkePhaseTableIssue(law: ResolvedLaw, alpha: number): string | null {
  if (law.kind !== LAW.hapke || law.p === 0 || alpha >= Math.PI) return null;
  const table = hapkePhaseTables.get(hapkeLawKey(law));
  if (!table) return 'bare Hapke phase table missing or stale → bounded fixed-order normalization';
  if (Math.PI - alpha < table.minCrescentRad) return 'bare Hapke phase outside table domain → bounded fixed-order normalization';
  return null;
}
function hapkePhaseLookup(law: ResolvedLaw, a: number): XYZS | null {
  const table = hapkePhaseTables.get(hapkeLawKey(law));
  if (!table || Math.PI - a < table.minCrescentRad) return null;
  const t = Math.log(Math.PI / (Math.PI - a)), cells = table.cells;
  let lo = 0, hi = cells.length - 1;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (t > cells[mid].hi) lo = mid + 1; else hi = mid; }
  return scalarXYZS(Math.exp(cubic(cells[lo], t)) * hapkePhaseFactor(law, a));
}

interface ZonalSpectrum { coeff: Float64Array; energy: XYZS; min: XYZS; max: XYZS; slope: XYZS; knots: Float64Array }
const SPECTRAL_MAX = 512;
/** M(y)=sum c_l P_l(y). Composite GL at the actual row knots integrates the input,
 * with no downsampled/replaced map. The L2 residual is retained to bound truncation. */
function zonalSpectrum(z: ZonalProfile): ZonalSpectrum {
  const coeff = new Float64Array((SPECTRAL_MAX + 1) * 4), energy: XYZS = [0, 0, 0, 0];
  const min: XYZS = [Infinity, Infinity, Infinity, Infinity], max: XYZS = [0, 0, 0, 0], slope: XYZS = [0, 0, 0, 0];
  const innerCuts = profileCuts(z).sort((a, b) => a - b);
  const knots = Float64Array.from(innerCuts, Math.sin), cuts = [-Math.PI / 2, ...innerCuts, Math.PI / 2];
  for (let j = 0; j < z.rows; j++) {

    for (let c = 0; c < 4; c++) {
      min[c] = Math.min(min[c], z.mean[4 * j + c]); max[c] = Math.max(max[c], z.mean[4 * j + c]);
      if (j > 0) slope[c] = Math.max(slope[c], Math.abs(z.mean[4 * j + c] - z.mean[4 * (j - 1) + c]) * z.rows / Math.PI);
    }
  }
  for (let c = 0; c < 4; c++) {
    if (z.slopeBound) slope[c] = z.slopeBound[c];
    if (z.maxBound) max[c] = z.maxBound[c];
    if (z.minBound) min[c] = z.minBound[c];
  }
  const gl = gaussLegendre(24), vals = [0, 0, 0, 0];
  for (let j = 1; j < cuts.length; j++) for (let q = 0; q < gl.x.length; q++) {
    const lat = cuts[j - 1] + (gl.x[q] + 1) * (cuts[j] - cuts[j - 1]) / 2, y = Math.sin(lat);
    const w = Math.cos(lat) * gl.w[q] * (cuts[j] - cuts[j - 1]) / 4;
    zonalAt(z, y, vals);
    for (let c = 0; c < 4; c++) energy[c] += w * vals[c] ** 2;
    let prev = 1, cur = y;
    for (let l = 0; l <= SPECTRAL_MAX; l++) {
      const pl = l === 0 ? 1 : l === 1 ? y : ((2 * l - 1) * y * cur - (l - 1) * prev) / l;
      if (l > 1) { prev = cur; cur = pl; }
      for (let c = 0; c < 4; c++) coeff[4 * l + c] += (2 * l + 1) * w * vals[c] * pl;
    }
  }
  return { coeff, energy, min, max, slope, knots };
}

let harmonicFactors: { diag: Float64Array; first: Float64Array; A: Float64Array; B: Float64Array; moment: Float64Array } | undefined;
function factors() {
  if (harmonicFactors) return harmonicFactors;
  const width = SPECTRAL_MAX + 1, size = width * width;
  const diag = new Float64Array(width), first = new Float64Array(width);
  const A = new Float64Array(size), B = new Float64Array(size), moment = new Float64Array(size);
  for (let m = 0; m < width; m++) {
    if (m > 0) diag[m] = Math.sqrt((2 * m - 1) / (2 * m));
    first[m] = Math.sqrt(2 * m + 1);
    for (let l = m + 2; l < width; l++) {
      const index = l * width + m, den = Math.sqrt(l * l - m * m);
      A[index] = (2 * l - 1) / den; B[index] = Math.sqrt((l - 1) ** 2 - m * m) / den;
      if ((l - m) % 2 === 0) {
        const j = (l - m) / 2;
        moment[index] = Math.sqrt(2 * j * (2 * j - 1) / ((2 * m + 2 * j) * (2 * m + 2 * j - 1))) * (m + j - 0.5) / j;
      }
    }
  }
  harmonicFactors = { diag, first, A, B, moment };
  return harmonicFactors;
}

/** Associated Legendre latitude moments R_lm(s)=int (1-y²)^s sqrt((l-m)!/(l+m)!) P_l^m(y) dy.
 * Odd l-m vanish. Integrating Gegenbauer polynomials gives the beta/Pochhammer recurrence
 * below (expand the Gegenbauer polynomial and integrate each monomial); this is analytic, not another quadrature/table. */
function latitudeMoments(s: number, degree: number, reusable?: Float64Array): Float64Array {
  const width = SPECTRAL_MAX + 1, R = reusable ?? new Float64Array(width * (degree + 1)), f = factors();
  let diag = 1;
  const bb = [latitudeBeta(s), latitudeBeta(s + 0.5)];
  for (let m = 0; m <= degree; m++) {
    if (m > 0) diag *= -f.diag[m];
    if (m >= 2) bb[m % 2] *= (s + m / 2) / (s + m / 2 + 0.5);
    let r = diag * bb[m % 2];
    R[m * width + m] = r;
    for (let l = m + 2; l <= degree; l += 2) {
      const j = (l - m) / 2;
      r *= f.moment[l * width + m] * (m / 2 - s + j - 1) / (s + m / 2 + j + 0.5);
      R[l * width + m] = r;
    }
  }
  return R;
}

/** Fast separable kernel, before Barkstrom's paired limb floor. */
function longitudeMoments(law: ResolvedLaw, a: number, degree: number) {
  const delta = Math.PI - a;
  // The largest oscillation is degree*delta/2, not degree*pi/2. Keep the full-disk
  // resolution per wavelength but avoid thousands of nodes in a narrow crescent.
  const order = Math.max(64, 16 * Math.ceil(2 * degree * delta / (16 * Math.PI)));
  const Q = new Float64Array(degree + 1), gl = gaussLegendre(order);
  let square = 0;
  for (let i = 0; i < gl.x.length / 2; i++) {
    const u = gl.x[i] * Math.PI / 2, t = delta / 2 * Math.sin(u), eps = delta / 2 + t;
    const ci = Math.sin(delta - eps), cl = Math.sin(eps);
    const f = Math.pow(law.kind === LAW.minnaert ? ci * cl : ci * cl / (ci + cl), law.p);
    const w = gl.w[i] * delta * Math.PI / 2 * Math.cos(u), ct = Math.cos(t);
    square += w * f * f;
    let prev = 1, cur = ct;
    for (let m = 0; m <= degree; m++) {
      const v = m === 0 ? 1 : m === 1 ? ct : 2 * ct * cur - prev;
      if (m > 1) { prev = cur; cur = v; }
      Q[m] += w * f * v;
    }
  }
  return { Q, square };
}

/** Addition theorem with polar axis perpendicular to the Sun/observer plane. Parseval and
 * Cauchy–Schwarz give the orientation-independent ABSOLUTE remainder:
 * |I-I_L| <= sqrt(4pi (E[M²]-sum c_l²/(2l+1)) (||K||²-||K_L||²))/pi.
 * The small positive roundoff reserve prevents a negative subtraction from certifying zero error.
 * Barkstrom's omitted floor has an independent positive upper bound, checked before acceptance. */
function spectralIntegral(law: ResolvedLaw, a: number, pole: V3, spectrum: ZonalSpectrum, R: Float64Array, degree: number, levels: number[], correction?: { value: XYZS; error: XYZS }) {
  const { Q, square } = longitudeMoments(law, a, degree), s = law.kind === LAW.minnaert ? law.p : law.p / 2;
  const norm = latitudeBeta(2 * s) * square, length = Math.hypot(...pole), y = pole[1] / length;
  const st = Math.sqrt(Math.max(0, 1 - y * y)), az = Math.atan2(pole[0], pole[2]) - a / 2;
  const byDegree = new Float64Array(degree + 1), norms = new Float64Array(degree + 1);
  const cos = Array.from({ length: degree + 1 }, (_, m) => Math.cos(m * az));
  let diag = 1;
  const width = SPECTRAL_MAX + 1, f = factors();
  for (let m = 0; m <= degree; m++) {
    if (m > 0) diag *= -f.diag[m] * st;
    let cur = diag, prev = 0;
    for (let l = m; l <= degree; l++) {
      const p = l === m ? cur : l === m + 1 ? f.first[m] * y * cur
        : f.A[l * width + m] * y * cur - f.B[l * width + m] * prev;
      if (l > m) { prev = cur; cur = p; }
      if ((l - m) % 2 !== 0) continue;
      const r = R[l * width + m], contribution = (m === 0 ? 1 : 2) * r * Q[m] * p * cos[m] / Math.PI;
      byDegree[l] += contribution;
      norms[l] += (2 * l + 1) / (4 * Math.PI) * r * r * Q[m] * Q[m] * (m === 0 ? 1 : 2);
    }
  }
  // The profile coefficient depends on degree, not harmonic order. Sum the scalar
  // kernel first, then apply all four channels once per degree.
  // All lower truncations share these exact moments: sum each degree once, rather than
  // recomputing the entire rotation for every convergence check.
  const results: { degree: number; value: XYZS; relativeBound: number; extraRelativeBound: number }[] = [];
  const sum: XYZS = [0, 0, 0, 0], used: XYZS = [0, 0, 0, 0];
  const floor = law.kind === LAW.barkstrom && !correction ? 2 * Math.pow(1e-3, law.p + 1) / ((law.p + 1) * (law.p + 2)) : 0;
  let projectedNorm = 0, next = 0;
  for (let l = 0; l <= degree; l++) {
    projectedNorm += norms[l];
    for (let c = 0; c < 4; c++) { sum[c] += byDegree[l] * spectrum.coeff[4 * l + c]; used[c] += spectrum.coeff[4 * l + c] ** 2 / (2 * l + 1); }
    if (l !== levels[next]) continue;
    next++;
    const value = sum.map((v, c) => v - (correction?.value[c] ?? 0)) as XYZS;
    const tail = Math.max(0, norm - projectedNorm) + norm * 1e-12;
    let relativeBound = 0, extraRelativeBound = 0;
    for (let c = 0; c < 4; c++) {
      const residual = Math.max(0, spectrum.energy[c] - used[c]) + spectrum.energy[c] * 1e-12;
      // K <= mu^B in the omitted strip, dOmega=dmu*dphi. This is a positive bound.
      const extra = floor * spectrum.max[c] + (correction?.error[c] ?? 0);
      const bound = Math.sqrt(4 * Math.PI * residual * tail) / Math.PI + extra;
      extraRelativeBound = Math.max(extraRelativeBound, extra / Math.max(value[c] - extra, Number.MIN_VALUE));
      relativeBound = Math.max(relativeBound, bound / Math.max(value[c] - bound, Number.MIN_VALUE));
    }
    results.push({ degree: l, value, relativeBound, extraRelativeBound });
  }
  return results;
}

/** Near a crescent the harmonic remainder bound is intentionally conservative. Instead integrate
 * in photometric longitude, splitting the INNER latitude integral at every actual map knot and
 * at Barkstrom's floor. The laws separate, so only one pow per latitude node is needed. */
function crescentIntegral(law: ResolvedLaw, a: number, pole: V3, z: ZonalProfile, knots: Float64Array, n: number, nb: number): XYZS {
  const lg = gaussLegendre(n), delta = Math.PI - a;
  const s = law.kind === LAW.minnaert ? 2 * law.p : law.p, length = Math.hypot(...pole);
  const P = pole.map(v => v / length), acc: XYZS = [0, 0, 0, 0];
  const lonCuts = [-Math.PI / 2, Math.PI / 2];
  const addLambda = (lam: number) => {
    if (lam <= a - Math.PI / 2 || lam >= Math.PI / 2) return;
    const eps = Math.PI / 2 - lam;
    lonCuts.push(Math.asin(Math.max(-1, Math.min(1, 2 * eps / delta - 1))));
  };
  const amplitude = Math.hypot(P[0], P[2]), centre = Math.atan2(P[0], P[2]);
  // Outer-longitude tangencies to each map row: A(lambda)^2 + Py^2 = sin(lat_row)^2.
  // Without these cuts, doubling longitude nodes can alias the narrow latitude-row arcs.
  if (amplitude > 0) for (const y of knots) {
    if (y * y <= P[1] * P[1]) continue;
    const target = Math.sqrt(y * y - P[1] * P[1]) / amplitude;
    if (target >= 1) continue;
    for (const sign of [-1, 1]) {
      const t = Math.acos(sign * target);
      for (let lam of [centre - t, centre + t]) {
        if (lam < -Math.PI) lam += 2 * Math.PI;
        if (lam > Math.PI) lam -= 2 * Math.PI;
        addLambda(lam);
      }
    }
  }
  if (law.kind === LAW.barkstrom) addLambda(Math.acos(1e-3));
  const uniqueLongitudes = lonCuts.sort((x, y) => x - y).filter((v, j, all) => j === 0 || v - all[j - 1] > 32 * Number.EPSILON);
  for (let segment = 1; segment < uniqueLongitudes.length; segment++) for (let p = 0; p < n; p++) {
    const du = (uniqueLongitudes[segment] - uniqueLongitudes[segment - 1]) / 2;
    const u = uniqueLongitudes[segment - 1] + (lg.x[p] + 1) * du, eps = delta * (1 + Math.sin(u)) / 2;
    const lam = Math.PI / 2 - eps, cl = Math.sin(eps), ci = Math.sin(delta - eps);
    const wl = lg.w[p] * delta / 2 * du * Math.cos(u) / Math.PI;
    const lon = Math.pow(law.kind === LAW.minnaert ? ci * cl : ci * cl / (ci + cl), law.p);
    const A = P[0] * Math.sin(lam) + P[2] * cl, radius = Math.hypot(A, P[1]), b0 = Math.atan2(P[1], A);
    const cuts = [-Math.PI / 2, Math.PI / 2];
    for (const y of knots) {
      if (Math.abs(y) >= radius) continue;
      const t = Math.acos(y / radius);
      for (let b of [b0 - t, b0 + t]) {
        if (b < -Math.PI) b += 2 * Math.PI;
        if (b > Math.PI) b -= 2 * Math.PI;
        if (b > -Math.PI / 2 && b < Math.PI / 2) cuts.push(b);
      }
    }
    if (law.kind === LAW.barkstrom && cl > 1e-3) { const b = Math.acos(1e-3 / cl); cuts.push(-b, b); }
    const uniqueLatitudes = cuts.sort((x, y) => x - y).filter((v, j, all) => j === 0 || v - all[j - 1] > 32 * Number.EPSILON);
    for (let j = 1; j < uniqueLatitudes.length; j++) {
      const db = (uniqueLatitudes[j] - uniqueLatitudes[j - 1]) / 2;
      // Empty equatorial knot spans at a thin crescent can cover the whole latitude range.
      // Resolve those wide intervals too; longitude convergence alone cannot certify latitude.
      const bg = gaussLegendre(Math.max(nb, nb * Math.ceil(8 * db)));
      const mid = (uniqueLatitudes[j] + uniqueLatitudes[j - 1]) / 2;
      const midLat = Math.asin(Math.max(-1, Math.min(1, A * Math.cos(mid) + P[1] * Math.sin(mid))));
      const rawRow = Math.floor((0.5 - midLat / Math.PI) * z.rows - 0.5);
      const row = Math.max(0, Math.min(z.rows - 1, rawRow)), next = Math.min(row + 1, z.rows - 1);
      let weight = 0, latitudeMoment = 0;
      const sampled = [0, 0, 0, 0];
      for (let q = 0; q < bg.x.length; q++) {
        const b = uniqueLatitudes[j - 1] + (bg.x[q] + 1) * db, cb = Math.cos(b);
        const lat = Math.asin(Math.max(-1, Math.min(1, A * cb + P[1] * Math.sin(b))));
        let f = Math.pow(cb, s + 1) * bg.w[q] * db * wl * lon;
        if (law.kind === LAW.barkstrom) f *= Math.min(1, cb * cl / 1e-3);
        if (z.sample) {
          zonalAt(z, Math.sin(lat), sampled);
          for (let c = 0; c < 4; c++) acc[c] += f * sampled[c];
        } else { weight += f; latitudeMoment += f * lat; }
      }
      const tMoment = rawRow < 0 || row === z.rows - 1 ? 0 : (z.rows / 2 - 0.5 - row) * weight - z.rows / Math.PI * latitudeMoment;
      for (let c = 0; c < 4; c++) acc[c] += z.mean[row * 4 + c] * weight + (z.mean[next * 4 + c] - z.mean[row * 4 + c]) * tMoment;
    }
  }
  return acc;
}

/** Barkstrom's floor correction in dOmega=dmu*dphi, with the map evaluated on the limb.
 * This reuse has an analytic absolute bound: latitude is 1-Lipschitz in spherical distance,
 * distance(n(mu,phi),n(0,phi))=asin(mu), and |M'| is known from the actual linear rows.
 * Map error <= max|M'| asin(f) * 2 f^(B+1)/((B+1)(B+2)). */
function barkstromFloorCorrection(law: ResolvedLaw, a: number, P: V3, z: ZonalProfile, spectrum: ZonalSpectrum, n: number): { value: XYZS; bound: XYZS } {
  const gl = gaussLegendre(n), phiGL = gaussLegendre(4), value: XYZS = [0, 0, 0, 0];
  const sa = Math.sin(a), ca = Math.cos(a), length = Math.hypot(...P), pole = P.map(v => v / length);
  const radius = Math.hypot(pole[0], pole[1]), centre = Math.atan2(pole[1], pole[0]);
  const cuts = [-Math.PI / 2, Math.PI / 2];
  for (const y of spectrum.knots) {
    if (Math.abs(y) >= radius) continue;
    const t = Math.acos(y / radius);
    for (let phi of [centre - t, centre + t]) {
      if (phi < -Math.PI) phi += 2 * Math.PI;
      if (phi > Math.PI) phi -= 2 * Math.PI;
      if (phi > -Math.PI / 2 && phi < Math.PI / 2) cuts.push(phi);
    }
  }
  const threshold = 1e-3 * Math.abs(ca) / (sa * Math.sqrt(1 - 1e-6));
  if (threshold < 1) { const phi = Math.acos(threshold); cuts.push(-phi, phi); }
  cuts.sort((x, y) => x - y);
  const map = [0, 0, 0, 0];
  for (let j = 1; j < cuts.length; j++) for (let k = 0; k < phiGL.x.length; k++) {
    const dphi = (cuts[j] - cuts[j - 1]) / 2, u = phiGL.x[k] * Math.PI / 2;
    const phi = (cuts[j] + cuts[j - 1]) / 2 + dphi * Math.sin(u), cp = Math.cos(phi);
    const muMax = Math.min(1e-3, sa * cp / Math.hypot(ca, sa * cp));
    zonalAt(z, pole[0] * cp + pole[1] * Math.sin(phi), map);
    let weight = 0;
    for (let q = 0; q < n; q++) {
      const mu = (gl.x[q] + 1) * muMax / 2, mu0 = sa * Math.sqrt(1 - mu * mu) * cp + ca * mu;
      weight += Math.pow(Math.max(0, mu * mu0 / (mu + mu0)), law.p) * (1 - mu / 1e-3) * gl.w[q] * muMax / 2;
    }
    weight *= phiGL.w[k] * dphi / 2 * Math.cos(u);
    for (let c = 0; c < 4; c++) value[c] += weight * map[c];
  }
  const upper = 2 * Math.pow(1e-3, law.p + 1) / ((law.p + 1) * (law.p + 2));
  return { value, bound: spectrum.slope.map(v => v * Math.asin(1e-3) * upper) as XYZS };
}

/** Cache owned by the caller, so cold work and warm work can be benchmarked separately. No
 * rounded geometry key: every query uses its actual phase/pole, also when the camera stops. */
export class MotionNormalization {
  private spectra = new WeakMap<ZonalProfile, ZonalSpectrum>();
  private moments = new Map<string, Float64Array>();
  private degrees = new WeakMap<ZonalProfile, { degree: number; alpha: number }>();
  private variableMoments?: Float64Array;
  private variableExponent?: number;
  private variableDegree = 0;
  private fixed = new NormalizationCache();
  private zonalIds = new WeakMap<ZonalProfile, number>();
  private nextZonalId = 1;

  /**
   * The bounded-cost path for what no fast method above covers (a Hapke law, and any law but Minnaert and
   * Barkstrom under a zonal map): a fixed-order quadrature (about 2 ms), cached. A lookup runs on the main
   * thread inside a frame, first use included: 7 October 2026, a table built on first use took 1.5–2.5 s per
   * Hapke body, and the converged zonal integral 0.8–6 s in every frame of a mapped one.
   *
   * The cache's cell is chosen so that the value at its centre stands for every phase in it within 10⁻⁵:
   * |d ln I/dα| is bounded by the two opposition terms at α = 0, b₀/(2h) each (B = 1/(1 + tan(α/2)/h)), plus
   * the crescent's power law, at most 4/(π − α), plus 2 for the rest; the cell's width is 10⁻⁵ over that bound,
   * rounded down to a power of two (Pluto's coherent peak, h_C = 1.4·10⁻⁴: cells of 7·10⁻⁹ rad). The integral
   * is evaluated at the cell's centre and at the pole rounded to 10⁻⁴, so the result does not depend on which
   * phase of the cell was asked for first.
   */
  private fixedOrder(law: ResolvedLaw, a: number, zonal?: { profile: ZonalProfile; pole: V3 }): XYZS {
    const n = law.kind === LAW.hapke ? 24 : 32;
    const surge = law.kind === LAW.hapke ? (law.hs > 0 ? law.bs0 / (2 * law.hs) : 0) + (law.hc > 0 ? law.bc0 / (2 * law.hc) : 0) : 0;
    const slope = surge + 4 / 2 ** Math.floor(Math.log2(Math.PI - a)) + 2;
    const step = 2 ** Math.floor(Math.log2(1e-5 / slope)), cell = Math.round(a / step);
    const centre = Math.min(cell * step, Math.PI);
    let key = `${JSON.stringify(law)}|${step}|${cell}`;
    let at = zonal;
    if (zonal) {
      let id = this.zonalIds.get(zonal.profile);
      if (!id) this.zonalIds.set(zonal.profile, (id = this.nextZonalId++));
      const pole = zonal.pole.map((v) => Math.round(v * 1e4) / 1e4) as V3;
      key += `|${id}|${pole.join(',')}`;
      at = { profile: zonal.profile, pole };
    }
    return this.fixed.get(key, () => (at ? fixedOrderZonalIntegral(law, centre, at, n) : law.kind === LAW.hapke ? bareDiskIntegralAtOrder(law, centre, n) : lawDiskIntegral(law, centre, undefined, n)));
  }

  get(law: ResolvedLaw, alpha: number, zonal?: { profile: ZonalProfile; pole: V3 }): XYZS {
    const a = Math.min(Math.max(alpha, 0), Math.PI), delta = Math.PI - a;
    if (!(delta > 0)) return [0, 0, 0, 0];
    if (zonal && (law.kind === LAW.minnaert || law.kind === LAW.barkstrom) && law.p > 0) {
      let spectrum = this.spectra.get(zonal.profile);
      if (!spectrum) {
        spectrum = zonalSpectrum(zonal.profile); this.spectra.set(zonal.profile, spectrum);
        const s = law.kind === LAW.minnaert ? law.p : law.p / 2;
        const R = latitudeMoments(s, SPECTRAL_MAX);
        if (law.kind === LAW.barkstrom) {
          this.variableMoments = R; this.variableExponent = s; this.variableDegree = SPECTRAL_MAX;
        } else this.moments.set(`${s}:${SPECTRAL_MAX}`, R);
      }
      // Numerical workload crossover: the narrowest crescents are cheaper in row coordinates.
      if (a < 3.07) {
        let correction: { value: XYZS; error: XYZS } | undefined;
        if (law.kind === LAW.barkstrom && a > 2.8) {
          const bare = latitudeBeta(law.p / 2) * longitudeMoments(law, a, 0).Q[0] / Math.PI;
          const floor = 2 * Math.pow(1e-3, law.p + 1) / ((law.p + 1) * (law.p + 2));
          const omittedBound = Math.max(...spectrum.max.map((v, c) => floor * v / Math.max(bare * spectrum.min[c] - floor * v, Number.MIN_VALUE)));
          if (omittedBound > 1e-5) {
            const low = barkstromFloorCorrection(law, a, zonal.pole, zonal.profile, spectrum, 4);
            const high = barkstromFloorCorrection(law, a, zonal.pole, zonal.profile, spectrum, 8);
            correction = { value: high.value, error: high.value.map((v, c) => high.bound[c] + 4 * Math.abs(v - low.value[c])) as XYZS };
          }
        }
        const s = law.kind === LAW.minnaert ? law.p : law.p / 2;
        const choices = [64, 96, 128, 192, 256, 384, SPECTRAL_MAX];
        const previous = this.degrees.get(zonal.profile);
        const start = previous?.degree ?? 64;
        for (const degree of choices.filter(d => d >= start)) {
          const key = `${s}:${degree}`;
          let R: Float64Array;
          if (law.kind === LAW.barkstrom) {
            this.variableMoments ??= new Float64Array((SPECTRAL_MAX + 1) ** 2);
            if (this.variableExponent !== s || this.variableDegree < degree) {
              latitudeMoments(s, degree, this.variableMoments);
              this.variableExponent = s; this.variableDegree = degree;
            }
            R = this.variableMoments;
          } else {
            const cached = this.moments.get(`${s}:${SPECTRAL_MAX}`) ?? this.moments.get(key);
            R = cached ?? latitudeMoments(s, degree);
            if (!cached) {
              if (this.moments.size > 8) this.moments.clear();
              this.moments.set(key, R);
            }
          }
          const results = spectralIntegral(law, a, zonal.pole, spectrum, R, degree, choices.filter(d => d <= degree), correction);
          const recent: XYZS[] = [];
          for (const result of results) {
            recent.push(result.value);
            const correctionResolved = result.extraRelativeBound <= 1e-5;
            const converged = correctionResolved && recent.length >= 3 && recent.slice(-3).every(value => value.every((v, c) => Math.abs(v - result.value[c]) <= 4e-6 * Math.abs(result.value[c])));
            // With a loose analytic bound, three increasing orders must agree. This is a
            // convergence estimate, like the general quadrature; real-map scans test its
            // 2e-5 relative bound. It is not a continuous certificate for arbitrary maps.
            if (result.relativeBound <= MOTION_RELATIVE_BUDGET || converged) {
              this.degrees.set(zonal.profile, { degree: result.degree, alpha: a }); return result.value;
            }
          }
        }
      }
      let n = 4;
      const nb = 2;
      let prev = crescentIntegral(law, a, zonal.pole, zonal.profile, spectrum.knots, n, nb);
      for (let it = 0; it < 6; it++) {
        n *= 2;
        const value = crescentIntegral(law, a, zonal.pole, zonal.profile, spectrum.knots, n, nb);
        if (value.every((v, c) => Math.abs(v - prev[c]) <= 1e-5 * Math.abs(v))) return value;
        prev = value;
      }
      return lawDiskIntegral(law, a, zonal);
    }
    if (zonal) return this.fixedOrder(law, a, zonal);
    if (law.kind === LAW.lambert) return scalarXYZS(2 / (3 * Math.PI) * (Math.sin(a) + delta * Math.cos(a)));
    if (law.kind === LAW.lommelSeeliger) return scalarXYZS(0.5 * lommelSeeligerPhase(a));
    if (law.kind === LAW.lunarLambert) {
      const lambert = 2 / (3 * Math.PI) * (Math.sin(a) + delta * Math.cos(a));
      return scalarXYZS(law.p * lommelSeeligerPhase(a) + (1 - law.p) * lambert);
    }
    if (law.kind === LAW.akimov && delta >= 1e-4) {
      if (a < 1e-6) return scalarXYZS((1 + Math.cos(a)) / 2);
      return scalarXYZS(Math.cos(a / 2) * 2 * delta / Math.PI ** 2 * latitudeBeta((a / delta + 1) / 2));
    }
    if (law.kind === LAW.hapke) {
      if (law.p === 0) return scalarXYZS(0);
      const value = hapkePhaseLookup(law, a);
      if (value) return value;
    }
    return this.fixedOrder(law, a);
  }
}

/** Ellipsoid axes in km; optional photometric axes expressed in the body frame for triaxial bodies. */
export interface EllipsoidGeometry {
  radii: V3;
  pole: V3;
  axes?: [V3, V3, V3];
}

/** Normal-space change of variables (Gauss map), not an area-only correction.
 * x=D²n/|Dn|, dA=(abc)²/(n·D²n)² dΩ_n. Cosines are n·s and n·o;
 * maps use the latitude of x, NOT that of n. Radii are divided by the volumetric mean.
 * Oblate bodies have a zonal Jacobian, so the existing moving integral can integrate
 * the exact Jacobian times the exact piecewise-linear map, without resampling the map. */
export class EllipsoidNormalization {
  private motion = new MotionNormalization();
  constructor(private bare = new MotionNormalization()) {}
  private profiles = new WeakMap<ZonalProfile, Map<string, ZonalProfile>>();
  private plain = new Map<string, ZonalProfile>();
  private means = new WeakMap<ZonalProfile, XYZS>();
  private equatorMoments = new WeakMap<ZonalProfile, Map<string, XYZS>>();
  private equatorNodes = new WeakMap<ZonalProfile, Map<number, { logCos: number; values: XYZS }[]>>();
  private floorNodes = new WeakMap<ZonalProfile, Map<string, { lo: number; hi: number; nodes: { cp: number; sp: number; weight: number; map: XYZS }[] }[]>>();
  private exact = new Map<string, XYZS>();
  private tableViews = new WeakMap<object, WeakMap<object, boolean>>();
  private tableMaps = new WeakMap<ZonalProfile, WeakMap<object, boolean>>();
  private triaxial = new WeakMap<ZonalProfile, Map<string, XYZS>>();

  private profile(radii: V3, map?: ZonalProfile): ZonalProfile {
    const R = Math.cbrt(radii[0] * radii[1] * radii[2]);
    const a = radii[0] / R, c = radii[2] / R, a2 = a*a, c2 = c*c;
    const key = `${a}:${c}`;
    let cache = this.plain;
    if (map) { let found = this.profiles.get(map); if (!found) this.profiles.set(map, found = new Map()); cache = found; }
    const previous = cache.get(key); if (previous) return previous;
    const sample = (t: number, out: number[]) => {
      const positionZ = c2 * t / Math.hypot(a2 * Math.sqrt(Math.max(0, 1-t*t)), c2*t);
      if (map) zonalAt(map, positionZ, out); else out.fill(1);
      const jac = a2*a2*c2 / (a2 + (c2-a2)*t*t)**2;
      for (let k=0;k<4;k++) out[k] *= jac;
    };
    // Map kinks transform exactly to normal latitude. Extra smooth cuts resolve the
    // Jacobian on bare ellipsoids; they are integration cuts, never interpolation nodes.
    const cuts = Array.from({length:31},(_,j) => Math.PI*((j+1)/32-0.5));
    if (map) for (const lat of profileCuts(map)) cuts.push(Math.atan2(a2*Math.sin(lat),c2*Math.cos(lat)));
    cuts.sort((x,y)=>x-y);
    const unique = cuts.filter((v,j)=>j===0 || v-cuts[j-1]>1e-14);
    const rows = 1024, mean = new Float64Array(rows*4), values = [0,0,0,0];
    for (let j=0;j<rows;j++) { sample(Math.sin(Math.PI*(0.5-(j+0.5)/rows)),values); mean.set(values,4*j); }
    // Conservative analytic slope of W(t) M(lat_position(t)) in normal latitude.
    const low=Math.min(a2,c2), high=Math.max(a2,c2), wMax=a2*a2*c2/low**2;
    const wSlope=4*a2*a2*c2*Math.abs(c2-a2)/low**3;
    const slopeBound: XYZS=[0,0,0,0];
    for (let k=0;k<4;k++) {
      let max=1, slope=0;
      if (map) for (let j=0;j<map.rows;j++) { max=Math.max(max,map.mean[4*j+k]); if(j>0) slope=Math.max(slope,Math.abs(map.mean[4*j+k]-map.mean[4*(j-1)+k])*map.rows/Math.PI); }
      slopeBound[k]=wSlope*max+wMax*slope*high/low;
    }
    const maxBound: XYZS = [1,1,1,1], minBound: XYZS = [1,1,1,1];
    if (map) for(let k=0;k<4;k++) {
      maxBound[k]=0; minBound[k]=Infinity;
      for(let j=0;j<map.rows;j++) {maxBound[k]=Math.max(maxBound[k],map.mean[4*j+k]);minBound[k]=Math.min(minBound[k],map.mean[4*j+k]);}
    }
    for(let k=0;k<4;k++) {maxBound[k]*=wMax;minBound[k]*=a2*a2*c2/high**2;}
    const profile={rows,mean,sample,cuts:unique,slopeBound,maxBound,minBound}; cache.set(key,profile); return profile;
  }

  get(law: ResolvedLaw, alpha: number, geometry: EllipsoidGeometry, map?: ZonalProfile): XYZS {
    const [a,b,c]=geometry.radii;
    if(a===b && b===c) return this.bare.get(law,alpha,map?{profile:map,pole:geometry.pole}:undefined);
    if(a===b && (map || law.kind === LAW.minnaert || law.kind === LAW.barkstrom)) {
      const profile = this.profile(geometry.radii,map);
      if ((law.kind === LAW.minnaert || law.kind === LAW.barkstrom) && geometry.pole[0] === 0 && geometry.pole[2] === 0) {
        // At the equator-on reference the law separates in photometric latitude and
        // longitude. Integrate the exact profile only once per exponent, not per frame.
        let moments = this.equatorMoments.get(profile);
        if (!moments) this.equatorMoments.set(profile, moments = new Map());
        const momentKey = `${law.kind}:${law.p}:${Math.sign(geometry.pole[1])}`;
        let latitude = moments.get(momentKey);
        if (!latitude) {
          const sign=Math.sign(geometry.pole[1]);
          let nodesBySign=this.equatorNodes.get(profile);
          if(!nodesBySign)this.equatorNodes.set(profile,nodesBySign=new Map());
          let nodes=nodesBySign.get(sign);
          if(!nodes) {
            nodes=[];
            const gl=gaussLegendre(16),vals=[0,0,0,0],cuts=[-Math.PI/2,...profile.cuts!,Math.PI/2];
            for(let j=1;j<cuts.length;j++)for(let i=0;i<gl.x.length;i++) {
              const half=(cuts[j]-cuts[j-1])/2,beta=cuts[j-1]+(gl.x[i]+1)*half;
              profile.sample!(Math.sin(beta)*sign,vals);
              nodes.push({logCos:Math.log(Math.cos(beta)),values:vals.map(v=>v*gl.w[i]*half) as XYZS});
            }
            nodesBySign.set(sign,nodes);
          }
          latitude = [0,0,0,0];
          const exponent=law.kind===LAW.minnaert?2*law.p+1:law.p+1;
          for(const node of nodes) {
            const weight=Math.exp(exponent*node.logCos);
            for(let k=0;k<4;k++)latitude[k]+=weight*node.values[k];
          }
          if(moments.size>64)moments.clear(); moments.set(momentKey,latitude);
        }
        const longitude=longitudeMoments(law,alpha,0).Q[0]/Math.PI;
        const value = latitude.map(v=>v*longitude) as XYZS;
        if (law.kind === LAW.minnaert) return value;
        const max = profile.maxBound!;
        const floorBound=2*Math.pow(1e-3,law.p+1)/((law.p+1)*(law.p+2));
        if(value.every((v,k)=>floorBound*max[k]<1e-6*v))return value;
        // The only nonseparable term is Barkstrom's emission-cosine floor.
        // At an equator-on view, the latitude shift from a normal in this strip
        // to the limb is <= mu² |tan(phi)|/(1+sqrt(1-f²)). Integrating this bound
        // with mu^B and upper=min(f, tan(pi-alpha) cos(phi)) gives the closed form
        // below. Reuse the limb profile only when its positive error bound fits;
        // otherwise sample the exact latitude at every node.
        const tangent=Math.sin(alpha)/Math.abs(Math.cos(alpha)),power=law.p+3;
        const phiBound=2*(tangent<=1e-3 ? tangent**power/power
          : Math.pow(1e-3,power)*(1/power+Math.log(tangent/1e-3)));
        const latitudeBound=phiBound/(Math.PI*(1+Math.sqrt(1-1e-6))*power);
        if(Math.cos(alpha)>=0)return this.motion.get(law,alpha,{profile,pole:geometry.pole});
        let reuseLimb=true;
        const correction=(order:number):XYZS=>{
          const gl=gaussLegendre(order),acc:XYZS=[0,0,0,0],vals=[0,0,0,0],sa=Math.sin(alpha),ca=Math.cos(alpha);
          if(ca>=0)throw new Error('Barkstrom equator floor bound unexpectedly unresolved before quadrature domain');
          const phiGL=gaussLegendre(Math.max(2,order/2));
          const muNodes=Array.from(gl.x,x=>(1+Math.sin(x*Math.PI/2))/2);
          const muWeights=Array.from(gl.x,(x,i)=>gl.w[i]*Math.PI/4*Math.cos(x*Math.PI/2));
          const threshold=-ca*1e-3/(sa*Math.sqrt(1-1e-6));
          const split=threshold<1?Math.acos(threshold):null;
          const sign=Math.sign(geometry.pole[1]);
          const nodesFor=(lo:number,hi:number)=>Array.from(phiGL.x,(x,j)=>{
            const half=(hi-lo)/2,u=x*Math.PI/2,phi=(hi+lo)/2+half*Math.sin(u),cp=Math.cos(phi),sp=Math.sin(phi);
            const values=[0,0,0,0];profile.sample!(sp*sign,values);
            return {cp,sp,weight:phiGL.w[j]*half/2*Math.cos(u),map:values as XYZS};
          });
          let cache=this.floorNodes.get(profile);
          if(!cache)this.floorNodes.set(profile,cache=new Map());
          const nodeKey=`${phiGL.x.length}:${sign}`;
          let segments=cache.get(nodeKey);
          if(!segments) {
            const cuts=[-Math.PI/2,...profile.cuts!,Math.PI/2];
            segments=cuts.slice(1).map((hi,j)=>({lo:cuts[j],hi,nodes:nodesFor(cuts[j],hi)}));
            cache.set(nodeKey,segments);
          }
          for(const segment of segments) {
            // Only the two segments intersecting the moving mu=f boundary need new
            // longitude nodes; every unchanged node samples the same exact profile.
            let crossing: number | undefined;
            if(split!==null) {
              if(split>segment.lo && split<segment.hi)crossing=split;
              else if(-split>segment.lo && -split<segment.hi)crossing=-split;
            }
            const nodes=crossing===undefined?segment.nodes:[...nodesFor(segment.lo,crossing),...nodesFor(crossing,segment.hi)];
            for(const node of nodes) {
              const {cp,sp}=node,upper=Math.min(1e-3,sa*cp/Math.hypot(ca,sa*cp));
              let scalar=0;
              for(let i=0;i<order;i++) {
                const mu=muNodes[i]*upper,root=Math.sqrt(1-mu*mu),mu0=sa*root*cp+ca*mu;
                if(mu0<=0)continue;
                const w=Math.pow(mu*mu0/(mu+mu0),law.p)*(1-mu/1e-3)*muWeights[i]*upper*node.weight;
                if(reuseLimb)scalar+=w;
                else {
                  profile.sample!(root*sp*sign,vals);
                  for(let k=0;k<4;k++)acc[k]+=w*vals[k];
                }
              }
              if(reuseLimb)for(let k=0;k<4;k++)acc[k]+=scalar*node.map[k];
            }
          }
          return acc;
        };
        let previous=correction(4);
        for(let order=8;order<=64;order*=2) {
          const next=correction(order);
          const corrected=value.map((v,k)=>v-next[k]) as XYZS;
          if(next.every((v,k)=>Math.abs(v-previous[k])<1e-6*Math.abs(corrected[k]))) {
            if(reuseLimb && corrected.some((v,k)=>profile.slopeBound![k]*latitudeBound>=MOTION_RELATIVE_BUDGET*v)) {
              reuseLimb=false; previous=correction(4); order=4; continue;
            }
            return corrected;
          }
          previous=next;
        }
        throw new Error('Barkstrom equator floor correction did not converge');
      }
      return this.motion.get(law,alpha,{profile,pole:geometry.pole});
    }
    // Triaxial fallback: integrate in normal-space photometric coordinates with the
    // full Jacobian. This is only needed for the instantaneous point/glare flux.
    let axes=geometry.axes;
    if (!axes) {
      if(a!==b)throw new Error('Triaxial ellipsoid needs body-frame photometric axes');
      const P=geometry.pole,el=Math.hypot(P[0],P[1]);
      const E:V3=el>1e-12?[-P[1]/el,P[0]/el,0]:[1,0,0];
      const F:V3=[P[1]*E[2]-P[2]*E[1],P[2]*E[0]-P[0]*E[2],P[0]*E[1]-P[1]*E[0]];
      axes=[[E[0],F[0],P[0]],[E[1],F[1],P[1]],[E[2],F[2],P[2]]];
    }
    const R=Math.cbrt(a*b*c), d=geometry.radii.map(v=>(v/R)**2);
    const key=JSON.stringify([law,alpha,d,axes]);
    let mapCache: Map<string, XYZS> | undefined;
    if (map) { mapCache=this.triaxial.get(map); if(!mapCache)this.triaxial.set(map,mapCache=new Map()); const hit=mapCache.get(key);if(hit)return hit; }
    if (!map) {const hit=this.exact.get(key);if(hit)return hit;}
    const delta=Math.PI-alpha;
    if (!(delta>0)) return [0,0,0,0];
    const evaluate=(n:number):XYZS=>{
      const gl=gaussLegendre(n),acc:XYZS=[0,0,0,0],values=[1,1,1,1];
      for(let j=0;j<n;j++) for(let i=0;i<n;i++) {
        const betaScale=law.kind===LAW.akimov?Math.sqrt(delta/Math.PI):1;
        const v=gl.x[j]*Math.PI/2,tan=Math.tan(v),beta=Math.atan(betaScale*tan),cb=Math.cos(beta),sb=Math.sin(beta);
        const betaJac=betaScale*(1+tan*tan)/(1+betaScale*betaScale*tan*tan);
        const u=gl.x[i]*Math.PI/2,eps=delta*(1+Math.sin(u))/2,mu=cb*Math.sin(eps),mu0=cb*Math.sin(delta-eps);
        const nv=[cb*Math.cos(eps),sb,mu];
        const bf=axes[0].map((v,k)=>v*nv[0]+axes[1][k]*nv[1]+axes[2][k]*nv[2]);
        const den=bf.reduce((s,v,k)=>s+d[k]*v*v,0),jac=d[0]*d[1]*d[2]/den**2;
        if(map) zonalAt(map,d[2]*bf[2]/Math.hypot(...bf.map((v,k)=>d[k]*v)),values);
        const weight=lawRadf(law,mu0,mu,alpha)*mu*cb*jac*gl.w[j]*gl.w[i]*delta*Math.PI/8*Math.cos(u)*betaJac;
        for(let k=0;k<4;k++)acc[k]+=weight*values[k];
      }
      return acc;
    };
    // Fixed order keeps the current-view point integral bounded on first use, as
    // MotionNormalization does for Hapke maps. Smooth bare ellipsoids use 64;
    // mapped triaxial bodies use the same finite rule rather than adaptive refinement.
    const value=evaluate(law.kind === LAW.hapke ? 24 : 64);
    const cache=mapCache ?? this.exact;
    if(cache.size>512)cache.clear();cache.set(key,value);
    return value;
  }

  reference(law: ResolvedLaw, alpha: number, radii: V3, view: AlbedoMeasurementView, map?: ZonalProfile, table?: CalibrationNormalizationTable): XYZS {
    if (view.kind === 'latitude' && table && alpha < Math.PI) {
      const resolved = resolveLaw(table.model, alpha);
      let valid = !('error' in resolved) && JSON.stringify(resolved.law) === JSON.stringify(law)
        && table.radiiKm.every((v,k)=>v===radii[k]);
      let viewCache=this.tableViews.get(view);
      if(!viewCache)this.tableViews.set(view,viewCache=new WeakMap());
      let sameView=viewCache.get(table);
      if(sameView===undefined){sameView=JSON.stringify(view)===JSON.stringify(table.view);viewCache.set(table,sameView);}
      valid=valid && sameView;
      if (map && valid) {
        let byTable=this.tableMaps.get(map);
        if(!byTable)this.tableMaps.set(map,byTable=new WeakMap());
        let same=byTable.get(table);
        if(same===undefined) {
          same=!!table.zonalRows && table.zonalRows.length===map.mean.length
            && table.zonalRows.every((v,k)=>Math.abs(v-map.mean[k])<1e-12);
          byTable.set(table,same);
        }
        valid=same;
      }
      const t=Math.min(table.endLogCrescent,Math.log(Math.PI/(Math.PI-alpha)));
      if(valid && t<=table.endLogCrescent) {
        let lo=0,hi=table.cells.length-1;
        while(lo<hi){const mid=(lo+hi)>>>1;if(table.cells[mid].hi<t)lo=mid+1;else hi=mid;}
        const cell=table.cells[lo],v=map?cell.mapped:cell.bare;
        if(v) {
          const u=(t-cell.lo)/(cell.hi-cell.lo),delta=Math.PI-alpha;
          const factor=law.kind===LAW.minnaert?delta**(2*law.p+1)
            :delta**(law.p+1)*Math.min(1,delta/table.sphereFloor);
          const weights=[-4.5*(u-1/3)*(u-2/3)*(u-1),13.5*u*(u-2/3)*(u-1),
            -13.5*u*(u-1/3)*(u-1),4.5*u*(u-1/3)*(u-2/3)];
          const bare=factor*weights.reduce((sum,w,j)=>sum+w*cell.sphere[j],0);
          return [0,1,2,3].map(k=>bare*weights.reduce((sum,w,j)=>sum+w*v[j][k],0)) as XYZS;
        }
      }
    }
    if (view.kind === 'latitude') {
      const views = view.views?.length ? view.views : [{...view, weight: 1}];
      const result: XYZS = [0,0,0,0];
      for (const at of views) {
        const lat=at.latitudeDeg*Math.PI/180;
        const o:V3=[Math.cos(lat),0,Math.sin(lat)],t=at.solarTangent ?? [0,1,0];
        // Keep the observed Sun tangent as phase changes. At the observation
        // phase this gives the recorded sub-solar latitude exactly.
        const s=o.map((v,k)=>v*Math.cos(alpha)+t[k]*Math.sin(alpha)) as V3;
        const axes=photometricFrame(o,s),pole:V3=[axes[0][2],axes[1][2],axes[2][2]];
        const value=this.get(law,alpha,{radii,pole,axes},map);
        for(let k=0;k<4;k++)result[k]+=at.weight*value[k];
      }
      return result;
    }
    // Average ALL orientations of the normal-space Jacobian (Cauchy's mean area),
    // with the zonal map when present. The average commutes with the law integral.
    let average:XYZS;
    if(radii[0]===radii[1]) {
      const profile=this.profile(radii,map),cached=this.means.get(profile);
      if(cached)average=cached;else{
        average=[0,0,0,0];const gl=gaussLegendre(16),vals=[0,0,0,0],cuts=[-Math.PI/2,...profile.cuts!,Math.PI/2];
        for(let j=1;j<cuts.length;j++)for(let i=0;i<gl.x.length;i++){
          const half=(cuts[j]-cuts[j-1])/2,lat=cuts[j-1]+(gl.x[i]+1)*half;
          profile.sample!(Math.sin(lat),vals);
          for(let k=0;k<4;k++)average[k]+=vals[k]*Math.cos(lat)*gl.w[i]*half/2;
        }
        this.means.set(profile,average);
      }
    } else {
      const key='mean:'+radii.join(',');
      let cache=this.exact;
      if(map){let found=this.triaxial.get(map);if(!found)this.triaxial.set(map,found=new Map());cache=found;}
      const hit=cache.get(key);
      if(hit)average=hit;else {
        const R=Math.cbrt(radii[0]*radii[1]*radii[2]),d=radii.map(v=>(v/R)**2),gl=gaussLegendre(48),vals=[1,1,1,1];average=[0,0,0,0];
        for(let j=0;j<48;j++)for(let i=0;i<96;i++){
          const z=gl.x[j],rho=Math.sqrt(1-z*z),phi=2*Math.PI*(i+0.5)/96,nv=[rho*Math.cos(phi),rho*Math.sin(phi),z];
          const den=nv.reduce((s,v,k)=>s+d[k]*v*v,0),jac=d[0]*d[1]*d[2]/den**2;
          if(map)zonalAt(map,d[2]*z/Math.hypot(...nv.map((v,k)=>d[k]*v)),vals);
          for(let k=0;k<4;k++)average[k]+=jac*vals[k]*gl.w[j]/192;
        }
        cache.set(key,average);
      }
    }
    return this.bare.get(law,alpha).map((v,k)=>v*average[k]) as XYZS;
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
