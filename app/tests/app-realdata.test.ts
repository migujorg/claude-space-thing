// Integration + timing against the pipeline's built products (skipped when app/public/data is not built):
// the real loader, the real core (ephemeris, light time, precise orientation) and AppModel with every moon
// system loaded lazily. Prints per-frame costs (world geometry, orbits, snapshot) for crowded views.

import { describe, expect, it } from 'vitest';
import { AppModel } from '../src/app/model';
import { loadAll } from '../src/data/load';
import { Ephemeris, EphemerisSet } from '../src/core/ephemeris';
import { apparentPosition } from '../src/core/lighttime';
import { OrientationSet, PreciseOrientation, bodyToIcrf } from '../src/core/rotation';
import { TimeScale, formatUtc } from '../src/core/time';
import { DATA_DIR } from './core-data';

interface Fs {
  existsSync(p: string): boolean;
  readFileSync(p: string): Uint8Array;
}
const fs: Fs = await import(/* @vite-ignore */ 'node:fs' as string);
const built = fs.existsSync(DATA_DIR + 'bodies.json') && fs.existsSync(DATA_DIR + 'ephem/sat-sat.json');

const fetchFs = async (url: string): Promise<Response> => {
  const p = DATA_DIR + url.replace(/^\/data\//, '');
  if (!fs.existsSync(p)) return new Response('not found', { status: 404 });
  const u8 = fs.readFileSync(p);
  const copy = new Uint8Array(u8.byteLength);
  copy.set(u8);
  return new Response(copy, { headers: { 'content-type': p.endsWith('.json') ? 'application/json' : 'application/octet-stream' } });
};

const core = { TimeScale, formatUtc, Ephemeris, EphemerisSet, bodyToIcrf, apparentPosition, OrientationSet, PreciseOrientation };

async function setup() {
  const data = await loadAll({ fetch: fetchFs, base: '/data/', eagerEphemeris: (p) => p === 'ephem/de442s.json' });
  const model = new AppModel(core);
  model.setData(data);
  model.setViewport({ width: 1280, height: 720, dpr: 1 });
  const t = model.clock.window!;
  const tMs = model.utcMs((t.startEt + t.endEt) / 2)!;
  model.applyUrl({ tMs });
  return { model, data };
}

function measure(model: AppModel, frames = 30) {
  const acc = { world: [] as number[], orbits: [] as number[], snapshot: [] as number[], total: [] as number[] };
  for (let i = 0; i < frames; i++) {
    model.frame(1 / 60);
    for (const k of ['world', 'orbits', 'snapshot', 'total'] as const) acc[k].push(model.timings[k]);
  }
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  return { world: med(acc.world), orbits: med(acc.orbits), snapshot: med(acc.snapshot), total: med(acc.total), max: Math.max(...acc.total) };
}

describe.skipIf(!built)('real data (app/public/data)', () => {
  it('loads every moon system lazily; all bodies get positions; costs stay small', async () => {
    const { model, data } = await setup();
    expect(data.deferred.length).toBeGreaterThanOrEqual(6);
    model.frame(0);
    const before = model.snapshot!.bodies.length + model.overlayOnly.length;
    model.startBackgroundLoading();
    await model.systemsIdle();
    expect(model.systems!.summary().errors).toEqual([]);
    model.frame(0);
    const after = model.snapshot!.bodies.length + model.overlayOnly.length;
    const physical = model.bodies.filter((b) => b.kind !== 'barycenter' && b.kind !== 'star').length;
    expect(before).toBeLessThan(20);
    expect(after).toBe(physical);

    const rows: string[] = [];
    const view = async (name: string, id: number, dist: number, orbits: boolean) => {
      await model.goTo(id, dist, { instant: true });
      model.setReality({ overlays: { orbits } });
      // let the orbit manager finish its work (budgeted over frames), then measure steady state
      for (let i = 0; i < 400 && orbits && (model.orbits!.stats.pending > 0 || i < 2); i++) model.frame(1 / 60);
      const m = measure(model);
      const st = model.orbits!.stats;
      rows.push(`${name.padEnd(26)} bodies ${String(model.snapshot!.bodies.length).padStart(3)} + overlay-only ${String(model.overlayOnly.length).padStart(3)} | world ${m.world.toFixed(2)} ms, snapshot ${m.snapshot.toFixed(2)} ms, orbits ${m.orbits.toFixed(2)} ms (${st.drawn} drawn) | total ${m.total.toFixed(2)} ms (max ${m.max.toFixed(1)})`);
      return m;
    };
    const jup = await view('Jupiter @ 2.5 million km', 599, 2.5e6, false);
    await view('  + orbits overlay', 599, 2.5e6, true);
    const sat = await view('Saturn @ 3 million km', 699, 3e6, false);
    await view('  + orbits overlay', 699, 3e6, true);
    await view('Earth-Moon @ 1 million km', 399, 1e6, true);
    console.log(`Per-frame shell cost with all ${model.bodies.length} bodies loaded (median of 30 frames):\n  ${rows.join('\n  ')}`);
    // Generous bounds (CI machines vary): the shell's per-frame work must stay a small fraction of a frame.
    expect(jup.world + jup.snapshot).toBeLessThan(25);
    expect(sat.world + sat.snapshot).toBeLessThan(25);
  }, 120_000);

  it("Earth's orientation comes from orient/earth: measured before the last EOP datum, a prediction after", async () => {
    const { model, data } = await setup();
    expect(data.orientations.map((o) => o.path)).toEqual(['orient/earth.json', 'orient/moon.json']);
    const segs = data.orientations[0].header.segments;
    const measured = segs.find((s) => s.label === 'measured')!;
    const predicted = segs.find((s) => s.label === 'estimated')!;
    const pm = model.orientations.provenance(399, (measured.startEt + measured.endEt) / 2)!;
    const pe = model.orientations.provenance(399, (predicted.startEt + predicted.endEt) / 2)!;
    expect(pm).toMatchObject({ kind: 'precise', label: 'measured', frame: 'ITRF93' });
    expect(pe).toMatchObject({ kind: 'precise', label: 'estimated', frame: 'ITRF93' });
    // At Strict, a predicted Earth orientation is not used for drawing.
    model.setReality({ exists: 'strict' });
    model.setEt((predicted.startEt + predicted.endEt) / 2);
    await model.goTo(399, 3e4, { instant: true });
    model.frame(0);
    expect(model.snapshot!.bodies.find((b) => b.id === 399)!.orient).toBeNull();
    model.setReality({ exists: 'best' });
    model.frame(0);
    expect(model.snapshot!.bodies.find((b) => b.id === 399)!.orient).not.toBeNull();
  }, 60_000);

  it('go-to a moon of a system that is not loaded yet waits for it and arrives', async () => {
    const { model } = await setup();
    const titan = model.bodies.find((b) => b.name === 'Titan')!;
    expect(model.bodyLoadState(titan.id)).toBe('deferred');
    await model.goTo(titan.id, 1e5, { instant: true });
    model.frame(0);
    expect(model.debugState().camera).toMatchObject({ target: titan.id });
    expect(model.bodyLoadState(titan.id)).toBe('loaded');
  }, 60_000);
});
