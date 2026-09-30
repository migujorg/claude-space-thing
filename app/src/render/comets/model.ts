// Comets as they would look: the coma, the dust tail and the ion tail in absolute light (docs/reports/comets.md).
// Pure physics (no GPU), evaluated at the comet's actual heliocentric state and the observer's position; the pipeline
// product comets/model.json carries every constant, table and source.
//
// Coma. Its total brightness is the SBDB total-magnitude law m1 = M1 + 5 log Δ + K1 log r (the same number the point
// source shows). How that light is split and spread is physics:
//   * water production from the heliocentric magnitude, log Q(H2O) = a − b (M1 + K1 log r) (Jorda et al. 2008);
//   * daughter species C2, CN, C3 and the dust (A(θ)fρ) in proportion to Q(OH): the comet's own ratios where A'Hearn
//     et al. (1995) measured them, else the population medians;
//   * gas emission bands: L = g(r)·N with N = Q·l_d/v the Haser total (g ∝ r⁻², l_d ∝ r², so L = g₁ Q l_d,1/v);
//     C2 Δv=+1 and CH as measured fractions of C2 Δv=0; [O I] 630.0/636.4 nm from the O(¹D) yield of water;
//   * dust: the rest of the V-band flux. With Afρ fixed, the 1/ρ coma that carries it has a size: the coma radius is
//     where the measured (or estimated) Afρ has accumulated that flux — R = F_dust·4r²Δ² / (Afρ·F_sun).
//   * spatial profiles: dust Σ ∝ e^{−(ρ/Re)²}/ρ (Re = 2R/√π keeps the total), gas the projected Haser distributions.
// Colour is the sum of the components' XYZS (dust = sunlight × measured reddening; gas = its band spectrum).
//
// Dust tail (Finson & Probstein 1968): grains of radiation-pressure parameter β released at t − τ with the nucleus'
// velocity move on Kepler orbits with μ(1 − β) (syndynes: fixed β; synchrones: fixed τ). A (τ, β) grid of grain
// packets carries the cross-section produced in dτ (from Afρ at the emission-time distance and the grain speeds, since
// Afρ = A·Σ Q_σ/(2v)) with the measured size distribution; each packet is a Gaussian whose width is its ejection
// speed × age (the shell of grains with that speed).
//
// Ion tail: CO+ ions (Q(CO) = x_CO Q(H2O)) carried at the solar-wind speed along the aberrated anti-solar direction
// v_sw r̂ − v_comet, each radiating the CO+ comet-tail bands.

import type { CometModelProduct, Label } from '../../data/schema';
import { keplerDrift } from '../../core/smallbody';

export type V3 = [number, number, number];
export type XYZS = [number, number, number, number];

export const AU_KM = 149597870.7;
const KM_CM = 1e5;
const DAY = 86400;

/** Composition of one comet: log10 Q(X)/Q(OH) and log10 Afρ[cm]/Q(OH) (blue continuum). */
export interface CometActivity {
  C2: number;
  CN: number;
  C3: number;
  afrho: number;
  /** measured values applied at another time: derived; population medians: estimated. */
  label: Label;
  sources: string[];
}

export interface CometInput {
  M1: number;
  K1: number;
  activity: CometActivity;
  /** Dust colour population: long-period (P > 200 yr or unbound) or short-period comets. */
  dust: 'longPeriod' | 'shortPeriod';
  /** Heliocentric ICRF state of the nucleus at emission time (km, km/s). */
  helioPos: V3;
  helioVel: V3;
  /** Heliocentric ICRF position of the observer (km). */
  observer: V3;
}

export type Profile =
  | { kind: 'dust'; reKm: number }
  | { kind: 'haser'; species: 'C2' | 'CN' | 'C3' | 'OH'; ldKm: number };

export interface ComaComponent {
  name: string;
  /** Illuminance at the observer of the whole component (lux; S scotopic lux). */
  xyzs: XYZS;
  /** Its V-band flux relative to the Sun's at 1 au. */
  v: number;
  profile: Profile;
}

export interface Coma {
  rAu: number;
  deltaKm: number;
  phaseDeg: number;
  /** Total magnitude from this observer (M1/K1 law). */
  m1: number;
  mH: number;
  qH2O: number;
  qOH: number;
  afrhoCm: number;
  /** Dust coma radius (the 1/ρ equivalent, km) and the Gaussian taper scale Re = 2R/√π. */
  radiusKm: number;
  reKm: number;
  /** Fraction of the V-band light in gas emission; gasScaled: the modelled gas exceeded gasFractionMax and was cut to it. */
  gasFractionV: number;
  gasScaled: boolean;
  total: XYZS;
  components: ComaComponent[];
  label: Label;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const addX = (a: XYZS, b: XYZS, s: number): XYZS => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s, a[3] + b[3] * s];

/** Linear interpolation in a table (clamped). */
export function interp(xs: ArrayLike<number>, ys: ArrayLike<number>, x: number): number {
  const n = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (xs[m] <= x) lo = m; else hi = m;
  }
  const t = (x - xs[lo]) / (xs[hi] - xs[lo]);
  return ys[lo] + t * (ys[hi] - ys[lo]);
}

/** Error function via the Chebyshev-fitted erfc of Numerical Recipes (Press et al. 2007, §6.2; |relative error| < 1.2e-7). */
export function erf(x: number): number {
  // Numerical Recipes erfc Chebyshev fit, fractional error < 1.2e-7 everywhere.
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 +
    t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? 1 - r : r - 1;
}

/** Composition of a comet: its measured ratios where present, the population medians elsewhere. */
export function activityOf(model: CometModelProduct, measured?: { C2?: number; CN?: number; C3?: number; afrho?: number; sources?: string[] } | null): CometActivity {
  const p = model.composition.population;
  const m = measured ?? {};
  const own = m.C2 !== undefined || m.afrho !== undefined;
  return {
    C2: m.C2 ?? p.C2.median,
    CN: m.CN ?? p.CN.median,
    C3: m.C3 ?? p.C3.median,
    afrho: m.afrho ?? p.afrho.median,
    label: own && m.afrho !== undefined ? 'derived' : 'estimated',
    sources: [...new Set([...(m.sources ?? []), ...model.composition.sources])],
  };
}

/** Phase angle (deg) at the comet between the Sun and the observer. */
export function phaseAngleDeg(helioPos: V3, observer: V3): number {
  const toSun = scale(helioPos, -1);
  const toObs = sub(observer, helioPos);
  const c = dot(toSun, toObs) / (len(toSun) * len(toObs));
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
}

/** Schleicher's composite dust phase function (normalised at 0°). */
export function dustPhase(model: CometModelProduct, phaseDeg: number): number {
  return interp(model.dustPhase.phaseDeg, model.dustPhase.value, phaseDeg);
}

/** CN fluorescence efficiency at 1 au for heliocentric radial velocity v (Swings effect; clamped to the table). */
function gCN(model: CometModelProduct, vKmS: number): number {
  return interp(model.gFactors.CN.vKmS, model.gFactors.CN.value, vKmS);
}

/** The coma as seen from input.observer (see the file header). */
export function coma(model: CometModelProduct, input: CometInput): Coma {
  const r = len(input.helioPos) / AU_KM;
  const deltaKm = len(sub(input.helioPos, input.observer));
  const deltaCm = deltaKm * KM_CM;
  const phase = phaseAngleDeg(input.helioPos, input.observer);
  const mH = input.M1 + input.K1 * Math.log10(r);
  const m1 = mH + 5 * Math.log10(deltaKm / AU_KM);
  const w = model.waterFromMagnitude;
  const qH2O = 10 ** (w.a - w.b * mH);
  const qOH = qH2O / w.qH2OPerQOH;
  const act = input.activity;
  const vGas = model.haser.velocityKmS * KM_CM;               // cm/s
  const ld = (s: 'C2' | 'CN' | 'C3' | 'OH') => model.haser.species[s].daughterKm1Au * r * r;   // km at r
  const n1 = (s: 'C2' | 'CN' | 'C3', q: number) => (q * model.haser.species[s].daughterKm1Au * KM_CM) / vGas; // Q l_d,1 / v
  const rdot = dot(input.helioPos, input.helioVel) / len(input.helioPos);
  const flux = (lErg: number) => lErg / (4 * Math.PI * deltaCm * deltaCm);   // erg cm^-2 s^-1
  const bands = model.components.bands;
  // Band luminosities (erg/s): g ∝ r^-2 and l_d ∝ r^2 cancel.
  const qC2 = qOH * 10 ** act.C2, qCN = qOH * 10 ** act.CN, qC3 = qOH * 10 ** act.C3;
  const lC2 = model.gFactors.C2 * n1('C2', qC2);
  const gas: { name: string; key: string; l: number; profile: Profile }[] = [
    { name: 'C2 Swan Δv=0', key: 'C2(0)', l: lC2, profile: { kind: 'haser', species: 'C2', ldKm: ld('C2') } },
    { name: 'C2 Swan Δv=+1', key: 'C2(1)', l: lC2 * model.bandRatiosToC2['C2(1)'].median, profile: { kind: 'haser', species: 'C2', ldKm: ld('C2') } },
    { name: 'CN violet (0-0)', key: 'CN(0)', l: gCN(model, rdot) * n1('CN', qCN), profile: { kind: 'haser', species: 'CN', ldKm: ld('CN') } },
    { name: 'C3 (4050 Å group)', key: 'C3', l: model.gFactors.C3 * n1('C3', qC3), profile: { kind: 'haser', species: 'C3', ldKm: ld('C3') } },
  ];
  if (model.bandRatiosToC2.CH) gas.push({ name: 'CH (4300 Å)', key: 'CH', l: lC2 * model.bandRatiosToC2.CH.median, profile: { kind: 'haser', species: 'C2', ldKm: ld('C2') } });
  const ox = model.oxygen;
  for (const line of ['6300', '6364'] as const) {
    gas.push({ name: `[O I] ${line} Å`, key: `OI${line}`, l: qH2O * ox.photonsPerH2O * ox.branching[line] * ox.photonEnergyErg[line], profile: { kind: 'haser', species: 'OH', ldKm: ld('OH') } });
  }
  const vTot = 10 ** (-0.4 * (m1 - model.sun.vMag));
  let vGasSum = 0;
  for (const g of gas) vGasSum += flux(g.l) * bands[g.key].v;
  const fMax = model.gasFractionMax;
  const gasScaled = vGasSum > fMax * vTot;
  const s = gasScaled ? (fMax * vTot) / vGasSum : 1;
  const components: ComaComponent[] = [];
  let total: XYZS = [0, 0, 0, 0];
  for (const g of gas) {
    const f = flux(g.l) * s;
    const b = bands[g.key];
    const xyzs: XYZS = [b.xyzs[0] * f, b.xyzs[1] * f, b.xyzs[2] * f, b.xyzs[3] * f];
    components.push({ name: g.name, xyzs, v: b.v * f, profile: g.profile });
    total = addX(total, xyzs, 1);
  }
  const dustC = model.components.dust[input.dust];
  const vDust = vTot - vGasSum * s;
  const u = vDust / dustC.v;                                   // Afρ·R / (4 r² Δ²) in the Afρ units
  const afrhoCm = qOH * 10 ** act.afrho;
  const radiusKm = (u * 4 * r * r * deltaCm * deltaCm) / afrhoCm / KM_CM;
  const reKm = (2 * radiusKm) / Math.sqrt(Math.PI);
  const dustXyzs: XYZS = [dustC.xyzs[0] * u, dustC.xyzs[1] * u, dustC.xyzs[2] * u, dustC.xyzs[3] * u];
  components.push({ name: 'dust', xyzs: dustXyzs, v: vDust, profile: { kind: 'dust', reKm } });
  total = addX(total, dustXyzs, 1);
  return {
    rAu: r, deltaKm, phaseDeg: phase, m1, mH, qH2O, qOH, afrhoCm, radiusKm, reKm,
    gasFractionV: (vGasSum * s) / vTot, gasScaled, total, components, label: 'estimated',
  };
}

/** Enclosed fraction of one component within projected radius rho (km). */
export function enclosedFraction(model: CometModelProduct, p: Profile, rhoKm: number): number {
  if (rhoKm <= 0) return 0;
  if (p.kind === 'dust') return erf(rhoKm / p.reKm);
  const t = model.haser.species[p.species];
  const lx = Math.log10(rhoKm / p.ldKm);
  if (lx <= t.log10X[0]) {
    // below the table: the projected Haser column is ~ flat-to-1/ρ; scale the first entry linearly in ρ
    return t.enclosed[0] * 10 ** (lx - t.log10X[0]);
  }
  return interp(t.log10X, t.enclosed, lx);
}

/** Illuminance (XYZS lux) of the coma within projected radius rho (km). */
export function enclosed(model: CometModelProduct, c: Coma, rhoKm: number): XYZS {
  let out: XYZS = [0, 0, 0, 0];
  for (const k of c.components) out = addX(out, k.xyzs, enclosedFraction(model, k.profile, rhoKm));
  return out;
}

/** Projected radius (km) inside which every component has at least `frac` of its light. */
export function comaExtentKm(model: CometModelProduct, c: Coma, frac = 0.999): number {
  let ext = 0;
  for (const k of c.components) {
    let lo = 1, hi = 1e9;
    for (let i = 0; i < 60; i++) {
      const mid = Math.sqrt(lo * hi);
      if (enclosedFraction(model, k.profile, mid) < frac) lo = mid; else hi = mid;
    }
    ext = Math.max(ext, hi);
  }
  return ext;
}

/** Radius (km) enclosing half of the V-band light of the coma. */
export function halfLightRadiusKm(model: CometModelProduct, c: Coma): number {
  const vOf = (rho: number) => c.components.reduce((acc, k) => acc + k.v * enclosedFraction(model, k.profile, rho), 0);
  const vt = c.components.reduce((a, k) => a + k.v, 0);
  let lo = 1e-3, hi = 1e9;
  for (let i = 0; i < 60; i++) {
    const mid = Math.sqrt(lo * hi);
    if (vOf(mid) < 0.5 * vt) lo = mid; else hi = mid;
  }
  return hi;
}

// ---- the coma on the GPU: a table of the enclosed light vs angle -------------------------------------------------

export const LUT_SIZE = 128;

export interface ComaLut {
  /** Angular radii (rad) of the first and last sample; samples are log-spaced. */
  theta0: number;
  theta1: number;
  /** LUT_SIZE × XYZS enclosed illuminance (lux) at θ_k. */
  values: Float32Array;
}

export function comaLut(model: CometModelProduct, c: Coma, extentKm: number): ComaLut {
  let inner = c.reKm;
  for (const k of c.components) if (k.profile.kind === 'haser') inner = Math.min(inner, model.haser.species[k.profile.species].parentKm1Au * c.rAu * c.rAu);
  const rho0 = Math.max(inner * 1e-4, 1e-3);
  const rho1 = Math.max(extentKm, rho0 * 10);
  const values = new Float32Array(LUT_SIZE * 4);
  for (let i = 0; i < LUT_SIZE; i++) {
    const rho = rho0 * (rho1 / rho0) ** (i / (LUT_SIZE - 1));
    values.set(enclosed(model, c, rho), i * 4);
  }
  return { theta0: rho0 / c.deltaKm, theta1: rho1 / c.deltaKm, values };
}

/** Enclosed illuminance at angular radius θ from a LUT (log-θ interpolation; linear in θ below the first sample,
 * constant beyond the last): the function the coma shader evaluates. */
export function lutEnclosed(l: ComaLut, theta: number, ch: number): number {
  const v = l.values;
  if (theta <= 0) return 0;
  if (theta <= l.theta0) return v[ch] * (theta / l.theta0);
  if (theta >= l.theta1) return v[(LUT_SIZE - 1) * 4 + ch];
  const x = (Math.log(theta / l.theta0) / Math.log(l.theta1 / l.theta0)) * (LUT_SIZE - 1);
  const i = Math.min(Math.floor(x), LUT_SIZE - 2);
  const t = x - i;
  return v[i * 4 + ch] * (1 - t) + v[(i + 1) * 4 + ch] * t;
}

/**
 * Illuminance a square cell of side a (rad) at angle theta from the nucleus receives from the coma: the enclosed light
 * between θ − a/2 and θ + a/2 shared in proportion a² / (annulus solid angle); the cell containing the nucleus takes
 * the disc of equal area.
 */
export function cellIlluminance(l: ComaLut, theta: number, a: number, ch: number): number {
  const h = 0.5 * a;
  if (theta < h) return lutEnclosed(l, a / Math.sqrt(Math.PI), ch);
  const d = lutEnclosed(l, theta + h, ch) - lutEnclosed(l, theta - h, ch);
  return (d * a * a) / (4 * Math.PI * theta * h);
}

/** Pixels closer to the nucleus than this many pixel sizes are integrated exactly over the square (NEAR_STEPS thin
 * rings, each shared by the area of the square inside it); farther out the ring through the pixel is enough. */
export const NEAR_PX = 6;
export const NEAR_STEPS = 8;

/** Area of the disc of radius rho inside the quadrant rectangle [0, x] × [0, y] (x, y ≥ 0). */
function quadrantDiscArea(x: number, y: number, rho: number): number {
  if (x <= 0 || y <= 0 || rho <= 0) return 0;
  const r2 = rho * rho;
  const xm = Math.min(x, rho);
  const u0 = Math.min(Math.sqrt(Math.max(r2 - y * y, 0)), xm);
  const S = (u: number) => 0.5 * (u * Math.sqrt(Math.max(r2 - u * u, 0)) + r2 * Math.asin(Math.min(u / rho, 1)));
  return y * u0 + S(xm) - S(u0);
}

/** Area of the disc of radius rho (centred on the origin) inside the rectangle [x0, x1] × [y0, y1]. */
export function rectDiscArea(x0: number, x1: number, y0: number, y1: number, rho: number): number {
  const F = (x: number, y: number) => Math.sign(x) * Math.sign(y) * quadrantDiscArea(Math.abs(x), Math.abs(y), rho);
  return F(x1, y1) - F(x0, y1) - F(x1, y0) + F(x0, y0);
}

/**
 * Illuminance of the pixel of solid angle omega whose centre is at tangent-plane offset (x, y) (rad, axes along the
 * pixel grid) from the nucleus. Mirrors the WGSL of shaders.ts (COMA_SHADER).
 */
export function pixelIlluminance(l: ComaLut, x: number, y: number, omega: number, ch: number): number {
  const a = Math.sqrt(omega);
  const r = Math.hypot(x, y);
  if (r >= NEAR_PX * a) return cellIlluminance(l, Math.atan(r), a, ch);
  const h = 0.5 * a;
  const x0 = x - h, x1 = x + h, y0 = y - h, y1 = y + h;
  const dx = Math.max(0, Math.abs(x) - h), dy = Math.max(0, Math.abs(y) - h);
  const rMin = Math.hypot(dx, dy);
  const rMax = Math.hypot(Math.abs(x) + h, Math.abs(y) + h);
  let e = 0;
  let rPrev = rMin, cPrev = lutEnclosed(l, rMin, ch), aPrev = rectDiscArea(x0, x1, y0, y1, rMin);
  for (let k = 1; k <= NEAR_STEPS; k++) {
    const rk = rMin + ((rMax - rMin) * k) / NEAR_STEPS;
    const ck = lutEnclosed(l, rk, ch), ak = rectDiscArea(x0, x1, y0, y1, rk);
    e += ((ck - cPrev) * (ak - aPrev)) / (Math.PI * (rk * rk - rPrev * rPrev));
    rPrev = rk; cPrev = ck; aPrev = ak;
  }
  return e;
}

// ---- dust tail -------------------------------------------------------------------------------------------------

export interface TailPacket {
  /** Heliocentric ICRF position (km). */
  pos: V3;
  /** Illuminance at the observer (lux). */
  xyzs: XYZS;
  /** Gaussian width (km, 1σ in each axis). */
  sigmaKm: number;
  /** For tests and the inspector. */
  beta: number;
  tauS: number;
}

/** Position of a zero-velocity grain of radiation-pressure parameter beta released tauS ago by a nucleus now at
 * (pos, vel): the nucleus is taken back tauS on its two-body orbit (μ), the grain forward on one with μ(1 − β). */
export function grainPosition(pos: V3, vel: V3, mu: number, beta: number, tauS: number): { pos: V3; emitPos: V3 } | null {
  const s = new Float64Array([...pos, ...vel]);
  if (keplerDrift(s, 0, -tauS, mu) !== 0) return null;
  const emitPos: V3 = [s[0], s[1], s[2]];
  const mub = mu * (1 - beta);
  if (mub > 0) {
    if (keplerDrift(s, 0, tauS, mub) !== 0) return null;
  } else {
    // β = 1: straight line
    s[0] += s[3] * tauS; s[1] += s[4] * tauS; s[2] += s[5] * tauS;
  }
  return { pos: [s[0], s[1], s[2]], emitPos };
}

/** Syndyne (fixed β) through the given ages (s): heliocentric positions. */
export function syndyne(pos: V3, vel: V3, mu: number, beta: number, tausS: number[]): V3[] {
  return tausS.map((t) => grainPosition(pos, vel, mu, beta, t)?.pos ?? [NaN, NaN, NaN]);
}

/** Synchrone (fixed age) through the given β: heliocentric positions. */
export function synchrone(pos: V3, vel: V3, mu: number, betas: number[], tauS: number): V3[] {
  return betas.map((b) => grainPosition(pos, vel, mu, b, tauS)?.pos ?? [NaN, NaN, NaN]);
}

export interface DustTailOptions {
  nTau?: number;
  nBeta?: number;
  tauMinDays?: number;
  tauMaxDays?: number;
}

/** Terminal grain speed (km/s) v0 β^γ r^Γ (Moreno & Jehin 2025, Eq. 1, zenith term averaged). */
export function grainSpeedKmS(model: CometModelProduct, beta: number, rAu: number): number {
  const e = model.grains.ejection;
  return e.v0KmS * beta ** e.gamma * rAu ** e.Gamma;
}

/** A dust packet's geometry (independent of the observer): heliocentric position, A·σ (cm²), Gaussian width. */
export interface DustPacketGeometry {
  pos: V3;
  aSigmaCm2: number;
  sigmaKm: number;
  beta: number;
  tauS: number;
}

/**
 * Dust-tail packets on a (τ, β) grid (log-spaced both): cross-section A·σ = A·Q_σ(t−τ)·Δτ·p(β)Δβ with
 * A·Q_σ = 2 Afρ / ⟨1/v⟩ (steady 1/ρ coma: Afρ = A Σ Q_σ(β) / (2 v(β))), Afρ at the emission-time distance scaled
 * with the water production (Afρ ∝ Q(OH) ∝ 10^{−b K1 log r}). Packets inside the coma radius are left to the coma.
 * Depends on the comet's state only (not on the observer): cache it per epoch.
 */
export function dustTailGeometry(model: CometModelProduct, input: Pick<CometInput, 'helioPos' | 'helioVel' | 'K1'>, c: Pick<Coma, 'afrhoCm' | 'rAu' | 'radiusKm'>, opts: DustTailOptions = {}): DustPacketGeometry[] {
  const nTau = opts.nTau ?? 48, nBeta = opts.nBeta ?? 24;
  const tau0 = (opts.tauMinDays ?? 0.25) * DAY, tau1 = (opts.tauMaxDays ?? 90) * DAY;
  const g = model.grains;
  const b0 = g.betaMin, b1 = g.betaMax;
  const k = g.crossSectionBetaExponent;
  const mu = model.sun.gmKm3S2;
  const dlnTau = Math.log(tau1 / tau0) / (nTau - 1);
  const dlnB = Math.log(b1 / b0) / (nBeta - 1);
  // normalised cross-section distribution in β: p(β) = β^k / ∫ β^k dβ; trapezoid weights in ln β
  const pnorm = k === -1 ? Math.log(b1 / b0) : (b1 ** (k + 1) - b0 ** (k + 1)) / (k + 1);
  const betas: number[] = [], pw: number[] = [];
  for (let j = 0; j < nBeta; j++) {
    const b = b0 * Math.exp(j * dlnB);
    betas.push(b);
    pw.push((b ** k / pnorm) * b * dlnB * (j === 0 || j === nBeta - 1 ? 0.5 : 1));
  }
  const bW = model.waterFromMagnitude.b;
  const out: DustPacketGeometry[] = [];
  for (let i = 0; i < nTau; i++) {
    const tau = tau0 * Math.exp(i * dlnTau);
    const dTau = tau * dlnTau * (i === 0 || i === nTau - 1 ? 0.5 : 1);
    const emit = grainPosition(input.helioPos, input.helioVel, mu, 0, tau);
    if (!emit) continue;
    const re = len(emit.emitPos) / AU_KM;
    const afrho = c.afrhoCm * 10 ** (-bW * input.K1 * (Math.log10(re) - Math.log10(c.rAu)));
    let invV = 0;
    for (let j = 0; j < nBeta; j++) invV += pw[j] / (grainSpeedKmS(model, betas[j], re) * KM_CM);
    const aQ = (2 * afrho) / invV;                 // cm^2 s^-1 (A times cross-section production)
    for (let j = 0; j < nBeta; j++) {
      const p = grainPosition(input.helioPos, input.helioVel, mu, betas[j], tau);
      if (!p) continue;
      if (len(sub(p.pos, input.helioPos)) < c.radiusKm) continue;
      const shell = grainSpeedKmS(model, betas[j], re) * tau;
      out.push({ pos: p.pos, aSigmaCm2: aQ * dTau * pw[j], sigmaKm: shell / Math.sqrt(3), beta: betas[j], tauS: tau });
    }
  }
  return out;
}

/** Light of dust packets at the observer: A·σ/(4π r² Δ²) (the Afρ·ρ/(4r²Δ²) unit of the dust component) times the
 * phase function at the packet relative to the nucleus' phase (the coma's Afρ is the one at the nucleus' phase). */
export function dustTailLight(model: CometModelProduct, geo: DustPacketGeometry[], input: Pick<CometInput, 'dust' | 'observer'>, c: Pick<Coma, 'phaseDeg'>): TailPacket[] {
  const phi0 = dustPhase(model, c.phaseDeg);
  const dust = model.components.dust[input.dust];
  return geo.map((q) => {
    const rp = len(q.pos) / AU_KM;
    const dp = len(sub(q.pos, input.observer)) * KM_CM;
    const ph = dustPhase(model, phaseAngleDeg(q.pos, input.observer)) / phi0;
    const u = (q.aSigmaCm2 / (4 * Math.PI * rp * rp * dp * dp)) * ph;   // Aσ/π = Afρ·ρ
    return { pos: q.pos, xyzs: [dust.xyzs[0] * u, dust.xyzs[1] * u, dust.xyzs[2] * u, dust.xyzs[3] * u] as XYZS, sigmaKm: q.sigmaKm, beta: q.beta, tauS: q.tauS };
  });
}

/** Both steps of the dust tail. */
export function dustTail(model: CometModelProduct, input: CometInput, c: Coma, opts: DustTailOptions = {}): TailPacket[] {
  return dustTailLight(model, dustTailGeometry(model, input, c, opts), input, c);
}

// ---- ion tail --------------------------------------------------------------------------------------------------

/** Direction of the ion tail: the solar wind as seen from the moving comet, v_sw r̂ − v_comet (unit vector). */
export function ionTailDirection(pos: V3, vel: V3, vswKmS: number): V3 {
  const rh = scale(pos, 1 / len(pos));
  const d = sub(scale(rh, vswKmS), vel);
  return scale(d, 1 / len(d));
}

export interface IonTailOptions {
  /** Drawn length, in hours of ion travel at the solar-wind speed. */
  hours?: number;
  n?: number;
}

/** Ion-tail packets: CO+ ions per unit length Q(CO+)/v_sw along the aberrated anti-solar axis, each radiating the
 * comet-tail bands at the packet's own r; width set by the coma (the ions' source region). */
export function ionTail(model: CometModelProduct, input: CometInput, c: Coma, opts: IonTailOptions = {}): TailPacket[] {
  const n = opts.n ?? 96;
  const vsw = model.solarWind.medianKmS;
  const len_ = vsw * (opts.hours ?? 24) * 3600;
  const dir = ionTailDirection(input.helioPos, input.helioVel, vsw);
  const qIon = c.qH2O * model.coPlus.coPerH2O;
  const perKm = qIon / vsw;
  const dx = len_ / n;
  const cp = model.coPlus;
  let colour: XYZS = [0, 0, 0, 0];
  for (const [band, share] of Object.entries(cp.share)) colour = addX(colour, model.components.bands[`COplus${band}`].xyzs as XYZS, share);
  const out: TailPacket[] = [];
  for (let i = 0; i < n; i++) {
    const x = (i + 0.5) * dx;
    const pos: V3 = [input.helioPos[0] + dir[0] * x, input.helioPos[1] + dir[1] * x, input.helioPos[2] + dir[2] * x];
    const rp = len(pos) / AU_KM;
    const dp = len(sub(pos, input.observer)) * KM_CM;
    const lErg = perKm * dx * cp.gTotalErgPerSIon1Au / (rp * rp);
    const f = lErg / (4 * Math.PI * dp * dp);
    const fade = i >= 0.7 * n ? (n - i) / (0.3 * n) : 1;
    out.push({ pos, xyzs: [colour[0] * f * fade, colour[1] * f * fade, colour[2] * f * fade, colour[3] * f * fade], sigmaKm: Math.max(0.5 * c.radiusKm, 0.6 * dx), beta: NaN, tauS: x / vsw });
  }
  return out;
}

/** Rough dust-tail length (km) for level-of-detail decisions: the largest β grain after the longest age. */
export function dustTailLengthKm(model: CometModelProduct, rAu: number, tauMaxDays = 90): number {
  const g = model.sun.gmKm3S2 / (rAu * AU_KM) ** 2;          // km/s^2
  const t = tauMaxDays * DAY;
  return 0.5 * model.grains.betaMax * g * t * t;
}
