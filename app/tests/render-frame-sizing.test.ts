import { describe, expect, it } from 'vitest';
import { aerialPerspectiveSize, type FrameLimits } from '../src/render/frameSizing';

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
