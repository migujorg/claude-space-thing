// CPU-side (float64) preparation of one frame: which bodies are resolved disks and which are points,
// their photometry per docs/architecture.md §4.3, eclipse occluders, the Sun, analytic glare sources
// and display-space overlays. No GPU calls here; renderer.ts packs the result into buffers.

import type { SceneAtmosphere, SceneBody, SceneSnapshot } from './scene';
import { AU_KM } from './constants';
import { diskIlluminance, diskModelPPhi, evalPhase, extrapolatePhase, LAMBERT_ALBEDO_PER_GEOMETRIC_ALBEDO, limbDarkenedI0, meanRadius, phaseRangeDeg, type XYZS } from './photometry';
import { LAMBERT_LAW, lawRadf, MotionNormalization, mapDiskIntegral, NormalizationCache, photometricFrame, resolveLaw, TEXEL_LAW, type ResolvedLaw, type ZonalProfile } from './spatial';
import { sampleLevel0, type Level0Map } from './surface';
import { MAX_POPULATION_NODES, NIGHT_LAMP, type CloudPopulation } from './earth';
import { ATM_DISK_NODES, atmosphereDiskFactors, marsDustScale, modelDiskXYZS } from './atmosphere';
import type { AtmosphereBinding } from './atmosphereGpu';
import { texelRadf, type TexelHapke } from './texelLaw';
import { planetshineSources, type PlanetshineSource } from './planetshine';
import { prepareRings, type RingPrep } from './rings';
import { LABEL_ORDER, type Label } from '../data/schema';
import { dot, len, normalize, prepareBody, scale, sub, type BodyFrame, type M3, type V3 } from './raycast';
import { camToNdc, PROVENANCE_TINT, PROVENANCE_TINT_ALPHA, ringVertices, toCam, type CameraGeom } from './overlays';
import { blackwellEquivalent } from '../eye/mesopic';
import type { EyeFrame } from '../eye/model';
import { pointObserver } from '../eye/points';
import { CIE146 } from '../eye/constants';
import { cie146 } from '../eye/glare';
import { DARK_LIGHT_CONE } from '../eye/tonemap';
import { DEG2_PER_SR } from '../eye/pupil';

/** GPU page-table bindings of a body's surface-map layers (renderer supplies them; surface.ts). */
export interface SurfaceBinding {
  albedo?: { base: number; maxLevel: number; zonal: ZonalProfile | null; map0?: Level0Map | null };
  /** Per-texel photometric model (texelLaw.ts) and its GPU texture, once loaded. */
  photometry?: { texel: TexelHapke; view: GPUTextureView };
  height?: { base: number; maxLevel: number };
  /** Earth's cloud-properties, surface-water and emitted-radiance layers (earth.ts). */
  clouds?: { base: number; maxLevel: number };
  /** Earth's cloud optical-thickness moments (earth.ts cloudLogNormal), in the clouds atlas. */
  cloudTau?: { base: number; maxLevel: number };
  water?: { base: number; maxLevel: number };
  night?: { base: number; maxLevel: number };
  /** Earth's wind layer, one whole level in its own texture (rgba16float: ascending, daily mean, passes). */
  wind?: { view: GPUTextureView };
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
  /**
   * Always 1. Written to the W target, which nothing reads: a resolved body carries no Ricco weight
   * (docs/eye-model.md §6.3). The field, the target and their plumbing are to be removed together.
   */
  riccoWeight: number;
  occluders: [V3, number][];
  hatch: boolean;
  tint: [number, number, number, number] | null;
  /** Earth's layers (earth.ts): the albedo map's absoluteDiskMean and the night lights' luminance factors. */
  earth: EarthBinding | null;
  /**
   * The body's atmosphere (docs/rendering-earth.md §4, §8): the data, the Lambert-equivalent reflectance
   * below it per channel for the multiple-scattering table (1.5·p from the disk photometry, as
   * planetshine.ts), the shell quad's half-extent (tan units) and the Sun's angular radius at the body.
   * onDisk: drawn over the disk too (else beyond the disk only: an atmosphere whose lower boundary is hidden
   * (Venus), or one whose scattering is not measured (Titan: binding.unmeasured, hatched)).
   */
  atmosphere: {
    data: SceneAtmosphere; groundAlbedo: number[]; shellBeta: number; sunAngularRadius: number; onDisk: boolean;
    /** Solar illuminance at the body over π (cd/m² per unit radiance factor), times the resolved fraction. */
    sunE: XYZS;
    binding: AtmosphereBinding;
  } | null;
}

export interface EarthBinding {
  absR: XYZS;
  /** cd/m² (XYZS) per unit of the night layer's radiance; zeros when there is no night layer. */
  nightK: XYZS;
  /** The population for the cloud without a retrieval (with the cloudTau layer bound and admitted), else null. */
  unmeasuredTau: CloudPopulation | null;
}

/**
 * Earth mode (earth.ts): the albedo layer is surface-only absolute reflectance (its header has
 * `normalization.absoluteDiskMean`) and the cloud layer is bound. Null otherwise; a surface-only map
 * without clouds gets a warning (the caller then drops the map).
 */
export function earthMode(b: SceneBody, surface: SurfaceBinding | null, irr: XYZS | null, warnings: string[]): EarthBinding | null {
  const abs = b.surface?.albedo?.header.normalization?.absoluteDiskMean;
  if (!abs || !surface?.albedo || !irr) return null;
  if (!surface.clouds) {
    warnings.push(`${b.name}: surface-only reflectance map needs its cloud layer → disk photometry drawn instead`);
    return null;
  }
  let nightK: XYZS = [0, 0, 0, 0];
  if (surface.night) {
    const k = (b.surface?.night?.header.constants?.toXYZS as Record<string, unknown> | undefined)?.[NIGHT_LAMP];
    if (Array.isArray(k) && k.length === 4 && k.every((v) => typeof v === 'number' && v >= 0)) nightK = k as XYZS;
    else warnings.push(`${b.name}: night-light layer has no ${NIGHT_LAMP} luminance factors → night lights not drawn`);
  }
  const un = surface.cloudTau ? b.surface?.cloudTauUnmeasured ?? null : null;
  return { absR: [abs.X, abs.Y, abs.Z, abs.S], nightK, unmeasuredTau: un && un.taus.length <= MAX_POPULATION_NODES ? un : null };
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
  /** Sun shield (viewing aid) on: the occulting disc's direction and cos(angular radius); null when off. */
  sunShield: { dir: V3; cosRadius: number; radius: number } | null;
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
 * Smallest σ (pixels) of a point-source splat. A reconstruction-filter choice, not an eye constant:
 * at σ ≥ 0.6 px the discrete sum of the Gaussian over the pixel grid equals its integral to 2·10⁻³
 * for every sub-pixel position (Poisson summation: 2·exp(−2π²σ²)), so splats conserve energy.
 */
export const SIGMA_MIN_PX = 0.6;
/**
 * σ of a point splat in pixels: the observer's optical point spread, never narrower than SIGMA_MIN_PX.
 * @param coreSigmaDeg equivalent σ of the eye's optical core (EyeFrame.coreSigmaDeg)
 * @param pixelAngle angle of a pixel at the view centre, rad
 * @param opticalCore EyeSettings.opticalCore: false for an imager at the frame's own sampling, whose point spread
 *   is the reconstruction minimum at every field
 */
export function splatSigmaPx(coreSigmaDeg: number, pixelAngle: number, opticalCore: boolean): number {
  return Math.max(opticalCore ? ((coreSigmaDeg * Math.PI) / 180) / pixelAngle : 0, SIGMA_MIN_PX);
}
/**
 * Relative margin by which a body's own point is drawn nearer than the nearest point of its disk. A numerical
 * tolerance, not a property of anything: the disk's depth is computed per fragment in float32 (2⁻²⁴ ≈ 6·10⁻⁸
 * relative), the point's here in float64.
 */
const OWN_POINT_DEPTH_MARGIN = 1e-6;

const normCache = new NormalizationCache();
/** Disk renormalization factors under an atmosphere (I0, Iatm, Apath, Ashell per channel), by phase bin. */
const ATM_FACTOR_BIN_DEG = 1;
const atmCache = new Map<string, number[]>();
const motionNormalization = new MotionNormalization();
const lawKey = (l: ResolvedLaw) => `${l.kind}:${l.p}:${l.b}:${l.c}:${l.bs0}:${l.hs}:${l.bc0}:${l.hc}:${l.thetaBar}:${l.K}:${l.hFn}`;

/**
 * Bond albedo per unit scale of a law: q·I(0) = 2∫₀^π I(α) sin α dα (1 for Lambert). With the surface scale
 * p·Φ(α)/I(α) it is the surface's Bond albedo, which energy conservation keeps ≤ 1.
 */
function lawBond(law: ResolvedLaw): XYZS {
  return normCache.get(`bond|${lawKey(law)}`, () => {
    const n = 64;
    const out: XYZS = [0, 0, 0, 0];
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * (i + 0.5)) / n;
      const I = lawIntegral(law, a);
      for (let c = 0; c < 4; c++) out[c] += (2 * I[c] * Math.sin(a) * Math.PI) / n;
    }
    return out;
  });
}

/** The same motion-normalization entry point used by prepareFrame and the opt-in benchmark. */
export function lawIntegral(law: ResolvedLaw, alpha: number, zonal?: { profile: ZonalProfile; pole: V3 }): XYZS {
  return motionNormalization.get(law, alpha, zonal);
}

const worse = (a: Label, b: Label): Label => (LABEL_ORDER.indexOf(a) >= LABEL_ORDER.indexOf(b) ? a : b);

export interface PrepareOptions {
  /** Surface-map bindings per body (renderer.ts); absent → no maps. */
  surfaces?: (b: SceneBody) => SurfaceBinding | null;
  /**
   * A body's atmosphere once its tables are ready (atmosphereGpu.ts), else null: groundAlbedo for the
   * multiple-scattering table, dust the Mars season scaling.
   */
  atmospheres?: (b: SceneBody, groundAlbedo: number[], dust: { scale: number; bin: number } | null) => AtmosphereBinding | { error: string; unmeasured?: AtmosphereBinding } | null;
}

/**
 * @param pointFootprintSr equivalent solid angle 2πσ² of a point splat as the renderer draws it: the eye's optical
 *   core (Watson 2013), never narrower than SIGMA_MIN_PX. It decides which bodies are points (below).
 */
export function prepareFrame(snap: SceneSnapshot, g: CameraGeom, eye: EyeFrame, pointFootprintSr: number, opts: PrepareOptions = {}): PreparedFrame {
  const warnings: string[] = [];
  const resolved: ResolvedBody[] = [];
  const points: PointSource[] = [];
  const glare: GlareSource[] = [];
  const overlay: number[] = [];
  const tintOn = snap.view.overlays.provenanceTint;
  const fwd: V3 = [-g.back[0], -g.back[1], -g.back[2]];
  const zeroBg = pointObserver(eye, { Y: 0, S: 0 });
  // Point or disk (docs/eye-model.md §6.3). A body is a point to the eye while its disk is smaller than the eye's
  // point spread, and the splat is that point spread as drawn. So the switch is made on the disk's diameter in
  // units of the splat: 1 to 2 px for the reconstruction-minimum splat (σ = SIGMA_MIN_PX), and the same multiple of
  // σ (1.67 to 3.33) when the screen resolves the eye's optical core. `splatScale` is the splat's σ over the minimum.
  const splatScale = Math.max(1, Math.sqrt(pointFootprintSr / (2 * Math.PI)) / g.pixelAngle / SIGMA_MIN_PX);
  const resolvedShare = (diamPx: number) => smooth(1, 2, diamPx / splatScale);

  const inFrame = (c: V3) => {
    if (c[2] >= 0) return false;
    const p = camToNdc(g, c);
    return Math.abs(p[0]) <= 1 && Math.abs(p[1]) <= 1;
  };
  /** Whether a sphere of radius r (km) at camera-relative pos overlaps the frame (for per-body warnings). */
  const inView = (pos: V3, r: number) => {
    const D = len(pos);
    if (!(D > 0)) return false;
    if (r >= D) return true;
    const ang = Math.asin(r / D);
    const c = toCam(g, pos);
    const cosOff = -c[2] / D;
    if (cosOff < Math.cos(Math.min(Math.PI, Math.PI / 2 + ang))) return false;
    if (c[2] >= 0) return ang > Math.acos(Math.min(1, Math.max(-1, cosOff))) - Math.PI / 2;
    const p = camToNdc(g, c);
    const t = Math.tan(Math.min(ang, 1.5)) / -c[2] * D;
    return Math.abs(p[0]) <= 1 + t / g.tanX && Math.abs(p[1]) <= 1 + t / g.tanY;
  };

  // Sun first (its radius is needed for eclipse shadows).
  const sunR = snap.sun?.radius ?? 0;
  let sun: SunPrep | null = null;
  let adaptedWhite: V3 | null = null;
  let sunShield: { dir: V3; cosRadius: number; radius: number } | null = null;
  if (snap.sun) {
    const s = snap.sun;
    const dist = len(s.pos);
    const dAU = dist / AU_KM;
    const E: XYZS = [0, 1, 2, 3].map((k) => s.irradianceXYZS_1AU[k] / (dAU * dAU)) as XYZS;
    adaptedWhite = [s.irradianceXYZS_1AU[0], s.irradianceXYZS_1AU[1], s.irradianceXYZS_1AU[2]];
    const n = scale(s.pos, 1 / dist);
    const rho = Math.asin(Math.min(1, s.radius / dist));
    const diamPx = (2 * rho) / g.pixelAngle;
    let fRes = s.limbDarkening ? resolvedShare(diamPx) : 0;
    // Sun shield (viewing aid, ViewSettings.sunShield): an occulting disc covers the solar disk (its
    // angular radius plus one pixel). The Sun's light never reaches the eye: no disk, no point, no veil.
    const shielded = snap.view.sunShield === true;
    if (shielded) {
      const radius = Math.min(rho + g.pixelAngle, Math.PI);
      sunShield = { dir: n, cosRadius: Math.cos(radius), radius };
    }
    if (!s.limbDarkening && diamPx / splatScale > 1 && !shielded) warnings.push('Sun: limb darkening unknown → drawn as an unresolved point of the correct illuminance (no uniform disk assumed)');
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
    if (!shielded) glare.push({ dir: n, minDeg: (rho * 180) / Math.PI, E: E.map((v) => v * vis) as XYZS, inFrame: sunInFrame });
    // The outline marks the disc; drawn with a radius of at least OCCULTER_OUTLINE_MIN_PX so a tiny disc stays findable.
    else if (c[2] < 0) occulterOutline(g, n, Math.max(rho + g.pixelAngle, OCCULTER_OUTLINE_MIN_PX * g.pixelAngle), overlay);
    const coeffs: number[][] = [0, 1, 2, 3].map((k) => {
      const src = s.limbDarkening?.[k] ?? [1];
      if (src.length > 6) warnings.push('Sun: limb-darkening polynomial truncated to degree 5');
      return [0, 1, 2, 3, 4, 5].map((i) => src[i] ?? 0);
    });
    const I0 = [0, 1, 2, 3].map((k) => (fRes > 0 ? limbDarkenedI0(E[k], coeffs[k], s.radius, dist) : 0)) as XYZS;
    let point: PointSource | null = null;
    if (fRes < 1 && c[2] < 0 && !shielded) {
      point = { ndc: camToNdc(g, c), depth: g.near / -c[2], E: E.map((v) => v * (1 - fRes)) as XYZS };
    }
    if (c[2] >= 0 || shielded) fRes = 0;
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
  // Reflected light of rings too small to resolve: it joins the planet's point source.
  const ringPoint = new Map<SceneBody, XYZS>();
  for (const b of snap.bodies) {
    if (!b.rings) continue;
    const rf = prepareRings(b, irr, sunR, g.pixelAngle);
    if (rf.draw) rings.push(rf.draw);
    if (rf.pointE) ringPoint.set(b, rf.pointE);
    if (inView(b.pos, b.rings ? Math.max(...(b.rings.opticalDepth.flatMap((p) => p.radiusKm)), 0) : 0)) warnings.push(...rf.warnings);
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
    // This body's warnings are kept only if it is in view (drawn in the frame).
    const w0 = warnings.length;
    try {
      prepareOneBody(b);
    } finally {
      if (!inView(b.pos, b.radii ? extentOf(b, b.radii) : 0)) warnings.length = w0;
    }
  }
  function prepareOneBody(b: SceneBody): void {
    const D = len(b.pos);
    if (!(D > 0)) return;
    const c = toCam(g, b.pos);
    if (!b.radii) {
      // Position known, size unknown: no brightness can be computed (R is needed). Nothing is drawn; the
      // shell draws the hollow "position known, brightness not admitted" marker (ui/labels.ts).
      return;
    }
    const R = meanRadius(b.radii);
    const angR = Math.asin(Math.min(1, R / D));
    const behind = dot(normalize(b.pos), fwd) < -Math.sin(Math.max(angR, Math.asin(Math.min(1, extentOf(b, b.radii) / D))));
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
    let surface = b.orient && b.surface && opts.surfaces ? opts.surfaces(b) : null;
    if (!b.orient && b.surface && (b.surface.albedo || b.surface.height)) warnings.push(`${b.name}: orientation unknown → surface maps not shown`);
    // Earth (earth.ts): a map of surface-only absolute reflectance is drawn with its clouds, never scaled
    // by the disk photometry (which includes clouds and air). Without the cloud layer it is not used.
    const earth = earthMode(b, surface, irr, warnings);
    if (!earth && surface?.albedo && b.surface?.albedo?.header.normalization?.absoluteDiskMean) surface = { ...surface, albedo: undefined };
    if (!earth && surface && (surface.clouds || surface.cloudTau || surface.water || surface.night || surface.wind)) surface = { ...surface, clouds: undefined, cloudTau: undefined, water: undefined, night: undefined, wind: undefined };
    // A body drawn from its atmosphere model (SceneAtmosphere.surface: Titan; docs/rendering-earth.md §8 "Titan").
    // The rule (architecture §4.3, §4.4): the model gives the spatial pattern of its resolved disk, and the disk
    // photometry its absolute brightness and colour. Wherever that photometry is admitted and covers the phase
    // angle, the whole model radiance is scaled per channel by measured p·Φ(α) over the model's own disk integral,
    // so the drawn disk's integral is the measurement; beyond the measured range the scale of the range's edge is
    // held where a continuation is allowed (Best, Complete: estimated), and the body is not measured where it is
    // not (Strict). Nothing of the model is adjusted or stored: the factors are computed here and said in a warning.
    // The exception is the Earth drawn with its layers (earthMode), which is never scaled to its disk photometry:
    // its layers carry their own absolute calibration (surface reflectance, cloud optical thickness and air, each
    // in absolute units), and its disk albedo is the weather of one day, which a single disk value cannot fix.
    const physical = !earth && b.atmosphere?.surface && b.orient && irr && opts.atmospheres ? b.atmosphere.surface : null;
    // An in-range point is the disk photometry directly: it needs neither the model tables nor an integral.
    // A disk needs the model's spatial pattern; beyond the range, a point also needs its phase dependence.
    const resolvedDisk = (2 * angR) / g.pixelAngle > 1;
    /** The scale of the model to the disk photometry, per channel, once it is drawn. */
    let modelScale: XYZS | null = null;
    // Disk-integrated p·Φ per channel: from the body's disk reflectance model (the Moon: ROLO) inside its
    // domain, else albedoXYZS·Φ(α) (architecture §4.3).
    // The measured phase range's edge when α lies beyond it (the photometry is then the law's extrapolation).
    let phaseEdge: number | null = null;
    let pPhi: XYZS | null = b.surfaceUnknown ? null
      : diskModelPPhi(b.diskReflectanceModel, b.orient, R, b.toSun, scale(b.pos, -1), irr);
    // Photometry measured at this very geometry (ROLO): normalize the maps at this geometry, not on a
    // rotational average, or the model's libration and waxing/waning terms would be counted twice.
    const atThisGeometry = pPhi !== null;
    // Outside a rolo-v1 model's domain (the far side, α beyond 1.55–97°), albedoXYZS·Φ(α) is still the
    // model's reference view: zero libration, geometric mean of the waxing and waning Moon (photometry.json
    // 301 geometricAlbedoXYZS and phaseFunction methods: "describes the near side as seen from Earth"). The
    // maps are normalized there, so the view actually drawn differs from it by what the maps say.
    const atReferenceView = !atThisGeometry && b.diskReflectanceModel?.kind === 'rolo-v1';
    const texel = surface?.photometry?.texel ?? null;
    if (texel) law = TEXEL_LAW;
    if (!pPhi && !b.surfaceUnknown && b.albedoXYZS && b.phase) {
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
          if (range) phaseEdge = ((alpha * 180) / Math.PI > range[1] ? range[1] : range[0]) * (Math.PI / 180);
          label = worse(label, 'estimated');
        } else {
          warnings.push(`${b.name}: ${ph.reason} → sunlit part drawn as not measured (night side black)`);
        }
      }
      if (phi !== null) pPhi = b.albedoXYZS.map((a) => a * phi!) as XYZS;
    }
    let physB: AtmosphereBinding | null = null;
    if (physical && pPhi && (resolvedDisk || phaseEdge !== null)) {
      const got = opts.atmospheres!(b, [0, 0, 0, 0], null);
      if (got && 'error' in got) warnings.push(got.error);
      else if (got?.tables && got.grid) physB = got;
    }
    // With ready tables, the model supplies the continuation for both representations (said below).
    if (phaseEdge !== null && !physB) {
      const range = phaseRangeDeg(b.phase!);
      warnings.push(`${b.name}: phase extrapolated beyond measured range (${range?.[0]}–${range?.[1]}°) with the spatial law → estimated`);
    }
    let Idisk: XYZS | null = null;
    if (pPhi) {
      E = diskIlluminance(pPhi, dAU, R, D, 1);
      // Normalization: the disk integral of law × map equals p·Φ(α). A zonal map with a constant law:
      // rotation-averaged zonal mean (exact for any rotation phase). A per-texel law, or photometry measured
      // at this geometry: the map (level 0) and law over the actual disk, at this geometry or averaged over
      // rotations (mapDiskIntegral).
      let zonal: { profile: ZonalProfile; pole: V3 } | undefined;
      let I: XYZS;
      const map0 = surface?.albedo?.map0 ?? null;
      if (b.orient && (texel || ((atThisGeometry || atReferenceView) && map0))) {
        const Rm = b.orient;
        const [px, py, pz] = photometricFrame(normalize(scale(b.pos, -1)), sunDir);
        const toBf = (v: V3): V3 => [Rm[0] * v[0] + Rm[3] * v[1] + Rm[6] * v[2], Rm[1] * v[0] + Rm[4] * v[1] + Rm[7] * v[2], Rm[2] * v[0] + Rm[5] * v[1] + Rm[8] * v[2]];
        const axes: [V3, V3, V3] = [toBf(px), toBf(py), toBf(pz)];
        const rotations = atThisGeometry ? 1 : 8;
        const q = (v: V3) => v.map((x) => x.toFixed(3)).join(',');
        const fMap = (lat: number, lon: number, mu0: number, mu: number, gph: number): XYZS => {
          const m = map0 ? sampleLevel0(map0, lat, lon) : [1, 1, 1, 1];
          if (texel) {
            const r = texelRadf(texel, lat, lon, mu0, mu, gph);
            return [m[0] * r[0], m[1] * r[1], m[2] * r[2], m[3] * r[3]];
          }
          const r = lawRadf(law, mu0, mu, gph);
          return [m[0] * r, m[1] * r, m[2] * r, m[3] * r];
        };
        const n = texel ? 24 : 32;
        if (atReferenceView) {
          // Body-fixed: observer over (0°, 0°), the Sun on the equator at east longitude ±α.
          const key = `map|${b.id}|${texel ? 't' : ''}${map0 ? 'm' : ''}|${alpha.toFixed(3)}|reference`;
          I = normCache.get(key, () => {
            const ref = (sgn: number) => mapDiskIntegral(alpha, photometricFrame([1, 0, 0], [Math.cos(alpha), sgn * Math.sin(alpha), 0]), fMap, n, 1);
            const a = ref(1), c = ref(-1);
            return [0, 1, 2, 3].map((k) => Math.sqrt(a[k] * c[k])) as XYZS;
          });
        } else {
          const key = `map|${b.id}|${texel ? 't' : ''}${map0 ? 'm' : ''}|${alpha.toFixed(3)}|` + (atThisGeometry ? `${q(axes[0])}|${q(axes[2])}` : q([axes[0][2], axes[1][2], axes[2][2]]));
          I = normCache.get(key, () => mapDiskIntegral(alpha, axes, fMap, n, rotations));
        }
      } else {
        if (surface?.albedo?.zonal && b.orient) {
          const Rm = b.orient;
          const [px, py, pz] = photometricFrame(normalize(scale(b.pos, -1)), sunDir);
          const P: V3 = [Rm[2], Rm[5], Rm[8]];
          zonal = { profile: surface.albedo.zonal, pole: [dot(P, px), dot(P, py), dot(P, pz)] };
        }
        I = lawIntegral(law, alpha, zonal);
      }
      if (I[1] > 0) {
        K = [0, 1, 2, 3].map((k) => (I[k] > 0 ? pPhi![k] / (Math.PI * dAU * dAU * I[k]) : 0)) as XYZS;
        lit = true;
        Idisk = I;
      }
    }
    if (earth && irr) {
      // Absolute reflectance: L = (E_sun/π)·ρ (earth.ts); the disk photometry (E) still gives the point.
      K = irr.map((v) => v / (Math.PI * dAU * dAU)) as XYZS;
      law = LAMBERT_LAW;
      lit = true;
    }
    // The atmosphere (docs/rendering-earth.md §4, §8): Earth with its layers; other bodies from their disk
    // photometry, with the surface scale renormalized so that the body (surface under the air, the air over
    // the disk and beyond its edge) still reflects the measured p·Φ.
    let atmB: AtmosphereBinding | null = null;
    let onDisk = false;
    const groundAlbedo = b.albedoXYZS && irr ? [0, 1, 2, 3].map((c) => LAMBERT_ALBEDO_PER_GEOMETRIC_ALBEDO * (b.albedoXYZS![c] / irr[c])) : [0, 0, 0, 0];
    // The same calibration and integrated light for a model-drawn body at every angular size.
    if (physical && physB && pPhi && irr) {
      // The model's radiance, L = (E_sun/π)·ρ_surface·μ0 under the air plus the air's own light (the shader's
      // ATM_OVER_PHOTOMETRY with the surface scale b.rad = E_sun/π·ρ, and the shell), times the factor of the rule
      // above in each channel: the measured p·Φ over the model's disk integral, both at α, or at the edge of the
      // measured range when α lies beyond it. Until the tables are ready, or when the atmosphere cannot be drawn
      // (warned above), the disk photometry stands in, without the air. With no admitted photometry at this phase
      // (pPhi null, warned above) there is nothing to scale the model to: the body stays not measured.
      const edge = phaseEdge !== null && b.phase && b.albedoXYZS ? evalPhase(b.phase, phaseEdge) : null;
      const aRef = edge?.ok ? phaseEdge! : alpha;
      const pRef = edge?.ok ? b.albedoXYZS!.map((v, c) => (v * edge.phi) / irr[c]) : pPhi.map((v, c) => v / irr[c]);
      const d = modelDisk(physB, aRef);
      const own = [0, 1, 2, 3].map((c) => d[c] + physical.xyzs[c] * d[4 + c]);
      const scaleC = pRef.map((v, c) => (own[c] > 0 ? v / own[c] : 0)) as XYZS;
      modelScale = scaleC;
      // ∫L dΩ = E☉(1 AU)·A_model(α)·scale·(R/Δ)²/d², including the shell beyond the surface limb.
      // In range E already is p·Φ exactly; beyond it the model, with the edge's held factors,
      // supplies the phase dependence for the point and off-frame glare as it does for the resolved disk.
      // Reuse the 1° cache: slowly changing phases need no new integral until they enter another bin.
      if (edge?.ok) {
        const current = aRef === alpha ? d : modelDisk(physB, alpha);
        const modelPPhi = irr.map((v, c) => v * scaleC[c] * (current[c] + physical.xyzs[c] * current[4 + c])) as XYZS;
        E = diskIlluminance(modelPPhi, dAU, R, D, 1);
      }
      atmB = physB;
      K = irr.map((v, c) => (v * physical.xyzs[c] * scaleC[c]) / (Math.PI * dAU * dAU)) as XYZS;
      law = LAMBERT_LAW;
      lit = true;
      onDisk = true;
      // Two decimals: the photometry behind the factors is good to a few percent (the exact values are in the tests).
      const by = `×${scaleC[0].toFixed(2)} X, ${scaleC[1].toFixed(2)} Y, ${scaleC[2].toFixed(2)} Z, ${scaleC[3].toFixed(2)} S`;
      const deg = (a: number) => Number(((a * 180) / Math.PI).toFixed(1));
      const range = b.phase ? phaseRangeDeg(b.phase) : null;
      warnings.push(edge?.ok
        ? `${b.name}: atmosphere model scaled to the disk photometry as at ${deg(aRef)}°, ${by}: phase ${deg(alpha)}° is beyond the measured range (${range?.[0]}–${range?.[1]}°) and the factors of its edge are held → estimated`
        : `${b.name}: atmosphere model scaled to the disk photometry at ${deg(alpha)}°, ${by} (measured p·Φ over the model's disk integral)`);
    } else if (!physical && b.atmosphere && b.orient && irr && lit && opts.atmospheres && (earth || pPhi) && resolvedDisk) {
      const dust = b.atmosphere.body.dustColumn ? marsDustScale(b.atmosphere.body, snap.et) : null;
      const got = opts.atmospheres(b, groundAlbedo, dust ? { scale: dust.scale, bin: dust.bin } : null);
      if (got && 'error' in got) {
        warnings.push(got.error);
        atmB = got.unmeasured ?? null;
      } else atmB = got;
      if (atmB && earth) onDisk = !atmB.unmeasured;
      if (atmB && !earth && pPhi && Idisk && !atmB.unmeasured && atmB.tables && atmB.grid) {
        // Beyond the measured phase range the photometry is the spatial law's extrapolation: a surface model
        // that knows nothing of the air (e.g. Pluto's haze at high phase). The surface scale is then found at
        // the range's edge, with the measured p·Φ there, and the air's light at α is added on top.
        let aRef = alpha;
        let pRef = pPhi.map((v, k) => v / irr[k]);
        let lawRef = law;
        if (phaseEdge !== null && b.phase && b.albedoXYZS) {
          const pe = evalPhase(b.phase, phaseEdge);
          if (pe.ok) {
            aRef = phaseEdge;
            pRef = b.albedoXYZS.map((v, k) => (v * pe.phi) / irr[k]);
            const lr2 = resolveLaw(b.spatialModel, phaseEdge);
            lawRef = 'error' in lr2 ? LAMBERT_LAW : lr2.law;
          }
        }
        // Factors by phase angle only (a uniform surface: the map's share in the ratio I0/Iatm is second order),
        // in 1° bins, linear between bins: a new bin costs one integral (about 10 ms), whatever the rotation.
        const binning = (Math.PI / 180) * ATM_FACTOR_BIN_DEG;
        const i0 = Math.min(Math.floor(aRef / binning), Math.round(Math.PI / binning) - 1);
        const at = (i: number): number[] => {
          const a = i * binning;
          const lr3 = resolveLaw(b.spatialModel, a);
          const lawA = 'error' in lr3 ? LAMBERT_LAW : lr3.law;
          const key = `atm|${atmB!.key}|${lawKey(lawA)}|${i}`;
          let f = atmCache.get(key);
          if (!f) {
            const r = atmosphereDiskFactors(atmB!.model, atmB!.tables!, atmB!.grid!, [Math.sin(a), 0, Math.cos(a)], [0, 0, 1], (_nv, mu0, mu) => {
              const rr = mu0 > 0 ? lawRadf(lawA, mu0, mu, a) : 0;
              return { rho: [rr, rr, rr, rr], albedo: [1, 1, 1, 1] };
            }, ATM_DISK_NODES);
            f = [...r.I0, ...r.Iatm, ...r.Apath, ...r.Ashell];
            if (atmCache.size > 4096) atmCache.clear();
            atmCache.set(key, f);
          }
          return f;
        };
        const f0 = at(i0), f1 = at(i0 + 1);
        const tt = Math.min(Math.max(aRef / binning - i0, 0), 1);
        const fct = f0.map((v, k) => v + (f1[k] - v) * tt);
        const air = [0, 1, 2, 3].map((c) => fct[8 + c] + fct[12 + c]);
        const scaleK = [0, 1, 2, 3].map((c) => ((1 - air[c] / pRef[c]) * fct[c]) / fct[4 + c]);
        // The surface's Bond albedo once renormalized (lawBond): > 1 means the surface under the air cannot
        // be seen (Venus: the profile starts inside the cloud deck), so the disk stays the measured one.
        const bond = lawBond(lawRef);
        const surfaceBond = [0, 1, 2, 3].map((c) => (pRef[c] / fct[c]) * bond[c] * scaleK[c]);
        // Against a phase curve that is a model (an estimate: the Earth's radiative-transfer fit, Mars beyond the
        // phases seen from Earth), air brighter than the curve says the curve does not hold there, not that the
        // measured atmosphere is wrong. The surface scale then comes from the nearest lower phase where the curve
        // still exceeds the air, and the air at α is drawn on top (as beyond the measured range).
        let fallback: { deg: number; scale: number[] } | null = null;
        if (air.some((a, c) => !(a < pRef[c])) && b.phaseEstimated && b.albedoXYZS && b.phase) {
          for (let i = Math.min(i0, Math.round(Math.PI / binning) - 1); i >= 0 && !fallback; i--) {
            const a = i * binning;
            const ph = evalPhase(b.phase, a);
            if (!ph.ok) continue;
            const pA = b.albedoXYZS.map((v, k) => (v * ph.phi) / irr[k]);
            const fa = at(i);
            const airA = [0, 1, 2, 3].map((c) => fa[8 + c] + fa[12 + c]);
            if (airA.some((x, c) => !(x < pA[c]))) continue;
            const sc = [0, 1, 2, 3].map((c) => ((1 - airA[c] / pA[c]) * fa[c]) / fa[4 + c]);
            const lrA = resolveLaw(b.spatialModel, a);
            const bondA = lawBond('error' in lrA ? LAMBERT_LAW : lrA.law);
            if ([0, 1, 2, 3].some((c) => !((pA[c] / fa[c]) * bondA[c] * sc[c] <= 1))) continue;
            fallback = { deg: (a * 180) / Math.PI, scale: sc };
          }
        }
        if (fallback) {
          K = K.map((v, c) => v * fallback!.scale[c]) as XYZS;
          onDisk = true;
          warnings.push(`${b.name}: the atmosphere alone is brighter than the disk photometry, a model at this phase → the surface scale is taken at ${fallback.deg.toFixed(0)}°, the air drawn on top`);
        } else if (air.some((a, c) => !(a < pRef[c]))) {
          warnings.push(`${b.name}: the atmosphere alone is brighter than the measured disk → atmosphere not drawn`);
          atmB = null;
        } else if (surfaceBond.some((x) => !(x <= 1))) {
          const shell = [0, 1, 2, 3].map((c) => 1 - fct[12 + c] / pRef[c]);
          K = K.map((v, c) => v * shell[c]) as XYZS;
          warnings.push(`${b.name}: the surface under the atmosphere is not visible in its model → the atmosphere is drawn beyond the disk only (the disk is the measured photometry)`);
        } else {
          K = K.map((v, c) => v * scaleK[c]) as XYZS;
          onDisk = true;
        }
      }
    }
    const tint = tintOn ? ([...PROVENANCE_TINT[label], PROVENANCE_TINT_ALPHA] as [number, number, number, number]) : null;
    const hatch = !lit && !(E && E[1] > 0);
    const diamPx = (2 * angR) / g.pixelAngle;
    const fRes = resolvedShare(diamPx);

    // Behind the Sun shield's occulting disc: hidden (its resolved part is cut out on the GPU).
    const behindShield = sunShield !== null && dot(normalize(b.pos), sunShield.dir) >= sunShield.cosRadius;
    // Off-frame bright bodies still veil the view (analytic glare).
    if (E && !inFrame(c) && !behindShield) glare.push({ dir: normalize(b.pos), minDeg: (angR * 180) / Math.PI, E, inFrame: false });

    if (behind) return;
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
      // Earth: the source's illuminance over π, shaded by the Earth model like sunlight (earth.ts). A body drawn
      // from its atmosphere model: on its surface's reflectance, with the model's scale (the air itself is not lit
      // by planetshine).
      const physK = physical && modelScale ? physical.xyzs.map((v, c) => v * modelScale![c]) : null;
      const planetshine = lit
        ? planetshineSources(b, snap.bodies, irr).map((ps) => ({ ...ps, K: (earth ? ps.E.map((e) => e / Math.PI) : physK ? ps.E.map((e, c) => (e * physK[c]) / Math.PI) : ps.K).map((v) => v * fRes) as XYZS }))
        : [];
      resolved.push({
        body: b, frame, lit,
        K: K.map((v) => v * fRes) as XYZS,
        law, surface: orient ? surface : null,
        bodyToWorld: orient ?? [1, 0, 0, 0, 1, 0, 0, 0, 1], radiiKm: radii,
        planetshine, ring: ringFor(b),
        sunDir, sunDistKm: toSunLen, sunRadiusKm: sunR,
        riccoWeight: 1, occluders, hatch, tint,
        earth: orient ? earth : null,
        atmosphere: orient && atmB && b.atmosphere && irr
          ? {
            data: b.atmosphere,
            groundAlbedo,
            onDisk,
            shellBeta: prepareBody(b.pos, [atmTop(b), atmTop(b), atmTop(b)], null, 3 * g.pixelAngle).beta,
            sunAngularRadius: Math.asin(Math.min(1, sunR / toSunLen)),
            sunE: irr.map((v, c) => (v / (Math.PI * dAU * dAU)) * fRes * (modelScale ? modelScale[c] : 1)) as XYZS,
            binding: atmB,
          }
          : null,
      });
    }
    if (fRes < 1 && c[2] < 0 && !behindShield) {
      const ndc = camToNdc(g, c);
      // The unresolved part of the disk plus the unresolved part of its rings' reflected light.
      let Ep: XYZS | null = E && E[1] > 0 ? (E.map((v) => v * (1 - fRes)) as XYZS) : null;
      const rp = ringPoint.get(b);
      let ptLabel = label;
      if (rp && rp[1] > 0) {
        Ep = Ep ? (Ep.map((v, k) => v + rp[k]) as XYZS) : rp;
        ptLabel = worse(ptLabel, b.rings!.worstLabel);
      }
      if (Ep) {
        // Visibility is judged on the GPU at the point's own background (eye-model.md §2 "Fixations");
        // here only points invisible even against a zero background are dropped.
        if (blackwellEquivalent(Ep[1], Ep[3], zeroBg.mesopic.m) >= zeroBg.thresholdBwLux) {
          // In the switch the body is part disk, part point. The point is drawn at the depth of the body's nearest
          // point, not of its centre: the centre lies behind the disk's surface, and the disk would hide the core
          // of the body's own splat. Anything nearer than the body still hides the point.
          const nearest = Math.max((-c[2] - extentOf(b, b.radii)) * (1 - OWN_POINT_DEPTH_MARGIN), g.near);
          points.push({ ndc, depth: g.near / nearest, E: Ep });
        }
        if (tintOn && fRes < 0.5) ringVertices(ndc, 7, 1.5, [...PROVENANCE_TINT[ptLabel], PROVENANCE_TINT_ALPHA] as [number, number, number, number], g, overlay);
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
  // The analytic veil is evaluated per pixel for every source, so keep only sources whose veil can reach
  // 1 % of the dark light somewhere in the frame (a numerical tolerance: fainter veils cannot change what
  // is seen), strongest first; the renderer binds at most MAX_GLARE_SOURCES of them.
  const halfDiagDeg = (Math.atan(Math.hypot(g.tanX, g.tanY)) * 180) / Math.PI;
  const veilMax = (gs: GlareSource) => {
    const th = gs.inFrame ? gs.minDeg : Math.max((angle(gs.dir, fwd) * 180) / Math.PI - halfDiagDeg, gs.minDeg);
    return gs.E[1] * cie146(Math.min(Math.max(th, CIE146.minDeg), CIE146.maxDeg), eye.settings.ageYears, eye.settings.pigmentation);
  };
  const veiling = inField
    .map((gs) => ({ gs, v: veilMax(gs) }))
    .filter((x) => x.gs.inFrame || x.v >= 0.01 * DARK_LIGHT_CONE)
    .sort((a, b) => b.v - a.v)
    .map((x) => x.gs);
  return { resolved, points, sun, glare: veiling, overlay, warnings, adaptedWhite, rings, offFrameFluxDeg2, sunShield };
}

/**
 * Outline of the Sun shield's occulting disc (a display overlay marking the viewing aid): the rim of the
 * cone of angular radius `r` around `n`, projected, as a thin band of triangles in `out`.
 */
function occulterOutline(g: CameraGeom, n: V3, r: number, out: number[]): void {
  const [e1, e2] = tangent(n);
  const seg = 64;
  const half = 0.75; // px: a 1.5 px line
  const rim: ([number, number] | null)[] = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * 2 * Math.PI;
    const d: V3 = [0, 1, 2].map((k) => Math.cos(r) * n[k] + Math.sin(r) * (Math.cos(a) * e1[k] + Math.sin(a) * e2[k])) as V3;
    const c = toCam(g, d);
    rim.push(c[2] < 0 ? camToNdc(g, c) : null);
  }
  const col = OCCULTER_OUTLINE_RGBA;
  for (let i = 0; i < seg; i++) {
    const p = rim[i];
    const q = rim[i + 1];
    if (!p || !q) continue;
    // Offset perpendicular to the segment, in pixels.
    const dx = ((q[0] - p[0]) * g.W) / 2;
    const dy = ((q[1] - p[1]) * g.H) / 2;
    const l = Math.hypot(dx, dy) || 1;
    const ox = ((-dy / l) * half * 2) / g.W;
    const oy = ((dx / l) * half * 2) / g.H;
    const v = (x: number, y: number) => out.push(x, y, 0, col[0], col[1], col[2], col[3]);
    v(p[0] - ox, p[1] - oy); v(q[0] - ox, q[1] - oy); v(p[0] + ox, p[1] + oy);
    v(p[0] + ox, p[1] + oy); v(q[0] - ox, q[1] - oy); v(q[0] + ox, q[1] + oy);
  }
}

/** Smallest radius (px) at which the occulting disc's outline is drawn (a UI marking). */
const OCCULTER_OUTLINE_MIN_PX = 5;
/** Display colour of the occulting disc's outline (a UI marking, not scene light): neutral grey. */
const OCCULTER_OUTLINE_RGBA = [0.45, 0.45, 0.45, 0.9] as const;

/** Largest extent of a body from its centre: its radii, or its shape mesh where one is drawn (meshes/). */
function extentOf(b: SceneBody, radii: [number, number, number]): number {
  return Math.max(...radii, b.shape?.boundRadiusKm ?? 0);
}

/** Radius of the atmosphere shell around a body: its largest radius plus the atmosphere's height. */
function atmTop(b: SceneBody): number {
  const a = b.atmosphere!.body;
  return Math.max(...b.radii!) + (a.topAltitudeKm ?? 0) - (a.altitudesKm[0] ?? 0);
}

/**
 * Disk integrals of a body drawn from its atmosphere model (modelDiskXYZS: the air's light per channel, then the
 * surface term per unit reflectance) at phase angle a, from the same 1° bins, linear between them. A new bin costs
 * one integral (about 30 ms for Titan's 12 spectral bins). The held edge and the current phase share this cache,
 * including for points: at most four new integrals on a cold frame, one per crossed bin for a slow phase.
 */
function modelDisk(bind: AtmosphereBinding, a: number): number[] {
  const binning = (Math.PI / 180) * ATM_FACTOR_BIN_DEG;
  const i0 = Math.min(Math.floor(a / binning), Math.round(Math.PI / binning) - 1);
  const at = (i: number): number[] => {
    const key = `model|${bind.key}|${i}`;
    let f = atmCache.get(key);
    if (!f) {
      const d = modelDiskXYZS(bind.model, bind.tables!, bind.grid!, [Math.sin(i * binning), 0, Math.cos(i * binning)], [0, 0, 1], ATM_DISK_NODES);
      f = [...d.air, ...d.surface];
      if (atmCache.size > 4096) atmCache.clear();
      atmCache.set(key, f);
    }
    return f;
  };
  const f0 = at(i0), f1 = at(i0 + 1);
  const tt = Math.min(Math.max(a / binning - i0, 0), 1);
  return f0.map((v, k) => v + (f1[k] - v) * tt);
}

function tangent(n: V3): [V3, V3] {
  const h: V3 = Math.abs(n[0]) < 0.6 ? [1, 0, 0] : Math.abs(n[1]) < 0.6 ? [0, 1, 0] : [0, 0, 1];
  const e1 = normalize([n[1] * h[2] - n[2] * h[1], n[2] * h[0] - n[0] * h[2], n[0] * h[1] - n[1] * h[0]]);
  const e2: V3 = [n[1] * e1[2] - n[2] * e1[1], n[2] * e1[0] - n[0] * e1[2], n[0] * e1[1] - n[1] * e1[0]];
  return [e1, e2];
}
