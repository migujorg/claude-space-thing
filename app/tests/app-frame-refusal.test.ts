import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../src/app/ports';
import type { RendererStats } from '../src/render/scene';
const harness = vi.hoisted(() => {
  const model = {
    clock: { pause: vi.fn() }, on: vi.fn(), emit: vi.fn(), setViewport: vi.fn(), setData: vi.fn(), applyUrl: vi.fn(),
    starCatalog: () => null, reality: { exists: 'best' }, frame: vi.fn(() => ({})), startBackgroundLoading: vi.fn(),
    systemsIdle: async () => {}, urlTargetSettled: async () => {}, finishOrbitWork: () => 0, shapesIdle: () => true,
  };
  const ui = { status: vi.fn(), fatal: vi.fn(), started: vi.fn(), update: vi.fn(), attachInput: () => ({ flyInput: () => null }) };
  return { model, ui };
});
vi.mock('../src/app/model', () => ({ AppModel: vi.fn(function () { return harness.model; }) }));
vi.mock('../src/ui/index', () => ({ mountUi: () => harness.ui }));
vi.mock('../src/data/load', () => ({ loadAll: async () => ({ report: { products: [] } }), bodyEphemerisPaths: () => [] }));
import { startApp } from '../src/app/bootstrap';
let tick: FrameRequestCallback;
let resize: () => void;
let width: number;
const stats: RendererStats = { frameMs: 0, adaptationLuminance: 0, starsDrawn: 0, warnings: [] };
const refusal = 'Frame cannot be rendered: requested width exceeds maxTextureDimension2D.';
const render = vi.fn();
let finish: (() => void) | undefined;
const renderer = {
  stats, render, setStars: vi.fn(),
  resize(w: number) { stats.warnings = w > 8192 ? [refusal] : []; if (w > 8192) throw new RangeError(refusal); },
  settled: () => finish ? new Promise<void>((resolve) => { finish = resolve; }) : Promise.resolve(),
  frameDone: () => finish ? new Promise<void>((resolve) => { finish = resolve; }) : Promise.resolve(),
};
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
async function start() {
  const canvas = { getBoundingClientRect: () => ({ width, height: 720 }) } as HTMLCanvasElement;
  const deps = { Renderer: { create: async () => renderer }, search: '', eventCache: null, eventWorker: null } as unknown as AppDeps;
  const app = await startApp(canvas, {} as HTMLElement, deps);
  await flush(); tick(10); await flush(); await app.ready;
  return app;
}
beforeEach(() => {
  width = 1280; finish = undefined; stats.warnings = []; vi.clearAllMocks();
  vi.stubGlobal('window', { devicePixelRatio: 1, addEventListener: vi.fn() });
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback; } observe() {} });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { tick = callback; return 1; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());
describe('app resize refusal', () => {
  it('invalidates the last good frame, skips refused draws and recovers after a supported frame completes', async () => {
    const app = await start(); expect(window.__frameReady).toBe(true);
    width = 8193; expect(() => resize()).not.toThrow();
    expect(window.__frameReady).toBe(false); expect(window.__frameError).toBe(refusal);
    const drawn = render.mock.calls.length;
    const waiter = window.__app!.nextFrame(); tick(20); await waiter;
    expect(render).toHaveBeenCalledTimes(drawn);
    expect(harness.ui.update).toHaveBeenLastCalledWith(expect.any(Number), stats);
    width = 1280; resize(); expect(window.__frameReady).toBe(false); expect(window.__frameError).toBeUndefined();
    finish = () => {}; tick(30);
    expect(render).toHaveBeenCalledTimes(drawn + 1); expect(window.__frameReady).toBe(false);
    finish!(); await flush(); expect(window.__frameReady).toBe(true); app.stop();
  });
  it('does not swallow an unrelated resize failure', async () => {
    const app = await start();
    vi.spyOn(renderer, 'resize').mockImplementationOnce(() => { throw new Error('unrelated failure'); });
    expect(() => resize()).toThrow('unrelated failure'); app.stop(); vi.restoreAllMocks();
  });
  it('does not let an old in-flight frame restore readiness after a refusal or supported resize', async () => {
    const app = await start();
    finish = () => {}; tick(20);
    const oldDone = finish!;
    width = 8193; resize();
    width = 1280; resize();
    oldDone(); await flush();
    expect(window.__frameReady).toBe(false);
    tick(30); finish!(); await flush();
    expect(window.__frameReady).toBe(true);
    app.stop();
  });
  it('does not certify startup at a refused size', async () => {
    width = 8193;
    const app = await start();
    expect(window.__frameReady).toBe(false);
    expect(window.__frameError).toBe(refusal);
    expect(render).not.toHaveBeenCalled();
    width = 1280; resize(); tick(20); await flush();
    expect(window.__frameReady).toBe(true);
    app.stop();
  });
  it('preserves an unrelated frame error through refusal and recovery', async () => {
    const app = await start();
    window.__frameError = 'WebGPU device lost';
    width = 8193; resize();
    width = 1280; resize(); tick(20); await flush();
    expect(window.__frameError).toBe('WebGPU device lost');
    expect(window.__frameReady).toBe(false);
    app.stop();
  });
});
