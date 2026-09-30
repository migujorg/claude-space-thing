// Frame preparation: resolved ↔ point transition conserves the disk-integrated illuminance, missing
// data is never filled in, and the Sun without limb darkening is a point of the correct illuminance.
import { describe, expect, it } from 'vitest';
import { cameraGeom, prepareFrame } from '../src/render/frame';
import { AdaptationState, computeEyeFrame } from '../src/eye/model';
import { DEFAULT_EYE_SETTINGS } from '../src/eye/settings';
import { diskIlluminance, lambertPhase, lambertRadianceFactor, type XYZS } from '../src/render/photometry';
import { AU_KM } from '../src/render/constants';
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
    expect(noR.overlay.length).toBeGreaterThan(0); // hollow marker
  });
  it('a measured phase curve outside its validity range is not extrapolated', () => {
    const eye = computeEyeFrame(DEFAULT_EYE_SETTINGS, eyeState(), 'eye', 0, null);
    const g = cameraGeom(snap([]), W, H, 1e-7);
    const b = body(1e5, { phase: { kind: 'poly-mag', coeffs: [0, 0.01], minDeg: 20, maxDeg: 120 } }); // α = 0 here
    const p = prepareFrame(snap([b], 60), g, eye, 1e-9);
    expect(p.resolved[0].lit).toBe(false);
    expect(p.warnings.join()).toMatch(/outside/);
  });
});

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
});
