import { describe, expect, it } from 'vitest';
import { buildOrientation, IauOrientationSet } from '../src/app/orientation';
import { buildSnapshot } from '../src/app/snapshot';
import { defaultReality } from '../src/app/reality';
import { computeWorld } from '../src/app/world';
import { OrientationSet, PreciseOrientation, bodyToIcrf } from '../src/core/rotation';
import type { OrientationHeader } from '../src/data/schema';
import { attributeRows } from '../src/ui/inspectModel';
import { body, FakeEphemerisSet, fakeLight, makeApparent } from './app-fakes';

// A tiny precise product: constant Euler angles over [0, 100] s, labelled `estimated` (like a prediction).
const header: OrientationHeader = {
  bin: 'orient/test.bin',
  references: { REF: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
  bodies: { '399': { frame: 'TESTFRAME', pckFrame: 'TESTFRAME', bodyToPck: [1, 0, 0, 0, 1, 0, 0, 0, 1] } },
  segments: [{ body: 399, frameClassId: 1, reference: 'REF', type: 2, initEt: 0, intLen: 100, rsize: 5, n: 1, offset: 0, startEt: 0, endEt: 100, sources: ['precise-src'], label: 'estimated', method: 'test prediction' }],
};
const data = new Float64Array([50, 50, 0.3, 0.2, 1.0]);
const earth = body(399, 'Earth', 'planet', { r: 6400, albedo: 'measured', phase: 'measured' });
const sun = body(10, 'Sun', 'star', { r: 7e5 });
const core = { OrientationSet, PreciseOrientation, bodyToIcrf };

describe('orientation set integration', () => {
  it('prefers the precise product where it covers, falls back to the IAU model elsewhere', () => {
    const { set, errors, loaded } = buildOrientation(core, [earth], [{ path: 'orient/test.json', header, data }]);
    expect(errors).toEqual([]);
    expect(loaded).toEqual(['orient/test.json']);
    const precise = new PreciseOrientation(header, data).bodyToIcrf(399, 50)!;
    expect(set.orientation(399, 50)).toEqual(precise);
    expect(set.provenance(399, 50)).toMatchObject({ kind: 'precise', label: 'estimated', frame: 'TESTFRAME', sources: ['precise-src'] });
    expect(set.orientation(399, 500)).toEqual(bodyToIcrf(earth.rotation.value!, 500));
    expect(set.provenance(399, 500)).toMatchObject({ kind: 'iau', label: 'measured' });
  });

  it('without core precise classes: IAU only, and the unused product is reported', () => {
    const { set, errors } = buildOrientation({ bodyToIcrf }, [earth], [{ path: 'orient/test.json', header, data }]);
    expect(set).toBeInstanceOf(IauOrientationSet);
    expect(errors[0]).toMatch(/IAU models used/);
    expect(set.orientation(399, 50)).toEqual(bodyToIcrf(earth.rotation.value!, 50));
    expect(set.provenance(399, 50)).toMatchObject({ kind: 'iau' });
    expect(set.provenance(12345, 50)).toBeNull();
  });

  it('a broken product is skipped with an error, the rest keeps working', () => {
    const bad = { ...header, bodies: {} };
    const { errors, set } = buildOrientation(core, [earth], [{ path: 'orient/bad.json', header: bad, data }]);
    expect(errors[0]).toMatch(/orient\/bad.json could not be used/);
    expect(set.provenance(399, 50)).toMatchObject({ kind: 'iau' });
  });
});

describe('snapshot orientation at the emission epoch', () => {
  // Earth fixed at 1e5 km; signal speed chosen so the light time is 60 s.
  const eph = new FakeEphemerisSet({ 10: () => [0, 0, -1e9], 399: () => [1e5, 0, 0] });
  const apparent = makeApparent(1e5 / 60);
  const cam = { orient: [1, 0, 0, 0, 1, 0, 0, 0, 1] as [number, number, number, number, number, number, number, number, number], fovY: 1, width: 10, height: 10 };
  const { set } = buildOrientation(core, [earth], [{ path: 'orient/test.json', header, data }]);
  const snap = (et: number, exists: 'strict' | 'best') => {
    const world = computeWorld(et, [0, 0, 0], [sun, earth], eph, { apparentPosition: apparent }, 10);
    return buildSnapshot({ world, camera: cam, reality: { ...defaultReality(), exists }, light: fakeLight(), selectedId: null, orbits: [], orientations: set });
  };

  it('uses the precise product at emitEt even when et itself is past its coverage', () => {
    const s = snap(150, 'best'); // emitEt = 90, inside [0, 100]
    expect(s.bodies[0].orient).toEqual(new PreciseOrientation(header, data).bodyToIcrf(399, 90));
    expect(s.bodies[0].worstLabel).toBe('estimated');
  });

  it('an estimated (predicted) orientation is withheld at Strict; the IAU model takes over outside coverage', () => {
    expect(snap(150, 'strict').bodies[0].orient).toBeNull();
    expect(snap(150, 'strict').bodies[0].worstLabel).toBe('derived');
    const later = snap(400, 'strict'); // emitEt 340: IAU model (measured) → allowed
    expect(later.bodies[0].orient).toEqual(bodyToIcrf(earth.rotation.value!, 340));
  });

  it('the inspector shows which orientation is in use and its label', () => {
    const rows = attributeRows(earth, 'strict', [], { orientation: set.provenance(399, 90) });
    const o = rows.find((r) => r.key === 'orientation')!;
    expect(o).toMatchObject({ label: 'estimated', withheld: true, sources: ['precise-src'] });
    expect(o.name).toMatch(/TESTFRAME/);
    expect(attributeRows(earth, 'best', [], { orientation: null }).find((r) => r.key === 'orientation')!.label).toBe('unknown');
  });
});
