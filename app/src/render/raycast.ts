// Precision-conditioned ray casting of ellipsoids (docs/architecture.md §3.3).
//
// Positions arrive camera-relative in float64. For each body the CPU builds, in float64, the matrix
// M = S⁻¹·Rᵀ that maps world vectors into the body's "unit-sphere" frame, and one of two ray
// parametrisations whose float32 evaluation is well conditioned:
//
//  FAR  (D ≥ 3·R_max): rays d = n + x·e1 + y·e2 through a screen-space quad around the body, with
//       (x, y) small tangent-plane offsets interpolated by the rasteriser. The ray is re-based at its
//       crossing of the tangent plane through the body centre, q' = x·E1 + y·E2 with E1 = D·M·e1,
//       E2 = D·M·e2 (all O(1)), so the quadratic |q' + s·d'|² = 1 has O(1) coefficients no matter
//       how far away the body is (1 m … 50 AU). World ray parameter t = D + s.
//  NEAR (D < 3·R_max): full-screen rays from the camera, o' = M·(−p) and c = |o'|² − 1 computed in
//       float64 on the CPU, so a camera 1 m above the surface still gets an accurate horizon.
//
// This module is the float64 reference; the WGSL body shader implements the same equations.

export type V3 = [number, number, number];
export type M3 = [number, number, number, number, number, number, number, number, number];

export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const len = (a: V3) => Math.sqrt(dot(a, a));
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const normalize = (a: V3): V3 => scale(a, 1 / len(a));
export const mulMV = (m: M3, v: V3): V3 => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
/** Mᵀ·v */
export const mulMtV = (m: M3, v: V3): V3 => [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]];

/** Orthonormal basis (e1, e2) perpendicular to unit n. */
export function tangentBasis(n: V3): [V3, V3] {
  const h: V3 = Math.abs(n[0]) < 0.6 ? [1, 0, 0] : Math.abs(n[1]) < 0.6 ? [0, 1, 0] : [0, 0, 1];
  const e1 = normalize(cross(n, h));
  const e2 = cross(n, e1);
  return [e1, e2];
}

export interface BodyFrame {
  /** Camera-relative centre, km. */
  pos: V3;
  radii: V3;
  rMax: number;
  D: number;
  /** World → unit-sphere frame, M = S⁻¹·Rᵀ (1/km). */
  M: M3;
  /** Unit-sphere frame → world (km), M⁻¹ = R·S. */
  Mi: M3;
  near: boolean;
  /** FAR: direction to centre, tangent basis, and the conditioned vectors. */
  n: V3;
  e1: V3;
  e2: V3;
  ns: V3; // M·n (1/km)
  E1: V3; // D·M·e1
  E2: V3; // D·M·e2
  /** Half-extent of the tangent-plane quad covering the bounding sphere (tan units). */
  beta: number;
  /** NEAR: camera in the unit-sphere frame, and |o'|² − 1. */
  o: V3;
  c: number;
}

/**
 * @param orient body-fixed → ICRF rotation (row-major) or null (orientation unknown: the caller
 *   passes equal radii so orientation is irrelevant)
 */
export function prepareBody(pos: V3, radii: V3, orient: M3 | null, extraBetaRad = 0): BodyFrame {
  const R: M3 = orient ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
  // M[i][j] = R[j][i] / radii[i];  Mi[i][j] = R[i][j]·radii[j]
  const M: M3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const Mi: M3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    M[i * 3 + j] = R[j * 3 + i] / radii[i];
    Mi[i * 3 + j] = R[i * 3 + j] * radii[j];
  }
  const D = len(pos);
  const rMax = Math.max(radii[0], radii[1], radii[2]);
  const n = scale(pos, 1 / D);
  const [e1, e2] = tangentBasis(n);
  const sinR = Math.min(rMax / D, 1);
  const beta = Math.tan(Math.min(Math.asin(sinR) + extraBetaRad, 1.4));
  const o = mulMV(M, scale(pos, -1));
  return {
    pos, radii, rMax, D, M, Mi,
    near: D < 3 * rMax,
    n, e1, e2,
    ns: mulMV(M, n),
    E1: scale(mulMV(M, e1), D),
    E2: scale(mulMV(M, e2), D),
    beta,
    o,
    c: dot(o, o) - 1,
  };
}

export interface Hit {
  /** World ray parameter: hit = t·d (d as passed / constructed, unnormalised for FAR). */
  t: number;
  /** Hit point in the unit-sphere frame. */
  h: V3;
  /** Discriminant (≥ 0 on the body); used for edge coverage. */
  disc: number;
}

/** FAR path for tangent-plane coordinates (x, y). World ray direction is n + x·e1 + y·e2. */
export function farHit(b: BodyFrame, x: number, y: number): Hit {
  const q = add(scale(b.E1, x), scale(b.E2, y));
  const d = add(b.ns, scale(q, 1 / b.D));
  const A = dot(d, d);
  const B = dot(q, d);
  const C = dot(q, q) - 1;
  const disc = B * B - A * C;
  const s = (-B - Math.sqrt(Math.max(disc, 0))) / A;
  return { t: b.D + s, h: add(q, scale(d, s)), disc };
}

/** NEAR path for a world ray direction (any length). */
export function nearHit(b: BodyFrame, dir: V3): Hit {
  const d = mulMV(b.M, dir);
  const A = dot(d, d);
  const B = dot(b.o, d);
  const disc = B * B - A * b.c;
  const sq = Math.sqrt(Math.max(disc, 0));
  // Stable nearest root for a camera outside the body (c > 0) looking toward it (B < 0).
  const t = B < 0 ? b.c / (-B + sq) : (-B - sq) / A;
  return { t, h: add(b.o, scale(d, t)), disc };
}

/** Outward world normal at a unit-sphere-frame point: ∝ Mᵀ·h (= R·S⁻¹·h). */
export function worldNormal(b: BodyFrame, h: V3): V3 {
  return normalize(mulMtV(b.M, h));
}
