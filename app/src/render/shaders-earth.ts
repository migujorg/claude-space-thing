// WGSL for Earth's layers (earth.ts is the reference; every function here mirrors one there).
// Needs SURFACE_WGSL (findPage, atlasTexel, isFiniteF) and the bindings declared by the Earth body
// pipeline: cloudPages (rgba16float atlas), rg16Pages (rg16float atlas) and SI (SurfInfo).

import { CLOUD_G_ICE, CLOUD_G_LIQUID, COX_MUNK_MAX_WIND, COX_MUNK_SIGMA2, FRESNEL_DIFFUSE, GAUSS4_W, GAUSS4_X, SEA_ICE_ALBEDO_VIS, SEA_WATER_N, WIND_12_5_PER_10 } from './earth';

const f = (x: number) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

export const EARTH_WGSL = /* wgsl */ `
struct LayerSample { v: vec4f, known: vec4f };

/**
 * Bilinear sample of a layer at level L over its known texels, per channel: known = weight of known
 * texels (0: unknown or not loaded). Unknown texels are NaN (zeroUnknown: all channels exactly 0, as in
 * albedo maps).
 */
fn sampleLayer(tex: texture_2d_array<f32>, perRow: u32, base: u32, L: u32, uv: vec2f, zeroUnknown: bool) -> LayerSample {
  let W = 512u << L;
  let H = 256u << L;
  let c = uv * vec2f(f32(W), f32(H)) - 0.5;
  let i0 = vec2i(floor(c));
  let fr = c - vec2f(i0);
  var acc = vec4f(0.0);
  var wk = vec4f(0.0);
  for (var k = 0; k < 4; k++) {
    let dx = k & 1;
    let dy = k >> 1;
    let w = select(1.0 - fr.x, fr.x, dx == 1) * select(1.0 - fr.y, fr.y, dy == 1);
    let ix = u32((i0.x + dx + i32(W)) % i32(W));
    let iy = u32(clamp(i0.y + dy, 0, i32(H) - 1));
    let h = findPage(base, L, ix, iy);
    if (h.page != 0u) {
      let a = atlasTexel(h.page, perRow, h.x, h.y);
      let t = textureLoad(tex, a.xy, a.z, 0);
      var ok = vec4<bool>(isFiniteF(t.x), isFiniteF(t.y), isFiniteF(t.z), isFiniteF(t.w));
      if (zeroUnknown && all(t == vec4f(0.0))) { ok = vec4<bool>(false); }
      acc += select(vec4f(0.0), w * t, ok);
      wk += select(vec4f(0.0), vec4f(w), ok);
    }
  }
  return LayerSample(select(vec4f(0.0), acc / max(wk, vec4f(1e-30)), wk > vec4f(0.0)), wk);
}

const CLOUD_G_LIQUID: f32 = ${f(CLOUD_G_LIQUID)};
const CLOUD_G_ICE: f32 = ${f(CLOUD_G_ICE)};
const SEA_ICE_ALBEDO: f32 = ${f(SEA_ICE_ALBEDO_VIS)};
const G4X = vec4f(${GAUSS4_X.map(f).join(', ')});
const G4W = vec4f(${GAUSS4_W.map(f).join(', ')});

fn escapeFn(mu: f32) -> f32 { return (3.0 / 7.0) * (1.0 + 2.0 * mu); }

const SEA_WATER_N: f32 = ${f(SEA_WATER_N)};
const FRESNEL_DIFFUSE: f32 = ${f(FRESNEL_DIFFUSE)};

/** earth.ts fresnel. */
fn fresnelWater(cosI: f32) -> f32 {
  let c = clamp(cosI, 0.0, 1.0);
  let sinT2 = (1.0 - c * c) / (SEA_WATER_N * SEA_WATER_N);
  if (sinT2 >= 1.0) { return 1.0; }
  let cosT = sqrt(1.0 - sinT2);
  let rs = (c - SEA_WATER_N * cosT) / (c + SEA_WATER_N * cosT);
  let rp = (SEA_WATER_N * c - cosT) / (SEA_WATER_N * c + cosT);
  return 0.5 * (rs * rs + rp * rp);
}
/** earth.ts erfc (Abramowitz & Stegun 7.1.26). */
fn erfcAS(x: f32) -> f32 {
  let t = 1.0 / (1.0 + 0.3275911 * x);
  return t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * exp(-x * x);
}
/** earth.ts smithLambda. */
fn smithLambda(mu: f32, s2: f32) -> f32 {
  if (mu >= 1.0) { return 0.0; }
  let nu = mu / sqrt(s2 * (1.0 - mu * mu));
  if (nu > 6.0) { return 0.0; }
  return (exp(-nu * nu) / (nu * sqrt(PI)) - erfcAS(nu)) * 0.5;
}
fn glintOf(cosBeta: f32, mu: f32, cosOmega: f32, s2: f32, mu0: f32) -> f32 {
  let c2 = cosBeta * cosBeta;
  let tan2 = (1.0 - c2) / c2;
  let shadow = 1.0 / (1.0 + smithLambda(max(mu0, 1e-6), s2) + smithLambda(max(mu, 1e-6), s2));
  return fresnelWater(cosOmega) * exp(-tan2 / s2) * shadow / (4.0 * s2 * mu * c2 * c2);
}
/** earth.ts glintRadianceFactor (Cox & Munk 1954, with Smith/Sancer shadowing). */
fn glintRF(cosBeta: f32, mu: f32, cosOmega: f32, u10: f32, mu0: f32) -> f32 {
  if (cosBeta <= 0.0 || mu <= 0.0) { return 0.0; }
  return glintOf(cosBeta, mu, cosOmega, ${f(COX_MUNK_SIGMA2.a)} + ${f(COX_MUNK_SIGMA2.b)} * max(u10, 0.0) * ${f(WIND_12_5_PER_10)}, mu0);
}
/** earth.ts glintMaxRadianceFactor: the largest glint of any wind in Cox & Munk's measured range. */
fn glintMaxRF(cosBeta: f32, mu: f32, cosOmega: f32, mu0: f32) -> f32 {
  if (cosBeta <= 0.0 || mu <= 0.0) { return 0.0; }
  let c2 = cosBeta * cosBeta;
  let tan2 = (1.0 - c2) / c2;
  return glintOf(cosBeta, mu, cosOmega, clamp(tan2, ${f(COX_MUNK_SIGMA2.a)}, ${f(COX_MUNK_SIGMA2.a + COX_MUNK_SIGMA2.b * COX_MUNK_MAX_WIND)}), mu0);
}

/** δ-Eddington plane albedo of a conservative layer (earth.ts cloudPlaneAlbedo). */
fn cloudPlaneAlbedo(tau: f32, g: f32, mu0: f32) -> f32 {
  let tt = (1.0 - g) * tau;
  let tp = (1.0 - g * g) * tau;
  let m = max(mu0, 1e-4);
  return clamp((tt + (2.0 / 3.0 - m) * (1.0 - exp(-tp / m))) / (4.0 / 3.0 + tt), 0.0, 1.0);
}

/** What the layers say at one point (earth.ts EarthSample; NaN handled by the known weights). */
struct EarthIn {
  Rs: vec4f,        // absolute surface reflectance where known
  surfKnown: f32,   // 1 known, 0 unknown
  fw: f32,          // water fraction
  fi: f32,          // sea-ice concentration over the water
  C: f32,           // cloud fraction
  cKnown: f32,      // cloud state known (1/0)
  tau: f32,         // in-cloud optical thickness
  tauKnown: f32,
  fice: f32,        // ice-phase share
  cthKm: f32,       // cloud-top height (km), 0 where unknown
  u10: f32,         // 10 m wind speed (m/s)
  windKnown: f32,   // 1 known, 0 unknown
  glint: f32,       // 1: wind layer bound (glint drawn, or marked unknown where the wind is)
};

/** One part of the pixel (earth.ts EarthPart): share, direct and diffuse radiance factors, emission transmission. */
struct EarthPart { w: f32, dir: vec4f, dif: vec4f, emit: vec4f };
struct EarthParts { clear: EarthPart, cloudy: EarthPart, gap: f32, gapEmit: f32, glintShare: f32, glintMax: f32 };

/** earth.ts earthParts. */
fn earthParts(e: EarthIn, mu0: f32, mu: f32, cosBeta: f32, cosOmega: f32) -> EarthParts {
  var gap = 0.0;
  let ai = clamp(e.fw, 0.0, 1.0) * clamp(e.fi, 0.0, 1.0);
  let Rs = ai * SEA_ICE_ALBEDO + (1.0 - ai) * select(vec4f(0.0), e.Rs, e.surfKnown > 0.5);
  let surfaceGap = select(1.0 - ai, 0.0, e.surfKnown > 0.5);
  var C = clamp(e.C, 0.0, 1.0);
  if (e.cKnown < 0.5) { C = 0.0; gap = 1.0; }
  var cloudy = C;
  var tau = max(e.tau, 0.0);
  if (C > 0.0 && e.tauKnown < 0.5) { gap = max(gap, C); cloudy = 0.0; tau = 0.0; }
  let gapEmit = gap;
  let fice = clamp(e.fice, 0.0, 1.0);
  let g = (1.0 - fice) * CLOUD_G_LIQUID + fice * CLOUD_G_ICE;
  let clearW = 1.0 - C;
  gap = max(gap, clearW * surfaceGap);
  let m0 = max(mu0, 0.0);
  // Open water: Sun glint (Cox & Munk) and the sky's Fresnel reflection (earth.ts earthParts).
  let ow = clamp(e.fw, 0.0, 1.0) * (1.0 - clamp(e.fi, 0.0, 1.0));
  var rg = 0.0;
  var o: EarthParts;
  if (e.glint > 0.5 && ow > 0.0 && mu0 > 0.0) {
    if (e.windKnown > 0.5) { rg = glintRF(cosBeta, mu, cosOmega, e.u10, mu0); }
    else { o.glintShare = clearW * ow; o.glintMax = glintMaxRF(cosBeta, mu, cosOmega, mu0); }
  }
  o.clear = EarthPart(clearW, Rs * m0 + ow * rg, Rs + ow * FRESNEL_DIFFUSE, vec4f(1.0));
  o.cloudy = EarthPart(cloudy, vec4f(0.0), vec4f(0.0), vec4f(0.0));
  if (cloudy > 0.0) {
    let tp = (1.0 - g * g) * tau;
    var rbar = 0.0;
    var tdir = 0.0;
    for (var k = 0; k < 4; k++) {
      rbar += 2.0 * G4W[k] * G4X[k] * cloudPlaneAlbedo(tau, g, G4X[k]);
      tdir += 2.0 * G4W[k] * G4X[k] * exp(-tp / G4X[k]);
    }
    let R0 = cloudPlaneAlbedo(tau, g, mu0);
    let through = exp(-tp / max(mu, 1e-4)) + max(1.0 - rbar - tdir, 0.0) * escapeFn(mu);
    let multi = 1.0 / (1.0 - Rs * rbar);
    let glintThrough = ow * rg * exp(-tp / max(m0, 1e-4)) * exp(-tp / max(mu, 1e-4));
    o.cloudy.dir = m0 * (R0 * escapeFn(mu) + (1.0 - R0) * multi * Rs * through) + glintThrough;
    o.cloudy.dif = rbar * escapeFn(mu) + (1.0 - rbar) * multi * Rs * through;
    o.cloudy.emit = multi * through;
  }
  o.gap = gap;
  o.gapEmit = gapEmit;
  return o;
}

struct EarthOut { rho: vec4f, emitT: vec4f, gap: f32, gapEmit: f32 };

/** earth.ts earthShade: no atmosphere. */
fn earthShade(e: EarthIn, mu0: f32, mu: f32, cosBeta: f32, cosOmega: f32) -> EarthOut {
  let p = earthParts(e, mu0, mu, cosBeta, cosOmega);
  var o: EarthOut;
  o.rho = p.clear.w * p.clear.dir + p.cloudy.w * p.cloudy.dir;
  o.emitT = p.clear.w * p.clear.emit + p.cloudy.w * p.cloudy.emit;
  o.gap = max(p.gap, earthGlintGap(p.glintShare, p.glintMax, o.rho.y));
  o.gapEmit = p.gapEmit;
  return o;
}

/** earth.ts earthGlintGap. */
fn earthGlintGap(share: f32, maxRho: f32, knownRhoY: f32) -> f32 {
  return select(0.0, share, share > 0.0 && maxRho > knownRhoY);
}

/** Unknown share of a pixel: reflected light where lit, emitted light where there are lights (earth.ts). */
fn earthGap(gap: f32, gapEmit: f32, lit: bool, nightL: vec4f) -> f32 {
  return max(select(0.0, gap, lit), select(0.0, gapEmit, nightL.y > 0.0));
}
`;
