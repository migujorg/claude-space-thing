import { describe, expect, it } from 'vitest';
import { MOON_CAMERAS, MOON_EPHEMERIDES, moonCameraState, directionAngle, metricSummary, moonAngularBudget } from '../src/gpu/smallbodies/moonDiagnostics';
import { fixture, loadEphemerisSet } from './core-data';
import type { SmallBodyForceModel } from '../src/data/schema';
import { shadeShader, stepShader, unitTestShader } from '../src/gpu/smallbodies/kernels';
import { AU_KM, C_KM_S } from '../src/core/constants';
import { solarDifferential } from './synthetic-moon-reference';

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

// Float32 transcription of the diagnostic algebra (not a device certificate). Reference uses
// independent direct-minus-indirect float64 arithmetic. These tests check cancellation and sign.
function tidal(x:number[], R:number[], gm:number, f:(n:number)=>number) {
  x=x.map(f);R=R.map(f);gm=f(gm);
  const dot=(a:number[],b:number[])=>a.reduce((s,v,k)=>f(s+f(v*b[k])),0);
  const R2=dot(R,R),q=f(f(dot(x,x)-f(2*dot(R,x)))/R2),w=f(1+q);
  const A=f(w*f(Math.sqrt(w))),fraction=f(f(-q*f(3+f(q*f(3+q))))/f(A*f(1+A)));
  const inv=f(1/Math.sqrt(R2)),scale=f(f(f(gm*inv)*inv)*inv);
  return x.map((v,k)=>f(scale*f(f(fraction*R[k])-f(f(1+fraction)*v))));
}

it('the tidal algebra preserves small forces and agrees with the independent force in every orientation', () => {
  const R=[1e9,0,0],x=[10,0,0],gm=fm.sun.gm;
  const truth=solarDifferential(x,R,gm),stable=tidal(x,R,gm,Math.fround);
  expect(Math.abs(stable[0]/truth[0]-1)).toBeLessThan(1e-6);
  expect(Math.fround(R[0]-x[0])).toBe(R[0]); // a direct f32 separation loses this tide entirely
  expect(tidal([0,0,0],R,gm,Math.fround).every(v=>v===0)).toBe(true);
  for(const r of [[2e7,-1e7,3e6],[-2e7,0,0],[0,2e7,0],[0,0,-2e7]]) {
    const exact=solarDifferential(r,[7e8,-2e8,1e8],gm),got=tidal(r,[7e8,-2e8,1e8],gm,n=>n);
    expect(Math.hypot(...got.map((v,k)=>v-exact[k]))/Math.hypot(...exact)).toBeLessThan(1e-12);
  }
});

it('both step and partial-display shaders enable the diagnostic only on explicit request', () => {
  const cfg={model:fm,samples:65,cKmS:C_KM_S,auKm:AU_KM,photometry:null};
  for(const shader of [stepShader,shadeShader,unitTestShader]) {
    expect(shader(cfg)).toContain('const DIAGNOSTIC_STABLE_DIFFERENTIAL: bool = false;');
    const source=shader({...cfg,diagnosticStableDifferential:true});
    expect(source).toContain('const DIAGNOSTIC_STABLE_DIFFERENTIAL: bool = true;');
    expect(source).toContain('-q * (3.0 + q * (3.0 + q)) / (A * (1.0 + A))');
  }
});

it('reports float32 force-error scales for all pinned moons at the epoch and both edges', () => {
  const reference=fixture<{epochEt:number;objects:{centerId:number;initial:number[];edges:{et:number;state:number[]}[]}[]}>('synthetic_moon_all_reference.json');
  if(!eph) return;
  const f=Math.fround;
  const norm=(r:number[])=>f(Math.sqrt(r.reduce((s,v)=>f(s+f(v*v)),0)));
  const direct=(x:number[],R:number[],gm:number)=>{
    const d=R.map((v,k)=>f(f(v)-f(x[k]))),id=f(1/norm(d));
    const kd=f(f(f(f(gm)*id)*id)*id);
    // CPU indirect table is evaluated in f64, stored in f32; direct term is evaluated in f32.
    const indirect=R.map(v=>f(-gm*v/Math.hypot(...R)**3));
    return d.map((v,k)=>f(f(kd*v)+indirect[k]));
  };
  const scales=[];
  for(const host of [5,6]) {
    const errors:number[]=[],stableErrors:number[]=[],distances:number[]=[],angular:Record<string,number[]>={planet:[],earth:[],near:[]};
    for(const o of reference.objects.filter(o=>o.centerId===host)) for(const s of [{et:reference.epochEt,state:o.initial},...o.edges]) {
      const hp=eph.positionSSB(host,s.et)!,sun=eph.positionSSB(10,s.et)!,R=sun.map((v,k)=>v-hp[k]),x=s.state.slice(0,3);
      const exact=solarDifferential(x,R,fm.sun.gm),rough=direct(x,R,fm.sun.gm),stable=tidal(x,R,fm.sun.gm,f);
      errors.push(Math.hypot(...rough.map((v,k)=>v-exact[k])));stableErrors.push(Math.hypot(...stable.map((v,k)=>v-exact[k])));
      distances.push(Math.hypot(...R));
      for(const view of ['planet','earth','near']) {
        const camera=moonCameraState(eph,s.et,host,fm.perturbers.find(p=>p.naifId===host)!.radius,view);
        const distance=Math.hypot(...x.map((v,k)=>v+hp[k]-camera[k]));
        angular[view].push(Math.atan2(45,distance)*180*3600/Math.PI);
      }
    }
    const T=Math.max(...reference.objects[0].edges.map(e=>Math.abs(e.et-reference.epochEt)));
    const summarize=(a:number[])=>({min:Math.min(...a),max:Math.max(...a)});
    scales.push({host,samples:errors.length,solarDistanceKm:summarize(distances),directForceErrorKmS2:summarize(errors),stableForceErrorKmS2:summarize(stableErrors),
      coherentDirectDisplacementScaleKm:0.5*Math.max(...errors)*T*T,coherentStableDisplacementScaleKm:0.5*Math.max(...stableErrors)*T*T,
      displacement45KmArcsec:Object.fromEntries(Object.entries(angular).map(([view,angles])=>[view,summarize(angles)]))});
  }
  console.log('MOON_ARITHMETIC',JSON.stringify(scales));
});
