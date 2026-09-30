// The TypeScript reference propagator against (a) the pipeline's Python integrator (same scheme: must agree to
// rounding-level differences), and (b) independent JPL Horizons states for a diverse set of asteroids and comets.
// Fixture: app/tests/fixtures/smallbody_reference.json (uv run python -m pipeline.sb_fixtures). The planets come
// from the built ephemeris products (skips, loudly, when they are not built).

import { describe, expect, it } from 'vitest';
import type { SmallBodyCoreHeader, SmallBodyForceModel } from '../src/data/schema';
import type { NonGrav } from '../src/core/smallbody';
import { SB_OK, SmallBodyPropagator, elementsToState } from '../src/core/smallbody';
import { coreState, readCore } from '../src/core/smallbodyCatalog';
import { DATA_DIR, MaxTracker, fixture, loadEphemerisSet } from './core-data';

interface FixtureObject {
  label: string;
  category: string;
  designation: string;
  spkid: number;
  coreRow: number;
  horizonsSolution: string;
  elements: { qKm: number; e: number; iRad: number; nodeRad: number; periRad: number; dtPeriS: number; epochEt: number };
  nonGrav: NonGrav | null;
  stateAtEpoch: number[];
  stateCommon: number[];
  epochs: number[];
  horizons: number[][];
  python: number[][];
  maxErrKm: number;
  toleranceKm: number;
}
interface Fixture {
  epochEt: number;
  forceModel: SmallBodyForceModel;
  objects: FixtureObject[];
}

const fx = fixture<Fixture>('smallbody_reference.json');
const eph = loadEphemerisSet();

const fs: { existsSync(p: string): boolean; readFileSync(p: string): Uint8Array; readFileSync(p: string, e: 'utf8'): string } =
  await import(/* @vite-ignore */ 'node:fs' as string);

describe('elementsToState vs the pipeline', () => {
  it('reproduces the Python state at each SBDB epoch to rounding (1e-14 relative: < 0.2 mm at 100 au)', () => {
    const obliquity = (fx.forceModel.obliquityArcsec / 3600) * (Math.PI / 180);
    for (const o of fx.objects) {
      const el = o.elements;
      const s = elementsToState({ q: el.qKm, e: el.e, i: el.iRad, node: el.nodeRad, peri: el.periRad, dtPeri: el.dtPeriS }, fx.forceModel.sun.gm, obliquity);
      expect(s, o.label).not.toBeNull();
      const dr = Math.hypot(s![0] - o.stateAtEpoch[0], s![1] - o.stateAtEpoch[1], s![2] - o.stateAtEpoch[2]);
      const dv = Math.hypot(s![3] - o.stateAtEpoch[3], s![4] - o.stateAtEpoch[4], s![5] - o.stateAtEpoch[5]);
      const r = Math.hypot(o.stateAtEpoch[0], o.stateAtEpoch[1], o.stateAtEpoch[2]);
      const v = Math.hypot(o.stateAtEpoch[3], o.stateAtEpoch[4], o.stateAtEpoch[5]);
      expect(dr / r, o.label).toBeLessThan(1e-14);
      expect(dv / v, o.label).toBeLessThan(1e-14);
    }
  });
});

describe.skipIf(!eph)('SmallBodyPropagator vs the Python integrator and JPL Horizons', () => {
  it('propagates every verification object across the window', () => {
    const prop = new SmallBodyPropagator(fx.forceModel, eph!);
    const max = new MaxTracker();
    const lines: string[] = [];
    for (const o of fx.objects) {
      // Chain outward from the common epoch, as the pipeline did (on the grid this equals direct propagation).
      const order = o.epochs.map((t, k) => ({ t, k }));
      const fwd = order.filter((e) => e.t >= fx.epochEt).sort((a, b) => a.t - b.t);
      const bwd = order.filter((e) => e.t < fx.epochEt).sort((a, b) => b.t - a.t);
      let worstPy = 0;
      let worstHz = 0;
      for (const chain of [fwd, bwd]) {
        const s = Float64Array.from(o.stateCommon);
        let t = fx.epochEt;
        for (const { t: te, k } of chain) {
          const st = prop.propagateOne(s, 0, t, te, fx.epochEt, o.nonGrav);
          expect(st, `${o.label} at ${te}`).toBe(SB_OK);
          t = te;
          const py = o.python[k];
          const hz = o.horizons[k];
          worstPy = Math.max(worstPy, Math.hypot(s[0] - py[0], s[1] - py[1], s[2] - py[2]));
          worstHz = Math.max(worstHz, Math.hypot(s[0] - hz[0], s[1] - hz[1], s[2] - hz[2]));
        }
      }
      max.add(`${o.label} TS vs Python km`, worstPy, o.category);
      lines.push(`${o.label.padEnd(30)} vs Horizons ${worstHz.toFixed(3).padStart(9)} km (tol ${o.toleranceKm}), vs Python ${worstPy.toExponential(2)} km`);
      expect(worstPy, o.label).toBeLessThan(0.01);
      expect(worstHz, o.label).toBeLessThanOrEqual(o.toleranceKm);
    }
    console.log(lines.join('\n'));
  }, 120_000);
});

const corePath = DATA_DIR + 'smallbodies/core.json';
describe.skipIf(!fs.existsSync(corePath))('smallbodies/core product', () => {
  it('holds the fixture states at the common epoch, bit for bit', () => {
    const header = JSON.parse(fs.readFileSync(corePath, 'utf8')) as SmallBodyCoreHeader;
    const u8 = fs.readFileSync(DATA_DIR + header.bin);
    const buf = new ArrayBuffer(u8.byteLength);
    new Uint8Array(buf).set(u8);
    const cat = readCore(header, buf);
    expect(cat.epochEt).toBe(fx.epochEt);
    expect(header.forceModel).toEqual(fx.forceModel);
    for (const o of fx.objects) {
      if (o.coreRow >= cat.count) continue; // partial (development) build
      const s = coreState(cat, o.coreRow);
      expect(s, o.label).not.toBeNull();
      for (let j = 0; j < 6; j++) expect(s![j], o.label).toBe(o.stateCommon[j]);
    }
  });
});
