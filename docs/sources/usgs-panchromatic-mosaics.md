# USGS Astrogeology 8-bit global mosaics of moons and Pluto (`usgs-*`)

All from `https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/` (= planetarymaps.usgs.gov/mosaic), uncompressed 8-bit equirectangular GeoTIFFs on a sphere, DN 0 = no data, public domain. Georeferencing from the GeoTIFF tags (tie point at the upper-left corner, pixel-is-area; centre longitude 0° or 180°), planetocentric latitude, east longitude. Producer statements below are from the FGDC metadata in `mosaic/FGDC_metadata/`, the detached ISIS/PDS labels and the cited processing papers. The GeoTIFF band scale and offset are part of the raw product, not a calibration fitted by this project.

## Used

| id | file | body | processing stated by the producer |
|---|---|---|---|
| `usgs-io-galileo-voyager-1km` | Io_GalileoSSI-Voyager_Global_Mosaic_1km.tif | Io | combined Galileo SSI / Voyager II monochrome morphology map (Becker & Geissler 2005); the 32-image Galileo-only grayscale description is a sibling product |
| `usgs-europa-voyager-galileo-500m` | Europa_Voyager_GalileoSSI_global_mosaic_500m.tif | Europa | radiometric calibration, Lunar-Lambert normalization, linear overlap matching, Soderblom et al. (1978) seam removal |
| `usgs-ganymede-voyager-galileo-1km` | Ganymede_Voyager_GalileoSSI_global_mosaic_1km.tif | Ganymede | same; inputs 180 m – 20 km/px; clear, 559 nm, 757 nm |
| `usgs-callisto-voyager-galileo-1km` | Callisto_Voyager_GalileoSSI_global_mosaic_1km.tif | Callisto | same family (Becker et al. 2001, LPSC XXXII 2009) |
| `usgs-pluto-newhorizons-300m` | Pluto_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif | Pluto | LORRI + MVIC; "32-bit values linearly stretched to 8 bit (1–255) using the input range 0.03344 to 0.99981" — inverted |
| `usgs-charon-newhorizons-300m` | Charon_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif | Charon | "stretched to 8 bit (1–255) using a 0.5 % to 99.5 % range ... 0.10892 to 1.3745" — inverted (1 % of pixels clipped) |

**Use (`surf_pan.py`):** decode the GeoTIFF `GDAL_METADATA` band-0 SCALE/OFFSET before box averaging and disk normalization: value = SCALE × stored pixel + OFFSET. The raw tags and detached ISIS `Pixels.Multiplier` / `Pixels.Base` agree:

| body | SCALE / Multiplier | OFFSET / Base | source label |
|---|---|---|---|
| Io | 0.0059055141 | −0.0029527571 | [ISIS label](https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Io_GalileoSSI-Voyager_Global_Mosaic_1km.lbl) |
| Europa | 0.0059055141 | −0.0029527571 | [ISIS label](https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Europa_Voyager_GalileoSSI_global_mosaic_500m.lbl) |
| Ganymede | 0.0059055141 | −0.0029527571 | [ISIS label](https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Ganymede_Voyager_GalileoSSI_global_mosaic_1km.lbl) |
| Callisto | 1 | 0 | [ISIS label](https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Callisto_Voyager_GalileoSSI_global_mosaic_1km.lbl), also PDS SCALING_FACTOR/OFFSET; no GDAL scale/offset tag |

[USGS's encoding documentation](https://astrogeology.usgs.gov/docs/concepts/isis-fundamentals/core-base-and-multiplier/) defines this conversion from stored integers to floating values. The labels do not identify those values as calibrated I/F. The old stage ignored the GeoTIFF encoding; after division by the disk mean, the correction amounts to using DN − 0.5 for the first three moons. It slightly **increases** their contrast and does not resolve Ganymede's hemispheric discrepancy. Pluto/Charon's explicit FGDC stretch inversion remains separate.

Brightness and colour remain **estimated**: decoded, tone-matched values are assumed proportional to relative reflectance at every scale; mixed filters, unknown per-image corrections and residual topographic shading prevent a measured albedo label. The same normalized ratio is written in X, Y, Z and S. No source supports upgrading the small-scale amplitudes to measured reflectance. Feature locations and morphology come from observed images. DN 0 remains unknown, masked before decoding. Gazetteer orientation checks remain unchanged.

### What the producers establish, and what they do not

The [Ganymede FGDC record](https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/FGDC_metadata/ganymede_voyager_galileo_ssi_global_mosaic_1km.xml) says level 1/2 processing preserves “the original contrast captured by the camera”. Its processing section subsequently describes photometric normalization, tone matching and separately enhanced colour; colour enhancement must not be attributed to the monochrome product. The [Europa FGDC record](https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/FGDC_metadata/europa_voyager_galileo_ssi_global_mosaic_500m.xml) describes overlapping-frame corrections and seam removal. The [Io grayscale record](https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/FGDC_metadata/io_galileo_ssi_grayscale_global_mosaic_1km.xml) says images were “empirically adjusted in brightness and contrast”. That is the Galileo-only grayscale sibling, not the combined map used here; [Becker & Geissler (2005)](https://www.lpi.usra.edu/meetings/lpsc2005/pdf/1862.pdf) identifies the combined monochrome map as Galileo plus Voyager II.

[Becker et al. (2001)](https://www.lpi.usra.edu/meetings/lpsc2001/pdf/2009.pdf) describes the three icy moons: best available Voyager/Galileo images, radiometric calibration, empirical Lunar-Lambert normalization, overlap correction and seam filtering. Its phrase “minimize image brightness variations” describes the overlap correction, not removal of the moons' intrinsic hemispheric albedo. [ISIS processing documentation](https://isis.astrogeology.usgs.gov/Isis2/html/voyager_mosaic.html) explains multiplicative/additive frame matching. These coefficients and reference-image choices are not supplied with the TIFFs; their effect cannot be inverted from the delivered mosaics.

[Kirk et al. (2000)](https://www.lpi.usra.edu/meetings/lpsc2000/pdf/2025.pdf) distinguishes albedo normalization (division by the actual-angle law and multiplication by a reference-angle law) from topographic normalization. For icy Galilean mosaics, its mixed mode retains albedo contrast at lower incidence angles and adjusts shading near the terminator. The record does not supply the mode-transition parameters used for these specific TIFFs. [ISIS `noseam`](https://isis.astrogeology.usgs.gov/Isis2/html/noseam.html) recombines high-pass image detail with the **low-pass base mosaic**. Seam removal is consequently not evidence that all large-scale variation was removed.

The sources supply no recoverable per-frame stretch, no scale separating reliable albedo from artificial contrast, and no assertion that the delivered hemispheric term is wholly nonphysical. **Decision:** apply the documented pixel encoding; retain the spatial pattern as estimated, and report the discrepancy. Subtracting a degree-1/2 spherical harmonic, imposing a low-pass width, or replacing a map's slice means would introduce a new assumption without an independently supported scale. No such filter or validation-image fit is applied.

### Hemisphere audit and uncertainty

The diagnostic integrates the **built map before the renderer's viewing-geometry normalization**. Leading is centred at 270°E and includes longitudes 180–360°E; trailing is centred at 90°E and includes 0–180°E. At each texel centre the weight is cos²(latitude) × max(cos(longitude − centre), 0), divided by the sum over known texels. This is projected area without a scattering law. A six-slice map gives weights [0.5, 1, 0.5] on each hemisphere. The map's rotation-averaged normalization cancels in the ratio.

| body | old map L/T (level 3) | decoded map L/T (level 3) | Table 4 slices, same projected-area kernel | rendered zero-phase disk L/T | published GRN modulation (Table 7) | L/T uncertainty |
|---|---|---|---|---|---|---|
| Io | 1.065740 | 1.066052 | 1.088513 | 1.094806 | 16 ± 6 % | unknown |
| Europa | 1.249334 | 1.250286 | 1.300055 | 1.319353 | 33 ± 7 % | unknown |
| Ganymede | 1.351423 | 1.354360 | 1.181850 | 1.189596 | 21 ± 5 % | unknown |
| Callisto | 1.293657 | 1.293657 | 0.935985 | 0.937718 | 16 ± 17 % | unknown |

The rendered ratio uses the app's Lambert slice kernel (cos² longitude), then `frame.ts` normalizes law × map at each actual view; disk totals are controlled by the slices already, not by the map-only diagnostic. This agrees with architecture §4.3/4.4; no renderer normalization defect was found.

[Mayorga et al. (2020)](https://arxiv.org/pdf/2009.05467), Table 4, supplies no numerical slice errors or covariance. Figures 4–7 shade 1σ fit regions; Table 7 errors concern peak-to-trough rotational modulation, not hemisphere means. They cannot be propagated as six independent slice errors. The authors discuss the opposite Callisto hemisphere and attribute it to scatter and their Lambertian assumptions (§4.1); Figure 7 notes errors comparable to the amplitude. Thus the requested assertion of map agreement “within the slices' published uncertainty” cannot be constructed from these tabulated data. Headers record `comparisonStatus: unknown`, a null `ratioUncertainty`, both kernels and the nominal map/slice ratio, without a pass/fail claim. This diagnostic never selects a correction.

## Rejected (checked, not used)

The Cassini-era global maps of Saturn's mid-size moons on the same server (`Iapetus_Cassini_Voyager_mosaic_global_783m.tif`, `Dione_Cassini_Voyager_mosaic_global_154m.tif`, `Tethys_Cassini_mosaic_global_293m.tif`, `Rhea_Cassini_Voyager_mosaic_global_417m.tif`, `Enceladus_Cassini_mosaic_global_110m.tif`) are NASA/JPL/SSI (CICLOPS) cartographic maps with DLR image preparation. The Iapetus map implies a leading/trailing brightness ratio of 0.84 (0.18 mag) at zero phase, while Iapetus's leading hemisphere is famously ~2 mag fainter than its trailing one: the large-scale contrast has been compressed, so these maps are not reflectance maps. Dione's implies 1.04 and its bright ray crater Creusa (49.2°N, 283.7°E) does not stand out. Until the brightness scaling of this series is documented or checked against disk photometry, none of them is used (listed as `rejected` in `surfaces/index.json`).

**Never used:** `*_ClrMosaic*`, `*_ClrMerge*`, `*_FalseColor*` (filter composites with enhancement), `*_HPF*` (high-pass filtered), `Triton_Voyager2_ClrMosaic_GlobalFill_600m.tif` (undocumented gap fill), the `*_airbrush_*` maps (hand-painted).
