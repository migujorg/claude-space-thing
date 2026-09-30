// Search index over smallbodies/names.txt (1.57 M lines: spkid, designation, name, prefix, principal
// provisional designation; line i ↔ core record i). Pure; runs in a Web Worker in the app.
//
// Every line contributes normalized keys (lowercase a–z0–9 only): designation (the number for numbered
// asteroids, "67p" for comets), name, provisional designation, and for comets prefix/designation ("c1984a1").
// Keys are stored in one string, "|k1|k2|…|" per line, so a query is three native indexOf scans:
//   exact  "|q|"   →  rank 0 (a number or designation typed in full)
//   prefix "|q"    →  rank 1
//   inside "q"     →  rank 2
// Within a rank, lower rows (SBDB order: numbered objects by number, then the rest) come first.

import type { SmallBodyNamesHeader } from './schema';

export interface NameHit {
  row: number;
  display: string;
  rank: 0 | 1 | 2;
}

export function normalizeName(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface NameFields {
  spkid: number;
  designation: string;
  name: string;
  prefix: string;
  provisional: string;
}

/** Conventional display: "99942 Apophis (2004 MN4)", "67P/Churyumov-Gerasimenko", "C/1984 A1 (Bradfield)". */
export function displayName(f: NameFields): string {
  if (f.prefix) {
    const des = f.prefix && !/^\d+[A-Z]$/.test(f.designation) ? `${f.prefix}/${f.designation}` : f.designation;
    if (!f.name) return des;
    return /^\d+[A-Z]$/.test(f.designation) ? `${des}/${f.name}` : `${des} (${f.name})`;
  }
  if (f.name) return /^\d+$/.test(f.designation) ? `${f.designation} ${f.name}${f.provisional && f.provisional !== f.designation ? ` (${f.provisional})` : ''}` : `${f.designation} ${f.name}`;
  return f.provisional && f.provisional !== f.designation ? `${f.designation} (${f.provisional})` : f.designation;
}

export class NameIndex {
  readonly count: number;
  private readonly text: string;
  private readonly lineStart: Uint32Array;
  private readonly keys: string;
  private readonly keyStart: Uint32Array;
  private readonly cols: number[];
  private readonly sep: string;
  private spkidRows: Map<number, number> | null = null;

  constructor(header: SmallBodyNamesHeader, text: string) {
    this.text = text;
    this.sep = header.separator;
    const col = (n: string) => header.columns.indexOf(n);
    this.cols = ['spkid', 'designation', 'name', 'prefix', 'principalProvisionalDesignation'].map(col);
    const nl = header.lineSeparator;
    // Line starts.
    const starts: number[] = [];
    let p = 0;
    while (p < text.length) {
      starts.push(p);
      const e = text.indexOf(nl, p);
      if (e < 0) break;
      p = e + nl.length;
    }
    if (starts.length && starts[starts.length - 1] >= text.length) starts.pop();
    this.count = starts.length;
    if (this.count !== header.count) throw new Error(`names: ${this.count} lines, header says ${header.count}`);
    this.lineStart = Uint32Array.from(starts);
    // Key string.
    const parts: string[] = [];
    const ks = new Uint32Array(this.count + 1);
    let len = 0;
    for (let i = 0; i < this.count; i++) {
      const f = this.fields(i);
      const k = new Set<string>();
      for (const v of [f.designation, f.name, f.provisional, f.prefix ? `${f.prefix}${f.designation}` : '']) {
        const n = normalizeName(v);
        if (n) k.add(n);
      }
      const line = `|${[...k].join('|')}|\n`;
      ks[i] = len;
      len += line.length;
      parts.push(line);
    }
    ks[this.count] = len;
    this.keys = parts.join('');
    this.keyStart = ks;
  }

  fields(row: number): NameFields {
    const a = this.lineStart[row];
    const b = row + 1 < this.count ? this.lineStart[row + 1] : this.text.length;
    const f = this.text.slice(a, b).replace(/[\r\n]+$/, '').split(this.sep);
    const [ks, kd, kn, kp, ka] = this.cols;
    return { spkid: Number(f[ks]), designation: f[kd] ?? '', name: f[kn] ?? '', prefix: f[kp] ?? '', provisional: f[ka] ?? '' };
  }

  display(row: number): string {
    return displayName(this.fields(row));
  }

  rowOfSpkid(spkid: number): number | null {
    if (!this.spkidRows) {
      this.spkidRows = new Map();
      for (let i = 0; i < this.count; i++) this.spkidRows.set(this.fields(i).spkid, i);
    }
    return this.spkidRows.get(spkid) ?? null;
  }

  private rowAt(pos: number): number {
    let lo = 0, hi = this.count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.keyStart[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  search(query: string, limit = 50): { hits: NameHit[]; more: boolean } {
    const q = normalizeName(query);
    if (!q) return { hits: [], more: false };
    const seen = new Set<number>();
    const hits: NameHit[] = [];
    let more = false;
    const scan = (needle: string, rank: 0 | 1 | 2) => {
      let from = 0;
      while (hits.length < limit) {
        const at = this.keys.indexOf(needle, from);
        if (at < 0) return;
        const row = this.rowAt(at);
        from = this.keyStart[row + 1]; // one hit per line per pass
        if (!seen.has(row)) {
          seen.add(row);
          hits.push({ row, display: this.display(row), rank });
        }
      }
      more = this.keys.indexOf(needle, from) >= 0 || more;
    };
    scan(`|${q}|`, 0);
    scan(`|${q}`, 1);
    scan(q, 2);
    return { hits, more };
  }
}
