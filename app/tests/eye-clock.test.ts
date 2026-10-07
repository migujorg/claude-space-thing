import { describe, expect, it } from 'vitest';
import { AdaptationState, computeEyeFrame, type AdaptationGoal } from '../src/eye/model';
import { stepPigment, trolands } from '../src/eye/bleaching';
import { CRUMEY, PATTANAIK } from '../src/eye/constants';
import { DEFAULT_EYE_SETTINGS } from '../src/eye/settings';

const goal: AdaptationGoal = { coneCdM2: 1e-4, rodCdM2: 3e-4, cornealFlux: 1 };
const pre = { cone: trolands(10000, 2.5), rod: trolands(23750, 2.5) }; // test light and pupil
function history(s: AdaptationState, elapsedS: number) {
  s.pigment = null; // renderer starts a defined history from regenerated pigments
  s.applyHistory(pre.cone, pre.rod, 600, elapsedS);
}
function reference(g: AdaptationGoal, elapsedS: number, pupil = 7) {
  const s = new AdaptationState();
  s.timeDependent = true;
  s.update(g, 0, pupil);
  history(s, elapsedS);
  return s;
}
const eye = (s: AdaptationState) => computeEyeFrame(DEFAULT_EYE_SETTINGS, s, 'eye', 0, null);

describe('held eye clock', () => {
  for (const elapsedS of [0, 60, 120, 720, 1800]) {
    it(`reads exactly ${elapsedS} s of history after arbitrary loading and sampled frames`, () => {
      const s = new AdaptationState();
      s.timeDependent = true;
      s.heldElapsedS = elapsedS;
      s.update(goal, 18, 7);
      history(s, 999); // held instant overrides the legacy adaptfrom elapsed time
      const expected = reference(goal, elapsedS);
      expect(eye(s)).toEqual(eye(expected));
      for (const dt of [0, 0.001, 2, 18, 0.016, 10000, ...Array(60).fill(0.016)]) {
        s.update(goal, dt, 7);
        expect(eye(s)).toEqual(eye(expected));
      }
    });
  }
  it('re-evaluates history under the newly measured light and pupil while the scene settles', () => {
    const s = reference(goal, 60);
    s.heldElapsedS = 120;
    const bright = { coneCdM2: 10, rodCdM2: 20, cornealFlux: 100 };
    s.update(bright, 0.01, 3);
    history(s, 60);
    s.update(goal, 100, 7);
    expect(eye(s)).toEqual(eye(reference(goal, 120)));
    // Reapplying a history must never compound the old bleach.
    history(s, 60);
    expect(eye(s)).toEqual(eye(reference(goal, 120)));
  });
  it('without the parameter preserves the neural filters, pigment kinetics and zero-dt behavior', () => {
    const s = reference(goal, 120);
    const bright = { coneCdM2: 1, rodCdM2: 2, cornealFlux: 100 };
    const old = { cone: s.coneCdM2, rod: s.rodCdM2, pigment: { ...s.pigment! } };
    s.update(bright, 0.1, 3);
    expect(s.coneCdM2).toBe(old.cone + (1 - Math.exp(-0.1 / PATTANAIK.t0Cone)) * (1 - old.cone));
    expect(s.rodCdM2).toBe(old.rod + (1 - Math.exp(-0.1 / PATTANAIK.t0Rod)) * (2 - old.rod));
    expect(s.pigment).toEqual(stepPigment(old.pigment, trolands(1, 3), trolands(2, 3), 0.1));
    const pigment = s.pigment;
    s.update({ coneCdM2: 0, rodCdM2: 0, cornealFlux: 0 }, 0, 7);
    expect(s.coneCdM2).toBe(CRUMEY.zeroBackgroundB);
    expect(s.pigment).toBe(pigment);
  });
});
