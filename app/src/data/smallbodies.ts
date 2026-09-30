// Small-body products (docs/reports/small-bodies.md; schema.ts SmallBody*Header): discovery in the manifest,
// background loading of the tables (core, physical, comets, nongrav; integrity-checked like every product), and
// row lookups. names.txt is not loaded here: the name index (a Web Worker) fetches it when search needs it.

import { BinaryTable } from './binaryTable';
import type { DataLoader, Progress } from './load';
import type { Manifest, SmallBodyCoreHeader, SmallBodyNamesHeader, SmallBodyPhysicalHeader, SmallBodyTableHeader } from './schema';

export interface SmallBodyProducts {
  /** Header product paths, from the manifest. */
  core: string;
  physical: string | null;
  comets: string | null;
  nongrav: string | null;
  names: string | null;
  /** Every smallbodies/* product path (for the report). */
  all: string[];
  /** Bytes of the tables loaded in the background (headers + binaries, names excluded). */
  tableBytes: number;
  namesBytes: number;
}

export function discoverSmallBodies(manifest: Manifest | null): SmallBodyProducts | null {
  if (!manifest?.products['smallbodies/core.json']) return null;
  const all = Object.keys(manifest.products).filter((p) => p.startsWith('smallbodies/'));
  const has = (p: string) => (manifest.products[p] ? p : null);
  let tableBytes = 0, namesBytes = 0;
  for (const p of all) {
    if (/names\.(txt|json)$/.test(p)) namesBytes += manifest.products[p].bytes;
    else tableBytes += manifest.products[p].bytes;
  }
  return {
    core: 'smallbodies/core.json',
    physical: has('smallbodies/physical.json'),
    comets: has('smallbodies/comets.json'),
    nongrav: has('smallbodies/nongrav.json'),
    names: has('smallbodies/names.json'),
    all,
    tableBytes,
    namesBytes,
  };
}

export interface SmallBodyTable<H extends SmallBodyTableHeader = SmallBodyTableHeader> {
  header: H;
  buffer: ArrayBuffer;
  table: BinaryTable;
}

export interface SmallBodyTables {
  core: SmallBodyTable<SmallBodyCoreHeader>;
  physical: SmallBodyTable<SmallBodyPhysicalHeader> | null;
  comets: SmallBodyTable | null;
  nongrav: SmallBodyTable | null;
  namesHeader: SmallBodyNamesHeader | null;
  /** core row → comets / nongrav record (physical rows come from core.physRow). */
  cometRow: Map<number, number>;
  nongravRow: Map<number, number>;
  count: number;
}

export const NO_ROW = 0xffffffff;

/** Load the small-body tables through the loader (sizes/sha256 checked). null if the core table is unusable. */
/** What loading the small-body products needs from the DataLoader. */
export type SmallBodyLoader = Pick<DataLoader, 'get' | 'setReport' | 'manifest'>;

export async function loadSmallBodyTables(L: SmallBodyLoader, p: SmallBodyProducts, onProgress?: Progress): Promise<SmallBodyTables | null> {
  const json = (b: ArrayBuffer): unknown => JSON.parse(new TextDecoder().decode(b));
  let done = 0;
  const prog = (): Progress | undefined =>
    onProgress && ((got) => onProgress(done + got, p.tableBytes));
  const table = async <H extends SmallBodyTableHeader>(headerPath: string | null, why: string): Promise<SmallBodyTable<H> | null> => {
    if (!headerPath) return null;
    const loading = (path: string) => L.setReport(path, { status: 'loading', bytes: L.manifest?.products[path]?.bytes, message: 'Loading in the background.' });
    loading(headerPath);
    const header = await L.get(headerPath, (b) => json(b) as H, why);
    done += L.manifest?.products[headerPath]?.bytes ?? 0;
    if (!header) return null;
    const bin = header.bin.includes('/') ? header.bin : headerPath.replace(/[^/]+$/, '') + header.bin;
    loading(bin);
    const got = await L.get(bin, (buf) => ({ buf, t: new BinaryTable(header, buf) }), why, prog());
    done += L.manifest?.products[bin]?.bytes ?? 0;
    return got ? { header, buffer: got.buf, table: got.t } : null;
  };
  const core = await table<SmallBodyCoreHeader>(p.core, 'No asteroids or comets.');
  if (!core) return null;
  const physical = await table<SmallBodyPhysicalHeader>(p.physical, 'No measured sizes, albedos, colours, rotation or phase functions for small bodies.');
  const comets = await table(p.comets, 'No comet magnitude laws.');
  const nongrav = await table(p.nongrav, 'Comets and asteroids with non-gravitational forces are propagated without them.');
  const namesHeader = await loadSmallBodyNamesHeader(L, p);
  const rowMap = (t: SmallBodyTable | null) => {
    const m = new Map<number, number>();
    if (t?.table.has('row')) for (let k = 0; k < t.table.count; k++) m.set(t.table.get('row', k), k);
    return m;
  };
  return { core, physical, comets, nongrav, namesHeader, cometRow: rowMap(comets), nongravRow: rowMap(nongrav), count: core.table.count };
}

const namesHeaders = new WeakMap<object, Promise<SmallBodyNamesHeader | null>>();

/** The names header (tiny; fetched once per loader): the name index needs it before the tables arrive. */
export function loadSmallBodyNamesHeader(L: SmallBodyLoader, p: SmallBodyProducts): Promise<SmallBodyNamesHeader | null> {
  if (!p.names) return Promise.resolve(null);
  let h = namesHeaders.get(L);
  if (!h) {
    const path = p.names;
    h = L.get(path, (b) => JSON.parse(new TextDecoder().decode(b)) as SmallBodyNamesHeader, 'Small bodies cannot be searched by name.');
    namesHeaders.set(L, h);
  }
  return h;
}

/** Physical-table record of a core row, or null. */
export function physicalRow(t: SmallBodyTables, row: number): number | null {
  if (!t.physical || !t.core.table.has('physRow')) return null;
  const r = t.core.table.get('physRow', row);
  return r === NO_ROW || r >= t.physical.table.count ? null : r;
}

/** Whether a flag (a value of core header flagBits) is set on a core row. */
export function flagSet(t: SmallBodyTables, row: number, name: string): boolean {
  const bit = Object.entries(t.core.header.flagBits ?? {}).find(([, n]) => n === name)?.[0];
  return bit !== undefined && (t.core.table.get('flags', row) & Number(bit)) !== 0;
}

/** Names of every flag set on a core row. */
export function flagNames(t: SmallBodyTables, row: number): string[] {
  const f = t.core.table.has('flags') ? t.core.table.get('flags', row) : 0;
  return Object.entries(t.core.header.flagBits ?? {})
    .filter(([bit]) => (f & Number(bit)) !== 0)
    .map(([, n]) => n);
}

export function orbitClassOf(t: SmallBodyTables, row: number): { code: string; name: string } | null {
  const k = t.core.table.has('orbitClass') ? t.core.table.get('orbitClass', row) : 255;
  return t.core.header.orbitClasses?.[k] ?? null;
}
