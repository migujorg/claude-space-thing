# ashton-2021-saturn: the debiased population of Saturn's irregular moons to D = 2.8 km

- **URL:** https://iopscience.iop.org/article/10.3847/PSJ/ac0979/pdf. The publisher serves scripted clients a bot check, so the copy was fetched with a browser user agent on 2026-10-01 and is cached as `data/raw/papers/Ashton-2021-PSJ-2-158.pdf` (1 185 248 bytes, sha256 79d364f5b1e0fc504e4fda3073e6daea7fb4bf2be802d48deb403dfe870f3b5a; the stage accepts only that digest).
- **Citation:** Ashton, E., Gladman, B. & Beaudoin, M. (2021). Evidence for a recent collision in Saturn's irregular moon population. Planetary Science Journal 2, 158. DOI:10.3847/PSJ/ac0979. CC BY 4.0.

## What is used (transcribed in `syn_tables/populations.json`, `irregularMoons.saturn`)

- **The survey** (Sec. 2–3): CFHT, July 2019, two 1.1 deg² fields beside Saturn, shift and stack to m_w ≈ 26.3 (w ≈ g + r + i). The detection efficiency is measured per sky-brightness region.
- **The population** (abstract; Sec. 3.5): "150 ± 30 moons down to D = 2.8 km" (the deep sample, m_w = 26.3). The size distribution from D 3.8 to 2.8 km (m_w 25.7–26.3) has differential index q = 4.9 (+0.7/−0.6) (Sec. 3.6). With one albedo for all moons, N(<m) ∝ 10^((q − 1) m / 5) = 10^(0.78 m).
- **Calibration** (Tables 1–2): the paper's w magnitudes of 22 known moons found in the MPC list give H_V = m_w − 9.98 ± 0.05 (robust σ 0.17). Phoebe is excluded (saturated), and 10 provisional designations renumbered since are not found.

## Caveats

- The model spans only 0.6 mag (D 3.8–2.8 km). The layer adds nothing fainter than m_w 26.3 (H_V 16.32).
- The authors' own 2021 statement, that the catalogue is "very likely fully complete down to D = 5 km and nearly fully complete down to D = 3.5 km", predates the 2023 discoveries. The stage compares the model with today's MPC list instead: the catalogue is short of the model only at H_V 16.0–16.32.
