// The eye model's per-frame state: adaptation (goal → current), pupil, mesopic state, and every
// scalar the GPU passes need. Pure TS, no GPU; see docs/eye-model.md for the stage-by-stage account.

import { CRUMEY, PATTANAIK } from './constants';
import { luxFromMagnitude, magnitudeFromLux, pointThreshold, riccoArea } from './crumey';
import { blackwellEquivalent, mesopic, type MesopicResult } from './mesopic';
import { pupilDiameterMm } from './pupil';
import { appearanceMap, displayObserver, observerState, sceneReferences, type AppearanceMap, type DisplayObserver, type ObserverState, type References } from './tonemap';
import { cat02Matrix, degreeOfAdaptation, displayWhiteXYZ, type M3, type V3 } from './display';
import { opticalCoreSigmaDeg } from './glare';
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
 * Adaptation state. v0 is instantaneous (current = goal). The structure follows Pattanaik et al.
 * (2000) §4.1.2 so the time course can be switched on later: neural adaptation A as first-order
 * exponential filters with t0 = 80 ms (cones) / 150 ms (rods); pigment kinetics are M5 work.
 */
export class AdaptationState {
  goal: AdaptationGoal | null = null;
  coneCdM2 = 1;
  rodCdM2 = 1;
  cornealFlux = 0;
  timeDependent = false;

  /** Feed a new measurement. dt (s) is only used when timeDependent is on. */
  update(goal: AdaptationGoal, dt: number): void {
    this.goal = goal;
    const floorC = CRUMEY.zeroBackgroundB;
    const floorR = CRUMEY.zeroBackgroundB * CRUMEY.spRatioBlackwell;
    const gc = Math.max(goal.coneCdM2, floorC);
    const gr = Math.max(goal.rodCdM2, floorR);
    if (!this.timeDependent || !(dt > 0)) {
      this.coneCdM2 = gc;
      this.rodCdM2 = gr;
    } else {
      const fc = 1 - Math.exp(-dt / PATTANAIK.t0Cone);
      const fr = 1 - Math.exp(-dt / PATTANAIK.t0Rod);
      this.coneCdM2 += fc * (gc - this.coneCdM2);
      this.rodCdM2 += fr * (gr - this.rodCdM2);
    }
    this.cornealFlux = goal.cornealFlux;
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
}

export function computeEyeFrame(
  settings: EyeSettings,
  state: AdaptationState,
  mode: 'eye' | 'enhanced',
  boostStops: number,
  adaptedWhiteXYZ: V3 | null,
): EyeFrame {
  const Acone = state.coneCdM2;
  const Arod = state.rodCdM2;
  const pupilMm = pupilDiameterMm(state.cornealFlux, settings.ageYears, settings.eyes);
  const mes = mesopic(Acone, Arod);
  const scene = observerState(Acone, Arod, settings.coneBleaching);
  const refs = sceneReferences(scene);
  const display = displayObserver(settings.displayPeakCdM2, settings.displayBlackCdM2);
  const map = appearanceMap(refs, display);
  const exposure = mode === 'enhanced' ? Math.pow(2, boostStops) : 1;
  const adaptBw = blackwellEquivalent(Acone, Arod, mes.m);
  const thresholdBwLux = (settings.fieldFactor * pointThreshold(adaptBw)) / exposure;
  // Limiting magnitude of a 2850 K point: its Blackwell-equivalent illuminance equals its photopic one.
  const limitingMagnitude = magnitudeFromLux(thresholdBwLux);
  const D = degreeOfAdaptation(Acone);
  const cat = adaptedWhiteXYZ ? cat02Matrix(adaptedWhiteXYZ, displayWhiteXYZ(), D) : ([1, 0, 0, 0, 1, 0, 0, 0, 1] as M3);
  return {
    settings,
    mode,
    exposure,
    Acone,
    Arod,
    pupilMm,
    mesopic: mes,
    scene,
    refs,
    display,
    map,
    adaptBw,
    riccoAreaSr: riccoArea(adaptBw),
    thresholdBwLux,
    limitingMagnitude,
    coreSigmaDeg: opticalCoreSigmaDeg(pupilMm),
    cat,
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
