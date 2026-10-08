// Test page for the GPU small-body field (dev/test only; driven by scripts/sb-gpu.mjs):
//   /sb-test.html?mode=accuracy[&n=1000]   GPU vs float64 CPU reference (19 verification objects + n random ones)
//   /sb-test.html?mode=timing[&chunk=65536] full catalogue: create, one grid step, shade
//   /sb-test.html?mode=render&scene=above|inside  real-data frame through the renderer (enhanced / eye)
//   /sb-test.html?mode=moon-accuracy&timestamps=1  compact all-moon reference, restore, picking and timing checks
//   /sb-test.html?mode=synthetic[&syncam=5]       synthetic layer: GPU records vs float64 positions and
//                                                  photometry, level gating, pick, timing
//   /sb-test.html?mode=comet                       comet coma shader: rendered flux vs the M1/K1 illuminance
// Results in window.__sbResult (JSON); render mode sets window.__frameReady.

import { cometGpuFlux } from '../../render/comets/gputest';
import type { EphemHeader, LightData, SmallBodyCoreHeader, SmallBodyPhotometry, SmallBodyPhysicalHeader, SmallBodyTableHeader, BinaryTableHeader, SyntheticObjectsHeader } from '../../data/schema';
import { centerStateFrom, readSynthetic, syntheticState } from '../../core/smallbodySynthetic';
import { hgPhi, magnitudeToXYZS } from '../../core/smallbodyPhotometry';
import { Ephemeris, EphemerisSet } from '../../core/ephemeris';
import { SB_OK, SmallBodyPropagator, type NonGrav } from '../../core/smallbody';
import { coreState, readCore, readNonGrav } from '../../core/smallbodyCatalog';
import { AU_KM, C_KM_S } from '../../core/constants';
import { BinaryTable } from '../../data/binaryTable';
import { buildStarCatalog } from '../../data/stars';
import { luxFromMagnitude, magnitudeFromLux } from '../../eye/crumey';
import { resolveBinPath } from '../../data/load';
import { SmallBodyField, type SmallBodyTables } from './field';
import type { Vec3 } from '../../core/vec';

declare global {
  interface Window {
    __sbResult?: unknown;
    __frameReady?: boolean;
    __frameError?: string;
  }
}

const params = new URLSearchParams(location.search);
const log = (s: string) => {
  console.log(s);
  const el = document.getElementById('log');
  if (el) el.textContent += s + '\n';
};

async function json<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return (await r.json()) as T;
}
async function bin(path: string): Promise<ArrayBuffer> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.arrayBuffer();
}

async function loadEphemeris(): Promise<EphemerisSet> {
  const set = new EphemerisSet();
  for (const name of ['de442s', 'sat-plu']) {
    const h = await json<EphemHeader>(`/data/ephem/${name}.json`);
    set.add(new Ephemeris(h, new Float64Array(await bin(`/data/${h.bin}`))));
  }
  return set;
}

async function loadTables(): Promise<SmallBodyTables> {
  const d = '/data/smallbodies/';
  const coreHeader = await json<SmallBodyCoreHeader>(d + 'core.json');
  const physicalHeader = await json<SmallBodyPhysicalHeader>(d + 'physical.json');
  const cometsHeader = await json<SmallBodyTableHeader>(d + 'comets.json');
  const nongravHeader = await json<SmallBodyTableHeader>(d + 'nongrav.json');
  const [core, physical, comets, nongrav] = await Promise.all(['core', 'physical', 'comets', 'nongrav'].map((n) => bin(`${d}${n}.bin`)));
  const photometry = await json<SmallBodyPhotometry>(d + 'photometry.json');
  let synthetic: SmallBodyTables['synthetic'];
  if (params.get('synthetic') !== '0') {
    try {
      const header = await json<SyntheticObjectsHeader>('/data/synthetic/objects.json');
      synthetic = { header, objects: await bin('/data/synthetic/objects.bin') };
    } catch (e) {
      log(`no synthetic layer: ${(e as Error).message}`);
    }
  }
  return { core, coreHeader, physical, physicalHeader, comets, cometsHeader, nongrav, nongravHeader, photometry, synthetic };
}

/** Tables restricted to core rows `rows` (in that order); row references remapped. */
function subsetTables(t: SmallBodyTables, rows: number[]): SmallBodyTables {
  const ch = t.coreHeader;
  const cs = ch.stride;
  const core = new Uint8Array(rows.length * cs);
  const src = new Uint8Array(t.core);
  const newIndex = new Map<number, number>();
  rows.forEach((r, k) => { core.set(src.subarray(r * cs, (r + 1) * cs), k * cs); newIndex.set(r, k); });
  const coreHeader = { ...ch, count: rows.length };
  const sub = (buf: ArrayBuffer | undefined, h: SmallBodyTableHeader | undefined, keep: (row: number, k: number) => number | null) => {
    if (!buf || !h) return { buf, h };
    const tab = new BinaryTable(h, buf);
    const rowF = h.fields.find((f) => f.name === 'row')!;
    const out: Uint8Array[] = [];
    const s8 = new Uint8Array(buf);
    for (let k = 0; k < tab.count; k++) {
      const n = keep(tab.get('row', k), k);
      if (n === null) continue;
      const rec = s8.slice(k * h.stride, (k + 1) * h.stride);
      new DataView(rec.buffer).setUint32(rowF.offset, n, true);
      out.push(rec);
    }
    const all = new Uint8Array(Math.max(1, out.length) * h.stride);
    out.forEach((r, i) => all.set(r, i * h.stride));
    return { buf: all.buffer, h: { ...h, count: out.length } };
  };
  // physical: keep the rows referenced by the subset, fix core.physRow.
  const physRowOff = ch.fields.find((f) => f.name === 'physRow')!.offset;
  const dv = new DataView(core.buffer);
  const physMap = new Map<number, number>();
  rows.forEach((_, k) => {
    const pr = dv.getUint32(k * cs + physRowOff, true);
    if (pr !== 0xffffffff) physMap.set(pr, physMap.size);
  });
  rows.forEach((_, k) => {
    const pr = dv.getUint32(k * cs + physRowOff, true);
    if (pr !== 0xffffffff) dv.setUint32(k * cs + physRowOff, physMap.get(pr)!, true);
  });
  const ph = t.physical && t.physicalHeader ? (() => {
    const h = t.physicalHeader!;
    const s8 = new Uint8Array(t.physical!);
    const all = new Uint8Array(Math.max(1, physMap.size) * h.stride);
    const rowOff = h.fields.find((f) => f.name === 'row')!.offset;
    for (const [pr, k] of physMap) {
      all.set(s8.subarray(pr * h.stride, (pr + 1) * h.stride), k * h.stride);
      const core0 = new DataView(t.physical!).getUint32(pr * h.stride + rowOff, true);
      new DataView(all.buffer).setUint32(k * h.stride + rowOff, newIndex.get(core0)!, true);
    }
    return { buf: all.buffer, h: { ...h, count: physMap.size } };
  })() : { buf: undefined, h: undefined };
  const co = sub(t.comets, t.cometsHeader, (r) => newIndex.get(r) ?? null);
  const ng = sub(t.nongrav, t.nongravHeader, (r) => newIndex.get(r) ?? null);
  return {
    core: core.buffer, coreHeader, physical: ph.buf as ArrayBuffer | undefined, physicalHeader: ph.h as SmallBodyPhysicalHeader | undefined,
    comets: co.buf, cometsHeader: co.h, nongrav: ng.buf, nongravHeader: ng.h, photometry: t.photometry, synthetic: t.synthetic,
  };
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

async function device(): Promise<GPUDevice> {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('no WebGPU adapter');
  const lim = adapter.limits;
  return adapter.requestDevice({ requiredFeatures: params.get('timestamps') === '1' && adapter.features.has('timestamp-query') ? ['timestamp-query'] : [], requiredLimits: { maxStorageBufferBindingSize: lim.maxStorageBufferBindingSize, maxBufferSize: lim.maxBufferSize } });
}

async function submit(dev: GPUDevice, field: SmallBodyField, et: number, cam: Vec3, level: 'strict' | 'best' | 'complete' = 'best'): Promise<number> {
  const enc = dev.createCommandEncoder();
  field.update(enc, et, cam, { brightness: level });
  const t0 = performance.now();
  dev.queue.submit([enc.finish()]);
  await dev.queue.onSubmittedWorkDone();
  return performance.now() - t0;
}

// ------------------------------------------------------------------------------------------------ accuracy
async function accuracy(): Promise<unknown> {
  const dev = await device();
  const eph = await loadEphemeris();
  const all = await loadTables();
  // The verification objects of this build: their rows and names from the record the smallbodies stage wrote with
  // these tables. (The committed reference's coreRow is a row of the SBDB snapshot it was made from.)
  const fx = await json<{ objects: { name: string; category: string; coreRow: number }[] }>('/data/verification/smallbodies.json').catch(() => {
    throw new Error('this build has no verification/smallbodies.json (it was made before the smallbodies stage wrote its build record): rebuild the smallbodies stage');
  });
  const N = Number(params.get('n') ?? 1000);
  const full = readCore(all.coreHeader, all.core);
  const rand = rng(20260930);
  const rows: number[] = fx.objects.map((o) => o.coreRow);
  const labels: string[] = fx.objects.map((o) => o.name);
  const seen = new Set(rows);
  while (rows.length < fx.objects.length + N) {
    const r = Math.floor(rand() * full.count);
    if (seen.has(r) || !coreState(full, r)) continue;
    seen.add(r);
    rows.push(r);
    labels.push(`row ${r}`);
  }
  const tables = subsetTables(all, rows);
  const t0 = performance.now();
  const field = await SmallBodyField.create(dev, tables, eph, { debug: true, useFma: params.get('fma') === null ? undefined : params.get('fma') === '1' });
  log(`field: ${field.count} objects, created in ${(performance.now() - t0).toFixed(0)} ms; precision ${field.info.precision}; self-test ${JSON.stringify(field.info.selfTest)}; checkpoint spacing ${field.info.checkpointSpacingSteps}`);

  const cat = readCore(tables.coreHeader, tables.core);
  const prop = new SmallBodyPropagator(tables.coreHeader.forceModel, eph);
  const ng: Map<number, NonGrav> = tables.nongrav ? readNonGrav(tables.nongravHeader!, tables.nongrav) : new Map();
  const E0 = cat.epochEt;
  const H = tables.coreHeader.forceModel.grid.baseStepS;
  const win = tables.coreHeader.window;
  const DAY = 86400;
  // Order: outward, a jump back (checkpoint restore), the other side, a jump across the epoch, the window edges.
  const days = (params.get('days') ?? '0.37,30.2,200.6,120.1,547.9,-0.71,-60.4,-274.3,-150.9,-547.2,3.5,365.25').split(',').map(Number);
  const cache = new Map<number, { m: number; st: Float64Array }>();
  const cpuState = (i: number, et: number): Float64Array | null => {
    const x = (et - E0) / H;
    const m = x >= 0 ? Math.floor(x) : Math.ceil(x);
    const s0 = coreState(cat, i);
    if (!s0) return null;
    let from = { m: 0, st: s0 };
    const c = cache.get(i);
    if (c && (c.m === 0 || (Math.sign(c.m) === Math.sign(m) && Math.abs(c.m) <= Math.abs(m)))) from = { m: c.m, st: c.st.slice() };
    const st = from.st;
    if (from.m !== m && prop.propagateOne(st, 0, E0 + from.m * H, E0 + m * H, E0, ng.get(i) ?? null) !== SB_OK) {
      cache.delete(i);
      return null;
    }
    cache.set(i, { m, st: st.slice() });
    if (prop.propagateOne(st, 0, E0 + m * H, et, E0, ng.get(i) ?? null) !== SB_OK) return null;
    return st;
  };
  const idx = rows.map((_, k) => k);
  const perObject = new Float64Array(rows.length);
  const perObjectV = new Float64Array(rows.length);
  const times: unknown[] = [];
  let failures = 0;
  for (const dd of days) {
    const et = Math.min(win.endEt - 60, Math.max(win.startEt + 60, E0 + dd * DAY));
    const sun = eph.positionSSB(10, et)!;
    const cam: Vec3 = [sun[0] + AU_KM, sun[1], sun[2]];
    const gpuMs = await submit(dev, field, et, cam);
    const last = { ...field.info.last };
    const g = await field.readDebugStates(idx);
    const tc = performance.now();
    let max = 0, maxV = 0, worst = -1, sum = 0, n = 0;
    const errs: number[] = [];
    for (let k = 0; k < rows.length; k++) {
      const c = cpuState(k, et);
      const gx = g.subarray(6 * k, 6 * k + 6);
      const gOk = Number.isFinite(gx[0]);
      if (!c || !gOk) {
        if (!!c !== gOk) { failures++; log(`  status mismatch ${labels[k]} at ${dd} d: cpu ${c ? 'ok' : 'failed'} gpu ${gOk ? 'ok' : 'failed'}`); }
        continue;
      }
      const e = Math.hypot(gx[0] - c[0], gx[1] - c[1], gx[2] - c[2]);
      const ev = Math.hypot(gx[3] - c[3], gx[4] - c[4], gx[5] - c[5]);
      errs.push(e);
      perObject[k] = Math.max(perObject[k], e);
      perObjectV[k] = Math.max(perObjectV[k], ev);
      sum += e; n++;
      if (e > max) { max = e; worst = k; }
      maxV = Math.max(maxV, ev);
    }
    errs.sort((a, b) => a - b);
    const q = (p: number) => errs[Math.min(errs.length - 1, Math.floor(p * errs.length))];
    const rec = { days: dd, et, steps: last.steps, backgroundSteps: last.backgroundSteps, restoredFrom: last.restoredFrom, gpuMs: Math.round(gpuMs), cpuMs: Math.round(performance.now() - tc), n, maxKm: max, p50Km: q(0.5), p99Km: q(0.99), meanKm: sum / n, maxKmS: maxV, worst: labels[worst] };
    times.push(rec);
    log(`t = ${dd} d: ${last.steps} steps (+${last.backgroundSteps} bg, from ${last.restoredFrom ?? 'W'}), GPU ${gpuMs.toFixed(0)} ms; |dr| max ${max.toFixed(3)} km (${labels[worst]}), p99 ${q(0.99).toFixed(3)}, p50 ${q(0.5).toFixed(4)} km; |dv| max ${maxV.toExponential(2)} km/s`);
  }
  const fixtureErr = fx.objects.map((o, k) => ({ label: o.name, category: o.category, maxKm: perObject[k], maxKmS: perObjectV[k] }));
  for (const f of fixtureErr) log(`  ${f.label.padEnd(30)} max |dr| ${f.maxKm.toFixed(3)} km  |dv| ${f.maxKmS.toExponential(2)} km/s`);
  const randErr = Array.from(perObject.subarray(fx.objects.length)).sort((a, b) => a - b);
  const rq = (p: number) => randErr[Math.min(randErr.length - 1, Math.floor(p * randErr.length))];
  const worstRandom = [...perObject.subarray(fx.objects.length)].map((e, k) => ({ e, k: k + fx.objects.length })).sort((a, b) => b.e - a.e).slice(0, 5)
    .map(({ e, k }) => ({ row: rows[k], maxKm: e, flags: cat.table.get('flags', k), orbitClass: tables.coreHeader.orbitClasses[cat.table.get('orbitClass', k)]?.code }));
  log(`random ${N}: max over the window ${rq(1).toFixed(3)} km, p99 ${rq(0.99).toFixed(3)}, p50 ${rq(0.5).toFixed(4)}; worst ${JSON.stringify(worstRandom)}`);

  // Photometry and direction of the records vs the CPU (at the last time).
  const lastEt = (times[times.length - 1] as { et: number }).et;
  const sun = eph.positionSSB(10, lastEt)!;
  const cam: Vec3 = [sun[0] + 0.3 * AU_KM, sun[1] - 0.9 * AU_KM, sun[2] + 0.2 * AU_KM];
  await submit(dev, field, lastEt, cam, 'best');
  const recs = await field.readRecords();
  const g = await field.readDebugStates(idx);
  const sa = eph.positionSSB(10, lastEt - 1)!, sb = eph.positionSSB(10, lastEt + 1)!;
  const sv = [0, 1, 2].map((j) => (sb[j] - sa[j]) / 2);
  let maxAng = 0, maxDm = 0, nLit = 0, nCmp = 0;
  for (let k = 0; k < rows.length; k++) {
    const s = field.slotOf(k);
    const r = recs.subarray(8 * s, 8 * s + 8);
    const x = g.subarray(6 * k, 6 * k + 6);
    if (!Number.isFinite(x[0])) continue;
    // CPU geometry from the GPU state (tests the shading, not the propagation).
    const rel0 = [0, 1, 2].map((j) => x[j] + sun[j] - cam[j]);
    const tau = Math.hypot(...rel0) / C_KM_S;
    const rel = [0, 1, 2].map((j) => rel0[j] - tau * (x[3 + j] + sv[j]));
    const xo = [0, 1, 2].map((j) => x[j] - tau * x[3 + j]);
    const dist = Math.hypot(...rel);
    const dir = rel.map((v) => v / dist);
    maxAng = Math.max(maxAng, Math.hypot(dir[0] - r[0], dir[1] - r[1], dir[2] - r[2]));
    const rr = Math.hypot(...xo);
    const cr = [xo[1] * rel[2] - xo[2] * rel[1], xo[2] * rel[0] - xo[0] * rel[2], xo[0] * rel[1] - xo[1] * rel[0]];
    const alpha = Math.atan2(Math.hypot(...cr), xo[0] * rel[0] + xo[1] * rel[1] + xo[2] * rel[2]);
    const ap = field.light!.apparent(k, rr / AU_KM, dist / AU_KM, alpha, 'best');
    if (ap && r[4] > 0) {
      nCmp++;
      maxDm = Math.max(maxDm, Math.abs(-2.5 * Math.log10(r[4] / ap.E[1])));
    }
    if (r[4] > 0) nLit++;
  }
  log(`records: direction max |du| ${maxAng.toExponential(2)} rad; Y vs CPU photometry max ${maxDm.toFixed(4)} mag over ${nCmp} lit objects (${nLit} lit)`);

  // pick: the brightest object near the direction of object 0.
  const s0 = field.slotOf(0);
  const d0: Vec3 = [recs[8 * s0], recs[8 * s0 + 1], recs[8 * s0 + 2]];
  const picked = await field.pick(d0, 1e-4);
  log(`pick toward ${labels[0]}: ${picked === null ? 'null' : labels[picked]}`);
  // pick vs a CPU scan of the same records, for cones around random objects (brightest lit, else nearest).
  let pickAgree = 0;
  const pickCases = 40;
  for (let c = 0; c < pickCases; c++) {
    const k = Math.floor(rand() * rows.length);
    const sk = field.slotOf(k);
    const tol = [1e-5, 1e-3, 0.02, 0.2][c % 4];
    const dir: Vec3 = [recs[8 * sk] + 0.3 * tol, recs[8 * sk + 1] - 0.2 * tol, recs[8 * sk + 2]];
    const l = Math.hypot(...dir);
    const u = dir.map((v) => v / l);
    const thr = Math.fround((2 * Math.sin(tol / 2)) ** 2);
    let bestY = 0, bestYi = -1, bestC = Infinity, bestCi = -1;
    const f32 = Math.fround;
    for (let s = 0; s < field.count; s++) {
      const a = [recs[8 * s], recs[8 * s + 1], recs[8 * s + 2]];
      if (a[0] * a[0] + a[1] * a[1] + a[2] * a[2] < 0.25) continue;
      const dd = a.map((v, j) => f32(v - f32(u[j])));
      const c2 = f32(f32(f32(dd[0] * dd[0]) + f32(dd[1] * dd[1])) + f32(dd[2] * dd[2]));
      if (c2 > thr) continue;
      const idx = new Uint32Array(recs.buffer, (8 * s + 7) * 4, 1)[0];
      const y = recs[8 * s + 4];
      if (y > bestY || (y === bestY && y > 0 && idx < bestYi)) { bestY = y; bestYi = idx; }
      if (c2 < bestC || (c2 === bestC && idx < bestCi)) { bestC = c2; bestCi = idx; }
    }
    const want = bestY > 0 ? bestYi : bestCi >= 0 ? bestCi : null;
    const got = await field.pick(u as Vec3, tol);
    if (got === want) pickAgree++;
    else log(`  pick mismatch: tol ${tol}, gpu ${got}, cpu ${want}`);
  }
  log(`pick vs CPU scan: ${pickAgree}/${pickCases} agree`);
  // exclude() and stats: object 0 loses its light but keeps its direction; counts arrive a frame later.
  field.exclude([0]);
  await submit(dev, field, lastEt, cam, 'best');
  await submit(dev, field, lastEt, cam, 'strict');
  await submit(dev, field, lastEt, cam, 'strict');
  await new Promise((r) => setTimeout(r, 50));
  const recs2 = await field.readRecords();
  const excludedOk = recs2[8 * s0 + 4] === 0 && recs2[8 * s0] === recs[8 * s0];
  field.exclude([]);
  const statsStrict = field.stats;
  log(`exclude: ${excludedOk ? 'ok' : 'FAILED'}; stats at strict: ${JSON.stringify(statsStrict)}`);
  const so = field.stateOf(0, lastEt);
  const cpu0 = cpuState(0, lastEt);
  const stateOfErr = so && cpu0 ? Math.hypot(so.pos[0] - cpu0[0], so.pos[1] - cpu0[1], so.pos[2] - cpu0[2]) : null;
  return {
    precision: field.info.precision, selfTest: field.info.selfTest, objects: rows.length, spacing: field.info.checkpointSpacingSteps,
    times, fixtures: fixtureErr, random: { n: N, maxKm: rq(1), p99Km: rq(0.99), p90Km: rq(0.9), p50Km: rq(0.5), worst: worstRandom },
    statusMismatches: failures, records: { maxDirErrRad: maxAng, maxDmag: maxDm, compared: nCmp, lit: nLit },
    pick: picked === 0, pickAgreement: `${pickAgree}/${pickCases}`, stateOfErrKm: stateOfErr, excludeOk: excludedOk, statsStrict,
  };
}

// ------------------------------------------------------------------------------------------------ timing
async function timing(): Promise<unknown> {
  const dev = await device();
  const eph = await loadEphemeris();
  const tl = performance.now();
  const tables = await loadTables();
  const loadMs = performance.now() - tl;
  const chunk = Number(params.get('chunk') ?? 65536);
  const t0 = performance.now();
  const field = await SmallBodyField.create(dev, tables, eph, { chunkObjects: chunk, backgroundStepsPerUpdate: 0, checkpointBudgetBytes: 0 });
  const createMs = performance.now() - t0;
  log(`loaded in ${loadMs.toFixed(0)} ms; field of ${field.count} created in ${createMs.toFixed(0)} ms (${field.info.precision})`);
  const E0 = field.epochEt;
  const H = tables.coreHeader.forceModel.grid.baseStepS;
  const sun = eph.positionSSB(10, E0)!;
  const cam: Vec3 = [sun[0] + AU_KM, sun[1], sun[2]];
  const r: Record<string, number> = { loadMs, createMs, objects: field.count };
  r.shadeOnlyMs = await submit(dev, field, E0, cam);
  log(`shade only (et on the grid): ${r.shadeOnlyMs.toFixed(0)} ms`);
  r.shadeOnlyMs2 = await submit(dev, field, E0, cam);
  r.shadeWithDisplayStepMs = await submit(dev, field, E0 + 0.5 * 86400, cam);
  log(`shade with the display step: ${r.shadeWithDisplayStepMs.toFixed(0)} ms (cpu ${field.info.last.cpuMs.toFixed(1)} ms)`);
  r.oneStepPlusShadeMs = await submit(dev, field, E0 + H + 0.5 * 86400, cam);
  log(`one grid step + shade: ${r.oneStepPlusShadeMs.toFixed(0)} ms (${field.info.last.steps} steps, table intervals built ${field.info.last.tableIntervalsBuilt})`);
  r.twoStepsPlusShadeMs = await submit(dev, field, E0 + 3 * H + 0.5 * 86400, cam);
  log(`two grid steps + shade: ${r.twoStepsPlusShadeMs.toFixed(0)} ms (${field.info.last.steps} steps)`);
  r.stepMs = (r.twoStepsPlusShadeMs - r.shadeWithDisplayStepMs) / 2;
  r.chunk = chunk;
  return r;
}

// ------------------------------------------------------------------------------------------------ render
async function render(): Promise<unknown> {
  const { Renderer } = await import('../../render/renderer');
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const gpuCanvas = document.createElement('canvas');
  const renderer = await Renderer.create(gpuCanvas, { presentation: 'offscreen', hdr: 'auto' });
  renderer.resize(window.innerWidth, window.innerHeight, 1);
  const dev = (renderer as unknown as { device: GPUDevice }).device;
  const eph = await loadEphemeris();
  const tables = await loadTables();
  const light = await json<LightData>('/data/light.json');
  const starH = await json<BinaryTableHeader>('/data/stars/bright.json');
  const starT = new BinaryTable(starH, await bin(`/data/${resolveBinPath('stars/bright.json', starH.bin, null)}`));
  const scene = params.get('scene') ?? 'above';
  const level = (params.get('level') ?? 'best') as 'strict' | 'best' | 'complete';
  const allowed = (l: string) => (level === 'strict' ? ['measured', 'derived'] : ['measured', 'derived', 'estimated']).includes(l);
  if (params.get('nostars') !== '1') renderer.setStars(buildStarCatalog(starT, allowed as never).catalog);
  // syntint=1: DIAGNOSTIC false colour (orange) for synthetic objects.
  const synDiag: [number, number, number, number] | undefined = params.get('syntint') === '1' ? [1.9, 1.0, 0.12, 0.35] : undefined;
  const field = await SmallBodyField.create(dev, tables, eph, { chunkObjects: Number(params.get('chunk') ?? 262144), backgroundStepsPerUpdate: 0, syntheticDiagnosticColour: synDiag });
  renderer.setExtraPointSources(field.pointSources);
  const et = field.epochEt + Number(params.get('days') ?? 0) * 86400;
  const sunSSB = eph.positionSSB(10, et)!;
  const eps = (tables.coreHeader.forceModel.obliquityArcsec / 3600) * (Math.PI / 180);
  const north: Vec3 = [0, -Math.sin(eps), Math.cos(eps)]; // ecliptic north pole, ICRF
  const norm = (v: number[]) => { const l = Math.hypot(...v); return v.map((x) => x / l) as Vec3; };
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  let camH: Vec3;
  let fwd: Vec3;
  let up: Vec3;
  let fovDeg: number;
  let mode: 'eye' | 'enhanced';
  if (scene === 'inside') {
    // In the ecliptic at 2.7 au from the Sun (towards the vernal equinox), looking away from the Sun (look=out,
    // default: the Sun behind the observer) or along the orbital motion (look=along: the Sun 90 deg to the side).
    const r = Number(params.get('rau') ?? 2.7) * AU_KM;
    camH = [r, 0, 0];
    fwd = params.get('look') === 'along' ? norm(cross(north, [1, 0, 0])) : [1, 0, 0];
    up = north;
    fovDeg = Number(params.get('fov') ?? 60);
    mode = (params.get('mode2') ?? 'eye') as 'eye' | 'enhanced';
  } else if (scene === 'above-off') {
    // 3 au above the Sun, looking down at the belt beyond the Sun's side; the Sun is just above the frame.
    const h = Number(params.get('hau') ?? 3) * AU_KM;
    camH = [north[0] * h, north[1] * h, north[2] * h];
    const target = [2.6 * AU_KM, 0, 0];
    const aim = [0, 1, 2].map((j) => target[j] - camH[j]);
    fwd = norm(aim);
    up = norm([0, 1, 2].map((j) => -camH[j] / h - fwd[j] * (-camH[0] / h * fwd[0] - camH[1] / h * fwd[1] - camH[2] / h * fwd[2])));
    fovDeg = Number(params.get('fov') ?? 60);
    mode = (params.get('mode2') ?? 'enhanced') as 'eye' | 'enhanced';
  } else {
    const h = Number(params.get('hau') ?? 3) * AU_KM;
    camH = [north[0] * h, north[1] * h, north[2] * h];
    fwd = [-north[0], -north[1], -north[2]];
    up = [1, 0, 0];
    fovDeg = Number(params.get('fov') ?? 64);
    mode = (params.get('mode2') ?? 'enhanced') as 'eye' | 'enhanced';
  }
  const camSSB: Vec3 = [sunSSB[0] + camH[0], sunSSB[1] + camH[1], sunSSB[2] + camH[2]];
  const right = norm(cross(fwd, up));
  const u2 = cross(right, fwd);
  const orient = [right[0], u2[0], -fwd[0], right[1], u2[1], -fwd[1], right[2], u2[2], -fwd[2]] as [number, number, number, number, number, number, number, number, number];
  const sunL = light.sun;
  const snapshot = {
    et,
    camera: { orient, fovY: (fovDeg * Math.PI) / 180, width: 0, height: 0 },
    // nosun=1: DIAGNOSTIC - the Sun is left out of the scene (no disk, no glare veil) to show the belt's structure.
    sun: params.get('nosun') === '1' ? null : {
      pos: [-camH[0], -camH[1], -camH[2]] as Vec3, radius: sunL.radius.value as number,
      irradianceXYZS_1AU: sunL.irradianceXYZS_1AU.value as [number, number, number, number],
      limbDarkening: (sunL.limbDarkening.value as { coeffsXYZS: number[][] }).coeffsXYZS,
    },
    bodies: [],
    view: { mode, exposureBoostStops: Number(params.get('boost') ?? (mode === 'enhanced' ? 6 : 0)), overlays: { provenanceTint: false } },
    orbits: [],
  };
  const enc = dev.createCommandEncoder();
  field.update(enc, et, camSSB, { brightness: level });
  dev.queue.submit([enc.finish()]);
  const frames = Number(params.get('frames') ?? 1);
  for (let f = 0; f < frames; f++) renderer.render(snapshot as never);
  await renderer.settled();
  const px = await renderer.readPixels();
  canvas.width = px.width;
  canvas.height = px.height;
  canvas.getContext('2d')!.putImageData(new ImageData(px.data, px.width, px.height), 0, 0);
  // How many records are lit / how bright.
  const recs = await field.readRecords();
  let lit = 0, brightest = 0;
  for (let s = 0; s < field.count; s++) { const y = recs[8 * s + 4]; if (y > 0) { lit++; brightest = Math.max(brightest, y); } }
  let synLit = 0, synBrightest = 0;
  for (let j = 0; j < field.syntheticCount; j++) { const y = recs[8 * (field.count + j) + 4]; if (y > 0) { synLit++; synBrightest = Math.max(synBrightest, y); } }
  const s = renderer.stats;
  // Small bodies above the eye's point threshold (photopic Y vs the limiting magnitude's illuminance).
  const yLim = s.limitingMagnitude !== undefined ? luxFromMagnitude(s.limitingMagnitude) : Infinity;
  let above = 0, synAbove = 0;
  for (let q = 0; q < field.count; q++) if (recs[8 * q + 4] > yLim) above++;
  for (let j = 0; j < field.syntheticCount; j++) if (recs[8 * (field.count + j) + 4] > yLim) synAbove++;
  const hud = document.getElementById('hud')!;
  hud.textContent = [
    `REAL DATA · ${field.count.toLocaleString()} catalogued small bodies (${lit.toLocaleString()} with admitted brightness)${field.syntheticCount ? ` + ${synLit.toLocaleString()} synthetic drawn` : ''} · level ${level} · ${scene === 'inside' ? `inside the main belt, ${params.get('rau') ?? 2.7} au from the Sun, ${params.get('look') === 'along' ? 'looking along the orbital motion' : 'looking away from the Sun'}` : scene === 'above-off' ? `${params.get('hau') ?? 3} au above the Sun, looking down at the belt, Sun just outside the frame` : `${params.get('hau') ?? 3} au above the ecliptic, looking down at the Sun`}`,
    ...(params.get('nosun') === '1' ? [`DIAGNOSTIC: the Sun${params.get('nostars') === '1' ? ' and the stars are' : ' is'} left out of the scene (no disk, no glare), so the eye is dark-adapted: not what an observer would see`] : []),
    ...(synDiag ? ['DIAGNOSTIC FALSE COLOUR: synthetic objects orange, catalogued objects in their own colours'] : []),
    `${mode} mode${mode === 'enhanced' ? ` (+${snapshot.view.exposureBoostStops} stops)` : ''} · points drawn ${s.starsDrawn} (stars + small bodies) · limiting V ${s.limitingMagnitude?.toFixed(2)} · catalogued above it: ${above} (brightest V ${magnitudeFromLux(brightest).toFixed(1)})${field.syntheticCount ? ` · synthetic above it: ${synAbove} (brightest V ${synBrightest > 0 ? magnitudeFromLux(synBrightest).toFixed(1) : '-'})` : ''} · ${new Date((946728000 + et - 69.184) * 1000).toISOString().slice(0, 10)}`,
  ].join('\n');
  const res = {
    scene, mode, level, lit, brightestY: brightest, brightestV: magnitudeFromLux(brightest), smallBodiesAboveThreshold: above, pointsDrawn: s.starsDrawn,
    limitingV: s.limitingMagnitude, adaptation: s.adaptationLuminance, stats: field.stats,
    synthetic: { objects: field.syntheticCount, lit: synLit, brightestV: synBrightest > 0 ? magnitudeFromLux(synBrightest) : null, aboveThreshold: synAbove, falseColour: !!synDiag },
  };
  window.__frameReady = true;
  return res;
}

// ------------------------------------------------------------------------------------------------ unit
/** One Kepler drift and one kick acceleration per object on the GPU vs float64 on the CPU. */
async function unit(): Promise<unknown> {
  const { unitTestShader } = await import('./kernels');
  const { PlanetTable, SAMPLES } = await import('./planetTable');
  const { keplerDrift } = await import('../../core/smallbody');
  const { split64 } = await import('./wgslConst');
  const dev = await device();
  const eph = await loadEphemeris();
  const all = await loadTables();
  const cat = readCore(all.coreHeader, all.core);
  const model = all.coreHeader.forceModel;
  const H = model.grid.baseStepS;
  const N = Number(params.get('n') ?? 4000);
  const rand = rng(7);
  const cases: { st: Float64Array; dt: number; u: number }[] = [];
  while (cases.length < N) {
    const r = Math.floor(rand() * cat.count);
    const s = coreState(cat, r);
    if (!s) continue;
    const c = [model.scheme.drift[0], model.scheme.drift[1], 1, -model.scheme.drift[1], 0.013][cases.length % 5];
    // Round the state to double-single first so both sides start from the same numbers.
    const st = Float64Array.from(s, (v) => { const [a, b] = split64(v); return a + b; });
    const [dh, dl] = split64(c * H);
    cases.push({ st, dt: dh + dl, u: rand() * (SAMPLES - 1) });
  }
  const inp = new Float32Array(16 * N);
  cases.forEach((cs, i) => {
    const q = [0, 1, 2, 3, 4, 5].map((k) => split64(cs.st[k]));
    inp.set([q[0][0], q[1][0], q[2][0], q[3][0], q[4][0], q[5][0], q[0][1], q[1][1], q[2][1], q[3][1], q[4][1], q[5][1]], 12 * i);
    const [dh, dl] = split64(cs.dt);
    inp.set([dh, dl, cs.u, 0], 12 * N + 4 * i);
  });
  const table = new PlanetTable(model, eph, all.coreHeader.epochEt, all.coreHeader.window);
  const iv = table.index(0);
  table.fill(iv);
  const cfg = { model, samples: SAMPLES, cKmS: C_KM_S, auKm: AU_KM, photometry: null };
  const run = async (mode: number, fma: boolean): Promise<Float32Array> => {
    const pipe = dev.createComputePipeline({ layout: 'auto', compute: { module: dev.createShaderModule({ code: unitTestShader(cfg) }), entryPoint: 'main', constants: { USE_FMA: fma ? 1 : 0 } } });
    const mk = (size: number, usage: number) => dev.createBuffer({ size, usage });
    const u = mk(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    dev.queue.writeBuffer(u, 0, new Uint32Array([N, 0, mode, iv]));
    const sb = mk(inp.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    dev.queue.writeBuffer(sb, 0, inp);
    const ob = mk(48 * N, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    const tb = mk(table.data.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    dev.queue.writeBuffer(tb, 0, table.data.buffer as ArrayBuffer, table.data.byteOffset, table.data.byteLength);
    const nb = mk(48, GPUBufferUsage.STORAGE);
    const rb = mk(48 * N, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);
    const entries = [u, sb, ob, tb, nb].map((b, k) => ({ binding: k, resource: { buffer: b } }));
    const enc = dev.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipe);
    pass.setBindGroup(0, dev.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries }));
    pass.dispatchWorkgroups(Math.ceil(N / 64));
    pass.end();
    enc.copyBufferToBuffer(ob, 0, rb, 0, 48 * N);
    dev.queue.submit([enc.finish()]);
    await rb.mapAsync(GPUMapMode.READ);
    return new Float32Array(rb.getMappedRange().slice(0));
  };
  const res: Record<string, unknown> = {};
  for (const fma of [false, true]) {
    const o = await run(0, fma);
    const byC: Record<string, { dx: number; dv: number; dvRel: number; n: number }> = {};
    for (let i = 0; i < N; i++) {
      const cs = cases[i];
      const c = cs.st.slice();
      keplerDrift(c, 0, cs.dt, model.sun.gm);
      const g = [o[12 * i] + o[12 * i + 6], o[12 * i + 1] + o[12 * i + 7], o[12 * i + 2] + o[12 * i + 8], o[12 * i + 3] + o[12 * i + 9], o[12 * i + 4] + o[12 * i + 10], o[12 * i + 5] + o[12 * i + 11]];
      const key = `dt/H=${(cs.dt / H).toFixed(3)}`;
      const b = (byC[key] ??= { dx: 0, dv: 0, dvRel: 0, n: 0 });
      const dx = Math.hypot(g[0] - c[0], g[1] - c[1], g[2] - c[2]);
      const dv = Math.hypot(g[3] - c[3], g[4] - c[4], g[5] - c[5]);
      const dvDrift = Math.hypot(c[3] - cs.st[3], c[4] - cs.st[4], c[5] - cs.st[5]);
      if (dv / dvDrift > b.dvRel) {
        const r = Math.hypot(cs.st[0], cs.st[1], cs.st[2]);
        const v2 = cs.st[3] ** 2 + cs.st[4] ** 2 + cs.st[5] ** 2;
        (b as Record<string, unknown>).worst = { rAu: r / AU_KM, v: Math.sqrt(v2), aAu: 1 / (2 / r - v2 / model.sun.gm) / AU_KM, dvDrift, rdotv: (cs.st[0] * cs.st[3] + cs.st[1] * cs.st[4] + cs.st[2] * cs.st[5]) / r };
      }
      b.dx = Math.max(b.dx, dx); b.dv = Math.max(b.dv, dv); b.dvRel = Math.max(b.dvRel, dv / dvDrift); b.n++;
    }
    res[`drift${fma ? 'Fma' : 'Dekker'}`] = byC;
    log(`drift (${fma ? 'fma' : 'Dekker'}): ${JSON.stringify(byC)}`);
  }
  // Kick accelerations.
  const o = await run(1, false);
  const prop = new SmallBodyPropagator(model, eph);
  const rp = new Float64Array(3 * model.perturbers.length);
  const a = new Float64Array(3);
  let worstRel = 0, worstAbs = 0;
  for (let i = 0; i < N; i++) {
    const cs = cases[i];
    const t = all.coreHeader.epochEt + (cs.u / (SAMPLES - 1)) * H;
    prop.perturberPositions(t, rp);
    prop.acceleration(cs.st, 0, rp, null, a);
    const d = Math.hypot(o[12 * i] - a[0], o[12 * i + 1] - a[1], o[12 * i + 2] - a[2]);
    worstAbs = Math.max(worstAbs, d);
    worstRel = Math.max(worstRel, d / Math.hypot(a[0], a[1], a[2]));
  }
  log(`kick acceleration: max |da| ${worstAbs.toExponential(2)} km/s^2, max relative ${worstRel.toExponential(2)}`);
  res.kick = { maxAbs: worstAbs, maxRel: worstRel };
  return res;
}

// ------------------------------------------------------------------------------------------------ synthetic
/** GPU records of the synthetic layer vs float64 fixed heliocentric / integrated moon positions (core/smallbodySynthetic) and CPU photometry. */
async function synthetic(): Promise<unknown> {
  const dev = await device();
  const eph = await loadEphemeris();
  const all = await loadTables();
  if (!all.synthetic) throw new Error('no synthetic layer (build the pipeline stage synthetic)');
  // A small catalogue subset keeps the test fast; the synthetic layer is complete.
  const tables = params.get('full') === '1' ? all : subsetTables(all, Array.from({ length: 2000 }, (_, k) => k * 700));
  const t0 = performance.now();
  const field = await SmallBodyField.create(dev, tables, eph, { backgroundStepsPerUpdate: 0 });
  const createMs = performance.now() - t0;
  const N = field.count, S = field.syntheticCount;
  log(`field: ${N} catalogue + ${S} synthetic objects, created in ${createMs.toFixed(0)} ms; synthetic ${JSON.stringify(field.info.synthetic)}`);
  if (!S) throw new Error(`synthetic layer not enabled: ${field.info.synthetic.reason}`);
  const syn = readSynthetic(all.synthetic.header, all.synthetic.objects);
  const phot = tables.photometry!;
  const sunXYZS = phot.sunIrradianceXYZS1AU.value!;
  const cls = (tables.coreHeader.colorClasses?.classes ?? []).map((c) => c.xyzsPerUnitPV.map((v, k) => v / sunXYZS[k]));
  const G = all.synthetic.header.slopeParameterG!.value;
  const rand = rng(99);
  // 20 000 random objects, plus every object of the planet-centred populations (synthetic irregular moons)
  const cen = centerStateFrom(eph, 10);
  const moonRows = all.synthetic.header.populations.filter((p) => p.center).flatMap((p) => Array.from({ length: p.objects }, (_, k) => p.firstObject + k));
  const isMoon = new Set(moonRows);
  const sample = [...Array.from({ length: 20000 }, () => Math.floor(rand() * S)), ...moonRows];
  const DAY = 86400;
  const res: Record<string, unknown>[] = [];
  const win = tables.coreHeader.window;
  for (const dd of (params.get('days') ?? '0,0.37,200.6,-547.2,547.9').split(',').map(Number)) {
    const et = Math.min(win.endEt - 60, Math.max(win.startEt + 60, field.epochEt + dd * DAY));
    const sun = eph.positionSSB(10, et)!;
    // syncam=<naif id>: the camera 0.2 au from that body (e.g. 5: next to Jupiter, among its synthetic irregular moons)
    const near = params.get('syncam') ? eph.positionSSB(Number(params.get('syncam')), et) : null;
    const cam: Vec3 = near ? [near[0] + 0.15 * AU_KM, near[1] + 0.12 * AU_KM, near[2] + 0.05 * AU_KM] : [sun[0] + 0.4 * AU_KM, sun[1] + 2.2 * AU_KM, sun[2] - 0.1 * AU_KM];
    const ms = await submit(dev, field, et, cam, 'complete');
    const recs = await field.readRecords();
    const u32 = new Uint32Array(recs.buffer);
    const sa = eph.positionSSB(10, et - 1)!, sb = eph.positionSSB(10, et + 1)!;
    const sv = [0, 1, 2].map((j) => (sb[j] - sa[j]) / 2);
    let maxAng = 0, maxKm = 0, maxDm = 0, maxDm30 = 0, maxDm30Alpha120 = 0, maxDmMoon = 0, idxOk = 0, lit = 0;
    const angs: number[] = [];
    for (const j of sample) {
      const o = 8 * (N + j);
      if (u32[o + 7] === N + j) idxOk++;
      const st = syntheticState(syn, j, et, cen)!;
      const rel0 = [0, 1, 2].map((k) => st.pos[k] + sun[k] - cam[k]);
      const tau = Math.hypot(...rel0) / C_KM_S;
      const rel = [0, 1, 2].map((k) => rel0[k] - tau * (st.vel[k] + sv[k]));
      const xo = [0, 1, 2].map((k) => st.pos[k] - tau * st.vel[k]);
      const dist = Math.hypot(...rel);
      const ang = Math.hypot(rel[0] / dist - recs[o], rel[1] / dist - recs[o + 1], rel[2] / dist - recs[o + 2]);
      angs.push(ang);
      maxAng = Math.max(maxAng, ang);
      maxKm = Math.max(maxKm, ang * dist);
      const r = Math.hypot(...xo);
      const cr = [xo[1] * rel[2] - xo[2] * rel[1], xo[2] * rel[0] - xo[0] * rel[2], xo[0] * rel[1] - xo[1] * rel[0]];
      const alpha = Math.atan2(Math.hypot(...cr), xo[0] * rel[0] + xo[1] * rel[1] + xo[2] * rel[2]);
      const m = syn.table.get('H', j) + 5 * Math.log10((r / AU_KM) * (dist / AU_KM)) - 2.5 * Math.log10(hgPhi(phot, alpha, G));
      const k = syn.table.has('colorClass') ? syn.table.get('colorClass', j) : 255;
      const E = magnitudeToXYZS(phot, m, cls[k] ?? [1, 1, 1, 1]);
      if (recs[o + 4] > 0) {
        lit++;
        const dm = Math.abs(-2.5 * Math.log10(recs[o + 4] / E[1]));
        maxDm = Math.max(maxDm, dm);
        if (m < 30) maxDm30 = Math.max(maxDm30, dm);
        if (m < 30 && alpha < 2.1) maxDm30Alpha120 = Math.max(maxDm30Alpha120, dm);
        if (isMoon.has(j)) maxDmMoon = Math.max(maxDmMoon, dm);
      }
    }
    if (params.get('debug') === '1') {
      // worst few: CPU with / without light time, elements
      const worst = sample.map((j) => {
        const o = 8 * (N + j);
        const st = syntheticState(syn, j, et, cen)!;
        const rel0 = [0, 1, 2].map((k) => st.pos[k] + sun[k] - cam[k]);
        const d0 = Math.hypot(...rel0);
        const tau = d0 / C_KM_S;
        const rel = [0, 1, 2].map((k) => rel0[k] - tau * (st.vel[k] + sv[k]));
        const d1 = Math.hypot(...rel);
        const a1 = Math.hypot(rel[0] / d1 - recs[o], rel[1] / d1 - recs[o + 1], rel[2] / d1 - recs[o + 2]);
        const a0 = Math.hypot(rel0[0] / d0 - recs[o], rel0[1] / d0 - recs[o + 1], rel0[2] / d0 - recs[o + 2]);
        return { j, a1, a0, d1, el: [0, 1, 2, 3, 4, 5, 6].map((c) => syn.table.get(['a', 'e', 'i', 'node', 'peri', 'M', 'H'][c], j)), pop: syn.table.get('pop', j), gpu: [recs[o], recs[o + 1], recs[o + 2]], cpu: rel.map((v) => v / d1) };
      }).sort((x, y) => y.a1 - x.a1).slice(0, 4);
      log(`worst: ${JSON.stringify(worst)}`);
      const wph = sample.map((j) => {
        const o = 8 * (N + j);
        const st = syntheticState(syn, j, et, cen)!;
        const rel0 = [0, 1, 2].map((k) => st.pos[k] + sun[k] - cam[k]);
        const tau = Math.hypot(...rel0) / C_KM_S;
        const rel = [0, 1, 2].map((k) => rel0[k] - tau * (st.vel[k] + sv[k]));
        const xo = [0, 1, 2].map((k) => st.pos[k] - tau * st.vel[k]);
        const dist = Math.hypot(...rel);
        const r = Math.hypot(...xo);
        const cr = [xo[1] * rel[2] - xo[2] * rel[1], xo[2] * rel[0] - xo[0] * rel[2], xo[0] * rel[1] - xo[1] * rel[0]];
        const alpha = Math.atan2(Math.hypot(...cr), xo[0] * rel[0] + xo[1] * rel[1] + xo[2] * rel[2]);
        const m = syn.table.get('H', j) + 5 * Math.log10((r / AU_KM) * (dist / AU_KM)) - 2.5 * Math.log10(hgPhi(phot, alpha, G));
        const k = syn.table.get('colorClass', j);
        const E = magnitudeToXYZS(phot, m, cls[k] ?? [1, 1, 1, 1]);
        return { j, k, cls: cls[k], dm: -2.5 * Math.log10(recs[o + 4] / E[1]), alphaDeg: alpha * 180 / Math.PI, rAu: r / AU_KM, dAu: dist / AU_KM, m, gpuY: recs[o + 4], cpuY: E[1] };
      }).filter((x) => x.m < 30 && Number.isFinite(x.dm)).sort((x, y) => Math.abs(y.dm) - Math.abs(x.dm)).slice(0, 4);
      log(`worst photometry: ${JSON.stringify(wph)}`);
      const pops = new Map<number, number[]>();
      sample.forEach((j, q) => { const pp = syn.table.get('pop', j); if (!pops.has(pp)) pops.set(pp, []); pops.get(pp)!.push(angs[q]); });
      log(`by pop (unsorted angs): ${JSON.stringify([...pops].map(([k, v]) => [k, v.length, v.sort((a, b) => a - b)[v.length >> 1]]))}`);
    }
    const moonAngs = sample.map((j, q) => (isMoon.has(j) ? angs[q] : -1)).filter((x) => x >= 0).sort((a, b) => a - b);
    angs.sort((a, b) => a - b);
    const r = { days: dd, gpuMs: Math.round(ms), sampled: sample.length, indexOk: idxOk, lit, maxDirErrRad: maxAng, p50DirErrRad: angs[angs.length >> 1], p99DirErrRad: angs[Math.floor(0.99 * angs.length)], maxPosErrKm: maxKm, maxDmagVsCpuBrighterThanV30: maxDm30, maxDmagVsCpuAll: maxDm,
      maxDmagVsCpuBrighterThanV30PhaseBelow120: maxDm30Alpha120,
      moons: moonAngs.length ? { n: moonAngs.length, p50DirErrRad: moonAngs[moonAngs.length >> 1], maxDirErrRad: moonAngs[moonAngs.length - 1], maxDmagVsCpu: maxDmMoon } : null };
    res.push(r);
    log(`t = ${dd} d: GPU ${ms.toFixed(0)} ms; direction max ${maxAng.toExponential(2)} rad (${maxKm.toFixed(0)} km at the object), p99 ${r.p99DirErrRad.toExponential(2)}, p50 ${angs[angs.length >> 1].toExponential(2)}; photometry max ${maxDm30.toFixed(4)} mag (V < 30; ${maxDm.toFixed(2)} for all, the faintest being V ~ 36 where the device's exp2 is coarse) (phase < 120°: ${maxDm30Alpha120.toFixed(4)}) over ${lit} lit; index ok ${idxOk}/${sample.length}${r.moons ? `; irregular moons (${r.moons.n}): direction p50 ${r.moons.p50DirErrRad.toExponential(2)}, max ${r.moons.maxDirErrRad.toExponential(2)} rad, photometry max ${r.moons.maxDmagVsCpu.toFixed(4)} mag` : ''}`);
  }
  // Level gating: below complete every synthetic record is zero (not drawn, not pickable); counts arrive later.
  const et = field.epochEt;
  const sun = eph.positionSSB(10, et)!;
  const cam: Vec3 = [sun[0] + 0.4 * AU_KM, sun[1] + 2.2 * AU_KM, sun[2] - 0.1 * AU_KM];
  const onMs = await submit(dev, field, et, cam, 'complete');
  const recsOn = await field.readRecords();
  const j0 = sample[0];
  const dir0: Vec3 = [recsOn[8 * (N + j0)], recsOn[8 * (N + j0) + 1], recsOn[8 * (N + j0) + 2]];
  const pickedOn = await field.pick(dir0, 2e-6);
  await submit(dev, field, et, cam, 'complete');
  await new Promise((r) => setTimeout(r, 50));
  const statsComplete = field.stats;
  const offMs = await submit(dev, field, et, cam, 'best');
  const recsOff = await field.readRecords();
  let nonZero = 0;
  for (let j = 0; j < S; j++) if (recsOff[8 * (N + j)] !== 0 || recsOff[8 * (N + j) + 4] !== 0) nonZero++;
  const pickedOff = await field.pick(dir0, 2e-6);
  await submit(dev, field, et, cam, 'best');
  await new Promise((r) => setTimeout(r, 50));
  const statsBest = field.stats;
  const so = field.stateOf(N + j0, et + 10 * DAY);
  const cpu = syntheticState(syn, j0, et + 10 * DAY, cen);
  log(`gating: at complete pick -> ${pickedOn} (want ${N + j0}), stats ${JSON.stringify(statsComplete)}; at best ${nonZero} non-zero synthetic records, pick -> ${pickedOff}, stats ${JSON.stringify(statsBest)}; shade ${onMs.toFixed(0)} ms (complete) vs ${offMs.toFixed(0)} ms (best)`);
  return {
    catalogue: N, synthetic: S, createMs, info: field.info.synthetic, times: res,
    gating: { pickAtComplete: pickedOn, want: N + j0, nonZeroAtBest: nonZero, pickAtBest: pickedOff, statsComplete, statsBest, shadeMsComplete: onMs, shadeMsBest: offMs },
    stateOfMatchesCpu: !!so && !!cpu && so.pos.every((v, k) => v === cpu.pos[k]),
  };
}

/** Compact moon-only device harness. Same field code, eight workgroups; avoids timing 3 million
 * unrelated fixed synthetic ellipses. Reference is the independently generated, pinned DOP853 fixture. */
async function moonAccuracy(): Promise<unknown> {
  const dev = await device(), eph = await loadEphemeris(), all = await loadTables();
  if (!all.synthetic) throw new Error('rebuild synthetic');
  const old = all.synthetic.header;
  const populations = old.populations.filter(p=>p.center && p.objects);
  const originalRows = populations.flatMap(p=>Array.from({length:p.objects},(_,k)=>p.firstObject+k));
  const packed = new Uint8Array(originalRows.length*old.stride), raw = new Uint8Array(all.synthetic.objects);
  originalRows.forEach((row,k)=>packed.set(raw.subarray(row*old.stride,(row+1)*old.stride),k*old.stride));
  let first = 0;
  const compact = populations.map(p=>{const q={...p,firstObject:first};first+=p.objects;return q;});
  const tables = subsetTables(all,[0]);
  tables.synthetic = {objects:packed.buffer,header:{...old,count:originalRows.length,populations:compact,
    counts:{...old.counts,synthetic:originalRows.length}}};
  const field = await SmallBodyField.create(dev,tables,eph,{backgroundStepsPerUpdate:0,debug:true});
  const syn = readSynthetic(tables.synthetic.header,tables.synthetic.objects), center = centerStateFrom(eph,10);
  const reference = await json<{ epochEt:number;objects:{initial:number[];edges:{et:number;state:number[]}[]}[] }>('/tests/fixtures/synthetic_moon_all_reference.json');
  if (reference.epochEt !== syn.epochEt || reference.objects.length !== syn.count) throw new Error('reference/build epoch or count mismatch: regenerate reference, do not patch tolerance');
  const DAY = 86400;
  const epochs = [syn.epochEt,tables.coreHeader.window.endEt,syn.epochEt+15*DAY,tables.coreHeader.window.startEt,syn.epochEt-30*DAY,tables.coreHeader.window.endEt,syn.epochEt];
  const query = dev.features.has('timestamp-query') ? dev.createQuerySet({type:'timestamp',count:2}) : null;
  const resolved = query ? dev.createBuffer({size:16,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC}) : null;
  const read = query ? dev.createBuffer({size:16,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}) : null;
  const timedSubmit = async (et:number,cam:Vec3,level:'best'|'complete') => {
    const enc=dev.createCommandEncoder(),start=performance.now();
    if(query) enc.beginComputePass({timestampWrites:{querySet:query,beginningOfPassWriteIndex:0}}).end();
    field.update(enc,et,cam,{brightness:level});
    if(query) {
      enc.beginComputePass({timestampWrites:{querySet:query,endOfPassWriteIndex:1}}).end();
      enc.resolveQuerySet(query,0,2,resolved!,0);enc.copyBufferToBuffer(resolved!,0,read!,0,16);
    }
    const encodingWallMs=performance.now()-start,t=performance.now();
    dev.queue.submit([enc.finish()]);await dev.queue.onSubmittedWorkDone();
    const completionWallMs=performance.now()-t;
    let timestampGpuMs:number|null=null;
    if(query) {await read!.mapAsync(GPUMapMode.READ);const a=new BigUint64Array(read!.getMappedRange());timestampGpuMs=Number(a[1]-a[0])/1e6;read!.unmap();}
    return {timestampGpuMs,completionWallMs,encodingWallMs};
  };
  const res:unknown[] = [];
  for (const et of epochs) {
    const host = Number(params.get('syncam')??5), p = eph.positionSSB(host*100+99,et)!, sun = eph.positionSSB(10,et)!;
    const camera = params.get('camera')??'earth';
    const radius = all.coreHeader.forceModel.perturbers.find(p=>p.naifId===host)!.radius;
    const closeRow = compact.find(p=>p.center!.naifId===host)!.firstObject;
    const initialTarget = field.stateOf(field.count+closeRow,et)!;
    const cam:Vec3 = camera==='planet' ? [...p] : camera==='near' ? [p[0],p[1],p[2]+10*radius] : camera==='close'
      ? [initialTarget.pos[0]+sun[0]+10,initialTarget.pos[1]+sun[1],initialTarget.pos[2]+sun[2]] : [...eph.positionSSB(399,et)!];
    const timing = await timedSubmit(et,cam,'complete');
    const coldBatches = field.moonBatchInfo;
    const debug = await field.readMoonDebugStates(), records = await field.readRecords();
    let maxCpuKm=0,maxReferenceKm=0,maxVelocityKmS=0,maxDirRad=0,maxSelectionKm=0,maxInitialKm=0;
    for (let k=0;k<debug.rows.length;k++) {
      const j=debug.rows[k], st=syntheticState(syn,j,et,center)!, cid=compact.find(p=>p.code===syn.table.get('pop',j))!.center!.naifId, cs=center(cid,et)!;
      const relative=[...st.pos.map((v,c)=>v-cs.pos[c]),...st.vel.map((v,c)=>v-cs.vel[c])];
      const got=Array.from(debug.states.subarray(k*6,k*6+6));
      if (!got.every(Number.isFinite)) throw new Error(`unknown GPU state at moon ${originalRows[j]}, ET ${et}`);
      maxCpuKm=Math.max(maxCpuKm,Math.hypot(...got.slice(0,3).map((v,c)=>v-relative[c])));
      maxVelocityKmS=Math.max(maxVelocityKmS,Math.hypot(...got.slice(3).map((v,c)=>v-relative[c+3])));
      const initial=syntheticState(syn,j,syn.epochEt,center)!, c0=center(cid,syn.epochEt)!;
      maxInitialKm=Math.max(maxInitialKm,Math.hypot(...initial.pos.map((v,c)=>v-c0.pos[c]-reference.objects[j].initial[c])));
      const edge=reference.objects[j].edges.find(e=>e.et===et);
      if(edge) maxReferenceKm=Math.max(maxReferenceKm,Math.hypot(...got.slice(0,3).map((v,c)=>v-edge.state[c])));
      const selected=field.stateOf(field.count+j,et)!;
      maxSelectionKm=Math.max(maxSelectionKm,Math.hypot(...selected.pos.map((v,c)=>v-st.pos[c])));
      const ssba=eph.positionSSB(10,et-1)!,ssbb=eph.positionSSB(10,et+1)!;
      const rel=st.pos.map((v,c)=>v+sun[c]-cam[c]), tau=Math.hypot(...rel)/C_KM_S;
      const apparent=rel.map((v,c)=>v-tau*(st.vel[c]+(ssbb[c]-ssba[c])/2)),dist=Math.hypot(...apparent);
      maxDirRad=Math.max(maxDirRad,Math.hypot(...apparent.map((v,c)=>v/dist-records[(field.count+j)*8+c])));
    }
    if(et===syn.epochEt && maxCpuKm>1e-6) throw new Error('GPU epoch initialization changed');
    if(maxInitialKm>1e-5) throw new Error('reference initial realization differs from product');
    if(maxCpuKm>2 || maxReferenceKm>2.1 || maxSelectionKm!==0) throw new Error(`moon numerical/selection budget exceeded: ${JSON.stringify({maxCpuKm,maxReferenceKm,maxSelectionKm})}`);
    const row=field.count, rec=records.slice(row*8,row*8+3),picked=await field.pick([rec[0],rec[1],rec[2]],1e-7);
    if(picked!==row) throw new Error(`GPU picking disagrees: ${picked} vs ${row}`);
    const repeats=Number(params.get('repeats')??16),warm:unknown[]=[],baseline:unknown[]=[];
    for(let n=0;n<repeats;n++) warm.push(await timedSubmit(et,cam,'complete'));
    for(let n=0;n<repeats;n++) baseline.push(await timedSubmit(et,cam,'best'));
    res.push({et,camera,timing,warmComplete:warm,baselineBest:baseline,maxCpuKm,maxReferenceKm,maxVelocityKmS,maxDirRad,maxSelectionKm,maxInitialKm,pick:picked,want:row,batches:coldBatches,warmBatches:field.moonBatchInfo});
  }
  await submit(dev,field,syn.epochEt,eph.positionSSB(399,syn.epochEt)!,'best');
  const off=await field.readRecords();
  if(off.slice(field.count*8).some(v=>v!==0)) throw new Error('synthetic records survive below Complete');
  field.destroy();query?.destroy();resolved?.destroy();read?.destroy(); return {precision:field.info.precision,moons:originalRows.length,originalRows,results:res};
}

async function main(): Promise<void> {
  const mode = params.get('mode') ?? 'accuracy';
  const r = mode === 'moon-accuracy' ? await moonAccuracy() : mode === 'timing' ? await timing() : mode === 'render' ? await render() : mode === 'unit' ? await unit() : mode === 'synthetic' ? await synthetic()
    : mode === 'comet' ? await cometGpuFlux() : await accuracy();
  window.__sbResult = r;
}

main().catch((e) => {
  console.error(e);
  window.__frameError = String((e as Error)?.stack ?? e);
});
