# Voyager 2 ISS calibrated images for the validation set (`neptune-voyager2-1989-*`, `uranus-voyager2-1986-*`, `vgiss-user-tutorial`, `vgiss-8xxx-processing`)

**Data:** Voyager 2 narrow-angle camera, calibrated and geometrically corrected **GEOMED** images from the PDS Ring-Moon Systems Node (`https://opus.pds-rings.seti.org/holdings/volumes/VGISS_{7,8}xxx/<volume>/DATA/<folder>/<image>_GEOMED.IMG` + `.LBL`, 2.0 MB each; sha256 per file in the download ledger):
- Neptune, 1989-08-15: C1109146 (VIOLET, 7.68 s), C1109140 (GREEN, 11.52 s), C1109104 (ORANGE, 15.36 s); volume VGISS_8206.
- Uranus, 1986-01-14: C2654450 (VIOLET), C2654456 (BLUE), C2654514 (GREEN), C2654502 (ORANGE); volume VGISS_7204.
- Format: 1000 × 1000 LSB int16 after one VICAR header record; **I/F = DN × `REFLECTANCE_SCALING_FACTOR`** (1.0e-4 for all seven). DN 0 (the blank frame around the resampled area) and saturated values are masked. Mid-exposure = `STOP_TIME` − exposure/2.
- Instrument: Smith, B. A. et al. (1977), *Space Science Reviews* 21, 103–127, DOI [10.1007/BF00200847](https://doi.org/10.1007/BF00200847).

**Calibration:** *VGISS User Tutorial* (`https://opus.pds-rings.seti.org/holdings/documents/VGISS_5xxx/User-Tutorial.txt`) §6.3: FICOR77 with the final VGRSCF.DAT scale factors (corrections of 10–20 % determined around the Uranus and Neptune encounters); "Absolute calibration is still probably no more accurate than 5-10%", and `REFLECTANCE_SCALING_FACTOR` is "accurate to the advertised 5-10% level for the CALIB and GEOMED images". The validation takes 10 % (1σ), fully correlated between filters. *VGISS_8xxx Processing* (`.../VGISS_5xxx/VGISS_8xxx-Processing.txt`): the Neptune scale factors were corrected for the Sun–Neptune distance ((2.8607e9 km / 4.5291e9 km)² relative to Uranus), an error in earlier volumes.

**Geometry:** GEOMED images are resampled so that the reseau marks fall at their true positions; the pixel is 4.4930e-4° (label `HORIZONTAL_PIXEL_FOV`, "quite precise for the GEOMED images") and the internal geometry is "reliable at the level of ~1 pixel" (tutorial §6.1).

**Filters:** SVO `Voyager/ISS-NAC.{Violet,Blue,Green,Orange}`, "digitized from Fig 6 in Smith et al. 1977" (pre-launch, the same nominal curves for both spacecraft), energy-counter weighting (svo-filters.md).

**Consistency seen in the data:** a second ORANGE frame of the Neptune sequence (C1109153, 30.72 s) reads about 5 % higher at the 99th percentile of the disk and has a +0.02 I/F sky offset; the 15.36 s frame, with a sky level near 0, is used.
