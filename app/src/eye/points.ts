// How a point source (star, unresolved body) is shown (docs/eye-model.md §6.3), and the display-space
// glare criterion shared with extended sources. The WGSL point shader mirrors pointAppearance(); this
// is the reference and is unit-tested.
//
// Ricco's law governs how BRIGHT a small source looks, not how BIG: a point of illuminance E on a
// background B is as detectable, and (our supra-threshold extension) as bright, as a patch of the Ricco
// area A_R with luminance B + E/A_R. So:
//  1. perceived brightness: the scene observer's response to B + E·u/A_R (u = unscattered fraction) is
//     mapped through Pattanaik's appearance rules to the display luminance that evokes it in the display
//     observer — the *intended* display luminance, which may exceed what the display can show;
//  2. the display must evoke the same brightness in the *viewer*, who sums a small displayed dot over
//     their own Ricco area A_R,disp (Crumey's A_R at the display adaptation): the dot's flux is
//     Φ = ΔL_d·A_R,disp, drawn as a sharp splat of the eye's optical core (never the Ricco size);
//  3. glare: the part of Φ the splat cannot hold (its peak would exceed the display maximum) is the
//     "overflow". The display cannot show it, so the viewer's own eye cannot scatter it: the renderer
//     paints the glare the viewer's eye would add to it (the same CIE 146 kernel), in display units.
//     Light the display does show gets no painted glare (the viewer's eye adds its own). This is the
//     criterion of glare rendering as a conveyer of luminance beyond the display's range (Spencer et al.
//     1995; Yoshida et al. 2008; Ritschel et al. 2009), made quantitative with the display observer.
//  4. colour: cones alone carry colour and a point concentrates its light on few cones, so a star's
//     colour exponent (Pattanaik Eq. 3) is set by its own cone signal, B + E·u/A_c with A_c the cone
//     system's summation area, not by the pixel's (tiny) mean luminance.

//  5. fixation: a point is judged as the eye sees it when looking at it — adapted to its own local
//     background (the sky plus veil around it), not to the frame's global state. This is the condition of
//     Crumey's thresholds (an observer adapted to the background at the source) and it keeps faint stars
//     visible beside a bright body the extended image is adapted to (docs/eye-model.md §2 "Fixations").

import { blackwellEquivalent } from './mesopic';
import { PATTANAIK } from './constants';
import { localObserver, type EyeFrame, type LocalObserver } from './model';
import { colourExponent, lumResponse, response, type AppearanceMap, type DisplayObserver, type ObserverState } from './tonemap';

export interface PointAppearance {
  /** Above the local visibility threshold (Crumey, field factor F, at the point's own background)? */
  visible: boolean;
  /** Intended display luminance increment of the Ricco-equivalent patch, cd/m² (may exceed the peak). */
  deltaLd: number;
  /** Display flux wanted (ΔL_d·A_R,disp), drawn in the splat, and overflowing (painted as glare), cd·m⁻²·sr. */
  wantedFlux: number;
  drawnFlux: number;
  overflowFlux: number;
  /** Peak display luminance of the drawn splat, cd/m². */
  peakLd: number;
  /** Colour exponent from the source's own cone signal (1 = colorimetric, 0 = grey). */
  colourExponent: number;
}

/**
 * The display luminance that would evoke the scene observer's response in the display observer
 * (Pattanaik's appearance map and inverse display model) WITHOUT clamping at the display peak. It is
 * bounded by Hunt's cone-bleaching luminance (Pattanaik Eq. 6, 2·10⁶ cd/m²), beyond which the display
 * observer's response is no longer defined by the model.
 */
export function intendedDisplayLd(o: { scene: ObserverState; map: AppearanceMap; display: DisplayObserver }, Lp: number, Ls: number): number {
  const d = o.display;
  const Rd = o.map.gain * lumResponse(o.scene, Lp, Ls) + o.map.offset;
  if (!(Rd > 0)) return 0;
  if (Rd >= response(PATTANAIK.coneBleachHalf, d.sigma, d.B)) return PATTANAIK.coneBleachHalf;
  return d.sigma * Math.pow(Rd / (d.B - Rd), 1 / PATTANAIK.n);
}

/** The eye looking at a point: adapted to the point's physical local background (Y, S), cd/m². */
export function pointObserver(eye: EyeFrame, bg: { Y: number; S: number }): LocalObserver {
  return localObserver(eye.settings, eye.display, bg.Y, bg.S, eye.exposure, eye.dark);
}

/**
 * @param E point illuminance at the eye, lux: photopic Y and scotopic S
 * @param bg local physical background luminance (Y, S), cd/m², excluding the source itself; the eye
 *   judging the point is adapted to it (pointObserver)
 * @param unscattered fraction of the light not scattered out of the core (1 − CIE 146 kernel energy)
 * @param splatAreaSr effective area of the drawn splat (flux / peak luminance), sr
 */
export function pointAppearance(eye: EyeFrame, E: { Y: number; S: number }, bg: { Y: number; S: number }, unscattered: number, splatAreaSr: number): PointAppearance {
  const x = eye.exposure;
  const o = pointObserver(eye, bg);
  const obs = { scene: o.scene, map: o.map, display: eye.display };
  const visible = blackwellEquivalent(E.Y, E.S, o.mesopic.m) >= o.thresholdBwLux;
  const bY = bg.Y * x, bS = bg.S * x;
  const eY = (E.Y * unscattered * x) / o.riccoAreaSr, eS = (E.S * unscattered * x) / o.riccoAreaSr;
  const Lb = intendedDisplayLd(obs, bY, bS);
  const deltaLd = visible ? Math.max(0, intendedDisplayLd(obs, bY + eY, bS + eS) - Lb) : 0;
  const wantedFlux = deltaLd * eye.displayRiccoSr;
  const Ldb = Math.min(Lb, eye.display.maxLd);
  const capacity = Math.max(0, eye.display.maxLd - Ldb) * splatAreaSr;
  const drawnFlux = Math.min(wantedFlux, capacity);
  const peakLd = Ldb + drawnFlux / splatAreaSr;
  const Lc = bY + (E.Y * unscattered * x) / o.coneSummationSr;
  return { visible, deltaLd, wantedFlux, drawnFlux, overflowFlux: wantedFlux - drawnFlux, peakLd, colourExponent: colourExponent(Lc, o.scene, peakLd, eye.display) };
}

// ── The local background of a point and the cull (shaders.ts CULL_SHADER; renderer.ts steps 2–4) ──────────────
// The reference for what the GPU does, unit-tested (tests/eye-points.test.ts). The point image (PT) holds every
// source in the frame, whether the eye can pick it out or not: its light reaches the eye either way. So the veil
// a source is judged against is a function of the scene alone, and no verdict depends on an earlier one (a
// source's own or a neighbour's). The cull decides only what is displayed as a point.

/**
 * One level of the retina pyramid: its weight in the CIE 146 kernel fit and its Gaussian's σ in full-resolution
 * pixels as the veil shows it (renderer.ts pyramidSigma: box downsampling to the level, its blur, and the
 * bilinear upsamples back to full resolution).
 */
export interface VeilLevel {
  weight: number;
  sigmaPx: number;
}

/** A point source in the frame: position in pixels, illuminance at the eye in lux (photopic Y, scotopic S). */
export interface PointSource {
  x: number;
  y: number;
  E: { Y: number; S: number };
}

/**
 * The veil level a point's local background is read at: the first whose Gaussian's equivalent area 2πσ_k²·Ω_px
 * reaches the Ricco area, so a point's own core glare does not mask it (docs/eye-model.md §6); the last level
 * when none does.
 */
export function backgroundLevel(levels: VeilLevel[], pixelSr: number, riccoAreaSr: number): number {
  let k = 0;
  while (k < levels.length - 1 && 2 * Math.PI * levels[k].sigmaPx ** 2 * pixelSr < riccoAreaSr) k++;
  return k;
}

/**
 * Variance (px²) of the Gaussian that stands for level k's term in the background texture of level kR, read at a
 * point source's position. It differs from the level's σ² in the veil at full resolution in three ways, all of
 * which matter when the background is read at a fine level:
 *  - the source is not a point in PT but the splat of the eye's optical core (+ σ_splat²);
 *  - the texture is level kR's, not level 0's: the upsamples from kR down to full resolution, which σ_k counts
 *    (Σ_{j=1..kR} 4^j/6 = (4^{kR+1} − 4)/18), do not happen;
 *  - the shaders read that texture bilinearly at the source's position (+ 4^kR/6, one tent of a level-kR texel).
 * This is the mean over the source's position within a texel: tests/eye-points.test.ts runs the pyramid's
 * arithmetic on the CPU and finds the mean within 2 % and single positions within about ±20 % of it.
 */
function backgroundVariancePx2(levels: VeilLevel[], kR: number, k: number, splatSigmaPx: number): number {
  return levels[k].sigmaPx ** 2 - (4 ** (kR + 1) - 4) / 18 + 4 ** kR / 6 + splatSigmaPx ** 2;
}

/**
 * What a source of unit illuminance, splatted with σ_splat pixels, adds to that background r pixels away, per
 * pixel solid angle (multiply by E/Ω_px for cd/m²): Σ_{k≥kR} w_k·exp(−r²/2V_k)/(2πV_k), V_k as above.
 */
export function veilKernelPerPixel(levels: VeilLevel[], kR: number, rPx: number, splatSigmaPx: number): number {
  let v = 0;
  for (let k = kR; k < levels.length; k++) {
    const s2 = backgroundVariancePx2(levels, kR, k, splatSigmaPx);
    v += (levels[k].weight * Math.exp(-(rPx * rPx) / (2 * s2))) / (2 * Math.PI * s2);
  }
  return v;
}

/** A source's own light in its background, at its own position: the kernel at zero distance (Eye.pts.w). */
export function ownVeilPerPixel(levels: VeilLevel[], kR: number, splatSigmaPx: number): number {
  return veilKernelPerPixel(levels, kR, 0, splatSigmaPx);
}

/**
 * The point sources' part of the background texture at each source (cd/m²): the veil, at scales from the Ricco
 * area up, of EVERY source given, its own light included. There is no verdict among the arguments.
 */
export function pointVeil(sources: PointSource[], levels: VeilLevel[], kR: number, pixelSr: number, splatSigmaPx: number): { Y: number; S: number }[] {
  return sources.map((a) => {
    let Y = 0, S = 0;
    for (const b of sources) {
      const k = veilKernelPerPixel(levels, kR, Math.hypot(a.x - b.x, a.y - b.y), splatSigmaPx) / pixelSr;
      Y += b.E.Y * k;
      S += b.E.S * k;
    }
    return { Y, S };
  });
}

/**
 * The cull's local background of a source (cd/m²): the background texture at the source less the source's own
 * light there (never below zero: a texture from before the source was in the frame does not hold it), plus the
 * analytic veil (Sun, off-frame bodies).
 */
export function cullBackground(texture: { Y: number; S: number }, own: { Y: number; S: number }, analytic: { Y: number; S: number }): { Y: number; S: number } {
  return { Y: Math.max(texture.Y - own.Y, 0) + analytic.Y, S: Math.max(texture.S - own.S, 0) + analytic.S };
}

/** The verdict: is the point above the threshold of the eye looking at it, adapted to that background? */
export function pointVisible(eye: EyeFrame, E: { Y: number; S: number }, bg: { Y: number; S: number }): boolean {
  const o = pointObserver(eye, bg);
  return blackwellEquivalent(E.Y, E.S, o.mesopic.m) >= o.thresholdBwLux;
}
