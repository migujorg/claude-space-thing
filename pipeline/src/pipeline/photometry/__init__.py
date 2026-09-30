"""Light & color: the measured solar spectrum, solar limb darkening, and planet photometry.

Modules:
  solar     TSIS-1 HSRS solar spectral irradiance at 1 AU, (X, Y, Z, S), per-channel limb darkening, solar radius
  filters   Johnson-Cousins passbands (Bessell 1990, via the SVO Filter Profile Service) for band-averaged albedos
  phase     disk-integrated phase curves (Mallama & Hilton 2018, Lane & Irvine 1973, Buie et al. 2010)
  albedo    geometric-albedo spectra p(lambda) per body, with provenance
  bodies    assembly of photometry.json entries (docs/architecture.md §4.3) and consistency checks
  horizons  cross-check of predicted V magnitudes against JPL Horizons APmag
  report    docs/reports/planet-colors.md

Transcriptions of published tables live in tables/ with their exact citations (see docs/sources/).
"""
