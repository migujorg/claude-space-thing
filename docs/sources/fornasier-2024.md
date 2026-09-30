# Fornasier et al. (2024) Phobos photometry from Mars Express HRSC (`fornasier-2024`) — transcription

**Citation:** Fornasier, S., Wargnier, A., Hasselmann, P. H., Tirsch, D., Matz, K.-D., Doressoundiram, A., Gautier, T. & Barucci, M. A. (2024). Phobos photometric properties from Mars Express HRSC observations. *Astronomy & Astrophysics* 686, A203. DOI [10.1051/0004-6361/202449220](https://doi.org/10.1051/0004-6361/202449220). Accepted manuscript arXiv:2403.12156v1 (fetched, sha256 recorded).

**Transcribed** (`tables/fornasier_2024_phobos.json`):
- Table 1 (p. 6): disk-integrated Hapke geometric albedos in the four HRSC colour channels. Blue 0.0714, Green 0.0816, Red 0.0835, IR 0.0877. The opposition parameters B₀ = 2.283 and h = 0.05728 come from the SRC and the roughness is fixed at 24°.
- Table 2 (p. 8): IAU H–G parameters per channel: λc, Δλ, H, G, H_lin, β, q.
- Data coverage (Sec. 2.1): "mostly the 10–100° phase range".

**Checks:**
- H(Green) with the pck00011 radius and V☉ gives an albedo within 5 % of the Hapke value.
- The reconstruction reproduces all four band albedos. The SVO MEX/HRSC photon-counting responses have effective wavelengths of 447, 539, 749 and 957 nm, against λc = 444, 538, 748 and 956 nm in the paper.

**Use and caveats:**
- **Spectrum:** piecewise-linear through the four channels, with photon-counting band averages. Label **estimated**.
- **Phase function:** IAU H–G with G = 0.029 (Green), tabulated over 0–100°. Label **measured**. Its opposition shape is milder than the SRC-measured Hapke surge.
- **Not represented:**
  - Phobos' irregular shape: brightness depends on orientation, and a sphere of the mean radius is assumed.
  - Its red/blue unit contrast, which reaches 65 %.
