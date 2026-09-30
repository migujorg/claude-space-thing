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

import type { DiskReflectanceModel, PhaseFunction } from '../data/schema';

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

/**
 * Radius R of the reflected-light contract: the volumetric mean radius (abc)^(1/3) of the triaxial
 * radii (docs/architecture.md §4.3, the convention the `light` stage uses for geometricAlbedoXYZS).
 */
export function meanRadius(r: [number, number, number]): number {
  return Math.cbrt(r[0] * r[1] * r[2]);
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

/** Phase-angle range (degrees) over which a phase function is defined; null = all angles (Lambert). */
export function phaseRangeDeg(pf: PhaseFunction): [number, number] | null {
  switch (pf.kind) {
    case 'lambert':
      return null;
    case 'poly-mag':
      return [pf.minDeg, pf.maxDeg];
    case 'tabulated':
      return pf.alphaDeg.length ? [pf.alphaDeg[0], pf.alphaDeg[pf.alphaDeg.length - 1]] : null;
  }
}

/**
 * Best-estimate continuation of a measured phase curve outside its range (NORTH_STAR 3.2/3.7; used only
 * when the shell allows it): Φ(α) = Φ_meas(α_e)·I(α)/I(α_e), with α_e the nearest end of the measured
 * range and I the disk integral of the body's spatial law (its own phase dependence), so the result is
 * continuous with the measurement at the edge. Returns null when the law has no lit disk at α_e.
 *
 * @param lawIntegral disk-integrated brightness I(α) of the spatial law (e.g. from spatial.ts)
 */
export function extrapolatePhase(pf: PhaseFunction, alpha: number, lawIntegral: (a: number) => number): { phi: number; edgeDeg: number } | null {
  const r = phaseRangeDeg(pf);
  if (!r) return null;
  const edgeDeg = Math.min(Math.max((alpha * 180) / Math.PI, r[0]), r[1]);
  const edge = (edgeDeg * Math.PI) / 180;
  const at = evalPhase(pf, edge);
  if (!at.ok) return null;
  const Ie = lawIntegral(edge);
  if (!(Ie > 0)) return null;
  return { phi: (at.phi * lawIntegral(alpha)) / Ie, edgeDeg };
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

/**
 * ROLO whole-disk reflectance A_c (Kieffer & Stone 2005, Eq. 10; product kind 'rolo-v1', formula in
 * photometry.json and architecture §4.3), per channel X, Y, Z, S:
 *   ln A_c = Σ a_i g^i + b1 Φ + b2 Φ³ + b3 Φ⁵ + c1 θ + c2 φ + c3 Φ θ + c4 Φ φ
 *            + d1 exp(−g°/p1) + d2 exp(−g°/p2) + d3 cos((g° − p3)/p4)
 * g phase angle and Φ the Sun's selenographic longitude (east positive) in radians in the polynomial
 * terms; g° in degrees in the exponential and cosine terms (the cosine's argument then in radians);
 * θ, φ the observer's selenographic latitude and longitude in degrees. Returns null outside the model's
 * domain (phase range, observer libration range).
 */
export function roloReflectance(m: DiskReflectanceModel, gDeg: number, sunLonDeg: number, obsLatDeg: number, obsLonDeg: number): XYZS | null {
  if (!(gDeg >= m.minPhaseDeg && gDeg <= m.maxPhaseDeg)) return null;
  if (!(Math.abs(obsLatDeg) <= m.maxObserverLatitudeDeg && Math.abs(obsLonDeg) <= m.maxObserverLongitudeDeg)) return null;
  const g = (gDeg * Math.PI) / 180;
  const P = (sunLonDeg * Math.PI) / 180;
  const [c1, c2, c3, c4] = m.c;
  const [p1, p2, p3, p4] = m.p;
  const lib = c1 * obsLatDeg + c2 * obsLonDeg + c3 * P * obsLatDeg + c4 * P * obsLonDeg;
  return [0, 1, 2, 3].map((k) => {
    const [a0, a1, a2, a3] = m.a[k];
    const [b1, b2, b3] = m.b[k];
    const [d1, d2, d3] = m.d[k];
    const lnA = a0 + a1 * g + a2 * g * g + a3 * g * g * g + b1 * P + b2 * P ** 3 + b3 * P ** 5 + lib
      + d1 * Math.exp(-gDeg / p1) + d2 * Math.exp(-gDeg / p2) + d3 * Math.cos((gDeg - p3) / p4);
    return Math.exp(lnA);
  }) as XYZS;
}

type Vec3 = [number, number, number];

/**
 * Geometry for roloReflectance from the renderer's vectors: the Sun's selenographic longitude and the
 * sub-observer latitude/longitude (degrees) in the body-fixed frame `orient` (body-fixed → ICRF,
 * row-major), from the directions `toSun` and `toObserver` (ICRF, from the body centre).
 */
export function selenographicGeometry(orient: readonly number[], toSun: Vec3, toObserver: Vec3): { sunLonDeg: number; obsLatDeg: number; obsLonDeg: number } {
  const bf = (v: Vec3) => {
    const l = Math.hypot(v[0], v[1], v[2]);
    return [0, 1, 2].map((j) => (orient[j] * v[0] + orient[3 + j] * v[1] + orient[6 + j] * v[2]) / l); // orientᵀ·v
  };
  const s = bf(toSun), o = bf(toObserver);
  const deg = 180 / Math.PI;
  return {
    sunLonDeg: Math.atan2(s[1], s[0]) * deg,
    obsLatDeg: Math.asin(Math.max(-1, Math.min(1, o[2]))) * deg,
    obsLonDeg: Math.atan2(o[1], o[0]) * deg,
  };
}

/**
 * p·Φ per channel (what albedoXYZS·Φ(α) gives, "lux at 1 AU" for the contract's mean radius R) from a
 * body's disk reflectance model, or null when it has none or the geometry is outside its domain:
 * A_c·E☉,c(1 AU)·(radiusKm/R)² (architecture §4.3).
 */
export function diskModelPPhi(
  m: DiskReflectanceModel | null | undefined, orient: readonly number[] | null, meanRadiusKm: number,
  toSun: Vec3, toObserver: Vec3, sunIrradianceXYZS_1AU: readonly number[] | null,
): XYZS | null {
  if (!m || m.kind !== 'rolo-v1' || !orient || !sunIrradianceXYZS_1AU) return null;
  const ls = Math.hypot(...toSun), lo = Math.hypot(...toObserver);
  const cosg = (toSun[0] * toObserver[0] + toSun[1] * toObserver[1] + toSun[2] * toObserver[2]) / (ls * lo);
  const gDeg = (Math.acos(Math.max(-1, Math.min(1, cosg))) * 180) / Math.PI;
  const geo = selenographicGeometry(orient, toSun, toObserver);
  const A = roloReflectance(m, gDeg, geo.sunLonDeg, geo.obsLatDeg, geo.obsLonDeg);
  if (!A) return null;
  const k = (m.radiusKm / meanRadiusKm) ** 2;
  return A.map((a, c) => a * sunIrradianceXYZS_1AU[c] * k) as XYZS;
}
