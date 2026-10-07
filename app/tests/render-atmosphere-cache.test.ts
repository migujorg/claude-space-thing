import { expect, it } from 'vitest';
import { AtmosphereTableCache, atmosphereTableKey, type AtmosphereTableStore } from '../src/render/atmosphereCache';
import { precomputeAtmosphere } from '../src/render/atmosphere';
import { fixtureRayleighAtmosphere } from './fixtures/atmosphere';

const { cpuUsage } = await import(/* @vite-ignore */ 'node:process' as string);
const store = (): AtmosphereTableStore => {
  const bytes = new Map<string, ArrayBuffer>();
  return { get: async (key) => bytes.get(key)?.slice(0), put: async (key, value) => { bytes.set(key, value.slice(0)); } };
};

it('keys the kept table by every model input and the computation, independent of object identity or property order', async () => {
  const model = fixtureRayleighAtmosphere();
  const key = await atmosphereTableKey(model);
  expect(key).toMatch(/^[0-9a-f]{64}$/);
  expect(await atmosphereTableKey(structuredClone(model))).toBe(key);
  expect(await atmosphereTableKey(Object.fromEntries(Object.entries(model).reverse()) as typeof model)).toBe(key);
  for (const field of ['bottomKm', 'topKm', 'altitudesKm', 'wavelengthsNm', 'weights', 'species', 'groundAlbedo', 'multipleScattering', 'msScale'] as const) {
    const changed = structuredClone(model);
    switch (field) {
      case 'bottomKm': changed.bottomKm += 1; break;
      case 'topKm': changed.topKm += 1; break;
      case 'altitudesKm': changed.altitudesKm[1] += 1; break;
      case 'wavelengthsNm': changed.wavelengthsNm[0] += 1; break;
      case 'weights': changed.weights[0][0] += 0.01; break;
      case 'species': changed.species[0].scattering[0][0] *= 2; break;
      case 'groundAlbedo': changed.groundAlbedo[0] += 0.01; break;
      case 'multipleScattering': changed.multipleScattering = 'orders'; break;
      case 'msScale': changed.msScale = [[0.1]]; break;
    }
    expect(await atmosphereTableKey(changed), field).not.toBe(key);
  }
  expect(await atmosphereTableKey(model, 'changed computation')).not.toBe(key);
});

it.each(['hillaire', 'orders'] as const)('a fresh cache reads identical %s tables without computing them again, under 100 ms of process CPU', async (solver) => {
  const model = fixtureRayleighAtmosphere();
  model.multipleScattering = solver;
  const disk = store();
  let calls = 0;
  const compute = async () => { calls++; return precomputeAtmosphere(model); };
  const original = await new AtmosphereTableCache(disk).get(model, compute);
  const start = cpuUsage();
  const kept = await new AtmosphereTableCache(disk).get(structuredClone(model), compute);
  const elapsed = cpuUsage(start);
  expect((elapsed.user + elapsed.system) / 1000).toBeLessThan(100);
  expect(calls).toBe(1);
  expect(kept).toEqual(original);
  console.log(`[atmosphere-cache] ${solver} persistent hit: ${((elapsed.user + elapsed.system) / 1000).toFixed(3)} ms process CPU; ${Object.values(kept).reduce((sum: number, v) => sum + (v instanceof Float32Array ? v.byteLength : 0), 0)} table bytes; float32 difference 0`);
  // Two simultaneous requests share even the first computation.
  const memory = new AtmosphereTableCache(null);
  const [a, b] = await Promise.all([memory.get(model, compute), memory.get(model, compute)]);
  expect(a).toBe(b);
  expect(calls).toBe(2);
}, 60000);

it('cache absence, unreadable records and denied writes compute the same table', async () => {
  const model = fixtureRayleighAtmosphere();
  const table = precomputeAtmosphere(model);
  let calls = 0;
  for (const disk of [null, { get: async () => new ArrayBuffer(1), put: async () => {} },
    { get: async () => { throw Error('unavailable'); }, put: async () => { throw Error('quota'); } }]) {
    const cache = new AtmosphereTableCache(disk);
    expect(await cache.get(model, async () => { calls++; return table; })).toBe(table);
  }
  expect(calls).toBe(3);
}, 60000);
