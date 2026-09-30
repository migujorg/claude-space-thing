# M4 "the real sky" — report (data side §1–4, rendering §5)

Stages `deepstars` and `sky` (pipeline/src/pipeline/stages/), after `stars`. Products in app/public/data:

| product | content | size | labels |
|---|---|---|---|
| `stars/deep.json` + `stars/deep-o3-000…767.bin` | Gaia DR3 stars 10 ≤ G < 14 not in the bright tier, 48-byte records, 768 HEALPix order-3 tiles, brightest first | 785 MB + 0.3 MB | light: derived 15 232 820, estimated 1 129 217; position: derived 16 259 844, estimated 102 193 |
| `sky/faint-stars-o8.bin` | radiance XYZS of all 1.79 × 10⁹ Gaia sources with G ≥ 14, HEALPix order 8 | 12.6 MB | estimated |
| `sky/diffuse-o6.bin` (+ `-label.bin`) | Pioneer 10/11 sky minus all stars: diffuse galactic light + EBL + stars below Gaia, order 6, 3° resolution | 0.8 MB | estimated |
| `sky/deep-aggregate-o8.bin` | the deep tier summed per pixel (level of detail, not additive) | 12.6 MB | estimated (92.4 % of its Y from XP-derived records) |
| `sky/deep-remainder-o7.bin` | the deep-tier light not held as points when each order-3 tile is read to prefix k: 4 slices (k = 0: all; 1–3: records below `prefixY[k−1]`), HEALPix order 7 | 12.6 MB | estimated (as deep-aggregate) |
| `sky/diffuse.json` | `SkyMapsFile` header: projection, units, methods, sources, stats | 8 kB | |
| `sky/zodiacal.json` | Leinert 1998 zodiacal light at 1 AU + Kelsall 1998 cloud with a fitted visible phase function | 10 kB | at 1 AU measured; colour derived; elsewhere estimated |
| `stars/bright.*` (rebuilt) | 50 more bright stars lit by measured spectrophotometry (Sternberg), incl. Aldebaran, Spica, Polaris | 23.9 MB | derived 437 677, estimated 44 781 |

Products total 0.85 GB (budget 1.5 GB). Raw downloads: `data/raw/stars` 2.6 GB (of which the new deep-tier FITS
1.1 GB and archive sums 0.1 GB) + `data/raw/sky` 12 MB, under the 3 GB budget; the all-sky XP reductions (1.1 GB)
are a cache (`data/cache/stars/xp_reduced/`). New schema types (additive, `app/src/data/schema.ts`):
`TiledBinaryTableHeader`, `StarTile`, `HealpixMapLayer`, `SkyMapsFile`, `ZodiacalLightModel`; rows added to
docs/architecture.md §6. Sources: docs/sources/gaia-dr3.md (new sections), pioneer-ipp.md, zodiacal-light.md,
star-spectrophotometry.md (Sternberg).

Build time with everything cached: `deepstars` 163 s, `sky` 121 s. The first build also runs:
- 192 deep-tier TAP queries (27 min) and 3 × 48 aggregation queries (10–19 min each).
- The XP spectra, by one of two routes (`docs/reports/stars.md` §8). The routes give bit-identical reductions and
  byte-identical `stars/deep-*` products.
  - Default: those of the 15.3 M deep-tier sources are fetched by source_id from ARI Heidelberg's Gaia TAP service
    and reduced on the fly (3158 queries, 21 GB, ≈ 55 min at 4 queries at a time).
  - `stars.xpSource=bulk`: all 114 GB of bulk files are streamed and reduced (76 min).

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

15 303 880 sources (93.5 %) have XP spectra (every source flagged `has_xp_sampled` was found, in the bulk files and in ARI's table alike);
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
| ecliptic pole (60 ± 3) | 53.1 S10⊙ averaged over the year (57.8 with the Earth at heliocentric longitude 180°, 47.7 at 0°: the cloud's symmetry plane is tilted) |

The ~17 % deficit at high latitudes is the Kelsall vertical profile, which the fit does not change. The renderer
uses the model for every observer, the Earth included (§5.3): one continuous model rather than a switch to the
measured table at 1 AU, at the cost of these residuals.

**Checks against measurements the fit did not use** (heliocentric dependence, Leinert Eqs. 15 and 17): seen from R
in the ecliptic at 90° elongation, the model falls as R^−2.23 between 0.3 and 1 AU (Helios: R^−2.3±0.1) and
R^−2.62 between 1 and 3.3 AU (Pioneer 10: R^−2.5±0.2); at the ecliptic pole R^−2.28 and R^−2.39. From Mars (1.52 AU)
it gives 67 S10⊙ at 90° elongation (198 at 1 AU) and 21 at the pole (58); at 3.3 AU 8.7 and 3.3; zero beyond 5.2 AU
(Kelsall's integration limit; Pioneer 10 no longer detected zodiacal light beyond ~3.3 AU).

## 5. Rendering (app)

### 5.1 What draws what

| module | role |
|---|---|
| `app/src/data/sky.ts` | lists the products (`load.ts` → `loadSkyHeaders`: deep tiles `on-demand`, maps deferred), loads the three maps with size checks; `DeepTiles` reads the brightest-first prefix of a tile that a view needs by HTTP Range |
| `app/src/app/sky.ts` | `SkyController`, once per frame before `renderer.render`: sets the point/sky cut from the renderer's limiting magnitude, plans and streams deep tiles for the view, rebuilds the point list and the binned-star map, switches layers by reality level; CPU twins for verification (`probe`, `checkCube`, `checkZodiacal`); star picking and the inspector's facts |
| `app/src/render/sky/background.ts` | `SkyBackground`: GPU composition of the maps into a cube map with mips, the zodiacal grid (compute), the background pass into EXT |
| `app/src/render/sky/zodiacal.ts` | the Kelsall cloud with the fitted visible scattering: CPU line-of-sight integral and its generated WGSL twin |
| `app/src/render/sky/healpix.ts` | HEALPix NESTED `vec2pix` / `pix2vec` in TypeScript and WGSL |
| `app/src/ui/starCard.ts` | inspector card for a clicked star, bright or deep tier |

The renderer hook is `setBackground(hook)`: the renderer calls `hook.encode(encoder, { ext, depth, frameUB, W, H,
snapshot })` right after the bodies pass (an import, a field, a setter and the call in renderer.ts;
`debugSkip=background` turns it off). Without a GPU device no controller is made and the bright catalogue goes to
`setStars` as before.

### 5.2 Points or sky light

A star is a point when v = max(Y, S/1.408) (the renderer's visibility proxy) reaches E(V_cut), with V_cut = V_lim +
0.75 mag rounded to 0.25 mag and V_lim the renderer's limiting magnitude of the last frame. The cut moves only when
its target is 0.5 mag or more away, so adaptation drift does not rebuild every frame. Every other catalogue star —
bright tier or loaded deep record — is summed into an order-8 HEALPix radiance map (0.23° pixels) that the background
draws. The deep tier is read per order-3 tile only to the first prefix k with prefixY[k] ≤ E(V_cut)/3 (no later
record can reach the cut: v ≤ 3 Y for the bluest stars), and the `deepRemainder` slice k supplies the light of the
records not read (slice 0 for a tile not read, nothing for a complete one). Each star's light is therefore in
exactly one place: a point, the binned map, a remainder slice, or `faintStars` (G ≥ 14).

Tiles are wanted when their centre is within the view's half-diagonal + tile radius + 5°, nearest first, four
requests at a time, each finished read starting the next. Above 3 × 10⁶ records in memory (144 MB) tiles out of
view are evicted, least recently seen first, and tiles more than 45° outside the view for 10 s are unloaded
regardless (their light returns to remainder slice 0). A rebuild (point upload + cube recomposition) waits until
the view's tiles are in, or runs every 3 s while they stream.

### 5.3 Background pass

The maps are composed on the GPU into a cube map (512² per face, 256² on software adapters; rgba16float in µcd/m²):
each texel is the mean of 12 samples on a Vogel disc of about one source pixel (radius 0.16° for faintStars, 0.32°
for the binned stars and the remainder, 0.82° for the 3°-resolution diffuse layer), and a mip chain is built. The
background pass draws a full-screen triangle behind the bodies (depth test) and samples the cube at LOD
log2(pixel angle / texel angle), so the sky is filtered to the pixel's footprint at any field of view. It adds to
EXT pre-exposed like every other light, so the sky enters the adaptation measurement, the veil and every point's
local background. The cube is recomposed only when the binned stars, tile levels or layer switches change.

Zodiacal light is integrated for one ray per 16 × 16 pixels (compute pass, redone when the observer moves or the
view turns) and interpolated bilinearly. Each ray: 24 midpoint steps over the first 0.3 AU (dust at the observer),
then 64 steps in t with s = s_ca + h sinh(t), which crowds samples at the closest approach to the Sun, out to
5.2 AU from the Sun. Heliocentric ecliptic coordinates come from ICRF by the IAU 2006 obliquity, and the
Earth-trailing blob follows the Earth's mean longitude (Standish). Colour: the `s10ToXYZS` vectors interpolated in
solar elongation. The model is used for every observer, the Earth included (the table itself is not drawn; the fit
reproduces it to 12 % rms).

### 5.4 Screenshots and statistics

`app/scripts/sky-shots.mjs` (Vite + headless Chromium, WebGPU on SwiftShader, so the 256² cube; 1280 × 720;
`smallbodies=0`, because the GPU small-body field makes a SwiftShader frame take minutes). All at
2026-06-21T00:00Z. The Earth views are from 10⁶ km on the Earth's night side, so the Earth eclipses the Sun.

| view | V_lim | adaptation (cd/m²) | cut V | points, bright + deep | drawn, bright + deep | image |
|---|---|---|---|---|---|---|
| eye, galactic centre, 60° field | 5.82 | 3.2 × 10⁻⁴ (scotopic, m = 0) | 6.75 | 23 142 + 0 (459 316 bright binned; no tile needed) | 2 670 + 0 | `img/sky-gc-eye.png` |
| enhanced +3 stops, same view | 8.09 | 3.1 × 10⁻⁴ | 9.0 | 236 143 + 39; binned 246 315 + 277 318 (286 tiles to prefix 0, 12.7 MiB) | 27 843 + 7 | `img/sky-gc-enhanced3.png` |
| eye, ecliptic 50° from the Sun | 4.99 | 4.2 × 10⁻³ (m = 0.08) | 5.75 | 7 750 + 0 | 712 | `img/sky-ecliptic-earth.png` |
| eye, from Neptune (30 AU), ecliptic 50° from the Sun | 6.07 | 1.9 × 10⁻⁴ | 6.75 | 23 142 + 0 | 2 412 | `img/sky-ecliptic-30au.png` |
| enhanced +6, 20° field in UMa (210°, +55°), from 30 AU | 11.48 | 2.3 × 10⁻⁵ | 12.25 | 480 272 + 212 275; binned 2 186 + 379 297 (102 tiles in memory, 591 572 records, 32 MiB fetched) | 3 880 + 23 154 | `img/sky-deep-uma-enhanced6.png` |
| enhanced +6, 20° field at the galactic centre | 10.19 | 4.9 × 10⁻⁴ | 11.0 | 472 147 + 159 783; binned 10 311 + 1 000 196 (102 tiles, 1.16 M records; 125 MiB fetched while turning) | 13 618 + 32 345 | not kept (the core saturates at +6) |

* **Eye mode:** the Milky Way is a faint band with its dark lanes, below the brightest stars, as a dark-adapted
  eye sees it. The galactic centre pixel holds 666 S10⊙ = 5.9 × 10⁻⁴ cd/m²: diffuse 383, deepRemainder 93,
  faintStars 42 and the zodiacal light near the gegenschein 148 S10⊙.
* **Enhanced +3:** V_lim rises by 2.27 mag, i.e. 2.5 log₁₀ 8. The cut crosses the top of the deep tier, the view's
  tiles stream to prefix 0 (G ≤ 11.2), and the first deep points appear.
* **Ecliptic from the Earth:** the zodiacal cone brightens toward the eclipsed Sun. At the view centre
  (ε = 50.3°, β = 0) it is 559 S10⊙; Table 16, interpolated, gives 577 (−3 %). At ε = 20.2° it is 4 960 against
  5 000 (−1 %). At the galactic poles (β ±29.8°, λ − λ⊙ ±90°) it is 97 and 102 against 103. The dark dot right of
  centre is the Moon, nearly new as seen from behind the Earth: bodies hide the sky behind them.
* **From 30 AU:** no zodiacal light in the view (0 at the centre; the brightest grid ray, toward the inner system,
  2 S10⊙). The glow at the upper right is the Sun, about 4° outside the frame.
* **Deep tier:** at +6 stops the 20° field shows 23 154 deep-tier stars as points. At this exposure the 3°
  diffuse layer's structure is visible, including zero-clamped pixels (label code 2, §3.3) as dark 3° patches
  around a few bright stars.
* **Inspector:**
  * A click on a deep star (`sky.pickStar` + `facts`, as the card shows it) gives "Gaia DR3 791001554222619136,
    V ≈ 9.59, RA 177.8594°, Dec +50.5386°". Its position, flux and colour are `derived`, with the position route
    (2-parameter solution + Tycho-2 proper motion), the light route (XP sampled spectrum), its flag (2-parameter
    solution) and five sources.
  * A bright star gives "Sirius · α CMa · 9 CMa, HIP 32349, RA 101.2829°, Dec −16.7252°", with light from CALSPEC.

**Galactic poles against Leinert Table 34** (5° caps, S10⊙ from Y with 8.90 × 10⁻⁷ cd/m² per S10⊙; Table 34
excludes stars brighter than V = 6.5, and so do these sums):

| pole | faintStars | diffuse | deepRemainder | binned stars | points V ≥ 6.5 | sky, no zodiacal light | Table 34 Pioneer 10 B / R | of which stars | Table 34 star counts |
|---|---|---|---|---|---|---|---|---|---|
| NGP, eye (cut 6.75, no tiles) | 2.0 | 13.0 | 8.2 | 10.4 | 2.5 | **36.2** | 29 / 31 | 23.2 | 24, 21, 26, 41 |
| NGP, enhanced +3 (cut 9, tiles to prefix 0) | 2.0 | 13.0 | 5.3 | 4.8 | 11.1 | **36.2** | | 23.2 | |
| SGP, eye | 2.2 | 10.0 | 9.1 | 11.0 | 2.8 | **35.2** | 33 / – | 25.2 | 79, 36, –, – |
| SGP, enhanced +3 | 2.2 | 10.0 | 9.1 | 2.3 | 11.7 | **35.3** | | 25.3 | |

The sum does not depend on where the split falls: light moves between points, binned stars and remainder slices
but is neither lost nor counted twice. Against Table 34 the rendered sky is 17–25 % brighter at the NGP (Y lies
between the B and R channels, and our Pioneer map is itself 30 % above Table 34 in R there, §3.3) and 7 % brighter
at the SGP. The starlight alone is 23.2 S10⊙ at the NGP (blue star counts 21–26) and 25.2 at the SGP (Sharov &
Lipaeva 36). Seen from the Earth the
zodiacal light (97–102 S10⊙) triples it: 1.2 × 10⁻⁴ cd/m² = 22.5 V mag/arcsec² at the poles. From 30 AU,
3.0 × 10⁻⁵ cd/m² = 24.0.

**GPU against the CPU twins** (every run):
* **Zodiacal grid:** it equals `losBrightness` + `zodiXYZS` at five grid points per view to ≤ 3 × 10⁻⁵
  (float32).
* **Cube, coarse mip:** at mip 4 (5.6° texels) against a CPU cap of the same area, seven directions agree to
  −9…+10 % (galactic centre +0.03 %, poles +7 %). The flux survives the composition and the mip chain, and the face
  convention is right; a wrong face or axis would be off by factors.
* **Cube, mip 0:** against a 0.5° cap it differs by −3…+18 % in eye mode and −1…+10 % at cuts ≥ 9. At the
  ecliptic run's cut 5.75 it reaches −12…+57 % (Orion): single binned stars of V ≈ 6 are spread over a 0.32° disc
  on the GPU, and the CPU cap samples pixel centres.
* **Zodiacal model:** the CPU twin reproduces the pipeline's Python model (`sky_zodi.brightness_s10`) to
  10⁻⁴ at the test cells. The annual means from 1 AU against Table 16:

| λ − λ⊙, β | 20°, 0 | 30°, 0 | 45°, 0 | 60°, 0 | 90°, 0 | 120°, 0 | 150°, 0 | 180°, 0 | 30°, 30° | 90°, 30° | 180°, 30° | 90°, 60° | 180°, 45° | pole |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| model / table | 1.11 | 1.06 | 1.07 | 1.00 | 0.97 | 1.00 | 1.01 | 0.89 | 0.96 | 0.94 | 0.93 | 0.91 | 0.94 | 0.89 (53.1 / 60) |

(`app/tests/sky-zodiacal.test.ts` checks these cells to |ln| < 0.3 and rms < 0.15, together with the pole, the
radial exponents (R^−2.2 inside 1 AU, R^−2.6 to 3.3 AU), zero at 30 AU, 60 S10⊙ = 5.5 × 10⁻⁵ cd/m² and quadrature
convergence to 2 %.)

### 5.5 Cost

* **Memory:** a deep-tier record is 48 bytes, capped at 3 × 10⁶ in memory. The two +6 fields held 0.6 and 1.2
  million records.
* **Rebuild** (split, binning, point upload): CPU, on the main thread. It took 0.8 s for 0.6 M deep records and
  1.2 s for 1.2 M on the loaded test machine, and runs only when the cut moves by 0.5 mag or tiles arrive.
* **Cube recomposition and the zodiacal grid:** on the GPU, only on those events (composition) or on a view or
  observer change (grid). In the runs: 4–15 compositions and 13 grid updates per load.
* **SwiftShader:** frames took 22–34 s on 4 shared CPUs. No hardware-GPU timing was taken.

## 6. Open issues

* **Pioneer red channel:** the remainder at the galactic poles is ~2× larger in R than in B (§3.3) and the
  high-pass regression finds star structure at 0.74 (B) / 0.82 (R) of our prediction; beam shape, ERE and the
  IPP/S10⊙ calibration are not separated. Matsuoka et al. (2011, ApJ 736, 119) re-analysed the same data with
  better star subtraction and would be the next check.
* **Toller's removed stars** are modelled by catalogue size (V < 6.81); the exact list is not available.
* **Sub-degree DGL structure:** the diffuse layer has 3° resolution. Shaping it with a dust map (Planck) at a
  DGL/100 µm ratio would add structure but is an extra assumption; not done.
* **Pioneer gaps** (9.7 %) are filled by latitude medians (label code 1).
* **Zodiacal model at high ecliptic latitude** runs below Leinert: 4–12 % in the annual means at the test cells
  (§5.4; ecliptic pole 53.1 against 60) and up to ~17 % in the medians of §4.2. The phase function and albedo are
  single values for all dust components. The renderer draws the model at the Earth too, not the measured table.
* **XP wavelengths** are used as vacuum without the Edlén conversion the light stage applies (< 0.1 % in Y); the
  Pioneer bands are top-hats.
* **Deep-tier flags** 1 (variable) and 2 (multiple) are not evaluated (0), as the header says.
* **Gaia DR4** (2 Dec 2026): add its `RELEASES` entry from the released data model, then rebuild `stars`,
  `deepstars`, `sky`.
* **Points the renderer culls** (V_lim < V < V_cut, a 0.25–1.25 mag band) are in neither the point list nor the
  sky map, so their light is lost while they are invisible. At the NGP in eye mode the points fainter than V 6.5
  carry 2.5 of 36 S10⊙. The renderer's cull could hand them to the background, or the controller could bin by the
  renderer's per-star verdict.
* **Rebuilds run on the main thread:** 0.8–1.2 s for 0.6–1.2 M deep records, once per cut change or batch of tiles.
  A worker would remove the stall.
* **Deep tiles are read by HTTP range and not sha256-verified** (the manifest hash covers whole files). Sizes are
  checked, and the Data panel says so.
* **The 3° diffuse layer at high exposure:** its per-pixel noise (Pioneer's 2–3 S10⊙) and zero-clamped pixels show
  as blotches and dark 3° patches at +6 stops.
* **SwiftShader:** screenshots use a 256² cube and `smallbodies=0`. No frame timing on a hardware GPU yet.
