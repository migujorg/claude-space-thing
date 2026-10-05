/** Prefer the discrete GPU, but accept a working default adapter on hybrid systems. */
export async function requestRenderingAdapter(gpu: GPU | undefined): Promise<GPUAdapter> {
  if (!gpu) throw new Error('WebGPU is not available in this browser');
  const preferred = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (preferred) return preferred;
  const fallback = await gpu.requestAdapter();
  if (fallback) return fallback;
  throw new Error('No WebGPU adapter. Enable graphics acceleration and WebGPU in your browser; on Linux use open-workstation.sh');
}
