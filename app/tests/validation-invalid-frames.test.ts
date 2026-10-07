// Stubbed page results; test values only. No GPU or products.
import { expect, it } from 'vitest';
const { assessCase, frameLimitReason, tally, validationExitCode, markdownReport } = await import(
  /* @vite-ignore */ '../src/validation/results.mjs' as string);
const c = { id: 'earth', title: 'fixture', view: { camera: { width: 100, height: 80 } },
  rois: [{ id: 'body', kind: 'disk-centre', expected: { type: 'value', XYZS: [10, 10, 10, 10], tolerance: [1, 1, 1, 1] } },
    { id: 'sky', kind: 'sky', expected: { type: 'upper-limit', upperLimitXYZS: [1, 1, 1, 1] } }],
  ratios: [{ numerator: 'body', denominator: 'body', ratioXYZS: [1, 1, 1, 1], tolerance: [0.1, 0.1, 0.1, 0.1] }] };
const result = (mean = [10, 10, 10, 10], n = 4) => ({ id: c.id, ss: 4,
  scene: { bodies: [], notes: [] }, renderMs: 0,
  rois: [{ id: 'body', expectedType: 'value', expected: [10, 10, 10, 10], tolerance: [1, 1, 1, 1],
    rendered: { mean, std: [0, 0, 0, 0], n }, pass: true, failing: [] },
    { id: 'sky', expectedType: 'upper-limit', upperLimit: [1, 1, 1, 1], rendered: { mean: [0, 0, 0, 0], n: 4 }, pass: true, failing: [] }],
  ratios: [{ numerator: 'body', denominator: 'body', rendered: [1, 1, 1, 1], pass: true, failing: [] }] });
it.each(['WebGPU validation: texture too large', 'WebGPU device lost (unknown): reset'])(
  'a case error invalidates body, sky and ratio verdicts: %s', (error) => {
    const r = assessCase(c, result(), { errors: [error] });
    expect(r.status).toBe('not rendered');
    expect([...r.rois, ...r.ratios].every((q) => q.pass === null && q.status === 'not rendered' && q.reason.includes(error))).toBe(true);
    expect(tally([r])).toEqual({ pass: 0, fail: 0, notRendered: 2, notCompared: 0 });
    expect(validationExitCode([r], true)).toBe(1);
    expect(validationExitCode([r], false)).toBe(0); // a sweep continues at other levels
    const md = markdownReport({ generatedAt: 'fixture', options: { ss: 4 }, cases: [r] });
    expect(md).toContain('0 pass, 0 fail, 2 not rendered');
    expect(md).toContain(`not rendered: ${error}`);
  });
it.each([[0, 0, 0, 0], [NaN, NaN, NaN, NaN]])('a blank/non-finite body frame invalidates its sky too: %j', (mean) => {
  const r = assessCase(c, result(mean, Number.isNaN(mean[0]) ? 0 : 4));
  expect(r.status).toBe('not rendered');
  expect(r.rois[1].pass).toBeNull();
  expect(r.reason).toMatch(/zero|finite/);
});
it('zero in one region is still a model finding when another expected-light region renders', () => {
  const r = result([0, 0, 0, 0]);
  r.rois.push({ ...r.rois[0], id: 'lit', rendered: { mean: [1, 1, 1, 1], std: [0, 0, 0, 0], n: 4 } });
  expect(assessCase({ ...c, rois: [...c.rois, { ...c.rois[0], id: 'lit' }] }, r).status).toBe('rendered');
});
it('case errors do not leak to the next case, and limits refuse before any render', () => {
  expect(assessCase(c, result(), { errors: ['WebGPU error'] }).status).toBe('not rendered');
  expect(assessCase(c, result(), { errors: [] }).status).toBe('rendered');
  expect(frameLimitReason(c, 4, { maxTextureDimension2D: 399 })).toMatch(/400×320.*maxTextureDimension2D.*399/);
  expect(frameLimitReason(c, 4, { maxTextureDimension2D: 400 })).toBeNull();
  const r = assessCase(c, null, { ss: 4, reason: 'frame too large' });
  expect(r.rois).toHaveLength(2);
  expect(r.ratios[0].pass).toBeNull();
});
