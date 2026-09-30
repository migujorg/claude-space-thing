// Mesopic photometry (CIE 191:2010) and conversion of (photopic, scotopic) quantities into the
// "Blackwell units" in which Crumey's (2014) thresholds are expressed.

import { CIE191, CRUMEY } from './constants';

export interface MesopicResult {
  /** Adaptation coefficient m ∈ [0, 1]: 1 = photopic, 0 = scotopic. */
  m: number;
  /** Mesopic luminance, cd/m² (photopic units when m = 1, scotopic when m = 0). */
  Lmes: number;
}

/**
 * CIE 191:2010 mesopic luminance by the standard's iteration:
 *   L_mes,n = [m_{n−1}·L_p + (1 − m_{n−1})·L_s·V′(λ0)] / [m_{n−1} + (1 − m_{n−1})·V′(λ0)]
 *   m_n = a + b·log10(L_mes,n), clamped to [0, 1]
 * starting from m_0 = 0.5, iterated to convergence.
 */
export function mesopic(Lp: number, Ls: number): MesopicResult {
  const v = CIE191.vPrimeLambda0;
  let m: number = CIE191.m0;
  let Lmes = 0;
  for (let i = 0; i < 100; i++) {
    Lmes = (m * Lp + (1 - m) * Ls * v) / (m + (1 - m) * v);
    const mNew = Lmes > 0 ? Math.min(1, Math.max(0, CIE191.a + CIE191.b * Math.log10(Lmes))) : 0;
    if (Math.abs(mNew - m) < 1e-9) { m = mNew; break; }
    m = mNew;
  }
  Lmes = (m * Lp + (1 - m) * Ls * v) / (m + (1 - m) * v);
  return { m, Lmes };
}

/**
 * Convert a (photopic, scotopic) pair — luminances or illuminances — into the equivalent photopic
 * quantity of Blackwell's 2850 K light, the unit of Crumey's threshold model, at mesopic state m:
 *
 *   Q_bw = L_mes(q_p, q_s; m) / L_mes(1, ρ₂₈₅₀; m) = [m·q_p + (1−m)·V′(λ0)·q_s] / [m + (1−m)·V′(λ0)·ρ₂₈₅₀]
 *
 * At m = 0 this is Crumey's scotopic colour correction q_s/ρ₂₈₅₀ (§1.3); at m = 1 it is the photopic
 * quantity itself. In between it follows the CIE 191 weighting. (Our construction; see eye-model.md §5.)
 */
export function blackwellEquivalent(qp: number, qs: number, m: number): number {
  const v = CIE191.vPrimeLambda0;
  return (m * qp + (1 - m) * v * qs) / (m + (1 - m) * v * CRUMEY.spRatioBlackwell);
}
