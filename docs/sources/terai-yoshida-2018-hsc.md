# terai-yoshida-2018-hsc: size distribution of small Hilda asteroids

- **URL:** https://arxiv.org/pdf/1805.09445v1 (cached as `data/raw/papers/arXiv-1805.09445v1.pdf`, sha256 8ba1b01a617dae48c30d7032b83ffb1b0a7542533419dcef7d93b6433df55c32).
- **Citation:** Terai, T. & Yoshida, F. (2018). Size distribution of small Hilda asteroids. Astronomical Journal 156, 30. DOI:10.3847/1538-3881/aac81b.

## What is used (transcribed in `pipeline/src/pipeline/syn_tables/populations.json`)

- **Slope:** α = 0.38 ± 0.02 in the differential absolute-magnitude distribution, a single power law over ~1–10 km (abstract; Sec. 3.2, Eq. 3).
- **Sample:** unbiased for r < 4.9 au and H < 18.0 (Fig. 3 caption).
- **Colour:** m_V − m_r = 0.25, from the SDSS MOC4 Hildas (Sec. 3.2).

## How it is used

The `synthetic` stage continues the Hilda-region catalogue (3.7–4.2 au, q ≥ 1.3 au) fainter than its fitted completeness proxy with α = 0.38, down to H_V = 18.0 + 0.25 = 18.25.

Product-use scope: catalogue-count conditioning and a fitted H proxy do not establish detection probability for a generated orbit or guarantee consistency with all observations. Discovery yield is aggregate under fixed inputs; catalogue refits can change counts and identities. Source survey efficiencies and completeness statements above retain their published domains; the current generator does not apply their pointings or efficiencies as an object veto. [Audited limitations](../reports/synthetic-limitations.md).
