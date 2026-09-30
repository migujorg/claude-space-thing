# Lane & Irvine (1973) lunar disk photometry (`lane-irvine-1973`) — transcription

**Citation:** Lane, A. P. & Irvine, W. M. (1973). Monochromatic phase curves and albedos for the lunar disk. *Astronomical Journal* 78, 267–277. DOI [10.1086/111414](https://doi.org/10.1086/111414). ADS scan `https://articles.adsabs.harvard.edu/pdf/1973AJ.....78..267L` (fetched, sha256 recorded).

**Why this source:** photoelectric photometry of the *whole* lunar disk (Le Houga Observatory, 1964–65) in 9 narrow bands 359–1064 nm plus UBV, over phase angles 6–120°, giving both geometric albedos and phase curves from the same data — exactly the pair the §4.3 contract needs. Only printed tables exist.

**Transcribed (by hand from 300 dpi renders):**
- `tables/lane_irvine_1973.csv`: Table I (p. 268, effective wavelengths and half-widths), Table VII (p. 272, m(1,0) and errors), Table VIII (p. 274, geometric albedo p, phase integral q, Bond albedo A).
- `tables/lane_irvine_1973_phase.csv`: Table V (p. 271), phase curves in magnitudes every 10°, 0–120°, all bands.

**Checks:** Tables VII and VIII agree through the paper's Eq. 2 (m☉ = −26.81 in each narrow band and V, (B−V)☉ = 0.65) to ±0.001 in p, and A = p·q holds for every band (`tests/test_photometry_tables.py`).

**Use and caveats:**
- Albedo spectrum: the 9 narrow-band p values, linearly interpolated, rescaled from the paper's disk (sin σ × 384 400 km = 1738.1 km) to the pck00011 radius (×1.0008). Label **estimated**.
- Phase function (M1-M2): Table V, V column, tabulated (valid 6–120°; the 0° value is their linear extrapolation). Since M3 the Moon's phase function is the ROLO model for 1.55–97° (kieffer-stone-2005.md), normalized to this albedo; Table V's V curve is used only for 97–120°, shifted to join ROLO at 97°.
- The albedos **exclude the opposition surge** (linear extrapolation from α ≥ 6°); the ROLO phase function supplies it (Φ > 1 below 2°).
- The narrow-band albedos imply a V-band albedo 13 % above the paper's broadband V (0.113); the authors say their broadband V "appears slightly faint with respect to the narrow band data, perhaps because of transformation problems" (p. 273), and they also flag a possible excess at 0.60–0.85 µm in the 1965 data. We keep the narrow-band values (so geometricAlbedoV and XYZS agree) and report the difference.
