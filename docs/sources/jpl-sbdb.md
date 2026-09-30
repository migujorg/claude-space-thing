# jpl-sbdb-orbits, jpl-sbdb-physical, jpl-sbdb-nongrav: JPL Small-Body Database

- **URLs:** SBDB Query API `https://ssd-api.jpl.nasa.gov/sbdb_query.api` (bulk, paged), SBDB API `https://ssd-api.jpl.nasa.gov/sbdb.api` (one object). Documentation: [query API](https://ssd-api.jpl.nasa.gov/doc/sbdb_query.html), [object API](https://ssd-api.jpl.nasa.gov/doc/sbdb.html).
- **Used by:** the `smallbodies` stage (`pipeline/src/pipeline/sb_sbdb.py`, `sb_catalog.py`), written to `app/public/data/smallbodies/`.
- **Snapshot:** one download of the whole database is a snapshot under `data/raw/sbdb/<date>/` (2026-09-30: 1,573,014 objects in 32 pages of 50,000, 154,477 physical-parameter rows in 4 pages, 1,116 single-object answers). Later builds reuse the newest complete snapshot; `SB_SNAPSHOT=new` downloads a fresh one. Each SourceRecord's `sha256` is SHA-256 over the per-page sha256 values in page order (the per-page hashes and exact URLs are in `data/raw/_downloads.json`).
- **Citation:** JPL Small-Body Database, Solar System Dynamics Group, Jet Propulsion Laboratory. Giorgini, J. D. et al. (1996), JPL's On-Line Solar System Data Service, BAAS 28(3), 1158. Orbit solutions are credited per object (`producer`); non-gravitational model: Marsden, Sekanina & Yeomans (1973), AJ 78, 211, DOI:10.1086/111402; delay DT: Yeomans & Chodas (1989), AJ 98, 1083, DOI:10.1086/115201.
- **Licence / use:** U.S. Government work. The fair-use policy asks for one request at a time: every request is sequential with a pause (1 s between bulk pages, 0.4 s between object requests). A contact can be added to the User-Agent through `PIPELINE_CONTACT`.

## What is taken

| Query | Fields | Label |
|---|---|---|
| Orbits, every object, `full-prec=1`, `sort=spkid` | spkid, full_name, pdes, name, prefix, kind, class, neo, pha, orbit_id, epoch, equinox, e, a, q, i, om, w, ma, tp, condition_code, data_arc, n_obs_used, two_body, source, pe_used, H, G, H_sigma, A1, A2, A3, DT, S0, M1, K1, M2, K2, PC | elements, H, fitted G, M1/K1/M2/K2: measured |
| Physical, objects with any of the fields defined (`sb-cdata` OR of `|DF`) | diameter, diameter_sigma, extent, GM, density, rot_per, pole, albedo, BV, UB, IR, spec_T, spec_B | measured |
| Single object (`sbdb.api?spk=`), every object with A1/A2/A3/DT/S0 or with `pe_used` other than DE441 | `orbit.model_pars` (A1, A2, A3, DT and the g(r) constants ALN, R0, NM, NN, NK; also AMRAT, RHO, S0, jet terms) | measured |

**Full precision matters.** Without `full-prec=1` the API rounds the elements for display (Ceres a = 2.766), which would be worth 10⁵ km. With it, 16 significant digits (e.g. Ceres e = 0.07969229514816586).

**Paging consistency.** The database can change between pages. Pages are sorted by spkid, de-duplicated on spkid (0 duplicates in the 2026-09-30 snapshot) and the total is compared with the API's count.

**Conventions.** Heliocentric osculating elements referred to the IAU76/80 ecliptic and equinox J2000 (`equinox` = J2000 for every object), angles in degrees, distances in au, `epoch` and `tp` as TDB Julian dates. The ecliptic → ICRF rotation uses the IAU 1976 obliquity 84381.448″, as JPL does. 1,472,741 objects share the standard epoch JD 2461200.5 (2026-06-09); the other 100,273 have their own (comets near perihelion, lost objects back to −146).

**Non-gravitational models.** The query API returns only A1–A3, DT and S0; the g(r) constants come from `model_pars` (Apophis, for instance, uses g = (1 au / r)², i.e. ALN = 1, R0 = 1 au, NM = 2, NK = 0; comets default to Marsden et al. 1973). Three solutions use terms the propagator does not model (101955 Bennu: AMRAT, RHO thermal Yarkovsky model; 1P/Halley: S0; C/2013 A1 Siding Spring: rotating-jet terms): their state at the common epoch is taken from JPL Horizons instead (see `jpl-horizons-sb-states`), as is that of 134340 Pluto, which is itself a perturber of the force model.

**Physical parameters** are JPL's compilation of published values; the query API does not return the per-value reference (the single-object API does). They are labelled measured.
