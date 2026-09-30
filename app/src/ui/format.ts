// Pure display formatting. No physical values: numbers come from data; unit definitions from units.ts.

import type { IauRotation, PhaseFunction } from '../data/schema';
import { AU_KM, SECONDS_PER_DAY, SECONDS_PER_HOUR, SECONDS_PER_JULIAN_YEAR } from './units';

export function sig(x: number, n = 4): string {
  if (!Number.isFinite(x)) return String(x);
  if (x === 0) return '0';
  const a = Math.abs(x);
  if (a >= 1e-3 && a < 1e6) {
    const digits = Math.max(0, n - 1 - Math.floor(Math.log10(a)));
    return group(x.toFixed(Math.min(digits, 12)));
  }
  return x.toExponential(n - 1).replace('e+', 'e');
}

/** Thousands separators with thin spaces, keeping decimals. */
function group(s: string): string {
  const [i, d] = s.split('.');
  const neg = i.startsWith('-');
  const digits = neg ? i.slice(1) : i;
  const g = digits.length > 4 ? digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : digits;
  return (neg ? '−' : '') + g + (d ? '.' + d : '');
}

export function formatDistance(km: number | null | undefined): string {
  if (km === null || km === undefined || !Number.isFinite(km)) return '—';
  const a = Math.abs(km);
  if (a < 1) return `${sig(km * 1000, 3)} m`;
  if (a < 1e6) return `${group(Math.round(km).toString())} km`;
  if (a < 0.1 * AU_KM) return `${sig(km / 1e6, 4)} million km`;
  return `${sig(km / AU_KM, 4)} AU`;
}

export function formatAngle(rad: number | null | undefined): string {
  if (rad === null || rad === undefined || !Number.isFinite(rad)) return '—';
  const deg = (rad * 180) / Math.PI;
  const a = Math.abs(deg);
  if (a >= 1) return `${sig(deg, 4)}°`;
  if (a * 60 >= 1) return `${sig(deg * 60, 4)}′`;
  if (a * 3600 >= 0.01) return `${sig(deg * 3600, 3)}″`;
  return `${sig(deg * 3600e3, 3)} mas`;
}

export function formatDuration(s: number | null | undefined): string {
  if (s === null || s === undefined || !Number.isFinite(s)) return '—';
  const a = Math.abs(s);
  const sign = s < 0 ? '−' : '';
  if (a < 1) return `${sign}${sig(a * 1000, 3)} ms`;
  if (a < 60) return `${sign}${sig(a, 3)} s`;
  if (a < SECONDS_PER_HOUR) return `${sign}${Math.floor(a / 60)} min ${Math.round(a % 60)} s`;
  if (a < SECONDS_PER_DAY) return `${sign}${Math.floor(a / SECONDS_PER_HOUR)} h ${Math.round((a % SECONDS_PER_HOUR) / 60)} min`;
  if (a < SECONDS_PER_JULIAN_YEAR) return `${sign}${Math.floor(a / SECONDS_PER_DAY)} d ${Math.round((a % SECONDS_PER_DAY) / SECONDS_PER_HOUR)} h`;
  return `${sign}${sig(a / SECONDS_PER_JULIAN_YEAR, 3)} yr`;
}

export function formatRate(rate: number, presetLabel?: string | null): string {
  const dir = rate < 0 ? '◀ ' : '';
  if (presetLabel) return dir + presetLabel;
  return `${dir}×${sig(Math.abs(rate), 3)}`;
}

export function formatBytes(b: number | undefined): string {
  if (b === undefined) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${sig(b / 1024, 3)} KiB`;
  if (b < 1024 ** 3) return `${sig(b / 1024 ** 2, 3)} MiB`;
  return `${sig(b / 1024 ** 3, 3)} GiB`;
}

/** Luminance for the HUD. */
export function formatLuminance(cdm2: number | null | undefined): string {
  if (cdm2 === null || cdm2 === undefined || !Number.isFinite(cdm2)) return '—';
  return `${sig(cdm2, 3)} cd/m²`;
}

// ---- Sourced values --------------------------------------------------------------------------------

function isNumArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'number');
}

function polyStr(c: number[] | undefined, v: string): string {
  if (!c || !c.length) return '—';
  return c
    .map((k, i) => (i === 0 ? sig(k, 6) : `${k < 0 ? '−' : '+'} ${sig(Math.abs(k), 6)}${v}${i > 1 ? `^${i}` : ''}`))
    .join(' ');
}

export function formatRotation(r: IauRotation): string {
  const parts = [
    `pole α = ${polyStr(r.poleRa, 'T')}°`,
    `δ = ${polyStr(r.poleDec, 'T')}°`,
    `W = ${polyStr(r.pm, 'd')}°`,
  ];
  if (r.nutPrecRa?.length || r.nutPrecDec?.length || r.nutPrecPm?.length) parts.push('+ nutation/precession terms');
  return parts.join(', ');
}

export function formatPhase(p: PhaseFunction): string {
  switch (p.kind) {
    case 'lambert':
      return 'Lambert sphere (disk-integrated)';
    case 'tabulated':
      return `tabulated phase curve, ${p.alphaDeg.length} points, ${sig(Math.min(...p.alphaDeg), 3)}°–${sig(Math.max(...p.alphaDeg), 3)}°`;
    case 'poly-mag':
      return `magnitude polynomial (${p.coeffs.length} terms), valid ${sig(p.minDeg, 3)}°–${sig(p.maxDeg, 3)}°`;
    default:
      return JSON.stringify(p);
  }
}

/** Generic Sourced value formatter; `kind` hints the attribute. */
export function formatValue(value: unknown, unit?: string, kind?: 'radii' | 'xyzs' | 'rotation' | 'phase'): string {
  if (value === null || value === undefined) return 'unknown';
  const u = unit ? ` ${unit}` : '';
  if (kind === 'rotation' && typeof value === 'object') return formatRotation(value as IauRotation);
  if (kind === 'phase' && typeof value === 'object') return formatPhase(value as PhaseFunction);
  if (kind === 'radii' && isNumArray(value)) {
    const [a, b, c] = value;
    return a === b && b === c ? `${sig(a, 6)}${u} (sphere)` : `${value.map((x) => sig(x, 6)).join(' × ')}${u}`;
  }
  if (kind === 'xyzs' && isNumArray(value)) return `X ${sig(value[0])}, Y ${sig(value[1])}, Z ${sig(value[2])}, S ${sig(value[3])}${u}`;
  if (typeof value === 'number') return `${sig(value, 6)}${u}`;
  if (isNumArray(value)) return `${value.map((x) => sig(x, 5)).join(', ')}${u}`;
  if (typeof value === 'string') return value + u;
  const j = JSON.stringify(value);
  return j.length > 120 ? j.slice(0, 117) + '…' : j;
}
