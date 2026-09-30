# naif-nep098_part-2: JPL satellite ephemeris `nep098_part-2.bsp` (NAIF)

- **URL:** https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/satellites/nep098_part-2.bsp
- **Used by:** the `ephemeris` stage, for 3 bodies of the Neptune system in `app/public/data/ephem/sat-nep.json` and `.bin` (SPK types 2). The bodies stage also reads names and GMs from the kernel's comments.
- **Label:** `measured`. The records are the kernel's own, bit for bit.
- **Citation:** JPL Solar System Dynamics Group satellite ephemeris NEP098, planetary ephemeris DE-0442/LE-0442; NAIF SPK `nep098_part-2.bsp`. The kernel's own description: "Part 2 of NEP098 Satellite Ephemeris with Neptune barycenter (8), Sun (10), Earth Moon barycenter (3), and Earth (399) from DE442.". Satellite ephemerides: https://ssd.jpl.nasa.gov/sats/ephem/.

## What is taken

Thalassa (804), Despina (805), Galatea (806).

The DE copies embedded in the kernel (the Sun, the Earth-Moon barycentre, the Earth and the system barycentre) are never used; they would override the planetary ephemeris.

Range-request excerpt: 13.25 MB of the 1792 MB original (Last-Modified Mon, 13 Jul 2026 17:58:02 GMT), 8 HTTP range requests, 3 records re-read from the original and compared byte for byte at build time.

## Accuracy

- **Chebyshev interpolation error stated in the comments:** NEP098: 1.000 meters.
- **Orbit-determination uncertainty:** not published in the kernel. For recently discovered irregular moons, expect it to be far above 1 km.

## Verification

- **`pipeline/tests/test_ephem_satellites.py`:** the product is bit-identical to the excerpt, and SPICE `spkgeo` on the excerpt equals our evaluator (types 2/3 exactly, type 17 to < 1 mm).
- **`app/tests/core-ephemeris.test.ts`:** the TS evaluator matches SPICE on sampled segments, and moons match JPL Horizons relative to their planet centre.

How the kernels were chosen and excerpted: `docs/sources/naif-satellite-kernels.md`.
