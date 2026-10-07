// Independent surface sum: p=Dq, n=normalize(D^-1 q), dA_proj=det(D)(D^-1 o·q)dΩq.
import { describe, expect, it } from 'vitest';
import { cameraGeom, prepareFrame } from '../src/render/frame';
import { lawRadf, resolveLaw, LAMBERT_LAW, type ResolvedLaw } from '../src/render/spatial';
import { AdaptationState, computeEyeFrame } from '../src/eye/model';
import { DEFAULT_EYE_SETTINGS } from '../src/eye/settings';
import { AU_KM } from '../src/render/constants';
import type { SceneBody, SceneSnapshot } from '../src/render/scene';
const fs = await import('node:fs');
const photo = JSON.parse(fs.readFileSync(new URL('../public/data/photometry.json', import.meta.url), 'utf8'));
const bodies = JSON.parse(fs.readFileSync(new URL('../public/data/bodies.json', import.meta.url), 'utf8'));
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
describe('ellipsoid flux pinned at the albedo measurement view',()=>{
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
