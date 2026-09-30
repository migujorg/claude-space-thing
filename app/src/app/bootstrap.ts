// startApp(): the full wiring of data → model → renderer → UI. main.ts only injects the real core/
// and render/ implementations (see AppDeps in ports.ts).
//
// Screenshot contract (docs/architecture.md §5.4): window.__frameReady = true once the initial view
// (URL parameters applied, data loaded) has been rendered AND renderer.settled() has resolved;
// window.__frameError is set instead if startup fails. window.__app is the scripting/debug API.

import { bodyEphemerisPaths, loadAll } from '../data/load';
import type { Body } from '../data/schema';
import type { SceneSnapshot } from '../render/scene';
import { mountUi, type Ui } from '../ui/index';
import { AppModel } from './model';
import type { AppDeps, RendererPort } from './ports';
import { formatUrlParams, parseUrlParams, type UrlView } from './url';

export interface AppHandle {
  model: AppModel;
  ui: Ui;
  renderer: RendererPort | null;
  /** Resolves after the first frame has been rendered and settled. */
  ready: Promise<void>;
  stop(): void;
}

export interface DebugApi {
  debugState(): ReturnType<AppModel['debugState']> & { renderer: RendererPort['stats'] | null };
  /** Set the time (ISO-8601 UTC) and pause. Returns an error message or null. */
  setTime(iso: string): string | null;
  select(id: number | null): void;
  /** Travel to a body (animated); resolves when arrived. Pass instant=true to jump. */
  goTo(id: number, dist?: number, instant?: boolean): Promise<void>;
  setReality(patch: Parameters<AppModel['setReality']>[0]): void;
  /** Query string reproducing the current view. */
  url(): string;
  snapshot(): SceneSnapshot | null;
  /** Resolves after the next frame has been rendered and the renderer has settled. */
  nextFrame(): Promise<void>;
  model: AppModel;
}

declare global {
  interface Window {
    __app?: DebugApi;
    __frameReady?: boolean;
    __frameError?: string;
  }
}

/**
 * Which ephemeris files load before the first frame: those every body needs (the planetary file), the URL
 * target's chain, and moon systems named by ?system= ("all" → everything). The rest load in the background.
 */
export function eagerEphemeris(view: UrlView): (path: string, bodies: Body[]) => boolean {
  return (path, bodies) => {
    if (view.system?.includes('all')) return true;
    const physical = bodies.filter((b) => b.kind !== 'barycenter');
    if (physical.length && physical.every((b) => bodyEphemerisPaths(b).includes(path))) return true;
    const target = view.target !== undefined ? bodies.find((b) => b.id === view.target) : undefined;
    if (target && bodyEphemerisPaths(target).includes(path)) return true;
    const key = path.replace(/^ephem\/(sat-)?/, '').replace(/\.json$/, '');
    return !!view.system?.includes(key);
  };
}

export async function startApp(canvas: HTMLCanvasElement, uiRoot: HTMLElement, deps: AppDeps): Promise<AppHandle> {
  window.__frameReady = false;
  const model = new AppModel(deps, { now: deps.now });
  const ui = mountUi(uiRoot, model, { banner: deps.banner });
  let renderer: RendererPort | null = null;
  let running = true;
  let raf = 0;
  const frameWaiters: (() => void)[] = [];

  window.__app = {
    debugState: () => ({ ...model.debugState(), renderer: renderer ? renderer.stats : null }),
    setTime: (iso) => {
      const err = model.setTimeText(iso);
      if (!err) { model.clock.pause(); model.emit('time'); }
      return err;
    },
    select: (id) => model.select(id),
    goTo: (id, dist, instant) => {
      const r = model.goTo(id, dist, { instant });
      return typeof r === 'string' ? Promise.reject(new Error(r)) : r;
    },
    setReality: (p) => model.setReality(p),
    url: () => formatUrlParams(model.currentUrlView()),
    snapshot: () => model.snapshot,
    nextFrame: () => new Promise<void>((res) => frameWaiters.push(res)),
    model,
  };

  const sizeViewport = () => {
    const r = canvas.getBoundingClientRect();
    const w = Math.max(1, r.width || window.innerWidth), hgt = Math.max(1, r.height || window.innerHeight);
    const dpr = window.devicePixelRatio || 1;
    model.setViewport({ width: w, height: hgt, dpr });
    renderer?.resize(w, hgt, dpr);
  };

  const ready = (async () => {
    ui.status('Loading data…');
    const { view, errors } = parseUrlParams(deps.search ?? location.search);
    const data = await loadAll({
      fetch: deps.fetch ?? ((u: string) => fetch(u)),
      base: deps.dataBaseUrl ?? `${import.meta.env.BASE_URL}data/`,
      verifyHashes: deps.verifyHashes,
      eagerEphemeris: eagerEphemeris(view),
    });
    model.setData(data);
    ui.status(null);
    const missing = data.report.products.filter((p) => p.status === 'missing' || p.status === 'error');
    if (missing.length) model.message(`${missing.length} data product${missing.length > 1 ? 's' : ''} missing or unusable — see Data (M).`, 'warn');

    sizeViewport();
    errors.forEach((e) => model.message(e, 'warn'));
    model.applyUrl(view);

    try {
      renderer = await deps.Renderer.create(canvas);
    } catch (e) {
      const msg = `Renderer unavailable: ${(e as Error).message ?? e}`;
      ui.fatal(`${msg}. The data and UI still work; nothing can be drawn.`);
      window.__frameError = msg;
    }
    sizeViewport();
    const pushStars = () => {
      const r = model.starCatalog();
      if (renderer && r) renderer.setStars(r.catalog);
    };
    pushStars();
    let lastLevel = model.reality.exists;
    model.on('reality', () => {
      if (model.reality.exists !== lastLevel) { lastLevel = model.reality.exists; pushStars(); }
    });
    new ResizeObserver(sizeViewport).observe(canvas);
    window.addEventListener('resize', sizeViewport);
    const input = ui.attachInput(canvas);

    // Render loop with backpressure: a new frame is built and submitted only once the GPU has finished the
    // previous one, so a slow GPU (or software rendering) never accumulates a queue of stale frames, and the
    // DOM overlays (labels) always match the image on screen. Simulated time still advances by real time.
    let inFlight = false;
    let last = performance.now();
    const renderFrame = (dt: number, fly: ReturnType<typeof input.flyInput>) => {
      const s = model.frame(dt, fly);
      ui.update(dt, renderer?.stats ?? null);
      const ws = frameWaiters.splice(0);
      if (!renderer) { ws.forEach((w) => w()); return; }
      renderer.render(s);
      inFlight = true;
      renderer.settled().then(
        () => { inFlight = false; ws.forEach((w) => w()); },
        (e) => { inFlight = false; console.error(e); ws.forEach((w) => w()); },
      );
    };
    // Initial frame first (the user sees something at once), then moon systems load in the background.
    renderFrame(0, null);
    model.startBackgroundLoading();
    const loop = (t: number) => {
      if (!running) return;
      raf = requestAnimationFrame(loop);
      if (inFlight) return;
      const dt = Math.max(0, (t - last) / 1000);
      last = t;
      renderFrame(dt, input.flyInput(Math.min(dt, 0.1)));
    };
    raf = requestAnimationFrame(loop);

    // Screenshot contract: ready once everything that could appear in the view is loaded and drawn — every
    // moon system (loaded or failed), all orbit tracks the overlay needs — and the GPU has finished.
    await model.systemsIdle();
    const nextFrame = () => new Promise<void>((res) => frameWaiters.push(res));
    await nextFrame();
    for (let i = 0; i < 600 && model.reality.overlays.orbits && (model.orbits?.stats.pending ?? 0) > 0; i++) await nextFrame();
    if (!window.__frameError) window.__frameReady = true;
  })().catch((e) => {
    console.error(e);
    window.__frameError = String((e as Error)?.stack ?? e);
    ui.fatal(`Startup failed: ${(e as Error).message ?? e}`);
  });

  return {
    model,
    ui,
    get renderer() { return renderer; },
    ready,
    stop() { running = false; cancelAnimationFrame(raf); },
  };
}
