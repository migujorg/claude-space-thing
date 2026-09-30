// SceneSnapshot builder (render/scene.ts). Pure: applies the reality filter so that the renderer only
// ever receives values admitted at the current `exists` level (docs/architecture.md §5.2–5.3).
// Orientation comes from the OrientationSet at each body's light-emission epoch (precise product where it
// covers, else the IAU model), and its provenance label takes part in the filter.

import type { Body, Label, LightData } from '../data/schema';
import type { OrbitPolyline, SceneBody, SceneCamera, SceneSnapshot, SceneSun } from '../render/scene';
import type { OrientationSetPort, OrientationSourcePort, Vec3 } from './ports';
import { allowedValue, filterBody, labelAllowed, worstOf, type ExistsLevel, type FilteredBody, type RealityState } from './reality';
import { applyExtras, type SceneExtras } from './extras';
import type { BodyGeom, World } from './world';

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
  /** Surface maps, rings, disk/spatial photometric models (architecture §4.4, §6). */
  extras?: SceneExtras;
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

/** How one body enters the scene at a level: a SceneBody, an overlay-only marker, or nothing (position withheld). */
export function sceneBodyOf(
  g: BodyGeom,
  level: ExistsLevel,
  orientations: OrientationSetPort,
  chainLabel: Label | undefined,
  selectedId: number | null,
  extras?: SceneExtras,
  /** Radians per pixel at the view centre (render/frame.ts cameraGeom), to tell a point from a resolved disk. */
  pixelAngle?: number,
): { body: SceneBody } | { marker: OverlayOnlyBody } | null {
  if (!g.app) return null;
  const emit = g.app.emitEt;
  // Orientation provenance only matters when a shape can be drawn.
  const r = g.body.radii;
  const shape = !!r?.value && labelAllowed(r.label, level);
  const oprov = shape ? orientations.provenance(g.id, emit) : undefined;
  const f = filtered(g.body, level, chainLabel, oprov);
  if (!f.position) return null;
  if (!f.radii && !f.albedoXYZS) return { marker: { id: g.id, name: g.body.name, pos: g.app.rel, worstLabel: f.worstLabel, selected: g.id === selectedId } };
  const lit = g.toSun !== null;
  const radii = f.radii ? ([f.radii[0], f.radii[1], f.radii[2]] as Vec3) : null;
  const sb: SceneBody = {
    id: g.id,
    name: g.body.name,
    pos: g.app.rel,
    // Without a Sun direction the body cannot be lit: zero vector, and no photometry is passed.
    toSun: g.toSun ?? [0, 0, 0],
    orient: f.orientation ? orientations.orientation(g.id, emit) : null,
    radii,
    albedoXYZS: lit ? f.albedoXYZS : null,
    phase: lit ? f.phase : null,
    surfaceUnknown: f.surfaceUnknown || (radii !== null && !lit),
    worstLabel: f.worstLabel,
    selected: g.id === selectedId,
    // Best/complete may continue a measured phase curve with the spatial law (labelled estimated).
    allowPhaseExtrapolation: level !== 'strict',
  };
  const used = applyExtras(sb, g.body, extras, level, lit);
  // Shape model (app/shapes.ts): a mesh in place of the ellipsoid, when its labels are admitted and it can be placed.
  const mesh = extras?.shapes && sb.radii ? extras.shapes.sceneShape(sb, level, emit) : null;
  if (mesh && sb.radii) {
    // Only a disk at least a pixel across is drawn from the mesh (render/frame.ts resolves it at the mean radius);
    // a point is drawn from the disk photometry alone, so the mesh and its labels are not part of it.
    const R = Math.cbrt(sb.radii[0] * sb.radii[1] * sb.radii[2]);
    const D = Math.hypot(sb.pos[0], sb.pos[1], sb.pos[2]);
    const px = pixelAngle ? (2 * Math.asin(Math.min(1, R / D))) / pixelAngle : Infinity;
    if (px > 1) {
      sb.shape = mesh;
      used.push(mesh.worstLabel);
    } else extras!.shapes!.asPoint(sb.id);
  }
  if (used.length) sb.worstLabel = worstOf([sb.worstLabel, ...used]);
  return { body: sb };
}

export function buildSnapshot(inp: SnapshotInput, out?: { overlayOnly: OverlayOnlyBody[] }): SceneSnapshot {
  const { world, reality } = inp;
  const level = reality.exists;
  const bodies: SceneBody[] = [];
  const pixelAngle = (2 * Math.tan(inp.camera.fovY / 2)) / inp.camera.height;
  for (const g of world.bodies.values()) {
    // Small bodies (negative ids) are drawn by the small-body field; the model adds a resolved close-up itself.
    if (g.id < 0 || g.body.kind === 'star' || g.body.kind === 'barycenter' || !g.app) continue;
    const e = sceneBodyOf(g, level, inp.orientations, inp.chainLabel?.(g.id), inp.selectedId, inp.extras, pixelAngle);
    if (!e) continue;
    if ('marker' in e) out?.overlayOnly.push(e.marker);
    else bodies.push(e.body);
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
      ...(reality.sunShield ? { sunShield: true } : {}),
    },
    orbits: reality.overlays.orbits ? inp.orbits : [],
  };
}
