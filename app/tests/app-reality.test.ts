import { describe, expect, it } from 'vitest';
import {
  allowedValue, badgeParts, defaultReality, filterBody, labelAllowed, whyLine, worstOf,
} from '../src/app/reality';
import { body, src } from './app-fakes';

describe('labelAllowed', () => {
  it('strict admits measured + derived only', () => {
    expect(labelAllowed('measured', 'strict')).toBe(true);
    expect(labelAllowed('derived', 'strict')).toBe(true);
    expect(labelAllowed('estimated', 'strict')).toBe(false);
    expect(labelAllowed('synthetic', 'strict')).toBe(false);
  });
  it('best adds estimated; complete adds synthetic; unknown never', () => {
    expect(labelAllowed('estimated', 'best')).toBe(true);
    expect(labelAllowed('synthetic', 'best')).toBe(false);
    expect(labelAllowed('synthetic', 'complete')).toBe(true);
    for (const l of ['strict', 'best', 'complete'] as const) expect(labelAllowed('unknown', l)).toBe(false);
  });
  it('allowedValue returns null for unknown and for disallowed labels', () => {
    expect(allowedValue(src(5, 'estimated'), 'strict')).toBeNull();
    expect(allowedValue(src(5, 'estimated'), 'best')).toBe(5);
    expect(allowedValue(src<number>(null, 'unknown'), 'complete')).toBeNull();
    expect(allowedValue(undefined, 'complete')).toBeNull();
  });
  it('worstOf follows LABEL_ORDER', () => {
    expect(worstOf(['measured', 'estimated', 'derived'])).toBe('estimated');
    expect(worstOf([])).toBe('measured');
  });
});

describe('filterBody', () => {
  it('fully measured body draws a lit surface', () => {
    const f = filterBody(body(1, 'A', 'planet', { albedo: 'derived', phase: 'measured' }), 'strict');
    expect(f.radii).not.toBeNull();
    expect(f.albedoXYZS).toEqual([1, 2, 3, 4]);
    expect(f.phase).toEqual({ kind: 'lambert' });
    expect(f.surfaceUnknown).toBe(false);
    expect(f.worstLabel).toBe('derived');
  });

  it('estimated reflectance is withheld at strict → hatched silhouette', () => {
    const b = body(1, 'A', 'planet', { albedo: 'estimated', phase: 'estimated' });
    const strict = filterBody(b, 'strict');
    expect(strict.albedoXYZS).toBeNull();
    expect(strict.phase).toBeNull();
    expect(strict.surfaceUnknown).toBe(true);
    expect(strict.worstLabel).toBe('derived'); // position; radii/rotation measured
    expect(strict.uses.find((u) => u.key === 'albedoXYZS')?.reason).toBe('level');
    const best = filterBody(b, 'best');
    expect(best.surfaceUnknown).toBe(false);
    expect(best.worstLabel).toBe('estimated');
  });

  it('albedo without an admitted phase function is not drawn (no invented phase law)', () => {
    const f = filterBody(body(1, 'A', 'planet', { albedo: 'measured', phase: 'estimated' }), 'strict');
    expect(f.albedoXYZS).toBeNull();
    expect(f.surfaceUnknown).toBe(true);
    expect(f.uses.find((u) => u.key === 'albedoXYZS')?.reason).toBe('dependency');
  });

  it('estimated size at strict → no shape; point only if brightness is admitted', () => {
    const b = body(1, 'A', 'moon', { rLabel: 'estimated', albedo: 'measured', phase: 'measured' });
    const f = filterBody(b, 'strict');
    expect(f.radii).toBeNull();
    expect(f.orientation).toBe(false); // orientation is meaningless without a shape
    expect(f.albedoXYZS).not.toBeNull();
    expect(f.surfaceUnknown).toBe(false);
    expect(whyLine(f, 'strict')).toMatch(/point/);
  });

  it('no photometry at all → everything photometric unknown', () => {
    const f = filterBody(body(1, 'A', 'planet'), 'complete');
    expect(f.surfaceUnknown).toBe(true);
    expect(f.uses.find((u) => u.key === 'albedoXYZS')?.reason).toBe('unknown');
    expect(whyLine(f, 'complete')).toMatch(/not measured/);
  });
});

describe('badge', () => {
  const d = defaultReality();
  it('defaults are best + eye and show no badge', () => {
    expect(d.exists).toBe('best');
    expect(d.view).toBe('eye');
    expect(badgeParts(d, d)).toEqual([]);
  });
  it('complete becomes the default once a synthetic layer exists', () => {
    expect(defaultReality({ syntheticLayerAvailable: true }).exists).toBe('complete');
  });
  it('names every non-default dial', () => {
    expect(badgeParts({ ...d, exists: 'strict' }, d)).toEqual(['STRICT: measured + derived only']);
    expect(badgeParts({ ...d, view: 'enhanced', exposureBoostStops: 4 }, d)).toEqual(['ENHANCED +4 stops']);
    expect(badgeParts({ ...d, overlays: { ...d.overlays, provenanceTint: true } }, d)).toEqual(['PROVENANCE TINT']);
    expect(badgeParts({ ...d, exists: 'complete' }, d)[0]).toMatch(/COMPLETE/);
  });
});
