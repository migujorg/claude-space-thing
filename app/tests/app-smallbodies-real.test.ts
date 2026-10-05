// Small bodies on the real products (skips, loudly, when app/public/data/smallbodies is not built): table loading
// through the integrity-checked DataLoader, the real headers' columns and flags, the app's CPU positions against
// the pipeline's integrator and JPL Horizons (the build record the smallbodies stage wrote with these products:
// verification/smallbodies.json), per-level counts against the header statistics, and inspector rows.

import { beforeAll, describe, expect, it } from 'vitest';
import { SmallBodies } from '../src/app/smallbodies';
import { DataLoader } from '../src/data/load';
import type { CometListProduct, Manifest, SmallBodyCoreHeader } from '../src/data/schema';
import { discoverSmallBodies, loadSmallBodyTables, type SmallBodyTables } from '../src/data/smallbodies';
import { smallBodyFacts, smallBodyLegend } from '../src/ui/smallBodyInspect';
import { DATA_DIR, buildRecord, loadEphemerisSet, notCompared, type SmallBodyRecord } from './core-data';
import { apparentPosition } from '../src/core/lighttime';

interface Fs { existsSync(p: string): boolean; readFileSync(p: string): Uint8Array; readFileSync(p: string, e: 'utf8'): string }
const fs: Fs = await import(/* @vite-ignore */ 'node:fs' as string);

const built = fs.existsSync(DATA_DIR + 'smallbodies/core.json') && fs.existsSync(DATA_DIR + 'manifest.json');
if (!built) console.warn('[small-body tests] smallbodies/* not built; skipping the real-data tests');
const eph = built ? loadEphemerisSet() : null;

// What the pipeline computed for this build (null with the reason when the build has no record).
const rec = buildRecord<SmallBodyRecord>('verification/smallbodies.json', 'smallbodies');

/** The showcase check needs an eligible comet; absence is a named skip, never a substitute. */
function showcasePeak(list: CometListProduct, skip: (reason: string) => never) {
  const show = list.showcase;
  if (show === null) skip('No comet qualifies as the showcase in this build window');
  return list.notable.find((n) => n.row === show.row)!;
}

describe.skipIf(!built || !eph)('small bodies on the real products', () => {
  let tables: SmallBodyTables;
  let loadMs = 0;
  let loader: DataLoader;

  beforeAll(async () => {
    loader = new DataLoader({
      fetch: async (url) => {
        const path = DATA_DIR + url;
        if (!fs.existsSync(path)) return new Response('not found', { status: 404 });
        return new Response(fs.readFileSync(path) as unknown as BodyInit, { headers: { 'content-type': 'application/octet-stream' } });
      },
      base: '',
      verifyHashes: true,
    });
    loader.manifest = JSON.parse(fs.readFileSync(DATA_DIR + 'manifest.json', 'utf8')) as Manifest;
    const p = discoverSmallBodies(loader.manifest)!;
    let lastProgress = 0;
    const t0 = performance.now();
    tables = (await loadSmallBodyTables(loader, p, (got) => (lastProgress = got)))!;
    loadMs = performance.now() - t0;
    expect(lastProgress).toBeGreaterThan(0);
  }, 120_000);

  it('loads every table through the loader, sha256-verified, and parses the real headers', () => {
    expect(tables).not.toBeNull();
    const h = tables.core.header;
    expect(tables.count).toBe(h.count);
    expect(tables.physical?.table.count).toBe(tables.physical?.header.count);
    expect(tables.cometRow.size).toBe(tables.comets?.header.count);
    expect(tables.nongravRow.size).toBe(tables.nongrav?.header.count);
    expect(tables.namesHeader?.count).toBe(h.count);
    for (const f of ['smallbodies/core.bin', 'smallbodies/physical.bin', 'smallbodies/comets.bin', 'smallbodies/nongrav.bin']) {
      expect(loader.report.products.find((r) => r.path === f), f).toMatchObject({ status: 'ok', hash: 'verified' });
    }
    // Every documented column names label/source fields that exist.
    for (const t of [tables.core, tables.physical!, tables.comets!]) {
      for (const [c, d] of Object.entries(t.header.columns ?? {})) {
        expect(t.table.has(c), c).toBe(true);
        if (d.label) expect(t.table.has(d.label), `${c}.label ${d.label}`).toBe(true);
        if (d.source) expect(t.table.has(d.source), `${c}.source ${d.source}`).toBe(true);
      }
    }
    console.log(`small-body tables: ${tables.count} objects loaded + verified in ${loadMs.toFixed(0)} ms`);
  });

  if (!rec.record) {
    notCompared('the app\'s CPU positions of the verification objects against the pipeline\'s integrator and JPL Horizons', rec.why);
  } else {
    const record = rec.record;
    it('the build record names the products of this build (sha256 as in the manifest)', () => {
      expect(rec.unbound).toEqual([]);
      expect(record.epochEt).toBe(tables.core.header.epochEt);
    });

    it('reproduces the pipeline integrator at the verification epochs and stays within tolerance of JPL Horizons (CPU fallback, shuffled queries)', () => {
      const sb = new SmallBodies(tables, eph!);
      let worst = 0;
      let n = 0;
      const lines: string[] = [];
      const t0 = performance.now();
      expect(record.objects.length).toBeGreaterThan(0);
      for (const o of record.objects) {
        const order = o.epochs.map((t, k) => ({ t, k })).sort((a, b) => ((a.k * 7919) % 55) - ((b.k * 7919) % 55));
        let worstHz = 0;
        for (const { t, k } of order) {
          const s = sb.cpu.stateOf(o.coreRow, t);
          expect(s, `${o.label} at ${t}`).not.toBeNull();
          const py = o.python[k], hz = o.horizons[k];
          worst = Math.max(worst, Math.hypot(s!.pos[0] - py[0], s!.pos[1] - py[1], s!.pos[2] - py[2]));
          worstHz = Math.max(worstHz, Math.hypot(s!.pos[0] - hz[0], s!.pos[1] - hz[1], s!.pos[2] - hz[2]));
          n++;
        }
        lines.push(`${o.label.padEnd(30)} vs Horizons ${worstHz.toFixed(3).padStart(9)} km (tol ${o.toleranceKm})`);
        expect(worstHz, o.label).toBeLessThanOrEqual(o.toleranceKm);
      }
      const ms = performance.now() - t0;
      console.log(`small-body CPU positions: ${n} states of ${record.objects.length} objects in ${ms.toFixed(0)} ms; worst vs pipeline ${worst.toExponential(2)} km\n${lines.join('\n')}`);
      expect(worst).toBeLessThan(0.01);
    }, 120_000);
  }

  it('counts per level partition the catalogue and match the header statistics', () => {
    const sb = new SmallBodies(tables, eph!);
    const stats = (tables.core.header as SmallBodyCoreHeader).statistics.labels as Record<string, Record<string, number>>;
    const t0 = performance.now();
    const best = sb.labelCounts('best');
    const ms = performance.now() - t0;
    const strict = sb.labelCounts('strict');
    for (const c of [best, strict]) expect(c.drawn + c.withheld + c.noPosition).toBe(tables.count);
    expect(best.noPosition).toBe(stats.position.unknown);
    expect(strict.drawn).toBeLessThan(best.drawn);
    console.log(`small-body counts (by labels, ${ms.toFixed(0)} ms): best ${best.drawn} drawn / ${best.withheld} withheld; strict ${strict.drawn} / ${strict.withheld}; ${best.noPosition} without position`);
  });

  it('close-approach candidates for the event finder: every flagged object, with the header threshold', () => {
    const sb = new SmallBodies(tables, eph!);
    const c = sb.closeApproachCandidates()!;
    const st = (tables.core.header as SmallBodyCoreHeader).statistics.propagation as { closeApproachesInWindow: { objects: number; maxDistanceAu: number } };
    expect(c.candidates.length).toBe(st.closeApproachesInWindow.objects);
    expect(c.maxKm / 149597870.7).toBeCloseTo(st.closeApproachesInWindow.maxDistanceAu, 12);
    for (const x of c.candidates.slice(0, 20)) {
      expect(sb.hasFlag(x.row, 'closeApproachInWindow')).toBe(true);
      expect(x.state).toHaveLength(6);
    }
  });

  it('shows every attribute of Ceres with labels and sources, and a sphere of its measured diameter', () => {
    const sb = new SmallBodies(tables, eph!);
    // (1) Ceres is SPK-ID 20000001: its row is the line of names.txt that starts with it.
    const names = new TextDecoder().decode(fs.readFileSync(DATA_DIR + 'smallbodies/names.txt')).split('\n');
    const row = names.findIndex((l) => l.startsWith('20000001\t'));
    expect(row).toBeGreaterThanOrEqual(0);
    const f = smallBodyFacts(tables, row, 'best');
    const keys = f.rows.map((r) => r.key);
    for (const k of ['sb:orbit', 'sb:H', 'sb:G', 'sb:diameter', 'sb:albedo', 'sb:rotation', 'sb:phase', 'sb:spin']) expect(keys, k).toContain(k);
    for (const r of f.rows) {
      expect(r.label, r.key).not.toBe('unknown');
      expect(r.sources.length, `${r.key} sources`).toBeGreaterThan(0);
    }
    expect(f.rows.find((r) => r.key === 'sb:diameter')!.label).toBe('measured');
    expect(f.flags.map((x) => x.name)).toContain('numbered');
    expect(f.orbitClass?.code).toBe('MBA');
    const b = sb.pseudoBody(row);
    expect(b.radii.label).toBe('estimated');
    expect(b.radii.value![0]).toBeGreaterThan(0);
    expect(sb.summary(row)).toMatchObject({ comet: false, positionKnown: true });
    expect(smallBodyLegend(tables).length).toBeGreaterThan(3);
    console.log(f.rows.map((r) => `${r.name}: ${r.value} [${r.label}; ${r.sources.join(', ')}]`).join('\n'));
  });

  it('comets: the showcase comet is drawn with coma and tails from Earth at its peak; per-frame cost', (ctx) => {
    const sb = new SmallBodies(tables, eph!);
    if (!sb.comets || !tables.cometList) {
      return ctx.skip('comets/* not built: no showcase comet shell check');
    }
    const peak = showcasePeak(tables.cometList, ctx.skip);
    const et = peak.peakEt;
    const earth = eph!.positionSSB(399, et)!;
    const pix = (60 * Math.PI) / 180 / 720;
    const core = { apparentPosition };
    const t0 = performance.now();
    const first = sb.comets.frame([], earth, et, core, 'best', pix);
    const t1 = performance.now();
    const again = sb.comets.frame([], earth, et, core, 'best', pix);
    const t2 = performance.now();
    expect(first.rows).toContain(peak.row);
    expect(again.rows).toEqual(first.rows);
    const sc = first.comets.find((c) => c.id === -(peak.row + 1))!;
    // its apparent distance and the M1/K1 magnitude match the list (Horizons T-mag, see comets.test.ts)
    expect(Math.hypot(...sc.rel) / 149597870.7).toBeCloseTo(peak.deltaAu, 2);
    // nothing is drawn extended at Strict (the coma model is estimated)
    expect(sb.comets.frame([], earth, et, core, 'strict', pix).comets.length).toBe(0);
    console.log(`comets from Earth on ${new Date((946728000 + et - 69.184) * 1000).toISOString().slice(0, 10)}: extended ${first.comets.map((c) => c.name).join(', ')}; first frame ${(t1 - t0).toFixed(0)} ms (states from the catalogue epoch), next ${(t2 - t1).toFixed(1)} ms`);
  }, 120_000);

  it.for([true, false])('comets: loads a null showcase (retain notable comets: %s), reports its absence and renders only actual candidates', { timeout: 120_000 }, async (retainNotable, ctx) => {
    if (!tables.cometList || !tables.cometModel) return ctx.skip('comets/* not built: null-showcase regression needs the comet products');
    // Change only a test response, never the shared data product or its manifest.
    const json = JSON.stringify({ ...tables.cometList, showcase: null, notable: retainNotable ? tables.cometList.notable : [] });
    // A zero-row core fixture exercises the production table-loading path without copying the catalogue again.
    const responses: Record<string, string | ArrayBuffer> = {
      'smallbodies/core.json': JSON.stringify({ ...tables.core.header, bin: 'core.bin', count: 0 }),
      'smallbodies/core.bin': new ArrayBuffer(0),
      'comets/model.json': JSON.stringify(tables.cometModel),
      'comets/list.json': json,
    };
    const L = new DataLoader({ base: '', fetch: async (path) => new Response(responses[path]) });
    L.manifest = {
      ...loader.manifest!,
      products: Object.fromEntries(Object.entries(responses).map(([path, body]) => [path, {
        bytes: typeof body === 'string' ? new TextEncoder().encode(body).byteLength : body.byteLength,
        path, sha256: '', stage: path.startsWith('comets/') ? 'comets' : 'smallbodies',
      }])),
    };
    const loaded = await loadSmallBodyTables(L, discoverSmallBodies(L.manifest)!);
    const list = loaded!.cometList!;
    expect(L.report.products.find((r) => r.path === 'comets/list.json')).toMatchObject({ status: 'ok' });
    expect(list.showcase).toBeNull();
    const noShowcase = 'No comet qualifies as the showcase in this build window';
    expect(() => showcasePeak(list, (reason) => { throw new Error(reason); })).toThrow(noShowcase);

    const sb = new SmallBodies({ ...tables, cometList: list }, eph!);
    const et = tables.cometList.notable[0]?.peakEt ?? tables.cometList.window.startEt;
    const earth = eph!.positionSSB(399, et)!;
    const pix = (60 * Math.PI) / 180 / 720;
    const frame = sb.comets!.frame([], earth, et, { apparentPosition }, 'best', pix);
    if (retainNotable) {
      const baseline = new SmallBodies(tables, eph!);
      expect(frame).toEqual(baseline.comets!.frame([], earth, et, { apparentPosition }, 'best', pix));
      for (const row of frame.rows) expect(list.notable.some((n) => n.row === row)).toBe(true);
    } else {
      expect(frame).toEqual({ comets: [], rows: [] });
    }
  });
});
