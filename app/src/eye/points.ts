// How a point source (star, unresolved body) is shown (docs/eye-model.md §6.3), and the display-space
// glare criterion shared with extended sources. The WGSL point shader mirrors pointAppearance(); this
// is the reference and is unit-tested.
//
// Ricco's law governs how BRIGHT a small source looks, not how BIG: a point of illuminance E on a
// background B is as detectable, and (our supra-threshold extension) as bright, as a patch of the Ricco
// area A_R with luminance B + E/A_R. So:
//  1. perceived brightness: the scene observer's response to B + E·u/A_R (u = unscattered fraction) is
//     mapped through Pattanaik's appearance rules to the display luminance that evokes it in the display
//     observer — the *intended* display luminance, which may exceed what the display can show;
//  2. the display must evoke the same brightness in the *viewer*, who sums a small displayed dot over
//     their own Ricco area A_R,disp (Crumey's A_R at the display adaptation): the dot's flux is
//     Φ = ΔL_d·A_R,disp, drawn as a sharp splat of the eye's optical core (never the Ricco size);
//  3. glare: the part of Φ the splat cannot hold (its peak would exceed the display maximum) is the
//     "overflow". The display cannot show it, so the viewer's own eye cannot scatter it: the renderer
//     paints the glare the viewer's eye would add to it (the same CIE 146 kernel), in display units.
//     Light the display does show gets no painted glare (the viewer's eye adds its own). This is the
//     criterion of glare rendering as a conveyer of luminance beyond the display's range (Spencer et al.
//     1995; Yoshida et al. 2008; Ritschel et al. 2009), made quantitative with the display observer.
//  4. colour: cones alone carry colour and a point concentrates its light on few cones, so a star's
//     colour exponent (Pattanaik Eq. 3) is set by its own cone signal, B + E·u/A_c with A_c the cone
//     system's summation area, not by the pixel's (tiny) mean luminance.

//  5. fixation: a point is judged as the eye sees it when looking at it — adapted to its own local
//     background (the sky plus veil around it), not to the frame's global state. This is the condition of
//     Crumey's thresholds (an observer adapted to the background at the source) and it keeps faint stars
//     visible beside a bright body the extended image is adapted to (docs/eye-model.md §2 "Fixations").

import { blackwellEquivalent } from './mesopic';
import { PATTANAIK } from './constants';
import { localObserver, type EyeFrame, type LocalObserver } from './model';
import { colourExponent, lumResponse, response, type AppearanceMap, type DisplayObserver, type ObserverState } from './tonemap';

export interface PointAppearance {
  /** Above the local visibility threshold (Crumey, field factor F, at the point's own background)? */
  visible: boolean;
  /** Intended display luminance increment of the Ricco-equivalent patch, cd/m² (may exceed the peak). */
  deltaLd: number;
  /** Display flux wanted (ΔL_d·A_R,disp), drawn in the splat, and overflowing (painted as glare), cd·m⁻²·sr. */
  wantedFlux: number;
  drawnFlux: number;
  overflowFlux: number;
  /** Peak display luminance of the drawn splat, cd/m². */
  peakLd: number;
  /** Colour exponent from the source's own cone signal (1 = colorimetric, 0 = grey). */
  colourExponent: number;
}

/**
 * The display luminance that would evoke the scene observer's response in the display observer
 * (Pattanaik's appearance map and inverse display model) WITHOUT clamping at the display peak. It is
 * bounded by Hunt's cone-bleaching luminance (Pattanaik Eq. 6, 2·10⁶ cd/m²), beyond which the display
 * observer's response is no longer defined by the model.
 */
export function intendedDisplayLd(o: { scene: ObserverState; map: AppearanceMap; display: DisplayObserver }, Lp: number, Ls: number): number {
  const d = o.display;
  const Rd = o.map.gain * lumResponse(o.scene, Lp, Ls) + o.map.offset;
  if (!(Rd > 0)) return 0;
  if (Rd >= response(PATTANAIK.coneBleachHalf, d.sigma, d.B)) return PATTANAIK.coneBleachHalf;
  return d.sigma * Math.pow(Rd / (d.B - Rd), 1 / PATTANAIK.n);
}

/** The eye looking at a point: adapted to the point's physical local background (Y, S), cd/m². */
export function pointObserver(eye: EyeFrame, bg: { Y: number; S: number }): LocalObserver {
  return localObserver(eye.settings, eye.display, bg.Y, bg.S, eye.exposure, eye.dark);
}

/**
 * @param E point illuminance at the eye, lux: photopic Y and scotopic S
 * @param bg local physical background luminance (Y, S), cd/m², excluding the source itself; the eye
 *   judging the point is adapted to it (pointObserver)
 * @param unscattered fraction of the light not scattered out of the core (1 − CIE 146 kernel energy)
 * @param splatAreaSr effective area of the drawn splat (flux / peak luminance), sr
 */
export function pointAppearance(eye: EyeFrame, E: { Y: number; S: number }, bg: { Y: number; S: number }, unscattered: number, splatAreaSr: number): PointAppearance {
  const x = eye.exposure;
  const o = pointObserver(eye, bg);
  const obs = { scene: o.scene, map: o.map, display: eye.display };
  const visible = blackwellEquivalent(E.Y, E.S, o.mesopic.m) >= o.thresholdBwLux;
  const bY = bg.Y * x, bS = bg.S * x;
  const eY = (E.Y * unscattered * x) / o.riccoAreaSr, eS = (E.S * unscattered * x) / o.riccoAreaSr;
  const Lb = intendedDisplayLd(obs, bY, bS);
  const deltaLd = visible ? Math.max(0, intendedDisplayLd(obs, bY + eY, bS + eS) - Lb) : 0;
  const wantedFlux = deltaLd * eye.displayRiccoSr;
  const Ldb = Math.min(Lb, eye.display.maxLd);
  const capacity = Math.max(0, eye.display.maxLd - Ldb) * splatAreaSr;
  const drawnFlux = Math.min(wantedFlux, capacity);
  const peakLd = Ldb + drawnFlux / splatAreaSr;
  const Lc = bY + (E.Y * unscattered * x) / o.coneSummationSr;
  return { visible, deltaLd, wantedFlux, drawnFlux, overflowFlux: wantedFlux - drawnFlux, peakLd, colourExponent: colourExponent(Lc, o.scene, peakLd, eye.display) };
}

// ── The local background of a point and the cull (shaders.ts CULL_SHADER; renderer.ts steps 2–4) ──────────────
// The reference for what the GPU does, unit-tested (tests/eye-points.test.ts). The point image (PT) holds every
// source in the frame, whether the eye can pick it out or not: its light reaches the eye either way. So the veil
// a source is judged against is a function of the scene alone, and no verdict depends on an earlier one (a
// source's own or a neighbour's). The cull decides only what is displayed as a point, and it alone decides: its
// test is the display's (pointBackground), so the sources it passes are the sources on the screen.

/** One level of the retina pyramid: its weight in the CIE 146 kernel fit and its Gaussian's σ in pixels. */
export interface VeilLevel {
  weight: number;
  sigmaPx: number;
}

/** A point source in the frame: position in pixels, illuminance at the eye in lux (photopic Y, scotopic S). */
export interface PointSource {
  x: number;
  y: number;
  E: { Y: number; S: number };
}

/**
 * The veil level a point's local background is read at: the first whose Gaussian's equivalent area 2πσ_k²·Ω_px
 * reaches the Ricco area, so a point's own core glare does not mask it (docs/eye-model.md §6); the last level
 * when none does.
 */
export function backgroundLevel(levels: VeilLevel[], pixelSr: number, riccoAreaSr: number): number {
  let k = 0;
  while (k < levels.length - 1 && 2 * Math.PI * levels[k].sigmaPx ** 2 * pixelSr < riccoAreaSr) k++;
  return k;
}

/**
 * What a source of unit illuminance adds to that background r pixels away, per pixel solid angle (multiply by
 * E/Ω_px for cd/m²): Σ_{k≥kR} w_k·exp(−r²/2σ_k²)/(2πσ_k²).
 */
export function veilKernelPerPixel(levels: VeilLevel[], kR: number, rPx: number): number {
  let v = 0;
  for (let k = kR; k < levels.length; k++) {
    const s2 = levels[k].sigmaPx ** 2;
    v += (levels[k].weight * Math.exp(-(rPx * rPx) / (2 * s2))) / (2 * Math.PI * s2);
  }
  return v;
}

/**
 * The continuous kernel at zero distance. In the continuous model of the veil (pointVeil) this is a source's own
 * light in its background; in the shaders' pyramid it is not (ownVeilExact below is), and nothing on the GPU uses it.
 */
export function ownVeilPerPixel(levels: VeilLevel[], kR: number): number {
  return veilKernelPerPixel(levels, kR, 0);
}

/**
 * The point sources' part of the background texture at each source (cd/m²): the veil, at scales from the Ricco
 * area up, of EVERY source given, its own light included. There is no verdict among the arguments.
 */
export function pointVeil(sources: PointSource[], levels: VeilLevel[], kR: number, pixelSr: number): { Y: number; S: number }[] {
  return sources.map((a) => {
    let Y = 0, S = 0;
    for (const b of sources) {
      const k = veilKernelPerPixel(levels, kR, Math.hypot(a.x - b.x, a.y - b.y)) / pixelSr;
      Y += b.E.Y * k;
      S += b.E.S * k;
    }
    return { Y, S };
  });
}

/**
 * The background a source is judged against and seen on (cd/m²; shaders.ts pointBackground, one function for the
 * cull and the point shader): the veil texture at the source less the source's own light there (never below zero:
 * a texture from before the source was in the frame does not hold it), plus the analytic veil (Sun, off-frame
 * bodies), plus the extended image's unscattered light at the source's pixel (the sky, a disk or an atmosphere
 * behind it).
 */
export function pointBackground(texture: { Y: number; S: number }, own: { Y: number; S: number }, analytic: { Y: number; S: number }, direct: { Y: number; S: number }): { Y: number; S: number } {
  return { Y: Math.max(texture.Y - own.Y, 0) + analytic.Y + direct.Y, S: Math.max(texture.S - own.S, 0) + analytic.S + direct.S };
}

/** The verdict: is the point above the threshold of the eye looking at it, adapted to that background? */
export function pointVisible(eye: EyeFrame, E: { Y: number; S: number }, bg: { Y: number; S: number }): boolean {
  const o = pointObserver(eye, bg);
  return blackwellEquivalent(E.Y, E.S, o.mesopic.m) >= o.thresholdBwLux;
}

// ── A source's own light in its background, exactly ───────────────────────────────────────────────────────────
// What the level-kR veil texture holds of ONE source, read at that source: the number the cull has to take out of
// the texture so that a source alone on a dark background is judged against zero. It is not the kernel at zero
// distance (ownVeilPerPixel): the splat has a width, level kR is read and not level 0, and the value moves with
// the source's place in the texels (tests/eye-points.test.ts states by how much).
//
// Every stage between the splat and the read is a product of the same operation along x and along y:
//   the splat          Gaussian samples at the pixel centres within ±extent of the centre (a square cut-off, one
//                      solid angle for the whole splat);
//   down               the mean of two texels, a texel beyond the edge counting as zero;
//   blurH, blurV       seven taps, zero beyond the edge;
//   accum's upsample   each texel takes 3/4 of its parent and 1/4 of the parent's neighbour, zero beyond the edge;
//   the read           linear between two texels of level kR, indices clamped; texel t of level k covers the
//                      pixels [t·2^k, (t+1)·2^k).
// So level k's part of the texture at the source is rho_k(x)·rho_k(y), and the whole is
//   N · Σ_{k ≥ kR} w_k · rho_k(x) · rho_k(y)      per unit illuminance and per pixel solid angle,
// with N the splat's normalisation. Nothing is fitted and no texture is read.
//
// The cull computes it per source (shaders.ts CULL_SHADER ownAxis, the same arithmetic) and hands it to the point
// shader in the list; the renderer computes it here for the points it writes itself (unresolved bodies). Measured
// on the GPU for a source alone in the frame (scripts/point-census.mjs --lone): what is left of its own light in
// its background is under 10⁻⁶ of it where the HDR targets are float32, and under 10⁻³ where they are half float.
// Until 7 October 2026 the shaders subtracted ownVeilPerPixel, which is 30 to 60 % too much at level 0.

/** The retina pyramid's blur: a discrete Gaussian of σ = 1 texel, seven taps (shaders.ts PYRAMID_SHADER W0..W3). */
export const VEIL_BLUR_TAPS: readonly number[] = [0.39905027, 0.24203623, 0.05400558, 0.00443305];

/** A point source's splat: a Gaussian of sigmaPx sampled at pixel centres, cut where |dx| or |dy| exceeds extentPx. */
export interface PointSplat {
  sigmaPx: number;
  extentPx: number;
}

/** erf(x) to double precision: the series below 2.5, the continued fraction of erfc above. */
export function erf(x: number): number {
  const ax = Math.abs(x);
  let r: number;
  if (ax < 2.5) {
    let sum = ax, term = ax;
    for (let n = 1; n < 90; n++) {
      term *= (-ax * ax) / n;
      sum += term / (2 * n + 1);
    }
    r = (2 / Math.sqrt(Math.PI)) * sum;
  } else {
    let f = 0;
    for (let n = 60; n >= 1; n--) f = n / 2 / (ax + f);
    r = 1 - Math.exp(-ax * ax) / (Math.sqrt(Math.PI) * (ax + f));
  }
  return x < 0 ? -r : r;
}

/**
 * The splat's normalisation, per px²: the integral of the cut Gaussian over the square is 1. The samples of one
 * splat sum to 1 only on average over sub-pixel positions: between 0.990 and 1.005 at σ = 0.6 px with the cut-off
 * at 3σ, because the cut-off is hard and a pixel centre crossing it carries e^−4.5 of the peak (the round cut-off
 * the shaders use today gives 0.986 to 1.005). The own-light term uses the samples themselves, so it is exact
 * whatever they sum to.
 */
export function splatNorm(splat: PointSplat): number {
  const e = erf(splat.extentPx / (splat.sigmaPx * Math.SQRT2));
  return 1 / (2 * Math.PI * splat.sigmaPx * splat.sigmaPx * e * e);
}

/**
 * One axis of the exact own-light term: rho[k] for every level k ≥ kR that has weight (0 elsewhere), for a splat
 * centred at c (px along this axis; pixel i covers [i, i+1)) in a frame n0 pixels long. Unnormalised: the splat's
 * samples are exp(−d²/2σ²).
 *
 * rho[k] = 2^−k · Σ_pixels g_i · Σ_j l_k[j] · tap(|a_k + j − (i >> k)|): the splat's sample g_i falls in texel i >> k
 * of level k, the blur brings it to the three texels a_k … a_k + 2 the read reaches, and l_k are that read's weights
 * on them (two texels of level kR, carried up one upsampling per level).
 */
export function ownVeilAxis(c: number, n0: number, splat: PointSplat, kR: number, weights: readonly number[]): number[] {
  const K = weights.length;
  const rho = new Array<number>(K).fill(0);
  const p0 = Math.max(0, Math.ceil(c - splat.extentPx - 0.5));
  const p1 = Math.min(n0 - 1, Math.floor(c + splat.extentPx - 0.5));
  if (p1 < p0 || kR >= K) return rho;
  const g: number[] = [];
  for (let i = p0; i <= p1; i++) {
    const d = i + 0.5 - c;
    g.push(Math.abs(d) <= splat.extentPx ? Math.exp(-(d * d) / (2 * splat.sigmaPx * splat.sigmaPx)) : 0);
  }
  // The read: two texels of level kR.
  let n = Math.max(1, Math.ceil(n0 / 2 ** kR));
  const cc = c / 2 ** kR - 0.5;
  const i0 = Math.floor(cc), fr = cc - i0;
  const clampTexel = (t: number) => Math.min(Math.max(t, 0), n - 1);
  let a = clampTexel(i0);
  let l = [1 - fr, 0, 0];
  l[clampTexel(i0 + 1) - a] += fr;
  for (let k = kR; k < K; k++) {
    if (k > kR) {
      // One more upsampling of the accumulation: texel t reads its parent t >> 1 (3/4) and the parent's neighbour
      // on t's side (1/4); a texel beyond the level's edge holds nothing.
      n = Math.max(1, Math.ceil(n / 2));
      const b = (a - 1) >> 1;
      const m = [0, 0, 0];
      for (let j = 0; j < 3; j++) {
        if (l[j] === 0) continue;
        const t = a + j;
        const parent = t >> 1, neighbour = t & 1 ? parent + 1 : parent - 1;
        if (parent >= 0 && parent < n) m[parent - b] += 0.75 * l[j];
        if (neighbour >= 0 && neighbour < n) m[neighbour - b] += 0.25 * l[j];
      }
      a = b;
      l = m;
    }
    if (!(weights[k] > 0)) continue;
    let r = 0;
    for (let i = 0; i < g.length; i++) {
      const o = ((p0 + i) >> k) - a;
      if (o < -3 || o > 5) continue;
      let q = 0;
      for (let j = 0; j < 3; j++) {
        const d = Math.abs(j - o);
        if (d <= 3) q += l[j] * VEIL_BLUR_TAPS[d];
      }
      r += g[i] * q;
    }
    rho[k] = r / 2 ** k;
  }
  return rho;
}

/**
 * What the level-kR veil texture holds of a source at (x, y) px, read at the source, per unit illuminance and per
 * pixel solid angle (multiply by E/Ω for cd/m²): N · Σ_{k ≥ kR} w_k · rho_k(x) · rho_k(y). The centre may lie
 * outside the frame: only the part of the splat inside it is in the point image.
 */
export function ownVeilExact(x: number, y: number, W: number, H: number, splat: PointSplat, kR: number, weights: readonly number[]): number {
  const rx = ownVeilAxis(x, W, splat, kR, weights);
  const ry = ownVeilAxis(y, H, splat, kR, weights);
  let s = 0;
  for (let k = kR; k < weights.length; k++) s += weights[k] * rx[k] * ry[k];
  return s * splatNorm(splat);
}
