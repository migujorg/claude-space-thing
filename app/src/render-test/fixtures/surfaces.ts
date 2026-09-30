// ════════════════════════════════════════════════════════════════════════════════════════════
//  TEST FIXTURES — NOT DATA.
//  Procedural surface-map tiles, ring profiles and photometric parameters used only by the renderer
//  test page (/render-test.html) to exercise virtual texturing, height normals, rings and Hapke
//  shading. Served from `fixture://` URLs by a fetch override on the test page. Never imported by the
//  app, never written to app/public/data.
// ════════════════════════════════════════════════════════════════════════════════════════════

import type { SpatialPhotometricModel } from '../../data/schema';
import type { SceneRings, SurfaceLayerRef } from '../../render/scene';
import { numberToF16, TILE, tilesX, tilesY } from '../../render/surface';

/** Checker albedo: 30° squares with a 3° sub-checker and per-channel tints; a gap (unknown) region. */
function checkerAlbedo(latDeg: number, lonDeg: number): [number, number, number, number] | null {
  if (latDeg < -20 && latDeg > -45 && lonDeg > 20 && lonDeg < 80) return null; // not measured
  const big = (Math.floor((lonDeg + 180) / 30) + Math.floor((90 - latDeg) / 30)) & 1;
  const small = (Math.floor((lonDeg + 180) / 3) + Math.floor((90 - latDeg) / 3)) & 1;
  const fine = (Math.floor((lonDeg + 180) / 0.3) + Math.floor((90 - latDeg) / 0.3)) & 1;
  const v = (big ? 1.25 : 0.75) * (small ? 1.08 : 0.92) * (fine ? 1.03 : 0.97);
  return big ? [v * 1.1, v, v * 0.85, v * 0.9] : [v * 0.9, v, v * 1.15, v * 1.1];
}

/** Deterministic hash → [0, 1). */
function hash(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Crater field height (m) on a sphere of radius R km: per 5°×5° cell, a few bowl-shaped craters with a
 * raised rim (depth ≈ 0.2 × diameter; rim ≈ 0.04 × diameter). Shapes are illustrative only.
 */
const craterCells = new Map<number, { q: [number, number, number]; diam: number }[]>();
function cellCraters(ii: number, j: number): { q: [number, number, number]; diam: number }[] {
  const key = ii * 1000 + j;
  let list = craterCells.get(key);
  if (!list) {
    const cell = 5;
    list = [];
    for (let k = 0; k < 3; k++) {
      const clon = ((ii + hash(ii, j, k)) * cell - 180) * (Math.PI / 180);
      const clat = ((j + hash(j, ii, k + 7)) * cell - 90) * (Math.PI / 180);
      const diam = 8 + 70 * Math.pow(hash(ii, j, k + 13), 3); // km
      list.push({ q: [Math.cos(clat) * Math.cos(clon), Math.cos(clat) * Math.sin(clon), Math.sin(clat)], diam });
    }
    craterCells.set(key, list);
  }
  return list;
}

function craterHeight(latDeg: number, lonDeg: number, R: number): number {
  const cell = 5;
  const ci = Math.floor((lonDeg + 180) / cell), cj = Math.floor((latDeg + 90) / cell);
  let h = 0;
  const lat = (latDeg * Math.PI) / 180, lon = (lonDeg * Math.PI) / 180;
  const cl = Math.cos(lat);
  const p = [cl * Math.cos(lon), cl * Math.sin(lon), Math.sin(lat)];
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      const j = cj + dj;
      if (j < 0 || j >= 180 / cell) continue;
      const ii = (((ci + di) % (360 / cell)) + 360 / cell) % (360 / cell);
      for (const c of cellCraters(ii, j)) {
        const cosd = p[0] * c.q[0] + p[1] * c.q[1] + p[2] * c.q[2];
        if (cosd < 0.9) continue; // farther than ~26°: no influence
        const d = R * Math.acos(Math.min(1, cosd)); // km
        const x = d / (c.diam / 2);
        if (x < 1) h += c.diam * 1000 * (0.2 * (x * x - 1) + 0.04);
        else if (x < 2) h += c.diam * 1000 * 0.04 * Math.pow(2 - x, 2);
      }
    }
  }
  return h;
}

/** Radius used for the crater fixture (Moon-sized). */
export const FIXTURE_CRATER_RADIUS_KM = 1737.4;

/** Generate a fixture tile: fixture://<name>/<layer>/<L>/<ty>/<tx>.bin → ArrayBuffer (or null = 404). */
export function fixtureTile(url: string): ArrayBuffer | null {
  const m = /^fixture:\/\/([a-z-]+)\/(albedo|height)\/(\d+)\/(\d+)\/(\d+)\.bin$/.exec(url);
  if (!m) return null;
  const [, name, layer, Ls, tys, txs] = m;
  const L = Number(Ls), ty = Number(tys), tx = Number(txs);
  if (tx >= tilesX(L) || ty >= tilesY(L)) return null;
  const W = 512 << L, H = 256 << L;
  if (layer === 'albedo') {
    const buf = new ArrayBuffer(TILE * TILE * 8);
    const h = new Uint16Array(buf);
    for (let j = 0; j < TILE; j++) {
      const lat = 90 - (180 * (ty * TILE + j + 0.5)) / H;
      for (let i = 0; i < TILE; i++) {
        const lon = -180 + (360 * (tx * TILE + i + 0.5)) / W;
        const v = name === 'checker' ? checkerAlbedo(lat, lon) : [1, 1, 1, 1];
        if (!v) continue; // all zero = unknown
        for (let k = 0; k < 4; k++) h[(j * TILE + i) * 4 + k] = numberToF16(v[k]);
      }
    }
    return buf;
  }
  const buf = new ArrayBuffer(TILE * TILE * 4);
  const f = new Float32Array(buf);
  for (let j = 0; j < TILE; j++) {
    const lat = 90 - (180 * (ty * TILE + j + 0.5)) / H;
    for (let i = 0; i < TILE; i++) {
      const lon = -180 + (360 * (tx * TILE + i + 0.5)) / W;
      f[j * TILE + i] = craterHeight(lat, lon, FIXTURE_CRATER_RADIUS_KM);
    }
  }
  return buf;
}

export const FIXTURE_CHECKER: SurfaceLayerRef = { url: 'fixture://checker/albedo', header: { maxLevel: 6 } };
export const FIXTURE_CRATERS: SurfaceLayerRef = { url: 'fixture://craters/height', header: { maxLevel: 6 } };

/** Hapke parameters of the order fitted to the Moon (illustrative, cf. Sato et al. 2014); TEST ONLY. */
export const FIXTURE_HAPKE: SpatialPhotometricModel = { kind: 'hapke', w: 0.25, b: 0.25, c: 0.4, bs0: 1.8, hs: 0.07, thetaBarDeg: 23.657 };

/**
 * A Saturn-like ring system: τ and ϖ0 profiles shaped like C ring / B ring / Cassini division / A ring /
 * Encke-like gap, with a stretch of unknown τ to show the hatch. Invented values; TEST ONLY.
 */
export function fixtureRings(normal: [number, number, number]): SceneRings {
  const radiusKm: number[] = [], tau: (number | null)[] = [], alb: ([number, number, number, number] | null)[] = [];
  for (let r = 74500; r <= 136800; r += 250) {
    let t = 0, w = 0.5;
    if (r < 92000) { t = 0.1; w = 0.35; }
    else if (r < 117580) { t = 1.2 + 0.8 * Math.sin(r / 900); w = 0.55; }
    else if (r < 122170) { t = 0.12; w = 0.4; }
    else { t = 0.5 + 0.1 * Math.sin(r / 400); w = 0.5; }
    if (r > 133400 && r < 133700) t = 0;
    radiusKm.push(r);
    const unknown = r > 100000 && r < 102000;
    tau.push(unknown ? null : t);
    alb.push(unknown ? null : [w * 1.05, w, w * 0.8, w * 0.85]);
  }
  return { normal, radiusKm, tau, albedoXYZS: alb, particlePhase: { kind: 'hg', g: -0.3 }, worstLabel: 'estimated' };
}
