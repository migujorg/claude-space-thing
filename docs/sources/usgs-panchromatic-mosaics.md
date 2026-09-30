# USGS Astrogeology 8-bit global mosaics of moons and Pluto (`usgs-*`)

All from `https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/` (= planetarymaps.usgs.gov/mosaic), uncompressed 8-bit equirectangular GeoTIFFs on a sphere, DN 0 = no data, public domain. Georeferencing from the GeoTIFF tags (tie point at the upper-left corner, pixel-is-area; centre longitude 0° or 180°), planetocentric latitude, east longitude. Producer statements below are from the FGDC metadata in `mosaic/FGDC_metadata/`.

## Used

| id | file | body | processing stated by the producer |
|---|---|---|---|
| `usgs-io-galileo-voyager-1km` | Io_GalileoSSI-Voyager_Global_Mosaic_1km.tif | Io | 32 monochrome SSI images (clear; green/756 nm where sharper), various phase angles, "empirically adjusted in brightness and contrast to match one another"; 1.3–10 km/px |
| `usgs-europa-voyager-galileo-500m` | Europa_Voyager_GalileoSSI_global_mosaic_500m.tif | Europa | radiometric calibration, Lunar-Lambert normalization, linear overlap matching, Soderblom et al. (1978) seam removal |
| `usgs-ganymede-voyager-galileo-1km` | Ganymede_Voyager_GalileoSSI_global_mosaic_1km.tif | Ganymede | same; inputs 180 m – 20 km/px; clear, 559 nm, 757 nm |
| `usgs-callisto-voyager-galileo-1km` | Callisto_Voyager_GalileoSSI_global_mosaic_1km.tif | Callisto | same family (Becker et al. 2001, LPSC XXXII 2009) |
| `usgs-pluto-newhorizons-300m` | Pluto_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif | Pluto | LORRI + MVIC; "32-bit values linearly stretched to 8 bit (1–255) using the input range 0.03344 to 0.99981" — inverted |
| `usgs-charon-newhorizons-300m` | Charon_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif | Charon | "stretched to 8 bit (1–255) using a 0.5 % to 99.5 % range ... 0.10892 to 1.3745" — inverted (1 % of pixels clipped) |

**Use (`surf_pan.py`):** DN (or the inverted stretch value) box-averaged to the layer level and divided by its cos²-weighted disk mean; the same ratio in X, Y, Z and S. Brightness **estimated** (DN scaling undocumented except for Pluto/Charon; the mosaics mix images of very different resolution and geometry), colour **estimated** (single band). Io, Europa, Ganymede, Callisto and Pluto are checked against an IAU Gazetteer albedo feature (east longitude vs the mirrored longitude); the build fails if the feature is not where it should be. The headers also record the leading/trailing hemisphere brightness ratio the map implies, for comparison with measured orbital light curves.

## Rejected (checked, not used)

The Cassini-era global maps of Saturn's mid-size moons on the same server (`Iapetus_Cassini_Voyager_mosaic_global_783m.tif`, `Dione_Cassini_Voyager_mosaic_global_154m.tif`, `Tethys_Cassini_mosaic_global_293m.tif`, `Rhea_Cassini_Voyager_mosaic_global_417m.tif`, `Enceladus_Cassini_mosaic_global_110m.tif`) are NASA/JPL/SSI (CICLOPS) cartographic maps with DLR image preparation. The Iapetus map implies a leading/trailing brightness ratio of 0.84 (0.18 mag) at zero phase, while Iapetus's leading hemisphere is famously ~2 mag fainter than its trailing one: the large-scale contrast has been compressed, so these maps are not reflectance maps. Dione's implies 1.04 and its bright ray crater Creusa (49.2°N, 283.7°E) does not stand out. Until the brightness scaling of this series is documented or checked against disk photometry, none of them is used (listed as `rejected` in `surfaces/index.json`).

**Never used:** `*_ClrMosaic*`, `*_ClrMerge*`, `*_FalseColor*` (filter composites with enhancement), `*_HPF*` (high-pass filtered), `Triton_Voyager2_ClrMosaic_GlobalFill_600m.tif` (undocumented gap fill), the `*_airbrush_*` maps (hand-painted).
