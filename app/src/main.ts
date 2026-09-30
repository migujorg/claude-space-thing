// Entry point. Wiring only; see docs/architecture.md §5.1 for module layout.
async function main(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  if (!navigator.gpu) {
    document.body.insertAdjacentHTML('beforeend', '<p style="position:fixed;top:1em;left:1em">WebGPU is not available in this browser.</p>');
    return;
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter');
  const device = await adapter.requestDevice();
  const ctx = canvas.getContext('webgpu')!;
  ctx.configure({ device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: 'opaque' });
  const enc = device.createCommandEncoder();
  enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] }).end();
  device.queue.submit([enc.finish()]);
  (window as any).__frameReady = true;
}

main().catch((e) => {
  console.error(e);
  (window as any).__frameError = String(e);
});
