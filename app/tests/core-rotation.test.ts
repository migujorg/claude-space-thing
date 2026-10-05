import { describe, expect, it } from 'vitest';
import type { IauRotation, OrientationHeader, SourceRecord } from '../src/data/schema';
import { OrientationSet, PreciseOrientation, bodyToIcrf, icrfToBody } from '../src/core/rotation';
import type { Mat3 } from '../src/core/vec';
import { mat3Mul } from '../src/core/vec';
import { DATA_DIR, MaxTracker, buildRecord, etDate, fixture, loadBodies, loadOrientation, notCompared, type OrientationRecord } from './core-data';

interface SpiceRotation {
  bodies: { id: number; frame: string; cases: { et: number; bodyToJ2000: number[] }[] }[];
}
/** core_spice_orient.json: SPICE values for the kernel files each case names (sha256 in kernelSha256). */
interface SpiceOrient {
  kernelSha256: Record<string, string>;
  bodies: { id: number; frame: string; cases: { et: number; kernels: string[]; bodyToJ2000: number[] }[] }[];
}

const fs: { existsSync(p: string): boolean; readFileSync(p: string, e: 'utf8'): string } = await import(/* @vite-ignore */ 'node:fs' as string);

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

// The products hold Chebyshev records copied unchanged from NAIF's kernels, so the TypeScript evaluator must agree
// with SPICE on the same records to rounding: 1e-12 in a matrix element. That bound holds only against SPICE on the
// same kernel file. NAIF reissues the Earth kernels as measurements arrive (ITRF93 moved by up to 1.4e-11 on
// measured days more than a year old, and by 1.8e-9 on the newest days, between the files of 2026-09-29 and
// 2026-10-03: ephem_fixtures.py), so SPICE values from another file are not a reference for this product at this
// bound, and a looser bound would only measure how much NAIF revised its kernel. Hence two comparisons:
//   * with the build record (verification/orientation.json): SPICE on the very files the bodies stage copied, for
//     the Earth and the Moon, in every segment;
//   * with the committed reference (core_spice_orient.json, the Moon: its kernels are fixed files): only the cases
//     whose kernel files (sha256) are the ones the product segment was copied from. Others are reported as not
//     compared, as would be cases of a reference that held values from one build's Earth kernel.
describe.skipIf(!earth || !moon || !bodies)('Precise orientation (NAIF binary PCKs) vs SPICE pxform', () => {
  const product = (id: number) => (id === 399 ? earth! : moon!);
  const ROUNDING = 1e-12;

  const rec = buildRecord<OrientationRecord>('verification/orientation.json', 'bodies');
  if (!rec.record) {
    notCompared('orient/earth (ITRF93) and orient/moon (MOON_ME_DE440_ME421) against SPICE on the kernels they were copied from', rec.why);
  } else {
    const record = rec.record;
    it('the build record names the products of this build (sha256 as in the manifest)', () => {
      expect(rec.unbound).toEqual([]);
    });

    it('Earth ITRF93 and Moon MOON_ME_DE440_ME421 match SPICE pxform on the kernels of this build, in every segment (measured, predicted, long-term predict)', () => {
      const max = new MaxTracker();
      const seen = new Set<string>();
      for (const b of record.bodies) {
        const p = product(b.id);
        for (const c of b.cases) {
          const m = p.bodyToIcrf(b.id, c.et);
          expect(m, `${b.frame} et ${c.et}: inside the product by construction`).not.toBeNull();
          const seg = p.segment(b.id, c.et)!;
          expect(seg.label).toBe(c.bodyToJ2000.label);
          expect(seg.sources).toEqual(c.bodyToJ2000.sources);
          const err = maxDiff(m!, c.bodyToJ2000.value);
          max.add(`${b.frame} (${seg.label}, ${seg.sources.join(' + ')})`, err, `et ${c.et}`);
          expect(err, `${b.frame} et ${c.et}`).toBeLessThan(ROUNDING);
          seen.add(`${b.id}/${p.header.segments.indexOf(seg)}`);
        }
      }
      // Every segment of both products was sampled.
      for (const p of [earth!, moon!]) p.header.segments.forEach((s, n) => expect(seen.has(`${s.body}/${n}`), `segment ${n} of body ${s.body}`).toBe(true));
      max.report(`PreciseOrientation vs pxform on this build's kernels (${record.kernels.map((k) => k.file).join(', ')}; max |ΔM_ij|):`);
    });
  }

  // The committed reference: comparable case by case where the product was copied from the same kernel file.
  const ref = fixture<SpiceOrient>('core_spice_orient.json');
  const sources: SourceRecord[] = fs.existsSync(DATA_DIR + 'sources.json') ? JSON.parse(fs.readFileSync(DATA_DIR + 'sources.json', 'utf8')) : [];
  const sourceOf = new Map(sources.map((x) => [x.id, x]));
  const comparable: { id: number; frame: string; et: number; bodyToJ2000: number[] }[] = [];
  const not = new Map<string, number[]>();
  let total = 0;
  for (const b of ref.bodies) {
    const p = product(b.id);
    for (const c of b.cases) {
      total++;
      const seg = p.segment(b.id, c.et);
      const from = c.kernels.join(' + ');
      let why = '';
      if (!seg) {
        const all = p.header.segments.filter((x) => x.body === b.id);
        why = `outside the built product (${p.header.bin} covers ${etDate(Math.min(...all.map((x) => x.startEt)))} to ${etDate(Math.max(...all.map((x) => x.endEt)))})`;
      } else {
        const built = seg.sources.map((id) => sourceOf.get(id)?.sha256 ?? `no sha256 for ${id}`).sort();
        const refSha = c.kernels.map((k) => ref.kernelSha256[k] ?? `no sha256 for ${k}`).sort();
        if (built.join() !== refSha.join()) why = `this build copied ${p.header.bin} there from ${seg.sources.map((id) => sourceOf.get(id)?.version ?? id).join(' + ')}, another file`;
      }
      if (!why) comparable.push({ id: b.id, frame: b.frame, et: c.et, bodyToJ2000: c.bodyToJ2000 });
      else {
        const key = `${b.frame} from ${from}\u0000${why}`;
        not.set(key, [...(not.get(key) ?? []), c.et]);
      }
    }
  }
  for (const [key, ets] of not) {
    const [what, why] = key.split('\u0000');
    notCompared(`${ets.length} reference epochs (${etDate(Math.min(...ets))} to ${etDate(Math.max(...ets))}) of ${what} against the built product at rounding level`, why);
  }

  it.skipIf(comparable.length === 0)(`matches the committed SPICE reference where the product comes from the same kernel file (${comparable.length} of ${total} cases)`, () => {
    const max = new MaxTracker();
    for (const c of comparable) {
      const p = product(c.id);
      const err = maxDiff(p.bodyToIcrf(c.id, c.et)!, c.bodyToJ2000);
      max.add(`${c.frame} (${p.segment(c.id, c.et)!.label})`, err, `et ${c.et}`);
      expect(err, `${c.frame} et ${c.et}`).toBeLessThan(ROUNDING);
    }
    max.report('PreciseOrientation vs the committed pxform reference (max |ΔM_ij|):');
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
