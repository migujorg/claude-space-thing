// Reading the small-body products (smallbodies/core, nongrav, names; see schema.ts SmallBody*Header) into the
// inputs of the reference propagator (./smallbody.ts). Pure data handling, no DOM/GPU.

import type { SmallBodyCoreHeader, SmallBodyNamesHeader, SmallBodyTableHeader } from '../data/schema';
import { BinaryTable } from '../data/binaryTable';
import type { NonGrav } from './smallbody';

export interface SmallBodyCatalog {
  header: SmallBodyCoreHeader;
  table: BinaryTable;
  count: number;
  /** Common epoch of the states (TDB s past J2000) and origin of the integration grid. */
  epochEt: number;
}

export function readCore(header: SmallBodyCoreHeader, buffer: ArrayBuffer): SmallBodyCatalog {
  const table = new BinaryTable(header, buffer);
  for (const f of ['pos', 'vel', 'posLabel', 'flags']) {
    if (!table.has(f)) throw new Error(`smallbodies core table lacks field ${f}`);
  }
  return { header, table, count: table.count, epochEt: header.epochEt };
}

/** Heliocentric ICRF state (km, km/s) of record i at the common epoch, or null if its position is unknown. */
export function coreState(cat: SmallBodyCatalog, i: number): Float64Array | null {
  const pos = cat.table.column('pos');
  const vel = cat.table.column('vel');
  const s = new Float64Array([pos.get(i, 0), pos.get(i, 1), pos.get(i, 2), vel.get(i, 0), vel.get(i, 1), vel.get(i, 2)]);
  return s.every(Number.isFinite) ? s : null;
}

/** Whether flag `name` (header.flagBits) is set on record i. */
export function hasFlag(cat: SmallBodyCatalog, i: number, name: string): boolean {
  const bit = cat.header.flagBits[name];
  if (bit === undefined) throw new Error(`unknown small-body flag ${name}`);
  return ((cat.table.get('flags', i) >> bit) & 1) === 1;
}

/** core row -> non-gravitational parameters, from smallbodies/nongrav. */
export function readNonGrav(header: SmallBodyTableHeader, buffer: ArrayBuffer): Map<number, NonGrav> {
  const t = new BinaryTable(header, buffer);
  const out = new Map<number, NonGrav>();
  for (let k = 0; k < t.count; k++) {
    out.set(t.get('row', k), {
      a1: t.get('A1', k), a2: t.get('A2', k), a3: t.get('A3', k), dt: t.get('DT', k), aln: t.get('ALN', k),
      r0: t.get('R0', k), nm: t.get('NM', k), nn: t.get('NN', k), nk: t.get('NK', k),
    });
  }
  return out;
}

export interface SmallBodyName {
  spkid: number;
  designation: string;
  name: string;
  prefix: string;
  principalProvisionalDesignation: string;
}

/** Split names.txt (one line per core record, header.columns order). */
export function parseNames(header: SmallBodyNamesHeader, text: string): SmallBodyName[] {
  const lines = text.split(header.lineSeparator);
  if (lines[lines.length - 1] === '') lines.pop();
  if (lines.length !== header.count) throw new Error(`names: ${lines.length} lines, header says ${header.count}`);
  const col = (n: string) => {
    const k = header.columns.indexOf(n);
    if (k < 0) throw new Error(`names: no column ${n}`);
    return k;
  };
  const [ks, kd, kn, kp, ka] = ['spkid', 'designation', 'name', 'prefix', 'principalProvisionalDesignation'].map(col);
  return lines.map((ln) => {
    const f = ln.split(header.separator);
    return { spkid: Number(f[ks]), designation: f[kd] ?? '', name: f[kn] ?? '', prefix: f[kp] ?? '', principalProvisionalDesignation: f[ka] ?? '' };
  });
}
