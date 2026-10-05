// Test helper (not a test): loads the pipeline's built products from app/public/data and the fixtures in
// app/tests/fixtures. Tests that need built data skip themselves, loudly, when it is missing: build it with
//   cd pipeline && uv run python -m pipeline build --only time,ephemeris,bodies
//
// Two kinds of reference, never mixed (README "Tests and references"):
//   * committed references (app/tests/fixtures): values for stated inputs (orbit solutions, their own epoch and
//     force model, Horizons queries, SPICE kernels by sha256). Use them with their own epoch and model. They say
//     nothing about the build under test, whose epoch, window, catalogue snapshot and kernel revisions differ;
//   * build records (verification/*.json in the built data, `buildRecord`): what the pipeline computed for the
//     products of this very build. "The app reads this product as the pipeline wrote it" compares with these.
// A comparison this run cannot make is declared with `notCompared`, never dropped.
//
// TEST_DATA_DIR and TEST_FIXTURE_DIR (absolute paths) point the suite at another build's products or another
// set of references.

import { it } from 'vitest';
import type { Body, EphemHeader, Manifest, OrientationHeader, TimeData } from '../src/data/schema';
import { Ephemeris, EphemerisSet } from '../src/core/ephemeris';
import { PreciseOrientation } from '../src/core/rotation';

interface Fs {
  existsSync(p: string): boolean;
  readFileSync(p: string): Uint8Array;
  readFileSync(p: string, enc: 'utf8'): string;
}
// Non-literal specifiers: node:fs and node:url without depending on @types/node.
const fs: Fs = await import(/* @vite-ignore */ 'node:fs' as string);
const nodeUrl: { fileURLToPath(u: URL): string } = await import(/* @vite-ignore */ 'node:url' as string);

// fileURLToPath, not URL.pathname: on Windows the latter gives "/C:/..." which fs cannot open.
const dir = (rel: string) => nodeUrl.fileURLToPath(new URL(rel, import.meta.url));
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const slash = (p: string) => (/[\\/]$/.test(p) ? p : p + '/');
export const DATA_DIR = env.TEST_DATA_DIR ? slash(env.TEST_DATA_DIR) : dir('../public/data/');
export const FIXTURE_DIR = env.TEST_FIXTURE_DIR ? slash(env.TEST_FIXTURE_DIR) : dir('./fixtures/');

/**
 * Declare, inside a describe, a comparison this run cannot make. It appears in the report as a skipped test named
 * after what is not compared and why, and counts in the summary's "skipped": nothing stops being checked silently.
 */
export function notCompared(what: string, why: string): void {
  it.skip(`NOT COMPARED: ${what}: ${why}`, () => {});
}

/** A build record's header: the sha256 of every product it describes. */
export interface BuildRecordHeader {
  stage: string;
  products: Record<string, string>;
}

export interface BuildRecord<T> {
  /** The record, or null with `why` when this build has none. */
  record: T | null;
  why: string;
  /** Products whose sha256 in the manifest is not the one the record names (must be empty: see `bound`). */
  unbound: string[];
}

/**
 * The record a stage wrote next to its products (verification/<name>.json), read from the build under test. A
 * build made before the stage wrote one has none: the caller reports its comparisons as not compared.
 */
export function buildRecord<T extends BuildRecordHeader>(rel: string, stage: string): BuildRecord<T> {
  const none = (why: string): BuildRecord<T> => ({ record: null, why, unbound: [] });
  if (!fs.existsSync(DATA_DIR + 'manifest.json')) return none('the data is not built');
  const manifest = JSON.parse(fs.readFileSync(DATA_DIR + 'manifest.json', 'utf8')) as Manifest;
  if (!manifest.products[rel] || !fs.existsSync(DATA_DIR + rel)) {
    return none(`this build has no ${rel} (it was made before the ${stage} stage wrote its build record): rebuild the ${stage} stage`);
  }
  const record = JSON.parse(fs.readFileSync(DATA_DIR + rel, 'utf8')) as T;
  const unbound = Object.entries(record.products).filter(([p, sha]) => manifest.products[p]?.sha256 !== sha).map(([p]) => p);
  return { record, why: '', unbound };
}

export function fixture<T>(name: string): T {
  return JSON.parse(fs.readFileSync(FIXTURE_DIR + name, 'utf8')) as T;
}

function dataPath(rel: string): string | null {
  const p = DATA_DIR + rel;
  if (fs.existsSync(p)) return p;
  console.warn(`[core tests] ${rel} not built; skipping tests that need it (run the pipeline build first)`);
  return null;
}

export function loadTimeData(): TimeData | null {
  const p = dataPath('time.json');
  return p ? (JSON.parse(fs.readFileSync(p, 'utf8')) as TimeData) : null;
}

export function loadBodies(): Body[] | null {
  const p = dataPath('bodies.json');
  return p ? (JSON.parse(fs.readFileSync(p, 'utf8')) as Body[]) : null;
}

export function loadEphemeris(name: string): Ephemeris | null {
  const hp = dataPath(`${name}.json`);
  if (!hp) return null;
  const header = JSON.parse(fs.readFileSync(hp, 'utf8')) as EphemHeader;
  const bp = dataPath(header.bin);
  if (!bp) return null;
  const u8 = fs.readFileSync(bp);
  // Copy into a fresh, 8-byte-aligned buffer (Node may hand back a pooled, unaligned view).
  const buf = new ArrayBuffer(u8.byteLength);
  new Uint8Array(buf).set(u8);
  return new Ephemeris(header, new Float64Array(buf));
}

export function loadOrientation(name: string): PreciseOrientation | null {
  const hp = dataPath(`${name}.json`);
  if (!hp) return null;
  const header = JSON.parse(fs.readFileSync(hp, 'utf8')) as OrientationHeader;
  const bp = dataPath(header.bin);
  if (!bp) return null;
  const u8 = fs.readFileSync(bp);
  const buf = new ArrayBuffer(u8.byteLength);
  new Uint8Array(buf).set(u8);
  return new PreciseOrientation(header, new Float64Array(buf));
}

/** Names ("ephem/<name>") of every ephemeris product listed in manifest.json. */
export function ephemerisProducts(): string[] | null {
  const p = dataPath('manifest.json');
  if (!p) return null;
  const products = Object.keys((JSON.parse(fs.readFileSync(p, 'utf8')) as Manifest).products);
  return products.filter((k) => /^ephem\/[^/]+\.json$/.test(k)).map((k) => k.slice(0, -'.json'.length));
}

export function loadEphemerisSet(names = ephemerisProducts()): EphemerisSet | null {
  if (!names || names.length === 0) return null;
  const set = new EphemerisSet();
  for (const n of names) {
    const e = loadEphemeris(n);
    if (!e) return null;
    set.add(e);
  }
  return set;
}

/** Collects max errors so each suite can print what it actually achieved. */
export class MaxTracker {
  private readonly m = new Map<string, { v: number; at: string }>();
  /** Fixture cases checked / skipped because the epoch is outside the loaded products' coverage. */
  checked = 0;
  skipped = 0;
  add(key: string, v: number, at: string): void {
    const cur = this.m.get(key);
    if (!cur || v > cur.v) this.m.set(key, { v, at });
  }
  /**
   * Fixture epochs are fixed but each build's window is "now ± ~18 months" of its first build, so a case may fall
   * outside the products' actual coverage. Call with the coverage test; returns true if the case should be checked.
   */
  inCoverage(covered: boolean): boolean {
    if (covered) this.checked++;
    else this.skipped++;
    return covered;
  }
  report(title: string): void {
    const lines = [...this.m].map(([k, { v, at }]) => `  ${k}: ${v.toExponential(3)} (${at})`);
    const cov = this.checked + this.skipped > 0
      ? ` [${this.checked} cases checked, ${this.skipped} skipped: outside the built products' coverage]` : '';
    console.log(`${title}${cov}\n${lines.join('\n')}`);
    if (this.skipped > 0) console.warn(`NOT COMPARED: ${title} ${this.skipped} of ${this.checked + this.skipped} reference cases: outside the built products' coverage`);
  }
  /** Fail only if nothing at all could be checked: then the fixtures need regenerating for this window. */
  requireSome(what: string): void {
    if (this.checked === 0) {
      throw new Error(`${what}: all ${this.skipped} fixture cases are outside the built products' coverage; ` +
        'regenerate fixtures (cd pipeline && uv run python -m pipeline.ephem_fixtures)');
    }
  }
}

// ---------------------------------------------------------------------------------------------- small bodies
/** A verification object, in the committed reference (smallbody_reference.json) and in a build record alike. */
export interface VerificationObject {
  label: string;
  category: string;
  designation: string;
  spkid: number;
  /** Row in the catalogue of the build the file was made from. In the committed reference: not the build under test. */
  coreRow: number;
  horizonsSolution: string;
  elements: { qKm: number; e: number; iRad: number; nodeRad: number; periRad: number; dtPeriS: number; epochEt: number };
  nonGrav: { a1: number; a2: number; a3: number; dt: number; aln: number; r0: number; nm: number; nn: number; nk: number } | null;
  stateAtEpoch: number[];
  stateCommon: number[];
  stateCommonFrom: 'horizons' | 'integrated';
  epochs: number[];
  horizons: number[][];
  python: number[][];
  maxErrKm: number;
  toleranceKm: number;
}

/** verification/smallbodies.json: the smallbodies stage's build record. */
export interface SmallBodyRecord extends BuildRecordHeader {
  snapshot: string;
  epochEt: number;
  window: { startEt: number; endEt: number };
  objects: VerificationObject[];
  closeApproaches: {
    rule: string;
    counts: Record<string, number>;
    fields: string[];
    rows: (string | number)[][];
  };
}

/** verification/orientation.json: the bodies stage's build record. */
export interface OrientationRecord extends BuildRecordHeader {
  kernels: { source: string; file: string; sha256: string }[];
  bodies: { id: number; frame: string; product: string; cases: { et: number; segment: number; label: string; sources: string[]; bodyToJ2000: number[] }[] }[];
}

const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);
/** Calendar date (TDB) of an ET, for messages; `etMinute` to the minute. */
export const etDate = (et: number): string => new Date(J2000_MS + et * 1000).toISOString().slice(0, 10);
export const etMinute = (et: number): string => new Date(J2000_MS + et * 1000).toISOString().slice(0, 16);
