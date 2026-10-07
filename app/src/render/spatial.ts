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
}

function zonalAt(z: ZonalProfile, sinLat: number, out: number[]): void {
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
  for (let j = 0; j < zonal.profile.rows; j++) cuts.push(Math.PI * (0.5 - (j + 0.5) / zonal.profile.rows));
  // Latitudes where a circle becomes tangent to the limb, terminator, or i=e great circle.
  const sd = Math.hypot(sa, ca - 1);
  for (const pd of [pv, ps, ...(sd > 1e-12 ? [(ps - pv) / sd] : [])]) {
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
  // The sine map makes distances to both lune edges quadratic in the node coordinate:
  // it smooths the fractional-power endpoints of Minnaert without clipping the law.
  // Akimov contains cos(beta)^(a/(pi-a)); its width is O(sqrt((pi-a)/pi)).
  // beta = atan(scale*tan(u)) resolves that concentration even as the lune narrows.
  const delta = Math.PI - a;
  const scale = law.kind === LAW.akimov ? Math.sqrt(delta / Math.PI) : 1;
  const evaluate = (order: number): XYZS => {
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
  };
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
): XYZS {
  const a = Math.min(Math.max(alpha, 0), Math.PI);
  const lam0 = a - Math.PI / 2, lam1 = Math.PI / 2;
  if (lam1 <= lam0) return [0, 0, 0, 0];
  const { x, w } = gaussLegendre(n);
  const sa = Math.sin(a), ca = Math.cos(a);
  const [X, Y, Z] = frame;
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
      const lat = Math.asin(Math.max(-1, Math.min(1, bz)));
      const lon0 = Math.atan2(by, bx);
      const wt = (mu * cb * wl * wb) / rotations;
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
