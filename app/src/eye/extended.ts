// How a pixel of the extended image (resolved bodies, sky, the analytic veil) is shown: the float64 reference of
// the first step of COMPOSITE_SHADER (render/shaders.ts, "Perceived extended image"); docs/eye-model.md §4, §6.3.
// The frame has one adaptation state for the extended image (§2 "Fixations"); the composite maps each pixel's
// perceived luminance through Pattanaik's responses and appearance rules (tonemap.ts) at that state.

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
 * @param weight the weight the renderer puts on a resolved body's luminance (frame.ts ResolvedBody.riccoWeight; 1 for
 *   everything that is not a body)
 * @param unscattered fraction of the light the eye does not scatter out of the pixel (1 − CIE 146 kernel energy)
 * @param veil the analytic veil at the pixel (the Sun, bodies outside the frame)
 */
export function extendedPerceived(eye: EyeFrame, L: Luminance, weight: number, unscattered: number, veil: Luminance = { Y: 0, S: 0 }): Luminance {
  return {
    Y: (weight * unscattered * L.Y + veil.Y) * eye.exposure,
    S: (weight * unscattered * L.S + veil.S) * eye.exposure,
  };
}

/** Display luminance and colour exponent of that pixel (painted glare and point sources not included). */
export function extendedDisplay(eye: EyeFrame, L: Luminance, weight: number, unscattered: number, veil: Luminance = { Y: 0, S: 0 }): ToneResult {
  const p = extendedPerceived(eye, L, weight, unscattered, veil);
  return toneMap(p.Y, p.S, eye.scene, eye.map, eye.display);
}
