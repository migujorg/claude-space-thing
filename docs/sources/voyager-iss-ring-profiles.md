# Saturn ring I/F: Voyager ISS radial profiles (`vg2810-is2_p0001_v01_km010`, `vg2810-is1_p0001_v01_km010`)

**Data:** NASA PDS Ring-Moon Systems Node, volume VG_2810, data set `VG1/VG2-SR-ISS-4-PROFILES-V1.0` (Showalter, M. R. & Gordon, M. K., 2004), `https://pds-rings.seti.org/holdings/volumes/VG_28xx/VG_2810/DATA/`. The pipeline fetches each `.TAB` and its `.LBL` (sha256 recorded) and reads the geometry from the label. The TAB is comma-delimited: radius (km), I/F, and the number of pixels coadded. Instrument paper: Smith, B. A. et al. (1977). Voyager imaging experiment. *Space Science Reviews* 21, 103–127, DOI [10.1007/BF00200847](https://doi.org/10.1007/BF00200847).

| file | side | spacecraft, date | phase | Sun elevation | observer elevation | radii (km) |
|---|---|---|---|---|---|---|
| `IS2_P0001_V01_KM010` | lit | Voyager 2, 1981-08-25 | 47.0° (45.7–48.2 over the mosaic) | 8.05° (incidence 81.95°) | +23.3° (emission 66.7°) | 74 000–138 700 |
| `IS1_P0001_V01_KM010` | unlit | Voyager 1, 1980-11-12 | 46.6° | 3.87° | −11.9° (below the plane) | 74 000–140 600 |

Both use the narrow-angle camera's CLEAR filter (label: 0.46 µm, 0.28–0.64 µm) with 10 km bins; the image resolution is about 5 km. The volume's `PROFILES.TXT` describes the processing: VICAR calibration to I/F (FICOR77) with dark-current subtraction, geometric correction, navigation on ring features, coadding by radius, a baseline offset per scan (empty gaps set to zero), splicing of overlapping scans, and a final radial alignment to the Voyager PPS occultation (VG_2801).

**Use:**
- `rings.json` → `699.reflectanceMeasurements.radialProfiles` (label **measured**), as archived, with the geometry.
- Calibration of Saturn's ring reflectance model (`699.reflectance`, label **estimated**): the lit profile sets the radial modulation and, through its C, B and A ring means, the power-law exponent of the particle phase function; the unlit profile sets the unlit-face effective optical depth and gain (docs/architecture.md §6).
- For solar weighting the CLEAR band is the SVO `Voyager/ISS-NAC.Clear` response (svo-filters.md). Its effective wavelength for sunlight is 474.5 nm.

**Caveats:**
- The archive documentation does not quantify the absolute calibration of the vidicon images.
- In regions without empty gaps the zero level is a baseline matched to neighbouring scans (step 5), not a measurement.
- Each profile is one geometry averaged over a range of ring longitudes. Azimuthal asymmetries (A ring wakes) and spokes are averaged in.
- The Voyager radii and the Cassini UVIS occultation radii (optical depth) differ by up to a few bins at sharp edges. The model therefore treats gaps (τ⊥ < 0.01) and misregistered edges with default values (see the product's `method`).
