// Keep the worker's full float32 tables across navigations. The pipeline does not currently implement this
// renderer's Hillaire/orders solver; cache its exact output in the browser, without resampling or refitting.
import type { AtmosphereModel, AtmosphereTables } from './atmosphere';
import { IRR_H, IRR_W, MS_N, PROFILE_N, T_H, T_W } from './atmosphere';
import { FOURIER_N, VIEW_N } from './atmosphereMs';
import atmosphereCode from './atmosphere.ts?raw';
import scatteringCode from './atmosphereMs.ts?raw';

// Both source modules participate automatically: a solver or sampling change cannot read old tables.
const COMPUTATION = `float32-tables-v1\n${atmosphereCode}\n${scatteringCode}`;
const FIELDS = ['transmittance', 'multiScattering', 'skyIrradiance', 'profile', 'msSource'] as const;
const HEADER_WORDS = 7; // format version, K, then the five array lengths

/** Content of the built inputs, ground reflectance/dust scaling included, plus the actual computation. */
export async function atmosphereTableKey(model: AtmosphereModel, computation = COMPUTATION): Promise<string> {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, canonical(x)])) : v;
  const bytes = new TextEncoder().encode(computation + '\n' + JSON.stringify(canonical(model)));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface AtmosphereTableStore {
  get(key: string): Promise<ArrayBuffer | undefined>;
  put(key: string, bytes: ArrayBuffer): Promise<void>;
}

/** CacheStorage is origin-local and subject to ordinary browser eviction; an unavailable store is a miss. */
function browserStore(): AtmosphereTableStore | null {
  if (typeof caches === 'undefined') return null;
  const url = (key: string) => new URL(`/__atmosphere_tables/${key}`, location.origin).href;
  return {
    get: async (key) => (await (await caches.open('space-thing-atmosphere-tables-v1')).match(url(key)))?.arrayBuffer(),
    put: async (key, bytes) => { await (await caches.open('space-thing-atmosphere-tables-v1')).put(url(key), new Response(bytes)); },
  };
}

function encode(t: AtmosphereTables): ArrayBuffer {
  const n = FIELDS.map((f) => t[f]?.length ?? 0);
  const bytes = new ArrayBuffer(4 * (HEADER_WORDS + n.reduce((a, b) => a + b, 0)));
  new Uint32Array(bytes, 0, HEADER_WORDS).set([1, t.K, ...n]);
  let offset = HEADER_WORDS;
  for (const f of FIELDS) if (t[f]) { new Float32Array(bytes, offset * 4, t[f]!.length).set(t[f]!); offset += t[f]!.length; }
  return bytes;
}

function decode(bytes: ArrayBuffer, model: AtmosphereModel): AtmosphereTables | null {
  if (bytes.byteLength < HEADER_WORDS * 4 || bytes.byteLength % 4) return null;
  const h = new Uint32Array(bytes, 0, HEADER_WORDS), K = model.wavelengthsNm.length;
  const lengths = [T_W * T_H * K, MS_N * MS_N * K, IRR_W * IRR_H * K, PROFILE_N * K * 4,
    model.multipleScattering === 'orders' ? MS_N * MS_N * FOURIER_N * VIEW_N * K : 0];
  if (h[0] !== 1 || h[1] !== K || lengths.some((n, i) => h[2 + i] !== n)
    || bytes.byteLength !== 4 * (HEADER_WORDS + lengths.reduce((a, b) => a + b, 0))) return null;
  const t = { K } as AtmosphereTables;
  let offset = HEADER_WORDS;
  FIELDS.forEach((f, i) => { if (lengths[i]) t[f] = new Float32Array(bytes, offset * 4, lengths[i]); offset += lengths[i]; });
  return t;
}

export class AtmosphereTableCache {
  private kept = new Map<string, Promise<AtmosphereTables>>();
  constructor(private readonly store: AtmosphereTableStore | null = browserStore()) {}

  async get(model: AtmosphereModel, compute: () => Promise<AtmosphereTables>): Promise<AtmosphereTables> {
    let key: string;
    try { key = await atmosphereTableKey(model); }
    catch { return compute(); } // No SubtleCrypto: preserve the uncached computation.
    let pending = this.kept.get(key);
    if (!pending) {
      pending = this.load(key, model, compute);
      this.kept.set(key, pending);
      // A failed worker can be retried, rather than keeping a rejected promise forever.
      pending.catch(() => { this.kept.delete(key); });
    }
    return pending;
  }

  private async load(key: string, model: AtmosphereModel, compute: () => Promise<AtmosphereTables>): Promise<AtmosphereTables> {
    try {
      const bytes = await this.store?.get(key);
      const table = bytes && decode(bytes, model);
      if (table) return table;
    } catch { /* Storage denied or evicted: compute normally. */ }
    const table = await compute();
    try { await this.store?.put(key, encode(table)); }
    catch { /* Quota/storage failure does not change the frame. */ }
    return table;
  }
}
