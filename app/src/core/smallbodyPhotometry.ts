// Light from asteroids and comets: magnitude laws, colour, and the label rules that decide what may be drawn at each
// reality level. Pure (no DOM/GPU): the GPU field (gpu/smallbodies) packs lightParams() per object and evaluates the
// same formulas in WGSL; this file is the reference the tests hold both to.
//
// Constants come from smallbodies/photometry.json (SmallBodyPhotometry: sbpy's H-G and H-G1-G2 phase functions,
// Willmer 2018 V_sun, the Sun's XYZS at 1 AU, colour population means); rules are stated in its `rules` block and in
// docs/reports/small-bodies.md. An object of apparent V magnitude m delivers
//   E_k = sunIrradianceXYZS1AU_k * c_k * 10^(-0.4 (m - vSun)),  k = X, Y, Z, S (lux),
// with c the object's colour relative to sunlight (c = 1: the Sun's colour).

import { LABEL_ORDER, type Label, type PhaseBasisSpline, type SmallBodyCoreHeader, type SmallBodyPhotometry, type SmallBodyPhysicalHeader, type SmallBodyTableHeader } from '../data/schema';
import { BinaryTable, type BinaryColumn } from '../data/binaryTable';

export const MODEL_NONE = 0;
/** H-G with the SBDB H and G. */
export const MODEL_HG = 1;
/** H-G1-G2 (SsODNet V-band fit, its own H). */
export const MODEL_HG1G2 = 2;
/** Comet total magnitude M1 + 5 log Delta + K1 log r. */
export const MODEL_COMET_TOTAL = 3;
/** Comet nuclear magnitude M2 + 5 log Delta + K2 log r + PC phase[deg]. */
export const MODEL_COMET_NUCLEAR = 4;

export type ExistsLevel = 'strict' | 'best' | 'complete';
export const LEVEL_CODE: Record<ExistsLevel, number> = { strict: 0, best: 1, complete: 2 };
/** Highest admitted label index (LABEL_ORDER) per level (app/reality.ts ALLOWED_LABELS). */
const MAX_LABEL = [1, 2, 3];

const L = (l: Label) => LABEL_ORDER.indexOf(l);
const worst = (...ls: number[]) => Math.max(...ls);

/** (1 - G) Phi1 + G Phi2 of the IAU H-G system (Bowell et al. 1989 Eq. A4 as in sbpy). alpha in radians. */
export function hgPhi(p: SmallBodyPhotometry, alpha: number, G: number): number {
  const { A, B, C, W, smallPhase: s } = p.hg;
  const t = Math.tan(alpha / 2);
  const sn = Math.sin(alpha);
  const w = Math.exp(-W * t * t);
  const den = s[0] + s[1] * sn - s[2] * sn * sn;
  const phi = (i: 0 | 1) => w * (1 - (C[i] * sn) / den) + (1 - w) * (t > 0 ? Math.exp(-A[i] * t ** B[i]) : 1);
  return (1 - G) * phi(0) + G * phi(1);
}

/** One H-G1-G2 basis function at alpha (radians). */
export function basis(b: PhaseBasisSpline, alpha: number): number {
  const x = b.nodesRad;
  let v: number;
  if (alpha < x[0]) v = b.values[0] + b.endDerivatives[0] * (alpha - x[0]);
  else if (alpha >= x[x.length - 1]) v = b.values[x.length - 1] + b.endDerivatives[1] * (alpha - x[x.length - 1]);
  else {
    let i = 0;
    while (alpha >= x[i + 1]) i++;
    const t = alpha - x[i];
    const a = b.coefficients[i];
    v = a[0] + t * (a[1] + t * (a[2] + t * a[3]));
  }
  return Math.max(v, 0);
}

export function hg1g2Phi(p: SmallBodyPhotometry, alpha: number, G1: number, G2: number): number {
  return G1 * basis(p.hg1g2.phi1, alpha) + G2 * basis(p.hg1g2.phi2, alpha) + (1 - G1 - G2) * basis(p.hg1g2.phi3, alpha);
}

/** Illuminance (X, Y, Z, S lux) of apparent V magnitude m with colour c relative to sunlight. */
export function magnitudeToXYZS(p: SmallBodyPhotometry, m: number, c: readonly number[] = [1, 1, 1, 1]): [number, number, number, number] {
  const s = p.sunIrradianceXYZS1AU.value!;
  const k = 10 ** (-0.4 * (m - p.vSun.value!));
  return [s[0] * c[0] * k, s[1] * c[1] * k, s[2] * c[2] * k, s[3] * c[3] * k];
}

// ------------------------------------------------------------------------------------------------ half floats
const f32b = new Float32Array(1);
const u32b = new Uint32Array(f32b.buffer);
/** IEEE binary16 bits of x (round to nearest even), as WGSL unpack2x16float reads them. */
export function toHalf(x: number): number {
  f32b[0] = x;
  const b = u32b[0];
  const sign = (b >>> 16) & 0x8000;
  const exp = (b >>> 23) & 0xff;
  let mant = b & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  let e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    let h = mant >>> shift;
    const rem = mant & ((1 << shift) - 1);
    const half = 1 << (shift - 1);
    if (rem > half || (rem === half && (h & 1))) h++;
    return sign | h;
  }
  let h = (e << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && (h & 1))) h++;
  return sign | h;
}
export function fromHalf(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >>> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 0x1f) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

// ------------------------------------------------------------------------------------------------ per object
export type ColourMethod = 'gaia' | 'taxonomicClass' | 'taxonomicComplex' | 'orbitClass' | 'all' | 'sun';

export interface SmallBodyLightParams {
  model: number;
  /** H (MODEL_HG, MODEL_HG1G2), M1 or M2 (comets), mag. */
  h: number;
  /** G / G1 / K1 / K2. */
  p1: number;
  /** G2 / PC (mag per degree). */
  p2: number;
  /** Fitted phase-angle range of an H-G1-G2 fit (deg); outside it the phase function is extrapolated. */
  phaseMinDeg: number;
  phaseMaxDeg: number;
  /** Brightness label inside / outside the fitted phase range (worst of H and phase function). */
  labelIn: Label;
  labelOut: Label;
  posLabel: Label;
  /** Colour relative to sunlight (best / complete). */
  colour: [number, number, number, number];
  colourLabel: Label;
  /** The colour's spectral shape is derived from a measured spectrum (used at strict). */
  shapeDerived: boolean;
  colourMethod: ColourMethod;
}

export interface SmallBodyLightTables {
  core: ArrayBuffer;
  coreHeader: SmallBodyCoreHeader;
  physical?: ArrayBuffer;
  physicalHeader?: SmallBodyPhysicalHeader;
  comets?: ArrayBuffer;
  cometsHeader?: SmallBodyTableHeader;
}

const NO_ROW = 0xffffffff;

/** Everything needed to light each catalogue object, read once from the product tables. */
export class SmallBodyLight {
  readonly phot: SmallBodyPhotometry;
  readonly count: number;
  private readonly sun: number[];
  private readonly core: BinaryTable;
  private readonly phys: BinaryTable | null;
  private readonly physH: SmallBodyPhysicalHeader | null;
  private readonly comets: BinaryTable | null;
  private readonly cometRow: Int32Array;
  private readonly cometBit: number;
  private readonly classCodes: string[];
  private readonly classAlbedo: SmallBodyCoreHeader['classAlbedo'];
  private readonly vFilter: number;
  /** Columns read per object (a BinaryColumn get is a typed-array read). */
  private readonly cc: Record<string, BinaryColumn>;
  private readonly pc: Record<string, BinaryColumn>;
  private readonly mc: Record<string, BinaryColumn>;
  private readonly coreLabels: readonly Label[];
  private readonly physLabels: readonly Label[];

  constructor(phot: SmallBodyPhotometry, t: SmallBodyLightTables) {
    this.phot = phot;
    this.sun = phot.sunIrradianceXYZS1AU.value!;
    this.core = new BinaryTable(t.coreHeader, t.core);
    this.count = this.core.count;
    this.phys = t.physical && t.physicalHeader ? new BinaryTable(t.physicalHeader, t.physical) : null;
    this.physH = t.physicalHeader ?? null;
    this.comets = t.comets && t.cometsHeader ? new BinaryTable(t.cometsHeader, t.comets) : null;
    this.cometRow = new Int32Array(this.count).fill(-1);
    if (this.comets) {
      const row = this.comets.column('row');
      for (let k = 0; k < this.comets.count; k++) this.cometRow[row.get(k)] = k;
    }
    const bit = Object.entries(t.coreHeader.flagBits).find(([, n]) => n === 'comet');
    this.cometBit = bit ? Number(bit[0]) : 0;
    this.classCodes = t.coreHeader.orbitClasses.map((c) => c.code);
    this.classAlbedo = t.coreHeader.classAlbedo;
    const filters = this.physH?.phaseFilters ?? [];
    this.vFilter = filters.indexOf('V');
    const cols = (t: BinaryTable | null, names: string[]) => Object.fromEntries(t ? names.filter((n) => t.has(n)).map((n) => [n, t.column(n)]) : []);
    this.cc = cols(this.core, ['posLabel', 'flags', 'physRow', 'H', 'G', 'hLabel', 'gLabel', 'orbitClass']);
    this.pc = cols(this.phys, ['phaseFilter', 'phaseLabel', 'phaseH', 'phaseG1', 'phaseG2', 'phaseMinDeg', 'phaseMaxDeg', 'colorLabel',
      'geometricAlbedoXYZS', 'albedoLabel', 'albedo', 'gaiaBands', 'taxonomyBft']);
    this.mc = cols(this.comets, ['M1', 'K1', 'M2', 'K2', 'PC']);
    this.coreLabels = t.coreHeader.labelEncoding ?? LABEL_ORDER;
    this.physLabels = t.physicalHeader?.labelEncoding ?? LABEL_ORDER;
  }

  /** Parameters of core record i (see SmallBodyLightParams). */
  params(i: number): SmallBodyLightParams {
    const C = this.cc, P = this.pc;
    const cl0 = (name: string) => this.coreLabels[C[name].get(i)] ?? 'unknown';
    const pl0 = (name: string, r: number) => this.physLabels[P[name].get(r)] ?? 'unknown';
    const posLabel = cl0('posLabel');
    const out: SmallBodyLightParams = {
      model: MODEL_NONE, h: NaN, p1: 0, p2: 0, phaseMinDeg: 0, phaseMaxDeg: 180, labelIn: 'unknown', labelOut: 'unknown',
      posLabel, colour: [1, 1, 1, 1], colourLabel: 'estimated', shapeDerived: false, colourMethod: 'sun',
    };
    const isComet = (C.flags.get(i) & this.cometBit) !== 0;
    if (isComet) {
      const k = this.cometRow[i];
      const M = this.mc;
      if (this.comets && k >= 0) {
        const m1 = M.M1.get(k), k1 = M.K1.get(k), m2 = M.M2.get(k), k2 = M.K2.get(k), pc = M.PC.get(k);
        if (Number.isFinite(m1) && Number.isFinite(k1)) Object.assign(out, { model: MODEL_COMET_TOTAL, h: m1, p1: k1 });
        else if (Number.isFinite(m2) && Number.isFinite(k2)) Object.assign(out, { model: MODEL_COMET_NUCLEAR, h: m2, p1: k2, p2: Number.isFinite(pc) ? pc : 0 });
        if (out.model !== MODEL_NONE) out.labelIn = out.labelOut = this.phot.comets.label;
      }
      return out;
    }
    const pr = C.physRow.get(i);
    const p = pr !== NO_ROW ? this.phys : null;
    if (p && P.phaseFilter.get(pr) === this.vFilter && pl0('phaseLabel', pr) !== 'unknown') {
      const h = P.phaseH.get(pr), g1 = P.phaseG1.get(pr), g2 = P.phaseG2.get(pr);
      if (Number.isFinite(h) && Number.isFinite(g1) && Number.isFinite(g2)) {
        const pl = pl0('phaseLabel', pr);
        Object.assign(out, {
          model: MODEL_HG1G2, h, p1: g1, p2: g2, phaseMinDeg: P.phaseMinDeg.get(pr), phaseMaxDeg: P.phaseMaxDeg.get(pr),
          labelIn: pl, labelOut: LABEL_ORDER[worst(L(pl), L('estimated'))],
        });
      }
    }
    if (out.model === MODEL_NONE) {
      const H = C.H.get(i), G = C.G.get(i);
      const hl = cl0('hLabel'), gl = cl0('gLabel');
      if (Number.isFinite(H) && Number.isFinite(G) && hl !== 'unknown' && gl !== 'unknown') {
        const l = LABEL_ORDER[worst(L(hl), L(gl))];
        Object.assign(out, { model: MODEL_HG, h: H, p1: G, labelIn: l, labelOut: l });
      }
    }
    // Colour: the object's Gaia spectrum, else a population mean.
    if (p) {
      const cl = pl0('colorLabel', pr);
      const x = P.geometricAlbedoXYZS;
      const v = [x.get(pr, 0), x.get(pr, 1), x.get(pr, 2), x.get(pr, 3)];
      if (cl !== 'unknown' && v.every(Number.isFinite)) {
        const measuredAlbedo = pl0('albedoLabel', pr) === 'measured';
        const pv = measuredAlbedo ? P.albedo.get(pr) : this.classPv(C.orbitClass.get(i));
        out.colour = [v[0] / (pv * this.sun[0]), v[1] / (pv * this.sun[1]), v[2] / (pv * this.sun[2]), v[3] / (pv * this.sun[3])];
        out.shapeDerived = cl === 'derived' || (!measuredAlbedo && P.gaiaBands.get(pr) === 12);
        out.colourLabel = out.shapeDerived ? 'derived' : 'estimated';
        out.colourMethod = 'gaia';
        return out;
      }
    }
    const pm = this.phot.colour.populationMeans;
    const tax = p ? this.taxonomy(pr) : '';
    const cls = this.classCodes[C.orbitClass.get(i)] ?? '';
    let m: [ColourMethod, { cXYZS: [number, number, number, number] } | undefined][] = [
      ['taxonomicClass', tax ? pm.taxonomicClass[tax] : undefined],
      ['taxonomicComplex', tax ? pm.taxonomicComplex[tax.slice(0, 1).toUpperCase()] : undefined],
      ['orbitClass', pm.orbitClass[cls]],
      ['all', pm.all],
    ];
    m = m.filter(([, s]) => s);
    out.colour = [...m[0][1]!.cXYZS];
    out.colourMethod = m[0][0];
    out.colourLabel = 'estimated';
    return out;
  }

  private classPv(k: number): number {
    const code = this.classCodes[k];
    return (this.classAlbedo[code] ?? this.classAlbedo['*']).median;
  }

  private taxonomy(pr: number): string {
    const k = this.pc.taxonomyBft?.get(pr) ?? 0;
    if (!k) return '';
    const names = this.physH?.taxonomySsodnet ?? [];
    return (names[k] ?? '').split('|')[1]?.replace(/:+$/, '') ?? '';
  }

  /**
   * Apparent magnitude and illuminance of object i at heliocentric distance rAu, observer distance dAu and phase
   * angle alpha (radians), or null when its brightness is not admitted at `level` (CPU mirror of the WGSL).
   */
  apparent(i: number, rAu: number, dAu: number, alpha: number, level: ExistsLevel, prm = this.params(i)): { m: number; E: [number, number, number, number]; label: Label } | null {
    if (prm.model === MODEL_NONE) return null;
    const maxL = MAX_LABEL[LEVEL_CODE[level]];
    const adeg = (alpha * 180) / Math.PI;
    let label = prm.labelIn;
    if (prm.model === MODEL_HG1G2 && (adeg < prm.phaseMinDeg || adeg > prm.phaseMaxDeg)) label = prm.labelOut;
    if (L(label) > maxL || L(prm.posLabel) > maxL) return null;
    let m: number;
    if (prm.model === MODEL_HG) m = prm.h + 5 * Math.log10(rAu * dAu) - 2.5 * Math.log10(hgPhi(this.phot, alpha, prm.p1));
    else if (prm.model === MODEL_HG1G2) m = prm.h + 5 * Math.log10(rAu * dAu) - 2.5 * Math.log10(hg1g2Phi(this.phot, alpha, prm.p1, prm.p2));
    else if (prm.model === MODEL_COMET_TOTAL) m = prm.h + 5 * Math.log10(dAu) + prm.p1 * Math.log10(rAu);
    else m = prm.h + 5 * Math.log10(dAu) + prm.p1 * Math.log10(rAu) + prm.p2 * adeg;
    const c = level === 'strict' && !prm.shapeDerived ? [1, 1, 1, 1] : prm.colour;
    return { m, E: magnitudeToXYZS(this.phot, m, c), label };
  }

  /**
   * Pack every object's parameters for the GPU: 8 u32 per object (see gpu/smallbodies/kernels.ts `light`),
   * in the order `order` (GPU slot -> core index).
   */
  pack(order: Uint32Array): Uint32Array {
    const out = new Uint32Array(order.length * 8);
    const f = new Float32Array(1);
    const fu = new Uint32Array(f.buffer);
    const half2 = (a: number, b: number) => (toHalf(a) | (toHalf(b) << 16)) >>> 0;
    for (let s = 0; s < order.length; s++) {
      const i = order[s];
      const p = this.params(i);
      f[0] = p.model === MODEL_NONE ? 0 : p.h;
      const o = 8 * s;
      out[o] = fu[0];
      out[o + 1] = half2(p.p1, p.p2);
      out[o + 2] = half2(p.colour[0], p.colour[1]);
      out[o + 3] = half2(p.colour[2], p.colour[3]);
      out[o + 4] = half2(Number.isFinite(p.phaseMinDeg) ? p.phaseMinDeg : 0, Number.isFinite(p.phaseMaxDeg) ? p.phaseMaxDeg : 180);
      out[o + 5] = (p.model | (L(p.labelIn) << 4) | (L(p.labelOut) << 7) | (L(p.posLabel) << 10) | ((p.shapeDerived ? 1 : 0) << 13) | (L(p.colourLabel) << 14)) >>> 0;
      out[o + 6] = i;
      out[o + 7] = 0;
    }
    return out;
  }
}
