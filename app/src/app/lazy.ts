// Scheduling of deferred ephemeris files (one per moon system, docs/architecture.md §6). Pure state machine:
// the model drives it (starts fetches, reports progress/completion); tests drive it directly.
//
//   deferred ──start()/request()──► queued ──next()──► loading ──done(ok)──► loaded
//                                                         └────done(fail)──► error
//
// Priority: explicit requests (selection, search, go-to, URL) outrank everything, most recent first; otherwise
// the proximity priority set by the model (closer system → higher). At most `concurrency` loads at once.

export type SystemState = 'deferred' | 'queued' | 'loading' | 'loaded' | 'error';

export interface SystemInfo {
  /** Header product path, e.g. "ephem/sat-jup.json". */
  path: string;
  /** Short name, e.g. "sat-jup". */
  name: string;
  /** Human name, e.g. "Jupiter system". */
  title: string;
  bytes: number | null;
  /** Bodies whose chain to the SSB needs this file. */
  bodies: number[];
  /** Barycenter the system is centred on (for proximity), if known. */
  barycenter: number | null;
}

interface Entry {
  info: SystemInfo;
  state: SystemState;
  requested: number; // 0 = not explicitly requested; else a sequence number (later = more urgent)
  base: number; // proximity priority
  progress: number | null;
  error?: string;
}

const REQUEST_BOOST = 1e12;

export class SystemScheduler {
  private readonly entries = new Map<string, Entry>();
  private seq = 0;
  private readonly byBody = new Map<number, string[]>();

  constructor(systems: SystemInfo[], private readonly concurrency = 2) {
    for (const s of systems) {
      this.entries.set(s.path, { info: s, state: 'deferred', requested: 0, base: 0, progress: null });
      for (const b of s.bodies) {
        let l = this.byBody.get(b);
        if (!l) this.byBody.set(b, (l = []));
        l.push(s.path);
      }
    }
  }

  get systems(): SystemInfo[] {
    return [...this.entries.values()].map((e) => e.info);
  }

  state(path: string): SystemState | null {
    return this.entries.get(path)?.state ?? null;
  }

  progress(path: string): number | null {
    return this.entries.get(path)?.progress ?? null;
  }

  error(path: string): string | undefined {
    return this.entries.get(path)?.error;
  }

  /** Systems a body still needs (not loaded), in scheduling order. */
  pendingFor(bodyId: number): SystemInfo[] {
    return (this.byBody.get(bodyId) ?? []).map((p) => this.entries.get(p)!).filter((e) => e.state !== 'loaded').map((e) => e.info);
  }

  /** 'loaded' when nothing is pending for the body (including bodies needing no deferred file). */
  bodyState(bodyId: number): SystemState {
    const pend = (this.byBody.get(bodyId) ?? []).map((p) => this.entries.get(p)!).filter((e) => e.state !== 'loaded');
    if (!pend.length) return 'loaded';
    const order: SystemState[] = ['error', 'deferred', 'queued', 'loading'];
    return pend.map((e) => e.state).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
  }

  /** Queue every deferred system (background loading after the first frame). */
  startAll(): void {
    for (const e of this.entries.values()) if (e.state === 'deferred') e.state = 'queued';
  }

  /** Explicit need (selection, search, go-to): queue it ahead of everything else. */
  request(path: string): void {
    const e = this.entries.get(path);
    if (!e || e.state === 'loaded' || e.state === 'loading' || e.state === 'error') return;
    e.state = 'queued';
    e.requested = ++this.seq;
  }

  requestBody(bodyId: number): SystemInfo[] {
    const p = this.pendingFor(bodyId);
    for (const s of p) this.request(s.path);
    return p;
  }

  /** Proximity priority (higher first) for systems not explicitly requested. */
  setBasePriority(path: string, p: number): void {
    const e = this.entries.get(path);
    if (e) e.base = p;
  }

  private priority(e: Entry): number {
    return e.requested ? REQUEST_BOOST + e.requested : e.base;
  }

  /** The next system to start (marked loading), or null if at capacity or nothing is queued. */
  next(): SystemInfo | null {
    let loading = 0;
    let best: Entry | null = null;
    for (const e of this.entries.values()) {
      if (e.state === 'loading') loading++;
      else if (e.state === 'queued' && (!best || this.priority(e) > this.priority(best))) best = e;
    }
    if (!best || loading >= this.concurrency) return null;
    best.state = 'loading';
    best.progress = 0;
    return best.info;
  }

  setProgress(path: string, fraction: number): void {
    const e = this.entries.get(path);
    if (e && e.state === 'loading') e.progress = Math.max(0, Math.min(1, fraction));
  }

  done(path: string, ok: boolean, error?: string): void {
    const e = this.entries.get(path);
    if (!e) return;
    e.state = ok ? 'loaded' : 'error';
    e.progress = ok ? 1 : null;
    if (!ok) e.error = error ?? 'failed';
  }

  /** Nothing queued or loading (everything loaded, failed, or never started). */
  get idle(): boolean {
    for (const e of this.entries.values()) if (e.state === 'queued' || e.state === 'loading') return false;
    return true;
  }

  summary(): { loaded: number; total: number; active: { title: string; progress: number | null }[]; queued: number; errors: string[] } {
    const es = [...this.entries.values()];
    return {
      loaded: es.filter((e) => e.state === 'loaded').length,
      total: es.length,
      active: es.filter((e) => e.state === 'loading').map((e) => ({ title: e.info.title, progress: e.progress })),
      queued: es.filter((e) => e.state === 'queued').length,
      errors: es.filter((e) => e.state === 'error').map((e) => `${e.info.title}: ${e.error}`),
    };
  }
}

/** The barycenter a system file is centred on: the most common segment center below 10 (NAIF barycenters 1–9). */
export function systemBarycenter(segments: { center: number }[]): number | null {
  const counts = new Map<number, number>();
  for (const s of segments) if (s.center > 0 && s.center < 10) counts.set(s.center, (counts.get(s.center) ?? 0) + 1);
  let best: number | null = null, n = 0;
  for (const [c, k] of counts) if (k > n) { best = c; n = k; }
  return best;
}
