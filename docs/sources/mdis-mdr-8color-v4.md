# MESSENGER MDIS 8-colour multispectral map, MDR v4 (`mdis-mdr-8color-v4`) and USGS Mercury DEM (`usgs-mercury-dem-665m-v2`)

**MDR:** Map Projected Multispectral Reduced Data Records (MESS-H-MDIS-5-RDR-MDR-V1.0, PDS volume MSGRMDS_5001, product version 4). 54 tiles (NW/NE/SW/SE quadrants of the 13 non-polar Mercury charts + 2 polar tiles, and a south-polar gap-fill tile using images binned to 2.7 km/px), 64 px/deg, 17-band float32 cubes: I/F in WAC filters 430, 480, 560, 630, 750, 830, 900, 1000 nm (bands 1–8), image count and per-band standard deviations. Photometrically normalized to i = 30°, e = 0, g = 30° with a Kaasalainen–Shkuratov function (global parameters); each value is the average over the best image sets (v3/v4 mosaicking).

**Citation:** Hash, C. (2014), MESSENGER MDIS map projected multispectral RDR V1.0, NASA PDS; Denevi, B. W. et al. (2018). Calibration, projection, and final image products of MESSENGER's Mercury Dual Imaging System. *Space Science Reviews* 214, 2. DOI [10.1007/s11214-017-0440-y](https://doi.org/10.1007/s11214-017-0440-y). Files: `https://planetarydata.jpl.nasa.gov/img/data/messenger/MSGRMDS_5001/MDR/Hxx/MDIS_MDR_064PPD_*.IMG|LBL`.

**Download:** only bands 1–6 (430–830 nm) of each cube, as one HTTP byte range per tile (`surf_fetch.fetch_range`, ledger entry with range, remote size, ETag), 4.3 GB in total; reduced to level 4 and deleted.

**Label notes:** equatorial tiles have standard parallel 0, mid-latitude tiles 43.75° (longitude spacing 1/(64 cos 43.75°)); the projection offsets leave a sub-pixel (≤ 1 source pixel) ambiguity against the stated min/max latitudes.

**Not used:** the USGS `Mercury_MESSENGER_MDIS_Basemap_EnhancedColor_*` (PCA stretch, false colour) and `…_MD3Color_*` (1000/750/430 nm composite, 8-bit) mosaics, and the monochrome basemaps.

**DEM:** `Mercury_Messenger_USGS_DEM_Global_665m_v2.tif` (USGS Astrogeology), int16 × 0.5 m relative to a 2439.4 km sphere, 23040 × 11520, left edge 0°E; Becker, K. J. et al. (2016), First global digital elevation model of Mercury, LPSC 47, abstract 2959. Re-referenced to the pck00011 ellipsoid (2440.53 × 2440.53 × 2438.26 km). Labels: albedo brightness **measured**, colour **estimated**; height **measured**.
