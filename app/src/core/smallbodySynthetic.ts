// The synthetic layer (pipeline stage `synthetic`, docs/reports/synthetic-populations.md): objects no survey has
// found yet, each standing in for one of the undiscovered members of an (a, e, i, H) cell of a debiased population
// model. Reading synthetic/objects + cells, and their float64 two-body positions. Pure, no DOM/GPU.
//
// Their orbits are statistical samples (osculating elements at the small-body epoch), so they move on fixed Kepler
// ellipses about the Sun: planetary perturbations would change nothing a synthetic object could claim. Synthetic
// irregular moons (populations with a `center`) move on fixed Kepler ellipses about their planet-system barycentre
// (GM of the system); their heliocentric state adds the barycentre's, which the caller supplies (CenterState).

import { D_H_CONSTANT_KM } from './constants';
import type { SyntheticCellsHeader, SyntheticObjectsHeader, SyntheticPopulation } from '../data/schema';
import { BinaryTable } from '../data/binaryTable';

type Vec3 = [number, number, number];

export interface SyntheticCatalog {
  header: SyntheticObjectsHeader;
  table: BinaryTable;
  count: number;
  cellsHeader: SyntheticCellsHeader | null;
  cells: BinaryTable | null;
  /** Epoch of the elements, TDB s past J2000. */
  epochEt: number;
  /** GM of the Sun (km^3/s^2), the ecliptic -> ICRF obliquity (rad), km per au. */
  mu: number;
  obliquity: number;
  auKm: number;
  /** Population by objects.pop code. */
  populations: Map<number, SyntheticPopulation>;
}

/** Heliocentric ICRF state (km, km/s) of a NAIF body at et, or null: the centre of a planet-centred population. */
export type CenterState = (naifId: number, et: number) => { pos: Vec3; vel: Vec3 } | null;

const DEG = Math.PI / 180;

export function readSynthetic(header: SyntheticObjectsHeader, buffer: ArrayBuffer, cellsHeader?: SyntheticCellsHeader | null, cells?: ArrayBuffer | null): SyntheticCatalog {
  const table = new BinaryTable(header, buffer);
  for (const f of ['a', 'e', 'i', 'node', 'peri', 'M', 'H', 'cell', 'pop']) {
    if (!table.has(f)) throw new Error(`synthetic objects table lacks field ${f}`);
  }
  return {
    header,
    table,
    count: table.count,
    cellsHeader: cellsHeader ?? null,
    cells: cellsHeader && cells ? new BinaryTable(cellsHeader, cells) : null,
    epochEt: header.epochEt,
    mu: header.gmSun,
    obliquity: (header.obliquityArcsec / 3600) * DEG,
    auKm: header.auKm,
    populations: new Map(header.populations.map((p) => [p.code, p])),
  };
}

export interface SyntheticElements {
  aAu: number;
  e: number;
  /** Degrees, ecliptic and equinox J2000. */
  i: number;
  node: number;
  peri: number;
  /** Mean anomaly at epochEt, degrees. */
  M: number;
  H: number;
}

export function syntheticElements(s: SyntheticCatalog, j: number): SyntheticElements {
  const t = s.table;
  return { aAu: t.get('a', j), e: t.get('e', j), i: t.get('i', j), node: t.get('node', j), peri: t.get('peri', j), M: t.get('M', j), H: t.get('H', j) };
}

/** Eccentric anomaly for mean anomaly M (rad, any value) and 0 <= e < 1 (Newton, safe start). */
export function keplerE(M: number, e: number): number {
  const m = M - 2 * Math.PI * Math.floor(M / (2 * Math.PI));
  let E = e < 0.8 ? m + e * Math.sin(m) : Math.PI;
  for (let k = 0; k < 60; k++) {
    const f = E - e * Math.sin(E) - m;
    const d = f / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-15 * Math.max(1, Math.abs(E))) break;
  }
  return E;
}

/** The centre of object j's orbit: the planet-system barycentre of a population with a `center`, else null (the Sun). */
export function syntheticCenter(s: SyntheticCatalog, j: number): { naifId: number; name: string; gm: number } | null {
  return syntheticPopulation(s, j)?.center ?? null;
}

/**
 * Heliocentric ICRF state (km, km/s) of synthetic object j at et: two-body motion of its elements. An object of a
 * planet-centred population needs `center` (the barycentre's heliocentric state); without it, null.
 */
export function syntheticState(s: SyntheticCatalog, j: number, et: number, center?: CenterState): { pos: Vec3; vel: Vec3 } | null {
  const rel = syntheticRelativeState(s, j, et);
  if (!rel) return null;
  const c = syntheticCenter(s, j);
  if (!c) return rel;
  const cs = center?.(c.naifId, et);
  if (!cs) return null;
  return {
    pos: [cs.pos[0] + rel.pos[0], cs.pos[1] + rel.pos[1], cs.pos[2] + rel.pos[2]],
    vel: [cs.vel[0] + rel.vel[0], cs.vel[1] + rel.vel[1], cs.vel[2] + rel.vel[2]],
  };
}

/** State of synthetic object j relative to the centre of its orbit (the Sun, or its planet-system barycentre). */
export function syntheticRelativeState(s: SyntheticCatalog, j: number, et: number): { pos: Vec3; vel: Vec3 } | null {
  if (!(j >= 0 && j < s.count)) return null;
  const el = syntheticElements(s, j);
  if (!(el.e >= 0 && el.e < 1 && el.aAu > 0)) return null;
  const a = el.aAu * s.auKm;
  const n = Math.sqrt(syntheticMu(s, j) / (a * a * a));
  const E = keplerE(el.M * DEG + n * (et - s.epochEt), el.e);
  const ci = Math.cos(el.i * DEG), si = Math.sin(el.i * DEG);
  const cO = Math.cos(el.node * DEG), sO = Math.sin(el.node * DEG);
  const cw = Math.cos(el.peri * DEG), sw = Math.sin(el.peri * DEG);
  const P: Vec3 = [cO * cw - sO * sw * ci, sO * cw + cO * sw * ci, sw * si];
  const Q: Vec3 = [-cO * sw - sO * cw * ci, -sO * sw + cO * cw * ci, cw * si];
  const b = a * Math.sqrt(1 - el.e * el.e);
  const cE = Math.cos(E), sE = Math.sin(E);
  const x = a * (cE - el.e), y = b * sE;
  const edot = n / (1 - el.e * cE);
  const vx = -a * sE * edot, vy = b * cE * edot;
  const ce = Math.cos(s.obliquity), se = Math.sin(s.obliquity);
  const rot = (v: Vec3): Vec3 => [v[0], ce * v[1] - se * v[2], se * v[1] + ce * v[2]];
  return {
    pos: rot([x * P[0] + y * Q[0], x * P[1] + y * Q[1], x * P[2] + y * Q[2]]),
    vel: rot([vx * P[0] + vy * Q[0], vx * P[1] + vy * Q[1], vx * P[2] + vy * Q[2]]),
  };
}

/** GM of the centre of object j's orbit (km^3/s^2). */
export function syntheticMu(s: SyntheticCatalog, j: number): number {
  return syntheticCenter(s, j)?.gm ?? s.mu;
}

/** Orbital period (s). */
export function syntheticPeriod(s: SyntheticCatalog, j: number): number {
  const a = s.table.get('a', j) * s.auKm;
  return 2 * Math.PI * Math.sqrt((a * a * a) / syntheticMu(s, j));
}

/**
 * The CenterState of a planetary ephemeris: the barycentre's position minus the Sun's (heliocentric, as the small-body
 * states), velocity by a central difference over ±1 s (the GPU kernel uses the same difference).
 */
export function centerStateFrom(eph: { positionSSB(id: number, et: number): readonly number[] | null }, sunId: number): CenterState {
  return (id, et) => {
    const p = eph.positionSSB(id, et), s = eph.positionSSB(sunId, et);
    const pa = eph.positionSSB(id, et - 1), pb = eph.positionSSB(id, et + 1);
    const sa = eph.positionSSB(sunId, et - 1), sb = eph.positionSSB(sunId, et + 1);
    if (!p || !s || !pa || !pb || !sa || !sb) return null;
    return {
      pos: [p[0] - s[0], p[1] - s[1], p[2] - s[2]],
      vel: [0, 1, 2].map((k) => (pb[k] - sb[k] - (pa[k] - sa[k])) / 2) as Vec3,
    };
  };
}

export function syntheticPopulation(s: SyntheticCatalog, j: number): SyntheticPopulation | null {
  return s.populations.get(s.table.get('pop', j)) ?? null;
}

/** Diameter (km) from H and p_V (Pravec & Harris 2007 Eq. 3, the relation the pipeline uses). */
export function diameterFromH(H: number, pV: number): number {
  return (D_H_CONSTANT_KM / Math.sqrt(pV)) * 10 ** (-H / 5);
}

export interface SyntheticCell {
  row: number;
  pop: number;
  /** Cell indices in the population grid. */
  ia: number;
  ie: number;
  ii: number;
  ih: number;
  a: [number, number];
  e: [number, number];
  i: [number, number];
  /** Conditioned H range [lo, hi) and the completeness limit of the cell's a-bin. */
  h: [number, number];
  hLim: number;
  nModel: number;
  nObs: number;
  rawDeficit: number;
  deficit: number;
  u0: number;
  nShown: number;
  first: number;
}

export function syntheticCell(s: SyntheticCatalog, row: number): SyntheticCell | null {
  const c = s.cells;
  if (!c || !(row >= 0 && row < c.count)) return null;
  const g = (f: string) => c.get(f, row);
  return {
    row, pop: g('pop'), ia: g('ia'), ie: g('ie'), ii: g('ii'), ih: g('ih'),
    a: [g('aLo'), g('aHi')], e: [g('eLo'), g('eHi')], i: [g('iLo'), g('iHi')], h: [g('hLo'), g('hHi')], hLim: g('hLim'),
    nModel: g('nModel'), nObs: g('nObs'), rawDeficit: g('rawDeficit'), deficit: g('deficit'), u0: g('u0'), nShown: g('nShown'), first: g('first'),
  };
}
