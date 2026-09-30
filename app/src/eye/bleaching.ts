// Photopigment bleaching and dark adaptation (docs/eye-model.md §2 "Time"). Pure TS.
//
// The pigments of the cones and rods are bleached by light and regenerate in the dark, with first-order
// kinetics (PIGMENT in constants.ts). What the pigment state does to vision:
// - rods: the Dowling–Rushton relation (Alpern, Rushton & Torii 1970), the threshold is raised by
//   10^(a·B) over the absolute threshold. We apply it to the bleach in excess of the steady state for the
//   current light (the steady state is already part of the measured thresholds and tone model), and turn
//   it into an equivalent background (Crawford 1947) with Weber's law above the dark light;
// - cones: only the loss of photon catch, (1 − B). The cones' psychophysical desensitisation after a
//   bleach exceeds it (Hollins & Alpern 1973), but no constant for it could be verified (§10).
// Detection is by whichever system is more sensitive: Crumey's (2014) rod and cone branches.

import { CRUMEY, PIGMENT } from './constants';

/** Bleached fractions of the cone and rod pigments (0 = fully regenerated). */
export interface PigmentState {
  cone: number;
  rod: number;
}

/** Retinal illuminance, trolands: luminance (cd/m², scotopic cd/m² for scotopic td) × pupil area (mm²). */
export function trolands(L: number, pupilMm: number): number {
  return (Math.max(L, 0) * Math.PI * pupilMm * pupilMm) / 4;
}

const CONE_I0 = PIGMENT.coneHalfBleachTd;
const ROD_I0 = PIGMENT.rodBleachTdS / PIGMENT.rodTauS;

/** Bleached fraction in steady light I (td) with half-bleaching illuminance I₀. */
export function steadyBleach(I: number, I0: number): number {
  return I / (I + I0);
}

/**
 * dB/dt = I·(1 − B)/Q − B/τ with Q = I₀·τ, integrated exactly over dt for constant I:
 * B → B∞ = I/(I + I₀) with rate (I + I₀)/(I₀·τ).
 */
export function stepBleach(B: number, I: number, I0: number, tauS: number, dt: number): number {
  const Binf = steadyBleach(I, I0);
  return Binf + (B - Binf) * Math.exp((-(I + I0) / (I0 * tauS)) * dt);
}

export function steadyPigment(coneTd: number, rodTd: number): PigmentState {
  return { cone: steadyBleach(coneTd, CONE_I0), rod: steadyBleach(rodTd, ROD_I0) };
}

export function stepPigment(p: PigmentState, coneTd: number, rodTd: number, dt: number): PigmentState {
  return {
    cone: stepBleach(p.cone, coneTd, CONE_I0, PIGMENT.coneTauS, dt),
    rod: stepBleach(p.rod, rodTd, ROD_I0, PIGMENT.rodTauS, dt),
  };
}

/** The eye's sensitivity beyond steady adaptation to the current light (all neutral when adapted). */
export interface DarkAdaptation {
  /** Bleached fractions now. */
  pigment: PigmentState;
  /** Bleached fractions in steady state under the current light. */
  steady: PigmentState;
  /** log₁₀ of the rod threshold elevation over that steady state (Dowling–Rushton on the excess bleach). */
  rodLogElevation: number;
  /** Cone photon catch relative to the steady state, (1 − B)/(1 − B∞) ≤ 1. */
  coneCatch: number;
}

export const ADAPTED: DarkAdaptation = { pigment: { cone: 0, rod: 0 }, steady: { cone: 0, rod: 0 }, rodLogElevation: 0, coneCatch: 1 };

export function darkAdaptation(pigment: PigmentState, steady: PigmentState): DarkAdaptation {
  const excess = Math.max(0, pigment.rod - steady.rod);
  return {
    pigment,
    steady,
    rodLogElevation: PIGMENT.rodDowlingRushton * excess,
    coneCatch: Math.min(1, (1 - pigment.cone) / Math.max(1 - steady.cone, 1e-12)),
  };
}

/** Rod dark light (scotopic cd/m²): Crumey's zero-background level in scotopic units of Blackwell's light. */
const ROD_L0 = CRUMEY.zeroBackgroundB * CRUMEY.spRatioBlackwell;

/**
 * Rod adaptation luminance equivalent to the eye's state (Crawford 1947, "equivalent background"): with
 * Weber's law above the dark light L₀, a threshold raised E-fold over the eye adapted to A is the
 * threshold of an eye adapted to E·(A + L₀) − L₀.
 */
export function rodEquivalentAdaptation(Arod: number, rodLogElevation: number): number {
  if (!(rodLogElevation > 0)) return Arod;
  // Capped at the float range: past rod saturation the value no longer matters.
  const E = Math.pow(10, Math.min(rodLogElevation, 30));
  return E * (Math.max(Arod, 0) + ROD_L0) - ROD_L0;
}

/** Crumey (2014) scotopic point-source branch (Eq. 32/26) up to its range limit, Weber's law beyond it. */
export function rodBranchThreshold(Bbw: number): number {
  const s = CRUMEY.pointSplitB;
  const b = Math.min(Math.max(Bbw, CRUMEY.zeroBackgroundB), s);
  const v = CRUMEY.r1 * Math.pow(b, 0.25) + CRUMEY.r2 * Math.sqrt(b);
  return v * v * Math.max(1, Bbw / s);
}

/** Crumey (2014) photopic point-source branch (Eq. 33/27), not below its range (the split point). */
export function coneBranchThreshold(B: number): number {
  const b = Math.max(B, CRUMEY.pointSplitB);
  const v = CRUMEY.r3 * Math.pow(b, 0.25) + CRUMEY.r4 * Math.sqrt(b);
  return v * v;
}

/**
 * Factor (≥ 1) by which the eye's state raises a point-source threshold over the steady state for its
 * background (Acone photopic, Arod scotopic cd/m²): the more sensitive of rods (Dowling–Rushton) and cones
 * (photon catch) detects, each on its own Crumey branch. Exactly 1 when adapted, so the full-range
 * threshold of the adapted eye is kept.
 */
export function thresholdFactor(Acone: number, Arod: number, d: DarkAdaptation): number {
  if (!(d.rodLogElevation > 0) && !(d.coneCatch < 1)) return 1;
  const tr = rodBranchThreshold(Arod / CRUMEY.spRatioBlackwell);
  const tc = coneBranchThreshold(Acone);
  const trE = tr * Math.pow(10, Math.min(d.rodLogElevation, 30));
  const tcE = tc / Math.max(d.coneCatch, 1e-12);
  return Math.max(1, Math.min(trE, tcE) / Math.min(tr, tc));
}

/**
 * Reporting criterion for "fully adapted": the rod threshold within 0.1 log unit of its steady value.
 * A choice for the display of the state (docs/eye-model.md §2), not a model constant.
 */
export const ADAPTED_LOG_CRITERION = 0.1;

export interface AdaptationStatus {
  /** Share of the excess rod bleach regenerated, 0–1 (1 = adapted to the current light). */
  fraction: number;
  /** Time until the rod threshold is within ADAPTED_LOG_CRITERION of its steady value, if the light stays as it is, min. */
  minutesToFull: number;
  /** log₁₀ rod threshold elevation now. */
  rodLogElevation: number;
  adapted: boolean;
}

/**
 * The state under the current light I (rod trolands): the excess bleach ΔB decays as exp(−k·t) with
 * k = (I + I₀)/(I₀·τ), so the elevation a·ΔB reaches the criterion after ln(a·ΔB/criterion)/k.
 */
export function adaptationStatus(d: DarkAdaptation, rodTd: number): AdaptationStatus {
  const excess = Math.max(0, d.pigment.rod - d.steady.rod);
  const k = (rodTd + ROD_I0) / (ROD_I0 * PIGMENT.rodTauS);
  const e = d.rodLogElevation;
  const adapted = e <= ADAPTED_LOG_CRITERION;
  return {
    fraction: 1 - excess,
    minutesToFull: adapted ? 0 : Math.log(e / ADAPTED_LOG_CRITERION) / k / 60,
    rodLogElevation: e,
    adapted,
  };
}

/** HUD line, e.g. "dark adaptation 12 % — 8 min to full" (or "adapted"). */
export function adaptationStatusText(s: AdaptationStatus): string {
  if (s.adapted) return 'adapted';
  const m = s.minutesToFull;
  const t = m >= 1 ? `${Math.ceil(m)} min` : `${Math.max(1, Math.ceil(m * 60))} s`;
  return `dark adaptation ${Math.floor(100 * s.fraction)} % — ${t} to full`;
}
