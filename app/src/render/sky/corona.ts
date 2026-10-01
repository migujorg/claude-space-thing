// The solar corona from sky/corona.json (CoronaModel; pipeline sky_corona.py, docs/reports/sky.md §5), per pixel:
//
//  K-corona: Thomson scattering of the limb-darkened photosphere by coronal electrons, integrated along the line of
//   sight for the observer where it is:
//     B / B_sun = K0 / (1 − u/3) ∫ n(r, lat, P) [2((1−u)C + uD) − sin²χ ((1−u)A + uB)] ds      (s in R_sun)
//   with Minnaert's A..D of Ω = asin(1/r) and χ the angle between the radius vector and the line of sight;
//   n = (1−P)[w(lat) n_eq + (1−w) n_pole] + P c n_eq (van de Hulst 1950 laws inverted into densities, the phase P of
//   the solar cycle from the model's epochs), zero outside 1 ≤ r ≤ rMax. Quadrature: Gauss–Legendre in θ with
//   s = s_ca + p tan θ (p = impact parameter), which turns r^−k into cos^(k−2) θ, from the observer (or −θmax) to
//   θmax = acos(p / rMax). Colour: the disk-mean photospheric radiance bSun.
//  F-corona: a smooth law in the impact parameter p and the position angle ψ from the zodiacal cloud's plane of
//   symmetry, fitted to the LASCO reference map (Lamy et al. 2022), used instead of the zodiacal-light model for
//   p ≤ join[0] and blended into it up to join[1] (weight b, linear in log p). Colour: bSun × the zodiacal reddening.
//
// The same code runs on the CPU (this file: tests, probes) and on the GPU (coronaWgsl), like zodiacal.ts.

import type { CoronaModel } from '../../data/schema';
import { eclipticToIcrf, type V3, type XYZS } from './zodiacal';

export interface CoronaParams {
  eq: { k: number[]; c: number[] };
  pole: { k: number[]; c: number[] };
  cMax: number;
  /** Heliographic latitude ramp (rad): equatorial density below lat0, polar above lat1. */
  lat0: number;
  lat1: number;
  rMax: number;
  K0: number;
  u: number;
  /** Phase epochs (decimal years): previous minimum, maximum, next minimum. */
  epochs: [number, number, number];
  bSun: XYZS;
  fp: number[];
  fs: number[];
  fx: [number, number];
  join: [number, number];
  fColour: XYZS;
  /** Unit normal of the zodiacal cloud's plane of symmetry (ICRF). */
  symNormal: V3;
  /** The Sun's rotation pole (ICRF unit vector). */
  sunPole: V3;
}

const deg = (x: number) => (x * Math.PI) / 180;
const terms = (o: Record<string, number>) => {
  const e = Object.entries(o).map(([k, c]) => [Number(k), Number(c)] as const).filter(([k, c]) => Number.isFinite(k) && Number.isFinite(c));
  return { k: e.map((x) => x[0]), c: e.map((x) => x[1]) };
};

/** The Sun's pole (ICRF unit vector) from its IAU right ascension and declination (degrees). */
export function poleFromRaDec(raDeg: number, decDeg: number): V3 {
  const a = deg(raDeg), d = deg(decDeg);
  return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
}

export function parseCorona(m: CoronaModel, sunPole: V3): CoronaParams {
  const k = m.kCorona.value, f = m.fCorona.value, b = m.bSun.value;
  if (!k || !f || !b) throw new Error('corona.json: kCorona, fCorona or bSun has no value');
  const ed = k.electronDensity;
  const pl = f.symmetryPlane;
  const i = deg(pl.iDeg), om = deg(pl.OmegaDeg);
  // height above the plane = x sinΩ sin i − y cosΩ sin i + z cos i (Kelsall Eq. 5; zodiacal.ts tiltZ)
  const nEcl: V3 = [Math.sin(om) * Math.sin(i), -Math.cos(om) * Math.sin(i), Math.cos(i)];
  return {
    eq: terms(ed.equatorMin), pole: terms(ed.poleMin), cMax: ed.maxOverEquatorMin,
    lat0: deg(ed.latitudeRampDeg[0]), lat1: deg(ed.latitudeRampDeg[1]), rMax: ed.rMaxRsun,
    K0: k.thomson.K0, u: k.thomson.limbDarkeningU,
    epochs: [k.phase.minPrev.year, k.phase.max.year, k.phase.minNext.year],
    bSun: b.xyzs as XYZS,
    fp: f.law.p, fs: f.law.s, fx: f.law.xRange, join: f.joinRhoRsun, fColour: f.colourRelativeToSun as XYZS,
    symNormal: eclipticToIcrf(nEcl), sunPole,
  };
}

/** Decimal year of TDB seconds past J2000 (as the pipeline: 2000 + (days + 0.5) / 365.25). */
export const decimalYear = (et: number): number => 2000 + (et / 86400 + 0.5) / 365.25;

/** van de Hulst's (Mitchell's) phase: 0 at minimum, 1 at maximum, linear in time between. */
export function cyclePhase(p: CoronaParams, et: number): number {
  const t = decimalYear(et);
  const [a, m, b] = p.epochs;
  const x = t <= m ? (t - a) / (m - a) : 1 - (t - m) / (b - m);
  return Math.min(1, Math.max(0, x));
}

function density(p: CoronaParams, r: number, sinLat: number, P: number): number {
  if (r < 1 || r > p.rMax) return 0;
  const lr = Math.log(r);
  let ne = 0, np = 0;
  for (let j = 0; j < p.eq.k.length; j++) ne += p.eq.c[j] * Math.exp(-p.eq.k[j] * lr);
  for (let j = 0; j < p.pole.k.length; j++) np += p.pole.c[j] * Math.exp(-p.pole.k[j] * lr);
  const lat = Math.asin(Math.min(1, Math.abs(sinLat)));
  const w = Math.min(1, Math.max(0, (p.lat1 - lat) / (p.lat1 - p.lat0)));
  return (1 - P) * (w * ne + (1 - w) * np) + P * p.cMax * ne;
}

/** Thomson brightness per electron in units of (π r_e²/2) I0 at r (R_sun), sin²χ, for limb darkening u. */
export function thomsonKernel(r: number, sin2chi: number, u: number): number {
  const s = Math.min(1 / r, 1);
  const c = Math.max(Math.sqrt(Math.max(1 - s * s, 0)), 1e-6);
  const g = ((c * c) / s) * Math.log((1 + s) / c);
  const A = c * s * s;
  const C = 4 / 3 - c - (c * c * c) / 3;
  const B = -(1 - 3 * s * s - (1 + 3 * s * s) * g) / 8;
  const D = (5 + s * s - (5 - s * s) * g) / 8;
  return 2 * ((1 - u) * C + u * D) - sin2chi * ((1 - u) * A + u * B);
}

/** Gauss–Legendre nodes and weights on [−1, 1]. */
export function gaussLegendre(n: number): { x: number[]; w: number[] } {
  const x: number[] = [], w: number[] = [];
  for (let i = 1; i <= n; i++) {
    let z = Math.cos((Math.PI * (i - 0.25)) / (n + 0.5));
    let dp = 0;
    for (let it = 0; it < 100; it++) {
      let p0 = 1, p1 = 0;
      for (let j = 1; j <= n; j++) { const p2 = p1; p1 = p0; p0 = ((2 * j - 1) * z * p1 - (j - 1) * p2) / j; }
      dp = (n * (z * p0 - p1)) / (z * z - 1);
      const z1 = z;
      z = z1 - p0 / dp;
      if (Math.abs(z - z1) < 1e-15) break;
    }
    x.push(z);
    w.push(2 / ((1 - z * z) * dp * dp));
  }
  return { x, w };
}

export const K_NODES = 32;
const GL = gaussLegendre(K_NODES);

/**
 * K-corona brightness (units of B_sun) along unit ray d (ICRF) from the observer at o (ICRF, R_sun, relative to the
 * Sun's centre), at cycle phase P. 0 when the ray meets the Sun (p < 1) or passes outside rMax.
 */
export function kBrightness(p: CoronaParams, o: V3, d: V3, P: number): number {
  const sca = -(o[0] * d[0] + o[1] * d[1] + o[2] * d[2]);
  const pv: V3 = [o[0] + sca * d[0], o[1] + sca * d[1], o[2] + sca * d[2]];
  const b = Math.hypot(pv[0], pv[1], pv[2]);
  const pp = pv[0] * p.sunPole[0] + pv[1] * p.sunPole[1] + pv[2] * p.sunPole[2];
  const dp = d[0] * p.sunPole[0] + d[1] * p.sunPole[1] + d[2] * p.sunPole[2];
  let sum = 0;
  if (sca > 0) {
    // closest approach ahead: w = s − s_ca = b tan θ, from the observer (or −θmax) to θmax
    if (b < 1 || b >= p.rMax) return 0;     // b < 1: the ray meets the Sun
    const th1 = Math.acos(b / p.rMax);
    const th0 = Math.max(-th1, Math.atan2(-sca, b));
    if (th0 >= th1) return 0;
    const mid = 0.5 * (th0 + th1), half = 0.5 * (th1 - th0);
    for (let i = 0; i < K_NODES; i++) {
      const th = mid + half * GL.x[i];
      const ct = Math.cos(th);
      const r = b / ct;
      const sinLat = (pp + b * Math.tan(th) * dp) / r;
      sum += GL.w[i] * density(p, r, sinLat, P) * thomsonKernel(r, ct * ct, p.u) * (b / (ct * ct)) * half;
    }
  } else {
    // looking away from the Sun (only an observer inside rMax sees anything): w = r0 sinh v from the observer out
    const r0 = Math.hypot(o[0], o[1], o[2]);
    if (r0 >= p.rMax) return 0;
    const v0 = Math.asinh(-sca / r0), v1 = Math.asinh(Math.sqrt(Math.max(p.rMax * p.rMax - b * b, 0)) / r0);
    const mid = 0.5 * (v0 + v1), half = 0.5 * (v1 - v0);
    for (let i = 0; i < K_NODES; i++) {
      const v = mid + half * GL.x[i];
      const w = r0 * Math.sinh(v);
      const r = Math.hypot(b, w);
      const sinLat = (pp + w * dp) / r;
      sum += GL.w[i] * density(p, r, sinLat, P) * thomsonKernel(r, (b * b) / (r * r), p.u) * r0 * Math.cosh(v) * half;
    }
  }
  return (sum * p.K0) / (1 - p.u / 3);
}

/** F-corona law (units of B_sun) at impact parameter rho (R_sun), sin ψ from the plane of symmetry. */
export function fLaw(p: CoronaParams, rho: number, sinPsi: number): number {
  const x = Math.log10(rho);
  const xc = Math.min(p.fx[1], Math.max(p.fx[0], x));
  const s2 = sinPsi * sinPsi;
  let v = 0, dv = 0, sv = 0, dsv = 0;
  for (let i = 0; i < p.fp.length; i++) { v += p.fp[i] * xc ** i; if (i) dv += i * p.fp[i] * xc ** (i - 1); }
  for (let i = 0; i < p.fs.length; i++) { sv += p.fs[i] * xc ** i; if (i) dsv += i * p.fs[i] * xc ** (i - 1); }
  const slope = dv + (x > p.fx[1] ? s2 * dsv : 0);
  return 10 ** (v + s2 * sv + slope * (x - xc));
}

/**
 * F-corona near the Sun for observer o (R_sun) and ray d: [B (units of B_sun), weight b of the law against the
 * zodiacal-light model]. b = 0 (zodiacal model alone) when the closest approach is behind the observer, the
 * observer is within join[1] of the Sun, or the ray meets the Sun.
 */
export function fNear(p: CoronaParams, o: V3, d: V3): [number, number] {
  const sca = -(o[0] * d[0] + o[1] * d[1] + o[2] * d[2]);
  const D = Math.hypot(o[0], o[1], o[2]);
  if (sca <= 0 || D <= p.join[1]) return [0, 0];
  const pv: V3 = [o[0] + sca * d[0], o[1] + sca * d[1], o[2] + sca * d[2]];
  const rho = Math.hypot(pv[0], pv[1], pv[2]);
  if (rho >= p.join[1] || rho < 1) return [0, 0];
  const w = Math.min(1, Math.max(0, Math.log(p.join[1] / rho) / Math.log(p.join[1] / p.join[0])));
  const sinPsi = (pv[0] * p.symNormal[0] + pv[1] * p.symNormal[1] + pv[2] * p.symNormal[2]) / rho;
  return [fLaw(p, rho, sinPsi), w];
}

export const coronaXYZS = (p: CoronaParams, bK: number, bF: number): XYZS =>
  [0, 1, 2, 3].map((k) => p.bSun[k] * (bK + bF * p.fColour[k])) as XYZS;

const f32 = (x: number) => {
  const s = Number(x).toPrecision(9);
  return /[.eE]/.test(s) ? s : s + '.0';
};
const v3 = (v: readonly number[]) => `vec3f(${v.map(f32).join(', ')})`;
const v4 = (v: readonly number[]) => `vec4f(${v.map(f32).join(', ')})`;

/**
 * WGSL: `fn coronaK(o: vec3f, d: vec3f, P: f32) -> f32` (B / B_sun) and `fn coronaF(o: vec3f, d: vec3f) -> vec2f`
 * (B / B_sun, weight), `fn coronaRadiance(bK: f32, bF: f32) -> vec4f` (XYZS), with the model's constants inlined;
 * the same quadrature as kBrightness / fNear.
 */
export function coronaWgsl(p: CoronaParams): string {
  const sumTerms = (t: { k: number[]; c: number[] }) => t.k.map((k, j) => `${f32(t.c[j])} * exp2(${f32(-k)} * lr)`).join(' + ') || '0.0';
  const poly = (c: number[]) => c.map((ci, i) => (i === 0 ? f32(ci) : `${f32(ci)} * ${Array(i).fill('xc').join(' * ')}`)).join(' + ');
  const dpoly = (c: number[]) => c.slice(1).map((ci, j) => (j === 0 ? f32(ci) : `${f32((j + 1) * ci)} * ${Array(j).fill('xc').join(' * ')}`)).join(' + ') || '0.0';
  return /* wgsl */ `
const COR_GLX = array<f32, ${K_NODES}>(${GL.x.map(f32).join(', ')});
const COR_GLW = array<f32, ${K_NODES}>(${GL.w.map(f32).join(', ')});
fn coronaDensity(r: f32, sinLat: f32, P: f32) -> f32 {
  if (r < 1.0 || r > ${f32(p.rMax)}) { return 0.0; }
  let lr = log2(r);
  let ne = ${sumTerms({ k: p.eq.k, c: p.eq.c.map((c) => c) })};
  let np = ${sumTerms(p.pole)};
  let lat = asin(min(1.0, abs(sinLat)));
  let w = clamp((${f32(p.lat1)} - lat) / ${f32(p.lat1 - p.lat0)}, 0.0, 1.0);
  return (1.0 - P) * (w * ne + (1.0 - w) * np) + P * ${f32(p.cMax)} * ne;
}
fn thomsonKernel(r: f32, sin2chi: f32) -> f32 {
  let u = ${f32(p.u)};
  let s = min(1.0 / r, 1.0);
  let c = max(sqrt(max(1.0 - s * s, 0.0)), 1e-6);
  let g = c * c / s * log((1.0 + s) / c);
  let A = c * s * s;
  let C = ${f32(4 / 3)} - c - c * c * c / 3.0;
  let B = -(1.0 - 3.0 * s * s - (1.0 + 3.0 * s * s) * g) / 8.0;
  let D = (5.0 + s * s - (5.0 - s * s) * g) / 8.0;
  return 2.0 * ((1.0 - u) * C + u * D) - sin2chi * ((1.0 - u) * A + u * B);
}
/** K-corona, B / B_sun: observer o (R_sun from the Sun's centre, ICRF), unit ray d, cycle phase P. */
fn coronaK(o: vec3f, d: vec3f, P: f32) -> f32 {
  let sca = -dot(o, d);
  let pv = o + sca * d;
  let b = length(pv);
  let pole = ${v3(p.sunPole)};
  let pp = dot(pv, pole);
  let dp = dot(d, pole);
  var sum = 0.0;
  if (sca > 0.0) {
    // closest approach ahead: w = b tan(theta), from the observer (or -thetaMax) to thetaMax
    if (b < 1.0 || b >= ${f32(p.rMax)}) { return 0.0; }
    let th1 = acos(b / ${f32(p.rMax)});
    let th0 = max(-th1, atan2(-sca, b));
    if (th0 >= th1) { return 0.0; }
    let mid = 0.5 * (th0 + th1);
    let half = 0.5 * (th1 - th0);
    for (var i = 0u; i < ${K_NODES}u; i = i + 1u) {
      let th = mid + half * COR_GLX[i];
      let ct = cos(th);
      let r = b / ct;
      let sinLat = (pp + b * tan(th) * dp) / r;
      sum = sum + COR_GLW[i] * coronaDensity(r, sinLat, P) * thomsonKernel(r, ct * ct) * (b / (ct * ct)) * half;
    }
  } else {
    // looking away from the Sun (only an observer inside rMax sees anything): w = r0 sinh(v) from the observer out
    let r0 = length(o);
    if (r0 >= ${f32(p.rMax)}) { return 0.0; }
    let v0 = asinh(-sca / r0);
    let v1 = asinh(sqrt(max(${f32(p.rMax * p.rMax)} - b * b, 0.0)) / r0);
    let mid = 0.5 * (v0 + v1);
    let half = 0.5 * (v1 - v0);
    for (var i = 0u; i < ${K_NODES}u; i = i + 1u) {
      let v = mid + half * COR_GLX[i];
      let w = r0 * sinh(v);
      let r = sqrt(b * b + w * w);
      let sinLat = (pp + w * dp) / r;
      sum = sum + COR_GLW[i] * coronaDensity(r, sinLat, P) * thomsonKernel(r, b * b / (r * r)) * r0 * cosh(v) * half;
    }
  }
  return sum * ${f32(p.K0 / (1 - p.u / 3))};
}
fn coronaFLaw(rho: f32, sinPsi: f32) -> f32 {
  let x = log2(rho) * 0.301029996;
  let xc = clamp(x, ${f32(p.fx[0])}, ${f32(p.fx[1])});
  let s2 = sinPsi * sinPsi;
  let v = ${poly(p.fp)} + s2 * (${poly(p.fs)});
  var slope = ${dpoly(p.fp)};
  if (x > ${f32(p.fx[1])}) { slope = slope + s2 * (${dpoly(p.fs)}); }
  return exp2((v + slope * (x - xc)) * 3.321928095);
}
/** F-corona near the Sun: (B / B_sun, weight of the law against the zodiacal-light model). */
fn coronaF(o: vec3f, d: vec3f) -> vec2f {
  let sca = -dot(o, d);
  if (sca <= 0.0 || length(o) <= ${f32(p.join[1])}) { return vec2f(0.0); }
  let pv = o + sca * d;
  let rho = length(pv);
  if (rho >= ${f32(p.join[1])} || rho < 1.0) { return vec2f(0.0); }
  let w = clamp(log(${f32(p.join[1])} / rho) / ${f32(Math.log(p.join[1] / p.join[0]))}, 0.0, 1.0);
  let sinPsi = dot(pv, ${v3(p.symNormal)}) / rho;
  return vec2f(coronaFLaw(rho, sinPsi), w);
}
fn coronaRadiance(bK: f32, bF: f32) -> vec4f {
  return ${v4(p.bSun)} * (bK + bF * ${v4(p.fColour)});
}
`;
}
