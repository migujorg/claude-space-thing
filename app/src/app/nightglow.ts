// Earth's own light at night (docs/reports/nightglow.md): the shell side. Evaluates the airglow climatology
// (PALACE v1.0, nightglow/airglow.json) and the aurora precipitation (OVATION Prime 2010 driven by the measured
// solar-wind coupling, nightglow/aurora.json) for a time, and applies the reality filter. Pure: no DOM, no GPU.
//
// Labels: both models are `estimated` (a climatology measured at one site applied to the whole Earth; an empirical
// precipitation model and an emission model with assumed inputs), so neither is drawn at Strict. Their inputs keep
// their own labels for the inspector: the solar radio flux per day (derived from observations, or estimated where
// predictions fill the 27-day mean) and the coupling per hour (derived from OMNI measurements, or the estimated
// climatological median outside the measured part of the window).

import type { AirglowModel, AuroraModel, Label } from '../data/schema';
import type { AuroraBins } from '../data/nightglow';
import type { SceneAirglowLayer, SceneNightglow } from '../render/scene';
import { labelAllowed, worstOf, type ExistsLevel } from './reality';

export const EARTH_ID = 399;
const DAY_MS = 86400000;
const HOUR_MS = 3600000;

/** Day of year of a UTC instant (1 = 1 January 0 h), fractional. */
export function dayOfYear(ms: number): number {
  const y = new Date(ms).getUTCFullYear();
  return (ms - Date.UTC(y, 0, 1)) / DAY_MS + 1;
}

/** OVATION Prime 2010 season weights (IDL season_epoch) for a day of year: [winter, spring, summer, fall]. */
export function seasonWeights(doy: number): [number, number, number, number] {
  const w: [number, number, number, number] = [0, 0, 0, 0];
  if (doy >= 79 && doy < 171) { w[2] = 1 - (171 - doy) / 92; w[1] = 1 - w[2]; }
  else if (doy >= 171 && doy < 263) { w[3] = 1 - (263 - doy) / 92; w[2] = 1 - w[3]; }
  else if (doy >= 263 && doy < 354) { w[0] = 1 - (354 - doy) / 91; w[3] = 1 - w[0]; }
  else { const d0 = doy >= 354 ? doy - 365 : doy; w[1] = 1 - (79 - d0) / 90; w[0] = 1 - w[1]; }
  return w;
}

/** Index and weight of x between ascending nodes (clamped to the ends): value = v[i]·(1 − f) + v[i + 1]·f. */
export function bracket(nodes: number[], x: number): { i: number; f: number } {
  const n = nodes.length;
  if (n < 2 || x <= nodes[0]) return { i: 0, f: 0 };
  if (x >= nodes[n - 1]) return { i: n - 2, f: 1 };
  let i = 0;
  while (i < n - 2 && nodes[i + 1] <= x) i++;
  return { i, f: (x - nodes[i]) / (nodes[i + 1] - nodes[i]) };
}

/** Linear weights of the two month bins around a day of year (cyclic over the year): [month a, month b, weight of b]. */
export function monthWeights(centres: number[], doy: number): [number, number, number] {
  const Y = 365.25;
  for (let m = 0; m < 12; m++) {
    const a = centres[m], b = m < 11 ? centres[m + 1] : centres[0] + Y;
    const d = doy < a && m === 0 ? doy + Y : doy;
    if (d >= a && d < b) return [m, (m + 1) % 12, (d - a) / (b - a)];
  }
  // Before the first centre: between December and January.
  const a = centres[11] - Y, b = centres[0];
  return [11, 0, Math.min(Math.max((doy - a) / (b - a), 0), 1)];
}

/** The solar radio flux (sfu) of the UTC day of `ms` and its label; null outside the series. */
export function solarRadioFlux(m: AirglowModel, ms: number): { sfu: number; label: Label; day: string } | null {
  const s = m.solarRadioFlux.value;
  if (!s) return null;
  const first = Date.parse(s.firstDay + 'T00:00:00Z');
  const k = Math.floor((ms - first) / DAY_MS);
  const v = k >= 0 && k < s.values.length ? s.values[k] : null;
  if (v === null || v === undefined) return null;
  const day = new Date(first + k * DAY_MS).toISOString().slice(0, 10);
  const seg = s.labelSegments.find((g) => day >= g.from && day <= g.to);
  return { sfu: v, label: seg ? seg.label : m.solarRadioFlux.label, day };
}

/** The coupling dΦ/dt (OP2010 4-hour weighted) at a time: measured where the series has values, else the climatology. */
export function couplingAt(a: AuroraModel, ms: number): { value: number; label: Label; measured: boolean } {
  const c = a.coupling.value!;
  const t0 = Date.parse(c.hourlyStart);
  const x = (ms - t0) / (c.stepHours * HOUR_MS);
  const i = Math.floor(x);
  if (i >= 0 && i < c.values.length && x === i && c.values[i] !== null) {
    return { value: c.values[i]!, label: a.coupling.label, measured: true };
  }
  if (i >= 0 && i + 1 < c.values.length) {
    const v0 = c.values[i], v1 = c.values[i + 1];
    if (v0 !== null && v1 !== null) return { value: v0 + (v1 - v0) * (x - i), label: a.coupling.label, measured: true };
  }
  return { value: c.climatology.value, label: c.climatology.label, measured: false };
}

/**
 * The OVATION grid of one frame: per hemisphere, the season-weighted regressions at the coupling, linear between
 * coupling nodes. Output [mlat][mlt][eN, nN, eS, nS] (the texture layout of render/nightglow.ts).
 */
export function auroraGrid(a: AuroraModel, ovation: Float32Array, coupling: number, doy: number): Float32Array {
  const o = a.ovation.value!;
  const nN = o.couplingNodes.length, nT = o.mltHours.length, nL = o.mlatDeg.length;
  const { i, f } = bracket(o.couplingNodes, coupling);
  const plane = nT * nL;
  const at = (s: number, q: number, node: number) => ((s * 2 + q) * nN + node) * plane;
  const out = new Float32Array(plane * 4);
  const hemis = [seasonWeights(doy), seasonWeights(365 - doy)];
  hemis.forEach((w, h) => {
    for (let s = 0; s < 4; s++) {
      if (w[s] <= 0) continue;
      for (let q = 0; q < 2; q++) {
        const b0 = at(s, q, i), b1 = at(s, q, i + 1);
        const w0 = w[s] * (1 - f), w1 = w[s] * f;
        for (let t = 0; t < nT; t++) for (let l = 0; l < nL; l++) {
          const k = t * nL + l;
          out[(l * nT + t) * 4 + 2 * h + q] += w0 * ovation[b0 + k] + w1 * ovation[b1 + k];
        }
      }
    }
  });
  return out;
}

/** What the inspector shows about the night-side light of the Earth at a time and level. */
export interface NightglowInfo {
  airglow: {
    drawn: boolean;
    label: Label;
    reason?: string;
    srf: { sfu: number; label: Label; day: string } | null;
    sources: string[];
    method: string;
    uncertainty: string;
    zenithY: number | null;
  } | null;
  aurora: {
    drawn: boolean;
    label: Label;
    reason?: string;
    coupling: { value: number; label: Label; measured: boolean; unit: string; measuredUntil: string };
    sources: string[];
    method: string;
    uncertainty: string;
  } | null;
}

/** Airglow and aurora models with their binaries; builds SceneBody.nightglow for the Earth. */
export class NightglowSource {
  private layerCache: { key: string; layers: SceneAirglowLayer[]; zenithY: number } | null = null;
  private gridCache: { key: string; grid: Float32Array } | null = null;
  private groups: number[][][] | null = null;

  constructor(
    readonly airglow: AirglowModel | null,
    readonly aurora: AuroraModel | null,
    readonly bins: AuroraBins | null,
  ) {}

  /** The admitted night-side light at a UTC instant, or null when nothing is admitted. */
  scene(level: ExistsLevel, ms: number): SceneNightglow | null {
    const ag = this.airglowAt(level, ms);
    const au = this.auroraAt(level, ms);
    if (!ag && !au) return null;
    const samplesNm = this.airglow?.samplesNm ?? this.aurora?.emission.value?.samplesNm ?? [];
    const labels: Label[] = [];
    if (ag) labels.push(ag.label);
    if (au) labels.push(au.label);
    const d = new Date(ms);
    const utHours = d.getUTCHours() + d.getUTCMinutes() / 60 + (d.getUTCSeconds() + d.getUTCMilliseconds() / 1000) / 3600;
    return { samplesNm, utHours, airglow: ag?.scene ?? null, aurora: au?.scene ?? null, worstLabel: worstOf(labels) };
  }

  info(level: ExistsLevel, ms: number): NightglowInfo {
    const out: NightglowInfo = { airglow: null, aurora: null };
    const m = this.airglow;
    if (m) {
      const srf = solarRadioFlux(m, ms);
      const label = srf ? worstOf([m.label, srf.label]) : 'unknown';
      const ag = this.airglowAt(level, ms);
      out.airglow = {
        drawn: !!ag, label, srf, sources: [...m.sources, ...m.solarRadioFlux.sources], method: m.method, uncertainty: m.uncertainty,
        zenithY: ag ? this.layerCache?.zenithY ?? null : null,
        ...(ag ? {} : { reason: !srf ? 'no solar radio flux for this day' : `${label} — not admitted at this level` }),
      };
    }
    const a = this.aurora;
    if (a && a.coupling.value) {
      const c = couplingAt(a, ms);
      const label = worstOf([a.label, a.ovation.label, a.magneticCoordinates.label, a.emission.label, c.label]);
      const au = this.auroraAt(level, ms);
      out.aurora = {
        drawn: !!au, label,
        coupling: { ...c, unit: a.coupling.value.unit, measuredUntil: a.coupling.value.measuredUntil },
        sources: [...a.ovation.sources, ...a.coupling.sources, ...a.magneticCoordinates.sources, ...a.emission.sources],
        method: `${a.ovation.method ?? ''} ${a.emission.method ?? ''}`.trim(),
        uncertainty: [a.ovation.uncertainty, a.emission.uncertainty].filter(Boolean).join(' ') || 'unknown',
        ...(au ? {} : { reason: !this.bins ? 'aurora binaries not loaded' : `${label} — not admitted at this level` }),
      };
    }
    return out;
  }

  private airglowAt(level: ExistsLevel, ms: number): { scene: NonNullable<SceneNightglow['airglow']>; label: Label } | null {
    const m = this.airglow;
    if (!m) return null;
    const srf = solarRadioFlux(m, ms);
    if (!srf) return null;
    const label = worstOf([m.label, srf.label]);
    if (!labelAllowed(label, level)) return null;
    const doy = dayOfYear(ms);
    const [ma, mb, fm] = monthWeights(m.climatology.monthCentreDoy, doy);
    // Recompute when the interpolation changes by more than a tiny amount (once per ~hour of model time).
    const key = `${ma}|${mb}|${fm.toFixed(3)}|${srf.sfu}`;
    if (this.layerCache?.key !== key) this.layerCache = { key, ...airglowLayers(m, ma, mb, fm, srf.sfu) };
    return {
      label,
      scene: { nightMinSzaDeg: m.climatology.nightMinSolarZenithDeg ?? 100, ltNodesH: m.climatology.ltBinCentresHours, layers: this.layerCache.layers },
    };
  }

  private auroraAt(level: ExistsLevel, ms: number): { scene: NonNullable<SceneNightglow['aurora']>; label: Label } | null {
    const a = this.aurora, b = this.bins;
    if (!a || !b || !a.ovation.value || !a.coupling.value || !a.magneticCoordinates.value || !a.emission.value) return null;
    const c = couplingAt(a, ms);
    const label = worstOf([a.label, a.ovation.label, a.magneticCoordinates.label, a.emission.label, c.label]);
    if (!labelAllowed(label, level)) return null;
    const doy = dayOfYear(ms);
    const key = `${c.value.toFixed(1)}|${doy.toFixed(2)}`;
    if (this.gridCache?.key !== key) this.gridCache = { key, grid: auroraGrid(a, b.ovation, c.value, doy) };
    const e = a.emission.value;
    const groupNames = e.groups ?? ['N2p4278', 'OI5577', 'OI6300'];
    this.groups ??= groupNames.map((g) => e.lines[g]?.xyzsPerRBySample ?? []);
    const mc = a.magneticCoordinates.value;
    return {
      label,
      scene: {
        grid: this.gridCache.grid,
        mltHours: a.ovation.value.mltHours,
        mlatDeg: a.ovation.value.mlatDeg,
        magnetic: { data: b.magnetic, latDeg: mc.latDeg, lonDeg: mc.lonDeg },
        dipoleFrameRows: mc.dipoleFrameRows,
        emission: { data: b.emission, energiesKeV: e.averageEnergyNodesKeV, altitudesKm: e.altitudesKm },
        groupsBySample: this.groups,
      },
    };
  }
}

/**
 * Zenith column luminance of each layer per local-time node and spectral sample: Σ over the layer's classes of
 * referenceR · f0 · (1 + 0.01·sce·(srf − srf0)) · xyzsPerRBySample (PALACE Eq. 1), months interpolated linearly.
 * The solar-cycle factor is held at 0 where the linear law would go negative (not reached in the window).
 */
export function airglowLayers(m: AirglowModel, ma: number, mb: number, fm: number, srf: number): { layers: SceneAirglowLayer[]; zenithY: number } {
  const nLT = m.climatology.ltBinCentresHours.length;
  const nS = m.samplesNm.length;
  const byId = new Map(m.classes.map((c) => [c.id, c]));
  let zenithY = 0;
  const layers = m.layers.map((L) => {
    const t = new Float32Array(nLT * nS * 4);
    for (const id of L.classes) {
      const c = byId.get(id);
      if (!c) continue;
      for (let j = 0; j < nLT; j++) {
        const f0 = c.f0[ma][j] * (1 - fm) + c.f0[mb][j] * fm;
        const sce = c.sce[ma][j] * (1 - fm) + c.sce[mb][j] * fm;
        const I = c.referenceR * f0 * Math.max(0, 1 + 0.01 * sce * (srf - m.climatology.srf0));
        for (let k = 0; k < nS; k++) for (let ch = 0; ch < 4; ch++) t[(j * nS + k) * 4 + ch] += I * c.xyzsPerRBySample[k][ch];
      }
    }
    // Midnight node pair (for the Data panel's "zenith luminance" figure).
    const j0 = Math.floor((nLT - 1) / 2);
    for (let k = 0; k < nS; k++) zenithY += 0.5 * (t[(j0 * nS + k) * 4 + 1] + t[((j0 + 1) * nS + k) * 4 + 1]);
    return { centreKm: L.centreKm, sigmaKm: L.sigmaKm, xyzsBySample: t };
  });
  return { layers, zenithY };
}
