// Label placement for the names overlay. Pure: projected anchors in, placed boxes out.
// Greedy by priority; a label is dropped if its box overlaps an already placed one or leaves the
// screen, which declutters (e.g. moons collapse into their planet when seen from far away).

export interface LabelItem {
  id: number;
  /** Anchor (projected body center), CSS px. */
  x: number;
  y: number;
  /** Projected disk radius, px (0 for points). */
  r: number;
  text: string;
  /** Higher first. */
  priority: number;
}

export interface PlacedLabel {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutOptions {
  width: number;
  height: number;
  /** Estimated label width in px for a text. */
  measure: (text: string) => number;
  lineHeight?: number;
  gap?: number;
  margin?: number;
}

export function layoutLabels(items: LabelItem[], o: LayoutOptions): PlacedLabel[] {
  const lh = o.lineHeight ?? 16;
  const gap = o.gap ?? 6;
  const margin = o.margin ?? 2;
  const placed: PlacedLabel[] = [];
  const anchors: LabelItem[] = [];
  const sorted = [...items].sort((a, b) => b.priority - a.priority || b.r - a.r || a.id - b.id);
  for (const it of sorted) {
    // An anchor inside (or within a few px of) an already labelled body's disk collapses into it.
    if (anchors.some((a) => Math.hypot(a.x - it.x, a.y - it.y) < a.r + 4)) continue;
    const w = o.measure(it.text);
    // Right of the disk, vertically centered; if that leaves the screen, try the left side.
    const tries = [
      { x: it.x + it.r + gap, y: it.y - lh / 2 },
      { x: it.x - it.r - gap - w, y: it.y - lh / 2 },
    ];
    // Prefer a side whose box does not cover another body's position (so that body stays clickable);
    // otherwise accept one that only avoids other labels.
    const boxes = tries
      .map((p) => ({ id: it.id, x: p.x, y: p.y, w, h: lh }))
      .filter((b) => b.x >= margin && b.y >= margin && b.x + w <= o.width - margin && b.y + lh <= o.height - margin)
      .filter((b) => !placed.some((q) => overlaps(q, b, 2)));
    const box = boxes.find((b) => !items.some((a) => a.id !== it.id && inside(a.x, a.y, b, 3))) ?? boxes[0];
    if (box) {
      placed.push(box);
      anchors.push(it);
    }
  }
  return placed;
}

function inside(x: number, y: number, b: PlacedLabel, pad: number): boolean {
  return x > b.x - pad && x < b.x + b.w + pad && y > b.y - pad && y < b.y + b.h + pad;
}

function overlaps(a: PlacedLabel, b: PlacedLabel, pad: number): boolean {
  return a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
}

/** Rough text width for 12px system-ui (layout only; no DOM measurement per frame). */
export function estimateWidth(text: string, pxPerChar = 6.6, pad = 10): number {
  return Math.ceil(text.length * pxPerChar + pad);
}
