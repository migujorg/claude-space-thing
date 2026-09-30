# DeColibus et al. (2026) spectra of the Uranian moons (`decolibus-2026-data`, `decolibus-2026`)

**Data:** DeColibus, R., Cartwright, R., Grundy, W., Buratti, B., Hicks, M. & Mishra, I. (2026). Optical Spectra of the Large Uranian Moons (v1). Zenodo, DOI [10.5281/zenodo.18745327](https://doi.org/10.5281/zenodo.18745327), CC BY 4.0. File `VIS_Uranian_Moons_accepted.tar` (8.3 MB). It is fetched, and its md5 is checked against the value Zenodo publishes. The pipeline reads the tar members directly.

**Paper:** DeColibus, R. A., Cartwright, R. J., Grundy, W. M., Buratti, B. J., Hicks, M. D. & Mishra, I. (2026). Optical spectroscopy of the Uranian moons from equinox to northern summer. *The Planetary Science Journal* 7, 67. DOI [10.3847/PSJ/ae4a1b](https://doi.org/10.3847/PSJ/ae4a1b). The publisher answers scripted downloads with a bot-check page. The sha256 in `sources.json` is that of the copy retrieved by hand on 2026-09-30, which a build accepts if it is placed at `data/raw/papers/DeColibus2026_PSJ7_67.pdf`.

**Used from the dataset:**
- The "All" grand-average disk-integrated reflectance spectra of Ariel, Umbriel, Titania and Oberon: Palomar DBSP and LDT DeVeny, 2002–2024, all longitudes, 0.35–1.0 µm, normalized to 1 at 0.628–0.632 µm.
- The ReadMe's recommended scaling to geometric albedo at 0.628–0.632 µm: Ariel 0.546, Umbriel 0.262, Titania 0.361, Oberon 0.320, "digitized from Figure 7 of Karkoschka (2001)", HST F631N. The pipeline parses these from the ReadMe.
- The TMO B, V, R photometry of Titania and Oberon, used only for checks.

**Transcribed** (`tables/karkoschka_2001_uranian_phase.json`): the phase function the paper applies (Sec. 2.4, p. 9): Δm = βα + 0.5α/(α₀ + α), with α₀ = 0.5° and β = 0.023 mag/deg from Karkoschka (2001, *Icarus* 151, 51, DOI [10.1006/icar.2001.6596](https://doi.org/10.1006/icar.2001.6596)), "for both Titania and Oberon".

**Checks:**
- The formula reproduces every oppmag − corrmag correction in the dataset's `Titania_phot_mags.csv` and `Oberon_phot_mags.csv` (B, V, R) to 0.0015 mag.
- The dataset's TMO B and V geometric albedos agree with the band averages of the scaled spectra within 7 %.

**Use and caveats:**
- **Spectra:** the grand average × the ReadMe albedo. Label **derived**. The level rests on values digitized from a figure (±~5 %). Spectral slopes are trusted only over 0.4–0.9 µm (ReadMe). The disk radius is taken as the pck00011 radius (Thomas 1988, as in the paper).
- **Phase function:**
  - Titania and Oberon: the K2001 function, tabulated to 3.1°, the largest phase angle seen from Earth. Label **measured**.
  - Ariel and Umbriel: the same function, **estimated**, because their own parameters were not available.
  - It includes the strong, narrow opposition surge: 0.4 mag between 0° and 1.5°.
- These surge-inclusive HST albedos are 0.2–0.5 mag brighter than the older Voyager-based V(1,0) in JPL Horizons. The paper attributes the Voyager deficit to missing small-phase data.
