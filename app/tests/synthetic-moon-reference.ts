// TEST UTILITY ONLY. Planet-system-barycentric ICRF, km/s; time in TDB s past J2000.
// Newtonian restricted Sun + host problem. Sun acceleration is DIFFERENTIAL:
// GM_sun [(R-r)/|R-r|^3 - R/|R|^3], where R = Sun - host barycentre.
// This does not know an individual synthetic moon's true position. Initial state and all physical
// numbers must be supplied from labelled products. RK4 here is independent of the production SABA map.
import type { PlanetPositions } from '../src/core/smallbody';
import type { Vec3 } from '../src/core/vec';

export interface MoonReferenceModel {
  centerId: number;
  centerGm: number;
  sunId: number;
  sunGm: number;
  window: { startEt: number; endEt: number };
}

export function solarDifferential(r: readonly number[], sunRelative: readonly number[], gm: number): Vec3 {
  const d = r.map((x, k) => sunRelative[k] - x);
  const d3 = Math.hypot(...d) ** 3, R3 = Math.hypot(...sunRelative) ** 3;
  return [0, 1, 2].map(k => gm * (d[k] / d3 - sunRelative[k] / R3)) as Vec3;
}

export function moonReferenceAcceleration(r: readonly number[], et: number, model: MoonReferenceModel, eph: PlanetPositions): Vec3 {
  if (et < model.window.startEt || et > model.window.endEt) throw new Error('moon reference: outside coverage');
  const host = eph.positionSSB(model.centerId, et), sun = eph.positionSSB(model.sunId, et);
  if (!host || !sun) throw new Error('moon reference: missing ephemeris');
  const R = sun.map((x, k) => x - host[k]);
  const a = solarDifferential(r, R, model.sunGm), r3 = Math.hypot(...r) ** 3;
  return a.map((x, k) => x - model.centerGm * r[k] / r3) as Vec3;
}

/** Signed fixed steps, exact last partial step. hMax is a NUMERICAL test control, not an orbital constant. */
export function integrateMoonReference(initial: ArrayLike<number>, t0: number, t1: number, model: MoonReferenceModel, eph: PlanetPositions, hMax: number): Float64Array {
  if (!(hMax > 0 && Number.isFinite(hMax)) || initial.length !== 6 || !Array.from(initial).every(Number.isFinite)) throw new Error('moon reference: invalid input');
  if (![t0, t1].every(t => Number.isFinite(t) && t >= model.window.startEt && t <= model.window.endEt)) throw new Error('moon reference: outside coverage');
  let state = Float64Array.from(initial), t = t0;
  const deriv = (y: Float64Array, et: number): Float64Array => new Float64Array([...y.slice(3), ...moonReferenceAcceleration(Array.from(y.slice(0, 3)), et, model, eph)]);
  while (t !== t1) {
    const te = t + Math.sign(t1 - t) * Math.min(hMax, Math.abs(t1 - t));
    if (te === t) throw new Error('moon reference: step cannot advance time');
    const h = te - t, k1 = deriv(state, t);
    const stage = (k: Float64Array, f: number) => state.map((x, j) => x + f * h * k[j]);
    const k2 = deriv(stage(k1, 0.5), t + h / 2), k3 = deriv(stage(k2, 0.5), t + h / 2), k4 = deriv(stage(k3, 1), te);
    state = state.map((x, j) => x + h / 6 * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]));
    t = te;
  }
  return state;
}
