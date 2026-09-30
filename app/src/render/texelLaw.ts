// Per-texel photometric model (architecture §4.4 layer kind 'photometric-parameters'): the Moon's
// Hapke parameter maps (Sato et al. 2014; surfaces/301/hapke) as the spatial law of the resolved disk.
//
// The layer gives Hapke's w, b, c, B_S0, h_S per band per ~1° cell, with θ̄, K, B_C0, h_C in its
// header constants. The albedo layer's texels are the *normal albedo* pattern per CIE channel: the
// band ratios ρ_b = A_b/⟨A_b⟩ (A_b the normal albedo without the opposition surge, RADF_b(0,0,0; B_S0 = 0))
// combined with the band → XYZS weights W[c][b] of its header (normalization.channelWeights), linearly.
// Since that combination is linear in the band reflectances, the radiance factor of channel c at any
// geometry is Σ_b W[c][b]·RADF_b(i,e,g)/⟨A_b⟩, and relative to the map texel (its value at i = e = g = 0)
//
//   R_c(i, e, g) = Σ_b W[c][b]·RADF_b(i, e, g)/⟨A_b⟩  /  Σ_b W[c][b]·RADF_b(0, 0, 0; B_S0 = 0)/⟨A_b⟩,
//
// evaluated with the parameters of the texel's cell (bilinear over known cells). The rendered radiance
// is K_c·M_c·R_c, and K_c is set so that the disk integral of M·R equals the body's disk photometry
// (ROLO for the Moon; frame.ts). Bands: the four with the largest weights in the channels (for the
// Moon 415, 566, 604, 643 nm), weights renormalized over them per channel (the others carry < 3 %).
// Cells without parameters poleward of the data take the nearest known cell of their longitude; texels
// with no parameters at all fall back to Lambert, R = μ0.

import { hapkeRadf, LAW, type ResolvedLaw } from './spatial';
import { f16ToNumber } from './surface';
import type { SurfaceLayerRef } from './scene';
import type { XYZS } from './photometry';

export const TEXEL_LAW_BANDS = 4;
const PARAMS = ['w', 'b', 'c', 'Bs0', 'hs'] as const;

export interface TexelHapke {
  width: number;
  height: number;
  bandsNm: number[];
  /** Per texel (row-major from the north edge) per band: w, b, c, B_S0, h_S; NaN where unknown. */
  params: Float32Array;
  /** Per texel: Σ_b cw[c][b]·RADF_b(0,0,0; B_S0 = 0), XYZS; 0 where unknown. */
  denom: Float32Array;
  /** cw[c][b] = W[c][b]/⟨A_b⟩, renormalized so Σ_b W[c][b] = 1 over the used bands. */
  cw: number[][];
  thetaBar: number;
  K: number;
  bc0: number;
  hc: number;
  hFn: 0 | 1;
}

/** Why a photometric-parameters layer cannot be used with this albedo layer, or null. */
export function texelLawProblem(ref: SurfaceLayerRef, albedo: SurfaceLayerRef | undefined): string | null {
  const h = ref.header;
  if (h.kind !== undefined && h.kind !== 'photometric-parameters') return `layer kind ${h.kind} is not photometric-parameters`;
  if (h.format !== undefined && h.format !== 'float16') return `photometric layer stored as ${h.format}`;
  const c = h.constants as Record<string, unknown> | undefined;
  if (!c || typeof c.thetaBarDeg !== 'number') return 'photometric layer has no Hapke constants (θ̄, K, B_C0, h_C)';
  if (typeof c.model === 'string' && !/hapke/i.test(c.model)) return 'photometric layer is not a Hapke model';
  const n = albedo?.header.normalization as { channelWeights?: { bandsNm: number[]; W: number[][] }; bandNormalAlbedoDiskMean?: Record<string, number> } | undefined;
  if (!n?.channelWeights || !n.bandNormalAlbedoDiskMean) return 'albedo layer has no band → XYZS weights to combine the per-band photometric model';
  return null;
}

/** Decode the level-0 tiles (tx = 0, 1) of a Hapke parameter layer and combine it with the albedo layer's band weights. */
export function decodeTexelHapke(ref: SurfaceLayerRef, albedo: SurfaceLayerRef, tiles: (ArrayBuffer | null)[]): TexelHapke {
  const h = ref.header;
  const channels = h.channels ?? [];
  const c = h.constants as Record<string, number | string>;
  const norm = albedo.header.normalization as unknown as { channelWeights: { bandsNm: number[]; W: number[][] }; bandNormalAlbedoDiskMean: Record<string, number> };
  const { bandsNm: allBands, W } = norm.channelWeights;
  // The bands with the largest total weight that the parameter layer also has.
  const has = (nm: number) => PARAMS.every((p) => channels.includes(`${p}@${nm}nm`));
  const ranked = allBands
    .map((nm, j) => ({ nm, j, t: W.reduce((s, row) => s + Math.abs(row[j] ?? 0), 0) }))
    .filter((b) => has(b.nm) && norm.bandNormalAlbedoDiskMean[String(b.nm)] > 0)
    .sort((a, b) => b.t - a.t)
    .slice(0, TEXEL_LAW_BANDS);
  const bands = ranked.map((b) => b.nm);
  const cw = W.map((row) => {
    const s = ranked.reduce((a, b) => a + (row[b.j] ?? 0), 0);
    return ranked.map((b) => (s > 0 ? (row[b.j] ?? 0) / s : 0) / norm.bandNormalAlbedoDiskMean[String(b.nm)]);
  });
  while (bands.length < TEXEL_LAW_BANDS) { bands.push(0); cw.forEach((r) => r.push(0)); }
  const T = 256, width = 2 * T, height = T;
  const nb = TEXEL_LAW_BANDS;
  const params = new Float32Array(width * height * nb * 5).fill(NaN);
  const denom = new Float32Array(width * height * 4);
  const nch = channels.length;
  const idx = bands.map((nm) => PARAMS.map((p) => channels.indexOf(`${p}@${nm}nm`)));
  const law: ResolvedLaw = {
    kind: LAW.hapke, p: 0, b: 0, c: 0, bs0: 0, hs: 0, bc0: 0, hc: 1,
    thetaBar: ((c.thetaBarDeg as number) * Math.PI) / 180, K: (c.porosityK as number) ?? 1, hFn: 0,
  };
  for (let tx = 0; tx < 2; tx++) {
    const buf = tiles[tx];
    if (!buf || buf.byteLength < T * T * nch * 2) continue;
    const u16 = new Uint16Array(buf);
    for (let j = 0; j < T; j++) for (let i = 0; i < T; i++) {
      const o = (j * T + i) * nch;
      let any = 0;
      for (let k = 0; k < nch; k++) any |= u16[o + k];
      if (!any) continue; // unknown texel
      const t = j * width + tx * T + i;
      const nrm = [0, 0, 0, 0];
      for (let b = 0; b < nb; b++) {
        if (!bands[b]) continue;
        const v = idx[b].map((k) => f16ToNumber(u16[o + k]));
        params.set(v, (t * nb + b) * 5);
        // Normal albedo without the surge: RADF(0, 0, 0; B_S0 = 0).
        law.p = v[0]; law.b = v[1]; law.c = v[2]; law.bs0 = 0; law.hs = v[4];
        const a0 = hapkeRadf(0, 0, 0, law);
        for (let ch = 0; ch < 4; ch++) nrm[ch] += cw[ch][b] * a0;
      }
      denom.set(nrm, t * 4);
    }
  }
  // Cells without parameters (the Moon's caps poleward of 70°) take the parameters of the nearest known
  // cell of their longitude: continuous at the edge of the data (an assumption, like the pipeline's
  // polar albedo caps; a Lambert fallback there leaves a visible step at 70°).
  const stride = nb * 5;
  for (let i = 0; i < width; i++) {
    let first = -1, last = -1;
    for (let j = 0; j < height; j++) if (denom[(j * width + i) * 4 + 1] > 0) { if (first < 0) first = j; last = j; }
    if (first < 0) continue;
    const copy = (from: number, to: number) => {
      const a = from * width + i, b = to * width + i;
      params.copyWithin(b * stride, a * stride, a * stride + stride);
      denom.copyWithin(b * 4, a * 4, a * 4 + 4);
    };
    for (let j = 0; j < first; j++) copy(first, j);
    for (let j = last + 1; j < height; j++) copy(last, j);
  }
  return {
    width, height, bandsNm: bands, params, denom, cw,
    thetaBar: law.thetaBar, K: law.K,
    bc0: typeof c.Bc0 === 'number' ? c.Bc0 : 0, hc: typeof c.hc === 'number' ? c.hc : 1, hFn: 0,
  };
}

/**
 * R_c at body-fixed planetocentric (lat, lon) (radians) and geometry (μ0, μ, g): bilinear interpolation of
 * the known cells' parameters (the GPU does the same), Lambert (μ0) where no cell is known.
 */
export function texelRadf(t: TexelHapke, lat: number, lon: number, mu0: number, mu: number, g: number): XYZS {
  if (!(mu0 > 0) || !(mu > 0)) return [0, 0, 0, 0];
  const u = ((lon + Math.PI) / (2 * Math.PI)) * t.width - 0.5;
  const v = ((Math.PI / 2 - lat) / Math.PI) * t.height - 0.5;
  const i0 = Math.floor(u), j0 = Math.floor(v);
  const fu = u - i0, fv = v - j0;
  const nb = TEXEL_LAW_BANDS;
  const p = new Float64Array(nb * 5);
  const d = [0, 0, 0, 0];
  let wsum = 0;
  for (let k = 0; k < 4; k++) {
    const di = k & 1, dj = k >> 1;
    const w = (di ? fu : 1 - fu) * (dj ? fv : 1 - fv);
    const ii = (((i0 + di) % t.width) + t.width) % t.width;
    const jj = Math.min(Math.max(j0 + dj, 0), t.height - 1);
    const tix = jj * t.width + ii;
    if (!(t.denom[tix * 4 + 1] > 0) || !(w > 0)) continue;
    wsum += w;
    for (let q = 0; q < nb * 5; q++) {
      const val = t.params[tix * nb * 5 + q];
      p[q] += w * (Number.isFinite(val) ? val : 0);
    }
    for (let ch = 0; ch < 4; ch++) d[ch] += w * t.denom[tix * 4 + ch];
  }
  if (!(wsum > 0)) return [mu0, mu0, mu0, mu0];
  const law: ResolvedLaw = { kind: LAW.hapke, p: 0, b: 0, c: 0, bs0: 0, hs: 0, bc0: t.bc0, hc: t.hc, thetaBar: t.thetaBar, K: t.K, hFn: t.hFn };
  const i = Math.acos(Math.min(1, mu0)), e = Math.acos(Math.min(1, mu));
  const num = [0, 0, 0, 0];
  for (let b = 0; b < nb; b++) {
    if (!t.bandsNm[b]) continue;
    const o = b * 5;
    law.p = p[o] / wsum; law.b = p[o + 1] / wsum; law.c = p[o + 2] / wsum; law.bs0 = p[o + 3] / wsum; law.hs = p[o + 4] / wsum;
    const r = hapkeRadf(i, e, g, law);
    for (let ch = 0; ch < 4; ch++) num[ch] += t.cw[ch][b] * r;
  }
  return [0, 1, 2, 3].map((ch) => (d[ch] > 0 ? num[ch] / (d[ch] / wsum) : mu0)) as XYZS;
}

/**
 * GPU layout: an rgba16float 2-D array texture of `width × height × 6` layers: w, b, c, B_S0, h_S of the
 * four bands (one layer per parameter, bands in x, y, z, w), then the denominator (XYZS; 0 = unknown).
 */
export function texelHapkeGpuLayers(t: TexelHapke): Float32Array<ArrayBuffer> {
  const n = t.width * t.height;
  const out = new Float32Array(n * 4 * 6);
  const nb = TEXEL_LAW_BANDS;
  for (let tix = 0; tix < n; tix++) {
    for (let q = 0; q < 5; q++) for (let b = 0; b < nb; b++) {
      const v = t.params[(tix * nb + b) * 5 + q];
      out[q * n * 4 + tix * 4 + b] = Number.isFinite(v) ? v : 0;
    }
    for (let ch = 0; ch < 4; ch++) out[5 * n * 4 + tix * 4 + ch] = t.denom[tix * 4 + ch];
  }
  return out;
}
