# Earth: surface, clouds, sea, night lights and atmosphere

Earth is drawn from its dated surface layers and derived cloud aggregates instead of from its disk photometry: the surface, its clouds and
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

Tests: `app/tests/render-earth.test.ts`, `render-earth-transport.test.ts`, `render-atmosphere.test.ts` (TEST FIXTURE atmosphere) and
`render-earth-energy.test.ts` (real products, §6), `render-titan.test.ts` (real products, §8 "Titan"). Test page: `render-test.html?scene=earth-data&sun=lat,lon&obs=lat,lon&dist=km`.
Any of `map|clouds|water|night|wind|atm=0` switches a part off; `skip=ap` marches every pixel instead of the
columns, `skip=limb` leaves stars undimmed, `stars=N` adds N TEST FIXTURE stars, `bench=N` reports median pass times.

## 0. Inputs

| Input | Layer / file | Used for |
|---|---|---|
| Surface reflectance | `surfaces/399/albedo`: kind `relative-reflectance`, header `normalization.absoluteDiskMean` | texel × absoluteDiskMean = absolute reflectance factor (MODIS NBAR on land; water-leaving reflectance π·Rrs over water) |
| Clouds | `surfaces/399/clouds`: kind `cloud-properties` (cloudFraction, opticalThickness, cloudTopHeightM, iceFraction; SatCORPS composite, a mosaic of the 13:30 local hours of 2026-09-28) | cloud fraction and top height (§2) |
| Cloud thickness | `surfaces/399/cloudTau` and `cloudTauEstimated`: kind `cloud-optical-thickness-moments` (tauRetrievedFraction, lnTauMoment1, lnTauMoment2, iceTauFraction; the same cells) | which share of the cloud has a thickness, measured or estimated, and its ln τ distribution (§2) |
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

Each texel holds a cloud fraction C, the share of it that has an optical thickness τ at 0.65 µm with the
distribution of that thickness, the cloud-top height and the ice share ("The cloud field", below).

**Reflection and transmission** use the δ-Eddington two-stream solution for a non-absorbing layer over a
black surface (Joseph, Wiscombe & Weinman 1976; the conservative closed form was re-derived with sympy,
`R − candidate = 0`):

R(μ0) = [(1 − g)τ + (2/3 − μ0)(1 − e^{−τ'/μ0})] / [4/3 + (1 − g)τ], with τ' = (1 − g²)τ,

- T(μ0) = 1 − R(μ0).
- The spherical albedo r̄ = 2∫R(μ)μ dμ uses 4-point Gauss–Legendre.
- The direct view transmission is e^{−τ'/μ}.

**Asymmetry parameter g.** The values are those of the MODIS/VIIRS retrieval, chosen when the cloud field came
from it, so that a retrieved τ reproduced the reflectance the satellite measured. The present field is retrieved
by another algorithm (SatCORPS, "The cloud field" below), whose ice model is roughened hexagonal columns with g from
0.77 to 0.81 (Minnis et al. 2021, IEEE TGRS 59, 2744, §III-A.1, pp. 5–6), not 0.75: for ice the renderer's cloud is
no longer the retrieval's own, and a given τ is drawn somewhat brighter than it was measured. The constants are
unchanged (`core/constants.ts`); which value serves this field is open.

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

**The cloud field** (`pipeline/src/pipeline/satcorps.py`, `surf_earth.build_clouds`; source note
[sources/satcorps-gcc.md](sources/satcorps-gcc.md)). The layers are built from NASA Langley's SatCORPS Global
Cloud Composite (GEO-LEO global, V2): hourly files on a 1/36° grid in which each cell holds one satellite's
retrieval, from five geostationary imagers and NOAA-20 VIIRS, with its class, optical depth, top height, source,
observation time and angles.

- **It is a mosaic of moments, not one.** Each longitude comes from the hourly file nearest 13:30 local solar
  time of the UTC day 2026-09-28: 24 strips of 15°. The cuts between strips are hard and one hour apart; between
  the strips of 23 UTC (east of 150° W) and 00 UTC (west of it) the weather is 23 hours apart. These are real
  discontinuities in the picture: nothing is blended between hours. Geostationary cells were observed 7–725 s after
  their file's hour; the polar orbiter's cells between 2 h before and 3 h after it. 13:30 is the local time of the
  product's own polar orbiter, so the cells that fill the caps and a geostationary outage are of the same local hour,
  and of the wind layer that sets the glint (§3).
- **Aggregation.** The cells are summed onto the level-4 texels by area overlap (2.5 cells per texel on average).
  Every channel of the two thickness layers is an area-weighted sum, so the pyramid's 2×2 means are exact. A texel
  observed over less than half its area is unknown; nothing is carried across a hole. The mosaic is known over
  99.97 % of the globe, caps included.
- **Classes.** Each cell is one of: clear; cloud with a thickness retrieved from sunlight (*measured*); cloud whose
  thickness is the provider's estimate (*estimated*); the provider's "possible cloud"; cloud without a thickness
  ("no cloud property retrievals"); not observed. By area: clear 35.2 %, measured 53.9 %, estimated 8.4 %,
  possible 2.5 %, without a thickness 0.09 %, not observed 0.03 %.
- **The estimated group** is: any cell with the Sun 82° or more from the zenith (the provider's documented night
  algorithm: thermal channels, thin cloud only, thick cloud a default or an extrapolation); a geostationary cell
  with the Sun 75.25° or more from the zenith; a geostationary cell over water within 40° of the Sun's mirror
  direction. The last two are not documented by the provider: they are where its "possible" classes, a few percent
  of cells elsewhere, are all but absent (0.17 % inside the cone against 2.5 % outside, in the strips used), which
  matches the provider's statement that values "in the solar terminator and sun-glint" are extrapolated. No cell is
  flagged in the files. Each layer header states the test and the counts (`constants.geometricTest`).

**The three layers.**

- `clouds`: cloudFraction counts every cloud class and the "possible" class; opticalThickness and iceFraction are
  the mean thickness and ice share of the measured cells; cloudTopHeightM is the mean top of the cells with a
  thickness of either group (one channel serves both levels: where a texel holds estimated cells it includes their
  heights).
- `cloudTau` (label **derived**): f_τ, the share of the texel that is cloud with a *measured* thickness; Σ a·ln τ and
  Σ a·(ln τ)² over those cells (a: the cell's share of the texel); the share that is ice. Mean ln τ = m1 / f_τ,
  var ln τ = m2 / f_τ − (mean ln τ)².
- `cloudTauEstimated` (label **estimated**): the same over the cells with a measured *or* an estimated thickness.
  Where a texel has no estimated cell it equals `cloudTau`.

**What is drawn at each reality level.** The shell (`app/extras.ts`) binds `cloudTauEstimated` in place of
`cloudTau` where its label is admitted (Best estimate, Complete) and `cloudTau` at Strict. The renderer
(`earth.ts cloudLogNormal`, mirrored in `shaders-earth.ts`) draws the share f_τ of the bound layer as a log-normal
in τ, three sub-pixels at τ = exp(μ), exp(μ ± √3σ) with weights 2/3, 1/6, 1/6 (the 3-point Gauss–Hermite rule),
each with the full two-stream cloud; the ice share sets g. The rest of the cloud, cloudFraction − f_τ, has no
thickness at that level: it reflects nothing, the air over it is drawn, and it is marked not measured (hatched
where it is over half the pixel). **No statistic stands in for a thickness.**

| Class | Strict | Best estimate, Complete |
|---|---|---|
| measured thickness | drawn | drawn |
| estimated thickness | not measured | drawn with the provider's value (estimated) |
| "possible" cloud | not measured | not measured |
| cloud without a thickness | not measured | not measured |
| not observed | cloud state unknown: drawn clear and marked | the same |

Not measured is 10.9 % of the globe's area at Strict and 2.6 % at Best. (In the app the Earth's layers are drawn
only where its atmosphere is admitted, which is estimated: at Strict the Earth is its disk photometry, §0.) The marks
count only where the pixel is lit; at night only where there are lights to hide.

**The moments against the cells.** The header's `diagnostics.planeAlbedoCheck` compares the plane albedo × f_τ
(δ-Eddington, the Sun of 13:30 local) from the moments with the area mean of R(τ_i) over the measured cells
(independent pixels). Bias, then mean absolute error per texel, for the globe and for the validation swath
(40° S–40° N, 125–160° E):

| | level 4 (4.9 km) | level 0 (78 km) |
|---|---|---|
| R(linear mean τ) | +1.7 to +2.8 %, 1.7–2.8 % | +12–17 %, 12–17 % |
| R(exp mean ln τ) | −0.3 to −0.8 %, 0.8–1.4 % | −2.4 to −4.5 %, 4.9–7.2 % |
| 3-point log-normal | +0.2 to +0.4 %, 0.3–0.6 % | +0.7 to +1.0 %, 1.1–1.6 % |

The first row is the plane-parallel bias (Cahalan et al. 1994, J. Atmos. Sci. 51, 2434). The log-normal from both
moments holds at every level.

**What the field does not say.** No uncertainty per cell and no validation of this product version; the
algorithm family's thin ice cloud is, by day in geostationary data, 2.25 thicker than the lidar's on average (RMS
10.6); a pixel of 2–3 km is cloudy or clear as a whole, so small cumulus in pixels called clear is missing; the
composite's paper mentions no parallax correction; the grid's latitude is read as geodetic on the evidence of its
coastlines. Where the sea glints the sources disagree about the cloud itself (at 130° E, 6° S on this day: 74 %
cloud from NOAA-20 at 04:36 UTC, 6 % from Himawari-9 at 05:06). All of it is in the source note.

**Validation** (`earth-himawari9-2026`, Himawari-9 at 04:05 UTC on 2026-09-28; `earth-moon-epoxi-2008`, with this
cloud field standing in for 2008). Rendered Y over expected Y on the GPU, 4 × 4 samples per pixel, with the layer
this one replaced (VIIRS imagery through GIBS, its cloud without a thickness given a global partly-cloudy
statistic) and with this one; and what the model renders with no cloud at all (CPU twin):

| Region | previous layer | this layer | no cloud |
|---|---|---|---|
| Himawari disk centre | 1.51 fail | 1.28 fail | 0.95 |
| Himawari limb | 0.99 pass | 1.01, fails in Z | 0.99 |
| Himawari terminator | 0.64 fail | 0.75 fail | 0.74 |
| Himawari 130° E | 1.38 fail | 1.21 fail | 1.19 |
| Himawari 150° E | 1.02 pass | 1.18 fail | 0.17 |
| Himawari 141° E, 10° S | 1.38 fail | 1.11, Y passes, Z and S fail | 1.09 |
| EPOXI Earth, whole disk | 0.97 pass | 1.02 pass | 0.55 |
| EPOXI Earth, centre | 0.99 pass | 0.96 pass | 0.46 |
| EPOXI Moon/Earth ratio (0.1017 ± 0.0008) | 0.1007 fail | 0.0958 fail | |

The cases test the model; they did not choose the field. With the assumed thickness gone, the three regions it
made 1.38–1.51 are 1.11–1.28, and what remains is no longer the cloud field's: 130° E and 141° E are too bright
with no cloud at all (clear sea with sun glint under the air); the disk centre has 27 % cloud of thickness 2.7,
retrieved from the same Himawari scan as the reference image, and renders a third brighter than with no cloud; and
150° E, overcast at thickness 22, renders 1.18. The cloud's angular law (a plane albedo spread by the escape
function, 1.29 times Lambert at the nadir at every thickness), the glint and the reference are what these rows
now test.

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
- **Cloudy part:** path radiance above the cloud tops, plus cloud reflection lit at h_c and seen through
  T_view,above, plus the transmitted surface terms lit at the ground and seen through the whole air column.
  The surface terms retain §2's downward cloud transmission, cloud/base multiple reflection and direct +
  diffuse upward transmission; open water also retains its Fresnel skylight reflection. Lower-air path light
  is L_lower = max(L_whole − L_above, 0), already attenuated by the upper air. Per τ node it is multiplied by
  t_view·T(μ0) for downward direct flux and t_view·(1 − r̄) for downward diffuse flux. Because the existing
  path table combines single and multiple scattering and is already folded to XYZS, their mixture is
  approximated per channel by the cloud-top horizontal irradiances B = max(μ0, 0)·fold(T_sun(h_c)) and
  D = fold(E_sky(h_c)): lower transmission = t_view·[T(μ0)B + (1 − r̄)D]/(B + D), averaged over τ nodes.
  If B + D is zero, diffuse transmission is used for any twilight path light. This approximation neglects
  the transmitted downward beam's angular redistribution, redistribution on the upward cloud passage of
  directional air light, and cloud feedback on the precomputed multiple-scattering field. It adds no fitted
  coefficient and remains estimated. At τ = 0 both cloud transmissions are one, cloud reflection is zero,
  and surface + whole-air light exactly recover the clear share at any cloud height. At τ → ∞ all lower
  terms vanish, retaining the previous opaque-cloud result. Reflection increases and lower-air transmission
  decreases continuously with τ; their sum need not be monotonic (a thin cloud may dim bright grazing air
  before thick-cloud reflection dominates).
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
column of c × c pixels, c = ⌈frame height / 270⌉ (at least 2), and the pixels interpolate.
The square-column spacing is increased only as needed to keep both grid axes within the device’s 3D texture
and compute-dispatch limits; all altitude and spectral slices are retained (a depth that cannot fit uses the
per-pixel march). Hillaire slices the
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
| Surface + clouds, no atmosphere (level 1) | 0.150 0.150 0.153 0.151 | 0.62 0.63 0.50 0.56 |
| + atmosphere, glint, sky reflection and lower-air transmission (level 0) | 0.200 0.199 0.261 0.231 | 0.83 0.84 0.85 0.86 |
| Measured p·Φ(2.42°) | 0.241 0.238 0.308 0.269 | 1 |

With the atmosphere the colour matches: all four channels come out 0.83–0.86 of the measurement (with the
δ-scaled view transmittance). The test draws the `clouds` layer alone, without the thickness layers: each texel's
whole cloud fraction at the mean thickness of its measured cells, and no thickness where a texel has cloud but no
measured cell. The remaining 14–17 % is at the edge of the photometry's stated variability: the disk reflectance
changes by 10–20 % with clouds and the hemisphere in view, and the clouds here are a mosaic of a different day,
2026-09-28 (§2). Model approximations also contribute:

- Lambert land;
- two-stream clouds without a glory or phase features, which matter at 2.4° phase;
- clouds as a layer at their top.

The unknown share of the disk is 4 % (6 % at level 1): cloud in texels without a measured thickness.

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
drawn from its atmosphere model, which is scaled per channel so that the measurement is kept too (below, "Titan").

**The rule** (architecture §4.3, §4.4; frame.ts). Disk photometry is the absolute calibration of a body's
brightness and colour, and whatever draws the resolved disk supplies only the spatial pattern: a surface law and
maps, a surface under measured air, or a physical atmosphere model. Wherever the photometry is admitted at the
reality level and covers the phase angle, the drawn disk's integral is the measured p·Φ(α) in X, Y, Z and S. Beyond
the measured phase range the scale found at the range's edge is kept at Best estimate and Complete (an assumption:
the result is `estimated`, with a warning), and at Strict the sunlit part is marked not measured. There is one
exception, the Earth drawn with its layers (§1–§6): it is never scaled to its disk photometry. Its layers carry
their own absolute calibration (surface reflectance, cloud optical thickness and the air, each in absolute units),
and its disk albedo is the weather of one day, which one disk value cannot fix; §6 reports the ratio instead.

**Renormalisation** (frame.ts, `atmosphereDiskFactors` in atmosphere.ts). Four disk integrals per channel,
as reflectances (1/πR²)∫ρ dA, for the body's law on a uniform surface:

- I0: the surface alone;
- Iatm: the surface under the air, i.e. ρ·T_sun·T_view plus skylight on a Lambert surface of the same scale;
- Apath: the air's own light over the disk;
- Ashell: the air's light beyond the disk edge, the shell pipeline's chords.

The surface scale K is multiplied by (1 − (Apath + Ashell)/pΦ)·I0/Iatm, so the rendered body (surface
under the air, plus the air on and beyond the disk) still reflects the measured p·Φ(α). The integrals are
taken on a polar grid of the disk (`diskGrid` in atmosphere.ts: 12 Gauss–Legendre nodes in μ × 24 azimuths,
`ATM_DISK_NODES`; the annulus beyond the disk on 12 radii × 24 azimuths) and cached in 1° phase bins,
interpolated linearly, one integral of about 10 ms per new bin. With the real products the drawn disk's integral
is then within 0.05 % of p·Φ in every channel for Mars at 0°, 36° and 60° and for Pluto at 0° and 1.7°
(checked through `prepareFrame` against a 48 × 96 grid; Venus keeps its measured disk, below). Until this change
the grid was the cell centres of a 16 × 16 square, which counts the disk's area 3.5 % too large and a Lambert
disk's integral 0.8 % too large at zero phase, 5.5 % at 90° and 39 % at 150°: Mars was drawn from 0.2 % too
bright (X) to 1.2 % too dark (Z) at opposition, 1.7–3.4 % too dark at 36° and 2.5–4.8 % at 60°, and Pluto
0.2–0.4 % too bright. The map's weighting
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
   - Mars, whose curve beyond the ~47° seen from Earth is estimated: at α = 100° the scale is taken at 72°
     (dust at L_s = 0°, scale 0.89; 66° with the square grid, whose air came out too bright).
   - The Earth drawn from its disk photometry, whose curve is Mallama & Hilton's fit to a radiative-transfer
     model: at 175° the scale is taken at 107° (103° with the square grid), and the sunlit air ring is drawn.
     Earth mode with its layers does not use this.
4. **Not drawn**, when the air alone is brighter than a *measured* disk in any channel. Until M5 this was
   also Mars beyond α ≈ 65–70°, first in Z. (Apath + Ashell)/pΦ for X, Y, Z, S
   is 0.36 / 0.38 / 0.55 / 0.46 at α = 0°, 0.59 / 0.63 / 0.91 / 0.75 at 60° and 0.92 / 0.99 / 1.48 / 1.21
   at 95° (dust at L_s = 0°, scale 0.89; on a 48 × 96 grid). In blue the dust (ω ≈ 0.8) is brighter than the dark surface, so
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
| Mars | CO₂ Rayleigh; dust, double HG, ω 0.71–0.98 | Over the disk to α ≈ 72°: haze softens the terminator and lowers contrast. At α = 36° the surface scale is ×0.44 / 0.40 / 0.16 / 0.31 (X, Y, Z, S; dust at L_s = 0°, scale 0.89; with the δ-scaled view transmittance): the blue of the disk is mostly dust light. Beyond, the surface scale of the nearest phase where the estimated curve still exceeds the air (3.). |
| Venus | the cloud and upper haze above 60 km | Beyond the disk only. Near inferior conjunction (α = 172°) the haze alone outshines the measured p·Φ: not drawn. |
| Pluto | haze (tabulated Mie phase, ω 0.944) | Over the disk; the haze is 1.5 % (X, Y) to 3.9 % (Z) of the disk's light at low phase and forms a ring at high phase. |
| Titan | N₂ Rayleigh; DISR haze (three components, two phase functions); methane; surface reflectance | Drawn from the model, scaled per channel to the disk photometry (×0.99, 0.99, 0.89, 0.95 beyond 5.7°): see below. |

**Mars dust.** atmospheres.json gives the annual global-mean column and a table of global-mean column
optical depth by solar longitude (5° bins; Montabone et al. 2015, 2020 climatology), with L_s against
ephemeris time. `marsDustScale` takes L_s at the snapshot's time, the nearest bin (on the circle) and scales
the dust extinction by the bin's mean over the annual mean. Each bin has its own tables (a few seconds in
the worker when the season changes). The latitude dependence of the column is left out: the tables are
spherically symmetric.

**Titan: drawn from its atmosphere model, scaled to its disk photometry.** atmospheres.json gives Titan's air in
full: N₂ Rayleigh, the Huygens DISR haze (extinction of Tomasko et al. 2008; single-scattering albedo of Doose et
al. 2016, below 80 km and above 200 km; phase functions of Tomasko et al., below and above 80 km), methane
absorption, and the Lambert reflectance of the surface under it (docs/reports/atmospheres.md, "Titan"). extras.ts
attaches the surface (`SceneAtmosphere.surface`) when the surface reflectance and every component are admitted,
and frame.ts then draws the resolved disk from the model: the surface scale is K = E☉/(πd²)·ρ_c with ρ_c the
surface's X, Y, Z, S equivalents and a Lambert law, and the shader (`ATM_OVER_PHOTOMETRY`, and the shell beyond the
limb) adds the sunlight and skylight through the air and the air's own light, scaled by the Sun's E☉/(πd²).

By the rule above the model gives the pattern and the photometry the level. Every term of the model's radiance is
proportional, per channel, to one of those two scales, so frame.ts multiplies both by one factor per channel,

    f_c = p_c·Φ(α) / A_c(α),

the measured disk reflectance of photometry.json over the model's own disk integral A_c (`modelDiskXYZS` in
atmosphere.ts: the CPU twin of what the shaders compose, on a polar grid, in 1° phase bins interpolated linearly;
about 30 ms per new bin). No number of the model is adjusted and no factor is stored: f is computed at run time
from the tables in use, and the renderer says it in a warning line (`renderer.stats.warnings`: the scene suite's
and the validation's reports, the render-test page, `debugState()`), for example "Titan: atmosphere model scaled to
the disk photometry at 3°, ×0.99 X, 0.99 Y, 0.88 Z, 0.95 S (measured p·Φ over the model's disk integral)". The
inspector's "why" sentence says that the disk is scaled so; it does not show the numbers.

- **Inside the photometry's range** (0–5.7°) the factors run from ×0.982, 0.994, 0.810, 0.934 (X, Y, Z, S) at 0° to
  ×0.988, 0.987, 0.893, 0.951 at 5.7° (docs/reports/atmospheres.md, "What is drawn"). Only 5.7° is a measurement
  (Karkoschka's 1995 albedo); the values below it are the phase function's assumed linear rise of 2 % in every
  channel to zero phase (label `estimated`), which the scaling puts in place of the model's own backscatter peak in
  the blue (the model's Z rises by 12 % from 5.7° to 0°).
- **Beyond 5.7°** the photometry says nothing. At Best estimate and Complete the factors of 5.7° are held at every
  phase, the body's label becomes `estimated`, and the line says so ("… as at 5.7°, ×0.99 X, 0.99 Y, 0.89 Z, 0.95 S:
  phase 61° is beyond the measured range (0–5.7°) and the factors of its edge are held → estimated"). This is the
  standing continuation of a phase curve (rendering-m2.md §2) with the model's disk integral in the place of the
  spatial law's. A body whose model were admitted at Strict would be marked not measured there, as any body beyond
  its phase curve is.
- **At Strict** Titan's haze and photometry are both `estimated`, so neither is admitted and nothing of this applies.
- **Until the tables are ready**, or if the atmosphere cannot be drawn, the disk photometry stands in with a
  Lambert law (beyond 5.7° extrapolated with it at Best estimate, with the usual warning).
- **As a point**, and as a source of off-frame glare, a body drawn from its atmosphere model uses the disk
  photometry directly inside its range, without model tables, an integral or a scaling line. Beyond it, the point
  carries the model's disk integral (including the shell) times the disk's held edge factors, follows the model's
  phase dependence (`estimated`), and reports the same continuation line as the disk when in view.
  The point and disk therefore carry the same light through
  their blend. This rule follows `SceneAtmosphere.surface`, not a body id; Earth's layers keep their exception.
  The existing 1° integral cache is shared: with tables ready, a cold high-phase point needs at most four integrals
  (two for the edge, two for the current phase; about 30 ms each for Titan), then none until a phase bin changes.
  At 150° Titan's point now carries about 25 times the old Lambert continuation's Y flux.
- **From close by** the frame's summed light exceeds p·Φ·(R/Δ)²: the near side of a sphere is nearer than its
  centre, a first-order effect in R/Δ (0.75·R/Δ for a Lambert sphere at zero phase) that the far-field contract does
  not contain and the picture should. Measured on the GPU: +0.9 % from 200 000 km, +0.05 % from 2 000 000 km.

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
- **Cost**: 3.9–6.6 s for Titan's 12 bins (Node on the workstation, two measurements; the app computes them in a
  worker).

Sampling choices, at 550 and 750 nm and α = 6°, 90°, 166° (measured when the solver was written; the constants
are fixed in `atmosphereMs.ts` and the variations were not run again): 16 instead of 8 streams, 10 instead of 6
Fourier terms, 37 instead of 19 view directions, layers of 0.01, a 64 × 64 table each change A_gΦ by ≤ 0.7 %.
Clip angles from 2° to 24° change it by ≤ 1.5 % at 6° and by −5 to +13 % at 166°; 16° matches the streams'
resolution (about 11°).

**Accuracy** (`app/tests/render-titan.test.ts`; docs/reports/atmospheres.md "The renderer"). Against the Monte
Carlo solution of the same model (`titan_rt.py`, every sample its own bin), the disk-integrated A_gΦ of the CPU
twin is, as the median over the 48 samples, 1.03 times the reference at 6°, 1.00 at 60°, 0.97 at 90°, 0.94 at
120°, 0.88 at 150° and 0.94 at 166°. The reference's noise is 2–4 % per sample and phase bin, so the spread
between samples (0.98–1.07 at 6°, 0.81–0.95 at 150°) is partly its noise; the medians are good to about 0.6 %.
Split at the solid limb (550 and 750 nm; the reference's noise on the whole is 1–4 % there, more on each part):
the disk is 2–5 % too bright at 6° and 28–31 % too dark at 150°, where it is the thin crescent; the air beyond the
disk is within 6 % from 30° to 120° and 5–14 % too dark at 150–166°, where it is nearly all the light (at 6°,
where it is a tenth of the light, it is +19 % at 550 nm and −12 % at 750 nm). The local-spherical-symmetry
assumption misses the light that reaches the terminator from the sunlit side. Inside the photometry's range the
scaling removes this error from the disk's integral; beyond it the error stays in the picture, on top of the held
factors.

The twin's disk integral is taken on a polar grid (Gauss–Legendre in μ, uniform in azimuth). The square grid of
cell centres it replaced miscounted the disk's area by its edge cells (+3.5 % at 16 across, −1.0 % at 24, +1.0 % at
32), and the integral of a nearly uniform disk followed: the numbers of this section were 0.6 % higher at small
phase before 2026-10-07, and the thin crescent's disk part at 150° 8 % higher. `atmosphereDiskFactors` (the
renormalisation of Mars, Venus and Pluto, above) had the same square grid at 16 across and now shares the polar
one.

**The shaders against the CPU twin, and the drawn disk against the measurement.** The disk-integrated light of
rendered frames (the HDR buffer summed over a 512 × 512 view, Titan 330 px across, from 2 000 000 km; the
workstation's GPU, `nvidia blackwell`, rgba32float, 2026-10-07) over the twin's on a fine grid times the frame's
factors is 1.0003, 1.0005, 0.9986, 1.0001 (X, Y, Z, S) at 0°, 1.0005–1.0007 from 1° to 30°, 1.0002 at 60°,
0.9998–0.9999 at 90°, 0.9997–0.9998 at 120°, 0.9998–1.0001 at 150° and 0.9978–0.9989 at 166°: the shaders draw
what the twin computes to within 0.07 % from 1° to 150° (0.14 % in Z at exactly 0°) and 0.2 % at 166° (where the
twin's grid is the coarser of the two), so the twin's numbers stand for the picture. Against the measured p·Φ(α) the same frames give 1.0000,
1.0003, 0.9981, 0.9998 at 0° (at exactly 0° the model's backscatter peak is narrower than the ±0.07° the phase
angle varies across the disk from that distance), 1.0003, 1.0003, 1.0001, 1.0003 at 1°, 1.0004, 1.0004, 1.0002,
1.0004 at 3° and 1.0005, 1.0005, 1.0003, 1.0004 at 5.6°. From 200 000 km the frames are 0.9 % brighter at small
phase and 0.4 % at 60°, up to 0.4 % fainter from 90° to 150° and 0.5–1.3 % fainter at 166°: the finite distance
of the item above, not a difference between the shaders and the twin (the aerial-perspective columns change the
sum by 0.04 % or less). The figures of 2026-10-04 (within 2 % of the twin, SwiftShader, from 200 000 km) held both
that effect and the square grid's error.

**The two scenes** (app/e2e/scenes.json; baselines accepted on the workstation's GPU, 2026-10-07; both carry the
factors of 5.7°, ×0.99, 0.99, 0.89, 0.95, so against the unscaled model of 2026-10-04 the picture is 1 % fainter
in X and Y and 11 % in Z: a little more orange). `titan-haze` (61°,
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

**The model alone against the measurements** (pass: within twice the observation's 1σ). This is the finding about
the DISR model; since the scaling above it is no longer what the picture shows inside the photometry's range.
Karkoschka's (1998) full-disk albedo at 5.7° (absolute calibration ±4 %): the model itself, solved by the
reference, has X, Y, Z, S = 0.994 ± 0.005, 0.990 ± 0.005, 1.090 ± 0.009, 1.028 ± 0.006 of it (± the Monte Carlo
noise); the CPU twin with the app's 12 bins 1.012, 1.012, 1.119, 1.051 (the reciprocals of the factors at 5.7°);
the shaders' frame is 1.0006 of the twin. X, Y and S pass, Z fails. The brightness is right and the colour is not:
the model's reflected sunlight has x, y = (0.3717, 0.3746) against the measured (0.3811, 0.3838), Δu′v′ = 0.006,
bluer and less orange than Titan, and Z/Y is 10 % high, where a calibration error common to all wavelengths
cancels. 93 % of the model's Z comes from below 500 nm, where Doose et al. give no haze albedo and it is
extrapolated: the likely cause. At exact opposition the model is bluer still (Z rises by 12 % from 5.7° to 0°, Y
by 1 %: the backscatter peak of the 355 and 430 nm phase functions), against the 2 % in every channel that the
photometry assumes. Cassini ISS phase curves (García Muñoz et al. 2017; CISSCAL ~10 %): the medians of measured /
model (the twin, unscaled) pass in every range from 0° to 160° in BL1, GRN, CB1, RED and CB2 (0.83–1.11), with BL1
(455 nm) at 0.83–0.87 up to 90°, the same blue excess seen by a second instrument; at 160–170° the model is
20–30 % brighter than measured (BL1, GRN and CB1 fail) — its forward scattering through the upper haze is too
strong, as in the exact solution. Nothing in the model was changed for these results, and the ISS curves are not
an input to the scaling: beyond 5.7° the picture is this model times the factors of 5.7°, so the excess at
160–170° is drawn.

**Not done for Titan:** the change of μs along a scattering path (the terminator), Saturnshine on the haze
(planetshine lights the surface only), refraction, the methane bands at their 1 nm resolution, the detached
haze and the north–south asymmetry, a measured phase function for Titan beyond 5.7° (the ISS curves above are a figure digitized in five
filters, used only as a test; making them the photometry would end that test and is a separate decision), and the
scaling anchored at the one measured phase: only 5.7° is measured, so the standing rule (the model carries the
phase dependence away from the measurement, anchored at it) would hold the factors of 5.7° below it too and keep
the model's backscatter peak, instead of tying the blue channel to the photometry's assumed 2 % ramp. That needs
photometry.json to say which phases of a phase function are measured (a follow-up; no code for it here).

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

## 9. Airglow and aurora

The Earth's own light at night (docs/reports/nightglow.md; `src/render/nightglow.ts`). The emission is computed at half
resolution over the emission shell (to 600 km) and added after the atmosphere shells, depth-tested at full resolution. Each view ray is split at its closest approach to the
Earth's centre and ends on the ground where the pixel is on the disk. Airglow layers (Gaussian in altitude above the
ellipsoid) are integrated on each side with 8 Gauss–Legendre nodes in x = √(r − r_t), which handles the face-on
column and the limb's path enhancement alike; the night domain (solar zenith angle > 100° below the emission) is
evaluated per node, the local time and ellipsoid radius at the ends of each layer crossing (linear between). The aurora is marched (48-step budget, rounded up and at least four steps per segment) through the parts of the ray inside the shell and
the auroral caps; per step the precipitation at the step's magnetic coordinates and the emission's cumulative
altitude table give column integrals for the within-step linear-altitude approximation, with interpolation error
inside altitude bins and a midpoint-rate approximation when |Δh| ≤ 0.05 km. Light that crosses the lower atmosphere is attenuated
per 40 nm bin with §4's transmittance table. Neither emission lights the ground or clouds: the pass adds light
along the view ray and sends no irradiance to earthShade. Scattering of this light in the lower atmosphere
(path radiance) is also not modelled. The CPU model and product tests pass; WebGPU scene checks remain pending.
