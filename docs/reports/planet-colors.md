# Planet, moon and ring photometry: review report

Generated 2026-09-30 by `cd pipeline && uv run python -m pipeline.photometry.report`, from the same code as the `light` stage (`app/public/data/light.json`, `photometry.json`, `rings.json`). All numbers below are computed, not typed; the prose is written by hand. Sources are listed in `sources.json` and `docs/sources/`.

## How to read the colours

- **Chromaticity (x, y)**: CIE 1931 2° chromaticity of sunlight reflected by the body at zero phase, i.e. of K∫p(λ)E☉(λ)cmf(λ)dλ (docs/architecture.md §4.3).
- **Display colours are renderings for human review, not what the app shows** (the app's eye model does adaptation). *Equal exposure*: XYZ is divided by the Sun's Y, so a perfectly white Lambertian disk facing the Sun would be display white; the display luminance is then the photopic geometric albedo p_Y and the bodies keep their relative brightness. XYZ → linear sRGB with the IEC 61966-2-1 matrix (colour-science 0.4.7); **gamut mapping: per-channel clip of linear RGB to [0, 1]**, then the sRGB transfer function. "*" marks a colour that needed clipping.
  - *no adaptation*: display white is D65, so sunlight itself renders slightly warm.
  - *sun-adapted*: Bradford chromatic adaptation from sunlight's white point to D65, i.e. an observer adapted to sunlight (sunlight renders neutral grey-white). This is closer to what an eye in space would report.
  - *hue swatch*: the sun-adapted colour scaled so its largest channel is 1 (brightness removed; judge hue only).

## Sunlight at 1 AU (TSIS-1 HSRS v2)

| quantity | value |
|---|---|
| X, Y, Z | 130407, **134647 lux**, 140481 |
| scotopic S | 319825 scotopic lux (S/P = 2.375) |
| chromaticity x, y | 0.3216, 0.3320 |
| spectrum integral 202-2730 nm | 1325.76 W/m² = 97.4 % of TSI 1361 W/m² (IAU 2015 B3); the rest is outside the covered range |
| 360-830 nm integral | 739.39 W/m² |
| display (no adaptation, Y=1) | `#FFFDFA` |
| independent check | WHI 2008 reference spectrum (Woods et al. 2009; SORCE SIM) gives Y = 133 001 lux, (0.3212, 0.3321): HSRS is 1.2 % higher in Y, same chromaticity to 0.0004 (tests/test_light_solar.py) |

Y = 1.346e5 lux is slightly above the often-quoted 1.2-1.3e5 lux; it is what the TSIS-1 absolute scale gives (older SORCE-era spectra give 1.33e5). Not tuned.

## Solar limb darkening per channel (Neckel & Labs 1994)

I(μ)/I(1) = Σ c_k μ^k. Continuum coefficients (30 wavelengths) weighted by the disk-centre spectrum and each observer function; see `light.json` method for assumptions.

| channel | c0 | c1 | c2 | c3 | c4 | c5 | F/I (disk mean / centre) |
|---|---|---|---|---|---|---|---|
| X | 0.27097 | 1.34070 | -1.63787 | 2.07196 | -1.47192 | 0.42615 | 0.8057 |
| Y | 0.26689 | 1.32730 | -1.53036 | 1.83770 | -1.25128 | 0.34975 | 0.8045 |
| Z | 0.16857 | 1.31664 | -1.26493 | 1.57778 | -1.12644 | 0.32837 | 0.7633 |
| S | 0.21618 | 1.31236 | -1.31334 | 1.51022 | -0.99525 | 0.26985 | 0.7838 |

Refit of the channel-integrated profiles with a 5th-order polynomial on 201 μ samples: max residual 2.5e-13 (a weighted mean of quintics is a quintic). Value at μ = 1: 0.999999, 1.000001, 0.999997, 1.000002 (Table I is rounded to 5 decimals).

## Bodies

| body | x | y | p_V | p_Y | display, no adaptation | display, sun-adapted | hue swatch | albedo label | phase label | spectrum from |
|---|---|---|---|---|---|---|---|---|---|---|
| Mercury | 0.3489 | 0.3550 | 0.137 | 0.139 | `#73665A` | `#6F675C` | `#FFEED6` | estimated | measured | Payne+2026 (MASCS) |
| Venus | 0.3321 | 0.3540 | 0.683 | 0.680 | `#DDD7C1` | `#D5D9C5` | `#FAFFE8` | estimated | measured | Payne+2026 (VIRS) |
| Earth | 0.2967 | 0.3062 | 0.216 | 0.213 | `#7D7F8C` | `#78808F` | `#D8E6FF` | estimated | estimated | Payne+2026 (PSG model) |
| Moon | 0.3643 | 0.3591 | 0.128 | 0.132 | `#766254` | `#726356` | `#FFDFC3` | estimated | estimated | Lane & Irvine 1973 |
| Mars | 0.4092 | 0.3867 | 0.168 | 0.177 | `#926E4C` | `#8F6F4F` | `#FFC891` | estimated | estimated | Mallama+2017 UBVRI |
| Jupiter | 0.3333 | 0.3501 | 0.528 | 0.528 | `#C8BFAE` | `#C1C1B2` | `#FFFFEB` | estimated | measured | Karkoschka 1998 |
| Saturn | 0.3564 | 0.3679 | 0.472 | 0.479 | `#CAB597` | `#C3B79A` | `#FFEFCA` | estimated | estimated | Karkoschka 1998 |
| Uranus | 0.2871 | 0.3226 | 0.524 | 0.506 | `#A5C2C7` | `#9DC3CB` | `#C6F6FF` | derived | measured | Karkoschka 1998 |
| Neptune | 0.2717 | 0.3060 | 0.449 | 0.430 | `#90B5C5` | `#88B6CA` | `#AEE7FF` | derived | measured | Karkoschka 1998 |
| Pluto | 0.3574 | 0.3598 | 0.555 | 0.566 | `#DEC1A7` | `#D7C3AB` | `#FFE7CB` | estimated | measured | Buie+2010 B, V |

p_V: Bessell V band average of p(λ) (reported as `geometricAlbedoV`); p_Y: photopic (ȳ-weighted) geometric albedo = Y/Y☉. All albedos referenced to the pck00011 volumetric mean radius.

### Per-body data and weaknesses

- **Mercury** (199). Spectral shape: MESSENGER/MASCS global-mean reflectance (Izenberg et al. 2014) as composited and scaled by Payne et al. (2026) to Mallama et al.'s (2017) broadband albedos. It is a disk-resolved, photometrically standardized spectrum, not a zero-phase disk integral, so phase reddening is not removed; the colour is probably slightly too red, the level is good to ~3 %. Phase curve: SOHO/LASCO + ground (measured). Sources: `payne-2026-mercury`, `naif-pck00011`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`, `mallama-hilton-2018`.
- **Venus** (299). Spectral shape: MESSENGER/VIRS equatorial-cloud I/F (Pérez-Hoyos et al. 2018) scaled to p_V = 0.689. This is WEAK in the blue: below ~480 nm it is 20 % below Mallama's photometric B albedo, but Mallama's own synthetic B agrees with it. Venus's hue (how yellow) is therefore uncertain; its brightness is not. (Older disk-integrated data, Irvine 1968 and Barker 1975, lie between the two in Payne et al.'s compilation, their Fig. 3.) Phase curve: SOHO + ground (measured). Sources: `payne-2026-venus`, `naif-pck00011`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`, `mallama-hilton-2018`.
- **Earth** (399). Spectral shape and level: a radiative-transfer MODEL (PSG with MERRA-2 clouds for 2022 June 21) validated against DSCOVR/EPIC; no machine-readable measured whole-disk zero-phase visible spectrum was reachable (the EPIC L1B granules are in NASA Earthdata Cloud behind Earthdata Login; see 'Fix-ups' below). Its p_V = 0.22 is half of Mallama et al.'s 0.434 (used by Mallama & Hilton and Horizons). A simple check favours the low value: for a disk of mean reflectance factor ⟨R⟩ seen at zero phase p ≈ ⅔⟨R⟩, and Earth's ⟨R⟩ ≈ Bond albedo ≈ 0.3 gives p ≈ 0.2. The high value comes from EPOXI photometry at 58-77° phase extrapolated to 0° with a model phase curve. Real Earth varies by tens of percent with clouds. Phase curve: model (estimated). Sources: `payne-2026-earth`, `naif-pck00011`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`, `mallama-hilton-2018`.
- **Moon** (301). Albedo: Lane & Irvine (1973) whole-disk narrow-band geometric albedos, interpolated linearly between 9 bands; surge-free (linear extrapolation to 0°). The narrow-band data give a V-band albedo 13 % above the authors' own broadband V (they suspected their broadband transformation) and they flag a possible ~10 % excess at 600-850 nm in the 1965 data; the colour is probably too red (ROLO's is less red, see M3 below). Phase curve (M3): the ROLO model (Kieffer & Stone 2005) for 1.55-97°, with the opposition surge, normalized to that albedo, so the brightness there is ROLO's; Lane & Irvine's shape joined to it for 97-120° (estimated). Libration and waxing/waning are in diskReflectanceModel. Sources: `lane-irvine-1973`, `naif-pck00011`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`, `kieffer-stone-2005`.
- **Mars** (499). Reconstructed from Mallama et al. (2017) photometric Johnson UBVRI albedos (rotation/season averaged): a piecewise-linear spectrum through five band averages. Brightness and B-V are measured; the shape between bands is assumed (no 530 nm shoulder). A PSG model composite (Payne et al.) was rejected: its B albedo is 45 % below the photometry. Phase curve: measured to 50°, assumed beyond (estimated). Sources: `mallama-2017`, `svo-johnson-u`, `svo-johnson-b`, `svo-johnson-v`, `svo-johnson-r`, `svo-johnson-i`, `naif-pck00011`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`, `mallama-hilton-2018`.
- **Jupiter** (599). Karkoschka (1998) ESO spectrophotometry at 6.8° phase, scaled to 0° with Mallama & Hilton's V phase law (assumption: same at all λ, +2.4 %). Agrees with Mallama et al. (2017) B, V, Rc to ≤ 2 % and with Horizons to 0.02 mag. Strong data. Phase curve: ground + Cassini (measured). Sources: `karkoschka-1998-pds`, `naif-pck00011`, `mallama-hilton-2018`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`.
- **Saturn** (699). Karkoschka (1998) at the 1995 ring-plane crossing, i.e. the GLOBE without rings (what the renderer draws; rings are separate, see Rings). Scaled from 5.7° to 0° with an assumed phase law (+1.7 %). 5 % fainter in V than Mallama & Pavlov's synthetic globe magnitude from the same data, but consistent with Karkoschka's own V. Saturn's globe colour changes with season (hemisphere in view, ring shadow). Phase curve: assumed/modelled (estimated). Sources: `karkoschka-1998-pds`, `naif-pck00011`, `mallama-hilton-2018`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`.
- **Uranus** (799). Karkoschka (1998) 1995 geometric albedo. Uranus's colour changes with season (Irwin et al. 2024): the red albedo in 1995 is 28 % above Mallama et al.'s 2000s photometry, and the 2026 view (near northern solstice) differs from 1995's. Irwin et al.'s calibrated spectra are available only on request, so they could not be used. Phase curve: Voyager (measured). Sources: `karkoschka-1998-pds`, `naif-pck00011`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`, `mallama-hilton-2018`.
- **Neptune** (899). Karkoschka (1998) 1995 geometric albedo; Neptune brightened until ~2000 (3 % in V since 1995 per Mallama & Hilton), red albedo 15 % above Mallama's 2000s photometry. The computed colour is a pale blue close to Uranus's, as Irwin et al. (2024) find, not the deep blue of enhanced Voyager images. Phase curve: Voyager (measured). Sources: `karkoschka-1998-pds`, `naif-pck00011`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`, `mallama-hilton-2018`.
- **Pluto** (999). No machine-usable spectrum of Pluto alone was found (Lorenzi et al. 2016 spectra are figures only; New Horizons disk-integrated colours not tabulated). Reconstructed from HST B and V only (Buie et al. 2010): p linear in λ, extrapolated to 360-830 nm, so the red end is likely too high and the colour too red. Phase curve: 0-1.74° only (HST); unknown beyond, i.e. from any viewpoint far from the Earth-Sun line. Sources: `buie-2010a`, `willmer-2018`, `naif-pck00011`, `bessell-1990-b`, `bessell-1990-v`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`.

## Consistency: albedo, radius and zero-phase magnitude

V(1,0) implied by our p_V and the pck00011 volumetric mean radius R, with V☉ = -26.76 (Willmer 2018): V(1,0) = V☉ − 2.5 log10(p_V (R/AU)²). Compared with the zero-phase magnitude the phase curve is normalized to (Mallama & Hilton 2018; for Mercury the surge-inclusive value). Not adjusted to agree.

| body | R (km) | p_V | V(1,0) ours | V(1,0) published | ours − published | note |
|---|---|---|---|---|---|---|
| Mercury | 2439.8 | 0.1372 | -0.666 | -0.694 | +0.028 | -0.694 (surge-inclusive model; the polynomial's own constant is -0.613) |
| Venus | 6051.8 | 0.6825 | -4.380 | -4.384 | +0.004 | Eq. 3 |
| Earth | 6371.0 | 0.2160 | -3.243 | -3.990 | +0.747 | Mallama et al. 2017 (EPOXI + model phase curve) |
| Moon | 1737.4 | 0.1278 | +0.149 | +0.231 | -0.082 | Lane & Irvine broadband m_V(1,0) = -12.72 at the mean lunar distance (also Horizons' 0.23) |
| Mars | 3389.5 | 0.1676 | -1.597 | -1.601 | +0.004 | Eq. 6, mean over L(λe), L(Ls) |
| Jupiter | 69911.3 | 0.5277 | -9.414 | -9.395 | -0.019 | Eq. 8 |
| Saturn | 58232.0 | 0.4724 | -8.897 | -8.950 | +0.053 | Eq. 11, globe (Mallama & Pavlov synthetic from Karkoschka 1998) |
| Uranus | 25362.2 | 0.5237 | -7.204 | -7.173 | -0.031 | -7.110 − 8.4e-4 φ′ (φ′ ≈ 75° now → -7.173) |
| Neptune | 24622.2 | 0.4488 | -6.972 | -7.000 | +0.028 | Eq. 16, t > 2000 |
| Pluto | 1188.3 | 0.5548 | -0.620 | n/a | n/a | self-consistent (p_V derived from Buie et al. V(1,0)) |

## Band albedos vs Mallama et al. (2017) Table 7

Solar-weighted band averages of our p(λ) through Bessell (1990) B, V and Cousins R, I, vs Mallama et al.'s published albedos (several of theirs are *synthetic*, i.e. from other spectra; see `tables/mallama_2017_table7.csv`). Mars is not an independent comparison (built from Mallama's Johnson bands).

| body | B ours / M17 | V ours / M17 | Rc ours / M17 | Ic ours / M17 |
|---|---|---|---|---|
| Mercury | 0.108 / 0.105 (+3 %) | 0.137 / 0.142 (-3 %) | 0.159 / 0.158 (+0 %) | 0.185 / 0.180 (+3 %) |
| Venus | 0.528 / 0.658 (-20 %) | 0.683 / 0.689 (-1 %) | 0.670 / 0.658 (+2 %) | 0.639 / 0.640 (-0 %) |
| Earth | 0.272 / 0.512 (-47 %) | 0.216 / 0.434 (-50 %) | 0.202 / 0.392 (-49 %) | 0.224 / 0.396 (-43 %) |
| Mars | 0.087 / 0.088 (-1 %) | 0.168 / 0.170 (-1 %) | 0.268 / 0.250 (+7 %) | 0.329 / 0.285 (+15 %) |
| Jupiter | 0.442 / 0.443 (-0 %) | 0.528 / 0.538 (-2 %) | 0.513 / 0.513 (+0 %) | 0.405 / 0.389 (+4 %) |
| Saturn | 0.320 / 0.339 (-6 %) | 0.472 / 0.499 (-5 %) | 0.520 / 0.646 (-19 %) | 0.457 / 0.543 (-16 %) |
| Uranus | 0.578 / 0.561 (+3 %) | 0.524 / 0.488 (+7 %) | 0.338 / 0.264 (+28 %) | 0.119 / 0.089 (+34 %) |
| Neptune | 0.568 / 0.562 (+1 %) | 0.449 / 0.442 (+2 %) | 0.260 / 0.226 (+15 %) | 0.087 / 0.072 (+21 %) |

## Cross-check with JPL Horizons APmag

Apparent V at three epochs in the window, using Horizons' own r, Δ, phase angle α and sub-latitudes (fixtures in `pipeline/tests/fixtures/horizons/`). *M&H* is our reimplementation of Mallama & Hilton (2018) as coded in Ap_Mag_V3 (it reproduces Horizons to ≤ 0.001 mag except Mars, where Horizons adds the rotation and season terms). *ours* = our V(1,0) + 5 log10(rΔ) + our phase function. Earth is seen from Mars.

| body | date (UT) | α (°) | Horizons | M&H | ours | ours − Horizons | note |
|---|---|---|---|---|---|---|---|
| Mercury | 2026-Sep-30 | 55.54 | -0.115 | -0.114 | -0.086 | **+0.029** |  |
| Mercury | 2027-Jan-15 | 21.29 | -1.057 | -1.057 | -1.029 | **+0.028** |  |
| Mercury | 2027-Jun-01 | 114.52 | +0.789 | +0.789 | +0.817 | **+0.028** |  |
| Venus | 2026-Sep-30 | 132.92 | -4.779 | -4.779 | -4.775 | **+0.004** |  |
| Venus | 2027-Jan-15 | 83.34 | -4.421 | -4.421 | -4.417 | **+0.004** |  |
| Venus | 2027-Jun-01 | 27.86 | -3.865 | -3.865 | -3.861 | **+0.004** |  |
| Earth | 2026-Sep-30 | 65.75 | -2.052 | -2.052 | -1.304 | **+0.748** |  |
| Earth | 2027-Jan-15 | 134.17 | -0.926 | -0.926 | -0.179 | **+0.747** |  |
| Earth | 2027-Jun-01 | 86.85 | -1.881 | -1.881 | -1.133 | **+0.748** |  |
| Moon | 2026-Sep-30 | 42.94 | -11.663 | n/a | -11.578 | **+0.085** | Horizons formula not from Mallama & Hilton |
| Moon | 2027-Jan-15 | 100.19 | -9.736 | n/a | -9.680 | **+0.056** | Horizons formula not from Mallama & Hilton |
| Moon | 2027-Jun-01 | 129.58 | -8.207 | n/a | n/a | **n/a** | Horizons formula not from Mallama & Hilton |
| Mars | 2026-Sep-30 | 35.92 | +1.092 | +1.123 | +1.127 | **+0.035** | no L(λe), L(Ls) terms |
| Mars | 2027-Jan-15 | 25.25 | -0.551 | -0.474 | -0.470 | **+0.081** | no L(λe), L(Ls) terms |
| Mars | 2027-Jun-01 | 38.43 | +0.751 | +0.759 | +0.763 | **+0.012** | no L(λe), L(Ls) terms |
| Jupiter | 2026-Sep-30 | 7.99 | -1.868 | -1.868 | -1.888 | **-0.020** |  |
| Jupiter | 2027-Jan-15 | 5.41 | -2.489 | -2.489 | -2.509 | **-0.020** |  |
| Jupiter | 2027-Jun-01 | 10.21 | -1.926 | -1.926 | -1.945 | **-0.019** |  |
| Saturn | 2026-Sep-30 | 0.59 | +0.351 | +0.351 | +0.608 | **+0.257** | β_eff=7.62° (rings in Eq. 10) |
| Saturn | 2027-Jan-15 | 5.78 | +0.768 | +0.768 | +0.903 | **+0.135** | β_eff=7.87° (rings in Eq. 10) |
| Saturn | 2027-Jun-01 | 4.49 | +0.683 | +0.683 | +0.978 | **+0.295** | β_eff=12.15° (rings in Eq. 10) |
| Uranus | 2026-Sep-30 | 2.53 | +5.653 | +5.653 | +5.640 | **-0.013** | φ′=75.0° |
| Uranus | 2027-Jan-15 | 2.30 | +5.641 | +5.641 | +5.625 | **-0.016** | φ′=74.0° |
| Uranus | 2027-Jun-01 | 0.22 | +5.814 | +5.814 | +5.785 | **-0.029** | φ′=76.4° |
| Neptune | 2026-Sep-30 | 0.14 | +7.680 | +7.680 | +7.709 | **+0.029** |  |
| Neptune | 2027-Jan-15 | 1.74 | +7.780 | +7.780 | +7.821 | **+0.041** |  |
| Neptune | 2027-Jun-01 | 1.75 | +7.784 | +7.784 | +7.826 | **+0.042** |  |
| Pluto | 2026-Sep-30 | 1.44 | +14.547 | n/a | +14.740 | **+0.193** | Horizons formula not from Mallama & Hilton |
| Pluto | 2027-Jan-15 | 0.31 | +14.595 | n/a | +14.753 | **+0.158** | Horizons formula not from Mallama & Hilton |
| Pluto | 2027-Jun-01 | 1.36 | +14.558 | n/a | +14.749 | **+0.191** | Horizons formula not from Mallama & Hilton |

What the differences mean:

- **Mercury +0.03, Venus +0.00, Jupiter −0.02, Uranus −0.01…−0.03, Neptune +0.03…+0.04**: agreement at the level of the absolute calibrations (±3-4 %) and of the source epochs (Karkoschka 1995 vs 2000s).
- **Mars +0.01…+0.08**: Horizons includes the rotational and seasonal terms L(λe), L(Ls) (±0.06); our photometry is the rotation/season mean.
- **Earth +0.75**: our Earth is half as bright as Mallama & Hilton's (see the Earth note above). This is the largest open discrepancy; we believe the DSCOVR-validated value, but neither is a clean measurement.
- **Saturn +0.13…+0.30**: Horizons includes the rings for α < 6.5° (Eq. 10); our entry is the globe alone. Against the globe-only Eq. 11 we are +0.05 (see the consistency table).
- **Moon +0.09 (α = 43°), +0.06 (α = 100°), n/a at 130°**: Horizons uses V(1,α) = 0.23 + 0.026α + 4×10⁻⁹α⁴ (Allen's law; our fixtures reproduce it to 0.0002 mag), whose 0.23 equals Lane & Irvine's broadband V. Ours is the ROLO level (to 97°; Lane & Irvine's shape joined to it beyond), averaged over waxing and waning at zero libration; the fixture epochs' libration and waxing/waning (≈ ±5 % at 43°) are not applied in this table. Valid to 120° only.
- **Pluto +0.16…+0.19**: Horizons' Pluto includes Charon, V(1,α) ≈ −1.00 + 0.041α (inferred from the fixtures; the manual does not cite a source); we add Charon from the same HST paper for this comparison. Buie et al.'s 2002-2003 Pluto + Charon is 0.16 mag fainter than Horizons' system magnitude (the radius does not enter this comparison).

## Moons

Same conventions as the planets. Unknown entries carry their reason in photometry.json.

| moon | x | y | p_V | p_Y | display, sun-adapted | hue swatch | albedo label | phase label | phase domain |
|---|---|---|---|---|---|---|---|---|---|
| Phobos | 0.3337 | 0.3489 | 0.082 | 0.082 | `#52514B` | `#FFFDEB` | estimated | measured | 0-100° |
| Deimos | 0.3216 | 0.3320 | 0.080 | 0.080 | `#505050` | `#FFFFFF` | estimated | unknown | unknown |
| Io | 0.3599 | 0.3748 | 0.598 | 0.607 | `#D9CCA6` | `#FFF0C4` | estimated | measured | 0-130° |
| Europa | 0.3323 | 0.3467 | 0.654 | 0.656 | `#D6D4C7` | `#FFFDED` | estimated | measured | 0-130° |
| Ganymede | 0.3312 | 0.3442 | 0.424 | 0.426 | `#B1AFA5` | `#FFFCEF` | estimated | measured | 0-130° |
| Callisto | 0.3345 | 0.3485 | 0.180 | 0.181 | `#78766D` | `#FFFBEA` | estimated | measured | 0-130° |
| Mimas | 0.3196 | 0.3312 | 0.650 | 0.648 | `#D1D3D4` | `#FCFEFF` | derived | estimated | 0-120° |
| Enceladus | 0.3198 | 0.3319 | 0.893 | 0.891 | `#F0F3F3` | `#FCFFFF` | derived | estimated | 0-120° |
| Tethys | 0.3245 | 0.3329 | 0.743 | 0.746 | `#E3DFDF` | `#FFFBFA` | derived | estimated | 0-120° |
| Dione | 0.3222 | 0.3350 | 0.648 | 0.647 | `#D1D3D0` | `#FDFFFC` | derived | estimated | 0-120° |
| Rhea | 0.3244 | 0.3341 | 0.599 | 0.601 | `#CDCBC9` | `#FFFDFA` | derived | estimated | 0-120° |
| Titan | 0.3810 | 0.3837 | 0.216 | 0.223 | `#927F60` | `#FFE0AB` | estimated | estimated | 0-5.7° |
| Iapetus | | | unknown | | | | unknown | unknown | unknown |
| Ariel | 0.3256 | 0.3354 | 0.533 | 0.534 | `#C3C1BE` | `#FFFCF9` | derived | estimated | 0-3.1° |
| Umbriel | 0.3240 | 0.3350 | 0.258 | 0.259 | `#8C8B89` | `#FFFEFB` | derived | estimated | 0-3.1° |
| Titania | 0.3285 | 0.3370 | 0.347 | 0.348 | `#A39F9B` | `#FFF9F4` | derived | measured | 0-3.1° |
| Oberon | 0.3275 | 0.3373 | 0.310 | 0.311 | `#9A9794` | `#FFFBF5` | derived | measured | 0-3.1° |
| Miranda | | | unknown | | | | unknown | unknown | unknown |
| Triton | 0.3404 | 0.3466 | 0.861 | 0.871 | `#FBEEDF` | `#FFF1E2` | estimated | measured | 0-1.26° |
| Charon | 0.3336 | 0.3414 | 0.510 | 0.514 | `#C4BDB5` | `#FFF6EC` | estimated | derived | 0-1.74° |
| Himalia | 0.3216 | 0.3320 | 0.039 | 0.039 | `#373737` | `#FFFFFF` | estimated | estimated | 0-12° |
| Elara | 0.3216 | 0.3320 | 0.046 | 0.046 | `#3C3C3C` | `#FFFFFF` | estimated | estimated | 0-12° |
| Pasiphae | 0.3216 | 0.3320 | 0.113 | 0.113 | `#5E5E5E` | `#FFFFFF` | estimated | estimated | 0-12° |
| Sinope | 0.3216 | 0.3320 | 0.069 | 0.069 | `#4A4A4A` | `#FFFFFF` | estimated | estimated | 0-12° |
| Lysithea | 0.3216 | 0.3320 | 0.113 | 0.113 | `#5E5E5E` | `#FFFFFF` | estimated | estimated | 0-12° |
| Carme | 0.3216 | 0.3320 | 0.085 | 0.085 | `#525252` | `#FFFFFF` | estimated | estimated | 0-12° |
| Ananke | 0.3216 | 0.3320 | 0.081 | 0.081 | `#505151` | `#FFFFFF` | estimated | estimated | 0-12° |
| Leda | 0.3216 | 0.3320 | 0.157 | 0.157 | `#6E6E6E` | `#FFFFFF` | estimated | estimated | 0-12° |
| Phoebe | 0.3216 | 0.3320 | 0.090 | 0.090 | `#555555` | `#FFFFFF` | estimated | estimated | 0-6.5° |

- **Phobos** (401). Four Mars Express HRSC colour albedos (Hapke disk-integrated fits, surge-inclusive) joined piecewise linearly; H-G phase curve over 0-100°. Irregular body: the sphere of mean radius is an approximation. Sources: `fornasier-2024`, `svo-mex-hrsc-blue`, `svo-mex-hrsc-green`, `svo-mex-hrsc-red`, `svo-mex-hrsc-nir`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`.
- **Deimos** (402). Only a panchromatic albedo (0.080) exists in usable form: colour ASSUMED grey (placeholder), phase unknown. Sources: `wargnier-2025`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`.
- **Io** (501). Cassini ISS WAC albedos in 5 filters, joined piecewise linearly; below 420 nm held constant, which overstates Io's violet (its reflectance drops steeply there), so Io may render slightly less yellow than it is. Rotational variation up to 16 % (not represented). Sources: `mayorga-2020`, `svo-cassini-iss-wac-vio`, `svo-cassini-iss-wac-grn`, `svo-cassini-iss-wac-red`, `svo-cassini-iss-wac-cb2`, `svo-cassini-iss-wac-cb3`, `naif-pck00011`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`.
- **Europa** (502). Cassini ISS WAC albedos in 4 filters (no 939 nm); constant beyond 752 nm. Sources: `mayorga-2020`, `svo-cassini-iss-wac-vio`, `svo-cassini-iss-wac-grn`, `svo-cassini-iss-wac-red`, `svo-cassini-iss-wac-cb2`, `naif-pck00011`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`.
- **Ganymede** (503). Cassini ISS WAC albedos in 5 filters. Sources: `mayorga-2020`, `svo-cassini-iss-wac-vio`, `svo-cassini-iss-wac-grn`, `svo-cassini-iss-wac-red`, `svo-cassini-iss-wac-cb2`, `svo-cassini-iss-wac-cb3`, `naif-pck00011`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`.
- **Callisto** (504). Cassini ISS WAC albedos in 3 filters only (VIO, GRN, RED): constant beyond 647 nm, so the red end is unconstrained. Sources: `mayorga-2020`, `svo-cassini-iss-wac-vio`, `svo-cassini-iss-wac-grn`, `svo-cassini-iss-wac-red`, `naif-pck00011`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`.
- **Mimas** (601). Cassini VIMS model albedo a0 at 14 wavelengths (surge excluded). Phase curve: disk integral of the fitted model, 10-120° derived, 0-10° extrapolated without the surge. Sources: `filacchione-2022`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`.
- **Enceladus** (602). As Mimas. Enceladus is the brightest body in the solar system; its known strong opposition surge is NOT in these numbers. Sources: `filacchione-2022`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`.
- **Tethys** (603). As Mimas. Sources: `filacchione-2022`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`.
- **Dione** (604). As Mimas. Sources: `filacchione-2022`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`.
- **Rhea** (605). As Mimas. Sources: `filacchione-2022`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`.
- **Titan** (606). Karkoschka's 1995 full-disk spectrum × 1.02 to zero phase (model-based factor). Phase curve known only 0-5.7° (linear assumption); Titan's strongly forward-scattering Cassini phase curve is published only as figures. Sources: `karkoschka-1998-pds`, `karkoschka-1994-text`, `garcia-munoz-2017`, `naif-pck00011`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`.
- **Iapetus** (608). UNKNOWN: its leading and trailing hemispheres differ hugely in albedo, so any single value misleads; no machine-readable orbital lightcurve was accessible.
- **Ariel** (701). Ground-based disk-integrated spectrum (DeColibus et al. 2026) scaled to Karkoschka's (2001) HST 0.63 µm albedo. Phase curve: Titania/Oberon's (assumed). Sources: `decolibus-2026-data`, `decolibus-2026`, `naif-pck00011`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`.
- **Umbriel** (702). As Ariel. Sources: `decolibus-2026-data`, `decolibus-2026`, `naif-pck00011`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`.
- **Titania** (703). As Ariel; phase curve is Karkoschka's own for Titania/Oberon (strong narrow surge). TMO photometry in the same dataset agrees within 7 %. Sources: `decolibus-2026-data`, `decolibus-2026`, `naif-pck00011`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`.
- **Oberon** (704). As Titania. Sources: `decolibus-2026-data`, `decolibus-2026`, `naif-pck00011`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`.
- **Miranda** (705). UNKNOWN: no accessible disk-integrated photometry.
- **Triton** (801). Two broadband points (p_V, B-V): linear spectrum, extrapolated (estimated). Phase coefficient over 0-1.26° only. Sources: `verbiscer-2022`, `willmer-2018`, `bessell-1990-b`, `bessell-1990-v`, `naif-pck00011`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`.
- **Charon** (901). Buie et al. (2010) HST V and B-V: linear spectrum (estimated). Phase curve from their Hapke fit, 0-1.74°, reproducing their 0.25 mag 1°→0° surge. Sources: `buie-2010a`, `willmer-2018`, `bessell-1990-b`, `bessell-1990-v`, `naif-pck00011`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`.
- **Himalia** (506). Irregular satellite: brightness from the absolute magnitude H (Grav et al. 2015 compilation), colour ASSUMED grey, H-G phase curve with G assumed by the source (0.10) over Earth-based phase angles. p_V is referenced to the (rough, round-number) pck00011 radius, so it differs from the NEOWISE albedo while the brightness is the same. Sources: `grav-2015`, `willmer-2018`, `naif-pck00011`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`.
- **Elara** (507). Irregular satellite: brightness from the absolute magnitude H (Grav et al. 2015 compilation), colour ASSUMED grey, H-G phase curve with G assumed by the source (0.10) over Earth-based phase angles. p_V is referenced to the (rough, round-number) pck00011 radius, so it differs from the NEOWISE albedo while the brightness is the same. Sources: `grav-2015`, `willmer-2018`, `naif-pck00011`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`.
- **Pasiphae** (508). Irregular satellite: brightness from the absolute magnitude H (Grav et al. 2015 compilation), colour ASSUMED grey, H-G phase curve with G assumed by the source (0.10) over Earth-based phase angles. p_V is referenced to the (rough, round-number) pck00011 radius, so it differs from the NEOWISE albedo while the brightness is the same. Sources: `grav-2015`, `willmer-2018`, `naif-pck00011`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`.
- **Sinope** (509). Irregular satellite: brightness from the absolute magnitude H (Grav et al. 2015 compilation), colour ASSUMED grey, H-G phase curve with G assumed by the source (0.10) over Earth-based phase angles. p_V is referenced to the (rough, round-number) pck00011 radius, so it differs from the NEOWISE albedo while the brightness is the same. Sources: `grav-2015`, `willmer-2018`, `naif-pck00011`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`.
- **Lysithea** (510). Irregular satellite: brightness from the absolute magnitude H (Grav et al. 2015 compilation), colour ASSUMED grey, H-G phase curve with G assumed by the source (0.10) over Earth-based phase angles. p_V is referenced to the (rough, round-number) pck00011 radius, so it differs from the NEOWISE albedo while the brightness is the same. Sources: `grav-2015`, `willmer-2018`, `naif-pck00011`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`.
- **Carme** (511). Irregular satellite: brightness from the absolute magnitude H (Grav et al. 2015 compilation), colour ASSUMED grey, H-G phase curve with G assumed by the source (0.10) over Earth-based phase angles. p_V is referenced to the (rough, round-number) pck00011 radius, so it differs from the NEOWISE albedo while the brightness is the same. Sources: `grav-2015`, `willmer-2018`, `naif-pck00011`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`.
- **Ananke** (512). Irregular satellite: brightness from the absolute magnitude H (Grav et al. 2015 compilation), colour ASSUMED grey, H-G phase curve with G assumed by the source (0.10) over Earth-based phase angles. p_V is referenced to the (rough, round-number) pck00011 radius, so it differs from the NEOWISE albedo while the brightness is the same. Sources: `grav-2015`, `willmer-2018`, `naif-pck00011`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`.
- **Leda** (513). Irregular satellite: brightness from the absolute magnitude H (Grav et al. 2015 compilation), colour ASSUMED grey, H-G phase curve with G assumed by the source (0.10) over Earth-based phase angles. p_V is referenced to the (rough, round-number) pck00011 radius, so it differs from the NEOWISE albedo while the brightness is the same. Sources: `grav-2015`, `willmer-2018`, `naif-pck00011`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`.
- **Phoebe** (609). Irregular satellite: brightness from H = 6.59 (Grav et al. 2015 compilation), colour ASSUMED grey, H-G phase curve with G = 0.02 over 0-6.5°. Cassini measured Phoebe in detail, but no disk-integrated table was accessible. Sources: `grav-2015`, `willmer-2018`, `naif-pck00011`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`.

### Moons: zero-phase magnitude vs JPL Horizons

Our V(1,0) (from p_V and the pck00011 radius) against the V(1,0) and geometric albedo printed in each Horizons satellite header (JPL's compiled physical parameters; references are not given there). Horizons' APmag for the regular moons is that V(1,0) + 5 log10(rΔ), with no phase term (checked to 0.002 mag at all epochs), except Io and Ganymede (below); for the irregular satellites it includes a phase term.

| moon | R (km) | p_V ours | Horizons albedo | V(1,0) ours | V(1,0) Horizons | ours − Horizons |
|---|---|---|---|---|---|---|
| Phobos | 11.0 | 0.082 | 0.06 | +11.613 | +11.8 | -0.187 |
| Deimos | 6.2 | 0.080 | 0.06 | +12.894 | +12.89 | +0.004 |
| Io | 1821.5 | 0.598 | 0.63 | -1.629 | -1.68 | +0.051 |
| Europa | 1560.8 | 0.654 | 0.67 +/- 0.03 | -1.392 | -1.41 | +0.018 |
| Ganymede | 2631.2 | 0.424 | 0.43 | -2.055 | -2.09 | +0.035 |
| Callisto | 2410.3 | 0.180 | 0.17 | -0.935 | -1.05 | +0.115 |
| Mimas | 198.2 | 0.650 | 0.6 | +3.097 | +3.3 | -0.203 |
| Enceladus | 252.1 | 0.893 | 1.04 | +2.229 | +2.1 | +0.129 |
| Tethys | 531.0 | 0.743 | 0.80 | +0.812 | +0.6 | +0.212 |
| Dione | 561.4 | 0.648 | 0.6 | +0.840 | +0.8 | +0.040 |
| Rhea | 763.5 | 0.599 | 0.6 | +0.256 | +0.1 | +0.156 |
| Titan | 2574.8 | 0.216 | 0.2 | -1.275 | -1.28 | +0.005 |
| Iapetus | 734.3 | n/a | 0.6 | n/a | +1.5 (.7-2.5) | n/a |
| Ariel | 578.9 | 0.533 | 0.34 | +0.985 | +1.45 | -0.465 |
| Umbriel | 584.7 | 0.258 | 0.18 | +1.749 | +2.10 | -0.351 |
| Titania | 788.9 | 0.347 | 0.27 | +0.780 | +1.02 | -0.240 |
| Oberon | 761.4 | 0.310 | 0.24 | +0.977 | +1.23 | -0.253 |
| Miranda | 235.8 | n/a | 0.27 | n/a | +3.6 | n/a |
| Triton | 1352.6 | 0.861 | 0.7 | -1.379 | -1.24 | -0.139 |
| Charon | 606.0 | 0.510 | n/a | +0.933 | +0.90 (from APmag) | +0.032 |
| Himalia | 85.0 | 0.039 | 0.04 | +8.000 | +8.14 | -0.140 |
| Elara | 40.0 | 0.046 | 0.03 | +9.450 | +10.0 | -0.550 |
| Pasiphae | 18.0 | 0.113 | n/a | +10.210 | +10.33 | -0.120 |
| Sinope | 14.0 | 0.069 | n/a | +11.290 | +11.6 | -0.310 |
| Lysithea | 12.0 | 0.113 | n/a | +11.090 | +11.7 | -0.610 |
| Carme | 15.0 | 0.085 | n/a | +10.910 | +11.3 | -0.390 |
| Ananke | 10.0 | 0.081 | n/a | +11.840 | +12.2 | -0.360 |
| Leda | 5.0 | 0.157 | n/a | +12.630 | +13.5 | -0.870 |
| Phoebe | 106.5 | 0.090 | 0.081 +- 0.002 | +6.590 | +6.89 | -0.300 |

Reading the differences:

- **Galilean moons, Titan, Deimos, Dione**: within 0.12 mag. (For Callisto, JPL's own V(1,0) = -1.05 and albedo 0.17 are not consistent with each other at the pck00011 radius: -1.05 implies p ≈ 0.20.)
- **Mimas −0.20, Enceladus +0.13, Tethys +0.21, Rhea +0.16**: Filacchione's albedos exclude the opposition surge; JPL's values are older compilations (e.g. Enceladus p = 1.04). Earth-based magnitudes of these moons near opposition are brighter than both by the surge.
- **Ariel −0.47, Umbriel −0.35, Titania −0.24, Oberon −0.25**: HST albedos (Karkoschka 2001) include the narrow opposition surge. Horizons' albedos are much lower (Ariel 0.34), like the Voyager-based albedos that DeColibus et al. (2026) note fall below Karkoschka's because Voyager lacked small-phase data.
- **Phobos −0.19**: Hapke albedos with a strong surge (B0 = 2.3) vs JPL's p = 0.06.
- **Triton −0.14**: p_V = 0.86 (Buratti et al. 2011) vs JPL's 0.7.
- **Irregular satellites −0.1…−0.9**: Grav et al.'s (2015) compiled H values are brighter than the V(1,0) in Horizons' headers (Leda by 0.87 mag). Our V(1,0) equals H by construction. Their Horizons APmag includes a phase law, so the apparent-magnitude differences below mix the two.

### Moons: apparent magnitude vs Horizons APmag

*ours* = our V(1,0) + 5 log10(rΔ) + our phase function, at Horizons' r, Δ, α (from Earth). n/a: α outside our phase function's domain, or photometry unknown.

| moon | date | α (°) | Horizons | ours | ours − Horizons |
|---|---|---|---|---|---|
| Phobos | 2026-Sep-30 | 35.92 | +13.878 | +15.401 | **+1.523** |
| Phobos | 2027-Jan-15 | 25.25 | +12.438 | +13.606 | **+1.168** |
| Phobos | 2027-Jun-01 | 38.43 | +13.481 | +15.085 | **+1.604** |
| Deimos | 2026-Sep-30 | 35.92 | +14.968 | n/a | **n/a** |
| Deimos | 2027-Jan-15 | 25.24 | +13.528 | n/a | **n/a** |
| Deimos | 2027-Jun-01 | 38.43 | +14.571 | n/a | **n/a** |
| Io | 2026-Sep-30 | 7.99 | +9.422 | +6.003 | **-3.419** |
| Io | 2027-Jan-15 | 5.40 | +7.663 | +5.355 | **-2.308** |
| Io | 2027-Jun-01 | 10.21 | +10.320 | +5.963 | **-4.357** |
| Europa | 2026-Sep-30 | 7.99 | +6.253 | +6.186 | **-0.067** |
| Europa | 2027-Jan-15 | 5.41 | +5.615 | +5.557 | **-0.058** |
| Europa | 2027-Jun-01 | 10.22 | +6.185 | +6.125 | **-0.060** |
| Ganymede | 2026-Sep-30 | 8.00 | +7.939 | +5.560 | **-2.379** |
| Ganymede | 2027-Jan-15 | 5.41 | +6.520 | +4.916 | **-1.604** |
| Ganymede | 2027-Jun-01 | 10.22 | +8.546 | +5.517 | **-3.029** |
| Callisto | 2026-Sep-30 | 7.97 | +6.893 | +6.761 | **-0.132** |
| Callisto | 2027-Jan-15 | 5.41 | +6.171 | +6.080 | **-0.091** |
| Callisto | 2027-Jun-01 | 10.20 | +6.870 | +6.733 | **-0.137** |
| Mimas | 2026-Sep-30 | 0.59 | +12.805 | +12.613 | **-0.192** |
| Mimas | 2027-Jan-15 | 5.79 | +13.081 | +12.980 | **-0.101** |
| Mimas | 2027-Jun-01 | 4.49 | +13.164 | +13.040 | **-0.124** |
| Enceladus | 2026-Sep-30 | 0.59 | +11.606 | +11.741 | **+0.135** |
| Enceladus | 2027-Jan-15 | 5.78 | +11.882 | +12.071 | **+0.189** |
| Enceladus | 2027-Jun-01 | 4.49 | +11.965 | +12.139 | **+0.174** |
| Tethys | 2026-Sep-30 | 0.59 | +10.104 | +10.323 | **+0.219** |
| Tethys | 2027-Jan-15 | 5.78 | +10.383 | +10.665 | **+0.282** |
| Tethys | 2027-Jun-01 | 4.49 | +10.463 | +10.730 | **+0.267** |
| Dione | 2026-Sep-30 | 0.59 | +10.306 | +10.354 | **+0.048** |
| Dione | 2027-Jan-15 | 5.78 | +10.583 | +10.702 | **+0.119** |
| Dione | 2027-Jun-01 | 4.49 | +10.665 | +10.766 | **+0.101** |
| Rhea | 2026-Sep-30 | 0.59 | +9.606 | +9.770 | **+0.164** |
| Rhea | 2027-Jan-15 | 5.79 | +9.880 | +10.114 | **+0.234** |
| Rhea | 2027-Jun-01 | 4.49 | +9.965 | +10.181 | **+0.216** |
| Titan | 2026-Sep-30 | 0.59 | +8.229 | +8.236 | **+0.007** |
| Titan | 2027-Jan-15 | 5.79 | +8.500 | n/a | **n/a** |
| Titan | 2027-Jun-01 | 4.49 | +8.584 | +8.606 | **+0.022** |
| Iapetus | 2026-Sep-30 | 0.57 | +11.001 | n/a | **n/a** |
| Iapetus | 2027-Jan-15 | 5.77 | +11.291 | n/a | **n/a** |
| Iapetus | 2027-Jun-01 | 4.50 | +11.364 | n/a | **n/a** |
| Ariel | 2026-Sep-30 | 2.53 | +14.276 | +14.287 | **+0.011** |
| Ariel | 2027-Jan-15 | 2.30 | +14.263 | +14.262 | **-0.001** |
| Ariel | 2027-Jun-01 | 0.22 | +14.438 | +14.129 | **-0.309** |
| Umbriel | 2026-Sep-30 | 2.53 | +14.926 | +15.051 | **+0.125** |
| Umbriel | 2027-Jan-15 | 2.30 | +14.913 | +15.026 | **+0.113** |
| Umbriel | 2027-Jun-01 | 0.22 | +15.088 | +14.894 | **-0.194** |
| Titania | 2026-Sep-30 | 2.53 | +13.846 | +14.082 | **+0.236** |
| Titania | 2027-Jan-15 | 2.30 | +13.833 | +14.057 | **+0.224** |
| Titania | 2027-Jun-01 | 0.22 | +14.008 | +13.924 | **-0.084** |
| Oberon | 2026-Sep-30 | 2.53 | +14.056 | +14.279 | **+0.223** |
| Oberon | 2027-Jan-15 | 2.30 | +14.044 | +14.255 | **+0.211** |
| Oberon | 2027-Jun-01 | 0.22 | +14.218 | +14.122 | **-0.096** |
| Miranda | 2026-Sep-30 | 2.53 | +16.426 | n/a | **n/a** |
| Miranda | 2027-Jan-15 | 2.30 | +16.413 | n/a | **n/a** |
| Miranda | 2027-Jun-01 | 0.22 | +16.588 | n/a | **n/a** |
| Triton | 2026-Sep-30 | 0.14 | +13.440 | +13.304 | **-0.136** |
| Triton | 2027-Jan-15 | 1.74 | +13.540 | n/a | **n/a** |
| Triton | 2027-Jun-01 | 1.75 | +13.544 | n/a | **n/a** |
| Charon | 2026-Sep-30 | 1.44 | +16.388 | +16.711 | **+0.323** |
| Charon | 2027-Jan-15 | 0.31 | +16.483 | +16.653 | **+0.170** |
| Charon | 2027-Jun-01 | 1.36 | +16.402 | +16.720 | **+0.318** |
| Himalia | 2026-Sep-30 | 7.96 | +15.667 | +16.125 | **+0.458** |
| Himalia | 2027-Jan-15 | 5.60 | +15.005 | +15.345 | **+0.340** |
| Himalia | 2027-Jun-01 | 10.13 | +15.573 | +16.128 | **+0.555** |
| Elara | 2026-Sep-30 | 7.94 | +17.550 | +17.597 | **+0.047** |
| Elara | 2027-Jan-15 | 5.53 | +16.905 | +16.832 | **-0.073** |
| Elara | 2027-Jun-01 | 10.08 | +17.448 | +17.591 | **+0.143** |
| Pasiphae | 2026-Sep-30 | 7.85 | +17.838 | +18.310 | **+0.472** |
| Pasiphae | 2027-Jan-15 | 5.14 | +17.276 | +17.611 | **+0.335** |
| Pasiphae | 2027-Jun-01 | 10.31 | +17.666 | +18.249 | **+0.583** |
| Sinope | 2026-Sep-30 | 7.67 | +19.187 | +19.461 | **+0.274** |
| Sinope | 2027-Jan-15 | 5.23 | +18.649 | +18.799 | **+0.150** |
| Sinope | 2027-Jun-01 | 9.92 | +19.108 | +19.484 | **+0.376** |
| Lysithea | 2026-Sep-30 | 8.02 | +19.141 | +19.132 | **-0.009** |
| Lysithea | 2027-Jan-15 | 5.28 | +18.589 | +18.442 | **-0.147** |
| Lysithea | 2027-Jun-01 | 10.30 | +19.085 | +19.177 | **+0.092** |
| Carme | 2026-Sep-30 | 7.84 | +18.882 | +19.084 | **+0.202** |
| Carme | 2027-Jan-15 | 5.19 | +18.167 | +18.234 | **+0.067** |
| Carme | 2027-Jun-01 | 10.52 | +18.586 | +18.907 | **+0.321** |
| Ananke | 2026-Sep-30 | 7.76 | +19.747 | +19.976 | **+0.229** |
| Ananke | 2027-Jan-15 | 5.22 | +19.221 | +19.321 | **+0.100** |
| Ananke | 2027-Jun-01 | 10.02 | +19.663 | +19.993 | **+0.330** |
| Leda | 2026-Sep-30 | 7.89 | +21.005 | +20.730 | **-0.275** |
| Leda | 2027-Jan-15 | 5.40 | +20.323 | +19.922 | **-0.401** |
| Leda | 2027-Jun-01 | 10.19 | +20.928 | +20.756 | **-0.172** |
| Phoebe | 2026-Sep-30 | 0.55 | +16.416 | +16.238 | **-0.178** |
| Phoebe | 2027-Jan-15 | 5.82 | +16.641 | +16.882 | **+0.241** |
| Phoebe | 2027-Jun-01 | 4.46 | +16.744 | +16.901 | **+0.157** |

- **Io and Ganymede: Horizons appears to be wrong.** Their APmag implies linear phase coefficients of 0.452 and 0.318 mag/deg (the same at all three epochs, so not eclipses), about ten times Mayorga et al.'s measured curves (Io GRN: 0.018 mag/deg over 0-8°) and than Europa's and Callisto's own Horizons coefficients (0.021, 0.056 mag/deg). At α = 8° Horizons makes Io 3.4 mag too faint. Worth reporting to JPL.
- **Phobos +1.2…+1.6 at α = 25-38°**: Horizons applies no phase term; the H-G curve dims Phobos by that much.
- **Saturnian and Uranian moons**: the differences equal the V(1,0) differences above plus our phase term (≤ 0.1 mag at Earth-based α for Saturn's moons; up to 0.45 mag for the Uranian moons' surge).

## Rings (`rings.json`)

Normal optical depth τ⊥ from one occultation per system (label **measured**). Reflectance: Saturn's is a single-scattering model calibrated on Voyager and HST measurements (label **estimated**; the measurements themselves are also in the product, **measured**); Jupiter's, Uranus's and Neptune's are **unknown**. Values below are summaries of the product.

| planet | profile | radius range (km) | bins | observation | reflectance |
|---|---|---|---|---|---|
| Saturn | main rings | 72833-151675 | 7884 | Cassini UVIS HSP, β Cen ingress 2008-231T11:11:5, B = 66.7° | estimated |
| Uranus | ring system (6, 5, 4, α, β, η, γ, δ, λ, ε) | 37750-53500 | 15751 | Voyager 2 PPS, Beta Per egress 1986-01-24T19:20, B = 53.2° | unknown |
| Neptune | ring system | 42500-76000 | 6701 | Voyager 2 PPS, Sigma Sgr ingress 1989-08-24T22:56, B = 19.3° | unknown |
| Jupiter | unknown | | | | unknown |

Saturn, median τ⊥ by region (region limits are round numbers for this summary, not a product):

| region | radii (km) | median τ⊥ | max τ⊥ | bins at/above max detectable |
|---|---|---|---|---|
| C ring | 74500-92000 | 0.077 | 3.22 | 0 |
| B ring | 92000-117500 | 2.763 | 9.75 | 2 |
| Cassini Division | 117600-122000 | 0.087 | 1.90 | 0 |
| A ring | 122100-136770 | 0.633 | 1.99 | 0 |
| Encke Gap | 133450-133750 | 0.001 | 0.06 | 0 |

Transmission of a ray crossing the ring plane at elevation B is exp(−τ⊥/|sin B|) to first order; in the A and B rings self-gravity wakes change the slant optical depth with viewing azimuth by tens of percent. Saturn's equinox was in May 2025, so the Sun stays low over the rings throughout the window.

### Saturn's ring reflectance

Measured inputs: the Voyager 2 lit-face and Voyager 1 unlit-face ISS clear-filter I/F profiles (PDS VG_2810, 10 km bins) and Salo & French's (2010) HST WFPC2 phase curves of the C, B and A rings (5 filters 336-814 nm, α = 0.25-6.3°, six effective elevations 4.5-26.1°, their Table 4). The model is the classical single-scattering many-particle-thick ring (Chandrasekhar 1960; Salo & French Eq. 6) with the particle term ϖP taken from the HST curves (≤ 6.3°), joined to Voyager at 47° by a power-law particle phase function (π − α)^n, and with radial structure and the unlit face fitted to the Voyager profiles. Formula and assumptions: docs/architecture.md §6.

**Two independent anchors agree with a Callisto-like particle phase function.** Joining the HST ϖP at 6.3° (at the Voyager 2 effective elevation, 11.9°) to the Voyager 2 mean at 47° needs n per region below; Salo & French use n = 3.09 (Callisto, Dones et al. 1993) for the same rings. Particle ϖP for the Y channel and the chromaticity of the light the rings reflect (x, y of sunlight × ϖP) at Beff = 20.1°:

| region | radii (km) | mean τ⊥ (UVIS) | n | ϖP_Y 0.25° | ϖP_Y 6.3° | ϖP_Y 47° | x, y at 0.25° | x, y at ≥ 6.3° |
|---|---|---|---|---|---|---|---|---|
| C ring | 78000-83000 | 0.089 | 3.55 | 1.498 | 0.963 | 0.374 | 0.3288, 0.3353 | 0.3303, 0.3362 |
| B ring | 100000-107000 | 5.013 | 3.55 | 5.097 | 3.719 | 1.443 | 0.3424, 0.3515 | 0.3463, 0.3558 |
| A ring | 127000-129000 | 0.641 | 3.81 | 3.538 | 2.547 | 0.921 | 0.3386, 0.3478 | 0.3417, 0.3519 |

For comparison Saturn's globe: x, y = 0.3564, 0.3679. The rings are a paler tan than the globe, the B and A rings slightly redder than the C ring, and all redden with phase angle up to 6.3° (beyond, the colour is held at its 6.3° value: an assumption). ϖP ≫ 1 near opposition is the particles' backscattering phase function times their albedo, not an albedo above 1.

Unlit face: in the B ring core (100 000-107 000 km, median τ⊥ = 5.44) the Voyager 1 unlit profile needs an effective optical depth of median 1.07: light reaches the unlit side by multiple scattering and through gaps between self-gravity wakes, which single scattering at τ⊥ cannot produce. The fitted unlitTau/unlitGain reproduce that one geometry; at others the unlit face is the least certain part of the model.

**Independent check: Saturn's system brightness.** Mallama & Hilton (2018) fitted Saturn's V magnitude with rings (Eq. 10) and of the globe alone (Eq. 11) to ground photometry (α ≤ 6.5°, β ≤ 27°); their difference is the net light the rings add (ring light seen minus globe light the rings block). The model gives the same quantity by integrating over the ring plane with Saturn as an oblate spheroid that hides and shadows the rings and with the rings blocking globe light by 1 − exp(−τ⊥/μ) (Y channel ≈ V; Sun and observer at the same elevation β; the rings' shadow on the globe is ignored, small at these phase angles). Ratio model / M&H:

| β | α = 1° | α = 3° | α = 6° |
|---|---|---|---|
| 5° | 1.74 | 2.83 | M&H < 0 |
| 10° | 1.24 | 1.34 | 1.73 |
| 15° | 1.08 | 1.09 | 1.22 |
| 20° | 0.99 | 0.99 | 1.07 |
| 26° | 1.00 | 1.00 | 1.05 |

At β = 15-26° the model agrees with ground photometry within 10 % at α = 1-3° (5-22 % at 6°). At β ≤ 10° it is brighter than the M&H difference, but there the difference is not a clean measure of the rings: M&H's Eq. 10 at β = 0 is +0.04 mag (α = 0°) to +0.17 mag (α = 6°) off their globe-only Eq. 11, comparable to the whole ring term at low β, and the difference turns negative at β = 5°, α = 6° (rings dimming Saturn). The comparison is inconclusive there. The model's own low-β behaviour rests on the HST data down to Beff = 4.5°, below which the particle term is held constant.

Domain: 0.25° ≤ α ≤ 47° (brightness unknown outside: the true-opposition spike below 0.25° and the forward scattering by dust at large α are not in the data used); radii 74000-140600 km. Not modelled: the A ring's azimuthal (wake) asymmetry, spokes, the F ring.

Jupiter, Uranus, Neptune: no calibrated machine-readable reflectance profile was found (the PDS Ring-Moon Systems Node's Voyager ring-profile series VG_28xx has imaging (ISS) I/F profiles for Saturn only; other published photometry of these rings is in figures), so their reflectance stays unknown.

## M1 follow-ups (M2)

- **DSCOVR/EPIC (Earth)**: not usable without credentials. `https://asdc.larc.nasa.gov/data/DSCOVR/EPIC/L1B/` now answers 301 → `https://cmr.earthdata.nasa.gov/search/site/collections/directory/LARC_CLOUD/...`, i.e. the archive moved to NASA Earthdata Cloud (collection DSCOVR_EPIC_L1B v4, C4025357058-LARC_CLOUD). Granule URLs (`https://data.asdc.earthdata.nasa.gov/asdc-prod-protected/DSCOVR/DSCOVR_EPIC_L1B_4/...h5`, ~300 MB each) and the OPeNDAP service both answer 302 → `urs.earthdata.nasa.gov/oauth/authorize`: **Earthdata Login is required**. (Separately, TLS handshakes to asdc.larc.nasa.gov through this environment's proxy are reset about one time in three.) Only the browse PNGs, and the colour images of epic.gsfc.nasa.gov, are public; neither is calibrated. Earth's spectrum therefore remains the EPIC-validated model; with an Earthdata account (a token in the environment) the pipeline could fetch a few granules and integrate the 10 calibrated EPIC bands over the disk.
- **Moon beyond 120°**: no accessible measured whole-disk phase curve beyond 120° was found (Lane & Irvine stop at 120°). Still unknown.
- **Opposition surge, Moon and Mercury**: the Moon now uses the ROLO model (M3 below). Mercury's M&H curve stays defined from 2° (from Earth, α < 2° happens only within ~0.6° of the Sun).
- **Buie et al. (2010) source record**: the M1 download ledger held the sha256 of a bot-check page served in place of the PDF. Fixed (PDF validation; hand-retrieved copy with recorded sha256); transcribed numbers re-checked against the real PDF.

## M3: the Moon from ROLO

The ROLO lunar model (Kieffer & Stone 2005, AJ 129, 2887; version 311g) is an empirical fit of whole-Moon irradiance in 32 bands (350-2384 nm) from the USGS Robotic Lunar Observatory over 1.55° < g < 97°, with terms for the opposition effect, for which hemisphere is lit (waxing vs waning), and for libration. Table 4 and Eq. 11 were extracted from the PDF text with their minus signs (the PDF's minus glyph comes out as a control character) and checked against a rendering of the page, against an independent transcription of Table 4 (identical) and an independent implementation's constants (identical); Table 5's 'Effect' column confirms the units (g and Φ in radians in the polynomials, degrees in the exponentials). Converted to the CIE channels and refitted per channel (max |Δ ln A| = 2.3e-05).

Brightness of the Moon (Y channel, disk-equivalent reflectance A = p·Φ at zero libration, mean of waxing and waning) from ROLO and from Lane & Irvine (p_Y = 0.1318 times their V phase curve), and the waxing/waning ratio from ROLO:

| α | A_Y ROLO | A_Y Lane & Irvine | ROLO / L&I | waxing / waning | x, y (ROLO) |
|---|---|---|---|---|---|
| 1.55° | 0.1363 | 0.1268 | 1.075 | 1.002 | 0.3467, 0.3503 |
| 2° | 0.1315 | 0.1254 | 1.049 | 1.003 | 0.3468, 0.3503 |
| 3° | 0.1225 | 0.1223 | 1.002 | 1.004 | 0.3471, 0.3505 |
| 5° | 0.1094 | 0.1164 | 0.940 | 1.007 | 0.3477, 0.3509 |
| 7° | 0.1003 | 0.1107 | 0.906 | 1.010 | 0.3482, 0.3513 |
| 10° | 0.0905 | 0.1028 | 0.880 | 1.014 | 0.3490, 0.3518 |
| 20° | 0.0694 | 0.0809 | 0.859 | 1.029 | 0.3509, 0.3533 |
| 30° | 0.0545 | 0.0631 | 0.865 | 1.046 | 0.3523, 0.3542 |
| 45° | 0.0380 | 0.0440 | 0.862 | 1.074 | 0.3537, 0.3551 |
| 60° | 0.0259 | 0.0310 | 0.836 | 1.105 | 0.3547, 0.3559 |
| 90° | 0.0105 | 0.0134 | 0.783 | 1.145 | 0.3559, 0.3569 |
| 97° | 0.0082 | 0.0104 | 0.782 | 1.140 | 0.3561, 0.3571 |

Lane & Irvine's colour: x, y = 0.3643, 0.3591 (kept for geometricAlbedoXYZS; ROLO is less red). Below 2° ROLO is brighter than Lane & Irvine's surge-free extrapolation (the surge); from 5° on it is 6-22 % fainter, i.e. close to Lane & Irvine's own broadband V (13 % below their narrow bands) up to 45° and steeper beyond. The waxing Moon is brighter, as Lane & Irvine and Rougier (1934) observed (0.01-0.09 mag between quadrature and full). The product's phase function is ROLO's A_Y divided by Lane & Irvine's p_Y (so the brightness is ROLO's) for 1.55-97°, Lane & Irvine's curve shifted to join it for 97-120° (label estimated because of the join); diskReflectanceModel carries the full ROLO geometry per channel (derived).

## Weak data, in order of concern

1. **Earth**: model spectrum; factor-2 disagreement with the magnitude used by Horizons.
2. **Pluto**: colour from two broadband points; phase curve only to 1.74°.
3. **Venus blue end**: ±20 % between datasets below 480 nm, which sets how yellow Venus looks.
4. **Moon colour**: 1964-65 narrow-band photometry with a known internal 13 % V inconsistency; redder than ROLO. Its brightness now follows ROLO (1.55-97°), with the opposition surge.
5. **Uranus/Neptune epoch**: 1995 spectra; both have changed since (Uranus seasonally, strongly in the red).
6. **Mars and Mercury shapes**: Mars between broadband nodes; Mercury from disk-resolved spectra.
7. **Phase corrections for Jupiter/Saturn** to zero phase (+2.4 %, +1.7 %) assume a grey phase law.
8. **Opposition surges of the moons**: included for the Moon (ROLO, to 1.55°), Uranian moons, Triton, Charon, Phobos; see M3 for Mimas-Rhea.
9. **Iapetus and Miranda** unknown; **Deimos** grey placeholder; **Titan** and **Triton**/**Charon** phase curves only near opposition.
10. **Ring brightness**: Saturn's is a calibrated model (unlit face and radii away from the three HST regions least certain; low ring elevations only partly checked); Jupiter's, Uranus's and Neptune's unknown.
11. **Irregular satellites**: brightness from compiled H only; grey placeholder colour; rough pck00011 radii (if bodies.json uses a different radius for them, the rendered brightness scales by (R_bodies/R_pck)²).

