// CPU-side (float64) preparation of one frame: which bodies are resolved disks and which are points,
// their photometry per docs/architecture.md §4.3, eclipse occluders, the Sun, analytic glare sources
// and display-space overlays. No GPU calls here; renderer.ts packs the result into buffers.

import type { SceneBody, SceneSnapshot } from './scene';
import { AU_KM } from './constants';
import { diskIlluminance, evalPhase, lambertRadianceFactor, limbDarkenedI0, meanRadius, spatialScale, type XYZS } from './photometry';
import { dot, len, normalize, prepareBody, scale, sub, type BodyFrame, type M3, type V3 } from './raycast';
import { camToNdc, MARKER_COLOR, PROVENANCE_TINT, PROVENANCE_TINT_ALPHA, ringVertices, toCam, type CameraGeom } from './overlays';
import { blackwellEquivalent } from '../eye/mesopic';
import type { EyeFrame } from '../eye/model';
import { CIE146 } from '../eye/constants';
import { DEG2_PER_SR } from '../eye/pupil';

export interface ResolvedBody {
  body: SceneBody;
  frame: BodyFrame;
  lit: boolean;
  /** Radiance prefactor K (XYZS): L = K·cos i, already multiplied by the resolved fraction. */
  K: XYZS;
  sunDir: V3;
  sunDistKm: number;
  sunRadiusKm: number;
  riccoWeight: number;
  occluders: [V3, number][];
  hatch: boolean;
  tint: [number, number, number, number] | null;
}

export interface PointSource {
  ndc: [number, number];
  depth: number;
  E: XYZS;
}

export interface SunPrep {
  n: V3;
  e1: V3;
  e2: V3;
  distKm: number;
  radiusKm: number;
  beta: number;
  I0: XYZS;
  coeffs: number[][]; // per channel, μ^0..μ^5
  resolvedFraction: number;
  point: PointSource | null;
}

export interface GlareSource {
  dir: V3;
  /** Angle below which the source's own angular radius applies, degrees. */
  minDeg: number;
  E: XYZS;
  /** Whether the source's centre is inside the frame (its light is then in the HDR image). */
  inFrame: boolean;
}

export interface PreparedFrame {
  resolved: ResolvedBody[];
  points: PointSource[];
  sun: SunPrep | null;
  glare: GlareSource[];
  /** Overlay vertices (x, y, depth, r, g, b, a). */
  overlay: number[];
  warnings: string[];
  adaptedWhite: V3 | null;
  /**
   * Corneal flux ∫L dΩ (cd·m⁻²·deg²) of glare sources in the visual field (≤ 100° from fixation) whose
   * centre is outside the frame. Their light is not in the HDR image but still reaches the eye, so it
   * drives the pupil (Watson & Yellott 2012) together with the frame's own flux.
   */
  offFrameFluxDeg2: number;
}

export function cameraGeom(snap: SceneSnapshot, W: number, H: number, near: number): CameraGeom {
  const o = snap.camera.orient;
  const tanY = Math.tan(snap.camera.fovY / 2);
  return {
    right: [o[0], o[3], o[6]],
    up: [o[1], o[4], o[7]],
    back: [o[2], o[5], o[8]],
    tanX: (tanY * W) / H,
    tanY,
    W,
    H,
    near,
    pixelAngle: (2 * tanY) / H,
  };
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Fraction of a disk of angular radius rs covered by a disk of radius ro at separation d (planar). */
export function diskOverlapFraction(rs: number, ro: number, d: number): number {
  if (d >= rs + ro) return 0;
  if (d <= Math.abs(rs - ro)) return Math.min(1, (Math.min(rs, ro) / rs) ** 2);
  const a1 = rs * rs * Math.acos(Math.min(1, Math.max(-1, (d * d + rs * rs - ro * ro) / (2 * d * rs))));
  const a2 = ro * ro * Math.acos(Math.min(1, Math.max(-1, (d * d + ro * ro - rs * rs) / (2 * d * ro))));
  const k = 0.5 * Math.sqrt(Math.max(0, (-d + rs + ro) * (d + rs - ro) * (d - rs + ro) * (d + rs + ro)));
  return Math.min(1, (a1 + a2 - k) / (Math.PI * rs * rs));
}

const angle = (a: V3, b: V3) => 2 * Math.asin(Math.min(1, 0.5 * len(sub(normalize(a), normalize(b)))));

/**
 * @param pointFootprintSr equivalent solid angle of a point splat's footprint (for the Ricco weight)
 */
export function prepareFrame(snap: SceneSnapshot, g: CameraGeom, eye: EyeFrame, pointFootprintSr: number): PreparedFrame {
  const warnings: string[] = [];
  const resolved: ResolvedBody[] = [];
  const points: PointSource[] = [];
  const glare: GlareSource[] = [];
  const overlay: number[] = [];
  const tintOn = snap.view.overlays.provenanceTint;
  const fwd: V3 = [-g.back[0], -g.back[1], -g.back[2]];
  const AR = eye.riccoAreaSr;

  const inFrame = (c: V3) => {
    if (c[2] >= 0) return false;
    const p = camToNdc(g, c);
    return Math.abs(p[0]) <= 1 && Math.abs(p[1]) <= 1;
  };

  // Sun first (its radius is needed for eclipse shadows).
  const sunR = snap.sun?.radius ?? 0;
  let sun: SunPrep | null = null;
  let adaptedWhite: V3 | null = null;
  if (snap.sun) {
    const s = snap.sun;
    const dist = len(s.pos);
    const dAU = dist / AU_KM;
    const E: XYZS = [0, 1, 2, 3].map((k) => s.irradianceXYZS_1AU[k] / (dAU * dAU)) as XYZS;
    adaptedWhite = [s.irradianceXYZS_1AU[0], s.irradianceXYZS_1AU[1], s.irradianceXYZS_1AU[2]];
    const n = scale(s.pos, 1 / dist);
    const rho = Math.asin(Math.min(1, s.radius / dist));
    const diamPx = (2 * rho) / g.pixelAngle;
    let fRes = s.limbDarkening ? smooth(1, 2, diamPx) : 0;
    if (!s.limbDarkening && diamPx > 1) warnings.push('Sun: limb darkening unknown → drawn as an unresolved point of the correct illuminance (no uniform disk assumed)');
    const c = toCam(g, s.pos);
    const sunInFrame = inFrame(c);
    // Visible fraction of the disk (bodies in front), for the analytic glare veil.
    let covered = 0;
    for (const b of snap.bodies) {
      if (!b.radii) continue;
      const D = len(b.pos);
      if (D >= dist) continue;
      const rb = Math.asin(Math.min(1, meanRadius(b.radii) / D));
      covered += diskOverlapFraction(rho, rb, angle(b.pos, s.pos));
    }
    const vis = Math.max(0, 1 - covered);
    glare.push({ dir: n, minDeg: (rho * 180) / Math.PI, E: E.map((v) => v * vis) as XYZS, inFrame: sunInFrame });
    const coeffs: number[][] = [0, 1, 2, 3].map((k) => {
      const src = s.limbDarkening?.[k] ?? [1];
      if (src.length > 6) warnings.push('Sun: limb-darkening polynomial truncated to degree 5');
      return [0, 1, 2, 3, 4, 5].map((i) => src[i] ?? 0);
    });
    const I0 = [0, 1, 2, 3].map((k) => (fRes > 0 ? limbDarkenedI0(E[k], coeffs[k], s.radius, dist) : 0)) as XYZS;
    let point: PointSource | null = null;
    if (fRes < 1 && c[2] < 0) {
      point = { ndc: camToNdc(g, c), depth: g.near / -c[2], E: E.map((v) => v * (1 - fRes)) as XYZS };
    }
    if (c[2] >= 0) fRes = 0;
    const [e1, e2] = tangent(n);
    const margin = 3 * g.pixelAngle;
    sun = {
      n, e1, e2, distKm: dist, radiusKm: s.radius,
      beta: Math.tan(Math.min(rho + margin, 1.4)),
      I0, coeffs, resolvedFraction: fRes, point,
    };
  }

  for (const b of snap.bodies) {
    const D = len(b.pos);
    if (!(D > 0)) continue;
    const c = toCam(g, b.pos);
    const tint = tintOn ? ([...PROVENANCE_TINT[b.worstLabel], PROVENANCE_TINT_ALPHA] as [number, number, number, number]) : null;
    if (!b.radii) {
      // Position known, size unknown: no brightness can be computed (R is needed) → hollow marker.
      if (c[2] < 0) ringVertices(camToNdc(g, c), 6, 1.5, tint ?? MARKER_COLOR, g, overlay);
      continue;
    }
    const R = meanRadius(b.radii);
    const angR = Math.asin(Math.min(1, R / D));
    const behind = dot(normalize(b.pos), fwd) < -Math.sin(Math.max(angR, Math.asin(Math.min(1, Math.max(...b.radii) / D))));
    // Photometry, or the reason it is unavailable.
    let E: XYZS | null = null;
    let K: XYZS = [0, 0, 0, 0];
    let lit = false;
    const toSunLen = len(b.toSun);
    const dAU = toSunLen / AU_KM;
    const sunDir = scale(b.toSun, 1 / toSunLen);
    const alpha = angle(b.toSun, scale(b.pos, -1));
    if (!b.surfaceUnknown && b.albedoXYZS && b.phase) {
      const ph = evalPhase(b.phase, alpha);
      if (!ph.ok) warnings.push(`${b.name}: ${ph.reason} → surface drawn as not measured`);
      else {
        const sc = spatialScale(b.phase, ph.phi, alpha);
        E = diskIlluminance(b.albedoXYZS, dAU, R, D, ph.phi);
        if (sc !== null) {
          K = lambertRadianceFactor(b.albedoXYZS, dAU, sc);
          lit = true;
        }
      }
    }
    const hatch = !lit && !(E && E[1] > 0);
    const diamPx = (2 * angR) / g.pixelAngle;
    const fRes = smooth(1, 2, diamPx);
    const At = 2 * Math.PI * (1 - Math.cos(angR));
    const ricco = Math.min(1, Math.max(At, pointFootprintSr) / AR);

    // Off-frame bright bodies still veil the view (analytic glare).
    if (E && !inFrame(c)) glare.push({ dir: normalize(b.pos), minDeg: (angR * 180) / Math.PI, E, inFrame: false });

    if (behind) continue;
    if (fRes > 0) {
      let radii = b.radii;
      let orient = b.orient as M3 | null;
      if (!orient && !(radii[0] === radii[1] && radii[1] === radii[2])) {
        warnings.push(`${b.name}: orientation unknown → drawn as a sphere of mean radius`);
        radii = [R, R, R];
      }
      const frame = prepareBody(b.pos, radii, orient, 3 * g.pixelAngle);
      const occluders: [V3, number][] = [];
      if (lit) {
        const cands: { o: V3; r: number; d: number }[] = [];
        for (const o of snap.bodies) {
          if (o === b || !o.radii) continue;
          const rel = sub(o.pos, b.pos);
          const along = dot(rel, sunDir);
          if (along <= 0 || along >= toSunLen) continue;
          const perp = Math.sqrt(Math.max(0, dot(rel, rel) - along * along));
          const reach = meanRadius(o.radii) + Math.max(...b.radii) + (along * sunR) / toSunLen;
          if (perp < reach) cands.push({ o: rel, r: meanRadius(o.radii), d: len(rel) });
        }
        cands.sort((a, b2) => a.d - b2.d);
        for (const k of cands.slice(0, 4)) occluders.push([k.o, k.r]);
      }
      resolved.push({
        body: b, frame, lit,
        K: K.map((v) => v * fRes) as XYZS,
        sunDir, sunDistKm: toSunLen, sunRadiusKm: sunR,
        riccoWeight: ricco, occluders, hatch, tint,
      });
    }
    if (fRes < 1 && c[2] < 0) {
      const ndc = camToNdc(g, c);
      if (E && E[1] > 0) {
        const Ep = E.map((v) => v * (1 - fRes)) as XYZS;
        // Visibility: Crumey threshold at the adaptation state (Blackwell-equivalent units).
        if (blackwellEquivalent(Ep[1], Ep[3], eye.mesopic.m) >= eye.thresholdBwLux) {
          points.push({ ndc, depth: g.near / -c[2], E: Ep });
        }
        if (tint && fRes < 0.5) ringVertices(ndc, 7, 1.5, tint, g, overlay);
      } else if (fRes < 0.5) {
        ringVertices(ndc, 6, 1.5, tint ?? MARKER_COLOR, g, overlay);
      }
    }
  }
  resolved.sort((a, b) => a.frame.D - b.frame.D);
  // A glare source contributes only if it lies within the CIE 146 validity range (≤ 100°) of the
  // fixation direction (the view centre): beyond that it is outside the field of the fixating eye.
  const inField = glare.filter((gs) => (angle(gs.dir, fwd) * 180) / Math.PI <= CIE146.maxDeg);
  // Illuminance E (lux = cd·sr·m⁻²) of a small source equals its ∫L dΩ; convert sr → deg².
  const offFrameFluxDeg2 = inField.reduce((a, gs) => a + (gs.inFrame ? 0 : gs.E[1] * DEG2_PER_SR), 0);
  return { resolved, points, sun, glare: inField, overlay, warnings, adaptedWhite, offFrameFluxDeg2 };
}

function tangent(n: V3): [V3, V3] {
  const h: V3 = Math.abs(n[0]) < 0.6 ? [1, 0, 0] : Math.abs(n[1]) < 0.6 ? [0, 1, 0] : [0, 0, 1];
  const e1 = normalize([n[1] * h[2] - n[2] * h[1], n[2] * h[0] - n[0] * h[2], n[0] * h[1] - n[1] * h[0]]);
  const e2: V3 = [n[1] * e1[2] - n[2] * e1[1], n[2] * e1[0] - n[0] * e1[2], n[0] * e1[1] - n[1] * e1[0]];
  return [e1, e2];
}
