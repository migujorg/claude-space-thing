# Mayorga et al. (2020) Cassini phase curves of the Galilean satellites (`mayorga-2020`) — transcription

**Citation:** Mayorga, L. C., Charbonneau, D. & Thorngren, D. P. (2020). Reflected light observations of the Galilean satellites from Cassini: a test bed for cold terrestrial exoplanets. *Astronomical Journal* 160, 238. DOI [10.3847/1538-3881/abb8df](https://doi.org/10.3847/1538-3881/abb8df). Accepted manuscript arXiv:2009.05467v1 (`https://arxiv.org/pdf/2009.05467v1`, fetched, sha256 recorded).

**Why this source:** the only set of disk-integrated phase curves of all four Galilean satellites from one calibrated instrument over a wide phase range (Table 3 samples 1.025–140.582°; 3299 Cassini ISS WAC and 329 NAC images from the 2000–2001 Jupiter flyby, CISSCAL 3.9 radiometric calibration, not re-scaled to any reference spectrum). The zero-phase value of each fit is the geometric albedo in that filter.

**Transcribed** (`pipeline/src/pipeline/photometry/tables/mayorga_2020_table5.csv`): Table 5, the best-fit polynomials f(α) = Σ cᵢαⁱ (α in degrees) for Io (VIO, GRN, RED, CB2, CB3), Europa (VIO, GRN, RED, CB2), Ganymede (all five), Callisto (VIO, GRN, RED). Checked line by line, with signs, against the PDF text.

**Checks** (`tests/test_photometry_moons.py`):
- Every polynomial satisfies the paper's constraint f(180°) = 0 to < 0.002. A mistyped high-order coefficient would break this, because c₅·180⁵ ≈ 2×10¹¹·c₅.
- The SVO Cassini ISS WAC system responses, band-averaged with photon weighting (T·E☉·λ), reproduce the paper's Table 2 effective wavelengths (420, 568, 647, 752, 939 nm) to 1 nm.

**Use and caveats:**
- **Albedo spectrum:** piecewise-linear p(λ) with nodes at the filters' effective wavelengths, solved so that every photon-weighted band average equals c₀. It is held constant beyond the end nodes: below 420 nm for all four moons, beyond 752 nm for Europa and beyond 647 nm for Callisto. Label **estimated**, because the shape between nodes is an assumption. The disk radius is taken as the pck00011 mean radius; the paper used SPICE shapes.
- **Phase function:** the GRN (568 nm) curve f(α)/f(0), tabulated over the adopted domain 0–130°; footnote a of Table 5 reports that the tabulated fits differ by at most 0.05% over that range and discourages extrapolation beyond the observations. Label **measured**. This adopted fit domain is separate from measurement coverage. The complete machine-readable Table 3 contains 36 measurements at 30–60°: 17 WAC GRN and 17 WAC CB2 measurements of Ganymede near 52–53°, plus one NAC GRN measurement each of Ganymede (52.935°) and Callisto (45.570°). It also contains 68 NAC GRN measurements above 135° (Io, Europa and Ganymede), reaching 140.582°. Coverage remains sparse and differs by moon and filter; see the recount below.
- **Rotational variation** (`diskReflectanceModel`, kind `rotation-slices-v1`, label **estimated**): Table 4, transcribed to `pipeline/src/pipeline/photometry/tables/mayorga_2020_table4.csv` (all 17 rows, checked line by line). These are the albedos of six 60° longitude slices of a Lambertian sphere that the authors fitted with PlanetSlicer (Thorngren 2019) to the rotational light curves at 14–24° phase. The GRN slices, divided by their mean, give the factor F on p·Φ at the sub-observer and sub-solar longitudes (Eq. 4; PlanetSlicer's `getG` clipping). Slice j spans −180 + 60j to −120 + 60j degrees (PlanetSlicer's `getPhi`). The paper's longitudes run from −180 to 180 in an "E-W system" without naming the sign; east-positive (SPICE planetocentric, the paper used SpiceyPy) makes the leading hemisphere the brighter one for Io, Europa and Ganymede and the darker one for Callisto, as known from ground-based light curves, and the other sign would invert all four. The label is estimated because the Lambertian slice model is an assumption (the paper finds the moons non-Lambertian), the fit is at 14–24° phase (at 125° the paper finds the Io variation about twice as large), and one filter's slices are applied at all wavelengths.
  - Check (validation, docs/reports/validation.md): at the four New Horizons LORRI views of 2007, F is 0.994, 0.836, 1.058 and 0.970 for Io, Europa, Ganymede and Callisto. With it, the rendered disk-integrated brightness is 0.885, 0.888 and 0.893 of LORRI's for Io, Europa and Ganymede, the same within 1 %, and 0.812 for Callisto. Without it, photometry alone gives 0.896, 1.063, 0.842 and 0.850, and the renderer with the USGS maps (whose longitude contrast then applied) 0.907, 0.943, 0.951 and 0.865. The common ~11 % between this data set and LORRI remains unresolved; findings and limits are recorded below ("The ~11 % offset against New Horizons LORRI").
- **Not represented:**
  - The small wavelength dependence of the phase curves.
  - A narrow opposition surge, which the fits do not resolve.
- The result is in `geometricAlbedoV`: p_V = 0.598 / 0.654 / 0.424 / 0.180 (Io, Europa, Ganymede, Callisto). JPL's compiled albedos, as printed in the Horizons headers, are 0.63 / 0.67 / 0.43 / 0.17.

## Measurement coverage (Mayorga et al. 2020, machine-readable Table 3)

Recounted from all 8000 rows of [Table 3, CDS J/AJ/160/238](https://cdsarc.cds.unistra.fr/ftp/J/AJ/160/238/table3.dat.gz), using the catalogue's byte layout. The ranges below are minimum and maximum observed phase, **not continuous coverage**. The last column lists every gap greater than 10° between successive distinct sampled phases, combining WAC and NAC; endpoints are rounded to 0.001°. The 10° threshold only keeps the table readable, and smaller gaps are not listed. GRN, VIO and RED are CL1/filter pairs; CB2 and CB3 are filter/CL2 pairs. The adopted GRN fit remains tabulated over 0–130° regardless of these endpoints and gaps.

| Moon | Filter | Rows | Phase range (°) | Rows at 30–60° | Rows >135° | Adjacent-sample gaps >10° |
|---|---|---:|---|---:|---:|---|
| Io | CB2 | 328 | 5.123–127.217 | 0 | 0 | 17.735–71.533, 72.115–89.461, 90.505–108.662, 112.495–126.126 |
| Io | CB3 | 188 | 5.122–15.821 | 0 | 0 | none |
| Io | GRN | 673 | 5.123–140.339 | 0 | 33 | 20.565–61.684, 72.825–89.463, 127.327–137.521 |
| Io | RED | 565 | 1.045–127.302 | 0 | 0 | 20.565–61.684, 61.684–77.479, 77.479–94.663 |
| Io | VIO | 585 | 1.025–126.956 | 0 | 0 | 20.565–61.685, 61.685–75.677, 75.677–94.656 |
| Europa | CB2 | 343 | 4.412–126.780 | 0 | 0 | 17.902–106.335 |
| Europa | GRN | 667 | 1.805–140.495 | 0 | 16 | 20.735–77.276, 77.327–103.813, 126.782–137.722 |
| Europa | RED | 599 | 4.407–126.746 | 0 | 0 | 20.735–77.276, 77.327–103.820, 103.820–114.859 |
| Europa | VIO | 622 | 1.816–126.789 | 0 | 0 | 20.735–77.166, 77.327–103.792, 104.024–114.862 |
| Ganymede | CB2 | 293 | 3.459–125.346 | 17 | 0 | 17.717–51.854, 52.771–108.280, 108.788–124.297 |
| Ganymede | CB3 | 202 | 3.460–17.708 | 0 | 0 | none |
| Ganymede | GRN | 635 | 3.462–140.582 | 18 | 19 | 21.007–51.860, 52.935–77.573, 77.619–108.189, 125.411–138.879 |
| Ganymede | RED | 564 | 3.460–125.415 | 0 | 0 | 21.007–77.573, 77.619–115.621 |
| Ganymede | VIO | 574 | 3.462–125.428 | 0 | 0 | 21.007–77.572, 77.619–115.604 |
| Callisto | GRN | 393 | 6.338–100.060 | 1 | 0 | 21.550–45.570, 45.570–95.460 |
| Callisto | RED | 373 | 6.340–100.062 | 0 | 0 | 21.550–100.062 |
| Callisto | VIO | 396 | 6.142–100.055 | 0 | 0 | 21.550–99.832 |

Callisto's intermediate GRN point is NAC image `N1356767122_1.IMG` at 45.5704749°; its WAC GRN measurements jump from 21.550° to 100.060°. The combined-camera table also includes NAC GRN at 95.460°, so the next measurement after 45.570° is not the WAC point at 100.060°. These sparse measurements do not establish the accuracy of the fitted brightness between sampled phases, or a correction to the LORRI comparison.

## The ~11 % offset against New Horizons LORRI

**Finding, not a calibration resolution:** most of the deficit is already present in disk photometry. The independent CPU calculation of the reflected-light contract (§4.3 of `docs/architecture.md`), including the emitted GRN phase table and rotation slices, gives the following values for the four 2007 LORRI cases. Y is the mean radiance over each enclosing validation rectangle, including sky, before the eye model; it is not the mean over the illuminated disk alone.

| Body | Phase (°) | Contract Y (cd/m²) | LORRI-derived expected Y (cd/m²) | Contract / expected | Recorded rendered / contract |
|---|---:|---:|---:|---:|---:|
| Io | 35.629 | 310.076 | 348.169 | 0.890591 | 0.993951 |
| Europa | 28.221 | 362.113 | 407.374 | 0.888896 | 0.998306 |
| Ganymede | 29.006 | 266.467 | 299.208 | 0.890576 | 1.001624 |
| Callisto | 46.490 | 53.443 | 64.852 | 0.824085 | 0.984220 |

These are the retained `galilean-dim` investigation's `numbers.json` results, checked against the emitted photometry. Its independent calculation and the app CPU implementation agree to floating-point precision. The first three contract/expected ratios average **0.890021**, with a **0.191%** max/min spread. Thus a common ~11% deficit precedes rendering; the recorded renderer residuals are much smaller. Callisto has a further **7.4%** deficit relative to that common ratio, plus a recorded renderer shortfall of about **1.6%** relative to its contract. The renderer values are historical report measurements, not a new GPU run. The CPU agreement checks arithmetic, not the correctness of either absolute scale or the assumed phase/rotation/spectral model.

### LORRI calibration and exposure correction are supported

[Weaver et al. (2020), Table 2, PDF p.18; §§3.2–3.3, pp.22–33](https://arxiv.org/pdf/2001.03524v1) gives the adopted diffuse solar-spectrum responsivity **RSOLAR = 234900** for 1×1 images. July 2016 HD 37962 measurements set the absolute throughput; HD 205905 agrees independently. The ground-measured response shape is retained, and the standard-star apertures are corrected to infinite aperture. The abstract and Table 5 (p.36) state about **2% (1σ)** absolute accuracy for solar-type spectra; pp.25–27 separately discuss a few-percent aperture-to-total uncertainty and about 10% for non-solar spectra. Monitoring M7 and NGC 3532 found sensitivity stable at about **1%** over 2006–2017. This supports applying the in-flight scale to 2007, but that application is an inference from stability, not an explicit instruction in the paper to replace the Jupiter archive headers. The inspected documents do not supply a separately quantified diffuse-only error.

The old **266400** responsivity is documented in the [New Horizons SOC Instrument Interface Control Document, Table 9-5, PDF pp.50–51; §9.3.9, p.60](https://opus.pds-rings.seti.org/holdings/volumes/NHxxLO_xxxx/NHPELO_2001/document/soc_inst_icd.pdf). Its ratio to 234900 is **1.1341**: reverting would raise model/reference ratios by 13.4%, close to the discrepancy. That numerical coincidence is a diagnostic, not evidence that the pre-flight scale is correct. Jupiter's comparison in the same validation data set is also a validation observation, not an independent calibration of LORRI.

[Spencer & Weaver (February 2020), slides 2–7](https://opus.pds-rings.seti.org/holdings/documents/NHxxLO_xxxx/LORRI-True-Exposure-Times.pdf) supports the adopted **+0.6 ms** correction to commanded/header exposure times. Two 2007 Io image pairs imply offsets of 0.58–0.59 ms; slide 6 records the adopted correction and FITS-pipeline update. Slide 7 explains the hardware/software timing difference, **0.616 ms**, for all exposures. Using 0.616 rather than 0.600 ms changes these four reference radiances by less than **0.45%**, too little to explain 11%. The slides give no formal ±0.01-ms uncertainty, and the update date alone does not establish that every product archived in 2020 already has corrected exposure keywords. The reader's archive-year condition is an implementation shortcut, not a documented product-by-product audit.

### Cassini aperture losses remain a plausible, unquantified bias

[Mayorga et al. (2020), §§2.1–2.2/Table 1, pp.3–4](https://arxiv.org/pdf/2009.05467v1) uses CISSCAL 3.9 radiometric correction factors without rescaling to a reference spectrum. The empirical base apertures aim to collect **95%** of the light; the base sky annulus begins at the radius containing 99.7%, with a width of 3 pixels. Apertures grow by 0.2R for small disks and become 1.05R for resolved R > 5 pixels, with the inner sky annulus at 1.1R. No explicit total-flux aperture correction is described.

The [Cassini ISS Data User's Guide (2018), §4.3, pp.92–95; §5, pp.128–148](https://opus.pds-rings.seti.org/holdings/volumes/COISS_0xxx/COISS_0011/document/iss_data_user_guide_180916.pdf) describes total-flux calibration: correcting stellar PSF wings and summing satellite light over the frame. Its Table 13 (p.148) gives WAC GRN scatter of **4.14%**; p.146 recommends a floor of about **3%** for the best-calibrated filters. These are empirical calibration estimates, not uncertainties on Mayorga's phase fits. A finite aperture against total-flux calibration makes lost moon light plausible. However, Table 3 omits the per-image disk radius, summation, exposure and aperture, and the paper does not pin calibration-file hashes. Neither research lane established actual losses for those images or verified the earlier **5–13%** estimate as an image-specific bound. This does not demonstrate that aperture loss explains the full common deficit. Mayorga's §4.5 comparisons (pp.16–17) concern normalized spectra and rotational-curve shapes, not an independent absolute-scale check.

### Compiled ground magnitudes supply a loose comparison

[Urban & Seidelmann (eds., 2013), *Explanatory Supplement*, Table 10.6, book p.413, as reproduced in the USNO errata, PDF p.5](https://aa.usno.navy.mil/downloads/exp_supp_errata.pdf) supplies the compiled V(1,0) magnitudes below. App predictions use emitted p_V and radius, the cited Willmer (2018) solar V magnitude, and longitude-averaged flux (rotation factor F = 1). Johnson V is a filter integral, distinct from photopic Y.

| Body | App V(1,0) | Compiled V(1,0) | App / compiled flux |
|---|---:|---:|---:|
| Io | −1.6294 | −1.68 | 0.9545 |
| Europa | −1.3917 | −1.41 | 0.9832 |
| Ganymede | −2.0550 | −2.09 | 0.9683 |
| Callisto | −0.9349 | −1.05 | 0.8994 |

The retained `galilean-calibration/earth_comparison.json` calculation therefore differs by about **2–5%** for Io, Europa and Ganymede, and **10%** for Callisto. These rounded compilations are not independent precision photometry with an established uncertainty. Opposition behavior and historical zero-point conventions limit the comparison. It does not support a uniform 1/0.89 gain, but it cannot precisely exclude a bias at the spacecraft phases. Horizons apparent magnitudes are predictions from a published phase law, not new brightness measurements; the research lane reproduced them with the Supplement errata's coefficients. They cannot independently calibrate the app's phase/rotation model.

### Phase, rotation and spectral transfer remain unresolved

All four LORRI views lie between well-sampled Cassini phase clusters, as shown by the complete [machine-readable Mayorga Table 3, CDS J/AJ/160/238](https://cdsarc.cds.unistra.fr/ftp/J/AJ/160/238/table3.dat.gz) and the coverage recount above. Europa and Ganymede at 28–29° are already beyond their low-phase GRN samples (ending at 20.735° and 21.007°). Io's GRN gap is 20.565–61.684°. Ganymede has measurements near 52–53°; Callisto has one NAC GRN point at 45.570°, but its WAC GRN samples jump from 21.550° to 100.060°. That single nearby NAC point samples a different hemisphere and has no tabulated uncertainty; it does not establish the fit error at Callisto's LORRI view. Equal ratios at different phases do not exclude phase-fit or rotational-continuation errors. The rotation slices were fitted at 14–24° and continued to these views, and the spectrum is reconstructed between and beyond broadband filter nodes. Arithmetic colour-term checks do not establish the true spectrum at those geometries.

**What would settle the scale:** an independently calibrated, full-aperture, disk-integrated visible spectrum of Europa near **28–30°** phase, with observer/Sun hemisphere geometry specified and absolute uncertainty **≤2–3%**, would distinguish the competing flux levels at the relevant phase. Reduce it against external standards and total encircled energy, then integrate through both Cassini GRN and LORRI passbands. A suitably matched archived Voyager or Galileo observation could serve if its independent absolute calibration is established. Recovering the actual Cassini image geometry and aperture losses would separately test that candidate bias.

**No factor is applied.** The common deficit is located mainly before rendering, but its cause is not uniquely assigned: absolute calibration, sparsely sampled phase fits, rotation continuation and spectral transfer remain limited. Retain the source-supported LORRI calibration and published Cassini photometry until independent measurements or an image-specific re-reduction justify a change. Neither agreement with validation frames nor loose compiled magnitudes can select a calibration or a uniform 11% multiplier.
