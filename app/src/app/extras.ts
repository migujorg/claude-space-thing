// M2 scene extras the reality filter admits per body: surface-map layers (architecture §4.4), ring systems
// (rings.json) and whole-disk/spatial photometric models. Pure; used by snapshot.ts.

import type { AtmosphereFile, Body, Label, RingsFile, RingSystem } from '../data/schema';
import type { SurfaceLayer } from '../data/surfaces';
import type { Mat3, SceneBody, SceneRings, SurfaceLayerRef } from '../render/scene';
import { unmeasuredTauPopulation } from '../render/earth';
import { allowedValue, labelAllowed, worstOf, type ExistsLevel } from './reality';
import type { ShapeLibrary } from './shapes';
import { EARTH_ID, type NightglowSource } from './nightglow';

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
  /** Earth's dated layers (render/earth.ts): 'cloud-properties', 'surface-water', 'emitted-radiance', 'surface-wind'. */
  clouds?: LayerRef;
  /** 'cloud-optical-thickness-moments' (render/earth.ts cloudLogNormal). */
  cloudTau?: LayerRef;
  water?: LayerRef;
  night?: LayerRef;
  wind?: LayerRef;
}

export interface SceneExtras {
  surfaces: Map<number, BodySurfaces>;
  rings: RingsFile | null;
  /** atmospheres.json, when loaded (render/scene.ts SceneBody.atmosphere). */
  atmospheres?: AtmosphereFile | null;
  /** Shape models (render/scene.ts SceneBody.shape), when shapes/index.json is loaded. */
  shapes?: ShapeLibrary | null;
  /** Earth's airglow and aurora (render/scene.ts SceneBody.nightglow), with the time scale to evaluate them. */
  nightglow?: { source: NightglowSource; etToUtcMs: (et: number) => number } | null;
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
    else if (h.kind === 'cloud-properties') e.clouds = { ref, label: headerLabel(h, 'brightness') };
    else if (h.kind === 'cloud-optical-thickness-moments') e.cloudTau = { ref, label: headerLabel(h, 'brightness') };
    else if (h.kind === 'surface-water') e.water = { ref, label: headerLabel(h, 'brightness') };
    else if (h.kind === 'emitted-radiance') e.night = { ref, label: worstOf([headerLabel(h, 'brightness'), headerLabel(h, 'color')]) };
    else if (h.kind === 'surface-wind') e.wind = { ref, label: headerLabel(h, 'brightness') };
    else continue;
    out.set(l.bodyId, e);
  }
  return out;
}

/**
 * A body's atmosphere from atmospheres.json when every known value it needs is admitted at the level, else null.
 * Extinction must be known. A single-scattering albedo or phase function that is unknown (Titan's haze) does not
 * withhold it: the renderer draws no light for it and marks the air beyond the disk "not measured".
 */
export function atmosphereFor(file: AtmosphereFile | null | undefined, id: number, level: ExistsLevel): SceneBody['atmosphere'] {
  const b = file?.bodies[String(id)];
  if (!file || !b || !b.components.length || !file.foldWeights.value) return null;
  const labels: Label[] = [file.foldWeights.label];
  for (const c of b.components) {
    if (c.extinctionPerKm.label === 'unknown') return null;
    labels.push(c.extinctionPerKm.label);
    for (const l of [c.singleScatteringAlbedo.label, c.phaseFunction.label]) if (l !== 'unknown') labels.push(l);
  }
  if (!labels.every((l) => labelAllowed(l, level))) return null;
  return { wavelengthsNm: file.wavelengthsNm, foldWeights: file.foldWeights.value, body: b, worstLabel: worstOf(labels) };
}

/** The body's IAU north pole in ICRF: the body-fixed z axis, i.e. column 2 of the row-major body→ICRF matrix. */
export function poleOf(m: Mat3): [number, number, number] {
  return [m[2], m[5], m[8]];
}

function ringsFor(sys: RingSystem, orient: Mat3, level: ExistsLevel, et: number | undefined): SceneRings | null {
  // Ring components (Jupiter, Uranus, Neptune: ringComponents.ts) replace the classic radial profile when admitted;
  // the classic profile (opticalDepth, reflectance) stays for Saturn and for a level that does not admit them.
  const comps = allowedValue(sys.components, level);
  if (comps) {
    return {
      normal: poleOf(orient),
      opticalDepth: [],
      reflectance: null,
      components: comps,
      et,
      worstLabel: sys.components!.label,
    };
  }
  const estimate = allowedValue(sys.opticalDepthEstimate, level);
  const selected = estimate ? sys.opticalDepthEstimate! : sys.opticalDepth;
  const od = estimate ?? allowedValue(sys.opticalDepth, level);
  if (!od) return null;
  const refl = allowedValue(sys.reflectance, level);
  return {
    normal: poleOf(orient),
    opticalDepth: od.map((p) => ({ radiusKm: p.radiusKm, normalTau: p.normalTau })),
    reflectance: refl,
    worstLabel: worstOf([selected.label, ...(refl ? [sys.reflectance.label] : [])]),
  };
}

/**
 * Adds the admitted extras to a scene body in place and returns the worst label among what was added.
 * Maps and rings need the body-fixed frame, so they are only added when `sb.orient` is set.
 */
export function applyExtras(
  sb: SceneBody,
  body: Body,
  extras: SceneExtras | undefined,
  level: ExistsLevel,
  lit: boolean,
  /** Emission time (TDB seconds past J2000) the body is seen at: time-varying ring structure (precession, arcs) and nightglow. */
  emitEt?: number,
): Label[] {
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
  const atm = atmosphereFor(extras.atmospheres, body.id, level);
  const s = extras.surfaces.get(body.id);
  if (s && sb.radii) {
    const surface: SceneBody['surface'] = {};
    // A map of surface-only reflectance (no clouds, no atmosphere: Earth) must not be scaled by disk photometry,
    // which includes them. The renderer draws it with its clouds and its atmosphere (render/earth.ts); without
    // both admitted, the disk-photometry colour is the more faithful view, so the map is withheld.
    const surfaceOnly = !!(s.albedo?.ref.header as { normalization?: { absoluteDiskMean?: unknown } } | undefined)?.normalization?.absoluteDiskMean;
    const earthOk = surfaceOnly && !!atm && !!s.clouds && labelAllowed(s.clouds.label, level);
    if (s.albedo && lit && !sb.surfaceUnknown && (!surfaceOnly || earthOk) && labelAllowed(s.albedo.label, level)) {
      surface.albedo = s.albedo.ref;
      used.push(s.albedo.label);
      if (earthOk) {
        sb.atmosphere = atm;
        used.push(atm!.worstLabel);
        for (const k of ['clouds', 'cloudTau', 'water', 'night', 'wind'] as const) {
          const l = s[k];
          if (l && labelAllowed(l.label, level)) {
            surface[k] = l.ref;
            used.push(l.label);
          }
        }
        // The cloud without a retrieval: the partly-cloudy τ population of cloudTau's header (estimated) where the
        // level admits it (Best, Complete); at Strict it stays unknown (render/earth.ts unmeasuredTauPopulation).
        const un = surface.cloudTau ? unmeasuredTauPopulation(surface.cloudTau.header) : null;
        const unLabel = un && (LABELS.includes(un.label) ? (un.label as Label) : 'unknown');
        if (un && unLabel && labelAllowed(unLabel, level)) {
          surface.cloudTauUnmeasured = { taus: un.taus, p: un.p };
          used.push(unLabel);
        }
      }
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
  // Other bodies with an atmosphere (Mars, Venus, Pluto, Titan) keep their disk photometry; the renderer
  // renormalizes it under the air (docs/rendering-earth.md §8).
  if (atm && !sb.atmosphere && lit && !sb.surfaceUnknown) {
    sb.atmosphere = atm;
    used.push(atm.worstLabel);
  }
  // Earth's own light at night: needs the body-fixed frame (local time, magnetic coordinates) and the time.
  if (body.id === EARTH_ID && extras.nightglow && sb.radii && emitEt !== undefined) {
    const ms = extras.nightglow.etToUtcMs(emitEt);
    const ng = Number.isFinite(ms) ? extras.nightglow.source.scene(level, ms) : null;
    if (ng) {
      sb.nightglow = ng;
      used.push(ng.worstLabel);
    }
  }
  const sys = extras.rings?.[String(body.id)];
  if (sys) {
    const r = ringsFor(sys, sb.orient, level, emitEt);
    sb.rings = r;
    if (r) used.push(r.worstLabel);
  }
  return used;
}
