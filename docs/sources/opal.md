# Hubble OPAL global maps of the giant planets (`opal-<planet>-<epoch>`)

**What:** Outer Planet Atmospheres Legacy program, HST WFC3/UVIS. Each FITS map covers one planet rotation in one filter, cylindrical, planetographic latitude −90…+90 (north up), 360° of longitude; float32, 0 = no data. Limb darkening removed by the OPAL team with a Minnaert law (k per filter in the cycle README; "none" = not corrected). FITS × README scale = I/F. CC BY 4.0 (`LICENSE` card; attribution "NASA, ESA, A.A. Simon, M.H. Wong").

**Citation:** Simon, A. A., Wong, M. H. & Orton, G. S. (2015). First results from the Hubble OPAL program: Jupiter in 2015. *ApJ* 812, 55. DOI [10.1088/0004-637X/812/1/55](https://doi.org/10.1088/0004-637X/812/1/55). Data: MAST HLSP, DOI [10.17909/T9G593](https://doi.org/10.17909/T9G593). Also Wong, M. H. et al. (2020), *ApJS* 247, 58.

**Maps used (latest epoch, later rotation):**

| body | directory | map | size | colour filters | not used |
|---|---|---|---|---|---|
| Jupiter | cycle32/jupiter | 2025b (2025-12-11 16:49 – 12-12 00:58 UT) | 3600 × 1800, cell-registered | F395N F467M F502N F631N F658N | F275W, F343N (UV), FQ889N (CH₄) |
| Saturn | cycle32/saturn | 2025b (2025-08-29 15:19 – 23:35 UT) | 1800 × 900 | F395N F467M F502N F631N F763M | F225W, FQ727N, FQ889N |
| Uranus | cycle33/uranus | 2025b (2025-10-24 03:50 – 18:04 UT) | 721 × 361, node-registered | F467M F547M F657N F763M | F845M (no Minnaert), FQ619N, FQ727N |
| Neptune | cycle32/neptune | 2025c (2025-08-24 19:09 – 08-25 09:24 UT) | 721 × 361 | F467M F547M F657N | F763M, F845M (no Minnaert), FQ619N, FQ727N |

**Longitudes (README text, checked with data):** Jupiter/Saturn/Neptune "left edge = 0 (360) W, decreasing to the right" = east longitude increasing to the right; Uranus "right edge = 0 E, increasing to the left" (columns reversed). For Jupiter the direction is confirmed from the data: the 23.7°N prograde jet moves +4.3° east between the two December 2025 rotations 9.4 h apart (~150 m/s). Latitude orientation: the Great Red Spot comes out at 19.6°S planetocentric.

**Processing (`surf_giants.py`):** planetographic → planetocentric on the README navigation ellipsoid; rows seen at emission > 72.5° even at central-meridian passage (sub-Earth latitude from DE442s + pck00011 at the map epoch) are set unknown; box/linear resampling to level 3 (Jupiter), 2 (Saturn), 1 (Uranus, Neptune); band ratios → XYZS with each planet's disk spectrum. Labels: brightness **measured**, colour **estimated**. Epoch recorded; the maps are ~10 months (Jupiter) to ~13 months (Saturn, Neptune) old at 2026-09-30.
