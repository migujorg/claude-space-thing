// Visibility thresholds after Crumey (2014), MNRAS 442, 2600 (arXiv:1405.4209).
//
// All luminances here are in "Blackwell units": photopic cd/m² of a 2850 K source, the light used
// in the experiments the model is fitted to. mesopic.ts converts our (X,Y,Z,S) quantities into this
// frame (Crumey §1.3). Illuminances are lux, solid angles steradians.

import { CRUMEY as C } from './constants';

/** Scotopic-branch point-source threshold ΔI(B), lux (Eq. 32 with Eq. 26). */
export function pointThresholdScotopic(B: number): number {
  const v = C.r1 * Math.pow(B, 0.25) + C.r2 * Math.sqrt(B);
  return v * v;
}

/** Photopic-branch point-source threshold ΔI(B), lux (Eq. 33 with Eq. 27). */
export function pointThresholdPhotopic(B: number): number {
  const v = C.r3 * Math.pow(B, 0.25) + C.r4 * Math.sqrt(B);
  return v * v;
}

/**
 * Full-range point-source threshold ΔI(B), lux (Eq. 34 with Eq. 28), with Crumey's zero-background
 * cut-off: backgrounds below 10⁻⁵ cd/m² are treated as 10⁻⁵ (§2.3). Multiply by the field factor F
 * for practical visibility (Eq. 53).
 */
export function pointThreshold(B: number): number {
  const b = Math.max(B, C.zeroBackgroundB);
  const q = Math.pow(b, 0.25);
  const h = Math.sqrt(b);
  const inner = C.a1 * h + C.a2 * h * q + C.a3 * b;
  const v = Math.sqrt(Math.max(inner, 0)) + C.a4 * q + C.a5 * h;
  return v * v;
}

/** Large-target threshold contrast C∞(B), full-range hyperbola (Eq. 39 with Eq. 40), with the same cut-off. */
export function largeTargetContrast(B: number): number {
  const b = Math.max(B, C.zeroBackgroundB);
  const iq = Math.pow(b, -0.25);
  const inner = C.b1 * iq * iq + C.b2 * iq + C.b3;
  return Math.sqrt(Math.max(inner, 0)) + C.b4 * iq + C.b5;
}

/** Scotopic-branch C∞ (Eq. 35 with Eq. 37). */
export function largeTargetContrastScotopic(B: number): number {
  return C.k1 * Math.pow(B, -0.25) + C.k2;
}

/**
 * Ricco area A_R(B), sr: the intersection of the small- and large-target asymptotes,
 * A_R = R/C∞ = ΔI/ΔB∞ (Eq. 22, Eq. 59), evaluated with the full-range forms and the cut-off.
 * By construction a point of illuminance E is exactly as detectable as a patch of area A_R and
 * luminance E/A_R (Ricco's law); the eye model uses this equivalence for point sources.
 */
export function riccoArea(B: number): number {
  const b = Math.max(B, C.zeroBackgroundB);
  return pointThreshold(b) / (largeTargetContrast(b) * b);
}

/** Apparent V magnitude of an illuminance J (lux): m = −2.5·log10(J/Z_V) (Crumey §1.3). */
export function magnitudeFromLux(J: number): number {
  return -2.5 * Math.log10(J / C.zeroPointVLux);
}

export function luxFromMagnitude(m: number): number {
  return C.zeroPointVLux * Math.pow(10, -0.4 * m);
}

/** Luminance (cd/m²) of a surface brightness μ (mag/arcsec²): μ = 2.5·log10(60⁴(180/π)²·Z/B) (Crumey §1.3). */
export function luminanceFromSurfaceBrightness(mu: number): number {
  const k = Math.pow(60, 4) * Math.pow(180 / Math.PI, 2) * C.zeroPointVLux;
  return k * Math.pow(10, -0.4 * mu);
}

export function surfaceBrightnessFromLuminance(B: number): number {
  const k = Math.pow(60, 4) * Math.pow(180 / Math.PI, 2) * C.zeroPointVLux;
  return 2.5 * Math.log10(k / B);
}
