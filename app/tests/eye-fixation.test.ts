// Fixations (docs/eye-model.md §2): the extended image's adaptation is the luminance-weighted
// log-average of the retinal image (the eye looks at what is lit, never at the Sun's disk); point
// sources are judged at their own fixation, adapted to their own background.
import { describe, expect, it } from 'vitest';
import { fixationAdaptation, isNeverFixated, NEVER_FIXATED_NONE, neverFixatedDisc, type RetinalSample } from '../src/eye/fixation';
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

describe('the solar disk is never fixated, whatever its angular size (ADAPT_SHADER\'s comparison in float32)', () => {
  const f = Math.fround;
  const W = 1280, H = 720;
  type V3 = [number, number, number];
  const norm = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
  // A camera turned away from every axis (test values): right, up, back.
  const back = norm([0.31, -0.52, 0.79]);
  const right = norm([back[2], 0, -back[0]]);
  const up: V3 = [back[1] * right[2] - back[2] * right[1], back[2] * right[0] - back[0] * right[2], back[0] * right[1] - back[1] * right[0]];
  /** Exact direction through pixel (x, y) (pixel centres at +0.5), float64. */
  const dir64 = (x: number, y: number, tanX: number, tanY: number): V3 => {
    const cx = ((x + 0.5) / W * 2 - 1) * tanX, cy = (1 - (y + 0.5) / H * 2) * tanY;
    return norm([right[0] * cx + up[0] * cy - back[0], right[1] * cx + up[1] * cy - back[1], right[2] * cx + up[2] * cy - back[2]]);
  };
  /** The same as the shader computes it (COMMON ndcFromFrag, worldDirNdc, normalize): every step in float32. */
  const dir32 = (x: number, y: number, tanX: number, tanY: number): V3 => {
    const nx = f(f(f(f(x + 0.5) * f(1 / W)) * 2) - 1), ny = f(1 - f(f(f(y + 0.5) * f(1 / H)) * 2));
    const cx = f(nx * f(tanX)), cy = f(ny * f(tanY));
    const w = [0, 1, 2].map((k) => f(f(f(f(right[k]) * cx) + f(f(up[k]) * cy)) + f(f(back[k]) * -1)));
    const l = f(Math.sqrt(f(f(f(w[0] * w[0]) + f(w[1] * w[1])) + f(w[2] * w[2]))));
    return [f(w[0] / l), f(w[1] / l), f(w[2] / l)];
  };
  const angle = (a: V3, b: V3) => 2 * Math.asin(Math.min(1, 0.5 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])));
  const ARCSEC = Math.PI / (180 * 3600);

  // From the Sun at 30 au seen at a 1° field (32″) to the Sun at 1 au (16′). The disc spans 20 px in each case.
  for (const radiusArcsec of [30, 60, 120, 240, 480, 960]) {
    it(`a disk of radius ${radiusArcsec}″: no pixel inside it draws a fixation, and pixels just outside it do`, () => {
      const radius = radiusArcsec * ARCSEC;
      const pixelAngle = radius / 10;
      const tanY = (pixelAngle * H) / 2, tanX = (tanY * W) / H;
      // The Sun's centre between pixel centres, away from the view axis.
      const sun = dir64(700.3, 300.2, tanX, tanY);
      // As the renderer sets it: the disk's angular radius plus one pixel.
      const fix = neverFixatedDisc(sun, radius + pixelAngle);
      let inside = 0, insideFixated = 0, outside = 0, outsideExcluded = 0;
      for (let y = 280; y <= 322; y++) for (let x = 680; x <= 722; x++) {
        const theta = angle(dir64(x, y, tanX, tanY), sun);
        const excluded = isNeverFixated(dir32(x, y, tanX, tanY), fix);
        if (theta <= radius) { inside++; if (!excluded) insideFixated++; }
        if (theta >= radius + 2 * pixelAngle) { outside++; if (excluded) outsideExcluded++; }
      }
      expect(inside).toBeGreaterThan(300);
      expect(outside).toBeGreaterThan(900);
      expect({ insideFixated, outsideExcluded }).toEqual({ insideFixated: 0, outsideExcluded: 0 });
    });
  }
  it('no disc: every pixel may be fixated', () => {
    expect(isNeverFixated([0, 0, 1], NEVER_FIXATED_NONE)).toBe(false);
    expect(isNeverFixated(norm([0.2, -0.4, 0.1]), NEVER_FIXATED_NONE)).toBe(false);
  });
});
