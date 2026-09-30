# Mallama, Krobusek & Pavlov (2017) broadband albedos (`mallama-2017`) — transcription

**Citation:** Mallama, A., Krobusek, B. & Pavlov, H. (2017). Comprehensive wide-band magnitudes and albedos for the planets, with applications to exo-planets and Planet Nine. *Icarus* 282, 19–33. DOI [10.1016/j.icarus.2016.09.023](https://doi.org/10.1016/j.icarus.2016.09.023). Preprint arXiv:1609.05048v1 (fetched, sha256 recorded).

**Transcribed:** Table 7 ("Geometric albedos"), Johnson-Cousins U B V R I Rc Ic and Sloan u′ g′ r′ i′ z′ for Mercury–Neptune, into `pipeline/src/pipeline/photometry/tables/mallama_2017_table7.csv` (arXiv p. 16). Per Tables 3 and 5 of the paper, several entries are *synthetic* (computed by the authors from others' spectra), not photometric: Mercury U B R I Rc Ic; Venus U; Earth all; Saturn Rc Ic; Uranus and Neptune I; Rc and Ic of Mars. This is noted in the CSV header.

**Use:**
- **Mars spectrum:** the photometric Johnson U, B, V, R, I albedos (0.060, 0.088, 0.170, 0.288, 0.330; from Mallama 2007's photometry, rotation- and season-averaged) define a piecewise-linear p(λ) with nodes at the bands' solar-weighted effective wavelengths, solved exactly (`albedo.broadband_reconstruction`). Label **estimated** (shape between nodes assumed). Filter curves: SVO `Generic/Johnson.*`.
- Everywhere else: independent comparison only (report and tests), never an input.
