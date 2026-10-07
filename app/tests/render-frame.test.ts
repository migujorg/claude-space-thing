// Frame preparation: resolved ↔ point transition conserves the disk-integrated illuminance, missing
// data is never filled in, and the Sun without limb darkening is a point of the correct illuminance.
import { describe, expect, it } from 'vitest';
import { cameraGeom, prepareFrame, SIGMA_MIN_PX, splatSigmaPx } from '../src/render/frame';
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
  it('warnings name only bodies in view', () => {
    const eye = computeEyeFrame(DEFAULT_EYE_SETTINGS, eyeState(), 'eye', 0, null);
    const g = cameraGeom(snap([]), W, H, 1e-7);
    const pf = { kind: 'poly-mag' as const, coeffs: [0, 0.01], minDeg: 20, maxDeg: 120 }; // α = 0: outside
    const front = body(1e5, { id: 5, name: 'Front', phase: pf });
    const back = body(1e5, { id: 6, name: 'Back', phase: pf, pos: [0, 0, 1e5] });
    const p = prepareFrame(snap([front, back], 60), g, eye, 1e-9);
    expect(p.warnings.join()).toMatch(/Front/);
    expect(p.warnings.join()).not.toMatch(/Back/);
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

describe('Sun shield (viewing aid)', () => {
  const limb = [[0.3, 0.93, -0.23], [0.3, 0.93, -0.23], [0.3, 0.93, -0.23], [0.3, 0.93, -0.23]];
  const sunAt = (deg: number, limbDarkening: number[][] | null = limb) => {
    const r = (deg * Math.PI) / 180;
    return { pos: [AU_KM * Math.sin(r), 0, -AU_KM * Math.cos(r)] as [number, number, number], radius: 695700, irradianceXYZS_1AU: [1.2e5, 1.28e5, 1.1e5, 2.9e5] as XYZS, limbDarkening };
  };
  const shielded = (s: SceneSnapshot): SceneSnapshot => ({ ...s, view: { ...s.view, sunShield: true } });
  it('off by default; on, the Sun casts no veil, has no disk or point, and adds no light to the pupil', () => {
    const eye = computeEyeFrame(DEFAULT_EYE_SETTINGS, eyeState(), 'eye', 0, null);
    for (const [deg, fov] of [[0, 2], [45, 20]] as const) {
      const sn = snap([], fov, sunAt(deg));
      const g = cameraGeom(sn, W, H, 1e-7);
      const off = prepareFrame(sn, g, eye, 1e-9);
      expect(off.sunShield).toBeNull();
      expect(off.glare.length).toBe(1);
      const on = prepareFrame(shielded(sn), g, eye, 1e-9);
      expect(on.glare.length).toBe(0);
      expect(on.offFrameFluxDeg2).toBe(0);
      expect(on.sun!.resolvedFraction).toBe(0);
      expect(on.sun!.point).toBeNull();
      // The occulting disc: the Sun's direction, its angular radius plus one pixel.
      expect(on.sunShield!.dir[0]).toBeCloseTo(Math.sin((deg * Math.PI) / 180), 12);
      expect(Math.acos(on.sunShield!.cosRadius)).toBeCloseTo(Math.asin(695700 / AU_KM) + g.pixelAngle, 9);
    }
    // Unresolved Sun (no limb darkening): no point either, and no "limb darkening unknown" warning.
    const sn = snap([], 20, sunAt(0, null));
    const p = prepareFrame(shielded(sn), cameraGeom(sn, W, H, 1e-7), eye, 1e-9);
    expect(p.sun!.point).toBeNull();
    expect(p.warnings.join()).not.toMatch(/limb darkening unknown/);
  });
  it('marks the disc with a display outline when it is in front of the camera', () => {
    const eye = computeEyeFrame(DEFAULT_EYE_SETTINGS, eyeState(), 'eye', 0, null);
    const sn = snap([], 20, sunAt(0));
    const p = prepareFrame(shielded(sn), cameraGeom(sn, W, H, 1e-7), eye, 1e-9);
    expect(p.overlay.length).toBeGreaterThan(0);
    const back = snap([], 20, sunAt(180));
    expect(prepareFrame(shielded(back), cameraGeom(back, W, H, 1e-7), eye, 1e-9).overlay.length).toBe(0);
  });
  it('everything else stays physical: bodies keep their sunlight; only what lies behind the disc is hidden', () => {
    const eye = computeEyeFrame(DEFAULT_EYE_SETTINGS, eyeState(), 'eye', 0, null);
    // A planet 20° from the Sun (in frame, 60° field) and one exactly behind the Sun's disk, both beyond the Sun.
    const r20 = (20 * Math.PI) / 180;
    const sun = sunAt(0);
    const at = (id: number, pos: [number, number, number]) =>
      body(3e8, { id, pos, radii: [3000, 3000, 3000], toSun: [sun.pos[0] - pos[0], sun.pos[1] - pos[1], sun.pos[2] - pos[2]] });
    const planet = at(2, [3e8 * Math.sin(-r20), 0, -3e8 * Math.cos(r20)]);
    const hidden = at(3, [0, 0, -3e8]);
    const sn = snap([planet, hidden], 60, sun);
    const g = cameraGeom(sn, W, H, 1e-7);
    const off = prepareFrame(sn, g, eye, 1e-9);
    const on = prepareFrame(shielded(sn), g, eye, 1e-9);
    const E = (p: ReturnType<typeof prepareFrame>, x: number) => p.points.find((q) => Math.abs(q.ndc[0] - x) < 1e-6)?.E[1] ?? 0;
    const xPlanet = off.points.reduce((m, q) => Math.min(m, q.ndc[0]), Infinity);
    expect(E(on, xPlanet)).toBe(E(off, xPlanet));
    expect(E(on, xPlanet)).toBeGreaterThan(0);
    expect(off.points.some((q) => Math.abs(q.ndc[0]) < 1e-9)).toBe(true);
    expect(on.points.some((q) => Math.abs(q.ndc[0]) < 1e-9)).toBe(false);
  });
});

describe('point or disk: decided by the eye\'s point spread as drawn (docs/eye-model.md §6.3)', () => {
  const eye = () => computeEyeFrame(DEFAULT_EYE_SETTINGS, eyeState(), 'eye', 0, null);
  /** The splat the renderer draws (renderer.ts): σ in px and its footprint in sr. */
  const splat = (e: ReturnType<typeof eye>, pixelAngle: number, opticalCore = true) => {
    const sigmaPx = splatSigmaPx(e.coreSigmaDeg, pixelAngle, opticalCore);
    return { sigmaPx, footprintSr: 2 * Math.PI * sigmaPx * sigmaPx * pixelAngle * pixelAngle };
  };
  /** Distance at which a sphere of radius R (km) has the angular diameter `diam` (rad). */
  const distFor = (R: number, diam: number) => R / Math.sin(diam / 2);
  /** Resolved share of the test body seen under the angular diameter `diam` (rad): K over the full K. */
  const resolvedShare = (e: ReturnType<typeof eye>, fovDeg: number, diam: number, opticalCore = true) => {
    const g = cameraGeom(snap([], fovDeg), W, H, 1e-7);
    const p = prepareFrame(snap([body(distFor(6000, diam))], fovDeg), g, e, splat(e, g.pixelAngle, opticalCore).footprintSr);
    const Kfull = lambertRadianceFactor(albedo, 5, 1);
    return { share: p.resolved.length ? p.resolved[0].K[1] / Kfull[1] : 0, p, g };
  };

  it('where the splat is the reconstruction minimum, the switch is 1 to 2 pixels', () => {
    const e = eye();
    for (const fovDeg of [20, 50, 90]) {
      const g = cameraGeom(snap([], fovDeg), W, H, 1e-7);
      expect(splat(e, g.pixelAngle).sigmaPx).toBe(SIGMA_MIN_PX);
      const smooth = (x: number) => { const t = Math.min(1, Math.max(0, x - 1)); return t * t * (3 - 2 * t); };
      for (const diamPx of [0.5, 1, 1.2, 1.5, 1.8, 2, 3]) {
        const { share } = resolvedShare(e, fovDeg, diamPx * g.pixelAngle);
        expect(share).toBeCloseTo(smooth(diamPx), 9);
      }
    }
  });

  it('where the screen resolves the eye\'s optical core, the switch is at the same angular size at every field', () => {
    const e = eye();
    const sigma = (e.coreSigmaDeg * Math.PI) / 180;   // rad
    // 1.67 to 3.33 σ: the 1 to 2 px of a splat of σ = 0.6 px, in the splat's own units.
    const lo = sigma / SIGMA_MIN_PX, hi = (2 * sigma) / SIGMA_MIN_PX;
    const shares: number[][] = [];
    for (const fovDeg of [1, 3, 6]) {
      const g = cameraGeom(snap([], fovDeg), W, H, 1e-7);
      expect(splat(e, g.pixelAngle).sigmaPx).toBeGreaterThan(SIGMA_MIN_PX);
      const at = (diam: number) => resolvedShare(e, fovDeg, diam);
      // Under the eye's point spread: a point, however many pixels the disk covers.
      const small = at(0.99 * lo);
      expect((0.99 * lo) / g.pixelAngle).toBeGreaterThan(2);
      expect(small.p.resolved.length).toBe(0);
      expect(small.p.points.length).toBe(1);
      // Above it: a disk with no point part.
      const large = at(1.01 * hi);
      expect(large.share).toBeCloseTo(1, 12);
      expect(large.p.points.length).toBe(0);
      shares.push([1.2, 1.5, 1.8].map((k) => at(k * lo).share));
    }
    for (const row of shares) row.forEach((v, k) => expect(v).toBeCloseTo(shares[0][k], 9));
    expect(shares[0][1]).toBeCloseTo(0.5, 9);
  });

  it('an observer without the eye\'s optical core (the validation\'s imager): 1 to 2 pixels at every field', () => {
    const e = eye();
    expect(DEFAULT_EYE_SETTINGS.opticalCore).toBe(true);
    const smooth = (x: number) => { const t = Math.min(1, Math.max(0, x - 1)); return t * t * (3 - 2 * t); };
    // The EPOXI case's view is 3.5′ wide on 256 px; 1° on 720 lines is the app's narrowest field.
    for (const fovDeg of [0.0587, 1, 3, 50]) {
      const g = cameraGeom(snap([], fovDeg), W, H, 1e-7);
      expect(splat(e, g.pixelAngle, false).sigmaPx).toBe(SIGMA_MIN_PX);
      for (const diamPx of [0.5, 1, 1.5, 2, 20]) {
        expect(resolvedShare(e, fovDeg, diamPx * g.pixelAngle, false).share).toBeCloseTo(smooth(diamPx), 9);
      }
    }
    // A disk 10 px across at a 1° field (0.83′) is a point to an eye: it is under the eye's point spread.
    const g = cameraGeom(snap([], 1), W, H, 1e-7);
    expect(10 * g.pixelAngle).toBeLessThan(((e.coreSigmaDeg * Math.PI) / 180) / SIGMA_MIN_PX);
    expect(resolvedShare(e, 1, 10 * g.pixelAngle, true).share).toBe(0);
    expect(resolvedShare(e, 1, 10 * g.pixelAngle, false).share).toBeCloseTo(1, 12);
  });

  it('the point of a body in the switch is drawn nearer than every point of its own disk, and no nearer than that needs', () => {
    const e = eye();
    for (const fovDeg of [1, 50]) {
      const g = cameraGeom(snap([], fovDeg), W, H, 1e-7);
      const s = splat(e, g.pixelAngle);
      const dist = distFor(6000, 1.5 * (s.sigmaPx / SIGMA_MIN_PX) * g.pixelAngle);
      const p = prepareFrame(snap([body(dist, { radii: [6000, 6000, 5000] })], fovDeg), g, e, s.footprintSr);
      expect(p.resolved.length).toBe(1);
      expect(p.points.length).toBe(1);
      // Reversed depth: near / (distance along the view axis); larger is nearer. The disk's nearest point is at dist − 6000.
      const nearestSurface = g.near / (dist - 6000);
      expect(p.points[0].depth).toBeGreaterThan(nearestSurface);
      expect(p.points[0].depth / nearestSurface - 1).toBeLessThan(1e-5);
    }
  });

  it('the Sun switches by the same rule', () => {
    const e = eye();
    const limb = [[0.3, 0.93, -0.23], [0.3, 0.93, -0.23], [0.3, 0.93, -0.23], [0.3, 0.93, -0.23]];
    for (const fovDeg of [1, 50]) {
      const g = cameraGeom(snap([], fovDeg), W, H, 1e-7);
      const s = splat(e, g.pixelAngle);
      for (const k of [0.8, 1.5, 2.5]) {
        const dist = distFor(695700, k * (s.sigmaPx / SIGMA_MIN_PX) * g.pixelAngle);
        const sn = snap([], fovDeg, { pos: [0, 0, -dist], radius: 695700, irradianceXYZS_1AU: [1.2e5, 1.28e5, 1.1e5, 2.9e5] as XYZS, limbDarkening: limb });
        const sun = prepareFrame(sn, g, e, s.footprintSr).sun!;
        const b = resolvedShare(e, fovDeg, k * (s.sigmaPx / SIGMA_MIN_PX) * g.pixelAngle);
        expect(sun.resolvedFraction).toBeCloseTo(b.share, 9);
        expect(sun.point === null).toBe(k >= 2);
      }
    }
  });
});
