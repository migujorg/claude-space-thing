# mpc-mpcorb: MPCORB.DAT (Minor Planet Center)

- **URL:** https://minorplanetcenter.net/iau/MPCORB/MPCORB.DAT.gz (94 MB, daily). Format: https://minorplanetcenter.net/iau/info/MPOrbitFormat.html; U: https://www.minorplanetcenter.net/iau/info/UValue.html.
- **Used by:** the `smallbodies` stage (`sb_physical_sources.read_mpcorb`) → `smallbodies/core.bin` column `mpcU`, flag `mpcDisagrees`, and the cross-check statistics in the report.
- **Citation:** Minor Planet Center, Smithsonian Astrophysical Observatory / IAU. MPCORB.DAT orbit file.
- **Licence:** MPC data; the terms in the MPCORB header apply (acknowledge the MPC).

## Use

- **U.** Column 106: the MPC uncertainty parameter 0-9 (in-orbit longitude runoff per decade: U = 0 < 1″, each step ×e^1.49). Non-numeric codes (E, D, F, blank) are stored as 255. The JPL `condition_code` on the same scale is stored alongside (`conditionCode`).
- **Cross-check.** For every object in both catalogues at the common standard epoch (MPC `K2669` = 2026-06-09.0 TT; JPL JD 2461200.5 TDB, 1.6 ms apart), the heliocentric position from the MPC elements is compared with the one from the JPL elements. MPCORB prints angles to 1e-5° and a to 1e-7 au, which alone is worth tens of km, so only gaps above 10⁵ km set the `mpcDisagrees` flag. The JPL elements are the ones propagated.
- **Designations.** Packed designations are unpacked (numbers with letter and tilde prefixes, provisional designations, P-L and T-1/2/3 survey designations) and matched to the SBDB primary designation.
