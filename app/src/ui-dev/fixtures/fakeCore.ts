// ============================================================================================
//  UI-DEV FIXTURE CODE — NOT REAL PHYSICS. Stand-ins for core/ so the UI can be developed before
//  the real ephemeris/time modules land. Never imported by the real app (main.ts).
// ============================================================================================
//
// FakeEphemeris reads the fixture ".bin" as circular orbits: each segment's 4 doubles at `offset`
// are [radius km, period s, phase rad, inclination rad] around the segment's center.

import type { EphemHeader, EphemSegment, IauRotation, TimeData } from '../../data/schema';
import type { ApparentResult, EphemerisPort, EphemerisSetPort, Mat3, StateVector, Vec3 } from '../../app/ports';

/** Fixture epoch: ET 0 = 2000-01-01T12:00:00Z; no leap seconds, no TDB−TT (fixture simplification). */
const FIXTURE_EPOCH_MS = Date.UTC(2000, 0, 1, 12);
/** Fixture signal speed for the fake light-time (round number; the real value lives in core/constants.ts). */
const FIXTURE_LIGHT_SPEED_KM_S = 300000;

export class FixtureTimeScale {
  constructor(_d: TimeData) {}
  utcMsToEt(ms: number): number { return (ms - FIXTURE_EPOCH_MS) / 1000; }
  etToUtcMs(et: number): number { return et * 1000 + FIXTURE_EPOCH_MS; }
}

export function fixtureFormatUtc(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

interface Orbit { seg: EphemSegment; a: number; P: number; ph: number; inc: number }

export class FixtureEphemeris implements EphemerisPort {
  readonly ids: number[];
  readonly orbits: Orbit[];
  constructor(header: EphemHeader, data: Float64Array) {
    this.orbits = header.segments.map((seg) => ({ seg, a: data[seg.offset], P: data[seg.offset + 1], ph: data[seg.offset + 2], inc: data[seg.offset + 3] }));
    this.ids = this.orbits.map((o) => o.seg.target);
  }
  covers(id: number, et: number): boolean {
    const o = this.orbits.find((x) => x.seg.target === id);
    return !!o && et >= o.seg.initEt && et <= o.seg.initEt + o.seg.intLen * o.seg.n;
  }
}

export class FixtureEphemerisSet implements EphemerisSetPort {
  private orbits = new Map<number, Orbit>();
  window = { startEt: -Infinity, endEt: Infinity };
  add(e: EphemerisPort): void {
    for (const o of (e as FixtureEphemeris).orbits) {
      this.orbits.set(o.seg.target, o);
      this.window = {
        startEt: Math.max(this.window.startEt, o.seg.initEt),
        endEt: Math.min(this.window.endEt, o.seg.initEt + o.seg.intLen * o.seg.n),
      };
    }
  }
  covers(id: number, et: number): boolean {
    if (id === 0) return true;
    const o = this.orbits.get(id);
    return !!o && et >= this.window.startEt && et <= this.window.endEt && this.covers(o.seg.center, et);
  }
  positionSSB(id: number, et: number): Vec3 | null {
    if (id === 0) return [0, 0, 0];
    const o = this.orbits.get(id);
    if (!o || !this.covers(id, et)) return null;
    const c = this.positionSSB(o.seg.center, et);
    if (!c) return null;
    if (o.a === 0) return c;
    const th = o.ph + (2 * Math.PI * et) / o.P;
    const x = o.a * Math.cos(th), y = o.a * Math.sin(th);
    return [c[0] + x, c[1] + y * Math.cos(o.inc), c[2] + y * Math.sin(o.inc)];
  }
  stateSSB(id: number, et: number): StateVector | null {
    const p = this.positionSSB(id, et), a = this.positionSSB(id, et - 1), b = this.positionSSB(id, et + 1);
    if (!p || !a || !b) return null;
    return { pos: p, vel: [(b[0] - a[0]) / 2, (b[1] - a[1]) / 2, (b[2] - a[2]) / 2] };
  }
}

export function fixtureApparent(eph: EphemerisSetPort, id: number, obs: Vec3, et: number): ApparentResult | null {
  let tau = 0;
  for (let i = 0; i < 3; i++) {
    const p = eph.positionSSB(id, et - tau);
    if (!p) return null;
    tau = Math.hypot(p[0] - obs[0], p[1] - obs[1], p[2] - obs[2]) / FIXTURE_LIGHT_SPEED_KM_S;
  }
  const p = eph.positionSSB(id, et - tau);
  if (!p) return null;
  return { rel: [p[0] - obs[0], p[1] - obs[1], p[2] - obs[2]], lightTime: tau, emitEt: et - tau };
}

/** Fixture rotation: pole along ICRF +Z, spin W = pm[0] + pm[1]·days. */
export function fixtureBodyToIcrf(rot: IauRotation, et: number): Mat3 {
  const w = ((rot.pm[0] + rot.pm[1] * (et / 86400)) * Math.PI) / 180;
  const c = Math.cos(w), s = Math.sin(w);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}
