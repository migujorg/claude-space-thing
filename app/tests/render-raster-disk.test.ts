import { expect, it } from 'vitest';
import { LAMBERT_LAW, LAW, lawDiskIntegral } from '../src/render/spatial';
import { rasterDisk, sliverCosine } from '../src/render/raster-disk';

it('the Minnaert effective cosine has its removable k=1 limit', () => {
  expect(sliverCosine(0.2, 1)).toBeCloseTo(0.2 / Math.sqrt(Math.E), 14);
  for (const k of [0.788, 0.79, 0.9717, 1.4386]) {
    const mu = sliverCosine(0.2, k);
    expect(mu ** (k - 1)).toBeCloseTo(2 / (k + 1) * 0.2 ** (k - 1), 12);
  }
});

it('integrates a subpixel crescent instead of losing it between pixel centres', () => {
  const law = { ...LAMBERT_LAW, kind: LAW.minnaert, p: 0.788 };
  const alpha = 179 * Math.PI / 180;
  const expected = Math.PI * lawDiskIntegral(law, alpha)[0];
  const result = rasterDisk(law, { radius: 1, alpha, offset: [0.23, 0.41], rule: 'footprint', order: 24 });
  expect(Math.abs(result.sum / expected - 1)).toBeLessThan(1e-4);
});

it('a coordinate rotation can turn closest-approach rounding into false crescent light', () => {
  const law = { ...LAMBERT_LAW, kind: LAW.minnaert, p: 0.788 }, alpha = 179 * Math.PI / 180;
  const expected = Math.PI * lawDiskIntegral(law, alpha)[0];
  const rounded = rasterDisk(law, { radius: 1, alpha, offset: [0.23, 0.41], rotation: 0.37, rule: 'bounded' });
  expect(rounded.sum / expected).toBeGreaterThan(100);
  const sliver = rasterDisk(law, { radius: 1, alpha, offset: [0.23, 0.41], rotation: 0.37, rule: 'sliver' });
  expect(sliver.sum).toBe(0);
});
