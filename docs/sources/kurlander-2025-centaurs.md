# kurlander-2025-centaurs and kurlander-2025-archive: the debiased Centaur population and its model archive

- **Paper:** https://arxiv.org/pdf/2412.01687v1 (cached as `data/raw/papers/arXiv-2412.01687v1.pdf`, sha256 11def0ffc12414b5d30e1c11be2bbcfab6873ef869f205c21f2f3b90cd51ee24). Kurlander, J. A., Holman, M. J., Bernardinelli, P. H., Jurić, M., Heinze, A. N. & Payne, M. J. (2025). A well-characterized survey for Centaurs in Pan-STARRS1. Astronomical Journal 169, 73. DOI:10.3847/1538-3881/ad9a58. CC BY 4.0.
- **Archive:** https://zenodo.org/api/records/14201491/files/Survey-Debiasing-1.0.1.zip/content (DOI:10.5281/zenodo.14201491, v1.0.1, 2024-11-22; Kurlander, Bernardinelli, Holman, Jurić, Heinze, Payne). Cached as `data/raw/synthetic/Survey-Debiasing-1.0.1.zip`, 110 628 633 bytes, sha256 7cadb55bb6f4ac475b88eeb1baf77fec94a386c2da70f4facee88e42735716d6, retrieved 2026-10-01. MIT licence.

## What is used

- **Normalization** (abstract; Sec. 4.4): "an intrinsic population of 21,400 (+3,400 −2,800) Centaurs with H_r < 13.7". It is a binomial estimate from 44 discoveries in their debiasing zone, with p = 0.209 % of the selected literature population.
- **The literature model** (Sec. 4.4) is the orbital distribution of the Nesvorný et al. (2019) dynamical model (extending Nesvorný & Vokrouhlický 2016), combined with the Lawler et al. (2018) H law: "a knee power law transitions from a slope of α_bright = 0.9 to a slope of α_faint = 0.4 at H = 7.7, and is restricted to H < 13.7".
- **The archive's `literature_states_keps_and_H.pkl`** holds the model members with 21 < m < 23.5 (the paper's debiasing zone): heliocentric states (au, au/day) with the apparent magnitude m, the Keplerian elements (a, e, i, ω, Ω, M) and H_r, for 856 822 members. The notebook gives the size of the whole model: `n_literature_obs = 26116868`. The members span q 5.200–29.4 au and a 5.37–30.0 au; this is the Centaur definition used (q > 5.2 au, a < 30 au; Sec. 1.2, "as defined by the Minor Planet Center").
- **Reading the pickle.** It is opened with an unpickler that accepts only numpy array reconstruction, so nothing in the file can run code (`syn_sources.read_centaur_archive`). The archive's other files (the survey's selection function, a 50 MB k-d tree, and their 320 discoveries) are not used.

## How it is used

`synthetic` stage, population `centaur` (`syn_outer.centaur_realization`, docs/reports/synthetic-populations.md §12.1):

1. Each member's selection probability is P(d) = F(23.5 − d) − F(21 − d), with d = m − H and F the knee law's cumulative fraction. The members are weighted by 1/P to undo the archive's magnitude selection. The weights sum to 25.85 M, 0.990 of the stated model size.
2. In slices of d, the archive's H values follow the knee law as a *differential* law continuous at the knee (χ² per bin 0.92), not the cumulative reading (61.8). This confirms the law as stated.
3. One realization: 21 400 members with (a, e, i) by weighted systematic resampling, H_r by inverse transform, and uniform angles (`murtagh-2025-lsst-centaurs`). H_V = H_r + 0.265.

## Caveats (the paper's and ours)

- The survey accepts the model's marginal a, e, i and H distributions but rejects their joint distribution (Sec. 5.3: fewer Centaurs than the model at a < 18 au, more at 18–20.5 au, more at 10°–15° inclination). The synthetic Centaurs inherit the model's joint distribution.
- The H_r estimate assumes r = w = i colours; Sec. 5.3 notes that offsetting to the mean of r, w and i would lower the population by ~5 %.
- About 1 % of the model (states always brighter than m = 21, at r ≲ 5.6 au) cannot be reconstructed from the archive.
