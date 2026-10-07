// Precomputes an atmosphere's tables off the main thread (a few seconds of CPU; atmosphere.ts).
import { precomputeAtmosphere, type AtmosphereModel } from './atmosphere';

const ctx = self as unknown as { onmessage: ((e: MessageEvent<{ id: number; model: AtmosphereModel }>) => void) | null; postMessage(m: unknown, transfer: Transferable[]): void };

ctx.onmessage = (e) => {
  const { id, model } = e.data;
  const t = precomputeAtmosphere(model);
  const buffers = [t.transmittance.buffer, t.multiScattering.buffer, t.skyIrradiance.buffer, t.profile.buffer];
  if (t.msSource) buffers.push(t.msSource.buffer);
  ctx.postMessage({ id, tables: t }, buffers);
};
