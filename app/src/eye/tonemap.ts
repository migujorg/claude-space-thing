// Tone reproduction after Pattanaik, Tumblin, Yee & Greenberg (2000), "Time-dependent visual
// adaptation for fast realistic image display" (SIGGRAPH 2000): a forward model of the scene
// observer's rod and cone responses (Naka–Rushton with Hunt's semi-saturation and bleaching terms),
// an appearance model (reference white/black), and the inverse pair for the display observer.
//
// This file is the reference implementation (float64, used by tests and on the CPU for per-frame
// scalars). The per-pixel part is mirrored in WGSL (wgsl.ts); keep them in sync.

import { PATTANAIK as P } from './constants';

export function sigmaCone(A: number): number {
  const a = Math.max(A, 1e-12);
  const k = 1 / (P.coneKScale * a + 1);
  const k4 = k * k * k * k;
  return (P.coneSigmaNum * a) / (k4 * a + P.coneSigmaPow * (1 - k4) * (1 - k4) * Math.cbrt(a));
}

export function sigmaRod(A: number): number {
  const a = Math.max(A, 1e-12);
  const j = 1 / (P.rodJScale * a + 1);
  const j2 = j * j;
  return (P.rodSigmaNum * a) / (P.rodSigmaJ2 * j2 * a + P.rodSigmaPow * Math.pow(1 - j2, 4) * Math.pow(a, 1 / 6));
}

export function bleachCone(A: number): number {
  return P.coneBleachHalf / (P.coneBleachHalf + A);
}

export function bleachRod(A: number): number {
  return P.rodBleachHalf / (P.rodBleachHalf + A);
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
  Brod: number;
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
    Brod: bleachRod(Arod),
  };
}

export function coneResponse(s: ObserverState, Lp: number): number {
  return response(Lp, s.sigmaCone, s.Bcone);
}

export function rodResponse(s: ObserverState, Ls: number): number {
  return response(Ls, s.sigmaRod, s.Brod);
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
  peak: number;
  black: number;
  sigma: number;
  B: number;
  white: number;
  blackRef: number;
}

export function displayObserver(peakCdM2: number, blackCdM2: number): DisplayObserver {
  const A = peakCdM2 / P.refWhiteFactor;
  const sigma = sigmaCone(A);
  const B = 1; // B_cone(A ≈ 40 cd/m²) = 0.99998
  return {
    peak: peakCdM2,
    black: blackCdM2,
    sigma,
    B,
    white: response(peakCdM2, sigma, B),
    blackRef: response(blackCdM2, sigma, B),
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
  if (Rd >= d.white) return d.peak;
  return d.sigma * Math.pow(Rd / (d.B - Rd), 1 / P.n);
}

export interface ToneResult {
  /** Display luminance, cd/m² (≤ peak). */
  Ld: number;
  /** Fraction of the luminance response carried by cones, R_cone/(R_cone + R_rod): 1 = full colour. */
  coneFraction: number;
}

/** Map one pixel's (photopic, scotopic) luminance to display luminance. */
export function toneMap(Lp: number, Ls: number, s: ObserverState, map: AppearanceMap, d: DisplayObserver): ToneResult {
  const rc = coneResponse(s, Lp);
  const rr = rodResponse(s, Ls);
  const R = rc + rr;
  const Rd = map.gain * R + map.offset;
  return { Ld: inverseDisplay(Rd, d), coneFraction: R > 0 ? rc / R : 1 };
}
