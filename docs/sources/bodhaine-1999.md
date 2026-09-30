# Rayleigh optical depth: Bodhaine et al. (1999) (`bodhaine-1999`)

**Paper:** Bodhaine, B. A., Wood, N. B., Dutton, E. G. & Slusser, J. R. (1999). On Rayleigh optical depth calculations. *Journal of Atmospheric and Oceanic Technology* 16, 1854–1861, DOI [10.1175/1520-0426(1999)016<1854:ORODC>2.0.CO;2](https://doi.org/10.1175/1520-0426(1999)016<1854:ORODC>2.0.CO;2). Open full-text page at journals.ametsoc.org; its equations and tables are GIF images (`.../images/full-i1520-0426-16-11-1854-{e5,e6,e18,…,t03,t301}.gif`), which were read directly. The AMS site refuses the pipeline's scripted client (HTTP 403), so the page was saved by hand on 2026-09-30 (sha256 `4028e03c…6ab0`, pinned in the Download).

**What it is:** first-principles Rayleigh scattering of dry air: the Peck & Reeder (1972) refractive index scaled for CO2 (Edlén 1966), the King factor of air from Bates (1984) for N2, O2, Ar and CO2, the cross-section per molecule (Eq. 22), and the optical depth from surface pressure (Eq. 25). Table 3 lists σ, τ at sea level (1013.25 mb, 45°) and at Mauna Loa, and F(air) for 250–1000 nm.

**Transcribed:** `pipeline/src/pipeline/photometry/tables/bodhaine_1999_rayleigh.json`: Eqs. 5, 6 (F(N2), F(O2)), 18–21 (refractive index for 300 and 360 ppm CO2), 22 (σ), 23 (F(air)), 24 (Ns), 25 (τ), 27 (Owens' CO2 index); the appendix constants; Table 2 (CO2 optical depths); Table 3 at every 50 nm from 350 to 850 nm. λ in the formulas is treated as the vacuum wavelength (the dispersion formulas are in vacuum wavenumber); the product evaluates them at the vacuum wavelength of each standard-air sample (Edlén 1966).

**Checks:**
- Our σ reproduces Table 3 to 3e-5 and the King factor to 5e-6 (`tests/test_atmospheres.py`).
- With the US76 column, τ(550 nm) = 0.09713 vs Table 3's 0.09707 (sea level, 45°).
- The Owens CO2 refractivity (Eq. 27) agrees with Bideau-Mehu et al. (1973) to 0.1 % (refractiveindex-info.md).
- Table 2's CO2 optical depths are NOT reproduced by the Section 5 recipe as written (m = 44.01 gives values 28 % lower; the table implies σ_CO2/σ_air = 2.35 at 370 nm vs 2.58 from the refractivities). Not used; reported.

**Use:** `atmospheres.json`: Earth Rayleigh cross-section and depolarization (ρ = 6(F−1)/(3+7F)); Mars CO2 cross-section (Eq. 22 with Eq. 27 and F(CO2) = 1.15); the N2 King factor (Eq. 5) for Titan and Mars.

**Caveats:** dry air with 360 ppm CO2 (current CO2 ~ 420 ppm changes σ by < 0.01 %); water vapour neglected.
