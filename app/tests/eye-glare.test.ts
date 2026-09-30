import { describe, expect, it } from 'vitest';
import { cie146, fitScatterKernel, nnls, opticalCoreSigmaDeg, scatterFraction, watsonMTF } from '../src/eye/glare';

describe('CIE 146:2002 general disability glare equation', () => {
  it('hand-computed value at 1°, age 25, p = 0.5', () => {
    // 10 + (5 + 0.05)·(1 + (25/62.5)^4) + 0.00125
    expect(cie146(1, 25, 0.5)).toBeCloseTo(10 + 5.05 * (1 + 0.4 ** 4) + 0.00125, 10);
  });
  it('is zero outside 0.1°–100° and decreasing inside', () => {
    expect(cie146(0.05, 25, 0.5)).toBe(0);
    expect(cie146(120, 25, 0.5)).toBe(0);
    let prev = Infinity;
    for (let t = 0.1; t <= 100; t *= 1.5) { const v = cie146(t, 25, 0.5); expect(v).toBeLessThan(prev); prev = v; }
  });
  it('scatters a physically sensible fraction of the light, increasing with age', () => {
    const s25 = scatterFraction(25, 0.5);
    expect(s25).toBeGreaterThan(0.1);
    expect(s25).toBeLessThan(0.5);
    expect(scatterFraction(70, 0.5)).toBeGreaterThan(s25);
  });
});

describe('Watson (2013) optical MTF', () => {
  it('is 1 at DC, decreasing, zero beyond the diffraction cutoff', () => {
    expect(watsonMTF(0, 3)).toBeCloseTo(1, 12);
    expect(watsonMTF(10, 3)).toBeLessThan(watsonMTF(5, 3));
    expect(watsonMTF(200, 3)).toBe(0);
  });
  it('gives an arcminute-scale PSF core for 2–7 mm pupils', () => {
    for (const d of [2, 3, 4, 5, 6, 7]) {
      const arcmin = opticalCoreSigmaDeg(d) * 60;
      expect(arcmin).toBeGreaterThan(0.1);
      expect(arcmin).toBeLessThan(3);
    }
  });
});

describe('scatter-kernel fit used by the glare pyramid', () => {
  it('NNLS solves a trivial non-negative problem', () => {
    const x = nnls([[1, 0], [0, 1], [1, 1]], [1, -1, 0.5]);
    expect(x[1]).toBe(0);
    expect(x[0]).toBeGreaterThan(0);
  });
  it('scatters the same fraction of light at every display resolution (720p … 4K), never > 100 %', () => {
    const totals: number[] = [];
    for (const [W, H] of [[1280, 720], [1920, 1080], [2560, 1440], [3840, 2160]]) {
      const n = Math.ceil(Math.log2(Math.max(W, H))) + 1;
      const levels = Array.from({ length: n }, (_, k) => {
        const p = 4 ** k;
        return { sigmaPx: Math.sqrt(p + (p - 1) / 12 + (4 * p - 4) / 18) };
      });
      totals.push(fitScatterKernel(levels, 50 / H, Math.hypot(W, H), 25, 0.5).total);
    }
    for (const t of totals) {
      expect(t).toBeLessThan(0.6);
      expect(Math.abs(t / totals[0] - 1)).toBeLessThan(0.2);
    }
  });
  it('scatters a physical fraction at every field of view (5°–150°): wide fields no longer go black', () => {
    for (const [W, H] of [[1280, 720], [1920, 1080], [3840, 2160]]) {
      const n = Math.ceil(Math.log2(Math.max(W, H))) + 1;
      const levels = Array.from({ length: n }, (_, k) => {
        const p = 4 ** k;
        return { sigmaPx: Math.sqrt(p + (p - 1) / 12 + (4 * p - 4) / 18) };
      });
      for (const fov of [5, 20, 60, 90, 110, 130, 150]) {
        const pixelDeg = ((2 * Math.tan((fov * Math.PI) / 360)) / H) * (180 / Math.PI);
        const fit = fitScatterKernel(levels, pixelDeg, Math.hypot(W, H), 25, 0.5);
        // Never more than the CIE 146 kernel scatters in total (≈ 0.4 at age 25), never close to 1.
        expect(fit.total).toBeGreaterThan(0.1);
        expect(fit.total).toBeLessThan(0.5);
        // The in-frame part matches the target energy it is fitted to (the fit also honours the zero beyond 100°).
        expect(Math.abs(fit.fittedInRange / fit.target - 1)).toBeLessThan(0.15);
      }
    }
  });
  it('the sum of Gaussians reproduces the CIE profile and its energy within a few percent', () => {
    const levels = Array.from({ length: 11 }, (_, k) => ({ sigmaPx: 0.8 * 2 ** k }));
    const pixelDeg = 60 / 720;
    const fit = fitScatterKernel(levels, pixelDeg, 1500, 25, 0.5);
    expect(Math.abs(fit.fittedInRange / fit.target - 1)).toBeLessThan(0.03);
    expect(fit.total).toBeGreaterThanOrEqual(fit.fittedInRange);
    expect(fit.total).toBeLessThan(1);
    expect(fit.weights.every((w) => w >= 0)).toBe(true);
    const pxSr = ((pixelDeg * Math.PI) / 180) ** 2;
    for (const r of [1.5, 3, 6, 12, 24, 48, 96, 192, 384]) {
      const model = levels.reduce((s, l, k) => s + (fit.weights[k] * Math.exp((-r * r) / (2 * l.sigmaPx ** 2))) / (2 * Math.PI * l.sigmaPx ** 2), 0);
      const target = cie146(r * pixelDeg, 25, 0.5) * pxSr;
      expect(Math.abs(model / target - 1)).toBeLessThan(0.1);
    }
  });
});
