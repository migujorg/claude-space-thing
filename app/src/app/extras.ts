// M2 scene extras the reality filter admits per body: surface-map layers (architecture §4.4), ring systems
// (rings.json) and whole-disk/spatial photometric models. Pure; used by snapshot.ts.

import type { Body, Label, RingsFile, RingSystem } from '../data/schema';
import type { SurfaceLayer } from '../data/surfaces';
import type { Mat3, SceneBody, SceneRings, SurfaceLayerRef } from '../render/scene';
import { allowedValue, labelAllowed, worstOf, type ExistsLevel } from './reality';

export interface LayerRef {
  ref: SurfaceLayerRef;
  /** Worst of the layer's own labels (albedo: brightness pattern and colour; height: the relief). */
  label: Label;
}

export interface BodySurfaces {
  albedo?: LayerRef;
  height?: LayerRef;
  /** Per-texel photometric parameters (layer kind 'photometric-parameters', e.g. the Moon's Hapke maps). */
  photometry?: LayerRef;
}

export interface SceneExtras {
  surfaces: Map<number, BodySurfaces>;
  rings: RingsFile | null;
}

const LABELS: readonly string[] = ['measured', 'derived', 'estimated', 'synthetic', 'unknown'];
function headerLabel(h: Record<string, unknown>, key: string): Label {
  const l = (h[key] as { label?: unknown } | undefined)?.label;
  return LABELS.includes(l as string) ? (l as Label) : 'unknown';
}

/** Group surface layers by body, with the data root the renderer resolves `tilePath` against. */
export function surfaceRefs(layers: SurfaceLayer[], dataRoot: string): Map<number, BodySurfaces> {
  const root = dataRoot.replace(/\/+$/, '');
  const out = new Map<number, BodySurfaces>();
  for (const l of layers) {
    const h = l.header;
    if (typeof h.maxLevel !== 'number') continue;
    const ref: SurfaceLayerRef = { url: root, header: h as SurfaceLayerRef['header'] };
    const e = out.get(l.bodyId) ?? {};
    if (l.layer === 'albedo') e.albedo = { ref, label: worstOf([headerLabel(h, 'brightness'), headerLabel(h, 'color')]) };
    else if (l.layer === 'height') e.height = { ref, label: headerLabel(h, 'brightness') };
    else if (h.kind === 'photometric-parameters') e.photometry = { ref, label: headerLabel(h, 'brightness') };
    else continue;
    out.set(l.bodyId, e);
  }
  return out;
}

/** The body's IAU north pole in ICRF: the body-fixed z axis, i.e. column 2 of the row-major body→ICRF matrix. */
export function poleOf(m: Mat3): [number, number, number] {
  return [m[2], m[5], m[8]];
}

function ringsFor(sys: RingSystem, orient: Mat3, level: ExistsLevel): SceneRings | null {
  const od = allowedValue(sys.opticalDepth, level);
  if (!od) return null;
  const refl = allowedValue(sys.reflectance, level);
  return {
    normal: poleOf(orient),
    opticalDepth: od.map((p) => ({ radiusKm: p.radiusKm, normalTau: p.normalTau })),
    reflectance: refl,
    worstLabel: worstOf([sys.opticalDepth.label, ...(refl ? [sys.reflectance.label] : [])]),
  };
}

/**
 * Adds the admitted extras to a scene body in place and returns the worst label among what was added.
 * Maps and rings need the body-fixed frame, so they are only added when `sb.orient` is set.
 */
export function applyExtras(sb: SceneBody, body: Body, extras: SceneExtras | undefined, level: ExistsLevel, lit: boolean): Label[] {
  const used: Label[] = [];
  const p = body.photometry;
  const disk = lit ? allowedValue(p?.diskReflectanceModel, level) : null;
  if (disk) {
    sb.diskReflectanceModel = disk;
    used.push(p!.diskReflectanceModel!.label);
  }
  const spatial = lit ? allowedValue(p?.spatialModel, level) : null;
  if (spatial) {
    sb.spatialModel = spatial;
    used.push(p!.spatialModel!.label);
  }
  if (!extras || !sb.orient) return used;
  const s = extras.surfaces.get(body.id);
  if (s && sb.radii) {
    const surface: SceneBody['surface'] = {};
    // A map of surface-only reflectance (no clouds, no atmosphere: Earth) must not be scaled by disk photometry,
    // which includes them. Until the renderer draws clouds and air from their own layers, the disk-photometry
    // colour is the more faithful view, so such a map is withheld.
    const surfaceOnly = !!(s.albedo?.ref.header as { normalization?: { absoluteDiskMean?: unknown } } | undefined)?.normalization?.absoluteDiskMean;
    if (s.albedo && lit && !sb.surfaceUnknown && !surfaceOnly && labelAllowed(s.albedo.label, level)) {
      surface.albedo = s.albedo.ref;
      used.push(s.albedo.label);
    }
    if (s.height && labelAllowed(s.height.label, level)) {
      surface.height = s.height.ref;
      used.push(s.height.label);
    }
    if (s.photometry && surface.albedo && labelAllowed(s.photometry.label, level)) {
      surface.photometry = s.photometry.ref;
      used.push(s.photometry.label);
    }
    if (surface.albedo || surface.height) sb.surface = surface;
  }
  const sys = extras.rings?.[String(body.id)];
  if (sys) {
    const r = ringsFor(sys, sb.orient, level);
    sb.rings = r;
    if (r) used.push(r.worstLabel);
  }
  return used;
}
