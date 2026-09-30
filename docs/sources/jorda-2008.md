# jorda-2008: Jorda, Crovisier & Green (2008): water production rate from the visual magnitude

- **URL:** https://www.lpi.usra.edu/meetings/acm2008/pdf/8046.pdf (cached as `data/raw/papers/acm2008-8046.pdf`, 115 198 bytes, sha256 fc4925d3cb74ad65f3137a2197109652bec0f06aed8fb87af3da5063887197cb; retrieved 2026-09-30).
- **Citation:** Jorda, L., Crovisier, J. & Green, D. W. E. (2008). The correlation between visual magnitudes and water production rates. Asteroids, Comets, Meteors 2008, LPI Contribution No. 1405, paper 8046.

## Contents

Regression of log Q[H2O] on the heliocentric visual magnitude m_H = m_V − 5 log Δ for 234 measurements of 37 comets (Nançay OH, ICQ magnitudes): log Q[H2O] = 30.675 − 0.2453 m_H, with Q[H2O] = 1.1 Q[OH]; residual RMS 0.19 dex (factor 1.6).

## How it is used

Transcribed into `comet_tables/activity.json` (waterFromMagnitude). With m_H = M1 + K1 log r it gives every comet's water production at every r, hence Q(OH) and, through the measured ratios, the gas bands and Afρ.

## Caveats

- A population relation: an individual comet can lie a factor 2–4 off.
