// Rotational variation of the Galilean moons (photometry.json diskReflectanceModel, kind 'rotation-slices-v1';
// render/photometry.ts sliceFactor / diskModelPPhi): the orange-slice factor against PlanetSlicer (Thorngren 2019,
// the code Mayorga et al. 2020 used), its rotation average, and its use in p·Φ.
import { describe, expect, it } from 'vitest';
import { diskModelPPhi, sliceFactor, type XYZS } from '../src/render/photometry';
import type { RotationSlicesDiskModel } from '../src/data/schema';

// Mayorga et al. (2020) Table 4, Europa CL1GRN, divided by the mean (the product's relativeAlbedo).
const J = [0.313415, 0.341145, 0.287923, 0.222243, 0.245618, 0.273885];
const REL = J.map((v) => (v * J.length) / J.reduce((a, b) => a + b, 0));
const EDGES = [-180, -120, -60, 0, 60, 120, 180];
const rad = (d: number) => (d * Math.PI) / 180;

describe('sliceFactor', () => {
  it('reproduces PlanetSlicer toPhaseCurve(rel) / toPhaseCurve(1)', () => {
    // [sub-observer east lon, sub-solar east lon, F] from slicer.py (github.com/dpthorngren/PlanetSlicer).
    const ref: [number, number, number][] = [
      [67.2, 39.2, 0.836156], [-90, -90, 1.158935], [90, 90, 0.878412], [0, 30, 0.874536], [170, -160, 1.056665], [-100, 20, 1.039198],
    ];
    for (const [lo, ls, F] of ref) expect(sliceFactor(EDGES, REL, rad(lo), rad(ls))).toBeCloseTo(F, 5);
  });
  it('is 1 for a uniform body and averages to 1 over a rotation', () => {
    expect(sliceFactor(EDGES, [1, 1, 1, 1, 1, 1], rad(37), rad(80))).toBeCloseTo(1, 12);
    for (const phase of [0, 30, 100]) {
      let s = 0;
      const n = 720;
      for (let k = 0; k < n; k++) {
        const lo = -Math.PI + (2 * Math.PI * k) / n;
        s += sliceFactor(EDGES, REL, lo, lo + rad(phase));
      }
      // The ratio of averages is exactly 1; the average of ratios is close to it at low phase.
      expect(s / n).toBeCloseTo(1, phase < 50 ? 2 : 1);
    }
  });
  it('is 1 when nothing is both lit and visible', () => {
    expect(sliceFactor(EDGES, REL, 0, Math.PI)).toBe(1);
  });
});

describe('diskModelPPhi with a rotation-slices model', () => {
  const m: RotationSlicesDiskModel = {
    kind: 'rotation-slices-v1', formula: 'test', albedoXYZS: [1000, 1100, 900, 2000],
    phase: { kind: 'lambert' }, radiusKm: 1560.8, sliceEdgesEastLonDeg: EDGES, relativeAlbedo: REL,
  };
  // Body frame = ICRF; observer on +x (east longitude 0), Sun at 30° east in the equator.
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const toObs: [number, number, number] = [1e6, 0, 0];
  const toSun: [number, number, number] = [Math.cos(rad(30)) * 7.8e8, Math.sin(rad(30)) * 7.8e8, 0];
  it('is albedo · Φ(α) · F', () => {
    const pPhi = diskModelPPhi(m, I, 1560.8, toSun, toObs, null)!;
    const phiL = (Math.sin(rad(30)) + (Math.PI - rad(30)) * Math.cos(rad(30))) / Math.PI;
    const F = sliceFactor(EDGES, REL, 0, rad(30));
    expect(F).toBeCloseTo(0.874536, 5);
    pPhi.forEach((v, c) => expect(v).toBeCloseTo(m.albedoXYZS[c] * phiL * F, 6));
  });
  it('scales with the reference radius and needs the orientation', () => {
    const a = diskModelPPhi(m, I, 1560.8, toSun, toObs, null)!;
    const b = diskModelPPhi(m, I, 1560.8 / 2, toSun, toObs, null)!;
    (b as XYZS).forEach((v, c) => expect(v).toBeCloseTo(4 * a[c], 6));
    expect(diskModelPPhi(m, null, 1560.8, toSun, toObs, null)).toBeNull();
  });
});
