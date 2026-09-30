// SceneSnapshot builder (render/scene.ts). Pure: applies the reality filter so that the renderer only
// ever receives values admitted at the current `exists` level (docs/architecture.md §5.2–5.3).
// Orientation comes from the OrientationSet at each body's light-emission epoch (precise product where it
// covers, else the IAU model), and its provenance label takes part in the filter.

import type { Body, Label, LightData } from '../data/schema';
import type { OrbitPolyline, SceneBody, SceneCamera, SceneSnapshot, SceneSun } from '../render/scene';
import type { OrientationSetPort, OrientationSourcePort, Vec3 } from './ports';
import { allowedValue, filterBody, labelAllowed, type ExistsLevel, type FilteredBody, type RealityState } from './reality';
import type { World } from './world';

export interface SnapshotInput {
  world: World;
  camera: SceneCamera;
  reality: RealityState;
  light: LightData | null;
  selectedId: number | null;
  orbits: OrbitPolyline[];
  orientations: OrientationSetPort;
  /** Label of the ephemeris chain serving a body (default 'measured'). */
  chainLabel?: (id: number) => Label;
}

export interface SunResult {
  sun: SceneSun | null;
  /** Why the Sun is not drawn (for the UI), when sun is null. */
  reason?: string;
}

export function buildSun(world: World, light: LightData | null, level: ExistsLevel): SunResult {
  if (world.sunId === null) return { sun: null, reason: 'No body of kind "star" in bodies.json.' };
  const g = world.bodies.get(world.sunId);
  if (!g?.app) return { sun: null, reason: 'No ephemeris for the Sun at this time.' };
  if (!light) return { sun: null, reason: 'light.json is missing.' };
  const irr = allowedValue(light.sun.irradianceXYZS_1AU, level);
  if (!irr) return { sun: null, reason: `Solar irradiance is ${light.sun.irradianceXYZS_1AU?.label ?? 'unknown'} — not admitted at this level.` };
  const radius = allowedValue(light.sun.radius, level);
  if (radius === null) return { sun: null, reason: `Solar radius is ${light.sun.radius?.label ?? 'unknown'} — not admitted at this level.` };
  const ld = allowedValue(light.sun.limbDarkening, level);
  return {
    sun: {
      pos: g.app.rel,
      radius,
      irradianceXYZS_1AU: irr,
      limbDarkening: ld && ld.kind === 'poly-mu' ? ld.coeffsXYZS : null,
    },
  };
}

/**
 * Memo of filterBody per (body, level, chain label, orientation provenance): bodies are immutable after
 * load, and the per-frame inputs take few distinct values, so the filter runs a handful of times per body.
 */
const filterMemo = new WeakMap<object, Map<string, FilteredBody>>();
export function filtered(body: Body, level: ExistsLevel, chainLabel?: Label, orientation?: OrientationSourcePort | null): FilteredBody {
  const key = `${level}|${chainLabel ?? ''}|${orientation === undefined ? '-' : orientation === null ? 'x' : `${orientation.kind}:${orientation.label}:${orientation.frame}`}`;
  let m = filterMemo.get(body);
  if (!m) filterMemo.set(body, (m = new Map()));
  let f = m.get(key);
  if (!f) m.set(key, (f = filterBody(body, level, { chainLabel, orientation })));
  return f;
}

/**
 * A body whose position is known but for which nothing photometric may be drawn (no admitted shape and no
 * admitted brightness). It is not sent to the renderer: its only representation is the §5.3 hollow marker,
 * an overlay the shell draws (decluttered, toggleable).
 */
export interface OverlayOnlyBody {
  id: number;
  name: string;
  /** Camera-relative apparent position, km. */
  pos: Vec3;
  worstLabel: Label;
  selected: boolean;
}

export function buildSnapshot(inp: SnapshotInput, out?: { overlayOnly: OverlayOnlyBody[] }): SceneSnapshot {
  const { world, reality } = inp;
  const level = reality.exists;
  const bodies: SceneBody[] = [];
  for (const g of world.bodies.values()) {
    if (g.body.kind === 'star' || g.body.kind === 'barycenter' || !g.app) continue;
    const emit = g.app.emitEt;
    // Orientation provenance only matters when a shape can be drawn.
    const r = g.body.radii;
    const shape = !!r?.value && labelAllowed(r.label, level);
    const oprov = shape ? inp.orientations.provenance(g.id, emit) : undefined;
    const f = filtered(g.body, level, inp.chainLabel?.(g.id), oprov);
    if (!f.position) continue;
    if (!f.radii && !f.albedoXYZS) {
      out?.overlayOnly.push({ id: g.id, name: g.body.name, pos: g.app.rel, worstLabel: f.worstLabel, selected: g.id === inp.selectedId });
      continue;
    }
    const lit = g.toSun !== null;
    const radii = f.radii ? ([f.radii[0], f.radii[1], f.radii[2]] as Vec3) : null;
    bodies.push({
      id: g.id,
      name: g.body.name,
      pos: g.app.rel,
      // Without a Sun direction the body cannot be lit: zero vector, and no photometry is passed.
      toSun: g.toSun ?? [0, 0, 0],
      orient: f.orientation ? inp.orientations.orientation(g.id, emit) : null,
      radii,
      albedoXYZS: lit ? f.albedoXYZS : null,
      phase: lit ? f.phase : null,
      surfaceUnknown: f.surfaceUnknown || (radii !== null && !lit),
      worstLabel: f.worstLabel,
      selected: g.id === inp.selectedId,
      // Best/complete may continue a measured phase curve with the spatial law (labelled estimated).
      allowPhaseExtrapolation: level !== 'strict',
    });
  }
  return {
    et: world.et,
    camera: inp.camera,
    sun: buildSun(world, inp.light, level).sun,
    bodies,
    view: {
      mode: reality.view,
      exposureBoostStops: reality.view === 'enhanced' ? reality.exposureBoostStops : 0,
      overlays: { provenanceTint: reality.overlays.provenanceTint },
    },
    orbits: reality.overlays.orbits ? inp.orbits : [],
  };
}
