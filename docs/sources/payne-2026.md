# Payne et al. (2026) composite geometric-albedo spectra (`payne-2026-mercury`, `-venus`, `-earth`)

**Citation:** Payne, A., Villanueva, G. L., Kofman, V., Fauchez, T. J., Faggi, S., Mandell, A. M., Roberge, A. & Alei, E. (2026). A comprehensive spectroscopic reference of the solar system and its application to exoplanet direct imaging. *The Planetary Science Journal* 7, 51. DOI [10.3847/PSJ/ae2feb](https://doi.org/10.3847/PSJ/ae2feb) (arXiv:2508.13368). Data: Zenodo, DOI [10.5281/zenodo.17470005](https://doi.org/10.5281/zenodo.17470005), CC BY 4.0.

**Files:** `https://zenodo.org/api/records/17470005/files/<body>_albedo.csv/content` (wavelength µm, geometric albedo). Each file's md5 is checked against the checksum in the Zenodo record metadata, which is also fetched.

**What each composite is in 360–830 nm (Payne et al. Secs. 3–5, Tables 1–3):**
- **Mercury:** MESSENGER/MASCS global-mean reflectance (Izenberg et al. 2014), ×2 to match Mallama et al. (2017) broadband geometric albedos. Disk-resolved and photometrically standardized, not a zero-phase disk integral.
- **Venus:** MESSENGER/VIRS equatorial I/F from the 2007 flyby (Pérez-Hoyos et al. 2018, a NEMESIS fit), ×1.13 to Venus's p_V = 0.689 (Mallama et al. 2017).
- **Earth:** Planetary Spectrum Generator simulation (Kofman et al. 2024) of 2022 June 21 driven by MERRA-2 and MODIS, validated against DSCOVR/EPIC narrow bands. A **model**. Since the M3 follow-up it is no longer the Earth's albedo, which is now measured (himawari9-ahi.md). Only its relative shape below 0.47 µm is used, where Himawari has no band, and it serves as a cross-check: its p_V of 0.216 is close to the measured 0.239.

All three are labelled **estimated**. The Mars composite (a PSG model) was examined and **not used**: its Johnson B albedo is ~45 % below Mallama et al.'s photometry.

**Why used anyway:** no machine-readable measured zero-phase disk-integrated visible spectra were found for these bodies; the NASA ASDC archive holding DSCOVR/EPIC L1B images (from which Earth's disk-integrated albedo could be measured directly) refused connections from this build environment. See `docs/reports/planet-colors.md` for the resulting Earth discrepancy (p_V 0.22 vs Mallama's 0.434) and Venus's uncertain blue end.
