# ESA Ocean Colour CCI v6.0 monthly remote-sensing reflectance (`esa-oc-cci-v6-rrs`)

**What:** merged multi-sensor (SeaWiFS, MODIS-Aqua, MERIS, VIIRS, OLCI) Level-3 remote-sensing reflectance Rrs(λ) (sr⁻¹) at 412, 443, 490, 510, 560 and 665 nm. Sensors are band-shifted to common bands and bias-corrected. The grid is 1/24° geographic (8640 × 4320, WGS84 geodetic, latitude descending), as monthly composites. Ocean only. Cells without a valid retrieval in the month are fill: persistent cloud, sea ice, low sun, and some turbid coastal and land-adjacent cells.

**Citation:** Sathyendranath, S. et al. (2023). ESA Ocean Colour Climate Change Initiative (Ocean_Colour_cci): Version 6.0, 4km resolution data. NERC EDS Centre for Environmental Data Analysis. DOI [10.5285/5011d22aae5a4671b0cbc7d05c56c4f0](https://doi.org/10.5285/5011d22aae5a4671b0cbc7d05c56c4f0). Product description: Sathyendranath, S. et al. (2019), *Sensors* 19, 4285, DOI 10.3390/s19194285. Free and open (ESA CCI data policy; cite the dataset).

**Access (no login):** PML THREDDS NetCDF subset service, `https://www.oceancolour.org/thredds/ncss/cci/v6.0-release/geographic/monthly/rrs/<yyyy>/ESACCI-OC-L3S-RRS-MERGED-1M_MONTHLY_4km_GEO_PML_RRS-<yyyymm>-fv6.0.nc`. The six `Rrs_*` variables are fetched at full resolution in four 90° longitude blocks (NetCDF-4, read with h5py) and deleted after use.

**Use (`surf_earth.py`, layer `albedo`):** water-leaving reflectance ρw = π·Rrs at the nearest 4 km cell to each level-4 texel centre. The two grids are nearly the same size (0.0417° vs 0.0439°). Negative Rrs values (atmospheric-correction noise, mostly at 665 nm in clear water) are set to 0 and counted in the header. ρw is the diffuse light leaving the water. Fresnel reflection of sun and sky at the surface is not in it; the renderer adds that from the `water` layer. Labels: brightness **measured**; colour **estimated** (the 560 → 665 nm gap is 105 nm).

**Epoch:** the build uses the most recent September available, 2025-09. That matches the season of the land composite (September 2026). The latest month in the archive at build time was 2026-06, too far from the land composite's season.
