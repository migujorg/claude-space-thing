// Independent surface sum: p=Dq, n=normalize(D^-1 q), dA_proj=det(D)(D^-1 o·q)dΩq.
import { describe, expect, it } from 'vitest';
import { cameraGeom, prepareFrame } from '../src/render/frame';
import { lawRadf, resolveLaw, LAMBERT_LAW, type ResolvedLaw } from '../src/render/spatial';
import { AdaptationState, computeEyeFrame } from '../src/eye/model';
import { DEFAULT_EYE_SETTINGS } from '../src/eye/settings';
import { AU_KM } from '../src/render/constants';
import type { SceneBody, SceneSnapshot } from '../src/render/scene';
const fs: {readFileSync(p:URL,enc:'utf8'):string;existsSync(p:URL):boolean} = await import(/* @vite-ignore */ 'node:fs' as string);
const built = fs.existsSync(new URL('../public/data/photometry.json', import.meta.url)) && fs.existsSync(new URL('../public/data/bodies.json', import.meta.url));
const photo = built ? JSON.parse(fs.readFileSync(new URL('../public/data/photometry.json', import.meta.url), 'utf8')) : {};
const bodies = built ? JSON.parse(fs.readFileSync(new URL('../public/data/bodies.json', import.meta.url), 'utf8')) : [];
type V3 = [number, number, number];
export function surfaceSum(radii: V3, law: ResolvedLaw, alpha: number, latitude = 0, n = 400): number {
  const [a,b,c] = radii, o = [Math.cos(latitude), 0, Math.sin(latitude)];
  const s = [o[0]*Math.cos(alpha), Math.sin(alpha), o[2]*Math.cos(alpha)];
  let sum = 0;
  for (let j=0;j<n;j++) {
    const z = -1+2*(j+0.5)/n, rr = Math.sqrt(1-z*z);
    for (let i=0;i<2*n;i++) {
      const lon = 2*Math.PI*(i+0.5)/(2*n), q = [rr*Math.cos(lon)/a, rr*Math.sin(lon)/b,z/c];
      const muArea = q[0]*o[0]+q[2]*o[2], len = Math.hypot(...q);
      if (muArea<=0) continue;
      const mu0 = (q[0]*s[0]+q[1]*s[1]+q[2]*s[2])/len;
      sum += lawRadf(law,mu0,muArea/len,alpha)*muArea*a*b*c*2/n*Math.PI/n;
    }
  }
  return sum/(Math.PI*Math.cbrt(a*b*c)**2);
}
function frame(radii: V3, model: any, alpha: number, latitude = 0, diamPx = 100) {
  const eye = computeEyeFrame(DEFAULT_EYE_SETTINGS,new AdaptationState(),'eye',0,null);
  const snapshot: SceneSnapshot = {et:0,camera:{orient:[1,0,0,0,1,0,0,0,1],fovY:Math.PI/3,width:1280,height:720},sun:null,bodies:[],orbits:[],view:{mode:'eye',exposureBoostStops:0,overlays:{provenanceTint:false}}};
  const g = cameraGeom(snapshot,1280,720,1e-7), R=Math.cbrt(radii[0]*radii[1]*radii[2]), D=2*R/(diamPx*g.pixelAngle);
  // Body x toward observer at latitude zero, body y toward Sun's eastward displacement.
  const cl=Math.cos(latitude), sl=Math.sin(latitude);
  const b: SceneBody & { albedoMeasurementView: {kind:'latitude';latitudeDeg:number} } = {id:599,name:'test ellipsoid',pos:[0,0,-D],toSun:[5*AU_KM*Math.sin(alpha),0,5*AU_KM*Math.cos(alpha)],orient:[0,1,0,-sl,0,cl,cl,0,sl],radii,albedoXYZS:[1e4,1e4,1e4,1e4],phase:{kind:'lambert'},surfaceUnknown:false,worstLabel:'estimated',selected:false,spatialModel:model,albedoMeasurementView:{kind:'latitude',latitudeDeg:0}};
  snapshot.bodies=[b];
  const p=prepareFrame(snapshot,g,eye,1e-12);
  const lr=resolveLaw(model,alpha),law='error' in lr?LAMBERT_LAW:lr.law;
  const contract=1e4/25*(R/D)**2*(Math.sin(alpha)+(Math.PI-alpha)*Math.cos(alpha))/Math.PI;
  return {p,contract,R,D,law};
}
describe.skipIf(!built)('ellipsoid flux pinned at the albedo measurement view',()=>{
  for (const [id,phase] of [[599,6.8],[699,5.7]]) it(`${id} equator-on disk carries its measured photometry`,()=>{
    const radii=bodies.find((b:any)=>b.id===id).radii.value as V3,alpha=phase*Math.PI/180;
    const {p,contract,R,D,law}=frame(radii,photo[id].spatialModel.value,alpha);
    const flux=p.resolved[0].K[1]*Math.PI*(R/D)**2*surfaceSum(radii,law,alpha);
    expect(Math.abs(flux/contract-1)).toBeLessThan(0.005);
  });
  it('sphere unchanged to rounding',()=>{
    const {p}=frame([6000,6000,6000],null,0.3);
    expect(p.resolved[0].K[1]).toBeCloseTo(1e4/25*1.5/Math.PI,10);
  });
  it('point and disk agree away from the reference latitude',()=>{
    const radii=bodies.find((b:any)=>b.id===699).radii.value as V3,alpha=5.7*Math.PI/180;
    const disk=frame(radii,photo[699].spatialModel.value,alpha,Math.PI/2,100);
    const point=frame(radii,photo[699].spatialModel.value,alpha,Math.PI/2,0.8);
    const predicted=disk.p.resolved[0].K[1]*Math.PI*(disk.R/disk.D)**2*surfaceSum(radii,disk.law,alpha,Math.PI/2);
    expect(Math.abs((point.p.points[0].E[1]/point.contract)/(predicted/disk.contract)-1)).toBeLessThan(0.005);
    expect(predicted/disk.contract).toBeGreaterThan(1.1);
  });
});

// Original-position parametrization, with quadrature cut at source map rows. This
// does not use the production normal-space Jacobian/profile transformation.
import { EllipsoidNormalization, MotionNormalization, gaussLegendre, LAW, type ZonalProfile } from '../src/render/spatial';
import { zonalMeanOfLevel0 } from '../src/render/surface';
const fileBytes: {readFileSync(p:URL):Uint8Array} = await import(/* @vite-ignore */ 'node:fs' as string);
function mapAt(z:ZonalProfile,lat:number,k:number) {
  const row=(0.5-lat/Math.PI)*z.rows-0.5,j=Math.max(0,Math.min(z.rows-1,Math.floor(row))),t=Math.max(0,Math.min(1,row-j));
  return z.mean[4*j+k]*(1-t)+z.mean[4*Math.min(j+1,z.rows-1)+k]*t;
}
function positionQuadrature(radii:V3,law:ResolvedLaw,alpha:number,z?:ZonalProfile):number[] {
  const [a,,c]=radii,R=Math.cbrt(a*a*c),sa=Math.sin(alpha),ca=Math.cos(alpha),delta=Math.PI-alpha;
  const cuts=[-Math.PI/2,Math.PI/2];
  if(z)for(let j=0;j<z.rows;j++) {
    const lat=Math.PI*(0.5-(j+0.5)/z.rows);
    cuts.push(Math.atan2(a*Math.sin(lat),c*Math.cos(lat)));
  }
  cuts.sort((x,y)=>x-y);
  const bg=gaussLegendre(z?12:64),lg=gaussLegendre(96),sum=[0,0,0,0];
  for(let j=1;j<cuts.length;j++)for(let q=0;q<bg.x.length;q++) {
    const half=(cuts[j]-cuts[j-1])/2,beta=cuts[j-1]+(bg.x[q]+1)*half,cb=Math.cos(beta),sb=Math.sin(beta);
    const lat=Math.atan2(c*sb,a*cb);
    for(let p=0;p<lg.x.length;p++) {
      const u=lg.x[p]*Math.PI/2,eps=delta*(1+Math.sin(u))/2,lon=Math.PI/2-eps;
      const nx=cb*Math.cos(lon)/a,ny=cb*Math.sin(lon)/a,nz=sb/c,nlen=Math.hypot(nx,ny,nz);
      const mu=nx/nlen,mu0=(ca*nx+sa*ny)/nlen;
      const weight=lawRadf(law,mu0,mu,alpha)*a*a*c*nx*cb*bg.w[q]*half*lg.w[p]*delta/4*Math.cos(u)/(R*R);
      for(let k=0;k<4;k++)sum[k]+=weight*(z?mapAt(z,lat,k):1);
    }
  }
  return sum;
}
describe('ellipsoid law and zonal-map quadrature',()=>{
  for(const id of [599,699,799,899])it.skipIf(!built || ![0,1].every(t=>fs.existsSync(new URL(`../public/data/surfaces/${id}/albedo/0/0/${t}.bin`,import.meta.url))))(`${id} exact source rows and position latitude`,()=>{
    const radii=bodies.find((b:any)=>b.id===id).radii.value as V3;
    const tiles=[0,1].map(t=>{const v=fileBytes.readFileSync(new URL(`../public/data/surfaces/${id}/albedo/0/0/${t}.bin`,import.meta.url));return v.buffer.slice(v.byteOffset,v.byteOffset+v.byteLength) as ArrayBuffer;});
    const z=zonalMeanOfLevel0(tiles),norm=new EllipsoidNormalization();
    for(const phase of [0,60,150,179,179.5,179.9]) {
      const alpha=phase*Math.PI/180,lr=resolveLaw(photo[id].spatialModel.value,alpha),law='error' in lr?LAMBERT_LAW:lr.law;
      const ref=positionQuadrature(radii,law,alpha,z),got=norm.reference(law,alpha,radii,{kind:'latitude',latitudeDeg:0},z);
      for(let k=0;k<4;k++)expect(Math.abs(got[k]/ref[k]-1),`${phase}° channel ${k}`).toBeLessThan(1e-4);
    }
  },30000);
  it('orientation mean is the mean projected area, not an equator-on guess',()=>{
    const radii:V3=[2,2,1.7],R=Math.cbrt(2*2*1.7),e=Math.sqrt(1-(1.7/2)**2);
    const surfaceArea=2*Math.PI*4*(1+(1-e*e)/e*Math.atanh(e));
    const got=new EllipsoidNormalization().reference(LAMBERT_LAW,0,radii,{kind:'orientation-mean'});
    expect(got[1]/(2/3)).toBeCloseTo(surfaceArea/(4*Math.PI*R*R),12);
  });
  it('a triaxial instantaneous integral matches an independent surface sum',()=>{
    const radii:V3=[3,2,1],alpha=0.4,law={...LAMBERT_LAW,kind:LAW.minnaert,p:0.7};
    const axes: [V3,V3,V3]=[[0,1,0],[0,0,1],[1,0,0]];
    const got=new EllipsoidNormalization().get(law,alpha,{radii,pole:[0,1,0],axes});
    expect(Math.abs(got[1]/surfaceSum(radii,law,alpha)-1)).toBeLessThan(5e-4);
  });
});

// The fixed calibration is a pipeline product; first-use interpolation is compared
// with the original exact-row direct integral, separately from validation cases.
describe.skipIf(!built)('dated calibration normalization product', () => {
  for (const id of [599,699,799,899]) it(`${id} table matches the direct dated-view mean`, () => {
    const view=photo[id].albedoMeasurementView.value;
    const table=photo[id].albedoReferenceNormalization.value;
    expect(table).toBeDefined();
    expect(photo[id].albedoMeasurementView.label).toBe('derived');
    expect(photo[id].albedoReferenceNormalization.label).toBe('estimated');
    const direct=view;
    const radii=bodies.find((b: {id:number})=>b.id===id).radii.value as V3;
    const tiles=[0,1].map(t=>{const v=fileBytes.readFileSync(new URL(`../public/data/surfaces/${id}/albedo/0/0/${t}.bin`,import.meta.url));return v.buffer.slice(v.byteOffset,v.byteOffset+v.byteLength) as ArrayBuffer;});
    const map=zonalMeanOfLevel0(tiles);
    const productOnly=new EllipsoidNormalization({get:()=>{throw new Error('frame-time spherical oracle');}} as unknown as MotionNormalization);
    const probe=resolveLaw(photo[id].spatialModel.value,.3);
    if(!('error' in probe)) expect(productOnly.reference(probe.law,.3,radii,view,map,table).every(Number.isFinite)).toBe(true);
    const norm=new EllipsoidNormalization();
    for(const profile of [undefined,map]) for(const deg of [0,6.8,30.1,59.9,90,120,150,175,179,179.5,179.9,179.99,179.9999]) {
      const alpha=deg*Math.PI/180,r=resolveLaw(photo[id].spatialModel.value,alpha),law='error' in r?LAMBERT_LAW:r.law;
      const got=norm.reference(law,alpha,radii,view,profile,table),exact=norm.reference(law,alpha,radii,direct,profile);
      for(let k=0;k<4;k++)expect(Math.abs(got[k]/exact[k]-1),`${id} ${deg}° map=${!!profile} c=${k}`).toBeLessThan(1e-4);
    }
  },60000);
  it('a different law or different map cannot reuse a calibration table',()=>{
    const id=799,view=photo[id].albedoMeasurementView.value;
    const radii=bodies.find((b: {id:number})=>b.id===id).radii.value as V3;
    const norm=new EllipsoidNormalization(),direct=view;
    const map:ZonalProfile={rows:3,mean:Float64Array.from([1,1,1,1,2,2,2,2,1,1,1,1])};
    expect(norm.reference(LAMBERT_LAW,.3,radii,view,map,photo[id].albedoReferenceNormalization.value)).toEqual(norm.reference(LAMBERT_LAW,.3,radii,direct,map));
  });
});
