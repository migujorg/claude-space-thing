# granvik-2018-neo-model: debiased NEO orbit and H distribution (one realization)

- **URL:** https://www.mv.helsinki.fi/home/mgranvik/data/Granvik+_2018_Icarus/Granvik+_2018_Icarus.dat.gz (cached as `data/raw/synthetic/Granvik+_2018_Icarus.dat.gz`, 29 807 870 bytes, sha256 5e6304118a9c408a9715d9a6bcaf9fc816d8606bebc3f61f5e6acab687c947a3, retrieved 2026-09-30). README (`granvik-2018-neo-model-readme`, version 1.1 of 2025-05-13): sha256 f77da926ee1b8a3bb5b5477ed3c97503bf007d683d8571d1dd77a8cd16a23f55.
- **Citation:** Granvik, M., Morbidelli, A., Jedicke, R., Bolin, B., Bottke, W. F., Beshore, E., Vokrouhlický, D., Nesvorný, D. & Michel, P. (2018). Debiased orbit and absolute-magnitude distributions for near-Earth objects. Icarus 312, 181–207. DOI:10.1016/j.icarus.2018.04.018.
- **Licence:** published with the article; the README asks to cite it.

## Contents

802 000 synthetic NEOs with 17 < H < 25, one row each: a [au], e, i [deg], longitude of the ascending node [deg], argument of perihelion [deg], mean anomaly [deg], H (README). Every object has q < 1.3 au and a < 4.2 au. The model constrains the orbital elements (a, e, i) and H; the README gives no epoch for the angles.

## How it is used

`synthetic` stage, population `neo` (`pipeline/src/pipeline/stages/synthetic.py`): the realization is the debiased model. In each (a, e, i, H) cell (a 0.25 au, e 0.1, i 10°, H 0.5 mag) the model count is the number of realization members; the catalogue's NEOs in the cell are subtracted, and the missing ones are shown as realization members, in an order fixed by the cell's seed (`docs/reports/synthetic-populations.md`). Their angles are used as given, as osculating elements at the small-body epoch. The completeness proxy per a-bin is the first H bin in which the catalogue has significantly fewer NEOs than the model (2σ Poisson); no synthetic NEO is brighter.

## Caveats

- The model says nothing about H < 17: no synthetic NEO is brighter than 17.
- One realization: its cell counts carry Poisson noise around the model's expectation.
- The angles are not constrained by the model (they are uniform in the realization, not tied to an epoch), so a synthetic NEO's position along its orbit, and its node and perihelion, are arbitrary samples.

Product-use scope: catalogue-count conditioning and a fitted H proxy do not establish detection probability for a generated orbit or guarantee consistency with all observations. Discovery yield is aggregate under fixed inputs; catalogue refits can change counts and identities. Source survey efficiencies and completeness statements above retain their published domains; the current generator does not apply their pointings or efficiencies as an object veto. [Audited limitations](../reports/synthetic-limitations.md).
