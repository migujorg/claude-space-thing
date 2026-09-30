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
}

export type PhaseFunction =
  | { kind: 'lambert' }
  /** Tabulated magnitude correction vs phase angle, from a published phase curve. */
  | { kind: 'tabulated'; alphaDeg: number[]; deltaMag: number[] }
  /** Polynomial in phase angle (degrees) giving magnitude correction, e.g. Mallama & Hilton (2018). Valid in [minDeg, maxDeg]. */
  | { kind: 'poly-mag'; coeffs: number[]; minDeg: number; maxDeg: number };

/** rings.json: planet NAIF id (as string) → ring system. Produced by the `light` stage. See docs/architecture.md §6. */
export type RingsFile = Record<string, RingSystem>;

export interface RingSystem {
  /** NAIF id of the planet. The ring plane is its equator (IAU pole from bodies.json); radii are planet-centred. */
  planet: number;
  /** Radial profiles of normal optical depth, each from one measured occultation cut. */
  opticalDepth: Sourced<RingProfile[]>;
  /** Lit-face reflectance vs radius. Reserved: `unknown` until a measured source is processed. */
  reflectance: Sourced<RingReflectance>;
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

/** Reserved for a measured radial I/F profile of the lit face: I/F per radius bin at the given wavelengths and geometry. */
export interface RingReflectance {
  kind: 'radial-if';
  radiusKm: number[];
  wavelengthNm: number[];
  /** iOverF[w][r]: I/F at wavelengthNm[w], radiusKm[r]; null = not measured. */
  iOverF: (number | null)[][];
  phaseDeg: number;
  incidenceDeg: number;
  emissionDeg: number;
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
