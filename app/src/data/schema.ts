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
  type: 2 | 3;
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

export type BodyKind = 'star' | 'planet' | 'dwarf-planet' | 'moon' | 'barycenter';

export interface Body {
  id: number;
  name: string;
  kind: BodyKind;
  /** Body this one is grouped under in the UI (e.g. Moon -> Earth). */
  parent?: number;
  /** Which ephemeris file serves this body (holds its own segment), e.g. "ephem/centers"; the loader chains segments to reach the SSB. */
  ephemeris: string;
  /** Every ephemeris file needed to chain this body to the SSB (includes `ephemeris`). Load them all into one EphemerisSet. */
  ephemerisFiles?: string[];
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
  /** Bit index of each flag in the u16 `flags` field. */
  flagBits: Record<string, number>;
  /** Population statistic behind estimated diameters: measured p_V per SBDB orbit class ("*" = all). */
  classAlbedo: Record<string, { median: number; p16: number; p84: number; n: number }>;
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
