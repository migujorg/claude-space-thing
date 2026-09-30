// Web Worker: fetches smallbodies/names.txt, checks its sha256 against the manifest, builds the name index and
// answers queries (docs: data/nameIndex.ts). Keeps ~100 MB of strings off the main thread.

import { displayName, NameIndex } from '../data/nameIndex';
import type { NameRequest, NameResponse } from './nameService';

let index: NameIndex | null = null;
const post = (m: NameResponse) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (e: MessageEvent<NameRequest>) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      const res = await fetch(m.url);
      if (!res.ok || (res.headers.get('content-type') ?? '').includes('text/html')) throw new Error(`${m.url}: not found`);
      const buf = await res.arrayBuffer();
      if (m.bytes !== undefined && buf.byteLength !== m.bytes) throw new Error(`names.txt is ${buf.byteLength} B, manifest says ${m.bytes} B`);
      if (m.sha256 && globalThis.crypto?.subtle) {
        const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
        const hex = Array.from(d, (x) => x.toString(16).padStart(2, '0')).join('');
        if (hex !== m.sha256) throw new Error('names.txt sha256 differs from the manifest');
      }
      post({ type: 'progress', phase: 'indexing' });
      index = new NameIndex(m.header, new TextDecoder().decode(buf));
      post({ type: 'ready', count: index.count, verified: !!m.sha256 });
    } else if (!index) {
      post({ type: 'error', id: m.id, message: 'name index not ready' });
    } else if (m.type === 'search') {
      post({ type: 'result', id: m.id, ...index.search(m.query, m.limit) });
    } else if (m.type === 'display') {
      const f = m.rows.map((r) => (r >= 0 && r < index!.count ? index!.fields(r) : null));
      post({ type: 'display', id: m.id, names: f.map((x) => (x ? displayName(x) : '')), spkids: f.map((x) => (x ? x.spkid : NaN)) });
    } else if (m.type === 'spkid') {
      post({ type: 'spkid', id: m.id, row: index.rowOfSpkid(m.spkid) });
    }
  } catch (err) {
    post({ type: 'error', id: 'id' in m ? m.id : undefined, message: String((err as Error)?.message ?? err) });
  }
};
