import { describe, expect, it } from 'vitest';
import { applyExtras, poleOf, surfaceRefs, type SceneExtras } from '../src/app/extras';
import type { Body, RingSystem } from '../src/data/schema';
import type { SurfaceLayer } from '../src/data/surfaces';
import type { Mat3, SceneBody } from '../src/render/scene';

const layer = (bodyId: number, name: string, header: Record<string, unknown>): SurfaceLayer => ({
  bodyId, layer: name, path: `surfaces/${bodyId}/${name}.json`, tilePrefix: '', levels: 1, label: 'unknown', sources: [],
  epoch: null, method: null, notes: null, tiles: { count: 0, bytes: 0 }, header,
});

const ROT: Mat3 = [0, -1, 0, 1, 0, 0, 0, 0, 1];
const body = (id: number): Body => ({ id, name: 'X', kind: 'planet', ephemeris: '', radii: { value: [1, 1, 1], label: 'measured', sources: [] }, gm: { value: null, label: 'unknown', sources: [] }, rotation: { value: null, label: 'unknown', sources: [] } } as unknown as Body);
const scene = (): SceneBody => ({ id: 1, name: 'X', pos: [0, 0, 0], toSun: [1, 0, 0], orient: ROT, radii: [1, 1, 1], albedoXYZS: [1, 1, 1, 1], phase: { kind: 'lambert' }, surfaceUnknown: false, worstLabel: 'derived', selected: false });

describe('scene extras', () => {
  const surfaces = surfaceRefs([
    layer(1, 'albedo', { maxLevel: 3, brightness: { label: 'derived' }, color: { label: 'estimated' } }),
    layer(1, 'height', { maxLevel: 2, brightness: { label: 'measured' } }),
  ], '/data/');
  const ring: RingSystem = {
    planet: 1,
    opticalDepth: { value: [{ name: 'main', radiusKm: [2, 3], normalTau: [0.5, null], observation: {} as never }] as never, label: 'measured', sources: ['s'] },
    reflectance: { value: { kind: 'single-scattering-v1' } as never, label: 'estimated', sources: ['r'] },
  };
  const extras: SceneExtras = { surfaces, rings: { '1': ring } };

  it('albedo maps carry their worst label; height keeps its own', () => {
    expect(surfaces.get(1)!.albedo!.label).toBe('estimated');
    expect(surfaces.get(1)!.height!.label).toBe('measured');
    expect(surfaces.get(1)!.albedo!.ref.url).toBe('/data');
  });

  it('strict drops estimated maps and ring reflectance but keeps measured relief and optical depth', () => {
    const sb = scene();
    const used = applyExtras(sb, body(1), extras, 'strict', true);
    expect(sb.surface?.albedo).toBeUndefined();
    expect(sb.surface?.height).toBeDefined();
    expect(sb.rings?.reflectance).toBeNull();
    expect(sb.rings?.opticalDepth[0].normalTau).toEqual([0.5, null]);
    expect(used).not.toContain('estimated');
  });

  it('best estimate admits everything and reports it', () => {
    const sb = scene();
    const used = applyExtras(sb, body(1), extras, 'best', true);
    expect(sb.surface?.albedo).toBeDefined();
    expect(sb.rings?.reflectance).not.toBeNull();
    expect(sb.rings?.worstLabel).toBe('estimated');
    expect(used).toContain('estimated');
  });

  it('no body frame → no maps or rings; unlit → no albedo map', () => {
    const sb = { ...scene(), orient: null };
    applyExtras(sb, body(1), extras, 'best', true);
    expect(sb.surface).toBeUndefined();
    expect(sb.rings).toBeUndefined();
    const dark = scene();
    applyExtras(dark, body(1), extras, 'best', false);
    expect(dark.surface?.albedo).toBeUndefined();
  });

  it('withholds surface-only maps (Earth) that disk photometry must not scale', () => {
    const earth: SceneExtras = { surfaces: surfaceRefs([layer(1, 'albedo', { maxLevel: 3, brightness: { label: 'measured' }, color: { label: 'estimated' }, normalization: { absoluteDiskMean: { X: 0.03, Y: 0.03, Z: 0.03, S: 0.03 } } })], '/data'), rings: null };
    const sb = scene();
    applyExtras(sb, body(1), earth, 'best', true);
    expect(sb.surface?.albedo).toBeUndefined();
  });

  it('ring normal is the body z axis in ICRF', () => {
    expect(poleOf([1, 0, 0.1, 0, 1, 0.2, 0, 0, 0.97])).toEqual([0.1, 0.2, 0.97]);
  });
});
