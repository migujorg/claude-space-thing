// Test values only; no WebGPU or data products needed.
import { expect, it } from 'vitest';
import { DEFAULT_VALIDATION_SS, validationSampling, parseSamplingOption } from '../src/validation/sampling.mjs';

it('CLI and browser use one default, with integer overrides', () => {
  expect(validationSampling()).toBe(DEFAULT_VALIDATION_SS);
  expect(parseSamplingOption([])).toBe(DEFAULT_VALIDATION_SS);
  for (const n of [1, 2, 3, 4, 6]) {
    expect(parseSamplingOption(['--gpu', 'hardware', '--ss', String(n)])).toBe(n);
    expect(validationSampling(n)).toBe(n);
  }
});

it('invalid sampling never silently clamps, rounds or falls back', () => {
  for (const n of [0, -1, 1.5, NaN, Infinity, null, '']) {
    expect(() => validationSampling(n as number)).toThrow(/positive integer/);
  }
  for (const argv of [['--ss'], ['--ss', '--gpu', 'hardware'], ['--ss', 'NaN'], ['--ss', '0'], ['--ss', '2.5'], ['--ss', '2', '--ss', '4']]) {
    expect(() => parseSamplingOption(argv)).toThrow(/--ss/);
  }
});

interface SamplingRun {
  git: string;
  dataGeneratedAt: string;
  options: { ss: number };
  cases: { id: string; rois: { id: string; rendered: { mean: number[] }; pass: boolean; failing: string[] }[];
    ratios: { numerator: string; denominator: string; rendered: number[]; pass: null; failing: string[] }[] }[];
}
const { samplingRows, samplingMarkdown }: {
  samplingRows(run: SamplingRun): unknown[];
  samplingMarkdown(runs: SamplingRun[]): string;
} = await import(/* @vite-ignore */ '../scripts/validate-sampling.mjs' as string);

it('sweep retains every channel, ratio and verdict at each sampling', () => {
  const runs: SamplingRun[] = [1, 2, 3, 4, 6].map((ss) => ({
    git: 'fixture', dataGeneratedAt: 'fixture', options: { ss },
    cases: [{ id: 'test', rois: [{ id: 'disk', rendered: { mean: [ss, 10, 0, 30] }, pass: ss > 1, failing: ss > 1 ? [] : ['X'] }],
      ratios: [{ numerator: 'disk', denominator: 'earth', rendered: [1, 2, 3, 4], pass: null, failing: [] }] }],
  }));
  expect(samplingRows(runs[0])).toHaveLength(2);
  const md = samplingMarkdown(runs);
  expect(md).toMatch(/1 × 1 \| 2 × 2 \| 3 × 3 \| 4 × 4 \| 6 × 6/);
  expect(md).toMatch(/\| test \| disk \| X \| 1 \| 2 \| 3 \| 4 \| 6 \| -33\.33333 % \|/);
  expect(md).toMatch(/\| test \| disk \| Z \| 0 \| 0 \| 0 \| 0 \| 0 \| \+0 % \|/);
  expect(md).toMatch(/\| test \| disk \/ earth \| Y \| 2 \| 2 \| 2 \| 2 \| 2 \| \+0 % \|/);
  expect(md).toMatch(/fail \(X\) \| pass \| pass \| pass \| pass/);
  expect(md).toMatch(/not compared/);
});

it('CLI rejects malformed --ss before starting a server or browser', async () => {
  const { spawnSync }: {
    spawnSync(command: string, args: string[], options: { encoding: 'utf8' }): { status: number | null; stderr: string };
  } = await import(/* @vite-ignore */ 'node:child_process' as string);
  const { fileURLToPath }: { fileURLToPath(url: URL): string } = await import(/* @vite-ignore */ 'node:url' as string);
  const { execPath }: { execPath: string } = await import(/* @vite-ignore */ 'node:process' as string);
  for (const args of [['--ss'], ['--ss', '2.5']]) {
    const r = spawnSync(execPath, [fileURLToPath(new URL('../scripts/validate.mjs', import.meta.url)), ...args], { encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--ss requires a positive integer/);
    expect(r.stderr).not.toMatch(/listen|browserType\.launch/);
  }
});

it('invalid levels are excluded from convergence, verdict changes and promotion', async () => {
  const { samplingSummary, canPromoteDefault } = await import(/* @vite-ignore */ '../scripts/validate-sampling.mjs' as string);
  const runs = [1, 2, 3, 4, 6].map((ss) => ({ git: 'fixture', dataGeneratedAt: 'fixture', options: { ss }, cases: [
    { id: 'earth', status: [3, 6].includes(ss) ? 'not rendered' : 'rendered', reason: 'WebGPU error',
      rois: [{ id: 'disk', rendered: { mean: [3, 6].includes(ss) ? [0, 0, 0, 0] : [10, 10, 10, 10] },
        pass: ![3, 6].includes(ss), failing: [] }], ratios: [] },
    { id: 'other', status: 'rendered', rois: [{ id: 'disk', rendered: { mean: [ss === 4 ? 10.02 : 10, 10, 10, 10] }, pass: true, failing: [] }], ratios: [] },
  ] }));
  const summary = samplingSummary(runs);
  expect(summary.verdictChanges).toEqual([]);
  expect(summary.levels[4].cases.find((c) => c.id === 'earth').maxRelativePercent).toBeNull();
  expect(summary.levels[3].cases.find((c) => c.id === 'earth').referenceSs).toBe(4);
  expect(summary.levels[3].maxRelativePercent).toBeCloseTo(0.2);
  expect(canPromoteDefault(runs[2])).toBe(false);
  expect(canPromoteDefault(runs[3])).toBe(true);
  const md = samplingMarkdown(runs);
  expect(md).toContain('not rendered');
  expect(md).toContain('largest relative difference');
  expect(md).toContain('0.2 %');
});
