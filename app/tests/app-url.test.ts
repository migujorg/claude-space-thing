import { describe, expect, it } from 'vitest';
import { formatUrlParams, parseIsoUtc, parseUrlParams } from '../src/app/url';

describe('URL parameters', () => {
  it('parses the documented parameters', () => {
    const { view, errors } = parseUrlParams('?t=2026-09-30T00:00:00Z&target=399&dist=50000&az=30&el=-10&exists=strict&view=enhanced&boost=4&fov=40&labels=0&orbits=1&tint=1&ui=0');
    expect(errors).toEqual([]);
    expect(view).toEqual({
      tMs: Date.UTC(2026, 8, 30), target: 399, dist: 50000, az: 30, el: -10, exists: 'strict', view: 'enhanced', boost: 4, fov: 40,
      labels: false, orbits: true, tint: true, ui: false,
    });
  });
  it('reports and ignores bad values', () => {
    const { view, errors } = parseUrlParams('t=yesterday&target=abc&exists=maybe&el=95&dist=-3');
    expect(view).toEqual({});
    expect(errors).toHaveLength(5);
  });
  it('round-trips', () => {
    const v = { tMs: Date.UTC(2026, 0, 2, 3, 4, 5, 600), target: 599, dist: 1234567, az: 12.5, el: -3.25, exists: 'complete' as const, fov: 35, orbits: true, shield: true };
    expect(parseUrlParams(formatUrlParams(v)).view).toEqual(v);
  });
  it('treats times without a zone as UTC, never local', () => {
    expect(parseIsoUtc('2026-09-30 12:00')).toBe(Date.UTC(2026, 8, 30, 12));
    expect(parseIsoUtc('2026-09-30')).toBe(Date.UTC(2026, 8, 30));
    expect(parseIsoUtc('2026-09-30T12:00:00+02:00')).toBe(Date.UTC(2026, 8, 30, 10));
    expect(parseIsoUtc('30/09/2026')).toBeNull();
  });
});
