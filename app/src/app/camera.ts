// Camera math. Pure: positions are float64 km in ICRF with SSB origin; orientation is a row-major
// camera → ICRF rotation whose columns are (right, up, back): the camera looks along −back.
//
// Modes
//   orbit: around a target body; state is the unit direction target→camera, the distance from the
//          target's center and an up vector. It moves with the target as time runs (translation only:
//          the observer is not rotated with the body or with the Sun direction).
//   free:  free flight; position is stored relative to an anchor body (whatever you were near when
//          you left orbit mode) so the camera drifts along with it as time runs; null = SSB-fixed.
//
// All tuning numbers here are interaction choices (speeds, easing, margins), not properties of the
// universe.

import type { Mat3, Vec3 } from './ports';
import {
  add, addScaled, clamp, column, cross, DEG, dot, fromColumns, len, matFromQuat, mulMV, norm, perpComponent,
  quatFromMat, rotate, scale, slerpDir, slerpQuat, sub,
} from './vec';

export interface OrbitCam {
  mode: 'orbit';
  target: number;
  /** Unit vector from target center to camera, ICRF. */
  dir: Vec3;
  /** Distance from target center, km. */
  dist: number;
  /** Camera up (kept orthogonal to dir). */
  up: Vec3;
}

export interface FreeCam {
  mode: 'free';
  anchor: number | null;
  /** Position relative to the anchor's position (or SSB), km. */
  rel: Vec3;
  orient: Mat3;
}

export type CamState = OrbitCam | FreeCam;

export interface Pose {
  /** SSB, km */
  pos: Vec3;
  orient: Mat3;
}

// ---- Interaction constants (not physics) --------------------------------------------------------

export const CAMERA_TUNING = {
  /** Closest approach to a surface, as a fraction of the body's largest radius. */
  minAltitudeFrac: 1e-4,
  /** Absolute floor on altitude, km (for bodies with unknown size). */
  minAltitudeKm: 1e-3,
  maxDistKm: 1e12,
  /** Wheel zoom: altitude multiplier per notch. */
  zoomPerNotch: 1.18,
  /** Free-flight speed = altitude above the nearest surface × this, per second. */
  flySpeedPerAlt: 1.0,
  flyBoost: 8,
  flySlow: 0.125,
  /** Go-to framing: the target's angular radius as a fraction of the vertical FOV. */
  frameFrac: 0.16,
  /** Default go-to viewing direction, relative to the Sun direction (see sunFrame). */
  viewAzDeg: 25,
  viewElDeg: 12,
  travelMinS: 1.2,
  travelMaxS: 6,
  travelPerLogDist: 0.35,
  /** Fraction of the travel spent turning to face the target. */
  travelTurnFrac: 0.35,
};

// ---- Orientation --------------------------------------------------------------------------------

/** Camera → ICRF rotation looking along `forward` with `upHint` roughly up. */
export function lookRotation(forward: Vec3, upHint: Vec3): Mat3 {
  const back = norm(scale(forward, -1));
  const up = perpComponent(upHint, back);
  const right = cross(up, back);
  return fromColumns(right, up, back);
}

export const forwardOf = (m: Mat3): Vec3 => scale(column(m, 2), -1);
export const upOf = (m: Mat3): Vec3 => column(m, 1);
export const rightOf = (m: Mat3): Vec3 => column(m, 0);

/** Rotate every column of an orientation about a world axis. */
function rotateOrient(m: Mat3, axis: Vec3, a: number): Mat3 {
  return fromColumns(rotate(column(m, 0), axis, a), rotate(column(m, 1), axis, a), rotate(column(m, 2), axis, a));
}

// ---- Distances ----------------------------------------------------------------------------------

export function minDistance(radius: number | null): number {
  const r = radius ?? 0;
  return r + Math.max(r * CAMERA_TUNING.minAltitudeFrac, CAMERA_TUNING.minAltitudeKm);
}

export function clampDist(dist: number, radius: number | null): number {
  return clamp(dist, minDistance(radius), CAMERA_TUNING.maxDistKm);
}

/** Distance at which a body of `radius` has an angular radius of frameFrac × fovY. */
export function viewDistance(radius: number, fovY: number): number {
  return radius / Math.sin(Math.min(CAMERA_TUNING.frameFrac * fovY, 1.2));
}

// ---- Orbit mode ---------------------------------------------------------------------------------

export function orbitPose(cam: OrbitCam, targetPos: Vec3): Pose {
  return { pos: addScaled(targetPos, cam.dir, cam.dist), orient: lookRotation(scale(cam.dir, -1), cam.up) };
}

/** Trackball-style drag: dx, dy in radians (screen right/down positive). The target appears to follow the pointer. */
export function orbitRotate(cam: OrbitCam, dx: number, dy: number): OrbitCam {
  const o = lookRotation(scale(cam.dir, -1), cam.up);
  const up = upOf(o), right = rightOf(o);
  let dir = rotate(cam.dir, up, -dx);
  let upv = up;
  dir = rotate(dir, right, -dy);
  upv = rotate(upv, right, -dy);
  dir = norm(dir);
  return { ...cam, dir, up: perpComponent(upv, dir) };
}

/** Logarithmic zoom in altitude above the surface; never inside the body. */
export function orbitZoom(cam: OrbitCam, notches: number, radius: number | null): OrbitCam {
  const r = radius ?? 0;
  const alt = Math.max(cam.dist - r, minDistance(radius) - r);
  const next = r + alt * Math.pow(CAMERA_TUNING.zoomPerNotch, notches);
  return { ...cam, dist: clampDist(next, radius) };
}

/** Roll the camera about its view axis. */
export function orbitRoll(cam: OrbitCam, a: number): OrbitCam {
  return { ...cam, up: norm(rotate(cam.up, cam.dir, a)) };
}

// ---- Free mode ----------------------------------------------------------------------------------

export function freePose(cam: FreeCam, anchorPos: Vec3 | null): Pose {
  return { pos: anchorPos ? add(anchorPos, cam.rel) : cam.rel, orient: cam.orient };
}

/** Mouse look: dx, dy radians; positive dx turns right, positive dy looks down. */
export function freeLook(cam: FreeCam, dx: number, dy: number): FreeCam {
  let o = rotateOrient(cam.orient, upOf(cam.orient), -dx);
  o = rotateOrient(o, rightOf(o), -dy);
  return { ...cam, orient: orthonormal(o) };
}

export function freeRoll(cam: FreeCam, a: number): FreeCam {
  return { ...cam, orient: orthonormal(rotateOrient(cam.orient, forwardOf(cam.orient), a)) };
}

function orthonormal(m: Mat3): Mat3 {
  return lookRotation(forwardOf(m), upOf(m));
}

/** Speed (km/s) for free flight: proportional to the altitude above the nearest surface. */
export function flySpeed(altNearest: number, mod: 'normal' | 'fast' | 'slow' = 'normal'): number {
  const k = mod === 'fast' ? CAMERA_TUNING.flyBoost : mod === 'slow' ? CAMERA_TUNING.flySlow : 1;
  return Math.max(altNearest, CAMERA_TUNING.minAltitudeKm) * CAMERA_TUNING.flySpeedPerAlt * k;
}

/** Move in camera axes: m = (right, up, back) in −1..1. */
export function freeMove(cam: FreeCam, m: Vec3, dt: number, speed: number): FreeCam {
  const l = len(m);
  if (!(l > 0) || !(dt > 0)) return cam;
  const world = mulMV(cam.orient, scale(m, 1 / l));
  return { ...cam, rel: addScaled(cam.rel, world, speed * dt) };
}

export interface Sphere {
  center: Vec3;
  radius: number;
}

/** Altitude above the nearest surface (bodies with unknown radius count as points). */
export function nearestAltitude(p: Vec3, spheres: Sphere[]): { alt: number; index: number } {
  let best = Infinity, index = -1;
  for (let i = 0; i < spheres.length; i++) {
    const a = len(sub(p, spheres[i].center)) - spheres[i].radius;
    if (a < best) { best = a; index = i; }
  }
  return { alt: best, index };
}

/** Push a position out of any sphere it has entered (to the minimum distance). */
export function pushOutside(p: Vec3, spheres: Sphere[]): Vec3 {
  let q = p;
  for (const s of spheres) {
    const d = sub(q, s.center);
    const l = len(d);
    const min = minDistance(s.radius);
    if (l < min) q = addScaled(s.center, l > 0 ? scale(d, 1 / l) : [0, 0, 1], min);
  }
  return q;
}

// ---- Sun-relative viewing frame (URL az/el, default go-to direction) ----------------------------

/**
 * Target-centered frame: x̂ points from the target toward the Sun, ẑ is ICRF north (+Z) made
 * perpendicular to x̂, ŷ = ẑ × x̂. az is measured from x̂ toward ŷ, el from the x̂ŷ-plane toward ẑ.
 * So az = 0, el = 0 puts the camera between the target and the Sun (fully lit), az = 180 behind it.
 * Without a Sun direction (e.g. the target IS the Sun) x̂ = ICRF +X.
 */
export function sunFrame(toSun: Vec3 | null): Mat3 {
  const x = toSun && len(toSun) > 0 ? norm(toSun) : ([1, 0, 0] as Vec3);
  const z = perpComponent([0, 0, 1], x);
  const y = cross(z, x);
  return fromColumns(x, y, z);
}

export function dirFromAzEl(frame: Mat3, azRad: number, elRad: number): Vec3 {
  const local: Vec3 = [Math.cos(elRad) * Math.cos(azRad), Math.cos(elRad) * Math.sin(azRad), Math.sin(elRad)];
  return norm(mulMV(frame, local));
}

export function azElFromDir(frame: Mat3, dir: Vec3): { az: number; el: number } {
  const x = dot(dir, column(frame, 0)), y = dot(dir, column(frame, 1)), z = dot(dir, column(frame, 2));
  return { az: Math.atan2(y, x), el: Math.atan2(z, Math.hypot(x, y)) };
}

/** The default "sunlit side" viewing direction for a target. */
export function sunlitDirection(toSun: Vec3 | null): Vec3 {
  return dirFromAzEl(sunFrame(toSun), CAMERA_TUNING.viewAzDeg * DEG, CAMERA_TUNING.viewElDeg * DEG);
}

/** Up vector for an orbit camera looking back along -dir: ICRF north where possible. */
export function defaultUp(dir: Vec3): Vec3 {
  return perpComponent([0, 0, 1], dir);
}

// ---- Magic travel ("go to") ---------------------------------------------------------------------

export interface Travel {
  target: number;
  /** Camera position relative to the target at departure. */
  startRel: Vec3;
  startOrient: Mat3;
  endDir: Vec3;
  endDist: number;
  endUp: Vec3;
  duration: number;
  elapsed: number;
}

export const easeInOut = (u: number): number => {
  const x = clamp(u, 0, 1);
  return x * x * (3 - 2 * x);
};

export function startTravel(from: Pose, targetPos: Vec3, target: number, endDir: Vec3, endDist: number, endUp: Vec3): Travel {
  const startRel = sub(from.pos, targetPos);
  const d0 = Math.max(len(startRel), 1e-9);
  const logRatio = Math.abs(Math.log(d0 / endDist));
  const turn = Math.acos(clamp(dot(forwardOf(from.orient), norm(scale(startRel, -1))), -1, 1));
  const duration = clamp(
    CAMERA_TUNING.travelMinS + CAMERA_TUNING.travelPerLogDist * logRatio + 0.4 * turn,
    CAMERA_TUNING.travelMinS,
    CAMERA_TUNING.travelMaxS,
  );
  return { target, startRel, startOrient: from.orient, endDir: norm(endDir), endDist, endUp, duration, elapsed: 0 };
}

/** Pose along the travel at its current elapsed time, given the target's current position. */
export function travelPose(tr: Travel, targetPos: Vec3): Pose {
  const u = tr.duration > 0 ? tr.elapsed / tr.duration : 1;
  const e = easeInOut(u);
  const d0 = Math.max(len(tr.startRel), 1e-9);
  const d = Math.exp(Math.log(d0) + (Math.log(tr.endDist) - Math.log(d0)) * e);
  const dir = slerpDir(norm(tr.startRel), tr.endDir, e);
  const pos = addScaled(targetPos, dir, d);
  const upHint = slerpDir(upOf(tr.startOrient), tr.endUp, e);
  const look = lookRotation(scale(dir, -1), upHint);
  const w = easeInOut(u / CAMERA_TUNING.travelTurnFrac);
  const q = slerpQuat(quatFromMat(tr.startOrient), quatFromMat(look), w);
  return { pos, orient: matFromQuat(q) };
}

export function travelDone(tr: Travel): boolean {
  return tr.elapsed >= tr.duration;
}

export function travelEndCam(tr: Travel): OrbitCam {
  return { mode: 'orbit', target: tr.target, dir: tr.endDir, dist: tr.endDist, up: perpComponent(tr.endUp, tr.endDir) };
}

// ---- Mode switching -------------------------------------------------------------------------------

export function toFree(pose: Pose, anchor: number | null, anchorPos: Vec3 | null): FreeCam {
  return { mode: 'free', anchor, rel: anchorPos ? sub(pose.pos, anchorPos) : pose.pos, orient: pose.orient };
}

export function toOrbit(pose: Pose, target: number, targetPos: Vec3, radius: number | null): OrbitCam {
  const rel = sub(pose.pos, targetPos);
  const l = len(rel);
  const dir = l > 0 ? scale(rel, 1 / l) : scale(forwardOf(pose.orient), -1);
  return { mode: 'orbit', target, dir, dist: clampDist(l, radius), up: perpComponent(upOf(pose.orient), dir) };
}
