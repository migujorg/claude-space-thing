import { describe, expect, it } from 'vitest';
import { activePreset, Clock, intersectWindows, RATE_PRESETS } from '../src/app/clock';

const W = { startEt: 0, endEt: 1000 };

describe('Clock', () => {
  it('advances by rate × real dt only while playing', () => {
    const c = new Clock(100, W);
    c.tick(1);
    expect(c.et).toBe(100);
    c.play();
    c.setRateMagnitude(60);
    c.tick(0.5);
    expect(c.et).toBe(130);
  });

  it('presets are unit conversions and reverse flips direction', () => {
    expect(RATE_PRESETS.map((p) => p.rate)).toEqual([1, 60, 3600, 86400, 604800, 2592000]);
    const c = new Clock(500, W);
    c.setRateMagnitude(10);
    c.reverse();
    expect(c.rate).toBe(-10);
    c.setRateMagnitude(20); // keeps direction
    expect(c.rate).toBe(-20);
    c.play();
    c.tick(1);
    expect(c.et).toBe(480);
    expect(activePreset(-60)?.id).toBe('min');
  });

  it('stops at window edges instead of running past them', () => {
    const c = new Clock(990, W);
    c.setRateMagnitude(100);
    c.play();
    c.tick(1);
    expect(c.et).toBe(1000);
    expect(c.playing).toBe(false);
    expect(c.snapshot().stoppedAt).toBe('end');
    c.play(); // heading out of the window: refuses
    expect(c.playing).toBe(false);
    c.reverse();
    c.play();
    expect(c.playing).toBe(true);
  });

  it('a request outside the window parks at the edge, pauses, and is reported', () => {
    const c = new Clock(500, W);
    c.play();
    expect(c.set(5000)).toBe(false);
    expect(c.et).toBe(1000);
    expect(c.playing).toBe(false);
    expect(c.snapshot().outside).toEqual({ requestedEt: 5000, edge: 'end' });
    expect(c.set(-1)).toBe(false);
    expect(c.snapshot().outside?.edge).toBe('start');
    expect(c.set(10)).toBe(true);
    expect(c.snapshot().outside).toBeNull();
  });

  it('without a window, time is not clamped', () => {
    const c = new Clock(0, null);
    expect(c.set(1e12)).toBe(true);
    expect(c.fraction()).toBeNull();
  });

  it('intersects windows and ignores invalid ones', () => {
    expect(intersectWindows({ startEt: 0, endEt: 100 }, { startEt: 50, endEt: 200 })).toEqual({ startEt: 50, endEt: 100 });
    expect(intersectWindows(null, { startEt: Infinity, endEt: -Infinity }, { startEt: 1, endEt: 2 })).toEqual({ startEt: 1, endEt: 2 });
    expect(intersectWindows(null, undefined)).toBeNull();
  });
});
