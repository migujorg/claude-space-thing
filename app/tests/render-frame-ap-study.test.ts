// CPU evidence, not rendered-frame validation: viewPath is spherical, the GPU altitude is ellipsoidal.
import { expect, it } from 'vitest';
import type { AtmosphereFile, BodyPhotometry, LightData, ValidationCase } from '../src/data/schema';
import { atmosphereModelFromData, precomputeAtmosphere, ProfileGrid, viewPath } from '../src/render/atmosphere';
import { LAMBERT_ALBEDO_PER_GEOMETRIC_ALBEDO } from '../src/render/photometry';
import { dot, farHit, mulMV, normalize, prepareBody, scale } from '../src/render/raycast';
import { aerialPerspectiveSize, type FrameLimits } from '../src/render/frameSizing';
import { DATA_DIR } from './core-data';
const fs: { existsSync(p: string): boolean; readFileSync(p: string | URL, enc: 'utf8'): string } = await import(/* @vite-ignore */ 'node:fs' as string);
const available = ['atmospheres', 'photometry', 'light'].every((p) => fs.existsSync(DATA_DIR + p + '.json'));
if (!available) console.warn('NOT COMPARED: Himawari aerial-grid CPU interpolation (built inputs absent)');
it.skipIf(!available)('measures the grid cap at Himawari ROI centres with the spherical CPU twin', () => {
  const c: ValidationCase = JSON.parse(fs.readFileSync(new URL('../../validation/cases/earth-himawari9-2026/case.json', import.meta.url), 'utf8'));
  const af: AtmosphereFile = JSON.parse(fs.readFileSync(DATA_DIR + 'atmospheres.json', 'utf8'));
  const phot: Record<string, BodyPhotometry> = JSON.parse(fs.readFileSync(DATA_DIR + 'photometry.json', 'utf8'));
  const light: LightData = JSON.parse(fs.readFileSync(DATA_DIR + 'light.json', 'utf8'));
  const irr = light.sun.irradianceXYZS_1AU.value!;
  const ground = phot['399'].geometricAlbedoXYZS.value!.map((a, k) => LAMBERT_ALBEDO_PER_GEOMETRIC_ALBEDO * a / irr[k]);
  const built = atmosphereModelFromData({ body: af.bodies['399'], wavelengthsNm: af.wavelengthsNm, foldWeights: af.foldWeights.value! }, ground);
  if ('error' in built) throw new Error(built.error);
  const m = built.model, tab = precomputeAtmosphere(m), grid = new ProfileGrid(m, 512);
  const vb = c.view.bodies[0], camera = c.view.camera;
  const body = prepareBody(vb.pos, [m.bottomKm, m.bottomKm, m.bottomKm], null), S = normalize(vb.toSun);
  const limits: FrameLimits = { maxTextureDimension2D: 16384, maxTextureDimension3D: 2048, maxBufferSize: 2 ** 28, maxStorageBufferBindingSize: 2 ** 27, maxComputeWorkgroupsPerDimension: 65535 };
  const rows = [];
  for (const ss of [3, 6]) {
    const W = camera.width * ss, H = camera.height * ss;
    const oldPx = Math.max(2, Math.ceil(H / 270)), cap = aerialPerspectiveSize(W, H, 10, 3, limits)!;
    const march = (x: number, y: number) => {
      const dir = normalize(mulMV(camera.orient, [(x - W / 2) * camera.pixelPitchRad / ss, (H / 2 - y) * camera.pixelPitchRad / ss, -1]));
      const dn = dot(dir, body.n), hit = farHit(body, dot(dir, body.e1) / dn, dot(dir, body.e2) / dn);
      if (dn <= 0 || hit.disc < 0 || hit.t <= 0) return null;
      const path = viewPath(m, tab, grid, mulMV(body.Mi, hit.h), scale(dir, -1), S, 0, 32);
      return [...m.weights.map((weights) => weights.reduce((a, w, k) => a + w * path.L[k], 0)), ...Array.from(path.Td)];
    };
    const interpolate = (x: number, y: number, spacing: number) => {
      const cx = x / spacing - 0.5, cy = y / spacing - 0.5;
      const ix = Math.floor(cx), iy = Math.floor(cy), fx = cx - ix, fy = cy - iy;
      let sum: number[] | null = null;
      for (let n = 0; n < 4; n++) {
        const qx = Math.min(Math.ceil(W / spacing) - 1, Math.max(0, ix + (n & 1)));
        const qy = Math.min(Math.ceil(H / spacing) - 1, Math.max(0, iy + (n >> 1)));
        const v = march((qx + 0.5) * spacing, (qy + 0.5) * spacing);
        if (!v) return march(x, y); // shader fallback if a neighbour misses
        const w = ((n & 1) ? fx : 1 - fx) * ((n >> 1) ? fy : 1 - fy);
        sum ??= v.map(() => 0); v.forEach((a, k) => { sum![k] += w * a; });
      }
      return sum;
    };
    for (const roi of c.rois.filter((r) => !r.id.startsWith('sky'))) {
      const x = (roi.rect[0] + roi.rect[2]) * ss / 2, y = (roi.rect[1] + roi.rect[3]) * ss / 2;
      const a = interpolate(x, y, oldPx), b = interpolate(x, y, cap.colPx);
      expect(a).not.toBeNull(); expect(b).not.toBeNull();
      rows.push({ ss, roi: roi.id, oldPx, capPx: cap.colPx,
        Lrelative: a!.slice(0, 4).map((v, k) => (b![k] - v) / v),
        maxTabsolute: Math.max(...a!.slice(4).map((v, k) => Math.abs(b![k + 4] - v))),
        subSatelliteColumnKm: (vb.rangeKm - m.bottomKm) * camera.pixelPitchRad * cap.colPx / ss });
    }
  }
  console.log('HIMAWARI-AP-CPU ' + JSON.stringify(rows));
  expect(rows).toHaveLength(12);
  for (const r of rows) expect(r.Lrelative.every(Number.isFinite)).toBe(true);
});
