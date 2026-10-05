// The TypeScript reference propagator against (a) the pipeline's Python integrator (same scheme: must agree to
// rounding-level differences), and (b) independent JPL Horizons states for a diverse set of asteroids and comets.
//
// Two references, kept apart (core-data.ts):
//   * the committed one, app/tests/fixtures/smallbody_reference.json (uv run python -m pipeline.sb_fixtures): stated
//     orbit solutions at the reference's own epoch with its own force model. It is used with that epoch and model
//     whatever build is under test; the build only supplies the planets (ephemeris products), so reference epochs
//     outside the built ephemeris coverage are reported as not compared;
//   * the build record verification/smallbodies.json, written by the smallbodies stage with the products: the
//     states it put in core.bin. "The product holds what the pipeline computed" is checked against that.

import { describe, expect, it } from 'vitest';
import type { SmallBodyCoreHeader, SmallBodyForceModel } from '../src/data/schema';
import { SB_OK, SmallBodyPropagator, elementsToState } from '../src/core/smallbody';
import { coreState, readCore } from '../src/core/smallbodyCatalog';
import { DATA_DIR, MaxTracker, buildRecord, etDate, etMinute, fixture, loadEphemerisSet, notCompared, type SmallBodyRecord, type VerificationObject } from './core-data';

interface Reference {
  epochEt: number;
  sbdbSnapshot: string;
  forceModel: SmallBodyForceModel;
  objects: VerificationObject[];
}

const fx = fixture<Reference>('smallbody_reference.json');
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

describe.skipIf(!eph)(`SmallBodyPropagator vs the Python integrator and JPL Horizons (committed reference, its own epoch ${etDate(fx.epochEt)})`, () => {
  // The reference's epochs that the built ephemeris covers. Chains run outward from the reference epoch, so the
  // covered epochs are the ones inside the coverage, provided the reference epoch itself is.
  const w = eph!.window;
  const inside = (t: number) => t >= w.startEt && t <= w.endEt;
  const coverage = `the built ephemeris covers ${etMinute(w.startEt)} to ${etMinute(w.endEt)} TDB`;
  const all = [...new Set(fx.objects.flatMap((o) => o.epochs))].sort((a, b) => a - b);
  const out = inside(fx.epochEt) ? all.filter((t) => !inside(t)) : all;
  if (out.length > 0) {
    notCompared(`SmallBodyPropagator at ${out.length} of ${all.length} reference epochs (${etMinute(out[0])} to ${etMinute(out[out.length - 1])} TDB) of ${fx.objects.length} objects`, coverage);
  }

  it.skipIf(out.length === all.length)(`propagates every verification object across the reference epochs it can (${all.length - out.length} of ${all.length})`, () => {
    const prop = new SmallBodyPropagator(fx.forceModel, eph!);
    const max = new MaxTracker();
    const lines: string[] = [];
    let checked = 0;
    for (const o of fx.objects) {
      // Chain outward from the reference epoch, as the pipeline did (on the grid this equals direct propagation).
      const order = o.epochs.map((t, k) => ({ t, k })).filter((e) => inside(e.t));
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
          checked++;
        }
      }
      max.add(`${o.label} TS vs Python km`, worstPy, o.category);
      lines.push(`${o.label.padEnd(30)} vs Horizons ${worstHz.toFixed(3).padStart(9)} km (tol ${o.toleranceKm}), vs Python ${worstPy.toExponential(2)} km`);
      expect(worstPy, o.label).toBeLessThan(0.01);
      expect(worstHz, o.label).toBeLessThanOrEqual(o.toleranceKm);
    }
    expect(checked).toBe(fx.objects.length * (all.length - out.length));
    console.log(`reference of ${etDate(fx.epochEt)} (SBDB snapshot ${fx.sbdbSnapshot}), ${checked} states:\n${lines.join('\n')}`);
  }, 120_000);
});

const corePath = DATA_DIR + 'smallbodies/core.json';
describe.skipIf(!fs.existsSync(corePath))('smallbodies/core product against the build record of the same build', () => {
  it('ships the force model the committed reference was made with (Earth\'s pole apart: it is taken at each catalogue epoch)', () => {
    const header = JSON.parse(fs.readFileSync(corePath, 'utf8')) as SmallBodyCoreHeader;
    const noPole = (m: SmallBodyForceModel) => ({ ...m, zonal: { ...m.zonal, poleIcrf: null } });
    expect(noPole(header.forceModel), 'the force model changed: regenerate the reference (python -m pipeline.sb_fixtures)').toEqual(noPole(fx.forceModel));
  });

  const { record, why, unbound } = buildRecord<SmallBodyRecord>('verification/smallbodies.json', 'smallbodies');
  if (!record) {
    notCompared('smallbodies/core.bin states of the verification objects against the states the pipeline computed', why);
    return;
  }

  it('the build record names the products of this build (sha256 as in the manifest)', () => {
    expect(unbound).toEqual([]);
  });

  it('holds the states the pipeline computed at the catalogue epoch, bit for bit, in the rows it says', () => {
    const header = JSON.parse(fs.readFileSync(corePath, 'utf8')) as SmallBodyCoreHeader;
    const u8 = fs.readFileSync(DATA_DIR + header.bin);
    const buf = new ArrayBuffer(u8.byteLength);
    new Uint8Array(buf).set(u8);
    const cat = readCore(header, buf);
    expect(cat.epochEt).toBe(record.epochEt);
    expect(header.window).toEqual(record.window);
    const names = fs.readFileSync(DATA_DIR + 'smallbodies/names.txt', 'utf8').split('\n');
    expect(record.objects.length).toBeGreaterThan(0);
    for (const o of record.objects) {
      expect(names[o.coreRow].split('\t')[0], o.name).toBe(String(o.spkid));
      const s = coreState(cat, o.coreRow);
      expect(s, o.name).not.toBeNull();
      for (let j = 0; j < 6; j++) expect(s![j], o.name).toBe(o.stateCommon.value[j]);
    }
  });
});
