# naif-pck00011: NAIF text PCK `pck00011.tpc` (IAU WGCCRE rotation models and radii)

- **URL:** https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc
- **Used by:** the `bodies` stage, for `radii` and `rotation` in `app/public/data/bodies.json`. The app evaluates rotations with `app/src/core/rotation.ts`.
- **Label:** `measured`. These are the IAU working group's fitted models.
- **Citation:** Archinal, B. A., et al. (2018). Report of the IAU Working Group on Cartographic Coordinates and Rotational Elements: 2015. *Celestial Mechanics and Dynamical Astronomy* 130, 22. DOI:10.1007/s10569-017-9805-5. Its correction is reference [2] in the PCK. The Earth and Moon models come from the 2009 report, Archinal et al. (2011), *CMDA* 109, 101–135, DOI:10.1007/s10569-010-9320-4. The machine-readable form is NAIF pck00011.tpc (N. Bachman, 2022-12-27).

## What is taken

For the Sun, Mercury, Venus, Earth, Moon, Mars, Jupiter, Saturn, Uranus, Neptune and Pluto:

- **Rotation polynomials:** `BODYnnn_RADII`, `_POLE_RA`, `_POLE_DEC` and `_PM`.
- **Nutation/precession coefficients:** `_NUT_PREC_RA`, `_NUT_PREC_DEC` and `_NUT_PREC_PM`, where the body has them.
- **System phase angles:** `BODYn_NUT_PREC_ANGLES` of the system barycenter (n = id / 100), with `BODYn_MAX_PHASE_DEGREE`. Mars uses 2 (quadratic angles), which is why the schema has `nutPrecAnglesDegree`.

Values are read with SPICE's kernel-pool parser, so they are exactly the numbers SPICE uses.

## Evaluation

The evaluation is SPICE BODEUL/TISBOD. The model is stated in `bodies.json` `rotation.method` and in the header of `app/src/core/rotation.ts`.

## Earth is low precision

NAIF's own caution in the PCK: IAU_EARTH "has an error in the prime meridian location of magnitude at least 150 arcseconds". The model has no nutation, no UT1−UTC and no polar motion.

Measured against NAIF's high-precision Earth PCK (`earth_latest_high_prec.bpc`, ITRF93), total rotation difference:

| Date | Difference |
|---|---|
| 2000-01-01 | 169″ (0.047°) |
| 2010 | 219″ |
| 2020 | 253″ |
| 2025-06 | 301″ (0.084°) |
| 2026-09 | 311″ (0.086°) |

Almost all of it is in the prime meridian; the pole is off by about 9″. At the surface, 0.086° is about 10 km along the equator.

Since M2, Earth's precise orientation comes from `orient/earth` (ITRF93 from NAIF's binary Earth PCKs; naif-earth-pck-high-prec.md). The Moon's comes from `orient/moon` (DE440, Mean Earth frame; naif-moon-pa-de440.md). `OrientationSet.orientation()` in `app/src/core/rotation.ts` prefers those products and falls back to these IAU models outside their coverage. The IAU Moon model is only a trigonometric approximation of the Mean Earth/Polar Axis frame, not the DE440 libration solution.

## Verification

- **pipeline/tests/test_bodies.py:** every stored number equals the kernel pool. A Python statement of the model matches `spiceypy.pxform('IAU_<BODY>', 'J2000')` to within 2.4e-10 for all 61 bodies with a model that SPICE has a built-in IAU frame for, at 60 epochs from 1900 to 2100. The worst is Phobos, whose quadratic Mars phase angles grow fastest.
- **app/tests/core-rotation.test.ts:** `bodyToIcrf` (TS) matches `pxform` to within 5.3e-11 at 8 epochs from 1950 to 2100. That covers the Sun, the planets, the Moon, Pluto, Phobos, Deimos, Io, Europa, Enceladus, Titan, Janus, Miranda, Triton and Charon. The requirement was 1e-9.

## Moons

`pck00011` has rotation models for 61 of the 470 bodies and triaxial radii for 76. Every other moon has `rotation` and `radii` = `unknown`: no shape and no synchronous rotation is assumed.
