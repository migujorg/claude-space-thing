// Inspector view-model: pure functions from a body + data + level to display rows. No DOM.

import type { AtmosphereFile, Body, EphemHeader, EphemSegment, Label, LightData, RingSystem, Sourced } from '../data/schema';
import type { SurfaceLayer } from '../data/surfaces';
import type { EphemerisSourcePort, OrientationSourcePort } from '../app/ports';
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
  /** Evaluator-selected chain at this body's frame emission epoch; absent/null → no coverage. */
  ephemeris?: EphemerisSourcePort | null;
  /** Orientation in use at the current epoch (OrientationSet.provenance); undefined → not shown. */
  orientation?: OrientationSourcePort | null;
  /** The ephemeris file(s) this body needs are still loading. */
  loading?: string | null;
  /** Surface map layers for this body (surfaces/<id>/<layer>.json). */
  surfaces?: SurfaceLayer[];
  /** Shape model status (app/shapes.ts), when the body has one. */
  shape?: ShapeStatus | null;
  /** atmospheres.json, for the body's atmosphere rows (atmosphereRows). */
  atmospheres?: AtmosphereFile | null;
  /** The Earth's airglow and aurora at the current time (app/nightglow.ts NightglowSource.info). */
  nightglow?: NightglowInfo | null;
  /** The body's ring system (rings.json), when it has one. */
  rings?: RingSystem | null;
}

export function attributeRows(body: Body, level: ExistsLevel, ephs: { path: string; header: EphemHeader }[], ctx: AttributeContext = {}): AttrRow[] {
  const rows: AttrRow[] = [];
  const chain = ctx.ephemeris;
  if (chain?.links.length) {
    const path = [body.id, ...chain.links.map((l) => l.seg.center)].join(' → ');
    const types = uniq(chain.links.map((l) => l.seg.type)).join('/');
    // Match the owning header by identity; target lookup would select the wrong duplicate product.
    const fileOf = (header: EphemHeader) => (ephs.find((e) => e.header === header)?.path ?? header.bin).replace(/^ephem\//, '');
    const files = uniq(chain.links.map((l) => fileOf(l.header))).join(', ');
    const details = chain.links.map(({ header, seg }) => `${seg.target} → ${seg.center}: ${fileOf(header)} segment ${header.segments.indexOf(seg) + 1} (SPK type ${seg.type}, ${seg.label ?? 'unknown'}; sources: ${seg.sources.join(', ') || 'none recorded'})`).join('; ');
    rows.push({
      key: 'position',
      name: 'Position (ephemeris)',
      // A chain is only as grounded as its least grounded segment (e.g. a fitted planet-center offset).
      label: chain.label,
      value: `SPK type ${types} segments ${path} (SSB)${ctx.loading ? ` — ${ctx.loading}` : ''}`,
      method: `SPK ephemeris from ${files}, evaluated at the light-emission epoch; the light-time correction makes the drawn position derived. Links (1-based product segment indices): ${details}.`,
      sources: chain.sources,
      withheld: false,
    });
  } else {
    rows.push({ key: 'position', name: 'Position (ephemeris)', label: 'unknown', value: `unknown — no coverage: no complete ephemeris chain at this body's epoch${ctx.loading ? ` — ${ctx.loading}` : ''}`, sources: [], withheld: false });
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
  rows.push(...atmosphereRows(ctx.atmospheres ?? null, body.id, level));
  if (ctx.rings) rows.push(...ringRows(ctx.rings, level));
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
 * atmospheres.json rows of a body: one per component, labelled with the worst of its extinction, single-scattering
 * albedo and phase function (what the renderer needs of it), its vertical optical depth and albedo near 550 nm;
 * and the surface reflectance under the air of a body drawn from its atmosphere model (Titan).
 */
export function atmosphereRows(file: AtmosphereFile | null, id: number, level: ExistsLevel): AttrRow[] {
  const a = file?.bodies[String(id)];
  if (!file || !a || !a.components.length) return [];
  const wl = file.wavelengthsNm;
  let k550 = 0;
  wl.forEach((w, k) => { if (Math.abs(w - 550) < Math.abs(wl[k550] - 550)) k550 = k; });
  const rows: AttrRow[] = a.components.map((c) => {
    const parts = [c.extinctionPerKm, c.singleScatteringAlbedo, c.phaseFunction];
    const label = worstOf(parts.map((x) => x.label));
    const tau = c.columnOpticalDepth[k550];
    const ssa = c.singleScatteringAlbedo.value?.[k550];
    const ph = c.phaseFunction.value?.kind ?? 'unknown';
    const value = `${c.description}. Vertical optical depth ${formatValue(tau)} at ${wl[k550]} nm`
      + (ssa === undefined ? ', single-scattering albedo unknown' : `, single-scattering albedo ${formatValue(ssa)}`)
      + `, phase function ${ph}`;
    const method = [['Extinction', c.extinctionPerKm], ['Albedo', c.singleScatteringAlbedo], ['Phase function', c.phaseFunction]]
      .map(([n, x]) => `${n as string} (${(x as Sourced<unknown>).label}): ${(x as Sourced<unknown>).method ?? '—'}`).join(' ');
    return {
      key: `atm:${c.id}`, name: `Atmosphere: ${c.id}`, label, value, method,
      sources: uniq(parts.flatMap((x) => x.sources ?? [])),
      withheld: label !== 'unknown' && !labelAllowed(label, level),
    };
  });
  const sr = a.surfaceReflectance;
  if (sr) {
    rows.push({
      ...row('atm:surface', 'Surface under the atmosphere (Lambert reflectance)', sr, level),
      value: sr.value ? `X, Y, Z, S equivalents ${sr.value.channelEquivalents.map((v) => formatValue(v)).join(', ')}` : 'unknown',
    });
  }
  return rows;
}

/**
 * The renderer's own lines about a body in the frame on screen (RendererStats.warnings; frame.ts and rings.ts begin
 * each with the body's name: "Titan: …", "Saturn rings: …"), without the name. What the renderer says it did with the
 * body, e.g. the factors a model was scaled by or a phase curve continued beyond its range.
 */
export function rendererLines(warnings: readonly string[] | undefined, name: string): string[] {
  return (warnings ?? []).filter((w) => w.startsWith(`${name}: `) || w.startsWith(`${name} `))
    .map((w) => w.slice(name.length).replace(/^:/, '').trimStart());
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

/**
 * Ring rows: the classic profile (optical depth, reflectance) and, for a component model (Jupiter, Uranus, Neptune;
 * render/ringComponents.ts), one row per component with the worst of its geometry, optical-depth and reflectance
 * labels (each aspect's own label and method in the row's method), and one per phase-function table.
 */
export function ringRows(sys: RingSystem, level: ExistsLevel): AttrRow[] {
  const rows: AttrRow[] = [];
  const od = sys.opticalDepth;
  const nProf = od.value?.length ?? 0;
  rows.push({ ...row('rings:tau', 'Rings: optical depth profile', od, level), value: od.value ? `${nProf} occultation profile${nProf === 1 ? '' : 's'}` : 'unknown' });
  rows.push({ ...row('rings:refl', 'Rings: reflectance model', sys.reflectance, level), value: sys.reflectance.value ? 'single-scattering ring model' : 'unknown' });
  const c = sys.components;
  if (!c) return rows;
  const m = c.value;
  rows.push({ ...row('rings:components', 'Rings: components', c, level), value: m ? `${m.components.length} components, ${Object.keys(m.phaseFunctions).length} phase functions` : 'unknown' });
  if (!m) return rows;
  const aspects = ['geometry', 'opticalDepth', 'reflectance'] as const;
  const aspectName = { geometry: 'Geometry', opticalDepth: 'Optical depth', reflectance: 'Reflectance' };
  for (const comp of m.components) {
    const p = comp.provenance;
    const label = worstOf(aspects.map((a) => p[a].label));
    const known = aspects.filter((a) => p[a].label !== 'unknown').map((a) => p[a].label);
    const shown = known.length ? worstOf(known) : 'unknown';
    rows.push({
      key: `rings:${comp.id}`,
      name: `Ring: ${comp.name}`,
      label,
      value: aspects.map((a) => `${aspectName[a].toLowerCase()} ${p[a].label}`).join(' · '),
      method: aspects.map((a) => `${aspectName[a]} (${p[a].label}): ${p[a].method}`).join(' '),
      sources: uniq(aspects.flatMap((a) => p[a].sources)),
      withheld: shown !== 'unknown' && !labelAllowed(shown, level),
    });
  }
  for (const [id, t] of Object.entries(m.phaseFunctions)) {
    rows.push({
      key: `rings:phase:${id}`,
      name: `Ring phase function: ${t.name}`,
      label: t.label,
      value: `${t.minPhaseDeg}–${t.maxPhaseDeg}° (outside: not measured)`,
      method: t.method,
      sources: t.sources,
      withheld: !labelAllowed(t.label, level),
    });
  }
  return rows;
}
