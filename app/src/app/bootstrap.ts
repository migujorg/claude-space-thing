// startApp(): the full wiring of data → model → renderer → UI. main.ts only injects the real core/
// and render/ implementations (see AppDeps in ports.ts).
//
// Screenshot contract (docs/architecture.md §5.4): window.__frameReady = true once the initial view
// (URL parameters applied, data loaded) has been rendered AND renderer.settled() has resolved;
// window.__frameError is set instead if startup fails. window.__app is the scripting/debug API.

import { loadAll } from '../data/load';
import type { SceneSnapshot } from '../render/scene';
import { mountUi, type Ui } from '../ui/index';
import { AppModel } from './model';
import type { AppDeps, RendererPort } from './ports';
import { formatUrlParams, parseUrlParams } from './url';

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
    const data = await loadAll({
      fetch: deps.fetch ?? ((u: string) => fetch(u)),
      base: deps.dataBaseUrl ?? `${import.meta.env.BASE_URL}data/`,
      verifyHashes: deps.verifyHashes,
    });
    model.setData(data);
    ui.status(null);
    const missing = data.report.products.filter((p) => p.status === 'missing' || p.status === 'error');
    if (missing.length) model.message(`${missing.length} data product${missing.length > 1 ? 's' : ''} missing or unusable — see Data (M).`, 'warn');

    sizeViewport();
    const { view, errors } = parseUrlParams(deps.search ?? location.search);
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

    // Initial frame, then declare readiness once the GPU has finished it.
    const snap = model.frame(0, null);
    renderer?.render(snap);
    ui.update(0, renderer?.stats ?? null);
    if (renderer) await renderer.settled();
    if (!window.__frameError) window.__frameReady = true;

    let last = performance.now();
    const loop = (t: number) => {
      if (!running) return;
      const dt = Math.max(0, (t - last) / 1000);
      last = t;
      const fly = input.flyInput(Math.min(dt, 0.1));
      const s = model.frame(dt, fly);
      renderer?.render(s);
      ui.update(dt, renderer?.stats ?? null);
      if (frameWaiters.length) {
        const ws = frameWaiters.splice(0);
        (renderer ? renderer.settled() : Promise.resolve()).then(() => ws.forEach((w) => w()));
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
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
