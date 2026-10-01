// Planetary rings (docs/rendering-m2.md §5): the pipeline's ring products (rings.json, architecture §6)
// resampled for the GPU, the reflectance model as a float64 reference (mirrored in shaders-m2.ts), the
// disk-integrated light of rings too small to resolve, and per-frame preparation.
//
// Extinction: a ray crossing the ring plane at elevation B is transmitted exp(−τ⊥/|sin B|) (τ⊥ from the
// measured occultation profiles, `opticalDepth`).
//
// Reflectance: rings.json `reflectance` (kind 'single-scattering-v1'; Chandrasekhar 1960, Salo & French
// 2010 Eq. 6), per CIE channel c, μ = |sin B| of the observer, μ0 = |sin B′| of the Sun, sin Beff =
// 2μμ0/(μ + μ0), α the phase angle:
//   lit face   I/F_c = A(r)·W_c(r; α, Beff)·μ0/(4(μ + μ0))·[1 − exp(−τ⊥(r)(1/μ + 1/μ0))]
//   unlit face I/F_c = A(r)·g_u(r)·W_c(r; α, Beff)·μ0/(4|μ − μ0|)·|exp(−τ_u(r)/μ) − exp(−τ_u(r)/μ0)|
//              (μ = μ0: A·g_u·W·(τ_u/(4μ))·exp(−τ_u/μ))
//   radiance   L_c = I/F_c · E☉,c(d)/π
// W_c = ϖP from the per-region tables, bilinear in (α, Beff) with Beff clamped to the table; inside a
// region its table, between regions linear in radius from edge to edge, outside the nearest region's.
// Domain minPhaseDeg ≤ α ≤ maxPhaseDeg; outside it the ring brightness is unknown (hatched).
//
// Antialiasing: a pixel sees the average over a radial footprint that may span many profile bins.
// W varies slowly with radius and is taken at the footprint centre; the radial structure enters through
//   lit:   avg(A) − F_lit(k),  F_lit(k) = avg(A·exp(−τ⊥·k)),  k = 1/μ + 1/μ0
//   unlit: I/F = W/(4μ) · (1/|m1 − m0|)·|∫ H_u(m) dm| over [m0, m1] = [1/μ0, 1/μ],
//          H_u(m) = avg(A·g_u·τ_u·exp(−τ_u·m))   (μ = μ0: W·H_u(1/μ)/(4μ))
// F_lit is tabulated at 22 nodes spaced by √2 from k = 2, H_u at 44 nodes spaced by 2^(1/4) from m = 1,
// as cumulative sums over radius, and interpolated log-linearly (exact when the footprint has a single
// τ; for footprints mixing gaps and ringlets within ~1 % (lit) and ~2 % (unlit) of the exact mean).
// H_u (the derivative of the unlit transmission) has no constant part from empty gaps, which would
// otherwise swamp the small difference exp(−τ_u/μ) − exp(−τ_u/μ0).

import type { SceneBody, SceneRings } from './scene';
import type { Label, RingReflectance } from '../data/schema';
import { packComponentRecords, packComponents, phaseValue, type PackedComponents } from './ringComponents';
import { AU_KM } from './constants';
import { dot, len, normalize, prepareBody, type M3, type V3 } from './raycast';
import type { XYZS } from './photometry';

/** Largest number of radial bins uploaded per ring system. */
export const MAX_RING_BINS = 16384;
/** Nodes of the tabulated footprint averages: F_lit at k_j = 2·2^(j/2), H_u at m_j = 2^(j/4). */
export const RING_NODES = 22;
export const RING_NODES_U = 44;
export const RING_K0 = 2;
export const RING_M0 = 1;
/** Node spacing exponents (log2 of the node ratio). */
export const RING_K_STEP = 0.5;
export const RING_M_STEP = 0.25;
/** vec4 slots per bin edge: [Στ·known, Σknown_τ, Σknown_refl, ΣA] + 6 for F_lit + 11 for H_u. */
export const RING_STRIDE_MODEL = 18;
export const RING_STRIDE_PLAIN = 1;
const SLOT_FLIT = 1;
const SLOT_HU = 7;

export interface RingProfile {
  rMin: number;
  rMax: number;
  bins: number;
  /** vec4 slots per bin edge. */
  stride: number;
  /** Cumulative sums at the bins+1 bin edges (float32 for the GPU, float64 for the CPU). */
  cumulative: Float32Array;
  cum64: Float64Array;
  /** The reflectance model, if any. */
  model: RingReflectance | null;
  /** Model tables packed as vec4s for the GPU (layout: ringTables()), or null. */
  tables: Float32Array | null;
}

// Cached on the data arrays themselves (radiusKm, normalTau of each profile, and the reflectance model),
// not on the SceneRings wrapper: a shell that rebuilds the wrapper every frame must not cause a rebuild
// (7 885 bins × 66 exponentials) and a 2.3 MB re-upload per frame.
interface ProfileCacheEntry { arrays: unknown[]; byModel: WeakMap<object, RingProfile> }
const profileCache = new WeakMap<object, ProfileCacheEntry[]>();
const NO_MODEL = {};
const EMPTY_ANCHOR = {};

function profileCacheEntry(r: SceneRings, create: boolean): ProfileCacheEntry | undefined {
  const arrays = r.opticalDepth.flatMap((p) => [p.radiusKm, p.normalTau]);
  const anchor = (arrays[1] as object | undefined) ?? EMPTY_ANCHOR;
  let list = profileCache.get(anchor);
  let e = list?.find((x) => x.arrays.length === arrays.length && x.arrays.every((a, i) => a === arrays[i]));
  if (!e && create) {
    e = { arrays, byModel: new WeakMap() };
    if (!list) profileCache.set(anchor, (list = []));
    list.push(e);
  }
  return e;
}

function interpIn(R: number[], v: (number | null)[], r: number): number | null {
  const n = R.length;
  if (n < 2 || !(r >= R[0] && r <= R[n - 1])) return null;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (R[mid] <= r) lo = mid; else hi = mid; }
  const a = v[lo], b = v[hi];
  if (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  const t = R[hi] === R[lo] ? 0 : (r - R[lo]) / (R[hi] - R[lo]);
  return a + t * (b - a);
}

function gridAt(m: RingReflectance, arr: (number | null)[], r: number): number | null {
  const x = (r - m.radiusStartKm) / m.radiusStepKm;
  if (!(x >= 0 && x <= m.count - 1)) return null;
  const i = Math.min(Math.floor(x), m.count - 2);
  const a = arr[i], b = arr[i + 1];
  if (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  return a + (x - i) * (b - a);
}

/** Resample a ring system onto uniform bins and build the cumulative sums (cached per data object). */
export function ringProfile(r: SceneRings): RingProfile {
  const key = r.reflectance ?? NO_MODEL;
  const hit = profileCacheEntry(r, false)?.byModel.get(key);
  if (hit) return hit;
  const profs = r.opticalDepth.filter((p) => p.radiusKm.length >= 2);
  let rMin = Infinity, rMax = -Infinity, step = Infinity;
  for (const p of profs) {
    const n = p.radiusKm.length;
    rMin = Math.min(rMin, p.radiusKm[0]);
    rMax = Math.max(rMax, p.radiusKm[n - 1]);
    step = Math.min(step, (p.radiusKm[n - 1] - p.radiusKm[0]) / (n - 1));
  }
  const m = r.reflectance;
  if (m) step = Math.min(step, m.radiusStepKm);
  if (!(rMax > rMin)) { rMin = 0; rMax = 1; step = 1; }
  const bins = Math.max(1, Math.min(MAX_RING_BINS, Math.ceil((rMax - rMin) / step)));
  const stride = m ? RING_STRIDE_MODEL : RING_STRIDE_PLAIN;
  const S = stride * 4;
  const cum = new Float64Array((bins + 1) * S);
  const acc = new Float64Array(S);
  for (let b = 0; b < bins; b++) {
    const rc = rMin + ((b + 0.5) / bins) * (rMax - rMin);
    let tau: number | null = null;
    for (const p of profs) { tau = interpIn(p.radiusKm, p.normalTau, rc); if (tau !== null) break; }
    // Raw τ (measurement noise can make it negative): the footprint mean is clamped at 0 afterwards, so
    // averaging noisy empty gaps does not turn them into material.
    if (tau !== null) { acc[0] += tau; acc[1] += 1; }
    if (m) {
      const A = gridAt(m, m.litModulation, rc);
      const t = gridAt(m, m.normalTau, rc);
      const tu = gridAt(m, m.unlitTau, rc);
      const gu = gridAt(m, m.unlitGain, rc);
      if (A !== null && t !== null && tu !== null && gu !== null) {
        acc[2] += 1;
        acc[3] += A;
        for (let j = 0; j < RING_NODES; j++) acc[4 * SLOT_FLIT + j] += A * Math.exp(-Math.max(0, t) * RING_K0 * 2 ** (j * RING_K_STEP));
        const tuc = Math.max(0, tu);
        for (let j = 0; j < RING_NODES_U; j++) acc[4 * SLOT_HU + j] += A * gu * tuc * Math.exp(-tuc * RING_M0 * 2 ** (j * RING_M_STEP));
      }
    }
    cum.set(acc, (b + 1) * S);
  }
  const p: RingProfile = { rMin, rMax, bins, stride, cumulative: new Float32Array(cum), cum64: cum, model: m, tables: m ? ringTables(m) : null };
  profileCacheEntry(r, true)!.byModel.set(key, p);
  return p;
}

/**
 * Model tables as vec4s: [nP, nE, nR, 0], [minPhase, maxPhase, 0, 0], phase grid (4 per vec4), elevation
 * grid (4 per vec4), region edges [r0, r1, 0, 0] × nR, then W (XYZS) at ((region·nE) + e)·nP + p.
 */
export function ringTables(m: RingReflectance): Float32Array {
  const nP = m.phaseDeg.length, nE = m.elevationEffDeg.length, nR = m.regions.length;
  const v: number[] = [nP, nE, nR, 0, m.minPhaseDeg, m.maxPhaseDeg, 0, 0];
  const pack = (a: number[]) => { for (let i = 0; i < Math.ceil(a.length / 4) * 4; i++) v.push(a[i] ?? 0); };
  pack(m.phaseDeg);
  pack(m.elevationEffDeg);
  for (const g of m.regions) v.push(g.radiusKm[0], g.radiusKm[1], 0, 0);
  for (const g of m.regions) for (let e = 0; e < nE; e++) for (let p = 0; p < nP; p++) v.push(...g.amplitudeXYZS[e][p]);
  return new Float32Array(v);
}

/** Integral of cumulative slot `k` (float index within an edge record) over [x0, x1] in bin units. */
function segment(p: RingProfile, k: number, x0: number, x1: number): number {
  const S = p.stride * 4;
  const a = Math.min(Math.max(x0, 0), p.bins), b = Math.min(Math.max(x1, 0), p.bins);
  if (!(b > a)) return 0;
  const C = (j: number) => p.cum64[j * S + k];
  const j0 = Math.min(Math.floor(a), p.bins - 1), j1 = Math.min(Math.floor(b), p.bins - 1);
  const d0 = C(j0 + 1) - C(j0);
  if (j0 === j1) return (b - a) * d0;
  return (j0 + 1 - a) * d0 + (C(j1) - C(j0 + 1)) + (b - j1) * (C(j1 + 1) - C(j1));
}

export interface RingFootprint {
  /** Mean τ⊥ (unknown stretches count as 0) and the known fraction (outside the rings: known, empty). */
  tau: number;
  knownTau: number;
  /** Fraction of the footprint where the reflectance model is defined, and mean A there (× that fraction). */
  knownRefl: number;
  A: number;
  /** F_lit and H_u at their nodes (footprint means). */
  flit: number[];
  hu: number[];
}

/** Footprint means over [ra, rb] (km). */
export function ringAverage(p: RingProfile, ra: number, rb: number): RingFootprint {
  const s = p.bins / (p.rMax - p.rMin);
  let x0 = (Math.min(ra, rb) - p.rMin) * s, x1 = (Math.max(ra, rb) - p.rMin) * s;
  if (x1 - x0 < 1e-6) { x0 -= 5e-7; x1 += 5e-7; }
  const span = x1 - x0;
  const inside = Math.min(Math.max(x1, 0), p.bins) - Math.min(Math.max(x0, 0), p.bins);
  const g = (k: number) => segment(p, k, x0, x1) / span;
  const nodes = (slot: number, n: number) => (p.model ? Array.from({ length: n }, (_, j) => g(4 * slot + j)) : []);
  return {
    tau: Math.max(0, g(0)),
    knownTau: (segment(p, 1, x0, x1) + (span - inside)) / span,
    knownRefl: p.model ? g(2) : 0,
    A: p.model ? g(3) : 0,
    flit: nodes(SLOT_FLIT, RING_NODES),
    hu: nodes(SLOT_HU, RING_NODES_U),
  };
}

/**
 * Log-linear interpolation (in x) of node values F_j at x_j = x0·2^(j·step); returns F(x) and dF/dx.
 * Beyond the last node the last segment is continued.
 */
export function interpNodes(F: number[], x0: number, x: number, step = RING_K_STEP): [number, number] {
  const j = segmentOf(F.length, x0, step, x);
  const xa = x0 * 2 ** (j * step), xb = xa * 2 ** step;
  return interpSeg(F[j], F[j + 1], xa, xb, x);
}

function segmentOf(n: number, x0: number, step: number, x: number): number {
  return Math.min(Math.max(Math.floor(Math.log2(x / x0) / step), 0), n - 2);
}

function interpSeg(Fa: number, Fb: number, xa: number, xb: number, x: number): [number, number] {
  if (Fa > 1e-30 && Fb > 1e-30) {
    const sl = (Math.log(Fb) - Math.log(Fa)) / (xb - xa);
    const v = Fa * Math.exp(sl * (x - xa));
    return [v, v * sl];
  }
  const t = Math.min(Math.max((x - xa) / (xb - xa), 0), 1);
  return [Math.max(0, Fa + t * (Fb - Fa)), (Fb - Fa) / (xb - xa)];
}

/** ∫ from a to b (a < b) of the log-linear interpolant of node values H_j at x_j = x0·2^(j·step). */
export function integrateNodes(H: number[], x0: number, step: number, a: number, b: number): number {
  let total = 0;
  let x = a;
  let j = segmentOf(H.length, x0, step, a);
  for (let guard = 0; guard < H.length + 2 && x < b; guard++) {
    const xa = x0 * 2 ** (j * step), xb = xa * 2 ** step;
    const end = j >= H.length - 2 ? b : Math.min(b, xb);
    const Ha = H[j], Hb = H[j + 1];
    if (Ha > 1e-30 && Hb > 1e-30) {
      const sl = (Math.log(Hb) - Math.log(Ha)) / (xb - xa);
      const f = (y: number) => Ha * Math.exp(sl * (y - xa));
      total += Math.abs(sl) < 1e-12 ? Ha * (end - x) : (f(end) - f(x)) / sl;
    } else {
      const f = (y: number) => Math.max(0, Ha + ((Hb - Ha) * (y - xa)) / (xb - xa));
      total += 0.5 * (f(x) + f(end)) * (end - x);
    }
    x = end;
    j++;
  }
  return total;
}

/**
 * The radial part of I/F (without W), from footprint means: lit μ0/(4(μ+μ0))·(avg A − F_lit(1/μ + 1/μ0)),
 * unlit (1/(4μ))·|∫ H_u dm|/|m1 − m0| over [1/μ0, 1/μ].
 */
export function ringRadial(f: RingFootprint, mu: number, mu0: number, lit: boolean): number {
  if (!(mu > 0) || !(mu0 > 0) || !f.flit.length) return 0;
  if (lit) {
    const [F] = interpNodes(f.flit, RING_K0, 1 / mu + 1 / mu0, RING_K_STEP);
    return (mu0 / (4 * (mu + mu0))) * Math.max(0, f.A - F);
  }
  const m1 = 1 / mu, m0 = 1 / mu0;
  const lo = Math.min(m1, m0), hi = Math.max(m1, m0);
  if (hi - lo < 1e-5 * lo) return interpNodes(f.hu, RING_M0, m1, RING_M_STEP)[0] / (4 * mu);
  return integrateNodes(f.hu, RING_M0, RING_M_STEP, lo, hi) / (hi - lo) / (4 * mu);
}

/** The model's radial part evaluated exactly at a single radius (reference for tests). */
export function ringRadialExact(m: RingReflectance, r: number, mu: number, mu0: number, lit: boolean): number | null {
  const A = gridAt(m, m.litModulation, r), t = gridAt(m, m.normalTau, r);
  const tu = gridAt(m, m.unlitTau, r), gu = gridAt(m, m.unlitGain, r);
  if (A === null || t === null || tu === null || gu === null) return null;
  if (!(mu > 0) || !(mu0 > 0)) return 0;
  if (lit) return A * (mu0 / (4 * (mu + mu0))) * (1 - Math.exp(-t * (1 / mu + 1 / mu0)));
  if (Math.abs(mu - mu0) < 1e-9) return A * gu * (tu / (4 * mu)) * Math.exp(-tu / mu);
  return A * gu * (mu0 / (4 * Math.abs(mu - mu0))) * Math.abs(Math.exp(-tu / mu) - Math.exp(-tu / mu0));
}

function gridPos(g: number[], x: number): [number, number] {
  const n = g.length;
  if (n < 2 || x <= g[0]) return [0, 0];
  if (x >= g[n - 1]) return [n - 2, 1];
  let j = 0;
  while (j < n - 2 && g[j + 1] <= x) j++;
  return [j, (x - g[j]) / (g[j + 1] - g[j])];
}

/** W_c = ϖP (X, Y, Z, S) at radius r (km), phase α and effective elevation Beff (degrees). */
export function ringW(m: RingReflectance, r: number, alphaDeg: number, beffDeg: number): XYZS {
  const [pj, pt] = gridPos(m.phaseDeg, alphaDeg);
  const [ej, et] = gridPos(m.elevationEffDeg, beffDeg);
  const nP = m.phaseDeg.length;
  const tab = (k: number): XYZS => {
    const T = m.regions[k].amplitudeXYZS;
    const p1 = Math.min(pj + 1, nP - 1), e1 = Math.min(ej + 1, m.elevationEffDeg.length - 1);
    return [0, 1, 2, 3].map((c) =>
      (1 - et) * ((1 - pt) * T[ej][pj][c] + pt * T[ej][p1][c]) + et * ((1 - pt) * T[e1][pj][c] + pt * T[e1][p1][c])) as XYZS;
  };
  const R = m.regions;
  if (r <= R[0].radiusKm[0]) return tab(0);
  for (let k = 0; k < R.length; k++) {
    if (r <= R[k].radiusKm[1]) {
      if (r >= R[k].radiusKm[0] || k === 0) return tab(k);
      const t = (r - R[k - 1].radiusKm[1]) / (R[k].radiusKm[0] - R[k - 1].radiusKm[1]);
      const a = tab(k - 1), b = tab(k);
      return [0, 1, 2, 3].map((c) => a[c] + t * (b[c] - a[c])) as XYZS;
    }
  }
  return tab(R.length - 1);
}

/** Effective elevation Beff (degrees): sin Beff = 2μμ0/(μ + μ0). */
export function effectiveElevationDeg(mu: number, mu0: number): number {
  return mu + mu0 > 0 ? (Math.asin(Math.min(1, (2 * mu * mu0) / (mu + mu0))) * 180) / Math.PI : 0;
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
  /** Solar illuminance at the rings / π (radiance per unit I/F), XYZS, times the resolved fraction. */
  esun: XYZS;
  sunRadiusKm: number;
  /** Planet world → unit-sphere matrix (row-major), for the planet's shadow on the rings. */
  M: M3;
  label: Label;
  /** Centre, camera-relative km (float64), for bodies' ring shadows and transmission. */
  pos: V3;
  /** Inner and outer radius of the drawn system (km): the classic profile's, or the components' bounds. */
  rIn: number;
  rOut: number;
  /** Ring components (ringComponents.ts) with this frame's records, or null for the classic profile. */
  cmp: { packed: PackedComponents; records: Float32Array<ArrayBuffer>; poleSense: number } | null;
}

export interface RingFrame {
  /** Drawn ring system (resolved fraction > 0), or null. */
  draw: RingPrep | null;
  /** Illuminance at the observer of the unresolved fraction of the rings' reflected light (XYZS), or null. */
  pointE: XYZS | null;
  warnings: string[];
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function hitsUnitSphere(M: M3, X: V3, d: V3): boolean {
  const p: V3 = [M[0] * X[0] + M[1] * X[1] + M[2] * X[2], M[3] * X[0] + M[4] * X[1] + M[5] * X[2], M[6] * X[0] + M[7] * X[1] + M[8] * X[2]];
  const q: V3 = [M[0] * d[0] + M[1] * d[1] + M[2] * d[2], M[3] * d[0] + M[4] * d[1] + M[5] * d[2], M[6] * d[0] + M[7] * d[1] + M[8] * d[2]];
  const a = dot(q, q), b = dot(p, q), c = dot(p, p) - 1;
  if (c <= 0) return true;
  if (b >= 0) return false;
  return b * b - a * c > 0;
}

/**
 * Illuminance at a distant observer of a ring system's reflected light (XYZS): the model integrated over
 * the ring plane, minus what the planet hides (occultation) and shadows. `toObs` is the unit direction
 * from the planet to the observer, D its distance (km); `esun` the solar illuminance/π at the rings.
 */
export function ringIlluminance(p: RingProfile, normal: V3, toObs: V3, D: number, sunDir: V3, esun: XYZS, M: M3, nr = 200, nphi = 48): XYZS | null {
  const m = p.model;
  if (!m) return null;
  const vN = dot(toObs, normal), sN = dot(sunDir, normal);
  const mu = Math.abs(vN), mu0 = Math.abs(sN);
  const alphaDeg = (Math.acos(Math.max(-1, Math.min(1, dot(toObs, sunDir)))) * 180) / Math.PI;
  if (alphaDeg < m.minPhaseDeg || alphaDeg > m.maxPhaseDeg) return null;
  const E: XYZS = [0, 0, 0, 0];
  if (!(mu > 0) || !(mu0 > 0)) return E;
  const lit = vN * sN > 0;
  const beff = effectiveElevationDeg(mu, mu0);
  const h: V3 = Math.abs(normal[0]) < 0.6 ? [1, 0, 0] : [0, 1, 0];
  const u1 = normalize([normal[1] * h[2] - normal[2] * h[1], normal[2] * h[0] - normal[0] * h[2], normal[0] * h[1] - normal[1] * h[0]]);
  const u2: V3 = [normal[1] * u1[2] - normal[2] * u1[1], normal[2] * u1[0] - normal[0] * u1[2], normal[0] * u1[1] - normal[1] * u1[0]];
  const dr = (p.rMax - p.rMin) / nr;
  for (let i = 0; i < nr; i++) {
    const ra = p.rMin + i * dr, rb = ra + dr, rc = ra + 0.5 * dr;
    const f = ringAverage(p, ra, rb);
    const radial = ringRadial(f, mu, mu0, lit);
    if (!(radial > 0)) continue;
    let vis = 0;
    for (let j = 0; j < nphi; j++) {
      const ph = ((j + 0.5) / nphi) * 2 * Math.PI;
      const X: V3 = [0, 1, 2].map((k) => rc * (Math.cos(ph) * u1[k] + Math.sin(ph) * u2[k])) as V3;
      if (!hitsUnitSphere(M, X, toObs) && !hitsUnitSphere(M, X, sunDir)) vis++;
    }
    const dOmega = (Math.PI * (rb * rb - ra * ra) * mu * (vis / nphi)) / (D * D);
    const W = ringW(m, rc, alphaDeg, beff);
    for (let c = 0; c < 4; c++) E[c] += W[c] * radial * esun[c] * dOmega;
  }
  return E;
}

const pointCache = new WeakMap<RingProfile, Map<string, XYZS | null>>();

const EMPTY_RINGS: SceneRings = { normal: [0, 0, 1], opticalDepth: [], reflectance: null, worstLabel: 'unknown' };

/**
 * Per-frame preparation of a body's ring system: the resolved part to draw (faded in between 1 and 2
 * pixels of ring diameter) and the light of the unresolved part, which joins the planet's point source.
 * A system with components (Jupiter, Uranus, Neptune; ringComponents.ts) is drawn from them; their unresolved
 * light is not added to the planet's point (it is below 0.1 % of the planet's for all three).
 */
export function prepareRings(b: SceneBody, sunIrradianceXYZS_1AU: XYZS | null, sunRadiusKm: number, pixelAngle: number): RingFrame {
  const out: RingFrame = { draw: null, pointE: null, warnings: [] };
  const r = b.rings;
  const comps = r?.components ?? null;
  if (!r || !b.radii || (!comps && !r.opticalDepth.some((p) => p.radiusKm.length >= 2))) return out;
  const prof = ringProfile(comps ? EMPTY_RINGS : r);
  const packed = comps ? packComponents(comps) : null;
  const rIn = packed ? packed.rMin : prof.rMin;
  const rOut = packed ? packed.rMax : prof.rMax;
  const D = len(b.pos);
  if (!(D > 0)) return out;
  const fRes = smooth(1, 2, (2 * Math.asin(Math.min(1, rOut / D))) / pixelAngle);
  const planet = prepareBody(b.pos, b.radii, (b.orient as M3 | null) ?? null);
  const sunLen = len(b.toSun);
  const sunDir = normalize(b.toSun);
  const dAU = sunLen / AU_KM;
  const esun: XYZS = sunIrradianceXYZS_1AU ? (sunIrradianceXYZS_1AU.map((v) => v / (dAU * dAU) / Math.PI) as XYZS) : [0, 0, 0, 0];
  const normal = normalize(r.normal);
  const toObs = normalize([-b.pos[0], -b.pos[1], -b.pos[2]]);
  const m = r.reflectance;
  const alphaDeg = (Math.acos(Math.max(-1, Math.min(1, dot(toObs, sunDir)))) * 180) / Math.PI;
  if (comps) {
    const dark = comps.components.filter((c) => !c.layer && !c.thin && c.profile.opticalDepthKnown).map((c) => c.name);
    if (dark.length) out.warnings.push(`${b.name} rings: reflectance not measured for ${dark.join(', ')} → absorbs and casts shadows only, hatched as not measured where its mean optical depth in a pixel exceeds 0.001`);
    const outside = Object.values(comps.phaseFunctions).filter((t) => !phaseValue(t, alphaDeg)).map((t) => t.name);
    if (outside.length) out.warnings.push(`${b.name} rings: phase angle ${alphaDeg.toFixed(2)}° outside the measured range of ${outside.join('; ')} → that light not measured (hatched)`);
  } else if (!m) out.warnings.push(`${b.name} rings: reflectance not measured → rings absorb and cast shadows only; their material is hatched as not measured`);
  else if (alphaDeg < m.minPhaseDeg || alphaDeg > m.maxPhaseDeg) {
    out.warnings.push(`${b.name} rings: phase angle ${alphaDeg.toFixed(2)}° outside the reflectance model's ${m.minPhaseDeg}–${m.maxPhaseDeg}° → ring brightness not measured (hatched)`);
  } else {
    const beff = effectiveElevationDeg(Math.abs(dot(toObs, normal)), Math.abs(dot(sunDir, normal)));
    const e = m.elevationEffDeg;
    if (beff < e[0] || beff > e[e.length - 1]) {
      out.warnings.push(`${b.name} rings: effective elevation ${beff.toFixed(2)}° outside the calibrated ${e[0]}–${e[e.length - 1]}° → particle term held at the table edge (estimated)`);
    }
  }
  if (fRes < 1 && m && !comps && sunIrradianceXYZS_1AU) {
    // Per unit esun and D = 1 (E scales with both), cached on the quantized directions and the planet's
    // shape: an unresolved ring system otherwise costs ~10⁴ ray tests every frame.
    const q = (v: number[]) => v.map((x) => x.toFixed(4)).join(',');
    const key = `${q(normal)}|${q(toObs)}|${q(sunDir)}|${q(b.radii)}|${q(planet.M as number[])}`;
    let unit = pointCache.get(prof)?.get(key);
    if (unit === undefined) {
      unit = ringIlluminance(prof, normal, toObs, 1, sunDir, [1, 1, 1, 1], planet.M);
      let c = pointCache.get(prof);
      if (!c) pointCache.set(prof, (c = new Map()));
      if (c.size > 256) c.clear();
      c.set(key, unit);
    }
    if (unit) out.pointE = unit.map((v, k) => (v * esun[k] * (1 - fRes)) / (D * D)) as XYZS;
  }
  if (fRes > 0) {
    const ext = packed ? Math.hypot(rOut, packed.zMax) : rOut;
    const frame = prepareBody(b.pos, [ext, ext, ext], null, 3 * pixelAngle);
    out.draw = {
      bodyId: b.id, near: frame.near, n: frame.n, D, e1: frame.e1, e2: frame.e2, beta: frame.beta,
      // D·e1, D·e2 in km (the tangent-plane offsets of the FAR parametrisation, O(ring radius)).
      E1: [frame.e1[0] * D, frame.e1[1] * D, frame.e1[2] * D],
      E2: [frame.e2[0] * D, frame.e2[1] * D, frame.e2[2] * D],
      o: [-b.pos[0], -b.pos[1], -b.pos[2]],
      normal, profile: prof, sunDir, sunDistKm: sunLen, esun: esun.map((v) => v * fRes) as XYZS,
      sunRadiusKm, M: planet.M, label: r.worstLabel, pos: b.pos, rIn, rOut,
      cmp: packed && comps ? { packed, records: packComponentRecords(packed, r.et ?? comps.epochEt), poleSense: comps.poleSense ?? 1 } : null,
    };
  }
  return out;
}
