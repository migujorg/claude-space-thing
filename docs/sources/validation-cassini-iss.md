# Cassini ISS calibrated images for the validation set (`saturn-cassini-wac-2016-*`, `cisscal-users-guide-2009`, `naif-cassini-iss-ik-v10`)

**Data:** three Cassini ISS wide-angle-camera frames of Saturn, 2016-04-25 05:55:23–05:56:37 UTC (images W1840258828 RED, W1840258865 GRN, W1840258902 BL1; observation ISS_235SA_SATSTARE001_PRIME), from the PDS Ring-Moon Systems Node's *calibrated* holdings (`https://opus.pds-rings.seti.org/holdings/calibrated/COISS_2xxx/COISS_2104/data/1839950576_1840263036/<image>_CALIB.IMG` + `.LBL`, 4.2 MB each; sha256 per file in `data/raw/_downloads.json`).
- Calibrated by the Node with CISSCAL 4.0beta (label `DESCRIPTION`): bias, dark, non-linearity, flat field, exposure (shutter offset), radiometric conversion, and the sensitivity-vs-time correction; units **I/F** (`UNITS = 'I/F'`), float32 after one VICAR header record.
- Invalid pixels: CISSCAL's ~−1.5e36 markers and line 0 of the product (zeros and junk values) are masked; the reader rejects I/F outside −1…5.
- Instrument: Porco, C. C. et al. (2004), *Space Science Reviews* 115, 363–497, DOI [10.1007/s11214-004-1456-7](https://doi.org/10.1007/s11214-004-1456-7).

**Calibration accuracy:** *CISSCAL User Guide* (Cassini Imaging Central Laboratory for Operations, CICLOPS/Space Science Institute, 2009-03-20; `https://opus.pds-rings.seti.org/holdings/documents/COISS_0xxx/CISSCAL-Users-Guide.pdf`), §5.10.1: the absolute correction factors derived from standard stars "have errors on the order of 10-15%", and "the uncertainty of stellar fluxes is on the order of 10%, so this is the uncertainty we expect to achieve". The validation takes 10 % (1σ) per filter, fully correlated between filters. §5.11: the WAC's pin-cushion distortion moves points "only about a pixel at the image corners" (not corrected; < 0.3 view pixel after 4 × 4 binning).

**Pixel scale:** NAIF instrument kernel `cas_iss_v10.ti` (`https://naif.jpl.nasa.gov/pub/naif/CASSINI/kernels/ik/cas_iss_v10.ti`): WAC focal length 200.77 ± 0.01 mm, 12 µm pixels, 1024 × 1024 → 59.77 µrad per pixel.

**Geometry cross-check:** Horizons (Cassini −82 → Saturn 699, LT) plus pck00011 give sub-spacecraft 28.676°N, 84.123°E and sub-solar 26.112°N, 146.241°E, phase 54.576°, against OPUS's SPICE-derived keywords 28.675°, 84.13°E, 26.112°, 146.244°E, 54.57°.

**Not used:** the Cassini Earth-flyby lunar images (COISS_1001, August 1999). Their calibrated I/F reaches 1.6–1.8 on the Moon, about 25 times too high, consistent with CISSCAL's I/F option normalising to Jupiter's solar distance ("you must specify the solar distance by clicking on either 'Jupiter' or 'Saturn'", guide §5.9.1) rather than the Moon's. The label does not record the distance used, so these products were not corrected and not used.
