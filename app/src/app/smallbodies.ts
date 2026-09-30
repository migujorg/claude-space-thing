// Small bodies in the app shell (docs/reports/small-bodies.md): identity, f64 positions for the selected few, the
// resolved close-up of a selected object with a measured diameter, its orbit track, and per-level counts.
//
// The GPU SmallBodyField (ports.ts) draws the catalogue; this module never touches all 1.57 M objects per frame.
// Only objects the user deals with (selection, travel/orbit target) are evaluated on the CPU:
//   * position: SmallBodyField.stateOf when a field exists, else the core reference propagator
//     (core/smallbody.ts, the same scheme and force model as the pipeline) — never extrapolated past the
//     catalogue window;
//   * the propagator keeps each object's state at every grid epoch it has passed (epochEt + m·baseStep). A step
//     always ends on that grid, so a restart from a stored grid state is bit-identical to one long propagation.
//
// Ids: small bodies share the app's body-id space as negative numbers, sbId(row) = −(row + 1), so the
// selection, camera, picking and labels code paths take them unchanged. (NAIF ids of major bodies are ≥ 0.)
//
// Synthetic objects (the COMPLETE level, synthetic/objects): rows count … count + syntheticCount − 1, after the
// catalogue. They have no name, flags or catalogue records; every attribute is labelled synthetic, so the reality
// filter admits them (position included) at Complete only. Positions: two-body motion of their elements.

import { coreState, readCore, readNonGrav, type SmallBodyCatalog } from '../core/smallbodyCatalog';
import { diameterFromH, readSynthetic, syntheticPeriod, syntheticPopulation, syntheticState, type SyntheticCatalog } from '../core/smallbodySynthetic';
import { SB_OK, SmallBodyPropagator, type NonGrav } from '../core/smallbody';
import type { EphemerisSet } from '../core/ephemeris';
import type { Body, BodyKind, Label, PhaseFunction, Sourced } from '../data/schema';
import { flagNames, orbitClassOf, physicalRow, type SmallBodyTable, type SmallBodyTables } from '../data/smallbodies';
import type { TimeWindow } from './clock';
import { osculatingPeriod, orbitSpan } from './orbits';
import type { ApparentResult, CoreFunctions, EphemerisSetPort, SmallBodyFieldPort, Vec3 } from './ports';
import { labelAllowed, worstOf, type ExistsLevel } from './reality';

export const sbId = (row: number): number => -(row + 1);

/** Names of the synthetic populations (synthetic/objects.json populations[].name). */
export const SYNTHETIC_POP_TEXT: Record<string, { short: string; long: string }> = {
  neo: { short: 'NEO', long: 'near-Earth object (q < 1.3 au)' },
  hungaria: { short: 'Hungaria', long: 'Hungaria-region asteroid (1.78–2.0 au)' },
  mainbelt: { short: 'main-belt asteroid', long: 'main-belt asteroid (2.0–3.7 au)' },
  hilda: { short: 'Hilda', long: 'Hilda-region asteroid (3.7–4.2 au)' },
  trojan: { short: 'Jupiter Trojan', long: 'Jupiter Trojan (5.05–5.35 au)' },
  tno: { short: 'trans-Neptunian object', long: 'trans-Neptunian object (a ≥ 30 au)' },
};
export const sbRow = (id: number): number => -id - 1;
export const isSmallBodyId = (id: number | null | undefined): id is number => typeof id === 'number' && id < 0;

/** Kind shown for small bodies. Not a BodyKind of bodies.json: code that switches on kind treats it as "other". */
export const SMALL_BODY_KIND = 'small-body' as unknown as BodyKind;

export interface HelioState {
  /** Heliocentric ICRF, km. */
  pos: Vec3;
  /** km/s */
  vel: Vec3;
}

type Ephem = { positionSSB(id: number, et: number): Vec3 | null };

// ---- table accessors ----------------------------------------------------------------------------------

/** Label of a u8 label field of a record ('unknown' if the field is absent). */
export function labelOf(t: SmallBodyTable | null, field: string | undefined, rec: number | null): Label {
  if (!t || !field || rec === null || !t.table.has(field)) return 'unknown';
  return t.table.label(field, rec);
}

/** Source id of a u8 source-index field (255 = none). */
export function sourcesOf(t: SmallBodyTable | null, field: string | undefined, rec: number | null): string[] {
  if (!t || !field || rec === null || !t.table.has(field)) return [];
  const s = t.table.sourceId(field, rec);
  return s ? [s] : [];
}

export function numOf(t: SmallBodyTable | null, field: string, rec: number | null, k = 0): number {
  if (!t || rec === null || !t.table.has(field)) return NaN;
  return t.table.get(field, rec, k);
}

/** Short facts for lists (search results, labels). */
export interface SmallBodySummary {
  row: number;
  H: number | null;
  hLabel: Label;
  orbitClass: { code: string; name: string } | null;
  comet: boolean;
  neo: boolean;
  pha: boolean;
  /** Also a planetary-ephemeris body (e.g. Pluto): the app draws it from the planetary ephemeris. */
  planetary: boolean;
  positionKnown: boolean;
}

export interface SmallBodyCounts {
  /** Drawn (the field's count) or admitted by labels (without a field). */
  drawn: number;
  /** The synthetic layer at this level: objects drawn (0 below Complete) of `objects` in the layer. */
  synthetic?: { drawn: number; objects: number };
  /** Position known, but a brightness input (or the position) is not admitted at this level. */
  withheld: number;
  /** No position at all (label unknown). */
  noPosition: number;
  /** Where the numbers come from. */
  from: 'field' | 'labels';
}

// ---- CPU positions ------------------------------------------------------------------------------------------

/** Grid states of one object: index n ↔ epochEt + n·H; n ≥ 0 in fwd, n < 0 in bwd[−n − 1]. */
interface GridStore {
  fwd: Float64Array[];
  bwd: Float64Array[];
  /** First grid index (absolute value) that could not be reached (collision, no ephemeris). */
  failFwd: number;
  failBwd: number;
}

const MAX_STORES = 64;

/** f64 reference positions (core/smallbody.ts) on the catalogue's integration grid, per object on demand. */
export class CpuSmallBodyStates {
  readonly cat: SmallBodyCatalog;
  readonly H: number;
  readonly window: TimeWindow;
  private readonly prop: SmallBodyPropagator;
  private readonly ng: Map<number, NonGrav>;
  private readonly stores = new Map<number, GridStore>();
  private readonly tmp = new Float64Array(6);
  /** Wall-clock ms spent propagating (diagnostics). */
  ms = 0;

  constructor(tables: SmallBodyTables, eph: Ephem) {
    this.cat = readCore(tables.core.header, tables.core.buffer);
    const fm = tables.core.header.forceModel;
    this.H = fm.grid.baseStepS;
    this.window = tables.core.header.window;
    // The propagator only calls eph.positionSSB (perturbers); the adapter keeps the port's shape.
    const adapter = { positionSSB: (id: number, et: number) => eph.positionSSB(id, et) };
    this.prop = new SmallBodyPropagator(fm, adapter as unknown as EphemerisSet);
    this.ng = tables.nongrav ? readNonGrav(tables.nongrav.header, tables.nongrav.buffer) : new Map();
  }

  get mu(): number {
    return this.prop.mu;
  }

  inWindow(et: number): boolean {
    return et >= this.window.startEt && et <= this.window.endEt;
  }

  private store(row: number): GridStore | null {
    let s = this.stores.get(row);
    if (s) {
      // LRU: most recently used last.
      this.stores.delete(row);
      this.stores.set(row, s);
      return s;
    }
    const st0 = coreState(this.cat, row);
    if (!st0) return null;
    s = { fwd: [st0], bwd: [], failFwd: Infinity, failBwd: Infinity };
    this.stores.set(row, s);
    if (this.stores.size > MAX_STORES) this.stores.delete(this.stores.keys().next().value!);
    return s;
  }

  /** State at grid index n, extending the store as needed; null if unreachable. */
  private gridState(row: number, s: GridStore, n: number): Float64Array | null {
    const e0 = this.cat.epochEt, H = this.H;
    const ng = this.ng.get(row) ?? null;
    const t0 = performance.now();
    try {
      if (n >= 0) {
        if (n >= s.failFwd) return null;
        while (s.fwd.length <= n) {
          const k = s.fwd.length;
          const st = Float64Array.from(s.fwd[k - 1]);
          if (this.prop.propagateOne(st, 0, e0 + (k - 1) * H, e0 + k * H, e0, ng) !== SB_OK) { s.failFwd = k; return null; }
          s.fwd.push(st);
        }
        return s.fwd[n];
      }
      const m = -n; // ≥ 1
      if (m >= s.failBwd) return null;
      while (s.bwd.length < m) {
        const k = s.bwd.length + 1;
        const st = Float64Array.from(k === 1 ? s.fwd[0] : s.bwd[k - 2]);
        if (this.prop.propagateOne(st, 0, e0 - (k - 1) * H, e0 - k * H, e0, ng) !== SB_OK) { s.failBwd = k; return null; }
        s.bwd.push(st);
      }
      return s.bwd[m - 1];
    } finally {
      this.ms += performance.now() - t0;
    }
  }

  /** Heliocentric state at et, or null (position unknown, outside the catalogue window, or lost on the way). */
  stateOf(row: number, et: number): HelioState | null {
    if (!this.inWindow(et) || row < 0 || row >= this.cat.count) return null;
    const s = this.store(row);
    if (!s) return null;
    const e0 = this.cat.epochEt;
    const n = Math.trunc((et - e0) / this.H);
    const g = this.gridState(row, s, n);
    if (!g) return null;
    const tg = e0 + n * this.H;
    const st = this.tmp;
    st.set(g);
    if (et !== tg) {
      const t0 = performance.now();
      const ok = this.prop.propagateOne(st, 0, tg, et, e0, this.ng.get(row) ?? null) === SB_OK;
      this.ms += performance.now() - t0;
      if (!ok) return null;
    }
    return { pos: [st[0], st[1], st[2]], vel: [st[3], st[4], st[5]] };
  }

  /** Heliocentric positions at every grid epoch in [t0, t1] (xyz per sample; NaN where unreachable). */
  gridPositions(row: number, t0: number, t1: number): { times: Float64Array; pos: Float64Array } | null {
    const s = this.store(row);
    if (!s) return null;
    const e0 = this.cat.epochEt, H = this.H;
    const n0 = Math.ceil((Math.max(t0, this.window.startEt) - e0) / H);
    const n1 = Math.floor((Math.min(t1, this.window.endEt) - e0) / H);
    if (n1 < n0) return null;
    const times = new Float64Array(n1 - n0 + 1);
    const pos = new Float64Array(3 * times.length);
    // Walk outward from the epoch so each grid state is computed once.
    const order: number[] = [];
    for (let n = Math.max(0, n0); n <= n1; n++) order.push(n);
    for (let n = Math.min(-1, n1); n >= n0; n--) order.push(n);
    for (const n of order) {
      const i = n - n0;
      times[i] = e0 + n * H;
      const g = this.gridState(row, s, n);
      pos[3 * i] = g ? g[0] : NaN;
      pos[3 * i + 1] = g ? g[1] : NaN;
      pos[3 * i + 2] = g ? g[2] : NaN;
    }
    return { times, pos };
  }
}

// ---- the runtime ----------------------------------------------------------------------------------------

export interface OrbitSamples {
  row: number;
  t0: number;
  t1: number;
  centerEt: number;
  period: number | null;
  /** Heliocentric positions, xyz per sample. */
  pos: Float64Array;
}

export class SmallBodies {
  readonly tables: SmallBodyTables;
  /** Catalogue objects (core rows). */
  readonly count: number;
  /** Synthetic objects (rows count … count + syntheticCount − 1); 0 without the layer. */
  readonly syntheticCount: number;
  readonly synthetic: SyntheticCatalog | null;
  /** NAIF id of the centre of the heliocentric states (forceModel.sun). */
  readonly sunNaif: number;
  field: SmallBodyFieldPort | null = null;
  readonly cpu: CpuSmallBodyStates;
  private readonly eph: Ephem;
  private readonly names = new Map<number, string>();
  private readonly pseudo = new Map<number, Body>();
  private readonly counts = new Map<ExistsLevel, SmallBodyCounts>();
  private tracks = new Map<number, OrbitSamples>();

  constructor(tables: SmallBodyTables, eph: Ephem) {
    this.tables = tables;
    this.count = tables.count;
    this.eph = eph;
    this.sunNaif = tables.core.header.forceModel.sun.naifId;
    this.cpu = new CpuSmallBodyStates(tables, eph);
    const syn = tables.synthetic;
    this.synthetic = syn ? readSynthetic(syn.objects.header, syn.objects.buffer, syn.cells?.header ?? null, syn.cells?.buffer ?? null) : null;
    this.syntheticCount = this.synthetic?.count ?? 0;
  }

  has(row: number): boolean {
    return Number.isInteger(row) && row >= 0 && row < this.count + this.syntheticCount;
  }

  /** Whether a row is a synthetic object (not a real one). */
  isSynthetic(row: number): boolean {
    return this.synthetic !== null && row >= this.count && row < this.count + this.syntheticCount;
  }

  /** Index of a synthetic row in synthetic/objects. */
  syntheticIndex(row: number): number {
    return row - this.count;
  }

  get window(): TimeWindow {
    return this.cpu.window;
  }

  // ---- identity ----

  setName(row: number, name: string): void {
    if (!name || this.names.get(row) === name) return;
    this.names.set(row, name);
    this.pseudo.delete(row);
  }

  knownName(row: number): string | null {
    return this.names.get(row) ?? null;
  }

  /** Display name, or a placeholder until the name index has answered. Synthetic objects: what they stand for. */
  name(row: number): string {
    if (this.isSynthetic(row)) {
      const j = this.syntheticIndex(row);
      const p = syntheticPopulation(this.synthetic!, j);
      return `Synthetic ${SYNTHETIC_POP_TEXT[p?.name ?? '']?.short ?? 'object'} #${(j - (p?.firstObject ?? 0) + 1).toLocaleString('en-US')}`;
    }
    return this.names.get(row) ?? `Small body #${row + 1}`;
  }

  flags(row: number): string[] {
    return this.isSynthetic(row) ? [] : flagNames(this.tables, row);
  }

  hasFlag(row: number, name: string): boolean {
    return this.flags(row).includes(name);
  }

  summary(row: number): SmallBodySummary {
    if (this.isSynthetic(row)) {
      const j = this.syntheticIndex(row);
      const p = syntheticPopulation(this.synthetic!, j);
      return {
        row, H: this.synthetic!.table.get('H', j), hLabel: 'synthetic',
        orbitClass: p ? { code: p.name, name: SYNTHETIC_POP_TEXT[p.name]?.long ?? p.name } : null,
        comet: false, neo: p?.name === 'neo', pha: false, planetary: false, positionKnown: true,
      };
    }
    const t = this.tables.core;
    const f = this.flags(row);
    const H = numOf(t, 'H', row);
    return {
      row,
      H: Number.isFinite(H) ? H : null,
      hLabel: labelOf(t, 'hLabel', row),
      orbitClass: orbitClassOf(this.tables, row),
      comet: f.includes('comet'),
      neo: f.includes('neo'),
      pha: f.includes('pha'),
      planetary: f.includes('planetaryEphemeris'),
      positionKnown: labelOf(t, 'posLabel', row) !== 'unknown',
    };
  }

  posLabel(row: number): Label {
    return this.isSynthetic(row) ? 'synthetic' : labelOf(this.tables.core, 'posLabel', row);
  }

  // ---- positions ----

  /** Heliocentric f64 state: the field's stateOf when there is a field, else the CPU reference propagator. */
  helio(row: number, et: number): HelioState | null {
    if (!this.has(row) || !this.cpu.inWindow(et)) return null;
    if (this.isSynthetic(row)) {
      const s = this.field?.syntheticCount ? this.field.stateOf(row, et) : syntheticState(this.synthetic!, this.syntheticIndex(row), et);
      return s ? { pos: [s.pos[0], s.pos[1], s.pos[2]], vel: [s.vel[0], s.vel[1], s.vel[2]] } : null;
    }
    if (this.field) {
      const s = this.field.stateOf(row, et);
      return s ? { pos: [s.pos[0], s.pos[1], s.pos[2]], vel: [s.vel[0], s.vel[1], s.vel[2]] } : null;
    }
    return this.cpu.stateOf(row, et);
  }

  /** Position relative to the solar-system barycenter (heliocentric + the Sun's SSB position). */
  ssb(row: number, et: number): Vec3 | null {
    const h = this.helio(row, et);
    if (!h) return null;
    const sun = this.eph.positionSSB(this.sunNaif, et);
    return sun ? [sun[0] + h.pos[0], sun[1] + h.pos[1], sun[2] + h.pos[2]] : null;
  }

  /** Light-time-corrected position relative to the observer, and the Sun direction at the emission epoch. */
  apparent(row: number, observerSSB: Vec3, et: number, core: Pick<CoreFunctions, 'apparentPosition'>): { app: ApparentResult; toSun: Vec3 | null } | null {
    const eph = { positionSSB: (_id: number, t: number) => this.ssb(row, t) } as unknown as EphemerisSetPort;
    const a = core.apparentPosition(eph, sbId(row), observerSSB, et);
    if (!a) return null;
    const app: ApparentResult = { rel: [a.rel[0], a.rel[1], a.rel[2]], lightTime: a.lightTime, emitEt: a.emitEt };
    const h = this.helio(row, app.emitEt);
    return { app, toSun: h ? [0 - h.pos[0], 0 - h.pos[1], 0 - h.pos[2]] : null };
  }

  // ---- size ----

  /** Measured diameter (km) and its label, or null. */
  measuredDiameter(row: number): { km: number; label: Label; sources: string[] } | null {
    if (this.isSynthetic(row)) return null;
    const P = this.tables.physical;
    const p = physicalRow(this.tables, row);
    const D = numOf(P, 'diameter', p);
    const label = labelOf(P, 'diameterLabel', p);
    return Number.isFinite(D) && D > 0 && label !== 'unknown' ? { km: D, label, sources: sourcesOf(P, 'diameterSrc', p) } : null;
  }

  /**
   * Radius for navigation only (viewing distance, keeping the camera outside): the measured diameter, else the
   * catalogue's diameter-from-H (from the brightness and an albedo; estimated). Never used for drawing.
   */
  navRadius(row: number): number | null {
    if (this.isSynthetic(row)) {
      const j = this.syntheticIndex(row), t = this.synthetic!.table;
      const d = t.has('pV') ? diameterFromH(t.get('H', j), t.get('pV', j)) : NaN;
      return Number.isFinite(d) && d > 0 ? d / 2 : null;
    }
    const m = this.measuredDiameter(row);
    if (m) return m.km / 2;
    const d = numOf(this.tables.core, 'diameterFromH', row);
    return Number.isFinite(d) && d > 0 ? d / 2 : null;
  }

  // ---- the resolved close-up ----

  /**
   * A Body for the reality filter and the renderer when the object is seen up close. Only the measured
   * diameter makes a shape: a sphere of that diameter, labelled estimated because the shape is an assumption.
   * Colour/albedo come from the physical table with their own labels; the phase function is a Lambert sphere
   * (an assumption, estimated): the measured H-G1-G2 fit is not converted into a phase function yet.
   */
  pseudoBody(row: number): Body {
    let b = this.pseudo.get(row);
    if (b) return b;
    if (this.isSynthetic(row)) {
      b = this.syntheticBody(row);
      this.pseudo.set(row, b);
      if (this.pseudo.size > 256) this.pseudo.delete(this.pseudo.keys().next().value!);
      return b;
    }
    const P = this.tables.physical;
    const p = physicalRow(this.tables, row);
    const cols = P?.header.columns ?? {};
    const d = this.measuredDiameter(row);
    const radii: Sourced<[number, number, number]> = d
      ? {
          value: [d.km / 2, d.km / 2, d.km / 2],
          unit: 'km',
          label: worstOf(['estimated', d.label]),
          sources: d.sources,
          method: `A sphere of the ${d.label} effective diameter (${Number(d.km.toPrecision(6))} km). The shape is an assumption, so the drawn shape is estimated. Diameter: ${cols.diameter?.method ?? ''}`.trim(),
        }
      : { value: null, label: 'unknown', sources: [], method: 'No measured diameter: nothing resolved is drawn (a diameter from H is used for navigation only).' };
    const xyzs = [0, 1, 2, 3].map((k) => numOf(P, 'geometricAlbedoXYZS', p, k));
    const colorLabel = labelOf(P, 'colorLabel', p);
    const albedoXYZS: Sourced<[number, number, number, number]> =
      xyzs.every(Number.isFinite) && colorLabel !== 'unknown'
        ? { value: xyzs as [number, number, number, number], unit: cols.geometricAlbedoXYZS?.unit, label: colorLabel, sources: sourcesOf(P, 'colorSrc', p), method: cols.geometricAlbedoXYZS?.method }
        : { value: null, label: 'unknown', sources: [], method: 'No reflectance spectrum for this object.' };
    const pv = numOf(P, 'albedo', p);
    const pvLabel = labelOf(P, 'albedoLabel', p);
    const albedoV: Sourced<number> =
      Number.isFinite(pv) && pvLabel !== 'unknown'
        ? { value: pv, label: pvLabel, sources: sourcesOf(P, 'albedoSrc', p), method: cols.albedo?.method }
        : { value: null, label: 'unknown', sources: [] };
    const hasFit = labelOf(P, 'phaseLabel', p) !== 'unknown';
    const phase: Sourced<PhaseFunction> = {
      value: { kind: 'lambert' },
      label: 'estimated',
      sources: [],
      method: `Lambert sphere: a modelling assumption.${hasFit ? ' A measured H-G1-G2 phase curve exists (see Phase function H, G1, G2) but is not converted into a phase function by this version.' : ''}`,
    };
    b = {
      id: sbId(row),
      name: this.name(row),
      kind: SMALL_BODY_KIND,
      ephemeris: '',
      radii,
      gm: { value: null, label: 'unknown', sources: [] },
      rotation: { value: null, label: 'unknown', sources: [], method: 'A sphere of uniform albedo shows no rotation; spin data are listed below.' },
      photometry: { geometricAlbedoXYZS: albedoXYZS, geometricAlbedoV: albedoV, phaseFunction: phase },
    };
    this.pseudo.set(row, b);
    return b;
  }

  /** A synthetic object as a Body: a point (never resolved) whose every attribute is synthetic. */
  private syntheticBody(row: number): Body {
    const s = this.synthetic!, j = this.syntheticIndex(row), t = s.table;
    const pv = t.has('pV') ? t.get('pV', j) : NaN;
    const pop = syntheticPopulation(s, j);
    const src = pop?.sources ?? [];
    const cls = t.has('colorClass') ? this.tables.core.header.colorClasses?.classes[t.get('colorClass', j)] : undefined;
    const xyzs = cls && Number.isFinite(pv) ? (cls.xyzsPerUnitPV.map((v) => v * pv) as [number, number, number, number]) : null;
    return {
      id: sbId(row),
      name: this.name(row),
      kind: SMALL_BODY_KIND,
      ephemeris: '',
      radii: { value: null, label: 'unknown', sources: [], method: 'A synthetic object is drawn as a point only: its size is a population draw, not a shape.' },
      gm: { value: null, label: 'unknown', sources: [] },
      rotation: { value: null, label: 'unknown', sources: [] },
      photometry: {
        geometricAlbedoXYZS: xyzs ? { value: xyzs, label: 'synthetic', sources: src, method: `The class colour of ${cls!.name} (smallbody-class-colors) at the synthetic p_V.` } : { value: null, label: 'unknown', sources: [] },
        geometricAlbedoV: Number.isFinite(pv) ? { value: pv, label: 'synthetic', sources: src, method: s.header.columns?.pV?.method } : { value: null, label: 'unknown', sources: [] },
        phaseFunction: { value: { kind: 'lambert' }, label: 'synthetic', sources: src, method: 'Points are lit with the H-G law of the synthetic H (G of the layer header); no resolved phase function.' },
      },
    };
  }

  // ---- orbit track ----

  /**
   * Heliocentric positions over one osculating period around et (within the catalogue window), or the whole
   * window when the period is longer or unbound. Every point is a propagated position; the period only chooses
   * the span. Cached per object; rebuilt when et has moved a quarter of the span.
   */
  orbit(row: number, et: number, window: TimeWindow): OrbitSamples | null {
    const w = { startEt: Math.max(window.startEt, this.window.startEt), endEt: Math.min(window.endEt, this.window.endEt) };
    if (!(w.endEt > w.startEt)) return null;
    const old = this.tracks.get(row);
    if (old && (old.period === null || Math.abs(et - old.centerEt) < (old.t1 - old.t0) / 4)) return old;
    if (this.isSynthetic(row)) {
      // A fixed Kepler ellipse: one period of two-body positions (the whole window if the period is longer).
      const s = this.synthetic!, j = this.syntheticIndex(row);
      const period = syntheticPeriod(s, j);
      const [t0, t1] = orbitSpan(et, period, w);
      const n = 257;
      const pos = new Float64Array(3 * n);
      for (let k = 0; k < n; k++) {
        const st = syntheticState(s, j, t0 + ((t1 - t0) * k) / (n - 1));
        pos.set(st ? st.pos : [NaN, NaN, NaN], 3 * k);
      }
      const tr: OrbitSamples = { row, t0, t1, centerEt: et, period: period < w.endEt - w.startEt ? period : null, pos };
      this.tracks.set(row, tr);
      if (this.tracks.size > 8) this.tracks.delete(this.tracks.keys().next().value!);
      return tr;
    }
    const st0 = coreState(this.cpu.cat, row);
    if (!st0) return null;
    const period = osculatingPeriod([st0[0], st0[1], st0[2]], [st0[3], st0[4], st0[5]], this.cpu.mu);
    const [t0, t1] = orbitSpan(et, period, w);
    const g = this.cpu.gridPositions(row, t0, t1);
    if (!g) return null;
    const tr: OrbitSamples = { row, t0, t1, centerEt: et, period: period !== null && period < w.endEt - w.startEt ? period : null, pos: g.pos };
    this.tracks.set(row, tr);
    if (this.tracks.size > 8) this.tracks.delete(this.tracks.keys().next().value!);
    return tr;
  }

  // ---- counts ----

  /**
   * Objects whose brightness inputs are admitted at a level, by the catalogue labels: position, H and a phase
   * law (G, or a measured H-G1-G2 fit) for asteroids; position and the total-magnitude law for comets.
   * Used when no field reports its own counts. Cached per level.
   */
  labelCounts(level: ExistsLevel): SmallBodyCounts {
    let c = this.counts.get(level);
    if (c) return c;
    const t = this.tables;
    const core = t.core.table;
    const enc = t.core.header.labelEncoding ?? [];
    const ok = enc.map((l) => l !== 'unknown' && labelAllowed(l, level));
    const col = (tb: SmallBodyTable | null, f: string) => (tb?.table.has(f) ? tb.table.column(f) : null);
    const pos = col(t.core, 'posLabel'), hL = col(t.core, 'hLabel'), gL = col(t.core, 'gLabel'), phys = col(t.core, 'physRow');
    const flags = col(t.core, 'flags');
    const phaseL = col(t.physical, 'phaseLabel');
    const cometL = col(t.comets, 'totalLabel');
    const unknownCode = enc.indexOf('unknown');
    const cometBit = Number(Object.entries(t.core.header.flagBits ?? {}).find(([, n]) => n === 'comet')?.[0] ?? 0);
    const physCount = t.physical?.table.count ?? 0;
    let drawn = 0, withheld = 0, noPosition = 0;
    for (let i = 0; i < core.count; i++) {
      const pl = pos ? pos.get(i) : unknownCode;
      if (pl === unknownCode) { noPosition++; continue; }
      let bright: boolean;
      if (flags && cometBit && (flags.get(i) & cometBit) !== 0) {
        const k = t.cometRow.get(i);
        bright = k !== undefined && !!cometL && !!ok[cometL.get(k)];
      } else {
        const pr = phys ? phys.get(i) : -1;
        const fit = pr >= 0 && pr < physCount && !!phaseL && !!ok[phaseL.get(pr)];
        bright = !!hL && !!ok[hL.get(i)] && ((!!gL && !!ok[gL.get(i)]) || fit);
      }
      if (ok[pl] && bright) drawn++;
      else withheld++;
    }
    c = { drawn, withheld, noPosition, from: 'labels' };
    this.counts.set(level, c);
    return c;
  }

  /** Counts for the HUD: the field's own when it reports them, else by labels. */
  countsAt(level: ExistsLevel): SmallBodyCounts {
    const s = this.field?.stats;
    const objects = this.field ? this.field.syntheticCount ?? 0 : this.syntheticCount;
    const synthetic = objects ? { drawn: s?.synthetic?.drawn ?? (level === 'complete' && !this.field ? objects : 0), objects } : undefined;
    if (s) return { drawn: s.drawn, withheld: s.withheld, noPosition: this.labelCounts(level).noPosition, from: 'field', ...(synthetic ? { synthetic } : {}) };
    return { ...this.labelCounts(level), ...(synthetic ? { synthetic } : {}) };
  }
}
