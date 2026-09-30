# Ozone cross-sections: Serdyuchenko et al. (2014) (`serdyuchenko-2014-o3`)

**Data:** IUP Bremen Molecular Spectroscopy Lab, "O3 Spectra (2011)", ASCII file `serdyuchenkogorshelev5digits.dat` (version 25.07.2012, 12.5 MB) from `https://www.iup.uni-bremen.de/gruppen/molspec/downloads/`. Column 1 vacuum wavelength (nm), columns 2–12 absorption cross-section (cm²/molecule) at 293, 283, …, 193 K; 213–1100 nm on a 0.01 nm grid (data page).

**Papers:** Gorshelev, V., et al. (2014), High spectral resolution ozone absorption cross-sections – Part 1, *AMT* 7, 609–624, DOI [10.5194/amt-7-609-2014](https://doi.org/10.5194/amt-7-609-2014); Serdyuchenko, A., et al. (2014), Part 2: Temperature dependence, *AMT* 7, 625–636, DOI [10.5194/amt-7-625-2014](https://doi.org/10.5194/amt-7-625-2014).

**Processing:** vacuum wavelengths converted to standard air (Edlén 1966); each temperature column averaged over the 1 nm bins of the CIE grid; at each altitude interpolated linearly in temperature at the US76 temperature (clamped to 193–293 K). The product's 10 nm samples are box averages of β_O3 over ±5 nm.

**Check:** 5.07e-21 cm² at 600 nm and 223 K (Chappuis maximum); the US76 column gives τ_O3(600 nm) = 0.047.

**Use:** `atmospheres.json` Earth `ozone` component (pure absorber; label **estimated** because of the profile, not the cross-sections).

**Caveats:** data-page systematic uncertainty < 0.5 % (193–293 K); the July 2013 FFT-filtered version differs only below 317 nm, outside the product's range.
