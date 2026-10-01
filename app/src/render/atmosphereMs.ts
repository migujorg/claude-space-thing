// Multiple scattering for an optically thick, forward-scattering atmosphere (Titan's haze: τ ≈ 8 at 550 nm,
// ω ≈ 0.85–1, asymmetry ≈ 0.75), where Hillaire's (2020) per-point estimate of atmosphere.ts does not hold
// (docs/rendering-earth.md §8 "Titan": +26 % at 550 nm and +54 % at 400 nm on the geometric albedo against a
// Monte Carlo solution of the same model). Instead the diffuse radiance field is solved by successive orders of
// scattering (e.g. Lenoble 1985, Radiative Transfer in Scattering and Absorbing Atmospheres, ch. 6), per wavelength
// bin and solar zenith cosine μs, in azimuthal Fourier terms m = 0 … FOURIER_N − 1 about the local vertical:
//
//   - geometry: a spherical shell lit everywhere at the column's μs ("local spherical symmetry"): the direct beam at
//     every level is the spherical transmittance to the Sun (the model's table; a level that sees the Sun over the
//     limb while μs < 0 is lit), and each stream crosses each layer along its straight path in the shell, so light
//     travelling near the horizontal climbs out of the haze as it does around a sphere instead of staying in the
//     layer (plane-parallel). What it leaves out is the change of μs along a path: near the terminator the diffuse
//     light that comes from the sunlit side is missed;
//   - forward peak: the particle phase function is clipped at CLIP_DEG (P_c = min(P, P(θ_c)), a "δ-fit"
//     truncation in the spirit of Wiscombe's 1977 δ-M); the clipped fraction f counts as unscattered (σ_t' = σ_t −
//     f σ_s,p, σ_s,p' = (1 − f) σ_s,p, P' = P_c/(1 − f)). The renderer's single scattering keeps the full phase
//     function, and the whole path radiance is attenuated in the scaled medium (Nakajima & Tanaka 1988, JQSRT 40,
//     51, "TMS");
//   - streams: OS_STREAMS Gauss–Legendre nodes per hemisphere; the Fourier terms of the phase function between
//     streams are integrated numerically in azimuth, the m = 0 matrix renormalized to conserve energy on the
//     quadrature; a path's radiance where it enters a layer is linear in μ between the streams of that level;
//   - layers equal in scaled optical depth (≤ DTAU_MAX), source constant within a layer (exact exponential
//     integration along each path), Lambert surface below;
//   - orders summed until the ratio of successive orders settles, then the geometric tail is added.
//
// Outputs per bin, level and μs: the source of the next scattering out of the diffuse field (orders ≥ 2 of the
// scaled medium) toward VIEW_N view directions, per Fourier term (OsResult.J; the renderer's msSource table), and
// the downward diffuse flux (the sky irradiance on a horizontal surface). The test of the whole against the Monte
// Carlo solution, with its residuals per phase angle, is in docs/rendering-earth.md §8 "Titan".

import type { AtmosphereModel } from './atmosphere';
import { PHASE_N, ProfileGrid } from './atmosphere';

/** Clip angle of the particle forward peak (degrees): the peak inside it counts as unscattered. A sampling choice. */
export const CLIP_DEG = 16;
/** Gauss–Legendre nodes per hemisphere. */
export const OS_STREAMS = 8;
/** Largest scaled optical depth of one layer. */
export const DTAU_MAX = 0.04;

const D2R = Math.PI / 180;

/** Gauss–Legendre nodes and weights on (0, 1). */
export function gaussLegendre01(n: number): { mu: Float64Array; w: Float64Array } {
  const x = new Float64Array(n), w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let z = Math.cos((Math.PI * (i + 0.75)) / (n + 0.5));
    for (let it = 0; it < 100; it++) {
      let p1 = 1, p2 = 0;
      for (let j = 1; j <= n; j++) { const p3 = p2; p2 = p1; p1 = ((2 * j - 1) * z * p2 - (j - 1) * p3) / j; }
      const pp = (n * (z * p1 - p2)) / (z * z - 1);
      const dz = p1 / pp;
      z -= dz;
      if (Math.abs(dz) < 1e-15) {
        x[i] = z;
        w[i] = 2 / ((1 - z * z) * pp * pp);
        break;
      }
    }
  }
  // Map [−1, 1] to (0, 1).
  const mu = new Float64Array(n), ww = new Float64Array(n);
  for (let i = 0; i < n; i++) { mu[i] = 0.5 * (x[i] + 1); ww[i] = 0.5 * w[i]; }
  return { mu, w: ww };
}

/** The clipped (δ-fit) particle phase per bin: fraction f removed, and the clipped table renormalized (per sr, ∫ = 1). */
export function clipPhase(table: number[][]): { f: number[]; clipped: number[][] } {
  const ic = Math.round(CLIP_DEG);
  const f: number[] = [], clipped: number[][] = [];
  for (const row of table) {
    const cap = row[ic];
    const c = row.map((v, i) => (i < ic ? Math.min(v, cap) : v));
    let s = 0;
    for (let i = 0; i < PHASE_N - 1; i++) s += 0.5 * (c[i] * Math.sin(i * D2R) + c[i + 1] * Math.sin((i + 1) * D2R)) * D2R;
    s *= 2 * Math.PI;
    f.push(Math.max(0, 1 - s));
    clipped.push(c.map((v) => v / s));
  }
  return { f, clipped };
}

/** Phase (per sr) of a 1° table at scattering-angle cosine c, linear in angle. */
function tabAt(row: number[], c: number): number {
  const a = Math.acos(Math.min(1, Math.max(-1, c))) / D2R;
  const i = Math.min(Math.floor(a), PHASE_N - 2);
  const t = a - i;
  return row[i] * (1 - t) + row[i + 1] * t;
}

/**
 * Azimuthal Fourier term m of the phase function on the streams (index 0..N−1 downward μ = −μ_i, N..2N−1 upward
 * μ = +μ_i), "mean 1" normalization: M[a][b] = 4π·(1/π)∫₀^π P(cos Θ) cos(mφ) dφ with Θ between directions a and b
 * at relative azimuth φ, so that P = Σ_m (2 − δ_m0) M_m cos(mφ). For m = 0 the columns are renormalized so that
 * ½ Σ_a w_a M[a][b] = 1 (energy conservation on the quadrature); m = 1 takes the same column factors.
 */
function phaseMatrix(p: (c: number) => number, mu: Float64Array, w: Float64Array, m: number, norm?: Float64Array): { M: Float64Array; norm: Float64Array } {
  const N = mu.length, n2 = 2 * N;
  const dir = (a: number) => (a < N ? -mu[a] : mu[a - N]);
  const M = new Float64Array(n2 * n2);
  const NPHI = 180;
  for (let a = 0; a < n2; a++) for (let b = 0; b < n2; b++) {
    const ma = dir(a), mb = dir(b);
    const sa = Math.sqrt(1 - ma * ma), sb = Math.sqrt(1 - mb * mb);
    let s = 0;
    for (let k = 0; k < NPHI; k++) {
      const phi = (Math.PI * (k + 0.5)) / NPHI;          // symmetric in φ: integrate over [0, π]
      s += p(ma * mb + sa * sb * Math.cos(phi)) * Math.cos(m * phi);
    }
    M[a * n2 + b] = (4 * Math.PI * s) / NPHI;
  }
  const nrm = norm ?? new Float64Array(n2);
  if (!norm) {
    for (let b = 0; b < n2; b++) {
      let s = 0;
      for (let a = 0; a < n2; a++) s += 0.5 * w[a % N] * M[a * n2 + b];
      nrm[b] = s;
    }
  }
  for (let b = 0; b < n2; b++) for (let a = 0; a < n2; a++) M[a * n2 + b] /= nrm[b];
  return { M, norm: nrm };
}

/**
 * The same with the direct beam: v[a] = Fourier term m of P between stream a and the beam, azimuth measured from
 * the Sun's azimuth (unrenormalized).
 */
function beamVector(p: (c: number) => number, mu: Float64Array, muS: number, m: number): Float64Array {
  const N = mu.length, n2 = 2 * N;
  const v = new Float64Array(n2);
  const ss = Math.sqrt(Math.max(0, 1 - muS * muS));
  const NPHI = 180;
  for (let a = 0; a < n2; a++) {
    const ma = a < N ? -mu[a] : mu[a - N];
    const sa = Math.sqrt(1 - ma * ma);
    let s = 0;
    // The Sun's beam travels along −S: the scattering angle between the beam and stream a (at azimuth φ from the
    // Sun's) has cos Θ = −(stream · S).
    for (let k = 0; k < NPHI; k++) {
      const phi = (Math.PI * (k + 0.5)) / NPHI;
      s += p(-(ma * muS + sa * ss * Math.cos(phi))) * Math.cos(m * phi);
    }
    v[a] = (4 * Math.PI * s) / NPHI;
  }
  return v;
}

export interface OsResult {
  /** Level altitudes (km above the bottom), ascending. */
  z: Float64Array;
  /**
   * Multiple-scattering source per μs: J[μs][(m·(L + 1) + level)·VIEW_N + v], the Fourier term m (cos mφ, φ the
   * azimuth of the direction of travel from the Sun's) of the light scattered once more out of the diffuse field,
   * per unit scaled scattering coefficient (σ_R + σ_p'), sr⁻¹ per unit solar irradiance, at view-direction cosine
   * μ_v = cos(v·180°/(VIEW_N − 1)) (direction of travel, upward positive). The emission per unit length toward
   * (μ_v, φ) is (σ_R + σ_p')·Σ_m (2 − δ_m0) J_m cos mφ: orders ≥ 2 of the scaled medium.
   */
  J: Float64Array[];
  /** Downward diffuse flux on a horizontal surface per μs and level [mu][level], per unit solar irradiance. */
  down: Float64Array[];
  /** Orders summed (before the tail) per μs (Fourier term 0). */
  orders: number[];
}

/** View-direction nodes of the source table, uniform in zenith angle 0…180°. A sampling choice. */
export const VIEW_N = 19;
/** Fourier terms of the source table (m = 0 … FOURIER_N − 1). A sampling choice. */
export const FOURIER_N = 6;
export const viewMu = (v: number) => Math.cos((Math.PI * v) / (VIEW_N - 1));

/**
 * Successive orders of scattering for bin k at every μs of `muS`, Fourier terms 0 … FOURIER_N − 1. sunT(h, μs) is
 * the scaled transmittance to the Sun (spherical; 0 below the horizon). ground: Lambert reflectance below.
 */
export function ordersOfScattering(
  m: AtmosphereModel, G: ProfileGrid, k: number, muSList: number[], sunT: (h: number, muS: number) => number,
  ground: number, parts: { clipped: number[]; f: number }[], depol: number,
): OsResult {
  const { mu, w } = gaussLegendre01(OS_STREAMS);
  const N = mu.length, n2 = 2 * N;
  const H = m.topKm - m.bottomKm;
  // Scaled coefficients on a fine altitude grid, then layers of ≤ DTAU_MAX scaled optical depth.
  const NF = 4000;
  const P = new Float64Array(5 * G.K);
  const NG = parts.length;
  const zf = new Float64Array(NF + 1), ext = new Float64Array(NF + 1), sR = new Float64Array(NF + 1);
  const sA = parts.map(() => new Float64Array(NF + 1));
  for (let i = 0; i <= NF; i++) {
    const x = i / NF;
    zf[i] = H * x * x;
    G.at(zf[i], P);
    sR[i] = P[5 * k + 2];
    ext[i] = P[5 * k];
    for (let g = 0; g < NG; g++) {
      sA[g][i] = (1 - parts[g].f) * P[5 * k + 3 + g];
      ext[i] -= parts[g].f * P[5 * k + 3 + g];
    }
  }
  const levels: number[] = [0];
  let acc = 0;
  for (let i = 1; i <= NF; i++) {
    acc += 0.5 * (ext[i] + ext[i - 1]) * (zf[i] - zf[i - 1]);
    if (acc >= DTAU_MAX || i === NF) { levels.push(i); acc = 0; }
  }
  const L = levels.length - 1;
  const z = new Float64Array(L + 1);
  for (let l = 0; l <= L; l++) z[l] = zf[levels[l]];
  // Layer properties: optical depth, single-scattering albedos of the scatterers (Rayleigh, particle groups).
  const dtau = new Float64Array(L), wR = new Float64Array(L), zm = new Float64Array(L);
  const wAg = parts.map(() => new Float64Array(L));
  for (let l = 0; l < L; l++) {
    let t = 0, r = 0;
    const a = new Float64Array(NG);
    for (let i = levels[l] + 1; i <= levels[l + 1]; i++) {
      const dz = zf[i] - zf[i - 1];
      t += 0.5 * (ext[i] + ext[i - 1]) * dz;
      r += 0.5 * (sR[i] + sR[i - 1]) * dz;
      for (let g = 0; g < NG; g++) a[g] += 0.5 * (sA[g][i] + sA[g][i - 1]) * dz;
    }
    dtau[l] = t;
    wR[l] = t > 0 ? r / t : 0;
    for (let g = 0; g < NG; g++) wAg[g][l] = t > 0 ? a[g] / t : 0;
    zm[l] = 0.5 * (z[l] + z[l + 1]);
  }
  const gam = depol / (2 - depol);
  const pR = (c: number) => (3 / (16 * Math.PI)) * ((1 + 3 * gam) + (1 - gam) * c * c) / (1 + 2 * gam);
  const pAg = parts.map((p) => (c: number) => tabAt(p.clipped, c));
  const vmu = Float64Array.from({ length: VIEW_N }, (_, v) => viewMu(v));
  // Per Fourier term: the layer-mixed phase matrices are formed per layer from these (Rayleigh, then each group).
  const phs = [pR, ...pAg];
  const base = phs.map((p) => phaseMatrix(p, mu, w, 0));
  const PM: { M: Float64Array; O: Float64Array }[][] = phs.map(() => []);
  for (let mm = 0; mm < FOURIER_N; mm++) phs.forEach((p, q) => {
    PM[q].push({ M: mm ? phaseMatrix(p, mu, w, mm, base[q].norm).M : base[q].M, O: outputMatrix(p, mu, vmu, mm, base[q].norm) });
  });
  const wq = [wR, ...wAg];
  const NQ = phs.length;
  // Per Fourier term, each layer's mixture: the scattering matrix ω_q-weighted over the scatterers, and the same
  // toward the view nodes per unit scattering (Σ_q ω_q = 0: none).
  const mixM: Float64Array[] = [], mixO: Float64Array[] = [];
  for (let mm = 0; mm < FOURIER_N; mm++) {
    const X = new Float64Array(L * n2 * n2), Y = new Float64Array(L * VIEW_N * n2);
    for (let l = 0; l < L; l++) {
      let ws = 0;
      for (let q = 0; q < NQ; q++) ws += wq[q][l];
      for (let q = 0; q < NQ; q++) {
        const a = wq[q][l];
        if (a === 0) continue;
        const Mq = PM[q][mm].M, Oq = PM[q][mm].O;
        for (let i = 0; i < n2 * n2; i++) X[l * n2 * n2 + i] += a * Mq[i];
        for (let i = 0; i < VIEW_N * n2; i++) Y[l * VIEW_N * n2 + i] += (a / ws) * Oq[i];
      }
    }
    mixM.push(X);
    mixO.push(Y);
  }
  const res: OsResult = { z, J: [], down: [], orders: [] };
  // Transport of each stream across each layer along its straight path in the spherical shell (radii r_l): a
  // ray reaching level l downward at direction cosine μ_i left level l + 1 at μ' = √(1 − (r_l/r_l+1)²(1 − μ_i²));
  // one reaching level l + 1 upward at μ_i left level l at μ'' = √(1 − (b/r_l)²), b = r_l+1·√(1 − μ_i²), or, when
  // b ≥ r_l, left level l + 1 downward at μ_i and turned at its tangent point inside the layer. The radiance at
  // μ' or μ'' is interpolated (linear in μ) between the streams of that level. Per layer and stream: the path's
  // transmission e, the layer mean of the entering radiance's share g, and the interpolation node j and weight.
  // In the plane-parallel limit (r → ∞) μ' = μ'' = μ_i and the path is Δz/μ_i.
  const Rb = m.bottomKm;
  const eD = new Float64Array(L * N), gD = new Float64Array(L * N), jD = new Int32Array(L * N), tD = new Float64Array(L * N);
  const eU = new Float64Array(L * N), gU = new Float64Array(L * N), jU = new Int32Array(L * N), tU = new Float64Array(L * N);
  const tang = new Uint8Array(L * N);
  // Interpolation node j and weight t (value = I_j·(1 − t) + I_j+1·t) of cosine x among the streams (μ descending).
  const node = (x: number): [number, number] => {
    if (x >= mu[0]) return [0, 0];
    if (x <= mu[N - 1]) return [N - 2, 1];
    let j = 0;
    while (j < N - 2 && mu[j + 1] > x) j++;
    return [j, (mu[j] - x) / (mu[j] - mu[j + 1])];
  };
  const fill = (e: Float64Array, g: Float64Array, q: number, x: number) => {
    e[q] = Math.exp(-x);
    g[q] = x > 1e-9 ? (1 - Math.exp(-x)) / x : 1;
  };
  for (let l = 0; l < L; l++) {
    const r0 = Rb + z[l], r1 = Rb + z[l + 1];
    const k = dtau[l] / Math.max(z[l + 1] - z[l], 1e-12);
    for (let i = 0; i < N; i++) {
      const q = l * N + i;
      const sin2 = 1 - mu[i] * mu[i];
      // Downward, arriving at level l.
      const mu1 = Math.sqrt(Math.max(0, 1 - ((r0 * r0) / (r1 * r1)) * sin2));
      fill(eD, gD, q, k * (r1 * mu1 - r0 * mu[i]));
      [jD[q], tD[q]] = node(mu1);
      // Upward, arriving at level l + 1.
      const b2 = r1 * r1 * sin2;
      if (b2 >= r0 * r0) {
        tang[q] = 1;
        fill(eU, gU, q, k * 2 * r1 * mu[i]);
      } else {
        const mu0 = Math.sqrt(1 - b2 / (r0 * r0));
        fill(eU, gU, q, k * (r1 * mu[i] - r0 * mu0));
        [jU[q], tU[q]] = node(mu0);
      }
    }
  }
  const S = new Float64Array(L * n2), Snext = new Float64Array(L * n2);
  const Imean = new Float64Array(L * n2), Ibd = new Float64Array((L + 1) * N), Ibu = new Float64Array((L + 1) * N);

  /** Sum of all orders of one Fourier term: layer means per stream, and downward boundary radiances. */
  const solve = (mode: number, Mx: Float64Array, directFlux: number) => {
    const totMean = new Float64Array(L * n2), totDown = new Float64Array((L + 1) * N);
    let prevNorm = 0, prevRatio = 0, n = 0, first = 0;
    for (n = 1; n <= 400; n++) {
      for (let i = 0; i < N; i++) Ibd[L * N + i] = 0;
      for (let l = L - 1; l >= 0; l--) for (let i = 0; i < N; i++) {
        const q = l * N + i, o = (l + 1) * N + jD[q];
        const Iin = Ibd[o] * (1 - tD[q]) + Ibd[o + 1] * tD[q], s = S[l * n2 + i], ee = eD[q];
        Ibd[l * N + i] = Iin * ee + s * (1 - ee);
        Imean[l * n2 + i] = s + (Iin - s) * gD[q];
      }
      // Surface (Fourier term 0 only): Lambert reflection of the diffuse flux and, in the first order, of the
      // direct beam.
      let Iup = 0;
      if (mode === 0) {
        let Fd = 0;
        for (let i = 0; i < N; i++) Fd += 2 * Math.PI * w[i] * mu[i] * Ibd[i];
        if (n === 1) Fd += directFlux;
        Iup = (ground * Fd) / Math.PI;
      }
      for (let i = 0; i < N; i++) Ibu[i] = Iup;
      for (let l = 0; l < L; l++) for (let i = 0; i < N; i++) {
        const q = l * N + i, o = l * N + jU[q];
        const Iin = tang[q] ? Ibd[(l + 1) * N + i] : Ibu[o] * (1 - tU[q]) + Ibu[o + 1] * tU[q];
        const s = S[l * n2 + N + i], ee = eU[q];
        Imean[l * n2 + N + i] = s + (Iin - s) * gU[q];
        Ibu[(l + 1) * N + i] = Iin * ee + s * (1 - ee);
      }
      let norm = 0;
      for (let q = 0; q < L * n2; q++) { totMean[q] += Imean[q]; norm += Math.abs(Imean[q]); }
      for (let q = 0; q < (L + 1) * N; q++) totDown[q] += Ibd[q];
      if (n === 1) first = norm;
      for (let l = 0; l < L; l++) {
        const o = l * n2;
        for (let a = 0; a < n2; a++) {
          let s = 0;
          const r = (l * n2 + a) * n2;
          for (let b = 0; b < n2; b++) s += w[b % N] * Mx[r + b] * Imean[o + b];
          Snext[o + a] = 0.5 * s;
        }
      }
      S.set(Snext);
      const ratio = prevNorm > 0 ? norm / prevNorm : 0;
      if (norm <= 1e-7 * first) break;
      if (n > 8 && Math.abs(ratio - prevRatio) < 1e-4 && ratio < 1) {
        // Geometric tail of the remaining orders: the fields scale by `ratio` per order from here on.
        const tail = ratio / (1 - ratio);
        for (let q = 0; q < L * n2; q++) totMean[q] += Imean[q] * tail;
        for (let q = 0; q < (L + 1) * N; q++) totDown[q] += Ibd[q] * tail;
        break;
      }
      prevRatio = ratio;
      prevNorm = norm;
    }
    return { totMean, totDown, n };
  };
  /** Layer values → level values (end layers held). */
  const lev = (l: number) => (l === 0 ? [0, 0] : l === L ? [L - 1, L - 1] : [l - 1, l]);

  for (const muS of muSList) {
    const directFlux = muS > 0 ? muS * sunT(0, muS) : 0;
    const T = new Float64Array(L);
    let any = directFlux > 0;
    for (let l = 0; l < L; l++) { T[l] = sunT(zm[l], muS); if (T[l] > 0) any = true; }
    const J = new Float64Array(FOURIER_N * (L + 1) * VIEW_N);
    const dn = new Float64Array(L + 1);
    res.J.push(J);
    res.down.push(dn);
    if (!any) { res.orders.push(0); continue; }
    for (let mm = 0; mm < FOURIER_N; mm++) {
      const vs = phs.map((p) => beamVector(p, mu, muS, mm));
      for (let l = 0; l < L; l++) for (let a = 0; a < n2; a++) {
        let c = 0;
        for (let q = 0; q < NQ; q++) c += wq[q][l] * vs[q][a];
        S[l * n2 + a] = (c * T[l]) / (4 * Math.PI);
      }
      const s = solve(mm, mixM[mm], mm === 0 ? directFlux : 0);
      if (mm === 0) {
        res.orders.push(s.n);
        for (let l = 0; l <= L; l++) {
          let q = 0;
          for (let i = 0; i < N; i++) q += 2 * Math.PI * w[i] * mu[i] * s.totDown[l * N + i];
          dn[l] = q;
        }
      }
      // Source per unit scaled scattering out of each layer's diffuse field, toward the view nodes.
      const Jl = new Float64Array(L * VIEW_N);
      const Y = mixO[mm];
      for (let l = 0; l < L; l++) for (let v = 0; v < VIEW_N; v++) {
        let acc2 = 0;
        const r = (l * VIEW_N + v) * n2;
        for (let b = 0; b < n2; b++) acc2 += w[b % N] * Y[r + b] * s.totMean[l * n2 + b];
        Jl[l * VIEW_N + v] = 0.5 * acc2;
      }
      for (let l = 0; l <= L; l++) {
        const [a, b] = lev(l);
        for (let v = 0; v < VIEW_N; v++) J[(mm * (L + 1) + l) * VIEW_N + v] = 0.5 * (Jl[a * VIEW_N + v] + Jl[b * VIEW_N + v]);
      }
    }
  }
  return res;
}

/**
 * Fourier term m of the phase function between view node v (direction of travel μ_v) and stream b, "mean 1" and
 * with stream b's column factor of the m = 0 matrix (as phaseMatrix).
 */
function outputMatrix(p: (c: number) => number, mu: Float64Array, vmu: Float64Array, m: number, norm: Float64Array): Float64Array {
  const N = mu.length, n2 = 2 * N, NV = vmu.length;
  const O = new Float64Array(NV * n2);
  const NPHI = 180;
  for (let v = 0; v < NV; v++) for (let b = 0; b < n2; b++) {
    const ma = vmu[v], mb = b < N ? -mu[b] : mu[b - N];
    const sa = Math.sqrt(Math.max(0, 1 - ma * ma)), sb = Math.sqrt(1 - mb * mb);
    let s = 0;
    for (let q = 0; q < NPHI; q++) {
      const phi = (Math.PI * (q + 0.5)) / NPHI;
      s += p(ma * mb + sa * sb * Math.cos(phi)) * Math.cos(m * phi);
    }
    O[v * n2 + b] = (4 * Math.PI * s) / NPHI / norm[b];
  }
  return O;
}

/** Asymmetry g = ⟨cos θ⟩ of a 1° phase table (per sr). */
export function tableAsymmetry(row: number[]): number {
  let s = 0, n = 0;
  for (let i = 0; i < PHASE_N - 1; i++) {
    const a = row[i] * Math.sin(i * D2R), b = row[i + 1] * Math.sin((i + 1) * D2R);
    s += 0.5 * (a * Math.cos(i * D2R) + b * Math.cos((i + 1) * D2R)) * D2R;
    n += 0.5 * (a + b) * D2R;
  }
  return n > 0 ? s / n : 0;
}

/** Linear interpolation of a level profile at altitude h. */
export function atLevel(z: Float64Array, v: Float64Array, h: number): number {
  const n = z.length;
  if (h <= z[0]) return v[0];
  if (h >= z[n - 1]) return v[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mm = (lo + hi) >> 1; if (z[mm] <= h) lo = mm; else hi = mm; }
  const t = (h - z[lo]) / (z[hi] - z[lo]);
  return v[lo] + (v[hi] - v[lo]) * t;
}
