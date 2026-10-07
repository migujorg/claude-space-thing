# cfeps-l7-synthetic-model: the CFEPS L7 debiased Kuiper-belt model (v0.9)

- **URL:** https://www.cfeps.net/L7Release/L7SyntheticModel-v09.txt.gz (page https://www.cfeps.net/?page_id=105; cached as `data/raw/synthetic/L7SyntheticModel-v09.txt.gz`, 1 665 683 bytes, sha256 b48f692043fdaa979d08bb82f896039d3998c400fa029cfc312212d17f65e247, retrieved 2026-09-30).
- **Citation:** Petit, J.-M., Kavelaars, J. J., Gladman, B. J. et al. (2011). The Canada-France Ecliptic Plane Survey — Full data release: the orbital structure of the Kuiper belt. AJ 142, 131. DOI:10.1088/0004-6256/142/4/131. Gladman, B., Lawler, S. M., Petit, J.-M. et al. (2012). The resonant trans-Neptunian populations. AJ 144, 23. DOI:10.1088/0004-6256/144/1/23. Kavelaars, J. J., Jones, R. L., Gladman, B. J. et al. (2009). AJ 137, 4917. DOI:10.1088/0004-6256/137/6/4917.
- **Licence:** BSD-style, copyright 2007 J.-M. Petit, J. J. Kavelaars and B. J. Gladman (file header).

## Contents

66 037 model objects to H_g = 8.5: a, e, i, node, argument of perihelion, mean anomaly (au, degrees), H_g, then the heliocentric distance and the component (classical inner/main/outer, resonant with the resonance, scattering). Header: epoch of elements JD 2453157.5, longitude of Neptune λN = 5.489. The page: "our debiased model of the Kuiper Belt's true orbital distribution, sampled to give a calibrated number of TNOs down to H_g magnitude 8.5".

## How it is used

`synthetic` stage, population `tno`:

- **λN is in radians.** 5.489 rad = 314.50°; the stage computes Neptune's mean longitude at JD 2453157.5 from DE442s (314.42°) and fails the build if they differ by more than 2°. So the file is in the real sky frame at its epoch.
- **Epoch.** Each object's mean anomaly is advanced two-body (GM_sun) from the model epoch to the small-body epoch; a resonant object keeps its resonant geometry because Neptune moves by the same mean-motion ratio.
- **H_g → H_V.** H_V = H_g − (0.59 (g − r) + 0.01) = H_g − 0.423, with the mean CFEPS colour g − r = 0.70 (`petit-2011-cfeps`) and the star-based SDSS transformation of `jester-2005-sdss`. The faint limit H_g 8.5 becomes H_V 8.077.
- **Conditioning.** As for NEOs: cells of a (1 au to 50 au, then 5, 25 and 100 au), e 0.1, i 5°, H 0.5; the known TNOs in each cell are subtracted; the completeness proxy per a-bin is the first H bin with significantly fewer known TNOs than the model.

## Caveats (the page's own, and ours)

- Components with q > 100 au are absent; the resonance borders and the hot classical belt near ν8 are not precisely modelled (page).
- The model includes only resonances with a CFEPS detection; others are missing from the synthetic layer.
- The CFEPS g filter is MegaCam g'; applying the SDSS g transformation to it is an approximation of order 0.1 mag.

Product-use scope: catalogue-count conditioning and a fitted H proxy do not establish detection probability for a generated orbit or guarantee consistency with all observations. Discovery yield is aggregate under fixed inputs; catalogue refits can change counts and identities. Source survey efficiencies and completeness statements above retain their published domains; the current generator does not apply their pointings or efficiencies as an object veto. [Audited limitations](../reports/synthetic-limitations.md).
