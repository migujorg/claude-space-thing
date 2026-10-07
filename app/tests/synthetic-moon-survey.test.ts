// Opt-in numerical survey; reads ONLY a lane diagnostic, never writes a data product.
// Reproduce with SYNTHETIC_MOON_SURVEY_DIR=<lane> vitest run tests/synthetic-moon-survey.test.ts.
import { describe, expect, it } from 'vitest';
import { SmallBodyPropagator, SB_OK } from '../src/core/smallbody';
import type { SmallBodyForceModel } from '../src/data/schema';
import { fixture, loadEphemerisSet } from './core-data';
const env = (globalThis as { process?: { env?: Record<string, string> } }).process?.env ?? {};
const dir = env.SYNTHETIC_MOON_SURVEY_DIR;
const fs: { readFileSync(p: string, enc: 'utf8'): string } = await import(/* @vite-ignore */ 'node:fs' as string);
const eph = dir ? loadEphemerisSet(['ephem/de442s', 'ephem/centers']) : null;
const base = fixture<{ forceModel: SmallBodyForceModel }>('smallbody_reference.json').forceModel;
interface Survey {
  epochEt: number;
  externalPlanets?: boolean;
  objects: { row: number; centerId: number; centerGm: number; radiusKm: number; initial: number[];
    edges: { et: number; state: number[] }[] }[];
}
describe.skipIf(!dir || !eph)('all-moon translated CPU candidate (opt-in lane diagnostic)', () => {
  for (const [name, file] of [['Sun', 'survey-input.json'], ['Sun and external planets', 'survey-planets-input.json']]) it(`bounds ${name} edge states of every one of the 458 draws against DOP853`, () => {
    const input: Survey = JSON.parse(fs.readFileSync(dir + '/' + file, 'utf8'));
    const errors: number[] = [], displaySubsteps: number[] = [];
    const byHost = new Map<number, SmallBodyPropagator>();
    for (const o of input.objects) {
      let prop = byHost.get(o.centerId);
      if (!prop) {
        const model: SmallBodyForceModel = { ...base,
          sun: { ...base.sun, naifId: o.centerId, gm: o.centerGm, radius: o.radiusKm },
          perturbers: [{ ...base.perturbers[0], naifId: 10, gm: base.sun.gm, radius: base.sun.radius }, ...(input.externalPlanets ? base.perturbers.filter(p => p.naifId !== o.centerId) : [])],
          relativity: { ...base.relativity, enabled: false }, zonal: { ...base.zonal, perturber: null } };
        prop = new SmallBodyPropagator(model, eph!); byHost.set(o.centerId, prop);
      }
      let worst = 0;
      for (const edge of o.edges) {
        const state = Float64Array.from(o.initial);
        expect(prop.propagateOne(state, 0, input.epochEt, edge.et, input.epochEt), `row ${o.row}`).toBe(SB_OK);
        worst = Math.max(worst, Math.hypot(...[0,1,2].map(k=>state[k]-edge.state[k])));
      }
      errors.push(worst);
      const stats = { substeps: 0, maxLevel: 0, encounterSubsteps: 0 }, state = Float64Array.from(o.initial);
      expect(prop.propagateOne(state,0,input.epochEt,input.epochEt+base.grid.baseStepS,input.epochEt,null,stats)).toBe(SB_OK);
      displaySubsteps.push(stats.substeps);
    }
    expect(input.objects.length).toBe(458);
    expect(new Set(input.objects.map(o=>o.row)).size).toBe(458);
    // Numerical regression tolerance only. This is not a force-model, GPU or observer-position bound.
    expect(Math.max(...errors)).toBeLessThan(0.1);
    const quantile = (xs: number[], p: number) => {
      const a = [...xs].sort((a,b)=>a-b), ix = (a.length-1)*p, lo = Math.floor(ix);
      return a[lo]+(a[Math.ceil(ix)]-a[lo])*(ix-lo);
    };
    console.log(JSON.stringify({ forces: name, objects: errors.length, edgeComparisons: errors.length*2,
      km: { median: quantile(errors,.5), p90: quantile(errors,.9), max: Math.max(...errors) },
      fullTwoDayStep: { median: quantile(displaySubsteps,.5), p90: quantile(displaySubsteps,.9), max: Math.max(...displaySubsteps), total: displaySubsteps.reduce((a,b)=>a+b,0) } }));
  }, 120000);
});
