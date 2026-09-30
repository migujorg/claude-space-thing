import { describe, expect, it } from 'vitest';
import { SRGB_TO_XYZ, XYZ_TO_SRGB, cat02Matrix, displayWhiteXYZ, gamutMap, mul, mulM, srgbDecode, srgbEncode, type V3 } from '../src/eye/display';
import { applyColourExponent, displayObserver, observerState, response, sceneReferences, appearanceMap, sigmaCone, toneMap } from '../src/eye/tonemap';
import { PATTANAIK } from '../src/eye/constants';

describe('IEC 61966-2-1 sRGB', () => {
  it('XYZ→sRGB and its inverse round-trip to the identity', () => {
    const I = mulM(XYZ_TO_SRGB, SRGB_TO_XYZ);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(I[i * 3 + j]).toBeCloseTo(i === j ? 1 : 0, 12);
    const v: V3 = [0.3, 0.5, 0.2];
    const back = mul(SRGB_TO_XYZ, mul(XYZ_TO_SRGB, v));
    for (let k = 0; k < 3; k++) expect(back[k]).toBeCloseTo(v[k], 12);
  });
  it('D65 white maps to RGB (1, 1, 1) and sRGB primaries have the standard luminances', () => {
    const w = mul(XYZ_TO_SRGB, displayWhiteXYZ());
    for (const c of w) expect(c).toBeCloseTo(1, 3);
    expect(SRGB_TO_XYZ[3]).toBeCloseTo(0.2126, 3);
    expect(SRGB_TO_XYZ[4]).toBeCloseTo(0.7152, 3);
    expect(SRGB_TO_XYZ[5]).toBeCloseTo(0.0722, 3);
  });
  it('transfer function round-trips and is continuous at the linear segment', () => {
    for (const c of [0, 1e-4, 0.0031308, 0.01, 0.2, 0.5, 1]) expect(srgbDecode(srgbEncode(c))).toBeCloseTo(c, 9);
    expect(srgbEncode(1)).toBeCloseTo(1, 9);
  });
  it('gamut mapping keeps in-gamut colours, preserves Y and lands inside [0,1]', () => {
    expect(gamutMap([0.2, 0.4, 0.6])).toEqual([0.2, 0.4, 0.6]);
    const Yof = (c: V3) => SRGB_TO_XYZ[3] * c[0] + SRGB_TO_XYZ[4] * c[1] + SRGB_TO_XYZ[5] * c[2];
    for (const c of [[-0.2, 0.5, 0.3], [1.4, 0.2, 0.1], [0.1, 0.1, 3.0], [-0.1, 1.2, -0.05]] as V3[]) {
      const g = gamutMap(c);
      for (const k of g) { expect(k).toBeGreaterThanOrEqual(-1e-12); expect(k).toBeLessThanOrEqual(1 + 1e-12); }
      if (Yof(c) < 1) expect(Yof(g)).toBeCloseTo(Yof(c), 9);
    }
    expect(gamutMap([3, 3, 3])).toEqual([1, 1, 1]);
  });
  it('CAT02 with D = 1 maps the adapted white onto the display white', () => {
    const sun: V3 = [0.957, 1, 0.922];
    const M = cat02Matrix(sun, displayWhiteXYZ(), 1);
    const out = mul(M, sun);
    const w = displayWhiteXYZ();
    for (let k = 0; k < 3; k++) expect(out[k]).toBeCloseTo(w[k], 9);
  });
});

describe('Pattanaik et al. (2000) adaptation model', () => {
  it("reproduces the paper's display constants for its CRT (A = 25 cd/m²)", () => {
    // §4.3: σ_cone = 646 cd/m², B_rod = 0.0016 for A_rod = A_cone = 25.
    expect(sigmaCone(25)).toBeCloseTo(646, 0);
    expect(0.04 / (0.04 + 25)).toBeCloseTo(0.0016, 4); // Pattanaik Eq. 6 B_rod (their table)
  });
  it("reproduces the paper's display slope S_d = 0.1383 (response per log10 between REF_blk = 4 and REF_wht = 125)", () => {
    const s = sigmaCone(25);
    const Sd = (response(125, s, 1) - response(4, s, 1)) / Math.log10(125 / 4);
    expect(Sd).toBeCloseTo(0.1383, 2);
  });
  it('rods saturate in daylight and dominate in the dark', () => {
    const day = observerState(1e3, 2.3e3, false);
    expect(day.BrodAdapt).toBeLessThan(1e-4);
    const night = observerState(1e-4, 2.3e-4, false);
    const tm = toneMap(1e-4, 2.3e-4, night, appearanceMap(sceneReferences(night), displayObserver(200, 0)), displayObserver(200, 0));
    expect(tm.colourExponent).toBeLessThan(0.05);
  });
  it('"Neptune is not dark": an adapted surface at 30 AU (~20 cd/m²) is shown bright and in colour', () => {
    const d = displayObserver(200, 0);
    for (const A of [5, 20, 60]) {
      const s = observerState(A, 2.3 * A, false);
      const r = toneMap(A, 2.3 * A, s, appearanceMap(sceneReferences(s), d), d);
      expect(r.Ld / d.peak).toBeGreaterThan(0.08);
      expect(r.Ld / d.peak).toBeLessThan(0.6);
      expect(r.colourExponent).toBeGreaterThan(0.7);
    }
  });
  it('the same surface at 1 AU (~900× brighter) maps to a similar display level (adaptation)', () => {
    const d = displayObserver(200, 0);
    const at = (A: number) => {
      const s = observerState(A, 2.3 * A, false);
      return toneMap(A, 2.3 * A, s, appearanceMap(sceneReferences(s), d), d).Ld;
    };
    const ratio = at(20 * 900) / at(20);
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(4);
  });
  it('display response mapping is monotonic in scene luminance', () => {
    const d = displayObserver(200, 0);
    const s = observerState(100, 230, false);
    const m = appearanceMap(sceneReferences(s), d);
    let prev = -1;
    for (let L = 1e-3; L < 1e7; L *= 3) {
      const v = toneMap(L, 2.3 * L, s, m, d).Ld;
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
  it('uses the published exponent', () => expect(PATTANAIK.n).toBe(0.73));
  it("Pattanaik's cone path equals Hunt's: σ_cone = 5·2^(1/n)·A/F_L(A)", () => {
    for (const A of [1e-3, 0.1, 10, 1e4]) {
      const k = 1 / (5 * A + 1);
      const FL = 0.2 * k ** 4 * (5 * A) + 0.1 * (1 - k ** 4) ** 2 * Math.cbrt(5 * A); // Hunt F_L (Fairchild 2013 Eq. 12.1)
      expect(sigmaCone(A) / ((5 * Math.pow(2, 1 / 0.73) * A) / FL)).toBeCloseTo(1, 3);
    }
  });
  it('v1 (Hunt rods): adapted brightness rises monotonically from starlight to indoor levels', () => {
    const d = displayObserver(200, 0);
    let prev = 0;
    for (const A of [1e-5, 1e-4, 1e-3, 1e-2, 0.1, 1, 10]) {
      const s = observerState(A, 2.3 * A, false);
      const Ld = toneMap(A, 2.3 * A, s, appearanceMap(sceneReferences(s), d), d).Ld;
      expect(Ld).toBeGreaterThan(prev);
      prev = Ld;
    }
  });
  it('colour: full in daylight, fading through mesopic, gone in scotopic', () => {
    const d = displayObserver(200, 0);
    const k = (A: number) => { const s = observerState(A, 2.3 * A, false); return toneMap(A, 2.3 * A, s, appearanceMap(sceneReferences(s), d), d).colourExponent; };
    expect(k(1e4)).toBe(1);
    expect(k(0.1)).toBeGreaterThan(0.2);
    expect(k(0.1)).toBeLessThan(0.9);
    expect(k(1e-3)).toBeLessThan(0.1);
  });
  it('colour exponent: identity at 1, grey at 0, white stays white', () => {
    const w: [number, number, number] = [0.9505, 1, 1.089];
    const c: [number, number, number] = [0.6, 1, 0.4];
    const id = applyColourExponent(c, w, 1);
    for (let i = 0; i < 3; i++) expect(id[i]).toBeCloseTo(c[i], 9);
    const g = applyColourExponent(c, w, 0);
    for (let i = 0; i < 3; i++) expect(g[i]).toBeCloseTo(w[i], 9);
    const ww = applyColourExponent(w, w, 0.3);
    for (let i = 0; i < 3; i++) expect(ww[i]).toBeCloseTo(w[i], 9);
  });
});
