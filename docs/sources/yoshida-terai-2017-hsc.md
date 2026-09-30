# yoshida-terai-2017-hsc: size distribution of small Jupiter Trojans

- **URL:** https://arxiv.org/pdf/1706.10017v1 (cached as `data/raw/papers/arXiv-1706.10017v1.pdf`, sha256 ee2af234c6bc386ad784533c65341afe07ae1d9e669ae8b7c68b97705aca8f8a).
- **Citation:** Yoshida, F. & Terai, T. (2017). Small Jupiter Trojans survey with Subaru/Hyper Suprime-Cam. Astronomical Journal 154, 71. DOI:10.3847/1538-3881/aa7d03.

## What is used (transcribed in `pipeline/src/pipeline/syn_tables/populations.json`)

- **Slope:** α = 0.37 ± 0.01 for N(H) ∝ 10^(αH), from 481 L4 Trojans (abstract). It is a single power law for 13.0 ≲ H_r ≲ 17.4 (Sec. 4), and for a single power law the differential slope is the same.
- **Colour:** V − r = 0.25, the value the authors use (from Szabó et al. 2007) to join their sample to the MPC catalogue (Sec. 4).

## How it is used

The `synthetic` stage continues the Jupiter-Trojan catalogue beyond its completeness limit (C refitted per build, Hendler & Malhotra 2020) with α = 0.37, down to H_V = 17.4 + 0.25 = 17.65. That is the faint end of the measured range. It applies the L4 slope to both swarms.
