// Inspector view-model for a synthetic object (the COMPLETE level; pipeline stage synthetic): what it stands for
// (its population model, cell, the numbers of the conditioning, its seed) and its attributes, every one labelled
// synthetic. Pure, no DOM. Numbers come from synthetic/objects + cells and their headers, or cited core constants.

import { CFEPS_L7_HG_MAX, D_H_CONSTANT_KM } from '../core/constants';
import type { SyntheticPopulation } from '../data/schema';
import { SYNTHETIC_POP_TEXT } from '../app/smallbodies';
import { EXISTS_TEXT, labelAllowed, type ExistsLevel } from '../app/reality';
import { diameterFromH, syntheticCell, syntheticPopulation, type SyntheticCatalog } from '../core/smallbodySynthetic';
import type { AttrRow } from './inspectModel';

const fmt = (x: number, n = 5): string => String(Number(x.toPrecision(n)));
const n0 = (x: number): string => Math.round(x).toLocaleString('en-US');

/** Human description of a population model (its modelId and sources). */
function modelText(p: SyntheticPopulation): string {
  const m = p.model as Record<string, unknown>;
  const hRange = Array.isArray(m.hRange) ? m.hRange : [];
  const hBound = (k: number) => typeof hRange[k] === 'number' && Number.isFinite(hRange[k]) ? hRange[k] : 'unknown';
  if (p.name === 'neo') return `the debiased NEO model of Granvik et al. (2018): a realization of ${n0(Number(m.members ?? 0))} NEOs with ${hBound(0)} < H < ${hBound(1)}; this object is one of its members`;
  if (p.name === 'tno') return `the CFEPS L7 debiased Kuiper-belt model (Petit et al. 2011; Gladman et al. 2012): a realization of ${n0(Number(m.members ?? 0))} objects to H_g ${CFEPS_L7_HG_MAX} (H_V = H_g ${fmt(Number(m.vMinusG ?? 0), 3)}); this object is one of its members, moved two-body from the model epoch`;
  const slope = m.slope as Record<string, unknown> | undefined;
  const a = slope?.alphaFaint ?? slope?.alpha;
  const src = String(slope?.source ?? '');
  const who = src.startsWith('maeda') ? 'Maeda et al. (2021)' : src.startsWith('terai') ? 'Terai & Yoshida (2018)' : src.startsWith('yoshida') ? 'Yoshida & Terai (2017)' : src;
  return `the catalogue itself, complete to its Hendler & Malhotra (2020) limit, continued to fainter H with the debiased slope dN/dH ∝ 10^(${a}·H) of ${who}; orbit distribution in (e, i) from the complete catalogue at the same a`;
}

export interface SyntheticFacts {
  rows: AttrRow[];
  population: SyntheticPopulation | null;
  /** One paragraph: what this object is and is not. */
  what: string;
}

/** Everything about synthetic object j at a level (all rows labelled synthetic: withheld below Complete). */
export function syntheticFacts(s: SyntheticCatalog, j: number, level: ExistsLevel, epochTdb: string | undefined): SyntheticFacts {
  const t = s.table;
  const get = (f: string) => (t.has(f) ? t.get(f, j) : NaN);
  const pop = syntheticPopulation(s, j);
  const cellRow = get('cell');
  const c = syntheticCell(s, cellRow);
  const k = get('k');
  const src = pop?.sources ?? [];
  const withheld = !labelAllowed('synthetic', level);
  const row = (key: string, name: string, value: string, method?: string, sources = src): AttrRow => ({ key: `syn:${key}`, name, label: 'synthetic', value, sources, withheld, ...(method ? { method } : {}) });
  const cols = s.header.columns ?? {};
  const rows: AttrRow[] = [];
  const popText = pop ? SYNTHETIC_POP_TEXT[pop.name]?.plural ?? `${pop.name} objects` : 'objects';
  let what = `Not a real object. It stands in for one of the ${popText} that no survey has found yet.`;
  if (pop && c) {
    const stand = c.deficit;
    what = `Not a real object. It stands in for one of ~${fmt(stand, 3)} undiscovered ${popText} in its cell (a ${fmt(c.a[0], 4)}–${fmt(c.a[1], 4)} au, e ${fmt(c.e[0], 3)}–${fmt(c.e[1], 3)}, i ${fmt(c.i[0], 3)}°–${fmt(c.i[1], 3)}°, H ${fmt(c.h[0], 4)}–${fmt(c.h[1], 4)}). The model (${modelText(pop)}) expects ${fmt(c.nModel, 4)} objects there; the catalogue has ${n0(c.nObs)}, complete down to H ${fmt(c.hLim, 4)} at this a, so ${fmt(c.deficit, 4)} are missing and ${n0(c.nShown)} synthetic objects are shown in this cell. When surveys find more, the deficit falls and synthetic objects are removed from the end of the cell's list.`;
    rows.push(row('cell', 'Stands in for', `${fmt(c.deficit, 4)} undiscovered objects (model ${fmt(c.nModel, 4)} − catalogued ${n0(c.nObs)}; raw deficit ${fmt(c.rawDeficit, 4)}) in cell ${cellRow.toLocaleString('en-US')} of ${pop.name}: a ${fmt(c.a[0], 4)}–${fmt(c.a[1], 4)} au, e ${fmt(c.e[0], 3)}–${fmt(c.e[1], 3)}, i ${fmt(c.i[0], 3)}°–${fmt(c.i[1], 3)}°, H ${fmt(c.h[0], 4)}–${fmt(c.h[1], 4)}; ${n0(c.nShown)} shown`,
      `Model: ${modelText(pop)}. Deficit per cell = max(0, model − catalogued), each (a, H) group scaled to its total model − catalogued (no Poisson bias from clipping small cells). ${s.header.yieldRule}.`));
    rows.push(row('limit', 'Survey completeness limit here', `H ${fmt(c.hLim, 4)} (no synthetic object is brighter)`,
      String(pop.limit.method) === 'hendler-malhotra-2020'
        ? `Hendler & Malhotra (2020): H_lim(a) = −5 log10(a (a − 1 au)) + C, C = ${fmt(Number((pop.limit.fit as Record<string, number>)?.C ?? NaN), 5)} refitted to this catalogue (the most populated 0.25-mag H bin per 0.01-au a-bin).`
        : `First H bin (bright to faint) in which the catalogue has significantly fewer objects than the model: ${String(pop.limit.rule ?? '')}.`,
      pop.sources));
    rows.push(row('seed', 'Seed and place in the cell', `candidate ${n0(k)} of the stream '${pop.prefix}|${c.ia}|${c.ie}|${c.ii}|${c.ih}' (seed ${s.header.seed}, algorithm ${s.header.algorithm})`, s.header.seedRule, []));
  }
  rows.push(row('orbit', `Orbit (osculating, heliocentric ecliptic J2000${epochTdb ? `, at ${epochTdb} TDB` : ''})`,
    `a ${fmt(get('a'), 6)} au, e ${fmt(get('e'), 4)}, i ${fmt(get('i'), 4)}°, Ω ${fmt(get('node'), 5)}°, ω ${fmt(get('peri'), 5)}°, M ${fmt(get('M'), 5)}°`,
    'Sampled within the cell (catalogue-extrapolated populations: a, e, i uniform in the cell box, angles uniform, or for Trojans and Hildas their resonant angles drawn from the catalogued ones; model populations: the model object). Moves on this fixed Kepler ellipse (two-body): planetary perturbations would not make a statistical orbit any more real.'));
  rows.push(row('H', 'Absolute magnitude H', `${fmt(get('H'), 4)} mag`, cols.H?.method));
  if (s.header.slopeParameterG) rows.push(row('G', 'Slope parameter G (H-G law)', fmt(s.header.slopeParameterG.value, 3), s.header.slopeParameterG.method, [s.header.slopeParameterG.source, ...src]));
  const pv = get('pV');
  if (Number.isFinite(pv)) {
    rows.push(row('pV', 'Geometric albedo p_V', fmt(pv, 3), cols.pV?.method));
    rows.push(row('D', 'Diameter (from H and p_V)', `${fmt(diameterFromH(get('H'), pv), 3)} km`, `D = ${D_H_CONSTANT_KM} km / √p_V · 10^(−H/5) (Pravec & Harris 2007).`));
  }
  const rot = get('rotPeriod');
  if (Number.isFinite(rot)) rows.push(row('rot', 'Rotation period', `${fmt(rot, 4)} h`, cols.rotPeriod?.method));
  return { rows, population: pop, what };
}

/** "Why does it look like this" for a synthetic object. */
export function syntheticWhy(level: ExistsLevel, field: boolean, drawnByField: boolean): string {
  const L = EXISTS_TEXT[level].name;
  if (!labelAllowed('synthetic', level)) return `A synthetic object: it exists only at ${EXISTS_TEXT.complete.name}. At ${L} it is not drawn at all.`;
  if (!field) return 'A synthetic object; this build has no small-body renderer, so it is not drawn (a marker shows where it would be).';
  if (!drawnByField) return 'A synthetic object; the synthetic layer does not fit this device, so it is not drawn.';
  return 'A synthetic object, drawn as a point of the brightness its synthetic H gives (H-G law); never drawn resolved. Every attribute is synthetic.';
}
