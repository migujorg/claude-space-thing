# naif-nep104: JPL satellite ephemeris `nep104.bsp` (NAIF)

- **URL:** https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/satellites/nep104.bsp
- **Used by:** the `ephemeris` stage, for 7 bodies of the Neptune system in `app/public/data/ephem/sat-nep.json` and `.bin` (SPK types 2). The bodies stage also reads names and GMs from the kernel's comments.
- **Label:** `measured`. The records are the kernel's own, bit for bit.
- **Citation:** JPL Solar System Dynamics Group satellite ephemeris NEP104, NEP097, planetary ephemeris DE-0440/LE-0440, DE-0441/LE-0441; NAIF SPK `nep104.bsp`. The kernel's own description: "NEP104 Satellite Ephemeris with Neptune (899) from NEP097 and Neptune barycenter (8), Sun (10), Earth Moon barycenter (3), and Earth (399) from DE440.". Satellite ephemerides: https://ssd.jpl.nasa.gov/sats/ephem/.

## What is taken

Halimede (809), Psamathe (810), Sao (811), Laomedeia (812), Neso (813), S/2002 N 5 (85051), S/2021 N 1 (85052).

The DE copies embedded in the kernel (the Sun, the Earth-Moon barycentre, the Earth and the system barycentre) are never used; they would override the planetary ephemeris.

Range-request excerpt: 1.16 MB of the 333 MB original (Last-Modified Sat, 28 Sep 2024 14:06:38 GMT), 17 HTTP range requests, 4 records re-read from the original and compared byte for byte at build time.

## Accuracy

- **Chebyshev interpolation error stated in the comments:** NEP097: 1.000 meters.
- **Orbit-determination uncertainty:** not published in the kernel. For recently discovered irregular moons, expect it to be far above 1 km.

## Verification

- **`pipeline/tests/test_ephem_satellites.py`:** the product is bit-identical to the excerpt, and SPICE `spkgeo` on the excerpt equals our evaluator (types 2/3 exactly, type 17 to < 1 mm).
- **`app/tests/core-ephemeris.test.ts`:** the TS evaluator matches SPICE on sampled segments, and moons match JPL Horizons relative to their planet centre.

How the kernels were chosen and excerpted: `docs/sources/naif-satellite-kernels.md`.
