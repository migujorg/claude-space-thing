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
- **Rotational variation** (`diskReflectanceModel`, kind `rotation-slices-v1`, label **estimated**): Table 4, transcribed to `pipeline/src/pipeline/photometry/tables/mayorga_2020_table4.csv` (all 17 rows, checked line by line). These are the albedos of six 60° longitude slices of a Lambertian sphere that the authors fitted with PlanetSlicer (Thorngren 2019) to the rotational light curves at 14–24° phase. The GRN slices, divided by their mean, give the factor F on p·Φ at the sub-observer and sub-solar longitudes (Eq. 4; PlanetSlicer's `getG` clipping). Slice j spans −180 + 60j to −120 + 60j degrees (PlanetSlicer's `getPhi`). The paper's longitudes run from −180 to 180 in an "E-W system" without naming the sign; east-positive (SPICE planetocentric, the paper used SpiceyPy) makes the leading hemisphere the brighter one for Io, Europa and Ganymede and the darker one for Callisto, as known from ground-based light curves, and the other sign would invert all four. The label is estimated because the Lambertian slice model is an assumption (the paper finds the moons non-Lambertian), the fit is at 14–24° phase (at 125° the paper finds the Io variation about twice as large), and one filter's slices are applied at all wavelengths.
  - Check (validation, docs/reports/validation.md): at the four New Horizons LORRI views of 2007, F is 0.994, 0.836, 1.058 and 0.970 for Io, Europa, Ganymede and Callisto. With it, the rendered disk-integrated brightness is 0.885, 0.888 and 0.893 of LORRI's for Io, Europa and Ganymede, the same within 1 %, and 0.812 for Callisto. Without it, photometry alone gives 0.896, 1.063, 0.842 and 0.850, and the renderer with the USGS maps (whose longitude contrast then applied) 0.907, 0.943, 0.951 and 0.865. The common ~11 % between this data set and LORRI is bounded below ("The ~11 % offset against New Horizons LORRI").
- **Not represented:**
  - The small wavelength dependence of the phase curves.
  - A narrow opposition surge, which the fits do not resolve.
- The result is in `geometricAlbedoV`: p_V = 0.598 / 0.654 / 0.424 / 0.180 (Io, Europa, Ganymede, Callisto). JPL's compiled albedos, as printed in the Horizons headers, are 0.63 / 0.67 / 0.43 / 0.17.

## The ~11 % offset against New Horizons LORRI

**Observed** (rendered / LORRI, disk-integrated, 2007):

| Body | Phase angle | Rendered / LORRI |
|---|---|---|
| Io | 35.6° | 0.885 |
| Europa | 28.2° | 0.888 |
| Ganymede | 29.0° | 0.893 |
| Callisto | 46.5° | 0.812 |
| Jupiter (same LORRI data set; Karkoschka albedo, ground-based phase curve) | 9.8° | 0.936 |

Each candidate cause was checked with data outside the validation frames. Jupiter is the exception, used only as a cross-check.

1. **Cassini side: aperture losses in the paper's photometry.**
   - **PSF used:** the ISS WAC CL1/GRN extended PSF from the calibration volume (`COISS_0011/calib/xpsf/xpsf_wac_cl1_grn.img`: core by Birath 2006, extended wings by West 2018; fetched into `data/raw/cassini_iss_calib`).
   - **Point sources:** with the paper's apertures (Table 1: 3.5–4.3 px, sky annulus starting at 7.5–7.8 px and 3 px wide), they are recovered to 95.0–95.4 %.
   - **Resolved disks** (aperture 1.05 R, sky annulus from 1.1 R, 3 px wide):

     | Disk radius R | Recovered |
     |---|---|
     | 5 px | 86.5 % |
     | 8 px | 90.9 % |
     | 12 px | 94.0 % |

   - **Small disks** (aperture = base + 0.2 R): 94.7 % at R = 2.5 px and 86.7 % at R = 4.5 px.
   - **Why this biases the albedos:** CISSCAL 3.9's absolute factors refer to the total flux. The 2018 analysis corrects its star photometry for light in the PSF wings (ISS Data User's Guide, COISS_0011 `document/iss_data_user_guide_180916.pdf`, "Absolute Calibration"). The paper applies no aperture correction.
   - **Result:** its reflectances are probably low by 5–13 %, depending on how large each moon appeared. The paper does not give that per image. This caveat is now in the albedo's `uncertainty`.
   - **Cassini-side factor:** 0.87–0.95.
2. **LORRI side: absolute scale.**
   - **The two RSOLAR values:** the 2007 archive headers carry the pre-flight RSOLAR, 2.664 × 10⁵. The cases use Weaver et al.'s (2020) in-flight 2.349 × 10⁵ (HD 37962, 2016), which is 13.4 % lower. Weaver et al. find the sensitivity stable to about 1 % over 2006–2017.
   - **Jupiter cross-check** (same data set): it renders 0.936 with the in-flight value and would render 1.061 with the pre-flight one. Karkoschka's albedo is good to ±4 %, and Jupiter itself varies by a few percent.
   - **Result:** with the in-flight value, LORRI reads 7 ± 5 % above the ground-based scale, i.e. a LORRI-side factor of 1/(1.02–1.12).
   - **LORRI's own PSF** (aperture correction 0.10 mag outside 5 px for point sources) puts ≲ 2 % of the light of these 130–200 px disks outside the ROIs (disk + 6 px). That goes the other way.
3. **Colour term: not the cause.** Y/LORRI band averages from the app's spectra are 0.969 / 0.981 / 0.997 / 1.022 (Io, Europa, Ganymede, Callisto). A steeper violet fall-off for Io, where the reconstruction is unconstrained, changes Io's by 0.4 %. Io, Europa and Ganymede share the offset to 1 % despite colour terms 3 % apart.
4. **Phase-curve normalization: not the cause for Io, Europa and Ganymede.** Their different phase angles (28–36°) give the same offset, which a phase-curve error would not.
   - Callisto, at 46.5° inside the paper's 30–60° data gap, is 8 % lower still, probably from the polynomial there.
   - The Domingue & Verbiscer (1997) Hapke models (Voyager and telescopic data; `photometry/tables/domingue_verbiscer_1997_hapke.csv`), integrated over the disk, are 14–26 % brighter than the paper for Callisto at 46.5°. At small phase, however, they differ from it by −1 % to +37 % depending on the hemisphere, so they are no absolute reference.
5. **Ground-based zero phase: a loose bound only.** JPL's compiled values in the Horizons headers are:

   | | Io | Europa | Ganymede | Callisto |
   |---|---|---|---|---|
   | JPL albedo | 0.63 | 0.67 | 0.43 | 0.17 |
   | App albedo | 0.598 | 0.654 | 0.424 | 0.180 |
   | JPL V(1,0) | −1.68 | −1.41 | −2.09 | −1.05 |
   | App V(1,0) | −1.629 | −1.392 | −2.055 | −0.935 |

   JPL's two compiled sets disagree with each other by up to 0.2 mag (Callisto), so they bound the Cassini scale only to about 5–10 %.

**Bound:** together, items 1 and 2 predict a rendered / LORRI ratio of 0.87–0.95 × 1/(1.02–1.12) = 0.78–0.93. The observed 0.885–0.893, and 0.812 for Callisto with its phase-gap term, fall within that range. The offset is thus accounted for by known calibration systematics.

**Nothing is changed in the data.** The aperture loss depends on per-image moon sizes that are not published. The LORRI-scale evidence rests on a validation frame (Jupiter). Correcting either would be tuning.
