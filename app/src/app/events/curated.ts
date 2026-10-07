// Curated views: a short list of striking real configurations inside the data window. Most come from the event
// finder (the eclipse of the window, Saturn's equinox, a long double shadow transit on Jupiter, …); a few are
// placed here from the ephemerides at a time near the current one (the Earth over the lunar horizon, Jupiter with
// its four large moons, Pluto with Charon). Nothing here is a physical value: camera framings only.

import { SECONDS_PER_DAY } from '../../core/constants';

import type { Vec3 } from '../ports';
import { Geometry, minima, type EventView, type FinderInput, type SkyEvent } from './finder';

export interface Bookmark {
  id: string;
  title: string;
  detail: string;
  et: number;
  view: EventView;
  /** The event shown, when the bookmark comes from the finder. */
  event?: SkyEvent;
  /** Bodies the placement rests on (provenance). */
  bodies: number[];
  method: string;
}

const SUN = 10, EARTH = 399, MOON = 301, JUPITER = 599, PLUTO = 999, CHARON = 901;
const DAY = SECONDS_PER_DAY;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => mul(a, 1 / len(a));
const angle = (a: Vec3, b: Vec3): number => Math.atan2(len(cross(a, b)), dot(a, b));
const DEG = Math.PI / 180;

/** Framing choices (not physics). */
export const CURATED_TUNING = {
  /** Lunar-orbit camera altitude, km, and how far the Earth stands above the lunar horizon, degrees. */
  lunarOrbitAltKm: 100,
  earthAboveHorizonDeg: 4,
  lunarOrbitFovDeg: 24,
  /** Jupiter framing: the outermost Galilean moon at this fraction of the half field of view. */
  jupiterFill: 0.8,
  fovDeg: 50,
  /** Pluto framing: camera distance in Pluto–Charon separations. */
  plutoSeparations: 3,
};

/** The event with the best rank (ties: nearest to `nowEt`, future first). */
function best(events: SkyEvent[], nowEt: number, pred: (e: SkyEvent) => boolean): SkyEvent | null {
  let b: SkyEvent | null = null;
  const score = (e: SkyEvent) => e.rank * 1e3 - Math.abs(e.et - nowEt) / DAY / 1e3 + (e.et >= nowEt ? 1e-3 : 0);
  for (const e of events) if (pred(e) && (!b || score(e) > score(b))) b = e;
  return b;
}

function fromEvent(e: SkyEvent | null, view: number, title: string): Bookmark[] {
  if (!e || !e.views[view]) return [];
  return [{ id: `${e.id}#${view}`, title, detail: e.detail, et: e.views[view].et ?? e.et, view: e.views[view], event: e, bodies: e.bodies, method: e.method }];
}

/** Bookmarks from found events (whatever categories are ready). */
export function eventBookmarks(events: SkyEvent[], nowEt: number): Bookmark[] {
  const solar = best(events, nowEt, (e) => e.kind === 'solar-eclipse' && e.subtype === 'total');
  const lunar = best(events, nowEt, (e) => e.kind === 'lunar-eclipse' && e.subtype === 'total');
  const equinox = best(events, nowEt, (e) => e.kind === 'ring-plane' && e.subtype === 'sun-crossing');
  const edgeOn = best(events, nowEt, (e) => e.kind === 'ring-plane' && e.subtype !== 'sun-crossing');
  const shadows = best(events, nowEt, (e) => e.kind === 'jovian' && e.subtype.endsWith('-shadow'));
  const mars = best(events, nowEt, (e) => e.kind === 'opposition' && e.bodies.includes(499));
  const pair = best(events, nowEt, (e) => e.kind === 'planet-pair' && Number(e.data?.sunDeg) > 20);
  // Where the Sun shield earns its keep: two planets a few degrees from the Sun.
  const byTheSun = best(events, nowEt, (e) => e.kind === 'planet-pair' && Number(e.data?.sunDeg) < 10 && !!e.views[0]?.sunShield);
  const neo = events.filter((e) => e.kind === 'neo-approach' && e.subtype === 'earth').sort((a, b) => Number(a.data?.distKm) - Number(b.data?.distKm))[0] ?? null;
  return [
    ...fromEvent(solar, 0, 'Total solar eclipse: the Moon\'s shadow on the Earth'),
    ...fromEvent(solar, 1, 'Total solar eclipse: the Moon covering the Sun, over the point of greatest eclipse'),
    ...fromEvent(lunar, 0, 'Total lunar eclipse: the Earth in front of the Sun, from the Moon'),
    ...fromEvent(equinox, 0, 'Saturn at equinox: the rings edge-on to the Sun'),
    ...fromEvent(edgeOn, 1, 'Saturn\'s rings nearly edge-on from the Earth'),
    ...fromEvent(shadows, 0, `${shadows?.subtype === 'triple-shadow' ? 'Three' : 'Two'} moon shadows on Jupiter at once`),
    ...fromEvent(mars, 0, 'Mars at opposition'),
    ...fromEvent(pair, 0, pair?.title ?? ''),
    ...fromEvent(byTheSun, 0, byTheSun ? `${byTheSun.title.replace(' together in the sky', '')} beside the covered Sun` : ''),
    ...fromEvent(neo, 0, 'The closest pass of a near-Earth asteroid in the window'),
  ];
}

/** Bookmarks placed from the ephemerides near `nowEt` (inside the window). */
export function staticBookmarks(inp: FinderInput, nowEt: number): Bookmark[] {
  const g = new Geometry(inp);
  const w = inp.window;
  const t0 = Math.min(Math.max(nowEt, w.startEt), w.endEt);
  const out: Bookmark[] = [];
  const ok = (id: number, t: number) => Number.isFinite(g.pos(id, t)[0]);
  const T = CURATED_TUNING;

  // The Earth over the lunar horizon, from lunar orbit, when the Earth is half lit as seen from the Moon.
  if (ok(EARTH, t0) && ok(MOON, t0) && inp.radii.has(MOON)) {
    const f = (t: number) => {
      const M = g.pos(MOON, t);
      return Math.abs(angle(sub(g.pos(EARTH, t), M), sub(g.pos(SUN, t), M)) - Math.PI / 2);
    };
    const a = Math.max(w.startEt, t0 - 20 * DAY), b = Math.min(w.endEt, t0 + 20 * DAY);
    const q = minima(f, a, b, DAY / 4).filter((m) => m.v < 0.01).sort((x, y) => Math.abs(x.t - t0) - Math.abs(y.t - t0))[0];
    if (q) {
      const M = g.pos(MOON, q.t), E = g.pos(EARTH, q.t), S = g.pos(SUN, q.t);
      const e = unit(sub(E, M));
      const s = unit(sub(sub(S, M), mul(e, dot(sub(S, M), e))));
      const RM = g.meanRadius(MOON);
      const r = RM + T.lunarOrbitAltKm;
      const dip = Math.acos(RM / r);
      const th = Math.PI / 2 + dip - T.earthAboveHorizonDeg * DEG;
      const n = add(mul(e, Math.cos(th)), mul(s, Math.sin(th)));
      out.push({
        id: 'static:earthrise',
        title: 'The Earth over the Moon\'s horizon, from lunar orbit',
        detail: `${T.lunarOrbitAltKm} km above the Moon on its sunlit side, when the Earth is half lit as seen from the Moon (nearest such time to now)`,
        et: q.t,
        view: { label: 'From lunar orbit', target: MOON, rel: mul(n, r), lookAt: EARTH, up: n, fovDeg: T.lunarOrbitFovDeg, note: 'A fixed viewpoint in lunar orbit; press Space to let time run (the camera stays put relative to the Moon\'s centre).' },
        bodies: [SUN, EARTH, MOON],
        method: 'Time: the nearest instant when the Sun–Moon–Earth angle is 90° (golden-section search on the ephemerides). Camera placed geometrically above the Moon\'s mean-radius sphere.',
      });
    }
  }

  // Jupiter and its four large moons, from the Earth's direction, now.
  const gal = [501, 502, 503, 504];
  if (ok(JUPITER, t0) && gal.every((m) => ok(m, t0))) {
    const J = g.pos(JUPITER, t0), E = g.pos(EARTH, t0);
    const far = Math.max(...gal.map((m) => len(sub(g.pos(m, t0), J))));
    const d = far / Math.tan(T.jupiterFill * (T.fovDeg / 2) * DEG);
    out.push({
      id: 'static:jupiter',
      title: 'Jupiter with Io, Europa, Ganymede and Callisto',
      detail: 'now, from the direction of the Earth, close enough to see the four moons around the planet',
      et: t0,
      view: { label: 'Jupiter system', target: JUPITER, rel: mul(unit(sub(E, J)), d) },
      bodies: [SUN, EARTH, JUPITER, ...gal],
      method: 'Camera on the Jupiter–Earth line, far enough to frame the outermost of the four moons.',
    });
  }

  // Pluto and Charon, from above Charon's orbit on the sunlit side, now.
  if (ok(PLUTO, t0) && ok(CHARON, t0)) {
    const P = g.pos(PLUTO, t0), C = g.pos(CHARON, t0), S = g.pos(SUN, t0);
    const C2 = g.pos(CHARON, t0 + 3600), P2 = g.pos(PLUTO, t0 + 3600);
    let nrm = unit(cross(sub(C, P), sub(sub(C2, P2), sub(C, P))));
    const toSun = unit(sub(S, P));
    if (dot(nrm, toSun) < 0) nrm = mul(nrm, -1);
    out.push({
      id: 'static:pluto',
      title: 'Pluto and Charon',
      detail: 'now, from above Charon\'s orbit on the sunlit side',
      et: t0,
      view: { label: 'Pluto and Charon', target: PLUTO, rel: mul(unit(add(nrm, toSun)), T.plutoSeparations * len(sub(C, P))) },
      bodies: [SUN, PLUTO, CHARON],
      method: 'Camera between the pole of Charon\'s orbit (from the ephemeris) and the Sun direction, a few separations away.',
    });
  }
  return out;
}
