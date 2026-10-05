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

/** Minute and hour in SI seconds. BIPM SI Brochure, 9th ed. (2019), §4, Table 8. */
export const SECONDS_PER_MINUTE = 60;
export const SECONDS_PER_HOUR = 3600;

/** Julian year: exactly 365.25 days (IAU 1976 System of Astronomical Constants). */
export const DAYS_PER_JULIAN_YEAR = 365.25;
export const SECONDS_PER_JULIAN_YEAR = DAYS_PER_JULIAN_YEAR * SECONDS_PER_DAY;

/** Calendar year containing J2000's noon origin; IAU 1976 / NAIF SPICE Time Required Reading. */
export const J2000_CALENDAR_YEAR = 2000;

/** IAU 1976 mean obliquity at J2000, 84381.448 arcsec (NAIF SPICE Frames Required Reading, ECLIPJ2000). */
export const OBLIQUITY_J2000_DEG = 84381.448 / 3600;
export const OBLIQUITY_J2000_RAD = OBLIQUITY_J2000_DEG * RAD_PER_DEG;

/**
 * Diameter–H–albedo coefficient, km. Pravec & Harris (2007), Binary asteroid population 1.
 * Angular momentum content, Icarus 190, 250–259, Eq. 3. DOI:10.1016/j.icarus.2007.02.023.
 * D = coefficient / sqrt(p_V) * 10^(-H/5), also used by the pipeline's sb_physical and syn_model.
 */
export const D_H_CONSTANT_KM = 1329;

/**
 * Long-period comet boundary, Julian years (unbound orbits also belong to this population).
 * Jewitt (2015), Color systematics of comets and related bodies, AJ 150, 201, §3.
 * DOI:10.1088/0004-6256/150/6/201 (arXiv:1510.07069).
 */
export const LONG_PERIOD_COMET_YEARS = 200;

/**
 * Earth–Moon barycentre heliocentric mean longitude, deg + deg/Julian century past J2000.
 * JPL / E. M. Standish, Keplerian Elements for Approximate Positions of the Major Planets,
 * Table 1 (valid 1800–2050), https://ssd.jpl.nasa.gov/planets/approx_pos.html.
 */
export const EARTH_MEAN_LONGITUDE = { epochDeg: 100.46457166, rateDegPerCentury: 35999.37244981 } as const;

/**
 * 1 S10sun in solar flux per sr at 500 nm. Leinert et al. (1998), The 1997 reference of diffuse
 * night sky brightness, A&AS 127, 1–99, p. 4. DOI:10.1051/aas:1998105.
 */
export const S10_PER_SOLAR_FLUX_SR = 6.61e-12;

/**
 * Faint H_g limit of the CFEPS L7 synthetic model v0.9 (Petit et al. 2011; Gladman et al. 2012).
 * Defining model release: https://www.cfeps.net/L7Release/L7SyntheticModel-v09.txt.gz
 * (pipeline source cfeps-l7-synthetic-model; model page https://www.cfeps.net/?page_id=105).
 */
export const CFEPS_L7_HG_MAX = 8.5;

// Earth reflectance model (estimated assumptions, not per-object measurements).
/**
 * Asymmetry parameter g of liquid-water clouds at visible wavelengths, derived by Mie theory:
 * Hale & Querry (1973), Applied Optics 12, 555–563, DOI:10.1364/AO.12.000555.
 * Platnick et al. (2017), IEEE TGRS 55, 502–525, DOI:10.1109/TGRS.2016.2610522.
 * - refractive index of water from Hale & Querry (1973), n = 1.331–1.333 at 550–650 nm;
 * - the modified-gamma size distribution (effective variance 0.10) that the MODIS/VIIRS cloud-property
 *   retrieval assumes (Platnick et al. 2017);
 * - g = 0.860, 0.867, 0.873 at 550 nm for effective radii 8, 12, 20 µm (0.857–0.872 at 650 nm); the
 *   12 µm value is used (script in docs/rendering-earth.md §3).
 * Using the retrieval's own particle model keeps the reflectance of the retrieved optical thickness
 * consistent with what the satellite saw.
 */
export const CLOUD_G_LIQUID = 0.867;
/**
 * Asymmetry parameter of ice clouds: ≈ 0.75 in the mid-visible for the severely roughened aggregated
 * columns (Yang et al. 2013) of the MODIS Collection 6 retrieval (Platnick et al. 2017), which the VIIRS
 * CLDPROP product continues. Yang et al. (2013), J. Applied Meteorology and Climatology 52,
 * 430–446, DOI:10.1175/JAMC-D-12-039.1. Alternatives: smooth crystals (g ≈ 0.8, Baum et al. 2005, Collection 5).
 */
export const CLOUD_G_ICE = 0.75;
/**
 * Visible (λ < 700 nm) albedo of snow-covered first-year sea ice in spring (thick snow > 3 cm, SON):
 * 0.96 (Brandt et al. 2005, J. Climate 18, 3606, Table 3), taken as spectrally flat and Lambertian.
 * An assumption for all sea ice, so its light is labelled estimated. Alternatives in the same table:
 * thin snow on first-year ice 0.85–0.94, bare first-year ice 0.54–0.67. Perovich et al. (2002) measured
 * Arctic summer ice-only albedos of 0.4 (with melt ponds) to 0.65.
 */
export const SEA_ICE_ALBEDO_VIS = 0.96;
/**
 * Sea-surface slope variance of Cox & Munk (1954, JOSA 44, 838, clean surface): σ² = 0.003 + 5.12·10⁻³·U,
 * DOI:10.1364/JOSA.44.000838.
 * U the wind speed (m/s) at 12.5 m, isotropic Gaussian slopes (their Gram–Charlier skewness and
 * peakedness terms and the up/cross-wind anisotropy are left out: the wind direction is not in the layer).
 */
export const COX_MUNK_SIGMA2 = { a: 0.003, b: 5.12e-3 };
/**
 * U(12.5 m)/U(10 m) for a neutral logarithmic profile with a ~0.2 mm roughness length, the conversion the
 * wind layer's header gives (surfaces/399/wind.json constants.coxMunk.height).
 * Derived assumption: ln(12.5/0.0002) / ln(10/0.0002), rounded to 1.02; neutral
 * log profile (Monin & Obukhov 1954, Trudy Geofiz. Inst. AN SSSR 24, 163–187).
 */
export const WIND_12_5_PER_10 = 1.02;
/** Refractive index of sea water in the visible, as Cox & Munk (1954) used for its Fresnel reflectance. */
export const SEA_WATER_N = 1.338;

/** Largest wind speed (m/s, 12.5 m) of Cox & Munk's clean-surface photographs (their Table 1: 13.8 m/s). */
export const COX_MUNK_MAX_WIND = 13.8;
