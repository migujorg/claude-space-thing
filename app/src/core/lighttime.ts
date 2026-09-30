// Light-time correction (docs/architecture.md §3.4, NORTH_STAR 3.4): an object is seen where it was when the
// light now arriving at the observer left it. Newtonian, iterated to convergence (SPICE 'CN'; after the first
// step this is SPICE 'LT'). The observer is at rest in the SSB frame: no stellar aberration.

import { C_KM_S } from './constants';
import type { Vec3 } from './vec';

export interface ApparentPosition {
  /** Target at emitEt minus observer at et, km, ICRF. */
  rel: Vec3;
  /** One-way light time, s: |rel| / c (to < 1 ns). */
  lightTime: number;
  /** Emission epoch, TDB s past J2000: et − lightTime. */
  emitEt: number;
}

const MAX_ITER = 10;
const TOL_S = 1e-9;

export function apparentPosition(
  eph: { positionSSB(id: number, et: number): Vec3 | null },
  id: number,
  observerSSB: Vec3,
  et: number,
): ApparentPosition | null {
  const p0 = eph.positionSSB(id, et);
  if (!p0) return null;
  let lt = Math.hypot(p0[0] - observerSSB[0], p0[1] - observerSSB[1], p0[2] - observerSSB[2]) / C_KM_S;
  for (let i = 0; i < MAX_ITER; i++) {
    const p = eph.positionSSB(id, et - lt);
    if (!p) return null;
    const rel: Vec3 = [p[0] - observerSSB[0], p[1] - observerSSB[1], p[2] - observerSSB[2]];
    const next = Math.hypot(rel[0], rel[1], rel[2]) / C_KM_S;
    if (Math.abs(next - lt) < TOL_S) {
      // rel was evaluated at et − lt, so report that epoch; |rel|/c differs from lt by < TOL_S.
      return { rel, lightTime: lt, emitEt: et - lt };
    }
    lt = next;
  }
  // Newtonian light time contracts by a factor ~v/c per step; not converging means non-physical input.
  return null;
}
