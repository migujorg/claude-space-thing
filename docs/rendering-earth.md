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

**Limb.** Rays that miss the solid Earth go through `ATMOSPHERE_SHELL_SHADER`. It marches the chord through
the top sphere from its closest point to the centre, computed without cancellation at large distance.
Pixels partly covered by the Earth get the uncovered share. The shell is additive and depth-tested, with no
depth write.

**Titan.** See §8.

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
| + atmosphere, glint, sky reflection (level 0) | 0.212 0.211 0.268 0.240 | 0.88 0.89 0.87 0.89 |
| Measured p·Φ(2.42°) | 0.241 0.238 0.308 0.269 | 1 |

With the atmosphere the colour matches: all four channels come out 0.87–0.89 of the measurement. The
remaining 11–13 % is within the photometry's stated variability: the disk reflectance changes by 10–20 %
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

atmospheres.json has Mars (CO₂ + dust), Venus (the haze above 60 km), Pluto (haze) and Titan (N₂ +
haze). The giant planets have scale heights only, so they get no atmosphere. These bodies are drawn from
their disk photometry, which already contains the light of their air. The same tables (§4) add the air,
and the surface is renormalised so that the measurement is kept.

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

Three outcomes, each with a warning where it applies:

1. **Over the disk and beyond** (Mars and Pluto at most phases).
2. **Beyond the disk only**, when the renormalised surface would reflect more than it receives (Bond
   albedo > 1; `lawBond` = 2∫I(α) sin α dα per unit scale). Then the surface cannot be seen under the air
   in the model, and the disk keeps its measured photometry. Only the shell is drawn, and K is reduced by
   its share, Ashell/pΦ. This is Venus: atmospheres.json starts the profile at 60 km, inside the deck, with
   τ ≈ 12 above it (the file says to use photometry.json for the reflectance there).
3. **Not drawn**, when the air alone is brighter than the measured body in any channel
   (Apath + Ashell ≥ pΦ). This is Mars beyond α ≈ 65–70°, first in Z. (Apath + Ashell)/pΦ for X, Y, Z, S
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
| Mars | CO₂ Rayleigh; dust, double HG, ω 0.71–0.98 | Over the disk to α ≈ 65°: haze softens the terminator and lowers contrast. At α = 36° the surface scale is ×0.82 / 0.74 / 0.22 / 0.52 (X, Y, Z, S): the blue of the disk is mostly dust light. Not drawn beyond (3.). |
| Venus | the cloud and upper haze above 60 km | Beyond the disk only. Near inferior conjunction (α = 172°) the haze alone outshines the measured p·Φ: not drawn. |
| Pluto | haze (tabulated Mie phase, ω 0.944) | Over the disk; the haze is 1–2 % of the disk at low phase and forms a ring at high phase. |
| Titan | N₂ Rayleigh; haze with ω and phase unknown | See below. |

**Mars dust.** atmospheres.json gives the annual global-mean column and a table of global-mean column
optical depth by solar longitude (5° bins; Montabone et al. 2015, 2020 climatology), with L_s against
ephemeris time. `marsDustScale` takes L_s at the snapshot's time, the nearest bin (on the circle) and scales
the dust extinction by the bin's mean over the annual mean. Each bin has its own tables (a few seconds in
the worker when the season changes). The latitude dependence of the column is left out: the tables are
spherically symmetric.

**Titan.** The haze's single-scattering albedo and phase function are unknown, so its scattering cannot be
computed and no light is drawn for it. The disk keeps its measured photometry, which includes the haze's
light. The air beyond the disk edge, up to the top of the tabulated extinction (500 km), is marked "not
measured" (the shell writes the hatch mask and no light). Extinction alone is known. The one visible
effect of extinction only would be the dimming of what lies behind the limb, which is not drawn (see §4,
"Not modelled").

**Altitude reference.** The drawn ellipsoid (bodies.json radii) is taken as the profile's lower boundary.
For Venus this puts the haze 60 km (1 %) lower than it is: the disk is drawn at the solid radius, as it
was before, and the shell adds the 50 km of haze above it.

**Shell app use.** extras.ts attaches an admitted atmosphere to any lit body with photometry. Admission
needs every known label admitted at the reality level and a known extinction. Unknown scattering does not
withhold it: the renderer handles that as above.

**Not done.**

- δ-scaling of forward-peaked phase functions (Wiscombe 1977) for the view transmittance of surface
  light. Mars's surface contrast under the dust is therefore somewhat low. The disk total is kept by the
  renormalisation.
- Refraction and the Venus aureole.
- Latitude-dependent dust and seasonal hazes.
