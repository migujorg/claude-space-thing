/** CPU investigation only; no renderer imports this module.
 * Unit sphere, orthographic view, uniform map and collimated sunlight. Pixel centres
 * are integers; derivatives are paired 2x2-quad differences of the discriminant.
 * This isolates footprint sampling, not perspective, textures, shadows or GPU accuracy.
 */
import { rasterShaderLaw } from './raster-law-twin';
import { gaussLegendre, LAW, lawRadf, type ResolvedLaw } from './spatial';

export type RasterRule = 'bounded' | 'unbounded' | 'sliver' | 'footprint';
export interface RasterOptions {
  radius: number;
  alpha: number;
  offset?: [number, number];
  rule: RasterRule;
  /** Coordinate rotation about body y; exercises cancellation in the f32 normal dot. */
  rotation?: number;
  /** f32 geometry and scalar law operations are the default. */
  f32?: boolean;
  order?: number;
  /** Footprint total can be integrated without materialising every pixel. */
  pixels?: boolean;
}
export interface RasterResult {
  sum: number;
  maxPixel: number;
  nonfinite: number;
  evaluated: number;
  pixels?: Map<string, number>;
}

/** Projected-strip mean of mu^(k-1), at CONSTANT incidence. k=1 is removable. */
export function sliverCosine(m: number, k: number): number {
  return m * Math.exp(k === 1 ? -0.5 : -Math.log1p((k - 1) / 2) / (k - 1));
}

/** Published expressions, with the Barkstrom emission floor removed as well. */
export function publishedRadf(law: ResolvedLaw, mu0: number, mu: number, alpha: number): number {
  if (!(mu0 > 0) || !(mu > 0)) return 0;
  if (law.kind === LAW.barkstrom) return ((mu0 * mu) / (mu0 + mu)) ** law.p / mu;
  return lawRadf(law, mu0, mu, alpha);
}

export function rasterDisk(law: ResolvedLaw, options: RasterOptions): RasterResult {
  if (!(options.radius >= 1) || !(options.alpha >= 0 && options.alpha < Math.PI)) throw new Error('Expected radius >= 1 and 0 <= phase < pi');
  if (options.rule === 'footprint') return footprintDisk(law, options);
  const R = options.radius, [ox, oy] = options.offset ?? [0, 0];
  const f = options.f32 === false ? (v: number) => v : Math.fround;
  const sa = Math.sin(options.alpha), ca = Math.cos(options.alpha);
  const evaluate = rasterShaderLaw(law, options.rule === 'bounded' ? {} : { minnaertFloor: 0, barkstromFloor: 0 }, f);
  const c = f(Math.cos(options.rotation ?? 0.37)), s = f(Math.sin(options.rotation ?? 0.37));
  const disc = (i: number, j: number) => {
    const x = f((i - ox) / R), y = f((j - oy) / R);
    return f(1 - f(f(x * x) + f(y * y)));
  };
  const out: RasterResult = { sum: 0, maxPixel: 0, nonfinite: 0, evaluated: 0 };
  for (let j = Math.floor(oy - R - 1); j <= Math.ceil(oy + R + 1); j++) {
    // Analytic circle-row limits discard only the empty part of the bounding quad.
    const rowRadius = Math.sqrt(Math.max(0, R * R - Math.max(0, Math.abs(j - oy) - 2) ** 2));
    const centreRadius = Math.sqrt(Math.max(0, R * R - (j - oy) ** 2));
    const left = ca < 0 ? -ca * centreRadius : -rowRadius;
    for (let i = Math.floor(ox + left - 2); i <= Math.ceil(ox + rowRadius + 2); i++) {
      const D = disc(i, j);
      const fw = f(Math.abs(f(disc(i + (i % 2 === 0 ? 1 : -1), j) - D))
        + Math.abs(f(disc(i, j + (j % 2 === 0 ? 1 : -1)) - D)));
      const cov = Math.max(0, Math.min(1, f(0.5 + f(D / Math.max(fw, f(1e-30))))));
      if (cov === 0) continue;
      let x = f((i - ox) / R), y = f((j - oy) / R), z = f(Math.sqrt(Math.max(D, 0)));
      if (options.rule === 'sliver' && cov < 1) {
        const m = Math.sqrt(Math.min(1, Math.max(0, D + fw / 2)));
        z = law.kind === LAW.minnaert || law.kind === LAW.barkstrom ? sliverCosine(m, law.p) : 2 * m / 3;
        const radial = Math.hypot(x, y);
        const scale = Math.sqrt(Math.max(0, 1 - z * z)) / (radial || 1);
        x *= scale; y *= scale;
      }
      // Rotate hit into body coordinates and transpose it back, as m0..m2 do.
      // Closest-approach rays (D<0) retain z=0 before those f32 operations.
      const bx = f(f(c * x) + f(s * z)), bz = f(f(-s * x) + f(c * z));
      const nx = f(f(c * bx) - f(s * bz)), nz = f(f(s * bx) + f(c * bz));
      const len = f(Math.sqrt(f(f(nx * nx) + f(f(y * y) + f(nz * nz)))));
      const mu = f(nz / len), mu0 = f(f(f(nx / len) * f(sa)) + f(mu * f(ca)));
      const value = f(cov * evaluate(mu0, mu, options.alpha));
      out.evaluated++;
      if (!Number.isFinite(value)) out.nonfinite++;
      out.sum += value; out.maxPixel = Math.max(out.maxPixel, value);
    }
  }
  return out;
}

/** Reference: integrate the lit intersection of each ACTUAL square pixel with the disk.
 * y=sin(beta), x=cos(beta)cos(eps); mu=cos(beta)sin(eps).
 * Split at pixel boundaries, their circle/terminator tangencies, and i=e.
 * Sine endpoint maps keep quadrature nodes strictly inside; no cosine floor.
 * `pixels:false` omits x/y pixel cuts: the partition theorem gives the total,
 * but that mode makes no claim about individual pixel accuracy or cost.
 */
function footprintDisk(law: ResolvedLaw, o: RasterOptions): RasterResult {
  const R = o.radius, [ox, oy] = o.offset ?? [0, 0], n = o.order ?? 24;
  const delta = Math.PI - o.alpha, ca = Math.cos(o.alpha), { x: nodes, w } = gaussLegendre(n);
  const emit = o.pixels !== false;
  const pixels = emit ? new Map<string, number>() : undefined;
  const ys = [-1, 1];
  const xEdges: number[] = [];
  if (emit) {
    for (let i = Math.floor(ox - R); i <= Math.ceil(ox + R); i++) {
      const x = (i + 0.5 - ox) / R;
      if (Math.abs(x) >= 1) continue;
      xEdges.push(x);
      // Where the limb or terminator meets this vertical edge.
      for (const a of [1, -1, -ca]) if (a !== 0 && x / a > 0 && x / a < 1) {
        const y = Math.sqrt(1 - (x / a) ** 2); ys.push(-y, y);
      }
    }
    for (let j = Math.floor(oy - R); j <= Math.ceil(oy + R); j++) {
      const y = (j + 0.5 - oy) / R;
      if (Math.abs(y) < 1) ys.push(y);
    }
  }
  // Equator split and Akimov phase-dependent latitude concentration.
  ys.push(0);
  const cuts = [...new Set(ys)].sort((a, b) => a - b);
  const out: RasterResult = { sum: 0, maxPixel: 0, nonfinite: 0, evaluated: 0, pixels };
  const scale = law.kind === LAW.akimov ? Math.sqrt(delta / Math.PI) : 1;
  const toU = (y: number) => Math.atan(Math.tan(Math.asin(y)) / scale);
  for (let row = 1; row < cuts.length; row++) {
    const lo = toU(cuts[row - 1]), hi = toU(cuts[row]), half = (hi - lo) / 2;
    for (let q = 0; q < n; q++) {
      const u = (lo + hi) / 2 + half * nodes[q], t = Math.tan(u);
      const beta = Math.atan(scale * t), cb = Math.cos(beta), y = Math.sin(beta);
      const wy = half * w[q] * scale * (1 + t * t) / (1 + scale * scale * t * t);
      const epsCuts = [0, delta / 2, delta];
      if (emit) for (const edge of xEdges) {
        if (Math.abs(edge) < cb) {
          const eps = Math.acos(edge / cb);
          if (eps > 0 && eps < delta) epsCuts.push(eps);
        }
      }
      epsCuts.sort((a, b) => a - b);
      for (let col = 1; col < epsCuts.length; col++) {
        const a = epsCuts[col - 1], b = epsCuts[col], h = (b - a) / 2;
        if (h === 0) continue;
        const mid = (a + b) / 2;
        const key = `${Math.floor(R * cb * Math.cos(mid) + ox + 0.5)},${Math.floor(R * y + oy + 0.5)}`;
        let v = 0;
        for (let p = 0; p < n; p++) {
          const angle = nodes[p] * Math.PI / 2, eps = mid + h * Math.sin(angle);
          const mu = cb * Math.sin(eps), mu0 = cb * Math.sin(delta - eps);
          const value = publishedRadf(law, mu0, mu, o.alpha) * R * R * mu * cb
            * h * Math.PI / 2 * Math.cos(angle) * w[p] * wy;
          if (!Number.isFinite(value)) out.nonfinite++;
          v += value; out.evaluated++;
        }
        out.sum += v;
        if (pixels) pixels.set(key, (pixels.get(key) ?? 0) + v);
      }
    }
  }
  if (pixels) for (const v of pixels.values()) out.maxPixel = Math.max(out.maxPixel, v);
  return out;
}
