# Neckel & Labs (1994) solar limb darkening (`neckel-labs-1994`) — transcription

**Citation:** Neckel, H. & Labs, D. (1994). Solar limb darkening 1986–1990 (λλ303 to 1099 nm). *Solar Physics* 153, 91–114. DOI [10.1007/BF00712494](https://doi.org/10.1007/BF00712494).

**Why transcribed:** the coefficients exist only as a printed table (no VizieR/CDS or journal machine-readable version was found). The ADS scan `https://articles.adsabs.harvard.edu/pdf/1994SoPh..153...91N` is fetched by the pipeline so its sha256 is recorded.

**What was transcribed:** Table I, p. 98, "Coefficients of limb-darkening functions P5(μ) (Equation (5)) (mean of 1986 and 1987 east-west averages, corrected for scattered light)": 30 continuum wavelengths 303.327–1098.950 nm; N86, N87 (scan counts), A0…A5, F/I. File: `pipeline/src/pipeline/photometry/tables/neckel_labs_1994_table1.csv`. Rendered at 300–600 dpi and read by hand.

**Checks:** every row is tested against the paper's own identities, Eq. 5 (ΣA = 1) and Eq. 6 (F/I = 2 Σ A_k/(k+2)) (`tests/test_photometry_tables.py`). All rows pass within the 5-decimal rounding except one.

**Erratum:** the printed row at 365.875 nm (A2 = 0.17482; checked at 600 dpi) gives ΣA = 0.99800 and F/I = 0.74354 vs the printed 0.7445. Both identities are restored exactly by A2 = 0.17682 (a single-digit typesetting error). The CSV keeps the printed value; `photometry/solar.py` applies the correction (`NL94_ERRATA`) and a test asserts that the printed row fails by exactly this amount. Effect on the channel polynomials is negligible (that wavelength has almost no weight in X, Y, Z, S).

**Use:** per-channel (X, Y, Z, S) I(μ)/I(1) polynomials in `light.json` (`sun.limbDarkening`), label **estimated** (assumes continuum centre-to-limb variation for all wavelengths including lines; linear interpolation of coefficients in λ, across the Balmer jump below 366 nm).
