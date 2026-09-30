// Inspector view-model for a small body: every attribute of its catalogue records (core, physical, comets,
// nongrav) with the label, source and method the tables give per column (header `columns` docs and the u8
// label/source fields), its flags and orbit class, and the "why does it look like this" line. Pure, no DOM.
//
// Columns are grouped into attributes (a value with its uncertainty and qualifiers). The grouping and the
// wording are presentation; every number, label, source and method comes from the tables.

import type { Label } from '../data/schema';
import { flagNames, orbitClassOf, physicalRow, type SmallBodyTable, type SmallBodyTables } from '../data/smallbodies';
import { labelOf, numOf, sourcesOf } from '../app/smallbodies';
import { EXISTS_TEXT, labelAllowed, whyLine, type ExistsLevel, type FilteredBody } from '../app/reality';
import type { AttrRow } from './inspectModel';
import { formatValue, sig } from './format';
import { AU_KM, SECONDS_PER_DAY } from './units';

type TableKey = 'core' | 'physical' | 'comets' | 'nongrav';

interface Group {
  key: string;
  name: string;
  table: TableKey;
  cols: string[];
  /** Label / source fields when the column docs do not name them (the group's first documented column's otherwise). */
  label?: string;
  src?: string;
  format(v: Values, t: SmallBodyTable): string | null;
}

/** Column values of one record; NaN where unknown. */
type Values = Record<string, number[]>;

const fin = (x: number | undefined): x is number => typeof x === 'number' && Number.isFinite(x);
const one = (v: Values, c: string): number | undefined => (fin(v[c]?.[0]) ? v[c][0] : undefined);
const listAt = (t: SmallBodyTable, list: string, i: number | undefined): string | null => {
  const l = (t.header as unknown as Record<string, unknown>)[list];
  return Array.isArray(l) && i !== undefined && i > 0 && typeof l[i] === 'string' && l[i] ? (l[i] as string) : null;
};
const unitOf = (t: SmallBodyTable, c: string): string => {
  const u = t.header.columns?.[c]?.unit;
  return u ? ` ${u}` : '';
};
/** A catalogue value (f32) at its stored precision: no invented trailing digits. */
const fmt = (x: number, n = 6): string => String(Number(x.toPrecision(n)));
const pm = (x: number, s: number | undefined, n = 6) => `${fmt(x, n)}${fin(s) && s > 0 ? ` ± ${fmt(s, 2)}` : ''}`;
/** 255 marks "not given" in u8 code columns. */
const code = (x: number | undefined): number | undefined => (x === undefined || x === 255 ? undefined : x);

export const SMALL_BODY_GROUPS: Group[] = [
  {
    key: 'orbit', name: 'Orbit (heliocentric state at the catalogue epoch)', table: 'core', cols: ['pos', 'vel'],
    format: (v) => {
      const p = v.pos, u = v.vel;
      if (!p?.every(fin) || !u?.every(fin)) return null;
      return `r = ${sig(Math.hypot(p[0], p[1], p[2]) / AU_KM, 6)} AU, v = ${sig(Math.hypot(u[0], u[1], u[2]), 5)} km/s`;
    },
  },
  { key: 'H', name: 'Absolute magnitude H', table: 'core', cols: ['H'], format: (v, t) => (fin(one(v, 'H')) ? `${fmt(one(v, 'H')!, 4)}${unitOf(t, 'H')}` : null) },
  { key: 'G', name: 'Slope parameter G (H-G law)', table: 'core', cols: ['G'], format: (v) => (fin(one(v, 'G')) ? fmt(one(v, 'G')!, 3) : null) },
  {
    key: 'diameterFromH', name: 'Diameter from H (for navigation only; not drawn)', table: 'core', cols: ['diameterFromH'],
    format: (v, t) => (fin(one(v, 'diameterFromH')) ? `${fmt(one(v, 'diameterFromH')!, 3)}${unitOf(t, 'diameterFromH')}` : null),
  },
  { key: 'diameter', name: 'Diameter (effective)', table: 'physical', cols: ['diameter', 'diameterSigma'], format: (v, t) => (fin(one(v, 'diameter')) ? `${pm(one(v, 'diameter')!, one(v, 'diameterSigma'))}${unitOf(t, 'diameter')}` : null) },
  { key: 'albedo', name: 'Geometric albedo p_V', table: 'physical', cols: ['albedo', 'albedoSigma'], format: (v) => (fin(one(v, 'albedo')) ? pm(one(v, 'albedo')!, one(v, 'albedoSigma'), 3) : null) },
  {
    key: 'rotation', name: 'Rotation period (synodic)', table: 'physical', cols: ['rotPeriod', 'rotQuality'],
    format: (v, t) => {
      const p = one(v, 'rotPeriod');
      if (!fin(p)) return null;
      const q = listAt(t, 'lcdbU', one(v, 'rotQuality'));
      return `${fmt(p, 6)}${unitOf(t, 'rotPeriod')}${q ? ` (LCDB reliability U ${q})` : ''}`;
    },
  },
  {
    key: 'colour', name: 'Colour: geometric albedo (XYZ + scotopic)', table: 'physical', cols: ['geometricAlbedoXYZS', 'gaiaBands'],
    format: (v, t) => {
      const x = v.geometricAlbedoXYZS;
      if (!x?.every(fin)) return null;
      const b = one(v, 'gaiaBands');
      return `${formatValue(x, t.header.columns?.geometricAlbedoXYZS?.unit, 'xyzs')}${fin(b) && b > 0 ? ` · Gaia bands used: ${b}` : ''}`;
    },
  },
  {
    key: 'colourIndex', name: 'Colour indices', table: 'physical', cols: ['BV', 'UB', 'IR'], label: 'colorIndexLabel', src: 'colorIndexSrc',
    format: (v) => {
      const parts = ([['BV', 'B−V'], ['UB', 'U−B'], ['IR', 'I−R']] as const).filter(([c]) => fin(one(v, c))).map(([c, n]) => `${n} ${fmt(one(v, c)!, 3)}`);
      return parts.length ? parts.join(', ') : null;
    },
  },
  {
    key: 'taxonomy', name: 'Taxonomy (SBDB)', table: 'physical', cols: ['taxonomyB', 'taxonomyT'], label: 'taxonomyLabel', src: 'taxonomySrc',
    format: (v, t) => {
      const b = listAt(t, 'taxonomyB', one(v, 'taxonomyB')), th = listAt(t, 'taxonomyT', one(v, 'taxonomyT'));
      const parts = [b ? `SMASSII ${b}` : '', th ? `Tholen ${th}` : ''].filter(Boolean);
      return parts.length ? parts.join(', ') : null;
    },
  },
  {
    key: 'taxonomyBft', name: 'Taxonomy (SsODNet best estimate)', table: 'physical', cols: ['taxonomyBft'],
    format: (v, t) => {
      const s = listAt(t, 'taxonomySsodnet', one(v, 'taxonomyBft'));
      if (!s) return null;
      const [scheme, cls, tech] = s.split('|');
      return `${scheme} ${cls}${tech === 'Spec' ? ' (from a spectrum)' : tech === 'Phot' ? ' (from photometry/colours)' : tech ? ` (${tech})` : ''}`;
    },
  },
  {
    key: 'phase', name: 'Phase function H, G1, G2 (fitted)', table: 'physical',
    cols: ['phaseH', 'phaseG1', 'phaseG2', 'phaseHSigma', 'phaseG1Sigma', 'phaseG2Sigma', 'phaseMinDeg', 'phaseMaxDeg', 'phaseN', 'phaseFilter', 'phaseFacility'],
    format: (v, t) => {
      const H = one(v, 'phaseH');
      if (!fin(H)) return null;
      const g1 = one(v, 'phaseG1'), g2 = one(v, 'phaseG2');
      const lo = one(v, 'phaseMinDeg'), hi = one(v, 'phaseMaxDeg'), n = one(v, 'phaseN');
      const band = listAt(t, 'phaseFilters', one(v, 'phaseFilter')), fac = listAt(t, 'phaseFacilities', one(v, 'phaseFacility'));
      const fit = [fin(lo) && fin(hi) ? `phase angles ${fmt(lo, 3)}°–${fmt(hi, 3)}°` : '', fin(n) && n > 0 ? `${n} observations` : '', band ? `band ${band}` : '', fac ?? ''].filter(Boolean);
      return `H ${pm(H, one(v, 'phaseHSigma'), 4)}${fin(g1) ? `, G1 ${pm(g1, one(v, 'phaseG1Sigma'), 3)}` : ''}${fin(g2) ? `, G2 ${pm(g2, one(v, 'phaseG2Sigma'), 3)}` : ''}${fit.length ? ` · fitted over ${fit.join(', ')}` : ''}`;
    },
  },
  {
    key: 'spin', name: 'Spin pole and sidereal period', table: 'physical', cols: ['poleRA', 'poleDec', 'spinPeriod', 'spinTechnique'],
    format: (v, t) => {
      const ra = one(v, 'poleRA'), dec = one(v, 'poleDec'), p = one(v, 'spinPeriod');
      if (!fin(ra) && !fin(p)) return null;
      const tech = listAt(t, 'spinTechniques', one(v, 'spinTechnique'));
      return [fin(ra) && fin(dec) ? `pole RA ${fmt(ra, 4)}°, Dec ${fmt(dec, 3)}°` : '', fin(p) ? `period ${fmt(p, 6)}${unitOf(t, 'spinPeriod')}` : '', tech ? `technique ${tech}` : '']
        .filter(Boolean)
        .join(' · ');
    },
  },
  {
    key: 'cometTotal', name: 'Comet total-magnitude law (coma)', table: 'comets', cols: ['M1', 'K1'], label: 'totalLabel', src: 'src',
    format: (v) => (fin(one(v, 'M1')) ? `M1 ${fmt(one(v, 'M1')!, 4)} mag${fin(one(v, 'K1')) ? `, K1 ${fmt(one(v, 'K1')!, 4)}` : ''}` : null),
  },
  {
    key: 'cometNuclear', name: 'Comet nuclear-magnitude law', table: 'comets', cols: ['M2', 'K2', 'PC'], label: 'nuclearLabel', src: 'src',
    format: (v) =>
      fin(one(v, 'M2')) ? `M2 ${fmt(one(v, 'M2')!, 4)} mag${fin(one(v, 'K2')) ? `, K2 ${fmt(one(v, 'K2')!, 4)}` : ''}${fin(one(v, 'PC')) ? `, PC ${fmt(one(v, 'PC')!, 3)} mag/deg` : ''}` : null,
  },
  {
    key: 'nongrav', name: 'Non-gravitational acceleration (included in the propagation)', table: 'nongrav',
    cols: ['A1', 'A2', 'A3', 'DT', 'ALN', 'R0', 'NM', 'NN', 'NK'], label: 'label', src: 'src',
    format: (v, t) => {
      const parts = ['A1', 'A2', 'A3', 'DT'].filter((c) => fin(one(v, c)) && one(v, c) !== 0).map((c) => `${c} ${fmt(one(v, c)!, 4)}${unitOf(t, c)}`);
      const g = ['ALN', 'R0', 'NM', 'NN', 'NK'].filter((c) => fin(one(v, c))).map((c) => `${c} ${fmt(one(v, c)!, 4)}${unitOf(t, c)}`);
      return parts.length || g.length ? `${parts.join(', ') || 'A1 = A2 = A3 = 0'}${g.length ? ` · g(r): ${g.join(', ')}` : ''}` : null;
    },
  },
];

/** What each catalogue flag means (bits from the core header's flagBits; unknown flags are shown by name). */
export const FLAG_TEXT: Record<string, string> = {
  comet: 'Comet.',
  numbered: 'Numbered: its orbit is secure enough for a permanent number.',
  neo: 'Near-Earth object.',
  pha: 'Potentially hazardous asteroid.',
  nonGravitational: 'Has fitted non-gravitational forces (outgassing, thermal recoil); they are included in the propagation.',
  unsupportedModelTerms: 'Its JPL orbit uses model terms this propagator does not include (see Orbit method).',
  preEphemerisTwoBody: 'Its orbit epoch predates the planetary ephemeris: it was moved two-body to the ephemeris start, so its position is estimated.',
  positionLost: 'Position unknown: the propagation passed inside a planet, the Moon or the Sun (impactor, disrupted or sungrazing), so it is not drawn.',
  orbitFromMpc: 'Its orbit comes from the Minor Planet Center (MPCORB) rather than JPL.',
  twoBodyOrbitDetermination: 'Its orbit solution was determined with a two-body model.',
  oldPlanetaryEphemeris: 'Its orbit was fitted with an older planetary ephemeris than the one used to propagate it.',
  horizonsState: 'Its state at the catalogue epoch was taken from JPL Horizons instead of being integrated here.',
  mpcDisagrees: 'The MPC and JPL orbits put it at clearly different places at a common epoch: the orbit is poorly determined.',
  closeApproachInWindow: 'Passes close to a planet within the data window (CNEOS close-approach list).',
  planetaryEphemeris: 'Also a body of the planetary ephemeris: the app draws it from there.',
};

function tableOf(t: SmallBodyTables, k: TableKey, row: number): { tb: SmallBodyTable; rec: number } | null {
  if (k === 'core') return { tb: t.core, rec: row };
  if (k === 'physical') {
    const p = physicalRow(t, row);
    return p !== null && t.physical ? { tb: t.physical, rec: p } : null;
  }
  const tb = k === 'comets' ? t.comets : t.nongrav;
  const rec = (k === 'comets' ? t.cometRow : t.nongravRow).get(row);
  return tb && rec !== undefined ? { tb, rec } : null;
}

function values(tb: SmallBodyTable, rec: number, cols: string[]): Values {
  const v: Values = {};
  for (const c of cols) {
    const f = tb.header.fields.find((x) => x.name === c);
    if (!f) continue;
    v[c] = Array.from({ length: f.count ?? 1 }, (_, k) => tb.table.get(c, rec, k));
  }
  for (const c of ['conditionCode', 'mpcU', 'rotQuality', 'phaseFilter', 'phaseFacility', 'spinTechnique', 'taxonomyB', 'taxonomyT', 'taxonomyBft', 'gaiaBands']) {
    if (v[c]) v[c] = v[c].map((x) => code(x) ?? NaN);
  }
  return v;
}

export interface SmallBodyFacts {
  rows: AttrRow[];
  /** Attributes with no value for this object (one line instead of a row each). */
  unknown: string[];
  flags: { name: string; text: string }[];
  orbitClass: { code: string; name: string } | null;
}

/** Every catalogue attribute of a small body at a level (rows in SMALL_BODY_GROUPS order). */
export function smallBodyFacts(t: SmallBodyTables, row: number, level: ExistsLevel, ctx: { positionNote?: string } = {}): SmallBodyFacts {
  const rows: AttrRow[] = [];
  const unknown: string[] = [];
  for (const g of SMALL_BODY_GROUPS) {
    const tr = tableOf(t, g.table, row);
    if (!tr) {
      // Comet / non-gravitational tables apply to few objects: only say "unknown" where the object could have one.
      if (g.table === 'physical') unknown.push(g.name);
      continue;
    }
    const docs = tr.tb.header.columns ?? {};
    const lead = g.cols.find((c) => docs[c]?.label) ?? g.cols[0];
    const labelField = g.label ?? docs[lead]?.label;
    const srcField = g.src ?? docs[lead]?.source;
    const v = values(tr.tb, tr.rec, g.cols);
    const text = g.format(v, tr.tb);
    const label: Label = text === null ? 'unknown' : labelOf(tr.tb, labelField, tr.rec);
    if (text === null || label === 'unknown') {
      if (g.key !== 'nongrav') unknown.push(g.name);
      continue;
    }
    const methods = [...new Set(g.cols.map((c) => docs[c]?.method).filter((m): m is string => !!m))];
    const r: AttrRow = {
      key: `sb:${g.key}`,
      name: g.name,
      label,
      value: text,
      sources: sourcesOf(tr.tb, srcField, tr.rec),
      withheld: !labelAllowed(label, level),
      ...(methods.length ? { method: methods.join(' ') } : {}),
    };
    if (g.key === 'orbit') {
      const h = t.core.header;
      const cc = code(numOf(t.core, 'conditionCode', row)), u = code(numOf(t.core, 'mpcU', row));
      const q = [fin(cc) ? `JPL condition code ${cc}` : '', fin(u) ? `MPC uncertainty U ${u}` : ''].filter(Boolean);
      r.value += ` at ${h.epochTdb} TDB${q.length ? ` · ${q.join(', ')} (0 good … 9 poor)` : ''}${ctx.positionNote ? ` — ${ctx.positionNote}` : ''}`;
      const fm = h.forceModel;
      r.method = `${r.method ?? ''} Propagated to the displayed time with ${fm.scheme.name} (${fm.scheme.order}) on a ${sig(fm.grid.baseStepS / SECONDS_PER_DAY, 3)}-day grid under ${fm.perturbers.map((p) => p.name).join(', ')} (${fm.ephemeris}); ${fm.relativity.model}; non-gravitational: ${fm.nonGravitational}. Seen with light-time correction, so the drawn position is at best derived.`.trim();
      r.sources = [...new Set([...r.sources, ...fm.perturberSources])];
      r.label = label;
      r.withheld = !labelAllowed(label === 'measured' ? 'derived' : label, level);
    }
    rows.push(r);
  }
  const cm = t.cometModel;
  if (cm && t.cometRow.has(row) && rows.some((r) => r.key === 'sb:cometTotal')) {
    // Coma and tails (render/comets): the composition that splits the M1/K1 light into gas and dust.
    const own = t.cometList?.measured[String(row)];
    const p = cm.composition.population;
    const v = (k: 'C2' | 'CN' | 'C3' | 'afrho') => (own?.[k] ?? p[k].median).toFixed(2);
    const label: Label = own?.afrho !== undefined ? 'derived' : 'estimated';
    rows.push({
      key: 'sb:cometComposition', name: 'Coma composition (log Q(X)/Q(OH); dust log Afρ/Q(OH))', label,
      value: `C2 ${v('C2')}, CN ${v('CN')}, C3 ${v('C3')}; Afρ ${v('afrho')} — ${own ? `this comet (${own.key}, A'Hearn et al. 1995)` : `population medians (${p.afrho.n} comets)`}`,
      sources: [...new Set([...(own?.sources ?? []), ...cm.composition.sources])],
      method: `${cm.composition.method} Water production from the M1/K1 magnitude: ${cm.waterFromMagnitude.method}.`,
      withheld: !labelAllowed(label, level),
    });
    rows.push({
      key: 'sb:cometComa', name: 'Coma and tails (drawn when resolved)', label: 'estimated',
      value: 'gas bands (C2, CN, C3, CH, [O I]) and dust sharing the M1/K1 light; Finson–Probstein dust tail; CO⁺ ion tail',
      sources: [...new Set([...cm.components.sources, ...cm.grains.sources, ...cm.solarWind.sources, ...cm.dustPhase.sources])],
      method: 'docs/reports/comets.md: gas luminosity L = g·Q·l_d/v per band; dust = the rest of the V light, spread as a 1/ρ coma whose radius is where the Afρ coma reaches it; tail grains released with the nucleus velocity on Kepler orbits with μ(1 − β); ions along v_sw r̂ − v_comet.',
      withheld: !labelAllowed('estimated', level),
    });
  }
  const flags = flagNames(t, row).map((name) => ({ name, text: FLAG_TEXT[name] ?? name }));
  return { rows, unknown, flags, orbitClass: orbitClassOf(t, row) };
}

/** Brightness inputs the small-body points rest on, with their labels (asteroids: H + G or an H-G1-G2 fit; comets: M1/K1). */
export function brightnessInputs(t: SmallBodyTables, row: number): { what: string; label: Label }[] {
  if (flagNames(t, row).includes('comet')) {
    const k = t.cometRow.get(row);
    return [{ what: 'comet total-magnitude law M1/K1', label: k !== undefined ? labelOf(t.comets, 'totalLabel', k) : 'unknown' }];
  }
  const p = physicalRow(t, row);
  const out = [
    { what: 'H', label: labelOf(t.core, 'hLabel', row) },
    { what: 'G', label: labelOf(t.core, 'gLabel', row) },
  ];
  const fit = labelOf(t.physical, 'phaseLabel', p);
  if (fit !== 'unknown') out.push({ what: 'H-G1-G2 fit', label: fit });
  return out;
}

/** Whether the brightness inputs admit a point at a level (the same rule as SmallBodies.labelCounts). */
export function brightnessAdmitted(inputs: { what: string; label: Label }[], level: ExistsLevel): boolean {
  const ok = (w: string) => inputs.some((i) => i.what === w && i.label !== 'unknown' && labelAllowed(i.label, level));
  if (inputs.length === 1) return ok(inputs[0].what);
  return ok('H') && (ok('G') || ok('H-G1-G2 fit'));
}

/** "Why does it look like this" for a small body. */
export function smallBodyWhy(o: {
  level: ExistsLevel;
  positionLabel: Label;
  /** How it is drawn this frame ('comet': with its coma and tails, render/comets). */
  drawn: 'closeup' | 'point' | 'none' | 'comet';
  field: boolean;
  inputs: { what: string; label: Label }[];
  filtered: FilteredBody | null;
  hasDiameter: boolean;
  /** The body's shape-model status (app/shapes.ts), if it has one. */
  shape?: { drawn: boolean; text: string } | null;
}): string {
  const L = EXISTS_TEXT[o.level].name;
  if (o.positionLabel === 'unknown') return 'Its position is unknown (see its flags): nothing can be drawn.';
  const posShown = o.positionLabel === 'measured' ? 'derived' : o.positionLabel;
  if (!labelAllowed(posShown, o.level)) return `Its position is ${posShown}, not admitted at ${L}: nothing is drawn.`;
  const inputs = o.inputs.map((i) => `${i.what} (${i.label})`).join(', ');
  if (o.drawn === 'closeup' && o.filtered && o.shape?.drawn)
    return `${whyLine(o.filtered, o.level)} Resolved close-up drawn from its shape model, which also gives its orientation: ${o.shape.text}. The photometric size is the measured diameter or, without one, the model's volume-equivalent radius; the brightness spread over the mesh is derived.`;
  if (o.drawn === 'closeup' && o.filtered)
    return `${whyLine(o.filtered, o.level)} Resolved close-up: a sphere of the measured diameter — the spherical shape is an assumption.${o.shape ? ` Shape model not drawn: ${o.shape.text}.` : ''}`;
  const bright = brightnessAdmitted(o.inputs, o.level);
  if (o.drawn === 'comet')
    return `Drawn with its coma, dust tail and ion tail: the total light is ${inputs}; its split into gas bands and dust, the coma's size and the tails come from the comet model (estimated; docs/reports/comets.md). Too small to resolve, it is a point again.`;
  const size = !o.hasDiameter
    ? ' No measured diameter: it is never drawn resolved.'
    : labelAllowed('estimated', o.level)
      ? ' Up close it is drawn resolved, as a sphere of its measured diameter (the shape is an assumption, estimated).'
      : ` It is never drawn resolved at ${L}: a sphere of its measured diameter would be an assumption (estimated).`;
  if (!o.field)
    return `This build has no small-body renderer: it is not drawn as a point; a marker shows where it is. Brightness inputs: ${inputs}${bright ? '' : ` — not all admitted at ${L}`}.${size}`;
  if (bright) return `Drawn by the small-body field as a point of its computed brightness, from ${inputs}.${size}`;
  const withheld = o.inputs.filter((i) => i.label === 'unknown' || !labelAllowed(i.label, o.level)).map((i) => `${i.what} (${i.label})`);
  return `Not drawn at ${L}: its brightness rests on ${withheld.join(', ')}, not admitted at this level. Only the selection ring shows where it is.${size}`;
}

/** Legend lines for small-body brightness labels, from the core header's column docs and label statistics. */
export function smallBodyLegend(t: SmallBodyTables): string[] {
  const h = t.core.header;
  const stats = (h.statistics?.labels ?? {}) as Record<string, Record<string, number>>;
  const counts = (k: string) =>
    stats[k] ? Object.entries(stats[k]).map(([l, n]) => `${n.toLocaleString('en-US')} ${l}`).join(', ') : 'counts not given';
  const cols = h.columns ?? {};
  const lines = [
    'Asteroids and comets are drawn as points by the small-body field. A point\'s brightness is computed from the absolute magnitude H and a phase law, and carries the worst label of those inputs.',
    `H: ${counts('H')}. ${cols.H?.method ?? ''}`.trim(),
    `G: ${counts('G')}. ${cols.G?.method ?? ''}`.trim(),
  ];
  if (stats.phaseFunctionHG1G2) lines.push(`Measured H-G1-G2 phase curves: ${counts('phaseFunctionHG1G2')}.`);
  const m1 = t.comets?.header.columns?.M1?.method;
  if (m1) lines.push(`Comets: ${m1}`);
  lines.push('At Strict a point is drawn only when all of its brightness inputs are measured or derived; the others are withheld (the HUD counts them). A resolved close-up needs a measured diameter; its spherical shape is an assumption (estimated).');
  return lines;
}
