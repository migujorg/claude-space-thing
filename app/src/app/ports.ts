// Ports: the exact shapes the app shell needs from modules built elsewhere (core/, render/).
// The real classes satisfy these structurally; main.ts passes them to startApp() at integration.
//
// Function-valued members are declared with METHOD syntax on purpose: TypeScript compares method
// parameters bivariantly, so e.g. the real `apparentPosition(eph: EphemerisSet, ...)` is accepted
// where this port says `eph: EphemerisSetPort`, even if the concrete class has extra/private members.

import type {
  EphemHeader, IauRotation, Label, OrientationHeader, SmallBodyCoreHeader, SmallBodyPhysicalHeader, SmallBodyTableHeader, Sourced, TimeData,
} from '../data/schema';
import type { Mat3, RendererStats, SceneSnapshot, StarCatalog, Vec3 } from '../render/scene';

export type { Mat3, Vec3 };

// ---- core/time.ts --------------------------------------------------------------------------------

/** `class TimeScale { constructor(data: TimeData); utcMsToEt(unixMs); etToUtcMs(et) }` */
export interface TimeScalePort {
  utcMsToEt(unixMs: number): number;
  etToUtcMs(et: number): number;
}
export interface TimeScaleCtor {
  new (data: TimeData): TimeScalePort;
}

// ---- core/ephemeris.ts ---------------------------------------------------------------------------

/** `class Ephemeris { constructor(header, data); readonly ids; covers(id, et) }` */
export interface EphemerisPort {
  readonly ids: number[];
  covers(id: number, et: number): boolean;
}
export interface EphemerisCtor {
  new (header: EphemHeader, data: Float64Array): EphemerisPort;
}

export interface StateVector {
  /** km, ICRF, SSB origin */
  pos: Vec3;
  /** km/s */
  vel: Vec3;
}

/** `class EphemerisSet` — km, km/s, ICRF, SSB origin. */
export interface EphemerisSetPort {
  add(e: EphemerisPort): void;
  positionSSB(id: number, et: number): Vec3 | null;
  stateSSB(id: number, et: number): StateVector | null;
  covers(id: number, et: number): boolean;
  readonly window: { startEt: number; endEt: number };
  /** Optional (M2): where a chained position comes from (worst segment label, sources). */
  provenance?(id: number, et: number): { label: Label; sources: string[] } | null;
}
export interface EphemerisSetCtor {
  new (): EphemerisSetPort;
}

// ---- core/lighttime.ts, core/rotation.ts, core/time.ts (free functions) --------------------------

export interface ApparentResult {
  /** Apparent position of the body relative to the observer, km, ICRF. */
  rel: Vec3;
  /** One-way light time, s. */
  lightTime: number;
  /** Emission epoch = et − lightTime (TDB s past J2000). */
  emitEt: number;
}

export interface CoreFunctions {
  /** core/rotation.ts: row-major body-fixed → ICRF. */
  bodyToIcrf(rot: IauRotation, et: number): Mat3;
  /** core/lighttime.ts */
  apparentPosition(eph: EphemerisSetPort, id: number, observerSSB: Vec3, et: number): ApparentResult | null;
  /** core/time.ts */
  formatUtc(unixMs: number): string;
}

// ---- core/rotation.ts: precise orientation (M2) --------------------------------------------------

/** `class PreciseOrientation { constructor(header: OrientationHeader, data: Float64Array); readonly bodies; covers(body, et) }` */
export interface PreciseOrientationPort {
  readonly bodies: number[];
  covers(body: number, et: number): boolean;
}
export interface PreciseOrientationCtor {
  new (header: OrientationHeader, data: Float64Array): PreciseOrientationPort;
}

/** Where an orientation came from (core/rotation.ts OrientationSource). */
export interface OrientationSourcePort {
  kind: 'precise' | 'iau';
  label: Label;
  sources: string[];
  frame: string;
  method?: string;
  uncertainty?: string;
}

/** `class OrientationSet { constructor(bodies); add(p); orientation(id, et); provenance(id, et) }` */
export interface OrientationSetPort {
  add(p: PreciseOrientationPort): void;
  /** Body-fixed → ICRF (row-major): precise product where it covers, else the IAU model, else null. */
  orientation(bodyId: number, et: number): Mat3 | null;
  provenance(bodyId: number, et: number): OrientationSourcePort | null;
}
export interface OrientationSetCtor {
  new (bodies: Iterable<{ id: number; rotation?: Sourced<IauRotation> | null }>): OrientationSetPort;
}

/** Everything the app model needs from core/ (constructors + functions). */
export interface CoreDeps extends CoreFunctions {
  TimeScale: TimeScaleCtor;
  Ephemeris: EphemerisCtor;
  EphemerisSet: EphemerisSetCtor;
  /** Optional (M2): without them orientation comes from bodyToIcrf + the IAU model only. */
  OrientationSet?: OrientationSetCtor;
  PreciseOrientation?: PreciseOrientationCtor;
}

// ---- gpu/smallbodies (M3): GPU propagation + photometry of the small-body catalogue ------------------

/** The raw small-body tables handed to the GPU field (schema.ts SmallBody*Header + .bin). */
export interface SmallBodyTablesInput {
  core: ArrayBuffer;
  coreHeader: SmallBodyCoreHeader;
  physical?: ArrayBuffer;
  physicalHeader?: SmallBodyPhysicalHeader;
  comets?: ArrayBuffer;
  cometsHeader?: SmallBodyTableHeader;
  nongrav?: ArrayBuffer;
  nongravHeader?: SmallBodyTableHeader;
}

/** GPU buffer of point sources the renderer draws with the stars (layout owned by the field and renderer). */
export interface PointSourceBuffer {
  buffer: GPUBuffer;
  count: number;
  strideFloats: number;
}

/**
 * `class SmallBodyField` (app/src/gpu/smallbodies): propagates every small body and computes its brightness on
 * the GPU. `allowed.brightness` is the reality level; the field decides which objects it may draw at it.
 */
export interface SmallBodyFieldPort {
  update(encoder: GPUCommandEncoder, et: number, cameraSSB: Vec3, allowed: { brightness: 'strict' | 'best' | 'complete' }): void;
  readonly pointSources: PointSourceBuffer;
  /** Index (core row) of the small body nearest the ray within the tolerance, or null. */
  pick(dirICRF: Vec3, toleranceRad: number): Promise<number | null>;
  /** Heliocentric f64 state at et (CPU reference propagator), or null (position unknown / not covered). */
  stateOf(index: number, et: number): { pos: Vec3; vel: Vec3 } | null;
  /** Optional: counts at the last update, for the HUD ("N drawn / M withheld at this level"). */
  readonly stats?: { drawn: number; withheld: number };
  /** Optional: objects the shell draws itself (a resolved close-up) — the field must not also draw them as points. */
  exclude?(indices: number[]): void;
}

export interface SmallBodyFieldFactory {
  create(device: GPUDevice, tables: SmallBodyTablesInput, planets: { positionSSB(id: number, et: number): Vec3 | null }): Promise<SmallBodyFieldPort>;
}

// ---- render/renderer.ts --------------------------------------------------------------------------

/** `class Renderer { static create(canvas); setStars; resize; render; readonly stats; settled() }` */
export interface RendererPort {
  setStars(c: StarCatalog): void;
  /** w, h in CSS pixels; dpr = window.devicePixelRatio. */
  resize(w: number, h: number, dpr: number): void;
  render(s: SceneSnapshot): void;
  readonly stats: RendererStats;
  /** Resolves when the GPU has finished the work submitted so far (used for __frameReady). */
  settled(): Promise<void>;
  /** Optional (M3): the renderer's GPUDevice, so the small-body field can share buffers with it. */
  readonly gpuDevice?: GPUDevice;
  /** Optional (M3): extra point sources (small bodies) drawn with the stars; null removes them. */
  setExtraPointSources?(src: PointSourceBuffer | null): void;
}
export interface RendererFactory {
  create(canvas: HTMLCanvasElement): Promise<RendererPort>;
}

// ---- startApp() -----------------------------------------------------------------------------------

export type FetchFn = (url: string) => Promise<Response>;

/**
 * Dependencies injected into startApp(). At integration, main.ts is:
 *
 *   import { startApp } from './app/bootstrap';
 *   import { Renderer } from './render/renderer';
 *   import { TimeScale, formatUtc } from './core/time';
 *   import { Ephemeris, EphemerisSet } from './core/ephemeris';
 *   import { bodyToIcrf } from './core/rotation';
 *   import { apparentPosition } from './core/lighttime';
 *   startApp(canvas, uiRoot, { Renderer, TimeScale, formatUtc, Ephemeris, EphemerisSet, bodyToIcrf, apparentPosition,
 *                              OrientationSet, PreciseOrientation });
 */
export interface AppDeps extends CoreDeps {
  Renderer: RendererFactory;
  /** Optional (M3): GPU small-body field. Without it small bodies are searchable/inspectable but not drawn. */
  SmallBodyField?: SmallBodyFieldFactory;
  /** Optional (M3): Web Worker factory for the small-body name index (default: a module worker; tests: none). */
  nameWorker?: () => Worker;
  /** Defaults to window.fetch. */
  fetch?: FetchFn;
  /** Base URL of the data products. Defaults to `${import.meta.env.BASE_URL}data/`. */
  dataBaseUrl?: string;
  /** URL query string for view parameters. Defaults to location.search. */
  search?: string;
  /** Wall clock, Unix ms. Defaults to Date.now. */
  now?(): number;
  /** Verify sha256 of fetched products against the manifest. Default true. */
  verifyHashes?: boolean;
  /** Banner text shown permanently (used by the UI dev page to mark fixture data). */
  banner?: string;
}
