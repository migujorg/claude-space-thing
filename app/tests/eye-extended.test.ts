// A resolved body the eye is adapted to (docs/eye-model.md §2 "Fixations", §6.3). Found on 2026-10-07: Ganymede,
// 3.6′ across and about 400 cd/m², was drawn black at a 1° field while the frame was adapted to its own light.
import { describe, expect, it } from 'vitest';
import { cameraGeom, prepareFrame } from '../src/render/frame';
import { AdaptationState, computeEyeFrame } from '../src/eye/model';
import { DEFAULT_EYE_SETTINGS } from '../src/eye/settings';
import { extendedDisplay } from '../src/eye/extended';
import { inverseDisplay } from '../src/eye/tonemap';
import { PATTANAIK } from '../src/eye/constants';
import { AU_KM } from '../src/render/constants';
import type { SceneBody, SceneSnapshot } from '../src/render/scene';

const W = 1280, H = 720;
const ARCMIN = Math.PI / (180 * 60);
/** The renderer's smallest point-splat σ, px (renderer.ts SIGMA_MIN_PX). */
const SIGMA_MIN_PX = 0.6;

function snap(bodies: SceneBody[], fovDeg: number): SceneSnapshot {
  return {
    et: 0,
    camera: { orient: [1, 0, 0, 0, 1, 0, 0, 0, 1], fovY: (fovDeg * Math.PI) / 180, width: W, height: H },
    sun: null, bodies,
    view: { mode: 'eye', exposureBoostStops: 0, overlays: { provenanceTint: false } },
    orbits: [],
  };
}

/** A sunlit sphere on the view axis (test values: only its angular size matters here). */
function body(distKm: number): SceneBody {
  return {
    id: 1, name: 'B', pos: [0, 0, -distKm], toSun: [0, 0, 5 * AU_KM], orient: null, radii: [2600, 2600, 2600],
    albedoXYZS: [3.6e4, 3.8e4, 3.5e4, 8.8e4], phase: { kind: 'lambert' }, surfaceUnknown: false, worstLabel: 'measured', selected: false,
  };
}

describe('a sunlit disk the eye is adapted to', () => {
  // A uniform disk of luminance L alone in a dark frame. Its retinal image is u·L (u: the unscattered fraction), and
  // the fixation-weighted adaptation of that frame is u·L (fixation.ts: every fixation falls on the disk).
  // Luminances: the lit-disk means of Callisto, Ganymede and Jupiter in the lane's GPU runs of 2026-10-07, and an
  // Earth-like one; S/P 2.27 as rendered for Ganymede. u = 0.6 and 0.655 are the fractions those runs had at 50° and 1°.
  const cases = [150, 400, 650, 5000].flatMap((L) => [0.6, 0.655].map((u) => ({ L, u })));
  const SP = 2.27;

  it('is shown above the tone map\'s reference black at every angular diameter at which it is drawn resolved', () => {
    const failures: string[] = [];
    for (const { L, u } of cases) {
      const state = new AdaptationState();
      state.update({ coneCdM2: u * L, rodCdM2: u * L * SP, cornealFlux: 0 }, 0);
      const eye = computeEyeFrame(DEFAULT_EYE_SETTINGS, state, 'eye', 0, null);
      // Pattanaik's reference black (5A/32) and what the display shows for it.
      const blackCdM2 = (PATTANAIK.refWhiteFactor / PATTANAIK.refBlackDivisor) * eye.Acone;
      const blackLd = inverseDisplay(eye.map.gain * eye.refs.black + eye.map.offset, eye.display);
      for (const fovDeg of [1, 3, 10, 50]) {
        const g = cameraGeom(snap([], fovDeg), W, H, 1e-7);
        const sigmaPx = Math.max(((eye.coreSigmaDeg * Math.PI) / 180) / g.pixelAngle, SIGMA_MIN_PX);
        const footprintSr = 2 * Math.PI * sigmaPx * sigmaPx * g.pixelAngle * g.pixelAngle;
        for (const diamPx of [2, 3, 5, 10, 20, 43, 100, 300]) {
          const dist = (2 * 2600) / (diamPx * g.pixelAngle);
          const p = prepareFrame(snap([body(dist)], fovDeg), g, eye, footprintSr);
          expect(p.points.length).toBe(0);      // fully resolved from 2 px
          expect(p.resolved.length).toBe(1);
          const shown = extendedDisplay(eye, { Y: L, S: L * SP }, p.resolved[0].riccoWeight, u);
          const perceived = p.resolved[0].riccoWeight * u * L;
          if (!(perceived > blackCdM2 && shown.Ld > blackLd)) {
            failures.push(`L ${L} u ${u} fov ${fovDeg}° ${(diamPx * g.pixelAngle / ARCMIN).toFixed(2)}′ (${diamPx} px): perceived ${perceived.toPrecision(3)} ≤ black ${blackCdM2.toPrecision(3)} cd/m², shown ${shown.Ld.toPrecision(3)} cd/m²`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
