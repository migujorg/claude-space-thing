# Atmospheres: optical properties for sky and limb rendering

`app/public/data/atmospheres.json` (`AtmosphereFile`, light stage; built by `pipeline/src/pipeline/photometry/atmospheres.py`). Regenerate this report with `uv run python -m pipeline.photometry.atmo_report`.

## Layout

- Spectral samples 360–830 nm every 10 nm (48, standard-air wavelengths like the CIE tables). `foldWeights` (4 × 48) fold any spectral ratio sampled there into X, Y, Z, S (sunlight × observer, piecewise-linear basis, rows sum to 1; then × the Sun's XYZS from `light.json`).
- Per body: `referenceRadiusKm` (pck00011 mean radius, altitude 0), `topRadiusKm`, `altitudesKm`, and `components`, each with `extinctionPerKm[altitude][wavelength]`, `singleScatteringAlbedo[wavelength]`, `phaseFunction` (rayleigh with depolarization ρ, henyey-greenstein, double-henyey-greenstein, tabulated, or none for pure absorbers; mean 1 over the sphere), `channelEquivalents` (X, Y, Z, S) and `columnOpticalDepth`. Molecular components also carry `separable` = number density × cross-section.
- Every quantity is `Sourced` with a label; `unknown` quantities must not be rendered as if known. Titan also carries `surfaceReflectance` (the Lambert surface under its haze) and, on its methane component, the measured mole-fraction profile and the 1 nm absorption coefficient.

| body | components | τ(550 nm) per component (altitude 0 to top) | grid |
|---|---|---|---|
| Earth | rayleigh, ozone, aerosol | rayleigh 0.09711, ozone 0.03058, aerosol 0.122 | 0–86 km (87) |
| Mars | rayleigh, dust | rayleigh 0.002668, dust 0.3836 | 0–80 km (81) |
| Titan | rayleigh, haze-below-80km, haze-above-80km-a, haze-above-80km-b, methane | rayleigh 1.089, haze-below-80km 4.23, haze-above-80km-a 2.081, haze-above-80km-b 1.79, methane 0.02658 | 0–500 km (146) |
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
- Titan haze-below-80km: estimated / estimated / estimated
- Titan haze-above-80km-a: estimated / estimated / estimated
- Titan haze-above-80km-b: estimated / estimated / estimated
- Titan methane: estimated / derived / derived
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

Five components over a surface (`surfaceReflectance`), all from the Huygens descent (landing site, 10° S, January 2005) and used for the whole globe; Titan is drawn from them alone (docs/rendering-earth.md §8 "Titan"), so its disk-integrated brightness and colour are a test of these numbers (below).

- **Haze extinction** (DISR model, Tomasko et al. 2008 via Bazzon et al. 2014): τ = 8.63 at 531 nm, 8.11 at 550 nm, 6.04 at 650 nm, 3.25 at 940 nm, 2.61 at 1080 nm; Vincendon & Langevin (2010) quote Tomasko et al.'s total as 2.6 at 1.08 µm. The haze is three components sharing this extinction (below 80 km; above 80 km with weights 1 − w and w, w = (z − 80 km)/120 km), so that its albedo can change with altitude as Doose et al. (2016) prescribe; their columns add to τ(550) = 8.10.
- **Haze single-scattering albedo** (Doose et al. 2016, paywalled; digitized from the vector drawing of Barnes et al. 2018, Fig. 4, free to read; `tables/titan_doose_2016_ssa.csv`, `titan_digitize.py`): above 200 km 0.844 at 500 nm, 0.917 at 650 nm, 0.936 at 800 nm; below 80 km 0.940, 0.988, 1.000. The two curves obey Doose et al.'s rule ω(< 80 km) = (0.565 + ω(> 200 km))/1.5 (Es-sayeh et al. 2023) to 0.0005. Below 500 nm Doose et al. give nothing ("poorly constrained shortwards of 490 nm", García Muñoz et al. 2017): the above-200-km curve is continued linearly (the line through its 500–600 nm vertices) and the other by the rule, giving 0.791 / 0.904 at 400 nm — an extrapolation, and the model's largest error (below).
- **Haze phase functions** (Tomasko et al. 2008, Table 1, from the machine-readable copy in Adamkovics et al. 2016's reference data): below and above 80 km; asymmetry g = 0.729–0.783 and 0.729–0.799. Resampled log-linearly in angle through the forward peak, the rows integrate to 1.0010–1.0102 before renormalization.
- **Methane** (pure absorber): Karkoschka's (1998) cold-temperature absorption coefficients × the Huygens GCMS mole fraction at the DTWG altitudes × the HASI density; column 2.80 km-amagat; vertical τ = 7.13 at the strongest sample (730 nm, 10 nm box average of the extinction).
- N2 Rayleigh τ(550) = 1.089 (HASI surface 146645 Pa, 93.50 K, n = 1.136e+26 m⁻³).
- **Surface**: Lambert reflectance 0.041–0.150 over 360–830 nm (the values García Muñoz et al. 2017 adopted from Karkoschka & Schröder's 2016 DISR maps); X, Y, Z, S equivalents 0.108, 0.105, 0.072, 0.087.
- **Labels**: every haze quantity and the surface are `estimated` — DISR retrievals (their authors' radiative-transfer fits to the descent data), read from a figure or a secondary machine-readable copy, and one landing site used for the whole moon. The methane mole-fraction profile is `derived` (two measured products combined: the GCMS mole fraction and the DTWG altitude, by time), its absorption coefficient `estimated` (Karkoschka's own label).

### The model against Titan's measured brightness

The model is solved by a Monte Carlo reference (`titan_rt.py`: 400,000 photons per sample, spherical geometry, every order of scattering with the tabulated phase functions; tested against exact solutions in `pipeline/tests/test_titan_rt.py`; `docs/reports/titan-mc.json`), so this tests the data, not the renderer. Compared with Karkoschka's (1998) full-disk albedo at 5.7° (1995; absolute calibration ±4 %, 1σ) — the model in the reference's first bin (α 0–8.5°, solid-angle mean 5.7°), the observation box-averaged over each 10 nm sample:

| λ (nm) | 360 | 400 | 440 | 480 | 520 | 560 | 600 | 640 | 680 | 720 | 760 | 800 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| model | 0.110 | 0.119 | 0.124 | 0.157 | 0.183 | 0.222 | 0.245 | 0.286 | 0.293 | 0.205 | 0.287 | 0.197 |
| observed | 0.071 | 0.090 | 0.115 | 0.148 | 0.187 | 0.226 | 0.257 | 0.282 | 0.291 | 0.214 | 0.280 | 0.201 |
| ratio | 1.54 | 1.32 | 1.07 | 1.06 | 0.98 | 0.98 | 0.95 | 1.01 | 1.01 | 0.96 | 1.02 | 0.98 |

- 520–830 nm: model / observed 0.94–1.05; 440–510 nm: 1.05–1.12; below 440 nm 1.10–1.54, where the haze albedo is extrapolated: the model is too bright in the violet and blue. Monte Carlo noise per sample: 0.9–4.0 % (1σ).
- Folded to X, Y, Z, S: model / observed 0.994 ± 0.005, 0.990 ± 0.005, 1.090 ± 0.009, 1.028 ± 0.006 (± the Monte Carlo noise, 1σ; folding 10 nm samples instead of integrating at 1 nm changes the observation's own channels by at most 0.05 %). The luminance agrees with the measurement (-1.0 % against ±4 %); Z is +9.0 %, 2.2σ of the absolute calibration alone, and the colour ratio Z/Y, in which a calibration error common to all wavelengths cancels, is +10.1 %. 93 % of the model's Z (and 4 % of its Y) comes from the samples below 500 nm, where the haze albedo is extrapolated.
- Colour of the reflected sunlight (CIE 1931 x, y): 0.3731, 0.3744 (model) against 0.3811, 0.3838 (observed); Δu′v′ = 0.0055 ± 0.0005 (Monte Carlo): the model is bluer (less orange) than Titan.
- How independent the test is: Doose et al.'s (2016) model was developed against radiances measured "inside and outside the atmosphere" (its title), and García Muñoz et al. (2017, Methods) note that it is "consistent with past spectroscopic measurements of the geometric albedo between 500 and 950 nm" (Karkoschka's). Agreement above 500 nm therefore shows that the transcribed model and the radiative transfer reproduce the published one, more than it tests that model; and Karkoschka's methane coefficients were partly inferred from Titan's own spectrum (`tables/titan_disr_haze.json`), so the depths of the methane bands are not independent either. Below 500 nm the comparison is a real test, of the extrapolation, and it fails.

Cassini ISS disk-integrated phase curves (García Muñoz et al. 2017, Fig. 1, digitized: `tables/titan_garcia_munoz_2017_iss.csv`; NAC images 2004–2015, CISSCAL calibration ~10 %), median of measured / model over the measurements in each phase-angle range, the model band-averaged with the SVO NAC system responses:

| filter | λeff (nm) | n | all | 0–30° | 30–60° | 60–90° | 90–120° | 120–150° | 150–160° | 160–170° |
|---|---|---|---|---|---|---|---|---|---|---|
| BL1_CL2 | 456 | 337 | 0.84 | 0.89 | 0.85 | 0.83 | 0.89 | 0.94 | 0.78 | 0.72 |
| CL1_GRN | 569 | 320 | 0.99 | 1.04 | 1.00 | 0.98 | 1.01 | 0.99 | 0.75 | 0.72 |
| CL1_CB1 | 619 | 225 | 1.00 | 1.08 | 0.99 | 1.00 | 0.98 | 0.99 | 0.75 | 0.72 |
| RED_CL2 | 649 | 310 | 0.98 | 1.01 | 0.99 | 0.97 | 0.99 | 1.01 | 0.78 | 0.73 |
| CL1_CB2 | 750 | 260 | 0.93 | 0.97 | 0.94 | 0.91 | 0.95 | 0.97 | 0.78 | 0.71 |
| CL1_MT1 * | 619 | 706 | 0.94 | 0.96 | 0.94 | 0.92 | 0.95 | 0.97 | 0.74 | 0.73 |
| CL1_MT2 * | 727 | 282 | 0.86 | 0.87 | 0.87 | 0.84 | 0.91 | 0.96 | 0.76 | 0.73 |

\* Methane filters (5 nm wide): the model's 10 nm samples (box-averaged extinction) do not resolve them.

- Green to red continuum (GRN, CB1, RED), 0–150°: measured / model 0.97–1.08; CB2 (750 nm) 0.91–0.97; BL1 (455 nm) 0.83–0.94, the model too bright in the blue as against Karkoschka's spectrum.
- Beyond 150° every filter is measured below the model (0.71–0.78): its forward scattering through the limb is too strong. Its inputs there are the DISR phase functions at small angles and the extinction above 150 km, which DISR did not measure (the 65 km scale height extrapolated to 500 km; Titan's detached haze and season, 2004–2015, not represented).

### The renderer

The renderer's CPU twin (`atmosphere.ts` `diskReflectanceSpectral`, the tables and march of the shaders; `app/tests/render-titan.test.ts`, `docs/reports/titan-renderer.json`) against the same reference, every sample its own bin (range over the 48 samples, and the median):

| α | 6° | 10° | 20° | 30° | 40° | 50° | 60° | 70° | 80° | 90° | 100° | 110° | 120° | 130° | 140° | 150° | 155° | 160° | 163° | 166° | 169° |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| min | 0.99 | 0.99 | 0.97 | 1.00 | 0.98 | 0.98 | 0.97 | 0.95 | 0.94 | 0.94 | 0.90 | 0.91 | 0.90 | 0.88 | 0.86 | 0.82 | 0.83 | 0.83 | 0.86 | 0.89 | 0.91 |
| median | 1.04 | 1.04 | 1.04 | 1.03 | 1.02 | 1.01 | 1.01 | 1.00 | 1.00 | 0.98 | 0.97 | 0.96 | 0.95 | 0.95 | 0.91 | 0.89 | 0.89 | 0.90 | 0.92 | 0.94 | 0.96 |
| max | 1.08 | 1.08 | 1.08 | 1.07 | 1.08 | 1.05 | 1.05 | 1.05 | 1.08 | 1.05 | 1.10 | 1.08 | 1.07 | 1.06 | 0.99 | 0.95 | 1.05 | 0.99 | 0.98 | 0.99 | 1.01 |
| reference 1σ | 0.02 | 0.02 | 0.02 | 0.02 | 0.02 | 0.02 | 0.03 | 0.03 | 0.03 | 0.03 | 0.03 | 0.04 | 0.04 | 0.04 | 0.04 | 0.03 | 0.03 | 0.03 | 0.03 | 0.03 | 0.02 |

The reference's own noise per sample and phase bin (last row: its median over the samples, 2–4 %) accounts for much of the spread between min and max; the median over the 48 samples is the renderer's systematic error, known to about 0.6 %.

Against Karkoschka at 5.7° (pass: within 2σ = ±8 % per channel; the renderer at 6.04°, where its light differs from that at 5.7° by about 0.1 %): with the app's 12 bins of 4 samples X, Y, Z, S = 1.017, 1.018, 1.126, 1.057 of observed (1.033, 1.029, 1.120, 1.060 with every sample its own bin), that is 1.024, 1.028, 1.033, 1.028 of the reference: the renderer's own approximation adds 2.4–3.3 % at this phase. Colour x, y 0.3717, 0.3745 against 0.3811, 0.3838 (Δu′v′ 0.0060). X PASS (+1.7 %), Y PASS (+1.8 %), Z FAIL (+12.6 %), S PASS (+5.7 %).

Against the ISS phase curves (pass: each range's median within 2σ = ±20 %; measured / renderer):

| filter | all | 0–30° | 30–60° | 60–90° | 90–120° | 120–150° | 150–160° | 160–170° | result |
|---|---|---|---|---|---|---|---|---|---|
| BL1_CL2 | 0.83 | 0.87 | 0.83 | 0.82 | 0.91 | 0.98 | 0.84 | 0.77 | FAIL (160–170°) |
| CL1_GRN | 0.99 | 1.00 | 0.98 | 0.98 | 1.03 | 1.06 | 0.84 | 0.78 | FAIL (160–170°) |
| CL1_CB1 | 1.00 | 1.04 | 0.97 | 1.00 | 1.02 | 1.07 | 0.85 | 0.80 | FAIL (160–170°) |
| RED_CL2 | 0.97 | 0.98 | 0.97 | 0.97 | 1.04 | 1.09 | 0.89 | 0.82 | PASS |
| CL1_CB2 | 0.92 | 0.94 | 0.91 | 0.91 | 0.97 | 1.06 | 0.88 | 0.82 | PASS |
| CL1_MT1 | 0.93 | 0.94 | 0.92 | 0.93 | 0.99 | 1.05 | 0.83 | 0.79 | FAIL (160–170°) * |
| CL1_MT2 | 0.86 | 0.87 | 0.86 | 0.83 | 0.92 | 1.01 | 0.86 | 0.80 | PASS * |


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
- Titan: Not included: the detached haze layer near 500 km (seasonal; it vanished in 2012-2016), latitude/season variation of the haze (north-south asymmetry, polar hoods), clouds, methane Rayleigh scattering as its own species (counted as N2), the temperature dependence of methane absorption, gases other than N2 and CH4.
- Venus: Not included: CO2 Rayleigh scattering above the cloud tops (column above Hansen & Hovenier's 50 mb τ = 1 level ≈ 7.8e+27 m^-2 with the NSSDCA surface gravity, τ ≈ 0.009 at 550 nm), the UV absorber and SO2 (disk colour: photometry.json), the lower clouds, latitude variation (polar collar), mode 1 / mode 3 particles.
- Pluto: Not included: the ~20 discrete haze layers, the north-south asymmetry, gas Rayleigh scattering (~13 µbar: negligible).
