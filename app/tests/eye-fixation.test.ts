// Fixations (docs/eye-model.md §2): the extended image's adaptation is the luminance-weighted
// log-average of the retinal image (the eye looks at what is lit, never at the Sun's disk); point
// sources are judged at their own fixation, adapted to their own background.
import { describe, expect, it } from 'vitest';
import { fixationAdaptation, sunExclusionRad, type RetinalSample } from '../src/eye/fixation';
import { AdaptationState, computeEyeFrame } from '../src/eye/model';
import { DEFAULT_EYE_SETTINGS } from '../src/eye/settings';
import { pointAppearance } from '../src/eye/points';
import { luxFromMagnitude } from '../src/eye/crumey';

const deg2 = (d: number) => d * (Math.PI / 180) ** 2;
/** A frame of `fieldDeg2` split into regions of given luminance (test values). */
const frame = (regions: { Y: number; areaDeg2: number; sun?: boolean; centre?: boolean }[]): RetinalSample[] =>
  regions.map((r) => ({ Y: r.Y, S: 2 * r.Y, omegaSr: deg2(r.areaDeg2), onSunDisk: r.sun, inCentreField: r.centre }));

describe('fixations: where the eye looks when adapting to the extended image', () => {
  it('a uniform field adapts to its own luminance, either way', () => {
    for (const mode of ['brightness', 'centre'] as const) {
      const a = fixationAdaptation(frame([{ Y: 42, areaDeg2: 2000, centre: true }]), mode);
      expect(a.coneCdM2).toBeCloseTo(42, 6);
      expect(a.rodCdM2).toBeCloseTo(84, 6);
    }
  });
  it('a quarter Moon filling the view: the eye adapts to the sunlit half, not to the night side at the centre', () => {
    const f = frame([
      { Y: 3000, areaDeg2: 1000 },
      { Y: 0.1, areaDeg2: 1000, centre: true }, // earthshine-lit night side under the view centre
    ]);
    expect(fixationAdaptation(f, 'brightness').coneCdM2 / 3000).toBeGreaterThan(0.99);
    expect(fixationAdaptation(f, 'centre').coneCdM2).toBeCloseTo(0.1, 6);
  });
  it('a small bright disk in a dark field (the Moon from Earth) sets the adaptation by its light, not its area', () => {
    const moonArea = Math.PI * 0.26 ** 2;
    const a = fixationAdaptation(frame([{ Y: 3000, areaDeg2: moonArea }, { Y: 0, areaDeg2: 2500 - moonArea }]), 'brightness');
    expect(a.coneCdM2 / 3000).toBeGreaterThan(0.99);
  });
  it('the solar disk is never fixated; the rest of the frame (and the Sun\'s veil in it) sets the adaptation', () => {
    const rest = [{ Y: 8000, areaDeg2: 30 }, { Y: 50, areaDeg2: 1500 }];
    const a = fixationAdaptation(frame([{ Y: 1.6e9, areaDeg2: 0.2, sun: true }, ...rest]), 'brightness');
    expect(a.coneCdM2).toBeCloseTo(fixationAdaptation(frame(rest), 'brightness').coneCdM2, 9);
    expect(a.coneCdM2).toBeGreaterThan(1000);
    expect(a.coneCdM2).toBeLessThan(8000);
  });
  it('glare haze does not draw fixations: the Sun 10° off a crescent Earth leaves the eye adapted to the Earth (plus the veil there)', () => {
    const f: RetinalSample[] = [
      { Y: 1.6e9, S: 3.2e9, sceneY: 1.6e9, omegaSr: deg2(0.2), onSunDisk: true },
      { Y: 1e6, S: 2e6, sceneY: 0, omegaSr: deg2(3) },          // the Sun's near veil on black sky
      { Y: 1.1e4, S: 2.2e4, sceneY: 1e4, omegaSr: deg2(0.5) },  // sunlit crescent + veil at 10°
      { Y: 1e3, S: 2e3, sceneY: 0, omegaSr: deg2(2000) },       // far veil on black sky
    ];
    const a = fixationAdaptation(f, 'brightness').coneCdM2;
    expect(a / 1.1e4).toBeGreaterThan(0.9);
    expect(a / 1.1e4).toBeLessThan(1.01);
  });
  it('light the veil swamps right beside the limb (the inner corona) does not draw the eye onto the Sun', () => {
    // The bare Sun from 1 au in a 25° field: annuli of a corona-like scene luminance L(ρ) (ρ in solar radii)
    // under the Sun's veil 10·E/θ² (θ in degrees, E = 1.27e5 lx); no other light.
    const R = 0.2666, px = 0.04;
    const ring = (exclRad: number, inner: boolean): RetinalSample[] => {
      const out: RetinalSample[] = [];
      const n = 400, t0 = Math.log(R), t1 = Math.log(25);
      for (let i = 0; i < n; i++) {
        const a = Math.exp(t0 + ((t1 - t0) * i) / n), b = Math.exp(t0 + ((t1 - t0) * (i + 1)) / n), th = Math.sqrt(a * b);
        const rho = th / R;
        const excluded = (th * Math.PI) / 180 <= exclRad;
        const L = excluded && !inner ? 0 : 700 * (rho / 1.1) ** -6 + 30 * rho ** -2.3;
        const veil = (10 * 1.27e5) / th ** 2;
        out.push({ Y: L + veil, S: 2 * (L + veil), sceneY: L, omegaSr: deg2(Math.PI * (b * b - a * a)), onSunDisk: excluded });
      }
      return out;
    };
    const rad = (d: number) => (d * Math.PI) / 180;
    const wide = sunExclusionRad(rad(R), 1, rad(px));
    expect((wide * 180) / Math.PI).toBeCloseTo(R + 0.5, 9);
    expect(sunExclusionRad(rad(R), 0.01, rad(px))).toBeCloseTo(rad(R + px), 12);   // at least one pixel
    // Widened: the light inside the ring changes nothing (it is never fixated).
    const a = fixationAdaptation(ring(wide, true), 'brightness').coneCdM2;
    expect(a / fixationAdaptation(ring(wide, false), 'brightness').coneCdM2).toBeCloseTo(1, 9);
    // The disk alone: that light, 10⁻⁴ of the veil over it, would pull the eye to the limb (adaptation ×10 or more).
    const disk = rad(R + px);
    expect(fixationAdaptation(ring(disk, true), 'brightness').coneCdM2 / a).toBeGreaterThan(10);
  });
  it('an empty dark frame adapts to darkness (the dark-light floor)', () => {
    const a = fixationAdaptation(frame([{ Y: 0, areaDeg2: 2500 }]), 'brightness');
    expect(a.coneCdM2).toBeCloseTo(0, 12);
  });
});

describe('point sources are judged at their own fixation', () => {
  const eyeAt = (A: number) => {
    const s = new AdaptationState();
    s.update({ coneCdM2: A, rodCdM2: 2.06 * A, cornealFlux: 0 }, 0);
    return computeEyeFrame(DEFAULT_EYE_SETTINGS, s, 'eye', 0, null);
  };
  const splat = 2 * Math.PI * 0.36 * ((50 * Math.PI) / 180 / 720) ** 2;
  const star = (V: number) => ({ Y: luxFromMagnitude(V), S: 2 * luxFromMagnitude(V) });
  it('a faint star in dark sky looks the same whether the extended image is adapted to a bright planet or to the dark', () => {
    const darkSky = { Y: 2e-6, S: 4e-6 };
    const a = pointAppearance(eyeAt(1e-5), star(6), darkSky, 0.9, splat);
    const b = pointAppearance(eyeAt(300), star(6), darkSky, 0.9, splat);
    expect(a.visible && b.visible).toBe(true);
    expect(b.wantedFlux / a.wantedFlux).toBeCloseTo(1, 9);
  });
  it('the same star against a bright local veil (beside the planet) is below threshold', () => {
    const veil = { Y: 5, S: 10 };
    const p = pointAppearance(eyeAt(1e-5), star(6), veil, 0.9, splat);
    expect(p.visible).toBe(false);
    expect(p.wantedFlux).toBe(0);
  });
});
