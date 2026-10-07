// Tone reproduction after Pattanaik, Tumblin, Yee & Greenberg (2000), "Time-dependent visual
// adaptation for fast realistic image display" (SIGGRAPH 2000): a forward model of the scene
// observer's rod and cone responses (Naka–Rushton with Hunt's semi-saturation and bleaching terms),
// an appearance model (reference white/black), and the inverse pair for the display observer.
// Eye model v1: the rod path is Hunt's own (F_LS, B_S), not Pattanaik's Eq. 4/6 (see HUNT in constants.ts).
//
// This file is the reference implementation (float64, used by tests and on the CPU for per-frame
// scalars). The per-pixel part is mirrored in WGSL (app/src/render/shaders.ts); keep them in sync.

import { CRUMEY, HUNT as H, PATTANAIK as P, XYZ_TO_HPE } from './constants';

export function sigmaCone(A: number): number {
  const a = Math.max(A, 1e-12);
  const k = 1 / (P.coneKScale * a + 1);
  const k4 = k * k * k * k;
  return (P.coneSigmaNum * a) / (k4 * a + P.coneSigmaPow * (1 - k4) * (1 - k4) * Math.cbrt(a));
}

/**
 * Hunt's scotopic luminance-level adaptation factor F_LS (constants.ts HUNT). A = L_AS, scotopic cd/m².
 */
export function huntFLS(A: number): number {
  const x = (5 * Math.max(A, 1e-12)) / H.scotopicScale;
  const j = H.flsJ / (x + H.flsJ);
  const j2 = j * j;
  return H.flsJ2 * j2 * x + H.flsPow * Math.pow(1 - j2, H.flsExpJ) * Math.pow(x, 1 / 6);
}

/**
 * Hunt's rod response f_n(F_LS·S/S_w)/40 with reference white S_w = 5·A, written in Naka–Rushton
 * form: semi-saturation σ_rod = 5·A·2^(1/n)/F_LS(A) (the cone path has the same structure, with F_L).
 */
export function sigmaRod(A: number): number {
  const a = Math.max(A, 1e-12);
  return (P.refWhiteFactor * a * Math.pow(H.fnHalf, 1 / P.n)) / huntFLS(a);
}

/** Adaptation-dependent part of Hunt's rod saturation B_S: 0.5/(1 + 5·(5·L_AS/2.26)). */
export function rodSaturationAdapt(A: number): number {
  return 0.5 / (1 + H.bsB * ((5 * A) / H.scotopicScale));
}

/** Stimulus-dependent part of B_S: 0.5/(1 + 0.3·((5·L_AS/2.26)·S/S_w)^0.3), with S_w = 5·L_AS. */
export function rodSaturationStimulus(S: number): number {
  return 0.5 / (1 + H.bsA * Math.pow(Math.max(S, 0) / H.scotopicScale, H.bsExp));
}

export function bleachCone(A: number): number {
  return P.coneBleachHalf / (P.coneBleachHalf + A);
}

/** Naka–Rushton response B·Lⁿ/(Lⁿ + σⁿ) (Eq. 2), written to avoid overflow. */
export function response(L: number, sigma: number, B: number): number {
  if (!(L > 0)) return 0;
  return B / (1 + Math.pow(sigma / L, P.n));
}

/** Adaptation-dependent parameters of one observer (scene or display). */
export interface ObserverState {
  /** Cone (photopic, cd/m²) and rod (scotopic cd/m²) adaptation luminances. */
  Acone: number;
  Arod: number;
  sigmaCone: number;
  sigmaRod: number;
  Bcone: number;
  /** Adaptation-dependent part of Hunt's rod saturation (the stimulus part is per pixel). */
  BrodAdapt: number;
}

/**
 * @param coneBleaching whether to apply Hunt's steady-state cone bleaching amplitude (Eq. 6). The
 *   eye model v0 disables it; see docs/eye-model.md §4 for why. Rod saturation (B_rod) is always on.
 */
export function observerState(Acone: number, Arod: number, coneBleaching: boolean): ObserverState {
  return {
    Acone,
    Arod,
    sigmaCone: sigmaCone(Acone),
    sigmaRod: sigmaRod(Arod),
    Bcone: coneBleaching ? bleachCone(Acone) : 1,
    BrodAdapt: rodSaturationAdapt(Arod),
  };
}

/**
 * "Dark light": the eye's intrinsic noise acts as an equivalent background below which luminance is
 * indistinguishable from darkness (Barlow 1957; Crumey 2014 §2.1 attributes the flat threshold for
 * B → 0 to it and finds B ≲ 10⁻⁵ cd/m² effectively zero). The perceived response is the increment
 * over the dark-light pedestal, R(L + L0) − R(L0), with L0 = that level (photopic; ×ρ₂₈₅₀ scotopic).
 * This keeps darkness black and sub-dark-light luminances (e.g. a faint stellar veil) near black.
 */
export const DARK_LIGHT_CONE = CRUMEY.zeroBackgroundB;
export const DARK_LIGHT_ROD = CRUMEY.zeroBackgroundB * CRUMEY.spRatioBlackwell;

export function coneResponse(s: ObserverState, Lp: number): number {
  return response(Math.max(Lp, 0) + DARK_LIGHT_CONE, s.sigmaCone, s.Bcone) - response(DARK_LIGHT_CONE, s.sigmaCone, s.Bcone);
}

/** Hunt rod response with rod saturation B_S(S) = stimulus part + adaptation part. */
export function rodResponseRaw(s: ObserverState, S: number): number {
  return response(S, s.sigmaRod, rodSaturationStimulus(S) + s.BrodAdapt);
}

export function rodResponse(s: ObserverState, Ls: number): number {
  return rodResponseRaw(s, Math.max(Ls, 0) + DARK_LIGHT_ROD) - rodResponseRaw(s, DARK_LIGHT_ROD);
}

/** R_lum = R_rod + R_cone (§4.2). */
export function lumResponse(s: ObserverState, Lp: number, Ls: number): number {
  return coneResponse(s, Lp) + rodResponse(s, Ls);
}

export interface References {
  white: number;
  black: number;
}

/** Scene reference white/black responses: responses at 5·A and 5·A/32 (Eq. 8). */
export function sceneReferences(s: ObserverState): References {
  const w = P.refWhiteFactor;
  const bl = P.refWhiteFactor / P.refBlackDivisor;
  return {
    white: lumResponse(s, w * s.Acone, w * s.Arod),
    black: lumResponse(s, bl * s.Acone, bl * s.Arod),
  };
}

/**
 * The display observer. Pattanaik §4.3: fixed steady-state adaptation, display maximum ↦ REF_wht and
 * display minimum ↦ REF_blk. With Hunt's "reference white = 5 × adaptation" the display observer's
 * adaptation is peak/5 (their CRT: peak 125, A = 25). Rods of the display observer are saturated
 * (B_rod = 0.0016 at A = 25 in the paper) and are neglected in the inverse (error < 0.2 %).
 */
export interface DisplayObserver {
  /** Display white (SDR white on an HDR display), cd/m²: the observer's reference white, adapted to white/5. */
  peak: number;
  black: number;
  sigma: number;
  B: number;
  /** Response to display white (reference white). */
  white: number;
  blackRef: number;
  /**
   * Brightest luminance the display can show, cd/m²: = peak on SDR; the HDR peak on an HDR display, where
   * responses above reference white (highlights) are shown up to it (docs/eye-model.md §7).
   */
  maxLd: number;
  /** Response to maxLd. */
  maxResponse: number;
}

export function displayObserver(peakCdM2: number, blackCdM2: number, maxCdM2 = peakCdM2): DisplayObserver {
  const A = peakCdM2 / P.refWhiteFactor;
  const sigma = sigmaCone(A);
  const B = 1; // B_cone(A ≈ 40 cd/m²) = 0.99998
  const maxLd = Math.max(maxCdM2, peakCdM2);
  return {
    peak: peakCdM2,
    black: blackCdM2,
    sigma,
    B,
    white: response(peakCdM2, sigma, B),
    blackRef: response(blackCdM2, sigma, B),
    maxLd,
    maxResponse: response(maxLd, sigma, B),
  };
}

/** Which of Pattanaik's four inverse-appearance rules applies (§4.3), and its linear map R_d = g·R + o. */
export interface AppearanceMap {
  rule: 1 | 2 | 3 | 4;
  gain: number;
  offset: number;
}

export function appearanceMap(scene: References, d: DisplayObserver): AppearanceMap {
  const spanS = scene.white - scene.black;
  const spanD = d.white - d.blackRef;
  const midS = 0.5 * (scene.white + scene.black);
  const midD = 0.5 * (d.white + d.blackRef);
  // 1. The display can reproduce the scene responses directly.
  if (scene.white <= d.white && scene.black >= d.blackRef) return { rule: 1, gain: 1, offset: 0 };
  // 2. Scene span larger: compress and offset so scene white/black ↦ display white/black.
  if (spanS > spanD) {
    const g = spanD / spanS;
    return { rule: 2, gain: g, offset: d.blackRef - scene.black * g };
  }
  // 3. Scene mid above display mid: offset down just enough that scene white ≤ display white.
  if (midS > midD) return { rule: 3, gain: 1, offset: Math.min(0, d.white - scene.white) };
  // 4. Otherwise offset up just enough that display black ≤ scene black.
  return { rule: 4, gain: 1, offset: Math.max(0, d.blackRef - scene.black) };
}

/** Inverse display response: luminance L_d (cd/m²) that evokes response R_d in the display observer. */
export function inverseDisplay(Rd: number, d: DisplayObserver): number {
  if (!(Rd > 0)) return 0;
  if (Rd >= d.maxResponse) return d.maxLd;
  return d.sigma * Math.pow(Rd / (d.B - Rd), 1 / P.n);
}

export interface ToneResult {
  /** Display luminance, cd/m² (≤ peak). */
  Ld: number;
  /** Exponent applied to cone-space colour ratios (colourExponent): 1 = colorimetric colour, 0 = grey. */
  colourExponent: number;
}

/** Map one pixel's (photopic, scotopic) luminance to display luminance. */
export function toneMap(Lp: number, Ls: number, s: ObserverState, map: AppearanceMap, d: DisplayObserver): ToneResult {
  const rc = coneResponse(s, Lp);
  const rr = rodResponse(s, Ls);
  const R = rc + rr;
  const Rd = map.gain * R + map.offset;
  const Ld = inverseDisplay(Rd, d);
  return { Ld, colourExponent: colourExponent(Lp, s, Ld, d) };
}

/**
 * Colour appearance, Pattanaik et al. (2000) Eq. 3 and §4.3: chromatic signals come from cones only
 * (as in Hunt's model), with a strength proportional to the slope of the cone response,
 * S = dR/d ln L = n·R·(1 − R/B). Matching the scene's to the display observer's chromatic response
 * raises cone-space colour ratios to the power S_scene/S_display. Rods add brightness but no colour, so
 * colour fades as cone responses fall toward the dark-light noise.
 *
 * v1 caps the exponent at 1: colour is lost where the eye loses it, but never exaggerated beyond
 * colorimetric fidelity, which leaves the Hunt effect out (docs/eye-model.md §5).
 */
export function colourExponent(Lp: number, s: ObserverState, Ld: number, d: DisplayObserver): number {
  const r = response(Math.max(Lp, 0) + DARK_LIGHT_CONE, s.sigmaCone, s.Bcone);
  const sScene = P.n * r * (1 - r / s.Bcone);
  const rd = response(Ld, d.sigma, d.B);
  const sDisp = P.n * rd * (1 - rd / d.B);
  if (!(sDisp > 0)) return 1;
  return Math.min(1, sScene / sDisp);
}

/** Hunt–Pointer–Estevez XYZ → LMS (Hunt 2004; Fairchild 2013, as used by Hunt's model). */
export { XYZ_TO_HPE } from './constants';

/**
 * Apply a colour exponent to a chromaticity (XYZ with Y = 1) relative to a white (XYZ, Y = 1):
 * ρ_i = LMS_i/LMS_white,i → ρ_i^k, back to XYZ, renormalised to Y = 1.
 */
export function applyColourExponent(xyz: [number, number, number], white: [number, number, number], k: number): [number, number, number] {
  const M = XYZ_TO_HPE;
  const lms = (v: number[]) => [M[0] * v[0] + M[1] * v[1] + M[2] * v[2], M[3] * v[0] + M[4] * v[1] + M[5] * v[2], v[2]];
  const a = lms(xyz), w = lms(white);
  const l = [0, 1, 2].map((i) => Math.pow(Math.max(a[i] / w[i], 1e-9), k) * w[i]);
  // Inverse of the HPE matrix (third row is Z = S).
  const det = M[0] * M[4] - M[1] * M[3];
  const Z = l[2];
  const bx = l[0] - M[2] * Z, by = l[1] - M[5] * Z;
  const X = (M[4] * bx - M[1] * by) / det;
  const Y = (-M[3] * bx + M[0] * by) / det;
  return [X / Y, 1, Z / Y];
}
