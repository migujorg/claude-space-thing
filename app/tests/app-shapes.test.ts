import { describe, expect, it } from 'vitest';
import { radarSpin, ShapeLibrary } from '../src/app/shapes';
import type { ShapeIndex, ShapeModelHeader } from '../src/data/schema';
import type { Mat3, SceneBody, SceneCamera } from '../src/render/scene';
import { bodyToIcrfFromConstants, rotationAngleDeg } from '../src/core/shapeRotation';
import { buildSnapshot } from '../src/app/snapshot';
import { IauOrientationSet } from '../src/app/orientation';
import { computeWorld } from '../src/app/world';
import { defaultReality } from '../src/app/reality';
import { body as fakeBody, FakeEphemerisSet, fakeBodyToIcrf, fakeLight, makeApparent } from './app-fakes';

const lod = (tri: number, off: number) => ({
  level: 0, triangles: tri, vertices: tri / 2 + 2, offset: off, bytes: 100, method: 'source' as const, watertight: true, decimationAttempts: 0, volumeRatioToSource: 1,
  positions: { offset: 0, bytes: 12, type: 'f32' as const, components: 3 as const, count: 1 },
  normals: { offset: 12, bytes: 6, type: 'i16' as const, components: 3 as const, count: 1 },
  indices: { offset: 20, bytes: 6, type: 'u16' as const, components: 3 as const, count: 1 },
});

function header(id: number, over: Partial<ShapeModelHeader> & { orientation: ShapeModelHeader['orientation'] }): ShapeModelHeader {
  return {
    id, name: `body ${id}`, naifId: id, sbdb: null, kind: 'spacecraft', bin: `shapes/${id}.bin`, units: 'km',
    frame: { name: 'IAU_X', origin: '', axes: '' },
    provenance: { label: 'measured', sources: [`shape-${id}`], method: 'SPC' },
    source: { file: 'x', nativeVertices: 1, nativeTriangles: 1, weldedVertices: 1, weldedTriangles: 1, integrity: { boundaryEdges: 0, nonManifoldEdges: 0, inconsistentEdges: 0, eulerCharacteristic: 2, components: 1, genus: 0, watertight: true } },
    stats: { volumeKm3: 1, areaKm2: 10, volumeEquivalentRadiusKm: 1, centroidKm: [0, 0, 0], boundsKm: [[-2, -1, -1], [2, 1, 1]] },
    scaleCheck: null, lods: [lod(2000, 0), lod(500, 100)], layout: '', notes: [],
    ...over,
  };
}

const PHOBOS_SR = { POLE_RA: [317.68, -0.108, 0], POLE_DEC: [52.9, -0.061, 0], PM: [35.06, 1128.844585, 6.6443009930565219e-9] };
const HEADERS: Record<string, ShapeModelHeader> = {
  '401': header(401, { orientation: { frame: 'IAU_PHOBOS', label: 'measured', sourceRotation: PHOBOS_SR } }),
  '610': header(610, { orientation: { frame: 'IAU_JANUS', label: 'measured' } }),
  '807': header(807, { provenance: { label: 'estimated', sources: ['shape-larissa'], method: 'limb fit' }, orientation: { frame: 'IAU_LARISSA', label: 'measured' } }),
  '607': header(607, { orientation: { frame: 'IAU_HYPERION', label: 'unknown' }, notes: ["Hyperion's rotation is chaotic."] }),
  '20004660': header(20004660, {
    kind: 'radar',
    orientation: {
      frame: 'principal axes (radar model)', label: 'measured',
      spinState: { file: 'a.csv', fields: [
        { name: 'Pole_longitude', value: 25 }, { name: 'Pole_latitude', value: 80 }, { name: 'Rotational_period', value: 15.1 },
        { name: 'Rotational_phase_at_t0', value: 0 }, { name: 'year', value: 2002 }, { name: 'month', value: 1 }, { name: 'day', value: 1 },
        { name: 'hours', value: 0 }, { name: 'minutes', value: 0 }, { name: 'seconds', value: 0 },
      ] },
    },
  }),
};
const INDEX = { bodies: Object.fromEntries(Object.entries(HEADERS).map(([k]) => [k, { file: `shapes/${k}.json` }])) } as unknown as ShapeIndex;

function lib(): ShapeLibrary {
  return new ShapeLibrary(INDEX, {
    dataRoot: 'data/',
    fetchJson: async (u) => HEADERS[u.replace('data/shapes/', '').replace('.json', '')],
    utcToEt: (ms) => ms / 1000 - 946728000 + 69.184,
    spkidOf: (id) => (id === -4661 ? 20004660 : null),
  });
}

const body = (id: number, orient: Mat3 | null = null): SceneBody => ({
  id, name: String(id), pos: [0, 0, 0], toSun: [1, 0, 0], orient, radii: [1, 1, 1], albedoXYZS: [0.1, 0.1, 0.1, 0.1], phase: null,
  surfaceUnknown: false, worstLabel: 'measured', selected: false,
});

async function loaded(l: ShapeLibrary, ids: number[]) {
  for (const id of ids) l.sceneShape(body(id), 'best', 0);
  await l.whenIdle();
}

describe('ShapeLibrary: which mesh replaces the ellipsoid', () => {
  it('places a mesh with its own frame\'s constants (Phobos: pck00010) and reports why', async () => {
    const l = lib();
    await loaded(l, [401]);
    const et = 8e8;
    const s = l.sceneShape(body(401, [1, 0, 0, 0, 1, 0, 0, 0, 1]), 'strict', et)!;
    expect(s.key).toBe('shapes/401');
    expect(rotationAngleDeg(s.orient, bodyToIcrfFromConstants(PHOBOS_SR, et))).toBeLessThan(1e-12);
    expect(s.lods.map((x) => x.triangles)).toEqual([2000, 500]);
    expect(s.lods[1].url).toBe('data/shapes/401.bin');
    expect(s.worstLabel).toBe('derived');
    expect(l.status(401)!.drawn).toBe(true);
  });
  it('uses the app orientation for a shape in the body\'s IAU frame, and none without it', async () => {
    const l = lib();
    await loaded(l, [610]);
    const R: Mat3 = [0, -1, 0, 1, 0, 0, 0, 0, 1];
    expect(l.sceneShape(body(610, R), 'best', 0)!.orient).toEqual(R);
    expect(l.sceneShape(body(610, null), 'best', 0)).toBeNull();
    expect(l.status(610)!.text).toMatch(/no rotation model/);
  });
  it('filters by the shape label (Stooke\'s estimated limb fits only at Best)', async () => {
    const l = lib();
    await loaded(l, [807]);
    const I: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    expect(l.sceneShape(body(807, I), 'strict', 0)).toBeNull();
    expect(l.status(807)!.text).toMatch(/estimated, not admitted/);
    expect(l.sceneShape(body(807, I), 'best', 0)!.worstLabel).toBe('estimated');
  });
  it('keeps the ellipsoid when the orientation is unknown (Hyperion) and says why', async () => {
    const l = lib();
    await loaded(l, [607]);
    expect(l.sceneShape(body(607, [1, 0, 0, 0, 1, 0, 0, 0, 1]), 'complete', 0)).toBeNull();
    expect(l.status(607)!.text).toMatch(/orientation unknown — Hyperion's rotation is chaotic/);
  });
  it('places a radar model by its spin state with an estimated orientation (phase convention assumed)', async () => {
    const l = lib();
    l.sceneShape(body(-4661), 'best', 0);
    await l.whenIdle();
    expect(l.sceneShape(body(-4661), 'strict', 0)).toBeNull();
    expect(l.status(-4661)!.text).toMatch(/orientation is estimated/);
    const s = l.sceneShape(body(-4661), 'best', 1e8)!;
    expect(s.worstLabel).toBe('estimated');
    // pole at ecliptic (25°, 80°): z axis of the body frame
    const ecl = 23.4392911 * Math.PI / 180;
    const p = [s.orient[2], s.orient[5], s.orient[8]];
    const z = -Math.sin(ecl) * p[1] + Math.cos(ecl) * p[2];
    expect(Math.asin(z) * 180 / Math.PI).toBeCloseTo(80, 6);
  });
});

describe('snapshot: a mesh only for a body at least a pixel across', () => {
  it('draws the estimated Larissa mesh up close and keeps the distant point derived', async () => {
    const l = lib();
    await loaded(l, [807]);
    const bodies = [fakeBody(10, 'Sun', 'star', { r: 500 }), fakeBody(807, 'Larissa', 'moon', { r: 97, albedo: 'derived', phase: 'derived' })];
    const eph = new FakeEphemerisSet({ 10: () => [0, 0, 0], 807: () => [1e8, 0, 0] });
    const core = { apparentPosition: makeApparent(299792.458), bodyToIcrf: fakeBodyToIcrf };
    const camera: SceneCamera = { orient: [1, 0, 0, 0, 1, 0, 0, 0, 1], fovY: 1, width: 100, height: 100 };  // 0.011 rad/px
    const at = (dKm: number) => {
      const world = computeWorld(0, [1e8 - dKm, 0, 0], bodies, eph, core, 10);
      const s = buildSnapshot({
        world, camera, reality: defaultReality(), light: fakeLight(), selectedId: null, orbits: [],
        orientations: new IauOrientationSet(bodies, fakeBodyToIcrf), extras: { surfaces: new Map(), rings: null, shapes: l },
      });
      return s.bodies.find((b) => b.id === 807)!;
    };
    const near = at(5000);  // 3.5 px across
    expect(near.shape?.key).toBe('shapes/807');
    expect(near.worstLabel).toBe('estimated');
    expect(l.status(807)!.drawn).toBe(true);
    const far = at(1e6);  // 0.02 px: a point from the disk photometry
    expect(far.shape).toBeUndefined();
    expect(far.worstLabel).toBe('derived');
    expect(l.status(807)).toMatchObject({ drawn: false, text: expect.stringMatching(/under a pixel across/) });
  });
});

describe('radar spin states', () => {
  it('rejects tumblers and incomplete states', () => {
    expect(radarSpin([{ name: 'Euler_angle_of_rotation_at_t0_year', value: 1 }], () => 0)).toEqual({ error: expect.stringMatching(/non-principal-axis/) });
    expect(radarSpin([{ name: 'Pole_longitude', value: 1 }], () => 0)).toEqual({ error: expect.stringMatching(/incomplete/) });
  });
});
