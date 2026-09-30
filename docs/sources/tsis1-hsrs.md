# TSIS-1 Hybrid Solar Reference Spectrum, version 2 (`tsis1-hsrs-v2`)

**What:** solar spectral irradiance at 1 AU, 202–2730 nm, 0.1 nm resolution sampled every 0.025 nm, with per-point uncertainties; vacuum wavelengths; W m⁻² nm⁻¹. Normalized to TSIS-1 SIM (average of 2019 December 1–7, solar minimum) and scaled by 0.999061 to TSIS-1 TIM TSI.

**Citation:** Coddington, O. M., Richard, E. C., Harber, D., Pilewskie, P., Woods, T. N., Snow, M., Chance, K., Liu, X. & Sun, K. (2023). Version 2 of the TSIS-1 Hybrid Solar Reference Spectrum and extension to the full spectrum. *Earth and Space Science* 10, e2022EA002637. DOI [10.1029/2022EA002637](https://doi.org/10.1029/2022EA002637). Method: Coddington et al. (2021), *GRL* 48, e2020GL091709, DOI 10.1029/2020GL091709.

**File:** `https://lasp.colorado.edu/lisird/resources/lasp/hsrs/v2/hybrid_reference_spectrum_p1nm_resolution_c2022-11-30_with_unc.nc` (netCDF4/HDF5, 2.4 MB; LISIRD dataset `tsis1_hsrs_p1nm`). Read with `h5py` (datasets `Vacuum Wavelength`, `SSI`, `SSI_UNC`).

**Processing (`photometry/solar.py`):** vacuum → standard-air wavelengths with Edlén (1966) (`edlen-1966`; standard air is exactly the CIE's "λ in standard air"), transforming the per-nm density so energy is conserved; exact averages over 1 nm bins centred on the 360–830 nm CIE grid (no point sampling of Fraunhofer lines).

**Results and sanity checks:** Y = 134 647 lux, (x, y) = (0.3216, 0.3320), S = 319 825 scotopic lux; integral 202–2730 nm = 1325.76 W/m² = 97.4 % of the IAU 2015 B3 nominal TSI of 1361 W/m² (the remainder lies outside the covered range); 360–830 nm = 739.39 W/m². The vacuum→air conversion changes Y by +0.01 %. Independent check (tests only): the WHI 2008 reference spectrum (Woods et al. 2009, GRL 36, L01101, DOI 10.1029/2008GL036373; LISIRD `whi_ref_spectra`) gives Y = 133 001 lux and the same chromaticity to 0.0004; the 1.2 % difference is the known TSIS-1 vs SORCE SIM scale difference.

**Uncertainty:** 0.3 % (460–2365 nm), 1.3 % elsewhere (dataset metadata). Solar-cycle variability in the visible is ~0.1 %.
