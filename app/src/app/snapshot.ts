// SceneSnapshot builder (render/scene.ts). Pure: applies the reality filter so that the renderer only
// ever receives values admitted at the current `exists` level (docs/architecture.md §5.2–5.3).

import type { LightData } from '../data/schema';
import type { OrbitPolyline, SceneBody, SceneCamera, SceneSnapshot, SceneSun } from '../render/scene';
import type { CoreFunctions, Vec3 } from './ports';
import { allowedValue, filterBody, type ExistsLevel, type FilteredBody, type RealityState } from './reality';
import type { World } from './world';

export interface SnapshotInput {
  world: World;
  camera: SceneCamera;
  reality: RealityState;
  light: LightData | null;
  selectedId: number | null;
  orbits: OrbitPolyline[];
  core: Pick<CoreFunctions, 'bodyToIcrf'>;
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

/** Memo of filterBody per (body, level): bodies are immutable after load. */
const filterMemo = new WeakMap<object, Partial<Record<ExistsLevel, FilteredBody>>>();
export function filtered(body: Parameters<typeof filterBody>[0], level: ExistsLevel): FilteredBody {
  let m = filterMemo.get(body);
  if (!m) filterMemo.set(body, (m = {}));
  return (m[level] ??= filterBody(body, level));
}

export function buildSnapshot(inp: SnapshotInput): SceneSnapshot {
  const { world, reality } = inp;
  const level = reality.exists;
  const bodies: SceneBody[] = [];
  for (const g of world.bodies.values()) {
    if (g.body.kind === 'star' || g.body.kind === 'barycenter' || !g.app) continue;
    const f = filtered(g.body, level);
    const lit = g.toSun !== null;
    const radii = f.radii ? ([f.radii[0], f.radii[1], f.radii[2]] as Vec3) : null;
    bodies.push({
      id: g.id,
      name: g.body.name,
      pos: g.app.rel,
      // Without a Sun direction the body cannot be lit: zero vector, and no photometry is passed.
      toSun: g.toSun ?? [0, 0, 0],
      orient: f.rotation ? inp.core.bodyToIcrf(f.rotation, g.app.emitEt) : null,
      radii,
      albedoXYZS: lit ? f.albedoXYZS : null,
      phase: lit ? f.phase : null,
      surfaceUnknown: f.surfaceUnknown || (radii !== null && !lit),
      worstLabel: f.worstLabel,
      selected: g.id === inp.selectedId,
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
