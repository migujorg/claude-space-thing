// Small-body name service: lazily starts the name index (in a Web Worker, names.worker.ts; in-thread when no
// worker is available, e.g. tests) and answers searches, display names and spkid lookups asynchronously.

import { displayName, NameIndex, type NameHit } from '../data/nameIndex';
import type { SmallBodyNamesHeader } from '../data/schema';

export type NameRequest =
  | { type: 'init'; url: string; header: SmallBodyNamesHeader; bytes?: number; sha256?: string }
  | { type: 'search'; id: number; query: string; limit: number }
  | { type: 'display'; id: number; rows: number[] }
  | { type: 'spkid'; id: number; spkid: number };

export type NameResponse =
  | { type: 'progress'; phase: 'indexing' }
  | { type: 'ready'; count: number; verified: boolean }
  | { type: 'error'; id?: number; message: string }
  | { type: 'result'; id: number; hits: NameHit[]; more: boolean }
  | { type: 'display'; id: number; names: string[]; spkids: number[] }
  | { type: 'spkid'; id: number; row: number | null };

export type NameState = 'idle' | 'loading' | 'indexing' | 'ready' | 'error';

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

export interface NameServiceOptions {
  /** Absolute or base-relative URL of names.txt. */
  url: string;
  header: SmallBodyNamesHeader;
  bytes?: number;
  sha256?: string;
  /** Worker factory; without it the index is built in this thread (fetching with `fetch`). */
  worker?: () => Worker;
  fetch?: (url: string) => Promise<Response>;
}

export class NameService {
  state: NameState = 'idle';
  error: string | null = null;
  count = 0;
  verified = false;
  private worker: Worker | null = null;
  private local: NameIndex | null = null;
  private started: Promise<void> | null = null;
  private seq = 0;
  private pending = new Map<number, (r: NameResponse) => void>();
  private listeners = new Set<() => void>();
  private displayCache = new Map<number, string>();
  private spkidCache = new Map<number, number>();

  constructor(private readonly o: NameServiceOptions) {}

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(state: NameState, error: string | null = null): void {
    this.state = state;
    this.error = error;
    this.listeners.forEach((f) => f());
  }

  /** Start loading/indexing (idempotent). Resolves when ready; rejects on failure. */
  start(): Promise<void> {
    if (this.started) return this.started;
    this.set('loading');
    this.started = new Promise<void>((resolve, reject) => {
      const fail = (msg: string) => { this.set('error', msg); reject(new Error(msg)); };
      if (this.o.worker) {
        try {
          this.worker = this.o.worker();
        } catch (e) {
          this.worker = null;
        }
      }
      if (this.worker) {
        this.worker.onmessage = (e: MessageEvent<NameResponse>) => {
          const m = e.data;
          if (m.type === 'progress') this.set('indexing');
          else if (m.type === 'ready') { this.count = m.count; this.verified = m.verified; this.set('ready'); resolve(); }
          else if (m.type === 'error' && m.id === undefined) fail(m.message);
          else if ('id' in m && m.id !== undefined) { this.pending.get(m.id)?.(m); this.pending.delete(m.id); }
        };
        this.worker.onerror = (e) => fail(e.message || 'name worker failed');
        this.worker.postMessage({ type: 'init', url: this.o.url, header: this.o.header, bytes: this.o.bytes, sha256: this.o.sha256 } satisfies NameRequest);
      } else {
        const f = this.o.fetch ?? ((u: string) => fetch(u));
        f(this.o.url)
          .then(async (res) => {
            if (!res.ok || (res.headers.get('content-type') ?? '').includes('text/html')) throw new Error(`${this.o.url}: not found`);
            const text = await res.text();
            this.set('indexing');
            this.local = new NameIndex(this.o.header, text);
            this.count = this.local.count;
            this.set('ready');
            resolve();
          })
          .catch((e) => fail(String((e as Error)?.message ?? e)));
      }
    });
    return this.started;
  }

  private ask<T extends NameResponse>(req: WithoutId<Extract<NameRequest, { id: number }>>): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, (r) => (r.type === 'error' ? reject(new Error(r.message)) : resolve(r as T)));
      this.worker!.postMessage({ ...req, id } as NameRequest);
    });
  }

  async search(query: string, limit = 40): Promise<{ hits: NameHit[]; more: boolean }> {
    await this.start();
    if (this.local) return this.local.search(query, limit);
    const r = await this.ask<Extract<NameResponse, { type: 'result' }>>({ type: 'search', query, limit });
    return { hits: r.hits, more: r.more };
  }

  /** Display names for core rows (cached, with their SPK-IDs). */
  async display(rows: number[]): Promise<string[]> {
    const missing = [...new Set(rows.filter((r) => !this.displayCache.has(r)))];
    if (missing.length) {
      await this.start();
      let names: string[], spkids: number[];
      if (this.local) {
        const f = missing.map((r) => (r >= 0 && r < this.local!.count ? this.local!.fields(r) : null));
        names = f.map((x) => (x ? displayName(x) : ''));
        spkids = f.map((x) => (x ? x.spkid : NaN));
      } else {
        const r = await this.ask<Extract<NameResponse, { type: 'display' }>>({ type: 'display', rows: missing });
        names = r.names;
        spkids = r.spkids;
      }
      missing.forEach((r, i) => {
        this.displayCache.set(r, names[i]);
        if (Number.isFinite(spkids[i])) this.spkidCache.set(r, spkids[i]);
      });
    }
    return rows.map((r) => this.displayCache.get(r) ?? '');
  }

  /** SPK-ID of a row whose display name was fetched, else null. */
  spkidOf(row: number): number | null {
    return this.spkidCache.get(row) ?? null;
  }

  /** Cached display name, or null if not fetched yet. */
  cached(row: number): string | null {
    return this.displayCache.get(row) ?? null;
  }

  async rowOfSpkid(spkid: number): Promise<number | null> {
    await this.start();
    const row = this.local ? this.local.rowOfSpkid(spkid) : (await this.ask<Extract<NameResponse, { type: 'spkid' }>>({ type: 'spkid', spkid })).row;
    if (row !== null) this.spkidCache.set(row, spkid);
    return row;
  }

  dispose(): void {
    this.worker?.terminate();
  }
}
