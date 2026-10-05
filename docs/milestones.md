# Milestones

Each milestone is a **vertical slice**: data pipeline → provenance → rendering → UI, working end to end, before the next begins. Status is updated as work lands.

## M1 — The planets, right now  *(done)*

Fly anywhere among the Sun, planets, Pluto and the Moon at their real positions for now ± ~18 months, under physically correct sunlight, seen through a first human-eye model, against the real star field. Click anything to see where every number came from.

What landed:
- **Time & positions:** NAIF LSK leap seconds; JPL DE442s planetary ephemeris (bit-identical to SPICE); planet centers and every moon from NAIF satellite kernels (M2 work pulled forward). Verified against independent JPL Horizons vectors to ≤ 3 m (Moon, the worst case) and against SPICE bit-for-bit.
- **Bodies:** radii and IAU rotation models (pck00011), GM (gm_de440); precise Earth (ITRF93, predictions labeled `estimated`) and Moon (DE440 principal axes) orientation.
- **Light:** official CIE observers; TSIS-1 HSRS measured solar spectrum (Y = 134 647 lux at 1 AU); Neckel & Labs limb darkening; measured albedo spectra and phase curves for the planets, Pluto and the Moon, cross-checked against Horizons magnitudes (most within ±0.03 mag; see docs/reports/planet-colors.md).
- **Stars:** 482 459 stars complete to V ≈ 9.8; 91 % with color and brightness derived from Gaia DR3 XP, CALSPEC or Pulkovo spectra; positions at the window epoch (docs/reports/stars.md).
- **Renderer & eye (v1):** reversed-Z HDR renderer in absolute XYZ + scotopic units; analytic ellipsoid ray casting from 1 m to 50 AU; limb-darkened Sun; point sources with per-source color thresholds; Pattanaik et al. 2000 tone reproduction, CIE 146 glare (painted only beyond display range), Crumey 2014 visibility thresholds, CIE 191 mesopic vision, Watson & Yellott pupil (docs/eye-model.md).
- **App:** orbit/free-flight camera with magic travel, time controls clamped to the data window, inspector showing every attribute's label/method/sources, reality dials with a persistent badge, strict-mode hatching of unmeasured surfaces, labels/orbits/provenance-tint overlays, reproducible URLs.

Known limitations carried forward: planets are uniform-colored ellipsoids (maps come in M2); Earth's disk spectrum is a model (0.75 mag off Mallama & Hilton — measured DSCOVR EPIC data need an Earthdata login); no Milky Way diffuse light or zodiacal light yet (M4); eye adaptation is instantaneous.

## M2 — True-color worlds up close  *(done)*

Surface maps from mission mosaics, every moon, rings, measured photometric models, shadows, eclipses and planetshine.

Landed:
- **Every moon:** 459 moons besides the Moon with bit-exact NAIF satellite-kernel positions (types 2, 3, 17), radii/GM/rotation where published (else unknown); lazy-loaded per planetary system; hierarchical body browser.
- **Photometry:** measured colours and phase curves for 39 bodies (Galilean moons from Cassini ISS, Saturn's mid-size moons from VIMS with opposition surges, Uranian moons, Triton, Charon, Phobos, irregulars); the Moon from the ROLO model (colour, surge, waxing/waning asymmetry, libration); Earth's disk albedo measured from a Himawari-9 full-disk scan and checked against EPOXI (docs/reports/planet-colors.md).
- **Rings:** optical-depth profiles for Saturn (Cassini UVIS), Uranus and Neptune (Voyager PPS); Saturn ring reflectance from a single-scattering model calibrated on HST and Voyager measurements (both faces); unmeasured ring reflectance drawn as not measured.
- **Surfaces:** 3 GB of relative-reflectance tile pyramids calibrated by disk photometry (architecture §4.4): Moon (LROC WAC 7-band + LOLA relief + Hapke parameters), Mercury (MDIS 8-colour + DEM), Mars (HRSC colour + MOLA), Jupiter/Saturn/Uranus/Neptune (Hubble OPAL, dated 2025), Io/Europa/Ganymede/Callisto, Pluto, Charon (docs/reports/surfaces.md). Titan and Venus deliberately have no visible surface map (the eye sees haze/cloud).
- **Renderer:** GPU virtual texturing, relief normals, Hapke/Lommel–Seeliger/Minnaert spatial laws normalized to disk photometry, ring rendering with shadows both ways, planetshine, eclipses, phase-curve continuation only at Best estimate (docs/rendering-m2.md).

- **Earth, now:** measured land/ice reflectance (MODIS NBAR, Sept 2026), ocean water-leaving reflectance, the cloud field of 2026-09-28 (VIIRS optical thickness/phase/top height), sea-surface wind for sun glint (AMSR3/GMI, same day), VIIRS Black Marble night lights, and a multiple-scattering atmosphere from atmospheres.json (US76 + Bodhaine Rayleigh, measured ozone cross-sections, MACv2 aerosol). The rendered disk reflects 0.85–0.88 of the Himawari-measured value (docs/rendering-earth.md).
- **Eye:** adaptation driven by where the eye looks (fixations weighted by light), not the view centre; point sources judged at their own background (Crumey); optional, badged "Sun shield" viewing aid.
- **Atmospheres data** for Mars (seasonal dust), Venus, Titan, Pluto.
- **Titan from its haze:** the Huygens DISR haze (Tomasko et al. 2008 extinction and phase functions, Doose et al. 2016 albedos digitized from Barnes et al. 2018), methane absorption (Karkoschka 1998 × the Huygens GCMS profile) and the surface reflectance under it; Titan's resolved disk is drawn from them alone by orders of scattering in a spherical shell (Hillaire's table fails for a haze of τ ≈ 8), not renormalized to its photometry. Its brightness is the test: Y +1.8 % against Karkoschka at 5.7°, Z +12.6 % (the haze albedo extrapolated below 500 nm); the Cassini ISS phase curves within 2σ from 0° to 160° in five filters, 22–30 % too bright at 160–170° (the model's own forward scattering); the renderer within −18 % to +8 % of a Monte Carlo solution of the same model (docs/rendering-earth.md §8, docs/reports/atmospheres.md).

Known gaps: Saturn's icy-moon and Triton maps (public mosaics fail contrast checks), Uranian moon maps (none exist), Titan's haze below 500 nm and above 150 km (extrapolated) and its latitude/season variation, ring reflectance outside Saturn's main rings.

## M3 — Every known small body  *(done)*

Landed: 1,573,014 asteroids and comets from JPL SBDB at a common epoch with per-attribute provenance (NEOWISE diameters/albedos, LCDB rotation, Gaia DR3 spectra, SsODNet phase functions/spins/taxonomy), a Kepler-drift + planetary-kick propagator verified against Horizons (≤ 7 km for most objects over ±18 months; docs/reports/small-bodies.md), class colours from measured mean spectra, and the app side (search, inspector, selection, close-ups). GPU propagation of all 1.57M objects (double-single WGSL, checkpointed; median 8 m vs the f64 reference), label-aware photometry (H-G1-G2 / H-G / comet laws; Horizons APmag within 0.02 mag), picking and inspection.


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

## M6 — The complete solar system  *(first layer done)*

The synthetic layer (NORTH_STAR 3.3) for small bodies: 2,948,454 synthetic objects — NEOs (Granvik et al. 2018), Hungarias, main belt and Hildas (catalogue + measured SFD slopes: Maeda et al. 2021, Terai & Yoshida 2018), Jupiter Trojans (Yoshida & Terai 2017), TNOs (CFEPS L7) — filling only each (a, e, i, H) cell's deficit below the survey completeness limit refitted to the current catalogue (Hendler & Malhotra 2020 form). Deterministic per-cell streams make it yield to discoveries: removing N catalogued objects adds ~N synthetic ones and keeps the rest. Every synthetic value is labelled `synthetic`; the inspector explains which model/cell/deficit an object stands in for. `Complete` is now the default level. From inside the main belt it still looks empty to the naked eye — the brightest synthetic object is V 14.1 (docs/reports/synthetic-populations.md).

Next populations: irregular moons, Centaurs, comets' reservoirs, interplanetary dust (already modelled optically as zodiacal light).

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

## Paused work  *(2026-10-01, to resume)*

Four slices were stopped mid-way. Each sits on its own branch, based on this branch at 480e2c9 or later. The last commit on each is "WIP (paused)": work that wasn't committed when the slice stopped, and it is untested. None of them is merged here.

| Branch | Slice | State at pause |
|---|---|---|
| `claude/wip-nightglow` | Airglow and aurora on the Earth's night side | Close to done. `nightglow` stage (PALACE airglow, OVATION Prime 2010 aurora), emission pass, reality gating, inspector rows, three e2e scenes, report docs/reports/nightglow.md. The WIP commit has doc edits only. Next: final checks, then merge. |
| `claude/wip-titan-haze` | Titan's haze from Huygens DISR optics | Optics are in atmospheres.json and rendered by orders of scattering. The WIP commit has the docs and source notes in progress. Next: validation against Titan photometry, e2e scenes, then merge. |
| `claude/wip-giant-planet-rings` | Rings of Jupiter, Uranus and Neptune | A component model (eccentric, inclined, precessing bands and dust tori) with Uranus's rings is committed. The WIP commit adds Jupiter (Throop et al. 2004) and Neptune (arcs, Souami et al. 2022) data and rendering, untested. Next: tests, scenes, report. |
| `claude/wip-irregular-moons-centaurs` | M6: synthetic irregular moons and Centaurs | Stage, report section and app screenshot are committed. Next: final checks, then merge. |

Product data built on those branches is not in git. Resuming means rebuilding the stage on each branch: `nightglow`, `light` (for atmospheres.json and rings.json), and `synthetic`.
