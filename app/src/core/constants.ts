// Physical and conventional constants used by app code. Every entry cites where its value is defined
// (docs/architecture.md §1: no uncited numbers that describe the universe). Dataset values (leap seconds,
// GMs, radii, rotation models, ephemerides) are NOT here; they come from app/public/data.

/**
 * Speed of light in vacuum, km/s. Exact: defining constant of the SI.
 * BIPM (2019), The International System of Units (SI Brochure), 9th ed., §2.2, Table 1 (c = 299 792 458 m/s).
 */
export const C_KM_S = 299792.458;

/**
 * Astronomical unit, km. Exact by definition: IAU 2012 Resolution B2, "Re-definition of the astronomical unit
 * of length" (au = 149 597 870 700 m).
 */
export const AU_KM = 149597870.7;

/** Seconds in a day of the TDB/TT/TAI time scales (SI seconds): 86400. IAU 1976 System of Astronomical Constants. */
export const SECONDS_PER_DAY = 86400;

/** Days in a Julian century, the time unit of the IAU rotation models and SPICE PCKs: 36525 (IAU 1976 System of Astronomical Constants). */
export const DAYS_PER_JULIAN_CENTURY = 36525;

/**
 * Julian date of the J2000.0 epoch, 2000-01-01T12:00:00 TDB: 2451545.0. Origin of `et` (TDB seconds past J2000)
 * in SPICE and in this app (docs/architecture.md §3.2). IAU 1976 Resolution (epoch J2000.0); SPICE Time
 * Required Reading (NAIF).
 */
export const J2000_JD = 2451545.0;

/**
 * Unix seconds of 2000-01-01T12:00:00 on a count with 86400 s per UTC day and no leap seconds:
 * 10957.5 days × 86400 s = 946728000. POSIX.1-2017 (IEEE Std 1003.1), §4.16 "Seconds Since the Epoch".
 * TimeData.leapSeconds[].utcJ2000 = unix seconds − this value (see app/src/data/schema.ts).
 */
export const UNIX_S_AT_J2000_UTC_COUNT = 946728000;

/** Degrees → radians (π/180). Mathematical identity, not a measured value. */
export const RAD_PER_DEG = Math.PI / 180;
