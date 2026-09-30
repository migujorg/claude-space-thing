// Evaluation of the SPK type 2/3 products in app/public/data/ephem/ (docs/architecture.md §6), and chaining of
// segments to the Solar System Barycenter. km, km/s, ICRF (SPICE J2000) axes, TDB seconds past J2000.
//
// Record selection follows SPICE SPKR02/SPKR03: record = floor((et − initEt) / intLen), clamped to the last
// record, so at a record boundary the later record is used. Outside a segment's coverage nothing is returned:
// there is no extrapolation anywhere in this module.

import type { EphemHeader, EphemSegment, Label } from '../data/schema';
import { LABEL_ORDER } from '../data/schema';
import type { Vec3 } from './vec';

const SSB = 0;
const MAX_CHAIN = 16;

/** A segment bound to its data (internal to core; exported only so EphemerisSet can type it). */
export interface LoadedSegment {
  meta: EphemSegment;
  target: number;
  center: number;
  type: 2 | 3;
  initEt: number;
  intLen: number;
  rsize: number;
  n: number;
  offset: number;
  ncoef: number;
  startEt: number;
  endEt: number;
  data: Float64Array;
}

export interface State {
  pos: Vec3;
  vel: Vec3;
}

export class Ephemeris {
  readonly ids: number[];
  readonly header: EphemHeader;
  private readonly byTarget = new Map<number, LoadedSegment[]>();
  private readonly all: LoadedSegment[] = [];

  constructor(header: EphemHeader, data: Float64Array) {
    this.header = header;
    for (const m of header.segments) {
      if (m.frame !== 'J2000') throw new Error(`ephemeris segment ${m.target}: unsupported frame ${m.frame}`);
      if (m.type !== 2 && m.type !== 3) throw new Error(`ephemeris segment ${m.target}: unsupported SPK type ${m.type}`);
      const per = m.type === 2 ? 3 : 6;
      const ncoef = (m.rsize - 2) / per;
      if (!Number.isInteger(ncoef) || ncoef < 1) throw new Error(`ephemeris segment ${m.target}: bad rsize ${m.rsize}`);
      if (!(m.n >= 1) || !(m.intLen > 0)) throw new Error(`ephemeris segment ${m.target}: bad record count/length`);
      if (m.offset < 0 || m.offset + m.n * m.rsize > data.length) {
        throw new Error(`ephemeris segment ${m.target}: records [${m.offset}, +${m.n * m.rsize}) outside data (${data.length})`);
      }
      const s: LoadedSegment = {
        meta: m, target: m.target, center: m.center, type: m.type, initEt: m.initEt, intLen: m.intLen,
        rsize: m.rsize, n: m.n, offset: m.offset, ncoef, startEt: m.initEt, endEt: m.initEt + m.n * m.intLen, data,
      };
      this.all.push(s);
      let list = this.byTarget.get(s.target);
      if (!list) this.byTarget.set(s.target, (list = []));
      list.push(s);
    }
    this.ids = [...this.byTarget.keys()];
  }

  /** True if this file has a segment for `id` (relative to that segment's center) covering `et`. */
  covers(id: number, et: number): boolean {
    return this.find(id, et) !== null;
  }

  /** State of `id` relative to the center of its own segment in this file (no chaining); null if not covered. */
  state(id: number, et: number): { center: number; pos: Vec3; vel: Vec3 } | null {
    const s = this.find(id, et);
    if (!s) return null;
    const pos: Vec3 = [0, 0, 0];
    const vel: Vec3 = [0, 0, 0];
    evalState(s, et, pos, vel);
    return { center: s.center, pos, vel };
  }

  /** Segments of this file, in file order. */
  get segments(): readonly EphemSegment[] {
    return this.header.segments;
  }

  /** Coverage [start, end] (TDB s past J2000) over which every segment of this file can be evaluated. */
  get window(): { startEt: number; endEt: number } {
    let startEt = -Infinity;
    let endEt = Infinity;
    for (const s of this.all) {
      startEt = Math.max(startEt, s.startEt);
      endEt = Math.min(endEt, s.endEt);
    }
    return { startEt, endEt };
  }

  /** @internal Segment for `id` covering `et`; later segments take precedence (SPICE convention). */
  find(id: number, et: number): LoadedSegment | null {
    const list = this.byTarget.get(id);
    if (!list) return null;
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i];
      if (et >= s.startEt && et <= s.endEt) return s;
    }
    return null;
  }
}

/** Index of the first double of the record SPICE would use at et (et must be inside the segment). */
function recordBase(s: LoadedSegment, et: number): number {
  let r = Math.floor((et - s.initEt) / s.intLen);
  if (r > s.n - 1) r = s.n - 1;
  if (r < 0) r = 0;
  return s.offset + r * s.rsize;
}

// Chebyshev sums use the Clenshaw recurrence in exactly the operation order of SPICE CHBVAL/CHBINT, so results
// are bit-identical to SPICE (one float64 ulp is ~1 mm at 30 AU, so summation order is visible at that level).

/** Σ c_k T_k(x) for the nc coefficients at d[c], x = (et − MID)/RADIUS. */
function chbval(d: Float64Array, c: number, nc: number, x: number): number {
  const x2 = 2 * x;
  let w1 = 0;
  let w2 = 0;
  let w3 = 0;
  for (let j = nc - 1; j > 0; j--) {
    w3 = w2;
    w2 = w1;
    w1 = d[c + j] + (x2 * w2 - w3);
  }
  return d[c] + (x * w1 - w2);
}

/** Σ c_k T_k(x) and its derivative d/dx; writes [value, derivative] into out at index j and j + 3. */
function chbint(d: Float64Array, c: number, nc: number, x: number, out: number[], j: number): void {
  const x2 = 2 * x;
  let w1 = 0;
  let w2 = 0;
  let w3 = 0;
  let dw1 = 0;
  let dw2 = 0;
  let dw3 = 0;
  for (let k = nc - 1; k > 0; k--) {
    w3 = w2;
    w2 = w1;
    w1 = d[c + k] + (x2 * w2 - w3);
    dw3 = dw2;
    dw2 = dw1;
    dw1 = w2 * 2 + dw2 * x2 - dw3;
  }
  out[j] = d[c] + (x * w1 - w2);
  out[j + 3] = w1 + x * dw1 - dw2;
}

/** Position of s.target relative to s.center at et (et must be inside the segment). */
function evalPos(s: LoadedSegment, et: number, out: Vec3): void {
  const d = s.data;
  const base = recordBase(s, et);
  const x = (et - d[base]) / d[base + 1];
  const nc = s.ncoef;
  out[0] = chbval(d, base + 2, nc, x);
  out[1] = chbval(d, base + 2 + nc, nc, x);
  out[2] = chbval(d, base + 2 + 2 * nc, nc, x);
}

/** State of s.target relative to s.center at et (et must be inside the segment). */
function evalState(s: LoadedSegment, et: number, pos: Vec3, vel: Vec3): void {
  const d = s.data;
  const base = recordBase(s, et);
  const radius = d[base + 1];
  const x = (et - d[base]) / radius;
  const nc = s.ncoef;
  if (s.type === 2) {
    const tmp = [0, 0, 0, 0, 0, 0];
    for (let j = 0; j < 3; j++) chbint(d, base + 2 + j * nc, nc, x, tmp, j);
    for (let j = 0; j < 3; j++) {
      pos[j] = tmp[j];
      vel[j] = tmp[j + 3] / radius; // SPKE02: derivative w.r.t. x scaled to per second
    }
  } else {
    // Type 3 (SPKE03): separate coefficient sets for X, Y, Z, VX, VY, VZ.
    for (let j = 0; j < 3; j++) {
      pos[j] = chbval(d, base + 2 + j * nc, nc, x);
      vel[j] = chbval(d, base + 2 + (j + 3) * nc, nc, x);
    }
  }
}

/** Provenance of a chained position: the segments used, their worst label, and all their sources. */
export interface ChainProvenance {
  segments: EphemSegment[];
  label: Label;
  sources: string[];
}

export class EphemerisSet {
  private readonly list: Ephemeris[] = [];
  private win = { startEt: Infinity, endEt: -Infinity };

  /** Later-added files take precedence for the same target (SPICE's load-order priority). */
  add(e: Ephemeris): void {
    this.list.push(e);
    let startEt = -Infinity;
    let endEt = Infinity;
    for (const f of this.list) {
      const w = f.window;
      startEt = Math.max(startEt, w.startEt);
      endEt = Math.min(endEt, w.endEt);
    }
    this.win = { startEt, endEt };
  }

  /**
   * Interval over which every loaded segment can be evaluated (intersection of all coverages; empty, i.e.
   * startEt = +∞ and endEt = −∞, before anything is loaded). It includes the pipeline's light-time margin
   * around the manifest window; the app should still clamp scrubbing to manifest.window.
   */
  get window(): { startEt: number; endEt: number } {
    return { ...this.win };
  }

  /** Ids for which at least one segment is loaded. */
  get ids(): number[] {
    const s = new Set<number>();
    for (const e of this.list) for (const id of e.ids) s.add(id);
    return [...s];
  }

  covers(id: number, et: number): boolean {
    return this.chain(id, et) !== null;
  }

  positionSSB(id: number, et: number): Vec3 | null {
    const segs = this.chain(id, et);
    if (!segs) return null;
    const acc: Vec3 = [0, 0, 0];
    const p: Vec3 = [0, 0, 0];
    for (const s of segs) {
      evalPos(s, et, p);
      acc[0] += p[0];
      acc[1] += p[1];
      acc[2] += p[2];
    }
    return acc;
  }

  stateSSB(id: number, et: number): State | null {
    const segs = this.chain(id, et);
    if (!segs) return null;
    const pos: Vec3 = [0, 0, 0];
    const vel: Vec3 = [0, 0, 0];
    const p: Vec3 = [0, 0, 0];
    const v: Vec3 = [0, 0, 0];
    for (const s of segs) {
      evalState(s, et, p, v);
      for (let j = 0; j < 3; j++) {
        pos[j] += p[j];
        vel[j] += v[j];
      }
    }
    return { pos, vel };
  }

  /** Where a chained position at `et` comes from; null if not covered. */
  provenance(id: number, et: number): ChainProvenance | null {
    const segs = this.chain(id, et);
    if (!segs) return null;
    let worst = 0;
    const sources = new Set<string>();
    for (const s of segs) {
      const i = LABEL_ORDER.indexOf(s.meta.label ?? 'unknown');
      worst = Math.max(worst, i);
      for (const src of s.meta.sources) sources.add(src);
    }
    return { segments: segs.map((s) => s.meta), label: LABEL_ORDER[worst], sources: [...sources] };
  }

  /** Segments from `id` down to the SSB, all covering `et`; null if any link is missing. */
  private chain(id: number, et: number): LoadedSegment[] | null {
    if (!Number.isFinite(et)) return null;
    const out: LoadedSegment[] = [];
    let node = id;
    while (node !== SSB) {
      if (out.length >= MAX_CHAIN) return null;
      const s = this.find(node, et);
      if (!s) return null;
      out.push(s);
      node = s.center;
    }
    return out;
  }

  private find(id: number, et: number): LoadedSegment | null {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const s = this.list[i].find(id, et);
      if (s) return s;
    }
    return null;
  }
}
