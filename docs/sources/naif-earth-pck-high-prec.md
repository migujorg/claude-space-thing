# naif-earth-pck-high-prec: NAIF high-precision Earth orientation PCK (ITRF93)

- **URL:** the newest `https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/earth_000101_<end>_<lastdatum>.bpc`. This is the dated name of `earth_latest_high_prec.bpc`; the build of 2026-09-30 used `earth_000101_261226_260929.bpc`, 5.1 MB. NAIF regenerates it as new Earth orientation parameters (EOP) arrive, so each rebuild picks up the newest.
- **Used by:** the `bodies` stage, which writes `app/public/data/orient/earth.json` and `.bin`. `bodies.json` Earth gets `orientation: "orient/earth"`. The app evaluates it with `PreciseOrientation` / `OrientationSet` in `app/src/core/rotation.ts`.
- **Labels:**
  - `measured` before the file's "UTC Epoch of last datum" (2026-09-29 in this build);
  - `estimated` after it. The EOP there are predictions, and `method` says so.
- **Citation:** NAIF/JPL binary PCK (N. Bachman, NAIF), ITRF93 relative to ECLIPJ2000. It includes 1976 IAU precession, 1980 IAU nutation with nutation corrections, rotation through true sidereal time, and polar motion, from JPL's EOP file (https://eop.jpl.nasa.gov/). Acton (1996), PSS 44, 65, DOI:10.1016/0032-0633(95)00107-7.

## What is taken

The Chebyshev Euler-angle records (PCK type 2, 1-day records, degree 20) that overlap the window, copied bit for bit. They are split at the last-datum epoch into a `measured` and an `estimated` segment by declared coverage, so no record is modified.

The header carries two constant rotations, both computed by SPICE:
- ECLIPJ2000 → J2000;
- body frame → PCK frame (the identity for ITRF93).

## Accuracy

- **NAIF's statement** (pck00011.tpc, "Earth orientation"): error < 0.1 µrad before the epoch of the last datum, rising to several µrad after it.
- **Versus the IAU model:** the IAU_EARTH model (bodies.json `rotation`) is off by about 300″ in 2025–26. See naif-pck00011.md.

## Verification

- **`pipeline/tests/test_ephem_orient.py`:** body → J2000 matches `spiceypy.pxform('ITRF93', 'J2000')` to 3.3e-16 at 500 epochs over the window. Coverage is contiguous, and every `measured` segment comes before every `estimated` one.
- **`app/tests/core-rotation.test.ts`:** the TS `PreciseOrientation` matches `pxform` to 2.2e-16 in both the measured and predicted parts. `OrientationSet` falls back to the IAU model outside coverage and reports which one it used.
