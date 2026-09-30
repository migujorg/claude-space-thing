// The eye model's per-frame state: adaptation (goal → current), pupil, mesopic state, and every
// scalar the GPU passes need. Pure TS, no GPU; see docs/eye-model.md for the stage-by-stage account.

import { CIE191, CRUMEY, PATTANAIK } from './constants';
import { luxFromMagnitude, magnitudeFromLux, pointThreshold, riccoArea } from './crumey';
import { blackwellEquivalent, mesopic, type MesopicResult } from './mesopic';
import { pupilDiameterMm } from './pupil';
import { appearanceMap, displayObserver, observerState, response, rodResponseRaw, sceneReferences, DARK_LIGHT_CONE, DARK_LIGHT_ROD, type AppearanceMap, type DisplayObserver, type ObserverState, type References } from './tonemap';
import { cat02Matrix, degreeOfAdaptation, displayWhiteXYZ, type M3, type V3 } from './display';
import { opticalCoreSigmaDeg } from './glare';
import { ADAPTED, darkAdaptation, rodEquivalentAdaptation, steadyPigment, stepPigment, thresholdFactor, trolands, type DarkAdaptation, type PigmentState } from './bleaching';
import type { EyeSettings } from './settings';

/** What the GPU measures each frame (docs/eye-model.md §2). */
export interface AdaptationGoal {
  /** Mean photopic luminance of the retinal image over the adaptation field, cd/m². */
  coneCdM2: number;
  /** Same for scotopic luminance, scotopic cd/m². */
  rodCdM2: number;
  /** ∫ L dΩ over the rendered field, cd·m⁻²·deg² (drives the pupil). */
  cornealFlux: number;
}

/**
 * Adaptation state (docs/eye-model.md §2 "Time"). Instantaneous (current = goal, pigments in steady state)
 * unless `timeDependent`: then the neural adaptation A follows the goal through Pattanaik et al.'s (2000,
 * §4.1.2) first-order filters (t0 = 80 ms cones, 150 ms rods) and the pigments bleach and regenerate with
 * their kinetics (bleaching.ts), driven by the retinal illuminance of the goal through the pupil.
 */
export class AdaptationState {
  goal: AdaptationGoal | null = null;
  coneCdM2 = 1;
  rodCdM2 = 1;
  cornealFlux = 0;
  timeDependent = false;
  /** Bleached pigment fractions (null before the first measurement: then set to steady state). */
  pigment: PigmentState | null = null;
  /** Steady-state bleach for the last goal. */
  steady: PigmentState = { cone: 0, rod: 0 };
  /** Retinal illuminance of the last goal, photopic and scotopic trolands. */
  td = { cone: 0, rod: 0 };

  /**
   * Feed a new measurement. dt (s) is only used when timeDependent is on. pupilMm: the pupil through
   * which the goal reaches the retina (bleaching); default the Watson–Yellott pupil of the goal's corneal
   * flux for a 25-year-old, binocular.
   */
  update(goal: AdaptationGoal, dt: number, pupilMm?: number): void {
    this.goal = goal;
    const floorC = CRUMEY.zeroBackgroundB;
    const floorR = CRUMEY.zeroBackgroundB * CRUMEY.spRatioBlackwell;
    const gc = Math.max(goal.coneCdM2, floorC);
    const gr = Math.max(goal.rodCdM2, floorR);
    const timed = this.timeDependent && dt > 0;
    if (!timed) {
      this.coneCdM2 = gc;
      this.rodCdM2 = gr;
    } else {
      const fc = 1 - Math.exp(-dt / PATTANAIK.t0Cone);
      const fr = 1 - Math.exp(-dt / PATTANAIK.t0Rod);
      this.coneCdM2 += fc * (gc - this.coneCdM2);
      this.rodCdM2 += fr * (gr - this.rodCdM2);
    }
    this.cornealFlux = goal.cornealFlux;
    const d = pupilMm ?? pupilDiameterMm(goal.cornealFlux, 25, 2);
    this.td = { cone: trolands(goal.coneCdM2, d), rod: trolands(goal.rodCdM2, d) };
    this.steady = steadyPigment(this.td.cone, this.td.rod);
    if (!this.pigment || !this.timeDependent) this.pigment = this.steady;
    else if (timed) this.pigment = stepPigment(this.pigment, this.td.cone, this.td.rod, dt);
  }

  /**
   * Put the pigments in the state left by a history: steady adaptation to (coneTd, rodTd) for `exposureS`
   * starting from the current state (or full regeneration), then `elapsedS` under the current light.
   */
  applyHistory(coneTd: number, rodTd: number, exposureS: number, elapsedS: number): void {
    let p = stepPigment(this.pigment ?? { cone: 0, rod: 0 }, coneTd, rodTd, exposureS);
    p = stepPigment(p, this.td.cone, this.td.rod, elapsedS);
    this.pigment = p;
  }

  /** The eye's sensitivity beyond steady adaptation to the current light. */
  dark(): DarkAdaptation {
    return this.pigment ? darkAdaptation(this.pigment, this.steady) : ADAPTED;
  }

  /** Relative distance between the state used for rendering and a fresh goal. */
  distanceTo(goal: AdaptationGoal): number {
    const rc = Math.abs(Math.log(Math.max(goal.coneCdM2, CRUMEY.zeroBackgroundB) / this.coneCdM2));
    const rr = Math.abs(Math.log(Math.max(goal.rodCdM2, CRUMEY.zeroBackgroundB * CRUMEY.spRatioBlackwell) / this.rodCdM2));
    return Math.max(rc, rr);
  }
}

export interface EyeFrame {
  settings: EyeSettings;
  /** Pigment state beyond steady adaptation (bleaching.ts): rod threshold elevation, cone photon catch. */
  dark: DarkAdaptation;
  /** Rod adaptation luminance including the bleach's equivalent background (scotopic cd/m²). */
  ArodEff: number;
  mode: 'eye' | 'enhanced';
  /** 2^exposureBoostStops in 'enhanced', 1 in 'eye'. */
  exposure: number;
  Acone: number;
  Arod: number;
  pupilMm: number;
  mesopic: MesopicResult;
  scene: ObserverState;
  refs: References;
  display: DisplayObserver;
  map: AppearanceMap;
  /** Adaptation luminance in Blackwell units (for thresholds and the Ricco area). */
  adaptBw: number;
  /** Ricco area at the adaptation state, sr. */
  riccoAreaSr: number;
  /** Point-source threshold at the adaptation state, Blackwell lux, including F and the enhanced relaxation. */
  thresholdBwLux: number;
  /** Photopic limiting magnitude for a Blackwell-coloured (2850 K) point on the adaptation background. */
  limitingMagnitude: number;
  /** Equivalent Gaussian σ of the optical PSF core at the current pupil, degrees (Watson 2013). */
  coreSigmaDeg: number;
  /** XYZ → XYZ chromatic adaptation from the adapted white (sunlight) to the display white. */
  cat: M3;
  /** Responses to the dark-light pedestal (cone, rod), subtracted per pixel. */
  darkResponse: [number, number];
  /**
   * The viewer's Ricco area while looking at the display (Crumey's A_R at the display observer's
   * adaptation, peak/5), sr: a displayed dot smaller than this is seen by its flux (points.ts).
   */
  displayRiccoSr: number;
  /**
   * Spatial summation area of the cone system, sr: Crumey's A_R at a photopic background (at least the
   * upper end of the CIE 191 mesopic range, 5 cd/m², where his full-range model is cone-only). Below
   * that the cones are at absolute sensitivity and the value is held (docs/eye-model.md §6.3).
   */
  coneSummationSr: number;
}

/**
 * The observer adapted to one luminance: the scene observer's state, appearance map, mesopic state and
 * point-source thresholds at adaptation (A_cone, A_rod), floored at the zero-background level. Used for
 * the frame's global state and, per point source, for the local state of the eye looking at that point
 * (its background; docs/eye-model.md §2 "Fixations").
 */
export interface LocalObserver {
  Acone: number;
  Arod: number;
  scene: ObserverState;
  refs: References;
  map: AppearanceMap;
  mesopic: MesopicResult;
  adaptBw: number;
  riccoAreaSr: number;
  thresholdBwLux: number;
  coneSummationSr: number;
}

/**
 * @param dark the pigment state (bleaching.ts): the rods respond as if adapted to their equivalent
 *   background, and the threshold is raised by thresholdFactor. Mesopic state, Blackwell background and
 *   Ricco area stay those of the physical adaptation.
 */
export function localObserver(settings: EyeSettings, display: DisplayObserver, AconeIn: number, ArodIn: number, exposure: number, dark: DarkAdaptation = ADAPTED): LocalObserver {
  const Acone = Math.max(AconeIn, CRUMEY.zeroBackgroundB);
  const Arod = Math.max(ArodIn, CRUMEY.zeroBackgroundB * CRUMEY.spRatioBlackwell);
  const mes = mesopic(Acone, Arod);
  const scene = observerState(Acone, rodEquivalentAdaptation(Arod, dark.rodLogElevation), settings.coneBleaching);
  const refs = sceneReferences(scene);
  const map = appearanceMap(refs, display);
  const adaptBw = blackwellEquivalent(Acone, Arod, mes.m);
  return {
    Acone, Arod, scene, refs, map, mesopic: mes, adaptBw,
    riccoAreaSr: riccoArea(adaptBw),
    thresholdBwLux: (settings.fieldFactor * pointThreshold(adaptBw) * thresholdFactor(Acone, Arod, dark)) / exposure,
    coneSummationSr: riccoArea(Math.max(adaptBw, CIE191.upperCdM2)),
  };
}

export function computeEyeFrame(
  settings: EyeSettings,
  state: AdaptationState,
  mode: 'eye' | 'enhanced',
  boostStops: number,
  adaptedWhiteXYZ: V3 | null,
  /** The brightest luminance the output can show (an HDR display's peak), cd/m²; default display white. */
  outputMaxCdM2?: number,
): EyeFrame {
  const Acone = state.coneCdM2;
  const Arod = state.rodCdM2;
  const pupilMm = pupilDiameterMm(state.cornealFlux, settings.ageYears, settings.eyes);
  const display = displayObserver(settings.displayPeakCdM2, settings.displayBlackCdM2, outputMaxCdM2);
  const exposure = mode === 'enhanced' ? Math.pow(2, boostStops) : 1;
  const dark = state.dark();
  const o = localObserver(settings, display, Acone, Arod, exposure, dark);
  const { scene, refs, map, adaptBw, thresholdBwLux } = o;
  // Limiting magnitude of a 2850 K point: its Blackwell-equivalent illuminance equals its photopic one.
  const limitingMagnitude = magnitudeFromLux(thresholdBwLux);
  const D = degreeOfAdaptation(Acone);
  const cat = adaptedWhiteXYZ ? cat02Matrix(adaptedWhiteXYZ, displayWhiteXYZ(), D) : ([1, 0, 0, 0, 1, 0, 0, 0, 1] as M3);
  return {
    settings,
    dark,
    ArodEff: o.scene.Arod,
    mode,
    exposure,
    Acone,
    Arod,
    pupilMm,
    mesopic: o.mesopic,
    scene,
    refs,
    display,
    map,
    adaptBw,
    riccoAreaSr: o.riccoAreaSr,
    thresholdBwLux,
    limitingMagnitude,
    coreSigmaDeg: opticalCoreSigmaDeg(pupilMm),
    cat,
    darkResponse: [response(DARK_LIGHT_CONE, scene.sigmaCone, scene.Bcone), rodResponseRaw(scene, DARK_LIGHT_ROD)],
    displayRiccoSr: riccoArea(display.peak / PATTANAIK.refWhiteFactor),
    coneSummationSr: o.coneSummationSr,
  };
}

/**
 * Naked-eye limiting V magnitude of a point source of S/P ratio `starSP` seen against a uniform sky of
 * photopic luminance `skyP` and scotopic luminance `skyS` to which the observer is fully adapted —
 * computed with the same functions the renderer uses (mesopic state from CIE 191, Blackwell-equivalent
 * conversion, Crumey threshold with field factor F).
 */
export function limitingMagnitudeOnSky(skyP: number, skyS: number, starSP: number, fieldFactor: number): number {
  const mes = mesopic(Math.max(skyP, CRUMEY.zeroBackgroundB), Math.max(skyS, CRUMEY.zeroBackgroundB * CRUMEY.spRatioBlackwell));
  const bw = blackwellEquivalent(skyP, skyS, mes.m);
  const thr = fieldFactor * pointThreshold(bw);
  // A star of photopic illuminance E has Blackwell-equivalent illuminance k·E.
  const k = blackwellEquivalent(1, starSP, mes.m);
  return magnitudeFromLux(thr / k);
}

export { luxFromMagnitude };
