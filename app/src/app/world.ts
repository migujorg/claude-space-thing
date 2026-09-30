// Per-frame geometry of every body as seen from the camera: light-time-corrected camera-relative position
// (drawing) and the Sun direction at the emission epoch. Pure; computed once per frame and shared by the
// snapshot builder, labels, picking and the inspector. Geometric positions for navigation are evaluated on
// demand by the model (AppModel.bodyPos), not here: with hundreds of bodies every chain evaluation counts.

import type { Body } from '../data/schema';
import type { ApparentResult, CoreFunctions, EphemerisSetPort, Vec3 } from './ports';

export interface BodyGeom {
  id: number;
  body: Body;
  /** Apparent (light-time corrected) position relative to the camera. null → no ephemeris coverage now. */
  app: ApparentResult | null;
  /** Body center → Sun center at the emission epoch, km. null if either position is unavailable. */
  toSun: Vec3 | null;
}

export interface World {
  et: number;
  cameraPos: Vec3;
  sunId: number | null;
  bodies: Map<number, BodyGeom>;
}

/** Bodies that are physical objects (barycenters are bookkeeping points, not things you can see). */
export function isPhysical(b: Body): boolean {
  return b.kind !== 'barycenter';
}

export function findSunId(bodies: Body[]): number | null {
  return bodies.find((b) => b.kind === 'star')?.id ?? null;
}

/**
 * Largest radius of a body for navigation (keeping the camera outside, choosing viewing distances).
 * Uses any non-null value regardless of the reality level: navigation is not drawing.
 */
export function navRadius(b: Body | undefined): number | null {
  const r = b?.radii?.value;
  return r ? Math.max(r[0], r[1], r[2]) : null;
}

export function copy(v: Vec3 | null): Vec3 | null {
  return v ? [v[0], v[1], v[2]] : null;
}

export function computeWorld(
  et: number,
  cameraPos: Vec3,
  bodies: Body[],
  eph: EphemerisSetPort | null,
  core: Pick<CoreFunctions, 'apparentPosition'>,
  sunId: number | null,
): World {
  const out = new Map<number, BodyGeom>();
  const obs: Vec3 = [cameraPos[0], cameraPos[1], cameraPos[2]];
  for (const body of bodies) {
    if (!isPhysical(body)) continue;
    let app: ApparentResult | null = null;
    let toSun: Vec3 | null = null;
    // apparentPosition returns null when the chain does not cover the epoch (e.g. a system not loaded yet).
    const a = eph ? core.apparentPosition(eph, body.id, obs, et) : null;
    if (a) {
      // Copy at the port boundary: implementations may reuse scratch arrays between calls.
      app = { rel: [a.rel[0], a.rel[1], a.rel[2]], lightTime: a.lightTime, emitEt: a.emitEt };
      if (body.id === sunId) toSun = [0, 0, 0];
      else if (sunId !== null) {
        // The body at the emission epoch is observer + rel (rel = target(emitEt) − observer(et)).
        const s = eph!.positionSSB(sunId, app.emitEt);
        if (s) toSun = [s[0] - (obs[0] + app.rel[0]), s[1] - (obs[1] + app.rel[1]), s[2] - (obs[2] + app.rel[2])];
      }
    }
    out.set(body.id, { id: body.id, body, app, toSun });
  }
  return { et, cameraPos, sunId, bodies: out };
}
