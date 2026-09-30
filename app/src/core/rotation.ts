// IAU/WGCCRE body-fixed frames from the rotation models in bodies.json (NAIF text-PCK form), evaluated exactly
// as SPICE's BODEUL/TISBOD do:
//
//   d = et / 86400 (TDB days past J2000),  T = d / 36525 (Julian centuries)
//   θ_i = Σ_k A_ik T^k                     (system phase angles, degree = nutPrecAnglesDegree, default 1)
//   α   = Σ_k a_k T^k + Σ_i ra_i  sin θ_i  (pole right ascension)
//   δ   = Σ_k b_k T^k + Σ_i dec_i cos θ_i  (pole declination)
//   W   = Σ_k w_k d^k + Σ_i pm_i  sin θ_i  (prime meridian)
//   ICRF → body = [W]₃ [π/2 − δ]₁ [π/2 + α]₃     (frame rotations)
//
// Only as many phase angles are used as a body has coefficients, and a body without nutation/precession
// coefficients (e.g. Earth, Saturn) ignores its system's angles, as in SPICE. All angles in the data are degrees.

import type { IauRotation } from '../data/schema';
import { DAYS_PER_JULIAN_CENTURY, RAD_PER_DEG, SECONDS_PER_DAY } from './constants';
import type { Mat3 } from './vec';
import { frameRotation, mat3Mul, mat3Transpose } from './vec';

export interface IauAngles {
  /** Pole right ascension, radians. */
  ra: number;
  /** Pole declination, radians. */
  dec: number;
  /** Prime meridian angle, radians, reduced to (−2π, 2π). */
  w: number;
}

function poly(c: readonly number[], x: number): number {
  let r = 0;
  for (let k = c.length - 1; k >= 0; k--) r = r * x + c[k];
  return r;
}

export function iauAngles(rot: IauRotation, et: number): IauAngles {
  const d = et / SECONDS_PER_DAY;
  const t = d / DAYS_PER_JULIAN_CENTURY;
  let ra = poly(rot.poleRa, t);
  let dec = poly(rot.poleDec, t);
  let w = poly(rot.pm, d);

  const angles = rot.nutPrecAngles;
  const cra = rot.nutPrecRa ?? [];
  const cdec = rot.nutPrecDec ?? [];
  const cpm = rot.nutPrecPm ?? [];
  const nTerms = Math.max(cra.length, cdec.length, cpm.length);
  if (nTerms > 0) {
    const stride = (rot.nutPrecAnglesDegree ?? 1) + 1;
    if (!angles || angles.length < nTerms * stride) {
      throw new Error(`IauRotation: ${nTerms} nutation/precession terms but ${angles?.length ?? 0} angle coefficients`);
    }
    for (let i = 0; i < nTerms; i++) {
      let theta = 0;
      for (let k = stride - 1; k >= 0; k--) theta = theta * t + angles[i * stride + k];
      theta *= RAD_PER_DEG;
      const s = Math.sin(theta);
      if (i < cra.length) ra += cra[i] * s;
      if (i < cdec.length) dec += cdec[i] * Math.cos(theta);
      if (i < cpm.length) w += cpm[i] * s;
    }
  }
  return { ra: ra * RAD_PER_DEG, dec: dec * RAD_PER_DEG, w: (w % 360) * RAD_PER_DEG };
}

/** ICRF → body-fixed rotation (row-major): v_body = M · v_icrf. */
export function icrfToBody(rot: IauRotation, et: number): Mat3 {
  const { ra, dec, w } = iauAngles(rot, et);
  return mat3Mul(frameRotation(3, w), mat3Mul(frameRotation(1, Math.PI / 2 - dec), frameRotation(3, Math.PI / 2 + ra)));
}

/** Body-fixed → ICRF rotation (row-major): v_icrf = M · v_body. Equals SPICE pxform('IAU_<BODY>', 'J2000', et). */
export function bodyToIcrf(rot: IauRotation, et: number): Mat3 {
  return mat3Transpose(icrfToBody(rot, et));
}
