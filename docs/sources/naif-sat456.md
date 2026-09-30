# naif-sat456: JPL satellite ephemeris `sat456.bsp` (NAIF)

- **URL:** https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/satellites/sat456.bsp
- **Used by:** the `ephemeris` stage, for 42 bodies of the Saturn system in `app/public/data/ephem/sat-sat.json` and `.bin` (SPK types 2). The bodies stage also reads names and GMs from the kernel's comments.
- **Label:** `measured`. The records are the kernel's own, bit for bit.
- **Citation:** JPL Solar System Dynamics Group satellite ephemeris SAT456, SAT441.24, planetary ephemeris DE-0441/LE-0441, DE-0440/LE-0440; NAIF SPK `sat456.bsp`. The kernel's own description: "SAT456 Satellite Ephemeris with Saturn (699) from SAT441 and Saturn barycenter (6), Sun (10), Earth Moon barycenter (3), and Earth (399) from DE440.". Satellite ephemerides: https://ssd.jpl.nasa.gov/sats/ephem/.

## What is taken

Ymir (619), Paaliaq (620), Tarvos (621), Ijiraq (622), Suttungr (623), Kiviuq (624), Mundilfari (625), Albiorix (626), Skathi (627), Erriapus (628), Siarnaq (629), Thrymr (630), and 30 more.

The DE copies embedded in the kernel (the Sun, the Earth-Moon barycentre, the Earth and the system barycentre) are never used; they would override the planetary ephemeris.

Range-request excerpt: 0.70 MB of the 121 MB original (Last-Modified Thu, 07 Aug 2025 15:37:08 GMT), 97 HTTP range requests, 4 records re-read from the original and compared byte for byte at build time.

## Accuracy

- **Chebyshev interpolation error stated in the comments:** SAT456: 556.0 meters; SAT441.24: 7.500 meters.
- **Orbit-determination uncertainty:** not published in the kernel. For recently discovered irregular moons, expect it to be far above 1 km.

## Verification

- **`pipeline/tests/test_ephem_satellites.py`:** the product is bit-identical to the excerpt, and SPICE `spkgeo` on the excerpt equals our evaluator (types 2/3 exactly, type 17 to < 1 mm).
- **`app/tests/core-ephemeris.test.ts`:** the TS evaluator matches SPICE on sampled segments, and moons match JPL Horizons relative to their planet centre.

How the kernels were chosen and excerpted: `docs/sources/naif-satellite-kernels.md`.
