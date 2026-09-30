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
  /** UTC instant (as seconds past J2000 on the UTC-count-without-leaps scale, i.e. Unix-like) at which ΔAT takes this value. */
  utcJ2000: number;
  /** TAI − UTC in seconds from that instant. */
  deltaAT: number;
}

export interface TimeData {
  source: string;
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
  sources: string[];
}

export interface EphemHeader {
  bin: string;
  segments: EphemSegment[];
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
  /** System angle polynomials [theta0, theta1 (per century)] pairs, degrees. */
  nutPrecAngles?: number[];
}

export type BodyKind = 'star' | 'planet' | 'dwarf-planet' | 'moon' | 'barycenter';

export interface Body {
  id: number;
  name: string;
  kind: BodyKind;
  /** Body this one is grouped under in the UI (e.g. Moon -> Earth). */
  parent?: number;
  /** Which ephemeris file serves this body; the loader chains segments to reach the SSB. */
  ephemeris: string;
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
