import { describe, expect, it } from 'vitest';
import { formatUrlParams, parseIsoUtc, parseUrlParams } from '../src/app/url';
import scenesJson from '../e2e/scenes.json';

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
    const w = { adapt: 'instant' as const, adaptFrom: { luminanceCdM2: 10000, exposureS: 600, elapsedS: 300 } };
    expect(parseUrlParams(formatUrlParams(w)).view).toEqual(w);
  });
  it('eye adaptation: adapt=instant|realtime and a defined history', () => {
    expect(parseUrlParams('adapt=realtime&adaptfrom=10000,600,300').view).toEqual({ adapt: 'realtime', adaptFrom: { luminanceCdM2: 10000, exposureS: 600, elapsedS: 300 } });
    const bad = parseUrlParams('adapt=slow&adaptfrom=1,2');
    expect(bad.view).toEqual({});
    expect(bad.errors).toHaveLength(2);
  });
  it('parses and round-trips a held eye instant, including zero', () => {
    for (const adaptTimeS of [0, 60, 120, 720, 1800]) {
      const v = { adapt: 'realtime' as const, adaptFrom: { luminanceCdM2: 10000, exposureS: 600, elapsedS: 300 }, adaptTimeS };
      expect(parseUrlParams(formatUrlParams(v))).toEqual({ view: v, errors: [] });
    }
    for (const query of ['adapttime=-1', 'adapttime=Infinity', 'adapttime=oops', 'adapttime=60', 'adapt=instant&adaptfrom=10000,600,60&adapttime=60']) {
      const parsed = parseUrlParams(query);
      expect(parsed.view).not.toHaveProperty('adaptTimeS');
      expect(parsed.errors).toHaveLength(1);
    }
  });
  it('look: local azimuth and elevation at the camera place', () => {
    expect(parseUrlParams('target=399&dist=6771&look=0,-15').view).toEqual({ target: 399, dist: 6771, look: { azDeg: 0, elDeg: -15 } });
    const v = { target: 399, dist: 6771, az: 180, el: 0, look: { azDeg: 90.5, elDeg: -17.25 } };
    expect(parseUrlParams(formatUrlParams(v)).view).toEqual(v);
    const bad = parseUrlParams('look=10&look2=1');
    expect(bad.view).toEqual({});
    expect(parseUrlParams('look=0,95').errors).toHaveLength(1);
  });
  it('treats times without a zone as UTC, never local', () => {
    expect(parseIsoUtc('2026-09-30 12:00')).toBe(Date.UTC(2026, 8, 30, 12));
    expect(parseIsoUtc('2026-09-30')).toBe(Date.UTC(2026, 8, 30));
    expect(parseIsoUtc('2026-09-30T12:00:00+02:00')).toBe(Date.UTC(2026, 8, 30, 10));
    expect(parseIsoUtc('30/09/2026')).toBeNull();
  });
});

describe('the regression scenes (e2e/scenes.json)', () => {
  const suite = scenesJson as unknown as { defaults: Record<string, string>; scenes: { id: string; params: Record<string, string> }[] };
  // Every parameter url.ts reads. None of them reaches the eye settings: the observer of a scene is the app's,
  // an eye with its optical point spread (EyeSettings.opticalCore). Only the validation runner turns that off.
  const KNOWN = ['t', 'target', 'dist', 'az', 'el', 'look', 'exists', 'view', 'boost', 'fov', 'labels', 'orbits', 'tint', 'ui', 'system',
    'smallbodies', 'sbfield', 'shield', 'adapt', 'adaptfrom', 'adapttime'];
  it('are URL queries of documented parameters only, and all of them parse', () => {
    expect(suite.scenes.length).toBeGreaterThan(20);
    for (const scene of suite.scenes) {
      const params = { ...suite.defaults, ...scene.params };
      for (const k of Object.keys(params)) expect(KNOWN, `${scene.id}: ${k}`).toContain(k);
      const { view, errors } = parseUrlParams(new URLSearchParams(params).toString());
      expect(errors, scene.id).toEqual([]);
      expect(Object.keys(view).some((k) => /eye|core|optic/i.test(k)), scene.id).toBe(false);
    }
  });
});
