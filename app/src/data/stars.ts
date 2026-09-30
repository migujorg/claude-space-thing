// Star catalog → renderer StarCatalog (render/scene.ts), and stars/names.json parsing.
//
// The renderer wants interleaved float32 [ux, uy, uz, X, Y, Z, S] per star. The pipeline's header names
// its fields; we accept the layouts below and report anything else instead of guessing:
//   - a direction field: f32×3 named dir|u|unit|uvec|direction|icrf (or three f32 fields ux, uy, uz)
//   - an illuminance field: f32×4 named xyzs|illumXYZS|illuminanceXYZS|E|lux (or X, Y, Z, S)
// Provenance: u8 fields whose name contains "label" are decoded through labelEncoding; at a given
// `exists` level a star is passed to the renderer only if every one of its labels is allowed.

import type { Label } from './schema';
import type { StarCatalog } from '../render/scene';
import type { BinaryTable } from './binaryTable';

const STAR_FLOATS = 7;
const DIR_NAMES = ['dir', 'u', 'unit', 'uvec', 'direction', 'icrf', 'icrfDir', 'dirIcrf'];
const ILLUM_NAMES = ['xyzs', 'XYZS', 'illumXYZS', 'illuminanceXYZS', 'illuminance', 'E', 'lux', 'eXYZS'];

type Getter = (i: number) => number;

export interface StarLayout {
  get: Getter[]; // 7 getters in renderer order
  description: string;
}

function lower(s: string): string {
  return s.toLowerCase();
}

export function resolveStarLayout(t: BinaryTable): StarLayout {
  const fields = t.header.fields;
  const byName = (names: string[], type: string, count: number) =>
    fields.find((f) => f.type === type && (f.count ?? 1) === count && names.map(lower).includes(lower(f.name)));
  const dir = byName(DIR_NAMES, 'f32', 3);
  const ill = byName(ILLUM_NAMES, 'f32', 4);
  const get: Getter[] = [];
  const desc: string[] = [];
  if (dir) {
    const c = t.column(dir.name);
    for (let k = 0; k < 3; k++) get.push((i) => c.get(i, k));
    desc.push(`${dir.name}[3]`);
  } else if (['ux', 'uy', 'uz'].every((n) => t.has(n))) {
    for (const n of ['ux', 'uy', 'uz']) { const c = t.column(n); get.push((i) => c.get(i)); }
    desc.push('ux,uy,uz');
  } else {
    throw new Error(`star table: no direction field (expected f32×3 named one of ${DIR_NAMES.join('|')}, or ux/uy/uz)`);
  }
  if (ill) {
    const c = t.column(ill.name);
    for (let k = 0; k < 4; k++) get.push((i) => c.get(i, k));
    desc.push(`${ill.name}[4]`);
  } else if (['X', 'Y', 'Z', 'S'].every((n) => t.has(n))) {
    for (const n of ['X', 'Y', 'Z', 'S']) { const c = t.column(n); get.push((i) => c.get(i)); }
    desc.push('X,Y,Z,S');
  } else {
    throw new Error(`star table: no illuminance field (expected f32×4 named one of ${ILLUM_NAMES.join('|')}, or X/Y/Z/S)`);
  }
  return { get, description: desc.join(' + ') };
}

export interface StarFilterResult {
  catalog: StarCatalog;
  /** Stars withheld because one of their labels is not allowed at this level. */
  withheld: number;
  /** Per-label counts over the whole table (worst label per star). */
  labelCounts: Partial<Record<Label, number>>;
  layout: string;
}

/** Build the renderer catalog, keeping only stars whose labels are all allowed. */
export function buildStarCatalog(t: BinaryTable, isAllowed: (l: Label) => boolean): StarFilterResult {
  const layout = resolveStarLayout(t);
  const labelFields = t.labelFields();
  const order: Label[] = ['measured', 'derived', 'estimated', 'synthetic', 'unknown'];
  const labelCounts: Partial<Record<Label, number>> = {};
  const out = new Float32Array(t.count * STAR_FLOATS);
  let n = 0;
  for (let i = 0; i < t.count; i++) {
    let worst = 0;
    let ok = true;
    for (const f of labelFields) {
      const l = t.label(f, i);
      worst = Math.max(worst, order.indexOf(l));
      if (!isAllowed(l)) ok = false;
    }
    const wl = order[worst];
    labelCounts[wl] = (labelCounts[wl] ?? 0) + 1;
    if (!ok) continue;
    const base = n * STAR_FLOATS;
    for (let k = 0; k < STAR_FLOATS; k++) out[base + k] = layout.get[k](i);
    n++;
  }
  return {
    catalog: { count: n, data: n === t.count ? out : out.slice(0, n * STAR_FLOATS), stride: STAR_FLOATS },
    withheld: t.count - n,
    labelCounts,
    layout: layout.description,
  };
}

/** Unit direction (ICRF) of star row i, for "look at" from search. */
export function starDirection(t: BinaryTable, i: number): [number, number, number] {
  const g = resolveStarLayout(t).get;
  return [g[0](i), g[1](i), g[2](i)];
}

// ---- names.json ----------------------------------------------------------------------------------

export interface StarName {
  name: string;
  /** Row index into the bright-star table. */
  index: number;
}

/**
 * names.json has no shape in schema.ts yet. Accepted forms:
 *   [{ name, index }]  (also `row` or `i` for the index)
 *   { names: [...same...] }
 *   { "<row index>": "Name" }   or   { "Name": <row index> }
 *   { stars: { "<key>": { index, iau?, bayer?, flamsteed? } } }   (the stars stage's names.json)
 */
export function parseStarNames(json: unknown, rowCount: number): StarName[] {
  const out: StarName[] = [];
  const push = (name: unknown, index: unknown) => {
    const i = typeof index === 'string' ? Number(index) : index;
    if (typeof name === 'string' && name && typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < rowCount) out.push({ name, index: i });
  };
  const fromArray = (arr: unknown[]) => {
    for (const e of arr) {
      if (e && typeof e === 'object') {
        const o = e as Record<string, unknown>;
        push(o.name, o.index ?? o.row ?? o.i);
      }
    }
  };
  if (Array.isArray(json)) fromArray(json);
  else if (json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    if (o.stars && typeof o.stars === 'object' && !Array.isArray(o.stars)) {
      // stars pipeline shape: { stars: { "HIP 32349": { index, hip, iau?, bayer?, flamsteed? } } } — every
      // name a star is known by becomes a search entry (proper name, Bayer, Flamsteed, catalogue key).
      for (const [key, v] of Object.entries(o.stars as Record<string, Record<string, unknown>>)) {
        if (!v || typeof v !== 'object') continue;
        const names = [v.iau, v.bayer, v.flamsteed, key].filter((n): n is string => typeof n === 'string' && !!n);
        for (const n of new Set(names)) push(n, v.index);
      }
    } else if (Array.isArray(o.names)) fromArray(o.names);
    else {
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === 'string' && /^\d+$/.test(k)) push(v, Number(k));
        else if (typeof v === 'number') push(k, v);
      }
    }
  }
  if (out.length === 0 && json != null) throw new Error('names.json: no usable {name, index} entries (unrecognized shape or indices outside the star table)');
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
