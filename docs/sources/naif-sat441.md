# naif-sat441: JPL satellite ephemeris `sat441.bsp` (NAIF)

- **URL:** https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/satellites/sat441.bsp
- **Used by:** the `ephemeris` stage, for 15 bodies of the Saturn system in `app/public/data/ephem/sat-sat.json` and `.bin` (SPK types 2). The bodies stage also reads names and GMs from the kernel's comments.
- **Label:** `measured`. The records are the kernel's own, bit for bit.
- **Citation:** JPL Solar System Dynamics Group satellite ephemeris SAT441.24, planetary ephemeris DE-0440/LE-0440; NAIF SPK `sat441.bsp`. The kernel's own description: "none (the comments start with the SPKMERGE log)". Satellite ephemerides: https://ssd.jpl.nasa.gov/sats/ephem/.

## What is taken

Mimas (601), Enceladus (602), Tethys (603), Dione (604), Rhea (605), Titan (606), Hyperion (607), Iapetus (608), Phoebe (609), Helene (612), Telesto (613), Calypso (614), and 3 more.

The DE copies embedded in the kernel (the Sun, the Earth-Moon barycentre, the Earth and the system barycentre) are never used; they would override the planetary ephemeris.

Range-request excerpt: 3.93 MB of the 662 MB original (Last-Modified Sat, 29 Jan 2022 14:38:13 GMT), 33 HTTP range requests, 4 records re-read from the original and compared byte for byte at build time.

## Accuracy

- **Chebyshev interpolation error stated in the comments:** SAT441.24: 7.500 meters.
- **Orbit-determination uncertainty:** not published in the kernel. For recently discovered irregular moons, expect it to be far above 1 km.

## Verification

- **`pipeline/tests/test_ephem_satellites.py`:** the product is bit-identical to the excerpt, and SPICE `spkgeo` on the excerpt equals our evaluator (types 2/3 exactly, type 17 to < 1 mm).
- **`app/tests/core-ephemeris.test.ts`:** the TS evaluator matches SPICE on sampled segments, and moons match JPL Horizons relative to their planet centre.

How the kernels were chosen and excerpted: `docs/sources/naif-satellite-kernels.md`.
