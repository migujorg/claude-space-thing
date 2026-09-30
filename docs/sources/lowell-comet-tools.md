# lowell-comet-tools: Fluorescence efficiencies and Haser scale lengths (Lowell Observatory comet tools API)

- **URL:** https://asteroid.lowell.edu/api/comet/calc/gfactor?r=<r>&v=<v> (cached as `data/raw/comets/lowell-tools/gfactor_r0.5_v+0.json`, 528 bytes, sha256 a55b3c7023cabb9d1a65dc2d187042b9a616dc666ba699e31b921757adfe640b; `data/raw/comets/lowell-tools/gfactor_r1_v+0.json`, 531 bytes, sha256 20ac457040fc2a324ace0b257cb6b05807f25fb4c8e3954fcd6177d1b70bdbcc; `data/raw/comets/lowell-tools/gfactor_r1_v+20.json`, 533 bytes, sha256 21618a7cb7b94115f90221d6a2609bcea31f805f62b409ddb4be765ab2f91a09; `data/raw/comets/lowell-tools/gfactor_r1_v+40.json`, 533 bytes, sha256 a2d2504cad12e9f97623e7f56fc1aa16fcee79849e581522a5088fe4c5835d4b; `data/raw/comets/lowell-tools/gfactor_r1_v-20.json`, 535 bytes, sha256 0b678879e3c23867ef8e589387a98992d7c9626f9631a3e93c56f16696472f99; `data/raw/comets/lowell-tools/gfactor_r1_v-40.json`, 535 bytes, sha256 199e38f94dc965a2dde8ebe3ec334d145ef19942dccff1be55b6db013e47b3ee; `data/raw/comets/lowell-tools/gfactor_r2_v+0.json`, 534 bytes, sha256 3fadedcc263dc1649fd402cbccd6943e3538974900dc1b0d0e2f33c331be1eea; `data/raw/comets/lowell-tools/haser_r1_d1_ap10.json`, 1 185 bytes, sha256 ab07a57d445f2c80eda167485d370e60a2d8f34a4d73b8300ce337f22d5c7fff; retrieved 2026-09-30).
- **Recorded sha256:** 070948f53c29f36634cb37627543c9130a9226af634cf1aae3b3cbee76f01540 (SHA-256 over the per-file sha256 values, one per line, file order).
- **Citation:** Lowell Observatory Minor Planet Services, comet tools (https://asteroid.lowell.edu/comet/): fluorescence efficiencies and Haser scale lengths as used by A'Hearn et al. (1995), Icarus 118, 223-270, DOI:10.1006/icar.1995.1190; CN: Schleicher, D. G. (2010), AJ 140, 973, DOI:10.1088/0004-6256/140/4/973; NH: Meier, R. et al. (1998), Icarus 136, 268; OH: Schleicher, D. G. & A'Hearn, M. F. (1988), ApJ 331, 1058; OH scale lengths: Cochran, A. L. & Schleicher, D. G. (1993), Icarus 105, 235; other scale lengths: Randall, C. E. et al. (1992), BAAS 24, 1002.
- **Licence:** Public web service (Lowell Observatory).

## Contents

JSON answers of https://asteroid.lowell.edu/api/comet/calc/gfactor (L/N of OH, NH, CN, C3, C2 at 1 au for a heliocentric distance and radial velocity: CN from Schleicher 2010, NH from Meier et al. 1998, OH from Schleicher & A'Hearn 1988, C2 Δv = 0 and C3 from A'Hearn et al. 1995) and https://asteroid.lowell.edu/api/comet/calc/haser (parent and daughter Haser scale lengths at 1 au, scaling as r²).

## How it is used

`comets/model.json` gFactors (C2 4.5e-13, C3 1.0e-12 erg s⁻¹ molecule⁻¹; CN versus radial velocity, the Swings effect) and haser (C2 22 000/66 000 km, CN 13 000/210 000 km, C3 2800/27 000 km, OH 24 000/160 000 km): band luminosities L = g·Q·l_d/v of the coma's gas and its spatial profiles.

## Caveats

- The scale lengths are Haser-equivalent values for v = 1 km/s (A'Hearn et al. 1995 convention); they reproduce profiles, not physical lifetimes.
- CN and NH vary with r beyond the r⁻² scaling; only the velocity dependence at r = 1 au is used (CN contributes almost nothing to what the eye sees).
