// M4 sky, data side of the app: HEALPix (TS twin of the pipeline's), deep-tile prefix logic, range decoding, and
// round trips against the built products (skipped when not built).

import { describe, expect, it } from 'vitest';
import { npix, pix2vec, vec2pix } from '../src/render/sky/healpix';
import { DeepTiles, gaiaSourceId, type RangeFetch } from '../src/data/sky';
import { neededCount } from '../src/app/sky';
import type { TiledBinaryTableHeader } from '../src/data/schema';
import { DATA_DIR } from './core-data';

interface Fs { existsSync(p: string): boolean; readFileSync(p: string): Uint8Array; readFileSync(p: string, enc: 'utf8'): string }
const fs: Fs = await import(/* @vite-ignore */ 'node:fs' as string);

describe('HEALPix NESTED (TS)', () => {
  it('round-trips pixel centres', () => {
    for (const o of [0, 1, 3, 6]) for (let p = 0; p < npix(o); p += o > 3 ? 7 : 1) expect(vec2pix(o, pix2vec(o, p))).toBe(p);
  });
  it('matches known pixel centres and nests', () => {
    const v0 = pix2vec(0, 0);
    expect(v0[2]).toBeCloseTo(2 / 3, 12);
    expect(Math.atan2(v0[1], v0[0])).toBeCloseTo(Math.PI / 4, 12);
    expect(pix2vec(0, 4)).toEqual([1, 0, expect.closeTo(0, 12)]);
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (let i = 0; i < 2000; i++) {
      const u = [rnd(), rnd(), rnd()];
      expect(Math.floor(vec2pix(8, u) / 4)).toBe(vec2pix(7, u));
      expect(Math.floor(vec2pix(7, u) / 256)).toBe(vec2pix(3, u));
    }
  });
});

describe('deep tile prefixes', () => {
  const t = { count: 1000, yMax: 1e-9, prefixCounts: [10, 100, 400] };
  const prefixY = [8.5e-11, 3.4e-11, 1.35e-11];
  it('loads nothing when the tile cannot reach the cut, and the smallest sufficient prefix otherwise', () => {
    expect(neededCount(t, prefixY, 1e-8)).toBe(0);            // yMax < cut/3
    expect(neededCount(t, prefixY, 3 * 8.5e-11)).toBe(10);    // prefix 1 holds every Y >= cut/3
    expect(neededCount(t, prefixY, 3 * 3.4e-11)).toBe(100);
    expect(neededCount(t, prefixY, 3 * 1.35e-11)).toBe(400);
    expect(neededCount(t, prefixY, 1e-11)).toBe(1000);        // below the last prefix: the whole tile
  });
  it('formats Gaia source ids from (lo, hi) words', () => {
    // 4295806720 = 1 * 2^32 + 839424
    expect(gaiaSourceId(839424, 1)).toBe('4295806720');
  });
});

describe('DeepTiles range loading (synthetic tile)', () => {
  const header = {
    binPattern: 'deep-o3-{pix:03d}.bin', count: 5, stride: 48,
    fields: [
      { name: 'dir', type: 'f32', count: 3, offset: 0 }, { name: 'xyzs', type: 'f32', count: 4, offset: 12 },
      { name: 'labelPos', type: 'u8', count: 1, offset: 28 }, { name: 'labelFlux', type: 'u8', count: 1, offset: 29 },
      { name: 'labelColor', type: 'u8', count: 1, offset: 30 }, { name: 'src', type: 'u8', count: 1, offset: 31 },
      { name: 'posRoute', type: 'u8', count: 1, offset: 32 }, { name: 'lightRoute', type: 'u8', count: 1, offset: 33 },
      { name: 'flags', type: 'u8', count: 1, offset: 34 }, { name: 'catId', type: 'u32', count: 2, offset: 36 },
      { name: 'hip', type: 'u32', count: 1, offset: 44 },
    ],
    labelEncoding: ['measured', 'derived', 'estimated', 'synthetic', 'unknown'],
    tiling: { scheme: 'HEALPix', ordering: 'NESTED', order: 0, nside: 1, frame: 'ICRS', assignment: '', sort: '', prefixY: [3], prefixNote: '' },
    tiles: [{ pix: 0, bin: 'deep-o3-000.bin', count: 5, center: [0, 0, 1], radiusDeg: 1, yMax: 5, yMin: 1, prefixCounts: [3] }],
    tier: { name: 'deep', gaiaGMin: 10, gaiaGMax: 14, brighterTier: '' },
  } as unknown as TiledBinaryTableHeader;
  const file = new ArrayBuffer(5 * 48);
  const f = new Float32Array(file), u8 = new Uint8Array(file), u32 = new Uint32Array(file);
  for (let i = 0; i < 5; i++) {
    f.set([0, 0, 1, 1, 5 - i, 1, 2], i * 12);
    u8[i * 48 + 28] = 1; u8[i * 48 + 29] = 2; u8[i * 48 + 30] = 2; u8[i * 48 + 33] = i % 2;
    u32[i * 12 + 9] = 1000 + i;
  }
  const calls: [number, number][] = [];
  const fetchRange: RangeFetch = async (_u, s, e) => { calls.push([s, e]); return { buf: file.slice(s, e), partial: true }; };
  it('fetches only the missing byte range and decodes the records in order', async () => {
    const T = new DeepTiles(header, '/data/', fetchRange);
    await T.ensure(0, 3);
    await T.ensure(0, 5);
    await T.ensure(0, 4);
    expect(calls).toEqual([[0, 144], [144, 240]]);
    const t = T.get(0)!;
    expect(t.count).toBe(5);
    expect(Array.from(t.stars.filter((_, k) => k % 7 === 4))).toEqual([5, 4, 3, 2, 1]);
    expect(t.catId[2 * 4]).toBe(1004);
    expect(T.label(t.labels[1])).toBe('estimated');
    expect(t.routes[2 * 3 + 1]).toBe(1);
  });
});

const deepPath = DATA_DIR + 'stars/deep.json';
const built = fs.existsSync(deepPath) && fs.existsSync(DATA_DIR + 'sky/diffuse.json');
describe.skipIf(!built)('built deep tiles and sky maps', () => {
  it('prefix counts match the Y thresholds of real tiles, and remainder slices add up', () => {
    const h = JSON.parse(fs.readFileSync(deepPath, 'utf8')) as TiledBinaryTableHeader;
    for (const pix of [0, 444, 449, 767]) {
      const tile = h.tiles[pix];
      const buf = fs.readFileSync(DATA_DIR + 'stars/' + tile.bin);
      expect(buf.byteLength).toBe(tile.count * h.stride);
      const f = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      const Y = (i: number) => f[i * 12 + 4];
      for (let k = 0; k < h.tiling.prefixY.length; k++) {
        const n = tile.prefixCounts[k];
        if (n > 0) expect(Y(n - 1)).toBeGreaterThanOrEqual(h.tiling.prefixY[k]);
        if (n < tile.count) expect(Y(n)).toBeLessThan(h.tiling.prefixY[k]);
      }
      // every record lies in its tile
      for (let i = 0; i < tile.count; i += 97) expect(vec2pix(h.tiling.order, [f[i * 12], f[i * 12 + 1], f[i * 12 + 2]])).toBe(pix);
    }
    const maps = JSON.parse(fs.readFileSync(DATA_DIR + 'sky/diffuse.json', 'utf8'));
    const rem = maps.layers.deepRemainder;
    const rb = fs.readFileSync(DATA_DIR + 'sky/' + rem.bin);
    const r = new Float32Array(rb.buffer, rb.byteOffset, rb.byteLength / 4);
    const n = rem.npix;
    const om = (4 * Math.PI) / n;
    const totalY = (s: number) => { let a = 0; for (let p = 0; p < n; p++) a += r[(s * n + p) * 4 + 1]; return a * om; };
    const tot = [0, 1, 2, 3].map(totalY);
    for (let k = 0; k < 4; k++) expect(tot[k] / rem.stats.totalY_lux[k]).toBeCloseTo(1, 4);
    expect(tot[0]).toBeGreaterThan(tot[1]);
    expect(tot[1]).toBeGreaterThan(tot[2]);
    expect(tot[2]).toBeGreaterThan(tot[3]);
  });
});
