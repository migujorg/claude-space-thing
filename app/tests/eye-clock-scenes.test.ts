// CPU predictions for GPU re-acceptance. Baseline neural light/pupil values are held as measured inputs;
// this does not claim the sky cut's new GPU measurement is identical. No curve is fitted to these scenes.
const { readFileSync } = await import(/* @vite-ignore */ 'node:fs' as string);
import { describe, expect, it } from 'vitest';
import scenes from '../e2e/scenes.json';
import baseline from '../e2e/baseline/stats.json';
import { AdaptationState, computeEyeFrame } from '../src/eye/model';
import { adaptationStatus, trolands } from '../src/eye/bleaching';
import { DEFAULT_EYE_SETTINGS as settings } from '../src/eye/settings';
import { DEG2_PER_SR, pupilDiameterMm } from '../src/eye/pupil';
const { sceneQuery } = await import(/* @vite-ignore */ '../scripts/e2e-lib.mjs' as string);

describe('held scene clock CPU predictions', () => {
  it('reports the exact history instants against recorded baseline light and magnitude', () => {
    const light = JSON.parse(readFileSync(new URL('../public/data/light.json', import.meta.url), 'utf8'));
    const sunlight = light.sun.irradianceXYZS_1AU;
    expect(sunlight.label).toBe('derived');
    const sunSP = sunlight.value[3] / sunlight.value[1];
    console.log(`CPU input: built light.json S/Y = ${sunSP}; source IDs ${sunlight.sources.join(', ')}; eye defaults, baseline measured light/pupil, suite viewport.`);
    for (const scene of scenes.scenes) {
      const q = new URLSearchParams(sceneQuery(scenes, scene));
      if (!q.has('adapttime')) continue;
      const base = baseline.scenes[scene.id as keyof typeof baseline.scenes].stats;
      const fov = Number(q.get('fov') ?? 50) * Math.PI / 180; // app/model.ts DEFAULT_FOV_DEG
      const fieldDeg2 = 2 * Math.atan(Math.tan(fov / 2) * scenes.viewport.width / scenes.viewport.height) * fov * DEG2_PER_SR;
      const [L, exposureS] = q.get('adaptfrom')!.split(',').map(Number);
      const elapsedS = Number(q.get('adapttime'));
      const prePupil = pupilDiameterMm(L * fieldDeg2, settings.ageYears, settings.eyes);
      // Invert the same monotonic pupil formula to recover the baseline's recorded corneal flux.
      let lo = 0, hi = 1e6;
      for (let i = 0; i < 100; i++) {
        const mid = (lo + hi) / 2;
        if (pupilDiameterMm(mid, settings.ageYears, settings.eyes) > base.pupilDiameterMm) lo = mid;
        else hi = mid;
      }
      const s = new AdaptationState();
      s.timeDependent = true;
      s.heldElapsedS = elapsedS;
      s.update({ coneCdM2: base.adaptationLuminance, rodCdM2: base.scotopicAdaptationLuminance, cornealFlux: (lo + hi) / 2 }, 18, base.pupilDiameterMm);
      s.applyHistory(trolands(L, prePupil), trolands(L * sunSP, prePupil), exposureS, elapsedS);
      const e = computeEyeFrame(settings, s, 'eye', 0, null);
      const status = adaptationStatus(e.dark, s.td.rod);
      expect(e.Acone).toBe(base.adaptationLuminance);
      expect(e.Arod).toBe(base.scotopicAdaptationLuminance);
      expect(Number.isFinite(e.limitingMagnitude)).toBe(true);
      console.log(JSON.stringify({ id: scene.id, elapsedS, fieldDeg2, prePupilMm: prePupil,
        adaptationLuminance: e.Acone, scotopicAdaptationLuminance: e.Arod,
        baselineLimitingMagnitude: base.limitingMagnitude, heldLimitingMagnitude: e.limitingMagnitude,
        magnitudeDelta: e.limitingMagnitude - base.limitingMagnitude,
        darkAdaptationFraction: status.fraction, rodLogElevation: status.rodLogElevation,
        coneCatch: e.dark.coneCatch, minutesToFull: status.minutesToFull,
        baselineDarkAdaptation: 'not recorded', baselineStarsDrawn: base.starsDrawn }));
    }
  });
});
