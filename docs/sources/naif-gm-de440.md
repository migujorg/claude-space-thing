# naif-gm-de440: NAIF GM kernel `gm_de440.tpc`

- **URL:** https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/gm_de440.tpc
- **Used by:** the `bodies` stage, for `gm` (km³/s²) of all 11 bodies in `app/public/data/bodies.json`.
- **Label:** `measured`. Mass parameters are fitted quantities of the ephemeris and satellite solutions.
- **Citation:** gm_de440.tpc (B. Semenov, NAIF, 2022-12-14), derived from JPL Horizons `gm_Horizons.pck` (J. D. Giorgini, 2022-11-28).
  - **Barycenters 1–10 and bodies 199, 299, 301, 399:** DE440 values, from Park et al. (2021), *AJ* 161, 105, DOI:10.3847/1538-3881/abd414.
  - **Planet GMs 499–999:** the JPL natural-satellite ephemeris releases, https://ssd.jpl.nasa.gov/ftp/sats/.

## Notes

- **Planet versus system GM:** `gm` is the planet's own GM (`BODY599_GM`), not the system barycenter's (`BODY5_GM`). For Mercury and Venus the two are identical.
- **Pluto:** `BODY999_GM` is Pluto alone; Charon is `BODY901_GM`.
- **Verification:** `pipeline/tests/test_bodies.py` checks that every value equals the kernel pool.
