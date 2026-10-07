# NASA Langley SatCORPS Global Cloud Composite, GEO-LEO global, V2 (`satcorps-gcc-geoleo`)

**What:** hourly global composites of cloud retrievals on a 1/36° latitude-longitude grid (6480 × 12960 cells), made by the SatCORPS group at NASA Langley from five geostationary imagers (Meteosat-9, Meteosat-10, GOES-18, GOES-19, Himawari-9) and NOAA-20 VIIRS (CERES's VIIRS cloud product, granules `CER_ECV_NOAA20-VIIRS_VERSION1B`). Each cell holds one satellite's retrieval, chosen by the provider: class (`cloud_phase`), visible optical depth at about 0.65 µm (`cloud_optical_depth`, 0.01–150 in steps of 0.01), top height, the source (`satellite_ID`), the observation time (`relative_time`, seconds from the file's nominal hour) and the solar and viewing angles. File attribute `version`: SatCORPS V2.30; composite algorithm 4.09f. The Earth's cloud layers (`surfaces/399/clouds`, `cloudTau`, `cloudTauEstimated`) are built from it: `pipeline/src/pipeline/satcorps.py`, `surf_earth.build_clouds`, docs/rendering-earth.md §2.

**Access:** anonymous HTTPS with Range requests, `https://satcorps.larc.nasa.gov/prod/GCC-GEO-LEO/visst-pixel-netcdf-v2/<yyyy>/<mm>/<dd>/satcorps-gcc.v02.geoleo.glob-comp.<yyyy><doy>.<hh>00.3km.nc` (netCDF-4, 1.26–1.43 GB an hour, 33.6 GB for the day). The product page (https://satcorps.larc.nasa.gov/new/products/global-cloud-composite/, retrieved 2026-10-07) calls it **"early access"** and "near real time", with the global V2 series starting 26 May 2026: the archive may not keep these files, so the byte ranges read are kept in `data/raw/surfaces/earth/satcorps/` (not deleted after reduction as other surface inputs are). The files of 2026-09-28 were produced on 30 September, two days after the day (attribute `processed_history`), except the 20 UTC file, produced on 29 September.

**What is read:** of each of the 24 files of 2026-09-28, the 15° strip of longitude whose local solar time at the file's hour is within half an hour of 13:30, and of it nine variables: `satellite_ID`, `cloud_phase`, `relative_time`, `solar_zenith`, `view_zenith`, `relative_azimuth`, `cloud_optical_depth`, `cloud_top_height`, `surface_type`. h5py reads the file through HTTP Range requests (`satcorps.RangeFile`): each compressed chunk as its exact byte range, the metadata in 64 KiB blocks; 1,136 ranges, 1.54 GB, about 16 minutes on one connection. Every range is a raw file with a ledger entry (range, sha256, the remote file's size, ETag and Last-Modified). `satcorps.PINS` holds, per hour, the remote file's size, ETag and Last-Modified and the sha256 of the strip's decoded arrays; a file that changes or a strip that decodes differently fails the build. `python -m pipeline.satcorps pins <day>` prints the table for a day (an explicit input update).

**The 20 UTC file has no `surface_type`.** It is of an earlier processing run (37 variables, not 38). The builder reads that strip's surface type from the 21 UTC file (the nearest hour that has one; recorded in the header and pinned). Only the map's water class is used, for the glint test below. Over the strip's 3,499,200 cells the map is identical, cell for cell, in the 04, 12, 19 and 21 UTC files.

**Citation:** NASA Langley Research Center, SatCORPS Group, SatCORPS Global Cloud Composite (https://satcorps.larc.nasa.gov). Algorithm: Minnis, P., et al. (2008), Proc. SPIE 7107, 710703, doi:10.1117/12.800344; Minnis, P., et al. (2021), IEEE Trans. Geosci. Remote Sens. 59, 2744–2780, doi:10.1109/TGRS.2020.3008866. Composite: Khlopenkov, K., et al. (2017), Proc. SPIE 10424, doi:10.1117/12.2278645. The files state no licence. Their `user_notes` ask that the source be acknowledged ("NASA Langley Cloud and Radiation Research Group, http://satcorps.larc.nasa.gov") and that Dr. William L. Smith Jr. be contacted before a publication that uses the data.

## What the picture is

A mosaic of 24 moments, not one. The file of UTC hour h serves the longitudes 15·(13 − h)° < λ ≤ 15·(14 − h)° (wrapped), where h + λ/15 = 13.5 at the strip's centre. The cuts between strips, at every multiple of 15°, are hard: neighbouring strips are one hour apart, and between the strips of 23 UTC (east of 150° W) and 00 UTC (west of it) the weather is 23 hours apart and a day apart in local date. Nothing is blended between hours and nothing is interpolated across a hole. These are real discontinuities in the weather shown.

Why 13:30: it is the local time of the product's own polar orbiter (NOAA-20, ascending node 13:25), so the cells that fill the polar caps and the outages of a geostationary imager are of the same local hour as the geostationary cells; and it is the local time of the Earth's wind layer (AMSR3's ascending pass), which sets the sun glint. In the built layer the geostationary cells were observed 7–725 s after their file's nominal hour; the polar orbiter's between 2 h before and 3 h after it (observations span 2026-09-27 22:07 to 2026-09-29 01:26 UTC).

Coverage of the day's files (source IDs of all 48 hourly files of the GEO-ring and GEO-LEO products, 2026-10-07): the GEO-LEO files cover 97.8–98.7 % of the globe in 22 hours (87.9 % at 08 UTC, 95.7 % at 17 UTC, when Himawari-9 sections are absent from the input list); at 04 UTC seven Himawari-9 sections are absent and NOAA-20 cells stand in. Each hour's own strip is fully covered in 23 hours and 99.3 % in one (19 UTC). The built mosaic is known over 99.97 % of the globe.

## Classes, and which thickness is whose

| Cell | Group | Strict | Best estimate, Complete |
|---|---|---|---|
| `cloud_phase` 0 (clear, snow/ice), 4 (clear, land/water) | clear | clear | clear |
| 1 (water cloud), 2 (ice cloud) with an optical depth, by day, outside the geometry below | measured thickness | drawn | drawn |
| 1, 2 with an optical depth, in the geometry below | estimated thickness | cloud of unmeasured thickness | drawn with the provider's value, `estimated` |
| 6, 7 ("possible water/ice cloud") | not defined in any document read | not measured | not measured |
| 3 ("no cloud property retrievals"), or 1, 2 without a valid optical depth | cloud without a thickness | not measured | not measured |
| no source, fill, 5 ("bad input data"), 13 ("cleaned data") | not observed | cloud state not measured | cloud state not measured |

"No cloud property retrievals" is a cloudy pixel that neither the water nor the ice model fits (Minnis et al. 2021, §III-A, p. 5, outcome 4; 0.7 % of daytime pixels in Ed4 Aqua 2008, about 0.2 % at night, §IV-A, p. 16). No published thickness exists for that class, so none is given.

**The estimated group** (`satcorps.classify`; stated with its counts in each layer header, `constants.geometricTest`):

1. Solar zenith angle ≥ 82°, any satellite. Documented: the solar retrieval runs below 82°; otherwise thermal channels only, a thickness for thin cloud alone ("optical depths less than 3 or so"), thick cloud a default (Minnis et al. 2008, §3, p. 4; Minnis et al. 2021, §III-A, p. 5, §III-A.5, p. 9) and in version 2 a k-nearest-neighbour extrapolation of daytime thickness from the 6.7 and 11 µm channels (SatCORPS GCC overview v2, slides 8–9).
2. A geostationary cell with solar zenith angle ≥ 75.25°.
3. A geostationary cell over water (`surface_type` 17) within 40° of the Sun's mirror direction: cos Θ = cos θ0 cos θ + sin θ0 sin θ cos φ from the file's `solar_zenith`, `view_zenith` and `relative_azimuth`; Θ < 40°, no inner limit.

Items 2 and 3 are **not documented**. The overview (slide 7) lists, for "data products in the solar terminator and sun-glint", a k-nearest-neighbour extrapolation "from surrounding space/time domain"; no document read defines the zone and the files flag no cell. The two limits are where the files themselves show a different treatment: the provider's "possible" classes (6, 7), a few percent of geostationary cells elsewhere, are all but absent there.

*Where the processing differs: the evidence.*

- Solar zenith, 04:00 UTC file of 2026-09-28 (all solar zenith angles occur in one hour's file): among geostationary cells between 75.25° and 82°, none of 3,232,427 is in a "possible" class; between 60° and 75.25°, 116,722 of 7,128,216 are. The largest solar zenith angle of a "possible" cell is 75.24° (Meteosat-9), 75.16° (Meteosat-10), 75.21° (GOES-18), 75.19° (Himawari-9). "No cloud property retrievals" does not vanish there (14,326 Meteosat-9 cells between 75.25° and 82°): only the "possible" classes mark the limit. The polar orbiter's cells have no "possible" class anywhere, and their "no retrieval" class ends at 82°.
- The cone, in the 24 strips as built, cells over water with the solar zenith angle below 75.25° (file angles):

  | Satellite | inside 40°: "possible" / cells | outside: "possible" / cells |
  |---|---|---|
  | Meteosat-9 | 1,354 / 379,239 (0.36 %) | 133,549 / 6,336,799 (2.11 %) |
  | Meteosat-10 | 647 / 1,850,666 (0.03 %) | 83,500 / 4,164,012 (2.01 %) |
  | GOES-18 | 692 / 2,353,198 (0.03 %) | 156,594 / 7,947,207 (1.97 %) |
  | GOES-19 | 3,322 / 1,301,127 (0.26 %) | 246,369 / 5,735,302 (4.30 %) |
  | Himawari-9 | 6,814 / 1,889,329 (0.36 %) | 182,915 / 7,643,842 (2.39 %) |
  | all five | 12,829 / 7,773,559 (0.17 %) | 802,927 / 31,827,162 (2.52 %) |

- The edge is not one angle. In those strips, by angle from the mirror direction (computed from positions), the share of "possible" cells is: Meteosat-10 0.02–0.06 % inside 40°, 2.1 % from 40° to 46°; GOES-18 0.00–0.09 % inside, 0.5 % from 40° to 46°, 2.1 % beyond; Meteosat-9 0.04 % from 28° to 40°, 2.3 % from 40° to 46°, but 16 % of the 5,082 cells inside 10°; Himawari-9 0.2–0.3 % from 10° to 40°, 1.9 % from 40° to 46°, and 2.3 % inside 10°; GOES-19 0.04 % from 10° to 28°, 0.7 % from 28° to 40°, 1.0 % from 40° to 46°, 4.5 % beyond. In the 04:00 UTC file GOES-18, seen near its evening limb, has the classes back from 28°. So the provider's zone depends on more than this angle; 40° without an inner limit is the widest edge seen, taken conservatively, not the provider's definition.
- The azimuth convention: with φ = 0 on the mirror side (the formula above) Θ agrees with the mirror angle computed from the satellite's and the Sun's positions to 0.40° rms over 7,463,141 Himawari-9 cells of the 04:00 UTC file; with the other sign, to 71.7°.

The stake: in the built layer the estimated group is 8.4 % of the globe's area against 53.9 % with a measured thickness; "possible" cloud is 2.5 %, cloud without a thickness 0.09 %.

## What the provider documents about accuracy

No uncertainty per cell, no retrieval-method flag, no validation of V2.30 itself. The algorithm family (CERES Edition 4 / SatCORPS), on earlier instruments:

- Thin ice cloud (lidar thickness below about 6) against CALIOP, imager minus lidar, bias and RMS: by day over snow-free surfaces +0.86, 4.27 (MODIS), +0.91, 4.83 (VIIRS), **+2.25, 10.61 (geostationary: GOES-11/12, Meteosat-9, MTSAT-1R, 2008)**; by night +0.44, 1.84; +0.37, 1.67; +0.60, 1.88 (Yost et al. 2016, poster P-55, NTRS 20160007830, table "Global COD biases, RMS differences"). Thin cirrus is, on average, too thick in the geostationary cells. Thick cloud cannot be compared with the lidar.
- Liquid cloud against surface retrievals: 30 % low at the Azores (9.6 against 13.7; "significant", possibly an island effect), 5 % low and 8 % high at Barrow without and with snow (Minnis et al. 2021, §V-C.1, p. 26).
- Mask and phase agree with the lidar in at least 85 % of scenes over snow-free surfaces; tops of opaque water cloud within 0.2 km, of opaque ice within 1.5 km (Yost et al. 2016); passive retrievals "detect few clouds" thinner than about 0.3 (Minnis et al. 2008, §4, p. 7).
- The phase is the radiatively dominant one; thin cirrus over water cloud can be missed and mixed phase is not a class (product page).

## What stays unknown

- **Parallax.** The composite's paper does not mention a correction. A 10 km top seen at 60° view zenith is displaced 17 km towards the limb of its satellite's disk.
- **Cloud smaller than a pixel.** A 2–3 km pixel is cloudy or clear as a whole; a cloudy pixel's thickness is the plane-parallel value for its mean reflectance. Small cumulus in pixels called clear is not in the layer. A level-4 texel holds 2.5 composite cells on average.
- **The grid's latitude** is not stated in the files. It is read as WGS84 geodetic: against this pipeline's water layer (MOD44W), the land/water classes of `surface_type` agree better near north-south coasts when read so: 0.754 against 0.702 at 30–60° N, 0.715 against 0.629 at 30–60° S (0.719 against 0.705 within 15° of the equator, where the two readings nearly coincide).
- **The "possible" classes**: no document read defines them. They come in patches (88 % of such cells have another beside them; 28 % touch clear sky against 14 % for definite cloud) with a median thickness of 1.2–1.5.
- **Which daytime cells the provider extrapolated**: the test above is this pipeline's reading of the files, not the provider's flag.
- **Sources disagree where the sea glints.** At 130° E, 6° S on this day, within an hour: 74 % cloud plus 24 % "no retrieval" from NOAA-20 (04:36 UTC, in the 04:00 file), 6 % cloud from Himawari-9 (05:06 UTC, the strip used).
