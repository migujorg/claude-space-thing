# jpl-horizons-sb-states: JPL Horizons small-body state vectors

- **URL:** https://ssd.jpl.nasa.gov/api/horizons.api (queries cached under `data/raw/horizons/smallbodies/`, each with its exact URL and sha256 in `data/raw/_downloads.json`).
- **Citation:** Giorgini, J. D. et al. (1996). JPL's On-Line Solar System Data Service. BAAS 28(3), 1158.

## Two uses

1. **Product input (3 objects).** Objects whose SBDB orbit model has terms the propagator does not model (101955 Bennu: AMRAT and RHO of the Farnocchia et al. 2021 thermal model, served by Horizons from an OSIRIS-REx SPK; 1P/Halley: S0; one comet with a rotating-jet model) take Horizons' heliocentric state at the common epoch (`core.flags` bit `horizonsState`, source index of `jpl-horizons-sb-states`). From there the app propagates them with the normal force model, which lacks those terms (for Bennu that is a few km over the window).
2. **Verification only.** Heliocentric geometric ICRF states every 2 days across the window for 19 objects (`pipeline/src/pipeline/sb_verify.py`), fetched with `COMMAND='DES=<spkid>;'` (asteroids) or `'DES=<designation>;CAP;NOFRAG'` (comets). The solution Horizons names (`soln ref.= JPL#...`) must equal the SBDB `orbit_id`, or the build fails. Horizons integrates with DE441, the 16 most massive asteroids (SB441-N16), relativity, oblateness and the fitted non-gravitational terms, so it is an independent check of our force model and integrator.
