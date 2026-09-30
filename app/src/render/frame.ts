// CPU-side (float64) preparation of one frame: which bodies are resolved disks and which are points,
// their photometry per docs/architecture.md §4.3, eclipse occluders, the Sun, analytic glare sources
// and display-space overlays. No GPU calls here; renderer.ts packs the result into buffers.

import type { SceneAtmosphere, SceneBody, SceneSnapshot } from './scene';
import { AU_KM } from './constants';
import { diskIlluminance, diskModelPPhi, evalPhase, extrapolatePhase, LAMBERT_ALBEDO_PER_GEOMETRIC_ALBEDO, lambertPhase, limbDarkenedI0, meanRadius, phaseRangeDeg, type XYZS } from './photometry';
import { LAMBERT_LAW, LAW, lawDiskIntegral, lawRadf, mapDiskIntegral, NormalizationCache, photometricFrame, resolveLaw, TEXEL_LAW, type ResolvedLaw, type ZonalProfile } from './spatial';
import { sampleLevel0, type Level0Map } from './surface';
import { NIGHT_LAMP } from './earth';
import { atmosphereDiskFactors, marsDustScale } from './atmosphere';
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
  return { absR: [abs.X, abs.Y, abs.Z, abs.S], nightK };
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
  sunShield: { dir: V3; cosRadius: number } | null;
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
/** Disk renormalization factors under an atmosphere (I0, Iatm, Apath, Ashell per channel), by phase bin. */
const ATM_FACTOR_BIN_DEG = 1;
const atmCache = new Map<string, number[]>();
const zonalIds = new WeakMap<ZonalProfile, number>();
let nextZonalId = 1;
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
  /**
   * A body's atmosphere once its tables are ready (atmosphereGpu.ts), else null: groundAlbedo for the
   * multiple-scattering table, dust the Mars season scaling.
   */
  atmospheres?: (b: SceneBody, groundAlbedo: number[], dust: { scale: number; bin: number } | null) => AtmosphereBinding | { error: string; unmeasured?: AtmosphereBinding } | null;
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
  const zeroBg = pointObserver(eye, { Y: 0, S: 0 });

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
  let sunShield: { dir: V3; cosRadius: number } | null = null;
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
    // Sun shield (viewing aid, ViewSettings.sunShield): an occulting disc covers the solar disk (its
    // angular radius plus one pixel). The Sun's light never reaches the eye: no disk, no point, no veil.
    const shielded = snap.view.sunShield === true;
    if (shielded) sunShield = { dir: n, cosRadius: Math.cos(Math.min(rho + g.pixelAngle, Math.PI)) };
    if (!s.limbDarkening && diamPx > 1 && !shielded) warnings.push('Sun: limb darkening unknown → drawn as an unresolved point of the correct illuminance (no uniform disk assumed)');
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
          warnings.push(`${b.name}: phase extrapolated beyond measured range (${range?.[0]}–${range?.[1]}°) with the spatial law → estimated`);
        } else {
          warnings.push(`${b.name}: ${ph.reason} → sunlit part drawn as not measured (night side black)`);
        }
      }
      if (phi !== null) pPhi = b.albedoXYZS.map((a) => a * phi!) as XYZS;
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
    // Only for a resolved disk (smooth(1, 2, diameter px) > 0): a point's light is its disk photometry.
    if (b.atmosphere && b.orient && irr && lit && opts.atmospheres && (earth || pPhi) && (2 * angR) / g.pixelAngle > 1) {
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
        // in 1° bins, linear between bins: a new bin costs one integral (a few ms), whatever the rotation.
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
            }, 16);
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
        if (air.some((a, c) => !(a < pRef[c]))) {
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
    const fRes = smooth(1, 2, diamPx);
    const At = 2 * Math.PI * (1 - Math.cos(angR));
    const ricco = Math.min(1, Math.max(At, pointFootprintSr) / AR);

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
      // Earth: the source's illuminance over π, shaded by the Earth model like sunlight (earth.ts).
      const planetshine = lit
        ? planetshineSources(b, snap.bodies, irr).map((ps) => ({ ...ps, K: (earth ? ps.E.map((e) => e / Math.PI) : ps.K).map((v) => v * fRes) as XYZS }))
        : [];
      resolved.push({
        body: b, frame, lit,
        K: K.map((v) => v * fRes) as XYZS,
        law, surface: orient ? surface : null,
        bodyToWorld: orient ?? [1, 0, 0, 0, 1, 0, 0, 0, 1], radiiKm: radii,
        planetshine, ring: ringFor(b),
        sunDir, sunDistKm: toSunLen, sunRadiusKm: sunR,
        riccoWeight: ricco, occluders, hatch, tint,
        earth: orient ? earth : null,
        atmosphere: orient && atmB && b.atmosphere && irr
          ? {
            data: b.atmosphere,
            groundAlbedo,
            onDisk,
            shellBeta: prepareBody(b.pos, [atmTop(b), atmTop(b), atmTop(b)], null, 3 * g.pixelAngle).beta,
            sunAngularRadius: Math.asin(Math.min(1, sunR / toSunLen)),
            sunE: irr.map((v) => (v / (Math.PI * dAU * dAU)) * fRes) as XYZS,
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
          points.push({ ndc, depth: g.near / -c[2], E: Ep });
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

function tangent(n: V3): [V3, V3] {
  const h: V3 = Math.abs(n[0]) < 0.6 ? [1, 0, 0] : Math.abs(n[1]) < 0.6 ? [0, 1, 0] : [0, 0, 1];
  const e1 = normalize([n[1] * h[2] - n[2] * h[1], n[2] * h[0] - n[0] * h[2], n[0] * h[1] - n[1] * h[0]]);
  const e2: V3 = [n[1] * e1[2] - n[2] * e1[1], n[2] * e1[0] - n[0] * e1[2], n[0] * e1[1] - n[1] * e1[0]];
  return [e1, e2];
}
