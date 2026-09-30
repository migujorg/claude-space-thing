// Surface map layers (docs/architecture.md §4.4, schema.ts SurfaceLayerHeader): surfaces/<naifId>/<layer>.json
// headers next to their tile pyramids. The manifest lists each pyramid as one directory entry
// ("surfaces/<id>/<layer>/", total bytes) plus a "<layer>.sha256" listing of every tile; older builds listed
// tiles individually. The shell reads headers only (for provenance and the Data panel); tiles are the renderer's.

import type { Label, Manifest, SurfaceLayerHeader } from './schema';
import { LABEL_ORDER } from './schema';

export interface SurfaceLayer {
  bodyId: number;
  /** "albedo", "height", "hapke", ... */
  layer: string;
  /** Header product path, e.g. "surfaces/301/albedo.json". */
  path: string;
  /** Tile path prefix, e.g. "surfaces/301/albedo/". */
  tilePrefix: string;
  /** Number of pyramid levels, if the header states it. */
  levels: number | null;
  /** Provenance of the layer's values (brightness pattern / heights / parameters). */
  label: Label;
  /** Provenance of the per-texel colour (albedo layers), if stated. */
  colorLabel?: Label | null;
  sources: string[];
  epoch: string | null;
  method: string | null;
  notes: string | null;
  /** Fraction of the sphere covered by data, if stated. */
  coverage?: number | null;
  tiles: { count: number; bytes: number };
  /** The header exactly as written by the pipeline. */
  header: Record<string, unknown>;
}

export interface FoundSurface {
  bodyId: number;
  layer: string;
  path: string;
  /** Report key for the tiles ("surfaces/<id>/<layer>/*"). */
  tilePattern: string;
  tiles: { count: number; bytes: number; paths: string[] };
}

const HEADER_RE = /^surfaces\/(\d+)\/([^/]+)\.json$/;
const TILE_RE = /^surfaces\/(\d+)\/([^/]+)\/.+\.bin$/;
const DIR_RE = /^surfaces\/(\d+)\/([^/]+)\/$/;
const LISTING_RE = /^surfaces\/(\d+)\/([^/]+)\.sha256$/;

/** Layer headers listed in the manifest, with their tiles (directory entries, listings or individual tiles). */
export function discoverSurfaces(manifest: Manifest | null): FoundSurface[] {
  if (!manifest) return [];
  const out = new Map<string, FoundSurface>();
  const key = (id: string, layer: string) => `${id}/${layer}`;
  for (const p of Object.keys(manifest.products)) {
    const h = HEADER_RE.exec(p);
    if (h) out.set(key(h[1], h[2]), { bodyId: Number(h[1]), layer: h[2], path: p, tilePattern: `surfaces/${h[1]}/${h[2]}/*`, tiles: { count: 0, bytes: 0, paths: [] } });
  }
  for (const [p, e] of Object.entries(manifest.products)) {
    const m = TILE_RE.exec(p) ?? DIR_RE.exec(p) ?? LISTING_RE.exec(p);
    const f = m && out.get(key(m[1], m[2]));
    if (!f) continue;
    f.tiles.paths.push(p);
    if (TILE_RE.test(p)) f.tiles.count++;
    if (!LISTING_RE.test(p)) f.tiles.bytes += e.bytes;
  }
  return [...out.values()];
}

function str(x: unknown): string | null {
  return typeof x === 'string' && x ? x : null;
}

function label(x: unknown): Label | null {
  return (LABEL_ORDER as readonly string[]).includes(x as string) ? (x as Label) : null;
}

export function parseSurfaceHeader(f: FoundSurface, raw: unknown): SurfaceLayer {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${f.path}: expected a JSON object`);
  const h = raw as Partial<SurfaceLayerHeader> & Record<string, unknown>;
  const levels = Array.isArray(h.levels) ? h.levels.length : typeof h.levels === 'number' ? h.levels : typeof h.maxLevel === 'number' && typeof h.minLevel === 'number' ? h.maxLevel - h.minLevel + 1 : null;
  const lab = label(h.brightness?.label) ?? label(h.label) ?? 'unknown';
  const sources = Array.isArray(h.sources) ? h.sources.filter((s): s is string => typeof s === 'string') : h.brightness?.sources ?? [];
  const ep = h.epoch && typeof h.epoch === 'object' ? h.epoch : null;
  const epoch = ep ? ep.mid ?? (ep.start && ep.end ? `${ep.start} – ${ep.end}` : ep.observed ?? null) : str(h.epoch);
  const stats = h.stats && typeof h.stats === 'object' ? h.stats : null;
  return {
    bodyId: f.bodyId,
    layer: f.layer,
    path: f.path,
    tilePrefix: `surfaces/${f.bodyId}/${f.layer}/`,
    levels,
    label: lab,
    colorLabel: label(h.color?.label),
    sources,
    epoch: epoch ?? null,
    method: str(h.brightness?.method) ?? str(h.method),
    notes: Array.isArray(h.notes) ? h.notes.join(' ') : str(h.notes),
    coverage: typeof h.coverage?.areaFraction === 'number' ? h.coverage.areaFraction : null,
    tiles: { count: stats?.tiles ?? f.tiles.count, bytes: stats?.bytes ?? f.tiles.bytes },
    header: h as Record<string, unknown>,
  };
}
