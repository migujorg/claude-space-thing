// The per-frame interface between the app shell (which knows about time, data, camera and reality
// settings) and the renderer (which only knows how to turn light into pixels).
//
// The shell applies the reality filter (docs/architecture.md §5.2–5.3) BEFORE building a snapshot:
// anything not allowed at the current `exists` level arrives here as null / flagged, so the renderer
// never needs to reason about provenance labels except for the provenance-tint overlay.

import type { BodyAtmosphere, DiskReflectanceModel, Label, PhaseFunction, RingReflectance, SpatialPhotometricModel, SurfaceLayerHeader } from '../data/schema';
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
  surface?: {
    albedo?: SurfaceLayerRef;
    height?: SurfaceLayerRef;
    /**
     * Per-texel photometric model (a layer of kind 'photometric-parameters', e.g. surfaces/301/hapke):
     * the spatial law of the lit disk, per texel (texelLaw.ts). Used with the albedo layer, whose header
     * supplies the band → XYZS weights; the disk integral still equals the disk photometry.
     */
    photometry?: SurfaceLayerRef;
    /**
     * Earth (docs/rendering-earth.md). A layer of kind 'cloud-properties' (cloudFraction,
     * opticalThickness, cloudTopHeightM, iceFraction). With an albedo layer of surface-only reflectance
     * (its header has `normalization.absoluteDiskMean`), the renderer draws the surface from the map's
     * absolute reflectance and the clouds from this layer, instead of scaling the map by disk photometry.
     * A surface-only map without this layer is not used.
     */
    clouds?: SurfaceLayerRef;
    /** Earth: a layer of kind 'surface-water' (waterFraction, seaIceFraction): sea ice, and later glint. */
    water?: SurfaceLayerRef;
    /** Earth: a layer of kind 'emitted-radiance' (dnbRadiance, censoredFraction; night lights). */
    night?: SurfaceLayerRef;
    /**
     * Earth: a layer of kind 'surface-wind' (windSpeed10mAscending, windSpeed10mDailyMean, passes) for the
     * sun glint (Cox & Munk). Loaded whole at its finest level (≤ 2). Without it no glint is drawn.
     */
    wind?: SurfaceLayerRef;
  };
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
  /**
   * photometry.json `diskReflectanceModel.value` (the Moon: ROLO, kind 'rolo-v1') when admitted at the
   * reality level. Inside its domain (phase range and observer libration range; it needs `orient` and
   * the Sun's irradiance) it gives the disk-integrated brightness in place of albedoXYZS·Φ(α)
   * (architecture §4.3); outside, `phase` applies as usual. Include its label in `worstLabel`.
   */
  diskReflectanceModel?: DiskReflectanceModel | null;
  /**
   * atmospheres.json for this body, when admitted at the reality level (its worst label in `worstLabel` and
   * in `atmosphere.worstLabel`). Drawn for Earth with its layers (docs/rendering-earth.md §4): multiple
   * scattering, limb and terminator colours; for other bodies over their renormalized disk photometry (§8).
   * A component whose single-scattering albedo or phase function is unknown: no light is drawn for the
   * atmosphere, and the air beyond the disk is marked "not measured" (warning).
   */
  atmosphere?: SceneAtmosphere | null;
  /**
   * Shape model (docs/rendering-shapes.md): a triangle mesh drawn in place of the triaxial ellipsoid, when its
   * shape and orientation are admitted at the reality level. The renderer fetches the mesh levels itself and draws
   * the ellipsoid until one is resident. Radii, albedo and phase keep their meaning: the disk photometry is
   * redistributed over the mesh (energy normalization by the mesh's mean projected area). Include its label in
   * `worstLabel`.
   */
  shape?: SceneShape | null;
}

/** A shape model as the renderer needs it (docs/rendering-shapes.md; ShapeModelHeader, DamitIndexHeader). */
export interface SceneShape {
  /** Stable key of the model (the renderer caches its levels by key), e.g. 'shapes/401' or 'damit/1234'. */
  key: string;
  /** Mesh frame → ICRF rotation (row-major) at the body's light-emission epoch. */
  orient: Mat3;
  /** Model units → km (1 for meshes in km; DAMIT: the measured size over the model's). */
  scaleKm: number;
  /** Largest distance of the mesh from the body centre, km (culling: an irregular body reaches beyond its radii). */
  boundRadiusKm: number;
  /** Surface area of the mesh, km² (level-of-detail choice before any level is loaded). */
  areaKm2: number;
  /** Levels of detail, finest first. */
  lods: SceneShapeLod[];
  /** Worst label of the shape, its orientation and the energy normalization (derived). */
  worstLabel: Label;
}

export interface SceneShapeLod {
  /** URL of the binary that holds this level (data root + path). */
  url: string;
  /** Byte range of this level in the binary. */
  offset: number;
  bytes: number;
  triangles: number;
  vertices: number;
  /**
   * 'shape': a ShapeModelHeader level (float32 positions, int16 normals, u16/u32 indices at `parts`, offsets
   * relative to `offset`); 'damit': int16 positions × quantScale/32767 then u16 indices, no normals.
   */
  format: 'shape' | 'damit';
  parts?: {
    positions: { offset: number; bytes: number };
    normals: { offset: number; bytes: number };
    indices: { offset: number; bytes: number; type: 'u16' | 'u32' };
  };
  quantScale?: number;
}

/** One body's atmosphere from atmospheres.json (AtmosphereFile), with the file's spectral grid. */
export interface SceneAtmosphere {
  wavelengthsNm: number[];
  /** AtmosphereFile.foldWeights.value (4 × wavelengths). */
  foldWeights: number[][];
  /** AtmosphereFile.bodies[id]. The renderer caches its tables by this object's identity: keep it stable. */
  body: BodyAtmosphere;
  worstLabel: Label;
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
 * A planetary ring system as the renderer needs it (docs/rendering-m2.md §5): the planet's entry of
 * rings.json (`RingSystem`, architecture §6) after the reality filter. The ring plane passes through
 * the planet centre.
 */
export interface SceneRings {
  /** Unit normal of the ring plane (ICRF): the planet's IAU north pole. */
  normal: Vec3;
  /**
   * rings.json `opticalDepth.value` (RingProfile[]; only `radiusKm` and `normalTau` are read). The rings
   * extend over the profiles' radii; where profiles overlap, the first with a value at a radius wins.
   * τ null → not measured there (hatched, no light, no shadow). Sets the extinction: ring shadows on
   * bodies, bodies seen through the rings.
   */
  opticalDepth: { radiusKm: number[]; normalTau: (number | null)[] }[];
  /**
   * rings.json `reflectance.value` (kind 'single-scattering-v1', Saturn) when admitted at the reality
   * level; null when its label is `unknown` (Jupiter, Uranus, Neptune) or it is not admitted: the rings
   * then only absorb and cast shadows, and their material is hatched as "not measured".
   */
  reflectance: RingReflectance | null;
  /** Worst provenance label among the ring data drawn (e.g. estimated for Saturn's reflectance). */
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
  /**
   * Viewing aid, not a change to reality (the shell shows it in the reality badge): an occulting disc
   * held over the Sun, like a coronagraph's occulter or a hand held up. It just covers the solar disk
   * (its angular radius plus one pixel), so the Sun's light never enters the eye: no solar disk, no
   * solar glare, no solar light in the adaptation or the pupil. Everything else stays physical,
   * including the sunlight on the bodies. Whatever lies behind the disc is hidden. Available in eye and
   * enhanced modes; off by default.
   */
  sunShield?: boolean;
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
  /** CPU time of the last render() call, ms: frame preparation (photometry, rings, tiles) and all of render() up to submit. */
  cpuPrepMs?: number;
  cpuFrameMs?: number;
  /** Shape meshes (docs/rendering-shapes.md): level cache and what was drawn from meshes this frame. */
  meshes?: {
    budgetMiB: number;
    usedMiB: number;
    residentLevels: number;
    pendingFetches: number;
    failedFetches: number;
    models: number;
    drawn: { name: string; level: number; triangles: number; energyNormalization: number; selfShadow: boolean }[];
  };
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
