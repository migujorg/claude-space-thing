// Display output (eye/display.ts, eye/tonemap.ts; docs/eye-model.md §7): colour spaces derived from their
// primaries, the extended sRGB curve of HDR canvases, the gamut ceiling, and highlights above SDR white.
import { describe, expect, it } from 'vitest';
import { DISPLAY_P3, P3_TO_XYZ, XYZ_TO_P3, XYZ_TO_SRGB, gamutMap, gamutMapTo, mul, rgbToXyzFromPrimaries, srgbEncode, srgbEncodeExtended, SRGB_TO_XYZ } from '../src/eye/display';
import { displayObserver, inverseDisplay, response } from '../src/eye/tonemap';
import { SRGB } from '../src/eye/constants';

describe('colour spaces', () => {
  it('the sRGB matrix built from the IEC 61966-2-1 primaries matches the standard matrix', () => {
    const m = rgbToXyzFromPrimaries([0.64, 0.33], [0.3, 0.6], [0.15, 0.06], [SRGB.whiteX, SRGB.whiteY]);
    for (let i = 0; i < 9; i++) expect(m[i]).toBeCloseTo(SRGB_TO_XYZ[i], 3);
  });
  it('XYZ → linear Display P3 matches CSS Color 4 (P3-D65 primaries)', () => {
    // CSS Color Module Level 4, sample code: XYZ (D65) → linear display-p3.
    const css = [446124 / 178915, -333277 / 357830, -72051 / 178915, -14852 / 17905, 63121 / 35810, 423 / 17905, 11844 / 330415, -50337 / 660830, 316169 / 330415];
    for (let i = 0; i < 9; i++) expect(XYZ_TO_P3[i]).toBeCloseTo(css[i], 3);
    expect(DISPLAY_P3.r).toEqual([0.68, 0.32]);
    // White maps to (1, 1, 1) in both spaces.
    const w: [number, number, number] = [SRGB.whiteX / SRGB.whiteY, 1, (1 - SRGB.whiteX - SRGB.whiteY) / SRGB.whiteY];
    for (const v of [...mul(XYZ_TO_P3, w), ...mul(XYZ_TO_SRGB, w)]) expect(v).toBeCloseTo(1, 3);
    expect(P3_TO_XYZ[3] + P3_TO_XYZ[4] + P3_TO_XYZ[5]).toBeCloseTo(1, 9);
  });
  it('the extended sRGB curve equals the standard one on [0, 1] and continues above 1 (WebGPU spec example)', () => {
    for (const c of [0, 0.001, 0.2, 0.5, 1]) expect(srgbEncodeExtended(c)).toBeCloseTo(srgbEncode(c), 12);
    // WebGPU §21.5: encoded (2.5, −0.15, −0.15) on an 'srgb' canvas is (2.3, 0.545, 0.386) in Display P3.
    const dec = (v: number) => Math.sign(v) * Math.pow((Math.abs(v) + 0.055) / 1.055, 2.4);
    const lin = [dec(2.5), dec(-0.15), dec(-0.15)] as [number, number, number];
    const p3 = mul(XYZ_TO_P3, mul(SRGB_TO_XYZ, lin)).map(srgbEncodeExtended);
    expect(p3[0]).toBeCloseTo(2.3, 1);
    expect(p3[1]).toBeCloseTo(0.545, 2);
    expect(p3[2]).toBeCloseTo(0.386, 2);
  });
});

describe('gamut ceiling and HDR highlights', () => {
  it('gamutMapTo(·, 1) is the SDR gamut map; a higher ceiling keeps highlights up to it', () => {
    const y = [SRGB_TO_XYZ[3], SRGB_TO_XYZ[4], SRGB_TO_XYZ[5]];
    for (const c of [[0.2, 0.5, 0.9], [1.4, 0.2, 0.1], [-0.1, 0.4, 0.3], [3, 3, 3]] as [number, number, number][]) {
      const a = gamutMapTo(c, 1, y), b = gamutMap(c);
      for (let k = 0; k < 3; k++) expect(a[k]).toBeCloseTo(b[k], 12);
    }
    expect(gamutMapTo([3, 3, 3], 5, y)).toEqual([3, 3, 3]);
    const h = gamutMapTo([8, 1, 1], 5, y);
    expect(Math.max(...h)).toBeCloseTo(5, 9);
    // Luminance kept.
    expect(y[0] * h[0] + y[1] * h[1] + y[2] * h[2]).toBeCloseTo(y[0] * 8 + y[1] + y[2], 9);
  });
  it('the display observer keeps its reference white; HDR shows responses above white up to the peak', () => {
    const sdr = displayObserver(200, 0);
    const hdr = displayObserver(200, 0, 1000);
    expect(hdr.white).toBe(sdr.white);
    expect(sdr.maxLd).toBe(200);
    expect(hdr.maxLd).toBe(1000);
    const R = response(500, sdr.sigma, sdr.B);
    expect(inverseDisplay(R, sdr)).toBe(200);
    expect(inverseDisplay(R, hdr)).toBeCloseTo(500, 6);
    expect(inverseDisplay(response(5000, hdr.sigma, hdr.B), hdr)).toBe(1000);
    // Below white both agree.
    const r2 = response(50, sdr.sigma, sdr.B);
    expect(inverseDisplay(r2, hdr)).toBeCloseTo(inverseDisplay(r2, sdr), 9);
  });
});
