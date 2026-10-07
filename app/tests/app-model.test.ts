import { describe, expect, it } from 'vitest';
import { AppModel } from '../src/app/model';
import { len, sub } from '../src/app/vec';
import type { LoadedData } from '../src/data/load';
import type { Vec3 } from '../src/app/ports';
import { body, FAKE_J2000_MS, FakeEphemerisSet, fakeCore, fakeLight } from './app-fakes';

const DAY = 86400;
const earthAt = (t: number): Vec3 => [1.5e8 * Math.cos(t / (58 * DAY)), 1.5e8 * Math.sin(t / (58 * DAY)), 0];
const moonAt = (t: number): Vec3 => { const e = earthAt(t); return [e[0] + 4e5 * Math.cos(t / (4.3 * DAY)), e[1] + 4e5 * Math.sin(t / (4.3 * DAY)), e[2]]; };
const T0 = 8.4e8; // fake ET around late 2026

function setup(now = FAKE_J2000_MS + T0 * 1000) {
  const eph = new FakeEphemerisSet({ 10: () => [0, 0, 0], 399: earthAt, 301: moonAt }, { startEt: T0 - 100 * DAY, endEt: T0 + 200 * DAY });
  const model = new AppModel(fakeCore(eph), { now: () => now });
  const data: LoadedData = {
    manifest: { generatedAt: 'x', pipelineVersion: 'x', window: { startEt: T0 - 50 * DAY, endEt: T0 + 400 * DAY }, products: {} },
    sources: new Map(),
    time: { source: 'x', leapSeconds: [], deltaTA: 0, k: 0, eb: 0, m0: 0, m1: 0 },
    ephemerides: [{ name: 'fake', path: 'ephem/fake.json', header: { bin: 'fake.bin', segments: [] }, data: new Float64Array(0) }],
    bodies: [
      body(10, 'Sun', 'star', { r: 7e5 }),
      body(399, 'Earth', 'planet', { r: 6400, albedo: 'derived', phase: 'measured' }),
      body(301, 'Moon', 'moon', { parent: 399, r: 1700 }),
      body(999, 'NoEphem', 'dwarf-planet', { r: 1000 }), // no ephemeris coverage in this fake
    ],
    light: fakeLight(),
    stars: null,
    starNames: [],
    report: { products: [], notes: [] },
    deferred: [],
    orientations: [],
    surfaces: [],
    loader: null,
  };
  model.setData(data);
  model.setViewport({ width: 1600, height: 900, dpr: 1 });
  return { model, eph };
}

describe('AppModel', () => {
  it('clamps time to the intersection of the manifest and ephemeris windows', () => {
    const { model } = setup();
    expect(model.clock.window).toEqual({ startEt: T0 - 50 * DAY, endEt: T0 + 200 * DAY });
    expect(model.setEt(T0 + 300 * DAY)).toBe(false);
    expect(model.clock.et).toBe(T0 + 200 * DAY);
    expect(model.debugState().outsideWindow?.edge).toBe('end');
    expect(model.messages.at(-1)?.text).toMatch(/outside the data window/);
  });

  it('applies URL parameters: paused at t, orbiting target at dist/az/el, reality, fov', () => {
    const { model } = setup();
    model.applyUrl({ tMs: FAKE_J2000_MS + (T0 + 10 * DAY) * 1000, target: 301, dist: 50000, az: 40, el: -20, exists: 'strict', view: 'enhanced', boost: 3, fov: 30, orbits: true });
    expect(model.clock.et).toBeCloseTo(T0 + 10 * DAY, 6);
    expect(model.clock.playing).toBe(false);
    model.frame(0);
    const s = model.debugState();
    expect(s.camera.mode).toBe('orbit');
    expect(s.camera.target).toBe(301);
    expect(s.camera.distKm).toBeCloseTo(50000, 6);
    expect(s.camera.azDeg).toBeCloseTo(40, 6);
    expect(s.camera.elDeg).toBeCloseTo(-20, 6);
    expect(s.camera.fovDeg).toBeCloseTo(30, 9);
    expect(s.badge).toEqual(['STRICT: measured + derived only', 'ENHANCED +3 stops']);
    expect(s.drawn.orbits).toBeGreaterThan(0);
    // round trip through the URL view
    const v = model.currentUrlView();
    expect(v).toMatchObject({ target: 301, exists: 'strict', view: 'enhanced', boost: 3, orbits: true });
    expect(v.az).toBeCloseTo(40, 6);
    expect(v.dist).toBeCloseTo(50000, 6);
  });

  it('carries the held eye instant from the URL into every snapshot and back', () => {
    const { model } = setup();
    const history = { luminanceCdM2: 10000, exposureS: 600, elapsedS: 60 };
    model.applyUrl({ adapt: 'realtime', adaptFrom: history, adaptTimeS: 60 });
    for (const dt of [0, 0.016, 2, 18]) {
      expect(model.frame(dt).view.adaptation).toEqual({ mode: 'realtime', history, heldElapsedS: 60 });
    }
    expect(model.currentUrlView()).toMatchObject({ adaptFrom: history, adaptTimeS: 60 });
  });

  it('without t starts at now and plays in real time; default target and sunlit view', () => {
    const { model } = setup(FAKE_J2000_MS + (T0 + DAY) * 1000);
    model.applyUrl({});
    expect(model.clock.et).toBeCloseTo(T0 + DAY, 6);
    expect(model.clock.playing).toBe(true);
    expect(model.clock.rate).toBe(1);
    model.frame(0);
    const s = model.debugState();
    expect(s.camera.target).toBe(399);
    expect(Math.abs(s.camera.azDeg!)).toBeLessThan(90); // on the sunlit side
  });

  it('go-to travels smoothly, follows the target and resolves on arrival', async () => {
    const { model } = setup();
    model.applyUrl({ tMs: FAKE_J2000_MS + T0 * 1000, target: 399, dist: 1e6 });
    model.clock.play();
    model.clock.setRateMagnitude(3600);
    const p = model.goTo(301);
    expect(typeof p).not.toBe('string');
    let done = false;
    void (p as Promise<void>).then(() => (done = true));
    let minDist = Infinity;
    for (let i = 0; i < 400 && !done; i++) {
      model.frame(1 / 60);
      const moon = model.bodyPos(301)!;
      minDist = Math.min(minDist, len(sub(model.pose.pos, moon)));
      await Promise.resolve();
    }
    expect(done).toBe(true);
    const s = model.debugState();
    expect(s.camera.target).toBe(301);
    expect(s.selected).toBe(301);
    expect(minDist).toBeGreaterThan(1700);
    // after arrival the camera rides along with the Moon
    const rel0 = sub(model.pose.pos, model.bodyPos(301)!);
    for (let i = 0; i < 30; i++) model.frame(1 / 60);
    const rel1 = sub(model.pose.pos, model.bodyPos(301)!);
    expect(len(sub(rel0, rel1))).toBeLessThan(1e-6);
  });

  it('lists the bodies in the frame with their apparent size (debugState, for the scene suite)', () => {
    const { model } = setup();
    model.applyUrl({ tMs: FAKE_J2000_MS + T0 * 1000, target: 399, dist: 50000, az: 0, el: 0 });
    model.frame(0);
    const v = model.debugState().drawn.inView;
    const earth = v.find((b) => b.id === 399)!;
    // Earth fills about the go-to framing: 2·atan(6400 / 50000) of the 50° field over 900 px.
    expect(earth.px).toBeCloseTo((2 * Math.tan(Math.asin(6400 / 50000)) * 900) / (2 * Math.tan((25 * Math.PI) / 180)), 0);
    expect(earth).toMatchObject({ worstLabel: 'derived', marker: false });
    // The Sun is behind the camera (the view is from the Sun side): not in the frame.
    expect(v.some((b) => b.id === 10)).toBe(false);
  });

  it('go-to refuses bodies without a position instead of guessing', () => {
    const { model } = setup();
    model.applyUrl({ tMs: FAKE_J2000_MS + T0 * 1000 });
    expect(model.goTo(12345)).toMatch(/No body/);
    expect(model.goTo(999)).toMatch(/No position for NoEphem/);
  });

  it('a URL target without a position falls back to a default view and says why', () => {
    const { model } = setup();
    model.applyUrl({ tMs: FAKE_J2000_MS + T0 * 1000, target: 999, dist: 5000 });
    model.frame(0);
    expect(model.debugState().camera.target).toBe(399);
    expect(model.messages.map((m) => m.text).join(' ')).toMatch(/No position for NoEphem/);
  });

  it('picking at the screen center selects the orbited body', () => {
    const { model } = setup();
    model.applyUrl({ tMs: FAKE_J2000_MS + T0 * 1000, target: 399, dist: 30000 });
    model.frame(0);
    expect(model.pickAt(800, 450)).toBe(399);
  });

  it('free flight stays outside bodies and rides with its anchor', () => {
    const { model } = setup();
    model.applyUrl({ tMs: FAKE_J2000_MS + T0 * 1000, target: 399, dist: 10000 });
    model.frame(0);
    model.toggleMode();
    expect(model.cam.mode).toBe('free');
    for (let i = 0; i < 300; i++) model.frame(1 / 60, { move: [0, 0, -1], roll: 0, mod: 'fast' });
    const d = len(sub(model.pose.pos, model.bodyPos(399)!));
    expect(d).toBeGreaterThan(6400);
    expect(model.debugState().camera.anchor).toBe(399);
    for (let i = 0; i < 200; i++) { model.wheel(-10); model.frame(0); }
    expect(len(sub(model.pose.pos, model.bodyPos(399)!))).toBeGreaterThan(6400);
  });

  it('snapshot uses the current reality level', () => {
    const { model } = setup();
    model.applyUrl({ tMs: FAKE_J2000_MS + T0 * 1000, target: 399, dist: 30000 });
    const s = model.frame(0);
    expect(s.bodies.map((b) => b.id).sort()).toEqual([301, 399]);
    expect(s.sun?.radius).toBe(500);
    expect(s.bodies.find((b) => b.id === 399)!.selected).toBe(true);
    expect(s.camera.width).toBe(1600);
  });
});
