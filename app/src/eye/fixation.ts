// Where the eye looks (docs/eye-model.md §2 "Fixations"). The float64 reference of the adaptation
// measurement the renderer reduces on the GPU (shaders.ts ADAPT_SHADER).
//
// A scene is perceived over many fixations. For the extended image the renderer uses one adaptation
// state, the one the eye settles to while it looks around the frame. Fixations go to the objects in the
// frame in proportion to their light (the unscattered scene luminance, not the glare haze around a
// bright source), and at each fixation the eye adapts to the retinal image there (object plus veil).
// The adaptation is therefore the log-average of the retinal image weighted by the scene luminance.
// The eye looks at what is lit (a quarter Moon's sunlit half, not its night side), and a small bright
// body in a dark field sets the adaptation by its light rather than by its tiny area. The solar disk is
// not fixated (it cannot be looked at); its veil still counts where the eye looks. Point sources are
// judged at their own fixation (eye/points.ts), so faint stars beside a bright body stay visible.
// Only the light the eye can see draws it (fixationWeight): each pixel's scene luminance counts as an increment
// on the retinal image there, with no weight below the large-target threshold contrast C∞ (Crumey 2014) and full
// weight from 2·C∞. Light buried in a far brighter veil (the zodiacal light a degree from the Sun, 10⁻⁴ of the
// veil) attracts nothing, like the veil itself; an object brighter than its veil (a planet on dark sky) keeps its
// full weight.
//
// 'centre' keeps the v1 rule: one fixation at the view centre, the log-average over its 1° field
// (Ward Larson, Rushmeier & Piatko 1997).

import { DARK_LIGHT_CONE, DARK_LIGHT_ROD } from './tonemap';
import { largeTargetContrast } from './crumey';

/**
 * Fixation weight per unit solid angle of a pixel of unscattered scene luminance L on a retinal image of luminance
 * Lret (both photopic cd/m²): L·clamp(L/(L_r·C∞(L_r)) − 1, 0, 1) + L₀, L_r = Lret + L₀. C∞ is evaluated at the
 * photopic luminance (a weighting, not a threshold of the rendered image). Mirrored in ADAPT_SHADER.
 */
export function fixationWeight(L: number, Lret: number): number {
  const Ls = Math.max(L, 0);
  const Lr = Math.max(Lret, 0) + DARK_LIGHT_CONE;
  const vis = Math.min(Math.max(Ls / (Lr * largeTargetContrast(Lr)) - 1, 0), 1);
  return Ls * vis + DARK_LIGHT_CONE;
}

export interface RetinalSample {
  /** Retinal image (unscattered scene + veil, point cores excluded): photopic Y and scotopic S, cd/m². */
  Y: number;
  S: number;
  /** Unscattered scene luminance (photopic), cd/m²: what draws fixations. Defaults to Y. */
  sceneY?: number;
  /** Solid angle, sr. */
  omegaSr: number;
  /** Inside the resolved solar disk (never fixated). */
  onSunDisk?: boolean;
  /** Inside the centre field (for 'centre'). */
  inCentreField?: boolean;
}

/** Adaptation luminances (cone, rod) the eye settles to over its fixations. */
export function fixationAdaptation(samples: RetinalSample[], mode: 'brightness' | 'centre'): { coneCdM2: number; rodCdM2: number } {
  let sc = 0, sr = 0, sw = 0;
  for (const s of samples) {
    const lc = Math.log(Math.max(s.Y, 0) + DARK_LIGHT_CONE);
    const lr = Math.log(Math.max(s.S, 0) + DARK_LIGHT_ROD);
    let w: number;
    if (mode === 'brightness') w = s.onSunDisk ? 0 : fixationWeight(s.sceneY ?? s.Y, s.Y) * s.omegaSr;
    else w = s.inCentreField ? s.omegaSr : 0;
    sc += lc * w;
    sr += lr * w;
    sw += w;
  }
  if (!(sw > 0)) return { coneCdM2: 0, rodCdM2: 0 };
  return { coneCdM2: Math.exp(sc / sw) - DARK_LIGHT_CONE, rodCdM2: Math.exp(sr / sw) - DARK_LIGHT_ROD };
}
