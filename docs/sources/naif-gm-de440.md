# naif-gm-de440: NAIF GM kernel `gm_de440.tpc`

- **URL:** https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/gm_de440.tpc
- **Used by:** the `bodies` stage, for `gm` (km³/s²) in `app/public/data/bodies.json`.
- **Label:** `measured`. Mass parameters are fitted quantities of the ephemeris and satellite solutions.
- **Citation:** gm_de440.tpc (B. Semenov, NAIF, 2022-12-14), derived from JPL Horizons `gm_Horizons.pck` (J. D. Giorgini, 2022-11-28).
  - **Barycenters 1–10 and bodies 199, 299, 301, 399:** DE440 values, from Park et al. (2021), *AJ* 161, 105, DOI:10.3847/1538-3881/abd414.
  - **Planet GMs 499–999:** the JPL natural-satellite ephemeris releases, https://ssd.jpl.nasa.gov/ftp/sats/.

## Notes

- **Planet versus system GM:** `gm` is the planet's own GM (`BODY599_GM`), not the system barycenter's (`BODY5_GM`). For Mercury and Venus the two are identical.
- **Pluto:** `BODY999_GM` is Pluto alone; Charon is `BODY901_GM`.
- **Moons:** the GM order is
  1. `BODYnnn_GM` from this file when it is > 0;
  2. else a GM > 0 published in the moon's satellite kernel comments ("Bodies on the File" or "Additional Constants on the File", the value used by the JPL integration); in the build of 2026-09-30 that applies only to Styx (905, from plu060);
  3. else `unknown`.

  A GM of 0 in either place means the body was integrated as massless, which is not a measurement of its mass: gm_de440.tpc lists BODY905_GM = 0, and most irregular moons have 0 in their kernels. 55 of the 470 bodies have a GM.
- **Verification:** `pipeline/tests/test_bodies.py` checks that every value equals the kernel pool.
