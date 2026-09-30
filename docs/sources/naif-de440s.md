# naif-de440s: JPL planetary and lunar ephemeris DE440 (`de440s.bsp`)

- **URL:** https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/de440s.bsp (32.7 MB, coverage 1849–2150)
- **Used by:** the `ephemeris` stage, which writes `app/public/data/ephem/de440s.json` and `.bin`.
- **Label:** `measured`. The Chebyshev records are JPL's fit to the observations, copied bit for bit.
- **Citation:** Park, R. S., Folkner, W. M., Williams, J. G., Boggs, D. H. (2021). The JPL Planetary and Lunar Ephemerides DE440 and DE441. *AJ* 161, 105. DOI:10.3847/1538-3881/abd414.

## What is taken

All 14 segments are kept, as SPK type 2 in the J2000 (ICRF) frame:

| Segments | Target wrt center | Record length |
|---|---|---|
| Barycenters | 1–9 wrt the SSB (0) | 8–32 days |
| Sun | 10 wrt 0 | 16 days |
| Moon, Earth | 301 and 399 wrt the Earth-Moon barycenter (3) | 4 days |
| Mercury, Venus | 199 wrt 1 and 299 wrt 2 | one record for the whole span |

Each segment keeps only the records that overlap the manifest window ± 2 days, which leaves room for light-time. Records are byte-identical to the kernel. Record selection follows SPICE SPKR02; see `app/src/core/ephemeris.ts`.

DE440s does **not** contain planet centers relative to their system barycenters (499 wrt 4 … 999 wrt 9). Those come from `jpl-horizons-center-*`.

## Verification

- **pipeline/tests/test_ephem.py:** every segment matches `spiceypy.spkgeo` on the original kernel to within 7.2e-7 km and 8.7e-15 km/s at about 400 random epochs per segment plus every record boundary. Inside the coverage the evaluator is bit-identical to SPICE, because it uses the same Clenshaw operation order as CHBINT. The only nonzero difference is at the final coverage instant, where SPICE would switch to the next, dropped record.
- **app/tests/core-ephemeris.test.ts:** the TS evaluator matches `spkgeo` exactly (difference 0.0) at 70 segment/epoch cases. Against independent JPL Horizons geometric SSB vectors (5 epochs), barycenters 3–9 agree to within 1e-6 km. The Sun, Mercury, Venus, Earth and Moon agree to within 2.6 m.

## Known issue: DE442 exists

NAIF published `de442s.bsp` on 2025-02-06 (same layout, 31 MB). According to `de442_tech-comments.txt`, DE442 was integrated in May 2024. It updates DE440 with Uranus occultation data plus four more years of Mars-orbiter and Juno ranging.

Measured difference, DE440 minus DE442, over the current window:

| Body | Max difference |
|---|---|
| Uranus barycenter | 1371 km |
| Neptune barycenter | 376 km |
| Jupiter barycenter | 15 km |
| Pluto barycenter | 1.9 km |
| Inner planets and Sun | < 0.3 km |

JPL Horizons already mixes the two. The satellite ephemerides behind its Uranus and Neptune answers (ura184, nep098) embed the DE442 barycenters, while its Jupiter answers (jup365) and plain barycenter queries are DE440-equivalent. That is why our Uranus center differs from Horizons' "799 wrt SSB" by 1300 km, and Neptune by 364 km.

Under NORTH_STAR §3.5 (best available source), switching to DE442s is probably right. It needs a decision because product names are part of the contract. The code change is small: set `PLANETARY` in `pipeline/src/pipeline/ephem_kernels.py`, update the SourceRecord text there, then rerun the build and `python -m pipeline.ephem_fixtures`. The product is then named `ephem/de442s`, and `bodies.json` `ephemerisFiles` follows automatically.
