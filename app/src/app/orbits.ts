// Orbit overlay polylines. Each body's track is sampled ONCE from the ephemeris over the whole data
// window (position relative to its parent), then each frame the span covering one orbital period
// around the current time (or the whole window, if shorter) is sliced out and made camera-relative by
// adding the parent's apparent camera-relative position.
//
// Period: osculating two-body period from the ephemeris state relative to the parent and the two GMs
// from bodies.json (any label — the drawn points are ephemeris positions either way; the period only
// chooses how much of the track to show). Without GM, the whole window is shown.

import type { Body } from '../data/schema';
import type { OrbitPolyline } from '../render/scene';
import type { EphemerisSetPort, Vec3 } from './ports';
import type { TimeWindow } from './clock';
import { dot, len, sub } from './vec';

export interface OrbitTrack {
  id: number;
  parentId: number;
  t0: number;
  dt: number;
  n: number;
  /** body − parent at t0 + i·dt, km; NaN where not covered. */
  rel: Float64Array;
  period: number | null;
}

/** Keplerian period (s) from relative state and μ = GM1 + GM2; null if not bound. */
export function osculatingPeriod(r: Vec3, v: Vec3, mu: number): number | null {
  const rr = len(r);
  const v2 = dot(v, v);
  if (!(rr > 0) || !(mu > 0)) return null;
  const energy = v2 / 2 - mu / rr;
  if (energy >= 0) return null;
  const a = -mu / (2 * energy);
  return 2 * Math.PI * Math.sqrt((a * a * a) / mu);
}

/** Orbit parent: the UI parent when it is a physical body, otherwise the Sun. */
export function orbitParentId(body: Body, byId: Map<number, Body>, sunId: number | null): number | null {
  if (body.id === sunId || body.kind === 'star' || body.kind === 'barycenter') return null;
  const p = body.parent !== undefined ? byId.get(body.parent) : undefined;
  if (p && p.kind !== 'barycenter') return p.id;
  return sunId;
}

/** [start, end] of one period around et, kept inside the window; the whole window if the period is longer. */
export function orbitSpan(et: number, period: number | null, w: TimeWindow): [number, number] {
  const L = w.endEt - w.startEt;
  if (period === null || !(period < L)) return [w.startEt, w.endEt];
  let s = et - period / 2;
  s = Math.max(w.startEt, Math.min(s, w.endEt - period));
  return [s, s + period];
}

export function buildTrack(
  eph: EphemerisSetPort,
  body: Body,
  parent: Body,
  w: TimeWindow,
  etNow: number,
  opts: { samplesPerPeriod?: number; minSamples?: number; maxSamples?: number } = {},
): OrbitTrack | null {
  const spp = opts.samplesPerPeriod ?? 256;
  const minS = opts.minSamples ?? 512;
  const maxS = opts.maxSamples ?? 40000;
  const L = w.endEt - w.startEt;
  if (!(L > 0)) return null;
  let period: number | null = null;
  const gm1 = body.gm?.value, gm2 = parent.gm?.value;
  if (typeof gm1 === 'number' && typeof gm2 === 'number') {
    const t = Math.min(Math.max(etNow, w.startEt), w.endEt);
    const sb = eph.stateSSB(body.id, t), sp = eph.stateSSB(parent.id, t);
    if (sb && sp) period = osculatingPeriod(sub(sb.pos, sp.pos), sub(sb.vel, sp.vel), gm1 + gm2);
  }
  let n = period !== null && period < L ? Math.ceil((L / period) * spp) + 1 : minS;
  n = Math.max(2, Math.min(maxS, Math.max(n, minS)));
  const dt = L / (n - 1);
  const rel = new Float64Array(3 * n);
  for (let i = 0; i < n; i++) {
    const t = w.startEt + i * dt;
    const a = eph.positionSSB(body.id, t), b = eph.positionSSB(parent.id, t);
    if (a && b) { rel[3 * i] = a[0] - b[0]; rel[3 * i + 1] = a[1] - b[1]; rel[3 * i + 2] = a[2] - b[2]; }
    else rel[3 * i] = rel[3 * i + 1] = rel[3 * i + 2] = NaN;
  }
  return { id: body.id, parentId: parent.id, t0: w.startEt, dt, n, rel, period };
}

/** Camera-relative polyline for the span around et. NaN samples are dropped. */
export function trackPolyline(track: OrbitTrack, et: number, w: TimeWindow, parentCamRel: Vec3, selected: boolean): OrbitPolyline {
  const [s, e] = orbitSpan(et, track.period, w);
  const i0 = Math.max(0, Math.floor((s - track.t0) / track.dt));
  const i1 = Math.min(track.n - 1, Math.ceil((e - track.t0) / track.dt));
  const pts = new Float64Array(3 * (i1 - i0 + 1));
  let k = 0;
  for (let i = i0; i <= i1; i++) {
    const x = track.rel[3 * i];
    if (Number.isNaN(x)) continue;
    pts[k++] = parentCamRel[0] + x;
    pts[k++] = parentCamRel[1] + track.rel[3 * i + 1];
    pts[k++] = parentCamRel[2] + track.rel[3 * i + 2];
  }
  return { id: track.id, points: k === pts.length ? pts : pts.slice(0, k), selected };
}

/** Lazily built, cached tracks for all bodies. */
export class OrbitTracks {
  private tracks = new Map<number, OrbitTrack | null>();
  constructor(
    private readonly eph: EphemerisSetPort,
    private readonly bodies: Body[],
    private readonly sunId: number | null,
    private readonly window: TimeWindow,
  ) {}

  get(id: number, etNow: number): OrbitTrack | null {
    if (this.tracks.has(id)) return this.tracks.get(id)!;
    const byId = new Map(this.bodies.map((b) => [b.id, b]));
    const body = byId.get(id);
    const pid = body ? orbitParentId(body, byId, this.sunId) : null;
    const parent = pid !== null ? byId.get(pid) : undefined;
    const t = body && parent ? buildTrack(this.eph, body, parent, this.window, etNow) : null;
    this.tracks.set(id, t);
    return t;
  }
}
