import { describe, expect, it } from 'vitest';
import { MOON_CAMERAS, MOON_EPHEMERIDES, moonCameraState, directionAngle, metricSummary, moonAngularBudget } from '../src/gpu/smallbodies/moonDiagnostics';
import { fixture, loadEphemerisSet } from './core-data';
import type { SmallBodyForceModel } from '../src/data/schema';

const input = fixture<{ epochEt:number; objects:{centerId:number;initial:number[];edges:{et:number}[]}[] }>('synthetic_moon_all_reference.json');
const fm = fixture<{forceModel:SmallBodyForceModel}>('smallbody_reference.json').forceModel;
const eph = loadEphemerisSet(MOON_EPHEMERIDES.map(n=>`ephem/${n}`));

describe.skipIf(!eph)('moon device harness cameras', () => {
  for (const host of [5,6]) for (const camera of MOON_CAMERAS) it(`camera=${camera}&syncam=${host}, epoch and both edges`, () => {
    const o = input.objects.find(o=>o.centerId===host)!;
    for (const et of [input.epochEt,...o.edges.map(e=>e.et)]) {
      const p = eph!.positionSSB(host,et)!;
      const target = p.map((v,k)=>v+o.initial[k]) as [number,number,number];
      const cam = moonCameraState(eph!,et,host,fm.perturbers.find(p=>p.naifId===host)!.radius,camera,target);
      expect(cam).toHaveLength(3);
      expect(cam.every(Number.isFinite)).toBe(true);
      if(camera==='planet') expect(cam).toEqual(eph!.positionSSB(host*100+99,et));
    }
  });
});

it('reports missing camera coverage and unknown targets explicitly', () => {
  expect(()=>moonCameraState({positionSSB:()=>null},0,5,1,'planet')).toThrow('missing NAIF 599');
  expect(()=>moonCameraState({positionSSB:()=>null},0,6,1,'near')).toThrow('missing NAIF 699');
  expect(()=>moonCameraState({positionSSB:()=>null},0,5,1,'close')).toThrow('unknown target');
});

it('retains sub-arcsecond angles, percentiles and worst identity', () => {
  expect(directionAngle([1,0,0],[1,1e-10,0])).toBeCloseTo(1e-10,15);
  expect(directionAngle([1,0,0],[-1,0,0])).toBe(Math.PI);
  expect(metricSummary(Array.from({length:10},(_,k)=>({value:k,id:`moon:${k}`,et:2*k})))).toEqual({max:9,p90:8,worstMoonId:'moon:9',worstEt:18,samples:10});
  expect(moonAngularBudget(50*Math.PI/180,720)).toBeLessThan(0.1*2*Math.tan(25*Math.PI/180)/720);
});
