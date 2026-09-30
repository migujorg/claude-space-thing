# Earth: surface, clouds, sea, night lights and atmosphere

Earth is drawn from its measured layers instead of from its disk photometry: the surface, its clouds and
their optical thickness, open water with its sun glint, sea ice, night lights, and the air above them. This
file covers each part: what it computes, from which data, and with which published model. The eye model is in
[eye-model.md](eye-model.md); the other renderer parts are in [rendering-m2.md](rendering-m2.md).

Code:

- `app/src/render/earth.ts`: the reference model (surface, sea ice, clouds, glint, night lights).
- `shaders-earth.ts`: its WGSL mirror.
- `atmosphere.ts`: atmospheres.json → model, precomputed tables, and CPU references of the per-pixel march.
- `atmosphere.worker.ts`: computes the tables off the main thread.
- `atmosphereGpu.ts`: packs the tables into a texture.
- `shaders-atmosphere.ts`: the per-pixel march.
- `shaders.ts`: the Earth body variant `EARTH_BODY_SHADER` and `ATMOSPHERE_SHELL_SHADER`.

Tests: `app/tests/render-earth.test.ts`, `render-atmosphere.test.ts` (TEST FIXTURE atmosphere) and
`render-earth-energy.test.ts` (real products, §6). Test page: `render-test.html?scene=earth-data&sun=lat,lon&obs=lat,lon&dist=km`.
Any of `map|clouds|water|night|wind|atm=0` switches a part off.

## 0. Inputs

| Input | Layer / file | Used for |
|---|---|---|
| Surface reflectance | `surfaces/399/albedo`: kind `relative-reflectance`, header `normalization.absoluteDiskMean` | texel × absoluteDiskMean = absolute reflectance factor (MODIS NBAR on land; water-leaving reflectance π·Rrs over water) |
| Clouds | `surfaces/399/clouds`: kind `cloud-properties` (cloudFraction, opticalThickness, cloudTopHeightM, iceFraction; VIIRS CLDPROP, 2026-09-28 daytime overpass) | cloud reflection and transmission (§2) |
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
- Cloudy but no optical thickness (2.5 % of the cloud cover): that share contributes nothing and is marked.
- The marks count only where the pixel is lit. At night only the cloud state matters, and only where
  there are lights to hide.

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
  daily mean. It is taken as U(12.5 m) = 1.02·U10 (the layer header's neutral log profile).
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

The ground reflectance under the atmosphere, for Ψ_ms, is the Lambert-equivalent 1.5·p_Y of the measured
disk photometry, the relation planetshine.ts uses. It includes the air itself, a small double count.

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

**Limb.** Rays that miss the solid Earth go through `ATMOSPHERE_SHELL_SHADER`. It marches the chord through
the top sphere from its closest point to the centre, computed without cancellation at large distance.
Pixels partly covered by the Earth get the uncovered share. The shell is additive and depth-tested, with no
depth write.

**Titan.** The haze's single-scattering albedo and phase function are unknown, so no scattering could be
computed and its atmosphere is not drawn. Its disk keeps its measured photometry, which includes the haze's
light.

**Not modelled.**

- Refraction: the eclipse ring comes out blue from high-altitude Rayleigh scattering, not red from light
  refracted into the shadow.
- O₂ and H₂O bands (omitted in the data).
- Multiple bounces between the surface and the air, beyond the ground term of Ψ_ms.
- Stars seen through the limb are not dimmed.
- Clouds affect only their own pixel, not the air around them.

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
| + atmosphere, glint, sky reflection (level 0) | 0.210 0.210 0.262 0.236 | 0.87 0.88 0.85 0.88 |
| Measured p·Φ(2.42°) | 0.241 0.238 0.308 0.269 | 1 |

With the atmosphere the colour matches: all four channels come out 0.85–0.88 of the measurement. The
remaining 12–15 % is within the photometry's stated variability: the disk reflectance changes by 10–20 %
with clouds and the hemisphere in view, and the clouds here are from a different day, 2026-09-28. Model
approximations also contribute:

- Lambert land;
- two-stream clouds without a glory or phase features, which matter at 2.4° phase;
- clouds as a layer at their top.

The unknown share of the disk is 1 %.

## 7. Cost

Per Earth pixel: 32 steps × (profile 3, transmittance 1, multiple scattering 1) texture samples per 4 bins,
i.e. 480 filtered samples, plus the cloud and surface lookups.

On SwiftShader at 960 × 540 with the Earth covering about 40 % of the frame, bodies+rings takes 13 s, against
1.3 s without the atmosphere. On a desktop GPU this is estimated at ≈ 2–4 ms at 1080p and 8–15 ms for a 4K
frame filled by Earth. Hillaire's aerial-perspective volume (a 32³ froxel table per frame) would cut it to a
few samples per pixel; it is the next optimisation.

## 8. Other atmospheres

atmospheres.json also has Mars (CO₂ + dust, scaled by the dust column), Venus (haze above the 60 km deck,
tabulated phase), Pluto (haze) and Titan (see §4). The renderer draws an atmosphere only with Earth's layers
for now.

Mars's and Pluto's disks are drawn from their disk photometry, which already includes their air. Adding a
scattering atmosphere on top would count it twice. The consistent way is the renormalisation of
rendering-m2.md §2 with the atmosphere inside the disk integral; it is not done yet. The tables and the
adapter already handle their phase functions: double HG for Mars, tabulated for Venus and Pluto.
