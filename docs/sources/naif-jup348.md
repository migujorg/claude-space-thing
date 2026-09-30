# naif-jup348: JPL satellite ephemeris `jup348.bsp` (NAIF)

- **URL:** https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/satellites/jup348.bsp
- **Used by:** the `ephemeris` stage, for 4 bodies of the Jupiter system in `app/public/data/ephem/sat-jup.json` and `.bin` (SPK types 2). The bodies stage also reads names and GMs from the kernel's comments.
- **Label:** `measured`. The records are the kernel's own, bit for bit.
- **Citation:** JPL Solar System Dynamics Group satellite ephemeris JUP348, JUP365.26, planetary ephemeris DE-0442/LE-0442, DE-0440/LE-0440; NAIF SPK `jup348.bsp`. The kernel's own description: "JUP348 Satellite Ephemeris with Jupiter (599) from JUP365 and Jupiter barycenter (5), Sun (10), Earth Moon barycenter (3), and Earth (399) from DE442.". Satellite ephemerides: https://ssd.jpl.nasa.gov/sats/ephem/.

## What is taken

S/2011 J 4 (55527), S/2018 J 5 (55528), S/2024 J 1 (55529), S/2011 J 5 (55530).

The DE copies embedded in the kernel (the Sun, the Earth-Moon barycentre, the Earth and the system barycentre) are never used; they would override the planetary ephemeris.

Range-request excerpt: 0.17 MB of the 60 MB original (Last-Modified Wed, 18 Mar 2026 17:38:32 GMT), 10 HTTP range requests, 4 records re-read from the original and compared byte for byte at build time.

## Accuracy

- **Chebyshev interpolation error stated in the comments:** JUP365.26: 16.00 meters.
- **Orbit-determination uncertainty:** not published in the kernel. For recently discovered irregular moons, expect it to be far above 1 km.

## Verification

- **`pipeline/tests/test_ephem_satellites.py`:** the product is bit-identical to the excerpt, and SPICE `spkgeo` on the excerpt equals our evaluator (types 2/3 exactly, type 17 to < 1 mm).
- **`app/tests/core-ephemeris.test.ts`:** the TS evaluator matches SPICE on sampled segments, and moons match JPL Horizons relative to their planet centre.

How the kernels were chosen and excerpted: `docs/sources/naif-satellite-kernels.md`.
