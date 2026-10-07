// Validation runner, pure part (docs/reports/validation.md; app/e2e/README.md "Validation against calibrated
// images"): turns a ground-truth case (validation/cases/<id>/case.json) into a SceneSnapshot with the app's own
// data, and compares the renderer's HDR regions with the case's expected radiance.
//
// Geometry-only approach: the case gives the complete view (camera, body positions, Sun direction and body
// orientation at the observation epoch), so nothing is computed from the app's ephemeris or orientation products.
// Every case runs, whatever its epoch, although the app's data window is 2025-03…2028-03. What the app draws on the
// bodies (albedo, phase function, maps, rings, atmospheres) is exactly what it draws in normal use, filtered at the
// chosen reality level (snapshot.ts sceneBodyOf). Things that change with time are the app's, not the
// observation's: Earth's clouds are those of the app's cloud day, seasonal and volcanic changes are not modelled.

import { validationSampling } from './sampling.mjs';

import type { Body, Label, LightData, ValidationBody, ValidationCase, ValidationRoi } from '../data/schema';
import type { SceneBody, SceneSnapshot, SceneSun } from '../render/scene';
import type { OrientationSetPort, OrientationSourcePort } from '../app/ports';
import type { BodyGeom } from '../app/world';
import type { SceneExtras } from '../app/extras';
import { allowedValue, type ExistsLevel } from '../app/reality';
import { sceneBodyOf } from '../app/snapshot';
import { C_KM_S } from '../core/constants';

export type XYZS = [number, number, number, number];
export const CHANNELS = ['X', 'Y', 'Z', 'S'] as const;

export interface ValidationData {
  bodies: Body[];
  light: LightData | null;
  extras: SceneExtras;
}

export interface ValidationOptions {
  /** Reality level the app's data are filtered at (default 'best': the most complete level for known bodies). */
  reality?: ExistsLevel;
  /** Samples per pixel along each axis: the view is rendered at ss × its size and box-averaged (default DEFAULT_VALIDATION_SS in sampling.mjs). */
  ss?: number;
}

export interface ValidationScene {
  snapshot: SceneSnapshot;
  /** What the harness did about bodies it could not place as the case asks. */
  notes: string[];
  /** Per case body: how the app draws it (id, worst label, maps and models used). */
  bodies: { naifId: number; name: string; drawn: 'resolved' | 'marker' | 'none'; worstLabel?: Label; uses?: string[] }[];
}

/** Orientation port that answers with the case's body-fixed → ICRF matrix (pck00011 at the observation epoch). */
function caseOrientation(vb: ValidationBody, body: Body): OrientationSetPort {
  const prov: OrientationSourcePort = {
    kind: 'iau', label: body.rotation?.label ?? 'unknown', sources: body.rotation?.sources ?? [], frame: 'ICRF',
    method: 'validation case: body-fixed → ICRF at the observation epoch (pipeline.validation, pck00011)',
  };
  return { add: () => undefined, orientation: () => vb.orient, provenance: () => prov };
}

function sunOf(light: LightData | null, pos: [number, number, number], level: ExistsLevel): SceneSun | null {
  if (!light) return null;
  const irr = allowedValue(light.sun.irradianceXYZS_1AU, level);
  const radius = allowedValue(light.sun.radius, level);
  if (!irr || radius === null) return null;
  const ld = allowedValue(light.sun.limbDarkening, level);
  return { pos, radius, irradianceXYZS_1AU: irr, limbDarkening: ld && ld.kind === 'poly-mu' ? ld.coeffsXYZS : null };
}

function usesOf(sb: SceneBody): string[] {
  const u: string[] = [];
  if (sb.albedoXYZS && sb.phase) u.push('disk photometry');
  if (sb.diskReflectanceModel) u.push(`disk model ${sb.diskReflectanceModel.kind}`);
  if (sb.spatialModel) u.push('spatial model');
  // The thickness layer is named as bound: cloudTau (measured) or cloudTauEstimated (the provider's estimates added).
  for (const k of ['albedo', 'height', 'photometry', 'clouds', 'cloudTau', 'water', 'night', 'wind'] as const) {
    const l = sb.surface?.[k];
    if (l) u.push(`map ${(l.header as { layer?: string }).layer ?? k}`);
  }
  if (sb.surface?.cloudTauUnmeasured) u.push('partly-cloudy τ statistic for the cloud without a retrieval (estimated)');
  if (sb.rings) u.push(`rings${sb.rings.reflectance ? '' : ' (absorbing only)'}`);
  if (sb.atmosphere) u.push('atmosphere');
  if (sb.surfaceUnknown) u.push('surface unknown (hatched)');
  return u;
}

/** The case's view as a SceneSnapshot drawn from the app's data. */
export function validationScene(c: ValidationCase, data: ValidationData, opts: ValidationOptions = {}): ValidationScene {
  const level = opts.reality ?? 'best';
  const ss = validationSampling(opts.ss);
  const v = c.view;
  const byId = new Map(data.bodies.map((b) => [b.id, b]));
  const notes: string[] = [];
  const bodies: SceneBody[] = [];
  const drawn: ValidationScene['bodies'] = [];
  for (const vb of v.bodies) {
    const body = byId.get(vb.naifId);
    if (!body) {
      notes.push(`${vb.name} (${vb.naifId}) is not in bodies.json: not drawn`);
      drawn.push({ naifId: vb.naifId, name: vb.name, drawn: 'none' });
      continue;
    }
    const lightTime = vb.rangeKm / C_KM_S;
    const g: BodyGeom = { id: vb.naifId, body, app: { rel: vb.pos, lightTime, emitEt: v.et - lightTime }, toSun: vb.toSun };
    const e = sceneBodyOf(g, level, caseOrientation(vb, body), 'measured', null, data.extras);
    if (!e) {
      drawn.push({ naifId: vb.naifId, name: vb.name, drawn: 'none' });
      continue;
    }
    if ('marker' in e) {
      notes.push(`${vb.name}: nothing photometric admitted at level ${level} (marker only)`);
      drawn.push({ naifId: vb.naifId, name: vb.name, drawn: 'marker', worstLabel: e.marker.worstLabel });
      continue;
    }
    const sb = e.body;
    // The case says whether its expected values include the planet's rings (Saturn); otherwise they are left out.
    if (!vb.rings && sb.rings) {
      delete sb.rings;
      notes.push(`${vb.name}: rings not attached (the case's view has none)`);
    }
    bodies.push(sb);
    drawn.push({ naifId: vb.naifId, name: vb.name, drawn: 'resolved', worstLabel: sb.worstLabel, uses: usesOf(sb) });
  }
  const snapshot: SceneSnapshot = {
    et: v.et,
    camera: { orient: v.camera.orient, fovY: v.camera.fovY, width: v.camera.width * ss, height: v.camera.height * ss },
    sun: sunOf(data.light, v.sun.pos, level),
    bodies,
    // The observer is an imager at the frame's own sampling, not an eye (EyeSettings.opticalCore): the case's
    // regions are read from the HDR buffer, and a body must be in it whenever the frame resolves it.
    view: { mode: 'eye', exposureBoostStops: 0, overlays: { provenanceTint: false }, eye: { opticalCore: false } },
    orbits: [],
  };
  if (!snapshot.sun) notes.push(`the Sun is not admitted at level ${level} (light.json)`);
  return { snapshot, notes, bodies: drawn };
}

// ---- comparison ----------------------------------------------------------------------------------------------

export interface RegionStats {
  mean: XYZS;
  std: XYZS;
  n: number;
}

export interface RoiResult {
  id: string;
  kind: ValidationRoi['kind'];
  target: number;
  rect: [number, number, number, number];
  expectedType: 'value' | 'upper-limit' | 'none';
  expected?: XYZS;
  sigma?: XYZS;
  tolerance?: XYZS;
  upperLimit?: XYZS;
  label?: Label;
  rendered: RegionStats;
  /** rendered / expected per channel (value ROIs). */
  ratio?: XYZS;
  /** (rendered − expected) / σ per channel (value ROIs). */
  deviationSigma?: XYZS;
  status?: 'not rendered';
  reason?: string;
  /** null: not compared or the whole case was not rendered. */
  pass: boolean | null;
  failing: string[];
  note?: string;
}

export function compareRoi(roi: ValidationRoi, r: RegionStats): RoiResult {
  const base = { id: roi.id, kind: roi.kind, target: roi.target, rect: roi.rect, rendered: r };
  const e = roi.expected;
  if (e.type === 'none') return { ...base, expectedType: 'none', pass: null, failing: [], note: e.method };
  if (!r.n) return { ...base, expectedType: e.type, pass: null, failing: [], note: 'no finite rendered pixels' };
  if (e.type === 'upper-limit') {
    const failing = CHANNELS.filter((_, c) => !(r.mean[c] <= e.upperLimitXYZS[c]));
    return { ...base, expectedType: 'upper-limit', upperLimit: e.upperLimitXYZS, label: e.label, pass: failing.length === 0, failing: [...failing] };
  }
  const ratio = r.mean.map((m, c) => m / e.XYZS[c]) as XYZS;
  const dev = r.mean.map((m, c) => (m - e.XYZS[c]) / e.sigma[c]) as XYZS;
  const failing = CHANNELS.filter((_, c) => !(Math.abs(r.mean[c] - e.XYZS[c]) <= e.tolerance[c]));
  return {
    ...base, expectedType: 'value', expected: e.XYZS, sigma: e.sigma, tolerance: e.tolerance, label: e.label,
    ratio, deviationSigma: dev, pass: failing.length === 0, failing: [...failing],
  };
}

export interface RatioResult {
  status?: 'not rendered';
  reason?: string;
  numerator: string;
  denominator: string;
  expected: XYZS;
  tolerance: XYZS;
  rendered: XYZS | null;
  pass: boolean | null;
  failing: string[];
}

export function compareRatios(c: ValidationCase, rois: RoiResult[]): RatioResult[] {
  const byId = new Map(rois.map((r) => [r.id, r]));
  return c.ratios.map((q) => {
    const a = byId.get(q.numerator), b = byId.get(q.denominator);
    const base = { numerator: q.numerator, denominator: q.denominator, expected: q.ratioXYZS, tolerance: q.tolerance };
    if (!a?.rendered.n || !b?.rendered.n) return { ...base, rendered: null, pass: null, failing: [] };
    const rendered = a.rendered.mean.map((m, k) => m / b.rendered.mean[k]) as XYZS;
    const failing = CHANNELS.filter((_, k) => !(Math.abs(rendered[k] - q.ratioXYZS[k]) <= q.tolerance[k]));
    return { ...base, rendered, pass: failing.length === 0, failing: [...failing] };
  });
}

/** The ROI's rectangle in the rendered image, which is ss times the view's size. */
export function scaledRect(rect: [number, number, number, number], ss: number): [number, number, number, number] {
  return [rect[0] * ss, rect[1] * ss, rect[2] * ss, rect[3] * ss];
}
