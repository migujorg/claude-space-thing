# Earth: surface, clouds, sea, night lights and atmosphere

Earth is drawn from its measured layers instead of from its disk photometry: the surface, its clouds and
their optical thickness, open water with its sun glint, sea ice, night lights, and the air above them. This
file covers each part: what it computes, from which data, and with which published model. The eye model is in
[eye-model.md](eye-model.md); the other renderer parts are in [rendering-m2.md](rendering-m2.md).

Code:

- `app/src/render/earth.ts`: the reference model (surface, sea ice, clouds, glint, night lights).
- `shaders-earth.ts`: its WGSL mirror.
- `atmosphere.ts`: atmospheres.json → model, precomputed tables, and CPU references of the per-pixel march.
- `atmosphereMs.ts`: multiple scattering by orders of scattering, for an optically thick haze (Titan, §8).
- `atmosphere.worker.ts`: computes the tables off the main thread.
- `atmosphereGpu.ts`: packs the tables into a texture.
- `shaders-atmosphere.ts`: the per-pixel march.
- `shaders.ts`: the Earth body variant `EARTH_BODY_SHADER`, `ATMOSPHERE_SHELL_SHADER`, the aerial-perspective
  columns `AP_COLUMNS_SHADER` and the limb transmittance of light from beyond (`LIMB_WGSL`, used by the star
  cull and the sky background).

Tests: `app/tests/render-earth.test.ts`, `render-atmosphere.test.ts` (TEST FIXTURE atmosphere) and
`render-earth-energy.test.ts` (real products, §6), `render-titan.test.ts` (real products, §8 "Titan"). Test page: `render-test.html?scene=earth-data&sun=lat,lon&obs=lat,lon&dist=km`.
Any of `map|clouds|water|night|wind|atm=0` switches a part off; `skip=ap` marches every pixel instead of the
columns, `skip=limb` leaves stars undimmed, `stars=N` adds N TEST FIXTURE stars, `bench=N` reports median pass times.

## 0. Inputs

| Input | Layer / file | Used for |
|---|---|---|
| Surface reflectance | `surfaces/399/albedo`: kind `relative-reflectance`, header `normalization.absoluteDiskMean` | texel × absoluteDiskMean = absolute reflectance factor (MODIS NBAR on land; water-leaving reflectance π·Rrs over water) |
| Clouds | `surfaces/399/clouds`: kind `cloud-properties` (cloudFraction, opticalThickness, cloudTopHeightM, iceFraction; VIIRS CLDPROP, 2026-09-28 daytime overpass) | cloud reflection and transmission (§2) |
| Cloud τ statistics | `surfaces/399/cloudTau`: kind `cloud-optical-thickness-moments` (tauRetrievedFraction, lnTauMoment1, lnTauMoment2, iceTauFraction; the same samples) | which share of the cloud has an optical thickness, and its ln τ distribution (§2) |
| Water | `surfaces/399/water`: kind `surface-water` (waterFraction, seaIceFraction) | glint, sky reflection, sea ice (§1, §3) |
| Wind | `surfaces/399/wind`: kind `surface-wind` (10 m speed: AMSR3 ascending ~13:30, daily mean, passes) | glint width (§3) |
| Night lights | `surfaces/399/night`: kind `emitted-radiance` (VIIRS Black Marble DNB radiance; header `constants.toXYZS`) | emitted light (§5) |
| Atmosphere | `atmospheres.json` → `bodies["399"]` (molecules, ozone, aerosol; 360–830 nm) | §4 |

Earth mode starts when a body's albedo layer has `absoluteDiskMean` and its cloud layer is bound. A
surface-only map is never scaled by the disk photometry, which includes clouds and air. Without the cloud
layer the map is dropped, with a warning. The shell (`app/src/app/extras.ts`) passes the map, clouds,
water, night and wind only when the atmosphere is also admitted at the reality level (it is `estimated`, so
Strict shows the disk photometry instead). It also needs the loader to put `atmospheres.json` into
`LoadedData.atmospheres`.

The unresolved Earth stays a point of its measured disk photometry. §6 compares the two.

## 1. Surface

The surface is a Lambert reflector of the map's absolute reflectance. MODIS NBAR is the nadir-view
reflectance at the local-noon Sun. Land BRDFs (hot spot, forward scattering) are not modelled: per-pixel
kernel weights (MCD43A1) are not in the layer.

**Sea ice** covers `seaIceFraction` of a texel's water (NaN: no ice analysed there, i.e. none). It has a
visible albedo of 0.96, taken as spectrally flat and Lambertian: snow-covered first-year ice in spring,
thick snow, SON, λ < 700 nm (Brandt, Warren, Worby & Grenfell 2005, J. Climate 18, 3606, Table 3). This is
an assumption for all sea ice, so its light is estimated. Alternatives in the same table: thin snow on
first-year ice 0.85–0.94, bare first-year ice 0.54–0.67. Perovich et al. (2002) measured 0.4–0.65 for Arctic
summer ice with melt ponds.

**Unknown surface** (albedo texel unknown, not ice) contributes no light. Under clear sky that share of the
pixel is marked "not measured" (hatched when it is over half the pixel); under a cloud only its transmitted
share is missing.

## 2. Clouds

Each texel holds a cloud fraction C, the in-cloud optical thickness τ at 0.65 µm, the cloud-top height and
the share of ice-phase retrievals.

**Reflection and transmission** use the δ-Eddington two-stream solution for a non-absorbing layer over a
black surface (Joseph, Wiscombe & Weinman 1976; the conservative closed form was re-derived with sympy,
`R − candidate = 0`):

R(μ0) = [(1 − g)τ + (2/3 − μ0)(1 − e^{−τ'/μ0})] / [4/3 + (1 − g)τ], with τ' = (1 − g²)τ,

- T(μ0) = 1 − R(μ0).
- The spherical albedo r̄ = 2∫R(μ)μ dμ uses 4-point Gauss–Legendre.
- The direct view transmission is e^{−τ'/μ}.

**Asymmetry parameter g** is the one the retrieval itself assumed, so the retrieved τ reproduces the
reflectance the satellite measured:

- **Liquid clouds: g = 0.867.** Mie theory (scripted with miepython) with the water refractive index of Hale &
  Querry (1973) and the modified-gamma distribution (v_e = 0.10) of the MODIS/VIIRS retrieval (Platnick et al.
  2017). At 550 nm this gives g = 0.860, 0.867 and 0.873 for effective radii of 8, 12 and 20 µm; at 650 nm,
  0.857–0.872. The 12 µm value is used.
- **Ice clouds: g = 0.75.** Severely roughened aggregated columns (Yang et al. 2013), the Collection 6 ice
  model (Platnick et al. 2017), which the VIIRS CLDPROP product continues.
- **Mixed-phase texels** take g linear in the ice share.

**Angular distribution.** Light leaving a cloud diffusely follows the escape function
u(μ) = (3/7)(1 + 2μ) (van de Hulst 1980; Kokhanovsky 2004), normalised like a Lambert surface.

**Surface under the cloud.** It is lit by T(μ0), with multiple reflection 1/(1 − R_s·r̄) between it and the
cloud base, and is seen through the direct view path plus the diffuse part (1 − r̄ − t̄_dir)·u(μ).

**Energy.** A non-absorbing cloud over a white surface reflects all the light (tested to 10⁻⁶).

**Unknown values.**

- Cloud state unknown (all NaN, poleward of the daylit band: north of 78.8° N and south of 82.5° S on
  2026-09-28): the pixel is drawn clear and marked.
- Cloudy but no optical thickness: that share contributes no reflected light and is marked. With the
  `cloudTau` layer this is cloudFraction − f_τ, 39 % of the daylit cloud (below); without it, only the texels
  with no retrieval at all (2.5 % of the cloud cover). It is hatched where it is over half the pixel. With the
  `cloudTau` layer at Best and Complete, cloudFraction − f_τ instead takes the measured partly-cloudy statistic
  (estimated, below). It is no longer marked.
- The marks count only where the pixel is lit. At night only the cloud state matters, and only where
  there are lights to hide.

**What the layer cannot say (validation, M5).** In the validation case `earth-himawari9-2026` (Himawari-9,
the cloud layer's own overpass), the disk centre renders 2.1× the measured radiance and three points
near it 1.2–1.25×. The limb passes. The centre texel is 81 % cloudy with an in-cloud mean τ = 7.8 (low
cumulus, tops near 1 km), and its neighbours range from clear to τ = 20. Across the swath from 125° E to
160° E the render is about 1.4× the image. The model reproduces what the layer says there (checked on the
CPU with earth.ts): the excess is in what the layer means.

- Its cloud fraction counts the samples with a retrieved cloud top. These include partly cloudy samples,
  for which the retrieval gives no optical thickness.
- Its τ is the mean over the samples that have one.
- The renderer gives that τ to the whole cloud fraction. Where no sample has a τ (49 % of the cloudy texels
  in the swath) the share is drawn as unknown. Where only some lack one, nothing in the layer tells, and
  broken cumulus comes out too bright.
- R(τ̄) ≥ the mean of R(τ) adds to it (the plane-parallel bias, Cahalan et al. 1994, J. Atmos. Sci. 51,
  2434).

A fix needs two things from the pipeline: the share of samples with an optical-thickness retrieval (the rest
of the cloudy share is then unknown), and preferably the mean of ln τ (Cahalan et al.'s effective
thickness). The renderer change is then small. The 8-px blocks in the rendered case are the glint: the wind
layer's resolution and swath gaps (§3; clear water where the wind is unknown gets no glint).

**The `cloudTau` layer.** It is built from the
same 16 samples per texel as `clouds` (the rebuilt `clouds` tiles are bit-identical to the previous build),
float16 × 4:

- `tauRetrievedFraction` f_τ is the share of samples with an optical-thickness retrieval, 0 ≤ f_τ ≤
  cloudFraction. The cloudy share without a thickness is cloudFraction − f_τ; its thickness is unknown. GIBS
  serves no cloud mask and no partly-cloudy thickness (CLDPROP's `_PCL` fields), so nothing finer can be said.
- `lnTauMoment1` = Σ ln τ_i / N and `lnTauMoment2` = Σ (ln τ_i)² / N are taken over the retrieved samples, with N
  all samples of the texel. So mean ln τ = m1 / f_τ, and var ln τ = m2 / f_τ − (mean ln τ)².
- `iceTauFraction` is the share of samples with an ice-phase retrieval.

Every channel is a per-sample average, so the pyramid's 2×2 means are exact at every level. A coarse texel's
variance includes the spread between its texels. That is unlike `clouds`, whose in-cloud means are averaged
without their counts. ln τ is taken at each colour-map bin's geometric centre: ±0.018 above τ = 1, but the bin
0.01–1 is taken as τ = 0.1, ±2.3 in ln τ.

The layer measures the problem directly. In the daylit globe, 39 % of the cloud fraction has no thickness
(μ0-weighted). In the validation swath (40° S–40° N, 125–160° E) it is 47–50 %, depending on the weighting:
41 % of the cloudy texels have no retrieval at all and 30 % have some. At (0°, 140.7° E), for example,
cloudFraction = 0.94 but f_τ = 0.06.

For the part that has a thickness, the header's `diagnostics.planeAlbedoCheck` compares the plane albedo
× f_τ (δ-Eddington, overpass Sun) from the moments with the independent-pixel mean of R(τ_i). The figures
are bias, then the mean absolute error per texel:

| | level 4 (4.9 km) | level 0 (78 km) |
|---|---|---|
| R(linear mean τ) | +3.0 %, 3.0 % | +13–14 %, 13–14 % |
| R(exp mean ln τ) | −0.1 to −0.3 %, 1.1–1.2 % | −0.3 to −0.5 %, 3.3–3.7 % |
| 3-point log-normal (nodes μ, μ ± √3σ; weights 2/3, 1/6, 1/6) | +0.1 %, 0.2–0.3 % | +0.5 %, 0.8 % |

The first row is the plane-parallel bias. The log-mean alone is nearly unbiased; the log-normal from both
moments also holds per texel at coarse levels.

**How the renderer uses it (M5).** Where the moments are known (`earth.ts cloudLogNormal`, mirrored in
`shaders-earth.ts`):

- The retrieved share f_τ of the pixel is a log-normal in τ: ln τ has mean m1/f_τ and variance m2/f_τ −
  mean². It is drawn as three sub-pixels at τ = exp(μ), exp(μ ± √3σ) with weights 2/3, 1/6, 1/6 (the 3-point
  Gauss–Hermite rule), each with the full two-stream cloud (reflection, transmission to and from the surface,
  multiple reflection, glint through thin cloud). Against a 400-point integral of the plane albedo it is within
  0.05 % for σ(ln τ) = 0.5 and within 0.6 % for σ = 1 (τ ≥ 3); for σ = 1.4 on thin cloud it reaches 1–3 %. The
  ice share among the retrievals (iceTauFraction/f_τ) sets g.
- The rest of the cloud, cloudFraction − f_τ, has no measured thickness for its own samples. GIBS serves no
  partly-cloudy thickness for them.
  - At Strict it gets no τ: it reflects nothing and is marked unknown (hatched where it is over half the pixel).
  - At Best and Complete it is a second population, with the measured partly-cloudy τ distribution of the
    header's `unmeasuredTau` statistic (below), labelled **estimated** in the body's worst label and tint.
    Its probabilities are taken bin by bin (`earth.ts unmeasuredTauPopulation`; empty bins dropped), as
    sub-pixels with liquid g, in the same two-stream layer as the retrieved part. The renderer's plane albedo
    R̄ = Σ p_k R(τ_k) is 0.35599, 0.23700, 0.16705, 0.12035 and 0.08673 at μ0 = 0.2–1.0. The header's
    `planeAlbedoLiquid` check values are 0.356, 0.237, 0.1671, 0.1204 and 0.0867.
- Without the layer (older data), the clouds layer's mean τ applies to the whole cloud, as before.

Validation (`earth-himawari9-2026`, Himawari-9 over the cloud layer's own overpass):

| ROI | before | after |
|---|---|---|
| disk centre | 2.08 | 1.03 |
| near-centre points | 1.17–1.25 | 0.79, 0.91, 0.99 |
| limb | 0.99 | 0.99 |

The disk centre's agreement is partly coincidental: at (0°, 140.7° E) the texel has cloudFraction 0.94 and
f_τ 0.06, so most of that pixel is unknown and hatched. It shows only the retrieved cloud, the clear sea and
the air. For the same reason the EPOXI Earth of 2008 (whole disk at 75° phase, the app's cloud day standing
in for 2008) now renders at 0.85 of its measured disk brightness and 0.62 at its centre, against 1.07 and
1.01 when the clouds layer's mean τ was spread over the whole cloud. That was the overestimate this layer
removes. What is missing now is the light of the cloud whose thickness is not measured.

**With the partly-cloudy statistic at Best** (the second population above), the same cases give:

| ROI | unknown (Strict rule) | with the statistic |
|---|---|---|
| Himawari disk centre | 1.03 | 1.47 (fail) |
| Himawari near-centre points | 0.79, 0.99, 0.91 | 1.29, 1.01, 1.36 |
| Himawari limb (Y) | 0.99 | 1.00 (Z 1.11, just outside its tolerance) |
| Himawari terminator | 0.71 | 0.57 |
| EPOXI Earth, whole disk | 0.85 | 0.94 (pass) |
| EPOXI Earth, centre | 0.62 | 0.92 (pass) |
| EPOXI Moon/Earth ratio | 0.111 (0.1016 ± 0.0014) | 0.1010 (pass) |

The whole-disk case now passes. The texels at Himawari's centre do not: they are 81–94 % "cloudy" with
f_τ = 0.06, yet in the image they are about as dark as the clear sea under the air. Their cloud without a
retrieval is much thinner than the global partly-cloudy mean (τ_g 1.24). Even with no light from it, the centre
renders 1.03. A regional or per-texel statistic would be needed there. At the terminator the unknown share
was drawn as clear air over a black surface. That air reached the ground, whereas air over a cloud stops at
its top, so 0.71 was too bright for the wrong reason.

**A statistic for the unmeasured share (`cloudTau.json` → `constants.unmeasuredTau`; for Best estimate).**
Most cloudy samples without a retrieval are pixels that the clear-sky restoral flags as partly cloudy or cloud
edge. MODIS and VIIRS do retrieve them, but report the result in `_PCL` fields, and for VIIRS NOAA-20 GIBS
serves none of these. The table is the measured global τ distribution of MODIS partly cloudy pixels: July 2021,
MODIS C6.1 Level-3 COSP product, read from Fig. 7 of Pincus et al. (2023) (docs/sources/pincus-2023-modis-cosp.md;
`pipeline/src/pipeline/cloud_pcl.py`).

- **Partly cloudy, all heights** (`statistics.floorCellsZero.partlyCloudyAllHeights`):

  | τ bin | 0–0.3 | 0.3–1.3 | 1.3–3.6 | 3.6–9.4 | 9.4–23 | > 23 |
  |---|---|---|---|---|---|---|
  | probability | 0.042 | 0.468 | 0.335 | 0.132 | 0.024 | 0 |

  ln τ has mean 0.21 and σ = 1.17 (τ_g = 1.24). The population is 91.5 % low (pc ≥ 680 hPa) and 3.5 % ice.
  For comparison, fully cloudy pixels in the same figure have τ_g = 6.9, and our own VIIRS retrievals of the
  day have τ_g = 8.3.
- **How to apply it** (`constants.use.unmeasuredShare`): at Best, give the share cloudFraction − f_τ this
  distribution as a separate population, labelled **estimated**; at Strict it stays unknown.
  - The plane albedo is R̄ = Σ_k p_k R(τ_k) over the seven bins, with τ_k = exp(`tauBinLnCentre[k]`); this
    assumes no shape. Alternatively, use a log-normal with these μ and σ through the same 3-point rule as the
    retrieved part.
  - Use liquid g. Do not give this share the texel's own retrieved distribution, which is biased to overcast cloud.
  - `planeAlbedoLiquid` lists R̄ at μ0 = 0.2–1.0 for checking. The bin sum gives 0.356, 0.237, 0.167, 0.120 and
    0.087 at μ0 = 0.2, 0.4, 0.6, 0.8 and 1.0. The log-normal agrees to 1–3 % up to μ0 = 0.6 and is 6–10 % higher
    at μ0 = 0.8–1, because the measured distribution has no mass above τ = 23. R(τ_g) is 30–40 % too low there.
    So the bin sum is the one to use.
- **Why a partly-cloudy τ fits a whole sample:** a partly cloudy pixel's τ is retrieved as if the pixel were
  overcast, i.e. it is the plane-parallel τ that gives the pixel's mean reflectance.
- **Caveats** (reasons for the estimated label):
  - The histogram holds only successful partly-cloudy retrievals. About 34 % of global over-ocean liquid PCL
    attempts fail (Platnick et al. 2017), and failed overcast retrievals and pixels restored to clear are also
    in our share; the same τ is assumed for them.
  - It is one month, global, MODIS rather than VIIRS, with no regional dependence.
  - The palest histogram cells cannot be read. `floorCellsAtFloor` bounds that effect: τ_g up to 1.77,
    σ up to 1.73.

**Not modelled.** Cloud parallax and cloud shadows on the ground. The cloud-top height is used only to
place the cloud's reflection inside the atmosphere (§4). Also not modelled: 3D cloud effects, the glory,
and cloud-bow phase features (the two-stream albedo has no phase function).

## 3. Open water: sun glint and sky reflection

The map holds only the water-leaving light. The surface reflection adds two terms.

**Sun glint.** Cox & Munk (1954, JOSA 44, 838; their text was checked) give N = ρ(ω)·p·H /
(4 cos μ cos⁴β):

- p = e^{−tan²β/σ²}/(πσ²) is the isotropic slope density.
- σ² = 0.003 + 5.12·10⁻³·U, with U at 12.5 m (clean sea).
- ρ(ω) is the Fresnel reflectance of unpolarised light for n = 1.338, as Cox & Munk used.
- β is the facet tilt and ω the incidence on the facet.

As a radiance factor: ρ_glint = ρ_F(ω)·e^{−tan²β/σ²}·S / (4σ²·μ·cos⁴β).

Choices and references for the glint:

- **Shadowing.** S is the bidirectional shadowing 1/(1 + Λ(μ0) + Λ(μ)) of Smith (1967) as used by Sancer
  (1969). Without it the radiance diverges at grazing angles; a crescent Earth first rendered with
  adaptation 6·10⁷ cd/m².
- **erfc** comes from Abramowitz & Stegun 7.1.26.
- **Wind.** The wind layer gives U10: the AMSR3 ascending pass (~13:30 local, like the clouds), else the
  daily mean. The choice is made per texel, then the texels are interpolated (M5). Choosing per pixel after
  interpolation switched sources in steps where the ascending swath ended: blocks of different glint in the
  validation case `earth-himawari9-2026`. It is taken as U(12.5 m) = 1.02·U10 (the layer header's neutral
  log profile). The layer is level 2 (0.18°, ~20 km); the passive-microwave winds behind it are coarser
  still, so the glint varies in blocks of a few tens of km.
- **Direction.** Wind direction is not in the layer, so the up/cross-wind anisotropy and the Gram–Charlier
  terms are left out.
- **Thin clouds.** The glint is seen through them in the unscattered beam both ways.
- **Tests.** The hemispheric albedo of the glint is 0.9–1.15 × ρ_F (tested at 20° Sun, 5 m/s).

**Sky reflection.** Diffuse skylight is reflected with the hemispheric mean Fresnel reflectance,
2∫ρ_F(μ)μ dμ = 0.066 (derived), taken as isotropic. The mirror image of the sky's radiance distribution is
not modelled.

**Unknown wind** (land, coasts, rain, swath gaps: 52 % of the globe). No glint is drawn. The open water is
marked only where a measured wind could make the glint outshine the pixel's known light. Cox & Munk's
clean-surface data span 0.7–13.8 m/s; the largest glint within that range, through both atmospheric paths, is
compared with the rest of the pixel. Far from the specular point an unknown wind does not matter and nothing
is marked.

## 4. Atmosphere

**Method.** Hillaire (2020, "A Scalable and Production Ready Sky and Atmosphere Rendering Technique",
Comput. Graph. Forum 39(4)), with the table parameterisations, point-to-point transmittance and horizon
treatment of Bruneton (2017, "Precomputed Atmospheric Scattering: a New Implementation", the reference
code of Bruneton & Neyret 2008).

Alternatives:

- Bruneton & Neyret's full 4D scattering tables: exact multiple scattering, larger, slower to build.
- Brute-force multiple scattering per pixel: too slow.

Hillaire's approximation treats scattering orders ≥ 2 as isotropic, with the same illumination near each
point. He reports errors of a few percent against path tracing for Earth.

**Data.** atmospheres.json gives, for each component on a 1 km altitude grid to 86 km:

- β_ext(λ), linear in altitude;
- the single-scattering albedo ω(λ);
- the phase function: Rayleigh with depolarisation, Henyey–Greenstein, double HG or tabulated.

Earth has molecules (τ = 0.097 at 550 nm), ozone (0.031) and aerosol (HG, 0.122). The renderer merges the 48
samples (360–830 nm) into 12 bins of 40 nm. Fold weights are summed; coefficients and phase functions are
averaged with each sample's sunlight × observer importance. Scattering = ω·β_ext and absorption =
(1 − ω)·β_ext. Phase functions become per-bin tables at 1°.

**Tables** (spectral, per unit solar irradiance, computed in a worker: 3.6 s in Node for Earth). Each is
stored as rgba16float, four bins per texel:

- transmittance to the top, 256 × 64;
- multiple scattering Ψ_ms, 32 × 32 (64 directions × 20 steps, ground reflectance below);
- sky irradiance on a horizontal surface, 64 × 16;
- a per-altitude profile, 256 samples;
- the particle phase table.

The ground reflectance under the atmosphere, for Ψ_ms, is the Lambert-equivalent 1.5·p of the measured
disk photometry, the relation planetshine.ts uses, per channel: each bin takes the value of the X, Y or Z
channel whose fold weight is largest there, capped at 1 (1.5·p exceeds 1 for Venus). It includes the air
itself, a small double count.

**Per pixel.** The view segment from the surface point back to the top of the atmosphere is marched in 32
steps. Each step adds single scattering (the species' phase functions, sunlight through the
transmittance table, the solar disk sinking below the horizon) and Hillaire's σ_s·Ψ_ms, integrated
analytically over the step. Altitude is measured above the ellipsoid (|p| − |p|/|Mp|); the tables are
spherical around it. The march also records the part above the cloud tops.

The pixel is then composed, per bin, folded into XYZS with the fold weights:

- **Clear part:** path radiance + T_view·(ρ_dir·T_sun(0) + ρ_dif·E_sky(0));
- **Cloudy part:** path radiance above the cloud tops + T_view,above·(ρ_dir·T_sun(h_c) + ρ_dif·E_sky(h_c));
- **Unknown part:** path radiance only.

ρ_dir and ρ_dif are the Earth model's radiance factors for direct sunlight and for diffuse skylight. Each
part is taken as spectrally flat within an XYZS channel (exact for grey clouds).

**δ-scaled view transmittance (M5).** A particle's forward-scattering peak sends a surface's light on
along (almost) its own path. For aerosol and dust (g ≈ 0.7) the peak is a few degrees wide, a fraction of
a km on the ground from the scattering altitude, so the light stays in the pixel. T_view for the surface
and cloud radiance therefore uses the δ-M extinction σ_ext − f·σ_s,particle (Wiscombe 1977, M = 2: f = χ₂,
the second Legendre moment of the particle phase function, = g² for Henyey–Greenstein; `atmosphere.ts
particleDeltaFraction`). The path radiance, sunlight and skylight keep the full phase functions.
Mars dust has f ≈ 0.5, so T_view at 0° phase rises from 0.53 to 0.69 of the airless disk. Images under
dust keep more contrast, and the disk renormalisation keeps the total.

**Aerial-perspective columns (M5).** Marching every pixel is most of the cost (§7). Following Hillaire's
(2020) aerial-perspective volume, a compute pass (`AP_COLUMNS_SHADER`) marches the view path once per
column of c × c pixels, c = ⌈frame height / 270⌉ (at least 2), and the pixels interpolate. Hillaire slices the
camera frustum by distance, for views from inside the air. Seen from outside, what changes along a column's
path toward the surface is the altitude, so the slices here are by altitude. For each slice altitude h_k the
texture (rgba16float, 3D) holds the path radiance folded to XYZS and the δ-scaled transmittance per bin of
the part of the path above h_k:

- h_0 = 0 is the whole path (the clear part and the night lights);
- Earth adds 1, 2, 3, 4, 6, 8, 10, 13 and 16 km, the range of its cloud tops. A pixel reads the two slices
  around its cloud-top height and interpolates linearly. Other bodies use only h_0.

A pixel interpolates its four surrounding columns bilinearly. If any of them missed the body (at the limb), it
marches itself. The slice altitudes and the column size are sampling choices. Against the per-pixel march at
640 × 360, the 8-bit output differs by at most 15/255 on Earth (mean 0.2; cloud edges, where the cloud-top
height varies within a column) and 3/255 on Mars.

**Limb.** Rays that miss the solid Earth go through `ATMOSPHERE_SHELL_SHADER`. It marches the chord through
the top sphere from its closest point to the centre, computed without cancellation at large distance.
Pixels partly covered by the Earth get the uncovered share. The shell is additive and depth-tested, with no
depth write.

**Stars behind the limb (M5).** A star seen through the shell is dimmed by the transmittance of its chord.
The optical depth of the chord through the shell, for a ray whose closest approach is at impact altitude h, is

  τ_k(h) = 2 ∫₀^L σ_ext,k(√(r_h² + s²) − R) ds, with r_h = R + h and L = √(r_top² − r_h²).

`atmosphere.ts limbChordTable` tabulates it at 64 altitudes from the bottom to the top. It uses full
extinction, not δ-scaled: the forward peak is degrees wide and spreads a star's light far beyond its image.
The table is folded to XYZS as the effective optical depth −ln Σ_k w_ck·e^{−τ_k}. The fold weights make this
exact for a spectrum like the Sun's; for other stars it is an approximation. The star cull (`CULL_SHADER
limbTransmittance`) finds each point source's closest approach in the body's unit-sphere frame, reads the
table (log-linear in h), and multiplies the source's XYZS. A ray that meets the solid body gives 0. The sky
background (Milky Way, faint stars, zodiacal light: `sky/background.ts`) is dimmed the same way per pixel,
the zodiacal light included, since nearly all of it comes from beyond the planet.

Comet comae and tails (`comets/`) are at a finite distance, so they use `limbTransmittanceTo(u, D)`: a limb
counts only when the source lies beyond the ray's closest approach to that body. A comet in front of a planet
is not dimmed. Test page: `scene=earth-data&comet=behind|front&cometd=<km>&cometin=<deg>` places the TEST
FIXTURE comet with its tail across the Earth's limb; `hdrgrid=N` logs the HDR luminance for comparison.
With the nucleus 45 000 km beyond the Earth, the tail light between the surface and 75 km is 0.93 of that
without the limb term (2-px bins, 43 km each). Above 75 km it is unchanged, and so is every pixel of the
comet placed in front.

This applies to the nearest four measured atmospheres that are drawn, with the camera above their top. Stars
seen from inside an atmosphere are not dimmed (extinction by airmass is not modelled). The test page's
`stars=N&skip=limb` compares with and without. From 8 000 km with 500 000 TEST FIXTURE stars, a star just
outside the solid limb is no longer drawn, and the stars behind the disk are dropped at the cull instead of
by the depth test (57 871 → 19 944 drawn). The test checks the table against the Chapman grazing
approximation τ ≈ σ(h)·√(2π r_h H_s) for an exponential TEST FIXTURE atmosphere, within 2 % in transmittance.

**Titan.** See §8.

**Not modelled.**

- Refraction: the eclipse ring comes out blue from high-altitude Rayleigh scattering, not red from light
  refracted into the shadow. Stars behind the limb are dimmed but not displaced or flattened, although a
  ray grazing the surface is bent by about twice the refraction at the horizon (≈ 35′), over a degree.
  atmospheres.json gives extinction and scattering, not refractivity.
- O₂ and H₂O bands (omitted in the data).
- Multiple bounces between the surface and the air, beyond the ground term of Ψ_ms.
- Clouds affect only their own pixel, not the air around them.
- Eclipse shadows on the air: the march has no occluders, so during a solar eclipse the ground in the Moon's
  umbra is dark but the sky above it keeps its daylight path radiance. The Moments eclipse view is therefore
  placed just above the atmosphere (src/app/events/finder.ts).

## 5. Night lights

Radiance (nW cm⁻² sr⁻¹) × the header's luminance factors for CIE HP1 (high-pressure sodium). The lamp
spectrum is not measured, so the colour is estimated. The alternative, CIE LED-B3, differs by 3 % in Y and
mostly in colour. The light passes through the clouds (the emission transmission of §2, with multiple
reflection) and the view path's transmittance.

Open ocean and other areas without a Black Marble value emit nothing. That is an absence of data, not a
claim, so it is not marked: marking it would hatch most of the night side.

## 6. Energy check

`render-earth-energy.test.ts` integrates the model over the disk at the Himawari-9 reference geometry
(sub-satellite 140.7° E, phase 2.42°) and compares the result with photometry.json 399, which is Himawari-9
2025-03-20 02:30 UTC, α = 2.42°. The ratio is reported, not forced:

| Model | A (X, Y, Z, S) | Ratio to measured |
|---|---|---|
| Surface + clouds, no atmosphere (level 1) | 0.179 0.178 0.182 0.180 | 0.74 0.75 0.59 0.67 |
| + atmosphere, glint, sky reflection (level 0) | 0.215 0.214 0.271 0.243 | 0.89 0.90 0.88 0.91 |
| Measured p·Φ(2.42°) | 0.241 0.238 0.308 0.269 | 1 |

With the atmosphere the colour matches: all four channels come out 0.88–0.91 of the measurement (with the
δ-scaled view transmittance). The remaining 9–12 % is within the photometry's stated variability: the disk reflectance changes by 10–20 %
with clouds and the hemisphere in view, and the clouds here are from a different day, 2026-09-28. Model
approximations also contribute:

- Lambert land;
- two-stream clouds without a glory or phase features, which matter at 2.4° phase;
- clouds as a layer at their top.

The unknown share of the disk is 1 %.

## 7. Cost

Per Earth pixel: 32 steps × (profile 3, transmittance 1, multiple scattering 1) texture samples per 4 bins,
i.e. 480 filtered samples, plus the cloud and surface lookups.

On SwiftShader at 960 × 540 with the Earth covering about 40 % of the frame, the per-pixel march made
bodies+rings take 13 s, against 1.3 s without the atmosphere. On a desktop GPU this is estimated at
≈ 2–4 ms at 1080p and 8–15 ms for a 4K frame filled by Earth.

**Aerial-perspective columns (M5, §4).** The march now runs once per column: 1/c² of the pixels (c = 3 at
720p, 4 at 1080p, 8 at 4K), plus the pixels at the limb. Each pixel then makes 4 × 3·(1 + K/4) texel
loads (four columns; the two slices around the cloud tops and the whole path), 48 for K = 12 bins, instead of
32 steps × 5 filtered samples × K/4. Measured on SwiftShader at 1280 × 720, with frames alternating between
columns and per-pixel march under the same load (`bench=4&benchab=ap`, median):

| View | Per-pixel march: bodies+rings | Columns: aerial perspective + bodies+rings |
|---|---|---|
| Earth, 45 000 km (§6 geometry) | 27.3 s | 1.8 + 17.2 s (−30 %) |
| Mars, 8 radii | 15.7 s | 1.0 + 10.7 s (−26 %) |

Mars without its atmosphere takes 2.9 s. On SwiftShader most of the remaining cost is not the march:
removing the per-pixel fallback from the shader changed the Mars time by less than the run-to-run noise
(±30 %). A real GPU, where the march dominates, should gain close to c². This has not been measured in this
container, which has no GPU.

## 8. Other atmospheres

atmospheres.json has Mars (CO₂ + dust), Venus (the haze above 60 km), Pluto (haze) and Titan (N₂ +
haze + methane, over a surface reflectance). The giant planets have scale heights only, so they get no
atmosphere. Mars, Venus and Pluto are drawn from their disk photometry, which already contains the light of their
air. The same tables (§4) add the air, and the surface is renormalised so that the measurement is kept. Titan is
drawn from its model alone (below, "Titan").

**Renormalisation** (frame.ts, `atmosphereDiskFactors` in atmosphere.ts). Four disk integrals per channel,
as reflectances (1/πR²)∫ρ dA, for the body's law on a uniform surface:

- I0: the surface alone;
- Iatm: the surface under the air, i.e. ρ·T_sun·T_view plus skylight on a Lambert surface of the same scale;
- Apath: the air's own light over the disk;
- Ashell: the air's light beyond the disk edge, the shell pipeline's chords.

The surface scale K is multiplied by (1 − (Apath + Ashell)/pΦ)·I0/Iatm, so the rendered body (surface
under the air, plus the air on and beyond the disk) still reflects the measured p·Φ(α). The integrals are
cached in 1° phase bins, interpolated linearly, one integral of a few ms per new bin. The map's weighting
of the ratio I0/Iatm is left out: it is second order. The shader (`ATM_OVER_PHOTOMETRY`) draws the surface
term × T_sun·T_view, the skylight term and the path radiance, per bin, folded to XYZS.

Four outcomes, each with a warning where it applies:

1. **Over the disk and beyond** (Mars and Pluto at most phases).
2. **Beyond the disk only**, when the renormalised surface would reflect more than it receives (Bond
   albedo > 1; `lawBond` = 2∫I(α) sin α dα per unit scale). Then the surface cannot be seen under the air
   in the model, and the disk keeps its measured photometry. Only the shell is drawn, and K is reduced by
   its share, Ashell/pΦ. This is Venus: atmospheres.json starts the profile at 60 km, inside the deck, with
   τ ≈ 12 above it (the file says to use photometry.json for the reflectance there).
3. **Air brighter than a phase curve that is a model (M5).** When the air alone is brighter than pΦ in any
   channel (Apath + Ashell ≥ pΦ) and the phase function is `estimated` (`SceneBody.phaseEstimated`, set from
   its label), the curve does not hold there; the measured atmosphere is not the part in doubt. The surface
   scale is then taken at the nearest lower phase (1° bins) where the curve still exceeds the air and the
   surface's Bond albedo stays ≤ 1, and the air at α is drawn on top, as beyond the measured range. The
   warning names that phase. Examples:
   - Mars, whose curve beyond the ~47° seen from Earth is estimated: at α = 100° the scale is taken at 58°.
   - The Earth drawn from its disk photometry, whose curve is Mallama & Hilton's fit to a radiative-transfer
     model: at 175° the scale is taken at 103°, and the sunlit air ring is drawn. Earth mode with its layers
     does not use this.
4. **Not drawn**, when the air alone is brighter than a *measured* disk in any channel. Until M5 this was
   also Mars beyond α ≈ 65–70°, first in Z. (Apath + Ashell)/pΦ for X, Y, Z, S
   is 0.37 / 0.40 / 0.58 / 0.48 at α = 0°, 0.61 / 0.65 / 0.94 / 0.78 at 60° and 0.94 / 1.00 / 1.49 / 1.22
   at 95° (dust at L_s ≈ 0°, scale 0.95). In blue the dust (ω ≈ 0.8) is brighter than the dark surface, so
   the dust's light approaching the whole measured blue light at high phase is plausible, and the overshoot
   is within the climatology's spread. Two approximations also push that way: dust forward scattering of
   the surface's light sits in Hillaire's isotropic Ψ_ms, and the dust phase function has no wavelength
   dependence in the data. The data are not adjusted to make it fit.

**Beyond the measured phase range.** The photometry there is the spatial law's extrapolation
(rendering-m2.md §2), a surface model that knows nothing of the air. The surface scale is then found at
the range's edge, with the measured p·Φ there, and the air's light at α is added on top. For Pluto
(measured to 1.74°) this gives the blue forward-scattering haze ring at high phase, which the
extrapolated disk could not contain.

**Per body.**

| Body | Components | Outcome in the test views |
|---|---|---|
| Mars | CO₂ Rayleigh; dust, double HG, ω 0.71–0.98 | Over the disk to α ≈ 65°: haze softens the terminator and lowers contrast. At α = 36° the surface scale is ×0.62 / 0.57 / 0.18 / 0.41 (X, Y, Z, S; with the δ-scaled view transmittance): the blue of the disk is mostly dust light. Beyond, the surface scale of the nearest phase where the estimated curve still exceeds the air (3.). |
| Venus | the cloud and upper haze above 60 km | Beyond the disk only. Near inferior conjunction (α = 172°) the haze alone outshines the measured p·Φ: not drawn. |
| Pluto | haze (tabulated Mie phase, ω 0.944) | Over the disk; the haze is 1–2 % of the disk at low phase and forms a ring at high phase. |
| Titan | N₂ Rayleigh; DISR haze (three components, two phase functions); methane; surface reflectance | Drawn from the model, not renormalised: see below. |

**Mars dust.** atmospheres.json gives the annual global-mean column and a table of global-mean column
optical depth by solar longitude (5° bins; Montabone et al. 2015, 2020 climatology), with L_s against
ephemeris time. `marsDustScale` takes L_s at the snapshot's time, the nearest bin (on the circle) and scales
the dust extinction by the bin's mean over the annual mean. Each bin has its own tables (a few seconds in
the worker when the season changes). The latitude dependence of the column is left out: the tables are
spherically symmetric.

**Titan: drawn from its atmosphere model.** atmospheres.json gives Titan's air in full: N₂ Rayleigh, the
Huygens DISR haze (extinction of Tomasko et al. 2008; single-scattering albedo of Doose et al. 2016, below
80 km and above 200 km; phase functions of Tomasko et al., below and above 80 km), methane absorption, and the
Lambert reflectance of the surface under it (docs/reports/atmospheres.md, "Titan"). Its disk is therefore not
taken from its disk photometry: extras.ts attaches the surface (`SceneAtmosphere.surface`) when the surface
reflectance and every component are admitted, and frame.ts draws the resolved disk like Earth's, absolute:
the surface scale is K = E☉/(πd²)·ρ_c with ρ_c the surface's X, Y, Z, S equivalents and a Lambert law, the shader
(`ATM_OVER_PHOTOMETRY`) adds the sunlight and skylight through the air and the air's own light over and beyond
the disk, and nothing is renormalised. The measured brightness and colour are thus a test of the data, not an
input (results below). Until the tables are ready, or if the atmosphere cannot be drawn, the disk photometry
stands in (beyond its phase range, 0–5.7°, extrapolated with a Lambert law at Best estimate, with the usual
warning). An unresolved Titan (under 1 px) is still drawn from its disk photometry, and between 1 and 2 px the
two are blended, so a growing disk switches from Karkoschka's measurement to the model: at 5.7° the model's disk
is +2 % in X and Y, +13 % in Z and +6 % in S (below, "Against the measurements"). This is an exception to
architecture §4.3, which asks that a resolved disk's integral reproduce p·Φ(α): inside the photometry's range
Titan's does not, in Z by more than the measurement's uncertainty. Beyond 5.7° the point is the Lambert
extrapolation, which knows nothing of the haze's forward scattering: at 150° the model's disk reflects about 25
times what that point does.

**Why not Hillaire's table.** The haze is optically thick (τ ≈ 8 at 550 nm, ω 0.84–1, asymmetry 0.73–0.80).
Hillaire's per-point estimate (isotropic orders ≥ 2, infinite-series closure) gives a disk 22 % (550 nm) and 48 %
(400 nm) brighter at 6° phase than a Monte Carlo solution of the same model (the CPU twin with
`multipleScattering` left at 'hillaire'). Two variants tried while this was written are no longer in the code,
and their numbers were not measured again: with the particle scattering similarity-scaled it was 70 % too dark,
and an isotropic emission of the diffuse field's mean intensity, even from an exact solution, was off by up to
17 % at low phase or 45 % at high phase, depending on how single scattering was attenuated. The angular shape
of the multiple-scattering source matters.

**Orders of scattering** (`atmosphereMs.ts`, `AtmosphereModel.multipleScattering = 'orders'`, chosen for a body
drawn from its model). Per 40 nm bin and solar zenith cosine μs (32 values), successive orders of scattering are
summed in azimuthal Fourier terms m = 0…5:

- **Geometry**: a spherical shell lit at the column's μs everywhere ("local spherical symmetry"). The direct beam at
  every level is the table's spherical transmittance to the Sun. Each of 2 × 8 Gauss streams crosses each layer
  along its straight path in the shell, its radiance at the far level interpolated in μ between that level's
  streams: light travelling near the horizontal climbs out of the haze, as it does around a sphere. A plane-
  parallel solution keeps it in the layer and made the air beyond the disk edge 15–24 % too bright (a variant no
  longer in the code; not measured again).
- **Forward peak**: the particle phase function is clipped at 16° (δ-fit; the clipped fraction f, 0.36–0.49,
  counts as unscattered). The whole path radiance is attenuated in the scaled medium (σ_t − f·σ_s,particle),
  single scattering with the full phase function and the scaled sunlight (Nakajima & Tanaka 1988, "TMS"). The
  transmittance table of an 'orders' model is the scaled one, also for the surface's sunlight.
- **Layers** of ≤ 0.04 scaled optical depth, exact exponential integration along each path, Lambert surface;
  orders summed until their ratio settles, then the geometric tail.
- **Output**: the source of the next scattering out of the diffuse field (orders ≥ 2) per unit scaled
  scattering, toward 19 view directions (every 10° from the zenith), per Fourier term: `msSource`, 32 (h) × 32
  (μs) × 6 × 19 per bin, and the downward diffuse flux as the sky irradiance. The march emits
  (σ_R + (1 − f)σ_p)·Σ_m (2 − δ_m0) J_m(h, μs, μ_v) cos mφ toward the camera (φ: azimuth from the Sun's),
  linear in h, μs and the view angle.
- **Two particle groups**: the haze has two phase functions (below and above 80 km). Particle species with the
  same table form a group (`particleGroups`; at most two, else one column-weighted table as before); the
  second group's scattering is the profile's fourth slot. Every other body has one group, so nothing changes
  for them there. One thing does: every tabulated phase function is now renormalised so that its 1° table, as
  the renderer interpolates it, integrates to 1 over the sphere (`phaseTableIntegral`; Titan's forward peak needs
  it, +0.3 to +1.1 %), which lowers Venus's cloud phase function by 0.04–0.30 % and Pluto's haze by 0.13 %.
- **GPU**: the source tiles follow the seven usual table layers (8 × 2 tiles of 32 × 32 per layer, 8 layers per
  4 bins); `Atm.ms.x` switches the march (`atmStep` in shaders-atmosphere.ts, shared by `atmMarch` and the
  aerial-perspective columns) to the source table and the scaled path; `Atm.delta2` holds the second group's f.
  Per march step and 4 bins: 12 more texture reads.
- **Cost**: 6.6 s for Titan's 12 bins (Node, the workstation; the app computes them in a worker).

Sampling choices, at 550 and 750 nm and α = 6°, 90°, 166° (measured when the solver was written; the constants
are fixed in `atmosphereMs.ts` and the variations were not run again): 16 instead of 8 streams, 10 instead of 6
Fourier terms, 37 instead of 19 view directions, layers of 0.01, a 64 × 64 table each change A_gΦ by ≤ 0.7 %.
Clip angles from 2° to 24° change it by ≤ 1.5 % at 6° and by −5 to +13 % at 166°; 16° matches the streams'
resolution (about 11°).

**Accuracy** (`app/tests/render-titan.test.ts`; docs/reports/atmospheres.md "The renderer"). Against the Monte
Carlo solution of the same model (`titan_rt.py`, every sample its own bin), the disk-integrated A_gΦ of the CPU
twin is, as the median over the 48 samples, 1.04 times the reference at 6°, 1.01 at 60°, 0.98 at 90°, 0.95 at
120°, 0.89 at 150° and 0.94 at 166°. The reference's noise is 2–4 % per sample and phase bin, so the spread
between samples (0.99–1.08 at 6°, 0.82–0.95 at 150°) is partly its noise; the medians are good to about 0.6 %.
Split at the solid limb (550 and 750 nm; the reference's noise on each part is 2–10 %): the disk is 3–6 % too
bright at 6° and 22–26 % too dark at 150°, where it is the thin crescent; the air beyond the disk is within 6 %
from 60° to 120° and 5–14 % too dark at 150–166°, where it is nearly all the light (at 6°, where it is a tenth
of the light, it is +19 % at 550 nm and −12 % at 750 nm, 3 and 1 times the noise). The local-spherical-symmetry
assumption misses the light that reaches the terminator from the sunlit side.

**The shaders against the CPU twin.** The disk-integrated light of rendered frames (the HDR buffer summed over
a 512 × 512 view, Titan 330 px across, SwiftShader, 2026-10-04) is 1.003–1.004 of the CPU twin's at 6°, 1.002
at 30°, 0.997 at 60°, 0.989 at 90°, 0.982–0.985 at 120°, 0.988–0.991 at 150° and 0.983–0.991 at 166° (X, Y, Z,
S): the shaders draw what the twin computes to within 2 %, so the twin's numbers stand for the picture.

**The two scenes** (app/e2e/scenes.json; rendered 2026-10-04, no baseline accepted yet). `titan-haze` (61°,
from 12 000 km): a tan-orange disk, brightest toward the sub-solar point, with no sharp terminator (the light
fades over about a quarter of the radius and wraps past the cusps), the haze visible to about 150 km beyond the
solid limb with a blue-grey outer fringe, the night side black. `titan-haze-ring` (170°, from 12 000 km): the
camera is inside Titan's shadow, the Sun 10° from the disk centre behind a limb that spans 12.4–14.8° (surface
to the model's top), so the scattering angle is 2–5° on the limb nearest the Sun and 22–25° on the far one.
The picture is a crescent over about ±65° of the limb, dark for the first 150–200 km above the surface (the
sunlight does not get through the lower haze), orange at 200–300 km and white-blue to 500 km; the rest of the
limb is 15 or more times fainter (the phase function between 3° and 17–24°) and black to the adapted eye. From
far away, where the scattering angle is 10° all round, the CPU twin gives a complete ring: at 350–400 km the
far limb has 0.36–0.54 of the near limb's radiance.

**The 12 bins.** Methane bands narrower than a bin are averaged in extinction, not in transmission. Against
every sample its own bin, Titan's X, Y, Z, S at 5.7° change by −1.5, −1.0, +0.5 and −0.2 %.

**The surface term** is drawn with the channel equivalents of the surface reflectance times the binned
transmittances folded per channel (a per-channel product in place of the spectral one). Seen directly, through the
δ-scaled transmittance, the surface gives under 0.01 % of the disk's light at 550 nm and 0.3 % at 750 nm (at 6°);
the rest of its light reaches the eye scattered by the haze, inside the orders' solution.

**Against the measurements** (pass: within twice the observation's 1σ). Karkoschka's (1998) full-disk albedo at
5.7° (absolute calibration ±4 %): the model itself, solved by the reference, has X, Y, Z, S = 0.994 ± 0.005,
0.990 ± 0.005, 1.090 ± 0.009, 1.028 ± 0.006 of it (± the Monte Carlo noise); the CPU twin with the app's 12 bins
1.017, 1.018, 1.126, 1.057; the rendered frame 1.022, 1.023, 1.130, 1.062. X, Y and S pass, Z fails. The
brightness is right and the colour is not: the reflected sunlight has x, y = (0.3717, 0.3745) against the
measured (0.3811, 0.3838), Δu′v′ = 0.006, bluer and less orange than Titan, and Z/Y is 10 % high, where a
calibration error common to all wavelengths cancels. 93 % of the model's Z comes from below 500 nm, where Doose
et al. give no haze albedo and it is extrapolated. At exact opposition the model is bluer still (Z rises by 12 %
from 5.7° to 0°, Y by 1 %: the backscatter peak of the 355 and 430 nm phase functions), against the 2 % in every
channel that the photometry assumes. Cassini ISS phase curves (García Muñoz et al. 2017; CISSCAL ~10 %): the
medians of measured / rendered pass in every range from 0° to 160° in BL1, GRN, CB1, RED and CB2 (0.82–1.09),
with BL1 (455 nm) at 0.82–0.88 up to 90°, the same blue excess seen by a second instrument; at 160–170° the
rendering is 22–30 % brighter than measured (BL1, GRN and CB1 fail) — its forward scattering through the upper
haze is too strong, as in the exact solution. Nothing in the model was changed for these results.

**Not done for Titan:** the change of μs along a scattering path (the terminator), Saturnshine on the haze
(planetshine lights the surface only), refraction, the methane bands at their 1 nm resolution, the detached
haze and the north–south asymmetry, a point light from the model (the point stays the disk photometry, unknown
beyond 5.7° at Strict).

**Altitude reference.** The drawn ellipsoid (bodies.json radii) is taken as the profile's lower boundary.
For Venus this puts the haze 60 km (1 %) lower than it is: the disk is drawn at the solid radius, as it
was before, and the shell adds the 50 km of haze above it.

**Shell app use.** extras.ts attaches an admitted atmosphere to any lit body with photometry. Admission
needs every known label admitted at the reality level and a known extinction. Unknown scattering does not
withhold it: the renderer then draws no light for that air, keeps the disk photometry and marks the air beyond
the disk "not measured" (the shell writes the hatch mask). No body has unknown scattering now; Titan had, until
its haze optics were added. A surface reflectance under the air (Titan's) is attached as
`SceneAtmosphere.surface` only when it and every component's albedo and phase function are known and admitted;
at Strict (estimated values withheld) Titan's atmosphere is not admitted at all and its disk photometry is drawn.

**Not done.**

- δ-scaling of the sunlight's path and of the multiple-scattering table, except for Titan's orders of
  scattering (above). Otherwise only the view transmittance of surface light is δ-scaled (§4). The skylight
  table already holds the forward-scattered sunlight, so scaling the sun path too would count it twice.
- Refraction and the Venus aureole.
- Latitude-dependent dust and seasonal hazes.
