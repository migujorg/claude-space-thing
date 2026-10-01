// Ring components (rings.json `components`, kind 'ring-components-v1'; docs/architecture.md §6 "Ring components",
// docs/rendering-m2.md §6b): the rings of Jupiter, Uranus and Neptune drawn one by one. This module is the float64
// reference of the model (mirrored in shaders-m2.ts RING_COMMON) and packs it for the GPU.
//
// Geometry. Each component is a band between two edges, each a precessing keplerian ellipse with normal modes:
//   r(λ, t) = a(1 − e²)/(1 + e cos(λ − ϖ0 − ϖ̇t)) − Σ A_m cos(m(λ − Ω_P t − δ_m))   (m = 0: −A_0 cos(Ω_P t + δ_0))
// with λ the longitude in the ring plane from the ascending node of the planet's equator on the ICRF equator, in
// the direction of orbital motion (about the angular-momentum pole, poleSense × the IAU pole), t in days from the
// model epoch. The band lies in the plane z = aSinI·sin(λ − Ω0 − Ω̇t). Across it, u = (r − r_in)/(r_out − r_in).
//
// Optical depth: τ(u, λ) = profile(u) · s, s = (widthRef/W(λ) if widthScaling) · arcs(λ − λ0 − n t). The profile is
// piecewise constant over bins of width uStep centred on uStart + i·uStep.
//
// Light per CIE channel c, μ = |sin B|, μ0 = |sin B′|, footprint [r ± fw/2] mapped to [u0, u1]:
//   G(x) = ∫ (1 − e^{−profile(u)·x}) du over the footprint (tabulated at x_j = X0·2^{j/2}, log-linear between nodes)
//   lit   I/F = L_c(α) · μ0/(4(μ+μ0)) · (W/fw) · G(s(1/μ + 1/μ0))
//   unlit I/F = L_c(α) · μ0/(4|μ−μ0|) · (W/fw) · |G(s/μ) − G(s/μ0)|
//   thin  I/F = D_c(α) · s · (W/fw) · T/(4μ),   T = ∫ profile du
//   transmission of a ray at μ_r through the band: 1 − (W/fw)·G(s/μ_r)  (only when the profile is an optical depth)
// These are the exact footprint means of the classical single-scattering formulas (architecture §6) for a band of
// piecewise-constant τ; only the interpolation of G between its nodes is approximate.

import type { RingComponent, RingComponentEdge, RingComponentModel, RingPhaseTable } from '../data/schema';
import type { XYZS } from './photometry';

export const G_NODES = 32;
export const G_X0 = 1 / 8;
export const G_STEP = 0.5;               // log2 spacing of the nodes
/** vec4 per bin edge of a component's cumulative table: [T, G∞, 0, 0] + G_NODES/4 vec4 of G. */
export const CMP_EDGE_VEC4 = 1 + G_NODES / 4;
/** vec4 per component in the per-frame record block. */
export const CMP_RECORD_VEC4 = 20;
export const CMP_MAX_MODES = 11;
export const CMP_MAX = 32;
/** A band narrower than this (independently fitted edges can nearly cross) is drawn this wide (km). */
export const MIN_WIDTH_KM = 0.5;
export const DAY_S = 86400;
const DEG = Math.PI / 180;

export function gNode(j: number): number {
  return G_X0 * 2 ** (j * G_STEP);
}

/** Argument of a normal mode: m(λ − Ω_P t − δ); for m = 0, −(Ω_P t + δ). */
export function modeArgument(m: RingComponentEdge['modes'][number], lam: number, tDays: number): number {
  const ph = (m.patternSpeedDegPerDay * tDays + m.phaseDeg) * DEG;
  return m.m === 0 ? -ph : m.m * (lam - ph);
}

/** Radius of an edge at longitude λ (radians), t days after the epoch. */
export function edgeRadius(e: RingComponentEdge, lam: number, tDays: number): number {
  const ecc = e.ae / e.a;
  const f = lam - (e.varpi0Deg + e.varpiDotDegPerDay * tDays) * DEG;
  let r = (e.a * (1 - ecc * ecc)) / (1 + ecc * Math.cos(f));
  for (const m of e.modes) r -= m.amplitudeKm * Math.cos(modeArgument(m, lam, tDays));
  return r;
}

/** Height of the band's plane above the planet's equator at λ (the outer edge's a·sin i and node). */
export function bandHeight(c: RingComponent, lam: number, tDays: number): number {
  const e = c.outer;
  if (!e.aSinI) return 0;
  return e.aSinI * Math.sin(lam - (e.node0Deg + e.nodeDotDegPerDay * tDays) * DEG);
}

export interface Band { rIn: number; rOut: number; W: number; s: number }

/** Edges, width and τ scale of a component at λ (radians), et (TDB s). */
export function bandAt(model: RingComponentModel, c: RingComponent, lam: number, et: number): Band {
  const t = (et - model.epochEt) / DAY_S;
  let rIn = edgeRadius(c.inner, lam, t), rOut = edgeRadius(c.outer, lam, t);
  if (rOut - rIn < MIN_WIDTH_KM) {
    const mid = 0.5 * (rIn + rOut);
    rIn = mid - 0.5 * MIN_WIDTH_KM;
    rOut = mid + 0.5 * MIN_WIDTH_KM;
  }
  const W = rOut - rIn;
  let s = c.profile.widthScaling ? c.profile.widthRefKm / W : 1;
  if (c.arcs) s *= arcFactor(c, lam, et);
  return { rIn, rOut, W, s };
}

/** The arcs' longitudinal factor at λ (radians), et; 0 outside the tabulated range. */
export function arcFactor(c: RingComponent, lam: number, et: number): number {
  const a = c.arcs!;
  const lead = a.lambda0Deg + (a.meanMotionDegPerDay * (et - a.epochEt)) / DAY_S;
  let phi = (lam / DEG - lead - a.phiStartDeg) % 360;
  if (phi < 0) phi += 360;
  const x = phi / a.phiStepDeg;
  const n = a.factor.length;
  if (!(x >= 0 && x <= n - 1)) return 0;
  const i = Math.min(Math.floor(x), n - 2);
  return a.factor[i] + (x - i) * (a.factor[i + 1] - a.factor[i]);
}

/** Longitude λ (radians) of a ring-plane point X (ICRF, planet-centred) about the angular-momentum pole P. */
export function ringLongitude(X: [number, number, number], P: [number, number, number]): number {
  const nx = -P[1], ny = P[0];
  const nl = Math.hypot(nx, ny);
  const x = [nx / nl, ny / nl, 0];
  const y = [P[1] * x[2] - P[2] * x[1], P[2] * x[0] - P[0] * x[2], P[0] * x[1] - P[1] * x[0]];
  const lx = X[0] * x[0] + X[1] * x[1] + X[2] * x[2];
  const ly = X[0] * y[0] + X[1] * y[1] + X[2] * y[2];
  const l = Math.atan2(ly, lx);
  return l < 0 ? l + 2 * Math.PI : l;
}

// ── phase tables ───────────────────────────────────────────────────────────────────────────────
/** Value (XYZS) of a phase table at α (degrees), log-linear in α; null outside its domain. */
export function phaseValue(t: RingPhaseTable, alphaDeg: number): XYZS | null {
  if (!(alphaDeg >= t.minPhaseDeg && alphaDeg <= t.maxPhaseDeg)) return null;
  const g = t.phaseDeg, n = g.length;
  let j = 0;
  if (alphaDeg >= g[n - 1]) j = n - 2;
  else while (j < n - 2 && g[j + 1] <= alphaDeg) j++;
  const f = Math.min(Math.max((alphaDeg - g[j]) / (g[j + 1] - g[j]), 0), 1);
  const out = [0, 0, 0, 0] as XYZS;
  for (let c = 0; c < 4; c++) {
    const a = Math.max(t.valuesXYZS[j][c], 1e-30), b = Math.max(t.valuesXYZS[j + 1][c], 1e-30);
    out[c] = Math.exp(Math.log(a) + f * (Math.log(b) - Math.log(a)));
  }
  return out;
}

// ── cumulative tables ──────────────────────────────────────────────────────────────────────────
export interface ComponentTable {
  bins: number;
  /** (bins+1) edges × CMP_EDGE_VEC4 × 4 floats, float64. */
  cum: Float64Array;
  /** u of edge 0 and the bin width. */
  u0: number;
  du: number;
}

export function componentTable(c: RingComponent): ComponentTable {
  const v = c.profile.values;
  const bins = v.length;
  const S = CMP_EDGE_VEC4 * 4;
  const cum = new Float64Array((bins + 1) * S);
  const acc = new Float64Array(S);
  const du = c.profile.uStep;
  for (let i = 0; i < bins; i++) {
    const tau = Math.max(0, v[i]);
    acc[0] += tau * du;
    acc[1] += tau > 0 ? du : 0;
    for (let j = 0; j < G_NODES; j++) acc[4 + j] += (1 - Math.exp(-tau * gNode(j))) * du;
    cum.set(acc, (i + 1) * S);
  }
  return { bins, cum, u0: c.profile.uStart - 0.5 * du, du };
}

/** ∫ of cumulative slot k over [ua, ub] (u units), from per-bin increments (exact for piecewise-constant data). */
export function tableSegment(t: ComponentTable, k: number, ua: number, ub: number): number {
  const S = CMP_EDGE_VEC4 * 4;
  const x0 = Math.min(Math.max((ua - t.u0) / t.du, 0), t.bins), x1 = Math.min(Math.max((ub - t.u0) / t.du, 0), t.bins);
  if (!(x1 > x0)) return 0;
  const C = (j: number) => t.cum[j * S + k];
  const j0 = Math.min(Math.floor(x0), t.bins - 1), j1 = Math.min(Math.floor(x1), t.bins - 1);
  const d0 = (C(j0 + 1) - C(j0)) / t.du;
  if (j0 === j1) return (x1 - x0) * t.du * d0;
  const d1 = (C(j1 + 1) - C(j1)) / t.du;
  return (j0 + 1 - x0) * t.du * d0 + (C(j1) - C(j0 + 1)) + (x1 - j1) * t.du * d1;
}

/** G(x) over [ua, ub] from the nodes (log-linear in x), with its slope dG/dx. */
export function gAt(t: ComponentTable, ua: number, ub: number, x: number): [number, number] {
  const node = (j: number) => tableSegment(t, 4 + j, ua, ub);
  if (x <= G_X0) {
    const g0 = node(0);
    return [(g0 * x) / G_X0, g0 / G_X0];
  }
  const j = Math.min(Math.floor(Math.log2(x / G_X0) / G_STEP), G_NODES - 2);
  const xa = gNode(j), xb = gNode(j + 1);
  const Fa = node(j), Fb = node(j + 1);
  if (x > xb) {
    // Beyond the last node G tends to the covered fraction (G∞); approach it as G∞ − (G∞ − G_b)·xb/x.
    const ginf = tableSegment(t, 1, ua, ub);
    const v = ginf - (ginf - Fb) * (xb / x);
    return [v, ((ginf - Fb) * xb) / (x * x)];
  }
  if (Fa > 1e-30 && Fb > 1e-30) {
    const sl = (Math.log(Fb) - Math.log(Fa)) / (xb - xa);
    const v = Fa * Math.exp(sl * (x - xa));
    return [v, v * sl];
  }
  const f = (x - xa) / (xb - xa);
  return [Math.max(0, Fa + f * (Fb - Fa)), (Fb - Fa) / (xb - xa)];
}

/** Exact G(x) over [ua, ub] from the profile (reference for tests). */
export function gExact(c: RingComponent, ua: number, ub: number, x: number): number {
  const v = c.profile.values, du = c.profile.uStep, u0 = c.profile.uStart - 0.5 * du;
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    const a = Math.max(ua, u0 + i * du), b = Math.min(ub, u0 + (i + 1) * du);
    if (b > a) s += (1 - Math.exp(-Math.max(0, v[i]) * x)) * (b - a);
  }
  return s;
}

// ── light and extinction at one footprint (CPU reference of the shader) ────────────────────────
export interface ComponentLight {
  /** I/F per channel (footprint mean). */
  iof: XYZS;
  /** Mean τ over the footprint where reflectance is not known (no layer/thin, or α outside a table's domain). */
  tauUnknown: number;
  /** Mean τ over the footprint (optical-depth components). */
  tau: number;
}

/**
 * Footprint-mean I/F of all sheet components at ring-plane radius r (km) and longitude λ (radians), footprint
 * width fw (km), for observer/Sun elevations μ, μ0 (|sin|), lit face or not, phase α (degrees).
 */
export function componentsIF(
  model: RingComponentModel, tables: ComponentTable[], r: number, lam: number, et: number, fw: number,
  mu: number, mu0: number, lit: boolean, alphaDeg: number,
): ComponentLight {
  const out: ComponentLight = { iof: [0, 0, 0, 0], tauUnknown: 0, tau: 0 };
  model.components.forEach((c, k) => {
    if (c.kind !== 'sheet') return;
    const b = bandAt(model, c, lam, et);
    const ua = (r - 0.5 * fw - b.rIn) / b.W, ub = (r + 0.5 * fw - b.rIn) / b.W;
    const t = tables[k];
    const T = tableSegment(t, 0, ua, ub);
    if (!(T > 0)) return;
    const frac = b.W / fw;
    const tauMean = frac * b.s * T;
    const L = c.layer ? phaseValue(model.phaseFunctions[c.layer.phaseFunction], alphaDeg) : null;
    const D = c.thin ? phaseValue(model.phaseFunctions[c.thin.phaseFunction], alphaDeg) : null;
    if (c.profile.opticalDepthKnown) out.tau += tauMean;
    if ((c.layer && !L) || (c.thin && !D) || (!c.layer && !c.thin)) out.tauUnknown += tauMean;
    if (!(mu > 0) || !(mu0 > 0)) return;
    if (L && c.layer) {
      let geo: number;
      if (lit) geo = (mu0 / (4 * (mu + mu0))) * gAt(t, ua, ub, b.s * (1 / mu + 1 / mu0))[0];
      else {
        const x1 = b.s / mu, x0 = b.s / mu0;
        if (Math.abs(x1 - x0) < 1e-6 * x1) geo = (1 / (4 * mu)) * b.s * gAt(t, ua, ub, x1)[1];
        else geo = (mu0 / (4 * Math.abs(mu - mu0))) * Math.abs(gAt(t, ua, ub, x1)[0] - gAt(t, ua, ub, x0)[0]);
      }
      for (let ch = 0; ch < 4; ch++) out.iof[ch] += c.layer.scale * L[ch] * frac * geo;
    }
    if (D && c.thin) for (let ch = 0; ch < 4; ch++) out.iof[ch] += c.thin.scale * D[ch] * frac * b.s * T / (4 * mu);
  });
  return out;
}

/** Transmission of a ray crossing the ring plane at radius r, λ at elevation μ_r, footprint fw (km). */
export function componentsTransmission(
  model: RingComponentModel, tables: ComponentTable[], r: number, lam: number, et: number, fw: number, muRay: number,
): number {
  let T = 1;
  model.components.forEach((c, k) => {
    if (c.kind !== 'sheet' || !c.profile.opticalDepthKnown) return;
    const b = bandAt(model, c, lam, et);
    const ua = (r - 0.5 * fw - b.rIn) / b.W, ub = (r + 0.5 * fw - b.rIn) / b.W;
    if (!(tableSegment(tables[k], 1, ua, ub) > 0)) return;
    T *= Math.max(0, 1 - (b.W / fw) * gAt(tables[k], ua, ub, b.s / Math.max(muRay, 1e-6))[0]);
  });
  return T;
}

/** Radial extent of a component over all longitudes and times (bounds for culling), km. */
export function componentBounds(c: RingComponent): [number, number] {
  const ext = (e: RingComponentEdge, sgn: number) => e.a + sgn * (e.ae + e.modes.reduce((s, m) => s + Math.abs(m.amplitudeKm), 0));
  const lo = ext(c.inner, -1), hi = ext(c.outer, 1);
  const pad = MIN_WIDTH_KM;
  const W = hi - lo;
  const u0 = c.profile.uStart - 0.5 * c.profile.uStep, u1 = c.profile.uStart + (c.profile.values.length - 0.5) * c.profile.uStep;
  // The profile extends beyond the edges (u < 0, u > 1) by up to |u0|·W_max, (u1 − 1)·W_max.
  const wMax = Math.max(W, c.outer.a - c.inner.a + c.outer.ae + c.inner.ae + 2 * pad);
  return [lo + Math.min(0, u0) * wMax - pad, hi + Math.max(0, u1 - 1) * wMax + pad];
}

// ── GPU packing ────────────────────────────────────────────────────────────────────────────────
// Per ring system, a block of vec4s in the ring-profile storage buffer, addressed from its base:
//   [0, K·CMP_RECORD_VEC4)  per-frame records (rewritten every frame: precession and mode phases at the frame's et)
//   then static data: phase tables ([n, min, max, 0], grid 4 per vec4, n XYZS rows), the components' cumulative
//   tables ((bins+1)·CMP_EDGE_VEC4 each) and arc tables (4 per vec4).
// Record k (vec4 index k·CMP_RECORD_VEC4 + j):
//   0: inner a, e, ϖ(t) [rad], number of inner modes      1: outer a, e, ϖ(t), number of outer modes
//   2: a·sin i, node(t) [rad], u of the first bin edge, bin width in u
//   3: bins, cumulative-table offset, widthRefKm, flags (1 width scaling, 2 optical depth known, 4 arcs, 8 torus)
//   4: layer table offset (−1: none), layer scale, thin table offset (−1: none), thin scale
//   5: arc origin λ0 + n t + φStart [rad], arc step [rad], arc samples, arc table offset
//   6: radial bounds rLo, rHi (km), vertical law (0 none, 1 inclined orbits, 2 broken power law), 0
//   7: vertical parameters (inclined: r0, z0, cap; broken: zBreak, zMax, inner slope, outer slope)
//   9…: modes (m, A, (Ω_P t + δ) [rad], 0 inner / 1 outer)

export interface PackedComponents {
  model: RingComponentModel;
  tables: ComponentTable[];
  count: number;
  /** Static part (vec4-aligned floats), to be placed right after the records. */
  staticData: Float32Array;
  /** Offsets (vec4, relative to the block base) of each component's cumulative and arc tables. */
  cumRel: number[];
  arcRel: number[];
  phaseRel: Record<string, number>;
  /** Total block size in vec4. */
  sizeVec4: number;
  rMin: number;
  rMax: number;
  /** Largest half-thickness of a torus component (km), 0 without tori. */
  zMax: number;
}

const TAU2 = 2 * Math.PI;
const wrap = (x: number) => ((x % TAU2) + TAU2) % TAU2;
const packCache = new WeakMap<RingComponentModel, PackedComponents>();

/** Static packing of a model (cached on the model object). */
export function packComponents(model: RingComponentModel): PackedComponents {
  const hit = packCache.get(model);
  if (hit) return hit;
  const comps = model.components.slice(0, CMP_MAX);
  const tables = comps.map(componentTable);
  const K = comps.length;
  const parts: number[][] = [];
  let off = K * CMP_RECORD_VEC4;
  const push = (v: number[]) => {
    const at = off;
    const pad = Math.ceil(v.length / 4) * 4;
    parts.push(v.length === pad ? v : [...v, ...new Array(pad - v.length).fill(0)]);
    off += pad / 4;
    return at;
  };
  const phaseRel: Record<string, number> = {};
  for (const [id, t] of Object.entries(model.phaseFunctions)) {
    const n = t.phaseDeg.length;
    const g = [...t.phaseDeg, ...new Array(Math.ceil(n / 4) * 4 - n).fill(t.phaseDeg[n - 1])];
    phaseRel[id] = push([n, t.minPhaseDeg, t.maxPhaseDeg, 0, ...g, ...t.valuesXYZS.flatMap((row) => row.slice(0, 4))]);
  }
  const cumRel = tables.map((t) => push(Array.from(t.cum)));
  const arcRel = comps.map((c) => (c.arcs ? push(c.arcs.factor) : -1));
  const staticData = new Float32Array(parts.flat());
  let rMin = Infinity, rMax = -Infinity, zMax = 0;
  for (const c of comps) {
    const [lo, hi] = componentBounds(c);
    rMin = Math.min(rMin, lo);
    rMax = Math.max(rMax, hi);
    if (c.kind === 'torus' && c.vertical) zMax = Math.max(zMax, torusHalfThickness(c, hi));
  }
  const p: PackedComponents = { model, tables, count: K, staticData, cumRel, arcRel, phaseRel, sizeVec4: off, rMin, rMax, zMax };
  packCache.set(model, p);
  return p;
}

/** Half-thickness (km) of a torus component at radius r. */
export function torusHalfThickness(c: RingComponent, r: number): number {
  const v = c.vertical;
  if (!v) return 0;
  if (v.law === 'inclined-orbits') {
    const z = (v.z0Km * r) / v.r0Km;
    return v.zMaxCapKm ? Math.min(z, v.zMaxCapKm) : z;
  }
  return v.zMaxKm;
}

/** Per-frame records (K·CMP_RECORD_VEC4 vec4) at `et` (TDB seconds). */
export function packComponentRecords(p: PackedComponents, et: number): Float32Array<ArrayBuffer> {
  const m = p.model;
  const out = new Float32Array(p.count * CMP_RECORD_VEC4 * 4);
  const t = (et - m.epochEt) / DAY_S;
  m.components.slice(0, p.count).forEach((c, k) => {
    const o = k * CMP_RECORD_VEC4 * 4;
    const varpi = (e: RingComponentEdge) => wrap((e.varpi0Deg + e.varpiDotDegPerDay * t) * DEG);
    const nIn = Math.min(c.inner.modes.length, CMP_MAX_MODES);
    const modes = [...c.inner.modes.slice(0, nIn).map((x) => [x, 0] as const),
      ...c.outer.modes.slice(0, CMP_MAX_MODES - nIn).map((x) => [x, 1] as const)];
    out.set([c.inner.a, c.inner.ae / c.inner.a, varpi(c.inner), nIn], o);
    out.set([c.outer.a, c.outer.ae / c.outer.a, varpi(c.outer), modes.length - nIn], o + 4);
    const tb = p.tables[k];
    out.set([c.outer.aSinI, wrap((c.outer.node0Deg + c.outer.nodeDotDegPerDay * t) * DEG), tb.u0, tb.du], o + 8);
    const flags = (c.profile.widthScaling ? 1 : 0) | (c.profile.opticalDepthKnown ? 2 : 0) | (c.arcs ? 4 : 0) | (c.kind === 'torus' ? 8 : 0);
    out.set([tb.bins, p.cumRel[k], c.profile.widthRefKm, flags], o + 12);
    out.set([c.layer ? p.phaseRel[c.layer.phaseFunction] ?? -1 : -1, c.layer?.scale ?? 0,
      c.thin ? p.phaseRel[c.thin.phaseFunction] ?? -1 : -1, c.thin?.scale ?? 0], o + 16);
    if (c.arcs) {
      const a = c.arcs;
      const lead = a.lambda0Deg + (a.meanMotionDegPerDay * (et - a.epochEt)) / DAY_S + a.phiStartDeg;
      out.set([wrap(lead * DEG), a.phiStepDeg * DEG, a.factor.length, p.arcRel[k]], o + 20);
    }
    const [lo, hi] = componentBounds(c);
    const v = c.vertical;
    out.set([lo, hi, !v ? 0 : v.law === 'inclined-orbits' ? 1 : 2, 0], o + 24);
    if (v?.law === 'inclined-orbits') out.set([v.r0Km, v.z0Km, v.zMaxCapKm ?? 0, 0], o + 28);
    else if (v?.law === 'broken-power-law') out.set([v.zBreakKm, v.zMaxKm, v.innerSlope, v.outerSlope], o + 28);
    modes.forEach(([x, edge], j) => {
      out.set([x.m, x.amplitudeKm, wrap((x.patternSpeedDegPerDay * t + x.phaseDeg) * DEG), edge], o + (9 + j) * 4);
    });
  });
  return out;
}
