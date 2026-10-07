// Orientation of shape models (docs/rendering-shapes.md §2): the body-fixed frame a mesh is given in, as a
// body-fixed → ICRF rotation (row-major, v_icrf = M · v_body) at an epoch (TDB seconds past J2000).
//
// Three sources of rotation:
//   - PCK constants of the shape's own frame (ShapeModelHeader.orientation.sourceRotation, or appRotation /
//     labelRotation): the IAU form, evaluated by core/rotation.ts exactly as SPICE does.
//   - DAMIT spin states (Ďurech et al. 2010): r_ecl = Rz(λ) Ry(90° − β) Rz(φ(t)) r_ast with
//     φ(t) = φ0 + 2π (t − t0)/P + ½ υ (t − t0)², t in JD (DAMIT: light-time corrected, TDB), active rotations,
//     then ecliptic J2000 → ICRF.
//   - Radar spin states (JPL radar shape models: pole λ, β; period; phase at a zero epoch): the SHAPE software's
//     Euler angles (λ + 90°, 90° − β, φ), i.e. the IAU form in ecliptic coordinates. The data labels do not define
//     the phase angle, so this convention is an assumption (the orientation is labelled estimated).

import type { IauRotation } from '../data/schema';
import { J2000_JD, OBLIQUITY_J2000_DEG, RAD_PER_DEG, SECONDS_PER_DAY } from './constants';
import { bodyToIcrf } from './rotation';
import type { Mat3 } from './vec';
import { frameRotation, mat3Mul, mat3Transpose } from './vec';

export { OBLIQUITY_J2000_DEG } from './constants';

/** Ecliptic J2000 → ICRF (row-major, v_icrf = M · v_ecl). */
export const ECLIPTIC_TO_ICRF: Mat3 = mat3Transpose(frameRotation(1, OBLIQUITY_J2000_DEG * RAD_PER_DEG));

/** A header's PCK constants block (shape_orient.py `_constants`): SPICE text-kernel names. */
export interface PckConstants {
  POLE_RA: number[];
  POLE_DEC: number[];
  PM: number[];
  NUT_PREC_RA?: number[];
  NUT_PREC_DEC?: number[];
  NUT_PREC_PM?: number[];
  NUT_PREC_ANGLES?: number[];
  MAX_PHASE_DEGREE?: number;
}

export function isPckConstants(c: unknown): c is PckConstants {
  const o = c as Record<string, unknown> | null;
  const arr = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number' && Number.isFinite(x));
  return !!o && arr(o.POLE_RA) && arr(o.POLE_DEC) && arr(o.PM);
}

/** PCK constants → the app's IauRotation (core/rotation.ts). */
export function iauFromConstants(c: PckConstants): IauRotation {
  const r: IauRotation = { poleRa: c.POLE_RA.slice(), poleDec: c.POLE_DEC.slice(), pm: c.PM.slice() };
  if (c.NUT_PREC_ANGLES && (c.NUT_PREC_RA || c.NUT_PREC_DEC || c.NUT_PREC_PM)) {
    r.nutPrecAngles = c.NUT_PREC_ANGLES.slice();
    if (c.NUT_PREC_RA) r.nutPrecRa = c.NUT_PREC_RA.slice();
    if (c.NUT_PREC_DEC) r.nutPrecDec = c.NUT_PREC_DEC.slice();
    if (c.NUT_PREC_PM) r.nutPrecPm = c.NUT_PREC_PM.slice();
    r.nutPrecAnglesDegree = c.MAX_PHASE_DEGREE ?? 1;
  }
  return r;
}

/** Pole and uniform rotation in the IAU form (degrees, degrees/day), e.g. a PDS label's or DAMIT's IAUspin. */
export interface SimpleIauSpin {
  poleRaDeg: number;
  poleDecDeg: number;
  w0Deg: number;
  wDotDegPerDay: number;
}

export function iauFromSimple(s: SimpleIauSpin): IauRotation {
  return { poleRa: [s.poleRaDeg], poleDec: [s.poleDecDeg], pm: [s.w0Deg, s.wDotDegPerDay] };
}

export function bodyToIcrfFromConstants(c: PckConstants, et: number): Mat3 {
  return bodyToIcrf(iauFromConstants(c), et);
}

/** Active rotation matrices (rotate vectors), row-major. */
function rz(a: number): Mat3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}
function ry(a: number): Mat3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

export interface DamitSpin {
  lambdaDeg: number;
  betaDeg: number;
  periodHours: number;
  /** Epoch t0, JD (TDB). */
  jd0: number;
  phi0Deg: number;
  /** YORP: dω/dt, rad/day² (0: none). */
  yorpRadPerDay2: number;
}

/** DAMIT rotation angle φ(t) (radians) at ET (TDB s past J2000). */
export function damitPhase(s: DamitSpin, et: number): number {
  const dt = J2000_JD + et / SECONDS_PER_DAY - s.jd0;
  const omega = (2 * Math.PI * 24) / s.periodHours; // rad/day
  return s.phi0Deg * RAD_PER_DEG + omega * dt + 0.5 * s.yorpRadPerDay2 * dt * dt;
}

/** DAMIT model frame → ICRF (row-major) at ET. */
export function damitBodyToIcrf(s: DamitSpin, et: number): Mat3 {
  const toEcl = mat3Mul(rz(s.lambdaDeg * RAD_PER_DEG), mat3Mul(ry((90 - s.betaDeg) * RAD_PER_DEG), rz(damitPhase(s, et))));
  return mat3Mul(ECLIPTIC_TO_ICRF, toEcl);
}

export interface RadarSpin {
  lambdaDeg: number;
  betaDeg: number;
  periodHours: number;
  /** Rotational phase at the zero epoch, degrees. */
  phi0Deg: number;
  /** Zero epoch, ET (TDB s past J2000). */
  t0Et: number;
}

/**
 * Radar shape frame → ICRF at ET: ecliptic → body = R3(W)·R1(90° − β)·R3(90° + λ) (frame rotations), W = φ0 +
 * 360°·(t − t0)/P. The phase convention is assumed (see the file comment).
 */
export function radarBodyToIcrf(s: RadarSpin, et: number): Mat3 {
  const w = s.phi0Deg * RAD_PER_DEG + (2 * Math.PI * (et - s.t0Et)) / (s.periodHours * 3600);
  const eclToBody = mat3Mul(frameRotation(3, w), mat3Mul(frameRotation(1, (90 - s.betaDeg) * RAD_PER_DEG), frameRotation(3, (90 + s.lambdaDeg) * RAD_PER_DEG)));
  return mat3Mul(ECLIPTIC_TO_ICRF, mat3Transpose(eclToBody));
}

/** Rotation angle (degrees) between two rotation matrices. */
export function rotationAngleDeg(a: Mat3, b: Mat3): number {
  const r = mat3Mul(a, mat3Transpose(b));
  const c = (r[0] + r[4] + r[8] - 1) / 2;
  return Math.acos(Math.max(-1, Math.min(1, c))) / RAD_PER_DEG;
}
