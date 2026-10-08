# Milestones

Each milestone is a **vertical slice**: data pipeline → provenance → rendering → UI, working end to end, before the next begins. Status is updated as work lands.

## M1 — The planets, right now  *(done)*

Fly anywhere among the Sun, planets, Pluto and the Moon at their real positions for now ± ~18 months, under physically correct sunlight, seen through a first human-eye model, against the real star field. Click anything to see where every number came from.

What landed:
- **Time & positions:** NAIF LSK leap seconds; JPL DE442s planetary ephemeris (bit-identical to SPICE); planet centers and every moon from NAIF satellite kernels (M2 work pulled forward). Verified against independent JPL Horizons vectors to ≤ 3 m (Moon, the worst case) and against SPICE bit-for-bit.
- **Bodies:** radii and IAU rotation models (pck00011), GM (gm_de440); precise Earth (ITRF93, predictions labeled `estimated`) and Moon (DE440 principal axes) orientation.
- **Light:** official CIE observers; TSIS-1 HSRS measured solar spectrum (Y = 134 647 lux at 1 AU); Neckel & Labs limb darkening; measured albedo spectra and phase curves for the planets, Pluto and the Moon, cross-checked against Horizons magnitudes (most within ±0.03 mag; see docs/reports/planet-colors.md).
- **Stars:** 482 458 stars complete to V ≈ 9.8; 91 % with color and brightness derived from Gaia DR3 XP, CALSPEC or Pulkovo spectra; positions at the window epoch (docs/reports/stars.md).
- **Renderer & eye (v1):** reversed-Z HDR renderer in absolute XYZ + scotopic units; analytic ellipsoid ray casting from 1 m to 50 AU; limb-darkened Sun; point sources with per-source color thresholds; Pattanaik et al. 2000 tone reproduction, CIE 146 glare (painted only beyond display range), Crumey 2014 visibility thresholds, CIE 191 mesopic vision, Watson & Yellott pupil (docs/eye-model.md).
- **App:** orbit/free-flight camera with magic travel, time controls clamped to the data window, inspector showing every attribute's label/method/sources, reality dials with a persistent badge, strict-mode hatching of unmeasured surfaces, labels/orbits/provenance-tint overlays, reproducible URLs.

Limitations at the M1 landing (subsequent milestones address these): planets are uniform-colored ellipsoids (maps come in M2); Earth's disk spectrum is a model (0.75 mag off Mallama & Hilton — measured DSCOVR EPIC data need an Earthdata login); no Milky Way diffuse light or zodiacal light yet (M4); eye adaptation is instantaneous.

## M2 — True-color worlds up close  *(done)*

Surface maps from mission mosaics, every moon, rings, measured photometric models, shadows, eclipses and planetshine.

Landed:
- **Every moon:** 459 moons besides the Moon with bit-exact NAIF satellite-kernel positions (types 2, 3, 17), radii/GM/rotation where published (else unknown); lazy-loaded per planetary system; hierarchical body browser.
- **Photometry:** measured colours and phase curves for 39 bodies (Galilean moons from Cassini ISS, Saturn's mid-size moons from VIMS with opposition surges, Uranian moons, Triton, Charon, Phobos, irregulars); the Moon from the ROLO model (colour, surge, waxing/waning asymmetry, libration); Earth's disk albedo measured from a Himawari-9 full-disk scan and checked against EPOXI (docs/reports/planet-colors.md).
- **Rings:** optical-depth profiles for Saturn (Cassini UVIS), Uranus and Neptune (Voyager PPS); Saturn ring reflectance from a single-scattering model calibrated on HST and Voyager measurements (both faces), with separate measured and cleaned estimated optical-depth profiles; estimated component models for Jupiter, Uranus and Neptune; unmeasured ring reflectance drawn as not measured.
- **Surfaces:** 3 GB of relative-reflectance tile pyramids calibrated by disk photometry (architecture §4.4): Moon (LROC WAC 7-band + LOLA relief + Hapke parameters), Mercury (MDIS 8-colour + DEM), Mars (HRSC colour + MOLA), Jupiter/Saturn/Uranus/Neptune (Hubble OPAL, dated 2025), Io/Europa/Ganymede/Callisto, Pluto, Charon (docs/reports/surfaces.md). Titan and Venus deliberately have no visible surface map (the eye sees haze/cloud).
- **Renderer:** GPU virtual texturing, relief normals, Hapke/Lommel–Seeliger/Minnaert spatial laws normalized to disk photometry, ring rendering with shadows both ways, planetshine, eclipses, phase-curve continuation only at Best estimate (docs/rendering-m2.md).

- **Earth, now:** measured land/ice reflectance (MODIS NBAR, Sept 2026), ocean water-leaving reflectance, the SatCORPS cloud mosaic of 2026-09-28 (24 longitude strips near 13:30 local solar time, cloud fraction/phase/top height and two optical-thickness moment layers), sea-surface wind for sun glint (AMSR3/GMI, same day), VIIRS Black Marble night lights, and a multiple-scattering atmosphere from atmospheres.json (US76 + Bodhaine Rayleigh, measured ozone cross-sections, MACv2 aerosol). The earlier VIIRS rendering reflected 0.85–0.88 of the Himawari-measured value; that historical check does not certify the SatCORPS mosaic (docs/rendering-earth.md).
- **Eye:** adaptation driven by where the eye looks (fixations weighted by light), not the view centre; point sources judged at their own background (Crumey); optional, badged "Sun shield" viewing aid.
- **Atmospheres data** for Mars (seasonal dust), Venus, Titan, Pluto.
- **Titan from its haze:** the Huygens DISR haze (Tomasko et al. 2008 extinction and phase functions, Doose et al. 2016 albedos digitized from Barnes et al. 2018), methane absorption (Karkoschka 1998 × the Huygens GCMS profile) and the surface reflectance under it; Titan's resolved disk is drawn from them by orders of scattering in a spherical shell (Hillaire's table fails for a haze of τ ≈ 8), and scaled per channel to its disk photometry, so inside the photometry's range (0–5.7°) the drawn disk's integral is the measurement (architecture §4.3) and beyond it the factors of 5.7° are held (×0.99, 0.99, 0.89, 0.95 in X, Y, Z, S; estimated). The model's own brightness is the test of the data, reported and not shown: Y −1.0 % against Karkoschka at 5.7° and Z +9.0 % by the exact solution (Y +1.2 %, Z +11.9 % as the renderer computes it; the haze albedo is extrapolated below 500 nm), so the model alone is bluer than Titan; the Cassini ISS phase curves within 2σ from 0° to 160° in five filters, 20–30 % too bright at 160–170° (the model's own forward scattering, which the picture keeps); the renderer's CPU twin within −12 % to +3 % of a Monte Carlo solution of the same model (medians over the spectrum, by phase angle), and the shaders within 0.2 % of the twin (docs/rendering-earth.md §8, docs/reports/atmospheres.md).

Known gaps: Saturn's icy-moon and Triton maps (public mosaics fail contrast checks), Uranian moon maps (none exist), Titan's haze below 500 nm and above 150 km (extrapolated) and its latitude/season variation, Uranus λ and Neptune Galle ring reflectance, Neptune arc geometry outside observation support.

## M3 — Every known small body  *(done)*

Landed: 1,574,145 asteroids and comets from JPL SBDB at a common epoch with per-attribute provenance (NEOWISE diameters/albedos, LCDB rotation, Gaia DR3 spectra, SsODNet phase functions/spins/taxonomy), a Kepler-drift + planetary-kick propagator verified against Horizons (≤ 7 km for most objects over ±18 months; docs/reports/small-bodies.md), class colours from measured mean spectra, and the app side (search, inspector, selection, close-ups). GPU propagation of all 1.57M objects (double-single WGSL, checkpointed; median 8 m vs the f64 reference), label-aware photometry (H-G1-G2 / H-G / comet laws; Horizons APmag within 0.02 mag), picking and inspection.


The full MPC/JPL catalogs of asteroids and comets propagated on the GPU, with measured sizes, colors, rotation and shapes where they exist.

Comets as they would look (landed after M6):

- A comet resolved from the camera is drawn with its coma, its Finson–Probstein dust tail and its CO⁺ ion tail, in absolute light, from its propagated state.
- The total light is the M1/K1 law; the rendered coma sums to it within 0.5 %.
- The light is split between gas bands and dust using measured activity: A'Hearn et al. (1995) production rates and Afρ, McDonald band strengths, Lowell fluorescence efficiencies, Jewitt (2015) dust colours, and the Jorda et al. (2008) water–magnitude relation.
- Tail directions are checked against Horizons PsAng/PsAMV.
- The comets of the window, with their predicted peaks, are listed in docs/reports/comets.md. The e2e scene `comet-lemmon` shows the best-placed one, C/2025 A6 (Lemmon).

## M4 — The real sky  *(done)*

Data landed: 16.4M deep stars (G 10–14) in HEALPix tiles, the faint-star + diffuse Milky Way map anchored on Pioneer 10/11 photometry from beyond the zodiacal cloud, a Kelsall/Leinert zodiacal light model, Sternberg spectrophotometry for the brightest stars (docs/reports/sky.md). Rendering: deep tiles stream by view and needed magnitude (HTTP range reads of brightest-first prefixes); everything not drawn as a point is binned into a HEALPix sky map so no starlight is lost or double counted; the Pioneer-anchored diffuse light and faint stars form an absolute-luminance background cube; zodiacal light is line-of-sight integrated for the observer's actual position (−3 % vs Leinert at 50° elongation, fades to 0 at 30 AU); deep stars are pickable with Gaia ids and provenance (docs/reports/sky.md §5).


Gaia DR3 stars with spectra-derived colors, the brightest stars from Hipparcos, the Milky Way's diffuse light, zodiacal light.

## M5 — Eye model v1 and HDR display  *(done)*

- **Adaptation over time** from published dark/light adaptation data, running in real elapsed time (after 10 min of daylight: limiting V 4.8 after 2 min of dark, 5.1 after 12 min, 6.3 after 30, 6.6 fully adapted); bleaching by very bright exposures; instant adaptation for screenshots and the regression suite.
- **Fixation-driven adaptation:** the eye adapts where it would look — fixations spread over the frame, weighted by light the eye can actually see; point sources are judged at their own background (Crumey 2014).
- **HDR output** on HDR displays (extended-range canvas), mapping the eye model's intended display luminance to absolute nits; SDR path unchanged.
- **Low-light acuity** from published contrast-sensitivity data; stars and the sky background dimmed behind atmospheric limbs; δ-M scaled view transmittance (Wiscombe 1977); aerial-perspective atmosphere for performance.
- **Shape models** drawn as meshes (56 measured spacecraft/radar shapes, 16,098 DAMIT models) with orientation from each model's own frame or spin state, self-shadowing and energy normalized to the measured albedo (docs/rendering-shapes.md).
- **Validation runner** (`npm run validate`) against 11 calibrated observations (docs/reports/validation.md); validation cases test the model and are never used to select or tune it.

## M6 — The complete solar system  *(statistical products implemented; five-rule guarantees remain open)*

The synthetic layer (NORTH_STAR 3.3) for small bodies: 2,948,558 synthetic objects in the six asteroid/TNO populations (shared build read on 7 October) — NEOs (Granvik et al. 2018), Hungarias, main belt and Hildas (catalogue + measured SFD slopes: Maeda et al. 2021, Terai & Yoshida 2018), Jupiter Trojans (Yoshida & Terai 2017), TNOs (CFEPS L7) — filling only each (a, e, i, H) cell's deficit fainter than a completeness proxy fitted from a/H catalogue counts, with the Hendler & Malhotra 2020 proxy form for catalogue extrapolations. TNO candidates additionally pass a CFEPS pointing/efficiency discovery veto; other survey histories remain unknown. Deterministic streams yield in aggregate under fixed model/limits/templates; refits can change counts and identities, and there is no one-to-one discovery replacement. Every synthetic value is labelled `synthetic`; the inspector explains which model/cell/deficit an object stands in for. `Complete` is the default when a synthetic layer is available and small bodies are enabled. In the historical render from inside the main belt it still looks empty to the naked eye — the brightest synthetic object is V 14.1 (docs/reports/synthetic-populations.md).

Centaurs and irregular moons (landed on `rc` in `4b51dd5`; docs/reports/synthetic-populations.md §12):

- **Centaurs:** 20 935 synthetic Centaurs in the shared build read on 7 October (q > 5.2 au, 5.35–30 au). They come from one realization of the Kurlander et al. (2025) normalized literature model: 21 400 with H_r < 13.7, Nesvorný et al. (2019) orbits, Lawler et al. (2018) H law. Their archive keeps only magnitude-selected members; magnitude selection is approximately inverted on reconstructible states by 1/P weights under an independent H law, which add up to 99 % of the stated model size, and the archive follows the stated H law (χ² 0.92 per bin). The layer is conditioned on the SBDB Centaurs per a-bin, without overlapping the Trojan and Kuiper-belt grids. The cited survey rejects its joint distribution. A cited nuclei table qualifies one of the 44 comet-flagged Centaurs (C/2014 OG392, coma-separated V photometry); the other 43 do not condition this build. Its recomputed H_V is 11.92603, estimated; the paper's reported 11.3 is retained as a discrepancy. Eighteen catalogue M2 laws are retained without assuming bare-nucleus suitability.
- **Irregular moons:** 435 retrograde moons of Jupiter (Ashton et al. 2020, below H_V 17.63) and 23 of Saturn (Ashton et al. 2021, the last 0.3 mag the 2023 discoveries have not reached). Each survey's magnitudes are put on the MPC H_V scale with its own photometry of known moons. The moons use fixed planet-centred two-body elements on CPU/GPU. Individual position budgets are unknown; [audit C3](reports/synthetic-limitations.md#sampled-propagation-drift-c3) measures degree-scale omitted-force drift in representative samples.
  - Their orbit distribution is the known moons' (an assumption, labelled as such): no bias-corrected orbit distribution was found in the published sources reviewed.
  - Uranus and Neptune get none: no supported population below the quoted survey limits was found in the sources reviewed. Their zero samples do not certify complete catalogues.
- Yield-to-discovery and determinism tests cover both. The earlier 2.95 M objects are byte-identical.

Next populations: comets' reservoirs, interplanetary dust (already modelled optically as zodiacal light), and irregular moons below the Uranus and Neptune limits once a debiased population is published.

## Earth's night side: airglow and aurora  *(landed)*

The night side of the Earth glows with its own light (docs/reports/nightglow.md). Airglow: PALACE v1.0, ten years of measured X-shooter spectra at Cerro Paranal, as 22 emission classes on nine layers (OH, Na, O₂, FeO and HO₂ in the mesopause, the green line at 97 km, the red lines near 250 km), scaled to the month, local time and the measured 10.7 cm flux of the day. Aurora: OVATION Prime 2010 driven by the measured solar wind (OMNI 2, Newell coupling) in IGRF-14 magnetic coordinates, turned into blue, green and red light with the Fang et al. (2008) ionisation, laboratory cross sections and transport ratios. Both are a source term of the atmosphere, integrated along every view ray (the limb's ~50× path enhancement, occlusion by the ground, spectral attenuation by the lower atmosphere). The scene suite includes dark- and daylight-adapted limb views and storm/quiet aurora views; all four have accepted baseline records. Both models are estimated: drawn at Best estimate and Complete, never at Strict; without measured solar wind (including times after 2026-09-18T03:00:00Z in the current product) the aurora is the climatological oval and the inspector says so. Checked: the green limb against SCIAMACHY (model/measured 0.80), aurora peak heights against Whiter et al. (2023). URL `look=<az>,<el>` turns the camera at its place (e.g. an ISS-like view of the limb).

## Moments — real events in the data window  *(done)*

`E` opens Moments. It lists notable configurations inside the data window, computed in a Web Worker from the loaded ephemerides, radii and orientation models only (light-time corrected; scan, then bisection or golden-section search):

- solar and lunar eclipses;
- Galilean-moon transits, shadow transits, occultations, eclipses and double or triple shadows;
- Saturn's ring-plane crossings;
- oppositions, conjunctions, elongations and close planet pairs;
- Pluto–Charon mutual events (none in this window);
- near-Earth-object approaches to the Earth and the Moon, propagated with the reference propagator.

Each event has a "go there" camera and a method line, and shows its provenance: its files, its sources and its worst input label. Results are cached in IndexedDB per data build (src/app/events).

Checked against published predictions (tests/app-events-real.test.ts):

- The 2027-08-02 total eclipse: greatest eclipse within 30 s of 10:07:50 TD, at 25.5°N 33.2°E, gamma 0.1421, duration 6 min 23 s ± 10 s. Published durations use a slightly smaller lunar radius.
- The other five solar eclipses of the window, and the lunar totals of 2025-09-07 and 2026-03-03 within 60 s. The lunar shadow is geometric, so its magnitudes are a little smaller than published ones.
- Saturn's equinox on 2025-05-06, and oppositions and elongations on their almanac dates.
- The JPL CNEOS close approaches: all 2,816 Earth approaches in the window reproduced (median 0.1 s, relative distance 5e-9).

Curated views start with the longest total solar and lunar eclipses, then:

- Saturn at equinox, and its rings nearly edge-on from the Earth;
- a double shadow transit on Jupiter;
- Mars at opposition;
- a planet pair, and the closest pair to the Sun with the Sun shield on;
- the Earth over the lunar horizon, the Jovian system now, and Pluto with Charon.

A view may ask for the Sun shield (`K`, badged). The first run (no URL parameters) frames the Earth, with the Moon beside it, now and in real time, with a hint line. The scene suite adds that composition, the eclipse from the shadow axis and from above the atmosphere, and the double shadow transit.

Dropped: an asteroid belt seen from above. From 2–14 AU at +8 to +14 stops, the asteroids were lost among the background stars.

## Resumed work  *(landed on rc by 2026-10-07)*

All four paused slices are integrated. The commits below are their landings on `rc`; their products are listed in the manifest. Remaining model limits and checks are recorded here and in the linked reports.

| Slice | Integration commit | What landed; what remains open |
|---|---|---|
| Irregular moons and Centaurs | `4b51dd5` | Synthetic Centaurs and Jupiter/Saturn irregular moons, CPU/GPU planet-centred motion, provenance and unknown rotation in the inspector. Moon orbit templates are the bright known moons, without a survey selection correction; completeness is enforced by magnitude/cell deficits, without a sky/orbit selection veto. All comet-flagged Centaur-region objects are excluded, including 18 with nuclear laws whose suitability has not been established. Uranus/Neptune have no synthetic population below the published limits. See [synthetic-populations.md §12](reports/synthetic-populations.md#12-centaurs-and-irregular-moons). |
| Giant-planet rings | `460242c`; Uranus estimate `3e3ce4d`; Saturn profiles `b34cebb` | Jupiter/Uranus/Neptune component models; Uranus’s separately labelled constant-width COR estimates outside historical support; Saturn’s measured signed archive profile and separate cleaned estimate. Neptune’s arcs remain unknown outside their observation support. Uranus μ/ν are absent, λ and Neptune Galle reflectance unknown; torus/inclined-plane extinction and unresolved component light are omitted. Formal COR phase errors do not bound dynamical change; the source’s inconsistent Table 14 width-law column is unused. The `rings-data` probe fixes the Sun distance at 9.54 AU, so it cannot check absolute outer-ring brightness. See [rings.md](reports/rings.md). |
| Earth’s airglow and aurora | `0aa4539` | `nightglow` products, atmospheric emission, reality gates and inspector; four canonical scenes with accepted baselines. Missing solar wind uses a labelled climatological driver. Airglow has no latitude dependence or day/twilight model; aurora remains statistical, with vertical columns and incomplete emission species/transport. Emission does not illuminate the ground or scatter into the view through the lower atmosphere. See [nightglow.md](reports/nightglow.md). |
| Titan’s haze | `2005879` | Huygens-based optics, orders-of-scattering rendering, per-channel disk-photometry scaling, inspector factors and two accepted scene baselines. Below 5.7° the scale follows an estimated photometric ramp rather than a phase-resolved measurement; the product does not identify the single measured phase for anchoring. Unresolved Titan beyond that range still uses a Lambert continuation, including off-frame glare. Blue haze optics and high-altitude structure are extrapolated; high-phase model discrepancies, Saturnshine, refraction, detached haze, latitude/season asymmetry and 1 nm methane rendering remain open. See [atmospheres.md](reports/atmospheres.md) and [rendering-earth.md §8](rendering-earth.md#8-other-atmospheres). |

The canonical scenes and their acceptance records are in `app/e2e/scenes.json` and `app/e2e/baseline/stats.json`; those records do not cover every component geometry or physical validation case.

## 7 October 2026 — Measured light through a steadier eye

Earth's clouds now retain the SatCORPS mosaic's observing times and the distinction
between retrieved, provider-estimated and unknown thickness. Oblate planets keep
their albedo calibration at its measurement view; built reference and bare Hapke
phase tables move numerical work out of frames. Narrow-field bodies keep their
light through the point/disk transition, the acuity filter uses the fovea's
light-weighted adaptation, and star verdicts subtract the discrete pyramid's
exact own-light term. `starsDrawn` counts displayed stars.

The GPU-reference scene suite has 36 views, a held eye clock and a frame-cost gate.
Validation records sampling, in-frame ratios, scene dependence and cases not
rendered, with locked rebuilds and a report generated from the run. Refused frame
sizes and GPU errors remain visible in the app. Synthetic provenance now states
the model limits, qualifies Centaur nuclear photometry and applies the CFEPS
discovery veto; the reviewed Hilda/Trojan model tables remain inactive. These
changes do not close the synthetic motion or survey-coverage gaps.
