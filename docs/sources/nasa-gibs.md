# NASA GIBS science layers decoded through their colour maps (`nasa-gibs`)

**What:** NASA's Global Imagery Browse Services serve many Level-2/3 science parameters as colour-mapped PNG images. Each layer's colour map (`https://gibs.earthdata.nasa.gov/colormaps/v1.3/<map>.xml`, linked from the WMTS capabilities `ows:Metadata`) lists, for every RGB colour, the value interval `[lo, hi)` it encodes and, for some maps, a class (e.g. cloud phase). Inverting the map gives the value to within one bin. That is a documented transform, lossless apart from quantization. It is unlike the stretched true-colour ("Corrected Reflectance", Rayleigh-corrected and contrast-stretched) and GeoColor (partly synthetic) imagery, which this pipeline does not use.

**Access:** WMS 1.3.0 GetMap, `https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi`, EPSG:4326 (WGS84 geodetic latitude, lat/lon axis order), PNG. Each layer is fetched in 4 × 4 blocks of 8192 × 4096 px (0.011°, 4 × 4 samples per level-4 texel). No login. The capabilities document (5 MB) is cached per UTC day and gives each layer's default (latest) date. **Checks (`surf_gibs.py`):** colour maps with duplicate colours are rejected. Colours not in the map are counted (`unmatchedColours` in each header; 0 in all builds so far). An open-ended top bin (`+INF` upper bound, or an upper bound > 1000 × the lower one, e.g. DNB `[38.2, 999999)`) is decoded to its lower bound and flagged as censored.

**Citation:** NASA Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS), https://earthdata.nasa.gov/gibs. NASA data policy: no restrictions; cite GIBS and each product.

## Layers used (`surf_earth.py`)

| Layer | Product | Colour map | Used for |
|---|---|---|---|
| `VIIRS_NOAA20_Cloud_Optical_Thickness` | CLDPROP_L2_VIIRS_NOAA20 v1.1 (`viirs-noaa20-cldprop`) | `MODIS_VIIRS_Cloud_Optical_Thickness` — 250 bins 0.01–150 (≈ 4 % wide from 1 to 100), two classes (ice / water phase) | `clouds`: opticalThickness, iceFraction |
| `VIIRS_NOAA20_Cloud_Top_Height_Day` | same | `MODIS_VIIRS_Cloud_Top_Height` — 50 m bins to 12 km, then `[12000, +INF)` | `clouds`: cloudFraction, cloudTopHeightM |
| `VIIRS_NOAA20_GapFilled_BRDF_Corrected_DayNightBand_Radiance` | VJ146A2 v2 (`viirs-noaa20-vj146a2`) | `VIIRS_DayNightBand_At_Sensor_Radiance` — bins 0.1 nW cm⁻² sr⁻¹ below 5, widening to 0.6 at 38.2, then `[38.2, 999999)` | `night` |
| `MODIS_Terra_L3_Land_Water_Mask` | MOD44W v6 (`modis-mod44w-v6-water-mask`) | `MODIS_Land_Water_Mask` — water opaque (168, 248, 255); land and no-data both transparent (MOD44W has no gaps, so transparent = land) | `water`: waterFraction; land/water split of `albedo` |
| `GHRSST_L4_MUR_Sea_Ice_Concentration` | MUR v4.1 sea_ice_fraction (`ghrsst-mur-sea-ice`) | `GHRSST_Sea_Ice_Concentration` — 1 % bins | `water`: seaIceFraction |

## Products

- **CLDPROP_L2_VIIRS_NOAA20 v1.1** (`viirs-noaa20-cldprop`): Platnick, S., Meyer, K., Wind, G., Holz, R. E., Amarasinghe, N., Hubanks, P. A., Marchant, B., Dutcher, S. & Veglio, P. (2021). The NASA MODIS-VIIRS continuity cloud optical properties products. *Remote Sensing* 13, 2. DOI [10.3390/rs13010002](https://doi.org/10.3390/rs13010002). The continuity algorithm uses the same methods on MODIS and VIIRS: cloud-top height from the IR/CO₂-slicing algorithm, and cloud optical thickness and phase from 0.65/0.86 µm with 2.2 µm reflectances. The day layers exist only where the solar zenith angle is below 81.36°. NOAA-20 crosses the equator northbound at ~13:30 local solar time.
- **VJ146A2 v2** (`viirs-noaa20-vj146a2`): Román, M. O. et al. (2018). NASA's Black Marble nighttime lights product suite. *Remote Sensing of Environment* 210, 113–143. DOI [10.1016/j.rse.2018.03.017](https://doi.org/10.1016/j.rse.2018.03.017). This is the daily at-surface Day/Night-Band radiance at 15″. Moonlight, the atmosphere and view-angle effects are removed, and cloudy pixels are gap-filled from earlier clear nights. It covers land only.
- **MOD44W v6** (`modis-mod44w-v6-water-mask`): Carroll, M. L. et al. (2017). MOD44W MODIS/Terra Land Water Mask Derived from MODIS and SRTM L3 Global 250m SIN Grid V006. LP DAAC. DOI [10.5067/MODIS/MOD44W.006](https://doi.org/10.5067/MODIS/MOD44W.006). GIBS serves annual masks 2000–2015; the build uses the latest year (2015).
- **GHRSST MUR v4.1 sea-ice fraction** (`ghrsst-mur-sea-ice`): JPL MUR MEaSUREs Project (2015). GHRSST Level 4 MUR Global Foundation SST Analysis v4.1, PO.DAAC, DOI [10.5067/GHGMR-4FJ04](https://doi.org/10.5067/GHGMR-4FJ04). It carries the EUMETSAT OSI SAF passive-microwave sea-ice concentration, interpolated to the MUR grid.

## Labels

Cloud properties, radiance, water fraction and sea ice are **measured**, with quantization as above. Averages over the 16 samples in a texel are box means. The cloud layer is unknown poleward of the daylit band at the overpass (a coverage mask computed from the solar declination, Spencer 1971). All products use WGS84 geodetic latitude. Texel rows are resampled to planetocentric latitude by taking the nearest row (the shift is at most 0.19°).
