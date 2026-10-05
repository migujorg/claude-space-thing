# Earth's night side: airglow and aurora

Pipeline stage `nightglow` (`pipeline/src/pipeline/stages/nightglow.py`, with `nightglow_airglow.py`,
`nightglow_aurora.py`, `us76_upper.py` and the transcribed values in `nightglow_tables/`). App: `src/app/nightglow.ts`
(time, reality filter), `src/render/nightglow.ts` (the emission pass and its CPU twin), inspector rows in
`src/ui/inspectModel.ts`.

The Earth's upper atmosphere emits light of its own: the **airglow** (chemiluminescence of O, OH, Na, O₂, FeO … at
80–300 km, everywhere, every night) and the **aurora** (electrons precipitating at high magnetic latitudes). Seen from
orbit the airglow is a thin green band along the night limb, with a fainter red layer above it; the aurora is a
green-and-red oval around each magnetic pole. Both are drawn as an additional source term of the Earth's atmosphere,
in absolute luminance (X, Y, Z cd/m² and scotopic cd/m²), so the eye model decides what is seen: a dark-adapted eye
is expected to see the airglow band, a daylight-adapted one is expected not to. These perceptual results still require
WebGPU scene verification on the running app.

## 1. Products

| File | Content | Label |
|---|---|---|
| `nightglow/airglow.json` | PALACE v1.0 emission classes: luminance per rayleigh (and per 10 nm sample), reference zenith intensities, the 12 × 12 month × local-time climatology with solar-cycle slopes; 9 Gaussian layers; the 10.7 cm solar radio flux (27-day centred means) per day of the window | model `estimated`; flux per day `derived` (observed) or `estimated` (predictions fill the window) |
| `nightglow/aurora.json` | OVATION Prime 2010 grid description, the solar-wind coupling per hour, magnetic-coordinate grid description, the emission model (columns, peaks, luminance per R per line group) | model `estimated`; coupling `derived` (measured part) / climatology `estimated`; magnetic coordinates `estimated` |
| `nightglow/aurora-ovation.bin` | float16 [season 4][energy flux, number flux][coupling node 32][MLT 96][\|MLAT\| 80] | `estimated` |
| `nightglow/aurora-magnetic.bin` | float32 [lat 180][lon 360][AACGM-like latitude, cos and sin of longitude] at 110 km | `estimated` |
| `nightglow/aurora-emission.bin` | float32 [mean energy 22][altitude 257 (86–598 km)][N₂⁺ 1N (427.8 nm), O 557.7 nm, O 630.0+636.4 nm, 0]: R per km per (erg cm⁻² s⁻¹) | `estimated` |

The build checked on 2026-10-04 contains 59 raw inputs (122,867,792 bytes, including the reused CIE tables,
US76 document and NAIF leap-second kernel) and five products (5,236,095 bytes). The final rebuild with all raw
inputs cached took 45 s; most of it was magnetic field-line tracing. Itikawa's NIST PDF first returned HTTP 403
and succeeded with the pipeline's browser user agent. If the publisher refuses a future retrieval, the existing
transcription remains cited and the source record explicitly omits a retrieval date and checksum. UTC dates use
SPICE and the registered NAIF LSK rather than a fixed TDB-to-UTC offset.

## 2. Airglow

**Source: PALACE v1.0** (Noll et al. 2025, GMD 18, 4353, DOI:10.5194/gmd-18-4353-2025; data Zenodo
DOI:10.5281/zenodo.14064022, CC BY 4.0). It is a measured climatology: 10 years of VLT X-shooter spectra at Cerro
Paranal (24.6° S) reduced to 23 emission classes (OH Meinel bands by vibrational level, O₂ bands, the O green and red
lines, Na D, K, N, FeO and HO₂ pseudo-continua, …), each with its line list or continuum, a reference zenith intensity
(annual nocturnal mean at 100 sfu), and a 12 × 12 month × local-time table of the scaling factor f₀, the solar-cycle
effect (SCE, % per sfu) and the residual variability σ. PALACE Eq. 1: I = I_ref · f₀ · (1 + 0.01 · SCE · (S − 100)),
S the 27-day centred mean of the 10.7 cm flux. PALACE was chosen over SM-01 and over a physical model because it is a
measured, open, line-resolved climatology of the visible spectrum with its solar-cycle dependence.

**Spectra → luminance.** Every line and continuum is integrated against the CIE 1931 2° colour-matching functions and
the CIE 1951 scotopic function at its standard-air wavelength (Edlén 1966), with the photon energy hc/λ at the vacuum
wavelength and the definition of the rayleigh (1 R = radiance 10¹⁰/(4π) photons m⁻² s⁻¹ sr⁻¹; Hunten, Roach &
Chamberlain 1956). One rayleigh of the green line is Y = 1.9325·10⁻⁷ cd/m², S = 1.7379·10⁻⁷ scotopic cd/m². Each
class also gets its luminance split over the 48 atmosphere samples (360–830 nm, 10 nm) so the renderer can attenuate
it spectrally. Classes that emit only in the infrared (OH 3a/3b, O₂ a-band) have zero luminance. The H geocoronal
class has no emission layer in PALACE and is left out (`omitted`; 9·10⁻⁸ cd/m² at the zenith).

**Shares of the zenith luminance** (reference, Y / scotopic): FeO pseudo-continuum 45 % / 42 %, O 557.7 nm 22 % /
17 %, HO₂ 8 % / 7 %, O₂ Herzberg/Chamberlain 7 % / 28 %, OH Meinel (sum) ≈ 8 % / 4 %, Na D 4 % / 1 %, O 630/636 nm
5 % / 0.1 %. Total at the reference: Y = 1.40·10⁻⁴ cd/m²; at local midnight in September at 100 sfu 1.36·10⁻⁴ cd/m².

**Vertical profiles.** Gaussians in altitude above the ellipsoid at PALACE's reference heights (81, 87, 88, 89, 92,
94, 97 km for the mesopause classes; 250 and 300 km for the thermospheric O and N lines). Thickness: FWHM 8.6 km for
every mesopause layer, the mean OH layer of 34 rocket flights (Baker & Stair 1988, Physica Scripta 37, 611,
DOI:10.1088/0031-8949/37/4/021 — paywalled; quoted from the open review Wüst et al. 2023, ACP 23, 1599,
DOI:10.5194/acp-23-1599-2023); applying it to Na, O₂ and the green line is an assumption. Thermosphere: σ = 50 km
(PALACE Sect. 4.5: most of the red-line emission between 200 and 300 km).

**Domain.** PALACE is a night-time climatology (solar zenith angle > 100°: the Sun below the horizon up to ~200 km).
The airglow is drawn where the solar zenith angle at the ground point below the emission exceeds 100°; in twilight
and day it is unknown and not drawn (no dayglow). Local time is the mean solar time at the emission point
(UT + longitude/15); beyond PALACE's local-time bins (18:30–05:30 bin centres) the end values are held (polar night).

**Assumptions (why `estimated`).** PALACE is measured at one site; it is applied at every latitude, with the same
calendar month in both hemispheres. Latitude structure is therefore missing: the red lines in particular are
enhanced near Paranal by the equatorial ionisation anomaly and weaker elsewhere; gravity waves, the semi-annual
oscillation's latitude dependence and the high-latitude enhancements are not modelled. PALACE's own σ tables give the
night-to-night variability: 20–50 % for the mesopause emissions, up to 100 % for the red lines.

**Solar radio flux.** Daily DRAO Penticton observations (the 20 UT value; NRC Canada) give the centred 27-day means
in the build checked on 2026-10-04: `derived` from 2025-04-04 to 2026-09-21 (all 27 days observed; last observation
2026-10-04), then `estimated` to 2028-04-04 with the NOAA SWPC predicted monthly F10.7 filling the missing days.
The values range 93.69–166.01 sfu. At Strict nothing estimated is drawn, and the airglow model itself is `estimated`, so the airglow is
drawn at Best estimate and Complete only.

## 3. Aurora

**Precipitation: OVATION Prime 2010** (Newell et al. 2009, JGR 114, A09207, DOI:10.1029/2009JA014326; 2010, JGR 115,
A03216, DOI:10.1029/2009JA014805; the NOAA operational model, Machol et al. 2012). Seasonal regression coefficients
(the 36 published files, via the OvationPyme distribution) are evaluated as the IDL code does: flux = (b₁ + b₂ dΦ/dt)
× the type probability, the code's caps, the northern dawn-wedge interpolation, hemispheres averaged; diffuse,
monoenergetic and broadband electrons summed (ions not included). The grid is precomputed at 32 coupling nodes
(0–7184 in steps of 276.3, then 8000–24000); the app interpolates linearly between nodes (exact for the regressions,
approximate for the probability, which is piecewise in steps of 276) and between seasons with OP2010's day-of-year
weights (southern hemisphere: 365 − doy). Coupling above the last node (24 000; reached in the strongest hours of the
window, e.g. 2026-01-20 09 UT at 65 000) is held at the last node.

**Driver: measured solar wind.** The Newell et al. (2007) coupling dΦ_MP/dt = v^{4/3} B_T^{2/3} sin^{8/3}(θ_c/2) from
hourly OMNI 2 (King & Papitashvili 2005, DOI:10.1029/2004JA010649; NASA SPDF): By, Bz in GSM and the flow speed, then
OP2010's average of the four preceding hours (weights 1, 0.65, 0.65², 0.65³; at least two hours measured). Over the
window this covers 2025-04-04 to 2026-09-03 03 UT (12 412 hours, 331 gaps): label `derived`.

**Outside the measured solar wind** (after 2026-09-03, and in gaps) there is no nowcast. Following NORTH_STAR §3.2
(no invention; unknowns shown as unknown) and architecture §2 (estimated values only at Best/Complete, labelled), the
choices are:

- *Strict*: the aurora is never drawn, because OVATION itself is an empirical statistical model (`estimated`) even with
  measured input. The inspector says so.
- *Best estimate / Complete*: with measured coupling, the OP2010 aurora of that hour; without, the **climatological
  oval**: OP2010 at the median coupling of the last 365 measured days (3555; OP2010's own mean is 4421), labelled
  `estimated`, and the inspector says that no measured solar wind exists for the time. No synthetic storms are
  invented. The SWPC real-time solar wind (DSCOVR/ACE, 7 days) is not archived by the pipeline, so the month between
  the end of OMNI and today is climatological too.
- The SWPC OVATION nowcast (`ovation_aurora_latest.json`) is downloaded only as a location check (§6).

**Magnetic coordinates.** IGRF-14 (IAGA Division V Working Group V-MOD; NOAA NCEI coefficient file) at the window's mid-epoch (2026.757);
field lines traced from 110 km with RK4 (2 % of r per step) to the centred dipole's equatorial plane, continued as
dipole lines beyond 5 R_E; AACGM-like latitude acos(√(R/r_apex)) (Baker & Wing 1989), longitude the apex's dipole
longitude; MLT = 12 + (mlon − dipole longitude of the Sun)/15. Grid 1° × 1°, undefined (no aurora) below 20° latitude.
The aurora is placed in vertical columns above these points (field-line tilt neglected: at 70° magnetic latitude a dipole field is about 10° from
vertical, so the top of a 100 km tall curtain is misplaced by ~18 km). Label `estimated`: the fixed epoch,
dipole continuation, spherical start points and vertical columns introduce modelling assumptions.

**Emission.** For Maxwellian electrons of mean energy ⟨E⟩ = 2E₀ and unit energy flux:

- ionisation rate: Fang et al. (2008, JGR 113, A09311, DOI:10.1029/2008JA013384) parameterisation (35 eV per ion pair)
  in the US Standard Atmosphere 1976 above 86 km (`us76_upper.py`, a port of the MIT-licensed `ussa1976` with one
  correction: atomic oxygen's diffusion uses the mean molar mass grid; it matches the printed Table VIII to < 1 %,
  pytest);
- N₂⁺ first negative (0, v″) bands: the N₂ share of ionisation (equal cross sections per particle: assumption) ×
  Q_emis(391.4 nm)/Q_ion(N₂) at 100 eV (Itikawa 2006, JPCRD 35, 31, DOI:10.1063/1.1937426) × A(0,v″)/A(0,0) (Laher's
  tables computed as in Gilmore et al. 1992, JPCRD 21, 1005): 0.0192 photons of 427.8 nm per N₂ ionisation;
- O 557.7 and 630.0 nm: the B3C ratios to 427.8 nm for Maxwellian precipitation (Gabrielse et al. 2021, Front. Phys. 9,
  744298, DOI:10.3389/fphy.2021.744298, Fig. 2B, read from the figure, 0.104–9.81 keV; held at the end values
  outside); 636.4 nm = 630.0 nm × A(636.4)/A(630.0) (NIST ASD);
- vertical profiles: blue and green follow the N₂ ionisation; red follows the ionisation times the O(¹D) survival
  A/(A + k_N₂[N₂] + k_O₂[O₂]) (rate constants: IUPAC, Atkinson et al. 2004, ACP 4, 1461).

Columns per erg cm⁻² s⁻¹ (R), evaluated at mean energies 0.2, 1.7 and 7 keV: 427.8 nm 86, 195, 247;
557.7 nm 679, 1667, 1952; 630.0 nm 3320, 487, 75. Peak heights of the blue/green emission 210 km at 0.2 keV, 126 km at 1.7 keV, 106 km at 7 keV, 94 km
at 30 keV. Electrons above ~20 keV deposit up to 3 % of their energy below 86 km, which is not in the table.

**Line groups and attenuation.** The table holds the three groups' volume emission rates; the renderer multiplies the
path integral of each group by its luminance per R, folded per 40 nm bin with the atmosphere's transmittance.

## 4. Rendering (`src/render/nightglow.ts`)

The emission is computed at half the frame's resolution in its own pass (covering the emission shell, up to 600 km
above the largest radius; full screen when the camera is inside it or near the Earth) and added at full resolution
after the atmosphere shells, bilinearly, depth-tested at the shell's near entry against the bodies in front
(a numerical cost choice; GPU timing has not been verified on this machine).
For each pixel the view ray is split at its closest approach to the Earth's centre (the tangent point), ends at the
ground where the pixel is on the disk (the solid Earth occludes everything behind it; at the limb's edge the far side
is weighted by the uncovered share of the pixel), and:

- **Airglow:** each layer is integrated on each side of the tangent point with an 8-node Gauss–Legendre rule in
  x = √(r − r_t) (s = x·√(2r_t + x²)), which removes the square-root singularity of the limb integral, so the same
  nodes give the face-on column and the limb's path enhancement. The night domain is evaluated at every node; the
  ellipsoid radius and the local time are evaluated exactly at the two ends of the layer crossing and taken linear in
  between (at most ~1000 km for a mesopause layer at the limb). Seen face-on the layers add their zenith column
  (×1/cos away from the nadir); at the limb a mesopause layer gives 51 times its zenith column (closed form 51.12,
  quadrature 51.13).
- **Aurora:** the segments of the ray inside the shell (86–600 km) and inside the auroral caps (dipole latitude ≥ 40°,
  a double cone about the dipole axis) are marched in 48 steps. Per step the precipitation at the midpoint's magnetic
  coordinates and MLT gives the energy flux and the mean energy (energy flux / number flux); the altitude is linear in
  path length within a step and the emission is integrated exactly in altitude from the cumulative table,
  (C(h₂) − C(h₁))·Δs/Δh, so the step does not skip a thin layer under that within-step linear-altitude approximation.
- **Lower atmosphere:** light from the far side below the atmosphere's top (86 km), or any light when the camera is
  inside the atmosphere, is attenuated with the atmosphere's transmittance table per 40 nm bin (Bruneton 2017's
  transmittance between two points) at the emission-weighted point of each layer and side.
- **Ground and clouds:** neither airglow nor aurora illuminates them in this slice. The emission pass adds light
  along the view ray; it does not feed an irradiance term into `earthShade`. Scattering of this light into the view
  path by the lower atmosphere is also not modelled (§7).
- **Eye:** the pass writes the HDR luminance buffer like every other light, so adaptation, the mesopic colour
  response and the thresholds of the eye model (docs/eye-model.md) apply unchanged.

## 5. Provenance in the app

- Reality: both models are `estimated`, so `SceneBody.nightglow` is set only at Best estimate and Complete; at Strict
  nothing is drawn and the inspector shows the rows as withheld.
- Inspector (Earth): an "Airglow" row (what it is based on, whether drawn, the zenith luminance near local midnight,
  the 10.7 cm flux of the day and its label) and an "Aurora" row (drawn or not, the coupling value and whether it is
  measured or the climatological median, with the end of the measured solar wind), with methods, uncertainties and
  sources.
- Data panel: the five products with their integrity checks; missing products say what is lost.

## 6. Checks

The CPU model and product checks below were run on this machine (`app/tests/nightglow.test.ts`,
`pipeline/tests/test_nightglow.py`). Checks against measurements test the model; nothing was tuned to them.
The historical SWPC nowcast comparison was not rerun: its downloaded snapshot is time-dependent. GPU emission,
occlusion, attenuation, adaptation and the three rendered scenes remain unverified here.

| Check | Result |
|---|---|
| 1 R of 557.7 nm → luminance, from the CIE tables and the R definition (independent of the pipeline code) | Y 1.9325·10⁻⁷ cd/m², S 1.7379·10⁻⁷: product equal to 10⁻³ (pass) |
| Layer quadrature: vertical column | 1 to 0.2 % for every layer (pass) |
| Limb/zenith at a mesopause layer's peak vs the parabolic closed form 2Γ(5/4)(8r²σ²)^¼/(σ√2π) | 51.13 vs 51.12 (pass, < 1 %) |
| **Green-line limb brightness vs SCIAMACHY** (Lednyts'kyy et al. 2015, AMT 8, 1021, DOI:10.5194/amt-8-1021-2015, Fig. 4b: September 2010, 20–25° N, ~22 h, monthly mean; read from the figure 7.8·10³ R, range 7.0–8.5·10³ R, at 89–90 km) | model: zenith 103 R (F10.7 78.7 sfu, DRAO), limb peak 6.25·10³ R, ratio 0.80; pass band 0.6–1.5 (PALACE's σ). Peak tangent height 94.3 km vs ~89.5 km read from the figure: the model's layer (PALACE's 97 km reference height) is ~5 km higher than SCIAMACHY's retrieval puts it |
| Green-line zenith in the commonly measured 100–250 R | 103 R at solar minimum-like flux (pass, at the low end) |
| Whole-airglow zenith luminance | 1.36·10⁻⁴ cd/m² (the moonless natural sky at a dark site is ~2·10⁻⁴ cd/m², of which airglow is the largest part) |
| US76 upper atmosphere vs Table VIII (N₂, O, O₂, Ar, He at 86–900 km) | < 1 % (pass) |
| Fang 2008 energy closure (∫q dz · 35 eV) for ⟨E⟩ 0.5–3 keV | within 8 % of the energy flux (pass) |
| **Aurora peak heights vs measured means** (Whiter et al. 2023, Ann. Geophys. 41, 1, DOI:10.5194/angeo-41-1-2023: 557.7 nm 114.8 km, 427.8 nm 116.6 km) | inside the model's peaks for ⟨E⟩ 2–5 keV (≈ 120–108 km) (pass) |
| Field-line tracing against a pure dipole | AACGM latitude = analytic dipole latitude within 0.05° (pass) |
| OP2010 midnight oval at coupling 2763 | energy-flux peak 1.9 erg cm⁻² s⁻¹ at 67.2° MLAT (inside 60–72°, pass) |
| Oval location vs the NOAA SWPC OVATION nowcast (2026-10-01 03:58 UT; the same model family with SWPC's real-time solar wind, so this checks the coordinates, MLT and hemisphere handling and the climatological driver, not the physics; ours at the climatological coupling 3555) | latitude of the northern energy-flux maximum minus the nowcast's probability maximum, over 331 longitudes: median −2.5°, mean \|Δ\| 3.9°, 90th percentile 11.5°; night side (MLT 18–06, 154 longitudes) median −0.5°, mean \|Δ\| 3.1°; day side median −3.5°, mean \|Δ\| 4.6° |
| PALACE normalisation: night-weighted climatology mean at 100 sfu | 1 within 5 % for Og, Na, Or, FeO, OH 5a (pass) |
| Step integration of the aurora (5–7 steps over 600 km, vertical and 60° slant) | the column to 10⁻⁴ (pass) |

## 7. Open issues

- No latitude dependence of the airglow (PALACE at one site); no dayglow or twilight airglow (SZA < 100° unknown).
- The red line's latitude structure (equatorial ionisation anomaly) is not modelled; PALACE's Paranal values carry it.
- The aurora: no proton aurora, no N₂ first positive or N₂⁺ Meinel bands (red/infrared), no O(¹D) quenching by O, no
  explicit O(¹D) sources other than electron impact; transport results enter only through the B3C ratios read from a
  figure; the mean energy outside 0.104–9.81 keV holds the end ratios. Brightness uncertain by 30–50 %, the red line
  within a factor 2.
- OP2010 is statistical: arcs, substorm breakups and pulsating aurora are not reproduced; coupling above 24 000 is held.
- No measured solar wind after 2026-09-03 (OMNI's latency): the climatological oval is shown at Best estimate. Adding
  the SWPC real-time solar wind would make the last week live.
- Field-line tilt neglected (vertical columns); the magnetic grid is fixed at the window's mid-epoch (the secular
  variation over 3 years moves the pole by < 0.5°).
- No airglow or aurora path radiance from scattering in the lower atmosphere. Neither emission illuminates the
  ground or clouds. Light from the far side is attenuated at one representative point per layer.
- The task brief's rule of thumb of ~1 kR of 427.8 nm per erg cm⁻² s⁻¹ is not reproduced: the model gives 0.19–0.26
  kR per erg for ⟨E⟩ 1.7–30 keV (and 1.7–1.9 kR of 557.7 nm). The model is built from the cross sections and transport
  ratios above and was not adjusted; the difference is left open.
