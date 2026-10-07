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
