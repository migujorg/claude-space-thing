// The per-frame interface between the app shell (which knows about time, data, camera and reality
// settings) and the renderer (which only knows how to turn light into pixels).
//
// The shell applies the reality filter (docs/architecture.md §5.2–5.3) BEFORE building a snapshot:
// anything not allowed at the current `exists` level arrives here as null / flagged, so the renderer
// never needs to reason about provenance labels except for the provenance-tint overlay.

import type { Label, PhaseFunction } from '../data/schema';
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
}
