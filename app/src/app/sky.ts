// SkyController: the M4 sky in the app. It decides which stars are drawn as points and which light goes into the
// sky background, streams the deep tiles, and feeds the renderer (setStars + the render/sky background hook).
//
// The split is by brightness: a catalogue star (bright tier, loaded deep-tier records) is a point when its
// visibility proxy v = max(Y, S / 1.408) — photopic illuminance, or the scotopic one referred to the 2850 K
// point the eye model's limiting magnitude is defined for — reaches the point cut Y_cut = E(V_lim + MARGIN_MAG),
// where V_lim is the faintest point the renderer could show anywhere in the frame (stats.pointLimitingMagnitude:
// the eye looking at the frame's darkest background; stats.limitingMagnitude, the global adaptation's limit,
// when absent). Every star below the cut is
// binned into an order-8 HEALPix map and drawn as extended light: its light is not lost (thousands of such
// stars are the Milky Way the eye sees), and no star is counted twice. The deep tiles in view are loaded only
// to the prefix that holds every record that can reach the cut (Y ≥ Y_cut / 3, colour margin for v); the
// rest of each tile's light comes from the pipeline's deepRemainder slice for that prefix, so the sky is
// complete whatever is loaded. faintStars (G ≥ 14), the diffuse remainder and the zodiacal light are added on
// the GPU (render/sky/background.ts). Each layer is drawn only if its label is admitted at the reality level.

import type { Label } from '../data/schema';
import type { LoadedData } from '../data/load';
import { DeepTiles, deepTilePattern, gaiaSourceId, httpRangeFetch, loadSkyMaps, type SkyMaps } from '../data/sky';
import { resolveStarLayout } from '../data/stars';
import type { RendererStats, SceneSnapshot, StarCatalog } from '../render/scene';
import { SkyBackground } from '../render/sky/background';
import { npix, pix2vec, vec2pix } from '../render/sky/healpix';
import { AU_KM, earthMeanLongitude, icrfToEcliptic, losBrightness, parseZodiacal, zodiXYZS, type ZodiParams } from '../render/sky/zodiacal';
import { coronaXYZS, cyclePhase, fNear, kBrightness, kFootprintN, parseCorona, poleFromRaDec, type CoronaParams } from '../render/sky/corona';
import { luxFromMagnitude } from '../eye/crumey';
import { PIONEER_STAR_REMOVAL_V_MAG } from '../core/constants';
import { CRUMEY } from '../eye/constants';
import type { RendererPort, Vec3 } from './ports';

/** Points are loaded down to this many magnitudes below the limiting magnitude. */
export const MARGIN_MAG = 0.75;
/** The point cut is quantised to this step and moves only when its target is two steps away (hysteresis). */
const CUT_STEP_MAG = 0.25;
const SP = CRUMEY.spRatioBlackwell;
const BIN_ORDER = 8;
/** Deep-tier records held in memory (48 bytes each) before tiles out of view are evicted, least recently seen first. */
const RECORD_BUDGET = 3_000_000;
const MAX_INFLIGHT = 4;
/** Tiles within this angle beyond the view cone are loaded too (turning the view slowly needs no wait). */
const VIEW_MARGIN_RAD = (5 * Math.PI) / 180;
/** Tiles farther than this beyond the view cone and out of view for FAR_UNLOAD_MS are unloaded even under budget. */
const FAR_MARGIN_RAD = (45 * Math.PI) / 180;
const FAR_UNLOAD_MS = 10_000;

export interface StarPick {
  tier: 'bright' | 'deep';
  /** bright: table row; deep: tile pixel and record. */
  row: number;
  pix?: number;
  dir: Vec3;
  xyzs: [number, number, number, number];
}

export interface StarFacts {
  tier: 'bright' | 'deep';
  name: string | null;
  catalog: string;
  catalogId: string;
  vLike: number;
  xyzs: [number, number, number, number];
  /** ICRS right ascension and declination of the drawn direction, degrees. */
  radecDeg: [number, number];
  labels: { position: Label; flux: Label; colour: Label };
  routes: { position: { label: Label; sources: string[]; method: string } | null; light: { label: Label; sources: string[]; method: string } | null };
  flags: string[];
  sources: string[];
}

export interface SkyStats {
  cutMag: number;
  pointsBright: number;
  pointsDeep: number;
  binnedBright: number;
  binnedDeep: number;
  tilesLoaded: number;
  tilesInView: number;
  deepRecords: number;
  deepMiB: number;
  pendingTiles: number;
  mapsLoaded: boolean;
  layers: Record<string, boolean>;
  rebuilds: number;
  /** CPU time of the last rebuild (split, binning, point upload), ms. */
  rebuildMs: number;
}

type Allowed = (l: Label) => boolean;

export class SkyController {
  readonly tiles: DeepTiles | null;
  private maps: SkyMaps | null = null;
  private mapsPromise: Promise<void> | null = null;
  private bg: SkyBackground | null = null;
  private cutMag = NaN;
  private dirty = true;
  private lastRebuild = 0;
  private inflight = new Set<number>();
  private queue: { pix: number; count: number; prio: number }[] = [];
  private lastUse = new Map<number, number>();
  private lastSeenMs = new Map<number, number>();
  private frame = 0;
  private waiters: (() => void)[] = [];
  private allowed: Allowed;
  private levelKey = '';
  // bright tier, per reality level: rows admitted, their v and bin pixel
  private bright: { rows: Int32Array; v: Float32Array; pix: Uint32Array; star: Float32Array } | null = null;
  private points: { tier: 'bright' | 'deep'; row: number; pix: number }[] = [];
  private pointData: Float32Array = new Float32Array(0);
  private lastMap: Float32Array | null = null;
  private lastLevels: Uint32Array | null = null;
  private lastSnap: SceneSnapshot | null = null;
  private zodi: ZodiParams | null = null;
  private corona: CoronaParams | null = null;
  /** Debug: upload only one tier's point stars (background unchanged), to count stars drawn per tier. */
  debugTier: 'all' | 'bright' | 'deep' = 'all';
  readonly stats: SkyStats = { cutMag: NaN, pointsBright: 0, pointsDeep: 0, binnedBright: 0, binnedDeep: 0, tilesLoaded: 0, tilesInView: 0, deepRecords: 0, deepMiB: 0, pendingTiles: 0, mapsLoaded: false, layers: {}, rebuilds: 0, rebuildMs: 0 };

  constructor(
    private readonly data: LoadedData,
    private readonly renderer: RendererPort,
    base: string,
    allowed: Allowed,
    fetchFn?: (url: string, init?: RequestInit) => Promise<Response>,
  ) {
    this.allowed = allowed;
    const deep = data.sky?.deep ?? null;
    this.tiles = deep ? new DeepTiles(deep, base, httpRangeFetch(fetchFn), () => { this.dirty = true; }) : null;
  }

  /** GPU background counters (composes, zodiacal updates, cube size), for the HUD / scripts. */
  get backgroundStats(): { composes: number; zodiUpdates: number; cubeSize: number } | null {
    return this.bg ? { ...this.bg.stats } : null;
  }

  /** Re-run the split now (e.g. after changing debugTier). */
  invalidate(): void {
    this.dirty = true;
  }

  /** The reality level changed: re-filter everything. */
  setAllowed(allowed: Allowed): void {
    this.allowed = allowed;
    this.bright = null;
    this.dirty = true;
  }

  /** Start fetching the map binaries (after the first frame). */
  startMaps(): Promise<void> {
    if (this.mapsPromise) return this.mapsPromise;
    const L = this.data.loader;
    const maps = this.data.sky?.maps;
    this.mapsPromise = (async () => {
      if (L && maps) this.maps = await loadSkyMaps(L, maps);
      this.createBackground();
      this.stats.mapsLoaded = true;
      this.dirty = true;
    })().catch((e) => { console.error(e); });
    return this.mapsPromise;
  }

  private createBackground(): void {
    const dev = this.renderer.gpuDevice;
    if (!dev || !this.renderer.setBackground) return;
    let zodi = null;
    try {
      zodi = this.data.sky?.zodiacal ? parseZodiacal(this.data.sky.zodiacal) : null;
    } catch (e) {
      console.error(e);
    }
    this.zodi = zodi;
    // the corona needs the Sun's rotation pole (heliographic latitudes): bodies.json, Sun (IAU, constant for the Sun)
    let corona: CoronaParams | null = null;
    try {
      const rot = this.data.bodies.find((b) => b.id === 10)?.rotation?.value;
      if (this.data.sky?.corona && rot) corona = parseCorona(this.data.sky.corona, poleFromRaDec(rot.poleRa[0], rot.poleDec[0]));
    } catch (e) {
      console.error(e);
    }
    this.corona = corona;
    const order = this.data.sky?.deep?.tiling.order ?? 3;
    // A software adapter (SwiftShader, headless tests) composes a 256² cube (0.35° texels) instead of 512² (0.18°).
    const info = (dev as unknown as { adapterInfo?: { vendor?: string; architecture?: string; description?: string } }).adapterInfo;
    const soft = !!info && /swiftshader|llvmpipe|software/i.test(`${info.vendor} ${info.architecture} ${info.description}`);
    this.bg = new SkyBackground(dev, { faint: this.maps?.faint ?? null, diffuse: this.maps?.diffuse ?? null, remainder: this.maps?.remainder ?? null, tileOrder: order }, zodi, soft ? 256 : 512, corona);
    this.renderer.setBackground(this.bg);
  }

  /** Called once per frame before renderer.render(s). */
  beforeFrame(s: SceneSnapshot, rs: RendererStats | null): void {
    this.frame++;
    this.lastSnap = s;
    // Stars are culled against their own background (docs/eye-model.md §2 "Fixations"), so the cut follows the
    // darkest background in the frame, not the global adaptation (a bright planet in view would hide them all).
    const lim = rs?.pointLimitingMagnitude ?? rs?.limitingMagnitude;
    const target = Math.round(((Number.isFinite(lim) ? lim! : 6.5) + MARGIN_MAG) / CUT_STEP_MAG) * CUT_STEP_MAG;
    if (!Number.isFinite(this.cutMag) || Math.abs(target - this.cutMag) >= CUT_STEP_MAG * 2 - 1e-9) {
      this.cutMag = target;
      this.dirty = true;
    }
    this.stats.cutMag = this.cutMag;
    this.planTiles(s);
    this.pump();
    const now = performance.now();
    // Rebuild once the tile loads of this view are in (or every 3 s while they stream): each rebuild re-uploads
    // the points and recomposes the sky cube.
    if (this.dirty && ((this.inflight.size === 0 && this.queue.length === 0) || now - this.lastRebuild > 3000)) this.rebuild();
    this.updateLayers();
    if (this.idleNow()) { const w = this.waiters; this.waiters = []; w.forEach((f) => f()); }
  }

  /**
   * Cut the points afresh at the renderer's current limit, without the hysteresis beforeFrame applies while the view
   * changes: a settled frame then does not depend on the limits the loading frames passed through. True when the cut
   * changed (the points are rebuilt on the next frame).
   */
  settleCut(rs: RendererStats | null): boolean {
    const lim = rs?.pointLimitingMagnitude ?? rs?.limitingMagnitude;
    const target = Math.round(((Number.isFinite(lim) ? lim! : 6.5) + MARGIN_MAG) / CUT_STEP_MAG) * CUT_STEP_MAG;
    if (target === this.cutMag) return false;
    this.cutMag = target;
    this.stats.cutMag = target;
    this.dirty = true;
    return true;
  }

  /** Resolves when the maps are in, every tile the view needs is loaded, and the result is uploaded. */
  idle(): Promise<void> {
    if (this.idleNow()) return Promise.resolve();
    return new Promise((res) => this.waiters.push(res));
  }

  private idleNow(): boolean {
    return (!this.data.sky?.maps || this.stats.mapsLoaded) && this.queue.length === 0 && this.inflight.size === 0 && !this.dirty && !(this.bg?.pending ?? false);
  }

  private yCut(): number {
    return luxFromMagnitude(this.cutMag);
  }

  // ---- tiles --------------------------------------------------------------------------------------

  private planTiles(s: SceneSnapshot): void {
    const T = this.tiles;
    if (!T || !Number.isFinite(this.cutMag)) return;
    const h = T.header;
    const o = s.camera.orient;
    const fwd: Vec3 = [-o[2], -o[5], -o[8]];
    const tanY = Math.tan(s.camera.fovY / 2);
    const tanX = (tanY * s.camera.width) / Math.max(1, s.camera.height);
    const half = Math.atan(Math.hypot(tanX, tanY));
    const yc = this.yCut();
    const want: { pix: number; count: number; prio: number }[] = [];
    let inView = 0;
    const now = performance.now();
    h.tiles.forEach((t, pix) => {
      const c = t.center;
      const ang = Math.acos(Math.max(-1, Math.min(1, c[0] * fwd[0] + c[1] * fwd[1] + c[2] * fwd[2])));
      const edge = half + (t.radiusDeg * Math.PI) / 180;
      if (ang > edge + VIEW_MARGIN_RAD) {
        // far out of view for a while: unload (its light returns to deepRemainder slice 0 at the next rebuild)
        if (ang > edge + FAR_MARGIN_RAD && T.get(pix) && !this.inflight.has(pix) && now - (this.lastSeenMs.get(pix) ?? 0) > FAR_UNLOAD_MS) {
          T.evict(pix);
          this.dirty = true;
        }
        return;
      }
      inView++;
      this.lastUse.set(pix, this.frame);
      this.lastSeenMs.set(pix, now);
      const count = neededCount(t, h.tiling.prefixY, yc);
      const have = T.get(pix)?.count ?? 0;
      if (count > have && !this.inflight.has(pix)) want.push({ pix, count, prio: ang });
    });
    this.stats.tilesInView = inView;
    want.sort((a, b) => a.prio - b.prio);
    this.queue = want;
  }

  private pump(): void {
    const T = this.tiles;
    if (!T) return;
    while (this.inflight.size < MAX_INFLIGHT && this.queue.length) {
      const job = this.queue.shift()!;
      if (this.inflight.has(job.pix)) continue;
      this.inflight.add(job.pix);
      // Each completion starts the next queued read, so streaming does not wait for frames (a slow frame, e.g. on
      // a software adapter, would otherwise admit only MAX_INFLIGHT tiles per frame).
      T.ensure(job.pix, job.count).then(
        () => { this.inflight.delete(job.pix); this.evict(); this.dirty = true; this.pump(); },
        (e) => { this.inflight.delete(job.pix); T.failures++; console.error(e); this.pump(); },
      );
    }
    this.stats.pendingTiles = this.queue.length + this.inflight.size;
    this.reportTiles();
  }

  private evict(): void {
    const T = this.tiles!;
    if (T.records() <= RECORD_BUDGET) return;
    const lru = T.loaded().map((t) => t.pix).filter((p) => (this.lastUse.get(p) ?? 0) < this.frame).sort((a, b) => (this.lastUse.get(a) ?? 0) - (this.lastUse.get(b) ?? 0));
    for (const p of lru) {
      if (T.records() <= RECORD_BUDGET * 0.8) break;
      T.evict(p);
    }
  }

  private reportTiles(): void {
    const T = this.tiles;
    const L = this.data.loader;
    if (!T || !L) return;
    const loaded = T.loaded();
    const changed = loaded.length !== this.stats.tilesLoaded || T.records() !== this.stats.deepRecords;
    this.stats.tilesLoaded = loaded.length;
    this.stats.deepRecords = T.records();
    this.stats.deepMiB = T.fetchedBytes / 2 ** 20;
    if (changed) {
      const h = T.header;
      L.setReport(deepTilePattern(h), {
        status: 'on-demand',
        bytes: h.tiles.reduce((a, t) => a + t.count * h.stride, 0),
        message: `${h.tiles.length} tiles, ${h.count.toLocaleString('en')} stars; ${loaded.length} tiles in memory (${T.records().toLocaleString('en')} stars, brightest-first prefixes), ${this.stats.deepMiB.toFixed(1)} MiB fetched by HTTP range${T.failures ? `, ${T.failures} failed fetches` : ''}. Ranges are size-checked; tile sha256s are not verified (tiles are read in prefixes).`,
      });
    }
  }

  // ---- rebuild: points + binned background --------------------------------------------------------

  private brightRows(): NonNullable<SkyController['bright']> | null {
    const st = this.data.stars;
    if (!st) return null;
    if (this.bright) return this.bright;
    const t = st.table;
    const lay = resolveStarLayout(t);
    const lf = t.labelFields();
    const rows: number[] = [];
    for (let i = 0; i < t.count; i++) {
      let ok = true;
      for (const f of lf) if (!this.allowed(t.label(f, i))) { ok = false; break; }
      if (ok) rows.push(i);
    }
    const n = rows.length;
    const star = new Float32Array(n * 7);
    const v = new Float32Array(n);
    const pix = new Uint32Array(n);
    rows.forEach((r, k) => {
      for (let j = 0; j < 7; j++) star[k * 7 + j] = lay.get[j](r);
      v[k] = Math.max(star[k * 7 + 4], star[k * 7 + 6] / SP);
      pix[k] = vec2pix(BIN_ORDER, [star[k * 7], star[k * 7 + 1], star[k * 7 + 2]]);
    });
    this.bright = { rows: Int32Array.from(rows), v, pix, star };
    return this.bright;
  }

  private rebuild(): void {
    this.dirty = false;
    const t0 = performance.now();
    this.lastRebuild = t0;
    this.stats.rebuilds++;
    // Without the GPU background nothing can show binned light: every star stays a point (the M1 behaviour).
    const yc = this.bg ? this.yCut() : 0;
    const nb = npix(BIN_ORDER);
    const om = (4 * Math.PI) / nb;
    const map = new Float32Array(nb * 4);
    const pts: number[] = [];
    const idx: { tier: 'bright' | 'deep'; row: number; pix: number }[] = [];
    let pb = 0, pd = 0, bb = 0, bd = 0;
    const b = this.brightRows();
    if (b) {
      for (let k = 0; k < b.v.length; k++) {
        const s = b.star.subarray(k * 7, k * 7 + 7);
        if (b.v[k] >= yc) { for (let j = 0; j < 7; j++) pts.push(s[j]); idx.push({ tier: 'bright', row: b.rows[k], pix: -1 }); pb++; }
        else { const p = b.pix[k] * 4; for (let j = 0; j < 4; j++) map[p + j] += s[3 + j] / om; bb++; }
      }
    }
    const T = this.tiles;
    const levels = new Uint32Array(T ? T.header.tiles.length : 1);
    if (T) {
      const pc = T.header.tiles;
      for (const tile of T.loaded()) {
        const meta = pc[tile.pix];
        levels[tile.pix] = tile.count >= meta.count ? 4 : Math.max(0, meta.prefixCounts.findIndex((c) => c === tile.count) + 1);
        for (let i = 0; i < tile.count; i++) {
          if (!this.allowed(T.label(tile.labels[i * 3])) || !this.allowed(T.label(tile.labels[i * 3 + 1])) || !this.allowed(T.label(tile.labels[i * 3 + 2]))) continue;
          const s = tile.stars.subarray(i * 7, i * 7 + 7);
          const v = Math.max(s[4], s[6] / SP);
          if (v >= yc) { for (let j = 0; j < 7; j++) pts.push(s[j]); idx.push({ tier: 'deep', row: i, pix: tile.pix }); pd++; }
          else { const p = vec2pix(BIN_ORDER, [s[0], s[1], s[2]]) * 4; for (let j = 0; j < 4; j++) map[p + j] += s[3 + j] / om; bd++; }
        }
      }
    }
    this.pointData = new Float32Array(pts);
    this.points = idx;
    let cat: StarCatalog = { count: idx.length, data: this.pointData, stride: 7 };
    if (this.debugTier !== 'all') {
      const keep = idx.map((p, k) => (p.tier === this.debugTier ? k : -1)).filter((k) => k >= 0);
      const sub = new Float32Array(keep.length * 7);
      keep.forEach((k, j) => sub.set(this.pointData.subarray(k * 7, k * 7 + 7), j * 7));
      cat = { count: keep.length, data: sub, stride: 7 };
    }
    this.renderer.setStars(cat);
    this.bg?.setDynamic(map, levels);
    this.lastMap = map;
    this.lastLevels = levels;
    Object.assign(this.stats, { pointsBright: pb, pointsDeep: pd, binnedBright: bb, binnedDeep: bd, rebuildMs: performance.now() - t0 });
  }

  private updateLayers(): void {
    const bg = this.bg;
    const maps = this.data.sky?.maps;
    if (!bg || !maps) return;
    const key = String(['faintStars', 'diffuse', 'deepRemainder'].map((k) => this.allowed(maps.layers[k]?.label ?? 'unknown')));
    const zl = this.data.sky?.zodiacal?.scattering.label ?? 'unknown';
    const zOn = this.allowed(zl);
    const cor = this.data.sky?.corona;
    const kOn = !!cor && this.allowed(cor.kCorona.label), fOn = !!cor && this.allowed(cor.fCorona.label);
    if (key + zOn + kOn + fOn === this.levelKey) return;
    this.levelKey = key + zOn + kOn + fOn;
    const on = key.split(',').map((x) => x === 'true');
    bg.setLayers({ faint: on[0], diffuse: on[1], remainder: on[2] });
    bg.showZodiacal = zOn;
    bg.showCoronaK = kOn;
    bg.showCoronaF = fOn;
    this.stats.layers = { faintStars: on[0], diffuse: on[1], deepRemainder: on[2], zodiacal: zOn, kCorona: kOn, fCorona: fOn };
  }

  // ---- probes (CPU twin of the GPU background, for verification) ----------------------------------

  /**
   * Sky-background radiance toward (RA, Dec) in degrees, per component (XYZS, cd/m² and scotopic cd/m²), from the
   * same inputs the GPU composes (nearest pixel, no disc average) plus the zodiacal light for the current observer.
   */
  probe(raDeg: number, decDeg: number, radiusDeg = 0): Record<string, number[]> {
    const r = (raDeg * Math.PI) / 180, dd = (decDeg * Math.PI) / 180;
    const d: Vec3 = [Math.cos(dd) * Math.cos(r), Math.cos(dd) * Math.sin(r), Math.sin(dd)];
    // directions averaged: the centre, or every order-8 pixel centre within radiusDeg (equal-area pixels)
    const dirs: Vec3[] = [];
    if (radiusDeg > 0) {
      const c = Math.cos((radiusDeg * Math.PI) / 180);
      for (let p = 0; p < npix(BIN_ORDER); p++) { const v = pix2vec(BIN_ORDER, p); if (v[0] * d[0] + v[1] * d[1] + v[2] * d[2] >= c) dirs.push(v); }
    } else dirs.push(d);
    const tOrder = this.data.sky?.deep?.tiling.order ?? 3;
    const avg = (f: (v: Vec3) => number[]) => {
      const a = [0, 0, 0, 0];
      for (const v of dirs) { const x = f(v); for (let k = 0; k < 4; k++) a[k] += x[k] / dirs.length; }
      return a;
    };
    const at = (m: Float32Array | null | undefined, order: number, v: Vec3, slice = 0) => {
      if (!m) return [0, 0, 0, 0];
      const p = vec2pix(order, v) + slice * npix(order);
      return [m[p * 4], m[p * 4 + 1], m[p * 4 + 2], m[p * 4 + 3]];
    };
    const out: Record<string, number[]> = {};
    const on = this.stats.layers;
    out.faintStars = on.faintStars ? avg((v) => at(this.maps?.faint, 8, v)) : [0, 0, 0, 0];
    out.diffuse = on.diffuse ? avg((v) => at(this.maps?.diffuse, 6, v)) : [0, 0, 0, 0];
    const lvlOf = (v: Vec3) => (this.lastLevels ? this.lastLevels[vec2pix(tOrder, v)] ?? 0 : 0);
    const lvl = lvlOf(d);
    out.deepRemainder = on.deepRemainder ? avg((v) => (lvlOf(v) < 4 ? at(this.maps?.remainder, 7, v, lvlOf(v)) : [0, 0, 0, 0])) : [0, 0, 0, 0];
    out.binnedStars = avg((v) => at(this.lastMap, BIN_ORDER, v));
    // points drawn in the cap (their light, as radiance over the cap): not background, but what the eye integrates
    if (radiusDeg > 0) {
      const c = Math.cos((radiusDeg * Math.PI) / 180);
      const om = 2 * Math.PI * (1 - c);
      const pd = this.pointData;
      const a = [0, 0, 0, 0];
      // the same for points fainter than V = 6.5 only (Leinert Table 34 removes the brighter stars)
      const a65 = [0, 0, 0, 0];
      const y65 = luxFromMagnitude(PIONEER_STAR_REMOVAL_V_MAG);
      for (let k = 0; k < this.points.length; k++) {
        if (pd[k * 7] * d[0] + pd[k * 7 + 1] * d[1] + pd[k * 7 + 2] * d[2] < c) continue;
        for (let j = 0; j < 4; j++) a[j] += pd[k * 7 + 3 + j] / om;
        if (pd[k * 7 + 4] < y65) for (let j = 0; j < 4; j++) a65[j] += pd[k * 7 + 3 + j] / om;
      }
      out.pointStarsInCap = a;
      out.pointStarsV65InCap = a65;
    }
    out.zodiacal = [0, 0, 0, 0];
    out.kCorona = [0, 0, 0, 0];
    out.fCorona = [0, 0, 0, 0];
    const s = this.lastSnap;
    // the F-corona law replaces the zodiacal model near the Sun with weight b (render/sky/corona.ts fNear)
    let fw = 0;
    if (this.corona && s?.sun) {
      const c = this.corona;
      const o: [number, number, number] = [-s.sun.pos[0] / s.sun.radius, -s.sun.pos[1] / s.sun.radius, -s.sun.pos[2] / s.sun.radius];
      if (on.kCorona) out.kCorona = coronaXYZS(c, kBrightness(c, o, d, cyclePhase(c, s.et)), 0);
      if (on.fCorona) {
        const [bF, w] = fNear(c, o, d);
        fw = w;
        out.fCorona = coronaXYZS(c, 0, bF).map((x) => x * w);
      }
    }
    if (this.zodi && on.zodiacal && s?.sun) {
      const oI = [-s.sun.pos[0] / AU_KM, -s.sun.pos[1] / AU_KM, -s.sun.pos[2] / AU_KM];
      const I = losBrightness(this.zodi, icrfToEcliptic(oI), icrfToEcliptic(d), earthMeanLongitude(s.et));
      const n = Math.hypot(oI[0], oI[1], oI[2]);
      const eps = Math.acos(Math.max(-1, Math.min(1, -(oI[0] * d[0] + oI[1] * d[1] + oI[2] * d[2]) / n)));
      out.zodiacal = zodiXYZS(this.zodi, I, eps).map((x) => x * (1 - fw));
    }
    out.background = [0, 1, 2, 3].map((k) => ['faintStars', 'diffuse', 'deepRemainder', 'binnedStars', 'zodiacal', 'kCorona', 'fCorona'].reduce((a, n) => a + out[n][k], 0));
    out.level = [lvl];
    out.pixels = [dirs.length];
    return out;
  }

  /**
   * Debug: the GPU cube (hardware cube sampling at mip `lod`) against the CPU composition (probe without zodiacal
   * light, averaged over a cap of `capDeg`; at LOD 0 the footprints differ — a texel's disc vs the cap — so single
   * binned stars make differences; at a coarse LOD with a matching cap only the large-scale flux is compared).
   */
  async checkCube(radec: [number, number][], lod = 0, capDeg = 0.5): Promise<{ ra: number; dec: number; gpuY: number; cpuY: number }[]> {
    if (!this.bg) return [];
    const dirs = radec.map(([ra, dec]) => {
      const r = (ra * Math.PI) / 180, d = (dec * Math.PI) / 180;
      return [Math.cos(d) * Math.cos(r), Math.cos(d) * Math.sin(r), Math.sin(d)] as [number, number, number];
    });
    const g = await this.bg.sampleCube(dirs, lod);
    return radec.map(([ra, dec], i) => {
      const p = this.probe(ra, dec, capDeg);
      return { ra, dec, gpuY: g[i][1], cpuY: p.background[1] - p.zodiacal[1] };
    });
  }

  /**
   * Debug: the GPU zodiacal grid against the CPU twin (render/sky/zodiacal.ts) at a few grid points of the
   * current view: [{ px, py, gpuY, cpuY }] (cd/m²).
   */
  async checkZodiacal(): Promise<{ px: number; py: number; gpuY: number; cpuY: number }[]> {
    const g = await this.bg?.readZodi();
    const s = this.lastSnap;
    if (!g || !s || !s.sun || !this.zodi) return [];
    const W = s.camera.width, H = s.camera.height;
    const tanY = Math.tan(s.camera.fovY / 2), tanX = (tanY * W) / H;
    const o = s.camera.orient;
    const oI = [-s.sun.pos[0] / AU_KM, -s.sun.pos[1] / AU_KM, -s.sun.pos[2] / AU_KM];
    const n = Math.hypot(oI[0], oI[1], oI[2]);
    const out: { px: number; py: number; gpuY: number; cpuY: number }[] = [];
    for (const [fx, fy] of [[0.5, 0.5], [0.1, 0.1], [0.9, 0.2], [0.3, 0.8], [0.75, 0.6]]) {
      const i = Math.round(fx * (g.w - 1)), j = Math.round(fy * (g.h - 1));
      const px = i * 16, py = j * 16;
      const ndx = (px / W) * 2 - 1, ndy = 1 - (py / H) * 2;
      const c = [ndx * tanX, ndy * tanY, -1];
      const d = [o[0] * c[0] + o[1] * c[1] + o[2] * c[2], o[3] * c[0] + o[4] * c[1] + o[5] * c[2], o[6] * c[0] + o[7] * c[1] + o[8] * c[2]];
      const dn = Math.hypot(d[0], d[1], d[2]);
      const u = [d[0] / dn, d[1] / dn, d[2] / dn];
      const I = losBrightness(this.zodi, icrfToEcliptic(oI), icrfToEcliptic(u), earthMeanLongitude(s.et));
      const eps = Math.acos(Math.max(-1, Math.min(1, -(oI[0] * u[0] + oI[1] * u[1] + oI[2] * u[2]) / n)));
      out.push({ px, py, gpuY: g.data[(j * g.w + i) * 4 + 1], cpuY: zodiXYZS(this.zodi, I, eps)[1] });
    }
    return out;
  }

  /**
   * Debug: the GPU K-corona texture against the CPU twin (render/sky/corona.ts) at pixels rho solar radii from the
   * Sun's centre along the screen's +x axis: [{ rho, px, py, gpuY, cpuY }] (cd/m²). Empty when the Sun is off screen.
   */
  async checkCorona(): Promise<{ rho: number; px: number; py: number; gpuY: number; cpuY: number }[]> {
    const s = this.lastSnap;
    const c = this.corona;
    if (!s || !s.sun || !c || !this.bg) return [];
    const W = s.camera.width, H = s.camera.height;
    const tanY = Math.tan(s.camera.fovY / 2), tanX = (tanY * W) / H;
    const o = s.camera.orient;
    const D = Math.hypot(s.sun.pos[0], s.sun.pos[1], s.sun.pos[2]);
    const n = s.sun.pos.map((x) => x / D);
    // world -> camera: the transpose of orient (camera -> world, row-major)
    const cam = [0, 1, 2].map((k) => o[k] * n[0] + o[3 + k] * n[1] + o[6 + k] * n[2]);
    if (cam[2] >= 0) return [];
    const sx = ((cam[0] / -cam[2]) / tanX + 1) / 2 * W, sy = (1 - (cam[1] / -cam[2]) / tanY) / 2 * H;
    const pxPerRad = W / 2 / tanX;
    const obs: Vec3 = [-s.sun.pos[0] / s.sun.radius, -s.sun.pos[1] / s.sun.radius, -s.sun.pos[2] / s.sun.radius];
    const P = cyclePhase(c, s.et);
    const pts: { rho: number; px: number; py: number }[] = [];
    for (const rho of [1.1, 1.3, 1.6, 2, 3, 5, 10]) {
      const px = Math.round(sx + Math.asin((rho * s.sun.radius) / D) * pxPerRad), py = Math.round(sy);
      if (px >= 0 && px < W && py >= 0 && py < H) pts.push({ rho, px, py });
    }
    const g = await this.bg.readCoronaK(pts.map((p) => [p.px, p.py]));
    if (!g) return [];
    // The direction through a point of the frame (pixel units, the GPU's convention).
    const dirAt = (fx: number, fy: number): Vec3 => {
      const ndx = (fx / W) * 2 - 1, ndy = 1 - (fy / H) * 2;
      const cc = [ndx * tanX, ndy * tanY, -1];
      const d = [o[0] * cc[0] + o[1] * cc[1] + o[2] * cc[2], o[3] * cc[0] + o[4] * cc[1] + o[5] * cc[2], o[6] * cc[0] + o[7] * cc[1] + o[8] * cc[2]];
      const dn = Math.hypot(d[0], d[1], d[2]);
      return [d[0] / dn, d[1] / dn, d[2] / dn];
    };
    // The Sun shield's disc (render/frame.ts: the solar radius plus a pixel) is left out of the average, as on the GPU.
    const cosShield = s.view.sunShield ? Math.cos(Math.asin(Math.min(1, s.sun.radius / D)) + (2 * tanY) / H) : 2;
    const shielded = (u: Vec3) => u[0] * n[0] + u[1] * n[1] + u[2] * n[2] >= cosShield;
    return pts.map((p, i) => {
      // The same footprint average as the GPU pass (corona.ts kFootprintN).
      const u = dirAt(p.px + 0.5, p.py + 0.5);
      const sca = -(obs[0] * u[0] + obs[1] * u[1] + obs[2] * u[2]);
      const b = Math.hypot(obs[0] + sca * u[0], obs[1] + sca * u[1], obs[2] + sca * u[2]);
      const u1 = dirAt(p.px + 1.5, p.py + 0.5);
      const pxR = Math.hypot(u1[0] - u[0], u1[1] - u[1], u1[2] - u[2]) * Math.max(sca, 0);
      const nf = kFootprintN(pxR, b, sca > 0);
      let bK = 0;
      for (let j = 0; j < nf; j++) for (let k = 0; k < nf; k++) {
        const us = nf === 1 ? u : dirAt(p.px + (k + 0.5) / nf, p.py + (j + 0.5) / nf);
        if (!shielded(us)) bK += kBrightness(c, obs, us, P);
      }
      return { ...p, gpuY: g[i][1], cpuY: coronaXYZS(c, bK / (nf * nf), 0)[1] };
    });
  }

  // ---- picking ------------------------------------------------------------------------------------

  /** The brightest point star within tolRad of the ray (ICRF unit vector), or null. */
  pickStar(ray: Vec3, tolRad: number): StarPick | null {
    const c = Math.cos(tolRad);
    let best = -1, bestY = -1;
    const d = this.pointData;
    for (let k = 0; k < this.points.length; k++) {
      const dot = d[k * 7] * ray[0] + d[k * 7 + 1] * ray[1] + d[k * 7 + 2] * ray[2];
      if (dot >= c && d[k * 7 + 4] > bestY) { best = k; bestY = d[k * 7 + 4]; }
    }
    if (best < 0) return null;
    const p = this.points[best];
    return { tier: p.tier, row: p.row, pix: p.pix >= 0 ? p.pix : undefined, dir: [d[best * 7], d[best * 7 + 1], d[best * 7 + 2]], xyzs: [d[best * 7 + 3], d[best * 7 + 4], d[best * 7 + 5], d[best * 7 + 6]] };
  }

  /** What is known about a picked star, with its provenance (bright or deep header routes). */
  facts(p: StarPick): StarFacts | null {
    const f = this.factsBase(p);
    if (!f) return null;
    const [x, y, z] = p.dir;
    const ra = (Math.atan2(y, x) * 180) / Math.PI;
    return { ...f, radecDeg: [ra < 0 ? ra + 360 : ra, (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI] };
  }

  private factsBase(p: StarPick): Omit<StarFacts, 'radecDeg'> | null {
    if (p.tier === 'bright') {
      const st = this.data.stars;
      if (!st) return null;
      const t = st.table;
      const hdr = st.header;
      const lab = (n: string) => (t.has(n) ? t.label(n, p.row) : 'unknown');
      const u8 = (n: string) => (t.has(n) ? t.column(n).get(p.row) : -1);
      const src = hdr.sourceTable?.[u8('src')] ?? '?';
      const cat = t.has('catId') ? [t.column('catId').get(p.row, 0), t.column('catId').get(p.row, 1)] : [0, 0];
      const hip = t.has('hip') ? t.column('hip').get(p.row) : 0;
      const catalogId = /gaia/.test(src) ? `Gaia DR3 ${gaiaSourceId(cat[0], cat[1])}` : /tycho/.test(src) ? `TYC ${cat[0] >>> 17}-${(cat[0] >>> 3) & 0x3fff}-${cat[0] & 7}` : `HIP ${cat[0]}`;
      // proper name first, then Bayer, then Flamsteed (names.json order is not kept by the name index)
      const rank = (n: string) => (/^\d+ /.test(n) ? 2 : /^[Ͱ-Ͽ]/.test(n) ? 1 : 0);
      const names = this.data.starNames.filter((n) => n.index === p.row && !/^HIP \d+$/.test(n.name)).map((n) => n.name).sort((a, b) => rank(a) - rank(b));
      const name = names.length ? names.join(' · ') : null;
      return this.factsOf('bright', name, src, catalogId + (hip && !/^HIP/.test(catalogId) ? ` · HIP ${hip}` : ''), p.xyzs,
        { position: lab('labelPos'), flux: lab('labelFlux'), colour: lab('labelColor') }, hdr, u8('posRoute'), u8('lightRoute'), u8('flags'));
    }
    const T = this.tiles;
    const tile = T && p.pix !== undefined ? T.get(p.pix) : undefined;
    if (!T || !tile) return null;
    const i = p.row;
    const hdr = T.header;
    return this.factsOf('deep', null, hdr.sourceTable?.[0] ?? 'gaia', `Gaia DR3 ${gaiaSourceId(tile.catId[i * 2], tile.catId[i * 2 + 1])}`, p.xyzs,
      { position: T.label(tile.labels[i * 3]), flux: T.label(tile.labels[i * 3 + 1]), colour: T.label(tile.labels[i * 3 + 2]) }, hdr, tile.routes[i * 2], tile.routes[i * 2 + 1], tile.flags[i]);
  }

  private factsOf(tier: 'bright' | 'deep', name: string | null, catalog: string, catalogId: string, xyzs: [number, number, number, number],
    labels: StarFacts['labels'], hdr: { routes?: Record<string, { label: Label; sources: string[]; method: string }[]>; flagBits?: Record<string, string> }, posRoute: number, lightRoute: number, flags: number): Omit<StarFacts, 'radecDeg'> {
    const r = hdr.routes ?? {};
    const pos = r.pos?.[posRoute] ?? null;
    const light = r.light?.[lightRoute] ?? null;
    const fl = Object.entries(hdr.flagBits ?? {}).filter(([k]) => /^\d+$/.test(k) && (flags & Number(k)) !== 0).map(([, v]) => v);
    const sources = [...new Set([...(pos?.sources ?? []), ...(light?.sources ?? [])])];
    return { tier, name, catalog, catalogId, vLike: -2.5 * Math.log10(xyzs[1] / CRUMEY.zeroPointVLux), xyzs, labels, routes: { position: pos, light }, flags: fl, sources };
  }
}

/** Records of a tile needed so that every star with v ≥ yCut is loaded (0 = none). */
export function neededCount(t: { count: number; yMax: number | null; prefixCounts: number[] }, prefixY: number[], yCut: number): number {
  if (t.yMax === null || t.count === 0) return 0;
  // v ≤ 3 Y for the bluest stars (S/Y ≲ 4, S/1.408): records with Y < yCut/3 can never reach the cut.
  if (t.yMax < yCut / 3) return 0;
  for (let k = 0; k < prefixY.length; k++) if (prefixY[k] <= yCut / 3) return t.prefixCounts[k];
  return t.count;
}

/** One line for the Data panel. */
export function skySummary(sky: SkyController): string {
  const s = sky.stats;
  const layers = Object.entries(s.layers).map(([k, on]) => `${k} ${on ? 'on' : 'off'}`).join(', ');
  return `points to V≈${Number.isFinite(s.cutMag) ? s.cutMag.toFixed(2) : '—'}: ${s.pointsBright.toLocaleString('en')} bright + ${s.pointsDeep.toLocaleString('en')} deep; ` +
    `below the cut, as sky light: ${s.binnedBright.toLocaleString('en')} bright + ${s.binnedDeep.toLocaleString('en')} deep; ` +
    `deep tiles ${s.tilesLoaded} loaded (${s.deepRecords.toLocaleString('en')} stars, ${s.deepMiB.toFixed(1)} MiB fetched), ${s.tilesInView} in view, ${s.pendingTiles} pending` +
    (s.mapsLoaded ? `; layers: ${layers || 'none'}` : '; sky maps loading');
}

/**
 * Click a star: when a click hits no body (pickBody), the brightest point star within 6 px of it opens the star
 * card. Listens on the canvas itself (ui/input.ts is untouched); a drag is not a click.
 */
export function attachStarPicking(
  canvas: HTMLElement,
  sky: SkyController,
  pickBody: (x: number, y: number) => Promise<number | null>,
  camera: () => { orient: number[]; fovY: number } | null,
  show: (f: StarFacts | null) => void,
): () => void {
  let down: [number, number] | null = null;
  const onDown = (e: PointerEvent) => { down = [e.clientX, e.clientY]; };
  const onUp = (e: PointerEvent) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 3) { down = null; return; }
    down = null;
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    void pickBody(x, y).then((id) => {
      if (id !== null) { show(null); return; }
      const cam = camera();
      if (!cam) return;
      const t = Math.tan(cam.fovY / 2);
      const cx = ((2 * x) / r.width - 1) * t * (r.width / r.height);
      const cy = (1 - (2 * y) / r.height) * t;
      const o = cam.orient;
      const d = [o[0] * cx + o[1] * cy - o[2], o[3] * cx + o[4] * cy - o[5], o[6] * cx + o[7] * cy - o[8]];
      const n = Math.hypot(d[0], d[1], d[2]);
      const p = sky.pickStar([d[0] / n, d[1] / n, d[2] / n], (6 * 2 * t) / r.height);
      show(p ? sky.facts(p) : null);
    });
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);
  return () => { canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointerup', onUp); };
}
