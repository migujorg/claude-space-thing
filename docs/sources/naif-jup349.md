# naif-jup349: JPL satellite ephemeris `jup349.bsp` (NAIF)

- **URL:** https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/satellites/jup349.bsp
- **Used by:** the `ephemeris` stage, for 14 bodies of the Jupiter system in `app/public/data/ephem/sat-jup.json` and `.bin` (SPK types 2). The bodies stage also reads names and GMs from the kernel's comments.
- **Label:** `measured`. The records are the kernel's own, bit for bit.
- **Citation:** JPL Solar System Dynamics Group satellite ephemeris JUP349, JUP365.26, planetary ephemeris DE-0442/LE-0442, DE-0440/LE-0440; NAIF SPK `jup349.bsp`. The kernel's own description: "JUP349 Satellite Ephemeris with Jupiter (599) from JUP365 and Jupiter barycenter (5), Sun (10), Earth Moon barycenter (3), and Earth (399) from DE442.". Satellite ephemerides: https://ssd.jpl.nasa.gov/sats/ephem/.

## What is taken

S/2010 J 3 (55531), S/2010 J 4 (55532), S/2010 J 5 (55533), S/2010 J 6 (55534), S/2011 J 6 (55535), S/2017 J 12 (55536), S/2017 J 13 (55537), S/2017 J 14 (55538), S/2017 J 15 (55539), S/2017 J 16 (55540), S/2017 J 17 (55541), S/2017 J 18 (55542), and 2 more.

The DE copies embedded in the kernel (the Sun, the Earth-Moon barycentre, the Earth and the system barycentre) are never used; they would override the planetary ephemeris.

Range-request excerpt: 0.52 MB of the 98 MB original (Last-Modified Mon, 13 Apr 2026 18:15:14 GMT), 32 HTTP range requests, 4 records re-read from the original and compared byte for byte at build time.

## Accuracy

- **Chebyshev interpolation error stated in the comments:** JUP365.26: 16.00 meters.
- **Orbit-determination uncertainty:** not published in the kernel. For recently discovered irregular moons, expect it to be far above 1 km.

## Verification

- **`pipeline/tests/test_ephem_satellites.py`:** the product is bit-identical to the excerpt, and SPICE `spkgeo` on the excerpt equals our evaluator (types 2/3 exactly, type 17 to < 1 mm).
- **`app/tests/core-ephemeris.test.ts`:** the TS evaluator matches SPICE on sampled segments, and moons match JPL Horizons relative to their planet centre.

How the kernels were chosen and excerpted: `docs/sources/naif-satellite-kernels.md`.
