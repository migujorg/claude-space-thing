import { describe, expect, it } from 'vitest';
import { centerStateFrom, readSynthetic, syntheticRelativeState, syntheticState, syntheticMoonState } from '../src/core/smallbodySynthetic';
import type { SmallBodyForceModel, SyntheticObjectsHeader } from '../src/data/schema';
import { SmallBodies } from '../src/app/smallbodies';
import { SmallBodyField } from '../src/gpu/smallbodies/field';
import { hostForceModel } from '../src/core/smallbody';
import { PlanetTable } from '../src/gpu/smallbodies/planetTable';
import { fakeTables, makeTable } from './sb-fixtures';
import { fixture, loadEphemerisSet } from './core-data';

const input = fixture<{ epochEt: number; objects: { row: number; centerId: number; centerGm: number; radiusKm: number; initial: number[]; elements: Record<string, number>; edges: { et: number; state: number[] }[] }[]; provenance: { objectsHeader: SyntheticObjectsHeader } }>('synthetic_moon_all_reference.json');
const fm = fixture<{ forceModel: SmallBodyForceModel }>('smallbody_reference.json').forceModel;
const window = { startEt: input.objects[0].edges[0].et, endEt: input.objects[0].edges[1].et };
const header = structuredClone(input.provenance.objectsHeader);
for (const p of header.populations.filter(p => p.center)) {
  const host = fm.perturbers.find(q => q.naifId === p.center!.naifId)!;
  p.model.integration = { kind: 'host-smallbody-v1', window, forceModel: hostForceModel(fm,host.naifId,host.gm) };
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
  it('selection fallback and field stateOf use the same translated CPU path, including jumps', () => {
    const center = centerStateFrom(eph!,10);
    const tables = fakeTables();
    tables.core.header.window = window;
    const sb = new SmallBodies({...tables,synthetic:{objects:packed,cells:null}},eph!);
    const fieldContext = { synthetic:syn,count:tables.count,syntheticCount:syn.count,centerState:center } as unknown as SmallBodyField;
    for (const j of [0,434,435,457]) for (const et of [window.endEt,input.epochEt+12345,window.startEt,input.epochEt]) {
      const selected = sb.helio(sb.count+j,et);
      const fromField = SmallBodyField.prototype.stateOf.call(fieldContext,tables.count+j,et);
      expect(selected?.pos).toEqual(fromField?.pos);
      expect(selected?.vel).toEqual(fromField?.vel);
      expect(selected).not.toBeNull();
    }
  });
  it('missing metadata, missing perturbers and out-of-window motion are unknown', () => {
    const center = centerStateFrom(eph!,10);
    expect(syntheticState(syn,0,window.endEt+1,center)).toBeNull();
    expect(syntheticMoonState(syn,0,input.epochEt+1,{positionSSB:()=>null})).toBeNull();
    expect(syntheticState(syn,0,input.epochEt+1,()=>({pos:[0,0,0],vel:[0,0,0]}))).toBeNull();
    const old = structuredClone(packed.header);
    old.populations.forEach(p=>{delete p.model.integration;});
    expect(syntheticState(readSynthetic(old,packed.buffer),0,input.epochEt+1,center)).toBeNull();
    for (const p of header.populations.filter(p=>p.center)) {
      const translated = hostForceModel(fm,p.center!.naifId,p.center!.gm);
      expect(translated.perturbers.map(p=>p.naifId)).toEqual([10,...fm.perturbers.filter(q=>q.naifId!==p.center!.naifId).map(q=>q.naifId)]);
      expect(translated.relativity.enabled).toBe(false);
      expect(translated.zonal.perturber).toBeNull();
    }
  });
  it.skipIf(!((globalThis as {process?:{env?:Record<string,string>}}).process?.env?.MOON_CPU_BENCH))('measures in-process CPU initial conversion and two-host table costs', async () => {
    const process: { cpuUsage(p?:{user:number;system:number}):{user:number;system:number} } = await import(/* @vite-ignore */ 'node:process' as string);
    const measure = (f:()=>void) => { const t=process.cpuUsage(); f();const d=process.cpuUsage(t);return (d.user+d.system)/1000; };
    const iterations=100, H=fm.grid.baseStepS;
    const initCpuMs=measure(()=>{for(let n=0;n<iterations;n++) for(let j=0;j<syn.count;j++) syntheticRelativeState(syn,j,syn.epochEt);})/iterations;
    const hosts=[5,6].map(id=>fm.perturbers.find(p=>p.naifId===id)!);
    const tableCpuMs=measure(()=>{for(let n=0;n<iterations;n++) for(const host of hosts) {
      const t=new PlanetTable(hostForceModel(fm,host.naifId,host.gm),eph!,syn.epochEt,{startEt:syn.epochEt,endEt:syn.epochEt+H});
      expect(t.fill(0)).toBe(true);
    }})/iterations;
    console.log(JSON.stringify({iterations,initial458CpuMs:initCpuMs,twoNewIntervalsCpuMs:tableCpuMs,reusedIntervalsCpuMs:0,gpuTime:'unmeasured',apiEncodingCpuTime:'unmeasured'}));
  });

});
