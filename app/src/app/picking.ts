// Screen ↔ world math for picking and labels. Pure. All positions are camera-relative (km, ICRF), so
// rays start at the origin. Pixel coordinates are CSS pixels with (0,0) at the top-left.

import type { Mat3, Vec3 } from './ports';
import { dot, len, mulMtV, mulMV, norm, scale } from './vec';

export interface Viewport {
  orient: Mat3;
  fovY: number;
  width: number;
  height: number;
}

/** Unit ray direction (ICRF) through pixel (x, y). */
export function pixelRay(v: Viewport, x: number, y: number): Vec3 {
  const t = Math.tan(v.fovY / 2);
  const aspect = v.width / v.height;
  const cx = ((2 * x) / v.width - 1) * t * aspect;
  const cy = (1 - (2 * y) / v.height) * t;
  return norm(mulMV(v.orient, [cx, cy, -1]));
}

export interface Projected {
  x: number;
  y: number;
  /** Distance along the view axis, km (> 0 in front). */
  depth: number;
  /** Straight-line distance, km. */
  dist: number;
}

/** Project a camera-relative point; null if behind the camera. */
export function project(v: Viewport, rel: Vec3): Projected | null {
  const c = mulMtV(v.orient, rel);
  const depth = -c[2];
  if (!(depth > 0)) return null;
  const t = Math.tan(v.fovY / 2);
  const aspect = v.width / v.height;
  return {
    x: ((c[0] / depth / (t * aspect) + 1) * v.width) / 2,
    y: ((1 - c[1] / depth / t) * v.height) / 2,
    depth,
    dist: len(rel),
  };
}

/** Pixels per radian near the view center. */
export function pixelsPerRadian(v: Viewport): number {
  return v.height / (2 * Math.tan(v.fovY / 2));
}

/** Angular radius (rad) of a sphere of radius r at distance d. */
export function angularRadius(r: number, d: number): number {
  return d > r ? Math.asin(r / d) : Math.PI / 2;
}

/**
 * First intersection of the ray t·dir (t ≥ 0, |dir| = 1) with a triaxial ellipsoid.
 * `orient` is body-fixed → ICRF (row-major); null treats the body as a sphere of its largest radius.
 * Returns t (km), 0 if the origin is inside, or null for a miss.
 */
export function rayEllipsoid(dir: Vec3, center: Vec3, radii: Vec3, orient: Mat3 | null): number | null {
  let o: Vec3 = scale(center, -1);
  let d: Vec3 = dir;
  let r: Vec3 = radii;
  if (orient) {
    o = mulMtV(orient, o);
    d = mulMtV(orient, d);
  } else {
    const m = Math.max(radii[0], radii[1], radii[2]);
    r = [m, m, m];
  }
  const os: Vec3 = [o[0] / r[0], o[1] / r[1], o[2] / r[2]];
  const ds: Vec3 = [d[0] / r[0], d[1] / r[1], d[2] / r[2]];
  const a = dot(ds, ds);
  const c = dot(os, os) - 1;
  if (c <= 0) return 0;
  // Closest approach in the scaled space (numerically stable for distant bodies).
  const tca = -dot(os, ds) / a;
  if (tca < 0) return null;
  const px = os[0] + ds[0] * tca, py = os[1] + ds[1] * tca, pz = os[2] + ds[2] * tca;
  const d2 = px * px + py * py + pz * pz;
  if (d2 > 1) return null;
  const thc = Math.sqrt((1 - d2) / a);
  return tca - thc;
}

export interface PickTarget {
  id: number;
  /** Camera-relative position, km. */
  pos: Vec3;
  /** Drawn radii (null → point). */
  radii: Vec3 | null;
  orient: Mat3 | null;
}

export interface PickHit {
  id: number;
  via: 'surface' | 'proximity';
  /** Distance to the hit (surface) or to the center (proximity), km. */
  dist: number;
}

/**
 * Pick at pixel (x, y): the nearest ray–ellipsoid hit, unless a body within `tolPx` pixels of the ray
 * (edge of its disk, or its point) lies in front of that hit — sub-pixel bodies stay clickable.
 */
export function pick(v: Viewport, targets: PickTarget[], x: number, y: number, tolPx = 6): PickHit | null {
  const ray = pixelRay(v, x, y);
  const tolRad = tolPx / pixelsPerRadian(v);
  let surf: PickHit | null = null;
  const near: { id: number; dist: number; ang: number }[] = [];
  for (const t of targets) {
    const d = len(t.pos);
    if (t.radii) {
      const h = rayEllipsoid(ray, t.pos, t.radii, t.orient);
      if (h !== null) {
        if (!surf || h < surf.dist) surf = { id: t.id, via: 'surface', dist: h };
        continue; // directly hit: not a proximity candidate
      }
    }
    if (!(d > 0)) continue;
    const ang = Math.acos(Math.max(-1, Math.min(1, dot(ray, t.pos) / d)));
    const angR = t.radii ? angularRadius(Math.max(t.radii[0], t.radii[1], t.radii[2]), d) : 0;
    if (ang - angR <= tolRad) near.push({ id: t.id, dist: d, ang: ang - angR });
  }
  // Near misses count only if they are in front of the surface that was hit.
  const cands = surf ? near.filter((n) => n.dist < surf!.dist) : near;
  cands.sort((a, b) => a.ang - b.ang || a.dist - b.dist);
  if (cands.length) return { id: cands[0].id, via: 'proximity', dist: cands[0].dist };
  return surf;
}

/** Is the center of `target` hidden behind another body's drawn ellipsoid? */
export function occluded(target: PickTarget, others: PickTarget[]): boolean {
  const d = len(target.pos);
  if (!(d > 0)) return false;
  const dir = scale(target.pos, 1 / d);
  const r = target.radii ? Math.max(target.radii[0], target.radii[1], target.radii[2]) : 0;
  for (const o of others) {
    if (o.id === target.id || !o.radii) continue;
    const t = rayEllipsoid(dir, o.pos, o.radii, o.orient);
    if (t !== null && t < d - r) return true;
  }
  return false;
}
