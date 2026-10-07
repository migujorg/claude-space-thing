// Earth's appearance from its measured layers (docs/rendering-earth.md): the surface from a map of
// surface-only absolute reflectance, sea ice, clouds from their retrieved optical thickness, and night
// lights from their emitted radiance. This module is the reference implementation. EARTH_WGSL
// (shaders-earth.ts) mirrors it line by line, and the disk-integral check (tests) uses it.
//
// Radiance factor ρ: L = (E_sun/π)·ρ, with E_sun the solar illuminance on a surface normal to the Sun,
// so a Lambert surface of reflectance R has ρ = R·μ0.

import { CLOUD_G_ICE, CLOUD_G_LIQUID, COX_MUNK_MAX_WIND, COX_MUNK_SIGMA2, SEA_ICE_ALBEDO_VIS, SEA_WATER_N, WIND_12_5_PER_10 } from '../core/constants';
export { CLOUD_G_ICE, CLOUD_G_LIQUID, COX_MUNK_MAX_WIND, COX_MUNK_SIGMA2, SEA_ICE_ALBEDO_VIS, SEA_WATER_N, WIND_12_5_PER_10 } from '../core/constants';

/**
 * The night layer's radiance → luminance conversion: CIE HP1 (high-pressure sodium) from the layer
 * header's constants.toXYZS. The alternative there, CIE LED-B3 (4000 K LED), differs by 3 % in Y and
 * mostly in colour. The lamp spectrum is not measured, so night-light colour is estimated.
 */
export const NIGHT_LAMP = 'HP1';

/** Fresnel reflectance of unpolarised light at a dielectric interface (Cox & Munk 1954 Eq. 10). */
export function fresnel(cosI: number, n = SEA_WATER_N): number {
  const c = Math.min(Math.max(cosI, 0), 1);
  const sinT2 = (1 - c * c) / (n * n);
  if (sinT2 >= 1) return 1;
  const cosT = Math.sqrt(1 - sinT2);
  const rs = (c - n * cosT) / (c + n * cosT);
  const rp = (n * c - cosT) / (n * c + cosT);
  return 0.5 * (rs * rs + rp * rp);
}
/** Fresnel reflectance for isotropic diffuse light, 2∫ρ_F(μ)μ dμ (derived, ≈ 0.066). */
export const FRESNEL_DIFFUSE = (() => {
  let a = 0;
  const n = 4000;
  for (let i = 0; i < n; i++) { const mu = (i + 0.5) / n; a += (2 * fresnel(mu) * mu) / n; }
  return a;
})();

/** erfc(x) for x ≥ 0 (Abramowitz & Stegun 1964, 7.1.26; |error| ≤ 1.5·10⁻⁷). */
export function erfc(x: number): number {
  const t = 1 / (1 + 0.3275911 * x);
  return t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x);
}
/**
 * Smith's (1967) shadowing term Λ for Gaussian slopes of total variance σ², seen at cosine μ:
 * Λ = [e^{−ν²}/(ν√π) − erfc(ν)]/2, ν = μ/(σ√(1 − μ²)).
 */
export function smithLambda(mu: number, s2: number): number {
  if (mu >= 1) return 0;
  const nu = mu / Math.sqrt(s2 * (1 - mu * mu));
  if (nu > 6) return 0;
  return (Math.exp(-nu * nu) / (nu * Math.sqrt(Math.PI)) - erfc(nu)) / 2;
}
/** Bidirectional shadowing of the sea surface, 1/(1 + Λ(μ0) + Λ(μ)) (Sancer 1969, used by ocean glint models since). */
export function seaShadowing(mu0: number, mu: number, s2: number): number {
  return 1 / (1 + smithLambda(Math.max(mu0, 1e-6), s2) + smithLambda(Math.max(mu, 1e-6), s2));
}

/**
 * Sun glint radiance factor (L = (E/π)·ρ) of a wind-roughened sea (Cox & Munk 1954 Eq. 9, N = ρ(ω)·p·H /
 * (4 cos μ cos⁴β), with the isotropic slope density p = e^{−tan²β/σ²}/(πσ²)): facets tilted by β (cos β = h·N,
 * h the half vector of the Sun and view directions) reflect the direct beam at incidence ω (cos ω = h·S).
 * Times the facets' mutual shadowing (seaShadowing), without which the radiance diverges at grazing angles.
 */
export function glintRadianceFactor(cosBeta: number, mu: number, cosOmega: number, u10: number, mu0 = 1): number {
  if (!(cosBeta > 0) || !(mu > 0) || !Number.isFinite(u10)) return 0;
  const s2 = COX_MUNK_SIGMA2.a + COX_MUNK_SIGMA2.b * Math.max(u10, 0) * WIND_12_5_PER_10;
  return glintOf(cosBeta, mu, cosOmega, s2, mu0);
}
function glintOf(cosBeta: number, mu: number, cosOmega: number, s2: number, mu0: number): number {
  const c2 = cosBeta * cosBeta;
  const tan2 = (1 - c2) / c2;
  return (fresnel(cosOmega) * Math.exp(-tan2 / s2) * seaShadowing(mu0, mu, s2)) / (4 * s2 * mu * c2 * c2);
}

/**
 * The largest glint radiance factor any wind within Cox & Munk's measured range (0–13.8 m/s) could give at
 * this geometry: e^{−t/σ²}/σ² peaks at σ² = t = tan²β, clamped to the range. Where the wind is unknown
 * and this exceeds the known light of the water, the pixel is marked unknown.
 */
export function glintMaxRadianceFactor(cosBeta: number, mu: number, cosOmega: number, mu0 = 1): number {
  if (!(cosBeta > 0) || !(mu > 0)) return 0;
  const c2 = cosBeta * cosBeta;
  const tan2 = (1 - c2) / c2;
  const s2 = Math.min(Math.max(tan2, COX_MUNK_SIGMA2.a), COX_MUNK_SIGMA2.a + COX_MUNK_SIGMA2.b * COX_MUNK_MAX_WIND);
  return glintOf(cosBeta, mu, cosOmega, s2, mu0);
}

/** 4-point Gauss–Legendre nodes and weights on [0, 1] (for the hemispheric integrals). */
export const GAUSS4_X = [0.0694318442029737, 0.330009478207572, 0.669990521792428, 0.930568155797026];
export const GAUSS4_W = [0.173927422568727, 0.326072577431273, 0.326072577431273, 0.173927422568727];

/**
 * Escape function of a thick, non-absorbing layer, u(μ) ≈ (3/7)(1 + 2μ) (van de Hulst 1980;
 * Kokhanovsky 2004): the angular distribution of the diffuse light leaving a cloud. It is normalised so
 * that 2∫u(μ)μ dμ = 1, i.e. a Lambert surface has u = 1.
 */
export function escape(mu: number): number {
  return (3 / 7) * (1 + 2 * mu);
}

export interface CloudLayerOptics {
  /** Plane albedo for the direct solar beam at μ0 (δ-Eddington, conservative). */
  R0: number;
  /** Spherical (diffuse-incidence) albedo r̄ = 2∫R(μ)μ dμ; its diffuse transmission is 1 − r̄. */
  rbar: number;
  /** Direct (unscattered) transmission along the view, e^{−τ'/μ}. */
  tView: number;
  /** Diffuse transmission of a Lambert source below into the view direction, per the escape function. */
  tViewDiffuse: number;
}

/**
 * δ-Eddington plane albedo of a conservative (non-absorbing) layer of optical thickness τ and asymmetry g,
 * for collimated light at μ0 over a black surface (Joseph, Wiscombe & Weinman 1976). δ-scaling:
 * τ' = (1 − g²)τ, g' = g/(1 + g), so (1 − g')τ' = (1 − g)τ. The conservative Eddington solution (derived in
 * docs/rendering-earth.md §3) is
 *   R(μ0) = [(1 − g)τ + (2/3 − μ0)(1 − e^{−τ'/μ0})] / [4/3 + (1 − g)τ].
 */
export function cloudPlaneAlbedo(tau: number, g: number, mu0: number): number {
  const tt = (1 - g) * tau;
  const tp = (1 - g * g) * tau;
  const m = Math.max(mu0, 1e-4);
  const R = (tt + (2 / 3 - m) * (1 - Math.exp(-tp / m))) / (4 / 3 + tt);
  return Math.min(Math.max(R, 0), 1);
}

export function cloudOptics(tau: number, g: number, mu0: number, mu: number): CloudLayerOptics {
  let rbar = 0;
  let tdir = 0;
  const tp = (1 - g * g) * tau;
  for (let k = 0; k < 4; k++) {
    const x = GAUSS4_X[k];
    rbar += 2 * GAUSS4_W[k] * x * cloudPlaneAlbedo(tau, g, x);
    tdir += 2 * GAUSS4_W[k] * x * Math.exp(-tp / x);
  }
  const tView = Math.exp(-tp / Math.max(mu, 1e-4));
  const tbar = 1 - rbar;
  return { R0: cloudPlaneAlbedo(tau, g, mu0), rbar, tView, tViewDiffuse: Math.max(tbar - tdir, 0) * escape(mu) };
}

export type XYZS = [number, number, number, number];

/** What the layers say at one surface point (NaN = unknown, as in the layers). */
export interface EarthSample {
  /** Absolute surface reflectance (texel × absoluteDiskMean), XYZS; null where the map is unknown. */
  surface: XYZS | null;
  waterFraction: number;
  seaIceFraction: number;
  cloudFraction: number;
  opticalThickness: number;
  iceFraction: number;
  /** Emitted radiance (DNB, nW cm⁻² sr⁻¹) and its luminance factors (cd/m² per unit), XYZS. */
  nightRadiance?: number;
  /** 10 m wind speed over open water (m/s); NaN or absent: unknown (no glint, and marked unknown in the glint zone). */
  windSpeed?: number;
  /**
   * The bound thickness layer, cloudTau or cloudTauEstimated (area-weighted sums over the texel's cells; NaN =
   * unknown): the share of the texel that is cloud with a thickness f_τ ≤ cloudFraction, Σ a·ln τ, Σ a·(ln τ)², and
   * the share that is ice cloud with a thickness. When known it replaces opticalThickness and iceFraction
   * (cloudLogNormal).
   */
  tauMoments?: { fTau: number; m1: number; m2: number; iceTau: number };
  /**
   * A τ population for the cloud without a thickness (cloudFraction − f_τ), from a statistic in the cloudTau
   * header (unmeasuredTauPopulation; estimated). The present cloud layers carry none: absent or null, that cloud
   * stays unknown, which is the rule at every reality level (docs/rendering-earth.md §2).
   */
  unmeasuredTau?: CloudPopulation | null;
}

/** A cloud population as τ nodes with probabilities (summing to 1), each node a sub-pixel of its own. */
export interface CloudPopulation {
  taus: number[];
  p: number[];
}

/**
 * A cloudTau header's statistic for cloud without a retrieval, where a header has one (the present Earth layers do
 * not: their cloud without a thickness is not measured at any level): constants.unmeasuredTau, the measured τ
 * distribution of MODIS partly cloudy pixels (Pincus et al. 2023, Fig. 7; docs/rendering-earth.md §3), as
 * constants.use.unmeasuredShare prescribes. The partly-cloudy, all-heights histogram
 * (statistics.floorCellsZero.partlyCloudyAllHeights) is used bin by bin, τ_k = exp(tauBinLnCentre[k]). No
 * fitted shape is used: the log-normal through the same moments is 6–10 % brighter at high Sun, because the
 * histogram has no mass above τ = 23. Empty bins are dropped and the probabilities renormalized. null when the
 * header has no usable statistic.
 */
export function unmeasuredTauPopulation(header: unknown): (CloudPopulation & { label: string }) | null {
  const u = (header as { constants?: { unmeasuredTau?: Record<string, unknown> } } | null)?.constants?.unmeasuredTau;
  if (!u) return null;
  const value = u.value;
  if (!value || typeof value !== 'object') return null;
  const payload = value as Record<string, unknown>;
  const ln = payload.tauBinLnCentre;
  const stats = payload.statistics as Record<string, Record<string, { binProbability?: unknown }>> | undefined;
  const pr = stats?.floorCellsZero?.partlyCloudyAllHeights?.binProbability;
  if (!Array.isArray(ln) || !Array.isArray(pr) || ln.length !== pr.length || ln.length === 0) return null;
  if (!ln.every((x) => typeof x === 'number' && fin(x)) || !pr.every((x) => typeof x === 'number' && fin(x) && x >= 0)) return null;
  const sum = (pr as number[]).reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return null;
  const taus: number[] = [], p: number[] = [];
  (pr as number[]).forEach((x, k) => {
    if (x > 0) { taus.push(Math.exp(ln[k] as number)); p.push(x / sum); }
  });
  if (taus.length > MAX_POPULATION_NODES) return null;
  return { taus, p, label: typeof u.label === 'string' ? u.label : 'unknown' };
}

/** Nodes of a cloud population the renderer holds per body (struct Body unTau/unP in shaders.ts). */
export const MAX_POPULATION_NODES = 8;

/** Plane albedo of a population over a black surface, R̄(μ0) = Σ p_k R(τ_k) (the header's planeAlbedoLiquid check). */
export function populationPlaneAlbedo(pop: CloudPopulation, g: number, mu0: number): number {
  return pop.taus.reduce((a, t, k) => a + pop.p[k] * cloudPlaneAlbedo(t, g, mu0), 0);
}

/** Nodes and weights of the 3-point Gauss–Hermite rule for a normal variable: μ, μ ± √3σ with 2/3, 1/6, 1/6. */
export const LOGNORMAL_NODES = [0, Math.sqrt(3), -Math.sqrt(3)];
export const LOGNORMAL_WEIGHTS = [2 / 3, 1 / 6, 1 / 6];

/**
 * The retrieved cloud as a log-normal distribution of τ from the cloudTau moments: its share of the texel f_τ,
 * mean ln τ = m1/f_τ, var ln τ = m2/f_τ − mean² (≥ 0), the ice share among the retrievals, and the three τ nodes
 * (weights LOGNORMAL_WEIGHTS). null when the moments are unknown.
 */
export function cloudLogNormal(t: EarthSample['tauMoments'], cloudFraction: number): { f: number; taus: number[]; ice: number } | null {
  if (!t || !fin(t.fTau) || !fin(t.m1) || !fin(t.m2) || !fin(cloudFraction)) return null;
  const f = Math.min(Math.max(t.fTau, 0), Math.max(cloudFraction, 0));
  if (!(f > 0)) return { f: 0, taus: [0, 0, 0], ice: 0 };
  const mu = t.m1 / t.fTau;
  const sd = Math.sqrt(Math.max(t.m2 / t.fTau - mu * mu, 0));
  const ice = fin(t.iceTau) ? Math.min(Math.max(t.iceTau / t.fTau, 0), 1) : 0;
  return { f, taus: LOGNORMAL_NODES.map((x) => Math.exp(mu + x * sd)), ice };
}

/** Sun–view geometry for the glint: cos β = h·N and cos ω = h·S with h the half vector of S and V. */
export interface GlintGeometry { cosBeta: number; cosOmega: number }

export interface EarthShade {
  /** Share of the pixel whose emitted light (night lights) cannot be transmitted to the viewer: unknown cloud state. */
  gapEmit: number;
  /** Radiance factor ρ (XYZS) for the direct Sun, no atmosphere: L = (E/π)·ρ. */
  rho: XYZS;
  /**
   * Transmission of light emitted at the surface (night lights) to the viewer, through the clouds
   * (including multiple reflection between clouds and surface).
   */
  emitT: XYZS;
  /**
   * Share of the pixel whose reflected light is unknown (surface map gap under clear sky, cloud state
   * unknown, wind unknown in the glint zone). It matters only where the pixel is lit.
   */
  gap: number;
}

/** One part of the pixel (clear or cloudy) for the atmosphere's composition (earth.ts earthParts). */
export interface EarthPart {
  /** Share of the pixel. */
  w: number;
  /** Radiance factor for the direct solar beam (includes μ0): L = (E/π)·dir. */
  dir: XYZS;
  /** Radiance factor per unit diffuse (sky) irradiance E_d: L = (E_d/π)·dif. */
  dif: XYZS;
  /** Transmission of surface emission to the viewer. */
  emit: XYZS;
  /** The transmitted surface part of dir/dif, to be lit through the whole air column. */
  surfaceDir: XYZS;
  surfaceDif: XYZS;
  /** Lower-air path transmission: down through the cloud (direct/diffuse), then unscattered up. */
  lowerDirect: number;
  lowerDiffuse: number;
}

const fin = (x: number) => Number.isFinite(x);

/**
 * One surface point seen at μ (cosine of the view zenith) and lit at μ0, split into its clear part (a Lambert
 * surface with sea ice) and its cloudy part (cloud reflection with the escape-function angular
 * distribution, plus the surface seen through the cloud, including multiple reflection between the cloud
 * base and the surface), each for direct sunlight and for diffuse skylight.
 */
export interface EarthPartsOut {
  clear: EarthPart;
  cloudy: EarthPart;
  gap: number;
  gapEmit: number;
  /**
   * Where the wind is unknown over open water in sunlight: the share of the pixel (clear open water) and
   * the largest glint radiance factor a measured wind could give there. The caller marks that share
   * unknown when this glint could outshine the pixel's known light (earthGlintGap).
   */
  glintUnknown: { share: number; maxRho: number };
}

export function earthParts(s: EarthSample, mu0: number, mu: number, glint?: GlintGeometry): EarthPartsOut {
  let gap = 0;
  // Sea ice covers seaIceFraction of the water part (NaN: no ice analysed there, i.e. none).
  const fw = fin(s.waterFraction) ? Math.min(Math.max(s.waterFraction, 0), 1) : 0;
  const fi = fin(s.seaIceFraction) ? Math.min(Math.max(s.seaIceFraction, 0), 1) : 0;
  const ai = fw * fi;
  const Rs: XYZS = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) Rs[c] = ai * SEA_ICE_ALBEDO_VIS + (1 - ai) * (s.surface ? s.surface[c] : 0);
  const surfaceGap = s.surface ? 0 : 1 - ai;
  // Clouds: unknown fraction → treated as clear and marked unknown.
  let C = s.cloudFraction;
  if (!fin(C)) { C = 0; gap = 1; }
  C = Math.min(Math.max(C, 0), 1);
  // The cloud's optical thickness, as populations of τ nodes (each node a sub-pixel of its own, independent pixels):
  // with the thickness layer's moments, the share f_τ as a log-normal in τ (three nodes); the rest of the cloud,
  // C − f_τ, has no thickness: no reflected light, marked unknown (a population for it is taken only where a header
  // provides one; the present layers provide none). Without the moments, the clouds layer's mean τ over the whole
  // cloud (unknown where NaN).
  const ln = cloudLogNormal(s.tauMoments, C);
  const pops: { w: number; taus: number[]; wts: number[]; fice: number }[] = [];
  if (ln) {
    pops.push({ w: ln.f, taus: ln.taus, wts: LOGNORMAL_WEIGHTS, fice: ln.ice });
    const rest = C - ln.f;
    if (rest > 0 && s.unmeasuredTau) pops.push({ w: rest, taus: s.unmeasuredTau.taus, wts: s.unmeasuredTau.p, fice: 0 });
    else gap = Math.max(gap, rest);
  } else {
    const tau = s.opticalThickness;
    const fice = fin(s.iceFraction) ? Math.min(Math.max(s.iceFraction, 0), 1) : 0;
    if (C > 0 && !fin(tau)) gap = Math.max(gap, C);
    else pops.push({ w: C, taus: [Math.max(tau, 0)], wts: [1], fice });
  }
  const cloudy = pops.reduce((a, q) => a + q.w, 0);
  // What stays unknown for light emitted at the surface: the cloud state and the cloud of unknown thickness.
  const gapEmit = gap;
  const clearW = 1 - C;
  gap = Math.max(gap, clearW * surfaceGap);
  const m0 = Math.max(mu0, 0);
  // Open water: the specular Fresnel reflection of the Sun (glint, Cox & Munk) and of the sky (as isotropic
  // diffuse light, FRESNEL_DIFFUSE); the map holds only the water-leaving part.
  const ow = fw * (1 - fi);
  const u = s.windSpeed ?? NaN;
  const rg = glint && ow > 0 && mu0 > 0 ? glintRadianceFactor(glint.cosBeta, mu, glint.cosOmega, u, mu0) : 0;
  const glintUnknown = glint && ow > 0 && mu0 > 0 && !fin(u)
    ? { share: clearW * ow, maxRho: glintMaxRadianceFactor(glint.cosBeta, mu, glint.cosOmega, mu0) }
    : { share: 0, maxRho: 0 };
  const clear: EarthPart = { w: clearW, dir: Rs.map((r) => r * m0 + ow * rg) as XYZS, dif: Rs.map((r) => r + ow * FRESNEL_DIFFUSE) as XYZS, emit: [1, 1, 1, 1], surfaceDir: [0, 0, 0, 0], surfaceDif: [0, 0, 0, 0], lowerDirect: 0, lowerDiffuse: 0 };
  const cl: EarthPart = { w: cloudy, dir: [0, 0, 0, 0], dif: [0, 0, 0, 0], emit: [0, 0, 0, 0], surfaceDir: [0, 0, 0, 0], surfaceDif: [0, 0, 0, 0], lowerDirect: 0, lowerDiffuse: 0 };
  // Each τ node is a sub-pixel of its own (independent pixel approximation), weighted by its share of the cloud.
  if (cloudy > 0) for (const q of pops) for (let k = 0; k < q.taus.length; k++) {
    const tau = q.taus[k], wk = (q.w / cloudy) * q.wts[k];
    if (!(wk > 0)) continue;
    const g = (1 - q.fice) * CLOUD_G_LIQUID + q.fice * CLOUD_G_ICE;
    const o = cloudOptics(tau, g, mu0, mu);
    const through = o.tView + o.tViewDiffuse;
    // The glint seen through a thin cloud: the unscattered beam both ways.
    const tp = (1 - g * g) * tau;
    const glintThrough = ow * rg * Math.exp(-tp / Math.max(m0, 1e-4)) * o.tView;
    // Lower-air radiance is directional, so retain only its unscattered second passage through the cloud.
    // Downward direct/diffuse flux uses the conservative two-stream transmission. Angular redistribution
    // on that downward passage and cloud/air feedback on the precomputed multiple-scattering field are neglected.
    cl.lowerDirect += wk * (1 - o.R0) * o.tView;
    cl.lowerDiffuse += wk * (1 - o.rbar) * o.tView;
    for (let c = 0; c < 4; c++) {
      const multi = 1 / (1 - Rs[c] * o.rbar);
      const surfaceDir = m0 * (1 - o.R0) * multi * Rs[c] * through + glintThrough;
      // Water's Fresnel skylight also belongs below the cloud (and must survive the zero-τ limit).
      const surfaceDif = (1 - o.rbar) * multi * (Rs[c] + ow * FRESNEL_DIFFUSE) * through;
      cl.surfaceDir[c] += wk * surfaceDir;
      cl.surfaceDif[c] += wk * surfaceDif;
      cl.dir[c] += wk * (m0 * o.R0 * escape(mu) + surfaceDir);
      cl.dif[c] += wk * (o.rbar * escape(mu) + surfaceDif);
      cl.emit[c] += wk * multi * through;
    }
  }
  return { clear, cloudy: cl, gap, gapEmit, glintUnknown };
}

/** The unknown share from an unknown wind: marked where the possible glint exceeds the known light (radiance factors, Y). */
export function earthGlintGap(g: EarthPartsOut['glintUnknown'], knownRhoY: number): number {
  return g.share > 0 && g.maxRho > knownRhoY ? g.share : 0;
}

/** Without an atmosphere: the direct-Sun radiance factor and emission transmission of the whole pixel. */
export function earthShade(s: EarthSample, mu0: number, mu: number, glint?: GlintGeometry): EarthShade {
  const { clear, cloudy, gap, gapEmit, glintUnknown } = earthParts(s, mu0, mu, glint);
  const rho = [0, 1, 2, 3].map((c) => clear.w * clear.dir[c] + cloudy.w * cloudy.dir[c]) as XYZS;
  const emitT = [0, 1, 2, 3].map((c) => clear.w * clear.emit[c] + cloudy.w * cloudy.emit[c]) as XYZS;
  return { rho, emitT, gap: Math.max(gap, earthGlintGap(glintUnknown, rho[1])), gapEmit };
}

/** Per-bin atmospheric illumination at the ground and cloud top, per unit solar irradiance. */
export interface EarthIllumination {
  ts0: ArrayLike<number>; es0: ArrayLike<number>;
  tsc: ArrayLike<number>; esc: ArrayLike<number>;
}
/** CPU reference of shaders.ts EARTH_WITH_ATMOSPHERE; returns πL/E_sun (XYZS). */
export function earthAtmosphereRadiance(pr: EarthPartsOut, path: {
  L: ArrayLike<number>; Lc: ArrayLike<number>; Td: ArrayLike<number>; Tcd: ArrayLike<number>;
}, light: EarthIllumination, weights: ArrayLike<ArrayLike<number>>, mu0: number): XYZS {
  const unknownW = Math.max(1 - pr.clear.w - pr.cloudy.w, 0);
  const out: XYZS = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) {
    let fullPath = 0, upperPath = 0, directTop = 0, diffuseTop = 0;
    for (let k = 0; k < path.L.length; k++) {
      const w = weights[c][k];
      fullPath += w * path.L[k]; upperPath += w * path.Lc[k];
      directTop += w * light.tsc[k]; diffuseTop += w * light.esc[k];
    }
    out[c] = Math.PI * ((pr.clear.w + unknownW) * fullPath + pr.cloudy.w * upperPath);
    for (let k = 0; k < path.L.length; k++) {
      const clearRad = path.Td[k] * (pr.clear.dir[c] * light.ts0[k] + pr.clear.dif[c] * light.es0[k]);
      const cloudRad = path.Tcd[k] * ((pr.cloudy.dir[c] - pr.cloudy.surfaceDir[c]) * light.tsc[k]
        + (pr.cloudy.dif[c] - pr.cloudy.surfaceDif[c]) * light.esc[k])
        + path.Td[k] * (pr.cloudy.surfaceDir[c] * light.ts0[k] + pr.cloudy.surfaceDif[c] * light.es0[k]);
      out[c] += weights[c][k] * (pr.clear.w * clearRad + pr.cloudy.w * cloudRad);
    }
    // Existing path tables contain combined single/multiple scattering, already folded on the GPU.
    // Approximate their illumination mixture by the direct/diffuse horizontal irradiance at cloud top.
    // If the local Sun is below the horizon, use diffuse transmission for twilight path light.
    // This keeps the clear-air spectral path at τ=0, without adding a new table or scattering parameter.
    const beam = Math.max(mu0, 0) * directTop;
    const total = beam + diffuseTop;
    const lowerT = total > 0 ? (pr.cloudy.lowerDirect * beam + pr.cloudy.lowerDiffuse * diffuseTop) / total : pr.cloudy.lowerDiffuse;
    out[c] += Math.PI * pr.cloudy.w * Math.max(fullPath - upperPath, 0) * lowerT;
  }
  return out;
}
