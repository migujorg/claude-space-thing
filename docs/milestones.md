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
- **Atmospheres data** for Mars (seasonal dust), Venus, Titan (haze extinction only — its single-scattering properties are unknown pending Tomasko et al. 2008), Pluto.

Known gaps: Saturn's icy-moon and Triton maps (public mosaics fail contrast checks), Uranian moon maps (none exist), Titan haze scattering properties, ring reflectance outside Saturn's main rings.

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

## M5 — Eye model v1 and HDR display

Time-dependent adaptation, HDR output, acuity limits, refinement against published vision data.

## M6 — The complete solar system  *(first layer done)*

The synthetic layer (NORTH_STAR 3.3) for small bodies: 2,948,454 synthetic objects — NEOs (Granvik et al. 2018), Hungarias, main belt and Hildas (catalogue + measured SFD slopes: Maeda et al. 2021, Terai & Yoshida 2018), Jupiter Trojans (Yoshida & Terai 2017), TNOs (CFEPS L7) — filling only each (a, e, i, H) cell's deficit below the survey completeness limit refitted to the current catalogue (Hendler & Malhotra 2020 form). Deterministic per-cell streams make it yield to discoveries: removing N catalogued objects adds ~N synthetic ones and keeps the rest. Every synthetic value is labelled `synthetic`; the inspector explains which model/cell/deficit an object stands in for. `Complete` is now the default level. From inside the main belt it still looks empty to the naked eye — the brightest synthetic object is V 14.1 (docs/reports/synthetic-populations.md).

Next populations: irregular moons, Centaurs, comets' reservoirs, interplanetary dust (already modelled optically as zodiacal light).
