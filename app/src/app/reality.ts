// Reality settings (NORTH_STAR 3.7, docs/architecture.md §5.2–5.3) and the per-attribute filter.
// Pure: no DOM, no GPU.

import { LABEL_ORDER, type Body, type IauRotation, type Label, type PhaseFunction, type Sourced } from '../data/schema';

export type ExistsLevel = 'strict' | 'best' | 'complete';
export type ViewMode = 'eye' | 'enhanced';

export interface Overlays {
  labels: boolean;
  orbits: boolean;
  provenanceTint: boolean;
}

export interface RealityState {
  exists: ExistsLevel;
  view: ViewMode;
  /** Extra exposure in stops; only applied in 'enhanced'. */
  exposureBoostStops: number;
  overlays: Overlays;
}

export const EXISTS_LEVELS: readonly ExistsLevel[] = ['strict', 'best', 'complete'];
export const VIEW_MODES: readonly ViewMode[] = ['eye', 'enhanced'];

/** Which labels each level admits. 'unknown' is never admitted: there is no value to draw. */
export const ALLOWED_LABELS: Record<ExistsLevel, readonly Label[]> = {
  strict: ['measured', 'derived'],
  best: ['measured', 'derived', 'estimated'],
  complete: ['measured', 'derived', 'estimated', 'synthetic'],
};

export const EXISTS_TEXT: Record<ExistsLevel, { name: string; blurb: string }> = {
  strict: { name: 'Strict', blurb: 'Measured + derived only. Unknowns are shown as unknown.' },
  best: { name: 'Best estimate', blurb: 'Adds estimated attributes of known objects (population statistics, model assumptions).' },
  complete: { name: 'Complete', blurb: 'Adds synthetic objects sampled from measured population models.' },
};

export const VIEW_TEXT: Record<ViewMode, { name: string; blurb: string }> = {
  eye: { name: 'Naked eye', blurb: 'What a human eye would perceive. The truth.' },
  enhanced: { name: 'Enhanced', blurb: 'Eye limits lifted: exposure boosted, faint things brightened.' },
};

export const LABEL_TEXT: Record<Label, string> = {
  measured: 'Taken directly from an observational dataset (including fitted products such as ephemerides).',
  derived: 'Computed from measured values by established physics, with no assumed inputs.',
  estimated: 'Computed with at least one assumed input: a population statistic or a modeling assumption.',
  synthetic: 'A whole object that is not individually known, sampled from a measured population model.',
  unknown: 'No data, and we do not pretend otherwise.',
};

/**
 * Defaults (NORTH_STAR 3.7): Best estimate + Naked eye until a synthetic layer exists, then Complete.
 * Overlays: labels on (a DOM overlay that is obviously not part of the scene), orbits and tint off.
 */
export function defaultReality(opts: { syntheticLayerAvailable?: boolean } = {}): RealityState {
  return {
    exists: opts.syntheticLayerAvailable ? 'complete' : 'best',
    view: 'eye',
    exposureBoostStops: 0,
    overlays: { labels: true, orbits: false, provenanceTint: false },
  };
}

export function labelAllowed(label: Label, level: ExistsLevel): boolean {
  return ALLOWED_LABELS[level].includes(label);
}

/** The value of a Sourced attribute if its label is admitted at this level, else null. */
export function allowedValue<T>(s: Sourced<T> | null | undefined, level: ExistsLevel): T | null {
  if (!s || s.value === null || s.value === undefined) return null;
  return labelAllowed(s.label, level) ? s.value : null;
}

export function labelRank(l: Label): number {
  return LABEL_ORDER.indexOf(l);
}

export function worstOf(labels: Iterable<Label>): Label {
  let w = 0;
  for (const l of labels) w = Math.max(w, labelRank(l));
  return LABEL_ORDER[w];
}

// ---- per-body filter ----------------------------------------------------------------------------

export type AttrKey = 'position' | 'radii' | 'rotation' | 'albedoXYZS' | 'phaseFunction';

export interface AttrUse {
  key: AttrKey;
  /** Human name for the "why does it look like this" line. */
  what: string;
  label: Label;
  used: boolean;
  /** Why not used: 'unknown' (no value) or 'level' (label not admitted), or 'dependency'. */
  reason?: 'unknown' | 'level' | 'dependency';
}

export interface FilteredBody {
  radii: [number, number, number] | null;
  rotation: IauRotation | null;
  albedoXYZS: [number, number, number, number] | null;
  phase: PhaseFunction | null;
  surfaceUnknown: boolean;
  worstLabel: Label;
  uses: AttrUse[];
}

/**
 * Apply the `exists` level to one body's drawable attributes.
 * Position is always 'derived' (ephemeris evaluation + light-time correction) and is never withheld.
 * The surface is drawn lit only when shape, reflectance and phase function are all admitted; when the
 * shape is admitted but either of the others is not, the renderer draws the hatched "not measured"
 * silhouette (surfaceUnknown). worstLabel covers exactly what is drawn.
 */
export function filterBody(body: Body, level: ExistsLevel): FilteredBody {
  const uses: AttrUse[] = [];
  const use = <T>(key: AttrKey, what: string, s: Sourced<T> | undefined): T | null => {
    const label: Label = s?.label ?? 'unknown';
    const v = allowedValue(s, level);
    uses.push({ key, what, label, used: v !== null, ...(v === null ? { reason: s && s.value !== null && s.value !== undefined && label !== 'unknown' ? 'level' : 'unknown' } : {}) });
    return v;
  };
  uses.push({ key: 'position', what: 'position', label: 'derived', used: true });
  const radii = use('radii', 'shape (radii)', body.radii);
  const rotation = use('rotation', 'orientation', body.rotation);
  const albedo = use('albedoXYZS', 'reflectance (albedo)', body.photometry?.geometricAlbedoXYZS);
  const phase = use('phaseFunction', 'phase function', body.photometry?.phaseFunction);

  const surfaceKnown = radii !== null && albedo !== null && phase !== null;
  const surfaceUnknown = radii !== null && !surfaceKnown;
  // A point source needs brightness (albedo + phase) but not shape; with neither shape nor brightness
  // nothing photometric is drawn (overlay marker only).
  // Albedo and phase function are only meaningful together; orientation only with a shape.
  const drawnAlbedo = albedo !== null && phase !== null ? albedo : null;
  const drawnPhase = drawnAlbedo !== null ? phase : null;
  const drawnRotation = radii !== null ? rotation : null;
  for (const u of uses) {
    const dependent =
      ((u.key === 'albedoXYZS' || u.key === 'phaseFunction') && drawnAlbedo === null) || (u.key === 'rotation' && radii === null);
    if (u.used && dependent) {
      u.used = false;
      u.reason = 'dependency';
    }
  }
  const worstLabel = worstOf(uses.filter((u) => u.used).map((u) => u.label));
  return { radii, rotation: drawnRotation, albedoXYZS: drawnAlbedo, phase: drawnPhase, surfaceUnknown, worstLabel, uses };
}

// ---- badge & explanations -----------------------------------------------------------------------

/**
 * Text parts for the persistent top-center badge; empty when everything that affects the pixels is at
 * its default. Labels/orbits overlays are self-evidently overlays and not listed; the provenance tint
 * recolors objects, so it is.
 */
export function badgeParts(s: RealityState, defaults: RealityState, opts: { syntheticLayerAvailable?: boolean } = {}): string[] {
  const parts: string[] = [];
  if (s.exists !== defaults.exists) {
    if (s.exists === 'strict') parts.push('STRICT: measured + derived only');
    else if (s.exists === 'best') parts.push('BEST ESTIMATE: includes estimated values');
    else parts.push(opts.syntheticLayerAvailable ? 'COMPLETE: includes synthetic objects' : 'COMPLETE (no synthetic layer loaded)');
  }
  if (s.view === 'enhanced') {
    const b = s.exposureBoostStops;
    parts.push(b ? `ENHANCED ${b > 0 ? '+' : ''}${fmtStops(b)} stops` : 'ENHANCED');
  }
  if (s.overlays.provenanceTint) parts.push('PROVENANCE TINT');
  return parts;
}

function fmtStops(b: number): string {
  return Number.isInteger(b) ? String(b) : b.toFixed(1);
}

/** One-line "why does it look like this" for a filtered body at a level. */
export function whyLine(f: FilteredBody, level: ExistsLevel): string {
  const used = f.uses.filter((u) => u.used).map((u) => `${u.what} (${u.label})`);
  const withheld = f.uses.filter((u) => !u.used && u.reason === 'level').map((u) => `${u.what} (${u.label})`);
  const unknown = f.uses.filter((u) => !u.used && u.reason === 'unknown').map((u) => u.what);
  const dep = f.uses.filter((u) => !u.used && u.reason === 'dependency').map((u) => u.what);
  let s = `At ${EXISTS_TEXT[level].name} the renderer may use: ${used.join(', ') || 'nothing'}.`;
  if (withheld.length) s += ` Withheld at this level: ${withheld.join(', ')}.`;
  if (unknown.length) s += ` Unknown: ${unknown.join(', ')}.`;
  if (dep.length) s += ` Not used (its counterpart is missing): ${dep.join(', ')}.`;
  if (f.surfaceUnknown) s += ' → Shape is drawn with the hatched "not measured" material, not a guessed color.';
  else if (f.radii === null && f.albedoXYZS !== null) s += ' → Drawn as a point of its computed brightness (no admitted shape).';
  else if (f.radii === null) s += ' → No admitted shape or brightness: only an overlay marker can show it.';
  return s;
}
