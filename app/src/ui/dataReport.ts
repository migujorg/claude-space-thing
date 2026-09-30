// Data panel rows: products that differ only by a number in their path (tiles, catalogue shards) and share a
// status, integrity state and message are shown as one row with a count. Pure; no DOM.

import type { ProductReport } from '../data/load';

export interface ReportRow extends ProductReport {
  /** Number of products this row stands for (1 = a single product). */
  count: number;
  /** For a group: the last path (the row's `path` is the first). */
  lastPath?: string;
}

export function groupReport(products: ProductReport[], min = 4): ReportRow[] {
  const groups = new Map<string, ProductReport[]>();
  for (const p of products) {
    const key = [p.status, p.path.replace(/\d+/g, '#'), p.hash ?? '', p.message ?? '', p.consequence ?? ''].join('\u0000');
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(p);
  }
  const out: ReportRow[] = [];
  for (const g of groups.values()) {
    if (g.length < min) {
      for (const p of g) out.push({ ...p, count: 1 });
      continue;
    }
    const bytes = g.every((p) => p.bytes !== undefined) ? g.reduce((s, p) => s + p.bytes!, 0) : undefined;
    out.push({ ...g[0], ...(bytes !== undefined ? { bytes } : {}), count: g.length, lastPath: g[g.length - 1].path });
  }
  return out;
}
