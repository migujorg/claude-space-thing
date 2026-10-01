// The per-frame interface between the app shell (which knows about time, data, camera and reality
// settings) and the renderer (which only knows how to turn light into pixels).
//
// The shell applies the reality filter (docs/architecture.md §5.2–5.3) BEFORE building a snapshot:
// anything not allowed at the current `exists` level arrives here as null / flagged, so the renderer
// never needs to reason about provenance labels except for the provenance-tint overlay.

import type { BodyAtmosphere, DiskReflectanceModel, Label, PhaseFunction, RingReflectance, SpatialPhotometricModel, SurfaceLayerHeader } from '../data/schema';
import type { EyeSettings } from '../eye/settings';
import type { CometActivity } from './comets/model';
import type { CloudPopulation } from './earth';

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
  /**
   * The phase function is a model or an estimate rather than a measurement (its label is `estimated`; e.g. the
   * Earth's, a radiative-transfer fit). Where the air of a measured atmosphere alone outshines such a curve, the air
   * is drawn and the surface under it gets no light (frame.ts); against a measured curve the air is not drawn.
   */
  phaseEstimated?: boolean;
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
    /**
     * Earth: a layer of kind 'cloud-optical-thickness-moments' (tauRetrievedFraction, lnTauMoment1, lnTauMoment2,
     * iceTauFraction; the clouds layer's samples): which share of the cloud has a measured optical thickness, and
     * its ln τ distribution. Used with `clouds`; without it the clouds layer's mean τ is used.
     */
    cloudTau?: SurfaceLayerRef;
    /**
     * Earth: the τ population for the cloud without a retrieval (cloudFraction − f_τ), when the reality level
     * admits its label (render/earth.ts unmeasuredTauPopulation of cloudTau's header; estimated). Without it that
     * cloud stays unknown (hatched where it dominates).
     */
    cloudTauUnmeasured?: CloudPopulation;
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
   * redistributed over the mesh (energy normalization by the mesh's mean projected area). Set only for a body at
   * least a pixel across (a point is drawn from the disk photometry alone); include its label in `worstLabel`.
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
  /**
   * A body drawn from its atmosphere model (Titan; docs/rendering-earth.md §8 "Titan"): the Lambert reflectance
   * of what lies below the air, per sample of `wavelengthsNm` and per channel X, Y, Z, S (BodyAtmosphere
   * .surfaceReflectance; its label is in `worstLabel`). The resolved disk is then the model's own (sunlight through
   * the air onto this surface, plus the air's light), not renormalized to the disk photometry. Absent: the body
   * keeps its disk photometry and the air is drawn over it renormalized (§8).
   */
  surface?: { reflectance: number[]; xyzs: [number, number, number, number] };
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
  /** How the eye adapts over time (docs/eye-model.md §2 "Time"); absent = instant. */
  adaptation?: AdaptationSettings;
}

/**
 * 'realtime': the eye adapts over real elapsed time, neurally in fractions of a second and through its
 * pigments over minutes (dark adaptation takes ~30–40 min after daylight). 'instant': always fully adapted
 * to the view. Renderer.settled() (screenshots, tests) uses instant pigments unless a `history` is given.
 */
export interface AdaptationSettings {
  mode: 'instant' | 'realtime';
  /**
   * A defined past, for tests and demonstrations: the eye was adapted to a uniform field of
   * `luminanceCdM2` (photopic; scotopic from sunlight's S/P) filling the view for `exposureS`, then has
   * looked at the current view for `elapsedS`. Applied until the adaptation to the view has settled, then
   * the eye goes on in real time.
   */
  history?: { luminanceCdM2: number; exposureS: number; elapsedS: number };
}

export interface OrbitPolyline {
  id: number;
  /** Camera-relative points, km, float64 (renderer converts). */
  points: Float64Array;
  selected: boolean;
}

/**
 * A comet drawn extended (coma, dust tail, ion tail; render/comets). The shell sends only comets resolved from the
 * camera (render/comets/lod.ts) and takes them out of the small-body field's points; the rest stay points.
 */
export interface SceneComet {
  /** Body id (small bodies: −(row + 1)). */
  id: number;
  name: string;
  /** Camera-relative apparent position of the nucleus (km, ICRF, light-time corrected). float64. */
  rel: Vec3;
  /** Heliocentric ICRF state of the nucleus at the emission time (km, km/s): position and velocity from the propagator. */
  helioPos: Vec3;
  helioVel: Vec3;
  /** SBDB total-magnitude law and its label. */
  M1: number;
  K1: number;
  totalLabel: Label;
  /** Composition (render/comets/model.ts CometActivity): the comet's measured ratios or the population medians. */
  activity: CometActivity;
  /** Dust colour population (long-period: P > 200 yr or unbound). */
  dust: 'longPeriod' | 'shortPeriod';
}

export interface SceneSnapshot {
  et: number;
  camera: SceneCamera;
  sun: SceneSun | null;
  bodies: SceneBody[];
  view: ViewSettings;
  orbits: OrbitPolyline[];
  /** Comets drawn extended this frame (optional; absent: none). */
  comets?: SceneComet[];
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
  /**
   * Faintest point source visible anywhere in the frame (V mag, 2850 K-coloured): the eye looking at the
   * darkest background in the frame, adapted to it, with the current pigment state. Point sources are culled
   * against their own background (eye-model.md §2 "Fixations"), so this, not limitingMagnitude, bounds
   * which catalogue stars can be drawn at all.
   */
  pointLimitingMagnitude?: number;
  /**
   * Dark adaptation (eye/bleaching.ts): share of the excess rod bleach regenerated (1 = adapted to the
   * current light), minutes until the rod threshold is within 0.1 log unit of adapted if the light stays,
   * rod threshold elevation (log₁₀), cone photon catch relative to adapted, and a HUD line.
   */
  darkAdaptation?: { fraction: number; minutesToFull: number; rodLogElevation: number; coneCatch: number; text: string };
  /** Things the renderer could not draw as requested, e.g. "Sun: limb darkening unknown → drawn as a point". */
  warnings?: string[];
  /** GPU time per pass, ms (timestamp queries; absent where the adapter lacks 'timestamp-query'). A frame or two old. */
  gpuPassMs?: Record<string, number>;
  /** Sum of gpuPassMs, ms. */
  gpuFrameMs?: number;
  /** CPU time of the last render() call, ms: frame preparation (photometry, rings, tiles) and all of render() up to submit. */
  cpuPrepMs?: number;
  cpuFrameMs?: number;
  /** Comets drawn extended in the last frame (render/comets): comae and tail packets. */
  comets?: { comae: number; packets: number };
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
