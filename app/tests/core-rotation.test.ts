import { describe, expect, it } from 'vitest';
import type { IauRotation, OrientationHeader } from '../src/data/schema';
import { OrientationSet, PreciseOrientation, bodyToIcrf, icrfToBody } from '../src/core/rotation';
import type { Mat3 } from '../src/core/vec';
import { mat3Mul } from '../src/core/vec';
import { MaxTracker, fixture, loadBodies, loadOrientation } from './core-data';

interface SpiceRotation {
  bodies: { id: number; frame: string; cases: { et: number; bodyToJ2000: number[] }[] }[];
}

const bodies = loadBodies();

function maxDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let err = 0;
  for (let i = 0; i < 9; i++) err = Math.max(err, Math.abs(a[i] - b[i]));
  return err;
}

describe.skipIf(!bodies)('bodyToIcrf vs SPICE pxform(IAU_<BODY>, J2000) with pck00011 (bodies.json)', () => {
  it('matches to 1e-9 for planets, the Sun, the Moon, Pluto and moons with IAU models, 1950–2100', () => {
    const spice = fixture<SpiceRotation>('core_spice_rotation.json');
    const max = new MaxTracker();
    const required = new Set([399, 301, 499, 599, 999, 401, 501, 606, 801, 901, 705]);
    for (const b of spice.bodies) {
      const body = bodies!.find((x) => x.id === b.id);
      expect(body, `body ${b.id} missing from bodies.json`).toBeDefined();
      expect(body!.rotation.label).toBe('measured');
      const rot = body!.rotation.value as IauRotation;
      for (const c of b.cases) {
        const err = maxDiff(bodyToIcrf(rot, c.et), c.bodyToJ2000);
        max.add(b.frame, err, `et ${c.et}`);
        expect(err, `${b.frame} et ${c.et}`).toBeLessThan(1e-9);
      }
      required.delete(b.id);
    }
    expect([...required]).toEqual([]);
    max.report('bodyToIcrf vs pxform (max |ΔM_ij|):');
  });

  it('returns proper rotations (orthonormal, det +1) and icrfToBody is the inverse', () => {
    for (const body of bodies!) {
      if (body.rotation.label === 'unknown') continue;
      const rot = body.rotation.value as IauRotation;
      const m = bodyToIcrf(rot, 8.3e8);
      const p = mat3Mul(m, icrfToBody(rot, 8.3e8));
      for (let i = 0; i < 9; i++) expect(Math.abs(p[i] - (i % 4 === 0 ? 1 : 0))).toBeLessThan(1e-14);
      const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
      expect(Math.abs(det - 1)).toBeLessThan(1e-14);
    }
  });
});

const earth = loadOrientation('orient/earth');
const moon = loadOrientation('orient/moon');

describe.skipIf(!earth || !moon || !bodies)('Precise orientation (NAIF binary PCKs) vs SPICE pxform', () => {
  it('Earth ITRF93 and Moon MOON_ME_DE440_ME421 match pxform over the window (measured and predicted parts)', () => {
    const spice = fixture<SpiceRotation>('core_spice_orient.json');
    const max = new MaxTracker();
    for (const b of spice.bodies) {
      const p = b.id === 399 ? earth! : moon!;
      for (const c of b.cases) {
        if (!max.inCoverage(p.covers(b.id, c.et))) continue;
        const m = p.bodyToIcrf(b.id, c.et);
        const err = maxDiff(m!, c.bodyToJ2000);
        max.add(`${b.frame} (${p.segment(b.id, c.et)!.label})`, err, `et ${c.et}`);
        expect(err, `${b.frame} et ${c.et}`).toBeLessThan(1e-12);
      }
    }
    max.report('PreciseOrientation vs pxform (max |ΔM_ij|):');
    max.requireSome('orientation fixture');
  });

  it('OrientationSet prefers the precise product, falls back to the IAU model, and says which it used', () => {
    const set = new OrientationSet(bodies!);
    set.add(earth!);
    set.add(moon!);
    const seg = earth!.header.segments;
    const et = (seg[0].startEt + seg[0].endEt) / 2;
    expect(set.orientation(399, et)).toEqual(earth!.bodyToIcrf(399, et));
    expect(set.provenance(399, et)).toMatchObject({ kind: 'precise', label: 'measured', frame: 'ITRF93' });
    // Measured before the last EOP datum, estimated (predicted EOP) after.
    const labels = new Set(seg.map((s) => s.label));
    expect(labels).toEqual(new Set(['measured', 'estimated']));
    const lastEt = Math.max(...seg.map((s) => s.endEt));
    expect(set.provenance(399, lastEt)!.label).toBe('estimated');
    // Outside the product: the IAU model from bodies.json.
    const earthRot = bodies!.find((b) => b.id === 399)!.rotation.value as IauRotation;
    expect(set.orientation(399, lastEt + 86400)).toEqual(bodyToIcrf(earthRot, lastEt + 86400));
    expect(set.provenance(399, lastEt + 86400)!.kind).toBe('iau');
    // IAU_EARTH differs from ITRF93 by ~300 arcsec: the precise product is not a copy of the IAU model.
    const iau = bodyToIcrf(earthRot, et);
    const angle = Math.acos(Math.min(1, (traceProduct(set.orientation(399, et)!, iau) - 1) / 2)) * (180 / Math.PI) * 3600;
    expect(angle).toBeGreaterThan(100);
    expect(angle).toBeLessThan(1000);
    // A moon without a rotation model has no orientation at all (never assumed synchronous).
    const noRot = bodies!.find((b) => b.kind === 'moon' && b.rotation.label === 'unknown')!;
    expect(set.orientation(noRot.id, et)).toBeNull();
    expect(set.provenance(noRot.id, et)).toBeNull();
  });

  it('rejects malformed products', () => {
    const h: OrientationHeader = JSON.parse(JSON.stringify(earth!.header));
    h.segments[0].reference = 'NOPE';
    expect(() => new PreciseOrientation(h, new Float64Array(1e6))).toThrow();
  });
});

/** trace(aᵀ b) = 1 + 2 cos(angle between the two rotations). */
function traceProduct(a: Mat3, b: Mat3): number {
  let t = 0;
  for (let i = 0; i < 9; i++) t += a[i] * b[i];
  return t;
}
