import { describe, expect, it } from 'vitest';
import { keplerDrift, SB_OK, SmallBodyPropagator } from '../src/core/smallbody';
import { fixture, loadEphemerisSet } from './core-data';

import { integrateMoonReference, solarDifferential, type MoonReferenceModel } from './synthetic-moon-reference';
import type { SmallBodyForceModel } from '../src/data/schema';

interface Reference {
  epochEt: number;
  window: { startEt: number; endEt: number };
  objects: { row: number; center: { naifId: number; gm: number }; initial: number[];
    states: { et: number; state: number[]; audit: { positionKm: number; earthArcsec: number; centralAngleDeg: number } }[] }[];
}
const ref = fixture<Reference>('synthetic_moon_reference.json');
const fm = fixture<{ forceModel: SmallBodyForceModel }>('smallbody_reference.json').forceModel;
const eph = loadEphemerisSet(['ephem/de442s', 'ephem/centers']);
describe.skipIf(!eph)('synthetic moon reference at both build-window edges', () => {
  for (const o of ref.objects) for (const target of o.states) {
    it(`row ${o.row} at ${target.et} agrees with independent Sun+host integration`, () => {
      const model: MoonReferenceModel = { centerId: o.center.naifId, centerGm: o.center.gm, sunId: 10, sunGm: fm.sun.gm, window: ref.window };
      const state = integrateMoonReference(o.initial, ref.epochEt, target.et, model, eph!, 10800);
      const fine = integrateMoonReference(o.initial, ref.epochEt, target.et, model, eph!, 5400);
      expect(Math.hypot(...[0, 1, 2].map(k => state[k] - fine[k]))).toBeLessThan(0.01);
      const error = Math.hypot(...[0, 1, 2].map(k => state[k] - target.state[k]));
      expect(error).toBeLessThan(0.01);
      const fixed = Float64Array.from(o.initial);
      expect(keplerDrift(fixed, 0, target.et - ref.epochEt, o.center.gm)).toBe(SB_OK);
      // Independently recomputed audit metrics, not just a generated-state comparison.
      expect(Math.abs(Math.hypot(...[0, 1, 2].map(k => fixed[k] - target.state[k])) - target.audit.positionKm)).toBeLessThan(0.01);
      const planet = eph!.positionSSB(o.center.naifId * 100 + 99, target.et)!, host = eph!.positionSSB(o.center.naifId, target.et)!;
      const earth = eph!.positionSSB(399, target.et)!;
      for (const [observer, expected, factor] of [[planet, target.audit.centralAngleDeg, 1], [earth, target.audit.earthArcsec, 3600]] as const) {
        const a = [0, 1, 2].map(k => fixed[k] + host[k] - observer[k]), b = [0, 1, 2].map(k => state[k] + host[k] - observer[k]);
        const cross = Math.hypot(a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]);
        const angle = Math.atan2(cross, a.reduce((v, x, k) => v+x*b[k],0))*180/Math.PI*factor;
        expect(Math.abs(angle-expected)).toBeLessThan(0.00001);
      }
    });
    it(`CPU twin in the translated host frame at row ${o.row}, ${target.et}`, () => {
      const model: SmallBodyForceModel = { ...fm, sun: { ...fm.sun, naifId: o.center.naifId, gm: o.center.gm }, perturbers: [{ ...fm.perturbers[0], naifId: 10, gm: fm.sun.gm, radius: fm.sun.radius }], relativity: { ...fm.relativity, enabled: false }, zonal: { ...fm.zonal, perturber: null } };
      const prop = new SmallBodyPropagator(model, eph!);
      const state = Float64Array.from(o.initial);
      const stats = { substeps: 0, maxLevel: 0, encounterSubsteps: 0 };
      expect(prop.propagateOne(state, 0, ref.epochEt, target.et, ref.epochEt, null, stats)).toBe(SB_OK);
      const error = Math.hypot(...[0,1,2].map(k=>state[k]-target.state[k]));
      console.log(JSON.stringify({row:o.row, et:target.et, translatedCpuKm:error, stats}));
      expect(error).toBeLessThan(1);
    });
  }
});

it('the differential Sun force vanishes at the host and has the Newtonian tidal limit', () => {
  const R = [1000,0,0], gm = 3; // dimensional mathematical example, no product
  expect(solarDifferential([0,0,0],R,gm)).toEqual([0,0,0]);
  expect(solarDifferential([0,1e-3,0],R,gm)[1]).toBeCloseTo(-gm*1e-3/1000**3,20);
  expect(solarDifferential([1e-3,0,0],R,gm)[0]/(2*gm*1e-3/1000**3)).toBeCloseTo(1,5);
});
it('rejects missing coverage instead of extrapolating', () => {
  const model = { centerId: 5, centerGm: 1, sunId: 10, sunGm: 2, window: { startEt: 0, endEt: 10 } };
  const missing = { positionSSB: () => null };
  expect(() => integrateMoonReference([1,0,0,0,1,0],0,11,model,missing,1)).toThrow('outside coverage');
  expect(() => integrateMoonReference([1,0,0,0,1,0],0,1,model,missing,1)).toThrow('missing ephemeris');
  expect(() => integrateMoonReference([1,0,0,0,1,0],0,1,model,missing,0)).toThrow('invalid input');
});
