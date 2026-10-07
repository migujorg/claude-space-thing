// Observer and display settings. These describe *which* observer and display we model, not the
// universe; each default is justified by the source it keeps us consistent with.

import { CRUMEY } from './constants';

export interface EyeSettings {
  /**
   * Observer age, years. Default 25: inside the 19–26 year range of Blackwell's (1946) observers,
   * whose thresholds Crumey's model reproduces, so no additional age field factor is implied.
   * Also enters the pupil formula (Watson & Yellott 2012) and the glare equation (CIE 146:2002).
   */
  ageYears: number;
  /**
   * Eye pigmentation factor p of CIE 146:2002 (0 very dark eyes … 1.2 very light blue eyes).
   * Default 0.5, the middle of the published range. Only affects glare beyond ~30°.
   */
  pigmentation: number;
  /**
   * Crumey's (2014) overall field factor F multiplying laboratory thresholds. Default 2, his
   * "notional typical" value for actual observing (§3.1; gives V = 6.18 at 21.83 mag/arcsec²).
   */
  fieldFactor: number;
  /** 2 = binocular viewing (Watson & Yellott 2012 M(e)). */
  eyes: 1 | 2;
  /**
   * Whether the observer has the eye's optical point spread (Watson 2013; docs/eye-model.md §3). True: an eye.
   * False: an imager at the frame's own sampling, with no optics of its own. It changes two things and nothing
   * else in the model: a point splat is then the reconstruction minimum at every field, and the switch from
   * point to disk (§6.3) is 1 to 2 pixels at every field. The validation against spacecraft images runs with it
   * off: it compares the HDR buffer, before the eye model, with a camera's image, so a body belongs in that
   * buffer whenever the frame resolves it. With it on, a body under the eye's point spread is a point and is not
   * in that buffer (the Earth and the Moon of the EPOXI case, 0.9′ and 0.24′ across in a view 3.5′ wide, read
   * zero). The app and the scene suite never turn it off.
   */
  opticalCore: boolean;
  /** Diameter of the adaptation field around the fixation point, degrees (Ward Larson et al. 1997 foveal 1°). */
  adaptationFieldDeg: number;
  /**
   * Where the eye looks when adapting to the extended image (docs/eye-model.md §2 "Fixations"):
   * 'brightness' — fixations over the whole frame weighted by the light they bring to the eye (the eye
   * looks at what is lit, never at the Sun's disk); 'centre' — one fixation at the view centre with the
   * `adaptationFieldDeg` field (v1). Point sources are always judged at their own fixation.
   */
  fixation: 'brightness' | 'centre';
  /**
   * Display white, cd/m²: the SDR display's peak, or an HDR display's SDR white (canvas value 1.0). Default
   * 200, close to ITU-R BT.2408's 203 cd/m² HDR reference white.
   */
  displayPeakCdM2: number;
  /**
   * An HDR display's peak luminance, cd/m², used only when the output is HDR (renderer displayInfo): the
   * eye model's intended display luminance is shown up to it instead of being cut at white. Browsers do not
   * report it; default 1000 cd/m², the common HDR10 mastering and VESA DisplayHDR 1000 peak. The display
   * clips what it cannot reach.
   */
  hdrPeakCdM2: number;
  /** Display black level, cd/m² (0 = ideal emissive display). */
  displayBlackCdM2: number;
  /**
   * Apply Hunt's steady-state cone bleaching amplitude in the tone reproduction (Pattanaik Eq. 6).
   * Off in v0 — see docs/eye-model.md §4.
   */
  coneBleaching: boolean;
}

export const DEFAULT_EYE_SETTINGS: EyeSettings = {
  ageYears: 25,
  pigmentation: 0.5,
  fieldFactor: CRUMEY.typicalFieldFactor,
  eyes: 2,
  opticalCore: true,
  adaptationFieldDeg: 1,
  fixation: 'brightness',
  displayPeakCdM2: 200,
  hdrPeakCdM2: 1000,
  displayBlackCdM2: 0,
  coneBleaching: false,
};
