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
//
// Precise orientation (orient/*.json, NAIF binary PCK type 2) is evaluated by PreciseOrientation, and
// OrientationSet.orientation(bodyId, et) prefers it over the IAU model wherever it covers.

import type { IauRotation, Label, OrientationHeader, OrientSegment, Sourced } from '../data/schema';
import { DAYS_PER_JULIAN_CENTURY, RAD_PER_DEG, SECONDS_PER_DAY } from './constants';
import { chbval } from './ephemeris';
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

// ---- precise orientation (binary PCK type 2) --------------------------------------------------------------

function mat3(v: number[], what: string): Mat3 {
  if (!Array.isArray(v) || v.length !== 9 || !v.every(Number.isFinite)) throw new Error(`orientation: bad matrix ${what}`);
  return v.slice() as Mat3;
}

interface LoadedOrient {
  meta: OrientSegment;
  ncoef: number;
  startEt: number;
  endEt: number;
  refToIcrf: Mat3;
  bodyToPck: Mat3;
  data: Float64Array;
}

/**
 * One orient/*.json product: Chebyshev Euler angles (φ, δ, w) of a PCK frame relative to a reference frame, as
 * SPICE PCKE02/TISBOD: reference → PCK frame = R3(w)·R1(δ)·R3(φ). Record selection as SPK type 2. Nothing is
 * returned outside a segment's declared coverage.
 */
export class PreciseOrientation {
  readonly header: OrientationHeader;
  readonly bodies: number[];
  private readonly byBody = new Map<number, LoadedOrient[]>();

  constructor(header: OrientationHeader, data: Float64Array) {
    this.header = header;
    for (const m of header.segments) {
      if (m.type !== 2) throw new Error(`orientation segment for ${m.body}: unsupported PCK type ${m.type}`);
      const ncoef = (m.rsize - 2) / 3;
      if (!Number.isInteger(ncoef) || ncoef < 1 || !(m.n >= 1) || !(m.intLen > 0)) {
        throw new Error(`orientation segment for ${m.body}: bad layout`);
      }
      if (m.offset < 0 || m.offset + m.n * m.rsize > data.length) throw new Error(`orientation segment for ${m.body}: records outside data`);
      const ref = header.references[m.reference];
      const body = header.bodies[String(m.body)];
      if (!ref || !body) throw new Error(`orientation segment for ${m.body}: missing reference ${m.reference} or body frame`);
      const s: LoadedOrient = {
        meta: m, ncoef, data,
        startEt: Math.max(m.initEt, m.startEt), endEt: Math.min(m.initEt + m.n * m.intLen, m.endEt),
        refToIcrf: mat3(ref, m.reference), bodyToPck: mat3(body.bodyToPck, `bodies.${m.body}`),
      };
      let list = this.byBody.get(m.body);
      if (!list) this.byBody.set(m.body, (list = []));
      list.push(s);
    }
    this.bodies = [...this.byBody.keys()];
  }

  /** Segment serving `body` at `et` (later segments take precedence), or null. */
  segment(body: number, et: number): OrientSegment | null {
    return this.find(body, et)?.meta ?? null;
  }

  covers(body: number, et: number): boolean {
    return this.find(body, et) !== null;
  }

  /** Body-fixed → ICRF (row-major), or null outside coverage. */
  bodyToIcrf(body: number, et: number): Mat3 | null {
    const s = this.find(body, et);
    if (!s) return null;
    const d = s.data;
    const m = s.meta;
    let r = Math.floor((et - m.initEt) / m.intLen);
    if (r > m.n - 1) r = m.n - 1;
    if (r < 0) r = 0;
    const base = m.offset + r * m.rsize;
    const x = (et - d[base]) / d[base + 1];
    const phi = chbval(d, base + 2, s.ncoef, x);
    const delta = chbval(d, base + 2 + s.ncoef, s.ncoef, x);
    const w = chbval(d, base + 2 + 2 * s.ncoef, s.ncoef, x);
    const refToPck = mat3Mul(frameRotation(3, w), mat3Mul(frameRotation(1, delta), frameRotation(3, phi)));
    return mat3Mul(mat3Mul(s.refToIcrf, mat3Transpose(refToPck)), s.bodyToPck);
  }

  private find(body: number, et: number): LoadedOrient | null {
    const list = this.byBody.get(body);
    if (!list || !Number.isFinite(et)) return null;
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i];
      if (et >= s.startEt && et <= s.endEt) return s;
    }
    return null;
  }
}

/** Where an orientation came from: a precise product segment or the body's IAU model. */
export interface OrientationSource {
  kind: 'precise' | 'iau';
  label: Label;
  sources: string[];
  /** Body-fixed frame name for precise products (e.g. "ITRF93", "MOON_ME_DE440_ME421"); "IAU" otherwise. */
  frame: string;
  method?: string;
  uncertainty?: string;
}

/**
 * Body orientation with fallback: `orientation(id, et)` uses a precise product (orient/*.json) where one covers
 * the epoch, else the body's IAU rotation model (bodies.json `rotation`), else null (unknown).
 */
export class OrientationSet {
  private readonly precise: PreciseOrientation[] = [];
  private readonly iau = new Map<number, Sourced<IauRotation>>();

  constructor(bodies: Iterable<{ id: number; rotation?: Sourced<IauRotation> | null }> = []) {
    for (const b of bodies) if (b.rotation && b.rotation.value && b.rotation.label !== 'unknown') this.iau.set(b.id, b.rotation);
  }

  /** Later-added products take precedence for the same body. */
  add(p: PreciseOrientation): void {
    this.precise.push(p);
  }

  orientation(bodyId: number, et: number): Mat3 | null {
    for (let i = this.precise.length - 1; i >= 0; i--) {
      const m = this.precise[i].bodyToIcrf(bodyId, et);
      if (m) return m;
    }
    const rot = this.iau.get(bodyId);
    return rot && Number.isFinite(et) ? bodyToIcrf(rot.value as IauRotation, et) : null;
  }

  provenance(bodyId: number, et: number): OrientationSource | null {
    for (let i = this.precise.length - 1; i >= 0; i--) {
      const p = this.precise[i];
      const s = p.segment(bodyId, et);
      if (s) {
        return { kind: 'precise', label: s.label, sources: [...s.sources], frame: p.header.bodies[String(bodyId)].frame, method: s.method, uncertainty: s.uncertainty };
      }
    }
    const rot = this.iau.get(bodyId);
    if (!rot || !Number.isFinite(et)) return null;
    return { kind: 'iau', label: rot.label, sources: [...rot.sources], frame: 'IAU', method: rot.method, uncertainty: rot.uncertainty };
  }
}
