// Surface map layers (docs/architecture.md §4.4): surfaces/<naifId>/<layer>.json headers plus tile pyramids at
// surfaces/<naifId>/<layer>/<L>/<ty>/<tx>.bin. The header's exact shape is not in schema.ts yet, so this reads it
// tolerantly: the fields the shell needs for provenance (label, sources, epoch, levels, coverage) are extracted,
// and the whole header is kept (`header`) for the renderer. Tiles are never fetched here.

import type { Label, Manifest } from './schema';
import { LABEL_ORDER } from './schema';

export interface SurfaceLayer {
  bodyId: number;
  /** "albedo", "height", ... */
  layer: string;
  /** Header product path, e.g. "surfaces/301/albedo.json". */
  path: string;
  /** Tile path prefix, e.g. "surfaces/301/albedo/" (tiles are <prefix><L>/<ty>/<tx>.bin). */
  tilePrefix: string;
  /** Number of pyramid levels, if the header states it. */
  levels: number | null;
  label: Label;
  sources: string[];
  epoch: string | null;
  method: string | null;
  notes: string | null;
  /** Tiles listed in the manifest. */
  tiles: { count: number; bytes: number };
  /** The header exactly as written by the pipeline. */
  header: Record<string, unknown>;
}

export interface FoundSurface {
  bodyId: number;
  layer: string;
  path: string;
  tilePattern: string;
  tiles: { count: number; bytes: number; paths: string[] };
}

const HEADER_RE = /^surfaces\/(\d+)\/([^/]+)\.json$/;
const TILE_RE = /^surfaces\/(\d+)\/([^/]+)\/.+\.bin$/;

/** Layer headers and their tiles listed in the manifest. */
export function discoverSurfaces(manifest: Manifest | null): FoundSurface[] {
  if (!manifest) return [];
  const out = new Map<string, FoundSurface>();
  const key = (id: string, layer: string) => `${id}/${layer}`;
  for (const p of Object.keys(manifest.products)) {
    const h = HEADER_RE.exec(p);
    if (h) out.set(key(h[1], h[2]), { bodyId: Number(h[1]), layer: h[2], path: p, tilePattern: `surfaces/${h[1]}/${h[2]}/*`, tiles: { count: 0, bytes: 0, paths: [] } });
  }
  for (const [p, e] of Object.entries(manifest.products)) {
    const t = TILE_RE.exec(p);
    const f = t && out.get(key(t[1], t[2]));
    if (f) { f.tiles.count++; f.tiles.bytes += e.bytes; f.tiles.paths.push(p); }
  }
  return [...out.values()];
}

function str(x: unknown): string | null {
  return typeof x === 'string' && x ? x : null;
}

export function parseSurfaceHeader(f: FoundSurface, raw: unknown): SurfaceLayer {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${f.path}: expected a JSON object`);
  const h = raw as Record<string, unknown>;
  const levels = typeof h.levels === 'number' ? h.levels : Array.isArray(h.levels) ? h.levels.length : null;
  const labelRaw = (h.label ?? (h.provenance as Record<string, unknown> | undefined)?.label) as unknown;
  const label: Label = (LABEL_ORDER as readonly string[]).includes(labelRaw as string) ? (labelRaw as Label) : 'unknown';
  const sources = Array.isArray(h.sources) ? h.sources.filter((s): s is string => typeof s === 'string') : [];
  return {
    bodyId: f.bodyId,
    layer: f.layer,
    path: f.path,
    tilePrefix: `surfaces/${f.bodyId}/${f.layer}/`,
    levels,
    label,
    sources,
    epoch: str(h.epoch) ?? str(h.observed) ?? null,
    method: str(h.method),
    notes: str(h.notes),
    tiles: { count: f.tiles.count, bytes: f.tiles.bytes },
    header: h,
  };
}
