# Earth from Deep Impact / EPOXI (`epoxi-hriv-earth-v2`, `epoxi-hriv-earth-index`)

**Data:** EPOXI HRIV Earth observations, calibrated images, DIF-E-HRIV-3/4-EPOXI-EARTH-V2.0, NASA PDS Small Bodies Node (`https://pdssbn.astro.umd.edu/holdings/dif-e-hriv-3_4-epoxi-earth-v2.0/`), version 2.0 (2012-12-31).
- Observations: Livengood, T. A. et al. (2011), *Astrobiology* 11, 907–930, DOI [10.1089/ast.2011.0614](https://doi.org/10.1089/ast.2011.0614).
- Instrument: Hampton, D. L. et al. (2005), *Space Science Reviews* 117, 43–93.
- Calibration: Klaasen, K. P. et al. (2013), *Icarus* 225, 643–680.

**Selection:** 84 "RAD" images (irreversibly calibrated radiance, 512×512, 2.4 MB each; 197 MB in all), chosen from the archive's index table:
- three 24-hour sequences: 2008-03-18/19 (α = 57.7°), 2008-06-04/05 (76.6°) and 2009-03-27/28 (85.9°);
- in each, the 7 filters (350–950 nm) at 4 times spread over the day, as a rotation average.

The May 2008 sequence was not used because the Moon transits the Earth in it. The per-file sha256 values are in the ledger; the SourceRecord carries their combined digest.

**Processing** (`earth.epoxi_photometry`):
- I/F per pixel = radiance × the archive's `MULT2IOF` (its own solar flux per filter).
- Fill values and corrupt pixels (|I/F| > 3) are masked.
- The aperture is centred on the Earth's centroid. Its radius is R_px + 25 px, where R_px = R/(Δ·IFOV) and IFOV = pixel scale / range; the HRIV is defocused.
- The background is the median of the annulus just outside the aperture.
- A = Σ(I/F)/(π R_px²).

**Use:** an independent check only; no product value comes from it.
- Against the product's p(λ)·Φ(α) in the green filter, the ratios are 0.84 at 57.7° and 0.96 at 76.6°.
- At 85.9° the ratio is 1.34, but there the Earth, 186 px in radius, nearly fills the frame and the aperture is clipped.
- The violet/green colour ratio at 57.7° is 1.62, against the product's 1.60.

**Caveats:**
- Different years, seasons and hemispheres from the Himawari scene.
- The 2009 aperture is clipped.
- The HRIV absolute calibration is as archived.

**Validation use (case `earth-moon-epoxi-2008`, `docs/reports/validation.md`):** five more RAD images of the May 2008 sequence, 2008-05-29 02:03:44–02:03:58 UTC (hv08052902_1000117 VIOLET, _1000115 BLUE, _1000116 GREEN, _1000121 ORANGE, _1000119 RED; `data/rad/2008/150/`; 2.4 MB each), when the Moon stood 363 µrad (180 pixels) from the Earth's centre, 11 hours before its transit. Earth and Moon are in the same frames, so their brightness ratio is free of the absolute calibration. I/F = radiance × `MULT2IOF`; mid-time `OBSMIDDT`.
- Calibration accuracy: *EPOXI Calibration Pipeline Summary* (last revised 2014-05-11; DI-C-HRII/HRIV/MRI/ITS-6-DOC-SET-V4.0, `document/calibration/calibration_docs/epoxical_v5_10/epoxi_cal_pipeline_summ.pdf`, `epoxi-cal-pipeline-summary-2014`): "The uncertainty in conversion to absolute radiometric units is estimated to be 5% for HRI-VIS except for the 950-nm filter"; the HRI-VIS is out of focus with a PSF FWHM of ~9 pixels; the 350, 550, 650 and 850 nm filters have red leaks.
- Pixel scale 2.000 µrad (index: 99 034 m per pixel at 49 517 107 km).

