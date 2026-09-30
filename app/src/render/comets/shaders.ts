// WGSL of the comet passes (./layer.ts). Both draw absolute luminance (XYZS, cd/m²) additively into the HDR target
// EXT, depth-tested against the bodies (reversed Z), so the eye model treats comae and tails like any extended light.
//
// COMA: one camera-facing quad per coma around the nucleus direction. Each pixel gets the light the coma puts inside
// it, from a table of the enclosed illuminance C(θ) (lux within angular radius θ, log-spaced). Within NEAR_PX pixels
// of the nucleus the pixel square is integrated exactly: NEAR_STEPS thin rings, each contributing its light times the
// fraction of its area inside the square (closed-form disc ∩ rectangle area). Farther out the ring between θ − h and
// θ + h (h = half the pixel size) shared in proportion to the pixel's solid angle is enough. The pixels sum to the
// coma's total whatever its size, to 0.2 % (model.ts pixelIlluminance is the same function on the CPU, tested).
// Also writes the coma's Ricco weight into W (min-blended).
//
// PACKETS: Gaussian splats (dust-tail grain packets, ion-tail segments) of given illuminance and width (km), at
// their own distance; widths below 0.6 px are widened to 0.6 px so the splat still integrates to its illuminance.

import { COMMON } from '../shaders';
import { LUT_SIZE, NEAR_PX, NEAR_STEPS } from './model';

const f = (x: number) => (Number.isInteger(x) ? `${x}.0` : `${x}`);

export const COMA_SHADER = COMMON + /* wgsl */ `
struct Coma {
  n: vec4f,    // unit direction of the nucleus (camera-relative ICRF), w = distance (km)
  e1: vec4f,   // tangent-plane basis, w = quad half-extent (tan units)
  e2: vec4f,   // w = Ricco weight (W target)
  lut: vec4f,  // x = theta0 (rad), y = ln(theta1 / theta0), z = first LUT entry, w unused
};
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<storage, read> comae: array<Coma>;
@group(0) @binding(2) var<storage, read> luts: array<vec4f>;

struct VO { @builtin(position) pos: vec4f, @location(0) xy: vec2f, @location(1) @interpolate(flat) inst: u32 };

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let C = comae[ii];
  let xy = corners[vi] * C.e1.w;
  let d = C.n.xyz + xy.x * C.e1.xyz + xy.y * C.e2.xyz;
  let cc = toCam(F, d);
  var o: VO;
  o.pos = vec4f(cc.x * F.proj.x, cc.y * F.proj.y, 0.0, -cc.z);
  o.xy = xy;
  o.inst = ii;
  return o;
}

/** Enclosed illuminance within angular radius theta (log-theta interpolation of the table). */
fn enclosedAt(C: Coma, theta: f32) -> vec4f {
  let base = u32(C.lut.z);
  if (theta <= 0.0) { return vec4f(0.0); }
  if (theta <= C.lut.x) { return luts[base] * (theta / C.lut.x); }
  let x = log(theta / C.lut.x) / C.lut.y * ${f(LUT_SIZE - 1)};
  if (x >= ${f(LUT_SIZE - 1)}) { return luts[base + ${LUT_SIZE - 1}u]; }
  let i = min(u32(floor(x)), ${LUT_SIZE - 2}u);
  let t = x - f32(i);
  return mix(luts[base + i], luts[base + i + 1u], t);
}

/** Area of the disc of radius rho inside [0, x] x [0, y] (x, y >= 0) (model.ts quadrantDiscArea). */
fn quadrantDiscArea(x: f32, y: f32, rho: f32) -> f32 {
  if (x <= 0.0 || y <= 0.0 || rho <= 0.0) { return 0.0; }
  let r2 = rho * rho;
  let xm = min(x, rho);
  let u0 = min(sqrt(max(r2 - y * y, 0.0)), xm);
  let s1 = 0.5 * (xm * sqrt(max(r2 - xm * xm, 0.0)) + r2 * asin(min(xm / rho, 1.0)));
  let s0 = 0.5 * (u0 * sqrt(max(r2 - u0 * u0, 0.0)) + r2 * asin(min(u0 / rho, 1.0)));
  return y * u0 + s1 - s0;
}
fn signedQuadrant(x: f32, y: f32, rho: f32) -> f32 {
  return sign(x) * sign(y) * quadrantDiscArea(abs(x), abs(y), rho);
}
/** Area of the disc of radius rho (centred on the nucleus) inside [x0, x1] x [y0, y1]. */
fn rectDiscArea(x0: f32, x1: f32, y0: f32, y1: f32, rho: f32) -> f32 {
  return signedQuadrant(x1, y1, rho) - signedQuadrant(x0, y1, rho) - signedQuadrant(x1, y0, rho) + signedQuadrant(x0, y0, rho);
}

/** Light a square cell of side a (rad) at angle theta receives (model.ts cellIlluminance). */
fn cellLight(C: Coma, theta: f32, a: f32) -> vec4f {
  let h = 0.5 * a;
  if (theta < h) { return enclosedAt(C, a / sqrt(PI)); }
  return (enclosedAt(C, theta + h) - enclosedAt(C, theta - h)) * (a * a / (4.0 * PI * theta * h));
}

struct FO { @location(0) ext: vec4f, @location(1) w: vec4f, @builtin(frag_depth) depth: f32 };

@fragment fn fs(in: VO) -> FO {
  let C = comae[in.inst];
  let ndc = ndcFromFrag(F, in.pos.xy);
  let dir = normalize(C.n.xyz + in.xy.x * C.e1.xyz + in.xy.y * C.e2.xyz);
  if (occulted(F, dir)) { discard; }
  let omega = pixelSolidAngle(F, ndc);
  let a = sqrt(omega);
  let r = length(in.xy);
  var e = vec4f(0.0);
  if (r >= ${f(NEAR_PX)} * a) {
    e = cellLight(C, atan(r), a);
  } else {
    // near the nucleus: thin rings, each shared by the area of the pixel square inside it (e1, e2 follow the pixel
    // grid: layer.ts)
    let h = 0.5 * a;
    let x0 = in.xy.x - h;
    let x1 = in.xy.x + h;
    let y0 = in.xy.y - h;
    let y1 = in.xy.y + h;
    let rMin = length(max(abs(in.xy) - vec2f(h), vec2f(0.0)));
    let rMax = length(abs(in.xy) + vec2f(h));
    var rPrev = rMin;
    var cPrev = enclosedAt(C, rMin);
    var aPrev = rectDiscArea(x0, x1, y0, y1, rMin);
    for (var k = 1; k <= ${NEAR_STEPS}; k++) {
      let rk = rMin + (rMax - rMin) * f32(k) / ${f(NEAR_STEPS)};
      let ck = enclosedAt(C, rk);
      let ak = rectDiscArea(x0, x1, y0, y1, rk);
      e += (ck - cPrev) * ((ak - aPrev) / max(PI * (rk * rk - rPrev * rPrev), 1e-30));
      rPrev = rk;
      cPrev = ck;
      aPrev = ak;
    }
  }
  e = max(e, vec4f(0.0));
  if (e.y <= 0.0 && e.w <= 0.0) { discard; }
  var o: FO;
  o.ext = toStore(F, e / omega);
  o.w = vec4f(C.e2.w);
  o.depth = F.proj.z / max(C.n.w * dot(dir, -F.back.xyz), F.proj.z);
  return o;
}
`;

export const PACKET_SHADER = COMMON + /* wgsl */ `
struct Packet {
  p: vec4f,   // camera-relative position (km, ICRF), w = Gaussian sigma (km)
  e: vec4f,   // illuminance at the observer (XYZS, lux)
};
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<storage, read> packets: array<Packet>;

struct VO {
  @builtin(position) pos: vec4f,
  @location(0) xy: vec2f,                       // tangent-plane offset (tan units)
  @location(1) @interpolate(flat) e: vec4f,     // illuminance / (2 pi sigma^2 · truncation), per sr at the peak
  @location(2) @interpolate(flat) s: vec2f,     // x = sigma (rad), y = depth
};

const CUT: f32 = 3.0;

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let P = packets[ii];
  let dist = length(P.p.xyz);
  let n = P.p.xyz / dist;
  var up = F.up.xyz;
  if (abs(dot(up, n)) > 0.9) { up = F.right.xyz; }
  let e1 = normalize(cross(up, n));
  let e2 = cross(n, e1);
  let sig = max(P.p.w / dist, 0.6 * F.tanHalf.z);
  let xy = corners[vi] * (CUT * sig);
  let d = n + xy.x * e1 + xy.y * e2;
  let cc = toCam(F, d);
  var o: VO;
  o.pos = vec4f(cc.x * F.proj.x, cc.y * F.proj.y, 0.0, -cc.z);
  o.xy = xy;
  let trunc = 1.0 - exp(-0.5 * CUT * CUT);
  o.e = P.e / (2.0 * PI * sig * sig * trunc);
  let depth = F.proj.z / max(dist * max(dot(n, -F.back.xyz), 1e-6), F.proj.z);
  o.s = vec2f(sig, depth);
  return o;
}

struct FO { @location(0) ext: vec4f, @location(1) w: vec4f, @builtin(frag_depth) depth: f32 };

@fragment fn fs(in: VO) -> FO {
  let r2 = dot(in.xy, in.xy) / (in.s.x * in.s.x);
  if (r2 > CUT * CUT) { discard; }
  let ndc = ndcFromFrag(F, in.pos.xy);
  if (occulted(F, normalize(worldDirNdc(F, ndc)))) { discard; }
  var o: FO;
  o.ext = toStore(F, in.e * exp(-0.5 * r2));
  o.w = vec4f(1.0);
  o.depth = in.s.y;
  return o;
}
`;
