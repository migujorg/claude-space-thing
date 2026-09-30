# New Horizons MVIC global colour maps of Pluto and Charon (`nh-mvic-global-color-maps`)

**What:** "Global Color Map Mosaic of Pluto / Charon from New Horizons MVIC Observations". These are 4-band float32 cubes in the PDS4 collection `urn:nasa:pds:nh_derived:plutosystem_composition` v1.0 (PDS Small Bodies Node, 2025; a migration of the PDS3 product `NH-P/PSA-LEISA/MVIC-5-COMP-V1.0`). Bands: CH4 895 nm (40 nm wide), NIR 870 (180), Red 625 (150), Blue 475 (150). The arrays are band-sequential, little-endian float32. ISIS special values (0xFF7FFFFB …) mark no data.

| Body | File | Size | Grid |
|---|---|---|---|
| Pluto | `nh_pluto_color_mosaic.img` | 1.06 GB | 11487 × 5744, 650 m/px, sphere 1188.3 km, centre longitude 180°E |
| Charon | `nh_charon_color_mosaic.img` | 116 MB | 3808 × 1904, 1000 m/px, sphere 606 km, centre longitude 0° |

Upper-left corners and scales are taken from the `.lblx` labels. Latitudes are planetocentric and longitudes positive east.

**Processing (collection overview document):** each MVIC colour scan was converted from calibrated I/F (Howett et al. 2017) to normal albedo with the lunar-Lambert function (McEwen 1991) at L(15°) = 0.65. The scans were registered to the LORRI base map and mosaicked. The lower-resolution global 4-colour mosaic was merged with the panchromatic base map (McEwen 1991) to full resolution. The label says the values are "no longer strictly I/F values, but are similar". Phase angles are ~15° on approach and ~38° for the best encounter scans.

**Citation:** Olkin, C. B. et al. (2017). The global color of Pluto from New Horizons. *AJ* 154, 258. DOI [10.3847/1538-3881/aa965b](https://doi.org/10.3847/1538-3881/aa965b). Howett, C. J. A. et al. (2017). Inflight radiometric calibration of New Horizons' MVIC. *Icarus* 287, 140–151. DOI [10.1016/j.icarus.2016.12.007](https://doi.org/10.1016/j.icarus.2016.12.007). Schenk, P. M. et al. (2018), *Icarus* 314, 400–433 (Pluto) and 315, 124–145 (Charon). Public domain (NASA).

**Access:** `https://pds-smallbodies.astro.umd.edu/holdings/pds4-nh_derived:plutosystem_composition-v1.0/mosaic/`. The Blue, Red and NIR bands are read one at a time by HTTP Range through `download.fetch`, box-averaged, and deleted after use. The CH4 band is not used.

**Use (`surf_nh.py`):** band ratios at 475/625/870 nm are converted to XYZS with each body's disk spectrum (as for Mars). Pluto is built at level 3 and Charon at level 2. Labels: brightness **measured** (documented normal albedo), colour **estimated** (two visible bands 150 nm apart). Pluto's georeferencing is checked against Belton Regio. These maps replace the USGS 8-bit panchromatic mosaics. Those had brightness **estimated** (an inverted display stretch) and no colour variation.
