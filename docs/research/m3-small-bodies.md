# M3 research: every known small body

Status: research notes for M3 ("The full MPC/JPL catalogs of asteroids and comets propagated on the GPU, with measured sizes, colors, rotation and shapes where they exist"). Written 2026-09-30.

**How this was verified.** Counts come from live API queries on 2026-09-30. File sizes come from HEAD requests and directory listings. Files larger than 50 MB were inspected with range requests only. The propagation error numbers come from an experiment run for this note. DOIs were checked against Crossref or DataCite. Label shorthand: **M** measured, **D** derived, **E** estimated, **U** unknown.

---

## 1. Orbits: MPC vs JPL SBDB

### Counts on 2026-09-30

| | MPC (`https://minorplanetcenter.net/mpc/summary`) | JPL SBDB (Query API count) |
|---|---|---|
| Minor planets, total | 1,573,545 | 1,568,937 asteroids |
| Numbered / unnumbered | 895,910 / 672,991 | 895,910 / 673,027 |
| NEAs | 42,543 (869 with D > 1 km) | 42,743 NEOs (`sb-group=neo`) |
| Comets | 959 in `CometEls.txt` (current); `AllCometEls.txt` has 4,647 lines | 4,077 (`sb-kind=c`) |

### Bulk files

| File | Size | Epoch / format | Notes |
|---|---|---|---|
| `https://minorplanetcenter.net/iau/MPCORB/MPCORB.DAT.gz` | 94.1 MB, daily | Standard epoch **K2669 = 2026-06-09.0 TT** (JD 2461200.5). Fixed-width columns per `…/info/MPOrbitFormat.html`. | Fields: H, G, epoch, M, ω, Ω, i, e, n, a, **U**, reference, #obs, #opp, arc, rms, perturbers, computer, hex flags, designation, last obs. **Angles have 5 decimals and a has 7**, so rounding alone is worth tens of km for a main-belt asteroid. The licence header must accompany any redistribution. |
| `https://minorplanetcenter.net/Extended_Files/mpcorb_extended.json.gz` | 182 MB | same epoch; JSON | Adds `Orbit_type`, `Tp`, q/Q, `Critical_list…`, other designations |
| `https://minorplanetcenter.net/iau/MPCORB/NEA.txt` | 8.6 MB | MPCORB format | NEAs only |
| `https://minorplanetcenter.net/iau/MPCORB/CometEls.txt` | 163 KB | current perihelion elements plus **H and G for comets** (m = H + 5 log Δ + 2.5·G·log r, i.e. K = 2.5 G) | 959 comets |
| `https://ssd.jpl.nasa.gov/dat/ELEMENTS.NUMBR.gz` | 38.3 MB (102 MB unzipped) | epoch MJD 61200 = 2026-06-09; a, e, i, ω, Ω, M, H, G | 7–8 significant digits. No uncertainties. |
| `https://ssd.jpl.nasa.gov/dat/ELEMENTS.UNNUM.gz` | 25.4 MB | **Epochs vary**: poorly observed objects keep old epochs (e.g. 1927 LA at MJD 25051). `H = 99.00` means missing. | |
| `https://ssd.jpl.nasa.gov/dat/ELEMENTS.COMET` | 522 KB | perihelion elements | no magnitudes |
| **SBDB Query API** `https://ssd-api.jpl.nasa.gov/sbdb_query.api` | 20,000 rows in 2 s (4.9 MB JSON) | any field set; paginate with `limit` and `limit-from` | **Pass `full-prec=1`.** Without it the API returns display-rounded elements, e.g. Ceres a = 2.766 and e = 0.0797, which is useless for positions. With it you get 16 digits. |
| Lowell `https://ftp.lowell.edu/pub/elgb/astorb.dat.gz` | 114 MB, daily | includes a current ephemeris uncertainty (CEU) | Alternative; not needed. |

**Useful SBDB fields** (Query API, all as strings): `e, a, q, i, om, w, ma, tp, epoch, H, G, M1, K1, M2, K2, PC, A1, A2, A3, DT` (comet non-gravitational terms), `diameter, diameter_sigma, albedo, rot_per, spec_B, spec_T, BV, UB, GM, pole, extent`, and `condition_code, data_arc, n_obs_used, sigma_a, sigma_e, sigma_ma, … , moid, class`.

Coverage today:

| Field | Objects with a value |
|---|---|
| `H` | 1,568,435 |
| `G` | **120** (all others use the default) |
| `diameter` | 139,582 |
| `albedo` | 138,461 |
| `rot_per` | 34,592 |
| `spec_B` | 1,666 |
| `spec_T` | 980 |
| `BV` | 1,021 |
| `pole` | 13 |

Orbit quality:

| Condition | Objects |
|---|---|
| Epoch ≠ JD 2461200.5 | 96,196 |
| Epoch before 2000 | 192 |
| `condition_code` > 5 | 184,960 |
| `data_arc` < 30 d | 165,674 |
| q < 0.3 au | 475 |

The fair-use policy (https://ssd-api.jpl.nasa.gov/) applies: one request at a time, a `User-Agent` with product and contact (**the user must configure the contact**; this note used none), back off on errors, and no browser use.

**Uncertainty.** For MPC orbits, U (0–9) is the in-orbit longitude runoff per decade. U = 0 means under 1″. Each step is ×e^1.49: U=1 <4.4″, 2 <19.6″, 3 <86.5″, 4 <382″, 5 <1692″, 6 <7488″, 7 <33,121″, 8 <146,502″ (`https://www.minorplanetcenter.net/iau/info/UValue.html`). For a ±18-month window, scale it by ~0.15 decade. Along-track error from period uncertainty grows roughly linearly with time. SBDB instead gives formal 1σ element uncertainties (`sigma_*`) and a JPL `condition_code` on the same 0–9 scale. Show both in the inspector.

**Recommendation.**

- **Primary:** SBDB with `full-prec=1` for orbits, sigmas, condition code, physical parameters and non-gravitational terms. Pull it in pages of about 20k, serially: roughly 80 requests and about 400–600 MB of JSON for the full set.
- **Cross-check and U:** MPCORB. Join on designation. Flag objects where the MPC and JPL positions at "now" differ by more than their stated uncertainty.
- **Comets:** SBDB `M1/K1` (1,992 comets) and `M2/K2/PC` (872), plus MPC `CometEls.txt` for H and G of currently observable comets.

---

## 2. Physical properties: sources, sizes, what they measure

| Attribute | Source (URL) | Size / format | Count | Label |
|---|---|---|---|---|
| **Diameter, pV (thermal)** | NEOWISE Diameters and Albedos V2.0, `https://sbnarchive.psi.edu/pds4/non_mission/neowise_diameters_albedos_V2_0/data/` (`neowise_mainbelt.csv` 26 MB, `_neos` 225 KB, `_jupiter_trojans` 274 KB, `_hildas` 161 KB, `_centaurs`, `_irreg_sat`) | CSV; one row per fit | ~183k fits, **143,333 unique objects** | D **measured** when `Fit_code` contains `D`; otherwise the value is "assumed value if not fitted", so E. pV depends on the input H (see below). |
| Diameter (occultation) | `…/non_mission/smallbodiesoccultations_V4_0/AsteroidDiameters_2024Mar.psv` (35 KB) + summary | PSV | hundreds | M (best) |
| Diameter/albedo (TNOs, Centaurs) | `…/tno-centaur_diam-albedo-density_V1_0/` (151 KB) | PDS table | ~ hundreds | M |
| **Everything, curated** | **SsODNet ssoBFT** (IMCCE): `https://ssp.imcce.fr/data/ssoBFT-latest_Asteroid.parquet` (**856 MB**, updated weekly; last 2026-09-22), `_Comet.parquet` (1.4 MB), `_Satellite.parquet` (80 KB) | Parquet, about 600 columns, each value with min/max errors and the **bibcode of its source** | ~1.2M SSOs (per SsODNet docs) | Per-attribute best estimates with provenance. Read only the needed columns with pyarrow/fsspec range reads; do not download the whole file. |
| **Phase function** | SsODNet `phase_functions.*` (H, G1, G2 per filter, from ATLAS/ZTF/Gaia fits); ATLAS: Mahlke et al. 2021 | in ssoBFT | ~10⁵ | M (G1, G2). The **default G = 0.15** used by MPC/JPL for everything else is **E**. |
| **Rotation period** | LCDB (Warner et al. 2009): `https://minplanobs.org/MPInfo/datazips/LCLIST_PUB_CURRENT.zip` (40 MB). **Last public release 2023-10-01.** PDS copy `…/ast-lightcurve-database_V4_0/` (2021). | fixed-width text | ~35k in SBDB `rot_per` | M if LCDB U ≥ 2; U = 1 is dubious (E); none is U |
| **Spin axis and shape (convex)** | **DAMIT** `https://damit.cuni.cz/projects/damit/exports`: complete export `damit-20260930T000302Z.tar.gz` (**1.32 GB**, monthly; the stable URL `…/exports/complete/latest` also works) or CSV tables (`…/exports/table/asteroid_models`). **CC BY 4.0.** | tar of models and lightcurves, CSV | **16,098 models of 10,758 asteroids**, 8 tumblers. The Gaia DR3 inversions (Ďurech & Hanuš 2023) greatly enlarged it. | Shape and pole M (model fit to data). Convex hull only, so fine concavities are U. |
| Radar shape models | `…/gbo.ast.jpl.radar.shape_models_V1_0/` (OBJ + spin); `compil.ast.radar.shape-models/` | OBJ | tens | M |
| **Colour: spectra** | **Gaia DR3 SSO reflectance spectra**, `https://cdn.gea.esac.esa.int/Gaia/gdr3/Solar_system/sso_reflectance_spectrum/SsoReflectanceSpectrum_{00..19}.csv.gz` (20 files × ~0.67 MB = **14 MB**) | 16 bands **374–1034 nm** (44 nm steps), reflectance normalised to 1 at 550 nm, per-band error and flag (0 = ok 91%, 1–2 = suspect, mostly edge bands) | **60,518 asteroids** | Relative spectrum M. Absolute level from pV (D/E). **Licence CC BY-NC 3.0 IGO.** |
| Colour: SDSS | SDSS MOC4 `…/gbo.sdss-moc.phot/data/sdssmocadr4.tab` (230 MB); SDSS taxonomy `…/ast.sdss-based-taxonomy/` (7 MB); newer multi-epoch SDSS set: Sergeyev & Carry 2021, A&A 652, A59 | ugriz | ~10⁵ | M (colours); taxonomy E |
| Colour: spectra (ground) | SMASS II `…/gbo.ast.smass2.spectra/`; MITHNEOS `…/gbo.ast.mithneos.spectra_2000-2021_V1_0/`; Bus–DeMeo `…/ast.bus-demeo.taxonomy/` (371 objects, mean class spectra 12 KB) | PDS tables | ~10³ | M |
| Taxonomy compilations | `…/ast_taxonomy_v1.1/taxonomy10.tab` (324 KB; updated 2026-02); Mahlke et al. 2022 taxonomy (in SsODNet) | | ~10⁴–10⁵ | class M; **spectrum-from-class is E** |
| TNO/Centaur colours | `…/compil.tno-centaur.colors/` | | ~10³ | M |
| Families | Nesvorný HCM families V2.0, `https://sbnarchive.psi.edu/pds4/non_mission/ast.nesvorny.families_V2_0/data/` (`proper_catalog24.tab` 130 MB, `families_2024/`, `familylist.tab`), DOI 10.26033/5hyq-6k90 | | 1,249,051 proper-element records | M (membership) |
| Masses/densities | SsODNet `mass`, `density` (Carry 2012 compilation style) | | a few hundred | M |

**All SBN URLs** above share the prefix `https://sbnarchive.psi.edu/pds4/non_mission/`. PDS data are public.

### Spacecraft shape models (the "up close" set)

| Body | File (verified) | Size |
|---|---|---|
| Eros | `https://naif.jpl.nasa.gov/pub/naif/generic_kernels/dsk/asteroids/eros/near-a-msi-5-erosshape-v1_0_{64q,512q}.bds`; SPC also at SBN `…/gaskell.ast-eros.shape-model_V1_1/` | 3.7 / 106 MB |
| Itokawa | `…/dsk/asteroids/itokawa/hay_a_amica_5_itokawashape_v1_0_{64q,512q}.bds` | 4.5 / 149 MB |
| Vesta | `…/dsk/asteroids/vesta/vesta_gaskell_256.bds`; Dawn HAMO DTM at USGS `Vesta_Dawn_HAMO_DTM_DLR_Global_48ppd.tif` | 39 MB / 597 MB |
| Ceres | NAIF `DAWN/kernels/dsk/dawn_ceres_dlr_m135_*.bds` (tiles of 390–633 MB); USGS `Ceres_Dawn_FC_HAMO_DTM_DLR_Global_60ppd_Oct2016.tif` | 467 MB |
| Bennu | NAIF `ORX/kernels/dsk/bennu_g_{12600,06370,03250,01680,00880,00400}mm_*_v021.bds` | 0.7 MB – 560 MB |
| Apophis (radar) | `ORX/kernels/dsk/apophis_g_25000mm_rad_obj_0000n00000_v001.bds`; SBN `gbo.ast-apophis.jpl.radar.shape_model_v1.0/` | 311 KB |
| Ryugu | Hayabusa2 SPICE bundle, DOI 10.17597/isas.darts/hyb2-00600 (DARTS; `https://data.darts.isas.jaxa.jp/pub/hayabusa2/`) | (DSK in bundle) |
| 67P | ESA SPICE `https://spiftp.esac.esa.int/data/SPICE/ROSETTA/kernels/dsk/ROS_CG_M004_OSPGDLR_N_V1.BDS` (and others) | 132 MB |
| Lutetia, Šteins | same dir: `ROS_LU_M003_OSPCLAM_N_V1.BDS`, `ROS_ST_K020_OSPCLAM_N_V1.BDS` | 107 MB / 1.7 MB |
| Didymos, Dimorphos | ESA `…/SPICE/HERA/kernels/dsk/g_01165mm_spc_obj_didy_…_v003.bds`, `g_00243mm_spc_obj_dimo_…_v004.bds` (DART-era) | 107 MB each |
| Phobos, Deimos | ESA `…/ROSETTA/kernels/dsk/PHOBOS_K275_DLR_V02.BDS` (10 MB), `DEIMOS_K005_THO_V01.BDS` | |
| Arrokoth | NAIF `pds/data/nh-j_p_ss-spice-6-v1.0/nhsp_1000/data/dsk/mu69_porter_2024_v01.bds` | 2.2 MB |
| Donaldjohanson (Lucy) | NAIF `LUCY/kernels/dsk/lcy_donj_k548_iso20m_v10.bds` | 22 MB |
| Ida, Mathilde, Gaspra, others | SBN `ast-sat.thomas.shape-models_V1_0/` | small |

DSK files are read with spiceypy 8.2 (MIT). Convert them to meshes in the pipeline. Shape labels are M, and meshes decimated for rendering are D.

---

## 3. Per-attribute provenance mapping

| Attribute | measured | derived | estimated | unknown |
|---|---|---|---|---|
| Orbit elements, epoch | SBDB/MPC solution | — | — | — |
| Position at t | — | numerical propagation (§4); uncertainty from sigma/U | objects with `data_arc` < few days or `condition_code` ≥ 8: show the uncertainty ellipsoid | lost objects (epoch ≪ 2000 and U = 9): no position |
| H | fitted H (JPL/MPC; better: SsODNet phase-curve H) | — | — | H = 99 → U |
| Phase function | G1/G2 or G fitted (SsODNet, ATLAS) | — | default G = 0.15 (MPC) | — |
| Diameter | NEOWISE `D`-fit, occultation, radar, spacecraft, AKARI/IRAS | — | D = 1329 km · 10^(−H/5)/√pV with **pV from the taxonomic class** (DeMeo/Bus class means) or **from the population** (region-dependent albedo, NEOWISE statistics) | — |
| Geometric albedo pV | NEOWISE (conditional on its input H) | pV recomputed from D and a better H (D) | class/region mean | — |
| Relative reflectance spectrum | Gaia DR3 (60.5k), SMASS/MITHNEOS/DeMeo spectra | CIE XYZ from spectrum × solar spectrum | spectrum from taxonomic class mean (DeMeo `meanspectra.tab`), from SDSS colours, or from the population colour of its family | none of the above |
| Absolute colour (XYZ at α = 0) | — | relative spectrum (M) × pV (M) | any E input | — |
| Rotation period | LCDB U ≥ 2, DAMIT | — | LCDB U = 1 | none |
| Pole, shape | DAMIT, radar, spacecraft | — | — | the vast majority: **U**. Render a point or disk with its measured brightness, never an invented potato. |
| Comet total magnitude | — | — | M1/K1 law (E: comets routinely deviate by 1–2 mag) | — |
| Comet nucleus | spacecraft (67P, 9P, 103P, 81P, 19P, 1P) | — | M2/K2 | most: U |

**Two known pitfalls.**

1. **Catalogue H values (MPC and JPL) carry H-dependent systematic offsets of tenths of a magnitude** (Pravec et al. 2012, Icarus 221, 365, doi:10.1016/j.icarus.2012.07.026). NEOWISE pV inherits them. Prefer SsODNet or ATLAS phase-curve H where it exists, and propagate the H uncertainty into D and pV.
2. The diameter formula D(H, pV) needs a citation: Pravec & Harris 2007, Icarus 190, 250, doi:10.1016/j.icarus.2007.02.023.

---

## 4. Propagation for ±18 months, and a GPU approach (measured, not guessed)

### Experiment

- **Initial conditions:** SBDB `full-prec` elements at JD 2461200.5 for 12 objects: Ceres, Vesta, Eros, Hilda, Hektor, Chiron, Eris, Phaethon, Apophis, Chariklo, Icarus and Toutatis.
- **Reference:** JPL Horizons heliocentric ICRF vectors at 13 epochs from 2025-03-30 to 2028-03-30. Horizons integrates with planets, 16 massive asteroids, GR and non-gravitational terms.
- **Our perturbers:** a DE442s excerpt (2025–2028, 207 KB, fetched with `jplephem excerpt`).
- **Integrator:** scipy DOP853 (rtol 1e-12), in barycentric coordinates.
- **Metric:** maximum position error over the window, in km.

| Object | Pure two-body (Kepler) | Sun + Jupiter | Sun + 8 planets + Pluto | + solar 1PN GR |
|---|---|---|---|---|
| 1 Ceres | 715,441 | 70,166 | 24.0 | 6.0 |
| 4 Vesta | 276,301 | 40,655 | 30.4 | 0.5 |
| 433 Eros | 134,388 | 82,562 | 93.4 | 1.1 |
| 153 Hilda | 349,081 | 39,531 | 2.6 | 1.9 |
| 624 Hektor | 273,986 | 18,175 | 3.0 | 1.3 |
| 2060 Chiron | 283,838 | 30,644 | 0.3 | 0.3 |
| 136199 Eris | 292,100 | 543 | 0.2 | 0.2 |
| 3200 Phaethon (q = 0.14 au) | 481,105 | 53,644 | 235.7 | 1.8 |
| 99942 Apophis | 89,717 | 79,808 | 66.9 | 4.9 |
| 10199 Chariklo | 262,989 | 15,630 | 0.3 | 0.3 |
| 1566 Icarus (q = 0.19 au) | 105,190 | 56,914 | 243.9 | 0.9 |
| 4179 Toutatis | 196,977 | 26,182 | 11.8 | 6.5 |

What the table shows:

- **Two-body propagation is unacceptable.** 10⁵–7×10⁵ km is up to ~0.1° as seen from Earth, and grossly wrong up close.
- **All planets plus solar GR reach ≤ 6.5 km everywhere.** The remainder is the 16 big asteroids (Ceres is perturbed by Vesta and Pallas), the Earth/Moon split, and Yarkovsky (Apophis).
- **GR matters for low-q NEOs** (Phaethon 236 → 1.8 km).

**Integrator error at fixed step** (same forces, compared with the DOP853 solution after 640 d, km):

| Object | RK4 Cartesian, dt = 0.5 d | 1 d | 2 d | 4 d | Kepler-drift/kick (Wisdom–Holman-type), dt = 1 d | 2 d | 4 d | 8 d |
|---|---|---|---|---|---|---|---|---|
| Ceres | 0.001 | 0.005 | 0.09 | 1.5 | 1.9* | 5.4 | 19 | 74 |
| Eros | 0.03 | 0.6 | 9.2 | 153 | 0.8* | 1.3 | 3.0 | 10 |
| Phaethon | **3×10⁵** | 9×10⁶ | — | — | 2.7 | 19 | 3,480 | — |
| Icarus | **1.3×10⁴** | 3.5×10⁵ | — | — | 0.08 | 0.9 | 46 | 800 |
| Apophis | 1.1 | 18 | 335 | 6,720 | 0.9* | 3.7 | 15 | 58 |
| Eris | <0.001 | <0.001 | <0.001 | <0.001 | 0.9* | 1.8 | 5.5 | 20 |

\* The ~1 km floor of the heliocentric scheme is mostly a model difference, not integration error: its indirect term uses Σ GM_p r_p / r_p³, while the reference uses the ephemeris Sun, which also feels asteroids.

What this shows:

- **Cartesian RK4 fails at perihelion for low-q orbits.**
- **The Kepler-drift scheme is robust.** For q < 0.3 au (475 objects) it needs dt ≤ 1 d: Phaethon is 2.7 km at 1 d and 19 km at 2 d. Elsewhere, 2–4 d gives ~2–20 km.

### Recommended M3 propagation design

1. **Pipeline (CPU, float64).**
   - Take SBDB full-precision elements and convert them to heliocentric ICRF states at the standard epoch. The ecliptic→ICRF rotation uses ε = 84381.448″, and SPICE treats J2000 as equal to ICRF.
   - For the 96,196 objects whose epoch ≠ JD 2461200.5, pre-integrate them to the standard epoch on the CPU. Use **ASSIST** (Holman et al. 2023, PSJ 4, 69, doi:10.3847/PSJ/acc9a9; GPL; a REBOUND extension that uses DE440/441 plus `sb441-n16.bsp`, the 16 perturbing asteroids, 616 MB at `https://ssd.jpl.nasa.gov/ftp/eph/small_bodies/asteroids_de441/`) or the same DOP853 force model.
   - Output one float64 state per object: about 1.57M × 48 B = **75 MB**, plus a label byte and an index.
2. **GPU (WGSL has no f64, so use double-single / df64 arithmetic).**
   - Upload the DE442s Chebyshev records for the window (≈200 KB).
   - Integrate every object with a **Kepler drift (universal variables, heliocentric) plus kick** (planets direct + indirect, plus the solar 1PN term). Use dt = 2 d by default and 0.5–1 d for q < 0.3 au.
   - Run this once at load to build keyframes. Every 16 d over ±18 months is about 70 per object, which is 5.3 GB at 48 B/state. Either lengthen the cadence (64 d → 1.3 GB, then up to 16 two-day steps from the nearest keyframe) or store float32 offsets from the osculating Kepler orbit (24 B/state). Scrubbing then takes a few drift/kick steps from the nearest keyframe.
   - Planet positions are shared across objects at each step, so the per-object cost is one Kepler solve plus 9 distance terms in df64 (~10⁴ fp32-equivalent operations). The whole 1.57M × 550-step integration should take well under a minute on an RTX 5090. This is an estimate, not a measurement.
3. **Special cases.**
   - Objects with **close planetary approaches inside the window**: query the CNEOS close-approach API (`https://ssd-api.jpl.nasa.gov/cad.api`). Use Horizons-generated SPK for these (type 21, about 40 KB per object-year, e.g. Eros 3 yr = 125 KB) and evaluate them on the CPU. Convert them to type 2 in the pipeline so the app keeps one evaluator.
   - Comets with non-gravitational terms: A1/A2/A3 in SBDB (Marsden et al. 1973, AJ 78, 211, doi:10.1086/111402). Add the kick, or use Horizons SPK for active comets.
4. **Validation.** Keep the 12-object Horizons comparison above as a pipeline test with fixtures. **Assert ≤ 10 km** (≤ 30 km for q < 0.3 au).
5. **Error budget.** Integration error (≤ ~10 km) is below orbit-determination uncertainty for most objects. U ≥ 3 means ≥ 19.6″ per decade of runoff, i.e. ≥ ~3″ over 18 months, which is ≈ 5,000 km along-track at a = 2.5 au. Carry the orbit uncertainty per object and display it.

---

## 5. Rubin/LSST status, 2026-09-30

- **The LSST 10-year survey began on 2026-06-29.** World-public alerts started flowing on 2026-02-24 (about 800k alerts on the first night), at reduced scale until templates exist. Sources: `https://rubinobservatory.org/for-scientists/resources/early-science` (page dated 27 Jul 2026) and `https://rubinobservatory.org/news/first-alerts`.
- **Solar-system discoveries are reported to the MPC on an ad-hoc basis.** They therefore already appear in MPCORB and SBDB. There is **no separate Rubin orbit catalogue to ingest.**
- **Data releases:** Data Preview 1 (ComCam, 2024 data) is public. The early DP2 was released 2026-07-27, with the complete DP2 targeted for Oct–Dec 2026. **DR1 is expected by the end of June 2028**, outside the v1 window. LSDB serves DP1 and DP2 as HATS Parquet at `https://data.lsdb.io/hats/dp1/` and `…/dp2/`. The Rubin alert archive is at `https://data.lsdb.io/hats/rubin_alert_archive/` (frozen July 14).
- **Expected growth:** Kurlander et al. 2025 (AJ 170, 99, doi:10.3847/1538-3881/add685) predict LSST will raise the known populations to 1.27×10⁵ NEOs, **5.09×10⁶ main-belt asteroids**, 1.09×10⁵ Jupiter Trojans and 3.70×10⁴ TNOs (4–9× today). **About 70% of the main belt will be found in the first two years.** Their simulated catalogue is public.
- **Consequences for M3:**
  - The catalogue will roughly triple within a few years. Design the binary layout and the GPU path for **≥ 5M objects**.
  - Rebuild from MPCORB/SBDB frequently (daily is possible).
  - Newly discovered objects will have short arcs, and many will carry griz colours only once Rubin DRs ship.

---

## Citations (DOIs verified via Crossref/DataCite, 2026-09-30)

**Surveys and catalogues**
- Warner, Harris & Pravec 2009 (LCDB), Icarus 202, 134, doi:10.1016/j.icarus.2009.02.003
- Ďurech et al. 2010 (DAMIT), A&A 513, A46, doi:10.1051/0004-6361/200912693
- Ďurech & Hanuš 2023 (Gaia DR3 spins), A&A 675, A24, doi:10.1051/0004-6361/202345889
- Mainzer et al. 2011, ApJ 743, 156, doi:10.1088/0004-637X/743/2/156
- Masiero et al. 2011, ApJ 741, 68, doi:10.1088/0004-637X/741/2/68
- NEOWISE Diameters and Albedos V2.0 (PDS), doi:10.26033/18S3-2Z54
- Gaia Collaboration, Galluccio et al. 2023 (reflectance spectra), A&A 674, A35, doi:10.1051/0004-6361/202243791
- Tanga et al. 2023 (Gaia DR3 SSO), A&A 674, A12, doi:10.1051/0004-6361/202243796
- Ivezić et al. 2001 (SDSS MOC), AJ 122, 2749, doi:10.1086/323452
- Sergeyev & Carry 2021, A&A 652, A59, doi:10.1051/0004-6361/202140430

**Taxonomy and spectra**
- Bus & Binzel 2002, Icarus 158, 146, doi:10.1006/icar.2002.6856
- DeMeo et al. 2009, Icarus 202, 160, doi:10.1016/j.icarus.2009.02.005
- Binzel et al. 2019 (MITHNEOS), Icarus 324, 41, doi:10.1016/j.icarus.2018.12.035
- Mahlke et al. 2022 (taxonomy), A&A 665, A26, doi:10.1051/0004-6361/202243587

**Phase functions**
- Mahlke et al. 2021 (ATLAS phase curves), Icarus 354, 114094, doi:10.1016/j.icarus.2020.114094
- Muinonen et al. 2010 (H,G1,G2), Icarus 209, 542, doi:10.1016/j.icarus.2010.04.003

**Families, curated tables, densities**
- Nesvorný et al. 2015 (families, Asteroids IV), doi:10.2458/azu_uapress_9780816532131-ch016
- Nesvorný HCM families V2.0 (PDS), doi:10.26033/5hyq-6k90
- Berthier et al. 2023 (SsODNet), A&A 671, A151, doi:10.1051/0004-6361/202244878
- Carry 2012 (densities), PSS 73, 98, doi:10.1016/j.pss.2012.03.009

**Dynamics**
- Rein & Liu 2012 (REBOUND), A&A 537, A128, doi:10.1051/0004-6361/201118085
- Rein & Spiegel 2015 (IAS15), MNRAS 446, 1424, doi:10.1093/mnras/stu2164
- Holman et al. 2023 (ASSIST), PSJ 4, 69, doi:10.3847/PSJ/acc9a9
- Park et al. 2021 (DE440/441), AJ 161, 105, doi:10.3847/1538-3881/abd414

**LSST**
- Ivezić et al. 2019, ApJ 873, 111, doi:10.3847/1538-4357/ab042c
- Kurlander et al. 2025, AJ 170, 99, doi:10.3847/1538-3881/add685

**Software**
- jplephem 2.24 (MIT)
- spiceypy 8.2.0 (MIT)
- assist 1.2.3 and rebound 5.2.1 (GPL-3)
- sbpy 0.6.0 (BSD)
- pyarrow 25 (Apache-2.0)

## Top recommendations

1. **Orbits:** JPL SBDB via the Query API with `full-prec=1` (paged, serial, with a proper User-Agent) as the primary source, and MPCORB for U and cross-checks. Never use the API's default rounded output.
2. **Physical data:** ingest SsODNet ssoBFT (column-selective Parquet reads) as the curated best-estimate layer with per-value bibcodes. Add the raw NEOWISE V2.0, Gaia DR3 SSO spectra (14 MB, 60,518 objects, CC BY-NC), DAMIT (CC BY 4.0, 16,098 models), LCDB (2023-10) and the Nesvorný 2024 families, so the provenance chain is explicit.
3. **Labels:** diameters are measured only from thermal, occultation, radar or spacecraft; H-plus-class-albedo is estimated. Colour is measured only with a spectrum or colours. Shape is unknown for everything outside DAMIT, radar and spacecraft models, and should be rendered as a point, not a potato.
4. **Propagation:** a heliocentric Kepler-drift + kick integrator (8 planets + Pluto from DE442s, plus solar GR) in df64 on the GPU, dt 2 d (0.5–1 d for q < 0.3 au), generating keyframes at load. The force model was measured at ≤ 6.5 km vs Horizons, and the integration scheme adds ~1–5 km at dt = 2 d (19 km for Phaethon). Pure two-body is off by up to 7×10⁵ km. Close approachers and active comets use Horizons SPK.
5. **Plan for 5M+ objects** because of LSST; there is no separate Rubin catalogue to ingest until DR1 (≈ mid-2028).

## Open issues

- LCDB public release is from 2023; check whether SsODNet's `spins` table supersedes it.
- The Gaia DR3 SSO licence is CC BY-NC. Fine for personal use; recheck if the project ever becomes public/commercial.
- The DAMIT export is 1.32 GB; the model shapes alone are likely much smaller. Check whether per-model downloads suffice.
