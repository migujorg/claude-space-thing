// The Moon's per-texel Hapke layer as its spatial law (texelLaw.ts) and the normalization of maps at the
// actual geometry (spatial.ts mapDiskIntegral, frame.ts): the rendered disk integrates to the disk
// photometry (ROLO) at every geometry.
import { describe, expect, it } from 'vitest';
import { decodeTexelHapke, texelLawProblem, texelRadf, type TexelHapke } from '../src/render/texelLaw';
import { hapkeRadf, LAMBERT_LAW, LAW, lawDiskIntegral, mapDiskIntegral, photometricFrame, type ResolvedLaw } from '../src/render/spatial';
import { numberToF16, type Level0Map } from '../src/render/surface';
import type { SceneBody, SurfaceLayerRef } from '../src/render/scene';
import type { V3 } from '../src/render/raycast';

// ── TEST FIXTURES (invented values, shaped like surfaces/301/hapke.json and albedo.json) ─────────────
const BANDS = [415, 566, 604, 643];
const albedoRef: SurfaceLayerRef = {
  url: 'fixture://t',
  header: {
    maxLevel: 0,
    normalization: {
      weighting: 'test', texelDiskMeanCheck: [1, 1, 1, 1],
      channelWeights: { bandsNm: [321, ...BANDS], W: [[0, 0.1, 0.4, 0.3, 0.2], [0, 0.1, 0.6, 0.2, 0.1], [0.01, 0.7, 0.29, 0, 0], [0, 0.4, 0.6, 0, 0]] },
      bandNormalAlbedoDiskMean: { 321: 0.03, 415: 0.05, 566: 0.07, 604: 0.08, 643: 0.085 },
    } as never,
  },
};
const params = (lonDeg: number) => BANDS.map((_, b) => [0.25 + 0.05 * b + (lonDeg > 0 ? 0.1 : 0), 0.3, 0.6, 1.5, 0.06]);
function hapkeRef(unknownSouthOf = -70): SurfaceLayerRef {
  const channels = BANDS.flatMap((nm) => ['w', 'b', 'c', 'Bs0', 'hs'].map((p) => `${p}@${nm}nm`));
  return {
    url: 'fixture://t',
    header: {
      maxLevel: 0, kind: 'photometric-parameters', format: 'float16', channels, bytesPerTexel: channels.length * 2,
      constants: { thetaBarDeg: 23.657, porosityK: 1, Bc0: 0, hc: 1, model: 'Hapke 2012 (test)' },
      unknownSouthOf,
    } as never,
  };
}
function tiles(unknownSouthOf = -70): ArrayBuffer[] {
  const nch = BANDS.length * 5, T = 256;
  return [0, 1].map((tx) => {
    const u = new Uint16Array(T * T * nch);
    for (let j = 0; j < T; j++) for (let i = 0; i < T; i++) {
      const lat = 90 - (180 * (j + 0.5)) / T;
      const lon = -180 + (360 * (tx * T + i + 0.5)) / (2 * T);
      if (lat < unknownSouthOf) continue;
      const p = params(lon).flat();
      for (let k = 0; k < nch; k++) u[(j * T + i) * nch + k] = numberToF16(p[k]);
    }
    return u.buffer;
  });
}

describe('per-texel Hapke law (texelLaw.ts)', () => {
  const t: TexelHapke = decodeTexelHapke(hapkeRef(), albedoRef, tiles());
  const band = (b: number, lonDeg: number): ResolvedLaw => {
    const [w, bb, c, bs0, hs] = params(lonDeg)[b];
    return { kind: LAW.hapke, p: w, b: bb, c, bs0, hs, bc0: 0, hc: 1, thetaBar: (23.657 * Math.PI) / 180, K: 1, hFn: 0 };
  };
  it('uses the four heaviest bands and needs the albedo layer\'s band weights', () => {
    expect([...t.bandsNm].sort()).toEqual(BANDS);
    expect(texelLawProblem(hapkeRef(), albedoRef)).toBeNull();
    expect(texelLawProblem(hapkeRef(), { url: 'x', header: { maxLevel: 0 } })).toMatch(/band/);
  });
  it('R_c is the band-weighted Hapke radiance factor relative to the normal albedo (no surge): 1 at i = e = g = 0', () => {
    const lat = 0.2, lon = -1.0, lonDeg = (lon * 180) / Math.PI;
    const r0 = texelRadf(t, lat, lon, 1, 1, 0);
    // At exact zero phase the surge term is on, so R > 1 by the surge; without it the ratio is 1.
    const ratioSurge = (b: number) => hapkeRadf(0, 0, 0, band(b, lonDeg)) / hapkeRadf(0, 0, 0, { ...band(b, lonDeg), bs0: 0 });
    expect(r0[1]).toBeGreaterThan(1);
    expect(r0[1]).toBeLessThan(Math.max(...BANDS.map((_, b) => ratioSurge(b))) + 1e-3);
    // Away from zero phase, against a direct evaluation.
    const i = 0.7, e = 0.3, g = 0.9;
    const r = texelRadf(t, lat, lon, Math.cos(i), Math.cos(e), g);
    for (let c = 0; c < 4; c++) {
      let num = 0, den = 0;
      BANDS.forEach((_, b) => {
        num += t.cw[c][b] * hapkeRadf(i, e, g, band(b, lonDeg));
        den += t.cw[c][b] * hapkeRadf(0, 0, 0, { ...band(b, lonDeg), bs0: 0 });
      });
      expect(r[c] / (num / den)).toBeCloseTo(1, 2); // float16 parameters
    }
  });
  it('poleward of the data, cells take the nearest known cell of their longitude (continuous at the edge)', () => {
    const edge = texelRadf(t, (-69.5 * Math.PI) / 180, 0.5, 0.6, 0.8, 0.4);
    const cap = texelRadf(t, (-80 * Math.PI) / 180, 0.5, 0.6, 0.8, 0.4);
    for (let c = 0; c < 4; c++) expect(cap[c] / edge[c]).toBeCloseTo(1, 6);
    expect(cap[1]).not.toBeCloseTo(0.6, 3); // not Lambert
  });
  it('falls back to Lambert (μ0) only where a longitude has no parameters at all', () => {
    const empty = decodeTexelHapke(hapkeRef(), albedoRef, [null, null]);
    expect(texelRadf(empty, 0.1, 0.5, 0.6, 0.8, 0.4)).toEqual([0.6, 0.6, 0.6, 0.6]);
  });
});

describe('normalization of maps over the actual disk (mapDiskIntegral)', () => {
  const frameAt = (alpha: number, subLon: number): [V3, V3, V3] => {
    // Observer on the equator at longitude subLon; Sun at phase alpha toward increasing longitude.
    const o: V3 = [Math.cos(subLon), Math.sin(subLon), 0];
    const s: V3 = [Math.cos(subLon + alpha), Math.sin(subLon + alpha), 0];
    return photometricFrame(o, s);
  };
  it('reduces to the constant-law disk integral for a uniform map', () => {
    for (const a of [0.1, 0.8, 1.6]) {
      const I = mapDiskIntegral(a, frameAt(a, 0.3), (_la, _lo, mu0) => [mu0, mu0, mu0, mu0], 32);
      expect(I[1] / lawDiskIntegral(LAMBERT_LAW, a)[1]).toBeCloseTo(1, 6);
    }
  });
  it('sees longitude structure at this geometry, and averages it out over rotations', () => {
    const map = (lon: number) => (lon > 0 ? 1.5 : 0.5); // bright eastern hemisphere
    const f = (_la: number, lon: number, mu0: number): [number, number, number, number] => { const v = mu0 * map(lon); return [v, v, v, v]; };
    const a = 0.5;
    const east = mapDiskIntegral(a, frameAt(a, Math.PI / 2), f, 32)[1];
    const west = mapDiskIntegral(a, frameAt(a, -Math.PI / 2), f, 32)[1];
    const avg = lawDiskIntegral(LAMBERT_LAW, a)[1];
    expect(east / avg).toBeGreaterThan(1.3);
    expect(west / avg).toBeLessThan(0.7);
    const rot = mapDiskIntegral(a, frameAt(a, Math.PI / 2), f, 32, 16)[1];
    expect(rot / avg).toBeCloseTo(1, 2);
  });
});

describe('the Moon in a frame with maps and the per-texel law', () => {
  it('the rendered disk integrates to the disk photometry at this geometry (brute force over the sphere)', async () => {
    const { prepareFrame, cameraGeom } = await import('../src/render/frame');
    const { AdaptationState, computeEyeFrame } = await import('../src/eye/model');
    const { DEFAULT_EYE_SETTINGS } = await import('../src/eye/settings');
    const { AU_KM } = await import('../src/render/constants');
    const t = decodeTexelHapke(hapkeRef(), albedoRef, tiles());
    const map0: Level0Map = { width: 512, height: 256, data: new Float32Array(512 * 256 * 4) };
    for (let j = 0; j < 256; j++) for (let i = 0; i < 512; i++) {
      const lon = -180 + (360 * (i + 0.5)) / 512;
      map0.data.set(lon > 20 && lon < 90 ? [0.6, 0.6, 0.5, 0.55] : [1.2, 1.2, 1.25, 1.2], (j * 512 + i) * 4);
    }
    const sunIrr: [number, number, number, number] = [1.3e5, 1.35e5, 1.4e5, 3.2e5];
    const dist = 384400, alpha = 1.0;
    // A ROLO-like disk model (TEST VALUES, the shape of photometry.json 301.diskReflectanceModel): the
    // photometry is measured at this geometry, so the maps are normalized at this geometry exactly.
    const rolo = {
      kind: 'rolo-v1' as const, formula: 'test',
      a: [0, 1, 2, 3].map(() => [-2.1, -1.63, 0.34, -0.19]), b: [0, 1, 2, 3].map(() => [0.04, 0.011, -0.004]),
      d: [0, 1, 2, 3].map(() => [0.37, -0.11, 0.008]), c: [0.00034, -0.0013, 0.00096, 0.00066] as [number, number, number, number],
      p: [4.06, 12.88, -30.59, 16.75] as [number, number, number, number], radiusKm: 1737.39,
      minPhaseDeg: 1.55, maxPhaseDeg: 97, maxObserverLatitudeDeg: 7, maxObserverLongitudeDeg: 8,
    };
    const body: SceneBody = {
      id: 301, name: 'Moon', pos: [-dist, 0, 0], toSun: [AU_KM * Math.cos(alpha), AU_KM * Math.sin(alpha), 0], orient: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      radii: [1737.4, 1737.4, 1737.4], albedoXYZS: [18000, 17700, 13700, 35000], phase: { kind: 'lambert' }, surfaceUnknown: false,
      worstLabel: 'derived', selected: false, surface: { albedo: albedoRef, photometry: hapkeRef() }, diskReflectanceModel: rolo,
    };
    const st = new AdaptationState();
    st.update({ coneCdM2: 1, rodCdM2: 1, cornealFlux: 0 }, 0);
    const eye = computeEyeFrame(DEFAULT_EYE_SETTINGS, st, 'eye', 0, null);
    const snap = {
      et: 0, camera: { orient: [0, 0, 1, 1, 0, 0, 0, 1, 0] as never, fovY: (1 * Math.PI) / 180, width: 1280, height: 720 },
      sun: { pos: [AU_KM, 0, 0] as V3, radius: 695700, irradianceXYZS_1AU: sunIrr, limbDarkening: null }, bodies: [body],
      view: { mode: 'eye' as const, exposureBoostStops: 0, overlays: { provenanceTint: false } }, orbits: [],
    };
    const g = cameraGeom(snap, 1280, 720, 1e-7);
    const surfaces = () => ({ albedo: { base: 1, maxLevel: 0, zonal: null, map0 }, photometry: { texel: t, view: null as never } });
    const p = prepareFrame(snap, g, eye, 1e-9, { surfaces });
    const r = p.resolved[0];
    expect(r.law.kind).toBe(LAW.texelHapke);
    // Brute force: E = Σ L·dΩ over the visible, lit sphere, L = K·M·R (Lambert fallback nowhere here).
    const obs: V3 = [1, 0, 0], sun: V3 = [Math.cos(alpha), Math.sin(alpha), 0];
    const n = 400;
    let E = 0;
    const Rm = 1737.4;
    for (let a = 0; a < n; a++) for (let b = 0; b < 2 * n; b++) {
      const lat = -Math.PI / 2 + (Math.PI * (a + 0.5)) / n;
      const lon = -Math.PI + (Math.PI * (b + 0.5)) / n;
      const nrm: V3 = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
      const mu = nrm[0] * obs[0] + nrm[1] * obs[1] + nrm[2] * obs[2];
      const mu0 = nrm[0] * sun[0] + nrm[1] * sun[1] + nrm[2] * sun[2];
      if (!(mu > 0) || !(mu0 > 0)) continue;
      const dA = Rm * Rm * Math.cos(lat) * (Math.PI / n) * (Math.PI / n);
      const lonDeg = (lon * 180) / Math.PI;
      const M = lonDeg > 20 && lonDeg < 90 ? 0.6 : 1.2;
      const R = texelRadf(t, lat, lon, mu0, mu, alpha)[1];
      E += r.K[1] * M * R * (dA * mu) / (dist * dist);
    }
    const { diskModelPPhi } = await import('../src/render/photometry');
    const pPhi = diskModelPPhi(rolo, body.orient, Rm, body.toSun, [dist, 0, 0], sunIrr)!;
    const expected = pPhi[1] * (Rm / dist) ** 2; // d = 1 AU
    // Within the quadrature error for this sharp-edged test map (Gauss–Legendre 24 × 24 over the lune).
    expect(Math.abs(E / expected - 1)).toBeLessThan(0.015);
  }, 180000); // brute-force integration: allow for a loaded machine (the suite shares the CPU)

  it('outside the ROLO domain (the far side) the maps are normalized at the model\'s reference view', async () => {
    const { prepareFrame, cameraGeom } = await import('../src/render/frame');
    const { AdaptationState, computeEyeFrame } = await import('../src/eye/model');
    const { DEFAULT_EYE_SETTINGS } = await import('../src/eye/settings');
    const { AU_KM } = await import('../src/render/constants');
    const { evalPhase } = await import('../src/render/photometry');
    const t = decodeTexelHapke(hapkeRef(), albedoRef, tiles());
    // TEST FIXTURE map: a dark near side, a bright far side.
    const bright = (lonDeg: number) => (Math.abs(lonDeg) > 90 ? 1.3 : 0.8);
    const map0: Level0Map = { width: 512, height: 256, data: new Float32Array(512 * 256 * 4) };
    for (let j = 0; j < 256; j++) for (let i = 0; i < 512; i++) {
      const m = bright(-180 + (360 * (i + 0.5)) / 512);
      map0.data.set([m, m, m, m], (j * 512 + i) * 4);
    }
    const sunIrr: [number, number, number, number] = [1.3e5, 1.35e5, 1.4e5, 3.2e5];
    const dist = 384400, alpha = 1.0, Rm = 1737.4;
    const rolo = {
      kind: 'rolo-v1' as const, formula: 'test',
      a: [0, 1, 2, 3].map(() => [-2.1, -1.63, 0.34, -0.19]), b: [0, 1, 2, 3].map(() => [0.04, 0.011, -0.004]),
      d: [0, 1, 2, 3].map(() => [0.37, -0.11, 0.008]), c: [0.00034, -0.0013, 0.00096, 0.00066] as [number, number, number, number],
      p: [4.06, 12.88, -30.59, 16.75] as [number, number, number, number], radiusKm: 1737.39,
      minPhaseDeg: 1.55, maxPhaseDeg: 97, maxObserverLatitudeDeg: 7, maxObserverLongitudeDeg: 8,
    };
    // Camera over the far side (selenographic longitude 180°), the Sun α away.
    const body: SceneBody = {
      id: 301, name: 'Moon', pos: [dist, 0, 0], toSun: [-AU_KM * Math.cos(alpha), AU_KM * Math.sin(alpha), 0], orient: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      radii: [Rm, Rm, Rm], albedoXYZS: [18000, 17700, 13700, 35000], phase: { kind: 'lambert' }, surfaceUnknown: false,
      worstLabel: 'derived', selected: false, surface: { albedo: albedoRef, photometry: hapkeRef() }, diskReflectanceModel: rolo,
    };
    const st = new AdaptationState();
    st.update({ coneCdM2: 1, rodCdM2: 1, cornealFlux: 0 }, 0);
    const eye = computeEyeFrame(DEFAULT_EYE_SETTINGS, st, 'eye', 0, null);
    const snap = {
      et: 0, camera: { orient: [0, 0, -1, -1, 0, 0, 0, 1, 0] as never, fovY: (1 * Math.PI) / 180, width: 1280, height: 720 },
      sun: { pos: [AU_KM, 0, 0] as V3, radius: 695700, irradianceXYZS_1AU: sunIrr, limbDarkening: null }, bodies: [body],
      view: { mode: 'eye' as const, exposureBoostStops: 0, overlays: { provenanceTint: false } }, orbits: [],
    };
    const g = cameraGeom(snap, 1280, 720, 1e-7);
    const surfaces = () => ({ albedo: { base: 1, maxLevel: 0, zonal: null, map0 }, photometry: { texel: t, view: null as never } });
    const r = prepareFrame(snap, g, eye, 1e-9, { surfaces }).resolved[0];
    // Brute force at the reference view (observer over 0°, 0°; Sun at ±α on the equator) with the frame's K.
    const Eref = (sgn: number) => {
      const obs: V3 = [1, 0, 0], sun: V3 = [Math.cos(alpha), sgn * Math.sin(alpha), 0];
      const n = 300;
      let E = 0;
      for (let a = 0; a < n; a++) for (let b = 0; b < 2 * n; b++) {
        const lat = -Math.PI / 2 + (Math.PI * (a + 0.5)) / n;
        const lon = -Math.PI + (Math.PI * (b + 0.5)) / n;
        const nrm: V3 = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
        const mu = nrm[0] * obs[0] + nrm[1] * obs[1] + nrm[2] * obs[2];
        const mu0 = nrm[0] * sun[0] + nrm[1] * sun[1] + nrm[2] * sun[2];
        if (!(mu > 0) || !(mu0 > 0)) continue;
        const dA = Rm * Rm * Math.cos(lat) * (Math.PI / n) * (Math.PI / n);
        E += r.K[1] * bright((lon * 180) / Math.PI) * texelRadf(t, lat, lon, mu0, mu, alpha)[1] * (dA * mu) / (dist * dist);
      }
      return E;
    };
    const ph = evalPhase(body.phase!, alpha);
    const expected = body.albedoXYZS![1] * (ph.ok ? ph.phi : NaN) * (Rm / dist) ** 2; // d = 1 AU
    expect(Math.abs(Math.sqrt(Eref(1) * Eref(-1)) / expected - 1)).toBeLessThan(0.015);
  }, 180000);
});
