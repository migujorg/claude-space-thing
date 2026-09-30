// Orbit overlay polylines, built lazily and cheaply for hundreds of bodies.
//
// Each body's track is its position relative to its parent (UI parent, or the Sun), sampled from the
// ephemeris over ~1.5 orbital periods around the current time (or the whole data window when the period is
// longer or unknown). Each frame the manager:
//   1. skips bodies whose orbit would be smaller than a few pixels on screen (unless selected);
//   2. asks for a sample count proportional to the orbit's apparent size (a few px per segment);
//   3. (re)builds missing, stale or under-resolved tracks in priority order — selected first, then missing
//      tracks, then by apparent size — until a time budget is spent (work spreads over frames);
//   4. draws every candidate that has a track, camera-relative via the parent's apparent position.
// A stale track (sampled around another epoch) is still drawn: relative to the parent the orbit's shape
// changes slowly; it is refreshed as the budget allows.
//
// Period: osculating two-body period from the ephemeris state relative to the parent with μ = GM(parent) +
// GM(body, or 0 if unknown). It only chooses how much of the track to show; every drawn point is an
// ephemeris position.

import type { Body } from '../data/schema';
import type { OrbitPolyline } from '../render/scene';
import type { EphemerisSetPort, Vec3 } from './ports';
import type { TimeWindow } from './clock';
import type { World } from './world';
import { dot, len, sub } from './vec';

export interface OrbitTrack {
  id: number;
  parentId: number;
  t0: number;
  t1: number;
  n: number;
  /** body − parent at t0 + i·(t1 − t0)/(n − 1), km; NaN where not covered. */
  rel: Float64Array;
  period: number | null;
  /** Epoch the span was centred on. */
  centerEt: number;
  /** Samples-per-full-orbit the track was built for (resolution bookkeeping). */
  perOrbit: number;
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
  return spanAround(et, period, w, 1);
}

function spanAround(et: number, period: number | null, w: TimeWindow, periods: number): [number, number] {
  const L = w.endEt - w.startEt;
  const len = period === null ? Infinity : period * periods;
  if (!(len < L)) return [w.startEt, w.endEt];
  let s = et - len / 2;
  s = Math.max(w.startEt, Math.min(s, w.endEt - len));
  return [s, s + len];
}

export function periodOf(eph: EphemerisSetPort, body: Body, parent: Body, et: number): number | null {
  const gp = parent.gm?.value;
  if (typeof gp !== 'number') return null;
  const gb = typeof body.gm?.value === 'number' ? body.gm.value : 0;
  // Copy each result before the next call: implementations may reuse scratch arrays.
  const s1 = eph.stateSSB(body.id, et);
  const sb = s1 ? { pos: [...s1.pos] as Vec3, vel: [...s1.vel] as Vec3 } : null;
  const sp = eph.stateSSB(parent.id, et);
  return sb && sp ? osculatingPeriod(sub(sb.pos, sp.pos), sub(sb.vel, sp.vel), gp + gb) : null;
}

/** Sample body − parent at n epochs over [t0, t1]. */
export function sampleRelative(eph: EphemerisSetPort, id: number, parentId: number, t0: number, t1: number, n: number): Float64Array {
  const rel = new Float64Array(3 * n);
  const dt = n > 1 ? (t1 - t0) / (n - 1) : 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + i * dt;
    const a0 = eph.positionSSB(id, t);
    const a = a0 ? [a0[0], a0[1], a0[2]] : null;
    const b = eph.positionSSB(parentId, t);
    if (a && b) { rel[3 * i] = a[0] - b[0]; rel[3 * i + 1] = a[1] - b[1]; rel[3 * i + 2] = a[2] - b[2]; }
    else rel[3 * i] = rel[3 * i + 1] = rel[3 * i + 2] = NaN;
  }
  return rel;
}

/** Build a track sampled over 1.5 periods around et (or the window), `perOrbit` samples per full orbit. */
export function buildTrack(eph: EphemerisSetPort, body: Body, parent: Body, w: TimeWindow, et: number, perOrbit: number, maxSamples = 8192): OrbitTrack | null {
  if (!(w.endEt > w.startEt)) return null;
  const tc = Math.min(Math.max(et, w.startEt), w.endEt);
  const period = periodOf(eph, body, parent, tc);
  const [t0, t1] = spanAround(tc, period, w, 1.5);
  const orbits = period ? (t1 - t0) / period : 1;
  const n = Math.max(8, Math.min(maxSamples, Math.ceil(perOrbit * orbits) + 1));
  return { id: body.id, parentId: parent.id, t0, t1, n, rel: sampleRelative(eph, body.id, parent.id, t0, t1, n), period, centerEt: tc, perOrbit };
}

/** Camera-relative polyline: one period around et when the track covers it, else the whole (stale) track. NaNs dropped. */
export function trackPolyline(track: OrbitTrack, et: number, w: TimeWindow, parentCamRel: Vec3, selected: boolean): OrbitPolyline {
  let i0 = 0, i1 = track.n - 1;
  const [s, e] = orbitSpan(et, track.period, w);
  if (s >= track.t0 - 1e-6 && e <= track.t1 + 1e-6 && track.n > 1) {
    const dt = (track.t1 - track.t0) / (track.n - 1);
    i0 = Math.max(0, Math.floor((s - track.t0) / dt));
    i1 = Math.min(track.n - 1, Math.ceil((e - track.t0) / dt));
  }
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

export const ORBIT_TUNING = {
  /** Orbits smaller than this on screen (radius, px) are not drawn unless selected. */
  minRadiusPx: 3,
  /** Target polyline segment length on screen, px. */
  segmentPx: 5,
  minPerOrbit: 48,
  /** ~0.5° of orbit per segment at most: enough for any on-screen curvature. */
  maxPerOrbit: 720,
  selectedMinPerOrbit: 256,
  /** Cap on polyline points handed to the renderer per frame (lowest-priority orbits dropped first). */
  maxPointsPerFrame: 150_000,
  /** Time budget for sampling per frame, ms (at least one track is built per frame). */
  budgetMs: 3,
};

export interface OrbitFrameStats {
  candidates: number;
  drawn: number;
  built: number;
  pending: number;
  ms: number;
}

export interface OrbitView {
  et: number;
  world: World;
  /** Vertical field of view, rad, and viewport height, px. */
  fovY: number;
  height: number;
  selectedId: number | null;
}

/** Lazily built, budgeted orbit tracks for all bodies. */
export class OrbitManager {
  private readonly tracks = new Map<number, OrbitTrack>();
  private readonly byId: Map<number, Body>;
  private readonly parents = new Map<number, number | null>();
  stats: OrbitFrameStats = { candidates: 0, drawn: 0, built: 0, pending: 0, ms: 0 };

  constructor(
    private readonly eph: EphemerisSetPort,
    bodies: Body[],
    private readonly sunId: number | null,
    private readonly window: TimeWindow,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.byId = new Map(bodies.map((b) => [b.id, b]));
  }

  /** Forget tracks (e.g. after a system's ephemeris loaded, coverage changed). */
  invalidate(ids?: Iterable<number>): void {
    if (!ids) this.tracks.clear();
    else for (const id of ids) this.tracks.delete(id);
  }

  track(id: number): OrbitTrack | undefined {
    return this.tracks.get(id);
  }

  private parentOf(id: number): number | null {
    if (!this.parents.has(id)) {
      const b = this.byId.get(id);
      this.parents.set(id, b ? orbitParentId(b, this.byId, this.sunId) : null);
    }
    return this.parents.get(id)!;
  }

  update(v: OrbitView, budgetMs = ORBIT_TUNING.budgetMs): OrbitPolyline[] {
    const t0 = this.now();
    const pxPerRad = v.height / (2 * Math.tan(v.fovY / 2));
    const cands: { id: number; parentRel: Vec3; perOrbit: number; prio: number; sel: boolean }[] = [];
    for (const g of v.world.bodies.values()) {
      if (!g.app || g.body.kind === 'star' || g.body.kind === 'barycenter') continue;
      const pid = this.parentOf(g.id);
      const p = pid !== null ? v.world.bodies.get(pid) : undefined;
      if (!p?.app) continue;
      const a = len(sub(g.app.rel, p.app.rel));
      const dParent = len(p.app.rel);
      const rPx = dParent > a ? (a / dParent) * pxPerRad : 1e5;
      const sel = g.id === v.selectedId;
      if (rPx < ORBIT_TUNING.minRadiusPx && !sel) continue;
      let perOrbit = Math.ceil((2 * Math.PI * Math.min(rPx, 1e5)) / ORBIT_TUNING.segmentPx);
      perOrbit = Math.max(sel ? ORBIT_TUNING.selectedMinPerOrbit : ORBIT_TUNING.minPerOrbit, Math.min(ORBIT_TUNING.maxPerOrbit, perOrbit));
      cands.push({ id: g.id, parentRel: p.app.rel, perOrbit, prio: (sel ? 1e12 : 0) + rPx, sel });
    }
    // Work list: missing, stale (outside ±¼ period of its centre) or under-resolved tracks.
    const work = cands
      .map((c) => {
        const t = this.tracks.get(c.id);
        if (!t) return { c, prio: c.prio + 1e9 };
        const stale = t.period !== null && t.t1 - t.t0 < this.window.endEt - this.window.startEt - 1e-6 && Math.abs(v.et - t.centerEt) > t.period / 4;
        const coarse = c.perOrbit > 1.5 * t.perOrbit;
        return stale || coarse ? { c, prio: c.prio } : null;
      })
      .filter((x): x is { c: (typeof cands)[number]; prio: number } => x !== null)
      .sort((a, b) => b.prio - a.prio);
    let built = 0;
    for (const w of work) {
      if (built > 0 && this.now() - t0 >= budgetMs) break;
      const body = this.byId.get(w.c.id)!;
      const parent = this.byId.get(this.parentOf(w.c.id)!)!;
      const t = buildTrack(this.eph, body, parent, this.window, v.et, w.c.perOrbit);
      if (t) this.tracks.set(w.c.id, t);
      built++;
    }
    const out: OrbitPolyline[] = [];
    let points = 0;
    for (const c of [...cands].sort((a, b) => b.prio - a.prio)) {
      const t = this.tracks.get(c.id);
      if (!t) continue;
      if (points > ORBIT_TUNING.maxPointsPerFrame && !c.sel) break;
      const pl = trackPolyline(t, v.et, this.window, c.parentRel, c.sel);
      points += pl.points.length / 3;
      out.push(pl);
    }
    this.stats = { candidates: cands.length, drawn: out.length, built, pending: work.length - built, ms: this.now() - t0 };
    return out;
  }
}
