# ashton-2020-jupiter: the debiased population of km-scale retrograde jovian irregular moons

- **URL:** https://arxiv.org/pdf/2009.03382v1 (cached as `data/raw/papers/arXiv-2009.03382v1.pdf`, sha256 62569c321b15d868c0505d95039d50f92da963a715acd0bdcaa0517d0519b12e).
- **Citation:** Ashton, E., Beaudoin, M. & Gladman, B. (2020). The population of kilometer-scale retrograde jovian irregular moons. Planetary Science Journal 1, 52. DOI:10.3847/PSJ/abad95. CC BY 4.0.

## What is used (transcribed in `syn_tables/populations.json`, `irregularMoons.jupiter`)

- **The survey.** A CFHT archival field from 2010 was shifted and stacked. Implanted moons give the detection efficiency, which is 50 % at m_r = 25.7, the "characterisation limit" (Sec. 3.1).
- **The population** (Sec. 3.5, abstract): "160 ± 60 retrograde jovian moons with m_r < 24" and "600 retrograde jovian irregulars (within a factor of 2) down to 25.7th magnitude". The differential luminosity function of the debiased detections from m_r 23.75 to 25.75 has α = 0.29 ± 0.15 (Sec. 3.4). The model used is the 440 moons between m_r 24 and 25.7, distributed with that slope.
- **Calibration** (Table 1): the paper's r magnitudes of 7 known moons (Hermippe 21.8, Erinome 22.4, S/2003 J 16 22.8, Jupiter LIX 23.2, LII 23.6, LXIX 23.8, LI 24.2) against their MPC H give H_V = m_r − 6.37 ± 0.06. This is the median offset; Jupiter LI is a 1.7-mag outlier.

## Caveats

- Retrograde moons only: the direct (prograde) jovians are neither debiased nor modelled (the authors expect their completeness to be worse; Sec. 3.5).
- The total rests on one 1° field 1.5° west of Jupiter, scaled by the known moons' sky distribution over 10 oppositions (a multiplier of 11 ± 5): "within a factor of 2".
- The paper's 2020 statement that the catalogue was complete to m_r ≈ 23.2 is not used. The stage finds the limit of today's catalogue by comparing it with the model.

Product-use scope: catalogue-count conditioning and a fitted H proxy do not establish detection probability for a generated orbit or guarantee consistency with all observations. Discovery yield is aggregate under fixed inputs; catalogue refits can change counts and identities. Source survey efficiencies and completeness statements above retain their published domains; the current generator does not apply their pointings or efficiencies as an object veto. [Audited limitations](../reports/synthetic-limitations.md).
