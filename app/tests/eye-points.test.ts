// Point sources: Ricco summation sets brightness (never size), glare is painted only for light the
// display cannot show, and colour follows each source's own cone signal (eye/points.ts).
import { describe, expect, it } from 'vitest';
import { AdaptationState, computeEyeFrame } from '../src/eye/model';
import { DEFAULT_EYE_SETTINGS } from '../src/eye/settings';
import { VEIL_BLUR_TAPS, backgroundLevel, erf, intendedDisplayLd, ownVeilAxis, ownVeilExact, ownVeilPerPixel, pointAppearance, pointBackground, pointHidden, pointObserver, pointVeil, pointVisible, splatNorm, veilKernelPerPixel, type PointSource, type PointSplat, type VeilLevel } from '../src/eye/points';
import { luxFromMagnitude, riccoArea } from '../src/eye/crumey';
import { fitScatterKernel } from '../src/eye/glare';
import { CRUMEY, HECHT1947, PATTANAIK } from '../src/eye/constants';
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
type YS = { Y: number; S: number };
/** A source's background where no extended light lies behind it (pointBackground's direct term is zero). */
const veilBackground = (texture: YS, own: YS, analytic: YS) => pointBackground(texture, own, analytic, { Y: 0, S: 0 });
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

// The cull and the point image (shaders.ts CULL_SHADER; renderer.ts steps 2–4), as their CPU twin states them.
// The property: a source's verdict in a frame is a function of the scene and the eye's state alone. It does not
// depend on any verdict of an earlier frame, the source's own or a neighbour's. That holds because the physical
// point image (PT), and so the veil the sources are judged against, holds every source in the frame, seen or not:
// the light of a star reaches the eye whether or not the eye can pick the star out.
describe('the star cull: no verdict depends on an earlier verdict (twin of CULL_SHADER and the point image)', () => {
  const W = 1280, H = 720, pixelDeg = 50 / H;
  const pixelSr = ((pixelDeg * Math.PI) / 180) ** 2;
  // The retina pyramid's levels: σ in pixels (renderer.ts pyramidSigma) and the CIE 146 fit's weights.
  const sigma = (k: number) => { const p = 4 ** k; return Math.sqrt(p + (p - 1) / 12 + (4 * p - 4) / 18); };
  const nLevels = Math.ceil(Math.log2(Math.max(W, H))) + 1;
  const fit = fitScatterKernel(Array.from({ length: nLevels }, (_, k) => ({ sigmaPx: sigma(k) })), pixelDeg, Math.hypot(W, H), 25, 0.5);
  const levels: VeilLevel[] = fit.weights.map((weight, k) => ({ weight, sigmaPx: sigma(k) }));
  // A view with a sunlit body in it: the suite's pluto-charon adapts to 11 cd/m².
  const eye = eyeAt(11);
  const kR = backgroundLevel(levels, pixelSr, eye.riccoAreaSr);
  // Everything in the veil that is not a point source (the sky's and the bodies' scattered light), cd/m².
  const other = { Y: 2e-3, S: 4e-3 };
  const none = { Y: 0, S: 0 };
  // A 2850 K-coloured point: its Blackwell-equivalent illuminance is its photopic one, so the threshold is in lux of Y.
  const lamp = (Y: number) => ({ Y, S: CRUMEY.spRatioBlackwell * Y });
  const thr = (bg: { Y: number; S: number }) => pointObserver(eye, bg).thresholdBwLux;
  const at = (x: number, y: number, Y: number): PointSource => ({ x, y, E: lamp(Y) });
  const own = (s: PointSource) => ({ Y: (s.E.Y * ownVeilPerPixel(levels, kR)) / pixelSr, S: (s.E.S * ownVeilPerPixel(levels, kR)) / pixelSr });
  const add = (a: { Y: number; S: number }, b: { Y: number; S: number }) => ({ Y: a.Y + b.Y, S: a.S + b.S });

  // One frame of the renderer, as it is: every source is in the point image; each is judged against the veil of
  // the frame before (the texture the cull reads) less its own light there. The only history is that texture.
  const frame = (sources: PointSource[], texBefore: { Y: number; S: number }[]) => ({
    verdicts: sources.map((s, i) => pointVisible(eye, s.E, veilBackground(texBefore[i], own(s), none))),
    tex: pointVeil(sources, levels, kR, pixelSr).map((v) => add(v, other)),
  });
  // The texture when only some of the sources are in the point image (the rules below; not what the renderer does).
  const texOfDrawn = (sources: PointSource[], drawn: boolean[]) => sources.map((a) => {
    let Y = other.Y, S = other.S;
    sources.forEach((b, j) => {
      if (!drawn[j]) return;
      const k = veilKernelPerPixel(levels, kR, Math.hypot(a.x - b.x, a.y - b.y)) / pixelSr;
      Y += b.E.Y * k;
      S += b.E.S * k;
    });
    return { Y, S };
  });
  // The rule before the fix: only the sources that passed are in the image, and own light is always subtracted.
  const frameOld = (sources: PointSource[], texBefore: { Y: number; S: number }[]) => {
    const verdicts = sources.map((s, i) => pointVisible(eye, s.E, veilBackground(texBefore[i], own(s), none)));
    return { verdicts, tex: texOfDrawn(sources, verdicts) };
  };
  // The rule that was tried and rejected: only the sources that passed are in the image, and a source's own light
  // is subtracted only if it was drawn the frame before (one flag per source).
  const frameFlags = (sources: PointSource[], texBefore: { Y: number; S: number }[], was: boolean[]) => {
    const verdicts = sources.map((s, i) => pointVisible(eye, s.E, veilBackground(texBefore[i], was[i] ? own(s) : none, none)));
    return { verdicts, tex: texOfDrawn(sources, verdicts) };
  };
  const run = <T extends { verdicts: boolean[]; tex: { Y: number; S: number }[] }>(n: number, first: T, step: (prev: T) => T) => {
    const out = [first];
    for (let i = 1; i < n; i++) out.push(step(out[i - 1]));
    return out.map((f) => f.verdicts.map((v) => (v ? '1' : '0')).join(''));
  };

  it('the background is read at the first veil level as wide as the Ricco area: fine when light-adapted, coarse in the dark', () => {
    expect(2 * Math.PI * levels[kR].sigmaPx ** 2 * pixelSr).toBeGreaterThanOrEqual(eye.riccoAreaSr);
    if (kR > 0) expect(2 * Math.PI * levels[kR - 1].sigmaPx ** 2 * pixelSr).toBeLessThan(eye.riccoAreaSr);
    expect(backgroundLevel(levels, pixelSr, dark.riccoAreaSr)).toBeGreaterThan(kR + 2);
    // never beyond the last level, even for an area no level reaches
    expect(backgroundLevel(levels, pixelSr, 1e9)).toBe(levels.length - 1);
  });
  // This block models the veil as the continuous kernel (pointVeil), which is enough to state the rule: there a
  // source's own light is the kernel at zero distance. What the shaders take out is what the pyramid holds
  // (ownVeilExact, tested at the end of this file).
  it('in the continuous model a source\'s own light in its background is the veil kernel at zero distance, and taking it out leaves the others\' light', () => {
    const k0 = ownVeilPerPixel(levels, kR);
    let sum = 0;
    for (let k = kR; k < levels.length; k++) sum += levels[k].weight / (2 * Math.PI * levels[k].sigmaPx ** 2);
    expect(k0).toBeCloseTo(sum, 15);
    expect(veilKernelPerPixel(levels, kR, 0)).toBe(k0);
    expect(veilKernelPerPixel(levels, kR, 3)).toBeLessThan(k0);
    // an isolated source: what is left of its background is the other light, to rounding
    const s = at(100, 100, luxFromMagnitude(5));
    const tex = add(pointVeil([s], levels, kR, pixelSr)[0], other);
    const bg = veilBackground(tex, own(s), none);
    expect(bg.Y / other.Y - 1).toBeLessThan(1e-12);
    expect(Math.abs(bg.S / other.S - 1)).toBeLessThan(1e-12);
    // and it is never negative: against a texture that does not hold the source (the first frame after a cut)
    expect(veilBackground({ Y: 0.5 * own(s).Y, S: 0 }, own(s), none)).toEqual({ Y: 0, S: 0 });
    expect(veilBackground({ Y: 0, S: 0 }, own(s), { Y: 1e-4, S: 2e-4 })).toEqual({ Y: 1e-4, S: 2e-4 });
  });
  it('the point image holds every source: one the eye cannot pick out still lights its neighbours\' background', () => {
    // a source far below the threshold, 2 px from one above it
    const faint = at(102, 100, 0.01 * thr(other));
    const seen = at(100, 100, 3 * thr(other));
    const f = frame([seen, faint], pointVeil([seen, faint], levels, kR, pixelSr).map((v) => add(v, other)));
    expect(f.verdicts).toEqual([true, false]);
    const withFaint = veilBackground(f.tex[0], own(seen), none).Y;
    const alone = veilBackground(add(pointVeil([seen], levels, kR, pixelSr)[0], other), own(seen), none).Y;
    expect(withFaint - alone).toBeCloseTo((faint.E.Y * veilKernelPerPixel(levels, kR, 2)) / pixelSr, 12);
    expect(withFaint).toBeGreaterThan(alone);
    // no light is lost: each source, seen or not, carries its whole scattered light into the veil (the kernel's
    // integral over the plane is the levels' weight)
    let w = 0;
    for (let k = kR; k < levels.length; k++) w += levels[k].weight;
    let integral = 0;
    for (let r = 0.005; r < 60000; r *= 1.01) integral += 2 * Math.PI * (r * 1.005) * (r * 0.01) * veilKernelPerPixel(levels, kR, r * 1.005);
    expect(integral / w - 1).toBeLessThan(1e-3);
    expect(integral / w - 1).toBeGreaterThan(-1e-3);
  });
  it('a star at threshold keeps one verdict from any history; under the old rule it was drawn every other frame', () => {
    // E passes against the veil with its own light taken out although it was never in it, and fails against the true one
    const probe = at(300, 200, 1);
    const k0 = ownVeilPerPixel(levels, kR) / pixelSr;
    // find E with thr(other − E·k0) ≤ E < thr(other): the old rule's flipping band
    let E = thr(other);
    for (let i = 0; i < 60; i++) E = 0.5 * (thr({ Y: Math.max(other.Y - E * k0, 0), S: Math.max(other.S - CRUMEY.spRatioBlackwell * E * k0, 0) }) + thr(other));
    const star = { ...probe, E: lamp(E) };
    expect(pointVisible(eye, star.E, other)).toBe(false);
    expect(pointVisible(eye, star.E, veilBackground(other, own(star), none))).toBe(true);
    const zero = [none];
    // old rule: on, off, on, off … for ever
    const old = run(12, frameOld([star], zero), (p) => frameOld([star], p.tex));
    expect(new Set(old.slice(2)).size).toBe(2);
    for (let i = 3; i < old.length; i++) expect(old[i]).not.toBe(old[i - 1]);
    // as it is now: one verdict (not seen: it is below the threshold of its true background), from every history
    const histories = [zero, [other], [{ Y: 50 * other.Y, S: 50 * other.S }], pointVeil([star], levels, kR, pixelSr).map((v) => add(v, other))];
    const seqs = histories.map((h) => run(12, frame([star], h), (p) => frame([star], p.tex)));
    for (const s of seqs) {
      expect(new Set(s.slice(1)).size).toBe(1);   // constant from the second frame on (the first reads the history's texture)
      expect(s[11]).toBe('0');
      expect(s.slice(1)).toEqual(seqs[0].slice(1));
    }
  });
  it('a close pair at threshold has one verdict; with a "drawn last frame" flag per star the outcome depended on the history', () => {
    // two equal stars 1 px apart: each passes against the other light alone and fails with its neighbour's light added
    const kN = veilKernelPerPixel(levels, kR, 1) / pixelSr;
    let E = thr(other);
    for (let i = 0; i < 60; i++) E = 0.5 * (thr(other) + thr({ Y: other.Y + E * kN, S: other.S + CRUMEY.spRatioBlackwell * E * kN }));
    const A = at(400, 300, E), B = at(401, 300, E);
    expect(pointVisible(eye, A.E, other)).toBe(true);
    expect(pointVisible(eye, A.E, { Y: other.Y + E * kN, S: other.S + CRUMEY.spRatioBlackwell * E * kN })).toBe(false);
    const pair = [A, B];
    const texOf = (drawn: PointSource[]) => texOfDrawn(pair, pair.map((s) => drawn.includes(s)));
    // flags: three histories, three outcomes (A alone, B alone, both alternating)
    const flagRun = (was: boolean[]) => {
      let f = frameFlags(pair, texOfDrawn(pair, was), was);
      const out = [f.verdicts.map((v) => (v ? '1' : '0')).join('')];
      for (let i = 1; i < 12; i++) { f = frameFlags(pair, f.tex, f.verdicts); out.push(f.verdicts.map((v) => (v ? '1' : '0')).join('')); }
      return out;
    };
    expect(flagRun([true, false])[11]).toBe('10');
    expect(flagRun([false, true])[11]).toBe('01');
    const both = flagRun([true, true]);
    expect(new Set(both.slice(2)).size).toBe(2);
    // as it is now: both judged against the pair's whole light, whatever was drawn before
    const histories = [[none, none], [other, other], texOf([A]), texOf([B]), texOf(pair)];
    const seqs = histories.map((h) => run(12, frame(pair, h), (p) => frame(pair, p.tex)));
    for (const s of seqs) {
      expect(new Set(s.slice(1)).size).toBe(1);
      expect(s.slice(1)).toEqual(seqs[0].slice(1));
      expect(s[11]).toBe('00');
    }
  });
  it('a field of stars around the threshold: the verdicts of a frame follow from that frame\'s sources alone', () => {
    // 400 stars on 200 × 200 px, within ±1 mag of the threshold (a deterministic sequence, no random numbers)
    const field: PointSource[] = [];
    for (let i = 0; i < 400; i++) {
      const u = (i * 0.61803398875) % 1, v = (i * 0.75487766625) % 1, m = (i * 0.56984029099) % 1;
      field.push(at(200 * u, 200 * v, thr(other) * 10 ** (0.4 * (2 * m - 1))));
    }
    const truth = pointVeil(field, levels, kR, pixelSr).map((v) => add(v, other));
    const expected = field.map((s, i) => pointVisible(eye, s.E, veilBackground(truth[i], own(s), none)));
    const nSeen = expected.filter(Boolean).length;
    expect(nSeen).toBeGreaterThan(50);
    expect(nSeen).toBeLessThan(350);
    const key = expected.map((v) => (v ? '1' : '0')).join('');
    const empty = field.map(() => none);
    const bright = field.map(() => ({ Y: 1, S: 2 }));
    const half = texOfDrawn(field, field.map((_, i) => i % 2 === 1));
    for (const h of [empty, bright, half, truth]) {
      const s = run(6, frame(field, h), (p) => frame(field, p.tex));
      for (let i = 1; i < 6; i++) expect(s[i]).toBe(key);
    }
    // the old rule, same field, from an empty texture: it never settles
    const old = run(40, frameOld(field, empty), (p) => frameOld(field, p.tex));
    expect(old[39]).not.toBe(old[38]);
  });
});

describe('one test for the cull and the display: the background includes the extended image\'s direct light', () => {
  const eye = eyeAt(2e-4);
  const none = { Y: 0, S: 0 };
  it('a star on a dark veil but in front of the sky\'s own luminance is judged against that sky', () => {
    const veil = { Y: 2e-5, S: 4e-5 }, sky = { Y: 2e-4, S: 4.4e-4 };
    // the faintest star that passes against the veil alone (what the cull tested until 7 October 2026)
    let V = 4;
    while (pointVisible(eye, star(V + 0.05), pointBackground(veil, none, none, none))) V += 0.05;
    const s = star(V);
    expect(pointVisible(eye, s, pointBackground(veil, none, none, none))).toBe(true);
    // against what the display judged it by, it is not seen: the cull counted it and the screen did not show it
    expect(pointVisible(eye, s, pointBackground(veil, none, none, sky))).toBe(false);
    // and the limit against the sky is brighter by a good part of a magnitude
    let Vs = 4;
    while (pointVisible(eye, star(Vs + 0.05), pointBackground(veil, none, none, sky))) Vs += 0.05;
    expect(V - Vs).toBeGreaterThan(0.3);
  });
  it('the direct light adds to the veil and the analytic veil; the own light comes out of the texture only', () => {
    const bg = pointBackground({ Y: 5, S: 9 }, { Y: 2, S: 3 }, { Y: 0.5, S: 1 }, { Y: 10, S: 20 });
    expect(bg).toEqual({ Y: 13.5, S: 27 });
    expect(pointBackground({ Y: 1, S: 1 }, { Y: 2, S: 3 }, none, { Y: 10, S: 20 })).toEqual({ Y: 10, S: 20 });
  });
});

describe('occlusion belongs to the source, not to its splat\'s pixels', () => {
  // reverse depth, as the renderer stores it: larger is nearer; 0 is infinity, and no surface
  it('a star (at infinity) is hidden where a body covers its centre, and nowhere else', () => {
    expect(pointHidden(0.3, 0)).toBe(true);
    expect(pointHidden(0, 0)).toBe(false);
  });
  it('a moon in front of its planet is drawn, behind it hidden, and its own disk at its own depth does not hide it', () => {
    expect(pointHidden(0.3, 0.5)).toBe(false);
    expect(pointHidden(0.5, 0.3)).toBe(true);
    expect(pointHidden(0.5, 0.5)).toBe(false);
  });
});

// The own-light term as it was until 7 October 2026: one number per frame, the kernel at zero distance
// (ownVeilPerPixel). The pyramid's own arithmetic, run on the CPU for one splat as the shaders drew it then (a round
// cut-off; shaders.ts PYRAMID_SHADER: 2 × 2 box downsampling, the 7-tap blur, the accumulation w_k·blur_k + bilinear
// upsample of the level above, textures zero outside; BG's bilinear read), gives what the background texture really
// held of a source at its own position. The term left out the splat's own width and the fact that level kR is
// read, not level 0, and it was one number while the texture's value depends on where the source sits in the
// texels. These tests keep the size of that error on record; the exact term that replaced it is tested below.
describe('the own-light term as it was (one number per frame) against the retina pyramid run on the CPU', () => {
  const W = 1280, H = 720;
  const sigma = (k: number) => { const p = 4 ** k; return Math.sqrt(p + (p - 1) / 12 + (4 * p - 4) / 18); };
  const nLevels = Math.ceil(Math.log2(Math.max(W, H))) + 1;
  const dims: { w: number; h: number }[] = [{ w: W, h: H }];
  while (dims[dims.length - 1].w > 1 || dims[dims.length - 1].h > 1) dims.push({ w: Math.max(1, Math.ceil(dims[dims.length - 1].w / 2)), h: Math.max(1, Math.ceil(dims[dims.length - 1].h / 2)) });
  const TAPS = [0.39905027, 0.24203623, 0.05400558, 0.00443305];
  const splatPx = 0.6, extent = 3 * splatPx, norm = 1 / (1 - Math.exp(-9 / 2));   // renderer.ts SIGMA_MIN_PX, SPLAT_EXTENT_SIGMA

  /** The texture of level kR read at (rx, ry) px, for one source of unit illuminance at (cx, cy) px, per pixel solid angle. */
  function pyramidAt(weights: number[], kR: number, cx: number, cy: number, rx: number, ry: number): number {
    // PT: the splat's fragments (pixel centres within the extent)
    const px: { x: number; y: number; g: number }[] = [];
    for (let y = Math.floor(cy - extent - 1); y <= cy + extent + 1; y++) for (let x = Math.floor(cx - extent - 1); x <= cx + extent + 1; x++) {
      const r2 = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2;
      if (r2 <= extent * extent && x >= 0 && y >= 0 && x < W && y < H) px.push({ x, y, g: (Math.exp(-r2 / (2 * splatPx * splatPx)) / (2 * Math.PI * splatPx * splatPx)) * norm });
    }
    const inside = (k: number, X: number, Y: number) => X >= 0 && Y >= 0 && X < dims[k].w && Y < dims[k].h;
    // level k before its blur: k box downsamples of PT (zero outside every texture on the way)
    const lvl = (k: number, X: number, Y: number) => {
      if (!inside(k, X, Y)) return 0;
      let v = 0;
      for (const p of px) if (p.x >> k === X && p.y >> k === Y) v += p.g;
      return v / 4 ** k;
    };
    const blur = (k: number, X: number, Y: number) => {
      let v = 0;
      for (let j = -3; j <= 3; j++) {
        if (Y + j < 0 || Y + j >= dims[k].h) continue;   // the horizontal pass's texture, zero outside
        for (let i = -3; i <= 3; i++) v += TAPS[Math.abs(i)] * TAPS[Math.abs(j)] * lvl(k, X + i, Y + j);
      }
      return v;
    };
    const memo = new Map<string, number>();
    const acc = (k: number, X: number, Y: number): number => {
      if (k >= dims.length || !inside(k, X, Y)) return 0;
      const key = `${k},${X},${Y}`;
      const hit = memo.get(key);
      if (hit !== undefined) return hit;
      const c = [(X + 0.5) * 0.5 - 0.5, (Y + 0.5) * 0.5 - 0.5];
      const i0 = [Math.floor(c[0]), Math.floor(c[1])], f = [c[0] - Math.floor(c[0]), c[1] - Math.floor(c[1])];
      const up = (acc(k + 1, i0[0], i0[1]) * (1 - f[0]) + acc(k + 1, i0[0] + 1, i0[1]) * f[0]) * (1 - f[1])
        + (acc(k + 1, i0[0], i0[1] + 1) * (1 - f[0]) + acc(k + 1, i0[0] + 1, i0[1] + 1) * f[0]) * f[1];
      const v = ((weights[k] ?? 0) > 0 ? weights[k] * blur(k, X, Y) : 0) + up;
      memo.set(key, v);
      return v;
    };
    // BG's read: bilinear between texel centres, indices clamped to the texture
    const c = [rx / 2 ** kR - 0.5, ry / 2 ** kR - 0.5];
    const i0 = [Math.floor(c[0]), Math.floor(c[1])], f = [c[0] - Math.floor(c[0]), c[1] - Math.floor(c[1])];
    const cl = (X: number, Y: number) => acc(kR, Math.min(Math.max(X, 0), dims[kR].w - 1), Math.min(Math.max(Y, 0), dims[kR].h - 1));
    return (cl(i0[0], i0[1]) * (1 - f[0]) + cl(i0[0] + 1, i0[1]) * f[0]) * (1 - f[1]) + (cl(i0[0], i0[1] + 1) * (1 - f[0]) + cl(i0[0] + 1, i0[1] + 1) * f[0]) * f[1];
  }
  /** The source's own light where the shaders read it: at its own position. */
  const ownInPyramid = (weights: number[], kR: number, cx: number, cy: number) => pyramidAt(weights, kR, cx, cy, cx, cy);
  // 36 positions spread over a 64 × 64 px block near the frame's centre: every phase of the texels up to level 6
  const positions: [number, number][] = [];
  for (let i = 0; i < 36; i++) positions.push([608 + 64 * ((i * 0.61803398875) % 1), 328 + 64 * ((i * 0.75487766625) % 1)]);

  const fits = [50, 20].map((fov) => {
    const fit = fitScatterKernel(Array.from({ length: nLevels }, (_, k) => ({ sigmaPx: sigma(k) })), fov / H, Math.hypot(W, H), 25, 0.5);
    return { fov, weights: fit.weights, levels: fit.weights.map((weight, k) => ({ weight, sigmaPx: sigma(k) })) as VeilLevel[] };
  });
  /** term / what the pyramid holds: over the positions, [mean, smallest, largest]. */
  const ratio = (f: (typeof fits)[number], kR: number) => {
    const got = positions.map(([x, y]) => ownInPyramid(f.weights, kR, x, y));
    const term = ownVeilPerPixel(f.levels, kR);
    const mean = got.reduce((a, b) => a + b, 0) / got.length;
    return [term / mean, term / Math.max(...got), term / Math.min(...got)];
  };
  it('read at level 0 with weight there (a light-adapted eye at a 50° field), the term is 45 % more than the texture holds', () => {
    const [mean, lo, hi] = ratio(fits[0], 0);
    expect(fits[0].weights[0]).toBeGreaterThan(0.1);
    expect(mean).toBeGreaterThan(1.4);
    expect(mean).toBeLessThan(1.5);
    // more at every position: the background of every source then comes out too dark, never too bright
    expect(lo).toBeGreaterThan(1.25);
    expect(hi).toBeLessThan(1.65);
  });
  it('read at level 1 and coarser, the term is within 6 % of the texture\'s mean over positions, on either side', () => {
    for (const f of fits) for (let kR = 1; kR <= 6; kR++) {
      const [mean] = ratio(f, kR);
      expect(Math.abs(mean - 1), `fov ${f.fov}° level ${kR}`).toBeLessThan(0.06);
    }
    // at a 20° field level 0 has no weight; read there the texture is level 1's term seen through one more upsample
    expect(fits[1].weights[0]).toBe(0);
    expect(ratio(fits[1], 0)[0]).toBeGreaterThan(1.05);
    expect(ratio(fits[1], 0)[0]).toBeLessThan(1.15);
  });
  it('at one position the texture holds up to a quarter more or less than its mean: no single number per frame can be exact', () => {
    for (const f of fits) for (let kR = 0; kR <= 6; kR++) {
      const got = positions.map(([x, y]) => ownInPyramid(f.weights, kR, x, y));
      const mean = got.reduce((a, b) => a + b, 0) / got.length;
      expect(Math.max(...got) / mean, `fov ${f.fov}° level ${kR}`).toBeLessThan(1.25);
      expect(Math.min(...got) / mean, `fov ${f.fov}° level ${kR}`).toBeGreaterThan(0.75);
      // and the spread is real, not rounding: more than 10 % between the extremes at every level
      expect(Math.max(...got) / Math.min(...got), `fov ${f.fov}° level ${kR}`).toBeGreaterThan(1.1);
    }
  });
  it('the CPU pyramid keeps a source\'s light: each level alone spreads the whole splat over the full-resolution veil', () => {
    // the veil at full resolution (level 0's texture) summed over the pixels around the source, one level at a time
    for (const k of [0, 1, 2]) {
      const w = Array.from({ length: nLevels }, (_, j) => (j === k ? 1 : 0));
      const half = 8 * 2 ** k;
      let sum = 0;
      for (let y = 360 - half; y < 360 + half; y++) for (let x = 640 - half; x < 640 + half; x++) sum += pyramidAt(w, 0, 640.3, 360.7, x + 0.5, y + 0.5);
      expect(Math.abs(sum - 1), `level ${k}`).toBeLessThan(5e-3);
    }
  });
});

// The exact own-light term (eye/points.ts ownVeilExact) against the retina pyramid run in full, in two dimensions,
// on the CPU: PYRAMID_SHADER's passes level by level over whole images, with no factorisation and no knowledge of
// where the source is. The property the cull needs: a source alone on a dark background is judged against zero,
// wherever it sits in the pixels and whichever level is read.
describe('a point source\'s own light in its background, exactly: the product form against the pyramid run in two dimensions', () => {
  type Img = Float64Array | Float32Array;
  type Ctor = Float64ArrayConstructor | Float32ArrayConstructor;
  interface Src { x: number; y: number; E: number }
  const sizes = (W: number, H: number) => {
    const d = [{ w: W, h: H }];
    while (d[d.length - 1].w > 1 || d[d.length - 1].h > 1) d.push({ w: Math.max(1, Math.ceil(d[d.length - 1].w / 2)), h: Math.max(1, Math.ceil(d[d.length - 1].h / 2)) });
    return d;
  };
  /** The point image: every source's splat, a Gaussian per axis sampled at the pixel centres within the cut-off. */
  function pointImage(W: number, H: number, splat: PointSplat, sources: Src[], A: Ctor): Img {
    const im = new A(W * H);
    const N = splatNorm(splat), e = splat.extentPx, s2 = 2 * splat.sigmaPx * splat.sigmaPx;
    for (const q of sources) {
      for (let y = Math.max(0, Math.floor(q.y - e - 1)); y <= Math.min(H - 1, Math.ceil(q.y + e + 1)); y++) {
        for (let x = Math.max(0, Math.floor(q.x - e - 1)); x <= Math.min(W - 1, Math.ceil(q.x + e + 1)); x++) {
          const dx = x + 0.5 - q.x, dy = y + 0.5 - q.y;
          if (Math.abs(dx) > e || Math.abs(dy) > e) continue;
          im[y * W + x] += q.E * N * Math.exp(-(dx * dx + dy * dy) / s2);
        }
      }
    }
    return im;
  }
  /** PYRAMID_SHADER on whole images: down, blurH, blurV (levels with weight), accum from the top; acc of every level. */
  function veilPyramid(W: number, H: number, weights: readonly number[], base: Img, A: Ctor): { w: number; h: number; data: Img }[] {
    const d = sizes(W, H);
    expect(weights.length).toBe(d.length);
    const lvl: Img[] = [base];
    for (let k = 1; k < d.length; k++) {
      const { w, h } = d[k], pw = d[k - 1].w, ph = d[k - 1].h, src = lvl[k - 1], o = new A(w * h);
      const ld = (x: number, y: number) => (x < pw && y < ph ? src[y * pw + x] : 0);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o[y * w + x] = (ld(2 * x, 2 * y) + ld(2 * x + 1, 2 * y) + ld(2 * x, 2 * y + 1) + ld(2 * x + 1, 2 * y + 1)) * 0.25;
      lvl.push(o);
    }
    const acc: { w: number; h: number; data: Img }[] = new Array(d.length);
    let above: Img = new A(1), aw = 1, ah = 1, top = true;
    for (let k = d.length - 1; k >= 0; k--) {
      const { w, h } = d[k], o = new A(w * h);
      let blur: Img | null = null;
      if (weights[k] > 0) {
        const src = lvl[k], tmp = new A(w * h);
        blur = new A(w * h);
        const at = (im: Img, x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? im[y * w + x] : 0);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          let v = at(src, x, y) * VEIL_BLUR_TAPS[0];
          for (let t = 1; t <= 3; t++) v += (at(src, x + t, y) + at(src, x - t, y)) * VEIL_BLUR_TAPS[t];
          tmp[y * w + x] = v;
        }
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          let v = at(tmp, x, y) * VEIL_BLUR_TAPS[0];
          for (let t = 1; t <= 3; t++) v += (at(tmp, x, y + t) + at(tmp, x, y - t)) * VEIL_BLUR_TAPS[t];
          blur[y * w + x] = v;
        }
      }
      const prev = above, pw = aw, ph = ah, isTop = top;
      const ld = (x: number, y: number) => (!isTop && x >= 0 && y >= 0 && x < pw && y < ph ? prev[y * pw + x] : 0);
      const mix = (p: number, q: number, t: number) => p * (1 - t) + q * t;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const cx = (x + 0.5) * 0.5 - 0.5, cy = (y + 0.5) * 0.5 - 0.5;
        const ix = Math.floor(cx), iy = Math.floor(cy), fx = cx - ix, fy = cy - iy;
        o[y * w + x] = (blur ? weights[k] * blur[y * w + x] : 0) + mix(mix(ld(ix, iy), ld(ix + 1, iy), fx), mix(ld(ix, iy + 1), ld(ix + 1, iy + 1), fx), fy);
      }
      acc[k] = { w, h, data: o };
      above = o; aw = w; ah = h; top = false;
    }
    return acc;
  }
  /** The read: linear between the texels of level kR on that level's own grid, indices clamped. */
  function readAt(level: { w: number; h: number; data: Img }, kR: number, x: number, y: number): number {
    const cx = x / 2 ** kR - 0.5, cy = y / 2 ** kR - 0.5;
    const ix = Math.floor(cx), iy = Math.floor(cy), fx = cx - ix, fy = cy - iy;
    const at = (X: number, Y: number) => level.data[Math.min(Math.max(Y, 0), level.h - 1) * level.w + Math.min(Math.max(X, 0), level.w - 1)];
    return (at(ix, iy) * (1 - fx) + at(ix + 1, iy) * fx) * (1 - fy) + (at(ix, iy + 1) * (1 - fx) + at(ix + 1, iy + 1) * fx) * fy;
  }
  let seed = 20261007;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  /** Positions over the frame, with the edges, the corners and centres just outside it. */
  const positionsIn = (W: number, H: number, n: number, e: number): [number, number][] => {
    const p: [number, number][] = [];
    for (let i = 0; i < n; i++) p.push([rnd() * W, rnd() * H]);
    p.push([0.3, 0.2], [W - 0.4, H - 0.3], [W / 2, H / 2], [W / 2 + 0.5, H / 2 + 0.5], [1.9, H - 2.2], [W - 1.1, 3.3], [-0.6 * e, H / 3], [W / 3, H + 0.5 * e]);
    return p;
  };
  // frames with even and odd sizes at every level, and splats from the reconstruction minimum to a narrow field's
  const cases: { W: number; H: number; splat: PointSplat }[] = [
    { W: 96, H: 54, splat: { sigmaPx: 0.6, extentPx: 1.8 } },
    { W: 97, H: 61, splat: { sigmaPx: 0.6, extentPx: 1.8 } },
    { W: 131, H: 77, splat: { sigmaPx: 1.613, extentPx: 4.839 } },
    { W: 160, H: 91, splat: { sigmaPx: 8.058, extentPx: 24.174 } },
  ];
  const someWeights = (K: number) => [0.173, 0.0829, 0, 0.0241, 0.014, 0.0112, 0.00867, 0.0098, 0.0383, 0, 0.000587, 0.02].slice(0, K);

  it('equals the pyramid at every position, at every level read, in even and odd frames, for narrow and wide splats', () => {
    let worst = 0, checked = 0;
    for (const c of cases) {
      const K = sizes(c.W, c.H).length, w = someWeights(K);
      for (const [x, y] of positionsIn(c.W, c.H, 24, c.splat.extentPx)) {
        const acc = veilPyramid(c.W, c.H, w, pointImage(c.W, c.H, c.splat, [{ x, y, E: 1 }], Float64Array), Float64Array);
        for (let kR = 0; kR < K; kR++) {
          const tex = readAt(acc[kR], kR, x, y), own = ownVeilExact(x, y, c.W, c.H, c.splat, kR, w);
          if (tex === 0 && own === 0) continue;
          worst = Math.max(worst, Math.abs(own - tex) / tex);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(700);
    expect(worst).toBeLessThan(1e-12);
  });

  it('level by level: each level\'s part alone is rho_k(x)·rho_k(y), so no level\'s error hides behind a heavier one', () => {
    const c = cases[1], K = sizes(c.W, c.H).length;
    let worst = 0;
    for (const [x, y] of positionsIn(c.W, c.H, 6, c.splat.extentPx)) {
      const base = pointImage(c.W, c.H, c.splat, [{ x, y, E: 1 }], Float64Array);
      for (let k = 0; k < K; k++) {
        const w = Array.from({ length: K }, (_, j) => (j === k ? 1 : 0));
        const acc = veilPyramid(c.W, c.H, w, base, Float64Array);
        for (let kR = 0; kR <= k; kR++) {
          const tex = readAt(acc[kR], kR, x, y);
          const rx = ownVeilAxis(x, c.W, c.splat, kR, w), ry = ownVeilAxis(y, c.H, c.splat, kR, w);
          if (tex === 0) { expect(rx[k] * ry[k]).toBe(0); continue; }
          worst = Math.max(worst, Math.abs(rx[k] * ry[k] * splatNorm(c.splat) - tex) / tex);
        }
      }
    }
    expect(worst).toBeLessThan(1e-12);
  });

  it('a source alone on a dark background is judged against zero: nothing of its own light is left, at any position or level', () => {
    const E = { Y: 3.2e-7, S: 6.9e-7 }, omega = 1.68e-6;   // a 2nd magnitude star, a pixel of a 50° field at 720 px
    for (const c of cases.slice(0, 3)) {
      const K = sizes(c.W, c.H).length, w = someWeights(K);
      for (const [x, y] of positionsIn(c.W, c.H, 12, c.splat.extentPx)) {
        const acc = veilPyramid(c.W, c.H, w, pointImage(c.W, c.H, c.splat, [{ x, y, E: 1 }], Float64Array), Float64Array);
        for (let kR = 0; kR < K; kR++) {
          const tex = readAt(acc[kR], kR, x, y) / omega, own = ownVeilExact(x, y, c.W, c.H, c.splat, kR, w) / omega;
          const bg = veilBackground({ Y: E.Y * tex, S: E.S * tex }, { Y: E.Y * own, S: E.S * own }, { Y: 0, S: 0 });
          expect(bg.Y, `${c.W}x${c.H} (${x}, ${y}) level ${kR}`).toBeLessThanOrEqual(1e-12 * E.Y * own);
          expect(bg.S).toBeLessThanOrEqual(1e-12 * E.S * own);
          expect(bg.Y).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('beside a neighbour, what is left is the neighbour\'s light there and nothing else', () => {
    const c = cases[1], K = sizes(c.W, c.H).length, w = someWeights(K);
    for (let i = 0; i < 12; i++) {
      const a: Src = { x: 20 + rnd() * 50, y: 15 + rnd() * 30, E: 1 };
      const b: Src = { x: a.x + (rnd() - 0.5) * 9, y: a.y + (rnd() - 0.5) * 9, E: 10 ** (4 * rnd() - 2) };   // from overlapping to 4.5 px away, 1/100 to 100 times as bright
      const both = veilPyramid(c.W, c.H, w, pointImage(c.W, c.H, c.splat, [a, b], Float64Array), Float64Array);
      const alone = veilPyramid(c.W, c.H, w, pointImage(c.W, c.H, c.splat, [b], Float64Array), Float64Array);
      for (let kR = 0; kR < 5; kR++) {
        const own = ownVeilExact(a.x, a.y, c.W, c.H, c.splat, kR, w);
        const left = readAt(both[kR], kR, a.x, a.y) - own, others = readAt(alone[kR], kR, a.x, a.y);
        expect(Math.abs(left - others), `pair ${i} level ${kR}`).toBeLessThan(1e-12 * (own + others));
      }
    }
  });

  it('in single precision, as the GPU stores it, what is left of a lone source is under a millionth of its own light', () => {
    let worst = 0;
    for (const c of cases.slice(0, 3)) {
      const K = sizes(c.W, c.H).length, w = someWeights(K);
      const w32 = w.map((v) => Math.fround(v));
      for (const [x, y] of positionsIn(c.W, c.H, 12, c.splat.extentPx)) {
        const acc = veilPyramid(c.W, c.H, w32, pointImage(c.W, c.H, c.splat, [{ x, y, E: 1 }], Float32Array), Float32Array);
        for (let kR = 0; kR < K; kR++) {
          const tex = readAt(acc[kR], kR, x, y), own = ownVeilExact(x, y, c.W, c.H, c.splat, kR, w32);
          if (own === 0) { expect(tex).toBe(0); continue; }
          worst = Math.max(worst, Math.abs(tex - own) / own);
        }
      }
    }
    expect(worst).toBeLessThan(1e-6);
    expect(worst).toBeGreaterThan(0);   // it is rounding, not an identity of the test with itself
  });

  it('with the point image stored in half floats (the fallback without float32 blending) what is left is under a thousandth', () => {
    // a half float keeps 11 significant bits; a GPU may round to nearest or toward zero when it stores one
    const half = (v: number, floor: boolean) => {
      if (v === 0) return 0;
      const e = Math.floor(Math.log2(v)), m = (v / 2 ** e) * 1024;
      return ((floor ? Math.floor(m) : Math.round(m)) / 1024) * 2 ** e;
    };
    for (const floor of [false, true]) {
      let worst = 0;
      for (const c of cases.slice(0, 3)) {
        const K = sizes(c.W, c.H).length, w = someWeights(K).map((v) => Math.fround(v));
        for (const [x, y] of positionsIn(c.W, c.H, 10, c.splat.extentPx)) {
          const base = pointImage(c.W, c.H, c.splat, [{ x, y, E: 1 }], Float32Array).map((v) => half(v, floor));
          const acc = veilPyramid(c.W, c.H, w, base, Float32Array);
          for (let kR = 0; kR < K; kR++) {
            const own = ownVeilExact(x, y, c.W, c.H, c.splat, kR, w);
            if (own > 0) worst = Math.max(worst, Math.abs(readAt(acc[kR], kR, x, y) - own) / own);
          }
        }
      }
      expect(worst, floor ? 'rounded toward zero' : 'rounded to nearest').toBeLessThan(1e-3);
      expect(worst).toBeGreaterThan(1e-5);   // and it is far from the float32 bound: the storage is what limits it
    }
  });

  it('a splat cut by the frame: only the part inside is in the point image, and only that is taken out', () => {
    const c = cases[0], K = sizes(c.W, c.H).length, w = someWeights(K);
    // wholly outside: nothing in the image, nothing to take out
    expect(ownVeilExact(-c.splat.extentPx - 0.6, 20, c.W, c.H, c.splat, 0, w)).toBe(0);
    // half outside: less than the same source well inside
    const inside = ownVeilExact(40.5, 20.5, c.W, c.H, c.splat, 0, w), half = ownVeilExact(0, 20.5, c.W, c.H, c.splat, 0, w);
    expect(half).toBeGreaterThan(0.3 * inside);
    expect(half).toBeLessThan(0.8 * inside);
  });

  it('one splat\'s samples sum to between 0.99 and 1.005 at the smallest splat, to one on average; and erf is erf', () => {
    expect(erf(0.5)).toBeCloseTo(0.5204998778130465, 14);
    expect(erf(3 / Math.SQRT2)).toBeCloseTo(0.9973002039367398, 14);
    expect(erf(-1)).toBeCloseTo(-0.8427007929497149, 14);
    expect(Math.abs(erf(2.5 - 1e-9) - erf(2.5 + 1e-9))).toBeLessThan(1e-11);   // the two branches meet
    const splat = cases[0].splat;
    // The normalisation is the integral's, not each splat's sum: a pixel centre crossing the hard cut-off at 3σ
    // carries e^−4.5 of the peak, so the sum steps with the sub-pixel position. A point's light in the point image
    // is therefore right to a percent, not to the 2·10⁻³ of an uncut Gaussian on the pixel grid.
    let lo = Infinity, hi = 0, mean = 0;
    const n = 400;
    for (let i = 0; i < n; i++) {
      const x = 40 + rnd(), y = 25 + rnd();
      let sum = 0;
      for (const v of pointImage(96, 54, splat, [{ x, y, E: 1 }], Float64Array)) sum += v;
      lo = Math.min(lo, sum); hi = Math.max(hi, sum); mean += sum / n;
    }
    expect(lo).toBeGreaterThan(0.989);
    expect(lo).toBeLessThan(0.995);
    expect(hi).toBeLessThan(1.006);
    expect(hi).toBeGreaterThan(1.002);
    expect(Math.abs(mean - 1)).toBeLessThan(1.5e-3);
  });

  it('the kernel at zero distance is not that number: 30 to 60 % more at level 0, a fifth either way above (1280 × 720, 50°)', () => {
    const W = 1280, H = 720, K = sizes(W, H).length;
    const sig = (k: number) => { const p = 4 ** k; return Math.sqrt(p + (p - 1) / 12 + (4 * p - 4) / 18); };
    const fit = fitScatterKernel(Array.from({ length: K }, (_, k) => ({ sigmaPx: sig(k) })), 50 / H, Math.hypot(W, H), 25, 0.5);
    const levels: VeilLevel[] = fit.weights.map((weight, k) => ({ weight, sigmaPx: sig(k) }));
    const splat = { sigmaPx: 0.6, extentPx: 1.8 };
    const range = (kR: number) => {
      const term = ownVeilPerPixel(levels, kR);
      let lo = Infinity, hi = 0;
      for (let i = 0; i < 300; i++) {
        const r = term / ownVeilExact(100 + rnd() * 1000, 100 + rnd() * 500, W, H, splat, kR, fit.weights);
        lo = Math.min(lo, r); hi = Math.max(hi, r);
      }
      return [lo, hi];
    };
    const [lo0, hi0] = range(0);
    expect(lo0).toBeGreaterThan(1.25);
    expect(hi0).toBeLessThan(1.65);
    for (let kR = 1; kR <= 5; kR++) {
      const [lo, hi] = range(kR);
      expect(lo, `level ${kR}`).toBeGreaterThan(0.78);
      expect(hi, `level ${kR}`).toBeLessThan(1.28);
      expect(hi / lo, `level ${kR}`).toBeGreaterThan(1.2);
    }
  });
});
