# Saturn ring phase curves from HST: Salo & French (2010) (`salo-french-2010`)

**Paper:** Salo, H. & French, R. G. (2010). The opposition and tilt effects of Saturn's rings from HST observations. *Icarus* 210, 785–816, DOI [10.1016/j.icarus.2010.07.002](https://doi.org/10.1016/j.icarus.2010.07.002). Text source: the accepted manuscript arXiv:1007.0349v1, fetched as a PDF with sha256 recorded. The data come from HST WFPC2 imaging of Saturn in 1996–2005, processed and calibrated as described by Cuzzi, French & Dones (2002, *Icarus* 158, 199), French et al. (2007a, *Icarus* 189, 493) and French et al. (2007b, *PASP* 119, 623).

**Transcribed:** `pipeline/src/pipeline/photometry/tables/salo_french_2010_table4.csv` holds:
- Table 4, "Log-linear fits to normalized HST phase curves", manuscript p. 69: a and b of I/F = a ln α + b, with α in degrees, fitted for α > 0.25° (data to 6.3°).
- The values cover three regions (C ring 78 000–83 000 km, B ring 100 000–107 000 km, A ring 127 000–129 000 km), five filters (F336W, F439W, F555W, F675W, F814W) and six effective ring elevations Beff (4.5°, 10.2°, 15.4°, 20.1°, 23.6°, 26.1°): 90 rows.
- Table 5's printed I/F(6°) and OE = I(0.5°)/I(6°) (p. 70) sit in the same rows as checks.

The numbers were extracted from the PDF text by a script. Tests check them: a ln 6 + b reproduces every printed I/F(6°) to ≤ 0.0002, and the ratio at 0.5° and 6° reproduces every printed OE to ≤ 0.3 % (`tests/test_ring_reflectance.py`).

The I/F is the paper's geometrically corrected lit-face I/F, (I/F)·(μ+μ0)/(2μ0), at the effective elevation sin Beff = 2μμ0/(μ+μ0) (the paper's Eqs. 1–2). The model inverts it through the same single-scattering reflection formula (the paper's Eq. 6).

**Also used from the paper** (Sec. 3.2): the power-law particle phase function P ∝ (π − α)^n with n = 3.09, "a good match to the phase function of Callisto" (after Dones et al. 1993, *Icarus* 105, 184). The model uses this form between 6.3° and the Voyager anchor at 47°; n is refitted per region, giving 3.5–3.8.

**Use:**
- `rings.json` → `699.reflectanceMeasurements.regionalPhaseCurves` (label **measured**).
- The ϖP tables of `699.reflectance` (label **estimated**) for α ≤ 6.3°, integrated to CIE channels through the WFPC2 PC photon-counting responses (svo-filters.md).

**Caveats:**
- Below α = 0.25° the true-opposition surge (French et al. 2007b) rises more steeply than the log-linear fit; the model's domain starts at 0.25°.
- The fits describe region means. Radial structure inside and between the regions comes from Voyager (voyager-iss-ring-profiles.md).
- The A ring region (127 000–129 000 km) is where the azimuthal wake asymmetry is strong. The HST values are averages over the ansae the paper used.
