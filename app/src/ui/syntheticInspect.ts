// Inspector view-model for a synthetic object (the COMPLETE level; pipeline stage synthetic): what it stands for
// (its population model, cell, the numbers of the conditioning, its seed) and its attributes, every one labelled
// synthetic. Pure, no DOM. Every number comes from synthetic/objects + cells and their headers.

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
  if (p.name === 'neo') return `the debiased NEO model of Granvik et al. (2018): a realization of ${n0(Number(m.members ?? 0))} NEOs with 17 < H < 25; this object is one of its members`;
  if (p.name === 'tno') return `the CFEPS L7 debiased Kuiper-belt model (Petit et al. 2011; Gladman et al. 2012): a realization of ${n0(Number(m.members ?? 0))} objects to H_g 8.5 (H_V = H_g ${fmt(Number(m.vMinusG ?? 0), 3)}); this object is one of its members, moved two-body from the model epoch`;
  if (p.name === 'centaur') {
    const r = (m.realization ?? {}) as Record<string, number>;
    return `the debiased Centaur population of Kurlander et al. (2025): ${n0(Number((m.normalization as Record<string, number> | undefined)?.nBelowHr ?? 0))} Centaurs with H_r < 13.7, orbits of the Nesvorný et al. (2019) dynamical model and the Lawler et al. (2018) H law; one realization of ${n0(Number(m.members ?? 0))} members (H_V = H_r + ${fmt(Number(r.vMinusR ?? 0), 3)}), the archive's magnitude selection undone by weighting each model orbit by 1/P(selected); this object is one of its members, with uniform angles (as Murtagh et al. 2025)`;
  }
  if (p.center) {
    const mm = m.model as Record<string, unknown> | undefined;
    const src = String(mm?.source ?? '');
    const who = src.startsWith('ashton-2020') ? 'Ashton et al. (2020)' : src.startsWith('ashton-2021') ? 'Ashton et al. (2021)' : src;
    if (!mm || mm.none) return `no debiased population below the completeness limit (${String(mm?.none ?? '')})`;
    return `the debiased population of ${String(m.planet ?? '')}'s ${m.moonClass === 'retrograde' ? 'retrograde ' : ''}irregular moons of ${who}: ${fmt(Number(mm.nInRange ?? 0), 4)} moons with H_V ${fmt(Number(mm.hLoV), 4)}–${fmt(Number(mm.hHiV), 4)} (dN/dH ∝ 10^(${mm.alpha}·H)), put on the MPC H_V scale with the survey's own photometry of known moons; orbit distribution: that of the known moons brighter than the limit (an assumption: no debiased orbit model exists)`;
  }
  const slope = m.slope as Record<string, unknown> | undefined;
  const a = slope?.alphaFaint ?? slope?.alpha;
  const src = String(slope?.source ?? '');
  const who = src.startsWith('maeda') ? 'Maeda et al. (2021)' : src.startsWith('terai') ? 'Terai & Yoshida (2018)' : src.startsWith('yoshida') ? 'Yoshida & Terai (2017)' : src;
  return `the catalogue itself, complete to its Hendler & Malhotra (2020) limit, continued to fainter H with the debiased slope dN/dH ∝ 10^(${a}·H) of ${who}; orbit distribution in (e, i) from the complete catalogue at the same a`;
}

/** How an irregular-moon model was put on the MPC H_V scale (empty for other populations). */
function calibrationText(p: SyntheticPopulation): string {
  const c = p.limit.calibration as { offset?: number; offsetSigma?: number | null; n?: number } | undefined;
  if (!c || c.offset === undefined) return '';
  return ` The model's magnitudes are put on the MPC H_V scale with H_V = m ${c.offset < 0 ? '−' : '+'} ${fmt(Math.abs(c.offset), 4)}${c.offsetSigma ? ` ± ${fmt(c.offsetSigma, 2)}` : ''}, the median offset over the survey's photometry of ${c.n} known moons.`;
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
    const about = pop.center ? ` about the ${pop.center.name}` : '';
    const catalogue = pop.center ? 'the MPC list of known moons' : 'the catalogue';
    what = `Not a real object. It stands in for one of ~${fmt(stand, 3)} undiscovered ${popText} in its cell (a ${fmt(c.a[0], 4)}–${fmt(c.a[1], 4)} au${about}, e ${fmt(c.e[0], 3)}–${fmt(c.e[1], 3)}, i ${fmt(c.i[0], 3)}°–${fmt(c.i[1], 3)}°, H ${fmt(c.h[0], 4)}–${fmt(c.h[1], 4)}). The model (${modelText(pop)}) expects ${fmt(c.nModel, 4)} objects there; ${catalogue} has ${n0(c.nObs)}, complete down to H ${fmt(c.hLim, 4)}${pop.center ? '' : ' at this a'}, so ${fmt(c.deficit, 4)} are missing and ${n0(c.nShown)} synthetic objects are shown in this cell. When surveys find more, the deficit falls and synthetic objects are removed from the end of the cell's list.`;
    rows.push(row('cell', 'Stands in for', `${fmt(c.deficit, 4)} undiscovered objects (model ${fmt(c.nModel, 4)} − catalogued ${n0(c.nObs)}; raw deficit ${fmt(c.rawDeficit, 4)}) in cell ${cellRow.toLocaleString('en-US')} of ${pop.name}: a ${fmt(c.a[0], 4)}–${fmt(c.a[1], 4)} au, e ${fmt(c.e[0], 3)}–${fmt(c.e[1], 3)}, i ${fmt(c.i[0], 3)}°–${fmt(c.i[1], 3)}°, H ${fmt(c.h[0], 4)}–${fmt(c.h[1], 4)}; ${n0(c.nShown)} shown`,
      `Model: ${modelText(pop)}. Deficit per cell = max(0, model − catalogued), each (a, H) group scaled to its total model − catalogued (no Poisson bias from clipping small cells). ${s.header.yieldRule}.`));
    rows.push(row('limit', 'Survey completeness limit here', `H ${fmt(c.hLim, 4)} (no synthetic object is brighter)`,
      String(pop.limit.method) === 'hendler-malhotra-2020'
        ? `Hendler & Malhotra (2020): H_lim(a) = −5 log10(a (a − 1 au)) + C, C = ${fmt(Number((pop.limit.fit as Record<string, number>)?.C ?? NaN), 5)} refitted to this catalogue (the most populated 0.25-mag H bin per 0.01-au a-bin).`
        : `First H bin (bright to faint) in which the catalogue has significantly fewer objects than the model: ${String(pop.limit.rule ?? '')}.${calibrationText(pop)}`,
      pop.sources));
    rows.push(row('seed', 'Seed and place in the cell', `candidate ${n0(k)} of the stream '${pop.prefix}|${c.ia}|${c.ie}|${c.ii}|${c.ih}' (seed ${s.header.seed}, algorithm ${s.header.algorithm})`, s.header.seedRule, []));
  }
  if (pop?.center) {
    const motion = String((pop.model as Record<string, unknown>).motion ?? '');
    rows.push(row('orbit', `Orbit (osculating, about the ${pop.center.name}, ecliptic J2000 axes${epochTdb ? `, at ${epochTdb} TDB` : ''})`,
      `a ${fmt(get('a'), 6)} au (${n0(get('a') * s.auKm)} km), e ${fmt(get('e'), 4)}, i ${fmt(get('i'), 4)}°, Ω ${fmt(get('node'), 5)}°, ω ${fmt(get('peri'), 5)}°, M ${fmt(get('M'), 5)}°`,
      `a, e, i uniform in the cell box; the cells are those of the known moons brighter than the limit (an assumption: no debiased orbit model of irregular moons exists); node, argument of pericentre and mean anomaly uniform. Motion: ${motion}`));
  } else {
    rows.push(row('orbit', `Orbit (osculating, heliocentric ecliptic J2000${epochTdb ? `, at ${epochTdb} TDB` : ''})`,
      `a ${fmt(get('a'), 6)} au, e ${fmt(get('e'), 4)}, i ${fmt(get('i'), 4)}°, Ω ${fmt(get('node'), 5)}°, ω ${fmt(get('peri'), 5)}°, M ${fmt(get('M'), 5)}°`,
      'Sampled within the cell (catalogue-extrapolated populations: a, e, i uniform in the cell box, angles uniform, or for Trojans and Hildas their resonant angles drawn from the catalogued ones; model populations: the model object). Moves on this fixed Kepler ellipse (two-body): planetary perturbations would not make a statistical orbit any more real.'));
  }
  rows.push(row('H', 'Absolute magnitude H', `${fmt(get('H'), 4)} mag`, cols.H?.method));
  if (s.header.slopeParameterG) rows.push(row('G', 'Slope parameter G (H-G law)', fmt(s.header.slopeParameterG.value, 3), s.header.slopeParameterG.method, [s.header.slopeParameterG.source, ...src]));
  const pv = get('pV');
  if (Number.isFinite(pv)) {
    rows.push(row('pV', 'Geometric albedo p_V', fmt(pv, 3), cols.pV?.method));
    rows.push(row('D', 'Diameter (from H and p_V)', `${fmt(diameterFromH(get('H'), pv), 3)} km`, 'D = 1329 km / √p_V · 10^(−H/5) (Pravec & Harris 2007).'));
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
