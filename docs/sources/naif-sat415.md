# naif-sat415: JPL satellite ephemeris `sat415.bsp` (NAIF)

- **URL:** https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/satellites/sat415.bsp
- **Used by:** the `ephemeris` stage, for 9 bodies of the Saturn system in `app/public/data/ephem/sat-sat.json` and `.bin` (SPK types 3). The bodies stage also reads names and GMs from the kernel's comments.
- **Label:** `measured`. The records are the kernel's own, bit for bit.
- **Citation:** JPL Solar System Dynamics Group satellite ephemeris SAT415, planetary ephemeris DE-0437/LE-0437; NAIF SPK `sat415.bsp`. The kernel's own description: "none (the comments start with the SPKMERGE log)". Satellite ephemerides: https://ssd.jpl.nasa.gov/sats/ephem/.

## What is taken

Janus (610), Epimetheus (611), Atlas (615), Prometheus (616), Pandora (617), Pan (618), Pallene (633), Anthe (649), Aegaeon (653).

The DE copies embedded in the kernel (the Sun, the Earth-Moon barycentre, the Earth and the system barycentre) are never used; they would override the planetary ephemeris.

Range-request excerpt: 17.27 MB of the 624 MB original (Last-Modified Mon, 07 Mar 2022 23:50:18 GMT), 20 HTTP range requests, 4 records re-read from the original and compared byte for byte at build time.

## Accuracy

- **Chebyshev interpolation error stated in the comments:** SAT415: 5.800 meters.
- **Orbit-determination uncertainty:** not published in the kernel. For recently discovered irregular moons, expect it to be far above 1 km.

## Verification

- **`pipeline/tests/test_ephem_satellites.py`:** the product is bit-identical to the excerpt, and SPICE `spkgeo` on the excerpt equals our evaluator (types 2/3 exactly, type 17 to < 1 mm).
- **`app/tests/core-ephemeris.test.ts`:** the TS evaluator matches SPICE on sampled segments, and moons match JPL Horizons relative to their planet centre.

How the kernels were chosen and excerpted: `docs/sources/naif-satellite-kernels.md`.
