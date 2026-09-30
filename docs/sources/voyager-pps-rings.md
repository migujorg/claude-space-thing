# Uranus and Neptune ring optical depth: Voyager 2 PPS occultations (`vg2801-pu2-epsilon-system`, `vg2801-pn1-system`)

**Data:** NASA PDS Ring-Moon Systems Node, volume VG_2801 (data set `VG2-SR/UR/NR-PPS-2/4-OCC-V1.0`), EASYDATA resampled profiles (2003), `https://pds-rings.seti.org/holdings/volumes/VG_28xx/VG_2801/EASYDATA/`. The columns are radius, mean signal, its standard deviation, normal optical depth, and the lower and upper limits of the 68 % confidence interval. The `.TAB` and `.LBL` are fetched with sha256 recorded, and the label is parsed for the geometry.

- **Uranus:** `KM001/PU2P01XE`, the β Per egress occultation of 1986-01-24, whole ring system 37 750–53 500 km at 1 km, 264 nm, ring-plane elevation 53.2°. Instrument paper: Lane, A. L. et al. (1986). *Science* 233, 65–70, DOI [10.1126/science.233.4759.65](https://doi.org/10.1126/science.233.4759.65).
- **Neptune:** `KM005/PN1P01`, the σ Sgr ingress occultation of 1989-08-24/25, 42 500–76 000 km at 5 km, 264 nm, ring-plane elevation 19.3°. Instrument paper: Lane, A. L. et al. (1989). *Science* 246, 1450–1454, DOI [10.1126/science.246.4936.1450](https://doi.org/10.1126/science.246.4936.1450).

**Use** (`rings.json` → `799`, `899`, label **measured**): radius and normal optical depth. The per-bin 68 % intervals are summarized in `uncertainty` (median half-width) to keep the product small.

**Caveats:**
- Each profile is one cut. The Uranian rings are eccentric and vary in width and τ around each ring; in this cut the ε ring lies near 51 480–51 590 km. Neptune's Adams ring arcs vary with longitude and time.
- At 1 km the narrow Uranian rings (a few km wide, except ε) are barely resolved, so the peak τ values are smoothed.
