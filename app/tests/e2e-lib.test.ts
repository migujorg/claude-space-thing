import scenesJson from '../e2e/scenes.json';
// The pure parts of the scene regression suite (scripts/e2e-lib.mjs): scene URLs, PNG thumbnails, the lightness
// grid, the comparison rules against a baseline, and the --gpu option's browser arguments and adapter checks.

import { describe, expect, it } from 'vitest';

interface Stats {
  adaptationLuminance: number | null;
  scotopicAdaptationLuminance: number | null;
  pupilDiameterMm: number | null;
  mesopicM: number | null;
  limitingMagnitude: number | null;
  starsDrawn: number | null;
  bodiesDrawn: number;
  bodies: { id: number; name: string; worstLabel: string; surfaceUnknown: boolean }[];
  points: string[];
  sun: boolean;
  warnings: string[];
  badge: string[];
}
interface SceneResult {
  error?: string;
  stats: Stats;
  grid?: number[] | null;
  consoleErrors?: string[];
}
interface Meta {
  acceptedAt: string;
  git: string;
  data: { manifestGeneratedAt: string; manifestSha256: string };
  viewport?: { width: number; height: number };
  gpu?: Gpu;
}
interface Baseline extends Partial<Meta> {
  scenes: Record<string, { query: string; stats: unknown; consoleErrors: string[]; readyMs?: number; accepted?: Partial<Meta> }>;
}
interface Lib {
  sceneQuery(suite: unknown, scene: unknown): string;
  extractStats(debug: unknown): Stats;
  boxLinear(rgba: Uint8Array, w: number, h: number, tw?: number, th?: number): Float64Array;
  thumbFromLinear(lin: Float64Array, tw?: number, th?: number): Uint8Array;
  gridFromThumb(px: Uint8Array, tw?: number, th?: number): number[];
  encodePng(rgba: Uint8Array, w: number, h: number): Uint8Array;
  decodePng(buf: Uint8Array): { width: number; height: number; rgba: Uint8Array };
  compareScene(cur: SceneResult, base: SceneResult | null, tol?: Record<string, number>): { pass: boolean; failures: string[]; notes: string[] };
  statsTable(results: unknown[]): string;
  THUMB_W: number;
  THUMB_H: number;
  GPU_MODES: string[];
  gpuLaunchArgs(mode?: string): string[];
  runServerOptions(): { hmr: boolean; watch: null };
  isSoftwareAdapter(info: Adapter | null): boolean;
  adapterLabel(info: Adapter | null): string;
  gpuMismatch(mode: string, info: Adapter | null): string | null;
  hdrFormatOf(warnings: string[] | undefined): string;
  gpuNote(baselineGpu: Gpu | undefined, gpu: Gpu): string | null;
  mergeBaseline(prev: Baseline | null, results: { id: string; query: string; stats: unknown; consoleErrors?: string[]; readyMs?: number }[], meta: Meta, sceneIds: string[]): Baseline;
  sceneAcceptance(baseline: Baseline | null, id: string): Partial<Meta>;
  acceptanceNotes(baseline: Baseline | null, ids: string[], data: Meta['data'], gpu: Gpu): string[];
  starsFramesNote(values: number[] | undefined, compared: number | null | undefined): string | null;
  starsFramesFailure(values: number[] | undefined, compared: number | null | undefined, query: string | undefined): string | null;
}
interface Adapter { vendor: string; architecture: string; device: string; description: string; fallback: boolean; float32Blendable: boolean }
interface Gpu { mode: string; adapter: Adapter | null }
// Non-literal specifier: a plain .mjs module of the Node script, without declarations.
const lib = (await import(/* @vite-ignore */ '../scripts/e2e-lib.mjs' as string)) as Lib;

type InView = { id: number; name: string; worstLabel: string | null; px: number; surfaceUnknown?: boolean; marker?: boolean };
const EARTH: InView = { id: 399, name: 'Earth', worstLabel: 'measured', px: 300 };
const MOON: InView = { id: 301, name: 'Moon', worstLabel: 'derived', px: 0.4 };
const debug = (o: Partial<{ adapt: number; stars: number; warnings: string[]; inView: InView[]; sun: boolean }> = {}) => ({
  renderer: { adaptationLuminance: o.adapt ?? 100, scotopicAdaptationLuminance: 250, pupilDiameterMm: 3, mesopicM: 1, limitingMagnitude: 2.5, starsDrawn: o.stars ?? 1000, warnings: o.warnings ?? [] },
  drawn: { sun: o.sun ?? true, bodies: [], inView: o.inView ?? [EARTH, MOON] },
  badge: [],
});

function image(w: number, h: number, f: (x: number, y: number) => number): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = f(x, y); px.set([v, v, v, 255], 4 * (y * w + x)); }
  return px;
}
const scene = (d: unknown, grid: number[] | null = null, extra: Partial<SceneResult> = {}): SceneResult => ({ stats: lib.extractStats(d), grid, consoleErrors: [], ...extra });

describe('scene suite helpers', () => {
  it('builds scene URLs from suite defaults and scene params', () => {
    const suite = { defaults: { t: '2026-10-15T00:00:00Z', smallbodies: '0' } };
    expect(lib.sceneQuery(suite, { params: { target: '399', smallbodies: '1' } })).toBe('t=2026-10-15T00:00:00Z&smallbodies=1&target=399');
    expect(lib.sceneQuery(suite, { params: { smallbodies: null } })).toBe('t=2026-10-15T00:00:00Z');
  });

  it('passes the exact held instant for all four time-dependent scenes', () => {
    const expected = { 'night-limb-iss-daylight-eye': '60', 'starfield-dark-2min': '120', 'starfield-dark-12min': '720', 'starfield-dark-30min': '1800' };
    for (const [id, elapsed] of Object.entries(expected)) {
      const scene = scenesJson.scenes.find((s) => s.id === id)!;
      const q = new URLSearchParams(lib.sceneQuery(scenesJson, scene));
      expect(q.get('adapttime'), id).toBe(elapsed);
      expect(q.get('adapt'), id).toBe('realtime');
      expect(q.get('adaptfrom')?.split(',')[2], id).toBe(elapsed);
      expect(scene).not.toHaveProperty('tolerance');
      expect(scene).not.toHaveProperty('toleranceWhy');
    }
  });

  it('round-trips PNG thumbnails and averages lightness in linear light', () => {
    const w = 128, h = 72;
    const px = image(w, h, (x) => (x < w / 2 ? 0 : 255)); // left half black, right half white
    const thumb = lib.thumbFromLinear(lib.boxLinear(px, w, h));
    const png = lib.encodePng(thumb, lib.THUMB_W, lib.THUMB_H);
    const back = lib.decodePng(png);
    expect(back.width).toBe(lib.THUMB_W);
    expect(Array.from(back.rgba)).toEqual(Array.from(thumb));
    const g = lib.gridFromThumb(back.rgba);
    expect(g.length).toBe(16 * 9);
    expect(g[0]).toBe(0);
    expect(g[15]).toBe(1);
    // A 50 % checkerboard averages to half the linear light, i.e. display lightness ~0.735, not 0.5.
    const checker = lib.thumbFromLinear(lib.boxLinear(image(w, h, (x, y) => ((x + y) % 2 ? 255 : 0)), w, h));
    expect(lib.gridFromThumb(checker)[40]).toBeCloseTo(0.735, 2);
  });

  it('passes an unchanged scene and reports changes within tolerance as notes', () => {
    const g = new Array(144).fill(0.2);
    const base = scene(debug(), g);
    expect(lib.compareScene(scene(debug(), g), base)).toEqual({ pass: true, failures: [], notes: [] });
    const r = lib.compareScene(scene(debug({ adapt: 110, stars: 1010 }), g.map((x) => x + 0.01)), base);
    expect(r.pass).toBe(true);
    expect(r.notes.join('\n')).toMatch(/adaptationLuminance.*starsDrawn.*image/s);
  });

  it('fails on stats, bodies, labels, warnings and image regressions', () => {
    const g = new Array(144).fill(0.3);
    const base = scene(debug({ warnings: ['Sun: limb darkening unknown'] }), g);
    const fails = (cur: SceneResult) => lib.compareScene(cur, base).failures.join('\n');
    expect(fails(scene(debug({ adapt: 300, warnings: ['Sun: limb darkening unknown'] }), g))).toMatch(/adaptationLuminance: 100 → 300/);
    expect(fails(scene(debug({ stars: 500, warnings: ['Sun: limb darkening unknown'] }), g))).toMatch(/starsDrawn: 1000 → 500/);
    expect(fails(scene(debug({ inView: [MOON], warnings: ['Sun: limb darkening unknown'] }), g))).toMatch(/no longer drawn resolved: Earth/);
    expect(fails(scene(debug({ inView: [{ ...EARTH, px: 0.5 }, MOON], warnings: ['Sun: limb darkening unknown'] }), g))).toMatch(/no longer drawn resolved: Earth.*\n.*new or changed \(id:label\): 399:measured/);
    expect(fails(scene(debug({ inView: [{ ...EARTH, worstLabel: 'estimated' }, MOON], warnings: ['Sun: limb darkening unknown'] }), g))).toMatch(/worst label measured → estimated/);
    expect(fails(scene(debug({ inView: [EARTH, { ...MOON, marker: true }], warnings: ['Sun: limb darkening unknown'] }), g))).toMatch(/gone or changed \(id:label\): 301:derived\n.*new or changed \(id:label\): 301:derived:marker/);
    expect(fails(scene(debug(), g))).toMatch(/warning gone/);
    expect(fails(scene(debug({ warnings: ['Sun: limb darkening unknown', 'new thing'] }), g))).toMatch(/new renderer warning: new thing/);
    expect(fails(scene(debug({ warnings: ['Sun: limb darkening unknown'] }), g.map(() => 0)))).toMatch(/went black/);
    expect(fails(scene(debug({ warnings: ['Sun: limb darkening unknown'] }), g.map(() => 1)))).toMatch(/went white/);
    expect(fails(scene(debug({ warnings: ['Sun: limb darkening unknown'] }), g.map((x, i) => (i === 50 ? 0.9 : x))))).toMatch(/largest \|ΔL\| 0\.600.*cell 2,3/);
    expect(fails(scene(debug({ warnings: ['Sun: limb darkening unknown'] }), g, { consoleErrors: ['boom'] }))).toMatch(/console errors 0 → 1/);
    expect(lib.compareScene({ ...scene(debug(), g), error: 'timeout' }, null).failures).toEqual(['did not render: timeout']);
    // A scene that timed out has no stats: it fails without comparing them.
    expect(lib.compareScene({ error: 'Timeout 600000ms exceeded' } as unknown as SceneResult, base)).toEqual({ pass: false, failures: ['did not render: Timeout 600000ms exceeded'], notes: [] });
    expect(lib.compareScene(scene(debug(), g), null)).toMatchObject({ pass: true, notes: ['no baseline for this scene'] });
    // Per-scene tolerance overrides.
    expect(lib.compareScene(scene(debug({ adapt: 300, warnings: ['Sun: limb darkening unknown'] }), g), base, { adaptationLog10: 0.5 }).pass).toBe(true);
    expect(lib.statsTable([{ id: 'x', readyMs: 1000, ...scene(debug(), g), compare: { pass: true, failures: [] } }])).toMatch(/x\s+1000\s+(?:none\s+){6}100\s+3\.00\s+2\.50\s+1000\s+none\s+2 \(1\)\s+1 measured, 1 derived\s+0\s+0\.300\s+pass/);
  });
});

// The adapters as Chromium 141 reports them (device and description are empty without developer features).
const SWIFTSHADER: Adapter = { vendor: 'google', architecture: 'swiftshader', device: '', description: '', fallback: true, float32Blendable: true };
const RTX: Adapter = { vendor: 'nvidia', architecture: 'blackwell', device: '', description: '', fallback: false, float32Blendable: true };

describe('the --gpu option', () => {
  it('keeps SwiftShader as the default, with the arguments the scripts always used', () => {
    const was = ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-webgpu-adapter=swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'];
    expect(lib.gpuLaunchArgs()).toEqual(was);
    expect(lib.gpuLaunchArgs('swiftshader')).toEqual(was);
    expect(lib.GPU_MODES).toEqual(['swiftshader', 'hardware']);
  });

  it('asks for Vulkan without a window surface in hardware mode, and for no software adapter', () => {
    const args = lib.gpuLaunchArgs('hardware');
    // Both are needed for the GPU process to initialize Vulkan; either alone still gives SwiftShader.
    expect(args).toContain('--use-angle=vulkan');
    expect(args).toContain('--enable-features=Vulkan');
    expect(args).toContain('--disable-vulkan-surface');
    expect(args).toContain('--enable-unsafe-webgpu');
    expect(args.join(' ')).not.toMatch(/swiftshader/);
    expect(() => lib.gpuLaunchArgs('gpu')).toThrow(/--gpu gpu: expected swiftshader or hardware/);
  });
  it('a run\'s own server does not watch files or reload pages: a data rebuild or an edit cannot lose the scene being measured', () => {
    // the address and the port are local-server.mjs's (127.0.0.1, assigned by the OS, never 5173)
    expect(lib.runServerOptions()).toEqual({ hmr: false, watch: null });
  });

  it('tells a software adapter from a hardware one', () => {
    expect(lib.isSoftwareAdapter(SWIFTSHADER)).toBe(true);
    expect(lib.isSoftwareAdapter(RTX)).toBe(false);
    expect(lib.isSoftwareAdapter(null)).toBe(false);
    // By name too (Mesa's CPU rasterizer does not call itself a fallback adapter), as src/app/sky.ts does.
    expect(lib.isSoftwareAdapter({ ...RTX, vendor: 'mesa', architecture: '', description: 'llvmpipe (LLVM 20.1, 256 bits)' })).toBe(true);
    expect(lib.isSoftwareAdapter({ ...RTX, fallback: true })).toBe(true);
    expect(lib.adapterLabel(RTX)).toBe('nvidia blackwell (hardware)');
    expect(lib.adapterLabel(SWIFTSHADER)).toBe('google swiftshader (software)');
    expect(lib.adapterLabel(null)).toBe('none');
    expect(lib.adapterLabel({ ...RTX, vendor: '', architecture: '' })).toBe('unnamed adapter (hardware)');
  });

  it('fails a hardware run that got a software adapter or none, and requires nothing of a SwiftShader run', () => {
    expect(lib.gpuMismatch('hardware', RTX)).toBeNull();
    expect(lib.gpuMismatch('hardware', SWIFTSHADER)).toMatch(/--gpu hardware: the browser's adapter is google swiftshader \(software\)/);
    expect(lib.gpuMismatch('hardware', null)).toMatch(/no WebGPU adapter/);
    expect(lib.gpuMismatch('swiftshader', SWIFTSHADER)).toBeNull();
    expect(lib.gpuMismatch('swiftshader', RTX)).toBeNull();
    expect(lib.gpuMismatch('swiftshader', null)).toBeNull();
  });

  it('reads the HDR target format from the renderer warnings', () => {
    expect(lib.hdrFormatOf([])).toBe('rgba32float');
    expect(lib.hdrFormatOf(undefined)).toBe('rgba32float');
    expect(lib.hdrFormatOf(['Sun: limb darkening unknown'])).toBe('rgba32float');
    expect(lib.hdrFormatOf(['HDR buffers are rgba16float with pre-exposure (float32-blendable unavailable or disabled)'])).toBe('rgba16float');
  });

  it('notes a baseline accepted on another kind of adapter; a baseline without the record was SwiftShader', () => {
    const soft: Gpu = { mode: 'swiftshader', adapter: SWIFTSHADER }, hard: Gpu = { mode: 'hardware', adapter: RTX };
    expect(lib.gpuNote(undefined, soft)).toBeNull();
    expect(lib.gpuNote(soft, soft)).toBeNull();
    expect(lib.gpuNote(hard, hard)).toBeNull();
    expect(lib.gpuNote(undefined, hard)).toBe('The baseline was accepted on swiftshader; this run rendered on hardware (nvidia blackwell (hardware)). Differences may come from the adapter.');
    expect(lib.gpuNote(hard, soft)).toMatch(/accepted on hardware \(nvidia blackwell \(hardware\)\); this run rendered on swiftshader \(google swiftshader \(software\)\)/);
  });

  it('accepting some scenes keeps the header of the whole suite\'s acceptance and records theirs; notes follow each scene\'s own', () => {
    const soft: Gpu = { mode: 'swiftshader', adapter: SWIFTSHADER }, hard: Gpu = { mode: 'hardware', adapter: RTX };
    const oct1: Meta = { acceptedAt: '2026-10-01T02:04:20.913Z', git: '48c7878', data: { manifestGeneratedAt: '2026-10-01T01:21:52+00:00', manifestSha256: 'aaaa' }, viewport: { width: 1280, height: 720 } };
    const oct7: Meta = { acceptedAt: '2026-10-07T09:00:00.000Z', git: '67a912f', data: { manifestGeneratedAt: '2026-10-07T08:09:35+00:00', manifestSha256: 'bbbb' }, viewport: { width: 1280, height: 720 }, gpu: hard };
    const scene = (n: number) => ({ query: 'q', stats: { starsDrawn: n }, consoleErrors: [], readyMs: 1 });
    const prev: Baseline = { ...oct1, scenes: { a: scene(1015), b: scene(186), gone: scene(3) } };
    const ids = ['a', 'b', 'c'];
    // one scene of three: the header is still the suite's acceptance of 1 October; the scene carries its own
    const part = lib.mergeBaseline(prev, [{ id: 'a', ...scene(667) }], oct7, ids);
    expect(part.acceptedAt).toBe(oct1.acceptedAt);
    expect(part.git).toBe('48c7878');
    expect(part.data).toEqual(oct1.data);
    expect(part.gpu).toBeUndefined();
    expect(part.scenes.a.stats).toEqual({ starsDrawn: 667 });
    expect(part.scenes.a.accepted).toEqual({ acceptedAt: oct7.acceptedAt, git: '67a912f', data: oct7.data, gpu: hard });
    expect(part.scenes.b).toEqual(prev.scenes.b);
    expect(part.scenes.gone).toBeUndefined();            // no longer in scenes.json
    expect(lib.sceneAcceptance(part, 'a').gpu).toEqual(hard);
    expect(lib.sceneAcceptance(part, 'b').gpu).toBeUndefined();
    expect(lib.sceneAcceptance(part, 'b').git).toBe('48c7878');
    // a hardware run on the new data against it: scene b alone gets the two notes, by name
    expect(lib.acceptanceNotes(part, ['a', 'b', 'c'], oct7.data, hard)).toEqual([
      'b: The baseline was accepted on another data build (manifest 2026-10-01T01:21:52+00:00); this run uses 2026-10-07T08:09:35+00:00. Differences may come from the data.',
      'b: The baseline was accepted on swiftshader; this run rendered on hardware (nvidia blackwell (hardware)). Differences may come from the adapter.',
    ]);
    // a SwiftShader run on the old data: only scene a differs
    expect(lib.acceptanceNotes(part, ['a', 'b'], oct1.data, soft)).toHaveLength(2);
    expect(lib.acceptanceNotes(part, ['a', 'b'], oct1.data, soft).every((n) => n.startsWith('a: '))).toBe(true);
    // a note that holds for every compared scene is not prefixed
    expect(lib.acceptanceNotes(prev, ['a', 'b'], oct7.data, soft)).toEqual(['The baseline was accepted on another data build (manifest 2026-10-01T01:21:52+00:00); this run uses 2026-10-07T08:09:35+00:00. Differences may come from the data.']);
    // the whole suite: the header is the new acceptance and no scene carries its own
    const whole = lib.mergeBaseline(part, ids.map((id) => ({ id, ...scene(1) })), oct7, ids);
    expect(whole.acceptedAt).toBe(oct7.acceptedAt);
    expect(whole.gpu).toEqual(hard);
    expect(Object.keys(whole.scenes)).toEqual(ids);
    for (const id of ids) expect(whole.scenes[id].accepted).toBeUndefined();
    expect(lib.acceptanceNotes(whole, ids, oct7.data, hard)).toEqual([]);
    // no baseline yet: the first acceptance, even of one scene, writes the header
    expect(lib.mergeBaseline(null, [{ id: 'a', ...scene(1) }], oct7, ids).git).toBe('67a912f');
  });

  it('notes a star count that is not one number from frame to frame', () => {
    expect(lib.starsFramesNote(undefined, 10)).toBeNull();
    expect(lib.starsFramesNote([], 10)).toBeNull();
    expect(lib.starsFramesNote([1015], 1015)).toBeNull();
    expect(lib.starsFramesNote([965, 1043], 965)).toBe('starsDrawn changes from frame to frame: 965, 1043; the stats hold 965');
    expect(lib.starsFramesNote([2631, 2632, 2634, 2635, 2636, 2639, 2643], 2635)).toBe('starsDrawn changes from frame to frame: 2631 … 2643 (7 values); the stats hold 2635');
  });

  it('a star count that changes between frames fails a scene whose eye is always adapted, and only such a scene', () => {
    const instant = 't=2026-10-15T00:00:00Z&smallbodies=0&adapt=instant&target=999&dist=60000';
    const realtime = 't=2026-10-15T00:00:00Z&smallbodies=0&adapt=realtime&target=999&adaptfrom=10000,600,1800';
    expect(lib.starsFramesFailure([667], 667, instant)).toBeNull();
    expect(lib.starsFramesFailure(undefined, 667, instant)).toBeNull();   // not sampled (SwiftShader)
    expect(lib.starsFramesFailure([913, 1096], 913, instant)).toBe('starsDrawn changes from frame to frame: 913, 1096; the stats hold 913 (the eye is always adapted in this scene: the settled frame must be one frame)');
    expect(lib.starsFramesFailure([2624, 2626, 2629], 2626, realtime)).toBeNull();
    expect(lib.starsFramesNote([2624, 2626, 2629], 2626)).not.toBeNull();
    expect(lib.starsFramesFailure([1, 2], 1, 'target=999&adapt=instantly')).toBeNull();
    expect(lib.starsFramesFailure([1, 2], 1, undefined)).toBeNull();
    for (const t of [0, 60, 1800]) {
      expect(lib.starsFramesFailure([1, 2], 1, realtime + '&adapttime=' + t)).toMatch(/clock held/);
      expect(lib.starsFramesFailure([1], 1, realtime + '&adapttime=' + t)).toBeNull();
      expect(lib.starsFramesFailure(undefined, 1, realtime + '&adapttime=' + t)).toMatch(/unavailable/);
    }
    expect(lib.starsFramesFailure([1, 2], 1, realtime + '&adapttime=-1')).toBeNull();
  });
});
