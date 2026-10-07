// Full float32 byte hashes captured from db55a5b BEFORE optimizing either solver. These are test evidence,
// never data products. Changed built model inputs require a reference recomputation from that commit.
import { expect, it } from 'vitest';
import { atmosphereModelFromData, precomputeAtmosphere, ProfileGrid } from '../src/render/atmosphere';
import type { AtmosphereFile, BodyPhotometry, LightData } from '../src/data/schema';
import reference from './fixtures/atmosphere-table-hashes.json';
import { DATA_DIR } from './core-data';
const fs = await import(/* @vite-ignore */ 'node:fs' as string);
const { createHash } = await import(/* @vite-ignore */ 'node:crypto' as string);
const { cpuUsage } = await import(/* @vite-ignore */ 'node:process' as string);
const built = fs.existsSync(DATA_DIR + 'atmospheres.json');
const hash = (x: Uint8Array | string): string => createHash('sha256').update(x).digest('hex');
it.skipIf(!built)('every built atmosphere retains every bit of every reference table', () => {
  const af = JSON.parse(fs.readFileSync(DATA_DIR + 'atmospheres.json', 'utf8')) as AtmosphereFile;
  const ph = JSON.parse(fs.readFileSync(DATA_DIR + 'photometry.json', 'utf8')) as Record<string, BodyPhotometry>;
  const light = JSON.parse(fs.readFileSync(DATA_DIR + 'light.json', 'utf8')) as LightData;
  expect(Object.keys(af.bodies).sort()).toEqual(reference.bodies.map((b) => b.id).sort());
  for (const ref of reference.bodies) {
    const body = af.bodies[ref.id];
    const ground = ph[ref.id]?.geometricAlbedoXYZS.value?.map((v, c) => Math.min(1, 1.5 * v / light.sun.irradianceXYZS_1AU.value![c])) ?? 0;
    const opts = body.surfaceReflectance?.value ? { groundPerSample: body.surfaceReflectance.value.reflectance, multipleScattering: 'orders' as const } : {};
    const r = atmosphereModelFromData({ wavelengthsNm: af.wavelengthsNm, foldWeights: af.foldWeights.value!, body }, ground, 1, opts);
    if ('error' in r) { expect(r.error).toBe(ref.error); continue; }
    // A fixture-input mismatch is not evidence of a solver regression. Fail explicitly, without rewriting it.
    expect(hash(JSON.stringify(r.model)), `${ref.name}: reference model inputs changed`).toBe(ref.modelSha256);
    // Bound redundant full-profile evaluations, independent of shared-machine scheduling. The old solver
    // exceeds six million per body. Geometry reused across Sun angles needs fewer than 100,000.
    let profileCalls = 0;
    const at = ProfileGrid.prototype.at;
    ProfileGrid.prototype.at = function(h, out) { profileCalls++; return at.call(this, h, out); };
    const start = cpuUsage();
    let tables;
    try { tables = precomputeAtmosphere(r.model); }
    finally { ProfileGrid.prototype.at = at; }
    const dt = cpuUsage(start), cpuMs = (dt.user + dt.system) / 1000;
    const arrays = Object.entries(tables).filter(([, v]) => v instanceof Float32Array) as [string, Float32Array][];
    expect(tables.K).toBe(ref.K);
    expect(arrays.map(([key]) => key).sort()).toEqual(Object.keys(ref.tables!).sort());
    for (const [key, v] of arrays) {
      const expected = (ref.tables as Record<string, { bytes: number; sha256: string }>)[key];
      expect(v.byteLength, `${ref.name}/${key}`).toBe(expected.bytes);
      expect(hash(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)), `${ref.name}/${key}: full table bytes`).toBe(expected.sha256);
    }
    expect.soft(profileCalls, `${ref.name}: redundant full-profile work`).toBeLessThan(100000);
    console.log(`[atmosphere CPU] ${ref.name}: ${cpuMs.toFixed(3)} ms; ${profileCalls} full-profile lookups; ${arrays.reduce((s, [,v]) => s + v.byteLength, 0)} bytes`);
  }
}, 120000);
