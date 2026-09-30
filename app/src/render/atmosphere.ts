// Planetary atmospheres: precomputed transmittance, multiple-scattering and sky-irradiance tables, computed
// spectrally and folded into XYZS (docs/rendering-earth.md §4). The method follows Hillaire (2020), "A
// Scalable and Production Ready Sky and Atmosphere Rendering Technique" (EGSR, Comput. Graph. Forum 39(4)).
// The table parameterisations, transmittance between two points and sun visibility at the horizon follow
// Bruneton (2017), "Precomputed Atmospheric Scattering: a New Implementation" (reference code of Bruneton &
// Neyret 2008). Alternatives: Bruneton & Neyret's full 4D scattering tables (exact multiple scattering,
// larger), or brute-force per-pixel multiple scattering (too slow). Hillaire's multiple-scattering
// approximation assumes isotropic phase for scattering orders ≥ 2, and the same illumination at every
// point near the one being lit; he reports errors of a few percent against path tracing for Earth.
//
// Everything here is spectral, per wavelength bin k, and per unit solar irradiance. A caller folds any
// result r_k into channel c as Σ_k w[c][k]·r_k, using the sunlight-weighted observer weights of the bins.
//
// Tables map a unit-range coordinate x ∈ [0, 1] to texel centres (x = i/(n − 1)), as Bruneton's
// GetTextureCoordFromUnitRange does, so the table edges are sampled exactly.

/** One constituent's optical properties on the model's altitude grid (per km), per wavelength bin. */
export interface AtmosphereSpecies {
  name: string;
  /** Scattering coefficient [altitude][bin], km⁻¹. */
  scattering: number[][];
  /** Absorption coefficient [altitude][bin], km⁻¹. */
  absorption: number[][];
  /**
   * Phase function: Rayleigh with a depolarisation ratio per bin; a particle phase function tabulated per bin
   * at PHASE_ANGLES (per steradian, ∫P dΩ = 1); or none (pure absorber).
   */
  phase: { kind: 'rayleigh'; depolarization: number[] } | { kind: 'particle'; table: number[][] } | { kind: 'none' };
}

/** Scattering angles (degrees) of tabulated particle phase functions: 0°, 1°, …, 180°. */
export const PHASE_N = 181;
export const phaseAngleDeg = (i: number) => i;

/** Particle phase function of bin k at scattering-angle cosine ν (linear in angle). */
export function particlePhase(table: number[][], nu: number, k: number): number {
  const a = (Math.acos(clamp(nu, -1, 1)) * 180) / Math.PI;
  const i = Math.min(Math.floor(a), PHASE_N - 2);
  const f = a - i;
  return table[k][i] * (1 - f) + table[k][i + 1] * f;
}

/** A spherically symmetric atmosphere as the renderer uses it (adapted from atmospheres.json). */
export interface AtmosphereModel {
  /** Radius of the bottom (surface) and of the top of the atmosphere, km. */
  bottomKm: number;
  topKm: number;
  /** Altitudes above the bottom of the profile samples, km (ascending, first 0). */
  altitudesKm: number[];
  /** Bin centres, nm (for reference). */
  wavelengthsNm: number[];
  /** Folding weights [channel X, Y, Z, S][bin], each row summing to 1. */
  weights: number[][];
  species: AtmosphereSpecies[];
  /** Mean reflectance of what lies below the atmosphere (surface and clouds), per bin, for the multiple-scattering table. */
  groundAlbedo: number[];
}

/** Table sizes (Hillaire 2020 uses 256×64 transmittance and 32×32 multiple scattering). */
export const T_W = 256, T_H = 64;
export const MS_N = 32;
export const IRR_W = 64, IRR_H = 16;
/** Altitude samples of the per-pixel profile table (quadratic in altitude: dense near the bottom). */
export const PROFILE_N = 256;

const clamp = (x: number, a: number, b: number) => Math.min(Math.max(x, a), b);
type V3 = [number, number, number];

/** Interpolated coefficient at altitude h (km above the bottom): linear between levels (atmospheres.json). */
export function coeffAt(model: AtmosphereModel, table: number[][], h: number, k: number): number {
  const a = model.altitudesKm;
  if (h <= a[0]) return table[0][k];
  const n = a.length;
  if (h >= a[n - 1]) return table[n - 1][k];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (a[m] <= h) lo = m; else hi = m; }
  const t = (h - a[lo]) / (a[hi] - a[lo]);
  return table[lo][k] + (table[hi][k] - table[lo][k]) * t;
}

/**
 * The model resampled on a fine quadratic altitude grid (h = H·x²) for fast lookups: per sample and bin,
 * extinction, total scattering, molecular (Rayleigh) and particle scattering. All particle species share one
 * phase function (particleTable): several are merged by column scattering (an approximation; every body
 * in atmospheres.json has at most one).
 */
export class ProfileGrid {
  readonly n: number;
  readonly K: number;
  readonly H: number;
  /** [sample][bin][ext, sca, sR, sA, g] */
  readonly v: Float64Array;
  constructor(readonly m: AtmosphereModel, n = 2048) {
    this.n = n;
    this.K = m.wavelengthsNm.length;
    this.H = m.topKm - m.bottomKm;
    this.v = new Float64Array(n * this.K * 5);
    for (let a = 0; a < n; a++) {
      const x = a / (n - 1);
      const h = this.H * x * x;
      for (let k = 0; k < this.K; k++) {
        let ext = 0, sc = 0, sR = 0, sA = 0;
        for (const s of m.species) {
          const b = coeffAt(m, s.scattering, h, k);
          ext += b + coeffAt(m, s.absorption, h, k);
          sc += b;
          if (s.phase.kind === 'rayleigh') sR += b;
          else if (s.phase.kind === 'particle') sA += b;
        }
        this.v.set([ext, sc, sR, sA, 0], (a * this.K + k) * 5);
      }
    }
  }
  /** Interpolated [ext, sca, sR, sA, g] of every bin at altitude h, written to out (length 5K). */
  at(h: number, out: Float64Array): Float64Array {
    const x = Math.sqrt(clamp(h / this.H, 0, 1)) * (this.n - 1);
    const i = Math.min(Math.floor(x), this.n - 2);
    const f = x - i;
    const o0 = i * this.K * 5, o1 = (i + 1) * this.K * 5;
    for (let q = 0; q < this.K * 5; q++) out[q] = this.v[o0 + q] * (1 - f) + this.v[o1 + q] * f;
    return out;
  }
}

// ── Ray geometry in the spherical shell (Bruneton 2017 §"Intersections") ───────────────────────────

export function distanceToTop(m: AtmosphereModel, r: number, mu: number): number {
  const d = r * r * (mu * mu - 1) + m.topKm * m.topKm;
  return Math.max(0, -r * mu + Math.sqrt(Math.max(d, 0)));
}
export function distanceToBottom(m: AtmosphereModel, r: number, mu: number): number {
  const d = r * r * (mu * mu - 1) + m.bottomKm * m.bottomKm;
  return Math.max(0, -r * mu - Math.sqrt(Math.max(d, 0)));
}
export function rayHitsGround(m: AtmosphereModel, r: number, mu: number): boolean {
  return mu < 0 && r * r * (mu * mu - 1) + m.bottomKm * m.bottomKm >= 0;
}

/** Transmittance table coordinates (Bruneton 2017 GetTransmittanceTextureUvFromRMu, unit range): [x_μ, x_r]. */
export function transmittanceUv(m: AtmosphereModel, r: number, mu: number): [number, number] {
  const H = Math.sqrt(m.topKm * m.topKm - m.bottomKm * m.bottomKm);
  const rho = Math.sqrt(Math.max(r * r - m.bottomKm * m.bottomKm, 0));
  const d = distanceToTop(m, r, mu);
  const dMin = m.topKm - r, dMax = rho + H;
  const xMu = dMax > dMin ? (d - dMin) / (dMax - dMin) : 0;
  return [clamp(xMu, 0, 1), clamp(rho / H, 0, 1)];
}
function rMuFromTransmittanceUv(m: AtmosphereModel, xMu: number, xR: number): [number, number] {
  const H = Math.sqrt(m.topKm * m.topKm - m.bottomKm * m.bottomKm);
  const rho = H * xR;
  const r = Math.sqrt(rho * rho + m.bottomKm * m.bottomKm);
  const dMin = m.topKm - r, dMax = rho + H;
  const d = dMin + xMu * (dMax - dMin);
  const mu = d === 0 ? 1 : clamp((H * H - rho * rho - d * d) / (2 * r * d), -1, 1);
  return [r, mu];
}

export interface AtmosphereTables {
  K: number;
  /** Transmittance to the top of the atmosphere [T_H (x_r)][T_W (x_μ)][K]. */
  transmittance: Float32Array;
  /** Multiple-scattering Ψ_ms per unit solar irradiance, sr⁻¹ [MS_N (h/H)][MS_N ((μs + 1)/2)][K]. */
  multiScattering: Float32Array;
  /** Sky irradiance on a horizontal surface per unit solar irradiance [IRR_H (h/H)][IRR_W ((μs + 1)/2)][K]. */
  skyIrradiance: Float32Array;
  /** Per-altitude profile for the per-pixel march [PROFILE_N (√(h/H))][K][σ_t, σ_s molecular, σ_s particle, 0]. */
  profile: Float32Array;
}

/** Bilinear lookup of all K bins of a [rows][cols][K] table at unit-range (x, y) into out. */
function lutK(t: Float32Array, cols: number, rows: number, K: number, x: number, y: number, out: Float64Array): Float64Array {
  const fx = clamp(x, 0, 1) * (cols - 1), fy = clamp(y, 0, 1) * (rows - 1);
  const x0 = Math.min(Math.floor(fx), cols - 2), y0 = Math.min(Math.floor(fy), rows - 2);
  const ax = fx - x0, ay = fy - y0;
  const o00 = (y0 * cols + x0) * K, o10 = o00 + K, o01 = o00 + cols * K, o11 = o01 + K;
  for (let k = 0; k < K; k++) {
    out[k] = (t[o00 + k] * (1 - ax) + t[o10 + k] * ax) * (1 - ay) + (t[o01 + k] * (1 - ax) + t[o11 + k] * ax) * ay;
  }
  return out;
}

/** Transmittance from radius r along μ to the top of the atmosphere, all bins (table lookup). */
export function transmittanceToTopK(m: AtmosphereModel, tab: AtmosphereTables, r: number, mu: number, out: Float64Array = new Float64Array(tab.K)): Float64Array {
  const [x, y] = transmittanceUv(m, r, mu);
  return lutK(tab.transmittance, T_W, T_H, tab.K, x, y, out);
}
export function transmittanceToTop(m: AtmosphereModel, tab: AtmosphereTables, r: number, mu: number, k: number): number {
  return transmittanceToTopK(m, tab, r, mu)[k];
}
/** Transmittance to the Sun (0 below the geometric horizon; the solar disk's size is not modelled here). */
function transmittanceToSunK(m: AtmosphereModel, tab: AtmosphereTables, r: number, muS: number, out: Float64Array): Float64Array {
  if (rayHitsGround(m, r, muS)) { out.fill(0); return out; }
  return transmittanceToTopK(m, tab, r, muS, out);
}

/** Rayleigh phase function with depolarisation ratio ρ_n (Chandrasekhar 1950), per steradian. */
export function rayleighPhase(nu: number, depol: number): number {
  const gamma = depol / (2 - depol);
  return (3 / (16 * Math.PI)) * ((1 + 3 * gamma) + (1 - gamma) * nu * nu) / (1 + 2 * gamma);
}
/** Henyey–Greenstein phase function, per steradian. */
export function hgPhase(nu: number, g: number): number {
  const d = 1 + g * g - 2 * g * nu;
  return (1 - g * g) / (4 * Math.PI * d * Math.sqrt(d));
}

/** Depolarisation ratio per bin of the model's Rayleigh-type species (the first one). */
export function rayleighDepolarization(m: AtmosphereModel): number[] {
  for (const s of m.species) if (s.phase.kind === 'rayleigh') return s.phase.depolarization;
  return m.wavelengthsNm.map(() => 0);
}

/** The particle phase table shared by all particle species (column-scattering weighted), or null. */
export function particleTable(m: AtmosphereModel): number[][] | null {
  const parts = m.species.filter((s) => s.phase.kind === 'particle');
  if (!parts.length) return null;
  if (parts.length === 1) return (parts[0].phase as { table: number[][] }).table;
  const K = m.wavelengthsNm.length;
  const col = (s: AtmosphereSpecies, k: number) => s.scattering.reduce((a, row) => a + row[k], 0);
  return Array.from({ length: K }, (_, k) => {
    const wsum = parts.reduce((a, s) => a + col(s, k), 0) || 1;
    return Array.from({ length: PHASE_N }, (_, i) => parts.reduce((a, s) => a + col(s, k) * (s.phase as { table: number[][] }).table[k][i], 0) / wsum);
  });
}

/** Precompute all tables (CPU). */
export function precomputeAtmosphere(m: AtmosphereModel): AtmosphereTables {
  const K = m.wavelengthsNm.length;
  const H = m.topKm - m.bottomKm;
  const G = new ProfileGrid(m);
  const P = new Float64Array(5 * K);
  const tab: AtmosphereTables = { K, transmittance: new Float32Array(T_W * T_H * K), multiScattering: new Float32Array(0), skyIrradiance: new Float32Array(0), profile: new Float32Array(0) };

  // 1. Transmittance to the top (Bruneton 2017 ComputeTransmittanceToTopAtmosphereBoundary): trapezoid
  //    rule, 300 steps.
  const tau = new Float64Array(K);
  for (let j = 0; j < T_H; j++) for (let i = 0; i < T_W; i++) {
    const [r, mu] = rMuFromTransmittanceUv(m, i / (T_W - 1), j / (T_H - 1));
    const d = distanceToTop(m, r, mu);
    const n = 300;
    tau.fill(0);
    for (let s = 0; s <= n; s++) {
      const t = (d * s) / n;
      const rs = Math.sqrt(t * t + 2 * r * mu * t + r * r);
      G.at(rs - m.bottomKm, P);
      const w = s === 0 || s === n ? 0.5 : 1;
      for (let k = 0; k < K; k++) tau[k] += w * P[5 * k];
    }
    for (let k = 0; k < K; k++) tab.transmittance[(j * T_W + i) * K + k] = Math.exp(-(tau[k] * d) / n);
  }

  // 2. Multiple scattering Ψ_ms(h, μs) (Hillaire 2020 §5.5): the second-order light L2 and the transfer
  //    factor f_ms from 64 directions × 20 steps, isotropic phase, ground reflection in L2; Ψ = L2/(1 − f_ms).
  tab.multiScattering = new Float32Array(MS_N * MS_N * K);
  const dirs = sphereDirections(64);
  const L2 = new Float64Array(K), fms = new Float64Array(K), ts = new Float64Array(K);
  for (let j = 0; j < MS_N; j++) for (let i = 0; i < MS_N; i++) {
    const h = Math.max(H * (j / (MS_N - 1)), 1e-3);
    const r = m.bottomKm + h;
    const muS = -1 + 2 * (i / (MS_N - 1));
    const sunV: V3 = [Math.sqrt(Math.max(1 - muS * muS, 0)), 0, muS];
    L2.fill(0); fms.fill(0);
    for (const w of dirs) {
      const ground = rayHitsGround(m, r, w[2]);
      const dist = ground ? distanceToBottom(m, r, w[2]) : distanceToTop(m, r, w[2]);
      const n = 20;
      const ds = dist / n;
      tau.fill(0);
      for (let s = 0; s < n; s++) {
        const t = (s + 0.5) * ds;
        const p: V3 = [w[0] * t, w[1] * t, r + w[2] * t];
        const rp = Math.hypot(p[0], p[1], p[2]);
        G.at(rp - m.bottomKm, P);
        transmittanceToSunK(m, tab, rp, (p[0] * sunV[0] + p[2] * sunV[2]) / rp, ts);
        for (let k = 0; k < K; k++) {
          const ext = P[5 * k], sc = P[5 * k + 1];
          const a = Math.exp(-(tau[k] + 0.5 * ext * ds));
          L2[k] += (a * sc * ts[k] * ds) / (4 * Math.PI) / dirs.length;
          fms[k] += (a * sc * ds) / dirs.length;
          tau[k] += ext * ds;
        }
      }
      if (ground) {
        const p: V3 = [w[0] * dist, w[1] * dist, r + w[2] * dist];
        const rp = Math.hypot(p[0], p[1], p[2]);
        const muSp = (p[0] * sunV[0] + p[2] * sunV[2]) / rp;
        transmittanceToSunK(m, tab, rp, muSp, ts);
        for (let k = 0; k < K; k++) L2[k] += (Math.exp(-tau[k]) * ts[k] * Math.max(muSp, 0) * m.groundAlbedo[k]) / Math.PI / dirs.length;
      }
    }
    for (let k = 0; k < K; k++) tab.multiScattering[(j * MS_N + i) * K + k] = L2[k] / Math.max(1 - fms[k], 1e-3);
  }

  // 3. Sky irradiance on a horizontal surface at altitude h (Bruneton's irradiance texture, here from this
  //    model's single + multiple scattering): ∫ L_sky(ω) cos θ dω over the upper hemisphere.
  tab.skyIrradiance = new Float32Array(IRR_W * IRR_H * K);
  const up = sphereDirections(96).filter((w) => w[2] > 0);
  const L = new Float64Array(K);
  for (let j = 0; j < IRR_H; j++) for (let i = 0; i < IRR_W; i++) {
    const h = H * (j / (IRR_H - 1));
    const r = m.bottomKm + h;
    const muS = -1 + 2 * (i / (IRR_W - 1));
    const sunV: V3 = [Math.sqrt(Math.max(1 - muS * muS, 0)), 0, muS];
    const o = (j * IRR_W + i) * K;
    for (const w of up) {
      skyRadianceK(m, tab, [0, 0, r], w, sunV, 16, G, L);
      for (let k = 0; k < K; k++) tab.skyIrradiance[o + k] += (L[k] * w[2] * 2 * Math.PI) / up.length;
    }
  }

  // 4. Profile table for the per-pixel march.
  tab.profile = new Float32Array(PROFILE_N * K * 4);
  for (let a = 0; a < PROFILE_N; a++) {
    G.at(profileAltitude(m, a / (PROFILE_N - 1)), P);
    for (let k = 0; k < K; k++) tab.profile.set([P[5 * k], P[5 * k + 2], P[5 * k + 3], 0], (a * K + k) * 4);
  }
  return tab;
}

/** Altitude (km) of profile-table coordinate x ∈ [0, 1]: h = H·x². */
export function profileAltitude(m: AtmosphereModel, x: number): number {
  return (m.topKm - m.bottomKm) * x * x;
}

/**
 * Radiance per unit solar irradiance (sr⁻¹) of the sky seen from point p (planet-centred, km) along unit
 * direction w, Sun along unit sunV, every bin into out: single scattering with the species' phase functions
 * plus Hillaire's multiple-scattering term, marched in n steps. The reference for the per-pixel shader.
 */
export function skyRadianceK(m: AtmosphereModel, tab: AtmosphereTables, p: V3, w: V3, sunV: V3, n: number, G: ProfileGrid, out: Float64Array): Float64Array {
  const K = tab.K;
  const r = Math.hypot(p[0], p[1], p[2]);
  const mu = (p[0] * w[0] + p[1] * w[1] + p[2] * w[2]) / r;
  const ground = rayHitsGround(m, r, mu);
  const dist = ground ? distanceToBottom(m, r, mu) : distanceToTop(m, r, mu);
  const nu = w[0] * sunV[0] + w[1] * sunV[1] + w[2] * sunV[2];
  const depol = rayleighDepolarization(m);
  const table = particleTable(m);
  const P = new Float64Array(5 * K), ts = new Float64Array(K), ms = new Float64Array(K), tau = new Float64Array(K);
  out.fill(0);
  const ds = dist / n;
  for (let s = 0; s < n; s++) {
    const t = (s + 0.5) * ds;
    const q: V3 = [p[0] + w[0] * t, p[1] + w[1] * t, p[2] + w[2] * t];
    const rq = Math.hypot(q[0], q[1], q[2]);
    const h = rq - m.bottomKm;
    const muS = (q[0] * sunV[0] + q[1] * sunV[1] + q[2] * sunV[2]) / rq;
    G.at(h, P);
    transmittanceToSunK(m, tab, rq, muS, ts);
    if (tab.multiScattering.length) msLookupK(m, tab, h, muS, ms); else ms.fill(0);
    for (let k = 0; k < K; k++) {
      const ext = P[5 * k], sc = P[5 * k + 1];
      const S = (P[5 * k + 2] * rayleighPhase(nu, depol[k]) + (table ? P[5 * k + 3] * particlePhase(table, nu, k) : 0)) * ts[k] + sc * ms[k];
      out[k] += Math.exp(-(tau[k] + 0.5 * ext * ds)) * S * ds;
      tau[k] += ext * ds;
    }
  }
  return out;
}

/** Single-bin convenience wrapper of skyRadianceK (tests). */
export function skyRadiance(m: AtmosphereModel, tab: AtmosphereTables, p: V3, w: V3, sunV: V3, k: number, n = 32): number {
  return skyRadianceK(m, tab, p, w, sunV, n, new ProfileGrid(m, 512), new Float64Array(tab.K))[k];
}

/** Ψ_ms at altitude h and sun cosine μs, all bins (bilinear). */
export function msLookupK(m: AtmosphereModel, tab: AtmosphereTables, h: number, muS: number, out: Float64Array): Float64Array {
  return lutK(tab.multiScattering, MS_N, MS_N, tab.K, (muS + 1) / 2, h / (m.topKm - m.bottomKm), out);
}
export function msLookup(m: AtmosphereModel, tab: AtmosphereTables, h: number, muS: number, k: number): number {
  return msLookupK(m, tab, h, muS, new Float64Array(tab.K))[k];
}

/** Sky irradiance at altitude h, sun cosine μs (per unit solar irradiance). */
export function skyIrradianceLookup(m: AtmosphereModel, tab: AtmosphereTables, h: number, muS: number, k: number): number {
  return lutK(tab.skyIrradiance, IRR_W, IRR_H, tab.K, (muS + 1) / 2, h / (m.topKm - m.bottomKm), new Float64Array(tab.K))[k];
}

/** n roughly uniform unit vectors (Fibonacci sphere). */
export function sphereDirections(n: number): V3[] {
  const out: V3[] = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const z = 1 - (2 * (i + 0.5)) / n;
    const rr = Math.sqrt(1 - z * z);
    out.push([rr * Math.cos(ga * i), rr * Math.sin(ga * i), z]);
  }
  return out;
}

// ── atmospheres.json → AtmosphereModel ───────────────────────────────────────────────────────────

/** The parts of atmospheres.json the adapter reads (schema AtmosphereFile / BodyAtmosphere). */
export interface AtmosphereData {
  wavelengthsNm: number[];
  foldWeights: number[][];
  body: {
    name: string;
    referenceRadiusKm: number;
    altitudesKm: number[];
    topAltitudeKm: number | null;
    components: {
      id: string;
      extinctionPerKm: { value: number[][] | null; label: string };
      singleScatteringAlbedo: { value: number[] | null; label: string };
      phaseFunction: { value: AtmospherePhaseData | null; label: string };
    }[];
  };
}
export type AtmospherePhaseData =
  | { kind: 'rayleigh'; depolarization: number[] }
  | { kind: 'henyey-greenstein'; g: number[] }
  | { kind: 'double-henyey-greenstein'; g1: number[]; g2: number[]; alpha: number[] }
  | { kind: 'tabulated'; anglesDeg: number[]; values: number[][] }
  | { kind: 'none' };

/** Samples of atmospheres.json merged into one renderer bin (12 bins of 40 nm over 360–830 nm). */
export const SAMPLES_PER_BIN = 4;

/**
 * Build the renderer's model from a body's entry of atmospheres.json:
 * - consecutive groups of SAMPLES_PER_BIN wavelengths are merged into one bin (fold weights summed;
 *   coefficients and phase functions averaged with the sunlight × observer importance of each sample,
 *   the mean of the four fold-weight rows);
 * - scattering = ω·β_ext and absorption = (1 − ω)·β_ext (the schema's definition);
 * - phase functions become per-bin tables at 1° (HG, double HG and tabulated; ∫P dΩ = 1).
 * An atmosphere with a component whose extinction, single-scattering albedo or phase function is unknown is
 * not drawn: partial scattering would misstate its light (e.g. Titan's haze); its extent (bottom and top
 * radii) is returned with the error, for the "not measured" treatment of the limb.
 * groundAlbedo: the Lambert-equivalent reflectance below, one number or per channel X, Y, Z, S; per channel,
 * each bin takes the value of the colour-matching channel (X, Y or Z) whose fold weight is largest there, and
 * values are capped at 1 (energy conservation; 1.5·p exceeds 1 for Venus).
 */
export function atmosphereModelFromData(d: AtmosphereData, groundAlbedo: number | number[], dustScale = 1): { model: AtmosphereModel } | { error: string; extent?: { bottomKm: number; topKm: number } } {
  const b = d.body;
  if (!b.altitudesKm.length || b.topAltitudeKm === null) return { error: `${b.name}: no atmosphere profile (scale height only) → no atmosphere drawn` };
  for (const c of b.components) {
    for (const [what, s] of [['extinction', c.extinctionPerKm], ['single-scattering albedo', c.singleScatteringAlbedo], ['phase function', c.phaseFunction]] as const) {
      if (s.label === 'unknown' || s.value === null) {
        return {
          error: `${b.name}: ${c.id} ${what} not measured → its light is not drawn; the atmosphere beyond the disk is marked not measured`,
          extent: { bottomKm: b.referenceRadiusKm + b.altitudesKm[0], topKm: b.referenceRadiusKm + b.topAltitudeKm },
        };
      }
    }
  }
  const n = d.wavelengthsNm.length;
  const K = Math.floor(n / SAMPLES_PER_BIN);
  const W = d.foldWeights;
  const imp = d.wavelengthsNm.map((_, k) => (W[0][k] + W[1][k] + W[2][k] + W[3][k]) / 4);
  const bins = Array.from({ length: K }, (_, bi) => Array.from({ length: SAMPLES_PER_BIN }, (_, j) => bi * SAMPLES_PER_BIN + j));
  // Samples beyond the last full bin join it (their weights are negligible at the red end).
  for (let k = K * SAMPLES_PER_BIN; k < n; k++) bins[K - 1].push(k);
  const avg = (vals: (k: number) => number, bin: number[]) => {
    const ws = bin.reduce((a, k) => a + imp[k], 0);
    return ws > 0 ? bin.reduce((a, k) => a + imp[k] * vals(k), 0) / ws : bin.reduce((a, k) => a + vals(k), 0) / bin.length;
  };
  const weights = [0, 1, 2, 3].map((c) => bins.map((bin) => bin.reduce((a, k) => a + W[c][k], 0)));
  const wavelengthsNm = bins.map((bin) => avg((k) => d.wavelengthsNm[k], bin));
  const ground = bins.map((_, k) => {
    if (typeof groundAlbedo === 'number') return Math.min(1, Math.max(0, groundAlbedo));
    let best = 0;
    for (let c = 1; c < 3; c++) if (weights[c][k] > weights[best][k]) best = c;
    return Math.min(1, Math.max(0, groundAlbedo[best]));
  });
  const species: AtmosphereSpecies[] = b.components.map((c) => {
    const ssa = c.singleScatteringAlbedo.value!, ph = c.phaseFunction.value!;
    // Mars: the dust component is the annual global mean, scaled to the season (marsDustScale).
    const ext = c.id === 'dust' && dustScale !== 1 ? c.extinctionPerKm.value!.map((row) => row.map((v) => v * dustScale)) : c.extinctionPerKm.value!;
    const scattering = ext.map((row) => bins.map((bin) => avg((k) => row[k] * ssa[k], bin)));
    const absorption = ext.map((row) => bins.map((bin) => avg((k) => row[k] * (1 - ssa[k]), bin)));
    let phase: AtmosphereSpecies['phase'];
    if (ph.kind === 'none' || ssa.every((w) => w === 0)) phase = { kind: 'none' };
    else if (ph.kind === 'rayleigh') phase = { kind: 'rayleigh', depolarization: bins.map((bin) => avg((k) => ph.depolarization[k], bin)) };
    else {
      const at = (k: number, deg: number): number => {
        const nu = Math.cos((deg * Math.PI) / 180);
        if (ph.kind === 'henyey-greenstein') return hgPhase(nu, ph.g[k]);
        if (ph.kind === 'double-henyey-greenstein') return ph.alpha[k] * hgPhase(nu, ph.g1[k]) + (1 - ph.alpha[k]) * hgPhase(nu, ph.g2[k]);
        // Tabulated (mean 1 over the sphere): linear in angle, per steradian = value/4π.
        const a = ph.anglesDeg;
        let i = 0;
        while (i < a.length - 2 && a[i + 1] < deg) i++;
        const t = Math.min(Math.max((deg - a[i]) / (a[i + 1] - a[i]), 0), 1);
        return (ph.values[k][i] * (1 - t) + ph.values[k][i + 1] * t) / (4 * Math.PI);
      };
      phase = { kind: 'particle', table: bins.map((bin) => Array.from({ length: PHASE_N }, (_, i) => avg((k) => at(k, phaseAngleDeg(i)), bin))) };
    }
    return { name: c.id, scattering, absorption, phase };
  });
  return {
    model: {
      // The profile's first level is the bottom (0 for Earth and Mars; Venus: 60 km, inside its cloud deck).
      bottomKm: b.referenceRadiusKm + b.altitudesKm[0], topKm: b.referenceRadiusKm + b.topAltitudeKm,
      altitudesKm: b.altitudesKm.map((a) => a - b.altitudesKm[0]),
      wavelengthsNm, weights, species, groundAlbedo: ground,
    },
  };
}

export interface ViewPath {
  /** Path radiance per unit solar irradiance (sr⁻¹) and transmittance, per bin: whole segment and above hSplit. */
  L: Float64Array;
  T: Float64Array;
  Lc: Float64Array;
  Tc: Float64Array;
}

/**
 * Reference of the shader's atmMarch (shaders-atmosphere.ts) for a sphere: the segment from surface point p
 * (planet-centred, km, at the bottom) toward the observer along unit e, to the top of the atmosphere, marched
 * in n steps from the observer's side; single scattering with the species' phase functions plus the
 * multiple-scattering table; Lc/Tc over the part above altitude hSplit. sLen: the segment's length instead
 * (a chord that misses the body, from its far end p; the shell shader's march).
 */
export function viewPath(m: AtmosphereModel, tab: AtmosphereTables, G: ProfileGrid, p: V3, e: V3, sunV: V3, hSplit: number, n: number, sLen?: number): ViewPath {
  const K = tab.K;
  const out: ViewPath = { L: new Float64Array(K), T: new Float64Array(K).fill(1), Lc: new Float64Array(K), Tc: new Float64Array(K).fill(1) };
  const r0 = Math.hypot(p[0], p[1], p[2]);
  const pe = p[0] * e[0] + p[1] * e[1] + p[2] * e[2];
  const Hk = m.topKm - m.bottomKm;
  const sTop = sLen ?? -pe + Math.sqrt(Math.max(pe * pe + 2 * r0 * Hk + Hk * Hk, 0));
  const d: V3 = [-e[0], -e[1], -e[2]];
  const nu = d[0] * sunV[0] + d[1] * sunV[1] + d[2] * sunV[2];
  const depol = rayleighDepolarization(m);
  const table = particleTable(m);
  const P = new Float64Array(5 * K), ts = new Float64Array(K), ms = new Float64Array(K);
  const ds = sTop / n;
  for (let i = 0; i < n; i++) {
    const s = sTop - (i + 0.5) * ds;
    const q: V3 = [p[0] - d[0] * s, p[1] - d[1] * s, p[2] - d[2] * s];
    const rq = Math.hypot(q[0], q[1], q[2]);
    const h = Math.max(rq - m.bottomKm, 0);
    const muS = (q[0] * sunV[0] + q[1] * sunV[1] + q[2] * sunV[2]) / rq;
    G.at(h, P);
    transmittanceToSunK(m, tab, m.bottomKm + h, muS, ts);
    msLookupK(m, tab, h, muS, ms);
    for (let k = 0; k < K; k++) {
      const ext = P[5 * k], sR = P[5 * k + 2], sA = P[5 * k + 3];
      const src = (sR * rayleighPhase(nu, depol[k]) + (table ? sA * particlePhase(table, nu, k) : 0)) * ts[k] + (sR + sA) * ms[k];
      const tr = Math.exp(-ext * ds);
      const seg = ext > 1e-9 ? (src * (1 - tr)) / ext : src * ds;
      out.L[k] += out.T[k] * seg;
      out.T[k] *= tr;
      if (h > hSplit) { out.Lc[k] += out.Tc[k] * seg; out.Tc[k] *= tr; }
    }
  }
  return out;
}

/** Transmittance to the Sun at altitude h (0 below the horizon), all bins (atmTsun without the solar disk). */
export function sunTransmittanceK(m: AtmosphereModel, tab: AtmosphereTables, h: number, muS: number, out: Float64Array): Float64Array {
  return transmittanceToSunK(m, tab, m.bottomKm + h, muS, out);
}
/** Sky irradiance at altitude h, all bins. */
export function skyIrradianceK(m: AtmosphereModel, tab: AtmosphereTables, h: number, muS: number, out: Float64Array): Float64Array {
  return lutK(tab.skyIrradiance, IRR_W, IRR_H, tab.K, (muS + 1) / 2, h / (m.topKm - m.bottomKm), out);
}

/**
 * Mars (atmospheres.json dustColumn): the dust component's scale at ephemeris time et, the global-mean
 * column dust optical depth of the season's L_s bin over its annual mean, and the bin index (for caching).
 * L_s comes from the file's solarLongitude table (linear in et). The latitude dependence of the column is
 * left out: the tables are spherically symmetric. Null when the body has no dust column.
 */
export function marsDustScale(body: { dustColumn?: { value: { lsDeg: number[]; globalMean610Pa: number[]; annualGlobalMean610Pa: number } | null } ; solarLongitude?: { value: { et: number[]; lsDeg: number[] } | null } }, et: number): { scale: number; bin: number; ls: number } | null {
  const dc = body.dustColumn?.value, sl = body.solarLongitude?.value;
  if (!dc || !sl || !sl.et.length) return null;
  const t = sl.et;
  let i = 0;
  while (i < t.length - 2 && t[i + 1] < et) i++;
  const f = Math.min(Math.max((et - t[i]) / (t[i + 1] - t[i]), 0), 1);
  let l0 = sl.lsDeg[i], l1 = sl.lsDeg[i + 1];
  if (l1 < l0 - 180) l1 += 360;
  const ls = (((l0 + (l1 - l0) * f) % 360) + 360) % 360;
  // Nearest bin centre (the table's L_s are bin centres, 5° apart), on the circle.
  const dist = (a: number) => { const d = Math.abs(a - ls) % 360; return Math.min(d, 360 - d); };
  let bin = 0;
  for (let k = 1; k < dc.lsDeg.length; k++) if (dist(dc.lsDeg[k]) < dist(dc.lsDeg[bin])) bin = k;
  return { scale: dc.globalMean610Pa[bin] / dc.annualGlobalMean610Pa, bin, ls };
}

/**
 * The disk integrals that renormalize a body drawn from its disk photometry once its atmosphere is added
 * (docs/rendering-earth.md §8): over a grid of n × n points on the disk seen from direction o (unit, body →
 * observer) with the Sun along s, for a surface radiance factor f (per channel, law × map, without air):
 * - I0: ∫ f (the surface alone),
 * - Iatm: ∫ Σ_k w[c][k]·(f·T_sun,k + M·E_sky,k)·T_view,k (the surface under the air; skylight as Lambert),
 * - Apath: ∫ Σ_k w[c][k]·π·L_path,k (the light of the air itself),
 * - Ashell: the same for the rays that miss the body and cross the air (the limb; the shell shader), over the
 *   annulus from the bottom to the top radius, marched in `shellSteps` like the shader,
 * all as disk-integrated reflectances (1/(πR²))∫ρ dA with R the bottom radius. The rendered body keeps the
 * measured p·Φ when the surface scale K is multiplied by (1 − (Apath + Ashell)/pΦ)·I0/Iatm.
 */
export function atmosphereDiskFactors(
  m: AtmosphereModel, tab: AtmosphereTables, G: ProfileGrid, o: V3, s: V3,
  f: (n: V3, mu0: number, mu: number) => { rho: number[]; albedo: number[] }, n = 24, shellSteps = 32,
): { I0: number[]; Iatm: number[]; Apath: number[]; Ashell: number[] } {
  const K = tab.K;
  const I0 = [0, 0, 0, 0], Iatm = [0, 0, 0, 0], Apath = [0, 0, 0, 0], Ashell = [0, 0, 0, 0];
  // Basis of the disk plane.
  const h: V3 = Math.abs(o[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const e1n = [o[1] * h[2] - o[2] * h[1], o[2] * h[0] - o[0] * h[2], o[0] * h[1] - o[1] * h[0]];
  const l1 = Math.hypot(e1n[0], e1n[1], e1n[2]);
  const e1: V3 = [e1n[0] / l1, e1n[1] / l1, e1n[2] / l1];
  const e2: V3 = [o[1] * e1[2] - o[2] * e1[1], o[2] * e1[0] - o[0] * e1[2], o[0] * e1[1] - o[1] * e1[0]];
  const ts = new Float64Array(K), es = new Float64Array(K);
  const dA = (2 / n) * (2 / n) / Math.PI;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const x = -1 + (2 * (i + 0.5)) / n, y = -1 + (2 * (j + 0.5)) / n;
    const r2 = x * x + y * y;
    if (r2 >= 1) continue;
    const mu = Math.sqrt(1 - r2);
    const nv: V3 = [x * e1[0] + y * e2[0] + mu * o[0], x * e1[1] + y * e2[1] + mu * o[1], x * e1[2] + y * e2[2] + mu * o[2]];
    const mu0 = nv[0] * s[0] + nv[1] * s[1] + nv[2] * s[2];
    const sf = f(nv, mu0, mu);
    const p: V3 = [nv[0] * m.bottomKm, nv[1] * m.bottomKm, nv[2] * m.bottomKm];
    const path = viewPath(m, tab, G, p, o, s, -1, 16);
    sunTransmittanceK(m, tab, 0, mu0, ts);
    skyIrradianceK(m, tab, 0, mu0, es);
    for (let c = 0; c < 4; c++) {
      let under = 0, air = 0;
      for (let k = 0; k < K; k++) {
        under += m.weights[c][k] * (sf.rho[c] * ts[k] + sf.albedo[c] * es[k]) * path.T[k];
        air += m.weights[c][k] * Math.PI * path.L[k];
      }
      I0[c] += sf.rho[c] * dA;
      Iatm[c] += under * dA;
      Apath[c] += air * dA;
    }
  }
  // The annulus: impact parameter b = R + H·x² (dense near the bottom, where the air is), n/2 radii × n angles.
  const R = m.bottomKm, Hk = m.topKm - m.bottomKm, nb = Math.max(8, Math.round(n / 2)), nt = n;
  for (let i = 0; i < nb; i++) {
    const x = (i + 0.5) / nb;
    const b = R + Hk * x * x;
    const db = (2 * Hk * x) / nb;
    const half = Math.sqrt(Math.max(m.topKm * m.topKm - b * b, 0));
    for (let j = 0; j < nt; j++) {
      const t = (2 * Math.PI * (j + 0.5)) / nt;
      const c0 = Math.cos(t) * b, c1 = Math.sin(t) * b;
      const pFar: V3 = [c0 * e1[0] + c1 * e2[0] - half * o[0], c0 * e1[1] + c1 * e2[1] - half * o[1], c0 * e1[2] + c1 * e2[2] - half * o[2]];
      const path = viewPath(m, tab, G, pFar, o, s, -1, shellSteps, 2 * half);
      const dA = (b * db * ((2 * Math.PI) / nt)) / (Math.PI * R * R);
      for (let c = 0; c < 4; c++) {
        let air = 0;
        for (let k = 0; k < K; k++) air += m.weights[c][k] * Math.PI * path.L[k];
        Ashell[c] += air * dA;
      }
    }
  }
  return { I0, Iatm, Apath, Ashell };
}
