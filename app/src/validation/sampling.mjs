// Numerical integration setting, never a photometric model parameter. Pixel-centre sampling changes validation
// verdicts and undersamples small disks. Provisional 4 until the coarsest converged grid is established by
// app/shots/validation/sampling-convergence.json (scripts/validate-sampling.mjs; docs/reports/validation.md).
export const DEFAULT_VALIDATION_SS = 4;

/** Shared by the CLI, the scene builder and the browser run; reject ambiguity in the sampling recorded. */
export function validationSampling(value = DEFAULT_VALIDATION_SS) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('validation sampling must be a positive integer');
  return value;
}

export function parseSamplingOption(argv) {
  const indices = argv.flatMap((arg, i) => arg === '--ss' ? [i] : []);
  if (!indices.length) return validationSampling();
  if (indices.length !== 1) throw new Error('--ss must be specified once');
  const raw = argv[indices[0] + 1];
  if (!raw || raw.startsWith('--')) throw new Error('--ss requires a positive integer');
  try { return validationSampling(Number(raw)); }
  catch { throw new Error('--ss requires a positive integer'); }
}
