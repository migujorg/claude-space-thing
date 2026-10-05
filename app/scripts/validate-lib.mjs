// Pure helpers of scripts/validate.mjs (tested in tests/validation-runner.test.ts): the markdown report.

import { adapterLabel } from './e2e-lib.mjs';

const g = (v, d = 4) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : Number(v).toPrecision(d));
const f = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : Number(v).toFixed(d));

function verdict(q) {
  if (q.pass === true) return 'pass';
  if (q.pass === false) return `**FAIL** (${q.failing.join('')})`;
  return 'not compared';
}

/** One table row per ROI: Y is shown; the verdict covers all four channels. */
export function roiRow(caseId, q) {
  let expected = '—', ratio = '—', dev = '—';
  if (q.expectedType === 'value') {
    expected = `${g(q.expected[1])} ± ${g(q.tolerance[1], 2)}`;
    ratio = f(q.ratio[1], 3);
    dev = `${q.deviationSigma[1] >= 0 ? '+' : ''}${f(q.deviationSigma[1], 1)}`;
  } else if (q.expectedType === 'upper-limit') expected = `≤ ${g(q.upperLimit[1])}`;
  return `| ${caseId} | ${q.id} | ${q.kind} | ${expected} | ${g(q.rendered.mean[1])} | ${ratio} | ${dev} | ${verdict(q)} |`;
}

export function markdownReport(report) {
  const L = [];
  L.push('# Validation run: renderer HDR buffer against calibrated images', '');
  // What rendered it: the HDR targets the cases actually had (rgba32float needs float32-blendable) and, when the
  // runner recorded it, the WebGPU adapter.
  const formats = [...new Set(report.cases.map((c) => c.hdrFormat).filter(Boolean))];
  L.push(`${report.generatedAt} · git ${report.git ?? '?'} · data ${report.dataGeneratedAt ?? '?'} · reality level ` +
    `${report.options.reality} · ${report.options.ss}×${report.options.ss} samples per pixel · HDR ${report.options.hdr}` +
    (formats.length ? ` (${formats.join(', ')})` : '') +
    (report.gpu ? ` · GPU ${report.gpu.mode}: ${adapterLabel(report.gpu.adapter)}` : ''), '');
  L.push('Y in cd/m² (X, Z in cd/m², S in scotopic cd/m² are in report.json). Tolerance = 2σ of the observation\'s ' +
    'budget; a verdict covers all four channels (the failing ones are named). Upper limits: the rendered mean must not ' +
    'exceed the observed sky level. σ: deviation in units of the 1σ budget.', '');
  const all = report.cases.flatMap((c) => c.rois ?? []);
  const n = (p) => all.filter((q) => q.pass === p).length;
  L.push(`**${n(true)} pass, ${n(false)} fail, ${n(null)} not compared** over ${report.cases.length} cases` +
    (report.cases.some((c) => c.error) ? ` (${report.cases.filter((c) => c.error).length} did not render)` : '') + '.', '');
  L.push('| case | ROI | kind | expected Y ± tol | rendered Y | rendered/expected | σ | verdict |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const c of report.cases) {
    if (c.error) {
      L.push(`| ${c.id} | — | — | — | — | — | — | **did not render**: ${c.error.replace(/\|/g, '/').slice(0, 160)} |`);
      continue;
    }
    for (const q of c.rois) L.push(roiRow(c.id, q));
  }
  const ratios = report.cases.flatMap((c) => (c.ratios ?? []).map((r) => ({ id: c.id, ...r })));
  if (ratios.length) {
    L.push('', '| case | ratio | expected Y ± tol | rendered Y | verdict |', '|---|---|---|---|---|');
    for (const r of ratios) {
      L.push(`| ${r.id} | ${r.numerator} / ${r.denominator} | ${g(r.expected[1])} ± ${g(r.tolerance[1], 2)} | ` +
        `${r.rendered ? g(r.rendered[1]) : '—'} | ${verdict(r)} |`);
    }
  }
  L.push('', '## Per case', '');
  for (const c of report.cases) {
    if (c.error) {
      L.push(`* **${c.id}**: did not render: ${c.error}`);
      continue;
    }
    const bodies = c.scene.bodies.map((b) => `${b.name} ${b.drawn}${b.worstLabel ? ` (${b.worstLabel}; ${(b.uses ?? []).join(', ')})` : ''}`).join('; ');
    L.push(`* **${c.id}** (${c.width}×${c.height}, ${(c.renderMs / 1000).toFixed(0)} s): ${bodies}.` +
      (c.scene.notes.length ? ` Notes: ${c.scene.notes.join('; ')}.` : '') +
      ((c.stats?.warnings ?? []).length ? ` Renderer warnings: ${c.stats.warnings.join('; ')}.` : ''));
  }
  if (report.dataMissing?.length) L.push('', `Data products missing or unusable: ${report.dataMissing.join(', ')}.`);
  if (report.consoleErrors?.length) L.push('', `Console errors: ${report.consoleErrors.length} (report.json).`);
  return L.join('\n') + '\n';
}
