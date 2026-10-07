// Shared CPU gate for browser readbacks and stubbed CLI page results. A failed frame is no measurement.

export function frameLimitReason(c, ss, limits) {
  const w = c.view.camera.width * ss, h = c.view.camera.height * ss;
  const max = limits?.maxTextureDimension2D;
  if (!Number.isFinite(max)) return 'device did not report maxTextureDimension2D';
  return Math.max(w, h) > max ? `required frame ${w}×${h} at ${ss}×${ss} exceeds device maxTextureDimension2D ${max}` : null;
}

export function assessCase(c, result, { ss = result?.ss, errors = [], reason } = {}) {
  const allErrors = [...new Set([...(result?.errors ?? []), ...errors])];
  reason ??= result?.status === 'not rendered' ? result.reason : null;
  if (allErrors.length) reason = [reason, ...allErrors.filter((e) => !reason?.includes(e))].filter(Boolean).join('; ');
  // Test the union of regions expecting body light, not the sky or each dark region in isolation.
  // Mean AND spread equal to zero implies every finite sample is zero.
  const litIds = new Set(c.rois.filter((q) => q.expected.type === 'value' && q.expected.XYZS.some((v) => v > 0)).map((q) => q.id));
  const lit = (result?.rois ?? []).filter((q) => litIds.has(q.id));
  if (!reason && litIds.size && !lit.some((q) => q.rendered?.n > 0 && q.rendered.mean.some((v, k) =>
    Number.isFinite(v) && (v !== 0 || (Number.isFinite(q.rendered.std?.[k]) && q.rendered.std[k] !== 0))))) {
    reason = 'HDR buffer is entirely zero or has no finite pixels over the body regions expecting light';
  }
  if (!reason && !result) reason = 'page returned no frame';
  if (!reason) return { ...result, status: 'rendered', errors: allErrors };
  const invalid = { status: 'not rendered', reason, pass: null, failing: [] };
  const rois = c.rois.map((q) => ({
    id: q.id, kind: q.kind, target: q.target, rect: q.rect, expectedType: q.expected.type,
    ...(q.expected.type === 'value' ? { expected: q.expected.XYZS, tolerance: q.expected.tolerance, sigma: q.expected.sigma } : {}),
    ...(q.expected.type === 'upper-limit' ? { upperLimit: q.expected.upperLimitXYZS } : {}),
    rendered: { mean: [NaN, NaN, NaN, NaN], std: [NaN, NaN, NaN, NaN], n: 0 }, ...invalid,
  }));
  const ratios = (c.ratios ?? []).map((q) => ({ numerator: q.numerator, denominator: q.denominator,
    expected: q.ratioXYZS, tolerance: q.tolerance, rendered: null, ...invalid }));
  const r = { ...result, id: c.id, title: c.title, width: c.view.camera.width, height: c.view.camera.height,
    ss, rois, ratios, errors: allErrors, status: invalid.status, reason };
  // An invalid readback cannot be presented as a rendered screenshot.
  delete r.hdrY;
  delete r.display;
  return r;
}

// Headline tallies count every comparison row, including ratios.
export function tally(cases) {
  const n = { pass: 0, fail: 0, notRendered: 0, notCompared: 0 };
  for (const c of cases) for (const q of [...(c.rois ?? []), ...(c.ratios ?? [])]) {
    if (c.status === 'not rendered' || q.status === 'not rendered' || c.error) n.notRendered++;
    else if (q.pass === true) n.pass++;
    else if (q.pass === false) n.fail++;
    else n.notCompared++;
  }
  return n;
}
export function validationExitCode(cases, strict) {
  return strict && (cases.some((c) => c.status === 'not rendered' || c.error) ||
    cases.some((c) => [...(c.rois ?? []), ...(c.ratios ?? [])].some((q) => q.pass === false))) ? 1 : 0;
}
