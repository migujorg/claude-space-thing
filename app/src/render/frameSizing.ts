import { fovealSumsSize } from '../eye/acuity';

/** GPU allocation geometry only: these sampling choices do not describe the universe. */
export type FrameLimits = Pick<GPUSupportedLimits, 'maxTextureDimension2D' | 'maxTextureDimension3D' |
  'maxBufferSize' | 'maxStorageBufferBindingSize' | 'maxComputeWorkgroupsPerDimension'>;

/** Rows of square aerial-perspective columns, with at least two pixels per column. */
const AP_ROWS = 270;

/** Reduced-resolution 2D targets, optionally including interpolation border texels. */
export function sampledFrameSize(W: number, H: number, scale: number, border = 0) {
  return { w: Math.max(1, Math.ceil(W / scale)) + border, h: Math.max(1, Math.ceil(H / scale)) + border };
}

export function aerialPerspectiveSize(W: number, H: number, slices: number, K4: number, limits: FrameLimits) {
  const depth = slices * (1 + K4);
  // Keep every spectral/altitude slice: null selects the existing per-pixel march instead.
  if (depth > limits.maxTextureDimension3D) return null;
  const maxColumns = Math.min(limits.maxTextureDimension3D, 8 * limits.maxComputeWorkgroupsPerDimension);
  const colPx = Math.max(2, Math.ceil(H / AP_ROWS), Math.ceil(W / maxColumns), Math.ceil(H / maxColumns));
  return { colPx, nx: Math.ceil(W / colPx), ny: Math.ceil(H / colPx), depth };
}

export type SizeResult<T> = { ok: true; size: T } | { ok: false; warning: string };
const refuse = (why: string): SizeResult<never> => ({ ok: false, warning: `Frame cannot be rendered: ${why}. Reduce the viewport or device pixel ratio.` });

/** Allocation and dispatch dimensions shared by all full-frame passes. A refused plan allocates nothing. */
export function frameSize(W: number, H: number, limits: FrameLimits, adaptTilePx: number) {
  if (![W, H].every((n) => Number.isSafeInteger(n) && n > 0)) return refuse(`invalid size ${W} × ${H}`);
  if (Math.max(W, H) > limits.maxTextureDimension2D) return refuse(`${W} × ${H} exceeds maxTextureDimension2D ${limits.maxTextureDimension2D}`);
  const tilesX = Math.ceil(W / adaptTilePx), tilesY = Math.ceil(H / adaptTilePx);
  const adaptationBytes = tilesX * tilesY * 64 * 16;
  const storageLimit = Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize);
  if (adaptationBytes > storageLimit) return refuse(`adaptation buffers need ${adaptationBytes} bytes, exceeding the storage/buffer limit ${storageLimit}`);
  const compute = { x: Math.ceil(W / 8), y: Math.ceil(H / 8) };
  if (Math.max(compute.x, compute.y, tilesX, tilesY) > limits.maxComputeWorkgroupsPerDimension) return refuse(`compute dispatch exceeds maxComputeWorkgroupsPerDimension ${limits.maxComputeWorkgroupsPerDimension}`);
  const levels: { w: number; h: number }[] = [];
  let w = W, h = H;
  for (;;) {
    levels.push({ w, h });
    if (w === 1 && h === 1) break;
    w = Math.max(1, Math.ceil(w / 2)); h = Math.max(1, Math.ceil(h / 2));
  }
  const acuW = levels[1]?.w ?? 1, acuH = levels[1]?.h ?? 1;
  const acuMips = Math.max(1, Math.min(levels.length - 1, Math.floor(Math.log2(Math.max(acuW, acuH))) + 1));
  // The fovea's block sums for the acuity filter: one texel per adaptation invocation (8 × 8 per tile), sides
  // rounded up to powers of two (eye/acuity.ts fovealSumsSize), mips down to 1 × 1.
  const [fovW, fovH] = fovealSumsSize(tilesX * 8, tilesY * 8);
  if (Math.max(fovW, fovH) > limits.maxTextureDimension2D) return refuse(`the fovea's block sums need ${fovW} × ${fovH} texels, exceeding maxTextureDimension2D ${limits.maxTextureDimension2D}`);
  let fovMips = 1;
  for (let n = Math.max(fovW, fovH); n > 1; n >>= 1) fovMips++;
  return { ok: true as const, size: { W, H, levels, tilesX, tilesY, adaptationBytes, compute, acuW, acuH, acuMips, fovW, fovH, fovMips } };
}

/** Reject an optional diagnostic rather than invalidate the rendered frame. GPU row copies align to 256 bytes. */
export function readbackSize(W: number, H: number, bytesPerPixel: number, storage: boolean, limits: FrameLimits): SizeResult<{ bytes: number; bytesPerRow: number }> {
  const bytesPerRow = storage ? W * bytesPerPixel : Math.ceil(W * bytesPerPixel / 256) * 256;
  const bytes = bytesPerRow * H;
  const limit = storage ? Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize) : limits.maxBufferSize;
  if (!Number.isSafeInteger(bytes) || bytes > limit) return { ok: false, warning: `Readback needs ${bytes} bytes, exceeding ${storage ? 'storage/buffer' : 'buffer'} limit ${limit}; read a smaller region.` };
  if (storage && Math.max(Math.ceil(W / 8), Math.ceil(H / 8)) > limits.maxComputeWorkgroupsPerDimension) return { ok: false, warning: 'Readback exceeds maxComputeWorkgroupsPerDimension; read a smaller region.' };
  return { ok: true, size: { bytes, bytesPerRow } };
}

/** Request supported limits rather than guessed hardware capabilities. */
export function requiredFrameLimits(limits: FrameLimits): FrameLimits {
  return {
    maxTextureDimension2D: limits.maxTextureDimension2D,
    maxTextureDimension3D: limits.maxTextureDimension3D,
    maxBufferSize: limits.maxBufferSize,
    maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize,
    maxComputeWorkgroupsPerDimension: limits.maxComputeWorkgroupsPerDimension,
  };
}
