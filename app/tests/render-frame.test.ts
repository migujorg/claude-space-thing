// Frame preparation: resolved ↔ point transition conserves the disk-integrated illuminance, missing
// data is never filled in, and the Sun without limb darkening is a point of the correct illuminance.
import { describe, expect, it } from 'vitest';
import { cameraGeom, prepareFrame } from '../src/render/frame';
import { AdaptationState, computeEyeFrame } from '../src/eye/model';
import { DEFAULT_EYE_SETTINGS } from '../src/eye/settings';
import { diskIlluminance, lambertPhase, lambertRadianceFactor, type XYZS } from '../src/render/photometry';
import { AU_KM } from '../src/render/constants';
import { PROVENANCE_TINT } from '../src/render/overlays';
import type { SceneBody, SceneSnapshot } from '../src/render/scene';

const W = 1280, H = 720;
const albedo: XYZS = [3.6e4, 3.8e4, 3.5e4, 8.8e4]; // test values
const eyeState = () => { const s = new AdaptationState(); s.update({ coneCdM2: 1e-5, rodCdM2: 1.4e-5, cornealFlux: 0 }, 0); return s; };

function snap(bodies: SceneBody[], fovDeg = 5, sun: SceneSnapshot['sun'] = null): SceneSnapshot {
  return {
    et: 0,
    camera: { orient: [1, 0, 0, 0, 1, 0, 0, 0, 1], fovY: (fovDeg * Math.PI) / 180, width: W, height: H },
    sun, bodies,
    view: { mode: 'eye', exposureBoostStops: 0, overlays: { provenanceTint: false } },
    orbits: [],
  };
}

function body(distKm: number, extra: Partial<SceneBody> = {}): SceneBody {
  // Camera looks along −z; Sun direction at phase 0 (behind the observer).
  return {
    id: 1, name: 'B', pos: [0, 0, -distKm], toSun: [0, 0, 5 * AU_KM], orient: null, radii: [6000, 6000, 6000],
    albedoXYZS: albedo, phase: { kind: 'lambert' }, surfaceUnknown: false, worstLabel: 'measured', selected: false, ...extra,
  };
}

describe('resolved/point split', () => {
  it('resolved fraction + point fraction always sum to the disk-integrated illuminance', () => {
    const eye = computeEyeFrame(DEFAULT_EYE_SETTINGS, eyeState(), 'eye', 0, null);
    const g = cameraGeom(snap([]), W, H, 1e-7);
    for (const diamPx of [0.5, 0.9, 1.2, 1.5, 1.8, 2.5]) {
      const dist = (2 * 6000) / (diamPx * g.pixelAngle);
      const s = snap([body(dist)]);
      const p = prepareFrame(s, g, eye, 1e-9);
      const E = diskIlluminance(albedo, 5, 6000, dist, lambertPhase(0));
      const Kfull = lambertRadianceFactor(albedo, 5, 1);
      const fRes = p.resolved.length ? p.resolved[0].K[1] / Kfull[1] : 0;
      const Epoint = p.points.length ? p.points[0].E[1] : 0;
      expect(fRes * E[1] + Epoint).toBeCloseTo(E[1], 6 - Math.round(Math.log10(E[1])));
      if (diamPx <= 1) expect(p.resolved.length).toBe(0);
      if (diamPx >= 2) expect(p.points.length).toBe(0);
    }
  });
  it('never invents light: unknown surface / missing albedo / missing phase / missing radii', () => {
    const eye = computeEyeFrame(DEFAULT_EYE_SETTINGS, eyeState(), 'eye', 0, null);
    const g = cameraGeom(snap([]), W, H, 1e-7);
    for (const extra of [{ surfaceUnknown: true }, { albedoXYZS: null }, { phase: null }] as Partial<SceneBody>[]) {
      const p = prepareFrame(snap([body(1e5, extra)], 60), g, eye, 1e-9);
      expect(p.points.length).toBe(0);
      expect(p.resolved.length).toBe(1);
      expect(p.resolved[0].lit).toBe(false);
      expect(p.resolved[0].hatch).toBe(true);
      expect(p.resolved[0].K).toEqual([0, 0, 0, 0]);
    }
    const noR = prepareFrame(snap([body(1e5, { radii: null })], 60), g, eye, 1e-9);
    expect(noR.resolved.length + noR.points.length).toBe(0);
    expect(noR.overlay.length).toBe(0); // the shell draws the hollow marker (ui/labels.ts), not the renderer
  });
  it('a measured phase curve outside its validity range is not extrapolated', () => {
    const eye = computeEyeFrame(DEFAULT_EYE_SETTINGS, eyeState(), 'eye', 0, null);
    const g = cameraGeom(snap([]), W, H, 1e-7);
    const b = body(1e5, { phase: { kind: 'poly-mag', coeffs: [0, 0.01], minDeg: 20, maxDeg: 120 } }); // α = 0 here
    const p = prepareFrame(snap([b], 60), g, eye, 1e-9);
    expect(p.resolved[0].lit).toBe(false);
    expect(p.warnings.join()).toMatch(/outside/);
  });
  it('best estimate: outside the measured range Φ continues with the spatial law, continuous at the edge, labelled estimated', () => {
    const eye = computeEyeFrame(DEFAULT_EYE_SETTINGS, eyeState(), 'eye', 0, null);
    const s0 = snap([], 60);
    s0.view.overlays.provenanceTint = true;
    const g = cameraGeom(s0, W, H, 1e-7);
    const pf = { kind: 'poly-mag' as const, coeffs: [0, 0.03], minDeg: 0, maxDeg: 5 }; // measured near opposition only
    // Sun at phase 30° as seen from the camera.
    const a = (30 * Math.PI) / 180;
    const at = (allow: boolean) => {
      const b = body(1e5, { phase: pf, worstLabel: 'measured', allowPhaseExtrapolation: allow, toSun: [5 * AU_KM * Math.sin(a), 0, 5 * AU_KM * Math.cos(a)] });
      return prepareFrame({ ...s0, bodies: [b] }, g, eye, 1e-9);
    };
    const strict = at(false);
    expect(strict.resolved[0].lit).toBe(false);
    expect(strict.resolved[0].hatch).toBe(true);
    const best = at(true);
    expect(best.resolved[0].lit).toBe(true);
    expect(best.warnings.join()).toMatch(/phase extrapolated beyond measured range/);
    // Lambert law: Φ(30°) = Φ_meas(5°)·Φ_L(30°)/Φ_L(5°).
    const phi5 = Math.pow(10, -0.4 * 0.03 * 5);
    const expectE = diskIlluminance(albedo, 5, 6000, 1e5, (phi5 * lambertPhase(a)) / lambertPhase((5 * Math.PI) / 180));
    const Kfull = best.resolved[0].K[1] / smoothRes(best);
    // Resolved radiance prefactor: albedo/(π d²)·Φ/I with I = (2/3)Φ_L(α) for Lambert.
    expect(Kfull).toBeCloseTo((albedo[1] * expectE[1]) / diskIlluminance(albedo, 5, 6000, 1e5, 1)[1] / (Math.PI * 25 * (2 / 3) * lambertPhase(a)), 6);
    // The tint shows the estimated label (orange), not the body's own 'measured'.
    expect(best.resolved[0].tint!.slice(0, 3)).toEqual(PROVENANCE_TINT.estimated);
  });
});

/** The resolved fraction baked into K (1 for a large disk). */
function smoothRes(p: ReturnType<typeof prepareFrame>): number {
  return p.resolved[0].frame.D > 0 ? 1 : 0;
}

describe('Sun', () => {
  const sun = (limb: number[][] | null) => ({ pos: [0, 0, -AU_KM] as [number, number, number], radius: 695700, irradianceXYZS_1AU: [1.2e5, 1.28e5, 1.1e5, 2.9e5] as XYZS, limbDarkening: limb });
  it('without limb darkening it is a point of the full illuminance, never a uniform disk', () => {
    const eye = computeEyeFrame(DEFAULT_EYE_SETTINGS, eyeState(), 'eye', 0, null);
    const s = snap([], 2, sun(null));
    const g = cameraGeom(s, W, H, 1e-7);
    const p = prepareFrame(s, g, eye, 1e-9);
    expect(p.sun!.resolvedFraction).toBe(0);
    expect(p.sun!.point!.E[1]).toBeCloseTo(1.28e5, 6);
    expect(p.warnings.join()).toMatch(/limb darkening unknown/);
  });
  it('with limb darkening and > 2 px it is a resolved disk with no point part', () => {
    const eye = computeEyeFrame(DEFAULT_EYE_SETTINGS, eyeState(), 'eye', 0, null);
    const s = snap([], 2, sun([[0.3, 0.93, -0.23], [0.3, 0.93, -0.23], [0.3, 0.93, -0.23], [0.3, 0.93, -0.23]]));
    const p = prepareFrame(s, cameraGeom(s, W, H, 1e-7), eye, 1e-9);
    expect(p.sun!.resolvedFraction).toBe(1);
    expect(p.sun!.point).toBeNull();
  });
  it('off-screen Sun: veils the frame and drives the pupil, but only within 100° of fixation', () => {
    const eye = computeEyeFrame(DEFAULT_EYE_SETTINGS, eyeState(), 'eye', 0, null);
    const at = (deg: number) => {
      const r = (deg * Math.PI) / 180;
      const s = { ...sun(null), pos: [AU_KM * Math.sin(r), 0, -AU_KM * Math.cos(r)] as [number, number, number] };
      const sn = snap([], 20, s);
      return prepareFrame(sn, cameraGeom(sn, W, H, 1e-7), eye, 1e-9);
    };
    const inside = at(5);
    expect(inside.glare.length).toBe(1);
    expect(inside.offFrameFluxDeg2).toBe(0); // in frame: its light is in the HDR image already
    const off = at(45);
    expect(off.glare.length).toBe(1);
    expect(off.glare[0].inFrame).toBe(false);
    expect(off.offFrameFluxDeg2).toBeCloseTo(1.28e5 * (180 / Math.PI) ** 2, -2);
    const behind = at(120);
    expect(behind.glare.length).toBe(0);
    expect(behind.offFrameFluxDeg2).toBe(0);
  });
  it('analytic glare sources: strongest first, and those whose veil cannot reach 1 % of the dark light anywhere are dropped', () => {
    const eye = computeEyeFrame(DEFAULT_EYE_SETTINGS, eyeState(), 'eye', 0, null);
    const r = (45 * Math.PI) / 180;
    const s = { ...sun(null), pos: [AU_KM * Math.sin(r), 0, -AU_KM * Math.cos(r)] as [number, number, number] };
    // 40 faint bodies off frame (V ≈ 12 and fainter) and one bright one, 30° off axis.
    const faint = Array.from({ length: 40 }, (_, k) => body(3e9, {
      id: 100 + k, pos: [3e9 * Math.sin(0.5), 0.01 * k * 3e9, -3e9 * Math.cos(0.5)], radii: [5, 5, 5],
    }));
    const bright = body(4e5, { id: 99, pos: [4e5 * Math.sin(0.5), 0, -4e5 * Math.cos(0.5)], radii: [1737, 1737, 1737] });
    const sn = snap([...faint, bright], 20, s);
    const p = prepareFrame(sn, cameraGeom(sn, W, H, 1e-7), eye, 1e-9);
    expect(p.glare.length).toBeLessThanOrEqual(3);
    expect(p.glare[0].E[1]).toBeGreaterThan(1e4); // the Sun first
    expect(p.glare.some((gs) => gs.E[1] > 1e-3 && gs.E[1] < 1e4)).toBe(true); // the bright body kept
    // The pupil still counts every source's light.
    expect(p.offFrameFluxDeg2).toBeGreaterThan(0);
  });
});
