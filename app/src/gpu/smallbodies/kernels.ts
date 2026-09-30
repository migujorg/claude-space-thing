// WGSL for the small-body field (see ./field.ts for the design and docs/reports/small-bodies.md for the numbers).
//
// Every physical constant is generated from the product headers (forceModel of smallbodies/core.json, and
// smallbodies/photometry.json) as exact float32 / double-single literals (./wgslConst.ts); nothing numeric is
// hand-written here except exact mathematical constants (Taylor coefficients, Lagrange weights, SABA structure).
//
// Arithmetic: positions and velocities are double-single (df64: hi + lo float32, ~48-bit significand) where it
// matters for the result, float32 elsewhere:
//   * state x, v (km, km/s, heliocentric ICRF) stored as df64;
//   * Kepler drift: the universal-variable equation is solved in float32 (Laguerre-Conway) and refined by one
//     Newton step whose residual r0*G1 + eta*G2 + mu*G3 - dt is evaluated with the dominant term in df64; the
//     increments dx = (f-1) x + g v and dv = fdot x + (gdot-1) v are formed with g = dt - mu*G3 and
//     fdot = -mu*G1/(r*r0) in df64 and the small terms (f-1, gdot-1) in float32;
//   * kicks: accelerations in float32 from df64 differences planet - object (so close approaches keep their
//     precision), added to the df64 velocity;
//   * encounter (RK4) substeps: stage positions in df64 (x + h v in df64, the h^2 a terms in float32).
// The error-free transformations (two_sum, Dekker split/two_prod) route intermediates through opq(), an XOR
// with a runtime zero from a uniform, so no compiler can fuse or re-associate them; USE_FMA switches two_prod to
// fma() when the device's fma is verified exact by the self-test (./field.ts).

import type { SmallBodyForceModel, SmallBodyPhotometry } from '../../data/schema';
import { df, f32 } from './wgslConst';

export interface KernelConfig {
  model: SmallBodyForceModel;
  /** Planet samples per grid interval (including both ends). */
  samples: number;
  /** Speed of light, km/s, and the astronomical unit, km (definitions). */
  cKmS: number;
  auKm: number;
  photometry: SmallBodyPhotometry | null;
}

/** Workgroup size of the per-object kernels. */
export const WG = 64;

export const DF64_WGSL = /* wgsl */ `
override USE_FMA: bool = false;
var<private> ZB: u32;
fn opq(x: f32) -> f32 { return bitcast<f32>(bitcast<u32>(x) ^ ZB); }
fn nanf() -> f32 { return bitcast<f32>(0x7fc00000u | ZB); }
fn bad(x: f32) -> bool { return (bitcast<u32>(x) & 0x7f800000u) == 0x7f800000u; }

fn two_sum(a: f32, b: f32) -> vec2f {
  let s = opq(a + b);
  let bb = opq(s - a);
  return vec2f(s, (a - (s - bb)) + (b - bb));
}
fn quick_two_sum(a: f32, b: f32) -> vec2f {
  let s = opq(a + b);
  return vec2f(s, b - (s - a));
}
fn split(a: f32) -> vec2f {
  let t = opq(4097.0 * a);
  let hi = t - opq(t - a);
  return vec2f(hi, a - hi);
}
fn two_prod(a: f32, b: f32) -> vec2f {
  let p = opq(a * b);
  if (USE_FMA) { return vec2f(p, fma(a, b, -p)); }
  let A = split(a);
  let B = split(b);
  return vec2f(p, ((A.x * B.x - p) + A.x * B.y + A.y * B.x) + A.y * B.y);
}
fn dd_add(a: vec2f, b: vec2f) -> vec2f {
  var s = two_sum(a.x, b.x);
  let t = two_sum(a.y, b.y);
  s.y = s.y + t.x;
  s = quick_two_sum(s.x, s.y);
  s.y = s.y + t.y;
  return quick_two_sum(s.x, s.y);
}
fn dd_add_f(a: vec2f, b: f32) -> vec2f {
  var s = two_sum(a.x, b);
  s.y = s.y + a.y;
  return quick_two_sum(s.x, s.y);
}
fn dd_mul(a: vec2f, b: vec2f) -> vec2f {
  var p = two_prod(a.x, b.x);
  p.y = p.y + (a.x * b.y + a.y * b.x);
  return quick_two_sum(p.x, p.y);
}
fn dd_mul_f(a: vec2f, b: f32) -> vec2f {
  var p = two_prod(a.x, b);
  p.y = p.y + a.y * b;
  return quick_two_sum(p.x, p.y);
}
fn dd_div(a: vec2f, b: vec2f) -> vec2f {
  let q1 = a.x / b.x;
  let r = dd_add(a, -dd_mul_f(b, q1));
  let q2 = r.x / b.x;
  let r2 = dd_add(r, -dd_mul_f(b, q2));
  let q3 = r2.x / b.x;
  return dd_add_f(quick_two_sum(q1, q2), q3);
}
fn dd_sqrt(a: vec2f) -> vec2f {
  if (a.x <= 0.0) { return vec2f(0.0); }
  let x = inverseSqrt(a.x);
  let y = a.x * x;
  let d = dd_add(a, -two_prod(y, y));
  return dd_add_f(vec2f(y, 0.0), d.x * x * 0.5);
}
fn dd_dot(ah: vec3f, al: vec3f, bh: vec3f, bl: vec3f) -> vec2f {
  var s = dd_mul(vec2f(ah.x, al.x), vec2f(bh.x, bl.x));
  s = dd_add(s, dd_mul(vec2f(ah.y, al.y), vec2f(bh.y, bl.y)));
  return dd_add(s, dd_mul(vec2f(ah.z, al.z), vec2f(bh.z, bl.z)));
}
`;

function perturberConsts(m: SmallBodyForceModel): string {
  const nb = m.perturbers.length;
  const j2i = m.zonal.perturber === null ? -1 : m.perturbers.findIndex((p) => p.naifId === m.zonal.perturber);
  const j2p = j2i >= 0 ? m.perturbers[j2i] : null;
  // -1.5 J2 GM R^2 (km^5/s^2): the J2 acceleration is J2K / d^5 * (...), as in core/smallbody.ts.
  const j2k = j2p ? -1.5 * m.zonal.j2 * j2p.gm * m.zonal.referenceRadiusKm ** 2 : 0;
  const [px, py, pz] = m.zonal.poleIcrf;
  const c2inv = m.relativity.enabled ? 1 / (m.relativity.cKmS * m.relativity.cKmS) : 0;
  const sc = m.stepControl;
  return /* wgsl */ `
const NB: u32 = ${nb}u;
const NBT: u32 = ${nb + 1}u;
const GM = array<f32, ${nb}>(${m.perturbers.map((p) => f32(p.gm)).join(', ')});
const RAD = array<f32, ${nb}>(${m.perturbers.map((p) => f32(p.radius)).join(', ')});
const RAD2 = array<f32, ${nb}>(${m.perturbers.map((p) => f32(p.radius * p.radius)).join(', ')});
const MU = ${df(m.sun.gm)};
const MU_F: f32 = ${f32(m.sun.gm)};
const SIXTH = ${df(1 / 6)};
const SUN_R2: f32 = ${f32(m.sun.radius * m.sun.radius)};
const C2INV: f32 = ${f32(c2inv)};
const J2_INDEX: i32 = ${j2i};
const J2K: f32 = ${f32(j2k)};
const POLE = vec3f(${f32(px)}, ${f32(py)}, ${f32(pz)});
const ETA_SUN: f32 = ${f32(sc.etaSun)};
const ETA_PLANET: f32 = ${f32(sc.etaPlanet)};
const ETA_ENC: f32 = ${f32(sc.etaEncounter)};
const ENC_RATIO: f32 = ${f32(sc.encounterRatio)};
const KMAX: f32 = ${f32(sc.kmax)};
const NDRIFT: u32 = ${m.scheme.drift.length}u;
const NKICK: u32 = ${m.scheme.kick.length}u;
const DRIFT = array<vec2f, ${m.scheme.drift.length}>(${m.scheme.drift.map(df).join(', ')});
const KICK = array<vec2f, ${m.scheme.kick.length}>(${m.scheme.kick.map(df).join(', ')});
`;
}

const DYNAMICS_WGSL = /* wgsl */ `
struct St { xh: vec3f, xl: vec3f, vh: vec3f, vl: vec3f };

// Stumpff c2(z), c3(z): Maclaurin series for |z| <= 0.1 (truncation < 1e-13), else the argument is quartered
// until it is and the results doubled back (c0(4z) = 2c0^2 - 1, c1(4z) = c0 c1, c2(4z) = c1^2/2,
// c3(4z) = (c2 + c0 c3)/4). No transcendental functions (their float32 accuracy is not specified tightly).
fn stumpff(z0: f32) -> vec2f {
  var z = z0;
  var n = 0u;
  loop {
    if (abs(z) <= 0.1 || n >= 40u) { break; }
    z = z * 0.25;
    n = n + 1u;
  }
  var c2 = 1.0 / 2.0 + z * (-1.0 / 24.0 + z * (1.0 / 720.0 + z * (-1.0 / 40320.0 + z * (1.0 / 3628800.0 + z * (-1.0 / 479001600.0)))));
  var c3 = 1.0 / 6.0 + z * (-1.0 / 120.0 + z * (1.0 / 5040.0 + z * (-1.0 / 362880.0 + z * (1.0 / 39916800.0 + z * (-1.0 / 6227020800.0)))));
  if (n > 0u) {
    var c0 = 1.0 - z * c2;
    var c1 = 1.0 - z * c3;
    for (var i = 0u; i < n; i = i + 1u) {
      let n3 = 0.25 * (c2 + c0 * c3);
      let n2 = 0.5 * c1 * c1;
      let n1 = c0 * c1;
      let n0 = 2.0 * c0 * c0 - 1.0;
      c3 = n3; c2 = n2; c1 = n1; c0 = n0;
    }
  }
  return vec2f(c2, c3);
}

// c2(z) - 1/2 and c3(z) - 1/6 (so c2, c3 can be carried in double-single: 1/2 + tail, SIXTH + tail).
fn stumpff_tails(z: f32) -> vec2f {
  if (abs(z) <= 0.1) {
    let t2 = z * (-1.0 / 24.0 + z * (1.0 / 720.0 + z * (-1.0 / 40320.0 + z * (1.0 / 3628800.0 + z * (-1.0 / 479001600.0)))));
    let t3 = z * (-1.0 / 120.0 + z * (1.0 / 5040.0 + z * (-1.0 / 362880.0 + z * (1.0 / 39916800.0 + z * (-1.0 / 6227020800.0)))));
    return vec2f(t2, t3);
  }
  let c = stumpff(z);
  return vec2f(c.x - 0.5, c.y - 1.0 / 6.0);
}

// Laguerre-Conway (n = 5) solution of r0 G1 + eta G2 + mu G3 = dt for the universal anomaly s, float32.
fn solve_s(r0: f32, eta: f32, beta: f32, dt: f32, s_in: f32) -> f32 {
  var s = s_in;
  for (var it = 0u; it < 20u; it = it + 1u) {
    let z = beta * s * s;
    let c = stumpff(z);
    let g1 = s * (1.0 - z * c.y);
    let g2 = s * s * c.x;
    let g3 = s * s * s * c.y;
    let g0 = 1.0 - z * c.x;
    let f = r0 * g1 + eta * g2 + MU_F * g3 - dt;
    let fp = r0 * g0 + eta * g1 + MU_F * g2;
    let fpp = eta * g0 + (MU_F - beta * r0) * g1;
    let disc = 16.0 * fp * fp - 20.0 * f * fpp;
    let den = fp + select(1.0, -1.0, fp < 0.0) * sqrt(abs(disc));
    if (den == 0.0) { break; }
    let ds = 5.0 * f / den;
    s = s - ds;
    if (abs(ds) <= 1e-7 * abs(s)) { break; }
  }
  return s;
}

// Two-body drift of the double-single state by dt (double-single, s). False if the solution is not finite.
fn kdrift(st: ptr<function, St>, dt: vec2f) -> bool {
  let x = *st;
  let r0d = dd_sqrt(dd_dot(x.xh, x.xl, x.xh, x.xl));
  let etad = dd_dot(x.xh, x.xl, x.vh, x.vl);
  let r0 = r0d.x;
  let eta = etad.x;
  // beta = 2 mu / r0 - v^2 cancels strongly near perihelion (x18 for q = 0.14 au); in float32 its error would reach
  // the z c2 terms of r at 2e-10. Double-single, rounded once.
  let beta = dd_add(dd_div(2.0 * MU, r0d), -dd_dot(x.vh, x.vl, x.vh, x.vl)).x;
  let dtf = dt.x + dt.y;
  var s = dtf / r0 - eta * dtf * dtf / (2.0 * r0 * r0 * r0);
  s = solve_s(r0, eta, beta, dtf, s);
  if (bad(s)) { return false; }
  // One Newton step on the time equation r0*G1 + eta*G2 + mu*G3 = dt, the first two terms in double-single.
  var z = beta * s * s;
  var tl = stumpff_tails(z);
  var c2d = quick_two_sum(0.5, tl.x);
  var c3 = SIXTH.x + tl.y;
  var G1 = dd_add_f(vec2f(s, 0.0), -s * z * c3);
  let F = dd_add_f(dd_add(dd_add(dd_mul(r0d, G1), dd_mul(etad, dd_mul(two_prod(s, s), c2d))), -dt), MU_F * s * s * s * c3);
  let Fp = r0 * (1.0 - z * c2d.x) + eta * G1.x + MU_F * s * s * c2d.x;
  let sd = two_sum(s, -(F.x + F.y) / Fp);
  if (bad(sd.x) || bad(sd.y)) { return false; }
  // Lagrange coefficients in double-single (every one of them multiplies a full x or v): with k = mu/(r r0),
  // f - 1 = -k r G2, g = dt - mu G3, fdot = -k G1, gdot - 1 = -k r0 G2.
  let sh = sd.x;
  z = beta * sh * sh;
  tl = stumpff_tails(z);
  c2d = quick_two_sum(0.5, tl.x);
  c3 = SIXTH.x + tl.y;
  G1 = dd_add_f(sd, -sh * z * c3);
  let G2 = dd_mul(dd_mul(sd, sd), c2d);
  let G3 = sh * sh * sh * c3;
  let rd = dd_add(r0d, dd_add_f(dd_mul(etad, G1), -r0 * z * c2d.x + MU_F * G2.x));
  let k = dd_div(MU, dd_mul(rd, r0d));
  let gd = dd_add_f(dt, -MU_F * G3);
  let fm1 = -dd_mul(k, dd_mul(rd, G2));
  let fdot = -dd_mul(k, G1);
  let gdm1 = -dd_mul(k, dd_mul(r0d, G2));
  var o = x;
  for (var j = 0u; j < 3u; j = j + 1u) {
    let xk = vec2f(x.xh[j], x.xl[j]);
    let vk = vec2f(x.vh[j], x.vl[j]);
    let nx = dd_add(xk, dd_add(dd_mul(gd, vk), dd_mul(fm1, xk)));
    let nv = dd_add(vk, dd_add(dd_mul(fdot, xk), dd_mul(gdm1, vk)));
    o.xh[j] = nx.x; o.xl[j] = nx.y; o.vh[j] = nv.x; o.vl[j] = nv.y;
  }
  *st = o;
  return true;
}

// Float32 two-body drift of a position (for the non-gravitational delay DT only).
fn kdrift_pos_f32(x: vec3f, v: vec3f, dt: f32) -> vec3f {
  let r0 = length(x);
  let eta = dot(x, v);
  let beta = 2.0 * MU_F / r0 - dot(v, v);
  var s = dt / r0 - eta * dt * dt / (2.0 * r0 * r0 * r0);
  s = solve_s(r0, eta, beta, dt, s);
  if (bad(s)) { return x; }
  let c = stumpff(beta * s * s);
  let f = 1.0 - MU_F * s * s * c.x / r0;
  let g = dt - MU_F * s * s * s * c.y;
  return f * x + g * v;
}

// ---- planets: T holds, per grid interval, body and sample, a double-single heliocentric position (2 vec4f);
// body NB holds the indirect acceleration (hi only). Four-point Lagrange interpolation around sample u.
fn tix(iv: u32, b: u32, j: u32) -> u32 { return ((iv * NBT + b) * NS + j) * 2u; }
struct Stencil { j0: u32, nn: u32, w: vec4f };
fn stencil(u: f32) -> Stencil {
  let j0 = u32(clamp(i32(floor(u)) - 1, 0, i32(NS) - 4));
  let x = u - f32(j0);
  let a = x - 1.0;
  let b = x - 2.0;
  let c = x - 3.0;
  let w = vec4f(-a * b * c / 6.0, x * b * c / 2.0, -x * a * c / 2.0, x * a * b / 6.0);
  return Stencil(j0, u32(clamp(round(x), 0.0, 3.0)), w);
}
// Planet b minus the object (km, float32 from double-single differences).
fn prel(b: u32, iv: u32, s: Stencil, xh: vec3f, xl: vec3f) -> vec3f {
  let bi = tix(iv, b, s.j0);
  let pnh = T[bi + 2u * s.nn].xyz;
  let pnl = T[bi + 2u * s.nn + 1u].xyz;
  var d = (pnh - xh) + (pnl - xl);
  for (var i = 0u; i < 4u; i = i + 1u) {
    if (i != s.nn) {
      d = d + s.w[i] * ((T[bi + 2u * i].xyz - pnh) + (T[bi + 2u * i + 1u].xyz - pnl));
    }
  }
  return d;
}

// Kick acceleration (all but the solar Kepler term) at sample coordinate u; status 1 = inside a body.
fn kick_accel(xh: vec3f, xl: vec3f, v: vec3f, u: f32, iv: u32, ngi: u32, out: ptr<function, vec3f>) -> u32 {
  let s = stencil(u);
  let r2 = dot(xh, xh);
  if (r2 < SUN_R2) { return 1u; }
  var acc = vec3f(0.0);
  for (var b = 0u; b < NB; b = b + 1u) {
    let d = prel(b, iv, s, xh, xl);
    let d2 = dot(d, d);
    if (d2 < RAD2[b]) { return 1u; }
    let id = inverseSqrt(d2);
    acc = acc + (GM[b] * id * id * id) * d;
    if (i32(b) == J2_INDEX) {
      let zz = -dot(d, POLE);
      let f = J2K * (id * id) * (id * id * id);
      let cc = 1.0 - 5.0 * zz * zz * id * id;
      acc = acc + f * (-cc * d + 2.0 * zz * POLE);
    }
  }
  let bi = tix(iv, NB, s.j0);
  acc = acc + s.w.x * T[bi].xyz + s.w.y * T[bi + 2u].xyz + s.w.z * T[bi + 4u].xyz + s.w.w * T[bi + 6u].xyz;
  let r = sqrt(r2);
  if (C2INV != 0.0) {
    let k = MU_F * C2INV / (r2 * r);
    acc = acc + k * ((4.0 * MU_F / r - dot(v, v)) * xh + 4.0 * dot(xh, v) * v);
  }
  if (ngi != 0u) {
    let p0 = NG[3u * (ngi - 1u)];
    let p1 = NG[3u * (ngi - 1u) + 1u];
    let p2 = NG[3u * (ngi - 1u) + 2u];
    var rr = r;
    if (p0.w != 0.0) { rr = length(kdrift_pos_f32(xh, v, -p0.w)); }
    let uu = rr / p1.y;
    let g = p1.x * pow(uu, -p1.z) * pow(1.0 + pow(uu, p1.w), -p2.x);
    let n = normalize(cross(xh, v));
    let ur = xh / r;
    let tt = cross(n, ur);
    acc = acc + g * (p0.x * ur + p0.y * tt + p0.z * n);
  }
  *out = acc;
  return 0u;
}

// Substep level (forceModel.stepControl, as core/smallbody.ts substepLevel): x = level, y = dominance.
fn substep_level(st: St, h: f32, iv: u32, u0: f32, u1: f32) -> vec2f {
  let xh = st.xh;
  let vh = st.vh;
  let r = length(xh);
  let vn = length(vh);
  let hv = cross(xh, vh);
  let rv = dot(xh, vh);
  let k1 = vn * vn - MU_F / r;
  let ecc = length((k1 * xh - rv * vh) / MU_F);
  let q = dot(hv, hv) / MU_F / (1.0 + ecc);
  let rEff = max(q, r - vn * abs(h));
  let tauSun = sqrt(rEff * rEff * rEff / MU_F);
  var hmax = ETA_SUN * tauSun;
  let lo = min(0.0, h);
  let hi = max(0.0, h);
  let aSun = MU_F / (r * r);
  var dom = 0.0;
  let sa = stencil(u0);
  let sb = stencil(u1);
  for (var b = 0u; b < NB; b = b + 1u) {
    let d = prel(b, iv, sa, xh, st.xl);
    let de = prel(b, iv, sb, xh, st.xl);
    let uv = (de - d) / h - vh;
    let u2 = dot(uv, uv);
    var tc = 0.0;
    if (u2 > 0.0) { tc = clamp(-dot(d, uv) / u2, lo, hi); }
    let dMin = max(length(d + uv * tc), RAD[b]);
    var tau = sqrt(dMin * dMin * dMin / GM[b]);
    if (u2 > 0.0) { tau = min(tau, dMin / sqrt(u2)); }
    let dp = GM[b] / (dMin * dMin) / aSun;
    hmax = min(hmax, select(ETA_PLANET, ETA_ENC, dp > ENC_RATIO) * tau);
    dom = max(dom, dp);
  }
  if (dom > ENC_RATIO) { hmax = min(hmax, ETA_ENC * tauSun); }
  let ha = abs(h);
  if (ha <= hmax) { return vec2f(0.0, dom); }
  return vec2f(clamp(ceil(log2(ha / hmax)), 0.0, KMAX), dom);
}

fn ucoord(t: vec2f, tk: vec2f) -> f32 {
  let d = dd_add(t, -tk);
  return (d.x + d.y) * INV_SAMPLE_DT;
}

// One composition step (drift, kick, ..., drift) of length hs from ts.
fn saba(st: ptr<function, St>, ts: vec2f, hs: vec2f, iv: u32, tk: vec2f, ngi: u32) -> u32 {
  var tc = ts;
  let hf = hs.x + hs.y;
  for (var i = 0u; i < NDRIFT; i = i + 1u) {
    let dt = dd_mul(DRIFT[i], hs);
    if (dt.x != 0.0) {
      if (!kdrift(st, dt)) { return 3u; }
    }
    tc = dd_add(tc, dt);
    if (i == NKICK) { break; }
    var a: vec3f;
    let s = kick_accel((*st).xh, (*st).xl, (*st).vh, ucoord(tc, tk), iv, ngi, &a);
    if (s != 0u) { return s; }
    let k = dd_mul(KICK[i], hs);
    let kf = k.x + k.y;
    for (var j = 0u; j < 3u; j = j + 1u) {
      let nv = dd_add_f(vec2f((*st).vh[j], (*st).vl[j]), kf * a[j]);
      (*st).vh[j] = nv.x;
      (*st).vl[j] = nv.y;
    }
  }
  return 0u;
}

// Double-single 3-vectors for the encounter (RK4) path.
struct D3 { h: vec3f, l: vec3f };
fn d3_add(a: D3, b: D3) -> D3 {
  var o: D3;
  for (var j = 0u; j < 3u; j = j + 1u) {
    let s = dd_add(vec2f(a.h[j], a.l[j]), vec2f(b.h[j], b.l[j]));
    o.h[j] = s.x;
    o.l[j] = s.y;
  }
  return o;
}
fn d3_add_f(a: D3, b: vec3f) -> D3 {
  var o: D3;
  for (var j = 0u; j < 3u; j = j + 1u) {
    let s = dd_add_f(vec2f(a.h[j], a.l[j]), b[j]);
    o.h[j] = s.x;
    o.l[j] = s.y;
  }
  return o;
}
fn d3_mul(a: D3, k: vec2f) -> D3 {
  var o: D3;
  for (var j = 0u; j < 3u; j = j + 1u) {
    let s = dd_mul(vec2f(a.h[j], a.l[j]), k);
    o.h[j] = s.x;
    o.l[j] = s.y;
  }
  return o;
}
// The Sun's acceleration -mu x / |x|^3 in double-single (it is summed over RK4 stages into the velocity, where
// float32 would leave ~6e-8 of a_sun h per substep).
fn sun_dd(xh: vec3f, xl: vec3f) -> D3 {
  let r2 = dd_dot(xh, xl, xh, xl);
  let k = -dd_div(MU, dd_mul(r2, dd_sqrt(r2)));
  return d3_mul(D3(xh, xl), k);
}

// Classical RK4 on the full equations (encounter mode). Stage positions in double-single with float32 h^2 a
// terms; the final combination carries the Sun's part in double-single, the planets' part in float32:
//   x' = x + h v + h^2/6 (a1 + a2 + a3),  v' = v + h/6 (a1 + 2 a2 + 2 a3 + a4).
fn rk4(st: ptr<function, St>, ts: vec2f, hs: vec2f, iv: u32, tk: vec2f, ngi: u32) -> u32 {
  let y = *st;
  let h = hs.x + hs.y;
  let X = D3(y.xh, y.xl);
  let hV = d3_mul(D3(y.vh, y.vl), hs);
  let u0 = ucoord(ts, tk);
  let um = ucoord(dd_add(ts, 0.5 * hs), tk);
  let u1 = ucoord(dd_add(ts, hs), tk);
  var p1: vec3f;
  var p2: vec3f;
  var p3: vec3f;
  var p4: vec3f;
  var s = kick_accel(X.h, X.l, y.vh, u0, iv, ngi, &p1);
  if (s != 0u) { return s; }
  let s1 = sun_dd(X.h, X.l);
  let a1 = p1 + s1.h;
  let x2 = d3_add(X, D3(0.5 * hV.h, 0.5 * hV.l));
  s = kick_accel(x2.h, x2.l, y.vh + 0.5 * h * a1, um, iv, ngi, &p2);
  if (s != 0u) { return s; }
  let s2 = sun_dd(x2.h, x2.l);
  let a2 = p2 + s2.h;
  let x3 = d3_add_f(x2, 0.25 * h * h * a1);
  s = kick_accel(x3.h, x3.l, y.vh + 0.5 * h * a2, um, iv, ngi, &p3);
  if (s != 0u) { return s; }
  let s3 = sun_dd(x3.h, x3.l);
  let a3 = p3 + s3.h;
  let xhv = d3_add(X, hV);
  let x4 = d3_add_f(xhv, 0.5 * h * h * a2);
  s = kick_accel(x4.h, x4.l, y.vh + h * a3, u1, iv, ngi, &p4);
  if (s != 0u) { return s; }
  let s4 = sun_dd(x4.h, x4.l);
  let hs6 = dd_mul(hs, SIXTH);
  let h2s6 = dd_mul(hs, hs6);
  let sx = d3_add(d3_add(s1, s2), s3);
  let sv = d3_add(d3_add(sx, d3_add(s2, s3)), s4);
  let nx = d3_add_f(d3_add(xhv, d3_mul(sx, h2s6)), (h * h / 6.0) * (p1 + p2 + p3));
  let nv = d3_add_f(d3_add(D3(y.vh, y.vl), d3_mul(sv, hs6)), (h / 6.0) * (p1 + 2.0 * p2 + 2.0 * p3 + p4));
  *st = St(nx.h, nx.l, nv.h, nv.l);
  return 0u;
}

// A step of length h (double-single, signed) from t0 inside grid interval iv (starting at tk): substep level from
// the state at t0, then 2^level SABA or RK4 substeps. Status 0 ok, 1 collided, 3 no convergence.
fn advance(st: ptr<function, St>, t0: vec2f, h: vec2f, iv: u32, tk: vec2f, ngi: u32) -> u32 {
  let hf = h.x + h.y;
  if (hf == 0.0) { return 0u; }
  let u0 = ucoord(t0, tk);
  let lv = substep_level(*st, hf, iv, u0, u0 + hf * INV_SAMPLE_DT);
  let lvl = u32(lv.x);
  let n = 1u << lvl;
  let inv = 1.0 / f32(n);
  let hs = vec2f(h.x * inv, h.y * inv);
  let enc = lv.y > ENC_RATIO;
  for (var j = 0u; j < n; j = j + 1u) {
    let ts = dd_add(t0, dd_mul_f(hs, f32(j)));
    var s: u32;
    if (enc) { s = rk4(st, ts, hs, iv, tk, ngi); } else { s = saba(st, ts, hs, iv, tk, ngi); }
    if (s != 0u) { return s; }
  }
  return 0u;
}

fn load_state(i: u32) -> St {
  let a = S[3u * i];
  let b = S[3u * i + 1u];
  let c = S[3u * i + 2u];
  return St(a.xyz, vec3f(b.zw, c.x), vec3f(a.w, b.xy), c.yzw);
}
`;

function photometryWgsl(p: SmallBodyPhotometry | null, auKm: number): string {
  if (!p) {
    return /* wgsl */ `
const HAVE_PHOT = false;
const AU_KM: f32 = ${f32(auKm)};
fn light(pp0: vec4u, pp1: vec4u, rAu: f32, dAu: f32, alpha: f32, mode: u32) -> vec4f { return vec4f(0.0); }
`;
  }
  const basisFn = (name: string, b: SmallBodyPhotometry['hg1g2']['phi1']) => {
    const x = b.nodesRad;
    const parts: string[] = [];
    parts.push(`if (a < ${f32(x[0])}) { v = ${f32(b.values[0])} + ${f32(b.endDerivatives[0])} * (a - ${f32(x[0])}); }`);
    for (let i = 0; i < x.length - 1; i++) {
      const c = b.coefficients[i];
      parts.push(`else if (a < ${f32(x[i + 1])}) { let t = a - ${f32(x[i])}; v = ${f32(c[0])} + t * (${f32(c[1])} + t * (${f32(c[2])} + t * ${f32(c[3])})); }`);
    }
    parts.push(`else { v = ${f32(b.values[x.length - 1])} + ${f32(b.endDerivatives[1])} * (a - ${f32(x[x.length - 1])}); }`);
    return `fn ${name}(a: f32) -> f32 {\n  var v: f32;\n  ${parts.join('\n  ')}\n  return max(v, 0.0);\n}\n`;
  };
  const hg = p.hg;
  const sun = p.sunIrradianceXYZS1AU.value!;
  return /* wgsl */ `
const HAVE_PHOT = true;
const AU_KM: f32 = ${f32(auKm)};
const SUN_XYZS = vec4f(${sun.map(f32).join(', ')});
const V_SUN: f32 = ${f32(p.vSun.value!)};
${basisFn('hg1g2_phi1', p.hg1g2.phi1)}
${basisFn('hg1g2_phi2', p.hg1g2.phi2)}
${basisFn('hg1g2_phi3', p.hg1g2.phi3)}
// IAU H-G (Bowell et al. 1989 Eq. A4, sbpy's form).
fn hg_phi(alpha: f32, g: f32) -> f32 {
  let t = tan(0.5 * alpha);
  let s = sin(alpha);
  let w = exp(-${f32(hg.W)} * t * t);
  let den = ${f32(hg.smallPhase[0])} + ${f32(hg.smallPhase[1])} * s - ${f32(hg.smallPhase[2])} * s * s;
  var l1 = 1.0;
  var l2 = 1.0;
  if (t > 0.0) {
    l1 = exp(-${f32(hg.A[0])} * pow(t, ${f32(hg.B[0])}));
    l2 = exp(-${f32(hg.A[1])} * pow(t, ${f32(hg.B[1])}));
  }
  let p1 = w * (1.0 - ${f32(hg.C[0])} * s / den) + (1.0 - w) * l1;
  let p2 = w * (1.0 - ${f32(hg.C[1])} * s / den) + (1.0 - w) * l2;
  return (1.0 - g) * p1 + g * p2;
}
fn log10f(x: f32) -> f32 { return log2(x) * ${f32(Math.LOG10E / Math.LOG2E)}; }

// Illuminance (X, Y, Z, S lux) at the eye, or 0 when the object's brightness is not allowed at this level.
// pp0 = (H|M bits, p1:p2 f16, cX:cY f16, cZ:cS f16), pp1 = (phaseMin:phaseMax f16 deg, codes, core index, 0).
fn light(pp0: vec4u, pp1: vec4u, rAu: f32, dAu: f32, alpha: f32, mode: u32) -> vec4f {
  let code = pp1.y;
  let model = code & 15u;
  if (model == 0u) { return vec4f(0.0); }
  let maxLab = select(select(3u, 2u, mode == 1u), 1u, mode == 0u);
  let adeg = alpha * ${f32(180 / Math.PI)};
  let pr = unpack2x16float(pp1.x);
  var lab = (code >> 4u) & 7u;
  if (model == 2u && (adeg < pr.x || adeg > pr.y)) { lab = (code >> 7u) & 7u; }
  if (lab > maxLab || ((code >> 10u) & 7u) > maxLab) { return vec4f(0.0); }
  let hm = bitcast<f32>(pp0.x);
  let pq = unpack2x16float(pp0.y);
  var m: f32;
  if (model == 1u) {
    m = hm + 5.0 * log10f(rAu * dAu) - 2.5 * log10f(max(hg_phi(alpha, pq.x), 1e-30));
  } else if (model == 2u) {
    let ph = pq.x * hg1g2_phi1(alpha) + pq.y * hg1g2_phi2(alpha) + (1.0 - pq.x - pq.y) * hg1g2_phi3(alpha);
    m = hm + 5.0 * log10f(rAu * dAu) - 2.5 * log10f(max(ph, 1e-30));
  } else if (model == 3u) {
    m = hm + 5.0 * log10f(dAu) + pq.x * log10f(rAu);
  } else {
    m = hm + 5.0 * log10f(dAu) + pq.x * log10f(rAu) + pq.y * adeg;
  }
  var c = vec4f(1.0);
  if (mode != 0u || ((code >> 13u) & 1u) == 1u) {
    c = vec4f(unpack2x16float(pp0.z), unpack2x16float(pp0.w));
  }
  return SUN_XYZS * c * exp2(-0.4 * ${f32(Math.log2(10))} * (m - V_SUN));
}
`;
}

/** Propagation step kernel: advances every object one grid step (StepU) in place. */
export function stepShader(cfg: KernelConfig): string {
  return /* wgsl */ `
${DF64_WGSL}
${perturberConsts(cfg.model)}
const NS: u32 = ${cfg.samples}u;
const INV_SAMPLE_DT: f32 = ${f32((cfg.samples - 1) / cfg.model.grid.baseStepS)};
struct FieldU { count: u32, zeroBits: u32, pad0: u32, pad1: u32 };
struct StepU { t0: vec2f, h: vec2f, tk: vec2f, iv: u32, first: u32, n: u32, groupsX: u32, pad0: u32, pad1: u32 };
@group(0) @binding(0) var<uniform> F: FieldU;
@group(0) @binding(1) var<uniform> SU: StepU;
@group(0) @binding(2) var<storage, read_write> S: array<vec4f>;
@group(0) @binding(3) var<storage, read> T: array<vec4f>;
@group(0) @binding(4) var<storage, read> PI: array<u32>;
@group(0) @binding(5) var<storage, read> NG: array<vec4f>;
${DYNAMICS_WGSL}
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) gid: vec3u) {
  ZB = F.zeroBits;
  let j = gid.x + gid.y * SU.groupsX * ${WG}u;
  if (j >= SU.n) { return; }
  let i = SU.first + j;
  if (i >= F.count) { return; }
  let info = PI[i];
  if ((info & 0xC0000000u) != 0u) { return; }
  var st = load_state(i);
  if (bad(st.xh.x)) { return; }
  let s = advance(&st, SU.t0, SU.h, SU.iv, SU.tk, info & 0xFFFFu);
  if (s != 0u) {
    st.xh = vec3f(nanf());
  }
  S[3u * i] = vec4f(st.xh, st.vh.x);
  S[3u * i + 1u] = vec4f(st.vh.yz, st.xl.xy);
  S[3u * i + 2u] = vec4f(st.xl.z, st.vl);
}
`;
}

/**
 * Shade kernel: the display step from the working grid point to et (not stored), light time, direction and
 * illuminance, written as star-layout records [dir.xyz, X, Y, Z, S, bitcast(core index)].
 */
export function shadeShader(cfg: KernelConfig): string {
  return /* wgsl */ `
${DF64_WGSL}
${perturberConsts(cfg.model)}
const NS: u32 = ${cfg.samples}u;
const INV_SAMPLE_DT: f32 = ${f32((cfg.samples - 1) / cfg.model.grid.baseStepS)};
const C_KM_S: f32 = ${f32(cfg.cKmS)};
struct FieldU { count: u32, zeroBits: u32, pad0: u32, pad1: u32 };
struct FrameU {
  camH: vec4f, camL: vec4f, sunV: vec4f,
  t0: vec2f, h: vec2f, tk: vec2f, iv: u32, mode: u32,
  flags: u32, first: u32, n: u32, groupsX: u32,
};
@group(0) @binding(0) var<uniform> F: FieldU;
@group(0) @binding(1) var<uniform> FR: FrameU;
@group(0) @binding(2) var<storage, read> S: array<vec4f>;
@group(0) @binding(3) var<storage, read> T: array<vec4f>;
@group(0) @binding(4) var<storage, read> PI: array<u32>;
@group(0) @binding(5) var<storage, read> NG: array<vec4f>;
@group(0) @binding(6) var<storage, read> PH: array<vec4u>;
@group(0) @binding(7) var<storage, read_write> R: array<vec4u>;
@group(0) @binding(8) var<storage, read_write> DBG: array<vec4f>;
// [drawn, withheld]: objects with a position whose light is / is not admitted at this level.
@group(0) @binding(9) var<storage, read_write> CNT: array<atomic<u32>, 2>;
${DYNAMICS_WGSL}
${photometryWgsl(cfg.photometry, cfg.auKm)}
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) gid: vec3u) {
  ZB = F.zeroBits;
  let j = gid.x + gid.y * FR.groupsX * ${WG}u;
  if (j >= FR.n) { return; }
  let i = FR.first + j;
  if (i >= F.count) { return; }
  let pp0 = PH[2u * i];
  let pp1 = PH[2u * i + 1u];
  let idx = pp1.z;
  let info = PI[i];
  var st: St;
  // Not drawn: no state (unknown / lost position, planetary-ephemeris objects), or the whole field is hidden.
  var ok = (info & 0xC0000000u) == 0u && (FR.flags & 2u) == 0u;
  if (ok) {
    st = load_state(i);
    ok = !bad(st.xh.x);
    if (ok && (FR.h.x != 0.0)) {
      ok = advance(&st, FR.t0, FR.h, FR.iv, FR.tk, info & 0xFFFFu) == 0u;
    }
  }
  if ((FR.flags & 1u) != 0u) {
    if (ok) {
      DBG[4u * i] = vec4f(st.xh, 0.0);
      DBG[4u * i + 1u] = vec4f(st.xl, 0.0);
      DBG[4u * i + 2u] = vec4f(st.vh, 0.0);
      DBG[4u * i + 3u] = vec4f(st.vl, 0.0);
    } else {
      DBG[4u * i] = vec4f(nanf());
    }
  }
  if (!ok) {
    R[2u * i] = vec4u(0u);
    R[2u * i + 1u] = vec4u(0u, 0u, 0u, idx);
    return;
  }
  // Camera-relative position, back-dated by the light time (first order, SSB velocity).
  var rel = (st.xh - FR.camH.xyz) + (st.xl - FR.camL.xyz);
  let tau = length(rel) / C_KM_S;
  rel = rel - tau * (st.vh + FR.sunV.xyz);
  let xo = st.xh - tau * st.vh;
  let dist = length(rel);
  let dir = rel / dist;
  let r = length(xo);
  let alpha = atan2(length(cross(xo, rel)), dot(xo, rel));
  var e = vec4f(0.0);
  if (HAVE_PHOT) { e = light(pp0, pp1, r / AU_KM, dist / AU_KM, alpha, FR.mode); }
  if (e.y > 0.0) { atomicAdd(&CNT[0], 1u); } else { atomicAdd(&CNT[1], 1u); }
  // Excluded (the shell draws the object itself, e.g. a resolved close-up): no point, but still pickable.
  if ((info & 0x20000000u) != 0u) { e = vec4f(0.0); }
  R[2u * i] = bitcast<vec4u>(vec4f(dir, e.x));
  R[2u * i + 1u] = vec4u(bitcast<vec3u>(e.yzw), idx);
}
`;
}

/**
 * Pick: two passes over the records. The cone test uses the squared chord |u - dir|^2 <= P.dir.w (accurate for small
 * angles in float32, unlike 1 - cos). Pass 0: max apparent Y (O[0]) and min chord (O[1]) inside the cone; pass 1: the
 * smallest core index matching each (O[2], O[3]).
 */
export const PICK_SHADER = /* wgsl */ `
struct PickU { dir: vec4f, count: u32, groupsX: u32, pass_: u32, pad: u32 };
@group(0) @binding(0) var<uniform> P: PickU;
@group(0) @binding(1) var<storage, read> R: array<vec4u>;
@group(0) @binding(2) var<storage, read_write> O: array<atomic<u32>, 4>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x + gid.y * P.groupsX * 256u;
  if (i >= P.count) { return; }
  let a = bitcast<vec4f>(R[2u * i]);
  let bu = R[2u * i + 1u];
  let y = bitcast<f32>(bu.x);
  if (dot(a.xyz, a.xyz) < 0.25) { return; }
  let dd = a.xyz - P.dir.xyz;
  let c2 = dot(dd, dd);
  if (c2 > P.dir.w) { return; }
  let cb = bitcast<u32>(c2);
  let yb = bitcast<u32>(max(y, 0.0));
  if (P.pass_ == 0u) {
    atomicMin(&O[1], cb);
    if (y > 0.0) { atomicMax(&O[0], yb); }
  } else {
    if (y > 0.0 && yb == atomicLoad(&O[0])) { atomicMin(&O[2], bu.w); }
    if (cb == atomicLoad(&O[1])) { atomicMin(&O[3], bu.w); }
  }
}
`;

/** Constants of the synthetic-object kernel (from synthetic/objects.json and smallbodies/core.json). */
export interface SyntheticKernelConfig {
  gmSun: number;
  auKm: number;
  cKmS: number;
  obliquityRad: number;
  /** Slope parameter of the H-G law given to every synthetic object. */
  slopeG: number;
  /** Colour relative to sunlight (X, Y, Z, S) per core colorClass index; null entries draw grey (1, 1, 1, 1). */
  classColours: ([number, number, number, number] | null)[];
  photometry: SmallBodyPhotometry | null;
}

/** Brightness code of a synthetic object for `light`: H-G law (model 1), every label synthetic (3). */
export const SYNTHETIC_CODE = (1 | (3 << 4) | (3 << 7) | (3 << 10) | (3 << 14)) >>> 0;

/**
 * Synthetic objects (the COMPLETE level): two-body motion of their elements (fixed Kepler ellipses about the Sun;
 * mean motion and mean anomaly in df64, the rest float32, ~1e-7 relative), light time, direction and illuminance,
 * written as star-layout records after the catalogue's (index = base + object). Elements per object:
 * vec4(a au, e, i rad, node rad), vec4(peri rad, M0 rad at epochEt, H, bitcast(colour class)).
 */
export function syntheticShader(cfg: SyntheticKernelConfig): string {
  const cls = cfg.classColours.length ? cfg.classColours : [null];
  const clsLit = cls.map((c) => (c && c.every(Number.isFinite) ? `vec4f(${c.map(f32).join(', ')})` : 'vec4f(1.0)')).join(', ');
  return /* wgsl */ `
${DF64_WGSL}
${photometryWgsl(cfg.photometry, cfg.auKm)}
const C_KM_S: f32 = ${f32(cfg.cKmS)};
const MU_DD = ${df(cfg.gmSun)};
const AU_DD = ${df(cfg.auKm)};
const TWO_PI_DD = ${df(2 * Math.PI)};
const INV_TWO_PI: f32 = ${f32(1 / (2 * Math.PI))};
const PI_F: f32 = ${f32(Math.PI)};
const COS_OBL: f32 = ${f32(Math.cos(cfg.obliquityRad))};
const SIN_OBL: f32 = ${f32(Math.sin(cfg.obliquityRad))};
const SLOPE_G: f32 = ${f32(cfg.slopeG)};
const NCLS: u32 = ${cls.length}u;
const CLS = array<vec4f, ${cls.length}>(${clsLit});
struct SynU {
  camH: vec4f, camL: vec4f, sunV: vec4f,
  dt: vec2f, mode: u32, zeroBits: u32,
  first: u32, n: u32, groupsX: u32, base: u32,
};
@group(0) @binding(0) var<uniform> U: SynU;
@group(0) @binding(1) var<storage, read> EL: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> R: array<vec4u>;
// [catalogue drawn, catalogue withheld, synthetic drawn, synthetic withheld]
@group(0) @binding(3) var<storage, read_write> CNT: array<atomic<u32>, 4>;

fn ecl_to_icrf(v: vec3f) -> vec3f { return vec3f(v.x, COS_OBL * v.y - SIN_OBL * v.z, SIN_OBL * v.y + COS_OBL * v.z); }

// (sin x, cos x) to ~1 ulp for |x| < 1e5: WGSL's sin/cos are only required to be accurate to 2^-11 absolute (and
// software devices are that coarse), which would move a synthetic object by ~1e-4 of its distance. Cody-Waite
// reduction by pi/2 (three-part constant) and the minimax polynomials of the Cephes sinf/cosf on [-pi/4, pi/4].
fn sincos_acc(x: f32) -> vec2f {
  let q = round(x * 0.63661977236758134);
  var r = x - q * 1.5703125;
  r = r - q * 4.837512969970703125e-4;
  r = r - q * 7.549789954891882e-8;
  let z = r * r;
  let sn = r + r * z * (-1.6666654611e-1 + z * (8.3321608736e-3 + z * -1.9515295891e-4));
  let cs = 1.0 - 0.5 * z + z * z * (4.166664568298827e-2 + z * (-1.388731625493765e-3 + z * 2.443315711809948e-5));
  let k = i32(q) & 3;
  if (k == 0) { return vec2f(sn, cs); }
  if (k == 1) { return vec2f(cs, -sn); }
  if (k == 2) { return vec2f(-sn, -cs); }
  return vec2f(-cs, sn);
}

@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) gid: vec3u) {
  ZB = U.zeroBits;
  let j = gid.x + gid.y * U.groupsX * ${WG}u;
  if (j >= U.n) { return; }
  let i = U.first + j;
  let e0 = EL[2u * i];
  let e1 = EL[2u * i + 1u];
  let idx = U.base + i;
  let ecc = e0.y;
  // Mean anomaly M0 + n dt in df64, reduced to [0, 2 pi).
  let a_dd = dd_mul_f(AU_DD, e0.x);
  let nn = dd_sqrt(dd_div(MU_DD, dd_mul(dd_mul(a_dd, a_dd), a_dd)));
  var M = dd_add_f(dd_mul(nn, U.dt), e1.y);
  let k = floor(M.x * INV_TWO_PI);
  M = dd_add(M, dd_mul_f(TWO_PI_DD, -k));
  var m = M.x + M.y;
  m = m - 2.0 * PI_F * floor(m * INV_TWO_PI);
  var E = select(PI_F, m + ecc * sincos_acc(m).x, ecc < 0.8);
  for (var it = 0; it < 20; it = it + 1) {
    let t = sincos_acc(E);
    let d = (E - ecc * t.x - m) / (1.0 - ecc * t.y);
    E = E - d;
    if (abs(d) < 2e-7) { break; }
  }
  let a = a_dd.x;
  let b = a * sqrt(max(0.0, 1.0 - ecc * ecc));
  let tE = sincos_acc(E);
  let cE = tE.y;
  let sE = tE.x;
  let edot = (nn.x + nn.y) / (1.0 - ecc * cE);
  let ti = sincos_acc(e0.z); let ci = ti.y; let si = ti.x;
  let tO = sincos_acc(e0.w); let cO = tO.y; let sO = tO.x;
  let tw = sincos_acc(e1.x); let cw = tw.y; let sw = tw.x;
  let P = vec3f(cO * cw - sO * sw * ci, sO * cw + cO * sw * ci, sw * si);
  let Q = vec3f(-cO * sw - sO * cw * ci, -sO * sw + cO * cw * ci, cw * si);
  let pos = ecl_to_icrf((a * (cE - ecc)) * P + (b * sE) * Q);
  let vel = ecl_to_icrf((-a * sE * edot) * P + (b * cE * edot) * Q);
  // Camera-relative position, back-dated by the light time (first order, SSB velocity).
  var rel = (pos - U.camH.xyz) - U.camL.xyz;
  let tau = length(rel) / C_KM_S;
  rel = rel - tau * (vel + U.sunV.xyz);
  let xo = pos - tau * vel;
  let dist = length(rel);
  let dir = rel / dist;
  let r = length(xo);
  let alpha = atan2(length(cross(xo, rel)), dot(xo, rel));
  let cc = bitcast<u32>(e1.w);
  let c = select(vec4f(1.0), CLS[min(cc, NCLS - 1u)], cc < NCLS);
  let pp0 = vec4u(bitcast<u32>(e1.z), pack2x16float(vec2f(SLOPE_G, 0.0)), pack2x16float(c.xy), pack2x16float(c.zw));
  let pp1 = vec4u(pack2x16float(vec2f(0.0, 180.0)), ${SYNTHETIC_CODE}u, idx, 0u);
  var e = vec4f(0.0);
  if (HAVE_PHOT && !bad(dist)) { e = light(pp0, pp1, r / AU_KM, dist / AU_KM, alpha, U.mode); }
  if (e.y > 0.0) { atomicAdd(&CNT[2], 1u); } else { atomicAdd(&CNT[3], 1u); }
  R[2u * idx] = bitcast<vec4u>(vec4f(dir, e.x));
  R[2u * idx + 1u] = vec4u(bitcast<vec3u>(e.yzw), idx);
}
`;
}

/** Device self-test of the double-single primitives (compared with float64 on the CPU in ./field.ts). */
export const SELFTEST_SHADER = /* wgsl */ `
${DF64_WGSL}
struct FieldU { count: u32, zeroBits: u32, pad0: u32, pad1: u32 };
@group(0) @binding(0) var<uniform> F: FieldU;
@group(0) @binding(1) var<storage, read> IN: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> OUT: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3u) {
  ZB = F.zeroBits;
  let i = gid.x;
  if (i >= F.count) { return; }
  let v = IN[i];
  let a = v.xy;
  let b = v.zw;
  OUT[3u * i] = vec4f(two_prod(a.x, b.x), two_sum(a.x, b.x));
  OUT[3u * i + 1u] = vec4f(dd_mul(a, b), dd_add(a, b));
  OUT[3u * i + 2u] = vec4f(dd_div(a, b), dd_sqrt(vec2f(abs(a.x), select(a.y, -a.y, a.x < 0.0))));
}
`;

/** Test kernel: one Kepler drift (kdrift) per case (mode 0), or one kick acceleration (mode 1), vs the CPU. */
export function unitTestShader(cfg: KernelConfig): string {
  return /* wgsl */ `
${DF64_WGSL}
${perturberConsts(cfg.model)}
const NS: u32 = ${cfg.samples}u;
const INV_SAMPLE_DT: f32 = ${f32((cfg.samples - 1) / cfg.model.grid.baseStepS)};
struct FieldU { count: u32, zeroBits: u32, mode: u32, iv: u32 };
@group(0) @binding(0) var<uniform> F: FieldU;
@group(0) @binding(1) var<storage, read> S: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> OUT: array<vec4f>;
@group(0) @binding(3) var<storage, read> T: array<vec4f>;
@group(0) @binding(4) var<storage, read> NG: array<vec4f>;
${DYNAMICS_WGSL}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid: vec3u) {
  ZB = F.zeroBits;
  let i = gid.x;
  if (i >= F.count) { return; }
  var st = load_state(i);
  let p = S[3u * F.count + i];
  if (F.mode == 0u) {
    if (!kdrift(&st, p.xy)) { st.xh = vec3f(nanf()); }
    OUT[3u * i] = vec4f(st.xh, st.vh.x);
    OUT[3u * i + 1u] = vec4f(st.vh.yz, st.xl.xy);
    OUT[3u * i + 2u] = vec4f(st.xl.z, st.vl);
  } else {
    var a: vec3f;
    let s = kick_accel(st.xh, st.xl, st.vh, p.z, F.iv, 0u, &a);
    OUT[3u * i] = vec4f(a, f32(s));
  }
}
`;
}
