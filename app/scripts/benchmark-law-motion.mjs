// Opt-in CPU benchmark: node scripts/benchmark-law-motion.mjs [--runs=3] [--baseline=18b70e2]
// No server, browser, downloads or shared data writes. Builds tiny ESM bundles into /tmp.
// --verify separately checks all 86,400 XYZS outputs against converged quadrature (about two minutes).
// --current-only / --old-only select one variant; --baseline=1847844 measures the original fixed-order code.
// --trace and --giant-only are diagnostic modes; --giant-only is not the required nine-body check.
// --check fails if any warm sample run exceeds median 0.5 ms or p99 2 ms; use on an idle machine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
// Some restricted lane runtimes cannot reap a synchronous child even after exit 0.
function git(args) {
  try { return execFileSync('git', args, { cwd: app, encoding: 'utf8' }); }
  catch (e) { if (e.status === 0 && typeof e.stdout === 'string') return e.stdout; throw e; }
}
const app = fileURLToPath(new URL('..', import.meta.url));
const runs = Number(process.argv.find(s => s.startsWith('--runs='))?.split('=')[1] ?? 3);
if (process.argv.includes('--check') && process.argv.includes('--giant-only')) throw new Error('--giant-only cannot qualify the nine-body cost check');
const baseline = process.argv.find(s => s.startsWith('--baseline='))?.split('=')[1] ?? '18b70e2';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'law-motion-'));
globalThis.__lawWork = [];
const phot = JSON.parse(fs.readFileSync(path.join(app, 'public/data/photometry.json')));
const scenes = JSON.parse(fs.readFileSync(path.join(app, 'e2e/scenes.json'))).scenes;
const sets = [
  { scene: 'jupiter-galileans', moons: ['501', '502', '503', '504', '506', '507', '508', '509'] },
  { scene: 'saturn-rings', moons: ['601', '602', '603', '604', '605', '606', '607', '608'] },
].map(s => ({ ...s, ids: [scenes.find(v => v.id === s.scene).params.target, ...s.moons] }));
// Snapshot the small level-0 inputs once, so a concurrent shared-data rebuild cannot change
// the maps between current/baseline runs. The snapshot is in memory, not a new data product.
const tiles = new Map(sets.map(set => [set.ids[0], [0, 1].map(t => {
  const bytes = fs.readFileSync(path.join(app, `public/data/surfaces/${set.ids[0]}/albedo/0/0/${t}.bin`));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
})]));
async function bundle(ref, tag) {
  const filename = path.join(temp, tag + '.mjs');
  await build({ stdin: { contents: `export { lawIntegral } from './src/render/frame.ts'; export { resolveLaw, LAMBERT_LAW, lawDiskIntegral, LAW } from './src/render/spatial.ts'; export { zonalMeanOfLevel0 } from './src/render/surface.ts';`, resolveDir: app, loader: 'ts' },
    outfile: filename, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
    plugins: [{ name: 'baseline', setup(b) { b.onLoad({ filter: /src\/render\/(frame|spatial)\.ts$/ }, args => {
      const relative = path.relative(path.dirname(app), args.path);
      let contents = ref ? git(['show', `${ref}:${relative}`]) : fs.readFileSync(args.path, 'utf8');
      if (!ref && args.path.endsWith('/spatial.ts') && process.argv.includes('--trace')) {
        contents = contents.replace('const results = spectralIntegral(law, a, zonal.pole, spectrum, R, degree, choices.filter(d => d <= degree), correction);',
          "const stageStart = performance.now(); const results = spectralIntegral(law, a, zonal.pole, spectrum, R, degree, choices.filter(d => d <= degree), correction); globalThis.__lawWork.push({ method: 'spectral', degree, ms: performance.now()-stageStart });");
        contents = contents.replace('let prev = crescentIntegral(law, a, zonal.pole, zonal.profile, spectrum.knots, n, nb);',
          "let stageStart = performance.now(); let prev = crescentIntegral(law, a, zonal.pole, zonal.profile, spectrum.knots, n, nb); globalThis.__lawWork.push({ method: 'row', n, ms: performance.now()-stageStart });");
        contents = contents.replace('const value = crescentIntegral(law, a, zonal.pole, zonal.profile, spectrum.knots, n, nb);',
          "stageStart = performance.now(); const value = crescentIntegral(law, a, zonal.pole, zonal.profile, spectrum.knots, n, nb); globalThis.__lawWork.push({ method: 'row', n, ms: performance.now()-stageStart, change: Math.max(...value.map((v,c)=>Math.abs(v/prev[c]-1))) });");
      }
      if (args.path.endsWith('/frame.ts') && !contents.includes('export function lawIntegral')) contents += '\nexport { lawIntegral };\n';
      return { contents, loader: 'ts' };
    }); } }] });
  return import(filename);
}
function profile(lib, id) { return lib.zonalMeanOfLevel0(tiles.get(id)); }

function frame(lib, set, z, step, f, verify) {
  // A continuous orbit covers day, quarter and crescent views. Both phase and unit pole move.
  const angle = 0.2 + step * f, alpha = Math.acos(Math.cos(angle));
  const latitude = 0.7 * Math.sin(0.35 + step * f);
  const pole = [Math.cos(latitude) * Math.sin(angle), Math.sin(latitude), Math.cos(latitude) * Math.cos(angle)];
  let checksum = 0;
  for (let j = 0; j < (process.argv.includes('--giant-only') ? 1 : set.ids.length); j++) {
    const id = set.ids[j], a = Math.min(Math.PI, Math.max(0, alpha + j * 1e-5));
    const r = lib.resolveLaw(phot[id]?.spatialModel?.value, a);
    const law = 'error' in r ? lib.LAMBERT_LAW : r.law, zonal = j === 0 ? { profile: z, pole } : undefined;
    const value = lib.lawIntegral(law, a, zonal);
    if (verify) verify(id, a, value, lib.lawDiskIntegral(law, a, zonal, law.kind === lib.LAW.hapke ? 24 : 32));
    checksum += value[1];
  }
  return checksum;
}
const quantile = (a, q) => a[Math.min(a.length - 1, Math.floor(q * a.length))];
let failed = false, failedAccuracy = false;
try {
  console.log(JSON.stringify({ benchmark: 'normalization through prepareFrame lawIntegral', frames: 600, runs, baseline, bodies: sets.map(s => ({ scene: s.scene, ids: s.ids })), inputHashes: { photometry: createHash('sha256').update(fs.readFileSync(path.join(app, 'public/data/photometry.json'))).digest('hex'), tiles: Object.fromEntries([...tiles].map(([id, data]) => [id, data.map(bytes => createHash('sha256').update(new Uint8Array(bytes)).digest('hex'))])) }, note: 'Cold frame excluded from warm percentiles; warm frames include every real geometry query, no prefilled orbit cache.' }));
  // Fresh bundles per run reset the exact cache and all cold table construction.
  const variants = process.argv.includes('--current-only') ? [['current', null]] : process.argv.includes('--old-only') ? [['old', baseline]] : [['current', null], ['old', baseline]];
  for (let run = 0; run < runs; run++) for (const [tag, ref] of variants) {
    const lib = await bundle(ref, `${tag}-${run}`);
    for (const set of sets) for (const step of [1e-3, 1e-2]) {
      const z = profile(lib, set.ids[0]);
      const start = performance.now(); let checksum = frame(lib, set, z, step, 0);
      const cold = performance.now() - start;
      const times = [], slow = [];
      for (let f = 1; f <= 600; f++) {
        globalThis.__lawWork = [];
        const before = performance.now(); checksum += frame(lib, set, z, step, f);
        const elapsed = performance.now() - before; times.push(elapsed); if (elapsed > 2) slow.push({ f, ms: elapsed, phaseDeg: Math.acos(Math.cos(0.2 + step * f)) * 180 / Math.PI, ...(process.argv.includes('--trace') ? { work: globalThis.__lawWork } : {}) });
      }
      times.sort((a, b) => a - b);
      const median = quantile(times, 0.5), p99 = quantile(times, 0.99);
      const pass = median <= 0.5 && p99 <= 2;
      if (tag === 'current' && !pass) failed = true;
      let verification;
      if (process.argv.includes('--verify') && tag === 'current') {
        let count = 0, maxRelative = 0, worst;
        for (let f = 1; f <= 600; f++) frame(lib, set, z, step, f, (id, a, value, exact) => {
          for (let c = 0; c < 4; c++) {
            const relative = exact[c] === 0 ? Math.abs(value[c]) : Math.abs(value[c] / exact[c] - 1);
            count++;
            if (relative > maxRelative) { maxRelative = relative; worst = { id, frame: f, phaseDeg: a * 180 / Math.PI, channel: c }; }
          }
        });
        const accuracyPass = maxRelative < 2e-5;
        if (!accuracyPass) failedAccuracy = true;
        verification = { count, maxRelative, worst, accuracyPass };
      }
      console.log(JSON.stringify({ tag, ref: ref ?? git(['rev-parse', '--short', 'HEAD']).trim(), run: run + 1, scene: set.scene, stepRad: step, coldMs: cold, medianMs: median, p99Ms: p99, maxMs: times.at(-1), pass, checksum, verification, slowest: slow.sort((a,b) => b.ms-a.ms).slice(0, 10) }));
    }
  }
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
if ((process.argv.includes('--check') && failed) || failedAccuracy) process.exitCode = 1;
