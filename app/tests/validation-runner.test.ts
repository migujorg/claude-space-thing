// The validation runner's pure parts (src/validation/runner.ts, src/render/hdrReadback.ts regionStats,
// scripts/validate-lib.mjs): the scene built from a ground-truth case, the ROI and ratio comparisons, the region
// statistics and the markdown report. TEST VALUES, not data.
import { describe, expect, it } from 'vitest';
import type { ValidationCase, ValidationRoi } from '../src/data/schema';
import { compareRatios, compareRoi, scaledRect, validationScene, type RoiResult } from '../src/validation/runner';
import { regionStats } from '../src/render/hdrReadback';
import { body, fakeLight, src } from './app-fakes';

const ORIENT: [number, number, number, number, number, number, number, number, number] = [0, -1, 0, 1, 0, 0, 0, 0, 1];

function testCase(o: { rings?: boolean; bodies?: number[] } = {}): ValidationCase {
  const vb = (id: number, name: string) => ({
    naifId: id, name, pos: [0, 0, -1e6] as [number, number, number], toSun: [1.5e8, 0, 0] as [number, number, number], orient: ORIENT,
    radii: [1000, 1000, 1000] as [number, number, number], rangeKm: 1e6, sunDistanceAu: 1, phaseDeg: 90,
    subObserver: { latDeg: 0, eastLonDeg: 0 }, subSolar: { latDeg: 0, eastLonDeg: 90 }, rings: o.rings ?? false,
  });
  const ids = o.bodies ?? [599];
  return {
    schema: 'validation-case-v1', id: 'test', title: 'test', summary: '', generated: '', observation: {},
    view: {
      epochUtc: '2007-01-01T00:00:00', et: 2.2e8,
      camera: { orient: [1, 0, 0, 0, 1, 0, 0, 0, 1], fovY: 0.01, width: 64, height: 48, pixelPitchRad: 0.01 / 48, convention: '' },
      bodies: ids.map((id) => vb(id, id === 599 ? 'Jupiter' : `body ${id}`)),
      sun: { pos: [1.5e8, 0, -1e6] },
    },
    reference: { file: 'reference.bin', dtype: 'float32-le', shape: [1, 48, 64], bands: ['x'], quantity: 'I/F', note: '' },
    comparison: { renderOutput: '', roiStatistic: '', tolerance: '' }, rois: [], ratios: [], appProducts: {}, notes: [], sources: [],
  };
}

const RINGS = { '599': { opticalDepth: src([{ radiusKm: [1, 2], normalTau: [0.1, 0.1] }], 'measured'), reflectance: src(null, 'unknown') } };
const data = (withPhotometry = true) => ({
  bodies: [body(599, 'Jupiter', 'planet', withPhotometry ? { albedo: 'estimated', phase: 'measured' } : {})],
  light: fakeLight(),
  extras: { surfaces: new Map(), rings: RINGS as never, atmospheres: null },
});

describe('validationScene', () => {
  it('places the body, camera and Sun exactly as the case says', () => {
    const s = validationScene(testCase(), data());
    const b = s.snapshot.bodies[0];
    expect(b.pos).toEqual([0, 0, -1e6]);
    expect(b.toSun).toEqual([1.5e8, 0, 0]);
    expect(b.orient).toEqual(ORIENT);
    expect(b.albedoXYZS).toEqual([1, 2, 3, 4]);
    expect(s.snapshot.et).toBe(2.2e8);
    expect(s.snapshot.camera).toMatchObject({ fovY: 0.01, width: 64, height: 48 });
    expect(s.snapshot.sun?.pos).toEqual([1.5e8, 0, -1e6]);
    expect(s.snapshot.view.mode).toBe('eye');
    expect(s.bodies[0]).toMatchObject({ naifId: 599, drawn: 'resolved', worstLabel: 'estimated' });
  });
  it('renders at ss times the size', () => {
    const s = validationScene(testCase(), data(), { ss: 3 });
    expect(s.snapshot.camera).toMatchObject({ width: 192, height: 144 });
    expect(scaledRect([1, 2, 3, 4], 3)).toEqual([3, 6, 9, 12]);
  });
  it('attaches the rings only when the case has them', () => {
    expect(validationScene(testCase({ rings: false }), data()).snapshot.bodies[0].rings).toBeUndefined();
    expect(validationScene(testCase({ rings: true }), data()).snapshot.bodies[0].rings).toBeTruthy();
  });
  it('reports bodies it cannot draw, and applies the reality level', () => {
    const s = validationScene(testCase({ bodies: [599, 12345] }), data());
    expect(s.bodies[1]).toMatchObject({ naifId: 12345, drawn: 'none' });
    expect(s.notes.join(' ')).toMatch(/12345/);
    // Estimated albedo: not admitted at 'strict', so the surface is hatched (no albedo reaches the renderer).
    const strict = validationScene(testCase(), data(), { reality: 'strict' }).snapshot.bodies[0];
    expect(strict.albedoXYZS).toBeNull();
    expect(strict.surfaceUnknown).toBe(true);
  });
});

const roi = (expected: ValidationRoi['expected'], id = 'r'): ValidationRoi => ({
  id, kind: 'disk-centre', note: null, target: 599, rect: [0, 0, 2, 2], pixels: 4, geometry: {}, bands: [], expected,
});
const VALUE = { type: 'value' as const, XYZS: [100, 100, 100, 100] as [number, number, number, number], sigma: [5, 5, 5, 5] as [number, number, number, number],
  tolerance: [10, 10, 10, 10] as [number, number, number, number], comparison: '', label: 'estimated' as const, method: '', budget: {}, bandCentersNm: [], rho: [], colorCriterion: '' };

describe('compareRoi / compareRatios', () => {
  it('passes within the tolerance on every channel and names the failing ones', () => {
    const ok = compareRoi(roi(VALUE), { mean: [105, 91, 100, 109], std: [0, 0, 0, 0], n: 4 });
    expect(ok.pass).toBe(true);
    expect(ok.ratio?.[0]).toBeCloseTo(1.05);
    expect(ok.deviationSigma?.[1]).toBeCloseTo(-1.8);
    const bad = compareRoi(roi(VALUE), { mean: [111, 100, 80, 100], std: [0, 0, 0, 0], n: 4 });
    expect(bad.pass).toBe(false);
    expect(bad.failing).toEqual(['X', 'Z']);
  });
  it('treats upper limits, none and empty regions', () => {
    const ul = roi({ type: 'upper-limit', upperLimitXYZS: [1, 1, 1, 1], comparison: '', label: 'derived', method: '' });
    expect(compareRoi(ul, { mean: [0.5, 0.5, 0.5, 0.5], std: [0, 0, 0, 0], n: 4 }).pass).toBe(true);
    expect(compareRoi(ul, { mean: [0.5, 2, 0.5, 0.5], std: [0, 0, 0, 0], n: 4 }).failing).toEqual(['Y']);
    expect(compareRoi(roi({ type: 'none', label: 'unknown', method: 'no data' }), { mean: [0, 0, 0, 0], std: [0, 0, 0, 0], n: 4 }).pass).toBeNull();
    expect(compareRoi(roi(VALUE), { mean: [NaN, NaN, NaN, NaN], std: [NaN, NaN, NaN, NaN], n: 0 }).pass).toBeNull();
  });
  it('compares ratios of rendered means', () => {
    const c = testCase();
    c.ratios = [{ numerator: 'a', denominator: 'b', ratioXYZS: [0.1, 0.1, 0.1, 0.1], sigma: [0.01, 0.01, 0.01, 0.01], tolerance: [0.02, 0.02, 0.02, 0.02], bands: [], comparison: '', method: '' }];
    const rr = (id: string, m: number): RoiResult => ({ id, kind: 'disk-integrated', target: 1, rect: [0, 0, 1, 1], expectedType: 'value', rendered: { mean: [m, m, m, m], std: [0, 0, 0, 0], n: 1 }, pass: true, failing: [] });
    const [r] = compareRatios(c, [rr('a', 11), rr('b', 100)]);
    expect(r.pass).toBe(true);
    expect(r.rendered?.[1]).toBeCloseTo(0.11);
    expect(compareRatios(c, [rr('a', 20), rr('b', 100)])[0].failing).toEqual(['X', 'Y', 'Z', 'S']);
  });
});

describe('regionStats', () => {
  it('averages the finite pixels per channel', () => {
    const d = new Float32Array([1, 2, 3, 4, 3, 4, 5, 6, NaN, 0, 0, 0]);
    const s = regionStats({ width: 3, height: 1, data: d });
    expect(s.n).toBe(2);
    expect(s.mean).toEqual([2, 3, 4, 5]);
    expect(s.std).toEqual([1, 1, 1, 1]);
  });
});

interface Lib { markdownReport(report: unknown): string; roiRow(caseId: string, q: unknown): string }
const lib = (await import(/* @vite-ignore */ '../scripts/validate-lib.mjs' as string)) as Lib;

describe('validate-lib markdownReport', () => {
  it('writes one row per ROI with the verdict, and the case notes', () => {
    const q = compareRoi(roi(VALUE, 'disk-centre'), { mean: [100, 130, 100, 100], std: [0, 0, 0, 0], n: 4 });
    const md = lib.markdownReport({
      generatedAt: 'now', git: 'abc', dataGeneratedAt: 'then', options: { ss: 1, reality: 'best', hdr: 'auto' },
      cases: [
        { id: 'c1', width: 10, height: 10, renderMs: 1000, rois: [q], ratios: [], stats: { warnings: ['w1'] },
          scene: { notes: ['n1'], bodies: [{ name: 'Jupiter', drawn: 'resolved', worstLabel: 'estimated', uses: ['disk photometry'] }] } },
        { id: 'c2', error: 'timeout' },
      ],
    });
    expect(md).toContain('| c1 | disk-centre | disk-centre | 100.0 ± 10 | 130.0 | 1.300 | +6.0 | **FAIL** (Y) |');
    expect(md).toContain('**0 pass, 1 fail, 0 not compared** over 2 cases (1 did not render)');
    expect(md).toContain('Notes: n1');
    expect(md).toContain('Renderer warnings: w1');
    expect(md).toContain('did not render');
    // A report without the adapter record (written before --gpu) keeps its header.
    expect(md).toContain('1×1 samples per pixel · HDR auto\n');
  });

  it('says in the header which HDR targets and which adapter rendered the cases', () => {
    const q = compareRoi(roi(VALUE, 'disk-centre'), { mean: [100, 100, 100, 100], std: [0, 0, 0, 0], n: 4 });
    const c = (id: string, hdrFormat: string) => ({ id, width: 10, height: 10, renderMs: 1000, hdrFormat, rois: [q], ratios: [], stats: { warnings: [] }, scene: { notes: [], bodies: [] } });
    const report = {
      generatedAt: 'now', git: 'abc', dataGeneratedAt: 'then', options: { ss: 1, reality: 'best', hdr: 'auto' },
      gpu: { mode: 'hardware', adapter: { vendor: 'nvidia', architecture: 'blackwell', device: '', description: '', fallback: false, float32Blendable: true } },
      cases: [c('c1', 'rgba32float'), c('c2', 'rgba32float')],
    };
    expect(lib.markdownReport(report)).toContain('· HDR auto (rgba32float) · GPU hardware: nvidia blackwell (hardware)\n');
    expect(lib.markdownReport({ ...report, options: { ...report.options, hdr: 'f16' }, gpu: { mode: 'swiftshader', adapter: null }, cases: [c('c1', 'rgba16float')] }))
      .toContain('· HDR f16 (rgba16float) · GPU swiftshader: none\n');
  });
});
