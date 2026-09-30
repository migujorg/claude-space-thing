# naif-earth-pck-predict: NAIF low-accuracy long-term predict Earth orientation PCK (ITRF93)

- **URL:** the newest `https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/earth_<yyyy>_<created>_<end>_predict.bpc`. The build of 2026-09-30 used `earth_2026_260806_2126_predict.bpc` (18 MB, 2026-01-01 to 2126-11-03).
- **Used by:** the `bodies` stage, for `orient/earth` after the end of the high-precision file. In this build that is from 2026-12-26 to the end of the window, 2028-04.
- **Label:** `estimated`.
- **Citation:** NAIF/JPL binary PCK (N. Bachman, NAIF, 2026-08-07), built from JPL's EOP file `latest.long` (last datum 2026-08-06, predictions to 2026-11-02). Acton (1996), PSS 44, 65.

## What it is

The file's comments call it a "low accuracy, long term predict earth PCK". Past its source EOP file, polar motion and nutation corrections are held constant, and TAI−UT1 is set so that TAI−UT1R stays constant. The rest of the Earth rotation model is the same as in the high-precision file.

## Measured behaviour

Measured on 2026-09-30 against the high-precision file:

| Comparison | Difference |
|---|---|
| Measured part of 2026 | up to 0.66″ (mean 0.06″) |
| Short-term predicted part, Oct–Dec 2026 | up to 1.66″ |
| Jump at the hand-over on 2026-12-26 | 1.66″, about 51 m at the equator |

Beyond that its error is not known. UT1 is unpredictable over months to years, so treat the rotation as uncertain at the arcsecond-to-tens-of-arcseconds level by 2028. The error is not published.

## Verification

- **`pipeline/tests/test_ephem_orient.py`:** matches `pxform('ITRF93', 'J2000')` with both files loaded (high-precision file taking priority).
- **`app/tests/core-rotation.test.ts`:** the TS evaluator matches SPICE at the 2027 epochs.
