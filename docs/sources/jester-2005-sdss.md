# jester-2005-sdss: transformation from SDSS g, r to Johnson V

- **URL:** https://arxiv.org/pdf/astro-ph/0506022v1 (cached as `data/raw/papers/arXiv-astro-ph-0506022v1.pdf`, sha256 e3859932465623d368e18fc04666c614d737a607e0c01ebfc13cd0f60f384bea).
- **Citation:** Jester, S., Schneider, D. P., Richards, G. T. et al. (2005). The SDSS view of the Palomar-Green bright quasar survey. Astronomical Journal 130, 873–895. DOI:10.1086/432466.

## What is used

Table 1, "All stars with R−I < 1.15": V = g − 0.59 (g − r) − 0.01, rms 0.01. It is transcribed in `pipeline/src/pipeline/syn_tables/populations.json`. With the mean CFEPS colour g − r = 0.70 (`petit-2011-cfeps`), the `synthetic` stage gets H_V = H_g − 0.423 for the CFEPS L7 model objects.

## Caveat

The relation is fitted to stars. TNOs are reddish, like K stars, which are inside the fitted range. CFEPS used the MegaCam g' filter, not SDSS g. Both approximations are of order 0.1 mag.
