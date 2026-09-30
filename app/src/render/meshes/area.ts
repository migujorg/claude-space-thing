// Rotation-mean projected (silhouette) area of a closed mesh, for the energy normalization of a shape model
// (docs/rendering-shapes.md §3): the disk photometry (geometric albedo p with a reference radius R, phase
// function Φ) describes the brightness of a body whose mean projected area is πR². A mesh redistributes that
// light over its own silhouette, so its radiance prefactor is scaled by πR² / ⟨A_proj⟩.
//
// ⟨A_proj⟩ is estimated by rasterizing the mesh's silhouette onto a G×G grid from N directions spread over a
// hemisphere (the silhouette seen from −u equals that from u). For a convex body it equals area/4 (Cauchy); for a
// non-convex one (a contact binary) it is smaller.

export interface ProjectedAreaOptions {
  directions?: number;
  grid?: number;
}

/** Fibonacci points on the upper hemisphere (z > 0). */
export function hemisphereDirections(n: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const z = 1 - (i + 0.5) / n;
    const r = Math.sqrt(1 - z * z);
    out.push([r * Math.cos(ga * i), r * Math.sin(ga * i), z]);
  }
  return out;
}

export function projectedArea(pos: Float32Array, idx: ArrayLike<number>, nf: number, u: [number, number, number], bound: number, grid: number): number {
  // orthonormal basis ⊥ u
  const h: [number, number, number] = Math.abs(u[0]) < 0.6 ? [1, 0, 0] : [0, 1, 0];
  let e1: [number, number, number] = [u[1] * h[2] - u[2] * h[1], u[2] * h[0] - u[0] * h[2], u[0] * h[1] - u[1] * h[0]];
  const l1 = Math.hypot(...e1);
  e1 = [e1[0] / l1, e1[1] / l1, e1[2] / l1];
  const e2: [number, number, number] = [u[1] * e1[2] - u[2] * e1[1], u[2] * e1[0] - u[0] * e1[2], u[0] * e1[1] - u[1] * e1[0]];
  const nv = pos.length / 3;
  const px = new Float64Array(nv), py = new Float64Array(nv);
  const s = grid / (2 * bound);
  for (let i = 0; i < nv; i++) {
    const x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2];
    px[i] = (x * e1[0] + y * e1[1] + z * e1[2] + bound) * s;
    py[i] = (x * e2[0] + y * e2[1] + z * e2[2] + bound) * s;
  }
  const cov = new Uint8Array(grid * grid);
  for (let f = 0; f < nf; f++) {
    const a = idx[3 * f], b = idx[3 * f + 1], c = idx[3 * f + 2];
    const ax = px[a], ay = py[a], bx = px[b], by = py[b], cx = px[c], cy = py[c];
    const area2 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (area2 === 0) continue;
    const sg = area2 > 0 ? 1 : -1;
    const x0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - 0.5)), x1 = Math.min(grid - 1, Math.floor(Math.max(ax, bx, cx) - 0.5));
    const y0 = Math.max(0, Math.ceil(Math.min(ay, by, cy) - 0.5)), y1 = Math.min(grid - 1, Math.floor(Math.max(ay, by, cy) - 0.5));
    for (let j = y0; j <= y1; j++) {
      const yc = j + 0.5;
      for (let i = x0; i <= x1; i++) {
        const xc = i + 0.5;
        const w0 = sg * ((bx - ax) * (yc - ay) - (by - ay) * (xc - ax));
        const w1 = sg * ((cx - bx) * (yc - by) - (cy - by) * (xc - bx));
        const w2 = sg * ((ax - cx) * (yc - cy) - (ay - cy) * (xc - cx));
        if (w0 >= 0 && w1 >= 0 && w2 >= 0) cov[j * grid + i] = 1;
      }
    }
  }
  let n = 0;
  for (let i = 0; i < cov.length; i++) n += cov[i];
  return n / (s * s);
}

/** Mean silhouette area over directions (model units²). */
export function meanProjectedArea(pos: Float32Array, idx: ArrayLike<number>, nf: number, bound: number, opts: ProjectedAreaOptions = {}): number {
  const dirs = hemisphereDirections(opts.directions ?? 48);
  const grid = opts.grid ?? 192;
  let sum = 0;
  for (const u of dirs) sum += projectedArea(pos, idx, nf, u, bound * 1.001, grid);
  return sum / dirs.length;
}
