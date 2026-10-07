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
import { tally } from '../src/validation/results.mjs';
import { DEFAULT_VALIDATION_SS } from '../src/validation/sampling.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'shots/validation');
export const SAMPLING_AXES = [1, 2, 3, 4, 6];
const CHANNELS = ['X', 'Y', 'Z', 'S'];
const number = (v) => Number.isFinite(v) ? Number(v.toPrecision(7)).toString() : '—';

export function canPromoteDefault(run) {
  return !!run && run.cases.every((c) => c.status !== 'not rendered' && !c.error && !(c.errors?.length) && !(c.consoleErrors?.length));
}

export function samplingRows(run) {
  return run.cases.flatMap((c) => {
    const invalid = c.status === 'not rendered' || c.error || c.errors?.length || c.consoleErrors?.length;
    const base = { case: c.id, status: invalid ? 'not rendered' : 'rendered', reason: c.reason ?? c.error };
    return [
      ...(c.rois ?? []).map((q) => ({ ...base, region: q.id, values: invalid ? null : q.rendered.mean, pass: invalid ? null : q.pass, failing: q.failing })),
      ...(c.ratios ?? []).map((q) => ({ ...base, region: `${q.numerator} / ${q.denominator}`, values: invalid ? null : q.rendered, pass: invalid ? null : q.pass, failing: q.failing })),
    ];
  });
}
const relativePercent = (a, b) => !Number.isFinite(a) || !Number.isFinite(b) ? null : b === 0 ? a === 0 ? 0 : null : 100 * (a / b - 1);

export function samplingSummary(runs) {
  const rows = runs.map(samplingRows);
  const ids = [...new Set(runs.flatMap((r) => r.cases.map((c) => c.id)))];
  const references = new Map(ids.map((id) => [id, runs.reduce((best, r, i) =>
    rows[i].some((q) => q.case === id && q.status !== 'not rendered') && (best === null || r.options.ss > runs[best].options.ss) ? i : best, null)]));
  const levels = runs.map((run, i) => {
    const cases = ids.map((id) => {
      const ref = references.get(id);
      const caseRows = rows[i].filter((q) => q.case === id);
      const invalid = !caseRows.length || caseRows.some((q) => q.status === 'not rendered');
      const differences = invalid || ref === null ? [] : caseRows.flatMap((q) => {
        const finest = rows[ref].find((b) => b.case === id && b.region === q.region);
        return CHANNELS.map((_, k) => relativePercent(q.values?.[k], finest?.values?.[k])).filter((v) => v !== null).map(Math.abs);
      });
      return { id, referenceSs: ref === null ? null : runs[ref].options.ss, status: invalid ? 'not rendered' : 'rendered',
        maxRelativePercent: differences.length ? Math.max(...differences) : null };
    });
    const valid = cases.map((c) => c.maxRelativePercent).filter((v) => v !== null);
    return { ss: run.options.ss, cases, maxRelativePercent: valid.length ? Math.max(...valid) : null, tally: tally(run.cases) };
  });
  const keys = new Map(rows.flat().map((q) => [JSON.stringify([q.case, q.region]), q]));
  const verdictChanges = [...keys.values()].filter((q) => new Set(rows.flat().filter((r) => r.case === q.case && r.region === q.region && r.status !== 'not rendered' && r.pass !== null).map((r) => r.pass)).size > 1)
    .map((q) => ({ case: q.case, region: q.region }));
  return { levels, verdictChanges };
}

export function samplingMarkdown(runs) {
  const rows = runs.map(samplingRows);
  const summary = samplingSummary(runs);
  const keys = [...new Map(rows.flat().map((q) => [JSON.stringify([q.case, q.region]), q])).values()];
  const columns = runs.map((r) => `${r.options.ss} × ${r.options.ss}`).join(' | ');
  const lines = ['# Validation sampling convergence', '',
    `Run git ${runs[0].git}; data ${runs[0].dataGeneratedAt}; hardware WebGPU.`, '',
    'Each channel is shown; ratios are dimensionless, ROI X/Y/Z are cd/m² and S is scotopic cd/m².',
    'Δ 4→6 is shown only when both frames rendered. Per-level maxima use the finest valid level for each case; zero over zero is 0%, nonzero over zero is unknown.',
    'These finite grids are evidence of convergence, not a proof. Compare all channels and verdicts, not just the tally.', '',
    '| sampling | pass | fail | not rendered | largest relative difference (%) |', '|---|---|---|---|---|'];
  for (const level of summary.levels) lines.push(`| ${level.ss} × ${level.ss} | ${level.tally.pass} | ${level.tally.fail} | ${level.tally.notRendered} | ${number(level.maxRelativePercent)} % |`);
  lines.push('', '| sampling | case | finest valid sampling | largest relative difference (%) |', '|---|---|---|---|');
  for (const level of summary.levels) for (const c of level.cases) lines.push(`| ${level.ss} × ${level.ss} | ${c.id} | ${c.referenceSs ?? '—'} | ${c.status === 'not rendered' ? 'not rendered' : `${number(c.maxRelativePercent)} %`} |`);
  const def = summary.levels.find((l) => l.ss === DEFAULT_VALIDATION_SS);
  lines.push('', `Default ${DEFAULT_VALIDATION_SS} × ${DEFAULT_VALIDATION_SS}: largest relative difference ${number(def?.maxRelativePercent)} % against each case's finest valid level; ${def?.cases.filter((c) => c.status === 'rendered').length ?? 0} cases rendered. This run supplies the numerical justification; invalid levels supply no convergence evidence. A case whose finest valid level is the default has no finer check.`, '',
    `Verdict depends on sampling: ${summary.verdictChanges.map((q) => `${q.case} / ${q.region}`).join('; ') || 'none'} (valid frames only).`, '',
    `| case | region | channel | ${columns} | Δ 4→6 |`, `|---|---|---|${runs.map(() => '---|').join('')}---|`);
  const four = runs.findIndex((r) => r.options.ss === 4), six = runs.findIndex((r) => r.options.ss === 6);
  for (const q of keys) {
    const rr = rows.map((r) => r.find((v) => v.case === q.case && v.region === q.region));
    for (let k = 0; k < 4; k++) {
      const values = rr.map((r) => r?.values?.[k]);
      const delta = relativePercent(values[four], values[six]);
      lines.push(`| ${q.case} | ${q.region} | ${CHANNELS[k]} | ${rr.map((r, i) => r?.status === 'not rendered' ? 'not rendered' : number(values[i])).join(' | ')} | ${delta === null ? '—' : `${delta >= 0 ? '+' : ''}${number(delta)} %`} |`);
    }
  }
  lines.push('', `| case | region | ${columns} |`, `|---|---|${runs.map(() => '---|').join('')}`);
  for (const q of keys) {
    const verdicts = rows.map((r) => {
      const v = r.find((v) => v.case === q.case && v.region === q.region);
      return !v || v.status === 'not rendered' ? 'not rendered' : v.pass === null ? 'not compared' : v.pass ? 'pass' : `fail (${v.failing.join('')})`;
    });
    lines.push(`| ${q.case} | ${q.region} | ${verdicts.join(' | ')} |`);
  }
  for (const run of runs) for (const c of run.cases) if (c.status === 'not rendered') lines.push('', `${run.options.ss} × ${run.options.ss}, ${c.id}: not rendered: ${c.reason}`);
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
      if (run.options.ss !== ss || run.cases.some((c) => c.ss !== ss)) throw new Error(`incomplete run at ss ${ss}`);
      if (fingerprint() !== before) throw new Error('tree, case inputs or data manifest changed during the sweep; rerun on stable inputs');
      if (runs.length && JSON.stringify([run.gpu, run.dataMissing, run.cases.map((c) => c.id), samplingRows(run).map((q) => [q.case, q.region])]) !==
          JSON.stringify([runs[0].gpu, runs[0].dataMissing, runs[0].cases.map((c) => c.id), samplingRows(runs[0]).map((q) => [q.case, q.region])])) {
        throw new Error('adapter, HDR format, data availability or regions changed during the sweep');
      }
      for (const prev of runs) for (const c of run.cases) {
        const other = prev.cases.find((p) => p.id === c.id);
        if (c.status !== 'not rendered' && other.status !== 'not rendered' && c.hdrFormat !== other.hdrFormat) {
          throw new Error('HDR format changed between valid frames during the sweep');
        }
      }
      runs.push(run);
    }
    mkdirSync(OUT, { recursive: true });
    writeFileSync(resolve(OUT, 'sampling-convergence.json'), JSON.stringify({ schema: 'validation-sampling-v1', inputFingerprint: before, summary: samplingSummary(runs), runs }, null, 1) + '\n');
    writeFileSync(resolve(OUT, 'sampling-convergence.md'), samplingMarkdown(runs));
    // Promote the current default, never the last (6 × 6) run. The report's header reads this run's recorded ss.
    const defaultRun = runs.find((r) => r.options.ss === DEFAULT_VALIDATION_SS);
    if (canPromoteDefault(defaultRun)) cpSync(resolve(OUT, `sampling/${DEFAULT_VALIDATION_SS}`), OUT, { recursive: true });
    else console.log(`Default ss ${DEFAULT_VALIDATION_SS} was not promoted: at least one case was not rendered. Existing report.json is unchanged.`);
    console.log(`Convergence: ${resolve(OUT, 'sampling-convergence.md')}; default report ${canPromoteDefault(defaultRun) ? `promoted at ss ${DEFAULT_VALIDATION_SS}` : 'not promoted'}`);
  } finally {
    await server.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
