# naif-lsk-naif0012: NAIF leapseconds kernel `naif0012.tls`

- **URL:** https://naif.jpl.nasa.gov/pub/naif/generic_kernels/lsk/naif0012.tls
- **Used by:** the `time` stage, which writes `app/public/data/time.json` (schema `TimeData`). The app converts with `app/src/core/time.ts`.
- **Label:** `measured`. The leap seconds are IERS announcements, and the TDB−TT formula is a published fit (Moyer 1981).
- **Citation:** NAIF LSK naif0012.tls (NAIF/JPL, 2016-07-14). Leap seconds through 2017-01-01 as announced in IERS Bulletin C. The TDB−TT formula comes from Moyer, T. D. (1981), *Celestial Mechanics* 23, 33–56 and 57–68.

## What is taken

- **`DELTET/DELTA_AT`:** 28 pairs (ΔAT, date). ΔAT runs from 10 s at 1972-01-01 to 37 s at 2017-01-01.
- **Other constants:** `DELTET/DELTA_T_A` = 32.184 s, `DELTET/K` = 1.657e-3 s, `DELTET/EB` = 1.671e-2, and `DELTET/M` = (6.239996, 1.99096871e-7 rad/s).

The file is read through SPICE's own kernel-pool parser (spiceypy), so the `@1972-JAN-1` dates come out exactly as SPICE sees them.

## Conventions (exact)

- **`utcJ2000`:** equals the Unix seconds of the UTC instant minus 946728000. That is the number of seconds since 2000-01-01T12:00:00, counting 86400 s per UTC day and no leap seconds. It is identical to SPICE's "UTC seconds past J2000" in `DELTET/DELTA_AT`.
- **Conversion chain:** `TT = UTC + ΔAT + 32.184`, then `TDB = TT + K sin(E)`, where `E = M + EB sin M` and `M = M0 + M1·TT`. This is SPICE DELTET. The formula is good to about 30 µs; the LSK says so itself.
- **Before 1972-01-01:** SPICE uses ΔAT = 10 − 1 = 9 s, and `TimeScale` does the same, so it matches SPICE everywhere. UTC before 1972 was not defined by whole leap seconds, so neither implementation is exact there. This is irrelevant for v1.
- **Inside a leap second (23:59:60.x):** Unix-millisecond UTC cannot name it. `etToUtcMs` clamps to 00:00:00.000 of the next day and stays monotonic.

## Verification

- **pipeline/tests/test_time.py:** the JSON equals the kernel pool. A Python port of the algorithm matches `spiceypy.str2et` to within 2.4e-7 s at 3168 instants from 1960 to 2040, including ±1 ms around every leap second.
- **app/tests/core-time.test.ts:** `TimeScale` matches `str2et`/`et2utc` fixtures to within 6e-8 s and 0.5 µs. Round trips agree to within 0.12 µs, and the 2016-12-31 leap second is handled with the clamp.

## Maintenance

naif0012 is still NAIF's current LSK; no leap second has been announced since 2017. When IERS announces one, NAIF will publish a new LSK. Update the URL in `pipeline/src/pipeline/ephem_kernels.py` and rebuild.
