// Simulation clock in TDB seconds past J2000 (docs/architecture.md §3.2). Pure; no DOM.
//
// Time is clamped to the data window (intersection of loaded windows). Asking for a time outside it
// never extrapolates: the clock parks at the nearest edge, pauses, and remembers the request so the UI
// can show an "outside data window" state until time is set back inside.

export interface TimeWindow {
  startEt: number;
  endEt: number;
}

export interface RatePreset {
  id: string;
  label: string;
  /** Simulated seconds per real second (magnitude; direction is separate). */
  rate: number;
}

/** Unit conversions only (s per min/h/day/week). */
export const RATE_PRESETS: readonly RatePreset[] = [
  { id: 'real', label: 'real time', rate: 1 },
  { id: 'min', label: '1 min/s', rate: 60 },
  { id: 'hour', label: '1 h/s', rate: 3600 },
  { id: 'day', label: '1 day/s', rate: 86400 },
  { id: 'week', label: '1 week/s', rate: 7 * 86400 },
  { id: 'month', label: '30 days/s', rate: 30 * 86400 },
];

export type Edge = 'start' | 'end';

export interface ClockSnapshot {
  et: number;
  playing: boolean;
  /** Signed rate: simulated s per real s. */
  rate: number;
  window: TimeWindow | null;
  /** Set when the last request was outside the window (et is parked at `edge`). */
  outside: { requestedEt: number; edge: Edge } | null;
  /** Set when playback ran into a window edge and stopped. */
  stoppedAt: Edge | null;
}

export function intersectWindows(...ws: (TimeWindow | null | undefined)[]): TimeWindow | null {
  let out: TimeWindow | null = null;
  for (const w of ws) {
    if (!w || !Number.isFinite(w.startEt) || !Number.isFinite(w.endEt) || !(w.startEt < w.endEt)) continue;
    out = out ? { startEt: Math.max(out.startEt, w.startEt), endEt: Math.min(out.endEt, w.endEt) } : { ...w };
  }
  if (out && !(out.startEt < out.endEt)) return { startEt: out.startEt, endEt: out.startEt }; // empty intersection: degenerate
  return out;
}

export class Clock {
  private _et: number;
  private _playing = false;
  private _rate = 1;
  private _window: TimeWindow | null;
  private _outside: ClockSnapshot['outside'] = null;
  private _stoppedAt: Edge | null = null;

  constructor(et: number, window: TimeWindow | null = null) {
    this._window = window;
    this._et = et;
    this.set(et);
  }

  get et(): number { return this._et; }
  get playing(): boolean { return this._playing; }
  get rate(): number { return this._rate; }
  get window(): TimeWindow | null { return this._window; }

  snapshot(): ClockSnapshot {
    return { et: this._et, playing: this._playing, rate: this._rate, window: this._window, outside: this._outside, stoppedAt: this._stoppedAt };
  }

  setWindow(w: TimeWindow | null): void {
    this._window = w;
    this.set(this._outside ? this._outside.requestedEt : this._et);
  }

  /** Set time; returns false (and parks at an edge, paused) if outside the window. */
  set(et: number): boolean {
    this._stoppedAt = null;
    const w = this._window;
    if (!Number.isFinite(et)) return false;
    if (w && (et < w.startEt || et > w.endEt)) {
      const edge: Edge = et < w.startEt ? 'start' : 'end';
      this._et = edge === 'start' ? w.startEt : w.endEt;
      this._outside = { requestedEt: et, edge };
      this._playing = false;
      return false;
    }
    this._et = et;
    this._outside = null;
    return true;
  }

  play(): void {
    this._outside = null;
    this._stoppedAt = null;
    // At an edge and heading out of the window: nothing to play.
    if (this.atEdgeHeadingOut()) return;
    this._playing = true;
  }
  pause(): void { this._playing = false; }
  toggle(): void { if (this._playing) this.pause(); else this.play(); }

  /** Set the rate magnitude from a preset, keeping direction. */
  setRateMagnitude(r: number): void {
    this._rate = Math.sign(this._rate || 1) * Math.abs(r);
  }
  setRate(r: number): void { this._rate = r; }
  reverse(): void { this._rate = -this._rate; this._stoppedAt = null; }
  get reversed(): boolean { return this._rate < 0; }

  private atEdgeHeadingOut(): boolean {
    const w = this._window;
    if (!w) return false;
    return (this._rate > 0 && this._et >= w.endEt) || (this._rate < 0 && this._et <= w.startEt);
  }

  /** Advance by real seconds. Playback stops at window edges. */
  tick(realDt: number): void {
    if (!this._playing || !(realDt > 0)) return;
    const next = this._et + this._rate * realDt;
    const w = this._window;
    if (w && next > w.endEt) { this._et = w.endEt; this._playing = false; this._stoppedAt = 'end'; return; }
    if (w && next < w.startEt) { this._et = w.startEt; this._playing = false; this._stoppedAt = 'start'; return; }
    this._et = next;
  }

  /** Position in the window as 0..1 (for a scrubber), or null without a window. */
  fraction(): number | null {
    const w = this._window;
    if (!w || w.endEt <= w.startEt) return null;
    return (this._et - w.startEt) / (w.endEt - w.startEt);
  }
}

/** Nearest preset to a rate magnitude (for highlighting the active button). */
export function activePreset(rate: number): RatePreset | null {
  return RATE_PRESETS.find((p) => p.rate === Math.abs(rate)) ?? null;
}
