// Virtual texturing: pyramid addressing, level-of-detail rule, footprint sampling, and the tile cache's
// strict budget / LRU / fallback behaviour (GPU replaced by a fake page store).
import { describe, expect, it } from 'vitest';
import {
  f16ToNumber, footprintTiles, layerEntries, levelForFootprint, levelOffset, numberToF16, TILE, TILE_BYTES,
  TileCache, tileIndex, tileOf, uvOf, zonalMeanOfLevel0, type PageStore,
} from '../src/render/surface';
import { prepareBody, type M3, type V3 } from '../src/render/raycast';
import type { CameraGeom } from '../src/render/overlays';
import type { SurfaceLayerRef } from '../src/render/scene';

const I3: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

describe('pyramid addressing', () => {
  it('level offsets and sizes follow the §4.4 layout', () => {
    expect([0, 1, 2, 3].map(levelOffset)).toEqual([0, 2, 10, 42]);
    expect(layerEntries(2)).toBe(42);
    expect(tileIndex(1, 3, 1)).toBe(2 + 1 * 4 + 3);
  });
  it('u, v of body-fixed directions', () => {
    expect(uvOf([1, 0, 0])).toEqual([0.5, 0.5]);
    expect(uvOf([0, 1, 0])[0]).toBeCloseTo(0.75, 12);
    expect(uvOf([0, 0, 1])[1]).toBeCloseTo(0, 12);
    expect(tileOf(0, 0.25, 0.5)).toEqual([0, 0]);
    expect(tileOf(0, 0.75, 0.5)).toEqual([1, 0]);
    expect(tileOf(2, 0.999999, 0.999999)).toEqual([7, 3]);
  });
  it('level of detail: texel ≈ pixel footprint', () => {
    const R = 512 / (2 * Math.PI); // equatorial texel of level 0 = 1 km
    expect(levelForFootprint(R, 1, 10)).toBe(0);
    expect(levelForFootprint(R, 0.25, 10)).toBe(2);
    expect(levelForFootprint(R, 0.25, 1)).toBe(1);
    expect(levelForFootprint(R, 100, 10)).toBe(0);
  });
});

function camera(W = 1280, H = 720, fovYDeg = 40): CameraGeom {
  const tanY = Math.tan((fovYDeg * Math.PI) / 360);
  return { right: [1, 0, 0], up: [0, 1, 0], back: [0, 0, 1], tanX: (tanY * W) / H, tanY, W, H, near: 1e-7, pixelAngle: (2 * tanY) / H };
}

describe('footprint sampling', () => {
  const R = 1737.4;
  it('a distant body needs only level 0', () => {
    const g = camera();
    const b = prepareBody([0, 0, -400000], [R, R, R], I3);
    const t = footprintTiles(b, I3, g, 8);
    expect(new Set(t.map((x) => x.L))).toEqual(new Set([0]));
    expect(t.length).toBe(2);
  });
  it('a close body needs finer tiles, each with its ancestors, level 0 first', () => {
    const g = camera();
    const b = prepareBody([0, 0, -6000], [R, R, R], I3);
    const t = footprintTiles(b, I3, g, 8);
    const maxL = Math.max(...t.map((x) => x.L));
    expect(maxL).toBeGreaterThanOrEqual(2);
    expect(t[0].L).toBe(0);
    const keys = new Set(t.map((x) => tileIndex(x.L, x.tx, x.ty)));
    for (const x of t) {
      if (x.L === 0) continue;
      expect(keys.has(tileIndex(x.L - 1, x.tx >> 1, x.ty >> 1))).toBe(true);
      expect(x.tx).toBeLessThan(2 << x.L);
      expect(x.ty).toBeLessThan(1 << x.L);
    }
    // The camera is on +z (body-fixed = world here): the sub-camera point is the north pole (row 0).
    expect(t.some((x) => x.L === maxL && x.ty === 0)).toBe(true);
  });
  it('the chosen level matches the shader rule at the disk centre', () => {
    const g = camera();
    const dist = 20000;
    const b = prepareBody([0, 0, -dist], [R, R, R], I3);
    const range = dist - R;
    const expectL = levelForFootprint(R, g.pixelAngle * range, 8);
    const t = footprintTiles(b, I3, g, 8);
    expect(Math.max(...t.map((x) => x.L))).toBe(expectL);
  });
});

function fakeStore(pages: number) {
  const entries = new Map<number, number>();
  const uploads: number[] = [];
  const store: PageStore = { pages, upload: (p) => uploads.push(p), setEntry: (i, v) => (v ? entries.set(i, v) : entries.delete(i)) };
  return { store, entries, uploads };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('tile cache', () => {
  const ref = (maxLevel: number, missing?: Record<string, [number, number][]>): SurfaceLayerRef => ({ url: 'fixture://t/albedo', header: { maxLevel, missing } });
  const all = (L: number) => {
    const out = [];
    for (let ty = 0; ty < 1 << L; ty++) for (let tx = 0; tx < 2 << L; tx++) out.push({ L, tx, ty, priority: L });
    return out;
  };

  it('never exceeds its page budget; excess requests are deferred, not loaded', async () => {
    const { store, entries } = fakeStore(6);
    const fetched: string[] = [];
    let base = 0;
    const c = new TileCache('albedo', store, (n) => { const b = base; base += n; return b; }, async (u) => { fetched.push(u); return new ArrayBuffer(TILE_BYTES.albedo); }, 64);
    const r = ref(2);
    c.layer(r);
    c.beginFrame();
    c.request(r, [...all(0), ...all(1), ...all(2)]);
    c.pump();
    await flush();
    expect(c.residentCount()).toBeLessThanOrEqual(6);
    expect(entries.size).toBe(c.residentCount());
    expect(c.getStats().deferredTiles).toBeGreaterThan(0);
    // Level 0 made it (most urgent) and is pinned.
    expect(entries.get(tileIndex(0, 0, 0))).toBeGreaterThan(0);
    expect(entries.get(tileIndex(0, 1, 0))).toBeGreaterThan(0);
  });

  it('evicts least-recently-used tiles that the current frame does not need', async () => {
    const { store, entries } = fakeStore(4);
    const c = new TileCache('albedo', store, () => 0, async () => new ArrayBuffer(TILE_BYTES.albedo));
    const r = ref(1);
    c.layer(r);
    c.beginFrame();
    c.request(r, [...all(0), { L: 1, tx: 0, ty: 0, priority: 1 }, { L: 1, tx: 1, ty: 0, priority: 1 }]);
    c.pump();
    await flush();
    expect(c.residentCount()).toBe(4);
    c.beginFrame(); // the view moved: other level-1 tiles needed now
    c.request(r, [...all(0), { L: 1, tx: 2, ty: 1, priority: 1 }]);
    c.pump();
    await flush();
    expect(entries.get(tileIndex(1, 2, 1))).toBeGreaterThan(0);
    expect(c.residentCount()).toBe(4);
    const old = [tileIndex(1, 0, 0), tileIndex(1, 1, 0)].filter((i) => entries.has(i));
    expect(old.length).toBe(1); // one of the unused tiles was evicted, level 0 stayed
    expect(entries.has(tileIndex(0, 0, 0)) && entries.has(tileIndex(0, 1, 0))).toBe(true);
  });

  it('absent tiles (404, or listed missing in the header) are never fetched again', async () => {
    const { store } = fakeStore(8);
    const fetched: string[] = [];
    const c = new TileCache('albedo', store, () => 0, async (u) => { fetched.push(u); return u.endsWith('/1/0/1.bin') ? null : new ArrayBuffer(TILE_BYTES.albedo); });
    const r = ref(1, { 1: [[3, 1]] });
    c.layer(r);
    for (let f = 0; f < 3; f++) {
      c.beginFrame();
      c.request(r, [...all(0), ...all(1)]);
      c.pump();
      await flush();
    }
    expect(fetched.filter((u) => u.endsWith('/1/0/1.bin')).length).toBe(1);
    expect(fetched.some((u) => u.endsWith('/1/1/3.bin'))).toBe(false);
  });
});

describe('level-0 zonal mean', () => {
  it('averages each row per channel; unknown texels count as the disk average (1)', () => {
    const tile = (val: (i: number, j: number) => [number, number, number, number] | null) => {
      const b = new ArrayBuffer(TILE_BYTES.albedo);
      const h = new Uint16Array(b);
      for (let j = 0; j < TILE; j++) for (let i = 0; i < TILE; i++) {
        const v = val(i, j);
        if (v) for (let k = 0; k < 4; k++) h[(j * TILE + i) * 4 + k] = numberToF16(v[k]);
      }
      return b;
    };
    const t0 = tile((_, j) => (j < 128 ? [2, 2, 2, 2] : [0.5, 0.5, 1, 1]));
    const t1 = tile((i) => (i < 128 ? null : [2, 2, 2, 2]));
    const z = zonalMeanOfLevel0([t0, t1]);
    expect(z.rows).toBe(256);
    expect(z.mean[0]).toBeCloseTo((256 * 2 + 128 * 1 + 128 * 2) / 512, 12);
    expect(z.mean[4 * 200 + 0]).toBeCloseTo((256 * 0.5 + 128 * 1 + 128 * 2) / 512, 12);
    expect(z.mean[4 * 200 + 2]).toBeCloseTo((256 * 1 + 128 * 1 + 128 * 2) / 512, 12);
    const none = zonalMeanOfLevel0([null, null]);
    expect(none.mean.every((v) => v === 1)).toBe(true);
  });
  it('binary16 conversions round-trip', () => {
    for (const v of [0, 1, 0.5, 1.0009765625, 65504, 6.103515625e-5, 2.98e-8, 0.33325195]) {
      expect(f16ToNumber(numberToF16(v))).toBeCloseTo(v, 6);
    }
  });
});

void (null as unknown as V3);
