// Compile-time check that implementations shaped like the ones being built in core/ and render/
// (concrete classes with private state and extra members; free functions typed against the concrete
// EphemerisSet class) are accepted by AppDeps. If this file type-checks, integration in main.ts is
// `startApp(canvas, ui, { Renderer, TimeScale, formatUtc, Ephemeris, EphemerisSet, bodyToIcrf, apparentPosition })`.

import { describe, expect, it } from 'vitest';
import type { AppDeps } from '../src/app/ports';
import type { EphemHeader, IauRotation, TimeData } from '../src/data/schema';
import type { Mat3, RendererStats, SceneSnapshot, StarCatalog, Vec3 } from '../src/render/scene';

class TimeScale {
  #table: number[];
  constructor(data: TimeData) { this.#table = data.leapSeconds.map((l) => l.deltaAT); }
  utcMsToEt(unixMs: number): number { return unixMs / 1000 + this.#table.length; }
  etToUtcMs(et: number): number { return et * 1000; }
  extra(): void {}
}
const formatUtc = (unixMs: number): string => String(unixMs);

class Ephemeris {
  private readonly segs: EphemHeader['segments'];
  readonly ids: number[];
  constructor(header: EphemHeader, private data: Float64Array) { this.segs = header.segments; this.ids = this.segs.map((s) => s.target); }
  covers(id: number, et: number): boolean { return this.ids.includes(id) && et === et && this.data.length >= 0; }
  evaluate(_id: number, _et: number): Vec3 | null { return null; }
}

class EphemerisSet {
  private list: Ephemeris[] = [];
  add(e: Ephemeris): void { this.list.push(e); }
  positionSSB(_id: number, _et: number): Vec3 | null { return null; }
  stateSSB(_id: number, _et: number): { pos: Vec3; vel: Vec3 } | null { return null; }
  covers(id: number, et: number): boolean { return this.list.some((e) => e.covers(id, et)); }
  get window(): { startEt: number; endEt: number } { return { startEt: 0, endEt: 1 }; }
}

function bodyToIcrf(_rot: IauRotation, _et: number): Mat3 { return [1, 0, 0, 0, 1, 0, 0, 0, 1]; }
function apparentPosition(eph: EphemerisSet, id: number, observerSSB: Vec3, et: number): { rel: Vec3; lightTime: number; emitEt: number } | null {
  return eph.covers(id, et) ? { rel: observerSSB, lightTime: 0, emitEt: et } : null;
}

class Renderer {
  private device: unknown = null;
  stats: RendererStats = { frameMs: 0, adaptationLuminance: 0, starsDrawn: 0 };
  static async create(_canvas: HTMLCanvasElement): Promise<Renderer> { return new Renderer(); }
  setStars(_c: StarCatalog): void { void this.device; }
  resize(_w: number, _h: number, _dpr: number): void {}
  render(_s: SceneSnapshot): void {}
  settled(): Promise<void> { return Promise.resolve(); }
}

describe('ports', () => {
  it('accept realistic implementations structurally', () => {
    const deps: AppDeps = { Renderer, TimeScale, formatUtc, Ephemeris, EphemerisSet, bodyToIcrf, apparentPosition };
    expect(typeof deps.Renderer.create).toBe('function');
  });
});
