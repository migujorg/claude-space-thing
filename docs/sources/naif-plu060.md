# naif-plu060: JPL satellite ephemeris `plu060.bsp` (NAIF)

- **URL:** https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/satellites/plu060.bsp
- **Used by:** the `ephemeris` stage, for 6 bodies of the Pluto system in `app/public/data/ephem/sat-plu.json` and `.bin` (SPK types 2). The bodies stage also reads names and GMs from the kernel's comments.
- **Label:** `measured`. The records are the kernel's own, bit for bit.
- **Citation:** JPL Solar System Dynamics Group satellite ephemeris PLU060, planetary ephemeris DE-0440/LE-0440; NAIF SPK `plu060.bsp`. The kernel's own description: "PLU060 Satellite Ephemeris with Pluto Barycenter (9), Sun (10), Earth Moon barycenter (3), and Earth (399) from DE440.". Satellite ephemerides: https://ssd.jpl.nasa.gov/sats/ephem/.

## What is taken

Charon (901), Nix (902), Hydra (903), Kerberos (904), Styx (905), Pluto (999).

The DE copies embedded in the kernel (the Sun, the Earth-Moon barycentre, the Earth and the system barycentre) are never used; they would override the planetary ephemeris.

Range-request excerpt: 0.95 MB of the 135 MB original (Last-Modified Wed, 03 Apr 2024 14:44:03 GMT), 15 HTTP range requests, 4 records re-read from the original and compared byte for byte at build time.

## Accuracy

- **Chebyshev interpolation error stated in the comments:** PLU060: 1.700 meters.
- **Orbit-determination uncertainty:** not published in the kernel. For recently discovered irregular moons, expect it to be far above 1 km.

## Verification

- **`pipeline/tests/test_ephem_satellites.py`:** the product is bit-identical to the excerpt, and SPICE `spkgeo` on the excerpt equals our evaluator (types 2/3 exactly, type 17 to < 1 mm).
- **`app/tests/core-ephemeris.test.ts`:** the TS evaluator matches SPICE on sampled segments, and moons match JPL Horizons relative to their planet centre.

How the kernels were chosen and excerpted: `docs/sources/naif-satellite-kernels.md`.
