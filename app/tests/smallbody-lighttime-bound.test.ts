// CPU twin of the population shaders' light-time approximation; see architecture §3.4.
import { describe, expect, it } from 'vitest';
import { C_KM_S, AU_KM } from '../src/core/constants';
import { apparentPosition } from '../src/core/lighttime';
import { SB_OK, SmallBodyPropagator } from '../src/core/smallbody';
import { centerStateFrom, readSynthetic, syntheticCenter, syntheticState } from '../src/core/smallbodySynthetic';
import { shadeShader, syntheticShader } from '../src/gpu/smallbodies/kernels';
import type { SmallBodyCoreHeader, SmallBodyForceModel, SyntheticObjectsHeader } from '../src/data/schema';
import type { Vec3 } from '../src/core/vec';
import { cross, dot, norm, distance } from '../src/core/vec';
import { DATA_DIR, fixture, loadEphemerisSet, notCompared } from './core-data';

const io: {
  existsSync(p: string): boolean;
  readFileSync(p: string | URL, enc: 'utf8'): string;
  openSync(p: string, mode: 'r'): number;
  readSync(fd: number, b: Uint8Array, offset: number, length: number, position: number): number;
  closeSync(fd: number): void;
  createReadStream(p: string): unknown;
} = await import(/* @vite-ignore */ 'node:fs' as string);
const readline: { createInterface(o: { input: unknown; crlfDelay: number; }): AsyncIterable<string>; } =
  await import(/* @vite-ignore */ 'node:readline' as string);
const ref = fixture<{ forceModel: SmallBodyForceModel; }>('smallbody_reference.json');

it('documents the population approximation and the tested budgets', () => {
  const architecture = io.readFileSync(new URL('../../docs/architecture.md', import.meta.url), 'utf8');
  const section = architecture.split('### 3.4 Apparent positions')[1].split('## 4. Light')[0];
  expect(section).toContain('first-order');
  expect(section).toContain('0.12 km; 0.002 arcsec');
  expect(section).toContain('0.07 km; 0.00035 arcsec');
});

// Shader source guards tie the CPU transcription below to BOTH generated kernels. A source edit must update
// the twin and re-establish the numerical bound. These tests do not execute WGSL or bound GPU float32 error.
it('keeps both shaders coupled to the tested geometric-delay and SSB-velocity formula', () => {
  const config = { model: ref.forceModel, samples: 16, cKmS: C_KM_S, auKm: AU_KM, photometry: null };
  const shade = shadeShader(config).replace(/\s+/g, ' ');
  const synthetic = syntheticShader({
    gmSun: ref.forceModel.sun.gm, auKm: AU_KM, cKmS: C_KM_S,
    obliquityRad: ref.forceModel.obliquityArcsec * Math.PI / (180 * 3600), slopeG: 0,
    classColours: [], photometry: null
  }).replace(/\s+/g, ' ');
  expect(shade).toContain('let tau = length(rel) / C_KM_S; rel = rel - tau * (st.vh + FR.sunV.xyz);');
  expect(synthetic).toContain('let tau = length(rel) / C_KM_S; rel = rel - tau * vssb;');
  expect(synthetic).toContain('vssb = vel + U.sunV.xyz;');
  expect(synthetic).toContain('vssb = vel + U.cen[cid - 1u + 4u].xyz;');
});

function firstOrder(rel: Vec3, velocitySSB: Vec3): Vec3 {
  const tau = norm(rel) / C_KM_S;
  return rel.map((x, j) => x - tau * velocitySSB[j]) as Vec3;
}

it('has the predicted O(v²/c²) delay error against an exact uniform-motion solution', () => {
  const rel: Vec3 = [3e6, -1e6, 5e5], v: Vec3 = [40, 20, -10]; // mathematical test inputs, no data product
  const ap = apparentPosition({ positionSSB: (_id: number, t: number): Vec3 => rel.map((x, j) => x + v[j] * t) as Vec3 }, 0, [0, 0, 0], 0)!;
  // c²τ² = |rel-vτ|², positive root, in a cancellation-free form.
  const rv = dot(rel, v), den = C_KM_S ** 2 - dot(v, v);
  const tau = dot(rel, rel) / (Math.sqrt(rv * rv + den * dot(rel, rel)) + rv);
  expect(Math.abs(ap.lightTime - tau)).toBeLessThan(1e-9);
  const first = firstOrder(rel, v), error = first.map((x, j) => x - ap.rel[j]) as Vec3;
  const leading = v.map(x => -x * rv / C_KM_S ** 2) as Vec3;
  expect(distance(error, leading) / norm(leading)).toBeLessThan(0.001);
});

it('includes the omitted acceleration in the leading error', () => {
  const rel: Vec3 = [3e6, -1e6, 5e5], v: Vec3 = [40, 20, -10], a: Vec3 = [0.001, -0.002, 0.0005];
  const ap = apparentPosition({
    positionSSB: (_id: number, t: number): Vec3 => rel.map((x, j) => x + v[j] * t + 0.5 * a[j] * t * t) as Vec3,
  }, 0, [0, 0, 0], 0)!;
  const tau0 = norm(rel) / C_KM_S;
  const first = firstOrder(rel, v), error = first.map((x, j) => x - ap.rel[j]) as Vec3;
  const leading = v.map((x, j) => -x * dot(rel, v) / C_KM_S ** 2 - 0.5 * a[j] * tau0 ** 2) as Vec3;
  expect(distance(error, leading) / norm(leading)).toBeLessThan(0.001);
});

const eph = loadEphemerisSet(['ephem/de442s', 'ephem/centers']);
const corePath = DATA_DIR + 'smallbodies/core.json';
const header: SmallBodyCoreHeader | null = io.existsSync(corePath) ? JSON.parse(io.readFileSync(corePath, 'utf8')) : null;
function sliceState(row: number): Float64Array {
  const b = new Uint8Array(header!.stride), fd = io.openSync(DATA_DIR + header!.bin, 'r');
  try { expect(io.readSync(fd, b, 0, b.length, row * b.length)).toBe(b.length); } finally { io.closeSync(fd); }
  const view = new DataView(b.buffer);
  return Float64Array.from({ length: 6 }, (_, j) => view.getFloat64(j * 8, true));
}
function checkedError(stateAt: (t: number) => Float64Array | null, observerId: number, et: number): { km: number; arcsec: number; uncorrectedKm: number; } {
  const state = stateAt(et)!;
  const sun = eph!.positionSSB(10, et)!, sa = eph!.positionSSB(10, et - 1)!, sb = eph!.positionSSB(10, et + 1)!;
  const obs = eph!.positionSSB(observerId, et)!;
  const rel = [0, 1, 2].map(j => state[j] + sun[j] - obs[j]) as Vec3;
  const v = [0, 1, 2].map(j => state[j + 3] + (sb[j] - sa[j]) / 2) as Vec3;
  const first = firstOrder(rel, v);
  const ap = apparentPosition({
    positionSSB: (_id: number, t: number): Vec3 | null => {
      const s = stateAt(t), su = eph!.positionSSB(10, t); return s && su ? [s[0] + su[0], s[1] + su[1], s[2] + su[2]] : null;
    },
  }, 0, obs, et);
  expect(ap).not.toBeNull();
  return {
    km: distance(first, ap!.rel), arcsec: Math.atan2(norm(cross(first, ap!.rel)), dot(first, ap!.rel)) * 180 / Math.PI * 3600,
    uncorrectedKm: distance(rel, ap!.rel)
  };
}

// The numerical survey is in the lane's evaluate-lighttime.mjs/evaluation.json. Keep the maxima and the deepest
// Earth encounters as compact regression cases. Identity is SPK-ID, not a row that a catalogue rebuild can move.
const cases = [
  { spkid: '54527085', des: '2025 HA', anchorEt: 797352386.9430139, et: 797265986.9430139 },
  { spkid: '54564655', des: '2025 WV13', anchorEt: 817558208.5025758, et: 817561808.5025758 },
  { spkid: '54549695', des: '2025 TF', anchorEt: 812551733.0236405, et: 812551733.0236405 },
  { spkid: '54555306', des: '2025 UC11', anchorEt: 815098262.6442835, et: 815098262.6442835 },
];
const rows = new Map<string, number>();
if (header && eph) {
  const wanted = new Set(cases.map(c => c.spkid));
  let row = 0;
  for await (const line of readline.createInterface({ input: io.createReadStream(DATA_DIR + 'smallbodies/names.txt'), crlfDelay: Infinity })) {
    const id = line.split('\t', 1)[0]; if (wanted.has(id)) rows.set(id, row); row++;
    if (rows.size === wanted.size) break;
  }
}
describe.skipIf(!header || !eph)('first-order population light time against iterated float64 orbits (built catalogue)', () => {
  for (const c of cases) {
    const covered = header && c.et > header.window.startEt + 3600 && c.et < header.window.endEt - 3600;
    if (header && !covered) { notCompared(c.des + ' light-time bound', 'the fixed regression epoch is outside this build window'); continue; }
    it(`${c.des} from Earth: below 0.12 km and 0.002 arcsec`, () => {
      expect(rows.has(c.spkid), c.des + ' absent from this catalogue').toBe(true);
      const prop = new SmallBodyPropagator(header!.forceModel, eph!), initial = sliceState(rows.get(c.spkid)!);
      expect(prop.propagateOne(initial, 0, header!.epochEt, c.anchorEt, header!.epochEt, null)).toBe(SB_OK);
      const stateAt = (t: number) => { const s = initial.slice(); return prop.propagateOne(s, 0, c.anchorEt, t, header!.epochEt, null) === SB_OK ? s : null; };
      const e = checkedError(stateAt, 399, c.et);
      expect(e.km).toBeLessThan(0.12);
      expect(e.arcsec).toBeLessThan(0.002);
      // Removing the correction must fail the budget by a substantial factor.
      expect(e.uncorrectedKm).toBeGreaterThan(0.12);
      console.log(`[light time] ${c.des}: ${e.km} km, ${e.arcsec} arcsec`);
    }, 30_000);
  }
});

const synPath = DATA_DIR + 'synthetic/objects.json';
const manifestPath = DATA_DIR + 'manifest.json';
const manifest: { products: Record<string, { sha256: string;}>; } | null = io.existsSync(manifestPath) ? JSON.parse(io.readFileSync(manifestPath, 'utf8')) : null;
const sh: SyntheticObjectsHeader | null = io.existsSync(synPath) ? JSON.parse(io.readFileSync(synPath, 'utf8')) : null;
describe.skipIf(!sh || !eph)('synthetic irregular moons: same approximation, host-planet observer', () => {
  for (const c of [{ row: 2970041, et: 817676528 }, { row: 2969819, et: 809256128 }]) {
    const covered = header && c.et > header.window.startEt + 86400 && c.et < header.window.endEt - 86400;
    // Synthetic stream indices are identities only within the stated catalogue realization.
    const sameRealization = sh?.catalogue.coreSha256 === '6decd4d6b6694a4f293d28cd82012644058604b42acb85528ffb67b53cfdd38f'
      && manifest?.products['synthetic/objects.bin']?.sha256 === 'c10046f33f7c34eaadca74f4121027b8aeb1dbcc4099897eb4d3d96eccd798de';
    if (sh && (!covered || !sameRealization)) {
      notCompared(`synthetic moon ${c.row} light-time bound`, !covered ? 'epoch outside this build window' : 'different synthetic realization: repeat the numerical survey'); continue;
    }
    it(`synthetic Jupiter moon ${c.row}: below 0.07 km and 0.00035 arcsec`, () => {
      const b = new Uint8Array(sh!.stride), fd = io.openSync(DATA_DIR + sh!.bin, 'r');
      try { expect(io.readSync(fd, b, 0, b.length, c.row * b.length)).toBe(b.length); } finally { io.closeSync(fd); }
      const syn = readSynthetic({ ...sh!, count: 1 }, b.buffer), center = syntheticCenter(syn, 0)!;
      expect(center.naifId).toBe(5);
      const cs = centerStateFrom(eph!, 10);
      const stateAt = (t: number) => { const s = syntheticState(syn, 0, t, cs); return s ? Float64Array.from([...s.pos, ...s.vel]) : null; };
      const e = checkedError(stateAt, 599, c.et);
      expect(e.km).toBeLessThan(0.07);
      expect(e.arcsec).toBeLessThan(0.00035);
      expect(e.uncorrectedKm).toBeGreaterThan(0.07);
      console.log(`[light time] synthetic moon ${c.row}: ${e.km} km, ${e.arcsec} arcsec`);
    });
  }
});
