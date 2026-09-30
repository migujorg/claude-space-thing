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

export type SurfaceLayerKind = 'relative-reflectance' | 'height' | 'photometric-parameters';

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
  /** level (as string) → [tx, ty][] of tiles that are entirely unknown and therefore not stored. */
  missingTiles: Record<string, [number, number][]>;
  /** How unknown texels are encoded (float16 layers: all channels exactly 0; float32 layers: NaN). */
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
  /** Provenance of the spatial brightness pattern (worst over regions). */
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
    channelWeights?: { bandsNm: number[]; W: number[][] };
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
  notes?: string;
}
