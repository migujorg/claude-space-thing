# Milestones

Each milestone is a **vertical slice**: data pipeline → provenance → rendering → UI, working end to end, before the next begins. Status is updated as work lands.

## M1 — The planets, right now  *(in progress)*

Fly anywhere among the Sun, planets, Pluto and the Moon at their real positions for now ± ~18 months, under physically correct sunlight, seen through a first human-eye model, against the real naked-eye star field. Click anything to see where every number came from.

- Pipeline: NAIF LSK (time), DE440s (positions), PCK (radii, rotation), GM; CIE observers; measured solar spectrum; planet albedo spectra and phase curves; bright-star catalog.
- App: f64 ephemeris + light-time, reversed-Z HDR renderer in absolute photometric units (XYZ + scotopic), Sun disk with measured limb darkening, lit ellipsoids, star splats, eye model v0 (adaptation, glare, visibility threshold, mesopic), sRGB output.
- UI: fly/orbit camera, go-to, time controls, inspector with provenance, reality dials + badge.
- Verification: ephemeris vs. independent JPL Horizons vectors; screenshot tests.

## M2 — True-color worlds up close

Surface maps from mission mosaics, major moons of every planet, Saturn's rings from Cassini profiles, measured photometric models, shadows and eclipses, planetshine.

## M3 — Every known small body

The full MPC/JPL catalogs of asteroids and comets propagated on the GPU, with measured sizes, colors, rotation and shapes where they exist.

## M4 — The real sky

Gaia DR3 stars with spectra-derived colors, the brightest stars from Hipparcos, the Milky Way's diffuse light, zodiacal light.

## M5 — Eye model v1 and HDR display

Time-dependent adaptation, HDR output, acuity limits, refinement against published vision data.

## M6 — The complete solar system

The synthetic layer (NORTH_STAR 3.3): small bodies below survey completeness, drawn from debiased population models, yielding to discoveries.
