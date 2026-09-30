// Reflected-light contract (docs/architecture.md §4.3) as the renderer implements it.
//
//   E_obs(α) = albedoXYZS · (1/d²) · (R/Δ)² · Φ(α),   d in AU, R = mean radius, Δ observer distance
//
// Resolved bodies use a spatial reflectance law whose disk integral reproduces E_obs exactly:
//  - kind 'lambert': a Lambert surface of albedo A_L = 1.5·p. A Lambert sphere has geometric albedo
//    p = 2A_L/3 and disk-integrated phase function Φ_L(α) = [sin α + (π − α)·cos α]/π, so this is exact.
//  - measured curves ('poly-mag', 'tabulated'): the same Lambert law, with radiance scaled by
//    Φ_meas(α)/Φ_L(α) so the disk integral equals the measurement. The *spatial* distribution across
//    the disk is then an assumption (labelled by the shell); the disk-integrated brightness is not.
// With albedoXYZS = p·E_sun(1 AU), the Lambert radiance is L = 1.5·albedoXYZS·cos i / (π·d²).

import type { PhaseFunction } from '../data/schema';

export type XYZS = [number, number, number, number];

/** A Lambert sphere's geometric albedo is 2/3 of its Lambert albedo, so A_L = 1.5·p. */
export const LAMBERT_ALBEDO_PER_GEOMETRIC_ALBEDO = 1.5;

/** Disk-integrated phase function of a Lambert sphere, normalised to Φ(0) = 1. */
export function lambertPhase(alpha: number): number {
  const a = Math.min(Math.max(alpha, 0), Math.PI);
  return (Math.sin(a) + (Math.PI - a) * Math.cos(a)) / Math.PI;
}

export type PhaseEval = { ok: true; phi: number } | { ok: false; reason: string };

/**
 * Φ(α) of a measured or modelled phase function. Never extrapolates: outside a published curve's
 * validity range the value is unknown and the caller must treat the surface as not measured.
 */
export function evalPhase(pf: PhaseFunction, alpha: number): PhaseEval {
  const deg = (alpha * 180) / Math.PI;
  switch (pf.kind) {
    case 'lambert':
      return { ok: true, phi: lambertPhase(alpha) };
    case 'poly-mag': {
      if (deg < pf.minDeg || deg > pf.maxDeg) return { ok: false, reason: `phase angle ${deg.toFixed(1)}° outside the curve's validity ${pf.minDeg}–${pf.maxDeg}°` };
      let dm = 0;
      for (let k = pf.coeffs.length - 1; k >= 0; k--) dm = dm * deg + pf.coeffs[k];
      return { ok: true, phi: Math.pow(10, -0.4 * dm) };
    }
    case 'tabulated': {
      const a = pf.alphaDeg;
      const n = a.length;
      if (n === 0 || deg < a[0] || deg > a[n - 1]) return { ok: false, reason: `phase angle ${deg.toFixed(1)}° outside the tabulated range` };
      let i = 0;
      while (i < n - 2 && a[i + 1] < deg) i++;
      const t = a[i + 1] === a[i] ? 0 : (deg - a[i]) / (a[i + 1] - a[i]);
      const dm = pf.deltaMag[i] + t * (pf.deltaMag[i + 1] - pf.deltaMag[i]);
      return { ok: true, phi: Math.pow(10, -0.4 * dm) };
    }
  }
}

/**
 * Radiance scale of the spatial law relative to plain Lambert: Φ_meas/Φ_L (1 for kind 'lambert').
 * Returns null when Φ_L(α) = 0 (exactly back-lit) while the measurement is non-zero — nothing lit
 * is visible then, so no scale exists.
 */
export function spatialScale(pf: PhaseFunction, phiMeasured: number, alpha: number): number | null {
  if (pf.kind === 'lambert') return 1;
  const pl = lambertPhase(alpha);
  if (pl <= 0) return phiMeasured > 0 ? null : 0;
  return phiMeasured / pl;
}

/** Mean radius of a triaxial body, (a+b+c)/3 (the IAU WGCCRE "mean radius" convention). */
export function meanRadius(r: [number, number, number]): number {
  return (r[0] + r[1] + r[2]) / 3;
}

/** Disk-integrated illuminance at the observer (lux, XYZS), architecture §4.3. */
export function diskIlluminance(albedoXYZS: XYZS, dAU: number, radiusKm: number, deltaKm: number, phi: number): XYZS {
  const k = ((radiusKm / deltaKm) ** 2 * phi) / (dAU * dAU);
  return [albedoXYZS[0] * k, albedoXYZS[1] * k, albedoXYZS[2] * k, albedoXYZS[3] * k];
}

/** Prefactor K such that the rendered radiance is L = K·max(cos i, 0) (cd/m², XYZS). */
export function lambertRadianceFactor(albedoXYZS: XYZS, dAU: number, scale: number): XYZS {
  const k = (LAMBERT_ALBEDO_PER_GEOMETRIC_ALBEDO * scale) / (Math.PI * dAU * dAU);
  return [albedoXYZS[0] * k, albedoXYZS[1] * k, albedoXYZS[2] * k, albedoXYZS[3] * k];
}

/**
 * Limb-darkened solar disk: normalise I(μ) = I0·Σ c_k μ^k so that ∫ I dΩ over the visible cap equals
 * E (lux) for a sphere of radius R at distance D. Integrates exactly over the spherical cap.
 */
export function limbDarkenedI0(E: number, coeffs: number[], radiusKm: number, distKm: number): number {
  const sinRho = Math.min(radiusKm / distKm, 1);
  const rho = Math.asin(sinRho);
  const n = 512;
  let integral = 0;
  for (let i = 0; i < n; i++) {
    const th = ((i + 0.5) / n) * rho;
    const b = (distKm * Math.sin(th)) / radiusKm; // impact parameter / R
    const mu = Math.sqrt(Math.max(0, 1 - b * b));
    let p = 0;
    for (let k = coeffs.length - 1; k >= 0; k--) p = p * mu + coeffs[k];
    integral += p * 2 * Math.PI * Math.sin(th) * (rho / n);
  }
  return integral > 0 ? E / integral : 0;
}
