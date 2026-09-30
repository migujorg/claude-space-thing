// Energy check of Earth's layer model against the measured disk photometry (skipped when the products are
// not built). The rendered Earth (earth.ts: surface map, sea ice, clouds, glint; then with the atmosphere of
// atmosphere.ts) is integrated over the disk at the Himawari-9 reference geometry and compared with photometry.json 399,
// the disk-integrated reflectance p·Φ measured at α = 2.42°. The ratio is reported, not forced: the cloud
// layer (2026-09-28) and the Himawari scene (2025-03-20) are different days, and Earth's disk reflectance
// varies by 10–20 % with clouds and the hemisphere in view (photometry.json uncertainty).

import { describe, expect, it } from 'vitest';
import { earthParts, earthShade, type XYZS } from '../src/render/earth';
import { atmosphereModelFromData, precomputeAtmosphere, ProfileGrid, skyIrradianceK, sunTransmittanceK, viewPath } from '../src/render/atmosphere';
import { f16ToNumber } from '../src/render/surface';
import { DATA_DIR } from './core-data';

interface Fs { existsSync(p: string): boolean; readFileSync(p: string): Uint8Array; readFileSync(p: string, enc: 'utf8'): string }
const fs: Fs = await import(/* @vite-ignore */ 'node:fs' as string);
const S = DATA_DIR + 'surfaces/399/';
const built = ['albedo', 'clouds', 'water'].every((l) => fs.existsSync(`${S}${l}.json`)) && fs.existsSync(DATA_DIR + 'photometry.json');
const builtAtm = built && fs.existsSync(DATA_DIR + 'atmospheres.json');

/** A whole level decoded to float32 (NaN = unknown; zeroUnknown: all channels 0 → NaN). */
function level(layer: string, ch: number, zeroUnknown: boolean, LEVEL = 1): Float32Array {
  const W = 512 << LEVEL, H = 256 << LEVEL;
  const out = new Float32Array(W * H * ch).fill(NaN);
  for (let ty = 0; ty < 1 << LEVEL; ty++) for (let tx = 0; tx < 2 << LEVEL; tx++) {
    const p = `${S}${layer}/${LEVEL}/${ty}/${tx}.bin`;
    if (!fs.existsSync(p)) continue;
    const u8 = fs.readFileSync(p);
    const h = new Uint16Array(u8.buffer, u8.byteOffset, u8.byteLength / 2);
    for (let j = 0; j < 256; j++) for (let i = 0; i < 256; i++) {
      const src = (j * 256 + i) * ch;
      const dst = ((ty * 256 + j) * W + tx * 256 + i) * ch;
      let allZero = true;
      for (let c = 0; c < ch; c++) if (h[src + c] !== 0) allZero = false;
      if (zeroUnknown && allZero) continue;
      for (let c = 0; c < ch; c++) out[dst + c] = f16ToNumber(h[src + c]);
    }
  }
  return out;
}

const rad = (d: number) => (d * Math.PI) / 180;
const unit = (lat: number, lon: number): [number, number, number] => [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];

describe.skipIf(!built)('Earth energy check (real layers)', () => {
  it('disk-integrated reflectance at the Himawari reference geometry vs photometry.json 399 (ratio reported)', () => {
    const W = 1024, H = 512;
    const alb = level('albedo', 4, true), cl = level('clouds', 4, false), wa = level('water', 2, false);
    const albHeader = JSON.parse(fs.readFileSync(`${S}albedo.json`, 'utf8'));
    const m = albHeader.normalization.absoluteDiskMean;
    const absR: XYZS = [m.X, m.Y, m.Z, m.S];
    const phot = JSON.parse(fs.readFileSync(DATA_DIR + 'photometry.json', 'utf8'))['399'];
    const light = JSON.parse(fs.readFileSync(DATA_DIR + 'light.json', 'utf8'));
    const irr = light.sun.irradianceXYZS_1AU.value as XYZS;
    const pMeasured = (phot.geometricAlbedoXYZS.value as XYZS).map((v, k) => v / irr[k]);
    // Himawari-9 at 140.7° E over the equator; the Sun 2.42° away (the reference phase), near the equinox.
    const obs = unit(0, rad(140.7));
    const sun = unit(rad(-2.42), rad(140.7));
    // A = (1/π)∫ρ μ dΩ over the visible hemisphere (radiance factor ρ = πL/E), texel by texel.
    const A = [0, 0, 0, 0];
    let unknown = 0;
    for (let j = 0; j < H; j++) {
      const lat = rad(90 - ((j + 0.5) * 180) / H);
      const dOmega = (rad(180 / H) * rad(360 / W)) * Math.cos(lat);
      for (let i = 0; i < W; i++) {
        const lon = rad(((i + 0.5) * 360) / W - 180);
        const n = unit(lat, lon);
        const mu = n[0] * obs[0] + n[1] * obs[1] + n[2] * obs[2];
        if (mu <= 0) continue;
        const mu0 = n[0] * sun[0] + n[1] * sun[1] + n[2] * sun[2];
        const t = j * W + i;
        const surf = Number.isFinite(alb[t * 4]) ? ([0, 1, 2, 3].map((c) => alb[t * 4 + c] * absR[c]) as XYZS) : null;
        const s = earthShade({
          surface: surf, waterFraction: wa[t * 2], seaIceFraction: wa[t * 2 + 1],
          cloudFraction: cl[t * 4], opticalThickness: cl[t * 4 + 1], iceFraction: cl[t * 4 + 3],
        }, mu0, mu);
        for (let c = 0; c < 4; c++) A[c] += (s.rho[c] * mu * dOmega) / Math.PI;
        unknown += (s.gap * mu * dOmega) / Math.PI;
      }
    }
    const ratio = A.map((a, k) => a / pMeasured[k]);
    console.log(`Earth energy check (no atmosphere): model A XYZS ${A.map((v) => v.toFixed(4)).join(' ')}; measured p ${pMeasured.map((v) => v.toFixed(4)).join(' ')}; ratio ${ratio.map((v) => v.toFixed(3)).join(' ')}; unknown share of the disk ${(unknown).toFixed(3)}`);
    for (const r of ratio) {
      expect(r).toBeGreaterThan(0.3);
      expect(r).toBeLessThan(1.5);
    }
  }, 120000);
});

describe.skipIf(!builtAtm)('Earth energy check with the atmosphere (real layers and atmospheres.json)', () => {
  it('surface + clouds + atmosphere at the Himawari reference geometry vs photometry.json 399 (ratio reported)', () => {
    const LV = 0, W = 512, H = 256;
    const alb = level('albedo', 4, true, LV), cl = level('clouds', 4, false, LV), wa = level('water', 2, false, LV);
    const wi = fs.existsSync(`${S}wind.json`) ? level('wind', 3, false, LV) : null;
    const albHeader = JSON.parse(fs.readFileSync(`${S}albedo.json`, 'utf8'));
    const m = albHeader.normalization.absoluteDiskMean;
    const absR: XYZS = [m.X, m.Y, m.Z, m.S];
    const phot = JSON.parse(fs.readFileSync(DATA_DIR + 'photometry.json', 'utf8'))['399'];
    const light = JSON.parse(fs.readFileSync(DATA_DIR + 'light.json', 'utf8'));
    const irr = light.sun.irradianceXYZS_1AU.value as XYZS;
    const pMeasured = (phot.geometricAlbedoXYZS.value as XYZS).map((v, k) => v / irr[k]);
    const af = JSON.parse(fs.readFileSync(DATA_DIR + 'atmospheres.json', 'utf8'));
    const r = atmosphereModelFromData({ wavelengthsNm: af.wavelengthsNm, foldWeights: af.foldWeights.value, body: af.bodies['399'] }, pMeasured.map((p) => 1.5 * p)); // per channel, as the renderer (frame.ts)
    if ('error' in r) throw new Error(r.error);
    const model = r.model;
    const tab = precomputeAtmosphere(model);
    const G = new ProfileGrid(model, 1024);
    const K = tab.K;
    const w = model.weights;
    const obs = unit(0, rad(140.7));
    const sun = unit(rad(-2.42), rad(140.7));
    const A = [0, 0, 0, 0], A0 = [0, 0, 0, 0];
    let unknown = 0;
    const ts0 = new Float64Array(K), es0 = new Float64Array(K), tsc = new Float64Array(K), esc = new Float64Array(K);
    for (let j = 0; j < H; j++) {
      const lat = rad(90 - ((j + 0.5) * 180) / H);
      const dOmega = (rad(180 / H) * rad(360 / W)) * Math.cos(lat);
      for (let i = 0; i < W; i++) {
        const lon = rad(((i + 0.5) * 360) / W - 180);
        const n = unit(lat, lon);
        const mu = n[0] * obs[0] + n[1] * obs[1] + n[2] * obs[2];
        if (mu <= 0) continue;
        const mu0 = n[0] * sun[0] + n[1] * sun[1] + n[2] * sun[2];
        const t = j * W + i;
        const surf = Number.isFinite(alb[t * 4]) ? ([0, 1, 2, 3].map((c) => alb[t * 4 + c] * absR[c]) as XYZS) : null;
        const u = wi ? (Number.isFinite(wi[t * 3]) ? wi[t * 3] : wi[t * 3 + 1]) : NaN;
        const sample = { surface: surf, waterFraction: wa[t * 2], seaIceFraction: wa[t * 2 + 1], cloudFraction: cl[t * 4], opticalThickness: cl[t * 4 + 1], iceFraction: cl[t * 4 + 3], windSpeed: u };
        const hv = [sun[0] + obs[0], sun[1] + obs[1], sun[2] + obs[2]];
        const hl = Math.hypot(hv[0], hv[1], hv[2]);
        const glint = wi ? { cosBeta: (hv[0] * n[0] + hv[1] * n[1] + hv[2] * n[2]) / hl, cosOmega: (hv[0] * sun[0] + hv[1] * sun[1] + hv[2] * sun[2]) / hl } : undefined;
        const pr = earthParts(sample, mu0, mu, glint);
        const cth = Number.isFinite(cl[t * 4 + 2]) ? Math.max(cl[t * 4 + 2], 0) * 1e-3 : 0;
        const p = n.map((v) => v * model.bottomKm) as [number, number, number];
        const path = viewPath(model, tab, G, p, obs, sun, cth, 24);
        sunTransmittanceK(model, tab, 0, mu0, ts0); skyIrradianceK(model, tab, 0, mu0, es0);
        sunTransmittanceK(model, tab, cth, mu0, tsc); skyIrradianceK(model, tab, cth, mu0, esc);
        const unknownW = Math.max(1 - pr.clear.w - pr.cloudy.w, 0);
        for (let c = 0; c < 4; c++) {
          let rho = 0;
          for (let k = 0; k < K; k++) {
            const clearRad = Math.PI * path.L[k] + path.Td[k] * (pr.clear.dir[c] * ts0[k] + pr.clear.dif[c] * es0[k]);
            const cloudRad = Math.PI * path.Lc[k] + path.Tcd[k] * (pr.cloudy.dir[c] * tsc[k] + pr.cloudy.dif[c] * esc[k]);
            rho += w[c][k] * (pr.clear.w * clearRad + pr.cloudy.w * cloudRad + unknownW * Math.PI * path.L[k]);
          }
          A[c] += (rho * mu * dOmega) / Math.PI;
          A0[c] += ((pr.clear.w * pr.clear.dir[c] + pr.cloudy.w * pr.cloudy.dir[c]) * mu * dOmega) / Math.PI;
        }
        unknown += (pr.gap * mu * dOmega) / Math.PI;
      }
    }
    const ratio = A.map((a, k) => a / pMeasured[k]);
    console.log(`Earth energy check WITH atmosphere${wi ? ' and glint' : ''}: model A XYZS ${A.map((v) => v.toFixed(4)).join(' ')} (no atmosphere, same level ${A0.map((v) => v.toFixed(4)).join(' ')}); measured p ${pMeasured.map((v) => v.toFixed(4)).join(' ')}; ratio ${ratio.map((v) => v.toFixed(3)).join(' ')}; unknown share of the disk ${unknown.toFixed(3)}`);
    for (const x of ratio) {
      expect(x).toBeGreaterThan(0.5);
      expect(x).toBeLessThan(1.5);
    }
  }, 300000);
});
