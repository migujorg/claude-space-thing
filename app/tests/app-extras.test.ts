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

  it('ring components replace the profile where admitted, carrying the emission time; strict keeps the profile', () => {
    const comps = { value: { kind: 'ring-components-v1', components: [], phaseFunctions: {} } as never, label: 'estimated' as const, sources: ['c'] };
    const ex: SceneExtras = { surfaces, rings: { '1': { ...ring, components: comps } } };
    const best = scene();
    applyExtras(best, body(1), ex, 'best', true, 1234.5);
    expect(best.rings?.components).toBe(comps.value);
    expect(best.rings?.et).toBe(1234.5);
    expect(best.rings?.worstLabel).toBe('estimated');
    const strict = scene();
    applyExtras(strict, body(1), ex, 'strict', true, 1234.5);
    expect(strict.rings?.components).toBeUndefined();
    expect(strict.rings?.opticalDepth[0].normalTau).toEqual([0.5, null]);
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

  it('draws a surface-only map with its clouds, water, night and wind layers once the atmosphere is admitted', () => {
    const abs = { normalization: { absoluteDiskMean: { X: 0.03, Y: 0.03, Z: 0.03, S: 0.03 } } };
    const layers = surfaceRefs([
      layer(1, 'albedo', { maxLevel: 3, brightness: { label: 'measured' }, color: { label: 'estimated' }, ...abs }),
      layer(1, 'clouds', { maxLevel: 3, kind: 'cloud-properties', brightness: { label: 'measured' } }),
      layer(1, 'water', { maxLevel: 3, kind: 'surface-water', brightness: { label: 'measured' } }),
      layer(1, 'night', { maxLevel: 3, kind: 'emitted-radiance', brightness: { label: 'measured' }, color: { label: 'estimated' } }),
      layer(1, 'wind', { maxLevel: 2, kind: 'surface-wind', brightness: { label: 'measured' } }),
    ], '/data');
    const comp = (l: string) => ({ id: 'rayleigh', description: '', extinctionPerKm: { value: [[1]], label: l, sources: [] }, singleScatteringAlbedo: { value: [1], label: 'derived', sources: [] }, phaseFunction: { value: { kind: 'rayleigh', depolarization: [0] }, label: 'derived', sources: [] } });
    const atmospheres = { definition: '', wavelengthsNm: [550], channels: ['X', 'Y', 'Z', 'S'], foldWeights: { value: [[1], [1], [1], [1]], label: 'derived', sources: [] }, bodies: { '1': { name: 'X', naifId: 1, referenceRadiusKm: 1, altitudeReference: '', altitudesKm: [0], topAltitudeKm: 1, topRadiusKm: 2, scaleHeightKm: { value: 1, label: 'derived', sources: [] }, components: [comp('estimated')] } } } as unknown as SceneExtras['atmospheres'];
    const best = scene();
    applyExtras(best, body(1), { surfaces: layers, rings: null, atmospheres }, 'best', true);
    expect(best.surface?.albedo).toBeDefined();
    expect(best.surface?.clouds && best.surface.water && best.surface.night && best.surface.wind).toBeTruthy();
    expect(best.atmosphere?.worstLabel).toBe('estimated');
    // Strict: the atmosphere (estimated) is not admitted, so the surface-only map stays withheld.
    const strict = scene();
    applyExtras(strict, body(1), { surfaces: layers, rings: null, atmospheres }, 'strict', true);
    expect(strict.surface?.albedo).toBeUndefined();
    expect(strict.atmosphere).toBeUndefined();
  });

  it('gives the cloud without a retrieval the partly-cloudy statistic at Best (estimated), never at Strict', () => {
    const abs = { normalization: { absoluteDiskMean: { X: 0.03, Y: 0.03, Z: 0.03, S: 0.03 } } };
    const unmeasuredTau = { label: 'estimated', sources: ['s'], value: { tauBinLnCentre: [-0.471, 0.772], statistics: { floorCellsZero: { partlyCloudyAllHeights: { binProbability: [0.6, 0.4] } } } } };
    const layers = surfaceRefs([
      layer(1, 'albedo', { maxLevel: 3, brightness: { label: 'measured' }, color: { label: 'measured' }, ...abs }),
      layer(1, 'clouds', { maxLevel: 3, kind: 'cloud-properties', brightness: { label: 'measured' } }),
      layer(1, 'cloudTau', { maxLevel: 3, kind: 'cloud-optical-thickness-moments', brightness: { label: 'measured' }, constants: { unmeasuredTau } }),
    ], '/data');
    const comp = { id: 'rayleigh', description: '', extinctionPerKm: { value: [[1]], label: 'derived', sources: [] }, singleScatteringAlbedo: { value: [1], label: 'derived', sources: [] }, phaseFunction: { value: { kind: 'rayleigh', depolarization: [0] }, label: 'derived', sources: [] } };
    const atmospheres = { definition: '', wavelengthsNm: [550], channels: ['X', 'Y', 'Z', 'S'], foldWeights: { value: [[1], [1], [1], [1]], label: 'derived', sources: [] }, bodies: { '1': { name: 'X', naifId: 1, referenceRadiusKm: 1, altitudeReference: '', altitudesKm: [0], topAltitudeKm: 1, topRadiusKm: 2, scaleHeightKm: { value: 1, label: 'derived', sources: [] }, components: [comp] } } } as unknown as SceneExtras['atmospheres'];
    const best = scene();
    const usedBest = applyExtras(best, body(1), { surfaces: layers, rings: null, atmospheres }, 'best', true);
    expect(best.surface?.cloudTau).toBeDefined();
    expect(best.surface?.cloudTauUnmeasured?.taus).toEqual([Math.exp(-0.471), Math.exp(0.772)]);
    expect(best.surface?.cloudTauUnmeasured?.p).toEqual([0.6, 0.4]);
    expect(usedBest).toContain('estimated');
    // Strict: the measured layers are drawn, the cloud without a retrieval stays unknown.
    const strict = scene();
    const usedStrict = applyExtras(strict, body(1), { surfaces: layers, rings: null, atmospheres }, 'strict', true);
    expect(strict.surface?.cloudTau).toBeDefined();
    expect(strict.surface?.cloudTauUnmeasured).toBeUndefined();
    expect(usedStrict).not.toContain('estimated');
  });

  it('attaches an admitted atmosphere to a body drawn from its photometry (unknown scattering does not withhold it)', () => {
    const comp = (id: string, ext: string, ssa: string) => ({ id, description: '', extinctionPerKm: { value: [[1]], label: ext, sources: [] }, singleScatteringAlbedo: { value: ssa === 'unknown' ? null : [1], label: ssa, sources: [] }, phaseFunction: { value: ssa === 'unknown' ? null : { kind: 'rayleigh', depolarization: [0] }, label: ssa, sources: [] } });
    const entry = (components: unknown[]) => ({ name: 'X', naifId: 1, referenceRadiusKm: 1, altitudeReference: '', altitudesKm: [0], topAltitudeKm: 1, topRadiusKm: 2, scaleHeightKm: { value: 1, label: 'derived', sources: [] }, components });
    const file = (components: unknown[]) => ({ definition: '', wavelengthsNm: [550], channels: ['X', 'Y', 'Z', 'S'], foldWeights: { value: [[1], [1], [1], [1]], label: 'derived', sources: [] }, bodies: { '1': entry(components) } }) as unknown as SceneExtras['atmospheres'];
    const plain: SceneExtras = { surfaces: new Map(), rings: null, atmospheres: file([comp('dust', 'estimated', 'derived')]) };
    const sb = scene();
    applyExtras(sb, body(1), plain, 'best', true);
    expect(sb.atmosphere?.worstLabel).toBe('estimated');
    const strict = scene();
    applyExtras(strict, body(1), plain, 'strict', true);
    expect(strict.atmosphere).toBeUndefined();
    const dark = scene();
    applyExtras(dark, body(1), plain, 'best', false);
    expect(dark.atmosphere).toBeUndefined();
    // Titan-like: haze scattering unknown, extinction estimated → passed (the renderer marks it not measured).
    const titan = scene();
    applyExtras(titan, body(1), { ...plain, atmospheres: file([comp('rayleigh', 'estimated', 'derived'), comp('haze', 'estimated', 'unknown')]) }, 'best', true);
    expect(titan.atmosphere?.worstLabel).toBe('estimated');
    // Unknown extinction → nothing to draw at all.
    const none = scene();
    applyExtras(none, body(1), { ...plain, atmospheres: file([comp('haze', 'unknown', 'unknown')]) }, 'best', true);
    expect(none.atmosphere).toBeUndefined();
  });

  it('ring normal is the body z axis in ICRF', () => {
    expect(poleOf([1, 0, 0.1, 0, 1, 0.2, 0, 0, 0.97])).toEqual([0.1, 0.2, 0.97]);
  });
});
