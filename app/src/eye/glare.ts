// Point spread of the eye = optical core (pupil-dependent) + intraocular scatter (disability glare).
//
// Core: Watson (2013) mean optical MTF of the best-corrected eye as a function of pupil diameter.
// Scatter: CIE 146:2002 general disability glare equation (0.1° ≤ θ ≤ 100°).
// The renderer approximates the scatter kernel on the pixel grid by a sum of Gaussians (one per level
// of an image pyramid); fitScatterKernel() finds non-negative weights by least squares.

import { CIE146, WATSON2013 } from './constants';

/**
 * CIE 146:2002 general disability glare function L_veil/E_glare in sr⁻¹ (equivalently
 * (cd/m²)/lux) at glare angle θ (degrees), for observer age A (years) and eye pigmentation p
 * (0 very dark … 1.2 very light blue). Returns 0 outside the validity range 0.1°–100°.
 */
export function cie146(thetaDeg: number, ageYears: number, p: number): number {
  if (thetaDeg < CIE146.minDeg || thetaDeg > CIE146.maxDeg) return 0;
  const t = thetaDeg;
  const ageTerm = 1 + Math.pow(ageYears / CIE146.ageScale, 4);
  return CIE146.c3 / (t * t * t) + (CIE146.c2 / (t * t) + (CIE146.c1 * p) / t) * ageTerm + CIE146.c0 * p;
}

/** Fraction of the light entering the eye that the CIE 146 function scatters into 0.1°…maxDeg. */
export function scatterFraction(ageYears: number, p: number, minDeg: number = CIE146.minDeg, maxDeg: number = CIE146.maxDeg): number {
  // ∫ f(θ) dΩ = ∫ f(θ) 2π sin θ dθ, integrated in log θ for accuracy near the 1/θ³ core.
  const n = 4000;
  const l0 = Math.log(minDeg);
  const l1 = Math.log(maxDeg);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const lt = l0 + ((i + 0.5) / n) * (l1 - l0);
    const tDeg = Math.exp(lt);
    const tRad = (tDeg * Math.PI) / 180;
    const dTheta = tRad * ((l1 - l0) / n); // dθ = θ d(ln θ)
    sum += cie146(tDeg, ageYears, p) * 2 * Math.PI * Math.sin(tRad) * dTheta;
  }
  return sum;
}

/** Watson (2013) mean radial optical MTF at spatial frequency u (cycles/deg) for pupil diameter d (mm). */
export function watsonMTF(u: number, dMm: number): number {
  const u0 = (dMm * Math.PI * 1e6) / (WATSON2013.lambdaNm * 180);
  if (u >= u0) return 0;
  const s = u / u0;
  const diffraction = (2 / Math.PI) * (Math.acos(s) - s * Math.sqrt(1 - s * s));
  const u1 = WATSON2013.u1c0 + WATSON2013.u1c1 * dMm + WATSON2013.u1c2 * dMm * dMm;
  // Watson 2013 Eq. 4/5: the polychromatic mean MTF is sqrt(D(u)) × (1 + (u/u1)²)^-0.62 — the square root of
  // the diffraction-limited MTF (the "diffraction" factor is the square-root term in his formula).
  return Math.sqrt(diffraction) * Math.pow(1 + (u / u1) ** 2, WATSON2013.exponent);
}

/**
 * Equivalent area (deg²) of the optical PSF: 1/PSF(0), with PSF(0) = ∬ MTF d²u = 2π ∫ M(u) u du.
 * A Gaussian with the same peak has σ = √(A/2π). The renderer uses this σ for the footprint of point
 * sources (the "core"), never smaller than a pixel's reconstruction filter.
 */
export function opticalCoreSigmaDeg(dMm: number): number {
  const u0 = (dMm * Math.PI * 1e6) / (WATSON2013.lambdaNm * 180);
  const n = 20000;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const u = ((i + 0.5) / n) * u0;
    s += watsonMTF(u, dMm) * u * (u0 / n);
  }
  const peak = 2 * Math.PI * s; // per deg²
  return Math.sqrt(1 / peak / (2 * Math.PI));
}

/** One level of the renderer's blur pyramid, described by its effective Gaussian σ in full-res pixels. */
export interface PyramidLevel {
  sigmaPx: number;
}

/**
 * Fit non-negative weights w_k so that Σ_k w_k·G(r; σ_k) ≈ f_CIE(θ(r))·Ω_px for r ≥ r_min, where
 * G is a unit-integral 2-D Gaussian (per pixel²) and θ(r) = r·pixelAngle. Least squares on the energy
 * per annulus (2πr·Δr·value), which is what matters visually and for energy conservation.
 * Returns the weights and their sum (the fraction of light the pyramid redistributes).
 */
export function fitScatterKernel(
  levels: PyramidLevel[],
  pixelAngleDeg: number,
  maxRadiusPx: number,
  ageYears: number,
  p: number,
): { weights: number[]; total: number; target: number; fittedInRange: number } {
  const pxSr = (pixelAngleDeg * Math.PI / 180) ** 2;
  const rMin = Math.max(CIE146.minDeg / pixelAngleDeg, 0.5);
  const rMax = Math.min(maxRadiusPx, CIE146.maxDeg / pixelAngleDeg);
  const samples: number[] = [];
  const nS = 400;
  if (rMax <= rMin) return { weights: levels.map(() => 0), total: 0, target: 0, fittedInRange: 0 };
  for (let i = 0; i < nS; i++) samples.push(rMin * Math.pow(rMax / rMin, (i + 0.5) / nS));
  // Design matrix rows: energy in annulus [r_i ± dr/2] (log-spaced), per unit weight.
  const A: number[][] = [];
  const b: number[] = [];
  let target = 0;
  for (let i = 0; i < nS; i++) {
    const r = samples[i];
    const dr = r * Math.log(rMax / rMin) / nS;
    const ring = 2 * Math.PI * r * dr;
    const f = cie146(r * pixelAngleDeg, ageYears, p) * pxSr;
    b.push(f * ring);
    target += f * ring;
    A.push(levels.map((l) => (Math.exp(-(r * r) / (2 * l.sigmaPx * l.sigmaPx)) / (2 * Math.PI * l.sigmaPx * l.sigmaPx)) * ring));
  }
  const weights = nnls(A, b);
  let fittedInRange = 0;
  for (let i = 0; i < nS; i++) for (let k = 0; k < levels.length; k++) fittedInRange += A[i][k] * weights[k];
  // `total` is what the pyramid actually redistributes (including the parts of the narrowest and
  // widest Gaussians that land inside 0.1° or beyond the screen); the composite keeps 1 − total
  // of the light unscattered, so energy is conserved exactly.
  return { weights, total: weights.reduce((s, w) => s + w, 0), target, fittedInRange };
}

/** Lawson–Hanson non-negative least squares for small dense problems: min ‖Ax − b‖ s.t. x ≥ 0. */
export function nnls(A: number[][], b: number[]): number[] {
  const m = A.length;
  const n = A[0]?.length ?? 0;
  const x = new Array<number>(n).fill(0);
  const P = new Set<number>();
  const grad = () => {
    const w = new Array<number>(n).fill(0);
    for (let i = 0; i < m; i++) {
      let r = b[i];
      for (let j = 0; j < n; j++) r -= A[i][j] * x[j];
      for (let j = 0; j < n; j++) w[j] += A[i][j] * r;
    }
    return w;
  };
  const solveP = (): number[] => {
    const idx = [...P];
    const k = idx.length;
    const M = Array.from({ length: k }, () => new Array<number>(k).fill(0));
    const v = new Array<number>(k).fill(0);
    for (let i = 0; i < m; i++) {
      for (let a = 0; a < k; a++) {
        v[a] += A[i][idx[a]] * b[i];
        for (let c = 0; c < k; c++) M[a][c] += A[i][idx[a]] * A[i][idx[c]];
      }
    }
    const sol = solveLinear(M, v);
    const z = new Array<number>(n).fill(0);
    idx.forEach((j, a) => (z[j] = sol[a]));
    return z;
  };
  const scale = Math.max(...b.map(Math.abs), 1e-300);
  for (let outer = 0; outer < 3 * n + 10; outer++) {
    const w = grad();
    let jBest = -1;
    let wBest = 1e-12 * scale;
    for (let j = 0; j < n; j++) if (!P.has(j) && w[j] > wBest) { wBest = w[j]; jBest = j; }
    if (jBest < 0) break;
    P.add(jBest);
    for (let inner = 0; inner < 3 * n + 10; inner++) {
      const z = solveP();
      let ok = true;
      for (const j of P) if (z[j] <= 0) ok = false;
      if (ok) { for (let j = 0; j < n; j++) x[j] = z[j]; break; }
      let alpha = Infinity;
      for (const j of P) if (z[j] <= 0) alpha = Math.min(alpha, x[j] / (x[j] - z[j]));
      for (let j = 0; j < n; j++) x[j] += alpha * (z[j] - x[j]);
      for (const j of [...P]) if (x[j] <= 1e-15) { P.delete(j); x[j] = 0; }
    }
  }
  return x;
}

function solveLinear(M: number[][], v: number[]): number[] {
  const n = v.length;
  const a = M.map((row, i) => [...row, v[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    [a[c], a[p]] = [a[p], a[c]];
    const d = a[c][c] || 1e-300;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r][c] / d;
      for (let k = c; k <= n; k++) a[r][k] -= f * a[c][k];
    }
  }
  return a.map((row, i) => row[n] / (row[i] || 1e-300));
}
