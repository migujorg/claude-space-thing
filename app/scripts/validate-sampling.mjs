// Hardware-only, sequential convergence sweep. Run: cd app && node scripts/validate-sampling.mjs
// Retains runs at 1, 2, 3, 4 and 6 samples/axis, writes every ROI/ratio/channel against sampling, and promotes
// the shared default's run to shots/validation/report.json for the pipeline report. Never selects a model/tolerance.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { startLocalServer } from './local-server.mjs';
import { runServerOptions } from './e2e-lib.mjs';
import { DEFAULT_VALIDATION_SS } from '../src/validation/sampling.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'shots/validation');
export const SAMPLING_AXES = [1, 2, 3, 4, 6];
const CHANNELS = ['X', 'Y', 'Z', 'S'];
const number = (v) => Number.isFinite(v) ? Number(v.toPrecision(7)).toString() : '—';

export function samplingRows(run) {
  return run.cases.flatMap((c) => [
    ...(c.rois ?? []).map((q) => ({ case: c.id, region: q.id, values: q.rendered.mean, pass: q.pass, failing: q.failing })),
    ...(c.ratios ?? []).map((q) => ({ case: c.id, region: `${q.numerator} / ${q.denominator}`, values: q.rendered, pass: q.pass, failing: q.failing })),
  ]);
}

export function samplingMarkdown(runs) {
  const rows = runs.map(samplingRows);
  const columns = runs.map((r) => `${r.options.ss} × ${r.options.ss}`).join(' | ');
  const lines = ['# Validation sampling convergence', '',
    `Run git ${runs[0].git}; data ${runs[0].dataGeneratedAt}; hardware WebGPU.`, '',
    'Each channel is shown; ratios are dimensionless, ROI X/Y/Z are cd/m² and S is scotopic cd/m².',
    'Δ is relative to the 6 × 6 value; zero over zero is 0%, nonzero over zero is unknown.',
    'These finite grids are evidence of convergence, not a proof. Compare all channels and verdicts, not just the tally.', '',
    `| case | region | channel | ${columns} | Δ 4→6 |`, `|---|---|---|${runs.map(() => '---|').join('')}---|`];
  const four = runs.findIndex((r) => r.options.ss === 4);
  const six = runs.findIndex((r) => r.options.ss === 6);
  for (let i = 0; i < rows[0].length; i++) {
    for (let k = 0; k < 4; k++) {
      const values = rows.map((r) => r[i].values?.[k]);
      const a = values[four], b = values[six];
      const delta = Number.isFinite(a) && Number.isFinite(b) ? b === 0 ? a === 0 ? 0 : null : 100 * (a / b - 1) : null;
      lines.push(`| ${rows[0][i].case} | ${rows[0][i].region} | ${CHANNELS[k]} | ${values.map(number).join(' | ')} | ${delta === null ? '—' : `${delta >= 0 ? '+' : ''}${number(delta)} %`} |`);
    }
  }
  lines.push('', `| case | region | ${columns} |`, `|---|---|${runs.map(() => '---|').join('')}`);
  for (let i = 0; i < rows[0].length; i++) {
    const verdicts = rows.map((r) => r[i].pass === null ? 'not compared' : r[i].pass ? 'pass' : `fail (${r[i].failing.join('')})`);
    lines.push(`| ${rows[0][i].case} | ${rows[0][i].region} | ${verdicts.join(' | ')} |`);
  }
  return lines.join('\n') + '\n';
}

function fingerprint() {
  const repo = resolve(ROOT, '..');
  const index = JSON.parse(readFileSync(resolve(repo, 'validation/index.json'), 'utf8'));
  const hash = createHash('sha256');
  hash.update(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }));
  hash.update(execFileSync('git', ['diff', 'HEAD', '--', 'src', 'scripts'], { cwd: ROOT }));
  hash.update(readFileSync(resolve(ROOT, 'public/data/manifest.json')));
  hash.update(readFileSync(resolve(repo, 'validation/index.json')));
  for (const c of index.cases) hash.update(readFileSync(resolve(repo, 'validation', c.path)));
  return hash.digest('hex');
}

async function render(args) {
  await new Promise((done, fail) => {
    const child = spawn(process.execPath, [resolve(ROOT, 'scripts/validate.mjs'), ...args], { cwd: ROOT, stdio: 'inherit' });
    child.once('error', fail);
    child.once('exit', (code, signal) => code === 0 ? done() : fail(new Error(`validation exited ${code ?? signal}`)));
  });
}

async function main() {
  if (process.argv.length > 2) throw new Error('sampling sweep takes no options: all cases, hardware GPU, shared defaults');
  const before = fingerprint();
  const { server, base } = await startLocalServer(ROOT, runServerOptions());
  const runs = [];
  try {
    for (const ss of SAMPLING_AXES) {
      const out = resolve(OUT, `sampling/${ss}`);
      await render(['--base', base, '--gpu', 'hardware', '--ss', String(ss), '--out', out]);
      const run = JSON.parse(readFileSync(resolve(out, 'report.json'), 'utf8'));
      if (run.options.ss !== ss || run.cases.some((c) => c.error || c.ss !== ss)) throw new Error(`incomplete run at ss ${ss}`);
      if (fingerprint() !== before) throw new Error('tree, case inputs or data manifest changed during the sweep; rerun on stable inputs');
      if (runs.length && JSON.stringify([run.gpu, run.dataMissing, run.cases.map((c) => [c.id, c.hdrFormat]), samplingRows(run).map((q) => [q.case, q.region])]) !==
          JSON.stringify([runs[0].gpu, runs[0].dataMissing, runs[0].cases.map((c) => [c.id, c.hdrFormat]), samplingRows(runs[0]).map((q) => [q.case, q.region])])) {
        throw new Error('adapter, HDR format, data availability or regions changed during the sweep');
      }
      runs.push(run);
    }
    mkdirSync(OUT, { recursive: true });
    writeFileSync(resolve(OUT, 'sampling-convergence.json'), JSON.stringify({ schema: 'validation-sampling-v1', inputFingerprint: before, runs }, null, 1) + '\n');
    writeFileSync(resolve(OUT, 'sampling-convergence.md'), samplingMarkdown(runs));
    // Promote the current default, never the last (6 × 6) run. The report's header reads this run's recorded ss.
    cpSync(resolve(OUT, `sampling/${DEFAULT_VALIDATION_SS}`), OUT, { recursive: true });
    console.log(`Convergence: ${resolve(OUT, 'sampling-convergence.md')}; report: ss ${DEFAULT_VALIDATION_SS}`);
  } finally {
    await server.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
