// UTC ↔ ET (TDB seconds past J2000), following SPICE's DELTET algorithm with the NAIF LSK values in time.json
// (docs/architecture.md §3.2):
//
//   TAI = UTC + ΔAT            ΔAT from the leap-second table (time.json leapSeconds)
//   TT  = TAI + ΔT_A           ΔT_A = 32.184 s (deltaTA)
//   TDB = TT + K sin E,  E = M + EB sin M,  M = M0 + M1 · (TT seconds past J2000)
//
// UTC is passed around as Unix milliseconds (a leap-second-free count), which cannot name the inserted second
// 23:59:60. utcMsToEt therefore never lands inside a leap second, and etToUtcMs maps any ET inside one to the
// instant the new ΔAT starts (00:00:00.000 of the next day): the documented clamp.
//
// Before the first table entry (1972-01-01) SPICE uses ΔAT = first − 1 s; this code does the same so results
// match SPICE everywhere. (UTC before 1972 was not defined by whole leap seconds, so neither is exact there.)

import type { TimeData } from '../data/schema';
import { UNIX_S_AT_J2000_UTC_COUNT } from './constants';

export class TimeScale {
  /** UTC (s past J2000, leap-free count) at which entry i starts. */
  private readonly utcStart: Float64Array;
  /** TAI (s past J2000) at which entry i starts: utcStart[i] + dat[i]. */
  private readonly taiStart: Float64Array;
  private readonly dat: Float64Array;
  private readonly datBefore: number;
  private readonly deltaTA: number;
  private readonly k: number;
  private readonly eb: number;
  private readonly m0: number;
  private readonly m1: number;

  constructor(data: TimeData) {
    const ls = data.leapSeconds;
    if (!ls || ls.length === 0) throw new Error('TimeData has no leap seconds');
    for (let i = 1; i < ls.length; i++) {
      if (!(ls[i].utcJ2000 > ls[i - 1].utcJ2000)) throw new Error('TimeData leapSeconds not strictly increasing');
    }
    this.utcStart = Float64Array.from(ls, (l) => l.utcJ2000);
    this.dat = Float64Array.from(ls, (l) => l.deltaAT);
    this.taiStart = Float64Array.from(ls, (l) => l.utcJ2000 + l.deltaAT);
    this.datBefore = ls[0].deltaAT - 1;
    this.deltaTA = data.deltaTA;
    this.k = data.k;
    this.eb = data.eb;
    this.m0 = data.m0;
    this.m1 = data.m1;
    for (const v of [this.deltaTA, this.k, this.eb, this.m0, this.m1]) {
      if (!Number.isFinite(v)) throw new Error('TimeData TDB constants missing');
    }
  }

  /** TAI − UTC (s) in force at a UTC instant given as seconds past J2000 on the leap-free count. */
  deltaAT(utcJ2000: number): number {
    const i = lastLE(this.utcStart, utcJ2000);
    return i < 0 ? this.datBefore : this.dat[i];
  }

  /** TDB − TT (s) at TT seconds past J2000. */
  tdbMinusTt(tt: number): number {
    const m = this.m0 + this.m1 * tt;
    const e = m + this.eb * Math.sin(m);
    return this.k * Math.sin(e);
  }

  utcMsToEt(unixMs: number): number {
    const utc = unixMs / 1000 - UNIX_S_AT_J2000_UTC_COUNT;
    const tt = utc + this.deltaAT(utc) + this.deltaTA;
    return tt + this.tdbMinusTt(tt);
  }

  etToUtcMs(et: number): number {
    // Invert TDB = TT + f(TT); f changes by < 1e-9 s per 1.7 ms of TT, so three fixed-point steps are exact.
    let tt = et;
    for (let i = 0; i < 3; i++) tt = et - this.tdbMinusTt(tt);
    const tai = tt - this.deltaTA;
    const i = lastLE(this.taiStart, tai);
    let utc = tai - (i < 0 ? this.datBefore : this.dat[i]);
    const next = i + 1;
    if (next < this.utcStart.length && utc >= this.utcStart[next]) {
      // Inside an inserted leap second (23:59:60.x): clamp to the instant the new ΔAT applies.
      utc = this.utcStart[next];
    }
    return (utc + UNIX_S_AT_J2000_UTC_COUNT) * 1000;
  }
}

/** "YYYY-MM-DDTHH:MM:SSZ" (UTC, seconds truncated toward the past). */
export function formatUtc(unixMs: number): string {
  if (!Number.isFinite(unixMs)) return 'invalid time';
  const d = new Date(Math.floor(unixMs / 1000) * 1000);
  if (Number.isNaN(d.getTime())) return 'invalid time';
  return d.toISOString().replace('.000Z', 'Z');
}

/** Index of the last element ≤ x in a sorted array, or −1. */
function lastLE(a: Float64Array, x: number): number {
  let lo = 0;
  let hi = a.length - 1;
  if (!(x >= a[0])) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (a[mid] <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
