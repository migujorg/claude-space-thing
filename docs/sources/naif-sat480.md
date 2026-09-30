# naif-sat480: JPL satellite ephemeris `sat480.bsp` (NAIF)

- **URL:** https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/satellites/sat480.bsp
- **Used by:** the `ephemeris` stage, for 1 bodies of the Saturn system in `app/public/data/ephem/sat-sat.json` and `.bin` (SPK types 17). The bodies stage also reads names and GMs from the kernel's comments.
- **Label:** `measured`. The records are the kernel's own, bit for bit.
- **Citation:** JPL Solar System Dynamics Group satellite ephemeris SAT480, planetary ephemeris not stated; NAIF SPK `sat480.bsp`. The kernel's own description: "SAT480 Satellite Ephemeris with Saturn (699) from SAT441 and Saturn barycenter (6), Sun (10), Earth Moon barycenter (3), and Earth (399) from DE442.". Satellite ephemerides: https://ssd.jpl.nasa.gov/sats/ephem/.

## What is taken

S/2009 S 2 (65304).

The DE copies embedded in the kernel (the Sun, the Earth-Moon barycentre, the Earth and the system barycentre) are never used; they would override the planetary ephemeris.

Downloaded whole (it has a segment type the excerpter cannot copy, or is small).

## Accuracy

- **Chebyshev interpolation error stated in the comments:** none stated.
- **Orbit-determination uncertainty:** not published in the kernel. For recently discovered irregular moons, expect it to be far above 1 km.

## Verification

- **`pipeline/tests/test_ephem_satellites.py`:** the product is bit-identical to the excerpt, and SPICE `spkgeo` on the excerpt equals our evaluator (types 2/3 exactly, type 17 to < 1 mm).
- **`app/tests/core-ephemeris.test.ts`:** the TS evaluator matches SPICE on sampled segments, and moons match JPL Horizons relative to their planet centre.

How the kernels were chosen and excerpted: `docs/sources/naif-satellite-kernels.md`.
