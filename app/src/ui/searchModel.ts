// Body browser / search model. Pure: bodies + ordering keys in, rows out.
//
// Browse (empty query): Sun, then planets and dwarf planets outward (by current distance from the Sun), each
// with its moons (ordered by current distance from the planet when known, else NAIF id) under a collapsible
// header showing the count. Search: every body whose name, designation or NAIF id matches, ignoring case,
// spaces, punctuation and diacritics ("s2003j2" finds "S/2003 J 2").

import type { Body } from '../data/schema';

export interface BrowseRow {
  kind: 'body' | 'star';
  id: number;
  name: string;
  /** Indentation depth (0 = top level). */
  depth: number;
  /** Number of moons under this row (collapsible), 0 if none. */
  children: number;
  expanded: boolean;
}

export function normalize(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface BrowseKeys {
  /** Distance of a top-level body from the Sun (smaller first); null when unknown (sorted last, by id). */
  helio(id: number): number | null;
  /** Distance of a moon from its parent; null when unknown. */
  fromParent(id: number): number | null;
}

function byKey(key: (id: number) => number | null) {
  return (a: Body, b: Body) => {
    const ka = key(a.id), kb = key(b.id);
    if (ka !== null && kb !== null) return ka - kb;
    if (ka !== null) return -1;
    if (kb !== null) return 1;
    return a.id - b.id;
  };
}

export function browseRows(bodies: Body[], keys: BrowseKeys, expanded: Set<number>): BrowseRow[] {
  const phys = bodies.filter((b) => b.kind !== 'barycenter');
  const ids = new Set(phys.map((b) => b.id));
  const children = new Map<number, Body[]>();
  for (const b of phys) {
    if (b.parent !== undefined && ids.has(b.parent) && b.parent !== b.id) {
      let l = children.get(b.parent);
      if (!l) children.set(b.parent, (l = []));
      l.push(b);
    }
  }
  const top = phys.filter((b) => b.parent === undefined || !ids.has(b.parent));
  top.sort((a, b) => (a.kind === 'star' ? -1 : b.kind === 'star' ? 1 : byKey(keys.helio)(a, b)));
  const out: BrowseRow[] = [];
  const add = (b: Body, depth: number) => {
    const kids = (children.get(b.id) ?? []).sort(byKey(keys.fromParent));
    const open = expanded.has(b.id);
    out.push({ kind: 'body', id: b.id, name: b.name, depth, children: kids.length, expanded: open });
    if (open) for (const k of kids) add(k, depth + 1);
  };
  for (const b of top) add(b, 0);
  return out;
}

export interface SearchHit {
  kind: 'body' | 'star';
  id: number;
  name: string;
  /** Where the match came from, for display ("id 501", "designation"). */
  via?: string;
}

export function searchBodies(bodies: Body[], query: string, limit = 60): { hits: SearchHit[]; more: number } {
  const q = normalize(query);
  if (!q) return { hits: [], more: 0 };
  const scored: { b: Body; s: number; via?: string }[] = [];
  for (const b of bodies) {
    if (b.kind === 'barycenter') continue;
    const n = normalize(b.name);
    let s = -1;
    let via: string | undefined;
    if (n === q) s = 0;
    else if (n.startsWith(q)) s = 1;
    else if (n.includes(q)) s = 2;
    if (String(b.id) === q.replace(/^naif/, '')) { s = 0; via = `NAIF ${b.id}`; }
    if (s >= 0) scored.push({ b, s, via });
  }
  scored.sort((a, b) => a.s - b.s || (a.b.kind === 'moon' ? 1 : 0) - (b.b.kind === 'moon' ? 1 : 0) || a.b.name.localeCompare(b.b.name));
  return {
    hits: scored.slice(0, limit).map((x) => ({ kind: 'body' as const, id: x.b.id, name: x.b.name, ...(x.via ? { via: x.via } : {}) })),
    more: Math.max(0, scored.length - limit),
  };
}
