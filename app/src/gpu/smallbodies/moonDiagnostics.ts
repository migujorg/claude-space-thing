// Device-harness helpers, also exercised without WebGPU. Numerical controls are policies, not data.
import type { PlanetPositions } from '../../core/smallbody';
import type { Vec3 } from '../../core/vec';
import { acuityCyclesPerDeg } from '../../eye/acuity';

export const MOON_EPHEMERIDES = ['de442s', 'sat-plu', 'centers'];
export const MOON_CAMERAS = ['earth', 'planet', 'near', 'close'] as const;
export type MoonCamera = typeof MOON_CAMERAS[number];

export function moonCameraState(eph: PlanetPositions, et: number, host: number, radiusKm: number,
  camera: string, targetSSB?: Vec3 | null): Vec3 {
  const required = (id: number): Vec3 => {
    const p = eph.positionSSB(id, et);
    if (!p || !p.every(Number.isFinite)) throw new Error(`moon camera ${camera}: missing NAIF ${id} at ET ${et}`);
    return p;
  };
  if (camera === 'earth') return [...required(399)];
  if (camera === 'planet') return [...required(host * 100 + 99)];
  if (camera === 'near') {
    const p = required(host * 100 + 99);
    if (!(radiusKm > 0)) throw new Error('moon camera: missing sourced host radius');
    return [p[0], p[1], p[2] + 10 * radiusKm];
  }
  if (camera === 'close') {
    if (!targetSSB?.every(Number.isFinite)) throw new Error('moon camera close: unknown target');
    return [targetSSB[0] + 10, targetSSB[1], targetSSB[2]]; // diagnostic observer offset, km
  }
  throw new Error(`unknown moon camera ${camera}`);
}

export const ARCSEC_PER_RAD = 180 * 3600 / Math.PI;
// A tenth of the smallest half-cycle in the existing, cited eye model, additionally capped at
// a tenth of a centre pixel. Safety allocations, not a claim about astrometric vernier acuity.
export function moonAngularBudget(fovY: number, height: number): number {
  return Math.min(0.1 * Math.PI / (180 * 2 * acuityCyclesPerDeg(Infinity)), 0.1 * 2 * Math.tan(fovY / 2) / height);
}

export function directionAngle(a: readonly number[], b: readonly number[]): number {
  const an = Math.hypot(...a), bn = Math.hypot(...b);
  if (!(an > 0 && bn > 0)) throw new Error('unknown moon direction');
  const u = a.map(x => x / an), v = b.map(x => x / bn);
  return Math.atan2(Math.hypot(u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]), u.reduce((s,x,k)=>s+x*v[k],0));
}

export function metricSummary(samples: { value: number; id: string; et: number }[]) {
  if (!samples.length || samples.some(s => !Number.isFinite(s.value))) throw new Error('incomplete moon metric');
  const sorted = [...samples].sort((a,b)=>a.value-b.value), worst = sorted[sorted.length-1];
  return { max: worst.value, p90: sorted[Math.ceil(0.9*sorted.length)-1].value, worstMoonId: worst.id, worstEt: worst.et, samples: sorted.length };
}

/** Sample each host separately so even the smaller Saturn batch is represented. */
export function moonPickRows(populations: { firstObject: number; objects: number }[]): number[] {
  return populations.flatMap(p => Array.from({ length: Math.ceil(p.objects / 10) }, (_, k) => p.firstObject + 10*k));
}

/** The pick shader scans this combined display buffer, not child batch states or sorted slots.
 * Read directions immediately before asking; a camera update invalidates an earlier snapshot. */
export async function checkRecordPicks(field: { count: number; readRecords(): Promise<Float32Array>;
  pick(dir: Vec3, toleranceRad: number): Promise<number | null> }, moonRows: number[], toleranceRad: number) {
  const records = await field.readRecords();
  const words = new Uint32Array(records.buffer, records.byteOffset, records.length);
  const checks = [];
  for (const [k, index] of [0, ...moonRows.map(j => field.count + j)].entries()) {
    const asked = Array.from(records.subarray(index*8,index*8+3)) as Vec3;
    const returnedIndex = await field.pick(asked,toleranceRad);
    // Re-read what the pass actually saw: detects a stale camera/snapshot in the harness.
    const stored = await field.readRecords();
    const direction = (i: number) => Array.from(stored.subarray(i*8,i*8+3));
    const valid = Math.hypot(...direction(index)) > 0 && Math.hypot(...asked) > 0;
    checks.push({ kind: k === 0 ? 'catalogue' : 'moon', syntheticRow: k === 0 ? null : moonRows[k-1],
      expectedIndex: index, storedIndex: words[index*8+7], returnedIndex,
      askedStoredAngleRad: valid ? directionAngle(asked,direction(index)) : null,
      askedReturnedAngleRad: returnedIndex !== null && Math.hypot(...direction(returnedIndex)) > 0 && valid
        ? directionAngle(asked,direction(returnedIndex)) : null });
  }
  return checks;
}
