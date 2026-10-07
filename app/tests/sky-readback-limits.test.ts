import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkyBackground } from '../src/render/sky/background';

// Exercise the diagnostic entry points without constructing GPU pipelines or allocating real textures.
function background(w: number, h: number, maxBufferSize: number, data = new ArrayBuffer(512)) {
  const buffer = { mapAsync: vi.fn().mockResolvedValue(undefined), getMappedRange: () => data, unmap: vi.fn(), destroy: vi.fn() };
  const enc = { copyTextureToBuffer: vi.fn(), finish: vi.fn() };
  const device = { limits: { maxBufferSize }, createBuffer: vi.fn(() => buffer), createCommandEncoder: vi.fn(() => enc), queue: { submit: vi.fn() } };
  const sky = Object.assign(Object.create(SkyBackground.prototype), {
    device, corTex: { width: w, height: h }, zodiTex: { width: w, height: h }, zodiOn: true,
  }) as SkyBackground;
  vi.stubGlobal('GPUBufferUsage', { COPY_DST: 1, MAP_READ: 2 });
  vi.stubGlobal('GPUMapMode', { READ: 1 });
  return { sky, device, enc, buffer };
}

afterEach(() => vi.unstubAllGlobals());

describe('sky diagnostic staging limits', () => {
  it.each(['corona', 'zodi'] as const)('%s refuses padded rows above maxBufferSize before allocation or submission', async (kind) => {
    // 17 texels: rgba16float pads to 256 bytes/row, rgba32float to 512.
    const bpr = kind === 'corona' ? 256 : 512;
    const { sky, device } = background(17, 2, bpr * 2 - 1);
    const read = kind === 'corona' ? sky.readCoronaK([[0, 0]]) : sky.readZodi();
    await expect(read).rejects.toThrow(RangeError);
    await expect(read).rejects.toThrow(`Readback needs ${bpr * 2} bytes`);
    expect(device.createBuffer).not.toHaveBeenCalled();
    expect(device.createCommandEncoder).not.toHaveBeenCalled();
    expect(device.queue.submit).not.toHaveBeenCalled();
  });

  it('corona accepts the exact buffer limit and decodes half floats across padded rows', async () => {
    const data = new ArrayBuffer(512);
    new Uint16Array(data).set([0x3c00, 0x4000, 0x4200, 0x4400], 128 + 4);
    const { sky, device, enc, buffer } = background(17, 2, 512, data);
    expect(await sky.readCoronaK([[1, 1]])).toEqual([[1, 2, 3, 4]]);
    expect(device.createBuffer).toHaveBeenCalledWith({ size: 512, usage: 3 });
    expect(enc.copyTextureToBuffer.mock.calls[0][1].bytesPerRow).toBe(256);
    expect(buffer.destroy).toHaveBeenCalledOnce();
  });

  it('zodiacal accepts the exact buffer limit and removes row padding', async () => {
    const data = new ArrayBuffer(1024);
    new Float32Array(data).set([1, 2, 3, 4], 128);
    const { sky, device, enc, buffer } = background(17, 2, 1024, data);
    const result = await sky.readZodi();
    expect(result?.w).toBe(17);
    expect(result?.h).toBe(2);
    expect(result?.data.length).toBe(17 * 2 * 4);
    expect(Array.from(result!.data.slice(68, 72))).toEqual([1, 2, 3, 4]);
    expect(device.createBuffer).toHaveBeenCalledWith({ size: 1024, usage: 3 });
    expect(enc.copyTextureToBuffer.mock.calls[0][1].bytesPerRow).toBe(512);
    expect(buffer.destroy).toHaveBeenCalledOnce();
  });
});
