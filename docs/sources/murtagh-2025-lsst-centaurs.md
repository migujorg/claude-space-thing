# murtagh-2025-lsst-centaurs: colours and angles of the model Centaurs (LSST predictions)

- **URL:** https://arxiv.org/pdf/2506.02779v1 (cached as `data/raw/papers/arXiv-2506.02779v1.pdf`, sha256 a01efc0849f48e421dbca1cfc7eeb1d6df0b5509b5e6159b9a10eba8fc964493).
- **Citation:** Murtagh, J., Schwamb, M. E., Merritt, S. R., Bernardinelli, P. H., Kurlander, J. A., Cornwall, S., Jurić, M., Fedorets, G. et al. (2025). Predictions of the LSST solar system yield: discovery rates and characterizations of Centaurs. Astronomical Journal 170, 98. DOI:10.3847/1538-3881/ade1db. CC BY 4.0.

## What is used (transcribed in `syn_tables/populations.json`, `centaurs`)

- **Colours** (Sec. 2.3.3, Table 2). The model Centaurs take the colours of (54598) Bienor (less red, LSST g − r = 0.56) and (5145) Pholus (red, g − r = 1.00), in the 3:1 ratio of Wong & Brown (2017). The mean g − r is 0.67. With V − r = 0.41 (g − r) − 0.01 (`jester-2005-sdss`), H_V = H_r + 0.265. The LSST g and r filters are taken as SDSS g and r, a difference of order 0.02 mag.
- **Angles** (Sec. 2.3.1): "As the output angular elements are uncorrelated with each other, and in order to avoid clustering of the orbits, the angular elements ω, Ω, and M are randomized U[0°, 360°)". The synthetic Centaurs do the same.
- **Not used as a number:** their single-slope H distribution (α = 0.42 with N(H_r < 13.7) = 21 400). The stage keeps Kurlander et al.'s own law (the knee law the archive was drawn from), with which the 21 400 was derived.
