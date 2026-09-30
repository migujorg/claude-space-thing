// WGSL sources. Eye-model constants are injected from src/eye/constants.ts (single source of truth);
// the per-pixel eye functions mirror src/eye/*.ts (keep in sync).

import { CIE146, CIE191, CRUMEY, HUNT, PATTANAIK, SRGB } from '../eye/constants';
import { SRGB_TO_XYZ, inv3 } from '../eye/display';
import { XYZ_TO_HPE } from '../eye/tonemap';
import { LAW_WGSL, MASK_HATCH_SHADER, RING_COMMON, RING_SHADER as RING_SHADER_OF, SURFACE_WGSL } from './shaders-m2';
import { FORESHORTEN_MIN_MU } from './surface';

// Relief self-shadowing: horizon search toward the Sun in geometrically growing steps from one texel
// (a numerical choice, not a physical constant: 40 steps growing by 15% reach ~230 texels, capped at
// R/4; coarser growth undersamples crater rims and leaves stair-stepped shadow edges).
const FORESHORTEN = FORESHORTEN_MIN_MU;
const MARCH_STEPS = 40;
const MARCH_GROWTH = 1.15;
export { MASK_HATCH_SHADER };

const HPE_INV_M = inv3([...XYZ_TO_HPE]);
/** Column-major WGSL constructor arguments for the inverse HPE matrix. */
const HPE_INV_COLS = [0, 1, 2].map((c) => `vec3f(${[0, 1, 2].map((r) => HPE_INV_M[r * 3 + c].toPrecision(9)).join(', ')})`).join(', ');

const f = (x: number) => {
  const s = x.toPrecision(9);
  return /[.eE]/.test(s) ? s : s + '.0';
};

/** Uniform structs and helpers shared by all passes. */
export const COMMON = /* wgsl */ `
diagnostic(off, derivative_uniformity);
const PI: f32 = 3.14159265358979;

struct Frame {
  right: vec4f,    // camera right in ICRF
  up: vec4f,       // camera up
  back: vec4f,     // camera back (view direction is -back)
  proj: vec4f,     // x = 1/tanX, y = 1/tanY, z = near (km), w = pre-exposure
  size: vec4f,     // W, H, 1/W, 1/H
  tanHalf: vec4f,  // tanX, tanY, pixel angle at centre (rad), frame index
  store: vec4f,    // x = largest value the HDR format can store (fp16 fallback), yzw unused
};

/** Pre-expose a luminance for storage in the HDR targets (clamped so fp16 never overflows to inf). */
fn toStore(F: Frame, v: vec4f) -> vec4f {
  return min(v * F.proj.w, vec4f(F.store.x));
}

struct Eye {
  scene: vec4f,    // sigmaCone, sigmaRod, Bcone, adaptation part of Hunt's rod saturation B_S
  map: vec4f,      // gain, offset, n, exposure
  disp: vec4f,     // sigmaD, BD, displayWhiteResponse, peak cd/m2
  mes: vec4f,      // m (CIE 191), V'(lambda0), rho2850, field factor F
  cr0: vec4f,      // Crumey a1..a4
  cr1: vec4f,      // a5, zero-background B, adaptation (Blackwell units), Ricco area (sr)
  glare: vec4f,    // unscattered fraction, age, pigmentation, point Ricco weight
  cat0: vec4f,
  cat1: vec4f,
  cat2: vec4f,     // chromatic adaptation matrix rows
  misc: vec4f,     // dither amplitude, cos(adaptation field radius), star sigma px, analytic source count
  misc2: vec4f,    // star quad half-extent px, 1/(1-exp(-extent^2/2 sigma^2)), unused, unused
  dark: vec4f,     // dark-light pedestal: L0 cone, L0 rod, R(L0) cone, R(L0) rod
  pts: vec4f,      // points (eye/points.ts): display response at the bleaching luminance, viewer's Ricco area (sr), cone summation area (sr), own veil in the background per lux per pixel solid angle
  fix: vec4f,      // fixations: unit direction to the Sun, w = cos(angular radius + 1 px) of its disk (2: no Sun)
  flags: vec4f,    // display black response, cone bleaching (1/0), fixation mode (1 brightness, 0 centre), unused
};

fn toCam(F: Frame, w: vec3f) -> vec3f {
  return vec3f(dot(F.right.xyz, w), dot(F.up.xyz, w), dot(F.back.xyz, w));
}
fn camToWorld(F: Frame, c: vec3f) -> vec3f {
  return F.right.xyz * c.x + F.up.xyz * c.y + F.back.xyz * c.z;
}
/** Unnormalised world direction through an NDC position (y up). */
fn worldDirNdc(F: Frame, ndc: vec2f) -> vec3f {
  return camToWorld(F, vec3f(ndc.x * F.tanHalf.x, ndc.y * F.tanHalf.y, -1.0));
}
fn ndcFromFrag(F: Frame, p: vec2f) -> vec2f {
  return vec2f(p.x * F.size.z * 2.0 - 1.0, 1.0 - p.y * F.size.w * 2.0);
}
/** Solid angle (sr) of the pixel at an NDC position for the rectilinear projection. */
fn pixelSolidAngle(F: Frame, ndc: vec2f) -> f32 {
  let tx = ndc.x * F.tanHalf.x;
  let ty = ndc.y * F.tanHalf.y;
  let r2 = 1.0 + tx * tx + ty * ty;
  return (2.0 * F.tanHalf.x * F.size.z) * (2.0 * F.tanHalf.y * F.size.w) / (r2 * sqrt(r2));
}

// CIE 146:2002 general disability glare function, sr^-1, theta in degrees (0.1..100).
fn cie146(tDeg: f32, age: f32, p: f32) -> f32 {
  if (tDeg < ${f(CIE146.minDeg)} || tDeg > ${f(CIE146.maxDeg)}) { return 0.0; }
  let a = age / ${f(CIE146.ageScale)};
  let ageTerm = 1.0 + a * a * a * a;
  return ${f(CIE146.c3)} / (tDeg * tDeg * tDeg) + (${f(CIE146.c2)} / (tDeg * tDeg) + ${f(CIE146.c1)} * p / tDeg) * ageTerm + ${f(CIE146.c0)} * p;
}
/** Angle between two unit vectors, accurate for small angles. */
fn angleBetween(a: vec3f, b: vec3f) -> f32 {
  return 2.0 * asin(clamp(0.5 * length(a - b), 0.0, 1.0));
}
// CIE 191 + Crumey (2014) §1.3: (photopic, scotopic) -> Blackwell-equivalent photopic units.
fn blackwellEq(E: Eye, qp: f32, qs: f32) -> f32 {
  let m = E.mes.x;
  let v = E.mes.y;
  return (m * qp + (1.0 - m) * v * qs) / (m + (1.0 - m) * v * E.mes.z);
}
// Crumey (2014) Eq. 34 point-source threshold (lux), with the zero-background cut-off.
fn crumeyPointThreshold(E: Eye, Bin: f32) -> f32 {
  let B = max(Bin, E.cr1.y);
  let q = sqrt(sqrt(B));
  let h = sqrt(B);
  let inner = E.cr0.x * h + E.cr0.y * h * q + E.cr0.z * B;
  let v = sqrt(max(inner, 0.0)) + E.cr0.w * q + E.cr1.x * h;
  return v * v;
}
// Crumey (2014) Eq. 39/40 large-target threshold contrast and the Ricco area A_R = ΔI/(C∞·B) (crumey.ts).
fn crumeyRiccoArea(E: Eye, Bin: f32) -> f32 {
  let B = max(Bin, E.cr1.y);
  let iq = 1.0 / sqrt(sqrt(B));
  let inner = ${f(CRUMEY.b1)} * iq * iq + ${f(CRUMEY.b2)} * iq + ${f(CRUMEY.b3)};
  let cInf = sqrt(max(inner, 0.0)) + ${f(CRUMEY.b4)} * iq + ${f(CRUMEY.b5)};
  return crumeyPointThreshold(E, B) / (cInf * B);
}
// CIE 191:2010 adaptation coefficient m by the standard's iteration (mesopic.ts), for a local state.
fn mesopicM(Lp: f32, Ls: f32) -> f32 {
  let v = ${f(CIE191.vPrimeLambda0)};
  var m = ${f(CIE191.m0)};
  for (var i = 0; i < 24; i++) {
    let Lmes = (m * Lp + (1.0 - m) * Ls * v) / (m + (1.0 - m) * v);
    m = select(0.0, clamp(${f(CIE191.a)} + ${f(CIE191.b)} * log2(Lmes) * ${f(Math.LOG10E / Math.LOG2E)}, 0.0, 1.0), Lmes > 0.0);
  }
  return m;
}
// (photopic, scotopic) → Blackwell units at mesopic state m (mesopic.ts blackwellEquivalent).
fn blackwellEqM(E: Eye, m: f32, qp: f32, qs: f32) -> f32 {
  let v = E.mes.y;
  return (m * qp + (1.0 - m) * v * qs) / (m + (1.0 - m) * v * E.mes.z);
}
`;

/** Storage binding for analytic glare sources, declared by modules that call analyticVeil(). */
const SRCS = (group: number, binding: number) => `@group(${group}) @binding(${binding}) var<storage, read> srcs: array<vec4f>;`;

/** Analytic glare veil; requires the `srcs` binding (use with SRCS). */
const VEIL = /* wgsl */ `
/** Veil (cd/m2, XYZS) at a unit world direction from the analytic glare sources (Sun, off-frame bodies). */
fn analyticVeil(E: Eye, dir: vec3f) -> vec4f {
  var v = vec4f(0.0);
  let n = u32(E.misc.w);
  for (var i = 0u; i < n; i++) {
    let s = srcs[2u * i];
    let e = srcs[2u * i + 1u];
    let t = degrees(angleBetween(dir, s.xyz));
    // Sources are pre-selected to lie within the CIE validity range of the fixation direction;
    // clamping θ keeps the veil continuous across the frame (docs/eye-model.md §3).
    v += e * cie146(clamp(max(t, s.w), ${f(CIE146.minDeg)}, ${f(CIE146.maxDeg)}), E.glare.y, E.glare.z);
  }
  return v;
}

`;

/** Scene → display tone reproduction (eye/tonemap.ts), shared by the composite and the point shaders; needs \`E\`. */
const TONE = /* wgsl */ `
fn naka(L: f32, sigma: f32, B: f32) -> f32 {
  if (L <= 0.0) { return 0.0; }
  return B / (1.0 + pow(sigma / L, E.map.z));
}
// Hunt rod response (tonemap.ts rodResponseRaw): B_S(S)·Sⁿ/(Sⁿ + σ_rodⁿ), B_S = stimulus + adaptation parts.
fn rodRaw(S: f32) -> f32 {
  let bs = 0.5 / (1.0 + ${f(HUNT.bsA)} * pow(max(S, 0.0) / ${f(HUNT.scotopicScale)}, ${f(HUNT.bsExp)})) + E.scene.w;
  return naka(S, E.scene.y, bs);
}
/** R_lum = R_cone + R_rod over the dark-light pedestal (tonemap.ts lumResponse); perceived Y, S. */
fn sceneResponse(Y: f32, S: f32) -> f32 {
  let rc = naka(max(Y, 0.0) + E.dark.x, E.scene.x, E.scene.z) - E.dark.z;
  let rr = rodRaw(max(S, 0.0) + E.dark.y) - E.dark.w;
  return rc + rr;
}
/** Pattanaik's appearance map and inverse display model (tonemap.ts inverseDisplay): display cd/m². */
fn displayLd(R: f32) -> f32 {
  let Rd = E.map.x * R + E.map.y;
  if (Rd <= 0.0) { return 0.0; }
  if (Rd >= E.disp.z) { return E.disp.w; }
  return E.disp.x * pow(Rd / (E.disp.y - Rd), 1.0 / E.map.z);
}
/** Intended display luminance (points.ts intendedDisplayLd): not clamped at the peak, bounded by bleaching. */
fn intendedLd(R: f32) -> f32 {
  let Rd = E.map.x * R + E.map.y;
  if (Rd <= 0.0) { return 0.0; }
  if (Rd >= E.pts.x) { return ${f(PATTANAIK.coneBleachHalf)}; }
  return E.disp.x * pow(Rd / (E.disp.y - Rd), 1.0 / E.map.z);
}
/** Pattanaik Eq. 3 colour exponent (tonemap.ts colourExponent): cone signal Lc (perceived Y), display Ld. */
fn colourK(Lc: f32, Ld: f32) -> f32 {
  let rcr = naka(max(Lc, 0.0) + E.dark.x, E.scene.x, E.scene.z);
  let sScene = E.map.z * rcr * (1.0 - rcr / E.scene.z);
  let rdr = naka(Ld, E.disp.x, E.disp.y);
  let sDisp = E.map.z * rdr * (1.0 - rdr / E.disp.y);
  return select(1.0, min(1.0, sScene / sDisp), sDisp > 0.0);
}
// ── The scene observer adapted to a local luminance (model.ts localObserver; tonemap.ts): used for point
// sources, which are judged by the eye looking at them, adapted to their own background.
struct Obs { sc: f32, sr: f32, bc: f32, br: f32, gain: f32, off: f32, d0c: f32, d0r: f32 };
fn sigmaConeAt(A: f32) -> f32 {
  let k = 1.0 / (${f(PATTANAIK.coneKScale)} * A + 1.0);
  let k4 = k * k * k * k;
  return ${f(PATTANAIK.coneSigmaNum)} * A / (k4 * A + ${f(PATTANAIK.coneSigmaPow)} * (1.0 - k4) * (1.0 - k4) * pow(A, 1.0 / 3.0));
}
fn sigmaRodAt(A: f32) -> f32 {
  let x = 5.0 * A / ${f(HUNT.scotopicScale)};
  let j = ${f(HUNT.flsJ)} / (x + ${f(HUNT.flsJ)});
  let fls = ${f(HUNT.flsJ2)} * j * j * x + ${f(HUNT.flsPow)} * pow(1.0 - j * j, ${f(HUNT.flsExpJ)}) * pow(x, 1.0 / 6.0);
  return ${f(PATTANAIK.refWhiteFactor)} * A * pow(${f(HUNT.fnHalf)}, 1.0 / E.map.z) / fls;
}
fn rodRawO(o: Obs, S: f32) -> f32 {
  let bs = 0.5 / (1.0 + ${f(HUNT.bsA)} * pow(max(S, 0.0) / ${f(HUNT.scotopicScale)}, ${f(HUNT.bsExp)})) + o.br;
  return naka(S, o.sr, bs);
}
fn respO(o: Obs, Y: f32, S: f32) -> f32 {
  return naka(max(Y, 0.0) + E.dark.x, o.sc, o.bc) - o.d0c + rodRawO(o, max(S, 0.0) + E.dark.y) - o.d0r;
}
/** Observer adapted to (Ac, Ar) with Pattanaik's reference white/black (5·A, 5·A/32) and appearance rules. */
fn obsAt(AcIn: f32, ArIn: f32) -> Obs {
  let Ac = max(AcIn, E.cr1.y);
  let Ar = max(ArIn, E.cr1.y * E.mes.z);
  var o: Obs;
  o.sc = sigmaConeAt(Ac);
  o.sr = sigmaRodAt(Ar);
  o.bc = select(1.0, ${f(PATTANAIK.coneBleachHalf)} / (${f(PATTANAIK.coneBleachHalf)} + Ac), E.flags.y > 0.5);
  o.br = 0.5 / (1.0 + ${f(HUNT.bsB)} * (5.0 * Ar / ${f(HUNT.scotopicScale)}));
  o.d0c = naka(E.dark.x, o.sc, o.bc);
  o.d0r = rodRawO(o, E.dark.y);
  let w = respO(o, ${f(PATTANAIK.refWhiteFactor)} * Ac, ${f(PATTANAIK.refWhiteFactor)} * Ar);
  let b = respO(o, ${f(PATTANAIK.refWhiteFactor / PATTANAIK.refBlackDivisor)} * Ac, ${f(PATTANAIK.refWhiteFactor / PATTANAIK.refBlackDivisor)} * Ar);
  let dW = E.disp.z;
  let dB = E.flags.x;
  o.gain = 1.0;
  o.off = 0.0;
  if (w <= dW && b >= dB) {
  } else if (w - b > dW - dB) {
    o.gain = (dW - dB) / (w - b);
    o.off = dB - b * o.gain;
  } else if (w + b > dW + dB) {
    o.off = min(0.0, dW - w);
  } else {
    o.off = max(0.0, dB - b);
  }
  return o;
}
fn intendedLdO(o: Obs, R: f32) -> f32 {
  let Rd = o.gain * R + o.off;
  if (Rd <= 0.0) { return 0.0; }
  if (Rd >= E.pts.x) { return ${f(PATTANAIK.coneBleachHalf)}; }
  return E.disp.x * pow(Rd / (E.disp.y - Rd), 1.0 / E.map.z);
}
fn colourKO(o: Obs, Lc: f32, Ld: f32) -> f32 {
  let rcr = naka(max(Lc, 0.0) + E.dark.x, o.sc, o.bc);
  let sScene = E.map.z * rcr * (1.0 - rcr / o.bc);
  let rdr = naka(Ld, E.disp.x, E.disp.y);
  let sDisp = E.map.z * rdr * (1.0 - rdr / E.disp.y);
  return select(1.0, min(1.0, sScene / sDisp), sDisp > 0.0);
}
const WHITE_XYZ = vec3f(${f(SRGB.whiteX / SRGB.whiteY)}, 1.0, ${f((1 - SRGB.whiteX - SRGB.whiteY) / SRGB.whiteY)});
const HPE = mat3x3f(vec3f(${f(XYZ_TO_HPE[0])}, ${f(XYZ_TO_HPE[3])}, ${f(XYZ_TO_HPE[6])}), vec3f(${f(XYZ_TO_HPE[1])}, ${f(XYZ_TO_HPE[4])}, ${f(XYZ_TO_HPE[7])}), vec3f(${f(XYZ_TO_HPE[2])}, ${f(XYZ_TO_HPE[5])}, ${f(XYZ_TO_HPE[8])}));
const HPE_INV = mat3x3f(${HPE_INV_COLS});
/** Display chromaticity (XYZ, Y = 1) of a scene XYZ: CAT to the display white, then colour exponent k. */
fn displayChroma(xyz: vec3f, k: f32) -> vec3f {
  let cat = mat3x3f(vec3f(E.cat0.x, E.cat1.x, E.cat2.x), vec3f(E.cat0.y, E.cat1.y, E.cat2.y), vec3f(E.cat0.z, E.cat1.z, E.cat2.z));
  var chroma = WHITE_XYZ;
  let a = cat * xyz;
  if (a.y > 0.0) { chroma = a / a.y; }
  let lmsW = HPE * WHITE_XYZ;
  let lms = pow(max((HPE * chroma) / lmsW, vec3f(1e-9)), vec3f(k)) * lmsW;
  let c2 = HPE_INV * lms;
  return c2 / max(c2.y, 1e-12);
}
`;

/** Bilinear sample of a (coarser) screen-aligned texture at an NDC position. */
const BG = /* wgsl */ `
fn bgAt(t: texture_2d<f32>, ndc: vec2f) -> vec4f {
  let d = vec2i(textureDimensions(t));
  let c = (ndc * vec2f(0.5, -0.5) + 0.5) * vec2f(d) - 0.5;
  let i0 = vec2i(floor(c));
  let fr = c - vec2f(i0);
  let l = vec2i(0);
  let h = d - 1;
  let a = mix(textureLoad(t, clamp(i0, l, h), 0), textureLoad(t, clamp(i0 + vec2i(1, 0), l, h), 0), fr.x);
  let b = mix(textureLoad(t, clamp(i0 + vec2i(0, 1), l, h), 0), textureLoad(t, clamp(i0 + vec2i(1, 1), l, h), 0), fr.x);
  return mix(a, b, fr.y);
}
`;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Resolved bodies: analytic ellipsoid ray casting on a screen-space quad (see raycast.ts).
// ─────────────────────────────────────────────────────────────────────────────────────────────
const BODY_COMMON = /* wgsl */ `
struct Body {
  n: vec4f,     // direction to centre (world, unit), w = D (km)
  e1: vec4f,    // tangent basis e1, w = quad half-extent (tan units)
  e2: vec4f,    // tangent basis e2, w = 1 for the NEAR path
  ns: vec4f,    // M n
  E1: vec4f,    // D M e1
  E2: vec4f,    // D M e2
  m0: vec4f, m1: vec4f, m2: vec4f,     // rows of M (world -> unit-sphere frame)
  mi0: vec4f, mi1: vec4f, mi2: vec4f,  // rows of M^-1
  o: vec4f,     // NEAR: camera in unit-sphere frame, w = |o|^2 - 1
  sun: vec4f,   // unit direction to the Sun from the body centre, w = distance (km)
  rad: vec4f,   // radiance prefactor (cd/m2 per unit radiance factor of the law), XYZS
  misc: vec4f,  // x = Ricco weight, y = Sun radius (km), z = occluder count, w = 1 lit / 0 dark
  occ: array<vec4f, 4>,  // occluders: centre relative to this body (km), w = radius
  rot0: vec4f, rot1: vec4f, rot2: vec4f,  // body-fixed → world rows; w = radii a, b, c (km)
  surfA: vec4f, // albedo map: page-table base (u32 bits), max level, enabled, mean radius (km)
  surfH: vec4f, // height map: page-table base (u32 bits), max level, enabled, unused
  law0: vec4f,  // spatial law: kind, p (L, k or w), b, c
  law1: vec4f,  // B_S0, h_S, B_C0, h_C
  law2: vec4f,  // θ̄ (rad), K, H function (0: Hapke 2002, 1: 1981), unused
  ps0: vec4f, psK0: vec4f, ps1: vec4f, psK1: vec4f,  // planetshine: unit direction (w = 1 if present), radiance prefactor
  ring: vec4f,  // ring system index (−1: none), body centre − ring centre (km)
};

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<storage, read> bodies: array<Body>;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) xy: vec2f,
  @location(1) @interpolate(flat) id: u32,
};

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let b = bodies[ii];
  let c = corners[vi];
  var o: VOut;
  o.id = ii;
  if (b.e2.w > 0.5) {
    o.pos = vec4f(c, 0.0, 1.0);
    o.xy = c;
  } else {
    let xy = c * b.e1.w;
    let d = b.n.xyz + xy.x * b.e1.xyz + xy.y * b.e2.xyz;
    let cc = toCam(F, d);
    o.pos = vec4f(cc.x * F.proj.x, cc.y * F.proj.y, 0.0, -cc.z);
    o.xy = xy;
  }
  return o;
}

struct Hit { t: f32, h: vec3f, disc: f32, dir: vec3f };

fn castBody(b: Body, xy: vec2f) -> Hit {
  var r: Hit;
  if (b.e2.w > 0.5) {
    let dirW = normalize(worldDirNdc(F, xy));
    let d = vec3f(dot(b.m0.xyz, dirW), dot(b.m1.xyz, dirW), dot(b.m2.xyz, dirW));
    let A = dot(d, d);
    let B = dot(b.o.xyz, d);
    r.disc = B * B - A * b.o.w;
    let sq = sqrt(max(r.disc, 0.0));
    r.t = select((-B - sq) / A, b.o.w / (-B + sq), B < 0.0);
    r.h = b.o.xyz + d * r.t;
    r.dir = dirW;
  } else {
    let q = xy.x * b.E1.xyz + xy.y * b.E2.xyz;
    let d = b.ns.xyz + q / b.n.w;
    let A = dot(d, d);
    let B = dot(q, d);
    let C = dot(q, q) - 1.0;
    r.disc = B * B - A * C;
    let s = (-B - sqrt(max(r.disc, 0.0))) / A;
    r.t = b.n.w + s;
    r.h = q + d * s;
    r.dir = b.n.xyz + xy.x * b.e1.xyz + xy.y * b.e2.xyz;
  }
  return r;
}

fn depthOf(t: f32, dir: vec3f) -> f32 {
  let zv = t * dot(dir, -F.back.xyz);
  return F.proj.z / max(zv, F.proj.z);
}
`;

export const BODY_SHADER = COMMON + BODY_COMMON + RING_COMMON + LAW_WGSL + SURFACE_WGSL + /* wgsl */ `
@group(0) @binding(2) var<storage, read> pageTable: array<u32>;
@group(0) @binding(3) var albedoPages: texture_2d_array<f32>;
@group(0) @binding(4) var heightPages: texture_2d_array<f32>;
@group(0) @binding(5) var<uniform> SI: SurfInfo;
@group(0) @binding(6) var<storage, read> rings: array<Ring>;
@group(0) @binding(7) var<storage, read> ringProf: array<vec4f>;

/** Fraction of the solar disk (uniform-disk approximation) visible from body-relative point p. */
fn sunVisible(b: Body, p: vec3f) -> f32 {
  let n = u32(b.misc.z);
  if (n == 0u) { return 1.0; }
  let S = b.sun.xyz * b.sun.w - p;
  let dS = length(S);
  let sHat = S / dS;
  let rs = asin(min(b.misc.y / dS, 1.0));
  var covered = 0.0;
  for (var i = 0u; i < n; i++) {
    let O = b.occ[i].xyz - p;
    let dO = length(O);
    if (dot(O, S) <= 0.0 || dO >= dS) { continue; }
    let ro = asin(min(b.occ[i].w / dO, 1.0));
    let sep = angleBetween(O / dO, sHat);
    covered += circleOverlap(rs, ro, sep);
  }
  return clamp(1.0 - covered / (PI * rs * rs), 0.0, 1.0);
}

/** Sunlight transmitted through a ring system to body-relative point p (ring shadow, soft by the solar disk). */
fn ringShadowT(b: Body, p: vec3f) -> f32 {
  if (b.ring.x < -0.5) { return 1.0; }
  let R = rings[u32(b.ring.x)];
  let N = R.N.xyz;
  let X = p + b.ring.yzw;
  let s = b.sun.xyz;
  let sN = dot(s, N);
  if (abs(sN) < 1e-6) { return 1.0; }
  let u = -dot(X, N) / sN;
  if (u <= 0.0) { return 1.0; }
  let r = length(X + u * s);
  let delta = u * asin(min(b.misc.y / b.sun.w, 1.0)) / abs(sN);
  let a = ringAvg(R, r - delta, r + delta);
  return exp(-a.tau / abs(sN));
}

/** Light from point p toward the camera transmitted through a ring system in front of it. */
fn ringViewT(b: Body, p: vec3f, dirN: vec3f, range: f32) -> f32 {
  if (b.ring.x < -0.5) { return 1.0; }
  let R = rings[u32(b.ring.x)];
  let N = R.N.xyz;
  let X = p + b.ring.yzw;
  let dN = dot(dirN, N);
  if (abs(dN) < 1e-6) { return 1.0; }
  let u = dot(X, N) / dN;
  if (u <= 0.0 || u >= range) { return 1.0; }
  let r = length(X - u * dirN);
  let fw = F.tanHalf.z * (range - u) / abs(dN);
  let a = ringAvg(R, r - 0.5 * fw, r + 0.5 * fw);
  return exp(-a.tau / abs(dN));
}

struct FOut {
  @location(0) ext: vec4f,
  @location(1) w: f32,
  @location(2) mask: f32,
  @builtin(frag_depth) depth: f32,
};

@fragment fn fs(in: VOut) -> FOut {
  let b = bodies[in.id];
  let hit = castBody(b, in.xy);
  let cov = clamp(0.5 + hit.disc / max(fwidth(hit.disc), 1e-30), 0.0, 1.0);
  if (cov <= 0.0) { discard; }
  var L = vec4f(0.0);
  var gap = 0.0;
  if (b.misc.w > 0.5) {
    let dirN = normalize(hit.dir);
    let range = hit.t * length(hit.dir);
    let V = -dirN;
    let Nell = normalize(b.m0.xyz * hit.h.x + b.m1.xyz * hit.h.y + b.m2.xyz * hit.h.z);
    let p = vec3f(dot(b.mi0.xyz, hit.h), dot(b.mi1.xyz, hit.h), dot(b.mi2.xyz, hit.h));
    var N = Nell;
    var M = vec4f(1.0);
    var selfShadow = 1.0;
    if (b.surfA.z > 0.5 || b.surfH.z > 0.5) {
      // Body-fixed point (km), planetocentric (u, v), and the pixel's surface footprint (surface.ts).
      let radii = vec3f(b.rot0.w, b.rot1.w, b.rot2.w);
      let pbf = hit.h * radii;
      let uv = uvOfBf(pbf);
      let fp = F.tanHalf.z * range / sqrt(max(dot(Nell, V), ${FORESHORTEN}));
      if (b.surfA.z > 0.5) {
        let base = bitcast<u32>(b.surfA.x);
        let Lr = residentLevel(base, surfLevel(b.surfA.w, fp, b.surfA.y), uv);
        let s = sampleAlbedo(base, Lr, uv);
        M = s.m;
        gap = s.gap;
      }
      if (b.surfH.z > 0.5) {
        let base = bitcast<u32>(b.surfH.x);
        let Lh = residentLevel(base, surfLevel(b.surfA.w, fp, b.surfH.y), uv);
        let W = f32(512u << Lh);
        let H = f32(256u << Lh);
        let r = length(pbf);
        let upb = normalize(pbf / (radii * radii));
        let lat = atan2(pbf.z, length(pbf.xy));
        let lon = atan2(pbf.y, pbf.x);
        let east = vec3f(-sin(lon), cos(lon), 0.0);
        let north = vec3f(-sin(lat) * cos(lon), -sin(lat) * sin(lon), cos(lat));
        let h0 = sampleHeight(base, Lh, uv);
        let hE = sampleHeight(base, Lh, uv + vec2f(1.0 / W, 0.0));
        let hW = sampleHeight(base, Lh, uv - vec2f(1.0 / W, 0.0));
        let hN = sampleHeight(base, Lh, uv - vec2f(0.0, 1.0 / H));
        let hS = sampleHeight(base, Lh, uv + vec2f(0.0, 1.0 / H));
        if (h0.y > 0.99 && hE.y > 0.99 && hW.y > 0.99 && hN.y > 0.99 && hS.y > 0.99) {
          // Slopes (km/km) from central differences; heights are meters.
          let sE = (hE.x - hW.x) * 1e-3 / (2.0 / W * 2.0 * PI * r * max(cos(lat), 1e-3));
          let sN = (hN.x - hS.x) * 1e-3 / (2.0 / H * PI * r);
          let nb = normalize(upb - sE * east - sN * north);
          N = normalize(b.rot0.xyz * nb.x + b.rot1.xyz * nb.y + b.rot2.xyz * nb.z);
          // Self-shadowing: horizon toward the Sun by ray marching the height field (curvature included),
          // compared with the solar disk (soft terminator of relief).
          let sbf = b.rot0.xyz * b.sun.x + b.rot1.xyz * b.sun.y + b.rot2.xyz * b.sun.z;
          let es = asin(clamp(dot(sbf, upb), -1.0, 1.0));
          let hor = sbf - dot(sbf, upb) * upb;
          let hl = length(hor);
          let rs = asin(min(b.misc.y / b.sun.w, 1.0));
          if (hl > 1e-6 && es < 0.5 * PI - rs) {
            let hd = hor / hl;
            let texKm = 2.0 * PI * r / W;
            var maxAng = -0.5 * PI;
            var d = texKm;
            for (var k = 0; k < ${MARCH_STEPS}; k++) {
              if (d > 0.25 * r) { break; }
              let q = pbf + hd * d;
              let hq = sampleHeight(base, Lh, uvOfBf(q));
              if (hq.y > 0.5) {
                let rise = (hq.x - h0.x) * 1e-3 - d * d / (2.0 * r);
                maxAng = max(maxAng, atan2(rise, d));
              }
              d *= ${MARCH_GROWTH};
            }
            let x = clamp((es - maxAng) / max(rs, 1e-6), -1.0, 1.0);
            selfShadow = 0.5 + (x * sqrt(1.0 - x * x) + asin(x)) / PI;
          }
        }
      }
    }
    let S = b.sun.xyz;
    let mu0 = dot(N, S);
    let mu = dot(N, V);
    if (mu0 > 0.0 && mu > 0.0) {
      let r = lawRadf(mu0, mu, acos(clamp(dot(S, V), -1.0, 1.0)), b.law0, b.law1, b.law2);
      L = b.rad * M * (r * sunVisible(b, p) * selfShadow * ringShadowT(b, p));
    }
    // Planetshine (Lambert, measured albedos of both bodies; planetshine.ts).
    if (b.ps0.w > 0.5) { L += b.psK0 * M * max(dot(N, b.ps0.xyz), 0.0); }
    if (b.ps1.w > 0.5) { L += b.psK1 * M * max(dot(N, b.ps1.xyz), 0.0); }
    L *= ringViewT(b, p, dirN, range);
  }
  var o: FOut;
  o.ext = toStore(F, L * cov);
  o.w = b.misc.x;
  o.mask = select(0.0, cov, gap > 0.5);
  o.depth = depthOf(hit.t, hit.dir);
  return o;
}
`;

/** Display-space overlay for resolved bodies: "not measured" hatch and provenance tint. */
export const BODY_OVERLAY_SHADER = COMMON + BODY_COMMON + /* wgsl */ `
@group(0) @binding(2) var<storage, read> ov: array<vec4f>;   // per body: colour (rgba), flags (x hatch, y tint)
@group(0) @binding(3) var depthTex: texture_depth_2d;

@fragment fn fsOverlay(in: VOut) -> @location(0) vec4f {
  let b = bodies[in.id];
  let hit = castBody(b, in.xy);
  let cov = clamp(0.5 + hit.disc / max(fwidth(hit.disc), 1e-30), 0.0, 1.0);
  if (cov <= 0.0) { discard; }
  let stored = textureLoad(depthTex, vec2i(in.pos.xy), 0);
  if (stored > depthOf(hit.t, hit.dir) * 1.0001) { discard; }   // behind another body
  let col = ov[2u * in.id];
  let flags = ov[2u * in.id + 1u];
  var out = vec4f(0.0);
  if (flags.y > 0.5) { out = vec4f(col.rgb, col.a * cov); }
  // The hatch marks only the SUNLIT part: an unlit hemisphere receives no direct sunlight whatever its
  // reflectance or phase curve (geometry), so it stays black and still occludes what is behind it.
  let N = normalize(b.m0.xyz * hit.h.x + b.m1.xyz * hit.h.y + b.m2.xyz * hit.h.z);
  let sunlit = dot(N, b.sun.xyz) > 0.0;
  if (flags.x > 0.5 && sunlit) {
    // Diagonal stripes in screen space: clearly non-physical "not measured" material.
    let s = fract((in.pos.x + in.pos.y) / 10.0);
    let stripe = select(0.18, 0.55, s < 0.5);
    let edge = clamp(1.0 - abs(hit.disc) / max(fwidth(hit.disc), 1e-30) * 0.5, 0.0, 1.0);
    let g = max(stripe, edge * 0.8);
    out = vec4f(vec3f(g), 0.85 * cov);
  }
  if (out.a <= 0.0) { discard; }
  return vec4f(out.rgb * out.a, out.a);
}
`;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Stars: GPU visibility culling (Crumey threshold) → compact list + indirect draw arguments.
// ─────────────────────────────────────────────────────────────────────────────────────────────
export const CULL_SHADER = COMMON + /* wgsl */ `
struct CullInfo { count: u32, stride: u32, maxVisible: u32, groupsX: u32 };
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> E: Eye;
@group(0) @binding(2) var<storage, read> stars: array<f32>;
@group(0) @binding(3) var<storage, read_write> visible: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> args: array<atomic<u32>, 4>;
@group(0) @binding(5) var bgTex: texture_2d<f32>;
@group(0) @binding(6) var<uniform> info: CullInfo;
${SRCS(0, 7)}
${VEIL}
${BG}

@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x + gid.y * info.groupsX * 256u;
  if (i >= info.count) { return; }
  let base = i * info.stride;
  let u = vec3f(stars[base], stars[base + 1u], stars[base + 2u]);
  let e = vec4f(stars[base + 3u], stars[base + 4u], stars[base + 5u], stars[base + 6u]);
  let c = toCam(F, u);
  if (c.z >= 0.0) { return; }
  let ndc = vec2f(c.x * F.proj.x, c.y * F.proj.y) / (-c.z);
  let marg = E.misc2.x * 2.0 * F.size.zw;
  if (abs(ndc.x) > 1.0 + marg.x || abs(ndc.y) > 1.0 + marg.y) { return; }
  // Local background: last frame's scattered light at scales ≥ the Ricco area (so a star's own core glare
  // does not mask it), plus the analytic veil (Sun, off-frame bodies).
  let own = e * (E.pts.w / pixelSolidAngle(F, ndc));
  let bg = max(bgAt(bgTex, ndc) / F.proj.w - own, vec4f(0.0)) + analyticVeil(E, normalize(u));
  // Judged by the eye looking at the star, adapted to that background (Crumey's condition), not to the
  // frame's global state (eye-model.md §2 "Fixations").
  let aC = max(bg.y, E.cr1.y);
  let aR = max(bg.w, E.cr1.y * E.mes.z);
  let mL = mesopicM(aC, aR);
  let thr = E.mes.w * crumeyPointThreshold(E, blackwellEqM(E, mL, aC, aR)) / E.map.w;
  if (blackwellEqM(E, mL, e.y, e.w) < thr) { return; }
  let k = atomicAdd(&args[1], 1u);
  if (k >= info.maxVisible) { return; }
  visible[2u * k] = vec4f(ndc, 0.0, 0.0);
  visible[2u * k + 1u] = e;
}
`;

export const CLAMP_ARGS_SHADER = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> args: array<u32, 4>;
@group(0) @binding(1) var<uniform> maxVisible: vec4u;
@compute @workgroup_size(1) fn main() { args[1] = min(args[1], maxVisible.x); }
`;

// Point sources (stars, unresolved bodies, unresolved Sun), eye/points.ts. Two passes share the vertex stage:
//  fsPhys (before the glare pyramids): the physical retinal image, an energy-conserving Gaussian splat of
//    the eye's optical core (σ ≥ reconstruction minimum) with luminance E·g/Ω into PT, and the overflow
//    (display flux the splat cannot hold, display units) into PTEX, the only point light whose glare is
//    painted (as the viewer's glare, in display space);
//  fsDisp (before the composite): what the display shows, a sharp splat of display flux ΔL_d·A_R,disp
//    (Ricco summation sets brightness, never size) in display-linear XYZ with the star's own colour.
export const POINT_SHADER = COMMON + TONE + BG + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> E: Eye;
@group(0) @binding(2) var<storage, read> pts: array<vec4f>;   // (ndc.x, ndc.y, depth, _), (E XYZS)
@group(0) @binding(3) var bgTex: texture_2d<f32>;              // coarse physical veil (≥ Ricco scale)
@group(0) @binding(4) var extTex: texture_2d<f32>;             // resolved bodies
${SRCS(0, 5)}
${VEIL}

struct PV {
  @builtin(position) pos: vec4f,
  @location(0) off: vec2f,
  @location(1) @interpolate(flat) e: vec4f,
  @location(2) @interpolate(flat) disp: vec4f,   // drawn display flux × chroma (XYZ)
  @location(3) @interpolate(flat) over: vec4f,   // overflowing display flux × chroma (XYZ)
};

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> PV {
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let p = pts[2u * ii];
  let e = pts[2u * ii + 1u];
  let ext = E.misc2.x;
  let offPx = corners[vi] * ext;
  var o: PV;
  o.pos = vec4f(p.xy + offPx * 2.0 * F.size.zw, p.z, 1.0);
  o.off = offPx * vec2f(1.0, -1.0);
  o.e = e;
  // Appearance (points.ts pointAppearance). Background: coarse veil + analytic veil + bodies.
  let px = clamp(vec2i((p.xy * vec2f(0.5, -0.5) + 0.5) * F.size.xy), vec2i(0), vec2i(F.size.xy) - 1);
  let dir = normalize(worldDirNdc(F, p.xy));
  // The source's own light is removed from the background (it would otherwise mask itself).
  let own = e * (E.pts.w / pixelSolidAngle(F, p.xy));
  let bgPhys = max(bgAt(bgTex, p.xy) / F.proj.w - own, vec4f(0.0)) + analyticVeil(E, dir) + E.glare.x * textureLoad(extTex, px, 0) / F.proj.w;
  // The eye looking at the point is adapted to that background (its own fixation, eye-model.md §2).
  let ob = obsAt(bgPhys.y, bgPhys.w);
  let aC = max(bgPhys.y, E.cr1.y);
  let aR = max(bgPhys.w, E.cr1.y * E.mes.z);
  let mL = mesopicM(aC, aR);
  let bBw = blackwellEqM(E, mL, aC, aR);
  let visible = blackwellEqM(E, mL, e.y, e.w) >= E.mes.w * crumeyPointThreshold(E, bBw) / E.map.w;
  let aRicco = crumeyRiccoArea(E, bBw);
  let aCones = crumeyRiccoArea(E, max(bBw, ${f(CIE191.upperCdM2)}));
  let bg = bgPhys * E.map.w;
  let u = E.glare.x * E.map.w;
  let eY = e.y * u / aRicco;
  let eS = e.w * u / aRicco;
  let Lb = intendedLdO(ob, respO(ob, bg.y, bg.w));
  let dLd = select(0.0, max(0.0, intendedLdO(ob, respO(ob, bg.y + eY, bg.w + eS)) - Lb), visible);
  let wanted = dLd * E.pts.y;
  let Ldb = min(Lb, E.disp.w);
  let splatArea = 2.0 * PI * E.misc.z * E.misc.z * pixelSolidAngle(F, p.xy) / E.misc2.y;
  let capacity = max(0.0, E.disp.w - Ldb) * splatArea;
  let drawn = min(wanted, capacity);
  let peakLd = Ldb + drawn / max(splatArea, 1e-30);
  let chroma = displayChroma(e.xyz, colourKO(ob, bg.y + e.y * u / aCones, peakLd));
  o.disp = vec4f(chroma * drawn, 0.0);
  o.over = vec4f(chroma * (wanted - drawn), 0.0);
  return o;
}

fn splat(in: PV) -> f32 {
  // Offset from the true (sub-pixel) centre, in pixels.
  let s = E.misc.z;
  let r2 = dot(in.off, in.off);
  let ext = E.misc2.x;
  if (r2 > ext * ext) { return -1.0; }
  let ndc = ndcFromFrag(F, in.pos.xy);
  return exp(-r2 / (2.0 * s * s)) / (2.0 * PI * s * s) * E.misc2.y / pixelSolidAngle(F, ndc);
}

struct PhysOut { @location(0) pt: vec4f, @location(1) ex: vec4f };

@fragment fn fsPhys(in: PV) -> PhysOut {
  let g = splat(in);
  if (g < 0.0) { discard; }
  var o: PhysOut;
  o.pt = toStore(F, in.e * g);
  o.ex = min(in.over * g, vec4f(F.store.x));   // display units (cd/m²), not pre-exposed
  return o;
}

@fragment fn fsDisp(in: PV) -> @location(0) vec4f {
  let g = splat(in);
  if (g < 0.0) { discard; }
  return vec4f(in.disp.xyz * g, 0.0);
}
`;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Sun disk with measured limb darkening, depth-tested against bodies.
// ─────────────────────────────────────────────────────────────────────────────────────────────
export const SUN_SHADER = COMMON + /* wgsl */ `
struct Sun {
  n: vec4f,      // unit direction, w = distance (km)
  e1: vec4f,     // w = quad half-extent (tan units)
  e2: vec4f,     // w = radius (km)
  i0: vec4f,     // I0 per channel (cd/m2)
  c0: vec4f, c1: vec4f, c2: vec4f, c3: vec4f,  // limb-darkening coefficients mu^0..mu^3 per channel
  c4: vec4f, c5: vec4f,                        // mu^4, mu^5
  weight: vec4f, // x = resolved fraction
};
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> S: Sun;

struct SV { @builtin(position) pos: vec4f, @location(0) xy: vec2f };

@vertex fn vs(@builtin(vertex_index) vi: u32) -> SV {
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let xy = corners[vi] * S.e1.w;
  let d = S.n.xyz + xy.x * S.e1.xyz + xy.y * S.e2.xyz;
  let cc = toCam(F, d);
  var o: SV;
  o.pos = vec4f(cc.x * F.proj.x, cc.y * F.proj.y, 0.0, -cc.z);
  o.xy = xy;
  return o;
}

struct SO { @location(0) ext: vec4f, @builtin(frag_depth) depth: f32 };

@fragment fn fs(in: SV) -> SO {
  let r2 = dot(in.xy, in.xy);
  let sinT = sqrt(r2 / (1.0 + r2));
  let b = S.n.w * sinT / S.e2.w;             // impact parameter / R
  let edge = 1.0 - b * b;
  let cov = clamp(0.5 + edge / max(fwidth(edge), 1e-30), 0.0, 1.0);
  if (cov <= 0.0) { discard; }
  let mu = sqrt(max(edge, 0.0));
  let P = S.c0 + mu * (S.c1 + mu * (S.c2 + mu * (S.c3 + mu * (S.c4 + mu * S.c5))));
  var o: SO;
  o.ext = toStore(F, S.i0 * max(P, vec4f(0.0)) * (cov * S.weight.x));
  let cosT = 1.0 / sqrt(1.0 + r2);
  let t = S.n.w * cosT - S.e2.w * mu;
  let dir = normalize(S.n.xyz + in.xy.x * S.e1.xyz + in.xy.y * S.e2.xyz);
  o.depth = F.proj.z / max(t * dot(dir, -F.back.xyz), F.proj.z);
  return o;
}
`;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Glare pyramid (intraocular scatter): combine → downsample → separable blur → weighted upsample sum.
// ─────────────────────────────────────────────────────────────────────────────────────────────
export const PYRAMID_SHADER = /* wgsl */ `
struct Lvl { weight: f32, pad0: f32, pad1: f32, pad2: f32 };  // accum: level weight

@group(0) @binding(0) var srcA: texture_2d<f32>;
@group(0) @binding(1) var srcB: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba32float, write>;
@group(0) @binding(3) var<uniform> lvl: Lvl;

fn load(t: texture_2d<f32>, p: vec2i) -> vec4f {
  let d = vec2i(textureDimensions(t));
  if (p.x < 0 || p.y < 0 || p.x >= d.x || p.y >= d.y) { return vec4f(0.0); }
  return textureLoad(t, p, 0);
}

@compute @workgroup_size(8, 8) fn combine(@builtin(global_invocation_id) g: vec3u) {
  let p = vec2i(g.xy);
  let d = vec2i(textureDimensions(dst));
  if (p.x >= d.x || p.y >= d.y) { return; }
  textureStore(dst, p, load(srcA, p) + load(srcB, p));
}

@compute @workgroup_size(8, 8) fn down(@builtin(global_invocation_id) g: vec3u) {
  let p = vec2i(g.xy);
  let d = vec2i(textureDimensions(dst));
  if (p.x >= d.x || p.y >= d.y) { return; }
  let q = p * 2;
  let s = load(srcA, q) + load(srcA, q + vec2i(1, 0)) + load(srcA, q + vec2i(0, 1)) + load(srcA, q + vec2i(1, 1));
  textureStore(dst, p, s * 0.25);
}

// Discrete Gaussian, sigma = 1 texel, 7 taps, normalised.
const W0: f32 = 0.39905027;
const W1: f32 = 0.24203623;
const W2: f32 = 0.05400558;
const W3: f32 = 0.00443305;

fn blur(p: vec2i, dir: vec2i) -> vec4f {
  var s = load(srcA, p) * W0;
  s += (load(srcA, p + dir) + load(srcA, p - dir)) * W1;
  s += (load(srcA, p + 2 * dir) + load(srcA, p - 2 * dir)) * W2;
  s += (load(srcA, p + 3 * dir) + load(srcA, p - 3 * dir)) * W3;
  return s;
}

@compute @workgroup_size(8, 8) fn blurH(@builtin(global_invocation_id) g: vec3u) {
  let p = vec2i(g.xy);
  let d = vec2i(textureDimensions(dst));
  if (p.x >= d.x || p.y >= d.y) { return; }
  textureStore(dst, p, blur(p, vec2i(1, 0)));
}

@compute @workgroup_size(8, 8) fn blurV(@builtin(global_invocation_id) g: vec3u) {
  let p = vec2i(g.xy);
  let d = vec2i(textureDimensions(dst));
  if (p.x >= d.x || p.y >= d.y) { return; }
  textureStore(dst, p, blur(p, vec2i(0, 1)));
}

// Accumulation P_k = w_k·blur_k + up(P_{k+1}) (srcA = blur_k, srcB = P_{k+1}, a 1×1 zero texture above the
// top level). The pyramid runs twice per frame: on the physical image (the veil on the retina: adaptation,
// visibility thresholds) and on the overflow image (the viewer's glare that is painted, eye-model.md §3).

fn upsample(t: texture_2d<f32>, p: vec2i) -> vec4f {
  let c = (vec2f(p) + 0.5) * 0.5 - 0.5;
  let i0 = vec2i(floor(c));
  let fr = c - vec2f(i0);
  let a = mix(load(t, i0), load(t, i0 + vec2i(1, 0)), fr.x);
  let b = mix(load(t, i0 + vec2i(0, 1)), load(t, i0 + vec2i(1, 1)), fr.x);
  return mix(a, b, fr.y);
}

@compute @workgroup_size(8, 8) fn accum(@builtin(global_invocation_id) g: vec3u) {
  let p = vec2i(g.xy);
  let d = vec2i(textureDimensions(dst));
  if (p.x >= d.x || p.y >= d.y) { return; }
  textureStore(dst, p, lvl.weight * load(srcA, p) + upsample(srcB, p));
}
`;

/**
 * Overflow image, the input of the painted-glare pyramid (eye/points.ts §3), in display units (cd/m²,
 * XYZ): for extended sources the intended display luminance above the display peak, with the pixel's
 * displayed colour; plus the point sources' overflow (PTEX).
 */
export const OVERFLOW_SHADER = COMMON + TONE + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> E: Eye;
@group(0) @binding(2) var extTex: texture_2d<f32>;
@group(0) @binding(3) var wTex: texture_2d<f32>;
@group(0) @binding(4) var ptExTex: texture_2d<f32>;
@group(0) @binding(5) var dst: texture_storage_2d<rgba32float, write>;

@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) g: vec3u) {
  let p = vec2i(g.xy);
  let d = vec2i(textureDimensions(dst));
  if (p.x >= d.x || p.y >= d.y) { return; }
  let perc = textureLoad(wTex, p, 0).x * E.glare.x * textureLoad(extTex, p, 0) / F.proj.w * E.map.w;
  var o = textureLoad(ptExTex, p, 0);
  let over = intendedLd(sceneResponse(perc.y, perc.w)) - E.disp.w;
  if (over > 0.0 && perc.y > 0.0) {
    o = o + vec4f(displayChroma(perc.xyz, colourK(perc.y, E.disp.w)) * over, 0.0);
  }
  textureStore(dst, p, o);
}
`;

/** Discrete Gaussian weights used by PYRAMID_SHADER (σ = 1 texel, 7 taps), for the σ_eff model. */
export const PYRAMID_BLUR_SIGMA = 1;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Adaptation measurement: log-average over the foveal field of the retinal image (excluding point cores;
// Ward Larson, Rushmeier & Piatko 1997) and the corneal flux ∫L dΩ, reduced on the GPU.
// ─────────────────────────────────────────────────────────────────────────────────────────────
export const ADAPT_SHADER = COMMON + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> E: Eye;
@group(0) @binding(2) var extTex: texture_2d<f32>;
@group(0) @binding(3) var ptTex: texture_2d<f32>;
@group(0) @binding(4) var veilTex: texture_2d<f32>;
@group(0) @binding(5) var<storage, read_write> partials: array<vec4f>;
${SRCS(0, 6)}
${VEIL}

var<workgroup> sh: array<vec4f, 256>;

@compute @workgroup_size(16, 16) fn tiles(@builtin(global_invocation_id) g: vec3u, @builtin(local_invocation_index) li: u32, @builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nw: vec3u) {
  let p = vec2i(g.xy);
  var acc = vec4f(0.0);
  if (f32(p.x) < F.size.x && f32(p.y) < F.size.y) {
    let ndc = ndcFromFrag(F, vec2f(p) + 0.5);
    let dir = normalize(worldDirNdc(F, ndc));
    let om = pixelSolidAngle(F, ndc);
    let ext = textureLoad(extTex, p, 0) / F.proj.w;
    let pt = textureLoad(ptTex, p, 0) / F.proj.w;
    let ret = E.glare.x * ext + textureLoad(veilTex, p, 0) / F.proj.w + analyticVeil(E, dir);
    let lc = log(max(ret.y, 0.0) + E.dark.x);
    let lr = log(max(ret.w, 0.0) + E.dark.y);
    if (E.flags.z > 0.5) {
      // Fixations over the whole frame, drawn to the objects there in proportion to their light (the
      // unscattered scene, not the glare haze); at each the eye adapts to the retinal image (object plus
      // veil). The solar disk is never fixated; its veil still counts where the eye looks.
      let wgt = select((max(ext.y, 0.0) + E.dark.x) * om, 0.0, dot(dir, E.fix.xyz) >= E.fix.w);
      acc = vec4f(lc * wgt, lr * wgt, wgt, 0.0);
    } else if (dot(dir, -F.back.xyz) >= E.misc.y) {
      // One fixation at the view centre: log-average (geometric mean) over the adaptation field, offset by
      // the dark light so that darkness is finite (Ward Larson et al. 1997).
      acc = vec4f(lc * om, lr * om, om, 0.0);
    }
    acc.w = (ext.y + pt.y) * om;
  }
  sh[li] = acc;
  workgroupBarrier();
  for (var s = 128u; s > 0u; s = s >> 1u) {
    if (li < s) { sh[li] += sh[li + s]; }
    workgroupBarrier();
  }
  if (li == 0u) { partials[wg.x + wg.y * nw.x] = sh[0]; }
}
`;

export const ADAPT_REDUCE_SHADER = /* wgsl */ `
@group(0) @binding(0) var<storage, read> partials: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> result: array<vec4f, 2>;
@group(0) @binding(2) var<uniform> n: vec4u;
@group(0) @binding(3) var<storage, read> args: array<u32, 4>;
var<workgroup> sh: array<vec4f, 256>;
@compute @workgroup_size(256) fn main(@builtin(local_invocation_index) li: u32) {
  var acc = vec4f(0.0);
  for (var i = li; i < n.x; i += 256u) { acc += partials[i]; }
  sh[li] = acc;
  workgroupBarrier();
  for (var s = 128u; s > 0u; s = s >> 1u) {
    if (li < s) { sh[li] += sh[li + s]; }
    workgroupBarrier();
  }
  if (li == 0u) {
    result[0] = sh[0];
    result[1] = vec4f(f32(args[1]), 0.0, 0.0, 0.0);
  }
}
`;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Composite: retinal image → eye model (Ricco summation, Pattanaik rod/cone responses, mesopic
// desaturation, CAT02) → display luminance → sRGB with gamut mapping and dither.
// ─────────────────────────────────────────────────────────────────────────────────────────────
export const COMPOSITE_SHADER = COMMON + TONE + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> E: Eye;
@group(0) @binding(2) var extTex: texture_2d<f32>;
@group(0) @binding(3) var ptDispTex: texture_2d<f32>;   // point sources, display-linear XYZ (cd/m²)
@group(0) @binding(4) var wTex: texture_2d<f32>;
@group(0) @binding(5) var paintTex: texture_2d<f32>;    // painted glare: the viewer's veil of the overflow (display XYZ, cd/m²)
${SRCS(0, 6)}
${VEIL}

const XYZ2RGB = mat3x3f(
  vec3f(${f(SRGB.xyzToRgb[0])}, ${f(SRGB.xyzToRgb[3])}, ${f(SRGB.xyzToRgb[6])}),
  vec3f(${f(SRGB.xyzToRgb[1])}, ${f(SRGB.xyzToRgb[4])}, ${f(SRGB.xyzToRgb[7])}),
  vec3f(${f(SRGB.xyzToRgb[2])}, ${f(SRGB.xyzToRgb[5])}, ${f(SRGB.xyzToRgb[8])}));
// 1 / (Y of RGB (1,1,1)): the achromatic colour of luminance Y is (Y·GRAY_NORM)·(1,1,1).
const GRAY_NORM: f32 = ${f(1 / (SRGB_TO_XYZ[3] + SRGB_TO_XYZ[4] + SRGB_TO_XYZ[5]))};

@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[vi], 0.0, 1.0);
}

fn srgbEncode(c: f32) -> f32 {
  if (c <= ${f(SRGB.encodeThreshold)}) { return ${f(SRGB.linearSlope)} * c; }
  return ${f(SRGB.gammaScale)} * pow(c, 1.0 / ${f(SRGB.gamma)}) - ${f(SRGB.gammaOffset)};
}

fn hash(p: vec2u) -> f32 {
  var x = p.x * 1664525u + p.y * 1013904223u;
  x = (x ^ (x >> 16u)) * 2246822519u;
  x = (x ^ (x >> 13u)) * 3266489917u;
  x = x ^ (x >> 16u);
  return f32(x) / 4294967296.0;
}

@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let p = vec2i(pos.xy);
  let ndc = ndcFromFrag(F, pos.xy);
  let dir = normalize(worldDirNdc(F, ndc));
  let ext = textureLoad(extTex, p, 0) / F.proj.w;
  let w = textureLoad(wTex, p, 0).x;
  // Perceived extended image: unscattered core (small resolved bodies Ricco-weighted) + the analytic veil
  // of the Sun and off-frame bodies (never displayable, so their glare is shown as the scene observer's).
  // The in-frame veil is not shown here: the viewer's eye scatters whatever the display shows, and what it
  // cannot show is painted below as the viewer's glare of the overflow.
  let perc = (w * E.glare.x * ext + analyticVeil(E, dir)) * E.map.w;
  // Pattanaik et al. (2000) with Hunt rods: scene responses → display luminance.
  let Ld = displayLd(sceneResponse(perc.y, perc.w));
  // Colour: chromatic adaptation to the display white, then the cone colour-appearance exponent
  // (Pattanaik Eq. 3, tonemap.ts colourExponent).
  var chroma = WHITE_XYZ;
  if (perc.y > 0.0) { chroma = displayChroma(perc.xyz, colourK(perc.y, Ld)); }
  // Display-linear, relative to the display peak, plus the painted glare.
  let xyzD = chroma * (Ld / E.disp.w) + textureLoad(paintTex, p, 0).xyz / E.disp.w;
  let Yd = xyzD.y;
  var rgb = XYZ2RGB * xyzD;
  // Gamut mapping toward the achromatic colour of equal luminance (docs/eye-model.md §7).
  let g = Yd * GRAY_NORM;
  var t = 1.0;
  for (var k = 0; k < 3; k++) {
    let c = rgb[k];
    if (c < 0.0) { t = min(t, g / (g - c)); }
    if (c > 1.0) { t = min(t, (1.0 - g) / (c - g)); }
  }
  if (g >= 1.0) { rgb = vec3f(1.0); } else { rgb = vec3f(g) + t * (rgb - vec3f(g)); }
  rgb = clamp(rgb, vec3f(0.0), vec3f(1.0));
  // Point sources (display units, at most the display peak by construction): hue-preserving fit into the
  // gamut, then drawn over the extended image. Where a star's dot and its painted glare together exceed
  // the display, the dot's own colour is kept rather than clipping both to white.
  var rp = XYZ2RGB * (textureLoad(ptDispTex, p, 0).xyz / E.disp.w);
  let lo = min(rp.r, min(rp.g, rp.b));
  if (lo < 0.0) {
    let gp = max(textureLoad(ptDispTex, p, 0).y / E.disp.w, 0.0) * GRAY_NORM;
    rp = vec3f(gp) + (gp / max(gp - lo, 1e-12)) * (rp - vec3f(gp));
  }
  rp = max(rp, vec3f(0.0));
  let hi = max(rp.r, max(rp.g, rp.b));
  if (hi > 1.0) { rp = rp / hi; }
  rgb = clamp(rp + rgb * (1.0 - min(1.0, max(rp.r, max(rp.g, rp.b)))), vec3f(0.0), vec3f(1.0));
  // sRGB encoding with triangular dither of ±1 LSB against banding.
  let n = hash(vec2u(p)) + hash(vec2u(p) + vec2u(7919u, 104729u)) - 1.0;
  let enc = vec3f(srgbEncode(rgb.r), srgbEncode(rgb.g), srgbEncode(rgb.b)) + n * E.misc.x;
  return vec4f(clamp(enc, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;

// Screen-space overlay geometry (orbits, markers): pre-projected on the CPU, depth-tested manually.
export const LINE_SHADER = /* wgsl */ `
@group(0) @binding(0) var depthTex: texture_depth_2d;
struct LV { @builtin(position) pos: vec4f, @location(0) col: vec4f, @location(1) depth: f32 };
@vertex fn vs(@location(0) p: vec3f, @location(1) col: vec4f) -> LV {
  var o: LV;
  o.pos = vec4f(p.xy, 0.0, 1.0);
  o.col = col;
  o.depth = p.z;
  return o;
}
@fragment fn fs(in: LV) -> @location(0) vec4f {
  let stored = textureLoad(depthTex, vec2i(in.pos.xy), 0);
  if (in.depth > 0.0 && stored > in.depth * 1.0001) { discard; }
  return vec4f(in.col.rgb * in.col.a, in.col.a);
}
`;

export const RING_SHADER = RING_SHADER_OF(COMMON);
