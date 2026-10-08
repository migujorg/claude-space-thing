import { describe, expect, it } from 'vitest';
import { centerStateFrom, readSynthetic, syntheticRelativeState, syntheticState } from '../src/core/smallbodySynthetic';
import type { SmallBodyForceModel, SyntheticObjectsHeader } from '../src/data/schema';
import { makeTable } from './sb-fixtures';
import { fixture, loadEphemerisSet } from './core-data';

const input = fixture<{ epochEt: number; objects: { row: number; centerId: number; centerGm: number; radiusKm: number; initial: number[]; elements: Record<string, number>; edges: { et: number; state: number[] }[] }[]; provenance: { objectsHeader: SyntheticObjectsHeader } }>('synthetic_moon_all_reference.json');
const fm = fixture<{ forceModel: SmallBodyForceModel }>('smallbody_reference.json').forceModel;
const window = { startEt: input.objects[0].edges[0].et, endEt: input.objects[0].edges[1].et };
const header = structuredClone(input.provenance.objectsHeader);
for (const p of header.populations.filter(p => p.center)) {
  const host = fm.perturbers.find(q => q.naifId === p.center!.naifId)!;
  p.model.integration = { kind: 'host-smallbody-v1', window, forceModel: { ...fm, sun: host,
    perturbers: [fm.sun, ...fm.perturbers.filter(q => q.naifId !== host.naifId)],
    relativity: { ...fm.relativity, enabled: false }, zonal: { ...fm.zonal, perturber: null } } };
}
const packed = makeTable<SyntheticObjectsHeader>([['a','f32'],['e','f32'],['i','f32'],['node','f32'],['peri','f32'],['M','f32'],['H','f32'],['cell','u32'],['pop','u8']], input.objects.map(o => o.elements), (({ count, stride, fields, ...rest }) => rest)(header));
// The helper header count describes the compact slice, not the original 3-million-row table.
packed.header.count = input.objects.length;
const syn = readSynthetic(packed.header, packed.buffer);
const eph = loadEphemerisSet(['ephem/de442s','ephem/centers']);

describe.skipIf(!eph)('production moon motion, all 458 pinned draws', () => {
  it('preserves every initial state and row identity at the product epoch', () => {
    expect(input.objects).toHaveLength(458);
    expect(new Set(input.objects.map(o=>o.row)).size).toBe(458);
    input.objects.forEach((o,j) => {
      const st = syntheticRelativeState(syn,j,input.epochEt)!;
      expect(Math.hypot(...st.pos.map((v,k)=>v-o.initial[k]))).toBeLessThan(1e-7);
      expect(Math.hypot(...st.vel.map((v,k)=>v-o.initial[k+3]))).toBeLessThan(1e-13);
      expect(syntheticState(syn,j,input.epochEt,centerStateFrom(eph!,10))).not.toBeNull();
    });
  });
  it('agrees with independent Sun + external-planet DOP853 at both window edges', () => {
    const center = centerStateFrom(eph!,10);
    let max = 0;
    input.objects.forEach((o,j) => {
      for (const edge of o.edges) {
        const st = syntheticState(syn,j,edge.et,center);
        expect(st, `row ${o.row}, ET ${edge.et}`).not.toBeNull();
        const host = center(o.centerId,edge.et)!;
        const error = Math.hypot(...st!.pos.map((v,k)=>v-host.pos[k]-edge.state[k]));
        max = Math.max(max,error);
      }
    });
    console.log({ objects: 458, comparisons: 916, maxCpuKm: max });
    // Existing translated CPU report max 0.042166 km; predeclared 0.1-km regression budget.
    expect(max).toBeLessThan(0.1);
  },120000);
});
