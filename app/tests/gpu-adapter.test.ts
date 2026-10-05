import { describe, expect, it, vi } from 'vitest';
import { requestRenderingAdapter } from '../src/render/adapter';

describe('rendering adapter selection', () => {
  it('uses the high performance adapter when available', async () => {
    const adapter = {} as GPUAdapter;
    const requestAdapter = vi.fn().mockResolvedValue(adapter);
    expect(await requestRenderingAdapter({ requestAdapter } as unknown as GPU)).toBe(adapter);
    expect(requestAdapter).toHaveBeenCalledOnce();
    expect(requestAdapter).toHaveBeenCalledWith({ powerPreference: 'high-performance' });
  });

  it('tries the default adapter when the preferred GPU is unavailable', async () => {
    const adapter = {} as GPUAdapter;
    const requestAdapter = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(adapter);
    expect(await requestRenderingAdapter({ requestAdapter } as unknown as GPU)).toBe(adapter);
    expect(requestAdapter).toHaveBeenNthCalledWith(2);
  });

  it('gives an actionable error when both choices are unavailable', async () => {
    const requestAdapter = vi.fn().mockResolvedValue(null);
    await expect(requestRenderingAdapter({ requestAdapter } as unknown as GPU)).rejects.toThrow('open-workstation.sh');
    expect(requestAdapter).toHaveBeenCalledTimes(2);
  });
});
