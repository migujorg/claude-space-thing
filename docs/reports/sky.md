# M4 "the real sky", data side — report

Stages `deepstars` and `sky` (pipeline/src/pipeline/stages/), after `stars`. Products in app/public/data:

| product | content | size | labels |
|---|---|---|---|
| `stars/deep.json` + `stars/deep-o3-000…767.bin` | Gaia DR3 stars 10 ≤ G < 14 not in the bright tier, 48-byte records, 768 HEALPix order-3 tiles, brightest first | 785 MB + 0.3 MB | light: derived 15 232 820, estimated 1 129 217; position: derived 16 259 844, estimated 102 193 |
| `sky/faint-stars-o8.bin` | radiance XYZS of all 1.79 × 10⁹ Gaia sources with G ≥ 14, HEALPix order 8 | 12.6 MB | estimated |
| `sky/diffuse-o6.bin` (+ `-label.bin`) | Pioneer 10/11 sky minus all stars: diffuse galactic light + EBL + stars below Gaia, order 6, 3° resolution | 0.8 MB | estimated |
| `sky/deep-aggregate-o8.bin` | the deep tier summed per pixel (level of detail, not additive) | 12.6 MB | estimated (92.4 % of its Y from XP-derived records) |
| `sky/diffuse.json` | `SkyMapsFile` header: projection, units, methods, sources, stats | 8 kB | |
| `sky/zodiacal.json` | Leinert 1998 zodiacal light at 1 AU + Kelsall 1998 cloud with a fitted visible phase function | 10 kB | at 1 AU measured; colour derived; elsewhere estimated |
| `stars/bright.*` (rebuilt) | 50 more bright stars lit by measured spectrophotometry (Sternberg), incl. Aldebaran, Spica, Polaris | 23.9 MB | derived 437 677, estimated 44 781 |

Products total 0.84 GB (budget 1.5 GB). Raw downloads: `data/raw/stars` 2.6 GB (of which the new deep-tier FITS
1.1 GB and archive sums 0.1 GB) + `data/raw/sky` 12 MB, under the 3 GB budget; the all-sky XP reductions (1.1 GB)
are a cache (`data/cache/stars/xp_reduced/`). New schema types (additive, `app/src/data/schema.ts`):
`TiledBinaryTableHeader`, `StarTile`, `HealpixMapLayer`, `SkyMapsFile`, `ZodiacalLightModel`; rows added to
docs/architecture.md §6. Sources: docs/sources/gaia-dr3.md (new sections), pioneer-ipp.md, zodiacal-light.md,
star-spectrophotometry.md (Sternberg).

Build time with everything cached: `deepstars` 163 s, `sky` 121 s. First build: 114 GB of XP bulk files streamed
and reduced (76 min), 192 deep-tier TAP queries (27 min), 3 × 48 aggregation queries (10–19 min each).

## 1. Deep star tiers (`stars/deep.*`)

### 1.1 Tier split and counts against the archive

The archive's own counts come from an independent aggregation (`count_grid_L4_*`: COUNT(*) per HEALPix level-4
pixel and integer G bin over all 1 811 709 771 DR3 sources):

| G | archive | where |
|---|---|---|
| < 10 | 482 106 | `stars/bright`: 482 105 Gaia records (one spurious duplicate of ζ Her dropped in M1), plus 353 Hipparcos/Tycho-only records |
| 10 – 11 | 765 134 | `stars/deep` |
| 11 – 12 | 1 840 581 | `stars/deep` |
| 12 – 13 | 4 281 806 | `stars/deep` |
| 13 – 14 | 9 474 529 | `stars/deep` |
| 10 – 14 total | **16 362 050** | deep-tier queries returned 16 362 050 rows; **16 362 037 records** after de-duplication |
| ≥ 14 | 1 789 410 276 | `sky/faint-stars` (the level-8 sums count 1 789 410 276 sources) |
| no G | 5 455 339 | not used (no photometry) |

Split: `stars/bright` = every Gaia source with G < 10 (+ Hipparcos/Tycho stars Gaia lacks); `stars/deep` = every
other source with 10 ≤ G < 14. No deep source shares a source_id with bright (bright only holds G < 10 Gaia
sources); 13 deep sources were dropped as the same star as a bright Hipparcos/Tycho-only record (within 2″ at the
epoch, Y within 1.5 mag). Per tile, deep count + dropped equals the archive grid's count of the tile's 4 children
in G 10–14 (768 tiles; 11 tiles differ by the 13 dropped stars, max 2).

### 1.2 Records, positions and light

Same 48-byte record and header conventions as `stars/bright` (`TiledBinaryTableHeader`; `binPattern`
`deep-o3-{pix:03d}.bin`; `tiles[]` with centre, radius, count, Y range and prefix counts).

| position route | label | records |
|---|---|---|
| 5/6-parameter astrometry propagated to the epoch (no RV: < 0.1 mas) | derived | 16 238 626 |
| 2-parameter solution + Tycho-2 proper motion | derived | 21 218 |
| 2-parameter solution at J2016.0, no proper motion known | estimated | 102 193 |

| light route | label | records |
|---|---|---|
| own XP spectrum (all samples in 360–830 nm, integrals > 0, no neighbour within 2″ brighter than G + 2.5) | derived | 15 232 820 |
| G, BP − RP relation fitted on this tier's XP stars (3 859 adaptive bins, BP − RP −0.54 … 7.71, median scatter 0.007 mag in Y; 67 stars outside the colour range use the end bin) | estimated | 1 077 197 |
| G alone (no BP/RP), population median (scatter 0.14 mag) | estimated | 52 020 |

15 303 880 sources (93.5 %) have XP spectra (every source flagged `has_xp_sampled` was found in the bulk files);
71 060 of those are blended (164 405 sources have a comparably bright neighbour within 2″, including bright-tier
stars) or have a missing sample. Sources without XP are not uniform on the sky: in regions Gaia scanned few times
(e.g. tile 444: 62 % estimated) the tile is lit mostly by the relation. XP wavelengths are used as vacuum (as the
bright tier; < 0.1 % in Y).

### 1.3 Tiles

HEALPix order 3 (768 tiles, NESTED, ICRS), assigned by `source_id >> 53` (the pixel of the J2016 catalogue
position; `sky_healpix` agrees with Gaia's level-12 index for 99.6 % of sources and 100 % at level 3). Records per
tile: min 4 211, median 12 189, max 177 747 (8.5 MB, toward the Galactic centre). Each `radiusDeg` is the largest
distance of a member star from the pixel centre (≤ 7.45°). Prefix counts at the Y of a G = 11 / 12 / 13 star of
median colour (8.52 × 10⁻¹¹, 3.39 × 10⁻¹¹, 1.35 × 10⁻¹¹ lux) sum to 702 832 / 2 427 389 / 6 402 257 records, so
the app can load the whole sky to G ≈ 12 with 116 MB.

**Round trips** (8 tiles: 0, 444 (smallest), 449 (largest), 478, 524, 689, 722, 767), read back with the header's
field table: byte length = count × 48; Y non-increasing; every direction within `radiusDeg` of `center`; every
`source_id >> 53` equals the tile; XP-route XYZS equal the reduced XP values (rtol 10⁻⁶); prefix counts equal the
number of records above each threshold. All pass for all 8 tiles.

Total Y of the tier: 3.42 × 10⁻⁴ lux (sum over the sphere, as for the bright tier's 5.68 × 10⁻⁴).

### 1.4 Gaia release parameter

`PIPELINE_GAIA_RELEASE` (default `dr3`) selects an entry of `stars_gaia.RELEASES` (schema, CDN directory,
citation, XP grid). All queries, raw directories and SourceRecord ids derive from it; for `dr3` every query string
is unchanged, so the cached M1 files were reused byte for byte. DR4 is not pre-filled: its entry must come from
the released data model.

## 2. Brightest stars: Sternberg spectrophotometry

Sternberg III/208 (322.5–762.5 nm) joined with III/207 (597.5–1082.5 nm) covers 360–830 nm for the 170 Hipparcos
stars in both; 53 are refused because the two catalogues disagree by more than 5 % in their 597.5–762.5 nm
overlap. The route sits after CALSPEC, XP and Pulkovo and lights 50 records (label `derived`), among them:

| star | before (M1) | now | Y (lux) | x, y | −2.5 log(Y / E_V) |
|---|---|---|---|---|---|
| Aldebaran | V, B − V (estimated), Y 1.257e-06 | Sternberg (overlap ratio 1.041, rms 2.8 %) | 1.111e-06 | 0.3990, 0.3912 | +0.028 |
| Spica | V, B − V (estimated), Y 1.048e-06 | Sternberg (1.016, 4.9 %) | 9.973e-07 | 0.2501, 0.2461 | +0.035 |
| Polaris | V, B − V (estimated), Y 4.309e-07 | Sternberg (1.030, 3.8 %) | 3.922e-07 | 0.3168, 0.3263 | +0.058 |

(E_V = 2.54 × 10⁻⁶ · 10^(−0.4 V) lux, Hipparcos V: a sanity check only.) On 58 stars also measured by Pulkovo
(none overlaps CALSPEC), Sternberg Y is 0.7 % brighter (median; rms 0.048 mag) and slightly bluer (Δx −0.004,
Δy −0.005). Betelgeuse is only in III/207 (no blue half), Antares and α Cen A in neither; they stay estimated.

## 3. Diffuse sky (`sky/diffuse.json`)

The sky beyond the rendered stars is two layers (`composition` in the header): **faintStars** (Gaia G ≥ 14, at
0.23° pixels) and **diffuse** (what Pioneer saw that no catalogue star accounts for, at 3° resolution).

### 3.1 faintStars: Gaia G ≥ 14 from archive sums (estimated)

Per level-8 pixel the archive sums 10^(−0.4 G) over all G ≥ 14 sources; per level-6 pixel and BP − RP bin of
0.1 mag it sums 10^(−0.4 G) again. Each colour bin is converted with the median XYZS · 10^(0.4 G) of the deep-tier
stars of that colour whose XYZS comes from their XP spectra (73 bins, BP − RP −0.4 … 6.9, ≥ 30 stars each;
1 × 10⁶ calibration stars); sources without BP/RP (3.3 % of the G-flux) take the all-colour median; 0.03 % of the
flux lies outside the calibrated colours. The level-6 colour mix is applied to the level-8 G sums. The two archive
sums agree to 10⁻¹⁴.

Hold-out test: bins built from G < 13 stars, applied to the summed G-flux of the 13 ≤ G < 14 stars per bin,
reproduce their summed X, Y, Z, S to −0.16 %, −0.09 %, −0.88 %, −0.24 % (Pioneer B −1.6 %, R +0.1 %).
Estimated, because it assumes that faint stars of a given BP − RP have the spectra of brighter ones of that colour.
(A linear model XYZS = a·F_G + b·F_BP + c·F_RP, which could be applied to plain sums, was tried first and rejected:
its bias by colour reached 20–70 % in Z and B.)

The faint stars hold 2.12 × 10⁻⁴ lux (sum over the sphere): 19 % of all stellar light.

### 3.2 Pioneer 10/11: which stars are in the maps

The IPP maps (docs/sources/pioneer-ipp.md) have no data on 9.7 % of the sky and show no spike at Sirius or
Canopus. Leinert (p. 69): stars "typically brighter than 6.5 mag" were removed using a 12 457-star catalogue. The
12 457th brightest Hipparcos star has V = 6.81, so the stars with V < 6.81 (12 571 Hipparcos stars; 12 635 bright-
tier records) are treated as removed and not subtracted. Check by regression of the high-passed (10°) maps on
star maps per Hipparcos-V bin (2° beam; coefficient 1 = fully present, relative to the rest of the stars):

| V bin | < 5.0 | 5.0–5.5 | 5.5–6.0 | 6.0–6.5 | 6.5–7.0 | 7.0–7.5 | 7.5–8.0 | rest + deep + faint |
|---|---|---|---|---|---|---|---|---|
| B coefficient | −0.001 | −0.04 | −0.16 | −0.15 | −0.01 | 0.25 | 0.36 | 0.74 |
| R coefficient | −0.008 | −0.03 | −0.14 | −0.17 | 0.37 | 0.21 | 0.34 | 0.82 |

(8-fold split errors 0.002–0.04.) Stars brighter than V = 6.5 are absent (0, or slightly negative: Toller's
subtraction slightly over-removed); fainter stars are present but with coefficients well below 1. That shortfall
is not a clean inclusion fraction: it depends on the assumed beam (a larger Gaussian beam raises every coefficient
together, the IPP field of view was a 2.3° × up to 7.9° sector), and the unfiltered comparison says the fainter
stars are in the maps (below). The regression is kept as a diagnostic in `stats.starInclusion`. The choice of cut
matters at the level of the light between V = 6.5 and 7.0: median 1.6 S10⊙ (6.5 to the cut) and 0.8–0.9 S10⊙ (cut
to 7.0) at 3° resolution, against a median remainder of 21 (B) / 35 (R) S10⊙.

### 3.3 diffuse: the remainder (estimated)

Pioneer B and R (binned to order 7 with coverage weights, smoothed 2.24° to reach 3° FWHM from the native ~2°)
minus the stars in the maps (bright tier V ≥ 6.81, deep tier, faintStars, each star's IPP-band flux from its XP
spectrum or from its XYZ (rms 8.5 % B, 3.8 % R), smoothed to 3°), in S10⊙ with 1 S10⊙ = 6.61 × 10⁻¹² F⊙,band/sr
(F⊙,B = 1.842, F⊙,R = 1.608 W m⁻² nm⁻¹ from TSIS-1 HSRS).

**At the poles** (5° caps), against Leinert Table 34 (p. 75; stars m_V < 6.5 excluded there, as here):

| pole | Pioneer map B / R | Table 34 Pioneer 10 B / R | our stars V ≥ 6.5 + faint B / R | Table 34 star counts (Roach & Megill pg, Sharov & Lipaeva B, Tanabe blue, red) | remainder B / R |
|---|---|---|---|---|---|
| NGP | 28.3 / 40.2 | 29 / 31 | 22.1 / 25.2 | 24, 21, 26, 41 | 7.8 / 17.4 |
| SGP | 27.4 / 42.0 | 33 / – | 23.4 / 28.1 | 79, 36, –, – | 5.5 / 15.8 |
| NCP | 63.3 / 84.5 | 56 / 77 | 42.9 / 51.6 | 48, 37, 48, 76 | 22.8 / 35.0 |
| SCP | 80.2 / 109.0 | 74 / 94 | 53.6 / 69.9 | 56, 41, –, – | 29.8 / 41.3 |
| NEP | 66.6 / 86.4 | 66 / 82 | 53.5 / 61.1 | 52, 50, 66, 76 | 14.9 / 27.4 |
| SEP | 122.0 / 142.8 | 128 / 125 | 91.6 / 97.0 | 50, 39, –, – | 32.9 / 47.2 |

(S10⊙; the map is averaged over 5°, Table 34 is read from Pioneer 10 isophote maps; SEP lies at the edge of the
LMC, which faintStars resolves: 38.6 S10⊙ of it.) The Gaia-based starlight agrees with the published star counts
where the Milky Way is faint (NGP 22.1 against 21–26 in B), and the map with Table 34 to within 17 % (5° caps
against point readings) except the red NGP (40 vs 31, +30 %). The remainder at the galactic poles, 5–8 S10⊙ in B, is the expected size of diffuse galactic plus
extragalactic light (Leinert Sect. 11–12; ~10 S10⊙ of DGL and ~1 of EBL quoted by Benn & Ellison). In R it is about
twice as large; either extended red emission (the subject of Gordon's thesis, from which the maps come) or a
relative calibration offset between the IPP red channel and our S10⊙ conversion. Not corrected.

**Sky-wide**, median remainder 21.0 S10⊙ in B (5–95 %: 6.8–87) and 35.0 in R (12–157); against Pioneer medians of
73.8 / 100.8 and our stars' 45.8 / 56.7. By galactic latitude (Y, cd/m², median; ≈ S10 via 8.9 × 10⁻⁷ cd/m² per
S10⊙ at solar colour):

| abs(b) | diffuse | faintStars | deep tier (aggregate) |
|---|---|---|---|
| 0–5° | 9.6e-05 (108) | 3.9e-05 (43) | 6.1e-05 (68) |
| 5–10° | 7.7e-05 (86) | 3.8e-05 (43) | 5.6e-05 (63) |
| 10–20° | 4.9e-05 (55) | 1.9e-05 (21) | 3.6e-05 (41) |
| 20–30° | 3.1e-05 (35) | 9.2e-06 (10) | 2.2e-05 (25) |
| 30–50° | 1.8e-05 (21) | 4.4e-06 (4.9) | 1.3e-05 (15) |
| 50–70° | 1.3e-05 (14) | 2.5e-06 (2.8) | 8.1e-06 (9.2) |
| 70–90° | 1.1e-05 (13) | 1.9e-06 (2.1) | 6.5e-06 (7.3) |

**B, R → XYZS.** The remainder is converted with a spectrum I(λ) = a F⊙(λ) (λ / 437 nm)^α: the solar spectrum
tilted by a power law whose α reproduces the R/B ratio (median α = 1.34, i.e. redder than the Sun) and whose B-band
mean gives a. This is an assumption about a spectrum measured at two points (DGL is scattered starlight, roughly
the integrated stellar spectrum reddened; EBL and ERE differ), so the layer is `estimated`, never `derived`, even
though both bands are measured; the two-band tilt pins the colour to first order and the ratio of X, Y, Z within
360–830 nm to a few per cent. Label codes per pixel (`diffuse-o6-label.bin`): 0 = Pioneer-covered (44 128 pixels),
1 = no Pioneer data, filled with the median remainder of covered pixels at the same galactic latitude (2° bands;
4 758 pixels, 9.7 %), 2 = remainder ≤ 0 in B or R, set to 0 (266 pixels).

### 3.4 Total brightness

Sum of illuminances over the whole sphere (Y, lux): bright tier 5.68 × 10⁻⁴, deep tier 3.42 × 10⁻⁴, faintStars
2.12 × 10⁻⁴ — all starlight **1.12 × 10⁻³ lux**, i.e. 430 V = 0 stars or 104 S10 when spread over the sky; the
published value is ≈ 100 S10 (Benn & Ellison 1999, after Roach & Gordon 1973; the M1 bright tier alone held 53 %).
The diffuse remainder adds 4.9 × 10⁻⁴ (44 S10 sky average, dominated by the Milky Way plane). A surface facing an
average hemisphere receives a quarter: 2.8 × 10⁻⁴ lux of starlight and 4.0 × 10⁻⁴ lux with the diffuse light,
outside any atmosphere and zodiacal cloud.

## 4. Zodiacal light (`sky/zodiacal.json`)

### 4.1 At 1 AU: Leinert Table 16 (measured)

Table 16 (p. 36) is transcribed in `sky_tables/leinert_1998_table16.csv` (182 values, 8 blank cells near the Sun
kept null). Transcription check: Table 17 (the same map in 10⁻⁸ W m⁻² sr⁻¹ µm⁻¹), transcribed separately, equals
1.28 × Table 16 to ≤ 1.2 % in every cell (three-digit rounding) with the same blanks; every row falls with
latitude. Stated errors 10–15 S10⊙ at low values, 5–10 % at high values (p. 38).

**Colour (derived).** Per 1 S10⊙ = 6.61 × 10⁻¹² F⊙/sr, with F⊙ from TSIS-1 HSRS times Leinert's adopted
reddening f_co(λ) = 1 + s log₁₀(λ / 500 nm) (Eq. 22, p. 41):

| per S10⊙ | X | Y (cd/m²) | Z | S (scotopic cd/m²) |
|---|---|---|---|---|
| solar colour | 8.62e-7 | 8.90e-7 | 9.29e-7 | 2.114e-6 |
| elongation 30° | 8.96e-7 | 9.23e-7 | 8.83e-7 | 2.104e-6 |
| elongation ≥ 90° | 8.87e-7 | 9.15e-7 | 8.94e-7 | 2.106e-6 |

The ecliptic pole, 60 S10⊙, is 5.5 × 10⁻⁵ cd/m² = 23.3 V mag/arcsec² (1 S10 = 27.78 mag/arcsec², Leinert
Table 2). Derived rather than measured: f_co is Leinert's smoothed fit to scattered colour measurements.

### 4.2 Elsewhere: Kelsall cloud with a fitted visible phase function (estimated)

The Kelsall et al. (1998) DIRBE model gives the dust (cross-section) density anywhere inside 5.2 AU: smooth cloud,
three dust-band pairs, circumsolar ring, Earth-trailing blob (Table 1, Eqs. 3–9; `sky_tables/kelsall_1998.json`,
re-implemented in `sky_zodi.py`; the density is labelled `derived`). Its albedos and phase functions are for
1.25–3.5 µm, so the visible ones were obtained from optical measurements: Kelsall's own phase-function form
Φ(Θ) = N [C0 + C1 Θ + exp(C2 Θ)] (their Eq. 2, which they chose because it reproduces Hong's 1985 visible phase
function) with C0, C1, C2 and one albedo fitted by weighted least squares (σ = √(12.5² + (0.075 I)²) S10⊙, the
table's errors) to all 182 cells of Table 16, the model averaged over the Earth's orbit (12 positions, ±β,
±(λ − λ⊙)) as the table is. Hong (1985) itself could not be retrieved.

| fitted | value |
|---|---|
| albedo | 0.218 (Kelsall's 1.25 µm value 0.204) |
| C0, C1, C2 | −0.0976 sr⁻¹, 0.0761 rad⁻¹ sr⁻¹, −2.0 rad⁻¹ (N = 0.652) |
| Φ at 0°, 30°, 60°, 90°, 180° (sr⁻¹) | 0.588, 0.191, 0.069, 0.043, 0.093 |
| fit | rms of ln(model / table) 11.6 %, max 28 %, reduced χ² 0.97 |

| region | model / table, median (range) |
|---|---|
| elongation ≤ 30°, abs(β) ≤ 15° | 1.06 (0.89–1.23) |
| ecliptic, λ − λ⊙ 35–120°, abs(β) ≤ 15° | 1.00 (0.91–1.19) |
| β 20–30° | 0.98 (0.90–1.08) |
| β 45°, 60°, 75° | 0.83, 0.81, 0.83 (0.75–1.04) |
| Gegenschein, λ − λ⊙ ≥ 150°, abs(β) ≤ 10° | 0.96 (0.89–1.01) |
| ecliptic pole (60 ± 3) | 57.8 S10⊙ |

The ~17 % deficit at high latitudes is the Kelsall vertical profile, which the fit does not change; at the Earth
the renderer should use the table (measured), the model is for other positions.

**Checks against measurements the fit did not use** (heliocentric dependence, Leinert Eqs. 15 and 17): seen from R
in the ecliptic at 90° elongation, the model falls as R^−2.23 between 0.3 and 1 AU (Helios: R^−2.3±0.1) and
R^−2.62 between 1 and 3.3 AU (Pioneer 10: R^−2.5±0.2); at the ecliptic pole R^−2.28 and R^−2.39. From Mars (1.52 AU)
it gives 67 S10⊙ at 90° elongation (198 at 1 AU) and 21 at the pole (58); at 3.3 AU 8.7 and 3.3; zero beyond 5.2 AU
(Kelsall's integration limit; Pioneer 10 no longer detected zodiacal light beyond ~3.3 AU).

## 5. Open issues

* **Pioneer red channel:** the remainder at the galactic poles is ~2× larger in R than in B (§3.3) and the
  high-pass regression finds star structure at 0.74 (B) / 0.82 (R) of our prediction; beam shape, ERE and the
  IPP/S10⊙ calibration are not separated. Matsuoka et al. (2011, ApJ 736, 119) re-analysed the same data with
  better star subtraction and would be the next check.
* **Toller's removed stars** are modelled by catalogue size (V < 6.81); the exact list is not available.
* **Sub-degree DGL structure:** the diffuse layer has 3° resolution. Shaping it with a dust map (Planck) at a
  DGL/100 µm ratio would add structure but is an extra assumption; not done.
* **Pioneer gaps** (9.7 %) are filled by latitude medians (label code 1).
* **Zodiacal model at high ecliptic latitude** runs ~17 % below Leinert; the phase function and albedo are single
  values for all dust components.
* **XP wavelengths** are used as vacuum without the Edlén conversion the light stage applies (< 0.1 % in Y); the
  Pioneer bands are top-hats.
* **Deep-tier flags** 1 (variable) and 2 (multiple) are not evaluated (0), as the header says.
* **Gaia DR4** (2 Dec 2026): add its `RELEASES` entry from the released data model, then rebuild `stars`,
  `deepstars`, `sky`.
