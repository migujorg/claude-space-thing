import { describe, expect, it, vi } from 'vitest';
import { Renderer } from '../src/render/renderer';
import { ADAPT_TILE_PX } from '../src/render/shaders';
import { aerialPerspectiveSize, frameSize, readbackSize, requiredFrameLimits, type FrameLimits } from '../src/render/frameSizing';

// WebGPU baseline limits; no adapter/GPU is involved in these allocation tests.
const baseline: FrameLimits = {
  maxTextureDimension2D: 8192, maxTextureDimension3D: 2048,
  maxBufferSize: 256 * 2 ** 20, maxStorageBufferBindingSize: 128 * 2 ** 20,
  maxComputeWorkgroupsPerDimension: 65535,
};

describe('frame resource sizing', () => {
  it('fits the 4125 × 414 Himawari aerial grid in a baseline device', () => {
    const a = aerialPerspectiveSize(4125, 414, 10, 3, baseline)!;
    expect(a.nx).toBeLessThanOrEqual(baseline.maxTextureDimension3D);
    expect(a.ny).toBeLessThanOrEqual(baseline.maxTextureDimension3D);
    expect(a.depth).toBeLessThanOrEqual(baseline.maxTextureDimension3D);
  });
});

// 2D capability evidenced by the sweep; 3D/buffer capabilities are explicit test scenarios,
// not a claim that the sweep recorded the adapter's unreported limits.
const wider = { ...baseline, maxTextureDimension2D: 16384 };
const widths = [1280, 4096, 4125, 5120, 7680, 8250, 16384];
for (const limits of [baseline, wider, { ...wider, maxTextureDimension3D: 4096 }]) {
  describe(`limits 2D=${limits.maxTextureDimension2D}, 3D=${limits.maxTextureDimension3D}`, () => {
    for (const W of widths) it(`sizes or refuses ${W}-wide frames without an invalid allocation`, () => {
      for (const H of [138, 414, 828, W]) {
        const plan = frameSize(W, H, limits, ADAPT_TILE_PX);
        if (!plan.ok) { expect(plan.warning).toMatch(/Frame cannot be rendered/); continue; }
        const p = plan.size;
        // EXT, PT, PTEX, PTDISP, W, MASK, depth, offscreen display; five textures at every pyramid level.
        for (const { w, h } of [{ w: p.W, h: p.H }, ...p.levels]) {
          expect(Math.max(w, h)).toBeLessThanOrEqual(limits.maxTextureDimension2D);
          expect(Math.max(Math.ceil(w / 8), Math.ceil(h / 8))).toBeLessThanOrEqual(limits.maxComputeWorkgroupsPerDimension);
        }
        expect(p.adaptationBytes).toBeLessThanOrEqual(limits.maxBufferSize);
        expect(p.adaptationBytes).toBeLessThanOrEqual(limits.maxStorageBufferBindingSize);
        expect(Math.max(p.tilesX, p.tilesY)).toBeLessThanOrEqual(limits.maxComputeWorkgroupsPerDimension);
        expect(p.acuMips).toBeLessThanOrEqual(Math.floor(Math.log2(Math.max(p.acuW, p.acuH))) + 1);
        for (let j = 0; j < p.acuMips; j++) {
          expect(Math.max(1, p.acuW >> j, p.acuH >> j)).toBeLessThanOrEqual(limits.maxTextureDimension2D);
        }
        // Night emission (half-resolution), zodiacal grid (+1 interpolation border).
        for (const [w, h] of [[Math.ceil(W / 2), Math.ceil(H / 2)], [Math.ceil(W / 16) + 1, Math.ceil(H / 16) + 1]]) {
          expect(Math.max(w, h)).toBeLessThanOrEqual(limits.maxTextureDimension2D);
          expect(Math.max(Math.ceil(w / 8), Math.ceil(h / 8))).toBeLessThanOrEqual(limits.maxComputeWorkgroupsPerDimension);
        }
        const a = aerialPerspectiveSize(W, H, 10, 3, limits)!;
        expect(Math.max(a.nx, a.ny, a.depth)).toBeLessThanOrEqual(limits.maxTextureDimension3D);
        expect(Math.max(Math.ceil(a.nx / 8), Math.ceil(a.ny / 8))).toBeLessThanOrEqual(limits.maxComputeWorkgroupsPerDimension);
        for (const [bpp, storage] of [[4, false], [8, false], [16, true]] as const) {
          const rb = readbackSize(W, H, bpp, storage, limits);
          if (rb.ok) {
            expect(rb.size.bytes).toBeLessThanOrEqual(limits.maxBufferSize);
            if (storage) expect(rb.size.bytes).toBeLessThanOrEqual(limits.maxStorageBufferBindingSize);
            else expect(rb.size.bytesPerRow % 256).toBe(0);
          } else expect(rb.warning).toMatch(/Readback/);
        }
      }
    });
  });
}

it('preserves the uncapped scene-suite grid and caps only the narrow Himawari grids', () => {
  expect(aerialPerspectiveSize(1280, 720, 10, 3, baseline)).toEqual({ colPx: 3, nx: 427, ny: 240, depth: 40 });
  expect(aerialPerspectiveSize(4125, 414, 10, 3, baseline)).toEqual({ colPx: 3, nx: 1375, ny: 138, depth: 40 });
  expect(aerialPerspectiveSize(8250, 828, 10, 3, baseline)).toEqual({ colPx: 5, nx: 1650, ny: 166, depth: 40 });
  expect(aerialPerspectiveSize(4125, 414, 10, 3, { ...baseline, maxTextureDimension3D: 4096 })?.colPx).toBe(2);
});

it('requests exactly the adapter capabilities for every frame limit', () => {
  expect(requiredFrameLimits(wider)).toEqual(wider);
});

it('refuses above 2D, storage/buffer and compute limits before planning allocations', () => {
  expect(frameSize(8250, 828, baseline, ADAPT_TILE_PX).ok).toBe(false);
  expect(frameSize(16385, 1, wider, ADAPT_TILE_PX).ok).toBe(false);
  expect(frameSize(1024, 1024, { ...baseline, maxStorageBufferBindingSize: 1024 }, ADAPT_TILE_PX).ok).toBe(false);
  expect(frameSize(1024, 1024, { ...baseline, maxBufferSize: 1024 }, ADAPT_TILE_PX).ok).toBe(false);
  expect(frameSize(1024, 1024, { ...baseline, maxComputeWorkgroupsPerDimension: 1 }, ADAPT_TILE_PX).ok).toBe(false);
  expect(frameSize(NaN, 1, baseline, ADAPT_TILE_PX).ok).toBe(false);
});

it('falls back to the same per-pixel atmosphere when its complete depth cannot fit', () => {
  expect(aerialPerspectiveSize(1280, 720, 10, 3, { ...baseline, maxTextureDimension3D: 32 })).toBeNull();
});

it('rejects large readbacks but permits a region without restricting rendering', () => {
  expect(frameSize(4096, 4096, baseline, ADAPT_TILE_PX).ok).toBe(true);
  expect(readbackSize(4096, 4096, 16, true, baseline).ok).toBe(false);
  expect(readbackSize(4096, 2048, 16, true, baseline).ok).toBe(true);
  expect(readbackSize(16384, 16384, 4, false, wider).ok).toBe(false);
  expect(readbackSize(8250, 828, 16, true, wider).ok).toBe(true);
});

it('the renderer refuses before creating any resources and recovers on a supported resize', async () => {
  vi.stubGlobal('GPUTextureUsage', { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, STORAGE_BINDING: 4 });
  vi.stubGlobal('GPUBufferUsage', { UNIFORM: 1, COPY_DST: 2, STORAGE: 4 });
  const textures: { size: number[]; mipLevelCount?: number }[] = [], buffers: { size: number }[] = [];
  const r = {
    device: { limits: baseline,
      createTexture: (desc: { size: number[] }) => { textures.push(desc); return {}; },
      createBuffer: (desc: { size: number }) => { buffers.push(desc); return {}; },
    },
    canvas: { width: 1, height: 1 }, stats: { warnings: [] as string[] }, persistentWarnings: [],
    targets: null, glareCache: { key: '' }, destroyTargets: vi.fn(), frameRefusal: null,
  };
  try {
    expect(() => Renderer.prototype.resize.call(r as unknown as Renderer, 8250, 828, 1)).toThrow(/maxTextureDimension2D/);
    expect(textures).toHaveLength(0); expect(buffers).toHaveLength(0);
    expect(r.stats.warnings.join()).toMatch(/Frame cannot be rendered/);
    await expect(Renderer.prototype.settled.call(r as unknown as Renderer)).rejects.toThrow(/Frame cannot be rendered/);
    Renderer.prototype.resize.call(r as unknown as Renderer, 4125, 414, 1);
    expect(r.frameRefusal).toBeNull(); expect(r.stats.warnings).toEqual([]);
    expect(textures.length).toBeGreaterThan(0);
    for (const t of textures) expect(Math.max(...t.size)).toBeLessThanOrEqual(baseline.maxTextureDimension2D);
    for (const b of buffers) expect(b.size).toBeLessThanOrEqual(baseline.maxStorageBufferBindingSize);
  } finally { vi.unstubAllGlobals(); }
});
