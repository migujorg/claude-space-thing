// Fixations (docs/eye-model.md §2): the extended image's adaptation is the luminance-weighted
// log-average of the retinal image (the eye looks at what is lit, never at the Sun's disk); point
// sources are judged at their own fixation, adapted to their own background.
import { describe, expect, it } from 'vitest';
import { fixationAdaptation, type RetinalSample } from '../src/eye/fixation';
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
  it('light buried in the Sun\'s veil draws no fixations: the Sun with its zodiacal light adapts like the Sun alone', () => {
    // TEST VALUES of the kind the sun-1au scene has: the inner zodiacal light a degree from the Sun is ~10⁻⁴ of the
    // veil there, and faint everywhere else.
    const sunOnly: RetinalSample[] = [
      { Y: 1.6e9, S: 3.2e9, sceneY: 1.6e9, omegaSr: deg2(0.2), onSunDisk: true },
      { Y: 1e6, S: 2e6, sceneY: 0, omegaSr: deg2(3) },
      { Y: 1e4, S: 2e4, sceneY: 0, omegaSr: deg2(100) },
      { Y: 1e3, S: 2e3, sceneY: 0, omegaSr: deg2(2000) },
    ];
    const withZodi: RetinalSample[] = [
      { Y: 1.6e9, S: 3.2e9, sceneY: 1.6e9, omegaSr: deg2(0.2), onSunDisk: true },
      { Y: 1e6, S: 2e6, sceneY: 200, omegaSr: deg2(3) },
      { Y: 1e4, S: 2e4, sceneY: 1, omegaSr: deg2(100) },
      { Y: 1e3, S: 2e3, sceneY: 1e-3, omegaSr: deg2(2000) },
    ];
    const a0 = fixationAdaptation(sunOnly, 'brightness').coneCdM2;
    const a1 = fixationAdaptation(withZodi, 'brightness').coneCdM2;
    expect(a1 / a0).toBeGreaterThan(0.95);
    expect(a1 / a0).toBeLessThan(1.05);
    // Weighted by the scene light alone (the rule before M5+), the 200 cd/m² next to the Sun would take the eye there.
    expect(a0).toBeLessThan(1e4);
  });
  it('the solar corona draws no fixations beside the bare Sun, and sets the adaptation in totality', () => {
    // TEST VALUES shaped like the sky stage's corona at 1 au (docs/reports/sky.md §5.5: K + F ≈ 2600 cd/m² at
    // 1.1 R⊙, 40 at 2, 2 at 5): annuli out to 25°, under the Sun's veil 10·E/θ² (θ in degrees, E = 1.27e5 lx)
    // when the disk is bare, under no solar veil in totality (the Moon covers ρ < 1.08).
    const R = 0.2666;
    const corona = (rho: number) => 2500 * (rho / 1.1) ** -8 + 90 * (rho / 1.1) ** -2.4;
    const frameAt = (withCorona: boolean, totality: boolean): RetinalSample[] => {
      const out: RetinalSample[] = [{ Y: totality ? 0 : 2e9, S: 0, sceneY: totality ? 0 : 2e9, omegaSr: deg2(Math.PI * R * R), onSunDisk: true }];
      const n = 400, t0 = Math.log(R), t1 = Math.log(25);
      for (let i = 0; i < n; i++) {
        const a = Math.exp(t0 + ((t1 - t0) * i) / n), b = Math.exp(t0 + ((t1 - t0) * (i + 1)) / n), th = Math.sqrt(a * b);
        const rho = th / R;
        const L = withCorona && !(totality && rho < 1.08) ? corona(rho) : 0;
        const veil = totality ? 0.05 * L : (10 * 1.27e5) / th ** 2;
        out.push({ Y: L + veil, S: 2 * (L + veil), sceneY: L, omegaSr: deg2(Math.PI * (b * b - a * a)) });
      }
      return out;
    };
    // Bare Sun: the corona (≤ 10⁻³ of the veil over it) changes nothing.
    const bare = fixationAdaptation(frameAt(true, false), 'brightness').coneCdM2;
    expect(bare / fixationAdaptation(frameAt(false, false), 'brightness').coneCdM2).toBeCloseTo(1, 3);
    // Totality: nothing veils it, so the eye adapts to the inner corona (hundreds of cd/m²), not to darkness.
    const tot = fixationAdaptation(frameAt(true, true), 'brightness').coneCdM2;
    expect(tot).toBeGreaterThan(100);
    expect(tot).toBeLessThan(2600);
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
