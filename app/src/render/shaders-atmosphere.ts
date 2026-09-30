// WGSL for planetary atmospheres (atmosphere.ts is the reference). Tables are packed into one rgba16float
// 2D-array texture (atmosphereGpu.ts packTables): four bins per texel, K4 = ⌈K/4⌉ layers per table.
//   layer j            transmittance to the top, 256 × 64 (x_μ, x_r)
//   layer K4 + j       multiple scattering Ψ_ms, 32 × 32 ((μs + 1)/2, h/H)
//   layer 2K4 + j      sky irradiance, 64 × 16 ((μs + 1)/2, h/H)
//   layer 3K4 + j      profile σ_t, 256 × 1 (√(h/H))
//   layer 4K4 + j      profile σ_s molecular
//   layer 5K4 + j      profile σ_s particle
//   layer 6K4 + j      particle phase function, 181 × 1 (scattering angle / 180°)
// Needs bindings A (Atm uniform), atmTex and atmSamp.

import { IRR_H, IRR_W, MS_N, PHASE_N, PROFILE_N, T_H, T_W } from './atmosphere';

/** Largest number of 4-bin groups the shaders handle (16 bins). */
export const ATM_K4_MAX = 4;
/** Width and height of the packed texture's layers. */
export const ATM_TEX_W = Math.max(T_W, PROFILE_N, PHASE_N, IRR_W, MS_N);
export const ATM_TEX_H = Math.max(T_H, MS_N, IRR_H);

const f = (x: number) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

export const ATMOSPHERE_WGSL = /* wgsl */ `
struct Atm {
  geo: vec4f,     // bottom radius, top radius (km), K4, Sun's angular radius (rad)
  sunE: vec4f,    // solar illuminance at the body over π (cd/m² per unit radiance factor), XYZS
  quad: vec4f,    // shell quad half-extent (tan units), 1 = full-screen (camera near or inside), steps, 1 = scattering not measured
  w: array<vec4f, 16>,     // fold weights: channel c, bins 4j..4j+3 at w[4c + j]
  depol: array<vec4f, 4>,  // Rayleigh depolarisation ratio per bin
};

const ATM_TW: f32 = ${f(ATM_TEX_W)};
const ATM_TH: f32 = ${f(ATM_TEX_H)};

fn atmSample(layer: i32, x: f32, y: f32, nx: f32, ny: f32) -> vec4f {
  let uv = vec2f((clamp(x, 0.0, 1.0) * (nx - 1.0) + 0.5) / ATM_TW, (clamp(y, 0.0, 1.0) * (ny - 1.0) + 0.5) / ATM_TH);
  return textureSampleLevel(atmTex, atmSamp, uv, layer, 0.0);
}
fn atmK4() -> i32 { return i32(A.geo.z); }

/** Transmittance table coordinates (atmosphere.ts transmittanceUv). */
fn atmTransmittanceUv(r: f32, mu: f32) -> vec2f {
  let Rb = A.geo.x;
  let Rt = A.geo.y;
  let H = sqrt(Rt * Rt - Rb * Rb);
  let rho = sqrt(max(r * r - Rb * Rb, 0.0));
  let d = max(-r * mu + sqrt(max(r * r * (mu * mu - 1.0) + Rt * Rt, 0.0)), 0.0);
  let dMin = Rt - r;
  let dMax = rho + H;
  return vec2f(select(0.0, (d - dMin) / (dMax - dMin), dMax > dMin), rho / H);
}
fn atmT(r: f32, mu: f32, j: i32) -> vec4f {
  let uv = atmTransmittanceUv(r, mu);
  return atmSample(j, uv.x, uv.y, ${f(T_W)}, ${f(T_H)});
}
/** Transmittance to the Sun, with the solar disk sinking below the horizon (Bruneton 2017). */
fn atmTsun(r: f32, muS: f32, j: i32) -> vec4f {
  let sinH = min(A.geo.x / r, 1.0);
  let cosH = -sqrt(max(1.0 - sinH * sinH, 0.0));
  let a = sinH * A.geo.w;
  return atmT(r, muS, j) * smoothstep(-a, a, muS - cosH);
}
fn atmMS(h: f32, muS: f32, j: i32) -> vec4f {
  return atmSample(atmK4() + j, (muS + 1.0) * 0.5, h / (A.geo.y - A.geo.x), ${f(MS_N)}, ${f(MS_N)});
}
fn atmIrr(h: f32, muS: f32, j: i32) -> vec4f {
  return atmSample(2 * atmK4() + j, (muS + 1.0) * 0.5, h / (A.geo.y - A.geo.x), ${f(IRR_W)}, ${f(IRR_H)});
}
fn atmProfile(h: f32, q: i32, j: i32) -> vec4f {
  return atmSample((3 + q) * atmK4() + j, sqrt(clamp(h / (A.geo.y - A.geo.x), 0.0, 1.0)), 0.0, ${f(PROFILE_N)}, 1.0);
}
fn atmParticlePhase(nu: f32, j: i32) -> vec4f {
  return atmSample(6 * atmK4() + j, acos(clamp(nu, -1.0, 1.0)) / PI, 0.0, ${f(PHASE_N)}, 1.0);
}
fn atmRayleighPhase(nu: f32, depol: vec4f) -> vec4f {
  let gamma = depol / (2.0 - depol);
  return (3.0 / (16.0 * PI)) * ((1.0 + 3.0 * gamma) + (1.0 - gamma) * nu * nu) / (1.0 + 2.0 * gamma);
}
/** Σ_k w[c][k]·x_k for the four channels. */
fn atmFold(x: array<vec4f, 4>) -> vec4f {
  var o = vec4f(0.0);
  for (var j = 0; j < atmK4(); j++) {
    o += vec4f(dot(A.w[j], x[j]), dot(A.w[4 + j], x[j]), dot(A.w[8 + j], x[j]), dot(A.w[12 + j], x[j]));
  }
  return o;
}

struct AtmPath {
  L: array<vec4f, 4>,   // path radiance per unit solar irradiance (sr⁻¹), per bin, over the whole segment
  T: array<vec4f, 4>,   // transmittance of the whole segment
  Lc: array<vec4f, 4>,  // the same over the part above altitude hSplit (the cloud tops)
  Tc: array<vec4f, 4>,
};

/**
 * Single scattering (species phase functions) plus Hillaire's multiple scattering along the segment
 * p(s) = p0 − d·s, s from sNear (camera side) down to sFar, marched in n steps from the camera side
 * (atmosphere.ts skyRadianceK). p0 is relative to the body centre (km); Mr rows map a body-relative point
 * to the unit-sphere frame of the body's ellipsoid, so altitude = |p| − |p|/|M p| (above the ellipsoid).
 */
fn atmMarch(p0: vec3f, d: vec3f, sNear: f32, sFar: f32, n: i32, S: vec3f, m0: vec3f, m1: vec3f, m2: vec3f, hSplit: f32) -> AtmPath {
  var o: AtmPath;
  let K4 = atmK4();
  var phR: array<vec4f, 4>;
  var phA: array<vec4f, 4>;
  // Scattering angle: sunlight travels along −S, the scattered light toward the camera along −d.
  let nu = dot(d, S);
  for (var j = 0; j < K4; j++) {
    o.T[j] = vec4f(1.0);
    o.Tc[j] = vec4f(1.0);
    phR[j] = atmRayleighPhase(nu, A.depol[j]);
    phA[j] = atmParticlePhase(nu, j);
  }
  let ds = (sNear - sFar) / f32(n);
  for (var i = 0; i < n; i++) {
    let s = sNear - (f32(i) + 0.5) * ds;
    let p = p0 - d * s;
    let rp = length(p);
    let q = vec3f(dot(m0, p), dot(m1, p), dot(m2, p));
    let h = max(rp - rp / max(length(q), 1e-6), 0.0);
    let r = A.geo.x + h;
    let muS = dot(p, S) / rp;
    for (var j = 0; j < K4; j++) {
      let ext = atmProfile(h, 0, j);
      let sR = atmProfile(h, 1, j);
      let sA = atmProfile(h, 2, j);
      let src = (sR * phR[j] + sA * phA[j]) * atmTsun(r, muS, j) + (sR + sA) * atmMS(h, muS, j);
      // Analytic integration over the step (Hillaire 2020): ∫ T S = T·S·(1 − e^{−σ ds})/σ.
      let tr = exp(-ext * ds);
      let seg = src * select(vec4f(ds), (1.0 - tr) / max(ext, vec4f(1e-12)), ext > vec4f(1e-9));
      o.L[j] += o.T[j] * seg;
      o.T[j] *= tr;
      if (h > hSplit) {
        o.Lc[j] += o.Tc[j] * seg;
        o.Tc[j] *= tr;
      }
    }
  }
  return o;
}
`;
