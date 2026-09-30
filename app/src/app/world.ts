// Per-frame geometry of every body as seen from the camera: geometric SSB position (navigation),
// light-time-corrected camera-relative position (drawing), and the Sun direction at the emission epoch.
// Pure; computed once per frame and shared by the snapshot builder, labels, picking and the inspector.

import type { Body } from '../data/schema';
import type { ApparentResult, CoreFunctions, EphemerisSetPort, Vec3 } from './ports';
import { sub } from './vec';

export interface BodyGeom {
  id: number;
  body: Body;
  /** Geometric position at et, SSB, km. null → no ephemeris coverage now. */
  ssb: Vec3 | null;
  /** Apparent (light-time corrected) position relative to the camera. */
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

export function computeWorld(
  et: number,
  cameraPos: Vec3,
  bodies: Body[],
  eph: EphemerisSetPort | null,
  core: Pick<CoreFunctions, 'apparentPosition'>,
  sunId: number | null,
): World {
  const out = new Map<number, BodyGeom>();
  for (const body of bodies) {
    if (!isPhysical(body)) continue;
    let ssb: Vec3 | null = null;
    let app: ApparentResult | null = null;
    let toSun: Vec3 | null = null;
    if (eph && eph.covers(body.id, et)) {
      ssb = eph.positionSSB(body.id, et);
      app = core.apparentPosition(eph, body.id, cameraPos, et);
      if (app) {
        if (body.id === sunId) toSun = [0, 0, 0];
        else if (sunId !== null) {
          const s = eph.positionSSB(sunId, app.emitEt);
          const b = eph.positionSSB(body.id, app.emitEt);
          if (s && b) toSun = sub(s, b);
        }
      }
    }
    out.set(body.id, { id: body.id, body, ssb, app, toSun });
  }
  return { et, cameraPos, sunId, bodies: out };
}
