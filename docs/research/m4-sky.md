# M4 research: the real sky

Status: research notes for M4 ("Gaia DR3 stars with spectra-derived colors, the brightest stars from Hipparcos, the Milky Way's diffuse light, zodiacal light"). Written 2026-09-30.

**How this was verified.** Counts are live ADQL `COUNT(*)` queries against the Gaia Archive TAP on 2026-09-30. Bulk file sizes come from S3-style listings of the Gaia CDN. Other URLs were checked with HEAD or GET requests, and DOIs via Crossref. Label shorthand: **M** measured, **D** derived, **E** estimated, **U** unknown.

> **Timing: Gaia DR4 is scheduled for 2 December 2026** (~12:00 CET; https://www.cosmos.esa.int/web/gaia/data-release-4). That is inside the v1 build window. DR4 covers 5.5 years of data (DR3 covered 34 months) and has a draft data model online. Build the `stars` stage so the release (DR3 → DR4) is a parameter, and expect the DR4 archive schema and bulk layout to differ.

---

## 1. Gaia DR3 beyond the bright catalogue

### How many stars, and how many have spectra (TAP counts, `gaiadr3.gaia_source`)

| Cut | Sources | With XP continuous spectra | With XP sampled spectra |
|---|---|---|---|
| G < 6 | 6,764 | 4,902 | — |
| G < 12 | 3,087,821 | — | — |
| G < 14 | 16,844,156 | 15,744,582 | 15,744,582 |
| G < 15 | — | — | 34,468,345 |
| G < 16 | **77,952,319** | 72,452,149 | — |
| all | 1.81 × 10⁹ | ~2.2 × 10⁸ (G ≲ 17.65) | **34,468,373** (essentially all of G < 15) |

### Bulk files

Base URL: `https://cdn.gea.esac.esa.int/Gaia/gdr3/`. The browser index is JavaScript, so list the files programmatically with the S3 API: `https://gaia.eu-1.cdn77-storage.com/?prefix=Gaia/gdr3/<dir>/&delimiter=/`.

| Directory | Files | Total |
|---|---|---|
| `gaia_source/GaiaSource_*.csv.gz` | 3,386 | **753 GB** (~230 MB each) |
| `Spectroscopy/xp_sampled_mean_spectrum/` | 3,386 | 114 GB. 343 samples, 336–1020 nm in 2 nm steps, W m⁻² nm⁻¹. |
| `Spectroscopy/xp_continuous_mean_spectrum/` | — | **3.7 TB** (the coefficients plus their covariance) |
| `Spectroscopy/xp_summary/` | — | 9.7 GB |
| `Performance_verification/synthetic_photometric_gspc` | — | 43 GB |

- The `gaia_source` files are partitioned by `source_id` (HEALPix), **not by magnitude**. A magnitude cut therefore means downloading all 753 GB. Don't.
- Licence (`_license.txt`, https://www.cosmos.esa.int/web/gaia-users/license): **CC BY-NC 3.0 IGO**. Credit ESA/Gaia/DPAC and follow the citation guide at https://www.cosmos.esa.int/web/gaia-users/credits.

### Efficient ways to get G < 12–16

1. **Recommended: server-side filtering with Gaia Archive TAP async**, `https://gea.esac.esa.int/tap-server/tap/async`.
   - Limits (Gaia Archive FAQ): **anonymous users get 3,000,000 rows per job**, a 120-minute timeout and 3-day retention. Registered users get unlimited rows, a 20 GB job quota and 1 GB of user tables. Synchronous queries are capped at 60 s. `COUNT(*)` on the full table completed within that during this research.
   - Slice by `source_id` range, since `source_id >> 35` is the HEALPix level-12 index. About 30 anonymous jobs cover G < 16 with ≤ 3M rows each.
   - Ask only for the rendering columns: `source_id, ra, dec, parallax, pmra, pmdec, radial_velocity, ref_epoch, phot_{g,bp,rp}_mean_flux(_error), phot_g_mean_mag, ruwe, has_xp_sampled`. At about 60 B/row as binary VOTable or FITS, G < 16 is about 5 GB.
2. **Column-selective Parquet: LSDB HATS**, `https://data.lsdb.io/hats/gaia_dr3/gaia/` (properties: 1,812,731,847 rows, HEALPix order ≤ 6, sorted by `source_id`; `lsdb` 0.11, BSD-3).
   - Excellent for a few columns over the whole sky. It cannot prune by magnitude, because row-group statistics on G are useless, so every chosen column is read for all 1.8B rows (~7 GB per float column).
   - Better than TAP only if you need everything to G ≈ 21, e.g. for the integrated-starlight map in §3.
3. **VizieR `I/355/gaiadr3`** via `tapvizier.cds.unistra.fr` works the same way as option 1 and is useful as a fallback.

### Colour for each star (the eye-model input)

- **G < 15, 34.5M stars: use the XP sampled spectra.**
  - Get them from the bulk files (114 GB, streamed and reduced on the fly to XYZS per star), from DataLink (`retrieval_type=XP_SAMPLED`, 5,000 sources per call), or by calibrating the continuous coefficients with **GaiaXPy 2.1.4** (BSD-3, `calibrate`).
  - Integrate against the CIE 1931 2° functions and V′(λ) the way `light.json` does for the Sun. The results are D.
  - Apply the published XP systematic corrections (Huang et al. 2024, ApJS 271, 13, doi:10.3847/1538-4365/ad18b1; up to several % in the blue).
  - XP covers 336–1020 nm, which fully contains the 360–830 nm CIE grid in architecture §4.2, so no extrapolation is needed. The XP spectra are low resolution (R ~ 30–100), which is fine for broadband XYZ.
  - XP data releases: De Angeli et al. 2023, A&A 674, A2, doi:10.1051/0004-6361/202243680; Montegriffo et al. 2023, A&A 674, A3, doi:10.1051/0004-6361/202243880.
- **15 < G < ~21: G, BP and RP only.** Map (G, BP−RP) to XYZS with a relation fitted on the XP-sampled stars (label E). Where dust matters, add extinction as another fitted term.
- **Positions:** `ref_epoch` = J2016.0. Propagate proper motion and parallax to "now" (D). Use Gaia DR3 as the frame (Gaia Collaboration, Vallenari et al. 2023, A&A 674, A1, doi:10.1051/0004-6361/202243940).
- **Photometry:** synthetic photometry in standard systems is in GSPC (Gaia Collaboration, Montegriffo et al. 2023, A&A 674, A33, doi:10.1051/0004-6361/202243709). It is useful for validation, for example comparing Johnson V from XP against our XYZ-derived V.

---

## 2. The brightest stars Gaia misses

- **Gaia DR3's brightest source is G = 1.73** (source 1576683529448755328, which is ε UMa/Alioth). No star brighter than that is in DR3, so Sirius, Canopus, Arcturus, Vega, Capella, Rigel and others are missing. DR3 has only 150 sources with G < 3 and 634 with G < 4. G < 6 photometry and astrometry are degraded by saturation, and XP exists for 4,902 of the 6,764 G < 6 sources.
- **Astrometry and photometry: Hipparcos new reduction**, VizieR `I/311` (van Leeuwen 2007, A&A 474, 653, doi:10.1051/0004-6361:20078357). ReadMe at `https://cdsarc.cds.unistra.fr/ftp/I/311/`.
- **Photometry and cross-IDs:**
  - Bright Star Catalogue 5th ed., `V/50` (Hoffleit & Warren 1991).
  - Tycho-2, `I/259` (Høg et al. 2000; 2.5M stars; B_T and V_T).
- **Absolute spectrophotometry of bright stars (measured SEDs):**
  - Burnashev 1985, `III/126`: 1,588 objects, 320–817 nm in 2.5 nm steps.
  - Kharitonov et al. 1988, `III/202`: 1,147 stars, 322.5–757.5 nm in 5 nm steps.
  - Glushneva et al., `III/208`: 866 stars.
  - **HST CALSPEC** (`https://archive.stsci.edu/hlsps/reference-atlases/cdbs/current_calspec/`), e.g. `alpha_lyr_stis_012.fits` (2026-03-16), `sirius_stis_005.fits`, `18sco_stis_006.fits`, `109vir_stis_005.fits`. These are the best-calibrated.
- **Rule:**
  - V ≲ 6 or no Gaia XP: CALSPEC if available (M).
  - Otherwise a Burnashev or Kharitonov SED scaled to Hipparcos/Tycho photometry (M/D).
  - Otherwise a spectral-type template from the class in BSC (E).
  - Merge Gaia and Hipparcos by cross-match (Gaia provides `hipparcos2_best_neighbour`), never double-counting.
- **Variables:** the current brightness of Betelgeuse, Mira and similar stars is not the catalogue mean. The AAVSO VSX catalogue is on LSDB (`https://data.lsdb.io/hats/vsx/`), but current magnitudes need AAVSO light curves. Without them, the "now" brightness is E, from the mean plus the amplitude as uncertainty.

---

## 3. The Milky Way's diffuse light, in absolute units

What has to be rendered as a *surface* is everything not drawn as an individual star:

- unresolved stars (fainter than our point-source cut),
- diffuse galactic light (DGL, starlight scattered by dust),
- the extragalactic background (about 1% level),
- inside the Solar System, zodiacal light (§4),
- from Earth's surface only, airglow.

| Candidate | What it is | Access (verified) | Verdict |
|---|---|---|---|
| **Pioneer 10/11 IPP all-sky maps** (Gordon, Witt & Friedmann 1998, ApJ 498, 522, doi:10.1086/305571; data from Weinberg/Toller; Toller 1983, ApJ 266, L79, doi:10.1086/183982) | Total sky brightness **measured from beyond 3.3 AU, i.e. outside the zodiacal cloud**, in B (437 nm, Δλ 83 nm) and R (644 nm, Δλ 97 nm). Includes all stars, DGL and EBL. | `https://www.stsci.edu/~kgordon/pioneer_ipp/P_all_1_B.fits`, `P_all_1_R.fits` (4.15 MB each; 1440×720 float32, 0.25° pixels in galactic lon/lat; the native beam is ~2°; units **S10(G2V)**, conversion in Gordon et al. 1998). Raw NSSDC tape data are linked on the same page (`dirty.as.arizona.edu`, not fetched). Page states "Copyright … All Rights Reserved": fine for personal use; ask for anything else. | **Use this as the absolute anchor.** Reanalysis with better star subtraction: Matsuoka et al. 2011, ApJ 736, 119, doi:10.1088/0004-637X/736/2/119. |
| Mellinger 2009 all-sky colour panorama (PASP 121, 1180, doi:10.1086/648480) | Ground-based CCD mosaic at 36″/px, calibrated in S10(V) against Tycho photometry and **the Pioneer backgrounds**; 18-bit, 7.7 GB FITS | Not publicly downloadable: https://www.milkywaysky.com/ is copyrighted and commercial. | High resolution and beautiful, but **cannot be pipeline-downloaded**. Its calibration traces back to Pioneer anyway. Skip unless licensed. |
| Leinert et al. 1998, "The 1997 reference of diffuse night sky brightness" (A&AS 127, 1, doi:10.1051/aas:1998105) | Tables of zodiacal light vs helio-ecliptic position (Table 17), integrated starlight and DGL (from Pioneer), airglow, and conversion constants | VizieR `J/A+AS/127/1` holds **only the IRAS 60/100 µm maps**. The optical tables exist only in the paper PDF, and `aas.aanda.org` returns **403 to scripted fetches** (ADS timed out). | Needed for zodiacal light. A scripted PDF-table extraction with a pinned checksum is the only automatic route. A manually transcribed table would violate NORTH_STAR 3.8. **Open issue.** |
| New Horizons LORRI dark-sky fields (Lauer et al. 2022, ApJL 927, L8, doi:10.3847/2041-8213/ac573d; Postman et al. 2024, ApJ 972, 95, doi:10.3847/1538-4357/ad5ffc) | Absolute sky brightness at 40–57 AU in a few dozen high-latitude fields | PDS SBN `https://pds-smallbodies.astro.umd.edu/holdings/pds4-nh_derived-v1.0/lorri_cob/` | Validation points for the high-latitude diffuse level. |
| Gaia-integrated starlight | Sum of all Gaia fluxes per HEALPix pixel | via HATS (column read of `phot_*_mean_flux` + ra/dec; tens of GB) | The resolved part, D. Good to about G ≈ 21. |

**Recommended construction** (each step keeps its label):

1. Individual stars down to a render cut (e.g. G ≈ 16) are points (§1).
2. From that cut down to G ≈ 21, **bin Gaia fluxes into a HEALPix map** (nside 1024, ≈ 3.4′) as surface brightness per band. Colour comes from XP where the source has it, otherwise from BP/RP. This is D.
3. **Residual = Pioneer IPP − (all Gaia stars convolved with the IPP beam)** in B and R. The residual is DGL + stars below G ≈ 21 + EBL at ~2° resolution. It is D, with the Pioneer calibration as its uncertainty.
4. Sub-degree DGL structure: scale the Planck thermal dust map (Planck 2013 XI, A&A 571, A11, doi:10.1051/0004-6361/201323195) by a DGL/100 µm ratio (Brandt & Draine 2012, ApJ 744, 129, doi:10.1088/0004-637X/744/2/129; Ienaka et al. 2013, ApJ 767, 80, doi:10.1088/0004-637X/767/1/80). Constrain it so its 2° average equals the Pioneer residual. This is E. The DGL spectrum comes from Brandt & Draine (E).
5. Validate against Matsuoka 2011 and the NH LORRI fields.

**Two-band colour for the residual (437/644 nm): E.** It is a fit of a smooth stellar-population spectrum to two points, and it is the weakest link in the whole sky model.

---

## 4. Zodiacal light (3D, viewable from anywhere)

- **Kelsall et al. 1998 DIRBE model** (ApJ 508, 44, doi:10.1086/306380). Components:
  - a 3D smooth cloud (a modified fan),
  - 3 asteroidal dust bands,
  - a circumsolar ring,
  - the Earth-trailing blob.
  - Each has emissivity and scattering fitted in the DIRBE bands 1.25–240 µm.
- **Optical applicability.** The *density geometry* is measured and transferable. The *visible albedo and scattering phase function* are **not** in the model: its scattering albedo and phase function are fitted only in the short-wavelength DIRBE bands (1.25–3.5 µm). For the optical, fit a phase function to visible data:
  - the Leinert 1998 Table 17 brightness map at 1 AU,
  - Helios 1/2 photometry 0.3–1 AU (Leinert et al. 1981, A&A 103, 177; radial slope ≈ r^−2.3),
  - Pioneer 10's measurement that zodiacal light vanishes beyond ~3.3 AU (Hanner et al. 1974, JGR 79, 3671, doi:10.1029/JA079i025p03671).
  - Hong 1985 (A&A 146, 67) gives a three-term Henyey–Greenstein fit to the visible zodiacal phase function.
  - Result: brightness seen from 1 AU is D (the tables are measurements). Brightness from elsewhere is **E** (Kelsall geometry plus a fitted optical phase function).
- **Code:** ZodiPy 1.1.5 (GPL-3; San et al. 2022, A&A 666, A107, doi:10.1051/0004-6361/202244133) implements Kelsall and Planck for arbitrary observer positions, but only for **IR wavelengths**. Use it for the density and line-of-sight integration and supply our own visible scattering. It is GPL, so run it only in the pipeline, not in the app.
- **Colour:** zodiacal light is slightly redder than the Sun (Leinert 1998). Use the solar spectrum times a fitted reddening (E).
- **A physically based alternative for later (M6):** dynamical cloud models (Nesvorný et al. 2010, ApJ 713, 816, doi:10.1088/0004-637x/713/2/816) give size-resolved dust densities. Scattering then comes from Mie or empirical particle phase functions.
- **From Earth's surface only:** airglow and atmospheric scattering. The ESO sky model (Noll et al. 2012, A&A 543, A92, doi:10.1051/0004-6361/201219040) is the best documented reference. v1 is mostly "in space", so this is optional.

---

## Top recommendations

1. **Pull Gaia by server-side ADQL** (TAP async, ~30 anonymous ≤3M-row jobs for G < 16, ~5 GB), not the 753 GB bulk. Make the release a parameter: **DR4 arrives 2 Dec 2026.**
2. **Colours:** XP sampled spectra for G < 15 (34.5M stars) integrated with the CIE functions, with Huang 2024 corrections (D). Fainter stars use a BP/RP → XYZS mapping fitted on that set (E). Licence CC BY-NC 3.0 IGO.
3. **Bright stars:** Hipparcos I/311 + BSC5 + CALSPEC and the Burnashev/Kharitonov SEDs for everything Gaia lacks (G < 1.73 entirely) or has saturated (G ≲ 6).
4. **Milky Way glow:** anchor absolutely to the **Pioneer 10/11 IPP B/R maps** (measured outside the zodiacal cloud). Add Gaia-summed starlight to G ≈ 21 (D). Planck-dust-shaped DGL for sub-degree structure (E). Mellinger is not downloadable.
5. **Zodiacal light:** Kelsall geometry (via ZodiPy in the pipeline) with a visible phase function fitted to Leinert 1998 and Helios (E away from 1 AU). Automating the Leinert table extraction is the main open item.

## Open issues

- The Leinert 1998 optical tables are not machine-readable anywhere found, and EDP blocks scripted download. Decide between a PDF-table extraction script and a one-time vendored table with a checksum. The second needs a North Star decision.
- The DR4 schema will change the stage. Check the draft data model before M4 starts.
- Pioneer map licence: ask K. Gordon, or use the NSSDC raw data.
