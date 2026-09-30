# Atmospheres: optical properties for sky and limb rendering

`app/public/data/atmospheres.json` (`AtmosphereFile`, light stage; built by `pipeline/src/pipeline/photometry/atmospheres.py`). Regenerate this report with `uv run python -m pipeline.photometry.atmo_report`.

## Layout

- Spectral samples 360–830 nm every 10 nm (48, standard-air wavelengths like the CIE tables). `foldWeights` (4 × 48) fold any spectral ratio sampled there into X, Y, Z, S (sunlight × observer, piecewise-linear basis, rows sum to 1; then × the Sun's XYZS from `light.json`).
- Per body: `referenceRadiusKm` (pck00011 mean radius, altitude 0), `topRadiusKm`, `altitudesKm`, and `components`, each with `extinctionPerKm[altitude][wavelength]`, `singleScatteringAlbedo[wavelength]`, `phaseFunction` (rayleigh with depolarization ρ, henyey-greenstein, double-henyey-greenstein, tabulated, or none for pure absorbers; mean 1 over the sphere), `channelEquivalents` (X, Y, Z, S) and `columnOpticalDepth`. Molecular components also carry `separable` = number density × cross-section.
- Every quantity is `Sourced` with a label; `unknown` quantities (Titan's haze single-scattering albedo and phase function) must not be rendered as if known.

| body | components | τ(550 nm) per component (altitude 0 to top) | grid |
|---|---|---|---|
| Earth | rayleigh, ozone, aerosol | rayleigh 0.09711, ozone 0.03058, aerosol 0.122 | 0–86 km (87) |
| Mars | rayleigh, dust | rayleigh 0.002668, dust 0.3836 | 0–80 km (81) |
| Titan | rayleigh, haze | rayleigh 1.089, haze 8.101 | 0–500 km (146) |
| Venus | cloud | cloud 12.65 | 60–110 km (101) |
| Pluto | haze | haze 0.02075 | 0–300 km (61) |
| Jupiter | — (scale height only) | — | — |
| Saturn | — (scale height only) | — | — |
| Uranus | — (scale height only) | — | — |
| Neptune | — (scale height only) | — | — |

Labels per component (extinction / SSA / phase):

- Earth rayleigh: estimated / derived / derived
- Earth ozone: estimated / derived / derived
- Earth aerosol: estimated / estimated / estimated
- Mars rayleigh: estimated / derived / derived
- Mars dust: estimated / derived / estimated
- Titan rayleigh: estimated / derived / derived
- Titan haze: estimated / unknown / unknown
- Venus cloud: estimated / estimated / estimated
- Pluto haze: estimated / estimated / estimated

## Earth

**Rayleigh cross-section** (Bodhaine et al. 1999 Eq. 22 with Peck & Reeder air, 360 ppm CO2, Bates King factor) against their Table 3 at 350–850 nm: max relative difference 2.9e-05; King factor max |Δ| 4.8e-06.

**Rayleigh optical depth**: the US76 column (0–86 km, 2.1533e+29 m⁻²) × σ against Bodhaine's Table 3 (sea level, 1013.25 mb, 45° latitude):

| λ (nm) | 350 | 400 | 450 | 500 | 550 | 600 | 650 | 700 | 750 | 800 | 850 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| this product | 0.63069 | 0.36043 | 0.22124 | 0.14344 | 0.09713 | 0.06813 | 0.04922 | 0.03645 | 0.02757 | 0.02124 | 0.01663 |
| Bodhaine Table 3 | 0.63031 | 0.36022 | 0.22111 | 0.14336 | 0.09707 | 0.06809 | 0.04919 | 0.03642 | 0.02755 | 0.02123 | 0.01662 |

Ratio at 550 nm: 1.00060 (the US76 column vs Bodhaine's P A/(m_a g) with g at the mass-weighted column height; 0.06 % is within the variability of real surface pressure).

**US76 profile**: the defining equations reproduce the Standard's printed check rows (Tables I–II, 8 values from −5 to 80.5 km) to max |Δ|/value = 8.4e-05.

**Ozone**: US76 Table 18 integrates to 346.4 DU on the product grid (table: 345 DU = 0.345 atm-cm, 5 % above Dobson-network values at 45° N per the Standard itself); τ_O3 = 0.0468 at 600 nm (Chappuis peak).

**Aerosol**: MACv2 global annual mean, τ(550) = 0.122, ω(550) = 0.941, g(550) = 0.702 (Kinne 2019 Table 2).

**Zenith sky colour** (check of the combined components): single-scattering zenith radiance, plane-parallel, no multiple scattering or ground reflection, integrated against the CIE observer. CCT by Hernández-Andrés et al. (1999) (colour-science); `y_D` is the CIE D-series daylight locus at that CCT (colour-science CCT_to_xy_CIE_D).

| Sun elevation | x | y | CCT (K) | y_D (daylight locus) |
|---|---|---|---|---|
| 60° | 0.2958 | 0.3086 | 7858 | 0.3108 |
| 30° | 0.2758 | 0.2879 | 10594 | 0.2882 |
| 10° | 0.2727 | 0.2887 | 10921 | 0.2863 |

The zenith sky is blue (CCT 7858–10921 K) and lies on the daylight locus within |Δy| ≤ 0.0025: the molecular, ozone and aerosol components together give a skylight colour on the CIE daylight locus.

| Sun zenith angle | air mass | direct-sun transmittance T_Y | x | y |
|---|---|---|---|---|
| 0° | 1.00 | 0.780 | 0.3335 | 0.3449 |
| 60° | 2.00 | 0.608 | 0.3454 | 0.3569 |
| 80° | 5.76 | 0.241 | 0.3889 | 0.3927 |

Direct sunlight reddens with air mass (plane-parallel air mass; near the horizon use a spherical path).

## Mars

- L_s = 0 epochs from DE442 + the IAU pole: 2024-11-12T09:27:46 and 2026-09-30T08:11:07 (668.57 sols apart): the starts of Mars years 38 and 39 in the numbering of Clancy et al. (2000) that the MCD uses (MY 1 began at L_s = 0 on 1955 April 11, MCD manual §1.2).
- Column dust (visible, 610 Pa), MCD climatology scenario: annual global mean 0.375; minimum 0.201 at L_s ≈ 82° (aphelion clear season), maximum 0.756 at L_s ≈ 238° (perihelion dust season).
- Dust asymmetry at 650 nm: measured double-HG (Chen-Chen et al. 2019) g = 0.685 (text 0.687); the MCD's Wolff et al. dust 0.691. SSA at 650 nm: MCD table 0.967; the value Chen-Chen et al. took from Wolff et al. (2009) for the MSL cameras 0.975. The asymmetry agreement is an independent check (sky-radiance fit vs T-matrix calculation); the SSA agreement supports the attribution of the LMD file to Wolff et al.
- CO2 Rayleigh τ(550) = 0.0027 at 636 Pa; dust τ(550) = 0.384 (annual mean) — dust dominates the sky colour.
- CO2 refractivity (Owens 1967 via Bodhaine Eq. 27, scaled 15 → 0 °C) vs Bideau-Mehu et al. (1973): max relative difference 9.5e-04 at 400–830 nm. Bodhaine's Table 2 CO2 optical depths (360 ppm, 300–370 nm) are NOT reproduced by their Section 5 recipe (ours are 28 % lower with m = 44.01 as stated); at 370 nm the table implies σ_CO2/σ_air = 2.35 (τ_CO2 / (τ_air × 360 ppm)) where Eq. 22 with the two refractivities gives 2.59. The cross-section itself is validated by the refractivity check; the table's column bookkeeping is unclear.

## Titan

- Haze column (DISR model, Tomasko et al. 2008 via Bazzon et al. 2014): τ = 8.63 at 531 nm, 8.11 at 550 nm, 6.04 at 650 nm, 3.25 at 940 nm, 2.61 at 1080 nm; Vincendon & Langevin (2010) quote Tomasko et al.'s total as 2.6 at 1.08 µm.
- N2 Rayleigh τ(550) = 1.089 (HASI surface 146645 Pa, 93.50 K, n = 1.136e+26 m⁻³).
- **Unknown**: the haze single-scattering albedo and phase function. They are in Tomasko et al. (2008, Table 2, Fig. 48 and the tabulated phase functions) and Doose et al. (2016), which are not accessible here (Elsevier); no open transcription of the numbers was found. Titan's haze cannot be rendered physically until they are supplied (a hand copy of the paper would do, as for ROLO). The disk-integrated colour remains calibrated by `photometry.json`.

## Venus

- Cloud/haze τ = 1 at 70 km (365 nm), 4 km scale height to 80 km, 4.8 km above (Lee et al. 2021; Pere et al. 2016). Mie droplets of Hansen & Hovenier (1974): g(550) = 0.718, extinction relative to 365 nm 0.998–1.136 over 360–830 nm (nearly grey).

## Pluto

- Mie spheres of radius 0.2 µm, n = 1.69 + 0.018i at 607.6 nm (Gladstone et al. 2016's example): P at phase 165° (scattering angle 15°) = 4.85 vs their ≈ 5; Q_sca = 2.82 vs ≈ 2.7; ω = 0.944, g = 0.575.
- Measured haze I/F ratio phase 167° / 20° at 45 km (Cheng et al. 2017 Table 4): 37.5; the Mie phase-function ratio P(13°)/P(160°) = 28.1 (single scattering, same path): the measured haze is 33 % more forward-scattering than the sphere model at that altitude (Cheng et al. note that the 45 km phase function lacks the backscatter lobe of spheres and resembles Titan's aggregate haze).
- Colour exponent (extinction ∝ λ^-a) from the MVIC blue/red I/F: a = 4.1 (3.2–5.2).

## Giant planets

NSSDCA scale heights near 1 bar, and kT/(μ m_u g) from the same sheets' 1 bar temperature, mean molecular weight and gravity:

| planet | NSSDCA H (km) | kT/(μ m_u g) (km) | T (K) | μ | g (m/s²) |
|---|---|---|---|---|---|
| Jupiter | 27.0 | 23.8 | 165 | 2.22 | 25.92 |
| Saturn | 59.5 | 48.1 | 134 | 2.07 | 11.19 |
| Uranus | 27.7 | 26.6 | 76 | 2.64 | 9.01 |
| Neptune | 19.7 | 20.4 | 72 | 2.61 | 11.27 |

Sheet H relative to kT/(μ m_u g): Jupiter +13 %, Saturn +24 %, Uranus +4 %, Neptune -3 % (the sheets do not say at what level or temperature their scale heights apply). Limb haze is `unknown` for all four.

## Not included

- Earth: Not included (unknown here): water-vapour and O2 line absorption (e.g. the O2 A band at 760 nm, H2O bands at 720 and 820 nm), NO2, clouds, polar stratospheric and volcanic aerosol, airglow; the atmosphere above 86 km (about 3.8e-06 of the Rayleigh column: N(86 km) times its scale height).
- Mars: Not included (unknown here): water-ice clouds (aphelion cloud belt, polar hoods), dust storms beyond the climatology, detached dust layers, the wavelength dependence of the dust phase function, CO2 ice clouds.
- Titan: Not included: haze single-scattering albedo and phase function (unknown, see the haze component), methane absorption bands (619, 727, 790 nm and stronger in the near infrared; Karkoschka & Tomasko 2010, not accessed), the detached haze layer, latitude/season variation, clouds.
- Venus: Not included: CO2 Rayleigh scattering above the cloud tops (column above Hansen & Hovenier's 50 mb τ = 1 level ≈ 7.8e+27 m^-2 with the NSSDCA surface gravity, τ ≈ 0.009 at 550 nm), the UV absorber and SO2 (disk colour: photometry.json), the lower clouds, latitude variation (polar collar), mode 1 / mode 3 particles.
- Pluto: Not included: the ~20 discrete haze layers, the north-south asymmetry, gas Rayleigh scattering (~13 µbar: negligible).
