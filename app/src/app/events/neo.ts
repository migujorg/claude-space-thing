// Close approaches of near-Earth objects to the Earth and the Moon, from the small-body catalogue's orbits
// propagated with the core reference propagator (the same scheme and force model as the pipeline and the GPU
// field) — derived, like every other event. The candidates are the objects the catalogue flags
// `closeApproachInWindow` (JPL CNEOS lists a planetary approach for them inside the window); the flag only chooses
// whom to integrate: distances, times and speeds are computed here.
//
// Method: each object's states on the catalogue's integration grid across the window (sbgrid.gridStates); local
// minima of the sampled distance to the Earth (and to the Moon) that could hide an approach inside the threshold
// (a sample is at most half a grid step from the true minimum: screened with the relative speed there); each
// refined by golden-section search on the distance of the object propagated to the trial time (encounter substeps
// included) from the nearest state already computed, so the refinement costs about one grid step of propagation.

import { SB_OK, type NonGrav, type SmallBodyPropagator } from '../../core/smallbody';
import { gridStates } from '../sbgrid';
import type { Vec3 } from '../ports';
import { goldenMin, type EventView, type SkyEvent } from './finder';

const SUN = 10, EARTH = 399, MOON = 301;
// d[i] may be NaN (object lost): the comparisons below then fail, as intended.

export interface NeoCandidate {
  row: number;
  /** Heliocentric state at the catalogue epoch (km, km/s). */
  state: ArrayLike<number>;
  ng: NonGrav | null;
  /** Absolute magnitude H and its label (for the description), if known. */
  H?: number | null;
}

export interface NeoInput {
  prop: SmallBodyPropagator;
  eph: { positionSSB(id: number, et: number): Vec3 | null };
  epochEt: number;
  /** Grid step of the catalogue (forceModel.grid.baseStepS). */
  H: number;
  window: { startEt: number; endEt: number };
  /** Report approaches closer than this (km). */
  maxKm: number;
  /** Equatorial radius of the Earth (km), from bodies.json, for "Earth radii" in the text. */
  earthRadiusKm: number | null;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];

/** The id the app uses for a small body (smallbodies.ts sbId); repeated here to keep this module worker-light. */
const sbId = (row: number) => -(row + 1);

export function neoApproaches(inp: NeoInput, cands: NeoCandidate[], onProgress?: (done: number, total: number) => void): SkyEvent[] {
  const out: SkyEvent[] = [];
  const { prop, eph, epochEt, H, window } = inp;
  const pos = (id: number, t: number): Vec3 | null => {
    const p = eph.positionSSB(id, t);
    return p ? [p[0], p[1], p[2]] : null;
  };
  const tmp = new Float64Array(6);
  let k = 0;
  for (const c of cands) {
    k++;
    const g = gridStates(prop, c.state, c.ng, epochEt, H, window);
    const n = g.states.length / 6;
    const tOf = (i: number) => epochEt + (g.n0 + i) * H;
    const at = (i: number): Vec3 | null => {
      const x = g.states[6 * i];
      if (!Number.isFinite(x)) return null;
      const s = pos(SUN, tOf(i));
      return s ? [s[0] + x, s[1] + g.states[6 * i + 1], s[2] + g.states[6 * i + 2]] : null;
    };
    // Heliocentric states computed during one refinement (t → state), seeded with the bracketing grid states.
    let known: { t: number; st: Float64Array }[] = [];
    const seedKnown = (i0: number, i1: number) => {
      known = [];
      for (let i = i0; i <= i1; i++) if (Number.isFinite(g.states[6 * i])) known.push({ t: tOf(i), st: g.states.slice(6 * i, 6 * i + 6) });
    };
    // Position (SSB) and heliocentric velocity at t, propagated from the nearest known state.
    const stateAt = (t: number): { p: Vec3; v: Vec3 } | null => {
      let best: { t: number; st: Float64Array } | null = null;
      for (const k of known) if (!best || Math.abs(k.t - t) < Math.abs(best.t - t)) best = k;
      if (!best) return null;
      tmp.set(best.st);
      if (t !== best.t) {
        if (prop.propagateOne(tmp, 0, best.t, t, epochEt, c.ng) !== SB_OK) return null;
        known.push({ t, st: tmp.slice() });
      }
      const s = eph.positionSSB(SUN, t);
      if (!s) return null;
      return { p: [s[0] + tmp[0], s[1] + tmp[1], s[2] + tmp[2]], v: [tmp[3], tmp[4], tmp[5]] };
    };
    const vel = (id: number, t: number): Vec3 | null => {
      const a = pos(id, t - 1), b = pos(id, t + 1);
      return a && b ? mul(sub(b, a), 0.5) : null;
    };
    for (const body of [EARTH, MOON]) {
      const d = new Float64Array(n).fill(NaN);
      for (let i = 0; i < n; i++) {
        const a = at(i), b = pos(body, tOf(i));
        if (a && b) d[i] = len(sub(a, b));
      }
      for (let i = 0; i < n; i++) {
        // Local minima of the samples; at the ends the minimum may lie between the window edge and the first
        // (last) sample, which are up to a grid step apart.
        const lo = i === 0 ? window.startEt : tOf(i - 1), hi = i === n - 1 ? window.endEt : tOf(i + 1);
        if (!(i === 0 || d[i] <= d[i - 1]) || !(i === n - 1 || d[i] < d[i + 1]) || !(d[i] < Infinity) || hi <= lo) continue;
        // The true minimum is within half a grid step of this sample: it can be inside the threshold only if the
        // sample is within sqrt(maxKm² + (v·H/2)²) (straight-line motion; 20 % margin for curvature).
        const sunV = vel(SUN, tOf(i)), bodyV = vel(body, tOf(i));
        if (!sunV || !bodyV) continue;
        const v = len(sub([g.states[6 * i + 3] + sunV[0], g.states[6 * i + 4] + sunV[1], g.states[6 * i + 5] + sunV[2]], bodyV));
        if (d[i] > 1.2 * Math.hypot(inp.maxKm, (v * H) / 2)) continue;
        seedKnown(Math.max(0, i - 1), Math.min(n - 1, i + 1));
        const f = (t: number) => {
          const s = stateAt(t), b = pos(body, t);
          return s && b ? len(sub(s.p, b)) : Infinity;
        };
        const m = goldenMin(f, lo, hi, 1);
        // A minimum at the window edge is an approach outside the window.
        if (!(m.v < inp.maxKm) || m.t < window.startEt + 2 || m.t > window.endEt - 2) continue;
        const s = stateAt(m.t);
        if (!s) continue;
        const Eb = pos(EARTH, m.t)!, Mb = pos(MOON, m.t)!;
        const dE = len(sub(s.p, Eb)), dM = len(sub(s.p, Mb));
        // The Moon only when the object passes nearer to it than to the Earth, and within the Earth–Moon distance
        // (farther passes are passes of the Earth–Moon pair, listed once, for the Earth).
        if (body === MOON && (dM >= dE || dM >= len(sub(Mb, Eb)))) continue;
        // Heliocentric velocity of the object + the Sun's SSB velocity − the body's SSB velocity.
        const sv = vel(SUN, m.t)!, bv = vel(body, m.t)!;
        const vRel = len(sub([s.v[0] + sv[0], s.v[1] + sv[1], s.v[2] + sv[2]], bv));
        out.push(approachEvent(c, body, m.t, m.v, vRel, s.p, body === EARTH ? Eb : Mb, inp.earthRadiusKm));
      }
    }
    onProgress?.(k, cands.length);
  }
  out.sort((a, b) => a.et - b.et);
  return out;
}

function approachEvent(c: NeoCandidate, body: number, t: number, distKm: number, vRel: number, A: Vec3, B: Vec3, earthR: number | null): SkyEvent {
  const toObj = sub(A, B);
  const u = mul(toObj, 1 / len(toObj));
  const where = body === EARTH ? 'the Earth' : 'the Moon';
  const dist = `${Math.round(distKm).toLocaleString('en-US')} km from ${where}'s centre${body === EARTH && earthR ? ` (${(distKm / earthR).toFixed(1)} Earth radii)` : ''}`;
  const views: EventView[] = [
    {
      label: `${body === EARTH ? 'The Earth' : 'The Moon'} from beside the object at closest approach`,
      target: body,
      rel: mul(u, distKm + Math.min(1000, 0.01 * distKm)),
      note: 'The camera is just behind the object, which is the faint point in front of the disk (too small and dark to be seen by eye at most distances).',
    },
    {
      label: `The object from ${where}'s direction (enhanced)`,
      target: sbId(c.row),
      rel: mul(u, -Math.min(distKm * 0.5, 50000)),
      fovDeg: 5,
      enhancedStops: 10,
      note: 'Enhanced view (+10 stops): a near-Earth asteroid is far fainter than the naked-eye limit.',
    },
  ];
  return {
    id: `neo-approach:${body}:${c.row}:${Math.round(t)}`,
    kind: 'neo-approach',
    subtype: body === EARTH ? 'earth' : 'moon',
    et: t,
    title: `Close approach to ${where}`,
    detail: `${dist}; ${vRel.toFixed(2)} km/s relative speed${c.H !== null && c.H !== undefined && Number.isFinite(c.H) ? `; H = ${c.H.toFixed(1)}` : ''}`,
    bodies: [sbId(c.row), body, SUN],
    observer: where,
    method: `Minimum of the geometric distance between the object and ${where}'s centre: the catalogue orbit (JPL SBDB) propagated with the reference propagator (the pipeline's force model, including encounter substeps) and ${where}'s position from the loaded ephemerides; golden-section refinement to 1 s. Listed within the distance the catalogue flagged candidates with (its header)${body === MOON ? ', and for the Moon only when the object passes nearer the Moon than the Earth and within the Earth–Moon distance' : ''}. The catalogue picks the candidates from the CNEOS close-approach list; the numbers here are computed, not copied.`,
    rank: Math.max(0, 60 - 10 * Math.log10(Math.max(1, distKm / 10000))),
    views,
    data: { row: c.row, distKm, vRelKmS: vRel, ...(c.H !== null && c.H !== undefined && Number.isFinite(c.H) ? { H: c.H } : {}) },
  };
}
