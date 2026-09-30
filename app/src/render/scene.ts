// The per-frame interface between the app shell (which knows about time, data, camera and reality
// settings) and the renderer (which only knows how to turn light into pixels).
//
// The shell applies the reality filter (docs/architecture.md §5.2–5.3) BEFORE building a snapshot:
// anything not allowed at the current `exists` level arrives here as null / flagged, so the renderer
// never needs to reason about provenance labels except for the provenance-tint overlay.

import type { Label, PhaseFunction, SpatialPhotometricModel, SurfaceLayerHeader } from '../data/schema';
import type { EyeSettings } from '../eye/settings';

export type { EyeSettings };

export type Vec3 = [number, number, number];
/** Row-major 3x3 matrix. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export interface SceneBody {
  id: number;
  name: string;
  /** Camera-relative position of the body center in km, ICRF axes, light-time corrected. float64. */
  pos: Vec3;
  /** Vector from the body center to the Sun center, km, ICRF (at the light-time-corrected epoch). */
  toSun: Vec3;
  /** Body-fixed → ICRF rotation at the light-time-corrected epoch; null if not allowed/unknown. */
  orient: Mat3 | null;
  /** Triaxial radii (km); null if not allowed/unknown → the renderer draws nothing resolved, only a point if brightness is known. */
  radii: Vec3 | null;
  /** docs/architecture.md §4.3; null if not allowed/unknown. */
  albedoXYZS: [number, number, number, number] | null;
  /** null → no allowed phase function; renderer may not invent one. */
  phase: PhaseFunction | null;
  /** When true, draw the silhouette with the "not measured" hatch material instead of a lit surface (§5.3). */
  surfaceUnknown: boolean;
  /** Worst provenance label among what is drawn, for the provenance-tint overlay. */
  worstLabel: Label;
  selected: boolean;

  // ── M2 additions (all optional; see docs/rendering-m2.md) ─────────────────────────────────────
  /**
   * Surface maps (docs/architecture.md §4.4). Used only when `orient` is known (a map needs the
   * body-fixed frame) and the surface is lit and measured. The renderer fetches the tiles itself.
   */
  surface?: { albedo?: SurfaceLayerRef; height?: SurfaceLayerRef };
  /**
   * Measured spatially resolved photometric model (photometry.json `spatialModel`), already filtered by
   * the reality level; absent/null → Lambert. It only redistributes light across the disk: the disk
   * integral stays albedoXYZS·Φ(α) (§4.3).
   */
  spatialModel?: SpatialPhotometricModel | null;
  /** Ring system centred on this body (ring plane through the body centre). */
  rings?: SceneRings | null;
  /**
   * Reality levels best/complete (NORTH_STAR 3.2/3.7): outside the measured phase-angle range of
   * `phase`, continue Φ(α) with the spatial law's own phase dependence, scaled to be continuous at the
   * edge of the range; the result is labelled estimated (tint, warning). false/absent (strict): the
   * sunlit part is hatched as not measured.
   */
  allowPhaseExtrapolation?: boolean;
}

/**
 * One layer of a surface-map pyramid (architecture §4.4): the parsed `surfaces/<naifId>/<layer>.json`
 * (SurfaceLayerHeader) and where to fetch its tiles. The renderer reads `maxLevel`, `tilePath`,
 * `missingTiles`, `format` and `channels`; a layer whose format is not the one the renderer decodes
 * (albedo: float16 X, Y, Z, S; height: float32 metres) is ignored with a warning.
 */
export interface SurfaceLayerRef {
  /**
   * With a pipeline header (it has `tilePath`, relative to the data root): the data root URL, e.g.
   * '/data'; tile (L, ty, tx) is `${url}/${tilePath}` with {level}, {ty}, {tx} substituted. Without
   * `tilePath` (test fixtures): the layer directory, tile = `${url}/${L}/${ty}/${tx}.bin`.
   */
  url: string;
  header: Partial<SurfaceLayerHeader> & {
    /** Finest pyramid level present (levels 0..maxLevel). */
    maxLevel: number;
    /** Fixture form of `missingTiles`: level (as a string key) → [tx, ty] pairs not stored (entirely unknown). */
    missing?: Record<string, [number, number][]>;
  };
}

/**
 * A planetary ring system as the renderer needs it (docs/rendering-m2.md §5). Radial profiles are
 * sampled at increasing radii; between samples values are interpolated linearly, outside
 * [radiusKm[0], radiusKm[last]] there is no ring. Physics: many-particle-thick classical layer with
 * single scattering (lit face I/F = ϖ0·P(α)/4 · μ0/(μ + μ0) · [1 − e^(−τ(1/μ + 1/μ0))], unlit face
 * (ϖ0·P/4)·μ0/(μ − μ0)·[e^(−τ/μ) − e^(−τ/μ0)]), direct transmission e^(−τ/μ).
 */
export interface SceneRings {
  /** Unit normal of the ring plane (ICRF); usually the planet's north pole. */
  normal: Vec3;
  /** Sample radii, km, strictly increasing. */
  radiusKm: number[];
  /** Normal optical depth at each sample; null = not measured there (drawn as a hatched gap, no light, no shadow). */
  tau: (number | null)[];
  /** Ring-particle single-scattering albedo ϖ0 per channel (X, Y, Z, scotopic) at each sample; null = unknown (rings then only absorb). */
  albedoXYZS: ([number, number, number, number] | null)[] | null;
  /** Particle phase function normalised so ∫P dΩ/4π = 1; null = unknown (rings then only absorb). */
  particlePhase: { kind: 'hg'; g: number } | { kind: 'tabulated'; alphaDeg: number[]; P: number[] } | null;
  /** Worst provenance label among the ring data drawn, for the provenance tint. */
  worstLabel: Label;
}

export interface SceneSun {
  pos: Vec3;               // camera-relative, km
  radius: number;          // km
  irradianceXYZS_1AU: [number, number, number, number];
  /** Limb darkening I(mu)/I(1) polynomial coefficients per channel (X, Y, Z, S); null → uniform disk is NOT assumed, sun drawn as unresolved point + "limb darkening unknown". */
  limbDarkening: number[][] | null;
}

export interface SceneCamera {
  /** Camera → ICRF rotation (columns: right, up, back, i.e. camera looks along −Z). */
  orient: Mat3;
  fovY: number;            // radians
  width: number;           // pixels
  height: number;
}

export interface ViewSettings {
  mode: 'eye' | 'enhanced';
  /** Only in 'enhanced': extra exposure in stops on top of the eye's adaptation. */
  exposureBoostStops: number;
  overlays: { provenanceTint: boolean };
  /**
   * Optional observer/display settings (see app/src/eye/settings.ts for meanings and defaults):
   * ageYears, pigmentation, fieldFactor, eyes, adaptationFieldDeg, displayPeakCdM2, displayBlackCdM2.
   * Omitted fields keep their defaults.
   */
  eye?: Partial<EyeSettings>;
}

export interface OrbitPolyline {
  id: number;
  /** Camera-relative points, km, float64 (renderer converts). */
  points: Float64Array;
  selected: boolean;
}

export interface SceneSnapshot {
  et: number;
  camera: SceneCamera;
  sun: SceneSun | null;
  bodies: SceneBody[];
  view: ViewSettings;
  orbits: OrbitPolyline[];
}

/** Star catalog as loaded from app/public/data/stars/*.bin (see the header's field list). */
export interface StarCatalog {
  count: number;
  /** Interleaved float32: ux, uy, uz (ICRF unit vector), X, Y, Z, S (illuminance at the observer, lux). */
  data: Float32Array;
  stride: number; // floats per star
}

export interface RendererStats {
  frameMs: number;
  /** Current eye adaptation luminance, cd/m². */
  adaptationLuminance: number;
  starsDrawn: number;
  /** Scotopic adaptation luminance, scotopic cd/m². */
  scotopicAdaptationLuminance?: number;
  /** Pupil diameter from the eye model, mm. */
  pupilDiameterMm?: number;
  /** CIE 191 mesopic coefficient m of the adaptation state (1 photopic … 0 scotopic). */
  mesopicM?: number;
  /** Faintest point source visible at the adaptation state (V mag, for a 2850 K-coloured point). */
  limitingMagnitude?: number;
  /** Things the renderer could not draw as requested, e.g. "Sun: limb darkening unknown → drawn as a point". */
  warnings?: string[];
  /** GPU time per pass, ms (timestamp queries; absent where the adapter lacks 'timestamp-query'). A frame or two old. */
  gpuPassMs?: Record<string, number>;
  /** Sum of gpuPassMs, ms. */
  gpuFrameMs?: number;
  /** Surface-map tile cache (virtual texturing). */
  surfaceCache?: {
    budgetMiB: number;
    usedMiB: number;
    residentTiles: number;
    pendingFetches: number;
    /** Tiles wanted this frame that the budget could not hold (finer detail is then deferred). */
    deferredTiles: number;
    failedFetches: number;
  };
}
