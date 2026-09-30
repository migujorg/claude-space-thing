// The app model: everything the shell knows (data, time, camera, selection, reality settings) and the
// per-frame pipeline world → snapshot. No DOM, no GPU: the UI and bootstrap drive it, tests use it
// with fake core implementations.

import type { Body, LightData } from '../data/schema';
import type { LoadedData } from '../data/load';
import { buildStarCatalog, starDirection, type StarFilterResult } from '../data/stars';
import type { SceneCamera, SceneSnapshot } from '../render/scene';
import {
  azElFromDir, CAMERA_TUNING, clampDist, defaultUp, dirFromAzEl, flySpeed, forwardOf, freeLook, freeMove, freePose,
  freeRoll, lookRotation, nearestAltitude, orbitPose, orbitRoll, orbitRotate, orbitZoom, pushOutside, startTravel,
  sunFrame, sunlitDirection, toFree, toOrbit, travelDone, travelEndCam, travelPose, upOf, viewDistance,
  type CamState, type Pose, type Sphere, type Travel,
} from './camera';
import { Clock, intersectWindows, type TimeWindow } from './clock';
import { OrbitTracks, trackPolyline } from './orbits';
import { pick, type PickTarget, type Viewport } from './picking';
import type { CoreDeps, EphemerisSetPort, TimeScalePort, Vec3 } from './ports';
import { badgeParts, defaultReality, labelAllowed, type RealityState } from './reality';
import { buildSnapshot, buildSun, filtered } from './snapshot';
import { parseIsoUtc, type UrlView } from './url';
import { DEG, IDENTITY, len, matFromQuat, norm, quatFromMat, slerpQuat, sub } from './vec';
import { computeWorld, copy, findSunId, isPhysical, navRadius, type World } from './world';

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

export type AppEvent = 'data' | 'selection' | 'reality' | 'time' | 'camera' | 'message';

export interface AppMessage {
  text: string;
  level: 'info' | 'warn' | 'error';
}

const DEFAULT_FOV_DEG = 50;
/** Preferred initial target (NAIF id of Earth, a naming convention — not a physical value). */
const DEFAULT_TARGET = 399;

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
  clock = new Clock(0, null);
  readonly realityDefaults: RealityState;
  reality: RealityState;
  fovY = DEFAULT_FOV_DEG * DEG;
  cam: CamState = { mode: 'free', anchor: null, rel: [0, 0, 0], orient: IDENTITY };
  travel: Travel | null = null;
  private travelResolve: (() => void) | null = null;
  private turn: Turn | null = null;
  selectedId: number | null = null;
  pose: Pose = { pos: [0, 0, 0], orient: IDENTITY };
  world: World | null = null;
  snapshot: SceneSnapshot | null = null;
  viewport: ViewportSize = { width: 1, height: 1, dpr: 1 };
  uiHidden = false;
  /** Problems constructing core objects from loaded data (shown in the Data panel). */
  coreErrors: string[] = [];
  messages: AppMessage[] = [];
  private tracks: OrbitTracks | null = null;
  private starCache = new Map<string, StarFilterResult>();
  private listeners = new Map<AppEvent, Set<() => void>>();
  private readonly now: () => number;

  constructor(core: CoreDeps, opts: { now?: () => number; syntheticLayerAvailable?: boolean } = {}) {
    this.core = core;
    this.now = opts.now ?? Date.now;
    this.realityDefaults = defaultReality({ syntheticLayerAvailable: opts.syntheticLayerAvailable });
    this.reality = structuredClone(this.realityDefaults);
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

  setData(d: LoadedData): void {
    this.data = d;
    this.bodies = d.bodies;
    this.byId = new Map(d.bodies.map((b) => [b.id, b]));
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
    if (d.ephemerides.length) {
      const set = new this.core.EphemerisSet();
      let added = 0;
      for (const e of d.ephemerides) {
        try {
          set.add(new this.core.Ephemeris(e.header, e.data));
          added++;
        } catch (err) {
          this.coreErrors.push(`${e.path} could not be used: ${(err as Error).message ?? err}`);
        }
      }
      if (added) {
        this.eph = set;
        try {
          ephWindow = set.window;
        } catch {
          ephWindow = null;
        }
      }
    }
    const window = intersectWindows(d.manifest?.window, ephWindow);
    this.clock = new Clock(window ? (window.startEt + window.endEt) / 2 : 0, window);
    if (this.eph && window) this.tracks = new OrbitTracks(this.eph, this.bodies, this.sunId, window);
    this.starCache.clear();
    this.emit('data');
    this.emit('time');
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
    this.reality = { ...this.reality, ...patch, overlays: { ...this.reality.overlays, ...(patch.overlays ?? {}) } };
    this.emit('reality');
  }

  badge(): string[] {
    return badgeParts(this.reality, this.realityDefaults);
  }

  setFovDeg(deg: number): void {
    this.fovY = Math.min(120, Math.max(1, deg)) * DEG;
    this.emit('camera');
  }

  // ---- selection & navigation ------------------------------------------------------------------------

  select(id: number | null): void {
    if (id !== null && !this.byId.has(id)) return;
    this.selectedId = id;
    this.emit('selection');
  }

  bodyPos(id: number, et = this.clock.et): Vec3 | null {
    return this.eph && this.eph.covers(id, et) ? copy(this.eph.positionSSB(id, et)) : null;
  }

  radiusOf(id: number): number | null {
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
  goTo(id: number, dist?: number, opts: { azDeg?: number; elDeg?: number; instant?: boolean } = {}): Promise<void> | string {
    const body = this.byId.get(id);
    if (!body || !isPhysical(body)) return `No body with id ${id}.`;
    const tp = this.bodyPos(id);
    if (!tp) return `No position for ${body.name} at this time (outside its ephemeris coverage).`;
    const radius = this.radiusOf(id);
    const endDist = clampDist(dist ?? this.defaultDistance(id), radius);
    let dir: Vec3;
    const toSun = this.toSunAt(id);
    if (opts.azDeg !== undefined || opts.elDeg !== undefined)
      dir = dirFromAzEl(sunFrame(toSun), (opts.azDeg ?? CAMERA_TUNING.viewAzDeg) * DEG, (opts.elDeg ?? CAMERA_TUNING.viewElDeg) * DEG);
    else if (this.cam.mode === 'orbit' && this.cam.target === id && !this.travel) dir = this.cam.dir;
    else dir = sunlitDirection(toSun);
    const up = defaultUp(dir);
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
      const alt = nearestAltitude(this.pose.pos, this.spheres()).alt;
      this.cam = freeMove(this.cam, [0, 0, 1], Math.abs(notches) * 0.15, Math.sign(notches) * flySpeed(alt));
    }
    this.emit('camera');
  }

  roll(a: number): void {
    if (this.cam.mode === 'orbit') this.cam = orbitRoll(this.cam, a);
    else this.cam = freeRoll(this.cam, a);
  }

  private spheres(et = this.clock.et): Sphere[] {
    const out: Sphere[] = [];
    for (const b of this.bodies) {
      if (!isPhysical(b)) continue;
      const p = this.bodyPos(b.id, et);
      if (p) out.push({ center: p, radius: this.radiusOf(b.id) ?? 0 });
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
    this.world = computeWorld(et, this.pose.pos, this.bodies, this.eph, this.core, this.sunId);
    this.snapshot = buildSnapshot({
      world: this.world,
      camera: this.sceneCamera(),
      reality: this.reality,
      light: this.light,
      selectedId: this.selectedId,
      orbits: this.reality.overlays.orbits ? this.orbitPolylines(this.world) : [],
      core: this.core,
    });
    return this.snapshot;
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

  private orbitPolylines(world: World) {
    const out = [];
    const w = this.clock.window;
    if (!this.tracks || !w) return [];
    for (const g of world.bodies.values()) {
      if (!g.app || g.body.kind === 'star') continue;
      const tr = this.tracks.get(g.id, world.et);
      if (!tr) continue;
      const parent = world.bodies.get(tr.parentId);
      if (!parent?.app) continue;
      out.push(trackPolyline(tr, world.et, w, parent.app.rel, g.id === this.selectedId));
    }
    return out;
  }

  // ---- picking ------------------------------------------------------------------------------------

  /** Everything clickable this frame, with drawn (level-filtered) radii. */
  pickTargets(): PickTarget[] {
    const s = this.snapshot;
    if (!s) return [];
    const t: PickTarget[] = s.bodies.map((b) => ({ id: b.id, pos: b.pos, radii: b.radii, orient: b.orient }));
    if (s.sun && this.sunId !== null) t.push({ id: this.sunId, pos: s.sun.pos, radii: [s.sun.radius, s.sun.radius, s.sun.radius], orient: null });
    else if (this.sunId !== null) {
      const g = this.world?.bodies.get(this.sunId);
      if (g?.app) t.push({ id: this.sunId, pos: g.app.rel, radii: null, orient: null });
    }
    return t;
  }

  cssViewport(): Viewport {
    return { orient: this.pose.orient, fovY: this.fovY, width: this.viewport.width, height: this.viewport.height };
  }

  pickAt(x: number, y: number): number | null {
    return pick(this.cssViewport(), this.pickTargets(), x, y)?.id ?? null;
  }

  // ---- URL & debug --------------------------------------------------------------------------------

  /** Apply URL view parameters (after setData). */
  applyUrl(v: UrlView): void {
    if (v.fov !== undefined) this.fovY = Math.min(120, Math.max(1, v.fov)) * DEG;
    const patch: Parameters<AppModel['setReality']>[0] = { overlays: {} };
    if (v.exists) patch.exists = v.exists;
    if (v.view) patch.view = v.view;
    if (v.boost !== undefined) patch.exposureBoostStops = v.boost;
    if (v.labels !== undefined) patch.overlays!.labels = v.labels;
    if (v.orbits !== undefined) patch.overlays!.orbits = v.orbits;
    if (v.tint !== undefined) patch.overlays!.provenanceTint = v.tint;
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

    // Requested target first; if it cannot be shown now, fall back (and say so).
    const fallbacks = [DEFAULT_TARGET, ...this.bodies.filter((b) => b.kind === 'planet').map((b) => b.id), this.sunId];
    const candidates = [v.target, ...fallbacks].filter((id, i, a): id is number => id !== undefined && id !== null && a.indexOf(id) === i);
    for (const id of candidates) {
      if (!this.byId.has(id)) {
        if (id === v.target) this.message(`Unknown target ${id}.`, 'warn');
        continue;
      }
      const requested = id === v.target;
      const r = this.goTo(id, requested ? v.dist : undefined, requested ? { azDeg: v.az, elDeg: v.el, instant: true } : { instant: true });
      if (typeof r !== 'string') return;
      this.message(r, 'warn');
    }
  }

  currentUrlView(): UrlView {
    const v: UrlView = {};
    const ms = this.utcMs();
    if (ms !== null) v.tMs = ms;
    if (this.cam.mode === 'orbit') {
      v.target = this.cam.target;
      v.dist = this.cam.dist;
      const ae = azElFromDir(sunFrame(this.toSunAt(this.cam.target)), this.cam.dir);
      v.az = ae.az / DEG;
      v.el = ae.el / DEG;
    }
    const d = this.realityDefaults, r = this.reality;
    if (r.exists !== d.exists) v.exists = r.exists;
    if (r.view !== d.view) v.view = r.view;
    if (r.view === 'enhanced' && r.exposureBoostStops) v.boost = r.exposureBoostStops;
    if (Math.abs(this.fovY / DEG - DEFAULT_FOV_DEG) > 1e-9) v.fov = this.fovY / DEG;
    if (r.overlays.labels !== d.overlays.labels) v.labels = r.overlays.labels;
    if (r.overlays.orbits !== d.overlays.orbits) v.orbits = r.overlays.orbits;
    if (r.overlays.provenanceTint !== d.overlays.provenanceTint) v.tint = r.overlays.provenanceTint;
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
      },
      noPosition: [...(this.world?.bodies.values() ?? [])].filter((g) => !g.app).map((g) => g.id),
      data: {
        loaded: this.data?.report.products.filter((p) => p.status === 'ok').map((p) => p.path) ?? [],
        missing: this.data?.report.products.filter((p) => p.status === 'missing').map((p) => p.path) ?? [],
        errors: [...(this.data?.report.products.filter((p) => p.status === 'error').map((p) => `${p.path}: ${p.message}`) ?? []), ...this.coreErrors],
      },
      messages: this.messages.map((m) => m.text),
    };
  }

  /** Worst label etc. for a body at the current level (inspector). */
  filtered(id: number) {
    const b = this.byId.get(id);
    return b ? filtered(b, this.reality.exists) : null;
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
