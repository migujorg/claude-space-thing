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
  /** Pipeline bookkeeping for resumable builds (pipeline/build.py): stage name → last run (built / failed). */
  stages?: Record<string, { status: 'built' | 'failed'; finishedAt?: string; error?: string; profile?: string | null }>;
  /** The last build: its profile and, per stage, what happened and why (e.g. "not in profile minimal"). */
  build?: {
    profile: string | null;
    startedAt: string;
    finishedAt: string;
    stages: Record<string, { status: string; reason: string }>;
  };
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

/**
 * 'small-body': asteroids and comets of the smallbodies/* products. bodies.json never contains it; the app makes
 * a Body of this kind for a selected catalogue object (app/src/app/smallbodies.ts).
 */
export type BodyKind = 'star' | 'planet' | 'dwarf-planet' | 'moon' | 'barycenter' | 'small-body';

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
   *  waxing/waning asymmetry; the Galilean moons: their measured rotational variation). Inside its domain it gives
   *  the disk-integrated illuminance directly, in place of geometricAlbedoXYZS · Φ(α); see docs/architecture.md
   *  §4.3. */
  diskReflectanceModel?: Sourced<DiskReflectanceModel>;
}

export type DiskReflectanceModel = RoloDiskModel | RotationSlicesDiskModel;

/**
 * Disk-integrated brightness with a rotational (orbital-longitude) variation, kind 'rotation-slices-v1' (the
 * Galilean moons: Mayorga et al. 2020 Table 4). p·Φ = albedoXYZS · Φ(α) · F, with
 *   F = Σ_j a_j G_j(λ_obs, λ_sun) / Σ_j G_j(λ_obs, λ_sun),
 * a_j the albedo of longitude slice j relative to the slices' mean, λ_obs and λ_sun the planetocentric east
 * longitudes of the sub-observer and sub-solar points, and G_j the Lambertian orange-slice integral over the part of
 * slice j that is both lit and visible (the equator's view; `formula` gives it). Rotation-averaged, F = 1, so the
 * model keeps geometricAlbedoXYZS and phaseFunction as the longitude average. Domain: Φ(α) tabulated at α.
 */
export interface RotationSlicesDiskModel {
  kind: 'rotation-slices-v1';
  formula: string;
  /** The body's geometricAlbedoXYZS ("lux at 1 AU", referenced to radiusKm) and phaseFunction values. */
  albedoXYZS: [number, number, number, number];
  phase: PhaseFunction;
  radiusKm: number;
  /** Slice boundaries in planetocentric east longitude, degrees, ascending from −180 to 180 (n + 1 values). */
  sliceEdgesEastLonDeg: number[];
  /** Albedo of each slice relative to the mean of the slices (n values, mean 1). */
  relativeAlbedo: number[];
}

/** Whole-disk reflectance A_c per channel (X, Y, Z, scotopic) vs viewing geometry, in the form of Kieffer & Stone
 *  (2005) Eq. 10. Illuminance at the observer E_c = A_c · E☉,c(1 AU)/d² · (radiusKm/Δ)². `formula` gives the
 *  expression and the units (radians in the polynomial terms, degrees elsewhere). */
export interface RoloDiskModel {
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
 *  - akimov:           the parameter-free Akimov disk function D(i, e, g) (Shkuratov et al. 1999; the form of
 *                      Filacchione et al. 2022, arXiv:2111.15541, §4 Eqs. 4–6), D = 1 at g = 0
 *  - barkstrom:        r ∝ (1/μ)·(μ0μ/(μ0 + μ))^B          (Barkstrom 1973; B = 1 is Lommel–Seeliger)
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
  | { kind: 'akimov'; validPhaseDeg?: [number, number] }
  | { kind: 'barkstrom'; B: PhaseDependent; validPhaseDeg?: [number, number] }
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

/** atmospheres.json (light stage): per body, optical properties for physically based sky/limb rendering
 *  (multiple scattering). Wavelengths are standard-air nm (as the CIE tables); spectral arrays have one entry per
 *  `wavelengthsNm`. See docs/architecture.md §6 and docs/reports/atmospheres.md. */
export interface AtmosphereFile {
  definition: string;
  /** Spectral samples, 360–830 nm every 10 nm. */
  wavelengthsNm: number[];
  channels: ['X', 'Y', 'Z', 'S'];
  /** W[c][k]: fold a spectral ratio f_k sampled at wavelengthsNm into channel c as Σ_k W[c][k] f_k (sunlight ×
   *  observer weights with the piecewise-linear basis; rows sum to 1), then × the Sun's XYZS from light.json. */
  foldWeights: Sourced<number[][]>;
  /** NAIF id (string) → body. */
  bodies: Record<string, BodyAtmosphere>;
}

export interface BodyAtmosphere {
  name: string;
  naifId: number;
  /** Radius of altitude 0 (km): pck00011 volumetric mean radius. */
  referenceRadiusKm: number;
  altitudeReference: string;
  /** Altitude grid (km above the reference sphere) of every component's profile; empty when none. */
  altitudesKm: number[];
  /** Top of the tabulated atmosphere (km), and referenceRadiusKm + topAltitudeKm; null when no profile. */
  topAltitudeKm: number | null;
  topRadiusKm: number | null;
  scaleHeightKm: Sourced<number>;
  surfacePressurePa?: Sourced<number>;
  /** kg/kmol */
  meanMolecularWeight?: Sourced<number>;
  components: AtmosphereComponent[];
  /** Known contributors that are not included. */
  omitted?: string;
  /** Mars: seasonal column dust and L_s over the build window (scale the 'dust' component by
   *  opticalDepth610Pa(L_s, latitude) / annualGlobalMean610Pa). */
  dustColumn?: Sourced<{ lsDeg: number[]; latitudeDeg: number[]; opticalDepth610Pa: number[][];
                         globalMean610Pa: number[]; annualGlobalMean610Pa: number; referencePressurePa: number;
                         wavelengthNm: number }>;
  solarLongitude?: Sourced<{ et: number[]; lsDeg: number[] }>;
  /** Venus: altitude of optical depth 1 (km). */
  cloudTopAltitudeKm?: Sourced<number>;
  /** Pluto: measured haze I/F versus phase angle. */
  hazeMeasurements?: Sourced<{ phaseDeg: number[]; peakIoverF: number[]; IoverFat45km: number[];
                               wavelengthNm: number }>;
  /** Titan: Lambert reflectance of the surface below the atmosphere, at wavelengthsNm, and its X, Y, Z, S
   *  (sunlight × observer weighted) equivalents. A body with it is drawn from its atmosphere alone (no disk
   *  photometry renormalization; docs/rendering-earth.md §8 "Titan"). */
  surfaceReflectance?: Sourced<{ wavelengthsNm: number[]; reflectance: number[];
                                 channelEquivalents: [number, number, number, number] }>;
  /** Giant planets: near the 1 bar level. */
  temperatureAt1barK?: Sourced<number>;
  densityAt1barKgM3?: Sourced<number>;
  limbHaze?: Sourced<never>;
}

export interface AtmosphereComponent {
  /** 'rayleigh' | 'ozone' | 'aerosol' | 'dust' | 'haze' | 'cloud' */
  id: string;
  description: string;
  /** β_ext (km⁻¹) [altitude index][wavelength index], linear in altitude between levels. */
  extinctionPerKm: Sourced<number[][]>;
  /** ω per wavelength (scattering coefficient = ω β); 0 for a pure absorber; `unknown` must not be rendered as
   *  known. */
  singleScatteringAlbedo: Sourced<number[]>;
  phaseFunction: Sourced<AtmospherePhaseFunction>;
  /** X, Y, Z, S equivalents: extinction per altitude, and column-weighted SSA and asymmetry (optically thin). */
  channelEquivalents: Sourced<{ extinctionPerKm: [number, number, number, number][];
                                singleScatteringAlbedo: [number, number, number, number] | null;
                                asymmetry: [number, number, number, number] | null }>;
  /** Vertical optical depth from altitude 0 to the top, per wavelength (a convenience). */
  columnOpticalDepth: number[];
  /** Molecular components: extinctionPerKm = 1e3 × numberDensityPerM3[altitude] × crossSectionM2[wavelength]. */
  separable?: Sourced<{ numberDensityPerM3: number[]; crossSectionM2: number[] }>;
  /** Asymmetry parameter per wavelength, for reference where the phase function is tabulated or fixed. */
  asymmetry?: Sourced<number[]>;
  /** Titan 'methane': the measured mole-fraction profile (altitude km, mole fraction). */
  methaneMoleFraction?: Sourced<{ altitudeKm: number[]; moleFraction: number[] }>;
  /** Titan 'methane': the absorption coefficient at 1 nm resolution (per km-amagat), for renderers that resolve
   *  the bands (extinctionPerKm holds 10 nm box averages). */
  absorptionCoefficient?: Sourced<{ wavelengthNm: number[]; perKmAmagat: number[] }>;
}

/** All normalized to a mean of 1 over the sphere (∫P dΩ = 4π); Θ is the scattering angle. */
export type AtmospherePhaseFunction =
  /** P = 3[(1+ρ) + (1−ρ)cos²Θ]/(4+2ρ), ρ per wavelength. */
  | { kind: 'rayleigh'; depolarization: number[] }
  /** P = (1−g²)/(1+g²−2g cosΘ)^{3/2}, g per wavelength. */
  | { kind: 'henyey-greenstein'; g: number[] }
  /** α·HG(g1) + (1−α)·HG(g2), per wavelength. */
  | { kind: 'double-henyey-greenstein'; g1: number[]; g2: number[]; alpha: number[] }
  /** values[wavelength][angle] at anglesDeg (interpolate linearly in angle). */
  | { kind: 'tabulated'; anglesDeg: number[]; values: number[][] }
  /** Pure absorber. */
  | { kind: 'none' };

/** rings.json: planet NAIF id (as string) → ring system. Produced by the `light` stage. See docs/architecture.md §6. */
export type RingsFile = Record<string, RingSystem>;

export interface RingSystem {
  /** NAIF id of the planet. The ring plane is its equator (IAU pole from bodies.json); radii are planet-centred. */
  planet: number;
  /** Radial profiles of normal optical depth, each from one measured occultation cut. */
  opticalDepth: Sourced<RingProfile[]>;
  /** Optional reconstructed optical depth, with its own provenance. Preferred when its label is admitted;
   * otherwise opticalDepth supplies the unchanged archive measurement (Saturn at Strict). */
  opticalDepthEstimate?: Sourced<RingProfile[]>;
  /** Ring I/F model for the lit and unlit faces (per CIE channel, any geometry in its domain), calibrated on the
   *  measurements below; `unknown` where no measurement exists. See docs/architecture.md §6. */
  reflectance: Sourced<RingReflectance>;
  /** The measured reflectance data the model is built on, each at its own observed geometry. */
  reflectanceMeasurements?: {
    radialProfiles: Sourced<RingIFProfile[]>;
    regionalPhaseCurves: Sourced<RingRegionalPhaseCurves>;
  };
  /**
   * Rings drawn one by one (Jupiter, Uranus, Neptune; docs/architecture.md §6 "Ring components"): eccentric,
   * inclined and precessing narrow rings, arcs, dusty sheets and vertically extended tori, each with its own
   * optical depth and light. When present and admitted it replaces `opticalDepth` for drawing; the label is the
   * worst of its components' geometry, optical-depth and reflectance labels.
   */
  components?: Sourced<RingComponentModel>;
}

/** One edge of a ring component: a precessing, inclined keplerian ellipse with normal modes (French et al. 2024). */
export interface RingComponentEdge {
  /** Semimajor axis and a·e, km. */
  a: number;
  ae: number;
  /** Longitude of periapse at the model epoch (degrees) and apsidal precession rate (degrees/day). */
  varpi0Deg: number;
  varpiDotDegPerDay: number;
  /** Height amplitude a·sin i (km), node at epoch (degrees) and nodal rate (degrees/day). */
  aSinI: number;
  node0Deg: number;
  nodeDotDegPerDay: number;
  /** Δr = −A cos(m(λ − Ω_P t − δ)); for m = 0, −A cos(Ω_P t + δ) (t in days from the epoch). */
  modes: { m: number; amplitudeKm: number; phaseDeg: number; patternSpeedDegPerDay: number }[];
}

export interface RingComponentProvenance {
  /** Canonical Sourced payload; absent only in products built before the envelope migration. */
  value?: Record<string, unknown> | null;
  label: Label;
  sources: string[];
  method: string;
}

/** A tabulated phase function per CIE channel (X, Y, Z, scotopic), interpolated log-linearly in α. */
export interface RingPhaseTable {
  /** Canonical Sourced payload. Flat fields below mirror it for existing renderer consumers. */
  value?: {
    name: string; phaseDeg: number[]; valuesXYZS: number[][]; minPhaseDeg: number; maxPhaseDeg: number;
  } | null;
  name: string;
  phaseDeg: number[];
  valuesXYZS: number[][];
  /** Outside [minPhaseDeg, maxPhaseDeg] this light is not measured (drawn as unknown). */
  minPhaseDeg: number;
  maxPhaseDeg: number;
  label: Label;
  sources: string[];
  method: string;
}

export interface RingComponent {
  id: string;
  name: string;
  /** 'sheet': a thin layer in the ring's plane; 'torus': spread vertically by `vertical`. */
  kind: 'sheet' | 'torus';
  inner: RingComponentEdge;
  outer: RingComponentEdge;
  /** Inclusive support interval, TDB s past J2000. Outside it this geometry is unknown, with zero light/extinction.
   * basis distinguishes source-stated validity from a pipeline observation-support policy. Omitted for stationary
   * estimated profiles whose source states no temporal interval; their epoch/assumption remains in provenance. */
  geometryValidity?: { startEt: number; endEt: number; basis: string };
  /** Alternative component admitted only at Best/Complete and only outside geometryValidity. */
  outsideSupportEstimate?: Sourced<RingComponent>;
  /** Explicit ellipse-and-mean-width estimate; static m=0 boundary offsets are not observed modes. */
  centrelineEstimate?: {
    centreline: RingComponentEdge;
    meanWidthKm: number;
    lastDatumEt: number;
    lastDatumTdb: string;
    /** Days per Julian year, supplied by the pipeline for elapsed-year annotation. */
    yearDays: number;
  };
  /**
   * Values at u = uStart + i·uStep across the band (u = (r − r_in)/(r_out − r_in)): the normal optical depth where the
   * band is widthRefKm wide (scaled by widthRefKm/W elsewhere when widthScaling), or, when !opticalDepthKnown, the
   * normal I/F at the thin term's reference phase (light only, no extinction).
   */
  profile: { uStart: number; uStep: number; values: number[]; widthRefKm: number; widthScaling: boolean; opticalDepthKnown: boolean };
  /** Macroscopic particles (many-particle-thick layer): L_c(α) = scale · table(α). */
  layer: { phaseFunction: string; scale: number } | null;
  /** Optically thin dust: D_c(α) = scale · table(α), normal I/F = D·τ/4. */
  thin: { phaseFunction: string; scale: number } | null;
  /** Longitudinal modulation of τ (Neptune's arcs): factor(φ), φ = λ − λ0 − n (et − epochEt)/86400. */
  arcs?: { lambda0Deg: number; epochEt: number; meanMotionDegPerDay: number; phiStartDeg: number; phiStepDeg: number; factor: number[] };
  /** Vertical structure of a torus: density per unit height at radius r (normalized to ∫ dz = 1). */
  vertical?:
    | { law: 'inclined-orbits'; r0Km: number; z0Km: number; zMaxCapKm?: number }
    | {
      law: 'broken-power-law'; zBreakKm: number; zMaxKm: number; innerSlope: number; outerSlope: number;
      /** Heights (zBreak, zMax) at the outer edge relative to the inner edge, linear in radius between (default 1). */
      outerScale?: number;
    };
  provenance: { geometry: RingComponentProvenance; opticalDepth: RingComponentProvenance; reflectance: RingComponentProvenance };
}

export interface RingComponentModel {
  kind: 'ring-components-v1';
  formula: string;
  /** Epoch of the edge elements, TDB seconds past J2000. */
  epochEt: number;
  longitudeOrigin: string;
  /** +1 when the planet's angular momentum points along its IAU north pole, −1 when opposite (Uranus). */
  poleSense?: 1 | -1;
  phaseFunctions: Record<string, RingPhaseTable>;
  components: RingComponent[];
  notes: string;
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
 * 'cloud-properties' (layer 'clouds'): [cloudFraction, opticalThickness, cloudTopHeightM, iceFraction] of a mosaic of
 * one UTC day's 13:30 local hours (`epoch.mosaic`: 15° strips one hour apart, a 24-hour cut at 150° W); cloudFraction
 * counts every cloud class of the source, opticalThickness and iceFraction are of the cloud with a measured thickness;
 * 'cloud-optical-thickness-moments' (the same cells): [tauRetrievedFraction, lnTauMoment1, lnTauMoment2,
 * iceTauFraction], area-weighted sums (exact at every level): meanLnTau = m1 / f, varLnTau = m2 / f − meanLnTau²,
 * ice share = iceTauFraction / f. Two layers of this kind: 'cloudTau' holds the cloud whose thickness was retrieved
 * from sunlight (label derived; Strict), 'cloudTauEstimated' that cloud together with the cloud whose thickness is
 * the provider's estimate (label estimated; bound in its place at Best and Complete, app/extras.ts;
 * `constants.geometricTest` says which cells). cloudFraction − f of the layer in use is cloud of unmeasured
 * thickness at that level: drawn as not measured, never given a statistic;
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
  | 'cloud-optical-thickness-moments'
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
  /** Highest level stored (the source's own maximum unless a build level cap applied, see levelCap). */
  maxLevel: number;
  levels: SurfaceLevelInfo[];
  /**
   * Present only when a build profile capped the pyramid (pipeline parameter surfaces.maxLevel): the source supports
   * levels up to sourceMaxLevel, but only minLevel..maxLevel were written (identical to an uncapped build's).
   */
  levelCap?: { sourceMaxLevel: number; note: string };
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
    /** Earliest and latest observation of the layer's samples (ISO UTC), where the layer is a mosaic of moments. */
    observedSpan?: { earliest: string; latest: string };
    /**
     * Earth's cloud layers: a mosaic of moments, not one. Each longitude comes from the hourly file nearest
     * `localSolarHour` of one UTC day: strips `stripWidthDeg` wide, hard cuts `hoursBetweenNeighbourStrips` apart,
     * and a cut of `dayCut.hours` at `dayCut.lonDeg`. Per strip: the file's UTC hour, its longitudes, the satellites
     * with their cell counts and observation times (seconds from the file's nominal hour) and the cells per class.
     */
    mosaic?: {
      what: string;
      localSolarHour: number;
      stripWidthDeg: number;
      hoursBetweenNeighbourStrips: number;
      dayCut: { lonDeg: number; hours: number; what: string };
      cuts: string;
      strips: { fileHourUtc: number; lonWest: number; lonEast: number; referenceTime: string;
        sources: Record<string, { cells: number; secondsFromNominal: [number, number] | null }>; cells: Record<string, number> }[];
      secondsFromNominalHour: { geostationary: [number, number] | null; polarOrbiter: [number, number] | null };
    };
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

// ---------------------------------------------------------------------------------------------- shape models
// Products of the `shapes` stage (app/public/data/shapes/): triangle meshes of irregular bodies.

/** One part (positions, normals or indices) of a mesh LOD, relative to the LOD's `offset` in the .bin. */
export interface ShapeBinaryPart {
  offset: number;
  bytes: number;
  /** f32 positions (km), i16 snorm normals (÷ 32767), u16 or u32 triangle indices. */
  type: 'f32' | 'i16' | 'u16' | 'u32';
  /** 3 per element (xyz, or the three vertex indices of a triangle). */
  components: 3;
  /** Number of elements (vertices or triangles). */
  count: number;
  encoding?: string;
}

export interface ShapeLod {
  /** 0 = finest; each further level has fewer triangles (about 1/4). */
  level: number;
  triangles: number;
  vertices: number;
  /** Byte offset of this LOD in the .bin; each part padded to 4 bytes. */
  offset: number;
  bytes: number;
  positions: ShapeBinaryPart;
  normals: ShapeBinaryPart;
  /** Counter-clockwise seen from outside. */
  indices: ShapeBinaryPart;
  /** Every edge shared by exactly two triangles with consistent orientation. */
  watertight: boolean;
  /** Present only when `watertight` is false (a decimated level of a closed source that could not be kept closed). */
  defectEdges?: { boundaryEdges: number; nonManifoldEdges: number; inconsistentEdges: number };
  /** Volume of this level ÷ volume of the welded source mesh. */
  volumeRatioToSource: number;
  /** 'source' (the welded source mesh itself) or 'quadric' (quadric-error decimation of the previous level). */
  method: 'source' | 'quadric';
  decimationAttempts: number;
}

/** shapes/<id>.json next to shapes/<id>.bin (id = NAIF id for planetary satellites, SBDB SPK-ID otherwise). */
export interface ShapeModelHeader {
  id: number;
  name: string;
  /** SPICE body id where one exists (e.g. 2000433 for Eros; asteroids' SBDB SPK-IDs are 20000000 + number). */
  naifId: number | null;
  sbdb: { spkid: number; fullname: string } | null;
  /** How the shape was obtained: spacecraft imaging/altimetry, radar delay-Doppler, lightcurve inversion. */
  kind: 'spacecraft' | 'radar' | 'lightcurve';
  bin: string;
  units: 'km';
  /** The body-fixed frame the vertices are given in (the source's own). */
  frame: { name: string; origin: string; axes: string };
  /**
   * Orientation provenance: `frame`, the SPICE kernels that define it for the source, the rotation constants
   * behind it (`sourceRotation`: POLE_RA/POLE_DEC [deg, deg/century, deg/century²], PM [deg, deg/day, deg/day²],
   * and where the kernel has them NUT_PREC_RA/DEC/PM with the system's NUT_PREC_ANGLES and MAX_PHASE_DEGREE, as
   * SPICE evaluates them; for a frame without constants of its own, e.g. ROS_LUTETIA, the equivalent constant pole
   * and uniform rate, `derived`),
   * the app's frame for the body (`appFrame`, pck00011) and its constants, the angle between the two frames at
   * given epochs (`differenceDeg`, `poleDifferenceDeg`), and for radar models the published spin state.
   */
  orientation: {
    frame: string;
    label: Label;
    kernels?: string[];
    appFrame?: string;
    sourceRotation?: Record<string, unknown>;
    appRotation?: Record<string, unknown>;
    differenceDeg?: Record<string, number>;
    poleDifferenceDeg?: Record<string, number>;
    labelRotation?: Record<string, unknown>;
    spinState?: { file: string; fields: { name: string; unit?: string; description?: string; value: number | string }[] };
    note?: string;
    comparison?: string;
    [k: string]: unknown;
  };
  provenance: { label: Label; sources: string[]; method: string; uncertainty?: string };
  source: {
    file: string;
    nativeVertices: number;
    nativeTriangles: number;
    weldedVertices: number;
    /** After dropping degenerate, repeated and zero-volume back-to-back plates (noted in `notes` when any). */
    weldedTriangles: number;
    /**
     * Of the welded source: `components` = separate surfaces (Arrokoth's two lobes are 2); `genus` (only when
     * watertight) = handles, i.e. tunnels through the mesh (0 for a sphere-like surface).
     */
    integrity: {
      boundaryEdges: number;
      nonManifoldEdges: number;
      inconsistentEdges: number;
      eulerCharacteristic: number;
      components: number;
      genus?: number;
      watertight: boolean;
    };
  };
  stats: {
    volumeKm3: number;
    areaKm2: number;
    volumeEquivalentRadiusKm: number;
    centroidKm: number[];
    boundsKm: number[][];
  };
  /** Volume-equivalent radius against a measured mean radius (pck00011 radii or SBDB diameter). */
  scaleCheck: {
    referenceMeanRadiusKm: number;
    reference: string;
    volumeEquivalentRadiusKm: number;
    ratio: number;
  } | null;
  lods: ShapeLod[];
  layout: string;
  notes: string[];
}

/**
 * shapes/damit-index.json: a BinaryTableHeader with one row per DAMIT model; mesh data in `meshBin` (per model at
 * `dataOffset`: int16 xyz × vertexCount scaled by `scale`/32767, padded to 4 bytes, then uint16 indices).
 */
export interface DamitIndexHeader extends BinaryTableHeader {
  kind: 'damit-models';
  meshBin: string;
  provenance: { label: Label; sources: string[]; method: string; uncertainty: string };
  rotation: string;
  references: { author: string; year: string; title: string; journal: string; bibcode: string; url: string }[];
  stats: Record<string, number>;
}

/** shapes/index.json */
export interface ShapeIndex {
  bodies: Record<string, {
    name: string;
    file: string;
    kind: ShapeModelHeader['kind'];
    label: Label;
    trianglesFinest: number;
    lods: number;
    bytes: number;
    volumeEquivalentRadiusKm: number;
    scaleRatio: number | null;
    orientationLabel: Label;
  }>;
  damit?: { file: string; models: number; asteroids: number; bytes: number; label: Label; [k: string]: unknown };
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

/** A population of the synthetic layer (synthetic/objects.json `populations`; pipeline stage synthetic). */
export interface SyntheticPopulation {
  /** neo, hungaria, mainbelt, hilda, trojan, tno, centaur, irregular-jupiter, irregular-saturn, irregular-uranus, irregular-neptune */
  name: string;
  /**
   * Planet-centred populations (irregular moons): the elements are osculating elements about this NAIF body (a
   * planet-system barycentre), ecliptic J2000 axes, mu = gm (km^3/s^2). Absent: heliocentric (mu = gmSun).
   */
  center?: { naifId: number; name: string; gm: number; gmSource?: string };
  /** How the population's elements are referred (planet-centred populations). */
  frame?: string;
  /** objects.pop / cells.pop value. */
  code: number;
  /** The model (source id, or 'catalogue+<completeness source>+<slope source>'). */
  modelId: string;
  sources: string[];
  /** Seed string prefix of the population's cell streams ('<algorithm>|<seed>|<modelId>'). */
  prefix: string;
  grid: { aEdgesAu: number[]; eWidth: number; iWidthDeg: number; nE: number; nI: number; hWidthMag: number; hAlignment: string };
  hFloor: number;
  /** How the completeness limit was found (fit of Hendler & Malhotra 2020, or comparison with the model). */
  limit: Record<string, unknown>;
  model: Record<string, unknown>;
  firstCell: number;
  cells: number;
  firstObject: number;
  objects: number;
  knownInGrid: number;
  totals: { model: number; knownInGroups: number; rawDeficit: number; deficit: number; shown: number; groups: number };
}

/** synthetic/objects.json: objects standing in for the undiscovered members of each (a, e, i, H) cell. */
export interface SyntheticObjectsHeader extends SmallBodyTableHeader {
  algorithm: string;
  seed: number;
  /** Epoch of the elements (= smallbodies core epochEt), TDB s past J2000. */
  epochEt: number;
  epochTdb?: string;
  catalogue: { product: string; snapshot: string; coreSha256: string; physicalSha256: string; sources: string[] };
  populations: SyntheticPopulation[];
  labels: string;
  seedRule: string;
  yieldRule: string;
  frame: string;
  gmSun: number;
  obliquityArcsec: number;
  auKm: number;
  cells: string;
  counts: { synthetic: number; cells: number };
  floors: Record<string, number>;
  /** Slope parameter of the H-G magnitude law used for every synthetic object. */
  slopeParameterG?: { value: number; source: string; method: string };
  attributePools?: Record<string, unknown>;
  /** colorClass value of objects without a class (drawn in the solar colour, grey) and why. */
  grey?: { colorClass: number; method: string };
}

/** synthetic/cells.json: one record per (population, a, e, i, H) cell. */
export interface SyntheticCellsHeader extends SmallBodyTableHeader {
  algorithm: string;
  seed: number;
  seedRule: string;
  yieldRule: string;
  populations: { name: string; code: number; modelId: string; firstCell: number; cells: number }[];
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

// ---- comets/ (pipeline stage comets; docs/reports/comets.md) ------------------------------------------------------

/** A spectral component integrated once: XYZS (lux) and V-band flux relative to the Sun at 1 au, per unit. */
export interface CometSpectralComponent {
  xyzs: [number, number, number, number];
  v: number;
  windowNm?: [number, number];
}

export interface CometRatioStat {
  median: number;
  p16: number;
  p84: number;
  n: number;
}

/** Enclosed fraction of a Haser daughter distribution vs log10(rho / l_d). */
export interface CometHaserTable {
  parentKm1Au: number;
  daughterKm1Au: number;
  log10X: number[];
  enclosed: number[];
}

/** comets/model.json: the physical model of comae and tails, composed by the app at each comet's geometry. */
export interface CometModelProduct {
  description: string;
  sun: { vMag: number; vMagSources: string[]; irradianceXYZS1Au: [number, number, number, number]; gmKm3S2: number; gmSources: string[] };
  waterFromMagnitude: Sourced<{ a: number; b: number; qH2OPerQOH: number; rmsDex: number; rRangeAu: [number, number] }>;
  composition: Sourced<{ population: Record<'C2' | 'CN' | 'C3' | 'afrho', CometRatioStat> }>;
  gFactors: Sourced<{ C2: number; C3: number; CN: { vKmS: number[]; value: number[] } }>;
  bandRatiosToC2: Sourced<{ 'C2(1)': CometRatioStat; CH?: CometRatioStat }>;
  haser: Sourced<{ velocityKmS: number; species: Record<'C2' | 'CN' | 'C3' | 'OH', CometHaserTable>; scaling: string }>;
  oxygen: Sourced<{ photonsPerH2O: number; branching: Record<'6300' | '6364', number>; photonEnergyErg: Record<'6300' | '6364', number> }>;
  coPlus: Sourced<{ gTotalErgPerSIon1Au: number; share: Record<string, number>; coPerH2O: number }>;
  solarWind: Sourced<{ medianKmS: number; p16KmS: number; p84KmS: number; hours: number }>;
  grains: Sourced<{
    betaMin: number; betaMax: number; radiusMinM: number; radiusMaxM: number; crossSectionBetaExponent: number; sizeIndex: number;
    densityKgM3: number; qPr: number; ejection: { v0KmS: number; gamma: number; Gamma: number };
  }>;
  dustPhase: { phaseDeg: number[]; value: number[]; label: Label; sources: string[]; method: string };
  components: {
    dust: Record<'longPeriod' | 'shortPeriod', CometSpectralComponent & { normalizedGradientPer100nm: number }>;
    /** Per erg cm^-2 s^-1 of band flux at the observer: C2(0), C2(1), CN(0), C3, CH, OI6300, OI6364, COplus(2,0), COplus(3,0). */
    bands: Record<string, CometSpectralComponent>;
    sunV: { vFlux1Au: number; xyzs1Au: [number, number, number, number] };
    sources: string[];
  };
  gasFractionMax: number;
}

/** A comet of comets/list.json: predicted peak m1 from Earth over the catalogue window. */
export interface CometListEntry {
  row: number;
  designation: string;
  name: string;
  M1: number;
  K1: number;
  peakMag: number;
  peakEt: number;
  rAu: number;
  deltaAu: number;
  elongationDeg: number;
  perihelionEt: number;
  qAu: number;
  /** Lowell database key (A'Hearn et al. 1995) when its composition was measured. */
  measured: string | null;
}

/** Measured composition of one comet (log10 ratios to Q(OH); afrho: log10 Afrho[cm]/Q(OH)). */
export type CometMeasuredActivity = Sourced<{
  key: string;
  C2?: number;
  CN?: number;
  C3?: number;
  afrho?: number;
  n: Partial<Record<'C2' | 'CN' | 'C3' | 'afrho', number>>;
  rRangeAu: [number, number];
}>;

/** comets/list.json */
export interface CometListProduct {
  window: { startEt: number; endEt: number };
  notableMag: number;
  count: number;
  method: string;
  notable: CometListEntry[];
  /** Null when no notable, non-fragment comet has solar elongation >= 30 deg at peak. */
  showcase: { row: number; designation: string; name: string; rule: string } | null;
  /** core row (as a string) → measured composition. */
  measured: Record<string, CometMeasuredActivity>;
  label: Label;
  sources: string[];
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
  /** Several maps in one file (deepRemainder): slice k covers value[(k * npix + pix) * channels + c]. */
  slices?: { count: number; yBelow: (number | null)[]; layout: string; tileOrder: number };
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
/**
 * sky/corona.json (pipeline sky_corona.py; docs/reports/sky.md §5): the K-corona as an electron-density model the
 * renderer integrates along each line of sight (Thomson scattering, van de Hulst 1950 laws, solar-cycle phase), and
 * the F-corona near the Sun (LASCO reference map, Lamy et al. 2022) joined to the zodiacal-light model.
 */
export interface CoronaModel {
  kind: 'coronaModel';
  version: number;
  frame: string;
  /** Mean radiance of the solar disk (van de Hulst's unit B_sun), XYZS cd/m². */
  bSun: Sourced<{ xyzs: number[] }>;
  kCorona: Sourced<{
    electronDensity: {
      unit: string;
      radiusUnit: string;
      /** n(r) = Σ c_k r^-k, {k: c_k} (cm⁻³, r in R_sun). */
      equatorMin: Record<string, number>;
      poleMin: Record<string, number>;
      form: string;
      latitudeRampDeg: [number, number];
      maxOverEquatorMin: number;
      rMaxRsun: number;
      model: string;
    };
    thomson: { K0: number; limbDarkeningU: number; brightness: string };
    phase: {
      definition: string;
      minPrev: { year: number; month: string; smoothedSN: number };
      max: { year: number; month: string; smoothedSN: number };
      minNext: { year: number; month: string; predictedSN: number; atEndOfPrediction: boolean };
    };
  }>;
  fCorona: Sourced<{
    law: { form: string; p: number[]; s: number[]; xRange: [number, number] };
    rho: string;
    joinRhoRsun: [number, number];
    join: string;
    colourRelativeToSun: number[];
    symmetryPlane: { iDeg: number; OmegaDeg: number };
  }>;
}

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

// ── Validation cases (validation/cases/<id>/case.json; docs/reports/validation.md) ───────────────────────────
// Ground-truth comparisons for the renderer: a view it can reproduce exactly and regions of interest with the
// radiance its HDR buffer (absolute XYZS, before the eye model) must hold there. Not loaded by the app itself;
// the render-test harness reads them.

/** validation/index.json */
export interface ValidationIndex {
  schema: 'validation-index-v1';
  cases: { id: string; title: string; epochUtc: string; target: { naifId: number; name: string };
    instrument: string; rois: string[]; path: string }[];
  doc: string;
}

/** A body as the harness must place it: maps 1:1 onto SceneBody's geometric fields. */
export interface ValidationBody {
  naifId: number;
  name: string;
  /** Camera-relative position of the body centre, km, ICRF, light-time corrected (SceneBody.pos). */
  pos: [number, number, number];
  /** Body centre → Sun, km, ICRF (SceneBody.toSun). */
  toSun: [number, number, number];
  /** Body-fixed → ICRF, row-major (SceneBody.orient). */
  orient: [number, number, number, number, number, number, number, number, number];
  radii: [number, number, number];
  rangeKm: number;
  sunDistanceAu: number;
  phaseDeg: number;
  subObserver: { latDeg: number; eastLonDeg: number };
  subSolar: { latDeg: number; eastLonDeg: number };
  /** Draw the body's ring system (rings.json) as in the app. */
  rings: boolean;
}

export interface ValidationView {
  epochUtc: string;
  /** TDB seconds past J2000 of the observation (the view is explicit: the harness must not recompute it from the
   *  app's ephemeris, which only covers the app's time window). */
  et: number;
  /** SceneCamera: camera → ICRF (columns right, up, back; row-major), fovY (rad), width × height pixels. */
  camera: { orient: [number, number, number, number, number, number, number, number, number]; fovY: number;
    width: number; height: number; pixelPitchRad: number; convention: string };
  bodies: ValidationBody[];
  sun: { pos: [number, number, number] };
}

export type ValidationRoiKind =
  | 'disk-centre' | 'limb' | 'terminator' | 'point' | 'ring' | 'disk-integrated' | 'sky-near' | 'sky-far';

export interface ValidationRoi {
  id: string;
  kind: ValidationRoiKind;
  note: string | null;
  /** NAIF id of the body the ROI is on. */
  target: number;
  /** [x0, y0, x1, y1): pixel rectangle in the view (x right, y down), exclusive upper bounds. */
  rect: [number, number, number, number];
  pixels: number;
  /** Mean / range of incidence, emission, phase, latitude, east longitude or ring radius over the ROI. */
  geometry: Record<string, unknown>;
  /** Per instrument band: measured I/F statistics, 1σ relative budget, band radiance. */
  bands: {
    filter: string;
    product: string;
    /** Disk-integrated ROIs: `mean` has the local sky level (`background.level`, the camera's scattered light and
     *  zero level in a 5-pixel frame around the rectangle) subtracted; `rawMean` is the plain rectangle mean. */
    iof: { mean: number; std: number; n: number; nInRect: number;
      background?: { level: number; levelSigma: number; robustPixelSpread: number; sideMedians: number[];
        pixels: number; rawMean: number } };
    sigmaRel: { calibration: number; noise: number; registration: number };
    bandRadiance: { value: number; sigma: number | null; unit: 'W m-2 sr-1 nm-1'; bandSolarIrradiance1AU: number };
  }[];
  expected:
    | { type: 'value'; XYZS: [number, number, number, number]; sigma: [number, number, number, number];
        tolerance: [number, number, number, number]; comparison: string; label: Label; method: string;
        budget: Record<string, unknown>; bandCentersNm: number[]; rho: number[]; colorCriterion: string }
    | { type: 'upper-limit'; upperLimitXYZS: [number, number, number, number]; comparison: string; label: Label;
        method: string }
    | { type: 'none'; label: 'unknown'; method: string };
  /** Case-specific extras, e.g. Himawari's cloudTimeOffsetH. */
  [extra: string]: unknown;
}

export interface ValidationRatio {
  numerator: string;
  denominator: string;
  ratioXYZS: [number, number, number, number];
  sigma: [number, number, number, number];
  tolerance: [number, number, number, number];
  bands: { filter: string; ratio: number; sigma: number }[];
  comparison: string;
  method: string;
}

export interface ValidationCase {
  schema: 'validation-case-v1';
  id: string;
  title: string;
  summary: string;
  generated: string;
  observation: Record<string, unknown>;
  view: ValidationView;
  /** reference.bin: float32 LE I/F, shape [bands, height, width], NaN = no data, same pixel grid as the view. */
  reference: { file: string; dtype: 'float32-le'; shape: [number, number, number]; bands: string[];
    quantity: string; note: string };
  comparison: { renderOutput: string; roiStatistic: string; tolerance: string };
  rois: ValidationRoi[];
  ratios: ValidationRatio[];
  appProducts: Record<string, unknown>;
  notes: string[];
  sources: SourceRecord[];
}

// ── Nightglow: airglow and aurora (pipeline stage `nightglow`, docs/reports/nightglow.md) ─────────────────────────

/** One PALACE emission class (Noll et al. 2025): its spectrum folded through the CIE observers, and its climatology. */
export interface AirglowClass {
  id: string;
  chem: string;
  name: string;
  /** Reference height of the class's emission layer, km (AirglowLayer.centreKm). */
  layerKm: number;
  /** Zenith column emission rate above the atmosphere, R: annual nocturnal mean at 100 sfu (all wavelengths). */
  referenceR: number;
  /** The part of referenceR at 360–830 nm, R. */
  visibleR: number;
  /** Luminance (X, Y, Z cd/m²; S scotopic cd/m²) of a column of 1 R of the class's spectrum. */
  xyzsPerR: number[];
  /** The same split over the 10 nm samples of `AirglowModel.samplesNm`, for spectral attenuation. */
  xyzsPerRBySample: number[][];
  zenithXYZSReference: number[];
  shareOfZenithY: number;
  shareOfZenithS: number;
  brightestVisibleLines: { nmAir: number; R: number }[];
  /** PALACE climatology [month 12][local-time bin 12]: scaling at 100 sfu, solar-cycle effect (% per sfu), residual σ. */
  f0: number[][];
  sce: number[][];
  sigma: number[][];
}

/** A Gaussian volume-emission layer (altitude above the reference ellipsoid). */
export interface AirglowLayer {
  id: string;
  centreKm: number;
  sigmaKm: number;
  fwhmKm: number;
  kind: 'mesopause' | 'thermosphere';
  classes: string[];
}

/** Daily solar radio flux (centred 27-day means of F10.7), sfu, with the provenance of each day. */
export interface SolarRadioFluxSeries {
  firstDay: string;
  values: (number | null)[];
  labelSegments: { label: Label; from: string; to: string }[];
  lastObservedDay: string;
}

/** Resolved airglow data used by the app; serialized as AirglowProduct. */
export interface AirglowModel {
  kind: 'airglowModel';
  version: number;
  description: string;
  units: Record<string, string>;
  classes: AirglowClass[];
  layers: AirglowLayer[];
  omitted: { id: string; reason: string; zenithY: number }[];
  samplesNm: number[];
  climatology: {
    monthCentreDoy: number[];
    ltBinCentresHours: number[];
    localTime: string;
    nightWeight: number[][];
    srf0: number;
    /** Night domain: the airglow is drawn where the solar zenith angle at the ground point below exceeds this. */
    nightMinSolarZenithDeg?: number;
    scaling: string;
    domain: string;
  };
  solarRadioFlux: Sourced<SolarRadioFluxSeries>;
  label: Label;
  sources: string[];
  method: string;
  uncertainty: string;
  limbCheck?: {
    peakLimbR: number; peakLimbRRange: [number, number]; peakTangentKm: number;
    latitudeDeg: number; localTimeH: number; month: number; year: number; _source?: string;
    /** Solar radio flux of that month (sfu) and how it was formed. */
    srfSfu?: number | null; srfMethod?: string;
  };
}

/** nightglow/airglow.json v2: inline physical data in the canonical Sourced.value envelope. */
export interface AirglowProduct extends Sourced<Omit<AirglowModel, 'kind' | 'version' | 'label' | 'sources' | 'method' | 'uncertainty'>> {
  kind: 'airglowModel';
  version: number;
}

/** An aurora line group of the emission model. */
export interface AuroraLineGroup {
  /** Column per unit energy flux at each average-energy node, R per (erg cm⁻² s⁻¹). */
  columnRPerErg: number[];
  peakKm: number[];
  /** Luminance of 1 R of the group (all its lines, in their fixed ratios). */
  xyzsPerR: number[];
  /** The same over the 10 nm samples (emission.value.samplesNm). */
  xyzsPerRBySample?: number[][];
}

/** nightglow/aurora.json */
export interface AuroraModel {
  kind: 'auroraModel';
  version: number;
  description: string;
  ovation: Sourced<{
    file: string; dtype: 'float32' | 'float16'; layout: string;
    seasons: string[]; quantities: string[];
    couplingNodes: number[]; mlatDeg: number[]; mltHours: number[];
    seasonWeights: string; types: string;
  }>;
  coupling: Sourced<{
    unit: string;
    hourlyStart: string;
    stepHours: number;
    values: (number | null)[];
    measuredUntil: string;
    climatology: { value: number; label: Label; method: string; sources: string[] };
  }>;
  magneticCoordinates: Sourced<{
    file: string; dtype: 'float32'; layout: string;
    /** [first, step, count] */
    latDeg: [number, number, number];
    lonDeg: [number, number, number];
    altitudeKm: number;
    epochYear: number;
    /** Dipole frame axes (x, y, z) in Earth-fixed coordinates. */
    dipoleFrameRows: number[][];
    mlt: string;
    undefined: string;
  }>;
  emission: Sourced<{
    file: string; dtype: 'float32'; layout: string; unit: string;
    groups?: string[];
    samplesNm?: number[];
    averageEnergyNodesKeV: number[];
    altitudesKm: number[];
    lines: Record<string, AuroraLineGroup>;
    n2plusBands: { nmVac: number; photonsRelative4278: number }[];
    checks: Record<string, unknown>;
  }>;
  label: Label;
  nowcastCheck?: { source: string; use: string };
}
