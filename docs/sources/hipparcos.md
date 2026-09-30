# Hipparcos (stars)

Two Hipparcos products are used by the `stars` stage.

## Hipparcos new reduction — `hipparcos-2007`

- **What:** VizieR I/311 `hip2.dat.gz` (117 955 stars): ICRS positions at J1991.25, parallaxes, proper motions
  (μα* = μα cos δ) and their errors, Hp, B − V, solution type.
- **Citation:** van Leeuwen F. 2007, Validation of the new Hipparcos reduction, A&A 474, 653,
  DOI 10.1051/0004-6361:20078357.
- **URL:** `https://cdsarc.cds.unistra.fr/ftp/I/311/hip2.dat.gz` (+ `ReadMe`, whose byte positions the parser
  quotes).
- **Use:** positions of stars Gaia DR3 does not have (most stars brighter than G ≈ 3, e.g. Sirius, Canopus,
  Betelgeuse, Antares) or measures worse (2-parameter solutions; RUWE > 1.4 with a larger propagated
  uncertainty). Propagated from J1991.25 by linear space motion; acceleration terms of the 7/9-parameter
  solutions are not applied (orbital motion is not quadratic over 35 years).

## Hipparcos main catalogue (1997) — `hipparcos-1997`

- **What:** VizieR I/239 `hip_main.dat`: Johnson V (ground-based where available, flag `r_Vmag`), B − V,
  Tycho BT/VT, HD number, spectral type, variability (`VarFlag`) and multiplicity (`MultFlag`, `Ncomp`,
  `CombMag`) flags.
- **Citation:** ESA 1997, The Hipparcos and Tycho Catalogues, ESA SP-1200 (bibcode 1997ESASP1200.....E).
- **URL:** `https://cdsarc.cds.unistra.fr/ftp/I/239/hip_main.dat` (+ `ReadMe`).
- **Use:** (1) measured photometry for the photometric light estimate of stars without a usable spectrum;
  (2) HD numbers to attach Pulkovo spectra to stars; (3) flags in the per-star `flags` byte.
- **Caveats:** `CombMag = '*'` entries give the combined light of a multiple entry; such photometry is not
  applied to a Gaia source that resolves the system (the Gaia component's own photometry is used instead).
