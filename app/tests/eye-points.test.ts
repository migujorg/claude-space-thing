// Point sources: Ricco summation sets brightness (never size), glare is painted only for light the
// display cannot show, and colour follows each source's own cone signal (eye/points.ts).
import { describe, expect, it } from 'vitest';
import { AdaptationState, computeEyeFrame } from '../src/eye/model';
import { DEFAULT_EYE_SETTINGS } from '../src/eye/settings';
import { intendedDisplayLd, pointAppearance } from '../src/eye/points';
import { luxFromMagnitude, riccoArea } from '../src/eye/crumey';
import { HECHT1947, PATTANAIK } from '../src/eye/constants';
import { inverseDisplay, lumResponse } from '../src/eye/tonemap';

const eyeAt = (A: number) => {
  const s = new AdaptationState();
  s.update({ coneCdM2: A, rodCdM2: 2.06 * A, cornealFlux: 0 }, 0);
  return computeEyeFrame(DEFAULT_EYE_SETTINGS, s, 'eye', 0, null);
};
// A 0.6 px σ splat at 1280×720, 50° vertical field (the renderer's reconstruction minimum).
const splat = 2 * Math.PI * 0.36 * ((50 * Math.PI) / 180 / 720) ** 2;
const star = (V: number, sp = 2) => ({ Y: luxFromMagnitude(V), S: sp * luxFromMagnitude(V) });
const dark = eyeAt(1e-5);
const bg = { Y: 2e-6, S: 4e-6 };

describe('point sources are drawn as points', () => {
  it('the viewer\'s Ricco area (display adaptation) is ~5′, far smaller than the dark-adapted one (~50′)', () => {
    const r = (sr: number) => (Math.sqrt(sr / Math.PI) * 180 * 60) / Math.PI;
    expect(r(dark.displayRiccoSr)).toBeGreaterThan(4);
    expect(r(dark.displayRiccoSr)).toBeLessThan(6);
    expect(r(dark.riccoAreaSr)).toBeGreaterThan(45);
    expect(dark.displayRiccoSr).toBeCloseTo(riccoArea(DEFAULT_EYE_SETTINGS.displayPeakCdM2 / PATTANAIK.refWhiteFactor), 15);
  });
  it('brightness rises monotonically with illuminance; the splat never exceeds the display peak', () => {
    let prev = -1;
    for (let V = 8; V >= -5; V -= 0.5) {
      const p = pointAppearance(dark, star(V), bg, 0.9, splat);
      expect(p.wantedFlux).toBeGreaterThanOrEqual(prev);
      expect(p.peakLd).toBeLessThanOrEqual(dark.display.peak + 1e-9);
      expect(p.drawnFlux + p.overflowFlux).toBeCloseTo(p.wantedFlux, 12);
      prev = p.wantedFlux;
    }
  });
  it('a star near the limiting magnitude is a dim dot; no glare is painted for stars the display can show', () => {
    const faint = pointAppearance(dark, star(7), bg, 0.9, splat);
    expect(faint.peakLd).toBeGreaterThan(0);
    expect(faint.peakLd / dark.display.peak).toBeLessThan(0.02);
    for (const V of [7, 5, 3]) expect(pointAppearance(dark, star(V), bg, 0.9, splat).overflowFlux).toBe(0);
  });
  it('glare (overflow) is painted only beyond the display range and grows with the source', () => {
    const o = (V: number) => pointAppearance(dark, star(V), bg, 0.9, splat).overflowFlux;
    expect(o(0)).toBeGreaterThan(0);
    expect(o(-1.5)).toBeGreaterThan(o(0));
    expect(o(-4.5)).toBeGreaterThan(o(-1.5));
  });
  it('the intended display luminance continues the tone curve beyond the peak, bounded by cone bleaching', () => {
    for (const L of [1e-6, 1e-4, 1e-3]) {
      const clamped = inverseDisplay(dark.map.gain * lumResponse(dark.scene, L, 2 * L) + dark.map.offset, dark.display);
      if (clamped < dark.display.peak) expect(intendedDisplayLd(dark, L, 2 * L)).toBeCloseTo(clamped, 9);
    }
    expect(intendedDisplayLd(dark, 1e6, 2e6)).toBeLessThanOrEqual(PATTANAIK.coneBleachHalf);
  });
});

describe('star colour from the source\'s own cone signal', () => {
  const k = (V: number) => pointAppearance(dark, star(V), bg, 0.9, splat).colourExponent;
  const kBg = pointAppearance(dark, { Y: 0, S: 0 }, bg, 0.9, splat).colourExponent;
  const vCone = -2.5 * Math.log10(HECHT1947.coneC / luxFromMagnitude(0)); // Hecht (1947) cone point threshold, V ≈ 4.3
  it('no colour at the cone point threshold of Hecht (1947) (V ≈ 4.3)', () => {
    expect(vCone).toBeCloseTo(4.31, 1);
    expect(k(vCone) - kBg).toBeLessThan(0.05);
    expect(k(0) - kBg).toBeGreaterThan(4 * (k(vCone) - kBg));
  });
  it('colour grows with brightness: weak near V 2, clear for the brightest stars', () => {
    expect(k(2.3)).toBeGreaterThan(kBg);
    expect(k(0)).toBeGreaterThan(0.2);
    expect(k(-1.5)).toBeGreaterThan(0.5);
    // (Non-decreasing up to the small effect of the display slope at the brighter dot, Pattanaik Eq. 3.)
    for (let V = 6; V >= -3; V -= 0.5) expect(k(V - 0.5)).toBeGreaterThan(k(V) - 0.005);
  });
});
