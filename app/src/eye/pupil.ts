// Light-adapted pupil diameter: Watson & Yellott (2012), J. Vision 12(10):12, "unified formula".

import { WATSON_YELLOTT as W } from './constants';

/** Stanley & Davies (1995) formula in terms of the corneal flux density F = L·a (cd·m⁻²·deg²). */
export function stanleyDavies(F: number): number {
  const x = Math.pow(Math.max(F, 0) / W.fluxScale, W.exponent);
  return W.dMax - (W.dRange * x) / (x + W.denomOffset);
}

/**
 * Unified formula D_U(L, a, y, e):
 *   F = L·a·M(e),  M(1) = 0.1, M(2) = 1
 *   D_U = D_SD(F, 1) + (y − y0)·(0.021323 − 0.0095623·D_SD(F, 1))
 *
 * @param cornealFlux L·a in cd·m⁻²·deg² — for a non-uniform scene we use the solid-angle integral
 *   of luminance over the rendered field, ∫L dΩ (the "effective corneal flux density" of the paper).
 * @param ageYears observer age y
 * @param eyes 1 (monocular) or 2 (binocular)
 */
export function pupilDiameterMm(cornealFlux: number, ageYears: number, eyes: 1 | 2): number {
  const F = cornealFlux * (eyes === 1 ? W.monocularFactor : 1);
  const dsd = stanleyDavies(F);
  return dsd + (ageYears - W.refAge) * (W.ageSlopeA - W.ageSlopeB * dsd);
}

/** Square degrees per steradian, to turn ∫L dΩ (cd/m²·sr) into cd/m²·deg². */
export const DEG2_PER_SR = (180 / Math.PI) ** 2;
