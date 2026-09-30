// Test helper (not a test): loads the pipeline's built products from app/public/data and the fixtures in
// app/tests/fixtures. Tests that need built data skip themselves, loudly, when it is missing: build it with
//   cd pipeline && uv run python -m pipeline build --only time,ephemeris,bodies

import type { Body, EphemHeader, Manifest, TimeData } from '../src/data/schema';
import { Ephemeris, EphemerisSet } from '../src/core/ephemeris';

interface Fs {
  existsSync(p: string): boolean;
  readFileSync(p: string): Uint8Array;
  readFileSync(p: string, enc: 'utf8'): string;
}
// Non-literal specifier: node:fs without depending on @types/node.
const fs: Fs = await import(/* @vite-ignore */ 'node:fs' as string);

const dir = (rel: string) => decodeURIComponent(new URL(rel, import.meta.url).pathname);
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
  add(key: string, v: number, at: string): void {
    const cur = this.m.get(key);
    if (!cur || v > cur.v) this.m.set(key, { v, at });
  }
  report(title: string): void {
    const lines = [...this.m].map(([k, { v, at }]) => `  ${k}: ${v.toExponential(3)} (${at})`);
    console.log(`${title}\n${lines.join('\n')}`);
  }
}
