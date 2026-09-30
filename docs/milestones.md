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

## M2 — True-color worlds up close  *(nearly done)*

Surface maps from mission mosaics, every moon, rings, measured photometric models, shadows, eclipses and planetshine.

Landed:
- **Every moon:** 459 moons besides the Moon with bit-exact NAIF satellite-kernel positions (types 2, 3, 17), radii/GM/rotation where published (else unknown); lazy-loaded per planetary system; hierarchical body browser.
- **Photometry:** measured colours and phase curves for 39 bodies (Galilean moons from Cassini ISS, Saturn's mid-size moons from VIMS with opposition surges, Uranian moons, Triton, Charon, Phobos, irregulars); the Moon from the ROLO model (colour, surge, waxing/waning asymmetry, libration); Earth's disk albedo measured from a Himawari-9 full-disk scan and checked against EPOXI (docs/reports/planet-colors.md).
- **Rings:** optical-depth profiles for Saturn (Cassini UVIS), Uranus and Neptune (Voyager PPS); Saturn ring reflectance from a single-scattering model calibrated on HST and Voyager measurements (both faces); unmeasured ring reflectance drawn as not measured.
- **Surfaces:** 3 GB of relative-reflectance tile pyramids calibrated by disk photometry (architecture §4.4): Moon (LROC WAC 7-band + LOLA relief + Hapke parameters), Mercury (MDIS 8-colour + DEM), Mars (HRSC colour + MOLA), Jupiter/Saturn/Uranus/Neptune (Hubble OPAL, dated 2025), Io/Europa/Ganymede/Callisto, Pluto, Charon (docs/reports/surfaces.md). Titan and Venus deliberately have no visible surface map (the eye sees haze/cloud).
- **Renderer:** GPU virtual texturing, relief normals, Hapke/Lommel–Seeliger/Minnaert spatial laws normalized to disk photometry, ring rendering with shadows both ways, planetshine, eclipses, phase-curve continuation only at Best estimate (docs/rendering-m2.md).

Remaining: Earth surface, today's clouds and night lights; Saturn's icy-moon maps from documented-brightness sources; local eye adaptation (bright close-ups currently saturate when the view centre is dark).

## M3 — Every known small body  *(in progress)*

Landed: 1,573,014 asteroids and comets from JPL SBDB at a common epoch with per-attribute provenance (NEOWISE diameters/albedos, LCDB rotation, Gaia DR3 spectra, SsODNet phase functions/spins/taxonomy), a Kepler-drift + planetary-kick propagator verified against Horizons (≤ 7 km for most objects over ±18 months; docs/reports/small-bodies.md), class colours from measured mean spectra, and the app side (search, inspector, selection, close-ups). Remaining: GPU propagation and drawing of all objects as points.


The full MPC/JPL catalogs of asteroids and comets propagated on the GPU, with measured sizes, colors, rotation and shapes where they exist.

## M4 — The real sky

Gaia DR3 stars with spectra-derived colors, the brightest stars from Hipparcos, the Milky Way's diffuse light, zodiacal light.

## M5 — Eye model v1 and HDR display

Time-dependent adaptation, HDR output, acuity limits, refinement against published vision data.

## M6 — The complete solar system

The synthetic layer (NORTH_STAR 3.3): small bodies below survey completeness, drawn from debiased population models, yielding to discoveries.
