# U.S. Standard Atmosphere, 1976 (`us-standard-atmosphere-1976`)

**Document:** U.S. Standard Atmosphere, 1976. NOAA, NASA, USAF. NOAA-S/T 76-1562 (NASA-TM-X-74335), U.S. Government Printing Office, 1976. Scan from NTRS 19770009539 (`https://ntrs.nasa.gov/api/citations/19770009539/downloads/19770009539.pdf`, 243 pages, sha256 in the download ledger). Its text layer is unusable OCR, so the values were read from 110–200 dpi renderings of the pages (pdf page numbers below; the report's own page numbers in parentheses).

**What it is:** "an idealized, steady-state representation of the earth's atmosphere from the surface to 1000 km, as it is assumed to exist in a period of moderate solar activity" (§1.0, pdf 17, p. 1), defined by a piecewise-linear molecular-scale temperature profile in geopotential altitude and the hydrostatic equation up to 86 km. Below 51 km′ its tables are identical with the 1962 Standard and "based on traditional definitions" which, "especially for heights below 20 km′, do not necessarily represent an average of the vast amount of atmospheric data available today"; 51–84.852 km′ follows "the averages of present-day atmospheric data" (same page). The ozone model (Part 3) is built from balloon and rocket soundings.

**Transcribed:** `pipeline/src/pipeline/photometry/tables/us_standard_atmosphere_1976.json`:
- Table 2 adopted constants (pdf 18, p. 2): k, N_A, R*, g0, P0, T0; r0 = 6 356 766 m (text under eq. 17, pdf 24, p. 8).
- Table 3 sea-level composition (pdf 19, p. 3) and M0 = 28.9644 kg/kmol (text, pdf 25, p. 9).
- Table 4 layer bases H_b and gradients L_M,b (pdf 19, p. 3).
- Table 8 molecular-weight ratio M/M0 at 80–86 km (pdf 25, p. 9; geometric half).
- Table 18 mid-latitude ozone model, 2–74 km (pdf 54, p. 38): number density and its standard deviation.
- Check rows of the main Tables I–II (pdf 67, 89, 90, 105).
- The equations used (17, 18, 23, 33a, 33b, 34) as text.

**Checks** (`tests/test_atmospheres.py`, `docs/reports/atmospheres.md`):
- The defining equations reproduce the printed number densities from −5 to 80.5 km to < 1e-4 (the Standard's tables below 86 km were computed without the M/M0 ratio, pdf 25; the product applies it, a ≤ 0.04 % change at 80–86 km).
- Layer-base pressures: 22 632 Pa at 11 km′.
- The ozone table integrates to the stated 0.345 atm-cm (9.27e22 m⁻²) within 2 %.

**Use:** `atmospheres.json` Earth: the molecular number density N(z), 0–86 km (Rayleigh component, label **estimated**: a standard stands in for the real, variable atmosphere; the cross-section itself is derived); temperature T(z) for the ozone cross-sections; the ozone profile (label **estimated**). A measured-data-fitted empirical model (NRLMSIS 2.x) was not used: it is distributed as Fortran code plus parameter files rather than as tables, and would add a compiled dependency.

**Caveats:** an idealized standard — real surface pressure and density profiles vary by several percent with weather, latitude and season. The ozone model is mid-latitude, "weighted towards the solar maximum conditions which existed in the late 1960's" (p. 37), 5 % above Dobson-network totals at 45° N; the table starts at 2 km (held constant below).
