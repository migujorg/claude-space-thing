# Planet colors and photometry: review report

Generated 2026-09-30 by `cd pipeline && uv run python -m pipeline.photometry.report`, from the same code as the `light` stage (`app/public/data/light.json`, `photometry.json`). All numbers below are computed, not typed; the prose is written by hand. Sources are listed in `sources.json` and `docs/sources/`.

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
| Moon | 0.3643 | 0.3591 | 0.128 | 0.132 | `#766254` | `#726356` | `#FFDFC3` | estimated | measured | Lane & Irvine 1973 |
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
- **Earth** (399). Spectral shape and level: a radiative-transfer MODEL (PSG with MERRA-2 clouds for 2022 June 21) validated against DSCOVR/EPIC; no machine-readable measured whole-disk zero-phase visible spectrum was reachable (the EPIC L1B archive at NASA ASDC refused connections from this environment). Its p_V = 0.22 is half of Mallama et al.'s 0.434 (used by Mallama & Hilton and Horizons). A simple check favours the low value: for a disk of mean reflectance factor ⟨R⟩ seen at zero phase p ≈ ⅔⟨R⟩, and Earth's ⟨R⟩ ≈ Bond albedo ≈ 0.3 gives p ≈ 0.2. The high value comes from EPOXI photometry at 58-77° phase extrapolated to 0° with a model phase curve. Real Earth varies by tens of percent with clouds. Phase curve: model (estimated). Sources: `payne-2026-earth`, `naif-pck00011`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`, `mallama-hilton-2018`.
- **Moon** (301). Lane & Irvine (1973) whole-disk narrow-band geometric albedos, interpolated linearly between 9 bands. Opposition surge EXCLUDED from both albedo and phase curve (the real full Moon is tens of percent brighter at α < 5°). The narrow-band data give a V-band albedo 13 % above the authors' own broadband V (they suspected their broadband transformation) and they flag a possible ~10 % excess at 600-850 nm in the 1965 data; the Moon may therefore render slightly too red and too bright. Phase curve: measured 6-120°. Sources: `lane-irvine-1973`, `naif-pck00011`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`.
- **Mars** (499). Reconstructed from Mallama et al. (2017) photometric Johnson UBVRI albedos (rotation/season averaged): a piecewise-linear spectrum through five band averages. Brightness and B-V are measured; the shape between bands is assumed (no 530 nm shoulder). A PSG model composite (Payne et al.) was rejected: its B albedo is 45 % below the photometry. Phase curve: measured to 50°, assumed beyond (estimated). Sources: `mallama-2017`, `svo-johnson-u`, `svo-johnson-b`, `svo-johnson-v`, `svo-johnson-r`, `svo-johnson-i`, `naif-pck00011`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`, `mallama-hilton-2018`.
- **Jupiter** (599). Karkoschka (1998) ESO spectrophotometry at 6.8° phase, scaled to 0° with Mallama & Hilton's V phase law (assumption: same at all λ, +2.4 %). Agrees with Mallama et al. (2017) B, V, Rc to ≤ 2 % and with Horizons to 0.02 mag. Strong data. Phase curve: ground + Cassini (measured). Sources: `karkoschka-1998-pds`, `naif-pck00011`, `mallama-hilton-2018`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`.
- **Saturn** (699). Karkoschka (1998) at the 1995 ring-plane crossing, i.e. the GLOBE without rings (what the renderer draws; rings are M2). Scaled from 5.7° to 0° with an assumed phase law (+1.7 %). 5 % fainter in V than Mallama & Pavlov's synthetic globe magnitude from the same data, but consistent with Karkoschka's own V. Saturn's globe colour changes with season (hemisphere in view, ring shadow). Phase curve: assumed/modelled (estimated). Sources: `karkoschka-1998-pds`, `naif-pck00011`, `mallama-hilton-2018`, `tsis1-hsrs-v2`, `cie-1931-2deg-cmf`, `cie-1951-scotopic`.
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
| Moon | 2026-Sep-30 | 42.94 | -11.663 | n/a | -11.734 | **-0.071** | Horizons formula not from Mallama & Hilton |
| Moon | 2027-Jan-15 | 100.19 | -9.736 | n/a | -9.946 | **-0.210** | Horizons formula not from Mallama & Hilton |
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
- **Moon −0.07 (α = 43°), −0.21 (α = 100°), n/a at 130°**: Horizons uses V(1,α) = 0.23 + 0.026α + 4×10⁻⁹α⁴ (Allen's law; our fixtures reproduce it to 0.0002 mag), whose 0.23 equals Lane & Irvine's broadband V. Ours is 0.08 mag brighter at zero phase (we use their narrow-band albedos, see the Moon note) and follows their measured V phase curve, which dims less than Allen's law at large α; valid to 120° only.
- **Pluto +0.16…+0.19**: Horizons' Pluto includes Charon, V(1,α) ≈ −1.00 + 0.041α (inferred from the fixtures; the manual does not cite a source); we add Charon from the same HST paper for this comparison. Buie et al.'s 2002-2003 Pluto + Charon is 0.16 mag fainter than Horizons' system magnitude (the radius does not enter this comparison).

## Weak data, in order of concern

1. **Earth**: model spectrum; factor-2 disagreement with the magnitude used by Horizons.
2. **Pluto**: colour from two broadband points; phase curve only to 1.74°.
3. **Venus blue end**: ±20 % between datasets below 480 nm, which sets how yellow Venus looks.
4. **Moon**: 1964-65 photometry with a known internal 13 % V inconsistency; opposition surge excluded.
5. **Uranus/Neptune epoch**: 1995 spectra; both have changed since (Uranus seasonally, strongly in the red).
6. **Mars and Mercury shapes**: Mars between broadband nodes; Mercury from disk-resolved spectra.
7. **Phase corrections for Jupiter/Saturn** to zero phase (+2.4 %, +1.7 %) assume a grey phase law.

