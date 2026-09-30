# heinze-2019-decam: apparent-magnitude distribution of main-belt asteroids to R = 25.6

- **URL:** https://arxiv.org/pdf/1910.13015v1 (cached as `data/raw/papers/arXiv-1910.13015v1.pdf`, sha256 50adf559090423f8d357dc61f8d47e0e4b5714be2d1ddb1c251d06836a251eaf).
- **Citation:** Heinze, A. N., Trollo, J. & Metchev, S. (2019). The flux distribution and sky density of 25th magnitude main belt asteroids. Astronomical Journal 158, 232. DOI:10.3847/1538-3881/ab48fa.

## Role: a cross-check only

The paper gives differential slopes of the apparent R distribution (abstract; Sec. 9.4):

- constant fit: α = 0.28 ± 0.02 for R 20–25.6;
- broken fit: α = 0.218 ± 0.026 for R 20–23.5, and 0.340 ± 0.025 for R 23.5–25.6.

Apparent- and absolute-magnitude slopes are the same only for a single power law (Sec. 9.2), and the authors defer the H distribution to a companion paper. So the `synthetic` stage uses no number from this paper: it is quoted in `syn_tables/populations.json` as an independent check. The bright branch agrees with the slope the stage uses, α2 = 0.23 of `maeda-2021-hsc`.
