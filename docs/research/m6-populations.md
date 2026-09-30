# M6 research: debiased population models for the synthetic layer

Status: research notes for M6 ("small bodies below survey completeness, drawn from debiased population models, yielding to discoveries"; NORTH_STAR 3.3). Written 2026-09-30.

**How this was verified.** URLs were checked with HEAD or GET requests on 2026-09-30. Model numbers are quoted from the papers' abstracts or tables, retrieved from arXiv or the publisher. DOIs were checked against Crossref or DataCite. Label shorthand: **M** measured, **D** derived, **E** estimated, **S** synthetic, **U** unknown.

---

## 1. Population models and what can actually be downloaded

### Near-Earth objects (best-developed field)

| Model | What it gives | Access | Key numbers |
|---|---|---|---|
| **Granvik et al. 2018**, Icarus 312, 181, doi:10.1016/j.icarus.2018.04.018 | Debiased 4D (a, e, i, H) distribution for 17 < H < 25 by source region, calibrated on Catalina 703/G96 (2005–2012) | `https://www.mv.helsinki.fi/home/mgranvik/data/Granvik+_2018_Icarus/`: `Granvik+_2018_Icarus.dat.gz` (28 MB) is **one realisation of 802,000 synthetic NEOs** with columns a, e, i, Ω, ω, M, H. Also `…_model_lowres_v20181213_albedo_cp.out.gz` (32 MB) and a readme (v1.1, 2025-05-13). | 962 (+52/−56) NEOs with H < 17.75; 802 (+48/−42) × 10³ with H < 25 |
| **NEOMOD / NEOMOD 2 / NEOMOD 3** (Nesvorný et al. 2023, AJ 166, 55, doi:10.3847/1538-3881/ace040; 2024, Icarus 411, 115922, doi:10.1016/j.icarus.2023.115922; 2024, Icarus 417, 116110, doi:10.1016/j.icarus.2024.116110) | Orbit, H and albedo/size distribution calibrated on CSS G96 2013–2022 plus NEOWISE albedos. Includes a **detection-efficiency model** for G96. | The "NEOMOD Simulator" code generates user-defined samples. It is on the author's page `https://www2.boulder.swri.edu/~davidn/NEOMOD_Simulator/`, which **could not be verified from here** (TLS chain error via curl, 503 via fetch). Try from a normal machine. | NEOMOD2: 936 ± 29 with H < 17.75; (1.20 ± 0.04) × 10⁷ with H < 28; cumulative slope 2.6 for H = 25–28. NEOMOD3: 830 ± 60 with D > 1 km; 20,000 ± 2,000 with D > 140 m; albedo distribution = two Rayleigh components with scale p_V = 0.03 and 0.17. |
| **Deienno et al. 2025**, Icarus 425, 116316, doi:10.1016/j.icarus.2024.116316 | NEOMOD-style debiasing of ATLAS data | paper | Completeness ≈ **88% (+3/−2) for H < 17.75** and **≈ 36% (±1) for H < 22.25** |
| Supporting | Harris & D'Abramo 2015 (Icarus 257, 302, doi:10.1016/j.icarus.2015.05.004); Morbidelli et al. 2020 debiased albedos (Icarus 340, 113631, doi:10.1016/j.icarus.2020.113631); Bottke et al. 2000 (Science 288, 2190, doi:10.1126/science.288.5474.2190) | | |

### Main belt (and Hungarias)

- **Completeness in H versus semimajor axis: Hendler & Malhotra 2020** (PSJ 1, 75, doi:10.3847/PSJ/abbe25; code `http://github.com/equant/Asteroids/`).
  - Model: **H_lim(a) = −5 log₁₀(a·(a − 1 au)) + C**, with a in au.
  - Main-belt fit (MPCORB, Sept 2019): **C = 20.28 ± 0.03**, giving H_lim = 18.4 at 2.12 au and 15.9 at 3.25 au.
  - Median H_lim by region (their Table 1): Hungarias 18.38, inner belt 17.76, middle belt 17.01, outer belt 16.28, Hildas 15.69, Jupiter Trojans 13.88.
  - The method takes the peak of the observed H histogram per a-bin, so completeness is already falling just brighter than H_lim (Bannister et al. 2016, AJ 152, 70, doi:10.3847/0004-6256/152/3/70, find a ~20% efficiency drop over 2 mag). Treat H_lim as the point where completeness starts to fall. **Recompute it from today's MPCORB at every build.** The recipe is simple, and the value rises every year, fast now that LSST is running.
- **Size-frequency distribution:**
  - Bottke et al. 2005 (Icarus 175, 111, doi:10.1016/j.icarus.2004.10.026): the collisional-evolution SFD shape.
  - Faint end: Gladman et al. 2009 (Icarus 202, 104, doi:10.1016/j.icarus.2009.02.012); Heinze et al. 2019 (flux distribution and sky density of 25th-magnitude main-belt asteroids, AJ 158, 232, doi:10.3847/1538-3881/ab48fa); Maeda et al. 2021 (HSC, colour-separated SFDs, AJ 162, 280, doi:10.3847/1538-3881/ac2c6e).
  - Albedo per region: NEOWISE (Masiero et al. 2011, doi:10.1088/0004-637X/741/2/68).
- **Orbit distribution:** use the **observed complete sample itself** (H < H_lim(a), about 466k objects in 2019 and more now) as the empirical orbit distribution. Resample it in proper elements (Nesvorný 2024 `proper_catalog24.tab`, M3 doc). The family/background fraction is part of that sample. Its extrapolation to faint H is E.

### Jupiter Trojans, Hildas, and Neptune Trojans

- **Jupiter Trojans:**
  - NEOWISE debiased: Grav et al. 2011, ApJ 742, 40, doi:10.1088/0004-637X/742/1/40.
  - Small-Trojan SFD from Subaru HSC: Yoshida & Terai 2017, AJ 154, 71, doi:10.3847/1538-3881/aa7d03.
  - Colour-magnitude bimodality (red vs less-red): Wong & Brown 2015, AJ 150, 174, doi:10.1088/0004-6256/150/6/174.
  - Completeness: H_lim ≈ 13.9 (Hendler & Malhotra 2020). LSST will take the count to ~1.09 × 10⁵ (Kurlander et al. 2025).
- **Hildas:** NEOWISE, Grav et al. 2012, ApJ 744, 197, doi:10.1088/0004-637x/744/2/197; H_lim ≈ 15.7.
- **Neptune Trojans:** Murtagh et al. (arXiv:2512.03892) predict 130–300 LSST discoveries. The population model is in OSSOS/CFEPS (below).

### Trans-Neptunian objects

- **CFEPS L7 synthetic model** (Petit et al. 2011, AJ 142, 131, doi:10.1088/0004-6256/142/4/131).
  - File: `https://www.cfeps.net/L7Release/L7SyntheticModel-v09.txt.gz` (1.67 MB).
  - Contents: **66,038 synthetic TNOs** with a, e, i, Ω, ω, M, H (3.44–8.5), and a dynamical class (classical, resonant, …).
  - Epoch JD 2453157.5, given together with Neptune's longitude λ_N = 5.489°. Resonant arguments are tied to Neptune, so **rotate the longitudes by Neptune's motion since the epoch.**
  - BSD-style licence in the header.
  - Survey characterisation: `https://www.cfeps.net/L7Release/L7Characterization.tgz`.
- **OSSOS:**
  - Data release: Bannister et al. 2018, ApJS 236, 18, doi:10.3847/1538-4365/aab77a.
  - **Survey simulator**, GitHub `OSSOS/SurveySimulator` (Fortran; Lawler et al. 2018, Front. Astron. Space Sci. 5, 14, doi:10.3389/fspas.2018.00014). The old `cfeps.net/Survey_Simulator_files/SurveySimulator.tgz` link is **404**, so use GitHub.
  - **New repo `OSSOS/OSSOS_Models`** (created 2026-02): "Nominal models of the Outer Solar System populations derived from OSSOS++ sample". Its contents were not readable in this session.
- **Size distributions:**
  - Hot main belt: Petit et al. 2023, ApJL 947, L4, doi:10.3847/2041-8213/acc525. There are 30,000 non-resonant main-belt objects with H_r < 8.3, twice as many hot as cold, and the same H distribution for 5.5 < H_r < 8.3.
  - Cold classical: Kavelaars et al. 2021, ApJL 920, L28, doi:10.3847/2041-8213/ac2c72. An exponential cutoff at large sizes, with asymptotic slope α ≈ 0.4 for H_r ≈ 5–12.
- **Prediction tool for LSST:** Sorcha (GitHub `dirac-institute/sorcha`; PyPI `sorcha` 1.2.1, 2026-08). Kurlander et al. 2025 (AJ 170, 99, doi:10.3847/1538-3881/add685) used it and published a simulated LSST solar-system catalogue.

### Irregular moons

- Review: Jewitt & Haghighipour 2007, ARA&A 45, 261, doi:10.1146/annurev.astro.44.051905.092459.
- Saturn: the SFD and a recent collisional family are in Ashton et al. 2021, PSJ 2, 158, doi:10.3847/PSJ/ac0979.
- Jupiter: Sheppard & Jewitt 2003, Nature 423, 261, doi:10.1038/nature01584; new families in Sheppard et al. 2023, RNAAS 7, 100, doi:10.3847/2515-5172/acd766.
- Completeness limits differ strongly by planet: a few km at Jupiter and Saturn, far larger at Uranus and Neptune. **Take them from the discovery papers.** Orbits are strongly clustered in families, so sample around the known families (E), not uniformly.
- The number of known moons jumped (Saturn now 292 in Horizons; M2 doc), so any model must be conditioned on the current NAIF/Horizons list.

### Interplanetary dust (drives zodiacal light; M4)

| Model | Scope | Citation |
|---|---|---|
| Grün et al. 1985 | Mass-flux distribution at 1 au | Icarus 62, 244, doi:10.1016/0019-1035(85)90121-6 |
| Divine 1993 | Five-population model | JGR 98, 17029, doi:10.1029/93je01203 |
| ESA IMEM2 | Inner Solar System | Soja et al. 2019, A&A 628, A109, doi:10.1051/0004-6361/201834892 |
| NASA MEM 3 | Engineering model | Moorhead et al. 2020, J. Spacecr. Rockets 57, 160, doi:10.2514/1.A34561 |
| Dynamical cometary-origin zodiacal model | Size-resolved densities | Nesvorný et al. 2010, ApJ 713, 816, doi:10.1088/0004-637x/713/2/816 |
| Dust bands | Asteroid-family sources | Nesvorný et al. 2003, ApJ 591, 486, doi:10.1086/374807 |
| Outer Solar System | Poppe 2016 model; New Horizons SDC fluxes higher than expected out to ~60 au | Poppe 2016, Icarus 264, 369, doi:10.1016/j.icarus.2015.10.001; Doner et al. 2024, ApJL 961, L38, doi:10.3847/2041-8213/ad18b0 |

For rendering, dust matters only as diffuse light: zodiacal light, dust bands, gegenschein, and forward scatter near the Sun. Integrate densities along the line of sight (M4 §4) rather than sampling particles.

---

## 2. Conditioning synthetic sampling on survey completeness

**Unit of bookkeeping:** a cell c in (population, a, e, i, H), e.g. Δa = 0.01–0.05 au and ΔH = 0.25. For NEOs use NEOMOD's own binning. For TNOs use the class plus the (a, e, i, H) grid of the model.

For each cell:

1. **Model expectation:** N_model(c), the debiased model's count.
2. **Observed:** N_obs(c), from the current catalogue (M3), with H uncertainty handled by soft assignment across H bins.
3. **Completeness:** C(c) = P(detected | object in c). Where it comes from:
   - NEOs: NEOMOD G96 detection efficiency, with ATLAS from Deienno 2025.
   - Main belt, Hungarias, Hildas, Trojans: a completeness ramp built from Hendler–Malhotra H_lim(a), recomputed from current MPCORB, e.g. C = 1 for H < H_lim − 1 and a logistic fall-off above.
   - TNOs: the OSSOS/CFEPS survey simulator applied to the model. Known TNOs come from many surveys, so C for the *full* MPC catalogue is itself E. Use conservatively high C to avoid overfilling.
   - LSST era: Sorcha with the actual LSST visit history once it is public (DR1 ~2028). Until then, use the MPC catalogue H_lim(a) recomputed daily, which picks up Rubin discoveries.
4. **Number of undiscovered objects:** draw U(c) ~ Poisson(N_model(c) · (1 − C(c))), or use its expectation for a smooth look.
   - Consistency check: if N_obs(c) > N_model(c) · C(c) by more than 3σ, the model is under-predicting that cell. Set U = 0 there and log it; never delete real objects.
   - **Rule: never place a synthetic object where C(c) ≈ 1**, i.e. H < H_lim(a) − margin. That is the "surveys would have caught it" rule of NORTH_STAR 3.3.
5. **Object-level veto** (stronger, optional for v2): propagate each candidate backwards over the survey pointing histories and reject it if it would have been detected. Candidate pointing sources:
   - MPC sky coverage (NEO surveys submit field centres and limiting magnitudes; format at `https://www.minorplanetcenter.net/iau/info/Coverage.html`; interactive tool at `/mpcops/pointings/sky_coverage/`; bulk raw-file access **not verified**).
   - OSSOS characterisation files.
   - LSST visits.
   Sorcha does exactly this forward modelling for LSST.
6. **Attributes of a synthetic object:**
   - Orbit and H drawn within the cell. Angles (M, and Ω, ω where the model randomises them) come from the seeded stream.
   - Albedo from the regional or class distribution (NEOMOD3 two-Rayleigh for NEOs; NEOWISE regional distributions for the main belt; Wong & Brown colour classes for Trojans), so D = 1329 km · 10^(−H/5)/√p_V.
   - Colour from the class mix.
   - Rotation period from the LCDB distribution for its size.
   - Every attribute is labelled S, with `sources` = [model id, completeness id, catalogue version] and `method` = cell id + stream index.

### Scale, and when to sample

| Population | Scale |
|---|---|
| NEOs, H < 28 | ~1.2 × 10⁷ (NEOMOD2) |
| Main belt, D > 1 km | ~10⁶ |
| Main belt, 100 m | 10⁸–10⁹ (rough, from SFD extrapolation) |

- **Global catalogue:** sample down to a size where the whole population fits comfortably on the GPU, e.g. D ≳ 1 km for the main belt and H < 25 for NEOs.
- **Local:** sample smaller bodies **on demand in cells around the camera** with the same seeds, so the local universe is identical whenever you return. This is still "sampled from a measured population model", deterministic and data-bounded, and it keeps memory bounded.

---

## 3. Determinism and retiring synthetic objects when discoveries arrive

1. **Candidate stream per cell, independent of the catalogue.** seed(c) = hash(model id + version, cell id). This generates an ordered list of candidates (c, k), k = 0, 1, 2, …. The candidates depend only on the model, never on the catalogue, so a new catalogue release cannot reshuffle the synthetic universe.
2. **How many to show:** the first U(c) candidates that pass the veto. With the expectation rule, U(c) = round(N_model(c)(1 − C(c))). With the Poisson rule, draw U from the same seeded stream.
3. **When a new real object is discovered in cell c:**
   - N_obs rises and C(c) is recomputed.
   - U(c) typically drops by about one. Retire the **candidate nearest to the discovery** in (a, e, i, H, λ) (Mahalanobis distance, deterministic tie-break on k) instead of the last one in the list. This minimises visual change and lets the real object replace its stand-in rather than stacking on top of it.
   - Record `replaced_by: <designation>` in the build diff.
4. **Reproducibility:** manifest.json records model versions, the completeness recipe with its parameters (e.g. the fitted C of H_lim(a) per build), catalogue sha256s and seeds. Same inputs → same universe (NORTH_STAR 3.3).
5. **Guard-rails:**
   - Never let a synthetic object be brighter than the completeness-safe H for its cell.
   - Never give synthetic objects shapes. Render them as points, or as spheres labelled S in Enhanced mode.
   - Keep synthetic objects out of Strict and Best-estimate modes (architecture §5.2).

---

## Top recommendations

1. **Start with NEOs.** Granvik 2018's downloadable 802k-object realisation plus NEOMOD2/3 numbers and albedos give measured-model populations. Condition them with the NEOMOD G96 efficiency and Deienno 2025's ATLAS completeness (88% at H < 17.75, 36% at H < 22.25). Get the NEOMOD Simulator from a machine where the SwRI site is reachable.
2. **Main belt, Hildas, Trojans:** use the observed complete sample (H < H_lim(a)) as the orbit model. The completeness boundary H_lim(a) = −5 log₁₀(a(a−1)) + C is refit every build. The faint-end SFD comes from Bottke 2005 with Heinze 2019 and Maeda 2021, and albedos from NEOWISE.
3. **TNOs:** CFEPS L7 (66,038 objects, 1.7 MB, BSD-style) rotated to current Neptune longitude, plus the OSSOS survey simulator. Check `OSSOS/OSSOS_Models` (2026) first; it may supersede L7. Size distributions from Petit 2023 and Kavelaars 2021.
4. **Retirement:** fixed, catalogue-independent candidate streams per cell. Show the first U(c) = N_model(1−C) candidates. When a discovery lands, drop the nearest candidate, and log every replacement.
5. **Scale:** a global synthetic catalogue to ~1 km (MBAs) or H < 25 (NEOs), plus deterministic on-demand local sampling for smaller sizes near the camera. Dust is rendered as line-of-sight light (M4), never as particles.

## Open issues

- NEOMOD Simulator availability and licence (unverified from here).
- `OSSOS_Models` contents (repo not readable in this session).
- Bulk access to MPC sky-coverage pointing files.
- LSST's per-visit history will not be public before DR1 (~June 2028), so an object-level veto for the LSST era must wait. Until then, use the catalogue-derived H_lim(a).
