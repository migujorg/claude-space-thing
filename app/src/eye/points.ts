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

import { PATTANAIK } from './constants';
import type { EyeFrame } from './model';
import { colourExponent, lumResponse, response } from './tonemap';

export interface PointAppearance {
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
export function intendedDisplayLd(eye: EyeFrame, Lp: number, Ls: number): number {
  const d = eye.display;
  const Rd = eye.map.gain * lumResponse(eye.scene, Lp, Ls) + eye.map.offset;
  if (!(Rd > 0)) return 0;
  if (Rd >= response(PATTANAIK.coneBleachHalf, d.sigma, d.B)) return PATTANAIK.coneBleachHalf;
  return d.sigma * Math.pow(Rd / (d.B - Rd), 1 / PATTANAIK.n);
}

/**
 * @param E point illuminance at the eye, lux: photopic Y and scotopic S
 * @param bg local perceived background luminance (Y, S), cd/m², excluding the source itself
 * @param unscattered fraction of the light not scattered out of the core (1 − CIE 146 kernel energy)
 * @param splatAreaSr effective area of the drawn splat (flux / peak luminance), sr
 */
export function pointAppearance(eye: EyeFrame, E: { Y: number; S: number }, bg: { Y: number; S: number }, unscattered: number, splatAreaSr: number): PointAppearance {
  const x = eye.exposure;
  const bY = bg.Y * x, bS = bg.S * x;
  const eY = (E.Y * unscattered * x) / eye.riccoAreaSr, eS = (E.S * unscattered * x) / eye.riccoAreaSr;
  const Lb = intendedDisplayLd(eye, bY, bS);
  const deltaLd = Math.max(0, intendedDisplayLd(eye, bY + eY, bS + eS) - Lb);
  const wantedFlux = deltaLd * eye.displayRiccoSr;
  const Ldb = Math.min(Lb, eye.display.peak);
  const capacity = Math.max(0, eye.display.peak - Ldb) * splatAreaSr;
  const drawnFlux = Math.min(wantedFlux, capacity);
  const peakLd = Ldb + drawnFlux / splatAreaSr;
  const Lc = bY + (E.Y * unscattered * x) / eye.coneSummationSr;
  return { deltaLd, wantedFlux, drawnFlux, overflowFlux: wantedFlux - drawnFlux, peakLd, colourExponent: colourExponent(Lc, eye.scene, peakLd, eye.display) };
}
