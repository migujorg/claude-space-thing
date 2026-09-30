# jpl-horizons-center-599: Jupiter center (599) relative to the Jupiter system barycenter (5)

- **Source:** JPL Horizons API vector tables, https://ssd.jpl.nasa.gov/api/horizons.api (`COMMAND='599'`, `CENTER='500@5'`, `EPHEM_TYPE=VECTORS`, `REF_SYSTEM=ICRF`, `REF_PLANE=FRAME`, `TIME_TYPE=TDB`, `OUT_UNITS=KM-S`, `VEC_CORR=NONE`, `CSV_FORMAT=YES`). The exact query URL and the sha256 of the response are in `sources.json` and `data/raw/_downloads.json`. They change whenever the build window moves.
- **Underlying data:** the JPL satellite ephemeris that Horizons names in its output header, `jup365_merged` (JPL Solar System Dynamics Group, https://ssd.jpl.nasa.gov/sats/ephem/).
- **Used by:** the `ephemeris` stage, for the `599 wrt 5` segment of `app/public/data/ephem/centers.json` and `.bin`. The app chains it to the SSB through barycenter 5 in `ephem/de442s`.
- **Label:** `derived`, because it is a fit to measured-ephemeris samples.
- **Citation:** Giorgini, J. D., et al. (1996). JPL's On-Line Solar System Data Service. *BAAS* 28(3), 1158, plus the satellite ephemeris above.

## Why this source

The planetary ephemeris (DE442s) has no planet centers relative to their system barycenters. The offset for Jupiter is up to 220 km (the Galilean moons) over the window.

The NAIF satellite SPKs that hold these offsets are too big for the 500 MB download budget: jup365 is 1.1 GB, sat441 0.6 GB, ura184 about 4 GB, nep098 about 4 GB, and plu060 0.13 GB. Horizons evaluates exactly these ephemerides and names them in each response, so one uniform method is used for all six systems. The one exception is Mars, where `mar099s.bsp` (64 MB) would also have fit.

## Method

- **Sampling:** Horizons geometric states are sampled every 60 min, over the manifest window ± 2 days, snapped outward to 32-day multiples so that rebuilds within about a month reuse the download.
- **Fit:** SPK type 2 records of 1 day, degree 11, fitted by least squares to the 25 samples each record spans. Records start at 0h TDB, where the satellite ephemerides have their own record boundaries. Straddling those boundaries made fits up to 100× worse (3 m versus 0.2 mm for Uranus).
- **Hold-out check:** a second, independent Horizons query every 437 min, offset by 13 min, is used only for checking. The build fails if either residual reaches 1 km.

## Result (build of 2026-09-30)

| Check | Value |
|---|---|
| Max residual, 26,881 fitted epochs | 3.3e-4 km |
| Max residual, 3,691 hold-out epochs | 3.1e-4 km |

Each build records its own numbers in the segment's `uncertainty` field, and `pipeline/tests/test_ephem.py` re-checks them against the raw files. These residuals exclude the error of `jup365_merged` itself.

Residuals are sub-mm in two thirds of the records and up to 0.33 m in the rest, in a 9-day pattern. That pattern fits irregular record boundaries in jup365, which a smooth 1-day fit cannot straddle.

jup365 was built on DE440, while our barycenter comes from DE442. The offset from the barycenter does not depend on the planetary ephemeris. After shifting Horizons' SSB vector by the SPICE-computed DE440→DE442 barycenter difference, our chain agrees with it to within 7.8e-5 km (see naif-de442s.md).
