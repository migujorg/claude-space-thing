# maeda-2021-hsc: debiased absolute-magnitude distribution of small main-belt asteroids

- **URL:** https://arxiv.org/pdf/2110.00178v1 (cached as `data/raw/papers/arXiv-2110.00178v1.pdf`, sha256 20697320cfa4dc49fd900de4b3761a94d645dd6864d27ae92af4332b3af60496).
- **Citation:** Maeda, N., Terai, T., Ohtsuki, K., Yoshida, F., Ishihara, K. & Deyama, T. (2021). Size distributions of bluish and reddish small main-belt asteroids obtained by Subaru/Hyper Suprime-Cam. Astronomical Journal 162, 280. DOI:10.3847/1538-3881/ac2c6e.

## What is used (transcribed in `pipeline/src/pipeline/syn_tables/populations.json`)

Table 3, row "All": a broken power law Σ(H) = dN/dH (Eq. 15). The fit uses 1814 main-belt asteroids, debiased with per-CCD detection efficiencies. The fitted values are:

- α1 = 0.55 (+0.04/−0.01) brighter than H_break;
- α2 = 0.23 ± 0.01 fainter than H_break;
- H_break = 16.69 (+0.04/−0.13) in H_r.

The unbiased sample has R ≤ 3.0 au and H_r ≤ 20.3 (Sec. 3.1). V − r = 0.25 converts to V (Sec. 4.3).

## How it is used

The `synthetic` stage continues the main-belt and Hungaria catalogue fainter than its fitted completeness proxy with dN/dH ∝ 10^(0.23 H) for H_V ≥ 16.94. This is the measured range of the fit, and the default floor H_V = 20.0 lies inside it; the stage refuses floors beyond H_V 20.55. It does not use α1 as a number: brighter than the break, the bright catalogue is assumed representative over most of the belt and is its own measurement. Only in the outer belt, where the reference bin lies just brighter than the break, does the stage use the catalogue's own local slope for the few tenths of a magnitude up to the break.

## Cross-checks

- The catalogue's own slope, where it is assumed representative at these magnitudes (a = 2.12–2.3 au, H 17–18.5), is 0.25; at 2.3–2.5 au, H 17–18.25, it is 0.20. Both match α2.
- Heinze et al. (2019, `heinze-2019-decam`) find an apparent-magnitude slope of 0.218 ± 0.026 for R = 20–23.5, which also matches.
- The paper's total N(H_V < 20) = 8.6 × 10^6 is normalised to ASTORB at H_V = 15.4 through α1, which is steeper than the bright catalogue's own counts between 15.4 and 17 (0.30–0.42). Anchored on the catalogue, the stage's model has N(H_V < 20) = 3.40 × 10^6 (docs/reports/synthetic-populations.md).

Product-use scope: catalogue-count conditioning and a fitted H proxy do not establish detection probability for a generated orbit or guarantee consistency with all observations. Discovery yield is aggregate under fixed inputs; catalogue refits can change counts and identities. Source survey efficiencies and completeness statements above retain their published domains; the current generator does not apply their pointings or efficiencies as an object veto. [Audited limitations](../reports/synthetic-limitations.md).
