# hendler-malhotra-2020: observational completion limit H_lim(a)

- **URL:** https://arxiv.org/pdf/2010.07822v1 (cached as `data/raw/papers/arXiv-2010.07822v1.pdf`, sha256 f345e85a18da8f1daadf386f7aeafa19eb8f548a05397f950d68abfcf9e401bf).
- **Citation:** Hendler, N. P. & Malhotra, R. (2020). Observational completion limit of minor planets from the asteroid belt to Jupiter Trojans. Planetary Science Journal 1, 75. DOI:10.3847/PSJ/abbe25.

## What is used (transcribed in `pipeline/src/pipeline/syn_tables/populations.json`)

- **The method** (Sec. 3.1): in each semimajor-axis bin, H_lim is the centre of the most populated H bin (0.25 mag). Its uncertainty is (H_max − H_min)/√n (Sec. 3.2). Bin widths from 0.002 to 0.05 au give the same result (Sec. 3.2).
- **The model** (Eq. 5): H_lim(a) = −5 log10(a (a − 1 au)) + C, from a flux-limited survey near opposition.
- **The regions** of Table 1 (Hungarias 1.78–2.0 au, main belt 2.12–3.25, Hildas 3.92–4.004, Trojans 5.095–5.319) are the fit ranges. The C values of Table 1 (2019 catalogue: main belt 20.28 ± 0.03) are kept for comparison only.

## How it is used

The `synthetic` stage refits C on every build, in each region, to the current catalogue: the per-bin peaks in 0.01-au bins with ≥ 50 objects, and the weighted least-squares C. That is the maximum-likelihood value for Gaussian errors, which the paper samples with MCMC. With the 2026-09-30 SBDB snapshot C = 21.357 ± 0.012 for the main belt, one magnitude deeper than in 2019. That catalogue has 1.44 M main-belt objects; the paper's had 0.78 M. Synthetic objects fill only H ≥ H_lim(a) of their a-bin.

## Caveat

The peak marks where completeness starts falling faster than the population rises (Sec. 3.1, 4), so the bin just brighter than H_lim can already be a few per cent incomplete. The stage therefore anchors the extrapolation one bin brighter, at [H_lim − 1, H_lim − 0.5).
