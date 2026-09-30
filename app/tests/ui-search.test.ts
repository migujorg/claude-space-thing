import { describe, expect, it } from 'vitest';
import { browseRows, normalize, searchBodies } from '../src/ui/searchModel';
import { body } from './app-fakes';

const bodies = [
  body(10, 'Sun', 'star'),
  body(599, 'Jupiter', 'planet'),
  body(399, 'Earth', 'planet'),
  body(301, 'Moon', 'moon', { parent: 399 }),
  body(501, 'Io', 'moon', { parent: 599 }),
  body(503, 'Ganymede', 'moon', { parent: 599 }),
  body(55501, 'S/2003 J 2', 'moon', { parent: 599 }),
  body(5, 'Jupiter barycenter', 'barycenter'),
];
const helio: Record<number, number> = { 399: 1.5e8, 599: 7.8e8 };
const fromParent: Record<number, number> = { 501: 4.2e5, 503: 1.07e6 };
const keys = { helio: (id: number) => helio[id] ?? null, fromParent: (id: number) => fromParent[id] ?? null };

describe('body browser', () => {
  it('lists the Sun, then planets outward, with moon counts; barycenters are hidden', () => {
    const rows = browseRows(bodies, keys, new Set());
    expect(rows.map((r) => r.name)).toEqual(['Sun', 'Earth', 'Jupiter']);
    expect(rows.find((r) => r.id === 599)!.children).toBe(3);
    expect(rows.find((r) => r.id === 399)!.children).toBe(1);
  });

  it('expands a system: moons by distance from the planet, unknown distances last by id', () => {
    const rows = browseRows(bodies, keys, new Set([599]));
    expect(rows.map((r) => [r.name, r.depth])).toEqual([
      ['Sun', 0], ['Earth', 0], ['Jupiter', 0], ['Io', 1], ['Ganymede', 1], ['S/2003 J 2', 1],
    ]);
  });
});

describe('search', () => {
  it('matches names and designations ignoring case, spaces and punctuation', () => {
    expect(normalize('S/2003 J 2')).toBe('s2003j2');
    expect(searchBodies(bodies, 's2003j2').hits.map((h) => h.id)).toEqual([55501]);
    expect(searchBodies(bodies, '2003 j').hits.map((h) => h.id)).toEqual([55501]);
    expect(searchBodies(bodies, 'gany').hits.map((h) => h.name)).toEqual(['Ganymede']);
    expect(searchBodies(bodies, 'jupiter').hits.map((h) => h.id)).toEqual([599]); // barycenter excluded
  });
  it('matches NAIF ids and ranks exact/prefix matches first, planets before moons', () => {
    expect(searchBodies(bodies, '501').hits[0]).toMatchObject({ id: 501, via: 'NAIF 501' });
    const r = searchBodies(bodies, 'o');
    expect(r.hits.length).toBeGreaterThan(0);
    expect(searchBodies(bodies, 'e', 2)).toMatchObject({ more: expect.any(Number) });
    expect(searchBodies(bodies, 'e', 2).hits).toHaveLength(2);
  });
});
