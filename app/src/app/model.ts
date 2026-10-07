// The app model: everything the shell knows (data, time, camera, selection, reality settings) and the
// per-frame pipeline world → snapshot. No DOM, no GPU: the UI and bootstrap drive it, tests use it
// with fake core implementations.

import { SECONDS_PER_DAY } from '../core/constants';

import type { Body, Label, LightData } from '../data/schema';
import type { DataLoader, DeferredEphemeris, LoadedData, LoadedEphemeris } from '../data/load';
import { loadSmallBodyNamesHeader, loadSmallBodyTables, type SmallBodyLoader, type SmallBodyTables } from '../data/smallbodies';
import { normalizeName } from '../data/nameIndex';
import { buildStarCatalog, starDirection, type StarFilterResult } from '../data/stars';
import type { SceneCamera, SceneSnapshot } from '../render/scene';
import {
  azElFromDir, CAMERA_TUNING, clampDist, defaultUp, dirFromAzEl, flySpeed, forwardOf, freeLook, freeMove, freePose,
  freeRoll, lookRotation, nearestAltitude, orbitPose, orbitRoll, orbitRotate, orbitZoom, pushOutside, startTravel,
  sunFrame, sunlitDirection, toFree, toOrbit, travelDone, travelEndCam, travelPose, upOf, viewDistance,
  type CamState, type Pose, type Sphere, type Travel,
} from './camera';
import { Clock, intersectWindows, type TimeWindow } from './clock';
import { SystemScheduler, systemBarycenter, type SystemInfo, type SystemState } from './lazy';
import { surfaceRefs, type SceneExtras } from './extras';
import { ShapeLibrary, type ShapeStatus } from './shapes';
import { buildOrientation } from './orientation';
import { OrbitManager } from './orbits';
import { NameService } from './nameService';
import { angularRadius, pick, pixelRay, pixelsPerRadian, project, type PickTarget, type Viewport } from './picking';
import type { CoreDeps, EphemerisSetPort, OrientationSetPort, OrientationSourcePort, SmallBodyFieldPort, TimeScalePort, Vec3 } from './ports';
import { badgeParts, defaultReality, labelAllowed, type RealityState } from './reality';
import { buildSnapshot, buildSun, filtered, sceneBodyOf, type OverlayOnlyBody } from './snapshot';
import { SmallBodies, sbId, sbRow, type ShapeSize, type SmallBodyCounts } from './smallbodies';
import { GridWorkerClient, type GridWorkerPort } from './sbgrid';
import { parseIsoUtc, type UrlView } from './url';
import { NightglowSource, type NightglowInfo } from './nightglow';
import { DEG, IDENTITY, len, matFromQuat, norm, perpComponent, quatFromMat, slerpQuat, sub } from './vec';
import { computeWorld, copy, findSunId, isPhysical, navRadius, type World } from './world';
import { EventService, EventWorkerClient, FINDER_VERSION, hashKey, InProcessEvents, type EventCache, type EventComputePort, type Readiness } from './events/service';
import { EventEngine, type Category, type EngineInit } from './events/engine';
import type { EventView, FinderInput, SkyEvent } from './events/finder';
import { eventBookmarks, staticBookmarks, type Bookmark } from './events/curated';

export interface ViewportSize {
  /** CSS pixels */
  width: number;
  height: number;
  dpr: number;
}

export interface FlyInput {
  /** (right, up, back) in −1..1 */
  move: Vec3;
  /** radians per second */
  roll: number;
  mod: 'normal' | 'fast' | 'slow';
}

/**
 * 'loading': background loading of moon systems or the small-body catalogue progressed (UI indicator, search list).
 * 'smallbodies': the small-body catalogue, its name index or its GPU field changed state.
 */
export type AppEvent = 'data' | 'selection' | 'reality' | 'time' | 'camera' | 'message' | 'loading' | 'smallbodies' | 'events';

/** Where the small-body catalogue stands. */
export interface SmallBodyLoad {
  /** absent: no products; off: disabled (?smallbodies=0); waiting: loads after the moon systems. */
  status: 'absent' | 'off' | 'waiting' | 'loading' | 'ready' | 'error';
  got: number;
  total: number;
  message: string | null;
  /** Wall-clock ms from the start of the download to usable tables. */
  ms: number | null;
}

/** Click tolerance for points, CSS px (as picking.pick). */
const PICK_TOL_PX = 6;
/** A small body with an admitted shape is drawn resolved (a close-up) from this apparent diameter, device px. */
const CLOSEUP_MIN_PX = 1;
/** SBDB SPK-IDs of small bodies are >= 1,000,000 (comets 1000001..., asteroids 2000001... / 20000001...). */
const SPKID_MIN = 1_000_000;

/** Loads deferred ephemeris binaries (DataLoader in the app; a fake in tests). */
export type DeferredLoader = Pick<DataLoader, 'loadDeferred'>;

/** Wall-clock cost of the last frame's stages, ms. */
export interface FrameTimings {
  world: number;
  snapshot: number;
  orbits: number;
  total: number;
  bodies: number;
}

const SYSTEM_TITLES: Record<string, string> = { 4: 'Mars system', 5: 'Jupiter system', 6: 'Saturn system', 7: 'Uranus system', 8: 'Neptune system', 9: 'Pluto system' };

export interface AppMessage {
  text: string;
  level: 'info' | 'warn' | 'error';
}

const perfNow = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const DEFAULT_FOV_DEG = 50;
/** Preferred initial target (NAIF id of Earth, a naming convention — not a physical value). */
const DEFAULT_TARGET = 399;
/** NAIF id of the Moon (the first-run view frames it beside the Earth). */
const FIRST_RUN_COMPANION = 301;
/** First run: the Moon this far from the centre of view (a framing choice), degrees. */
const FIRST_RUN_MOON_OFFSET_DEG = 14;

interface Turn {
  from: Mat3Q;
  to: Mat3Q;
  elapsed: number;
  duration: number;
}
type Mat3Q = ReturnType<typeof quatFromMat>;

export class AppModel {
  readonly core: CoreDeps;
  data: LoadedData | null = null;
  timeScale: TimeScalePort | null = null;
  eph: EphemerisSetPort | null = null;
  bodies: Body[] = [];
  byId = new Map<number, Body>();
  sunId: number | null = null;
  light: LightData | null = null;
  /** Surface maps and rings the snapshot may attach (filtered per frame by the reality level). */
  extras: SceneExtras | undefined;
  clock = new Clock(0, null);
  /** Defaults of the reality settings (NORTH_STAR 3.7): Complete once the build has a synthetic layer. */
  realityDefaults: RealityState;
  /** The data lists a synthetic layer (synthetic/objects.json): Complete is the default level. */
  syntheticLayerAvailable = false;
  /** The existence level was set by the user or the URL (a new default level does not override it). */
  private levelChosen = false;
  reality: RealityState;
  fovY = DEFAULT_FOV_DEG * DEG;
  cam: CamState = { mode: 'free', anchor: null, rel: [0, 0, 0], orient: IDENTITY };
  travel: Travel | null = null;
  private travelResolve: (() => void) | null = null;
  private turn: Turn | null = null;
  selectedId: number | null = null;
  /** M4 sky (app/sky.ts): one-line state for the Data panel; set by bootstrap when the sky is running. */
  skyInfo: (() => string) | null = null;
  pose: Pose = { pos: [0, 0, 0], orient: IDENTITY };
  world: World | null = null;
  snapshot: SceneSnapshot | null = null;
  /** Bodies with a position but nothing drawable (shown only as overlay markers), this frame. */
  overlayOnly: OverlayOnlyBody[] = [];
  /** Top of each body's UI hierarchy (planet/dwarf planet/Sun for moons; itself otherwise). */
  private roots = new Map<number, number>();
  viewport: ViewportSize = { width: 1, height: 1, dpr: 1 };
  uiHidden = false;
  /** Problems constructing core objects from loaded data (shown in the Data panel). */
  coreErrors: string[] = [];
  messages: AppMessage[] = [];
  /** Body orientation: precise products where they cover, else the IAU model. */
  orientations: OrientationSetPort;
  /** Background loading of deferred ephemerides (moon systems); null when nothing is deferred. */
  systems: SystemScheduler | null = null;
  timings: FrameTimings = { world: 0, snapshot: 0, orbits: 0, total: 0, bodies: 0 };
  orbits: OrbitManager | null = null;
  /** Small-body catalogue (null until its tables have loaded) and its name index (null without names). */
  smallBodies: SmallBodies | null = null;
  names: NameService | null = null;
  sb: SmallBodyLoad = { status: 'absent', got: 0, total: 0, message: null, ms: null };
  private sbGo: (() => void) | null = null;
  private propagationWorker: (() => Worker) | null = null;
  private gridWorker: GridWorkerClient | null = null;
  private sbExcluded = '';
  private pendingSpkid: { spkid: number; dist?: number; az?: number; el?: number } | null = null;
  private spkidWaiters: (() => void)[] = [];
  private spkidResolving = false;
  private deferred = new Map<string, DeferredEphemeris>();
  private loader: DeferredLoader | null = null;
  private idleWaiters: (() => void)[] = [];
  private pendingGoTo: { id: number; dist?: number; opts: { azDeg?: number; elDeg?: number; dir?: Vec3; up?: Vec3; instant?: boolean }; resolve: () => void; reject: (e: Error) => void } | null = null;
  private chainCache = new Map<number, { et: number; label: Label }>();
  private lastPriorityUpdate = -Infinity;
  private starCache = new Map<string, StarFilterResult>();
  private listeners = new Map<AppEvent, Set<() => void>>();
  private readonly now: () => number;
  /** Every ephemeris file in the set, in load order (the event finder gets the same chain). */
  private loadedEphem: LoadedEphemeris[] = [];
  /** Opened without URL parameters (first-run view and hint). */
  firstRun = false;
  /** Event finder ("Moments"); computes on demand (the Moments panel, scripts). */
  events: EventService | null = null;
  private readonly eventWorker: (() => Worker) | null;
  private staticViews: { key: string; list: Bookmark[] } | null = null;
  private readonly eventCache: EventCache | null;

  constructor(core: CoreDeps, opts: { now?: () => number; syntheticLayerAvailable?: boolean; eventWorker?: () => Worker; eventCache?: EventCache | null } = {}) {
    this.core = core;
    this.now = opts.now ?? Date.now;
    this.syntheticLayerAvailable = !!opts.syntheticLayerAvailable;
    this.realityDefaults = defaultReality({ syntheticLayerAvailable: opts.syntheticLayerAvailable });
    this.reality = structuredClone(this.realityDefaults);
    this.orientations = buildOrientation(core, [], []).set;
    this.eventWorker = opts.eventWorker ?? null;
    this.eventCache = opts.eventCache ?? null;
    // A category of events may be waiting for a moon system or the small-body catalogue.
    this.on('loading', () => this.events?.inputsChanged());
    this.on('smallbodies', () => this.events?.inputsChanged());
  }

  // ---- events -----------------------------------------------------------------------------------

  on(ev: AppEvent, fn: () => void): () => void {
    let s = this.listeners.get(ev);
    if (!s) this.listeners.set(ev, (s = new Set()));
    s.add(fn);
    return () => s!.delete(fn);
  }

  emit(ev: AppEvent): void {
    this.listeners.get(ev)?.forEach((f) => f());
  }

  message(text: string, level: AppMessage['level'] = 'info'): void {
    this.messages.push({ text, level });
    if (this.messages.length > 20) this.messages.shift();
    this.emit('message');
  }

  // ---- data -------------------------------------------------------------------------------------

  setData(d: LoadedData, dataBaseUrl = 'data/'): void {
    this.data = d;
    // atmospheres.json (render/scene.ts SceneBody.atmosphere) once the loader provides it as `atmospheres`.
    const atmospheres = d.atmospheres ?? null;
    // Shape models (app/shapes.ts): headers, meshes and the DAMIT table are fetched when a body first needs them.
    const shapes = d.shapes
      ? new ShapeLibrary(d.shapes, {
          dataRoot: dataBaseUrl,
          utcToEt: (ms) => this.timeScale?.utcMsToEt(ms) ?? NaN,
          spkidOf: (id) => this.spkidForShapes(id),
        })
      : null;
    // Earth's airglow and aurora (app/nightglow.ts), evaluated per frame at the frame's UTC.
    const ng = d.nightglow && (d.nightglow.airglow || d.nightglow.aurora)
      ? { source: new NightglowSource(d.nightglow.airglow, d.nightglow.aurora, d.nightglow.bins), etToUtcMs: (et: number) => this.timeScale?.etToUtcMs(et) ?? NaN }
      : null;
    this.extras = { surfaces: surfaceRefs(d.surfaces ?? [], dataBaseUrl), rings: d.rings ?? null, atmospheres, shapes, nightglow: ng };
    this.bodies = d.bodies;
    this.byId = new Map(d.bodies.map((b) => [b.id, b]));
    this.roots.clear();
    this.sunId = findSunId(d.bodies);
    this.light = d.light;
    this.coreErrors = [];
    if (d.time) {
      try {
        this.timeScale = new this.core.TimeScale(d.time);
      } catch (e) {
        this.coreErrors.push(`time.json could not be used: ${(e as Error).message ?? e}`);
      }
    }
    let ephWindow: TimeWindow | null = null;
    this.loadedEphem = [];
    if (d.ephemerides.length || d.deferred?.length) {
      const set = new this.core.EphemerisSet();
      let added = 0;
      for (const e of d.ephemerides) {
        try {
          set.add(new this.core.Ephemeris(e.header, e.data));
          this.loadedEphem.push(e);
          added++;
        } catch (err) {
          this.coreErrors.push(`${e.path} could not be used: ${(err as Error).message ?? err}`);
        }
      }
      this.eph = set;
      // The time window comes from what is loaded up front. Files loaded later (moon systems) are not allowed
      // to shrink it: a body whose file does not cover an epoch is simply not drawn then.
      if (added) {
        try {
          ephWindow = set.window;
        } catch {
          ephWindow = null;
        }
      }
    }
    const o = buildOrientation(this.core, this.bodies, d.orientations ?? []);
    this.orientations = o.set;
    this.coreErrors.push(...o.errors);
    this.chainCache.clear();
    this.deferred = new Map((d.deferred ?? []).map((x) => [x.path, x]));
    this.loader = d.loader ?? null;
    this.systems = this.deferred.size
      ? new SystemScheduler(
          [...this.deferred.values()].map((x): SystemInfo => {
            const bary = systemBarycenter(x.header.segments);
            return { path: x.path, name: x.name, title: (bary !== null && SYSTEM_TITLES[bary]) || x.name, bytes: x.bytes, bodies: x.bodies, barycenter: bary };
          }),
        )
      : null;
    const window = intersectWindows(d.manifest?.window, ephWindow);
    this.clock = new Clock(window ? (window.startEt + window.endEt) / 2 : 0, window);
    this.orbits = this.eph && window ? new OrbitManager(this.eph, this.bodies, this.sunId, window) : null;
    this.starCache.clear();
    this.names?.dispose();
    this.names = null;
    this.gridWorker?.dispose();
    this.gridWorker = null;
    this.smallBodies = null;
    this.sbExcluded = '';
    this.sb = { status: d.smallBodies ? 'waiting' : 'absent', got: 0, total: d.smallBodies?.tableBytes ?? 0, message: null, ms: null };
    this.events?.dispose();
    this.events = new EventService(this.eventHost(), (init) => this.eventPort(init), this.eventCache);
    this.events.onChange(() => this.emit('events'));
    this.setSyntheticLayerAvailable(!!d.smallBodies?.synthetic);
    this.emit('data');
    this.emit('time');
  }

  /**
   * Architecture §5.2 / NORTH_STAR 3.7: once a synthetic layer exists, Complete is the default level. A level the user
   * or the URL chose is kept. The layer exists when the data list it and small bodies are not disabled.
   */
  private setSyntheticLayerAvailable(syn: boolean): void {
    if (syn === this.syntheticLayerAvailable) return;
    const nd = defaultReality({ syntheticLayerAvailable: syn });
    if (!this.levelChosen) this.reality = { ...this.reality, exists: nd.exists };
    this.realityDefaults = { ...this.realityDefaults, exists: nd.exists };
    this.syntheticLayerAvailable = syn;
    this.emit('reality');
  }

  // ---- small bodies ---------------------------------------------------------------------------------

  /**
   * Background loading of the small-body catalogue: the names header at once (search can start indexing), the
   * tables once the moon systems are in (or at once when something asks for a small body). Resolves when the
   * tables are usable or have failed. `enabled: false` (?smallbodies=0) skips it.
   */
  async initSmallBodies(opts: {
    loader: SmallBodyLoader;
    namesUrl(file: string): string;
    /** Name index worker (nameService.ts). */
    worker?: () => Worker;
    /** Background propagation worker (sbprop.worker.ts). */
    propagationWorker?: () => Worker;
    enabled?: boolean;
  }): Promise<void> {
    const p = this.data?.smallBodies;
    if (!p) return;
    this.propagationWorker = opts.propagationWorker ?? null;
    if (opts.enabled === false) {
      this.setSyntheticLayerAvailable(false);
      this.sb = { ...this.sb, status: 'off', message: 'Disabled by the URL (smallbodies=0).' };
      this.failPendingSpkid('small bodies are disabled by the URL (smallbodies=0)');
      this.emit('smallbodies');
      return;
    }
    const L = opts.loader;
    void loadSmallBodyNamesHeader(L, p).then((h) => {
      if (!h) return;
      const entry = L.manifest?.products[h.file];
      const svc = new NameService({ url: opts.namesUrl(h.file), header: h, bytes: entry?.bytes, sha256: entry?.sha256, worker: opts.worker });
      const report = () => {
        const st = svc.state;
        if (st === 'loading' || st === 'indexing') L.setReport(h.file, { status: 'loading', bytes: entry?.bytes, message: st === 'indexing' ? 'Indexing names (in a worker).' : 'Loading for search.' });
        else if (st === 'ready') L.setReport(h.file, { status: 'ok', bytes: entry?.bytes, hash: svc.verified ? 'verified' : 'unchecked' });
        else if (st === 'error') L.setReport(h.file, { status: 'error', bytes: entry?.bytes, message: svc.error ?? 'failed', consequence: 'Small bodies cannot be searched by name.' });
        this.emit('smallbodies');
        this.emit('loading');
      };
      svc.onChange(report);
      this.names = svc;
      if (this.selectedId !== null && this.selectedId < 0) this.fetchName(sbRow(this.selectedId));
      this.emit('smallbodies');
      void this.resolvePendingSpkid();
    });
    if (this.sb.status === 'waiting') await Promise.race([this.systemsIdle(), new Promise<void>((r) => (this.sbGo = r))]);
    this.sbGo = null;
    if (this.sb.status !== 'waiting') return;
    this.sb = { ...this.sb, status: 'loading' };
    this.emit('smallbodies');
    const t0 = perfNow();
    let lastEmit = 0;
    const tables = await loadSmallBodyTables(L, p, (got, total) => {
      this.sb.got = got;
      if (total) this.sb.total = total;
      const t = Date.now();
      if (t - lastEmit > 100) { lastEmit = t; this.emit('loading'); }
    }).catch((e) => {
      this.sb.message = String((e as Error)?.message ?? e);
      return null;
    });
    if (!tables) {
      this.sb = { ...this.sb, status: 'error', message: this.sb.message ?? 'The core table could not be loaded (see Data).' };
      this.message('The small-body catalogue could not be loaded: asteroids and comets are missing (see Data).', 'error');
    } else {
      this.setSmallBodyTables(tables, perfNow() - t0);
    }
    this.emit('smallbodies');
    this.emit('loading');
    this.resumePendingGoTo();
    if (!tables) this.failPendingSpkid('the small-body catalogue could not be loaded');
  }

  /** Use loaded small-body tables (initSmallBodies does this; tests call it directly). */
  setSmallBodyTables(t: SmallBodyTables, ms: number | null = null): void {
    try {
      this.smallBodies = new SmallBodies(t, { positionSSB: (id, et) => (this.eph ? copy(this.eph.positionSSB(id, et)) : null) });
    } catch (e) {
      this.coreErrors.push(`smallbodies: ${(e as Error).message ?? e}`);
      this.sb = { ...this.sb, status: 'error', message: String((e as Error).message ?? e) };
      return;
    }
    this.sb = { ...this.sb, status: 'ready', got: this.sb.total, ms, message: null };
    this.sbExcluded = '';
    this.attachGridWorker(t);
    if (this.selectedId !== null && this.selectedId < 0) this.fetchName(sbRow(this.selectedId));
    this.emit('smallbodies');
    this.resumePendingGoTo();
    void this.resolvePendingSpkid();
  }

  /** Propagate selected small bodies off the main thread (when a worker factory was given). */
  private attachGridWorker(t: SmallBodyTables): void {
    const sb = this.smallBodies;
    this.gridWorker?.dispose();
    this.gridWorker = null;
    if (!sb || !this.propagationWorker) return;
    try {
      const h = t.core.header;
      this.gridWorker = new GridWorkerClient(this.propagationWorker(), {
        type: 'init',
        forceModel: h.forceModel,
        epochEt: h.epochEt,
        window: h.window,
        // The files every body needs, in load order: the perturbers resolve exactly as on this thread.
        ephem: (this.data?.ephemerides ?? []).map((e) => ({ header: e.header, data: e.data })),
      });
    } catch (e) {
      this.coreErrors.push(`small-body propagation worker: ${(e as Error).message ?? e}`);
      return;
    }
    this.useGridWorker(this.gridWorker);
  }

  /** Propagate through this background port (the worker client; tests pass a fake). */
  useGridWorker(port: GridWorkerPort): void {
    const sb = this.smallBodies;
    if (!sb) return;
    sb.cpu.attachWorker(port);
    sb.cpu.onSeeded = () => {
      this.emit('loading');
      this.resumePendingGoTo();
    };
    sb.cpu.onWorkerError = (e) => this.message(`Small-body positions are computed on the main thread (worker failed: ${e.message}).`, 'warn');
  }

  /** Attach the GPU field (bootstrap, once the renderer's device is known). */
  setSmallBodyField(f: SmallBodyFieldPort | null): void {
    if (!this.smallBodies) return;
    this.smallBodies.field = f;
    if (f?.syntheticNote) this.message(`Synthetic objects are not drawn: ${f.syntheticNote}.`, 'warn');
    this.sbExcluded = '';
    this.emit('smallbodies');
  }

  /** Start loading the small-body tables now instead of after the moon systems. */
  requestSmallBodies(): void {
    this.sbGo?.();
  }

  /** Resolves once a URL small-body target (SPK-ID) has been resolved or given up. */
  urlTargetSettled(): Promise<void> {
    if (!this.pendingSpkid && !this.spkidResolving) return Promise.resolve();
    return new Promise((res) => this.spkidWaiters.push(res));
  }

  private failPendingSpkid(why: string): void {
    const p = this.pendingSpkid;
    if (!p) return;
    this.pendingSpkid = null;
    this.message(`Target ${p.spkid} not shown: ${why}.`, 'warn');
    this.spkidWaiters.splice(0).forEach((w) => w());
  }

  private async resolvePendingSpkid(): Promise<void> {
    const p = this.pendingSpkid;
    if (!p || !this.names || !this.smallBodies) return;
    this.pendingSpkid = null;
    this.spkidResolving = true;
    try {
      const row = await this.names.rowOfSpkid(p.spkid);
      if (row === null) this.message(`Unknown target ${p.spkid}: no body or small body has this id.`, 'warn');
      else {
        const r = this.goTo(sbId(row), p.dist, { azDeg: p.az, elDeg: p.el, instant: true });
        if (typeof r === 'string') this.message(r, 'warn');
        else await r;
      }
    } catch (e) {
      this.message(`Target ${p.spkid} not shown: ${(e as Error).message ?? e}`, 'warn');
    } finally {
      this.spkidResolving = false;
      this.spkidWaiters.splice(0).forEach((w) => w());
    }
  }

  /** SBDB SPK-ID of a small body for the shape-model lookup (asks the name index when not known yet). */
  private spkidForShapes(id: number): number | null {
    if (id >= 0 || !this.names) return null;
    const row = sbRow(id);
    const s = this.names.spkidOf(row);
    if (s === null) this.fetchName(row);
    return s;
  }

  /** Why a body is or is not drawn from a shape model (inspector), or null when it has none. */
  shapeStatus(id: number): ShapeStatus | null {
    return this.extras?.shapes?.status(id) ?? null;
  }

  /**
   * How a small body's pseudo-body carries a shape model: false (none admitted: a sphere of the measured diameter),
   * true (the measured diameter as the photometric size) or the model's own size (no measured diameter).
   */
  private shapedPseudo(id: number, row: number): boolean | ShapeSize {
    const shapes = this.extras?.shapes;
    if (!shapes || shapes.available(id, this.reality.exists) !== true) return false;
    if (this.smallBodies?.measuredDiameter(row)) return true;
    return shapes.size(id) ?? false;
  }

  shapesIdle(): boolean {
    return this.extras?.shapes?.idle() ?? true;
  }

  /** Resolves when no shape-model header, DAMIT table or SPK-ID lookup for a shape is in flight. */
  shapesSettled(): Promise<void> {
    return this.extras?.shapes?.whenIdle() ?? Promise.resolve();
  }

  /** Ask the name index for a small body's display name (the inspector and labels pick it up). */
  private fetchName(row: number): void {
    const sb = this.smallBodies;
    // Search results bring the name but not the SPK-ID (needed for links): ask until both are known.
    if (!this.names || !sb || sb.isSynthetic(row) || (sb.knownName(row) && this.names.spkidOf(row) !== null)) return;
    this.names.display([row]).then(
      ([n]) => {
        if (!n) return;
        sb.setName(row, n);
        this.emit('selection');
      },
      () => undefined,
    );
  }

  /** Small bodies drawn / withheld at the current level (field counts, or by labels without a field). */
  smallBodyCounts(): SmallBodyCounts | null {
    return this.smallBodies?.countsAt(this.reality.exists) ?? null;
  }

  /** A body by id: major bodies from bodies.json, small bodies (negative ids) as built by SmallBodies. */
  bodyOf(id: number): Body | undefined {
    if (id < 0) {
      const sb = this.smallBodies, row = sbRow(id);
      return sb?.has(row) ? sb.pseudoBody(row, this.shapedPseudo(id, row)) : undefined;
    }
    return this.byId.get(id);
  }

  bodyName(id: number): string {
    return this.bodyOf(id)?.name ?? (id < 0 ? `Small body #${-id}` : String(id));
  }

  /** For a small body that is also a planetary-ephemeris body (Pluto): that body, matched by name. */
  planetaryTwin(id: number): number | null {
    const sb = this.smallBodies;
    if (id >= 0 || !sb || !sb.hasFlag(sbRow(id), 'planetaryEphemeris')) return null;
    const n = sb.knownName(sbRow(id));
    if (!n) return null;
    const words = new Set(n.split(/[\s()/]+/).map(normalizeName).filter(Boolean));
    return this.bodies.find((b) => b.kind !== 'barycenter' && words.has(normalizeName(b.name)))?.id ?? null;
  }

  // ---- background loading of moon systems ----------------------------------------------------------

  /** Add a loaded ephemeris file (e.g. a moon system) to the set. */
  addEphemeris(e: LoadedEphemeris): boolean {
    if (!this.eph) this.eph = new this.core.EphemerisSet();
    try {
      this.eph.add(new this.core.Ephemeris(e.header, e.data));
    } catch (err) {
      this.coreErrors.push(`${e.path} could not be used: ${(err as Error).message ?? err}`);
      return false;
    }
    this.loadedEphem.push(e);
    if (this.eventFiles([...this.loadedEphem]).includes(e)) this.events?.addEphem({ path: e.path, header: e.header, data: e.data });
    this.chainCache.clear();
    const d = this.deferred.get(e.path);
    this.orbits?.invalidate(d?.bodies);
    return true;
  }

  /** Queue every deferred system and start loading (after the first frame). */
  startBackgroundLoading(): void {
    if (!this.systems) return;
    this.updateSystemPriorities(true);
    this.systems.startAll();
    this.pump();
  }

  /** Resolves when no system is queued or loading. */
  systemsIdle(): Promise<void> {
    if (!this.systems || this.systems.idle) return Promise.resolve();
    return new Promise((res) => this.idleWaiters.push(res));
  }

  /**
   * Where a body's position stands: 'loaded' (or nothing deferred), else the state of its pending system.
   * Small bodies: the state of the small-body catalogue.
   */
  bodyLoadState(id: number): SystemState {
    if (id < 0) {
      const s = this.sb.status;
      if (s === 'ready') return this.smallBodies?.pending(sbRow(id)) ? 'loading' : 'loaded';
      return s === 'loading' ? 'loading' : s === 'waiting' ? 'queued' : 'error';
    }
    return this.systems ? this.systems.bodyState(id) : 'loaded';
  }

  /** Ask for the systems a body needs, ahead of the others. Returns them (empty if nothing pending). */
  requestBody(id: number): SystemInfo[] {
    if (id < 0) {
      this.requestSmallBodies();
      return [];
    }
    if (!this.systems) return [];
    const p = this.systems.requestBody(id);
    if (p.length) this.pump();
    return p;
  }

  requestSystem(path: string): void {
    this.systems?.request(path);
    this.pump();
  }

  private pump(): void {
    const sys = this.systems;
    if (!sys) return;
    for (let s = sys.next(); s; s = sys.next()) {
      const info = s;
      const def = this.deferred.get(info.path);
      if (!def || !this.loader) {
        sys.done(info.path, false, 'no loader');
        continue;
      }
      let lastEmit = 0;
      this.loader
        .loadDeferred(def, (got, total) => {
          if (!total) return;
          sys.setProgress(info.path, got / total);
          const t = Date.now();
          if (t - lastEmit > 100) { lastEmit = t; this.emit('loading'); }
        })
        .then(
          (loaded) => {
            const ok = !!loaded && this.addEphemeris(loaded);
            sys.done(info.path, ok, ok ? undefined : 'could not be loaded — see Data (M)');
            if (!ok) this.message(`${info.title} could not be loaded: its bodies have no positions (see Data).`, 'error');
          },
          (err) => sys.done(info.path, false, String(err)),
        )
        .finally(() => {
          this.emit('loading');
          this.resumePendingGoTo();
          if (sys.idle) this.idleWaiters.splice(0).forEach((w) => w());
          this.pump();
        });
    }
    this.emit('loading');
  }

  /** Closer systems load first (unless something was explicitly requested). */
  private updateSystemPriorities(force = false): void {
    const sys = this.systems;
    if (!sys || !this.eph) return;
    const t = Date.now();
    if (!force && t - this.lastPriorityUpdate < 500) return;
    this.lastPriorityUpdate = t;
    for (const s of sys.systems) {
      const p = s.barycenter !== null ? this.bodyPos(s.barycenter) : null;
      const d = p ? len(sub(p, this.pose.pos)) : Infinity;
      sys.setBasePriority(s.path, Number.isFinite(d) ? -Math.log10(Math.max(d, 1)) : -100);
    }
  }

  private resumePendingGoTo(): void {
    const p = this.pendingGoTo;
    if (!p) return;
    const st = this.bodyLoadState(p.id);
    if (st === 'loaded') {
      this.pendingGoTo = null;
      const r = this.goTo(p.id, p.dist, p.opts);
      if (typeof r === 'string') {
        this.message(r, 'warn');
        p.reject(new Error(r));
      } else r.then(p.resolve, p.reject);
    } else if (st === 'error') {
      this.pendingGoTo = null;
      const msg = p.id < 0 ? `${this.bodyName(p.id)}: the small-body catalogue is not available (see Data).` : `${this.bodyName(p.id)}: its ephemeris could not be loaded.`;
      this.message(msg, 'error');
      p.reject(new Error(msg));
    }
  }

  /** Label of the ephemeris chain serving a body (cached per day; cleared when files are added). */
  chainLabel(id: number, et = this.clock.et): Label {
    // Small bodies: the catalogue's position label (propagation adds no assumption beyond it).
    if (id < 0) return this.smallBodies?.posLabel(sbRow(id)) ?? 'unknown';
    const c = this.chainCache.get(id);
    if (c && Math.abs(c.et - et) < SECONDS_PER_DAY) return c.label;
    const label = this.eph?.provenance?.(id, et)?.label ?? 'measured';
    this.chainCache.set(id, { et, label });
    return label;
  }

  /** Evaluator-selected ephemeris chain at the frame's light-emission epoch (or now before a frame). */
  ephemerisSource(id: number) {
    if (id < 0) return null;
    const g = this.world?.bodies.get(id);
    // A frame without an apparent position has no chain to report, even if reception time is covered.
    if (g && !g.app) return null;
    return this.eph?.provenance?.(id, g?.app?.emitEt ?? this.clock.et) ?? null;
  }

  /** Orientation provenance of a body at the light-emission epoch of the current frame (or now). */
  /** Earth's airglow and aurora at the current time and level (the inspector), or null without the products. */
  nightglowInfo(): NightglowInfo | null {
    const ng = this.extras?.nightglow;
    if (!ng) return null;
    const ms = ng.etToUtcMs(this.clock.et);
    return Number.isFinite(ms) ? ng.source.info(this.reality.exists, ms) : null;
  }

  orientationSource(id: number): OrientationSourcePort | null {
    if (id < 0) return null;
    const et = this.world?.bodies.get(id)?.app?.emitEt ?? this.clock.et;
    return this.orientations.provenance(id, et);
  }

  /** Stars admitted at the current `exists` level (cached per level). */
  starCatalog(): StarFilterResult | null {
    const t = this.data?.stars?.table;
    if (!t) return null;
    const lvl = this.reality.exists;
    let r = this.starCache.get(lvl);
    if (!r) {
      try {
        r = buildStarCatalog(t, (l) => labelAllowed(l, lvl));
      } catch (e) {
        this.coreErrors.push(`stars: ${(e as Error).message}`);
        return null;
      }
      this.starCache.set(lvl, r);
    }
    return r;
  }

  // ---- time -------------------------------------------------------------------------------------

  nowEt(): number | null {
    return this.timeScale ? this.timeScale.utcMsToEt(this.now()) : null;
  }

  utcMs(et = this.clock.et): number | null {
    return this.timeScale ? this.timeScale.etToUtcMs(et) : null;
  }

  formatTime(et = this.clock.et): string {
    const ms = this.utcMs(et);
    return ms === null ? `TDB ${et.toFixed(1)} s past J2000` : this.core.formatUtc(ms);
  }

  setEt(et: number): boolean {
    const ok = this.clock.set(et);
    if (!ok) this.message(`${this.formatTimeOrEt(et)} is outside the data window. Showing the window edge — never extrapolated.`, 'warn');
    this.emit('time');
    return ok;
  }

  private formatTimeOrEt(et: number): string {
    try {
      return this.formatTime(et);
    } catch {
      return `TDB ${et.toFixed(0)} s`;
    }
  }

  /** Parse user text: ISO UTC, "now", or (without time.json) a TDB seconds number. Returns an error or null. */
  setTimeText(text: string): string | null {
    const s = text.trim();
    if (/^now$/i.test(s)) return this.goNow() ? null : 'Current time unavailable (no time.json).';
    if (this.timeScale) {
      const ms = parseIsoUtc(s);
      if (ms === null) return 'Expected ISO-8601 UTC, e.g. 2026-09-30T12:00:00Z';
      this.setEt(this.timeScale.utcMsToEt(ms));
      return null;
    }
    const x = Number(s);
    if (!Number.isFinite(x)) return 'Without time.json, enter TDB seconds past J2000.';
    this.setEt(x);
    return null;
  }

  goNow(): boolean {
    const et = this.nowEt();
    if (et === null) return false;
    this.setEt(et);
    return true;
  }

  // ---- reality ------------------------------------------------------------------------------------

  setReality(patch: Partial<Omit<RealityState, 'overlays'>> & { overlays?: Partial<RealityState['overlays']> }): void {
    if (patch.exists !== undefined) this.levelChosen = true;
    this.reality = { ...this.reality, ...patch, overlays: { ...this.reality.overlays, ...(patch.overlays ?? {}) } };
    this.emit('reality');
  }

  badge(): string[] {
    const parts = badgeParts(this.reality, this.realityDefaults, { syntheticLayerAvailable: this.syntheticLayerAvailable });
    // Away from the default level, say what it does to the asteroids and comets (most brightnesses rest on an
    // assumed phase law, so Strict withholds most of them).
    const c = this.reality.exists !== this.realityDefaults.exists ? this.smallBodyCounts() : null;
    if (c && c.withheld > 0) parts.push(`SMALL BODIES: ${c.withheld.toLocaleString('en-US')} withheld`);
    return parts;
  }

  setFovDeg(deg: number): void {
    this.fovY = Math.min(120, Math.max(1, deg)) * DEG;
    this.emit('camera');
  }

  // ---- selection & navigation ------------------------------------------------------------------------

  select(id: number | null): void {
    if (id !== null && !this.bodyOf(id)) return;
    this.selectedId = id;
    if (id !== null) this.requestBody(id); // a selected moon's system loads next
    if (id !== null && id < 0) this.fetchName(sbRow(id));
    this.emit('selection');
  }

  bodyPos(id: number, et = this.clock.et): Vec3 | null {
    if (id < 0) return this.smallBodies?.ssb(sbRow(id), et) ?? null;
    // positionSSB returns null when the chain does not cover et (no separate covers() walk).
    return this.eph ? copy(this.eph.positionSSB(id, et)) : null;
  }

  radiusOf(id: number): number | null {
    if (id < 0) return this.smallBodies?.navRadius(sbRow(id)) ?? null;
    const r = navRadius(this.byId.get(id));
    if (r !== null) return r;
    if (id === this.sunId) return this.light?.sun.radius?.value ?? null;
    return null;
  }

  toSunAt(id: number, et = this.clock.et): Vec3 | null {
    if (this.sunId === null || id === this.sunId) return null;
    const s = this.bodyPos(this.sunId, et), p = this.bodyPos(id, et);
    return s && p ? sub(s, p) : null;
  }

  /** A sensible viewing distance: frame the body, or (unknown size) a small fraction of its distance to the Sun. */
  defaultDistance(id: number): number {
    const r = this.radiusOf(id);
    if (r) return viewDistance(r, this.fovY);
    const ts = this.toSunAt(id);
    return ts ? len(ts) * 1e-3 : 1e6;
  }

  /**
   * Magic travel to a body; ends in orbit mode on the sunlit side (or at az/el given in `opts`).
   * Resolves when the travel completes (or is superseded). Returns an error string if impossible.
   */
  goTo(id: number, dist?: number, opts: { azDeg?: number; elDeg?: number; dir?: Vec3; up?: Vec3; instant?: boolean } = {}): Promise<void> | string {
    const twin = this.planetaryTwin(id);
    if (twin !== null) return this.goTo(twin, dist, opts);
    const body = this.bodyOf(id);
    if (id < 0 && !body) {
      // The small-body catalogue is still coming: go there once it has arrived.
      const s = this.sb.status;
      if (s !== 'waiting' && s !== 'loading') return s === 'ready' ? `No small body #${-id}.` : 'Small bodies are not available (see Data).';
      this.requestSmallBodies();
      this.pendingGoTo?.resolve();
      this.message('Loading the small-body catalogue…');
      return new Promise<void>((resolve, reject) => {
        this.pendingGoTo = { id, dist, opts, resolve, reject };
      });
    }
    if (!body || !isPhysical(body)) return `No body with id ${id}.`;
    const tp = this.bodyPos(id);
    // A small body still being propagated in the background takes the pending path below.
    if (!tp && id < 0 && this.bodyLoadState(id) === 'loaded') {
      const sb = this.smallBodies!, row = sbRow(id), w = sb.window;
      if (sb.posLabel(row) === 'unknown') return `No position for ${body.name}: its position is unknown (see its flags).`;
      if (this.clock.et < w.startEt || this.clock.et > w.endEt)
        return `No position for ${body.name} at this time: small bodies are propagated only within ${this.formatTimeOrEt(w.startEt)} – ${this.formatTimeOrEt(w.endEt)}.`;
      return `No position for ${body.name} at this time (propagation stopped, see its flags).`;
    }
    if (!tp) {
      // Its moon system may still be loading: go there once it has arrived (never to a guessed place).
      const state = this.bodyLoadState(id);
      if (state !== 'loaded' && state !== 'error') {
        const pend = this.requestBody(id);
        this.select(id);
        this.pendingGoTo?.resolve();
        this.message(id < 0 ? `Propagating ${body.name}…` : `Loading ${pend.map((s) => s.title).join(', ') || 'ephemeris'} for ${body.name}…`);
        return new Promise<void>((resolve, reject) => {
          this.pendingGoTo = { id, dist, opts, resolve, reject };
        });
      }
      return state === 'error'
        ? `No position for ${body.name}: its ephemeris could not be loaded (see Data).`
        : `No position for ${body.name} at this time (outside its ephemeris coverage).`;
    }
    if (this.pendingGoTo && this.pendingGoTo.id !== id) {
      this.pendingGoTo.resolve();
      this.pendingGoTo = null;
    }
    const radius = this.radiusOf(id);
    const endDist = clampDist(dist ?? this.defaultDistance(id), radius);
    let dir: Vec3;
    const toSun = this.toSunAt(id);
    if (opts.dir) dir = norm(opts.dir);
    else if (opts.azDeg !== undefined || opts.elDeg !== undefined)
      dir = dirFromAzEl(sunFrame(toSun), (opts.azDeg ?? CAMERA_TUNING.viewAzDeg) * DEG, (opts.elDeg ?? CAMERA_TUNING.viewElDeg) * DEG);
    else if (this.cam.mode === 'orbit' && this.cam.target === id && !this.travel) dir = this.cam.dir;
    else dir = sunlitDirection(toSun);
    const up = opts.up ? perpComponent(opts.up, dir) : defaultUp(dir);
    this.finishTravel();
    this.turn = null;
    this.select(id);
    const tr = startTravel(this.pose, tp, id, dir, endDist, up);
    if (opts.instant) {
      this.cam = travelEndCam(tr);
      this.pose = orbitPose(this.cam, tp);
      this.emit('camera');
      return Promise.resolve();
    }
    this.travel = tr;
    this.emit('camera');
    return new Promise<void>((res) => (this.travelResolve = res));
  }

  private finishTravel(): void {
    this.travel = null;
    const r = this.travelResolve;
    this.travelResolve = null;
    r?.();
  }

  /** Stop a travel in place (user took control). */
  cancelTravel(): void {
    const tr = this.travel;
    if (!tr) return;
    const tp = this.bodyPos(tr.target);
    if (tp) this.cam = toOrbit(this.pose, tr.target, tp, this.radiusOf(tr.target));
    this.finishTravel();
  }

  /** Turn to look along an ICRF direction (e.g. a star). Switches to free mode, anchored where you are. */
  lookAlong(dir: Vec3): void {
    this.cancelTravel();
    if (this.cam.mode === 'orbit') {
      const tp = this.bodyPos(this.cam.target);
      this.cam = toFree(this.pose, this.cam.target, tp);
    }
    this.turn = { from: quatFromMat(this.pose.orient), to: quatFromMat(lookRotation(norm(dir), upOf(this.pose.orient))), elapsed: 0, duration: 1.2 };
    this.emit('camera');
  }

  lookAtStar(index: number): void {
    const t = this.data?.stars?.table;
    if (!t) return;
    this.lookAlong(starDirection(t, index));
  }

  toggleMode(): void {
    this.cancelTravel();
    this.turn = null;
    if (this.cam.mode === 'orbit') {
      this.cam = toFree(this.pose, this.cam.target, this.bodyPos(this.cam.target));
    } else {
      const target = this.selectedId ?? this.cam.anchor ?? this.nearestBody();
      if (target === null) return;
      const tp = this.bodyPos(target);
      if (!tp) return;
      const o = toOrbit(this.pose, target, tp, this.radiusOf(target));
      // Smoothly turn to face the target without changing distance.
      this.travel = startTravel(this.pose, tp, target, o.dir, o.dist, o.up);
      this.select(target);
    }
    this.emit('camera');
  }

  nearestBody(): number | null {
    let best: number | null = null, bd = Infinity;
    for (const b of this.bodies) {
      if (!isPhysical(b)) continue;
      const p = this.bodyPos(b.id);
      if (!p) continue;
      const d = len(sub(p, this.pose.pos)) - (this.radiusOf(b.id) ?? 0);
      if (d < bd) { bd = d; best = b.id; }
    }
    return best;
  }

  /** Pointer drag in CSS pixels. */
  drag(dxPx: number, dyPx: number): void {
    if (this.travel) this.cancelTravel();
    this.turn = null;
    const radPerPx = this.fovY / Math.max(1, this.viewport.height);
    if (this.cam.mode === 'orbit') this.cam = orbitRotate(this.cam, dxPx * radPerPx * 1.5, dyPx * radPerPx * 1.5);
    else this.cam = freeLook(this.cam, dxPx * radPerPx, dyPx * radPerPx);
    this.emit('camera');
  }

  /** Wheel: orbit zoom (log in altitude); in free mode nudges forward/back. */
  wheel(notches: number): void {
    if (this.travel) this.cancelTravel();
    if (this.cam.mode === 'orbit') this.cam = orbitZoom(this.cam, notches, this.radiusOf(this.cam.target));
    else {
      const spheres = this.spheres();
      const alt = nearestAltitude(this.pose.pos, spheres).alt;
      const anchorPos = this.cam.anchor !== null ? this.bodyPos(this.cam.anchor) : null;
      const moved = freeMove(this.cam, [0, 0, 1], Math.abs(notches) * 0.15, Math.sign(notches) * flySpeed(alt));
      const safe = pushOutside(freePose(moved, anchorPos).pos, spheres);
      this.cam = { ...moved, rel: anchorPos ? sub(safe, anchorPos) : safe };
    }
    this.emit('camera');
  }

  roll(a: number): void {
    if (this.cam.mode === 'orbit') this.cam = orbitRoll(this.cam, a);
    else this.cam = freeRoll(this.cam, a);
  }

  /** Bodies with a known size, as spheres at `et` (flight speed and collision; bodies of unknown size are ignored). */
  private spheres(et = this.clock.et): Sphere[] {
    const out: Sphere[] = [];
    for (const b of this.bodies) {
      const r = this.radiusOf(b.id);
      if (!isPhysical(b) || r === null) continue;
      const p = this.bodyPos(b.id, et);
      if (p) out.push({ center: p, radius: r });
    }
    // Small bodies the view is about (flight speed near them scales with their size, too).
    for (const id of this.smallBodyIdsInView()) {
      const r = this.radiusOf(id), p = r !== null ? this.bodyPos(id, et) : null;
      if (r !== null && p) out.push({ center: p, radius: r });
    }
    return out;
  }

  // ---- frame ------------------------------------------------------------------------------------

  setViewport(v: ViewportSize): void {
    this.viewport = v;
  }

  sceneCamera(): SceneCamera {
    const { width, height, dpr } = this.viewport;
    return { orient: this.pose.orient, fovY: this.fovY, width: Math.max(1, Math.round(width * dpr)), height: Math.max(1, Math.round(height * dpr)) };
  }

  /** Advance by real seconds and build this frame's snapshot. */
  frame(realDt: number, fly: FlyInput | null = null): SceneSnapshot {
    const wasPlaying = this.clock.playing;
    this.clock.tick(realDt);
    if (wasPlaying && !this.clock.playing) {
      this.message(`Reached the ${this.clock.snapshot().stoppedAt} of the data window. Stopped.`, 'warn');
      this.emit('time');
    }
    const et = this.clock.et;
    // The clock takes real elapsed time; camera motion is capped so a stalled frame doesn't teleport.
    this.updateCamera(Math.min(realDt, 0.1), et, fly);
    this.updateSystemPriorities();
    const t0 = perfNow();
    this.world = computeWorld(et, this.pose.pos, this.bodies, this.eph, this.core, this.sunId);
    this.addSmallBodyGeoms(this.world);
    const t1 = perfNow();
    if (!this.reality.overlays.orbits && this.orbits) this.orbits.stats = { candidates: 0, drawn: 0, built: 0, pending: 0, ms: 0 };
    const orbits =
      this.reality.overlays.orbits && this.orbits
        ? this.orbits.update({ et, world: this.world, fovY: this.fovY, height: this.viewport.height, selectedId: this.selectedId, isFocus: this.focusPredicate() })
        : [];
    if (this.reality.overlays.orbits) orbits.push(...this.smallBodyOrbits(this.world));
    const t2 = perfNow();
    const overlayOnly: OverlayOnlyBody[] = [];
    this.snapshot = buildSnapshot({
      world: this.world,
      camera: this.sceneCamera(),
      reality: this.reality,
      light: this.light,
      selectedId: this.selectedId,
      orbits,
      orientations: this.orientations,
      chainLabel: (id) => this.chainLabel(id, et),
      extras: this.extras,
    }, { overlayOnly });
    this.addSmallBodyCloseUps(this.snapshot, overlayOnly);
    this.overlayOnly = overlayOnly;
    const t3 = perfNow();
    this.timings = { world: t1 - t0, orbits: t2 - t1, snapshot: t3 - t2, total: t3 - t0, bodies: this.snapshot.bodies.length };
    return this.snapshot;
  }

  /** Small bodies the view deals with this frame: the selection and the camera's target/anchor. */
  private smallBodyIdsInView(): number[] {
    const c = this.cam;
    const ids = [this.selectedId, this.travel?.target ?? null, c.mode === 'orbit' ? c.target : c.anchor];
    return [...new Set(ids.filter((id): id is number => id !== null && id < 0))];
  }

  /** Light-time-corrected geometry of those small bodies (CPU f64; a handful of objects, never the catalogue). */
  private addSmallBodyGeoms(world: World): void {
    const sb = this.smallBodies;
    if (!sb) return;
    for (const id of this.smallBodyIdsInView()) {
      const row = sbRow(id);
      if (!sb.has(row)) continue;
      const a = sb.apparent(row, world.cameraPos, world.et, this.core);
      // With an admitted shape model the object's shape is not assumed (app/shapes.ts): the radii keep the measured
      // diameter's label, so the mesh can be drawn wherever that diameter is admitted.
      world.bodies.set(id, { id, body: sb.pseudoBody(row, this.shapedPseudo(id, row)), app: a?.app ?? null, toSun: a?.toSun ?? null });
    }
  }

  /** Orbit tracks of those small bodies: propagated heliocentric positions, drawn relative to the Sun's apparent position. */
  private smallBodyOrbits(world: World) {
    const sb = this.smallBodies;
    const sunRel = this.sunId !== null ? world.bodies.get(this.sunId)?.app?.rel : undefined;
    const w = this.clock.window;
    if (!sb || !sunRel || !w) return [];
    const out: { id: number; points: Float64Array; selected: boolean }[] = [];
    for (const id of this.smallBodyIdsInView()) {
      const tr = sb.orbit(sbRow(id), world.et, w);
      if (!tr) continue;
      const pts = new Float64Array(tr.pos.length);
      for (let i = 0; i < pts.length; i += 3) {
        pts[i] = sunRel[0] + tr.pos[i];
        pts[i + 1] = sunRel[1] + tr.pos[i + 1];
        pts[i + 2] = sunRel[2] + tr.pos[i + 2];
      }
      out.push({ id, points: pts, selected: id === this.selectedId });
    }
    return out;
  }

  /**
   * Small bodies near enough to be resolved, with an admitted shape (a sphere of the measured diameter), are drawn
   * by the renderer as bodies and taken out of the field's points. Everything else stays a point of the field;
   * without a field, a body with an admitted shape goes to the renderer (which draws sub-pixel bodies as points)
   * and one without it gets the overlay marker.
   */
  private addSmallBodyCloseUps(snap: SceneSnapshot, overlayOnly: OverlayOnlyBody[]): void {
    const sb = this.smallBodies;
    const world = this.world;
    if (!sb || !world) return;
    const level = this.reality.exists;
    const cam = snap.camera;
    const ppr = cam.height / (2 * Math.tan(cam.fovY / 2));
    const excluded: number[] = [];
    for (const g of world.bodies.values()) {
      if (g.id >= 0 || !g.app) continue;
      const e = sceneBodyOf(g, level, this.orientations, this.chainLabel(g.id, world.et), this.selectedId, this.extras, 1 / ppr);
      if (!e) continue; // position not admitted at this level
      if ('body' in e && e.body.radii) {
        const px = 2 * Math.tan(angularRadius(e.body.radii[0], len(e.body.pos))) * ppr;
        if (!sb.field || px >= CLOSEUP_MIN_PX) {
          snap.bodies.push(e.body);
          if (sb.field) excluded.push(sbRow(g.id));
          continue;
        }
      }
      if (!sb.field) overlayOnly.push('marker' in e ? e.marker : { id: g.id, name: g.body.name, pos: g.app.rel, worstLabel: e.body.worstLabel, selected: g.id === this.selectedId });
    }
    // Comets resolved from the camera: coma and tails (render/comets), no longer points of the field.
    if (sb.comets) {
      const pixelAngle = (2 * Math.tan(cam.fovY / 2)) / cam.height;
      const inView = this.smallBodyIdsInView().map(sbRow);
      const o = cam.orient;
      const aspect = cam.width / Math.max(1, cam.height);
      const view = { dir: [-o[2], -o[5], -o[8]] as Vec3, halfDiagonalRad: Math.atan(Math.tan(cam.fovY / 2) * Math.hypot(1, aspect)) };
      const got = sb.comets.frame(inView, world.cameraPos, world.et, this.core, level, pixelAngle, undefined, view);
      if (got.comets.length) snap.comets = got.comets;
      if (sb.field) for (const row of got.rows) if (!excluded.includes(row)) excluded.push(row);
    }
    const key = excluded.join(',');
    if (key !== this.sbExcluded) {
      this.sbExcluded = key;
      sb.field?.exclude?.(excluded);
    }
  }

  private updateCamera(dt: number, et: number, fly: FlyInput | null): void {
    if (this.travel) {
      const tr = this.travel;
      tr.elapsed += dt;
      const tp = this.bodyPos(tr.target, et);
      if (tp) {
        if (travelDone(tr)) {
          this.cam = travelEndCam(tr);
          this.pose = orbitPose(this.cam, tp);
          this.finishTravel();
          this.emit('camera');
        } else this.pose = travelPose(tr, tp);
      } else this.finishTravel();
      return;
    }
    if (this.cam.mode === 'orbit') {
      const tp = this.bodyPos(this.cam.target, et);
      if (tp) this.pose = orbitPose(this.cam, tp);
      return;
    }
    // free
    let cam = this.cam;
    if (this.turn) {
      const t = this.turn;
      t.elapsed += dt;
      const u = Math.min(1, t.elapsed / t.duration);
      const e = u * u * (3 - 2 * u);
      cam = { ...cam, orient: matFromQuat(slerpQuat(t.from, t.to, e)) };
      if (u >= 1) this.turn = null;
    }
    const anchorPos = cam.anchor !== null ? this.bodyPos(cam.anchor, et) : null;
    if (fly && (fly.roll || len(fly.move) > 0)) {
      if (fly.roll) cam = freeRoll(cam, fly.roll * dt);
      const spheres = this.spheres(et);
      const cur = freePose(cam, anchorPos).pos;
      const speed = flySpeed(nearestAltitude(cur, spheres).alt, fly.mod);
      cam = freeMove(cam, fly.move, dt, speed);
      const moved = freePose(cam, anchorPos).pos;
      const safe = pushOutside(moved, spheres);
      cam = { ...cam, rel: anchorPos ? sub(safe, anchorPos) : safe };
    }
    this.cam = cam;
    if (cam.anchor === null || anchorPos) this.pose = freePose(cam, anchorPos);
  }

  // ---- picking ------------------------------------------------------------------------------------

  /** Everything clickable this frame, with drawn (level-filtered) radii. */
  pickTargets(): PickTarget[] {
    const s = this.snapshot;
    if (!s) return [];
    const t: PickTarget[] = s.bodies.map((b) => ({ id: b.id, pos: b.pos, radii: b.radii, orient: b.orient }));
    for (const b of this.overlayOnly) t.push({ id: b.id, pos: b.pos, radii: null, orient: null });
    if (s.sun && this.sunId !== null) t.push({ id: this.sunId, pos: s.sun.pos, radii: [s.sun.radius, s.sun.radius, s.sun.radius], orient: null });
    else if (this.sunId !== null) {
      const g = this.world?.bodies.get(this.sunId);
      if (g?.app) t.push({ id: this.sunId, pos: g.app.rel, radii: null, orient: null });
    }
    // Small bodies in view that the field draws as points (or nothing draws at this level): clickable points.
    if (this.world) {
      const have = new Set(t.map((x) => x.id));
      for (const g of this.world.bodies.values()) if (g.id < 0 && g.app && !have.has(g.id)) t.push({ id: g.id, pos: g.app.rel, radii: null, orient: null });
    }
    return t;
  }

  cssViewport(): Viewport {
    return { orient: this.pose.orient, fovY: this.fovY, width: this.viewport.width, height: this.viewport.height };
  }

  pickAt(x: number, y: number): number | null {
    return pick(this.cssViewport(), this.pickTargets(), x, y)?.id ?? null;
  }

  /** pickAt, falling back to the small-body field's GPU pick when no major body is hit. */
  async pickAtAsync(x: number, y: number): Promise<number | null> {
    const id = this.pickAt(x, y);
    if (id !== null) return id;
    const sb = this.smallBodies;
    if (!sb?.field) return null;
    const vp = this.cssViewport();
    const row = await sb.field.pick(pixelRay(vp, x, y), PICK_TOL_PX / pixelsPerRadian(vp));
    return row !== null && sb.has(row) ? sbId(row) : null;
  }

  // ---- events ("Moments") ------------------------------------------------------------------------

  private eventPort(init: EngineInit): EventComputePort {
    if (this.eventWorker) {
      try {
        return new EventWorkerClient(this.eventWorker(), init);
      } catch (e) {
        this.coreErrors.push(`event finder worker: ${(e as Error).message ?? e} (computing on the main thread)`);
      }
    }
    const inp = this.finderInput();
    if (!inp) throw new Error('no ephemerides');
    return new InProcessEvents(new EventEngine(inp));
  }

  private eventHost() {
    return {
      readiness: (c: Category) => this.eventReadiness(c),
      engineInit: (): EngineInit => ({
        ephem: this.eventFiles(this.loadedEphem).map((e) => ({ path: e.path, header: e.header, data: e.data })),
        bodies: this.bodies.map((b) => ({ id: b.id, radii: b.radii, rotation: b.rotation })),
        orientations: (this.data?.orientations ?? []).map((o) => ({ path: o.path, header: o.header, data: o.data })),
        window: this.clock.window ?? { startEt: 0, endEt: 0 },
        atmospheres: [...this.atmosphereTops()].map(([id, topKm]) => ({ id, topKm })),
      }),
      smallBodies: () => {
        const sb = this.smallBodies, c = sb?.closeApproachCandidates();
        if (!sb || !c) return null;
        const h = sb.tables.core.header;
        return { forceModel: h.forceModel, epochEt: h.epochEt, window: h.window, maxKm: c.maxKm, candidates: c.candidates };
      },
      cacheKey: (c: Category) => this.eventCacheKey(c),
    };
  }

  /**
   * The ephemeris files the event finder needs (copied to its worker): in load order, each file that brings a
   * body the finder uses (barycentres, Sun, planets, the Moon, the Galilean moons, Charon) not already brought by
   * an earlier one. The other moon systems (tens of MB) stay on this thread.
   */
  private eventFiles(files: LoadedEphemeris[]): LoadedEphemeris[] {
    const used = new Set([...Array.from({ length: 11 }, (_, i) => i), 199, 299, 301, 399, 499, 599, 699, 799, 899, 999, 501, 502, 503, 504, 901]);
    const have = new Set<number>();
    return files.filter((f) => {
      const brings = f.header.segments.map((s) => s.target).filter((t) => used.has(t) && !have.has(t));
      brings.forEach((t) => have.add(t));
      return brings.length > 0;
    });
  }

  /** Whether the inputs of a category of events are loaded. */
  eventReadiness(c: Category): Readiness {
    const w = this.clock.window;
    const eph = this.eph;
    if (!eph || !w) return { state: 'no', why: 'No ephemerides are loaded.' };
    const mid = 0.5 * (w.startEt + w.endEt);
    const need = (ids: number[], opts: { radii?: number[]; rotation?: number[] } = {}): Readiness => {
      for (const id of ids) {
        if (!this.byId.has(id)) return { state: 'no', why: `The data has no body ${id}.` };
        const st = this.bodyLoadState(id);
        if (st === 'error') return { state: 'no', why: `The ephemeris of ${this.bodyName(id)} could not be loaded.` };
        if (st !== 'loaded') return { state: 'wait', why: `Waiting for ${this.systems?.pendingFor(id).map((s) => s.title).join(', ') || 'its ephemeris'} to load.` };
        if (!eph.positionSSB(id, mid)) return { state: 'no', why: `No position for ${this.bodyName(id)} in the data window.` };
      }
      for (const id of opts.radii ?? []) if (!this.byId.get(id)?.radii?.value) return { state: 'no', why: `${this.bodyName(id)} has no radii in the data.` };
      for (const id of opts.rotation ?? []) if (!this.byId.get(id)?.rotation?.value) return { state: 'no', why: `${this.bodyName(id)} has no rotation model in the data.` };
      return { state: 'ready' };
    };
    switch (c) {
      case 'eclipses':
        return need([10, 399, 301], { radii: [10, 399, 301] });
      case 'planets': {
        const r = need([10, 399], { radii: [10] });
        // The ecliptic pole comes from the Earth–Moon barycentre's orbit.
        return r.state === 'ready' && !eph.positionSSB(3, mid) ? { state: 'no', why: 'No Earth–Moon barycentre in the ephemerides.' } : r;
      }
      case 'saturn':
        return need([10, 399, 699], { rotation: [699] });
      case 'jovian':
        return need([10, 399, 599, 501, 502, 503, 504], { radii: [599], rotation: [599] });
      case 'pluto':
        return need([399, 999, 901], { radii: [999, 901] });
      case 'neo': {
        const s = this.sb.status;
        if (s === 'ready') return this.smallBodies?.closeApproachCandidates() ? { state: 'ready' } : { state: 'no', why: 'The small-body catalogue does not flag close approaches (or not with a stated distance).' };
        if (s === 'waiting' || s === 'loading') return { state: 'wait', why: 'Waiting for the small-body catalogue to load.' };
        if (s === 'off') return { state: 'no', why: 'Small bodies are disabled by the URL (smallbodies=0).' };
        return { state: 'no', why: s === 'absent' ? 'The data has no small-body catalogue.' : 'The small-body catalogue could not be loaded.' };
      }
    }
  }

  /** Cache key for a category: the finder version and the sha256 of every input file (null without a manifest). */
  private eventCacheKey(c: Category): string | null {
    const man = this.data?.manifest;
    if (!man) return null;
    const inputs = Object.keys(man.products)
      .filter((p) => /^(ephem|orient)\//.test(p) || p === 'bodies.json' || (c === 'neo' && /^smallbodies\/(core|nongrav)\.(json|bin)$/.test(p)))
      .sort();
    const parts = inputs.map((p) => `${p}=${man.products[p].sha256 ?? ''}`);
    if (!parts.length || parts.some((x) => x.endsWith('='))) return null;
    return `v${FINDER_VERSION}:${c}:${hashKey(parts.join(';'))}`;
  }

  /** The finder's geometry on this thread (curated views are placed with it). */
  finderInput(): FinderInput | null {
    const eph = this.eph, w = this.clock.window;
    if (!eph || !w) return null;
    const radii = new Map<number, Vec3>();
    for (const b of this.bodies) if (b.radii?.value) radii.set(b.id, [b.radii.value[0], b.radii.value[1], b.radii.value[2]]);
    return { eph: { positionSSB: (id, et) => copy(eph.positionSSB(id, et)) }, radii, orientation: (id, et) => this.orientations.orientation(id, et), window: w, atmosphereTopKm: this.atmosphereTops() };
  }

  /** Top of each drawn atmosphere above its body's largest radius, km (as the renderer draws the shell). */
  private atmosphereTops(): Map<number, number> {
    const out = new Map<number, number>();
    for (const a of Object.values(this.data?.atmospheres?.bodies ?? {})) {
      if (a.topAltitudeKm === null || a.topAltitudeKm === undefined) continue;
      out.set(a.naifId, a.topAltitudeKm - (a.altitudesKm?.[0] ?? 0));
    }
    return out;
  }

  /** Curated views: the most striking events found so far, and a few placed near the current time. */
  curatedViews(): Bookmark[] {
    const now = this.nowEt() ?? this.clock.et;
    const key = `${this.data?.manifest?.generatedAt ?? ''}:${this.loadedEphem.length}:${Math.round(now / SECONDS_PER_DAY)}`;
    if (this.staticViews?.key !== key) {
      const inp = this.finderInput();
      let list: Bookmark[] = [];
      try {
        list = inp ? staticBookmarks(inp, now) : [];
      } catch (e) {
        this.coreErrors.push(`curated views: ${(e as Error).message ?? e}`);
      }
      this.staticViews = { key, list };
    }
    return [...eventBookmarks(this.events?.all() ?? [], now), ...this.staticViews.list];
  }

  /**
   * Show an event: jump to its time (paused) and place the camera as the view says — orbiting its target, or
   * fixed near a surface looking at another body. Resolves when the camera is there.
   */
  goToEvent(ev: SkyEvent, viewIndex = 0, opts: { instant?: boolean } = {}): Promise<void> | string {
    const v = ev.views[viewIndex];
    if (!v) return `${ev.title}: no such view.`;
    return this.showView(v, v.et ?? ev.et, opts);
  }

  showView(v: EventView, et: number, opts: { instant?: boolean } = {}): Promise<void> | string {
    this.clock.pause();
    this.setEt(et);
    this.setFovDeg(v.fovDeg ?? DEFAULT_FOV_DEG);
    if (v.enhancedStops !== undefined) this.setReality({ view: 'enhanced', exposureBoostStops: v.enhancedStops });
    if (v.sunShield) this.setReality({ sunShield: true });
    const rel = v.rel, d = len(rel);
    if (v.lookAt === undefined) return this.goTo(v.target, d, { dir: norm(rel), up: v.up, instant: opts.instant });
    // A fixed viewpoint (near a surface): the camera keeps its offset from `target` and looks at `lookAt`.
    const tp = this.bodyPos(v.target), lp = this.bodyPos(v.lookAt);
    if (!tp || !lp) return `No position for ${this.bodyName(tp ? v.lookAt : v.target)} at this time.`;
    const pos: Vec3 = [tp[0] + rel[0], tp[1] + rel[1], tp[2] + rel[2]];
    const fwd = norm(sub(lp, pos));
    this.finishTravel();
    this.turn = null;
    this.cam = { mode: 'free', anchor: v.target, rel: [rel[0], rel[1], rel[2]], orient: lookRotation(fwd, v.up ?? defaultUp(fwd)) };
    this.pose = freePose(this.cam, tp);
    this.select(v.lookAt);
    this.emit('camera');
    return Promise.resolve();
  }

  // ---- URL & debug --------------------------------------------------------------------------------

  /** Apply URL view parameters (after setData). */
  applyUrl(v: UrlView): void {
    this.firstRun = Object.keys(v).length === 0;
    if (v.smallbodies === false) this.setSyntheticLayerAvailable(false);   // no small bodies: no synthetic layer
    if (v.fov !== undefined) this.fovY = Math.min(120, Math.max(1, v.fov)) * DEG;
    const patch: Parameters<AppModel['setReality']>[0] = { overlays: {} };
    if (v.exists) patch.exists = v.exists;
    if (v.view) patch.view = v.view;
    if (v.boost !== undefined) patch.exposureBoostStops = v.boost;
    if (v.labels !== undefined) patch.overlays!.labels = v.labels;
    if (v.orbits !== undefined) patch.overlays!.orbits = v.orbits;
    if (v.tint !== undefined) patch.overlays!.provenanceTint = v.tint;
    if (v.shield !== undefined) patch.sunShield = v.shield;
    if (v.adapt !== undefined) patch.instantAdaptation = v.adapt === 'instant';
    if (v.adaptFrom !== undefined) patch.adaptationHistory = v.adaptFrom;
    if (v.adaptTimeS !== undefined) patch.adaptationTimeS = v.adaptTimeS;
    this.setReality(patch);
    if (v.ui === false) this.uiHidden = true;

    if (v.tMs !== undefined && this.timeScale) {
      this.setEt(this.timeScale.utcMsToEt(v.tMs));
      this.clock.pause();
    } else {
      if (v.tMs !== undefined) this.message('Ignoring t: no time.json, so UTC cannot be converted.', 'warn');
      if (this.goNow()) this.clock.play();
    }
    this.emit('time');
    if (this.firstRun && this.firstRunView()) return;

    // Requested target first; if it cannot be shown now, fall back (and say so).
    const fallbacks = [DEFAULT_TARGET, ...this.bodies.filter((b) => b.kind === 'planet').map((b) => b.id), this.sunId];
    const candidates = [v.target, ...fallbacks].filter((id, i, a): id is number => id !== undefined && id !== null && a.indexOf(id) === i);
    for (const id of candidates) {
      if (!this.byId.has(id)) {
        if (id === v.target && id >= SPKID_MIN && this.data?.smallBodies) {
          // An SBDB SPK-ID: resolved through the name index once the catalogue is in; start somewhere meanwhile.
          this.pendingSpkid = { spkid: id, dist: v.dist, az: v.az, el: v.el };
          if (this.sb.status === 'off') this.failPendingSpkid('small bodies are disabled by the URL (smallbodies=0)');
        } else if (id === v.target) this.message(`Unknown target ${id}.`, 'warn');
        continue;
      }
      const requested = id === v.target;
      const r = this.goTo(id, requested ? v.dist : undefined, requested ? { azDeg: v.az, elDeg: v.el, instant: true } : { instant: true });
      if (typeof r !== 'string') {
        if (requested && v.look) this.lookLocal(id, v.look.azDeg, v.look.elDeg);
        return;
      }
      this.message(r, 'warn');
    }
  }

  /**
   * The first-run view: the Earth framed as a go-to would, with the Moon beside it (FIRST_RUN_MOON_OFFSET_DEG from
   * the centre) — the camera on the cone around the anti-Moon direction that gives that offset, turned as far
   * toward the Sun as the cone allows (the most lit Earth this configuration offers). False if impossible.
   */
  firstRunView(): boolean {
    const E = this.bodyPos(DEFAULT_TARGET), M = this.bodyPos(FIRST_RUN_COMPANION), r = this.radiusOf(DEFAULT_TARGET);
    if (!E || !M || !r) return false;
    const dist = this.defaultDistance(DEFAULT_TARGET);
    const um = norm(sub(M, E));
    const ts = this.toSunAt(DEFAULT_TARGET);
    const w = perpComponent(ts ?? [0, 0, 1], um);
    const dirAt = (b: number): Vec3 => norm([-um[0] * Math.cos(b) + w[0] * Math.sin(b), -um[1] * Math.cos(b) + w[1] * Math.sin(b), -um[2] * Math.cos(b) + w[2] * Math.sin(b)]);
    const moonOff = (b: number) => {
      const d = dirAt(b);
      const C: Vec3 = [E[0] + d[0] * dist, E[1] + d[1] * dist, E[2] + d[2] * dist];
      const a = norm(sub(M, C)), e = norm(sub(E, C));
      return Math.acos(Math.max(-1, Math.min(1, a[0] * e[0] + a[1] * e[1] + a[2] * e[2])));
    };
    // The offset grows with the cone angle (0: the Moon hidden behind the Earth); bisection.
    let lo = 0, hi = Math.PI / 2;
    const want = FIRST_RUN_MOON_OFFSET_DEG * DEG;
    if (moonOff(hi) < want) lo = hi;
    for (let i = 0; i < 60; i++) {
      const mid = 0.5 * (lo + hi);
      if (moonOff(mid) < want) lo = mid; else hi = mid;
    }
    const r2 = this.goTo(DEFAULT_TARGET, dist, { dir: dirAt(0.5 * (lo + hi)), instant: true });
    if (typeof r2 === 'string') return false;
    // Nothing selected: the view is uncluttered, and the hint invites a click.
    this.select(null);
    return true;
  }

  /** The local frame at the camera's place relative to body `id`: up (from its centre), north and east. */
  private localFrame(id: number, rel: Vec3): { up: Vec3; north: Vec3; east: Vec3 } {
    const up = norm(rel);
    const o = this.orientations.orientation(id, this.clock.et);
    const pole: Vec3 = o ? [o[2], o[5], o[8]] : [0, 0, 1];
    let north = perpComponent(pole, up);
    if (len(north) < 1e-9) north = perpComponent([1, 0, 0], up);
    north = norm(north);
    const east: Vec3 = [north[1] * up[2] - north[2] * up[1], north[2] * up[0] - north[0] * up[2], north[0] * up[1] - north[1] * up[0]];
    return { up, north, east };
  }

  /** Keep the camera where it is and look along local azimuth/elevation (URL `look`): a free camera anchored at `id`. */
  lookLocal(id: number, azDeg: number, elDeg: number): void {
    const tp = this.bodyPos(id);
    if (!tp) return;
    const rel = sub(this.pose.pos, tp);
    const { up, north, east } = this.localFrame(id, rel);
    const a = azDeg * DEG, e = elDeg * DEG;
    const fwd = norm([0, 1, 2].map((k) => Math.cos(e) * (Math.cos(a) * north[k] + Math.sin(a) * east[k]) + Math.sin(e) * up[k]) as Vec3);
    this.finishTravel();
    this.turn = null;
    this.cam = { mode: 'free', anchor: id, rel, orient: lookRotation(fwd, up) };
    this.pose = freePose(this.cam, tp);
    this.emit('camera');
  }

  currentUrlView(): UrlView {
    const v: UrlView = {};
    const ms = this.utcMs();
    if (ms !== null) v.tMs = ms;
    // A small body is linked by its SBDB SPK-ID (known once its name was fetched); without it, no target.
    const target = this.cam.mode === 'orbit' ? (this.cam.target < 0 ? this.names?.spkidOf(sbRow(this.cam.target)) ?? null : this.cam.target) : null;
    if (this.cam.mode === 'orbit' && target !== null) {
      v.target = target;
      v.dist = this.cam.dist;
      const ae = azElFromDir(sunFrame(this.toSunAt(this.cam.target)), this.cam.dir);
      v.az = ae.az / DEG;
      v.el = ae.el / DEG;
    } else if (this.cam.mode === 'free' && this.cam.anchor !== null && this.cam.anchor >= 0) {
      // A free camera anchored at a body: its place as target/dist/az/el and its view direction as `look`.
      const c = this.cam;
      v.target = c.anchor!;
      v.dist = len(c.rel);
      const ae = azElFromDir(sunFrame(this.toSunAt(c.anchor!)), norm(c.rel));
      v.az = ae.az / DEG;
      v.el = ae.el / DEG;
      const { up, north, east } = this.localFrame(c.anchor!, c.rel);
      const f: Vec3 = [-c.orient[2], -c.orient[5], -c.orient[8]];
      const el = Math.asin(Math.max(-1, Math.min(1, f[0] * up[0] + f[1] * up[1] + f[2] * up[2])));
      const az = Math.atan2(f[0] * east[0] + f[1] * east[1] + f[2] * east[2], f[0] * north[0] + f[1] * north[1] + f[2] * north[2]);
      v.look = { azDeg: az / DEG, elDeg: el / DEG };
    }
    const d = this.realityDefaults, r = this.reality;
    if (r.exists !== d.exists) v.exists = r.exists;
    if (r.view !== d.view) v.view = r.view;
    if (r.view === 'enhanced' && r.exposureBoostStops) v.boost = r.exposureBoostStops;
    if (Math.abs(this.fovY / DEG - DEFAULT_FOV_DEG) > 1e-9) v.fov = this.fovY / DEG;
    if (r.overlays.labels !== d.overlays.labels) v.labels = r.overlays.labels;
    if (r.overlays.orbits !== d.overlays.orbits) v.orbits = r.overlays.orbits;
    if (r.overlays.provenanceTint !== d.overlays.provenanceTint) v.tint = r.overlays.provenanceTint;
    if (!!r.sunShield !== !!d.sunShield) v.shield = !!r.sunShield;
    if (!!r.instantAdaptation !== !!d.instantAdaptation) v.adapt = r.instantAdaptation ? 'instant' : 'realtime';
    if (r.adaptationHistory) v.adaptFrom = r.adaptationHistory;
    if (r.adaptationTimeS !== undefined) v.adaptTimeS = r.adaptationTimeS;
    return v;
  }

  debugState() {
    const c = this.clock.snapshot();
    const cam = this.cam;
    const sunRes = this.world ? buildSun(this.world, this.light, this.reality.exists) : null;
    const target = this.travel ? this.travel.target : cam.mode === 'orbit' ? cam.target : null;
    const ae = cam.mode === 'orbit' ? azElFromDir(sunFrame(this.toSunAt(cam.target)), cam.dir) : null;
    return {
      et: c.et,
      utc: this.utcMs() !== null ? this.formatTime() : null,
      playing: c.playing,
      rate: c.rate,
      window: c.window,
      outsideWindow: c.outside,
      selected: this.selectedId,
      camera: {
        mode: cam.mode,
        target,
        anchor: cam.mode === 'free' ? cam.anchor : null,
        posSSB: this.pose.pos,
        forward: forwardOf(this.pose.orient),
        distKm: cam.mode === 'orbit' ? cam.dist : null,
        azDeg: ae ? ae.az / DEG : null,
        elDeg: ae ? ae.el / DEG : null,
        fovDeg: this.fovY / DEG,
        traveling: !!this.travel,
      },
      reality: this.reality,
      badge: this.badge(),
      drawn: {
        sun: !!this.snapshot?.sun,
        sunReason: sunRes?.reason ?? null,
        bodies: this.snapshot?.bodies.map((b) => ({ id: b.id, name: b.name, worstLabel: b.worstLabel, surfaceUnknown: b.surfaceUnknown, resolved: !!b.radii })) ?? [],
        orbits: this.snapshot?.orbits.length ?? 0,
        inView: this.bodiesInView(),
      },
      noPosition: [...(this.world?.bodies.values() ?? [])].filter((g) => !g.app).map((g) => g.id),
      loading: this.systems
        ? {
            ...this.systems.summary(),
            systems: Object.fromEntries(this.systems.systems.map((s) => [s.name, this.systems!.state(s.path)])),
          }
        : null,
      timings: this.timings,
      orbitStats: this.orbits?.stats ?? null,
      smallBodies: this.smallBodyDebug(),
      data: {
        loaded: this.data?.report.products.filter((p) => p.status === 'ok').map((p) => p.path) ?? [],
        missing: this.data?.report.products.filter((p) => p.status === 'missing').map((p) => p.path) ?? [],
        errors: [...(this.data?.report.products.filter((p) => p.status === 'error').map((p) => `${p.path}: ${p.message}`) ?? []), ...this.coreErrors],
      },
      messages: this.messages.map((m) => m.text),
    };
  }

  /**
   * What is in the frame this frame: bodies sent to the renderer, overlay-only markers and the Sun, whose
   * projected disk overlaps the viewport, with their apparent diameter (CSS px; 0 for points and markers).
   * The regression suite (scripts/e2e.mjs) compares these per scene.
   */
  bodiesInView(): { id: number; name: string; worstLabel: Label | null; px: number; surfaceUnknown: boolean; marker: boolean }[] {
    const s = this.snapshot;
    if (!s) return [];
    const vp = this.cssViewport();
    const ppr = pixelsPerRadian(vp);
    const out: ReturnType<AppModel['bodiesInView']> = [];
    const add = (id: number, name: string, pos: Vec3, r: number | null, worstLabel: Label | null, surfaceUnknown: boolean, marker: boolean) => {
      const p = project(vp, pos);
      if (!p) return;
      const px = r ? 2 * Math.tan(angularRadius(r, p.dist)) * ppr : 0;
      if (p.x + px / 2 < 0 || p.y + px / 2 < 0 || p.x - px / 2 > vp.width || p.y - px / 2 > vp.height) return;
      out.push({ id, name, worstLabel, px: Math.round(px * 100) / 100, surfaceUnknown, marker });
    };
    for (const b of s.bodies) add(b.id, b.name, b.pos, b.radii ? Math.max(b.radii[0], b.radii[1], b.radii[2]) : null, b.worstLabel, b.surfaceUnknown, false);
    for (const b of this.overlayOnly) add(b.id, b.name, b.pos, null, b.worstLabel, false, true);
    if (s.sun && this.sunId !== null) add(this.sunId, this.bodyName(this.sunId), s.sun.pos, s.sun.radius, null, false, false);
    return out.sort((a, b) => a.id - b.id);
  }

  private smallBodyDebug() {
    const sb = this.smallBodies;
    const sel = this.selectedId !== null && this.selectedId < 0 && sb ? sbRow(this.selectedId) : null;
    const g = this.selectedId !== null && this.selectedId < 0 ? this.world?.bodies.get(this.selectedId) : undefined;
    return {
      status: this.sb.status,
      message: this.sb.message,
      loadMs: this.sb.ms,
      count: sb?.count ?? null,
      field: !!sb?.field,
      names: this.names ? { state: this.names.state, count: this.names.count, error: this.names.error } : null,
      counts: this.smallBodyCounts(),
      cpuPropagationMs: sb?.cpu.ms ?? null,
      closeUps: this.snapshot?.bodies.filter((b) => b.id < 0).map((b) => b.id) ?? [],
      selected:
        sel !== null && sb
          ? { row: sel, name: sb.name(sel), spkid: this.names?.spkidOf(sel) ?? null, flags: sb.flags(sel), distKm: g?.app ? len(g.app.rel) : null, lightTimeS: g?.app?.lightTime ?? null }
          : null,
    };
  }

  /** The planet (or dwarf planet, or Sun) a body belongs to in the UI hierarchy; the body itself if top-level. */
  rootOf(id: number): number {
    let r = this.roots.get(id);
    if (r === undefined) {
      r = id;
      for (let i = 0, b = this.byId.get(id); b && b.parent !== undefined && this.byId.has(b.parent) && i < 8; i++) {
        r = b.parent;
        b = this.byId.get(b.parent);
      }
      this.roots.set(id, r);
    }
    return r;
  }

  /** The system the view is about: that of the travel/orbit target, else the free-flight anchor, else the selection. */
  focusRoot(): number | null {
    const c = this.cam;
    const id = this.travel?.target ?? (c.mode === 'orbit' ? c.target : c.anchor) ?? this.selectedId;
    return id === null ? null : this.rootOf(id);
  }

  /**
   * Build every orbit track the overlay still needs now, ignoring the per-frame budget (used before declaring
   * a screenshot ready, where each rendered frame can be expensive). Returns the number of tracks built.
   */
  finishOrbitWork(): number {
    if (!this.reality.overlays.orbits || !this.orbits || !this.world) return 0;
    this.orbits.update({ et: this.world.et, world: this.world, fovY: this.fovY, height: this.viewport.height, selectedId: this.selectedId, isFocus: this.focusPredicate() }, Infinity);
    return this.orbits.stats.built;
  }

  private focusPredicate(): (id: number) => boolean {
    const f = this.focusRoot();
    return (id) => f === null || this.rootOf(id) === f;
  }

  /** Worst label etc. for a body at the current level (inspector). */
  filtered(id: number) {
    const b = this.bodyOf(id);
    return b ? filtered(b, this.reality.exists, this.chainLabel(id), this.orientationSource(id)) : null;
  }

  distanceTo(id: number): number | null {
    const g = this.world?.bodies.get(id);
    return g?.app ? len(g.app.rel) : null;
  }

  heliocentricDistance(id: number): number | null {
    const g = this.world?.bodies.get(id);
    return g?.toSun ? len(g.toSun) : null;
  }
}
