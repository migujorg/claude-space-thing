// Test values only; no WebGPU or data products needed.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DEFAULT_VALIDATION_SS, validationSampling, parseSamplingOption } from './sampling.mjs';

test('CLI and browser use one default, with integer overrides', () => {
  assert.equal(DEFAULT_VALIDATION_SS, 4);
  assert.equal(validationSampling(), DEFAULT_VALIDATION_SS);
  assert.equal(parseSamplingOption([]), DEFAULT_VALIDATION_SS);
  for (const n of [1, 2, 3, 4, 6]) {
    assert.equal(parseSamplingOption(['--gpu', 'hardware', '--ss', String(n)]), n);
    assert.equal(validationSampling(n), n);
  }
});

test('invalid sampling never silently clamps, rounds or falls back', () => {
  for (const n of [0, -1, 1.5, NaN, Infinity, null, '']) {
    assert.throws(() => validationSampling(n), /positive integer/);
  }
  for (const argv of [['--ss'], ['--ss', '--gpu', 'hardware'], ['--ss', 'NaN'], ['--ss', '0'], ['--ss', '2.5'], ['--ss', '2', '--ss', '4']]) {
    assert.throws(() => parseSamplingOption(argv), /--ss/);
  }
});

const { samplingRows, samplingMarkdown } = await import('../../scripts/validate-sampling.mjs');
test('sweep retains every channel, ratio and verdict at each sampling', () => {
  const runs = [1, 2, 3, 4, 6].map((ss) => ({
    git: 'fixture', dataGeneratedAt: 'fixture', options: { ss },
    cases: [{ id: 'test', rois: [{ id: 'disk', rendered: { mean: [ss, 10, 0, 30] }, pass: ss > 1, failing: ss > 1 ? [] : ['X'] }],
      ratios: [{ numerator: 'disk', denominator: 'earth', rendered: [1, 2, 3, 4], pass: null, failing: [] }] }],
  }));
  assert.equal(samplingRows(runs[0]).length, 2);
  const md = samplingMarkdown(runs);
  assert.match(md, /1 × 1 \| 2 × 2 \| 3 × 3 \| 4 × 4 \| 6 × 6/);
  assert.match(md, /\| test \| disk \| X \| 1 \| 2 \| 3 \| 4 \| 6 \| -33\.33333 % \|/);
  assert.match(md, /\| test \| disk \| Z \| 0 \| 0 \| 0 \| 0 \| 0 \| \+0 % \|/);
  assert.match(md, /\| test \| disk \/ earth \| Y \| 2 \| 2 \| 2 \| 2 \| 2 \| \+0 % \|/);
  assert.match(md, /fail \(X\) \| pass \| pass \| pass \| pass/);
  assert.match(md, /not compared/);
});

test('CLI rejects malformed --ss before starting a server or browser', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  for (const args of [['--ss'], ['--ss', '2.5']]) {
    const r = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/validate.mjs', import.meta.url)), ...args], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--ss requires a positive integer/);
    assert.doesNotMatch(r.stderr, /listen|browserType\.launch/);
  }
});
