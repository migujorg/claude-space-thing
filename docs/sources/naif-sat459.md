# naif-sat459: JPL satellite ephemeris `sat459.bsp` (NAIF)

- **URL:** https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/satellites/sat459.bsp
- **Used by:** the `ephemeris` stage, for 18 bodies of the Saturn system in `app/public/data/ephem/sat-sat.json` and `.bin` (SPK types 2). The bodies stage also reads names and GMs from the kernel's comments.
- **Label:** `measured`. The records are the kernel's own, bit for bit.
- **Citation:** JPL Solar System Dynamics Group satellite ephemeris SAT458, SAT459, SAT441.24, SAT441, planetary ephemeris DE-0441/LE-0441, DE-0440/LE-0440; NAIF SPK `sat459.bsp`. The kernel's own description: "SAT459 Satellite Ephemeris with Saturn (699) from SAT441 and Saturn barycenter (6), Sun (10), Earth Moon barycenter (3), and Earth (399) from DE442.". Satellite ephemerides: https://ssd.jpl.nasa.gov/sats/ephem/.

## What is taken

S/2020 S 45 (65286), S/2020 S 46 (65287), S/2020 S 47 (65288), S/2020 S 48 (65289), S/2023 S 51 (65290), S/2023 S 52 (65291), S/2023 S 53 (65292), S/2023 S 54 (65293), S/2023 S 55 (65294), S/2023 S 56 (65295), S/2023 S 57 (65296), S/2020 S 49 (65297), and 6 more.

The DE copies embedded in the kernel (the Sun, the Earth-Moon barycentre, the Earth and the system barycentre) are never used; they would override the planetary ephemeris.

Range-request excerpt: 0.39 MB of the 84 MB original (Last-Modified Mon, 13 Apr 2026 18:15:21 GMT), 31 HTTP range requests, 4 records re-read from the original and compared byte for byte at build time.

## Accuracy

- **Chebyshev interpolation error stated in the comments:** SAT441.24: 7.500 meters; SAT441: 7.500 meters.
- **Orbit-determination uncertainty:** not published in the kernel. For recently discovered irregular moons, expect it to be far above 1 km.

## Verification

- **`pipeline/tests/test_ephem_satellites.py`:** the product is bit-identical to the excerpt, and SPICE `spkgeo` on the excerpt equals our evaluator (types 2/3 exactly, type 17 to < 1 mm).
- **`app/tests/core-ephemeris.test.ts`:** the TS evaluator matches SPICE on sampled segments, and moons match JPL Horizons relative to their planet centre.

How the kernels were chosen and excerpted: `docs/sources/naif-satellite-kernels.md`.
