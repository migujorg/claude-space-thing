# naif-de442s: JPL planetary and lunar ephemeris DE442 (`de442s.bsp`)

- **URL:** https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/de442s.bsp (32.7 MB, NAIF 2025-02-06, segment coverage 1849–2150)
- **Used by:** the `ephemeris` stage, which writes `app/public/data/ephem/de442s.json` and `.bin` (`PLANETARY` in `pipeline/src/pipeline/ephem_kernels.py`).
- **Label:** `measured`. The Chebyshev records are JPL's fit to the observations, copied bit for bit.
- **Citation:** JPL planetary and lunar ephemeris DE442, integrated 13 May 2024 and documented in [`de442_tech-comments.txt`](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/de442_tech-comments.txt). It is based on DE440: Park, R. S., Folkner, W. M., Williams, J. G., Boggs, D. H. (2021), The JPL Planetary and Lunar Ephemerides DE440 and DE441, *AJ* 161, 105, DOI:10.3847/1538-3881/abd414.

## Why DE442

In the tech comments, JPL calls DE442 "essentially an update of the planetary ephemeris DE440, incorporating Uranus occultation data as well as additional Mars orbiter ranging data and Juno ranging data spanning an additional four years". It is JPL's newest general-purpose ephemeris, so it is the best available source under NORTH_STAR §3.5. JPL built its current Uranus (ura184) and Neptune (nep098) satellite ephemerides on it.

It replaced DE440s on 2026-09-30. Measured difference, DE442 minus DE440, over the window:

| Body | Max difference |
|---|---|
| Uranus barycenter | 1371 km |
| Neptune barycenter | 376 km |
| Jupiter barycenter | 15 km |
| Pluto barycenter | 1.9 km |
| Mars barycenter | 0.25 km |
| Sun, Mercury, Venus, Earth-Moon, Saturn | 0.16–0.26 km |
| Moon wrt the Earth-Moon barycenter | 0.3 m |

## What is taken

All 14 segments are kept, as SPK type 2 in the J2000 (ICRF) frame:

| Segments | Target wrt center | Record length |
|---|---|---|
| Barycenters | 1–9 wrt the SSB (0) | 8–32 days |
| Sun | 10 wrt 0 | 16 days |
| Moon, Earth | 301 and 399 wrt the Earth-Moon barycenter (3) | 4 days |
| Mercury, Venus | 199 wrt 1 and 299 wrt 2 | one record spanning 1549–2650 |

Each segment keeps only the records that overlap the manifest window ± 2 days, which leaves room for light-time. Records are byte-identical to the kernel. Record selection follows SPICE SPKR02; see `app/src/core/ephemeris.ts`.

Each segment's *declared* coverage (from the SPK segment summary) is written as `startEt`/`endEt`. For 199 and 299 it is narrower than the records' span: the records span 1549–2650 but the segments declare 1849–2150. SPICE refuses epochs outside the declared range, and so does our evaluator.

DE442s does **not** contain planet centers relative to their system barycenters (499 wrt 4 … 999 wrt 9). Those come, with the moons, from the NAIF satellite kernels (`ephem/sat-*`, with the centres also copied into `ephem/centers`); see naif-satellite-kernels.md. Until M2 they were fitted to JPL Horizons.

## GM consistency

GMs still come from `gm_de440.tpc`, because NAIF has published no DE442 GM kernel. The GM table in DE442's tech comments differs from it by at most about 3e-9 relative (the Moon: 4902.800104 vs 4902.800118 km³/s²). That makes no difference to anything the app draws.

## Verification

- **pipeline/tests/test_ephem.py:** every segment is bit-identical to the kernel, and its declared coverage is carried through. It matches `spiceypy.spkgeo` on the original kernel at about 400 random epochs per segment plus every record boundary.
- **app/tests/core-ephemeris.test.ts:** the TS evaluator matches `spkgeo` exactly (difference 0.0) at 70 segment/epoch cases.

### Comparison with independent JPL Horizons vectors (5 epochs)

Horizons builds each answer on the planetary ephemeris of the satellite ephemeris it uses:

| Horizons source | Built on |
|---|---|
| Plain "DE441" queries | Identical to DE440 in this era (measured ≤ 1.1e-6 km) |
| jup365, sat441, mar099, plu060 | DE440 |
| ura184, nep098 | DE442 |

The source is named in each response; the base ephemeris is taken from NAIF's `.cmt` "Planetary Ephemeris Number".

- **Uranus and Neptune** (Horizons on DE442): agree with no correction, 7.2e-7 km and 6.0e-8 km.
- **Everything else** (Horizons on DE440): the fixture carries a SPICE-computed DE440→DE442 shift of the barycenter part (`toOurs`). After that shift every body agrees to within 2.6e-3 km; the Moon is the largest, and the planet centres, now taken from the satellite kernels, are ≤ 7.2e-7 km. Before the shift, the raw differences are exactly the DE440/DE442 difference, e.g. Jupiter 14.8 km and barycenter 7 1300 km.
- **Center offsets:** the same agreement confirms that the planet-centre offsets (given relative to their barycenters) do not depend on the planetary ephemeris.
