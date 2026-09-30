// Body orientation for the shell: core's OrientationSet (precise orient/* products preferred over the IAU
// model) when injected, else an IAU-only fallback with the same interface and semantics.

import type { Body, OrientationHeader } from '../data/schema';
import type { CoreDeps, Mat3, OrientationSetPort, OrientationSourcePort, PreciseOrientationPort } from './ports';

/** IAU-model-only OrientationSet (used when core's precise classes are not injected, e.g. the UI dev page). */
export class IauOrientationSet implements OrientationSetPort {
  private readonly rot = new Map<number, Body['rotation']>();
  constructor(bodies: Iterable<Body>, private readonly bodyToIcrf: CoreDeps['bodyToIcrf']) {
    for (const b of bodies) if (b.rotation?.value && b.rotation.label !== 'unknown') this.rot.set(b.id, b.rotation);
  }
  add(_p: PreciseOrientationPort): void {
    throw new Error('precise orientation products need core OrientationSet/PreciseOrientation');
  }
  orientation(id: number, et: number): Mat3 | null {
    const r = this.rot.get(id);
    return r?.value && Number.isFinite(et) ? this.bodyToIcrf(r.value, et) : null;
  }
  provenance(id: number, et: number): OrientationSourcePort | null {
    const r = this.rot.get(id);
    if (!r || !Number.isFinite(et)) return null;
    return { kind: 'iau', label: r.label, sources: [...r.sources], frame: 'IAU', method: r.method, uncertainty: r.uncertainty };
  }
}

export interface OrientationBuild {
  set: OrientationSetPort;
  /** Problems with individual products (shown in the Data panel); the product is skipped. */
  errors: string[];
  /** Products that were added. */
  loaded: string[];
}

export function buildOrientation(
  core: Pick<CoreDeps, 'OrientationSet' | 'PreciseOrientation' | 'bodyToIcrf'>,
  bodies: Body[],
  products: { path: string; header: OrientationHeader; data: Float64Array }[],
): OrientationBuild {
  const errors: string[] = [];
  const loaded: string[] = [];
  if (!core.OrientationSet || !core.PreciseOrientation) {
    if (products.length) errors.push(`${products.map((p) => p.path).join(', ')}: precise orientation unavailable in this build (IAU models used).`);
    return { set: new IauOrientationSet(bodies, core.bodyToIcrf), errors, loaded };
  }
  const set = new core.OrientationSet(bodies);
  for (const p of products) {
    try {
      set.add(new core.PreciseOrientation(p.header, p.data));
      loaded.push(p.path);
    } catch (e) {
      errors.push(`${p.path} could not be used: ${(e as Error).message ?? e}`);
    }
  }
  return { set, errors, loaded };
}
