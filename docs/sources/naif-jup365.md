# naif-jup365: JPL satellite ephemeris `jup365.bsp` (NAIF)

- **URL:** https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/satellites/jup365.bsp
- **Used by:** the `ephemeris` stage, for 9 bodies of the Jupiter system in `app/public/data/ephem/sat-jup.json` and `.bin` (SPK types 2). The bodies stage also reads names and GMs from the kernel's comments.
- **Label:** `measured`. The records are the kernel's own, bit for bit.
- **Citation:** JPL Solar System Dynamics Group satellite ephemeris JUP365.26, planetary ephemeris DE-0440/LE-0440; NAIF SPK `jup365.bsp`. The kernel's own description: "JUP365 Satellite Ephemeris with Jupiter barycenter (5), Sun (10), Earth Moon barycenter (3), and Earth (399) from DE440.". Satellite ephemerides: https://ssd.jpl.nasa.gov/sats/ephem/.

## What is taken

Io (501), Europa (502), Ganymede (503), Callisto (504), Amalthea (505), Thebe (514), Adrastea (515), Metis (516), Jupiter (599).

The DE copies embedded in the kernel (the Sun, the Earth-Moon barycentre, the Earth and the system barycentre) are never used; they would override the planetary ephemeris.

Range-request excerpt: 5.65 MB of the 1137 MB original (Last-Modified Sun, 14 Mar 2021 15:29:22 GMT), 21 HTTP range requests, 4 records re-read from the original and compared byte for byte at build time.

## Accuracy

- **Chebyshev interpolation error stated in the comments:** JUP365.26: 16.00 meters.
- **Orbit-determination uncertainty:** not published in the kernel. For recently discovered irregular moons, expect it to be far above 1 km.

## Verification

- **`pipeline/tests/test_ephem_satellites.py`:** the product is bit-identical to the excerpt, and SPICE `spkgeo` on the excerpt equals our evaluator (types 2/3 exactly, type 17 to < 1 mm).
- **`app/tests/core-ephemeris.test.ts`:** the TS evaluator matches SPICE on sampled segments, and moons match JPL Horizons relative to their planet centre.

How the kernels were chosen and excerpted: `docs/sources/naif-satellite-kernels.md`.
