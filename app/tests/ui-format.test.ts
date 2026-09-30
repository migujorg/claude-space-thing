import { describe, expect, it } from 'vitest';
import { formatAngle, formatDistance, formatDuration, formatRate, formatValue, sig } from '../src/ui/format';
import { estimateWidth, layoutLabels } from '../src/ui/labelLayout';
import { AU_KM } from '../src/ui/units';

describe('formatting', () => {
  it('distances pick a readable unit', () => {
    expect(formatDistance(0.25)).toBe('250 m');
    expect(formatDistance(384400)).toBe('384 400 km');
    expect(formatDistance(5.5e6)).toBe('5.500 million km');
    expect(formatDistance(5.2 * AU_KM)).toBe('5.200 AU');
    expect(formatDistance(null)).toBe('—');
  });
  it('angles go from degrees to arcseconds to mas', () => {
    expect(formatAngle(Math.PI / 4)).toBe('45.00°');
    expect(formatAngle((0.5 * Math.PI) / 180)).toBe('30.00′');
    expect(formatAngle((1 / 3600) * (Math.PI / 180) * 2)).toBe('2.00″');
    expect(formatAngle((1e-3 / 3600) * (Math.PI / 180) * 5)).toBe('5.00 mas');
  });
  it('durations', () => {
    expect(formatDuration(1.5)).toBe('1.50 s');
    expect(formatDuration(125)).toBe('2 min 5 s');
    expect(formatDuration(3 * 3600 + 600)).toBe('3 h 10 min');
    expect(formatDuration(-0.002)).toBe('−2.00 ms');
  });
  it('rates and generic values', () => {
    expect(formatRate(-3600, '1 h/s')).toBe('◀ 1 h/s');
    expect(formatRate(12)).toBe('×12.0');
    expect(formatValue([6378.1366, 6378.1366, 6356.7519], 'km', 'radii')).toBe('6378.14 × 6378.14 × 6356.75 km');
    expect(formatValue([100, 100, 100], 'km', 'radii')).toBe('100.000 km (sphere)');
    expect(formatValue(null)).toBe('unknown');
    expect(formatValue({ kind: 'lambert' }, undefined, 'phase')).toMatch(/Lambert/);
    expect(sig(123456789)).toBe('1.235e8');
  });
});

describe('label layout', () => {
  const o = { width: 800, height: 600, measure: (t: string) => estimateWidth(t) };
  it('places labels right of the disk and drops overlapping lower-priority ones', () => {
    const placed = layoutLabels(
      [
        { id: 1, x: 100, y: 100, r: 20, text: 'Planet', priority: 10 },
        { id: 2, x: 102, y: 101, r: 0, text: 'Moon', priority: 5 },
        { id: 3, x: 400, y: 300, r: 0, text: 'Other', priority: 1 },
      ],
      o,
    );
    expect(placed.map((p) => p.id)).toEqual([1, 3]);
    expect(placed[0].x).toBeGreaterThan(120);
  });
  it('puts a label on the side that leaves a nearby body uncovered', () => {
    const placed = layoutLabels(
      [
        { id: 1, x: 300, y: 300, r: 3, text: 'Planet 877 822 km', priority: 10 },
        { id: 2, x: 360, y: 301, r: 0, text: 'Moon', priority: 5 },
      ],
      o,
    );
    const planet = placed.find((p) => p.id === 1)!;
    expect(planet.x + planet.w).toBeLessThan(300); // flipped left: the moon at x=360 stays clickable
    expect(placed.map((p) => p.id).sort()).toEqual([1, 2]);
  });
  it('flips to the left near the right edge and skips labels that cannot fit', () => {
    const [p] = layoutLabels([{ id: 1, x: 790, y: 300, r: 0, text: 'Edge', priority: 1 }], o);
    expect(p.x + p.w).toBeLessThan(790);
    expect(layoutLabels([{ id: 1, x: 400, y: 2, r: 0, text: 'Top', priority: 1 }], o)).toEqual([]);
  });
});
