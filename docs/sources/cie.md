# CIE observer tables (`cie-1931-2deg-cmf`, `cie-1951-scotopic`)

**What:** the CIE 1931 2° colour-matching functions x̄, ȳ, z̄ (360–830 nm, 1 nm) and the CIE scotopic spectral luminous efficiency V′(λ) (380–780 nm, 1 nm), wavelengths in standard air.

**Citation:**
- CIE (2019). *Colour-matching functions of CIE 1931 standard colorimetric observer.* Data table, DOI [10.25039/CIE.DS.xvudnb9b](https://doi.org/10.25039/CIE.DS.xvudnb9b). Original source: CIE 018:2019 *The Basis of Physical Photometry*, 3rd ed., Table 6 (DOI 10.25039/TR.018.2019); standard ISO/CIE 11664-1:2019.
- CIE (2019). *CIE spectral luminous efficiency for scotopic vision.* Data table, DOI [10.25039/CIE.DS.gr6w4b5g](https://doi.org/10.25039/CIE.DS.gr6w4b5g). Original source: CIE 018:2019, Table 2.
- K_m = 683.002 lm/W and K′_m = 1700.06 lm/W from the text of CIE 018:2019 / CIE 015:2018 (not in the CSVs).

**Files (fetched by `pipeline/src/pipeline/cie.py`):**
- `https://files.cie.co.at/Publications-datasets/CIE_xyz_1931_2deg.csv` (+ `_metadata.json`)
- `https://files.cie.co.at/Publications-datasets/CIE_sle_scotopic.csv` (+ `_metadata.json`)

Landing pages: `cie.co.at/datatable/cie-1931-colour-matching-functions-2-degree-observer`, `cie.co.at/datatable/cie-spectral-luminous-efficiency-scotopic-vision` (the older `.../cie-scotopic-luminous-efficiency-function` URL is a 404). Licence CC BY-SA 4.0.

**Verification:** each CSV's sha256 is compared with the checksum the CIE publishes in its metadata JSON, and the column sums with the metadata's `sumOfColumns` validation. `tests/test_cie.py` confirms the official tables equal the `colour-science` 0.4.7 transcription previously used, to < 1e-9, inside 380–780 nm (V′) and 360–830 nm (CMFs).

**One difference from the previous implementation:** the scotopic table has no rows below 380 or above 780 nm. The CIE metadata says `extrapolationMethod: "zero"`; `colour-science`'s `align()` held the edge values instead (5.89e-4 at 360–379 nm). The change affects scotopic integrals of sunlight by < 0.02 %.
