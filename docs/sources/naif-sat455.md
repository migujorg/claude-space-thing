# naif-sat455: JPL satellite ephemeris `sat455.bsp` (NAIF)

- **URL:** https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/satellites/sat455.bsp
- **Used by:** the `ephemeris` stage, for 128 bodies of the Saturn system in `app/public/data/ephem/sat-sat.json` and `.bin` (SPK types 2). The bodies stage also reads names and GMs from the kernel's comments.
- **Label:** `measured`. The records are the kernel's own, bit for bit.
- **Citation:** JPL Solar System Dynamics Group satellite ephemeris SAT455, SAT441.24, planetary ephemeris DE-0440/LE-0440; NAIF SPK `sat455.bsp`. The kernel's own description: "SAT455 Satellite Ephemeris with Saturn (699) from SAT441 and Saturn barycenter (6), Sun (10), Earth Moon barycenter (3), and Earth (399) from DE440.". Satellite ephemerides: https://ssd.jpl.nasa.gov/sats/ephem/.

## What is taken

S/2004 S 54 (65158), S/2004 S 55 (65159), S/2004 S 56 (65160), S/2004 S 57 (65161), S/2004 S 58 (65162), S/2004 S 59 (65163), S/2004 S 60 (65164), S/2004 S 61 (65165), S/2005 S 6 (65166), S/2005 S 7 (65167), S/2006 S 21 (65168), S/2006 S 22 (65169), and 116 more.

The DE copies embedded in the kernel (the Sun, the Earth-Moon barycentre, the Earth and the system barycentre) are never used; they would override the planetary ephemeris.

Range-request excerpt: 2.11 MB of the 292 MB original (Last-Modified Tue, 01 Apr 2025 13:47:38 GMT), 289 HTTP range requests, 4 records re-read from the original and compared byte for byte at build time.

## Accuracy

- **Chebyshev interpolation error stated in the comments:** SAT441.24: 7.500 meters.
- **Orbit-determination uncertainty:** not published in the kernel. For recently discovered irregular moons, expect it to be far above 1 km.

## Verification

- **`pipeline/tests/test_ephem_satellites.py`:** the product is bit-identical to the excerpt, and SPICE `spkgeo` on the excerpt equals our evaluator (types 2/3 exactly, type 17 to < 1 mm).
- **`app/tests/core-ephemeris.test.ts`:** the TS evaluator matches SPICE on sampled segments, and moons match JPL Horizons relative to their planet centre.

How the kernels were chosen and excerpted: `docs/sources/naif-satellite-kernels.md`.
