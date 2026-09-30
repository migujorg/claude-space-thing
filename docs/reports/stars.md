# Stars (M1): the star field seen from inside the solar system

Stage `stars` → `app/public/data/stars/bright.json` (BinaryTableHeader) + `bright.bin`, and `stars/names.json`.
Build: `cd pipeline && uv run python -m pipeline build --only stars` (from scratch ≈ 14 min, of which ≈ 12 min
fetching the XP spectra of the 440 702 selected sources, 0.61 GB; with `--set stars.xpSource=bulk` ≈ 50 min,
streaming all 114 GB of Gaia XP bulk files; from the cache ≈ 1 min; §8). Code: `pipeline/src/pipeline/stages/stars.py` and
`pipeline/src/pipeline/stars_*.py`; tests `pipeline/tests/test_stars_*.py`. Dataset notes:
`docs/sources/gaia-dr3.md`, `hipparcos.md`, `star-spectrophotometry.md`, `star-names.md`. Numbers below are from
the build of 2026-09-30 (window mid-epoch J2026.746); the stage writes them to `data/cache/stars/diagnostics.json`.

## Summary

| | |
|---|---|
| Stars | **482 459** (Gaia DR3 482 105, Hipparcos-only 104, Tycho-2-only 22, missing binary components 228) |
| Completeness | every star with **V < 9.8** that Gaia DR3, Hipparcos or Tycho-2 knows (99.9 % point of G − V; V < 10.0 at 99 %) |
| Light labels | **derived 437 677 (90.7 %)**, estimated 44 781 (9.3 %), unknown 0 (M4 rebuild with the Sternberg route; M1: 437 627 / 44 832) |
| Position labels | derived 481 820, estimated 639 |
| Size | bright.bin 23.2 MB + bright.json 10 kB + names.json 0.7 MB = 23.9 MB |
| Raw data kept | 1.5 GB (`data/raw/stars/`), of which 1.2 GB the XP spectra of the selected sources |
| Names | 3 816 stars: 409 IAU names, 1 977 Bayer, 2 880 Flamsteed designations |

## 1. What is in the product

### 1.1 Which stars

| Catalogue records | Rule | Count |
|---|---|---|
| Gaia DR3 sources | `phot_g_mean_mag < 10.0`, minus spurious duplicates of very bright stars (below) | 482 105 |
| Hipparcos-only | Hipparcos stars with no Gaia DR3 counterpart and V < 10.0 (Hp when V is missing) | 104 |
| Tycho-2-only | Tycho-2 stars with no Gaia best neighbour, no Gaia source within 2″, no Hipparcos entry, and V = VT − 0.090 (BT − VT) < 10.0 | 22 |
| Missing components | light of a Hipparcos multiple entry that no Gaia source carries (below) | 228 |

**Hipparcos ↔ Gaia.** Gaia's own `hipparcos2_best_neighbour` table first (96 114 pairs used); unmatched
Hipparcos stars are then matched by position at J2016.0 within 1.5″ if G − Hp < 1.5 (17 869; one-sided because
very red Mira-type stars such as R Dor have G 2–3 mag brighter than Hp, while a much *fainter* Gaia source is a
companion of a star Gaia lacks), then within 4″ if |G − Hp| < 1 (33; astrometric binaries whose Hipparcos proper
motion is perturbed, e.g. κ For). Where the best-neighbour table paired a Hipparcos star with a source > 1 mag
off in G while an unclaimed source within 4″ agrees with Hp to 0.75 mag, the pairing is moved (51; β Lep: from
G = 7.8 to G = 2.6). 3 888 Hipparcos stars stay unmatched, almost all fainter than V = 10 (their Gaia
counterparts have G > 10.5); 104 of them are catalogue records, mostly stars too bright for Gaia.

**Multiple stars.** Three effects would otherwise double-count or lose light:

* *Blended XP.* Gaia's BP/RP windows are 3.5″ × 2.1″, so each member of a pair closer than ~2″ has a spectrum
  holding both stars' light (such pairs show identical BP − RP). For the 5 127 sources with a neighbour
  ≤ 2.5 mag fainter within 2″, the XP flux is not used; their resolved G (astrometric field) with the blended
  colour is (flag 32).
* *Hipparcos combined photometry.* Hipparcos gives one V for many close pairs (`CombMag`), and a ground-based
  spectrophotometer aperture holds both stars. For such an entry the records within max(10″, ρ + 2″) are taken as
  its components (chance of an unrelated G < 10.5 star within 10″ ≈ 5 × 10⁻⁴). A Hipparcos-only or Pulkovo record
  keeps only the light the other records don't carry (7 reduced, e.g. γ And, α Her, θ¹ Ori C; 2 dropped because
  the Gaia components carry it all, HIP 24020 and 88745). When the Gaia components fall short of the Hipparcos
  system light by > 20 %, the shortfall is
  a component Gaia DR3 does not list: 228 become their own `estimated` records at the Hipparcos position (Castor A,
  m ≈ 1.9: Gaia DR3 has only Castor B); 586 shortfalls fainter than V = 10 are not added.
* *Spurious duplicates.* Two Gaia sources < 0.4″ apart with G within 0.15 mag, the brighter G < 5, are treated as
  one star. One case: ζ Her (two 2-parameter sources 0.26″ apart at G = 2.76 and 2.72; its real companion is
  5.5 mag and 1.5″ away). Real close equal pairs exist (γ Lup: 0.88″, G = 3.40/3.47) and are kept.

### 1.2 Record layout (48 bytes, little-endian; header `fields` is authoritative)

| offset | field | type | meaning |
|---|---|---|---|
| 0 | `dir` | f32 × 3 | ICRF unit vector (barycentric, no aberration) at `header.epochEt` = middle of the manifest window |
| 12 | `xyzs` | f32 × 4 | illuminance at the observer: CIE X, Y (lux), Z, scotopic S (scotopic lux) |
| 28 | `labelPos` | u8 | Label index (`header.labelEncoding`) of `dir` |
| 29 | `labelFlux` | u8 | label of Y and S |
| 30 | `labelColor` | u8 | label of the X : Y : Z : S ratios |
| 31 | `src` | u8 | index into `header.sourceTable`: the catalogue the record and its `catId` come from |
| 32 | `posRoute` | u8 | index into `header.routes.pos` (label, all sources, method of the direction) |
| 33 | `lightRoute` | u8 | index into `header.routes.light` (label, all sources, method of X, Y, Z, S) |
| 34 | `flags` | u8 | bits: 1 variable; 2 multiple / RUWE > 1.4; 4 XP spectrum present but not used (too bright, or a non-positive integral); 8 light from a Hipparcos multiple entry's combined light; 16 Gaia 2-parameter solution; 32 BP/RP blended by a neighbour within 2″ |
| 36 | `catId` | u32 × 2 | Gaia DR3 `source_id` as (lo, hi); or HIP number; or TYC1·2¹⁷ + TYC2·2³ + TYC3 (`header.idEncoding`) |
| 44 | `hip` | u32 | Hipparcos number of the star, 0 if none |

Bytes 0–27 are exactly the app's `StarCatalog` block `[ux, uy, uz, X, Y, Z, S]`; with stride 48 the file is a
`Float32Array` of stride 12. Records are sorted by Y, brightest first. No record currently carries NaN (no
`unknown` light), but the format allows it. `names.json` maps `"HIP n"` →
`{index, hip, gaiaDr3?, alsoIndex?, iau?, bayer?, flamsteed?, variable?, sources}`; `index` is the brightest
record carrying that Hipparcos number (Castor → Castor A), `alsoIndex` the other components.

### 1.3 Positions

Rigorous linear space motion (ESA 1997, SP-1200 Vol. 1 §1.5.5) from the catalogue epoch to the window's
mid-epoch, including the perspective term when parallax and radial velocity are known.

| Position route | label | stars |
|---|---|---|
| Gaia DR3 5/6-parameter astrometry, J2016.0 | derived | 475 030 |
| Hipparcos new reduction, J1991.25 (stars Gaia lacks; Gaia 2-parameter or RUWE > 1.4 with a larger propagated uncertainty) | derived | 4 649 |
| Gaia 2-parameter position + the star's Tycho-2 proper motion | derived | 2 133 |
| Tycho-2 mean position J2000.0 + proper motion | derived | 8 |
| Gaia 2-parameter position + proper motion of the Hipparcos star within 10″ (same system assumed) | estimated | 222 |
| Gaia 2-parameter position, no proper motion known (error = pm × 10.7 yr) | estimated | 403 |
| Tycho-2 observed position, no proper motion | estimated | 14 |

Parallax is not applied (directions are from the solar-system barycentre).

### 1.4 Light, in order of preference

| # | Light route | label | stars |
|---|---|---|---|
| 1 | **HST CALSPEC** STIS spectrum, observed over all of 360–830 nm | derived | 50 |
| 2 | **Gaia DR3 XP** sampled spectrum (336–1020 nm) for G ≥ 4.0 (§2), no blending neighbour, all four integrals > 0 | derived | 437 372 |
| 3 | **Pulkovo** spectrophotometry 320–1080 nm, V agrees with Hipparcos to 0.10 mag, not a combined entry | derived | 205 |
| 3b | **Sternberg** III/208 + III/207 spectrophotometry 322–1082 nm, the two agree to 5 % in their overlap, V agrees with Hipparcos (M4; docs/reports/sky.md §2) | derived | 50 |
| 4 | Hipparcos V, B − V → photometric relation | estimated | 436 |
| 5 | Gaia G, BP − RP → photometric relation | estimated | 43 786 |
| 6 | Tycho VT, BT − VT → photometric relation | estimated | 27 |
| 7 | magnitude only (G, V or VT) → population-median relation | estimated | 298 |
| 8 | Hipparcos multiple entry: system light not carried by other records | estimated | 234 |

(Counts from the M4 rebuild, 482 458 records; the M1 build had 477 on route 4, 43 795 on route 5 and 235 on route 8.)

*Photometric relations.* XYZS = 10^(−0.4 m) · k(c) with k the median of XYZS · 10^(0.4 m) over the stars of the
same colour index c (50-star bins) whose XYZS is derived from their own XP spectrum (G ≥ 4.0, not blended). The
assumption — equal colour index, equal spectral shape — makes them `estimated`. This replaces a template library
(e.g. Pickles 1998, matched by spectral type) with ~96 000–437 000 measured spectra on the same flux scale as the
XP stars. Robust scatter of Y about the relation: 0.009 mag (V, B − V), 0.005 mag (G, BP − RP), 0.017 mag (VT,
BT − VT). Order: Hipparcos V, B − V first for stars brighter than the XP limit and for non-Gaia stars (unless the
photometry is the combined light of a pair Gaia resolves or the source is blended), then Gaia G, BP − RP, Tycho,
Hipparcos V, V − I. 18 stars are bluer or redder than the calibrated colour range and use its end value.
*Population median* (route 7): 294 faint companions 1–3″ from brighter stars have G but no BP/RP; their colour is
that of the median star (Y scatter 0.21 mag in G, 0.03 mag in V).

Every spectrum goes through `cie.resample` (linear to 1 nm) and `cie.xyzs` (CIE 1931 2° CMFs, K_m = 683.002;
CIE 1951 V′, K′_m = 1700.06). For XP, whose grid is shared, the linear map resample∘xyzs is evaluated once per
sample and applied as a matrix product (identical to per-star calls; unit-tested). Vacuum wavelengths (XP,
CALSPEC) are used as-is; the 0.14 nm air/vacuum offset is negligible for these broadband integrals. 18 XP spectra
of extremely red stars (carbon stars, Miras) dip below zero in the blue and integrate to a negative Z or S; they
are not used (flag 4) and fall back to photometry.

## 2. The XP bright limit (G ≥ 4.0), from the data

XP-derived Y and chromaticity compared with what the star's Hipparcos V and B − V predict through the V, B − V
relation (calibrated on G ≥ 4 stars; the question is where brighter stars stop following it):

| G | stars | median ΔY (mag) | robust σ | median Δx | σ x | median Δy | σ y |
|---|---|---|---|---|---|---|---|
| 2.0–2.5 | 10 | +0.456 | 0.091 | −0.0636 | 0.0150 | −0.0288 | 0.0140 |
| 2.5–3.0 | 54 | +0.359 | 0.166 | −0.0361 | 0.0204 | −0.0265 | 0.0194 |
| 3.0–3.5 | 117 | +0.113 | 0.092 | −0.0134 | 0.0128 | −0.0057 | 0.0089 |
| 3.5–4.0 | 219 | +0.017 | 0.028 | −0.0035 | 0.0041 | −0.0005 | 0.0026 |
| **4.0–4.5** | 414 | −0.001 | 0.011 | −0.0011 | 0.0017 | +0.0000 | 0.0015 |
| 4.5–5.0 | 685 | −0.002 | 0.010 | −0.0010 | 0.0018 | −0.0001 | 0.0016 |
| 5.0–6.0 | 3 305 | −0.001 | 0.009 | −0.0010 | 0.0017 | −0.0004 | 0.0015 |
| 6.0–8.0 | 37 215 | ±0.001 | 0.008 | −0.0005 | 0.0019 | −0.0003 | 0.0017 |
| 8.0–9.0 | 36 238 | 0.000 | 0.008–0.009 | +0.0002 | 0.0026 | +0.0002 | 0.0024 |
| 9.0–10.0 | 18 184 | −0.002 | 0.012–0.016 | +0.0010 | 0.0040 | +0.0003 | 0.0038 |

(ΔY > 0: XP fainter.) Below G ≈ 4 the XP spectra of saturated stars go wrong — too faint by 0.1–0.5 mag and too
blue by up to 0.06 in x — while from G = 4.0 on they agree with the ground-based photometry as well as faint stars
do. The same break shows against the independent Pulkovo spectrophotometry:

| G | stars | median ΔY XP − Pulkovo (mag) | robust σ | median Δx | median Δy |
|---|---|---|---|---|---|
| < 3 | 46 | +0.374 | 0.172 | −0.0496 | −0.0370 |
| 3–4 | 47 | +0.026 | 0.064 | −0.0116 | −0.0100 |
| 4–5 | 46 | −0.021 | 0.012 | −0.0066 | −0.0080 |
| 5–6 | 6 | −0.006 | 0.023 | −0.0065 | −0.0083 |

The constant offset at G ≥ 4 (XP 2 % brighter, Δx ≈ −0.007) is a difference of absolute calibration between
Pulkovo and the HST scale, not an XP problem — see §3.

## 3. Absolute scales of the three spectral sources

*XP vs CALSPEC* (43 stars with both, G 3.8–9.8): XP Y is fainter by a median 0.011 mag (σ 0.003–0.004),
Δx = −0.001 to −0.002, Δy = −0.002 to −0.003, (S/Y) higher by ~1 %. Consistent and small; the XP external
calibration was anchored on earlier CALSPEC versions (so this is not an independent check of either).

*Pulkovo vs CALSPEC* (same stars, single, same light):

| star | ΔY Pulkovo − CALSPEC (mag) | Δx | Δy |
|---|---|---|---|
| Sirius | +0.036 | +0.0021 | +0.0040 |
| Vega | +0.026 | +0.0037 | +0.0056 |
| η UMa | +0.060 | +0.0042 | +0.0067 |
| 109 Vir | +0.055 | +0.0051 | +0.0065 |
| δ UMi | +0.066 | +0.0058 | +0.0064 |
| σ Ori | −0.077 | +0.0050 | +0.0067 |

Pulkovo is 3–7 % fainter and ~0.005 redder than HST (σ Ori is brighter in Pulkovo, most likely because its
aperture also held σ Ori D, 13″ away and ~7 % of the light of the AB pair that STIS observed). Pulkovo spectra
are still used, as measured data, for the 205 bright stars (G < 4 or missing from
Gaia) with no CALSPEC spectrum: these offsets are the systematic uncertainty of those stars' Y (≈ 5 %) and
chromaticity (≈ 0.005) — below what an eye can tell apart at star brightness.

## 4. Named bright stars

Y against the rough V-band rule E_V ≈ 2.54 × 10⁻⁶ · 10^(−0.4 V) lux with Hipparcos V (a sanity check only; Y and V
differ in passband, so red stars sit ~0.1 mag brighter in Y):

| star | light route | label | Y (lux) | x | y | S/Y | V (Hipparcos) | E_V (lux) | −2.5 log(Y/E_V) |
|---|---|---|---|---|---|---|---|---|---|
| Sirius | CALSPEC | derived | 9.801e-06 | 0.2622 | 0.2657 | 3.082 | −1.44 | 9.568e-06 | −0.026 |
| Canopus | Pulkovo | derived | 5.091e-06 | 0.2816 | 0.2896 | 2.819 | −0.62 | 4.496e-06 | −0.135 ¹ |
| Arcturus | Pulkovo | derived | 2.902e-06 | 0.3785 | 0.3812 | 1.878 | −0.05 | 2.660e-06 | −0.095 |
| Vega | CALSPEC | derived | 2.537e-06 | 0.2629 | 0.2674 | 3.069 | +0.03 | 2.471e-06 | −0.029 |
| Betelgeuse | V, B − V | estimated | 1.758e-06 | 0.4140 | 0.4059 | 1.577 | +0.45 ² | 1.678e-06 | −0.051 |
| Rigel | Pulkovo | derived | 2.209e-06 | 0.2697 | 0.2760 | 2.968 | +0.18 | 2.152e-06 | −0.029 |
| Antares | V, B − V | estimated | 1.041e-06 | 0.4372 | 0.4067 | 1.477 | +1.06 ² | 9.568e-07 | −0.091 |
| α Cen A | V, B − V | estimated | 2.677e-06 | 0.3245 | 0.3330 | 2.352 | −0.01 | 2.564e-06 | −0.047 |
| Procyon | Pulkovo | derived | 1.819e-06 | 0.3035 | 0.3143 | 2.550 | +0.40 | 1.757e-06 | −0.037 |
| Altair | Pulkovo | derived | 1.265e-06 | 0.2857 | 0.2954 | 2.753 | +0.76 | 1.261e-06 | −0.003 |
| Aldebaran | Sternberg ³ | derived | 1.111e-06 | 0.3990 | 0.3912 | 1.704 | +0.87 | 1.140e-06 | +0.028 |
| Spica | Sternberg ³ | derived | 9.973e-07 | 0.2501 | 0.2461 | 3.307 | +0.98 | 1.030e-06 | +0.035 |
| Deneb | Pulkovo | derived | 7.887e-07 | 0.2800 | 0.2890 | 2.827 | +1.25 | 8.032e-07 | +0.020 |
| Achernar | Pulkovo | derived | 1.677e-06 | 0.2561 | 0.2591 | 3.190 | +0.45 | 1.678e-06 | +0.001 |
| Capella | Pulkovo | derived | 2.471e-06 | 0.3381 | 0.3481 | 2.215 | +0.08 | 2.360e-06 | −0.050 |
| Polaris | Sternberg ³ | derived | 3.922e-07 | 0.3168 | 0.3263 | 2.418 | +1.97 | 4.138e-07 | +0.058 |

¹ Hipparcos V for Canopus is −0.62; the Pulkovo catalogue's own V is −0.72, with which the difference is −0.03.
² Semiregular variables; the value is for the catalogue's mean V.
³ Since M4: Sternberg III/208 + III/207 spectrophotometry (docs/sources/star-spectrophotometry.md,
docs/reports/sky.md §2). Before, these three were V, B − V estimates (Aldebaran Y 1.257e-06, Spica 1.048e-06,
Polaris 4.309e-07).
Betelgeuse (III/207 only, no blue half), Antares and α Cen A are in no measured spectrophotometric catalogue used
here (Pulkovo's 320–1080 nm table lacks them; α Cen A/B have only its 320–735 nm table) and Gaia cannot observe
them.

## 5. Colour trend

Median chromaticity and scotopic-to-photopic ratio of the catalogue, by Hipparcos B − V and by the first letter
of the Hipparcos spectral type (apparent colours, i.e. including interstellar reddening):

| B − V | stars | x | y | S/Y |
|---|---|---|---|---|
| −0.4 to −0.2 | 93 | 0.2518 | 0.2519 | 3.269 |
| −0.2 to 0.0 | 6 621 | 0.2593 | 0.2619 | 3.134 |
| 0.0 to 0.2 | 12 804 | 0.2698 | 0.2755 | 2.968 |
| 0.2 to 0.4 | 12 965 | 0.2885 | 0.2965 | 2.727 |
| 0.4 to 0.6 | 21 890 | 0.3056 | 0.3145 | 2.539 |
| 0.6 to 0.8 | 10 540 | 0.3213 | 0.3302 | 2.385 |
| 0.8 to 1.0 | 10 589 | 0.3461 | 0.3525 | 2.162 |
| 1.0 to 1.2 | 15 628 | 0.3597 | 0.3632 | 2.045 |
| 1.2 to 1.4 | 8 000 | 0.3807 | 0.3766 | 1.874 |
| 1.4 to 1.6 | 6 984 | 0.4034 | 0.3896 | 1.700 |
| 1.6 to 1.8 | 3 260 | 0.4151 | 0.3982 | 1.617 |
| 1.8 to 2.0 | 368 | 0.4360 | 0.4058 | 1.479 |

| class | stars | x | y | S/Y |
|---|---|---|---|---|
| O | 251 | 0.2839 | 0.2906 | 2.778 |
| B | 10 118 | 0.2633 | 0.2672 | 3.067 |
| A | 18 213 | 0.2748 | 0.2816 | 2.898 |
| F | 23 752 | 0.3030 | 0.3117 | 2.567 |
| G | 21 447 | 0.3284 | 0.3364 | 2.320 |
| K | 30 957 | 0.3680 | 0.3687 | 1.975 |
| M | 4 219 | 0.4122 | 0.3974 | 1.640 |

Hot stars are bluer (x ≈ 0.25) and rich in scotopic light (S/Y ≈ 3.3), cool stars redder (x ≈ 0.44, S/Y ≈ 1.5),
monotonically in B − V. The O stars in this magnitude range are distant and reddened by dust, hence redder than
the B stars. (Vega: x = 0.2629, y = 0.2674; the solar twin 18 Sco via CALSPEC: x = 0.3199, y = 0.3304.)

## 6. Counts and total starlight

m_Y = V_Vega − 2.5 log₁₀(Y / Y_Vega) with Y_Vega = 2.537 × 10⁻⁶ lux from Vega's CALSPEC spectrum and
V_Vega = 0.03 (Hipparcos) — a photopic magnitude on the Vega scale, used here only for binning.

| m_Y | stars | cumulative | derived | estimated | cumulative ΣY (lux) | ΣS (scot. lux) | share of catalogue Y |
|---|---|---|---|---|---|---|---|
| < 0 | 4 | 4 | 3 | 1 | | | |
| 0–1 | 12 | 16 | 6 | 6 | 4.03e-5 | 1.08e-4 | 7.1 % |
| 1–2 | 35 | 51 | 23 | 12 | 5.94e-5 | 1.60e-4 | 10.5 % |
| 2–3 | 121 | 172 | 74 | 47 | 8.90e-5 | 2.36e-4 | 15.7 % |
| 3–4 | 354 | 526 | 84 | 270 | 1.23e-4 | 3.22e-4 | 21.7 % |
| 4–5 | 1 133 | 1 659 | 711 | 422 | 1.67e-4 | 4.32e-4 | 29.4 % |
| 5–6 | 3 431 | 5 090 | 2 501 | 930 | 2.21e-4 | 5.66e-4 | 38.9 % |
| 6–7 | 10 726 | 15 816 | 8 587 | 2 139 | 2.88e-4 | 7.28e-4 | 50.7 % |
| 7–8 | 31 049 | 46 865 | 27 520 | 3 529 | 3.65e-4 | 9.11e-4 | 64.3 % |
| 8–9 | 87 411 | 134 276 | 79 536 | 7 875 | 4.52e-4 | 1.11e-3 | 79.7 % |
| 9–10 | 233 490 | 367 766 | 212 260 | 21 230 | 5.45e-4 | 1.33e-3 | 96.0 % |
| 10–11 | 102 758 | 470 524 | 95 043 | 7 715 | | | |
| ≥ 11 | 11 935 | 482 459 | | | 5.68e-4 | 1.37e-3 | 100 % |

(Stars with m_Y > 10 are red: their G < 10 but their photopic light is fainter; the catalogue is defined in G.)

**Completeness.** Every Gaia DR3 source with G < 10.0 is in, so every Gaia star with V < 10.0 − max(G − V) is.
For 10 949 single, constant Hipparcos stars with ground-based V: median G − V = −0.125, 99th percentile +0.001,
99.9th percentile +0.165 → complete to **V = 9.8** (V = 10.0 for 99 % of stars). Stars Gaia misses are filled
from Hipparcos (complete to V ≈ 7.3–9) and Tycho-2 (99 % complete to V = 11): of the 22 439 Tycho-2 stars with
VT < 11 and no Gaia best neighbour, 21 179 have a Gaia source within 2″ (at G − VT < 1.5), 11 444 are Hipparcos
stars, and the 22 with neither and V < 10 are Tycho-only records. The residual incompleteness is stars missing
from all three catalogues — mainly close binaries below Tycho's resolution (partly recovered through Hipparcos
combined photometry, §1.1).

**Integrated starlight.** The whole catalogue sums to X = 5.63 × 10⁻⁴, **Y = 5.68 × 10⁻⁴ lux**, Z = 6.42 × 10⁻⁴,
**S = 1.37 × 10⁻³ scotopic lux** (sum of normal-incidence illuminances over the whole sphere), chromaticity
(0.318, 0.320). That is 218 Vega-like V = 0 stars (Y of a V = 0 A0 star = Y_Vega · 10^(0.4 · 0.03) =
2.61 × 10⁻⁶ lux), a total magnitude of −5.84. Published comparison: all starlight spread uniformly over the sky
would be ≈ 100 S10 units (one V = 10 star per square degree; Benn C. R. & Ellison S. L. 1999,
arXiv:astro-ph/9909153, summarising La Palma Technical Note 115, 1998 — an approximate fit to Roach & Gordon 1973,
*The Light of the Night Sky*), i.e. 100 × 41 253 × 10⁻⁴ = 413 V = 0 stars ≈ 1.08 × 10⁻³ lux (an approximate
value). The catalogue holds **53 %** of it, as expected: the same source notes
that most of this light comes from stars with 6 < V < 16; the rest is the Milky Way's unresolved glow (M4). A
surface facing an average hemisphere of the sky would receive ~Y/4 ≈ 1.4 × 10⁻⁴ lux from these stars
(≈ 2.7 × 10⁻⁴ lux from all starlight, before any atmosphere). Masana et al. (2021, MNRAS 501, 5443, DOI 10.1093/mnras/staa4005) find that the
~35 000 Hipparcos stars missing from Gaia DR2 (their flux dominated by the brightest) give ~20 % of the integrated
starlight; the roughly
comparable part here (m_Y < 5, 29 % of the catalogue) is ~16 % of the Benn & Ellison total.

## 7. Positions vs SIMBAD

Test `test_catalogue_positions_vs_simbad` propagates SIMBAD's J2000 astrometry (stored in
`pipeline/tests/fixtures/simbad_stars.json`) with astropy to the product epoch and compares with `dir`:

| star | position source | catalogue − SIMBAD |
|---|---|---|
| Sirius, Canopus, Arcturus, Vega, Betelgeuse, Rigel, Antares, Procyon, Altair, Aldebaran, Spica, Deneb, Polaris | Hipparcos 2007 | 0.000–0.007″ |
| α Cen A | Hipparcos 2007 | 0.039″ |
| 61 Cyg A | Gaia DR3 | 0.069″ |
| Barnard's star (10.4″/yr) | Gaia DR3 | 0.384″ |

All < 1″ (SIMBAD's values for these stars come from the same Hipparcos/Gaia solutions, so this checks the
propagation, the epoch handling and the record matching). `propagate` itself matches astropy's
`apply_space_motion` to < 0.1 mas over 1991–2027 for the fastest nearby stars.

## 8. XP spectra: targeted queries (`stars.xpSource`)

ESA publishes the XP sampled spectra (`xp_sampled_mean_spectrum`) as 3386 bulk files ordered by source_id, not
by brightness, so colouring the 440 702 bright-tier sources from them means streaming all 114 GB. They are not in
ESA's TAP service, and ESA's DataLink (`RETRIEVAL_TYPE=XP_SAMPLED`, `DATA_STRUCTURE=RAW`) took 251 s for a batch
of 1000 ids (≈ 30 h for the bright tier). The TAP service of ARI Heidelberg, a Gaia DPAC partner data centre,
serves the same table (`gaiadr3.xp_sampled_mean_spectrum`, flux REAL[343]). The default route
(`stars.xpSource=archive`) queries it for exactly the sources a stage needs:
`SELECT source_id, flux FROM gaiadr3.xp_sampled_mean_spectrum WHERE source_id IN (...)`. Queries are POSTed with at
most 5000 ids each, grouped by HEALPix level-2 pixel so that batches stay put when the selection changes, and the
answer is a FITS table. `--set stars.xpSource=bulk` keeps the bulk stream.

* **Bright tier.** 207 queries, 0.61 GB, 12 min with 4 at a time. Each response is kept as a FITS file in
  `data/raw/stars/gaia_dr3_xp_ari/`, with its ADQL as a `.adql` sidecar and its POST-body and response sha256s
  in the download ledger.
* **Deep tiers.** The responses are reduced on the fly, like the bulk stream, and only the reductions are kept, in
  `data/cache/stars/xp_reduced/xyzs_pioneerBR_v1_archive/`. The bright-tier stars that the sky stage needs are
  reduced from the raw files above, with no second download.

**Same values.** The comparison is against the bulk-derived data of the 2026-09-30 build, i.e. the raw subset
`data/raw/stars/gaia_dr3_xp_sampled/*.npz` and the reduced cache `data/cache/stars/xp_reduced/xyzs_pioneerBR_v1/`:

| | compared | identical |
|---|---|---|
| bright tier: source ids | 440 702 | the same set |
| bright tier: flux samples (float32) | 151 160 786 | all, bit for bit (0 null samples) |
| bright tier: X, Y, Z, S as the stars stage computes them | 440 702 stars | all, bit for bit (max relative difference 0) |
| bright tier: reductions X, Y, Z, S, Pioneer B, R (deep and sky stages) | 440 702 × 6 | all, bit for bit |
| deep stages' XP reductions: every deep-tier source with XP plus the XP-lit bright stars | 15 741 252 × 6 | all, bit for bit; all 15 741 252 found in the bulk cache, none missing from ARI |
| stars stage products `bright.bin`, `bright.json`, `names.json` | built both ways from the same data/raw | byte-identical |
| deepstars products `stars/deep.json` + 768 tiles | archive build vs the bulk-route release build | byte-identical (769 files) |
| sky products (`sky/diffuse*`, `deep-aggregate-o8`, `deep-remainder-o7`, `faint-stars-o8`, `zodiacal.json`) | archive build vs the release build | byte-identical (7 files) |

The deep stages' XP reductions cover 15 303 880 deep-tier sources, queried in 3158 queries (21.1 GB of FITS
responses, ≈ 55 min at 4 queries at a time, ≈ 6.5 MB/s). They also cover 437 372 bright-tier stars lit by XP,
which are reduced from the stars stage's raw responses without being downloaded again. The cache holds 0.5 GB
(the bulk route's covers all 34.5 M spectra, 1.1 GB). A build interrupted by a container restart resumed where it
stopped: only the 287 queries not yet recorded in `_fetched.json` were repeated.

The reductions are identical only because the archive route reproduces how the bulk route reads the numbers. The
bulk files print every sample as the shortest decimal that round-trips to its float32, and the bulk route parses
that text straight to float64 (`_parse_flux`). The archive route gets the float32 values, prints them the same way
and parses them back (`stars_gaia.xp_text_float64`, with Arrow casts). Without that step, 97.6 % of the bright-tier
reductions are bit-identical and the rest differ by at most 3.0 × 10⁻⁶ relative (99th percentile 8.6 × 10⁻⁸).
The stars stage itself integrates the float32 values widened to float64 on both routes, so its product never
depended on this. Only `sources.json` differs between the routes: the XP records name the service, the queries,
and a digest over the responses' sha256s instead of the bulk files'. `pipeline/tests/test_stars_xp_archive.py`
checks the equivalence offline against `_stream_file` on synthetic spectra spanning many decades.

## 9. Tests

`pipeline/tests/test_stars_format.py` (writer/reader round trip; the app's Float32 view; built-product
consistency: unit vectors, labels vs routes, NaN iff unknown, positivity, sort order, size < 30 MB),
`test_stars_astrometry.py` (vs astropy; vs SIMBAD), `test_stars_light.py` (resample∘xyzs operator = direct cie
calls; coverage rule; relation fitting; named-star brightness sanity), `test_stars_names.py` (Bayer/Flamsteed/
variable designations; names product).

## 10. Open issues

* **No observer parallax.** Directions are barycentric. From the outer planets nearby stars shift by up to
  ~23″ (α Cen from 30 au) — below eye resolution, but a zoomed "enhanced" view would show it. Adding parallax
  (f32, with a label) would cost 4 bytes per record.
* **Proper motion within the window** is not in the file; over ±18 months the fastest bright star (α Cen,
  3.7″/yr) moves 5.5″. The app treats `dir` as fixed at `epochEt`.
* **Brightest stars without spectra.** The 436 stars on the Hipparcos V, B − V route (Betelgeuse, Antares,
  α Cen A/B, Hadar, Acrux, ...: brighter than G = 4 or missing from Gaia) are `estimated`. Since M4 the Sternberg
  catalogues (III/208 + III/207) make 50 of the former ones `derived`, among them Aldebaran, Spica and Polaris.
* **Pulkovo absolute scale** differs from HST by 3–7 % and ~0.005 in chromaticity (§3); not corrected (a
  cross-calibration would itself be an assumption).
* **Variable stars** carry catalogue-mean brightness (flag 1); Betelgeuse varies by ~1 mag.
* **Stars fainter than the limit** (and the unresolved Milky Way) hold ~47 % of all starlight: M4 (diffuse light).
* **Environment note for other stages:** `import colour` without matplotlib installs a MagicMock as
  `sys.modules['matplotlib']`, after which importing `astropy.time` fails ("matplotlib.__spec__ is not set").
  The stars stage works around it locally (`stages/stars.py::_import_astropy`); installing matplotlib or fixing
  it in `cie.py` would remove the trap for everyone.
