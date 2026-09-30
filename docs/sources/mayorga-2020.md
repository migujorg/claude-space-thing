# Mayorga et al. (2020) Cassini phase curves of the Galilean satellites (`mayorga-2020`) — transcription

**Citation:** Mayorga, L. C., Charbonneau, D. & Thorngren, D. P. (2020). Reflected light observations of the Galilean satellites from Cassini: a test bed for cold terrestrial exoplanets. *Astronomical Journal* 160, 238. DOI [10.3847/1538-3881/abb8df](https://doi.org/10.3847/1538-3881/abb8df). Accepted manuscript arXiv:2009.05467v1 (`https://arxiv.org/pdf/2009.05467v1`, fetched, sha256 recorded).

**Why this source:** the only set of disk-integrated phase curves of all four Galilean satellites from one calibrated instrument over a wide phase range (0–135°, 3299 Cassini ISS WAC and 329 NAC images from the 2000–2001 Jupiter flyby, CISSCAL 3.9 radiometric calibration, not re-scaled to any reference spectrum). The zero-phase value of each fit is the geometric albedo in that filter.

**Transcribed** (`pipeline/src/pipeline/photometry/tables/mayorga_2020_table5.csv`): Table 5, the best-fit polynomials f(α) = Σ cᵢαⁱ (α in degrees) for Io (VIO, GRN, RED, CB2, CB3), Europa (VIO, GRN, RED, CB2), Ganymede (all five), Callisto (VIO, GRN, RED). Checked line by line, with signs, against the PDF text.

**Checks** (`tests/test_photometry_moons.py`):
- Every polynomial satisfies the paper's constraint f(180°) = 0 to < 0.002. A mistyped high-order coefficient would break this, because c₅·180⁵ ≈ 2×10¹¹·c₅.
- The SVO Cassini ISS WAC system responses, band-averaged with photon weighting (T·E☉·λ), reproduce the paper's Table 2 effective wavelengths (420, 568, 647, 752, 939 nm) to 1 nm.

**Use and caveats:**
- **Albedo spectrum:** piecewise-linear p(λ) with nodes at the filters' effective wavelengths, solved so that every photon-weighted band average equals c₀. It is held constant beyond the end nodes: below 420 nm for all four moons, beyond 752 nm for Europa and beyond 647 nm for Callisto. Label **estimated**, because the shape between nodes is an assumption. The disk radius is taken as the pck00011 mean radius; the paper used SPICE shapes.
- **Phase function:** the GRN (568 nm) curve f(α)/f(0), tabulated over 0–130°, the range the paper recommends (footnote a of Table 5). Label **measured**. There are no data at 30–60°, and none beyond 135°.
- **Not represented:**
  - The rotational (orbital-longitude) variation, which the paper fits separately (Table 4). It reaches 16 % peak to peak for Io at low phase and 38 % at high phase.
  - The small wavelength dependence of the phase curves.
  - A narrow opposition surge, which the fits do not resolve.
- The result is in `geometricAlbedoV`: p_V = 0.598 / 0.654 / 0.424 / 0.180 (Io, Europa, Ganymede, Callisto). JPL's compiled albedos, as printed in the Horizons headers, are 0.63 / 0.67 / 0.43 / 0.17.
