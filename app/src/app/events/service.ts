// Main-thread side of the event finder: schedules the categories (one at a time, in a worker), waits for the
// inputs each needs (a moon system, the small-body catalogue), caches results per data build (IndexedDB in the
// browser, keyed by the sha256 of every input file and the finder's version) and tells the UI what stands where.

import type { EngineInit, EphemFile, SmallBodyInit } from './engine';
import { CATEGORIES, EventEngine, type Category } from './engine';
import type { SkyEvent } from './finder';

/** Bump when the finder's results change for the same inputs (invalidates cached results). */
export const FINDER_VERSION = 1;

export const CATEGORY_TITLES: Record<Category, string> = {
  eclipses: 'Eclipses of the Sun and the Moon',
  planets: 'Planets: oppositions, conjunctions, elongations, close pairs',
  saturn: 'Saturn\'s ring plane',
  jovian: 'Jupiter\'s Galilean moons',
  pluto: 'Pluto and Charon',
  neo: 'Near-Earth objects passing the Earth and the Moon',
};

// ---- worker protocol ------------------------------------------------------------------------------------------

export type EventRequest =
  | { type: 'init'; init: EngineInit }
  | { type: 'ephem'; file: EphemFile }
  | { type: 'smallbodies'; sb: SmallBodyInit }
  | { type: 'find'; id: number; category: Category };

export type EventResponse =
  | { type: 'progress'; id: number; fraction: number }
  | { type: 'result'; id: number; events: SkyEvent[]; ms: number; errors: string[] }
  | { type: 'error'; id?: number; message: string };

export interface FindResult { events: SkyEvent[]; ms: number; errors: string[] }

/** Where the computation runs (a worker, or this thread). */
export interface EventComputePort {
  addEphem(f: EphemFile): void;
  setSmallBodies(sb: SmallBodyInit): void;
  find(category: Category, onProgress: (f: number) => void): Promise<FindResult>;
  dispose(): void;
}

export class EventWorkerClient implements EventComputePort {
  private seq = 0;
  private readonly waiting = new Map<number, { resolve: (r: FindResult) => void; reject: (e: Error) => void; progress: (f: number) => void }>();
  private failed: Error | null = null;

  constructor(private readonly worker: Worker, init: EngineInit) {
    worker.onmessage = (e: MessageEvent<EventResponse>) => {
      const m = e.data;
      if (m.type === 'progress') this.waiting.get(m.id)?.progress(m.fraction);
      else if (m.type === 'result') {
        this.waiting.get(m.id)?.resolve({ events: m.events, ms: m.ms, errors: m.errors });
        this.waiting.delete(m.id);
      } else if (m.id !== undefined) {
        this.waiting.get(m.id)?.reject(new Error(m.message));
        this.waiting.delete(m.id);
      } else this.fail(new Error(m.message));
    };
    worker.onerror = (e) => this.fail(new Error(e.message || 'event worker failed'));
    this.post({ type: 'init', init });
  }

  private post(m: EventRequest): void {
    this.worker.postMessage(m);
  }

  private fail(e: Error): void {
    this.failed = e;
    for (const w of this.waiting.values()) w.reject(e);
    this.waiting.clear();
  }

  addEphem(f: EphemFile): void {
    this.post({ type: 'ephem', file: f });
  }

  setSmallBodies(sb: SmallBodyInit): void {
    this.post({ type: 'smallbodies', sb });
  }

  find(category: Category, onProgress: (f: number) => void): Promise<FindResult> {
    if (this.failed) return Promise.reject(this.failed);
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject, progress: onProgress });
      this.post({ type: 'find', id, category });
    });
  }

  dispose(): void {
    this.worker.terminate();
  }
}

/** The engine on this thread (tests, or no Worker support): blocks while a category is computed. */
export class InProcessEvents implements EventComputePort {
  constructor(private readonly engine: EventEngine) {}
  addEphem(f: EphemFile): void {
    this.engine.addEphem(f);
  }
  setSmallBodies(sb: SmallBodyInit): void {
    this.engine.setSmallBodies(sb);
  }
  async find(category: Category, onProgress: (f: number) => void): Promise<FindResult> {
    await Promise.resolve();
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const events = this.engine.find(category, onProgress);
    return { events, ms: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0, errors: this.engine.errors.splice(0) };
  }
  dispose(): void {}
}

// ---- cache ------------------------------------------------------------------------------------------------------

/** Results per category, one entry each (a new data build replaces it). Never rejects. */
export interface EventCache {
  load(c: Category, key: string): Promise<SkyEvent[] | null>;
  save(c: Category, key: string, events: SkyEvent[]): Promise<void>;
}

/**
 * IndexedDB (the browser default: the Galilean-moon and close-approach lists run to megabytes, more than
 * localStorage holds). Without IndexedDB, or on any error, nothing is cached and results are recomputed.
 */
export function indexedDbCache(factory: () => IDBFactory | null = () => (typeof indexedDB !== 'undefined' ? indexedDB : null)): EventCache {
  let db: Promise<IDBDatabase | null> | null = null;
  const open = () =>
    (db ??= new Promise<IDBDatabase | null>((resolve) => {
      try {
        const f = factory();
        if (!f) return resolve(null);
        const req = f.open('st-events', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('results');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    }));
  const run = async <T,>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> => {
    const d = await open();
    if (!d) return null;
    return new Promise<T | null>((resolve) => {
      try {
        const r = f(d.transaction('results', mode).objectStore('results'));
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  };
  return {
    async load(c, key) {
      const v = (await run('readonly', (s) => s.get(c))) as { key?: string; events?: SkyEvent[] } | null | undefined;
      return v && v.key === key && Array.isArray(v.events) ? v.events : null;
    },
    async save(c, key, events) {
      await run('readwrite', (s) => s.put({ key, events }, c));
    },
  };
}

interface Stored { key: string; methods: string[]; events: (Omit<SkyEvent, 'method'> & { method: number })[] }

/** Web Storage (small; tests use it with an in-memory Storage). */
export function storageCache(storage: () => Storage | null): EventCache {
  const name = (c: Category) => `st-events:${c}`;
  return {
    async load(c, key) {
      try {
        const s = storage()?.getItem(name(c));
        if (!s) return null;
        const d = JSON.parse(s) as Stored;
        if (d.key !== key) return null;
        return d.events.map((e) => ({ ...e, method: d.methods[e.method] }));
      } catch {
        return null;
      }
    },
    async save(c, key, events) {
      try {
        const methods: string[] = [];
        const idx = new Map<string, number>();
        const ev = events.map((e) => {
          let i = idx.get(e.method);
          if (i === undefined) { i = methods.length; methods.push(e.method); idx.set(e.method, i); }
          return { ...e, method: i };
        });
        storage()?.setItem(name(c), JSON.stringify({ key, methods, events: ev } satisfies Stored, compactNumbers));
      } catch {
        // Quota or no storage: results are simply recomputed next time.
      }
    },
  };
}

/** Times to 1 ms, other numbers to 9 significant digits (far below anything shown). */
function compactNumbers(this: unknown, k: string, v: unknown): unknown {
  if (typeof v !== 'number' || !Number.isFinite(v) || Number.isInteger(v)) return v;
  if (k === 'et' || k === 'startEt' || k === 'endEt') return Math.round(v * 1000) / 1000;
  return Number(v.toPrecision(9));
}

/** FNV-1a (64-bit, as hex) of a string: a short cache key from the input files' sha256s. */
export function hashKey(s: string): string {
  let h = 0xcbf29ce484222325n;
  const p = 0x100000001b3n, m = (1n << 64n) - 1n;
  for (let i = 0; i < s.length; i++) h = ((h ^ BigInt(s.charCodeAt(i))) * p) & m;
  return h.toString(16).padStart(16, '0');
}

// ---- service ----------------------------------------------------------------------------------------------------

export type Readiness = { state: 'ready' } | { state: 'wait'; why: string } | { state: 'no'; why: string };

/** What the service needs from the app. */
export interface EventServiceHost {
  /** Whether a category's inputs are loaded (ready), still coming (wait) or unavailable (no). */
  readiness(c: Category): Readiness;
  /** The inputs loaded so far (sent to the compute port when it is created). */
  engineInit(): EngineInit;
  /** Close-approach candidates (when `neo` is ready). */
  smallBodies(): SmallBodyInit | null;
  /** Cache key of a category's inputs; null: do not cache. */
  cacheKey(c: Category): string | null;
}

export type CategoryStatus = 'idle' | 'waiting' | 'reading' | 'queued' | 'running' | 'ready' | 'error' | 'unavailable';

export interface CategoryState {
  key: Category;
  title: string;
  status: CategoryStatus;
  /** 0..1 while running. */
  progress: number | null;
  events: SkyEvent[];
  /** Compute time, ms (null when loaded from the cache). */
  ms: number | null;
  cached: boolean;
  /** Why it waits, is unavailable, or failed. */
  message: string | null;
}

export class EventService {
  private port: EventComputePort | null = null;
  private readonly st = new Map<Category, CategoryState>();
  private started = false;
  private busy = false;
  private readonly listeners = new Set<() => void>();
  private readonly sent = new Set<string>();
  private sbSent = false;
  private readonly waiters = new Map<Category, { resolve: (e: SkyEvent[]) => void; reject: (e: Error) => void }[]>();
  /** Problems reported by the compute side (bad files); shown with the panel. */
  readonly errors: string[] = [];

  constructor(
    private readonly host: EventServiceHost,
    private readonly makePort: (init: EngineInit) => EventComputePort,
    private readonly cache: EventCache | null = null,
  ) {
    for (const c of CATEGORIES) this.st.set(c, { key: c, title: CATEGORY_TITLES[c], status: 'idle', progress: null, events: [], ms: null, cached: false, message: null });
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    this.listeners.forEach((f) => f());
  }

  get isStarted(): boolean {
    return this.started;
  }

  states(): CategoryState[] {
    return CATEGORIES.map((c) => this.st.get(c)!);
  }

  state(c: Category): CategoryState {
    return this.st.get(c)!;
  }

  /** Every event found so far, in time order. */
  all(): SkyEvent[] {
    return this.states().flatMap((s) => s.events).sort((a, b) => a.et - b.et);
  }

  byId(id: string): SkyEvent | null {
    for (const s of this.st.values()) for (const e of s.events) if (e.id === id) return e;
    return null;
  }

  /** Begin (idempotent): cached categories at once, the rest queued as their inputs arrive. */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const s of this.st.values()) this.refresh(s);
    this.pump();
    this.changed();
  }

  /** The events of a category once computed (starts the service). */
  whenReady(c: Category): Promise<SkyEvent[]> {
    this.start();
    const s = this.st.get(c)!;
    if (s.status === 'ready') return Promise.resolve(s.events);
    if (s.status === 'unavailable' || s.status === 'error') return Promise.reject(new Error(s.message ?? s.status));
    return new Promise((resolve, reject) => {
      const l = this.waiters.get(c) ?? [];
      l.push({ resolve, reject });
      this.waiters.set(c, l);
    });
  }

  /** A moon system (or any ephemeris file) arrived: pass it on and re-check waiting categories. */
  addEphem(f: EphemFile): void {
    if (this.port && !this.sent.has(f.path)) {
      this.sent.add(f.path);
      this.port.addEphem(f);
    }
    this.inputsChanged();
  }

  /** Something a category waits for may have arrived (or failed). */
  inputsChanged(): void {
    if (!this.started) return;
    let any = false;
    for (const s of this.st.values()) {
      if (s.status === 'waiting' || s.status === 'idle') {
        const before = s.status + (s.message ?? '');
        this.refresh(s);
        if (s.status + (s.message ?? '') !== before) any = true;
      }
    }
    this.pump();
    if (any) this.changed();
  }

  dispose(): void {
    this.port?.dispose();
    this.port = null;
  }

  private refresh(s: CategoryState): void {
    const key = this.host.cacheKey(s.key);
    const r = this.host.readiness(s.key);
    if (r.state === 'no') {
      this.settle(s, 'unavailable', r.why);
      return;
    }
    if (r.state === 'wait') {
      s.status = 'waiting';
      s.message = r.why;
      return;
    }
    s.message = null;
    if (!key || !this.cache) {
      s.status = 'queued';
      return;
    }
    // Results computed earlier for this data build, if any; else compute.
    s.status = 'reading';
    this.cache.load(s.key, key).then(
      (hit) => {
        if (s.status !== 'reading') return;
        if (hit) {
          s.events = hit;
          s.cached = true;
          s.ms = null;
          this.settle(s, 'ready', null);
        } else s.status = 'queued';
        this.changed();
        this.pump();
      },
      () => {
        if (s.status !== 'reading') return;
        s.status = 'queued';
        this.pump();
      },
    );
  }

  private settle(s: CategoryState, status: 'ready' | 'error' | 'unavailable', message: string | null): void {
    s.status = status;
    s.message = message;
    s.progress = null;
    const ws = this.waiters.get(s.key) ?? [];
    this.waiters.delete(s.key);
    for (const w of ws) status === 'ready' ? w.resolve(s.events) : w.reject(new Error(message ?? status));
  }

  private ensurePort(): EventComputePort {
    if (!this.port) {
      const init = this.host.engineInit();
      for (const f of init.ephem) this.sent.add(f.path);
      this.port = this.makePort(init);
    }
    return this.port;
  }

  private pump(): void {
    if (!this.started || this.busy) return;
    const s = this.states().find((x) => x.status === 'queued');
    if (!s) return;
    let port: EventComputePort;
    try {
      port = this.ensurePort();
      if (s.key === 'neo' && !this.sbSent) {
        const sb = this.host.smallBodies();
        if (!sb) {
          this.settle(s, 'unavailable', 'The small-body catalogue is not loaded.');
          this.changed();
          this.pump();
          return;
        }
        port.setSmallBodies(sb);
        this.sbSent = true;
      }
    } catch (e) {
      this.settle(s, 'error', String((e as Error).message ?? e));
      this.changed();
      return;
    }
    this.busy = true;
    s.status = 'running';
    s.progress = 0;
    this.changed();
    port.find(s.key, (f) => {
      s.progress = f;
      this.changed();
    }).then(
      (r) => {
        s.events = r.events;
        s.ms = r.ms;
        s.cached = false;
        this.errors.push(...r.errors);
        const key = this.host.cacheKey(s.key);
        if (key && this.cache) void this.cache.save(s.key, key, r.events).catch(() => undefined);
        this.settle(s, 'ready', null);
      },
      (e: Error) => this.settle(s, 'error', e.message),
    ).finally(() => {
      this.busy = false;
      this.changed();
      this.pump();
    });
  }
}
