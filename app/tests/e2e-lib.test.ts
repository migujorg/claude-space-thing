// The pure parts of the scene regression suite (scripts/e2e-lib.mjs): scene URLs, PNG thumbnails, the lightness
// grid, and the comparison rules against a baseline.

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
}
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
    expect(lib.statsTable([{ id: 'x', readyMs: 1000, ...scene(debug(), g), compare: { pass: true, failures: [] } }])).toMatch(/x\s+1\s+100\s+3\.00\s+2\.50\s+1000\s+2 \(1\)\s+1 measured, 1 derived\s+0\s+0\.300\s+pass/);
  });
});
