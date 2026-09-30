// Photopigment bleaching and dark adaptation (eye/bleaching.ts, docs/eye-model.md §2 "Time"): kinetics, the
// classic features of the dark-adaptation curve after daylight, and the adapted eye left unchanged.
import { describe, expect, it } from 'vitest';
import {
  adaptationStatus, adaptationStatusText, darkAdaptation, rodBranchThreshold, coneBranchThreshold, rodEquivalentAdaptation,
  steadyBleach, steadyPigment, stepPigment, thresholdFactor, trolands, type PigmentState,
} from '../src/eye/bleaching';
import { CRUMEY, PIGMENT } from '../src/eye/constants';
import { pointThreshold, pointThresholdPhotopic, pointThresholdScotopic } from '../src/eye/crumey';
import { AdaptationState, computeEyeFrame, localObserver } from '../src/eye/model';
import { DEFAULT_EYE_SETTINGS } from '../src/eye/settings';
import { displayObserver } from '../src/eye/tonemap';

const SUN_SP = 2.375; // S/P of sunlight (light.json irradianceXYZS, S/Y), a test input
const DAY = 1e4; // cd/m², a sunlit landscape (test input)
const dayPupil = 2.5; // mm (test input)

/** Pigments after `minutes` of darkness following 10 min of daylight. */
function afterDaylight(minutes: number): PigmentState {
  const p0 = stepPigment({ cone: 0, rod: 0 }, trolands(DAY, dayPupil), trolands(DAY * SUN_SP, dayPupil), 600);
  return stepPigment(p0, 0, 0, minutes * 60);
}
const dark0 = steadyPigment(0, 0);
const display = displayObserver(DEFAULT_EYE_SETTINGS.displayPeakCdM2, 0);
/** Limiting magnitude on a dark background (2850 K point) for a pigment state. */
function limitAt(p: PigmentState): number {
  const o = localObserver(DEFAULT_EYE_SETTINGS, display, 0, 0, 1, darkAdaptation(p, dark0));
  return -2.5 * Math.log10(o.thresholdBwLux / CRUMEY.zeroPointVLux);
}

describe('pigment kinetics (first order)', () => {
  it('half-bleaches at I₀ in steady light; I₀ = Q/τ for rods', () => {
    expect(steadyPigment(PIGMENT.coneHalfBleachTd, 0).cone).toBeCloseTo(0.5, 12);
    expect(steadyPigment(0, PIGMENT.rodBleachTdS / PIGMENT.rodTauS).rod).toBeCloseTo(0.5, 12);
    expect(steadyBleach(0, 1)).toBe(0);
  });
  it('the exact step equals many small steps, and regeneration in the dark is exp(−t/τ)', () => {
    let p: PigmentState = { cone: 0.9, rod: 0.9 };
    for (let i = 0; i < 1000; i++) p = stepPigment(p, 3000, 5000, 0.3);
    const q = stepPigment({ cone: 0.9, rod: 0.9 }, 3000, 5000, 300);
    expect(p.cone).toBeCloseTo(q.cone, 10);
    expect(p.rod).toBeCloseTo(q.rod, 10);
    const d = stepPigment({ cone: 1, rod: 1 }, 0, 0, 400);
    expect(d.rod).toBeCloseTo(Math.exp(-1), 12);
    expect(d.cone).toBeCloseTo(Math.exp(-400 / 110), 12);
  });
  it('daylight bleaches most of both pigments', () => {
    const p = afterDaylight(0);
    expect(p.cone).toBeGreaterThan(0.6);
    expect(p.rod).toBeGreaterThan(0.75);
  });
});

describe('dark adaptation after daylight (Crumey branches, Dowling–Rushton rods, cone photon catch)', () => {
  const adapted = limitAt(dark0);
  const curve = [0, 1, 2, 3, 5, 8, 10, 12, 15, 18, 20, 25, 30, 35, 40, 50].map((m) => ({ m, lim: limitAt(afterDaylight(m)) }));
  it('prints the curve', () => {
    console.log('limiting magnitude after 10 min of daylight: ' + curve.map((c) => `${c.m} min ${c.lim.toFixed(2)}`).join(', ') + ` (adapted ${adapted.toFixed(2)})`);
  });
  it('the adapted eye is unchanged: factor 1, and the full-range Crumey threshold', () => {
    for (const B of [0, 1e-5, 1e-3, 0.07, 1, 100, 1e4]) expect(thresholdFactor(B, B * 1.4, darkAdaptation(dark0, dark0))).toBe(1);
    const o = localObserver(DEFAULT_EYE_SETTINGS, display, 0, 0, 1);
    expect(o.thresholdBwLux).toBeCloseTo(DEFAULT_EYE_SETTINGS.fieldFactor * pointThreshold(0), 20);
  });
  it('cones recover within minutes to a plateau (cone threshold), 1.0 log unit above the rods\' absolute threshold', () => {
    const plateau = adapted - 2.5 * Math.log10(pointThresholdPhotopic(CRUMEY.pointSplitB) / pointThresholdScotopic(CRUMEY.zeroBackgroundB));
    const at = (m: number) => curve.find((c) => c.m === m)!.lim;
    expect(at(0)).toBeLessThan(plateau - 0.5); // cones still bleached at first
    for (const m of [5, 8, 10, 12]) expect(Math.abs(at(m) - plateau)).toBeLessThan(0.1); // the plateau: rods still desensitised
  });
  it('then the rods take over (rod–cone break) and reach the adapted threshold after ~30–40 min', () => {
    const at = (m: number) => curve.find((c) => c.m === m)!.lim;
    expect(at(20)).toBeGreaterThan(at(12) + 0.5);
    expect(at(40)).toBeGreaterThan(adapted - 0.25);
    expect(at(25)).toBeLessThan(adapted - 0.25);
    // Monotonic recovery.
    for (let i = 1; i < curve.length; i++) expect(curve[i].lim).toBeGreaterThanOrEqual(curve[i - 1].lim - 1e-9);
  });
  it('after a full bleach, the rod threshold falls 3 → 1 log unit at ~0.2–0.35 log/min (S2; Lamb 1981: 0.24) and reaches 0.1 at ~30 min', () => {
    // Elevation a·exp(−t/τ): time from 3 to 1 log unit and to 0.1.
    const t = (e: number) => (PIGMENT.rodTauS / 60) * Math.log(PIGMENT.rodDowlingRushton / e);
    const s2 = 2 / (t(1) - t(3));
    expect(s2).toBeGreaterThan(0.2);
    expect(s2).toBeLessThan(0.35);
    expect(t(0.1)).toBeGreaterThan(28);
    expect(t(0.1)).toBeLessThan(40);
    expect(darkAdaptation(stepPigment({ cone: 1, rod: 1 }, 0, 0, t(1) * 60), dark0).rodLogElevation).toBeCloseTo(1, 9);
  });
  it('the equivalent background follows Weber above the dark light and is the identity when adapted', () => {
    expect(rodEquivalentAdaptation(0.01, 0)).toBe(0.01);
    const L0 = CRUMEY.zeroBackgroundB * CRUMEY.spRatioBlackwell;
    expect(rodEquivalentAdaptation(0.01, 2)).toBeCloseTo(100 * (0.01 + L0) - L0, 12);
  });
  it('branch thresholds: rods Weber beyond Crumey\'s range, cones held at the split', () => {
    const s = CRUMEY.pointSplitB;
    expect(rodBranchThreshold(10 * s)).toBeCloseTo(10 * rodBranchThreshold(s), 20);
    expect(coneBranchThreshold(0)).toBe(coneBranchThreshold(s));
    // At the split both branches agree (Crumey's text after Eq. 27), to 20 %.
    expect(rodBranchThreshold(s) / coneBranchThreshold(s)).toBeGreaterThan(0.8);
    expect(rodBranchThreshold(s) / coneBranchThreshold(s)).toBeLessThan(1.25);
  });
});

describe('adaptation state and status', () => {
  it('instant: pigments in steady state; realtime: they lag and recover', () => {
    const s = new AdaptationState();
    s.update({ coneCdM2: DAY, rodCdM2: DAY * SUN_SP, cornealFlux: DAY * 3000 }, 0, dayPupil);
    s.update({ coneCdM2: 1e-4, rodCdM2: 3e-4, cornealFlux: 1 }, 1, 7);
    expect(s.dark().rodLogElevation).toBe(0);
    const r = new AdaptationState();
    r.timeDependent = true;
    r.update({ coneCdM2: DAY, rodCdM2: DAY * SUN_SP, cornealFlux: DAY * 3000 }, 0, dayPupil);
    for (let i = 0; i < 60; i++) r.update({ coneCdM2: DAY, rodCdM2: DAY * SUN_SP, cornealFlux: DAY * 3000 }, 10, dayPupil);
    r.update({ coneCdM2: 1e-4, rodCdM2: 3e-4, cornealFlux: 1 }, 1, 7);
    const d1 = r.dark();
    expect(d1.rodLogElevation).toBeGreaterThan(8);
    const eye = computeEyeFrame(DEFAULT_EYE_SETTINGS, r, 'eye', 0, null);
    expect(eye.ArodEff).toBeGreaterThan(1e3); // rods behave as if in daylight
    for (let i = 0; i < 40 * 60; i++) r.update({ coneCdM2: 1e-4, rodCdM2: 3e-4, cornealFlux: 1 }, 1, 7);
    expect(r.dark().rodLogElevation).toBeLessThan(0.1);
    const st = adaptationStatus(d1, r.td.rod);
    expect(st.adapted).toBe(false);
    expect(st.minutesToFull).toBeGreaterThan(25);
    expect(st.minutesToFull).toBeLessThan(40);
    expect(adaptationStatusText(st)).toMatch(/^dark adaptation \d+ % — \d+ min to full$/);
    expect(adaptationStatusText(adaptationStatus(r.dark(), r.td.rod))).toBe('adapted');
  });
  it('a history: daylight, then minutes in the dark view', () => {
    const s = new AdaptationState();
    s.timeDependent = true;
    s.update({ coneCdM2: 1e-4, rodCdM2: 3e-4, cornealFlux: 1 }, 0, 7);
    s.pigment = null;
    s.applyHistory(trolands(DAY, dayPupil), trolands(DAY * SUN_SP, dayPupil), 600, 300);
    const p = afterDaylight(5);
    expect(s.pigment!.rod).toBeCloseTo(p.rod, 3);
    expect(s.pigment!.cone).toBeCloseTo(p.cone, 3);
  });
});
