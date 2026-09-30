# LROC WAC Hapke photometric parameter maps (`lroc-wac-hapke-parameters`)

**What:** Hapke parameters fitted to ~66,000 WAC multispectral observations (2010-02 to 2011-10) in 1° × 1° cells, 70°S–70°N, for each of the 7 WAC bands: w (single-scattering albedo), b and c (double Henyey–Greenstein phase function), B_C0 and h_c (coherent backscatter, fixed at 0 and 1), B_S0 and h_s (shadow-hiding opposition effect), θ̄ (roughness, fixed at 23.657°), φ (filling factor). One 63-band float32 file, 12.7 MB.

**Citation:** Sato, H., Robinson, M. S., Hapke, B., Denevi, B. W. & Boyd, A. K. (2014). Resolved Hapke parameter maps of the Moon. *JGR Planets* 119, 1775–1805. DOI [10.1002/2013JE004580](https://doi.org/10.1002/2013JE004580). Model: Hapke, B. (2012), *Theory of Reflectance and Emittance Spectroscopy*, 2nd ed., Cambridge University Press, DOI [10.1017/CBO9781139025683](https://doi.org/10.1017/CBO9781139025683).

**File:** `https://pds.mcp.nasa.gov/data/store/img/lunar_reconnaissance_orbiter/pds4/lroc/lro-l-lroc-5-rdr/LROLRC_2001/DATA/SDP/WAC_HAPKEPARAMMAP/WAC_HAPKEPARAMMAP_7BAND.IMG`.

**Label discrepancies found:**
- The PDS4 label gives the array offset as 1440 bytes; the attached PDS3 label (`^IMAGE = 6`, `RECORD_BYTES = 1440`) and the file size (7200 + 63 × 140 × 360 × 4 bytes) say 7200. We use 7200.
- The PDS4 `upperleft_corner_x/y` values are off by half a pixel/sign relative to the PDS3 `LINE/SAMPLE_PROJECTION_OFFSET` (69.5, −0.5), which put the cell edges on integer degrees. We use the PDS3 values.
- The README says φ is "fixed at 1.0"; the file contains 0.0. Either reading gives porosity factor K = 1 (Hapke's K(φ) → 1 as φ → 0 and is undefined for φ ≥ 0.752), which is what `surf_hapke.py` uses.
- Several cells have h_s = 0 or 0.2 and c = 1.1994 (fit bounds).

**Use:** (1) conversion of `lroc-wac-hapke-7band` to normal albedo (see that note); (2) exported unchanged as the Moon's `hapke` layer (level 0, nearest 1° cell; channels w, b, c, B_S0, h_s per band; constants in the header). Label **measured** (fitted product).

**Implementation check (`tests/test_surf_color_hapke.py`):** Hapke's H-function approximation reproduces Chandrasekhar's H(1) = 2.9078 for w = 1 within 1 %; the roughness correction is neutral at normal geometry and azimuth-independent at e = 0; with θ̄ → 0 the model reduces to the smooth-surface textbook form; median 643 nm parameters give I/F(60°, 0°, 60°) ≈ 0.05.
