// CPU-side (float64) preparation of one frame: which bodies are resolved disks and which are points,
// their photometry per docs/architecture.md §4.3, eclipse occluders, the Sun, analytic glare sources
// and display-space overlays. No GPU calls here; renderer.ts packs the result into buffers.

import type { SceneBody, SceneSnapshot } from './scene';
import { AU_KM } from './constants';
import { diskIlluminance, evalPhase, extrapolatePhase, lambertPhase, limbDarkenedI0, meanRadius, phaseRangeDeg, type XYZS } from './photometry';
import { LAMBERT_LAW, LAW, lawDiskIntegral, NormalizationCache, photometricFrame, resolveLaw, type ResolvedLaw, type ZonalProfile } from './spatial';
import { planetshineSources, type PlanetshineSource } from './planetshine';
import { prepareRings, type RingPrep } from './rings';
import { LABEL_ORDER, type Label } from '../data/schema';
import { dot, len, normalize, prepareBody, scale, sub, type BodyFrame, type M3, type V3 } from './raycast';
import { camToNdc, PROVENANCE_TINT, PROVENANCE_TINT_ALPHA, ringVertices, toCam, type CameraGeom } from './overlays';
import { blackwellEquivalent } from '../eye/mesopic';
import type { EyeFrame } from '../eye/model';
import { CIE146 } from '../eye/constants';
import { DEG2_PER_SR } from '../eye/pupil';

/** GPU page-table bindings of a body's surface-map layers (renderer supplies them; surface.ts). */
export interface SurfaceBinding {
  albedo?: { base: number; maxLevel: number; zonal: ZonalProfile | null };
  height?: { base: number; maxLevel: number };
}

export interface ResolvedBody {
  body: SceneBody;
  frame: BodyFrame;
  lit: boolean;
  /**
   * Radiance prefactor K (XYZS): L = K·r(μ0, μ, g)·M with r the spatial law's radiance factor and M the
   * surface map, K = albedoXYZS/(π d²)·Φ(α)/I(α) (spatial.ts), multiplied by the resolved fraction.
   */
  K: XYZS;
  /** Spatial photometric law at this phase angle (Lambert when none is measured or it does not apply). */
  law: ResolvedLaw;
  /** Surface-map bindings; null when the body has no maps or its orientation is unknown. */
  surface: SurfaceBinding | null;
  /** Body-fixed → ICRF rotation (row-major) and the radii the ray caster uses. */
  bodyToWorld: M3;
  radiiKm: V3;
  /** Planetshine sources (radiance prefactors already multiplied by the resolved fraction). */
  planetshine: PlanetshineSource[];
  /** Ring system whose shadow may fall on this body or that may lie in front of it: index into rings, and body centre − ring centre (km). */
  ring: { index: number; B: V3 } | null;
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
  /** Ring systems to draw (and to cast shadows / attenuate bodies seen through them). */
  rings: RingPrep[];
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
const normCache = new NormalizationCache();
const zonalIds = new WeakMap<ZonalProfile, number>();
let nextZonalId = 1;
const lawKey = (l: ResolvedLaw) => `${l.kind}:${l.p}:${l.b}:${l.c}:${l.bs0}:${l.hs}:${l.bc0}:${l.hc}:${l.thetaBar}:${l.K}:${l.hFn}`;

/** Disk integral I(α) of a law, optionally weighted by a map's zonal mean (cached; exact for plain Lambert). */
function lawIntegral(law: ResolvedLaw, alpha: number, zonal?: { profile: ZonalProfile; pole: V3 }): XYZS {
  if (law.kind === LAW.lambert && !zonal) {
    const v = (2 / 3) * lambertPhase(alpha);
    return [v, v, v, v];
  }
  let key = `${lawKey(law)}|${alpha.toFixed(5)}`;
  if (zonal) {
    let id = zonalIds.get(zonal.profile);
    if (!id) zonalIds.set(zonal.profile, (id = nextZonalId++));
    key += `|${id}|${zonal.pole.map((v) => v.toFixed(3)).join(',')}`;
  }
  return normCache.get(key, () => lawDiskIntegral(law, alpha, zonal, law.kind === LAW.hapke ? 24 : 32));
}

const worse = (a: Label, b: Label): Label => (LABEL_ORDER.indexOf(a) >= LABEL_ORDER.indexOf(b) ? a : b);

export interface PrepareOptions {
  /** Surface-map bindings per body (renderer.ts); absent → no maps. */
  surfaces?: (b: SceneBody) => SurfaceBinding | null;
}

export function prepareFrame(snap: SceneSnapshot, g: CameraGeom, eye: EyeFrame, pointFootprintSr: number, opts: PrepareOptions = {}): PreparedFrame {
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

  // Ring systems first (bodies need their indices for ring shadows and transmission).
  const irr = snap.sun ? (snap.sun.irradianceXYZS_1AU as XYZS) : null;
  const rings: RingPrep[] = [];
  for (const b of snap.bodies) {
    const rp = prepareRings(b, irr, sunR, g.pixelAngle);
    if (rp) rings.push(rp);
  }
  const ringFor = (b: SceneBody): { index: number; B: V3 } | null => {
    let best: { index: number; B: V3 } | null = null;
    let bestD = Infinity;
    rings.forEach((r, index) => {
      const B = sub(b.pos, r.pos);
      const d = len(B);
      if (d < 10 * r.profile.rMax && d < bestD) { bestD = d; best = { index, B }; }
    });
    return best;
  };

  for (const b of snap.bodies) {
    const D = len(b.pos);
    if (!(D > 0)) continue;
    const c = toCam(g, b.pos);
    if (!b.radii) {
      // Position known, size unknown: no brightness can be computed (R is needed). Nothing is drawn; the
      // shell draws the hollow "position known, brightness not admitted" marker (ui/labels.ts).
      continue;
    }
    const R = meanRadius(b.radii);
    const angR = Math.asin(Math.min(1, R / D));
    const behind = dot(normalize(b.pos), fwd) < -Math.sin(Math.max(angR, Math.asin(Math.min(1, Math.max(...b.radii) / D))));
    // Photometry, or the reason it is unavailable.
    let E: XYZS | null = null;
    let K: XYZS = [0, 0, 0, 0];
    let lit = false;
    let label = b.worstLabel;
    const toSunLen = len(b.toSun);
    const dAU = toSunLen / AU_KM;
    const sunDir = scale(b.toSun, 1 / toSunLen);
    const alpha = angle(b.toSun, scale(b.pos, -1));
    // Spatial law at this phase angle (Lambert when none is measured or its fit does not cover α).
    let law = LAMBERT_LAW;
    const lr = resolveLaw(b.spatialModel, alpha);
    if ('error' in lr) warnings.push(`${b.name}: ${lr.error} → Lambert spatial distribution`);
    else law = lr.law;
    // Surface maps need the body-fixed frame.
    const surface = b.orient && b.surface && opts.surfaces ? opts.surfaces(b) : null;
    if (!b.orient && b.surface && (b.surface.albedo || b.surface.height)) warnings.push(`${b.name}: orientation unknown → surface maps not shown`);
    if (!b.surfaceUnknown && b.albedoXYZS && b.phase) {
      const ph = evalPhase(b.phase, alpha);
      let phi: number | null = ph.ok ? ph.phi : null;
      if (!ph.ok) {
        const range = phaseRangeDeg(b.phase);
        const x = b.allowPhaseExtrapolation
          ? extrapolatePhase(b.phase, alpha, (a) => {
            const la = resolveLaw(b.spatialModel, a);
            return lawIntegral('error' in la ? LAMBERT_LAW : la.law, a)[1];
          })
          : null;
        if (x) {
          phi = x.phi;
          label = worse(label, 'estimated');
          warnings.push(`${b.name}: phase extrapolated beyond measured range (${range?.[0]}–${range?.[1]}°) with the spatial law → estimated`);
        } else {
          warnings.push(`${b.name}: ${ph.reason} → sunlit part drawn as not measured (night side black)`);
        }
      }
      if (phi !== null) {
        E = diskIlluminance(b.albedoXYZS, dAU, R, D, phi);
        // Normalization: the disk integral of law × map (zonal mean, rotation-averaged) equals p·Φ(α).
        let zonal: { profile: ZonalProfile; pole: V3 } | undefined;
        if (surface?.albedo?.zonal && b.orient) {
          const Rm = b.orient;
          const [px, py, pz] = photometricFrame(normalize(scale(b.pos, -1)), sunDir);
          const P: V3 = [Rm[2], Rm[5], Rm[8]];
          zonal = { profile: surface.albedo.zonal, pole: [dot(P, px), dot(P, py), dot(P, pz)] };
        }
        const I = lawIntegral(law, alpha, zonal);
        if (I[1] > 0) {
          K = [0, 1, 2, 3].map((k) => (I[k] > 0 ? (b.albedoXYZS![k] * phi!) / (Math.PI * dAU * dAU * I[k]) : 0)) as XYZS;
          lit = true;
        }
      }
    }
    const tint = tintOn ? ([...PROVENANCE_TINT[label], PROVENANCE_TINT_ALPHA] as [number, number, number, number]) : null;
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
      const planetshine = lit
        ? planetshineSources(b, snap.bodies, irr).map((ps) => ({ ...ps, K: ps.K.map((v) => v * fRes) as XYZS }))
        : [];
      resolved.push({
        body: b, frame, lit,
        K: K.map((v) => v * fRes) as XYZS,
        law, surface: orient ? surface : null,
        bodyToWorld: orient ?? [1, 0, 0, 0, 1, 0, 0, 0, 1], radiiKm: radii,
        planetshine, ring: ringFor(b),
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
      }
      // A sub-pixel body without admitted brightness: nothing is drawn (the shell owns those markers).
    }
  }
  resolved.sort((a, b) => a.frame.D - b.frame.D);
  // A glare source contributes only if it lies within the CIE 146 validity range (≤ 100°) of the
  // fixation direction (the view centre): beyond that it is outside the field of the fixating eye.
  const inField = glare.filter((gs) => (angle(gs.dir, fwd) * 180) / Math.PI <= CIE146.maxDeg);
  // Illuminance E (lux = cd·sr·m⁻²) of a small source equals its ∫L dΩ; convert sr → deg².
  const offFrameFluxDeg2 = inField.reduce((a, gs) => a + (gs.inFrame ? 0 : gs.E[1] * DEG2_PER_SR), 0);
  return { resolved, points, sun, glare: inField, overlay, warnings, adaptedWhite, rings, offFrameFluxDeg2 };
}

function tangent(n: V3): [V3, V3] {
  const h: V3 = Math.abs(n[0]) < 0.6 ? [1, 0, 0] : Math.abs(n[1]) < 0.6 ? [0, 1, 0] : [0, 0, 1];
  const e1 = normalize([n[1] * h[2] - n[2] * h[1], n[2] * h[0] - n[0] * h[2], n[0] * h[1] - n[1] * h[0]]);
  const e2: V3 = [n[1] * e1[2] - n[2] * e1[1], n[2] * e1[0] - n[0] * e1[2], n[0] * e1[1] - n[1] * e1[0]];
  return [e1, e2];
}
