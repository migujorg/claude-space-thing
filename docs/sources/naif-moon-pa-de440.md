# naif-moon-pa-de440: NAIF lunar orientation PCK from DE440

- **URL:** https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/moon_pa_de440_200625.bpc (12.9 MB, 1549–2650; N. Bachman, NAIF, 2021-06-25)
- **Used by:** the `bodies` stage, which writes `app/public/data/orient/moon.json` and `.bin`. `bodies.json` Moon gets `orientation: "orient/moon"`.
- **Label:** `measured`, since it is the DE440 lunar libration solution.
- **Citation:** Park, R. S., Folkner, W. M., Williams, J. G., Boggs, D. H. (2021). The JPL Planetary and Lunar Ephemerides DE440 and DE441. *AJ* 161, 105, DOI:10.3847/1538-3881/abd414. NAIF binary PCK `moon_pa_de440_200625.bpc`.

## What is taken

The Chebyshev Euler angles (PCK type 2, 8-day records) of the principal-axes frame MOON_PA_DE440 relative to J2000, for the window, bit for bit.

The app's lunar body-fixed frame is the Mean Earth/Polar Axis frame **MOON_ME_DE440_ME421**. That is the frame lunar maps (LROC, LOLA) use and the one IAU_MOON approximates. It is obtained from PA through the constant rotation defined in [naif-moon-fk-de440](naif-moon-fk-de440.md). The rotation is computed by SPICE and stored as `bodies["301"].bodyToPck` in the header.

## Accuracy and verification

- **Versus the IAU model:** the research notes (m2-worlds.md §1b) give IAU_MOON vs DE440 ME differences of up to about 155 m on the surface, and PA vs ME of 0.029° (about 875 m).
- **`pipeline/tests/test_ephem_orient.py`:** body → J2000 matches `pxform('MOON_ME_DE440_ME421', 'J2000')` to 6.1e-13 at 500 epochs.
- **`app/tests/core-rotation.test.ts`:** the TS evaluator matches to 4.0e-13.
