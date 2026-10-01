// Earth's own light at night: airglow and aurora (docs/reports/nightglow.md, docs/rendering-earth.md §9).
//
// The emission is an additional source term of the Earth's atmosphere: for every pixel the view ray is followed
// through the emission shell (up to 600 km) and the volume emission along it is summed, in absolute luminance
// (X, Y, Z cd/m², S scotopic cd/m²; architecture §4.1). The solid Earth ends the ray. Light that crosses the lower
// atmosphere on its way to the camera (a far-side layer seen below the limb, or any layer seen from the ground) is
// attenuated spectrally with the atmosphere's own transmittance table, per 40 nm bin (atmosphere.ts).
//
// Airglow: Gaussian layers in altitude above the ellipsoid. Each layer is integrated on each side of the ray's
// closest approach to the Earth's centre (the tangent point) with an 8-node Gauss–Legendre rule in x, r = r_t + x²,
// which takes the square-root singularity of ds/dr at the tangent out of the integrand (s = x·√(2r_t + x²)): the
// same nodes give a face-on column and the limb's path enhancement (about 50× for the mesopause layers). The night
// domain (solar zenith angle at the ground point > 100°) is evaluated at every node; the local time (UT +
// longitude/15) and the ellipsoid's radius exactly at the two ends of each layer crossing, linear in between.
//
// Aurora: the ray segments inside the shell and inside the auroral caps (dipole latitude ≥ 40°) are marched; per
// step the precipitation (OVATION Prime 2010 at the step's magnetic latitude and local time) and the emission table
// of its mean energy give the light of three line groups. Within a step the altitude is taken linear in path length
// and the emission is integrated exactly in altitude from a cumulative table ((C(h₂) − C(h₁))·Δs/Δh), so layers
// thinner than a step are neither missed nor aliased.
//
// Cost: the emission is computed at 1/NIGHTGLOW_SCALE resolution in a pass of its own and added at full resolution
// (bilinear), depth-tested at the shell's near entry.

import type { AtmosphereBinding } from './atmosphereGpu';
import { SAMPLES_PER_BIN } from './atmosphere';
import { ATMOSPHERE_WGSL, ATM_K4_MAX } from './shaders-atmosphere';
import { BODY_COMMON, COMMON } from './shaders';
import { numberToF16 } from './surface';
import type { SceneNightglow } from './scene';
import type { M3, V3 } from './raycast';

/** Gauss–Legendre nodes and weights on [−1, 1] (8 points). */
export const GL8_X = [-0.9602898564975363, -0.7966664774136267, -0.525532409916329, -0.1834346424956498, 0.1834346424956498, 0.525532409916329, 0.7966664774136267, 0.9602898564975363];
export const GL8_W = [0.1012285362903763, 0.2223810344533745, 0.3137066458778873, 0.3626837833783620, 0.3626837833783620, 0.3137066458778873, 0.2223810344533745, 0.1012285362903763];
/** A layer is integrated over its centre ± this many σ (the Gaussian beyond holds 6·10⁻⁵ of the column). */
export const LAYER_EXTENT_SIGMA = 4;
/** Auroral caps: the aurora is searched where the centred-dipole latitude is at least this (OVATION's grid starts at
 * 50° AACGM latitude; the margin covers the difference between the two). */
export const AURORA_CAP_DIPOLE_LAT_DEG = 40;
/** Steps of the aurora march per pixel (a numerical resolution). */
export const AURORA_STEPS = 48;
/** Shader limits. */
export const NG_MAX_LAYERS = 12;
export const NG_MAX_LT = 16;
/** vec4 per (layer, local-time node) or line group in the table buffer: folded XYZS, then 4 channels × ATM_K4_MAX bin groups. */
export const NG_STRIDE = 1 + 4 * ATM_K4_MAX;
/** Mean energy per unit (energy flux / number flux): keV per (erg / 10⁸ electrons) = 10⁻⁸ erg / 1.602176634·10⁻⁹ erg. */
export const KEV_PER_ERG_PER_1E8 = 1e-8 / 1.602176634e-9;

// ── CPU twin (tests, docs) ─────────────────────────────────────────────────────────────────────────────────

/** Radiance of 1 rayleigh: 10¹⁰/(4π) photons m⁻² s⁻¹ sr⁻¹ (Hunten, Roach & Chamberlain 1956). */
export const PHOTON_RADIANCE_PER_R = 1e10 / (4 * Math.PI);

/**
 * ∫ v(h(u)) du of a Gaussian layer (normalised: a vertical path through it gives 1) along one side of a straight
 * ray, u = distance from the ray's closest approach to the centre (r_t), from u0 to u1, on a sphere of radius rRef
 * (h = r − rRef). The 8-node rule of the shader, in x = √(r − r_t).
 */
export function layerBranchIntegral(rt: number, rRef: number, hc: number, sigma: number, u0: number, u1: number): number {
  const rLo = rRef + hc - LAYER_EXTENT_SIGMA * sigma, rHi = rRef + hc + LAYER_EXTENT_SIGMA * sigma;
  if (rt >= rHi) return 0;
  const ul = Math.max(u0, Math.sqrt(Math.max((rLo - rt) * (rLo + rt), 0)));
  const uh = Math.min(u1, Math.sqrt((rHi - rt) * (rHi + rt)));
  if (!(uh > ul)) return 0;
  const xOf = (u: number) => u / Math.sqrt(Math.sqrt(rt * rt + u * u) + rt);
  const x0 = xOf(ul), x1 = xOf(uh);
  const xm = 0.5 * (x0 + x1), xr = 0.5 * (x1 - x0);
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    const x = xm + xr * GL8_X[i];
    const r = rt + x * x;
    const dudx = (2 * r) / Math.sqrt(2 * rt + x * x);
    const h = r - rRef;
    const v = Math.exp(-0.5 * ((h - hc) / sigma) ** 2) / (sigma * Math.sqrt(2 * Math.PI));
    sum += GL8_W[i] * xr * dudx * v;
  }
  return sum;
}

/** Limb-to-zenith ratio of a layer for a ray with tangent altitude tangentKm above a sphere of radius R (both sides). */
export function limbFactor(tangentKm: number, R: number, hc: number, sigma: number): number {
  return 2 * layerBranchIntegral(R + tangentKm, R, hc, sigma, 0, Infinity);
}

/** Emission tables for the GPU: rate (R per km per erg cm⁻² s⁻¹) and its cumulative integral from the lowest altitude. */
export function emissionTables(data: Float32Array, nE: number, altitudesKm: number[]): { rate: Float32Array; cum: Float32Array } {
  const nA = altitudesKm.length;
  const rate = data.slice(0, nE * nA * 4);
  const cum = new Float32Array(nE * nA * 4);
  for (let e = 0; e < nE; e++) {
    for (let g = 0; g < 4; g++) {
      let c = 0;
      for (let a = 0; a < nA; a++) {
        const k = (e * nA + a) * 4 + g;
        if (a > 0) c += 0.5 * (rate[k] + rate[k - 4]) * (altitudesKm[a] - altitudesKm[a - 1]);
        cum[k] = c;
      }
    }
  }
  return { rate, cum };
}

/**
 * ∫ ε(h(s)) ds over [s0, s1] in n steps, with h linear in s within a step and ε integrated exactly in altitude from
 * its cumulative C (the shader's aurora step): Σ (C(h₂) − C(h₁))·Δs/Δh, or ε(h̄)·Δs where Δh is tiny.
 */
export function slabIntegral(C: (h: number) => number, eps: (h: number) => number, hOf: (s: number) => number, s0: number, s1: number, n: number): number {
  const ds = (s1 - s0) / n;
  let sum = 0, h0 = hOf(s0);
  for (let i = 0; i < n; i++) {
    const h1 = hOf(s0 + (i + 1) * ds);
    const dh = h1 - h0;
    sum += Math.abs(dh) > 0.05 ? ((C(h1) - C(h0)) * ds) / dh : eps(0.5 * (h0 + h1)) * ds;
    h0 = h1;
  }
  return sum;
}

/**
 * Which renderer bin each spectral sample falls in: atmospheres.json's samples are merged SAMPLES_PER_BIN at a time
 * (atmosphere.ts atmosphereModelFromData), so when the nightglow samples are the same grid the same rule applies;
 * otherwise each sample goes to the bin with the nearest centre.
 */
export function sampleBins(samplesNm: number[], atmSamplesNm: number[] | null, binCentresNm: number[]): Int32Array {
  const K = binCentresNm.length;
  const out = new Int32Array(samplesNm.length);
  const same = !!atmSamplesNm && atmSamplesNm.length === samplesNm.length && atmSamplesNm.every((w, k) => Math.abs(w - samplesNm[k]) < 1e-6);
  samplesNm.forEach((w, k) => {
    if (same) out[k] = Math.min(Math.floor(k / SAMPLES_PER_BIN), K - 1);
    else {
      let best = 0;
      for (let b = 1; b < K; b++) if (Math.abs(binCentresNm[b] - w) < Math.abs(binCentresNm[best] - w)) best = b;
      out[k] = best;
    }
  });
  return out;
}

/**
 * The table buffer: per airglow layer and local-time node, then per aurora line group, NG_STRIDE vec4: the XYZS
 * summed over all samples, then for channel c and bin group j the vec4 of bins 4j…4j+3 (zero without bins).
 */
export function packTables(ng: SceneNightglow, bins: Int32Array | null): { data: Float32Array<ArrayBuffer>; groupOffset: number } {
  const layers = ng.airglow?.layers.slice(0, NG_MAX_LAYERS) ?? [];
  const nLT = Math.min(ng.airglow?.ltNodesH.length ?? 0, NG_MAX_LT);
  const nS = ng.samplesNm.length;
  const groups = ng.aurora?.groupsBySample ?? [];
  const blocks = layers.length * nLT + groups.length;
  const data = new Float32Array(Math.max(1, blocks) * NG_STRIDE * 4);
  const put = (block: number, xyzs: (k: number, c: number) => number) => {
    const o = block * NG_STRIDE * 4;
    for (let k = 0; k < nS; k++) {
      for (let c = 0; c < 4; c++) {
        const v = xyzs(k, c);
        if (!v) continue;
        data[o + c] += v;
        if (bins) {
          const b = bins[k];
          if (b >> 2 < ATM_K4_MAX) data[o + 4 * (1 + c * ATM_K4_MAX + (b >> 2)) + (b & 3)] += v;
        }
      }
    }
  };
  layers.forEach((L, l) => {
    for (let j = 0; j < nLT; j++) put(l * nLT + j, (k, c) => L.xyzsBySample[(j * nS + k) * 4 + c]);
  });
  const groupOffset = layers.length * nLT;
  groups.forEach((g, i) => put(groupOffset + i, (k, c) => g[k]?.[c] ?? 0));
  return { data, groupOffset };
}

const f16Scratch = new Float32Array(1);
const f16Bits = new Uint32Array(f16Scratch.buffer);
/** Float32 values → IEEE 754 binary16 bits (round to nearest even; surface.ts numberToF16 without its allocations). */
export function toF16Array(src: ArrayLike<number>, out: Uint16Array<ArrayBuffer> = new Uint16Array(src.length)): Uint16Array<ArrayBuffer> {
  for (let k = 0; k < src.length; k++) {
    f16Scratch[0] = src[k];
    const x = f16Bits[0];
    const sign = (x >>> 16) & 0x8000;
    const ex = (x >>> 23) & 0xff;
    let e = ex - 127 + 15;
    let m = x & 0x7fffff;
    let h: number;
    if (ex === 0xff) h = sign | 0x7c00 | (m ? 0x200 : 0);
    else if (e >= 31) h = sign | 0x7c00;
    else if (e <= 0) {
      if (e < -10) h = sign;
      else {
        m = (m | 0x800000) >>> (1 - e);
        const r = m & 0x1fff;
        m >>>= 13;
        if (r > 0x1000 || (r === 0x1000 && (m & 1))) m++;
        h = sign | m;
      }
    } else {
      const r = m & 0x1fff;
      m >>>= 13;
      if (r > 0x1000 || (r === 0x1000 && (m & 1))) { m++; if (m === 0x400) { m = 0; e++; } }
      h = e >= 31 ? sign | 0x7c00 : sign | (e << 10) | m;
    }
    out[k] = h;
  }
  return out;
}

/** Body-fixed vector of a world vector (rows of R map body-fixed → world). */
const toBodyFixed = (R: M3, w: V3): V3 => [R[0] * w[0] + R[3] * w[1] + R[6] * w[2], R[1] * w[0] + R[4] * w[1] + R[7] * w[2], R[2] * w[0] + R[5] * w[1] + R[8] * w[2]];
const toWorld = (R: M3, b: V3): V3 => [R[0] * b[0] + R[1] * b[1] + R[2] * b[2], R[3] * b[0] + R[4] * b[1] + R[5] * b[2], R[6] * b[0] + R[7] * b[1] + R[8] * b[2]];

// ── WGSL ───────────────────────────────────────────────────────────────────────────────────────────────────

const f = (x: number) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

export const NIGHTGLOW_SHADER = COMMON + BODY_COMMON + ATMOSPHERE_WGSL + /* wgsl */ `
@group(0) @binding(12) var<uniform> A: Atm;
@group(0) @binding(13) var atmTex: texture_2d_array<f32>;
@group(0) @binding(14) var atmSamp: sampler;

struct NgU {
  a: vec4f,      // body index, airglow layer count, 1 = aurora, radius of the shell's top (km, sphere)
  b: vec4f,      // UT hours, cos(night minimum solar zenith angle), 1 = attenuate (atmosphere bound), local-time node count
  c: vec4f,      // shell quad half-extent (tan units), Sun's dipole longitude (deg), sin(cap dipole latitude), aurora group offset (blocks)
  sunW: vec4f,   // unit direction to the Sun from the Earth's centre, world axes
  dip0: vec4f, dip1: vec4f, dip2: vec4f,  // dipole frame axes (Earth-fixed rows)
  dipW: vec4f,   // dipole axis in world axes
  em: vec4f,     // emission table: first energy (keV), ln step, energy count, altitude count
  em2: vec4f,    // first altitude (km), altitude step (km), aurora steps, unused
  op: vec4f,     // OVATION grid: first MLT (h), MLT step, MLT count, unused
  op2: vec4f,    // first |mlat| (deg), step, count, unused
  mag: vec4f,    // magnetic grid: first latitude, step, first longitude, step (deg)
  lay: array<vec4f, ${NG_MAX_LAYERS}>,   // per airglow layer: centre (km), σ (km)
  lt: array<vec4f, ${NG_MAX_LT / 4}>,      // local-time nodes (h)
};
@group(0) @binding(20) var<uniform> NG: NgU;
@group(0) @binding(21) var<storage, read> ngTab: array<vec4f>;
@group(0) @binding(22) var magTex: texture_2d<f32>;
@group(0) @binding(23) var opTex: texture_2d<f32>;
@group(0) @binding(24) var emTex: texture_2d_array<f32>;
@group(0) @binding(25) var ngSamp: sampler;

const NG_STRIDE: i32 = ${NG_STRIDE};
const GX = array<f32, 8>(${GL8_X.join(', ')});
const GW = array<f32, 8>(${GL8_W.join(', ')});
const NG_K4: i32 = ${ATM_K4_MAX};

@vertex fn vsNight(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let b = bodies[ii];
  let c = corners[vi];
  var o: VOut;
  o.id = ii;
  if (b.e2.w > 0.5 || NG.c.x <= 0.0) {
    o.pos = vec4f(c, 0.0, 1.0);
    o.xy = c;
  } else {
    let xy = c * NG.c.x;
    let d = b.n.xyz + xy.x * b.e1.xyz + xy.y * b.e2.xyz;
    let cc = toCam(F, d);
    o.pos = vec4f(cc.x * F.proj.x, cc.y * F.proj.y, 0.0, -cc.z);
    o.xy = xy;
  }
  return o;
}

/** Radius of the ellipsoid in the direction of p (relative to the centre, world km). */
fn ellR(b: Body, p: vec3f) -> f32 {
  let m = vec3f(dot(b.m0.xyz, p), dot(b.m1.xyz, p), dot(b.m2.xyz, p));
  return length(p) / max(length(m), 1e-12);
}
fn toFixed(b: Body, w: vec3f) -> vec3f {
  return vec3f(b.rot0.x * w.x + b.rot1.x * w.y + b.rot2.x * w.z, b.rot0.y * w.x + b.rot1.y * w.y + b.rot2.y * w.z, b.rot0.z * w.x + b.rot1.z * w.y + b.rot2.z * w.z);
}

/** Local-time node bracket: index and weight (held at the end nodes). The nodes are uniform (NightglowGpu checks). */
fn ltBracket(lt: f32) -> vec2f {
  let n = i32(NG.b.w);
  let x0 = NG.lt[0].x;
  let xn = NG.lt[(n - 1) >> 2][(n - 1) & 3];
  let t = clamp((lt - x0) / max(xn - x0, 1e-6), 0.0, 1.0) * f32(n - 1);
  let i = min(i32(floor(t)), n - 2);
  return vec2f(f32(i), t - f32(i));
}

/** The local mean solar time at a point (h from local midnight, in (−12, 12]): UT + east longitude / 15. */
fn localTime(b: Body, p: vec3f) -> f32 {
  let pb = toFixed(b, p);
  let lt = NG.b.x + atan2(pb.y, pb.x) * (12.0 / PI);
  return lt - 24.0 * floor((lt + 12.0) / 24.0);
}

/** Folded XYZS of a layer at a local time. */
fn agFolded(l: i32, lt: f32) -> vec4f {
  let br = ltBracket(lt);
  let base = l * i32(NG.b.w) * NG_STRIDE;
  let j = i32(br.x);
  return mix(ngTab[base + j * NG_STRIDE], ngTab[base + (j + 1) * NG_STRIDE], br.y);
}

/** Σ_bins T·XYZS of block k (per channel), with T per bin group. */
fn blockAttenuated(k: i32, T: array<vec4f, 4>) -> vec4f {
  var o = vec4f(0.0);
  let base = k * NG_STRIDE + 1;
  for (var j = 0; j < atmK4(); j++) {
    o.x += dot(T[j], ngTab[base + 0 * NG_K4 + j]);
    o.y += dot(T[j], ngTab[base + 1 * NG_K4 + j]);
    o.z += dot(T[j], ngTab[base + 2 * NG_K4 + j]);
    o.w += dot(T[j], ngTab[base + 3 * NG_K4 + j]);
  }
  return o;
}
/** Per-channel factor by which T dims block k's light (1 where the block has none). */
fn blockFactor(k: i32, T: array<vec4f, 4>) -> vec4f {
  let all = ngTab[k * NG_STRIDE];
  let att = blockAttenuated(k, T);
  return select(vec4f(1.0), att / max(all, vec4f(1e-30)), all > vec4f(0.0));
}
fn layerFactor(l: i32, lt: f32, T: array<vec4f, 4>) -> vec4f {
  let br = ltBracket(lt);
  let j = i32(br.x) + select(0, 1, br.y > 0.5);
  return blockFactor(l * i32(NG.b.w) + j, T);
}

/**
 * Transmittance per bin of the light from a point to the camera (atmosphere.ts, Bruneton 2017), altitudes mapped
 * onto the atmosphere's spherical model (r = bottom + h). far: the point lies beyond the ray's closest approach.
 * hT: altitude of the closest approach; camOut: the camera is above the atmosphere's top.
 */
fn transToCam(h: f32, u: f32, far: bool, hT: f32, camOut: bool, hC: f32, muC: f32, d: vec3f, pHat: vec3f, ground: bool) -> array<vec4f, 4> {
  var T: array<vec4f, 4>;
  for (var j = 0; j < 4; j++) { T[j] = vec4f(1.0); }
  let Rb = A.geo.x;
  let Rt = A.geo.y;
  let K4 = atmK4();
  if (camOut) {
    if (!far) { return T; }
    let rtp = Rb + max(hT, 0.0);
    if (rtp >= Rt) { return T; }
    var r = Rb + h;
    if (r > Rt) { r = Rt; }
    let mu = -sqrt(max((r - rtp) * (r + rtp), 0.0)) / r;
    for (var j = 0; j < K4; j++) { T[j] = atmT(r, mu, j); }
    return T;
  }
  // Camera inside the atmosphere: the ratio of the transmittances to the top (or of the reversed ray to the ground).
  let rc = Rb + max(hC, 0.0);
  let rp = min(Rb + max(h, 0.0), Rt);
  let muP = dot(pHat, d);
  for (var j = 0; j < K4; j++) {
    if (!ground) {
      let tp = select(atmT(rp, muP, j), vec4f(1.0), Rb + h >= Rt);
      T[j] = clamp(atmT(rc, muC, j) / max(tp, vec4f(1e-6)), vec4f(0.0), vec4f(1.0));
    } else {
      T[j] = clamp(atmT(rp, -muP, j) / max(atmT(rc, -muC, j), vec4f(1e-6)), vec4f(0.0), vec4f(1.0));
    }
  }
  return T;
}

struct Ray {
  q: vec3f,      // closest approach to the centre, relative to it (km, world)
  d: vec3f,      // unit direction
  rt: f32,       // |q|
  hT: f32,       // altitude of q above the ellipsoid
  sC: f32,       // camera's s (s = 0 at q)
  hC: f32,       // camera altitude
  muC: f32,      // cosine of the ray with the camera's vertical
  camOut: bool,  // camera above the atmosphere's top
  ground: bool,  // the ray ends on the ground
  atten: bool,
};

/** One airglow layer on one side of the ray: luminance (XYZS). */
fn agBranch(b: Body, R: Ray, l: i32, sgn: f32, u0: f32, u1: f32) -> vec4f {
  let hc = NG.lay[l].x;
  let sig = NG.lay[l].y;
  let rt = R.rt;
  // Reference radius: the ellipsoid where this side of the ray crosses the layer's centre.
  let qDir = select(R.d * sgn, R.q, rt > 1.0);
  let rc0 = ellR(b, qDir) + hc;
  let uc = clamp(sqrt(max((rc0 - rt) * (rc0 + rt), 0.0)), u0, u1);
  let rRef = ellR(b, R.q + R.d * (sgn * uc));
  let rLo = rRef + hc - ${f(LAYER_EXTENT_SIGMA)} * sig;
  let rHi = rRef + hc + ${f(LAYER_EXTENT_SIGMA)} * sig;
  if (rt >= rHi) { return vec4f(0.0); }
  let ul = max(u0, sqrt(max((rLo - rt) * (rLo + rt), 0.0)));
  let uh = min(u1, sqrt((rHi - rt) * (rHi + rt)));
  if (uh <= ul) { return vec4f(0.0); }
  // cos(solar zenith angle) of the ground point below p(u) = q + d·sgn·u: (q·s + sgn·u·d·s)/|p|, |p| = r_t + x².
  let qs = dot(R.q, NG.sunW.xyz);
  let ds = sgn * dot(R.d, NG.sunW.xyz);
  let pa = R.q + R.d * (sgn * ul);
  let pz = R.q + R.d * (sgn * uh);
  // Both ends of the crossing in daylight (with a margin): so is all of it (the chord stays within the shell).
  if ((qs + ds * ul) / length(pa) > NG.b.y + 0.02 && (qs + ds * uh) / length(pz) > NG.b.y + 0.02) { return vec4f(0.0); }
  // Along the crossing the ellipsoid radius and the local time are linear in u (ends evaluated exactly).
  let Ra = ellR(b, pa);
  let Rz = ellR(b, pz);
  let lta = localTime(b, pa);
  var dlt = localTime(b, pz) - lta;
  dlt = dlt - 24.0 * round(dlt / 24.0);
  let du = max(uh - ul, 1e-6);
  let x0 = ul / sqrt(sqrt(rt * rt + ul * ul) + rt);
  let x1 = uh / sqrt(sqrt(rt * rt + uh * uh) + rt);
  let xm = 0.5 * (x0 + x1);
  let xr = 0.5 * (x1 - x0);
  var acc = vec4f(0.0);
  var cw = 0.0;
  var cu = 0.0;
  var ch = 0.0;
  var clt = 0.0;
  for (var i = 0; i < 8; i++) {
    let x = xm + xr * GX[i];
    let w2 = sqrt(2.0 * rt + x * x);
    let u = x * w2;
    let r = rt + x * x;
    let dudx = 2.0 * r / w2;
    let fu = clamp((u - ul) / du, 0.0, 1.0);
    let h = r - mix(Ra, Rz, fu);
    let z = (h - hc) / sig;
    let v = exp(-0.5 * z * z) * (0.3989422804014327 / sig);
    let night = 1.0 - smoothstep(NG.b.y - 0.004, NG.b.y + 0.004, (qs + ds * u) / r);
    let w = GW[i] * xr * dudx * v * night;
    if (w <= 0.0) { continue; }
    let lt = lta + dlt * fu;
    acc += w * agFolded(l, lt);
    cw += w;
    cu += w * u;
    ch += w * h;
    clt += w * lt;
  }
  // Light reaches the camera through the atmosphere only from the far side below its top, or when the camera is in it.
  if (cw <= 0.0 || !R.atten || (R.camOut && (sgn < 0.0 || A.geo.x + R.hT >= A.geo.y))) { return acc; }
  // Attenuation at the layer's emission-weighted point on this side.
  let uC = cu / cw;
  let pC = R.q + R.d * (sgn * uC);
  let T = transToCam(ch / cw, uC, sgn > 0.0, R.hT, R.camOut, R.hC, R.muC, R.d, normalize(pC), R.ground);
  return acc * layerFactor(l, clt / cw, T);
}

/** Emission table lookup (layer 0: rate R/km per erg; 1: cumulative R per erg), bilinear in log energy and altitude. */
fn emAt(layer: i32, ie: f32, h: f32) -> vec4f {
  let nE = i32(NG.em.z);
  let nA = i32(NG.em.w);
  let ia = (h - NG.em2.x) / NG.em2.y;
  if (layer == 0 && (ia < 0.0 || ia > f32(nA - 1))) { return vec4f(0.0); }
  let a = clamp(ia, 0.0, f32(nA - 1));
  let a0 = min(i32(floor(a)), nA - 2);
  let fa = a - f32(a0);
  let e0 = min(i32(floor(ie)), nE - 2);
  let fe = ie - f32(e0);
  let v00 = textureLoad(emTex, vec2i(a0, e0), layer, 0);
  let v10 = textureLoad(emTex, vec2i(a0 + 1, e0), layer, 0);
  let v01 = textureLoad(emTex, vec2i(a0, e0 + 1), layer, 0);
  let v11 = textureLoad(emTex, vec2i(a0 + 1, e0 + 1), layer, 0);
  return mix(mix(v00, v10, fa), mix(v01, v11, fa), fe);
}

/** Precipitation at a point (world, relative to the centre): energy flux (erg cm⁻² s⁻¹) and energy-node index. */
fn precip(b: Body, p: vec3f) -> vec2f {
  let pb = toFixed(b, p);
  let lat = asin(clamp(pb.z / length(pb), -1.0, 1.0)) * (180.0 / PI);
  let lon = atan2(pb.y, pb.x) * (180.0 / PI);
  let dims = vec2f(textureDimensions(magTex));
  let uv = vec2f((lon - NG.mag.z) / NG.mag.w + 0.5, (lat - NG.mag.x) / NG.mag.y + 0.5) / dims;
  let m = textureSampleLevel(magTex, ngSamp, uv, 0.0);
  if (m.w < 0.5) { return vec2f(0.0); }
  let mlat = m.x / m.w;
  let alat = abs(mlat);
  if (alat < NG.op2.x) { return vec2f(0.0); }
  let mlon = atan2(m.z, m.y) * (180.0 / PI);
  var mlt = 12.0 + (mlon - NG.c.y) / 15.0;
  mlt = mlt - 24.0 * floor(mlt / 24.0);
  let ou = vec2f(((mlt - NG.op.x) / NG.op.y + 0.5) / NG.op.z, ((alat - NG.op2.x) / NG.op2.y + 0.5) / NG.op2.z);
  let o = textureSampleLevel(opTex, ngSamp, ou, 0.0);
  let ef = select(o.z, o.x, mlat >= 0.0);
  let nf = select(o.w, o.y, mlat >= 0.0);
  if (ef <= 1e-5 || nf <= 1e-9) { return vec2f(0.0); }
  let E = ${f(KEV_PER_ERG_PER_1E8)} * ef / nf;
  let ie = clamp(log(E / NG.em.x) / NG.em.y, 0.0, NG.em.z - 1.0);
  return vec2f(ef, ie);
}

/** Intervals of s where the line q + d·s lies inside the auroral caps (double cone about the dipole axis). */
fn capIntervals(R: Ray, iv: ptr<function, array<vec2f, 2>>) -> i32 {
  let a = NG.dipW.xyz;
  let c2 = NG.c.z * NG.c.z;
  let al = dot(a, R.q);
  let be = dot(a, R.d);
  let A2 = be * be - c2;
  let B2 = 2.0 * al * be;
  let C2 = al * al - c2 * R.rt * R.rt;
  let BIG = 1e9;
  if (abs(A2) < 1e-9) {
    if (abs(B2) < 1e-12) { if (C2 >= 0.0) { (*iv)[0] = vec2f(-BIG, BIG); return 1; } return 0; }
    let s0 = -C2 / B2;
    (*iv)[0] = select(vec2f(-BIG, s0), vec2f(s0, BIG), B2 > 0.0);
    return 1;
  }
  let disc = B2 * B2 - 4.0 * A2 * C2;
  if (disc <= 0.0) {
    if (A2 > 0.0) { (*iv)[0] = vec2f(-BIG, BIG); return 1; }
    return 0;
  }
  let sq = sqrt(disc);
  let qq = -0.5 * (B2 + select(-sq, sq, B2 >= 0.0));
  var s1 = qq / A2;
  var s2 = select(C2 / qq, s1, abs(qq) < 1e-20);
  if (s1 > s2) { let t = s1; s1 = s2; s2 = t; }
  if (A2 > 0.0) { (*iv)[0] = vec2f(-BIG, s1); (*iv)[1] = vec2f(s2, BIG); return 2; }
  (*iv)[0] = vec2f(s1, s2);
  return 1;
}

/** The aurora along the ray within [sA, sB] (both sides of q): luminance (XYZS). */
fn aurora(b: Body, R: Ray, sA: f32, sB: f32, farW: f32) -> vec4f {
  let rTop = NG.a.w;
  let rBot = min(b.rot0.w, min(b.rot1.w, b.rot2.w)) + NG.em2.x - 2.0;
  let rt = R.rt;
  if (rt >= rTop) { return vec4f(0.0); }
  let cTop = sqrt((rTop - rt) * (rTop + rt));
  var shell: array<vec2f, 2>;
  if (rt < rBot) {
    let cBot = sqrt((rBot - rt) * (rBot + rt));
    shell[0] = vec2f(-cTop, -cBot);
    shell[1] = vec2f(cBot, cTop);
  } else {
    shell[0] = vec2f(-cTop, 0.0);
    shell[1] = vec2f(0.0, cTop);
  }
  var caps: array<vec2f, 2>;
  let nc = capIntervals(R, &caps);
  var pieces: array<vec2f, 4>;
  var np = 0;
  var total = 0.0;
  for (var i = 0; i < 2; i++) {
    for (var k = 0; k < nc; k++) {
      let lo = max(max(shell[i].x, caps[k].x), sA);
      let hi = min(min(shell[i].y, caps[k].y), sB);
      if (hi > lo) { pieces[np] = vec2f(lo, hi); np++; total += hi - lo; }
    }
  }
  if (np == 0) { return vec4f(0.0); }
  var Rg: array<vec4f, 2>;   // line-group path integrals (R), near and far side
  var cw: array<f32, 2>;
  var cu: array<f32, 2>;
  var chh: array<f32, 2>;
  let nTot = NG.em2.z;
  for (var pi = 0; pi < np; pi++) {
    let pc = pieces[pi];
    let n = max(4, i32(ceil(nTot * (pc.y - pc.x) / total)));
    let ds = (pc.y - pc.x) / f32(n);
    var p0 = R.q + R.d * pc.x;
    var h0 = length(p0) - ellR(b, p0);
    for (var i = 0; i < n; i++) {
      let s1 = pc.x + f32(i + 1) * ds;
      let p1 = R.q + R.d * s1;
      let h1 = length(p1) - ellR(b, p1);
      let sm = s1 - 0.5 * ds;
      let pr = precip(b, R.q + R.d * sm);
      if (pr.x > 0.0) {
        let dh = h1 - h0;
        var e: vec4f;
        if (abs(dh) > 0.05) { e = (emAt(1, pr.y, h1) - emAt(1, pr.y, h0)) * (ds / dh); }
        else { e = emAt(0, pr.y, 0.5 * (h0 + h1)) * ds; }
        e = max(e, vec4f(0.0)) * pr.x;
        let side = select(0, 1, sm > 0.0);
        let w = e.x + e.y + e.z;
        Rg[side] += e;
        cw[side] += w;
        cu[side] += w * abs(sm);
        chh[side] += w * 0.5 * (h0 + h1);
      }
      h0 = h1;
    }
  }
  var L = vec4f(0.0);
  let go = i32(NG.c.w);
  for (var side = 0; side < 2; side++) {
    if (cw[side] <= 0.0) { continue; }
    let sw = select(1.0, farW, side == 1);
    var T: array<vec4f, 4>;
    for (var j = 0; j < 4; j++) { T[j] = vec4f(1.0); }
    let att = R.atten && !(R.camOut && (side == 0 || A.geo.x + R.hT >= A.geo.y));
    if (att) {
      let uC = cu[side] / cw[side];
      let sg = select(-1.0, 1.0, side == 1);
      let pC = R.q + R.d * (sg * uC);
      T = transToCam(chh[side] / cw[side], uC, side == 1, R.hT, R.camOut, R.hC, R.muC, R.d, normalize(pC), R.ground);
    }
    for (var g = 0; g < 3; g++) {
      let k = go + g;
      var lum = ngTab[k * NG_STRIDE];
      if (att) { lum = blockAttenuated(k, T); }
      L += sw * Rg[side][g] * lum;
    }
  }
  return L;
}

/** The view ray of a pixel relative to the Earth: closest approach q, direction, and the camera's distance to q. */
struct PixelRay { q: vec3f, d: vec3f, tCam: f32 };
fn pixelRay(b: Body, xy: vec2f) -> PixelRay {
  var o: PixelRay;
  if (b.e2.w > 0.5) {
    o.d = normalize(worldDirNdc(F, xy));
    let cRel = -b.n.xyz * b.n.w;
    o.tCam = -dot(cRel, o.d);
    o.q = cRel + o.d * o.tCam;
  } else {
    let a = xy.x * b.e1.xyz + xy.y * b.e2.xyz;
    let a2 = dot(a, a);
    let L2 = 1.0 + a2;
    o.d = (b.n.xyz + a) / sqrt(L2);
    o.q = b.n.w * (a - b.n.xyz * a2) / L2;
    o.tCam = b.n.w / sqrt(L2);
  }
  return o;
}

/** The emission, at a reduced resolution (NIGHTGLOW_SCALE; no depth: the composite tests it at full resolution). */
@fragment fn fsNightLow(in: VOut) -> @location(0) vec4f {
  let b = bodies[in.id];
  let hit = castBody(b, in.xy);
  let cov = select(0.0, clamp(0.5 + hit.disc / max(fwidth(hit.disc), 1e-30), 0.0, 1.0), hit.t > 0.0);
  let onBody = hit.t > 0.0 && hit.disc > 0.0;
  let pr = pixelRay(b, in.xy);
  var R: Ray;
  R.q = pr.q;
  R.d = pr.d;
  let tCam = pr.tCam;
  R.rt = length(R.q);
  let rTop = NG.a.w;
  if (R.rt >= rTop) { return vec4f(0.0); }
  let cTop = sqrt((rTop - R.rt) * (rTop + R.rt));
  R.sC = -tCam;
  let sNear = max(R.sC, -cTop);
  if (sNear >= cTop) { return vec4f(0.0); }
  // The ray ends on the ground where the pixel is (fully) on the disk; at the limb's edge the far side is weighted
  // by the uncovered share of the pixel.
  var sEnd = cTop;
  var farW = 1.0;
  R.ground = onBody && cov >= 1.0;
  if (R.ground) { sEnd = min(hit.t * length(hit.dir) - tCam, cTop); }
  else if (cov > 0.0) { farW = 1.0 - cov; }
  if (sEnd <= sNear) { return vec4f(0.0); }
  let qDir = select(R.d, R.q, R.rt > 1.0);
  R.hT = R.rt - ellR(b, qDir);
  let pc = R.q + R.d * R.sC;
  R.hC = length(pc) - ellR(b, pc);
  R.muC = dot(normalize(pc), R.d);
  R.atten = NG.b.z > 0.5;
  R.camOut = !R.atten || A.geo.x + R.hC >= A.geo.y;

  var L = vec4f(0.0);
  // Airglow: each layer on the near side (s < 0) and the far side (s > 0) of q.
  let nl = i32(NG.a.y);
  for (var l = 0; l < nl; l++) {
    if (sNear < 0.0) { L += agBranch(b, R, l, -1.0, max(-min(sEnd, 0.0), 0.0), -sNear); }
    if (sEnd > 0.0) { L += farW * agBranch(b, R, l, 1.0, max(sNear, 0.0), sEnd); }
  }
  if (NG.a.z > 0.5) {
    // Partially covered limb pixels: the far side is weighted inside aurora() (side 1).
    L += aurora(b, R, sNear, sEnd, farW);
  }
  return min(toStore(F, L), vec4f(65000.0));
}

struct NOut {
  @location(0) ext: vec4f,
  @location(1) w: f32,
  @location(2) mask: f32,
  @builtin(frag_depth) depth: f32,
};

@group(0) @binding(26) var lowTex: texture_2d<f32>;

/** Full resolution: the low-resolution emission, depth-tested at the shell's near entry (bodies in front hide it). */
@fragment fn fsNightComposite(in: VOut) -> NOut {
  let b = bodies[in.id];
  let pr = pixelRay(b, in.xy);
  let rt = length(pr.q);
  let rTop = NG.a.w;
  if (rt >= rTop) { discard; }
  let cTop = sqrt((rTop - rt) * (rTop + rt));
  let sNear = max(-pr.tCam, -cTop);
  if (sNear >= cTop || occulted(F, pr.d)) { discard; }
  let v = textureSampleLevel(lowTex, ngSamp, in.pos.xy * F.size.zw, 0.0);
  if (all(v == vec4f(0.0))) { discard; }
  var o: NOut;
  o.ext = v;
  o.w = 1.0;
  o.mask = 0.0;
  o.depth = depthOf(max(pr.tCam + sNear, 0.0) + 1e-3, pr.d);
  return o;
}
`;

// ── GPU resources ──────────────────────────────────────────────────────────────────────────────────────────

/** What the pass needs of the Earth this frame (render/frame.ts ResolvedBody). */
export interface NightglowFrame {
  /** Index of the Earth in the frame's body buffer. */
  index: number;
  ng: SceneNightglow;
  /** Body-fixed → world rotation (row-major), unit direction to the Sun (world), largest radius (km). */
  bodyToWorld: M3;
  sunDir: V3;
  rMaxKm: number;
  /** Camera-relative centre (km) and the tangent-plane quad half-extent of a sphere of the shell's radius (tan units). */
  shellBeta: number;
  /** The Earth's atmosphere binding (attenuation), and its spectral samples (atmospheres.json) for the bin mapping. */
  atm: AtmosphereBinding | undefined;
  atmSamplesNm: number[] | null;
}

/** Top of the emission shell above the largest radius: the emission tables' top, or the airglow's highest layer. */
export function shellTopKm(ng: SceneNightglow): number {
  let top = 0;
  for (const L of ng.airglow?.layers ?? []) top = Math.max(top, L.centreKm + LAYER_EXTENT_SIGMA * L.sigmaKm);
  const alt = ng.aurora?.emission.altitudesKm;
  if (alt?.length) top = Math.max(top, alt[alt.length - 1]);
  return top;
}

export const NG_UB_BYTES = (14 + NG_MAX_LAYERS + NG_MAX_LT / 4) * 16;
/**
 * The emission is computed at 1/NIGHTGLOW_SCALE of the frame's resolution in each direction and composited (bilinear)
 * at full resolution: a cost choice. At the ISS's distance from the limb the green layer's FWHM (8.6 km) spans
 * ~0.2°, several pixels of the reduced image at the usual fields of view.
 */
export const NIGHTGLOW_SCALE = 2;

export class NightglowGpu {
  private pipe: GPURenderPipeline;
  private lowPipe: GPURenderPipeline;
  private low: GPUTexture | null = null;
  private ub: GPUBuffer;
  private tab: GPUBuffer | null = null;
  private tabKey: unknown[] = [];
  private groupOffset = 0;
  private mag: GPUTexture | null = null;
  private magKey: Float32Array | null = null;
  private op: GPUTexture | null = null;
  private opKey: Float32Array | null = null;
  private em: GPUTexture | null = null;
  private emKey: Float32Array | null = null;
  private dummy2d: GPUTexture;
  private dummyArr: GPUTexture;
  private sampler: GPUSampler;

  constructor(private readonly device: GPUDevice, hdrFormat: GPUTextureFormat, weightFormat: GPUTextureFormat) {
    const d = device;
    const m = d.createShaderModule({ code: NIGHTGLOW_SHADER, label: 'nightglow' });
    const add: GPUBlendState = { color: { operation: 'add', srcFactor: 'one', dstFactor: 'one' }, alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one' } };
    const min: GPUBlendState = { color: { operation: 'min', srcFactor: 'one', dstFactor: 'one' }, alpha: { operation: 'min', srcFactor: 'one', dstFactor: 'one' } };
    const max: GPUBlendState = { color: { operation: 'max', srcFactor: 'one', dstFactor: 'one' }, alpha: { operation: 'max', srcFactor: 'one', dstFactor: 'one' } };
    this.lowPipe = d.createRenderPipeline({
      label: 'nightglow (emission)', layout: 'auto',
      vertex: { module: m, entryPoint: 'vsNight' },
      fragment: { module: m, entryPoint: 'fsNightLow', targets: [{ format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list' },
    });
    this.pipe = d.createRenderPipeline({
      label: 'nightglow (composite)', layout: 'auto',
      vertex: { module: m, entryPoint: 'vsNight' },
      fragment: { module: m, entryPoint: 'fsNightComposite', targets: [{ format: hdrFormat, blend: add }, { format: weightFormat, blend: min }, { format: 'r8unorm', blend: max }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'greater' },
    });
    this.ub = d.createBuffer({ size: NG_UB_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'nightglow' });
    this.dummy2d = d.createTexture({ size: [2, 2], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING, label: 'nightglow dummy' });
    this.dummyArr = d.createTexture({ size: [2, 2, 2], format: 'rgba32float', usage: GPUTextureUsage.TEXTURE_BINDING, label: 'nightglow dummy' });
    this.sampler = d.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'clamp-to-edge' });
  }

  /** Upload what changed and write the uniform; returns the bind-group entries 20–25. */
  prepare(fr: NightglowFrame): GPUBindGroupEntry[] {
    const d = this.device;
    const ng = fr.ng;
    const atm = fr.atm && !fr.atm.unmeasured ? fr.atm : undefined;
    // Table buffer: re-pack when the layers, the aurora groups or the atmosphere's bins change.
    const key = [ng.airglow?.layers, ng.aurora?.groupsBySample, atm?.model];
    if (!this.tab || key.some((k, i) => k !== this.tabKey[i])) {
      const bins = atm ? sampleBins(ng.samplesNm, fr.atmSamplesNm, atm.model.wavelengthsNm) : null;
      const { data, groupOffset } = packTables(ng, bins);
      if (!this.tab || this.tab.size < data.byteLength) {
        this.tab?.destroy();
        this.tab = d.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'nightglow tables' });
      }
      d.queue.writeBuffer(this.tab, 0, data);
      this.groupOffset = groupOffset;
      this.tabKey = key;
    }
    const au = ng.aurora;
    if (au) {
      if (this.magKey !== au.magnetic.data) {
        const [, , nLat] = au.magnetic.latDeg, [, , nLon] = au.magnetic.lonDeg;
        const src = au.magnetic.data;
        const px = new Uint16Array(nLat * nLon * 4);
        for (let k = 0; k < nLat * nLon; k++) {
          const ok = Number.isFinite(src[3 * k]) && Number.isFinite(src[3 * k + 1]);
          px[4 * k] = numberToF16(ok ? src[3 * k] : 0);
          px[4 * k + 1] = numberToF16(ok ? src[3 * k + 1] : 0);
          px[4 * k + 2] = numberToF16(ok ? src[3 * k + 2] : 0);
          px[4 * k + 3] = numberToF16(ok ? 1 : 0);
        }
        this.mag?.destroy();
        this.mag = d.createTexture({ size: [nLon, nLat], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, label: 'magnetic coordinates' });
        d.queue.writeTexture({ texture: this.mag }, px, { bytesPerRow: nLon * 8 }, [nLon, nLat]);
        this.magKey = src;
      }
      if (this.opKey !== au.grid) {
        const nT = au.mltHours.length, nL = au.mlatDeg.length;
        const px = toF16Array(au.grid);
        if (!this.op || this.op.width !== nT || this.op.height !== nL) {
          this.op?.destroy();
          this.op = d.createTexture({ size: [nT, nL], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, label: 'aurora precipitation' });
        }
        d.queue.writeTexture({ texture: this.op }, px, { bytesPerRow: nT * 8 }, [nT, nL]);
        this.opKey = au.grid;
      }
      if (this.emKey !== au.emission.data) {
        const nE = au.emission.energiesKeV.length, nA = au.emission.altitudesKm.length;
        const { rate, cum } = emissionTables(au.emission.data, nE, au.emission.altitudesKm);
        const all = new Float32Array(2 * nE * nA * 4);
        all.set(rate, 0);
        all.set(cum, nE * nA * 4);
        this.em?.destroy();
        this.em = d.createTexture({ size: [nA, nE, 2], format: 'rgba32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, label: 'aurora emission' });
        d.queue.writeTexture({ texture: this.em }, all, { bytesPerRow: nA * 16, rowsPerImage: nE }, [nA, nE, 2]);
        this.emKey = au.emission.data;
      }
    }
    // Uniform.
    const R = fr.bodyToWorld;
    const sunB = toBodyFixed(R, fr.sunDir);
    const a = new Float32Array(NG_UB_BYTES / 4);
    const nLayers = Math.min(ng.airglow?.layers.length ?? 0, NG_MAX_LAYERS);
    const nLT = Math.min(ng.airglow?.ltNodesH.length ?? 0, NG_MAX_LT);
    const lt = ng.airglow?.ltNodesH ?? [];
    if (lt.length > 2 && lt.some((t, j) => Math.abs(t - (lt[0] + (j * (lt[lt.length - 1] - lt[0])) / (lt.length - 1))) > 1e-6))
      throw new Error('nightglow: local-time nodes must be uniform');
    const top = fr.rMaxKm + shellTopKm(ng);
    a.set([fr.index, nLayers, au ? 1 : 0, top], 0);
    const cosNight = Math.cos(((ng.airglow?.nightMinSzaDeg ?? 100) * Math.PI) / 180);
    a.set([ng.utHours, cosNight, atm ? 1 : 0, nLT], 4);
    let lonSunDip = 0;
    let dipW: V3 = [0, 0, 1];
    if (au) {
      const D = au.dipoleFrameRows;
      lonSunDip = (Math.atan2(D[1][0] * sunB[0] + D[1][1] * sunB[1] + D[1][2] * sunB[2], D[0][0] * sunB[0] + D[0][1] * sunB[1] + D[0][2] * sunB[2]) * 180) / Math.PI;
      dipW = toWorld(R, [D[2][0], D[2][1], D[2][2]]);
      a.set([...D[0], 0, ...D[1], 0, ...D[2], 0], 16);
    }
    a.set([fr.shellBeta, lonSunDip, Math.sin((AURORA_CAP_DIPOLE_LAT_DEG * Math.PI) / 180), this.groupOffset], 8);
    a.set([...fr.sunDir, 0], 12);
    a.set([...dipW, 0], 28);
    if (au) {
      const E = au.emission.energiesKeV, h = au.emission.altitudesKm;
      a.set([E[0], Math.log(E[E.length - 1] / E[0]) / (E.length - 1), E.length, h.length], 32);
      a.set([h[0], (h[h.length - 1] - h[0]) / (h.length - 1), AURORA_STEPS, 0], 36);
      const T = au.mltHours, Lm = au.mlatDeg;
      a.set([T[0], (T[T.length - 1] - T[0]) / (T.length - 1), T.length, 0], 40);
      a.set([Lm[0], (Lm[Lm.length - 1] - Lm[0]) / (Lm.length - 1), Lm.length, 0], 44);
      a.set([au.magnetic.latDeg[0], au.magnetic.latDeg[1], au.magnetic.lonDeg[0], au.magnetic.lonDeg[1]], 48);
    }
    ng.airglow?.layers.slice(0, nLayers).forEach((L, l) => a.set([L.centreKm, L.sigmaKm, 0, 0], 52 + 4 * l));
    ng.airglow?.ltNodesH.slice(0, nLT).forEach((t, j) => { a[52 + 4 * NG_MAX_LAYERS + j] = t; });
    d.queue.writeBuffer(this.ub, 0, a);
    return [
      { binding: 20, resource: { buffer: this.ub } },
      { binding: 21, resource: { buffer: this.tab! } },
      { binding: 22, resource: (this.mag ?? this.dummy2d).createView() },
      { binding: 23, resource: (this.op ?? this.dummy2d).createView() },
      { binding: 24, resource: (this.em ?? this.dummyArr).createView({ dimension: '2d-array' }) },
      { binding: 25, resource: this.sampler },
    ];
  }

  /**
   * The emission at 1/NIGHTGLOW_SCALE resolution into its own target (a render pass of its own, before the bodies
   * pass). `entries`: bindings 0, 1, 12–14 and those of prepare().
   */
  encodeEmission(enc: GPUCommandEncoder, entries: GPUBindGroupEntry[], index: number, W: number, H: number, timestampWrites?: GPURenderPassTimestampWrites): void {
    const w = Math.max(1, Math.ceil(W / NIGHTGLOW_SCALE)), h = Math.max(1, Math.ceil(H / NIGHTGLOW_SCALE));
    if (!this.low || this.low.width !== w || this.low.height !== h) {
      this.low?.destroy();
      this.low = this.device.createTexture({ size: [w, h], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING, label: 'nightglow (low resolution)' });
    }
    const layout = this.lowPipe.getBindGroupLayout(0);
    const pass = enc.beginRenderPass({ label: 'nightglow (emission)', ...(timestampWrites ? { timestampWrites } : {}), colorAttachments: [{ view: this.low.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
    pass.setPipeline(this.lowPipe);
    pass.setBindGroup(0, this.device.createBindGroup({ layout, entries }));
    pass.draw(6, 1, 0, index);
    pass.end();
  }

  /** Adds the emission into the bodies pass (depth-tested). `entries`: bindings 0, 1 and those of prepare(). */
  drawComposite(pass: GPURenderPassEncoder, entries: GPUBindGroupEntry[], index: number): void {
    if (!this.low) return;
    const keep = new Set([0, 1, 20, 25]);
    pass.setPipeline(this.pipe);
    pass.setBindGroup(0, this.device.createBindGroup({
      layout: this.pipe.getBindGroupLayout(0),
      entries: [...entries.filter((e) => keep.has(e.binding)), { binding: 26, resource: this.low.createView() }],
    }));
    pass.draw(6, 1, 0, index);
  }

  destroy(): void {
    for (const t of [this.mag, this.op, this.em, this.dummy2d, this.dummyArr, this.low]) t?.destroy();
    this.ub.destroy();
    this.tab?.destroy();
  }
}
