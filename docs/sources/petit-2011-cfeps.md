# petit-2011-cfeps: CFEPS full data release (mean g − r of the sample)

- **URL:** https://arxiv.org/pdf/1108.4836v1 (cached as `data/raw/papers/arXiv-1108.4836v1.pdf`, sha256 a5d3b8d84fe31c0ac6b7b05e6c5048054437e0311bca1199c9611b5e87785af7).
- **Citation:** Petit, J.-M., Kavelaars, J. J., Gladman, B. J. et al. (2011). The Canada-France Ecliptic Plane Survey — Full data release: the orbital structure of the Kuiper belt. Astronomical Journal 142, 131. DOI:10.1088/0004-6256/142/4/131.

## What is used

"a color of (g − r) = 0.70, corresponding to the mean (g − r) color of our full CFEPS sample" (Sec. 2, arXiv v1 p. 4, lines 72–73). This value is transcribed in `pipeline/src/pipeline/syn_tables/populations.json`. With `jester-2005-sdss` it converts the CFEPS L7 model's H_g to H_V (`cfeps-l7-synthetic-model`).

This paper is also one of the references the CFEPS page asks users of the L7 model to cite.
