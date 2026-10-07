// URL parameters for reproducible views:
//   ?t=<ISO UTC>&target=<NAIF id>&dist=<km from target center>&az=<deg>&el=<deg>
//    &exists=strict|best|complete&view=eye|enhanced&boost=<stops>&fov=<deg, vertical>
//    &labels=0|1&orbits=0|1&tint=0|1&ui=0|1&system=jup,sat|all&smallbodies=0|1&sbfield=0|1&shield=0|1
//    &adapt=instant|realtime&adaptfrom=<cd/m²>,<exposure s>,<elapsed s>&adapttime=<elapsed s>
// adapt: how the eye adapts over time (default realtime). adaptfrom: a defined eye history for tests and
// demonstrations, e.g. adaptfrom=10000,600,300 = 10 min in daylight, then 5 min looking at this view.
// adapttime: with realtime adaptation and adaptfrom, sample the history at exactly this nonnegative elapsed
// time in the current view (overrides adaptfrom's third value), holding it through loading and readback.
// Omit it for the interactive real-time clock. "Settled" then means light/data convergence at that instant,
// not more elapsed adaptation time. E.g. adapt=realtime&adaptfrom=10000,600,60&adapttime=60.
// target may also be an SBDB SPK-ID (>= 1000000, e.g. 20099942 for 99942 Apophis): a small body, resolved once the
// small-body catalogue and its name index are in. smallbodies=0 skips loading the small-body catalogue.
// `system` names moon systems (ephem/sat-<key>) to load before the first frame instead of in the background;
// "all" loads every one up front. The target's own system is always loaded up front.
// az/el are in the target-centered Sun frame (camera.ts sunFrame): az = el = 0 puts the camera on the
// Sun side of the target. look=<az>,<el> then turns the camera, kept at that place, to look along local azimuth az
// (from the target's north toward east) and elevation el (above the plane perpendicular to the direction from the
// target's centre), e.g. dist=6771&look=0,-17 looks at the horizon from 400 km above a 6371 km Earth. A URL with `t` starts paused at that instant; without `t` the app starts
// at "now", playing in real time.

import { EXISTS_LEVELS, VIEW_MODES, type ExistsLevel, type ViewMode } from './reality';

export interface UrlView {
  /** Unix ms (UTC), parsed from `t`. */
  tMs?: number;
  target?: number;
  dist?: number;
  az?: number;
  el?: number;
  exists?: ExistsLevel;
  view?: ViewMode;
  boost?: number;
  fov?: number;
  labels?: boolean;
  orbits?: boolean;
  tint?: boolean;
  ui?: boolean;
  /** Moon systems to load before the first frame (keys like "jup", or "all"). */
  system?: string[];
  /** false: do not load the small-body catalogue. */
  smallbodies?: boolean;
  /** false: load the catalogue (targets, selection, comets) but do not draw it all as GPU points (no field: a view far
   * from the catalogue epoch then needs no integration of every object; used by the comet regression scene). */
  sbfield?: boolean;
  /** Sun shield (viewing aid): an occulting disc over the Sun (RealityState.sunShield). */
  shield?: boolean;
  /** Eye adaptation over time (RealityState.instantAdaptation). */
  adapt?: 'instant' | 'realtime';
  /** Eye history (RealityState.adaptationHistory). */
  adaptFrom?: { luminanceCdM2: number; exposureS: number; elapsedS: number };
  /** Fixed elapsed seconds in the current view after adaptFrom; holds the eye clock. */
  adaptTimeS?: number;
  /** View direction at the camera's place: local azimuth and elevation (deg), see the header. */
  look?: { azDeg: number; elDeg: number };
}

/** Parse an ISO-8601 UTC time. A missing zone designator means UTC (never local time). */
export function parseIsoUtc(s: string): number | null {
  let str = s.trim();
  if (!str) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) str += 'T00:00:00Z';
  str = str.replace(' ', 'T');
  if (/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(str)) str += 'Z';
  if (!/^[-+]?\d{4,6}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(str)) return null;
  const ms = Date.parse(str);
  return Number.isFinite(ms) ? ms : null;
}

export function parseUrlParams(search: string): { view: UrlView; errors: string[] } {
  const p = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const view: UrlView = {};
  const errors: string[] = [];
  const num = (k: string, ok: (x: number) => boolean = Number.isFinite): number | undefined => {
    const s = p.get(k);
    if (s === null || s === '') return undefined;
    const x = Number(s);
    if (!Number.isFinite(x) || !ok(x)) { errors.push(`Ignoring ${k}=${s}: not a valid number.`); return undefined; }
    return x;
  };
  const bool = (k: string): boolean | undefined => {
    const s = p.get(k);
    if (s === null) return undefined;
    if (s === '1' || s === 'true' || s === '') return true;
    if (s === '0' || s === 'false') return false;
    errors.push(`Ignoring ${k}=${s}: expected 0 or 1.`);
    return undefined;
  };
  const t = p.get('t');
  if (t !== null) {
    const ms = parseIsoUtc(t);
    if (ms === null) errors.push(`Ignoring t=${t}: expected ISO-8601 UTC, e.g. 2026-09-30T12:00:00Z.`);
    else view.tMs = ms;
  }
  view.target = num('target', Number.isInteger);
  view.dist = num('dist', (x) => x > 0);
  view.az = num('az');
  view.el = num('el', (x) => x >= -90 && x <= 90);
  view.boost = num('boost');
  view.fov = num('fov', (x) => x > 0 && x < 180);
  const ex = p.get('exists');
  if (ex !== null) {
    if ((EXISTS_LEVELS as readonly string[]).includes(ex)) view.exists = ex as ExistsLevel;
    else errors.push(`Ignoring exists=${ex}: expected ${EXISTS_LEVELS.join('|')}.`);
  }
  const vw = p.get('view');
  if (vw !== null) {
    if ((VIEW_MODES as readonly string[]).includes(vw)) view.view = vw as ViewMode;
    else errors.push(`Ignoring view=${vw}: expected ${VIEW_MODES.join('|')}.`);
  }
  const sys = p.get('system');
  if (sys !== null) {
    const keys = sys.split(',').map((k) => k.trim().toLowerCase().replace(/^(ephem\/)?sat-/, '')).filter(Boolean);
    if (keys.length && keys.every((k) => /^[a-z0-9]+$/.test(k))) view.system = keys;
    else errors.push(`Ignoring system=${sys}: expected keys like jup,sat or all.`);
  }
  view.labels = bool('labels');
  view.orbits = bool('orbits');
  view.tint = bool('tint');
  view.ui = bool('ui');
  view.smallbodies = bool('smallbodies');
  view.sbfield = bool('sbfield');
  view.shield = bool('shield');
  const ad = p.get('adapt');
  if (ad !== null) {
    if (ad === 'instant' || ad === 'realtime') view.adapt = ad;
    else errors.push(`Ignoring adapt=${ad}: expected instant|realtime.`);
  }
  const af = p.get('adaptfrom');
  if (af !== null) {
    const x = af.split(',').map(Number);
    if (x.length === 3 && x.every((v) => Number.isFinite(v) && v >= 0)) view.adaptFrom = { luminanceCdM2: x[0], exposureS: x[1], elapsedS: x[2] };
    else errors.push(`Ignoring adaptfrom=${af}: expected <cd/m²>,<exposure s>,<elapsed s>.`);
  }
  const at = num('adapttime', (x) => x >= 0);
  if (at !== undefined) {
    if (!view.adaptFrom || view.adapt === 'instant') errors.push('Ignoring adapttime: requires adaptfrom and realtime adaptation.');
    else view.adaptTimeS = at;
  }
  const lk = p.get('look');
  if (lk !== null) {
    const x = lk.split(',').map(Number);
    if (x.length === 2 && x.every(Number.isFinite) && x[1] >= -90 && x[1] <= 90) view.look = { azDeg: x[0], elDeg: x[1] };
    else errors.push(`Ignoring look=${lk}: expected <azimuth deg>,<elevation deg>.`);
  }
  for (const k of Object.keys(view) as (keyof UrlView)[]) if (view[k] === undefined) delete view[k];
  return { view, errors };
}

/** Round-trippable query string (without '?'). */
export function formatUrlParams(v: UrlView): string {
  const p = new URLSearchParams();
  if (v.tMs !== undefined) p.set('t', new Date(v.tMs).toISOString());
  if (v.target !== undefined) p.set('target', String(v.target));
  if (v.dist !== undefined) p.set('dist', sig(v.dist, 7));
  if (v.az !== undefined) p.set('az', v.az.toFixed(2));
  if (v.el !== undefined) p.set('el', v.el.toFixed(2));
  if (v.exists !== undefined) p.set('exists', v.exists);
  if (v.view !== undefined) p.set('view', v.view);
  if (v.boost !== undefined) p.set('boost', String(v.boost));
  if (v.fov !== undefined) p.set('fov', sig(v.fov, 4));
  for (const k of ['labels', 'orbits', 'tint', 'ui', 'smallbodies', 'sbfield', 'shield'] as const) if (v[k] !== undefined) p.set(k, v[k] ? '1' : '0');
  if (v.system?.length) p.set('system', v.system.join(','));
  if (v.adapt !== undefined) p.set('adapt', v.adapt);
  if (v.adaptFrom) p.set('adaptfrom', `${v.adaptFrom.luminanceCdM2},${v.adaptFrom.exposureS},${v.adaptFrom.elapsedS}`);
  if (v.adaptTimeS !== undefined) p.set('adapttime', String(v.adaptTimeS));
  if (v.look) p.set('look', `${v.look.azDeg.toFixed(2)},${v.look.elDeg.toFixed(2)}`);
  // ':' is legal in a query string; keep ISO times readable.
  return p.toString().replace(/%3A/gi, ':');
}

function sig(x: number, n: number): string {
  return String(Number(x.toPrecision(n)));
}
