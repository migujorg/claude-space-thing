# naif-jup347: JPL satellite ephemeris `jup347.bsp` (NAIF)

- **URL:** https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/satellites/jup347.bsp
- **Used by:** the `ephemeris` stage, for 90 bodies of the Jupiter system in `app/public/data/ephem/sat-jup.json` and `.bin` (SPK types 2). The bodies stage also reads names and GMs from the kernel's comments.
- **Label:** `measured`. The records are the kernel's own, bit for bit.
- **Citation:** JPL Solar System Dynamics Group satellite ephemeris JUP347, JUP365.26, planetary ephemeris DE-0442/LE-0442, DE-0440/LE-0440; NAIF SPK `jup347.bsp`. The kernel's own description: "JUP347 Satellite Ephemeris with Jupiter (599) from JUP365 and Jupiter barycenter (5), Sun (10), Earth Moon barycenter (3), and Earth (399) from DE442.". Satellite ephemerides: https://ssd.jpl.nasa.gov/sats/ephem/.

## What is taken

Himalia (506), Elara (507), Pasiphae (508), Sinope (509), Lysithea (510), Carme (511), Ananke (512), Leda (513), Callirrhoe (517), Themisto (518), Megaclite (519), Taygete (520), and 78 more.

The DE copies embedded in the kernel (the Sun, the Earth-Moon barycentre, the Earth and the system barycentre) are never used; they would override the planetary ephemeris.

Range-request excerpt: 6.80 MB of the 921 MB original (Last-Modified Thu, 15 May 2025 18:58:48 GMT), 188 HTTP range requests, 4 records re-read from the original and compared byte for byte at build time.

## Accuracy

- **Chebyshev interpolation error stated in the comments:** JUP365.26: 16.00 meters.
- **Orbit-determination uncertainty:** not published in the kernel. For recently discovered irregular moons, expect it to be far above 1 km.

## Verification

- **`pipeline/tests/test_ephem_satellites.py`:** the product is bit-identical to the excerpt, and SPICE `spkgeo` on the excerpt equals our evaluator (types 2/3 exactly, type 17 to < 1 mm).
- **`app/tests/core-ephemeris.test.ts`:** the TS evaluator matches SPICE on sampled segments, and moons match JPL Horizons relative to their planet centre.

How the kernels were chosen and excerpted: `docs/sources/naif-satellite-kernels.md`.
