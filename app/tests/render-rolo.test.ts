// The Moon's disk-integrated brightness from the ROLO model (Kieffer & Stone 2005 Eq. 10; product kind
// 'rolo-v1', architecture §4.3): formula, domain, geometry, consistency with the phase curve the pipeline
// derived from it, and its use by frame preparation.
import { describe, expect, it } from 'vitest';
import { diskModelPPhi, roloReflectance, selenographicGeometry, type XYZS } from '../src/render/photometry';
import { cameraGeom, prepareFrame } from '../src/render/frame';
import { AdaptationState, computeEyeFrame } from '../src/eye/model';
import { DEFAULT_EYE_SETTINGS } from '../src/eye/settings';
import { AU_KM } from '../src/render/constants';
import type { DiskReflectanceModel } from '../src/data/schema';
import type { Mat3, SceneBody, SceneSnapshot } from '../src/render/scene';

// ── TEST FIXTURE: values copied from this build's pipeline products (photometry.json "301", light.json).
// They are here to check the renderer's evaluation against the pipeline's own numbers; not a data source.
const ROLO: DiskReflectanceModel = {
  kind: 'rolo-v1', formula: 'see photometry.json',
  a: [[-2.07865, -1.63229, 0.350681, -0.194436], [-2.10254, -1.6346, 0.344678, -0.191184], [-2.32237, -1.6891, 0.38804, -0.206244], [-2.2181, -1.65579, 0.353142, -0.193018]],
  b: [[0.04143, 0.0106789, -0.00406704], [0.0403132, 0.0113554, -0.00415995], [0.0389651, 0.0134997, -0.00492368], [0.0390957, 0.0131991, -0.00467589]],
  d: [[0.370044, -0.111032, 0.0073166], [0.370312, -0.108609, 0.00794299], [0.3576, -0.0624907, 0.00323264], [0.363241, -0.0851684, 0.00705148]],
  c: [0.00034115, -0.0013425, 0.00095906, 0.00066229],
  p: [4.06054, 12.8802, -30.5858, 16.7498],
  radiusKm: 1737.39, minPhaseDeg: 1.55, maxPhaseDeg: 97, maxObserverLatitudeDeg: 7, maxObserverLongitudeDeg: 8,
};
const SUN_1AU: XYZS = [130406.85309695941, 134646.97719597662, 140481.21235231555, 319824.6563841383];
const MOON_ALBEDO: XYZS = [17998.90290991065, 17741.79321027472, 13671.449060889747, 35233.67313981386];
/** Moon phase curve nodes (deltaMag) from the same build, derived by the pipeline from ROLO. */
const MOON_PHASE_NODES: [number, number][] = [[2, 0.0022], [10, 0.4082], [30, 0.9577], [60, 1.7644], [90, 2.7461]];

describe('ROLO whole-disk reflectance', () => {
  it('evaluates Kieffer & Stone Eq. 10 term by term (radians in the polynomials, degrees elsewhere)', () => {
    const g = 45, P = 30, th = 3, ph = -4;
    const gr = (g * Math.PI) / 180, Pr = (P * Math.PI) / 180;
    const k = 1;
    const [a0, a1, a2, a3] = ROLO.a[k], [b1, b2, b3] = ROLO.b[k], [d1, d2, d3] = ROLO.d[k], [c1, c2, c3, c4] = ROLO.c, [p1, p2, p3, p4] = ROLO.p;
    const lnA = a0 + a1 * gr + a2 * gr ** 2 + a3 * gr ** 3 + b1 * Pr + b2 * Pr ** 3 + b3 * Pr ** 5
      + c1 * th + c2 * ph + c3 * Pr * th + c4 * Pr * ph + d1 * Math.exp(-g / p1) + d2 * Math.exp(-g / p2) + d3 * Math.cos((g - p3) / p4);
    expect(roloReflectance(ROLO, g, P, th, ph)![1]).toBeCloseTo(Math.exp(lnA), 14);
  });
  it('the waxing Moon (Sun east, Φ > 0) is ~10 % brighter than the waning Moon at 60°', () => {
    const r = roloReflectance(ROLO, 60, 60, 0, 0)![1] / roloReflectance(ROLO, 60, -60, 0, 0)![1];
    expect(r).toBeGreaterThan(1.07);
    expect(r).toBeLessThan(1.13);
  });
  it('reproduces the pipeline\'s phase curve: geometric mean of waxing and waning / p_Y (within 0.2 %)', () => {
    const pY = MOON_ALBEDO[1] / SUN_1AU[1];
    for (const [g, dm] of MOON_PHASE_NODES) {
      const A = Math.sqrt(roloReflectance(ROLO, g, g, 0, 0)![1] * roloReflectance(ROLO, g, -g, 0, 0)![1]);
      expect(Math.abs(A / pY / 10 ** (-0.4 * dm) - 1)).toBeLessThan(0.002);
    }
  });
  it('outside its domain it does not apply (phase range, observer libration range)', () => {
    expect(roloReflectance(ROLO, 1.5, 1.5, 0, 0)).toBeNull();
    expect(roloReflectance(ROLO, 97.5, 97, 0, 0)).toBeNull();
    expect(roloReflectance(ROLO, 30, 30, 7.5, 0)).toBeNull();
    expect(roloReflectance(ROLO, 30, 30, 0, -8.5)).toBeNull();
    expect(roloReflectance(ROLO, 30, 30, 6.9, 7.9)).not.toBeNull();
  });
});

describe('selenographic geometry', () => {
  const bf = (lat: number, lon: number): [number, number, number] => {
    const la = (lat * Math.PI) / 180, lo = (lon * Math.PI) / 180;
    return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
  };
  it('recovers the Sun\'s longitude and the sub-observer point in the body frame, for any orientation', () => {
    // Body frame rotated 90° about z relative to ICRF: body x = ICRF y.
    const R: Mat3 = [0, -1, 0, 1, 0, 0, 0, 0, 1]; // body-fixed → ICRF (row-major)
    const toWorld = (v: [number, number, number]): [number, number, number] => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];
    const g = selenographicGeometry(R, toWorld(bf(1, 60)), toWorld(bf(-3, 5)));
    expect(g.sunLonDeg).toBeCloseTo(60, 9);
    expect(g.obsLatDeg).toBeCloseTo(-3, 9);
    expect(g.obsLonDeg).toBeCloseTo(5, 9);
  });
});

describe('the Moon in a frame', () => {
  const W = 1280, H = 720;
  const eyeState = () => { const s = new AdaptationState(); s.update({ coneCdM2: 1e-2, rodCdM2: 1e-2, cornealFlux: 0 }, 0); return s; };
  const I: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const moon = (obsLat: number, sunLon: number): SceneBody => {
    const la = (obsLat * Math.PI) / 180, lo = (sunLon * Math.PI) / 180;
    const dist = 384400;
    return {
      id: 301, name: 'Moon', pos: [-dist * Math.cos(la), 0, -dist * Math.sin(la)], toSun: [AU_KM * Math.cos(lo), AU_KM * Math.sin(lo), 0], orient: I,
      radii: [1737.4, 1737.4, 1737.4], albedoXYZS: MOON_ALBEDO, phase: { kind: 'lambert' }, surfaceUnknown: false, worstLabel: 'derived', selected: false,
      diskReflectanceModel: ROLO,
    };
  };
  const snap = (b: SceneBody): SceneSnapshot => ({
    et: 0, camera: { orient: [0, 0, 1, 1, 0, 0, 0, 1, 0], fovY: 1e-4, width: W, height: H }, // looking along +x … far away from the disk: point only
    sun: { pos: [AU_KM, 0, 0], radius: 695700, irradianceXYZS_1AU: SUN_1AU, limbDarkening: null }, bodies: [b],
    view: { mode: 'eye', exposureBoostStops: 0, overlays: { provenanceTint: false } }, orbits: [],
  });
  it('inside its domain the disk brightness is ROLO\'s, not albedo × the (here Lambert) phase function', () => {
    const b = moon(0, 60);
    const eye = computeEyeFrame(DEFAULT_EYE_SETTINGS, eyeState(), 'eye', 0, null);
    const s = snap(b);
    // A camera pointed at the Moon with a tiny field so the disk is resolved; compare the prefactor K.
    s.camera.orient = [0, 0, 1, 1, 0, 0, 0, 1, 0];
    s.camera.fovY = (1 * Math.PI) / 180;
    const g = cameraGeom(s, W, H, 1e-7);
    const p = prepareFrame(s, g, eye, 1e-9);
    const pPhi = diskModelPPhi(ROLO, I, 1737.4, b.toSun, [-b.pos[0], -b.pos[1], -b.pos[2]], SUN_1AU)!;
    expect(p.resolved.length).toBe(1);
    // K = p·Φ / (π d² I(α)) with the Lambert disk integral I(α) = (2/3)Φ_L(α).
    const alpha = Math.PI / 3;
    const IL = (2 / 3) * ((Math.sin(alpha) + (Math.PI - alpha) * Math.cos(alpha)) / Math.PI);
    const dAU = Math.hypot(...b.toSun) / AU_KM;
    expect(p.resolved[0].K[1] / (pPhi[1] / (Math.PI * dAU * dAU * IL))).toBeCloseTo(1, 6);
  });
  it('outside the libration range it falls back to the phase function', () => {
    const b = moon(10, 60);
    const eye = computeEyeFrame(DEFAULT_EYE_SETTINGS, eyeState(), 'eye', 0, null);
    const s = snap(b);
    const la = (10 * Math.PI) / 180;
    // Camera looking at the Moon (columns right = y, up = (−sin, 0, cos), back = toObserver).
    s.camera.fovY = (1 * Math.PI) / 180;
    s.camera.orient = [0, -Math.sin(la), Math.cos(la), 1, 0, 0, 0, Math.cos(la), Math.sin(la)];
    const g = cameraGeom(s, W, H, 1e-7);
    const p = prepareFrame(s, g, eye, 1e-9);
    expect(diskModelPPhi(ROLO, I, 1737.4, b.toSun, [-b.pos[0], -b.pos[1], -b.pos[2]], SUN_1AU)).toBeNull();
    const alpha = Math.acos(Math.cos(la) * 0.5);
    const IL = (2 / 3) * ((Math.sin(alpha) + (Math.PI - alpha) * Math.cos(alpha)) / Math.PI);
    const PhiL = IL * 1.5;
    const dAU = Math.hypot(...b.toSun) / AU_KM;
    expect(p.resolved[0].K[1] / ((MOON_ALBEDO[1] * PhiL) / (Math.PI * dAU * dAU * IL))).toBeCloseTo(1, 6);
  });
});
