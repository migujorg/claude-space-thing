// Event finder ("Moments"): notable configurations inside the data window, computed from the loaded ephemerides,
// body radii and orientation models only — so every result is `derived`. Pure (no DOM); runs in a Web Worker
// (events.worker.ts). docs: app/src/app/events/README in the report; methods are stated per event (`method`).
//
// Geometry is light-time consistent (Newtonian, as core/lighttime.ts): what an observer sees at `et` is each body
// where it was when its light left it; shadows are cast by bodies where they were when the sunlight passed them.
// Times are TDB seconds past J2000. Root finding: a coarse scan (step chosen per phenomenon, far below its
// duration), then bisection on sign changes and golden-section search on minima, to ~0.1 s.

import { AU_KM, C_KM_S } from '../../core/constants';
import type { Mat3, Vec3 } from '../ports';

// ---- inputs & outputs ---------------------------------------------------------------------------------------

export interface FinderInput {
  eph: { positionSSB(id: number, et: number): Vec3 | null };
  /** Triaxial radii a, b, c (km) by NAIF id. */
  radii: Map<number, Vec3>;
  /** Body-fixed → ICRF (row-major) at et, or null (orientation unknown). */
  orientation(id: number, et: number): Mat3 | null;
  window: { startEt: number; endEt: number };
  /** Top of the drawn atmosphere above the body's largest radius (km), per body with one (atmospheres.json). */
  atmosphereTopKm?: Map<number, number>;
}

/** A viewpoint "just above the atmosphere" clears the drawn atmosphere's top by this much (framing), km. */
export const ABOVE_ATMOSPHERE_KM = 50;

/**
 * A camera placement that shows an event, at the event time: the camera is at `rel` (km, ICRF) from `target`'s
 * centre and orbits it (looking at its centre) — or, with `lookAt`, stays fixed relative to `target` and looks at
 * the body `lookAt` (a viewpoint on or near a surface).
 */
export interface EventView {
  label: string;
  target: number;
  rel: Vec3;
  lookAt?: number;
  /** Camera up hint (ICRF); default: the app's. */
  up?: Vec3;
  fovDeg?: number;
  /** Viewing mode for faint things (always labelled ENHANCED by the app's badge). */
  enhancedStops?: number;
  /** Cover the Sun with the occulting disc (a viewing aid, badged). */
  sunShield?: boolean;
  /** Time of the view when it differs from the event time (TDB s). */
  et?: number;
  note?: string;
}

export type EventKind =
  | 'solar-eclipse' | 'lunar-eclipse' | 'jovian' | 'ring-plane' | 'opposition' | 'conjunction' | 'elongation'
  | 'planet-pair' | 'mutual' | 'neo-approach';

export interface SkyEvent {
  id: string;
  kind: EventKind;
  subtype: string;
  /** Time of the event's centre (greatest eclipse, mid-transit, crossing, extremum), TDB s past J2000. */
  et: number;
  startEt?: number;
  endEt?: number;
  title: string;
  detail: string;
  /** Bodies whose ephemerides (and radii) the event rests on (provenance). */
  bodies: number[];
  /** Bodies whose orientation model the result uses (provenance). */
  orientations?: number[];
  observer: string;
  /** How it was computed (shown with the event). */
  method: string;
  /** Larger = more striking (for curated lists). */
  rank: number;
  views: EventView[];
  /** Extra numbers (for tests and the UI). */
  data?: Record<string, number | string | boolean>;
}

// ---- small vector helpers (f64 arrays, no allocation discipline needed here) ----------------------------------

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => mul(a, 1 / len(a));
const angle = (a: Vec3, b: Vec3): number => Math.atan2(len(cross(a, b)), dot(a, b));
const mT = (m: Mat3, v: Vec3): Vec3 => [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]];
const mV = (m: Mat3, v: Vec3): Vec3 => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
const DEG = Math.PI / 180;

// ---- numerical tools --------------------------------------------------------------------------------------------

/** Sample f on [t0, t1] with a step; NaN where f is undefined. */
export function scan(f: (t: number) => number, t0: number, t1: number, step: number): { t: Float64Array; v: Float64Array } {
  const n = Math.max(2, Math.ceil((t1 - t0) / step) + 1);
  const t = new Float64Array(n), v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    t[i] = Math.min(t1, t0 + i * step);
    v[i] = f(t[i]);
  }
  return { t, v };
}

/** Root of f in [a, b] where f(a), f(b) have opposite signs (bisection to tol seconds). */
export function bisect(f: (t: number) => number, a: number, b: number, tol = 0.05): number {
  let fa = f(a);
  for (let i = 0; i < 80 && b - a > tol; i++) {
    const m = 0.5 * (a + b), fm = f(m);
    if (!Number.isFinite(fm)) return m;
    if ((fa < 0) === (fm < 0)) { a = m; fa = fm; } else b = m;
  }
  return 0.5 * (a + b);
}

/** Golden-section minimum of f on [a, b] (to tol seconds). */
export function goldenMin(f: (t: number) => number, a: number, b: number, tol = 0.1): { t: number; v: number } {
  const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a), d = a + g * (b - a), fc = f(c), fd = f(d);
  for (let i = 0; i < 200 && b - a > tol; i++) {
    if (fc < fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = f(c); }
    else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = f(d); }
  }
  const t = 0.5 * (a + b);
  return { t, v: f(t) };
}

/** Refined local minima of f: scan, then golden-section around every sampled minimum below `below`. */
export function minima(f: (t: number) => number, t0: number, t1: number, step: number, below = Infinity): { t: number; v: number }[] {
  const s = scan(f, t0, t1, step);
  const out: { t: number; v: number }[] = [];
  for (let i = 1; i < s.v.length - 1; i++) {
    const v = s.v[i];
    if (!(v <= s.v[i - 1] && v < s.v[i + 1]) || !(v < below)) continue;
    const m = goldenMin(f, s.t[i - 1], s.t[i + 1]);
    if (m.t > t0 + 1 && m.t < t1 - 1) out.push(m);
  }
  return out;
}

/** Intervals where f < 0, with refined ends (a scan step shorter than any interval, plus minima for grazes). */
export function negativeIntervals(f: (t: number) => number, t0: number, t1: number, step: number): { start: number; end: number; min: { t: number; v: number } }[] {
  const s = scan(f, t0, t1, step);
  const out: { start: number; end: number; min: { t: number; v: number } }[] = [];
  const n = s.v.length;
  let i = 0;
  while (i < n - 1) {
    // Enter: a sign change, or a sampled minimum dipping below zero between two positive samples.
    if (s.v[i] >= 0 && s.v[i + 1] < 0) {
      const start = bisect(f, s.t[i], s.t[i + 1]);
      let j = i + 1;
      while (j < n - 1 && s.v[j + 1] < 0) j++;
      if (j >= n - 1) break; // runs past the window end: not a complete event
      const end = bisect(f, s.t[j], s.t[j + 1]);
      out.push({ start, end, min: goldenMin(f, start, end) });
      i = j + 1;
      continue;
    }
    if (i > 0 && s.v[i] >= 0 && s.v[i] < s.v[i - 1] && s.v[i] <= s.v[i + 1] && s.v[i] < 0.3) {
      const m = goldenMin(f, s.t[i - 1], s.t[i + 1]);
      if (m.v < 0) out.push({ start: bisect(f, s.t[i - 1], m.t), end: bisect(f, m.t, s.t[i + 1]), min: m });
    }
    i++;
  }
  return out;
}

// ---- geometry -------------------------------------------------------------------------------------------------

const SUN = 10, EARTH = 399, MOON = 301, JUPITER = 599, SATURN = 699, PLUTO = 999, CHARON = 901, EMB = 3;

export class Geometry {
  constructor(readonly inp: FinderInput) {}

  pos(id: number, t: number): Vec3 {
    const p = this.inp.eph.positionSSB(id, t);
    return p ? [p[0], p[1], p[2]] : [NaN, NaN, NaN];
  }

  /** Where the observer sees body `id` at t: its position when the light left it, and that epoch. */
  apparent(id: number, obs: Vec3, t: number): { p: Vec3; emit: number } {
    let p = this.pos(id, t);
    let lt = len(sub(p, obs)) / C_KM_S;
    for (let k = 0; k < 4; k++) {
      p = this.pos(id, t - lt);
      lt = len(sub(p, obs)) / C_KM_S;
    }
    return { p, emit: t - lt };
  }

  radius(id: number): Vec3 {
    const r = this.inp.radii.get(id);
    if (!r) throw new Error(`no radii for ${id}`);
    return r;
  }

  meanRadius(id: number): number {
    const r = this.radius(id);
    return (r[0] + r[1] + r[2]) / 3;
  }

  /**
   * A ray (origin o, unit direction d) against body `id`'s ellipsoid centred at c, oriented at et: the distance of
   * the line from the centre in radius-scaled coordinates (< 1: the line pierces the body), and the ray parameter
   * of the first intersection (NaN when it misses). Without an orientation the body is taken as a sphere of its
   * mean radius.
   */
  pierce(id: number, c: Vec3, et: number, o: Vec3, d: Vec3): { rho: number; hit: number; along: number } {
    const r = this.radius(id);
    const R = this.inp.orientation(id, et);
    let oo = sub(o, c), dd = d;
    let rr: Vec3 = r;
    if (R) { oo = mT(R, oo); dd = mT(R, dd); } else { const m = this.meanRadius(id); rr = [m, m, m]; }
    const os: Vec3 = [oo[0] / rr[0], oo[1] / rr[1], oo[2] / rr[2]];
    const ds: Vec3 = [dd[0] / rr[0], dd[1] / rr[1], dd[2] / rr[2]];
    const a = dot(ds, ds), b = dot(os, ds), cc = dot(os, os) - 1;
    const along = -b / a; // parameter of closest approach
    const rho = len([os[0] + ds[0] * along, os[1] + ds[1] * along, os[2] + ds[2] * along]);
    const disc = b * b - a * cc;
    const hit = disc >= 0 ? (-b - Math.sqrt(disc)) / a : NaN;
    return { rho, hit, along };
  }
}

// ---- solar eclipses (seen from Earth) ---------------------------------------------------------------------------

export interface SolarEclipseGeometry {
  et: number;
  /** Distance of the shadow axis from Earth's centre in equatorial radii. */
  gamma: number;
  kind: 'total' | 'annular' | 'partial';
  /** Greatest-eclipse point (geodetic, degrees) and the Sun's altitude there. */
  latDeg: number;
  lonDeg: number;
  sunAltDeg: number;
  /** Eclipse magnitude at the greatest-eclipse point: the diameter ratio (central) or the covered fraction. */
  magnitude: number;
  /** Apparent diameter ratio Moon / Sun there. */
  ratio: number;
  /** Central duration at the greatest-eclipse point, s (total/annular). */
  durationS: number;
  /** Umbra (or antumbra) diameter on the fundamental plane there, km. */
  umbraKm: number;
  /** Ground point (ICRF, SSB) and the shadow axis direction (Sun → Moon). */
  point: Vec3;
  up: Vec3;
  axis: Vec3;
  /** The point of the shadow axis nearest the Earth's centre (SSB). */
  onAxis: Vec3;
}

/** Shadow axis for the Earth at time t: Moon and Sun where they were when the shadow now at Earth was cast. */
function moonShadowAxis(g: Geometry, t: number): { M: Vec3; S: Vec3; E: Vec3; u: Vec3 } {
  const E = g.pos(EARTH, t);
  let M = g.pos(MOON, t);
  M = g.pos(MOON, t - len(sub(M, E)) / C_KM_S);
  const tM = t - len(sub(M, E)) / C_KM_S;
  let S = g.pos(SUN, tM);
  S = g.pos(SUN, tM - len(sub(S, M)) / C_KM_S);
  return { M, S, E, u: unit(sub(M, S)) };
}

export function solarEclipseAt(g: Geometry, t: number): SolarEclipseGeometry | null {
  const { M, S, E, u } = moonShadowAxis(g, t);
  const RE = g.radius(EARTH), RM = g.meanRadius(MOON), RS = g.meanRadius(SUN);
  const D = len(sub(M, S));
  const em = sub(E, M);
  const x0 = dot(em, u);
  const d = len(sub(em, mul(u, x0)));
  const rp = RM + (x0 * (RS + RM)) / D; // penumbra radius at Earth's distance
  const gamma = d / RE[0];
  if (d > RE[0] + rp) return null;
  const R = g.inp.orientation(EARTH, t);
  // First intersection of the axis with the ellipsoid (from the Moon side), else the limb point nearest the axis.
  const hit = g.pierce(EARTH, E, t, M, u);
  let P: Vec3;
  let central = false;
  if (Number.isFinite(hit.hit)) {
    P = add(M, mul(u, hit.hit));
    central = true;
  } else {
    // The surface point below the axis' closest approach (on the ellipsoid when the orientation is known).
    const dir = unit(sub(add(M, mul(u, x0)), E));
    let s = RE[0];
    if (R) {
      const b = mT(R, dir);
      s = 1 / Math.hypot(b[0] / RE[0], b[1] / RE[1], b[2] / RE[2]);
    }
    P = add(E, mul(dir, s));
  }
  const xP = dot(sub(P, M), u);
  const ru = RM - (xP * (RS - RM)) / D; // > 0 umbra (total), < 0 antumbra (annular)
  let kind: SolarEclipseGeometry['kind'] = 'partial';
  if (central || d < RE[0] + Math.abs(ru)) kind = ru > 0 ? 'total' : 'annular';
  // Geodetic position and local vertical.
  let latDeg = NaN, lonDeg = NaN, up = unit(sub(P, E));
  if (R) {
    const p = mT(R, sub(P, E));
    const a = RE[0], c = RE[2];
    latDeg = Math.atan2(p[2] * a * a, Math.hypot(p[0], p[1]) * c * c) / DEG;
    lonDeg = Math.atan2(p[1], p[0]) / DEG;
    up = unit(mV(R, [p[0] / (a * a), p[1] / (a * a), p[2] / (c * c)]));
  }
  const sunDir = unit(sub(S, P));
  const sunAltDeg = 90 - angle(up, sunDir) / DEG;
  const sM = Math.asin(RM / len(sub(M, P))), sS = Math.asin(RS / len(sub(S, P)));
  const ratio = sM / sS;
  // Eclipse magnitude: the apparent diameter ratio for a central eclipse; otherwise the fraction of the Sun's
  // diameter covered (the conventional definitions).
  const covered = (sS + sM - angle(sub(M, P), sub(S, P))) / (2 * sS);
  // Central duration: umbra diameter over the speed of the ground point relative to the axis, on the fundamental plane.
  let durationS = NaN;
  if (kind !== 'partial' && R) {
    const pFixed = mT(R, sub(P, E));
    const w = (tt: number) => {
      const ax = moonShadowAxis(g, tt);
      const Rt = g.inp.orientation(EARTH, tt) ?? R;
      const O = add(ax.E, mV(Rt, pFixed));
      const om = sub(O, ax.M);
      return sub(om, mul(ax.u, dot(om, ax.u)));
    };
    const h = 5;
    const vPerp = len(sub(w(t + h), w(t - h))) / (2 * h);
    durationS = (2 * Math.abs(ru)) / vPerp;
  }
  const magnitude = kind === 'partial' ? covered : ratio;
  return { et: t, gamma, kind, latDeg, lonDeg, sunAltDeg, magnitude, ratio, durationS, umbraKm: 2 * Math.abs(ru), point: P, up, axis: u, onAxis: add(M, mul(u, x0)) };
}

/** Geocentric Sun–Moon angle minima (new moons) in the window. */
export function newMoons(g: Geometry): number[] {
  const f = (t: number) => angle(sub(g.pos(MOON, t), g.pos(EARTH, t)), sub(g.pos(SUN, t), g.pos(EARTH, t)));
  const w = g.inp.window;
  return minima(f, w.startEt, w.endEt, 43200).map((m) => m.t);
}

export function fullMoons(g: Geometry): number[] {
  const f = (t: number) => angle(sub(g.pos(MOON, t), g.pos(EARTH, t)), sub(g.pos(EARTH, t), g.pos(SUN, t)));
  const w = g.inp.window;
  return minima(f, w.startEt, w.endEt, 43200).map((m) => m.t);
}

const EPHEM_METHOD = 'from the loaded ephemerides (positions), the bodies\' radii and orientation models; light-time corrected (Newtonian), no aberration';

export function solarEclipses(g: Geometry): SkyEvent[] {
  const out: SkyEvent[] = [];
  const RE = g.radius(EARTH);
  for (const tc of newMoons(g)) {
    const axisDist = (t: number) => {
      const { M, E, u } = moonShadowAxis(g, t);
      const em = sub(E, M);
      return len(sub(em, mul(u, dot(em, u))));
    };
    const m = goldenMin(axisDist, tc - 6 * 3600, tc + 6 * 3600);
    const e = solarEclipseAt(g, m.t);
    if (!e) continue;
    const kindName = e.kind === 'total' ? 'Total' : e.kind === 'annular' ? 'Annular' : 'Partial';
    const where = Number.isFinite(e.latDeg) ? `${fmtLat(e.latDeg)} ${fmtLon(e.lonDeg)}` : 'unknown';
    const central = e.kind !== 'partial';
    const detail = [
      `greatest eclipse at ${where}, Sun ${Math.round(e.sunAltDeg) || 0}° high`,
      central ? `${e.kind === 'total' ? 'totality' : 'annularity'} ${fmtDuration(e.durationS)} there` : `${(100 * e.magnitude).toFixed(0)} % of the Sun's diameter covered at most`,
      `magnitude ${e.magnitude.toFixed(4)}`,
      `shadow axis ${e.gamma.toFixed(4)} Earth radii from the centre`,
    ].join('; ');
    // View 1: in space on the shadow axis, looking back at the Earth. View 2: over the greatest-eclipse point,
    // looking at the Sun — just above the atmosphere when the Earth has one drawn: the renderer does not darken
    // the sky in the Moon's shadow, so from the ground it would show a daylight sky during totality.
    const E = g.pos(EARTH, m.t);
    const top = g.inp.atmosphereTopKm?.get(EARTH);
    const alt = top !== undefined ? top + ABOVE_ATMOSPHERE_KM : 1;
    const onAxis = add(e.onAxis, mul(e.axis, -4.5 * RE[0]));
    const views: EventView[] = [
      { label: 'Above the Earth, in the Moon\'s shadow', target: EARTH, rel: sub(onAxis, E), note: 'The camera is on the shadow axis between the Moon and the Earth, looking at the Earth: the Moon\'s shadow is the dark spot.' },
      {
        label: `${top !== undefined ? 'Just above the atmosphere over' : 'On the ground at'} ${central ? 'greatest eclipse' : 'the point of greatest eclipse'}, looking at the Sun`,
        target: EARTH,
        rel: sub(add(e.point, mul(e.up, alt)), E),
        lookAt: SUN,
        up: e.up,
        fovDeg: 6,
        note: top !== undefined
          ? `The camera is ${Math.round(alt)} km above the greatest-eclipse point, above the drawn atmosphere: the renderer does not yet darken the sky in the Moon's shadow, so a view from the ground would show a daylight sky during totality. Around the Moon: the solar corona (K-corona from van de Hulst's 1950 photometry at this date's phase of the solar cycle, F-corona from the LASCO map; estimated, an average corona: the streamers of the day are not known).`
          : "The camera is 1 km above the greatest-eclipse point. Around the Moon: the solar corona (K-corona from van de Hulst's 1950 photometry at this date's phase of the solar cycle, F-corona from the LASCO map; estimated, an average corona: the streamers of the day are not known).",
      },
    ];
    out.push({
      id: `solar-eclipse:${e.kind}:${Math.round(m.t)}`,
      kind: 'solar-eclipse',
      subtype: e.kind,
      et: m.t,
      title: `${kindName} solar eclipse`,
      detail,
      bodies: [SUN, EARTH, MOON],
      orientations: [EARTH],
      observer: 'the Earth',
      method: `Greatest eclipse: the time the Moon's shadow axis passes closest to the Earth's centre; point, type and duration from the umbra/antumbra cone at the first intersection of the axis with the Earth's ellipsoid (orientation: the Earth's orientation model), with the Moon's mean radius (published predictions use a slightly smaller lunar radius for central durations, so theirs are a few seconds shorter). ${EPHEM_METHOD}.`,
      // Longer central phases rank higher (the curated list shows the best one).
      rank: (e.kind === 'total' ? 90 : e.kind === 'annular' ? 70 : 30) + (Number.isFinite(e.durationS) ? Math.min(10, e.durationS / 60) : 0),
      views,
      data: { gamma: e.gamma, latDeg: e.latDeg, lonDeg: e.lonDeg, magnitude: e.magnitude, ratio: e.ratio, durationS: e.durationS, sunAltDeg: e.sunAltDeg, umbraKm: e.umbraKm },
    });
  }
  return out;
}

// ---- lunar eclipses ---------------------------------------------------------------------------------------------

function earthShadowAt(g: Geometry, t: number) {
  const M = g.pos(MOON, t);
  let E = g.pos(EARTH, t);
  E = g.pos(EARTH, t - len(sub(M, E)) / C_KM_S);
  const tE = t - len(sub(M, E)) / C_KM_S;
  let S = g.pos(SUN, tE);
  S = g.pos(SUN, tE - len(sub(E, S)) / C_KM_S);
  const u = unit(sub(E, S));
  const me = sub(M, E);
  const x = dot(me, u);
  const d = len(sub(me, mul(u, x)));
  const RE = g.meanRadius(EARTH), RS = g.meanRadius(SUN), RM = g.meanRadius(MOON);
  const D = len(sub(E, S));
  const ru = RE - (x * (RS - RE)) / D;
  const rp = RE + (x * (RS + RE)) / D;
  return { d, ru, rp, RM, M, E, u };
}

export function lunarEclipses(g: Geometry): SkyEvent[] {
  const out: SkyEvent[] = [];
  for (const tc of fullMoons(g)) {
    const m = goldenMin((t) => earthShadowAt(g, t).d, tc - 6 * 3600, tc + 6 * 3600);
    const s = earthShadowAt(g, m.t);
    const umbral = (s.ru + s.RM - s.d) / (2 * s.RM);
    const penumbral = (s.rp + s.RM - s.d) / (2 * s.RM);
    if (penumbral <= 0) continue;
    const kind = umbral >= 1 ? 'total' : umbral > 0 ? 'partial' : 'penumbral';
    const contact = (level: (x: ReturnType<typeof earthShadowAt>) => number) => {
      const f = (t: number) => earthShadowAt(g, t).d - level(earthShadowAt(g, t));
      if (f(m.t) >= 0) return null;
      return { a: bisect(f, m.t - 5 * 3600, m.t), b: bisect(f, m.t, m.t + 5 * 3600) };
    };
    const tot = kind === 'total' ? contact((x) => x.ru - x.RM) : null;
    const par = kind !== 'penumbral' ? contact((x) => x.ru + x.RM) : null;
    const pen = contact((x) => x.rp + x.RM);
    const detail = [
      `umbral magnitude ${umbral.toFixed(3)}, penumbral ${penumbral.toFixed(3)}`,
      tot ? `totality ${fmtDuration(tot.b - tot.a)}` : null,
      par ? `in the umbra ${fmtDuration(par.b - par.a)}` : null,
      pen ? `in the penumbra ${fmtDuration(pen.b - pen.a)}` : null,
    ].filter(Boolean).join('; ');
    const RM = s.RM;
    const toEarth = unit(sub(s.E, s.M));
    const side = unit(cross(toEarth, [0, 0, 1]));
    const views: EventView[] = [
      {
        label: 'From the Moon: the Earth covers the Sun',
        target: MOON,
        rel: mul(toEarth, RM + 2),
        lookAt: EARTH,
        fovDeg: 6,
        note: 'The camera is 2 km above the Moon\'s surface, below the Earth. The red ring of sunlight refracted by the Earth\'s atmosphere is not rendered yet, so the Earth is a black disk.',
      },
      {
        label: 'The Moon in the Earth\'s shadow, from nearby',
        target: MOON,
        rel: add(mul(toEarth, 12 * RM), mul(side, 5 * RM)),
        note: 'Without the atmosphere\'s refracted light (not rendered yet) the umbra is black rather than red.',
      },
    ];
    out.push({
      id: `lunar-eclipse:${kind}:${Math.round(m.t)}`,
      kind: 'lunar-eclipse',
      subtype: kind,
      et: m.t,
      startEt: pen?.a,
      endEt: pen?.b,
      title: `${kind[0].toUpperCase()}${kind.slice(1)} lunar eclipse`,
      detail,
      bodies: [SUN, EARTH, MOON],
      observer: 'the Earth\'s night side',
      method: `Greatest eclipse: the time the Moon's centre passes closest to the axis of the Earth's shadow; magnitudes and contacts from the geometric umbra and penumbra of the Earth's mean radius, with no enlargement for the atmosphere (published predictions enlarge the shadow slightly, so their magnitudes and contact times differ a little). ${EPHEM_METHOD}.`,
      rank: (kind === 'total' ? 60 : kind === 'partial' ? 40 : 10) + (tot ? Math.min(10, (tot.b - tot.a) / 600) : 0),
      views,
      data: { umbral, penumbral },
    });
  }
  return out;
}

// ---- Jupiter's Galilean moons (as seen from the Earth) ----------------------------------------------------------

export const GALILEANS: Record<number, string> = { 501: 'Io', 502: 'Europa', 503: 'Ganymede', 504: 'Callisto' };

interface Interval { start: number; end: number; mid: number }

/** Framing (not physics): shadows seen from this many Jupiter radii (inside the Galilean orbits, so no moon
 *  comes between); a moon's own transit, occultation or eclipse from this multiple of its distance (so it is in view). */
export const JOVIAN_VIEW = { shadowRadii: 4.2, moonDistances: 1.5 };

/** From the Earth's direction: close for shadows on the disk, beyond the moon for the moon's own phenomena. */
function jovianView(g: Geometry, subtype: string, m: number, t: number): EventView {
  const E = g.pos(EARTH, t), J = g.pos(JUPITER, t);
  const shadow = subtype.includes('shadow');
  const d = shadow ? JOVIAN_VIEW.shadowRadii * g.radius(JUPITER)[0] : JOVIAN_VIEW.moonDistances * len(sub(g.pos(m, t), J));
  return { label: shadow ? 'Jupiter\'s disk from the Earth\'s direction, close' : `Jupiter and ${GALILEANS[m]} from the Earth's direction`, target: JUPITER, rel: mul(unit(sub(E, J)), d) };
}

export function jovianEvents(g: Geometry, onProgress?: (f: number) => void): SkyEvent[] {
  const w = g.inp.window;
  const out: SkyEvent[] = [];
  const shadowIntervals = new Map<number, Interval[]>();
  const moons = Object.keys(GALILEANS).map(Number).filter((m) => Number.isFinite(g.pos(m, 0.5 * (w.startEt + w.endEt))[0]));
  const step = 1800;
  let k = 0;
  for (const m of moons) {
    const name = GALILEANS[m];
    // Line of sight from the Earth's centre to the moon against Jupiter's ellipsoid (observed time t).
    const sight = (t: number) => {
      const E = g.pos(EARTH, t);
      const J = g.apparent(JUPITER, E, t), Mo = g.apparent(m, E, t);
      const d = unit(sub(Mo.p, E));
      const r = g.pierce(JUPITER, J.p, J.emit, E, d);
      const front = dot(sub(Mo.p, E), d) < dot(sub(J.p, E), d);
      return { rho: r.rho, front };
    };
    // Sunlight past the moon onto Jupiter (Jupiter-local time te): the shadow falls on the disk.
    const shadowOnJ = (te: number) => {
      const J = g.pos(JUPITER, te);
      let Mo = g.pos(m, te);
      const tm = te - len(sub(Mo, J)) / C_KM_S;
      Mo = g.pos(m, tm);
      let S = g.pos(SUN, tm);
      S = g.pos(SUN, tm - len(sub(Mo, S)) / C_KM_S);
      const d = unit(sub(Mo, S));
      const r = g.pierce(JUPITER, J, te, S, d);
      return { rho: r.rho, moonFirst: len(sub(Mo, S)) < dot(sub(J, S), d) };
    };
    // Sunlight past Jupiter onto the moon (moon-local time tm): the moon is eclipsed.
    const moonInShadow = (tm: number) => {
      const Mo = g.pos(m, tm);
      let J = g.pos(JUPITER, tm);
      const tJ = tm - len(sub(Mo, J)) / C_KM_S;
      J = g.pos(JUPITER, tJ);
      let S = g.pos(SUN, tJ);
      S = g.pos(SUN, tJ - len(sub(J, S)) / C_KM_S);
      const d = unit(sub(Mo, S));
      const r = g.pierce(JUPITER, J, tJ, S, d);
      return { rho: r.rho, jupiterFirst: dot(sub(J, S), d) < len(sub(Mo, S)) };
    };
    const toEarthTime = (tLocal: number, id: number) => {
      let t = tLocal;
      for (let i = 0; i < 3; i++) t = tLocal + len(sub(g.pos(id, tLocal), g.pos(EARTH, t))) / C_KM_S;
      return t;
    };
    const push = (subtype: string, iv: Interval, titleX: string, detail: string, local?: (t: number) => number) => {
      const map = local ?? ((t: number) => t);
      const start = map(iv.start), end = map(iv.end), mid = map(iv.mid);
      const E = g.pos(EARTH, mid), J = g.pos(JUPITER, mid);
      const elong = angle(sub(J, E), sub(g.pos(SUN, mid), E)) / DEG;
      out.push({
        id: `jovian:${subtype}:${m}:${Math.round(mid)}`,
        kind: 'jovian',
        subtype,
        et: mid,
        startEt: start,
        endEt: end,
        title: titleX,
        detail: `${detail}; ${fmtDuration(end - start)}${elong < 15 ? `; Jupiter only ${elong.toFixed(0)}° from the Sun` : ''}`,
        bodies: [SUN, EARTH, JUPITER, m],
        orientations: [JUPITER],
        observer: 'the Earth',
        method: `Contacts of the moon's centre with Jupiter's limb (seen from the Earth's centre) or with the edge of the shadow (sunlight grazing the ellipsoid), Jupiter's shape from its measured radii and IAU orientation; times as observed at the Earth. ${EPHEM_METHOD}.`,
        rank: 5,
        views: [jovianView(g, subtype, m, mid)],
        data: { moon: m, elongationDeg: elong },
      });
    };
    for (const iv of negativeIntervals((t) => sight(t).rho - 1, w.startEt, w.endEt, step)) {
      const front = sight(iv.min.t).front;
      push(front ? 'transit' : 'occultation', { start: iv.start, end: iv.end, mid: iv.min.t },
        front ? `${name} transits Jupiter` : `${name} occulted by Jupiter`,
        front ? `${name} crosses in front of Jupiter's disk` : `${name} passes behind Jupiter`);
    }
    onProgress?.((k + 0.5) / moons.length);
    const shadows: Interval[] = [];
    for (const iv of negativeIntervals((te) => shadowOnJ(te).rho - 1, w.startEt, w.endEt, step)) {
      const s = shadowOnJ(iv.min.t);
      if (s.moonFirst) {
        const map = (t: number) => toEarthTime(t, JUPITER);
        push('shadow-transit', { start: iv.start, end: iv.end, mid: iv.min.t }, `${name}'s shadow on Jupiter`, `${name}'s shadow crosses Jupiter's disk`, map);
        shadows.push({ start: map(iv.start), end: map(iv.end), mid: map(iv.min.t) });
      }
    }
    shadowIntervals.set(m, shadows);
    for (const iv of negativeIntervals((tm) => moonInShadow(tm).rho - 1, w.startEt, w.endEt, step)) {
      if (moonInShadow(iv.min.t).jupiterFirst)
        push('eclipse', { start: iv.start, end: iv.end, mid: iv.min.t }, `${name} eclipsed by Jupiter`, `${name} passes through Jupiter's shadow`, (t) => toEarthTime(t, m));
    }
    onProgress?.(++k / moons.length);
  }
  // Two or more shadows on the disk at once (rare, striking).
  const all = [...shadowIntervals.entries()].flatMap(([m, l]) => l.map((iv) => ({ m, ...iv })));
  all.sort((a, b) => a.start - b.start);
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length && all[j].start < all[i].end; j++) {
      if (all[j].m === all[i].m) continue;
      const start = Math.max(all[i].start, all[j].start), end = Math.min(all[i].end, all[j].end);
      if (end <= start) continue;
      const third = all.find((x) => x.m !== all[i].m && x.m !== all[j].m && x.start < end && x.end > start);
      const ids = [all[i].m, all[j].m, ...(third ? [third.m] : [])].sort();
      const s2 = third ? Math.max(start, third.start) : start, e2 = third ? Math.min(end, third.end) : end;
      const mid = 0.5 * (s2 + e2);
      const id = `jovian:${third ? 'triple' : 'double'}-shadow:${ids.join('-')}:${Math.round(mid)}`;
      const elong = angle(sub(g.pos(JUPITER, mid), g.pos(EARTH, mid)), sub(g.pos(SUN, mid), g.pos(EARTH, mid))) / DEG;
      if (out.some((e) => e.id === id)) continue;
      out.push({
        id,
        kind: 'jovian',
        subtype: third ? 'triple-shadow' : 'double-shadow',
        et: mid,
        startEt: s2,
        endEt: e2,
        title: `${third ? 'Triple' : 'Double'} shadow transit on Jupiter`,
        detail: `shadows of ${ids.map((x) => GALILEANS[x]).join(', ')} on the disk together for ${fmtDuration(e2 - s2)}${elong < 15 ? `; Jupiter only ${elong.toFixed(0)}° from the Sun` : ''}`,
        bodies: [SUN, EARTH, JUPITER, ...ids],
        orientations: [JUPITER],
        observer: 'the Earth',
        method: `Overlap of the individual shadow transits (times as observed at the Earth). ${EPHEM_METHOD}.`,
        rank: (third ? 90 : 45) + Math.min(20, (e2 - s2) / 540) - (elong < 15 ? 30 : 0),
        views: [jovianView(g, 'shadow', ids[0], mid)],
        data: { elongationDeg: elong, overlapS: e2 - s2 },
      });
    }
  }
  return out;
}

// ---- Saturn's ring plane ----------------------------------------------------------------------------------------

export function ringPlaneEvents(g: Geometry): SkyEvent[] {
  const w = g.inp.window;
  const pole = (t: number): Vec3 | null => {
    const R = g.inp.orientation(SATURN, t);
    return R ? [R[2], R[5], R[8]] : null;
  };
  if (!pole(w.startEt)) return [];
  // Saturnicentric latitude of the Earth (apparent) and of the Sun (sunlight arriving now).
  const earthB = (t: number) => {
    const E = g.pos(EARTH, t), S = g.apparent(SATURN, E, t);
    return Math.asin(dot(pole(S.emit)!, unit(sub(E, S.p))));
  };
  const sunB = (t: number) => {
    const Sa = g.pos(SATURN, t);
    const Su = g.apparent(SUN, Sa, t);
    return Math.asin(dot(pole(t)!, unit(sub(Su.p, Sa))));
  };
  const out: SkyEvent[] = [];
  const make = (subtype: string, t: number, title: string, detail: string, rank: number, extra: Record<string, number> = {}): SkyEvent => {
    const Sa = g.pos(SATURN, t), Su = g.pos(SUN, t);
    const n = pole(t)!;
    const inPlane = unit(sub(sub(Su, Sa), mul(n, dot(sub(Su, Sa), n))));
    const dir = unit(add(mul(inPlane, Math.cos(15 * DEG)), mul(n, Math.sin(15 * DEG))));
    return {
      id: `ring-plane:${subtype}:${Math.round(t)}`,
      kind: 'ring-plane',
      subtype,
      et: t,
      title,
      detail,
      bodies: [SUN, EARTH, SATURN],
      orientations: [SATURN],
      observer: subtype.startsWith('sun') ? 'Saturn' : 'the Earth',
      method: `Saturnicentric latitude of the Earth (light-time corrected) or of the Sun against Saturn's ring plane (its equator, IAU pole); crossings by bisection, closest approaches by golden-section search. ${EPHEM_METHOD}.`,
      rank,
      views: [
        { label: 'Saturn from 15° above the ring plane, sunward', target: SATURN, rel: mul(dir, 420000) },
        { label: 'Saturn from the Earth\'s direction', target: SATURN, rel: mul(unit(sub(g.pos(EARTH, t), Sa)), 420000) },
      ],
      data: extra,
    };
  };
  const day = 86400;
  const e = scan(earthB, w.startEt, w.endEt, day);
  const s = scan(sunB, w.startEt, w.endEt, day);
  for (let i = 0; i < s.v.length - 1; i++) {
    if ((s.v[i] < 0) !== (s.v[i + 1] < 0)) {
      const t = bisect(sunB, s.t[i], s.t[i + 1], 1);
      out.push(make('sun-crossing', t, 'Equinox at Saturn: the Sun crosses the ring plane', 'the rings are lit edge-on; their lit face changes', 85, { earthBDeg: earthB(t) / DEG }));
    }
  }
  for (let i = 0; i < e.v.length - 1; i++) {
    if ((e.v[i] < 0) !== (e.v[i + 1] < 0)) {
      const t = bisect(earthB, e.t[i], e.t[i + 1], 1);
      out.push(make('earth-crossing', t, 'The Earth crosses Saturn\'s ring plane', 'the rings are seen edge-on from the Earth', 75, { sunBDeg: sunB(t) / DEG }));
    }
  }
  for (const m of minima((t) => Math.abs(earthB(t)), w.startEt, w.endEt, day, 3 * DEG)) {
    if (m.v < 1e-6) continue; // a crossing, reported above
    out.push(make('earth-closest', m.t, 'The Earth closest to Saturn\'s ring plane', `the rings open by only ${(m.v / DEG).toFixed(2)}° as seen from the Earth`, 40, { earthBDeg: m.v / DEG }));
  }
  return out;
}

// ---- planets as seen from the Earth --------------------------------------------------------------------------------

export const PLANETS: Record<number, string> = { 199: 'Mercury', 299: 'Venus', 499: 'Mars', 599: 'Jupiter', 699: 'Saturn', 799: 'Uranus', 899: 'Neptune', 999: 'Pluto' };

export function planetEvents(g: Geometry): SkyEvent[] {
  const w = g.inp.window;
  const out: SkyEvent[] = [];
  const day = 86400;
  // Ecliptic north: the direction of the Earth–Moon barycentre's orbital angular momentum (from the ephemeris).
  const tm = 0.5 * (w.startEt + w.endEt);
  const r0 = sub(g.pos(EMB, tm), g.pos(SUN, tm)), r1 = sub(g.pos(EMB, tm + 3600), g.pos(SUN, tm + 3600));
  const north = unit(cross(r0, sub(r1, r0)));
  const view = (id: number, t: number): EventView => {
    const E = g.pos(EARTH, t), P = g.pos(id, t);
    return { label: `${PLANETS[id]} from the Earth's direction`, target: id, rel: mul(unit(sub(E, P)), 8 * g.radius(id)[0] / Math.sin(8 * DEG)) };
  };
  for (const [idS, name] of Object.entries(PLANETS)) {
    const id = Number(idS);
    if (!Number.isFinite(g.pos(id, tm)[0])) continue;
    const elong = (t: number) => {
      const E = g.pos(EARTH, t);
      return angle(sub(g.apparent(SUN, E, t).p, E), sub(g.apparent(id, E, t).p, E));
    };
    const inner = id === 199 || id === 299;
    const base = (subtype: string, t: number, title: string, detail: string, rank: number, kind: EventKind): SkyEvent => ({
      id: `${kind}:${subtype}:${id}:${Math.round(t)}`,
      kind,
      subtype,
      et: t,
      title,
      detail,
      bodies: [SUN, EARTH, id],
      observer: 'the Earth',
      method: `Extrema of the angle between the planet and the Sun as seen from the Earth's centre (light-time corrected); conventional oppositions and conjunctions use ecliptic longitude and can differ by hours. ${EPHEM_METHOD}.`,
      rank,
      views: [view(id, t)],
      data: { elongationDeg: elong(t) / DEG, distanceAu: len(sub(g.pos(id, t), g.pos(EARTH, t))) / AU_KM },
    });
    for (const m of minima((t) => -elong(t), w.startEt, w.endEt, day)) {
      const t = m.t, deg = -m.v / DEG;
      const E = g.pos(EARTH, t);
      const distKm = len(sub(g.pos(id, t), E));
      if (inner) {
        const east = dot(cross(sub(g.pos(SUN, t), E), sub(g.pos(id, t), E)), north) > 0;
        out.push(base(east ? 'east' : 'west', t, `${name} at greatest ${east ? 'eastern (evening)' : 'western (morning)'} elongation`, `${deg.toFixed(1)}° from the Sun`, 20, 'elongation'));
      } else {
        out.push(base('opposition', t, `${name} at opposition`, `${deg.toFixed(1)}° from the Sun, ${(distKm / AU_KM).toFixed(3)} au from the Earth`, id === 499 ? 50 : 25, 'opposition'));
      }
    }
    for (const m of minima(elong, w.startEt, w.endEt, day)) {
      const t = m.t, deg = m.v / DEG;
      const E = g.pos(EARTH, t);
      const nearer = len(sub(g.pos(id, t), E)) < len(sub(g.pos(SUN, t), E));
      const sub_ = inner ? (nearer ? 'inferior' : 'superior') : 'solar';
      const solarRadius = Math.asin(g.meanRadius(SUN) / len(sub(g.pos(SUN, t), E))) / DEG;
      const transit = inner && nearer && deg < solarRadius;
      out.push(base(transit ? 'transit' : sub_, t, transit ? `Transit of ${name} across the Sun` : `${name} at ${sub_} conjunction`, `${deg.toFixed(2)}° from the Sun's centre`, transit ? 95 : 10, 'conjunction'));
    }
  }
  // Pairs of bright planets close together in the sky.
  const bright = [199, 299, 499, 599, 699];
  for (let i = 0; i < bright.length; i++) {
    for (let j = i + 1; j < bright.length; j++) {
      const a = bright[i], b = bright[j];
      const sep = (t: number) => {
        const E = g.pos(EARTH, t);
        return angle(sub(g.apparent(a, E, t).p, E), sub(g.apparent(b, E, t).p, E));
      };
      for (const m of minima(sep, w.startEt, w.endEt, day, 2 * DEG)) {
        const E = g.pos(EARTH, m.t);
        const sun = angle(sub(g.pos(a, m.t), E), sub(g.pos(SUN, m.t), E)) / DEG;
        const P = g.pos(a, m.t);
        out.push({
          id: `planet-pair:${a}-${b}:${Math.round(m.t)}`,
          kind: 'planet-pair',
          subtype: `${a}-${b}`,
          et: m.t,
          title: `${PLANETS[a]} and ${PLANETS[b]} together in the sky`,
          detail: `${(m.v / DEG).toFixed(2)}° apart as seen from the Earth; ${sun.toFixed(0)}° from the Sun`,
          bodies: [EARTH, a, b, SUN],
          observer: 'the Earth',
          method: `Minimum of the angle between the two planets as seen from the Earth's centre (light-time corrected). ${EPHEM_METHOD}.`,
          rank: 15 + Math.max(0, 20 - (m.v / DEG) * 10) - (sun < 15 ? 20 : 0),
          // Close to the Sun its glare hides the pair: the view covers the Sun (a viewing aid, badged).
          views: [{
            label: sun < PAIR_SHIELD_SUN_DEG ? 'From just outside the Earth, the Sun covered' : 'From just outside the Earth, looking at the pair',
            // A fixed viewpoint on the Earth–pair line, the Earth behind the camera, looking at the first planet.
            target: EARTH,
            rel: mul(unit(sub(P, E)), PAIR_VIEW_KM),
            lookAt: a,
            fovDeg: 10,
            ...(sun < PAIR_SHIELD_SUN_DEG
              ? { sunShield: true, note: `The Earth is behind the camera; the pair is ahead, ${sun.toFixed(0)}° from the Sun, which the Sun shield covers (a viewing aid, badged): without it the Sun's glare hides them.` }
              : { note: 'The Earth is behind the camera; the pair is ahead.' }),
          }],
          data: { separationDeg: m.v / DEG, sunDeg: sun },
        });
      }
    }
  }
  return out;
}

/** Pairs closer to the Sun than this are shown with the Sun shield (framing: the glare of the Sun), degrees. */
export const PAIR_SHIELD_SUN_DEG = 15;
/** Pair views: the camera this far from the Earth's centre, towards the pair (framing), km. */
export const PAIR_VIEW_KM = 30000;

// ---- Pluto and Charon -------------------------------------------------------------------------------------------

export function plutoCharon(g: Geometry): SkyEvent[] {
  const w = g.inp.window;
  if (!Number.isFinite(g.pos(CHARON, 0.5 * (w.startEt + w.endEt))[0])) return [];
  const RP = g.meanRadius(PLUTO), RC = g.meanRadius(CHARON);
  // Sky-plane distance between the centres as seen from the Earth, minus the sum of the radii (< 0: overlapping disks).
  const gap = (t: number) => {
    const E = g.pos(EARTH, t);
    const P = g.apparent(PLUTO, E, t).p, C = g.apparent(CHARON, E, t).p;
    const s = unit(sub(P, E));
    const d = sub(C, P);
    return len(sub(d, mul(s, dot(d, s)))) - (RP + RC);
  };
  const m = minima(gap, w.startEt, w.endEt, 3 * 3600);
  const best = m.reduce((a, b) => (b.v < a.v ? b : a), { t: w.startEt, v: Infinity });
  const events = m.filter((x) => x.v < 0);
  const P = g.pos(PLUTO, best.t), C = g.pos(CHARON, best.t), E = g.pos(EARTH, best.t);
  const n = unit(cross(sub(C, P), sub(E, P)));
  const base = {
    kind: 'mutual' as const,
    bodies: [EARTH, PLUTO, CHARON],
    observer: 'the Earth',
    method: `Distance between Pluto's and Charon's centres across the line of sight from the Earth, against the sum of their radii. ${EPHEM_METHOD}.`,
    views: [{ label: 'Pluto and Charon from 50 000 km', target: PLUTO, rel: mul(unit(add(unit(sub(E, P)), n)), 50000) }],
  };
  if (!events.length)
    return [{
      ...base,
      id: `mutual:none:${Math.round(best.t)}`,
      subtype: 'none',
      et: best.t,
      title: 'No Pluto–Charon mutual events in the data window',
      detail: `seen from the Earth their disks come no closer than ${Math.round(best.v).toLocaleString('en-US')} km apart (the orbit is far from edge-on)`,
      rank: 5,
      data: { closestGapKm: best.v },
    }];
  return events.map((x) => ({ ...base, id: `mutual:overlap:${Math.round(x.t)}`, subtype: 'overlap', et: x.t, title: 'Pluto–Charon mutual event', detail: `disks overlap by ${Math.round(-x.v)} km`, rank: 60 }));
}

// ---- all ----------------------------------------------------------------------------------------------------------

export type EventCategory = 'eclipses' | 'jovian' | 'saturn' | 'planets' | 'pluto';

export function findEvents(inp: FinderInput, category: EventCategory, onProgress?: (f: number) => void): SkyEvent[] {
  const g = new Geometry(inp);
  switch (category) {
    case 'eclipses':
      return [...solarEclipses(g), ...lunarEclipses(g)];
    case 'jovian':
      return jovianEvents(g, onProgress);
    case 'saturn':
      return ringPlaneEvents(g);
    case 'planets':
      return planetEvents(g);
    case 'pluto':
      return plutoCharon(g);
  }
}

// ---- formatting (no physical values) -------------------------------------------------------------------------------

function fmtLat(d: number): string {
  return `${Math.abs(d).toFixed(1)}°${d >= 0 ? 'N' : 'S'}`;
}
function fmtLon(d: number): string {
  return `${Math.abs(d).toFixed(1)}°${d >= 0 ? 'E' : 'W'}`;
}
export function fmtDuration(s: number): string {
  if (!Number.isFinite(s)) return 'unknown';
  if (s < 90) return `${s.toFixed(0)} s`;
  if (s < 5400) return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}
