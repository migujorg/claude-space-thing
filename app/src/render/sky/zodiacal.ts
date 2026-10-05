// Zodiacal light from sky/zodiacal.json (ZodiacalLightModel): the Kelsall et al. (1998) interplanetary dust
// cloud with the visible phase function and albedo the pipeline fitted to Leinert et al. (1998) Table 16.
//
//   I(obs, d) = A ∫ n(x) Φ(Θ) / R² ds     (solar flux at 1 AU per sr; n in AU⁻¹, s and R in AU)
//   L_XYZS    = I · perSolarFluxPerSr(ε)  (cd/m², scotopic cd/m²; ε = solar elongation of d, 30°→90° colour)
//
// integrated from the observer to R = rOutAU (5.2 AU). The same quadrature runs on the CPU (this file:
// tests, probes) and on the GPU (zodiacalWgsl, generated from the same parameters): 24 uniform steps over the
// first 0.3 AU (the Earth's resonant ring lies there for an observer at 1 AU), then 64 steps uniform in
// t with s = s_ca + h·sinh(t) beyond, which concentrates samples at the ray's closest approach to the Sun
// (s_ca, distance h), where the integrand ∝ R^-3.3 peaks.
//
// Frame: heliocentric ecliptic J2000 (the obliquity below rotates ICRF into it). The trailing blob is placed
// relative to the Earth's heliocentric mean longitude (Kelsall Sect. 4.2.3), from Standish's approximate
// mean elements (JPL, "Keplerian Elements for Approximate Positions of the Major Planets", EM barycentre:
// L = 100.46457166° + 35999.37244981° T, T in Julian centuries past J2000) — adequate for a blob 12° wide.

import { DAYS_PER_JULIAN_CENTURY, EARTH_MEAN_LONGITUDE, OBLIQUITY_J2000_RAD, SECONDS_PER_DAY } from '../../core/constants';
export { AU_KM, OBLIQUITY_J2000_RAD, S10_PER_SOLAR_FLUX_SR } from '../../core/constants';
import type { ZodiacalLightModel } from '../../data/schema';

export type V3 = [number, number, number];
export type XYZS = [number, number, number, number];

export interface ZodiParams {
  smooth: { n0: number; alpha: number; beta: number; gamma: number; mu: number; i: number; om: number; x0: number; y0: number; z0: number };
  bands: { n3: number; dzeta: number; v: number; p: number; i: number; om: number; dR: number }[];
  ring: { n: number; R: number; sr: number; sz: number; i: number; om: number };
  blob: { n: number; R: number; sr: number; sz: number; theta: number; sth: number };
  albedo: number;
  c0: number;
  c1: number;
  c2: number;
  norm: number;
  rOut: number;
  eps30: XYZS;
  eps90: XYZS;
}

const deg = (x: number) => (x * Math.PI) / 180;

export function parseZodiacal(z: ZodiacalLightModel): ZodiParams {
  const comp = z.cloud.value?.components as Record<string, any> | undefined;
  const sc = z.scattering.value;
  if (!comp || !sc) throw new Error('zodiacal.json: cloud or scattering has no value');
  const s = comp.smoothCloud;
  const r = comp.ring;
  const b = comp.trailingBlob;
  const need = (x: unknown, what: string) => {
    if (typeof x !== 'number' || !Number.isFinite(x)) throw new Error(`zodiacal.json: ${what} missing`);
    return x;
  };
  return {
    smooth: {
      n0: need(s.n0_per_AU, 'n0'), alpha: need(s.alpha, 'alpha'), beta: need(s.beta, 'beta'), gamma: need(s.gamma, 'gamma'),
      mu: need(s.mu, 'mu'), i: deg(need(s.i_deg, 'i')), om: deg(need(s.Omega_deg, 'Omega')),
      x0: need(s.X0_AU, 'X0'), y0: need(s.Y0_AU, 'Y0'), z0: need(s.Z0_AU, 'Z0'),
    },
    bands: (comp.dustBands as any[]).map((d) => ({
      n3: need(d.n3_per_AU, 'n3'), dzeta: deg(need(d.dzeta_deg, 'dzeta')), v: need(d.v, 'v'), p: need(d.p, 'p'),
      i: deg(need(d.i_deg, 'band i')), om: deg(need(d.Omega_deg, 'band Omega')), dR: need(d.dR_AU, 'dR'),
    })),
    ring: { n: need(r.n_SR_per_AU, 'nSR'), R: need(r.R_SR_AU, 'RSR'), sr: need(r.sigma_r_SR_AU, 'sr'), sz: need(r.sigma_z_SR_AU, 'sz'), i: deg(need(r.i_deg, 'ring i')), om: deg(need(r.Omega_deg, 'ring Omega')) },
    blob: { n: need(b.n_TB_per_AU, 'nTB'), R: need(b.R_TB_AU, 'RTB'), sr: need(b.sigma_r_TB_AU, 'srTB'), sz: need(b.sigma_z_TB_AU, 'szTB'), theta: deg(need(b.theta_TB_deg, 'thetaTB')), sth: deg(need(b.sigma_theta_TB_deg, 'sthTB')) },
    albedo: need(sc.albedo, 'albedo'), c0: need(sc.C0, 'C0'), c1: need(sc.C1, 'C1'), c2: need(sc.C2, 'C2'), norm: need(sc.N, 'N'),
    rOut: need(z.cloud.value!.rOutAU, 'rOutAU'),
    eps30: sc.perSolarFluxPerSr.eps30 as XYZS,
    eps90: sc.perSolarFluxPerSr.eps90 as XYZS,
  };
}

/** Height above a plane of inclination i and ascending node om (Kelsall Eq. 5). */
const tiltZ = (x: number, y: number, z: number, i: number, om: number) =>
  x * Math.sin(om) * Math.sin(i) - y * Math.cos(om) * Math.sin(i) + z * Math.cos(i);

/** Cross-section density (AU⁻¹) at heliocentric ecliptic (x, y, z) AU; earthLon = Earth's mean longitude (rad). */
export function density(m: ZodiParams, x: number, y: number, z: number, earthLon: number): number {
  const s = m.smooth;
  const xp = x - s.x0, yp = y - s.y0, zp = z - s.z0;
  const rc = Math.hypot(xp, yp, zp);
  const zeta = Math.abs(tiltZ(xp, yp, zp, s.i, s.om)) / rc;
  const g = zeta < s.mu ? (zeta * zeta) / (2 * s.mu) : zeta - s.mu / 2;
  let n = s.n0 * Math.pow(rc, -s.alpha) * Math.exp(-s.beta * Math.pow(g, s.gamma));
  const r = Math.hypot(x, y, z);
  for (const b of m.bands) {
    const q = Math.abs(tiltZ(x, y, z, b.i, b.om)) / r / b.dzeta;
    n += ((3 * b.n3) / r) * Math.exp(-(q ** 6)) * (b.v + q ** b.p) * (1 - Math.exp(-((r / b.dR) ** 20)));
  }
  const ring = m.ring;
  const zr = Math.abs(tiltZ(x, y, z, ring.i, ring.om));
  n += ring.n * Math.exp(-((r - ring.R) ** 2) / (2 * ring.sr ** 2) - zr / ring.sz);
  const bl = m.blob;
  let dth = Math.atan2(y, x) - earthLon;
  dth = ((((dth + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI - bl.theta;
  n += bl.n * Math.exp(-((r - bl.R) ** 2) / (2 * bl.sr ** 2) - zr / bl.sz - (dth * dth) / (2 * bl.sth ** 2));
  return n;
}

export function phase(m: ZodiParams, theta: number): number {
  return m.norm * (m.c0 + m.c1 * theta + Math.exp(m.c2 * theta));
}

export const NEAR_STEPS = 24;
export const FAR_STEPS = 64;
export const NEAR_AU = 0.3;

/** Scattered brightness I (solar flux at 1 AU per sr) seen from `obs` (AU, helio-ecliptic) along unit `d`. */
export function losBrightness(m: ZodiParams, obs: V3, d: V3, earthLon: number, nearSteps = NEAR_STEPS, farSteps = FAR_STEPS): number {
  const b = obs[0] * d[0] + obs[1] * d[1] + obs[2] * d[2];
  const c = obs[0] ** 2 + obs[1] ** 2 + obs[2] ** 2 - m.rOut ** 2;
  const disc = b * b - c;
  if (disc <= 0) return 0;
  const sq = Math.sqrt(disc);
  const s0 = Math.max(0, -b - sq);
  const s1 = -b + sq;
  if (s1 <= s0) return 0;
  const f = (s: number) => {
    const x = obs[0] + s * d[0], y = obs[1] + s * d[1], z = obs[2] + s * d[2];
    const r = Math.hypot(x, y, z);
    const cosT = -(x * d[0] + y * d[1] + z * d[2]) / r;
    return (density(m, x, y, z, earthLon) * phase(m, Math.acos(Math.max(-1, Math.min(1, cosT))))) / (r * r);
  };
  let sum = 0;
  // near segment: uniform (midpoint)
  const sn = Math.min(s1, s0 + NEAR_AU);
  const dn = (sn - s0) / nearSteps;
  for (let k = 0; k < nearSteps; k++) sum += f(s0 + (k + 0.5) * dn) * dn;
  if (s1 > sn) {
    const sca = Math.min(Math.max(-b, sn), s1);
    const h = Math.max(Math.sqrt(Math.max(obs[0] ** 2 + obs[1] ** 2 + obs[2] ** 2 - b * b, 0)), 0.005);
    const t0 = Math.asinh((sn - sca) / h);
    const t1 = Math.asinh((s1 - sca) / h);
    const dt = (t1 - t0) / farSteps;
    for (let k = 0; k < farSteps; k++) {
      const t = t0 + (k + 0.5) * dt;
      sum += f(sca + h * Math.sinh(t)) * h * Math.cosh(t) * dt;
    }
  }
  return m.albedo * sum;
}

/** Radiance XYZS (cd/m², scotopic cd/m²) for brightness I at solar elongation eps (rad). */
export function zodiXYZS(m: ZodiParams, I: number, eps: number): XYZS {
  const t = Math.min(1, Math.max(0, ((eps * 180) / Math.PI - 30) / 60));
  return [0, 1, 2, 3].map((k) => I * ((1 - t) * m.eps30[k] + t * m.eps90[k])) as XYZS;
}

/** ICRF → heliocentric ecliptic J2000 (rotation about x by the obliquity). */
export function icrfToEcliptic(v: readonly number[]): V3 {
  const c = Math.cos(OBLIQUITY_J2000_RAD), s = Math.sin(OBLIQUITY_J2000_RAD);
  return [v[0], c * v[1] + s * v[2], -s * v[1] + c * v[2]];
}

export function eclipticToIcrf(v: readonly number[]): V3 {
  const c = Math.cos(OBLIQUITY_J2000_RAD), s = Math.sin(OBLIQUITY_J2000_RAD);
  return [v[0], c * v[1] - s * v[2], s * v[1] + c * v[2]];
}

/** Earth's heliocentric mean longitude (rad) at TDB seconds past J2000 (Standish, EM barycentre). */
export function earthMeanLongitude(et: number): number {
  const T = et / (DAYS_PER_JULIAN_CENTURY * SECONDS_PER_DAY);
  const L = EARTH_MEAN_LONGITUDE.epochDeg + EARTH_MEAN_LONGITUDE.rateDegPerCentury * T;
  return deg(((L % 360) + 360) % 360);
}

const f32 = (x: number) => {
  const s = Number(x).toPrecision(9);
  return /[.eE]/.test(s) ? s : s + '.0';
};

/**
 * WGSL: `fn zodiI(obs: vec3f, d: vec3f, earthLon: f32) -> f32` with the model's parameters as constants
 * (same quadrature as losBrightness).
 */
export function zodiacalWgsl(m: ZodiParams): string {
  const s = m.smooth;
  const bands = m.bands.map((b) => `
    {
      let q = abs(tiltZ(x, ${f32(b.i)}, ${f32(b.om)})) / r / ${f32(b.dzeta)};
      n = n + (3.0 * ${f32(b.n3)} / r) * exp(-pow(q, 6.0)) * (${f32(b.v)} + pow(q, ${f32(b.p)})) * (1.0 - exp(-pow(r / ${f32(b.dR)}, 20.0)));
    }`).join('');
  return /* wgsl */ `
fn tiltZ(x: vec3f, inc: f32, om: f32) -> f32 {
  return x.x * sin(om) * sin(inc) - x.y * cos(om) * sin(inc) + x.z * cos(inc);
}
fn zodiDensity(x: vec3f, earthLon: f32) -> f32 {
  let xp = x - vec3f(${f32(s.x0)}, ${f32(s.y0)}, ${f32(s.z0)});
  let rc = length(xp);
  let zeta = abs(tiltZ(xp, ${f32(s.i)}, ${f32(s.om)})) / rc;
  var g = zeta - ${f32(s.mu / 2)};
  if (zeta < ${f32(s.mu)}) { g = zeta * zeta / ${f32(2 * s.mu)}; }
  var n = ${f32(s.n0)} * pow(rc, ${f32(-s.alpha)}) * exp(-${f32(s.beta)} * pow(max(g, 0.0), ${f32(s.gamma)}));
  let r = length(x);${bands}
  let zr = abs(tiltZ(x, ${f32(m.ring.i)}, ${f32(m.ring.om)}));
  n = n + ${f32(m.ring.n)} * exp(-(r - ${f32(m.ring.R)}) * (r - ${f32(m.ring.R)}) / ${f32(2 * m.ring.sr ** 2)} - zr / ${f32(m.ring.sz)});
  var dth = atan2(x.y, x.x) - earthLon;
  dth = dth - 6.28318530718 * floor((dth + 3.14159265359) / 6.28318530718) - ${f32(m.blob.theta)};
  n = n + ${f32(m.blob.n)} * exp(-(r - ${f32(m.blob.R)}) * (r - ${f32(m.blob.R)}) / ${f32(2 * m.blob.sr ** 2)} - zr / ${f32(m.blob.sz)} - dth * dth / ${f32(2 * m.blob.sth ** 2)});
  return n;
}
fn zodiPhase(theta: f32) -> f32 {
  return ${f32(m.norm)} * (${f32(m.c0)} + ${f32(m.c1)} * theta + exp(${f32(m.c2)} * theta));
}
fn zodiF(obs: vec3f, d: vec3f, s: f32, earthLon: f32) -> f32 {
  let x = obs + s * d;
  let r = length(x);
  let cosT = -dot(x, d) / r;
  return zodiDensity(x, earthLon) * zodiPhase(acos(clamp(cosT, -1.0, 1.0))) / (r * r);
}
/** Scattered brightness (solar flux at 1 AU per sr) from obs (AU, helio-ecliptic) along unit d. */
fn zodiI(obs: vec3f, d: vec3f, earthLon: f32) -> f32 {
  let b = dot(obs, d);
  let c = dot(obs, obs) - ${f32(m.rOut * m.rOut)};
  let disc = b * b - c;
  if (disc <= 0.0) { return 0.0; }
  let sq = sqrt(disc);
  let s0 = max(0.0, -b - sq);
  let s1 = -b + sq;
  if (s1 <= s0) { return 0.0; }
  var sum = 0.0;
  let sn = min(s1, s0 + ${f32(NEAR_AU)});
  let dn = (sn - s0) / ${f32(NEAR_STEPS)};
  for (var k = 0u; k < ${NEAR_STEPS}u; k = k + 1u) { sum = sum + zodiF(obs, d, s0 + (f32(k) + 0.5) * dn, earthLon) * dn; }
  if (s1 > sn) {
    let sca = min(max(-b, sn), s1);
    let h = max(sqrt(max(dot(obs, obs) - b * b, 0.0)), 0.005);
    let t0 = asinh((sn - sca) / h);
    let t1 = asinh((s1 - sca) / h);
    let dt = (t1 - t0) / ${f32(FAR_STEPS)};
    for (var k = 0u; k < ${FAR_STEPS}u; k = k + 1u) {
      let t = t0 + (f32(k) + 0.5) * dt;
      sum = sum + zodiF(obs, d, sca + h * sinh(t), earthLon) * h * cosh(t) * dt;
    }
  }
  return ${f32(m.albedo)} * sum;
}
fn zodiXYZS(I: f32, eps: f32) -> vec4f {
  let t = clamp((eps * 57.2957795 - 30.0) / 60.0, 0.0, 1.0);
  let e30 = vec4f(${m.eps30.map(f32).join(', ')});
  let e90 = vec4f(${m.eps90.map(f32).join(', ')});
  return I * mix(e30, e90, t);
}
`;
}
