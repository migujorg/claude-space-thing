// Declutter for the names/markers overlay (non-physical). Pure: projected candidates in, what to show out.
//
// Ranking (overlay priority only — nothing here is drawn as a physical quantity):
//   selected ≫ Sun/planets/dwarf planets ≫ moons; moons of the system in focus rank above other systems';
//   then estimated brightness where admitted (reflected light, phase ignored), apparent size where the size is
//   admitted, and for bodies of unknown size and brightness their proximity relative to the focus body.
// Markers (hollow rings for bodies with nothing drawable) appear for the focus system and the selection only,
// never closer than a minimum spacing, and at most `maxMarkers`. Labels are capped overall and separately for
// such unknown bodies; the selected body's label is always placed.

import type { BodyKind } from '../data/schema';
import { estimateWidth, layoutLabels, type LabelItem, type PlacedLabel } from './labelLayout';

export interface OverlayCandidate {
  id: number;
  /** Projected position, CSS px. */
  x: number;
  y: number;
  /** Projected radius of the drawn disk, px (0 for points and markers). */
  rPx: number;
  /** Distance from the camera, km. */
  dist: number;
  kind: BodyKind;
  selected: boolean;
  /** Belongs to the system in focus (the target's planet and its moons). */
  focus: boolean;
  /** log10 of the estimated reflected illuminance at the eye (lux), when brightness is admitted. */
  brightness: number | null;
  /** Apparent angular radius, px, when the size is admitted (may be < 1). */
  sizePx: number | null;
  /** Nothing drawable: shown only through a marker. */
  marker: boolean;
  text: string;
}

export interface DeclutterOptions {
  width: number;
  height: number;
  /** Distance to the focus body, km (for the proximity term). */
  focusDist: number | null;
  blocked?: { x: number; y: number; w: number; h: number }[];
  measure?: (text: string) => number;
  maxLabels?: number;
  maxUnknownLabels?: number;
  maxMarkers?: number;
  markerMinSepPx?: number;
}

export interface DeclutterResult {
  labels: PlacedLabel[];
  markers: number[];
}

const KIND_BASE: Record<BodyKind, number> = { star: 300, planet: 200, 'dwarf-planet': 150, moon: 0, 'small-body': 0, barycenter: -1000 };

export function scoreCandidate(c: OverlayCandidate, focusDist: number | null): number {
  let s = KIND_BASE[c.kind] ?? 0;
  if (c.selected) s += 1e6;
  if (c.focus) s += 50;
  else if (c.kind === 'moon') s -= 50;
  if (c.brightness !== null) s += Math.max(0, Math.min(100, 10 * (c.brightness + 12)));
  if (c.sizePx !== null) s += 20 + 5 * Math.log10(Math.max(c.sizePx, 0.01));
  if (c.brightness === null && c.sizePx === null && focusDist && c.dist > 0) s += Math.max(-30, Math.min(30, 10 * Math.log10(focusDist / c.dist)));
  return s;
}

export function declutter(cands: OverlayCandidate[], o: DeclutterOptions): DeclutterResult {
  const maxLabels = o.maxLabels ?? Math.max(10, Math.round((o.width * o.height) / 40000));
  const maxUnknown = o.maxUnknownLabels ?? 6;
  const maxMarkers = o.maxMarkers ?? 30;
  const sep = o.markerMinSepPx ?? 14;
  const scored = cands.map((c) => ({ c, s: scoreCandidate(c, o.focusDist) })).sort((a, b) => b.s - a.s || a.c.id - b.c.id);

  // Markers: focus system or selected, spaced apart, capped.
  const markers: OverlayCandidate[] = [];
  for (const { c } of scored) {
    if (!c.marker || !(c.focus || c.selected)) continue;
    if (!c.selected && markers.length >= maxMarkers) continue;
    if (!c.selected && markers.some((m) => Math.hypot(m.x - c.x, m.y - c.y) < sep)) continue;
    markers.push(c);
  }
  const markerIds = new Set(markers.map((m) => m.id));

  // Labels: ranked, capped; a marker-only body is labelled only when its marker is shown.
  const items: LabelItem[] = [];
  let unknown = 0;
  for (const { c, s } of scored) {
    if (items.length >= maxLabels && !c.selected) continue;
    const isUnknown = c.brightness === null && c.sizePx === null;
    if (c.marker && !markerIds.has(c.id)) continue;
    if (isUnknown && !c.selected) {
      if (unknown >= maxUnknown) continue;
      unknown++;
    }
    items.push({ id: c.id, x: c.x, y: c.y, r: c.rPx, text: c.text, priority: s, force: c.selected });
  }
  const labels = layoutLabels(items, { width: o.width, height: o.height, measure: o.measure ?? ((t) => estimateWidth(t)), blocked: o.blocked });
  return { labels, markers: markers.map((m) => m.id) };
}
