// The data contract between the pipeline and the app. See docs/architecture.md.
// The pipeline (Python) writes exactly these shapes; keep pipeline/src/pipeline/schema.py in sync.

export type Label = 'measured' | 'derived' | 'estimated' | 'synthetic' | 'unknown';

/** Provenance order: lower index = more grounded. */
export const LABEL_ORDER: readonly Label[] = ['measured', 'derived', 'estimated', 'synthetic', 'unknown'];

export interface Sourced<T> {
  value: T | null;
  unit?: string;
  label: Label;
  sources: string[];
  method?: string;
  uncertainty?: string;
}

export interface SourceRecord {
  id: string;
  title: string;
  citation: string;
  url: string;
  retrieved: string;
  sha256?: string;
  version?: string;
  license?: string;
  notes?: string;
}

export interface ProductEntry {
  path: string;
  bytes: number;
  sha256: string;
  stage: string;
}

export interface Manifest {
  generatedAt: string;
  pipelineVersion: string;
  /** Validity window of time-dependent products, TDB seconds past J2000. */
  window: { startEt: number; endEt: number };
  products: Record<string, ProductEntry>;
}

export interface LeapSecond {
  /**
   * UTC instant at which ΔAT takes this value, as seconds past 2000-01-01T12:00:00 counted with 86400 s per UTC
   * day and no leap seconds: exactly (Unix seconds of that instant) − 946728000. Same number SPICE stores for the
   * LSK's DELTET/DELTA_AT @dates.
   */
  utcJ2000: number;
  /** TAI − UTC in seconds from that instant. */
  deltaAT: number;
}

export interface TimeData {
  source: string;
  /** Human-readable statement of the conventions above (written by the `time` stage). */
  notes?: string;
  leapSeconds: LeapSecond[];
  /** TDB − TT periodic formula constants from the LSK. */
  deltaTA: number; // 32.184
  k: number;
  eb: number;
  m0: number;
  m1: number;
}

/** One SPK segment restricted to the window. Records are native SPK type 2 (or 3) layout in the .bin. */
export interface EphemSegment {
  target: number;
  center: number;
  frame: 'J2000';
  /** SPK type: 2/3 Chebyshev records, or 17 (precessing equinoctial conic: n = 1 record of 12 doubles). */
  type: 2 | 3 | 17;
  /** Start of first record interval, TDB s past J2000. */
  initEt: number;
  /** Length of each record interval, s. */
  intLen: number;
  /** Doubles per record (MID, RADIUS, then coefficients). */
  rsize: number;
  /** Number of records. */
  n: number;
  /** Offset into the .bin Float64Array, in doubles. */
  offset: number;
  /**
   * Coverage declared by the source segment, TDB s past J2000; may be narrower than the records' span
   * [initEt, initEt + n·intLen]. Absent → the records' span. Never evaluate outside it.
   */
  startEt?: number;
  endEt?: number;
  sources: string[];
  /** Provenance of the positions this segment produces (absent → treat as the worst of its sources, i.e. unknown). */
  label?: Label;
  method?: string;
  uncertainty?: string;
}

export interface EphemHeader {
  /** Path of the binary relative to the data root (app/public/data), e.g. "ephem/de442s.bin". */
  bin: string;
  segments: EphemSegment[];
  notes?: string;
}

/** IAU WGCCRE style rotation model, angles in degrees and time in days/centuries as the PCK defines them. */
export interface IauRotation {
  poleRa: number[];   // [a0, a1 (per century), a2 (per century^2)]
  poleDec: number[];
  pm: number[];       // [w0, w1 (per day), w2 (per day^2)]
  /** Nutation/precession: per-body trig terms (coefficients) referencing the system's angle polynomials. */
  nutPrecRa?: number[];
  nutPrecDec?: number[];
  nutPrecPm?: number[];
  /** System angle polynomials [theta0, theta1 (per century), ...] per angle, degrees; flattened, (nutPrecAnglesDegree + 1) numbers per angle. */
  nutPrecAngles?: number[];
  /** Polynomial degree of each nutPrecAngles entry (PCK BODY#_MAX_PHASE_DEGREE); absent → 1 (pairs). Mars uses 2. */
  nutPrecAnglesDegree?: number;
}

/** One binary-PCK type 2 segment (SPICE PCKE02): Chebyshev series of three Euler angles, same record layout as SPK type 2. */
export interface OrientSegment {
  /** NAIF body id whose orientation this is (399, 301). */
  body: number;
  /** PCK frame class id (3000 = ITRF93, 31008 = MOON_PA_DE440). */
  frameClassId: number;
  /** Frame the Euler angles are relative to; a key of OrientationHeader.references. */
  reference: string;
  type: 2;
  initEt: number;
  intLen: number;
  rsize: number;
  n: number;
  offset: number;
  /** Declared coverage (TDB s past J2000); may be narrower than the records' span. */
  startEt: number;
  endEt: number;
  sources: string[];
  label: Label;
  method?: string;
  uncertainty?: string;
}

/** orient/<name>.json: precise body orientation. reference → PCK frame = R3(w)·R1(δ)·R3(φ) (angles φ, δ, w). */
export interface OrientationHeader {
  /** Path of the binary relative to the data root, e.g. "orient/earth.bin". */
  bin: string;
  /** Row-major rotation matrices reference frame → J2000 (ICRF), by frame name (computed by SPICE). */
  references: Record<string, number[]>;
  /** Per body id: the body-fixed frame the app uses and the constant row-major rotation body frame → PCK frame. */
  bodies: Record<string, { frame: string; pckFrame: string; bodyToPck: number[] }>;
  segments: OrientSegment[];
  notes?: string;
}

export type BodyKind = 'star' | 'planet' | 'dwarf-planet' | 'moon' | 'barycenter';

export interface Body {
  id: number;
  name: string;
  kind: BodyKind;
  /** Body this one is grouped under in the UI (e.g. Moon -> Earth). */
  parent?: number;
  /** Which ephemeris file serves this body (holds its own segment), e.g. "ephem/sat-jup"; the loader chains segments to reach the SSB. */
  ephemeris: string;
  /** Every ephemeris file needed to chain this body to the SSB (includes `ephemeris`). Load them all into one EphemerisSet. */
  ephemerisFiles?: string[];
  /** Precise orientation product for this body ("orient/earth"), preferred over `rotation` where it covers (OrientationSet). */
  orientation?: string;
  /** Triaxial radii a, b, c in km. */
  radii: Sourced<[number, number, number]>;
  gm: Sourced<number>;
  rotation: Sourced<IauRotation>;
  /** Filled by the loader from photometry.json (produced by the `light` stage). Absent → all unknown. */
  photometry?: BodyPhotometry;
}

/** photometry.json: NAIF id (as string) → photometry. */
export type PhotometryFile = Record<string, BodyPhotometry>;

export interface BodyPhotometry {
  /** See docs/architecture.md §4.3. Four numbers (X, Y, Z, scotopic) in "lux at 1 AU". */
  geometricAlbedoXYZS: Sourced<[number, number, number, number]>;
  /** Visual geometric albedo, for display. */
  geometricAlbedoV: Sourced<number>;
  /** Disk-integrated phase function. */
  phaseFunction: Sourced<PhaseFunction>;
  /**
   * Optional measured spatially resolved photometric model (docs/architecture.md §4.4 "Photometric
   * model"; docs/rendering-m2.md). It sets only how light is distributed across the disk: the renderer
   * rescales it so the disk integral still equals geometricAlbedoXYZS·Φ(α). Absent → Lambert.
   */
  spatialModel?: Sourced<SpatialPhotometricModel>;
  /** Optional refinement with more geometry than the phase angle (the Moon: ROLO, with libration and the
   *  waxing/waning asymmetry). Inside its domain it gives the disk-integrated illuminance directly, in place of
   *  geometricAlbedoXYZS · Φ(α); see docs/architecture.md §4.3. */
  diskReflectanceModel?: Sourced<DiskReflectanceModel>;
}

/** Whole-disk reflectance A_c per channel (X, Y, Z, scotopic) vs viewing geometry, in the form of Kieffer & Stone
 *  (2005) Eq. 10. Illuminance at the observer E_c = A_c · E☉,c(1 AU)/d² · (radiusKm/Δ)². `formula` gives the
 *  expression and the units (radians in the polynomial terms, degrees elsewhere). */
export interface DiskReflectanceModel {
  kind: 'rolo-v1';
  formula: string;
  /** Per channel X, Y, Z, scotopic: [a0, a1, a2, a3]. */
  a: number[][];
  /** Per channel: [b1, b2, b3]. */
  b: number[][];
  /** Per channel: [d1, d2, d3]. */
  d: number[][];
  /** Shared by all channels: [c1, c2, c3, c4] (libration) and [p1, p2, p3, p4] (degrees). */
  c: [number, number, number, number];
  p: [number, number, number, number];
  radiusKm: number;
  /** Domain: minPhaseDeg ≤ α ≤ maxPhaseDeg, |observer selenographic latitude| ≤ maxObserverLatitudeDeg and
   *  |longitude| ≤ maxObserverLongitudeDeg; outside it the model does not apply. */
  minPhaseDeg: number;
  maxPhaseDeg: number;
  maxObserverLatitudeDeg: number;
  maxObserverLongitudeDeg: number;
}

/** A parameter that is either constant or tabulated against phase angle (linear interpolation, no extrapolation). */
export type PhaseDependent = number | { alphaDeg: number[]; values: number[] };

/**
 * Spatially resolved photometric (bidirectional reflectance) models. Angles: incidence i, emission e,
 * phase g; μ0 = cos i, μ = cos e. Each is a published model with its fitted parameters:
 *  - lambert:          r ∝ μ0
 *  - lommel-seeliger:  r ∝ μ0/(μ0 + μ)
 *  - lunar-lambert:    r ∝ 2L·μ0/(μ0 + μ) + (1 − L)·μ0   (McEwen 1991)
 *  - minnaert:         r ∝ μ0^k·μ^(k−1)                  (Minnaert 1941)
 *  - hapke:            Hapke (2012) isotropic multiple-scattering approximation with the shadow-hiding
 *                      (SHOE) and coherent-backscatter (CBOE) opposition effects, a double Henyey–Greenstein
 *                      particle phase function p(g) = (1+c)/2·HG(b, backward) + (1−c)/2·HG(b, forward),
 *                      porosity factor K and Hapke's (1984) macroscopic roughness θ̄.
 * `validPhaseDeg` (optional) is the phase-angle range the fit covers; outside it the renderer falls back to
 * Lambert for the spatial distribution and warns.
 */
export type SpatialPhotometricModel =
  | { kind: 'lambert'; validPhaseDeg?: [number, number] }
  | { kind: 'lommel-seeliger'; validPhaseDeg?: [number, number] }
  | { kind: 'lunar-lambert'; L: PhaseDependent; validPhaseDeg?: [number, number] }
  | { kind: 'minnaert'; k: PhaseDependent; validPhaseDeg?: [number, number] }
  | {
      kind: 'hapke';
      /** Single-scattering albedo. */
      w: number;
      /** Double Henyey–Greenstein asymmetry b (0..1) and backward/forward partition c (−1..1). */
      b: number;
      c: number;
      /** SHOE amplitude B_S0 and angular width h_S. */
      bs0: number;
      hs: number;
      /** CBOE amplitude B_C0 and width h_C (default 0: no CBOE). */
      bc0?: number;
      hc?: number;
      /** Mean slope angle θ̄ of the macroscopic roughness, degrees (0 = smooth). */
      thetaBarDeg: number;
      /** Porosity factor K (default 1). */
      K?: number;
      /** Approximation of Chandrasekhar's H function used by the fit: Hapke (2002) (default) or Hapke (1981). */
      hFunction?: 'hapke2002' | 'hapke1981';
      validPhaseDeg?: [number, number];
    };

export type PhaseFunction =
  | { kind: 'lambert' }
  /** Tabulated magnitude correction vs phase angle, from a published phase curve. Valid for alphaDeg[0] ≤ α ≤
   *  alphaDeg[last] (linear interpolation); the first node may be above 0 and deltaMag may be negative (an
   *  opposition surge above the albedo's surge-free reference). */
  | { kind: 'tabulated'; alphaDeg: number[]; deltaMag: number[] }
  /** Polynomial in phase angle (degrees) giving magnitude correction, e.g. Mallama & Hilton (2018). Valid in [minDeg, maxDeg]. */
  | { kind: 'poly-mag'; coeffs: number[]; minDeg: number; maxDeg: number };

/** smallbody-class-colors.json (light stage): estimated colours and albedo statistics for small bodies without a
 *  measured spectrum. An object's geometricAlbedoXYZS = p_V × xyzsPerUnitPV (lux at 1 AU, §4.3); using these makes
 *  the object's attribute `estimated`. See docs/sources/smallbody-class-colors.md. */
export interface SmallBodyClassColorsFile {
  definition: string;
  /** Bus-DeMeo classes (DeMeo et al. 2009). */
  classes: Record<string, SmallBodyClassEntry>;
  /** Coarse SDSS colour classes (Carvano et al. 2010): frequency and p_V statistics. */
  sdssClasses: Record<string, { meanSpectrumClass: string; frequency: number; numberedSingleLetter: number;
                                pV: PVStats | null }>;
  /** For objects of unknown class. */
  population: { colour: Sourced<{ xyzsPerUnitPV: [number, number, number, number] }>; pV: Sourced<PVStats> };
  /** Other schemes' class labels → the Bus-DeMeo class whose colour to use (assumed correspondences; `rule`). */
  aliases: { rule: string; bus: Record<string, string>; tholen: Record<string, string>; mahlke: Record<string, string> };
}

export interface SmallBodyClassEntry {
  colour: Sourced<{
    xyzsPerUnitPV: [number, number, number, number];
    /** The class reflectance spectrum used (normalized to 1 at 550 nm), to 900 nm. */
    spectrum: { wavelengthNm: number[]; reflectance: number[] };
    ultravioletFrom: string;
    ecasN: number;
    ecasWavelengthsNm: [number, number];
  }>;
  /** NEOWISE-fitted p_V of the class's classified asteroids; unknown when fewer than 3. */
  pV: Sourced<PVStats>;
}

export interface PVStats { median: number; p16: number; p84: number; n: number }

/** rings.json: planet NAIF id (as string) → ring system. Produced by the `light` stage. See docs/architecture.md §6. */
export type RingsFile = Record<string, RingSystem>;

export interface RingSystem {
  /** NAIF id of the planet. The ring plane is its equator (IAU pole from bodies.json); radii are planet-centred. */
  planet: number;
  /** Radial profiles of normal optical depth, each from one measured occultation cut. */
  opticalDepth: Sourced<RingProfile[]>;
  /** Ring I/F model for the lit and unlit faces (per CIE channel, any geometry in its domain), calibrated on the
   *  measurements below; `unknown` where no measurement exists. See docs/architecture.md §6. */
  reflectance: Sourced<RingReflectance>;
  /** The measured reflectance data the model is built on, each at its own observed geometry. */
  reflectanceMeasurements?: {
    radialProfiles: Sourced<RingIFProfile[]>;
    regionalPhaseCurves: Sourced<RingRegionalPhaseCurves>;
  };
}

export interface RingProfile {
  /** What the profile covers, as named by the source (e.g. "main rings", "ring system"). */
  name: string;
  /** Bin-centre radii, km, increasing (nominally uniform; spacing may vary by < 1 %). */
  radiusKm: number[];
  /** Normal optical depth τ⊥ per bin; null = not constrained. Without self-gravity wakes the slant optical depth
   *  along a ray at elevation B above the ring plane is τ⊥ / |sin B|. */
  normalTau: (number | null)[];
  /** Largest measurable τ⊥ per bin (values at or above it are lower limits), when the source provides it. */
  maxTau?: (number | null)[];
  /** Geometry of the occultation that produced the profile. */
  observation: {
    instrument: string;
    star: string;
    direction: string;
    /** UTC (as archived) of the first and last samples. */
    start: string;
    stop: string;
    wavelengthNm: [number, number];
    /** Elevation of the line of sight above the ring plane, degrees. */
    ringElevationDeg: number;
    ringLongitudeDeg?: [number, number];
    observedRingAzimuthDeg?: [number, number];
  };
}

/** A radial I/F profile of the rings measured at one geometry. */
export interface RingIFProfile {
  name: string;
  side: 'lit' | 'unlit';
  instrument: string;
  filter: string;
  /** Solar-weighted effective wavelength of the band. */
  effectiveWavelengthNm: number;
  start: string;
  phaseDeg: number;
  /** Elevation of the Sun above the ring plane, degrees. */
  solarElevationDeg: number;
  /** Elevation of the observer: positive on the Sun's side of the ring plane, negative on the unlit side. */
  observerElevationDeg: number;
  /** Uniform radial grid: radius of sample i = radiusStartKm + i·radiusStepKm, i < count. */
  radiusStartKm: number;
  radiusStepKm: number;
  count: number;
  iOverF: (number | null)[];
}

/** Lit-face phase curves of ring regions: geometrically corrected I/F = a ln α + b (α in degrees). */
export interface RingRegionalPhaseCurves {
  definition: string;
  minPhaseDeg: number;
  maxPhaseDeg: number;
  filters: { name: string; effectiveWavelengthNm: number }[];
  /** Effective elevations Beff (sin Beff = 2μμ0/(μ+μ0)), degrees. */
  elevationEffDeg: number[];
  /** a[e][f], b[e][f] for elevationEffDeg[e] and filters[f]. */
  regions: { name: string; radiusKm: [number, number]; a: number[][]; b: number[][] }[];
}

/** Ring reflectance model. `formula` states how to evaluate I/F per channel; all arrays are on the uniform radial
 *  grid radiusStartKm + i·radiusStepKm (i < count); null = not modelled there. */
export interface RingReflectance {
  kind: 'single-scattering-v1';
  formula: string;
  radiusStartKm: number;
  radiusStepKm: number;
  count: number;
  normalTau: (number | null)[];
  /** Radial modulation of the particle reflectance (about 1 on average in each calibrated region). */
  litModulation: (number | null)[];
  /** Effective optical depth and gain for light diffusely transmitted to the unlit face. */
  unlitTau: (number | null)[];
  unlitGain: (number | null)[];
  /** Grids of the amplitude tables (degrees); the model is defined for minPhaseDeg ≤ α ≤ maxPhaseDeg. */
  phaseDeg: number[];
  elevationEffDeg: number[];
  minPhaseDeg: number;
  maxPhaseDeg: number;
  regions: {
    name: string;
    radiusKm: [number, number];
    centerKm: number;
    /** Exponent n of the power-law particle phase function (π − α)^n used between the calibrated phase ranges. */
    powerLawExponent: number;
    /** ϖP (particle albedo × phase function) per CIE channel X, Y, Z, scotopic: amplitudeXYZS[e][p][c] for
     *  elevationEffDeg[e], phaseDeg[p]. */
    amplitudeXYZS: number[][][];
  }[];
}

export interface SunData {
  /** Solar irradiance at 1 AU integrated against the CIE observers: X, Y (lux), Z, scotopic lux. */
  irradianceXYZS_1AU: Sourced<[number, number, number, number]>;
  /** Photospheric radius used for the disk, km. */
  radius: Sourced<number>;
  /** Limb darkening: I(mu)/I(1) as polynomial coefficients in mu, per channel if available. */
  limbDarkening: Sourced<{ kind: 'poly-mu'; coeffsXYZS: number[][] }>;
}

export interface LightData {
  sun: SunData;
  cie: { photopicKm: number; scotopicKm: number; sources: string[] };
}

/** Binary table header shared by star catalogs and later small-body catalogs. */
export interface BinaryField {
  name: string;
  type: 'f32' | 'f64' | 'u32' | 'u16' | 'u8' | 'i32';
  count: number;
  /** Byte offset within one record. */
  offset: number;
}

export interface BinaryTableHeader {
  bin: string;
  count: number;
  stride: number;
  fields: BinaryField[];
  /** For u8 label fields: which label index maps to which Label. */
  labelEncoding?: Label[];
  /** Source ids referenced by index from source-index fields. */
  sourceTable?: string[];
  notes?: string;
  /** Epoch of time-dependent fields (e.g. star directions), TDB seconds past J2000. */
  epochEt?: number;
  /**
   * Per-record provenance routes. A u8 field `<kind>Route` (e.g. posRoute, lightRoute) indexes routes[kind];
   * each route states the label, all SourceRecord ids and the method that produced that record's values.
   */
  routes?: Record<string, BinaryRoute[]>;
  /** How catalogue-id fields are to be read, keyed by sourceTable id. */
  idEncoding?: Record<string, string>;
  /** Meaning of the bits of a u8 `flags` field, keyed by bit value ("1", "2", "4", ...). */
  flagBits?: Record<string, string>;
  /** Free-form completeness statement of a catalogue product. */
  completeness?: Record<string, unknown>;
}

export interface BinaryRoute {
  label: Label;
  sources: string[];
  method: string;
}

// ------------------------------------------------------------------------------------------ surface maps (§4.4)
// Written by the pipeline's `surfaces` stage: surfaces/<naifId>/<layer>.json next to the tile pyramid.

/** Provenance of one aspect of a surface layer (its brightness pattern or its colour). */
export interface SurfaceProvenance {
  label: Label;
  sources: string[];
  method: string;
  uncertainty?: string;
}

/** A lat/lon box of a layer that comes from a particular source with its own provenance (e.g. polar caps). */
export interface SurfaceRegion {
  latMin: number;
  latMax: number;
  /** East longitude, degrees, −180..180. */
  lonMin: number;
  lonMax: number;
  brightness: SurfaceProvenance;
  color?: SurfaceProvenance;
  note?: string;
}

export interface SurfaceLevelInfo {
  level: number;
  /** Texels: width = 512·2^level, height = 256·2^level. */
  width: number;
  height: number;
  tilesX: number;
  tilesY: number;
  /** Texel size in degrees (same in latitude and longitude). */
  texelDeg: number;
}

/**
 * 'relative-reflectance': XYZS normal reflectance relative to its disk mean (albedo layers).
 * 'height': metres above the reference ellipsoid. 'photometric-parameters': model constants per texel.
 * Earth only (all dated, float16 with NaN = unknown per channel):
 * 'cloud-properties': [cloudFraction, opticalThickness, cloudTopHeightM, iceFraction] of one day's daytime overpass;
 * 'emitted-radiance': [dnbRadiance (nW cm⁻² sr⁻¹), censoredFraction]; `constants.toXYZS` converts to luminance;
 * 'surface-water': [waterFraction, seaIceFraction] (where the renderer adds Fresnel reflection and glint);
 * 'surface-wind': [windSpeed10mAscending, windSpeed10mDailyMean, passes] in m/s at 10 m (for the Cox & Munk glint
 * slope variance; `constants.coxMunk` states the formula and the 12.5 m vs 10 m height note).
 */
export type SurfaceLayerKind =
  | 'relative-reflectance'
  | 'height'
  | 'photometric-parameters'
  | 'cloud-properties'
  | 'emitted-radiance'
  | 'surface-water'
  | 'surface-wind';

export interface SurfaceLayerHeader {
  body: number;
  bodyName: string;
  /** 'albedo' | 'height' | other layer names (e.g. 'hapke'). */
  layer: string;
  kind: SurfaceLayerKind;
  /** Per-channel element type of the raw little-endian tiles. */
  format: 'float16' | 'float32';
  /** Channel names, interleaved per texel: ['X','Y','Z','S'] for albedo, ['height'] for height. */
  channels: string[];
  bytesPerTexel: number;
  tileSize: 256;
  minLevel: number;
  maxLevel: number;
  levels: SurfaceLevelInfo[];
  /** Template relative to the data root, placeholders {level}, {ty}, {tx}. */
  tilePath: string;
  /** Path of the "sha256  path" listing of every stored tile. */
  tileListing: string;
  /** How the coarser levels were built from the top level (layers built before this field: mean of known texels). */
  coarseLevels?: string;
  /** level (as string) → [tx, ty][] of tiles that are entirely unknown and therefore not stored. */
  missingTiles: Record<string, [number, number][]>;
  /**
   * How unknown texels are encoded: float16 reflectance/height layers use all channels exactly 0; float32 layers
   * and the Earth cloud/night/water layers use NaN per channel (the text says which).
   */
  noData: string;
  geometry: {
    projection: 'equirectangular';
    latitude: 'planetocentric';
    longitude: 'east';
    u: string;
    v: string;
    texelValue: string;
  };
  /** Body-fixed frame of the source maps and how it relates to the app's IAU frame. */
  frame: {
    name: string;
    note?: string;
    longitudeSystem?: string;
    sourceLatitude?: string;
    referenceRadiusKm?: number;
    referenceEllipsoidKm?: number[];
  };
  coverage: {
    /** Fraction of the sphere's area with data (top level). */
    areaFraction: number;
    /** Fraction of the rotation-averaged zero-phase disk weight (cos²φ) with data. */
    diskWeightFraction: number;
    regions: SurfaceRegion[];
  };
  /**
   * Provenance of the layer's values, worst over regions: for albedo layers the spatial brightness pattern, for
   * height and parameter layers the heights / parameters themselves.
   */
  brightness: SurfaceProvenance;
  /** Provenance of the per-texel colour variation (albedo layers only). */
  color?: SurfaceProvenance;
  sources: string[];
  /** Observation epoch; maps of changing surfaces carry start/end (ISO UTC) and how the surface changes. */
  epoch?: {
    start?: string;
    end?: string;
    mid?: string;
    observed?: string;
    changes?: string;
    perFilter?: Record<string, { start: string; end: string }>;
  };
  /**
   * Albedo layers: how the texels were normalized so that the cos²φ-weighted disk average is 1 per channel
   * (band disk means before normalization, band → XYZS weights W (texel = W·bandRatios), achieved disk mean).
   */
  normalization?: {
    weighting: string;
    texelDiskMeanCheck: number[];
    channelWeights?: { bandsNm: number[]; W: number[][] } | Record<string, { bandsNm: number[]; W: number[][] }>;
    /**
     * Earth: absolute surface reflectance = texel × absoluteDiskMean[channel]. Earth's disk photometry includes
     * clouds and atmosphere, so it must not be used to scale Earth's surface map.
     */
    absoluteDiskMean?: Record<'X' | 'Y' | 'Z' | 'S', number>;
    [k: string]: unknown;
  };
  /** Height layers: 'm' (above the pck00011 reference ellipsoid named in `frame`). */
  units?: string;
  /** Parameter layers: model constants and the model definition. */
  constants?: Record<string, unknown>;
  diagnostics?: Record<string, unknown>;
  notes?: string[];
  generated: string;
  stats: { tiles: number; bytes: number };
}

/** surfaces/index.json */
export interface SurfaceIndex {
  bodies: Record<string, { name: string; layers: Record<string, string> }>;
  /** NAIF id → why the body deliberately has no visible-light surface map (e.g. Venus, Titan). */
  excluded: Record<string, string>;
  /** NAIF id → why a candidate map failed a check (the body is rendered from photometry only). */
  rejected?: Record<string, string>;
  /** Builder module → wall-clock seconds of the last build. */
  buildSeconds?: Record<string, number>;
  notes?: string;
}

// ---------------------------------------------------------------------------------------------- small bodies
// Products of the `smallbodies` stage (app/public/data/smallbodies/). Each table is a BinaryTableHeader plus
// per-column documentation; the core header also carries the force model the propagator must use
// (app/src/core/smallbody.ts). Source-index fields hold 255 when there is no source (label unknown).

/** Documentation of one binary column: its unit, the fields holding its label and source index, and how it was made. */
export interface BinaryColumnDoc {
  unit?: string;
  /** Name of the u8 field holding this column's provenance label. */
  label?: string;
  /** Name of the u8 field holding this column's index into sourceTable. */
  source?: string;
  method?: string;
}

export interface SmallBodyTableHeader extends BinaryTableHeader {
  columns?: Record<string, BinaryColumnDoc>;
}

/** Force model and integrator settings (written by pipeline/src/pipeline/sb_model.py). */
export interface SmallBodyForceModel {
  frame: string;
  sun: { naifId: number; gm: number; radius: number; sources: string[] };
  perturbers: { name: string; naifId: number; gm: number; radius: number }[];
  perturberSources: string[];
  /** Ephemeris product that serves the perturbers, e.g. "ephem/de442s". */
  ephemeris: string;
  indirect: string;
  zonal: { perturber: number | null; j2: number; referenceRadiusKm: number; poleIcrf: [number, number, number]; source: string; model: string };
  relativity: { model: string; enabled: boolean; cKmS: number };
  nonGravitational: string;
  scheme: { name: string; drift: number[]; kick: number[]; order: string };
  grid: { baseStepS: number; rule: string };
  stepControl: {
    etaSun: number;
    etaPlanet: number;
    etaEncounter: number;
    kmax: number;
    encounterRatio: number;
    rule: string;
    encounter: string;
  };
  obliquityArcsec: number;
  kepler: string;
}

/** smallbodies/core.json: one record per asteroid/comet (state at epochEt, H, G, flags, labels). */
export interface SmallBodyCoreHeader extends SmallBodyTableHeader {
  /** Common epoch of every state and origin of the integration grid, TDB s past J2000. */
  epochEt: number;
  epochTdb: string;
  window: { startEt: number; endEt: number };
  forceModel: SmallBodyForceModel;
  orbitClasses: { code: string; name: string }[];
  /** Meaning of each bit of the u16 `flags` field, keyed by bit value ("1", "2", "4", ...), as BinaryTableHeader. */
  flagBits: Record<string, string>;
  /** Population statistic behind estimated diameters: measured p_V per SBDB orbit class ("*" = all). */
  classAlbedo: Record<string, { median: number; p16: number; p84: number; n: number }>;
  /**
   * Estimated colour of every asteroid without a measured spectrum: core field colorClass indexes `classes`
   * (Bus-DeMeo class mean colours from smallbody-class-colors.json, then 'population'); 255 = comet.
   */
  colorClasses?: {
    method: string;
    sources: string[];
    classes: { name: string; xyzsPerUnitPV: [number, number, number, number]; pVMedian: number | null }[];
    counts?: Record<string, number>;
    physicalFilled?: number;
  };
  statistics: Record<string, unknown>;
  snapshot: string;
  names: string;
  physical: string;
  comets: string;
  nongrav: string;
}

export interface SmallBodyPhysicalHeader extends SmallBodyTableHeader {
  /** LCDB reliability code per rotQuality index ('' = not from the LCDB). */
  lcdbU: string[];
  taxonomyB: string[];
  taxonomyT: string[];
  /** Filter of each H-G1-G2 fit (physical.phaseFilter index), e.g. 'V' = MPC-archive V photometry. */
  phaseFilters?: string[];
  phaseFacilities?: string[];
  spinTechniques?: string[];
  /** SsODNet best taxonomy per physical.taxonomyBft index: 'scheme|class|technique'. */
  taxonomySsodnet?: string[];
}

/** smallbodies/names.json: line i of `file` describes core record i. */
export interface SmallBodyNamesHeader {
  file: string;
  count: number;
  encoding: 'utf-8';
  separator: string;
  lineSeparator: string;
  columns: string[];
  sources: string[];
  notes?: string;
}

/** One H-G1-G2 basis function (sbpy's clamped cubic spline, linear beyond the end nodes, clipped at 0). */
export interface PhaseBasisSpline {
  nodesRad: number[];
  values: number[];
  endDerivatives: [number, number];
  /** Per interval i: [A0, A1, A2, A3] of sum A_k (alpha - nodesRad[i])^k. */
  coefficients: number[][];
}

/** smallbodies/photometry.json (pipeline stage sbphotometry): turning small-body magnitudes into light. */
export interface SmallBodyPhotometry {
  vSun: Sourced<number>;
  sunIrradianceXYZS1AU: Sourced<[number, number, number, number]>;
  hg: { A: [number, number]; B: [number, number]; C: [number, number]; W: number; smallPhase: [number, number, number]; form: string; sources: string[]; note?: string };
  hg1g2: { phi1: PhaseBasisSpline; phi2: PhaseBasisSpline; phi3: PhaseBasisSpline; sources: string[]; form: string };
  colour: {
    definition: string;
    shapeDerivedRule: string;
    shapeDerived: number;
    withSpectrum: number;
    yOverV: Record<string, number | string>;
    estimatedColour: string;
  };
  comets: { method: string; label: Label };
  rules: Record<string, string>;
}

/**
 * A star tier split into HEALPix tiles (stars/deep.json): every tile file holds records with the header's fields
 * and stride, sorted brightest first (by Y), so reading a prefix of a tile loads it to a magnitude limit.
 */
export interface TiledBinaryTableHeader extends Omit<BinaryTableHeader, 'bin'> {
  /** Tile file name pattern, e.g. "deep-o3-{pix:03d}.bin" (next to the header). */
  binPattern: string;
  tiling: {
    scheme: 'HEALPix';
    ordering: 'NESTED';
    order: number;
    nside: number;
    frame: 'ICRS';
    assignment: string;
    sort: string;
    /** Y thresholds (lux) for StarTile.prefixCounts. */
    prefixY: number[];
    prefixNote: string;
  };
  tiles: StarTile[];
  tier: { name: string; gaiaGMin: number; gaiaGMax: number; brighterTier: string };
}

export interface StarTile {
  pix: number;
  bin: string;
  count: number;
  /** ICRF unit vector of the HEALPix pixel centre. */
  center: [number, number, number];
  /** Every record of the tile lies within this angle of `center` (degrees). */
  radiusDeg: number;
  yMax: number | null;
  yMin: number | null;
  /** Number of leading records with Y >= tiling.prefixY[k]. */
  prefixCounts: number[];
}

/** One all-sky HEALPix map of radiance (sky/diffuse.json layers). */
export interface HealpixMapLayer {
  bin: string;
  scheme: 'HEALPix';
  ordering: 'NESTED';
  order: number;
  nside: number;
  npix: number;
  frame: 'ICRS';
  /** Channel order within a pixel, e.g. ["X", "Y", "Z", "S"]. */
  channels: string[];
  dtype: 'f32';
  /** e.g. "pixel-major: value[pix * 4 + channel]". */
  layout: string;
  unit: string;
  label: Label;
  sources: string[];
  method: string;
  /** Effective angular resolution (FWHM, degrees) when coarser than the pixels; null = pixel size. */
  resolutionFwhmDeg: number | null;
  uncertainty: string;
  /** Optional per-pixel u8 method codes (labelCodes explains them). */
  labelBin?: string;
  labelCodes?: Record<string, string>;
  pixelSolidAngleSr?: number;
  stats?: Record<string, unknown>;
}

export interface SkyMapsFile {
  kind: 'skyMaps';
  version: number;
  layers: Record<string, HealpixMapLayer>;
  composition: string;
  bands: Record<string, { centerNm: number; widthNm: number }>;
}

/** sky/zodiacal.json: measured zodiacal light at 1 AU plus a 3-D dust model for other observer positions. */
export interface ZodiacalLightModel {
  kind: 'zodiacalLightModel';
  version: number;
  frame: string;
  at1AU: Sourced<{
    dlamDeg: number[];
    betaDeg: number[];
    /** s10[i][j] in S10sun at 500 nm; null = not tabulated. */
    s10: (number | null)[][];
    axes: string;
    eclipticPoleS10: number;
  }>;
  s10ToXYZS: Sourced<{ eps30: number[]; eps90: number[]; solarColour: number[]; use: string }>;
  cloud: Sourced<{
    model: string;
    components: Record<string, unknown>;
    equations: Record<string, string>;
    rOutAU: number;
    densityUnit: string;
  }>;
  scattering: Sourced<{
    phaseFunction: string;
    C0: number;
    C1: number;
    C2: number;
    N: number;
    albedo: number;
    brightness: string;
    perSolarFluxPerSr: { eps30: number[]; eps90: number[] };
  }>;
  notes: string;
}
