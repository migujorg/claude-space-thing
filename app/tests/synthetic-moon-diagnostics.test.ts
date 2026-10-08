import { describe, expect, it } from 'vitest';
import { MOON_CAMERAS, MOON_EPHEMERIDES, moonCameraState, directionAngle, metricSummary, moonAngularBudget } from '../src/gpu/smallbodies/moonDiagnostics';
import { fixture, loadEphemerisSet } from './core-data';
import type { SmallBodyForceModel } from '../src/data/schema';
import { shadeShader, stepShader, unitTestShader } from '../src/gpu/smallbodies/kernels';
import { AU_KM, C_KM_S } from '../src/core/constants';
import { SmallBodyPropagator, hostForceModel } from '../src/core/smallbody';
import { checkRecordPicks, moonPickRows } from '../src/gpu/smallbodies/moonDiagnostics';
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

it('production moon step/display/twin use tides; catalogue arithmetic and named baseline remain direct', () => {
  const cfg={model:fm,samples:65,cKmS:C_KM_S,auKm:AU_KM,photometry:null};
  const host=fm.perturbers.find(p=>p.naifId===5)!;
  const model=hostForceModel(fm,5,host.gm);
  for(const shader of [stepShader,shadeShader,unitTestShader]) {
    expect(shader(cfg)).toContain('const STABLE_DIFFERENTIAL: bool = false;');
    expect(shader({...cfg,model})).toContain('const STABLE_DIFFERENTIAL: bool = true;');
    expect(shader({...cfg,model,diagnosticForceVariant:'baseline'})).toContain('const STABLE_DIFFERENTIAL: bool = false;');
  }
  const law={...model,perturbers:[{...fm.sun,name:'Sun'}]};
  const prop=new SmallBodyPropagator(law,{positionSSB:()=>null});
  const a=new Float64Array(3), x=1e-4, R=1e9;
  prop.acceleration([x,0,0,0,0,0],0,new Float64Array([R,0,0]),null,a);
  expect(a[0]/(2*fm.sun.gm*x/R**3)).toBeCloseTo(1,10);
  const baseline=new SmallBodyPropagator(law,{positionSSB:()=>null},'baseline'), direct=new Float64Array(3);
  baseline.acceleration([x,0,0,0,0,0],0,new Float64Array([R,0,0]),null,direct);
  expect(Math.abs(direct[0]/a[0]-1)).toBeGreaterThan(1e-5);
  for(const position of [[2e7,-1e7,3e6],[-2e7,0,0],[0,2e7,0],[0,0,-2e7],[.9*R,0,0]]) {
    prop.acceleration([...position,0,0,0],0,new Float64Array([R,0,0]),null,a);
    const truth=solarDifferential(position,[R,0,0],fm.sun.gm);
    expect(Math.hypot(...a.map((v,k)=>v-truth[k]))/Math.hypot(...truth)).toBeLessThan(1e-12);
  }
});

it('picking uses current combined-buffer records and global indices across both host batches', async () => {
  const count=7, records=new Float32Array((count+24)*8), words=new Uint32Array(records.buffer);
  for(let index=0;index<count+24;index++) {
    records.set([1,index/100,0],index*8);words[index*8+7]=index;
  }
  // Both host boundaries are represented: this is synthetic row order, never child sorted slots.
  const rows=moonPickRows([{firstObject:0,objects:21},{firstObject:21,objects:3}]);
  expect(rows).toEqual([0,10,20,21]);
  const calls:number[]=[];
  const checks=await checkRecordPicks({count,readRecords:async()=>records,
    pick:async(dir)=>{const index=Math.round(dir[1]*100);calls.push(index);return index;}},rows,1e-7);
  expect(calls).toEqual([0,7,17,27,28]); // catalogue control, then count + j
  expect(checks.every(c=>c.returnedIndex===c.expectedIndex && c.storedIndex===c.expectedIndex && c.askedStoredAngleRad===0)).toBe(true);
  // A batch-local identity is a defect even when the angular pick finds that record.
  words[28*8+7]=0;
  const bad=await checkRecordPicks({count,readRecords:async()=>records,pick:async()=>0},[21],1e-7);
  expect(bad[1].storedIndex).toBe(0);
  expect(bad[1].expectedIndex).toBe(28);
  const changed=records.slice();changed.set([0,1,0],7*8);
  let reads=0;
  const stale=await checkRecordPicks({count,readRecords:async()=>reads++===0?records:changed,pick:async()=>null},[0],1e-7);
  expect(stale[1].askedStoredAngleRad).toBeGreaterThan(1);
  expect(stale[1].returnedIndex).toBeNull();
});

it('reports float32 force-error scales for all pinned moons at the epoch and both edges', () => {
  const reference=fixture<{epochEt:number;objects:{centerId:number;initial:number[];edges:{et:number;state:number[]}[]}[]}>('synthetic_moon_all_reference.json');
  if(!eph) return;
  const f=Math.fround;
  const norm=(r:number[])=>f(Math.sqrt(r.reduce((s,v)=>f(s+f(v*v)),0)));
  const direct=(x:number[],R:number[],gm:number)=>{
    // prel's nearest-sample high/low difference before its final f32 collapse. At these
    // exact sample times interpolation weights select the sample, so no stencil error is charged.
    const d=R.map((v,k)=>{
      const Rh=f(v),Rl=f(v-Rh),xh=f(x[k]),xl=f(x[k]-xh);
      return f(f(Rh-xh)+f(Rl-xl));
    });
    const id=f(1/norm(d));
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
