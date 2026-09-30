# naif-moon-fk-de440: NAIF lunar frames kernel for DE440

- **URL:** https://naif.jpl.nasa.gov/pub/naif/generic_kernels/fk/satellites/moon_de440_250416.tf (19 KB). The name `moon_de440_220930.tf` listed in NAIF's `pck/aareadme.txt` returns 404, per the research notes.
- **Used by:** the `bodies` stage, for `orient/moon`.
- **Label:** `measured`, together with naif-moon-pa-de440.
- **Citation:** NAIF frame kernel `moon_de440_250416.tf`, which defines MOON_PA_DE440 (frame 31008) and MOON_ME_DE440_ME421 (31009). The DE440 lunar frames are from Park et al. (2021), *AJ* 161, 105, DOI:10.3847/1538-3881/abd414.

## What is taken

The constant rotation MOON_ME_DE440_ME421 → MOON_PA_DE440. It is a TK frame of three small fixed angles, evaluated by SPICE (`pxform`) rather than typed in, and stored as `bodies["301"].bodyToPck` in `orient/moon.json`.
