// URL parameters for reproducible views:
//   ?t=<ISO UTC>&target=<NAIF id>&dist=<km from target center>&az=<deg>&el=<deg>
//    &exists=strict|best|complete&view=eye|enhanced&boost=<stops>&fov=<deg, vertical>
//    &labels=0|1&orbits=0|1&tint=0|1&ui=0|1&system=jup,sat|all&smallbodies=0|1&shield=0|1
// target may also be an SBDB SPK-ID (>= 1000000, e.g. 20099942 for 99942 Apophis): a small body, resolved once the
// small-body catalogue and its name index are in. smallbodies=0 skips loading the small-body catalogue.
// `system` names moon systems (ephem/sat-<key>) to load before the first frame instead of in the background;
// "all" loads every one up front. The target's own system is always loaded up front.
// az/el are in the target-centered Sun frame (camera.ts sunFrame): az = el = 0 puts the camera on the
// Sun side of the target. A URL with `t` starts paused at that instant; without `t` the app starts
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
  /** Sun shield (viewing aid): an occulting disc over the Sun (RealityState.sunShield). */
  shield?: boolean;
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
  view.shield = bool('shield');
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
  for (const k of ['labels', 'orbits', 'tint', 'ui', 'smallbodies', 'shield'] as const) if (v[k] !== undefined) p.set(k, v[k] ? '1' : '0');
  if (v.system?.length) p.set('system', v.system.join(','));
  // ':' is legal in a query string; keep ISO times readable.
  return p.toString().replace(/%3A/gi, ':');
}

function sig(x: number, n: number): string {
  return String(Number(x.toPrecision(n)));
}
