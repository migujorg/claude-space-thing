// Inspector view-model: pure functions from a body + data + level to display rows. No DOM.

import type { Body, EphemSegment, Label, LightData, Sourced } from '../data/schema';
import type { LoadedEphemeris } from '../data/load';
import { labelAllowed, worstOf, type ExistsLevel } from '../app/reality';
import { formatValue } from './format';

export interface AttrRow {
  key: string;
  name: string;
  label: Label;
  value: string;
  method?: string;
  uncertainty?: string;
  sources: string[];
  /** Has a value, but its label is not admitted at the current level. */
  withheld: boolean;
}

export interface ChainLink {
  file: string;
  seg: EphemSegment;
}

/** Segments from `id` down to the SSB (0), following each segment's center. */
export function ephemerisChain(ephs: LoadedEphemeris[], id: number): { links: ChainLink[]; complete: boolean; sources: string[] } {
  const links: ChainLink[] = [];
  const seen = new Set<number>();
  let cur = id;
  while (cur !== 0 && !seen.has(cur)) {
    seen.add(cur);
    let found: ChainLink | null = null;
    for (const e of ephs) {
      const s = e.header.segments.find((x) => x.target === cur);
      if (s) { found = { file: e.path, seg: s }; break; }
    }
    if (!found) return { links, complete: false, sources: uniq(links.flatMap((l) => l.seg.sources)) };
    links.push(found);
    cur = found.seg.center;
  }
  return { links, complete: cur === 0, sources: uniq(links.flatMap((l) => l.seg.sources)) };
}

function uniq<T>(a: T[]): T[] {
  return [...new Set(a)];
}

function row<T>(key: string, name: string, s: Sourced<T> | undefined, level: ExistsLevel, kind?: Parameters<typeof formatValue>[2]): AttrRow {
  if (!s) return { key, name, label: 'unknown', value: 'unknown', sources: [], withheld: false, method: 'Not provided by the data products.' };
  const hasValue = s.value !== null && s.value !== undefined;
  return {
    key,
    name,
    label: s.label,
    value: hasValue ? formatValue(s.value, s.unit, kind) : 'unknown',
    ...(s.method ? { method: s.method } : {}),
    ...(s.uncertainty ? { uncertainty: s.uncertainty } : {}),
    sources: s.sources ?? [],
    withheld: hasValue && !labelAllowed(s.label, level),
  };
}

export function attributeRows(body: Body, level: ExistsLevel, ephs: LoadedEphemeris[]): AttrRow[] {
  const rows: AttrRow[] = [];
  const chain = ephemerisChain(ephs, body.id);
  if (chain.links.length) {
    const path = [body.id, ...chain.links.map((l) => l.seg.center)].join(' → ');
    const types = uniq(chain.links.map((l) => l.seg.type)).join('/');
    const files = uniq(chain.links.map((l) => l.file.replace(/^ephem\//, ''))).join(', ');
    rows.push({
      key: 'position',
      name: 'Position (ephemeris)',
      // A chain is only as grounded as its least grounded segment (e.g. a fitted planet-center offset).
      label: worstOf(chain.links.map((l) => l.seg.label ?? 'unknown')),
      value: `SPK type ${types} segments ${path}${chain.complete ? ' (SSB)' : ' — chain to the SSB is incomplete'}`,
      method: `Chebyshev ephemeris from ${files}, evaluated at the light-emission epoch; the light-time correction makes the drawn position derived.`,
      sources: chain.sources,
      withheld: false,
    });
  } else {
    rows.push({ key: 'position', name: 'Position (ephemeris)', label: 'unknown', value: 'unknown — no ephemeris segment for this body', sources: [], withheld: false });
  }
  rows.push(row('radii', 'Shape (triaxial radii)', body.radii, level, 'radii'));
  rows.push(row('gm', 'GM', body.gm, level));
  rows.push(row('rotation', 'Rotation model', body.rotation, level, 'rotation'));
  const p = body.photometry;
  rows.push(row('albedoXYZS', 'Geometric albedo (XYZ + scotopic)', p?.geometricAlbedoXYZS, level, 'xyzs'));
  rows.push(row('albedoV', 'Geometric albedo (V)', p?.geometricAlbedoV, level));
  rows.push(row('phase', 'Phase function', p?.phaseFunction, level, 'phase'));
  return rows;
}

/** light.json attributes the renderer uses to draw the Sun. */
export function sunRows(light: LightData | null, level: ExistsLevel): AttrRow[] {
  if (!light) return [{ key: 'light', name: 'Sunlight (light.json)', label: 'unknown', value: 'unknown — light.json is missing', sources: [], withheld: false }];
  const ld = light.sun.limbDarkening;
  const ldRow = row('limbDarkening', 'Limb darkening', ld, level);
  if (ld?.value) ldRow.value = `I(μ)/I(1) polynomial in μ, ${ld.value.coeffsXYZS.map((c) => c.length).join('/')} coefficients (X/Y/Z/S)`;
  return [
    row('irradiance', 'Irradiance at 1 AU (XYZ + scotopic)', light.sun.irradianceXYZS_1AU, level, 'xyzs'),
    row('sunRadius', 'Photospheric radius (disk)', light.sun.radius, level),
    ldRow,
  ];
}

/** "Why does it look like this" for the Sun, which is drawn from light.json rather than photometry. */
export function sunWhy(light: LightData | null, level: ExistsLevel, drawn: boolean, reason?: string): string {
  if (!drawn) return `The Sun is not drawn: ${reason ?? 'unknown reason'}`;
  const used = sunRows(light, level).filter((r) => r.label !== 'unknown' && !r.withheld).map((r) => `${r.name} (${r.label})`);
  const ld = light?.sun.limbDarkening;
  const ldOk = !!ld?.value && labelAllowed(ld.label, level);
  return `The Sun is drawn from light.json: ${used.join(', ')}.${ldOk ? '' : ' Limb darkening is not admitted, so no uniform disk is assumed: the renderer shows it as unresolved light and says so.'}`;
}

/** Label for a quantity derived from inputs (position is derived; add the others' labels). */
export function derivedLabel(...inputs: Label[]): Label {
  return worstOf(['derived', ...inputs]);
}
