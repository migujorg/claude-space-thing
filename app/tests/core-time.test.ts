import { describe, expect, it } from 'vitest';
import { TimeScale, formatUtc } from '../src/core/time';
import { MaxTracker, fixture, loadTimeData } from './core-data';

interface SpiceTime {
  utcToEt: { utc: string; unixMs: number; et: number }[];
  leapSecondUtcToEt: { utc: string; et: number }[];
  etToUtc: { et: number; utc: string }[];
}

const spice = fixture<SpiceTime>('core_spice_time.json');
const data = loadTimeData();

/** "YYYY-MM-DDTHH:MM:SS.ffffff" (no leap second) → Unix ms, keeping sub-ms digits. */
function isoToUnixMs(s: string): number {
  const [whole, frac = '0'] = s.split('.');
  return Date.parse(whole + 'Z') + Number('0.' + frac) * 1000;
}

describe.skipIf(!data)('TimeScale vs SPICE (naif0012.tls, time.json)', () => {
  const ts = data ? new TimeScale(data) : (null as unknown as TimeScale); // describe bodies run even when skipped
  const max = new MaxTracker();

  it('utcMsToEt matches str2et, including pre-1972 and around leap seconds', () => {
    for (const c of spice.utcToEt) {
      const err = Math.abs(ts.utcMsToEt(c.unixMs) - c.et);
      max.add('utc→et |Δ| s', err, c.utc);
      expect(err, c.utc).toBeLessThan(1e-6);
    }
  });

  it('a leap second adds one SI second between 23:59:59 and 00:00:00', () => {
    const a = ts.utcMsToEt(Date.parse('2016-12-31T23:59:59Z'));
    const b = ts.utcMsToEt(Date.parse('2017-01-01T00:00:00Z'));
    const spiceA = spice.utcToEt.find((c) => c.utc === '2016-12-31T23:59:59')!.et;
    const spiceB = spice.utcToEt.find((c) => c.utc === '2017-01-01T00:00:00')!.et;
    expect(b - a).toBeCloseTo(spiceB - spiceA, 9);
    expect(b - a).toBeCloseTo(2, 6);
  });

  it('etToUtcMs matches et2utc', () => {
    for (const c of spice.etToUtc) {
      const err = Math.abs(ts.etToUtcMs(c.et) - isoToUnixMs(c.utc));
      max.add('et→utc |Δ| ms', err, c.utc);
      expect(err, c.utc).toBeLessThan(1e-3);
    }
  });

  it('inside a leap second etToUtcMs clamps to the start of the next day, monotonically', () => {
    const next = Date.parse('2017-01-01T00:00:00Z');
    for (const c of spice.leapSecondUtcToEt) expect(ts.etToUtcMs(c.et), c.utc).toBe(next);
    const before = ts.etToUtcMs(spice.leapSecondUtcToEt[0].et - 0.25);
    expect(formatUtc(before)).toBe('2016-12-31T23:59:59Z');
    let prev = -Infinity;
    for (let et = spice.leapSecondUtcToEt[0].et - 2; et < spice.leapSecondUtcToEt[0].et + 3; et += 0.125) {
      const u = ts.etToUtcMs(et);
      expect(u).toBeGreaterThanOrEqual(prev);
      prev = u;
    }
  });

  it('round-trips UTC → ET → UTC to < 1 µs outside leap seconds (1972–2040)', () => {
    let seed = 12345;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const lo = Date.parse('1972-01-01T00:00:00Z');
    const hi = Date.parse('2040-01-01T00:00:00Z');
    for (let i = 0; i < 20000; i++) {
      const ms = lo + rand() * (hi - lo);
      const err = Math.abs(ts.etToUtcMs(ts.utcMsToEt(ms)) - ms);
      max.add('round trip |Δ| ms', err, new Date(ms).toISOString());
      expect(err).toBeLessThan(1e-3);
    }
    max.report('TimeScale vs SPICE:');
  });
});

describe('formatUtc', () => {
  it('formats to whole seconds, truncating toward the past', () => {
    expect(formatUtc(Date.UTC(2026, 8, 30, 8, 18, 42, 999))).toBe('2026-09-30T08:18:42Z');
    expect(formatUtc(Date.UTC(2026, 8, 30, 8, 18, 42, 0))).toBe('2026-09-30T08:18:42Z');
    expect(formatUtc(-1)).toBe('1969-12-31T23:59:59Z');
    expect(formatUtc(Number.NaN)).toBe('invalid time');
  });
});
