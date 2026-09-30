import { describe, expect, it } from 'vitest';
import type { IauRotation } from '../src/data/schema';
import { bodyToIcrf, icrfToBody } from '../src/core/rotation';
import { mat3Mul } from '../src/core/vec';
import { MaxTracker, fixture, loadBodies } from './core-data';

interface SpiceRotation {
  bodies: { id: number; frame: string; cases: { et: number; bodyToJ2000: number[] }[] }[];
}

const bodies = loadBodies();

describe.skipIf(!bodies)('bodyToIcrf vs SPICE pxform(IAU_<BODY>, J2000) with pck00011 (bodies.json)', () => {
  it('matches to 1e-9 for every body, 1950–2100', () => {
    const spice = fixture<SpiceRotation>('core_spice_rotation.json');
    const max = new MaxTracker();
    const required = new Set([399, 301, 499, 599, 999]);
    for (const b of spice.bodies) {
      const body = bodies!.find((x) => x.id === b.id);
      expect(body, `body ${b.id} missing from bodies.json`).toBeDefined();
      expect(body!.rotation.label).toBe('measured');
      const rot = body!.rotation.value as IauRotation;
      for (const c of b.cases) {
        const m = bodyToIcrf(rot, c.et);
        let err = 0;
        for (let i = 0; i < 9; i++) err = Math.max(err, Math.abs(m[i] - c.bodyToJ2000[i]));
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
      const rot = body.rotation.value as IauRotation;
      const m = bodyToIcrf(rot, 8.3e8);
      const p = mat3Mul(m, icrfToBody(rot, 8.3e8));
      for (let i = 0; i < 9; i++) expect(Math.abs(p[i] - (i % 4 === 0 ? 1 : 0))).toBeLessThan(1e-14);
      const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
      expect(Math.abs(det - 1)).toBeLessThan(1e-14);
    }
  });
});
