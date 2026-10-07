// How a pixel of the extended image (resolved bodies, sky, the analytic veil) is shown: the float64 reference of
// the first step of COMPOSITE_SHADER (render/shaders.ts, "Perceived extended image"); docs/eye-model.md §4, §6.3.
// The frame has one adaptation state for the extended image (§2 "Fixations"); the composite maps each pixel's
// perceived luminance through Pattanaik's responses and appearance rules (tonemap.ts) at that state.
//
// A resolved body is shown at its own retinal luminance whatever its angular size: no Ricco weight. Ricco's law is
// a detection threshold on a background the eye is adapted to (Crumey 2014: "threshold rather than brightness
// perception"); the eye that looks at a body it resolves is adapted to that body's light (§2), and the measurements
// of brightness against size above threshold show no dilution by area where they exist (§6.3, §10).

import type { EyeFrame } from './model';
import { toneMap, type ToneResult } from './tonemap';

/** Photopic (cd/m²) and scotopic (scotopic cd/m²) luminance. */
export interface Luminance {
  Y: number;
  S: number;
}

/**
 * Perceived luminance of a pixel of the extended image, the composite's `perc`.
 * @param L the pixel's scene luminance (EXT), before the eye's scatter
 * @param unscattered fraction of the light the eye does not scatter out of the pixel (1 − CIE 146 kernel energy)
 * @param veil the analytic veil at the pixel (the Sun, bodies outside the frame)
 */
export function extendedPerceived(eye: EyeFrame, L: Luminance, unscattered: number, veil: Luminance = { Y: 0, S: 0 }): Luminance {
  return {
    Y: (unscattered * L.Y + veil.Y) * eye.exposure,
    S: (unscattered * L.S + veil.S) * eye.exposure,
  };
}

/** Display luminance and colour exponent of that pixel (painted glare and point sources not included). */
export function extendedDisplay(eye: EyeFrame, L: Luminance, unscattered: number, veil: Luminance = { Y: 0, S: 0 }): ToneResult {
  const p = extendedPerceived(eye, L, unscattered, veil);
  return toneMap(p.Y, p.S, eye.scene, eye.map, eye.display);
}
