import { describe, expect, it } from 'vitest';
import {
  azElFromDir, clampDist, dirFromAzEl, flySpeed, forwardOf, freeLook, freeMove, lookRotation, minDistance, nearestAltitude,
  orbitPose, orbitRotate, orbitZoom, pushOutside, startTravel, sunFrame, sunlitDirection, toFree, toOrbit, travelDone,
  travelEndCam, travelPose, upOf, viewDistance, type OrbitCam,
} from '../src/app/camera';
import type { Mat3, Vec3 } from '../src/app/ports';
import { column, cross, DEG, dot, len, norm, sub, transpose, mulMM } from '../src/app/vec';

const close = (a: Vec3, b: Vec3, eps = 1e-9) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], -Math.log10(eps)));
function orthonormal(m: Mat3) {
  const i = mulMM(transpose(m), m);
  [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((x, k) => expect(i[k]).toBeCloseTo(x, 9));
  // right-handed: right × up = back
  close(cross(column(m, 0), column(m, 1)), column(m, 2));
}

describe('lookRotation', () => {
  it('builds a right-handed orthonormal camera → ICRF matrix looking along forward', () => {
    const f = norm([1, 2, 3]);
    const m = lookRotation(f, [0, 0, 1]);
    orthonormal(m);
    close(forwardOf(m), f);
    expect(dot(upOf(m), [0, 0, 1])).toBeGreaterThan(0);
  });
  it('handles forward parallel to the up hint', () => {
    orthonormal(lookRotation([0, 0, 1], [0, 0, 1]));
  });
});

describe('orbit camera', () => {
  const cam: OrbitCam = { mode: 'orbit', target: 1, dir: [1, 0, 0], dist: 10000, up: [0, 0, 1] };
  it('pose sits at target + dir·dist looking at the target', () => {
    const p = orbitPose(cam, [1e9, 2e9, 3e9]);
    close(p.pos, [1e9 + 10000, 2e9, 3e9], 1e-3);
    close(forwardOf(p.orient), [-1, 0, 0]);
  });
  it('follows the target as it moves (translation only)', () => {
    const a = orbitPose(cam, [0, 0, 0]), b = orbitPose(cam, [5, 6, 7]);
    close(sub(b.pos, a.pos), [5, 6, 7]);
    expect(b.orient).toEqual(a.orient);
  });
  it('drag rotates around the target, keeping distance and orthogonal up', () => {
    let c = cam;
    for (let i = 0; i < 50; i++) c = orbitRotate(c, 0.07, -0.05);
    expect(len(c.dir)).toBeCloseTo(1, 12);
    expect(c.dist).toBe(10000);
    expect(dot(c.dir, c.up)).toBeCloseTo(0, 9);
    // dragging right moves the camera toward screen-left
    const r = orbitRotate(cam, 0.1, 0);
    const right0 = column(lookRotation([-1, 0, 0], [0, 0, 1]), 0);
    expect(dot(r.dir, right0)).toBeLessThan(0);
  });
  it('wheel zoom is logarithmic in altitude and never enters the body', () => {
    const R = 6000;
    const c0: OrbitCam = { ...cam, dist: R + 1000 };
    const c1 = orbitZoom(c0, 1, R);
    const c2 = orbitZoom(c1, 1, R);
    expect((c2.dist - R) / (c1.dist - R)).toBeCloseTo((c1.dist - R) / (c0.dist - R), 9);
    let c = c0;
    for (let i = 0; i < 500; i++) c = orbitZoom(c, -1, R);
    expect(c.dist).toBeGreaterThan(R);
    expect(c.dist).toBeCloseTo(minDistance(R), 6);
    expect(clampDist(1, R)).toBe(minDistance(R));
  });
});

describe('sun-relative frame', () => {
  it('az = el = 0 points toward the Sun; round-trips az/el', () => {
    const toSun: Vec3 = [-3e8, 1e8, 2e7];
    const f = sunFrame(toSun);
    close(dirFromAzEl(f, 0, 0), norm(toSun));
    for (const [az, el] of [[30, 10], [-120, -45], [179, 80]]) {
      const ae = azElFromDir(f, dirFromAzEl(f, az * DEG, el * DEG));
      expect(ae.az / DEG).toBeCloseTo(az, 9);
      expect(ae.el / DEG).toBeCloseTo(el, 9);
    }
  });
  it('default go-to direction is on the sunlit side', () => {
    const toSun: Vec3 = [0, -1e8, 0];
    expect(dot(sunlitDirection(toSun), norm(toSun))).toBeGreaterThan(0.8);
  });
  it('viewDistance frames the body with a fixed angular size', () => {
    const d = viewDistance(1000, 50 * DEG);
    expect(d).toBeGreaterThan(1000);
    expect(viewDistance(2000, 50 * DEG) / d).toBeCloseTo(2, 12);
  });
});

describe('free flight', () => {
  it('speed scales with altitude above the nearest surface', () => {
    expect(flySpeed(2000) / flySpeed(1000)).toBeCloseTo(2, 12);
    expect(flySpeed(1000, 'fast')).toBeGreaterThan(flySpeed(1000));
    expect(flySpeed(1000, 'slow')).toBeLessThan(flySpeed(1000));
    const n = nearestAltitude([0, 0, 1500], [{ center: [0, 0, 0], radius: 1000 }, { center: [0, 0, 1e6], radius: 10 }]);
    expect(n.alt).toBeCloseTo(500, 9);
    expect(n.index).toBe(0);
  });
  it('moves along the view direction and is pushed out of bodies', () => {
    const c = toFree({ pos: [0, 0, 5000], orient: lookRotation([0, 0, -1], [0, 1, 0]) }, null, null);
    const m = freeMove(c, [0, 0, -1], 1, 100);
    close(m.rel, [0, 0, 4900]);
    const inside = pushOutside([0, 0, 10], [{ center: [0, 0, 0], radius: 1000 }]);
    expect(len(inside)).toBeCloseTo(minDistance(1000), 6);
  });
  it('mouse look keeps the orientation orthonormal', () => {
    let c = toFree({ pos: [0, 0, 0], orient: lookRotation([1, 0, 0], [0, 0, 1]) }, null, null);
    for (let i = 0; i < 100; i++) c = freeLook(c, 0.03, 0.02);
    orthonormal(c.orient);
    // positive dx turns right
    const c2 = freeLook(toFree({ pos: [0, 0, 0], orient: lookRotation([1, 0, 0], [0, 0, 1]) }, null, null), 0.1, 0);
    expect(forwardOf(c2.orient)[1]).toBeLessThan(0); // right of +X (up +Z) is −Y
  });
  it('free ↔ orbit conversions preserve the position', () => {
    const pose = { pos: [100, 200, 300] as Vec3, orient: lookRotation([0, 1, 0], [0, 0, 1]) };
    const o = toOrbit(pose, 7, [0, 0, 0], 10);
    close(orbitPose(o, [0, 0, 0]).pos, pose.pos, 1e-9);
  });
});

describe('magic travel', () => {
  it('interpolates distance logarithmically, ends at the requested view, never inside the target', () => {
    const R = 1000;
    const from = { pos: [5e9, 0, 0] as Vec3, orient: lookRotation([0, 1, 0], [0, 0, 1]) };
    const target: Vec3 = [0, 0, 0];
    const endDir = norm([0, -1, 0.2]);
    const tr = startTravel(from, target, 5, endDir, 8000, [0, 0, 1]);
    expect(tr.duration).toBeGreaterThan(1);
    let prev = Infinity;
    const steps = 100;
    for (let i = 0; i <= steps; i++) {
      tr.elapsed = (tr.duration * i) / steps;
      const p = travelPose(tr, target);
      const d = len(sub(p.pos, target));
      expect(d).toBeGreaterThan(R);
      expect(d).toBeLessThanOrEqual(prev * (1 + 1e-12));
      prev = d;
      orthonormal(p.orient);
    }
    // halfway (eased) the distance is the geometric mean
    tr.elapsed = tr.duration / 2;
    expect(len(travelPose(tr, target).pos)).toBeCloseTo(Math.sqrt(5e9 * 8000), 0);
    tr.elapsed = tr.duration;
    expect(travelDone(tr)).toBe(true);
    const end = travelPose(tr, target);
    close(norm(end.pos), endDir, 1e-9);
    close(forwardOf(end.orient), norm([0, 1, -0.2]), 1e-9);
    const cam = travelEndCam(tr);
    expect(cam.dist).toBe(8000);
  });
  it('the travel follows a moving target', () => {
    const tr = startTravel({ pos: [1e6, 0, 0], orient: lookRotation([-1, 0, 0], [0, 0, 1]) }, [0, 0, 0], 1, [1, 0, 0], 1e4, [0, 0, 1]);
    tr.elapsed = tr.duration;
    close(sub(travelPose(tr, [5e5, 5e5, 0]).pos, [5e5, 5e5, 0]), [1e4, 0, 0], 1e-6);
  });
});
