import { describe, expect, it } from 'vitest';
import { ephemPath, loadAll, resolveBinPath } from '../src/data/load';
import type { Manifest } from '../src/data/schema';
import { body, fakeLight, src } from './app-fakes';

type Files = Record<string, unknown>;

async function hex(b: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', b as Uint8Array<ArrayBuffer>));
  return Array.from(d, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Serve an in-memory data directory; unknown paths get Vite's SPA fallback (HTML, status 200). */
async function fakeServer(files: Files, opts: { manifest?: boolean; tamper?: string } = {}) {
  const bytes = new Map<string, Uint8Array>();
  for (const [p, v] of Object.entries(files)) {
    bytes.set(p, v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : new TextEncoder().encode(JSON.stringify(v)));
  }
  if (opts.manifest !== false) {
    const products: Manifest['products'] = {};
    for (const [p, b] of bytes) products[p] = { path: p, bytes: b.byteLength, sha256: await hex(b), stage: 'test' };
    const m: Manifest = { generatedAt: '2026-09-30T00:00:00Z', pipelineVersion: 'test', window: { startEt: 0, endEt: 1e6 }, products };
    bytes.set('manifest.json', new TextEncoder().encode(JSON.stringify(m)));
  }
  if (opts.tamper) {
    const b = bytes.get(opts.tamper)!.slice();
    b[b.length - 2] ^= 1;
    bytes.set(opts.tamper, b);
  }
  const requested: string[] = [];
  const fetch = async (url: string) => {
    const p = url.replace(/^\/data\//, '');
    requested.push(p);
    const b = bytes.get(p);
    if (!b) return new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    return new Response(new Blob([b as Uint8Array<ArrayBuffer>]), { status: 200, headers: { 'content-type': p.endsWith('.json') ? 'application/json' : 'application/octet-stream' } });
  };
  return { fetch, requested };
}

const ephHeader = { bin: 'de.bin', segments: [{ target: 399, center: 0, frame: 'J2000', type: 2, initEt: 0, intLen: 1e6, rsize: 4, n: 1, offset: 0, sources: ['src-eph'] }] };
const ephBin = new Float64Array([5e5, 5e5, 1, 2]).buffer;

function full(): Files {
  return {
    'sources.json': [{ id: 'src-eph', title: 'T', citation: 'C', url: 'u', retrieved: '2026-09-30' }],
    'time.json': { source: 's', leapSeconds: [], deltaTA: 1, k: 2, eb: 3, m0: 4, m1: 5 },
    'bodies.json': [body(10, 'Sun', 'star'), { ...body(399, 'Earth', 'planet'), ephemeris: 'de' }],
    'photometry.json': { '399': { geometricAlbedoXYZS: src([1, 2, 3, 4], 'derived'), geometricAlbedoV: src(0.3, 'derived'), phaseFunction: src({ kind: 'lambert' }, 'estimated') }, '77': {} },
    'light.json': fakeLight(),
    'ephem/de.json': ephHeader,
    'ephem/de.bin': ephBin,
  };
}

describe('loadAll', () => {
  it('loads every product, verifies hashes and merges photometry', async () => {
    const { fetch } = await fakeServer(full());
    const d = await loadAll({ fetch, base: '/data/' });
    const byPath = Object.fromEntries(d.report.products.map((p) => [p.path, p]));
    for (const p of ['manifest.json', 'sources.json', 'time.json', 'bodies.json', 'photometry.json', 'light.json', 'ephem/de.json', 'ephem/de.bin'])
      expect(byPath[p].status, p).toBe('ok');
    expect(byPath['bodies.json'].hash).toBe('verified');
    expect(byPath['manifest.json'].hash).toBe('unchecked');
    expect(d.bodies.find((b) => b.id === 399)!.photometry!.phaseFunction.label).toBe('estimated');
    expect(d.bodies.find((b) => b.id === 10)!.photometry).toBeUndefined();
    expect(d.report.notes.join(' ')).toMatch(/id 77/);
    expect(d.ephemerides).toHaveLength(1);
    expect(Array.from(d.ephemerides[0].data)).toEqual([5e5, 5e5, 1, 2]);
    expect(d.sources.get('src-eph')!.title).toBe('T');
    expect(d.time!.k).toBe(2);
  });

  it('keeps going when optional products are missing, and says what is lost', async () => {
    const f = full();
    delete f['photometry.json'];
    delete f['light.json'];
    const { fetch } = await fakeServer(f);
    const d = await loadAll({ fetch, base: '/data/' });
    const byPath = Object.fromEntries(d.report.products.map((p) => [p.path, p]));
    expect(byPath['photometry.json'].status).toBe('missing'); // HTML fallback treated as missing
    expect(byPath['photometry.json'].consequence).toMatch(/not measured/);
    expect(byPath['light.json'].consequence).toMatch(/Sun/);
    expect(byPath['stars/bright.json'].status).toBe('missing');
    expect(d.light).toBeNull();
    expect(d.bodies).toHaveLength(2);
    expect(d.bodies[1].photometry).toBeUndefined();
  });

  it('works with no manifest at all', async () => {
    const { fetch } = await fakeServer(full(), { manifest: false });
    const d = await loadAll({ fetch, base: '/data/' });
    expect(d.manifest).toBeNull();
    expect(d.report.products.find((p) => p.path === 'manifest.json')!.consequence).toMatch(/window/);
    expect(d.ephemerides).toHaveLength(1); // discovered via bodies.json
    expect(d.report.products.find((p) => p.path === 'bodies.json')!.hash).toBe('unchecked');
  });

  it('refuses a product whose sha256 does not match the manifest', async () => {
    const { fetch } = await fakeServer(full(), { tamper: 'ephem/de.bin' });
    const d = await loadAll({ fetch, base: '/data/' });
    const r = d.report.products.find((p) => p.path === 'ephem/de.bin')!;
    expect(r.status).toBe('error');
    expect(r.hash).toBe('mismatch');
    expect(r.consequence).toMatch(/Earth/);
    expect(d.ephemerides).toHaveLength(0);
  });

  it('reports malformed JSON and unused manifest products', async () => {
    const f = full();
    f['time.json'] = { nope: 1 };
    f['future/thing.json'] = { x: 1 };
    const { fetch } = await fakeServer(f);
    const d = await loadAll({ fetch, base: '/data/' });
    expect(d.time).toBeNull();
    expect(d.report.products.find((p) => p.path === 'time.json')!.status).toBe('error');
    expect(d.report.products.find((p) => p.path === 'future/thing.json')!.status).toBe('unused');
  });

  it('flags referenced source ids that sources.json lacks', async () => {
    const f = full();
    (f['bodies.json'] as ReturnType<typeof body>[])[1].radii.sources = ['nowhere'];
    const { fetch } = await fakeServer(f);
    const d = await loadAll({ fetch, base: '/data/' });
    expect(d.report.notes.join(' ')).toMatch(/nowhere/);
  });
});

describe('M2 products: deferred systems, orientation, surfaces', () => {
  const orientHeader = {
    bin: 'orient/earth.bin', references: { REF: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
    bodies: { '399': { frame: 'ITRF93', pckFrame: 'ITRF93', bodyToPck: [1, 0, 0, 0, 1, 0, 0, 0, 1] } },
    segments: [{ body: 399, frameClassId: 3000, reference: 'REF', type: 2, initEt: 0, intLen: 1e6, rsize: 5, n: 1, offset: 0, startEt: 0, endEt: 1e6, sources: ['src-eph'], label: 'measured' }],
  };
  function m2(): Files {
    const f = full();
    (f['bodies.json'] as ReturnType<typeof body>[]).push({ ...body(501, 'Io', 'moon', { parent: 399 }), ephemeris: 'ephem/sat', ephemerisFiles: ['ephem/sat', 'ephem/de'] });
    (f['bodies.json'] as ReturnType<typeof body>[])[1].orientation = 'orient/earth';
    f['ephem/sat.json'] = { bin: 'ephem/sat.bin', segments: [{ ...ephHeader.segments[0], target: 501, center: 399 }] };
    f['ephem/sat.bin'] = new Float64Array([5e5, 5e5, 3, 4]).buffer;
    f['orient/earth.json'] = orientHeader;
    f['orient/earth.bin'] = new Float64Array([5e5, 5e5, 0.1, 0.2, 0.3]).buffer;
    f['surfaces/301/albedo.json'] = { levels: 3, label: 'derived', sources: ['src-eph'], epoch: '2009-2024', notes: 'test map' };
    f['surfaces/301/albedo/0/0/0.bin'] = new Uint8Array(16);
    f['surfaces/301/albedo/0/0/1.bin'] = new Uint8Array(16);
    return f;
  }

  it('defers ephemeris binaries the caller does not want now, but reads their headers', async () => {
    const { fetch, requested } = await fakeServer(m2());
    const d = await loadAll({ fetch, base: '/data/', eagerEphemeris: (p) => p === 'ephem/de.json' });
    expect(d.ephemerides.map((e) => e.path)).toEqual(['ephem/de.json']);
    expect(d.deferred).toHaveLength(1);
    expect(d.deferred[0]).toMatchObject({ path: 'ephem/sat.json', binPath: 'ephem/sat.bin', bodies: [501], bytes: 32 });
    expect(requested).toContain('ephem/sat.json');
    expect(requested).not.toContain('ephem/sat.bin');
    expect(d.report.products.find((p) => p.path === 'ephem/sat.bin')!.status).toBe('deferred');

    // later: fetched with the same integrity checks, progress reported, report updated in place
    const progress: number[] = [];
    const e = await d.loader!.loadDeferred(d.deferred[0], (got) => progress.push(got));
    expect(Array.from(e!.data)).toEqual([5e5, 5e5, 3, 4]);
    expect(progress.at(-1)).toBe(32);
    expect(d.report.products.find((p) => p.path === 'ephem/sat.bin')).toMatchObject({ status: 'ok', hash: 'verified' });
  });

  it('a deferred binary that fails its integrity check is not used', async () => {
    const { fetch } = await fakeServer(m2(), { tamper: 'ephem/sat.bin' });
    const d = await loadAll({ fetch, base: '/data/', eagerEphemeris: (p) => p === 'ephem/de.json' });
    expect(await d.loader!.loadDeferred(d.deferred[0])).toBeNull();
    expect(d.report.products.find((p) => p.path === 'ephem/sat.bin')).toMatchObject({ status: 'error', hash: 'mismatch' });
  });

  it('loads precise orientation products named by bodies', async () => {
    const { fetch } = await fakeServer(m2());
    const d = await loadAll({ fetch, base: '/data/' });
    expect(d.orientations).toHaveLength(1);
    expect(d.orientations[0].path).toBe('orient/earth.json');
    expect(Array.from(d.orientations[0].data)).toEqual([5e5, 5e5, 0.1, 0.2, 0.3]);
    expect(d.ephemerides.map((e) => e.path)).toEqual(['ephem/de.json', 'ephem/sat.json']); // default: all eager
  });

  it('reads surface layer headers; tiles are summarized as on-demand, not listed one by one', async () => {
    const { fetch, requested } = await fakeServer(m2());
    const d = await loadAll({ fetch, base: '/data/' });
    expect(d.surfaces).toHaveLength(1);
    expect(d.surfaces[0]).toMatchObject({ bodyId: 301, layer: 'albedo', levels: 3, label: 'derived', sources: ['src-eph'], epoch: '2009-2024', tiles: { count: 2, bytes: 32 }, tilePrefix: 'surfaces/301/albedo/' });
    expect(requested.some((p) => p.endsWith('.bin') && p.startsWith('surfaces/'))).toBe(false);
    const paths = d.report.products.map((p) => p.path);
    expect(paths).toContain('surfaces/301/albedo/*');
    expect(paths.filter((p) => p.startsWith('surfaces/301/albedo/0'))).toEqual([]);
    expect(d.report.products.find((p) => p.path === 'surfaces/301/albedo/*')!.status).toBe('on-demand');
  });
});

describe('path helpers', () => {
  it('resolves bin paths relative to the header directory or the data root', () => {
    expect(resolveBinPath('ephem/de.json', 'de.bin', null)).toBe('ephem/de.bin');
    expect(resolveBinPath('ephem/de.json', 'ephem/de.bin', null)).toBe('ephem/de.bin');
    const m = { products: { 'stars/x.bin': {} } } as unknown as Manifest;
    expect(resolveBinPath('stars/bright.json', 'stars/x.bin', m)).toBe('stars/x.bin');
    expect(ephemPath('de440s')).toBe('ephem/de440s.json');
    expect(ephemPath('ephem/de440s.json')).toBe('ephem/de440s.json');
  });
});

describe('downstream albedo reference product',()=>{
  it('loads and merges the independently sourced table',async()=>{
    const table={value:{radiiKm:[1,1,.9],cells:[],relativeTolerance:1e-5},label:'derived',sources:['test']};
    const {fetch}=await fakeServer({...full(),'albedo-reference.json':{'399':table}});
    const d=await loadAll({fetch,base:'/data/'});
    expect(d.bodies.find(b=>b.id===399)!.photometry!.albedoReferenceNormalization).toEqual(table);
    expect(d.report.products.find(p=>p.path==='albedo-reference.json')!.hash).toBe('verified');
  });
  it('rejects a changed table through the ordinary integrity check',async()=>{
    const {fetch}=await fakeServer({...full(),'albedo-reference.json':{'399':{value:{cells:[]},label:'derived',sources:['test']}}},{tamper:'albedo-reference.json'});
    const d=await loadAll({fetch,base:'/data/'});
    expect(d.bodies.find(b=>b.id===399)!.photometry!.albedoReferenceNormalization).toBeUndefined();
    expect(d.report.products.find(p=>p.path==='albedo-reference.json')!.status).toBe('error');
  });
});
