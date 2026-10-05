// Inspector view-model: pure functions from a body + data + level to display rows. No DOM.

import type { Body, EphemHeader, EphemSegment, Label, LightData, Sourced } from '../data/schema';
import type { SurfaceLayer } from '../data/surfaces';
import type { OrientationSourcePort } from '../app/ports';
import { labelAllowed, worstOf, type ExistsLevel } from '../app/reality';
import { formatValue } from './format';
import type { ShapeStatus } from '../app/shapes';
import type { NightglowInfo } from '../app/nightglow';

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
export function ephemerisChain(ephs: { path: string; header: EphemHeader }[], id: number): { links: ChainLink[]; complete: boolean; sources: string[] } {
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

export interface AttributeContext {
  /** Orientation in use at the current epoch (OrientationSet.provenance); undefined → not shown. */
  orientation?: OrientationSourcePort | null;
  /** The ephemeris file(s) this body needs are still loading. */
  loading?: string | null;
  /** Surface map layers for this body (surfaces/<id>/<layer>.json). */
  surfaces?: SurfaceLayer[];
  /** Shape model status (app/shapes.ts), when the body has one. */
  shape?: ShapeStatus | null;
  /** The Earth's airglow and aurora at the current time (app/nightglow.ts NightglowSource.info). */
  nightglow?: NightglowInfo | null;
}

export function attributeRows(body: Body, level: ExistsLevel, ephs: { path: string; header: EphemHeader }[], ctx: AttributeContext = {}): AttrRow[] {
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
      value: `SPK type ${types} segments ${path}${chain.complete ? ' (SSB)' : ' — chain to the SSB is incomplete'}${ctx.loading ? ` — ${ctx.loading}` : ''}`,
      method: `Chebyshev ephemeris from ${files}, evaluated at the light-emission epoch; the light-time correction makes the drawn position derived.`,
      sources: chain.sources,
      withheld: false,
    });
  } else {
    rows.push({ key: 'position', name: 'Position (ephemeris)', label: 'unknown', value: 'unknown — no ephemeris segment for this body', sources: [], withheld: false });
  }
  rows.push(row('radii', 'Shape (triaxial radii)', body.radii, level, 'radii'));
  const sr = shapeRow(ctx.shape ?? null, level);
  if (sr) rows.push(sr);
  rows.push(row('gm', 'GM', body.gm, level));
  if (ctx.orientation !== undefined) {
    const o = ctx.orientation;
    rows.push(
      o
        ? {
            key: 'orientation',
            name: o.kind === 'precise' ? `Orientation in use: ${o.frame} (precise product)` : 'Orientation in use: IAU rotation model',
            label: o.label,
            value: o.kind === 'precise' ? `${o.frame} body-fixed frame from a binary PCK product, evaluated at the light-emission epoch` : 'IAU/WGCCRE model below, evaluated at the light-emission epoch',
            ...(o.method ? { method: o.method } : {}),
            ...(o.uncertainty ? { uncertainty: o.uncertainty } : {}),
            sources: o.sources,
            withheld: o.label !== 'unknown' && !labelAllowed(o.label, level),
          }
        : { key: 'orientation', name: 'Orientation in use', label: 'unknown', value: 'unknown — no rotation model or precise product covers this epoch', sources: [], withheld: false },
    );
  }
  rows.push(row('rotation', 'Rotation model (IAU)', body.rotation, level, 'rotation'));
  const p = body.photometry;
  rows.push(row('albedoXYZS', 'Geometric albedo (XYZ + scotopic)', p?.geometricAlbedoXYZS, level, 'xyzs'));
  rows.push(row('albedoV', 'Geometric albedo (V)', p?.geometricAlbedoV, level));
  rows.push(row('phase', 'Phase function', p?.phaseFunction, level, 'phase'));
  for (const sl of ctx.surfaces ?? []) {
    // An albedo map carries a brightness pattern and a colour; the drawn map is as grounded as the worse (extras.ts).
    const label = sl.layer === 'albedo' && sl.colorLabel ? worstOf([sl.label, sl.colorLabel]) : sl.label;
    const cover = typeof sl.coverage === 'number' ? `, ${Math.round(sl.coverage * 100)}% of the surface covered` : '';
    rows.push({
      key: `surface:${sl.layer}`,
      name: `Surface map: ${sl.layer}`,
      label,
      value: `${sl.levels ?? '?'} pyramid levels, ${sl.tiles.count} tiles${cover}${sl.epoch ? `, observed ${sl.epoch}` : ''}`,
      ...(sl.method ? { method: sl.method } : sl.notes ? { method: sl.notes } : {}),
      sources: sl.sources,
      withheld: label !== 'unknown' && !labelAllowed(label, level),
    });
  }
  if (ctx.nightglow) rows.push(...nightglowRows(ctx.nightglow, level));
  return rows;
}

const sig = (x: number, n = 3) => Number(x.toPrecision(n)).toString();

/** The Earth's own light at night: what the airglow and the aurora are based on, and whether they are drawn. */
export function nightglowRows(info: NightglowInfo, level: ExistsLevel): AttrRow[] {
  const rows: AttrRow[] = [];
  const a = info.airglow;
  if (a) {
    const srf = a.srf ? `10.7 cm solar flux (27-day mean) ${sig(a.srf.sfu)} sfu on ${a.srf.day} (${a.srf.label}${a.srf.label === 'estimated' ? ': partly predicted' : ': observed'})` : 'no solar flux for this day';
    rows.push({
      key: 'airglow',
      name: 'Airglow (PALACE climatology, measured at Cerro Paranal)',
      label: a.label,
      value: a.drawn
        ? `drawn on the night side; zenith luminance near local midnight ${a.zenithY !== null ? sig(a.zenithY) : 'unknown'} cd/m²; ${srf}`
        : `not drawn — ${a.reason ?? 'unknown'}; ${srf}`,
      method: a.method,
      uncertainty: a.uncertainty,
      sources: a.sources,
      withheld: !a.drawn && a.label !== 'unknown' && !labelAllowed(a.label, level),
    });
  }
  const u = info.aurora;
  if (u) {
    const c = u.coupling;
    const drive = c.measured
      ? `solar-wind coupling dΦ/dt ${sig(c.value)} (from OMNI measurements, ${c.label})`
      : `solar-wind coupling ${sig(c.value)}: climatological median (${c.label}) — no measured solar wind at this time (measured until ${c.measuredUntil.slice(0, 16).replace('T', ' ')} UT)`;
    rows.push({
      key: 'aurora',
      name: 'Aurora (OVATION Prime 2010 + emission model)',
      label: u.label,
      value: u.drawn ? `drawn: electron aurora, ${drive}` : `not drawn — ${u.reason ?? 'unknown'}; ${drive}`,
      method: u.method,
      uncertainty: u.uncertainty,
      sources: u.sources,
      withheld: !u.drawn && u.label !== 'unknown' && !labelAllowed(u.label, level),
    });
  }
  return rows;
}

/**
 * The shape model row: drawn (the mesh replaces the ellipsoid; its shape and orientation labels) or why not
 * (loading, a label not admitted at the level, an orientation that cannot be placed).
 */
export function shapeRow(s: ShapeStatus | null, level: ExistsLevel): AttrRow | null {
  if (!s) return null;
  const label = s.label ?? 'unknown';
  const oLabel = s.orientationLabel;
  const withheld = !s.drawn && ((s.label !== undefined && !labelAllowed(s.label, level)) || (oLabel !== undefined && oLabel !== 'unknown' && !labelAllowed(oLabel, level)));
  return {
    key: 'shape',
    name: s.drawn ? 'Shape model (mesh drawn)' : 'Shape model (not drawn: ellipsoid or point instead)',
    label: s.drawn ? worstOf([label, oLabel ?? label]) : label,
    value: s.text + (oLabel ? ` — orientation ${oLabel}` : ''),
    method: s.drawn
      ? 'The disk photometry (albedo with the reference radius, phase function) is spread over the mesh, scaled by πR² over the mean projected area of the mesh; the brightness is derived (docs/rendering-shapes.md).'
      : undefined,
    sources: s.sources ?? [],
    withheld,
  };
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
