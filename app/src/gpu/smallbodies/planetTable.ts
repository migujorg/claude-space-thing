// Perturber positions for the GPU kicks, from the float64 CPU ephemeris. For each grid interval k
// ([epochEt + kH, epochEt + (k+1)H], H = forceModel.grid.baseStepS) and each of SAMPLES equally spaced epochs in it
// (both ends included), every perturber's heliocentric position is stored as a double-single triple (hi, lo) and the
// indirect acceleration -sum GM_p r_p / |r_p|^3 (float32). The kernels interpolate with 4-point Lagrange polynomials
// around the sample nearest the kick time (kernels.ts prel: the interpolation is done on differences between samples,
// which float32 holds exactly to ~ulp(1e5 km) = 0.008 km, added to the nearest sample's double-single position).
// With H = 2 d and 65 samples (45 min apart) the interpolation error is < 1e-4 km for the Moon (the fastest-curving
// perturber; 4th derivative ~ R w^4), far below the float32 storage error.
//
// Intervals are filled lazily (fill()), since the app may only ever visit a part of the window.

import type { SmallBodyForceModel } from '../../data/schema';
import type { PlanetPositions } from '../../core/smallbody';
import { split64 } from './wgslConst';

export type { PlanetPositions };

export const SAMPLES = 65;

export class PlanetTable {
  readonly samples = SAMPLES;
  readonly nb: number;
  readonly nbt: number;
  readonly H: number;
  readonly epochEt: number;
  /** First and last interval index k (signed, relative to the epoch). */
  readonly kmin: number;
  readonly kmax: number;
  readonly count: number;
  /** Floats per interval. */
  readonly stride: number;
  readonly data: Float32Array;
  private readonly state: Uint8Array; // 0 = not built, 1 = ok, 2 = ephemeris gap
  private readonly ids: number[];
  private readonly gm: number[];
  private readonly sunId: number;
  private readonly planets: PlanetPositions;

  constructor(model: SmallBodyForceModel, planets: PlanetPositions, epochEt: number, window: { startEt: number; endEt: number }) {
    this.planets = planets;
    this.H = model.grid.baseStepS;
    this.epochEt = epochEt;
    this.ids = model.perturbers.map((p) => p.naifId);
    this.gm = model.perturbers.map((p) => p.gm);
    this.sunId = model.sun.naifId;
    this.nb = this.ids.length;
    this.nbt = this.nb + 1;
    this.kmin = Math.floor((window.startEt - epochEt) / this.H);
    this.kmax = Math.ceil((window.endEt - epochEt) / this.H) - 1;
    this.count = this.kmax - this.kmin + 1;
    this.stride = this.nbt * SAMPLES * 8;
    this.data = new Float32Array(this.count * this.stride);
    this.state = new Uint8Array(this.count);
  }

  /** Table index of interval k, or -1 outside the window. */
  index(k: number): number {
    return k < this.kmin || k > this.kmax ? -1 : k - this.kmin;
  }

  isBuilt(iv: number): boolean {
    return this.state[iv] !== 0;
  }

  /** Build interval iv (table index) if needed; false if the ephemeris does not cover it. */
  fill(iv: number): boolean {
    if (this.state[iv]) return this.state[iv] === 1;
    const t0 = this.epochEt + (this.kmin + iv) * this.H;
    const dtS = this.H / (SAMPLES - 1);
    const base = iv * this.stride;
    const p = new Float64Array(3 * this.nb);
    for (let j = 0; j < SAMPLES; j++) {
      const t = t0 + j * dtS;
      const sun = this.planets.positionSSB(this.sunId, t);
      if (!sun) { this.state[iv] = 2; return false; }
      let ax = 0, ay = 0, az = 0;
      for (let b = 0; b < this.nb; b++) {
        const x = this.planets.positionSSB(this.ids[b], t);
        if (!x) { this.state[iv] = 2; return false; }
        const px = x[0] - sun[0], py = x[1] - sun[1], pz = x[2] - sun[2];
        p[3 * b] = px; p[3 * b + 1] = py; p[3 * b + 2] = pz;
        const r2 = px * px + py * py + pz * pz;
        const k = this.gm[b] / (r2 * Math.sqrt(r2));
        ax -= k * px; ay -= k * py; az -= k * pz;
      }
      for (let b = 0; b <= this.nb; b++) {
        const o = base + ((b * SAMPLES + j) * 8);
        if (b < this.nb) {
          for (let c = 0; c < 3; c++) {
            const [hi, lo] = split64(p[3 * b + c]);
            this.data[o + c] = hi;
            this.data[o + 4 + c] = lo;
          }
        } else {
          this.data[o] = ax; this.data[o + 1] = ay; this.data[o + 2] = az;
        }
      }
    }
    this.state[iv] = 1;
    return true;
  }
}
