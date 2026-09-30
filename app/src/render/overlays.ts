// Display-space overlays (non-physical, drawn after tone mapping): orbit polylines, markers, and the
// provenance-tint palette.

import type { Label } from '../data/schema';
import type { OrbitPolyline } from './scene';
import { dot, type V3 } from './raycast';

/**
 * Provenance tint palette (Okabe & Ito 2008, "Color Universal Design", a palette distinguishable
 * under common colour-vision deficiencies). Exported so the shell can draw the legend.
 */
export const PROVENANCE_TINT: Record<Label, [number, number, number]> = {
  measured: [0 / 255, 158 / 255, 115 / 255], // bluish green
  derived: [86 / 255, 180 / 255, 233 / 255], // sky blue
  estimated: [230 / 255, 159 / 255, 0 / 255], // orange
  synthetic: [204 / 255, 121 / 255, 167 / 255], // reddish purple
  unknown: [213 / 255, 94 / 255, 0 / 255], // vermillion
};
export const PROVENANCE_TINT_ALPHA = 0.45;

export const ORBIT_COLOR: [number, number, number, number] = [0.55, 0.62, 0.75, 0.55];
export const ORBIT_SELECTED_COLOR: [number, number, number, number] = [1.0, 0.85, 0.35, 0.95];
export const MARKER_COLOR: [number, number, number, number] = [0.75, 0.75, 0.75, 0.9];

export interface CameraGeom {
  right: V3;
  up: V3;
  back: V3;
  tanX: number;
  tanY: number;
  W: number;
  H: number;
  near: number;
  /** Angle subtended by one pixel at the image centre, rad. */
  pixelAngle: number;
}

/** Camera-space coordinates of a camera-relative world vector. */
export function toCam(g: CameraGeom, w: V3): V3 {
  return [dot(g.right, w), dot(g.up, w), dot(g.back, w)];
}

/** NDC of a camera-space point in front of the camera (z < 0). */
export function camToNdc(g: CameraGeom, c: V3): [number, number] {
  return [c[0] / (g.tanX * -c[2]), c[1] / (g.tanY * -c[2])];
}

/**
 * Append screen-space quads (x, y, depth, r, g, b, a per vertex; 6 vertices per segment) for orbit
 * polylines. Points are float64 camera-relative km; segments are clipped against the near plane in
 * float64 before projection. Depth is near/z so the overlay can hide behind bodies.
 */
export function orbitVertices(orbits: OrbitPolyline[], g: CameraGeom, out: number[]): void {
  for (const o of orbits) {
    const col = o.selected ? ORBIT_SELECTED_COLOR : ORBIT_COLOR;
    const widthPx = o.selected ? 2.5 : 1.5;
    const pts = o.points;
    const n = Math.floor(pts.length / 3);
    let prev: V3 | null = null;
    for (let i = 0; i < n; i++) {
      const c = toCam(g, [pts[3 * i], pts[3 * i + 1], pts[3 * i + 2]]);
      if (prev) segment(prev, c, g, widthPx, col, out);
      prev = c;
    }
  }
}

function segment(a: V3, b: V3, g: CameraGeom, widthPx: number, col: readonly number[], out: number[]): void {
  const zc = -g.near * 2;
  if (a[2] > zc && b[2] > zc) return;
  if (a[2] > zc || b[2] > zc) {
    const t = (zc - a[2]) / (b[2] - a[2]);
    const m: V3 = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), zc];
    if (a[2] > zc) a = m; else b = m;
  }
  const pa = camToNdc(g, a);
  const pb = camToNdc(g, b);
  if ((pa[0] < -1.1 && pb[0] < -1.1) || (pa[0] > 1.1 && pb[0] > 1.1) || (pa[1] < -1.1 && pb[1] < -1.1) || (pa[1] > 1.1 && pb[1] > 1.1)) return;
  const dx = (pb[0] - pa[0]) * g.W * 0.5;
  const dy = (pb[1] - pa[1]) * g.H * 0.5;
  const L = Math.hypot(dx, dy);
  if (!(L > 1e-6) || L > 1e5) return;
  const nx = ((-dy / L) * widthPx * 0.5 * 2) / g.W;
  const ny = ((dx / L) * widthPx * 0.5 * 2) / g.H;
  const da = g.near / -a[2];
  const db = g.near / -b[2];
  const v = (x: number, y: number, d: number) => out.push(x, y, d, col[0], col[1], col[2], col[3]);
  v(pa[0] - nx, pa[1] - ny, da); v(pb[0] - nx, pb[1] - ny, db); v(pa[0] + nx, pa[1] + ny, da);
  v(pa[0] + nx, pa[1] + ny, da); v(pb[0] - nx, pb[1] - ny, db); v(pb[0] + nx, pb[1] + ny, db);
}

/** Hollow ring marker (position known, size/brightness not: docs/architecture.md §5.3). */
export function ringVertices(ndc: [number, number], radiusPx: number, widthPx: number, col: readonly number[], g: CameraGeom, out: number[]): void {
  const seg = 24;
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * 2 * Math.PI;
    const a1 = ((i + 1) / seg) * 2 * Math.PI;
    const p = (a: number, r: number): [number, number] => [ndc[0] + (Math.cos(a) * r * 2) / g.W, ndc[1] + (Math.sin(a) * r * 2) / g.H];
    const [x0, y0] = p(a0, radiusPx - widthPx / 2);
    const [x1, y1] = p(a1, radiusPx - widthPx / 2);
    const [x2, y2] = p(a0, radiusPx + widthPx / 2);
    const [x3, y3] = p(a1, radiusPx + widthPx / 2);
    const v = (x: number, y: number) => out.push(x, y, 0, col[0], col[1], col[2], col[3]);
    v(x0, y0); v(x1, y1); v(x2, y2); v(x2, y2); v(x1, y1); v(x3, y3);
  }
}
