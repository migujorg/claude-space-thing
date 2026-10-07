// A resolved body the eye is adapted to (docs/eye-model.md §2 "Fixations", §6.3). Found on 2026-10-07: Ganymede,
// 3.6′ across and about 400 cd/m², was drawn black at a 1° field while the frame was adapted to its own light:
// its luminance carried a Ricco weight A_t/A_R, and the adaptation did not.
import { describe, expect, it } from 'vitest';
import { cameraGeom, prepareFrame, SIGMA_MIN_PX } from '../src/render/frame';
import { AdaptationState, computeEyeFrame } from '../src/eye/model';
import { DEFAULT_EYE_SETTINGS } from '../src/eye/settings';
import { extendedDisplay, extendedPerceived } from '../src/eye/extended';
import { inverseDisplay } from '../src/eye/tonemap';
import { PATTANAIK } from '../src/eye/constants';
import { AU_KM } from '../src/render/constants';
import type { SceneBody, SceneSnapshot } from '../src/render/scene';

const W = 1280, H = 720;
const ARCMIN = Math.PI / (180 * 60);

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
  const fields = [1, 3, 10, 50];
  const sizesPx = [2, 3, 5, 10, 20, 43, 100, 300];

  /** The frame adapted to the disk, and each view in which the disk is drawn fully resolved. */
  function* views() {
    for (const { L, u } of cases) {
      const state = new AdaptationState();
      state.update({ coneCdM2: u * L, rodCdM2: u * L * SP, cornealFlux: 0 }, 0);
      const eye = computeEyeFrame(DEFAULT_EYE_SETTINGS, state, 'eye', 0, null);
      for (const fovDeg of fields) {
        const g = cameraGeom(snap([], fovDeg), W, H, 1e-7);
        // The point splat as the renderer draws it (renderer.ts): the eye's optical core, or the reconstruction minimum.
        const sigmaPx = Math.max(((eye.coreSigmaDeg * Math.PI) / 180) / g.pixelAngle, SIGMA_MIN_PX);
        const footprintSr = 2 * Math.PI * sigmaPx * sigmaPx * g.pixelAngle * g.pixelAngle;
        for (const diamPx of sizesPx) {
          const p = prepareFrame(snap([body((2 * 2600) / (diamPx * g.pixelAngle))], fovDeg), g, eye, footprintSr);
          if (p.points.length || p.resolved.length !== 1) continue;   // a point, or in the switch: another regime
          yield { L, u, eye, fovDeg, diamPx, arcmin: (diamPx * g.pixelAngle) / ARCMIN, body: p.resolved[0] };
        }
      }
    }
  }

  it('is shown above the tone map\'s reference black at every angular diameter at which it is drawn resolved', () => {
    const failures: string[] = [];
    let n = 0;
    for (const v of views()) {
      n++;
      // Pattanaik's reference black (5A/32) and what the display shows for it.
      const blackCdM2 = (PATTANAIK.refWhiteFactor / PATTANAIK.refBlackDivisor) * v.eye.Acone;
      const blackLd = inverseDisplay(v.eye.map.gain * v.eye.refs.black + v.eye.map.offset, v.eye.display);
      // What the frame gives the composite for this body: nothing that depends on its size.
      expect(v.body.riccoWeight).toBe(1);
      const perceived = extendedPerceived(v.eye, { Y: v.L, S: v.L * SP }, v.u).Y;
      const shown = extendedDisplay(v.eye, { Y: v.L, S: v.L * SP }, v.u);
      if (!(perceived > blackCdM2 && shown.Ld > blackLd)) {
        failures.push(`L ${v.L} u ${v.u} fov ${v.fovDeg}° ${v.arcmin.toFixed(2)}′ (${v.diamPx} px): perceived ${perceived.toPrecision(3)} ≤ black ${blackCdM2.toPrecision(3)} cd/m², shown ${shown.Ld.toPrecision(3)} cd/m²`);
      }
    }
    expect(failures).toEqual([]);
    // Every size from 2 px is resolved at 10° and 50°; at 1° and 3° the disks under the eye's point spread are points.
    expect(n).toBeGreaterThan(cases.length * 2 * sizesPx.length);
  });

  it('is shown at the luminance the display gives the adaptation level, whatever its angular diameter', () => {
    for (const v of views()) {
      const adapted = extendedDisplay(v.eye, { Y: v.eye.Acone / v.u, S: v.eye.Arod / v.u }, v.u).Ld;
      const shown = extendedDisplay(v.eye, { Y: v.L, S: v.L * SP }, v.u).Ld;
      expect(shown).toBeCloseTo(adapted, 9);
      // Mid-grey on the default 200 cd/m² display: the §10 table's 31.9 to 46 cd/m² between 10² and 10⁴ cd/m².
      expect(shown).toBeGreaterThan(30);
      expect(shown).toBeLessThan(50);
    }
  });
});
