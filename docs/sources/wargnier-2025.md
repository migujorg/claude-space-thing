# Wargnier et al. (2025) Deimos photometry from Mars Express HRSC/SRC (`wargnier-2025`) — transcription

**Citation:** Wargnier, A., Simon, P. N., Fornasier, S., El-Bez-Sebastien, N., Tirsch, D., Matz, K.-D., Gautier, T., Doressoundiram, A. & Barucci, M. A. (2025). Deimos photometric properties: analysis of 20 years of observations (2004–2024) by the Mars Express HRSC camera. *Astronomy & Astrophysics* 703, A289. DOI [10.1051/0004-6361/202555564](https://doi.org/10.1051/0004-6361/202555564). Accepted manuscript arXiv:2509.12804v1 (fetched, sha256 recorded).

**Transcribed** (`tables/wargnier_2025_deimos.json`): Table 4 (p. 9), row H2012-1THG, the disk-integrated Hapke fit to SRC panchromatic data:
- A_p = 0.080 ± 0.001, A_B = 0.018, q = 0.228;
- w = 0.083, g = −0.274;
- B_sh,0 = 2.14, h_sh = 0.065 and roughness 19.4° held fixed.

The SRC absolute calibration was derived by the authors, with an I/F factor (1.73 ± 0.13)×10⁷ DN/s (Eq. 13).

**Use and caveats:**
- **Albedo:** A_p at all wavelengths. Label **estimated**, and the method says "ASSUMED grey". Deimos' colour is unmeasured here: the paper shows HRSC colour phase curves only as a figure (Fig. 6).
- **Phase function:** **unknown**. The paper gives Hapke 2012 parameters (with porosity and roughness), which this pipeline does not evaluate.
