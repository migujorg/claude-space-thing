# naif-earth-pck-high-prec: NAIF high-precision Earth orientation PCK (ITRF93)

- **URL and rebuild pin:** `https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/earth_000101_270102_261006.bpc` (5,143,552 bytes; sha256 `0a1081571316a22d437d583d2319b3c38eb387ababc8e7a66fd55c5dec1bfdac`), paired with `earth_2026_260806_2126_predict.bpc` (19,169,280 bytes; sha256 `9f565ab5aaccd33afe54f3a1b20cb8b136636c31a0bd4c0986fac722b931c280`). These are the 7 October 2026 build's inputs, selected by `EARTH_HP`/`EARTH_PRED` and their SHA256 constants in `pipeline.ephem_orient`, independent of the build day. Builds check the raw bytes and download ledger; missing/unavailable or different inputs fail with recovery instructions. NAIF removes superseded high-precision daily names (the 3 October file returned 404 at its original URL and under `a_old_versions/` on 7 October), so keep the pinned raw files and `_downloads.json` entries. To review an update, run `cd pipeline && python -m pipeline.ephem_orient inspect-earth-pins`: it lists current candidates, downloads the newest into temporary files, prints names/hashes and the built window's interval that would become measured, and changes no pins, raw ledger or products. Deliberately edit each name and digest together with a comment/commit explaining why, keep the matching raw files/ledger, and rebuild `bodies`. A held pin remains measured only through 2026-10-06 UTC, predicted through 2027-01-02 UTC, then uses the low-accuracy long-term kernel; later builds do not acquire new measurements automatically. The long-term kernel's source EOP predicts only to 2026-11-02: beyond that it holds polar motion, nutation corrections and TAI−UT1R constant. Updating can also revise already measured dates; the build record `verification/orientation.json` always tests the exact kernels used.
- **Used by:** the `bodies` stage, which writes `app/public/data/orient/earth.json` and `.bin`. `bodies.json` Earth gets `orientation: "orient/earth"`. The app evaluates it with `PreciseOrientation` / `OrientationSet` in `app/src/core/rotation.ts`.
- **Labels:**
  - `measured` before the file's "UTC Epoch of last datum" (2026-10-06 in the pinned file);
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
