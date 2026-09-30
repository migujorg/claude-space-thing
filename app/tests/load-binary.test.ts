import { describe, expect, it } from 'vitest';
import { BinaryTable } from '../src/data/binaryTable';
import { buildStarCatalog, parseStarNames, resolveStarLayout, starDirection } from '../src/data/stars';
import type { BinaryTableHeader, Label } from '../src/data/schema';

/** Writes records with a DataView (little-endian) exactly as the header says. */
function pack(h: BinaryTableHeader, rows: Record<string, number[]>[]): ArrayBuffer {
  const buf = new ArrayBuffer(h.count * h.stride);
  const dv = new DataView(buf);
  rows.forEach((row, i) => {
    for (const f of h.fields) {
      const vals = row[f.name] ?? [];
      vals.forEach((v, k) => {
        const o = i * h.stride + f.offset;
        switch (f.type) {
          case 'f32': dv.setFloat32(o + 4 * k, v, true); break;
          case 'f64': dv.setFloat64(o + 8 * k, v, true); break;
          case 'u32': dv.setUint32(o + 4 * k, v, true); break;
          case 'i32': dv.setInt32(o + 4 * k, v, true); break;
          case 'u16': dv.setUint16(o + 2 * k, v, true); break;
          case 'u8': dv.setUint8(o + k, v); break;
        }
      });
    }
  });
  return buf;
}

const LABELS: Label[] = ['measured', 'derived', 'estimated', 'synthetic', 'unknown'];

describe('BinaryTable', () => {
  it('reads every field type with stride and offsets (aligned fast path)', () => {
    const h: BinaryTableHeader = {
      bin: 'x.bin', count: 3, stride: 32,
      fields: [
        { name: 'd', type: 'f64', count: 1, offset: 0 },
        { name: 'v', type: 'f32', count: 3, offset: 8 },
        { name: 'id', type: 'u32', count: 1, offset: 20 },
        { name: 'k', type: 'i32', count: 1, offset: 24 },
        { name: 'h', type: 'u16', count: 1, offset: 28 },
        { name: 'sizeLabel', type: 'u8', count: 1, offset: 30 },
        { name: 'src', type: 'u8', count: 1, offset: 31 },
      ],
      labelEncoding: LABELS, sourceTable: ['cat-a', 'cat-b'],
    };
    const rows = [0, 1, 2].map((i) => ({ d: [1e10 + i], v: [i, i + 0.5, -i], id: [4e9 + i], k: [-5 - i], h: [60000 + i], sizeLabel: [i], src: [i % 2] }));
    const t = new BinaryTable(h, pack(h, rows));
    for (let i = 0; i < 3; i++) {
      expect(t.get('d', i)).toBe(1e10 + i);
      expect(t.get('v', i, 1)).toBe(i + 0.5);
      expect(t.get('v', i, 2)).toBe(-i);
      expect(t.get('id', i)).toBe(4e9 + i);
      expect(t.get('k', i)).toBe(-5 - i);
      expect(t.get('h', i)).toBe(60000 + i);
      expect(t.label('sizeLabel', i)).toBe(LABELS[i]);
      expect(t.sourceId('src', i)).toBe(i % 2 ? 'cat-b' : 'cat-a');
    }
    expect(t.labelFields()).toEqual(['sizeLabel']);
  });

  it('falls back to DataView reads for unaligned layouts', () => {
    const h: BinaryTableHeader = { bin: 'x', count: 2, stride: 13, fields: [{ name: 'a', type: 'u8', count: 1, offset: 0 }, { name: 'x', type: 'f64', count: 1, offset: 1 }, { name: 'y', type: 'f32', count: 1, offset: 9 }] };
    const t = new BinaryTable(h, pack(h, [{ a: [7], x: [Math.PI], y: [2.5] }, { a: [8], x: [-Math.E], y: [-1] }]));
    expect(t.get('x', 0)).toBe(Math.PI);
    expect(t.get('x', 1)).toBe(-Math.E);
    expect(t.get('y', 1)).toBe(-1);
    expect(t.get('a', 1)).toBe(8);
  });

  it('rejects inconsistent headers', () => {
    const h: BinaryTableHeader = { bin: 'x', count: 10, stride: 8, fields: [{ name: 'a', type: 'f64', count: 1, offset: 0 }] };
    expect(() => new BinaryTable(h, new ArrayBuffer(79))).toThrow(/needs/);
    expect(() => new BinaryTable({ ...h, fields: [{ name: 'a', type: 'f64', count: 2, offset: 0 }] }, new ArrayBuffer(160))).toThrow(/does not fit/);
    expect(() => new BinaryTable(h, new ArrayBuffer(80)).get('nope', 0)).toThrow(/no field/);
  });
});

describe('star catalog', () => {
  const header: BinaryTableHeader = {
    bin: 'bright.bin', count: 3, stride: 32,
    fields: [
      { name: 'dir', type: 'f32', count: 3, offset: 0 },
      { name: 'xyzs', type: 'f32', count: 4, offset: 12 },
      { name: 'illumLabel', type: 'u8', count: 1, offset: 28 },
    ],
    labelEncoding: LABELS,
  };
  const rows = [
    { dir: [1, 0, 0], xyzs: [1, 2, 3, 4], illumLabel: [0] },
    { dir: [0, 1, 0], xyzs: [5, 6, 7, 8], illumLabel: [2] },
    { dir: [0, 0, 1], xyzs: [9, 10, 11, 12], illumLabel: [1] },
  ];
  const t = new BinaryTable(header, pack(header, rows));

  it('converts to the renderer layout and filters by label', () => {
    const all = buildStarCatalog(t, () => true);
    expect(all.catalog.count).toBe(3);
    expect(all.catalog.stride).toBe(7);
    expect(Array.from(all.catalog.data.slice(7, 14))).toEqual([0, 1, 0, 5, 6, 7, 8]);
    const strict = buildStarCatalog(t, (l) => l === 'measured' || l === 'derived');
    expect(strict.catalog.count).toBe(2);
    expect(strict.withheld).toBe(1);
    expect(Array.from(strict.catalog.data.slice(7, 14))).toEqual([0, 0, 1, 9, 10, 11, 12]);
    expect(strict.labelCounts).toEqual({ measured: 1, estimated: 1, derived: 1 });
    expect(starDirection(t, 2)).toEqual([0, 0, 1]);
  });

  it('accepts scalar-field layouts and rejects unknown ones', () => {
    const h2: BinaryTableHeader = {
      bin: 'b', count: 1, stride: 28,
      fields: ['ux', 'uy', 'uz', 'X', 'Y', 'Z', 'S'].map((name, i) => ({ name, type: 'f32' as const, count: 1, offset: 4 * i })),
    };
    const t2 = new BinaryTable(h2, pack(h2, [{ ux: [1], uy: [0], uz: [0], X: [1], Y: [2], Z: [3], S: [4] }]));
    expect(resolveStarLayout(t2).description).toBe('ux,uy,uz + X,Y,Z,S');
    expect(Array.from(buildStarCatalog(t2, () => true).catalog.data)).toEqual([1, 0, 0, 1, 2, 3, 4]);
    const h3: BinaryTableHeader = { bin: 'b', count: 1, stride: 4, fields: [{ name: 'mag', type: 'f32', count: 1, offset: 0 }] };
    expect(() => resolveStarLayout(new BinaryTable(h3, new ArrayBuffer(4)))).toThrow(/direction/);
  });

  it('parses names.json in the accepted shapes', () => {
    expect(parseStarNames([{ name: 'B', index: 1 }, { name: 'A', row: 0 }], 3)).toEqual([{ name: 'A', index: 0 }, { name: 'B', index: 1 }]);
    expect(parseStarNames({ names: [{ name: 'C', i: 2 }] }, 3)).toEqual([{ name: 'C', index: 2 }]);
    expect(parseStarNames({ '0': 'A', '2': 'C' }, 3).map((n) => n.index)).toEqual([0, 2]);
    expect(parseStarNames({ A: 0, B: 1 }, 3)).toHaveLength(2);
    expect(parseStarNames([{ name: 'X', index: 99 }, { name: 'Y', index: 1 }], 3)).toEqual([{ name: 'Y', index: 1 }]);
    expect(() => parseStarNames({ foo: 'bar' }, 3)).toThrow(/names.json/);
  });
});
