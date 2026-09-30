// TEST FIXTURES ONLY. Fake implementations of the core ports and made-up bodies for unit tests of the
// app shell. None of these numbers describe the real universe; they are chosen for easy assertions.

import type { Body, EphemHeader, IauRotation, Label, LightData, Sourced, TimeData } from '../src/data/schema';
import type { ApparentResult, CoreDeps, EphemerisPort, EphemerisSetPort, Mat3, StateVector, Vec3 } from '../src/app/ports';

export type Motion = (t: number) => Vec3;

/** Fake EphemerisSet: analytic positions per id, uniform coverage window. */
export class FakeEphemerisSet implements EphemerisSetPort {
  motions = new Map<number, Motion>();
  window = { startEt: -1e9, endEt: 1e9 };
  calls = 0;
  constructor(motions?: Record<number, Motion>, window?: { startEt: number; endEt: number }) {
    if (motions) for (const [k, v] of Object.entries(motions)) this.motions.set(Number(k), v);
    if (window) this.window = window;
  }
  add(_e: EphemerisPort): void {}
  covers(id: number, et: number): boolean {
    return this.motions.has(id) && et >= this.window.startEt && et <= this.window.endEt;
  }
  positionSSB(id: number, et: number): Vec3 | null {
    this.calls++;
    return this.covers(id, et) ? this.motions.get(id)!(et) : null;
  }
  stateSSB(id: number, et: number): StateVector | null {
    const p = this.positionSSB(id, et);
    if (!p) return null;
    const h = 1;
    const a = this.motions.get(id)!(et - h), b = this.motions.get(id)!(et + h);
    return { pos: p, vel: [(b[0] - a[0]) / (2 * h), (b[1] - a[1]) / (2 * h), (b[2] - a[2]) / (2 * h)] };
  }
}

/** Like FakeEphemerisSet but every call returns the SAME scratch arrays (a legal optimization). */
export class ScratchEphemerisSet extends FakeEphemerisSet {
  private scratch: Vec3 = [0, 0, 0];
  private sv: StateVector = { pos: [0, 0, 0], vel: [0, 0, 0] };
  positionSSB(id: number, et: number): Vec3 | null {
    const p = super.positionSSB(id, et);
    if (!p) return null;
    this.scratch[0] = p[0]; this.scratch[1] = p[1]; this.scratch[2] = p[2];
    return this.scratch;
  }
  stateSSB(id: number, et: number): StateVector | null {
    const s = super.stateSSB(id, et);
    if (!s) return null;
    for (let k = 0; k < 3; k++) { this.sv.pos[k] = s.pos[k]; this.sv.vel[k] = s.vel[k]; }
    return this.sv;
  }
}

/** Light-time iteration with a test-chosen signal speed (km/s). */
export function makeApparent(c: number) {
  return (eph: EphemerisSetPort, id: number, obs: Vec3, et: number): ApparentResult | null => {
    let tau = 0;
    let p = eph.positionSSB(id, et);
    if (!p) return null;
    for (let i = 0; i < 6; i++) {
      p = eph.positionSSB(id, et - tau);
      if (!p) return null;
      tau = Math.hypot(p[0] - obs[0], p[1] - obs[1], p[2] - obs[2]) / c;
    }
    p = eph.positionSSB(id, et - tau)!;
    return { rel: [p[0] - obs[0], p[1] - obs[1], p[2] - obs[2]], lightTime: tau, emitEt: et - tau };
  };
}

/** Rotation about +Z by pm[0] + pm[1]·t degrees (t in seconds here — a fake). */
export function fakeBodyToIcrf(rot: IauRotation, et: number): Mat3 {
  const w = ((rot.pm[0] + rot.pm[1] * et) * Math.PI) / 180;
  const c = Math.cos(w), s = Math.sin(w);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

export const FAKE_J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);

export class FakeTimeScale {
  constructor(_d: TimeData) {}
  utcMsToEt(ms: number): number { return (ms - FAKE_J2000_MS) / 1000; }
  etToUtcMs(et: number): number { return et * 1000 + FAKE_J2000_MS; }
}

export class FakeEphemeris implements EphemerisPort {
  ids: number[];
  constructor(public header: EphemHeader, public data: Float64Array) {
    this.ids = header.segments.map((s) => s.target);
  }
  covers(): boolean { return true; }
}

export function fakeCore(eph: FakeEphemerisSet, c = 1e5): CoreDeps {
  return {
    TimeScale: FakeTimeScale,
    Ephemeris: FakeEphemeris,
    EphemerisSet: class { constructor() { return eph; } } as unknown as CoreDeps['EphemerisSet'],
    bodyToIcrf: fakeBodyToIcrf,
    apparentPosition: makeApparent(c),
    formatUtc: (ms) => new Date(ms).toISOString(),
  };
}

export function src<T>(value: T | null, label: Label, unit?: string): Sourced<T> {
  return { value: label === 'unknown' ? null : value, label, sources: label === 'unknown' ? [] : ['fixture-src'], ...(unit ? { unit } : {}) };
}

export const ROT: IauRotation = { poleRa: [0, 0, 0], poleDec: [90, 0, 0], pm: [0, 1] };

export function body(id: number, name: string, kind: Body['kind'], o: Partial<Body> & { r?: number; rLabel?: Label; albedo?: Label; phase?: Label } = {}): Body {
  const r = o.r ?? 1000;
  const b: Body = {
    id, name, kind,
    ephemeris: 'fake',
    radii: o.radii ?? src<[number, number, number]>([r, r, r], o.rLabel ?? 'measured', 'km'),
    gm: o.gm ?? src(1, 'measured', 'km^3/s^2'),
    rotation: o.rotation ?? src(ROT, 'measured'),
    ...(o.parent !== undefined ? { parent: o.parent } : {}),
  };
  if (o.albedo || o.phase) {
    b.photometry = {
      geometricAlbedoXYZS: src<[number, number, number, number]>([1, 2, 3, 4], o.albedo ?? 'unknown'),
      geometricAlbedoV: src(0.3, o.albedo ?? 'unknown'),
      phaseFunction: src({ kind: 'lambert' as const }, o.phase ?? 'unknown'),
    };
  }
  return b;
}

export function fakeLight(label: Label = 'derived'): LightData {
  return {
    sun: {
      irradianceXYZS_1AU: src<[number, number, number, number]>([10, 11, 12, 13], label),
      radius: src(500, 'measured', 'km'),
      limbDarkening: src({ kind: 'poly-mu' as const, coeffsXYZS: [[1], [1], [1], [1]] }, 'measured'),
    },
    cie: { photopicKm: 1, scotopicKm: 2, sources: [] },
  };
}
