import { describe, expect, it } from 'vitest';
import { displayName, NameIndex, normalizeName } from '../src/data/nameIndex';
import { NameService } from '../src/app/nameService';
import type { SmallBodyNamesHeader } from '../src/data/schema';
import { DATA_DIR } from './core-data';

const header = (count: number): SmallBodyNamesHeader => ({
  file: 'smallbodies/names.txt', count, encoding: 'utf-8', separator: '\t', lineSeparator: '\n',
  columns: ['spkid', 'designation', 'name', 'prefix', 'principalProvisionalDesignation'], sources: ['jpl-sbdb-orbits'],
});
const LINES = [
  '1000012\t67P\tChuryumov-Gerasimenko\tP\t',
  '1000007\t1984 A1\tBradfield\tC\t',
  '20000001\t1\tCeres\t\tA801 AA',
  '20099942\t99942\tApophis\t\t2004 MN4',
  '20000011\t11\tParthenope\t\tA850 JA',
  '54509621\t2024 YR4\t\t\t2024 YR4',
  '54517009\t2024 YR41\t\t\t2024 YR41',
  '20012345\t12345\t\t\t1993 FX',
  '20002060\t2060\tChiron\t\t1977 UB',
];
const text = LINES.join('\n') + '\n';

describe('name index', () => {
  const idx = new NameIndex(header(LINES.length), text);

  it('formats names conventionally', () => {
    expect(idx.display(0)).toBe('67P/Churyumov-Gerasimenko');
    expect(idx.display(1)).toBe('C/1984 A1 (Bradfield)');
    expect(idx.display(3)).toBe('99942 Apophis (2004 MN4)');
    expect(idx.display(5)).toBe('2024 YR4');
    expect(idx.display(7)).toBe('12345 (1993 FX)');
    expect(displayName({ spkid: 0, designation: '2010 A2', name: '', prefix: 'P', provisional: '' })).toBe('P/2010 A2');
  });

  it('finds by number, name and provisional designation; exact before prefix before substring', () => {
    expect(idx.search('99942').hits[0]).toMatchObject({ row: 3, rank: 0 });
    expect(idx.search('apophis').hits.map((h) => h.row)).toEqual([3]);
    expect(idx.search('2004 MN4').hits[0].row).toBe(3);
    expect(idx.search('2024 yr4').hits.map((h) => [h.row, h.rank])).toEqual([[5, 0], [6, 1]]);
    expect(idx.search('1').hits[0]).toMatchObject({ row: 2, rank: 0 }); // (1) Ceres first
    expect(idx.search('67p').hits[0].row).toBe(0);
    expect(idx.search('C/1984 A1').hits[0].row).toBe(1);
    expect(idx.search('ron').hits.map((h) => h.display)).toContain('2060 Chiron (1977 UB)');
    expect(idx.search('zzz').hits).toEqual([]);
    expect(idx.search('1', 2)).toMatchObject({ more: true });
  });

  it('maps spkid to rows and rejects a line-count mismatch', () => {
    expect(idx.rowOfSpkid(20099942)).toBe(3);
    expect(idx.rowOfSpkid(1)).toBeNull();
    expect(() => new NameIndex(header(99), text)).toThrow(/99/);
    expect(normalizeName('Churyumov–Gerasimenko')).toBe('churyumovgerasimenko');
  });

  it('the service works in-thread (no worker) and caches display names', async () => {
    const svc = new NameService({ url: '/data/smallbodies/names.txt', header: header(LINES.length), fetch: async () => new Response(text) });
    expect(svc.state).toBe('idle');
    const r = await svc.search('apophis');
    expect(svc.state).toBe('ready');
    expect(r.hits[0].display).toBe('99942 Apophis (2004 MN4)');
    expect(await svc.display([2, 3])).toEqual(['1 Ceres (A801 AA)', '99942 Apophis (2004 MN4)']);
    expect(svc.cached(2)).toBe('1 Ceres (A801 AA)');
    expect(await svc.rowOfSpkid(54509621)).toBe(5);
  });

  it('reports a failed load', async () => {
    const svc = new NameService({ url: 'x', header: header(1), fetch: async () => new Response('<html>', { headers: { 'content-type': 'text/html' } }) });
    await expect(svc.search('a')).rejects.toThrow(/not found/);
    expect(svc.state).toBe('error');
  });
});

interface Fs { existsSync(p: string): boolean; readFileSync(p: string, enc: 'utf8'): string }
const fs: Fs = await import(/* @vite-ignore */ 'node:fs' as string);
const built = fs.existsSync(DATA_DIR + 'smallbodies/names.txt');

describe.skipIf(!built)('name index on the real names.txt', () => {
  it('indexes 1.5 M names and answers typical queries quickly', () => {
    const h = JSON.parse(fs.readFileSync(DATA_DIR + 'smallbodies/names.json', 'utf8')) as SmallBodyNamesHeader;
    const t0 = performance.now();
    const idx = new NameIndex(h, fs.readFileSync(DATA_DIR + 'smallbodies/names.txt', 'utf8'));
    const build = performance.now() - t0;
    const times: string[] = [];
    const q = (s: string) => {
      const t = performance.now();
      const r = idx.search(s, 20);
      times.push(`${s}: ${(performance.now() - t).toFixed(1)} ms`);
      return r.hits;
    };
    expect(q('ceres')[0].display).toMatch(/^1 Ceres/);
    expect(q('99942')[0].display).toMatch(/Apophis/);
    expect(q('2024 YR4')[0].display).toBe('2024 YR4');
    expect(q('67P')[0].display).toMatch(/^67P\/Churyumov/);
    expect(q('halley').some((x) => /1P\/Halley/.test(x.display))).toBe(true);
    expect(q('2025 N1')[0].display).toBe('C/2025 N1 (ATLAS)'); // 3I/ATLAS is listed by its comet designation
    q('a');
    q('zzzzqqq');
    console.log(`names: ${idx.count} lines indexed in ${build.toFixed(0)} ms; queries: ${times.join(', ')}`);
    expect(idx.count).toBe(h.count);
  }, 60_000);
});
