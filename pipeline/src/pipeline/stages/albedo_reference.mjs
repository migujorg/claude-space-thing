import fs from 'node:fs';import {createRequire} from 'node:module';
const p=JSON.parse(fs.readFileSync(0,'utf8'));
const {build}=createRequire(process.cwd()+'/package.json')('esbuild');
if(!fs.existsSync(p.bundle)) await build({stdin:{contents:"export * from './src/render/spatial.ts';export {zonalMeanOfLevel0} from './src/render/surface.ts';",resolveDir:process.cwd(),loader:'ts'},outfile:p.bundle,bundle:true,platform:'node',format:'esm',logLevel:'silent'});
const lib=await import(p.bundle);
if(p.kind==='hapke-phase') {
 const resolved=lib.resolveLaw(p.model,0);if('error' in resolved)throw Error(resolved.error);
 console.log(JSON.stringify({algorithm:'hapke-phase-v1',model:p.model,
  cells:lib.buildHapkePhaseCells(resolved.law),minCrescentRad:1e-4,
  interpolationTolerance:1e-7,relativeTolerance:1e-5,
  sourceCodeSha256:p.sourceHash,spatialCodeSha256:p.spatialHash}));
 process.exit(0);
}
const norm=new lib.EllipsoidNormalization();
const map=p.hasMap?lib.zonalMeanOfLevel0(p.tiles.map(path=>{if(!path)return null;const b=fs.readFileSync(path);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);})):undefined;
const end=Math.log(Math.PI/1e-8),cache=new Map();
function value(t){
 if(cache.has(t))return cache.get(t);
 const a=Math.PI*-Math.expm1(-t),r=lib.resolveLaw(p.model,a);if('error' in r)throw Error(r.error);
 const bare=lib.lawDiskIntegral(r.law,a)[0],b=norm.reference(r.law,a,p.radii,p.view),m=map?norm.reference(r.law,a,p.radii,p.view,map):null;
 const delta=Math.PI-a,factor=p.model.kind==='minnaert'?delta**(2*r.law.p+1):delta**(r.law.p+1)*Math.min(1,delta/1e-3);
 const v=[...b.map(x=>x/bare),...(m?m.map(x=>x/bare):[]),bare/factor];cache.set(t,v);return v;
}
const cells=[];
function visit(lo,hi,depth=0){
 const values=[0,1/3,2/3,1].map(u=>value(lo+u*(hi-lo)));
 const interp=u=>values[0].map((_,k)=>-4.5*(u-1/3)*(u-2/3)*(u-1)*values[0][k]+13.5*u*(u-2/3)*(u-1)*values[1][k]-13.5*u*(u-1/3)*(u-1)*values[2][k]+4.5*u*(u-1/3)*(u-2/3)*values[3][k]);
 let error=0;
 for(const u of [1/12,1/6,1/4,1/2,3/4,5/6,11/12]){const exact=value(lo+u*(hi-lo)),got=interp(u);error=Math.max(error,...got.map((v,k)=>Math.abs(v/exact[k]-1)));}
 if(error>1e-5){if(depth>=16)throw Error('Calibration interpolation did not converge');const mid=(lo+hi)/2;visit(lo,mid,depth+1);visit(mid,hi,depth+1);}
 else cells.push({lo,hi,sphere:values.map(v=>v.at(-1)),bare:values.map(v=>v.slice(0,4)),...(map?{mapped:values.map(v=>v.slice(4,8))}:{})});
}
let cuts=Array.from({length:17},(_,i)=>end*i/16);
if(p.model.kind==='barkstrom')cuts.push(Math.log(Math.PI/1e-3),...p.model.B.alphaDeg.filter(a=>a>0&&a<180).map(a=>-Math.log1p(-a/180)));
cuts=[...new Set(cuts)].sort((a,b)=>a-b);for(let i=1;i<cuts.length;i++)visit(cuts[i-1],cuts[i]);
console.log(JSON.stringify({model:p.model,view:p.view,radiiKm:p.radii,cells,endLogCrescent:end,sphereFloor:1e-3,sourceCodeSha256:p.sourceHash,relativeTolerance:1e-5,quadrature:'exact-row converged TypeScript reference',...(map?{zonalRows:Array.from(map.mean),mapTileSha256:p.tiles.map(path=>path?createRequire(process.cwd()+'/package.json')('node:crypto').createHash('sha256').update(fs.readFileSync(path)).digest('hex'):null)}:{})}));
