# Earth's whole-disk reflectance from Himawari-9 (`himawari9-ahi-l1b-fldk-20250320-0230`, `jma-ahi9-srf`)

**Data:** Japan Meteorological Agency, Himawari-9 Advanced Himawari Imager (AHI) Level 1b full-disk images in Himawari Standard Data format 1.3, as distributed by NOAA Open Data Dissemination on AWS (`https://noaa-himawari9.s3.amazonaws.com/AHI-L1b-FLDK/2025/03/20/0230/`).
- The pipeline fetches bands 1–4 (0.47, 0.51, 0.64 and 0.86 µm), 10 segment files each (40 files, 600 MB), with per-file sha256 in `data/raw/_downloads.json`.
- The SourceRecord's sha256 is the SHA-256 over the 40 per-file digests.
- Instrument and format: Bessho, K. et al. (2016), *J. Meteor. Soc. Japan* 94, 151–183, DOI [10.2151/jmsj.2016-009](https://doi.org/10.2151/jmsj.2016-009).
- Spectral responses: JMA Meteorological Satellite Center, "AHI-09 Spectral Response Curves" (Excel workbook, October 2013), read by a minimal xlsx parser (`earth.ahi_passband`).

**Why this scene:** 2025-03-20 02:30–02:39 UTC is the satellite's local noon at 140.7°E, one day before the equinox.
- The Sun is almost directly behind the satellite: 2.42° from the Earth's centre at mid-scan.
- The images therefore show the whole sunlit hemisphere at nearly zero phase: Asia, Australia and the western Pacific.
- No full-disk scan exists at 02:40 UTC (JMA housekeeping).

**Processing** (`pipeline/src/pipeline/photometry/earth.py`):
- **Header.** The Himawari Standard Data header blocks are parsed; the offsets were checked on a real segment.
- **Radiance.** Calibrated radiance is count × slope + intercept (block 5). Error and outside-scan counts are masked; there are none on the disk.
- **Resolution.** Band 3 (0.5 km) is averaged 2×2 onto the 1 km grid.
- **I/F per pixel.** I/F = π L d²/E_b, with d the Earth–Sun distance and E_b the TSIS-1 HSRS irradiance averaged over the band response. E_b agrees with JMA's own π/c′ within 1.5 %.
- **Pixel geometry** (CGMS normalized geostationary projection):
  - the intersection with the WGS84-like ellipsoid of block 3;
  - the solid angle cos y·Δx·Δy;
  - the surface area Ω s²/μ_sat;
  - μ∞, the cosine to the Earth-centre → satellite direction (the observer at infinity).
- **Disk-integrated reflectance.** A = Σ I/F·dA·μ∞/(πR²), with R the pck00011 volumetric mean radius (6371.0 km).
- **Check.** The weights sum to the projected area of the cap the satellite sees: 0.976, against 1 − (R/h)² = 0.977 for a sphere.
- **Unseen annulus.** The 2.3 % of the projected disk beyond the satellite's horizon (81.3° from the sub-satellite point) takes the mean I/F of the 70–80° view-zenith ring.
- **Cache.** The result is cached in `data/cache/earth/`, keyed by the inputs' digests.

**Result:** A = p·Φ(2.42°) is 0.2955, 0.2545, 0.2152 and 0.2389 in bands 1–4. The spectrum is piecewise-linear through these four values, with the PSG model's shape below 0.47 µm. It gives p_V = 0.239 and x, y = 0.294, 0.300.

**Use:** `photometry.json` → `399.geometricAlbedoXYZS` / `geometricAlbedoV`, label **estimated** (the spectrum between and beyond the four bands is modelled). This is a reference albedo at α = 2.42°, and the phase function is normalized to 1 there.

**Caveats:**
- **One snapshot.** One hemisphere at one instant. Real Earth varies by ~10–20 % with clouds, season and the hemisphere in view; the EPOXI 24-hour ranges show ±5–10 % within one day.
- **Phase spread.** From 6.6 Earth radii the per-pixel phase angle spans 0–11.6°.
- **Calibration.** The AHI visible bands are vicariously calibrated to a few percent.
- **No ozone band.** The Chappuis band near 600 nm lies between band nodes and is not resolved.
