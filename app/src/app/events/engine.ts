// The event finder's compute side: holds the ephemerides, orientation models, body radii and (for close
// approaches) the small-body propagator, and answers one category at a time. Runs in events.worker.ts; the same
// class runs in-process where workers are unavailable (tests, Node).

import { Ephemeris, EphemerisSet } from '../../core/ephemeris';
import { OrientationSet, PreciseOrientation } from '../../core/rotation';
import { SmallBodyPropagator, type NonGrav } from '../../core/smallbody';
import type { Body, EphemHeader, OrientationHeader, SmallBodyForceModel } from '../../data/schema';
import type { Mat3, Vec3 } from '../ports';
import { findEvents, type EventCategory, type FinderInput, type SkyEvent } from './finder';
import { neoApproaches, type NeoCandidate } from './neo';

export type Category = EventCategory | 'neo';
export const CATEGORIES: Category[] = ['eclipses', 'planets', 'saturn', 'jovian', 'pluto', 'neo'];

export interface EphemFile { path: string; header: EphemHeader; data: Float64Array }
export interface OrientFile { path: string; header: OrientationHeader; data: Float64Array }

export interface EngineInit {
  /** Ephemeris files in load order (the chain resolves as on the main thread). */
  ephem: EphemFile[];
  /** bodies.json (radii and IAU rotation models only are used). */
  bodies: Pick<Body, 'id' | 'radii' | 'rotation'>[];
  orientations: OrientFile[];
  window: { startEt: number; endEt: number };
}

export interface SmallBodyInit {
  forceModel: SmallBodyForceModel;
  epochEt: number;
  window: { startEt: number; endEt: number };
  /** Report approaches closer than this (km). */
  maxKm: number;
  candidates: { row: number; state: number[]; ng: NonGrav | null; H: number | null }[];
}

export class EventEngine {
  private readonly eph: EphemerisSet | null;
  private sb: SmallBodyInit | null = null;
  /** Problems with individual files (reported, the rest keeps working). */
  readonly errors: string[] = [];

  /** From an input that is already live (the model's own ephemerides on the main thread; tests). */
  constructor(private readonly inp: FinderInput, eph: EphemerisSet | null = null) {
    this.eph = eph;
  }

  /** From the files (in a worker): builds its own ephemeris set and orientation models. */
  static fromFiles(init: EngineInit): EventEngine {
    const eph = new EphemerisSet();
    const orient = new OrientationSet(init.bodies);
    const radii = new Map<number, Vec3>();
    for (const b of init.bodies) if (b.radii?.value) radii.set(b.id, [b.radii.value[0], b.radii.value[1], b.radii.value[2]]);
    const engine = new EventEngine({
      eph: { positionSSB: (id, et) => eph.positionSSB(id, et) as Vec3 | null },
      radii,
      orientation: (id, et) => orient.orientation(id, et) as Mat3 | null,
      window: init.window,
    }, eph);
    for (const f of init.ephem) engine.addEphem(f);
    for (const o of init.orientations) {
      try {
        orient.add(new PreciseOrientation(o.header, o.data));
      } catch (e) {
        engine.errors.push(`${o.path}: ${(e as Error).message ?? e}`);
      }
    }
    return engine;
  }

  /** A file loaded later (a moon system); ignored by a live-input engine (its set already has it). */
  addEphem(f: EphemFile): void {
    if (!this.eph) return;
    try {
      this.eph.add(new Ephemeris(f.header, f.data));
    } catch (e) {
      this.errors.push(`${f.path}: ${(e as Error).message ?? e}`);
    }
  }

  setSmallBodies(sb: SmallBodyInit): void {
    this.sb = sb;
  }

  input(): FinderInput {
    return this.inp;
  }

  find(category: Category, onProgress?: (f: number) => void): SkyEvent[] {
    if (category !== 'neo') return findEvents(this.input(), category, onProgress);
    const sb = this.sb;
    if (!sb) throw new Error('the small-body catalogue is not loaded');
    // The propagator only calls positionSSB (the perturbers), as in smallbodies.ts.
    const prop = new SmallBodyPropagator(sb.forceModel, (this.eph ?? { positionSSB: this.inp.eph.positionSSB }) as unknown as EphemerisSet);
    // Only where both the catalogue's propagation and the ephemerides are defined.
    const w = this.inp.window;
    const window = { startEt: Math.max(sb.window.startEt, w.startEt), endEt: Math.min(sb.window.endEt, w.endEt) };
    const cands: NeoCandidate[] = sb.candidates.map((c) => ({ row: c.row, state: c.state, ng: c.ng, H: c.H }));
    const earthR = this.inp.radii.get(399)?.[0] ?? null;
    return neoApproaches(
      { prop, eph: this.inp.eph, epochEt: sb.epochEt, H: sb.forceModel.grid.baseStepS, window, maxKm: sb.maxKm, earthRadiusKm: earthR },
      cands,
      (done, total) => onProgress?.(done / total),
    );
  }
}
