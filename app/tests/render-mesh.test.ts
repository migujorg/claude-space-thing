import { describe, expect, it } from 'vitest';
import { meanProjectedArea } from '../src/render/meshes/area';
import { decodeLod, surfaceArea } from '../src/render/meshes/format';
import { chooseLod, drawableLod, edgeKm } from '../src/render/meshes/lod';
import type { SceneShapeLod } from '../src/render/scene';

/** Icosphere of radius r with `sub` subdivisions (outward, counter-clockwise faces). */
function icosphere(r: number, sub: number, centre: [number, number, number] = [0, 0, 0]): { pos: number[]; idx: number[] } {
  const t = (1 + Math.sqrt(5)) / 2;
  let v: number[][] = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
  let f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  v = v.map((p) => { const l = Math.hypot(p[0], p[1], p[2]); return p.map((x) => x / l); });
  for (let s = 0; s < sub; s++) {
    const cache = new Map<string, number>();
    const mid = (a: number, b: number) => {
      const k = a < b ? `${a},${b}` : `${b},${a}`;
      let i = cache.get(k);
      if (i === undefined) {
        const p = [0, 1, 2].map((j) => (v[a][j] + v[b][j]) / 2);
        const l = Math.hypot(p[0], p[1], p[2]);
        v.push(p.map((x) => x / l));
        cache.set(k, (i = v.length - 1));
      }
      return i;
    };
    const nf: number[][] = [];
    for (const [a, b, c] of f) {
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    f = nf;
  }
  return { pos: v.flatMap((p) => p.map((x, j) => x * r + centre[j])), idx: f.flat() };
}

const CUBE_V = [[-1, -1, -1], [-1, -1, 1], [-1, 1, -1], [-1, 1, 1], [1, -1, -1], [1, -1, 1], [1, 1, -1], [1, 1, 1]];
const CUBE_F = [[0, 1, 3], [0, 3, 2], [4, 6, 7], [4, 7, 5], [0, 4, 5], [0, 5, 1], [2, 3, 7], [2, 7, 6], [0, 2, 6], [0, 6, 4], [1, 5, 7], [1, 7, 3]];

describe('mean projected area (energy normalization)', () => {
  it('is πr² for a sphere and area/4 for a cube (Cauchy)', () => {
    const s = icosphere(3, 4);
    const pos = new Float32Array(s.pos);
    const a = meanProjectedArea(pos, s.idx, s.idx.length / 3, 3);
    expect(a / (Math.PI * 9)).toBeCloseTo(1, 1);
    expect(Math.abs(a / (Math.PI * 9) - 1)).toBeLessThan(0.02);
    const cube = new Float32Array(CUBE_V.flat());
    const ac = meanProjectedArea(cube, CUBE_F.flat(), 12, Math.sqrt(3));
    expect(Math.abs(ac / 6 - 1)).toBeLessThan(0.02);
  });
  it('is below area/4 for a non-convex body (two lobes shadowing each other)', () => {
    const a = icosphere(1, 3, [-1.2, 0, 0]), b = icosphere(1, 3, [1.2, 0, 0]);
    const pos = new Float32Array([...a.pos, ...b.pos]);
    const idx = [...a.idx, ...b.idx.map((i) => i + a.pos.length / 3)];
    const ap = meanProjectedArea(pos, idx, idx.length / 3, 2.2);
    const A = surfaceArea(pos, idx, idx.length / 3);
    expect(ap).toBeLessThan(0.95 * (A / 4));
    expect(ap).toBeGreaterThan(0.6 * (A / 4));
  });
});

describe('LOD decoding', () => {
  it('decodes a ShapeModelHeader level (float32, snorm16 normals, u16 indices) and a DAMIT polyhedron', () => {
    const nv = 8, nf = 12;
    const pos = new Float32Array(CUBE_V.flat());
    const nrm = new Int16Array(CUBE_V.flat().map((x) => Math.round((x / Math.sqrt(3)) * 32767)));
    const idx = new Uint16Array([...CUBE_F.flat()]);
    const buf = new Uint8Array(96 + 48 + 72);
    buf.set(new Uint8Array(pos.buffer), 0);
    buf.set(new Uint8Array(nrm.buffer), 96);
    buf.set(new Uint8Array(idx.buffer), 144);
    const lod: SceneShapeLod = {
      url: 'x', offset: 0, bytes: buf.byteLength, triangles: nf, vertices: nv, format: 'shape',
      parts: { positions: { offset: 0, bytes: 96 }, normals: { offset: 96, bytes: 48 }, indices: { offset: 144, bytes: 72, type: 'u16' } },
    };
    const d = decodeLod(buf.buffer, lod);
    expect(Array.from(d.positions)).toEqual(Array.from(pos));
    expect(d.normals.length).toBe(32);
    expect(d.normals[4 * 7 + 3]).toBe(0);
    expect(Array.from(d.indices)).toEqual(CUBE_F.flat());
    expect(d.boundRadius).toBeCloseTo(Math.sqrt(3), 6);
    expect(d.area).toBeCloseTo(24, 6);

    const q = new Int16Array(CUBE_V.flat().map((x) => x * 32767));
    const dbuf = new Uint8Array(48 + 72);
    dbuf.set(new Uint8Array(q.buffer), 0);
    dbuf.set(new Uint8Array(idx.buffer), 48);
    const dm = decodeLod(dbuf.buffer, { url: 'y', offset: 0, bytes: dbuf.byteLength, triangles: nf, vertices: nv, format: 'damit', quantScale: 2.5 });
    expect(dm.positions[21]).toBeCloseTo(2.5, 4);
    // computed normals point outward: corner (1, 1, 1) → (1, 1, 1)/√3
    const n7 = [dm.normals[28], dm.normals[29], dm.normals[30]].map((x) => x / 32767);
    expect(n7[0]).toBeCloseTo(1 / Math.sqrt(3), 3);
    expect(n7[2]).toBeCloseTo(1 / Math.sqrt(3), 3);
  });
});

describe('LOD choice', () => {
  const base = { triangles: [2_000_000, 500_000, 125_000, 31_250], areaKm2: 1600, boundRadiusKm: 14, pixelsPerRadian: 1000 };
  it('takes the coarsest level whose triangles stay under 1.5 px', () => {
    // far away: the coarsest level is enough
    expect(chooseLod({ ...base, distKm: 1e5 })).toBe(3);
    // 50 km from Phobos's centre at 1000 px/rad: edges of the 125 k level are ~0.1 km/36 km·1000 ≈ 4 px
    const k = chooseLod({ ...base, distKm: 50 });
    const px = (lvl: number) => (edgeKm(1600, base.triangles[lvl]) / 36) * 1000;
    expect(px(k)).toBeLessThanOrEqual(1.5);
    if (k < 3) expect(px(k + 1)).toBeGreaterThan(1.5);
    // closer than the finest level can serve: the finest
    expect(chooseLod({ ...base, distKm: 14.5 })).toBe(0);
  });
  it('draws the wanted level if resident, else the nearest finer, else the nearest coarser', () => {
    expect(drawableLod(2, [false, false, true, true])).toBe(2);
    expect(drawableLod(2, [true, false, false, true])).toBe(0);
    expect(drawableLod(1, [false, false, false, true])).toBe(3);
    expect(drawableLod(1, [false, false, false, false])).toBe(-1);
  });
});
