// Moments panel view-model: provenance of an event (which files, sources and labels it rests on), time
// formatting and list selection. No DOM.

import type { AppModel } from '../app/model';
import type { SkyEvent } from '../app/events/finder';
import { sbRow } from '../app/smallbodies';
import { sourcesOf } from '../app/smallbodies';
import type { Label } from '../data/schema';
import { derivedLabel, ephemerisChain } from './inspectModel';

export interface ProvenancePart {
  /** What the input is ("Earth position", "Earth orientation", "Moon radii"). */
  what: string;
  label: Label;
  /** Files it comes from. */
  files: string[];
  sources: string[];
}

export interface EventProvenance {
  /** The event's label: at least derived, and the worst of its inputs. */
  label: Label;
  parts: ProvenancePart[];
  files: string[];
  sources: string[];
}

const uniq = <T,>(a: T[]): T[] => [...new Set(a)];

/** Inputs of an event (positions, orientations, radii), each with its label, files and sources. */
export function eventProvenance(m: AppModel, ev: Pick<SkyEvent, 'bodies' | 'orientations' | 'et'>): EventProvenance {
  const parts: ProvenancePart[] = [];
  const ephs = [...(m.data?.ephemerides ?? []), ...(m.data?.deferred ?? [])];
  for (const id of ev.bodies) {
    if (id < 0) {
      const sb = m.smallBodies, row = sbRow(id);
      if (!sb) continue;
      const fm = sb.tables.core.header.forceModel;
      parts.push({
        what: `${m.bodyName(id)} position`,
        label: sb.posLabel(row),
        files: ['smallbodies/core.bin', ...(sb.tables.nongrav ? ['smallbodies/nongrav.bin'] : []), `${fm.ephemeris}.json`],
        sources: uniq([...sourcesOf(sb.tables.core, 'orbitSrc', row), ...(fm.perturberSources ?? [])]),
      });
      continue;
    }
    const chain = ephemerisChain(ephs, id);
    parts.push({ what: `${m.bodyName(id)} position`, label: m.chainLabel(id, ev.et), files: uniq(chain.links.map((l) => l.file)), sources: chain.sources });
    const r = m.byId.get(id)?.radii;
    if (r?.value) parts.push({ what: `${m.bodyName(id)} radii`, label: r.label, files: ['bodies.json'], sources: r.sources ?? [] });
  }
  for (const id of ev.orientations ?? []) {
    const o = m.orientations.provenance(id, ev.et);
    if (!o) continue;
    const file = o.kind === 'precise' ? m.data?.orientations.find((p) => Object.keys(p.header.bodies).includes(String(id)))?.path : 'bodies.json';
    parts.push({ what: `${m.bodyName(id)} orientation (${o.kind === 'precise' ? o.frame : 'IAU rotation model'})`, label: o.label, files: file ? [file] : [], sources: o.sources });
  }
  return {
    label: derivedLabel(...parts.map((p) => p.label)),
    parts,
    files: uniq(parts.flatMap((p) => p.files)),
    sources: uniq(parts.flatMap((p) => p.sources)),
  };
}

/** "2027-08-02 10:06 UTC" (or TDB seconds without time.json). */
export function eventTime(m: AppModel, et: number, seconds = false): string {
  const ms = m.utcMs(et);
  if (ms === null) return `TDB ${et.toFixed(0)} s`;
  const iso = new Date(Math.round(ms / 1000) * 1000).toISOString();
  return `${iso.slice(0, seconds ? 19 : 16).replace('T', ' ')} UTC`;
}

/** Title with the small body's name, when the event is about one. */
export function eventTitle(m: AppModel, ev: SkyEvent): string {
  const sb = ev.bodies.find((id) => id < 0);
  return sb !== undefined ? `${m.bodyName(sb)}: ${ev.title[0].toLowerCase()}${ev.title.slice(1)}` : ev.title;
}

export const JOVIAN_TYPES: [string, string][] = [
  ['all', 'all phenomena'],
  ['double-shadow', 'two shadows at once'],
  ['triple-shadow', 'three shadows at once'],
  ['shadow-transit', 'shadow transits'],
  ['transit', 'transits'],
  ['occultation', 'occultations'],
  ['eclipse', 'eclipses'],
];

/** `n` events around a time: the first at or after `et`, with up to `before` earlier ones. */
export function around(events: SkyEvent[], et: number, n: number, before = 0): { list: SkyEvent[]; first: number } {
  const sorted = [...events].sort((a, b) => a.et - b.et);
  let i = sorted.findIndex((e) => e.et >= et);
  if (i < 0) i = Math.max(0, sorted.length - n);
  const first = Math.max(0, Math.min(i - before, sorted.length - n));
  return { list: sorted.slice(first, first + n), first };
}
