// Float64 CPU reference propagator for asteroids and comets: the ground truth the GPU implementation is tested
// against. It is the same scheme as the pipeline's integrator (pipeline/src/pipeline/sb_dynamics.py), and every
// constant it uses (GMs, radii, splitting coefficients, step-control parameters, the Earth J2 term) comes from the
// `forceModel` block of the small-body product header (smallbodies/core.json), never from this file.
//
// Units: km, s, km^3/s^2. States are heliocentric ICRF (SPICE J2000): [x, y, z, vx, vy, vz].
//
// Scheme (see forceModel for the exact numbers):
//   * Kepler drift about the Sun in universal variables (Stumpff c2, c3; Laguerre–Conway iteration), valid for
//     every eccentricity: elliptic, parabolic, hyperbolic.
//   * Kicks: planets + Moon + Pluto direct and indirect terms (positions from the EphemerisSet, i.e. DE442s),
//     Earth J2, solar 1PN relativity, and the fitted non-gravitational acceleration where an object has one.
//   * Composition SABA_n (Laskar & Robutel 2001): drift c0·h, kick d0·h, drift c1·h, …, drift c_last·h.
//   * Encounter mode: when a planet's pull reaches stepControl.encounterRatio × the Sun's during a step, that
//     step's substeps are classical RK4 steps on the full acceleration instead (the Sun-centred split is poor there).
//   * Steps end on the grid epochEt + m·baseStep (first/last may be partial); each step of length h is split into
//     2^level equal substeps, level chosen from the state at the start of the step (stepControl rule).
//
// References: Danby (1988) Fundamentals of Celestial Mechanics §6.9 (universal variables); Conway (1986) Celest.
// Mech. 39, 199 (Laguerre); Wisdom & Holman (1991) AJ 102, 1528; Laskar & Robutel (2001) CMDA 80, 39; IERS
// Conventions (2010) Eq. 10.12 (1PN); Marsden, Sekanina & Yeomans (1973) AJ 78, 211 (non-gravitational g(r)).

import type { SmallBodyForceModel } from '../data/schema';
import type { Vec3 } from './vec';

export type { SmallBodyForceModel };

/** What the propagator needs from an ephemeris (EphemerisSet satisfies it): SSB positions by NAIF id, km. */
export interface PlanetPositions {
  positionSSB(id: number, et: number): Vec3 | null;
}

/** Translate the catalogue Newtonian law to a system-barycentric origin. Internal moon mass is already
 * in the host GM; never double-count the host or transplant solar 1PN / Earth J2 to a different origin. */
export function hostForceModel(base: SmallBodyForceModel, hostId: number, hostGm: number): SmallBodyForceModel {
  const host = base.perturbers.find(p => p.naifId === hostId);
  if (!host || host.gm !== hostGm) throw new Error('host force model requires the sourced system GM');
  return { ...base, frame: `host ${hostId} system-barycentric ICRF, km and s`,
    sun: { ...host, sources:base.sun.sources }, perturbers: [{ ...base.sun, name:'Sun' }, ...base.perturbers.filter(p => p.naifId !== hostId)],
    relativity: { ...base.relativity, enabled: false }, zonal: { ...base.zonal, perturber: null },
    nonGravitational: 'none: synthetic irregular moons are massless test particles' };
}

/** Host batches subtract nearly equal external accelerations (moon distance << solar distance).
 * Catalogue batches drift about the Sun; it is not an external perturber, so there is no
 * direct-minus-indirect solar kick to cancel. The old arithmetic is a named diagnostic only. */
export function stableDifferential(model: SmallBodyForceModel, diagnosticForceVariant?: 'baseline' | 'tidal'): boolean {
  return diagnosticForceVariant ? diagnosticForceVariant === 'tidal' : model.sun.naifId !== 10;
}

export const SB_OK = 0;
/** Passed inside a perturber's (or the Sun's) radius: later positions are meaningless. */
export const SB_COLLIDED = 1;
/** A kick time fell outside the loaded planetary ephemeris. */
export const SB_NO_EPHEMERIS = 2;
/** The universal Kepler equation did not converge (non-physical state). */
export const SB_NO_CONVERGENCE = 3;

/** Non-gravitational parameters of one object (SBDB model_pars converted to km, s). */
export interface NonGrav {
  a1: number; // km/s^2
  a2: number;
  a3: number;
  dt: number; // s (delay DT)
  aln: number;
  r0: number; // km
  nm: number;
  nn: number;
  nk: number;
}

/** Osculating heliocentric elements referred to the ecliptic and equinox J2000 (SBDB convention). */
export interface OsculatingElements {
  /** Perihelion distance, km. */
  q: number;
  e: number;
  /** Inclination, ascending node, argument of perihelion: radians. */
  i: number;
  node: number;
  peri: number;
  /** Time since perihelion passage at the epoch, s (for e < 1: M/n with M reduced to (−π, π]). */
  dtPeri: number;
}

const LAGUERRE_N = 5;
const MAX_ITER = 60;
const INV_FACT: number[] = (() => {
  const f = [1];
  for (let k = 1; k < 28; k++) f.push(f[k - 1] / k);
  return f;
})();

/** Stumpff c2(z), c3(z) (and hyperbolic continuations): series for |z| < 1, closed forms elsewhere. */
export function stumpff(z: number): [number, number] {
  if (Math.abs(z) < 1) {
    let c2 = 0;
    let c3 = 0;
    for (let k = 12; k >= 0; k--) {
      c2 = c2 * -z + INV_FACT[2 * k + 2];
      c3 = c3 * -z + INV_FACT[2 * k + 3];
    }
    return [c2, c3];
  }
  if (z > 0) {
    const x = Math.sqrt(z);
    const h = Math.sin(0.5 * x) / (0.5 * x);
    return [0.5 * h * h, (x - Math.sin(x)) / (x * z)];
  }
  const x = Math.sqrt(-z);
  const h = Math.sinh(0.5 * x) / (0.5 * x);
  return [0.5 * h * h, (Math.sinh(x) - x) / (x * -z)];
}

/** Solve r0·G1 + η·G2 + μ·G3 = dt for the universal anomaly s; returns NaN if it does not converge. */
export function solveUniversal(r0: number, eta: number, beta: number, mu: number, dt: number, s: number): number {
  for (let it = 0; it < MAX_ITER; it++) {
    const z = beta * s * s;
    const [c2, c3] = stumpff(z);
    const g1 = s * (1 - z * c3);
    const g2 = s * s * c2;
    const g3 = s * s * s * c3;
    const g0 = 1 - z * c2;
    const f = r0 * g1 + eta * g2 + mu * g3 - dt;
    const fp = r0 * g0 + eta * g1 + mu * g2;
    const fpp = eta * g0 + (mu - beta * r0) * g1;
    const disc = (LAGUERRE_N - 1) ** 2 * fp * fp - LAGUERRE_N * (LAGUERRE_N - 1) * f * fpp;
    const den = fp + Math.sign(fp || 1) * Math.sqrt(Math.abs(disc));
    const ds = (LAGUERRE_N * f) / den;
    s -= ds;
    if (Math.abs(ds) <= 1e-12 * Math.abs(s) || ds === 0) return s; // cubic convergence: the applied step leaves rounding error
  }
  return NaN;
}

/**
 * Two-body (Sun only) drift of state s (offset o, 6 numbers) by dt, in place. `sGuess` NaN → first-order guess.
 * Returns SB_OK or SB_NO_CONVERGENCE.
 */
export function keplerDrift(st: Float64Array | number[], o: number, dt: number, mu: number, sGuess = NaN): number {
  const x0 = st[o], x1 = st[o + 1], x2 = st[o + 2];
  const v0 = st[o + 3], v1 = st[o + 4], v2 = st[o + 5];
  const r0 = Math.sqrt(x0 * x0 + x1 * x1 + x2 * x2);
  const eta = x0 * v0 + x1 * v1 + x2 * v2;
  const vv = v0 * v0 + v1 * v1 + v2 * v2;
  const beta = (2 * mu) / r0 - vv;
  let s0 = sGuess;
  if (s0 !== s0) s0 = dt / r0 - (eta * dt * dt) / (2 * r0 * r0 * r0);
  const s = solveUniversal(r0, eta, beta, mu, dt, s0);
  if (s !== s) return SB_NO_CONVERGENCE;
  const z = beta * s * s;
  const [c2, c3] = stumpff(z);
  const g1 = s * (1 - z * c3);
  const g2 = s * s * c2;
  const g0 = 1 - z * c2;
  const r = r0 * g0 + eta * g1 + mu * g2;
  const fm1 = (-mu * g2) / r0;
  const g = r0 * g1 + eta * g2;
  const fd = (-mu * g1) / (r * r0);
  const gdm1 = (-mu * g2) / r;
  st[o] = x0 + (fm1 * x0 + g * v0);
  st[o + 1] = x1 + (fm1 * x1 + g * v1);
  st[o + 2] = x2 + (fm1 * x2 + g * v2);
  st[o + 3] = v0 + (fd * x0 + gdm1 * v0);
  st[o + 4] = v1 + (fd * x1 + gdm1 * v1);
  st[o + 5] = v2 + (fd * x2 + gdm1 * v2);
  return SB_OK;
}

function keplerE(M: number, e: number): number {
  let E = M + 0.85 * e * (Math.sin(M) >= 0 ? 1 : -1);
  for (let k = 0; k < 100; k++) {
    const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-15) break;
  }
  return E;
}

function keplerF(Mh: number, e: number): number {
  let F = Math.asinh(Mh / e);
  for (let k = 0; k < 200; k++) {
    const d = (e * Math.sinh(F) - F - Mh) / (e * Math.cosh(F) - 1);
    F -= d;
    if (Math.abs(d) <= 1e-15 * Math.max(1, Math.abs(F))) break;
  }
  return F;
}

/**
 * Heliocentric ICRF state from ecliptic-J2000 osculating elements: the perihelion state drifted by dtPeri along the
 * universal-variable orbit (one path for all eccentricities), then rotated about x by the obliquity (radians).
 * Returns [x, y, z, vx, vy, vz] or null if the Kepler solve fails.
 */
export function elementsToState(el: OsculatingElements, mu: number, obliquity: number): Float64Array | null {
  const { q, e, i, node, peri, dtPeri } = el;
  const cO = Math.cos(node), sO = Math.sin(node);
  const cw = Math.cos(peri), sw = Math.sin(peri);
  const ci = Math.cos(i), si = Math.sin(i);
  const P = [cO * cw - sO * sw * ci, sO * cw + cO * sw * ci, sw * si];
  const Q = [-cO * sw - sO * cw * ci, -sO * sw + cO * cw * ci, cw * si];
  const vp = Math.sqrt((mu * (1 + e)) / q);
  const st = new Float64Array([q * P[0], q * P[1], q * P[2], vp * Q[0], vp * Q[1], vp * Q[2]]);
  const beta = (mu * (1 - e)) / q;
  let s0: number;
  if (e < 1) {
    const n = Math.sqrt(beta * beta * beta) / mu;
    s0 = keplerE(n * dtPeri, e) / Math.sqrt(beta);
  } else if (e > 1) {
    const n = Math.sqrt((-beta) ** 3) / mu;
    s0 = keplerF(n * dtPeri, e) / Math.sqrt(-beta);
  } else {
    const p = (6 * q) / mu;
    const qq = (-6 * dtPeri) / mu;
    const d = Math.sqrt((qq * qq) / 4 + (p * p * p) / 27);
    s0 = Math.cbrt(-qq / 2 + d) + Math.cbrt(-qq / 2 - d);
  }
  if (keplerDrift(st, 0, dtPeri, mu, s0) !== SB_OK) return null;
  const ce = Math.cos(obliquity), se = Math.sin(obliquity);
  return new Float64Array([
    st[0], ce * st[1] - se * st[2], se * st[1] + ce * st[2],
    st[3], ce * st[4] - se * st[5], se * st[4] + ce * st[5],
  ]);
}

/** Time since perihelion (s) from SBDB-style elements: M/n for e < 1 with M reduced to (−π, π], else epoch − tp. */
export function timeSincePerihelion(qKm: number, e: number, meanAnomalyRad: number | null, epochMinusTpS: number | null, mu: number): number {
  if (e < 1 && meanAnomalyRad !== null && Number.isFinite(meanAnomalyRad)) {
    let M = meanAnomalyRad % (2 * Math.PI);
    if (M > Math.PI) M -= 2 * Math.PI;
    if (M <= -Math.PI) M += 2 * Math.PI;
    const n = Math.sqrt((mu * (1 - e) ** 3) / (qKm * qKm * qKm));
    return M / n;
  }
  if (epochMinusTpS === null) throw new Error('timeSincePerihelion: e >= 1 needs epoch − tp');
  return epochMinusTpS;
}

/** End of the next step from t toward t1 on the grid grid0 + m·H (H > 0). */
export function nextBoundary(t: number, t1: number, grid0: number, H: number): number {
  if (t1 > t) {
    const m = Math.floor((t - grid0) / H);
    let g = grid0 + (m + 1) * H;
    if (g <= t) g += H;
    return Math.min(g, t1);
  }
  const m = Math.ceil((t - grid0) / H);
  let g = grid0 + (m - 1) * H;
  if (g >= t) g -= H;
  return Math.max(g, t1);
}

export interface PropagationStats {
  /** Substeps taken. */
  substeps: number;
  /** Highest substep level used. */
  maxLevel: number;
  /** Substeps taken in encounter (RK4) mode. */
  encounterSubsteps: number;
}

/**
 * The propagator bound to a force model and an ephemeris (e.g. an EphemerisSet). Heliocentric perturber positions
 * come from `eph.positionSSB(id) − eph.positionSSB(sun)`.
 */
export class SmallBodyPropagator {
  readonly model: SmallBodyForceModel;
  readonly eph: PlanetPositions;
  readonly mu: number;
  readonly obliquity: number;
  private readonly ids: number[];
  private readonly gm: Float64Array;
  private readonly radius: Float64Array;
  private readonly sunRadius: number;
  private readonly drift: number[];
  private readonly kick: number[];
  private readonly c2inv: number;
  private readonly j2Index: number;
  private readonly j2: number;
  private readonly j2R: number;
  private readonly pole: [number, number, number];
  private readonly stableDifferential: boolean;
  private readonly rp: Float64Array;
  private readonly rpe: Float64Array;
  private readonly a = new Float64Array(3);

  constructor(model: SmallBodyForceModel, eph: PlanetPositions, diagnosticForceVariant?: 'baseline' | 'tidal') {
    this.stableDifferential = stableDifferential(model, diagnosticForceVariant);
    this.model = model;
    this.eph = eph;
    this.mu = model.sun.gm;
    this.obliquity = (model.obliquityArcsec / 3600) * (Math.PI / 180);
    this.ids = model.perturbers.map((p) => p.naifId);
    this.gm = Float64Array.from(model.perturbers, (p) => p.gm);
    this.radius = Float64Array.from(model.perturbers, (p) => p.radius);
    this.sunRadius = model.sun.radius;
    this.drift = model.scheme.drift;
    this.kick = model.scheme.kick;
    if (this.drift.length !== this.kick.length + 1) throw new Error('forceModel.scheme: need one more drift than kicks');
    this.c2inv = model.relativity.enabled ? 1 / (model.relativity.cKmS * model.relativity.cKmS) : 0;
    this.j2Index = model.zonal.perturber === null ? -1 : this.ids.indexOf(model.zonal.perturber);
    this.j2 = model.zonal.j2;
    this.j2R = model.zonal.referenceRadiusKm;
    this.pole = model.zonal.poleIcrf;
    this.rp = new Float64Array(this.ids.length * 3);
    this.rpe = new Float64Array(this.ids.length * 3);
  }

  /** Heliocentric perturber positions at t into rp (3 per perturber); false if the ephemeris does not cover t. */
  perturberPositions(t: number, rp: Float64Array = this.rp): boolean {
    const sun = this.eph.positionSSB(this.model.sun.naifId, t);
    if (!sun) return false;
    for (let p = 0; p < this.ids.length; p++) {
      const x = this.eph.positionSSB(this.ids[p], t);
      if (!x) return false;
      rp[3 * p] = x[0] - sun[0];
      rp[3 * p + 1] = x[1] - sun[1];
      rp[3 * p + 2] = x[2] - sun[2];
    }
    return true;
  }

  /** Kick acceleration (everything but the solar Kepler term) at state st[o..o+5] with perturbers rp. */
  acceleration(st: Float64Array | number[], o: number, rp: Float64Array, ng: NonGrav | null, a: Float64Array): void {
    const x0 = st[o], x1 = st[o + 1], x2 = st[o + 2];
    const v0 = st[o + 3], v1 = st[o + 4], v2 = st[o + 5];
    let a0 = 0, a1 = 0, a2 = 0;
    const np = this.ids.length;
    for (let p = 0; p < np; p++) {
      const px = rp[3 * p], py = rp[3 * p + 1], pz = rp[3 * p + 2];
      const dx = px - x0, dy = py - x1, dz = pz - x2;
      const d2 = dx * dx + dy * dy + dz * dz;
      const d3 = d2 * Math.sqrt(d2);
      const rp2 = px * px + py * py + pz * pz;
      const rp3 = rp2 * Math.sqrt(rp2);
      const g = this.gm[p];
      const q = (x0*x0 + x1*x1 + x2*x2 - 2*(px*x0 + py*x1 + pz*x2)) / rp2;
      if (this.stableDifferential && Math.abs(q) < 0.5) {
        const w = 1 + q, A = w * Math.sqrt(w);
        const f = -q * (3 + q * (3 + q)) / (A * (1 + A));
        const scale = g / rp3;
        a0 += scale * (f * px - (1 + f) * x0);
        a1 += scale * (f * py - (1 + f) * x1);
        a2 += scale * (f * pz - (1 + f) * x2);
      } else {
        // Near an external perturber q approaches -1: retain the direct separation.
        a0 += g * (dx / d3 - px / rp3);
        a1 += g * (dy / d3 - py / rp3);
        a2 += g * (dz / d3 - pz / rp3);
      }
    }
    const jp = this.j2Index;
    if (jp >= 0) {
      const dx = x0 - rp[3 * jp], dy = x1 - rp[3 * jp + 1], dz = x2 - rp[3 * jp + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      const [kx, ky, kz] = this.pole;
      const z = dx * kx + dy * ky + dz * kz;
      const f = (-1.5 * this.j2 * this.gm[jp] * this.j2R * this.j2R) / (d2 * d2 * Math.sqrt(d2));
      const c = 1 - (5 * z * z) / d2;
      a0 += f * (c * dx + 2 * z * kx);
      a1 += f * (c * dy + 2 * z * ky);
      a2 += f * (c * dz + 2 * z * kz);
    }
    const r2 = x0 * x0 + x1 * x1 + x2 * x2;
    const r = Math.sqrt(r2);
    if (this.c2inv !== 0) {
      const vv = v0 * v0 + v1 * v1 + v2 * v2;
      const rv = x0 * v0 + x1 * v1 + x2 * v2;
      const k = (this.mu * this.c2inv) / (r2 * r);
      const c1 = (4 * this.mu) / r - vv;
      const c4 = 4 * rv;
      a0 += k * (c1 * x0 + c4 * v0);
      a1 += k * (c1 * x1 + c4 * v1);
      a2 += k * (c1 * x2 + c4 * v2);
    }
    if (ng) {
      let rr = r;
      if (ng.dt !== 0) {
        const d = [x0, x1, x2, v0, v1, v2];
        if (keplerDrift(d, 0, -ng.dt, this.mu) === SB_OK) rr = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
      }
      const u = rr / ng.r0;
      const g = ng.aln * u ** -ng.nm * (1 + u ** ng.nn) ** -ng.nk;
      const hx = x1 * v2 - x2 * v1, hy = x2 * v0 - x0 * v2, hz = x0 * v1 - x1 * v0;
      const hn = Math.sqrt(hx * hx + hy * hy + hz * hz);
      const nx = hx / hn, ny = hy / hn, nz = hz / hn;
      const ux = x0 / r, uy = x1 / r, uz = x2 / r;
      const tx = ny * uz - nz * uy, ty = nz * ux - nx * uz, tz = nx * uy - ny * ux;
      a0 += g * (ng.a1 * ux + ng.a2 * tx + ng.a3 * nx);
      a1 += g * (ng.a1 * uy + ng.a2 * ty + ng.a3 * ny);
      a2 += g * (ng.a1 * uz + ng.a2 * tz + ng.a3 * nz);
    }
    a[0] = a0;
    a[1] = a1;
    a[2] = a2;
  }

  /**
   * Substep level for a step of signed length h from state st[o..], with perturber positions rp at the step's start
   * and rpe at its end (forceModel.stepControl), and the dominance ratio max_p (GM_p/d_min²)/(GM_sun/r²).
   */
  substepLevel(st: Float64Array | number[], o: number, h: number, rp: Float64Array, rpe: Float64Array): { level: number; dominance: number } {
    const { etaSun, etaPlanet, etaEncounter, encounterRatio, kmax } = this.model.stepControl;
    const mu = this.mu;
    const hAbs = Math.abs(h);
    const x0 = st[o], x1 = st[o + 1], x2 = st[o + 2];
    const v0 = st[o + 3], v1 = st[o + 4], v2 = st[o + 5];
    const r = Math.sqrt(x0 * x0 + x1 * x1 + x2 * x2);
    const vn = Math.sqrt(v0 * v0 + v1 * v1 + v2 * v2);
    const hx = x1 * v2 - x2 * v1, hy = x2 * v0 - x0 * v2, hz = x0 * v1 - x1 * v0;
    const h2 = hx * hx + hy * hy + hz * hz;
    const rv = x0 * v0 + x1 * v1 + x2 * v2;
    const k1 = vn * vn - mu / r;
    const ex = (k1 * x0 - rv * v0) / mu, ey = (k1 * x1 - rv * v1) / mu, ez = (k1 * x2 - rv * v2) / mu;
    const ecc = Math.sqrt(ex * ex + ey * ey + ez * ez);
    const q = h2 / mu / (1 + ecc);
    const rEff = Math.max(q, r - vn * hAbs);
    const tauSun = Math.sqrt((rEff * rEff * rEff) / mu);
    let hmax = etaSun * tauSun;
    const lo = Math.min(0, h), hi = Math.max(0, h);
    const aSun = mu / (r * r);
    let dom = 0;
    for (let p = 0; p < this.ids.length; p++) {
      const dx = rp[3 * p] - x0, dy = rp[3 * p + 1] - x1, dz = rp[3 * p + 2] - x2;
      const ux = (rpe[3 * p] - rp[3 * p]) / h - v0;
      const uy = (rpe[3 * p + 1] - rp[3 * p + 1]) / h - v1;
      const uz = (rpe[3 * p + 2] - rp[3 * p + 2]) / h - v2;
      const u2 = ux * ux + uy * uy + uz * uz;
      let tc = 0;
      if (u2 > 0) tc = Math.min(Math.max(-(dx * ux + dy * uy + dz * uz) / u2, lo), hi);
      const cx = dx + ux * tc, cy = dy + uy * tc, cz = dz + uz * tc;
      const dMin = Math.max(Math.sqrt(cx * cx + cy * cy + cz * cz), this.radius[p]);
      let tau = Math.sqrt((dMin * dMin * dMin) / this.gm[p]);
      if (u2 > 0) tau = Math.min(tau, dMin / Math.sqrt(u2));
      const dp = this.gm[p] / (dMin * dMin) / aSun;
      hmax = Math.min(hmax, (dp > encounterRatio ? etaEncounter : etaPlanet) * tau);
      dom = Math.max(dom, dp);
    }
    // Encounter mode integrates the full equations with RK4, which also has to resolve the solar orbit.
    if (dom > encounterRatio) hmax = Math.min(hmax, etaEncounter * tauSun);
    if (hAbs <= hmax) return { level: 0, dominance: dom };
    const lvl = Math.ceil(Math.log2(hAbs / hmax));
    return { level: Math.min(Math.max(lvl, 0), kmax), dominance: dom };
  }

  /** Full heliocentric acceleration (Sun + kick terms) at state s (6 numbers) and time t into a; status code. */
  private totalAccel(s: Float64Array, t: number, ng: NonGrav | null, a: Float64Array): number {
    const rp = this.rp;
    if (!this.perturberPositions(t, rp)) return SB_NO_EPHEMERIS;
    const r2 = s[0] * s[0] + s[1] * s[1] + s[2] * s[2];
    if (r2 < this.sunRadius * this.sunRadius) return SB_COLLIDED;
    for (let p = 0; p < this.ids.length; p++) {
      const dx = rp[3 * p] - s[0], dy = rp[3 * p + 1] - s[1], dz = rp[3 * p + 2] - s[2];
      if (dx * dx + dy * dy + dz * dz < this.radius[p] * this.radius[p]) return SB_COLLIDED;
    }
    this.acceleration(s, 0, rp, ng, a);
    const k = -this.mu / (r2 * Math.sqrt(r2));
    a[0] += k * s[0];
    a[1] += k * s[1];
    a[2] += k * s[2];
    return SB_OK;
  }

  /** Classical RK4 step on the full equations (encounter mode), state st[o..o+5] in place. */
  rk4Step(st: Float64Array | number[], o: number, t: number, h: number, ng: NonGrav | null): number {
    const y = Float64Array.from({ length: 6 }, (_, j) => st[o + j]);
    const s = new Float64Array(6);
    const k1 = new Float64Array(3), k2 = new Float64Array(3), k3 = new Float64Array(3), k4 = new Float64Array(3);
    let r = this.totalAccel(y, t, ng, k1);
    if (r !== SB_OK) return r;
    for (let j = 0; j < 3; j++) {
      s[j] = y[j] + 0.5 * h * y[3 + j];
      s[3 + j] = y[3 + j] + 0.5 * h * k1[j];
    }
    const k2x = s.slice(3, 6);
    r = this.totalAccel(s, t + 0.5 * h, ng, k2);
    if (r !== SB_OK) return r;
    for (let j = 0; j < 3; j++) {
      s[j] = y[j] + 0.5 * h * k2x[j];
      s[3 + j] = y[3 + j] + 0.5 * h * k2[j];
    }
    const k3x = s.slice(3, 6);
    r = this.totalAccel(s, t + 0.5 * h, ng, k3);
    if (r !== SB_OK) return r;
    for (let j = 0; j < 3; j++) {
      s[j] = y[j] + h * k3x[j];
      s[3 + j] = y[3 + j] + h * k3[j];
    }
    const k4x = s.slice(3, 6);
    r = this.totalAccel(s, t + h, ng, k4);
    if (r !== SB_OK) return r;
    for (let j = 0; j < 3; j++) {
      st[o + j] = y[j] + (h / 6) * (y[3 + j] + 2 * k2x[j] + 2 * k3x[j] + k4x[j]);
      st[o + 3 + j] = y[3 + j] + (h / 6) * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]);
    }
    return SB_OK;
  }

  /** One SABA step of length h from time t (state in place). */
  sabaStep(st: Float64Array | number[], o: number, t: number, h: number, ng: NonGrav | null): number {
    const rp = this.rp;
    const a = this.a;
    const nk = this.kick.length;
    let tc = t;
    for (let i = 0; i <= nk; i++) {
      const dt = this.drift[i] * h;
      if (dt !== 0 && keplerDrift(st, o, dt, this.mu) !== SB_OK) return SB_NO_CONVERGENCE;
      tc += dt;
      if (i === nk) break;
      if (!this.perturberPositions(tc, rp)) return SB_NO_EPHEMERIS;
      const x0 = st[o], x1 = st[o + 1], x2 = st[o + 2];
      if (x0 * x0 + x1 * x1 + x2 * x2 < this.sunRadius * this.sunRadius) return SB_COLLIDED;
      for (let p = 0; p < this.ids.length; p++) {
        const dx = rp[3 * p] - x0, dy = rp[3 * p + 1] - x1, dz = rp[3 * p + 2] - x2;
        if (dx * dx + dy * dy + dz * dz < this.radius[p] * this.radius[p]) return SB_COLLIDED;
      }
      this.acceleration(st, o, rp, ng, a);
      const k = this.kick[i] * h;
      st[o + 3] += k * a[0];
      st[o + 4] += k * a[1];
      st[o + 5] += k * a[2];
    }
    return SB_OK;
  }

  /**
   * Propagate one state (st[o..o+5], in place) from t0 to t1 on the grid grid0 + m·baseStep. grid0 is the product's
   * common epoch (header epochEt). Returns a status code; stats (optional) accumulates substeps and max level.
   */
  propagateOne(st: Float64Array | number[], o: number, t0: number, t1: number, grid0: number, ng: NonGrav | null = null, stats?: PropagationStats): number {
    const H = this.model.grid.baseStepS;
    const rp = this.rp;
    const rpe = this.rpe;
    let t = t0;
    while (t !== t1) {
      const te = nextBoundary(t, t1, grid0, H);
      const h = te - t;
      if (!this.perturberPositions(t, rp)) return SB_NO_EPHEMERIS;
      if (!this.perturberPositions(te, rpe)) return SB_NO_EPHEMERIS;
      const { level: lvl, dominance } = this.substepLevel(st, o, h, rp, rpe);
      const nsub = 1 << lvl;
      const hs = h / nsub;
      const enc = dominance > this.model.stepControl.encounterRatio;
      for (let j = 0; j < nsub; j++) {
        const s = enc ? this.rk4Step(st, o, t + j * hs, hs, ng) : this.sabaStep(st, o, t + j * hs, hs, ng);
        if (s !== SB_OK) return s;
      }
      if (stats) {
        stats.substeps += nsub;
        if (lvl > stats.maxLevel) stats.maxLevel = lvl;
        if (enc) stats.encounterSubsteps += nsub;
      }
      t = te;
    }
    return SB_OK;
  }

  /**
   * Propagate many states (6 numbers each, in place) from the common epoch t0 (= grid0) to et. Objects whose
   * propagation fails are set to NaN; their status codes are returned.
   */
  propagate(states: Float64Array, t0: number, et: number, grid0 = t0, ng: (NonGrav | null)[] | null = null): Uint8Array {
    const n = states.length / 6;
    const status = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const s = this.propagateOne(states, 6 * i, t0, et, grid0, ng?.[i] ?? null);
      status[i] = s;
      if (s !== SB_OK) states.fill(NaN, 6 * i, 6 * i + 6);
    }
    return status;
  }
}
