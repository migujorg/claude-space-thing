# Night lights: DNB spectral response and CIE lamp spectra (`noaa20-viirs-dnb-rsr`, `cie-illuminants-hp`, `cie-illuminants-led`)

The Black Marble layer (`surfaces/399/night`) stores **radiance in the VIIRS Day/Night Band** (DNB, about 500–900 nm), because that is what was measured. To turn it into luminance, the renderer needs the spectrum of the light. That spectrum is not measured. Street lighting is a changing mix of high-pressure sodium and white LEDs. The header therefore gives conversion factors for two standard CIE lamp spectra (`constants.toXYZS`), and the colour label is **estimated**.

**Definition:** DNB radiance = ∫ L(λ) RSR(λ) dλ, with the RSR normalized to peak 1. Factor_c = K_c ∫ S(λ) obs_c(λ) dλ / ∫ S(λ) RSR(λ) dλ × 10⁻⁵, since 1 nW cm⁻² sr⁻¹ = 10⁻⁵ W m⁻² sr⁻¹. Here obs = x̄, ȳ, z̄ (K_m = 683.002 lm/W) and V′ (K′_m = 1700.06 lm/W). The result is in cd m⁻² per nW cm⁻² sr⁻¹. For HP1 the Y factor is ≈ 0.0053; for LED-B3 it is ≈ 0.0051.

**Caveat:** the CIE tables end at 780 nm, but the DNB responds out to ~900 nm. Lamp emission beyond 780 nm is therefore missing from the DNB integral, for example the strong 819 nm sodium lines of HPS lamps. As a result the factors are upper limits.

- **`noaa20-viirs-dnb-rsr`:** NOAA/NESDIS STAR and the JPSS VIIRS Data Analysis Working Group (2016). J1 (NOAA-20) VIIRS RSR DAWG At-Launch Public Release V2.1 (Nov 2016). The file used is `J1_VIIRS_RSR_DNBLGS_BA_Fused_V2FS.txt` (band-averaged, fused, low-gain stage), inside `https://ncc.nesdis.noaa.gov/NOAA-20/docs/J1_VIIRS_RSR_DAWG_At-Launch_Public_Release_V2.1_Nov2016.zip`. Public domain.
- **`cie-illuminants-hp`:** CIE (2018). Relative spectral power distributions of high pressure discharge lamp illuminants (HP1 = standard high-pressure sodium), 380–780 nm in 5 nm steps. DOI [10.25039/CIE.DS.f6rvvnev](https://doi.org/10.25039/CIE.DS.f6rvvnev). Source: CIE 015:2018 Colorimetry, 4th ed., Table 11.
- **`cie-illuminants-led`:** CIE (2018). Relative spectral power distributions of illuminants representing typical LED lamps, 1 nm (LED-B3 = phosphor-converted white LED, ≈ 4000 K). Source: CIE 015:2018 (DOI 10.25039/TR.015.2018).

Both CIE tables are checked against the sha256 and column sums published in their metadata files (`*_metadata_v2.json` / `*_metadata.json`). Columns are found by the metadata's column titles, because the CSV files have no header row. Interpolation is linear with zero outside the table, as the metadata specifies. Licence CC BY-SA 4.0.
