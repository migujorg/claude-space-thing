import { describe, expect, it } from 'vitest';
import { lookRotation } from '../src/app/camera';
import { occluded, pick, pixelRay, pixelsPerRadian, project, rayEllipsoid, type Viewport } from '../src/app/picking';
import type { Mat3, Vec3 } from '../src/app/ports';
import { DEG, norm } from '../src/app/vec';

const vp: Viewport = { orient: lookRotation([1, 0, 0], [0, 0, 1]), fovY: 50 * DEG, width: 1600, height: 900 };

describe('projection', () => {
  it('center pixel looks straight ahead; project inverts pixelRay', () => {
    const r = pixelRay(vp, 800, 450);
    expect(r[0]).toBeCloseTo(1, 12);
    for (const [x, y] of [[10, 20], [1500, 880], [800, 1]]) {
      const d = pixelRay(vp, x, y);
      const p = project(vp, [d[0] * 1e9, d[1] * 1e9, d[2] * 1e9])!;
      expect(p.x).toBeCloseTo(x, 6);
      expect(p.y).toBeCloseTo(y, 6);
    }
    expect(project(vp, [-1, 0, 0])).toBeNull();
  });
  it('up on screen is +Z here, right is −Y', () => {
    const p = project(vp, [100, -10, 10])!;
    expect(p.x).toBeGreaterThan(800);
    expect(p.y).toBeLessThan(450);
  });
});

describe('rayEllipsoid', () => {
  it('hits a sphere at the right distance', () => {
    expect(rayEllipsoid([1, 0, 0], [100, 0, 0], [10, 10, 10], null)).toBeCloseTo(90, 9);
    expect(rayEllipsoid([1, 0, 0], [100, 20, 0], [10, 10, 10], null)).toBeNull();
    expect(rayEllipsoid([1, 0, 0], [-100, 0, 0], [10, 10, 10], null)).toBeNull();
    expect(rayEllipsoid([1, 0, 0], [1, 0, 0], [10, 10, 10], null)).toBe(0);
  });
  it('respects triaxial shape and orientation', () => {
    // Long axis (a = 50) along body x; body rotated 90° about z so the long axis lies along ICRF y.
    const rot: Mat3 = [0, -1, 0, 1, 0, 0, 0, 0, 1];
    const radii: Vec3 = [50, 5, 5];
    // A ray along ICRF x passing 30 km off-center in y hits only when the long axis is along y.
    const dir = norm([1, 0, 0]);
    expect(rayEllipsoid(dir, [1000, 30, 0], radii, rot)).not.toBeNull();
    expect(rayEllipsoid(dir, [1000, 30, 0], radii, [1, 0, 0, 0, 1, 0, 0, 0, 1])).toBeNull();
    expect(rayEllipsoid(dir, [1000, 0, 0], radii, rot)).toBeCloseTo(995, 9);
  });
  it('stays accurate for a small body at planetary distance', () => {
    const d = 4.5e9;
    expect(rayEllipsoid([1, 0, 0], [d, 0, 0], [1, 1, 1], null)).toBeCloseTo(d - 1, 3);
    expect(rayEllipsoid(norm([d, 0.9, 0]), [d, 0, 0], [1, 1, 1], null)).not.toBeNull();
  });
});

describe('pick', () => {
  const planet = { id: 1, pos: [1e6, 0, 0] as Vec3, radii: [6e4, 6e4, 6e4] as Vec3, orient: null };
  it('picks a resolved body by ray hit', () => {
    expect(pick(vp, [planet], 800, 450)).toMatchObject({ id: 1, via: 'surface' });
  });
  it('picks a sub-pixel body within a few pixels, and prefers it when in front of a disk', () => {
    const tiny = { id: 2, pos: [5e8, 0, 0] as Vec3, radii: [1, 1, 1] as Vec3, orient: null };
    const ppr = pixelsPerRadian(vp);
    // 4 px to the right (screen right = −Y)
    const off = (4 / ppr) * 5e8;
    const t2 = { ...tiny, pos: [5e8, -off, 0] as Vec3 };
    expect(pick(vp, [t2], 800, 450)).toMatchObject({ id: 2, via: 'proximity' });
    expect(pick(vp, [t2], 800, 450, 2)).toBeNull();
    // moon in front of the planet disk: proximity wins because it is closer
    const moon = { id: 3, pos: [5e5, -1, 0] as Vec3, radii: null, orient: null };
    expect(pick(vp, [planet, moon], 800, 450)?.id).toBe(3);
    // a point behind the planet disk does not steal the click
    const behind = { id: 4, pos: [5e9, 0, 0] as Vec3, radii: null, orient: null };
    expect(pick(vp, [planet, behind], 800, 450)?.id).toBe(1);
  });
});

describe('occlusion', () => {
  it('a label is hidden when another body is in front', () => {
    const planet = { id: 1, pos: [1e6, 0, 0] as Vec3, radii: [6e4, 6e4, 6e4] as Vec3, orient: null };
    const hidden = { id: 2, pos: [2e6, 1e4, 0] as Vec3, radii: [1e3, 1e3, 1e3] as Vec3, orient: null };
    const visible = { id: 3, pos: [5e5, 1e4, 0] as Vec3, radii: [1e3, 1e3, 1e3] as Vec3, orient: null };
    expect(occluded(hidden, [planet, hidden, visible])).toBe(true);
    expect(occluded(visible, [planet, hidden, visible])).toBe(false);
    expect(occluded(planet, [planet, hidden, visible])).toBe(false);
  });
});
