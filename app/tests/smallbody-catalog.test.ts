// Readers of the small-body products (core / nongrav / names) on a synthetic, hand-packed table, plus label
// decoding through the generic BinaryTable.

import { describe, expect, it } from 'vitest';
import type { SmallBodyCoreHeader, SmallBodyNamesHeader, SmallBodyTableHeader } from '../src/data/schema';
import { coreState, hasFlag, parseNames, readCore, readNonGrav } from '../src/core/smallbodyCatalog';

const LABELS = ['measured', 'derived', 'estimated', 'synthetic', 'unknown'] as const;

function coreFixture(): { header: SmallBodyCoreHeader; buffer: ArrayBuffer } {
  // pos f64x3 @0, vel f64x3 @24, flags u16 @48, posLabel u8 @50, orbitSrc u8 @51 -> stride 56
  const stride = 56;
  const buffer = new ArrayBuffer(2 * stride);
  const dv = new DataView(buffer);
  const rec = (i: number, s: number[], flags: number, label: number, src: number) => {
    for (let j = 0; j < 6; j++) dv.setFloat64(i * stride + 8 * j, s[j], true);
    dv.setUint16(i * stride + 48, flags, true);
    dv.setUint8(i * stride + 50, label);
    dv.setUint8(i * stride + 51, src);
  };
  rec(0, [1.5e8, -2e7, 3e6, -1.1, 29.5, 0.4], 0b101, 1, 0);
  rec(1, [NaN, NaN, NaN, NaN, NaN, NaN], 1 << 7, 4, 255);
  const header = {
    bin: 'smallbodies/core.bin', count: 2, stride,
    fields: [
      { name: 'pos', type: 'f64', count: 3, offset: 0 }, { name: 'vel', type: 'f64', count: 3, offset: 24 },
      { name: 'flags', type: 'u16', count: 1, offset: 48 }, { name: 'posLabel', type: 'u8', count: 1, offset: 50 },
      { name: 'orbitSrc', type: 'u8', count: 1, offset: 51 },
    ],
    labelEncoding: [...LABELS], sourceTable: ['jpl-sbdb-orbits'],
    epochEt: 843998400, epochTdb: '2026-09-30 00:00:00.000', window: { startEt: 0, endEt: 1 },
    flagBits: { '1': 'comet', '2': 'numbered', '4': 'neo', '128': 'positionLost' },
  } as unknown as SmallBodyCoreHeader;
  return { header, buffer };
}

describe('small-body catalog readers', () => {
  it('reads float64 states exactly, flags and labels', () => {
    const { header, buffer } = coreFixture();
    const cat = readCore(header, buffer);
    expect(cat.count).toBe(2);
    expect(Array.from(coreState(cat, 0)!)).toEqual([1.5e8, -2e7, 3e6, -1.1, 29.5, 0.4]);
    expect(coreState(cat, 1)).toBeNull();
    expect(hasFlag(cat, 0, 'comet')).toBe(true);
    expect(hasFlag(cat, 0, 'numbered')).toBe(false);
    expect(hasFlag(cat, 0, 'neo')).toBe(true);
    expect(hasFlag(cat, 1, 'positionLost')).toBe(true);
    expect(cat.table.label('posLabel', 0)).toBe('derived');
    expect(cat.table.label('posLabel', 1)).toBe('unknown');
    expect(cat.table.sourceId('orbitSrc', 0)).toBe('jpl-sbdb-orbits');
    expect(cat.table.sourceId('orbitSrc', 1)).toBeUndefined(); // 255 = no source
    expect(() => hasFlag(cat, 0, 'nope')).toThrow();
  });

  it('reads non-gravitational parameters keyed by core row', () => {
    const names = ['A1', 'A2', 'A3', 'DT', 'ALN', 'R0', 'NM', 'NN', 'NK'];
    const stride = 8 + 8 * 9;
    const buffer = new ArrayBuffer(stride);
    const dv = new DataView(buffer);
    dv.setUint32(0, 42, true);
    names.forEach((_, j) => dv.setFloat64(8 + 8 * j, j + 0.5, true));
    const header: SmallBodyTableHeader = {
      bin: 'smallbodies/nongrav.bin', count: 1, stride,
      fields: [{ name: 'row', type: 'u32', count: 1, offset: 0 }, ...names.map((name, j) => ({ name, type: 'f64' as const, count: 1, offset: 8 + 8 * j }))],
    };
    const ng = readNonGrav(header, buffer);
    expect(ng.get(42)).toEqual({ a1: 0.5, a2: 1.5, a3: 2.5, dt: 3.5, aln: 4.5, r0: 5.5, nm: 6.5, nn: 7.5, nk: 8.5 });
  });

  it('splits the names sidecar', () => {
    const header: SmallBodyNamesHeader = {
      file: 'smallbodies/names.txt', count: 2, encoding: 'utf-8', separator: '\t', lineSeparator: '\n',
      columns: ['spkid', 'designation', 'name', 'prefix', 'principalProvisionalDesignation'], sources: [],
    };
    const n = parseNames(header, '20000001\t1\tCeres\t\tA801 AA\n1000026\t2P\tEncke\tP\t\n');
    expect(n[0]).toEqual({ spkid: 20000001, designation: '1', name: 'Ceres', prefix: '', principalProvisionalDesignation: 'A801 AA' });
    expect(n[1].prefix).toBe('P');
    expect(() => parseNames({ ...header, count: 3 }, 'a\n')).toThrow();
  });
});
