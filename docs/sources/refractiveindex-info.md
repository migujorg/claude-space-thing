# Gas refractive indices via refractiveindex.info (`peck-khanna-1966-n2`, `bideau-mehu-1973-co2`)

**Database:** Polyanskiy, M. N., refractiveindex.info database (CC0), GitHub `polyanskiy/refractiveindex.info-database`, files fetched from raw.githubusercontent.com (sha256 in the download ledger). Each file gives the primary reference and a dispersion formula; "formula 6" is n − 1 = C1 + Σ C_i/(C_{i+1} − λ^−2), λ in µm.

- **N2:** `database/data/main/N2/nk/Peck-0C.yml` — Peck, E. R. & Khanna, B. N. (1966). Dispersion of nitrogen. *J. Opt. Soc. Am.* 56, 1059–1063, DOI [10.1364/JOSA.56.001059](https://doi.org/10.1364/JOSA.56.001059). 0 °C, 101.325 kPa; n − 1 = 6.8552e-5 + 3.243157e-2/(144 − λ^−2), fitted 0.4679–2.0587 µm. Used for the N2 Rayleigh cross-section (Titan; the non-CO2 part of Mars), with Loschmidt's number density at 0 °C and Bodhaine's F(N2); extrapolated below 468 nm.
- **CO2:** `database/data/main/CO2/nk/Bideau-Mehu.yml` — Bideau-Mehu, A., et al. (1973). Interferometric determination of the refractive index of carbon dioxide in the ultraviolet region. *Opt. Commun.* 9, 432–434, DOI [10.1016/0030-4018(73)90289-7](https://doi.org/10.1016/0030-4018(73)90289-7). 0 °C, 101.325 kPa. Used only to check Owens' CO2 refractivity (Bodhaine Eq. 27): agreement to 0.1 % at 400–830 nm after scaling 15 → 0 °C.

**Caveat:** secondary transcriptions of the primary formulas (the JOSA and Optics Communications papers are not open access); the formulas' coefficients are as printed there.
