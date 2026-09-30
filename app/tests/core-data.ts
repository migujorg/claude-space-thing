// Test helper (not a test): loads the pipeline's built products from app/public/data and the fixtures in
// app/tests/fixtures. Tests that need built data skip themselves, loudly, when it is missing: build it with
//   cd pipeline && uv run python -m pipeline build --only time,ephemeris,bodies

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
export const DATA_DIR = dir('../public/data/');
export const FIXTURE_DIR = dir('./fixtures/');

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
  }
  /** Fail only if nothing at all could be checked: then the fixtures need regenerating for this window. */
  requireSome(what: string): void {
    if (this.checked === 0) {
      throw new Error(`${what}: all ${this.skipped} fixture cases are outside the built products' coverage; ` +
        'regenerate fixtures (cd pipeline && uv run python -m pipeline.ephem_fixtures)');
    }
  }
}
