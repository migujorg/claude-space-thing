# Small bodies (M3): every catalogued asteroid and comet

Status: first full build on 2026-09-30. The stage is `smallbodies` (`pipeline/src/pipeline/stages/smallbodies.py`) and the reference propagator is `app/src/core/smallbody.ts`. The numbers below come from `uv run python -m pipeline.sb_report` after `uv run python -m pipeline build --only smallbodies`. Fixtures are regenerated with `uv run python -m pipeline.sb_fixtures`.

## 1. What was built

- **Every object in the JPL Small-Body Database:** 1,573,014 asteroids and comets as of the 2026-09-30 snapshot. Orbits are taken at full precision, with their non-gravitational models. Each object's osculating elements are turned into a state at its own epoch, then integrated to one **common epoch**: 2026-09-30 00:00 TDB (ET 843998400), the centre of the manifest window rounded to 0h TDB. The pipeline and the app use the same integrator.
- **Per-attribute provenance** for H, G, position, diameter, albedo, rotation period, colour, colour indices and taxonomy. Each has a label column and a source column, and the method is documented in the header. Estimated values sit in their own columns and never overwrite a measured or unknown one.
- **Verification:** 19 objects are compared with JPL Horizons over the ±548-day window, every 2 days. The 16 ordinary objects are within 7 km. Only the comets and a 21,000 km Earth flyby are worse, and they stay within their stated tolerances. A float64 TypeScript propagator reproduces the Python integrator bit for bit (difference 0.0 km).

## 2. Products (`app/public/data/smallbodies/`)

All tables are `BinaryTableHeader` + `.bin`, little-endian, fixed stride (`app/src/data/schema.ts`: `SmallBodyCoreHeader`, `SmallBodyPhysicalHeader`, `SmallBodyNamesHeader`). Labels use `labelEncoding` = measured, derived, estimated, synthetic, unknown (u8 0–4). Source indices point into the shared `sourceTable`, and 255 means no source. Each header's `columns` block gives every column's unit, label/source columns and method.

| File | Records | Stride | Bytes |
|---|---|---|---|
| `core.bin` / `core.json` | 1,573,014 (one per object, SBDB spkid order) | 80 | 125,841,120 / 13,941 |
| `physical.bin` / `.json` | 169,686 (objects with any measured physical attribute) | 68 | 11,538,648 / 6,663 |
| `comets.bin` / `.json` | 4,077 | 28 | 114,156 / 1,788 |
| `nongrav.bin` / `.json` | 976 | 88 | 85,888 / 2,071 |
| `names.txt` / `names.json` | 1,573,014 lines | — | 46,923,755 / 555 |
| **total** | | | **184.5 MB** |

**core** (80 B): `pos` f64×3 km and `vel` f64×3 km/s are heliocentric ICRF states at `epochEt`. Add the Sun's SSB position from the ephemeris to place them. The other fields are:
- `H`, `G`, `diameterFromH` as f32.
- `physRow` u32: the record in physical.bin, or 0xFFFFFFFF if there is none.
- `flags` u16. Bits are listed in `flagBits`: comet, numbered, neo, pha, nonGravitational, unsupportedModelTerms, preEphemerisTwoBody, positionLost, orbitFromMpc, twoBodyOrbitDetermination, oldPlanetaryEphemeris, horizonsState, mpcDisagrees, closeApproachInWindow, planetaryEphemeris.
- `orbitClass` u8: an index into `orbitClasses`, the SBDB class codes with names.
- `conditionCode` u8 (JPL) and `mpcU` u8 (MPC), on the U scale 0–9, with 255 for none.
- Labels: `posLabel`, `hLabel`, `gLabel`, `diameterFromHLabel`.
- Sources: `orbitSrc`, `hSrc`, `gSrc`, `diameterFromHSrc`.

The header also carries:
- `forceModel`: everything the propagator needs (§4).
- `classAlbedo`: the population statistic behind the estimated diameters.
- `statistics`: the counts in this report.
- `epochEt`, `window` and `snapshot`.

At 80 B per object, the 5 million objects expected after two years of LSST come to 400 MB of core. This is acceptable because the orbit is the only per-object float64 state.

**physical** (68 B): `row` u32 (core row). The measured values are:
- `diameter`, `diameterSigma`, `albedo`, `albedoSigma`, `rotPeriod` (h).
- `geometricAlbedoXYZS` f32×4, in "lux at 1 AU" per docs/architecture.md §4.3.
- `BV`, `UB`, `IR`.

Their labels and sources are in `diameterLabel/Src`, `albedoLabel/Src`, `rotLabel/Src`, `colorLabel/Src`, `colorIndexLabel/Src` and `taxonomyLabel/Src`. Codes and indices:
- `rotQuality`: the LCDB U code, an index into `lcdbU`.
- `gaiaBands`: the number of Gaia bands used.
- `taxonomyB` and `taxonomyT`: indices into the header lists (SMASSII/Bus, 35 classes; Tholen, 132 strings).

**comets** (28 B): `row`. Total-magnitude law `M1`, `K1`. Nuclear law `M2`, `K2`, `PC`. Labels `totalLabel` and `nuclearLabel`, with the SBDB as source. A brightness predicted from these laws is `estimated`: comets depart from them by 1–2 mag.

**nongrav** (88 B): `row`, then `A1 A2 A3` (km/s²), `DT` (s), `ALN`, `R0` (km), `NM`, `NN`, `NK` as f64. The propagator needs these, keyed by core row (`readNonGrav` in `app/src/core/smallbodyCatalog.ts`).

**names**: line *i* describes core record *i*. The tab-separated columns are `spkid`, `designation` (the number for numbered asteroids), `name`, `prefix` (comets) and `principalProvisionalDesignation`.

## 3. Inputs and provenance

| Source id | Dataset | Used for |
|---|---|---|
| `jpl-sbdb-orbits` | SBDB query API, 32 pages × 50,000 objects, `full-prec=1` (556 MB raw) | elements, H, fitted G, comet M1/K1/M2/K2/PC, condition code |
| `jpl-sbdb-nongrav` | 1,116 `sbdb.api` answers: every object with A1/A2/A3/DT/S0, or solved against an older DE | non-grav model constants (ALN, R0, NM, NN, NK); detecting unsupported terms |
| `jpl-sbdb-physical` | SBDB, 154,477 objects with a physical field | diameter, albedo, rotation, B–V/U–B/I–R, taxonomy |
| `neowise-v2` | NEOWISE Diameters and Albedos V2.0 (PDS) | diameter/p_V where SBDB has none (fit code D/V only) |
| `lcdb-2023-10` | LCDB public summary | rotation period with reliability U |
| `gaia-dr3-sso-reflectance` | Gaia DR3, 60,518 spectra | geometricAlbedoXYZS |
| `mpc-mpcorb` | MPCORB.DAT, 2026-09-29 | MPC U, cross-check of JPL orbits |
| `jpl-horizons-sb-states` | Horizons | 4 states at the common epoch (§4.4) and the verification |
| `jpl-cneos-cad` | CNEOS close-approach API, all planets, < 0.05 au, within the window | flag `closeApproachInWindow` (3,159 objects, 4,125 approaches) |
| `smallbodies-class-albedo`, `bowell-1989` | population values (docs/sources/smallbodies-class-albedo.md) | estimated diameters, the conventional G |
| `naif-de442s`, `naif-gm-de440`, `naif-pck00011`, `tsis1-hsrs-v2`, `cie-*`, `bessell-1990-v` | shared with M1 | perturbers, GMs, radii, Earth pole; colour integration |

The raw downloads for this stage total 0.73 GB, and all of `data/raw` is 803 MB. Every file is sha256-recorded in `data/raw/_downloads.json`, and JPL is queried sequentially with pauses. The notes are in `docs/sources/`: `jpl-sbdb.md`, `neowise-v2.md`, `lcdb-2023-10.md`, `gaia-dr3-sso-reflectance.md`, `mpc-mpcorb.md`, `smallbodies-class-albedo.md` and `jpl-horizons-sb-states.md`.

## 4. Propagation

### 4.1 Model (header `forceModel`)

The model is heliocentric, with the object treated as a test particle.

**Kepler drift about the Sun.** Exact, in universal variables: Stumpff c2 and c3, Laguerre–Conway iteration, and one code path for elliptic, parabolic and hyperbolic orbits.

**Kicks.** Each kick sums these accelerations:
- Mercury, Venus, Earth, Moon, and the Mars, Jupiter, Saturn, Uranus, Neptune and Pluto system barycentres, taken from DE442s: the direct term plus the indirect term Σ GM_p x_p/|x_p|³.
- Earth J2 (IERS 2010), about the IAU_EARTH pole.
- The solar 1PN term (IERS 2010 Eq. 10.12).
- The fitted non-gravitational acceleration g(r(t−DT))·(A1 r̂ + A2 t̂ + A3 n̂) (Marsden et al. 1973). Its constants come per object from SBDB, e.g. Apophis uses g = (1 au/r)².

**Elements → state.** The elements are referred to the ecliptic J2000, rotated to the ICRF with the IAU 1976 obliquity. For e < 1 the time since perihelion is M/n, with M reduced to (−π, π], otherwise it is epoch − tp. The perihelion state is then drifted by that time.

### 4.2 Scheme

The splitting is SABA3 (Laskar & Robutel 2001), with drifts c = (½ − √15/10, √15/10, √15/10, ½ − √15/10) and kicks d = (5/18, 4/9, 5/18).

Steps end on the grid `epochEt` + m·2 days. Each step of length h is split into 2^level equal substeps, and the level is set from the state at the start of the step:
- τ_sun = √(r_eff³/GM_sun), with r_eff = max(q_osc, r − |v||h|).
- For each planet p, the straight relative path over the step (planet velocity from its positions at the two ends) gives d_min. Then τ_p = min(d_min/u, √(d_min³/GM_p)).
- h ≤ min(0.3 τ_sun, η_p τ_p). η_p is 0.3, or 0.01 when that planet's pull exceeds 10⁻³ of the Sun's.
- The level is capped at 16.

**Encounter mode.** When any planet's pull exceeds 10⁻³ of the Sun's during a step, that step's substeps are classical RK4 on the full acceleration, capped at 0.01 τ_sun. The Sun-centred split converges badly once a planet dominates.

**Special handling:**
- **Pre-1850 epochs.** The 206 objects with epochs before DE442s begins (historical comets back to −146) are drifted two-body to the first grid point inside the ephemeris. Their position is labelled `estimated`.
- **Collisions.** Passing inside a planet, the Moon or the Sun gives position `unknown`. This applies to 61 objects: 21 Shoemaker-Levy 9 fragments, 27 SOHO/SMM/SOLWIND sungrazers, and 13 Earth impactors from 2008 TC3 to 2026 RW1.

### 4.3 How the scheme was chosen (measured)

**Scheme, against Horizons.** Maximum error in km over the window, with a 2-day base step:

| Scheme | Ceres | Eris | Eros | Icarus | Phaethon | Apophis | 2P/Encke | C/2025 A6 | 3I/ATLAS |
|---|---|---|---|---|---|---|---|---|---|
| SABA1 (leapfrog) | 5.21 | 1.78 | 1.08 | 2.88 | 3.32 | 0.99 | 4.03 | 1.71 | **108** |
| SABA2 | 5.47 | 0.57 | 0.82 | 1.74 | 3.49 | 0.12 | 29.2 | 0.81 | 1.55 |
| SABA3 | 5.47 | 0.57 | 0.82 | 1.74 | 3.49 | 0.12 | 29.2 | 0.81 | 1.53 |

SABA2 and SABA3 have converged onto the force model's own difference from Horizons. SABA1 has not: 3I/ATLAS is off by 108 km, and Encke's 4 km agrees with Horizons only by chance. SABA3 costs 3 kicks per step. A 4-day or 8-day base step gives the same numbers for these objects, but it breaks the 2026 RT34 flyby: the integration error is 34 km at 4 days and 3×10⁵ km at 8 days. The base step is therefore 2 days.

**Integration error alone.** Here the same forces are integrated with adaptive DOP853 (rtol 10⁻¹³, `sb_verify.reference`), sampled every 20 days over ±548 days:

| Sample | n | Max (km) | p99 | Median |
|---|---|---|---|---|
| random objects | 150 | 0.025 | 0.022 | 0.002 |
| Earth approaches < 0.05 au in the window (CNEOS) | 150 | 1.14 | 0.55 | 0.020 |
| q < 0.3 au | 60 | 0.35 | 0.19 | < 0.001 |
| comets with non-grav | 40 | 0.73 | 0.45 | < 0.001 |
| Jupiter Trojans | 20 | 0.001 | | |
| TNOs, hyperbolic | 20, 19 | < 0.001 | | |

Without encounter mode, the 21,000 km flyby of 2026 RT34 has an integration error of 143 km. With it the error is 0.01–0.14 km.

### 4.4 Horizons states at the common epoch

Four objects take their state at the common epoch from JPL Horizons instead of from integration:
- **101955 Bennu.** Farnocchia et al. 2021 thermal model (RHO, AMRAT); Horizons serves it from an SPK.
- **1P/Halley.** S0.
- **C/2013 A1 Siding Spring.** Rotating-jet terms.
- **134340 Pluto.** The SBDB object is also the force model's Pluto perturber, so it is flagged `planetaryEphemeris`. The app should draw it from the planetary ephemeris.

## 5. Verification against JPL Horizons

Each object follows the same path the stage and the app use:
1. SBDB elements give a state at the SBDB epoch.
2. That state is integrated to the common epoch.
3. From there it is integrated to every 2-day grid epoch in the window: 548 epochs, 2025-04-02 to 2028-03-30.

Horizons returns the same orbit solution in every case (orbit_id = `soln ref.`). Horizons' model differs from ours: it uses DE441 and adds 16 massive asteroids and, per ASSIST (Holman et al. 2023), which reproduces it, Earth J3/J4 and solar J2.

| Object | Class | q (au) | e | Solution | Max \|Δr\| (km) | Tolerance (km) | Max level |
|---|---|---|---|---|---|---|---|
| 1 Ceres | main belt (dwarf planet) | 2.545 | 0.080 | JPL 48 | 5.47 | 10 | 0 |
| 2 Pallas | main belt, i = 35° | 2.131 | 0.231 | JPL 74 | 2.10 | 10 | 0 |
| 4 Vesta | main belt | 2.148 | 0.090 | JPL 36 | 1.24 | 10 | 0 |
| 153 Hilda | Hilda (3:2) | 3.419 | 0.138 | JPL 87 | 2.50 | 10 | 0 |
| 624 Hektor | Jupiter Trojan | 5.149 | 0.024 | JPL 139 | 1.14 | 10 | 0 |
| 2060 Chiron | Centaur | 8.487 | 0.380 | JPL 171 | 0.85 | 10 | 0 |
| 10199 Chariklo | Centaur | 13.047 | 0.171 | JPL 61 | 0.72 | 10 | 0 |
| 136199 Eris | scattered-disc TNO | 38.163 | 0.438 | JPL 103 | 0.57 | 10 | 0 |
| 486958 Arrokoth | cold classical TNO | 42.486 | 0.036 | JPL 3 | 0.78 | 10 | 0 |
| 433 Eros | NEO (Amor) | 1.133 | 0.223 | JPL 659 | 0.82 | 10 | 0 |
| 1566 Icarus | NEO, q = 0.19 au | 0.186 | 0.827 | JPL 196 | 1.74 | 30 | 2 |
| 3200 Phaethon | NEO, q = 0.14 au | 0.140 | 0.890 | JPL 1003 | 3.49 | 30 | 2 |
| 99942 Apophis | NEO (Aten), Yarkovsky A2 | 0.746 | 0.191 | JPL 220 | 0.12 | 10 | 0 |
| 101955 Bennu | NEO, special thermal model (Horizons state at epoch) | 0.897 | 0.204 | JPL 118 | 6.98 | 10 | 0 |
| 2026 RT34 | NEO, Earth flyby at 21,000 km on 2026-09-13 | 0.618 | 0.394 | JPL 1 | 135 | 1000 | 14 |
| 2P/Encke | JFC, q = 0.34 au, non-grav | 0.340 | 0.847 | JPL K273/18 | 29.2 | 60 | 0 |
| 67P/Churyumov–Gerasimenko | JFC, non-grav, epoch 2015 | 1.243 | 0.641 | JPL K284/1 | 19.4 | 60 | 0 |
| C/2025 A6 (Lemmon) | long-period comet, non-grav | 0.530 | 0.996 | JPL 41 | 0.81 | 60 | 1 |
| 3I/ATLAS (C/2025 N1) | interstellar, e = 6.14, non-grav with DT | 1.356 | 6.141 | JPL 54 | 1.52 | 60 | 5 |

Each difference is accounted for as follows. The DOP853 reference gives the same differences to within 0.01 km, so every one of them comes from the force model, not the integrator.

- **Ceres, 5.5 km.** Vesta and Pallas are not perturbers. The research note found the same with this force model.
- **Bennu, 7.0 km.** From the Horizons state onward, it is propagated without its thermal Yarkovsky model.
- **2026 RT34, 135 km.** The flyby magnifies any difference in approach geometry by about 10⁴. Horizons models more Earth harmonics, and 16 asteroids act before the flyby. Without Earth J2 the error is 13,400 km. The orbit's own uncertainty (condition code 5) is far larger.
- **Comets.** The non-gravitational acceleration matches Horizons to about 0.3%. Changing it by 1% moves Encke by 90 km and 67P by 1,800 km. Encke's 29 km is a timing offset at the February 2027 perihelion, and it falls to 4 km afterwards. 67P is integrated from a 2015 epoch.

The 2 km to 7 km differences are far below a pixel at any viewing distance except a close fly-by. They are also far below the orbit uncertainty of most objects: U ≥ 3 means ≥ 20″/decade.

## 6. Catalogue content

| Kind | Objects |
|---|---|
| Numbered asteroids | 895,910 |
| Unnumbered asteroids | 673,027 |
| Numbered comets | 610 |
| Unnumbered comets | 3,467 |
| NEOs / PHAs | 42,743 / 2,549 |

| SBDB class | Objects | Median measured p_V (n) |
|---|---|---|
| MBA main belt | 1,387,741 | 0.081 (126,549) |
| OMB outer main belt | 50,589 | 0.060 (7,720) |
| IMB inner main belt | 33,012 | 0.469 (472) |
| MCA Mars-crosser | 30,162 | 0.144 (598) |
| APO Apollo | 24,179 | 0.128 (744) |
| TJN Jupiter Trojan | 16,394 | 0.070 (1,879) |
| AMO Amor | 14,856 | 0.129 (334) |
| TNO | 7,293 | < 20 measured → all-class 0.078 |
| ATE Aten | 3,462 | 0.205 (125) |
| CEN Centaur | 1,051 | 0.061 (56) |
| IEO Atira, AST, HYA | 38, 155, 5 | all-class 0.078 |
| comets: PAR 1,763, JFc 831, COM 733, HYP 520, HTC 111, ETc 80, CTc 22, JFC 17 | 4,077 | no diameter from H |

### Attribute coverage and labels

| Attribute | Measured | Derived | Estimated | Unknown |
|---|---|---|---|---|
| position at the common epoch | — | 1,572,747 | 206 | 61 |
| H | 1,568,436 | — | — | 4,578 (comets, 502 asteroids) |
| G | 120 | — | 1,568,315 (G = 0.15) | 4,579 |
| diameter | 139,730 | — | — | 1,433,284 |
| diameter from H (separate column) | — | 2 | 1,429,188 | 143,824 |
| geometric albedo p_V | 138,520 | — | — | 1,434,494 |
| rotation period | 32,951 | — | 1,664 (LCDB U ≤ 1+ or unrated) | 1,538,399 |
| colour (geometricAlbedoXYZS) | — | 36,081 | 18,253 (class p_V or gap) | 1,518,680 |
| B−V / U−B / I−R | 1,021 | — | — | 1,571,993 |
| taxonomy (SMASSII or Tholen) | 2,174 | — | — | 1,570,840 |

**Diameter.** 139,687 diameters come from the SBDB and 43 more from NEOWISE. Of the 139,066 objects with both, 91% agree within 1% (median ratio 1.000): the SBDB value is mostly NEOWISE. NEOWISE rows whose fit code does not include D are never used as diameters.

**Rotation (LCDB).** LCDB supplies 30,907 measured periods and 1,664 estimated ones. The remaining measured periods come from the SBDB rot_per. 1,988 LCDB entries are period limits and one is U = 0; neither is used.

**Colour (Gaia DR3).** All 60,518 spectra match an SBDB object. 6,184 of them have a flagged or missing band between 418 and 770 nm, and those objects get no colour. The 374 nm band is flagged for 74% of objects. Bridging it changes XYZS by at most 0.37%, the maximum over 2,000 fully good spectra (`edgeBandEffectMax`), so it does not demote the label.

**Estimated diameters** use the class medians above. The 16th–84th percentile range, e.g. MBA 0.046–0.255, is the honest spread and implies roughly ±40–60% in D.

### Orbit quality

- **Condition code.** 1,141,450 objects have code 0. 2,967 have none, mostly comets.
- **MPC cross-check.** 1,464,556 objects appear in both MPCORB and SBDB at the 2026-06-09 epoch. At that epoch the positions from the two orbits differ by a median of 59 km for condition code 0, which is MPCORB's 5-decimal rounding. At code 2 the median difference is 1,650 km, at code 5 it is 35,000 km and at code 7 it is 380,000 km. The 59,180 objects where the gap exceeds 10⁵ km are flagged `mpcDisagrees`; they are almost all code 5–9 orbits.
- **Close approaches.** 3,159 objects have a CNEOS-listed approach within 0.05 au of a planet in the window, and they are flagged. The GPU needs encounter substeps for them.

## 7. Runtime and sizes

The full stage took **17 min 50 s** on 4 vCPUs shared with other jobs. Integrating 1.57 M objects to the common epoch took 865 s: 236 M substeps, 12% of them in encounter mode. The 100,273 objects with non-standard epochs take 63% of that time. The rest of the time breaks down as follows:

| Step | Time |
|---|---|
| parse the SBDB JSON | 31 s |
| MPCORB | 24 s |
| physical merge | 30 s |
| write | 7 s |
| Horizons verification | 10–80 s (numba JIT warm or cold) |

Propagated states are cached in `data/cache/smallbodies_states_<key>.npz`. The key covers the snapshot, objects, epoch, force model and integrator source. With the cache, a rebuild takes **2 min 10 s**.

Across the window, the scheme averages **274 substeps per object** for ±548 days, 9.7% of them RK4. On the CPU this is about 590 µs per object per direction, so ~15 min per direction for the whole catalogue on 4 cores. This is the workload the GPU takes over (§8).

Products total 184.5 MB (§2). Raw downloads for this stage come to 0.73 GB.

## 8. Notes for the GPU implementation

- **Ground truth.** `SmallBodyPropagator.propagateOne(state, 0, epochEt, et, epochEt, nonGrav)` in `app/src/core/smallbody.ts` is the reference. It reproduces the pipeline to 0.0 km on all 19 fixtures, and `app/tests/smallbody-propagation.test.ts` checks it against Horizons. A GPU version should match it to its df64 rounding.
- **Grid.** Steps end on `epochEt + m·baseStepS`. On the grid, propagating t0 → t1 → t2 equals propagating t0 → t2, so keyframes on the grid are exact restarts.
- **Cost per substep.** SABA3 is 4 Kepler solves (usually 2–3 Laguerre iterations, with a Maclaurin Stumpff series since |z| < 1) and 3 force evaluations. A force evaluation covers 10 perturbers plus J2, 1PN and non-grav where present.
- **Shared perturber positions.** At level 0, every object on the grid kicks at the same times (t + c_cum·h), so perturber positions can be computed once per step for all objects. Only substeps and partial steps need per-object Chebyshev evaluation.
- **Divergence is rare.** In a ±548-day run of 50,000 random objects, 49,956 never leave level 0 and 15 go above level 4.
- **Precision.** WGSL has no f64. Heliocentric positions reach 10¹⁰ km, so the drift's f − 1 and ġ − 1 increments and the kicks need df64. Positions relative to the Sun keep the magnitudes moderate. Add the Sun's SSB position, from the ephemeris in df64, only for rendering.

## 9. Tests

- **pytest, 29 small-body tests** (78 in the whole suite, all passing):
  - `test_sb_parsers.py`: MPC packed designations, SBDB pages and non-grav model_pars, NEOWISE, LCDB, Gaia, MPCORB, and time-since-perihelion consistency.
  - `test_sb_dynamics.py`:
    - Kepler drift conservation and reversibility for all conic types.
    - Elements against the classical solution.
    - Stumpff series continuity.
    - The splitting without planets equals exact Kepler, conserving energy and angular momentum to 10⁻¹².
    - Forward/back reversibility through perihelion.
    - Integration error against DOP853 for 5 objects: Ceres 0.003, Phaethon 0.002, 2026 RT34 0.14, 3I 0.004 and Encke 0.002 km.
    - All 19 objects against Horizons within tolerance, and re-computation of the product's common-epoch states to 10⁻⁶ km.
  - `test_sb_physical.py`: label rules for SBDB/NEOWISE precedence and fit codes, inverse-variance combination, estimated diameters (never for comets or where measured), LCDB U codes and limits, and Gaia derived versus estimated.
  - `test_sb_table.py`: layout alignment, float64 round-trip, and consistency of the built products: NaN ⇔ unknown, sources exist, physRow back-links, no measured diameter alongside diameterFromH, names line count, and SABA coefficients summing to 1.
- **vitest, 16 small-body tests** (130 in the whole suite, all passing):
  - `smallbody-kepler.test.ts`: Stumpff, conservation, reversibility, period closure, elements, obliquity rotation and the step grid.
  - `smallbody-catalog.test.ts`: core, non-grav and names readers, labels and flags.
  - `smallbody-propagation.test.ts`: elementsToState against Python to 10⁻¹⁴; propagation against Python (0.0 km) and against Horizons within tolerance; the built core holds the fixture states bit for bit.

## 10. Open issues

1. **Asteroid perturbers.** The 16 massive asteroids are not perturbers (sb441-n16.bsp, 616 MB). This costs about 5 km for Ceres-like cases and more for objects that approach Ceres or Vesta.
2. **Deep Earth encounters.** Earth J3/J4 and solar J2 are missing. After a deep flyby positions carry tens to hundreds of km of model difference (2026 RT34: 135 km). 3,159 objects are flagged `closeApproachInWindow`. Close approachers could use Horizons SPKs, as the research note suggests.
3. **Comet non-gravitational models.** They match Horizons to ~0.3%, giving ≤ 30 km in the verification. Comets with only old orbits (e.g. 67P's 2015 epoch) accumulate more, although their true uncertainty is much larger.
4. **Special models.** Bennu, Halley and Siding Spring start from Horizons states but are propagated without their special terms (Bennu: 7 km over the window).
5. **Orbit uncertainty.** Only U and the condition code are carried. There are no covariances or sigma columns, and no per-object uncertainty ellipsoid yet.
6. **Physical data not yet ingested:**
   - SsODNet ssoBFT: G1/G2 phase functions (so G is `measured` for only 120 objects), better H, Mahlke taxonomy.
   - DAMIT shapes and poles.
   - SDSS MOC colours.
   - The TNO/Centaur albedo compilation. TNOs currently fall back to the all-class median p_V 0.078, which is poor for TNOs.
   - Class-mean spectra as estimated colours for objects without Gaia spectra.
7. **Stale or restricted sources.** The LCDB public release dates from 2023-10. The Gaia DR3 SSO licence is CC BY-NC.
8. **Sampling bias.** The class-albedo statistic uses the currently measured sample, which is biased (§3).
9. **Rebuild cost.** A full rebuild takes 18 minutes, dominated by the 100k objects with non-standard epochs. Sharing perturber positions per grid step (§8) would speed it up, and so would taking JPL's standard-epoch elements where they exist.
10. **Loader.** The app loader (`app/src/data/load.ts`) does not load the smallbodies products yet. That belongs to the renderer and app integration; `smallbodyCatalog.ts` provides the readers.
