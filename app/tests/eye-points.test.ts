// Point sources: Ricco summation sets brightness (never size), glare is painted only for light the
// display cannot show, and colour follows each source's own cone signal (eye/points.ts).
import { describe, expect, it } from 'vitest';
import { AdaptationState, computeEyeFrame } from '../src/eye/model';
import { DEFAULT_EYE_SETTINGS } from '../src/eye/settings';
import { backgroundLevel, cullBackground, intendedDisplayLd, ownVeilPerPixel, pointAppearance, pointObserver, pointVeil, pointVisible, veilKernelPerPixel, type PointSource, type VeilLevel } from '../src/eye/points';
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
    verdicts: sources.map((s, i) => pointVisible(eye, s.E, cullBackground(texBefore[i], own(s), none))),
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
    const verdicts = sources.map((s, i) => pointVisible(eye, s.E, cullBackground(texBefore[i], own(s), none)));
    return { verdicts, tex: texOfDrawn(sources, verdicts) };
  };
  // The rule that was tried and rejected: only the sources that passed are in the image, and a source's own light
  // is subtracted only if it was drawn the frame before (one flag per source).
  const frameFlags = (sources: PointSource[], texBefore: { Y: number; S: number }[], was: boolean[]) => {
    const verdicts = sources.map((s, i) => pointVisible(eye, s.E, cullBackground(texBefore[i], was[i] ? own(s) : none, none)));
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
  it('a source\'s own light in its background is the veil kernel at zero distance, and the cull removes exactly that', () => {
    const k0 = ownVeilPerPixel(levels, kR);
    let sum = 0;
    for (let k = kR; k < levels.length; k++) sum += levels[k].weight / (2 * Math.PI * levels[k].sigmaPx ** 2);
    expect(k0).toBeCloseTo(sum, 15);
    expect(veilKernelPerPixel(levels, kR, 0)).toBe(k0);
    expect(veilKernelPerPixel(levels, kR, 3)).toBeLessThan(k0);
    // an isolated source: what is left of its background is the other light, to rounding
    const s = at(100, 100, luxFromMagnitude(5));
    const tex = add(pointVeil([s], levels, kR, pixelSr)[0], other);
    const bg = cullBackground(tex, own(s), none);
    expect(bg.Y / other.Y - 1).toBeLessThan(1e-12);
    expect(Math.abs(bg.S / other.S - 1)).toBeLessThan(1e-12);
    // and it is never negative: against a texture that does not hold the source (the first frame after a cut)
    expect(cullBackground({ Y: 0.5 * own(s).Y, S: 0 }, own(s), none)).toEqual({ Y: 0, S: 0 });
    expect(cullBackground({ Y: 0, S: 0 }, own(s), { Y: 1e-4, S: 2e-4 })).toEqual({ Y: 1e-4, S: 2e-4 });
  });
  it('the point image holds every source: one the eye cannot pick out still lights its neighbours\' background', () => {
    // a source far below the threshold, 2 px from one above it
    const faint = at(102, 100, 0.01 * thr(other));
    const seen = at(100, 100, 3 * thr(other));
    const f = frame([seen, faint], pointVeil([seen, faint], levels, kR, pixelSr).map((v) => add(v, other)));
    expect(f.verdicts).toEqual([true, false]);
    const withFaint = cullBackground(f.tex[0], own(seen), none).Y;
    const alone = cullBackground(add(pointVeil([seen], levels, kR, pixelSr)[0], other), own(seen), none).Y;
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
    expect(pointVisible(eye, star.E, cullBackground(other, own(star), none))).toBe(true);
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
    const expected = field.map((s, i) => pointVisible(eye, s.E, cullBackground(truth[i], own(s), none)));
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
