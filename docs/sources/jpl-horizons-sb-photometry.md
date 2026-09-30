# jpl-horizons-sb-photometry: JPL Horizons observer tables for the small-body photometry test

- **URL:** https://ssd.jpl.nasa.gov/api/horizons.api. Queries are cached under `data/raw/horizons/smallbodies_photometry/observer_<spkid>.txt`; each query URL and sha256 is in `data/raw/_downloads.json` and in the fixture.
- **Citation:** Giorgini, J. D. et al. (1996). JPL's On-Line Solar System Data Service. BAAS 28(3), 1158.
- **Use:** test fixture only (`app/tests/fixtures/smallbody_photometry.json`, written by the `sbphotometry` stage). Six asteroids are included: 1 Ceres, 4 Vesta, 433 Eros, 99942 Apophis (all with a fitted G), and 1000 Piazzia and 10000 Myriostos (conventional G = 0.15). Each has three dates across the window (2025-06-01, 2026-09-30 and 2027-12-01 at 0h UT), observed from the geocentre with `QUANTITIES='9,19,20,24'`: APmag, r, Δ and the Sun-target-observer angle.
- Horizons prints the H and G it used in the object header. The fixture stores them next to our catalogue values, and the test requires the two to be equal.
