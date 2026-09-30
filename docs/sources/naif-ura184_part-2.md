# naif-ura184_part-2: JPL satellite ephemeris `ura184_part-2.bsp` (NAIF)

- **URL:** https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/satellites/ura184_part-2.bsp
- **Used by:** the `ephemeris` stage, for 7 bodies of the Uranus system in `app/public/data/ephem/sat-ura.json` and `.bin` (SPK types 2). The bodies stage also reads names and GMs from the kernel's comments.
- **Label:** `measured`. The records are the kernel's own, bit for bit.
- **Citation:** JPL Solar System Dynamics Group satellite ephemeris URA182.21, URA117, URA115, URA184, planetary ephemeris DE-0442/LE-0442, DE-0440/LE-0440, DE-0438/LE-0438, DE442; NAIF SPK `ura184_part-2.bsp`. Jacobson, R. A., Park, R. S. (2025). The Astronomical Journal 169, 65. DOI:10.3847/1538-3881/ad99d1. The kernel's own description: "The second subset of satellites from URA184 Satellite Ephemeris with Uranus barycenter (7), Sun (10), Earth Moon barycenter (3), and Earth (399) from DE442.". Satellite ephemerides: https://ssd.jpl.nasa.gov/sats/ephem/.

## What is taken

Rosalind (713), Belinda (714), Puck (715), Perdita (725), Mab (726), Cupid (727), S2025 u 1 (75052).

The DE copies embedded in the kernel (the Sun, the Earth-Moon barycentre, the Earth and the system barycentre) are never used; they would override the planetary ephemeris.

Range-request excerpt: 30.87 MB of the 2063 MB original (Last-Modified Fri, 26 Sep 2025 13:42:57 GMT), 17 HTTP range requests, 4 records re-read from the original and compared byte for byte at build time.

## Accuracy

- **Chebyshev interpolation error stated in the comments:** URA182.21: 0.8000 meters.
- **Orbit-determination uncertainty:** not published in the kernel. For recently discovered irregular moons, expect it to be far above 1 km.

## Verification

- **`pipeline/tests/test_ephem_satellites.py`:** the product is bit-identical to the excerpt, and SPICE `spkgeo` on the excerpt equals our evaluator (types 2/3 exactly, type 17 to < 1 mm).
- **`app/tests/core-ephemeris.test.ts`:** the TS evaluator matches SPICE on sampled segments, and moons match JPL Horizons relative to their planet centre.

How the kernels were chosen and excerpted: `docs/sources/naif-satellite-kernels.md`.
