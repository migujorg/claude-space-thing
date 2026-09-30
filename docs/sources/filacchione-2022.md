# Filacchione et al. (2022) VIMS spectrophotometry of Saturn's mid-sized moons (`filacchione-2022`) — transcription

**Citation:** Filacchione, G., Ciarniello, M., D'Aversa, E., Capaccioni, F., Clark, R. N., Buratti, B. J., Helfenstein, P., Stephan, K. & Plainaki, C. (2022). Saturn's icy satellites investigated by Cassini-VIMS. V. Spectrophotometry. *Icarus* 375, 114803. DOI [10.1016/j.icarus.2021.114803](https://doi.org/10.1016/j.icarus.2021.114803). The transcription is from the accepted manuscript arXiv:2111.15541v1 (`https://arxiv.org/pdf/2111.15541v1`, fetched, sha256 recorded). The published version could not be accessed to check that its tables match.

**Why this source:** a single photometric model per wavelength for each of Mimas, Enceladus, Tethys, Dione and Rhea, fitted to all Cassini VIMS pixels with i, e ≤ 70° and 10° ≤ g ≤ 120° over the whole mission. The model is I/F = D(i, e, g)·F(λ, g), with the Akimov disk function D and F = a₀ + a₁g + a₂g² (g in degrees). Because D = 1 everywhere on the disk at g = 0, a₀ is the geometric albedo of the model. It is the only machine-usable source found for both spectra and phase curves of these five moons.

**Transcribed** (`tables/filacchione_2022_tables.csv`): the 14 visible-channel rows (350–1010 nm, about 50 nm apart) of appendix Tables .2–.6, with a₀, a₁, a₂, their errors and χ². They were extracted from the PDF text by a script and checked against it.

**Checks** (`tests/test_photometry_moons.py`):
- a₀ at 549 nm agrees with the abstract's 0.55 µm values (Mimas 0.63 ± 0.02, Enceladus 0.89 ± 0.03, Tethys 0.74 ± 0.03, Dione 0.65 ± 0.03, Rhea 0.60 ± 0.05) within the quoted errors.
- The closed-form disk integral of the Akimov function agrees with numerical quadrature to 10⁻⁶.

**Use and caveats:**
- **Albedo spectrum:** a₀(λ), linearly interpolated. Label **derived**.
- **Phase function:** Φ(α) = F(α)/a₀ · J(α), where J is the disk integral of the Akimov function (`photometry/diskint.py`). It uses the 549 nm row and is tabulated over 0–120°. Label **estimated** for the curve as a whole:
  - 10–120° is the fitted range and is derived from measurements.
  - 0–10° is the paper's own extrapolation of the quadratic, which excludes the opposition surge.
- **Both the albedo and the phase curve exclude the opposition surge**, consistently with each other. Every Earth-based view is at α < 6.5°, where these moons are brighter than predicted here by their surge (tens of percent). See the Horizons comparison in `docs/reports/planet-colors.md`.
- **Not represented:**
  - Leading/trailing hemisphere albedo differences, which reach tens of percent (paper Sec. 5).
  - Phase reddening. Only one phase curve is used for all wavelengths.
